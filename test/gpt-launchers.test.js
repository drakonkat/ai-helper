import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchGptProcess, resolveGptLaunch } from "../src/gpt-launchers.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "aih-launcher & test-"));
  roots.push(home);
  const put = (relative, content = "") => {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const node = put("tools/node.exe");
  const env = { Path: dirname(node), USERNAME: "Test User", USERDOMAIN: "TEST" };
  return { home, env, node, put };
}

function scheduler({ existing, createError, runError } = {}) {
  const calls = [];
  let definition;
  let temporary;
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "/Query") return { exitCode: existing === undefined ? 1 : 0, stdout: existing || "", stderr: "" };
    if (args[0] === "/Create") {
      temporary = args[args.indexOf("/XML") + 1];
      definition = readFileSync(temporary, "utf16le");
      return { exitCode: createError ? 1 : 0, stdout: "", stderr: createError || "" };
    }
    if (args[0] === "/Run") return { exitCode: runError ? 1 : 0, stdout: "", stderr: runError || "" };
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { run, calls, get definition() { return definition; }, get temporary() { return temporary; } };
}

function textElement(xml, name) {
  return xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))[1]
    .replace(/&(?:amp|lt|gt|quot|apos);/g, text => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[text]);
}

// Decode Windows argv for inspecting the action on non-Windows test runners.
function windowsArgs(text) {
  const result = [];
  let current = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    let slashes = 0;
    while (text[i] === "\\") { slashes++; i++; }
    if (text[i] === '"') {
      current += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2) current += '"';
      else quoted = !quoted;
    } else {
      current += "\\".repeat(slashes);
      if (text[i] === " " && !quoted) { result.push(current); current = ""; }
      else if (text[i] !== undefined) current += text[i];
    }
  }
  result.push(current);
  return result;
}

