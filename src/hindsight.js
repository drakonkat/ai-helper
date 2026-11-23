import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { ensureDir, getAihDir, getLogsDir, getServiceLogPath } from "./utils/path.js";
import { execCommand } from "./utils/process.js";

/** Hindsight runs in Docker; these defaults match the upstream quick start. */
export const HINDSIGHT_REPOSITORY = "ghcr.io/vectorize-io/hindsight";
export const HINDSIGHT_DEFAULTS = Object.freeze({
  containerName: "hindsight",
  image: HINDSIGHT_REPOSITORY + ":latest",
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
const IMAGE_REF = /^[a-z0-9][a-z0-9._\/:@-]{0,254}$/i;

/**
 * Optional local LLM (llama.cpp server) that Hindsight calls for selected operations.
 * Both containers join one Docker network; Hindsight reaches it by container name.
 */
export const LOCAL_LLM_ID = "hindsight-llm";
export const HINDSIGHT_NETWORK = "aih-hindsight";
export const LOCAL_LLM_REPOSITORY = "ghcr.io/ggml-org/llama.cpp";
/** Hindsight operations with their own LLM settings; mental model refresh falls back to reflect. */
export const LOCAL_LLM_OPERATIONS = Object.freeze(["reflect", "retain", "consolidation", "mental_model_refresh"]);
const LLM_PORT = 8080;
const MODELS_DIR = "/models";
/** llama-server options set by aih; extra arguments may not repeat them. */
const LLM_ARG_NAMES = { "-m": "--model", "--model": "--model", "--lora": "--lora", "-a": "--alias", "--alias": "--alias",
  "--host": "--host", "--port": "--port", "-c": "--ctx-size", "--ctx-size": "--ctx-size", "-np": "--parallel", "--parallel": "--parallel" };
export const LOCAL_LLM_DEFAULTS = Object.freeze({
  enabled: false,
  containerName: LOCAL_LLM_ID,
  image: LOCAL_LLM_REPOSITORY + ":server-cuda",
  port: 8085,
  modelsDir: "",
  model: "",
  lora: "",
  alias: "local-llm",
  gpus: "all",
  ctxSize: 65536,
  parallel: 1,
  extraArgs: "--jinja --n-gpu-layers 999 --flash-attn on --metrics",
  operations: Object.freeze(["reflect"]),
  maxConcurrent: 1,
  timeout: 180,
  maxContextTokens: 48000,
  maxCompletionTokens: 8192,
});
/** Fields that only change how Hindsight calls the server, not the server itself. */
const LLM_ROUTING_FIELDS = ["containerName", "alias", "operations", "maxConcurrent", "timeout", "maxContextTokens", "maxCompletionTokens"];

function port(value, label) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(label + ": enter a port between 1 and 65535");
  }
  return number;
}

function integer(value, label, min, max) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < min || number > max) throw new Error(label + ": enter a whole number between " + min + " and " + max);
  return number;
}

const defined = input => Object.fromEntries(Object.entries(input || {}).filter(([, v]) => v !== undefined && v !== null));

/** A file inside the models folder, as a forward-slash relative path. */
function modelFile(value, label, required) {
  const text = String(value ?? "").trim().replaceAll("\\", "/");
  if (!text) {
    if (required) throw new Error(label + ": required when the local LLM is enabled");
    return "";
  }
  if (CONTROL.test(text) || /[,"]/.test(text) || text.startsWith("/") || /^[a-z]:/i.test(text) || text.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error(label + ": a file inside the models folder (no absolute path, '..', commas or quotes)");
  }
  return text;
}

export function splitLlmArgs(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean);
}

