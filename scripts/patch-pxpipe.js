import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original = "info.responsesComposition = measureResponsesComposition(req, inputWasString, originalInputString, inputItems);";
// Only the diagnostic copy is filtered. The transformer continues using req/inputItems unchanged.
const replacement = `// aih: partial diagnostics exclude opaque payloads (pxpipe 0.14.0).
    const diagnosticOriginal = JSON.stringify(req);
    const diagnosticJson = JSON.stringify(req, (key, value) => {
        if (key === 'encrypted_content') return undefined;
        if (['image', 'input_image', 'output_image', 'image_url', 'input_audio', 'audio', 'audio_url', 'input_video', 'video', 'video_url'].includes(value?.type) || value?.inline_data || value?.inlineData)
            return { type: value.type || 'opaque_media' };
        if (['compaction', 'compaction_trigger', 'context_compaction'].includes(value?.type))
            return { type: value.type, id: value.id };
        // Tool outputs may contain JSON-serialized media instead of a content array.
        if (key === 'output' && typeof value === 'string' && /"(?:encrypted_content|inline_data|inlineData)"|"type"\\s*:\\s*"(?:image|input_image|output_image|image_url|input_audio|audio|audio_url|input_video|video|video_url)"/.test(value)) {
            try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return parsed; } catch {}
        }
        return value;
    });
    const diagnosticRequest = JSON.parse(diagnosticJson);
    info.responsesComposition = measureResponsesComposition(diagnosticRequest, inputWasString, originalInputString, inputWasString ? [] : diagnosticRequest.input);
    info.responsesComposition.excludedBytes = Math.max(0, new TextEncoder().encode(diagnosticOriginal).length - new TextEncoder().encode(diagnosticJson).length);
    info.responsesComposition.partial = diagnosticJson !== diagnosticOriginal;`;

export function patchPxpipeSource(source, version) {
  if (version !== "0.14.0") throw new Error(`Review the pxpipe diagnostic patch before using version ${version}`);
  if (source.includes(replacement)) return source;
  if (source.split(original).length !== 2) throw new Error("pxpipe diagnostic patch target changed");
  return source.replace(original, replacement);
}

export function patchPxpipe() {
  const entry = fileURLToPath(import.meta.resolve("pxpipe-proxy"));
  const manifest = JSON.parse(readFileSync(resolve(dirname(entry), "../../package.json"), "utf8"));
  const file = resolve(dirname(entry), "openai.js");
  const source = readFileSync(file, "utf8");
  const patched = patchPxpipeSource(source, manifest.version);
  if (patched !== source) {
    const temporary = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, patched); renameSync(temporary, file); }
    finally { rmSync(temporary, { force: true }); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) patchPxpipe();
