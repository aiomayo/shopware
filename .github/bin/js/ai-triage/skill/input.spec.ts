/**
 * Unit tests for the skill input contract:
 *   - extractTemplateFields: parses ### section headers from issue body
 *   - detectLanguage: heuristic language detection
 *   - SkillInput: Zod schema for the wrapper → skill payload
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractTemplateFields,
  detectLanguage,
  SkillInput,
  RawIssue,
  truncateRawIssueInput,
  MAX_BODY_LEN,
  MAX_TITLE_LEN,
  MAX_LABELS,
  MAX_LABEL_LEN,
} from "./input.ts";

// ---- template-field extraction ------------------------------------------

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

// ---- language detection -------------------------------------------------

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

// ---- SkillInput Zod -----------------------------------------------------

test("SkillInput: rejects invalid language_detected value", () => {
  assert.throws(() => SkillInput.parse({
    issue_id: 1, title: "x", body: "x", labels: [],
    language_detected: "klingon",
    template_fields: { shopware_version: null, affected_area: null, actual_behaviour: null, expected_behaviour: null, reproduction_steps: null },
  }));
});

// ---- size caps (truncateRawIssueInput + Zod hard limits) ----------------

test("truncateRawIssueInput: caps oversized body and marks it [truncated]", () => {
  const oversized = "a".repeat(MAX_BODY_LEN + 5000);
  const out = truncateRawIssueInput({ issue_id: 1, title: "t", body: oversized, labels: [] }) as { body: string };
  assert.ok(out.body.length <= MAX_BODY_LEN, `body len ${out.body.length} > cap ${MAX_BODY_LEN}`);
  assert.match(out.body, /\[truncated\]$/);
});

test("truncateRawIssueInput: caps title length", () => {
  const t = "x".repeat(MAX_TITLE_LEN + 100);
  const out = truncateRawIssueInput({ issue_id: 1, title: t, body: null, labels: [] }) as { title: string };
  assert.equal(out.title.length, MAX_TITLE_LEN);
});

test("truncateRawIssueInput: caps label count and per-label length", () => {
  const tooMany = Array.from({ length: MAX_LABELS + 20 }, (_, i) => `label-${i}-${"y".repeat(MAX_LABEL_LEN + 50)}`);
  const out = truncateRawIssueInput({ issue_id: 1, title: "t", body: null, labels: tooMany }) as { labels: string[] };
  assert.equal(out.labels.length, MAX_LABELS);
  for (const l of out.labels) assert.ok(l.length <= MAX_LABEL_LEN);
});

test("truncateRawIssueInput: leaves small inputs unchanged", () => {
  const small = { issue_id: 42, title: "small", body: "short", labels: ["a", "b"] };
  const out = truncateRawIssueInput(small) as typeof small;
  assert.deepEqual(out, { issue_id: 42, title: "small", body: "short", labels: ["a", "b"] });
});

test("RawIssue: rejects body that exceeds MAX_BODY_LEN", () => {
  // After truncateRawIssueInput, this shouldn't happen — but the Zod schema is
  // the final guard, so it must reject directly.
  assert.throws(() => RawIssue.parse({
    issue_id: 1, title: "t", body: "x".repeat(MAX_BODY_LEN + 1), labels: [],
  }));
});

test("RawIssue: rejects non-positive issue_id (zero, negative, non-integer)", () => {
  assert.throws(() => RawIssue.parse({ issue_id: 0, title: "t", body: null, labels: [] }));
  assert.throws(() => RawIssue.parse({ issue_id: -5, title: "t", body: null, labels: [] }));
  assert.throws(() => RawIssue.parse({ issue_id: 1.5, title: "t", body: null, labels: [] }));
});
