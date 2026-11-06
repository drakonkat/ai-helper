import { baseUrl } from "./utils/metrics.js";
import { probeHindsightHealth } from "./hindsight.js";
import { PROXY_HEALTH_PATH } from "./proxy.js";

export { PROXY_HEALTH_PATH };

const obj = value => value && typeof value === "object" && !Array.isArray(value);
const str = value => typeof value === "string" ? value : null;
const num = value => Number.isFinite(value) ? value : null;

/**
 * Per-service HTTP health checks. "identity" proves the answer comes from the
 * expected service (a port can be reused or forwarded); "ok" decides health.
 */
export const HEALTH_CHECKS = {
  ocx: {
    path: "/healthz",
    identity: b => b.service === "opencodex",
    ok: b => b.status === "ok",
    uptime: b => b.uptime,
  },
  headroom: {
    path: "/health",
    identity: b => b.service ? /^headroom/.test(b.service) : typeof b.status === "string",
    ok: b => b.status === "healthy",
    uptime: b => b.uptime_seconds,
  },
  proxy: {
    path: PROXY_HEALTH_PATH,
    identity: b => b.service === "aih-proxy",
    ok: b => b.status === "ok",
    uptime: b => b.uptime_seconds,
    // Proxies started by older aih releases forward this path to their upstream.
    unverified: "no aih health endpoint (restart the proxy)",
  },
  pxpipe: {
    // pxpipe has no health route; its JSON stats endpoint proves the server answers.
    path: "/proxy-stats",
    identity: () => true,
    ok: () => true,
  },
};

export function hasHealthCheck(svc) {
  return Boolean(svc && (svc.runtime === "docker" || Object.hasOwn(HEALTH_CHECKS, svc.id)));
}

/**
 * healthy: identified and OK | degraded: identified, not OK (or HTTP error)
 * unverified: something answers but is not the expected service | unreachable: no answer.
 */
export async function probeHttpHealth(id, url, { fetchImpl = fetch, timeoutMs = 2000, now = Date.now } = {}) {
  const check = HEALTH_CHECKS[id];
  const base = baseUrl(url);
  const checkedAt = now();
  if (!check || !base) return { state: "unreachable", error: "no URL", checkedAt };
  const target = base + check.path;
  try {
    const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!obj(body) || !check.identity(body)) {
      return { state: "unverified", httpStatus: response.status, url: target, checkedAt,
        error: check.unverified || "unexpected response" };
    }
    return {
      state: response.ok && check.ok(body) ? "healthy" : "degraded",
      httpStatus: response.status, status: str(body.status), version: str(body.version),
      uptimeSeconds: num(check.uptime?.(body)), url: target, checkedAt,
    };
  } catch (error) {
    return { state: "unreachable", url: target, checkedAt,
      error: error?.name === "TimeoutError" ? "timeout" : error?.cause?.code || error?.message || String(error) };
  }
}

/** One entry point for every service status object shown in the dashboard. */
export function probeServiceHealth(svc, options) {
  if (svc.runtime === "docker") return probeHindsightHealth(svc.apiUrl, options);
  return probeHttpHealth(svc.id, svc.url, options);
}
