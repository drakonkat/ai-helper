// Deterministic preservation checks are a lower bound on quality, not a semantic
// judge. In particular, rendering text into an image does not prove it is readable.
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

function requestTexts(body) {
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

function hasImages(value) {
  if (!value || typeof value !== "object") return false;
  if (IMAGE_TYPES.has(value.type)) return true;
  return Object.values(value).some(child => Array.isArray(child) ? child.some(hasImages) : hasImages(child));
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
  const images = hasImages(transformedBody);
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
  return summarize(results);
}

/** Exact, case-sensitive answer checks; no assertions means explicitly unscored. */
export function evaluateAnswer(text, answerChecks) {
  if (answerChecks === undefined || answerChecks === null) return summarize([]);
  if (typeof answerChecks !== "object" || Array.isArray(answerChecks)) throw new Error("answerChecks must be an object");
  const results = [];
  for (const kind of ["includes", "excludes"]) {
    strings(answerChecks[kind], `answerChecks.${kind}`).forEach((expected, index) => {
      const present = typeof text === "string" && text.includes(expected);
      results.push({ id: `${kind}:${index}`, kind, expected,
        status: typeof text !== "string" ? "indeterminate" : (kind === "includes" ? present : !present) ? "pass" : "fail",
        reason: typeof text !== "string" ? "no_text_answer" : kind === "includes" ? "required_answer_text" : "forbidden_answer_text" });
    });
  }
  return summarize(results);
}
