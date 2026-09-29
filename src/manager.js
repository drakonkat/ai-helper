import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeProxyOptions } from "./proxy.js";
import { SERVICES, SERVICE_IDS, SERVICE_PACKAGES, APP_REPOSITORY_URL } from "./config.js";
import { compareVersions, getServiceVersions } from "./utils/versions.js";
import { installServiceUpdate, serviceStartCommand } from "./service-updates.js";
import { configureCodexForProxy } from "./codex-routing.js";
import { ensureDir, getAihDir, getLogsDir, getServiceLogPath, getStateFilePath } from "./utils/path.js";
import {
  isPidRunning,
  killProcessTree,
  spawnDetachedProcess,
  discoverRunningProcesses,
  openBrowser,
  sleep,
  execCommand,
  findPidsListeningOnPorts,
} from "./utils/process.js";
import { formatBytes, formatUptime, gray, red, yellow, green, cyan } from "./utils/format.js";

export class ServiceManager {
  updatesInProgress = new Set();

  /** Explicit update: fresh check, stop if needed, install, verify, restore runtime state. */
  async updateService(serviceId, { getVersions = getServiceVersions, install = installServiceUpdate } = {}) {
    if (!Object.hasOwn(SERVICE_PACKAGES, serviceId)) {
      return { success: false, message: serviceId === "proxy"
        ? "The built-in proxy is part of ai-helper; update ai-helper itself to update it."
        : `Unknown service '${serviceId}'. Available: ${SERVICE_IDS.join(", ")}` };
    }
    if (this.updatesInProgress.has(serviceId)) {
      return { success: false, message: `An update for '${serviceId}' is already in progress` };
    }
    this.updatesInProgress.add(serviceId);
    let stopped = false;
    let updated = false;
    let details = {};
    const restart = async () => {
      try { return await this.startService(serviceId); }
      catch (error) { return { success: false, message: error.message }; }
    };
    const rememberLaunchVersion = version => {
      if (!SERVICE_PACKAGES[serviceId].npx) return;
      const state = this.readState();
      const current = state.services[serviceId];
      if (current.launchVersion === version) return;
      current.launchVersion = version;
      current.command = serviceStartCommand(serviceId, current);
      this.saveState(state);
    };
    try {
      const state = await this.syncState();
      const current = state.services[serviceId] || { id: serviceId, status: "stopped" };
      const before = (await getVersions([current]))[serviceId];
      const latestVersion = before?.latestVersion;
      details = { previousVersion: before?.version ?? null, latestVersion: latestVersion ?? null };
      if (compareVersions(latestVersion, latestVersion) === null) {
        return { ...details, success: false, message: `Cannot determine the latest version of '${serviceId}'; no changes made. Check your registry connection and retry.` };
      }
      const comparison = compareVersions(before.version, latestVersion);
      if (comparison !== null && comparison >= 0) {
        // A manual npm upgrade may have overtaken a previous explicit npx pin.
        // Do not report current and then launch that old pin on the next start.
        rememberLaunchVersion(before.version);
        return { ...details, success: true, updated: false, alreadyUpToDate: true, version: before.version,
          message: `'${serviceId}' is already up to date (${before.version})` };
      }
      if (current.status === "running") {
        // stopService can throw after the process exited (e.g. state write
        // failure). A guarded startService is safe even if it remains running.
        stopped = true;
        const result = await this.stopService(serviceId);
        if (!result.success) throw new Error(`Update aborted: ${result.message}`);
        if ((await this.syncState()).services[serviceId]?.status === "running") {
          stopped = false; // Do not spawn a duplicate if an external supervisor revived it.
          return { ...details, success: false, message: `Update aborted: '${serviceId}' is still running; stop its external supervisor and retry.` };
        }
      }
      const installed = await install(serviceId);
      if (!installed.success) throw new Error(`${installed.message}. See 'aih logs ${serviceId}'.`);
      // Probe PATH, not the old daemon's health endpoint. Exit 0 alone is not
      // evidence: native updaters can decline unsupported install methods.
      const disk = (await getVersions([{ ...current, status: "stopped", pid: undefined }]))[serviceId];
      const installedComparison = compareVersions(disk?.version, latestVersion);
      if (installedComparison === null || installedComparison < 0) {
        throw new Error(`Installer completed, but '${serviceId}' on PATH is ${disk?.version || "unverified"}, expected ${latestVersion}. Check the installation/PATH and 'aih logs ${serviceId}'`);
      }
      updated = true;
      details.version = disk.version;
      rememberLaunchVersion(disk.version);
      let started;
      if (stopped) {
        stopped = false; // Only one restart attempt, including on startup failure.
        started = await restart();
        if (!started.success) return { ...details, success: false, updated, restarted: false,
          message: `'${serviceId}' updated to ${disk.version}, but restart failed: ${started.message}` };
        const running = (await this.syncState()).services[serviceId];
        if (running?.status !== "running" || !running.pid) {
          return { ...details, success: false, updated, restarted: false, codexConfig: started.codexConfig,
            message: `'${serviceId}' updated, but exited after restart; check 'aih logs ${serviceId}'` };
        }
        const live = (await getVersions([running]))[serviceId];
        const liveComparison = compareVersions(live?.version, latestVersion);
        if (liveComparison === null || liveComparison < 0) {
          return { ...details, success: false, updated, restarted: true, codexConfig: started.codexConfig,
            message: `'${serviceId}' restarted, but its running version is ${live?.version || "unverified"} (expected ${latestVersion}); check 'aih logs ${serviceId}'` };
        }
        details.version = live.version;
      }
      return { ...details, success: true, updated, restarted: Boolean(started), codexConfig: started?.codexConfig,
        message: `'${serviceId}' updated to ${details.version}${started ? " and restarted" : " (left stopped)"}` };
    } catch (error) {
      const recovery = stopped ? await restart() : null;
      return { ...details, success: false, updated, restarted: Boolean(recovery?.success && !recovery.alreadyRunning), codexConfig: recovery?.codexConfig,
        message: `Update failed: ${error.message}${recovery ? recovery.success
          ? recovery.alreadyRunning ? ". Service is still running." : ". Service restarted after the failure (package rollback is not guaranteed)."
          : `. Recovery restart failed: ${recovery.message}` : ""}` };
    } finally {
      this.updatesInProgress.delete(serviceId);
    }
  }

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

