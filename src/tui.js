import { APP_NAME, SERVICES, VERSION } from "./config.js";
import { manager } from "./manager.js";
import { ProxySetupWizard } from "./tui-proxy-setup.js";
import { preflightProxy } from "./proxy-setup.js";
import { preflightHindsight } from "./hindsight.js";
import { hasHealthCheck, probeServiceHealth } from "./health.js";
import {
  badgeStatus,
  bold,
  cyan,
  dim,
  gray,
  green,
  magenta,
  red,
  renderTable,
  stripAnsi,
  underline,
  white,
  yellow,
} from "./utils/format.js";
import { killProcessTree } from "./utils/process.js";
import { getProxyStatsPath, readProxyStats } from "./proxy-stats.js";
import { getServiceVersions } from "./utils/versions.js";
import {
  diffRates,
  probeChain,
} from "./utils/metrics.js";

const TICK_MS = 1000;
const STALE_MS = 5 * TICK_MS;
const VERSION_CHECK_MS = 5 * 60 * 1000;
const HEALTH_CHECK_MS = 5 * TICK_MS;
const HEALTH_STALE_MS = 3 * HEALTH_CHECK_MS;
const MAX_EVENTS = 20;

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";
const CLEAR_LINE = "\x1b[K";
const CLEAR_BELOW = "\x1b[J";
const RESET = "\x1b[0m";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";

/**
 * Truncates a possibly coloured string to a visible width, keeping escape
 * sequences intact and always closing with a reset.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function clip(text, width) {
  if (width <= 0) return "";
  const str = String(text);
  if (stripAnsi(str).length <= width) return str;

  let out = "";
  let visible = 0;
  let i = 0;
  while (i < str.length && visible < width) {
    if (str[i] === "\x1b") {
      const end = str.indexOf("m", i);
      if (end === -1) break;
      out += str.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += str[i];
    visible++;
    i++;
  }
  return out + RESET;
}

/**
 * Compact human formatting for counters and rates.
 * @param {number | null | undefined} value
 * @param {number} [decimals]
 * @returns {string}
 */
function num(value, decimals = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(decimals);
}

/**
 * @param {number | null | undefined} value
 * @returns {string}
 */
