import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { inflateSync } from "node:zlib";
import { builtInFixtures, validateFixtures } from "../src/benchmark/fixtures.js";
import { visualCodePng } from "../src/benchmark/quality-fixtures.js";
import { evaluateAnswer, evaluatePreservation, evaluateEvidence, requestTexts } from "../src/benchmark/quality.js";
import { requestImages, compareRequestImages } from "../src/request-images.js";
import { normalizePresetOptions, createPresetHooks } from "../src/proxy-presets.js";
import { normalizeProxyOptions } from "../src/proxy.js";
import { prepareBenchmark, runBenchmark, BENCHMARK_PRESETS } from "../src/benchmark/runner.js";
import { buildReport } from "../src/benchmark/report.js";

const test = typeof Bun === "undefined" ? nodeTest : nodeTest.skip;
const image = (id = "a", detail = "high") => ({ type: "input_image", image_url: `https://example.invalid/${id}.png`, detail });
const user = content => ({ role: "user", content });
const text = value => ({ type: "input_text", text: value });

test("quality suite is opt-in, deterministic, strictly scored and does not leak visual answers in native text", () => {
  const fixtures = builtInFixtures({ suite: "quality" });
  assert.equal(fixtures.length, 12); assert.equal(builtInFixtures().length, 30);
  assert.equal(builtInFixtures({ suite: "all" }).length, 42);
  assert.deepEqual(fixtures, builtInFixtures({ suite: "quality" }));
  assert.equal(validateFixtures(fixtures), fixtures);
  for (const f of fixtures) {
    assert.ok(f.answerChecks.exact || f.answerChecks.jsonEquals);
    const correct = f.answerChecks.exact || JSON.stringify(f.answerChecks.jsonEquals);
    assert.equal(evaluateAnswer(correct, f.answerChecks).status, "pass", f.id);
    assert.equal(evaluateAnswer(`Here is the answer: ${correct}`, f.answerChecks).status, "fail", f.id);
    assert.equal(evaluatePreservation(f.body, f.body, f.checks).status, "pass", f.id);
    if (f.evaluation?.kind === "native_image") {
      assert.ok(requestImages(f.body).length);
      for (const value of f.evaluation.evidence) assert.equal(requestTexts(f.body).join("\n").includes(value), false);
    }
  }
  assert.equal(fixtures.filter(f => f.evaluation?.kind === "native_image").length, 7);
  assert.equal(fixtures.filter(f => f.evaluation?.kind === "rendered_context").length, 2);
  const bad = structuredClone(fixtures.find(f => f.evaluation?.kind === "native_image"));
  bad.body.input.push(user(`Leaked answer: ${bad.answerChecks.exact}`));
  assert.throws(() => validateFixtures([bad]), /absent from native text/);
  assert.throws(() => prepareBenchmark({ suite: "quality", formats: ["chat"] }), /Responses only/);
  assert.throws(() => prepareBenchmark({ suite: "quality", fixtures: fixtures.slice(0, 1) }), /fixtures OR suite/);
  assert.throws(() => builtInFixtures({ suite: "typo" }), /suite/);
});

