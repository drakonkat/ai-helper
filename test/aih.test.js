import { describe, expect, it } from "bun:test";
import { SERVICES, SERVICE_IDS, APP_NAME, CLI_NAME } from "../src/config.js";
import { formatBytes, formatUptime, stripAnsi, renderTable, badgeStatus } from "../src/utils/format.js";
import { getAihDir, getStateFilePath, getLogsDir, getServiceLogPath, getLocalBinDir, isLocalBinInPath } from "../src/utils/path.js";
import { isPidRunning } from "../src/utils/process.js";
import { ServiceManager } from "../src/manager.js";

describe("Configuration", () => {
  it("should have correct app and CLI names", () => {
    expect(APP_NAME).toBe("ai-helper");
    expect(CLI_NAME).toBe("aih");
  });

  it("should define the three core services: pxpipe, ocx, agentmemory", () => {
    expect(SERVICE_IDS).toContain("pxpipe");
    expect(SERVICE_IDS).toContain("ocx");
    expect(SERVICE_IDS).toContain("agentmemory");
    expect(SERVICE_IDS.length).toBe(3);
  });

  it("should define valid commands and dashboard URLs for all services", () => {
    expect(SERVICES.pxpipe.command).toBe("npx pxpipe-proxy");
    expect(SERVICES.pxpipe.defaultUrl).toBe("http://localhost:47821");
    expect(SERVICES.ocx.command).toBe("ocx start");
    expect(SERVICES.ocx.defaultUrl).toBe("http://localhost:10100");
    expect(SERVICES.agentmemory.command).toBe("npx @agentmemory/agentmemory");
    expect(SERVICES.agentmemory.defaultUrl).toBe("http://localhost:3113");
  });
});

describe("Path Utilities", () => {
  it("should resolve AIH home and state paths", () => {
    const aihDir = getAihDir();
    expect(aihDir).toContain(".aih");
    expect(getStateFilePath()).toBe(`${aihDir}\\state.json` || `${aihDir}/state.json`);
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
});

describe("Service Manager", () => {
  const mgr = new ServiceManager();

  it("should load default state for all services", () => {
    const state = mgr.loadState();
    expect(state.services).toBeDefined();
    expect(state.services.pxpipe).toBeDefined();
    expect(state.services.ocx).toBeDefined();
    expect(state.services.agentmemory).toBeDefined();
  });

  it("should get status list with URLs for all services", async () => {
    const statuses = await mgr.getStatus();
    expect(statuses.length).toBe(3);
    const ids = statuses.map(s => s.id);
    expect(ids).toContain("pxpipe");
    expect(ids).toContain("ocx");
    expect(ids).toContain("agentmemory");

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

