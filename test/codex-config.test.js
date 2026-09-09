import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser';
import { syncCodexProxyConfig } from '../src/codex-config.js';

const PROXY = 'http://127.0.0.1:10102';
const URL_VALUE = `${PROXY}/v1`;
const keys = ['openai_base_url', 'experimental_realtime_ws_base_url'];

function fixture(t, content, env = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-config-'));
    t.after(() => {
        const target = path.resolve(home);
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
        assert.ok(path.basename(target).startsWith('aih-codex-config-'));
        fs.rmSync(target, { recursive: true, force: true });
    });
    const dir = path.join(home, '.codex');
    const file = path.join(dir, 'config.toml');
    if (content !== undefined) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, content);
    }
    return { home, dir, file, options: { home, env }, read: () => fs.readFileSync(file, 'utf8') };
}

function values(source) {
    return getStaticTOMLValue(parseTOML(source.replace(/^\uFEFF/, ''), { tomlVersion: '1.0.0' }));
}

function assertUrls(source) {
    const result = values(source);
    for (const key of keys) assert.equal(result[key], URL_VALUE);
}

test('updates only root AST value ranges, preserving quoted keys, comments, CRLF and BOM', t => {
    const original = '\uFEFF# private config\r\n"openai_base_url"  =  \'http://old:123/v1\' # keep me\r\n'
        + "'experimental_realtime_ws_base_url' = \"http://old:123/v1\"\r\n"
        + 'model = "model-a"\r\n[model_providers.custom]\r\nbase_url = "https://upstream.invalid/v1"\r\n';
    const f = fixture(t, original);
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'updated');
    assert.ok(result.message.includes(URL_VALUE));
    assert.ok(result.message.includes(f.file));
    assert.ok(result.message.includes(result.backupPath));
    const expected = original.replace("'http://old:123/v1'", JSON.stringify(URL_VALUE))
        .replace('"http://old:123/v1"', JSON.stringify(URL_VALUE));
    assert.equal(f.read(), expected);
    assert.deepEqual(fs.readFileSync(result.backupPath), Buffer.from(original));
    assertUrls(f.read());
    assert.equal(fs.existsSync(`${f.file}.aih.lock`), false);
});

test('ignores fake root keys and headers inside multiline strings and keeps every profile unchanged', t => {
    const original = 'instructions = """\nopenai_base_url = "fake"\n[not_a_table]\n"""\n'
        + "more = '''\nexperimental_realtime_ws_base_url = 'fake'\n[also_not_a_table]\n'''\n"
        + 'profile = "normal"\n[profiles.normal]\nmodel = "model-a"\n'
        + '[profiles.other]\nopenai_base_url = "http://other/v1"\n'
        + 'experimental_realtime_ws_base_url = "http://other/v1"\n'
        + '[[mcp_servers.example.items]]\nname = "unchanged"\n';
    const f = fixture(t, original);
    assert.equal(syncCodexProxyConfig(PROXY, f.options).status, 'updated');
    const expected = original.replace('[profiles.normal]', keys.map(key => `${key} = "${URL_VALUE}"`).join('\n') + '\n[profiles.normal]');
    assert.equal(f.read(), expected);
    assertUrls(f.read());
    assert.deepEqual(values(f.read()).profiles, values(original).profiles);
});

test('inserts missing key before the first indented table without changing the existing root value', t => {
    const original = `openai_base_url = '${URL_VALUE}' # leave this exact spelling\n  [features]\n  flag = true\n`;
    const f = fixture(t, original);
    assert.equal(syncCodexProxyConfig(PROXY, f.options).status, 'updated');
    assert.equal(f.read(), original.replace('  [features]', `experimental_realtime_ws_base_url = "${URL_VALUE}"\n  [features]`));
    assertUrls(f.read());
});

test('handles escaped quoted root keys and replaces whole multiline target values only', t => {
    const original = '"openai_\\u0062ase_url" = """\nhttp://old:123/v1\n""" # retained\n'
        + "experimental_realtime_ws_base_url = '''http://old:123/v1'''\n"
        + '"unrelated.key" = "leave this"\n';
    const f = fixture(t, original);
    assert.equal(syncCodexProxyConfig(PROXY, f.options).status, 'updated');
    assert.equal(f.read(), '"openai_\\u0062ase_url" = "' + URL_VALUE + '" # retained\n'
        + 'experimental_realtime_ws_base_url = "' + URL_VALUE + '"\n'
        + '"unrelated.key" = "leave this"\n');
    assertUrls(f.read());
});

