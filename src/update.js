import { PACKAGE_NAME, VERSION } from "./config.js";

export function isNewerVersion(latest, current) {
  const parse = value => typeof value === "string"
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
    : null;
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b || a[0] !== latest || b[0] !== current) return false;
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]);
  }
  if (!a[4] || !b[4]) return Boolean(b[4]) && !a[4];
  const left = a[4].split(".");
  const right = b[4].split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === undefined || right[i] === undefined) return right[i] === undefined;
    const numericLeft = /^\d+$/.test(left[i]);
    const numericRight = /^\d+$/.test(right[i]);
    if (numericLeft && numericRight) return BigInt(left[i]) > BigInt(right[i]);
    if (numericLeft !== numericRight) return numericRight;
    return left[i] > right[i];
  }
  return false;
}

export async function checkForUpdates({ fetchImpl = globalThis.fetch, notify = console.error } = {}) {
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
      signal: AbortSignal.timeout(1500), headers: { accept: "application/json" },
    });
    if (!response.ok) return;
    const { version } = await response.json();
    if (isNewerVersion(version, VERSION)) {
      notify(`[aih] Update available: ${VERSION} -> ${version}. Run: npm install -g ${PACKAGE_NAME}@latest`);
    }
  } catch {
    // An unavailable registry must not prevent services from starting.
  }
}
