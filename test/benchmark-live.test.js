import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { callProvider, parseProviderResponse, readLimited, validateUpstream } from "../src/benchmark/live.js";

const test = typeof Bun === "undefined" ? nodeTest : nodeTest.skip;
async function serverFor(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const options = upstream => ({ upstream, apiKey: "test-only-private-key", timeoutMs: 5000, maxBodyBytes: 100000 });
const responsesFixture = { format: "responses", path: "/v1/responses" };
const sseEvent = (type, response) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const doneItem = (output_index, item) => `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`;
const messageItem = (id, text) => ({ id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] });

test("Responses SSE reconstructs observed Astra finalized message with empty terminal output and terminal-only usage", async t => {
  const item = messageItem("msg_astra", "2.17.4-rc.3");
  const terminal = { status: "completed", output: [], usage: { input_tokens: 155, output_tokens: 13 } };
  t.mock.method(globalThis, "fetch", async () => new Response(
    'data: {"type":"response.output_text.delta","delta":"2.17.4-rc.3","usage":{"input_tokens":9999}}\n\n' +
    doneItem(0, item) + doneItem(0, item) + sseEvent("response.completed", terminal),
    { headers: { "content-type": "text/event-stream" } }));
  const result = await callProvider({ stream: true }, responsesFixture, options("http://localhost"));
  assert.equal(result.error, undefined);
  assert.equal(result.complete, true);
  assert.equal(result.text, "2.17.4-rc.3");
  assert.equal(result.outputFromFinalizedItems, true);
  assert.equal(result.usage.inputTokens, 155);
  assert.equal(result.usage.outputTokens, 13);
});

test("Responses SSE merges finalized items in output order and prefers terminal matching IDs without duplicates", async t => {
  const first = messageItem("first", "old first"), second = messageItem("second", "second answer");
  t.mock.method(globalThis, "fetch", async () => new Response(
    doneItem(1, second) + doneItem(0, first) +
    sseEvent("response.completed", { status: "completed", output: [messageItem("first", "authoritative first")] }),
    { headers: { "content-type": "text/event-stream" } }));
  const result = await callProvider({ stream: true }, responsesFixture, options("http://localhost"));
  assert.equal(result.error, undefined);
  assert.equal(result.text, "authoritative first\nsecond answer");
  assert.equal(result.complete, true);
  assert.equal(result.usage.inputTokens, null);
});

test("Responses SSE retains finalized function and custom tool calls even when terminal items are missing", async t => {
  const tool = { id: "function1", type: "function_call", name: "must_not_execute", arguments: "{}" };
  const custom = { id: "custom1", type: "custom_tool_call", name: "must_not_execute", input: "private prompt" };
  const item = messageItem("answer", "requested tools");
  t.mock.method(globalThis, "fetch", async () => new Response(doneItem(0, tool) + doneItem(1, custom) + doneItem(2, item) +
    sseEvent("response.completed", { status: "completed", output: [item] }),
    { headers: { "content-type": "text/event-stream" } }));
  const result = await callProvider({ stream: true }, responsesFixture, options("http://localhost"));
  assert.equal(result.error, undefined);
  assert.equal(result.text, "requested tools");
  assert.equal(result.additionalToolCalls, 2);
  assert.equal(result.complete, false);
  assert.ok(!JSON.stringify(result).includes("private prompt"));
});

test("Responses SSE empty terminal after text deltas alone is a parser error, not a scored empty answer", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    'data: {"type":"response.output_text.delta","delta":"private prompt"}\n\n' +
    sseEvent("response.completed", { status: "completed", output: [], usage: { input_tokens: 8, output_tokens: 2 } }),
    { headers: { "content-type": "text/event-stream" } }));
  const result = await callProvider({ stream: true }, responsesFixture, options("http://localhost"));
  assert.equal(result.complete, false);
  assert.match(result.error, /without finalized output text/);
  assert.equal(result.usage.totalTokens, 10);
  assert.ok(!JSON.stringify(result).includes("private prompt"));
});

