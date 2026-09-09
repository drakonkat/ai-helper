#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile, appendFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runBenchmark, prepareBenchmark, BENCHMARK_PRESETS } from "../src/benchmark/runner.js";
import { buildReport, reportCsv, reportMarkdown } from "../src/benchmark/report.js";

const HELP = `Usage: node scripts/bench-proxy.js [options]

Offline by default: private loopback proxies and real compressors; no provider call.
  --presets LIST          ${BENCHMARK_PRESETS.join(",")} (default: all; none always included)
  --formats LIST          responses,chat,anthropic (default: all)
  --transports LIST       http,ws (default: http; WS only for Responses)
  --fixtures FILE         JSON array of custom fixtures instead of built-in corpus
  --export-fixtures FILE  Write built-in fixtures as editable JSON, without running
  --model NAME            Override model identically for every fixture/flow
  --compare-models LIST   Replay each fixture for every model (mutually exclusive with --model)
  --repetitions N         Measured rounds (default: 3)
  --warmup N              Unscored rounds (default: 1; live warmups also cost tokens)
  --seed N                Reproducible randomized order (default: 42)
  --headroom-url URL      Compression service (default: http://127.0.0.1:8787)
  --rtk-filter NAME       Fixed filter for matching corpora only (default: auto)
  --models LIST           pxpipe allowlist (default: all fixture models, benchmark-only opt-in)
  --timeout-ms N          Per-request limit (default: 120000)
  --max-body-bytes N      Payload/response limit (default: 67108864)
  --out DIR               New output directory (default: benchmark-results/<run-id>)
  --save-payloads         Opt-in originals/transformed payloads and live answers; may contain sensitive data
  --live                 EXPLICITLY enable potentially billable provider calls
  --upstream URL         Live provider root BEFORE /v1, e.g. http://127.0.0.1:10100
  --api-key-env NAME      Environment variable holding credentials (never written to reports)
  --max-output-tokens N   Live answer cap (default: 256; no tool execution or retries)
  --max-live-calls N      Refuse live plans above this call count (default: 200, including warmups)
  --stop-on-error         Stop after the first request error (useful for live smoke checks)
  --max-quality-drop N   Allowed answer pass-rate drop in percentage points (default: 0)
  --max-latency-regression N  Allowed p95 increase in percent (default: 25)
  --list                 Print built-in fixture IDs without running
  --help                 Show help

Reports: report.json, records.jsonl, results.csv, report.md. Managed config/aih proxy stats are untouched.
Exit 0 completed without request errors; 2 request errors/interruption; 1 invalid setup.
Offline runs never claim a semantic-quality winner. See docs/benchmark.md.
`;

export async function main(argv = process.argv.slice(2)) {
  const strings = ["presets", "formats", "transports", "fixtures", "export-fixtures", "model", "compare-models", "repetitions", "warmup", "seed", "headroom-url", "rtk-filter", "models", "timeout-ms", "max-body-bytes", "out", "upstream", "api-key-env", "max-output-tokens", "max-live-calls", "max-quality-drop", "max-latency-regression"];
  const booleans = ["help", "list", "save-payloads", "live", "stop-on-error"];
  const { values } = parseArgs({ args: argv, options: { ...Object.fromEntries(strings.map(s => [s, { type: "string" }])), ...Object.fromEntries(booleans.map(s => [s, { type: "boolean" }])) }, strict: true, allowPositionals: false });
  if (values.help) { console.log(HELP); return 0; }
  const list = name => values[name] === undefined ? undefined : values[name].split(",").map(s => s.trim());
  const numeric = name => values[name] === undefined ? undefined : Number(values[name]);
  const formats = list("formats");
  if (formats && (formats.some(f => !["responses", "chat", "anthropic"].includes(f)) || new Set(formats).size !== formats.length)) throw new Error("Invalid formats list");
  const preview = values.list || values["export-fixtures"] ? prepareBenchmark({ model: values.model, compareModels: list("compare-models"), formats, presets: ["none"] }).fixtures : null;
  if (values.list) { console.log(preview.map(f => `${f.id}\t${f.format}\t${f.category}`).join("\n")); return 0; }
  if (values["export-fixtures"]) {
    const file = resolve(values["export-fixtures"]);
    await writeFile(file, JSON.stringify(preview, null, 2) + "\n", { flag: "wx" });
    console.log(`Fixtures exported to ${file}`); return 0;
  }
  if (values["api-key-env"] && !values.live) throw new Error("--api-key-env requires --live");
  const apiKey = values["api-key-env"] ? process.env[values["api-key-env"]] : undefined;
  if (values["api-key-env"] && !apiKey) throw new Error("Credential environment variable is missing or empty");
  const thresholds = { maxQualityDrop: numeric("max-quality-drop") ?? 0, maxLatencyRegression: numeric("max-latency-regression") ?? 25 };
  if (Object.values(thresholds).some(n => !Number.isFinite(n) || n < 0)) throw new Error("Thresholds must be nonnegative numbers");
  const fixtures = values.fixtures ? JSON.parse(await readFile(resolve(values.fixtures), "utf8")) : undefined;
  const options = { presets: list("presets"), formats, transports: list("transports"), fixtures, model: values.model, compareModels: list("compare-models"),
    repetitions: numeric("repetitions"), warmup: numeric("warmup"), seed: numeric("seed"),
    headroomUrl: values["headroom-url"], rtkFilter: values["rtk-filter"], models: values.models,
    timeoutMs: numeric("timeout-ms"), maxBodyBytes: numeric("max-body-bytes"), live: values.live,
    upstream: values.upstream, apiKey, maxOutputTokens: numeric("max-output-tokens"), maxLiveCalls: numeric("max-live-calls") };
  const prepared = prepareBenchmark(options); // Validate before creating/reserving any output files.
  const directory = resolve(values.out || join("benchmark-results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`));
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error("Output directory must be empty; choose a new run directory");
  // Reserve a new run; never overwrite a previous benchmark's measurements.
  await writeFile(join(directory, "records.jsonl"), "", { flag: "wx" });
  if (values["save-payloads"]) await mkdir(join(directory, "payloads"));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  if (values.live) console.error(`LIVE benchmark: up to ${prepared.cases.length * prepared.options.presets.length * (prepared.options.repetitions + prepared.options.warmup)} potentially billable provider calls, including warmups. No automatic retries or tool execution.`);
  try {
    const run = await runBenchmark({ ...options, signal: controller.signal,
      onRecord: async row => {
        await appendFile(join(directory, "records.jsonl"), JSON.stringify(row) + "\n");
        if (row.status === "error") {
          console.error(`${row.preset} / ${row.caseId}: ${row.error}`);
          if (values["stop-on-error"]) controller.abort();
        }
      },
      onPayload: values["save-payloads"] ? async payload => writeFile(join(directory, "payloads", `${payload.sequence}.json`), JSON.stringify(payload) + "\n", { flag: "wx" }) : undefined,
    });
    const report = buildReport(run, thresholds);
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    await writeFile(join(directory, "results.csv"), reportCsv(report), { flag: "wx" });
    await writeFile(join(directory, "report.md"), reportMarkdown(report), { flag: "wx" });
    console.log(reportMarkdown(report));
    console.log(`Reports saved to ${directory}`);
    return report.meta.completed && !report.records.some(r => r.status === "error") ? 0 : 2;
  } finally { process.removeListener("SIGINT", interrupt); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`Benchmark: ${error.message}`); process.exitCode = 1; });
}
