/**
 * Unit tests for the wrapper CLI (`triage.ts`):
 *   - extractOpencodeFinalMessage: parses opencode's JSONL stdout
 *   - ClaudeEnvelope: parses claude --output-format json envelope
 *   - buildChildEnv: per-engine env construction
 *   - extract{Opencode,Codex,Claude}Usage: token/cost telemetry extraction
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractOpencodeFinalMessage,
  ClaudeEnvelope,
  buildChildEnv,
  extractOpencodeUsage,
  extractCodexUsage,
  extractClaudeUsage,
} from "./triage.ts";

// ---- extractOpencodeFinalMessage ----------------------------------------

test("extractOpencodeFinalMessage: opencode 1.15.5 verified shape — {type:'text', part:{text}}", () => {
  // Real shape from opencode 1.15.5 CI capture 2026-05-20.
  const stdout = '{"type":"text","timestamp":1779276488,"sessionID":"ses_x","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_x","type":"text","text":"final answer text","time":{"start":1779276487999}}}';
  assert.equal(extractOpencodeFinalMessage(stdout), "final answer text");
});

test("extractOpencodeFinalMessage: last-candidate-wins rule", () => {
  const stdout = [
    '{"type":"text","part":{"text":"first answer"}}',
    '{"type":"tool_call"}',
    '{"type":"text","part":{"text":"second answer"}}',
  ].join("\n");
  assert.equal(extractOpencodeFinalMessage(stdout), "second answer");
});

test("extractOpencodeFinalMessage: ignores non-JSON and non-matching lines", () => {
  const stdout = [
    "some plain stdout chatter",
    '{"type":"tool_call","name":"rg"}',
    '{"type":"text","part":{"text":"yes"}}',
    "more chatter",
  ].join("\n");
  assert.equal(extractOpencodeFinalMessage(stdout), "yes");
});

test("extractOpencodeFinalMessage: throws when no text event found", () => {
  const stdout = '{"type":"tool_call","name":"rg"}';
  assert.throws(() => extractOpencodeFinalMessage(stdout), /no assistant message found/);
});

// ---- ClaudeEnvelope -----------------------------------------------------

test("ClaudeEnvelope: accepts string result + extra envelope keys (passthrough)", () => {
  const parsed = ClaudeEnvelope.parse({ result: "final answer text", total_cost_usd: 0.01, usage: {} });
  assert.equal(parsed.result, "final answer text");
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
      cache_read_input_tokens: 1200, // ignored — only top-level metrics are surfaced
    },
  };
  const usage = extractClaudeUsage(envelope);
  assert.equal(usage.input_tokens, 4500);
  assert.equal(usage.output_tokens, 320);
  assert.equal(usage.total_tokens, 4820);
  assert.equal(usage.total_cost_usd, 0.0123);
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

test("extractOpencodeUsage: harvests tokens from JSONL events (anthropic naming)", () => {
  const stdout = [
    '{"type":"text","part":{"text":"answer"}}',
    '{"type":"complete","tokens":{"input_tokens":1234,"output_tokens":567},"cost":0.0042}',
  ].join("\n");
  const usage = extractOpencodeUsage(stdout);
  assert.equal(usage.input_tokens, 1234);
  assert.equal(usage.output_tokens, 567);
  assert.equal(usage.total_tokens, 1801);
  assert.equal(usage.total_cost_usd, 0.0042);
});

test("extractOpencodeUsage: harvests tokens (openai naming)", () => {
  const stdout = '{"type":"complete","usage":{"prompt_tokens":100,"completion_tokens":50}}';
  const usage = extractOpencodeUsage(stdout);
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.output_tokens, 50);
});

test("extractOpencodeUsage: returns EMPTY when no token events", () => {
  const usage = extractOpencodeUsage('{"type":"text","part":{"text":"answer"}}');
  assert.equal(usage.input_tokens, null);
  assert.equal(usage.total_cost_usd, null);
});

test("extractCodexUsage: stub returns null fields (codex format not yet verified)", () => {
  const usage = extractCodexUsage("spawn ok\n[meta] some output\nfinished\n");
  assert.equal(usage.input_tokens, null);
  assert.equal(usage.output_tokens, null);
  assert.equal(usage.total_tokens, null);
  assert.equal(usage.total_cost_usd, null);
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
