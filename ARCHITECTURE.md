# 🏗️ Architecture & Internal Design

This document details the architectural principles, process lifecycles, auto-discovery mechanisms, and cross-platform designs implemented in **`ai-helper` (`aih`)**.

---

## 1. High-Level Architecture

```text
┌────────────────────────────────────────────────────────┐
│                        CLI / NPX                       │
│       bin/cli.js ───► src/index.js (Router & Flags)    │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│                     ServiceManager                     │
│   src/manager.js (State Machine & Process Manager)     │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
┌──────────────▼──────────────┐ ┌─────────▼──────────────┐
│     Auto-Discovery Engine   │ │     Process Lifecycle   │
│ - Win32_Process (WMI/CIM)   │ │ - Spawn Detached       │
│ - Get-NetTCPConnection      │ │ - Tree Kill (taskkill) │
│ - ps / pgrep (Unix)         │ │ - Log Redirection      │
└──────────────┬──────────────┘ └─────────┬──────────────┘
               │                          │
┌──────────────▼──────────────────────────▼──────────────┐
│                    Persistence Layer                   │
│   ~/.aih/state.json  │  ~/.aih/logs/<service>.log      │
└────────────────────────────────────────────────────────┘
```

---

## 2. Process Tree Management

### The Orphan Process Problem
When background daemons are spawned via npm or shell wrappers (`npx pxpipe-proxy`, `ocx start`, `npx @agentmemory/agentmemory`), the spawned process hierarchy often looks like:

```text
cmd.exe (or sh)
 └─► node.exe (npx-cli wrapper)
      └─► node.exe (actual worker / proxy server)
           └─► iii.exe (sub-process engine / binary)
```

If a process manager kills only the parent PID, the child `node.exe` and `iii.exe` processes remain running as orphans in the background, keeping network ports locked.

### Solution in ai-helper
1. **Windows**: Uses `taskkill.exe /pid <PID> /T /F`:
   - `/T`: Recursively terminates the specified process and any child processes started by it.
   - `/F`: Forcefully terminates the processes.
2. **Unix (Linux & macOS)**:
   - Signals the entire process group (`process.kill(-pid, "SIGTERM")`).
   - If processes remain alive after 500ms, sends `SIGKILL`.

---

## 3. Real-Time Auto-Discovery Engine

Even if services are started outside `aih` (e.g. from separate PowerShell tabs, IDE terminal windows, or boot scripts), `aih` dynamically discovers them:

### Windows Implementation
In a single fast PowerShell CIM query:
```powershell
$procs = Get-CimInstance Win32_Process | Where-Object { 
  $_.CommandLine -and ($_.CommandLine -match 'pxpipe|ocx|agentmemory|iii') 
} | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate

$ports = Get-NetTCPConnection -State Listen | Select-Object LocalPort, OwningProcess
```
1. Matches active processes against service signatures.
2. Correlates TCP listening ports with the process tree PIDs.
3. Automatically computes uptimes from `CreationDate`.
4. Maps dynamic ports to Web Dashboard URLs.

### Unix Implementation
Uses `ps -eo pid,command` to match command line strings and extract active PIDs.

---

## 4. State Synchronization

- **Storage Location**: `~/.aih/state.json` (overridable via `$AIH_HOME`).
- **Audit Cycle**:
  1. Reads existing state file.
  2. Verifies PID liveness with non-destructive signals (`process.kill(pid, 0)`).
  3. Discovers active external processes.
  4. Resolves listening URLs.
  5. Atomically saves updated state.

---

## 5. Zero-Dependency & Cross-Runtime Design

`ai-helper` relies solely on standard built-in modules:
- `node:child_process` & `node:fs`
- Works out of the box on **Node.js (>= 18.0.0)** and **Bun (>= 1.0.0)**.
- Standalone binaries can be generated with `bun build --compile`.

