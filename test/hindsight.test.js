import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HINDSIGHT_DEFAULTS,
  hindsightConfigHash,
  hindsightRunArgs,
  normalizeHindsightConfig,
  preflightHindsight,
  probeHindsightHealth,
  readHindsightApiKey,
  saveHindsightApiKey,
} from "../src/hindsight.js";
import { ServiceManager, manager } from "../src/manager.js";
import { Dashboard } from "../src/tui.js";
import { ProxySetupWizard } from "../src/tui-proxy-setup.js";
import { normalizeProxyOptions } from "../src/proxy.js";
import { stripAnsi } from "../src/utils/format.js";

const env = { AIH_HOME: process.env.AIH_HOME, KEY: process.env.HINDSIGHT_API_LLM_API_KEY };
const home = await mkdtemp(join(tmpdir(), "aih-hindsight-"));
process.env.AIH_HOME = home;
delete process.env.HINDSIGHT_API_LLM_API_KEY;
test.after(async () => {
  if (env.AIH_HOME === undefined) delete process.env.AIH_HOME; else process.env.AIH_HOME = env.AIH_HOME;
  if (env.KEY !== undefined) process.env.HINDSIGHT_API_LLM_API_KEY = env.KEY;
  await rm(home, { recursive: true, force: true });
});

const ok = stdout => ({ exitCode: 0, stdout, stderr: "" });
const fail = stderr => ({ exitCode: 1, stdout: "", stderr });
const running = { Status: "running", Running: true, StartedAt: "2026-11-06T10:00:00Z" };
const exited = { Status: "exited", Running: false, StartedAt: "2026-11-06T10:00:00Z" };
const container = ({ labels = {}, state = exited, image = "sha256:old" } = {}) => ({
  Id: "0123456789abcdef", Image: image, Config: { Image: HINDSIGHT_DEFAULTS.image, Labels: labels }, State: state,
});

/** Docker CLI double: records argv, never touches a real daemon. */
function fakeDocker({ current = null, image = "sha256:new", available = true, runExit = 0 } = {}) {
  const calls = [];
  let state = current;
  const run = async (command, args) => {
    assert.equal(command, "docker");
    calls.push(args);
    if (!available) return fail("error during connect: the docker daemon is not running");
    switch (args[0]) {
      case "version": return ok("29.0.0\n");
      case "container": return state ? ok(JSON.stringify([state])) : fail("Error response from daemon: No such container: " + args[2]);
      case "image": return image ? ok(image + "\n") : fail("Error: No such image");
      case "pull": image = "sha256:new"; return ok("pulled");
      case "run": {
        if (runExit) return fail("port is already allocated");
        const labels = Object.fromEntries(args.flatMap((a, i) => a === "--label" ? [args[i + 1].split("=")] : []));
        state = container({ labels, state: running, image });
        return ok("0123456789abcdef\n");
      }
      case "start": state = { ...state, State: running }; return ok(args[1]);
      case "stop": if (!state) return fail("Error: No such container: x"); state = { ...state, State: exited }; return ok(args[1]);
      case "rm": state = null; return ok(args.at(-1));
      default: throw new Error("unexpected docker " + args.join(" "));
    }
  };
  return { run, calls, verbs: () => calls.map(a => a[0] === "container" || a[0] === "image" ? a[0] + " " + a[1] : a[0]), get state() { return state; } };
}

function dockerManager(docker, { health = { state: "healthy", status: "healthy", database: "connected", version: "1.1.0" }, config } = {}) {
  const m = new ServiceManager();
  let data = { services: {}, config: config ? { hindsight: config } : {} };
  m.readState = () => { const s = structuredClone(data); s.services ||= {}; delete s.services.agentmemory; return s; };
  m.loadState = m.readState;
  m.saveState = value => { data = structuredClone(value); };
  m.syncState = async () => { const s = m.readState(); await m.syncDockerService(s, "hindsight"); m.saveState(s); return s; };
  m.runDocker = docker.run;
  m.probeHealth = async url => ({ url: url + "/health", checkedAt: Date.now(), ...(typeof health === "function" ? health() : health) });
  m.hindsightPollMs = 1;
  return m;
}

const managedHash = () => hindsightConfigHash(normalizeHindsightConfig(), readHindsightApiKey().key);

