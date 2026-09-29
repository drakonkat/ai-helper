import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser';

const URL_KEYS = ['openai_base_url', 'experimental_realtime_ws_base_url'];

class ConfigWarning extends Error {}

function warning(message) {
    throw new ConfigWarning(message);
}

function listenerUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        warning('Codex configuration skipped: the proxy listener URL is invalid.');
    }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.port === '0' || url.pathname !== '/' || url.search || url.hash) {
        warning('Codex configuration requires an HTTP loopback proxy listener origin with a nonzero port.');
    }
    return `${url.origin}/v1`;
}

function parseConfig(source) {
    try {
        const ast = parseTOML(source, { tomlVersion: '1.0.0' });
        return { ast, values: getStaticTOMLValue(ast) };
    } catch {
        // Parser errors can quote tokens containing credentials: never expose them.
        warning('Codex config.toml is not valid supported TOML; it was left unchanged.');
    }
}

function rewriteConfig(original, url) {
    const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
    const source = original.slice(bom.length);
    const { ast, values } = parseConfig(source);
    const body = ast.body[0].body;
    const edits = [];
    const missing = [];

    const profile = typeof values.profile === 'string' && values.profiles
        && Object.hasOwn(values.profiles, values.profile) ? values.profiles[values.profile] : null;
    if (profile && URL_KEYS.some(key => Object.hasOwn(profile, key) && profile[key] !== url)) {
        warning('The active Codex profile overrides proxy URL settings; config.toml was left unchanged. Update that profile explicitly.');
    }

    for (const key of URL_KEYS) {
        if (!Object.hasOwn(values, key)) {
            missing.push(key);
            continue;
        }
        const node = body.find(entry => entry.type === 'TOMLKeyValue' && entry.key.keys.length === 1
            && (entry.key.keys[0].name ?? entry.key.keys[0].value) === key);
        if (typeof values[key] !== 'string' || !node || node.value.kind !== 'string') {
            warning(`Codex ${key} must be a root-level string; config.toml was left unchanged.`);
        }
        if (values[key] !== url) {
            edits.push({ start: node.value.range[0], end: node.value.range[1], text: JSON.stringify(url) });
        }
    }

    if (missing.length) {
        const firstNewline = source.indexOf('\n');
        const newline = firstNewline > 0 && source[firstNewline - 1] === '\r' ? '\r\n' : '\n';
        const table = body.find(entry => entry.type === 'TOMLTable');
        // Insert at the table's line start, not inside its indentation or a string.
        const at = table ? source.lastIndexOf('\n', table.range[0] - 1) + 1 : source.length;
        const prefix = at > 0 && source[at - 1] !== '\n' ? newline : '';
        const lines = missing.map(key => `${key} = ${JSON.stringify(url)}`).join(newline);
        edits.push({ start: at, end: at, text: `${prefix}${lines}${newline}` });
    }

    let result = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }
    const verified = parseConfig(result).values;
    if (URL_KEYS.some(key => verified[key] !== url)) {
        warning('Could not safely set the root Codex proxy URLs; config.toml was left unchanged.');
    }
    return bom + result;
}

