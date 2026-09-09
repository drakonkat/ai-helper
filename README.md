# ⚡ ai-helper (`aih`)

<p align="center">
  <strong>Zero-config background service manager, auto-discovery daemon & web dashboard launcher for AI agent ecosystems.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@drakonkat/ai-helper"><img src="https://img.shields.io/npm/v/@drakonkat/ai-helper.svg?color=blue&style=flat-square" alt="NPM Version" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen.svg?style=flat-square" alt="Node Version" /></a>
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
- [HTTP / WebSocket Proxy](#http--websocket-proxy)
  - [Start a compression pipeline](#start-a-compression-pipeline)
  - [Select models](#select-models)
  - [Proxy token savings](#proxy-token-savings)
  - [Troubleshooting](#proxy-troubleshooting)
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

**`aih`** solves this with a lightweight CLI that:
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

# Open service web dashboards in your default browser
npx @drakonkat/ai-helper open

# Start all background services
npx @drakonkat/ai-helper start
```

The CLI manages existing service commands: install/configure `ocx`, `headroom`
and any other services you want to use separately. The built-in proxy includes
the pxpipe library; its presets do not require a separate pxpipe proxy process.

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
| **`proxy`** | `aih start proxy <upstream>` | `http://127.0.0.1:10101` | HTTP/SSE/WebSocket forwarding with optional presets; **no web dashboard** |

---

## ✨ Key Features

- 🔍 **Real-Time Auto-Discovery**: Automatically queries OS process tables (`Win32_Process` and TCP listening connections on Windows, `ps` on Unix) to discover and manage processes started from external terminal windows.
- 🌐 **One-Click Dashboard Launcher**: Run `aih open` to launch service dashboards in your browser in separate tabs.
- 🛡️ **Clean Process Tree Termination**: Kills parent and all nested child worker processes (`node.exe`, `iii.exe`, etc.) ensuring no ports remain locked.
- 📜 **Live Log Streaming**: Unified stdout/stderr log capture per service with live real-time tailing (`aih logs <service> -f`).
- 🤖 **Agent & Automation Friendly**: Native `--json` output format for IDE integrations, subagents, and automated workflows.
- 🔀 **Compression Presets**: pxpipe as a library, Headroom compression, RTK stdin filtering, or ordered combinations.
- 📊 **Proxy Savings**: Per-stage token estimates in `aih stats proxy`, the interactive UI and proxy logs.

---

## 💻 CLI Reference

### 1. Status Overview

```bash
aih status
# Interactive view (press q to exit)
aih status -ui
# or simply
aih
```

*Output:*
```text
ai-helper v1.1.1 — Background AI Ecosystem Service Manager

SERVICE       STATUS        PID   UPTIME   ADDRESS                  COMMAND
───────────   ─────────   ─────   ──────   ──────────────────────   ────────────────────────────
pxpipe        ● RUNNING   36212   1h 42m   http://localhost:47821   npx pxpipe-proxy
ocx           ● RUNNING   31540      54s   http://localhost:10100   ocx start
agentmemory   ● RUNNING   44600   1h 32m   http://localhost:3113    npx @agentmemory/agentmemory

Use 'aih open [service]' to open dashboards in browser or 'aih start' to launch.
```

---

### 2. Open Dashboards in Browser

```bash
# Open service dashboards (proxy is excluded)
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

`aih start` (also `aih up` and starts targeting individual services) checks npm's
`latest` release of `@drakonkat/ai-helper`. If a newer version exists, it prints
the installed/latest versions and the update command to stderr. The check times
out after 1.5 seconds; network errors never prevent startup. Updates are not
installed automatically. Compiled executables must be rebuilt to update them.

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

## HTTP / WebSocket Proxy

Requires **Node.js 20.19+** (also on PATH when using the Bun CLI or compiled executable).
Use **Node.js 24+ for Codex**, whose Zstandard request compression needs Node.js 22.15+.

### Start a compression pipeline

For a local OpenCodex upstream on port `10100`, with the aih listener on `10102`:

```bash
# Start the upstream and compression service, if not already running
aih start ocx
aih start headroom

# First start: Headroom -> pxpipe library -> OpenCodex
aih start proxy http://127.0.0.1:10100/ --listen http://127.0.0.1:10102 --preset headroom-pxpipe --models "gpt-6-astra,google-antigravity/gemini-3.8*"

# Inspect traffic and savings
aih stats proxy
aih status -ui
aih logs proxy -f
```

Set your client's API base URL to **`http://127.0.0.1:10102/v1`**. The client
must connect to `10102` for these presets and statistics to run; connecting
directly to OpenCodex (`10100`), Headroom (`8787`) or pxpipe (`47821`) bypasses
this aih proxy. Keep the client's existing credentials and selected model.
The proxy does not change client configuration for you.

After the first start, use `restart` to change options; unspecified options are
retained. Choose one of these alternatives:

```bash
# Keep the destination, listener and model selection; change the pipeline
aih restart proxy --preset rtk-pxpipe --rtk-filter=
aih restart proxy --preset pxpipe
aih restart proxy --preset headroom
aih restart proxy --preset rtk --rtk-filter=

# Return to Headroom -> pxpipe
aih restart proxy --preset headroom-pxpipe

# Forward without compression; clear any previously saved custom interceptor
aih restart proxy --preset none --interceptor=
```

RTK presets require an `rtk` executable with `rtk pipe` support on PATH.
`--rtk-filter=` selects automatic detection; `--rtk-filter grep` applies the
grep-output filter to every tool result, so use it only with matching output.

### Select models

**All models are forwarded.** `--models` selects only which models pxpipe may
compress; Headroom/RTK still process eligible requests outside that list.
Names match the `model` in the request, including any provider prefix.
For example, an AGY catalog entry can be `google-antigravity/gemini-3.8-flash`,
while Astra is `gpt-6-astra`.

```bash
# Exact Astra name plus any Gemini 3.8 variant under the AGY prefix
aih restart proxy --models "gpt-6-astra,google-antigravity/gemini-3.8*"

# Include the GPT-5.5 and GPT-5.6 selections too
aih restart proxy --models "gpt-5.5,gpt-5.6*,gpt-6-astra,google-antigravity/gemini-3.8*"

# Restore pxpipe's own default selection
aih restart proxy --models=
```

An explicit list **replaces** the saved list. Only a trailing `*` is supported;
use the exact IDs from your client's model catalog. Selecting a model allows
compression but does not force it: pxpipe can leave short or unprofitable
requests unchanged. The upstream must support the selected model/API format.

### Transport and lifecycle

```bash
aih start proxy http://127.0.0.1:10100/
# Also accepts the shorthand: aih start proxy http:127.0.0.1:10100/

aih start proxy http://127.0.0.1:10100/ --listen http://127.0.0.1:10101 --interceptor ./interceptor.mjs
aih status proxy --json
aih logs proxy -f
aih restart proxy
aih stop proxy
```

The positional URL is the **upstream destination**. The default listener is
`http://127.0.0.1:10101`. Point the AI client's API base URL at this listener,
keeping its usual API path: for example, `http://127.0.0.1:10101/v1` forwards
`/v1/responses` to `http://127.0.0.1:10100/v1/responses`. WebSockets use the same
port and path with `ws://`; an HTTPS upstream automatically uses WSS.
An upstream path is a prefix: upstream `https://example.com/backend-api/codex`
plus client `/responses` becomes `/backend-api/codex/responses`.

`start` runs in the background and reports success only after the socket is
listening and the interceptor has loaded. One proxy is managed at a time;
`restart proxy <upstream> [options]` changes its configuration. Omitted options
reuse the last successful configuration, stored in `~/.aih/state.json`.
Use `--interceptor=` to clear an interceptor. Once configured, the proxy also
participates in unqualified `start`, `stop`, `restart` and `status` commands.

HTTP methods, paths, queries, authentication headers, status codes, cookies and
payload bytes are forwarded. SSE stays streaming, with backpressure and upstream
cancellation when the client disconnects. HTTP redirects are returned to the
client without following or rewriting `Location`. WebSocket text/binary messages,
subprotocol selection, ping/pong and close codes are relayed. `Host`, hop-by-hop
headers and WebSocket handshake/framing are regenerated for each connection.
TLS certificates are verified normally; HTTP body compression is preserved.

This is a **reverse proxy**: it does not configure clients automatically, intercept
unrelated machine traffic, implement CONNECT/TLS interception, or translate
between AI API formats. Both sides must speak the same protocol. The listener
accepts loopback addresses only. OpenCodex's
[HTTP/SSE relay](https://github.com/lidge-jun/opencodex/blob/main/src/server/relay.ts)
and [WebSocket bridge](https://github.com/lidge-jun/opencodex/blob/main/src/server/ws-bridge.ts)
were reviewed as transport references; provider-specific rewriting is left to
the upstream service or your interceptor.

### Preset behavior

The recipes live in [src/proxy-presets.js](src/proxy-presets.js). All support
`--interceptor ./interceptor.mjs`, which runs **after** the preset for further
editing or logging. Configuration is saved; `aih restart proxy` reuses it.
Use `--models=` to restore pxpipe's default model selection and `--rtk-filter=`
to restore RTK auto-detection.

- **pxpipe:** calls the [pxpipe library](https://github.com/teamchong/pxpipe#library-use-no-proxy),
  selecting the transformer for Anthropic Messages, OpenAI Chat Completions or
  OpenAI Responses. `--models` is an explicit allowlist of exact names or trailing
  `*` prefixes; without it, pxpipe's own supported-model defaults apply. The library
  decides whether imaging is worthwhile; short/unprofitable requests stay unchanged.
  An explicit allowlist opts those models into imaging; it is not a quality guarantee.
- **headroom:** sends messages to [`POST /v1/compress`](https://headroomlabs-ai.github.io/headroom/proxy/)
  in `lossy_inline` mode, then forwards the result to your original upstream.
  It carries system prompts and tool definitions unchanged. For Responses it compresses
  only text in `function_call_output` items, preserving calls, IDs, reasoning and images.
  This compression endpoint does not provide the full Headroom proxy's tool-schema
  optimization or cache alignment. Set `HEADROOM_PROXY_TOKEN` before starting aih
  if Headroom requires its own token; the client's provider credentials are never
  sent to the compression service.
- **rtk:** runs [`rtk pipe`](https://github.com/rtk-ai/rtk) with tool-result text on
  stdin. `--rtk-filter` selects one fixed filter for all results; omit it for detection.
  Use a fixed filter only when the tool output matches that format. Empty or larger
  results are discarded. Prompts, tool calls and binary content are left untouched;
  no command from an AI request is executed.
- **headroom-pxpipe:** always applies Headroom first; `--models` gates only the
  following pxpipe stage.
- **rtk-pxpipe:** applies RTK to tool-result text first, then the pxpipe library.
  `--rtk-filter` controls RTK and `--models` gates only pxpipe; RTK still runs for
  models outside the allowlist. This chain needs RTK on PATH, with no Headroom service.

Presets process JSON POSTs on Messages, Chat Completions and Responses routes,
and outgoing WebSocket `response.create` events (flat or nested under `response`).
WebSocket model selection uses the event's model, then the last model on that
connection, then the URL's `model` query. Requests with no resolvable model pass
through. Binary frames, response events and SSE are unchanged. Gzip, deflate,
Brotli and Zstandard HTTP request bodies are decoded with the configured size limit only for
inspection; changed bodies are sent as plain JSON with corrected headers.
Zstandard (`Content-Encoding: zstd`, used by Codex) requires Node.js 22.15+.
Unsupported encodings pass through with a warning in `aih logs proxy`, without preset processing.
Headroom and RTK have a 30-second timeout. A failed stage returns HTTP 502 or
closes the WebSocket; it never silently retries the AI request.

### Proxy token savings

```bash
aih stats proxy           # cumulative savings by stage and last five requests
aih stats proxy --json    # counters and last 20 requests, for scripts
aih status -ui           # live proxy savings and configured pipeline
aih logs proxy -f        # per-request [aih stats] lines
```

Statistics start with the first eligible AI request processed by an active preset.
The worker stores counters and the last 20 measurements in `~/.aih/proxy-stats.json`
(`AIH_HOME` overrides the directory). They survive restarts and preset changes;
older traffic cannot be reconstructed. Prompts, tool outputs, images and credentials
are not stored in these statistics.

- Headroom supplies `tokens_before` and `tokens_after` for the messages sent to its
  compression endpoint. These are Headroom's counts, not provider billing usage.
- RTK uses local `o200k_base` token counts on each tool output before/after filtering.
- pxpipe uses its estimated text baseline minus image tokens and injected text.
  Where its transformer lacks these totals, a local text count plus the model's
  image-cost estimate is used. Image base64 is never counted as ordinary text.
- The total sums **incremental** savings from consecutive stages, including negative
  savings when a stage increases token use. Missing measurements are marked unknown
  and the total is marked partial. Model exclusions and unprofitable requests appear
  as zero savings with a reason.

These are **preset processing estimates**, before any custom interceptor. They do
not measure provider cache savings, prices, actual billed usage, or whether upstream
accepted the request. Errors in a preset count as processing failures with no credited
savings. Requests/events that the preset does not recognize are not counted.

The proxy has **no web dashboard**: its URL is a forwarding address. `aih open`
skips it, `aih open proxy` opens nothing, and the interactive UI offers no dashboard
shortcut when proxy is selected. Its statistics are available through the commands
above, without adding HTTP routes that could interfere with forwarded API paths.

### Proxy troubleshooting

| Symptom | What to check |
| --- | --- |
| No proxy statistics | Confirm `aih status proxy --json` shows a preset and the expected listener, point the client at that listener, then send a new request. `--preset none` does not produce preset savings. |
| Traffic in logs, but no statistics | Check content type/encoding in the example interceptor logs and any `[aih preset]` warnings. Zstandard requests require Node.js 22.15+. Unsupported encodings are forwarded without preset processing. |
| `model_excluded` | Match `--models` to the request's exact model ID, including provider prefixes; a new list replaces the old one. |
| Headroom shows `no_messages` | For Responses requests, this preset sends only tool-result text to Headroom. A request without tool outputs has nothing for that stage to compress. |
| Zero savings with `no_static_context`, `below_min_*` or `not_profitable` | The stage was reached but pxpipe chose to preserve the request. Zero savings is valid. |
| UI shows Headroom traffic but proxy statistics stay unchanged | The Headroom metrics/event panel is separate from the **PROXY** preset counters and can include other clients and older traffic. |
| Startup fails | Read `aih logs proxy -n 100`. Check Node on PATH, upstream/listener ports, and the saved interceptor path. `aih restart proxy --interceptor=` clears a missing interceptor. |
| Windows build cannot replace `dist/aih.exe` (`EPERM`) | Exit any dashboard using that binary with `q`, then rebuild. |

With Windows NVM, the compiled CLI resolves the actual Node executable behind
the launcher before starting the worker. Node remains required on PATH even
when using the compiled aih executable.

### JavaScript interceptor

Copy [src/proxy-interceptor.example.mjs](src/proxy-interceptor.example.mjs), edit
it and pass its path with `--interceptor`. Files run as trusted local JavaScript,
with normal Node imports and filesystem access. They load once at startup;
restart the proxy to apply edits. `.mjs` works regardless of the surrounding
package's module type. `.js` follows Node's usual package rules.

```js
export async function onRequest(context) {
  const body = JSON.parse(context.body.toString("utf8"));
  console.log(context.method, context.path, body);
  // body.model = "another-model";
  context.body = JSON.stringify(body);
}

export function onWebSocketMessage(context) {
  if (!context.isBinary) {
    console.log(context.direction, context.body.toString("utf8"));
  }
}
```

All hooks are optional, may be async, and modify the supplied context in place;
return values are ignored. Unmodified bodies pass through. Body values accept
`Buffer`, `Uint8Array` or string. Header names use lowercase.

| Export | Context / behavior |
| --- | --- |
| `onRequest(context)` | `method`, `path`, `headers`, `upstream`, complete `body` Buffer. Runs for HTTP requests; enables request buffering. |
| `onResponse(context)` | `request`, `statusCode`, `headers`. Runs before response headers are sent. |
| `onResponseBody(context)` | Same response context plus complete `body` Buffer. Buffers non-SSE responses only; takes precedence over the chunk hook. Skipped for HEAD, 204 and 304. |
| `onResponseChunk(context)` | Same response context plus raw `body` chunk. Processes streaming responses without accumulating the whole body. |
| `onWebSocketMessage(context)` | `request` handshake metadata, `direction` (`request` or `response`), complete `body` Buffer and `isBinary`. Preserves message order, including async hooks. |

HTTP chunks can split JSON, SSE events and UTF-8 characters. Use incremental
decoding/parsing for streams; the whole-body response hook deliberately bypasses
SSE. Bodies remain in their original encoding, so decompress explicitly before
editing compressed data and update `content-encoding` and any integrity headers
if you change the representation. The proxy recalculates buffered body lengths
and removes `content-length` when transforming streamed responses.

`--max-body-bytes 67108864` controls buffered HTTP bodies, individual WebSocket
messages and each direction's pending WebSocket queue (64 MiB default).
Without body hooks, HTTP streams are not buffered or size-limited by the proxy.
Interceptor/upstream errors return HTTP 502 (oversized requests: 413), or close
the connection if headers have already been sent; failed WebSockets are closed.
Requests are never retried automatically.

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
    "logPath": "C:\\Users\\user\\.aih\\logs\\pxpipe.log",
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
    "logPath": "C:\\Users\\user\\.aih\\logs\\ocx.log",
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
    "logPath": "C:\\Users\\user\\.aih\\logs\\agentmemory.log",
    "logSize": 85190
  }
]
```

---

## 📁 Configuration & State

State and log files are stored in the user's home directory under `~/.aih`:
- **State File**: `~/.aih/state.json` (records active PIDs, start timestamps, URLs, and status).
- **Proxy Statistics**: `~/.aih/proxy-stats.json` (cumulative estimates and the last 20 measurements).
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

# Install dependencies (Bun is also required for tests and compilation)
npm ci

# Run CLI directly
node bin/cli.js status
# or with bun
bun dev status

# Run test suite (existing CLI checks on Bun, proxy integration checks on Node)
npm test

# Optional: compile standalone binary (Windows/macOS/Linux)
bun run build
```

To test the checkout before publishing or installing it globally, use
`node bin/cli.js` in place of `aih`, or the freshly compiled binary:

```powershell
# Windows / PowerShell, from the repository directory
.\dist\aih.exe restart proxy http://127.0.0.1:10100/ --listen http://127.0.0.1:10102 --preset headroom-pxpipe --models "gpt-6-astra,google-antigravity/gemini-3.8*"
.\dist\aih.exe stats proxy
.\dist\aih.exe status -ui
```

Use `./dist/aih` on macOS/Linux. Running an existing global `aih` does not test
changes in this checkout. Close the compiled UI with `q` before rebuilding it
on Windows; after a rebuild, restart the proxy to load the updated worker.

---

## 📄 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.