test('appends missing root keys when there is no table or trailing newline', t => {
    const f = fixture(t, '# a comment without a newline');
    assert.equal(syncCodexProxyConfig(PROXY, f.options).status, 'updated');
    assert.ok(f.read().startsWith('# a comment without a newline\nopenai_base_url'));
    assertUrls(f.read());
});

test('unchanged configuration is byte-identical and creates no backup or lock', t => {
    const original = `openai_base_url = '${URL_VALUE}'\nexperimental_realtime_ws_base_url = """${URL_VALUE}"""\n`;
    const f = fixture(t, original);
    const before = fs.statSync(f.file);
    assert.equal(syncCodexProxyConfig(PROXY, f.options).status, 'unchanged');
    assert.equal(f.read(), original);
    assert.equal(fs.statSync(f.file).mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readdirSync(f.dir), ['config.toml']);
});

test('creates missing configuration with safe URLs and restrictive permissions', t => {
    const f = fixture(t);
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'updated');
    assert.equal(result.path, f.file);
    assert.equal(result.url, URL_VALUE);
    assert.equal(result.backupPath, undefined);
    assertUrls(f.read());
    assert.deepEqual(fs.readdirSync(f.dir), ['config.toml']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test('resolves non-default CODEX_HOME containing spaces, without touching the default directory', t => {
    const f = fixture(t);
    const configured = path.join(f.home, 'custom codex home');
    const result = syncCodexProxyConfig(PROXY, { home: f.home, env: { CODEX_HOME: configured } });
    assert.equal(result.status, 'updated');
    assert.equal(result.path, path.join(configured, 'config.toml'));
    assertUrls(fs.readFileSync(result.path, 'utf8'));
    assert.equal(fs.existsSync(f.dir), false);
});

test('disabled configuration does not validate URL or create files', t => {
    const f = fixture(t, undefined, { AIH_CODEX_AUTOCONFIG: '0' });
    assert.equal(syncCodexProxyConfig('invalid', f.options).status, 'skipped');
    assert.equal(fs.existsSync(f.dir), false);
});

test('preserves the first backup through multiple proxy port changes', t => {
    const original = 'model = "before-aih"\n';
    const f = fixture(t, original);
    const first = syncCodexProxyConfig(PROXY, f.options);
    const second = syncCodexProxyConfig('http://localhost:19090', f.options);
    assert.equal(first.status, 'updated');
    assert.equal(second.status, 'updated');
    assert.equal(fs.readFileSync(first.backupPath, 'utf8'), original);
    assert.equal(values(f.read()).openai_base_url, 'http://localhost:19090/v1');
    assert.equal(first.backupPath, second.backupPath);
});

test('malformed or unsupported root TOML is never rewritten and diagnostics never expose tokens', t => {
    const inputs = ['secret = "DONT_LEAK_ME', 'openai_base_url = 42\n', 'openai_base_url = { url = "x" }\n',
        '[openai_base_url]\nurl = "x"\n', 'openai_base_url.child = "x"\n',
        'openai_base_url = "one"\nopenai_base_url = "two"\n', Buffer.from([0xff, 0xfe, 0x61])];
    for (const content of inputs) {
        const f = fixture(t, content);
        const result = syncCodexProxyConfig(PROXY, f.options);
        assert.equal(result.status, 'warning');
        assert.ok(!result.message.includes('DONT_LEAK_ME'));
        assert.deepEqual(fs.readFileSync(f.file), Buffer.from(content));
        assert.deepEqual(fs.readdirSync(f.dir), ['config.toml']);
    }
});

test('active profile URL override reports warning without altering root or profiles', t => {
    const original = 'profile = "custom"\n[profiles.custom]\nopenai_base_url = "http://custom/v1"\n';
    const f = fixture(t, original);
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'warning');
    assert.match(result.message, /active Codex profile/);
    assert.equal(f.read(), original);
    assert.deepEqual(fs.readdirSync(f.dir), ['config.toml']);
});

test('rejects unsafe or zero-port listener URLs and permits loopback IPv6', t => {
    for (const proxy of ['garbage', 'https://127.0.0.1:10102', 'http://127.0.0.1:0', 'http://0.0.0.0:10102',
        'http://remote.invalid:10102', 'http://user:secret@127.0.0.1:10102', `${PROXY}?secret=x`, `${PROXY}/v1`]) {
        const f = fixture(t);
        assert.equal(syncCodexProxyConfig(proxy, f.options).status, 'warning');
        assert.equal(fs.existsSync(f.dir), false);
    }
    const f = fixture(t);
    assert.equal(syncCodexProxyConfig('http://[::1]:18080', f.options).status, 'updated');
    assert.equal(values(f.read()).openai_base_url, 'http://[::1]:18080/v1');
});

test('existing lock is preserved and prevents all configuration writes', t => {
    const original = 'model = "locked"\n';
    const f = fixture(t, original);
    fs.writeFileSync(`${f.file}.aih.lock`, 'other writer');
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'warning');
    assert.match(result.message, /locked/);
    assert.equal(f.read(), original);
    assert.equal(fs.readFileSync(`${f.file}.aih.lock`, 'utf8'), 'other writer');
    assert.equal(fs.existsSync(`${f.file}.aih.bak`), false);
});

