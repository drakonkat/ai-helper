import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import zlib from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";
import { normalizeProxyOptions, startProxy } from "../src/proxy.js";
import { createPresetHooks } from "../src/proxy-presets.js";
import { transformOpenAIResponses } from "pxpipe-proxy";
import { createProxyStatsRecorder, readProxyStats, tokenStage } from "../src/proxy-stats.js";

const exec = promisify(execFile);
// The proxy worker deliberately runs on Node, including when launched by Bun.
const test = typeof Bun === "undefined" ? nodeTest : nodeTest.skip;
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  const sockets = new Set();
  upstream.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const url = await listen(upstream);
  const proxy = await startProxy({ upstream: url + (options.prefix || ""), listen: "http://127.0.0.1:0", ...options });
  t.after(async () => {
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolveClose => upstream.close(resolveClose));
  });
  return { upstream, url, proxy };
}
function request(url, options = {}, body) {
  return new Promise((resolveResponse, reject) => {
    const outgoing = http.request(url, options, incoming => {
      const chunks = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.on("end", () => resolveResponse({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "aih proxy-"));
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("aih proxy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("validates proxy options and accepts the abbreviated URL", () => {
  assert.equal(normalizeProxyOptions({ upstream: "http:127.0.0.1:10100/" }).upstream, "http://127.0.0.1:10100/");
  for (const options of [
    {}, { upstream: "file:///tmp" }, { upstream: "http://user:pass@localhost" },
    { upstream: "http://localhost?a=b" }, { upstream: "http://localhost:10101" },
    { upstream: "http://localhost:10100", listen: "http://0.0.0.0:10101" },
    { upstream: "http://localhost:10100", maxBodyBytes: "NaN" },
    { upstream: "http://localhost:10100", preset: "missing" },
    { upstream: "http://localhost:10100", preset: "pxpipe", models: "gpt-5.5,," },
    { upstream: "http://localhost:10100", headroomUrl: "file:///tmp" },
    { upstream: "http://localhost:10100", rtkFilter: "grep; whoami" },
  ]) assert.throws(() => normalizeProxyOptions(options));
});

const denseInstructions = Array.from({ length: 600 }, (_, i) => `Rule ${i}: inspect function config_${i}(value) and preserve identifier component_${i}; validate errors with status=${400 + i % 100}.`).join("\n");
const aiBody = () => ({ model: "gpt-5.5", instructions: denseInstructions, input: [{ role: "user", content: "Check the code" }] });

test("pxpipe preset uses the real library, gates models, and preserves WS envelopes/model inheritance", { timeout: 15000 }, async t => {
  const config = normalizeProxyOptions({ upstream: "http://localhost:10100", preset: "pxpipe", models: "gpt-5.5*" });
  const measurements = [];
  const hooks = await createPresetHooks(config, event => measurements.push(event));
  t.after(() => hooks.close());
  const original = aiBody();
  const expected = await transformOpenAIResponses(Buffer.from(JSON.stringify(original)), { model: original.model });
  assert.equal(expected.info.compressed, true);
  assert.ok(expected.info.imageCount > 0);
  const context = { method: "POST", path: "/v1/responses", headers: { "content-type": "application/json", "content-encoding": "gzip", digest: "old" }, body: gzipSync(JSON.stringify(original)) };
  await hooks.onRequest(context);
  assert.deepEqual(JSON.parse(context.body), JSON.parse(Buffer.from(expected.body)));
  assert.equal(context.headers["content-encoding"], undefined);
  assert.equal(context.headers.digest, undefined);
  assert.equal(measurements[0].stages[0].saved, Math.round(expected.info.baselineImagedTokens - expected.info.imageTokens - expected.info.nativeInjectedTokens));
  for (const body of [{ ...original, model: "other-model" }, { model: "gpt-5.5", input: "short" }]) {
    const raw = Buffer.from(JSON.stringify(body));
    const request = { ...context, headers: { "content-type": "application/json" }, body: raw };
    await hooks.onRequest(request);
    assert.strictEqual(request.body, raw);
  }
  const request = { path: "/v1/responses" };
  const first = { request, direction: "request", isBinary: false, body: Buffer.from(JSON.stringify({ type: "response.create", event_id: "keep", response: original })) };
  await hooks.onWebSocketMessage(first);
  assert.deepEqual(JSON.parse(first.body), { type: "response.create", event_id: "keep", response: JSON.parse(Buffer.from(expected.body)) });
  const { model, ...withoutModel } = original;
  const second = { ...first, body: Buffer.from(JSON.stringify({ type: "response.create", ...withoutModel })) };
  await hooks.onWebSocketMessage(second);
  const parsed = JSON.parse(second.body);
  assert.equal(parsed.type, "response.create");
  assert.equal(parsed.model, undefined);
  assert.match(second.body.toString(), /data:image\/png;base64/);
  for (const event of [{ ...first, direction: "response" }, { ...first, isBinary: true }, { ...first, request: { path: "/v1/responses" }, body: Buffer.from(JSON.stringify({ type: "response.create", ...withoutModel })) }]) {
    const raw = event.body;
    await hooks.onWebSocketMessage(event);
    assert.strictEqual(event.body, raw);
  }
  assert.equal(measurements.length, 5); // No counting binary frames or upstream responses.
  assert.equal(measurements[1].stages[0].reason, "model_excluded");
  assert.ok(measurements.every(event => Number.isFinite(event.timings.presetMs) && event.timings.presetMs >= 0));
  assert.equal(request.updateTiming, undefined); // A WS connection is not a single response.
  assert.ok(measurements.at(-1).timings.pxpipeQueueMs >= 0);
  assert.ok(measurements.at(-1).timings.pxpipeMs >= 0);
});

test("timing updates persist out of order without recounting or resurrecting evicted requests", async t => {
  const file = join(await temp(t), "stats.json");
  const record = createProxyStatsRecorder(file);
  const event = { model: "first", preset: "pxpipe", transport: "HTTP", changed: true,
    stages: [tokenStage("pxpipe", 10, 8, true, "applied", "estimate")], timings: { presetMs: 2 } };
  const first = record(event);
  const second = record({ ...event, model: "second" });
  const before = readProxyStats(file);
  second({ totalMs: 10, state: "completed" });
  first({ upstreamHeadersMs: 20, state: "responding" });
  first({ totalMs: 30, state: "completed" });
  const after = readProxyStats(file);
  assert.equal(after.requests, 2);
  assert.equal(after.estimatedSavedTokens, 4);
  assert.deepEqual(after.stages, before.stages);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual(after.recent.map(e => e.at), before.recent.map(e => e.at));
  assert.deepEqual(after.recent[0].timings, { presetMs: 2, upstreamHeadersMs: 20, totalMs: 30, state: "completed" });
  assert.equal(after.recent[1].timings.totalMs, 10);
  for (let i = 0; i < 20; i++) record({ ...event, model: `later-${i}` });
  const evicted = await readFile(file, "utf8");
  first({ totalMs: 999 });
  assert.equal(await readFile(file, "utf8"), evicted);
});

test("HTTP/SSE timing updates preserve streaming, concurrency and upstream error statuses", { timeout: 15000 }, async t => {
  const dir = await temp(t);
  const file = join(dir, "stats.json");
  const interceptor = join(dir, "delay.mjs");
  await writeFile(interceptor, "export async function onRequest() { await new Promise(r => setTimeout(r, 30)); }\n");
  const record = createProxyStatsRecorder(file);
  let streamResponse;
  let arrive;
  const arrived = new Promise(resolve => { arrive = resolve; });
  let events = 0;
  const { proxy } = await fixture(t, (req, res) => {
    req.resume();
    if (req.headers["x-case"] === "fast") { res.writeHead(503); res.end("upstream unavailable"); }
    else { streamResponse = res; arrive(); }
  }, { preset: "pxpipe", models: "excluded", interceptor, onStats: event => {
    events++;
    return record(event);
  } });
  const options = { method: "POST", headers: { "content-type": "application/json" } };
  const outgoing = http.request(proxy.url + "/v1/responses", options);
  t.after(() => outgoing.destroy());
  const response = once(outgoing, "response");
  outgoing.end(JSON.stringify({ model: "slow", input: "hello" }));
  await arrived;
  assert.equal(readProxyStats(file).recent[0].timings.state, "waiting");
  await delay(30);
  streamResponse.writeHead(200, { "content-type": "text/event-stream" });
  streamResponse.flushHeaders();
  const [incoming] = await response;
  const headerTiming = readProxyStats(file).recent[0].timings;
  assert.equal(headerTiming.state, "responding");
  assert.ok(headerTiming.upstreamHeadersMs >= 20);
  assert.equal(headerTiming.totalMs, undefined);
  const chunk = once(incoming, "data");
  streamResponse.write("data: first\n\n");
  assert.equal((await chunk)[0].toString(), "data: first\n\n");
  assert.equal(incoming.readableEnded, false);
  const fast = await request(proxy.url + "/v1/responses", {
    ...options, headers: { ...options.headers, "x-case": "fast" },
  }, JSON.stringify({ model: "fast", input: "hello" }));
  assert.equal(fast.status, 503);
  let stats = readProxyStats(file);
  assert.equal(stats.recent[0].timings.totalMs, undefined);
  assert.equal(stats.recent[1].timings.statusCode, 503);
  assert.equal(stats.recent[1].timings.state, "completed");
  const ended = once(incoming, "end");
  streamResponse.end("data: done\n\n");
  incoming.resume();
  await ended;
  stats = readProxyStats(file);
  assert.equal(events, 2);
  assert.equal(stats.requests, 2);
  assert.equal(stats.errors, 0); // An upstream 503 is not a preset error.
  assert.deepEqual(stats.recent.map(event => event.model), ["slow", "fast"]);
  const timing = stats.recent[0].timings;
  assert.equal(timing.state, "completed");
  assert.equal(timing.statusCode, 200);
  assert.ok(timing.presetMs >= 0);
  assert.ok(timing.totalMs >= timing.presetMs + timing.upstreamHeadersMs + 20); // Custom interceptor is only in total.
});

test("HTTP timing distinguishes transport failure and client cancellation without counting twice", { timeout: 15000 }, async t => {
  const file = join(await temp(t), "stats.json");
  const record = createProxyStatsRecorder(file);
  const completions = [];
  let streamResponse;
  const { proxy } = await fixture(t, (req, res) => {
    req.resume();
    if (req.headers["x-case"] === "fail") { res.destroy(); return; }
    streamResponse = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    if (req.headers["x-case"] === "truncate") setTimeout(() => res.destroy(), 30);
  }, { preset: "pxpipe", models: "excluded", onStats: event => {
    const update = record(event);
    let complete;
    completions.push(new Promise(resolve => { complete = resolve; }));
    return timing => {
      update(timing);
      if (Number.isFinite(timing.totalMs)) complete();
    };
  } });
  const options = name => ({ method: "POST", headers: { "content-type": "application/json", "x-case": name } });
  const body = JSON.stringify({ model: "test", input: "hello" });
  assert.equal((await request(proxy.url + "/v1/responses", options("fail"), body)).status, 502);
  await completions[0];
  let timing = readProxyStats(file).recent.at(-1).timings;
  assert.equal(timing.state, "error");
  assert.equal(timing.upstreamHeadersMs, undefined);
  assert.ok(timing.totalMs >= 0);
  await assert.rejects(request(proxy.url + "/v1/responses", options("truncate"), body));
  await completions[1];
  timing = readProxyStats(file).recent.at(-1).timings;
  assert.equal(timing.state, "error");
  assert.equal(timing.statusCode, 200);
  const outgoing = http.request(proxy.url + "/v1/responses", options("cancel"));
  t.after(() => outgoing.destroy());
  const response = once(outgoing, "response");
  outgoing.end(body);
  const [incoming] = await response;
  await once(incoming, "data");
  const closed = once(streamResponse, "close");
  incoming.destroy();
  await closed;
  await completions[2];
  const stats = readProxyStats(file);
  assert.equal(stats.recent.at(-1).timings.state, "aborted");
  assert.ok(stats.recent.at(-1).timings.totalMs >= 0);
  assert.equal(stats.requests, 3);
  assert.equal(stats.errors, 0);
});

test("proxy counters persist, keep negative savings and unknown estimates, and omit body content", async t => {
  const dir = await temp(t);
  const file = join(dir, "stats.json");
  assert.equal(readProxyStats(file), null);
  let record = createProxyStatsRecorder(file);
  const event = { model: "test-model", preset: "headroom-pxpipe", transport: "HTTP", changed: true, body: "must-not-be-saved", stages: [
    tokenStage("headroom", 100, 70, true, "applied", "headroom"),
    tokenStage("pxpipe", 70, 80, true, "applied", "pxpipe_estimate"),
  ] };
  record(event);
  record = createProxyStatsRecorder(file);
  record({ ...event, changed: false, stages: [tokenStage("pxpipe", undefined, undefined, true, "unknown", "pxpipe_estimate")] });
  record({ ...event, error: true });
  const stats = readProxyStats(file);
  assert.equal(stats.requests, 3);
  assert.equal(stats.errors, 1);
  assert.equal(stats.estimatedSavedTokens, 20);
  assert.equal(stats.stages.headroom.saved, 30);
  assert.equal(stats.stages.pxpipe.saved, -10);
  assert.equal(stats.unmeasuredStages, 1);
  assert.doesNotMatch(await readFile(file, "utf8"), /must-not-be-saved/);
  await writeFile(file, "incomplete{");
  assert.equal(readProxyStats(file), null);
});

test("Zstandard requests produce stats for Astra/AGY and preserve bytes when excluded", { timeout: 15000 }, async t => {
  if (!zlib.zstdCompressSync) return t.skip("Zstandard requires Node 22.15+");
  const events = [];
  const config = normalizeProxyOptions({ upstream: "http://localhost:10100", preset: "pxpipe", models: "gpt-6-astra,google-antigravity/gemini-3.8*" });
  const hooks = await createPresetHooks(config, event => events.push(event));
  t.after(() => hooks.close());
  for (const model of ["gpt-6-astra", "google-antigravity/gemini-3.8-flash", "other-model"]) {
    const raw = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ ...aiBody(), model })));
    const context = { method: "POST", path: "/v1/responses", headers: { "content-type": "application/json", "content-encoding": "zstd" }, body: raw };
    await hooks.onRequest(context);
    assert.equal(events.at(-1).model, model);
    assert.equal(events.at(-1).error, false);
    if (model === "other-model") {
      assert.equal(events.at(-1).stages[0].reason, "model_excluded");
      assert.strictEqual(context.body, raw);
      assert.equal(context.headers["content-encoding"], "zstd");
    } else {
      assert.notEqual(events.at(-1).stages[0].reason, "model_excluded");
      if (events.at(-1).changed) {
        assert.equal(context.headers["content-encoding"], undefined);
        assert.equal(JSON.parse(context.body).model, model);
      }
    }
  }
  const limited = await createPresetHooks({ ...config, maxBodyBytes: 32 });
  t.after(() => limited.close());
  await assert.rejects(limited.onRequest({ method: "POST", path: "/v1/responses", headers: { "content-type": "application/json", "content-encoding": "zstd" }, body: zlib.zstdCompressSync(Buffer.alloc(1024)) }));
});

test("Headroom runs before real pxpipe over HTTP and WS, then the custom interceptor", { timeout: 15000 }, async t => {
  const received = [];
  const measurements = [];
  let failure = false;
  const compressor = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/compress");
    assert.equal(req.headers.authorization, undefined); // upstream credentials never reach Headroom
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.config.mode, "lossy_inline");
    received.push(body);
    res.writeHead(failure ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: body.messages.map(m => ({ ...m, content: "headroom-result" })), tokens_before: 100, tokens_after: 40 }));
  });
  const headroomUrl = await listen(compressor);
  t.after(() => { compressor.closeAllConnections(); return new Promise(done => compressor.close(done)); });
  const dir = await temp(t);
  const interceptor = join(dir, "after.mjs");
  await writeFile(interceptor, 'export function onRequest(c) { c.headers["x-after-preset"] = JSON.parse(c.body).input.find(i => i.type === "function_call_output").output; }');
  const { proxy, upstream } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("x-after-preset", req.headers["x-after-preset"]);
    res.end(Buffer.concat(chunks));
  }, { preset: "headroom-pxpipe", models: "gpt-5.5", headroomUrl, interceptor, onStats: event => measurements.push(event) });
  const wsServer = new WebSocketServer({ server: upstream });
  wsServer.on("connection", socket => socket.on("message", data => socket.send(data, { binary: false })));
  t.after(() => wsServer.close());
  const body = aiBody();
  body.input.push({ type: "function_call", name: "read", call_id: "call-1", arguments: "{}" }, { type: "function_call_output", call_id: "call-1", output: "original tool output" }, { type: "reasoning", id: "reason-1", encrypted_content: "unchanged", summary: [] });
  const afterHeadroom = structuredClone(body);
  afterHeadroom.input[2].output = "headroom-result";
  const expected = await transformOpenAIResponses(Buffer.from(JSON.stringify(afterHeadroom)), { model: body.model });
  const result = await request(proxy.url + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-only" } }, JSON.stringify(body));
  assert.equal(result.status, 200);
  assert.equal(result.headers["x-after-preset"], "headroom-result");
  assert.deepEqual(JSON.parse(result.body), JSON.parse(Buffer.from(expected.body)));
  assert.deepEqual(measurements[0].stages.map(s => s.name), ["headroom", "pxpipe"]);
  assert.equal(measurements[0].stages[0].saved, 60);
  assert.deepEqual(received[0].messages, [{ role: "tool", tool_call_id: "0", content: "original tool output" }]);
  const ws = new WebSocket(proxy.url.replace("http:", "ws:") + "/v1/responses");
  t.after(() => ws.terminate());
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify({ type: "response.create", ...body }));
  assert.deepEqual(JSON.parse((await reply)[0]), { type: "response.create", ...JSON.parse(Buffer.from(expected.body)) });
  failure = true;
  assert.equal((await request(proxy.url + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" } }, JSON.stringify(body))).status, 502);
  assert.equal(measurements.length, 3);
  assert.equal(measurements[2].error, true);
});

test("rtk preset filters only tool output text in all three AI formats", { timeout: 15000 }, async t => {
  try { await exec("rtk", ["--version"], { windowsHide: true }); }
  catch (error) { if (error.code === "ENOENT") return t.skip("rtk is not installed"); throw error; }
  const hooks = await createPresetHooks(normalizeProxyOptions({ upstream: "http://localhost:10100", preset: "rtk", rtkFilter: "grep" }));
  const text = Array.from({ length: 80 }, (_, i) => `src/example.js:${i + 1}: repeated match value`).join("\n") + "\n";
  const bodies = [
    ["/v1/responses", { input: [{ type: "function_call_output", call_id: "id", output: text }, { type: "reasoning", encrypted_content: "secret" }] }],
    ["/v1/chat/completions", { messages: [{ role: "tool", tool_call_id: "id", content: text }] }],
    ["/v1/messages", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "id", content: [{ type: "text", text }, { type: "image", source: { data: "image" } }] }] }] }],
  ];
  for (const [path, fields] of bodies) {
    const context = { method: "POST", path, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ model: "any-model", instructions: "untouched", ...fields })) };
    const before = context.body.length;
    await hooks.onRequest(context);
    assert.ok(context.body.length < before);
    assert.equal(JSON.parse(context.body).instructions, "untouched");
    assert.match(context.body.toString(), /80 matches/);
    assert.match(context.body.toString(), /"id"/);
    if (path.endsWith("/messages")) assert.match(context.body.toString(), /"data":"image"/);
    if (path.endsWith("/responses")) assert.match(context.body.toString(), /"encrypted_content":"secret"/);
  }
});

