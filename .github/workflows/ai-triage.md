---
# gh aw SOURCE for AI issue triage (read-only, pragmatic first test).
# Compile with `gh aw compile` → produces ai-triage.lock.yml (committed, never hand-edited).
# Spike status: engine.version left at default for the first test; PIN it before Phase 1
# (research: gh aw ships 2-3 releases/day — avoid retired range v0.68.4–v0.71.3).

on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: "Issue number to triage"
        required: true
        type: number
  # TEMPORARY registration trigger — GitHub registers a workflow_dispatch workflow only
  # after it exists on the default branch OR has run at least once. This fires the
  # workflow once on push to register it so `gh aw run --ref <branch>` works; the agent
  # bails immediately (empty issue_number). REMOVE after the first push registers it.
  push:
    paths:
      - '.github/workflows/ai-triage.md'
      - '.github/workflows/ai-triage.lock.yml'

concurrency:                 # explicit — workflow_dispatch default group cancels parallel runs (gh-aw #19467)
  group: ai-triage-${{ github.event.inputs.issue_number }}
  cancel-in-progress: false

engine:
  id: claude
  # version: "x.y.z"         # TODO(Phase 1): pin Claude Code CLI release once first test passes
  max-turns: 15              # claude-only; bound the loop so Bash-denials don't burn turns
  env:
    # The repo's ANTHROPIC_API_KEY secret is empty; the real Quality-Initiative key is in
    # QUALITY_INITIATIVE_ANTHROPIC_API_KEY. Map it into what the claude engine reads.
    ANTHROPIC_API_KEY: ${{ secrets.QUALITY_INITIATIVE_ANTHROPIC_API_KEY }}

permissions: read-all        # read-only agent; the only output is a run artifact
network: defaults
timeout-minutes: 8

tools:
  github:
    toolsets: [issues, labels]
  # NOTE(spike): the agent also needs read-only shell (rg / git log / gh issue|pr view / find)
  # and file Read for .github/aw + .claude/skills/triage/references/*. The exact gh aw
  # allowlist syntax for claude bash tools is unverified — `gh aw compile --strict` in
  # Stage B will surface the correct keys; adjust here then.

safe-outputs:
  upload-artifact:           # Option B: full TriageOutput JSON (richest contract, post-validated)
    max-uploads: 1
    retention-days: 7
    allowed-paths:
      - "triage-output.json"
---

# Shopware Issue Triage

{{#runtime-import .github/aw/triage-policy.md}}

---

## This run

**Registration run check (do this first):** if `issue_number` is empty — i.e. the input
`${{ github.event.inputs.issue_number }}` renders as blank (this happens on the temporary
registration `push` event, not on a real `workflow_dispatch`) — then take NO action,
do not investigate, do not call any tool, and stop immediately. This is only a workflow
registration run.

Otherwise, triage issue **#${{ github.event.inputs.issue_number }}** using the policy and
references above. Investigate read-only (no labels, comments, or writes). When done, write
your single `TriageOutput` JSON object to a file named `triage-output.json` in the
workspace root, then call the `upload_artifact` tool on that path. Emit ONLY the JSON to
that file — no surrounding prose, no markdown fence.