test("visual fixtures are real deterministic PNG pixels without answer-bearing metadata", () => {
  const first = visualCodePng("K7M2"), second = visualCodePng("R4T9");
  assert.deepEqual(first, visualCodePng("K7M2")); assert.notDeepEqual(first, second);
  const types = [], compressed = [];
  for (let at = 8; at < first.length;) {
    const length = first.readUInt32BE(at), type = first.toString("ascii", at + 4, at + 8);
    types.push(type); if (type === "IDAT") compressed.push(first.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
  assert.equal(first.readUInt32BE(16), 320); assert.equal(first.readUInt32BE(20), 160);
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.equal(pixels.length, 160 * (320 * 3 + 1));
  assert.ok(pixels.includes(24)); assert.ok(pixels.includes(255));
  assert.throws(() => visualCodePng("BAD!"));
});

test("strict answers reject extra prose, keys, wrong types, fences and duplicate JSON keys", () => {
  const checks = { jsonEquals: { code: "E42", line: 73, detail: { ok: true } }, maxChars: 200 };
  assert.equal(evaluateAnswer(' {"detail":{"ok":true},"line":73,"code":"E42"}\n', checks).status, "pass");
  for (const value of [
    '{"code":"E42","line":"73","detail":{"ok":true}}',
    '{"code":"E42","line":73,"detail":{"ok":true},"extra":1}',
    '```json\n{"code":"E42","line":73,"detail":{"ok":true}}\n```',
    '{"code":"BAD","code":"E42","line":73,"detail":{"ok":true}}',
    '{"code":"BAD","co\\u0064e":"E42","line":73,"detail":{"ok":true}}',
    '{"code":"E42","line":73,"detail":{"ok":false,"ok":true}}',
    '{"code":"E42","line":73}', "null", "[]", "",
  ]) assert.equal(evaluateAnswer(value, checks).status, "fail", value);
  assert.equal(evaluateAnswer("  hold\n", { exact: "hold" }).status, "pass");
  assert.equal(evaluateAnswer("HOLD", { exact: "hold" }).status, "fail");
  assert.equal(evaluateAnswer("hold because...", { exact: "hold" }).status, "fail");
  assert.equal(evaluateAnswer("length", { maxChars: 2 }).status, "fail");
  assert.equal(evaluateAnswer(null, checks).status, "indeterminate");
  for (const invalid of [{ exact: "" }, { jsonEquals: undefined }, { jsonEquals: null }, { jsonEquals: { a: NaN } }, { maxChars: 0 }, { regex: ".*" }]) {
    assert.throws(() => evaluateAnswer("text", invalid));
  }
});

test("native image detection recognizes protocol slots and ignores schemas, metadata and quoted JSON", () => {
  const bodies = [
    { input: [user([image()])] },
    { input: [{ type: "function_call_output", call_id: "c1", output: [image()] }] },
    { input: [user([{ type: "input_image", file_id: "file-native", detail: "low" }])] },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/a.png", detail: "high" } }] }] },
    { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] }] },
    { input: [user([{ inline_data: { mime_type: "image/png", data: "AA==" } }])] },
  ];
  for (const body of bodies) {
    assert.equal(requestImages(body).length, 1);
    const routing = requestImages(body, { identities: false });
    assert.equal(routing.length, 1); assert.equal(routing[0].fingerprint, undefined);
  }
  assert.equal(requestImages({ metadata: { picture: image() }, tools: [{ parameters: { type: "image" } }], input: [user(JSON.stringify(image()))] }).length, 0);
  for (const value of [null, {}, { input: null }, { messages: [null] }]) assert.equal(requestImages(value).length, 0);
});

test("native images keep exact data/detail, counts, order, message association and grouping", () => {
  const body = { model: "test", input: [user([text("earlier"), image()]), user([text("current"), image("b")])] };
  const good = structuredClone(body); good.input.unshift(user([text("generated context"), image("generated")]));
  assert.equal(compareRequestImages(body, good).status, "pass");
  assert.equal(compareRequestImages(body, good).addedOrChanged, 1);
  for (const mutate of [
    b => b.input.pop(), b => { b.input[0].content[1].detail = "low"; },
    b => b.input.reverse(), b => b.input[0].content.push(image()),
    b => { b.input[0].role = "assistant"; }, b => { b.input[0].content[0].text = "different association"; },
    b => { const a = b.input[0].content[1]; b.input[0].content[1] = b.input[1].content[1]; b.input[1].content[1] = a; },
  ]) { const bad = structuredClone(body); mutate(bad); assert.equal(compareRequestImages(body, bad).status, "fail"); }
  const pair = { input: [user([image(), image("b")])] };
  assert.equal(compareRequestImages(pair, { input: [user([image()]), user([image("b")])] }).status, "fail");
  const duplicate = { input: [user([image(), image()])] };
  const dropped = compareRequestImages(duplicate, { input: [user([image()])] });
  assert.equal(dropped.missingOrChanged, 1); assert.equal(dropped.status, "fail");
  const tool = { input: [{ type: "function_call_output", call_id: "c1", output: [image()] }] };
  const wrongTool = structuredClone(tool); wrongTool.input[0].call_id = "c2";
  assert.equal(compareRequestImages(tool, wrongTool).status, "fail");
});

test("an unchanged native image cannot hide text loss, and image corruption is a preservation failure", () => {
  const original = { model: "test", input: [user([image()]), { type: "function_call_output", call_id: "c", output: "E_CRITICAL" }] };
  const changed = structuredClone(original); changed.input[1].output = "all fine";
  assert.equal(evaluatePreservation(original, changed, { toolIncludes: ["E_CRITICAL"] }).status, "fail");
  changed.input[0].content.push(image("generated"));
  assert.equal(evaluatePreservation(original, changed, { toolIncludes: ["E_CRITICAL"] }).status, "indeterminate");
  changed.input[0].content[0].detail = "low";
  assert.equal(evaluatePreservation(original, changed, {}).status, "fail");
});

