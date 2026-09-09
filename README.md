# ⚡ ai-helper (`aih`)

<p align="center">
  <strong>Zero-config background service manager, auto-discovery daemon & web dashboard launcher for AI agent ecosystems.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@drakonkat/ai-helper"><img src="https://img.shields.io/npm/v/@drakonkat/ai-helper.svg?color=blue&style=flat-square" alt="NPM Version" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square" alt="Node Version" /></a>
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/bun-compatible-f472b6.svg?style=flat-square" alt="Bun Compatible" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey.svg?style=flat-square" alt="Platforms" />
</p>

---

## 📖 Table of Contents
- [Why ai-helper?](#-why-ai-helper)
- [Quick Start](#-quick-start)
- [Managed Services & Dashboards](#-managed-services--dashboards)
- [Key Features](#-key-features)
- [CLI Reference](#-cli-reference)
- [Programmatic JSON API](#-programmatic-json-api)
- [Architecture & Documentation](#-architecture--documentation)
- [Configuration & State](#-configuration--state)
- [Contributing](#-contributing)
- [License](#-license)

---

## 💡 Why ai-helper?

When building, testing, and collaborating with local AI agents, coding assistants, and MCP servers, multiple background services must run simultaneously:
1. **`pxpipe`**: LLM & MCP protocol reverse proxy bridge (`npx pxpipe-proxy`).
2. **`ocx`**: OpenCode interpreter and execution daemon (`ocx start`).
3. **`agentmemory`**: Persistent long-term agent memory server (`npx @agentmemory/agentmemory`).
4. **`headroom`**: LLM context optimization & compression proxy (`headroom proxy`).

Manually opening separate terminal tabs for each service is messy, clutters your workspace, and easily leads to orphaned background processes and blocked ports. 

**`aih`** solves this with a lightweight, zero-dependency CLI that:
- **Spawns and backgrounds** all services independently.
- **Auto-discovers** existing instances already running in external PowerShell / CMD / terminal windows.
- **Terminates process trees cleanly** (`taskkill /T /F` on Windows, process groups on Unix) so no child workers or ports remain trapped.
- **Opens web dashboards in your browser** with a single command (`aih open`).
- **Streams live unified logs** (`aih logs <service> -f`).

---

## 🚀 Quick Start

You can run `ai-helper` immediately using **`npx`** without cloning or installing anything:

```bash
# View services status and active dashboards
npx @drakonkat/ai-helper status

# Open all active web dashboards in your default browser
npx @drakonkat/ai-helper open

# Start all background services
npx @drakonkat/ai-helper start
```

### Global Installation

To use the compact `aih` command globally anywhere in your terminal:

```bash
# Install globally via npm
npm install -g @drakonkat/ai-helper

# Or via bun
bun add -g @drakonkat/ai-helper
```

---

## 📦 Managed Services & Dashboards

| Service | Background Command | Default Port / URL | Description |
| :--- | :--- | :--- | :--- |
| **`pxpipe`** | `npx pxpipe-proxy` | [`http://localhost:47821`](http://localhost:47821) | AI LLM & MCP protocol reverse proxy bridge |
| **`ocx`** | `ocx start` | [`http://localhost:10100`](http://localhost:10100) | OpenCode interpreter execution daemon |
| **`agentmemory`** | `npx @agentmemory/agentmemory` | [`http://localhost:3113`](http://localhost:3113) | Persistent agent long-term memory server & viewer |
| **`headroom`** | `headroom proxy` | [`http://localhost:8787/dashboard`](http://localhost:8787/dashboard) | Context optimization & LLM compression proxy |

---

## ✨ Key Features

- 🔍 **Real-Time Auto-Discovery**: Automatically queries OS process tables (`Win32_Process` and TCP listening connections on Windows, `ps` on Unix) to discover and manage processes started from external terminal windows.
- 🌐 **One-Click Dashboard Launcher**: Run `aih open` to launch all active service dashboards in your browser in separate tabs.
- 🛡️ **Clean Process Tree Termination**: Kills parent and all nested child worker processes (`node.exe`, `iii.exe`, etc.) ensuring no ports remain locked.
- 📜 **Live Log Streaming**: Unified stdout/stderr log capture per service with live real-time tailing (`aih logs <service> -f`).
- 🤖 **Agent & Automation Friendly**: Native `--json` output format for IDE integrations, subagents, and automated workflows.
- ⚡ **Zero Runtime Dependencies**: Built entirely on standard Node.js & Bun built-ins with instant startup time.

---

## 💻 CLI Reference

### 1. Status Overview

```bash
aih status
# or simply
aih
```

*Output:*
```text
ai-helper v1.0.0 — Background AI Ecosystem Service Manager

SERVICE       STATUS        PID   UPTIME   DASHBOARD / URL          COMMAND                     
───────────   ─────────   ─────   ──────   ──────────────────────   ────────────────────────────
pxpipe        ● RUNNING   36212   1h 42m   http://localhost:47821   npx pxpipe-proxy            
ocx           ● RUNNING   31540      54s   http://localhost:10100   ocx start                   
agentmemory   ● RUNNING   44600   1h 32m   http://localhost:3113    npx @agentmemory/agentmemory

Use 'aih open [service]' to open dashboards in browser or 'aih start' to launch.
```

Run `aih status --ui` in a terminal for the interactive live dashboard. Its
`VERSION` column shows the running service version when available, otherwise the
installed version. `UPDATE` shows `↑ <version>` for an available update,
`aggiornato` when no newer version is found, or `n/d` when the check cannot be
completed. Checks query npm/PyPI in the background every five minutes and after
a service restart; they never install or update services.

The `PIPELINE` panel separates current activity from Headroom's cumulative
statistics (since its counters started). `Token risparmiati` is saved tokens /
(input + saved); `Richieste cached` is cached requests / total requests, not a
cost-saving percentage. `Durata media` is the cumulative mean request latency.
Press **`d`** to toggle URLs, versions, token rates and metric definitions.
Rates use the interval between samples, not streaming token-generation speed.
Only explicit health checks show a service as `verificato`; a running process
alone is not a health check, and the final upstream is not monitored.
After a failed collection or five seconds without a sample, totals are marked
as old and live activity/rates are hidden until collection recovers.

---

### 2. Open Dashboards in Browser

```bash
# Open all currently running service dashboards
aih open

# Open only a specific dashboard
aih open agentmemory      # Opens http://localhost:3113
aih open ocx              # Opens http://localhost:10100
aih open pxpipe           # Opens http://localhost:47821
```

---

### 3. Start Services

```bash
# Start all configured services
aih start

# Start a specific service
aih start pxpipe
aih start agentmemory
```

### Astra / `--gpt` (Windows)

```powershell
aih start --gpt
aih start --gpt --json
```

Uses the configured Windows compression stack: starts OCX when needed, then pxpipe on **47822** and Headroom on **8788**, and selects **gpt-6-astra** with the `pxpipe-codex` provider in Codex's user config. Requests follow **Codex → Headroom → pxpipe → OCX → ChatGPT subscription**. OCX retains its canonical OpenAI endpoint and uses account pool mode; Anthropic's OCX endpoint is direct to avoid a routing loop.

The provider keeps `requires_openai_auth = true` so Codex shows your signed-in ChatGPT profile. `experimental_bearer_token = "local-proxy"` keeps model requests using the local placeholder credential; OCX supplies the real upstream credentials. Both settings are needed: enabling OpenAI auth alone sends the ChatGPT token to the proxies and can break Claude routing. Reopen Codex if an already-running app still displays the provider label after this configuration change.

The startup uses the same banner, colors and per-process output as plain `aih start`, including the actual listening PID:

```text
Starting service(s): ocx, pxpipe, headroom...

  Launching ocx... already running (PID: 1100)
  Launching pxpipe... started (PID: 2200)
  Launching headroom... started (PID: 3300)
```

The JavaScript launchers are **included in the package and standalone build**; no external `.ps1` files are required. Install/login to OCX and install Node.js, pxpipe-proxy and Headroom first. AIH finds Node and Headroom through `PATH` (also `~/.local/bin/headroom.exe`), and pxpipe through global npm or its npm cache, without fixed cache hashes or user-specific paths. Missing dependencies produce an installation hint; AIH does not install tools or create subscription credentials.

Paths default to the current user's home and respect `CODEX_HOME`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, and npm's cache/prefix configuration. Nonstandard installations can set `NODE_BINARY`, `PXPIPE_CLI_PATH` (the package's `bin/cli.js`) and `HEADROOM_BINARY`. Existing `PXPIPE_CONFIG`, `PXPIPE_LOG`, `PXPIPE_GPT_PROFILES`, `HEADROOM_WORKSPACE_DIR`, `HEADROOM_CONFIG_DIR` and `HEADROOM_SETTINGS_PATH` overrides are supported. The bundled Astra compression profile matches the previous launcher; Headroom runs with `--lossless --no-cache`.

Startup follows dependency order (OCX, pxpipe, Headroom); **requests flow the other way: Headroom → pxpipe → OCX**, which selects the final endpoint by model. Both pxpipe upstreams point to OCX on 10100. Hidden, on-demand Windows tasks named `AIH-GPT-<user>-pxpipe` and `AIH-GPT-<user>-headroom` keep the proxies alive independently of Codex, without boot/login triggers or external script files. Logs are `gpt-<service>.stdout.log` / `gpt-<service>.stderr.log` in `~/.pxpipe` and the Headroom workspace. Healthy existing instances are reused, including instances started by the old launchers; existing external scripts/tasks are not removed or changed. An occupied but unhealthy port fails its readiness check rather than spawning a duplicate.

Plain `aih start`, stop/restart and the TUI retain their existing service behavior; use `aih start --gpt` to bring up/check this chain and its printed URLs to access its dashboards. `--json` prints only JSON, including a `services` array with process IDs and already-running status.

The command backs up configuration files under `~/.aih/backups/gpt-*`, checks Headroom's actual upstream settings and verifies that Astra appears in the model catalog through the chain. AIH selects Astra last, after these checks. OCX can also sync Codex config during its own cold startup, so AIH saves the original before starting OCX; that backup remains available if startup fails. **Start a new Codex task** afterward: existing tasks can retain their old provider even after restarting the app. The existing pxpipe compression profile and Headroom compression options are preserved.

---

### 4. Stop Services

```bash
# Stop all running services (terminates process trees cleanly)
aih stop

# Stop a specific service
aih stop ocx
```

---

### 5. Restart Services

```bash
# Restart all services
aih restart

# Restart a specific service
aih restart pxpipe
```

---

### 6. View & Follow Logs

```bash
# View last 50 lines of logs
aih logs pxpipe

# View last 100 lines
aih logs agentmemory -n 100

# Stream logs in real-time (like tail -f)
aih logs ocx -f
```

---

## 🤖 Programmatic JSON API

For AI agents, scripts, and CI/CD pipelines, use the `--json` flag:

```bash
aih status --json
```

*Response:*
```json
[
  {
    "id": "pxpipe",
    "name": "pxpipe",
    "command": "npx pxpipe-proxy",
    "status": "running",
    "pid": 36212,
    "uptime": "1h 42m",
    "url": "http://localhost:47821",
    "description": "AI LLM / MCP reverse proxy bridge (pxpipe-proxy)",
    "logPath": "C:\Users\user\.aih\logs\pxpipe.log",
    "logSize": 48392
  },
  {
    "id": "ocx",
    "name": "ocx",
    "command": "ocx start",
    "status": "running",
    "pid": 31540,
    "uptime": "54s",
    "url": "http://localhost:10100",
    "description": "OpenCode Interpreter daemon service (ocx start)",
    "logPath": "C:\Users\user\.aih\logs\ocx.log",
    "logSize": 12480
  },
  {
    "id": "agentmemory",
    "name": "agentmemory",
    "command": "npx @agentmemory/agentmemory",
    "status": "running",
    "pid": 44600,
    "uptime": "1h 32m",
    "url": "http://localhost:3113",
    "description": "Long-term persistent agent memory service (@agentmemory/agentmemory)",
    "logPath": "C:\Users\user\.aih\logs\agentmemory.log",
    "logSize": 85190
  }
]
```

---

## 📁 Configuration & State

State and log files are stored in the user's home directory under `~/.aih`:
- **State File**: `~/.aih/state.json` (records active PIDs, start timestamps, URLs, and status).
- **Log Directory**: `~/.aih/logs/<service>.log` (stdout and stderr captured with startup banners).

You can override the storage directory by setting the `AIH_HOME` environment variable:
```bash
export AIH_HOME=/custom/path/.aih
```

---

## 📚 Architecture & Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Deep dive into process tree management, auto-discovery engine, and TCP port mapping.
- [CONTRIBUTING.md](CONTRIBUTING.md) - Guidelines for development, local testing, and pull requests.
- [CHANGELOG.md](CHANGELOG.md) - Version release history and updates.

---

## 🛠️ Development & Testing

```bash
# Clone the repo
git clone https://github.com/drakonkat/ai-helper.git
cd ai-helper

# Run CLI directly
node bin/cli.js status
# or with bun
bun dev status

# Run test suite
bun test

# Optional: compile standalone binary (Windows/macOS/Linux)
bun run build
```

---

## 📄 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.
