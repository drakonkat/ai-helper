import { join } from "path";
import { copyFileSync } from "fs";
import { CLI_NAME } from "../src/config.js";
import { getLocalBinDir, isLocalBinInPath, getAddToPathInstructions, ensureDir } from "../src/utils/path.js";
import { bold, cyan, dim, green, red, yellow } from "../src/utils/format.js";

async function run() {
  console.log(bold(cyan(`\n[aih] Building & Deploying ${CLI_NAME} to ~/.local/bin...\n`)));

  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? `${CLI_NAME}.exe` : CLI_NAME;
  const distDir = join(process.cwd(), "dist");
  const distPath = join(distDir, binaryName);
  const localBinDir = getLocalBinDir();
  const destPath = join(localBinDir, binaryName);

  ensureDir(distDir);
  ensureDir(localBinDir);

  console.log(dim(`Target executable: ${distPath}`));
  console.log(dim(`Destination:       ${destPath}\n`));

  // 1. Build standalone executable using Bun
  console.log(cyan("Step 1: Compiling standalone binary with Bun..."));
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "build.js"), distPath],
    { stdout: "pipe", stderr: "pipe" }
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    console.error(red(`✖ Build failed (exit code ${exitCode}): ${err}`));
    process.exit(1);
  }

  console.log(green(`✓ Successfully compiled ${binaryName}`));

  // 2. Copy binary to ~/.local/bin
  console.log(cyan("\nStep 2: Installing to ~/.local/bin..."));
  try {
    copyFileSync(distPath, destPath);
    console.log(green(`✓ Copied binary to ${destPath}`));
  } catch (err) {
    console.error(red(`✖ Failed to copy binary to ${destPath}: ${err?.message || err}`));
    process.exit(1);
  }

  // 3. Verify PATH
  console.log(cyan("\nStep 3: Verifying PATH..."));
  if (isLocalBinInPath()) {
    console.log(green(`✓ '${localBinDir}' is present in your PATH.`));
    console.log(bold(green(`\n🎉 Installation complete! You can now run '${CLI_NAME}' from anywhere in your terminal.\n`)));
  } else {
    console.log(yellow(`⚠ '${localBinDir}' is NOT currently in your PATH environment variable.`));
    console.log(dim("To execute 'aih' directly without specifying the full path, add ~/.local/bin to your PATH:\n"));

    const instructions = getAddToPathInstructions();
    if (isWindows) {
      console.log(bold("PowerShell (Recommended):"));
      console.log(cyan(`  ${instructions.powershell}\n`));
      console.log(bold("Command Prompt (CMD):"));
      console.log(cyan(`  ${instructions.cmd}\n`));
    } else {
      console.log(bold("Bash / Zsh:"));
      console.log(cyan(`  ${instructions.bash}\n`));
    }
    console.log(dim("After executing the command, open a new terminal window to start using 'aih'.\n"));
  }
}

run().catch(err => {
  console.error(red(`✖ Installation failed: ${err?.message || err}`));
  process.exit(1);
});