test("Responses SSE rejects malformed or conflicting finalized identities instead of inventing output", async t => {
  let wire;
  t.mock.method(globalThis, "fetch", async () => new Response(wire + sseEvent("response.completed", { status: "completed", output: [] }),
    { headers: { "content-type": "text/event-stream" } }));
  const item = messageItem("same", "private prompt");
  for (wire of [doneItem(-1, item), doneItem(0, { type: "message" }), doneItem(0, item) + doneItem(1, item),
    doneItem(0, item) + doneItem(0, messageItem("different", "test-only-private-key"))]) {
    const result = await callProvider({ stream: true }, responsesFixture, options("http://localhost"));
    assert.equal(result.complete, false);
    assert.match(result.error, /finalized output/);
    assert.ok(!JSON.stringify(result).includes("private prompt"));
    assert.ok(!JSON.stringify(result).includes("test-only-private-key"));
  }
});

test("Responses SSE handles fragmented UTF-8, CRLF, comments and multiline data using only terminal usage/text", async t => {
  const terminal = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "caffè ☕" }] }],
    usage: { input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 2 } } };
  const wire = ": keepalive\r\nid: ignored\r\nretry: 1000\r\n\r\n" +
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"caffè ☕ discarded delta","usage":{"input_tokens":99999}}\r\n\r\n' +
    `event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":${JSON.stringify(terminal)}}\r\n\r\n`;
  const bytes = Buffer.from(wire);
  let offset = 0, cancelled = false;
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    assert.equal(JSON.parse(request.body).stream, true);
    return new Response(new ReadableStream({
      pull(controller) { if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  });
  const result = await callProvider({ stream: true }, responsesFixture, { ...options("http://localhost"), maxBodyBytes: bytes.length });
  assert.equal(result.error, undefined);
  assert.equal(result.complete, true);
  assert.equal(result.text, "caffè ☕");
  assert.deepEqual(result.usage, parseProviderResponse(terminal, "responses").usage);
  assert.ok(Number.isFinite(result.firstOutputMs) && result.firstOutputMs >= 0 && result.firstOutputMs <= result.durationMs);
  assert.equal(cancelled, true);
});

test("Responses SSE terminates and cancels immediately without waiting for provider keepalive EOF", async t => {
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const upstream = await serverFor(t, (_request, response) => {
    response.setHeader("content-type", "text/event-stream");
    response.on("close", disconnected);
    response.write(sseEvent("response.completed", { status: "completed", output_text: "FINAL", usage: { input_tokens: 7, output_tokens: 1 } }));
    // Deliberately no end(): completion must cancel the open response stream.
  });
  const result = await callProvider({ stream: true }, responsesFixture, { ...options(upstream), timeoutMs: 1500 });
  assert.equal(result.text, "FINAL");
  assert.equal(result.complete, true);
  assert.equal(result.firstOutputMs, null);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("SSE reader did not close the provider socket")), 1000); timer.unref(); })]);
});

test("Responses SSE incomplete and failed terminals are never complete and do not expose provider errors", async t => {
  let status;
  t.mock.method(globalThis, "fetch", async () => new Response(sseEvent(`response.${status}`, {
    status, output_text: "partial answer", usage: { input_tokens: 10, output_tokens: 2 },
    error: { message: "private prompt test-only-private-key" },
  }), { headers: { "content-type": "text/event-stream" } }));
  for (status of ["incomplete", "failed"]) {
    const result = await callProvider({ stream: true }, responsesFixture, options("http://localhost"));
    assert.equal(result.complete, false);
    assert.equal(result.text, "partial answer");
    assert.equal(result.usage.totalTokens, 12);
    assert.equal(result.error, status === "failed" ? "Provider response failed" : undefined);
    assert.ok(!JSON.stringify(result).includes("private prompt"));
    assert.ok(!JSON.stringify(result).includes("test-only-private-key"));
  }
});

