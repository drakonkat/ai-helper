import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SERVICES, SERVICE_IDS, APP_NAME, CLI_NAME } from "../src/config.js";
import { formatBytes, formatUptime, stripAnsi, renderTable, badgeStatus } from "../src/utils/format.js";
import { getAihDir, getStateFilePath, getLogsDir, getServiceLogPath, getLocalBinDir, isLocalBinInPath } from "../src/utils/path.js";
import { isPidRunning, discoverRunningProcesses } from "../src/utils/process.js";
import { manager, ServiceManager } from "../src/manager.js";
import { PACKAGE_NAME, VERSION } from "../src/config.js";
import { checkForUpdates, isNewerVersion } from "../src/update.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const originalAihHome = process.env.AIH_HOME;
let testHome;
beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), "aih-tests-"));
  process.env.AIH_HOME = join(testHome, ".aih");
});
afterAll(() => {
  if (originalAihHome === undefined) delete process.env.AIH_HOME;
  else process.env.AIH_HOME = originalAihHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe("Update check", () => {
  it("checks start and up once, notifies on stderr, and starts services offline", async () => {
    const original = { argv: process.argv, fetch: globalThis.fetch, log: console.log, error: console.error, start: manager.startService };
    const notifications = [];
    let checks = 0;
    let starts = 0;
    try {
      console.log = () => {};
      console.error = message => notifications.push(message);
      globalThis.fetch = async () => { checks++; return { ok: true, json: async () => ({ version: "999.0.0" }) }; };
      manager.startService = async () => { starts++; return { success: true, pid: 123 }; };
      process.argv = ["node", "aih", "--help"];
      const { main } = await import("../src/index.js");
      for (const args of [
        ["start", "test-service"], ["--json", "up", "test-service"],
        ["start", "proxy", "http://127.0.0.1:10100", "--json"],
        ["up", "proxy", "http://127.0.0.1:10100", "--json"], ["version"],
      ]) {
        process.argv = ["node", "aih", ...args];
        await main();
      }
      expect(checks).toBe(4);
      expect(starts).toBe(4);
      expect(notifications.length).toBe(4);
      globalThis.fetch = async () => { throw new Error("offline"); };
      process.argv = ["node", "aih", "start", "test-service"];
      await main();
      expect(starts).toBe(5);
      expect(notifications.length).toBe(4);
    } finally {
      process.argv = original.argv;
      globalThis.fetch = original.fetch;
      console.log = original.log;
      console.error = original.error;
      manager.startService = original.start;
    }
  });

  it("compares release versions and treats registry errors as non-fatal", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
    expect(PACKAGE_NAME).toBe(pkg.name);
    for (const [latest, current, newer] of [
      ["1.10.0", "1.9.9", true], ["2.0.0", "1.99.99", true],
      ["1.1.1", "1.1.1", false], ["1.0.9", "1.1.0", false],
      ["1.0.0", "1.0.0-rc.1", true], ["1.0.0-rc.1", "1.0.0", false],
      ["1.0.0-rc.10", "1.0.0-rc.2", true], ["1.0.0-beta", "1.0.0-alpha", true],
      ["1.0.0-rc.1", "1.0.0-rc", true], ["1.0.0-rc", "1.0.0-rc.1", false],
      ["1.0.0-alpha", "1.0.0-1", true], ["1.0.0-1", "1.0.0-alpha", false],
      ["1.0.0+new", "1.0.0+old", false], ["invalid", "1.0.0", false],
      ["1.0.0\nmalicious", "1.0.0", false], [undefined, "1.0.0", false],
      ["999.0.0\n", "1.0.0", false],
    ]) expect(isNewerVersion(latest, current)).toBe(newer);
    const messages = [];
    const notify = message => messages.push(message);
    await checkForUpdates({ notify, fetchImpl: async (url, options) => {
      expect(url).toBe(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => ({ version: "999.0.0" }) };
    } });
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(`${VERSION} -> 999.0.0`);
    expect(messages[0]).toContain(`npm install -g ${PACKAGE_NAME}@latest`);
    for (const result of [
      { ok: false }, { ok: true, json: async () => ({ version: VERSION }) },
      { ok: true, json: async () => ({ version: "invalid" }) },
      { ok: true, json: async () => { throw new Error("bad JSON"); } },
    ]) await checkForUpdates({ notify, fetchImpl: async () => result });
    await checkForUpdates({ notify, fetchImpl: async () => { throw new Error("offline"); } });
    // A real fetch keeps the event loop alive; this mock has no network socket.
    const keepAlive = setInterval(() => {}, 100);
    try {
      await checkForUpdates({ notify, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) });
    } finally { clearInterval(keepAlive); }
    expect(messages.length).toBe(1);
  });
});

