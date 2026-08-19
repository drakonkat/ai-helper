import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { SERVICES, SERVICE_IDS } from "./config.js";
import { ensureDir, getAihDir, getLogsDir, getServiceLogPath, getStateFilePath } from "./utils/path.js";
import { isPidRunning, killProcessTree, spawnDetachedProcess, discoverRunningProcesses, openBrowser, sleep } from "./utils/process.js";
import { formatBytes, formatUptime, gray, red, yellow, green, cyan } from "./utils/format.js";

export class ServiceManager {
  /**
   * Reads raw state from disk without discovery.
   */
  readState() {
    ensureDir(getAihDir());
    const statePath = getStateFilePath();
    let state = {
      services: {},
      updatedAt: new Date().toISOString(),
    };

    if (existsSync(statePath)) {
      try {
        const raw = readFileSync(statePath, "utf-8");
        state = JSON.parse(raw);
      } catch {
        state = { services: {}, updatedAt: new Date().toISOString() };
      }
    }

    for (const id of SERVICE_IDS) {
      const def = SERVICES[id];
      if (!state.services[id]) {
        state.services[id] = {
          id: def.id,
          name: def.name,
          command: def.command,
          status: "stopped",
          url: def.defaultUrl,
        };
      }
    }

    return state;
  }

  /**
   * Synchronizes state with active OS processes and auto-discovers externally launched services.
   */
  async syncState() {
    const state = this.readState();
    let needsSave = false;

    // 1. Verify liveness of currently recorded PIDs
    for (const id of Object.keys(state.services)) {
      const svc = state.services[id];
      if (svc.status === "running") {
        if (!svc.pid || !isPidRunning(svc.pid)) {
          svc.status = "stopped";
          svc.pid = undefined;
          svc.startedAt = undefined;
          needsSave = true;
        }
      }
    }

    // 2. Discover externally started processes
    const discovered = await discoverRunningProcesses();
    for (const id of Object.keys(discovered)) {
      const info = discovered[id];
      const svc = state.services[id];
      if (svc) {
        if (svc.status !== "running" || !svc.pid || !isPidRunning(svc.pid)) {
          svc.status = "running";
          svc.pid = info.pid;
          svc.startedAt = info.startedAt || new Date().toISOString();
          svc.url = info.url || SERVICES[id]?.defaultUrl;
          needsSave = true;
        } else if (info.url && svc.url !== info.url) {
          svc.url = info.url;
          needsSave = true;
        }
      }
    }

    if (needsSave) {
      this.saveState(state);
    }

    return state;
  }

  /**
   * Synchronous load with PID liveness check.
   */
  loadState() {
    const state = this.readState();
    let needsSave = false;

    for (const id of Object.keys(state.services)) {
      const svc = state.services[id];
      if (svc.status === "running") {
        if (!svc.pid || !isPidRunning(svc.pid)) {
          svc.status = "stopped";
          svc.pid = undefined;
          svc.startedAt = undefined;
          needsSave = true;
        }
      }
    }

    if (needsSave) {
      this.saveState(state);
    }

    return state;
  }

  /**
   * Saves state to disk.
   */
  saveState(state) {
    ensureDir(getAihDir());
    state.updatedAt = new Date().toISOString();
    writeFileSync(getStateFilePath(), JSON.stringify(state, null, 2), "utf-8");
  }

  /**
   * Gets current status for all or specific services (with auto-discovery and URL resolution).
   */
  async getStatus(targetServices) {
    const state = await this.syncState();
    const targets = targetServices && targetServices.length > 0 ? targetServices : SERVICE_IDS;

    return targets.map(id => {
      const def = SERVICES[id] || {
        id,
        name: id,
        command: "custom",
        description: "Custom service",
        defaultUrl: "http://localhost",
      };
      const svcState = state.services[id] || {
        id,
        name: def.name,
        command: def.command,
        status: "stopped",
        url: def.defaultUrl,
      };

      const logPath = getServiceLogPath(id);
      let logSize = 0;
      if (existsSync(logPath)) {
        try {
          logSize = statSync(logPath).size;
        } catch {}
      }

      const url = svcState.url || def.defaultUrl || "-";

      return {
        ...svcState,
        description: def.description,
        uptime: svcState.status === "running" ? formatUptime(svcState.startedAt) : "-",
        url,
        logPath,
        logSize,
      };
    });
  }

  /**
   * Opens service dashboard in browser.
   */
  async openDashboard(targetServices) {
    const statuses = await this.getStatus(targetServices);
    const opened = [];

    for (const svc of statuses) {
      const url = svc.url || SERVICES[svc.id]?.defaultUrl;
      if (url && url !== "-") {
        openBrowser(url);
        opened.push({ id: svc.id, name: svc.name, url, status: svc.status });
      }
    }

    return opened;
  }

