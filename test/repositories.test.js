import { describe, expect, it, mock } from "bun:test";
import { APP_REPOSITORY_URL, SERVICES } from "../src/config.js";
import { Dashboard } from "../src/tui.js";
import { manager } from "../src/manager.js";
import { stripAnsi } from "../src/utils/format.js";

const repositoryUrls = {
  pxpipe: "https://github.com/teamchong/pxpipe",
  ocx: "https://github.com/lidge-jun/opencodex",
  agentmemory: "https://github.com/rohitg00/agentmemory",
  headroom: "https://github.com/headroomlabs-ai/headroom",
  proxy: "https://github.com/drakonkat/ai-helper",
};
const services = Object.entries(repositoryUrls).map(([id, repositoryUrl]) => ({
  id, repositoryUrl, status: "running", pid: 123, uptime: "20m",
  url: "http://localhost:10100", dashboardUrl: "http://localhost:10100",
}));

describe("service repositories", () => {
  it("records upstream GitHub repositories and uses ai-helper for its built-in proxy", () => {
    for (const [id, service] of Object.entries(SERVICES)) {
      expect(service.repositoryUrl).toBe(repositoryUrls[id]);
    }
    expect(APP_REPOSITORY_URL).toBe(repositoryUrls.proxy);
  });

  it("renders the repository column and selected full link without breaking terminal widths", () => {
    const { columns, rows } = process.stdout;
    const dashboard = new Dashboard({ getVersions: async () => ({}) });
    dashboard.statuses = services;
    try {
      process.stdout.rows = 40;
      for (const width of [40, 80, 100, 180]) {
        process.stdout.columns = width;
        const lines = dashboard.buildLines().map(stripAnsi);
        expect(lines.every(line => line.length <= width)).toBe(true);
        expect(lines.join("\n")).toContain("g GitHub");
        expect(lines.join("\n")).toContain("o dashboard");
        if (width >= 80) {
          expect(lines[2]).toContain("REPO");
          expect(lines.join("\n")).toContain(repositoryUrls.pxpipe);
        }
        if (width === 180) {
          for (const url of Object.values(repositoryUrls)) {
            expect(lines.join("\n")).toContain(url.replace("https://github.com/", ""));
          }
          expect(lines[2]).toContain("URL");
        }
      }
      process.stdout.columns = 100;
      dashboard.selected = services.findIndex(service => service.id === "proxy");
      expect(dashboard.buildLines().map(stripAnsi).join("\n")).toContain(repositoryUrls.proxy);
    } finally {
      process.stdout.columns = columns;
      process.stdout.rows = rows;
    }
  });

  it("opens the selected repository with g rather than its dashboard", async () => {
    const original = manager.openRepository;
    manager.openRepository = mock(async ids => ids.map(id => ({ id, url: repositoryUrls[id] })));
    try {
      const dashboard = new Dashboard();
      dashboard.statuses = services;
      dashboard.selected = 1;
      let action;
      dashboard.runAction = mock((label, callback) => { action = callback; });
      dashboard.onKey("g");
      expect(dashboard.runAction).toHaveBeenCalledTimes(1);
      const result = await action(dashboard.currentService());
      expect(manager.openRepository).toHaveBeenCalledWith(["ocx"]);
      expect(result).toEqual({ success: true, message: `Aperto ${repositoryUrls.ocx}` });
    } finally {
      if (original === undefined) delete manager.openRepository;
      else manager.openRepository = original;
    }
  });

  it("omits the repository action for services without metadata", () => {
    const dashboard = new Dashboard();
    dashboard.statuses = [{ id: "custom", status: "stopped", url: "-" }];
    dashboard.runAction = mock();
    dashboard.onKey("g");
    expect(dashboard.runAction).not.toHaveBeenCalled();
    expect(dashboard.buildLines().map(stripAnsi).join("\n")).not.toContain("g GitHub");
  });

  it("surfaces Codex configuration outcomes without hiding the lifecycle result", async () => {
    const dashboard = new Dashboard();
    dashboard.statuses = services;
    dashboard.refresh = mock(async () => {});
    await dashboard.runAction("Avvio", async () => ({
      success: true, message: "ocx started", codexConfig: { status: "warning", message: "Config not updated" },
    }));
    expect(stripAnsi(dashboard.status)).toBe("ocx started | Config not updated");
    await dashboard.runAction("Avvio", async () => ({
      success: true, message: "ocx started", codexConfig: { status: "unchanged" },
    }));
    expect(stripAnsi(dashboard.status)).toBe("ocx started");
    expect(dashboard.refresh).toHaveBeenCalledTimes(2);
  });
});
