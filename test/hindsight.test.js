import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HINDSIGHT_DEFAULTS,
  LOCAL_LLM_DEFAULTS,
  hindsightConfigHash,
  hindsightRunArgs,
  localLlmConfigHash,
  localLlmRunArgs,
  normalizeLocalLlmConfig,
  normalizeHindsightConfig,
  preflightHindsight,
  probeHindsightHealth,
  probeLocalLlmHealth,
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
const IMAGE_ENV = ["PATH=/usr/bin", "HINDSIGHT_API_PORT=8888", "HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:8888"];

/** Docker CLI double: records argv, never touches a real daemon. "current" is the container named hindsight. */
function fakeDocker({ current = null, containers = {}, image = "sha256:new", images = {}, imageEnvs = {}, available = true, runExit = 0, backupExit = 0, network = true, onPull } = {}) {
  const calls = [];
  const state = { ...(current ? { hindsight: current } : {}), ...containers };
  const run = async (command, args) => {
    assert.equal(command, "docker");
    calls.push(args);
    if (!available) return fail("error during connect: the docker daemon is not running");
    switch (args[0]) {
      case "version": return ok("29.0.0\n");
      case "container": return state[args[2]] ? ok(JSON.stringify([state[args[2]]])) : fail("Error response from daemon: No such container: " + args[2]);
      case "image": {
        const ref = args.at(-1);
        if (args.includes("{{json .Config.Env}}")) return ok(JSON.stringify(imageEnvs[ref] || IMAGE_ENV));
        const id = ref in images ? images[ref] : image;
        return id ? ok(id + "\n") : fail("Error: No such image");
      }
      case "pull":
        if (args[1] in images) images[args[1]] = onPull?.(args[1]) || "sha256:pulled";
        else image = "sha256:new";
        return ok("pulled");
      case "ps": {
        const volume = args[args.indexOf("--filter") + 1].slice("volume=".length);
        return ok(Object.entries(state).filter(([, c]) => (c.Mounts || []).some(m => m.Name === volume)).map(([name]) => name).join("\n") + "\n");
      }
      case "network":
        if (args[1] === "inspect") return network ? ok("aih-hindsight\n") : fail("Error: network aih-hindsight not found");
        network = true;
        return ok("created");
      case "tag": return ok("");
      case "run": {
        if (args.includes("--rm")) return backupExit ? fail("tar: write error") : ok("");
        if (runExit) return fail("port is already allocated");
        const name = args[args.indexOf("--name") + 1];
        const labels = Object.fromEntries(args.flatMap((a, i) => a === "--label" ? [args[i + 1].split("=")] : []));
        const ref = args.find(a => /^ghcr\.io\//.test(a));
        state[name] = container({ labels, state: running, image: ref in images ? images[ref] : image });
        return ok("0123456789abcdef\n");
      }
      case "start": state[args[1]] = { ...state[args[1]], State: running }; return ok(args[1]);
      case "stop": if (!state[args[1]]) return fail("Error: No such container: " + args[1]); state[args[1]] = { ...state[args[1]], State: exited }; return ok(args[1]);
      case "rm": delete state[args.at(-1)]; return ok(args.at(-1));
      default: throw new Error("unexpected docker " + args.join(" "));
    }
  };
  return { run, calls, verbs: () => calls.map(a => ["container", "image", "network"].includes(a[0]) ? a[0] + " " + a[1] : a[0]),
    get state() { return state.hindsight || null; }, containers: state };
}

function dockerManager(docker, { health = { state: "healthy", status: "healthy", database: "connected", version: "1.1.0" }, config,
  llmHealth = { state: "healthy", status: "ok", build: "b12282", model: "lfm3" }, smoke = { ok: true }, files = true } = {}) {
  const m = new ServiceManager();
  let data = { services: {}, config: config ? { hindsight: config } : {} };
  m.readState = () => { const s = structuredClone(data); s.services ||= {}; delete s.services.agentmemory; return s; };
  m.loadState = m.readState;
  m.saveState = value => { data = structuredClone(value); };
  m.syncState = async () => {
    const s = m.readState();
    await m.syncDockerService(s, "hindsight");
    if (s.config?.hindsight?.localLlm?.enabled) await m.syncDockerService(s, "hindsight-llm");
    m.saveState(s);
    return s;
  };
  m.runDocker = docker.run;
  m.probeHealth = async url => ({ url: url + "/health", checkedAt: Date.now(), ...(typeof health === "function" ? health() : health) });
  m.probeLlmHealth = async url => ({ url: url + "/health", checkedAt: Date.now(), ...(typeof llmHealth === "function" ? llmHealth() : llmHealth) });
  m.smokeTestLlm = async () => typeof smoke === "function" ? smoke() : smoke;
  m.fileExists = () => files;
  m.hindsightPollMs = 1;
  return m;
}

const managedHash = () => hindsightConfigHash(normalizeHindsightConfig(), readHindsightApiKey().key);

test("settings validate Docker names, loopback ports and URLs; the key never reaches argv", async () => {
  assert.deepEqual(normalizeHindsightConfig(), { ...HINDSIGHT_DEFAULTS, localLlm: normalizeLocalLlmConfig() });
  assert.equal(normalizeHindsightConfig().localLlm.enabled, false);
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
  assert.deepEqual(docker.verbs(), ["version", "container inspect", "ps", "image inspect", "pull", "run", "container inspect"]);
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
  assert.deepEqual(foreign.verbs(), ["version", "container inspect", "ps", "start", "container inspect"]);

  const changed = fakeDocker({ current: container({ labels: { "io.aih.managed": "true", "io.aih.config": "old" } }) });
  const recreated = await dockerManager(changed).startService("hindsight");
  assert.match(recreated.message, /recreated/);
  assert.deepEqual(changed.verbs(), ["version", "container inspect", "ps", "rm", "image inspect", "run", "container inspect"]);
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
  assert.equal(refused.adoptable, true);
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
  assert.match(updated.message, /updated from 1\.1\.0 to 1\.2\.0 and restarted \(data backup: .*hindsight-\d{8}T\d{6}\.tgz\)/);
  // Graceful stop, archive of the volume with the old image, then removal without -f or -v.
  assert.deepEqual(outdated.verbs().slice(5, 9), ["stop", "run", "rm", "version"]);
  const backup = outdated.calls.find(a => a[0] === "run" && a.includes("--rm"));
  assert.ok(backup.includes("hindsight-data:/d:ro") && backup.includes(join(home, "backups") + ":/b") && backup.includes("sha256:old"), backup.join(" "));
  assert.deepEqual(outdated.calls.find(a => a[0] === "rm"), ["rm", "hindsight"]);
  assert.equal(m.updatesInProgress.size, 0);

  const broken = fakeDocker({ current: container({ state: running, labels }), backupExit: 1 });
  const kept = await dockerManager(broken).updateService("hindsight");
  assert.equal(kept.success, false);
  assert.match(kept.message, /Data backup failed: tar: write error; the current container is kept/);
  assert.ok(!broken.verbs().includes("rm"));
  assert.equal(broken.state.State.Running, true, "the old container is started again");
});

test("update moves a release tag of the official image to the latest release", async () => {
  const config = normalizeHindsightConfig({ image: "ghcr.io/vectorize-io/hindsight:1.1.0" });
  const labels = { "io.aih.managed": "true", "io.aih.config": hindsightConfigHash(config, readHindsightApiKey().key) };
  const releases = latestVersion => ({ getVersions: async () => ({ hindsight: { latestVersion } }) });

  const docker = fakeDocker({ current: container({ state: running, labels }) });
  const m = dockerManager(docker, { config });
  const updated = await m.updateService("hindsight", releases("1.2.0"));
  assert.equal(updated.success, true, updated.message);
  assert.deepEqual(docker.calls.find(a => a[0] === "pull"), ["pull", "ghcr.io/vectorize-io/hindsight:1.2.0"]);
  assert.equal(docker.calls.findLast(a => a[0] === "run").at(-1), "ghcr.io/vectorize-io/hindsight:1.2.0");
  assert.equal(m.readState().config.hindsight.image, "ghcr.io/vectorize-io/hindsight:1.2.0", "the new tag is saved for later starts");

  for (const [latest, expected] of [["1.1.0", /already up to date/], [null, /Cannot determine the latest Hindsight release/]]) {
    const idle = fakeDocker({ current: container({ state: running, labels }) });
    const same = dockerManager(idle, { config });
    const result = await same.updateService("hindsight", releases(latest));
    assert.match(result.message, expected);
    assert.equal(result.success, latest !== null);
    assert.deepEqual(idle.verbs(), ["version", "container inspect", "ps"]);
    assert.equal(same.readState().config.hindsight.image, config.image);
  }

  const failing = fakeDocker({ current: container({ state: running, labels }), backupExit: 1 });
  const unchanged = dockerManager(failing, { config });
  assert.equal((await unchanged.updateService("hindsight", releases("1.2.0"))).success, false);
  assert.equal(unchanged.readState().config.hindsight.image, config.image, "a failed update does not move the saved tag");
});

test("adopt imports a foreign container's settings and recreates it on the same volume", async () => {
  const foreignContainer = (mounts = [{ Type: "volume", Name: "my-data", Destination: "/home/hindsight/.pg0" }]) => ({
    ...container({ state: running, labels: { "com.docker.compose.project": "hindsight" } }),
    Config: { Image: "ghcr.io/vectorize-io/hindsight:1.1.0", Labels: { "com.docker.compose.project": "hindsight" }, Env: [...IMAGE_ENV,
      "HINDSIGHT_API_LLM_PROVIDER=openai", "HINDSIGHT_API_LLM_MODEL=auto-free", "HINDSIGHT_API_LLM_BASE_URL=https://gateway.example/v1",
      "HINDSIGHT_API_LLM_API_KEY=sk-adopted", "HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:8888",
      "HINDSIGHT_API_LLM_1_API_KEY=sk-second", 'HINDSIGHT_API_LLM_STRATEGY={"mode":"failover","a":"b=c"}'] },
    Mounts: mounts,
    HostConfig: { PortBindings: { "8888/tcp": [{ HostIp: "127.0.0.1", HostPort: "18888" }], "9999/tcp": [{ HostIp: "127.0.0.1", HostPort: "19999" }] } },
  });
  try {
    const bound = fakeDocker({ current: foreignContainer([{ Type: "bind", Source: "C:/data", Destination: "/home/hindsight/.pg0" }]) });
    const refusing = dockerManager(bound);
    const refused = await refusing.updateService("hindsight", { adopt: true });
    assert.equal(refused.success, false);
    assert.match(refused.message, /Cannot adopt container 'hindsight': its data must be in one Docker volume.*Nothing was changed/);
    assert.deepEqual(bound.verbs(), ["version", "container inspect", "image inspect"]);
    assert.equal(refusing.readState().config.hindsight, undefined);
    assert.equal(readHindsightApiKey().key, "sk-secret");

    const docker = fakeDocker({ current: foreignContainer() });
    const m = dockerManager(docker);
    const adopted = await m.updateService("hindsight", { adopt: true });
    assert.equal(adopted.success, true, adopted.message);
    assert.match(adopted.message, /adopted and recreated by aih as 'hindsight' \(data volume 'my-data' kept, backup .*hindsight-\d{8}T\d{6}\.tgz; healthy/);
    assert.match(adopted.message, /Do not run 'docker compose up' for project 'hindsight' again/);
    const extra = join(home, "hindsight-extra.env");
    assert.deepEqual(m.readState().config.hindsight, normalizeHindsightConfig({ image: "ghcr.io/vectorize-io/hindsight:1.1.0", volume: "my-data",
      apiPort: 18888, uiPort: 19999, llmModel: "auto-free", llmBaseUrl: "https://gateway.example/v1", envFile: extra }));
    assert.deepEqual(readHindsightApiKey(), { key: "sk-adopted", source: "file" });
    // Image defaults and the variables aih sets itself are not copied; everything else is, verbatim.
    assert.equal(await readFile(extra, "utf8"), 'HINDSIGHT_API_LLM_1_API_KEY=sk-second\nHINDSIGHT_API_LLM_STRATEGY={"mode":"failover","a":"b=c"}\n');
    // Stop, archive the volume, then replace: adoption never goes ahead without a backup.
    assert.deepEqual(docker.verbs(), ["version", "container inspect", "image inspect", "stop", "run", "rm", "version", "container inspect", "ps", "image inspect", "run", "container inspect"]);
    const run = docker.calls.find(a => a[0] === "run" && !a.includes("--rm"));
    for (const expected of ["io.aih.managed=true", "my-data:/home/hindsight/.pg0", "127.0.0.1:18888:8888", "127.0.0.1:19999:9999", extra]) assert.ok(run.includes(expected), expected);
    assert.ok(!docker.calls.flat().join(" ").includes("sk-"), "no secret on a docker command line");
    assert.equal(run.at(-1), "ghcr.io/vectorize-io/hindsight:1.1.0", "adoption keeps the image; updating is a separate step");
    // Once adopted it is an ordinary aih container: the next update no longer asks.
    assert.notEqual((await m.updateService("hindsight", { getVersions: async () => ({ hindsight: { latestVersion: "1.1.0" } }) })).adoptable, true);
  } finally {
    saveHindsightApiKey("sk-secret");
  }
});

const LLM_ENV = ["PATH=/usr/bin", "LLAMA_ARG_HOST=0.0.0.0", "LLAMA_ARG_PORT=8080"];
const llmConfig = (overrides = {}) => normalizeHindsightConfig({ localLlm: { enabled: true, modelsDir: "C:/models", model: "base.gguf", lora: "adapter.gguf",
  alias: "lfm3", ctxSize: 131072, parallel: 2, maxConcurrent: 2, ...overrides } });
const managed = (config, extra = {}) => container({ state: running, labels: { "io.aih.managed": "true", "io.aih.config": hindsightConfigHash(config, readHindsightApiKey().key) }, ...extra });
const managedLlm = (llm, extra = {}) => container({ state: running, labels: { "io.aih.managed": "true", "io.aih.role": "llm", "io.aih.config": localLlmConfigHash(llm) }, ...extra });

test("local LLM settings: validated only when enabled, routed per operation, never repeated in extra arguments", () => {
  assert.equal(normalizeLocalLlmConfig({ modelsDir: "relative" }).enabled, false, "disabled settings may stay incomplete");
  assert.throws(() => normalizeLocalLlmConfig({ enabled: true, modelsDir: "C:/m" }), /model file: required/);
  assert.throws(() => normalizeLocalLlmConfig({ enabled: true, modelsDir: "models", model: "a.gguf" }), /absolute path/);
  assert.throws(() => normalizeLocalLlmConfig({ enabled: true, modelsDir: "C:/m", model: "../a.gguf" }), /inside the models folder/);
  assert.throws(() => normalizeLocalLlmConfig({ extraArgs: "--jinja --ctx-size 4096" }), /--ctx-size is set by aih/);
  assert.throws(() => normalizeLocalLlmConfig({ operations: "reflect,embed" }), /'embed' is not one of/);
  assert.throws(() => normalizeLocalLlmConfig({ enabled: true, modelsDir: "C:/m", model: "a.gguf", maxConcurrent: 2 }), /cannot exceed its 1 parallel slots/);
  assert.throws(() => normalizeLocalLlmConfig({ enabled: true, modelsDir: "C:/m", model: "a.gguf", ctxSize: 32768 }), /exceed the 32768 tokens of each local LLM slot/);
  assert.throws(() => normalizeHindsightConfig({ localLlm: { enabled: true, modelsDir: "C:/m", model: "a.gguf", port: 8888 } }), /must differ/);
  assert.deepEqual(normalizeLocalLlmConfig({ operations: "consolidation, REFLECT" }).operations, ["reflect", "consolidation"]);
  assert.equal(normalizeLocalLlmConfig({ gpus: "none" }).gpus, "");

  const config = llmConfig();
  const llm = localLlmRunArgs(config.localLlm, { configHash: "h" });
  assert.deepEqual(llm.slice(0, 8), ["run", "-d", "--name", "hindsight-llm", "--restart", "unless-stopped", "--network", "aih-hindsight"]);
  for (const expected of ["127.0.0.1:8085:8080", "type=bind,source=C:/models,target=/models,readonly", "io.aih.role=llm", "--gpus"]) assert.ok(llm.includes(expected), expected);
  assert.deepEqual(llm.slice(llm.indexOf(LOCAL_LLM_DEFAULTS.image)), [LOCAL_LLM_DEFAULTS.image, "--model", "/models/base.gguf", "--lora", "/models/adapter.gguf",
    "--alias", "lfm3", "--host", "0.0.0.0", "--port", "8080", "--ctx-size", "131072", "--parallel", "2", "--jinja", "--n-gpu-layers", "999", "--flash-attn", "on", "--metrics"]);
  const args = hindsightRunArgs(config, { configHash: "h", keySource: "file" });
  assert.ok(args.includes("aih-hindsight"));
  for (const expected of ["HINDSIGHT_API_REFLECT_LLM_BASE_URL=http://hindsight-llm:8080/v1", "HINDSIGHT_API_REFLECT_LLM_MODEL=lfm3",
    "HINDSIGHT_API_REFLECT_LLM_MAX_CONCURRENT=2", "HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS=48000"]) assert.ok(args.includes(expected), expected);
  assert.ok(!args.some(a => a.startsWith("HINDSIGHT_API_RETAIN_")), "only the selected operations are routed");
  assert.ok(!hindsightRunArgs(normalizeHindsightConfig(), { configHash: "h", keySource: "file" }).includes("--network"));
  // Without a local LLM the fingerprint is unchanged, so upgrading aih does not recreate Hindsight.
  assert.equal(hindsightConfigHash(normalizeHindsightConfig()), hindsightConfigHash({ ...normalizeHindsightConfig(), localLlm: undefined }));
  assert.equal(localLlmConfigHash(config.localLlm), localLlmConfigHash({ ...config.localLlm, timeout: 999 }), "routing changes recreate Hindsight only");
  assert.notEqual(hindsightConfigHash(config), hindsightConfigHash({ ...config, localLlm: { ...config.localLlm, timeout: 999 } }));
});

test("local LLM health: 503 while loading, healthy with build and model once loaded", async () => {
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const loading = await probeLocalLlmHealth("http://127.0.0.1:8085", { fetchImpl: async () => reply(503, { error: { code: 503, message: "Loading model" } }) });
  assert.equal(loading.state, "degraded");
  assert.equal(loading.detail, "loading model");
  const ready = await probeLocalLlmHealth("http://127.0.0.1:8085", { fetchImpl: async url => url.endsWith("/props")
    ? reply(200, { build_info: "b12282-aa75ff323", model_alias: "lfm3" }) : reply(200, { status: "ok" }) });
  assert.deepEqual([ready.state, ready.build, ready.model], ["healthy", "b12282", "lfm3"]);
});

test("start brings up the local LLM first and stop takes Hindsight down first", async () => {
  const config = llmConfig();
  const docker = fakeDocker({ network: false });
  const m = dockerManager(docker, { config });
  const started = await m.startService("hindsight");
  assert.equal(started.success, true, started.message);
  assert.match(started.message, /'hindsight' created; .* \| local LLM: healthy \(llama\.cpp b12282, model lfm3\)/);
  const runs = docker.calls.filter(a => a[0] === "run").map(a => a[a.indexOf("--name") + 1]);
  assert.deepEqual(runs, ["hindsight-llm", "hindsight"]);
  assert.ok(docker.calls.some(a => a[0] === "network" && a[1] === "create"));
  assert.deepEqual(Object.keys(m.readState().services).filter(id => id.startsWith("hindsight")), ["hindsight", "hindsight-llm"]);
  assert.equal(m.readState().services["hindsight-llm"].apiUrl, "http://127.0.0.1:8085");

  const stopped = await m.stopService("hindsight");
  assert.match(stopped.message, /stopped \(data kept\); local LLM 'hindsight-llm' stopped/);
  assert.deepEqual(docker.calls.filter(a => a[0] === "stop"), [["stop", "hindsight"], ["stop", "hindsight-llm"]]);

  const alone = await m.stopService("hindsight-llm");
  assert.equal(alone.success, true);
  assert.equal((await dockerManager(fakeDocker()).startService("hindsight-llm")).success, false, "disabled: nothing to start");
});

test("Hindsight is not started when its local LLM fails, nor next to a foreign Hindsight on the same volume", async () => {
  const config = llmConfig();
  const missing = fakeDocker();
  const noFiles = await dockerManager(missing, { config, files: false }).startService("hindsight");
  assert.match(noFiles.message, /Local LLM file not found: .*base\.gguf.*Hindsight was not started/);
  assert.ok(!missing.verbs().includes("run"));

  const broken = fakeDocker();
  const failed = await dockerManager(broken, { config, smoke: { ok: false, error: "HTTP 500: lora mismatch" } }).startService("hindsight");
  assert.match(failed.message, /test completion failed \(HTTP 500: lora mismatch\).*Hindsight was not started/);
  assert.deepEqual(broken.calls.filter(a => a[0] === "run").map(a => a[a.indexOf("--name") + 1]), ["hindsight-llm"]);

  const rival = { ...container({ state: running, labels: { "com.docker.compose.project": "hindsight-only-reflect" } }),
    Mounts: [{ Type: "volume", Name: "hindsight-data", Destination: "/home/hindsight/.pg0" }] };
  const shared = fakeDocker({ containers: { "hindsight-only-reflect": rival } });
  const refused = await dockerManager(shared).startService("hindsight");
  assert.equal(refused.success, false);
  assert.match(refused.message, /'hindsight-only-reflect' \(not created by aih, compose project 'hindsight-only-reflect'\) is running on data volume 'hindsight-data'/);
  assert.ok(!shared.verbs().includes("run") && !shared.verbs().includes("start"));
});

test("local LLM update re-pulls its pinned tag and rolls back to the previous image on failure", async () => {
  const config = llmConfig({ image: "ghcr.io/ggml-org/llama.cpp:server-cuda-b12282" });
  const image = config.localLlm.image;
  const current = () => ({ hindsight: managed(config), "hindsight-llm": managedLlm(config.localLlm, { image: "sha256:old" }) });

  const same = fakeDocker({ containers: current(), images: { [image]: "sha256:old" }, onPull: () => "sha256:old" });
  const unchanged = await dockerManager(same, { config }).updateService("hindsight-llm");
  assert.equal(unchanged.alreadyUpToDate, true);
  assert.match(unchanged.message, /pinned: to move to another build, change the local LLM image tag/);
  assert.deepEqual(same.calls.find(a => a[0] === "pull"), ["pull", image], "the tag is never advanced");

  const newer = fakeDocker({ containers: current(), images: { [image]: "sha256:old" }, onPull: () => "sha256:rebuilt" });
  const updated = await dockerManager(newer, { config }).updateService("hindsight-llm");
  assert.equal(updated.success, true, updated.message);
  assert.ok(!newer.calls.some(a => a.includes("--rm")), "the stateless LLM container is not backed up");

  let smokes = 0;
  const bad = fakeDocker({ containers: current(), images: { [image]: "sha256:old" }, onPull: () => "sha256:bad" });
  const rolled = await dockerManager(bad, { config, smoke: () => ++smokes === 1 ? { ok: false, error: "HTTP 500" } : { ok: true } }).updateService("hindsight-llm");
  assert.equal(rolled.success, false);
  assert.equal(rolled.rolledBack, true, rolled.message);
  assert.deepEqual(bad.calls.find(a => a[0] === "tag"), ["tag", "sha256:old", image]);
});

test("adopting a compose stack imports Hindsight and its local LLM, archives the data and renames both", async () => {
  const compose = { "com.docker.compose.project": "hindsight-only-reflect" };
  const hindsight = {
    ...container({ state: running, labels: compose }),
    Config: { Image: "ghcr.io/vectorize-io/hindsight:1.2.3", Labels: compose, Env: [...IMAGE_ENV, "HINDSIGHT_API_LLM_PROVIDER=openai",
      "HINDSIGHT_API_LLM_MODEL=auto-free", "HINDSIGHT_API_LLM_API_KEY=sk-adopted", "HINDSIGHT_API_LLM_TIMEOUT=120",
      "HINDSIGHT_API_REFLECT_LLM_PROVIDER=openai", "HINDSIGHT_API_REFLECT_LLM_BASE_URL=http://lfm3-hindsight:8080/v1",
      "HINDSIGHT_API_REFLECT_LLM_MODEL=lfm3-hindsight-v11", "HINDSIGHT_API_REFLECT_LLM_API_KEY=local", "HINDSIGHT_API_REFLECT_LLM_MAX_CONCURRENT=2",
      "HINDSIGHT_API_REFLECT_LLM_TIMEOUT=180", "HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS=48000", "HINDSIGHT_API_REFLECT_MAX_COMPLETION_TOKENS=8192"] },
    Mounts: [{ Type: "volume", Name: "hindsight-data", Destination: "/home/hindsight/.pg0" }],
    HostConfig: { PortBindings: { "8888/tcp": [{ HostPort: "8888" }], "9999/tcp": [{ HostPort: "9999" }] } },
  };
  const llm = {
    ...container({ state: running, labels: compose, image: "sha256:llama" }),
    Config: { Image: "ghcr.io/ggml-org/llama.cpp:server-cuda-b12282", Labels: compose, Env: LLM_ENV,
      Cmd: ["--model", "/models/LFM3-1.7B-Q8_0.gguf", "--lora", "/models/adapter.gguf", "--jinja", "--alias", "lfm3-hindsight-v11", "--host", "0.0.0.0",
        "--port", "8080", "--n-gpu-layers", "999", "--flash-attn", "on", "--parallel", "2", "--ctx-size", "131072", "--no-kv-unified", "--metrics"] },
    Mounts: [{ Type: "bind", Source: "C:/Users/me/lfm3/models", Destination: "/models" }],
    HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8085" }] },
      DeviceRequests: [{ Driver: "nvidia", Count: -1, DeviceIDs: null, Capabilities: [["gpu"]] }] },
  };
  try {
    const docker = fakeDocker({ containers: { "hindsight-only-reflect": hindsight, "lfm3-hindsight": llm },
      imageEnvs: { "sha256:llama": LLM_ENV }, images: { "ghcr.io/ggml-org/llama.cpp:server-cuda-b12282": "sha256:llama" } });
    const m = dockerManager(docker);
    const asked = await m.updateService("hindsight");
    assert.equal(asked.adoptable, true);
    assert.match(asked.message, /'hindsight-only-reflect' was not created by aih \(docker compose project 'hindsight-only-reflect'\)/);

    const adopted = await m.updateService("hindsight", { adopt: true });
    assert.equal(adopted.success, true, adopted.message);
    assert.match(adopted.message, /'hindsight-only-reflect' and 'lfm3-hindsight' adopted and recreated by aih as 'hindsight' and 'hindsight-llm'/);
    const saved = m.readState().config.hindsight;
    assert.deepEqual(saved.localLlm, normalizeLocalLlmConfig({ enabled: true, image: "ghcr.io/ggml-org/llama.cpp:server-cuda-b12282", port: 8085,
      modelsDir: "C:/Users/me/lfm3/models", model: "LFM3-1.7B-Q8_0.gguf", lora: "adapter.gguf", alias: "lfm3-hindsight-v11", gpus: "all",
      ctxSize: 131072, parallel: 2, extraArgs: "--jinja --n-gpu-layers 999 --flash-attn on --no-kv-unified --metrics",
      operations: ["reflect"], maxConcurrent: 2, timeout: 180, maxContextTokens: 48000, maxCompletionTokens: 8192 }));
    assert.equal(saved.containerName, "hindsight");
    // Routing variables become settings; only the rest stays in the extra file.
    assert.equal(await readFile(join(home, "hindsight-extra.env"), "utf8"), "HINDSIGHT_API_LLM_TIMEOUT=120\n");
    const verbs = docker.verbs();
    assert.ok(verbs.indexOf("run") < verbs.indexOf("rm"), "the data volume is archived before anything is removed");
    assert.deepEqual(docker.calls.filter(a => a[0] === "stop").map(a => a[1]), ["hindsight-only-reflect", "lfm3-hindsight"]);
    assert.deepEqual(Object.keys(docker.containers).sort(), ["hindsight", "hindsight-llm"]);
    assert.ok(!docker.calls.flat().join(" ").includes("sk-"), "no secret on a docker command line");
  } finally {
    saveHindsightApiKey("sk-secret");
  }
});


test("dashboard adopts only on a second consecutive u", async t => {
  const calls = [];
  t.mock.method(manager, "updateService", async (id, options) => { calls.push(options.adopt); return { success: false, adoptable: true, message: "press u again" }; });
  const d = new Dashboard({ getVersions: async () => ({}) });
  d.refresh = async () => {};
  d.render = () => {};
  d.statuses = [{ id: "hindsight", runtime: "docker", status: "running" }];
  const press = async key => { d.onKey(key); await new Promise(resolve => setImmediate(resolve)); };
  await press("u");
  await press("u");
  await press("u");
  await press("d");
  await press("u");
  assert.deepEqual(calls, [false, true, true, false]);
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

test("setup: the local LLM step appears with Hindsight, its fields only when on, and the summary checks the slot budget", () => {
  const w = new ProxySetupWizard({ services: {}, config: { startServices: ["hindsight", "proxy"] } }, { keyStatus: "file" });
  const keys = () => w.fields.map(f => f.key);
  assert.ok(keys().includes("hindsightLocalEnabled"));
  assert.ok(!keys().includes("hindsightLocalModel"), "hidden while off");
  assert.equal(w.hindsightSettings().config.localLlm.enabled, false);
  w.step = keys().indexOf("hindsightLocalEnabled");
  w.handle(" ");
  assert.equal(w.draft.hindsightLocalEnabled, "on");
  w.handle("\r");
  assert.equal(w.error, "", "an incomplete local LLM does not block moving through its fields");
  w.step = keys().indexOf("hindsightLocalOperations");
  w.handle("\x1b[B");
  w.handle(" ");
  assert.equal(w.draft.hindsightLocalOperations, "reflect,retain");
  Object.assign(w.draft, { hindsightLocalModelsDir: "C:/models", hindsightLocalModel: "base.gguf", hindsightLocalCtxSize: "32768" });
  assert.throws(() => w.validate(), /exceed the 32768 tokens/);
  w.draft.hindsightLocalCtxSize = "65536";
  const { localLlm } = w.hindsightSettings().config;
  assert.deepEqual([localLlm.enabled, localLlm.model, localLlm.operations], [true, "base.gguf", ["reflect", "retain"]]);
  w.step = w.fields.length;
  const summary = w.lines(140, 80).join("\n");
  assert.match(summary, /\* Local LLM for Hindsight: on \(previous: off\)/);
  assert.match(summary, /started before Hindsight and stopped after it/);
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
