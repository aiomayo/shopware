---
status: pending
priority: p2
issue_id: "010"
tags: [code-review, ops, security, ai-triage, pr-16860]
dependencies: []
---

# P2: `cancel-in-progress: true` enables budget-DoS; 14-day artifact retention

## Problem
1. **`cancel-in-progress: true` on the workflow** (`ai-triage.yml:39`) means
   each rapid-fire `workflow_dispatch` on the same issue kills the previous
   run *after* it has consumed model tokens. A repo collaborator (or scripted
   misuse / compromised account) can loop `gh workflow run … -f issue_number=N`
   and burn API budget on inputs that never complete. Combined with no body
   size cap (todo #003), per-attempt cost is highest at cancellation.
2. **14-day artifact retention on a public repo** (`ai-triage.yml:211`) —
   workflow artifacts are visible to all repo collaborators. Any content
   the redactor missed (see todo #006) is durably accessible for 14 days.
   14 days is a debug window appropriate for the foundation iteration; not
   for steady state.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/workflows/ai-triage.yml:37-39, 211`

## Proposed fix
- Flip to `cancel-in-progress: false`. Let the first run complete; queue
  the rest. Issue-state changes between runs are noise.
- Drop retention to `retention-days: 3` once the workflow is stable.
- Flip `if-no-files-found: warn` → `error` so a silent redactor failure
  is loud.

## Acceptance criteria
- [ ] `cancel-in-progress: false`.
- [ ] Retention review entry added to OVERVIEW.md / README.md.
- [ ] `if-no-files-found: error`.

## Resources
- Security review findings M4 + L3.
