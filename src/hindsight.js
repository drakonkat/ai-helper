import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { ensureDir, getAihDir, getLogsDir, getServiceLogPath } from "./utils/path.js";
import { execCommand } from "./utils/process.js";

/** Hindsight runs in Docker; these defaults match the upstream quick start. */
export const HINDSIGHT_DEFAULTS = Object.freeze({
  containerName: "hindsight",
  image: "ghcr.io/vectorize-io/hindsight:latest",
  apiPort: 8888,
  uiPort: 9999,
  volume: "hindsight-data",
  llmProvider: "openai",
  llmModel: "",
  llmBaseUrl: "",
  envFile: "",
});
export const HINDSIGHT_RELEASES_URL = "https://api.github.com/repos/vectorize-io/hindsight/releases/latest";
export const HINDSIGHT_KEY_ENV = "HINDSIGHT_API_LLM_API_KEY";
const API_PORT = 8888;
const UI_PORT = 9999;
const DATA_DIR = "/home/hindsight/.pg0";
const NO_KEY_PROVIDERS = new Set(["ollama", "lmstudio"]);
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

function port(value, label) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(label + ": enter a port between 1 and 65535");
  }
  return number;
}

/** Validates the non-secret settings; the API key never belongs in this object. */
export function normalizeHindsightConfig(input = {}) {
  const value = { ...HINDSIGHT_DEFAULTS, ...Object.fromEntries(Object.entries(input || {}).filter(([, v]) => v !== undefined && v !== null)) };
  const text = key => String(value[key] ?? "").trim();
  const config = {
    containerName: text("containerName"), image: text("image"), volume: text("volume"),
    apiPort: port(value.apiPort, "Hindsight API port"), uiPort: port(value.uiPort, "Hindsight UI port"),
    llmProvider: text("llmProvider").toLowerCase(), llmModel: text("llmModel"), llmBaseUrl: text("llmBaseUrl"),
    envFile: text("envFile"),
  };
  if (!DOCKER_NAME.test(config.containerName)) throw new Error("Hindsight container name: letters, digits, '_', '.', '-' (max 128)");
  if (!DOCKER_NAME.test(config.volume)) throw new Error("Hindsight data volume: letters, digits, '_', '.', '-' (max 128)");
  if (!/^[a-z0-9][a-z0-9._\/:@-]{0,254}$/i.test(config.image)) throw new Error("Hindsight image: invalid Docker image reference");
  if (config.apiPort === config.uiPort) throw new Error("Hindsight API and UI ports must differ");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.llmProvider)) throw new Error("Hindsight LLM provider: lowercase letters, digits, '_' or '-'");
  if (CONTROL.test(config.llmModel) || /\s/.test(config.llmModel) || config.llmModel.length > 200) throw new Error("Hindsight LLM model: no spaces or control characters");
  if (config.llmBaseUrl) {
    let url;
    try { url = new URL(config.llmBaseUrl); } catch { throw new Error("Hindsight LLM base URL: enter an http(s) URL or leave empty"); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Hindsight LLM base URL: http(s) without credentials");
  }
  if (CONTROL.test(config.envFile)) throw new Error("Hindsight environment file: invalid path");
  return config;
}

export function hindsightUrls(config) {
  return { api: "http://127.0.0.1:" + config.apiPort, ui: "http://localhost:" + config.uiPort };
}

export function hindsightKeyFile() {
  return join(getAihDir(), "hindsight.env");
}

/** Saved key first, then the environment of the process that runs docker. */
export function readHindsightApiKey({ file = hindsightKeyFile(), env = process.env } = {}) {
  try {
    if (existsSync(file)) {
      const line = readFileSync(file, "utf8").split(/\r?\n/).find(l => l.startsWith(HINDSIGHT_KEY_ENV + "="));
      const key = line?.slice(HINDSIGHT_KEY_ENV.length + 1);
      if (key) return { key, source: "file" };
    }
  } catch {}
  return env[HINDSIGHT_KEY_ENV] ? { key: env[HINDSIGHT_KEY_ENV], source: "env" } : { key: "", source: null };
}

export function validateHindsightApiKey(key) {
  if (CONTROL.test(key) || /\s/.test(key)) throw new Error("Hindsight API key: no spaces or control characters");
  return key;
}