function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function age(timestamp, now) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Snapshot strings are data, never terminal escape sequences or extra rows.
function plain(value, fallback = "-") {
  return stripAnsi(String(value ?? fallback)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stageList(event) {
  return Array.isArray(event?.stages) ? event.stages.filter(s => s && typeof s === "object") : [];
}

function savedTokens(value) {
  if (!Number.isFinite(value)) return dim("not measured");
  if (value > 0) return green(`-${num(value)} tok`);
  if (value < 0) return yellow(`+${num(-value)} tok`);
  return dim("0 tok");
}

/** Wrap complete fields, falling back to words for long descriptions. */
function wrapCells(cells, width, separator = "  |  ", indent = "  ") {
  const lines = [];
  let line = indent;
  for (const cell of cells) {
    if (stripAnsi(cell).length > width - indent.length) {
      if (line !== indent) lines.push(line);
      line = indent;
      for (const word of cell.split(" ")) {
        if (line !== indent && stripAnsi(line + " " + word).length > width) {
          lines.push(line);
          line = indent;
        }
        if (stripAnsi(word).length > width - indent.length) {
          if (line !== indent) lines.push(line);
          let remaining = stripAnsi(word);
          const chunkWidth = Math.max(1, width - indent.length);
          while (remaining.length > chunkWidth) {
            lines.push(indent + remaining.slice(0, chunkWidth));
            remaining = remaining.slice(chunkWidth);
          }
          line = indent + remaining;
        } else line += (line === indent ? "" : " ") + word;
      }
      continue;
    }
    const next = line === indent ? cell : dim(separator) + cell;
    if (line !== indent && stripAnsi(line + next).length > width) {
      lines.push(line);
      // Do not let the continuation arrow clip a field that just fits.
      const arrow = separator === " -> " && stripAnsi(cell).length + indent.length + 3 <= width ? dim("-> ") : "";
      line = indent + arrow + cell;
    } else line += next;
  }
  if (line !== indent) lines.push(line);
  return lines.map(line => clip(line, width));
}

/**
 * Colours a pipeline node by its live state.
 * @param {{ label: string; state: string }} node
 * @returns {string}
 */
function paintNode(node) {
  switch (node.state) {
    case "healthy":
      return green(`[ ${node.label}: verified ]`);
    case "running":
      return `[ ${node.label}: process running ]`;
    case "error":
      return red(bold(`[ ${node.label}: error ]`));
    case "stopped":
      return dim(`[ ${node.label}: stopped ]`);
    case "static":
      return `[ ${node.label} ]`;
    default:
      return yellow(`[ ${node.label}: not verified ]`);
  }
}

export class Dashboard {
  constructor({ getVersions = getServiceVersions, getProxyStats = readProxyStats, getHealth = probeServiceHealth } = {}) {
    this.statuses = [];
    this.getVersions = getVersions;
    this.getHealth = getHealth;
    this.health = {};
    this.healthAt = 0;
    this.healthKey = "";
    this.healthLoading = false;
    this.versions = {};
    this.versionsKey = "";
    this.versionsAt = 0;
    this.versionsLoading = false;
    this.versionsGeneration = 0;
    this.getProxyStats = getProxyStats;
    this.metricsFile = getProxyStatsPath();
    this.metricsAt = null;
    this.metricsError = null;
    this.metricsKey = "";
    this.sampleMs = null;
    this.rates = {};
    this.prevMetrics = null;
    this.prevAt = 0;
    this.chain = [];
    this.chainAt = null;
    this.showPipelineDetails = false;
    this.events = [];
    this.proxyStats = null;
    this.selected = 0;
    this.status = "";
    this.busy = false;
    this.running = false;
    this.timer = null;
    this.refreshing = false;
  }

  /**
   * Reads every service's health endpoint every few seconds, independently of the
   * 1 s tick; a start/stop/restart (status, PID, URL or container change) triggers an immediate check.
   */
  async refreshHealth(now = Date.now()) {
    const targets = this.statuses.filter(s => hasHealthCheck({ ...s, runtime: s.runtime || SERVICES[s.id]?.runtime }));
    const key = JSON.stringify(targets.map(s => [s.id, s.status, s.pid, s.url, s.containerId, s.apiUrl, s.runtimeError]));
    if (key !== this.healthKey) {
      this.healthKey = key;
      this.healthAt = 0;
    }
    if (this.healthLoading || (this.healthAt && now - this.healthAt < HEALTH_CHECK_MS)) return;
    this.healthLoading = true;
    try {
      const entries = await Promise.all(targets.map(async s => [s.id, s.status === "running"
        ? await Promise.resolve().then(() => this.getHealth({ ...s, runtime: s.runtime || SERVICES[s.id]?.runtime }))
          .catch(error => ({ state: "unreachable", error: error?.message || String(error), checkedAt: Date.now() }))
        : { state: s.runtimeError ? "docker" : "stopped", error: s.runtimeError, checkedAt: Date.now() }]));
      if (key === this.healthKey) this.health = Object.fromEntries(entries);
    } finally {
      if (key === this.healthKey) this.healthAt = Date.now();
      this.healthLoading = false;
      this.render();
    }
  }

  healthCell(svc, now = Date.now()) {
    const health = this.health[svc.id];
    if (!health) return dim(hasHealthCheck({ ...svc, runtime: svc.runtime || SERVICES[svc.id]?.runtime }) ? "checking..." : "-");
    const label = {
      healthy: green("ok"), degraded: red(bold("degraded")), unreachable: red("unreachable"),
      unverified: yellow("unverified"), stopped: dim("stopped"), docker: yellow("no docker"),
    }[health.state] || dim("n/a");
    return label;
  }

  /** Age of the last /health reading; stale readings are highlighted. */
  lastCheckCell(svc, now = Date.now()) {
    const health = this.health[svc.id];
    // A stopped service is not contacted, so there is no interaction to date.
    if (!Number.isFinite(health?.checkedAt) || health.state === "stopped") return dim("-");
    const text = `${age(health.checkedAt, now)} ago`;
    return now - health.checkedAt > HEALTH_STALE_MS ? yellow(text) : text;
  }

  /** @returns {any} */
  currentService() {
    return this.statuses[this.selected];
  }

  /** Checks versions independently of the one-second status/metrics refresh. */
  async refreshVersions() {
    const key = JSON.stringify(this.statuses.map(s => [s.id, s.status, s.pid, s.url]));
    if (key !== this.versionsKey) {
      this.versionsKey = key;
      this.invalidateVersions();
    }
    if (this.busy || this.versionsLoading || (this.versionsAt && Date.now() - this.versionsAt < VERSION_CHECK_MS)) return;

    const generation = this.versionsGeneration;
    const isCurrent = () => key === this.versionsKey && generation === this.versionsGeneration;
    this.versionsLoading = true;
    try {
      const versions = await this.getVersions(this.statuses);
      if (isCurrent()) this.versions = versions;
    } catch {
      // An unavailable registry must not interrupt service controls or metrics.
      if (isCurrent()) this.versions = {};
    } finally {
      if (isCurrent()) this.versionsAt = Date.now();
      this.versionsLoading = false;
      this.render();
    }
  }

  /**
   * One data tick. Every source is optional: a failing fetch degrades its own
   * panel and never breaks the loop.
   */
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.statuses = await manager.getStatus();
      void this.refreshVersions();
      void this.refreshHealth();
      if (this.selected >= this.statuses.length) {
        this.selected = Math.max(0, this.statuses.length - 1);
      }

      const proxy = this.statuses.find(s => s.id === "proxy");
      if (this.proxySetup) {
        this.proxySetup.active = proxy?.proxyOptions;
        this.proxySetup.running = proxy?.status === "running";
      }
      const stats = await this.getProxyStats();
      const probed = await probeChain(this.statuses, { nativeOnly: true });
      const now = Date.now();
      const metricsKey = JSON.stringify([proxy?.url, proxy?.pid, proxy?.status, stats?.since]);
      if (metricsKey !== this.metricsKey || (stats && stats.requests < this.prevMetrics?.requests)) this.prevMetrics = null;
      this.metricsKey = metricsKey;
      if (stats) {
        // updatedAt is the last preset event, not a heartbeat. An idle proxy's
        // unchanged snapshot is still readable; retain its real last-event age.
        this.proxyStats = stats;
        this.metricsAt = now;
        this.events = stats.recent.filter(ev => ev && typeof ev === "object" && !Array.isArray(ev)).slice(-MAX_EVENTS);
      }
      this.metricsError = !proxy ? "AIH proxy not configured"
        : proxy.status !== "running" ? "AIH proxy not running"
        : !stats ? "Proxy statistics missing or invalid" : null;
      if (!this.metricsError) {
        const counters = { requests: stats.requests };
        this.sampleMs = this.prevMetrics ? now - this.prevAt : null;
        this.rates = diffRates(this.prevMetrics, counters, this.sampleMs);
        this.prevMetrics = counters;
        this.prevAt = now;
      } else {
        // Keep the last totals and events for diagnosis, but never old rates.
        this.rates = {};
        this.prevMetrics = null;
        this.sampleMs = null;
      }

      // A verified health reading upgrades "process running" to "verified" in the chain.
      this.chain = probed.nodes.map(node => node.id === "proxy" && node.state === "running"
        && this.health.proxy?.state === "healthy" ? { ...node, state: "healthy" } : node);
      this.chainAt = now;
    } catch (err) {
      this.metricsError = "refresh failed";
      this.rates = {};
      this.prevMetrics = null;
      this.sampleMs = null;
      this.chainAt = null;
      this.status = red(`Refresh error: ${err?.message || err}`);
    } finally {
      this.refreshing = false;
    }
  }

  /** Pipeline rows wrap whole fields rather than clipping useful values. */
  pipelineLines(width, now = Date.now()) {
    const lines = [bold("PIPELINE") + dim("  AIH proxy metrics")];
    const add = (cells, separator) => lines.push(...wrapCells(cells, width, separator));
    const chainFresh = this.chainAt !== null && now - this.chainAt <= STALE_MS;
    add(this.chain.map(node => paintNode(chainFresh || node.state === "static"
      ? node : { ...node, state: "unknown" })), " -> ");

    const stale = this.metricsStale(now);
    const freshness = this.metricsAt === null ? "no sample"
      : `last sample ${age(this.metricsAt, now)} ago`;
    const freshnessText = stale ? yellow(`Stale data: ${freshness}`) : `Read ${age(this.metricsAt, now)} ago`;
    if (stripAnsi(lines[0] + "  |  " + freshnessText).length <= width) lines[0] += dim("  |  ") + freshnessText;
    else add([freshnessText]);
    if (this.metricsError) add([yellow(this.metricsError)]);

    const preset = this.statuses.find(s => s.id === "proxy")?.proxyOptions?.preset;
    if (preset === "none") add([yellow("Preset none: traffic not recorded in metrics")]);
    if (this.proxyStats) {
      const m = this.proxyStats;
      const lastAt = timestamp(m.updatedAt);
      add([bold("Preset processing"), stale ? dim("activity unavailable")
        : `${cyan(bold(num(this.rates.requests, 2)))} proc/s`,
      `Last event ${lastAt === null ? "-" : age(lastAt, now) + " ago"}`]);
      const changedRatio = Number.isFinite(m.changed) && m.requests > 0 ? m.changed / m.requests : null;
      add([bold("Since counters started") + (stale ? yellow(" (last sample)") : "")]);
      add([`Requests ${bold(num(m.requests))}`, `Changed ${bold(num(m.changed))} (${pct(changedRatio)})`,
        `Preset errors ${m.errors > 0 ? red(bold(num(m.errors))) : num(m.errors)}`]);
      add([`estimated savings ${bold(num(m.estimatedSavedTokens))} tokens${m.unmeasuredStages > 0 ? yellow(" (partial)") : ""}`]);
      for (const [name, stage] of Object.entries(m.stages || {})) {
        if (!stage || typeof stage !== "object") continue;
        add([`${plain(name)}: ${bold(num(stage.saved))} tokens`, `applied ${num(stage.applied)}/${num(stage.requests)}`,
          ...(stage.unmeasured > 0 ? [yellow(`unmeasured ${num(stage.unmeasured)}`)] : [])]);
      }
    }
    add([dim("Preset estimates; excludes interceptors, cache and billing.")]);

    if (this.showPipelineDetails) {
      add([`Source: ${plain(this.metricsFile)}`]);
      if (this.proxyStats?.since) add([`Counters since ${plain(this.proxyStats.since)} (persist across restarts)`]);
      for (const node of this.chain) {
        if (node.detail) add([`${node.label}: ${plain(node.detail)}`]);
        if (node.state === "running") add([yellow(`${node.label}: health not verified`)]);
      }
      if (!chainFresh) add([yellow("Chain states are stale")]);
      if (this.proxyStats && !stale) {
        add([dim(this.sampleMs === null ? "Rate: waiting for the second sample"
          : `Rate: last interval ${(this.sampleMs / 1000).toFixed(1)} s`)]);
      }
      add([dim("proc/s: requests processed by presets, not all proxy traffic")]);
      add([dim("Savings: sum of measured per-stage deltas; bases are not additive")]);
      add([dim("Preset errors != upstream errors; no global count of in-flight requests")]);
      add([dim("Timings: proxy = presets; header = upstream send -> headers (not first token)")]);
      add([dim("HTTP total includes upload, interceptors and streaming until finish/close")]);
      add([dim("WS: preset time only; awaiting outcome does not mean the request is still active")]);
    }
    return lines.map(line => clip(line, width));
  }

  /** Updates can change an installed version without changing status or PID. */
  invalidateVersions() {
    this.versionsGeneration++;
    this.versionsAt = 0;
    this.versions = {};
  }

  metricsStale(now = Date.now()) {
    return this.metricsAt === null || Boolean(this.metricsError) || now - this.metricsAt > STALE_MS;
  }

  /** Native recent events are a bounded snapshot, not an append-only log. */
  requestLines(event, width) {
    const at = timestamp(event.at);
    const time = at === null ? "--:--:--" : new Date(at).toLocaleTimeString("en-GB", { hour12: false });
    const stages = stageList(event);
    const partial = !event.error && stages.some(stage => !Number.isFinite(stage.saved));
    const unmeasured = partial && stages.every(stage => !Number.isFinite(stage.saved));
    const status = event.error ? red(bold("preset error")) : event.changed === true ? green("changed")
      : event.changed === false ? dim("unchanged") : dim("outcome unavailable");
    const timing = event.timings;
    const responseState = {
      waiting: dim("awaiting outcome"), responding: cyan("response started"),
      error: red(event.error ? "not forwarded" : "proxy/transport error"), aborted: yellow("aborted"),
    }[timing?.state];
    const lines = wrapCells([gray(time), cyan(plain(event.transport)), magenta(plain(event.model, "?")),
      plain(event.preset), status,
      ...(event.error ? [] : [savedTokens(unmeasured ? null : event.saved) + (partial && !unmeasured ? yellow(" (partial)") : "")]),
      ...(timing ? [
        `proxy: ${duration(timing.presetMs)}`,
        ...(Number.isFinite(timing.pxpipeQueueMs) ? [
          `queue: ${duration(timing.pxpipeQueueMs)}`, `pxpipe: ${duration(timing.pxpipeMs)}`,
          ...(Number.isFinite(timing.pxpipeCpuMs) ? [`CPU: ${duration(timing.pxpipeCpuMs)}`] : []),
        ] : []),
        ...(Number.isFinite(timing.eventLoopLagMs) ? [`max loop lag: ${duration(timing.eventLoopLagMs)}`] : []),
        ...(event.transport === "HTTP" ? [
          `header: ${duration(timing.upstreamHeadersMs)}`, `tot: ${duration(timing.totalMs)}`,
          ...(Number.isInteger(timing.statusCode) && timing.statusCode >= 100 && timing.statusCode <= 599
            ? [timing.statusCode >= 400 ? red(`HTTP ${timing.statusCode}`) : `HTTP ${timing.statusCode}`] : []),
          ...(responseState ? [responseState] : []),
        ] : [dim("WS response: n/a")]),
      ] : [dim("timings: n/a")]),
      ...(event.project ? [`project: ${plain(event.project)}`] : []),
      ...(event.sessionId || event.threadId ? [`session: ${plain(event.sessionId || event.threadId)}`] : []),
      ...(!this.showPipelineDetails ? stages.map(s => dim(`${plain(s.name)}: ${plain(s.reason)}`)) : []),
    ], width, "  ");
    if (this.showPipelineDetails) {
      for (const stage of stages) {
        const ratio = Number.isFinite(stage.before) && stage.before > 0 && Number.isFinite(stage.saved)
          ? stage.saved / stage.before : null;
        lines.push(...wrapCells([`${plain(stage.name)}: ${stage.applied ? "applied" : "bypass"}`,
          `${num(stage.before)} -> ${num(stage.after)} tok (${pct(ratio)})`,
          plain(stage.reason), dim(plain(stage.method)),
        ], width, "  |  ", "    "));
      }
    }
    return lines;
  }

  streamLines(width, maxRows = Infinity, now = Date.now()) {
    if (maxRows <= 0) return [];
    const lines = [clip(bold("REQUEST STREAM")
      + (this.metricsStale(now) && this.proxyStats ? yellow(" (historical)") : "")
      + dim("  AIH proxy / preset processing"), width)];
    if (maxRows === 1) return lines;
    if (!this.events.length) {
      const preset = this.statuses.find(s => s.id === "proxy")?.proxyOptions?.preset;
      const message = preset === "none" ? "preset none: no processing events"
        : this.proxyStats ? "waiting for requests processed by presets..."
        : "no proxy events available";
      return lines.concat(wrapCells([dim(message)], width).slice(0, maxRows - 1));
    }
    const groups = [];
    let available = maxRows - lines.length;
    // Keep newest complete entries, then show them in chronological order.
    for (const event of this.events.slice().reverse()) {
      const group = this.requestLines(event, width);
      if (group.length > available) {
        if (!groups.length) {
          const clipped = group.slice(0, available);
          if (clipped.length) clipped[clipped.length - 1] = clip(clipped.at(-1), Math.max(0, width - 4)) + dim(" ...");
          groups.unshift(clipped);
        }
        break;
      }
      groups.unshift(group);
      available -= group.length;
    }
    return lines.concat(groups.flat());
  }

  /**
   * Builds the whole screen as an array of lines.
   * @returns {string[]}
   */
  buildLines() {
    const width = Math.max(40, process.stdout.columns || 100);
    const height = Math.max(12, process.stdout.rows || 30);
    if (this.proxySetup) return this.proxySetup.lines(width, height, this.busy).map(line => clip(line, width));
    const lines = [];
    const svc = this.currentService();
    const target = svc ? bold(svc.id) : dim("-");
    const keyLines = wrapCells([
      `${dim("d")} ${this.showPipelineDetails ? "less" : "details"}`,
      `${dim("q")} quit`,
      `${dim("up/down")} select (${target})`,
      `${dim("s")} start`,
      `${dim("c")} setup`,
      `${dim("x")} stop`,
      `${dim("r")} restart`,
      `${dim("u")} update`,
      `${dim("k")} kill`,
      ...(svc?.dashboardUrl ? [`${dim("o")} dashboard`] : []),
      ...(svc?.repositoryUrl ? [`${dim("g")} GitHub`] : []),
    ], width, "  ", "");
    const footerLines = keyLines.length + 2;

    const title = `${bold(cyan(APP_NAME))} ${gray("v" + VERSION)} ${dim("live dashboard")}`;
    const clock = dim(new Date().toLocaleTimeString());
    const titlePad = Math.max(1, width - stripAnsi(title).length - stripAnsi(clock).length);
    lines.push(title + " ".repeat(titlePad) + clock);
    lines.push(gray("-".repeat(width)));

    const headers = [
      " ",
      "SERVICE",
      "STATUS",
      "HEALTH",
      "VERSION",
      "UPDATE",
      { header: "PID", align: "right" },
      { header: "UPTIME", align: "right" },
      "LAST CHECK",
      "REPO",
      "URL",
    ];
    const rows = this.statuses.map((s, idx) => {
      const active = idx === this.selected;
      const version = this.versions[s.id];
      const update = version?.updateAvailable === true
        ? yellow(bold(`↑ ${version.latestVersion}`))
        : version?.updateAvailable === false
          ? green("up to date")
          : dim(this.versionsLoading && !version ? "checking..." : "n/a");
      return [
        active ? cyan(bold(">")) : " ",
        active ? bold(white(s.id)) : bold(s.id),
        badgeStatus(s.status),
        this.healthCell(s),
        version?.version || dim("n/a"),
        update,
        s.pid ? String(s.pid) : dim("-"),
        s.status === "running" ? s.uptime : dim("-"),
        this.lastCheckCell(s),
        s.repositoryUrl ? cyan(underline(s.repositoryUrl.replace("https://github.com/", ""))) : dim("-"),
        s.id === "proxy" ? dim(`${s.url} (proxy)`) : s.status === "running" && s.url && s.url !== "-" ? cyan(underline(s.url)) : dim(s.url || "-"),
      ];
    });
    if (rows.length > 0) {
      const table = renderTable(headers, rows).split("\n");
      for (const line of table) lines.push(line);
    } else {
      lines.push(dim("  No services."));
    }
    lines.push("");

    const bodyLimit = height - footerLines;
    if (lines.length > bodyLimit - 4) {
      lines.length = Math.max(0, bodyLimit - 4);
      if (lines.length) lines[lines.length - 1] = dim("  ... services: enlarge the terminal");
    }
    const room = bodyLimit - lines.length;
    const streamRows = this.events.length ? Math.min(6, Math.max(2, Math.floor(room / 3))) : 2;
    const pipelineBudget = room - streamRows - 1;
    let pipeline = this.pipelineLines(width);
    if (pipeline.length > pipelineBudget) {
      // Never let expanded pipeline explanations consume the request stream.
      // On small screens prioritize native totals over the topology/details.
      const m = this.proxyStats;
      const header = m && this.metricsStale() ? bold("PIPELINE") + yellow(" (historical)") + dim("  AIH proxy metrics") : pipeline[0];
      pipeline = [header, ...wrapCells(m ? [
        `Requests ${num(m.requests)}`, `Changed ${num(m.changed)}`, `Preset errors ${num(m.errors)}`,
        `estimated savings ${num(m.estimatedSavedTokens)} tokens${m.unmeasuredStages > 0 ? " (partial)" : ""}`,
        ...(this.metricsStale() ? [yellow("Historical data / activity unavailable")] : []),
      ] : [yellow(this.metricsError || "no sample")], width)];
      pipeline = pipeline.slice(0, Math.max(1, pipelineBudget - 1));
      if (pipelineBudget > 1) pipeline.push(dim("  ... enlarge the terminal for the pipeline"));
    }
    lines.push(...pipeline);
    lines.push("");
    lines.push(...this.streamLines(width, Math.max(2, height - lines.length - footerLines)));

    while (lines.length < height - footerLines) lines.push("");
    // Keep controls reachable even when expanded details exceed the terminal.
    if (lines.length > height - footerLines) {
      lines.length = height - footerLines;
      lines[lines.length - 1] = dim("  ... enlarge the terminal or press d for fewer details");
    }
    lines.push(gray("-".repeat(width)));

    lines.push(...keyLines);
    lines.push(this.busy ? yellow(this.status) : this.status || dim("ready"));

    return lines.slice(0, height).map(line => clip(line, width));
  }

  render() {
    if (!this.running) return;
    const painted = this.buildLines().map(line => line + CLEAR_LINE);
    process.stdout.write(CURSOR_HOME + painted.join("\n") + CLEAR_BELOW);
  }

  /**
   * Runs a manager action, keeping the UI responsive and always refreshing
   * afterwards so the table reflects the new reality.
   * @param {string} label
   * @param {(svc: any) => Promise<any>} action
   */
  async runAction(label, action) {
    if (this.busy) return;
    const svc = this.currentService();
    if (!svc) return;

    this.busy = true;
    this.status = `${label} ${svc.id}...`;
    this.render();

    try {
      const res = await action(svc);
      const message = [res?.message || `${label} ${svc.id}: done`, res?.codexConfig?.message].filter(Boolean).join(" | ");
      this.status = res && res.success === false ? red(message)
        : res?.codexConfig?.status === "warning" ? yellow(message) : green(message);
    } catch (err) {
      this.status = red(`${label} ${svc.id}: ${err?.message || err}`);
    } finally {
      this.busy = false;
    }

    await this.refresh();
    this.render();
  }

  /**
   * @param {string} key
   */
  onKey(key) {
    if (this.proxySetup && key !== "\u0003") {
      if (this.busy) return;
      const command = this.proxySetup.handle(key);
      if (command === "cancel") this.proxySetup = null;
      else if (command) this.runProxySetupAction(command);
      this.render();
      return;
    }
    if (key === "\u0003" || key === "q") {
      this.stop();
      return;
    }

    switch (key) {
      case "c":
        if (this.busy) return;
        try { this.proxySetup = new ProxySetupWizard(manager.readState()); }
        catch (error) { this.status = red(error.message); }
        this.render();
        return;
      case "d":
        this.showPipelineDetails = !this.showPipelineDetails;
        this.render();
        return;
      case KEY_UP:
        this.selected = Math.max(0, this.selected - 1);
        this.render();
        return;
      case KEY_DOWN:
        this.selected = Math.min(this.statuses.length - 1, this.selected + 1);
        this.render();
        return;
      case "s":
        this.runAction("Start", svc => manager.startService(svc.id));
        return;
      case "x":
        this.runAction("Stop", svc => manager.stopService(svc.id));
        return;
      case "r":
        this.runAction("Restart", svc => manager.restartService(svc.id));
        return;
      case "u":
        return this.runAction("Update", async svc => {
          this.invalidateVersions();
          try {
            return await manager.updateService(svc.id);
          } finally {
            // Drop pre-update and mid-update checks even if installation failed.
            this.invalidateVersions();
          }
        });
      case "k":
        this.runAction("Kill", async svc => {
          if (!svc.pid) return { success: false, message: `${svc.id}: no PID to kill` };
          return killProcessTree(svc.pid);
        });
        return;
      case "o":
        if (!this.currentService()?.dashboardUrl) return;
        this.runAction("Dashboard", async svc => {
          const opened = await manager.openDashboard([svc.id]);
          return { success: opened.length > 0, message: opened.length ? `Opened ${opened[0].url}` : "No dashboard available" };
        });
        return;
      case "g":
        if (!this.currentService()?.repositoryUrl) return;
        this.runAction("GitHub", async svc => {
          const opened = await manager.openRepository([svc.id]);
          return { success: opened.length > 0, message: opened.length ? `Opened ${opened[0].url}` : "No repository available" };
        });
        return;
      default:
        return;
    }
  }

  async runProxySetupAction(command) {
    if (this.busy || !this.proxySetup) return;
    const wizard = this.proxySetup;
    this.busy = true;
    this.render();
    try {
      const options = wizard.validate();
      const hindsight = wizard.hindsightSettings();
      if (command === "check") {
        wizard.checks = [];
        const checks = await preflightProxy(options, (await manager.syncState()).services.proxy);
        if (hindsight) checks.push(...await preflightHindsight(hindsight.config, { newKey: hindsight.apiKey }));
        wizard.checks = checks;
      } else {
        const startup = { startServices: wizard.draft.startServices.split(","), ...(hindsight ? { hindsight } : {}) };
        const result = command === "save" ? manager.saveProxyConfiguration(options, startup)
          : await manager.applyProxyConfiguration(options, startup);
        if (!result.success) throw new Error(result.message);
        this.status = [result.message, result.codexConfig?.message].filter(Boolean).join(" | ");
        this.proxySetup = null;
      }
    } catch (error) { wizard.error = error.message; }
    finally { this.busy = false; }
    await this.refresh();
    this.render();
  }

  enterScreen() {
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE + "\x1b[?2004h");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", this.onData);
    }
    process.stdout.on("resize", this.onResize);
    process.on("SIGINT", this.onSigint);
    process.on("uncaughtException", this.onFatal);
    process.on("unhandledRejection", this.onFatal);
  }

  /** Always restores the terminal, even on a crash. */
  leaveScreen() {
    this.keyDecoder?.dispose();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {}
      process.stdin.off("data", this.onData);
      process.stdin.pause();
    }
    process.stdout.off("resize", this.onResize);
    process.off("SIGINT", this.onSigint);
    process.off("uncaughtException", this.onFatal);
    process.off("unhandledRejection", this.onFatal);
    process.stdout.write("\x1b[?2004l" + CURSOR_SHOW + ALT_SCREEN_OFF);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.leaveScreen();
  }

  async start() {
    this.keyDecoder = new KeyDecoder(key => this.onKey(key));
    this.onData = chunk => {
      this.keyDecoder.push(String(chunk));
    };
    this.onResize = () => this.render();
    this.onSigint = () => this.stop();
    this.onFatal = err => {
      this.stop();
      console.error(red(`[aih] ${err?.message || err}`));
      process.exitCode = 1;
    };

    this.running = true;
    this.enterScreen();

    await this.refresh();
    this.render();

    this.timer = setInterval(async () => {
      if (!this.running || this.busy) return;
      await this.refresh();
      this.render();
    }, TICK_MS);

    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }
}