test("settings validate Docker names, loopback ports and URLs; the key never reaches argv", async () => {
  assert.deepEqual(normalizeHindsightConfig(), { ...HINDSIGHT_DEFAULTS });
  assert.equal(normalizeHindsightConfig({ apiPort: "18888", llmProvider: "OpenAI" }).apiPort, 18888);
  for (const bad of [{ containerName: "bad name" }, { apiPort: 0 }, { uiPort: "x" }, { apiPort: 9999 },
    { image: "img with space" }, { llmBaseUrl: "ftp://x" }, { llmBaseUrl: "http://u:p@host" }, { llmModel: "a b" }, { volume: "../x" }]) {
    assert.throws(() => normalizeHindsightConfig(bad), /Hindsight/);
  }
  const config = normalizeHindsightConfig({ llmModel: "gpt-x", llmBaseUrl: "http://host.docker.internal:10100/v1", envFile: "C:/x/extra.env" });
  const args = hindsightRunArgs(config, { configHash: "h", keySource: "env" });
  assert.deepEqual(args.slice(0, 4), ["run", "-d", "--name", "hindsight"]);
  for (const expected of ["127.0.0.1:8888:8888", "127.0.0.1:9999:9999", "hindsight-data:/home/hindsight/.pg0", "io.aih.managed=true",
    "io.aih.config=h", "HINDSIGHT_API_LLM_MODEL=gpt-x", "HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:10100/v1", "HINDSIGHT_API_LLM_API_KEY", "C:/x/extra.env"]) {
    assert.ok(args.includes(expected), expected);
  }
  assert.equal(args.at(-1), HINDSIGHT_DEFAULTS.image);
  saveHindsightApiKey("sk-secret");
  assert.deepEqual(readHindsightApiKey(), { key: "sk-secret", source: "file" });
  assert.equal(await readFile(join(home, "hindsight.env"), "utf8"), "HINDSIGHT_API_LLM_API_KEY=sk-secret\n");
  const fileArgs = hindsightRunArgs(config, { configHash: "h", keySource: "file" }).join(" ");
  assert.ok(!fileArgs.includes("sk-secret"));
  assert.ok(fileArgs.includes("--env-file " + join(home, "hindsight.env")));
  assert.throws(() => saveHindsightApiKey("two\nlines"), /API key/);
  assert.notEqual(hindsightConfigHash(config, "a"), hindsightConfigHash(config, "b"));
});

test("health probe: 200 healthy, other HTTP degraded, no answer unreachable", async () => {
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const healthy = await probeHindsightHealth("http://127.0.0.1:8888", { fetchImpl: async url => url.endsWith("/live")
    ? reply(200, { status: "alive", version: "1.1.0", uptime_seconds: 125 })
    : reply(200, { status: "healthy", database: "connected" }) });
  assert.deepEqual({ ...healthy, checkedAt: 0 }, { state: "healthy", httpStatus: 200, status: "healthy", database: "connected",
    version: "1.1.0", uptimeSeconds: 125, url: "http://127.0.0.1:8888/health", checkedAt: 0 });
  const degraded = await probeHindsightHealth("http://127.0.0.1:8888", { fetchImpl: async () => reply(503, { status: "unhealthy", database: "disconnected" }) });
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.database, "disconnected");
  const notHealthy = await probeHindsightHealth("http://127.0.0.1:8888", { fetchImpl: async () => reply(200, { status: "unhealthy" }) });
  assert.equal(notHealthy.state, "degraded");
  const down = await probeHindsightHealth("http://127.0.0.1:8888", { fetchImpl: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } });
  assert.equal(down.state, "unreachable");
  assert.equal(down.error, "ECONNREFUSED");
});

test("start creates a missing container (pull, run) and succeeds only after /health", async () => {
  const docker = fakeDocker({ image: null });
  const m = dockerManager(docker);
  const result = await m.startService("hindsight");
  assert.equal(result.success, true, result.message);
  assert.match(result.message, /created; health: healthy v1\.1\.0/);
  assert.deepEqual(docker.verbs(), ["version", "container inspect", "image inspect", "pull", "run", "container inspect"]);
  const run = docker.calls.find(a => a[0] === "run");
  assert.ok(!run.join(" ").includes("sk-secret"));
  assert.ok(run.includes("io.aih.config=" + managedHash()));
  const saved = m.readState().services.hindsight;
  assert.equal(saved.status, "running");
  assert.equal(saved.pid, undefined);
  assert.equal(saved.apiUrl, "http://127.0.0.1:8888");
  assert.equal(saved.url, "http://localhost:9999");
});

