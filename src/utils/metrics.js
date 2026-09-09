import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * On first read we only look at the tail of the events file, which is
 * append-only and already several MB on an active machine.
 */
const INITIAL_TAIL_BYTES = 64 * 1024;

/**
 * Headroom keeps a rolling breakdown of where the token savings came from in
 * subscription_state.json. This is the only place in the ecosystem that splits
 * the total into compression vs provider cache reads: the per-request event log
 * only ever reports source "proxy", and neither pxpipe nor agentmemory publish
 * savings counters of their own.
 * @returns {string}
 */
export function getSavingsBreakdownPath() {
  const custom = process.env.HEADROOM_HOME;
  const base = custom && custom.trim().length > 0 ? custom : join(homedir(), ".headroom");
  return join(base, "subscription_state.json");
}

/**
 * Reads the savings breakdown. Returns null whenever the file is missing or
 * malformed so the panel degrades instead of breaking the render loop.
 * @param {string} [path]
 * @returns {{ submitted: number, compression: number, cacheReads: number, total: number, ratio: number | null } | null}
 */
export function readSavingsBreakdown(path) {
  const file = path || getSavingsBreakdownPath();
  if (!existsSync(file)) return null;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }

  const contribution = parsed?.contribution;
  const saved = contribution?.tokens_saved;
  if (!saved || typeof saved !== "object") return null;

  const numeric = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

  const compression = numeric(saved.compression);
  const cacheReads = numeric(saved.cache_reads);
  const total = numeric(saved.total) || compression + cacheReads;
  const submitted = numeric(contribution.tokens_submitted);

  // The raw baseline is what would have been sent without any optimisation, so
  // it is the only honest denominator for a savings percentage.
  const baseline = numeric(contribution.raw_without_headroom) || submitted + total;

  return {
    submitted,
    compression,
    cacheReads,
    total,
    ratio: baseline > 0 ? total / baseline : null,
  };
}

/**
 * Parses a Prometheus text exposition payload into a flat name -> number map.
 * Comment lines and labelled series are ignored: the dashboard only needs the
 * plain global counters.
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function parseProm(text) {
  const out = {};
  if (!text || typeof text !== "string") return out;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.includes("{")) continue;

    const sep = line.lastIndexOf(" ");
    if (sep <= 0) continue;

    const name = line.slice(0, sep).trim();
    const value = Number(line.slice(sep + 1).trim());
    if (name.length === 0 || !Number.isFinite(value)) continue;

    out[name] = value;
  }

  return out;
}

/**
 * Turns two snapshots of cumulative counters into per-second rates.
 * Returns null for a metric when no rate can be computed yet: no previous
 * sample, a metric that just appeared, or a counter that went backwards
 * (which means the service restarted).
 * @param {Record<string, number> | null} prev
 * @param {Record<string, number> | null} curr
 * @param {number} deltaMs
 * @returns {Record<string, number | null>}
 */
export function diffRates(prev, curr, deltaMs) {
  const rates = {};
  if (!curr) return rates;

  const usable = prev && Number.isFinite(deltaMs) && deltaMs > 0;

  for (const key of Object.keys(curr)) {
    if (!usable) {
      rates[key] = null;
      continue;
    }

    const before = prev[key];
    if (typeof before !== "number") {
      rates[key] = null;
      continue;
    }

    const delta = curr[key] - before;
    rates[key] = delta < 0 ? null : delta / (deltaMs / 1000);
  }

  return rates;
}

/**
 * Incrementally reads new JSON lines from an append-only JSONL file.
 * Only whole lines are consumed: the returned offset always points at a line
 * boundary, so a half-written record is re-read on the next tick instead of
 * being dropped. Malformed lines are skipped silently.
 * @param {string} path
 * @param {number} [fromOffset] Byte offset returned by a previous call.
 * @param {number} [maxLines] Keep at most this many of the newest events.
 * @returns {{ events: any[]; offset: number }}
 */
