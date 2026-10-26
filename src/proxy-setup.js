import { createServer } from "node:net";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeProxyOptions } from "./proxy.js";
import { PRESETS } from "./proxy-presets.js";

export const PROXY_FIELDS = Object.freeze([
  { key: "upstream", group: "Connection", label: "Upstream URL", help: "Where the AIH proxy forwards requests, e.g. OCX. Required HTTP(S) URL; no credentials, query or fragment." },
  { key: "listen", group: "Connection", label: "Proxy listen address", help: "Where clients connect to the AIH proxy. HTTP on loopback, e.g. http://127.0.0.1:10101" },
  { key: "preset", group: "Pipeline", label: "Tool combination", choices: PRESETS, help: "Fixed order: RTK -> Headroom -> pxpipe. none = forwarding only." },
  { key: "models", group: "Models", label: "Included models", help: "* = all. Comma-separated names; trailing wildcard: anthropic/claude-fable*. Excluded models bypass the pipeline. Empty = pxpipe defaults; RTK/Headroom on all." },
  { key: "headroomUrl", group: "Tool options", label: "Headroom URL", stage: "headroom", help: "Headroom HTTP(S) endpoint. Default: http://127.0.0.1:8787" },
  { key: "rtkFilter", group: "Tool options", label: "RTK filter", stage: "rtk", help: "Empty = automatic detection. Lowercase letters, numbers and hyphens." },
  { key: "pxpipeNativeImages", group: "Tool options", label: "pxpipe native images", stage: "pxpipe", choices: ["allow", "bypass"], help: "allow = process requests; bypass = skip pxpipe for requests containing native images." },
  { key: "interceptor", group: "Advanced", label: "Interceptor file", help: "Path to a .mjs file (spaces allowed). Empty = none. Runs after the presets." },
  { key: "maxBodyBytes", group: "Advanced", label: "Maximum body size (bytes)", help: "Positive integer. Default 67108864 (64 MiB)." },
]);

export function proxySetupDraft(state) {
  const options = { upstream: "", listen: "http://127.0.0.1:10101", preset: "none",
    headroomUrl: "http://127.0.0.1:8787", pxpipeNativeImages: "allow", maxBodyBytes: 67108864,
    models: state.config?.pxpipeModels, ...state.services?.proxy?.proxyOptions, ...state.config?.proxyOptions };
  return Object.fromEntries(PROXY_FIELDS.map(({ key }) => [key, String(options[key] ?? "")]));
}

export function normalizeSetupDraft(draft) {
  return normalizeProxyOptions({ ...draft, upstream: draft.upstream.trim(), listen: draft.listen.trim(),
    headroomUrl: draft.headroomUrl.trim(), interceptor: draft.interceptor.trim(), rtkFilter: draft.rtkFilter.trim() });
}

// JSON drops undefined: explicit empty values must survive to clear older overrides.
export function savedProxyOptions(config) {
  return { ...config, models: config.models ?? "", interceptor: config.interceptor ?? "", rtkFilter: config.rtkFilter ?? "" };
}

// Never import the interceptor during preflight: configuration checks must not execute user code.
export async function preflightProxy(options, current, {
  run = promisify(execFile), fetchImpl = fetch,
} = {}) {
  const config = normalizeProxyOptions(options);
  const checks = [];
  if (config.interceptor) {
    if (!config.interceptor.endsWith(".mjs")) throw new Error("Interceptor: select a .mjs file");
    await access(config.interceptor, constants.R_OK);
    if (!(await stat(config.interceptor)).isFile()) throw new Error("Interceptor: the path is not a file");
    checks.push("Interceptor is readable (code not executed)");
  }
  if (config.preset.split("-").includes("rtk")) {
    await run("rtk", ["--version"], { timeout: 5000, windowsHide: true, maxBuffer: 65536 });
    checks.push("RTK available");
  }
  if (config.preset.includes("pxpipe")) {
    await import("pxpipe-proxy");
    checks.push("pxpipe library available (pxpipe service not required)");
  }
  const listen = new URL(config.listen);
  const sameListener = current?.status === "running" && current?.url && (() => {
    const active = new URL(current.url);
    return active.port === listen.port && active.protocol === listen.protocol;
  })();
  if (!sameListener) await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", error => reject(new Error(`Listen port unavailable: ${error.message}`)));
    server.listen(Number(listen.port || 80), listen.hostname.replace(/^\[|\]$/g, ""), () => server.close(resolve));
  });
  checks.push(sameListener ? "Current listener: will be reused on restart" : "Listen port available");
  // These probes are advisory: authenticated upstreams often reject unauthenticated HEAD.
  for (const [name, url] of [["Upstream", config.upstream], ...(config.preset.includes("headroom") ? [["Headroom", new URL("health", config.headroomUrl.endsWith("/") ? config.headroomUrl : config.headroomUrl + "/").href]] : [])]) {
    try {
      const response = await fetchImpl(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(3000) });
      checks.push(`${name}: HTTP ${response.status} (reachable; authentication/functionality not verified)`);
      await response.body?.cancel();
    } catch { checks.push(`Warning: ${name} unreachable; check the URL and service before use`); }
  }
  return checks;
}
