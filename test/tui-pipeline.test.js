import { describe, expect, it, spyOn } from "bun:test";
import { Dashboard } from "../src/tui.js";
import { manager } from "../src/manager.js";
import { stripAnsi } from "../src/utils/format.js";

const now = 1_800_000_000_000;
const metrics = {
  headroom_requests_total: 120,
  headroom_requests_cached_total: 110,
  headroom_inbound_requests_active: 1,
  headroom_tokens_input_total: 992,
  headroom_tokens_saved_total: 8,
  headroom_tokens_output_total: 100,
  headroom_latency_ms_sum: 22816,
  headroom_latency_ms_count: 1,
};

function fixture() {
  const d = new Dashboard({ getVersions: async () => ({}) });
  d.metrics = { ...metrics };
  d.metricsAt = now;
  d.chainAt = now;
  d.sampleMs = 1000;
  d.rates = { headroom_requests_total: 0, headroom_tokens_input_total: 0, headroom_tokens_output_total: 0 };
  d.chain = [
    { id: "client", label: "client", state: "static", detail: "AI agents / CLI" },
    { id: "headroom", label: "headroom", state: "healthy", detail: "http://localhost:8788 v0.37.0" },
    { id: "pxpipe", label: "pxpipe", state: "running", detail: "http://127.0.0.1:47822" },
    { id: "upstream", label: "upstream", state: "unknown", detail: "" },
  ];
  return d;
}

const output = (d, at = now, width = 100) => d.pipelineLines(width, at).map(stripAnsi).join("\n");

