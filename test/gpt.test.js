import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ASTRA_MODEL, GPT_URLS, configureCodexForAstra, startGpt } from "../src/gpt.js";

it("selects Astra without changing unrelated TOML, and is idempotent with LF/CRLF", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const existing of ["", '[model_providers.pxpipe-codex] # owned provider\nbase_url = "http://old"\n\n']) {
      const original = ('model = "old-model"\nmodel_provider = "old-provider"\nreasoning = "high"\n\n' +
        existing + '[mcp_servers.example]\ncommand = "keep-me"\n').replace(/\n/g, newline);
      const configured = configureCodexForAstra(original);
      const parsed = Bun.TOML.parse(configured);
      expect(parsed.model).toBe(ASTRA_MODEL);
      expect(parsed.model_provider).toBe("pxpipe-codex");
      expect(parsed.model_providers["pxpipe-codex"].base_url).toBe(`${GPT_URLS.headroom}/v1`);
      expect(parsed.model_providers["pxpipe-codex"].requires_openai_auth).toBe(true);
      expect(parsed.model_providers["pxpipe-codex"].experimental_bearer_token).toBe("local-proxy");
      expect(parsed.reasoning).toBe("high");
      expect(parsed.mcp_servers.example.command).toBe("keep-me");
      expect(configureCodexForAstra(configured)).toBe(configured);
      if (newline === "\r\n") expect(configured.replace(/\r\n/g, "")).not.toContain("\n");
    }
  }
  expect(Bun.TOML.parse(configureCodexForAstra("")).model).toBe(ASTRA_MODEL);
  expect(() => configureCodexForAstra('model = "a"\nmodel = "b"\n')).toThrow("Duplicate");
  expect(() => configureCodexForAstra('instructions = """complex\ncontent"""\n')).toThrow("Unsupported");
  expect(() => configureCodexForAstra('[model_providers.pxpipe-codex.http_headers]\nx = "y"')).toThrow("Unsupported");
});

