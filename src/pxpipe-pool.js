import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

export function createPxpipePool(maxBodyBytes = 64 * 1024 * 1024, workerUrl = new URL("./pxpipe-thread.js", import.meta.url)) {
  // The standalone CLI embeds a separate bundle: runtime relative files do not exist there.
  if (typeof AIH_PXPIPE_THREAD_SOURCE !== "undefined") workerUrl = new URL(`data:text/javascript,${encodeURIComponent(AIH_PXPIPE_THREAD_SOURCE)}`);
  const slots = Array.from({ length: 2 }, () => ({ worker: null, ready: false, job: null, queue: [] }));
  let closed = false, sequence = 0, queuedBytes = 0;
  const pendingTerminations = new Set();
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
    queuedBytes -= job.bytes;
    slot.job = job;
    job.queueMs = performance.now() - job.queuedAt;
    slot.worker.ref();
    try { slot.worker.postMessage({ ...job.input, id: job.id }); }
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
      worker.unref();
      if (result.error) settle(job, new Error(result.error));
      else settle(job, null, { ...result, timings: { ...result.timings, pxpipeQueueMs: job.queueMs } });
      dispatch(slot);
    });
    worker.on("error", error => { if (slot.worker === worker) fail(slot, error); });
    worker.on("exit", code => { if (slot.worker === worker) fail(slot, new Error(`pxpipe worker exited (${code})`)); });
  }
  return {
    run(input, { sessionId, signal } = {}) {
      if (closed) return Promise.reject(new Error("pxpipe pool is closed"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (slots.reduce((n, slot) => n + slot.queue.length, 0) >= 32 || queuedBytes + input.body.byteLength > maxBodyBytes)
        return Promise.reject(Object.assign(new Error("pxpipe queue is full"), { statusCode: 503 }));
      // ponytail: fixed session affinity preserves caches; two busy sessions can share a lane.
      let hash = 0;
      for (const char of sessionId || "") hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
      const slot = sessionId ? slots[hash % slots.length]
        : slots.reduce((best, current) => current.queue.length + Boolean(current.job) < best.queue.length + Boolean(best.job) ? current : best);
      return new Promise((resolve, reject) => {
        const job = { id: ++sequence, input, resolve, reject, signal, bytes: input.body.byteLength, queuedAt: performance.now() };
        job.abort = () => {
          if (slot.job === job) { slot.job = null; terminate(slot); }
          else { const index = slot.queue.indexOf(job); if (index < 0) return; slot.queue.splice(index, 1); queuedBytes -= job.bytes; }
          settle(job, signal.reason);
          dispatch(slot);
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