    // Discover active verified daemon processes from OS
    const discovered = await discoverRunningProcesses({ knownServices: state.services });

    for (const id of Object.keys(state.services)) {
      const svc = state.services[id];
      const info = discovered[id];

      if (info && info.pid && isPidRunning(info.pid)) {
        // Confirmed active service daemon discovered in OS
        if (svc.status !== "running" || svc.pid !== info.pid) {
          svc.status = "running";
          svc.pid = info.pid;
          svc.startedAt = info.startedAt || svc.startedAt || new Date().toISOString();
          svc.url = info.url || SERVICES[id]?.defaultUrl;
          needsSave = true;
        } else if (info.url && svc.url !== info.url) {
          svc.url = info.url;
          needsSave = true;
        }
      } else if (svc.status === "running" && svc.pid && isPidRunning(svc.pid)) {
        // Process spawned by aih is still actively running in background
        if (!svc.url) {
          svc.url = SERVICES[id]?.defaultUrl;
          needsSave = true;
        }
      } else {
        // Not running and not discovered
        if (svc.status === "running" || svc.pid !== undefined) {
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
    const targets = targetServices && targetServices.length > 0 ? targetServices : Object.keys(state.services);

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
        dashboardUrl: id === "proxy" || url === "-" ? null : url,
        repositoryUrl: id === "proxy" ? APP_REPOSITORY_URL : def.repositoryUrl || null,
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
      const url = svc.dashboardUrl;
      if (url && url !== "-") {
        openBrowser(url);
        opened.push({ id: svc.id, name: svc.name, url, status: svc.status });
      }
    }

    return opened;
  }

  /** Repository metadata is static; opening it does not require process discovery. */
  async openRepository(targetServices) {
    const targets = targetServices?.length ? targetServices : Object.keys(this.readState().services);
    const opened = [];
    for (const id of targets) {
      const url = id === "proxy" ? APP_REPOSITORY_URL : SERVICES[id]?.repositoryUrl;
      if (!url) continue;
      openBrowser(url);
      opened.push({ id, name: SERVICES[id]?.name || id, url });
    }
    return opened;
  }

  async configureCodexProxy(options = {}) {
    try {
      return await configureCodexForProxy(this.loadState(), { ...options, readState: () => this.loadState() });
    } catch {
      // Config I/O must not tear down a proxy that has already reported ready.
      return { status: "warning", message: "Service started, but Codex configuration could not be updated safely." };
    }
  }

  /**
   * Starts a single service by ID.
   */
  async startService(serviceId, options) {
    if (serviceId === "proxy") return this.startProxyService(options);
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
        ...(serviceId === "ocx" ? { codexConfig: await this.configureCodexProxy({ waitForOcx: true }) } : {}),
      };
    }

