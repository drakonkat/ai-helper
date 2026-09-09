import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { buildReport, percentile, reportCsv, reportMarkdown } from "../src/benchmark/report.js";

const test = typeof Bun === "undefined" ? nodeTest : nodeTest.skip;
const tokens = (totalTokens = 100, toolTextTokens = 80) => ({ totalTokens, toolTextTokens });
const live = (inputTokens = 100, outputTokens = 20, extra = {}) => ({
  complete: true, additionalToolCalls: 0, durationMs: 50,
  usage: { inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null }, ...extra,
});
const row = (preset = "none", extra = {}) => ({
  caseId: "case-1", category: "build", model: "gpt-5.5", format: "responses", transport: "http", preset,
  phase: "measured", round: 0, status: "ok", changed: preset !== "none", durationMs: 100, connectionMs: 1,
  before: tokens(), after: tokens(), preservation: { status: "pass" }, answerQuality: { status: "pass" }, live: live(), ...extra,
});
const run = (records, extra = {}) => ({ meta: { mode: "offline", completed: true, corpusHash: "test-hash", notes: [], ...extra }, records });
const candidate = (report, preset) => report.decisions[0].candidates.find(item => item.preset === preset);

test("percentile is deterministic nearest rank and ignores unknown/nonfinite values", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([null, undefined, NaN, Infinity], 50), null);
  assert.equal(percentile([40, 10, 30, 20], 0), 10);
  assert.equal(percentile([40, 10, 30, 20], 50), 20);
  assert.equal(percentile([40, 10, 30, 20], 95), 40);
  assert.equal(percentile([40, 10, 30, 20], 100), 40);
  assert.equal(percentile([10, null, 20, NaN, Infinity], 50), 10);
});

test("token savings use weighted corpus sums, not averages of case percentages", () => {
  const report = buildReport(run([
    row("rtk", { before: tokens(100, 10), after: tokens(0, 0) }),
    row("rtk", { caseId: "case-2", before: tokens(900, 90), after: tokens(810, 81) }),
  ]));
  const summary = report.summaries[0];
  assert.deepEqual(summary.tokens, { before: 1000, after: 810, saved: 190, savedPercent: 19, measured: 2, coveragePercent: 100, partial: false });
  assert.equal(summary.toolText.savedPercent, 19);
  const negative = buildReport(run([row("rtk", { before: tokens(100), after: tokens(140) })])).summaries[0];
  assert.equal(negative.tokens.saved, -40);
  assert.equal(negative.tokens.savedPercent, -40);
});

test("errors and unknown totals remain visible instead of becoming zero-token savings", () => {
  const report = buildReport(run([
    row("rtk", { after: tokens(50) }),
    row("rtk", { caseId: "unknown", after: tokens(null) }),
    row("rtk", { caseId: "failed", status: "error", durationMs: 500, before: undefined, after: undefined, live: undefined }),
    row("pxpipe", { before: tokens(null), after: tokens(null), live: undefined }),
  ]));
  const summary = report.summaries.find(item => item.preset === "rtk");
  assert.equal(summary.attempts, 3);
  assert.equal(summary.successful, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.tokens.measured, 1);
  assert.equal(summary.tokens.coveragePercent, 100 / 3);
  assert.equal(summary.tokens.before, 100);
  assert.equal(summary.tokens.after, 50);
  assert.equal(summary.tokens.partial, true);
  assert.equal(summary.latency.failureP95Ms, 500);
  const unknown = report.summaries.find(item => item.preset === "pxpipe");
  for (const field of ["before", "after", "saved", "savedPercent"]) assert.equal(unknown.tokens[field], null);
  assert.equal(unknown.provider.input.total, null);
  assert.equal(unknown.provider.output.total, null);
});

test("warmup records are retained but excluded from summaries, categories and decisions", () => {
  const warmup = row("headroom", { phase: "warmup", category: "warmup-only", status: "error", durationMs: 9000 });
  const report = buildReport(run([warmup, row(), row("rtk", { firstRequest: true, durationMs: 12 })]));
  assert.equal(report.warmupRecords, 1);
  assert.equal(report.records.length, 3);
  assert.equal(report.summaries.length, 2);
  assert.ok(report.categories.every(item => item.category !== "warmup-only"));
  assert.ok(report.decisions[0].candidates.every(item => item.preset !== "headroom"));
  assert.equal(report.summaries.find(item => item.preset === "rtk").latency.firstRequestMs, 12);
});

test("offline savings and preservation never declare a semantic-quality winner", () => {
  const report = buildReport(run([row(), row("rtk", { after: tokens(1), durationMs: 1 })]));
  assert.equal(report.decisions[0].status, "offline_only_no_quality_winner");
  assert.deepEqual(report.decisions[0].paretoFrontier, []);
  for (const item of report.decisions[0].candidates) {
    assert.equal(item.eligible, false);
    assert.ok(item.reasons.includes("live_quality_not_measured"));
    assert.equal(item.qualityPassRate, null);
  }
});

