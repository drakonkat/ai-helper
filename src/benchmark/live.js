// Live evaluation is opt-in. No tool requested by a model is ever executed.
import { performance } from "node:perf_hooks";

export function validateUpstream(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Live upstream must be HTTP(S), without credentials, query or fragment");
  }
  return url.href;
}

export async function readLimited(response, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Response exceeds benchmark maxBodyBytes");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function callProvider(body, fixture, options) {
  const headers = { "content-type": "application/json" };
  if (options.apiKey) {
    if (fixture.format === "anthropic") headers["x-api-key"] = options.apiKey;
    else headers.authorization = `Bearer ${options.apiKey}`;
  }
  if (fixture.format === "anthropic") headers["anthropic-version"] = "2023-06-01";
  const url = options.upstream.replace(/\/$/, "") + fixture.path;
  const start = performance.now();
  const response = await fetch(url, {
    method: "POST", headers, body: JSON.stringify(body), redirect: "error",
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs),
  });
  const raw = await readLimited(response, options.maxBodyBytes);
  const durationMs = performance.now() - start;
  // Never put provider error bodies (which can echo credentials/prompts) in reports.
  if (!response.ok) return { status: response.status, durationMs, error: `Provider HTTP ${response.status}` };
  let value;
  try { value = JSON.parse(raw); } catch { return { status: response.status, durationMs, error: "Provider did not return JSON (streaming is not supported)" }; }
  try { return { status: response.status, durationMs, ...parseProviderResponse(value, fixture.format) }; }
  catch { return { status: response.status, durationMs, error: "Provider returned an invalid response shape" }; }
}

const number = n => Number.isFinite(n) && n >= 0 ? n : null;

export function parseProviderResponse(value, format) {
  const u = value?.usage || {};
  let text = "", additionalToolCalls = 0, complete = true;
  let inputTokens = number(u.input_tokens ?? u.prompt_tokens);
  const outputTokens = number(u.output_tokens ?? u.completion_tokens);
  const cachedInputTokens = number(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens);
  const cacheWriteInputTokens = number(u.cache_creation_input_tokens);
  if (format === "anthropic") {
    text = (value.content || []).filter(x => x.type === "text").map(x => x.text).join("\n");
    additionalToolCalls = (value.content || []).filter(x => x.type === "tool_use").length;
    complete = value.stop_reason === "end_turn" || value.stop_reason === "stop_sequence";
    // Anthropic input_tokens excludes cache reads/writes; normalize to all input.
    if (inputTokens !== null) inputTokens += (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
  } else if (format === "chat") {
    const choice = value.choices?.[0];
    const content = choice?.message?.content;
    text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(x => x.type === "text").map(x => x.text).join("\n") : "";
    additionalToolCalls = choice?.message?.tool_calls?.length || 0;
    complete = choice?.finish_reason === "stop";
  } else {
    text = typeof value.output_text === "string" ? value.output_text : (value.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text).join("\n");
    additionalToolCalls = (value.output || []).filter(x => /(?:^|_)call$/.test(x.type || "")).length;
    complete = value.status === "completed";
  }
  return {
    text, additionalToolCalls, complete: complete && additionalToolCalls === 0,
    usage: { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens,
      totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
      reasoningTokens: number(u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens) },
  };
}
