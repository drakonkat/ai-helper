import { evaluatePreservation } from "./quality.js";

const PATHS = { responses: "/v1/responses", chat: "/v1/chat/completions", anthropic: "/v1/messages" };
const SYSTEM = "You are evaluating synthetic tool results. Answer the final question using only the tool output. Return the requested literal values, case-sensitive, without explanation. Never execute further tools.";
const repeat = (count, line) => Array.from({ length: count }, (_, index) => line(index)).join("\n");
const DENSE_CONTEXT = repeat(600, index => `Reference rule ${index}: the synthetic module component_${index} accepts value_${index}, validates type and range, and emits a structured diagnostic on invalid input. Preserve literal names and numerical values when reporting results.`);

function scenarios() {
  return [
    {
      id: "build-success", category: "build", command: "npm run build",
      output: `vite v6.2.0 building for production...\n${repeat(150, index => `transforming src/components/Widget${index}.tsx ... done`)}\n✓ 150 modules transformed.\ndist/index.html  0.46 kB │ gzip: 0.30 kB\ndist/assets/checkout-7f3c.js  183.42 kB │ gzip: 52.10 kB\n✓ built in 3.84s`,
      question: "What is the emitted JavaScript bundle path?", expected: ["dist/assets/checkout-7f3c.js"],
    },
    {
      id: "build-failure", category: "build", command: "npm run build",
      output: `${repeat(120, index => `Checking project packages/module-${index}/tsconfig.json`)}\nsrc/payments/settlement.ts(73,9): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\nProcess exited with code 2.`,
      question: "Report the compiler error code and the source location exactly as shown.", expected: ["TS2322", "src/payments/settlement.ts(73,9)"],
    },
    {
      id: "test-failure", category: "test", command: "pytest -v",
      output: `${repeat(100, index => `tests/test_health.py::test_case_${index} PASSED [ ${Math.min(99, index)}%]`)}\nFAILED tests/test_billing.py::test_refund_rounding - AssertionError: expected 42, got 41\nE assert 41 == 42\n=========================== 1 failed, 100 passed in 2.93s ===========================`,
      question: "Which fully qualified test failed, and what were the expected and actual integers?", expected: ["tests/test_billing.py::test_refund_rounding", "42", "41"],
      preserve: ["tests/test_billing.py::test_refund_rounding", "expected 42, got 41"],
    },
    {
      id: "stack-trace", category: "stacktrace", command: "node scripts/checkout.js",
      output: `TypeError: Cannot read properties of undefined (reading 'currency')\n    at normalizeInvoice (/workspace/src/invoices/normalize.js:118:27)\n    at submitInvoice (/workspace/src/invoices/submit.js:56:12)\n${repeat(110, index => `    at middleware${index} (/workspace/node_modules/router/layer.js:95:5)`)}\nCaused by: missing customer profile\nDiagnostic code: CUSTOMER_PROFILE_MISSING`,
      question: "Return the first application source location and the diagnostic code.", expected: ["/workspace/src/invoices/normalize.js:118:27", "CUSTOMER_PROFILE_MISSING"],
    },
    {
      id: "repeated-logs", category: "logs", command: "docker logs synthetic-worker",
      output: `${repeat(240, index => `2026-01-01T12:${String(index % 60).padStart(2, "0")}:00Z INFO heartbeat worker=alpha queue_depth=0`)}\n2026-01-01T13:00:00Z ERROR request_id=req-9d82 code=QUEUE_LIMIT queue_depth=317 retry_after_ms=8500\n${repeat(80, index => `2026-01-01T13:01:${String(index % 60).padStart(2, "0")}Z INFO heartbeat worker=alpha queue_depth=0`)}`,
      question: "For the ERROR event only, return request_id, code and retry_after_ms.", expected: ["req-9d82", "QUEUE_LIMIT", "8500"],
    },
    {
      id: "grep-results", category: "search", command: "rg -n timeout src",
      output: `${repeat(160, index => `src/generated/client${index}.ts:20:const timeoutMs = 5000;`)}\nsrc/gateway/retry.ts:87:const timeoutMs = 17321; // production override\nsrc/gateway/retry.ts:88:const retryLimit = 4;`,
      question: "Return the production override source path, its line number and its timeout value.", expected: ["src/gateway/retry.ts", "87", "17321"],
      preserve: ["src/gateway/retry.ts:87:const timeoutMs = 17321"],
    },
    {
      id: "git-diff", category: "git", command: "git diff -- src",
      output: `diff --git a/src/config/retries.js b/src/config/retries.js\nindex e183fd0..d0beaf1 100644\n--- a/src/config/retries.js\n+++ b/src/config/retries.js\n@@ -1,162 +1,162 @@\n${repeat(160, index => ` // Configuration reference item ${index}; keep consistent across deployments.`)}\n-export const BACKOFF_CAP_MS = 4000;\n+export const BACKOFF_CAP_MS = 12500;\n export const RETRY_LIMIT = 3;`,
      question: "What configuration symbol changed, and what is its new value?", expected: ["BACKOFF_CAP_MS", "12500"],
    },
    {
      id: "large-json", category: "json", command: "cat synthetic-status.json",
      output: JSON.stringify({ records: Array.from({ length: 180 }, (_, index) => ({ id: `job-${index}`, state: "complete", duration_ms: 230 + index, attempts: 1 })), incident: { id: "inc-b62f", state: "blocked", reason: "SCHEMA_MISMATCH", affected_rows: 2917 } }, null, 2),
      question: "Return the incident id, reason and affected_rows count.", expected: ["inc-b62f", "SCHEMA_MISMATCH", "2917"],
    },
    {
      id: "short-output", category: "short", command: "node scripts/read-version.js",
      output: "service_version=2.17.4-rc.3\nstatus=ready\n",
      question: "What is the exact service version, including its suffix?", expected: ["2.17.4-rc.3"],
    },
    {
      id: "dense-context", category: "context", command: "cat synthetic-deploy-report.txt", dense: true,
      output: `${repeat(220, index => `Preflight check ${index}: valid; no remediation required; policy=documented`)}\nDeployment result: FAILED\nFailure domain: inventory-eu\nRecovery checkpoint: checkpoint-4e6b\nRequired action: REPLAY_PENDING_EVENTS\n`,
      question: "Return the failure domain, recovery checkpoint and required action from the deployment report.", expected: ["inventory-eu", "checkpoint-4e6b", "REPLAY_PENDING_EVENTS"],
    },
  ];
}

