import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME, VERSION } from "./config.js";
import { manager } from "./manager.js";
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
import { readProxyStats, proxyStatsLines } from "./proxy-stats.js";
import { getServiceVersions } from "./utils/versions.js";
import {
  baseUrl,
  diffRates,
  fetchText,
  parseProm,
  probeChain,
  readSavingsBreakdown,
  tailJsonl,
} from "./utils/metrics.js";

const TICK_MS = 1000;
const STALE_MS = 5 * TICK_MS;
const VERSION_CHECK_MS = 5 * 60 * 1000;
const MAX_EVENTS = 200;

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
 * Location of headroom's append-only savings event log: the only real-time
 * per-request source in the ecosystem (pxpipe exposes no API).
 * @returns {string}
 */
function getEventsFilePath() {
  const custom = process.env.HEADROOM_HOME;
  const base = custom && custom.trim().length > 0 ? custom : join(homedir(), ".headroom");
  return join(base, "savings_events.jsonl");
}

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
        line += (line === indent ? "" : " ") + word;
      }
      continue;
    }
    const next = line === indent ? cell : dim(separator) + cell;
    if (line !== indent && stripAnsi(line + next).length > width) {
      lines.push(line);
      line = indent + (separator === " -> " ? dim("-> ") : "") + cell;
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
      return green(`[ ${node.label}: verificato ]`);
    case "running":
      return `[ ${node.label}: processo attivo ]`;
    case "error":
      return red(bold(`[ ${node.label}: errore ]`));
    case "stopped":
      return dim(`[ ${node.label}: fermo ]`);
    case "static":
      return `[ ${node.label} ]`;
    default:
      return yellow(`[ ${node.label}: non verificato ]`);
  }
}

export class Dashboard {
  constructor({ getVersions = getServiceVersions } = {}) {
    this.statuses = [];
    this.getVersions = getVersions;
    this.versions = {};
    this.versionsKey = "";
    this.versionsAt = 0;
    this.versionsLoading = false;
    this.metrics = null;
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
    this.health = null;
    this.events = [];
    this.eventsOffset = undefined;
    this.eventsFile = getEventsFilePath();
    this.eventsFileSeen = false;
    this.savings = null;
    this.proxyStats = null;
    this.selected = 0;
    this.status = "";
    this.busy = false;
    this.running = false;
    this.timer = null;
    this.refreshing = false;
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
      this.versionsAt = 0;
      this.versions = {};
    }
    if (this.versionsLoading || (this.versionsAt && Date.now() - this.versionsAt < VERSION_CHECK_MS)) return;

