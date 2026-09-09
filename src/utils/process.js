import { spawn } from "node:child_process";
import { openSync, appendFileSync } from "node:fs";
import { ensureDir, getLogsDir } from "./path.js";

/**
 * Async sleep utility compatible with Node.js and Bun.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper to run a command and return stdout/stderr asynchronously.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<{ exitCode: number; stdout: string; stderr: string }>}
 */
export function execCommand(cmd, args) {
  return new Promise(resolve => {
    try {
      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", d => (stdout += d.toString()));
      proc.stderr?.on("data", d => (stderr += d.toString()));

      proc.on("close", exitCode => {
        resolve({ exitCode: exitCode ?? 0, stdout, stderr });
      });

      proc.on("error", err => {
        resolve({ exitCode: 1, stdout: "", stderr: err.message });
      });
    } catch (err) {
      resolve({ exitCode: 1, stdout: "", stderr: err.message });
    }
  });
}

/**
 * Checks if a process with the given PID is currently active.
 * @param {number} [pid]
 * @returns {boolean}
 */
export function isPidRunning(pid) {
  if (!pid || pid <= 0) return false;
  try {
    return process.kill(pid, 0);
  } catch (err) {
    if (err?.code === "ESRCH") {
      return false;
    }
    if (err?.code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Opens a URL in the user's default web browser cross-platform.
 * @param {string} url
 */
export function openBrowser(url) {
  if (!url) return;
  try {
    if (process.platform === "win32") {
      const proc = spawn("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      proc.unref();
    } else if (process.platform === "darwin") {
      const proc = spawn("open", [url], {
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
    } else {
      const proc = spawn("xdg-open", [url], {
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
    }
  } catch {}
}

/**
 * Finds PIDs of processes currently listening on the specified TCP ports.
 * @param {number[]} ports
 * @returns {Promise<number[]>}
 */
export async function findPidsListeningOnPorts(ports) {
  if (!ports || ports.length === 0) return [];
  const matchedPids = new Set();

  if (process.platform === "win32") {
    try {
      const portList = ports.join(", ");
      const script = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in ${portList} } | Select-Object -ExpandProperty OwningProcess`;
      const res = await execCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      const lines = res.stdout.trim().split(/\r?\n/);
      for (const line of lines) {
        const pid = parseInt(line.trim(), 10);
        if (pid && !isNaN(pid) && pid > 0) {
          matchedPids.add(pid);
        }
      }
    } catch {}
  } else {
    try {
      for (const port of ports) {
        const res = await execCommand("lsof", ["-t", `-i:${port}`, "-sTCP:LISTEN"]);
        const lines = res.stdout.trim().split(/\r?\n/);
        for (const line of lines) {
          const pid = parseInt(line.trim(), 10);
          if (pid && !isNaN(pid) && pid > 0) {
            matchedPids.add(pid);
          }
        }
      }
    } catch {}
  }

  return Array.from(matchedPids);
}

/**
 * Kills a process and its entire child process tree.
 * @param {number} pid
 * @returns {Promise<{ success: boolean; message: string }>}
 */
export async function killProcessTree(pid) {
  if (!isPidRunning(pid)) {
    return { success: true, message: `Process ${pid} is not running` };
  }

  if (process.platform === "win32") {
    try {
      const res = await execCommand("taskkill.exe", ["/pid", String(pid), "/T", "/F"]);
      await sleep(200);

      if (!isPidRunning(pid)) {
        return { success: true, message: `Terminated process tree for PID ${pid}` };
      }

      try {
        process.kill(pid, "SIGKILL");
      } catch {}

      return {
        success: !isPidRunning(pid),
        message: res.stdout.trim() || res.stderr.trim() || `Killed process ${pid}`,
      };
    } catch (err) {
      try {
        process.kill(pid, "SIGKILL");
        return { success: true, message: `Killed process ${pid} via signal fallback` };
      } catch {
        return { success: false, message: err?.message || String(err) };
      }
    }
  } else {
    try {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }

      for (let i = 0; i < 5; i++) {
        if (!isPidRunning(pid)) break;
        await sleep(100);
      }

      if (isPidRunning(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }

      await sleep(100);
      const stopped = !isPidRunning(pid);
      return {
        success: stopped,
        message: stopped ? `Terminated process ${pid}` : `Failed to terminate process ${pid}`,
      };
    } catch (err) {
      return { success: false, message: err?.message || String(err) };
    }
  }
}

/**
 * Spawns a background detached service and redirects output to a log file.
 * @param {string} command
 * @param {string} logFilePath
 * @param {{ env?: Record<string, string>; cwd?: string }} [options]
 * @returns {{ pid: number }}
 */
export function spawnDetachedProcess(command, logFilePath, options) {
  ensureDir(getLogsDir());

  const timestamp = new Date().toISOString();
  const banner = `\n[aih] ========================================\n[aih] Service started at: ${timestamp}\n[aih] Command: ${command}\n[aih] ========================================\n\n`;

  try {
    appendFileSync(logFilePath, banner, "utf-8");
  } catch {}

  const fd = openSync(logFilePath, "a");

  const proc = spawn(command, [], {
    shell: true,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...options?.env },
    cwd: options?.cwd,
    windowsHide: true,
  });

  proc.unref();

  return { pid: proc.pid };
}

// agentmemory binds a quartet derived from one anchor port N:
//   REST N | streams N+1 | viewer N+2 | engine N+46023
const AGENTMEMORY_ENGINE_OFFSET = 46023;
const AGENTMEMORY_VIEWER_OFFSET = 2;
const AGENTMEMORY_DEFAULT_VIEWER = 3113;

/**
 * Resolves the agentmemory viewer port from the ports a process is listening on.
 * The engine port is the one that binds 0.0.0.0 and is usually discovered first,
 * but the only browsable dashboard is the viewer, so derive it from the anchor.
 * @param {number[]} ports
 * @param {number[]} [viewerPorts] Ports owned by the Node viewer, not the iii engine.
 * @returns {number}
 */
export function resolveAgentmemoryViewerPort(ports, viewerPorts = []) {
  // The Node viewer and iii engine can own different parts of the port quartet.
  const visibleViewerPorts = [...new Set(viewerPorts.filter(p => Number.isFinite(p) && p > 0))];
  if (visibleViewerPorts.length === 1) return visibleViewerPorts[0];
  const candidates = (ports || []).filter(p => Number.isFinite(p) && p > 0);
  if (candidates.length === 0) return AGENTMEMORY_DEFAULT_VIEWER;

  // The engine port is the most reliable marker: it is the only one above the
  // offset and always anchor + 46023, so it recovers the anchor by itself. This
  // matters because the engine binds 0.0.0.0 while the rest of the quartet is
  // loopback-only, so the engine is sometimes the only port we get to see.
  const engine = candidates.find(p => p > AGENTMEMORY_ENGINE_OFFSET);
  if (engine) return engine - AGENTMEMORY_ENGINE_OFFSET + AGENTMEMORY_VIEWER_OFFSET;

  // Otherwise the lowest port is the REST anchor: REST is always bound, so the
  // smallest one we can see is the base of the quartet.
  return Math.min(...candidates) + AGENTMEMORY_VIEWER_OFFSET;
}

/** Resolve services from one Windows process/port snapshot, including child workers. */
export function discoverWindowsProcesses(data, { knownServices = {}, currentPid = process.pid, isRunning = isPidRunning } = {}) {
  const array = value => value ? (Array.isArray(value) ? value : [value]) : [];
  const procs = array(data?.Procs).filter(p => p.ProcessId && p.ProcessId !== currentPid);
  const ports = array(data?.Ports).filter(p => p.LocalPort > 0 && p.OwningProcess > 0);
  const byPid = new Map(procs.map(p => [p.ProcessId, p]));
  const children = new Map();
  const ownedPorts = new Map();
  for (const p of procs) children.set(p.ParentProcessId, [...(children.get(p.ParentProcessId) || []), p]);
  for (const p of ports) ownedPorts.set(p.OwningProcess, [...(ownedPorts.get(p.OwningProcess) || []), p]);
  const runtime = p => /^(node|bun|python[\d.]*|headroom|ocx|iii|cmd|powershell|pwsh)(\.exe)?$/i.test(p.Name || "");
  const engine = p => /^iii(?:\.exe)?$/i.test(p.Name || "");

  function serviceOf(p) {
    if (!runtime(p)) return;
    const cmd = (p.CommandLine || "").replace(/\\/g, "/").toLowerCase();
    // Do not exclude every bin/cli.js: pxpipe's real daemon uses that filename too.
    if (/aih_gpt_launcher|get-ciminstance|where-object|(?:ai-helper|\.aih)\/(?:bin\/cli|src\/index)\.js/.test(cmd)) return;
    if (/agentmemory-mcp|@agentmemory\/mcp|\bagentmemory\s+mcp\b|cli\.mjs["']?\s+mcp\b/.test(cmd)) return;
    if (cmd.includes("pxpipe-proxy")) return "pxpipe";
    if (cmd.includes("ocx.mjs") || (cmd.includes("opencodex") && !cmd.includes(".ps1")) || /\bocx(?:\.exe)?["']?\s+start\b/.test(cmd)) return "ocx";
    if (engine(p) || /@agentmemory\/agentmemory|agentmemory\/dist\/cli\.mjs|iii-config\.yaml/.test(cmd)) return "agentmemory";
    if (/headroom(?:\.exe)?["']?\s+proxy\b/.test(cmd)) return "headroom";
  }

  const discovered = {};
  const ranks = {};
  for (const seed of procs) {
    let id = serviceOf(seed);
    // Elevated processes may hide their command lines; a recorded PID still identifies their tree.
    if (!id && !seed.CommandLine && runtime(seed)) {
      id = Object.keys(knownServices).find(id => knownServices[id]?.pid === seed.ProcessId);
    }
    if (!id) continue;
    let root = seed;
    if (id === "agentmemory" && engine(seed)) {
      const parent = byPid.get(seed.ParentProcessId);
      if (parent && /^(node|bun)(\.exe)?$/i.test(parent.Name || "") &&
          (!parent.CommandLine || serviceOf(parent) === id)) root = parent;
    }
    const family = new Map();
    const pending = [root];
    while (pending.length) {
      const p = pending.pop();
      if (family.has(p.ProcessId)) continue;
      family.set(p.ProcessId, p);
      pending.push(...(children.get(p.ProcessId) || []));
    }
    const listeners = [...family.keys()].flatMap(pid => ownedPorts.get(pid) || []);
    if (!listeners.length) continue; // Shells, editors and hooks are not running daemons.
    const available = listeners.map(p => p.LocalPort);
    let port;
    if (id === "agentmemory") {
      const enginePorts = listeners.filter(p => engine(family.get(p.OwningProcess))).map(p => p.LocalPort);
      const viewerPorts = listeners.filter(p => /^(node|bun)(\.exe)?$/i.test(family.get(p.OwningProcess)?.Name || "")).map(p => p.LocalPort);
      port = resolveAgentmemoryViewerPort(enginePorts.length ? enginePorts : available, viewerPorts);
    } else {
      const explicit = Number(seed.CommandLine?.match(/\s--port(?:=|\s+)(\d+)/i)?.[1]);
      const defaults = { pxpipe: [47822, 47821], headroom: [8788, 8787], ocx: [10100] };
      port = [explicit, ...(defaults[id] || []), ...available].find(p => available.includes(p));
    }
    const owner = family.get((listeners.find(p => p.LocalPort === port) || listeners[0]).OwningProcess);
    if (!isRunning(owner.ProcessId)) continue;
    const rank = family.has(knownServices[id]?.pid) ? 1 : 0;
    if (discovered[id] && ranks[id] >= rank) continue;
    const date = owner.CreationDate;
    const match = String(date || "").match(/\/Date\((\d+)\)\//);
    const started = new Date(match ? Number(match[1]) : date || NaN);
    discovered[id] = {
      pid: owner.ProcessId,
      command: owner.CommandLine || seed.CommandLine || knownServices[id]?.command || id,
      startedAt: !isNaN(started.getTime()) ? started.toISOString() : undefined,
      port,
      url: `http://localhost:${port}${id === "headroom" ? "/dashboard" : ""}`,
    };
    ranks[id] = rank;
  }
  return discovered;
}

/**
 * Scans the OS process table and listening ports to discover active services and their URLs.
 * @returns {Promise<Record<string, { pid: number; command: string; startedAt?: string; url?: string }>>}
 */
export async function discoverRunningProcesses({ knownServices = {} } = {}) {
  const discovered = {};
  const currentPid = process.pid;

  if (process.platform === "win32") {
    try {
      // Keep parents and children even when elevation hides their command lines.
      const script = `
        $procs = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${currentPid} } |
          Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate
        $ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
          Select-Object LocalPort, OwningProcess
        @{ Procs = $procs; Ports = $ports } | ConvertTo-Json -Depth 3
      `;
      const res = await execCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      if (res.stdout.trim()) return discoverWindowsProcesses(JSON.parse(res.stdout), { knownServices });
    } catch {}
  } else {
    try {
      const res = await execCommand("ps", ["-eo", "pid,command"]);
      const lines = res.stdout.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.includes("ps -eo") || trimmed.includes("ai-helper") || /\baih\b/.test(trimmed)) continue;

        const parts = trimmed.split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const cmd = parts.slice(1).join(" ");
        if (!pid || pid === currentPid || !isPidRunning(pid)) continue;

        if (cmd.includes("bin/cli.js") || cmd.includes("bin/aih")) continue;

        if (cmd.includes("pxpipe-proxy")) {
          if (!discovered.pxpipe) discovered.pxpipe = { pid, command: cmd, url: "http://localhost:47821" };
        }
        if (cmd.includes("ocx start") || cmd.includes("ocx.mjs") || cmd.includes("opencodex")) {
          if (!discovered.ocx) discovered.ocx = { pid, command: cmd, url: "http://localhost:10100" };
        }

       const isMcpShim = cmd.includes("agentmemory-mcp") || cmd.includes("@agentmemory/mcp") || cmd.includes("agentmemory mcp");
       if (
         !isMcpShim &&
         (cmd.includes("@agentmemory/agentmemory") ||
           cmd.includes("iii-config.yaml") ||
           cmd.includes("iii") ||
           (cmd.includes("agentmemory") && !cmd.includes("mcp")))
       ) {
         if (!discovered.agentmemory) discovered.agentmemory = { pid, command: cmd, url: "http://localhost:3113" };
       }

        if (cmd.includes("headroom proxy") || (cmd.includes("headroom") && !cmd.includes("aih "))) {
          if (!discovered.headroom) discovered.headroom = { pid, command: cmd, url: "http://localhost:8787/dashboard" };
        }
     }
   } catch {}
  }

  return discovered;
}
