// Copy this file, edit it and pass --interceptor /path/to/interceptor.mjs.
// Hooks may be async. Mutate context; return values are ignored.
export function onRequest(context) {
  console.log(`[request] ${context.method} ${context.path}: ${context.body.length} bytes; type=${context.headers["content-type"] || "missing"}; encoding=${context.headers["content-encoding"] || "identity"}`);
  // const json = JSON.parse(context.body.toString("utf8"));
  // json.model = "another-model";
  // context.body = JSON.stringify(json);
}

export function onResponse(context) {
  console.log(`[response] ${context.request.path}: ${context.statusCode}`);
}

// Optional whole-body hook for non-SSE responses (buffers up to maxBodyBytes):
// export function onResponseBody(context) {
//   console.log(context.body.toString("utf8"));
// }

export function onResponseChunk(context) {
  // Raw bytes, possibly compressed. A chunk is NOT necessarily a full SSE event,
  // JSON document or UTF-8 character. Keep incremental decoding/parsing state on
  // context.request if needed; never assume chunk boundaries are message boundaries.
  console.log(`[response chunk] ${context.request.path}: ${context.body.length} bytes`);
}

export function onWebSocketMessage(context) {
  console.log(`[ws ${context.direction}] ${context.body.length} bytes, binary=${context.isBinary}`);
  // Text messages are complete, unlike HTTP response chunks:
  // if (!context.isBinary) {
  //   const json = JSON.parse(context.body.toString("utf8"));
  //   context.body = JSON.stringify(json);
  // }
}
