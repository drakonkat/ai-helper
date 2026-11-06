import { SERVICE_IDS } from "./config.js";

export const STARTUP_SERVICE_IDS = Object.freeze([
  "ocx", "hindsight", ...SERVICE_IDS.filter(id => !["ocx", "hindsight"].includes(id)), "proxy",
]);
export const DEFAULT_START_SERVICES = Object.freeze(["ocx", "hindsight", "proxy"]);
/** Saved selections from older releases name services that were replaced. */
const REPLACED_SERVICES = { agentmemory: "hindsight" };

export function normalizeStartServices(value = DEFAULT_START_SERVICES) {
  if (Array.isArray(value)) value = value.map(id => REPLACED_SERVICES[id] || id);
  if (!Array.isArray(value) || !value.length || value.some(id => !STARTUP_SERVICE_IDS.includes(id))) {
    throw new Error(`Select at least one startup service from: ${STARTUP_SERVICE_IDS.join(", ")}`);
  }
  // Start upstream services first and the built-in proxy last.
  return STARTUP_SERVICE_IDS.filter(id => value.includes(id));
}
