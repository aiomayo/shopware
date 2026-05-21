/**
 * Unit tests for the wrapper CLI (`triage.ts`):
 *   - extractOpencodeFinalMessage: parses opencode's JSONL stdout (multiple shapes)
 *   - parseEngine: --engine CLI argument validation
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractOpencodeFinalMessage,
  parseEngine,
  ClaudeEnvelope,
  buildChildEnv,
  extractOpencodeUsage,
  extractCodexUsage,
  extractClaudeUsage,
} from "./triage.ts";

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

// ---- ClaudeEnvelope -----------------------------------------------------

test("ClaudeEnvelope: accepts string-result shape (older CLI)", () => {
  const parsed = ClaudeEnvelope.parse({ result: "final answer text" });
  assert.equal((parsed.result as string), "final answer text");
});

test("ClaudeEnvelope: accepts object-result shape (newer CLI)", () => {
  const parsed = ClaudeEnvelope.parse({ result: { text: "final answer text" } });
  assert.deepEqual(parsed.result, { text: "final answer text" });
});

test("ClaudeEnvelope: rejects unknown shape", () => {
  assert.throws(() => ClaudeEnvelope.parse({ result: 42 }));
  assert.throws(() => ClaudeEnvelope.parse({}));
});

// ---- buildChildEnv ------------------------------------------------------

test("buildChildEnv: opencode pins all three XDG_* dirs to the per-run xdg dir", () => {
  const childEnv = buildChildEnv("opencode", "/tmp/run-xyz");
  assert.equal(childEnv.XDG_DATA_HOME, "/tmp/run-xyz");
  assert.equal(childEnv.XDG_CONFIG_HOME, "/tmp/run-xyz");
  assert.equal(childEnv.XDG_CACHE_HOME, "/tmp/run-xyz");
});

test("buildChildEnv: codex inherits host XDG_* (does not pin)", () => {
  const originalConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/host/xdg/config";
  try {
    const childEnv = buildChildEnv("codex", "/tmp/ignored");
    assert.equal(childEnv.XDG_CONFIG_HOME, "/host/xdg/config");
  } finally {
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfig;
  }
});

test("buildChildEnv: claude inherits host XDG_* (does not pin)", () => {
  const childEnv = buildChildEnv("claude", "/tmp/ignored");
  // host XDG values pass through unchanged (may be undefined on bare CI); the
  // key assertion is the function does NOT pin to xdgDir.
  assert.notEqual(childEnv.XDG_DATA_HOME, "/tmp/ignored");
});

// ---- usage extractors ---------------------------------------------------

test("extractClaudeUsage: parses input/output tokens + total_cost_usd", () => {
  const envelope = {
    result: "ok",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 4500,
      output_tokens: 320,
      cache_read_input_tokens: 1200,
    },
  };
  const usage = extractClaudeUsage(envelope);
  assert.equal(usage.input_tokens, 4500);
  assert.equal(usage.output_tokens, 320);
  assert.equal(usage.total_tokens, 4820);
  assert.equal(usage.total_cost_usd, 0.0123);
  assert.equal(usage.raw.cache_read_input_tokens, 1200);
});

test("extractClaudeUsage: returns null fields when usage is absent", () => {
  const usage = extractClaudeUsage({ result: "ok" });
  assert.equal(usage.input_tokens, null);
  assert.equal(usage.total_tokens, null);
  assert.equal(usage.total_cost_usd, null);
});

test("extractClaudeUsage: tolerates non-object input", () => {
  assert.equal(extractClaudeUsage(null).input_tokens, null);
  assert.equal(extractClaudeUsage("not json").total_tokens, null);
});

test("extractOpencodeUsage: harvests tokens from JSONL events", () => {
  const stdout = [
    '{"type":"text","part":{"text":"answer"}}',
    '{"type":"complete","tokens":{"input":1234,"output":567},"cost":0.0042}',
  ].join("\n");
  const usage = extractOpencodeUsage(stdout);
  assert.equal(usage.input_tokens, 1234);
  assert.equal(usage.output_tokens, 567);
  assert.equal(usage.total_tokens, 1801);
  assert.equal(usage.total_cost_usd, 0.0042);
});

test("extractOpencodeUsage: returns EMPTY when no token events", () => {
  const usage = extractOpencodeUsage('{"type":"text","part":{"text":"answer"}}');
  assert.equal(usage.input_tokens, null);
  assert.equal(usage.total_cost_usd, null);
});

test("extractCodexUsage: parses 'tokens: input=X output=Y total=Z' lines from stderr", () => {
  const stderr = "spawn ok\n[meta] tokens: input=2500 output=410 total=2910\nfinished\n";
  const usage = extractCodexUsage(stderr);
  assert.equal(usage.input_tokens, 2500);
  assert.equal(usage.output_tokens, 410);
  assert.equal(usage.total_tokens, 2910);
});

test("buildChildEnv: provider keys always passed through (multi-provider safe)", () => {
  const originalOpenai = process.env.OPENAI_API_KEY;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-openai";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-anthropic";
  try {
    const childEnv = buildChildEnv("opencode", "/tmp/x");
    assert.equal(childEnv.OPENAI_API_KEY, "sk-test-openai");
    assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-ant-test-anthropic");
  } finally {
    if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenai;
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
  }
});
