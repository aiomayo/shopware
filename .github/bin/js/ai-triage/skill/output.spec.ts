/**
 * Unit tests for the skill output contract:
 *   - parseJsonFromText: tolerant JSON extraction from chatty LLM text
 *   - truncateOversizedFields: server-side safety-net trimmer
 *   - TriageOutput Zod schema: the wire contract
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJsonFromText, truncateOversizedFields, TriageOutput, assertNoSecretsInOutput, SecretInOutputError } from "./output.ts";

function validOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    disposition: "valid-bug",
    severity: "medium",
    suggested_labels: ["domain/admin"],
    confidence: 0.8,
    reasoning: "ok",
    evidence_quotes: ["quote"],
    duplicate_of: null,
    missing_template_fields: [],
    affected_paths: [],
    related_issues: [],
    related_prs: [],
    recent_commits_in_area: [],
    change_size_estimate: "small",
    ...overrides,
  };
}

// ---- parseJsonFromText --------------------------------------------------

test("parseJsonFromText: plain JSON object", () => {
  const obj = parseJsonFromText('{"a": 1, "b": "x"}', "test");
  assert.deepEqual(obj, { a: 1, b: "x" });
});

test("parseJsonFromText: markdown ```json fence stripped", () => {
  const text = "chatty preamble\n```json\n{\"x\": 42}\n```\nchatty epilogue";
  assert.deepEqual(parseJsonFromText(text, "test"), { x: 42 });
});

test("parseJsonFromText: braces inside JSON strings do NOT break forward scan", () => {
  // The old reverse-walker mis-counted braces here. The forward greedy match works.
  const text = 'preamble {"reasoning": "the error says: missing }"} epilogue';
  assert.deepEqual(parseJsonFromText(text, "test"), { reasoning: "the error says: missing }" });
});

test("parseJsonFromText: nested objects", () => {
  const text = '{"outer": {"inner": {"deep": true}}}';
  const obj = parseJsonFromText(text, "test") as Record<string, unknown>;
  assert.deepEqual(obj, { outer: { inner: { deep: true } } });
});

test("parseJsonFromText: throws on missing braces", () => {
  assert.throws(() => parseJsonFromText("no JSON here, just prose", "test"), /no JSON object/);
});

test("parseJsonFromText: throws on malformed JSON with snippet in message", () => {
  // Forward greedy will take the whole {a,b,c} but parse will fail.
  try {
    parseJsonFromText("{not real json}", "test");
    assert.fail("expected throw");
  } catch (err) {
    assert.match((err as Error).message, /JSON\.parse failed/);
    assert.match((err as Error).message, /extracted \(\d+B\)/);
  }
});

test("parseJsonFromText: prose AFTER the JSON does not break extraction", () => {
  // Common opencode shape: the agent's final message is the raw assistant turn,
  // not envelope-wrapped, and the model sometimes emits prose after the JSON.
  // The old "first { to last }" extractor picked up a `}` in trailing prose.
  const text = 'prose {"a":1} more prose with a stray } char';
  assert.deepEqual(parseJsonFromText(text, "test"), { a: 1 });
});

test("parseJsonFromText: prose BEFORE and AFTER the JSON both survive", () => {
  const text = "Here is the triage result:\n{\"disposition\": \"valid-bug\"}\nNote: I considered #16599.";
  assert.deepEqual(parseJsonFromText(text, "test"), { disposition: "valid-bug" });
});

test("parseJsonFromText: escaped quote inside string does not derail brace tracking", () => {
  // String contains an escaped quote then a `}` — the walker must NOT exit the string.
  const text = '{"reasoning": "model said \\"missing }\\" and quit", "ok": true}';
  assert.deepEqual(parseJsonFromText(text, "test"), { reasoning: 'model said "missing }" and quit', ok: true });
});

// ---- truncateOversizedFields --------------------------------------------

test("truncateOversizedFields: truncates evidence_quotes > 500 chars", () => {
  const overlong = "x".repeat(600);
  const obj = { evidence_quotes: [overlong, "short"], reasoning: "ok" } as Record<string, unknown>;
  truncateOversizedFields(obj);
  const quotes = obj.evidence_quotes as string[];
  assert.ok(quotes[0].length === 500, `got length ${quotes[0].length}`);
  assert.match(quotes[0], /…\[truncated\]$/);
  assert.equal(quotes[1], "short");
});

test("truncateOversizedFields: leaves under-cap quotes unchanged", () => {
  const obj = { evidence_quotes: ["x".repeat(499)], reasoning: "x" } as Record<string, unknown>;
  truncateOversizedFields(obj);
  assert.equal((obj.evidence_quotes as string[])[0].length, 499);
});

test("truncateOversizedFields: truncates reasoning + recent_commits_in_area too", () => {
  const obj = {
    reasoning: "r".repeat(2500),
    recent_commits_in_area: ["c".repeat(250)],
    evidence_quotes: ["e"],
  } as Record<string, unknown>;
  truncateOversizedFields(obj);
  assert.equal((obj.reasoning as string).length, 2000);
  assert.equal((obj.recent_commits_in_area as string[])[0].length, 200);
});

test("truncateOversizedFields + Zod: oversized output now passes validation", () => {
  const raw = validOutput({
    evidence_quotes: ["x".repeat(800)], // would fail Zod max(500)
  });
  truncateOversizedFields(raw);
  const parsed = TriageOutput.parse(raw); // no throw
  assert.equal(parsed.evidence_quotes[0].length, 500);
});

// ---- TriageOutput .strict() — unknown keys rejected ---------------------

test("TriageOutput.strict: rejects unknown keys instead of silently stripping", () => {
  const raw = validOutput({ exfiltrated_env: "ANTHROPIC_API_KEY=sk-ant-FAKEKEY1234567890abcde" });
  assert.throws(() => TriageOutput.parse(raw), /unrecognized key|Unrecognized key/i);
});

// ---- assertNoSecretsInOutput — content scan -----------------------------

test("assertNoSecretsInOutput: passes for clean output", () => {
  const out = TriageOutput.parse(validOutput());
  assert.doesNotThrow(() => assertNoSecretsInOutput(out));
});

test("assertNoSecretsInOutput: detects anthropic key in reasoning", () => {
  const out = TriageOutput.parse(validOutput({
    reasoning: "We saw sk-ant-FAKEKEY1234567890abcdefg in env",
  }));
  assert.throws(() => assertNoSecretsInOutput(out), SecretInOutputError);
});

test("assertNoSecretsInOutput: detects openai key in evidence_quotes", () => {
  const out = TriageOutput.parse(validOutput({
    evidence_quotes: ["leaked sk-proj-FAKE1234567890abcdefghij"],
  }));
  assert.throws(() => assertNoSecretsInOutput(out), SecretInOutputError);
});

test("assertNoSecretsInOutput: detects github token", () => {
  const out = TriageOutput.parse(validOutput({
    reasoning: "token ghs_abc1234567890defghij1234567890",
  }));
  assert.throws(() => assertNoSecretsInOutput(out), SecretInOutputError);
});

test("assertNoSecretsInOutput: detects PEM private-key BEGIN marker", () => {
  const out = TriageOutput.parse(validOutput({
    reasoning: "found -----BEGIN RSA PRIVATE KEY----- ...",
  }));
  assert.throws(() => assertNoSecretsInOutput(out), SecretInOutputError);
});

test("assertNoSecretsInOutput: error message contains category, not the secret itself", () => {
  const out = TriageOutput.parse(validOutput({
    reasoning: "token ghs_abc1234567890defghij1234567890",
  }));
  try {
    assertNoSecretsInOutput(out);
    assert.fail("expected throw");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /github_token/);
    assert.ok(!msg.includes("ghs_abc1234567890defghij1234567890"), "error must not echo the secret");
  }
});
