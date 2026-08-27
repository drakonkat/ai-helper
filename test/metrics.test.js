import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseProm, diffRates, tailJsonl, baseUrl, probeChain } from "../src/utils/metrics.js";
import { splitKeys } from "../src/tui.js";

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
