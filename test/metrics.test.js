import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseProm,
  diffRates,
  tailJsonl,
  baseUrl,
  probeChain,
  readSavingsBreakdown,
} from "../src/utils/metrics.js";
import { Dashboard, splitKeys } from "../src/tui.js";
import { resolveAgentmemoryViewerPort } from "../src/utils/process.js";

const SAMPLE = [
  "# HELP headroom_requests_total Total number of requests",
  "# TYPE headroom_requests_total counter",
  "headroom_requests_total 104",
  "headroom_tokens_saved_total 61368",
  "headroom_latency_ms_sum 884088.51",
  'headroom_requests_by_model{model="claude-opus-5"} 104',
  "",
  "garbage-without-value",
].join("\n");

describe("parseProm", () => {
  it("reads plain counters and skips comments, labels and blanks", () => {
    const parsed = parseProm(SAMPLE);
    expect(parsed.headroom_requests_total).toBe(104);
    expect(parsed.headroom_tokens_saved_total).toBe(61368);
    expect(parsed.headroom_latency_ms_sum).toBeCloseTo(884088.51, 2);
    expect(parsed.headroom_requests_by_model).toBeUndefined();
    expect(Object.keys(parsed).length).toBe(3);
  });

  it("returns an empty map for junk input", () => {
    expect(parseProm("")).toEqual({});
    expect(parseProm(null)).toEqual({});
  });
});

describe("diffRates", () => {
  it("computes per-second rates from cumulative counters", () => {
    const rates = diffRates({ a: 10 }, { a: 20 }, 2000);
    expect(rates.a).toBe(5);
  });

  it("returns null on the first sample, with no fake zeroes", () => {
    const rates = diffRates(null, { a: 20 }, 1000);
    expect(rates.a).toBeNull();
  });

  it("returns null when a counter resets after a service restart", () => {
    const rates = diffRates({ a: 500 }, { a: 3 }, 1000);
    expect(rates.a).toBeNull();
  });

  it("returns null for a metric that has just appeared", () => {
    const rates = diffRates({ a: 1 }, { a: 2, b: 9 }, 1000);
    expect(rates.b).toBeNull();
  });
});

describe("tailJsonl", () => {
  it("reads only new whole lines and never replays them", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-tail-"));
    const file = join(dir, "events.jsonl");
    writeFileSync(file, '{"saved":1}\n{"saved":2}\n', "utf-8");

    const first = tailJsonl(file);
    expect(first.events.length).toBe(2);

    const second = tailJsonl(file, first.offset);
    expect(second.events.length).toBe(0);
    expect(second.offset).toBe(first.offset);

    appendFileSync(file, '{"saved":3}\n', "utf-8");
    const third = tailJsonl(file, second.offset);
    expect(third.events.length).toBe(1);
    expect(third.events[0].saved).toBe(3);
  });

  it("keeps a partial trailing line for the next tick", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-tail-"));
    const file = join(dir, "events.jsonl");
    writeFileSync(file, '{"saved":1}\n{"saved":2', "utf-8");

    const first = tailJsonl(file);
    expect(first.events.length).toBe(1);

    appendFileSync(file, '}\n', "utf-8");
    const second = tailJsonl(file, first.offset);
    expect(second.events.length).toBe(1);
    expect(second.events[0].saved).toBe(2);
  });

  it("skips malformed lines instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-tail-"));
    const file = join(dir, "events.jsonl");
    writeFileSync(file, 'not json\n{"saved":7}\n', "utf-8");
    expect(tailJsonl(file).events).toEqual([{ saved: 7 }]);
  });

  it("returns an empty result for a missing file", () => {
    expect(tailJsonl(join(tmpdir(), "aih-does-not-exist.jsonl"))).toEqual({ events: [], offset: 0 });
  });
});

describe("probeChain", () => {
  it("builds the static chain when headroom does not answer", async () => {
    const { nodes, health } = await probeChain([
      { id: "headroom", status: "stopped", url: "http://127.0.0.1:9/dashboard" },
      { id: "pxpipe", status: "running", url: "http://127.0.0.1:47821" },
    ]);
    expect(nodes.map(n => n.id)).toEqual(["client", "headroom", "pxpipe", "upstream"]);
    expect(nodes[1].state).toBe("stopped");
    expect(nodes[2].state).toBe("running");
    expect(health).toBeNull();
  });
});

describe("baseUrl", () => {
  it("strips the path from a dashboard URL", () => {
    expect(baseUrl("http://localhost:8787/dashboard")).toBe("http://localhost:8787");
    expect(baseUrl("-")).toBe("");
    expect(baseUrl(undefined)).toBe("");
  });
});

