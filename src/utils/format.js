import { VERSION, APP_NAME } from "../config.js";

const isColorSupported = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);

function wrap(code, close) {
  return (text) =>
    isColorSupported ? `\x1b[${code}m${text}\x1b[${close}m` : String(text);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);

export const black = wrap(30, 39);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const white = wrap(37, 39);
export const gray = wrap(90, 39);

export const bgGreen = wrap(42, 49);
export const bgRed = wrap(41, 49);
export const bgYellow = wrap(43, 49);
export const bgCyan = wrap(46, 49);

/**
 * Removes ANSI escape sequences for calculating display length.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Returns formatted status badge.
 * @param {"running" | "stopped" | "error"} status
 * @returns {string}
 */
export function badgeStatus(status) {
  switch (status) {
    case "running":
      return green(bold("● RUNNING"));
    case "stopped":
      return gray("○ STOPPED");
    case "error":
      return red(bold("✖ ERROR"));
    default:
      return gray("? UNKNOWN");
  }
}

/**
 * Formats uptime from an ISO timestamp.
 * @param {string} [startedAtIso]
 * @returns {string}
 */
export function formatUptime(startedAtIso) {
  if (!startedAtIso) return "-";
  const start = new Date(startedAtIso).getTime();
  if (isNaN(start)) return "-";

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return `${hours}h ${remMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

/**
 * Formats byte counts into human readable strings.
 * @param {number} [bytes]
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "-";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Renders a clean aligned terminal table.
 * @param {Array<string | { header: string; align?: "left" | "right" | "center" }>} headers
 * @param {Array<Array<string | number>>} rows
 * @returns {string}
 */
export function renderTable(headers, rows) {
  const colDefs = headers.map(h =>
    typeof h === "string" ? { header: h, align: "left" } : h
  );

  const colWidths = colDefs.map((col, colIdx) => {
    let max = stripAnsi(col.header).length;
    for (const row of rows) {
      const cell = row[colIdx] !== undefined ? String(row[colIdx]) : "";
      const len = stripAnsi(cell).length;
      if (len > max) max = len;
    }
    return max;
  });

  function pad(text, width, align = "left") {
    const rawLen = stripAnsi(text).length;
    const diff = Math.max(0, width - rawLen);
    if (align === "right") {
      return " ".repeat(diff) + text;
    } else if (align === "center") {
      const left = Math.floor(diff / 2);
      const right = diff - left;
      return " ".repeat(left) + text + " ".repeat(right);
    }
    return text + " ".repeat(diff);
  }

  const headerLine = colDefs
    .map((col, idx) => bold(cyan(pad(col.header, colWidths[idx], col.align))))
    .join("   ");

  const dividerLine = colWidths
    .map(w => gray("─".repeat(w)))
    .join("   ");

  const bodyLines = rows.map(row => {
    return colDefs
      .map((col, idx) => {
        const cell = row[idx] !== undefined ? String(row[idx]) : "";
        return pad(cell, colWidths[idx], col.align);
      })
      .join("   ");
  });

  return [headerLine, dividerLine, ...bodyLines].join("\n");
}

export function printBanner() {
  console.log(
    `${bold(cyan(APP_NAME))} ${gray(`v${VERSION}`)} ${dim("— Background AI Ecosystem Service Manager")}\n`
  );
}

