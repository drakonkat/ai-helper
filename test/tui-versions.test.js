import { describe, expect, it, mock, spyOn } from "bun:test";
import { Dashboard } from "../src/tui.js";
import { manager } from "../src/manager.js";
import { stripAnsi } from "../src/utils/format.js";

const services = ["pxpipe", "ocx", "agentmemory", "headroom"].map((id, i) => ({
  id, status: "running", pid: i + 100, uptime: "20m", url: `http://localhost:${3000 + i}`,
}));
const available = { version: "1.2.0", latestVersion: "1.3.0", updateAvailable: true };

describe("dashboard service versions", () => {
  it("renders installed versions, available updates, and unknown results at 80 columns", () => {
    const columns = process.stdout.columns;
    try {
      process.stdout.columns = 80;
      const dashboard = new Dashboard();
      dashboard.statuses = services;
      dashboard.versions = {
        pxpipe: available,
        ocx: { version: "2.0.0", latestVersion: "2.0.0", updateAvailable: false },
        agentmemory: { version: "0.9.29", latestVersion: null, updateAvailable: null },
        headroom: { version: null, latestVersion: "1.0.0", updateAvailable: null },
      };
      const lines = dashboard.buildLines().map(stripAnsi);
      expect(lines[2]).toContain("VERSION");
      expect(lines[2]).toContain("UPDATE");
      expect(lines.find(line => line.includes("pxpipe"))).toMatch(/1\.2\.0\s+↑ 1\.3\.0/);
      expect(lines.find(line => line.includes("ocx"))).toContain("aggiornato");
      expect(lines.find(line => line.includes("agentmemory"))).toMatch(/0\.9\.29\s+n\/d/);
      expect(lines.find(line => line.includes("headroom"))).toMatch(/n\/d\s+n\/d/);
      expect(lines.every(line => line.length <= 80)).toBe(true);
    } finally {
      process.stdout.columns = columns;
    }
  });

  it("caches checks for five minutes and refreshes after a service restart", async () => {
    const getVersions = mock(async () => ({ pxpipe: available }));
    const dashboard = new Dashboard({ getVersions });
    dashboard.statuses = services;
    await dashboard.refreshVersions();
    await dashboard.refreshVersions();
    expect(getVersions).toHaveBeenCalledTimes(1);
    dashboard.versionsAt -= 5 * 60 * 1000;
    await dashboard.refreshVersions();
    expect(getVersions).toHaveBeenCalledTimes(2);
    dashboard.statuses = services.map(s => ({ ...s, pid: s.pid + 10 }));
    await dashboard.refreshVersions();
    expect(getVersions).toHaveBeenCalledTimes(3);
    expect(dashboard.versions.pxpipe).toEqual(available);
  });

  it("refreshes the dashboard without waiting for the registry", async () => {
    let finish;
    const dashboard = new Dashboard({ getVersions: () => new Promise(resolve => { finish = resolve; }) });
    const getStatus = spyOn(manager, "getStatus").mockResolvedValue([
      { id: "pxpipe", status: "stopped", url: "" },
    ]);
    try {
      await dashboard.refresh();
      expect(dashboard.statuses[0].id).toBe("pxpipe");
      expect(dashboard.refreshing).toBe(false);
      expect(dashboard.versionsLoading).toBe(true);
    } finally {
      finish?.({});
      getStatus.mockRestore();
    }
  });

  it("does not duplicate an in-flight check or display results from a replaced service", async () => {
    let finish;
    const getVersions = mock(() => new Promise(resolve => { finish = resolve; }));
    const dashboard = new Dashboard({ getVersions });
    dashboard.statuses = services;
    const checking = dashboard.refreshVersions();
    expect(dashboard.buildLines().map(stripAnsi).join("\n")).toContain("verifica...");
    dashboard.statuses = services.map(s => ({ ...s, status: "stopped" }));
    await dashboard.refreshVersions();
    expect(getVersions).toHaveBeenCalledTimes(1);
    finish({ pxpipe: available });
    await checking;
    expect(dashboard.versions).toEqual({});
    expect(dashboard.versionsAt).toBe(0);
    expect(dashboard.versionsLoading).toBe(false);
    const retry = dashboard.refreshVersions();
    finish({ pxpipe: available });
    await retry;
    expect(getVersions).toHaveBeenCalledTimes(2);
  });

  it("degrades a failed check to n/d without retrying every second", async () => {
    const getVersions = mock(async () => { throw new Error("offline"); });
    const dashboard = new Dashboard({ getVersions });
    dashboard.statuses = services;
    await dashboard.refreshVersions();
    await dashboard.refreshVersions();
    expect(dashboard.versionsLoading).toBe(false);
    expect(getVersions).toHaveBeenCalledTimes(1);
    const row = dashboard.buildLines().map(stripAnsi).find(line => line.includes("pxpipe"));
    expect(row).toMatch(/n\/d\s+n\/d/);
    expect(row).not.toContain("aggiornato");
  });
});
