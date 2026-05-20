# Disposition, Severity & Confidence Calibration

## Disposition taxonomy

Exactly one of:

- **`valid-bug`** — Defect with a clear understanding of what's broken. The actual_behaviour is unambiguous. Minor template gaps are FINE if the defect itself is clear. **Default to `valid-bug` for any plausible defect where you can describe the problem in your own words.**
- **`duplicate`** — Same defect as an already-tracked issue. Set `duplicate_of` to the issue number. Only assert if symptoms genuinely match.
- **`needs-info`** — Issue is **fundamentally unclear**: the defect cannot be understood from the input. Empty/vague actual_behaviour, off-topic, gibberish. **Do NOT use just because a template field is short or has a placeholder (`.` / `_No response_`)** — only when you genuinely cannot tell what the bug is.
- **`not-a-bug`** — Working-as-designed, config question, third-party plugin issue, support request misfiled as bug.
- **`feature-request`** — Describes a desired capability, not a defect.

**Heuristik:** Try to describe the defect in one sentence. If you can, it's `valid-bug` (or `duplicate`). If you can't, it's `needs-info`.

## Severity rubric

Severity reflects **technical impact** (how broken is the system?), **NOT business priority** (how urgent is it to fix?). Shopware uses separate `priority/*` labels for business urgency — do not map between them.

Exactly one of:

- **`critical`** — Data loss, payment/checkout breakage, security exposure. Affects all merchants or no workaround exists.
- **`high`** — Core feature broken (admin, storefront checkout, order placement). Workaround impractical.
- **`medium`** — Defect with practical workaround. Affects subset of merchants OR specific configurations.
- **`low`** — Cosmetic, edge-case, minor UX, non-default config, easy workaround.

**Default to the LOWER severity if uncertain.** Do not inflate severity just because an issue is recent or has many comments.

## Confidence calibration

Confidence is your subjective probability that `disposition + severity + primary domain + duplicate_of` match what a senior Shopware engineer would conclude after the same 5–10 minutes of investigation.

| Range | Meaning |
|---|---|
| `0.90 – 1.00` | Bet money. Verified affected file path + clear repro + no plausible alternatives. |
| `0.70 – 0.89` | Informed estimate. Some ambiguity in domain attribution OR severity. |
| `0.50 – 0.69` | Coin-flip plus signal. Multiple plausible interpretations. |
| `0.30 – 0.49` | Guess with reasoning. Could not find affected code path. |

**Anti-overconfidence rule:** If you are at `≥ 0.85` and your reasoning has no shell-tool evidence (no file paths, no commit SHAs, no related-issue refs), lower confidence by `0.15`.
