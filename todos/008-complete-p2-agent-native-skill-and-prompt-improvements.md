---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, agent-native, prompt, ai-triage, pr-16860]
dependencies: []
---

# P2: SKILL.md gaps — missing examples + change_size_estimate anti-reward-hacking

## Problem
1. **`assets/examples.md` covers only 3 of 5 dispositions** — `valid-bug`,
   `needs-info`, `duplicate`. Missing: `not-a-bug` and `feature-request`.
   These are exactly the two the agent is most likely to mis-classify
   (misfiled support ticket vs `not-a-bug`; "please make this configurable"
   vs `feature-request`). Without worked examples, the agent extrapolates
   from the rubric alone.
2. **Anti-reward-hacking rubric (SKILL.md:124-133) doesn't cover
   `change_size_estimate`** — only confidence and severity have explicit
   calibration guards. A model that wants to "look thorough" biases toward
   `medium`/`large` without inspecting affected files. Today there's no
   "default to `unknown` if you didn't inspect" rule.
3. **Schema URL hygiene** — `SKILL.md:13` `output-schema-url` points to a
   GitHub HTML blob view, not raw content. Decorative only (no consumer
   fetches it), but weakens the "single source of truth" narrative.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.claude/skills/triage/assets/examples.md`
- `/Users/T.Altholtmann/code/sw1/.claude/skills/triage/SKILL.md:13` and
  `:124-133`

## Proposed fix
- Add one short worked example each for `not-a-bug` and `feature-request`
  (~15 lines JSON each).
- Add one line to anti-reward-hacking: "Default to `unknown` for
  `change_size_estimate` unless you actually inspected the affected files.
  Don't guess from the issue body alone."
- Either remove `output-schema-url` from SKILL.md or change it to a
  `raw.githubusercontent.com` URL pinned to a tag/SHA.

## Acceptance criteria
- [ ] `examples.md` has all 5 dispositions covered.
- [ ] Anti-reward-hacking section addresses `change_size_estimate`.
- [ ] `output-schema-url` is either removed or fetchable raw JSON.

## Resources
- Agent-native review findings #3, #4, #7.