describe("GPT launch resolution", () => {
  test("resolves a PATH npm installation with the exact pxpipe defaults and no secret snapshot", async () => {
    const f = fixture();
    const cli = f.put("tools/node_modules/pxpipe-proxy/bin/cli.js");
    const spec = await resolveGptLaunch("pxpipe", { ...f, env: { ...f.env, OPENAI_API_KEY: "secret", PXPIPE_MODELS: "wrong" } });
    expect(spec.command).toBe(f.node);
    expect(spec.args).toEqual([cli]);
    expect(spec.env).toMatchObject({ HOST: "127.0.0.1", PORT: "47822", PXPIPE_UPSTREAM: "http://127.0.0.1:10100", ANTHROPIC_UPSTREAM: "http://127.0.0.1:10100", OPENAI_UPSTREAM: "http://127.0.0.1:10100", PATH: f.env.Path });
    expect(spec.env.PXPIPE_CONFIG).toBe(join(f.home, ".config", "pxpipe", "config.json"));
    expect(spec.env.PXPIPE_LOG).toBe(join(f.home, ".pxpipe", "events.jsonl"));
    expect(JSON.parse(spec.env.PXPIPE_GPT_PROFILES)).toEqual({ "gpt-6-astra": { stripCols: 95, maxHeightPx: 1932, style: { font: "jetbrains-mono-12", cellWBonus: 0, cellHBonus: 0, aa: true, grid: false, gridCols: 0 } } });
    expect(spec.env.OPENAI_API_KEY).toBeUndefined();
    expect(spec.clearEnv).toEqual(["PXPIPE_MODELS", "OPENAI_API_KEY", "PXPIPE_PROVIDER", "PXPIPE_GATEWAY_BASE_URL", "PXPIPE_GATEWAY_HEADERS", "OPENAI_MODELS", "CLOUDFLARE_MODELS", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  });

  test("discovers dynamic npx cache directories and respects environment overrides", async () => {
    const f = fixture();
    const cache = join(f.home, "custom npm cache");
    const cli = f.put("custom npm cache/_npx/not-a-fixed-hash/node_modules/pxpipe-proxy/bin/cli.js");
    const env = { ...f.env, npm_config_cache: cache, XDG_CONFIG_HOME: join(f.home, "xdg"), PXPIPE_LOG: join(f.home, "custom events.jsonl"), PXPIPE_GPT_PROFILES: '{"custom":"a & b\\\""}' };
    const spec = await resolveGptLaunch("pxpipe", { ...f, env });
    expect(spec.args).toEqual([cli]);
    expect(spec.env.PXPIPE_CONFIG).toBe(join(env.XDG_CONFIG_HOME, "pxpipe", "config.json"));
    expect(spec.env.PXPIPE_LOG).toBe(env.PXPIPE_LOG);
    expect(spec.env.PXPIPE_GPT_PROFILES).toBe(env.PXPIPE_GPT_PROFILES);
    const overridden = await resolveGptLaunch("pxpipe", { ...f, env: { ...env, PXPIPE_CONFIG: "custom.json" } });
    expect(overridden.env.PXPIPE_CONFIG).toBe("custom.json");
  });

  test("finds LOCALAPPDATA npm cache and default per-home cache", async () => {
    const f = fixture();
    const cli = f.put("local/npm-cache/_npx/arbitrary/node_modules/pxpipe-proxy/bin/cli.js");
    const first = await resolveGptLaunch("pxpipe", { ...f, env: { ...f.env, LOCALAPPDATA: join(f.home, "local") } });
    expect(first.args).toEqual([cli]);
    const homeCli = f.put(".npm/_npx/another/node_modules/pxpipe-proxy/bin/cli.js");
    const second = await resolveGptLaunch("pxpipe", f);
    expect(second.args).toEqual([homeCli]);
  });

  test("uses npm's reported global root without executing a command shim", async () => {
    const f = fixture();
    const npm = f.put("tools/node_modules/npm/bin/npm-cli.js");
    const cli = f.put("different-global/pxpipe-proxy/bin/cli.js");
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, args]);
      return { exitCode: 0, stdout: join(f.home, "different-global"), stderr: "" };
    };
    const spec = await resolveGptLaunch("pxpipe", { ...f, run });
    expect(spec.args).toEqual([cli]);
    expect(calls).toEqual([[f.node, [npm, "root", "--global"]]]);
  });

  test("uses explicit node and CLI paths and refuses invalid overrides", async () => {
    const f = fixture();
    const cli = f.put("custom entry/cli.js");
    const spec = await resolveGptLaunch("pxpipe", { ...f, env: { ...f.env, Path: "", NODE_BINARY: f.node, PXPIPE_CLI_PATH: cli } });
    expect(spec.args).toEqual([cli]);
    await expect(resolveGptLaunch("pxpipe", { ...f, env: { ...f.env, NODE_BINARY: "missing-node.exe" } })).rejects.toThrow("executable override");
    await expect(resolveGptLaunch("pxpipe", { ...f, env: { ...f.env, PXPIPE_CLI_PATH: "missing.js" } })).rejects.toThrow("PXPIPE_CLI_PATH");
  });

  test("reports actionable missing dependencies without installing anything", async () => {
    const f = fixture();
    await expect(resolveGptLaunch("pxpipe", f)).rejects.toThrow("npm install --global pxpipe-proxy");
    await expect(resolveGptLaunch("headroom", f)).rejects.toThrow("HEADROOM_BINARY");
    await expect(resolveGptLaunch("pxpipe", { ...f, env: { Path: "" } })).rejects.toThrow("NODE_BINARY");
    await expect(resolveGptLaunch("other", f)).rejects.toThrow("Unknown GPT launcher");
  });

  test("resolves Headroom local executable and exact proxy arguments", async () => {
    const f = fixture();
    const executable = f.put(".local/bin/headroom.exe");
    const spec = await resolveGptLaunch("headroom", f);
    expect(spec.command).toBe(executable);
    expect(spec.args).toEqual(["proxy", "--host", "127.0.0.1", "--port", "8788", "--openai-api-url", "http://127.0.0.1:47822", "--anthropic-api-url", "http://127.0.0.1:47822", "--lossless", "--no-cache"]);
    expect(spec.env.HEADROOM_WORKSPACE_DIR).toBe(join(f.home, ".headroom"));
    expect(spec.env.HEADROOM_CONFIG_DIR).toBe(join(f.home, ".headroom", "config"));
    expect(spec.env.HEADROOM_SETTINGS_PATH).toBe(join(f.home, ".headroom", "settings.json"));
    expect(spec.clearEnv).toEqual(["ANTHROPIC_TARGET_API_URL", "OPENAI_TARGET_API_URL"]);
  });

  test("honors Headroom executable/workspace/config/settings overrides", async () => {
    const f = fixture();
    const executable = f.put("custom/headroom.exe");
    const env = { ...f.env, HEADROOM_BINARY: executable, HEADROOM_WORKSPACE_DIR: join(f.home, "workspace"), HEADROOM_CONFIG_DIR: join(f.home, "configs"), HEADROOM_SETTINGS_PATH: join(f.home, "settings.json") };
    const spec = await resolveGptLaunch("headroom", { ...f, env });
    expect(spec.command).toBe(executable);
    expect(spec.cwd).toBe(env.HEADROOM_WORKSPACE_DIR);
    expect(spec.env).toMatchObject({ HEADROOM_CONFIG_DIR: env.HEADROOM_CONFIG_DIR, HEADROOM_SETTINGS_PATH: env.HEADROOM_SETTINGS_PATH });
  });
});

