# 📋 Changelog

All notable changes to **`ai-helper` (`aih`)** are documented in this file.

---

## [Unreleased]

### Added
- GitHub `REPO` column in plain status and the live dashboard, `repositoryUrl` in JSON, and repository opening with `g` or `aih open <service> --repo`.
- Automatic Codex proxy URL configuration on managed proxy start/restart and ocx start/restart with an active proxy, including actual bound ports, ocx readiness checks, TOML-preserving edits, first-write backups, and `AIH_CODEX_AUTOCONFIG=0` opt-out.

---

## [1.1.1] - 2026-08-27

### Updates
- Added TUI updates and fixed the agentMemory dashboard flow.

---

## [1.1.0] - 2026-08-27

### 🚀 New Features
- **Headroom Service Integration**: Added full background service management, live status, logs, and dashboard launching for `headroom` (`headroom proxy` on port `8787` with dashboard at `http://localhost:8787/dashboard`).
- **Cross-Platform Auto-Discovery**: Automatic discovery of externally launched `headroom` proxy processes via OS process table queries and TCP port 8787 listeners.

---

## [1.0.4] - 2026-08-27

### 🐛 Bug Fixes
- **Self Process CLI Exclusion**: Exclude current CLI process (`process.pid`) and `aih` CLI command patterns from OS process auto-discovery, preventing false-positive "already running" statuses during `aih start <service>`.
- **Precise Process Matching**: Refine `pxpipe-proxy` matching patterns so general CLI arguments are not mistaken for the active service daemon.
- **Post-Start Verification**: Verify actual service liveness after the startup grace period in `startService`, reporting startup failures accurately instead of declaring dead processes as running.

---

## [1.0.2] - 2026-08-19

### 🐛 Bug Fixes
- **Auto-Discovery Fix**: Strictly exclude `agentmemory-mcp` / `@agentmemory/mcp` client shims from matching the `agentmemory` daemon server, ensuring the background web server (`http://localhost:3113`) is launched properly on `aih start`.

---

## [1.0.1] - 2026-08-19

### 🔧 Improvements & Fixes
- **Scoped Package Deployment**: Published under the `@drakonkat/ai-helper` npm scope for instant `npx` execution.
- **Enhanced Process Auto-Discovery**: Optimized WMI/CIM process query performance on Windows.
- **Documentation & CI**: Added complete GitHub community templates, architecture guides, and CI workflows.

---

## [1.0.0] - 2026-08-19

### 🚀 Initial Release
- **Managed Services**: Support for background lifecycle management of `pxpipe`, `ocx`, and `agentmemory`.
- **Auto-Discovery Engine**: Detects running service instances started from external terminal windows via OS process table queries.
- **TCP Port & Dashboard Mapping**: Dynamically detects listening web ports and exposes clickable dashboard URLs.
- **One-Click Browser Dashboard Launcher**: Added `aih open [service]` to launch active dashboards directly in the user's default browser.
- **Safe Process Tree Termination**: Tree-killing on Windows via `taskkill /pid <PID> /T /F` and process group termination on Unix.
- **Unified Live Log Streaming**: Real-time log capture and streaming with `aih logs <service> -f`.
- **Programmatic JSON API**: Added `--json` flag for IDE, agent, and pipeline integration.
- **Cross-Runtime & NPX Ready**: Universal Node.js (>=18) and Bun support.
