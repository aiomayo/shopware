---
status: pending
priority: p3
issue_id: "012"
tags: [code-review, quality, ai-triage, pr-16860]
dependencies: []
---

# P3: Process lifecycle + miscellaneous code-quality polish

## Problem
A grab-bag of small quality issues, none load-bearing on their own but
worth a single follow-up commit:

1. **`mkdtempSync` orphaned on SIGKILL** — `triage.ts:425, 443-445`. The
   `finally { rmSync }` block fires on normal completion / thrown errors,
   not on SIGKILL/SIGTERM (e.g. job-timeout). Add `process.on("SIGTERM",
   …)` cleanup.
2. **`child.on("close", c => c ?? -1)` loses signal info** —
   `triage.ts:169`. OOM-killed children yield `code === null` with a
   signal string; current code maps to `-1` in the error message.
   Include the signal name when code is null.
3. **`redactedTitle` redaction counts discarded** — `triage.ts:496`.
   Only body counts make it into the output JSON. Merge title+body
   counts via a `Set` union.
4. **`as Record<string, unknown>` cluster in `extractOpencodeFinalMessage`** —
   `triage.ts:266-302`. Encapsulate the four shapes in a small Zod
   union; `safeParse` each line. Removes the manual nested `as` ladder
   and the duplicate `as string` after `typeof === "string"` narrows.
5. **No `engines` field in `package.json`** — README says Node 22 LTS+
   but `npm ci` doesn't enforce. Add `"engines": { "node": ">=22.6" }`.
6. **`import.meta.url === \`file://${process.argv[1]}\`` is fragile** —
   `triage.ts:537`. Symlinked entry / Windows paths / unicode break it.
   Use `pathToFileURL(process.argv[1]).href`.
7. **`claude --json-schema <inline string>` puts ~2 KB schema in argv** —
   `triage.ts:393`. If claude-code supports `--json-schema-file <path>`,
   use that for parity with codex.
8. **`redact-stream.ts` rename or actually stream** — currently reads
   whole stdin via `readFileSync(0)`. Either rename to `redact-buffer.ts`
   or rewrite with `node:stream` async iterators + overlap buffer.
9. **OVERVIEW.md vision/roadmap content** — `OVERVIEW.md:99-118, 141-164`
   is PR-description prose that will rot post-merge. Move to PR
   description; keep only architecture + extension-model in OVERVIEW.md.

## Proposed fix
One follow-up commit (`chore(ci): ai-triage polish`) addressing all of
the above. Each is 1-5 LOC.

## Acceptance criteria
- [ ] SIGTERM handler removes `xdgDir`.
- [ ] Error message includes signal name when present.
- [ ] `redaction_counts` merges title + body.
- [ ] Zod-union refactor of `extractOpencodeFinalMessage`.
- [ ] `engines.node` in `package.json`.
- [ ] `pathToFileURL` used for entry-point check.
- [ ] OVERVIEW.md trimmed of PR-description prose.

## Resources
- TypeScript review findings S2, S5, S6, N1, N2, N3, N4, N5.
- Simplicity review finding #6 (OVERVIEW.md).
