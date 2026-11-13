import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

// Sized from field data: ~50 MB screenshot-heavy bodies take 20-40 s of worker CPU each.
export const PXPIPE_POOL_DEFAULTS = Object.freeze({
  lanes: 2, maxQueuedPerLane: 4, maxQueueWaitMs: 10000, abandonedJobMs: 120000, affinityEntries: 512,
});

/** Capacity rejection: callers forward the request without pxpipe instead of failing it. */
const busy = reason => Object.assign(new Error(reason === "queue_timeout" ? "pxpipe queue wait exceeded" : "pxpipe queue is full"),
  { code: "PXPIPE_BUSY", reason, statusCode: 503 });

export function createPxpipePool(maxBodyBytes = 64 * 1024 * 1024, workerUrl = new URL("./pxpipe-thread.js", import.meta.url), options = {}) {
  const { lanes, maxQueuedPerLane, maxQueueWaitMs, abandonedJobMs, affinityEntries } = { ...PXPIPE_POOL_DEFAULTS, ...options };
  // Memory guard only: waiting time is bounded by maxQueueWaitMs, not by the size of one request.
  const maxQueuedBytes = options.maxQueuedBytes ?? 4 * maxBodyBytes;
  // The standalone CLI embeds a separate bundle: runtime relative files do not exist there.
  if (typeof AIH_PXPIPE_THREAD_SOURCE !== "undefined") workerUrl = new URL(`data:text/javascript,${encodeURIComponent(AIH_PXPIPE_THREAD_SOURCE)}`);
  const slots = Array.from({ length: lanes }, () => ({ worker: null, ready: false, job: null, queue: [] }));
  const affinity = new Map();
  let closed = false, sequence = 0, queuedBytes = 0;
  const pendingTerminations = new Set();
  const load = slot => slot.queue.length + Boolean(slot.job);
  // Known threads keep their lane (warm caches). A new thread prefers its idle parent lane, else the least loaded.
  const pick = (key, parent) => {
    const known = key === undefined ? undefined : affinity.get(key);
    if (known) return known;
    const parentSlot = parent === undefined ? undefined : affinity.get(parent);
    return parentSlot && !load(parentSlot) ? parentSlot : slots.reduce((best, slot) => load(slot) < load(best) ? slot : best);
  };
  const remember = (key, slot) => {
    if (key === undefined) return;
    affinity.delete(key);
    affinity.set(key, slot);
    if (affinity.size > affinityEntries) affinity.delete(affinity.keys().next().value);
  };
  const full = (slot, bytes) => slot.queue.length >= maxQueuedPerLane || queuedBytes + bytes > maxQueuedBytes;
  const terminate = slot => {
    const worker = slot.worker;
    slot.worker = null;
    slot.ready = false;
    if (!worker) return;
    const termination = worker.terminate();
    pendingTerminations.add(termination);
    termination.then(() => pendingTerminations.delete(termination), () => pendingTerminations.delete(termination));
  };
  const settle = (job, error, result) => {
    clearTimeout(job.timer);
    if (job.settled) return; // abandoned jobs were already rejected
    job.settled = true;
    job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error); else job.resolve(result);
  };
  function dispatch(slot) {
    if (closed || slot.job || !slot.queue.length) return;
    if (!slot.worker) {
      try { start(slot); } catch (error) { fail(slot, error); return; }
    }
    if (!slot.ready) return;
    const job = slot.queue.shift();
    clearTimeout(job.timer);
    queuedBytes -= job.bytes;
    slot.job = job;
    job.queueMs = performance.now() - job.queuedAt;
    slot.worker.ref();
    const body = job.input.body;
    // Move a private copy instead of cloning it; a caller-owned buffer must stay readable.
    const transfer = job.transfer && body.byteOffset === 0 && body.byteLength === body.buffer.byteLength ? [body.buffer] : [];
    try { slot.worker.postMessage({ ...job.input, id: job.id }, transfer); }
    catch (error) { fail(slot, error); }
  }
  function fail(slot, error) {
    if (slot.job) settle(slot.job, error);
    slot.job = null;
    // A worker failing to initialize must reject its queue rather than restart endlessly.
    for (const job of slot.queue.splice(0)) { queuedBytes -= job.bytes; settle(job, error); }
    terminate(slot);
  }
  function start(slot) {
    const worker = slot.worker = new Worker(workerUrl, { execArgv: [] });
    worker.on("message", result => {
      if (slot.worker !== worker) return;
      if (result.ready) { slot.ready = true; if (!slot.queue.length) worker.unref(); dispatch(slot); return; }
      const job = slot.job;
      if (!job || result.id !== job.id) return fail(slot, new Error("Unexpected pxpipe worker response"));
      slot.job = null;
      clearTimeout(job.watchdog);
      worker.unref();
      if (result.error) settle(job, new Error(result.error));
      else settle(job, null, { ...result, timings: { ...result.timings, pxpipeQueueMs: job.queueMs } });
      dispatch(slot);
    });
    worker.on("error", error => { if (slot.worker === worker) fail(slot, error); });
    worker.on("exit", code => { if (slot.worker === worker) fail(slot, new Error(`pxpipe worker exited (${code})`)); });
  }
  return {
    /** True when run() would reject for capacity; lets callers skip parsing a body pxpipe cannot take. */
    full({ threadId, sessionId } = {}, bytes = 0) {
      return full(pick(threadId || sessionId, sessionId), bytes);
    },
    run(input, { threadId, sessionId, signal, transfer = false } = {}) {
      if (closed) return Promise.reject(new Error("pxpipe pool is closed"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      // Forked subagents share the parent's session_id: the thread is the affinity unit.
      const key = threadId || sessionId;
      const slot = pick(key, sessionId);
      if (full(slot, input.body.byteLength)) return Promise.reject(busy("queue_full"));
      remember(key, slot);
      return new Promise((resolve, reject) => {
        const job = { id: ++sequence, input, resolve, reject, signal, transfer, bytes: input.body.byteLength, queuedAt: performance.now() };
        job.timer = setTimeout(() => {
          const index = slot.queue.indexOf(job);
          if (index < 0) return;
          slot.queue.splice(index, 1);
          queuedBytes -= job.bytes;
          settle(job, busy("queue_timeout"));
        }, maxQueueWaitMs);
        job.timer.unref?.();
        job.abort = () => {
          if (slot.job === job) {
            // ponytail: the CPU transform cannot be interrupted; keep the warm worker and drop its result.
            // The watchdog still replaces a worker stuck on an abandoned job.
            job.watchdog = setTimeout(() => { if (slot.job === job) { slot.job = null; terminate(slot); dispatch(slot); } }, abandonedJobMs);
            job.watchdog.unref?.();
          } else {
            const index = slot.queue.indexOf(job);
            if (index < 0) return;
            slot.queue.splice(index, 1);
            queuedBytes -= job.bytes;
          }
          settle(job, signal.reason);
        };
        signal?.addEventListener("abort", job.abort, { once: true });
        slot.queue.push(job);
        queuedBytes += job.bytes;
        dispatch(slot);
      });
    },
    async close() {
      closed = true;
      for (const slot of slots) fail(slot, new Error("pxpipe pool is closed"));
      await Promise.allSettled([...pendingTerminations]);
    },
  };
}
