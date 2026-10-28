import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Directories where user-level installers put executables. A freshly installed
 * tool is not on this process's PATH yet, so verification and startup would miss it.
 */
export function toolSearchDirectories({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync, list = readdirSync } = {}) {
  const dirs = [join(home, ".local", "bin")];
  const pythons = root => {
    try {
      return list(root).filter(name => /^Python3\d+$/i.test(name)).sort().reverse().flatMap(name => [join(root, name), join(root, name, "Scripts")]);
    } catch { return []; }
  };
  if (platform === "win32") {
    if (env.LOCALAPPDATA) dirs.push(...pythons(join(env.LOCALAPPDATA, "Programs", "Python")));
    if (env.ProgramFiles) dirs.push(...pythons(env.ProgramFiles));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  return dirs.filter(dir => exists(dir));
}

/** Append (never prepend) missing tool directories to this process's PATH. */
export function refreshToolPath(options = {}) {
  const env = options.env || process.env;
  const current = (env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  const same = (a, b) => (options.platform || process.platform) === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const added = toolSearchDirectories({ ...options, env }).filter(dir => !current.some(entry => same(entry, dir)));
  if (added.length) env.PATH = [...current, ...added].join(delimiter);
  return added;
}


