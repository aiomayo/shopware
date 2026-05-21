---
status: pending
priority: p2
issue_id: "009"
tags: [code-review, typescript, tests, ai-triage, pr-16860]
dependencies: []
---

# P2: Engine switch lacks exhaustiveness guard; ClaudeEnvelope untested

## Problem
1. **No exhaustiveness check on the engine switch** at `triage.ts:430-434`.
   Today TS narrows correctly because the `Engine` union is closed, but the
   moment a 4th engine is added, the safest "fix" any maintainer reaches for
   (`finalText = ""` initialiser) silently bypasses the missing branch. The
   correct pattern is an explicit `_exhaustive: never` default arm.
2. **`ClaudeEnvelope` union has zero test coverage.** Two-shape union, both
   shapes go through `runClaude`'s ternary at `triage.ts:411`, no test in
   `triage.spec.ts` exercises either branch. When claude-code's CLI version
   bumps and changes the envelope, no unit test catches it.
3. **Engine-conditional `buildChildEnv` logic untested** — XDG isolation for
   opencode (`triage.ts:228-232`), API-key suppression for claude under
   `AI_TRIAGE_PREFER_SUBSCRIPTION` (`:236-238`). Behaviour the comments call
   "empirically confirmed" with no regression test.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/triage.ts:430-434`
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/triage.ts:374-377,411`
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/triage.ts:192-240`
- No matching tests in `triage.spec.ts`.

## Proposed fix
```ts
switch (engine) {
  case "opencode": finalText = await runOpencode(...); break;
  case "codex": finalText = await runCodex(...); break;
  case "claude": finalText = await runClaude(...); break;
  default: {
    const _exhaustive: never = engine;
    throw new Error(`unreachable engine: ${_exhaustive}`);
  }
}
```

Export `ClaudeEnvelope` and `buildChildEnv` for testing; add:
- `ClaudeEnvelope.parse({ result: "text" })` → ok
- `ClaudeEnvelope.parse({ result: { text: "text" } })` → ok
- `buildChildEnv("opencode", "/tmp/x")` sets all three `XDG_*` to `/tmp/x`
- `buildChildEnv("codex", "/tmp/x")` preserves host `XDG_*`
- `buildChildEnv("claude", "/tmp/x")` with `AI_TRIAGE_PREFER_SUBSCRIPTION=1`
  removes `ANTHROPIC_API_KEY`

## Acceptance criteria
- [ ] Engine switch has explicit `_exhaustive: never` default.
- [ ] 5+ new tests cover `ClaudeEnvelope` and `buildChildEnv`.

## Resources
- TypeScript review findings S1 + S4.
