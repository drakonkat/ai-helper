import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { SERVICE_PACKAGES, SERVICES } from "./config.js";
import { compareVersions } from "./utils/versions.js";
import { ensureDir, getLogsDir, getServiceLogPath } from "./utils/path.js";

/** Only allowlisted services/arguments reach an installer; never execute user input. */
export function serviceUpdateInvocation(id, platform = process.platform) {
  if (!Object.hasOwn(SERVICE_PACKAGES, id)) throw new Error(`Service '${id}' cannot be updated separately`);
  const pkg = SERVICE_PACKAGES[id];
  // Headroom detects its own Python environment (uv, pipx, pip/venv).
  // Do not run an arbitrary `pip` from PATH against a different interpreter.
  if (pkg.pypi) return { command: "headroom", args: ["update", "--yes"] };
  const args = ["install", "--global", `${pkg.name}@latest`, "--no-audit", "--no-fund"];
  // npm.cmd cannot be spawned directly on Windows. These are fixed arguments,
  // not paths or user-provided shell text; no shell is used on Unix.
  return platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", `npm ${args.join(" ")}`] }
    : { command: "npm", args };
}

/** Pin npx after an explicit update, so a project's old dependency/cache cannot win. */
export function serviceStartCommand(id, state) {
  const pkg = SERVICE_PACKAGES[id];
  const version = state?.launchVersion;
  if (pkg?.npx && typeof version === "string" && compareVersions(version, version) === 0) {
    return `npx --yes ${pkg.name}@${version.trim().replace(/^v/, "")}`;
  }
  return SERVICES[id]?.command;
}

/** Capture installer output, keeping --json/TUI clean and full diagnostics in the service log. */
export function installServiceUpdate(id, { spawnImpl = spawn, platform = process.platform } = {}) {
  const { command, args } = serviceUpdateInvocation(id, platform);
  ensureDir(getLogsDir());
  const logPath = getServiceLogPath(id);
  const fd = openSync(logPath, "a");
  writeSync(fd, `\n[aih] Update ${new Date().toISOString()}: ${command} ${args.join(" ")}\n`);
  return new Promise(resolve => {
    let tail = "";
    let finished = false;
    const finish = (exitCode, message) => {
      if (finished) return;
      finished = true;
      closeSync(fd);
      resolve({ success: exitCode === 0, exitCode, logPath,
        message: message || (exitCode === 0 ? "Installer completed" : `Installer failed (${exitCode}): ${tail.trim() || "no output"}`) });
    };
    const collect = data => {
      // Bound memory, not the log: package managers can produce many megabytes.
      const text = String(data);
      tail = (tail + text).slice(-4000);
      if (!finished) { try { writeSync(fd, text); } catch {} }
    };
    try {
      const child = spawnImpl(command, args, {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "1", npm_config_yes: "true", PIP_NO_INPUT: "1", NO_COLOR: "1" },
      });
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", error => finish(1, `Cannot update '${id}': ${error.message}`));
      // `close`, not `exit`: Headroom on Windows hands pip off to a child that
      // inherits these pipes. Wait for that installer too before restarting.
      child.once("close", (code, signal) => finish(code ?? 1, signal ? `Installer terminated by ${signal}` : undefined));
    } catch (error) { finish(1, error.message); }
  });
}