/** Validates the local LLM settings; required fields are enforced only when it is enabled. */
export function normalizeLocalLlmConfig(input = {}) {
  const value = { ...LOCAL_LLM_DEFAULTS, ...defined(input) };
  const text = key => String(value[key] ?? "").trim();
  const enabled = value.enabled === true || /^(true|on|yes|1)$/i.test(String(value.enabled));
  const operations = (Array.isArray(value.operations) ? value.operations : String(value.operations).split(","))
    .map(op => String(op).trim().toLowerCase()).filter(Boolean);
  const unknown = operations.find(op => !LOCAL_LLM_OPERATIONS.includes(op));
  if (unknown) throw new Error("Local LLM operations: '" + unknown + "' is not one of " + LOCAL_LLM_OPERATIONS.join(", "));
  const gpus = text("gpus").toLowerCase() === "none" ? "" : text("gpus");
  const config = {
    enabled,
    containerName: text("containerName"),
    image: text("image"),
    port: port(value.port, "Local LLM port"),
    modelsDir: text("modelsDir").replace(/(.)[\\/]+$/, "$1"),
    model: modelFile(value.model, "Local LLM model file", enabled),
    lora: modelFile(value.lora, "Local LLM LoRA adapter", false),
    alias: text("alias"),
    gpus,
    ctxSize: integer(value.ctxSize, "Local LLM context size", 512, 4194304),
    parallel: integer(value.parallel, "Local LLM parallel slots", 1, 64),
    extraArgs: splitLlmArgs(value.extraArgs).join(" "),
    operations: LOCAL_LLM_OPERATIONS.filter(op => operations.includes(op)),
    maxConcurrent: integer(value.maxConcurrent, "Local LLM max concurrent requests", 1, 64),
    timeout: integer(value.timeout, "Local LLM timeout (seconds)", 1, 3600),
    maxContextTokens: integer(value.maxContextTokens, "Reflect max context tokens", 256, 4194304),
    maxCompletionTokens: integer(value.maxCompletionTokens, "Reflect max completion tokens", 16, 4194304),
  };
  if (!DOCKER_NAME.test(config.containerName)) throw new Error("Local LLM container name: letters, digits, '_', '.', '-' (max 128)");
  if (!IMAGE_REF.test(config.image)) throw new Error("Local LLM image: invalid Docker image reference");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(config.alias)) throw new Error("Local LLM model alias: letters, digits, '.', '_', ':', '/', '-'");
  if (!/^(all|\d{1,2}|device=[A-Za-z0-9,._-]+)?$/.test(config.gpus)) throw new Error("Local LLM GPUs: all, none, a count or device=<ids>");
  if (CONTROL.test(config.extraArgs)) throw new Error("Local LLM extra arguments: no control characters");
  const managed = splitLlmArgs(config.extraArgs).find(arg => LLM_ARG_NAMES[arg.split("=")[0]]);
  if (managed) throw new Error("Local LLM extra arguments: " + managed.split("=")[0] + " is set by aih from the other fields");
  if (CONTROL.test(config.modelsDir) || /[,"]/.test(config.modelsDir)) throw new Error("Local LLM models folder: no commas, quotes or control characters");
  if (!enabled) return config;
  if (!/^([a-z]:[\\/]|\/)/i.test(config.modelsDir)) throw new Error("Local LLM models folder: enter an absolute path");
  if (!config.operations.length) throw new Error("Local LLM operations: choose at least one of " + LOCAL_LLM_OPERATIONS.join(", "));
  if (config.maxConcurrent > config.parallel) throw new Error("Local LLM max concurrent requests cannot exceed its " + config.parallel + " parallel slots");
  const slot = Math.floor(config.ctxSize / config.parallel);
  if (config.operations.includes("reflect") && config.maxContextTokens + config.maxCompletionTokens > slot) {
    throw new Error("Reflect context (" + config.maxContextTokens + ") + completion (" + config.maxCompletionTokens + ") tokens exceed the "
      + slot + " tokens of each local LLM slot (context size / parallel slots)");
  }
  return config;
}

/** Validates the non-secret settings; the API key never belongs in this object. */
export function normalizeHindsightConfig(input = {}) {
  const value = { ...HINDSIGHT_DEFAULTS, ...defined(input) };
  const text = key => String(value[key] ?? "").trim();
  const config = {
    containerName: text("containerName"), image: text("image"), volume: text("volume"),
    apiPort: port(value.apiPort, "Hindsight API port"), uiPort: port(value.uiPort, "Hindsight UI port"),
    llmProvider: text("llmProvider").toLowerCase(), llmModel: text("llmModel"), llmBaseUrl: text("llmBaseUrl"),
    envFile: text("envFile"), localLlm: normalizeLocalLlmConfig(value.localLlm),
  };
  if (!DOCKER_NAME.test(config.containerName)) throw new Error("Hindsight container name: letters, digits, '_', '.', '-' (max 128)");
  if (!DOCKER_NAME.test(config.volume)) throw new Error("Hindsight data volume: letters, digits, '_', '.', '-' (max 128)");
  if (!IMAGE_REF.test(config.image)) throw new Error("Hindsight image: invalid Docker image reference");
  if (config.apiPort === config.uiPort) throw new Error("Hindsight API and UI ports must differ");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.llmProvider)) throw new Error("Hindsight LLM provider: lowercase letters, digits, '_' or '-'");
  if (CONTROL.test(config.llmModel) || /\s/.test(config.llmModel) || config.llmModel.length > 200) throw new Error("Hindsight LLM model: no spaces or control characters");
  if (config.llmBaseUrl) {
    let url;
    try { url = new URL(config.llmBaseUrl); } catch { throw new Error("Hindsight LLM base URL: enter an http(s) URL or leave empty"); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Hindsight LLM base URL: http(s) without credentials");
  }
  if (CONTROL.test(config.envFile)) throw new Error("Hindsight environment file: invalid path");
  if (config.localLlm.enabled) {
    if ([config.apiPort, config.uiPort].includes(config.localLlm.port)) throw new Error("Local LLM port must differ from the Hindsight API and UI ports");
    if (config.localLlm.containerName === config.containerName) throw new Error("Local LLM and Hindsight container names must differ");
  }
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
  // Without a local LLM the fingerprint matches older releases: no needless recreation on upgrade.
  const { localLlm, ...base } = config;
  const parts = [base, key, extra];
  if (localLlm?.enabled) parts.push(Object.fromEntries(LLM_ROUTING_FIELDS.map(field => [field, localLlm[field]])));
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** Fingerprint of the settings that require recreating the local LLM container. */
export function localLlmConfigHash(llm) {
  const server = Object.fromEntries(Object.entries(llm).filter(([field]) => field === "containerName" || field === "alias"
    || !LLM_ROUTING_FIELDS.includes(field) && field !== "enabled"));
  return createHash("sha256").update(JSON.stringify(server)).digest("hex").slice(0, 16);
}

export function localLlmUrls(llm) {
  return { api: "http://127.0.0.1:" + llm.port, ui: "http://localhost:" + llm.port };
}

/** Variables that send the selected Hindsight operations to the local server. */
export function localLlmEnv(llm) {
  if (!llm?.enabled) return [];
  const url = "http://" + llm.containerName + ":" + LLM_PORT + "/v1";
  const env = llm.operations.flatMap(op => {
    const prefix = "HINDSIGHT_API_" + op.toUpperCase() + "_LLM_";
    return [prefix + "PROVIDER=openai", prefix + "BASE_URL=" + url, prefix + "MODEL=" + llm.alias, prefix + "API_KEY=local",
      prefix + "MAX_CONCURRENT=" + llm.maxConcurrent, prefix + "TIMEOUT=" + llm.timeout];
  });
  if (llm.operations.includes("reflect")) {
    env.push("HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS=" + llm.maxContextTokens, "HINDSIGHT_API_REFLECT_MAX_COMPLETION_TOKENS=" + llm.maxCompletionTokens);
  }
  return env;
}

export function hindsightRunArgs(config, { configHash, keySource }) {
  const args = ["run", "-d", "--name", config.containerName, "--restart", "unless-stopped", "--shm-size", "1g",
    ...(config.localLlm?.enabled ? ["--network", HINDSIGHT_NETWORK] : []),
    "-p", "127.0.0.1:" + config.apiPort + ":" + API_PORT, "-p", "127.0.0.1:" + config.uiPort + ":" + UI_PORT,
    "-v", config.volume + ":" + DATA_DIR,
    "--label", "io.aih.managed=true", "--label", "io.aih.config=" + configHash,
    "-e", "HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:" + API_PORT,
    "-e", "HINDSIGHT_API_LLM_PROVIDER=" + config.llmProvider];
  if (config.llmModel) args.push("-e", "HINDSIGHT_API_LLM_MODEL=" + config.llmModel);
  if (config.llmBaseUrl) args.push("-e", "HINDSIGHT_API_LLM_BASE_URL=" + config.llmBaseUrl);
  // -e wins over --env-file: the local routing cannot be overridden by the extra file by mistake.
  for (const line of localLlmEnv(config.localLlm)) args.push("-e", line);
  if (config.envFile) args.push("--env-file", config.envFile);
  // Never put the key on the command line: docker reads it from a file or its own environment.
  if (keySource === "file") args.push("--env-file", hindsightKeyFile());
  else if (keySource === "env") args.push("-e", HINDSIGHT_KEY_ENV);
  args.push(config.image);
  return args;
}

/** llama-server in Docker: models mounted read-only, API published on loopback only. */
export function localLlmRunArgs(llm, { configHash }) {
  const args = ["run", "-d", "--name", llm.containerName, "--restart", "unless-stopped", "--network", HINDSIGHT_NETWORK,
    "-p", "127.0.0.1:" + llm.port + ":" + LLM_PORT,
    "--mount", "type=bind,source=" + llm.modelsDir + ",target=" + MODELS_DIR + ",readonly",
    "--label", "io.aih.managed=true", "--label", "io.aih.role=llm", "--label", "io.aih.config=" + configHash];
  if (llm.gpus) args.push("--gpus", llm.gpus);
  args.push(llm.image, "--model", MODELS_DIR + "/" + llm.model);
  if (llm.lora) args.push("--lora", MODELS_DIR + "/" + llm.lora);
  args.push("--alias", llm.alias, "--host", "0.0.0.0", "--port", String(LLM_PORT),
    "--ctx-size", String(llm.ctxSize), "--parallel", String(llm.parallel), ...splitLlmArgs(llm.extraArgs));
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
    role: labels["io.aih.role"] || null,
    configHash: labels["io.aih.config"] || null,
    composeProject: labels["com.docker.compose.project"] || null,
    // Read only to adopt a container aih did not create.
    env: container?.Config?.Env || [],
    cmd: container?.Config?.Cmd || [],
    mounts: (container?.Mounts || []).map(m => ({ type: m.Type, name: m.Name, source: m.Source, destination: m.Destination })),
    ports: container?.HostConfig?.PortBindings || {},
    gpus: container?.HostConfig?.DeviceRequests || [],
  };
}