function request(format, model, scenario) {
  const instructions = scenario.dense ? `${SYSTEM}\n\n${DENSE_CONTEXT}` : SYSTEM;
  const callId = `call_${scenario.id.replaceAll("-", "_")}`;
  const parameters = { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false };
  const definition = { name: "exec_command", description: "Run the given shell command and return textual output.", parameters };
  const args = { cmd: scenario.command };
  if (format === "responses") return {
    model, instructions, max_output_tokens: 256, stream: false,
    tools: [{ type: "function", ...definition }],
    input: [
      { role: "user", content: "Inspect the synthetic command output." },
      { type: "function_call", call_id: callId, name: definition.name, arguments: JSON.stringify(args) },
      { type: "function_call_output", call_id: callId, output: scenario.output },
      { role: "user", content: scenario.question },
    ],
  };
  if (format === "chat") return {
    model, max_completion_tokens: 256, stream: false, tools: [{ type: "function", function: definition }],
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: "Inspect the synthetic command output." },
      { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: definition.name, arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: callId, content: scenario.output },
      { role: "user", content: scenario.question },
    ],
  };
  return {
    model, system: instructions, max_tokens: 256, stream: false,
    tools: [{ name: definition.name, description: definition.description, input_schema: parameters }],
    messages: [
      { role: "user", content: "Inspect the synthetic command output." },
      { role: "assistant", content: [{ type: "tool_use", id: callId, name: definition.name, input: args }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: scenario.output }, { type: "text", text: scenario.question }] },
    ],
  };
}

