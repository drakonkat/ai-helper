import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createPxpipePool } from "../src/pxpipe-pool.js";
import { createPresetHooks } from "../src/proxy-presets.js";
import { patchPxpipeSource, patchPxpipeHistorySource } from "../scripts/patch-pxpipe.js";
import { transformOpenAIResponses } from "pxpipe-proxy";

async function poolFixture(t, limit = 1024, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "aih-pxpipe-"));
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  const file = join(dir, "worker.mjs");
  await writeFile(file, `import { parentPort, threadId } from 'node:worker_threads';
    import { performance } from 'node:perf_hooks';
    parentPort.on('message', ({id, duration = 0, crash = false}) => {
      if (crash) process.exit(1);
      const start = performance.now(); while (performance.now() - start < duration) {}
      parentPort.postMessage({id, stage: {worker: threadId}, timings: {pxpipeMs: performance.now() - start}});
    }); parentPort.postMessage({ready: true});`);
  const pool = createPxpipePool(limit, pathToFileURL(file), options);
  t.after(async () => { await pool.close(); await rm(dir, { recursive: true, force: true }); });
  await Promise.all([pool.run({body: new Uint8Array(1)}, {sessionId: "A"}), pool.run({body: new Uint8Array(1)}, {sessionId: "B"})]);
  return pool;
}

test("CPU workers leave excluded models and the main event loop responsive", { timeout: 10000 }, async t => {
  const pool = await poolFixture(t);
  let completed = false, ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  t.after(() => clearInterval(timer));
  const jobs = Promise.all([pool.run({body: new Uint8Array(1), duration: 400}, {sessionId: "A"}),
    pool.run({body: new Uint8Array(1), duration: 400}, {sessionId: "B"})]).then(result => { completed = true; return result; });
  const events = [];
  const hooks = await createPresetHooks({preset: "pxpipe", models: "gpt-6-astra", maxBodyBytes: 1024}, event => events.push(event));
  t.after(() => hooks.close());
  const raw = Buffer.from(JSON.stringify({model: "gpt-6.1-sol", input: "hello"}));
  const context = {method: "POST", path: "/v1/responses", headers: {"content-type": "application/json"}, body: raw};
  await hooks.onRequest(context);
  await delay(30);
  assert.equal(completed, false, "Excluded traffic must finish before busy workers");
  assert.ok(ticks > 0, "CPU jobs must not block main-thread timers");
  assert.strictEqual(context.body, raw);
  assert.equal(events[0].stages[0].reason, "model_excluded");
  assert.equal(events[0].timings.pxpipeQueueMs, undefined);
  await jobs;
});

test("bounded queue, active/queued cancellation, crash recovery and close settle every job", { timeout: 10000 }, async t => {
  const pool = await poolFixture(t, 16, { maxQueuedPerLane: 2, maxQueuedBytes: 16 });
  const active = new AbortController(), queued = new AbortController();
  const first = pool.run({body: new Uint8Array(8), duration: 300}, {sessionId: "A", signal: active.signal});
  const second = pool.run({body: new Uint8Array(8)}, {sessionId: "A", signal: queued.signal});
  const third = pool.run({body: new Uint8Array(8)}, {sessionId: "A"});
  const settled = Promise.allSettled([first, second, third]);
  await assert.rejects(pool.run({body: new Uint8Array(1)}, {sessionId: "A"}), {code: "PXPIPE_BUSY", reason: "queue_full"});
  queued.abort(); active.abort();
  const results = await settled;
  assert.equal(results[0].reason.name, "AbortError");
  assert.equal(results[1].reason.name, "AbortError");
  assert.equal(results[2].status, "fulfilled");
  await assert.rejects(pool.run({body: new Uint8Array(1), crash: true}, {sessionId: "A"}), /exited/);
  await pool.run({body: new Uint8Array(1)}, {sessionId: "A"});
  const shutdown = pool.run({body: new Uint8Array(1), duration: 5000}, {sessionId: "B"});
  const rejected = assert.rejects(shutdown, /closed/);
  await Promise.all([pool.close(), pool.close(), rejected]);
  await assert.rejects(pool.run({body: new Uint8Array(1)}), /closed/);
});