test("benchmark bypass aliases are opt-in, map to real recipes and count towards live cap", () => {
  const f = builtInFixtures({ suite: "quality" })[5];
  const options = { fixtures: [f], compareModels: ["gpt-6-astra", "anthropic/claude-fable-5-1"], presets: ["pxpipe", "pxpipe-native-bypass"], repetitions: 1, warmup: 0, live: true, upstream: "http://127.0.0.1:1" };
  assert.throws(() => prepareBenchmark({ ...options, maxLiveCalls: 5 }), /6 calls/);
  assert.equal(prepareBenchmark({ ...options, maxLiveCalls: 6 }).options.presets.length, 3);
  assert.equal(BENCHMARK_PRESETS.some(p => p.endsWith("-native-bypass")), false);
  assert.throws(() => prepareBenchmark({ presets: ["none-native-bypass"] }), /supported presets/);
  assert.equal(normalizePresetOptions({ preset: "pxpipe" }).pxpipeNativeImages, "allow");
  assert.throws(() => normalizePresetOptions({ pxpipeNativeImages: "typo" }), /allow or bypass/);
});

test("real HTTP/WS proxies compare native-image allow/bypass and image-only instruction evidence", { timeout: 30000 }, async () => {
  const fixtures = builtInFixtures({ suite: "quality" }).filter(f => ["responses-native-single", "responses-rendered-rule"].includes(f.id));
  const before = structuredClone(fixtures);
  const run = await runBenchmark({ fixtures, presets: ["pxpipe", "pxpipe-native-bypass"], repetitions: 1, warmup: 0, transports: ["http", "ws"] });
  assert.equal(run.records.length, 12); assert.equal(run.meta.completed, true); assert.deepEqual(fixtures, before);
  for (const row of run.records) {
    assert.equal(row.status, "ok");
    if (row.caseId === "responses-native-single") {
      assert.equal(row.imageIntegrity.status, "pass"); assert.equal(row.imageIntegrity.retained, 1);
      assert.equal(row.evidence.status, "native_image_required");
      if (row.preset === "pxpipe-native-bypass") {
        assert.equal(row.changed, false); assert.equal(row.after.images, 1);
        assert.equal(row.stages[0].reason, "native_images_present");
      } else if (row.preset === "pxpipe") assert.ok(row.imageIntegrity.addedOrChanged > 0);
    } else if (row.preset !== "none") {
      assert.ok(row.imageIntegrity.addedOrChanged > 0);
      assert.equal(row.evidence.status, "rendered_image_required", "Expected answer must not survive in pxpipe's native factsheet");
    }
  }
  const report = buildReport(run);
  assert.ok(report.decisions.every(d => d.status === "offline_only_no_quality_winner"));
  assert.equal(run.meta.flowConfigs["pxpipe-native-bypass"].preset, "pxpipe");
});

test("bypass decision is captured before Headroom and only skips pxpipe", async t => {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    res.setHeader("content-type", "application/json");
    // Deliberately bad compressor removes an attachment. The original-image
    // snapshot must still bypass pxpipe, and preservation must flag the loss.
    res.end(JSON.stringify({ messages: body.messages.map(m => ({ ...m, content: "Headroom text" })), tokens_before: 100, tokens_after: 5 }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const events = [], config = normalizeProxyOptions({ upstream: "http://127.0.0.1:1", preset: "headroom-pxpipe", pxpipeNativeImages: "bypass", models: "gpt-5.5", headroomUrl: `http://127.0.0.1:${server.address().port}` });
  const hooks = await createPresetHooks(config, e => events.push(e));
  const original = { model: "gpt-5.5", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/a.png" } }, { type: "text", text: "Inspect image" }] }] };
  const context = { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(original)) };
  await hooks.onRequest(context);
  assert.deepEqual(events[0].stages.map(s => s.name), ["headroom", "pxpipe"]);
  assert.equal(events[0].stages[0].applied, true); assert.equal(events[0].stages[1].reason, "native_images_present");
  assert.equal(evaluatePreservation(original, JSON.parse(context.body), {}).status, "fail");
});
