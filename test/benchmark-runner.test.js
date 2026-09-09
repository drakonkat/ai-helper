import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBenchmark, normalizeBenchmarkOptions, prepareBenchmark } from "../src/benchmark/runner.js";
import { buildReport } from "../src/benchmark/report.js";
import { builtInFixtures } from "../src/benchmark/fixtures.js";

const test = typeof Bun === "undefined" ? nodeTest : nodeTest.skip;
const exec = promisify(execFile);
const comparisonModels = ["gpt-6-astra", "anthropic/claude-fable-5-1"];
function fixture() {
  return { id: "tiny", category: "logs", format: "responses", path: "/v1/responses",
    body: { model: "gpt-5.5", input: [
      { type: "function_call", call_id: "c1", name: "read_log", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "boring log line\n".repeat(120) + "FATAL: CHECKOUT_BROKEN" },
      { role: "user", content: "What is the diagnostic code?" },
    ] }, checks: { toolIncludes: ["CHECKOUT_BROKEN"] }, answerChecks: { includes: ["CHECKOUT_BROKEN"] } };
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function json(req) { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks)); }

test("benchmark validates explicit live access, options and baseline inclusion", () => {
  assert.deepEqual(normalizeBenchmarkOptions({ presets: ["rtk"] }).presets, ["none", "rtk"]);
  for (const options of [
    { live: true }, { upstream: "https://example.com" }, { apiKey: "never-implicitly-send" },
    { live: true, upstream: "https://user:pass@example.com" },
    { live: true, upstream: "http://localhost", transports: ["ws"] },
    { presets: [] }, { presets: ["none", "none"] }, { presets: ["magic"] },
    { repetitions: 0 }, { warmup: -1 }, { seed: NaN }, { timeoutMs: -1 }, { transports: ["ftp"] },
  ]) assert.throws(() => normalizeBenchmarkOptions(options));
  assert.throws(() => prepareBenchmark({ fixtures: [fixture()], live: true, upstream: "http://localhost", repetitions: 201, presets: ["none"] }), /exceeding maxLiveCalls/);
  const hosted = fixture(); hosted.body.tools = [{ type: "web_search" }];
  assert.throws(() => prepareBenchmark({ fixtures: [hosted], live: true, upstream: "http://localhost" }), /provider-hosted tools/);
});

test("multi-model comparison validates explicit unique model IDs and conflicting overrides", () => {
  assert.deepEqual(normalizeBenchmarkOptions({ compareModels: comparisonModels }).compareModels, comparisonModels);
  for (const compareModels of [[], "gpt-6-astra", [""], [" "], [null], [42], ["gpt-6-astra", "gpt-6-astra"]]) {
    assert.throws(() => normalizeBenchmarkOptions({ compareModels }), /compareModels|compare-models/);
  }
  assert.throws(() => normalizeBenchmarkOptions({ compareModels: comparisonModels, model: "gpt-6-astra" }), /model/i);
});

test("multi-model preparation clones the same corpus, preserving protocols, checks and caller fixtures", () => {
  const fixtures = builtInFixtures().filter(f => f.id.endsWith("-short-output"));
  const snapshot = structuredClone(fixtures);
  const prepared = prepareBenchmark({ fixtures, compareModels: comparisonModels, transports: ["http", "ws"] });
  assert.equal(prepared.fixtures.length, fixtures.length * comparisonModels.length);
  assert.equal(new Set(prepared.fixtures.map(f => f.id)).size, prepared.fixtures.length);
  assert.deepEqual(new Set(prepared.options.models.split(",")), new Set(comparisonModels));
  for (const original of fixtures) for (const model of comparisonModels) {
    const copy = prepared.fixtures.find(f => f.id === `${original.id}@${model}`);
    assert.ok(copy, `missing ${original.id} for ${model}`);
    assert.deepEqual(copy, { ...original, id: `${original.id}@${model}`, body: { ...original.body, model } });
    assert.notEqual(copy.body, original.body);
    assert.notEqual(copy.checks, original.checks);
  }
  assert.equal(prepared.cases.filter(c => c.transport === "ws").length, 2);
  assert.ok(prepared.cases.filter(c => c.transport === "ws").every(c => c.fixture.format === "responses"));
  assert.deepEqual(fixtures, snapshot);
});

