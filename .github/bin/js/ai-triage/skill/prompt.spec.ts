/**
 * Unit tests for the skill prompt-assembly helpers:
 *   - stripFrontmatter: removes YAML frontmatter from SKILL.md before sending to engine
 *   - formatPromptWithInput: wraps SkillInput in <input_json> tags
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stripFrontmatter, formatPromptWithInput } from "./prompt.ts";
import { SkillInput } from "./input.ts";

// ---- stripFrontmatter ---------------------------------------------------

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

// ---- formatPromptWithInput ----------------------------------------------

test("formatPromptWithInput: wraps input JSON in <input_json> tags", () => {
  const body = "# Skill\nDo the thing.";
  const input = SkillInput.parse({
    issue_id: 42,
    title: "T",
    body: "B",
    labels: [],
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
