import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import * as px from "pxpipe-proxy";
import { tokenStage } from "./proxy-stats.js";

parentPort.on("message", async ({ id, body, format, model }) => {
  const started = performance.now();
  const cpu = process.threadCpuUsage?.();
  try {
    const result = await (format === "anthropic" ? px.transformRequest(body, { model })
      : format === "chat" ? px.transformOpenAIChatCompletions(body, { model }) : px.transformOpenAIResponses(body, { model }));
    const info = result.info || {};
    let before = 0, after = 0, method = "pxpipe_estimate";
    if (info.compressed) {
      before = info.baselineImagedTokens;
      after = Number.isFinite(info.imageTokens) ? info.imageTokens + (info.nativeInjectedTokens ?? 0) : undefined;
      if (!Number.isFinite(before) || !Number.isFinite(after)) {
        const textTokens = value => {
          try { return countTokens(JSON.stringify(value, (key, item) =>
            ["image", "input_image", "output_image", "image_url"].includes(item?.type) || key === "encrypted_content" ? undefined : item), { disallowedSpecial: new Set() }); }
          catch { return NaN; }
        };
        before = textTokens(JSON.parse(Buffer.from(body)));
        let imageTokens;
        try { imageTokens = info.imageDims?.reduce((sum, d) => sum + px.openAIVisionTokens(model, d.width, d.height), 0); } catch {}
        after = Number.isFinite(imageTokens) ? textTokens(JSON.parse(Buffer.from(result.body))) + imageTokens : undefined;
        method = "o200k_and_vision_estimate";
      }
    }
    const stage = tokenStage("pxpipe", before, after, Boolean(info.compressed),
      info.compressed ? "applied" : String(info.reason || "unchanged").split(/[^a-z_]/i)[0].slice(0, 40), method);
    if (info.responsesComposition) stage.diagnostics = {
      partial: Boolean(info.responsesComposition.partial), excludedBytes: info.responsesComposition.excludedBytes ?? 0,
    };
    const output = info.compressed ? Uint8Array.from(result.body) : undefined;
    const usage = cpu && process.threadCpuUsage(cpu);
    parentPort.postMessage({ id, body: output, stage, timings: {
      pxpipeMs: performance.now() - started,
      ...(usage ? { pxpipeCpuMs: (usage.user + usage.system) / 1000 } : {}),
    } }, output ? [output.buffer] : []);
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
parentPort.postMessage({ ready: true });
