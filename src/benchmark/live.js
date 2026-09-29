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

async function readResponsesStream(response, maxBytes, start) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const finalizedItems = new Map(), finalizedIds = new Map();
  let size = 0, buffer = "", scanOffset = 0, event = "", data = [], firstOutputMs = null;
  function finalizedItem(value) {
    const { item, output_index: index } = value;
    if (!Number.isSafeInteger(index) || index < 0 || !item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.id !== "string" || !item.id || typeof item.type !== "string" || !item.type || item.status === "in_progress") {
      throw new Error("Provider SSE contained an invalid finalized output item");
    }
    if ((finalizedIds.has(item.id) && finalizedIds.get(item.id) !== index) ||
      (finalizedItems.has(index) && JSON.stringify(finalizedItems.get(index)) !== JSON.stringify(item))) {
      throw new Error("Provider SSE contained conflicting finalized output items");
    }
    finalizedItems.set(index, item); finalizedIds.set(item.id, index);
  }
  function mergedOutput(terminal) {
    const items = new Map(finalizedItems), terminalIds = new Set();
    for (const [position, item] of (terminal.output || []).entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string") throw new Error("Provider SSE contained an invalid terminal response");
      const index = finalizedIds.get(item.id) ?? position, previous = items.get(index);
      if ((item.id && terminalIds.has(item.id)) || (previous && (previous.type !== item.type ||
        (item.id && previous.id && item.id !== previous.id)))) throw new Error("Provider SSE contained an invalid terminal response");
      if (item.id) terminalIds.add(item.id);
      // The terminal item wins over its earlier finalized event, but absent
      // items retain their finalized content. Never reconstruct from deltas.
      items.set(index, item);
    }
    const output = [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
    const restored = output.length > (terminal.output || []).length;
    const merged = { ...terminal, output };
    if (restored && merged.output_text === "") delete merged.output_text;
    return { merged, restored };
  }
  function line(text) {
    if (text.startsWith(":")) return null;
    if (text) {
      const colon = text.indexOf(":");
      const field = colon < 0 ? text : text.slice(0, colon);
      const content = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = content;
      else if (field === "data") data.push(content);
      return null;
    }
    const name = event, payload = data.join("\n");
    event = ""; data = [];
    if (!payload) return null;
    if (payload === "[DONE]") throw new Error("Provider SSE ended without a terminal response");
    let value;
    try { value = JSON.parse(payload); }
    catch { throw new Error("Provider SSE contained invalid event data"); }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      (name && value.type && name !== value.type)) throw new Error("Provider SSE contained invalid event data");
    const type = value.type || name;
    if (type === "response.output_text.delta" && typeof value.delta === "string" && value.delta.length && firstOutputMs === null) firstOutputMs = performance.now() - start;
    if (type === "response.output_item.done") { finalizedItem(value); return null; }
    if (type === "error") throw new Error("Provider SSE reported an error");
    if (!["response.completed", "response.incomplete", "response.failed"].includes(type)) return null;
    const terminal = value.response, status = type.slice("response.".length);
    if (!terminal || typeof terminal !== "object" || Array.isArray(terminal) || terminal.status !== status ||
      (terminal.output !== undefined && !Array.isArray(terminal.output)) ||
      (status !== "failed" && !Array.isArray(terminal.output) && typeof terminal.output_text !== "string" && !finalizedItems.size)) {
      throw new Error("Provider SSE contained an invalid terminal response");
    }
    let parsed, restored;
    try {
      const result = mergedOutput(terminal); restored = result.restored;
      parsed = parseProviderResponse(result.merged, "responses");
      if (result.merged.output.some(item => item.status === "incomplete")) parsed.complete = false;
    }
    catch { throw new Error("Provider SSE contained an invalid terminal response"); }
    const missingFinalText = firstOutputMs !== null && !parsed.text && !parsed.additionalToolCalls;
    return { ...parsed, firstOutputMs, outputFromFinalizedItems: restored,
      ...(missingFinalText ? { complete: false, error: "Provider SSE ended without finalized output text" } : {}),
      ...(status === "failed" ? { error: "Provider response failed" } : {}) };
  }
  function consume(final = false) {
    let offset = 0, index = scanOffset;
    for (; index < buffer.length; index++) {
      if (buffer[index] !== "\n" && buffer[index] !== "\r") continue;
      // A CR and LF can arrive in separate network chunks.
      if (buffer[index] === "\r" && index === buffer.length - 1 && !final) break;
      const result = line(buffer.slice(offset, index));
      if (buffer[index] === "\r" && buffer[index + 1] === "\n") index++;
      offset = index + 1;
      if (result) return result;
    }
    buffer = buffer.slice(offset);
    scanOffset = index - offset;
    return null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const terminal = consume(true);
        if (terminal) return terminal;
        throw new Error("Provider SSE ended without a terminal response");
      }
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Response exceeds benchmark maxBodyBytes");
      buffer += decoder.decode(value, { stream: true });
      const terminal = consume();
      if (terminal) return terminal;
    }
  } finally {
    // Providers may keep SSE sockets open after a terminal event. Do not wait
    // for EOF, leak a reader, or accept subsequent contradictory/delta events.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
  if (response.ok && fixture.format === "responses" && /^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get("content-type") || "")) {
    try {
      const parsed = await readResponsesStream(response, options.maxBodyBytes, start);
      return { status: response.status, durationMs: performance.now() - start, ...parsed };
    } catch (error) {
      // Only locally constructed diagnostics survive; never JSON parser errors,
      // provider event bodies, echoed prompts or credentials.
      const safe = ["Provider SSE ended without a terminal response", "Provider SSE contained invalid event data",
        "Provider SSE reported an error", "Provider SSE contained an invalid terminal response", "Response exceeds benchmark maxBodyBytes",
        "Provider SSE contained an invalid finalized output item", "Provider SSE contained conflicting finalized output items"];
      return { status: response.status, durationMs: performance.now() - start, complete: false,
        error: safe.includes(error.message) ? error.message : "Provider SSE could not be read" };
    }
  }
  const raw = await readLimited(response, options.maxBodyBytes);
  const durationMs = performance.now() - start;
  // Never put provider error bodies (which can echo credentials/prompts) in reports.
  if (!response.ok) return { status: response.status, durationMs, error: `Provider HTTP ${response.status}` };
  let value;
  try { value = JSON.parse(raw); } catch { return { status: response.status, durationMs, error: "Provider did not return JSON or a supported Responses SSE stream" }; }
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
