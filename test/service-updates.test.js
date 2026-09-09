import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SERVICES } from "../src/config.js";
import { ServiceManager } from "../src/manager.js";
import { installServiceUpdate, serviceStartCommand, serviceUpdateInvocation } from "../src/service-updates.js";

// Every lifecycle/registry/installer dependency is replaced: no real services,
// processes, package managers, state files, or network requests are touched.
function fixture({ id = "ocx", status = "stopped", versions = ["2.42.0", "2.49.0", "2.49.0"], latest = "2.49.0" } = {}) {
  const manager = new ServiceManager();
  const calls = [];
  const probes = [];
  let state = { services: { [id]: { id, status, pid: status === "running" ? 123 : undefined } } };
  manager.syncState = async () => { calls.push("sync"); return structuredClone(state); };
  manager.readState = () => { calls.push("read"); return structuredClone(state); };
  manager.saveState = value => { calls.push("save"); state = structuredClone(value); };
  manager.stopService = async target => {
    expect(target).toBe(id);
    calls.push("stop");
    state.services[id].status = "stopped";
    state.services[id].pid = undefined;
    return { success: true };
  };
  manager.startService = async target => {
    expect(target).toBe(id);
    calls.push("start");
    state.services[id].status = "running";
    state.services[id].pid = 456;
    return { success: true, codexConfig: { status: "unchanged" } };
  };
  const options = {
    getVersions: async statuses => {
      calls.push("versions");
      probes.push(structuredClone(statuses));
      return { [id]: { version: versions[probes.length - 1], latestVersion: latest } };
    },
    install: async target => { expect(target).toBe(id); calls.push("install"); return { success: true }; },
  };
  return { manager, options, calls, probes, state: () => structuredClone(state), run: () => manager.updateService(id, options) };
}

describe("service installer command allowlist", () => {
  for (const [id, name] of [["ocx", "@bitkyc08/opencodex"], ["pxpipe", "pxpipe-proxy"], ["agentmemory", "@agentmemory/agentmemory"]]) {
    it(`selects a fixed npm latest command for ${id} on Unix and Windows`, () => {
      for (const platform of ["linux", "darwin"]) {
        expect(serviceUpdateInvocation(id, platform)).toEqual({
          command: "npm", args: ["install", "--global", `${name}@latest`, "--no-audit", "--no-fund"],
        });
      }
      expect(serviceUpdateInvocation(id, "win32")).toEqual({
        command: "cmd.exe", args: ["/d", "/s", "/c", `npm install --global ${name}@latest --no-audit --no-fund`],
      });
    });
  }

  it("uses Headroom's environment-aware noninteractive updater instead of arbitrary pip", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      expect(serviceUpdateInvocation("headroom", platform)).toEqual({ command: "headroom", args: ["update", "--yes"] });
    }
  });

  it("rejects proxy, unknown identifiers, inherited keys, and shell text before spawning", () => {
    for (const id of ["proxy", "missing", "constructor", "__proto__", "ocx & whoami", "../ocx"]) {
      expect(() => serviceUpdateInvocation(id)).toThrow("cannot be updated separately");
      expect(() => installServiceUpdate(id, { spawnImpl: () => { throw new Error("must not spawn"); } })).toThrow("cannot be updated separately");
    }
  });
});

describe("pinned npx launch commands", () => {
  it("pins npx services to the explicitly verified installation version", () => {
    expect(serviceStartCommand("pxpipe", { launchVersion: " v1.2.3 " })).toBe("npx --yes pxpipe-proxy@1.2.3");
    expect(serviceStartCommand("agentmemory", { launchVersion: "0.9.30-rc.1+build.2" })).toBe("npx --yes @agentmemory/agentmemory@0.9.30-rc.1+build.2");
  });

  it("ignores absent, malformed, and shell-injection launch versions", () => {
    for (const id of ["pxpipe", "agentmemory"]) {
      expect(serviceStartCommand(id)).toBe(SERVICES[id].command);
      for (const launchVersion of [null, 12, "latest", "1.2", "1.2.3 && whoami", "1.2.3\nwhoami", "1.2.3;whoami", "$(whoami)", "1.2.3\u001b[0m"]) {
        expect(serviceStartCommand(id, { launchVersion })).toBe(SERVICES[id].command);
      }
    }
  });

  it("does not change non-npx commands", () => {
    for (const id of ["ocx", "headroom"]) expect(serviceStartCommand(id, { launchVersion: "2.49.0" })).toBe(SERVICES[id].command);
  });
});