test("multi-model live-call ceiling covers all models, flows and warmups together", () => {
  const options = { fixtures: [fixture()], compareModels: comparisonModels, live: true,
    upstream: "http://127.0.0.1:1", repetitions: 9, warmup: 1, maxLiveCalls: 119 };
  assert.throws(() => prepareBenchmark(options), /120 calls, exceeding maxLiveCalls=119/);
  const prepared = prepareBenchmark({ ...options, maxLiveCalls: 120 });
  assert.equal(prepared.cases.length * prepared.options.presets.length *
    (prepared.options.repetitions + prepared.options.warmup), 120);
});

test("multi-model offline replay shares a corpus and keeps report groups separate", async () => {
  const fixtures = [fixture()], snapshot = structuredClone(fixtures);
  const options = { fixtures, compareModels: comparisonModels, presets: ["none"], repetitions: 2, warmup: 1, seed: 17 };
  const run = await runBenchmark(options);
  assert.equal(run.records.length, 6);
  assert.equal(run.meta.completed, true);
  assert.equal(run.meta.fixtureCount, 2);
  assert.deepEqual(new Set(run.meta.fixtures.map(f => f.model)), new Set(comparisonModels));
  assert.deepEqual(fixtures, snapshot);
  const report = buildReport(run);
  assert.equal(report.warmupRecords, 2);
  assert.equal(report.summaries.length, 2);
  assert.equal(report.decisions.length, 2);
  for (const model of comparisonModels) {
    const rows = report.records.filter(r => r.model === model);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(r => r.caseId === `tiny@${model}` && r.status === "ok" && r.preservation.status === "pass"));
    const summary = report.summaries.find(s => s.model === model);
    assert.equal(summary.attempts, 2);
    assert.equal(summary.tokens.saved, 0);
    assert.equal(report.decisions.find(d => d.model === model).status, "offline_only_no_quality_winner");
  }
  const again = await runBenchmark(options);
  assert.equal(again.meta.corpusHash, run.meta.corpusHash);
  assert.deepEqual(again.records.map(r => [r.caseId, r.model, r.round]), run.records.map(r => [r.caseId, r.model, r.round]));
});

test("offline real proxy replays HTTP and WS, preserves corpus, excludes warmup and does not touch AIH stats", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aih-benchmark-isolation-"));
  const old = process.env.AIH_HOME;
  process.env.AIH_HOME = dir;
  t.after(async () => { if (old === undefined) delete process.env.AIH_HOME; else process.env.AIH_HOME = old; await rm(dir, { recursive: true, force: true }); });
  const fixtures = [fixture()], snapshot = structuredClone(fixtures);
  const options = { fixtures, presets: ["none"], repetitions: 2, warmup: 1, transports: ["http", "ws"], seed: 5 };
  const run = await runBenchmark(options);
  assert.equal(run.records.length, 6);
  assert.equal(run.meta.completed, true);
  assert.ok(run.records.every(r => r.status === "ok" && r.before.totalTokens === r.after.totalTokens && r.preservation.status === "pass"));
  assert.ok(run.records.filter(r => r.transport === "ws").every(r => Number.isFinite(r.connectionMs)));
  assert.equal(run.records.filter(r => r.firstRequest).length, 1);
  assert.deepEqual(fixtures, snapshot);
  assert.deepEqual(await readdir(dir), []);
  const report = buildReport(run);
  assert.equal(report.warmupRecords, 2);
  assert.ok(report.summaries.every(s => s.attempts === 2 && s.tokens.saved === 0));
  assert.ok(report.decisions.every(d => d.paretoFrontier.length === 0));
  const again = await runBenchmark(options);
  assert.equal(again.meta.corpusHash, run.meta.corpusHash);
  assert.deepEqual(again.records.map(r => [r.caseId, r.preset, r.round, r.transport]), run.records.map(r => [r.caseId, r.preset, r.round, r.transport]));
});

