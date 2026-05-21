---
status: pending
priority: p1
issue_id: "002"
tags: [code-review, security, ai-triage, pr-16860]
dependencies: []
---

# P1: Agent tool allowlists are over-broad (Bash gh / git / head / tail + ls drift)

## Problem
The agent's tool allowlist is wider than needed and contains both **risky**
subcommands and a **drift between SKILL.md and the claude wrapper**.

1. `Bash(gh:*)` permits every `gh` subcommand (`gh secret list`, `gh repo edit`,
   `gh issue create`, `gh workflow run`, `gh auth status -t`). Most are 403 under
   today's `contents: read, issues: read` scope, but `gh auth status -t` prints
   the bearer token to stdout — caught by the redactor only as long as the token
   prefix patterns stay current. A future workflow that adds `contents: write`
   (planned for comment-posting) turns this into RCE-grade scope.
2. `Bash(git:*)` permits `git push`, `git config`, `git remote add`, etc.
3. `Bash(head:*)` + `Bash(tail:*)` allow `head /proc/self/environ` →
   secrets-into-output via prompt injection. The post-run redactor catches
   `sk-…` / `ghs_…` / `ghp_…` prefixes but is not exhaustive.
4. **SKILL.md ↔ claude wrapper drift:** SKILL.md `allowed-tools` declares
   `Bash(ls:*)`; the claude `--allowedTools` flag in `triage.ts` does NOT include
   `ls`. The skill's own examples (`references/TOOLS.md`) reference `ls
   src/Core/Content/ImportExport/`. Interactive Claude Code use believes `ls` is
   available; wrapper-fed claude rejects it.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/triage.ts:396`
- `/Users/T.Altholtmann/code/sw1/.claude/skills/triage/SKILL.md:11`
- `/Users/T.Altholtmann/code/sw1/.claude/skills/triage/references/TOOLS.md:10`

## Proposed fix
- Narrow `Bash(gh:*)` to `Bash(gh issue view:*) Bash(gh pr view:*) Bash(gh issue
  list:*) Bash(gh pr list:*) Bash(gh api repos/*/issues/*:*) Bash(gh api
  repos/*/pulls/*:*)`.
- Narrow `Bash(git:*)` to `Bash(git log:*) Bash(git show:*) Bash(git diff:*)
  Bash(git blame:*)`.
- Remove `Bash(head:*)` and `Bash(tail:*)` from claude — use the path-confined
  `Read` tool instead.
- Add `Bash(ls:*)` to the claude `--allowedTools` flag (or remove from SKILL.md
  if not actually needed).
- Add a workflow-file comment loudly forbidding `permissions.contents: write` in
  this job; future comment-posting MUST live in a separate sibling job with no
  agent — it just reads the JSON artifact and posts.

## Acceptance criteria
- [ ] `Bash(gh:*)` / `Bash(git:*)` no longer appear in claude wrapper or SKILL.md.
- [ ] `Bash(head:*)` / `Bash(tail:*)` removed from claude wrapper.
- [ ] `ls` is consistent between SKILL.md frontmatter and `triage.ts:396`.
- [ ] Workflow comment documents "no `contents: write` in this job, ever".

## Resources
- Security review findings H2 + M2.
- Agent-native review finding #1 (Bash(ls:*) drift).
