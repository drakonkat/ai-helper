import { createHash } from "node:crypto";

const TYPES = new Set(["image", "image_url", "input_image", "output_image"]);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const textTypes = new Set(["text", "input_text", "output_text"]);

/** Only protocol content slots, never schemas, metadata or strings containing JSON. No URL fetches. */
export function requestImages(body, { identities = true } = {}) {
  const images = [];
  function content(value, owner, path) {
    if (!Array.isArray(value)) return;
    const nearbyText = identities ? value.filter(part => textTypes.has(part?.type) && typeof part.text === "string").map(part => part.text) : [];
    const associationHash = identities ? hash({ ...owner, nearbyText }) : undefined;
    for (const [index, part] of value.entries()) {
      if (!part || typeof part !== "object") continue;
      const inline = part.inline_data || part.inlineData;
      if (TYPES.has(part.type) || /^image\//.test(inline?.mime_type || inline?.mimeType || "")) {
        // Routing only needs presence: avoid serializing/hashing potentially huge attachments there.
        images.push({ ...(identities ? { fingerprint: hash(part), associationHash } : {}), group: path, position: index });
      } else if (part.type === "tool_result") {
        content(part.content, { ...owner, toolCallId: part.tool_use_id || null }, `${path}/${index}/tool_result`);
      }
    }
  }
  content(body?.system, { scope: "system", role: "system" }, "system");
  content(body?.instructions, { scope: "instructions", role: "system" }, "instructions");
  for (const scope of ["input", "messages"]) {
    for (const [index, item] of (Array.isArray(body?.[scope]) ? body[scope] : []).entries()) {
      if (!item || typeof item !== "object") continue;
      const owner = { scope, role: item.role || null, toolCallId: item.call_id || item.tool_call_id || null };
      content(item.content, owner, `${scope}/${index}/content`);
      if (item.type === "function_call_output") content(item.output, owner, `${scope}/${index}/output`);
    }
  }
  return images;
}

/** Exact attachment/metadata preservation, relative order, grouping and adjacent native text. */
export function compareRequestImages(original, transformed) {
  const before = requestImages(original), after = requestImages(transformed);
  const wanted = new Set(before.map(x => x.fingerprint));
  const originalsAfter = after.filter(x => wanted.has(x.fingerprint));
  const counts = list => { const map = new Map(); for (const x of list) map.set(x.fingerprint, (map.get(x.fingerprint) || 0) + 1); return map; };
  const b = counts(before), a = counts(originalsAfter);
  let retained = 0, duplicated = 0;
  for (const [fingerprint, count] of b) { retained += Math.min(count, a.get(fingerprint) || 0); duplicated += Math.max(0, (a.get(fingerprint) || 0) - count); }
  const sequence = list => JSON.stringify(list.map(x => x.fingerprint));
  const groups = list => { const map = new Map(); return list.map(x => { if (!map.has(x.group)) map.set(x.group, map.size); return map.get(x.group); }); };
  const occurrences = new Map(), matches = new Map();
  for (const item of originalsAfter) { if (!matches.has(item.fingerprint)) matches.set(item.fingerprint, []); matches.get(item.fingerprint).push(item); }
  const checks = before.map((item, index) => {
    const occurrence = occurrences.get(item.fingerprint) || 0;
    occurrences.set(item.fingerprint, occurrence + 1);
    const match = matches.get(item.fingerprint)?.[occurrence];
    return { id: `native_image:${index}`, kind: "nativeImage", status: match ? "pass" : "fail", reason: match ? "native_image_unchanged" : "native_image_missing_or_changed" };
  });
  if (before.length) {
    const ordered = sequence(before) === sequence(originalsAfter);
    checks.push({ id: "native_images:order", kind: "nativeImage", status: ordered ? "pass" : "fail", reason: ordered ? "native_image_order_preserved" : "native_image_order_or_count_changed" });
    const associated = ordered && before.every((x, i) => x.associationHash === originalsAfter[i].associationHash)
      && JSON.stringify(groups(before)) === JSON.stringify(groups(originalsAfter));
    checks.push({ id: "native_images:association", kind: "nativeImage", status: associated ? "pass" : "fail", reason: associated ? "native_image_association_preserved" : "native_image_association_or_adjacent_text_changed" });
  }
  return { status: checks.some(c => c.status === "fail") ? "fail" : before.length ? "pass" : "unscored",
    before: before.length, after: after.length, retained, missingOrChanged: before.length - retained, duplicated,
    addedOrChanged: after.length - originalsAfter.length, checks };
}
