import { APP_NAME, CLI_NAME, SERVICES, SERVICE_IDS, VERSION } from "./config.js";
import { manager } from "./manager.js";
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

function printHelp() {
  printBanner();
  console.log(`${bold("USAGE:")}
  ${cyan(CLI_NAME)} ${yellow("<command>")} [options] [services...]

${bold("COMMANDS:")}
  ${yellow("status")}, ${yellow("ps")}              Show status, PID, uptime, and web dashboard URLs
  ${yellow("status -ui")}              Interactive live dashboard: manage services and watch the AI pipeline
  ${yellow("open")}, ${yellow("dash")} [services...]  Open web dashboard(s) directly in your default browser
  ${yellow("start")}, ${yellow("up")} [services...]   Start all or specified services (pxpipe, ocx, agentmemory, headroom)
  ${yellow("stop")}, ${yellow("down")} [services...]   Stop all or specified services
  ${yellow("restart")} [services...]      Restart all or specified services
  ${yellow("logs")} <service> [-n 50] [-f]  View or stream live logs for a service
  ${yellow("install")}                  Build standalone binary to ~/.local/bin and verify PATH
  ${yellow("version")}, ${yellow("-v")}            Show version information
  ${yellow("help")}, ${yellow("-h")}               Show this help message

${bold("SERVICES MANAGED:")}
${SERVICE_IDS.map(id => {
  const svc = SERVICES[id];
  return `  ${cyan(svc.id.padEnd(14))} ${svc.description} ${dim(`(${svc.defaultUrl})`)}`;
}).join("\n")}

${bold("OPTIONS:")}
  ${gray("-n, --lines <num>")}     Number of log lines to show (default: 50)
  ${gray("-f, --follow")}          Follow log output in real-time
  ${gray("--json")}                Output results in JSON format
  ${gray("-ui, --ui")}             Open the interactive dashboard (status only, requires a TTY)

${bold("EXAMPLES:")}
  ${dim("$")} ${cyan("npx ai-helper")} status
  ${dim("$")} ${cyan(CLI_NAME)} open                ${dim("# Opens all running dashboards in browser")}
  ${dim("$")} ${cyan(CLI_NAME)} open agentmemory    ${dim("# Opens agentmemory dashboard")}
  ${dim("$")} ${cyan(CLI_NAME)} start
  ${dim("$")} ${cyan(CLI_NAME)} stop pxpipe
  ${dim("$")} ${cyan(CLI_NAME)} restart ocx
  ${dim("$")} ${cyan(CLI_NAME)} logs pxpipe -f
`);
}

function printVersion() {
  const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`;
  console.log(`${bold(cyan(CLI_NAME))} version ${bold(VERSION)} (${runtime}, ${process.platform}-${process.arch})`);
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
      [
        process.execPath,
        "build",
        "--compile",
        "--minify",
        `--outfile=${tempBuildPath}`,
        join(import.meta.dir, "index.js"),
      ],
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

export async function main() {
  const rawArgs = process.argv.slice(2);

  let jsonOutput = false;
  let follow = false;
  let uiMode = false;
  let lines = 50;
  const positionalArgs = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
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

  const command = positionalArgs[0]?.toLowerCase() || "status";
  const targets = positionalArgs.slice(1);

  switch (command) {
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
        "DASHBOARD / URL",
        "COMMAND",
      ];

      const rows = statuses.map(s => [
        bold(s.id),
        badgeStatus(s.status),
        s.pid ? String(s.pid) : dim("-"),
        s.status === "running" ? s.uptime : dim("-"),
        s.status === "running" && s.url && s.url !== "-"
          ? cyan(underline(s.url))
          : dim(s.url || "-"),
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
      printBanner();
      const svcsToStart = targets.length > 0 ? targets : SERVICE_IDS;
      console.log(cyan(`Starting service(s): ${svcsToStart.join(", ")}...\n`));

      for (const id of svcsToStart) {
        process.stdout.write(`  Launching ${bold(id)}... `);
        const res = await manager.startService(id);
        if (res.success) {
          if (res.alreadyRunning) {
            console.log(yellow(`already running (PID: ${res.pid})`));
          } else {
            console.log(green(`started (PID: ${res.pid})`));
          }
        } else {
          console.log(red(`failed: ${res.message}`));
        }
      }
      console.log("");
      break;
    }

    case "stop":
    case "down": {
      printBanner();
      const svcsToStop = targets.length > 0 ? targets : SERVICE_IDS;
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
      printBanner();
      const svcsToRestart = targets.length > 0 ? targets : SERVICE_IDS;
      console.log(cyan(`Restarting service(s): ${svcsToRestart.join(", ")}...\n`));

      for (const id of svcsToRestart) {
        process.stdout.write(`  Restarting ${bold(id)}... `);
        const res = await manager.restartService(id);
        if (res.success) {
          console.log(green(`started (PID: ${res.pid})`));
        } else {
          console.log(red(`failed: ${res.message}`));
        }
      }
      console.log("");
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

      if (!SERVICE_IDS.includes(targetService)) {
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