test("Responses SSE rejects missing, truncated, malformed and contradictory terminal events safely", async t => {
  let wire;
  t.mock.method(globalThis, "fetch", async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
  const cases = [
    ["", /without a terminal/],
    ['data: {"type":"response.output_text.delta","delta":"private prompt","usage":{"input_tokens":123}}\n\n', /without a terminal/],
    ['data: [DONE]\n\n', /without a terminal/],
    [sseEvent("response.completed", { status: "completed", output: [] }).trimEnd(), /without a terminal/],
    ['data: {"private prompt test-only-private-key"}\n\n', /invalid event/],
    ['data: null\n\n', /invalid event/],
    ['data: {"type":"error","message":"private prompt test-only-private-key"}\n\n', /reported an error/],
    ['event: response.completed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n', /invalid event/],
    [sseEvent("response.completed", { status: "incomplete", output: [] }), /invalid terminal/],
    [sseEvent("response.completed", { status: "completed" }), /invalid terminal/],
    [sseEvent("response.completed", { status: "completed", output: "private prompt" }), /invalid terminal/],
    [sseEvent("response.completed", { status: "completed", output: [null] }), /invalid terminal/],
  ];
  for (const [input, expected] of cases) {
    wire = input;
    const result = await callProvider({ stream: true }, responsesFixture, options("http://localhost"));
    assert.equal(result.complete, false);
    assert.match(result.error, expected);
    assert.equal(result.text, undefined);
    assert.equal(result.usage, undefined);
    assert.ok(!JSON.stringify(result).includes("private prompt"));
    assert.ok(!JSON.stringify(result).includes("test-only-private-key"));
  }
});

test("Responses SSE bounds total bytes including comments and cancels invalid UTF-8 streams", async t => {
  let bytes, cancelled;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  for (const [input, cap, error] of [
    [Buffer.from(": " + "x".repeat(100) + "\n\n"), 50, /maxBodyBytes/],
    [Buffer.from([0xff, 0xfe]), 100, /could not be read/],
  ]) {
    bytes = input; cancelled = false;
    const result = await callProvider({ stream: true }, responsesFixture, { ...options("http://localhost"), maxBodyBytes: cap });
    assert.equal(result.complete, false);
    assert.match(result.error, error);
    assert.equal(cancelled, true);
    assert.equal(result.usage, undefined);
  }
});

test("Responses SSE does not invent missing terminal usage from deltas", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    'data: {"type":"response.output_text.delta","delta":"untrusted","usage":{"input_tokens":999,"output_tokens":123}}\n\n' +
    sseEvent("response.completed", { status: "completed", output_text: "final" }),
    { headers: { "content-type": "text/event-stream" } }));
  const result = await callProvider({ stream: true }, responsesFixture, options("http://localhost"));
  assert.equal(result.text, "final");
  assert.equal(result.complete, true);
  assert.equal(result.usage.inputTokens, null);
  assert.equal(result.usage.outputTokens, null);
  assert.equal(result.usage.totalTokens, null);
});

test("upstream validation rejects credentials, query, fragments and non-HTTP protocols", () => {
  assert.equal(validateUpstream("https://api.example.test/v1"), "https://api.example.test/v1");
  assert.equal(validateUpstream("http://127.0.0.1:8787"), "http://127.0.0.1:8787/");
  for (const url of ["ftp://example.test", "file:///tmp/input", "https://user:secret@example.test", "https://example.test/?key=secret", "https://example.test/#secret"]) {
    assert.throws(() => validateUpstream(url), /Live upstream/);
  }
});

test("Anthropic usage includes cache read/write without counting output twice", () => {
  const parsed = parseProviderResponse({
    content: [{ type: "text", text: "First" }, { type: "thinking", thinking: "not answer text" }, { type: "text", text: "Second" }],
    stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  }, "anthropic");
  assert.equal(parsed.text, "First\nSecond");
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.usage, { inputTokens: 130, outputTokens: 7, cachedInputTokens: 100, cacheWriteInputTokens: 20, totalTokens: 137, reasoningTokens: null });
});