/** Operations whose LLM calls go to one OpenAI-compatible server addressed by container name. */
function localLlmRoute(env) {
  const routes = LOCAL_LLM_OPERATIONS.map(op => {
    const prefix = "HINDSIGHT_API_" + op.toUpperCase() + "_LLM_";
    const url = /^http:\/\/([A-Za-z0-9_-]+):(\d+)\/v1\/?$/.exec(env.get(prefix + "BASE_URL") || "");
    const provider = env.get(prefix + "PROVIDER") || "openai";
    return url && url[1] !== "localhost" && provider === "openai" ? { op, prefix, host: url[1], port: Number(url[2]), model: env.get(prefix + "MODEL") || "" } : null;
  }).filter(Boolean);
  if (!routes.length) return null;
  if (routes.some(r => r.host !== routes[0].host || r.port !== routes[0].port || r.model !== routes[0].model)) {
    throw new Error("its operations use different local servers or models; aih manages a single local LLM");
  }
  const values = field => routes.map(r => env.get(r.prefix + field)).filter(v => v !== undefined);
  const one = (field, label) => {
    const found = [...new Set(values(field))];
    if (found.length > 1) throw new Error("its operations use different " + label + " values for the local LLM");
    return found[0];
  };
  const route = { host: routes[0].host, port: routes[0].port, alias: routes[0].model, operations: routes.map(r => r.op),
    maxConcurrent: one("MAX_CONCURRENT", "max concurrent"), timeout: one("TIMEOUT", "timeout"),
    maxContextTokens: env.get("HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS"), maxCompletionTokens: env.get("HINDSIGHT_API_REFLECT_MAX_COMPLETION_TOKENS") };
  // These variables are regenerated from the local LLM settings.
  for (const r of routes) for (const field of ["PROVIDER", "BASE_URL", "MODEL", "API_KEY", "MAX_CONCURRENT", "TIMEOUT"]) env.delete(r.prefix + field);
  if (route.operations.includes("reflect")) {
    env.delete("HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS");
    env.delete("HINDSIGHT_API_REFLECT_MAX_COMPLETION_TOKENS");
  }
  return route;
}