export function tailJsonl(path, fromOffset, maxLines = 200) {
  if (!path || !existsSync(path)) return { events: [], offset: 0 };

  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], offset: fromOffset || 0 };
  }

  let start;
  if (typeof fromOffset === "number" && fromOffset >= 0 && fromOffset <= size) {
    start = fromOffset;
  } else {
    // First read, or the file was truncated / rotated under us.
    start = Math.max(0, size - INITIAL_TAIL_BYTES);
  }

  if (start >= size) return { events: [], offset: size };

  const length = size - start;
  const buffer = Buffer.alloc(length);
  let fd;
  try {
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, start);
  } catch {
    return { events: [], offset: fromOffset || 0 };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  const text = buffer.toString("utf-8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    // No complete line in this window yet: stay where we are.
    return { events: [], offset: start };
  }

  const consumed = text.slice(0, lastNewline + 1);
  const offset = start + Buffer.byteLength(consumed, "utf-8");

  const events = [];
  const lines = text.slice(0, lastNewline).split("\n");
  for (const line of lines.slice(-maxLines)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Truncated first line of the initial window, or a partial flush.
    }
  }

  return { events, offset };
}

/**
 * Strips any path from a service URL, leaving scheme://host:port.
 * @param {string} [url]
 * @returns {string}
 */
export function baseUrl(url) {
  if (!url || url === "-") return "";
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "";
  }
}

/**
 * Fetches a URL with a hard timeout. Returns null on any failure so that a
 * dead service degrades a panel instead of breaking the render loop.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
export async function fetchText(url, timeoutMs = 2000) {
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<any | null>}
 */
export async function fetchJson(url, timeoutMs = 2000) {
  const text = await fetchText(url, timeoutMs);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Resolves the operational pipeline the AI calls flow through.
 * The static chain (client -> headroom -> pxpipe -> upstream) is derived from
 * the managed services; headroom's /health is used to confirm the live wiring
 * and is optional, so the panel still renders when headroom is down.
 * @param {Array<{ id: string; status: string; url?: string }>} statuses
 * @returns {Promise<{ nodes: Array<{ id: string; label: string; state: string; detail: string }>; health: any | null }>}
 */
export async function probeChain(statuses) {
  const byId = {};
  for (const svc of statuses || []) byId[svc.id] = svc;

  const proxy = byId.proxy;
  if (proxy?.proxyOptions) {
    const preset = proxy.proxyOptions.preset || "none";
    const stages = preset === "none" ? [] : preset.split("-").map(id => ({
      id, label: id === "pxpipe" ? "pxpipe (libreria)" : id === "rtk" ? "rtk (pipe)" : "headroom (compress)",
      state: id === "pxpipe" ? proxy.status : "static", detail: id === "headroom" ? proxy.proxyOptions.headroomUrl : "",
    }));
    return { nodes: [
      { id: "client", label: "client", state: "static", detail: "AI agents / CLI" },
      { id: "proxy", label: "aih proxy", state: proxy.status, detail: proxy.url },
      ...stages,
      { id: "upstream", label: "upstream", state: "static", detail: proxy.proxyOptions.upstream },
    ], health: null };
  }

  const stateOf = id => byId[id]?.status || "unknown";

  const nodes = [
    { id: "client", label: "client", state: "static", detail: "AI agents / CLI" },
    { id: "headroom", label: "headroom", state: stateOf("headroom"), detail: baseUrl(byId.headroom?.url) },
    { id: "pxpipe", label: "pxpipe", state: stateOf("pxpipe"), detail: baseUrl(byId.pxpipe?.url) },
    { id: "upstream", label: "upstream", state: "static", detail: "" },
  ];

  const headroomBase = baseUrl(byId.headroom?.url);
  const health = headroomBase ? await fetchJson(`${headroomBase}/health`, 2000) : null;

  if (health) {
    if (health.version) nodes[1].detail = `${nodes[1].detail} v${health.version}`.trim();
    if (health.status && health.status !== "healthy") nodes[1].state = "error";

    const upstream = health.checks?.upstream;
    if (upstream?.url) {
      // headroom reports where it actually forwards to, which is pxpipe.
      nodes[2].detail = upstream.url;
      if (upstream.status && upstream.status !== "healthy" && nodes[2].state === "running") {
        nodes[2].state = "error";
      }
    }
  }

  return { nodes, health };
}
