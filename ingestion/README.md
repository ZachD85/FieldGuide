# AtriGuide ingestion pipeline

This folder contains the safe proof-of-concept pipeline that converts curated
Google Drive PDFs into compact Firestore evidence records for FieldGuide.

## Safety defaults

- Every run is a dry run unless both `--apply` and
  `ATRIGUIDE_ENABLE_PRODUCTION_WRITES=YES` are supplied.
- A private shadow run instead requires `--apply --shadow` and the separate
  `ATRIGUIDE_ENABLE_SHADOW_WRITES=YES` acknowledgement. It writes only to the
  isolated test collection and never moves Drive files.
- Apply mode also requires AI extraction so incomplete skeleton records cannot
  be published.
- The pipeline writes a local preview after every document, preserving partial
  progress and failures for review.
- Existing Admin Portal category overrides remain authoritative during
  re-ingestion.
- Existing library records can be enriched with page-linked citations in place;
  no database purge or replacement is required.
- Clicking **Process Pending PDFs** performs duplicate detection, AI extraction,
  and Admin review-queue creation in one run. It never publishes a new card.
- Obvious duplicates are automatically moved to Google Drive trash (recoverable),
  while uncertain matches remain in Pending for an Admin decision.
- Admins can edit the suggested title, citation, summary, bullets, tags, search
  terms, and website category before approval.
- Approving a normal new document publishes its card and then moves its PDF to
  Archive. Publishing is idempotent, so a failed Drive move is safe to retry.
- Choosing **Treat as New** for a possible duplicate performs the full AI scrub
  and returns the resulting card to Admin review; it does not auto-publish.
- Different files representing the same study are checked by DOI, PMID,
  normalized study title, and substantive passage fingerprints before AI is
  called. Definite matches are skipped; uncertain matches are held for Admin
  review with no write or Drive move.
- AI input is capped at 48,000 selected characters, output at 2,048 tokens,
  and the raw response at 256 KiB.
- Credentials and generated preview files must remain local and must never be
  committed.

Production publishing remains gated by an explicit authenticated Admin approval.

## Controlled shadow test

```powershell
$env:ATRIGUIDE_ENABLE_SHADOW_WRITES="YES"
python atriguide_ingestion.py --scan-drive --limit 3 --use-ai --apply --shadow --output shadow_preview.json
```

This test cannot publish to the public library or archive the source PDFs.

## Document support

- Research paper or meta-analysis
- Guideline or consensus document
- Instructions for use (English content only)
- Article summary
- Brochure or other resource

The existing FieldGuide categories are preserved exactly. The schema is
documented in `FIRESTORE_EVIDENCE_SCHEMA.md`.

## Local verification

From this folder:

```powershell
python -m pip install -r requirements.txt
python -m unittest -v test_atriguide_ingestion.py
```

To create a preview from already extracted text:

```powershell
python atriguide_ingestion.py input.json --output ingestion_preview.json
```

This command is dry-run only and performs no Firestore writes or Drive moves.

## Existing-library citation backfill

Preview a small batch first:

```powershell
python atriguide_ingestion.py --backfill-citations --use-ai --limit 3 --output citation_backfill_preview.json
```

The preview reads the current records and their Drive PDFs but performs no
Firestore writes. An approved production update additionally requires `--apply`
and `ATRIGUIDE_ENABLE_PRODUCTION_WRITES=YES`. It updates only `schemaVersion`,
`evidence`, and citation-processing metadata. It never deletes records, moves
Drive files, or changes Admin Portal categories.

## Cloud configuration

Supply configuration through local environment variables or command options:

- `ATRIGUIDE_CREDENTIALS`
- `ATRIGUIDE_APP_ID`
- `ATRIGUIDE_PENDING_FOLDER_ID`
- `ATRIGUIDE_ARCHIVE_FOLDER_ID`
- `GEMINI_API_KEY`
- `ATRIGUIDE_INGESTION_MODEL` (optional)
- `ATRIGUIDE_GCP_PROJECT` and `ATRIGUIDE_VERTEX_LOCATION` (optional; Vertex AI defaults to the credential project and `us-central1`)
- `ATRIGUIDE_ENABLE_SHADOW_WRITES` (required only for isolated shadow writes)

Do not add credential JSON files, API keys, preview output, or service-account
material to Git.

When `GEMINI_API_KEY` is absent, the pipeline uses Vertex AI through the
service account in `ATRIGUIDE_CREDENTIALS`. This is the preferred production
path because it does not require a locally stored model API key.
