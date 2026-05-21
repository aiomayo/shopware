---
status: pending
priority: p3
issue_id: "011"
tags: [code-review, simplicity, ai-triage, pr-16860]
dependencies: []
---

# P3: Speculative code paths and env vars — YAGNI cleanup pass

## Problem
A handful of code paths are speculative defence against drift that hasn't
been observed against the pinned versions. Together they add ~80 LOC and
2-3 maintenance commitments that should pay off later, not now.

Candidates (all justify themselves loosely with "future drift"):

1. **`extractOpencodeFinalMessage` shapes 2-4** (`triage.ts:286-296`) — only
   shape 1 is verified against `opencode-ai@1.15.5`. Shapes 2-4 + their 3
   tests are dead branches against the pinned version.
2. **`ClaudeEnvelope` two-shape union** (`triage.ts:374-377`) — only one
   shape verified against `@anthropic-ai/claude-code@2.1.144`. Anticipated
   drift, not observed.
3. **`parseEngine` exported function** (`triage.ts:97-101`) — only callers
   are tests of behaviour (case-insensitivity) that the real env-parsing
   path doesn't support. Dead code wrapped in tests.
4. **`AI_TRIAGE_REPO_ROOT` env var** (`triage.ts:79`) — never overridden,
   default works in every realistic scenario.
5. **`AI_TRIAGE_PREFER_SUBSCRIPTION` env var** (`triage.ts:81, 236-238`) —
   manual workaround for a 1-dev edge case; `unset ANTHROPIC_API_KEY`
   achieves the same locally.
6. **`truncateOversizedFields`** (`skill/output.ts:38-68`) — separate
   mutating function for "opencode lacks engine-side schema enforcement".
   Either move limits into the prompt (skill says "max 500 chars per
   quote") and fail loudly on overshoot, or keep the function but document
   the failure mode.

## Proposed fix
Pick at least the easy wins (3, 4, 5) now; defer 1, 2, 6 to a "post-merge
cleanup" PR with a smoke test against real engine output to validate the
behaviour the speculative code anticipates.

## Acceptance criteria
- [ ] `parseEngine` removed (tests dropped or migrated to `EnvSchema`).
- [ ] `AI_TRIAGE_REPO_ROOT` inlined as a constant.
- [ ] `AI_TRIAGE_PREFER_SUBSCRIPTION` removed; docs note "unset
      ANTHROPIC_API_KEY locally" as the workaround.
- [ ] (Optional) shapes 2-4 / `ClaudeEnvelope` / `truncateOversizedFields`
      decisions tracked.

## Resources
- Simplicity review findings #1, #2, #4, #5, #7.
- TypeScript review finding N6.