/**
 * Splits a raw stdin chunk into individual keys, keeping arrow escape
 * sequences whole so a fast keypress burst is not misread as letters.
 * @param {string} chunk
 * @returns {string[]}
 */
export function splitKeys(chunk) {
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    const escape = chunk.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z~]/);
    if (escape) {
      keys.push(escape[0]);
      i += escape[0].length;
      continue;
    }
    const point = String.fromCodePoint(chunk.codePointAt(i));
    keys.push(point);
    i += point.length;
  }
  return keys;
}

/** CSI/paste sequences may arrive across separate stdin chunks. */
export class KeyDecoder {
  constructor(onKey) { this.onKey = onKey; this.pending = ""; }
  push(chunk) {
    clearTimeout(this.timer);
    const input = this.pending + chunk;
    this.pending = "";
    const partial = input.match(/\x1b(?:\[[0-9;]*)?$/);
    const complete = partial ? input.slice(0, -partial[0].length) : input;
    for (const key of splitKeys(complete)) this.onKey(key);
    if (partial) {
      this.pending = partial[0];
      this.timer = setTimeout(() => this.flush(), 50);
      this.timer.unref?.();
    }
  }
  flush() {
    clearTimeout(this.timer);
    const pending = this.pending;
    this.pending = "";
    // A bare Esc is cancellation; truncated CSI must not turn into text/actions.
    if (pending === "\x1b") this.onKey(pending);
  }
  dispose() { clearTimeout(this.timer); this.pending = ""; }
}

/**
 * Entry point for the interactive dashboard.
 * @returns {Promise<void>}
 */
export async function runDashboard() {
  const dashboard = new Dashboard();
  await dashboard.start();
}
