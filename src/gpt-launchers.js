import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";
import { execCommand } from "./utils/process.js";

const MARKER = "AIH_GPT_LAUNCHER_V1";
const PXPIPE_PROFILE = '{"gpt-6-astra":{"stripCols":95,"maxHeightPx":1932,"style":{"font":"jetbrains-mono-12","cellWBonus":0,"cellHBonus":0,"aa":true,"grid":false,"gridCols":0}}}';

function value(env, name) {
  const key = Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function file(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function directories(env) {
  return (value(env, "PATH") || "").split(delimiter).map(path => path.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

function binary(name, override, paths, fallback) {
  if (override) {
    const found = [override, ...paths.map(path => join(path, override))].find(file);
    if (found) return resolve(found);
    throw new Error(`${name} executable not found at ${override}. Correct the executable override before retrying.`);
  }
  const found = [...paths.flatMap(path => [join(path, `${name}.exe`), join(path, name)]), fallback].filter(Boolean).find(file);
  if (found) return resolve(found);
  throw new Error(`${name} is not installed or not on PATH. Install ${name === "node" ? "Node.js (or set NODE_BINARY)" : "Headroom (or set HEADROOM_BINARY)"} before starting GPT.`);
}

async function pxpipeCli(home, env, paths, node, run) {
  const override = value(env, "PXPIPE_CLI_PATH");
  if (override) {
    if (!file(override)) throw new Error(`PXPIPE_CLI_PATH does not point to an installed cli.js: ${override}`);
    return resolve(override);
  }
  const appdata = value(env, "APPDATA") || join(home, "AppData", "Roaming");
  const local = value(env, "LOCALAPPDATA") || join(home, "AppData", "Local");
  const prefixes = [...paths, dirname(node), join(appdata, "npm"), value(env, "npm_config_prefix")].filter(Boolean);
  const cli = root => join(root, "pxpipe-proxy", "bin", "cli.js");
  const globalCli = prefixes.flatMap(prefix => [cli(join(prefix, "node_modules")), cli(join(dirname(prefix), "lib", "node_modules"))]).find(file);
  if (globalCli) return resolve(globalCli);

  const caches = [value(env, "npm_config_cache"), join(local, "npm-cache"), join(appdata, "npm-cache"), join(home, ".npm")].filter(Boolean);
  // Use npm's installed JS entry point, never a shell shim (or an npx install).
  const npm = prefixes.map(prefix => join(prefix, "node_modules", "npm", "bin", "npm-cli.js")).find(file);
  if (npm) {
    const root = await run(node, [npm, "root", "--global"]);
    if (root.exitCode === 0 && file(cli(root.stdout.trim()))) return resolve(cli(root.stdout.trim()));
    const cache = await run(node, [npm, "config", "get", "cache"]);
    if (cache.exitCode === 0 && cache.stdout.trim()) caches.unshift(cache.stdout.trim());
  }
  for (const cache of new Set(caches)) {
    const npx = join(cache, "_npx");
    let candidates;
    try {
      candidates = readdirSync(npx, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => cli(join(npx, entry.name, "node_modules")))
        .filter(file)
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    } catch { continue; }
    if (candidates.length) return resolve(candidates[0]);
  }
  throw new Error("pxpipe-proxy is not installed on PATH, in global npm, or in the npm cache. Install it with npm install --global pxpipe-proxy, or set PXPIPE_CLI_PATH to its bin/cli.js.");
}

/** Resolve a cold-start command without starting anything or installing packages. */
export async function resolveGptLaunch(id, { home = homedir(), env = process.env, run = execCommand } = {}) {
  if (id !== "pxpipe" && id !== "headroom") throw new Error(`Unknown GPT launcher: ${id}`);
  const paths = directories(env);
  const node = binary("node", value(env, "NODE_BINARY"), paths);
  const username = value(env, "USERNAME") || userInfo().username;
  const domain = value(env, "USERDOMAIN");
  const taskUser = domain ? `${domain}\\${username}` : username;
  const systemRoot = value(env, "SystemRoot");
  const taskName = `AIH-GPT-${username.replace(/[\\/:*?"<>|\[\]]/g, "_")}-${id}`;
  const spec = {
    id, node, taskName, taskUser,
    schtasks: systemRoot && existsSync(join(systemRoot, "System32", "schtasks.exe")) ? join(systemRoot, "System32", "schtasks.exe") : "schtasks.exe",
    env: { ...(value(env, "PATH") !== undefined ? { PATH: value(env, "PATH") } : {}) },
  };
  if (id === "pxpipe") {
    spec.command = node;
    spec.args = [await pxpipeCli(home, env, paths, node, run)];
    spec.cwd = join(home, ".pxpipe");
    Object.assign(spec.env, {
      HOST: "127.0.0.1", PORT: "47822",
      PXPIPE_UPSTREAM: "http://127.0.0.1:10100",
      ANTHROPIC_UPSTREAM: "http://127.0.0.1:10100",
      OPENAI_UPSTREAM: "http://127.0.0.1:10100",
      PXPIPE_CONFIG: value(env, "PXPIPE_CONFIG") || join(value(env, "XDG_CONFIG_HOME") || join(home, ".config"), "pxpipe", "config.json"),
      PXPIPE_LOG: value(env, "PXPIPE_LOG") || join(spec.cwd, "events.jsonl"),
      PXPIPE_GPT_PROFILES: value(env, "PXPIPE_GPT_PROFILES") ?? PXPIPE_PROFILE,
    });
    spec.clearEnv = ["PXPIPE_MODELS", "OPENAI_API_KEY", "PXPIPE_PROVIDER", "PXPIPE_GATEWAY_BASE_URL", "PXPIPE_GATEWAY_HEADERS", "OPENAI_MODELS", "CLOUDFLARE_MODELS", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];
  } else {
    spec.command = binary("headroom", value(env, "HEADROOM_BINARY"), paths, join(home, ".local", "bin", "headroom.exe"));
    spec.args = ["proxy", "--host", "127.0.0.1", "--port", "8788", "--openai-api-url", "http://127.0.0.1:47822", "--anthropic-api-url", "http://127.0.0.1:47822", "--lossless", "--no-cache"];
    spec.cwd = value(env, "HEADROOM_WORKSPACE_DIR") || join(home, ".headroom");
    Object.assign(spec.env, {
      HEADROOM_WORKSPACE_DIR: spec.cwd,
      HEADROOM_CONFIG_DIR: value(env, "HEADROOM_CONFIG_DIR") || join(spec.cwd, "config"),
      HEADROOM_SETTINGS_PATH: value(env, "HEADROOM_SETTINGS_PATH") || join(spec.cwd, "settings.json"),
    });
    spec.clearEnv = ["ANTHROPIC_TARGET_API_URL", "OPENAI_TARGET_API_URL"];
  }
  spec.stdoutLog = join(spec.cwd, `gpt-${id}.stdout.log`);
  spec.stderrLog = join(spec.cwd, `gpt-${id}.stderr.log`);
  return spec;
}

// Keep this self-contained: Bun can rename imports when compiling the binary.
// The scheduled action injects Node's modules rather than capturing our imports.
function runService(spec, fs, spawn) {
  const env = { ...process.env };
  const replaced = new Set([...spec.clearEnv, ...Object.keys(spec.env)].map(key => key.toUpperCase()));
  for (const key of Object.keys(env)) if (replaced.has(key.toUpperCase())) delete env[key];
  Object.assign(env, spec.env);
  const stdout = fs.openSync(spec.stdoutLog, "a");
  const stderr = fs.openSync(spec.stderrLog, "a");
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd, env, windowsHide: true, stdio: ["ignore", stdout, stderr],
  });
  child.on("error", error => {
    fs.writeSync(stderr, `[aih] ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("close", code => {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    process.exitCode = code >= 0 && code !== null ? code : 1;
  });
}

function xml(text) {
  return String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}

function unxml(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]);
}

function quoteArgument(argument) {
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Start a hidden, persistent per-user task. Its definition intentionally survives CLI exit. */
export async function launchGptProcess(spec, { run = execCommand } = {}) {
  const description = `ai-helper GPT launcher v1: ${spec.taskName} (${spec.taskUser})`;
  const existing = await run(spec.schtasks, ["/Query", "/TN", spec.taskName, "/XML"]);
  const update = existing.exitCode === 0;
  if (update) {
    const oldDescription = existing.stdout.match(/<Description>([\s\S]*?)<\/Description>/)?.[1];
    const oldArguments = existing.stdout.match(/<Arguments>([\s\S]*?)<\/Arguments>/)?.[1];
    if (unxml(oldDescription || "") !== description || !unxml(oldArguments || "").includes(`/*${MARKER}*/`)) {
      throw new Error(`Scheduled task ${spec.taskName} is not owned by ai-helper; it was not changed. Rename that task or use a different Windows account.`);
    }
  }

  mkdirSync(spec.cwd, { recursive: true });
  for (const path of [spec.stdoutLog, spec.stderrLog]) mkdirSync(dirname(path), { recursive: true });
  const { command, args, cwd, env, clearEnv, stdoutLog, stderrLog } = spec;
  const payload = Buffer.from(JSON.stringify({ command, args, cwd, env, clearEnv, stdoutLog, stderrLog })).toString("base64");
  const script = `/*${MARKER}*/(${runService.toString()})(JSON.parse(Buffer.from("${payload}","base64").toString("utf8")),require("node:fs"),require("node:child_process").spawn)`;
  const argumentsText = ["-e", script].map(quoteArgument).join(" ");
  const definition = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(description)}</Description></RegistrationInfo>
  <Triggers />
  <Principals><Principal id="Author"><UserId>${xml(spec.taskUser)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${xml(spec.node)}</Command><Arguments>${xml(argumentsText)}</Arguments><WorkingDirectory>${xml(spec.cwd)}</WorkingDirectory></Exec></Actions>
</Task>`;
  const temporary = mkdtempSync(join(tmpdir(), "aih-gpt-task-"));
  try {
    const path = join(temporary, "task.xml");
    writeFileSync(path, `\uFEFF${definition}`, "utf16le");
    const created = await run(spec.schtasks, ["/Create", "/TN", spec.taskName, "/XML", path, ...(update ? ["/F"] : [])]);
    if (created.exitCode !== 0) throw new Error(`Cannot register ${spec.taskName}: ${created.stderr.trim() || created.stdout.trim() || "Task Scheduler rejected the task"}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const started = await run(spec.schtasks, ["/Run", "/TN", spec.taskName]);
  if (started.exitCode !== 0) throw new Error(`Cannot start ${spec.taskName}: ${started.stderr.trim() || started.stdout.trim() || "Task Scheduler rejected the start"}`);
  return { taskName: spec.taskName, stdoutLog: spec.stdoutLog, stderrLog: spec.stderrLog };
}
