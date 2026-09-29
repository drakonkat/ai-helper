import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { configureCodexForProxy, probeProxyListener, waitForOcxReady } from "../src/codex-routing.js";

function state() {
  return { services: {
    proxy: { status: "running", pid: 42, url: "http://127.0.0.1:12345", proxyOptions: { upstream: "http://127.0.0.1:10100/" } },
    ocx: { status: "running", pid: 43, url: "http://localhost:10100" },
  } };
}

function hooks(extra = {}) {
  return { env: {}, isRunning: () => true, probe: async () => true,
    waitReady: async () => ({ ready: true }), apply: url => ({ status: "updated", url }), ...extra };
}

test("only a live managed proxy may configure Codex; disabled mode does no work", async () => {
  const unexpected = () => { throw new Error("must not be called"); };
  for (const input of [{ services: {} }, { services: { proxy: { status: "running", pid: 42 } } },
    { services: { proxy: { ...state().services.proxy, status: "stopped" } } }]) {
    assert.equal((await configureCodexForProxy(input, hooks({ probe: unexpected, apply: unexpected }))).status, "skipped");
  }
  assert.equal((await configureCodexForProxy(state(), hooks({ isRunning: () => false }))).status, "skipped");
  assert.equal((await configureCodexForProxy(state(), hooks({ env: { AIH_CODEX_AUTOCONFIG: "0" }, probe: unexpected }))).status, "skipped");
});

test("prefixed upstreams require explicit client paths rather than silently doubling /v1", async () => {
  const input = state();
  input.services.proxy.proxyOptions.upstream = "http://127.0.0.1:10100/v1/";
  let wrote = false;
  const result = await configureCodexForProxy(input, hooks({ apply: () => { wrote = true; } }));
  assert.equal(result.status, "warning");
  assert.match(result.message, /path prefix/);
  assert.equal(wrote, false);
});

test("waits for ocx startup writes, then uses actual proxy listener rather than upstream/options port", async () => {
  const input = state();
  input.services.proxy.proxyOptions.listen = "http://127.0.0.1:0";
  const events = [];
  const result = await configureCodexForProxy(input, hooks({
    probe: async url => { events.push(["probe", url]); return true; },
    waitReady: async url => { events.push(["ready", url]); return { ready: true }; },
    apply: (url, options) => { events.push(["apply", url]); assert.deepEqual(options.env, {}); return { status: "updated", url }; },
  }));
  assert.deepEqual(events.map(e => e[0]), ["probe", "ready", "probe", "apply"]);
  assert.equal(result.url, input.services.proxy.url);
  assert.equal(events[1][1], input.services.ocx.url);
});

test("ocx start waits even with a different upstream; proxy-only start does not wait for unrelated ocx", async () => {
  const input = state();
  input.services.proxy.proxyOptions.upstream = "https://provider.example/";
  let waits = 0;
  const options = hooks({ waitReady: async () => { waits++; return { ready: true }; } });
  assert.equal((await configureCodexForProxy(input, options)).status, "updated");
  assert.equal(waits, 0);
  assert.equal((await configureCodexForProxy(input, { ...options, waitForOcx: true })).status, "updated");
  assert.equal(waits, 1);
});

test("unavailable listeners, failed readiness, concurrent restart and writer failures warn without writing", async () => {
  let writes = 0;
  const base = hooks({ apply: () => { writes++; return { status: "updated" }; } });
  const changed = state();
  changed.services.proxy.url = "http://127.0.0.1:12346";
  for (const extra of [
    { probe: async () => false },
    { waitReady: async () => ({ ready: false, reason: "not ready" }) },
    { readState: () => changed },
    { readState: () => ({ services: {} }) },
    { apply: () => { throw new Error("private file contents"); } },
  ]) {
    const result = await configureCodexForProxy(state(), { ...base, ...extra });
    assert.equal(result.status, "warning");
    assert.ok(!result.message.includes("private file contents"));
  }
  assert.equal(writes, 0);
});

test("rechecks state after the final asynchronous listener probe", async () => {
  const input = state();
  let latest = input;
  let probes = 0;
  let wrote = false;
  const result = await configureCodexForProxy(input, hooks({
    probe: async () => {
      if (++probes === 2) latest = { services: { proxy: { ...input.services.proxy, pid: 44, url: "http://127.0.0.1:12346" } } };
      return true;
    },
    readState: () => latest,
    apply: () => { wrote = true; return { status: "updated" }; },
  }));
  assert.equal(result.status, "warning");
  assert.equal(wrote, false);
});

test("does not race a replacement ocx's startup configuration writes", async () => {
  const input = state();
  let latest = input;
  let wrote = false;
  const result = await configureCodexForProxy(input, hooks({
    waitReady: async () => {
      latest = { services: { ...input.services, ocx: { ...input.services.ocx, pid: 44 } } };
      return { ready: true };
    },
    readState: () => latest,
    apply: () => { wrote = true; return { status: "updated" }; },
  }));
  assert.equal(result.status, "warning");
  assert.match(result.message, /ocx changed/);
  assert.equal(wrote, false);
});

async function server(t, handler) {
  const listener = http.createServer(handler);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise(resolve => { listener.closeAllConnections(); listener.close(resolve); }));
  return `http://127.0.0.1:${listener.address().port}`;
}

test("proxy liveness probe connects without forwarding an HTTP request", async t => {
  let requests = 0;
  const url = await server(t, (_req, res) => { requests++; res.end(); });
  assert.equal(await probeProxyListener(url), true);
  assert.equal(requests, 0);
  for (const invalid of ["http://127.0.0.1:0", "http://example.com", "https://localhost", "http://user:pass@localhost", "http://127.0.0.1/v1"]) {
    assert.equal(await probeProxyListener(invalid, 10), false);
  }
});

test("ocx readiness waits for ready, not merely a successful TCP/health check", async t => {
  let count = 0;
  const url = await server(t, (req, res) => {
    assert.equal(req.url, "/readyz");
    const ready = ++count >= 3;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "opencodex", status: ready ? "ready" : "pending" }));
  });
  assert.deepEqual(await waitForOcxReady(url, { intervalMs: 1, timeoutMs: 1000 }), { ready: true });
  assert.equal(count, 3);
});

test("ocx readiness rejects wrong identities, old versions, failures and bounded timeout", async t => {
  for (const [code, payload] of [
    [200, { service: "other", status: "ready" }],
    [404, { error: "not found" }],
    [503, { service: "opencodex", status: "failed" }],
    [503, { service: "opencodex", status: "pending" }],
    [503, { service: "opencodex", status: "ready", code: 200 }],
  ]) {
    const url = await server(t, (_req, res) => { res.writeHead(code); res.end(JSON.stringify(payload)); });
    assert.equal((await waitForOcxReady(url, { intervalMs: 1, timeoutMs: 35 })).ready, false);
  }
});
