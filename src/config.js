import { homedir } from "node:os";
import { join } from "node:path";
// Node 18 uses assert; newer Node uses with. Bun embeds this JSON when compiling.
const { default: packageInfo } = await import("../package.json", {
  with: { type: "json" }, assert: { type: "json" },
});

/**
 * Pre-configured AI ecosystem services managed by aih
 */
export const SERVICES = {
  pxpipe: {
    id: "pxpipe",
    name: "pxpipe",
    command: "npx pxpipe-proxy",
    repositoryUrl: "https://github.com/teamchong/pxpipe",
    description: "AI LLM / MCP reverse proxy bridge (pxpipe-proxy)",
    defaultPort: 47821,
    defaultUrl: "http://localhost:47821",
    ports: [47821],
  },
  ocx: {
    id: "ocx",
    name: "ocx",
    command: "ocx start",
    stopCommand: "ocx stop",
    repositoryUrl: "https://github.com/lidge-jun/opencodex",
    description: "OpenCode Interpreter daemon service (ocx start)",
    defaultPort: 10100,
    defaultUrl: "http://localhost:10100",
    ports: [10100],
  },
  hindsight: {
    id: "hindsight",
    name: "hindsight",
    // Docker container, not a host process: no PID, port cleanup or npm updates.
    runtime: "docker",
    command: "docker container hindsight",
    repositoryUrl: "https://github.com/vectorize-io/hindsight",
    description: "Long-term agent memory in Docker (vectorize-io/hindsight; API :8888, UI :9999)",
    defaultPort: 9999,
    defaultUrl: "http://localhost:9999",
    ports: [],
  },
  headroom: {
    id: "headroom",
    name: "headroom",
    command: "headroom proxy",
    repositoryUrl: "https://github.com/headroomlabs-ai/headroom",
    description: "Context optimization & LLM proxy (headroom proxy)",
    defaultPort: 8787,
    defaultUrl: "http://localhost:8787/dashboard",
    ports: [8787],
  },
};

export const SERVICE_IDS = Object.keys(SERVICES);

// Shared by read-only version probes and explicit service updates.
export const SERVICE_PACKAGES = {
  pxpipe: { name: "pxpipe-proxy", bin: "pxpipe", npx: true },
  ocx: { name: "@bitkyc08/opencodex", bin: "ocx", health: "/healthz", service: "opencodex" },
  headroom: { name: "headroom-ai", bin: "headroom", health: "/health", pypi: true },
};

export const APP_NAME = "ai-helper";
export const CLI_NAME = "aih";
export const VERSION = packageInfo.version;
export const PACKAGE_NAME = packageInfo.name;
export const APP_REPOSITORY_URL = packageInfo.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
