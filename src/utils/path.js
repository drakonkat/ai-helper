import { homedir } from "os";
import { join, resolve, normalize } from "path";
import { existsSync, mkdirSync } from "fs";

export function getAihDir() {
  const custom = process.env.AIH_HOME;
  if (custom && custom.trim().length > 0) {
    return resolve(custom);
  }
  return join(homedir(), ".aih");
}

export function getStateFilePath() {
  return join(getAihDir(), "state.json");
}

export function getLogsDir() {
  return join(getAihDir(), "logs");
}

export function getServiceLogPath(serviceId) {
  return join(getLogsDir(), `${serviceId}.log`);
}

export function getLocalBinDir() {
  return join(homedir(), ".local", "bin");
}

export function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

export function isLocalBinInPath() {
  const localBin = normalize(resolve(getLocalBinDir())).toLowerCase();
  const pathEnv = process.env.PATH || "";
  const delimiter = process.platform === "win32" ? ";" : ":";

  const entries = pathEnv
    .split(delimiter)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => {
      try {
        return normalize(resolve(p)).toLowerCase();
      } catch {
        return p.toLowerCase();
      }
    });

  return entries.includes(localBin);
}

export function getAddToPathInstructions() {
  const localBin = getLocalBinDir();
  return {
    powershell: `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";${localBin}", "User")`,
    cmd: `setx PATH "%PATH%;${localBin}"`,
    bash: `echo 'export PATH="${localBin}:$PATH"' >> ~/.bashrc && source ~/.bashrc`,
  };
}

