import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { builtInFixtures, validateFixtures } from "../src/benchmark/fixtures.js";
import { evaluatePreservation, evaluateAnswer } from "../src/benchmark/quality.js";

const test = typeof Bun === "undefined" ? nodeTest : nodeTest.skip;

function setToolOutput(body, format, output) {
  if (format === "responses") body.input.find(item => item.type === "function_call_output").output = output;
  else if (format === "chat") body.messages.find(item => item.role === "tool").content = output;
  else body.messages.at(-1).content.find(item => item.type === "tool_result").content = output;
}

test("built-in corpus has thirty deterministic, distinct, scored protocol requests", () => {
  const fixtures = builtInFixtures();
  assert.equal(fixtures.length, 30);
  assert.equal(new Set(fixtures.map(item => item.id)).size, 30);
  assert.equal(new Set(fixtures.map(item => item.category)).size, 9);
  assert.deepEqual(fixtures, builtInFixtures());
  const before = JSON.stringify(fixtures);
  assert.equal(validateFixtures(fixtures), fixtures);
  assert.equal(JSON.stringify(fixtures), before, "validation must not mutate fixtures");
  for (const fixture of fixtures) {
    const result = evaluatePreservation(fixture.body, fixture.body, fixture.checks);
    assert.equal(result.status, "pass", fixture.id);
    assert.ok(result.checks.some(check => check.id.startsWith("structure:tool_pair:")), fixture.id);
    assert.ok(result.passed >= 5, fixture.id);
    assert.equal(evaluateAnswer(fixture.answerChecks.includes.join("\n"), fixture.answerChecks).status, "pass", fixture.id);
    assert.equal(evaluateAnswer("No useful information.", fixture.answerChecks).status, "fail", fixture.id);
    assert.ok(fixture.checks.toolIncludes.length > 0, fixture.id);
  }
});

test("answers are not leaked in system instructions or user questions", () => {
  for (const fixture of builtInFixtures()) {
    const body = fixture.body;
    const questions = fixture.format === "responses" ? body.input.filter(item => item.role === "user").map(item => item.content)
      : body.messages.filter(item => item.role === "user").flatMap(item => typeof item.content === "string" ? [item.content] : item.content.filter(part => part.type === "text").map(part => part.text));
    const instructions = body.instructions || body.system || body.messages.find(item => item.role === "system")?.content;
    for (const answer of fixture.answerChecks.includes) {
      assert.equal([instructions, ...questions].some(text => text.includes(answer)), false, `${fixture.id}: ${answer}`);
    }
  }
});

test("corpus filters formats, overrides model and returns independent objects", () => {
  const fixtures = builtInFixtures({ model: "test-model", formats: ["anthropic"] });
  assert.equal(fixtures.length, 10);
  assert.ok(fixtures.every(item => item.format === "anthropic" && item.body.model === "test-model"));
  fixtures[0].body.tools[0].name = "changed";
  assert.equal(fixtures[1].body.tools[0].name, "exec_command");
  assert.equal(builtInFixtures()[0].body.model, "gpt-5.5");
  for (const options of [{ formats: [] }, { formats: ["other"] }, { formats: ["chat", "chat"] }, { model: " " }]) assert.throws(() => builtInFixtures(options));
});

test("short control stays short while dense context exercises image rendering", () => {
  const fixtures = builtInFixtures({ formats: ["responses"] });
  assert.ok(JSON.stringify(fixtures.find(item => item.category === "short").body).length < 2000);
  assert.ok(fixtures.find(item => item.category === "context").body.instructions.length > 60000);
});

for (const format of ["responses", "chat", "anthropic"]) {
  test(`${format}: deliberate loss fails and original input stays unchanged`, () => {
    const fixture = builtInFixtures({ formats: [format] }).find(item => item.category === "short");
    const before = JSON.stringify(fixture.body);
    const changed = structuredClone(fixture.body);
    setToolOutput(changed, format, "status=ready");
    const result = evaluatePreservation(fixture.body, changed, fixture.checks);
    assert.equal(result.status, "fail");
    assert.equal(result.failed, 1);
    assert.equal(result.unknown, 0);
    assert.equal(result.checks.find(check => check.kind === "toolIncludes").reason, "missing_text");
    assert.equal(JSON.stringify(fixture.body), before);
  });

  test(`${format}: image rendering is indeterminate, not a quality pass`, () => {
    const fixture = builtInFixtures({ formats: [format] }).find(item => item.category === "short");
    const changed = structuredClone(fixture.body);
    const image = format === "anthropic" ? { type: "image", source: { type: "base64", media_type: "image/png", data: "bm90LXJlYWxseS1hLXBuZw==" } }
      : format === "chat" ? { type: "image_url", image_url: { url: "data:image/png;base64,bm90LXJlYWxseS1hLXBuZw==" } }
        : { type: "input_image", image_url: "data:image/png;base64,bm90LXJlYWxseS1hLXBuZw==" };
    setToolOutput(changed, format, [image]);
    const result = evaluatePreservation(fixture.body, changed, fixture.checks);
    assert.equal(result.status, "indeterminate");
    assert.equal(result.failed, 0);
    assert.equal(result.unknown, 1);
    assert.equal(result.checks.find(check => check.kind === "toolIncludes").reason, "image_content_requires_live_evaluation");
  });
}

