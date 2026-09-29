import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { openAIVisionTokens } from "pxpipe-proxy";
import { measureRequest } from "../src/benchmark/measurement.js";

const test = typeof Bun === "undefined" ? nodeTest : nodeTest.skip;
const tokenize = text => countTokens(text, { disallowedSpecial: new Set() });

function png(width = 512, height = 512, extraBytes = 0) {
  const bytes = Buffer.alloc(33 + extraBytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

const imageRequest = (model, url = png(), detail = "original") => ({
  model, input: [{ role: "user", content: [{ type: "input_image", image_url: url, detail }] }],
});

test("canonical JSON gives deterministic common text/token measurements without mutation", async () => {
  const input = { model: "gpt-5", input: "Find the error" };
  const original = structuredClone(input);
  const expected = tokenize('{"input":"Find the error","model":"gpt-5"}');
  const result = await measureRequest(input);
  assert.equal(result.textTokens, expected);
  assert.equal(result.totalTokens, expected);
  assert.equal(result.knownTokens, expected);
  assert.equal(result.imageTokens, 0);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(input)));
  assert.equal(result.toolTextTokens, 0);
  assert.deepEqual(await measureRequest(JSON.stringify(input)), result);
  assert.deepEqual(await measureRequest(Buffer.from(JSON.stringify(input))), result);
  assert.deepEqual(await measureRequest({ input: input.input, model: input.model }), result);
  assert.deepEqual(input, original);
  assert.ok(result.warnings.some(warning => /not provider billing/.test(warning)));
});

test("tool text totals cover Responses, Chat and Anthropic without counting images", async () => {
  const text = "Error E42 at src/file.js:19 <|endoftext|>";
  const inputs = [
    { input: [{ type: "function_call_output", output: text }] },
    { input: [{ type: "function_call_output", output: [{ type: "input_text", text }, { type: "input_image", image_url: png() }] }] },
    { messages: [{ role: "tool", content: text }] },
    { messages: [{ role: "tool", content: [{ type: "text", text }] }] },
    { messages: [{ role: "user", content: [{ type: "tool_result", content: text }] }] },
    { messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "text", text }] }] }] },
  ];
  for (const input of inputs) assert.equal((await measureRequest(input)).toolTextTokens, tokenize(text));
});

test("PNG explicit-detail cost uses pxpipe model profile, not base64 text length", async () => {
  const result = await measureRequest(imageRequest("gpt-5.6-sol"));
  const largerPayload = await measureRequest(imageRequest("gpt-5.6-sol", png(512, 512, 30000)));
  assert.equal(result.images, 1);
  assert.equal(result.unknownImages, 0);
  assert.equal(result.imageTokens, openAIVisionTokens("gpt-5.6-sol", 512, 512));
  assert.equal(result.totalTokens, result.textTokens + result.imageTokens);
  assert.equal(largerPayload.textTokens, result.textTokens);
  assert.equal(largerPayload.totalTokens, result.totalTokens);
  assert.ok(largerPayload.bytes > result.bytes);
  assert.match(result.warnings.join(" "), /approximation/);
});

test("Chat image_url and Anthropic images are recognized and never text-tokenized", async () => {
  const chat = await measureRequest({ model: "gpt-4o", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: png(), detail: "high" } }] }] });
  assert.equal(chat.images, 1);
  assert.equal(chat.imageTokens, openAIVisionTokens("gpt-4o", 512, 512));
  const anthropic = await measureRequest({ model: "claude-opus-5", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png().split(",")[1] } }] }] });
  assert.equal(anthropic.images, 1);
  assert.equal(anthropic.unknownImages, 1);
  assert.equal(anthropic.totalTokens, null);
  assert.ok(anthropic.textTokens > 0);
});

test("unsupported model, remote image, invalid PNG, detail and unmodeled resize stay unknown", async () => {
  const cases = [
    imageRequest("gemini-3.1-pro"), imageRequest("claude-opus-5"), imageRequest("gpt-99"), imageRequest("gpt-4o-mini"),
    imageRequest("gpt-5", "https://example.invalid/image.png"), imageRequest("gpt-5", "data:image/jpeg;base64,aGVsbG8="),
    imageRequest("gpt-5", "data:image/png;base64,YmFk"), imageRequest("gpt-5", png(0, 512)),
    imageRequest("gpt-5", png(0xffffffff, 512)), imageRequest("gpt-5", png(), "auto"), imageRequest("gpt-5", png(), "low"),
    imageRequest("gpt-4.1-mini", png(2000, 2000), "high"),
  ];
  delete cases[0].input[0].content[0].detail;
  for (const input of cases) {
    const result = await measureRequest(input);
    assert.equal(result.totalTokens, null, JSON.stringify(input).slice(0, 100));
    assert.equal(result.unknownImages, 1);
    assert.ok(result.knownTokens > 0);
  }
});

test("mixed known and unknown images preserve the known subtotal without asserting a total", async () => {
  const input = imageRequest("gpt-5.5");
  input.input[0].content.push({ type: "input_image", image_url: "https://example.invalid/unknown.png", detail: "original" });
  const result = await measureRequest(input);
  assert.equal(result.images, 2);
  assert.equal(result.unknownImages, 1);
  assert.equal(result.imageTokens, openAIVisionTokens("gpt-5.5", 512, 512));
  assert.equal(result.knownTokens, result.textTokens + result.imageTokens);
  assert.equal(result.totalTokens, null);
});

test("encrypted and other binary/media payloads never produce false zero-cost totals", async () => {
  const variants = [
    payload => ({ input: [{ type: "reasoning", encrypted_content: payload }] }),
    payload => ({ input: [{ type: "input_file", file_data: payload }] }),
    payload => ({ messages: [{ content: [{ type: "input_audio", input_audio: { data: payload, format: "wav" } }] }] }),
    payload => ({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: payload } }] }] }),
    payload => ({ image_data: payload }),
    payload => ({ input: `data:application/octet-stream;base64,${payload}` }),
  ];
  for (const create of variants) {
    const small = await measureRequest(create("AAAA"));
    const large = await measureRequest(create("AAAA".repeat(20000)));
    assert.equal(small.textTokens, large.textTokens);
    assert.equal(small.totalTokens, null);
    assert.equal(large.totalTokens, null);
    assert.ok(small.knownTokens > 0);
  }
});

test("request token measurements permit negative savings rather than clamping", async () => {
  const before = await measureRequest({ model: "gpt-5", input: "tiny" });
  const after = await measureRequest({ model: "gpt-5", input: "more verbose output ".repeat(100) });
  assert.ok(before.totalTokens - after.totalTokens < 0);
});

test("non-request or invalid JSON fails explicitly", async () => {
  for (const input of [null, [], "not-json", "null", 42]) await assert.rejects(measureRequest(input));
});