for (const preset of ["rtk-pxpipe", "rtk-headroom-pxpipe"]) {
test(`${preset} preserves stage order over HTTP and WS; models gate only pxpipe`, { timeout: 20000 }, async t => {
  try { await exec("rtk", ["--version"], { windowsHide: true }); }
  catch (error) { if (error.code === "ENOENT") return t.skip("rtk is not installed"); throw error; }
  const body = aiBody();
  body.input.push({ type: "function_call", name: "grep", call_id: "id", arguments: "{}" }, {
    type: "function_call_output", call_id: "id",
    output: Array.from({ length: 80 }, (_, i) => `src/example.js:${i + 1}: repeated match value`).join("\n") + "\n",
  });
  const config = normalizeProxyOptions({ upstream: "http://localhost:10100", preset: "rtk", rtkFilter: "grep" });
  const rtk = await createPresetHooks(config);
  const context = { method: "POST", path: "/v1/responses", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
  await rtk.onRequest(context);
  assert.ok(context.body.length < Buffer.byteLength(JSON.stringify(body)));
  const afterRtk = JSON.parse(context.body);
  let headroomUrl, headroomCalls = 0;
  const withHeadroom = preset === "rtk-headroom-pxpipe";
  const beforePxpipe = structuredClone(afterRtk);
  if (withHeadroom) {
    beforePxpipe.input[2].output = "headroom-result";
    const compressor = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks)); headroomCalls++;
      assert.equal(req.url, "/v1/compress");
      assert.equal(payload.messages[0].content, afterRtk.input[2].output, "Headroom must receive RTK output, not original text");
      assert.equal(payload.config.mode, "lossy_inline");
      res.writeHead(headroomCalls === 4 ? 503 : 200, { "content-type": "application/json" });
      // Third request tests an unchanged Headroom result + gated pxpipe: retain RTK changes.
      res.end(JSON.stringify({ messages: payload.messages.map(m => ({ ...m, content: headroomCalls === 3 ? m.content : "headroom-result" })), tokens_before: 100, tokens_after: headroomCalls === 3 ? 100 : 5 }));
    });
    headroomUrl = await listen(compressor);
    t.after(() => { compressor.closeAllConnections(); return new Promise(done => compressor.close(done)); });
  }
  const expected = await transformOpenAIResponses(Buffer.from(JSON.stringify(beforePxpipe)), { model: body.model });
  assert.equal(expected.info.compressed, true);
  const measurements = [];
  const { proxy, upstream } = await fixture(t, (req, res) => req.pipe(res), { preset, headroomUrl, models: "gpt-5.5", rtkFilter: "grep", onStats: event => measurements.push(event) });
  const result = await request(proxy.url + context.path, { method: "POST", headers: context.headers }, JSON.stringify(body));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), JSON.parse(Buffer.from(expected.body)));
  const wsServer = new WebSocketServer({ server: upstream });
  t.after(() => wsServer.close());
  wsServer.on("connection", socket => socket.on("message", data => socket.send(data, { binary: false })));
  const ws = new WebSocket(proxy.url.replace("http:", "ws:") + context.path);
  t.after(() => ws.terminate());
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify({ type: "response.create", response: body, event_id: "keep" }));
  assert.deepEqual(JSON.parse((await reply)[0]), { type: "response.create", response: JSON.parse(Buffer.from(expected.body)), event_id: "keep" });
  const excluded = await request(proxy.url + context.path, { method: "POST", headers: context.headers }, JSON.stringify({ ...body, model: "other-model" }));
  assert.equal(excluded.status, 200);
  assert.deepEqual(JSON.parse(excluded.body), { ...JSON.parse(context.body), model: "other-model" });
  assert.deepEqual(measurements[0].stages.map(s => s.name), withHeadroom ? ["rtk", "headroom", "pxpipe"] : ["rtk", "pxpipe"]);
  assert.deepEqual(measurements[1].stages.map(s => s.name), measurements[0].stages.map(s => s.name));
  assert.ok(measurements[0].stages[0].saved > 0);
  assert.ok(measurements[0].stages.at(-1).saved > 0);
  assert.equal(measurements[2].stages.at(-1).reason, "model_excluded");
  assert.equal(measurements[2].changed, true);
  if (withHeadroom) {
    assert.equal(headroomCalls, 3);
    assert.equal(measurements[2].stages[1].applied, false);
    assert.equal((await request(proxy.url + context.path, { method: "POST", headers: context.headers }, JSON.stringify(body))).status, 502);
    assert.equal(measurements[3].error, true);
    assert.deepEqual(measurements[3].stages.map(s => s.name), ["rtk"], "Stop before pxpipe on Headroom failure");
  }
});
}