test("tool text checks cannot be satisfied by copies in the user question or metadata", () => {
  const fixture = builtInFixtures({ formats: ["responses"] }).find(item => item.category === "short");
  const changed = structuredClone(fixture.body);
  setToolOutput(changed, fixture.format, "status=ready");
  changed.input.at(-1).content += ` The answer is ${fixture.answerChecks.includes[0]}.`;
  changed.metadata = { expected: fixture.answerChecks.includes[0] };
  assert.equal(evaluatePreservation(fixture.body, changed, fixture.checks).status, "fail");
});

test("request checks ignore base64 payloads even if a byte string matches the assertion", () => {
  const original = { model: "model", input: [{ role: "user", content: "VE9LRU4=" }] };
  const transformed = { model: "model", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,VE9LRU4=" }] }] };
  assert.equal(evaluatePreservation(original, transformed, { requestIncludes: ["VE9LRU4="] }).status, "indeterminate");
  transformed.input[0].content = "data:image/png;base64,VE9LRU4=";
  assert.equal(evaluatePreservation(original, transformed, { requestIncludes: ["VE9LRU4="] }).status, "fail");
});

test("tool call pairing and model routing changes are separate failures", () => {
  const fixture = builtInFixtures({ formats: ["responses"] })[0];
  const changed = structuredClone(fixture.body);
  changed.input.find(item => item.type === "function_call_output").call_id = "wrong_id";
  changed.model = "wrong-model";
  changed.tools = [];
  const result = evaluatePreservation(fixture.body, changed, fixture.checks);
  assert.equal(result.status, "fail");
  assert.equal(result.failed, 3);
  assert.equal(result.checks.filter(check => check.kind !== "structure").every(check => check.status === "pass"), true);
});

test("image-restructured call history is not incorrectly declared lost", () => {
  const fixture = builtInFixtures({ formats: ["responses"] })[0];
  const changed = structuredClone(fixture.body);
  changed.input = [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }] }];
  const result = evaluatePreservation(fixture.body, changed, fixture.checks);
  assert.equal(result.status, "indeterminate");
  assert.equal(result.failed, 0);
});

test("source-missing assertions cannot produce false preservation passes", () => {
  const source = { model: "model", input: "hello" };
  const result = evaluatePreservation(source, { ...source, input: "invented" }, { requestIncludes: ["invented"] });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.checks[0].reason, "not_in_original");
});

test("answers use case-sensitive includes/excludes and no checks are unscored", () => {
  assert.deepEqual(evaluateAnswer("anything"), { status: "unscored", passed: 0, failed: 0, unknown: 0, total: 0, checks: [] });
  assert.equal(evaluateAnswer("anything", {}).status, "unscored");
  assert.equal(evaluateAnswer("ERR_OK", { includes: ["ERR_OK"], excludes: ["FAIL"] }).status, "pass");
  const result = evaluateAnswer("err_ok FAIL", { includes: ["ERR_OK"], excludes: ["FAIL"] });
  assert.equal(result.status, "fail");
  assert.equal(result.failed, 2);
  assert.equal(evaluateAnswer(null, { includes: ["ERR_OK"] }).status, "indeterminate");
  assert.equal(evaluateAnswer("", { includes: ["ERR_OK"] }).status, "fail");
  assert.throws(() => evaluateAnswer("text", { includes: "text" }), /array/);
  assert.equal(evaluatePreservation({}, {}, {}).status, "unscored");
});

test("custom fixtures allow explicitly unscored answers, without mutation", () => {
  const fixtures = builtInFixtures({ formats: ["responses"] }).slice(0, 1);
  delete fixtures[0].answerChecks;
  const before = JSON.stringify(fixtures);
  assert.equal(validateFixtures(fixtures), fixtures);
  assert.equal(JSON.stringify(fixtures), before);
});

test("validation rejects malformed manifests with actionable locations", () => {
  for (const value of [null, {}, [], "fixtures"]) assert.throws(() => validateFixtures(value), /nonempty JSON array/);
  const fixture = builtInFixtures({ formats: ["responses"] })[0];
  for (const [mutate, expected] of [
    [item => { item.id = ""; }, /Fixture\[0\].*\.id/],
    [item => { item.category = false; }, /\.category/],
    [item => { item.format = "unknown"; }, /\.format/],
    [item => { item.path = "/v1/messages"; }, /\.path must be \/v1\/responses/],
    [item => { delete item.body.model; }, /\.body\.model/],
    [item => { item.body.input = []; }, /\.body\.input/],
    [item => { item.body.tools = {}; }, /\.body\.tools/],
    [item => { item.checks = null; }, /\.checks must be an object/],
    [item => { item.checks.toolIncludes = "oops"; }, /\.checks\.toolIncludes must be an array/],
    [item => { item.checks.typo = []; }, /\.checks\.typo is unknown/],
    [item => { item.checks.toolIncludes = [""]; }, /nonempty strings/],
    [item => { item.checks.toolIncludes = ["not in the tool output"]; }, /absent from the original tool output/],
    [item => { item.checks.toolIncludes = [item.checks.requestIncludes[0]]; }, /absent from the original tool output/],
    [item => { item.answerChecks.includes = [7]; }, /\.answerChecks\.includes/],
    [item => { item.answerChecks.regex = "unsupported"; }, /\.answerChecks\.regex is unknown/],
  ]) {
    const copy = structuredClone(fixture);
    mutate(copy);
    assert.throws(() => validateFixtures([copy]), expected);
  }
  assert.throws(() => validateFixtures([fixture, structuredClone(fixture)]), /id is duplicated/);
  const chat = builtInFixtures({ formats: ["chat"] })[0];
  chat.body.messages = [];
  assert.throws(() => validateFixtures([chat]), /\.body\.messages/);
});
