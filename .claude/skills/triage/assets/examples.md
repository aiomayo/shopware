# Triage Output — Worked Examples

These are illustrative final outputs in **wrapper-fed JSON** format. Your actual reasoning, paths, SHAs, and issue numbers must come from your real investigation — **never invented**.

The interactive Markdown format is fully specified by the template in SKILL.md "Operating modes" → no separate example needed here.

## A — `valid-bug` with affected code identified

```json
{
  "disposition": "valid-bug",
  "severity": "medium",
  "suggested_labels": ["domain/crm-after-sales"],
  "confidence": 0.92,
  "reasoning": "Export downloads lose their filename extension. rg located src/Core/Content/ImportExport/Service/DownloadService.php; git log surfaced 4cfe2b182ba 'fix: ... (#16632)' which closes #16599 — fix already on trunk. Workaround (rename file) exists, hence medium not high.",
  "evidence_quotes": [
    "a file is generated that has no file extension",
    "4cfe2b182ba fix: export temporary url file download missing filename (#16632)"
  ],
  "duplicate_of": null,
  "missing_template_fields": ["expected_behaviour"],
  "affected_paths": ["src/Core/Content/ImportExport/Service/DownloadService.php"],
  "related_issues": [],
  "related_prs": [16632],
  "recent_commits_in_area": ["4cfe2b182ba fix: export temporary url file download missing filename (#16632)"],
  "change_size_estimate": "small"
}
```

## B — `needs-info` (input fundamentally unclear)

```json
{
  "disposition": "needs-info",
  "severity": "low",
  "suggested_labels": ["domain/framework", "component/core"],
  "confidence": 0.45,
  "reasoning": "Body says only 'shop is broken pls fix'. No version, area, actual/expected, or repro. Cannot describe defect. Domain + component labels are placeholders (rubric requires a component/* pair for framework); severity defaults low. No shell tools run.",
  "evidence_quotes": ["shop is broken pls fix"],
  "duplicate_of": null,
  "missing_template_fields": ["shopware_version", "affected_area", "actual_behaviour", "expected_behaviour", "reproduction_steps"],
  "affected_paths": [],
  "related_issues": [],
  "related_prs": [],
  "recent_commits_in_area": [],
  "change_size_estimate": "unknown"
}
```

## C — `duplicate` (verified via gh search)

```json
{
  "disposition": "duplicate",
  "severity": "medium",
  "suggested_labels": ["domain/framework", "component/administration"],
  "confidence": 0.88,
  "reasoning": "Same defect as #15800: 'sw-media-upload-v2 cannot be cleared'. gh issue view 15800 shows matching actual_behaviour + repro. #15800 still open, no fix on trunk.",
  "evidence_quotes": [
    "sw-media-upload-v2 ... can't be cleared anymore",
    "issue #15800: 'media upload cannot be cleared once set'"
  ],
  "duplicate_of": 15800,
  "missing_template_fields": [],
  "affected_paths": ["src/Administration/Resources/app/administration/src/component/form/sw-media-upload-v2"],
  "related_issues": [],
  "related_prs": [],
  "recent_commits_in_area": [],
  "change_size_estimate": "unknown"
}
```

## D — `not-a-bug` (third-party plugin / misfiled support)

```json
{
  "disposition": "not-a-bug",
  "severity": "low",
  "suggested_labels": ["domain/framework", "component/core"],
  "confidence": 0.82,
  "reasoning": "Reporter: 'plugin XYZ doesn't work after install'. rg confirms plugin XYZ is third-party (not in src/). Behaviour matches the plugin's documented `shopware.yaml` config requirement. Not a core defect.",
  "evidence_quotes": [
    "plugin XYZ doesn't work after install",
    "rg --files src/ -g 'XYZ*' returned no matches"
  ],
  "duplicate_of": null,
  "missing_template_fields": [],
  "affected_paths": [],
  "related_issues": [],
  "related_prs": [],
  "recent_commits_in_area": [],
  "change_size_estimate": "unknown"
}
```

## E — `feature-request` (technical capability missing, not a regression)

```json
{
  "disposition": "feature-request",
  "severity": "low",
  "suggested_labels": ["domain/inventory"],
  "confidence": 0.79,
  "reasoning": "Reporter wants product list sortable by margin. rg shows sw-product list view exposes a fixed sortable column set (name/stock/price); margin is not a stored column. New capability, not a regression.",
  "evidence_quotes": [
    "product list does not let me sort by margin",
    "sortable columns: name, stock, price"
  ],
  "duplicate_of": null,
  "missing_template_fields": ["actual_behaviour"],
  "affected_paths": [],
  "related_issues": [],
  "related_prs": [],
  "recent_commits_in_area": [],
  "change_size_estimate": "unknown"
}
```

These are templates for shape and tone. The schema, taxonomy, and severity rubric are normative; these examples are illustrative.
