import { APP_NAME, CLI_NAME, SERVICES, SERVICE_IDS, VERSION } from "./config.js";
import { manager } from "./manager.js";
import { checkForUpdates, updateSelf } from "./update.js";
import { readProxyStats, proxyStatsLines } from "./proxy-stats.js";
import {
  badgeStatus,
  bold,
  cyan,
  dim,
  gray,
  green,
  printBanner,
  red,
  renderTable,
  yellow,
  underline,
} from "./utils/format.js";
import { isLocalBinInPath, getAddToPathInstructions, getLocalBinDir, ensureDir } from "./utils/path.js";
import { join } from "node:path";
import { copyFileSync } from "node:fs";
import { parseArgs } from "node:util";

function printHelp() {
  printBanner();
  console.log(`${bold("USAGE:")}
  ${cyan(CLI_NAME)} ${yellow("<command>")} [services...] [options]
  ${cyan(CLI_NAME)} start proxy <http(s)://upstream> [proxy-options]
  ${cyan(CLI_NAME)} restart proxy [http(s)://upstream] [proxy-options]

${bold("COMMANDS:")}
  ${yellow("status")}, ${yellow("ps")} [services...]   Show status, PID, uptime, dashboards and repositories
  ${yellow("status -ui")}                 Interactive live dashboard: manage services and watch the AI pipeline
  ${yellow("open")}, ${yellow("dash")} [services...]   Open web dashboard(s) directly in your default browser
  ${yellow("start")}, ${yellow("up")} [services...]    Start ocx, agentmemory and the pxpipe proxy, or specified services
  ${yellow("start proxy")} [upstream]      Start HTTP/SSE/WebSocket proxy; first start requires upstream
  ${yellow("stop")}, ${yellow("down")} [services...]   Stop all or specified services
  ${yellow("restart")} [services...]       Restart all or specified services
  ${yellow("restart proxy")} [upstream]    Restart proxy, overriding only the supplied options
  ${yellow("update")}                      Update aih itself to the latest npm release
  ${yellow("update")} <services...>        Update the specified managed services
  ${yellow("<service> update")}            Update one service (for example: aih ocx update)
  ${yellow("logs")} <service> [-n 50] [-f]  View or stream live logs for a service
  ${yellow("stats proxy")} [--json]        Show proxy token savings estimates and recent requests
  ${yellow("config")} pxpipe-models=<list> Save the proxy model list for future starts
  ${yellow("install")}                     Build standalone binary to ~/.local/bin and verify PATH
  ${yellow("version")}, ${yellow("-v")}, ${yellow("--version")}     Show version information
  ${yellow("help")}, ${yellow("-h")}, ${yellow("--help")}           Show this help message

  Other aliases: status = ls/list; open = dashboard; logs = log.
  Service lists use spaces: ocx agentmemory. Omitting the command shows status.

${bold("SERVICES MANAGED:")}
${SERVICE_IDS.map(id => {
  const svc = SERVICES[id];
  return `  ${cyan(svc.id.padEnd(14))} ${svc.description} ${dim(`(${svc.defaultUrl})`)}`;
}).join("\n")}
  ${cyan("proxy".padEnd(14))} Built-in HTTP/SSE/WebSocket proxy (no web dashboard)

${bold("OPTIONS:")}
  ${gray("-n, --lines <num>")}     Number of log lines to show (logs only; default: 50)
  ${gray("-f, --follow")}          Follow log output in real-time (logs only)
  ${gray("--json")}                JSON for status, start/up, restart, update and stats
  ${gray("--repo")}                Open GitHub repositories instead of dashboards (open only)
  ${gray("-ui, --ui")}             Open the interactive dashboard (status only, requires a TTY)
  ${gray("--models <list>")}       pxpipe model allowlist (start/up and start/up/restart proxy)

${bold("PROXY OPTIONS (start/up/restart proxy):")}
  Put proxy immediately after the command, then the upstream URL and options.
  ${gray("--listen <url>")}          HTTP loopback address (fresh default: http://127.0.0.1:10101)
  ${gray("--interceptor <file.mjs>")} JavaScript hooks loaded at startup; quote paths with spaces
  ${gray("--preset <name>")}         pxpipe | headroom | rtk | headroom-pxpipe | rtk-pxpipe |
                            rtk-headroom-pxpipe | none (fresh default: none)
  ${gray("--headroom-url <url>")}     Headroom service (default: http://127.0.0.1:8787)
  ${gray("--rtk-filter <name>")}      Fixed rtk pipe filter; --rtk-filter= restores auto-detection
  ${gray("--max-body-bytes <num>")}   Positive integer; buffered request / WebSocket limit
                            (default: 67108864 bytes = 64 MiB)
  Saved proxy options are reused when omitted. To change a running proxy, use restart proxy.

${bold("START DEFAULTS AND MODEL VALUES:")}
  Without service targets, start/up launches ocx, agentmemory, then proxy with:
    upstream: http://127.0.0.1:10100/   listen: http://127.0.0.1:10102   preset: pxpipe
    models: gpt-6-astra,google-antigravity/gemini-3.8*,anthropic/claude-fable*
  config pxpipe-models=<list> saves a replacement list; --models overrides it.
  Model names are comma-separated; a trailing * matches a prefix (include provider names).
  All models are forwarded; the list selects which ones pxpipe may process.
  Value options accept --flag value or --flag=value. Quote lists, wildcards and spaced paths.
  --models= restores pxpipe's default model selection; --models "" also works if the shell
  preserves empty arguments. Bare --models without a value is an error.

${bold("SELF AND SERVICE UPDATES:")}
  'update' without targets updates aih's global npm installation, not managed services.
  Standalone executables must be rebuilt; npm updates do not replace them.
  To update all managed services: aih update pxpipe ocx agentmemory headroom
  In the live dashboard, select a service with up/down and press u to update it.
  Only running services are restarted; stopped services stay stopped.

${bold("CODEX CONFIGURATION:")}
  Starting aih's proxy, or ocx with an active proxy, updates Codex's two base URLs.
  Respects CODEX_HOME; set AIH_CODEX_AUTOCONFIG=0 to leave config.toml untouched.

${bold("EXAMPLES - STATUS, DASHBOARDS AND LOGS:")}
  ${dim("$")} ${cyan("npx @drakonkat/ai-helper")} status
  ${dim("$")} ${cyan(CLI_NAME)} status ocx proxy --json
  ${dim("$")} ${cyan(CLI_NAME)} status --ui
  ${dim("$")} ${cyan(CLI_NAME)} open agentmemory
  ${dim("$")} ${cyan(CLI_NAME)} open ocx proxy --repo
  ${dim("$")} ${cyan(CLI_NAME)} logs proxy --lines 100 --follow
  ${dim("$")} ${cyan(CLI_NAME)} logs ocx -n=20
  ${dim("$")} ${cyan(CLI_NAME)} stats proxy --json

${bold("EXAMPLES - START, STOP AND UPDATE:")}
  ${dim("$")} ${cyan(CLI_NAME)} start
  ${dim("$")} ${cyan(CLI_NAME)} config pxpipe-models="gpt-6-astra,claude-opus-5-5"
  ${dim("$")} ${cyan(CLI_NAME)} start --models "gpt-6-astra,anthropic/claude-fable*" --json
  ${dim("$")} ${cyan(CLI_NAME)} up --models="google-antigravity/gemini-3.8*"
  ${dim("$")} ${cyan(CLI_NAME)} start --models=   ${dim("# Use pxpipe's default model selection")}
  ${dim("$")} ${cyan(CLI_NAME)} start ocx agentmemory
  ${dim("$")} ${cyan(CLI_NAME)} stop ocx agentmemory proxy
  ${dim("$")} ${cyan(CLI_NAME)} restart ocx --json
  ${dim("$")} ${cyan(CLI_NAME)} update           ${dim("# Update aih itself from npm")}
  ${dim("$")} ${cyan(CLI_NAME)} ocx update
  ${dim("$")} ${cyan(CLI_NAME)} update ocx agentmemory --json
  ${dim("$")} ${cyan(CLI_NAME)} install          ${dim("# Build/install standalone binary; requires Bun")}

${bold("EXAMPLES - PROXY CONFIGURATION:")}
  ${dim("$")} ${cyan(CLI_NAME)} start proxy http://127.0.0.1:10100/ --listen http://127.0.0.1:10102 --preset pxpipe --models "gpt-6-astra,anthropic/claude-fable*"
  ${dim("$")} ${cyan(CLI_NAME)} restart proxy --models "google-antigravity/gemini-3.8*"
  ${dim("$")} ${cyan(CLI_NAME)} restart proxy --preset headroom-pxpipe --headroom-url http://127.0.0.1:8787
  ${dim("$")} ${cyan(CLI_NAME)} restart proxy --preset rtk-pxpipe --rtk-filter git-diff
  ${dim("$")} ${cyan(CLI_NAME)} restart proxy --models= --rtk-filter=
  ${dim("$")} ${cyan(CLI_NAME)} restart proxy --interceptor "./my hooks/interceptor.mjs" --max-body-bytes=33554432
`);
}

