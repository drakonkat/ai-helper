import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAihDir } from "./utils/path.js";
import { execCommand, findPidsListeningOnPorts, sleep } from "./utils/process.js";
import { launchGptProcess, resolveGptLaunch } from "./gpt-launchers.js";

export const ASTRA_MODEL = "gpt-6-astra";
export const GPT_SERVICE_IDS = ["ocx", "pxpipe", "headroom"];
export const GPT_URLS = {
  ocx: "http://127.0.0.1:10100",
  pxpipe: "http://127.0.0.1:47822",
  headroom: "http://127.0.0.1:8788",
};

// The GPT chain uses its own ports without changing the normal service defaults.
export function configureCodexForAstra(text) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const firstTable = text.search(/^[ \t]*\[/m);
  let root = firstTable < 0 ? text : text.slice(0, firstTable);
  let tables = firstTable < 0 ? "" : text.slice(firstTable);
  // ponytail: scoped TOML editing; reject complex target sections instead of guessing.
  const headers = tables.match(/^[ \t]*\[[^\n]*pxpipe-codex[^\n]*$/gm) || [];
  if (/"""|'''/.test(root) || headers.length > 1 ||
      headers.some(h => !/^[ \t]*\[model_providers\.pxpipe-codex\][ \t]*(?:#.*)?$/.test(h))) {
    throw new Error("Unsupported multiline/nested Codex configuration; config.toml was not changed.");
  }
  for (const [key, value] of Object.entries({ model: ASTRA_MODEL, model_provider: "pxpipe-codex" })) {
    const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=[^\\n]*$`, "gm");
    if ((root.match(pattern) || []).length > 1) throw new Error(`Duplicate Codex setting: ${key}`);
    root = pattern.test(root)
      ? root.replace(pattern, `${key} = "${value}"`)
      : `${root.trimEnd()}\n${key} = "${value}"\n\n`;
  }
  const provider = [
    "[model_providers.pxpipe-codex]",
    'name = "Headroom -> pxpipe -> OCX"',
    `base_url = "${GPT_URLS.headroom}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    // Preserve the ChatGPT profile while OCX supplies the real upstream credentials.
    'experimental_bearer_token = "local-proxy"',
    "supports_websockets = false",
    "", "",
  ].join("\n");
  const pattern = /^[ \t]*\[model_providers\.pxpipe-codex\][ \t]*(?:#.*)?(?:\n|$)[\s\S]*?(?=^[ \t]*\[|(?![\s\S]))/m;
  if (/"""|'''/.test(tables.match(pattern)?.[0] || "")) {
    throw new Error("Unsupported multiline provider configuration; config.toml was not changed.");
  }
  tables = pattern.test(tables) ? tables.replace(pattern, () => provider) : `${tables.trimEnd()}\n\n${provider}`;
  return bom + (root + tables).replace(/\n/g, newline);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export async function startGpt({ manager, home = homedir(), env = process.env, codexHome = env.CODEX_HOME || join(home, ".codex"),
  platform = process.platform, request = requestJson, run = execCommand, pause = sleep,
  findPids = findPidsListeningOnPorts, resolveLaunch = resolveGptLaunch, launchProcess = launchGptProcess,
  withProgress = async (_id, start) => start() } = {}) {
  if (platform !== "win32") throw new Error("aih start --gpt currently requires Windows.");
  const ocxPath = join(home, ".opencodex", "config.json");
  const headroomPath = env.HEADROOM_SETTINGS_PATH || join(env.HEADROOM_WORKSPACE_DIR || join(home, ".headroom"), "settings.json");
  const codexPath = join(codexHome, "config.toml");
  for (const file of [ocxPath, codexPath]) {
    if (!existsSync(file)) throw new Error(`Missing compression setup: ${file}. See README: Astra / --gpt.`);
  }
  configureCodexForAstra(readFileSync(codexPath, "utf8")); // Validate before starting or changing anything.
  const ocxConfig = JSON.parse(readFileSync(ocxPath, "utf8").replace(/^\uFEFF/, ""));
  const openai = ocxConfig.providers?.openai;
  if (!openai || openai.disabled || openai.authMode !== "forward" ||
      openai.baseUrl?.replace(/\/+$/, "") !== "https://chatgpt.com/backend-api/codex") {
    throw new Error("Enable the canonical OpenAI subscription provider in OCX before using --gpt.");
  }

  let backupDir;
  function backup(file, name) {
    if (!backupDir) {
      const parent = join(getAihDir(), "backups");
      mkdirSync(parent, { recursive: true });
      backupDir = mkdtempSync(join(parent, "gpt-"));
    }
    if (existsSync(file) && !existsSync(join(backupDir, name))) copyFileSync(file, join(backupDir, name));
  }
  function writeBackedUp(file, value, name) {
    if (existsSync(file) && readFileSync(file, "utf8") === value) return;
    backup(file, name);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.aih-${process.pid}.tmp`;
    writeFileSync(temp, value, "utf8");
    renameSync(temp, file);
  }
  async function waitFor(label, url, valid) {
    let lastError;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const body = await request(url);
        if (valid(body)) return body;
        lastError = "unexpected health response";
      } catch (error) { lastError = error.message; }
      await pause(1000);
    }
    throw new Error(`${label} is not ready: ${lastError}`);
  }

  const services = [];
  async function startService(id, healthPath, valid, launch) {
    const result = await withProgress(id, async () => {
      const url = GPT_URLS[id];
      const port = Number(new URL(url).port);
      const health = await request(`${url}${healthPath}`).catch(() => null);
      let alreadyRunning = Boolean(health && valid(health));
      const listeners = await findPids([port]);
      if (!alreadyRunning && !listeners.length) {
        const launched = await launch();
        alreadyRunning = Boolean(launched?.alreadyRunning);
      } else {
        // Never spawn a second process onto an occupied port, even if it is unhealthy.
        alreadyRunning = true;
      }
      await waitFor(id, `${url}${healthPath}`, valid);
      const [pid] = await findPids([port]);
      if (!pid) throw new Error(`Cannot determine ${id}'s listening PID on port ${port}.`);
      return { id, success: true, alreadyRunning, pid, url };
    });
    services.push(result);
  }
  await startService("ocx", "/healthz", h => h.service === "opencodex" && h.status === "ok", async () => {
    // OCX can inject its own Codex settings during startup, before our final selection.
    backup(codexPath, "codex-config.toml");
    const result = await manager.startService("ocx");
    if (!result.success) throw new Error(result.message);
    return result;
  });

  // Update the live router through OCX's API; editing its JSON alone does not reload it.
  const patches = [];
  if (ocxConfig.providers.anthropic && ocxConfig.providers.anthropic.baseUrl !== "https://api.anthropic.com") {
    patches.push(["anthropic", { baseUrl: "https://api.anthropic.com" }]);
  }
  if (openai.codexAccountMode !== "pool") patches.push(["openai", { codexAccountMode: "pool" }]);
  if (patches.length) {
    const token = readFileSync(join(home, ".opencodex", "admin-api-token"), "utf8").trim();
    backup(ocxPath, "ocx-config.json");
    for (const [provider, patch] of patches) {
      const result = await request(`${GPT_URLS.ocx}/api/providers?name=${provider}`, {
        method: "PATCH", headers: { "content-type": "application/json", "x-opencodex-api-key": token },
        body: JSON.stringify(patch),
      });
      if (!result.success) throw new Error(`OCX rejected the ${provider} configuration.`);
    }
  }
  const headroom = existsSync(headroomPath) ? JSON.parse(readFileSync(headroomPath, "utf8").replace(/^\uFEFF/, "")) : {};
  if (headroom.anthropic_base_url !== GPT_URLS.pxpipe || headroom.openai_base_url !== GPT_URLS.pxpipe) {
    writeBackedUp(headroomPath, JSON.stringify({ ...headroom, anthropic_base_url: GPT_URLS.pxpipe,
      openai_base_url: GPT_URLS.pxpipe }, null, 2) + "\n", "headroom-settings.json");
  }
  const launchProxy = async id => launchProcess(await resolveLaunch(id, { home, env, run }), { run });
  await startService("pxpipe", "/proxy-stats", h => h && typeof h === "object", () => launchProxy("pxpipe"));
  await startService("headroom", "/health", h => h.status === "healthy" &&
    h.config?.openai_api_url === GPT_URLS.pxpipe && h.config?.anthropic_api_url === GPT_URLS.pxpipe,
  () => launchProxy("headroom"));
  // A healthy process alone does not prove that the local chain reaches OCX's model router.
  const models = await request(`${GPT_URLS.headroom}/v1/models`, { headers: { Authorization: "Bearer local-proxy" } });
  if (!models.data?.some(m => m.id === ASTRA_MODEL)) throw new Error(`OCX does not expose ${ASTRA_MODEL} through the chain.`);
  writeBackedUp(codexPath, configureCodexForAstra(readFileSync(codexPath, "utf8")), "codex-config.toml");
  return { model: ASTRA_MODEL, urls: GPT_URLS, services, backupDir,
    note: "Start a NEW Codex task: existing tasks retain their provider. The existing pxpipe compression profile is preserved." };
}
