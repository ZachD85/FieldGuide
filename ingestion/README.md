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
- Drive archival happens only after a successful Firestore publish.
- Identical PDFs are reported as explicit duplicates and are neither published
  nor moved. A rerun of the same Drive file remains an idempotent update.
- AI input is capped at 48,000 selected characters, output at 2,048 tokens,
  and the raw response at 256 KiB.
- Credentials and generated preview files must remain local and must never be
  committed.

Production apply mode is intentionally not approved for the POC yet.

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

## Cloud configuration

Supply configuration through local environment variables or command options:

- `ATRIGUIDE_CREDENTIALS`
- `ATRIGUIDE_APP_ID`
- `ATRIGUIDE_PENDING_FOLDER_ID`
- `ATRIGUIDE_ARCHIVE_FOLDER_ID`
- `GEMINI_API_KEY`
- `ATRIGUIDE_INGESTION_MODEL` (optional)
- `ATRIGUIDE_ENABLE_SHADOW_WRITES` (required only for isolated shadow writes)

Do not add credential JSON files, API keys, preview output, or service-account
material to Git.
