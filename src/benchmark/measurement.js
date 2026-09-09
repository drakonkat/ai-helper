import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { openAIVisionTokens, resolveVisionCost } from "pxpipe-proxy";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IMAGE_TYPES = new Set(["image", "image_url", "input_image"]);
const OTHER_MEDIA_TYPES = new Set(["audio", "input_audio", "output_audio", "video", "video_url", "input_video", "file", "input_file", "document"]);
const BINARY_KEYS = new Set(["encrypted_content", "file_data", "b64_json", "base64", "bytes", "audio_data", "image_data", "video_data"]);

function tokenize(text) {
  // Tool output may contain special-token spellings; count them as ordinary text.
  return countTokens(text, { disallowedSpecial: new Set() });
}

function parseBody(body) {
  const serialized = typeof body === "string" ? body
    : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : JSON.stringify(body);
  const parsed = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Benchmark measurement requires a JSON request object");
  }
  return { parsed, bytes: Buffer.byteLength(serialized, "utf8") };
}

function pngDimensions(url) {
  if (typeof url !== "string" || !url.startsWith("data:image/png;base64,")) return null;
  const payload = url.slice("data:image/png;base64,".length);
  // Decode only IHDR, never the whole image. A malformed or truncated header is
  // not an image with zero cost. PNG dimensions are unsigned 31-bit integers.
  if (payload.length < 44 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  const header = Buffer.from(payload.slice(0, 44), "base64");
  if (header.length < 33 || !header.subarray(0, 8).equals(PNG_SIGNATURE)
    || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return null;
  return { width, height };
}

function recognizedOpenAIModel(value) {
  // Do not let pxpipe's unknown-model fallback charge an Anthropic/Gemini image
  // using OpenAI tile costs. These are model families represented by the pinned
  // pxpipe version; future/unrecognized versions must be added deliberately.
  const model = typeof value === "string" ? value.toLowerCase().replace(/^openai\//, "") : "";
  const date = "(?:-\\d{4}-\\d{2}-\\d{2})?";
  const known = ["gpt-4o", "gpt-4\\.1(?:-mini|-nano)?", "gpt-4\\.5-preview",
    "gpt-5(?:-mini|-nano|-chat-latest)?", "gpt-5\\.[1-6](?:-mini|-nano|-sol|-terra|-luna|-chat-latest|-codex)?",
    "o1(?:-pro)?", "o3(?:-pro)?", "o4-mini"];
  return new RegExp(`^(?:${known.join("|")})${date}$`).test(model) ? model : null;
}

function imageSource(block) {
  if (block.type === "image_url") return { url: block.image_url?.url ?? block.image_url, detail: block.image_url?.detail ?? block.detail };
  if (block.type === "input_image") return { url: block.image_url, detail: block.detail };
  const source = block.source ?? block.inline_data ?? block.inlineData;
  if (source?.type === "base64" || source?.data) {
    return { url: `data:${source.media_type ?? source.mime_type ?? source.mimeType};base64,${source.data}`, detail: block.detail };
  }
  return { url: source?.url ?? block.url, detail: block.detail };
}

function toolStrings(body) {
  const strings = [];
  const add = value => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) {
      for (const block of value) {
        if (["text", "input_text", "output_text"].includes(block?.type) && typeof block.text === "string") strings.push(block.text);
      }
    }
  };
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type === "function_call_output") add(item.output);
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === "tool" || message?.role === "function") add(message.content);
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool_result") add(block.content);
    }
  }
  return strings;
}

/**
 * A deterministic, cross-preset estimate, NOT provider billing/count_tokens.
 * textTokens counts canonical JSON (including structural/request fields) after
 * removing media payloads and opaque encrypted content. It uses o200k_base for
 * EVERY model so comparisons do not mix compressors' incompatible counters.
 * Image estimates use the installed pxpipe profile only for recognized OpenAI
 * models with explicit high/original detail. Unknown detail, remote/non-PNG
 * images, non-OpenAI media, and opaque content make totalTokens null; the known
 * subtotal remains available in knownTokens. No remote URL is fetched.
 */
