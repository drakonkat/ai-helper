import { SERVICE_PACKAGES, SERVICES } from "./config.js";
import { compareVersions } from "./utils/versions.js";
import { npmUpdateInvocation, runUpdateInstaller } from "./utils/update-installer.js";

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
export function installServiceUpdate(id, { spawnImpl, platform = process.platform } = {}) {
  return runUpdateInstaller(id, serviceUpdateInvocation(id, platform), { spawnImpl });
}
