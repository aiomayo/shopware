---
status: pending
priority: p1
issue_id: "005"
tags: [code-review, correctness, ai-triage, pr-16860]
dependencies: []
---

# P1: `parseJsonFromText` fails on chatty opencode output with trailing prose

## Problem
The "first `{` to last `}`" extractor assumes JSON-then-nothing. With opencode
(the default engine), the agent's final assistant message is *not* envelope-
wrapped — it's the raw text of the assistant turn. Models routinely emit prose
*after* the JSON ("Here is the triage JSON: {…}. Note that I…"). The reverse-
greedy scan picks up the closing `}` of the trailing prose sentence:

```
input:  'prose {"a":1} more prose with } char'
parse:  JSON.parse('{"a":1} more prose with }')  →  SyntaxError
```

Verified failure. codex (`--output-last-message`) and claude (`result` envelope)
route through structured channels; only opencode is exposed.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/skill/output.ts:89-103`
- Test gap: `skill/output.spec.ts:25-29` covers braces inside strings, NOT braces
  in trailing prose.

## Proposed fix
Forward-scan with a string-aware balanced-brace walker that tracks open
quotes and escapes; stop at the matching `}` of the first balanced object.
Approximately:
```ts
function extractFirstJsonObject(text: string): string {
  const first = text.indexOf("{");
  if (first === -1) throw new Error("no JSON object found");
  let depth = 0, inStr = false, esc = false;
  for (let i = first; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(first, i + 1);
    }
  }
  throw new Error("unterminated JSON object");
}
```

Also: reinforce the SKILL.md prompt with "emit ONLY the JSON object — no prose
before or after" to belt-and-braces this.

## Acceptance criteria
- [ ] New test: `parseJsonFromText('{"a":1} trailing prose with }', "test")`
      succeeds and returns `{a: 1}`.
- [ ] New test: prose before AND after the JSON still succeeds.
- [ ] Existing tests continue to pass.

## Resources
- TypeScript review finding M2.
