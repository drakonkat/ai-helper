import { resolve } from "node:path";

// Embed a Node worker so the compiled CLI uses the same proxy transport as npm.
const root = resolve(import.meta.dir, "..");
const outfile = process.argv[2] || resolve(root, "dist", process.platform === "win32" ? "aih.exe" : "aih");
const worker = await Bun.build({
  entrypoints: [resolve(root, "src/proxy-worker.js")], target: "node", format: "esm", minify: true,
});
if (!worker.success) throw new AggregateError(worker.logs, "Proxy worker build failed");
const result = await Bun.build({
  entrypoints: [resolve(root, "src/index.js")], minify: true,
  compile: { outfile },
  define: { AIH_PROXY_WORKER_SOURCE: JSON.stringify(await worker.outputs[0].text()) },
});
if (!result.success) throw new AggregateError(result.logs, "CLI build failed");
console.log(`Built ${outfile} (proxy worker requires Node.js 20.19+ on PATH)`);
