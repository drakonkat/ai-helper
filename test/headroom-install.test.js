import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { HEADROOM_PYTHON, HEADROOM_REQUIREMENT, installServiceUpdate, refreshToolPath } from "../src/service-updates.js";

// Probes and spawned installers are fakes: nothing is installed or executed.
async function withLogHome(run) {
  const previous = process.env.AIH_HOME;
  const home = mkdtempSync(join(tmpdir(), "aih-headroom-test-"));
  process.env.AIH_HOME = home;
  try { return await run(home); }
  finally {
    if (previous === undefined) delete process.env.AIH_HOME;
    else process.env.AIH_HOME = previous;
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe temporary cleanup path");
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * `present` maps a command to its --version output; commands installed by a
 * fake installer step are added through `onSpawn`.
 */
function machine({ present = {}, platform = "linux", failing = [], onSpawn } = {}) {
  const tools = { ...present };
  const spawned = [];
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, env: options.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      onSpawn?.(command, args, tools);
      child.emit("close", failing.includes(command) ? 3 : 0, null);
    }, 0);
    return child;
  };
  const probe = async (command, args) => {
    const key = command === "py" ? "py" : command;
    return Object.hasOwn(tools, key) && (command !== "py" || args[0] === "-3") ? tools[key] : null;
  };
  return {
    spawned,
    commands: () => spawned.map(s => [s.command, ...s.args]),
    run: () => installServiceUpdate("headroom", { platform, spawnImpl, probe, refreshPath: () => [] }),
  };
}

const UV_INSTALL = ["tool", "install", "--force", "--python", HEADROOM_PYTHON, HEADROOM_REQUIREMENT];

describe("Headroom installation bootstrap", () => {
  it("updates an existing installation through Headroom itself", async () => withLogHome(async () => {
    const m = machine({ present: { headroom: "headroom, version 0.9.0", uv: "uv 0.9.0" } });
    expect(await m.run()).toMatchObject({ success: true });
    expect(m.commands()).toEqual([["headroom", "update", "--yes"]]);
  }));

  it("installs a missing Headroom with uv, pinned to a Python that has wheels", async () => withLogHome(async () => {
    const m = machine({ present: { uv: "uv 0.9.0", python3: "Python 3.15.2" } });
    expect(await m.run()).toMatchObject({ success: true });
    expect(m.commands()).toEqual([["uv", ...UV_INSTALL]]);
  }));

  it("bootstraps uv through an existing Python when uv is missing", async () => withLogHome(async () => {
    const m = machine({ present: { python3: "Python 3.15.2" } });
    expect(await m.run()).toMatchObject({ success: true });
    expect(m.commands()).toEqual([
      ["python3", "-m", "pip", "install", "--user", "--upgrade", "uv"],
      ["python3", "-m", "uv", ...UV_INSTALL],
      ["python3", "-m", "uv", "tool", "update-shell"],
    ]);
    expect(m.spawned[0].env.PIP_BREAK_SYSTEM_PACKAGES).toBe("1");
  }));

  it("uses the Windows py launcher and ignores an unusable Store python alias", async () => withLogHome(async () => {
    const m = machine({ platform: "win32", present: { py: "Python 3.13.0", python: "" } });
    expect(await m.run()).toMatchObject({ success: true });
    expect(m.commands()[0]).toEqual(["py", "-3", "-m", "pip", "install", "--user", "--upgrade", "uv"]);
    expect(m.commands()[1].slice(0, 4)).toEqual(["py", "-3", "-m", "uv"]);
  }));

  it("rejects a Python older than 3.10", async () => withLogHome(async () => {
    const m = machine({ present: { python3: "Python 3.8.10" } });
    const result = await m.run();
    expect(result.success).toBe(false);
    expect(result.message).toContain("Python 3.10+ is required");
    expect(m.spawned).toEqual([]);
  }));

  it("installs Python with winget first when neither Python nor uv exists", async () => withLogHome(async () => {
    const m = machine({ platform: "win32", present: { winget: "v1.9" },
      onSpawn: (command, args, tools) => { if (command === "winget") tools.python = "Python 3.12.4"; } });
    expect(await m.run()).toMatchObject({ success: true });
    const [winget, ...rest] = m.commands();
    expect(winget.slice(0, 4)).toEqual(["winget", "install", "-e", "--id"]);
    expect(winget).toContain("Python.Python.3.12");
    expect(rest[0]).toEqual(["python", "-m", "pip", "install", "--user", "--upgrade", "uv"]);
    expect(rest).toHaveLength(3);
  }));

  it("reports an unverifiable Python installation instead of continuing", async () => withLogHome(async () => {
    const m = machine({ platform: "darwin", present: { brew: "Homebrew 5" } });
    const result = await m.run();
    expect(m.commands()).toEqual([["brew", "install", "python"]]);
    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain("not visible to this process");
  }));

  it("explains the failure when Python is missing and cannot be installed", async () => withLogHome(async () => {
    const m = machine({ platform: "win32" });
    const result = await m.run();
    expect(result.success).toBe(false);
    expect(result.message).toContain("Python 3.10+ is required");
    expect(m.spawned).toEqual([]);
  }));

  it("stops at the first failing step and says which installer failed", async () => withLogHome(async () => {
    const m = machine({ present: { python3: "Python 3.12.1" }, failing: ["python3"] });
    const result = await m.run();
    expect(result).toMatchObject({ success: false, exitCode: 3 });
    expect(result.message).toContain("Cannot install 'headroom'");
    expect(m.spawned).toHaveLength(1);
  }));
});

describe("tool PATH refresh", () => {
  it("appends user tool directories without duplicating or overriding", () => {
    const env = { PATH: "/usr/bin" };
    const local = join("/home/me", ".local", "bin");
    const options = { env, platform: "linux", home: "/home/me", exists: dir => dir === local };
    expect(refreshToolPath(options)).toEqual([local]);
    expect(env.PATH.startsWith("/usr/bin")).toBe(true);
    expect(env.PATH.endsWith(local)).toBe(true);
    expect(refreshToolPath(options)).toEqual([]);
  });
});

