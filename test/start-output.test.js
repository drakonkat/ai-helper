import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const modulePath = name => fileURLToPath(new URL(`../src/${name}.js`, import.meta.url));

// Isolate CLI auto-execution and mocks: no real services or user configuration are touched.
function runCli(args, fail = false, color = false) {
  const script = `
    import { mock } from 'bun:test';
    const ids = ['ocx', 'pxpipe', 'headroom'];
    const result = id => ({id, success: true, alreadyRunning: id === 'pxpipe', pid: 100 + ids.indexOf(id)});
    mock.module(${JSON.stringify(modulePath("manager"))}, () => ({
      manager: { startService: async id => result(id) }
    }));
    mock.module(${JSON.stringify(modulePath("gpt"))}, () => ({
      GPT_SERVICE_IDS: ids,
      startGpt: async ({withProgress = async (_id, start) => start()}) => {
        const services = [];
        for (const id of ids) services.push(await withProgress(id, async () => {
          if (${fail} && id === 'pxpipe') throw new Error('test launch failure');
          return result(id);
        }));
        return {services, urls: {ocx:'ocx',pxpipe:'pxpipe',headroom:'headroom'}, note:'New task required.'};
      }
    }));
    process.argv = ['bun', ${JSON.stringify(modulePath("index"))}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(modulePath("index"))});
  `;
  return spawnSync(process.execPath, ["--eval", script], {
    encoding: "utf8", env: { ...process.env, FORCE_COLOR: color ? "1" : "", NO_COLOR: color ? "" : "1" },
  });
}

it("uses exactly the normal start formatting for GPT names, PIDs and already-running services", () => {
  for (const color of [false, true]) {
    const normal = runCli(["start", "ocx", "pxpipe", "headroom"], false, color);
    const gpt = runCli(["start", "--gpt"], false, color);
    expect(normal.status).toBe(0);
    expect(gpt.status).toBe(0);
    expect(gpt.stderr).toBe("");
    expect(gpt.stdout.startsWith(normal.stdout)).toBe(true);
    if (!color) {
      expect(normal.stdout).toContain("Starting service(s): ocx, pxpipe, headroom...\n\n");
      expect(normal.stdout).toContain("  Launching ocx... started (PID: 100)\n");
      expect(normal.stdout).toContain("  Launching pxpipe... already running (PID: 101)\n");
      expect(normal.stdout).toContain("  Launching headroom... started (PID: 102)\n");
    }
  }
});

it("keeps GPT JSON free of console formatting, including with the up alias", () => {
  const cli = runCli(["up", "--gpt", "--json"], false, true);
  expect(cli.status).toBe(0);
  expect(cli.stderr).toBe("");
  expect(JSON.parse(cli.stdout).services.map(s => s.pid)).toEqual([100, 101, 102]);
  expect(cli.stdout).not.toContain("Launching");
  expect(cli.stdout).not.toContain("\x1b");
});

it("completes the launch line with the failure before exiting", () => {
  const cli = runCli(["start", "--gpt"], true);
  expect(cli.status).toBe(1);
  expect(cli.stdout).toContain("  Launching pxpipe... failed: test launch failure\n");
  expect(cli.stdout).not.toContain("Astra ready");
  expect(cli.stdout).not.toContain("Launching headroom");
});