it("backs up before OCX sync, starts the chain in order, and selects Astra after successful checks", async () => {
  const oldAihHome = process.env.AIH_HOME;
  const home = mkdtempSync(join(tmpdir(), "aih-gpt-"));
  process.env.AIH_HOME = join(home, ".aih");
  const put = (relative, value) => {
    const file = join(home, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
    return file;
  };
  const ocx = { providers: {
    openai: { baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "forward" },
    anthropic: { baseUrl: "http://127.0.0.1:8787", authMode: "oauth" },
  } };
  const ocxPath = put(".opencodex/config.json", JSON.stringify(ocx));
  put(".opencodex/admin-api-token", "test-admin");
  const hrPath = put("custom headroom/settings.json", '{"optimize":true}');
  const original = 'model = "keep-until-ready"\n';
  const synced = original + "# OCX startup sync\n";
  const codexPath = put(".codex/config.toml", original);
  const events = [];
  const running = new Set();
  const pids = { ocx: 1100, pxpipe: 2200, headroom: 3300 };
  const progress = [];
  let failStartup = true;
  let exposeAstra = true;
  let unhealthyHeadroom = false;
  let missingPid = false;
  const options = {
    home, env: { HEADROOM_SETTINGS_PATH: hrPath }, codexHome: join(home, ".codex"), platform: "win32", pause: async () => {},
    withProgress: async (id, start) => {
      progress.push(`launching:${id}`);
      const result = await start();
      progress.push(result);
      return result;
    },
    findPids: async ([port]) => {
      const id = Object.keys(GPT_URLS).find(id => Number(new URL(GPT_URLS[id]).port) === port);
      return !missingPid && running.has(id) ? [pids[id]] : [];
    },
    manager: { startService: async id => {
      const backups = join(home, ".aih", "backups");
      const saved = join(backups, readdirSync(backups)[0], "codex-config.toml");
      expect(readFileSync(saved, "utf8")).toBe(original);
      writeFileSync(codexPath, synced);
      events.push(id);
      running.add(id);
      return { success: true };
    } },
    resolveLaunch: async (id, opts) => {
      expect(opts.home).toBe(home);
      expect(opts.env.HEADROOM_SETTINGS_PATH).toBe(hrPath);
      return { id };
    },
    launchProcess: async ({ id }) => {
      events.push(id);
      expect(running.has("ocx")).toBe(true);
      if (id === "headroom") expect(running.has("pxpipe")).toBe(true);
      expect(JSON.parse(readFileSync(hrPath)).openai_base_url).toBe(GPT_URLS.pxpipe);
      if (failStartup) throw new Error("test startup failure");
      running.add(id);
    },
    request: async (url, request = {}) => {
      if (url.endsWith("/healthz")) {
        if (!running.has("ocx")) throw new Error("offline");
        return { service: "opencodex", status: "ok" };
      }
      if (request.method === "PATCH") {
        const provider = new URL(url).searchParams.get("name");
        expect(request.headers["x-opencodex-api-key"]).toBe("test-admin");
        events.push(provider);
        Object.assign(ocx.providers[provider], JSON.parse(request.body));
        writeFileSync(ocxPath, JSON.stringify(ocx));
        return { success: true };
      }
      if (url === `${GPT_URLS.pxpipe}/proxy-stats`) {
        if (!running.has("pxpipe")) throw new Error("offline");
        return { requests: 0 };
      }
      if (url === `${GPT_URLS.headroom}/health`) {
        if (!running.has("headroom")) throw new Error("offline");
        return { status: "healthy", config: {
          openai_api_url: unhealthyHeadroom ? GPT_URLS.ocx : GPT_URLS.pxpipe, anthropic_api_url: GPT_URLS.pxpipe,
        } };
      }
      if (url === `${GPT_URLS.headroom}/v1/models`) {
        events.push("models");
        return { data: exposeAstra ? [{ id: ASTRA_MODEL }] : [] };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  };
  try {
    await expect(startGpt(options)).rejects.toThrow("test startup failure");
    expect(readFileSync(codexPath, "utf8")).toBe(synced);
    expect(events).toEqual(["ocx", "anthropic", "openai", "pxpipe"]);
    failStartup = false;
    exposeAstra = false;
    await expect(startGpt(options)).rejects.toThrow("does not expose");
    expect(readFileSync(codexPath, "utf8")).toBe(synced);
    expect(events).toEqual(["ocx", "anthropic", "openai", "pxpipe", "pxpipe", "headroom", "models"]);
    exposeAstra = true;
    const result = await startGpt(options);
    expect(readFileSync(join(result.backupDir, "codex-config.toml"), "utf8")).toBe(synced);
    expect(Bun.TOML.parse(readFileSync(codexPath, "utf8")).model).toBe(ASTRA_MODEL);
    expect(ocx.providers.openai.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(JSON.parse(readFileSync(hrPath)).optimize).toBe(true);
    expect(result.services).toEqual(Object.keys(pids).map(id => ({
      id, success: true, alreadyRunning: true, pid: pids[id], url: GPT_URLS[id],
    })));
    expect(progress[0]).toBe("launching:ocx");
    expect(progress[1]).toMatchObject({ id: "ocx", alreadyRunning: false, pid: 1100 });
    expect(progress).toContainEqual(expect.objectContaining({ id: "pxpipe", alreadyRunning: false, pid: 2200 }));
    expect(progress).toContainEqual(expect.objectContaining({ id: "headroom", alreadyRunning: false, pid: 3300 }));
    const second = await startGpt(options);
    expect(second.backupDir).toBeUndefined();
    expect(events.filter(e => e === "ocx")).toHaveLength(1);
    unhealthyHeadroom = true;
    await expect(startGpt(options)).rejects.toThrow("headroom is not ready");
    expect(events.filter(e => e === "headroom")).toHaveLength(1); // An occupied port never triggers a duplicate.
    missingPid = true;
    await expect(startGpt(options)).rejects.toThrow("Cannot determine ocx's listening PID");
    await expect(startGpt({ ...options, platform: "linux" })).rejects.toThrow("requires Windows");
  } finally {
    if (oldAihHome === undefined) delete process.env.AIH_HOME;
    else process.env.AIH_HOME = oldAihHome;
    rmSync(home, { recursive: true, force: true });
  }
});