test("HTTP preserves method, encoded path/query, auth, compressed bytes, cookies and redirects", { timeout: 10000 }, async t => {
  const body = gzipSync(Buffer.from('{"input":"caffè ☕"}'));
  const { proxy, url } = await fixture(t, async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/base/v1/responses?x=%2F&a=1&a=2");
    assert.equal(req.headers.authorization, "Bearer test-only");
    assert.equal(req.headers.host, new URL(url).host);
    assert.equal(req.headers["x-hop"], undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), body);
    res.writeHead(307, { location: "/elsewhere", "set-cookie": ["a=1", "b=2"], "content-encoding": "gzip", "content-length": body.length });
    res.end(body);
  }, { prefix: "/base" });
  const result = await request(proxy.url + "/v1/responses?x=%2F&a=1&a=2", {
    method: "POST", headers: { authorization: "Bearer test-only", "content-encoding": "gzip", connection: "x-hop", "x-hop": "remove" },
  }, body);
  assert.equal(result.status, 307);
  assert.equal(result.headers.location, "/elsewhere");
  assert.deepEqual(result.headers["set-cookie"], ["a=1", "b=2"]);
  assert.deepEqual(result.body, body);
});

test("SSE arrives before upstream completion and client cancellation closes upstream", { timeout: 10000 }, async t => {
  let ended = false;
  let resolveClosed;
  const closed = new Promise(resolveClose => { resolveClosed = resolveClose; });
  const { proxy } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.on("close", () => { ended = true; resolveClosed(); });
  });
  const outgoing = http.get(proxy.url + "/v1/responses");
  const [incoming] = await once(outgoing, "response");
  const [chunk] = await once(incoming, "data");
  assert.equal(chunk.toString(), "data: first\n\n");
  assert.equal(ended, false);
  incoming.destroy();
  await closed;
});