/**
 * Settings that let aih recreate a container it did not create: image, ports, data volume and
 * the variables set on top of its image. Throws when something would be lost. "route" describes
 * a local LLM container the operations are sent to, if any.
 */
export function adoptedHindsightSettings(containerName, container, imageEnv) {
  const data = container.mounts.find(m => m.destination === DATA_DIR);
  if (data?.type !== "volume" || container.mounts.length !== 1) {
    throw new Error("its data must be in one Docker volume mounted at " + DATA_DIR + ", with no other mounts");
  }
  const inherited = new Set(imageEnv);
  const env = new Map(container.env.filter(line => !inherited.has(line)).map(line => line.split(/=(.*)/s).slice(0, 2)));
  const take = name => { const value = env.get(name); env.delete(name); return value; };
  const hostPort = port => container.ports[port + "/tcp"]?.[0]?.HostPort;
  take("HINDSIGHT_CP_DATAPLANE_API_URL"); // always set by aih
  const key = validateHindsightApiKey(take(HINDSIGHT_KEY_ENV) || "");
  const route = localLlmRoute(env);
  const config = normalizeHindsightConfig({
    containerName, image: container.image, volume: data.name, apiPort: hostPort(API_PORT), uiPort: hostPort(UI_PORT),
    llmProvider: take("HINDSIGHT_API_LLM_PROVIDER"), llmModel: take("HINDSIGHT_API_LLM_MODEL"), llmBaseUrl: take("HINDSIGHT_API_LLM_BASE_URL"),
  });
  const extra = [...env].map(([name, value]) => name + "=" + value);
  if (extra.some(line => /[\r\n]/.test(line))) throw new Error("a multi-line environment value cannot be written to an env file");
  return { config, key, extra, route };
}

