---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, architecture, ai-triage, pr-16860]
dependencies: []
---

# P2: `runEngine` couples the engine layer to the triage schema

## Problem
The OVERVIEW.md / AGENTS.md claim: "engine-spawn code is task-agnostic and
ready for extraction into a shared `lib/` once a second task lands." The
*runner functions* (`runOpencode` / `runCodex` / `runClaude`) honour this —
they return raw `string`. But `runEngine` itself bakes in the triage schema:

```ts
// triage.ts:438-441
const parsedJson = parseJsonFromText(finalText, engine);
truncateOversizedFields(parsedJson);
const output = TriageOutput.parse(parsedJson);
return { output, wallClockMs: Date.now() - start, engine };
```

…and the return type `EngineResult.output: TriageOutput` (`triage.ts:92`) ties
the engine layer's return type to the task schema. A second task (`ai-pr-review`)
cannot reuse `runEngine` without forking it — the abstraction is one refactor
away from real.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/triage.ts:91-95`
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/triage.ts:414-446`
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/AGENTS.md:30-35`
  (the "Don'ts" list says runner functions; it's silent on `runEngine`)

## Proposed fix
Either:
- **Option A (preferred for now):** keep `runEngine` private to triage; move
  the engine runners + `spawnAndWait` + `buildChildEnv` into a small `lib/`
  module that `main()` calls directly. `main()` then does
  `parseJsonFromText` + `TriageOutput.parse` itself.
- **Option B:** make `runEngine` generic:
  ```ts
  function runEngine<TOutput>(args: {
    skillPath: string; schemaPath: string; repoRoot: string;
    input: unknown; schema: ZodType<TOutput>;
  }): Promise<{ output: TOutput; wallClockMs: number; engine: Engine }>
  ```

Do this BEFORE the second skill lands; otherwise the second skill author
copy-pastes 500 lines. ~30-line move.

Also update `AGENTS.md:30-35` to call out that the orchestrator (not just the
runners) must stay task-agnostic.

## Acceptance criteria
- [ ] Engine runners + `spawnAndWait` are importable from a non-triage
      entrypoint without dragging in `TriageOutput`.
- [ ] `EngineResult` is no longer parameterised by `TriageOutput`.
- [ ] AGENTS.md "Don'ts" list updated.

## Resources
- Architecture review section "Q1".
