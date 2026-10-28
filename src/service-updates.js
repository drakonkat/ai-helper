
import { homedir } from "node:os";
import { join } from "node:path";
import { SERVICE_PACKAGES, SERVICES } from "./config.js";
import { compareVersions, runVersionCommand } from "./utils/versions.js";
import { refreshToolPath } from "./utils/tool-path.js";
export { refreshToolPath, toolSearchDirectories } from "./utils/tool-path.js";
import { npmUpdateInvocation, runUpdateInstaller } from "./utils/update-installer.js";

/** pip requirement for a runnable Headroom proxy (the proxy dependencies are an extra). */
export const HEADROOM_REQUIREMENT = "headroom-ai[proxy]";
/**
 * Headroom pulls native dependencies (e.g. zstandard) that lack wheels for very
 * new Python releases, so it gets its own interpreter instead of the system one.
 */
export const HEADROOM_PYTHON = "3.12";
const MIN_PYTHON_MINOR = 10;

/** Only allowlisted services/arguments reach an installer; never execute user input. */
export function serviceUpdateInvocation(id, platform = process.platform) {
  if (!Object.hasOwn(SERVICE_PACKAGES, id)) throw new Error(`Service '${id}' cannot be updated separately`);
  const pkg = SERVICE_PACKAGES[id];
  // Headroom detects its own Python environment (uv, pipx, pip/venv).
  // Do not run an arbitrary `pip` from PATH against a different interpreter.
  if (pkg.pypi) return { command: "headroom", args: ["update", "--yes"] };
  return npmUpdateInvocation(pkg.name, platform);
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
export function installServiceUpdate(id, options = {}) {
  const { spawnImpl, platform = process.platform } = options;
  // Validates the id synchronously, before anything can be spawned.
  const invocation = serviceUpdateInvocation(id, platform);
  if (!SERVICE_PACKAGES[id].pypi) return runUpdateInstaller(id, invocation, { spawnImpl });
  return installHeadroom(id, invocation, options);
}

async function findPython(probe, platform) {
  const candidates = platform === "win32" ? [["python"], ["py", "-3"]] : [["python3"], ["python"]];
  for (const [command, ...prefix] of candidates) {
    const match = (await probe(command, [...prefix, "--version"]))?.match(/^Python (\d+)\.(\d+)/);
    // On Windows the Store "python" alias fails this check instead of opening the Store.
    if (match && Number(match[1]) === 3 && Number(match[2]) >= MIN_PYTHON_MINOR) return { command, prefix };
  }
  return null;
}

/** Fixed package-manager invocation that installs Python, or null when none is usable. */
async function pythonInstallInvocation(platform, available) {
  if (platform === "win32") {
    return await available("winget") ? { command: "winget", args: ["install", "-e", "--id", "Python.Python.3.12",
      "--scope", "user", "--silent", "--accept-package-agreements", "--accept-source-agreements"] } : null;
  }
  if (platform === "darwin") return await available("brew") ? { command: "brew", args: ["install", "python"] } : null;
  const sudo = process.getuid?.() === 0 ? [] : ["sudo", "-n"];
  const elevated = args => ({ command: [...sudo, ...args][0], args: [...sudo, ...args].slice(1) });
  if (await available("apt-get")) return elevated(["apt-get", "install", "-y", "python3", "python3-pip", "python3-venv"]);
  if (await available("dnf")) return elevated(["dnf", "install", "-y", "python3", "python3-pip"]);
  return null;
}

/**
 * Install or update Headroom on this machine. An existing installation is
 * updated by Headroom itself; otherwise the missing prerequisites (Python,
 * pipx/uv) are installed first. Never shells out with user-provided text.
 */
async function installHeadroom(id, updateInvocation, { spawnImpl, platform = process.platform, probe = runVersionCommand, refreshPath = refreshToolPath } = {}) {
  const run = (invocation, env) => runUpdateInstaller(id, invocation, { spawnImpl, env });
  const available = async (command, args = ["--version"]) => (await probe(command, args, 5000)) !== null;
  refreshPath();
  // The first launch of a fresh Python install compiles bytecode and can take
  // tens of seconds; warm it up so aih's short version probe does not time out.
  const warmUp = async result => {
    if (result.success) await probe("headroom", ["--version"], 180000);
    return result;
  };
  if (await available("headroom")) return warmUp(await run(updateInvocation));

  const failed = (message, last) => ({ success: false, exitCode: last?.exitCode ?? 1, logPath: last?.logPath, message });
  const install = ["tool", "install", "--force", "--python", HEADROOM_PYTHON, HEADROOM_REQUIREMENT];
  // uv links its managed Python with a junction. Under MSIX-packaged hosts (e.g. the Codex
  // desktop app) %APPDATA% is virtualized and that junction dangles, so keep it in the real home.
  const uvEnv = platform === "win32" && !process.env.UV_PYTHON_INSTALL_DIR
    ? { UV_PYTHON_INSTALL_DIR: join(homedir(), ".local", "share", "uv", "python") } : undefined;
  let steps;
  if (await available("uv")) {
    steps = [{ command: "uv", args: install, env: uvEnv }];
  } else {
    // uv installs and manages the right Python itself; the system Python is only used to bootstrap uv.
    let python = await findPython(probe, platform);
    if (!python) {
      const pythonInstall = await pythonInstallInvocation(platform, available);
      if (!pythonInstall) return failed("Python 3." + MIN_PYTHON_MINOR + "+ is required to install Headroom and no supported package manager was found (winget, brew, apt-get, dnf). Install Python or uv manually and retry.");
      const installed = await run(pythonInstall);
      if (!installed.success) return { ...installed, message: "Cannot install Python for 'headroom': " + installed.message };
      refreshPath();
      python = await findPython(probe, platform);
      if (!python) return failed("Python was installed but is not visible to this process yet; open a new terminal and run the update again.", installed);
    }
    const py = [...python.prefix, "-m"];
    steps = [
      { command: python.command, args: [...py, "pip", "install", "--user", "--upgrade", "uv"], env: { PIP_BREAK_SYSTEM_PACKAGES: "1" } },
      { command: python.command, args: [...py, "uv", ...install], env: uvEnv },
      { command: python.command, args: [...py, "uv", "tool", "update-shell"] },
    ];
  }
  let result = { success: true, exitCode: 0 };
  for (const { env, ...invocation } of steps) {
    result = await run(invocation, env);
    if (!result.success) return { ...result, message: "Cannot install 'headroom': " + result.message };
  }
  refreshPath();
  return warmUp(result);
}