describe("ServiceManager.updateService", () => {
  it("rejects unsupported services before any state, registry, or installer I/O", async () => {
    const f = fixture();
    for (const id of ["proxy", "unknown", "constructor", "__proto__", "ocx & whoami"]) {
      const result = await f.manager.updateService(id, f.options);
      expect(result.success).toBe(false);
      expect(result.message).toContain(id === "proxy" ? "update ai-helper itself" : "Unknown service");
    }
    expect(f.calls).toEqual([]);
    expect(f.manager.updatesInProgress.size).toBe(0);
  });

  it("leaves an up-to-date or newer running version untouched", async () => {
    for (const version of ["2.49.0", "2.50.0"]) {
      const f = fixture({ status: "running", versions: [version] });
      expect(await f.run()).toMatchObject({ success: true, updated: false, alreadyUpToDate: true, version });
      expect(f.calls).toEqual(["sync", "versions"]);
      expect(f.state().services.ocx.status).toBe("running");
      expect(f.manager.updatesInProgress.size).toBe(0);
    }
  });

  it("realigns a stale npx pin when the stopped global installation is already current", async () => {
    for (const id of ["pxpipe", "agentmemory"]) {
      const f = fixture({ id, versions: ["2.49.0"] });
      const state = f.state();
      state.services[id].launchVersion = "2.42.0";
      state.services[id].command = serviceStartCommand(id, { launchVersion: "2.42.0" });
      f.manager.saveState(state);
      f.calls.length = 0;
      expect(await f.run()).toMatchObject({ success: true, updated: false, alreadyUpToDate: true, version: "2.49.0" });
      expect(f.calls).toEqual(["sync", "versions", "read", "save"]);
      expect(f.state().services[id]).toMatchObject({ status: "stopped", launchVersion: "2.49.0", command: serviceStartCommand(id, { launchVersion: "2.49.0" }) });
    }
  });

  it("makes no changes if the latest registry version is absent or malformed", async () => {
    for (const latest of [null, "", "latest", "2.49", "2.49.0;whoami"]) {
      const f = fixture({ status: "running", latest });
      const result = await f.run();
      expect(result.success).toBe(false);
      expect(result.message).toContain("no changes made");
      expect(f.calls).toEqual(["sync", "versions"]);
      expect(f.manager.updatesInProgress.size).toBe(0);
    }
  });

  it("handles an offline thrown probe without stopping or installing", async () => {
    const f = fixture({ status: "running" });
    f.options.getVersions = async () => { f.calls.push("versions"); throw new Error("registry offline"); };
    expect(await f.run()).toMatchObject({ success: false, updated: false, restarted: false, message: "Update failed: registry offline" });
    expect(f.calls).toEqual(["sync", "versions"]);
    expect(f.manager.updatesInProgress.size).toBe(0);
  });

  it("installs and verifies a stopped service without starting or stopping it", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ success: true, updated: true, restarted: false, previousVersion: "2.42.0", latestVersion: "2.49.0", version: "2.49.0" });
    expect(f.calls).toEqual(["sync", "versions", "install", "versions"]);
    expect(f.probes[1][0]).toMatchObject({ id: "ocx", status: "stopped", pid: undefined });
    expect(f.state().services.ocx.status).toBe("stopped");
    expect(f.manager.updatesInProgress.size).toBe(0);
  });

  it("can install when the previous installed version is unknown", async () => {
    const f = fixture({ versions: [null, "2.49.0"] });
    expect(await f.run()).toMatchObject({ success: true, updated: true, previousVersion: null, version: "2.49.0" });
  });

  it("accepts a newer installation if latest changes during the update", async () => {
    const f = fixture({ versions: ["2.42.0", "2.50.0"] });
    expect(await f.run()).toMatchObject({ success: true, updated: true, latestVersion: "2.49.0", version: "2.50.0" });
  });

  it("stops, installs, checks disk, restarts, and verifies the live version in order", async () => {
    const f = fixture({ status: "running" });
    expect(await f.run()).toMatchObject({ success: true, updated: true, restarted: true, version: "2.49.0", codexConfig: { status: "unchanged" } });
    expect(f.calls).toEqual(["sync", "versions", "stop", "sync", "install", "versions", "start", "sync", "versions"]);
    expect(f.probes.map(p => p[0].status)).toEqual(["running", "stopped", "running"]);
    expect(f.probes[1][0].pid).toBeUndefined();
    expect(f.probes[2][0].pid).toBe(456);
  });

  it("persists a verified npx pin before restarting and preserves stopped state", async () => {
    for (const id of ["pxpipe", "agentmemory"]) {
      for (const status of ["running", "stopped"]) {
        const f = fixture({ id, status });
        expect(await f.run()).toMatchObject({ success: true, updated: true, restarted: status === "running" });
        expect(f.state().services[id]).toMatchObject({ status, launchVersion: "2.49.0", command: serviceStartCommand(id, { launchVersion: "2.49.0" }) });
        expect(f.calls.indexOf("save")).toBeGreaterThan(f.calls.indexOf("install"));
        if (status === "running") expect(f.calls.indexOf("save")).toBeLessThan(f.calls.indexOf("start"));
        else expect(f.calls).not.toContain("start");
      }
    }
  });

  it("aborts before installation and guards recovery when stop fails but the process remains running", async () => {
    const f = fixture({ status: "running" });
    f.manager.stopService = async () => { f.calls.push("stop"); return { success: false, message: "permission denied" }; };
    f.manager.startService = async () => { f.calls.push("start"); return { success: true, alreadyRunning: true }; };
    const result = await f.run();
    expect(result).toMatchObject({ success: false, updated: false, restarted: false });
    expect(result.message).toContain("Update aborted: permission denied");
    expect(result.message).toContain("Service is still running");
    expect(f.calls).toEqual(["sync", "versions", "stop", "start"]);
    expect(f.manager.updatesInProgress.size).toBe(0);
  });

  it("recovers when stop throws after stopping the process without invoking the installer", async () => {
    const f = fixture({ status: "running" });
    const stop = f.manager.stopService;
    f.manager.stopService = async id => { await stop(id); throw new Error("state write failed"); };
    const result = await f.run();
    expect(result).toMatchObject({ success: false, updated: false, restarted: true });
    expect(result.message).toContain("state write failed");
    expect(f.state().services.ocx.status).toBe("running");
    expect(f.calls).toEqual(["sync", "versions", "stop", "start"]);
    expect(f.manager.updatesInProgress.size).toBe(0);
  });

  it("does not install or spawn duplicates if an external supervisor revives the service", async () => {
    const f = fixture({ status: "running" });
    f.manager.stopService = async () => { f.calls.push("stop"); return { success: true }; };
    const result = await f.run();
    expect(result.success).toBe(false);
    expect(result.message).toContain("external supervisor");
    expect(f.calls).toEqual(["sync", "versions", "stop", "sync"]);
  });

  for (const failure of ["throw", "exit code"]) {
    it(`recovers the originally running service after installer ${failure}`, async () => {
      const f = fixture({ status: "running" });
      f.options.install = async () => {
        f.calls.push("install");
        if (failure === "throw") throw new Error("installer exception");
        return { success: false, message: "npm exited 1" };
      };
      const result = await f.run();
      expect(result).toMatchObject({ success: false, updated: false, restarted: true, codexConfig: { status: "unchanged" } });
      expect(result.message).toContain(failure === "throw" ? "installer exception" : "npm exited 1");
      expect(result.message).toContain("rollback is not guaranteed");
      expect(f.calls).toEqual(["sync", "versions", "stop", "sync", "install", "start"]);
      expect(f.manager.updatesInProgress.size).toBe(0);
    });
  }

  it("does not start an originally stopped service after an installer failure", async () => {
    const f = fixture();
    f.options.install = async () => { f.calls.push("install"); return { success: false, message: "failed" }; };
    expect(await f.run()).toMatchObject({ success: false, updated: false, restarted: false });
    expect(f.calls).toEqual(["sync", "versions", "install"]);
  });

  it("rejects stale or unknown installed versions despite installer success and never pins them", async () => {
    for (const version of ["2.42.0", null, undefined, "invalid"]) {
      const f = fixture({ id: "agentmemory", status: "running", versions: ["2.42.0", version] });
      const result = await f.run();
      expect(result).toMatchObject({ success: false, updated: false, restarted: true });
      expect(result.message).toContain("expected 2.49.0");
      expect(f.calls).not.toContain("save");
      expect(f.calls.filter(c => c === "start")).toHaveLength(1);
      expect(f.state().services.agentmemory.launchVersion).toBeUndefined();
    }
  });

  it("rejects stale or unknown live versions after successful disk installation and restart", async () => {
    for (const version of ["2.42.0", null, undefined, "invalid"]) {
      const f = fixture({ status: "running", versions: ["2.42.0", "2.49.0", version] });
      const result = await f.run();
      expect(result).toMatchObject({ success: false, updated: true, restarted: true });
      expect(result.message).toContain("running version");
      expect(result.message).toContain("expected 2.49.0");
      expect(f.calls.filter(c => c === "start")).toHaveLength(1);
    }
  });

  it("does not confuse a post-restart daemon exit with a successful PATH version probe", async () => {
    const f = fixture({ status: "running" });
    f.manager.startService = async () => { f.calls.push("start"); return { success: true }; };
    const result = await f.run();
    expect(result).toMatchObject({ success: false, updated: true, restarted: false });
    expect(result.message).toContain("exited after restart");
    expect(f.probes).toHaveLength(2);
    expect(f.calls.filter(c => c === "start")).toHaveLength(1);
  });

  it("requires a PID as well as running status after restart", async () => {
    const f = fixture({ status: "running" });
    const sync = f.manager.syncState;
    let syncs = 0;
    f.manager.syncState = async () => {
      const state = await sync();
      if (++syncs === 3) state.services.ocx.pid = undefined;
      return state;
    };
    const result = await f.run();
    expect(result).toMatchObject({ success: false, updated: true, restarted: false });
    expect(result.message).toContain("exited after restart");
    expect(f.probes).toHaveLength(2);
  });

  for (const failure of ["throw", "result"]) {
    it(`reports a restart ${failure} after successful update without retrying startup`, async () => {
      const f = fixture({ status: "running" });
      f.manager.startService = async () => {
        f.calls.push("start");
        if (failure === "throw") throw new Error("port busy");
        return { success: false, message: "port busy" };
      };
      const result = await f.run();
      expect(result).toMatchObject({ success: false, updated: true, restarted: false, version: "2.49.0" });
      expect(result.message).toContain("restart failed: port busy");
      expect(f.calls.filter(c => c === "start")).toHaveLength(1);
      expect(f.probes).toHaveLength(2);
      expect(f.manager.updatesInProgress.size).toBe(0);
    });
  }

  it("reports both installation failure and recovery restart failure", async () => {
    const f = fixture({ status: "running" });
    f.options.install = async () => { throw new Error("install failed"); };
    f.manager.startService = async () => { f.calls.push("start"); throw new Error("restart failed"); };
    const result = await f.run();
    expect(result).toMatchObject({ success: false, updated: false, restarted: false });
    expect(result.message).toContain("install failed");
    expect(result.message).toContain("Recovery restart failed: restart failed");
    expect(f.calls.filter(c => c === "start")).toHaveLength(1);
  });

  it("guards concurrent updates of the same service and releases the guard afterwards", async () => {
    const f = fixture({ versions: ["2.42.0", "2.49.0", "2.49.0"] });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.options.install = async () => { f.calls.push("install"); await gate; return { success: true }; };
    const first = f.run();
    try {
      expect(f.manager.updatesInProgress.has("ocx")).toBe(true);
      const duplicate = await f.run();
      expect(duplicate.success).toBe(false);
      expect(duplicate.message).toContain("already in progress");
    } finally { release(); }
    expect(await first).toMatchObject({ success: true, updated: true });
    expect(f.calls.filter(c => c === "install")).toHaveLength(1);
    expect(f.manager.updatesInProgress.size).toBe(0);
    expect(await f.run()).toMatchObject({ success: true, updated: false, alreadyUpToDate: true });
  });

  it("releases the guard even if state synchronization throws", async () => {
    const f = fixture();
    f.manager.syncState = async () => { throw new Error("state unavailable"); };
    expect(await f.run()).toMatchObject({ success: false, updated: false, restarted: false });
    expect(f.manager.updatesInProgress.size).toBe(0);
    expect(f.calls).toEqual([]);
  });
});