/** Local LLM settings read from an existing llama.cpp server container. Throws when something would be lost. */
export function adoptedLocalLlmSettings(container, imageEnv, route, containerName = LOCAL_LLM_ID) {
  const inherited = new Set(imageEnv);
  const own = container.env.filter(line => !inherited.has(line)).map(line => line.split("=")[0]);
  if (own.length) throw new Error("local LLM container '" + route.host + "' sets environment variables (" + own.join(", ") + "); pass them as llama-server arguments instead");
  const models = container.mounts[0];
  if (container.mounts.length !== 1 || models.type !== "bind") throw new Error("local LLM container '" + route.host + "' must bind-mount one models folder and nothing else");
  const dir = models.destination.replace(/\/+$/, "");
  const values = {};
  const extra = [];
  const args = container.cmd;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    const name = LLM_ARG_NAMES[flag];
    if (name) values[name] = inline ?? args[++i];
    else extra.push(args[i]);
  }
  if (extra.some(arg => /\s/.test(arg))) throw new Error("a llama-server argument of '" + route.host + "' contains spaces");
  const inModels = (path, label) => {
    if (!path) return "";
    if (!path.startsWith(dir + "/")) throw new Error(label + " " + path + " is not inside the mounted folder " + dir);
    return path.slice(dir.length + 1);
  };
  const internal = Number(values["--port"] || LLM_PORT);
  if (internal !== route.port) throw new Error("Hindsight calls port " + route.port + " but '" + route.host + "' listens on " + internal);
  if (!values["--ctx-size"]) throw new Error("'" + route.host + "' has no --ctx-size; set one so the reflect token budget can be checked");
  const alias = values["--alias"] || route.alias;
  if (route.alias && alias !== route.alias) throw new Error("Hindsight asks for model '" + route.alias + "' but '" + route.host + "' serves '" + alias + "'");
  const gpu = container.gpus.find(d => d.Driver === "nvidia" || (d.Capabilities || []).flat().includes("gpu"));
  const gpus = !gpu ? "" : gpu.DeviceIDs?.length ? "device=" + gpu.DeviceIDs.join(",") : gpu.Count === -1 ? "all" : String(gpu.Count);
  const parallel = values["--parallel"] ?? 1;
  return normalizeLocalLlmConfig({
    enabled: true, containerName, image: container.image, port: container.ports[internal + "/tcp"]?.[0]?.HostPort ?? LOCAL_LLM_DEFAULTS.port,
    modelsDir: models.source, model: inModels(values["--model"], "the model"), lora: inModels(values["--lora"], "the LoRA adapter"),
    alias, gpus, ctxSize: values["--ctx-size"], parallel, extraArgs: extra.join(" "), operations: route.operations,
    maxConcurrent: route.maxConcurrent ?? parallel, timeout: route.timeout, maxContextTokens: route.maxContextTokens, maxCompletionTokens: route.maxCompletionTokens,
  });
}