function statOrNull(file) {
    try {
        return fs.lstatSync(file);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function sameStat(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size
        && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function snapshot(file) {
    const stat = statOrNull(file);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
        warning('Codex config.toml is a link or not a regular file; automatic configuration was skipped.');
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const before = fs.fstatSync(fd);
        const bytes = fs.readFileSync(fd);
        if (!sameStat(stat, before) || !sameStat(before, fs.fstatSync(fd))) {
            warning('Codex config.toml changed concurrently; automatic configuration was skipped. Retry when the other writer is finished.');
        }
        const source = bytes.toString('utf8');
        if (!Buffer.from(source, 'utf8').equals(bytes)) {
            warning('Codex config.toml is not valid UTF-8; it was left unchanged.');
        }
        return { stat, bytes, source };
    } finally {
        fs.closeSync(fd);
    }
}

function assertUnchanged(file, original) {
    const current = snapshot(file);
    if (Boolean(current) !== Boolean(original)
        || (current && (!sameStat(original.stat, current.stat) || !original.bytes.equals(current.bytes)))) {
        warning('Codex config.toml changed concurrently; automatic configuration was skipped. Retry when the other writer is finished.');
    }
}

function backupOriginal(file, bytes) {
    let fd;
    let complete = false;
    try {
        fd = fs.openSync(file, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        complete = true;
    } catch (error) {
        if (fd === undefined && error.code === 'EEXIST') {
            const existing = statOrNull(file);
            if (existing?.isFile() && !existing.isSymbolicLink()) return;
            warning('The Codex backup path is not a regular file; automatic configuration was skipped.');
        }
        throw error;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
            if (!complete) {
                try { fs.unlinkSync(file); } catch { /* Keep the original config intact. */ }
            }
        }
    }
}

/**
 * Point only Codex's two root URL keys at a ready, local AIH proxy listener.
 * Synchronous and nonthrowing. env/home injection keeps tests away from real configs.
 * The caller owns proxy readiness; this function never changes provider/profile URLs.
 */
export function syncCodexProxyConfig(proxyUrl, options = {}) {
    const env = options.env ?? process.env;
    if (env.AIH_CODEX_AUTOCONFIG === '0') {
        return { status: 'skipped', message: 'Automatic Codex proxy configuration is disabled (AIH_CODEX_AUTOCONFIG=0).' };
    }

    let configPath;
    let url;
    let lockPath;
    let lockFd;
    let lockStat;
    let tempPath;
    try {
        url = listenerUrl(proxyUrl);
        const home = options.home ?? os.homedir();
        const configDir = path.resolve(typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
            ? env.CODEX_HOME : path.join(home, '.codex'));
        configPath = path.join(configDir, 'config.toml');
        const directory = statOrNull(configDir);
        if (directory && (directory.isSymbolicLink() || !directory.isDirectory())) {
            warning('The Codex configuration directory is a link or not a directory; automatic configuration was skipped.');
        }
        const original = snapshot(configPath);
        const next = rewriteConfig(original?.source ?? '', url);
        if (original?.source === next) return { status: 'unchanged', path: configPath, url };

        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        lockPath = `${configPath}.aih.lock`;
        try {
            lockFd = fs.openSync(lockPath, 'wx', 0o600);
        } catch (error) {
            if (error.code === 'EEXIST') {
                warning('Codex configuration is locked by another AIH operation; it was left unchanged. Retry later.');
            }
            throw error;
        }
        lockStat = fs.fstatSync(lockFd);
        assertUnchanged(configPath, original);

        tempPath = `${configPath}.aih-${process.pid}-${randomUUID()}.tmp`;
        const tempFd = fs.openSync(tempPath, 'wx', 0o600);
        try {
            fs.writeFileSync(tempFd, next, 'utf8');
            fs.fsyncSync(tempFd);
        } finally {
            fs.closeSync(tempFd);
        }
        const backupPath = original ? `${configPath}.aih.bak` : undefined;
        if (original) backupOriginal(backupPath, original.bytes);
        assertUnchanged(configPath, original);
        if (original) {
            fs.renameSync(tempPath, configPath);
            tempPath = undefined;
        } else {
            // Unlike rename, an atomic link cannot overwrite a concurrently created file.
            fs.linkSync(tempPath, configPath);
        }
        return {
            status: 'updated', path: configPath, url,
            message: `Codex proxy URLs set to ${url} (config: ${configPath}${backupPath ? `; backup: ${backupPath}` : ''}).`,
            ...(backupPath ? { backupPath } : {}),
        };
    } catch (error) {
        const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : '';
        return {
            status: 'warning',
            message: error instanceof ConfigWarning ? error.message : `Could not safely update Codex config.toml${code}; automatic configuration was skipped.`,
            ...(configPath ? { path: configPath } : {}),
            ...(url ? { url } : {}),
        };
    } finally {
        if (tempPath) {
            try { fs.unlinkSync(tempPath); } catch { /* Best-effort cleanup; never remove config.toml. */ }
        }
        if (lockFd !== undefined) {
            try { fs.closeSync(lockFd); } catch { /* Best-effort lock cleanup. */ }
            try {
                const current = statOrNull(lockPath);
                if (current && lockStat && current.ino === lockStat.ino && current.dev === lockStat.dev) fs.unlinkSync(lockPath);
            } catch { /* Never hide the update result with a cleanup error. */ }
        }
    }
}