test("missing, negative or nonnumeric usage stays unknown; explicit zeros remain measured", () => {
  for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: "12" }, { input_tokens: null, output_tokens: Infinity }]) {
    const result = parseProviderResponse({ status: "completed", output: [], usage }, "responses");
    assert.equal(result.usage.inputTokens, null);
    assert.equal(result.usage.outputTokens, null);
    assert.equal(result.usage.totalTokens, null);
    assert.equal(result.usage.cachedInputTokens, null);
  }
  const zero = parseProviderResponse({ status: "completed", usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } }, "responses");
  assert.equal(zero.usage.totalTokens, 0);
  assert.equal(zero.usage.cachedInputTokens, 0);
  const partialCache = parseProviderResponse({ content: [], stop_reason: "end_turn", usage: { output_tokens: 2, cache_read_input_tokens: 10 } }, "anthropic");
  assert.equal(partialCache.usage.inputTokens, null);
  assert.equal(partialCache.usage.totalTokens, null);
  assert.equal(partialCache.usage.cachedInputTokens, 10);
});

test("Responses extracts answer text and cache/reasoning usage, not internal reasoning content", () => {
  const response = {
    status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "hidden" }] },
      { type: "message", content: [{ type: "output_text", text: "answer" }, { type: "refusal", refusal: "not plain output text" }] }],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 10 } },
  };
  const parsed = parseProviderResponse(response, "responses");
  assert.equal(parsed.text, "answer");
  assert.equal(parsed.complete, true);
  assert.equal(parsed.usage.inputTokens, 100);
  assert.equal(parsed.usage.totalTokens, 120);
  assert.equal(parsed.usage.cachedInputTokens, 80);
  assert.equal(parsed.usage.reasoningTokens, 10);
  assert.equal(parseProviderResponse({ ...response, output_text: "flattened answer" }, "responses").text, "flattened answer");
  assert.equal(parseProviderResponse({ ...response, status: "incomplete" }, "responses").complete, false);
});

test("Chat supports string and text-block answers and normalizes completion usage", () => {
  const create = content => ({ choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 90, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 3 } } });
  assert.equal(parseProviderResponse(create("answer"), "chat").text, "answer");
  const parsed = parseProviderResponse(create([{ type: "text", text: "a" }, { type: "image_url", image_url: "ignored" }, { type: "text", text: "b" }]), "chat");
  assert.equal(parsed.text, "a\nb");
  assert.equal(parsed.complete, true);
  assert.equal(parsed.usage.inputTokens, 90);
  assert.equal(parsed.usage.outputTokens, 10);
  assert.equal(parsed.usage.totalTokens, 100);
  assert.equal(parsed.usage.cachedInputTokens, 50);
  assert.equal(parsed.usage.reasoningTokens, 3);
  assert.equal(parseProviderResponse({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }, "chat").complete, false);
});

test("all protocols surface requested tool calls as incomplete, without executing them", () => {
  const inputs = [
    ["responses", { status: "completed", output: [{ type: "function_call", name: "must_not_execute", arguments: '{"command":"not executed"}' }] }],
    ["chat", { choices: [{ finish_reason: "stop", message: { tool_calls: [{ type: "function", function: { name: "must_not_execute", arguments: "{}" } }] } }] }],
    ["anthropic", { stop_reason: "end_turn", content: [{ type: "tool_use", name: "must_not_execute", input: {} }] }],
  ];
  for (const [format, input] of inputs) {
    const result = parseProviderResponse(input, format);
    assert.equal(result.additionalToolCalls, 1);
    assert.equal(result.complete, false);
    assert.equal(result.text, "");
  }
});