test("start reuses foreign containers, recreates changed aih containers and reports running ones", async () => {
  const foreign = fakeDocker({ current: container({ labels: { "com.docker.compose.project": "hindsight" } }) });
  assert.equal((await dockerManager(foreign).startService("hindsight")).success, true);
  assert.deepEqual(foreign.verbs(), ["version", "container inspect", "start", "container inspect"]);

  const changed = fakeDocker({ current: container({ labels: { "io.aih.managed": "true", "io.aih.config": "old" } }) });
  const recreated = await dockerManager(changed).startService("hindsight");
  assert.match(recreated.message, /recreated/);
  assert.deepEqual(changed.verbs(), ["version", "container inspect", "rm", "image inspect", "run", "container inspect"]);
  assert.deepEqual(changed.calls.find(a => a[0] === "rm"), ["rm", "hindsight"]); // never -v: the volume keeps data

  const live = fakeDocker({ current: container({ state: running }) });
  const already = await dockerManager(live).startService("hindsight");
  assert.equal(already.alreadyRunning, true);
  assert.match(already.message, /already running \| health: healthy/);
  assert.ok(!live.verbs().includes("start"));
});

test("start fails clearly without Docker, key, health or a free port", async () => {
  const down = fakeDocker({ available: false });
  const noDocker = await dockerManager(down).startService("hindsight");
  assert.equal(noDocker.success, false);
  assert.match(noDocker.message, /Docker is not available.*Start Docker Desktop/);

  await rm(join(home, "hindsight.env"), { force: true });
  const missingKey = fakeDocker();
  const noKey = await dockerManager(missingKey).startService("hindsight");
  assert.match(noKey.message, /needs an LLM API key/);
  assert.ok(!missingKey.verbs().includes("run"));
  const local = fakeDocker();
  assert.equal((await dockerManager(local, { config: { llmProvider: "ollama" } }).startService("hindsight")).success, true);
  saveHindsightApiKey("sk-secret");

  const busy = fakeDocker({ runExit: 1 });
  assert.match((await dockerManager(busy).startService("hindsight")).message, /docker run failed: port is already allocated/);

  const sick = fakeDocker();
  const m = dockerManager(sick, { health: { state: "degraded", httpStatus: 503, database: "disconnected" } });
  m.hindsightStartTimeoutMs = 0;
  const unhealthy = await m.startService("hindsight");
  assert.equal(unhealthy.success, false);
  assert.match(unhealthy.message, /\/health is unhealthy \(HTTP 503, database disconnected\)/);
});

test("stop uses docker stop only and sync tracks container state instead of PIDs", async () => {
  const docker = fakeDocker({ current: container({ state: running }) });
  const m = dockerManager(docker);
  const stopped = await m.stopService("hindsight");
  assert.equal(stopped.success, true);
  assert.match(stopped.message, /stopped \(data kept\)/);
  assert.deepEqual(docker.calls.filter(a => a[0] === "stop"), [["stop", "hindsight"]]);
  assert.equal(m.readState().services.hindsight.status, "stopped");

  const down = fakeDocker({ available: false });
  const offline = dockerManager(down);
  const state = offline.readState();
  assert.equal(await offline.syncDockerService(state, "hindsight"), true);
  assert.equal(state.services.hindsight.status, "stopped");
  assert.match(state.services.hindsight.runtimeError, /daemon is not running/);
  const calls = down.calls.length;
  await offline.syncDockerService(state, "hindsight");
  assert.equal(down.calls.length, calls, "a stopped Docker is not polled every second");
});

test("legacy agentmemory entries are dropped and saved selections migrate", async () => {
  const m = new ServiceManager();
  m.saveState({ services: { agentmemory: { id: "agentmemory", status: "running", pid: 1 } }, config: { startServices: ["agentmemory", "proxy"] } });
  const state = m.readState();
  assert.equal(state.services.agentmemory, undefined);
  assert.ok(state.services.hindsight);
  assert.deepEqual(new ProxySetupWizard(state, { keyStatus: null }).draft.startServices, "hindsight,proxy");
});

