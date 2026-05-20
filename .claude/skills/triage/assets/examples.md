# Triage Output — Worked Examples

These are illustrative final outputs. Your actual reasoning, paths, SHAs, and issue numbers must come from your real investigation — **never invented**.

## Example A — clear bug with affected code identified

```json
{
  "disposition": "valid-bug",
  "severity": "medium",
  "suggested_labels": ["domain/crm-after-sales"],
  "confidence": 0.92,
  "reasoning": "Export downloads lose their filename extension. rg shows the affected service at src/Core/Content/ImportExport/Service/DownloadService.php. git log surfaced commit 4cfe2b182ba 'fix: export temporary url file download missing filename (#16632)' which directly addresses this report. PR #16632 says 'closes #16599' — the bug is already fixed on trunk. Workaround exists (rename file), so severity is medium not high.",
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

## Example B — fundamentally unclear, `needs-info`

```json
{
  "disposition": "needs-info",
  "severity": "low",
  "suggested_labels": ["domain/framework"],
  "confidence": 0.45,
  "reasoning": "The body says only 'shop is broken pls fix'. No version, no affected area, no actual-vs-expected, no repro. I cannot describe the defect in my own words from the input. Domain label is placeholder; severity defaults to low per the rubric for absent context. Did not run any shell tools — no signals to investigate.",
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

## Example C — duplicate identified via gh search

```json
{
  "disposition": "duplicate",
  "severity": "medium",
  "suggested_labels": ["domain/admin"],
  "confidence": 0.88,
  "reasoning": "Issue describes the same defect as #15800: 'sw-media-upload-v2 field cannot be cleared'. gh issue view 15800 shows identical actual_behaviour and reproduction. #15800 is currently open and assigned. No fix on trunk yet (no matching commit in git log).",
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

These are templates for shape and tone. The schema, taxonomy, and severity rubric are normative — these examples are illustrative.
