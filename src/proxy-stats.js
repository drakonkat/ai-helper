import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAihDir } from "./utils/path.js";

export const getProxyStatsPath = () => join(getAihDir(), "proxy-stats.json");

export function readProxyStats(file = getProxyStatsPath()) {
  try {
    const stats = JSON.parse(readFileSync(file, "utf8"));
    return stats.version === 1 && Number.isFinite(stats.requests) && stats.stages && Array.isArray(stats.recent) ? stats : null;
  } catch { return null; }
}

export function tokenStage(name, before, after, applied, reason, method) {
  const known = Number.isFinite(before) && before >= 0 && Number.isFinite(after) && after >= 0;
  return { name, before: known ? Math.round(before) : null, after: known ? Math.round(after) : null,
    saved: known ? Math.round(before - after) : null, applied, reason, method };
}

// One managed proxy writes this bounded snapshot. Counters survive worker restarts.
export function createProxyStatsRecorder(file = getProxyStatsPath()) {
  const stats = readProxyStats(file) || { version: 1, since: new Date().toISOString(), requests: 0,
    changed: 0, errors: 0, estimatedSavedTokens: 0, unmeasuredStages: 0, stages: {}, recent: [] };
  let warned = false;
  return event => {
    try {
      stats.updatedAt = new Date().toISOString();
      stats.requests++;
      if (event.error) stats.errors++;
      else if (event.changed) stats.changed++;
      const stages = event.error ? [] : event.stages;
      let saved = 0;
      for (const stage of stages) {
        const total = stats.stages[stage.name] ||= { requests: 0, applied: 0, before: 0, after: 0, saved: 0, unmeasured: 0 };
        total.requests++;
        if (stage.applied) total.applied++;
        if (stage.saved === null) { total.unmeasured++; stats.unmeasuredStages++; }
        else { total.before += stage.before; total.after += stage.after; total.saved += stage.saved; saved += stage.saved; }
      }
      stats.estimatedSavedTokens += saved;
      const model = String(event.model).replace(/[\r\n]/g, " ").slice(0, 128);
      stats.recent.push({ at: stats.updatedAt, model, preset: event.preset, transport: event.transport,
        changed: event.changed, error: Boolean(event.error), saved: event.error ? null : saved, stages });
      stats.recent = stats.recent.slice(-20);
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(stats) + "\n");
      renameSync(temporary, file);
      console.log(`[aih stats] ${event.transport} ${model} ${event.preset}: ${event.error ? "processing failed" : stages.map(s => `${s.name}=${s.saved ?? "?"} (${s.reason})`).join(", ") + `; estimated saved=${saved} tokens`}`);
    } catch (error) {
      if (!warned) console.error(`[aih stats] Cannot save statistics: ${error.message}`);
      warned = true;
    }
  };
}

export function proxyStatsLines(stats) {
  if (!stats) return ["Proxy: nessuna statistica. Invia una richiesta AI con un preset attivo."];
  return [
    `PROXY: risparmio stimato ${stats.estimatedSavedTokens} token${stats.unmeasuredStages ? " (parziale)" : ""} | richieste ${stats.requests} | modificate ${stats.changed} | errori preset ${stats.errors}`,
    ...Object.entries(stats.stages).map(([name, s]) => `  ${name}: ${s.saved} token risparmiati | applicato ${s.applied}/${s.requests}${s.unmeasured ? ` | non misurati ${s.unmeasured}` : ""}`),
    "  Stime dei preset; esclusi interceptor, cache e fatturazione.",
  ];
}
