import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original = "info.responsesComposition = measureResponsesComposition(req, inputWasString, originalInputString, inputItems);";
// Only the diagnostic copy is filtered. The transformer continues using req/inputItems unchanged.
const replacement = `// aih: partial diagnostics exclude opaque payloads (pxpipe 0.14.0).
    const diagnosticOriginal = JSON.stringify(req);
    const diagnosticJson = JSON.stringify(req, (key, value) => {
        // Parse before filtering so a serialized media object is filtered at its root too.
        if (key === 'output' && typeof value === 'string' && /"(?:encrypted_content|inline_data|inlineData)"|"type"\\s*:\\s*"(?:image|input_image|output_image|image_url|input_audio|audio|audio_url|input_video|video|video_url)"/.test(value)) {
            try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') value = parsed; } catch {}
        }
        if (key === 'encrypted_content') return undefined;
        if (['image', 'input_image', 'output_image', 'image_url', 'input_audio', 'audio', 'audio_url', 'input_video', 'video', 'video_url'].includes(value?.type) || value?.inline_data || value?.inlineData)
            return { type: value.type || 'opaque_media' };
        if (['compaction', 'compaction_trigger', 'context_compaction'].includes(value?.type))
            return { type: value.type, id: value.id };
        return value;
    });
    const diagnosticRequest = JSON.parse(diagnosticJson);
    info.responsesComposition = measureResponsesComposition(diagnosticRequest, inputWasString, originalInputString, inputWasString ? [] : diagnosticRequest.input);
    info.responsesComposition.excludedBytes = Math.max(0, new TextEncoder().encode(diagnosticOriginal).length - new TextEncoder().encode(diagnosticJson).length);
    info.responsesComposition.partial = diagnosticJson !== diagnosticOriginal;`;

export function patchPxpipeSource(source, version) {
  if (version !== "0.14.0") throw new Error(`Review the pxpipe diagnostic patch before using version ${version}`);
  if (source.includes(replacement)) return source;
  // Upgrade the diagnostic block installed by aih 1.2.12 in place.
  const previous = /\/\/ aih: partial diagnostics exclude opaque payloads \(pxpipe 0\.14\.0\)\.[\s\S]*?info\.responsesComposition\.partial = diagnosticJson !== diagnosticOriginal;/g;
  if (source.match(previous)?.length === 1) source = source.replace(previous, original);
  if (source.split(original).length !== 2) throw new Error("pxpipe diagnostic patch target changed");
  return source.replace(original, replacement);
}

// History planning must keep media-bearing tool rounds native, including their call IDs.
const historyMarker = "// aih: native tool media is a history barrier (pxpipe 0.14.0).";
const historyChanges = [
  ["function responseOutputText(item) {", `${historyMarker}
function responseOutputHasMedia(output) {
    if (typeof output === 'string') {
        if (!/"(?:encrypted_content|inline_data|inlineData)"|"type"\\s*:\\s*"(?:image|input_image|output_image|image_url|input_audio|audio|audio_url|input_video|video|video_url|compaction|compaction_trigger|context_compaction)"/.test(output)) return false;
        try { output = JSON.parse(output); } catch { return false; }
    }
    const pending = [output];
    while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        if (['image', 'input_image', 'output_image', 'image_url', 'input_audio', 'audio', 'audio_url', 'input_video', 'video', 'video_url', 'compaction', 'compaction_trigger', 'context_compaction'].includes(value.type)
            || value.inline_data || value.inlineData || typeof value.encrypted_content === 'string') return true;
        for (const child of Object.values(value)) pending.push(child);
    }
    return false;
}
function responseOutputText(item) {`],
  ["const output = items[outputIndex];", "const output = items[outputIndex];\n            const opaque = responseOutputHasMedia(output.output);"],
  ["text: `${responseCallText(call)}\\n${responseOutputText(output)}`,", "opaque,\n                text: opaque ? '' : `${responseCallText(call)}\\n${responseOutputText(output)}`,"],
  ["outputTokens: gptCountTokens(typeof output.output === 'string' ? output.output : safeJson(output.output)),", "outputTokens: opaque ? 0 : gptCountTokens(typeof output.output === 'string' ? output.output : safeJson(output.output)),"],
  ["pairs: calls,", "opaque: calls.some((pair) => pair.opaque),\n            pairs: calls,"],
  ["const old = completed.slice(0, recentStart);", "const oldRounds = completed.slice(0, recentStart);\n    const old = oldRounds.filter((round) => !round.opaque);"],
  ["const oldPairs = old.reduce", "const oldPairs = oldRounds.reduce"],
];

export function patchPxpipeHistorySource(source, version) {
  if (version !== "0.14.0") throw new Error(`Review the pxpipe history patch before using version ${version}`);
  if (source.includes(historyMarker) && historyChanges.every(([, patched]) => source.includes(patched))) return source;
  for (const [target, patched] of historyChanges) {
    if (source.split(target).length !== 2) throw new Error("pxpipe history patch target changed");
    source = source.replace(target, patched);
  }
  return source;
}

export function patchPxpipe() {
  const entry = fileURLToPath(import.meta.resolve("pxpipe-proxy"));
  const manifest = JSON.parse(readFileSync(resolve(dirname(entry), "../../package.json"), "utf8"));
  // Validate both targets before modifying either dependency file.
  const changes = [["openai.js", patchPxpipeSource], ["openai-history.js", patchPxpipeHistorySource]].map(([name, patch]) => {
    const file = resolve(dirname(entry), name), source = readFileSync(file, "utf8");
    return { file, source, patched: patch(source, manifest.version) };
  });
  for (const { file, source, patched } of changes) {
    if (patched !== source) {
      const temporary = `${file}.${process.pid}.tmp`;
      try { writeFileSync(temporary, patched); renameSync(temporary, file); }
      finally { rmSync(temporary, { force: true }); }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) patchPxpipe();
