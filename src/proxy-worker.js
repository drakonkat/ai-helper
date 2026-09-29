import { startProxy } from "./proxy.js";
import { createProxyStatsRecorder } from "./proxy-stats.js";

try {
  const options = JSON.parse(process.env.AIH_PROXY_OPTIONS || "{}");
  delete process.env.AIH_PROXY_OPTIONS;
  const proxy = await startProxy({ ...options, onStats: createProxyStatsRecorder() });
  console.log(`[aih proxy] Listening on ${proxy.url} -> ${options.upstream}`);
  process.send?.({ url: proxy.url });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    proxy.close().then(() => process.exit(0), () => process.exit(1));
  });
} catch (error) {
  console.error(`[aih proxy] ${error.message}`);
  if (process.send) process.send({ error: error.message }, () => process.exit(1));
  else process.exit(1);
}