export async function imageId(image, run = execCommand) {
  const result = await run("docker", ["image", "inspect", "--format", "{{.Id}}", image], 10000);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

/** Long-running docker commands keep their output in the service log, not the terminal. "run" logs only its image. */
export async function dockerLogged(id, args, run = execCommand, timeout = 0, image = args.at(-1)) {
  ensureDir(getLogsDir());
  const result = await run("docker", args, timeout);
  try {
    appendFileSync(getServiceLogPath(id), "\n[aih] " + new Date().toISOString() + " docker " + args[0] + " " + (args[0] === "run" ? "(" + image + ")" : args.slice(1).join(" "))
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
  const llm = health.build || health.model ? " (" + [health.build && "llama.cpp " + health.build, health.model && "model " + health.model].filter(Boolean).join(", ") + ")" : "";
  if (health.state === "healthy") return "healthy" + (health.version ? " v" + health.version : "") + llm + (health.database ? ", database " + health.database : "");
  if (health.state === "degraded") return "unhealthy (HTTP " + health.httpStatus + (health.database ? ", database " + health.database : "") + (health.detail ? ", " + health.detail : "") + ")";
  return "unreachable (" + health.error + ")";
}

/**
 * llama.cpp server: /health answers 200 {"status":"ok"} once the model is loaded and 503 while
 * loading; /props adds the build and the served model alias.
 */
export async function probeLocalLlmHealth(apiUrl, { fetchImpl = fetch, timeoutMs = 2000, now = Date.now } = {}) {
  const checkedAt = now();
  const url = new URL("/health", apiUrl).href;
  const get = async path => {
    const response = await fetchImpl(new URL(path, apiUrl).href, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, ok: response.ok, body: body && typeof body === "object" ? body : {} };
  };
  try {
    const ready = await get("/health");
    const healthy = ready.ok && (ready.body.status === undefined || ready.body.status === "ok");
    const props = healthy ? await get("/props").catch(() => null) : null;
    return {
      state: healthy ? "healthy" : "degraded", httpStatus: ready.status, status: str(ready.body.status),
      detail: healthy ? null : str(ready.body.error?.message)?.toLowerCase() || null,
      version: null, build: str(props?.body?.build_info)?.split("-")[0] || null, model: str(props?.body?.model_alias),
      url, checkedAt,
    };
  } catch (error) {
    return { state: "unreachable", error: error?.name === "TimeoutError" ? "timeout" : error?.cause?.code || error?.message || String(error), url, checkedAt };
  }
}

/** One-token completion: proves the model and adapter actually generate, not just that the server is up. */
export async function smokeTestLocalLlm(apiUrl, alias, { fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  try {
    const response = await fetchImpl(new URL("/v1/chat/completions", apiUrl).href, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: alias, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (response.ok && Array.isArray(body?.choices)) return { ok: true };
    return { ok: false, error: "HTTP " + response.status + (str(body?.error?.message) ? ": " + body.error.message : "") };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "timeout" : error?.cause?.code || error?.message || String(error) };
  }
}

function portFree(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Read-only checks for the setup wizard; nothing is created, pulled or started. */
export async function preflightHindsight(config, { newKey = "", run = execCommand, probe = probeHindsightHealth, probeLlm = probeLocalLlmHealth,
  readKey = readHindsightApiKey, isPortFree = portFree, fileExists = existsSync } = {}) {
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
    const owner = container.managed ? "created by aih" : "not created by aih" + (container.composeProject ? " (compose project '" + container.composeProject + "')" : "") + "; it is reused as is and the settings above do not change it. To manage it from aih, adopt it: press u on hindsight in the dashboard";
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
  if (config.localLlm?.enabled) checks.push(...await preflightLocalLlm(config, { run, probeLlm, isPortFree, fileExists }));
  return checks;
}

async function preflightLocalLlm(config, { run, probeLlm, isPortFree, fileExists }) {
  const llm = config.localLlm;
  const checks = [];
  for (const [label, file] of [["model", llm.model], ["LoRA adapter", llm.lora]]) {
    if (!file) continue;
    const path = join(llm.modelsDir, file);
    checks.push(fileExists(path) ? "Local LLM " + label + " found: " + file : "Warning: local LLM " + label + " not found: " + path);
  }
  const refresh = llm.operations.includes("reflect") && !llm.operations.includes("mental_model_refresh") ? " (mental model refresh follows reflect)" : "";
  checks.push("Local LLM handles: " + llm.operations.join(", ") + refresh + "; other operations use " + config.llmProvider + (config.llmModel ? " " + config.llmModel : ""));
  if (llm.gpus) checks.push("Local LLM GPUs: --gpus " + llm.gpus + " (needs NVIDIA GPU support in Docker)");
  if (config.envFile) {
    let names = [];
    try {
      const managed = new Set(localLlmEnv(llm).map(line => line.split("=")[0]));
      names = readFileSync(config.envFile, "utf8").split(/\r?\n/).map(line => line.split("=")[0].trim()).filter(name => managed.has(name));
    } catch {}
    if (names.length) checks.push("Warning: " + names.join(", ") + " in the extra environment file are replaced by the local LLM settings; remove them there");
  }
  let container = null;
  try { container = await inspectContainer(llm.containerName, run); } catch (error) { checks.push("Warning: " + error.message); return checks; }
  if (container) {
    if (!container.managed) {
      checks.push("Warning: container '" + llm.containerName + "' exists and was not created by aih; aih will not use it. Rename/remove it, or adopt the stack: 'aih update hindsight --adopt'");
      return checks;
    }
    checks.push("Local LLM container '" + llm.containerName + "' " + container.status + ", created by aih");
    if (container.configHash !== localLlmConfigHash(llm)) checks.push("Local LLM settings changed: aih recreates its container on the next start");
    if (container.running) checks.push("Local LLM health: " + describeHealth(await probeLlm(localLlmUrls(llm).api)));
  } else {
    checks.push("Local LLM container '" + llm.containerName + "' not found: aih creates it on start");
    checks.push(await imageId(llm.image, run) ? "Image " + llm.image + " present" : "Image " + llm.image + " not present: pulled on first start (may take minutes)");
    checks.push(await isPortFree(llm.port) ? "Local LLM port " + llm.port + " available" : "Warning: local LLM port " + llm.port + " already in use");
  }
  return checks;
}