describe("Service start CLI", () => {
  it("starts default services in order and preserves explicit start options", async () => {
    const original = { argv: process.argv, fetch: globalThis.fetch, log: console.log, start: manager.startService };
    const calls = [];
    let starting = false;
    const defaultProxy = {
      upstream: "http://127.0.0.1:10100/", listen: "http://127.0.0.1:10102", preset: "pxpipe",
      models: "gpt-6-astra,google-antigravity/gemini-3.8*,anthropic/claude-fable*",
    };
    const customProxy = { upstream: "http://127.0.0.1:9000/", listen: "http://127.0.0.1:9001", preset: "rtk", models: "custom/*" };
    try {
      console.log = () => {};
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: VERSION }) });
      manager.startService = async (id, options) => {
        expect(starting).toBe(false);
        starting = true;
        calls.push([id, options]);
        await Promise.resolve();
        starting = false;
        return { success: true, pid: 123 };
      };
      process.argv = ["node", "aih", "--help"];
      const { main } = await import("../src/index.js");
      for (const command of ["start", "up"]) {
        for (const [args, expected] of [
          [[], [["ocx", undefined], ["agentmemory", undefined], ["proxy", defaultProxy]]],
          [["--models", "custom/*"], [["ocx", undefined], ["agentmemory", undefined], ["proxy", { ...defaultProxy, models: "custom/*" }]]],
          [["--models=custom/*"], [["ocx", undefined], ["agentmemory", undefined], ["proxy", { ...defaultProxy, models: "custom/*" }]]],
          [["--models", ""], [["ocx", undefined], ["agentmemory", undefined], ["proxy", { ...defaultProxy, models: "" }]]],
          [["--models="], [["ocx", undefined], ["agentmemory", undefined], ["proxy", { ...defaultProxy, models: "" }]]],
          [["ocx", "proxy", "--models", "custom/*"], [["ocx", undefined], ["proxy", { models: "custom/*" }]]],
          [["pxpipe", "headroom"], [["pxpipe", undefined], ["headroom", undefined]]],
          [["proxy", customProxy.upstream, "--listen", customProxy.listen, "--preset", customProxy.preset, "--models", customProxy.models], [["proxy", customProxy]]],
        ]) {
          calls.length = 0;
          process.argv = ["node", "aih", command, ...args, "--json"];
          await main();
          expect(calls).toEqual(expected);
        }
        for (const args of [["--models"], ["--models", "--json"]]) {
          calls.length = 0;
          process.argv = ["node", "aih", command, ...args];
          await expect(main()).rejects.toThrow("--models");
          expect(calls).toEqual([]);
        }
      }
    } finally {
      process.argv = original.argv;
      globalThis.fetch = original.fetch;
      console.log = original.log;
      manager.startService = original.start;
    }
  });
});

