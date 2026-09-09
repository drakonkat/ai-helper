import { describe, expect, it } from "bun:test";
import { discoverWindowsProcesses } from "../src/utils/process.js";

const proc = (pid, parent, name, command, extra = {}) => ({
  ProcessId: pid,
  ParentProcessId: parent,
  Name: name,
  CommandLine: command,
  ...extra,
});
const listener = (pid, port) => ({ OwningProcess: pid, LocalPort: port });
const discover = (Procs, Ports, options = {}) => discoverWindowsProcesses(
  { Procs, Ports },
  { currentPid: 99999, isRunning: () => true, ...options },
);
const pxpipeCommand = String.raw`node "C:\Users\tester\AppData\Roaming\npm\node_modules\pxpipe-proxy\bin\cli.js"`;
const memoryCommand = String.raw`node "C:\Users\tester\AppData\Roaming\npm\node_modules\@agentmemory\agentmemory\dist\cli.mjs" start`;
const engineCommand = String.raw`"C:\Users\tester\.agentmemory\bin\iii.exe" --config "C:\Users\tester\.agentmemory\iii-config.yaml"`;

function expectListener(result, service, pid, port, path = "") {
  expect(result[service]).toMatchObject({
    pid,
    port,
    url: `http://localhost:${port}${path}`,
  });
}

