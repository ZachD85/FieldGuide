# AtriGuide compact evidence schema (v3)

One Firestore document per source PDF, keyed by a stable hash of the Drive file ID.

## Common fields

```json
{
  "schemaVersion": 3,
  "source": {
    "driveFileId": "...", "driveUrl": "...", "fileName": "...", "contentHash": "...",
    "identity": {"doi": "...", "pmid": "...", "titleCandidates": ["..."], "passageFingerprints": ["..."]}
  },
  "title": "...",
  "citation": "...",
  "year": 2026,
  "documentType": "research_paper",
  "authority": "primary_research",
  "website": {
    "mainCategory": "MAZE",
    "subCategory": "Survival Benefits",
    "suggestedMainCategory": "MAZE",
    "suggestedSubCategory": "Survival Benefits",
    "classificationConfidence": 0.94,
    "classificationReason": "survival and surgical ablation terms",
    "manualOverride": false
  },
  "summary": "...",
  "cardBullets": ["..."],
  "clinicalTags": ["..."],
  "searchTerms": ["..."],
  "evidence": [{"claim": "...", "page": 4, "locator": "page 4", "kind": "result", "excerpt": "short supporting source text"}],
  "details": {},
  "review": {"status": "ready", "reasons": []},
  "ingestion": {"pipelineVersion": "2.0", "processedAt": "...", "model": "...", "inputCharacters": 0}
}
```

`mainCategory` and `subCategory` are the website's effective values. On re-ingestion, an existing record with `manualOverride: true` keeps those effective values; the script only refreshes the suggested values.

Allowed website placements are fixed:

- MAZE: Rhythm Outcomes, Survival Benefits, EnCompass Data, Other
- LAA: Outcomes and Safety, Stroke Reduction, Prophylactic Data
- Device Resources: IFUs, Product Brochures, Other Media
- MISC: Other Research, Helpful Documents

## Document types and compact `details`

- `research_paper` / `meta_analysis`: `studyDesign`, `population`, `sampleSize`, `intervention`, `comparator`, `followUp`, `endpoints`, `keyResults`, `safetyResults`, `limitations`
- `guideline_consensus`: `organization`, `recommendations[]` (`text`, `class`, `level`, `context`, `locator`)
- `ifu`: `device`, `revision`, `indications`, `contraindications`, `warnings`, `precautions`, `operatingParameters`, `use`, `troubleshooting`
- `article_summary`: `underlyingSources`, `talkingPoints`, `limitations`; authority is `secondary_summary`
- `brochure_other`: `resourceKind`, `intendedAudience`, `keyMessages`; authority is `manufacturer_resource` or `other`

Arrays are deliberately bounded in code: up to 5 card bullets, 8 evidence claims, 12 clinical tags, and 12 search terms. The full PDF remains the source of truth; Firestore stores retrieval-ready evidence, not a second copy of the document.

Page numbers come only from the page markers added during local PDF extraction. The
conversational AI selects a stored evidence claim by index; the server supplies its
validated page label. This prevents the chat response from inventing citations.

Existing v2 and legacy records remain valid. A citation backfill enriches them in
place and does not delete the collection or overwrite Admin category overrides.

## Duplicate identity

Duplicate checks run before the paid AI extraction. Exact PDF/content matches,
matching DOI or PMID values, the same normalized study title, and multiple
identical substantive passages are automatically skipped. A likely but
uncertain match is held as `possible_duplicate_needs_review`; it is never
published or moved automatically. This catches a full paper, abstract, article
summary, renamed PDF, or differently formatted copy of the same study while
keeping genuinely ambiguous pairs for Admin review.