/** Docker --env-file format: one KEY=value line, no quoting. Readable by the user only where supported. */
export function saveHindsightApiKey(key, file = hindsightKeyFile()) {
  validateHindsightApiKey(key);
  ensureDir(getAihDir());
  writeFileSync(file, HINDSIGHT_KEY_ENV + "=" + key + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

/** Fingerprint of everything that requires recreating the container (secrets are hashed). */
export function hindsightConfigHash(config, key = "") {
  let extra = "";
  try { if (config.envFile) extra = readFileSync(config.envFile, "utf8"); } catch {}
  return createHash("sha256").update(JSON.stringify([config, key, extra])).digest("hex").slice(0, 16);
}

export function hindsightRunArgs(config, { configHash, keySource }) {
  const args = ["run", "-d", "--name", config.containerName, "--restart", "unless-stopped", "--shm-size", "1g",
    "-p", "127.0.0.1:" + config.apiPort + ":" + API_PORT, "-p", "127.0.0.1:" + config.uiPort + ":" + UI_PORT,
    "-v", config.volume + ":" + DATA_DIR,
    "--label", "io.aih.managed=true", "--label", "io.aih.config=" + configHash,
    "-e", "HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:" + API_PORT,
    "-e", "HINDSIGHT_API_LLM_PROVIDER=" + config.llmProvider];
  if (config.llmModel) args.push("-e", "HINDSIGHT_API_LLM_MODEL=" + config.llmModel);
  if (config.llmBaseUrl) args.push("-e", "HINDSIGHT_API_LLM_BASE_URL=" + config.llmBaseUrl);
  if (config.envFile) args.push("--env-file", config.envFile);
  // Never put the key on the command line: docker reads it from a file or its own environment.
  if (keySource === "file") args.push("--env-file", hindsightKeyFile());
  else if (keySource === "env") args.push("-e", HINDSIGHT_KEY_ENV);
  args.push(config.image);
  return args;
}

export function requiresApiKey(config) {
  return !NO_KEY_PROVIDERS.has(config.llmProvider);
}

const firstLine = text => String(text || "").trim().split(/\r?\n/).find(Boolean) || "";

export function dockerError(result) {
  return firstLine(result.stderr) || firstLine(result.stdout) || "docker exited with code " + result.exitCode;
}

export async function dockerInfo(run = execCommand) {
  const result = await run("docker", ["version", "--format", "{{.Server.Version}}"], 10000);
  const version = result.stdout.trim();
  return result.exitCode === 0 && version ? { available: true, version }
    : { available: false, error: /ENOENT/.test(result.stderr) ? "docker CLI not found" : dockerError(result) };
}

/** null when the container does not exist; throws when Docker itself is unavailable. */
export async function inspectContainer(name, run = execCommand, timeout = 5000) {
  const result = await run("docker", ["container", "inspect", name], timeout);
  if (result.exitCode !== 0) {
    if (/no such (container|object)/i.test(result.stderr)) return null;
    throw new Error(/ENOENT/.test(result.stderr) ? "docker CLI not found" : dockerError(result));
  }
  const [container] = JSON.parse(result.stdout);
  const labels = container?.Config?.Labels || {};
  const started = Date.parse(container?.State?.StartedAt);
  return {
    id: String(container?.Id || "").slice(0, 12),
    imageId: container?.Image || null,
    image: container?.Config?.Image || null,
    status: container?.State?.Status || "unknown",
    running: container?.State?.Running === true,
    startedAt: Number.isFinite(started) && started > 0 ? new Date(started).toISOString() : undefined,
    managed: labels["io.aih.managed"] === "true",
    configHash: labels["io.aih.config"] || null,
    composeProject: labels["com.docker.compose.project"] || null,
  };
}

export async function imageId(image, run = execCommand) {
  const result = await run("docker", ["image", "inspect", "--format", "{{.Id}}", image], 10000);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

/** Long-running docker commands keep their output in the service log, not the terminal. */
export async function dockerLogged(id, args, run = execCommand, timeout = 0) {
  ensureDir(getLogsDir());
  const result = await run("docker", args, timeout);
  try {
    appendFileSync(getServiceLogPath(id), "\n[aih] " + new Date().toISOString() + " docker " + args[0] + " " + (args[0] === "run" ? "(" + args.at(-1) + ")" : args.slice(1).join(" "))
      + " -> exit " + result.exitCode + "\n" + result.stdout + result.stderr, "utf8");
  } catch {}
  return result;
}

const str = value => typeof value === "string" ? value : null;

/**
 * Reads /health (readiness, includes the database) and /health/live (version, uptime).
 * HTTP 200 = healthy, any other HTTP answer = degraded, no answer = unreachable.
 */
export async function probeHindsightHealth(apiUrl, { fetchImpl = fetch, timeoutMs = 2000, now = Date.now } = {}) {
  const checkedAt = now();
  const get = async path => {
    const response = await fetchImpl(new URL(path, apiUrl).href, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, ok: response.ok, body: body && typeof body === "object" ? body : {} };
  };
  try {
    const [ready, live] = await Promise.all([get("/health"), get("/health/live").catch(() => null)]);
    const healthy = ready.ok && (ready.body.status === undefined || ready.body.status === "healthy");
    return {
      state: healthy ? "healthy" : "degraded", httpStatus: ready.status,
      status: str(ready.body.status), database: str(ready.body.database),
      version: str(live?.body?.version), uptimeSeconds: Number.isFinite(live?.body?.uptime_seconds) ? live.body.uptime_seconds : null,
      url: new URL("/health", apiUrl).href, checkedAt,
    };
  } catch (error) {
    return { state: "unreachable", error: error?.name === "TimeoutError" ? "timeout" : error?.cause?.code || error?.message || String(error),
      url: new URL("/health", apiUrl).href, checkedAt };
  }
}

export function describeHealth(health) {
  if (!health) return "not checked";
  if (health.state === "healthy") return "healthy" + (health.version ? " v" + health.version : "") + (health.database ? ", database " + health.database : "");
  if (health.state === "degraded") return "unhealthy (HTTP " + health.httpStatus + (health.database ? ", database " + health.database : "") + ")";
  return "unreachable (" + health.error + ")";
}

function portFree(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Read-only checks for the setup wizard; nothing is created, pulled or started. */
export async function preflightHindsight(config, { newKey = "", run = execCommand, probe = probeHindsightHealth, readKey = readHindsightApiKey, isPortFree = portFree } = {}) {
  const checks = [];
  const docker = await dockerInfo(run);
  if (!docker.available) {
    checks.push("Warning: Docker not available (" + docker.error + "); start Docker Desktop before starting Hindsight");
    return checks;
  }
  checks.push("Docker " + docker.version + " available");
  const saved = readKey();
  if (newKey) checks.push("Hindsight API key: new value will be saved");
  else if (saved.key) checks.push("Hindsight API key: " + (saved.source === "file" ? "saved" : "from " + HINDSIGHT_KEY_ENV));
  else if (requiresApiKey(config)) checks.push("Warning: Hindsight API key missing; provider '" + config.llmProvider + "' requires one");
  if (config.envFile) {
    try {
      if (!statSync(config.envFile).isFile()) throw new Error();
      checks.push("Hindsight environment file readable");
    } catch { checks.push("Warning: Hindsight environment file not found: " + config.envFile); }
  }
  let container = null;
  try { container = await inspectContainer(config.containerName, run); } catch (error) { checks.push("Warning: " + error.message); }
  if (container) {
    const owner = container.managed ? "created by aih" : "not created by aih" + (container.composeProject ? " (compose project '" + container.composeProject + "')" : "") + "; it is reused as is and the settings above do not change it";
    checks.push("Container '" + config.containerName + "' " + container.status + ", " + owner);
    if (container.managed && container.configHash !== hindsightConfigHash(config, newKey || saved.key)) {
      checks.push("Settings changed: aih recreates the container on its next start (data volume kept)");
    }
    if (container.running) checks.push("Health: " + describeHealth(await probe(hindsightUrls(config).api)));
  } else {
    checks.push("Container '" + config.containerName + "' not found: aih creates it on start");
    checks.push(await imageId(config.image, run) ? "Image " + config.image + " present" : "Image " + config.image + " not present: pulled on first start (may take minutes)");
    for (const [label, port] of [["API", config.apiPort], ["UI", config.uiPort]]) {
      checks.push(await isPortFree(port) ? label + " port " + port + " available" : "Warning: " + label + " port " + port + " already in use");
    }
  }
  return checks;
}
