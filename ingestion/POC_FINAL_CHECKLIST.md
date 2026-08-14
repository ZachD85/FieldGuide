# AtriGuide POC final checklist

- [x] Review previews across the supported document types and approve the schema.
- [x] Port the newer ingestion script's Drive authentication, retry, download, and safety behavior.
- [x] Run a six-PDF test against the isolated shadow Firestore collection.
- [x] Confirm Admin Portal edits set `website.manualOverride=true` and survive re-ingestion.
- [x] Confirm the pipeline publishes successfully before permitting a Drive archive move.
- [ ] Route duplicates to an explicit duplicate state; leave failures retryable/Needs Review.
- [x] Review generated Evidence Cards against the source PDFs used in the controlled test.
- [x] Record model, bounded input size, token usage, and processing metadata per document.
- [ ] Add a hard evidence/context budget for question answering.
- [ ] API/security cleanup: rotate exposed keys, remove hard-coded secrets, use environment/secret management, restrict Firebase/Drive permissions, and review Firestore rules.
- [ ] Obtain explicit user approval before enabling production writes or archive moves.
