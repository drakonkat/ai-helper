import http from "node:http";
import net from "node:net";
import { syncCodexProxyConfig } from "./codex-config.js";
import { isPidRunning, sleep } from "./utils/process.js";

function localListener(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port === "0" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Expected a bound HTTP loopback listener");
  }
  return url;
}

/** TCP only: checking a reverse proxy must not generate an upstream AI request. */
export function probeProxyListener(value, timeoutMs = 1000) {
  let url;
  try { url = localListener(value); } catch { return Promise.resolve(false); }
  return new Promise(resolve => {
    const socket = net.createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** Bounded unauthenticated readiness probe, with no redirects or payload logging. */
function readOcxReadiness(url, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const request = http.get(new URL("/readyz", url), response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 8192) finish(null);
        else chunks.push(chunk);
      });
      response.once("error", () => finish(null));
      response.once("end", () => {
        try { finish({ ...JSON.parse(Buffer.concat(chunks).toString("utf8")), code: response.statusCode }); }
        catch { finish({ code: response.statusCode }); }
      });
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(result);
    }
    request.once("error", () => finish(null));
  });
}

/** /healthz and a live PID are insufficient: ocx writes Codex config late in startup. */
export async function waitForOcxReady(value, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  let url;
  try { url = localListener(value); } catch { return { ready: false, reason: "ocx has no valid loopback address" }; }
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await readOcxReadiness(url, Math.max(1, Math.min(1000, deadline - Date.now())));
    if (result?.service === "opencodex" && result.status === "ready" && result.code === 200) return { ready: true };
    if (result?.service === "opencodex" && result.status === "failed") return { ready: false, reason: "ocx startup configuration failed" };
    if (result && (result.service !== "opencodex" || !["pending", "ready"].includes(result.status))) {
      return { ready: false, reason: "ocx does not expose a recognized /readyz endpoint; update ocx before automatic configuration" };
    }
    if (Date.now() < deadline) await sleep(Math.min(intervalMs, deadline - Date.now()));
  } while (Date.now() < deadline);
  return { ready: false, reason: "timed out waiting for ocx to finish configuring Codex" };
}

function sameListener(left, right) {
  try {
    const a = localListener(left);
    const b = localListener(right);
    // All supported listen hosts are loopback aliases.
    return (a.port || "80") === (b.port || "80");
  } catch { return false; }
}

/** Only explicit start/restart actions call this; status/discovery never edits Codex. */
export async function configureCodexForProxy(state, {
  waitForOcx = false,
  env = process.env,
  isRunning = isPidRunning,
  probe = probeProxyListener,
  waitReady = waitForOcxReady,
  apply = syncCodexProxyConfig,
  readState = () => state,
} = {}) {
  if (env.AIH_CODEX_AUTOCONFIG === "0") return { status: "skipped" };
  const proxy = state.services?.proxy;
  if (!proxy?.proxyOptions || proxy.status !== "running" || !isRunning(proxy.pid)) return { status: "skipped" };
  const warning = reason => ({ status: "warning", message: `Codex configuration unchanged: ${reason}. Retry 'aih start proxy' when ready.` });
  try {
    // This integration targets the standard /v1 API on a root upstream. Prefixes
    // such as /v1 or /backend-api/codex need a different client base path.
    if (new URL(proxy.proxyOptions.upstream).pathname !== "/") {
      return { status: "warning", message: "Codex configuration unchanged: this proxy has an upstream path prefix. Configure Codex's base URLs manually to avoid duplicating the API path." };
    }
    if (!await probe(proxy.url)) return warning("the aih proxy listener is unavailable");
    const ocx = state.services.ocx;
    // When the proxy starts second, also wait for the known ocx upstream to finish its writes.
    const ocxIsUpstream = ocx?.status === "running" && isRunning(ocx.pid)
      && sameListener(proxy.proxyOptions.upstream, ocx.url);
    if (waitForOcx || ocxIsUpstream) {
      if (ocx?.status !== "running" || !isRunning(ocx.pid)) return warning("ocx is no longer running");
      const readiness = await waitReady(ocx.url);
      if (!readiness.ready) return warning(readiness.reason);
    }
    // Do not write an obsolete port if another action stopped/restarted the proxy while waiting.
    if (!await probe(proxy.url)) return warning("the aih proxy changed or stopped during configuration");
    const latestState = readState();
    const latest = latestState.services?.proxy;
    if (latest?.status !== "running" || latest.pid !== proxy.pid || latest.url !== proxy.url || !isRunning(latest.pid)) {
      return warning("the aih proxy changed or stopped during configuration");
    }
    if (waitForOcx || ocxIsUpstream) {
      const latestOcx = latestState.services?.ocx;
      if (latestOcx?.status !== "running" || latestOcx.pid !== ocx.pid || latestOcx.url !== ocx.url || !isRunning(latestOcx.pid)) {
        return warning("ocx changed or stopped during configuration");
      }
    }
    return apply(latest.url, { env });
  } catch {
    return warning("automatic configuration could not be completed safely");
  }
}
