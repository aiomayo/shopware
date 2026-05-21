---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, security, ai-triage, pr-16860]
dependencies: []
---

# P1: opencode receives the prompt via argv (process accounting + ARG_MAX risk)

## Problem
`runOpencode` passes the composed prompt (skill body + redacted issue JSON) as the
**last positional argv** to the opencode CLI. Two follow-on issues:

1. **Process accounting leak** — anything in argv is visible to other processes via
   `ps auxww` / `/proc/<pid>/cmdline`. Every sub-tool opencode spawns (`gh`, `rg`,
   `git`) inherits a parent whose cmdline is the full prompt. `runClaude` explicitly
   uses stdin "to avoid exposure in `ps auxww` / process accounting" — the same
   protection is absent here, and opencode is the **default engine**.
2. **`ARG_MAX` ceiling (~128 KB on Linux)** — a 50 KB Shopware bug body (templates +
   reproduction steps + stack trace + comments quoted in body) crashes opencode
   with `E2BIG`, not a clean error.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/triage.ts:325-339`
  passes `prompt` as last argv.
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/triage.ts:399` (claude)
  uses `"-p", "-"` + stdin; comment on `triage.ts:386-388` documents the threat.

## Proposed fix
- **Preferred:** pass the prompt via stdin if opencode supports `run --prompt -`
  (verify against `opencode-ai@1.15.5`).
- **Fallback:** write the prompt to a tempfile under `xdgDir` and pass the path
  via a `--prompt-file` flag, or feed via stdin if available.

## Acceptance criteria
- [ ] `ps auxww` during a triage run does NOT contain the issue body.
- [ ] A 60 KB body completes without `E2BIG`.
- [ ] No regression in `triage.spec.ts` opencode parsing tests.

## Resources
- PR #16860
- Security review finding H1.
