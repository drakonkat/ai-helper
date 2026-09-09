import { spawn } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { tokenStage } from "./proxy-stats.js";

// Fixed recipes; the user's --interceptor runs afterwards and can inspect/edit the result.
const PRESETS = ["none", "pxpipe", "headroom", "rtk", "headroom-pxpipe", "rtk-pxpipe"];
const DECODERS = { gzip: promisify(zlib.gunzip), deflate: promisify(zlib.inflate), br: promisify(zlib.brotliDecompress),
  ...(typeof zlib.zstdDecompress === "function" ? { zstd: promisify(zlib.zstdDecompress) } : {}) };

export function normalizePresetOptions(options) {
  const preset = options.preset || "none";
  if (!PRESETS.includes(preset)) throw new Error(`Unknown preset. Choose: ${PRESETS.join(", ")}`);
  const models = options.models ? String(options.models).split(",").map(s => s.trim()) : undefined;
  if (models?.some(s => !s || !/^[\w./:-]+\*?$/.test(s))) throw new Error("models must be comma-separated model names, optionally ending in *");
  const headroom = new URL(options.headroomUrl || "http://127.0.0.1:8787");
  if (!["http:", "https:"].includes(headroom.protocol) || headroom.username || headroom.password || headroom.search || headroom.hash) {
    throw new Error("headroomUrl must be HTTP(S) without credentials, query or fragment");
  }
  const rtkFilter = options.rtkFilter || undefined;
  if (rtkFilter && !/^[a-z][a-z0-9-]*$/.test(rtkFilter)) throw new Error("Invalid rtk filter name");
  return { preset, models: models?.join(","), headroomUrl: headroom.href, rtkFilter };
}

function toolTexts(body) {
  const slots = [];
  const add = (object, key) => { if (typeof object[key] === "string" && object[key]) slots.push([object, key]); };
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type !== "function_call_output") continue;
    if (Array.isArray(item.output)) {
      for (const part of item.output) if (part?.type === "input_text") add(part, "text");
    } else add(item, "output");
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === "tool") {
      if (Array.isArray(message.content)) {
        for (const part of message.content) if (part?.type === "text") add(part, "text");
      } else add(message, "content");
    }
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "tool_result") continue;
      if (Array.isArray(part.content)) {
        for (const block of part.content) if (block?.type === "text") add(block, "text");
      } else add(part, "content");
    }
  }
  return slots;
}