test("async JavaScript hooks modify HTTP bodies, streaming chunks and WebSocket messages", { timeout: 10000 }, async t => {
  const dir = await temp(t);
  const interceptor = join(dir, "hooks.mjs");
  await writeFile(interceptor, `
    export async function onRequest(ctx) {
      if (ctx.path === '/fail') throw new Error('test interceptor failure');
      ctx.body = Buffer.from(ctx.body.toString().replace('before', 'after'));
      ctx.headers['x-intercepted'] = 'yes';
    }
    export function onResponse(ctx) { ctx.headers['x-response-hook'] = 'yes'; }
    export async function onResponseChunk(ctx) {
      ctx.body = ctx.request.path === '/bad-chunk' ? {} : Buffer.from(ctx.body.toString().toUpperCase());
    }
    export async function onWebSocketMessage(ctx) {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (!ctx.isBinary) ctx.body = ctx.body.toString() + ':' + ctx.direction;
    }
  `);
  const { upstream, proxy } = await fixture(t, async (req, res) => {
    assert.equal(req.headers["x-intercepted"], "yes");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(Number(req.headers["content-length"]), body.length);
    res.writeHead(201, { "content-length": body.length });
    res.end(body);
  }, { interceptor });
  const wsServer = new WebSocketServer({ server: upstream });
  t.after(() => wsServer.close());
  wsServer.on("connection", ws => ws.on("message", (data, binary) => ws.send(data, { binary })));
  const response = await request(proxy.url + "/v1/responses", { method: "POST" }, "before");
  assert.equal(response.status, 201);
  assert.equal(response.headers["x-response-hook"], "yes");
  assert.equal(response.body.toString(), "AFTER");
  assert.equal((await request(proxy.url + "/fail")).status, 502);
  await assert.rejects(request(proxy.url + "/bad-chunk", { method: "POST" }, "bad chunk"));
  assert.equal((await request(proxy.url, { method: "POST" }, "still alive")).status, 201);
  const ws = new WebSocket(proxy.url.replace("http:", "ws:") + "/v1/responses");
  t.after(() => ws.terminate());
  await once(ws, "open");
  const messages = [];
  const done = new Promise(resolveDone => ws.on("message", data => { messages.push(data.toString()); if (messages.length === 3) resolveDone(); }));
  for (const text of ["one", "two", "three"]) ws.send(text);
  await done;
  assert.deepEqual(messages, ["one:request:response", "two:request:response", "three:request:response"]);
  const binaryMessage = once(ws, "message");
  ws.send(Buffer.from([0, 255, 17]));
  const [binary, isBinary] = await binaryMessage;
  assert.equal(isBinary, true);
  assert.deepEqual(binary, Buffer.from([0, 255, 17]));
});

