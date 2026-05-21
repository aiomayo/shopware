---
status: pending
priority: p3
issue_id: "014"
tags: [code-review, ci, performance, ai-triage, pr-16860]
dependencies: []
---

# P3: Add `cache: 'npm'` to ai-triage-tests.yml (save ~30 s per PR)

## Problem
`node_modules` for the ai-triage wrapper is **498 MB** (the three AI CLI
native binaries dominate). Neither workflow uses npm caching. `npm ci
--ignore-scripts` takes 30–60 s per run; for `ai-triage-tests.yml` (which
runs on every PR touching the wrapper) that's pure CI tax.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/workflows/ai-triage-tests.yml:40-49`

## Proposed fix
On `ai-triage-tests.yml` only:
```yaml
- name: Setup Node LTS
  uses: actions/setup-node@...
  with:
    node-version: 'lts/*'
    cache: 'npm'
    cache-dependency-path: .github/bin/js/ai-triage/package-lock.json
```

**Do NOT add caching to `ai-triage.yml`** (the production agent run).
`--ignore-scripts` + explicit postinstall is a supply-chain security
control; a cached `node_modules` could persist a poisoned binary across
runs. 30 s saved on a 10–600 s run is not worth the security trade-off.

## Acceptance criteria
- [ ] `cache: 'npm'` added to ai-triage-tests.yml only.
- [ ] Verified `ai-triage.yml` still uses `npm ci --ignore-scripts` without
      cache.

## Resources
- Performance review finding #8.