test("limited response reader bounds bytes and reconstructs UTF-8 across chunks", async () => {
  const bytes = Buffer.from("caffè ☕", "utf8");
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 5)); controller.enqueue(bytes.subarray(5)); controller.close(); } });
  assert.equal(await readLimited(new Response(body), bytes.length), "caffè ☕");
  await assert.rejects(readLimited(new Response("too large"), 2), /maxBodyBytes/);
});

test("live caller sends protocol-specific authentication and returns only measured response data", async t => {
  const requests = [];
  const upstream = await serverFor(t, (request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) });
      response.setHeader("content-type", "application/json");
      response.end(request.url === "/v1/messages" ? JSON.stringify({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } })
        : JSON.stringify({ status: "completed", output_text: "OK", usage: { input_tokens: 3, output_tokens: 1 } }));
    });
  });
  const body = { model: "test", input: "private prompt", stream: false };
  for (const fixture of [{ format: "responses", path: "/v1/responses" }, { format: "anthropic", path: "/v1/messages" }]) {
    const result = await callProvider(body, fixture, options(upstream));
    assert.equal(result.status, 200);
    assert.equal(result.text, "OK");
    assert.equal(result.complete, true);
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
    assert.ok(!JSON.stringify(result).includes("test-only-private-key"));
    assert.ok(!JSON.stringify(result).includes("private prompt"));
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.authorization, "Bearer test-only-private-key");
  assert.equal(requests[0].headers["x-api-key"], undefined);
  assert.equal(requests[1].headers["x-api-key"], "test-only-private-key");
  assert.equal(requests[1].headers.authorization, undefined);
  assert.equal(requests[1].headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(requests[0].body, body);
});

test("HTTP error bodies and non-JSON payloads cannot leak echoed prompts or credentials", async t => {
  const upstream = await serverFor(t, (request, response) => {
    response.statusCode = request.url === "/bad-json" ? 200 : 401;
    response.end("private prompt; test-only-private-key; not JSON");
  });
  const failed = await callProvider({}, { format: "responses", path: "/unauthorized" }, options(upstream));
  assert.equal(failed.error, "Provider HTTP 401");
  assert.equal(failed.status, 401);
  const nonJson = await callProvider({}, { format: "responses", path: "/bad-json" }, options(upstream));
  assert.match(nonJson.error, /did not return JSON/);
  for (const result of [failed, nonJson]) {
    assert.ok(!JSON.stringify(result).includes("test-only-private-key"));
    assert.ok(!JSON.stringify(result).includes("private prompt"));
    assert.equal(result.text, undefined);
  }
});

test("live caller never follows redirects or sends the API key to their target", async t => {
  let targetRequests = 0;
  const target = await serverFor(t, (_request, response) => { targetRequests++; response.end("unexpected"); });
  const source = await serverFor(t, (_request, response) => { response.writeHead(307, { location: `${target}/capture` }); response.end(); });
  await assert.rejects(callProvider({}, { format: "responses", path: "/redirect" }, options(source)));
  assert.equal(targetRequests, 0);
});

test("live caller respects response byte limits and external cancellation", async t => {
  const upstream = await serverFor(t, (_request, response) => response.end("x".repeat(200)));
  await assert.rejects(callProvider({}, { format: "responses", path: "/large" }, { ...options(upstream), maxBodyBytes: 10 }), /maxBodyBytes/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(callProvider({}, { format: "responses", path: "/cancelled" }, { ...options(upstream), signal: controller.signal }));
});

test("live tool requests trigger no follow-up HTTP calls and are returned for failure scoring", async t => {
  let calls = 0;
  const upstream = await serverFor(t, (_request, response) => {
    calls++;
    response.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "must_not_execute", arguments: "{}" }] }));
  });
  const result = await callProvider({}, { format: "responses", path: "/v1/responses" }, options(upstream));
  assert.equal(calls, 1);
  assert.equal(result.additionalToolCalls, 1);
  assert.equal(result.complete, false);
});