test("aborting the active job keeps its warm worker; a watchdog replaces a stuck one", { timeout: 10000 }, async t => {
  const pool = await poolFixture(t, 1024, { abandonedJobMs: 300 });
  const { worker } = (await pool.run({body: new Uint8Array(1)}, {threadId: "A"})).stage;
  const active = new AbortController();
  const abandoned = pool.run({body: new Uint8Array(1), duration: 100}, {threadId: "A", signal: active.signal});
  active.abort();
  await assert.rejects(abandoned, {name: "AbortError"});
  assert.equal((await pool.run({body: new Uint8Array(1)}, {threadId: "A"})).stage.worker, worker, "Abort must not restart the worker");
  const stuck = new AbortController();
  const hung = pool.run({body: new Uint8Array(1), duration: 5000}, {threadId: "A", signal: stuck.signal});
  stuck.abort();
  await assert.rejects(hung, {name: "AbortError"});
  const started = performance.now();
  assert.notEqual((await pool.run({body: new Uint8Array(1)}, {threadId: "A"})).stage.worker, worker);
  assert.ok(performance.now() - started < 3000, "The watchdog must not wait for the abandoned job");
});

test("queue wait is bounded and forked threads do not queue behind their parent", { timeout: 10000 }, async t => {
  // The wait limit also covers cold worker startup in the fixture.
  const pool = await poolFixture(t, 1024, { maxQueueWaitMs: 1000 });
  const parent = pool.run({body: new Uint8Array(1), duration: 2000}, {threadId: "A", sessionId: "A"});
  await assert.rejects(pool.run({body: new Uint8Array(1)}, {threadId: "A", sessionId: "A"}), {code: "PXPIPE_BUSY", reason: "queue_timeout"});
  const fork = await pool.run({body: new Uint8Array(1)}, {threadId: "fork", sessionId: "A"});
  assert.notEqual(fork.stage.worker, (await parent).stage.worker);
});

