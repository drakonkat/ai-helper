import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ServiceManager } from "../src/manager.js";
import { SERVICES } from "../src/config.js";

test("manager start/restart ocx reapplies proxy config after late ocx writes, without touching external services", { timeout: 40000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "aih codex manager-"));
  const oldEnv = { AIH_HOME: process.env.AIH_HOME, CODEX_HOME: process.env.CODEX_HOME, AIH_CODEX_AUTOCONFIG: process.env.AIH_CODEX_AUTOCONFIG };
  const oldOcx = { ...SERVICES.ocx };
  const manager = new ServiceManager();
  // No OS discovery or real ocx stop command in this fixture.
  manager.syncState = async () => manager.loadState();
  process.env.AIH_HOME = join(dir, ".aih");
  process.env.CODEX_HOME = join(dir, ".codex");
  process.env.AIH_CODEX_AUTOCONFIG = "1";
  SERVICES.ocx.stopCommand = undefined;
  SERVICES.ocx.ports = [];
  t.after(async () => {
    try {
      await manager.stopService("ocx");
      await manager.stopService("proxy");
    } finally {
      Object.assign(SERVICES.ocx, oldOcx);
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const target = resolve(dir);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("aih codex manager-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  await mkdir(process.env.CODEX_HOME);
  const configPath = join(process.env.CODEX_HOME, "config.toml");
  const reserve = http.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const ocxUrl = `http://127.0.0.1:${port}`;
  const directConfig = `# preserve this\nopenai_base_url = "${ocxUrl}/v1"\nexperimental_realtime_ws_base_url = "${ocxUrl}/v1"\n[features]\nkeep = true\n`;
  await writeFile(configPath, directConfig);
  const script = join(dir, "fake-ocx.mjs");
  await writeFile(script, `
    import http from 'node:http';
    import {writeFileSync} from 'node:fs';
    let ready = false;
    http.createServer((req, res) => {
      res.writeHead(req.url === '/readyz' && !ready ? 503 : 200, {'content-type': 'application/json'});
      res.end(JSON.stringify({service:'opencodex', status:ready ? 'ready' : 'pending'}));
    }).listen(${port}, '127.0.0.1');
    setTimeout(() => { writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(directConfig)}); ready = true; }, 3000);
  `);
  SERVICES.ocx.command = `"${process.execPath}" "${script}"`;
  SERVICES.ocx.defaultUrl = ocxUrl;

  const proxy = await manager.startService("proxy", { upstream: ocxUrl, listen: "http://127.0.0.1:0" });
  assert.equal(proxy.codexConfig.status, "updated");
  const check = async () => {
    const text = await readFile(configPath, "utf8");
    assert.ok(text.includes(`openai_base_url = "${proxy.url}/v1"`));
    assert.ok(text.includes(`experimental_realtime_ws_base_url = "${proxy.url}/v1"`));
    assert.ok(text.includes("[features]\nkeep = true"));
  };
  const started = await manager.startService("ocx");
  assert.equal(started.success, true);
  assert.equal(started.codexConfig.status, "updated");
  await check();
  assert.equal(await readFile(configPath + ".aih.bak", "utf8"), directConfig);

  await writeFile(configPath, directConfig);
  const already = await manager.startService("ocx");
  assert.equal(already.alreadyRunning, true);
  assert.equal(already.codexConfig.status, "updated");
  await check();

  const restarted = await manager.restartService("ocx");
  assert.equal(restarted.success, true);
  assert.equal(restarted.codexConfig.status, "updated");
  await check();
  await manager.stopService("proxy");
  await writeFile(configPath, directConfig);
  assert.equal((await manager.startService("ocx")).codexConfig.status, "skipped");
  assert.equal(await readFile(configPath, "utf8"), directConfig);

  // A failed ocx start must not trigger a configuration attempt.
  await manager.stopService("ocx");
  SERVICES.ocx.command = `"${process.execPath}" -e "process.exit(1)"`;
  const failed = await manager.startService("ocx");
  assert.equal(failed.success, false);
  assert.equal(failed.codexConfig, undefined);
  assert.equal(await readFile(configPath, "utf8"), directConfig);
});
