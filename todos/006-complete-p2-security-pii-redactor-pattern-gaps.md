---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, security, pii, ai-triage, pr-16860]
dependencies: []
---

# P2: PII redactor misses Shopware-relevant categories

## Problem
`pii-patterns.ts` covers tokens / API keys / IBAN / email / PEM blocks / user
paths. For Shopware bug reports it is missing:

- **Phone numbers** (E.164 / German / international)
- **Credit card numbers** (Luhn-validated, debug logs of failed payments
  routinely include unmasked PANs from customer screenshots)
- **Postal addresses + customer names**
- **Internal Shopware URLs** — `*.cloud.shopware.com`, `*.orb.local`,
  customer-specific shop hostnames (`https://customer-xyz.shop.example.com/admin`)
- **DAL UUID/ULID IDs** in URL paths (`/admin/orders/01HABC…`) — needs context
  anchoring to avoid false positives

GDPR processing concern: the redactor's documentation lists these as "redacted",
which is currently inaccurate. The post-run redactor catches the same gap.

## Evidence
- `/Users/T.Altholtmann/code/sw1/.github/bin/js/ai-triage/pii-patterns.ts:28-50`
- `pii-patterns.spec.ts` tests positive matches only — no fuzz / negative-space
  coverage.

## Proposed fix
Add patterns:
```ts
phone:              /\+?\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
credit_card:        /\b(?:\d[ -]?){13,19}\b/g,  // then Luhn-validate via replacer
shopware_url:       /\bhttps?:\/\/[a-z0-9-]+\.(?:cloud\.shopware\.com|shop\.example\.com|orb\.local)\b\S*/gi,
dal_id_in_url:      /\b\/(?:admin|api)\/[a-z-]+\/[0-9a-f]{32}\b/gi,
```
For `credit_card`, post-process matches with Luhn; reject false positives like
order numbers.

Add a fuzz test: random Faker-generated PII embedded in lorem; assert at least
N% redaction rate per category.

## Acceptance criteria
- [ ] New patterns + Luhn checker for CC.
- [ ] `pii-patterns.spec.ts` covers each new category with positive + negative.
- [ ] One fuzz test generates 100 random samples and asserts redaction.

## Resources
- Security review finding M1.