    const logPath = getServiceLogPath(serviceId);
    const command = serviceStartCommand(serviceId, current);
    const { pid } = spawnDetachedProcess(command, logPath, {
      env: def.env,
      cwd: def.workingDir,
    });

    state.services[serviceId] = {
      id: def.id,
      name: def.name,
      command,
      ...(current?.launchVersion ? { launchVersion: current.launchVersion } : {}),
      status: "running",
      pid,
      startedAt: new Date().toISOString(),
      url: def.defaultUrl,
    };
   this.saveState(state);

   // Wait a moment for background boot
   await sleep(2000);

   // Re-sync with OS
    const updatedState = await this.syncState();
    const updatedSvc = updatedState.services[serviceId];

    if (!updatedSvc || updatedSvc.status !== "running" || !updatedSvc.pid || !isPidRunning(updatedSvc.pid)) {
      return {
        success: false,
        message: `Service '${serviceId}' failed to start or exited immediately. Check logs with 'aih logs ${serviceId}'`,
        pid,
      };
    }

    return {
      success: true,
      message: `Service '${serviceId}' started successfully (PID: ${updatedSvc.pid})`,
      pid: updatedSvc.pid,
      url: updatedSvc.url || def.defaultUrl,
      ...(serviceId === "ocx" ? { codexConfig: await this.configureCodexProxy({ waitForOcx: true }) } : {}),
    };
  }

  async startProxyService(options) {
    const state = this.loadState();
    const current = state.services.proxy;
    const config = normalizeProxyOptions({
      ...current?.proxyOptions,
      ...(state.config?.pxpipeModels !== undefined ? { models: state.config.pxpipeModels } : {}),
      ...options,
    });
    if (current?.status === "running" && isPidRunning(current.pid)) {
      if (JSON.stringify(config) !== JSON.stringify(current.proxyOptions)) {
        throw new Error("Proxy is already running with different options; use 'aih restart proxy <upstream> [options]'");
      }
      return { success: true, alreadyRunning: true, pid: current.pid, url: current.url,
        codexConfig: await this.configureCodexProxy() };
    }
    ensureDir(getLogsDir());
    const compiled = typeof Bun !== "undefined" && /^(?:\/\$bunfs\/|[A-Z]:\/~BUN\/)/i.test(Bun.main);
    let workerPath = fileURLToPath(new URL("./proxy-worker.js", import.meta.url));
    if (compiled) {
      if (typeof AIH_PROXY_WORKER_SOURCE === "undefined") throw new Error("Rebuild with 'bun run build' to include the proxy worker");
      workerPath = join(getAihDir(), "proxy-worker.mjs");
      writeFileSync(workerPath, AIH_PROXY_WORKER_SOURCE);
    }
    let nodeExecutable = process.execPath;
    if (typeof Bun !== "undefined") {
      // NVM shims can drop IPC handles and expose the launcher's PID. Spawn Node itself.
      try {
        nodeExecutable = execFileSync("node", ["-p", "process.execPath"], {
          encoding: "utf8", windowsHide: true, timeout: 5000,
        }).trim();
      } catch (error) {
        throw new Error(`Cannot resolve Node.js 20.19+ on PATH: ${error.message}`);
      }
    }
    const fd = openSync(getServiceLogPath("proxy"), "a");
    let child;
    try {
      // Bun's HTTP/ws shims omit handshake events and cancellation; always use Node.
      child = spawn(nodeExecutable, [workerPath], {
        detached: true, windowsHide: true, stdio: ["ignore", fd, fd, "ipc"],
        env: { ...process.env, AIH_PROXY_OPTIONS: JSON.stringify(config) },
      });
    } finally { closeSync(fd); }
    try {
      const ready = await new Promise((resolveReady, reject) => {
        const timeout = setTimeout(() => finish(new Error("Proxy startup timed out; check 'aih logs proxy'")), 15000);
        const onError = error => finish(error.code === "ENOENT" ? new Error("Proxy requires Node.js 20.19+ on PATH") : error);
        const onExit = code => finish(new Error(`Proxy exited during startup (${code}); check 'aih logs proxy'`));
        const onMessage = message => {
          if (message.error) finish(new Error(message.error));
          else if (message.url) finish(null, message);
        };
        const finish = (error, result) => {
          clearTimeout(timeout);
          child.off("error", onError).off("exit", onExit).off("message", onMessage);
          error ? reject(error) : resolveReady(result);
        };
        child.once("error", onError).once("exit", onExit).on("message", onMessage);
      });
      const updated = this.loadState();
      updated.services.proxy = {
        id: "proxy", name: "proxy", command: `aih start proxy ${config.upstream}`,
        status: "running", pid: child.pid, startedAt: new Date().toISOString(),
        url: ready.url, proxyOptions: config,
      };
      this.saveState(updated);
      return { success: true, pid: child.pid, url: ready.url, codexConfig: await this.configureCodexProxy() };
    } catch (error) {
      if (child.pid) await killProcessTree(child.pid);
      throw error;
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
    }
  }

  /**
   * Starts all or selected services.
   */
  async startServices(serviceIds) {
    const targets = serviceIds && serviceIds.length > 0 ? serviceIds : Object.keys(this.readState().services);
    const results = {};

    for (const id of targets) {
      results[id] = await this.startService(id);
    }

    return results;
  }

  /**
   * Stops a single service cleanly, executing stop commands and clearing ports/workers.
   */
  async stopService(serviceId) {
    const def = SERVICES[serviceId];
    const state = await this.syncState();
    const current = state.services[serviceId];

    if (!current) return { success: false, message: `Unknown service '${serviceId}'` };

    // 1. If service has a dedicated graceful stopCommand, run it
    if (def?.stopCommand) {
      const isWin = process.platform === "win32";
      if (isWin) {
        await execCommand("cmd.exe", ["/c", def.stopCommand]);
      } else {
        await execCommand("sh", ["-c", def.stopCommand]);
      }
      await sleep(400);
    }

    // 2. Kill recorded process tree if still active
    if (current && current.pid && isPidRunning(current.pid)) {
      const result = await killProcessTree(current.pid);
      if (!result.success) return result;
    }

    // 3. Clean up any remaining processes holding the service's ports
    if (def?.ports && def.ports.length > 0) {
      const portPids = await findPidsListeningOnPorts(def.ports);
      for (const p of portPids) {
        if (isPidRunning(p)) {
          await killProcessTree(p);
        }
      }
    }

    // 4. Update state to stopped
    state.services[serviceId].status = "stopped";
    state.services[serviceId].pid = undefined;
    state.services[serviceId].startedAt = undefined;
    this.saveState(state);

    return {
      success: true,
      message: `Service '${serviceId}' stopped cleanly`,
    };
  }

  /**
   * Stops all or selected services.
   */
  async stopServices(serviceIds) {
    const targets = serviceIds && serviceIds.length > 0 ? serviceIds : Object.keys(this.readState().services);
    const results = {};

    for (const id of targets) {
      results[id] = await this.stopService(id);
    }

    return results;
  }

  /**
   * Restarts a single service by ID.
   */
  async restartService(serviceId, options) {
    if (serviceId === "proxy") {
      const current = this.readState().services.proxy;
      normalizeProxyOptions({ ...current?.proxyOptions, ...options });
      if (!current) return this.startService(serviceId, options);
    }
    const stopped = await this.stopService(serviceId);
    if (!stopped.success) return stopped;
    await sleep(600);
    return await this.startService(serviceId, options);
  }

  /**
   * Restarts all or selected services.
   */
  async restartServices(serviceIds) {
    const targets = serviceIds && serviceIds.length > 0 ? serviceIds : Object.keys(this.readState().services);
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
