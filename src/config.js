import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pre-configured AI ecosystem services managed by aih
 */
export const SERVICES = {
  pxpipe: {
    id: "pxpipe",
    name: "pxpipe",
    command: "npx pxpipe-proxy",
    description: "AI LLM / MCP reverse proxy bridge (pxpipe-proxy)",
    defaultPort: 47821,
    defaultUrl: "http://localhost:47821",
  },
  ocx: {
    id: "ocx",
    name: "ocx",
    command: "ocx start",
    description: "OpenCode Interpreter daemon service (ocx start)",
    defaultPort: 10100,
    defaultUrl: "http://localhost:10100",
  },
  agentmemory: {
    id: "agentmemory",
    name: "agentmemory",
    command: "npx @agentmemory/agentmemory",
    description: "Long-term persistent agent memory service (@agentmemory/agentmemory)",
    defaultPort: 3113,
    defaultUrl: "http://localhost:3113",
  },
};

export const SERVICE_IDS = Object.keys(SERVICES);

export const APP_NAME = "ai-helper";
export const CLI_NAME = "aih";
export const VERSION = "1.0.0";