function printVersion() {
  const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`;
  console.log(`${bold(cyan(CLI_NAME))} version ${bold(VERSION)} (${runtime}, ${process.platform}-${process.arch})`);
}

function printCodexConfig(result) {
  const config = result.codexConfig;
  if (config?.message) console.log((config.status === "warning" ? yellow : dim)(`  ${config.message}`));
}

async function runInstall() {
  printBanner();
  console.log(cyan("⚙  Building standalone binary and installing to ~/.local/bin...\n"));

  if (typeof Bun === "undefined") {
    console.log(yellow("Notice: Standalone compilation via 'install' uses Bun."));
    console.log("If you are using npm/Node, you can install globally with:\n");
    console.log(cyan("  npm install -g ai-helper\n"));
    return;
  }

  const localBinDir = getLocalBinDir();
  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? `${CLI_NAME}.exe` : CLI_NAME;
  const targetPath = join(localBinDir, binaryName);
  const tempBuildPath = join(process.cwd(), "dist", binaryName);

  try {
    const buildProc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../scripts/build.js"), tempBuildPath],
      { stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await buildProc.exited;
    if (exitCode !== 0) {
      const err = await new Response(buildProc.stderr).text();
      console.log(red(`✖ Build failed: ${err}`));
      process.exit(1);
    }

    console.log(green(`✓ Built standalone executable: ${tempBuildPath}`));

    ensureDir(localBinDir);
    copyFileSync(tempBuildPath, targetPath);
    console.log(green(`✓ Installed binary to: ${targetPath}`));

    console.log(dim("\nChecking PATH configuration..."));
    if (isLocalBinInPath()) {
      console.log(green(`\n🎉 Success! '${localBinDir}' is already in your PATH.`));
      console.log(dim(`You can now run '${CLI_NAME}' from any terminal window.\n`));
    } else {
      console.log(yellow(`\n⚠ Notice: '${localBinDir}' is NOT in your current PATH.`));
      console.log(`To make '${CLI_NAME}' available everywhere, run the following command:\n`);

      const instructions = getAddToPathInstructions();
      if (isWindows) {
        console.log(bold("PowerShell (User Environment):"));
        console.log(cyan(`  ${instructions.powershell}\n`));
        console.log(bold("Command Prompt (CMD):"));
        console.log(cyan(`  ${instructions.cmd}\n`));
      } else {
        console.log(bold("Bash / Zsh:"));
        console.log(cyan(`  ${instructions.bash}\n`));
      }
      console.log(dim("After running the command above, restart your terminal to apply changes.\n"));
    }
  } catch (err) {
    console.log(red(`✖ Installation error: ${err?.message || err}`));
    process.exit(1);
  }
}

export async function main({ updateSelfImpl = updateSelf } = {}) {
  const rawArgs = process.argv.slice(2);

  if (["start", "up", "restart"].includes(rawArgs[0]) && rawArgs[1] === "proxy" && !rawArgs.includes("--help") && !rawArgs.includes("-h")) {
    const { values, positionals } = parseArgs({ args: rawArgs.slice(2), allowPositionals: true, options: {
      listen: { type: "string" }, interceptor: { type: "string" },
      preset: { type: "string" }, models: { type: "string" },
      "headroom-url": { type: "string" }, "rtk-filter": { type: "string" },
      "max-body-bytes": { type: "string" }, json: { type: "boolean" },
    } });
    if (positionals.length > 1) throw new Error("Expected one upstream URL");
    const options = {};
    if (positionals[0]) options.upstream = positionals[0];
    if (values.listen !== undefined) options.listen = values.listen;
    if (values.interceptor !== undefined) options.interceptor = values.interceptor;
    for (const [flag, key] of Object.entries({ preset: "preset", models: "models", "headroom-url": "headroomUrl", "rtk-filter": "rtkFilter" })) {
      if (values[flag] !== undefined) options[key] = values[flag];
    }
    if (values["max-body-bytes"] !== undefined) options.maxBodyBytes = values["max-body-bytes"];
    if (rawArgs[0] !== "restart") await checkForUpdates();
    const result = rawArgs[0] === "restart"
      ? await manager.restartService("proxy", options)
      : await manager.startService("proxy", options);
    if (values.json) console.log(JSON.stringify(result));
    else if (result.success) console.log(green(`Proxy ${result.alreadyRunning ? "already running" : "started"} (PID: ${result.pid}) at ${result.url}`));
    else console.error(red(result.message));
    if (!values.json) printCodexConfig(result);
    if (!result.success) process.exitCode = 1;
    return;
  }

  let jsonOutput = false;
  let follow = false;
  let uiMode = false;
  let repoMode = false;
  let lines = 50;
  let models;
  const positionalArgs = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--repo") {
      repoMode = true;
    } else if (arg === "-ui" || arg === "--ui") {
      uiMode = true;
    } else if (arg === "-f" || arg === "--follow") {
      follow = true;
    } else if (arg === "-n" || arg === "--lines") {
      const next = rawArgs[i + 1];
      if (next && !next.startsWith("-")) {
        lines = parseInt(next, 10) || 50;
        i++;
      }
    } else if (arg.startsWith("-n=")) {
      lines = parseInt(arg.slice(3), 10) || 50;
    } else if (arg.startsWith("--lines=")) {
      lines = parseInt(arg.slice(8), 10) || 50;
    } else if (arg === "--models") {
      const next = rawArgs[i + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("--models requires a value (use --models= for an empty list)");
      models = next;
      i++;
    } else if (arg.startsWith("--models=")) {
      models = arg.slice(9);
    } else if (arg === "-h" || arg === "--help" || arg === "help") {
      printHelp();
      return;
    } else if (arg === "-v" || arg === "--version" || arg === "version") {
      printVersion();
      return;
    } else if (!arg.startsWith("-")) {
      positionalArgs.push(arg);
    }
  }

  const serviceFirstUpdate = positionalArgs[1]?.toLowerCase() === "update" && positionalArgs[0]?.toLowerCase() !== "update";
  const command = serviceFirstUpdate ? "update" : positionalArgs[0]?.toLowerCase() || "status";
  const targets = serviceFirstUpdate ? [positionalArgs[0].toLowerCase()] : positionalArgs.slice(1);

  switch (command) {
    case "config": {
      if (targets.length !== 1 || !targets[0].startsWith("pxpipe-models=") || rawArgs.some(arg => arg.startsWith("-"))) {
        throw new Error('Usage: aih config pxpipe-models="model1,model2" (use pxpipe-models= for pxpipe defaults)');
      }
      const state = manager.readState();
      state.config = { ...state.config, pxpipeModels: targets[0].slice("pxpipe-models=".length) };
      manager.saveState(state);
      console.log(green(`Saved pxpipe-models=${state.config.pxpipeModels}; applies on the next proxy start or restart.`));
      break;
    }
    case "update": {
      const ids = [...new Set(targets)];
      const invalid = ids.filter(id => !SERVICE_IDS.includes(id));
      const invalidOption = rawArgs.find(arg => arg.startsWith("-") && arg !== "--json");
      let results;
      // Validate the entire request before updating anything, including the
      // service-first alias (which accepts exactly one service).
      if (invalidOption) {
        results = [{ id: targets[0] || null, success: false, message: `Unsupported update option '${invalidOption}'. Only --json is supported.` }];
      } else if (serviceFirstUpdate && positionalArgs.length !== 2) {
        results = [{ id: targets[0], success: false, message: `Usage: ${CLI_NAME} <service> update [--json]; use '${CLI_NAME} update <services...>' for multiple services.` }];
      } else if (invalid.length) {
        results = invalid.map(id => ({ id, success: false, message: id === "proxy"
          ? "The built-in proxy is updated with ai-helper itself; run 'aih update' or rebuild its standalone executable."
          : `Unsupported service '${id}'. Updatable services: ${SERVICE_IDS.join(", ")}.` }));
      } else {
        if (!jsonOutput) printBanner();
        results = [];
        for (const id of ids.length ? ids : [CLI_NAME]) {
          if (!jsonOutput) process.stdout.write(`  Updating ${bold(id)}... `);
          let result;
          try {
            result = id === CLI_NAME ? await updateSelfImpl() : await manager.updateService(id);
          } catch (err) {
            result = { success: false, message: err?.message || String(err) };
          }
          results.push({ id, ...result });
          if (!jsonOutput) {
            console.log((result.success ? green : red)(result.message || `${id}: ${result.success ? "updated" : "update failed"}`));
            printCodexConfig(result);
          }
        }
      }
      if (jsonOutput) console.log(JSON.stringify(results, null, 2));
      else if (invalidOption || invalid.length || (serviceFirstUpdate && positionalArgs.length !== 2)) {
        for (const result of results) console.error(red(result.message));
      }
      if (results.some(result => !result.success)) process.exitCode = 1;
      break;
    }
    case "stats": {
      if (targets.length > 1 || (targets[0] && targets[0] !== "proxy")) throw new Error("Usage: aih stats proxy [--json]");
      const stats = readProxyStats();
      if (jsonOutput) console.log(JSON.stringify(stats, null, 2));
      else {
        console.log(proxyStatsLines(stats).join("\n"));
        if (stats) console.log(`  Dal ${stats.since} | aggiornato ${stats.updatedAt}`);
        for (const event of stats?.recent.slice(-5) || []) {
          console.log(`  ${event.at} ${event.transport} ${event.model} ${event.preset}: ${event.error ? "errore" : `${event.saved} token stimati`}`);
          for (const stage of event.stages) console.log(`    ${stage.name}: ${stage.saved ?? "?"} (${stage.reason}, ${stage.method})`);
        }
      }
      break;
    }
    case "status":
    case "ps":
    case "ls":
    case "list": {
      // Interactive mode needs a real terminal: piping or redirecting falls
      // back to the plain table so scripts keep working.
      if (uiMode && !jsonOutput && process.stdout.isTTY && process.stdin.isTTY) {
        const { runDashboard } = await import("./tui.js");
        await runDashboard();
        return;
      }

      const statuses = await manager.getStatus(targets.length > 0 ? targets : undefined);

      if (jsonOutput) {
        console.log(JSON.stringify(statuses, null, 2));
        return;
      }

      printBanner();

      const headers = [
        "SERVICE",
        "STATUS",
        { header: "PID", align: "right" },
        { header: "UPTIME", align: "right" },
        "ADDRESS",
        "REPO",
        "COMMAND",
      ];

      const rows = statuses.map(s => [
        bold(s.id),
        badgeStatus(s.status),
        s.pid ? String(s.pid) : dim("-"),
        s.status === "running" ? s.uptime : dim("-"),
        s.id === "proxy" ? dim(`${s.url} (proxy)`) : s.status === "running" && s.url && s.url !== "-"
          ? cyan(underline(s.url))
          : dim(s.url || "-"),
        s.repositoryUrl ? cyan(underline(s.repositoryUrl)) : dim("-"),
        dim(s.command),
      ]);

      console.log(renderTable(headers, rows));
      console.log("");
      console.log(dim(`Use '${CLI_NAME} open [service]' to open dashboards in browser or '${CLI_NAME} start' to launch.`));
      break;
    }

    case "open":
    case "dashboard":
    case "dash": {
      printBanner();
      const svcsToOpen = targets.length > 0 ? targets : undefined;
      if (repoMode) {
        const opened = await manager.openRepository(svcsToOpen);
        if (!opened.length) console.log(yellow("No GitHub repositories available to open."));
        for (const item of opened) console.log(`  ${bold(item.name)}: ${cyan(underline(item.url))}`);
        break;
      }
      const opened = await manager.openDashboard(svcsToOpen);

      if (opened.length === 0) {
        console.log(yellow("⚠ No dashboard URLs available to open."));
        console.log(dim(`Run '${CLI_NAME} status' to check running services.\n`));
        return;
      }

      console.log(green(`🌐 Opening ${opened.length} dashboard(s) in your default browser:\n`));
      for (const item of opened) {
        console.log(`  • ${bold(item.name)}: ${cyan(underline(item.url))} ${item.status === "running" ? green("(Running)") : dim("(Stopped)")}`);
      }
      console.log("");
      break;
    }

    case "start":
    case "up": {
      await checkForUpdates();
      if (!jsonOutput) printBanner();
      const svcsToStart = targets.length > 0 ? targets : ["ocx", "agentmemory", "proxy"];
      if (!jsonOutput) console.log(cyan(`Starting service(s): ${svcsToStart.join(", ")}...\n`));
      const results = [];

      for (const id of svcsToStart) {
        if (!jsonOutput) process.stdout.write(`  Launching ${bold(id)}... `);
        const res = await manager.startService(id, !targets.length && id === "proxy" ? {
          upstream: "http://127.0.0.1:10100/",
          listen: "http://127.0.0.1:10102",
          preset: "pxpipe",
          models: models ?? manager.readState().config?.pxpipeModels ?? "gpt-6-astra,google-antigravity/gemini-3.8*,anthropic/claude-fable*",
        } : id === "proxy" && models !== undefined ? { models } : undefined);
        results.push({ id, ...res });
        if (jsonOutput) continue;
        if (res.success) {
          if (res.alreadyRunning) {
            console.log(yellow(`already running (PID: ${res.pid})`));
          } else {
            console.log(green(`started (PID: ${res.pid})`));
          }
        } else {
          console.log(red(`failed: ${res.message}`));
        }
        printCodexConfig(res);
      }
      console.log(jsonOutput ? JSON.stringify(results, null, 2) : "");
      break;
    }

    case "stop":
    case "down": {
      printBanner();
      const svcsToStop = targets.length > 0 ? targets : Object.keys(manager.readState().services);
      console.log(cyan(`Stopping service(s): ${svcsToStop.join(", ")}...\n`));

      for (const id of svcsToStop) {
        process.stdout.write(`  Stopping ${bold(id)}... `);
        const res = await manager.stopService(id);
        if (res.success) {
          console.log(green(res.message));
        } else {
          console.log(red(res.message));
        }
      }
      console.log("");
      break;
    }

    case "restart": {
      if (!jsonOutput) printBanner();
      const svcsToRestart = targets.length > 0 ? targets : Object.keys(manager.readState().services);
      if (!jsonOutput) console.log(cyan(`Restarting service(s): ${svcsToRestart.join(", ")}...\n`));
      const results = [];

      for (const id of svcsToRestart) {
        if (!jsonOutput) process.stdout.write(`  Restarting ${bold(id)}... `);
        const res = await manager.restartService(id);
        results.push({ id, ...res });
        if (jsonOutput) continue;
        if (res.success) {
          console.log(green(`started (PID: ${res.pid})`));
        } else {
          console.log(red(`failed: ${res.message}`));
        }
        printCodexConfig(res);
      }
      console.log(jsonOutput ? JSON.stringify(results, null, 2) : "");
      break;
    }

    case "logs":
    case "log": {
      const targetService = targets[0];
      if (!targetService) {
        console.log(red("✖ Error: Please specify a service name for logs."));
        console.log(`Available services: ${SERVICE_IDS.join(", ")}`);
        console.log(`Example: ${cyan(`${CLI_NAME} logs pxpipe -f`)}\n`);
        process.exit(1);
      }

      if (!SERVICE_IDS.includes(targetService) && targetService !== "proxy") {
        console.log(yellow(`⚠ Warning: '${targetService}' is not a standard service. Looking for log file anyway...`));
      }

      await manager.showLogs(targetService, lines, follow);
      break;
    }

    case "install": {
      await runInstall();
      break;
    }

    default: {
      console.log(red(`✖ Unknown command: '${command}'\n`));
      printHelp();
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(red(`[aih] Fatal error: ${err?.message || err}`));
  process.exit(1);
});
