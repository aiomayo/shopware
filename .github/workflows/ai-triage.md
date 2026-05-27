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
    toolsets: [issues, labels, pull_requests]
    min-integrity: none   # triage must read issues from any contributor (not just 'approved')
  # Read-only shell for code investigation (affected_paths, recent fixes). Least-privilege:
  # git limited to inspection subcommands; no push/config/remote.
  bash: ["rg", "find", "git log", "git show", "git diff", "git blame"]

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

Triage issue **#${{ github.event.inputs.issue_number }}** using the policy and references
above. Investigate read-only (no labels, comments, or writes). When done, write your
single `TriageOutput` JSON object to a file named `triage-output.json` in the workspace
root, then call the `upload_artifact` tool on that path. Emit ONLY the JSON to that file
— no surrounding prose, no markdown fence.