test("update pulls and recreates only aih containers", async () => {
  const foreign = fakeDocker({ current: container({ state: running, labels: { "com.docker.compose.project": "hindsight" } }) });
  const refused = await dockerManager(foreign).updateService("hindsight");
  assert.equal(refused.success, false);
  assert.match(refused.message, /not created by aih \(docker compose project 'hindsight'\)/);
  assert.ok(!foreign.verbs().includes("pull"));

  const labels = { "io.aih.managed": "true", "io.aih.config": managedHash() };
  const current = fakeDocker({ current: container({ state: running, labels, image: "sha256:new" }) });
  assert.equal((await dockerManager(current).updateService("hindsight")).alreadyUpToDate, true);
  assert.ok(!current.verbs().includes("rm"));

  let version = "1.1.0";
  const outdated = fakeDocker({ current: container({ state: running, labels }) });
  const m = dockerManager(outdated, { health: () => ({ state: "healthy", version }) });
  const pull = outdated.run;
  m.runDocker = async (command, args) => { if (args[0] === "pull") version = "1.2.0"; return pull(command, args); };
  const updated = await m.updateService("hindsight");
  assert.equal(updated.success, true, updated.message);
  assert.match(updated.message, /updated from 1\.1\.0 to 1\.2\.0 and restarted/);
  assert.deepEqual(outdated.calls.find(a => a[0] === "rm"), ["rm", "-f", "hindsight"]);
  assert.equal(m.updatesInProgress.size, 0);
});

test("setup shows Hindsight fields only when selected and never renders the key", () => {
  const state = { services: {}, config: { startServices: ["ocx", "proxy"] } };
  const w = new ProxySetupWizard(state, { keyStatus: "file" });
  assert.equal(w.fields.some(f => f.key.startsWith("hindsight")), false);
  assert.equal(w.hindsightSettings(), null);
  w.draft.startServices = "ocx,hindsight,proxy";
  const keys = w.fields.map(f => f.key);
  assert.ok(keys.indexOf("hindsightContainer") > keys.indexOf("startServices"));
  w.step = keys.indexOf("hindsightApiKey");
  for (const c of "sk-very-secret") w.handle(c);
  const page = w.lines(100, 40).join("\n");
  assert.ok(!page.includes("sk-very-secret"));
  assert.match(page, /> \*{14}\|/);
  assert.match(page, /Current setting: key saved/);
  w.handle("\r");
  w.step = keys.indexOf("hindsightApiPort");
  w.draft.hindsightApiPort = "9999";
  w.handle("\r");
  assert.match(w.error, /must differ/);
  w.draft.hindsightApiPort = "18888";
  w.draft.hindsightLlmBaseUrl = "http://host.docker.internal:10100/v1";
  w.step = w.fields.length;
  const summary = w.lines(120, 60).join("\n");
  assert.ok(!summary.includes("sk-very-secret"));
  assert.match(summary, /\* LLM API key: new key \(hidden\)/);
  assert.match(summary, /\* API port: 18888 \(previous: 8888\)/);
  assert.deepEqual(w.hindsightSettings(), {
    config: normalizeHindsightConfig({ apiPort: 18888, llmBaseUrl: "http://host.docker.internal:10100/v1" }), apiKey: "sk-very-secret" });
});

test("dashboard forwards Hindsight settings and runs Docker preflight on check", async t => {
  const calls = [];
  t.mock.method(manager, "saveProxyConfiguration", (config, setup) => { calls.push(setup); return { success: true }; });
  const d = new Dashboard();
  d.refresh = async () => {};
  const options = normalizeProxyOptions({ upstream: "http://127.0.0.1:10100", listen: "http://127.0.0.1:0" });
  d.proxySetup = new ProxySetupWizard({ services: { proxy: { id: "proxy", status: "stopped", proxyOptions: options } } }, { keyStatus: null });
  d.proxySetup.draft.startServices = "hindsight,proxy";
  d.proxySetup.draft.hindsightApiKey = "sk-new";
  d.proxySetup.step = d.proxySetup.fields.length;
  await d.runProxySetupAction("save");
  assert.deepEqual(calls.at(-1), { startServices: ["hindsight", "proxy"], hindsight: { config: normalizeHindsightConfig(), apiKey: "sk-new" } });
});