test("WebSocket preserves handshake metadata, text/binary, ping/pong and close code", { timeout: 10000 }, async t => {
  const { upstream, proxy } = await fixture(t, (_req, res) => res.end(), { prefix: "/base" });
  const wsServer = new WebSocketServer({ server: upstream, handleProtocols: protocols => [...protocols].at(-1) });
  t.after(() => wsServer.close());
  wsServer.on("headers", headers => headers.push("x-upstream-id: preserved"));
  wsServer.on("connection", (ws, req) => {
    assert.equal(req.url, "/base/v1/responses?x=%2F");
    assert.equal(req.headers.authorization, "Bearer test-only");
    ws.on("message", (data, isBinary) => {
      if (data.toString() === "close") ws.close(4001, "finished");
      else ws.send(data, { binary: isBinary });
    });
    ws.send("greeting");
  });
  const ws = new WebSocket(proxy.url.replace("http:", "ws:") + "/v1/responses?x=%2F", ["first", "second"], { headers: { authorization: "Bearer test-only" } });
  t.after(() => ws.terminate());
  const greeting = once(ws, "message");
  const [handshake] = await once(ws, "upgrade");
  assert.equal(handshake.headers["x-upstream-id"], "preserved");
  assert.equal((await greeting)[0].toString(), "greeting");
  assert.equal(ws.protocol, "second");
  const pong = once(ws, "pong");
  ws.ping("hello");
  assert.equal((await pong)[0].toString(), "hello");
  const binary = once(ws, "message");
  ws.send(Buffer.from([1, 0, 255]));
  assert.deepEqual((await binary)[0], Buffer.from([1, 0, 255]));
  const closed = once(ws, "close");
  ws.send("close");
  const [code, reason] = await closed;
  assert.equal(code, 4001);
  assert.equal(reason.toString(), "finished");
});

