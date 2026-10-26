import { SERVICE_IDS } from "./config.js";

export const STARTUP_SERVICE_IDS = Object.freeze([
  "ocx", "agentmemory", ...SERVICE_IDS.filter(id => !["ocx", "agentmemory"].includes(id)), "proxy",
]);
export const DEFAULT_START_SERVICES = Object.freeze(["ocx", "agentmemory", "proxy"]);

export function normalizeStartServices(value = DEFAULT_START_SERVICES) {
  if (!Array.isArray(value) || !value.length || value.some(id => !STARTUP_SERVICE_IDS.includes(id))) {
    throw new Error(`Select at least one startup service from: ${STARTUP_SERVICE_IDS.join(", ")}`);
  }
  // Start upstream services first and the built-in proxy last.
  return STARTUP_SERVICE_IDS.filter(id => value.includes(id));
}