  /**
   * Starts a single service by ID.
   */
  async startService(serviceId) {
    const def = SERVICES[serviceId];
    if (!def) {
      return { success: false, message: `Unknown service '${serviceId}'. Available: ${SERVICE_IDS.join(", ")}` };
    }

    const state = await this.syncState();
    const current = state.services[serviceId];

    if (current && current.status === "running" && current.pid && isPidRunning(current.pid)) {
      return {
        success: true,
        message: `Service '${serviceId}' is already running (PID: ${current.pid})`,
        pid: current.pid,
        alreadyRunning: true,
        url: current.url || def.defaultUrl,
      };
    }

    const logPath = getServiceLogPath(serviceId);
    const { pid } = spawnDetachedProcess(def.command, logPath, {
      env: def.env,
      cwd: def.workingDir,
    });

    state.services[serviceId] = {
      id: def.id,
      name: def.name,
      command: def.command,
      status: "running",
      pid,
      startedAt: new Date().toISOString(),
      url: def.defaultUrl,
    };
    this.saveState(state);

    await sleep(600);

    if (!isPidRunning(pid)) {
      state.services[serviceId].status = "error";
      state.services[serviceId].pid = undefined;
      state.services[serviceId].lastError = "Process exited immediately after spawn";
      this.saveState(state);

      return {
        success: false,
        message: `Service '${serviceId}' exited immediately. Check logs with 'aih logs ${serviceId}'`,
        pid,
      };
    }

    return {
      success: true,
      message: `Service '${serviceId}' started successfully (PID: ${pid})`,
      pid,
      url: def.defaultUrl,
    };
  }

  /**
   * Starts all or selected services.
   */
  async startServices(serviceIds) {
    const targets = serviceIds && serviceIds.length > 0 ? serviceIds : SERVICE_IDS;
    const results = {};

    for (const id of targets) {
      results[id] = await this.startService(id);
    }

    return results;
  }

  /**
   * Stops a single service by ID.
   */
  async stopService(serviceId) {
    const state = await this.syncState();
    const current = state.services[serviceId];

    if (!current || current.status !== "running" || !current.pid) {
      return { success: true, message: `Service '${serviceId}' is not running` };
    }

    const pidToKill = current.pid;
    const killResult = await killProcessTree(pidToKill);

    state.services[serviceId].status = "stopped";
    state.services[serviceId].pid = undefined;
    state.services[serviceId].startedAt = undefined;
    this.saveState(state);

    return {
      success: killResult.success,
      message: killResult.success
        ? `Service '${serviceId}' stopped (PID: ${pidToKill})`
        : `Failed to stop service '${serviceId}': ${killResult.message}`,
    };
  }

  /**
   * Stops all or selected services.
   */
  async stopServices(serviceIds) {
    const targets = serviceIds && serviceIds.length > 0 ? serviceIds : SERVICE_IDS;
    const results = {};

    for (const id of targets) {
      results[id] = await this.stopService(id);
    }

    return results;
  }

  /**
   * Restarts a single service by ID.
   */
  async restartService(serviceId) {
    await this.stopService(serviceId);
    await sleep(400);
    return await this.startService(serviceId);
  }

  /**
   * Restarts all or selected services.
   */
  async restartServices(serviceIds) {
    const targets = serviceIds && serviceIds.length > 0 ? serviceIds : SERVICE_IDS;
    const results = {};

    for (const id of targets) {
      results[id] = await this.restartService(id);
    }

    return results;
  }

  /**
   * Displays or follows logs for a service.
   */
  async showLogs(serviceId, lines = 50, follow = false) {
    const logPath = getServiceLogPath(serviceId);
    if (!existsSync(logPath)) {
      console.log(yellow(`[aih] No log file exists yet for '${serviceId}' at: ${logPath}`));
      return;
    }

    const content = readFileSync(logPath, "utf-8");
    const allLines = content.split(/\r?\n/);
    const tailLines = allLines.slice(-lines);

    console.log(gray(`[aih] Displaying last ${tailLines.length} lines of ${logPath}:\n`));
    for (const line of tailLines) {
      console.log(line);
    }

    if (!follow) return;

    console.log(gray(`\n[aih] Following log output (Press Ctrl+C to stop)...\n`));

    let lastSize = statSync(logPath).size;
    let running = true;

    process.on("SIGINT", () => {
      running = false;
      console.log(gray("\n[aih] Stopped log following."));
      process.exit(0);
    });

    while (running) {
      await sleep(400);
      try {
        if (!existsSync(logPath)) continue;
        const currentSize = statSync(logPath).size;
        if (currentSize > lastSize) {
          const fd = openSync(logPath, "r");
          const buffer = Buffer.alloc(currentSize - lastSize);
          readSync(fd, buffer, 0, buffer.length, lastSize);
          closeSync(fd);
          process.stdout.write(buffer.toString("utf-8"));
          lastSize = currentSize;
        } else if (currentSize < lastSize) {
          lastSize = currentSize;
        }
      } catch {}
    }
  }
}

export const manager = new ServiceManager();