test("whole response hook buffers JSON, preserves HEAD metadata, and leaves SSE streaming", { timeout: 10000 }, async t => {
  const dir = await temp(t);
  const interceptor = join(dir, "response.mjs");
  await writeFile(interceptor, `
    export function onResponseBody(ctx) {
      const json = JSON.parse(ctx.body.toString());
      json.output = 'modified';
      ctx.body = JSON.stringify(json);
      ctx.headers['x-body-hook'] = 'yes';
    }
  `);
  const { proxy } = await fixture(t, (req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: streaming\n\n");
    } else {
      const body = '{"output":"original"}';
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
    }
  }, { interceptor });
  const response = await request(proxy.url);
  assert.equal(response.body.toString(), '{"output":"modified"}');
  assert.equal(response.headers["x-body-hook"], "yes");
  assert.equal(Number(response.headers["content-length"]), response.body.length);
  const head = await request(proxy.url, { method: "HEAD" });
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["x-body-hook"], undefined);
  assert.equal(Number(head.headers["content-length"]), 21);
  const outgoing = http.get(proxy.url + "/stream");
  const [incoming] = await once(outgoing, "response");
  assert.equal((await once(incoming, "data"))[0].toString(), "data: streaming\n\n");
  incoming.destroy();
});

test("upstream WebSocket rejection is forwarded as HTTP, and unavailable upstream returns 502", { timeout: 10000 }, async t => {
  const { upstream, proxy } = await fixture(t, (_req, res) => { res.writeHead(401, { "retry-after": "2" }); res.end("denied"); });
  const ws = new WebSocket(proxy.url.replace("http:", "ws:"));
  ws.on("error", () => {});
  t.after(() => ws.terminate());
  const [, incoming] = await once(ws, "unexpected-response");
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  assert.equal(incoming.statusCode, 401);
  assert.equal(incoming.headers["retry-after"], "2");
  assert.equal(Buffer.concat(chunks).toString(), "denied");
  await new Promise(resolveClose => upstream.close(resolveClose));
  assert.equal((await request(proxy.url)).status, 502);
});

