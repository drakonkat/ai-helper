import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import WebSocket, { WebSocketServer } from "ws";
import { normalizePresetOptions, createPresetHooks } from "./proxy-presets.js";

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
const HOOKS = ["onRequest", "onResponse", "onResponseBody", "onResponseChunk", "onWebSocketMessage"];

function parseUrl(value) {
  return new URL(String(value).replace(/^(https?):\/*/i, "$1://"));
}

export function normalizeProxyOptions(options = {}) {
  if (!options.upstream) throw new Error("Usage: aih start proxy <http(s)://upstream> [--listen http://127.0.0.1:10101] [--interceptor file.mjs]");
  const upstream = parseUrl(options.upstream);
  const listen = parseUrl(options.listen || "http://127.0.0.1:10101");
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("Upstream must be HTTP(S), with no credentials, query or fragment");
  }
  if (listen.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(listen.hostname) || listen.pathname !== "/" || listen.search || listen.hash || listen.username || listen.password) {
    throw new Error("Listen URL must be HTTP on loopback (127.0.0.1, localhost or [::1]), with no path or credentials");
  }
  if (listen.port !== "0" && listen.port === upstream.port && listen.protocol === upstream.protocol &&
      (listen.hostname === upstream.hostname || ["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname))) {
    throw new Error("Proxy cannot forward to its own listening address");
  }
  const maxBodyBytes = Number(options.maxBodyBytes ?? 64 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error("maxBodyBytes must be a positive integer");
  return {
    upstream: upstream.href,
    listen: listen.href,
    interceptor: options.interceptor ? resolve(options.interceptor) : undefined,
    maxBodyBytes,
    ...normalizePresetOptions(options),
  };
}

function headersForHop(headers) {
  const result = { ...headers };
  const connection = String(result.connection || "").toLowerCase().split(",").map(s => s.trim());
  for (const name of [...HOP_HEADERS, ...connection]) delete result[name];
  return result;
}

function bytes(value) {
  if (typeof value === "string" || value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("Interceptor body must be a string, Buffer or Uint8Array");
}

function readBody(request, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error) => {
      request.off("data", onData).off("end", onEnd).off("error", finish).off("aborted", onAbort);
      if (error) reject(error);
      else resolveBody(Buffer.concat(chunks, size));
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) {
        request.pause();
        finish(Object.assign(new Error("Request body exceeds maxBodyBytes"), { statusCode: 413 }));
      } else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAbort = () => finish(new Error("Client aborted request"));
    request.on("data", onData).once("end", onEnd).once("error", finish).once("aborted", onAbort);
  });
}

export async function startProxy(options) {
  const config = normalizeProxyOptions(options);
  const target = new URL(config.upstream);
  const listen = new URL(config.listen);
  const hooks = { ...(config.interceptor ? await import(pathToFileURL(config.interceptor).href) : {}) };
  for (const name of HOOKS) {
    if (hooks[name] !== undefined && typeof hooks[name] !== "function") throw new TypeError(`${name} must be a function`);
  }
  const preset = await createPresetHooks(config, options.onStats);
  for (const [name, hook] of Object.entries(preset)) {
    const custom = hooks[name];
    hooks[name] = async context => { await hook(context); await custom?.(context); };
  }
  const connections = new Set();
  const upstreamSockets = new Set();
  const upgrades = new WeakMap();
  const wsServer = new WebSocketServer({
    noServer: true,
    autoPong: false,
    maxPayload: config.maxBodyBytes,
    handleProtocols: (_protocols, request) => upgrades.get(request)?.protocol || false,
  });
  wsServer.on("headers", (headers, request) => {
    const extra = headersForHop(upgrades.get(request)?.headers || {});
    for (const [name, value] of Object.entries(extra)) {
      if (name.startsWith("sec-websocket-") || name === "content-length") continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.push(`${name}: ${item}`);
    }
  });

  function requestContext(request) {
    if (!request.url?.startsWith("/")) throw Object.assign(new Error("Only reverse proxy origin-form paths are supported"), { statusCode: 400 });
    return { method: request.method, path: request.url, headers: { ...request.headers }, upstream: target.href };
  }

  function upstreamPath(path) {
    if (typeof path !== "string" || !path.startsWith("/") || /[\r\n#]/.test(path)) throw new Error("Interceptor path must start with / and contain no fragment or newline");
    return target.pathname.replace(/\/$/, "") + path;
  }

  function fail(response, error) {
    if (response.destroyed) return;
    console.error(`[aih proxy] ${error.message}`);
    if (response.headersSent) return response.destroy();
    response.writeHead(error.statusCode || 502, { "content-type": "text/plain", connection: "close" });
    response.end(error.statusCode === 413 ? "Request body too large\n" : "Proxy request failed\n");
  }

  async function relayResponse(incoming, response, request) {
    const context = { request, statusCode: incoming.statusCode, headers: { ...incoming.headers } };
    try {
      await hooks.onResponse?.(context);
      const headers = headersForHop(context.headers);
      const hasBody = request.method !== "HEAD" && ![204, 304].includes(context.statusCode);
      const isSse = String(incoming.headers["content-type"] || "").toLowerCase().includes("text/event-stream");
      if (hasBody && hooks.onResponseBody && !isSse) {
        context.body = await readBody(incoming, config.maxBodyBytes).catch(error => {
          error.statusCode = 502;
          throw error;
        });
        await hooks.onResponseBody(context);
        context.body = bytes(context.body);
        if (context.body.length > config.maxBodyBytes) throw new Error("Modified response body exceeds maxBodyBytes");
        // The body hook can also update representation headers (e.g. content-encoding).
        const bufferedHeaders = headersForHop(context.headers);
        bufferedHeaders["content-length"] = String(context.body.length);
        response.writeHead(context.statusCode, bufferedHeaders);
        response.end(context.body);
        return;
      }
      if (hasBody && hooks.onResponseChunk) delete headers["content-length"];
      if (context.headers.trailer) headers.trailer = context.headers.trailer;
      incoming.once("end", () => response.addTrailers(headersForHop(incoming.trailers)));
      response.writeHead(context.statusCode, headers);
      response.flushHeaders();
      if (hasBody && hooks.onResponseChunk) {
        const transform = new Transform({
          transform(chunk, _encoding, callback) {
            const event = { ...context, body: chunk };
            Promise.resolve().then(() => hooks.onResponseChunk(event))
              .then(() => bytes(event.body)).then(body => callback(null, body), callback);
          },
        });
        await pipeline(incoming, transform, response);
      } else {
        await pipeline(incoming, response);
      }
    } catch (error) {
      fail(response, error);
      incoming.destroy();
    }
  }

  const server = http.createServer(async (request, response) => {
    let upstream;
    response.on("close", () => upstream?.destroy());
    request.on("error", error => { upstream?.destroy(); fail(response, error); });
    try {
      const context = requestContext(request);
      if (hooks.onRequest) {
        context.body = await readBody(request, config.maxBodyBytes);
        await hooks.onRequest(context);
        context.body = bytes(context.body);
        if (context.body.length > config.maxBodyBytes) throw Object.assign(new Error("Modified request body exceeds maxBodyBytes"), { statusCode: 413 });
      }
      if (response.destroyed) return;
      const headers = headersForHop(context.headers);
      headers.host = target.host;
      if (context.body !== undefined) headers["content-length"] = String(context.body.length);
      else if (context.headers.trailer) headers.trailer = context.headers.trailer;
      upstream = (target.protocol === "https:" ? https : http).request(target, {
        method: context.method, path: upstreamPath(context.path), headers,
      }, incoming => { void relayResponse(incoming, response, context); });
      upstream.on("error", error => fail(response, error));
      request.on("aborted", () => upstream.destroy());
      if (context.body !== undefined) upstream.end(context.body);
      else {
        request.once("end", () => upstream.addTrailers(headersForHop(request.trailers)));
        request.pipe(upstream);
      }
    } catch (error) {
      upstream?.destroy();
      fail(response, error);
    }
  });
  // Long-lived SSE streams must not expire between model events.
  server.timeout = 0;
  server.on("connection", socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.on("connect", (_request, socket) => socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));

  server.on("upgrade", (request, socket, head) => {
    let upstream;
    let client;
    let rejected = false;
    let failed = false;
    const abort = error => {
      if (failed) return;
      failed = true;
      if (rejected) { upstream?.terminate(); return; }
      console.error(`[aih proxy] WebSocket: ${error.message}`);
      if (!client && !socket.destroyed && !socket.writableEnded) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      client?.terminate();
      upstream?.terminate();
    };
    socket.on("error", abort);
    socket.once("close", () => { if (!client) upstream?.terminate(); });
    try {
      const context = requestContext(request);
      const headers = headersForHop(context.headers);
      for (const name of Object.keys(headers)) if (name.startsWith("sec-websocket-")) delete headers[name];
      headers.host = target.host;
      const protocols = request.headers["sec-websocket-protocol"]?.split(",").map(p => p.trim());
      const url = new URL(target.origin);
      url.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      upstream = new WebSocket(url.origin + upstreamPath(context.path), protocols, {
        headers, autoPong: false,
        finishRequest: outgoing => { outgoing.path = upstreamPath(context.path); outgoing.end(); },
        perMessageDeflate: false, maxPayload: config.maxBodyBytes, handshakeTimeout: 30000,
      });
      upstreamSockets.add(upstream);
      upstream.once("close", () => upstreamSockets.delete(upstream));
      upstream.on("error", abort);
      upstream.on("unexpected-response", (_outgoing, incoming) => {
        rejected = true;
        const response = new http.ServerResponse(request);
        response.assignSocket(socket);
        response.shouldKeepAlive = false;
        response.once("finish", () => { socket.end(); upstream.terminate(); });
        void relayResponse(incoming, response, context);
      });
      upstream.once("upgrade", incoming => upgrades.set(request, { headers: incoming.headers }));
      upstream.once("open", () => {
        try {
          upgrades.get(request).protocol = upstream.protocol;
          wsServer.handleUpgrade(request, socket, head, connected => {
            client = connected;
            client.on("error", abort);
            bridge(client, upstream, "request", context, abort);
            bridge(upstream, client, "response", context, abort);
          });
        } catch (error) { abort(error); }
      });
    } catch (error) { abort(error); }
  });

  function bridge(source, destination, direction, request, abort) {
    let pending = Promise.resolve();
    let queuedBytes = 0;
    source.on("message", (data, isBinary) => {
      queuedBytes += data.length;
      if (queuedBytes > config.maxBodyBytes) return abort(new Error("WebSocket interceptor queue exceeds maxBodyBytes"));
      source.pause();
      pending = pending.then(async () => {
        const event = { direction, request, body: data, isBinary };
        await hooks.onWebSocketMessage?.(event);
        const body = bytes(event.body);
        if (body.length > config.maxBodyBytes) throw new Error("Modified WebSocket message exceeds maxBodyBytes");
        await new Promise((resolveSend, reject) => destination.send(body, { binary: event.isBinary }, error => error ? reject(error) : resolveSend()));
        queuedBytes -= data.length;
        if (queuedBytes === 0) source.resume();
      }).catch(abort);
    });
    for (const type of ["ping", "pong"]) source.on(type, data => {
      if (destination.readyState === WebSocket.OPEN) destination[type](data, undefined, error => { if (error) abort(error); });
    });
    source.once("close", (code, reason) => {
      pending.then(() => {
        if (destination.readyState !== WebSocket.OPEN) return;
        if (code === 1006) destination.terminate();
        else if (code === 1005) destination.close();
        else destination.close(code, reason);
      }).catch(abort);
    });
  }

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(Number(listen.port || 80), listen.hostname.replace(/^\[|\]$/g, ""), () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const url = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  return {
    url,
    close: () => new Promise((resolveClose, reject) => {
      for (const ws of upstreamSockets) ws.terminate();
      for (const ws of wsServer.clients) ws.terminate();
      for (const socket of connections) socket.destroy();
      wsServer.close();
      server.close(error => error ? reject(error) : resolveClose());
    }),
  };
}
