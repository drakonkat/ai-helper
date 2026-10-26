import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { ServiceManager, manager } from "../src/manager.js";
import { Dashboard, splitKeys, KeyDecoder } from "../src/tui.js";
import { ProxySetupWizard } from "../src/tui-proxy-setup.js";
import { PROXY_FIELDS, proxySetupDraft, normalizeSetupDraft, preflightProxy } from "../src/proxy-setup.js";
import { normalizeProxyOptions } from "../src/proxy.js";
import { PRESETS } from "../src/proxy-presets.js";
import { DEFAULT_START_SERVICES, STARTUP_SERVICE_IDS, normalizeStartServices } from "../src/startup-services.js";

const options = extra => normalizeProxyOptions({ upstream: "http://127.0.0.1:10100", listen: "http://127.0.0.1:0", ...extra });
const state = extra => ({ services: { proxy: { id: "proxy", status: "stopped", proxyOptions: options() } }, ...extra });
function memoryManager(initial) {
  const m = new ServiceManager();
  let data = structuredClone(initial);
  m.readState = m.loadState = () => structuredClone(data);
  m.saveState = value => { data = structuredClone(value); };
  m.syncState = async () => m.readState();
  return m;
}
function summary(wizard) { wizard.step = wizard.fields.length; return wizard; }

test("startup selection validates services and puts dependencies before the proxy", () => {
  assert.deepEqual(normalizeStartServices(), DEFAULT_START_SERVICES);
  assert.deepEqual(normalizeStartServices(["proxy", "headroom", "ocx", "ocx"]), ["ocx", "headroom", "proxy"]);
  for (const invalid of [[], ["unknown"], "ocx", null]) assert.throws(() => normalizeStartServices(invalid), /Select at least one/);
});

test("startup step toggles multiple services, preserves edits on back and detects cancellation", () => {
  const w = new ProxySetupWizard(state());
  w.step = w.fields.length - 1;
  assert.equal(w.field.key, "startServices");
  assert.equal(w.draft.startServices, DEFAULT_START_SERVICES.join(","));
  assert.match(w.lines(100, 40).join("\n"), /> \[x\] ocx/);
  w.handle(" ");
  w.handle("\x1b[B"); w.handle(" ");
  w.handle("\x1b[B"); w.handle(" ");
  assert.equal(w.draft.startServices, "pxpipe,proxy");
  assert.equal(w.dirty, true);
  w.handle("\x1b[Z"); w.handle("\r");
  assert.equal(w.field.key, "startServices");
  assert.equal(w.draft.startServices, "pxpipe,proxy");
  w.handle("\r");
  assert.equal(w.summary, true);
  assert.match(w.lines(100, 40).join("\n"), /Services started by aih start \/ up: pxpipe,proxy/);
  w.handle("\x1b"); assert.equal(w.cancelPending, true);
  assert.equal(w.handle("\r"), "cancel");
  const empty = new ProxySetupWizard(state());
  empty.step = empty.fields.length - 1;
  empty.draft.startServices = "";
  empty.handle("\r");
  assert.equal(empty.summary, false);
  assert.match(empty.error, /Select at least one/);
});

test("startup preferences persist with setup, without changing running services", async () => {
  const initial = state();
  const m = memoryManager(initial);
  const selection = ["proxy", "ocx", "headroom"];
  m.saveProxyConfiguration(options(), { startServices: selection });
  assert.deepEqual(m.readState().config.startServices, ["ocx", "headroom", "proxy"]);
  assert.deepEqual(m.readState().services, initial.services);
  assert.deepEqual(new ProxySetupWizard(m.readState()).draft.startServices, "ocx,headroom,proxy");
  assert.throws(() => m.saveProxyConfiguration(options(), { startServices: [] }), /Select at least one/);
  assert.deepEqual(m.readState().config.startServices, ["ocx", "headroom", "proxy"]);
  m.startService = async () => ({ success: true });
  await m.applyProxyConfiguration(options(), { startServices: ["ocx"], preflight: async () => [] });
  assert.deepEqual(m.readState().config.startServices, ["ocx"]);
  assert.equal(STARTUP_SERVICE_IDS.includes("rtk"), false);
});

test("dashboard forwards startup selection for both save and apply", async t => {
  const calls = [];
  t.mock.method(manager, "saveProxyConfiguration", (config, setup) => { calls.push(["save", setup]); return { success: true }; });
  t.mock.method(manager, "applyProxyConfiguration", async (config, setup) => { calls.push(["apply", setup]); return { success: true }; });
  for (const command of ["save", "apply"]) {
    const d = new Dashboard();
    d.refresh = async () => {};
    d.proxySetup = summary(new ProxySetupWizard(state()));
    d.proxySetup.draft.startServices = "ocx,headroom,proxy";
    await d.runProxySetupAction(command);
    assert.equal(d.proxySetup, null);
    assert.deepEqual(calls.at(-1), [command, { startServices: ["ocx", "headroom", "proxy"] }]);
  }
});

