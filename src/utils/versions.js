import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { baseUrl, fetchJson } from "./metrics.js";
import { SERVICE_PACKAGES as PACKAGES } from "../config.js";

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  if (match[4]?.split(".").some(part => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") || [] };
}

function cleanVersion(value) {
  return parseVersion(value) ? value.trim().replace(/^v/, "") : null;
}

/** Returns -1, 0, 1, or null when either version cannot be compared safely. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y) ? -1 : 1;
    } else if (xn !== yn) return xn ? -1 : 1;
    else return x < y ? -1 : 1;
  }
  return 0;
}

/** Only bounded, read-only commands are used; never invoke npx or an updater. */
export function runVersionCommand(command, args, timeoutMs = 3000) {
  return new Promise(resolveResult => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
      resolveResult(error ? null : String(stdout).trim());
    });
  });
}

async function getProcessCommands(statuses) {
  const pids = [...new Set(statuses.filter(s => s.status === "running").map(s => Number(s.pid)))]
    .filter(pid => Number.isSafeInteger(pid) && pid > 0);
  if (!pids.length) return {};
  if (process.platform === "win32") {
    const filter = pids.map(pid => `ProcessId = ${pid}`).join(" OR ");
    const output = await runVersionCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`]);
    try {
      const parsed = JSON.parse(output);
      return Object.fromEntries((Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(p => [p.ProcessId, p.CommandLine]));
    } catch { return {}; }
  }
  const output = await runVersionCommand("ps", ["-p", pids.join(","), "-o", "pid=,args="]);
  return Object.fromEntries((output || "").split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

async function readPackageVersion(path, name) {
  try {
    const pkg = JSON.parse(await readFile(path, "utf8"));
    return pkg.name === name ? cleanVersion(pkg.version) : null;
  } catch { return null; }
}

/** Read the package referenced by this process, not an arbitrary npx cache entry. */
export async function readNpmVersionFromCommand(command, name) {
  for (const match of (command || "").matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
    const token = match[1] || match[2] || match[3];
    if (!isAbsolute(token)) continue;
    const path = resolve(token).replace(/\\/g, "/");
    const marker = `/node_modules/${name}/`;
    const index = path.lastIndexOf(marker);
    if (index < 0) continue;
    const version = await readPackageVersion(`${path.slice(0, index + marker.length)}package.json`, name);
    if (version) return version;
  }
  return null;
}

async function getInstalledVersion(status, command) {
  const pkg = PACKAGES[status.id];
  if (pkg.pypi) {
    // Headroom's Click CLI explicitly implements --version without starting a proxy.
    const output = await runVersionCommand("headroom", ["--version"]);
    return cleanVersion(output?.match(/^headroom, version\s+(\S+)$/im)?.[1]);
  }
  const running = await readNpmVersionFromCommand(command, pkg.name);
  if (running) return running;
  // A running service may be an older cached install, not the package on PATH.
  if (status.status === "running") return null;
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    // npm's Windows shims live alongside node_modules; Unix bins are symlinks.
    for (const candidate of [join(directory, "node_modules", pkg.name, "package.json"),
      join(directory, "..", "lib", "node_modules", pkg.name, "package.json")]) {
      const version = await readPackageVersion(candidate, pkg.name);
      if (version) return version;
    }
    try {
      const bin = await realpath(join(directory, pkg.bin));
      const version = await readNpmVersionFromCommand(JSON.stringify(bin), pkg.name);
      if (version) return version;
      // Bun/pnpm links may resolve outside node_modules; only trust named metadata.
      for (let path = dirname(bin), i = 0; i < 3; path = dirname(path), i++) {
        const version = await readPackageVersion(join(path, "package.json"), pkg.name);
        if (version) return version;
      }
    } catch {}
  }
  return null;
}

/**
 * Installed/running and latest published versions. Unknowns stay null, including
 * updateAvailable: a failed registry check is not evidence of being up to date.
 * Optional readers keep tests offline and independent of installed services.
 */
export async function getServiceVersions(statuses, {
  request = fetchJson,
  processCommands = getProcessCommands,
  installedVersion = getInstalledVersion,
} = {}) {
  const services = (statuses || []).filter(status => PACKAGES[status.id]);
  let commands;
  const readCommands = () => commands ||= Promise.resolve().then(() => processCommands(services)).catch(() => ({}));
  return Object.fromEntries(await Promise.all(services.map(async status => {
    const pkg = PACKAGES[status.id];
    const latest = (async () => {
      try {
        const url = pkg.pypi ? `https://pypi.org/pypi/${pkg.name}/json` : `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`;
        const data = await request(url, 3000);
        return cleanVersion(pkg.pypi ? data?.info?.version : data?.version);
      } catch { return null; }
    })();
    const installed = (async () => {
      if (status.status === "running" && pkg.health && baseUrl(status.url)) {
        try {
          const data = await request(`${baseUrl(status.url)}${pkg.health}`, 2000);
          const version = cleanVersion(data?.version);
          if (version && (!pkg.service || data?.service === pkg.service)) return version;
        } catch {}
      }
      try {
        const command = status.status === "running" ? (await readCommands())[status.pid] : null;
        return cleanVersion(await installedVersion(status, command));
      } catch { return null; }
    })();
    const [version, latestVersion] = await Promise.all([installed, latest]);
    const comparison = compareVersions(version, latestVersion);
    return [status.id, { version, latestVersion, updateAvailable: comparison === null ? null : comparison < 0 }];
  })));
}