describe("discoverWindowsProcesses", () => {
  it.each([47822, 47821, 49001])("keeps pxpipe's package bin/cli.js and actual port %i", port => {
    const command = `${pxpipeCommand} --port ${port}`;
    const result = discover([
      proc(10, 1, "node.exe", command),
      proc(11, 1, "node.exe", String.raw`node "C:\work\ai-helper\bin\cli.js" pxpipe`),
      proc(12, 1, "node.exe", String.raw`node "C:\work\unrelated\server.js"`),
    ], [listener(10, port), listener(12, 47821)]);

    expectListener(result, "pxpipe", 10, port);
    expect(result.pxpipe.command).toBe(command);
    expect(Object.keys(result)).toEqual(["pxpipe"]);
  });

  it("also recognizes a pxpipe CLI path with forward slashes", () => {
    const result = discover([
      proc(10, 1, "node.exe", 'node "C:/Users/tester/npm/node_modules/pxpipe-proxy/bin/cli.js"'),
    ], [listener(10, 47822)]);
    expectListener(result, "pxpipe", 10, 47822);
  });

  const headroomCommand = String.raw`"C:\Users\tester\.local\bin\headroom.exe" proxy --port 8788`;
  const headroomProcesses = [
    proc(20, 1, "headroom.exe", headroomCommand),
    proc(21, 20, "python.exe", `python ${headroomCommand}`),
    proc(22, 21, "python.exe", `python ${headroomCommand}`, { CreationDate: "/Date(1700000000000)/" }),
  ];
  const orderings = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

  for (const order of orderings) {
    it(`selects the listening headroom worker with process ordering ${order.join(",")}`, () => {
      const result = discover([
        ...order.map(index => headroomProcesses[index]),
        proc(23, 1, "python.exe", "python unrelated-server.py"),
      ], [listener(23, 8787), listener(22, 8788)]);

      expectListener(result, "headroom", 22, 8788, "/dashboard");
      expect(result.headroom.command).toBe(headroomProcesses[2].CommandLine);
      expect(result.headroom.startedAt).toBe("2023-11-14T22:13:20.000Z");
    });
  }

  for (const anchor of [3111, 4000]) {
    for (const reversed of [false, true]) {
      it(`uses the agentmemory viewer owner across split processes at anchor ${anchor}, reversed=${reversed}`, () => {
        const processes = [proc(30, 1, "node.exe", memoryCommand), proc(31, 30, "iii.exe", engineCommand)];
        const ports = [
          listener(31, anchor + 46023),
          listener(31, anchor),
          listener(31, anchor + 1),
          listener(30, anchor + 2),
        ];
        const result = discover(reversed ? processes.toReversed() : processes, reversed ? ports.toReversed() : ports);

        expectListener(result, "agentmemory", 30, anchor + 2);
        expect(result.agentmemory.command).toBe(memoryCommand);
      });
    }
  }

  it("does not add two to a standalone agentmemory viewer's listening port", () => {
    const result = discover([proc(30, 1, "node.exe", memoryCommand)], [listener(30, 3113)]);
    expectListener(result, "agentmemory", 30, 3113);
  });

  it.each([3111, 4000])("resolves an elevated agentmemory tree with a stale known port at anchor %i", anchor => {
    const result = discover([
      proc(31, 30, "iii.exe", null),
      proc(30, 29, "node.exe", null),
      proc(29, 1, "powershell.exe", null),
    ], [
      listener(31, anchor + 46023),
      listener(31, anchor),
      listener(31, anchor + 1),
      listener(30, anchor + 2),
    ], {
      knownServices: { agentmemory: { pid: 30, port: 3115, url: "http://localhost:3115" } },
    });

    expectListener(result, "agentmemory", 30, anchor + 2);
  });

  it.each(["node.exe", "bun.exe"])("follows an elevated OCX shell to its listening %s descendant", name => {
    const result = discover([
      proc(42, 41, name, null),
      proc(40, 1, "powershell.exe", null),
      proc(41, 40, "cmd.exe", null),
    ], [listener(42, 10100)], {
      knownServices: { ocx: { pid: 40, port: 10100, url: "http://localhost:10100" } },
    });

    expectListener(result, "ocx", 42, 10100);
  });

  it("ignores MCP shims, post-tool hooks, editors, and ai-helper commands", () => {
    const commands = [
      ["node.exe", "node C:/packages/agentmemory-mcp/dist/index.js"],
      ["node.exe", "node C:/packages/@agentmemory/mcp/dist/index.js"],
      ["node.exe", "node C:/packages/@agentmemory/agentmemory/dist/cli.mjs mcp"],
      ["cmd.exe", "cmd /c agentmemory mcp"],
      ["python.exe", "python C:/Users/tester/.codex/plugins/agentmemory/hooks/post-tool.py"],
      ["node.exe", "node C:/Users/tester/.codex/plugins/agentmemory/hooks/post-tool-use.js"],
      ["notepad.exe", "notepad C:/Users/tester/scripts/start-headroom.ps1"],
      ["notepad.exe", "notepad C:/Users/tester/scripts/start-agentmemory.ps1"],
      ["notepad.exe", "notepad C:/Users/tester/scripts/start-pxpipe-proxy.ps1"],
      ["node.exe", "node C:/work/ai-helper/bin/cli.js start headroom"],
      ["node.exe", String.raw`node C:\work\ai-helper\bin\cli.js start pxpipe-proxy`],
      ["aih.exe", "aih.exe start agentmemory"],
    ];
    const processes = commands.map(([name, command], index) => proc(50 + index, 1, name, command));
    expect(discover(processes, processes.map(p => listener(p.ProcessId, 6000 + p.ProcessId)))).toEqual({});
  });

  it("does not identify unrelated listeners solely by canonical ports", () => {
    const ports = [47821, 47822, 8787, 8788, 3111, 3112, 3113, 49134, 10100];
    const processes = ports.map((_, index) => proc(70 + index, 1, "node.exe", "node C:/work/unrelated/server.js"));
    expect(discover(processes, ports.map((port, index) => listener(70 + index, port)))).toEqual({});
  });

  it("terminates traversal through cyclic parent links", () => {
    const result = discover([
      proc(80, 81, "powershell.exe", null),
      proc(81, 80, "cmd.exe", null),
      proc(82, 81, "node.exe", null),
    ], [listener(82, 10100)], { knownServices: { ocx: { pid: 80 } } });
    expectListener(result, "ocx", 82, 10100);
  });

  it("accepts scalar Procs and Ports from PowerShell JSON", () => {
    const result = discover(proc(90, 1, "node.exe", pxpipeCommand), listener(90, 47822));
    expectListener(result, "pxpipe", 90, 47822);
  });

  it("accepts missing or empty PowerShell collections", () => {
    expect(discover(null, null)).toEqual({});
    expect(discover([], [])).toEqual({});
  });

  it("excludes the current PID and processes rejected by the liveness check", () => {
    const processes = [proc(90, 1, "node.exe", pxpipeCommand)];
    const ports = [listener(90, 47822)];
    expect(discover(processes, ports, { currentPid: 90 })).toEqual({});
    expect(discover(processes, ports, { isRunning: () => false })).toEqual({});
  });
});