test("a saturated pxpipe lane forwards requests unchanged instead of failing them", { timeout: 15000 }, async t => {
  const events = [];
  const hooks = await createPresetHooks({preset: "pxpipe", models: "gpt-6-astra", maxBodyBytes: 1024 * 1024}, event => events.push(event));
  t.after(() => hooks.close());
  const headers = {"content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({session_id: "S", thread_id: "T"})};
  const request = body => ({method: "POST", path: "/v1/responses", headers: {...headers}, body: Buffer.from(JSON.stringify(body))});
  // A non-leading model is parsed and rejected by the pool; a leading one is skipped before parsing.
  const queued = Array.from({length: 5}, () => request({input: "hello", model: "gpt-6-astra"}));
  const leading = request({model: "gpt-6-astra", input: "hello"});
  const contexts = [...queued, leading];
  const raws = contexts.map(context => context.body);
  await Promise.all(contexts.map(context => hooks.onRequest(context)));
  assert.equal(events.filter(event => event.error).length, 0);
  assert.equal(events.filter(event => event.stages[0].reason === "queue_full").length, 2);
  assert.strictEqual(queued[4].body, raws[4]);
  assert.strictEqual(leading.body, raws[5]);
  assert.equal(events.find(event => event.stages[0].reason === "queue_full").threadId, "T");
});

test("diagnostic patch is version-guarded, idempotent and preserves transformed bytes", { timeout: 10000 }, async t => {
  const entry = fileURLToPath(import.meta.resolve("pxpipe-proxy"));
  const file = new URL("openai.js", pathToFileURL(entry));
  const patched = await readFile(file, "utf8");
  assert.equal(patchPxpipeSource(patched, "0.14.0"), patched);
  assert.throws(() => patchPxpipeSource(patched, "0.15.0"), /Review/);
  assert.throws(() => patchPxpipeSource("changed", "0.14.0"), /target changed/);
  // Load the unpatched transformer beside its existing relative imports; no dependency copy.
  const baseline = new URL(`aih-baseline-${process.pid}.js`, file);
  await writeFile(baseline, patched.replace(/\/\/ aih: partial diagnostics[\s\S]*?info\.responsesComposition\.partial = diagnosticJson !== diagnosticOriginal;/,
    "info.responsesComposition = measureResponsesComposition(req, inputWasString, originalInputString, inputItems);"));
  t.after(() => unlink(baseline));
  const original = await import(baseline.href);
  const body = {model: "gpt-6-astra", instructions: "Preserve source identifiers and error checks. ".repeat(600), input: [
    {role: "user", content: "Inspect the code"},
    {type: "reasoning", encrypted_content: "A".repeat(8192), summary: []},
    {type: "compaction", id: "cmp", content: "B".repeat(8192)},
    {type: "function_call", call_id: "img", name: "inspect", arguments: "{}"},
    {type: "function_call_output", call_id: "img", output: [{type: "input_text", text: "result"},
      {type: "input_image", image_url: "data:image/png;base64," + "C".repeat(8192)}]},
    {type: "function_call", call_id: "json", name: "inspect", arguments: "{}"},
    {type: "function_call_output", call_id: "json", output: JSON.stringify([{type: "input_image", image_url: "data:image/png;base64," + "D".repeat(8192)}])},
  ]};
  const raw = Buffer.from(JSON.stringify(body));
  const before = await original.transformOpenAIResponses(raw, {model: body.model});
  const after = await transformOpenAIResponses(raw, {model: body.model});
  assert.equal(after.info.compressed, true);
  assert.deepEqual(Buffer.from(after.body), Buffer.from(before.body));
  assert.deepEqual(JSON.parse(raw), body, "Diagnostics must never mutate input");
  assert.equal(after.info.responsesComposition.partial, true);
  assert.ok(after.info.responsesComposition.excludedBytes > 24000);
  const plain = await transformOpenAIResponses(Buffer.from(JSON.stringify({model: body.model, input: "hello"})), {model: body.model});
  assert.equal(plain.info.responsesComposition.partial, false);
});

test("256 KiB opaque stress transforms in a worker and retains the encrypted value", { timeout: 10000 }, async t => {
  const events = [];
  const hooks = await createPresetHooks({preset: "pxpipe", models: "gpt-6-astra", maxBodyBytes: 1024 * 1024}, event => events.push(event));
  t.after(() => hooks.close());
  const opaque = "A".repeat(262144);
  const body = {model: "gpt-6-astra", instructions: "Preserve errors and source identifiers. ".repeat(600),
    input: [{role: "user", content: "Inspect"}, {type: "reasoning", encrypted_content: opaque}]};
  const context = {method: "POST", path: "/v1/responses", headers: {"content-type": "application/json"}, body: Buffer.from(JSON.stringify(body))};
  await hooks.onRequest(context);
  assert.equal(JSON.parse(context.body).input.find(item => item.type === "reasoning").encrypted_content, opaque);
  assert.equal(events[0].stages[0].diagnostics.partial, true);
  assert.ok(events[0].stages[0].diagnostics.excludedBytes >= opaque.length);
  assert.ok(events[0].timings.pxpipeMs >= 0);
  assert.ok(events[0].timings.pxpipeQueueMs >= 0);
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(hooks.onRequest({ ...context, signal: cancellation.signal }), {name: "AbortError"});
  assert.equal(events.at(-1).error, false, "Client cancellation is not a preset failure");
});

test("history treats media tool rounds as native barriers without tokenizing their payloads", { timeout: 10000 }, async () => {
  const entry = pathToFileURL(fileURLToPath(import.meta.resolve("pxpipe-proxy")));
  const file = new URL("openai-history.js", entry);
  const source = await readFile(file, "utf8");
  assert.equal(patchPxpipeHistorySource(source, "0.14.0"), source);
  assert.throws(() => patchPxpipeHistorySource(source, "0.15.0"), /Review/);
  assert.throws(() => patchPxpipeHistorySource("changed", "0.14.0"), /target changed/);
  const { planResponsesPairCollapse } = await import(file.href);
  const media = {type: "input_image", image_url: "data:image/png;base64," + "A".repeat(262144)};
  const outputs = [[{type: "input_text", text: "screenshot"}, media], JSON.stringify(media),
    JSON.stringify({content: [media]}), [{type: "input_audio", input_audio: {data: "B".repeat(262144)}}]];
  for (const output of outputs) {
    // A parallel round is atomic: even its textual sibling must stay native.
    const items = [
      {type: "function_call", call_id: "image", name: "inspect", arguments: "{}"},
      {type: "function_call", call_id: "text", name: "read", arguments: "{}"},
      {type: "function_call_output", call_id: "image", output},
      {type: "function_call_output", call_id: "text", output: "Readable output. ".repeat(100)},
    ];
    const before = JSON.stringify(items);
    const plan = await planResponsesPairCollapse(items, () => true, {keepRecentPairs: 0, minCollapseTokens: 1});
    assert.deepEqual(plan.selectedIndices, []);
    assert.equal(plan.pairState.completedPairs, 2);
    assert.equal(plan.pairState.oldCompletedPairs, 2);
    assert.equal(plan.pairState.imageableFunctionOutputTokens, 0);
    assert.equal(plan.pairState.malformedItems, 0);
    assert.equal(JSON.stringify(items), before);
    const recent = await planResponsesPairCollapse(items, () => true, {keepRecentPairs: 2});
    assert.equal(recent.pairState.recentCompletedPairs, 2);
  }
  const textItems = [{type: "function_call", call_id: "plain", name: "read", arguments: "{}"},
    {type: "function_call_output", call_id: "plain", output: "Source identifiers and error checks. ".repeat(100)}];
  const textPlan = await planResponsesPairCollapse(textItems, () => true, {keepRecentPairs: 0, minCollapseTokens: 1, maxImages: 20});
  assert.deepEqual(textPlan.selectedIndices, [0, 1]);
  assert.ok(textPlan.pairState.collapsedFunctionOutputTokens > 0);
  const separated = [...textItems,
    {type: "function_call", call_id: "image", name: "inspect", arguments: "{}"},
    {type: "function_call_output", call_id: "image", output: [media]},
    ...textItems.map(item => ({...item, call_id: "after"}))];
  const barriers = await planResponsesPairCollapse(separated, () => true, {keepRecentPairs: 0, minCollapseTokens: 1, maxImages: 20});
  assert.deepEqual(barriers.selectedIndices, [0, 1, 4, 5]);
  assert.ok(barriers.segments.every(segment => segment.selectedIndices.every(index => index < 2)
    || segment.selectedIndices.every(index => index > 3)), "No rendered segment may cross native media");
});

test("serialized root media diagnostics stay partial and the worker preserves the output", { timeout: 10000 }, async t => {
  const hooks = await createPresetHooks({preset: "pxpipe", models: "gpt-6-astra", maxBodyBytes: 1024 * 1024}, () => {});
  t.after(() => hooks.close());
  const output = JSON.stringify({type: "input_image", image_url: "data:image/png;base64," + "A".repeat(262144)});
  const body = {model: "gpt-6-astra", instructions: "Preserve errors and source identifiers. ".repeat(600), input: [
    {role: "user", content: "Inspect"},
    {type: "function_call", call_id: "image", name: "inspect", arguments: "{}"},
    {type: "function_call_output", call_id: "image", output},
  ]};
  const raw = Buffer.from(JSON.stringify(body));
  const result = await transformOpenAIResponses(raw, {model: body.model});
  assert.ok(result.info.responsesComposition.excludedBytes >= 262144);
  assert.ok(result.info.responsesComposition.functionOutputs < 100);
  const context = {method: "POST", path: "/v1/responses", headers: {"content-type": "application/json"}, body: raw};
  await hooks.onRequest(context);
  assert.equal(JSON.parse(context.body).input.find(item => item.type === "function_call_output").output, output);
});