describe("pipeline dashboard", () => {
  it("separates health, live activity and cumulative metrics without technical clutter", () => {
    const text = output(fixture());
    expect(text).toContain("headroom: verificato");
    expect(text).toContain("pxpipe: processo attivo");
    expect(text).toContain("upstream: non verificato");
    expect(text).toContain("Aggiornati 0s fa");
    expect(text).toContain("1 in corso");
    expect(text).toContain("0.00 req/s");
    expect(text).toContain("Dall'avvio dei contatori");
    expect(text).toContain("Token risparmiati 0.8%");
    expect(text).toContain("Richieste cached 91.7%");
    expect(text).toContain("Durata media 22.8 s");
    expect(text).not.toContain("http://");
    expect(text).not.toContain("Token in/s");
  });

  it("toggles addresses, metric definitions and rate sampling details with d", () => {
    const d = fixture();
    d.onKey("d");
    const text = output(d);
    expect(d.showPipelineDetails).toBe(true);
    expect(text).toContain("http://localhost:8788 v0.37.0");
    expect(text).toContain("pxpipe: health non verificato");
    expect(text).toContain("Token in/s 0.0");
    expect(text).toContain("ultimo intervallo di 1.0 s");
    expect(text).toContain("saved / (input + saved)");
    expect(text).toContain("cached / richieste totali");
    expect(text).toContain("Cache richieste != risparmio economico");
    d.chain[1].detail += " | inoltro: http://127.0.0.1:9999 (destinazione non verificata)";
    expect(output(d, now, 80).replace(/\s+/g, " ")).toContain("(destinazione non verificata)");
    d.onKey("d");
    expect(output(d)).not.toContain("http://");
  });

  it("marks old totals as historical and suppresses old live gauges, rates and health", () => {
    const d = fixture();
    d.onKey("d");
    const text = output(d, now + 6000);
    expect(text).toContain("Dati non aggiornati: ultimo campione 6s fa");
    expect(text).toContain("Dall'avvio dei contatori (ultimo campione)");
    expect(text).toContain("Token risparmiati 0.8%");
    expect(text).toContain("attivita non disponibile");
    expect(text).toContain("headroom: non verificato");
    expect(text).not.toContain("1 in corso");
    expect(text).not.toContain("req/s");
    expect(text).not.toContain("Token in/s");
    expect(text).not.toContain("headroom: verificato");
  });

  it("does not invent zeroes without samples, denominators or a second rate sample", () => {
    const empty = output(new Dashboard());
    expect(empty).toContain("nessun campione");
    expect(empty).not.toContain("0.0");
    const d = fixture();
    d.metrics = { headroom_requests_total: 0, headroom_latency_ms_sum: 420, headroom_latency_ms_count: 1 };
    d.rates = {};
    d.sampleMs = null;
    d.onKey("d");
    const text = output(d);
    expect(text).toContain("Token risparmiati -");
    expect(text).toContain("Richieste cached -");
    expect(text).toContain("Durata media 420 ms");
    expect(text).toContain("- req/s");
    expect(text).toContain("in attesa del secondo campione");
    expect(text).not.toMatch(/NaN|Infinity/);
  });

  it("wraps pipeline fields and keeps controls visible in small terminals", () => {
    const d = fixture();
    for (const width of [40, 80, 100]) {
      const lines = d.pipelineLines(width, now).map(stripAnsi);
      expect(lines.every(line => line.length <= width)).toBe(true);
      expect(lines.join("\n")).toContain("Token risparmiati 0.8%");
      expect(lines.join("\n")).toContain("Richieste cached 91.7%");
      expect(lines.join("\n")).toContain("upstream: non verificato");
    }
    const { columns, rows } = process.stdout;
    try {
      process.stdout.columns = 40;
      process.stdout.rows = 24;
      d.statuses = ["pxpipe", "ocx", "agentmemory", "headroom"].map(id => ({
        id, status: "running", dashboardUrl: "http://localhost:47822",
      }));
      d.onKey("d");
      const lines = d.buildLines().map(stripAnsi);
      expect(lines.length).toBe(24);
      expect(lines.every(line => line.length <= 40)).toBe(true);
      const footer = lines.slice(-5).join("\n");
      expect(footer).toContain("d riduci");
      expect(footer).toContain("q esci");
      expect(footer).toContain("k kill");
      expect(footer).toContain("o dashboard");
      expect(lines[23]).toBe("pronto");
      expect(lines.join("\n")).toContain("aumenta l'altezza");
    } finally {
      process.stdout.columns = columns;
      process.stdout.rows = rows;
    }
  });

  it("handles fetch failure, invalid payload, recovery and service restart without false live rates", async () => {
    let status = 200;
    let payload = { ...metrics };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/health") return Response.json({ status: "healthy" });
        return new Response(typeof payload === "string" ? payload
          : Object.entries(payload).map(([name, value]) => `${name} ${value}`).join("\n"), { status });
      },
    });
    const service = { id: "headroom", status: "running", pid: 1, url: server.url.origin };
    const getStatus = spyOn(manager, "getStatus").mockImplementation(async () => [service]);
    const d = new Dashboard({ getVersions: async () => ({}) });
    try {
      await d.refresh();
      expect(d.rates.headroom_requests_total).toBeNull();
      d.prevAt -= 1000;
      payload.headroom_requests_total += 1;
      await d.refresh();
      expect(d.rates.headroom_requests_total).toBeGreaterThan(0);
      const savedAt = d.metricsAt;
      const lastGood = d.metrics;

      status = 503;
      await d.refresh();
      expect(d.metricsAt).toBe(savedAt);
      expect(d.metrics).toBe(lastGood);
      expect(d.rates).toEqual({});
      expect(d.prevMetrics).toBeNull();
      expect(output(d, Date.now())).toContain("raccolta fallita");
      expect(output(d, Date.now())).not.toContain("1 in corso");

      status = 200;
      await d.refresh();
      expect(d.metricsError).toBeNull();
      expect(d.rates.headroom_requests_total).toBeNull();
      expect(output(d, Date.now())).toContain("1 in corso");

      service.pid = 2;
      payload.headroom_requests_total += 100;
      await d.refresh();
      expect(d.rates.headroom_requests_total).toBeNull();

      payload = "# HELP no usable metrics\nprocess_cpu_seconds_total 1";
      await d.refresh();
      expect(d.metricsError).toBe("risposta senza metriche Headroom");
      expect(d.rates).toEqual({});

      service.status = "stopped";
      await d.refresh();
      expect(d.metricsError).toBe("Headroom non in esecuzione");
      expect(output(d, Date.now())).toContain("headroom: fermo");

      getStatus.mockRejectedValue(new Error("status failed"));
      await d.refresh();
      expect(d.refreshing).toBe(false);
      expect(d.metricsError).toBe("aggiornamento fallito");
      expect(d.chainAt).toBeNull();
    } finally {
      getStatus.mockRestore();
      server.stop(true);
    }
  });
});