export async function measureRequest(body) {
  const { parsed, bytes } = parseBody(body);
  const warnings = new Set(["Local estimate: o200k_base over sanitized canonical JSON, not provider billing; JSON framing differs from model serialization."]);
  const model = recognizedOpenAIModel(parsed.model);
  const imageMeasurements = [];
  let unknownMedia = 0;
  let opaqueFields = 0;
  let omittedPayloads = 0;

  function inspectImage(block) {
    const { url, detail } = imageSource(block);
    const dimensions = pngDimensions(url);
    let reason;
    if (!model) reason = "unsupported_model";
    else if (!dimensions) reason = "remote_non_png_or_invalid_header";
    else if (detail !== "high" && detail !== "original") reason = "unknown_image_detail";
    let tokens = null;
    if (!reason) {
      const profile = resolveVisionCost(model);
      if (!["tile", "patch"].includes(profile?.regime)) reason = "unsupported_vision_profile";
      // The dependency's patch-cap shortcut is not a full provider resize
      // algorithm. Above its cap, leave the cost unknown rather than undercount.
      else if (profile.regime === "patch" && profile.patchCap
        && Math.ceil(dimensions.width / 32) * Math.ceil(dimensions.height / 32) > profile.patchCap) reason = "image_resize_not_modeled";
      else {
        const estimate = openAIVisionTokens(model, dimensions.width, dimensions.height);
        if (!Number.isFinite(estimate) || estimate < 0) reason = "invalid_vision_estimate";
        else tokens = estimate;
      }
    }
    if (reason) warnings.add(`Image token cost unknown (${reason}); totalTokens is null, not zero.`);
    else warnings.add("Image tokens are an installed pxpipe profile approximation for explicit high/original detail; provider resizing/detail rules and profile overrides may differ. Validate with provider usage.");
    imageMeasurements.push({ ...(dimensions ?? {}), detail: detail ?? null, tokens, reason: reason ?? null });
  }

  function stripDataUris(text) {
    return text.replace(/data:[^\s\"'<>]*;base64,[A-Za-z0-9+/=_-]*/gi, () => {
      omittedPayloads++;
      return "";
    });
  }

  function sanitize(value) {
    if (typeof value === "string") return stripDataUris(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    const inline = value.inline_data ?? value.inlineData;
    const isImage = IMAGE_TYPES.has(value.type) || /^image\//.test(inline?.mime_type ?? inline?.mimeType ?? "");
    if (isImage) {
      inspectImage(value);
      // Image URLs, IDs and payloads are transport representations, NOT text.
      return { type: value.type ?? "image", ...(value.detail ? { detail: value.detail } : {}) };
    }
    if (OTHER_MEDIA_TYPES.has(value.type) || inline) {
      unknownMedia++;
      return { type: value.type ?? "media" };
    }
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (BINARY_KEYS.has(key) || key === "data" && value.type === "base64") {
        if (key === "encrypted_content") opaqueFields++;
        else omittedPayloads++;
        continue;
      }
      result[key] = sanitize(value[key]);
    }
    return result;
  }

  const sanitized = sanitize(parsed);
  const textTokens = tokenize(JSON.stringify(sanitized));
  // These are bare tool text counts, without JSON framing. Do not treat the
  // disappearance of native tool text into images as 100% whole-request savings.
  const toolTextTokens = toolStrings(parsed).reduce((sum, text) => sum + tokenize(stripDataUris(text)), 0);
  const unknownImages = imageMeasurements.filter(item => item.tokens === null).length;
  const imageTokens = imageMeasurements.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
  const knownTokens = textTokens + imageTokens;
  if (unknownMedia) warnings.add("Audio/video/file or other media cost is unknown; its payload is excluded from text tokens.");
  if (opaqueFields) warnings.add("Opaque encrypted_content is excluded; its token cost is unknown.");
  if (omittedPayloads) warnings.add("Unclassified binary/base64 payloads are excluded from text tokens; their token cost is unknown.");
  const hasUnknown = unknownImages > 0 || unknownMedia > 0 || opaqueFields > 0 || omittedPayloads > 0;
  return {
    method: "o200k_base:canonical-json+pxpipe:openai-vision-estimate",
    textTokens, toolTextTokens, imageTokens, totalTokens: hasUnknown ? null : knownTokens,
    knownTokens, images: imageMeasurements.length, unknownImages, unknownMedia, opaqueFields,
    bytes, warnings: [...warnings], imageMeasurements,
  };
}
