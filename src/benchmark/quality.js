// Deterministic preservation checks are a lower bound on quality, not a semantic
// judge. In particular, rendering text into an image does not prove it is readable.
import { isDeepStrictEqual } from "node:util";
import { compareRequestImages } from "../request-images.js";
const IMAGE_TYPES = new Set(["image", "input_image", "image_url"]);

function contentTexts(value) {
  if (typeof value === "string") return [withoutDataUrls(value)];
  if (!Array.isArray(value)) return [];
  return value.flatMap(part => {
    if (!part || typeof part !== "object" || IMAGE_TYPES.has(part.type)) return [];
    if (["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string") return [withoutDataUrls(part.text)];
    if (part.type === "tool_result") return contentTexts(part.content);
    return [];
  });
}

function withoutDataUrls(text) {
  return text.replace(/data:[^\s,]*;base64,[A-Za-z0-9+/=_-]+/g, "");
}

function toolTexts(body) {
  const result = [];
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item?.type === "function_call_output") result.push(...contentTexts(item.output));
  }
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role === "tool") result.push(...contentTexts(message.content));
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === "tool_result") result.push(...contentTexts(part.content));
    }
  }
  return result;
}

export function requestTexts(body) {
  if (!body || typeof body !== "object") return [];
  const result = [...contentTexts(body.instructions), ...contentTexts(body.system)];
  if (typeof body.input === "string") result.push(withoutDataUrls(body.input));
  for (const item of Array.isArray(body.input) ? body.input : []) {
    result.push(...contentTexts(item?.content));
    if (item?.type === "function_call_output") result.push(...contentTexts(item.output));
    if (item?.type === "function_call" && typeof item.arguments === "string") result.push(withoutDataUrls(item.arguments));
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) result.push(...contentTexts(message?.content));
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const definition = tool?.function || tool;
    if (typeof definition?.description === "string") result.push(withoutDataUrls(definition.description));
  }
  return result;
}

function toolStructure(body) {
  const calls = new Map();
  const outputs = new Set();
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item?.type === "function_call" && typeof item.call_id === "string") calls.set(item.call_id, item.name);
    if (item?.type === "function_call_output" && typeof item.call_id === "string") outputs.add(item.call_id);
  }
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.id === "string") calls.set(call.id, call.function?.name);
    }
    if (message?.role === "tool" && typeof message.tool_call_id === "string") outputs.add(message.tool_call_id);
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === "tool_use" && typeof part.id === "string") calls.set(part.id, part.name);
      if (part?.type === "tool_result" && typeof part.tool_use_id === "string") outputs.add(part.tool_use_id);
    }
  }
  return { calls, outputs };
}

function summarize(checks) {
  const passed = checks.filter(check => check.status === "pass").length;
  const failed = checks.filter(check => check.status === "fail").length;
  const unknown = checks.filter(check => check.status === "indeterminate").length;
  return { status: failed ? "fail" : unknown ? "indeterminate" : checks.length ? "pass" : "unscored", passed, failed, unknown, total: checks.length, checks };
}

function strings(value, key) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(text => typeof text !== "string" || !text.trim())) {
    throw new Error(`${key} must be an array of nonempty strings`);
  }
  return value;
}

/** Check text and native tool invariants without decoding or OCRing images. */
export function evaluatePreservation(originalBody, transformedBody, checks = {}) {
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) throw new Error("checks must be an object");
  const results = [];
  const imageIntegrity = compareRequestImages(originalBody, transformedBody);
  // Unchanged user attachments cannot be evidence that removed tool text was imaged.
  const images = imageIntegrity.addedOrChanged > 0;
  for (const [scope, extract] of [["toolIncludes", toolTexts], ["requestIncludes", requestTexts]]) {
    const original = extract(originalBody);
    const transformed = extract(transformedBody);
    strings(checks[scope], `checks.${scope}`).forEach((expected, index) => {
      const sourcePresent = original.some(text => text.includes(expected));
      const present = transformed.some(text => text.includes(expected));
      results.push({ id: `${scope}:${index}`, kind: scope, expected,
        status: !sourcePresent ? "indeterminate" : present ? "pass" : images ? "indeterminate" : "fail",
        reason: !sourcePresent ? "not_in_original" : present ? "preserved_text" : images ? "image_content_requires_live_evaluation" : "missing_text" });
    });
  }
  if (typeof originalBody?.model === "string") {
    const preserved = originalBody.model === transformedBody?.model;
    results.push({ id: "structure:model", kind: "structure", status: preserved ? "pass" : "fail", reason: preserved ? "model_preserved" : "model_changed_or_missing" });
  }
  const original = toolStructure(originalBody);
  const transformed = toolStructure(transformedBody);
  for (const [id, name] of original.calls) {
    // Only require pairs which were present in the source: some Responses inputs
    // legitimately reference calls stored in previous_response_id server state.
    if (!original.outputs.has(id)) continue;
    const preserved = transformed.calls.get(id) === name && transformed.outputs.has(id);
    results.push({ id: `structure:tool_pair:${id}`, kind: "structure", status: preserved ? "pass" : images ? "indeterminate" : "fail",
      reason: preserved ? "tool_pair_preserved" : images ? "image_restructured_tool_history" : "tool_pair_missing_or_changed" });
  }
  const names = new Set((Array.isArray(transformedBody?.tools) ? transformedBody.tools : []).map(tool => tool?.function?.name || tool?.name).filter(Boolean));
  for (const tool of Array.isArray(originalBody?.tools) ? originalBody.tools : []) {
    const name = tool?.function?.name || tool?.name;
    if (typeof name === "string") results.push({ id: `structure:tool_definition:${name}`, kind: "structure", status: names.has(name) ? "pass" : "fail", reason: names.has(name) ? "tool_definition_preserved" : "tool_definition_missing" });
  }
  results.push(...imageIntegrity.checks);
  return summarize(results);
}