async function withLogHome(run) {
  const previous = process.env.AIH_HOME;
  const home = mkdtempSync(join(tmpdir(), "aih-update-test-"));
  process.env.AIH_HOME = home;
  try { return await run(home); }
  finally {
    if (previous === undefined) delete process.env.AIH_HOME;
    else process.env.AIH_HOME = previous;
    // The recursive cleanup target is the freshly created test temp directory.
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe temporary cleanup path");
    rmSync(home, { recursive: true, force: true });
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("installer output capture", () => {
  it("logs both streams privately and waits for close rather than exit", async () => withLogHome(async home => {
    const child = fakeChild();
    let invocation;
    let settled = false;
    const pending = installServiceUpdate("ocx", { platform: "linux", spawnImpl: (...args) => { invocation = args; return child; } });
    pending.then(() => { settled = true; });
    expect(invocation[0]).toBe("npm");
    expect(invocation[2]).toMatchObject({ windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { CI: "1", npm_config_yes: "true", PIP_NO_INPUT: "1", NO_COLOR: "1" } });
    expect(invocation[2].shell).toBeUndefined();
    child.stdout.emit("data", Buffer.from("updated package\n"));
    child.emit("exit", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stderr.emit("data", "child installer finished\n");
    child.emit("close", 0, null);
    const result = await pending;
    expect(result).toMatchObject({ success: true, exitCode: 0, logPath: join(home, "logs", "ocx.log") });
    const log = readFileSync(result.logPath, "utf8");
    expect(log).toContain("npm install --global @bitkyc08/opencodex@latest");
    expect(log).toContain("updated package\nchild installer finished\n");
  }));

  it("retains the full installer log but bounds failure diagnostics in memory", async () => withLogHome(async () => {
    const child = fakeChild();
    const pending = installServiceUpdate("ocx", { spawnImpl: () => child });
    const output = "beginning-of-full-log\n" + "x".repeat(12000) + "\nfinal failure detail";
    child.stdout.emit("data", output);
    child.emit("close", 7, null);
    const result = await pending;
    expect(result).toMatchObject({ success: false, exitCode: 7 });
    expect(result.message).toContain("final failure detail");
    expect(result.message).not.toContain("beginning-of-full-log");
    expect(result.message.length).toBeLessThan(4100);
    expect(readFileSync(result.logPath, "utf8")).toContain(output);
  }));

  it("handles a spawn exception without rejecting the operation", async () => withLogHome(async () => {
    expect(await installServiceUpdate("ocx", { spawnImpl: () => { throw new Error("missing npm"); } }))
      .toMatchObject({ success: false, exitCode: 1, message: "missing npm" });
  }));

  it("settles once on a child error even if close and late output follow", async () => withLogHome(async () => {
    const child = fakeChild();
    const pending = installServiceUpdate("ocx", { spawnImpl: () => child });
    child.emit("error", new Error("ENOENT"));
    child.stdout.emit("data", "late output");
    child.emit("close", 0, null);
    expect(await pending).toMatchObject({ success: false, exitCode: 1, message: "Cannot update 'ocx': ENOENT" });
  }));

  it("does not treat signal termination as installer success", async () => withLogHome(async () => {
    const child = fakeChild();
    const pending = installServiceUpdate("headroom", { spawnImpl: () => child });
    child.emit("close", null, "SIGTERM");
    expect(await pending).toMatchObject({ success: false, exitCode: 1, message: "Installer terminated by SIGTERM" });
  }));
});