/** Thirty reproducible, secret-free requests; commands are data, never executed. */
export function builtInFixtures({ model = "gpt-5.5", formats = Object.keys(PATHS) } = {}) {
  if (typeof model !== "string" || !model.trim()) throw new Error("fixture model must be a nonempty string");
  if (!Array.isArray(formats) || !formats.length || formats.some(format => !Object.hasOwn(PATHS, format)) || new Set(formats).size !== formats.length) {
    throw new Error(`fixture formats must be a nonempty, unique subset of: ${Object.keys(PATHS).join(", ")}`);
  }
  return formats.flatMap(format => scenarios().map(scenario => ({
    id: `${format}-${scenario.id}`, category: scenario.category, format, path: PATHS[format],
    body: request(format, model, scenario),
    checks: { toolIncludes: [...(scenario.preserve || scenario.expected)], requestIncludes: [scenario.question] },
    answerChecks: { includes: [...scenario.expected] },
  })));
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function checkArrays(value, keys, where) {
  if (!object(value)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${where}.${key} is unknown; allowed keys: ${keys.join(", ")}`);
    if (!Array.isArray(value[key]) || value[key].some(text => typeof text !== "string" || !text.trim())) throw new Error(`${where}.${key} must be an array of nonempty strings`);
  }
}

/** Validate a parsed JSON fixture array without changing it or inventing checks. */
export function validateFixtures(input) {
  if (!Array.isArray(input) || !input.length) throw new Error("Fixtures must be a nonempty JSON array");
  const ids = new Set();
  input.forEach((fixture, index) => {
    const where = `Fixture[${index}]${fixture?.id ? ` (${fixture.id})` : ""}`;
    if (!object(fixture)) throw new Error(`${where} must be an object`);
    for (const key of ["id", "category"]) if (typeof fixture[key] !== "string" || !fixture[key].trim()) throw new Error(`${where}.${key} must be a nonempty string`);
    if (ids.has(fixture.id)) throw new Error(`${where}.id is duplicated`);
    ids.add(fixture.id);
    if (!Object.hasOwn(PATHS, fixture.format)) throw new Error(`${where}.format must be responses, chat or anthropic`);
    if (fixture.path !== PATHS[fixture.format]) throw new Error(`${where}.path must be ${PATHS[fixture.format]} for ${fixture.format}`);
    if (!object(fixture.body)) throw new Error(`${where}.body must be a request object`);
    if (typeof fixture.body.model !== "string" || !fixture.body.model.trim()) throw new Error(`${where}.body.model must be a nonempty string`);
    if (fixture.format === "responses") {
      if (!(typeof fixture.body.input === "string" && fixture.body.input.trim()) && !(Array.isArray(fixture.body.input) && fixture.body.input.length)) throw new Error(`${where}.body.input must be nonempty text or an array`);
    } else if (!Array.isArray(fixture.body.messages) || !fixture.body.messages.length) throw new Error(`${where}.body.messages must be a nonempty array`);
    if (fixture.body.tools !== undefined && !Array.isArray(fixture.body.tools)) throw new Error(`${where}.body.tools must be an array`);
    checkArrays(fixture.checks, ["toolIncludes", "requestIncludes"], `${where}.checks`);
    if (fixture.answerChecks !== undefined) checkArrays(fixture.answerChecks, ["includes", "excludes"], `${where}.answerChecks`);
    const quality = evaluatePreservation(fixture.body, fixture.body, fixture.checks);
    const invalid = quality.checks.find(check => check.reason === "not_in_original");
    if (invalid) throw new Error(`${where}.checks.${invalid.kind} assertion ${JSON.stringify(invalid.expected)} is absent from the original ${invalid.kind === "toolIncludes" ? "tool output" : "request text"}`);
  });
  return input;
}
