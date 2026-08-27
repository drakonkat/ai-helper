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

/**
 * Scans the OS process table and listening ports to discover active services and their URLs.
 * @returns {Promise<Record<string, { pid: number; command: string; startedAt?: string; url?: string }>>}
 */
export async function discoverRunningProcesses() {
  const discovered = {};
  const currentPid = process.pid;

  if (process.platform === "win32") {
    try {
      const script = `
       $procs = Get-CimInstance Win32_Process | Where-Object { 
         $_.ProcessId -ne ${currentPid} -and 
         $_.CommandLine -and 
          ($_.CommandLine -match 'pxpipe-proxy|ocx|agentmemory|iii|headroom') -and 
         ($_.CommandLine -notmatch 'ai-helper|\\baih(\\.exe)?\\b|bin\\\\cli\\.js|Get-CimInstance|Where-Object|Select-Object')
       } | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate

        $ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess

        @{ Procs = $procs; Ports = $ports } | ConvertTo-Json -Depth 3
      `;

      const res = await execCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      if (!res.stdout.trim()) return discovered;

      let data;
      try {
        data = JSON.parse(res.stdout.trim());
      } catch {
        return discovered;
      }

      const procList = data?.Procs ? (Array.isArray(data.Procs) ? data.Procs : [data.Procs]) : [];
      const portList = data?.Ports ? (Array.isArray(data.Ports) ? data.Ports : [data.Ports]) : [];

      const pidToPorts = {};
      for (const p of portList) {
        if (p?.OwningProcess && p?.LocalPort) {
          if (!pidToPorts[p.OwningProcess]) pidToPorts[p.OwningProcess] = [];
          pidToPorts[p.OwningProcess].push(p.LocalPort);
        }
      }

      for (const item of procList) {
        const cmd = item.CommandLine || "";
        const pid = item.ProcessId;
        if (!pid || pid === currentPid || !isPidRunning(pid)) continue;

        // Skip any ai-helper / aih CLI executions
        if (cmd.includes("bin/cli.js") || cmd.includes("bin\\cli.js") || /\baih(\.exe)?\b/i.test(cmd)) {
          continue;
        }

        let startedAt;
        if (item.CreationDate) {
          const match = String(item.CreationDate).match(/\/Date\((\d+)\)\//);
          if (match) {
            startedAt = new Date(parseInt(match[1], 10)).toISOString();
          } else {
            const d = new Date(item.CreationDate);
            if (!isNaN(d.getTime())) {
              startedAt = d.toISOString();
            }
          }
        }

        const ports = pidToPorts[pid] || [];

        // 1. pxpipe
        if (cmd.includes("pxpipe-proxy")) {
          if (!discovered.pxpipe || (item.Name && item.Name.toLowerCase() === "node.exe" && cmd.includes("cli.js"))) {
            const webPort = ports.find(p => p > 1000 && p < 65000) || (discovered.pxpipe?.port);
            discovered.pxpipe = {
              pid,
              command: cmd,
              startedAt,
              port: webPort,
              url: webPort ? `http://localhost:${webPort}` : "http://localhost:47821",
            };
          }
        }

        // 2. ocx
        if (cmd.includes("ocx.mjs") || cmd.includes("opencodex") || (cmd.includes("ocx start") && !cmd.includes("aih "))) {
          const webPort = ports.find(p => p === 10100 || (p > 1000 && p < 65000));
          if (!discovered.ocx || cmd.includes("ocx.mjs start")) {
            discovered.ocx = {
              pid,
              command: cmd,
              startedAt,
              port: webPort || 10100,
              url: `http://localhost:${webPort || 10100}`,
            };
          }
        }

        // 3. agentmemory (daemon / iii-engine only, strictly exclude MCP stdio shims)
        const isMcpShim = cmd.includes("agentmemory-mcp") || cmd.includes("@agentmemory/mcp") || cmd.includes("agentmemory mcp");

        if (
          !isMcpShim &&
          (cmd.includes("@agentmemory/agentmemory") ||
            cmd.includes("agentmemory\\dist\\cli.mjs") ||
            cmd.includes("agentmemory/dist/cli.mjs") ||
            cmd.includes("iii-config.yaml") ||
            cmd.includes("iii.exe") ||
            (cmd.includes("agentmemory") && !cmd.includes("mcp") && !cmd.includes("aih ")))
        ) {
          const webPort = ports.find(p => p === 3113 || p === 43210 || (p > 1000 && p < 65000));
         if (!discovered.agentmemory || cmd.includes("agentmemory/agentmemory") || cmd.includes("dist\\cli.mjs")) {
           discovered.agentmemory = {
             pid,
             command: cmd,
             startedAt,
             port: webPort || 3113,
             url: `http://localhost:${webPort || 3113}`,
           };
         }
       }

        // 4. headroom
        if (cmd.includes("headroom proxy") || (cmd.includes("headroom") && !cmd.includes("aih "))) {
          const webPort = ports.find(p => p === 8787 || (p > 1000 && p < 65000));
          if (!discovered.headroom || cmd.includes("headroom proxy")) {
            discovered.headroom = {
              pid,
              command: cmd,
              startedAt,
              port: webPort || 8787,
              url: `http://localhost:${webPort || 8787}/dashboard`,
            };
          }
        }
     }

     for (const p of procList) {
       const ports = pidToPorts[p.ProcessId] || [];
       if (ports.length > 0) {
         if (ports.includes(47821) && discovered.pxpipe) {
           discovered.pxpipe.url = "http://localhost:47821";
         }
         if (ports.includes(10100) && discovered.ocx) {
           discovered.ocx.url = "http://localhost:10100";
         }
         if (ports.includes(3113) && discovered.agentmemory) {
           discovered.agentmemory.url = "http://localhost:3113";
         }
          if (ports.includes(8787) && discovered.headroom) {
            discovered.headroom.url = "http://localhost:8787/dashboard";
          }
       }
     }
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
