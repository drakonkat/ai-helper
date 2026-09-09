import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dashboard } from "../src/tui.js";
import { manager } from "../src/manager.js";
import { getProxyStatsPath, readProxyStats, tokenStage } from "../src/proxy-stats.js";
import { stripAnsi } from "../src/utils/format.js";

const now = 1_800_000_000_000;
const iso = value => new Date(value).toISOString();
const text = lines => lines.map(stripAnsi).join("\n");
const output = (d, at = now, width = 100) => text(d.pipelineLines(width, at));
const stream = (d, width = 160, rows = Infinity, at = now) => text(d.streamLines(width, rows, at));

function request(overrides = {}) {
  return {
    at: iso(now - 1000), model: "gpt-6-astra", preset: "rtk-pxpipe", transport: "HTTP",
    changed: true, error: false, saved: 250,
    stages: [
      tokenStage("rtk", 200, 150, true, "compressed", "gpt-tokenizer"),
      tokenStage("pxpipe", 1000, 800, true, "rendered", "estimate"),
    ],
    ...overrides,
  };
}

// Same versioned structure written by createProxyStatsRecorder; counter bases
// belong to individual stages and must never become a made-up request total.
function stats(overrides = {}) {
  return {
    version: 1, since: iso(now - 3_600_000), updatedAt: iso(now - 1000),
    requests: 120, changed: 96, errors: 2, estimatedSavedTokens: 1050, unmeasuredStages: 1,
    stages: {
      rtk: { requests: 120, applied: 3, before: 200, after: 150, saved: 50, unmeasured: 0 },
      pxpipe: { requests: 120, applied: 93, before: 5000, after: 4000, saved: 1000, unmeasured: 1 },
    },
    recent: [request()], ...overrides,
  };
}

function proxy(overrides = {}) {
  return {
    id: "proxy", status: "running", pid: 123, url: "http://127.0.0.1:8789", uptime: "1h",
    proxyOptions: { preset: "rtk-pxpipe", upstream: "https://upstream.example/v1" },
    ...overrides,
  };
}

function fixture() {
  const d = new Dashboard({ getVersions: async () => ({}) });
  d.statuses = [proxy()];
  d.proxyStats = stats();
  d.events = d.proxyStats.recent;
  d.metricsAt = now;
  d.chainAt = now;
  d.sampleMs = 1000;
  d.rates = { requests: 0 };
  d.chain = [
    { id: "client", label: "client", state: "static", detail: "AI agents / CLI" },
    { id: "proxy", label: "aih proxy", state: "running", detail: "http://127.0.0.1:8789" },
    { id: "rtk", label: "rtk (pipe)", state: "static", detail: "" },
    { id: "pxpipe", label: "pxpipe (libreria)", state: "running", detail: "" },
    { id: "upstream", label: "upstream", state: "unknown", detail: "https://upstream.example/v1" },
  ];
  return d;
}

async function withRefresh(run) {
  const state = { now, services: [proxy()], snapshot: stats() };
  const getStatus = spyOn(manager, "getStatus").mockImplementation(async () => state.services);
  const time = spyOn(Date, "now").mockImplementation(() => state.now);
  const d = new Dashboard({ getVersions: async () => ({}), getProxyStats: () => state.snapshot });
  try {
    await run(d, state, getStatus);
  } finally {
    getStatus.mockRestore();
    time.mockRestore();
  }
}