describe("splitKeys", () => {
  it("keeps arrow escape sequences whole", () => {
    expect(splitKeys("\x1b[A")).toEqual(["\x1b[A"]);
    expect(splitKeys("\x1b[Bs")).toEqual(["\x1b[B", "s"]);
    expect(splitKeys("qx")).toEqual(["q", "x"]);
  });
});

describe("proxy visibility", () => {
  it("shows preset savings and wiring without offering a proxy dashboard", async () => {
    const dashboard = new Dashboard();
    dashboard.statuses = [{ id: "proxy", status: "running", url: "http://127.0.0.1:10102", dashboardUrl: null,
      proxyOptions: { preset: "rtk-pxpipe", upstream: "http://127.0.0.1:10100" } }];
    dashboard.proxyStats = { requests: 2, changed: 1, errors: 0, estimatedSavedTokens: 120,
      stages: { rtk: { saved: 20, applied: 1, requests: 2 }, pxpipe: { saved: 100, applied: 1, requests: 2 } }, recent: [] };
    let opened = false;
    dashboard.runAction = () => { opened = true; };
    dashboard.onKey("o");
    expect(opened).toBe(false);
    const screen = dashboard.buildLines().join("\n");
    expect(screen).toContain("risparmio stimato 120");
    expect(screen).toContain("rtk: 20");
    expect(screen).toContain("pxpipe: 100");
    expect(screen).not.toContain("o\x1b[0m dashboard");
    expect(screen).not.toContain("\x1b[4mhttp://127.0.0.1:10102");
    const chain = await probeChain(dashboard.statuses);
    expect(chain.nodes.map(n => n.id)).toEqual(["client", "proxy", "rtk", "pxpipe", "upstream"]);
    expect(chain.nodes[3].label).toBe("pxpipe (libreria)");
  });
});

describe("readSavingsBreakdown", () => {
  const write = (name, contents) => {
    const dir = mkdtempSync(join(tmpdir(), "aih-savings-"));
    const file = join(dir, name);
    writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf-8");
    return file;
  };

  it("splits the savings into compression and provider cache reuse", () => {
    const file = write("state.json", {
      contribution: {
        tokens_submitted: 90,
        raw_without_headroom: 100,
        tokens_saved: { compression: 4, cache_reads: 6, total: 10 },
      },
    });

    expect(readSavingsBreakdown(file)).toEqual({
      submitted: 90,
      compression: 4,
      cacheReads: 6,
      total: 10,
      ratio: 0.1,
    });
  });

  it("derives the total when the file omits it", () => {
    const file = write("state.json", {
      contribution: { tokens_submitted: 100, tokens_saved: { compression: 10, cache_reads: 30 } },
    });

    expect(readSavingsBreakdown(file).total).toBe(40);
  });

  it("returns a null ratio instead of dividing by zero on a fresh install", () => {
    const file = write("state.json", {
      contribution: { tokens_submitted: 0, tokens_saved: { compression: 0, cache_reads: 0, total: 0 } },
    });

    expect(readSavingsBreakdown(file).ratio).toBeNull();
  });

  it("returns null for a missing, malformed, or unrelated file", () => {
    expect(readSavingsBreakdown(join(tmpdir(), "aih-does-not-exist.json"))).toBeNull();
    expect(readSavingsBreakdown(write("bad.json", "not json{"))).toBeNull();
    expect(readSavingsBreakdown(write("other.json", { pid: 1 }))).toBeNull();
  });
});

describe("resolveAgentmemoryViewerPort", () => {
  it("picks the viewer, not the engine port that is bound on every interface", () => {
    expect(resolveAgentmemoryViewerPort([49134, 3111, 3112])).toBe(3113);
  });

  it("recovers the viewer from the engine port alone", () => {
    expect(resolveAgentmemoryViewerPort([49134])).toBe(3113);
    expect(resolveAgentmemoryViewerPort([50023])).toBe(4002);
  });

  it("follows a relocated instance instead of assuming the default", () => {
    expect(resolveAgentmemoryViewerPort([4000, 4001, 50023])).toBe(4002);
  });

  it("derives the viewer from the REST anchor when the engine is not visible", () => {
    expect(resolveAgentmemoryViewerPort([3111])).toBe(3113);
  });

  it("falls back to the default when no port is visible", () => {
    expect(resolveAgentmemoryViewerPort([])).toBe(3113);
    expect(resolveAgentmemoryViewerPort(undefined)).toBe(3113);
  });
});