test("decision eligibility gates failed/missing baselines, aborted runs and incomplete coverage", () => {
  const failedBaseline = row("none", { status: "error", answerQuality: undefined, live: undefined });
  assert.ok(candidate(buildReport(run([failedBaseline, row("rtk")], { mode: "live" })), "rtk").reasons.includes("baseline_missing_failed_or_incomplete"));
  assert.ok(candidate(buildReport(run([row("rtk")], { mode: "live" })), "rtk").reasons.includes("baseline_missing_failed_or_incomplete"));
  assert.ok(candidate(buildReport(run([row(), row("none", { round: 1 }), row("rtk")], { mode: "live" })), "rtk").reasons.includes("baseline_missing_failed_or_incomplete"));
  assert.ok(candidate(buildReport(run([row(), row("rtk")], { mode: "live", completed: false })), "rtk").reasons.includes("run_incomplete"));
  const missingUsage = row("rtk", { live: live(50, null) });
  assert.ok(candidate(buildReport(run([row(), missingUsage], { mode: "live" })), "rtk").reasons.includes("token_coverage_incomplete"));
  const missingEstimate = row("rtk", { after: tokens(null) });
  assert.ok(candidate(buildReport(run([row(), missingEstimate])), "rtk").reasons.includes("token_coverage_incomplete"));
});

test("live Pareto frontier uses measured provider input, latency and quality without an arbitrary winner", () => {
  const report = buildReport(run([
    row(),
    row("headroom", { live: live(60), after: tokens(1000), durationMs: 100 }),
    row("rtk", { live: live(70), after: tokens(1), durationMs: 90 }),
    row("rtk-pxpipe", { live: live(80), durationMs: 110 }),
    row("pxpipe", { live: live(50), durationMs: 200 }),
  ], { mode: "live" }));
  assert.equal(report.decisions[0].status, "measured_tradeoffs");
  assert.deepEqual(report.decisions[0].paretoFrontier, ["headroom", "rtk"]);
  assert.equal(candidate(report, "headroom").inputSavedPercent, 40);
  assert.equal(candidate(report, "rtk").inputSavedPercent, 30);
  assert.equal(candidate(report, "rtk-pxpipe").eligible, true);
  assert.ok(candidate(report, "pxpipe").reasons.includes("latency_regression"));
});

test("quality-drop and latency thresholds are explicit, nonnegative and inclusive", () => {
  const records = [];
  for (let index = 0; index < 4; index++) {
    records.push(row("none", { caseId: `case-${index}` }));
    records.push(row("rtk", { caseId: `case-${index}`, durationMs: 125, live: live(50), answerQuality: { status: index === 3 ? "fail" : "pass" } }));
  }
  const strict = candidate(buildReport(run(records, { mode: "live" })), "rtk");
  assert.equal(strict.qualityDropPercentagePoints, 25);
  assert.ok(strict.reasons.includes("quality_regression"));
  assert.equal(strict.latencyRegressionPercent, 25);
  const permitted = candidate(buildReport(run(records, { mode: "live" }), { maxQualityDrop: 25, maxLatencyRegression: 25 }), "rtk");
  assert.equal(permitted.eligible, true);
  for (const options of [{ maxQualityDrop: -1 }, { maxLatencyRegression: -1 }, { maxQualityDrop: NaN }, { maxLatencyRegression: Infinity }]) {
    assert.throws(() => buildReport(run(records), options), /thresholds/);
  }
});

test("incomplete answers, unscored quality and all-failing baseline prevent quality endorsement", () => {
  const incomplete = buildReport(run([row(), row("rtk", { live: live(50, 20, { complete: false, additionalToolCalls: 1 }) })], { mode: "live" }));
  assert.ok(candidate(incomplete, "rtk").reasons.includes("answer_incomplete_or_tool_requested"));
  assert.equal(incomplete.summaries.find(item => item.preset === "rtk").provider.additionalToolCalls, 1);
  for (const status of ["indeterminate", "unscored"]) {
    const report = buildReport(run([row(), row("rtk", { answerQuality: { status } })], { mode: "live" }));
    assert.ok(candidate(report, "rtk").reasons.includes("answer_quality_unscored"));
  }
  const failed = buildReport(run([row("none", { answerQuality: { status: "fail" } }), row("rtk", { answerQuality: { status: "fail" } })], { mode: "live" }));
  assert.deepEqual(failed.decisions[0].paretoFrontier, []);
  assert.ok(candidate(failed, "rtk").reasons.includes("baseline_has_no_passing_answers"));
});

test("models, formats and transports remain separate strata", () => {
  const report = buildReport(run([
    row(), row("rtk"), row("none", { format: "chat" }), row("none", { model: "claude-opus-5" }), row("none", { transport: "websocket" }),
  ]));
  assert.equal(report.summaries.length, 5);
  assert.equal(report.decisions.length, 4);
  assert.equal(report.categories.length, 5);
});

test("CSV preserves unknown values and neutralizes formula injection; Markdown discloses limits", () => {
  const report = buildReport(run([row("rtk", { caseId: '=HYPERLINK("bad")', after: tokens(null), error: "line one\nline two" })]));
  const csv = reportCsv(report);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"100","",""'));
  assert.ok(csv.includes('"line one\nline two"'));
  const markdown = reportMarkdown(report);
  assert.match(markdown, /not billing/);
  assert.match(markdown, /not semantic quality/);
  assert.match(markdown, /offline_only_no_quality_winner/);
  assert.match(markdown, /partial/);
});