describe("persistent GPT tasks (mocked scheduler only)", () => {
  async function spec() {
    const f = fixture();
    f.put(".local/bin/headroom.exe");
    return resolveGptLaunch("headroom", f);
  }

  test("registers a hidden interactive task without timeout and removes temporary XML", async () => {
    const launch = await spec();
    const task = scheduler();
    const result = await launchGptProcess(launch, task);
    expect(task.calls.map(call => call.args[0])).toEqual(["/Query", "/Create", "/Run"]);
    expect(task.calls[1].args).not.toContain("/F");
    expect(task.definition).toContain("<Triggers />");
    expect(task.definition).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(task.definition).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(task.definition).toContain("<Hidden>true</Hidden>");
    expect(task.definition).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(task.definition).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(task.definition).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(task.definition).toContain("&amp;");
    expect(existsSync(task.temporary)).toBe(false);
    expect(existsSync(dirname(task.temporary))).toBe(false);
    expect(result.taskName).toBe("AIH-GPT-Test User-headroom");
  });

  test("updates only an owned task and refuses an unrelated same-name task", async () => {
    const launch = await spec();
    const first = scheduler();
    await launchGptProcess(launch, first);
    const update = scheduler({ existing: first.definition });
    await launchGptProcess({ ...launch, env: { ...launch.env, PATH: "changed" } }, update);
    expect(update.calls[1].args).toContain("/F");
    for (const existing of ["<Task><RegistrationInfo><Description>Someone else's task</Description></RegistrationInfo></Task>", first.definition.replace("AIH_GPT_LAUNCHER_V1", "unrelated")]) {
      const foreign = scheduler({ existing });
      await expect(launchGptProcess(launch, foreign)).rejects.toThrow("not owned by ai-helper");
      expect(foreign.calls).toHaveLength(1);
    }
  });

  test("cleans temporary XML on registration errors and reports run failures", async () => {
    const launch = await spec();
    const registration = scheduler({ createError: "Access denied" });
    await expect(launchGptProcess(launch, registration)).rejects.toThrow("Access denied");
    expect(existsSync(registration.temporary)).toBe(false);
    expect(registration.calls).toHaveLength(2);
    const start = scheduler({ runError: "User is not logged on" });
    await expect(launchGptProcess(launch, start)).rejects.toThrow("User is not logged on");
  });

  test("inline action preserves quotes and ampersands, clears stale env, logs output and propagates exit", async () => {
    const launch = await spec();
    const childPath = join(launch.cwd, "harmless child.js");
    const special = 'quoted "value" & apostrophe\' and \\trail\\';
    mkdirSync(launch.cwd, { recursive: true });
    writeFileSync(childPath, 'console.log(JSON.stringify({value:process.env.LAUNCHER_TEST,args:process.argv.slice(2),stale:process.env.OPENAI_TARGET_API_URL})); console.error("test stderr"); process.exitCode=7;');
    Object.assign(launch, { command: process.execPath, args: [childPath, special], env: { ...launch.env, LAUNCHER_TEST: special } });
    const task = scheduler();
    await launchGptProcess(launch, task);
    const argumentsText = textElement(task.definition, "Arguments");
    const args = windowsArgs(argumentsText);
    expect(args[0]).toBe("-e");
    expect(args).toHaveLength(2);
    const child = spawnSync("node", process.platform === "win32" ? [argumentsText] : args, {
      windowsVerbatimArguments: process.platform === "win32", windowsHide: true, encoding: "utf8",
      env: { ...process.env, OPENAI_TARGET_API_URL: "must-be-cleared" }, timeout: 10000,
    });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(7);
    expect(JSON.parse(readFileSync(launch.stdoutLog, "utf8"))).toEqual({ value: special, args: [special] });
    expect(readFileSync(launch.stderrLog, "utf8")).toBe("test stderr\n");
  });

  test("Bun standalone minification keeps the inline runner self-contained", async () => {
    const launch = await spec();
    const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    Object.assign(launch, { node, command: node, args: ["-e", 'console.log("compiled runner");process.exitCode=9;'] });
    const root = dirname(launch.cwd);
    const entry = join(root, "compile-check.js");
    const executable = join(root, process.platform === "win32" ? "compile-check.exe" : "compile-check");
    const savedXml = join(root, "saved-task.xml");
    const modulePath = fileURLToPath(new URL("../src/gpt-launchers.js", import.meta.url));
    writeFileSync(entry, `
      import { launchGptProcess } from ${JSON.stringify(modulePath)};
      import { readFileSync, writeFileSync } from "node:fs";
      await launchGptProcess(${JSON.stringify(launch)}, { run: async (_, args) => {
        if (args[0] === "/Create") writeFileSync(${JSON.stringify(savedXml)}, readFileSync(args[args.indexOf("/XML") + 1]));
        return { exitCode: args[0] === "/Query" ? 1 : 0, stdout: "", stderr: "" };
      }});
    `);
    const build = spawnSync("bun", ["build", "--compile", "--minify", "--outfile", executable, entry], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    expect(build.status).toBe(0);
    const compiled = spawnSync(executable, [], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    expect(compiled.stderr).toBe("");
    expect(compiled.status).toBe(0);
    const argumentsText = textElement(readFileSync(savedXml, "utf16le"), "Arguments");
    const child = spawnSync(node, process.platform === "win32" ? [argumentsText] : windowsArgs(argumentsText), {
      windowsVerbatimArguments: process.platform === "win32", windowsHide: true, encoding: "utf8", timeout: 10000,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(9);
    expect(readFileSync(launch.stdoutLog, "utf8")).toBe("compiled runner\n");
  }, 40000);
});