test("preflight reports Docker, key, container ownership and health without changing anything", async () => {
  const foreign = fakeDocker({ current: container({ state: running, labels: { "com.docker.compose.project": "hindsight" } }) });
  const checks = await preflightHindsight(normalizeHindsightConfig(), { run: foreign.run, probe: async () => ({ state: "healthy", version: "1.1.0" }) });
  assert.ok(checks.includes("Docker 29.0.0 available"));
  assert.ok(checks.some(c => /running, not created by aih \(compose project 'hindsight'\)/.test(c)));
  assert.ok(checks.includes("Health: healthy v1.1.0"));
  assert.deepEqual(foreign.verbs(), ["version", "container inspect"]);
  const missing = fakeDocker({ image: null });
  const fresh = await preflightHindsight(normalizeHindsightConfig({ llmProvider: "anthropic" }), { run: missing.run, readKey: () => ({ key: "", source: null }), isPortFree: async port => port !== 9999 });
  assert.ok(fresh.some(c => /API key missing; provider 'anthropic'/.test(c)));
  assert.ok(fresh.some(c => /not present: pulled on first start/.test(c)));
  assert.ok(fresh.includes("Warning: UI port 9999 already in use"));
  const offline = await preflightHindsight(normalizeHindsightConfig(), { run: fakeDocker({ available: false }).run });
  assert.match(offline[0], /Docker not available/);
});

test("dashboard reads every service's health on its own cadence and renders every state", async () => {
  const { columns, rows } = process.stdout;
  const probes = [];
  const d = new Dashboard({ getVersions: async () => ({}), getHealth: async svc => {
    probes.push(svc.id);
    return { state: svc.id === "headroom" ? "degraded" : svc.id === "proxy" ? "unverified" : "healthy", checkedAt: Date.now() };
  } });
  d.running = false;
  d.statuses = [
    { id: "ocx", status: "running", pid: 1, uptime: "1m", url: "http://localhost:10100" },
    { id: "headroom", status: "running", pid: 2, uptime: "1m", url: "http://localhost:8787/dashboard" },
    { id: "proxy", status: "running", pid: 3, uptime: "1m", url: "http://127.0.0.1:10102" },
    { id: "custom", status: "running", pid: 4, uptime: "1m", url: "http://localhost:1" },
    { id: "hindsight", runtime: "docker", status: "running", containerId: "0123456789ab", containerName: "hindsight", uptime: "1h", url: "http://localhost:9999", apiUrl: "http://127.0.0.1:8888" },
  ];
  const H = 4;
  try {
    process.stdout.columns = 160;
    process.stdout.rows = 40;
    await d.refreshHealth();
    await d.refreshHealth();
    assert.deepEqual(probes, ["ocx", "headroom", "proxy", "hindsight"], "probed once per cadence; unknown services skipped");
    let screen = d.buildLines().map(stripAnsi);
    assert.match(screen[2], /HEALTH.*UPTIME\s+LAST CHECK\s+REPO/);
    const row = (id = "hindsight") => d.buildLines().map(stripAnsi).find(l => new RegExp("^\\S?\\s+" + id + "\\s").test(l));
    assert.match(row(), /RUNNING\s+ok\s.*1h\s+0s ago/);
    assert.match(row("ocx"), /RUNNING\s+ok\s.*1m\s+0s ago/);
    assert.match(row("headroom"), /RUNNING\s+degraded\s/);
    assert.match(row("proxy"), /RUNNING\s+unverified\s/);
    assert.match(row("custom"), /RUNNING\s+-\s.*1m\s+-\s/);
    // No extra rows below the table: links and health details live in the columns.
    assert.ok(!screen.some(l => /\/health|GitHub \(g\):|URL:/.test(l)));

    d.statuses[H] = { ...d.statuses[H], status: "stopped", containerId: undefined, containerStatus: "missing" };
    await d.refreshHealth();
    assert.equal(probes.filter(id => id === "hindsight").length, 1, "stopped services are not probed");
    assert.match(row(), /STOPPED\s+stopped\s+n\/a\s+n\/a\s+-\s+-\s+-\s/);

    d.statuses[H] = { ...d.statuses[H], runtimeError: "docker daemon is not running" };
    await d.refreshHealth();
    assert.match(row(), /no docker/);

    d.getHealth = async () => { throw new Error("boom"); };
    d.statuses[H] = { ...d.statuses[H], status: "running", runtimeError: undefined, containerId: "x" };
    await d.refreshHealth();
    assert.match(row(), /unreachable\s.*0s ago/);
    d.health.hindsight.checkedAt -= 60000;
    assert.match(row(), /1m ago/);
  } finally {
    process.stdout.columns = columns;
    process.stdout.rows = rows;
  }
});
