const finite = n => Number.isFinite(n);
export function percentile(values, percent) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(percent / 100 * sorted.length) - 1)] : null;
}
const percent = (a, b) => b ? 100 * a / b : null;
const key = row => JSON.stringify([row.model, row.format, row.transport]);

function quality(rows, field) {
  const counts = { pass: 0, fail: 0, indeterminate: 0, unscored: 0 };
  for (const row of rows) counts[row[field]?.status || "unscored"]++;
  return { ...counts, passRate: percent(counts.pass, rows.length) };
}

function summarize(rows) {
  const successful = rows.filter(r => r.status === "ok");
  const known = successful.filter(r => finite(r.before?.totalTokens) && finite(r.after?.totalTokens));
  const before = known.reduce((n, r) => n + r.before.totalTokens, 0);
  const after = known.reduce((n, r) => n + r.after.totalTokens, 0);
  const tools = successful.filter(r => finite(r.before?.toolTextTokens) && finite(r.after?.toolTextTokens));
  const toolsBefore = tools.reduce((n, r) => n + r.before.toolTextTokens, 0);
  const toolsAfter = tools.reduce((n, r) => n + r.after.toolTextTokens, 0);
  const usageRows = successful.filter(r => finite(r.live?.usage?.inputTokens) && finite(r.live?.usage?.outputTokens));
  const usage = field => { const rs = successful.filter(r => finite(r.live?.usage?.[field])); return { total: rs.length ? rs.reduce((n, r) => n + r.live.usage[field], 0) : null, measured: rs.length }; };
  const stageReasons = {};
  for (const row of rows) for (const stage of row.stages || []) {
    const id = `${stage.name}:${stage.reason}`;
    stageReasons[id] = (stageReasons[id] || 0) + 1;
  }
  return {
    preset: rows[0].preset, model: rows[0].model, format: rows[0].format, transport: rows[0].transport,
    attempts: rows.length, successful: successful.length, errors: rows.length - successful.length,
    changed: successful.filter(r => r.changed).length,
    stageReasons,
    tokens: { before: known.length ? before : null, after: known.length ? after : null,
      saved: known.length ? before - after : null, savedPercent: known.length ? percent(before - after, before) : null,
      measured: known.length, coveragePercent: percent(known.length, rows.length), partial: known.length !== rows.length },
    toolText: { before: tools.length ? toolsBefore : null, after: tools.length ? toolsAfter : null, savedPercent: percent(toolsBefore - toolsAfter, toolsBefore), measured: tools.length,
      note: "Text-only diagnostic: text moved into images is NOT a tool-context saving." },
    latency: { medianMs: percentile(successful.map(r => r.durationMs), 50), p95Ms: percentile(successful.map(r => r.durationMs), 95),
      failureP95Ms: percentile(rows.filter(r => r.status !== "ok").map(r => r.durationMs), 95),
      firstRequestMs: rows.find(r => r.firstRequest)?.durationMs ?? null,
      connectionMedianMs: percentile(successful.map(r => r.connectionMs), 50) },
    preservation: quality(rows, "preservation"), answerQuality: quality(rows, "answerQuality"),
    provider: { input: usage("inputTokens"), output: usage("outputTokens"), total: usage("totalTokens"),
      cachedInput: usage("cachedInputTokens"), cacheWriteInput: usage("cacheWriteInputTokens"), reasoning: usage("reasoningTokens"),
      measured: usageRows.length, complete: successful.filter(r => r.live?.complete).length,
      additionalToolCalls: successful.reduce((n, r) => n + (r.live?.additionalToolCalls || 0), 0),
      medianMs: percentile(successful.map(r => r.live?.durationMs), 50) },
  };
}