test("schema covers all normalized runtime parameters and every recipe", () => {
  assert.deepEqual(PROXY_FIELDS.map(f => f.key).sort(), Object.keys(options()).sort());
  for (const preset of PRESETS) {
    const w = new ProxySetupWizard(state());
    w.draft.preset = preset;
    assert.equal(w.validate().preset, preset);
    for (const f of w.fields) if (f.stage) assert.ok(preset.split("-").includes(f.stage));
  }
});

test("draft precedence and empty/reset values", () => {
  const s = state({ config: { pxpipeModels: "legacy", proxyOptions: options({ models: "*", preset: "rtk" }) } });
  const draft = proxySetupDraft(s);
  assert.equal(draft.models, "*");
  assert.equal(draft.preset, "rtk");
  draft.models = draft.rtkFilter = draft.interceptor = "";
  const normalized = normalizeSetupDraft(draft);
  assert.equal(normalized.models, undefined);
  assert.equal(normalized.interceptor, undefined);
  assert.equal(normalized.rtkFilter, undefined);
});

test("wizard separates editable draft, initial value and actual configuration for every field", () => {
  const s = state({ config: { proxyOptions: options({ upstream: "http://127.0.0.1:11000", preset: "rtk-headroom-pxpipe" }) } });
  s.services.proxy.status = "running";
  const w = new ProxySetupWizard(s);
  w.draft.upstream = "http://127.0.0.1:12000";
  w.cursor = w.draft.upstream.length;
  const screen = w.lines(100, 30).join("\n");
  assert.match(screen, /PROXY SETUP \| Connection/);
  assert.match(screen, /Initial value: http:\/\/127\.0\.0\.1:11000\//);
  assert.match(screen, /Current setting: http:\/\/127\.0\.0\.1:10100\//);
  assert.match(screen, /> http:\/\/127\.0\.0\.1:12000/);
  for (let i = 0; i < w.fields.length; i++) {
    w.step = i;
    const page = w.lines(100, 40).join("\n");
    assert.match(page, /Initial value:/);
    assert.match(page, /Current setting:/);
  }
  const stopped = new ProxySetupWizard(state());
  assert.match(stopped.lines(100, 30).join("\n"), /Current setting: .*\(proxy stopped\)/);
  const fresh = new ProxySetupWizard({ services: {} });
  assert.match(fresh.lines(100, 30).join("\n"), /Current setting: \(not configured\)/);
});

test("current settings remain reachable on short screens", () => {
  const w = new ProxySetupWizard(state());
  w.lines(40, 12);
  for (let i = 0; i < 6; i++) { w.handle("\x1b[6~"); w.lines(40, 12); }
  assert.match(w.lines(40, 12).join("\n"), /Current setting:/);
});

test("dashboard refresh updates current settings without replacing the initial value or draft", async t => {
  const dashboard = new Dashboard({ getVersions: async () => ({}), getProxyStats: async () => null });
  dashboard.proxySetup = new ProxySetupWizard(state());
  const initial = dashboard.proxySetup.initial.upstream;
  dashboard.proxySetup.draft.upstream = "http://127.0.0.1:12000";
  t.mock.method(manager, "getStatus", async () => [{ id: "proxy", status: "running", proxyOptions: options({ upstream: "http://127.0.0.1:13000" }) }]);
  await dashboard.refresh();
  assert.equal(dashboard.proxySetup.active.upstream, "http://127.0.0.1:13000/");
  assert.equal(dashboard.proxySetup.initial.upstream, initial);
  assert.equal(dashboard.proxySetup.draft.upstream, "http://127.0.0.1:12000");
});

test("wizard validates, supports text editing and keeps q/s as text", () => {
  const w = new ProxySetupWizard({ services: {} });
  w.handle("\r");
  assert.equal(w.step, 0);
  assert.ok(w.error);
  for (const c of "http://localhost:10100") w.handle(c);
  w.handle("\r");
  assert.equal(w.step, 1);
  w.handle("\x15");
  for (const c of "http://localhost:10200") w.handle(c);
  w.handle("\x1b[D"); w.handle("\x7f"); w.handle("1");
  assert.match(w.draft.listen, /10210$/);
  w.handle("\x1b[Z");
  assert.equal(w.step, 0);
  w.handle("q"); w.handle("s");
  assert.match(w.draft.upstream, /qs$/);
});

test("wizard cancellation requires confirmation only for edits; no persistence", () => {
  const s = state();
  const w = new ProxySetupWizard(s);
  assert.equal(w.handle("\x1b"), "cancel");
  w.handle("x");
  w.handle("\x1b");
  assert.equal(w.cancelPending, true);
  w.handle("n");
  assert.equal(w.cancelPending, false);
  w.handle("\x1b");
  assert.equal(w.handle("\r"), "cancel");
  assert.equal(s.services.proxy.proxyOptions.upstream, options().upstream);
});

test("summary actions and short terminal rendering remain reachable", () => {
  const w = summary(new ProxySetupWizard(state()));
  assert.equal(w.handle("\r"), "check");
  w.handle("\x1b[B"); assert.equal(w.handle("\r"), "save");
  w.handle("\x1b[B"); assert.equal(w.handle("\r"), "apply");
  for (const width of [40, 80, 120]) {
    for (const height of [12, 24, 40]) {
      const lines = w.lines(width, height);
      assert.ok(lines.length <= height);
      assert.ok(lines.every(line => Array.from(line).length <= width));
      assert.match(lines.join("\n"), /Save only/);
      assert.match(lines.join("\n"), /Save and apply now/);
    }
  }
});

test("escape parser keeps CSI, paste markers and unicode intact", () => {
  assert.deepEqual(splitKeys("\x1b[A\x1b[3~\x1b[200~q😀\x1b[201~"), ["\x1b[A", "\x1b[3~", "\x1b[200~", "q", "😀", "\x1b[201~"]);
  const w = new ProxySetupWizard(state());
  w.handle("\x15");
  for (const k of splitKeys("\x1b[200~http://localhost:10100\nq\x1b[201~")) w.handle(k);
  assert.equal(w.step, 0);
  assert.match(w.draft.upstream, /q$/);
});

test("fragmented stdin sequences and standalone Escape", () => {
  const keys = [];
  const decoder = new KeyDecoder(key => keys.push(key));
  decoder.push("\x1b["); decoder.push("20"); decoder.push("0~hello\x1b[201"); decoder.push("~");
  assert.deepEqual(keys, ["\x1b[200~", ..."hello", "\x1b[201~"]);
  decoder.push("\x1b"); decoder.flush();
  assert.equal(keys.at(-1), "\x1b");
  decoder.dispose();
  const w = new ProxySetupWizard(state());
  w.handle("😀"); w.handle("\x7f");
  assert.equal(w.draft.upstream, w.initial.upstream);
});

test("save-only preserves live runtime and stores desired config separately", () => {
  const s = state(); s.services.proxy.status = "running"; s.services.proxy.pid = 123;
  const m = memoryManager(s);
  assert.equal(m.saveProxyConfiguration(options({ models: "*", preset: "pxpipe" })).success, true);
  assert.deepEqual(m.readState().services.proxy, s.services.proxy);
  assert.equal(m.readState().config.proxyOptions.models, "*");
});

test("apply validates before stop; startup failure recovers previous runtime", async () => {
  const s = state(); s.services.proxy.status = "running";
  const m = memoryManager(s);
  const calls = [];
  m.stopService = async () => { calls.push("stop"); return { success: true }; };
  m.startService = async (id, config) => {
    calls.push(config.preset);
    if (config.preset === "rtk") throw new Error("bad filter");
    return { success: true };
  };
  await assert.rejects(m.applyProxyConfiguration(options(), { preflight: async () => { throw new Error("missing rtk"); } }), /missing rtk/);
  assert.deepEqual(calls, []);
  const result = await m.applyProxyConfiguration(options({ preset: "rtk" }), { preflight: async () => [] });
  assert.equal(result.success, false);
  assert.match(result.message, /Previous configuration restored/);
  assert.deepEqual(calls, ["stop", "rtk", "stop", "none"]);
  assert.equal(m.proxySetupBusy, false);
});

test("apply stopped proxy, repeated submit guard, stop and recovery failures", async () => {
  const m = memoryManager(state());
  m.startService = async () => ({ success: true });
  const result = await m.applyProxyConfiguration(options({ models: "*" }), { preflight: async () => [] });
  assert.equal(result.success, true);
  assert.equal(m.readState().config.proxyOptions.models, "*");
  m.proxySetupBusy = true;
  assert.equal((await m.applyProxyConfiguration(options())).success, false);
  m.proxySetupBusy = false;
  const s = state(); s.services.proxy.status = "running";
  const failing = memoryManager(s);
  failing.stopService = async () => ({ success: false, message: "stop denied" });
  const blocked = await failing.applyProxyConfiguration(options({ preset: "rtk-headroom-pxpipe", models: "*" }), { preflight: async () => [] });
  assert.equal(blocked.success, false);
  assert.equal(blocked.saved, true);
  assert.equal(blocked.applied, false);
  assert.match(blocked.message, /Configuration saved, but not applied/);
  assert.match(blocked.message, /stop denied/);
  assert.match(blocked.message, /same permissions/);
  assert.equal(failing.readState().config.proxyOptions.preset, "rtk-headroom-pxpipe");
  assert.deepEqual(failing.readState().services.proxy, s.services.proxy);
  failing.stopService = async () => ({ success: true });
  failing.startService = async () => { throw new Error("cannot start"); };
  assert.match((await failing.applyProxyConfiguration(options(), { preflight: async () => [] })).message, /Recovery failed/);
});

test("preflight checks port, dependencies, interceptor, advisory endpoints", async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const listen = `http://127.0.0.1:${server.address().port}`;
  const fakeFetch = async () => new Response(null, { status: 401 });
  await assert.rejects(preflightProxy(options({ listen }), null, { fetchImpl: fakeFetch }), /Listen port/);
  const checks = await preflightProxy(options({ listen }), { status: "running", url: listen }, { fetchImpl: fakeFetch });
  assert.ok(checks.some(c => c.includes("Current listener")));
  assert.ok(checks.some(c => c.includes("401")));
  await assert.rejects(preflightProxy(options({ preset: "rtk" }), null, { run: async () => { throw new Error("missing RTK"); } }), /missing RTK/);
  const dir = await mkdtemp(join(tmpdir(), "aih-setup-"));
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("aih-setup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const interceptor = join(dir, "hooks.mjs");
  await writeFile(interceptor, "throw new Error('must not execute');");
  const verified = await preflightProxy(options({ interceptor, preset: "rtk-headroom-pxpipe" }), null, {
    run: async () => ({}), fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(verified.filter(c => c.startsWith("Warning")).length, 2);
});

test("real worker: empty resets survive disk; pending save is distinct; failed apply restores worker", { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "aih-setup-worker-"));
  assert.equal(dirname(resolve(home)), resolve(tmpdir()));
  assert.ok(basename(home).startsWith("aih-setup-worker-"));
  const env = { AIH_HOME: process.env.AIH_HOME, AIH_CODEX_AUTOCONFIG: process.env.AIH_CODEX_AUTOCONFIG };
  process.env.AIH_HOME = home;
  process.env.AIH_CODEX_AUTOCONFIG = "0";
  const m = new ServiceManager();
  m.syncState = async () => m.loadState();
  t.after(async () => {
    try { await m.stopService("proxy"); }
    finally {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  });
  const initial = m.readState();
  initial.config = { pxpipeModels: "legacy-model" };
  m.saveState(initial);
  m.saveProxyConfiguration(options());
  assert.equal(m.readState().config.proxyOptions.models, "");
  const started = await m.applyProxyConfiguration(options(), { preflight: async () => [] });
  assert.equal(started.success, true);
  const before = m.readState().services.proxy;
  assert.equal(before.proxyOptions.models, undefined);
  m.saveProxyConfiguration(options({ models: "pending-model" }));
  assert.equal(m.readState().services.proxy.pid, before.pid);
  const interceptor = join(home, "broken.mjs");
  await writeFile(interceptor, "this is not valid JavaScript !!!");
  const failed = await m.applyProxyConfiguration(options({ interceptor }), { preflight: async () => [] });
  assert.equal(failed.success, false);
  assert.match(failed.message, /Previous configuration restored/);
  const recovered = m.readState();
  assert.equal(recovered.services.proxy.status, "running");
  assert.notEqual(recovered.services.proxy.pid, before.pid);
  assert.equal(recovered.services.proxy.proxyOptions.interceptor, undefined);
  assert.equal(recovered.services.proxy.proxyOptions.models, undefined);
  assert.equal(recovered.config.proxyOptions.models, "pending-model");
});

test("dashboard setup available without selected service; global shortcuts isolated", t => {
  t.mock.method(manager, "readState", () => state());
  const dashboard = new Dashboard();
  dashboard.onKey("c");
  assert.ok(dashboard.proxySetup);
  dashboard.onKey("q");
  assert.match(dashboard.proxySetup.draft.upstream, /q/);
  dashboard.busy = true;
  const before = dashboard.proxySetup.draft.upstream;
  dashboard.onKey("s");
  assert.equal(dashboard.proxySetup.draft.upstream, before);
});