test("real proxy Headroom integration counts captured payload, not advertised stage numbers", async t => {
  const received = [];
  const headroomUrl = await serve(t, async (req, res) => {
    assert.equal(req.url, "/v1/compress"); assert.equal(req.headers.authorization, undefined);
    const body = await json(req); received.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ messages: body.messages.map(m => ({ ...m, content: "FATAL: CHECKOUT_BROKEN" })), tokens_before: 999999, tokens_after: 1 }));
  });
  const run = await runBenchmark({ fixtures: [fixture()], presets: ["headroom"], headroomUrl, repetitions: 1, warmup: 0, transports: ["http", "ws"] });
  assert.equal(run.records.length, 4);
  for (const row of run.records.filter(r => r.preset === "headroom")) {
    assert.equal(row.status, "ok"); assert.equal(row.preservation.status, "pass");
    assert.ok(row.after.totalTokens < row.before.totalTokens);
    assert.equal(row.stages[0].saved, 999998);
    assert.notEqual(row.before.totalTokens - row.after.totalTokens, row.stages[0].saved);
  }
  assert.ok(received.every(r => r.config.mode === "lossy_inline"));
});

test("compressor failure is an error, not a free 100% saving", async t => {
  const headroomUrl = await serve(t, (_req, res) => { res.writeHead(503); res.end("not available"); });
  const report = buildReport(await runBenchmark({ fixtures: [fixture()], presets: ["headroom"], headroomUrl, repetitions: 1, warmup: 0 }));
  const row = report.records.find(r => r.preset === "headroom");
  assert.equal(row.status, "error"); assert.equal(row.after, null);
  const summary = report.summaries.find(r => r.preset === "headroom");
  assert.equal(summary.errors, 1); assert.equal(summary.tokens.saved, null);
});

test("late Headroom events cannot contaminate the next sample", async t => {
  let count = 0;
  const headroomUrl = await serve(t, async (req, res) => {
    const body = await json(req); const attempt = ++count;
    await new Promise(done => setTimeout(done, attempt === 1 ? 650 : 350));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ messages: body.messages, tokens_before: attempt === 1 ? 999999 : 10, tokens_after: 5 }));
  });
  const run = await runBenchmark({ fixtures: [fixture()], presets: ["headroom"], headroomUrl, repetitions: 2, warmup: 0, timeoutMs: 500 });
  const rows = run.records.filter(r => r.preset === "headroom");
  assert.equal(rows[0].status, "error");
  assert.equal(rows[1].status, "ok");
  assert.equal(rows[1].stages.length, 1);
  assert.equal(rows[1].stages[0].before, 10);
});

test("live timeout cancels downstream fetch and never retries", async t => {
  let requests = 0;
  let closed;
  const disconnected = new Promise(done => { closed = done; });
  const upstream = await serve(t, async (req, res) => {
    await json(req); requests++;
    res.once("close", closed);
    // Deliberately never answer: per-sample cancellation must close this socket.
  });
  const run = await runBenchmark({ fixtures: [fixture()], presets: ["none"], live: true, upstream, repetitions: 1, warmup: 0, timeoutMs: 100 });
  assert.equal(run.records[0].status, "error");
  assert.equal(requests, 1);
  await Promise.race([disconnected, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Provider fetch was not cancelled")), 1500); timer.unref(); })]);
});

test("live routes compressed payloads to explicit provider, scores real response and never executes tool calls", async t => {
  const requests = [];
  const upstream = await serve(t, async (req, res) => {
    const body = await json(req); requests.push(body);
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer TEST-KEY-DO-NOT-REPORT");
    assert.equal(req.headers["x-request-id"], undefined);
    assert.equal(body.stream, false); assert.equal(body.max_output_tokens, 48);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "CHECKOUT_BROKEN" }] }],
      usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } } }));
  });
  const run = await runBenchmark({ fixtures: [fixture()], presets: ["none"], live: true, upstream, apiKey: "TEST-KEY-DO-NOT-REPORT", repetitions: 2, warmup: 1, maxOutputTokens: 48 });
  assert.equal(requests.length, 3);
  assert.ok(run.records.every(r => r.status === "ok" && r.answerQuality.status === "pass" && r.live.complete));
  const report = buildReport(run);
  assert.equal(report.summaries[0].provider.input.total, 200);
  assert.equal(report.summaries[0].provider.cachedInput.total, 40);
  assert.equal(JSON.stringify(report).includes("TEST-KEY-DO-NOT-REPORT"), false);
  assert.equal(JSON.stringify(report).includes('"text":"CHECKOUT_BROKEN"'), false);
  assert.equal(JSON.stringify(report).includes("CHECKOUT_BROKEN"), false);
  assert.equal(run.meta.mode, "live");
});