describe("Managed service update CLI", () => {
  async function runUpdate(args, update = async id => ({ success: true, message: `${id} updated`, version: "2.49.0" })) {
    const original = { argv: process.argv, log: console.log, error: console.error, exitCode: process.exitCode, update: manager.updateService };
    const stdout = [];
    const stderr = [];
    const calls = [];
    try {
      console.log = message => stdout.push(String(message));
      console.error = message => stderr.push(String(message));
      manager.updateService = async id => { calls.push(id); return update(id); };
      process.argv = ["node", "aih", "--help"];
      const { main } = await import("../src/index.js");
      stdout.length = 0;
      process.exitCode = 0;
      process.argv = ["node", "aih", ...args];
      await main();
      return { calls, stdout, stderr, exitCode: process.exitCode };
    } finally {
      process.argv = original.argv;
      console.log = original.log;
      console.error = original.error;
      process.exitCode = original.exitCode;
      manager.updateService = original.update;
    }
  }

  it("supports both service-first and command-first updates with clean JSON", async () => {
    for (const args of [["ocx", "update", "--json"], ["--json", "update", "ocx"]]) {
      const result = await runUpdate(args);
      expect(result.calls).toEqual(["ocx"]);
      expect(result.stdout).toHaveLength(1);
      expect(JSON.parse(result.stdout[0])).toEqual([{ id: "ocx", success: true, message: "ocx updated", version: "2.49.0" }]);
      expect(result.stderr).toEqual([]);
      expect(result.exitCode).toBe(0);
    }
  });

  it("defaults to standard services only and deduplicates explicit targets", async () => {
    const all = await runUpdate(["update", "--json"]);
    expect(all.calls).toEqual(SERVICE_IDS);
    expect(all.calls).not.toContain("proxy");
    const selected = await runUpdate(["update", "ocx", "agentmemory", "ocx", "--json"]);
    expect(selected.calls).toEqual(["ocx", "agentmemory"]);
    expect(JSON.parse(selected.stdout[0]).map(r => r.id)).toEqual(selected.calls);
  });

  it("validates every target and all update options before any mutation", async () => {
    for (const args of [
      ["update", "ocx", "unknown"], ["update", "proxy"],
      ["ocx", "update", "agentmemory"], ["unknown", "update"],
      ["update", "--ocx"], ["update", "ocx", "--repo"],
    ]) {
      const result = await runUpdate([...args, "--json"]);
      expect(result.calls).toEqual([]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toHaveLength(1);
      expect(JSON.parse(result.stdout[0]).every(r => r.success === false)).toBe(true);
      expect(result.stderr).toEqual([]);
    }
    const proxy = await runUpdate(["proxy", "update", "--json"]);
    expect(JSON.parse(proxy.stdout[0])[0].message).toContain("ai-helper itself");
  });

  it("reports no-op, returned failures, and thrown errors while processing other targets", async () => {
    const result = await runUpdate(["update", "ocx", "pxpipe", "headroom", "--json"], async id => {
      if (id === "ocx") return { success: true, alreadyUpToDate: true, message: "Already current" };
      if (id === "pxpipe") return { success: false, message: "Installer failed" };
      throw new Error("Cannot resolve installer");
    });
    expect(result.calls).toEqual(["ocx", "pxpipe", "headroom"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout[0])).toEqual([
      { id: "ocx", success: true, alreadyUpToDate: true, message: "Already current" },
      { id: "pxpipe", success: false, message: "Installer failed" },
      { id: "headroom", success: false, message: "Cannot resolve installer" },
    ]);
    expect(result.stderr).toEqual([]);
  });
});

describe("Configuration", () => {
  it("should have correct app and CLI names", () => {
    expect(APP_NAME).toBe("ai-helper");
    expect(CLI_NAME).toBe("aih");
  });

  it("should define the core services: pxpipe, ocx, agentmemory, headroom", () => {
    expect(SERVICE_IDS).toContain("pxpipe");
    expect(SERVICE_IDS).toContain("ocx");
    expect(SERVICE_IDS).toContain("agentmemory");
    expect(SERVICE_IDS).toContain("headroom");
    expect(SERVICE_IDS.length).toBe(4);
  });

  it("should define valid commands and dashboard URLs for all services", () => {
    expect(SERVICES.pxpipe.command).toBe("npx pxpipe-proxy");
    expect(SERVICES.pxpipe.defaultUrl).toBe("http://localhost:47821");
    expect(SERVICES.ocx.command).toBe("ocx start");
    expect(SERVICES.ocx.defaultUrl).toBe("http://localhost:10100");
    expect(SERVICES.agentmemory.command).toBe("npx @agentmemory/agentmemory");
    expect(SERVICES.agentmemory.defaultUrl).toBe("http://localhost:3113");
    expect(SERVICES.headroom.command).toBe("headroom proxy");
    expect(SERVICES.headroom.defaultUrl).toBe("http://localhost:8787/dashboard");
  });
});

describe("Path Utilities", () => {
  it("should resolve AIH home and state paths", () => {
    const aihDir = getAihDir();
    expect(aihDir).toContain(".aih");
    expect(getStateFilePath()).toBe(join(aihDir, "state.json"));
    expect(getLogsDir()).toContain("logs");
    expect(getServiceLogPath("pxpipe")).toContain("pxpipe.log");
  });

  it("should resolve local bin directory", () => {
    const localBin = getLocalBinDir();
    expect(localBin).toContain(".local");
    expect(localBin).toContain("bin");
  });

  it("should check if local bin is in PATH", () => {
    const inPath = isLocalBinInPath();
    expect(typeof inPath).toBe("boolean");
  });
});

describe("Format Utilities", () => {
  it("should strip ANSI sequences", () => {
    const colored = "\x1b[32m\x1b[1mHello World\x1b[22m\x1b[39m";
    expect(stripAnsi(colored)).toBe("Hello World");
  });

  it("should format uptime accurately", () => {
    expect(formatUptime(undefined)).toBe("-");
    const now = new Date();
    expect(formatUptime(now.toISOString())).toBe("0s");

    const tenSecsAgo = new Date(Date.now() - 10 * 1000).toISOString();
    expect(formatUptime(tenSecsAgo)).toBe("10s");

    const twoMinsAgo = new Date(Date.now() - 130 * 1000).toISOString();
    expect(formatUptime(twoMinsAgo)).toBe("2m 10s");

    const threeHoursAgo = new Date(Date.now() - (3 * 3600 + 15 * 60) * 1000).toISOString();
    expect(formatUptime(threeHoursAgo)).toBe("3h 15m");
  });

  it("should format bytes accurately", () => {
    expect(formatBytes(undefined)).toBe("-");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  it("should render table columns correctly", () => {
    const headers = ["NAME", "VALUE"];
    const rows = [
      ["item1", 100],
      ["item2", 200],
    ];
    const table = renderTable(headers, rows);
    expect(stripAnsi(table)).toContain("NAME");
    expect(stripAnsi(table)).toContain("item1");
    expect(stripAnsi(table)).toContain("100");
  });

  it("should render status badges", () => {
    expect(stripAnsi(badgeStatus("running"))).toBe("● RUNNING");
    expect(stripAnsi(badgeStatus("stopped"))).toBe("○ STOPPED");
    expect(stripAnsi(badgeStatus("error"))).toBe("✖ ERROR");
  });
});

describe("Process Utilities", () => {
  it("should accurately test current process PID", () => {
    expect(isPidRunning(process.pid)).toBe(true);
  });

  it("should return false for invalid PID", () => {
    expect(isPidRunning(undefined)).toBe(false);
    expect(isPidRunning(0)).toBe(false);
    expect(isPidRunning(-1)).toBe(false);
    expect(isPidRunning(9999999)).toBe(false);
  });

  it("should not discover the current process PID as a service", async () => {
    const discovered = await discoverRunningProcesses();
    for (const id of Object.keys(discovered)) {
      expect(discovered[id].pid).not.toBe(process.pid);
    }
  });
});

describe("Service Manager", () => {
  const mgr = new ServiceManager();

  it("should load default state for all services", () => {
    const state = mgr.loadState();
    expect(state.services).toBeDefined();
    expect(state.services.pxpipe).toBeDefined();
    expect(state.services.ocx).toBeDefined();
    expect(state.services.agentmemory).toBeDefined();
    expect(state.services.headroom).toBeDefined();
  });

  it("should get status list with URLs for all services", async () => {
    const statuses = await mgr.getStatus();
    expect(statuses.length).toBe(4);
    const ids = statuses.map(s => s.id);
    expect(ids).toContain("pxpipe");
    expect(ids).toContain("ocx");
    expect(ids).toContain("agentmemory");
    expect(ids).toContain("headroom");

    for (const svc of statuses) {
      expect(svc.url).toBeDefined();
      expect(svc.url).toContain("http");
    }
  }, 15000);

  it("should handle unknown service gracefully when starting", async () => {
    const res = await mgr.startService("unknown-service");
    expect(res.success).toBe(false);
    expect(res.message).toContain("Unknown service");
  }, 15000);
});