    this.versionsLoading = true;
    try {
      const versions = await this.getVersions(this.statuses);
      if (key === this.versionsKey) this.versions = versions;
    } catch {
      // An unavailable registry must not interrupt service controls or metrics.
      if (key === this.versionsKey) this.versions = {};
    } finally {
      if (key === this.versionsKey) this.versionsAt = Date.now();
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
      if (this.selected >= this.statuses.length) {
        this.selected = Math.max(0, this.statuses.length - 1);
      }

      const headroom = this.statuses.find(s => s.id === "headroom");
      const headroomBase = headroom && headroom.status === "running" ? baseUrl(headroom.url) : "";

      const metricsKey = JSON.stringify([headroomBase, headroom?.pid]);
      if (metricsKey !== this.metricsKey) this.prevMetrics = null;
      this.metricsKey = metricsKey;
      const [metricsText, probed] = await Promise.all([
        headroomBase ? fetchText(`${headroomBase}/metrics`, 2000) : null,
        probeChain(this.statuses),
      ]);
      const parsed = parseProm(metricsText);
      const now = Date.now();
      if (Object.keys(parsed).some(name => name.startsWith("headroom_"))) {
        this.sampleMs = this.prevMetrics ? now - this.prevAt : null;
        this.rates = diffRates(this.prevMetrics, parsed, this.sampleMs);
        this.prevMetrics = parsed;
        this.prevAt = now;
        this.metrics = parsed;
        this.metricsAt = now;
        this.metricsError = null;
      } else {
        // Keep the last totals for diagnosis, never an old gauge or rate as live.
        this.metricsError = headroom?.status !== "running" ? "Headroom non in esecuzione"
          : !headroomBase ? "URL Headroom non disponibile"
          : metricsText === null ? "raccolta fallita" : "risposta senza metriche Headroom";
        this.rates = {};
        this.prevMetrics = null;
        this.sampleMs = null;
      }

      this.chain = probed.nodes;
      this.chainAt = now;
      this.health = probed.health;

      const tail = tailJsonl(this.eventsFile, this.eventsOffset, MAX_EVENTS);
      this.eventsOffset = tail.offset;
      if (tail.offset > 0) this.eventsFileSeen = true;
      if (tail.events.length > 0) {
        this.events = this.events.concat(tail.events).slice(-MAX_EVENTS);
      }

      this.savings = readSavingsBreakdown();
      this.proxyStats = readProxyStats();
    } catch (err) {
      this.metricsError = "aggiornamento fallito";
      this.rates = {};
      this.prevMetrics = null;
      this.chainAt = null;
      this.status = red(`Refresh error: ${err?.message || err}`);
    } finally {
      this.refreshing = false;
    }
  }

  /** Pipeline rows wrap whole fields rather than clipping useful values. */
  pipelineLines(width, now = Date.now()) {
    const lines = [bold("PIPELINE") + dim("  metriche Headroom")];
    const add = (cells, separator) => lines.push(...wrapCells(cells, width, separator));
    const chainFresh = this.chainAt !== null && now - this.chainAt <= STALE_MS;
    add(this.chain.map(node => paintNode(chainFresh || node.state === "static"
      ? node : { ...node, state: "unknown" })), " -> ");

    const stale = this.metricsAt === null || Boolean(this.metricsError) || now - this.metricsAt > STALE_MS;
    const freshness = this.metricsAt === null ? "nessun campione"
      : `ultimo campione ${age(this.metricsAt, now)} fa`;
    const freshnessText = stale ? yellow(`Dati non aggiornati: ${freshness}`) : `Aggiornati ${age(this.metricsAt, now)} fa`;
    if (stripAnsi(lines[0] + "  |  " + freshnessText).length <= width) lines[0] += dim("  |  ") + freshnessText;
    else add([freshnessText]);
    if (this.metricsError) add([yellow(this.metricsError)]);

    if (this.metrics) {
      const m = this.metrics;
      add([bold("Adesso"), stale ? dim("attivita non disponibile")
        : `${cyan(bold(num(m.headroom_inbound_requests_active)))} in corso`,
      ...(stale ? [] : [`${bold(num(this.rates.headroom_requests_total, 2))} req/s`])]);
      const input = m.headroom_tokens_input_total;
      const saved = m.headroom_tokens_saved_total;
      const savingRatio = Number.isFinite(input) && Number.isFinite(saved) && input + saved > 0
        ? saved / (input + saved) : null;
      const cacheRatio = Number.isFinite(m.headroom_requests_cached_total) && m.headroom_requests_total > 0
        ? m.headroom_requests_cached_total / m.headroom_requests_total : null;
      const latency = Number.isFinite(m.headroom_latency_ms_sum) && m.headroom_latency_ms_count > 0
        ? m.headroom_latency_ms_sum / m.headroom_latency_ms_count : null;
      const duration = latency === null ? "-" : latency < 1000 ? `${Math.round(latency)} ms` : `${(latency / 1000).toFixed(1)} s`;
      add([bold("Dall'avvio dei contatori") + (stale ? yellow(" (ultimo campione)") : "")]);
      add([`Token risparmiati ${bold(pct(savingRatio))}`, `Richieste cached ${bold(pct(cacheRatio))}`,
        `Durata media ${bold(duration)}`]);
    }

    if (this.showPipelineDetails) {
      for (const node of this.chain) {
        if (node.detail) add([`${node.label}: ${node.detail}`]);
        if (node.state === "running") add([yellow(`${node.label}: health non verificato`)]);
      }
      if (!chainFresh) add([yellow("Stati della catena non aggiornati")]);
      if (this.metrics && !stale) {
        add([`Token in/s ${num(this.rates.headroom_tokens_input_total, 1)}`,
          `Token out/s ${num(this.rates.headroom_tokens_output_total, 1)}`]);
        add([dim(this.sampleMs === null ? "Velocita: in attesa del secondo campione"
          : `Velocita: ultimo intervallo di ${(this.sampleMs / 1000).toFixed(1)} s`)]);
      }
      add([dim("Token risparmiati: saved / (input + saved)")]);
      add([dim("Richieste cached: cached / richieste totali")]);
      add([dim("Durata media: somma latenze / campioni")]);
      add([dim("Cache richieste != risparmio economico")]);
    }
    return lines.map(line => clip(line, width));
  }

  /**
   * Builds the whole screen as an array of lines.
   * @returns {string[]}
   */
  buildLines() {
    const width = Math.max(40, process.stdout.columns || 100);
    const height = Math.max(12, process.stdout.rows || 30);
    const lines = [];
    const svc = this.currentService();
    const target = svc ? bold(svc.id) : dim("-");
    const keyLines = wrapCells([
      `${dim("d")} ${this.showPipelineDetails ? "riduci" : "dettagli"}`,
      `${dim("q")} esci`,
      `${dim("up/down")} seleziona (${target})`,
      `${dim("s")} start`,
      `${dim("x")} stop`,
      `${dim("r")} restart`,
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
      "VERSION",
      "UPDATE",
      { header: "PID", align: "right" },
      { header: "UPTIME", align: "right" },
      "REPO",
      "URL",
    ];
    const rows = this.statuses.map((s, idx) => {
      const active = idx === this.selected;
      const version = this.versions[s.id];
      const update = version?.updateAvailable === true
        ? yellow(bold(`↑ ${version.latestVersion}`))
        : version?.updateAvailable === false
          ? green("aggiornato")
          : dim(this.versionsLoading && !version ? "verifica..." : "n/d");
      return [
        active ? cyan(bold(">")) : " ",
        active ? bold(white(s.id)) : bold(s.id),
        badgeStatus(s.status),
        version?.version || dim("n/d"),
        update,
        s.pid ? String(s.pid) : dim("-"),
        s.status === "running" ? s.uptime : dim("-"),
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
    if (svc?.repositoryUrl) {
      // Keep both full links accessible when terminal width clips their columns.
      lines.push(...wrapCells([
        ...(svc.url && svc.url !== "-" ? [`${dim("URL:")} ${cyan(underline(svc.url))}`] : []),
        `${dim("GitHub (g):")} ${cyan(underline(svc.repositoryUrl))}`,
      ], width));
    }
    lines.push("");

    if (this.statuses.some(s => s.id === "proxy") || this.proxyStats) {
      lines.push(...proxyStatsLines(this.proxyStats));
      const last = this.proxyStats?.recent.at(-1);
      if (last) lines.push(dim(`  Ultima: ${last.model} ${last.preset} | ${last.error ? "errore" : last.stages.map(s => `${s.name}: ${s.reason}`).join(" | ")}`));
      lines.push("");
    }

    lines.push(...this.pipelineLines(width));
    lines.push("");

    lines.push(bold("STREAM RICHIESTE") + dim("  " + this.eventsFile));

    // Every event in the stream is source "proxy": headroom is the only service
    // that reports per-request savings. The split below is the one place that
    // says how much came from compression versus provider cache reuse.
    if (this.savings) {
      const sv = this.savings;
      const savingsCells = [
        `${dim("risparmio")} ${green(bold(num(sv.total)))}`,
        `${dim("compress")} ${bold(num(sv.compression))}`,
        `${dim("cache")} ${bold(num(sv.cacheReads))}`,
        `${dim("inviati")} ${bold(num(sv.submitted))}`,
        `${dim("efficienza")} ${green(bold(pct(sv.ratio)))}`,
      ];
      lines.push("  " + savingsCells.join(dim("  .  ")));
    }

    const slots = Math.max(1, height - lines.length - footerLines);

    if (this.events.length === 0) {
      lines.push(
        "  " +
          dim(
            this.eventsFileSeen
              ? "in attesa di richieste..."
              : "nessun file eventi: headroom non ha ancora scritto savings_events.jsonl"
          )
      );
    } else {
      for (const ev of this.events.slice(-slots)) {
        const time = ev.ts ? String(ev.ts).slice(11, 19) : "--:--:--";
        const before = Number(ev.before);
        const after = Number(ev.after);
        const saved = Number(ev.saved);
        const ratio = Number.isFinite(before) && before > 0 ? saved / before : null;
        const cost = Number(ev.cost_usd);
        const cells = [
          gray(time),
          magenta(String(ev.model || "?").padEnd(16).slice(0, 16)),
          `${dim("tok")} ${num(before)}${gray("->")}${num(after)}`,
          green(`-${num(saved)} (${pct(ratio)})`),
          dim(Number.isFinite(cost) ? "$" + cost.toFixed(4) : "-"),
          dim(String(ev.source || ev.client || "")),
        ];
        lines.push("  " + cells.join("  "));
      }
    }

    while (lines.length < height - footerLines) lines.push("");
    // Keep controls reachable even when expanded details exceed the terminal.
    if (lines.length > height - footerLines) {
      lines.length = height - footerLines;
      lines[lines.length - 1] = dim("  ... aumenta l'altezza o premi d per ridurre i dettagli");
    }
    lines.push(gray("-".repeat(width)));

    lines.push(...keyLines);
    lines.push(this.busy ? yellow(this.status) : this.status || dim("pronto"));

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
      const message = [res?.message || `${label} ${svc.id}: fatto`, res?.codexConfig?.message].filter(Boolean).join(" | ");
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
    if (key === "\u0003" || key === "q") {
      this.stop();
      return;
    }

    switch (key) {
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
        this.runAction("Avvio", svc => manager.startService(svc.id));
        return;
      case "x":
        this.runAction("Stop", svc => manager.stopService(svc.id));
        return;
      case "r":
        this.runAction("Riavvio", svc => manager.restartService(svc.id));
        return;
      case "k":
        this.runAction("Kill", async svc => {
          if (!svc.pid) return { success: false, message: `${svc.id}: nessun PID da terminare` };
          return killProcessTree(svc.pid);
        });
        return;
      case "o":
        if (!this.currentService()?.dashboardUrl) return;
        this.runAction("Dashboard", async svc => {
          const opened = await manager.openDashboard([svc.id]);
          return { success: opened.length > 0, message: opened.length ? `Aperto ${opened[0].url}` : "Nessuna dashboard disponibile" };
        });
        return;
      case "g":
        if (!this.currentService()?.repositoryUrl) return;
        this.runAction("GitHub", async svc => {
          const opened = await manager.openRepository([svc.id]);
          return { success: opened.length > 0, message: opened.length ? `Aperto ${opened[0].url}` : "Nessun repository disponibile" };
        });
        return;
      default:
        return;
    }
  }

  enterScreen() {
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);
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
    process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.leaveScreen();
  }

  async start() {
    this.onData = chunk => {
      for (const key of splitKeys(String(chunk))) this.onKey(key);
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
    if (chunk[i] === "\x1b" && chunk[i + 1] === "[" && chunk[i + 2]) {
      keys.push(chunk.slice(i, i + 3));
      i += 3;
      continue;
    }
    keys.push(chunk[i]);
    i++;
  }
  return keys;
}

/**
 * Entry point for the interactive dashboard.
 * @returns {Promise<void>}
 */
export async function runDashboard() {
  const dashboard = new Dashboard();
  await dashboard.start();
}