describe("native proxy pipeline dashboard", () => {
  it("uses the native stats reader and source path by default", () => {
    const d = new Dashboard();
    expect(d.getProxyStats).toBe(readProxyStats);
    expect(d.metricsFile).toBe(getProxyStatsPath());
    expect(d.metricsFile).toEndWith("proxy-stats.json");
  });

  it("separates process state, live preset activity and cumulative native counters", () => {
    const result = output(fixture());
    expect(result).toContain("metriche proxy AIH");
    expect(result).toContain("aih proxy: processo attivo");
    expect(result).toContain("pxpipe (libreria): processo attivo");
    expect(result).toContain("upstream: non verificato");
    expect(result).not.toContain(": verificato");
    expect(result).toContain("Letti 0s fa");
    expect(result).toContain("0.00 elab/s");
    expect(result).toContain("Ultimo evento 1s fa");
    expect(result).toContain("Dall'avvio dei contatori");
    expect(result).toContain("Richieste 120");
    expect(result).toContain("Modificate 96 (80.0%)");
    expect(result).toContain("Errori preset 2");
    expect(result).toContain("risparmio stimato 1.1k token (parziale)");
    expect(result).toContain("rtk: 50 token");
    expect(result).toContain("applicato 3/120");
    expect(result).toContain("pxpipe: 1.0k token");
    expect(result).toContain("non misurati 1");
    expect(result).toContain("esclusi interceptor, cache e fatturazione");
    expect(result).not.toMatch(/Headroom|cached|Durata media|Token in\/s|\$|http:\/\//);
  });

  it("toggles the source, health caveats, sampling and measurement definitions with d", () => {
    const d = fixture();
    d.onKey("d");
    const result = output(d, now, 120);
    expect(d.showPipelineDetails).toBe(true);
    expect(result).toContain("Fonte:");
    expect(result).toContain("proxy-stats.json");
    expect(result).toContain("http://127.0.0.1:8789");
    expect(result).toContain("https://upstream.example/v1");
    expect(result).toContain("aih proxy: health non verificato");
    expect(result).toContain("pxpipe (libreria): health non verificato");
    expect(result).toContain("persistono ai riavvii");
    expect(result).toContain("ultimo intervallo di 1.0 s");
    expect(result).toContain("non tutto il traffico proxy");
    expect(result).toContain("somma dei delta misurati per stadio; basi non sommabili");
    expect(result).toContain("Errori preset != errori upstream");
    expect(result).toContain("latenza e richieste in corso non misurate");
    d.onKey("d");
    expect(d.showPipelineDetails).toBe(false);
    expect(output(d)).not.toContain("Fonte:");
    expect(output(d)).not.toContain("http://");
  });

  it("keeps stale totals and events historical without stale rates or process assertions", () => {
    const d = fixture();
    d.onKey("d");
    const result = output(d, now + 6000);
    expect(d.metricsStale(now + 5000)).toBe(false);
    expect(d.metricsStale(now + 5001)).toBe(true);
    expect(result).toContain("Dati non aggiornati: ultimo campione 6s fa");
    expect(result).toContain("Dall'avvio dei contatori (ultimo campione)");
    expect(result).toContain("Richieste 120");
    expect(result).toContain("attivita non disponibile");
    expect(result).toContain("aih proxy: non verificato");
    expect(result).not.toContain("processo attivo");
    expect(result).not.toContain("0.00 elab/s");
    expect(result).toContain("Stati della catena non aggiornati");
    expect(stream(d, 160, Infinity, now + 6000)).toContain("(storico)");
    expect(stream(d, 160, Infinity, now + 6000)).toContain("gpt-6-astra");
  });

  it("does not invent zeroes without samples or ratios without denominators", () => {
    const empty = new Dashboard();
    expect(output(empty)).toContain("nessun campione");
    expect(output(empty)).not.toMatch(/0\.0|Richieste 0|NaN|Infinity/);
    expect(stream(empty)).toContain("nessun evento proxy disponibile");
    const d = fixture();
    d.proxyStats = stats({ requests: 0, changed: 0, estimatedSavedTokens: undefined, updatedAt: "invalid" });
    d.rates = {};
    d.sampleMs = null;
    d.onKey("d");
    const result = output(d);
    expect(result).toContain("Modificate 0 (-)");
    expect(result).toContain("risparmio stimato - token");
    expect(result).toContain("Ultimo evento -");
    expect(result).toContain("- elab/s");
    expect(result).toContain("in attesa del secondo campione");
    expect(result).not.toMatch(/NaN|Infinity/);
  });

  it("wraps pipeline fields and retains both panels and footer controls on a small terminal", () => {
    const d = fixture();
    for (const width of [40, 80, 100]) {
      const lines = d.pipelineLines(width, now).map(stripAnsi);
      expect(lines.every(line => line.length <= width)).toBe(true);
      expect(lines.join("\n")).toContain("Modificate 96 (80.0%)");
      expect(lines.join("\n")).toContain("Errori preset 2");
      expect(lines.join("\n")).toContain("upstream: non verificato");
    }
    const { columns, rows } = process.stdout;
    try {
      process.stdout.columns = 40;
      process.stdout.rows = 24;
      d.statuses[0].dashboardUrl = "http://127.0.0.1:8789";
      d.statuses[0].repositoryUrl = "https://github.com/example/proxy";
      d.onKey("d");
      const lines = d.buildLines().map(stripAnsi);
      expect(lines.length).toBe(24);
      expect(lines.every(line => line.length <= 40)).toBe(true);
      const footer = lines.slice(-6).join("\n");
      for (const control of ["d riduci", "q esci", "s start", "x stop", "r restart", "k kill", "o dashboard", "g GitHub"]) {
        expect(footer).toContain(control);
      }
      expect(lines[23]).toBe("pronto");
      expect(lines.join("\n")).toContain("aumenta l'altezza");
      expect(lines.join("\n")).toContain("PIPELINE");
      expect(lines.join("\n")).toContain("STREAM RICHIESTE");
      d.statuses.push(...["ocx", "agentmemory", "headroom"].map(id => ({
        id, status: "running", pid: 456, uptime: "1h", url: "http://127.0.0.1:9000",
      })));
      for (const [width, height] of [[60, 20], [40, 12]]) {
        process.stdout.columns = width;
        process.stdout.rows = height;
        const compact = d.buildLines().map(stripAnsi);
        expect(compact).toHaveLength(height);
        expect(compact.every(line => line.length <= width)).toBe(true);
        expect(compact.join("\n")).toContain("PIPELINE");
        expect(compact.join("\n")).toContain("STREAM RICHIESTE");
        expect(compact.join("\n")).toContain("d riduci");
        expect(compact.join("\n")).toContain("q esci");
        expect(compact.join("\n")).toContain("k kill");
        expect(compact.at(-1)).toBe("pronto");
      }
    } finally {
      process.stdout.columns = columns;
      process.stdout.rows = rows;
    }
  });
});

describe("native request stream", () => {
  it("shows HTTP/WS, model, preset and modified/unchanged/error states, not Headroom costs", () => {
    const d = fixture();
    d.events = [
      request(),
      request({ model: "ws-model", transport: "WS", preset: "pxpipe", changed: false, saved: 0,
        stages: [tokenStage("pxpipe", 100, 100, false, "below threshold", "estimate")] }),
      request({ model: "failed-model", preset: "headroom", error: true, saved: null, stages: [] }),
    ];
    const result = stream(d);
    expect(result).toContain("STREAM RICHIESTE");
    expect(result).toContain("proxy AIH / elaborazioni preset");
    for (const value of ["HTTP", "WS", "gpt-6-astra", "ws-model", "rtk-pxpipe", "modificata", "invariata", "errore preset", "below threshold"]) {
      expect(result).toContain(value);
    }
    expect(result).not.toMatch(/savings_events|\.headroom|\$|efficienza|cache \d|ms/);
    const failed = text(d.requestLines(d.events[2], 160));
    expect(failed).not.toMatch(/tok|non misurato|parziale/);
  });

  it("exposes before/after, method and percentage only within each stage in detail mode", () => {
    const d = fixture();
    expect(text(d.requestLines(request(), 160))).not.toContain("200 -> 150");
    d.onKey("d");
    const result = text(d.requestLines(request(), 160));
    expect(result).toContain("-250 tok");
    expect(result).toContain("rtk: applicato");
    expect(result).toContain("200 -> 150 tok (25.0%)");
    expect(result).toContain("pxpipe: applicato");
    expect(result).toContain("1.0k -> 800 tok (20.0%)");
    expect(result).toContain("gpt-tokenizer");
    expect(result).toContain("rendered");
    expect(result).toContain("estimate");
    expect(result).not.toContain("1.2k -> 950");
    expect(result).not.toMatch(/20\.8%|cache|\$|latenza/);
    expect(result.split("\n")[0]).not.toContain("%");
  });

  it("distinguishes increases, unknown estimates and partial measured savings", () => {
    const d = fixture();
    const increase = request({ saved: -40, stages: [tokenStage("pxpipe", 100, 140, true, "rendered", "estimate")] });
    expect(text(d.requestLines(increase, 160))).toContain("+40 tok");
    expect(text(d.requestLines(increase, 160))).not.toContain("--40");
    const unknown = tokenStage("pxpipe", null, null, false, "not measured", "unavailable");
    // Recorder stores zero as the sum of measured deltas even if none exist.
    const unmeasured = request({ saved: 0, stages: [unknown] });
    expect(text(d.requestLines(unmeasured, 160))).toContain("non misurato");
    expect(text(d.requestLines(unmeasured, 160))).not.toContain("0 tok");
    expect(text(d.requestLines(request({ saved: null, stages: [] }), 160))).toContain("non misurato");
    const partial = request({ saved: 50, stages: [request().stages[0], unknown] });
    expect(text(d.requestLines(partial, 160))).toContain("-50 tok (parziale)");
    d.onKey("d");
    const result = text(d.requestLines(partial, 160));
    expect(result).toContain("pxpipe: bypass");
    expect(result).toContain("- -> - tok (-)");
    expect(result).toContain("unavailable");
    expect(result).not.toMatch(/NaN|Infinity/);
  });

  it("contains long models and untrusted control characters without breaking ANSI or row widths", () => {
    const d = fixture();
    const event = request({
      at: "invalid timestamp", model: "\x1b[31m" + "very-long-model-".repeat(8) + "\x1b[0m\n\x1b[2J",
      preset: "rtk\rpreset", transport: "WS\x07", stages: [
        tokenStage("pxpipe\nforged", 100, 90, true, "rendered\r\nreason", "estimate\x1b[H"),
      ],
    });
    for (const details of [false, true]) {
      d.showPipelineDetails = details;
      for (const width of [40, 80, 100]) {
        const lines = d.requestLines(event, width);
        expect(lines.map(stripAnsi).every(line => line.length <= width)).toBe(true);
        expect(lines.map(stripAnsi).every(line => !/[\x00-\x1f\x7f-\x9f]/.test(line))).toBe(true);
        expect(text(lines)).toContain("--:--:--");
        expect(text(lines)).toContain("WS");
        expect(text(lines)).toContain("modificata");
        expect(text(lines)).toContain("reason");
      }
    }
  });

  it("selects newest complete events in chronological order within the row budget", () => {
    const d = fixture();
    d.events = ["oldest", "middle", "newest"].map((model, i) => request({ model, at: iso(now - (3 - i) * 1000), stages: [] }));
    const result = stream(d, 160, 3);
    expect(d.streamLines(160, 3, now)).toHaveLength(3);
    expect(result).not.toContain("oldest");
    expect(result.indexOf("middle")).toBeLessThan(result.indexOf("newest"));
    expect(d.streamLines(80, 0, now)).toEqual([]);
    expect(d.streamLines(80, 1, now)).toHaveLength(1);
    d.showPipelineDetails = true;
    d.events = [request()];
    const truncated = d.streamLines(40, 3, now);
    expect(truncated).toHaveLength(3);
    expect(text(truncated)).toContain("...");
    expect(truncated.map(stripAnsi).every(line => line.length <= 40)).toBe(true);
  });

  it("differentiates an empty recorder from preset none, which cannot report all proxy traffic", () => {
    const d = fixture();
    d.events = [];
    expect(stream(d)).toContain("in attesa di richieste elaborate dai preset");
    d.statuses[0].proxyOptions.preset = "none";
    expect(output(d)).toContain("Preset none: traffico non registrato nelle metriche");
    expect(stream(d)).toContain("preset none: nessun evento di elaborazione");
  });
});

describe("native snapshot refresh", () => {
  it("computes request rates from successive reads and resets baselines on restart or counter reset", async () => {
    await withRefresh(async (d, state) => {
      await d.refresh();
      expect(d.rates.requests).toBeNull();
      expect(d.sampleMs).toBeNull();
      state.now += 1000;
      await d.refresh();
      expect(d.rates.requests).toBe(0);
      state.now += 2000;
      state.snapshot = stats({ requests: 126 });
      await d.refresh();
      expect(d.rates.requests).toBe(3);
      expect(d.sampleMs).toBe(2000);
      const originalKey = d.metricsKey;
      state.services[0].pid++;
      state.now += 1000;
      state.snapshot.requests += 100;
      await d.refresh();
      expect(d.metricsKey).not.toBe(originalKey);
      expect(d.rates.requests).toBeNull();
      state.now += 1000;
      state.snapshot.requests = 1;
      await d.refresh();
      expect(d.rates.requests).toBeNull();
      state.now += 1000;
      state.snapshot.requests = 3;
      await d.refresh();
      expect(d.rates.requests).toBe(2);
      state.now += 1000;
      state.snapshot.since = iso(state.now);
      state.snapshot.requests += 100;
      await d.refresh();
      expect(d.rates.requests).toBeNull();
    });
  });

  it("treats successful reads of old idle snapshots as fresh, preserving the real last-event age", async () => {
    await withRefresh(async (d, state) => {
      state.snapshot.updatedAt = iso(now - 3_600_000);
      await d.refresh();
      state.now += 60_000;
      await d.refresh();
      expect(d.metricsAt).toBe(state.now);
      expect(d.metricsStale(state.now)).toBe(false);
      expect(d.rates.requests).toBe(0);
      const result = output(d, state.now);
      expect(result).toContain("Letti 0s fa");
      expect(result).toContain("Ultimo evento 1h fa");
      expect(result).not.toContain("Dati non aggiornati");
      expect(stream(d, 160, Infinity, state.now)).not.toContain("(storico)");
    });
  });

  it("replaces the bounded recent snapshot without duplicates on reread", async () => {
    await withRefresh(async (d, state) => {
      state.snapshot.recent = Array.from({ length: 30 }, (_, i) => request({ model: `model-${i}` }));
      await d.refresh();
      expect(d.events).toHaveLength(20);
      expect(d.events[0].model).toBe("model-10");
      const first = d.events.map(event => event.model);
      state.now += 1000;
      await d.refresh();
      expect(d.events.map(event => event.model)).toEqual(first);
      state.snapshot = stats({ recent: [null, "invalid", request({ model: "replacement" })] });
      await d.refresh();
      expect(d.events).toHaveLength(1);
      expect(d.events[0].model).toBe("replacement");
    });
  });

  it("suppresses old rates on read failure, then requires a new baseline on recovery", async () => {
    await withRefresh(async (d, state, getStatus) => {
      await d.refresh();
      state.now += 1000;
      state.snapshot.requests++;
      await d.refresh();
      expect(d.rates.requests).toBe(1);
      const good = d.proxyStats;
      const savedAt = d.metricsAt;
      state.now += 1000;
      state.snapshot = null;
      await d.refresh();
      expect(d.metricsAt).toBe(savedAt);
      expect(d.proxyStats).toBe(good);
      expect(d.events).toEqual(good.recent);
      expect(d.rates).toEqual({});
      expect(d.prevMetrics).toBeNull();
      expect(d.metricsError).toBe("Statistiche proxy assenti o non valide");
      expect(output(d, state.now)).toContain("attivita non disponibile");
      state.now += 1000;
      state.snapshot = stats({ requests: 150 });
      await d.refresh();
      expect(d.metricsError).toBeNull();
      expect(d.rates.requests).toBeNull();
      getStatus.mockRejectedValue(new Error("status failed"));
      await d.refresh();
      expect(d.refreshing).toBe(false);
      expect(d.metricsError).toBe("aggiornamento fallito");
      expect(d.rates).toEqual({});
      expect(d.prevMetrics).toBeNull();
      expect(d.chainAt).toBeNull();
    });
  });

  it("contains thrown reader errors and recovers without a stale rate", async () => {
    await withRefresh(async (d, state) => {
      await d.refresh();
      d.getProxyStats = () => { throw new Error("read unavailable"); };
      state.now += 1000;
      await d.refresh();
      expect(d.metricsError).toBe("aggiornamento fallito");
      expect(d.refreshing).toBe(false);
      expect(d.status).toContain("read unavailable");
      d.getProxyStats = () => state.snapshot;
      state.now += 1000;
      await d.refresh();
      expect(d.metricsError).toBeNull();
      expect(d.rates.requests).toBeNull();
    });
  });

  it("does not probe Headroom or any network endpoint, including when the native proxy is absent", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("unexpected network request"); });
    try {
      await withRefresh(async (d, state) => {
        state.services.push({ id: "headroom", status: "running", url: "http://127.0.0.1:8788" });
        await d.refresh();
        expect(d.metricsError).toBeNull();
        expect(d.chain.some(node => node.id === "headroom")).toBe(false);
        expect(d.chain.find(node => node.id === "upstream").state).toBe("unknown");
        state.services = state.services.filter(service => service.id !== "proxy");
        await d.refresh();
        expect(d.metricsError).toBe("Proxy AIH non configurato");
        expect(d.rates).toEqual({});
        expect(d.chain.find(node => node.id === "proxy").state).toBe("unknown");
        expect(d.chain.some(node => node.id === "headroom")).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it("shows persisted counters and events as historical when the proxy is stopped", async () => {
    await withRefresh(async (d, state) => {
      state.services[0].status = "stopped";
      await d.refresh();
      expect(d.metricsError).toBe("Proxy AIH non in esecuzione");
      expect(d.proxyStats.requests).toBe(120);
      expect(d.rates).toEqual({});
      expect(output(d)).toContain("aih proxy: fermo");
      expect(output(d)).toContain("Richieste 120");
      expect(output(d)).toContain("(ultimo campione)");
      expect(stream(d)).toContain("(storico)");
      expect(stream(d)).toContain("gpt-6-astra");
      state.services[0].status = "running";
      state.now += 1000;
      await d.refresh();
      expect(d.metricsError).toBeNull();
      expect(d.rates.requests).toBeNull();
    });
  });

  it("handles missing and malformed native files and resumes when the snapshot becomes readable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aih-tui-native-"));
    const file = join(directory, "proxy-stats.json");
    try {
      await withRefresh(async (d, state) => {
        d.getProxyStats = () => readProxyStats(file);
        await d.refresh();
        expect(d.proxyStats).toBeNull();
        expect(d.metricsAt).toBeNull();
        expect(d.metricsError).toBe("Statistiche proxy assenti o non valide");
        writeFileSync(file, JSON.stringify(stats()));
        state.now += 1000;
        await d.refresh();
        expect(d.proxyStats.requests).toBe(120);
        expect(d.metricsError).toBeNull();
        expect(d.rates.requests).toBeNull();
        for (const invalid of ["{partial", JSON.stringify({ version: 1, requests: "120", stages: {}, recent: [] }), "null"]) {
          const savedAt = d.metricsAt;
          writeFileSync(file, invalid);
          state.now += 1000;
          await d.refresh();
          expect(d.metricsError).toBe("Statistiche proxy assenti o non valide");
          expect(d.metricsAt).toBe(savedAt);
          expect(d.proxyStats.requests).toBe(120);
          expect(d.rates).toEqual({});
          expect(stream(d, 160, Infinity, state.now)).toContain("(storico)");
        }
        writeFileSync(file, JSON.stringify(stats({ requests: 160 })));
        state.now += 1000;
        await d.refresh();
        expect(d.metricsError).toBeNull();
        expect(d.proxyStats.requests).toBe(160);
        expect(d.rates.requests).toBeNull();
        unlinkSync(file);
        await d.refresh();
        expect(d.metricsError).toBe("Statistiche proxy assenti o non valide");
        expect(d.proxyStats.requests).toBe(160);
      });
    } finally {
      try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      rmdirSync(directory);
    }
  });
});
