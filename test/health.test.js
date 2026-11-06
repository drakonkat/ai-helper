import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HEALTH_CHECKS, PROXY_HEALTH_PATH, hasHealthCheck, probeHttpHealth, probeServiceHealth } from "../src/health.js";
import { startProxy } from "../src/proxy.js";

const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("each service is probed on its own endpoint and identified before it counts as healthy", async () => {
  const seen = [];
  const fetchImpl = async url => { seen.push(url); return json({ service: "opencodex", status: "ok", version: "2.97.0", uptime: 12 })(); };
  const ocx = await probeHttpHealth("ocx", "http://localhost:10100/dashboard", { fetchImpl });
  assert.deepEqual({ ...ocx, checkedAt: 0 }, { state: "healthy", httpStatus: 200, status: "ok", version: "2.97.0",
    uptimeSeconds: 12, url: "http://localhost:10100/healthz", checkedAt: 0 });
  assert.deepEqual(seen, ["http://localhost:10100/healthz"]);

  const headroom = await probeHttpHealth("headroom", "http://localhost:8787/dashboard", {
    fetchImpl: json({ service: "headroom-proxy", status: "healthy", version: "0.43.1", uptime_seconds: 5 }) });
  assert.equal(headroom.state, "healthy");
  assert.equal(headroom.url, "http://localhost:8787/health");
  assert.equal((await probeHttpHealth("headroom", "http://x:1", { fetchImpl: json({ service: "headroom-proxy", status: "unhealthy" }, 503) })).state, "degraded");

  // Another service on the port (or an older proxy forwarding the path) is not proof of health.
  const foreign = await probeHttpHealth("ocx", "http://localhost:10100", { fetchImpl: json({ service: "other", status: "ok" }) });
  assert.equal(foreign.state, "unverified");
  const oldProxy = await probeHttpHealth("proxy", "http://127.0.0.1:10102", { fetchImpl: async () => new Response("<html>", { status: 200 }) });
  assert.equal(oldProxy.state, "unverified");
  assert.match(oldProxy.error, /restart the proxy/);

  const down = await probeHttpHealth("ocx", "http://localhost:10100", { fetchImpl: async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }); } });
  assert.deepEqual([down.state, down.error], ["unreachable", "ECONNREFUSED"]);

  assert.ok(["ocx", "headroom", "proxy", "pxpipe"].every(id => hasHealthCheck({ id })));
  assert.ok(hasHealthCheck({ id: "hindsight", runtime: "docker" }));
  assert.equal(hasHealthCheck({ id: "custom" }), false);
  assert.equal((await probeServiceHealth({ id: "hindsight", runtime: "docker", apiUrl: "http://127.0.0.1:8888" },
    { fetchImpl: json({ status: "healthy", database: "connected" }) })).state, "healthy");
  assert.equal(HEALTH_CHECKS.proxy.path, PROXY_HEALTH_PATH);
});

test("the proxy answers its health path itself and forwards everything else", async t => {
  const forwarded = [];
  const upstream = http.createServer((req, res) => { forwarded.push(req.url); res.end("upstream"); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const stats = [];
  const proxy = await startProxy({ upstream: "http://127.0.0.1:" + upstream.address().port, listen: "http://127.0.0.1:0", onStats: e => stats.push(e) });
  t.after(() => proxy.close());
  const health = await probeHttpHealth("proxy", proxy.url);
  assert.equal(health.state, "healthy");
  assert.equal(health.status, "ok");
  assert.ok(health.uptimeSeconds >= 0);
  const head = await fetch(new URL(PROXY_HEALTH_PATH, proxy.url), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await (await fetch(new URL("/__aih/health?x=1", proxy.url))).text(), "upstream");
  assert.equal(await (await fetch(new URL("/v1/models", proxy.url))).text(), "upstream");
  assert.deepEqual(forwarded, ["/__aih/health?x=1", "/v1/models"]);
  assert.equal(stats.length, 0);
});
