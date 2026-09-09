import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compareVersions, getServiceVersions, readNpmVersionFromCommand, runVersionCommand } from "../src/utils/versions.js";

describe("version comparison", () => {
  it("compares numbers, ignores build metadata, and accepts a v prefix", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("v2.0.0+local", "2.0.0+registry")).toBe(0);
    expect(compareVersions("10.0.0", "2.99.99")).toBe(1);
  });

  it("orders prereleases before stable releases and numeric prerelease parts numerically", () => {
    expect(compareVersions("1.0.0-rc.9", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("keeps absent, malformed, and terminal-control values unknown", () => {
    for (const invalid of [null, undefined, 1, "", "latest", "1.2", "01.2.3", "1.2.3-rc.01", "1.2.3\u001b[0m"]) {
      expect(compareVersions(invalid, "1.2.3")).toBeNull();
    }
  });
});

describe("service version probes", () => {
  it("prefers verified live health metadata and correct registry package names", async () => {
    const calls = [];
    const result = await getServiceVersions([
      { id: "ocx", status: "running", url: "http://localhost:10100/dashboard" },
      { id: "agentmemory", status: "running", url: "http://localhost:3113" },
      { id: "headroom", status: "running", url: "http://localhost:8788/dashboard" },
    ], {
      request: async (url, timeout) => {
        calls.push([url, timeout]);
        if (url.endsWith("/healthz")) return { service: "opencodex", version: "v2.9.0" };
        if (url.endsWith("/agentmemory/health")) return { service: "agentmemory", version: "0.9.29" };
        if (url.endsWith("/health")) return { version: "0.12.0+local" };
        if (url.includes("opencodex")) return { version: "2.10.0" };
        if (url.includes("agentmemory")) return { version: "0.9.29" };
        return { info: { version: "0.11.0" } };
      },
      processCommands: () => { throw new Error("health should avoid process lookup"); },
      installedVersion: () => { throw new Error("health should avoid fallback"); },
    });
    expect(result.ocx).toEqual({ version: "2.9.0", latestVersion: "2.10.0", updateAvailable: true });
    expect(result.agentmemory.updateAvailable).toBe(false);
    expect(result.headroom.updateAvailable).toBe(false);
    expect(calls.map(([url]) => url)).toContain("https://registry.npmjs.org/%40bitkyc08%2Fopencodex/latest");
    expect(calls.map(([url]) => url)).toContain("https://registry.npmjs.org/%40agentmemory%2Fagentmemory/latest");
    expect(calls.map(([url]) => url)).toContain("https://pypi.org/pypi/headroom-ai/json");
    expect(calls.every(([, timeout]) => timeout > 0 && timeout <= 3000)).toBe(true);
  });

  it("shares a process lookup and isolates installed and registry failures", async () => {
    let lookups = 0;
    const commands = [];
    const result = await getServiceVersions([
      { id: "pxpipe", status: "running", pid: 10 },
      { id: "ocx", status: "running", pid: 20, url: "http://localhost:10100" },
      { id: "agentmemory", status: "stopped" },
      { id: "headroom", status: "stopped" },
    ], {
      request: async url => {
        if (url.includes("pxpipe")) return { version: "0.13.3" };
        if (url.includes("opencodex")) throw new Error("offline");
        if (url.endsWith("/healthz")) return { service: "foreign-service", version: "99.0.0" };
        return { version: "bad\u001b[0m", info: { version: "0.12.0" } };
      },
      processCommands: async () => { lookups++; return { 10: "pxpipe process", 20: "ocx process" }; },
      installedVersion: async (status, command) => {
        commands.push([status.id, command]);
        if (status.id === "headroom") throw new Error("not installed");
        return status.id === "pxpipe" ? "0.13.2" : "2.42.0";
      },
    });
    expect(lookups).toBe(1);
    expect(commands).toContainEqual(["pxpipe", "pxpipe process"]);
    expect(commands).toContainEqual(["ocx", "ocx process"]);
    expect(result.pxpipe.updateAvailable).toBe(true);
    expect(result.ocx).toEqual({ version: "2.42.0", latestVersion: null, updateAvailable: null });
    expect(result.agentmemory.latestVersion).toBeNull();
    expect(result.headroom).toEqual({ version: null, latestVersion: "0.12.0", updateAvailable: null });
  });

  it("does not probe stopped service URLs and handles unavailable process metadata", async () => {
    const calls = [];
    const result = await getServiceVersions([
      { id: "ocx", status: "stopped", url: "http://localhost:10100" },
      { id: "pxpipe", status: "running", pid: 12 },
    ], {
      request: async url => { calls.push(url); return null; },
      processCommands: async () => { throw new Error("access denied"); },
      installedVersion: async () => null,
    });
    expect(calls.every(url => url.startsWith("https://registry.npmjs.org/"))).toBe(true);
    expect(result.pxpipe).toEqual({ version: null, latestVersion: null, updateAvailable: null });
  });
});

it("reads exact running package metadata even when paths contain spaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aih-versions-"));
  try {
    const pkg = join(dir, "cache with spaces", "node_modules", "pxpipe-proxy");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pxpipe-proxy", version: "0.13.2" }));
    const command = `node "${join(pkg, "bin", "cli.js")}"`;
    expect(await readNpmVersionFromCommand(command, "pxpipe-proxy")).toBe("0.13.2");
    expect(await readNpmVersionFromCommand(command, "@agentmemory/agentmemory")).toBeNull();
    expect(await readNpmVersionFromCommand("npx pxpipe-proxy", "pxpipe-proxy")).toBeNull();
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "other-package", version: "99.0.0" }));
    expect(await readNpmVersionFromCommand(command, "pxpipe-proxy")).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("bounds version subprocesses, including Windows, without a shell", async () => {
  const started = Date.now();
  expect(await runVersionCommand(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], 50)).toBeNull();
  expect(Date.now() - started).toBeLessThan(3000);
  expect(await runVersionCommand("aih-deliberately-missing-version-command", [], 50)).toBeNull();
});
