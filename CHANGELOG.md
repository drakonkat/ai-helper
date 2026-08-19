# 📋 Changelog

All notable changes to **`ai-helper` (`aih`)** are documented in this file.

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