test("buffer limit returns 413, and invalid interceptor fails before listening", { timeout: 10000 }, async t => {
  const dir = await temp(t);
  const interceptor = join(dir, "hooks.mjs");
  await writeFile(interceptor, "export function onRequest() {}\n");
  const { proxy } = await fixture(t, (_req, res) => res.end("ok"), { interceptor, maxBodyBytes: 4 });
  assert.equal((await request(proxy.url, { method: "POST" }, "12345")).status, 413);
  assert.equal((await request(proxy.url, { method: "POST" }, "1234")).status, 200);
  await assert.rejects(startProxy({ upstream: "http://127.0.0.1:10100", interceptor: join(dir, "missing.mjs") }));
});

test("proxy bind failure cleans up and close is idempotent", async t => {
  const {proxy} = await fixture(t, (_req, res) => res.end("ok"), {preset: "pxpipe", models: "gpt-6-astra"});
  await assert.rejects(startProxy({upstream: "http://127.0.0.1:1", listen: proxy.url, preset: "pxpipe"}), {code: "EADDRINUSE"});
  await Promise.all([proxy.close(), proxy.close()]);
});

test("CLI backgrounds, reports readiness, saves options, restarts and stops only its proxy", { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "aih proxy-cli-"));
  const home = join(dir, ".aih");
  const executable = process.env.AIH_TEST_BINARY || process.execPath;
  const entry = process.env.AIH_TEST_BINARY ? [] : [resolve("bin/cli.js")];
  const codexHome = join(dir, ".codex");
  const configPath = join(codexHome, "config.toml");
  const cli = (...args) => exec(executable, [...entry, ...args], {
    env: { ...process.env, AIH_HOME: home, CODEX_HOME: codexHome, AIH_CODEX_AUTOCONFIG: "1" }, timeout: 20000, windowsHide: true,
  });
  const interceptor = join(dir, "cli hooks.mjs");
  await writeFile(interceptor, "export function onWebSocketMessage(ctx) { if (ctx.direction === 'request') ctx.body = ctx.body.toString() + '-hook'; }\n");
  const { url, upstream, proxy: occupied } = await fixture(t, (req, res) => {
    if (req.url === "/v1/responses") req.pipe(res);
    else res.end("alive");
  });
  const wsServer = new WebSocketServer({ server: upstream });
  t.after(() => wsServer.close());
  wsServer.on("connection", ws => ws.on("message", (body, binary) => ws.send(body, { binary })));
  t.after(async () => {
    try { await cli("stop", "proxy"); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  await cli("config", "pxpipe-models=gpt-5.5*");
  const started = JSON.parse((await cli("start", "proxy", url, "--listen", "http://127.0.0.1:0", "--interceptor", interceptor, "--preset", "pxpipe", "--json")).stdout);
  assert.equal(started.success, true);
  assert.equal(started.codexConfig.status, "updated");
  assert.match(await readFile(configPath, "utf8"), new RegExp(`openai_base_url = "${started.url}/v1"`));
  assert.match(await readFile(configPath, "utf8"), new RegExp(`experimental_realtime_ws_base_url = "${started.url}/v1"`));
  assert.equal(JSON.parse((await cli("stats", "proxy", "--json")).stdout), null);
  assert.equal((await request(started.url)).body.toString(), "alive");
  const wireBody = zlib.zstdCompressSync ? zlib.zstdCompressSync(Buffer.from(JSON.stringify(aiBody()))) : JSON.stringify(aiBody());
  const transformed = await request(started.url + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", ...(zlib.zstdCompressSync ? { "content-encoding": "zstd" } : {}) } }, wireBody);
  assert.equal(transformed.status, 200);
  assert.match(transformed.body.toString(), /data:image\/png;base64/);
  const stats = JSON.parse((await cli("stats", "proxy", "--json")).stdout);
  assert.equal(stats.requests, 1);
  assert.ok(stats.estimatedSavedTokens > 0);
  assert.match((await cli("stats", "proxy")).stdout, /risparmio stimato/);
  const ws = new WebSocket(started.url.replace("http:", "ws:") + "/v1/responses");
  t.after(() => ws.terminate());
  await once(ws, "open");
  const echoed = once(ws, "message");
  ws.send("from-cli");
  assert.equal((await echoed)[0].toString(), "from-cli-hook");
  ws.close();
  await once(ws, "close");
  assert.equal(JSON.parse((await cli("start", "proxy", "--json")).stdout).alreadyRunning, true);
  const [status] = JSON.parse((await cli("status", "proxy", "--json")).stdout);
  assert.equal(status.pid, started.pid);
  assert.equal(status.status, "running");
  assert.equal(status.dashboardUrl, null);
  assert.equal(status.repositoryUrl, "https://github.com/drakonkat/ai-helper");
  assert.match((await cli("status", "proxy")).stdout, /REPO[\s\S]*github.com\/drakonkat\/ai-helper/);
  assert.match((await cli("open", "proxy")).stdout, /No dashboard URLs/);
  const statuses = JSON.parse((await cli("status", "--ui", "--json")).stdout);
  assert.equal(statuses.length, 5);
  assert.equal(statuses.find(service => service.id === "proxy").pid, started.pid);
  assert.match((await cli("logs", "proxy")).stdout, /Listening on/);
  const restarted = JSON.parse((await cli("restart", "proxy", "--json")).stdout);
  assert.notEqual(restarted.pid, started.pid);
  assert.ok((await readFile(configPath, "utf8")).includes(`openai_base_url = "${restarted.url}/v1"`));
  assert.equal((await request(restarted.url)).body.toString(), "alive");
  assert.equal(JSON.parse((await cli("stats", "proxy", "--json")).stdout).estimatedSavedTokens, stats.estimatedSavedTokens);
  await assert.rejects(cli("restart", "proxy", "file:///invalid"));
  assert.equal((await request(restarted.url)).status, 200);
  await cli("stop", "proxy");
  const state = JSON.parse(await readFile(join(home, "state.json"), "utf8"));
  assert.equal(state.services.proxy.status, "stopped");
  assert.equal(state.services.proxy.proxyOptions.upstream, url + "/");
  assert.equal(state.services.proxy.proxyOptions.preset, "pxpipe");
  assert.equal(state.services.proxy.proxyOptions.models, "gpt-5.5*");
  const stoppedConfig = await readFile(configPath, "utf8");
  await assert.rejects(cli("start", "proxy", "--listen", occupied.url), /EADDRINUSE/);
  assert.equal(await readFile(configPath, "utf8"), stoppedConfig);
  assert.equal(JSON.parse(await readFile(join(home, "state.json"), "utf8")).services.proxy.status, "stopped");
  assert.equal((await request(url)).status, 200);
});