function rtkPipe(text, filter, limit) {
  return new Promise((resolve, reject) => {
    // Never execute a command from a tool call: RTK receives only stdin and fixed CLI flags.
    const child = spawn("rtk", ["pipe", ...(filter ? ["--filter", filter] : [])], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    const fail = error => { child.kill(); reject(error); };
    const timeout = setTimeout(() => fail(new Error("rtk pipe timed out")), 30000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.stdin.on("error", fail);
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > limit) fail(new Error("rtk output exceeds maxBodyBytes"));
      else chunks.push(chunk);
    });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`rtk pipe exited with code ${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(text);
  });
}

export async function createPresetHooks(config, onStats = () => {}) {
  if (!config.preset || config.preset === "none") return {};
  const { countTokens: tokenize } = await import("gpt-tokenizer/encoding/o200k_base");
  function countTokens(text) {
    try { return tokenize(text, { disallowedSpecial: new Set() }); }
    catch { return NaN; } // Observability must not reject an otherwise valid request.
  }
  const px = config.preset.includes("pxpipe") ? await import("pxpipe-proxy") : null;
  const models = config.models?.split(",");
  const wsModels = new WeakMap();
  const warnedEncodings = new Set();

  async function headroom(body, model) {
    // Responses items (reasoning, calls, IDs, images) stay native. Compress only their tool text.
    const slots = Array.isArray(body.input) ? toolTexts(body) : null;
    const messages = slots ? slots.map(([object, key], i) => ({ role: "tool", tool_call_id: String(i), content: object[key] })) : body.messages;
    if (!messages?.length) return tokenStage("headroom", 0, 0, false, "no_messages", "headroom");
    const response = await fetch(config.headroomUrl.replace(/\/$/, "") + "/v1/compress", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", ...(process.env.HEADROOM_PROXY_TOKEN ? { "x-headroom-proxy-token": process.env.HEADROOM_PROXY_TOKEN } : {}) },
      // Inline mode needs no Headroom retrieval tool injected into the client.
      body: JSON.stringify({ model, messages, config: { mode: "lossy_inline" } }),
    });
    if (!response.ok) throw new Error(`Headroom compression returned HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > config.maxBodyBytes) throw new Error("Headroom response exceeds maxBodyBytes");
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(result.messages)) throw new Error("Invalid Headroom response: missing messages");
    if (slots) {
      if (result.messages.length !== slots.length || result.messages.some((m, i) => m?.tool_call_id !== String(i) || typeof m.content !== "string")) {
        throw new Error("Headroom changed the Responses tool output structure");
      }
      slots.forEach(([object, key], i) => { object[key] = result.messages[i].content; });
    } else body.messages = result.messages;
    return tokenStage("headroom", result.tokens_before, result.tokens_after,
      JSON.stringify(result.messages) !== JSON.stringify(messages), result.compression_skipped ? "compression_skipped" : "processed", "headroom");
  }

  async function transform(raw, context, websocket = false) {
    const path = new URL(context.path, "http://localhost").pathname;
    const format = /\/(?:v1\/|anthropic\/)?messages$/.test(path) ? "anthropic"
      : /\/chat\/completions$/.test(path) ? "chat" : /\/responses$/.test(path) ? "responses" : null;
    if (!format) return raw;
    let envelope;
    try { envelope = JSON.parse(raw.toString("utf8")); } catch { return raw; }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return raw;
    if (websocket && envelope.type !== "response.create") return raw;
    const body = websocket && envelope.response ? envelope.response : envelope;
    if (!body || typeof body !== "object" || Array.isArray(body)) return raw;
    const model = body.model || (websocket && (wsModels.get(context) || new URL(context.path, "http://localhost").searchParams.get("model")));
    if (typeof model !== "string" || !model) return raw;
    if (websocket) wsModels.set(context, model);
    if (format === "responses" ? !(typeof body.input === "string" || Array.isArray(body.input)) : !Array.isArray(body.messages)) return raw;
    let changed = false;
    const stages = [];
    const report = error => {
      // Observability must never interrupt proxy traffic; no request bodies are passed to the recorder.
      try { onStats({ model, preset: config.preset, transport: websocket ? "WS" : "HTTP", changed, stages, error }); } catch {}
    };
    try {
      if (config.preset.startsWith("headroom")) {
        const before = JSON.stringify(body);
        stages.push(await headroom(body, model));
        changed = JSON.stringify(body) !== before;
      }
      if (config.preset === "rtk" || config.preset === "rtk-pxpipe") {
        let before = 0, after = 0, applied = false;
        for (const [object, key] of toolTexts(body)) {
          before += countTokens(object[key]);
          const output = await rtkPipe(object[key], config.rtkFilter, config.maxBodyBytes);
          // RTK may add framing or not recognize this output; only keep actual compression.
          if (output.trim() && Buffer.byteLength(output) < Buffer.byteLength(object[key])) {
            object[key] = output;
            changed = true;
            applied = true;
          }
          after += countTokens(object[key]);
        }
        stages.push(tokenStage("rtk", before, after, applied, applied ? "applied" : "unchanged", "o200k_estimate"));
      }
      if (px && (models ? models.some(m => m.endsWith("*") ? model.startsWith(m.slice(0, -1)) : model === m) : px.isPxpipeSupportedModel(model) || px.isPxpipeSupportedGptModel(model))) {
        const bytes = Buffer.from(JSON.stringify({ ...body, model }));
        const options = { model };
        const result = await (format === "anthropic" ? px.transformRequest(bytes, options)
          : format === "chat" ? px.transformOpenAIChatCompletions(bytes, options) : px.transformOpenAIResponses(bytes, options));
        const info = result.info || {};
        let before = 0, after = 0, method = "pxpipe_estimate";
        if (info.compressed) {
          before = info.baselineImagedTokens;
          after = Number.isFinite(info.imageTokens) ? info.imageTokens + (info.nativeInjectedTokens ?? 0) : undefined;
          if (!Number.isFinite(before) || !Number.isFinite(after)) {
            // Anthropic's transformer lacks token totals: count text locally and include newly rendered images.
            const textTokens = value => countTokens(JSON.stringify(value, (key, item) =>
              ["image", "input_image", "image_url"].includes(item?.type) || key === "encrypted_content" ? undefined : item));
            before = textTokens(JSON.parse(bytes));
            let imageTokens;
            try { imageTokens = info.imageDims?.reduce((sum, d) => sum + px.openAIVisionTokens(model, d.width, d.height), 0); } catch {}
            after = Number.isFinite(imageTokens) ? textTokens(JSON.parse(Buffer.from(result.body))) + imageTokens : undefined;
            method = "o200k_and_vision_estimate";
          }
        }
        stages.push(tokenStage("pxpipe", before, after, Boolean(info.compressed),
          info.compressed ? "applied" : String(info.reason || "unchanged").split(/[^a-z_]/i)[0].slice(0, 40), method));
        if (result.info?.compressed) {
          const transformed = JSON.parse(Buffer.from(result.body).toString("utf8"));
          if (!Object.hasOwn(body, "model")) delete transformed.model;
          // Only replace the AI request, preserving a WebSocket event's outer fields.
          if (body !== envelope) envelope.response = transformed;
          else { for (const key of Object.keys(body)) delete body[key]; Object.assign(body, transformed); }
          changed = true;
        }
      } else if (px) {
        stages.push(tokenStage("pxpipe", 0, 0, false, "model_excluded", "pxpipe_estimate"));
      }
      report(false);
      return changed ? Buffer.from(JSON.stringify(envelope)) : raw;
    } catch (error) { report(true); throw error; }
  }

  return {
    async onRequest(context) {
      if (context.method !== "POST" || !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(String(context.headers["content-type"] || ""))) return;
      const encoding = String(context.headers["content-encoding"] || "identity").toLowerCase();
      if (encoding !== "identity" && !DECODERS[encoding]) {
        if (!warnedEncodings.has(encoding)) {
          console.warn(`[aih preset] Skipped unsupported content-encoding=${encoding} on ${process.version}${encoding === "zstd" ? "; use Node.js 22.15+ for Zstandard requests" : ""}`);
          warnedEncodings.add(encoding);
        }
        return;
      }
      const raw = encoding === "identity" ? context.body : await DECODERS[encoding](context.body, { maxOutputLength: config.maxBodyBytes });
      const body = await transform(raw, context);
      if (body !== raw) {
        context.body = body;
        delete context.headers["content-encoding"];
        delete context.headers["content-md5"];
        delete context.headers.digest;
      }
    },
    async onWebSocketMessage(event) {
      if (event.direction === "request" && !event.isBinary) event.body = await transform(event.body, event.request, true);
    },
  };
}
