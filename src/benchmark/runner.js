import http from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { startProxy } from "../proxy.js";
import { normalizePresetOptions } from "../proxy-presets.js";
import { builtInFixtures, validateFixtures } from "./fixtures.js";
import { evaluatePreservation, evaluateAnswer } from "./quality.js";
import { measureRequest } from "./measurement.js";
import { callProvider, validateUpstream, readLimited } from "./live.js";

export const BENCHMARK_PRESETS = ["none", "headroom", "rtk", "pxpipe", "headroom-pxpipe", "rtk-pxpipe"];
const exec = promisify(execFile);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function normalizeBenchmarkOptions(options = {}) {
  const presets = options.presets || BENCHMARK_PRESETS;
  if (!Array.isArray(presets) || !presets.length || new Set(presets).size !== presets.length || presets.some(p => !BENCHMARK_PRESETS.includes(p))) throw new Error("presets must be a unique nonempty list of supported presets");
  // Every comparison includes a concurrently replayed baseline, not old global stats.
  const normalized = { ...options, presets: [...new Set(["none", ...presets])],
    repetitions: options.repetitions ?? 3, warmup: options.warmup ?? 1,
    seed: options.seed ?? 42, transports: options.transports || ["http"],
    timeoutMs: options.timeoutMs ?? 120000, maxBodyBytes: options.maxBodyBytes ?? 64 * 1024 * 1024,
    live: Boolean(options.live), maxOutputTokens: options.maxOutputTokens ?? 256, maxLiveCalls: options.maxLiveCalls ?? 200 };
  for (const key of ["repetitions", "timeoutMs", "maxBodyBytes", "maxOutputTokens", "maxLiveCalls"]) {
    if (!Number.isSafeInteger(normalized[key]) || normalized[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(normalized.warmup) || normalized.warmup < 0 || !Number.isSafeInteger(normalized.seed)) throw new Error("warmup must be nonnegative and seed must be an integer");
  if (!Array.isArray(normalized.transports) || !normalized.transports.length || new Set(normalized.transports).size !== normalized.transports.length || normalized.transports.some(t => !["http", "ws"].includes(t))) throw new Error("transports must contain http and/or ws");
  if (options.formats && (!Array.isArray(options.formats) || !options.formats.length || new Set(options.formats).size !== options.formats.length || options.formats.some(f => !["responses", "chat", "anthropic"].includes(f)))) throw new Error("formats must contain responses, chat and/or anthropic");
  if (options.compareModels !== undefined) {
    if (options.model !== undefined) throw new Error("Use model OR compareModels, not both");
    if (!Array.isArray(options.compareModels) || !options.compareModels.length || new Set(options.compareModels).size !== options.compareModels.length || options.compareModels.some(m => typeof m !== "string" || !/^[\w./:-]+$/.test(m))) throw new Error("compareModels must be a unique nonempty list of model IDs");
  }
  if (normalized.live) {
    if (!options.upstream) throw new Error("--live requires --upstream (provider root, before /v1)");
    normalized.upstream = validateUpstream(options.upstream);
    if (normalized.transports.includes("ws")) throw new Error("Live evaluation supports HTTP only; WS is available in offline replay");
  } else if (options.upstream || options.apiKey) throw new Error("An upstream/API key requires explicit --live");
  normalizePresetOptions({ ...options, preset: "none" });
  return normalized;
}

function randomizer(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

async function version(command) {
  try { return (await exec(command, ["--version"], { timeout: 15000, windowsHide: true, maxBuffer: 8192 })).stdout.trim().slice(0, 128); }
  catch { return null; }
}
async function packageVersion(name) {
  try { return JSON.parse(await readFile(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8")).version; } catch { return null; }
}

async function collector(options) {
  const records = new Map(), sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const id = req.headers["x-request-id"];
    const entry = records.get(id);
    if (!entry) { res.writeHead(400); res.end(); return; }
    res.on("close", () => { if (!res.writableFinished) entry.controller.abort(); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > options.maxBodyBytes) throw new Error("Collector body limit"); chunks.push(chunk); }
      entry.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (options.live) entry.live = await callProvider(entry.body, entry.fixture, { ...options, signal: entry.signal });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } catch (error) {
      entry.error = entry.signal.aborted ? "Benchmark interrupted or timed out" : `Collector/provider request failed (${error.name})`;
      res.writeHead(502); res.end("{}");
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const ws = new WebSocketServer({ server, maxPayload: options.maxBodyBytes });
  ws.on("connection", (socket, req) => {
    socket.on("error", () => {});
    socket.on("message", data => {
      const entry = records.get(req.headers["x-request-id"]);
      try {
        const envelope = JSON.parse(data.toString());
        if (entry) entry.body = envelope.response || envelope;
        socket.send("{}");
      } catch { socket.close(1007); }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { records, url: `http://127.0.0.1:${server.address().port}`,
    async close() { for (const c of ws.clients) c.terminate(); for (const s of sockets) s.destroy(); await new Promise(done => ws.close(done)); await new Promise(done => server.close(done)); } };
}

async function replay(proxy, fixture, transport, id, options) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
  if (transport === "http") {
    const started = performance.now();
    const response = await fetch(proxy.url + fixture.path, {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": id },
      body: JSON.stringify(fixture.body), signal, redirect: "error",
    });
    await readLimited(response, options.maxBodyBytes);
    if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
    return { durationMs: performance.now() - started, connectionMs: null };
  }
  const started = performance.now();
  const socket = new WebSocket(proxy.url.replace("http:", "ws:") + fixture.path, { headers: { "x-request-id": id }, maxPayload: options.maxBodyBytes });
  socket.on("error", () => {});
  const abort = () => socket.terminate();
  let abortReply;
  signal.addEventListener("abort", abort, { once: true });
  try {
    await once(socket, "open", { signal });
    const connectionMs = performance.now() - started;
    const sent = performance.now();
    const reply = new Promise((resolve, reject) => {
      socket.once("message", resolve);
      socket.once("close", () => reject(new Error("WebSocket closed before reply")));
      socket.once("error", reject);
      abortReply = () => reject(new Error("WebSocket request timed out or interrupted"));
      signal.addEventListener("abort", abortReply, { once: true });
    });
    socket.send(JSON.stringify({ type: "response.create", response: fixture.body }));
    await reply;
    return { durationMs: performance.now() - sent, connectionMs };
  } finally { signal.removeEventListener("abort", abort); if (abortReply) signal.removeEventListener("abort", abortReply); socket.terminate(); }
}

export function prepareBenchmark(inputOptions = {}) {
  const options = normalizeBenchmarkOptions(inputOptions);
  let fixtures = structuredClone(options.fixtures || builtInFixtures({ model: options.model, formats: options.formats }));
  if (options.formats) fixtures = fixtures.filter(f => options.formats.includes(f.format));
  if (options.model) for (const fixture of fixtures) fixture.body.model = options.model;
  if (options.compareModels) fixtures = options.compareModels.flatMap(model => fixtures.map(fixture => ({
    ...structuredClone(fixture), id: `${fixture.id}@${model}`, body: { ...structuredClone(fixture.body), model },
  })));
  if (options.live) for (const { body, format } of fixtures) {
    body.stream = false; delete body.stream_options;
    if (format === "responses") { body.store = false; body.background = false; }
    if (Array.isArray(body.tools) && body.tools.some(tool => format === "anthropic" ? tool.type && tool.type !== "custom" : tool.type !== "function")) {
      throw new Error("Live fixtures support client function tools only, not provider-hosted tools");
    }
    if (format === "anthropic") body.max_tokens = options.maxOutputTokens;
    else if (format === "chat") { delete body.max_tokens; body.max_completion_tokens = options.maxOutputTokens; body.n = 1; }
    else body.max_output_tokens = options.maxOutputTokens;
  }
  validateFixtures(fixtures);
  // A benchmark must exercise pxpipe instead of accidentally measuring its
  // default model gate. This opt-in is isolated from production configuration.
  options.models ||= [...new Set(fixtures.map(f => f.body.model))].join(",");
  normalizePresetOptions({ ...options, preset: "none" });
  for (const fixture of fixtures) if (Buffer.byteLength(JSON.stringify(fixture.body)) > options.maxBodyBytes) throw new Error(`Fixture ${fixture.id} exceeds maxBodyBytes`);
  const cases = fixtures.flatMap(fixture => options.transports.filter(t => t === "http" || fixture.format === "responses").map(transport => ({ fixture, transport })));
  if (!cases.length) throw new Error("No applicable cases (WS requires Responses fixtures)");
  const planned = cases.length * options.presets.length * (options.repetitions + options.warmup);
  if (options.live && planned > options.maxLiveCalls) throw new Error(`Live plan needs ${planned} calls, exceeding maxLiveCalls=${options.maxLiveCalls}; reduce the corpus/rounds or explicitly raise --max-live-calls`);
  return { options, fixtures, cases };
}

function privateQuality(result) {
  // Assertions can contain sensitive fixture excerpts: persist identifiers and
  // hashes, not the expected literal text. Payloads require a separate opt-in.
  return { ...result, checks: result.checks.map(({ expected, ...check }) => ({ ...check, ...(expected === undefined ? {} : { expectedHash: digest(expected) }) })) };
}

/** All traffic traverses the real proxy, then a private loopback collector. No managed service/state is touched. */
export async function runBenchmark(inputOptions = {}) {
  const { options, fixtures, cases } = prepareBenchmark(inputOptions);
  const meta = {
    schemaVersion: 1, startedAt: new Date().toISOString(), mode: options.live ? "live" : "offline",
    presets: options.presets, repetitions: options.repetitions, warmup: options.warmup, seed: options.seed,
    transports: options.transports, corpusHash: digest(fixtures), fixtureCount: fixtures.length,
    fixtures: fixtures.map(f => ({ id: f.id, category: f.category, format: f.format, model: f.body.model, hash: digest(f) })),
    plannedRecords: cases.length * options.presets.length * (options.repetitions + options.warmup),
    versions: { node: process.version, platform: process.platform, arch: process.arch,
      pxpipe: await packageVersion("pxpipe-proxy"), tokenizer: await packageVersion("gpt-tokenizer"),
      rtk: options.presets.some(p => p.includes("rtk")) ? await version("rtk") : null,
      headroomLocalCli: options.presets.some(p => p.includes("headroom")) ? await version("headroom") : null },
    config: { rtkFilter: options.rtkFilter || "auto", models: options.models, compareModels: options.compareModels || null, headroomUrl: options.headroomUrl || "http://127.0.0.1:8787",
      headroomMode: "lossy_inline", upstream: options.live ? options.upstream : null, timeoutMs: options.timeoutMs, maxOutputTokens: options.live ? options.maxOutputTokens : null, maxLiveCalls: options.live ? options.maxLiveCalls : null },
    notes: ["Local token estimates are not provider billing. Native stage counts are diagnostic only.",
      "Offline preservation checks are not semantic answer-quality evidence. Image content is not OCR-validated.",
      "Benchmark-only pxpipe allowlist defaults to all fixture models. This exercises imaging, but is not a model-support or quality guarantee.",
      "First request means first request through this benchmark instance, NOT a cold external service/cache.",
      "HTTP durations include a local collector hop; WS message durations exclude connection setup (reported separately).",
      "Live mode is a fixed single-answer evaluation, not a full agent task; no tool calls or retries are executed.",
      "Provider cache state is uncontrolled; cache reads/writes are reported separately. Warmup live calls also consume tokens.",
      "Aborted/failed provider calls can still incur usage that the provider does not return; measured usage is not a complete invoice.",
      "headroomLocalCli is the installed CLI version, not proof of the remote compression service version/configuration."],
  };
  const records = [], states = new Map();
  const sink = await collector(options);
  try {
    for (const preset of options.presets) {
      const state = { attempts: 0 };
      states.set(preset, state);
      const start = performance.now();
      try {
        state.proxy = await startProxy({ upstream: sink.url, listen: "http://127.0.0.1:0", preset,
          headroomUrl: options.headroomUrl, rtkFilter: options.rtkFilter, models: options.models,
          maxBodyBytes: options.maxBodyBytes, onStats: event => sink.records.get(event.requestId)?.events.push(event) });
      } catch (error) { state.error = `Preset setup failed (${error.name})`; }
      state.startupMs = performance.now() - start;
    }
    const baselines = new Map();
    for (const fixture of fixtures) baselines.set(fixture.id, await measureRequest(fixture.body));
    const random = randomizer(options.seed);
    let sequence = 0;
    outer: for (let round = -options.warmup; round < options.repetitions; round++) {
      for (const { fixture, transport } of shuffle(cases, random)) {
        for (const preset of shuffle(options.presets, random)) {
          if (options.signal?.aborted) break outer;
          const state = states.get(preset), id = String(++sequence);
          const controller = new AbortController();
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
          const entry = { fixture, controller, signal, events: [] };
          sink.records.set(id, entry);
          const row = { sequence, caseId: fixture.id, category: fixture.category, format: fixture.format, model: fixture.body.model,
            transport, preset, round, phase: round < 0 ? "warmup" : "measured", firstRequest: state.attempts++ === 0,
            status: "ok", before: baselines.get(fixture.id), after: null, stages: [], durationMs: null,
            preservation: null, answerQuality: null, live: null };
          const start = performance.now();
          try {
            if (state.error) throw new Error(state.error);
            Object.assign(row, await replay(state.proxy, fixture, transport, id, { ...options, signal }));
            if (entry.error) throw new Error(entry.error);
            if (!entry.body) throw new Error("No request reached the benchmark collector");
            row.after = await measureRequest(entry.body);
            row.preservation = privateQuality(evaluatePreservation(fixture.body, entry.body, fixture.checks));
            row.changed = digest(fixture.body) !== digest(entry.body);
            row.outputHash = digest(entry.body);
            if (options.live) {
              const { text, ...live } = entry.live || {};
              row.live = live;
              if (live.error) throw new Error(live.error);
              row.answerQuality = privateQuality(evaluateAnswer(text || "", fixture.answerChecks));
            }
            if (options.onPayload) await options.onPayload({ sequence, fixture, preset, transport, phase: row.phase, transformed: entry.body, answer: entry.live?.text });
          } catch (error) {
            row.status = "error";
            // Only our bounded messages, never provider response bodies or full stacks.
            row.error = error.message.startsWith("Proxy HTTP") || error.message.startsWith("Provider HTTP") ? error.message : `Benchmark request failed (${error.name})`;
            row.durationMs ??= performance.now() - start;
          } finally { controller.abort(); sink.records.delete(id); }
          row.stages = entry.events.flatMap(event => event.stages || []);
          records.push(row);
          await options.onRecord?.(row);
        }
      }
    }
    meta.interrupted = Boolean(options.signal?.aborted);
    meta.completed = !meta.interrupted && records.length === meta.plannedRecords;
    meta.startup = Object.fromEntries([...states].map(([preset, state]) => [preset, { durationMs: state.startupMs, error: state.error || null }]));
    meta.finishedAt = new Date().toISOString();
    return { meta, records };
  } finally {
    await Promise.allSettled([...states.values()].map(state => state.proxy?.close()));
    await sink.close();
  }
}