test('backup path conflicts refuse to replace the original and clean owned staging files', t => {
    const original = 'model = "keep"\n';
    const f = fixture(t, original);
    fs.mkdirSync(`${f.file}.aih.bak`);
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'warning');
    assert.match(result.message, /backup path/);
    assert.equal(f.read(), original);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['config.toml', 'config.toml.aih.bak']);
});

test('refuses hard-linked config files rather than silently separating shared configuration', t => {
    const f = fixture(t, 'model = "shared"\n');
    const linked = path.join(f.dir, 'shared.toml');
    fs.linkSync(f.file, linked);
    assert.equal(syncCodexProxyConfig(PROXY, f.options).status, 'warning');
    assert.equal(f.read(), 'model = "shared"\n');
    assert.equal(fs.statSync(linked).nlink, 2);
});

test('detects external edits made during staging and cleans its temporary file and lock', t => {
    const f = fixture(t, 'model = "initial"\n');
    const external = 'model = "external edit"\n';
    const nativeWrite = fs.writeFileSync;
    let edited = false;
    t.mock.method(fs, 'writeFileSync', function (file, ...args) {
        const result = nativeWrite.call(fs, file, ...args);
        if (!edited && typeof file === 'number') {
            edited = true;
            nativeWrite.call(fs, f.file, external);
        }
        return result;
    });
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'warning');
    assert.match(result.message, /concurrently/);
    assert.equal(f.read(), external);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['config.toml', 'config.toml.aih.bak']);
});

test('does not overwrite a newly created config during atomic first creation', t => {
    const f = fixture(t);
    const external = 'model = "created concurrently"\n';
    const nativeLink = fs.linkSync;
    t.mock.method(fs, 'linkSync', function (...args) {
        fs.writeFileSync(f.file, external);
        return nativeLink.apply(fs, args);
    });
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'warning');
    assert.equal(f.read(), external);
    assert.deepEqual(fs.readdirSync(f.dir), ['config.toml']);
});

test('a failing atomic replacement keeps original and backup and removes staging artifacts', t => {
    const original = 'model = "keep"\n';
    const f = fixture(t, original);
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('DO_NOT_LEAK'), { code: 'EACCES' }); });
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'warning');
    assert.match(result.message, /EACCES/);
    assert.ok(!result.message.includes('DO_NOT_LEAK'));
    assert.equal(f.read(), original);
    assert.equal(fs.readFileSync(`${f.file}.aih.bak`, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['config.toml', 'config.toml.aih.bak']);
});

test('refuses a symlinked config instead of replacing the link or target', t => {
    const f = fixture(t, 'model = "original"\n');
    const target = path.join(f.dir, 'real.toml');
    fs.renameSync(f.file, target);
    try {
        fs.symlinkSync(target, f.file, 'file');
    } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink creation not permitted on this host'); return; }
        throw error;
    }
    const result = syncCodexProxyConfig(PROXY, f.options);
    assert.equal(result.status, 'warning');
    assert.ok(fs.lstatSync(f.file).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), 'model = "original"\n');
});
