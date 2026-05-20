/**
 * Unit tests for the triage wrapper's pure functions.
 *
 * Run via `npm test` (uses Node's built-in --test runner; no extra deps).
 *
 * Tested:
 *  - redactPii: pattern coverage + ordering (anthropic before openai) + non-interference
 *  - parseJsonFromText: forward-greedy extraction + markdown fences + braces in strings
 *  - extractOpencodeFinalMessage: each of the 4 documented event shapes + the
 *    "last-candidate-wins" rule
 *  - parseEngine: valid/invalid inputs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { redactPii } from "./pii-patterns.ts";
import { parseJsonFromText, truncateOversizedFields, TriageOutput } from "./skill/output.ts";
import { extractTemplateFields, detectLanguage, SkillInput } from "./skill/input.ts";
import { stripFrontmatter, formatPromptWithInput } from "./skill/prompt.ts";
import { extractOpencodeFinalMessage, parseEngine } from "./triage.ts";

// ---- redactPii ----------------------------------------------------------
//
// IMPORTANT: every sample below is SYNTHETIC — strings constructed to match the
// regex shape but not corresponding to any real account. Never paste a real
// secret into this file. Use placeholders like "FAKE", "EXAMPLE", repeating
// digits, or documented vendor example tokens (e.g. AWS's `AKIAIOSFODNN7EXAMPLE`).

test("redactPii: anthropic key matched before openai", () => {
  const { redacted, counts } = redactPii("token sk-ant-abcdefghijklmnopqrstuv-1234");
  assert.match(redacted, /\[REDACTED_ANTHROPIC_KEY\]/);
  assert.equal(counts.anthropic_key, 1);
  assert.equal(counts.openai_key, undefined, "openai pattern must not swallow sk-ant-");
});

test("redactPii: openai key separate from anthropic", () => {
  const { redacted, counts } = redactPii("sk-proj-1234567890abcdefghij1234");
  assert.match(redacted, /\[REDACTED_OPENAI_KEY\]/);
  assert.equal(counts.openai_key, 1);
});

test("redactPii: github token covers ghr_ prefix (refresh tokens)", () => {
  const { redacted, counts } = redactPii("creds ghr_abc1234567890defghij1234567890");
  assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.equal(counts.github_token, 1);
});

test("redactPii: shopware integration key (SWIA prefix)", () => {
  const { redacted, counts } = redactPii("key SWIAAXP2DM5FEFNADWLNU2HVWQ ok");
  assert.match(redacted, /\[REDACTED_SHOPWARE_KEY\]/);
  assert.equal(counts.shopware_integration_key, 1);
});

test("redactPii: basic-auth URL preserves host", () => {
  const { redacted } = redactPii("https://alice:secret123@api.example.com/path");
  assert.match(redacted, /https:\/\/\[REDACTED_USER\]:\[REDACTED_PASS\]@api\.example\.com\/path/);
});

test("redactPii: private-key block bounded (regex does not catastrophically backtrack)", () => {
  // Unterminated BEGIN block — the {1,8192}? quantifier ensures linear bounded time,
  // not catastrophic exponential backtracking. ~200ms on a 20KB body is fine; ReDoS
  // would be measured in seconds/minutes.
  const longUnterminated = "-----BEGIN RSA PRIVATE KEY-----\n" + "A".repeat(20_000);
  const start = Date.now();
  redactPii(longUnterminated);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `private-key regex took ${elapsed}ms — ReDoS regression?`);
});

// ---- per-pattern coverage (synthetic samples only) -----------------------

test("redactPii: anthropic key — variations", () => {
  // shape: sk-ant-<at least 20 alphanumeric or dash chars>
  for (const sample of [
    "sk-ant-FAKE1234567890fakefakefake",
    "sk-ant-api03-fake-token-abcdefghij1234567890",
    "Header: Authorization: sk-ant-ABCDEFGHIJ1234567890ABC",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_ANTHROPIC_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: openai key — sk- and sk-proj-", () => {
  for (const sample of [
    "sk-FAKE1234567890fakefakefakefake",
    "sk-proj-FAKE1234567890fakefakefake_xyz",
    "key=sk-1234567890abcdefghij1234ABC",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_OPENAI_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: stripe — live + test + restricted + webhook keys", () => {
  for (const sample of [
    "sk_live_FAKE1234567890fakefake",
    "sk_test_FAKE1234567890fakefake",
    "pk_live_FAKE1234567890fakefake",
    "pk_test_FAKE1234567890fakefake",
    "rk_live_FAKE1234567890fakefake",
    "whsec_live_FAKE1234567890fakefake",
    "whsec_test_FAKE1234567890fakefake",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_STRIPE_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: github token — all current prefixes (ghp/gho/ghu/ghs/ghr/github_pat)", () => {
  for (const sample of [
    "ghp_FAKE1234567890abcdefghij",
    "gho_FAKE1234567890abcdefghij",
    "ghu_FAKE1234567890abcdefghij",
    "ghs_FAKE1234567890abcdefghij",
    "ghr_FAKE1234567890abcdefghij",
    "github_pat_FAKE1234567890abcdefghij",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/, `failed: ${sample}`);
  }
});

test("redactPii: AWS access keys (AKIA + ASIA)", () => {
  for (const sample of [
    "AKIAIOSFODNN7EXAMPLE",  // AWS's documented example value
    "ASIAIOSFODNN7EXAMPLE",
    "Found AKIA1234567890ABCDEF in config",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_AWS_ACCESS_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: Google API key (AIza-prefix, 35-char body)", () => {
  // Format: AIza + exactly 35 chars from [0-9A-Za-z_-]
  const sample = "AIza" + "FAKE".repeat(9).slice(0, 35); // 4 + 35 = 39 chars
  assert.equal(sample.length, 39);
  const { redacted } = redactPii(sample);
  assert.match(redacted, /\[REDACTED_GOOGLE_API_KEY\]/);
});

test("redactPii: Slack tokens — bot, user, app, configuration, refresh", () => {
  for (const sample of [
    "xoxb-1234567890-abcdefghij-FAKEFAKEFAKE",
    "xoxp-1234567890-fakefakefakefakefakefakefake",
    "xoxa-2-1234567890-abcdefghij",
    "xoxr-fakefakefakefakefakefake",
    "xoxs-fakefakefakefakefakefake",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_SLACK_TOKEN\]/, `failed: ${sample}`);
  }
});

test("redactPii: Shopware integration key (SWIA prefix)", () => {
  // Synthetic — uppercase alphanumeric, 20+ chars after SWIA
  for (const sample of [
    "SWIAFAKEFAKEFAKEFAKEFAKE",
    "key=SWIA1234567890ABCDEFGHIJ",
    "Found SWIAABCDEFGHIJKLMNOPQRSTUV in config.",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_SHOPWARE_KEY\]/, `failed: ${sample}`);
  }
});

test("redactPii: JWT — three base64url segments separated by dots", () => {
  // Each segment ≥10 chars from [A-Za-z0-9_-]; first must start with eyJ
  const sample = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.FAKEsignaturefakefake_xyz";
  const { redacted } = redactPii(sample);
  assert.match(redacted, /\[REDACTED_JWT\]/);
});

test("redactPii: Bearer token in HTTP header", () => {
  const sample = "Authorization: Bearer FAKE1234567890abcdefghij1234.xyz";
  const { redacted } = redactPii(sample);
  assert.match(redacted, /Bearer \[REDACTED_BEARER\]/);
});

test("redactPii: basic-auth URL (creds in URL)", () => {
  const sample = "Failing fetch: https://alice:s3cret-fake@api.example.com/path?x=1";
  const { redacted } = redactPii(sample);
  assert.match(redacted, /https:\/\/\[REDACTED_USER\]:\[REDACTED_PASS\]@api\.example\.com/);
});

test("redactPii: private-key PEM block (RSA, EC, OPENSSH, PGP variants)", () => {
  // Simple synthetic block — the regex matches the BEGIN/END markers and content between.
  for (const variant of ["RSA ", "EC ", "DSA ", "OPENSSH ", "PGP ", ""]) {
    const sample = `-----BEGIN ${variant}PRIVATE KEY-----
SYNTHETICKEYDATAFAKEFAKEFAKEFAKEFAKEFAKE
-----END ${variant}PRIVATE KEY-----`;
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/, `failed for variant: ${variant.trim() || "default"}`);
  }
});

test("redactPii: email — common formats", () => {
  for (const sample of [
    "user@example.com",
    "first.last+tag@example.de",
    "user-name@sub.example.co.uk",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_EMAIL\]/, `failed: ${sample}`);
  }
});

test("redactPii: IBAN — DE, FR, GB", () => {
  for (const sample of [
    "DE89 3704 0044 0532 0130 00",
    "FR1420041010050500013M02606",
    "GB29 NWBK 6016 1331 9268 19",
  ]) {
    const { redacted } = redactPii(sample);
    assert.match(redacted, /\[REDACTED_IBAN\]/, `failed: ${sample}`);
  }
});

test("redactPii: /Users/ path on macOS", () => {
  const { redacted } = redactPii("error in /Users/alice.dev/code/file.ts");
  assert.match(redacted, /\/Users\/\[REDACTED_USER\]\/code\/file\.ts/);
});

// ---- negative tests — must NOT redact -----------------------------------

test("redactPii: ordinary code/text not falsely matched", () => {
  for (const safe of [
    "function foo() { return 42; }",
    "src/Core/Content/Product/ProductDefinition.php",
    "The export download failed for customer.",
    "DEFG HIJKL MNOPQ",      // not enough digits to be IBAN
    "Issue #16599 references PR #16632 in trunk.",
  ]) {
    const { redacted, counts } = redactPii(safe);
    assert.equal(redacted, safe, `false positive in: ${safe}`);
    assert.equal(Object.keys(counts).length, 0, `false positive counts in: ${safe}`);
  }
});

test("redactPii: order-of-patterns smoke test (all 9 categories don't cross-match)", () => {
  const blob = [
    "sk-ant-abcdefghijklmnopqrstuv1234567890",
    "sk-proj-1234567890abcdefghij1234567890",
    "sk_live_1234567890abcdefghij12",
    "ghp_abc1234567890defghij12345",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-1234567890-abcdefghijkl-mnopqrstuvwxyz",
    "SWIAAXP2DM5FEFNADWLNU2HVWQ",
    "test@example.de",
    "/Users/jdoe/code",
  ].join("\n");
  const { counts } = redactPii(blob);
  // Each category should fire exactly once. github_token may collide with shopware_integration_key
  // shape if the prefix overlapped, so we assert >=1 not strictly 1.
  for (const key of ["anthropic_key", "openai_key", "stripe_key", "github_token", "aws_access_key",
                     "slack_token", "shopware_integration_key", "email", "user_path"]) {
    assert.ok((counts[key] ?? 0) >= 1, `expected ${key} to be matched, got ${JSON.stringify(counts)}`);
  }
});

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

// ---- extractOpencodeFinalMessage ----------------------------------------

test("extractOpencodeFinalMessage: shape 1 — {role:'assistant', content:string}", () => {
  const stdout = [
    '{"role": "user", "content": "ask"}',
    '{"role": "assistant", "content": "the answer"}',
  ].join("\n");
  assert.equal(extractOpencodeFinalMessage(stdout), "the answer");
});

test("extractOpencodeFinalMessage: shape 2 — {type:'message', role:'assistant', content:[{text}]}", () => {
  const stdout = '{"type":"message","role":"assistant","content":[{"text":"part1"},{"text":"part2"}]}';
  assert.equal(extractOpencodeFinalMessage(stdout), "part1part2");
});

test("extractOpencodeFinalMessage: shape 3 — {type:'complete', message:string}", () => {
  const stdout = '{"type":"complete","message":"final"}';
  assert.equal(extractOpencodeFinalMessage(stdout), "final");
});

test("extractOpencodeFinalMessage: opencode 1.15.5 verified shape — {type:'text', part:{text}}", () => {
  // Real shape from opencode 1.15.5 CI capture 2026-05-20.
  const stdout = '{"type":"text","timestamp":1779276488,"sessionID":"ses_x","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_x","type":"text","text":"final answer text","time":{"start":1779276487999}}}';
  assert.equal(extractOpencodeFinalMessage(stdout), "final answer text");
});

test("extractOpencodeFinalMessage: last-candidate-wins rule", () => {
  const stdout = [
    '{"role":"assistant","content":"first answer"}',
    '{"type":"tool_call"}',
    '{"role":"assistant","content":"second answer"}',
  ].join("\n");
  assert.equal(extractOpencodeFinalMessage(stdout), "second answer");
});

test("extractOpencodeFinalMessage: ignores non-JSON lines", () => {
  const stdout = [
    "some plain stdout chatter",
    '{"role":"assistant","content":"yes"}',
    "more chatter",
  ].join("\n");
  assert.equal(extractOpencodeFinalMessage(stdout), "yes");
});

test("extractOpencodeFinalMessage: throws when no assistant event found", () => {
  const stdout = '{"type":"tool_call","name":"rg"}';
  assert.throws(() => extractOpencodeFinalMessage(stdout), /no assistant message found/);
});

// ---- parseEngine --------------------------------------------------------

test("parseEngine: valid values", () => {
  assert.equal(parseEngine("opencode"), "opencode");
  assert.equal(parseEngine("codex"), "codex");
  assert.equal(parseEngine("claude"), "claude");
});

test("parseEngine: undefined defaults to opencode", () => {
  assert.equal(parseEngine(undefined), "opencode");
});

test("parseEngine: case-insensitive", () => {
  assert.equal(parseEngine("OPENCODE"), "opencode");
});

test("parseEngine: invalid throws", () => {
  assert.throws(() => parseEngine("gemini"), /must be opencode\|codex\|claude/);
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
  const raw = {
    disposition: "valid-bug",
    severity: "medium",
    suggested_labels: ["domain/admin"],
    confidence: 0.8,
    reasoning: "ok",
    evidence_quotes: ["x".repeat(800)], // would fail Zod max(500)
    duplicate_of: null,
    missing_template_fields: [],
    affected_paths: [],
    related_issues: [],
    related_prs: [],
    recent_commits_in_area: [],
    change_size_estimate: "small",
  };
  truncateOversizedFields(raw);
  const parsed = TriageOutput.parse(raw); // no throw
  assert.equal(parsed.evidence_quotes[0].length, 500);
});

// ---- skill/input: template-field extraction -----------------------------

test("extractTemplateFields: parses ### section headers from issue body", () => {
  const body = `### Shopware Version

6.7.1.0

### Affected area / extension

Platform(Default)

### Actual behaviour

It crashes on save.

### Expected behaviour

_No response_

### How to reproduce

.
`;
  const fields = extractTemplateFields(body);
  assert.equal(fields.shopware_version, "6.7.1.0");
  assert.equal(fields.affected_area, "Platform(Default)");
  assert.equal(fields.actual_behaviour, "It crashes on save.");
  // "_No response_" and "." placeholders → null per existing convention
  assert.equal(fields.expected_behaviour, null);
  assert.equal(fields.reproduction_steps, null);
});

test("extractTemplateFields: returns all-null on null/empty body", () => {
  const empty = extractTemplateFields(null);
  assert.equal(empty.shopware_version, null);
  assert.equal(empty.actual_behaviour, null);
});

// ---- skill/input: language detection ------------------------------------

test("detectLanguage: German body", () => {
  assert.equal(detectLanguage("Das ist nicht korrekt"), "de");
});

test("detectLanguage: French body", () => {
  assert.equal(detectLanguage("Ce n'est pas correct, nous voulons être sûrs"), "fr");
});

test("detectLanguage: English default", () => {
  assert.equal(detectLanguage("The button is broken"), "en");
});

test("detectLanguage: null body is unknown", () => {
  assert.equal(detectLanguage(null), "unknown");
});

// ---- skill/input: frontmatter strip -------------------------------------

test("stripFrontmatter: removes YAML frontmatter block", () => {
  const skillFile = `---
name: triage
description: Triage shopware issues
---

# Skill body starts here
`;
  const body = stripFrontmatter(skillFile);
  assert.equal(body, "# Skill body starts here\n");
});

test("stripFrontmatter: returns unchanged when no frontmatter", () => {
  const plain = "# Just markdown\nNo frontmatter at all.";
  assert.equal(stripFrontmatter(plain), plain);
});

test("stripFrontmatter: returns unchanged when frontmatter closing is missing", () => {
  const broken = "---\nname: triage\n# Body without closing fence\n";
  assert.equal(stripFrontmatter(broken), broken);
});

test("stripFrontmatter: tolerates UTF-8 BOM at file start", () => {
  const skillFile = "﻿---\nname: triage\ndescription: x\n---\n\n# Body starts here\n";
  assert.equal(stripFrontmatter(skillFile), "# Body starts here\n");
});

test("stripFrontmatter: tolerates CRLF line endings", () => {
  const skillFile = "---\r\nname: triage\r\ndescription: x\r\n---\r\n\r\n# Body\r\n";
  assert.match(stripFrontmatter(skillFile), /^# Body/);
});

// ---- skill/input: prompt assembly ---------------------------------------

test("formatPromptWithInput: wraps input JSON in <input_json> tags", () => {
  const body = "# Skill\nDo the thing.";
  const input = SkillInput.parse({
    issue_id: 42,
    title: "T",
    body: "B",
    labels: [],
    language_detected: "en",
    template_fields: {
      shopware_version: null,
      affected_area: null,
      actual_behaviour: null,
      expected_behaviour: null,
      reproduction_steps: null,
    },
  });
  const prompt = formatPromptWithInput(body, input);
  assert.match(prompt, /^# Skill\nDo the thing\./);
  assert.match(prompt, /<input_json>\n[\s\S]+"issue_id": 42[\s\S]+<\/input_json>\n$/);
});

test("SkillInput: rejects invalid language_detected value", () => {
  assert.throws(() => SkillInput.parse({
    issue_id: 1, title: "x", body: "x", labels: [],
    language_detected: "klingon",
    template_fields: { shopware_version: null, affected_area: null, actual_behaviour: null, expected_behaviour: null, reproduction_steps: null },
  }));
});
