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
