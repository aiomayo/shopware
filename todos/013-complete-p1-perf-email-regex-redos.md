---
status: pending
priority: p1
issue_id: "013"
tags: [code-review, security, performance, redos, ai-triage, pr-16860]
dependencies: []
---

# P1: ReDoS in email regex — attacker can hang the triage workflow

## Problem
The email pattern in `pii-patterns.ts` exhibits **catastrophic backtracking**.
Both `[A-Za-z0-9._%+-]+` and `[A-Za-z0-9.-]+` overlap with no `@` anchor —
on input like `"aaaa…"` the engine tries every start position × every length
before failing.

Profiled curve (cold Node, MacBook) — textbook O(n²):

| Input size | Time |
|---:|---:|
| 10 KB | 44 ms |
| 20 KB | 174 ms |
| 40 KB | 719 ms |
| 65 KB | **1889 ms** |
| 100 KB | **4657 ms** |

**Attack vector:** GitHub issue body cap is 65,536 chars. A 65 KB body of
`a`-class characters burns ~1.9 s on every triage run. Even worse: the same
redactor runs *post-run* via `redact-stream.ts` on the agent transcript (10 MB
cap). A 1 MB run of `a`-class chars in agent stdout → **~460 s blocking**,
exceeding the 1-min margin between wrapper timeout (7 min) and job timeout
(8 min). Result: job SIGKILLed by the runner, **artifact upload skipped**,
no forensic trail.

Existing test at `pii-patterns.spec.ts:49-58` covers ReDoS only for the
private-key block — email is unprotected.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/pii-patterns.ts:45`
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/redact-stream.ts:15`
  (10 MB cap protects memory, not CPU)

## Proposed fix
Bound the quantifiers to RFC-5321 lengths so the worst-case factor `n`
collapses to a constant:

```ts
{
  type: "email",
  regex: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g,
  // ...
}
```

Add a regression test mirroring the existing private-key one:

```ts
test("redactPii: email regex bounded (no ReDoS on long alphanumeric without @)", () => {
  const longNoAt = "a".repeat(65_000);
  const start = Date.now();
  redactPii(longNoAt);
  assert.ok(Date.now() - start < 200, "email regex must be ~O(n)");
});
```

Also: while in there, sweep all patterns in `pii-patterns.ts` for similar
issues (especially anything with two overlapping `+` quantifiers and no
anchor) and add a ReDoS test loop:

```ts
test("all PII regexes ~O(n) on 65 KB adversarial input", () => {
  for (const { type } of PII_PATTERNS) {
    const start = Date.now();
    redactPii("a".repeat(65_000));
    assert.ok(Date.now() - start < 100, `pattern ${type} > 100ms on 65KB`);
  }
});
```

## Acceptance criteria
- [ ] Email regex bounded; 100 KB input redacts in < 50 ms.
- [ ] New `pii-patterns.spec.ts` regression test for email ReDoS.
- [ ] Sweep test covering all patterns at 65 KB input < 100 ms each.

## Resources
- Performance review finding #1.
- Related: todo #003 (body size cap) — defence in depth.