export function buildReport(run, { maxQualityDrop = 0, maxLatencyRegression = 25 } = {}) {
  if (![maxQualityDrop, maxLatencyRegression].every(x => finite(x) && x >= 0)) throw new Error("Decision thresholds must be nonnegative numbers");
  const measured = run.records.filter(r => r.phase === "measured");
  const groups = new Map();
  for (const row of measured) { const k = `${key(row)}:${row.preset}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row); }
  const summaries = [...groups.values()].map(summarize);
  const sampleKeys = rows => rows.map(r => JSON.stringify([r.caseId, r.round])).sort().join("\n");
  const strata = new Map();
  for (const s of summaries) { const k = key(s); if (!strata.has(k)) strata.set(k, []); strata.get(k).push(s); }
  const decisions = [...strata.values()].map(group => {
    const baseline = group.find(s => s.preset === "none");
    const live = run.meta.mode === "live";
    const candidates = group.map(s => {
      const reasons = [];
      if (!run.meta.completed) reasons.push("run_incomplete");
      if (!baseline || baseline.errors || baseline.attempts !== s.attempts) reasons.push("baseline_missing_failed_or_incomplete");
      const baselineRows = groups.get(`${key(s)}:none`) || [];
      const candidateRows = groups.get(`${key(s)}:${s.preset}`) || [];
      if (sampleKeys(baselineRows) !== sampleKeys(candidateRows)) reasons.push("baseline_samples_do_not_match");
      if (s.errors) reasons.push("request_errors");
      const tokens = live ? s.provider.input.total : s.tokens.after;
      const baselineTokens = live ? baseline?.provider.input.total : baseline?.tokens.after;
      if (live ? s.provider.measured !== s.attempts || baseline?.provider.measured !== baseline?.attempts : s.tokens.partial || baseline?.tokens.partial) reasons.push("token_coverage_incomplete");
      if (!live) reasons.push("live_quality_not_measured");
      if (live && (s.provider.complete !== s.attempts || baseline?.provider.complete !== baseline?.attempts)) reasons.push("answer_incomplete_or_tool_requested");
      if (live && (s.answerQuality.unscored || s.answerQuality.indeterminate || baseline?.answerQuality.unscored || baseline?.answerQuality.indeterminate)) reasons.push("answer_quality_unscored");
      const qualityDrop = live && baseline ? baseline.answerQuality.passRate - s.answerQuality.passRate : null;
      if (finite(qualityDrop) && qualityDrop > maxQualityDrop) reasons.push("quality_regression");
      // A completely failing baseline is not evidence for a useful compression flow.
      if (live && !baseline?.answerQuality.pass) reasons.push("baseline_has_no_passing_answers");
      const latencyRegression = baseline?.latency.p95Ms > 0 && finite(s.latency.p95Ms) ? 100 * (s.latency.p95Ms / baseline.latency.p95Ms - 1) : null;
      if (!finite(latencyRegression)) reasons.push("latency_unmeasured");
      else if (latencyRegression > maxLatencyRegression) reasons.push("latency_regression");
      const comparableTokens = !reasons.some(reason => ["baseline_missing_failed_or_incomplete", "baseline_samples_do_not_match", "token_coverage_incomplete", "request_errors"].includes(reason));
      return { preset: s.preset, eligible: reasons.length === 0, reasons,
        inputSavedPercent: comparableTokens && finite(tokens) && finite(baselineTokens) ? percent(baselineTokens - tokens, baselineTokens) : null,
        p95Ms: s.latency.p95Ms, latencyRegressionPercent: latencyRegression,
        qualityPassRate: live ? s.answerQuality.passRate : null, qualityDropPercentagePoints: qualityDrop };
    });
    const eligible = candidates.filter(c => c.eligible);
    const frontier = eligible.filter(c => !eligible.some(other => other !== c && other.inputSavedPercent >= c.inputSavedPercent && other.p95Ms <= c.p95Ms && other.qualityPassRate >= c.qualityPassRate &&
      (other.inputSavedPercent > c.inputSavedPercent || other.p95Ms < c.p95Ms || other.qualityPassRate > c.qualityPassRate))).map(c => c.preset);
    return { model: group[0].model, format: group[0].format, transport: group[0].transport,
      status: live ? (frontier.length ? "measured_tradeoffs" : "insufficient_or_regressed") : "offline_only_no_quality_winner",
      paretoFrontier: frontier, candidates };
  });
  const categories = new Map();
  for (const row of measured) { const k = `${key(row)}:${row.preset}:${row.category}`; if (!categories.has(k)) categories.set(k, []); categories.get(k).push(row); }
  return { ...run, thresholds: { maxQualityDropPercentagePoints: maxQualityDrop, maxLatencyRegressionPercent: maxLatencyRegression }, summaries,
    categories: [...categories.values()].map(rows => ({ category: rows[0].category, ...summarize(rows) })), decisions,
    warmupRecords: run.records.filter(r => r.phase === "warmup").length };
}

const cell = x => {
  const value = x === null || x === undefined ? "" : typeof x === "object" ? JSON.stringify(x) : String(x);
  // Also neutralize spreadsheet formula injection from imported fixture IDs/models.
  return '"' + (typeof x === "string" && /^[=+\-@\t\r]/.test(value) ? "'" : "") + value.replaceAll('"', '""') + '"';
};
export function reportCsv(report) {
  const columns = ["caseId", "category", "model", "format", "transport", "preset", "round", "phase", "firstRequest", "status", "before", "after", "saved", "durationMs", "connectionMs", "preservation", "answerQuality", "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "complete", "error"];
  const lines = report.records.map(r => {
    const before = r.before?.totalTokens, after = r.after?.totalTokens;
    const values = { ...r, before, after, saved: finite(before) && finite(after) ? before - after : null,
      preservation: r.preservation?.status, answerQuality: r.answerQuality?.status, ...r.live?.usage, complete: r.live?.complete };
    return columns.map(c => cell(values[c])).join(",");
  });
  return [columns.join(","), ...lines].join("\n") + "\n";
}
const fmt = (x, suffix = "") => finite(x) ? x.toFixed(1) + suffix : "?";
const md = x => String(x).replace(/[\r\n|]/g, " ");
export function reportMarkdown(report) {
  const lines = ["# Proxy benchmark", "", `Mode: **${report.meta.mode}** · corpus: \`${report.meta.corpusHash}\``,
    `Completed: ${report.meta.completed} · warmup records excluded: ${report.warmupRecords}`, "",
    "Token estimates are not billing. Unknown multimedia costs are **unknown**, not zero. Offline preservation is not semantic quality.", "",
    "| Model / format / transport | Flow | OK / attempts | Token saving (local estimate) | Coverage | Median / p95 ms | Preservation pass | Answer pass |",
    "|---|---|---:|---:|---:|---:|---:|---:|"];
  for (const s of report.summaries) lines.push(`| ${md(s.model)} / ${s.format} / ${s.transport} | ${s.preset} | ${s.successful}/${s.attempts} | ${fmt(s.tokens.savedPercent, "%")}${s.tokens.partial ? " partial" : ""} | ${fmt(s.tokens.coveragePercent, "%")} | ${fmt(s.latency.medianMs)} / ${fmt(s.latency.p95Ms)} | ${s.preservation.pass}/${s.attempts} (${s.preservation.indeterminate} unknown) | ${report.meta.mode === "live" ? `${s.answerQuality.pass}/${s.attempts}` : "not measured"} |`);
  if (report.meta.mode === "live") {
    lines.push("", "## Provider-reported usage (measured requests only)", "", "| Model / format / transport | Flow | Input | Output | Cache read | Cache write | Complete answers |", "|---|---|---:|---:|---:|---:|---:|");
    for (const s of report.summaries) lines.push(`| ${md(s.model)} / ${s.format} / ${s.transport} | ${s.preset} | ${s.provider.input.total ?? "?"} | ${s.provider.output.total ?? "?"} | ${s.provider.cachedInput.total ?? "?"} | ${s.provider.cacheWriteInput.total ?? "?"} | ${s.provider.complete}/${s.attempts} |`);
  }
  lines.push("", "## Decision support", "", "Pareto candidates trade input-token savings against p95 latency and answer pass rate; this is not a cost or statistical-significance claim.");
  for (const d of report.decisions) {
    lines.push("", `### ${md(d.model)} / ${d.format} / ${d.transport}`, `Status: ${d.status}. Pareto frontier: ${d.paretoFrontier.join(", ") || "none"}.`);
    for (const c of d.candidates) lines.push(`- ${c.preset}: input saving ${fmt(c.inputSavedPercent, "%")}, p95 change ${fmt(c.latencyRegressionPercent, "%")}; ${c.eligible ? "eligible" : c.reasons.join(", ")}.`);
  }
  lines.push("", "## Measurement notes", ...report.meta.notes.map(n => `- ${n}`), "");
  return lines.join("\n");
}