test("actual pxpipe pipeline produces images and never treats base64 as tokens", { timeout: 20000 }, async () => {
  const dense = builtInFixtures({ formats: ["responses"] }).find(f => f.category === "context");
  assert.ok(dense, "dense context fixture exists");
  const run = await runBenchmark({ fixtures: [dense], presets: ["pxpipe"], repetitions: 1, warmup: 0 });
  const row = run.records.find(r => r.preset === "pxpipe");
  assert.equal(row.status, "ok"); assert.ok(row.after.images > 0);
  assert.ok(row.after.textTokens < row.before.textTokens);
  assert.ok(row.after.totalTokens === null || row.after.totalTokens < row.after.bytes);
  assert.equal(row.stages[0].name, "pxpipe");
});

test("real RTK pipe smoke test if installed", async t => {
  try { await exec("rtk", ["--version"], { windowsHide: true }); }
  catch { t.skip("rtk not installed"); return; }
  const run = await runBenchmark({ fixtures: [fixture()], presets: ["rtk"], repetitions: 1, warmup: 0 });
  assert.ok(run.records.every(r => r.status === "ok"));
  assert.equal(run.records.find(r => r.preset === "rtk").stages[0].method, "o200k_estimate");
});

test("CLI writes isolated artifacts and refuses overwrite", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aih-benchmark-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "fixtures.json"), out = join(dir, "out");
  await writeFile(file, JSON.stringify([fixture()]));
  const args = ["scripts/bench-proxy.js", "--fixtures", file, "--presets", "none", "--warmup", "0", "--repetitions", "1", "--out", out];
  await exec(process.execPath, args, { windowsHide: true });
  const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  assert.equal(report.records.length, 1);
  assert.deepEqual((await readdir(out)).sort(), ["records.jsonl", "report.json", "report.md", "results.csv"]);
  await assert.rejects(exec(process.execPath, args, { windowsHide: true }));
  const invalidOut = join(dir, "invalid");
  await assert.rejects(exec(process.execPath, ["scripts/bench-proxy.js", "--out", invalidOut, "--repetitions", "0"], { windowsHide: true }));
  await assert.rejects(readdir(invalidOut), { code: "ENOENT" });
});

test("multi-model CLI lists, exports and replays the requested model IDs", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aih-benchmark-models-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const common = ["scripts/bench-proxy.js", "--compare-models", comparisonModels.join(","), "--formats", "responses"];
  const { stdout } = await exec(process.execPath, [...common, "--list"], { windowsHide: true });
  for (const model of comparisonModels) assert.ok(stdout.includes(`responses-short-output@${model}`));
  const exportedFile = join(dir, "exported.json");
  await exec(process.execPath, [...common, "--export-fixtures", exportedFile], { windowsHide: true });
  const exported = JSON.parse(await readFile(exportedFile, "utf8"));
  assert.equal(exported.length, builtInFixtures({ formats: ["responses"] }).length * 2);
  assert.equal(new Set(exported.map(f => f.id)).size, exported.length);
  assert.deepEqual(new Set(exported.map(f => f.body.model)), new Set(comparisonModels));
  assert.ok(exported.every(f => f.format === "responses" && f.id.endsWith(`@${f.body.model}`)));
  const file = join(dir, "tiny.json"), out = join(dir, "out");
  await writeFile(file, JSON.stringify([fixture()]));
  await exec(process.execPath, [...common, "--fixtures", file, "--presets", "none", "--warmup", "0", "--repetitions", "1", "--out", out], { windowsHide: true });
  const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  assert.equal(report.records.length, 2);
  assert.deepEqual(new Set(report.summaries.map(s => s.model)), new Set(comparisonModels));
  await assert.rejects(exec(process.execPath, [...common, "--model", "gpt-6-astra", "--list"], { windowsHide: true }));
});
