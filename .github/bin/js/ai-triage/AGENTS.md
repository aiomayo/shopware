# AI Triage Agent — Project-Local Rules

These rules apply to any agent invoked from this directory. They are durable conventions, not task-specific instructions.

## Shell-Tool Discipline

Prefer cheap, scoped reads over noisy or expensive ones.

**Do:**

- Use `rg <pattern> <path>` with a path constraint and (when possible) `--type=<lang>`.
- Use `head -N <file>` or `rg -A <n> -B <n>` for context windows.
- Use `git log --oneline -N -- <path>` — always `--oneline` and always with a path filter.
- Parallelize independent reads in a single tool turn when paths are independent.

**Don't:**

- `cat` files larger than ~200 lines without slicing.
- `git log` without `--oneline` and without a `-- <path>` filter.
- `find /` or unrestricted globs.
- Re-read the same file twice within a session.
- Speculatively browse unrelated directories.

## GitHub-API (`gh`) Discipline

`gh` calls cost network round-trips and rate-limit budget.

**Do:**

- Cap at ~5 `gh` calls per triage session.
- Use `--json <fields>` to request only the fields you need.
- Prefer one well-targeted `gh issue list --search "<keywords>"` over multiple slight variations.

**Don't:**

- Run `gh issue list` multiple times with slight keyword variations — pick 1–2 good queries.
- Fetch full issue bodies for every candidate — use list+title-match first, only `gh issue view` on the top 1–3.

## Sandbox and Safety

The agent runs with `workspace-write` sandbox + network access enabled (needed for `gh`). However:

- Do NOT write or modify files on disk — the output is the final JSON only.
- Do NOT execute build commands, package installs, or anything that mutates state.
- All shell commands must be read-only in intent (reads, queries, log inspections).

## Output Format

The sole final message is a single JSON object that validates against the schema referenced in the task prompt. No preamble, no plan, no status updates, no markdown code fence, no emojis.