export function validateAnswerChecks(value, where = "answerChecks") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!["includes", "excludes", "exact", "jsonEquals", "maxChars"].includes(key)) throw new Error(`${where}.${key} is unknown`);
    if (["includes", "excludes"].includes(key)) {
      if (!Array.isArray(value[key])) throw new Error(`${where}.${key} must be an array of nonempty strings`);
      strings(value[key], `${where}.${key}`);
    }
    if (key === "exact" && (typeof value[key] !== "string" || !value[key].trim())) throw new Error(`${where}.exact must be nonempty text`);
    if (key === "maxChars" && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw new Error(`${where}.maxChars must be a positive integer`);
    if (key === "jsonEquals") {
      let valid = false;
      try { valid = value[key] !== null && typeof value[key] === "object" && isDeepStrictEqual(value[key], JSON.parse(JSON.stringify(value[key]))); } catch {}
      if (!valid) throw new Error(`${where}.jsonEquals must be a JSON object or array`);
    }
  }
}

function parseStrictJson(text) {
  const value = JSON.parse(text);
  // JSON.parse otherwise silently accepts conflicting duplicate keys. Tokens are
  // scanned only after syntax validation; escaped/unicode-equivalent keys collide.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g) || [], stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(token), keys = stack.at(-1);
      if (keys?.has(key)) throw new Error("Duplicate JSON key");
      keys?.add(key);
    }
  }
  return value;
}

/** Exact, case-sensitive answer checks; no assertions means explicitly unscored. */
export function evaluateAnswer(text, answerChecks) {
  if (answerChecks === undefined || answerChecks === null) return summarize([]);
  validateAnswerChecks(answerChecks);
  const results = [];
  for (const kind of ["includes", "excludes"]) {
    strings(answerChecks[kind], `answerChecks.${kind}`).forEach((expected, index) => {
      const present = typeof text === "string" && text.includes(expected);
      results.push({ id: `${kind}:${index}`, kind, expected,
        status: typeof text !== "string" ? "indeterminate" : (kind === "includes" ? present : !present) ? "pass" : "fail",
        reason: typeof text !== "string" ? "no_text_answer" : kind === "includes" ? "required_answer_text" : "forbidden_answer_text" });
    });
  }
  for (const kind of ["exact", "jsonEquals", "maxChars"]) {
    if (!Object.hasOwn(answerChecks, kind)) continue;
    const expected = answerChecks[kind];
    let passed = false, reason = kind === "jsonEquals" ? "answer_json_mismatch" : `answer_${kind}_mismatch`;
    if (typeof text === "string") {
      if (kind === "exact") passed = text.trim() === expected.trim();
      if (kind === "maxChars") passed = text.length <= expected;
      if (kind === "jsonEquals") {
        try { passed = isDeepStrictEqual(parseStrictJson(text), expected); }
        catch { reason = "answer_not_strict_json"; }
      }
    }
    results.push({ id: `${kind}:0`, kind, expected, status: typeof text !== "string" ? "indeterminate" : passed ? "pass" : "fail",
      reason: typeof text !== "string" ? "no_text_answer" : passed ? `answer_${kind}_matched` : reason });
  }
  return summarize(results);
}

/** Evidence location, not OCR validation: generated images may or may not contain the missing text. */
export function evaluateEvidence(body, evaluation, imageIntegrity) {
  if (!evaluation) return null;
  const text = requestTexts(body).join("\n");
  const native = evaluation.evidence.filter(value => text.includes(value)).length;
  const status = native ? "answer_evidence_in_native_text" : evaluation.kind === "native_image"
    ? imageIntegrity.missingOrChanged ? "native_image_lost" : imageIntegrity.before ? "native_image_required" : "no_native_image"
    : imageIntegrity.addedOrChanged ? "rendered_image_required" : "evidence_missing_without_image";
  return { kind: evaluation.kind, status, nativeEvidenceCount: native, totalEvidenceCount: evaluation.evidence.length };
}
