"""Safe, cost-conscious AtriGuide ingestion v2.

Dry-run is the default. Production mutation requires BOTH --apply and the exact
environment acknowledgement ATRIGUIDE_ENABLE_PRODUCTION_WRITES=YES.
"""
from __future__ import annotations

import argparse, hashlib, io, json, os, re, time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PIPELINE_VERSION = "2.0"
MAX_AI_INPUT_CHARACTERS = 48000
MAX_AI_OUTPUT_TOKENS = 2048
MAX_AI_RESPONSE_BYTES = 262144
CATEGORIES = {
    "MAZE": {"Rhythm Outcomes", "Survival Benefits", "Other"},
    "LAA": {"Outcomes and Safety", "Stroke Reduction", "Prophylactic Data"},
    "Device Resources": {"IFUs", "Product Brochures", "Other Media"},
    "MISC": {"Other Research", "Helpful Documents"},
}

@dataclass(frozen=True)
class Placement:
    main: str; sub: str; confidence: float; reason: str

def stable_id(drive_file_id: str) -> str:
    return hashlib.sha256(drive_file_id.encode()).hexdigest()[:32]

def detect_document_type(name: str, text: str) -> tuple[str, float]:
    normalized_name = re.sub(r"[_-]+", " ", name.lower())
    sample = f"{normalized_name}\n{text[:18000]}".lower()
    if any(term in normalized_name for term in ("guideline", "consensus")):
        return "guideline_consensus", .99
    if re.search(r"(?:^|\s)ifu(?:\s|\.|$)", normalized_name):
        return "ifu", .99
    rules = [
        ("ifu", ("instructions for use", "contraindications", "ifu-"), .98),
        ("guideline_consensus", ("clinical practice guideline", "consensus statement", "class of recommendation"), .95),
        ("meta_analysis", ("meta-analysis", "systematic review"), .96),
        ("article_summary", ("article summary", "clinical summary", "talking points"), .92),
        ("brochure_other", ("brochure", "product guide", "product overview"), .90),
    ]
    for kind, terms, confidence in rules:
        if any(term in sample for term in terms): return kind, confidence
    return "research_paper", .72

def classify(name: str, text: str, doc_type: str, folder_hint: str = "") -> Placement:
    normalized_name = re.sub(r"[_-]+", " ", name.lower())
    normalized_folder = re.sub(r"[_-]+", " ", folder_hint.lower())
    s = f"{normalized_name} {normalized_folder} {text[:12000]}".lower()
    if doc_type == "ifu": return Placement("Device Resources", "IFUs", .99, "document detected as IFU")
    if doc_type == "brochure_other": return Placement("Device Resources", "Product Brochures", .91, "brochure/product-guide signal")
    if doc_type == "guideline_consensus":
        return Placement("MISC", "Helpful Documents", .94, "broad guideline/consensus resource")
    # Strong title/folder signals describe the paper's primary topic better than
    # incidental LAA/stroke mentions in an ablation article's body or references.
    primary = f"{normalized_name} {normalized_folder}"
    if any(x in primary for x in ("surgical ablation", "ablation pattern", "cox maze", "maze procedure")):
        if any(x in primary for x in ("survival", "mortality", "death")) or (doc_type == "research_paper" and any(x in s for x in ("survival", "mortality", "death"))):
            return Placement("MAZE", "Survival Benefits", .93, "primary surgical-ablation topic plus survival outcome")
        if any(x in primary for x in ("ablation pattern", "rhythm", "freedom from af", "cox maze")):
            return Placement("MAZE", "Rhythm Outcomes", .91, "primary surgical-ablation/lesion-pattern topic")
        return Placement("MAZE", "Other", .84, "broad surgical-ablation resource")
    if any(x in s for x in ("left atrial appendage", "laaos", " laa ")):
        if any(x in s for x in ("prophylactic", "without atrial fibrillation", "no history of af")):
            return Placement("LAA", "Prophylactic Data", .90, "LAA plus prophylactic population signal")
        if any(x in s for x in ("stroke", "systemic embol")):
            return Placement("LAA", "Stroke Reduction", .94, "LAA plus stroke/embolism outcome")
        return Placement("LAA", "Outcomes and Safety", .82, "LAA topic signal")
    if any(x in s for x in ("cox-maze", "surgical ablation", "maze procedure")):
        if any(x in s for x in ("survival", "mortality", "death")):
            return Placement("MAZE", "Survival Benefits", .93, "surgical ablation plus survival outcome")
        if any(x in s for x in ("sinus rhythm", "freedom from af", "rhythm outcome")):
            return Placement("MAZE", "Rhythm Outcomes", .91, "surgical ablation plus rhythm outcome")
        return Placement("MAZE", "Other", .78, "MAZE/surgical-ablation topic")
    sub = "Helpful Documents" if doc_type in {"guideline_consensus", "article_summary"} else "Other Research"
    return Placement("MISC", sub, .58, "no reliable specialist category signal")

def select_text(text: str, doc_type: str, max_chars: int = MAX_AI_INPUT_CHARACTERS) -> str:
    """Bound model input; prefer useful sections and avoid repeated IFU translations."""
    text = re.sub(r"\n{3,}", "\n\n", text)
    if doc_type == "ifu":
        # English is normally first; stop at the next translated IFU heading.
        languages = "bg|cs|da|de|el|es|et|fi|fr|hr|hu|it|lt|lv|nl|no|pl|pt|ro|sk|sl|sv|tr"
        english_start = re.search(r"instructions for use\s+en\b", text, re.I)
        search_from = english_start.end() if english_start else 0
        stop_match = re.search(rf"\n[^\n]{{0,100}}\s(?:{languages})\s*\n", text[search_from:], re.I)
        text = text[:search_from + stop_match.start()] if stop_match else text
    if doc_type == "guideline_consensus":
        # Preserve front matter for identity, then retrieve topic windows rather
        # than spending the budget on author lists and the table of contents.
        guideline_budget = min(max_chars, 30000)
        excerpts, lowered = [text[:2500]], text.lower()
        topics = ("surgical ablation", "surgical occlusion", "cox-maze",
                  "left atrial appendage occlusion", "concomitant surgery")
        used = []
        for topic in topics:
            position = 0
            while len("\n".join(excerpts)) < guideline_budget:
                hit = lowered.find(topic, position)
                if hit < 0: break
                position = hit + len(topic)
                start, end = max(0, hit - 1200), min(len(text), hit + 5000)
                if any(abs(start - prior) < 2500 for prior in used): continue
                used.append(start); excerpts.append(text[start:end])
                if len(used) >= 8: break
        return "\n\n[SELECTED GUIDELINE EXCERPT]\n".join(excerpts)[:guideline_budget]
    headings = r"abstract|methods?|results?|discussion|limitations?|recommendations?|indications?|contraindications?|warnings?|precautions?|troubleshooting"
    chunks = re.split(rf"(?im)(?=^\s*(?:{headings})\s*$)", text)
    chosen = text if len(chunks) == 1 else "\n".join(chunks[:10])
    return chosen[:max_chars]

def build_skeleton(file_id: str, name: str, url: str, text: str, folder_hint: str = "") -> dict[str, Any]:
    doc_type, type_conf = detect_document_type(name, text)
    placement = classify(name, text, doc_type, folder_hint)
    selected = select_text(text, doc_type)
    needs_review = placement.confidence < .70 or type_conf < .70
    return {
        "id": stable_id(file_id), "schemaVersion": 2,
        "source": {"driveFileId": file_id, "driveUrl": url, "fileName": name,
                   "contentHash": hashlib.sha256(text.encode()).hexdigest()},
        "title": Path(name).stem, "citation": "", "year": None,
        "documentType": doc_type,
        "authority": {"ifu":"regulatory_labeling", "guideline_consensus":"professional_guidance", "article_summary":"secondary_summary", "brochure_other":"manufacturer_resource"}.get(doc_type, "primary_research"),
        "website": {"mainCategory": placement.main, "subCategory": placement.sub,
            "suggestedMainCategory": placement.main, "suggestedSubCategory": placement.sub,
            "classificationConfidence": placement.confidence, "classificationReason": placement.reason,
            "manualOverride": False},
        "summary": "", "cardBullets": [], "clinicalTags": [], "searchTerms": [], "evidence": [], "details": {},
        "review": {"status": "needs_review" if needs_review else "ready", "reasons": ["low classification confidence"] if needs_review else []},
        "ingestion": {"pipelineVersion": PIPELINE_VERSION, "processedAt": datetime.now(timezone.utc).isoformat(),
            "model": None, "inputCharacters": len(selected)},
        "_selectedText": selected,
    }

def merge_manual_override(candidate: dict[str, Any], existing: dict[str, Any] | None) -> dict[str, Any]:
    existing_website = (existing or {}).get("website", {})
    is_manual = existing_website.get("manualOverride") is True or (existing or {}).get("manualOverride") is True
    if existing and is_manual:
        effective_main = existing_website.get("mainCategory") or existing.get("mainCategory")
        effective_sub = existing_website.get("subCategory") or existing.get("subCategory")
        if effective_main in CATEGORIES and effective_sub in CATEGORIES[effective_main]:
            candidate["website"]["mainCategory"] = effective_main
            candidate["website"]["subCategory"] = effective_sub
        candidate["website"]["manualOverride"] = True
    return candidate

def add_fieldguide_compatibility(record: dict[str, Any]) -> dict[str, Any]:
    """Mirror v2 fields expected by the current FieldGuide UI during migration."""
    website = record["website"]
    record["author"] = record.get("citation", "")
    record["mainCategory"] = website["mainCategory"]
    record["subCategory"] = website["subCategory"]
    record["manualOverride"] = website.get("manualOverride", False)
    record["url"] = record.get("source", {}).get("driveUrl", "")
    record["linkType"] = "pdf"
    record["headerGroup"] = ""
    searchable = [record.get("title", ""), record.get("citation", ""), record.get("summary", "")]
    searchable.extend(record.get("clinicalTags", [])); searchable.extend(record.get("searchTerms", []))
    record["searchProfile"] = " ".join(str(value) for value in searchable if value).strip()
    return record

def writes_allowed(apply: bool) -> bool:
    return apply and os.getenv("ATRIGUIDE_ENABLE_PRODUCTION_WRITES") == "YES"

def load_drive_client(credentials_file: str):
    """Create only the Drive client needed for a read-only preview."""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise RuntimeError("Install packages from requirements-ingestion.txt") from exc
    drive_creds = service_account.Credentials.from_service_account_file(
        credentials_file, scopes=["https://www.googleapis.com/auth/drive"]
    )
    return build("drive", "v3", credentials=drive_creds)

def load_firestore_client(credentials_file: str):
    """Firestore is loaded only for an explicitly approved apply run."""
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError as exc:
        raise RuntimeError("Install packages from requirements-ingestion.txt") from exc
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(credentials_file))
    return firestore.client(), firestore

def list_pdfs(drive: Any, folder_id: str, folder_path: str = "") -> list[dict[str, Any]]:
    """Recursively list PDFs while retaining folder names as classification hints."""
    found, page_token = [], None
    while True:
        response = drive.files().list(
            q=f"'{folder_id}' in parents and trashed=false", spaces="drive",
            fields="nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)",
            pageToken=page_token,
        ).execute()
        for item in response.get("files", []):
            child_path = f"{folder_path}/{item['name']}".strip("/")
            if item["mimeType"] == "application/vnd.google-apps.folder":
                found.extend(list_pdfs(drive, item["id"], child_path))
            elif item["mimeType"] == "application/pdf":
                item["folderHint"] = folder_path
                found.append(item)
        page_token = response.get("nextPageToken")
        if not page_token: return found

def download_pdf(drive: Any, file_id: str, retries: int = 3) -> bytes:
    from googleapiclient.http import MediaIoBaseDownload
    for attempt in range(retries + 1):
        target = io.BytesIO()
        downloader = MediaIoBaseDownload(target, drive.files().get_media(fileId=file_id))
        try:
            done = False
            while not done: _, done = downloader.next_chunk()
            return target.getvalue()
        except Exception:
            if attempt == retries: raise
            time.sleep(2 ** attempt)
    raise RuntimeError("download retry loop exited unexpectedly")

def extract_pdf_text(pdf_bytes: bytes, max_pages: int = 160) -> str:
    """Extract locally. The later selector, not a four-page cutoff, controls AI cost."""
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf_bytes))
    pages = []
    for number, page in enumerate(reader.pages[:max_pages], start=1):
        value = page.extract_text() or ""
        if value.strip(): pages.append(f"\n[PAGE {number}]\n{value}")
    text = "".join(pages)
    if len(text.strip()) < 50: raise ValueError("PDF has too little extractable text; OCR/review required")
    return text

def move_to_archive(drive: Any, file_id: str, parents: list[str], archive_folder_id: str) -> None:
    if not parents: raise ValueError("Refusing move without verified current parent")
    drive.files().update(fileId=file_id, addParents=archive_folder_id,
                         removeParents=",".join(parents), fields="id,parents").execute()

def firestore_path(db: Any, app_id: str):
    return db.collection("artifacts").document(app_id).collection("public").document("data").collection("clinicalResources")

def publish_record(collection: Any, record: dict[str, Any], firestore_module: Any) -> None:
    add_fieldguide_compatibility(record)
    clean = {k: v for k, v in record.items() if not k.startswith("_") and k != "id"}
    clean["ingestion"]["publishedAt"] = firestore_module.SERVER_TIMESTAMP
    # Deterministic ID makes reruns update rather than add duplicate records.
    collection.document(record["id"]).set(clean, merge=True)

def find_existing_duplicate(collection: Any, content_hash: str, candidate_id: str) -> str | None:
    """Return another record ID with identical PDF bytes, preserving reruns."""
    matches = collection.where("source.contentHash", "==", content_hash).limit(2).stream()
    for snapshot in matches:
        if snapshot.id != candidate_id:
            return snapshot.id
    return None

def duplicate_result(item: dict[str, Any], status: str, content_hash: str,
                     duplicate_of: str) -> dict[str, Any]:
    """Create an explicit, reviewable duplicate outcome with no publish action."""
    return {
        "file": item["name"],
        "fileId": item["id"],
        "status": status,
        "duplicateOf": duplicate_of,
        "contentHash": content_hash,
        "action": "skipped_no_write_no_move",
    }

def validate_record(record: dict[str, Any]) -> None:
    website = record["website"]
    if website["mainCategory"] not in CATEGORIES or website["subCategory"] not in CATEGORIES[website["mainCategory"]]:
        raise ValueError("Invalid website placement")
    if record["documentType"] not in {"research_paper","meta_analysis","guideline_consensus","ifu","article_summary","brochure_other"}:
        raise ValueError("Invalid document type")

def enrich_with_ai(record: dict[str, Any], selected_text: str, model_name: str) -> dict[str, Any]:
    """One bounded structured extraction call; never reads a key from source code."""
    if len(selected_text) > MAX_AI_INPUT_CHARACTERS:
        raise ValueError("AI input exceeds the hard character budget")
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key: raise RuntimeError("GEMINI_API_KEY is not set")
    from urllib.parse import quote
    from urllib.request import Request, urlopen
    shape = {
        "title":"", "citation":"", "year":None, "summary":"",
        "cardBullets":["3-5 concise evidence bullets"], "clinicalTags":[], "searchTerms":[],
        "evidence":[{"claim":"numerical or authoritative claim", "locator":"[PAGE n]", "kind":"result|safety|recommendation|labeling"}],
        "details":{"typeSpecificFields":"Use only fields defined for this documentType"}
    }
    prompt = (
        "Extract only facts explicitly supported by the supplied text for an AtriGuide evidence card. "
        "Do not infer missing numbers. Preserve page markers in evidence locators. Return raw JSON only. "
        f"Document type: {record['documentType']}. Required compact shape: {json.dumps(shape)}\n\n{selected_text}"
    )
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{quote(model_name)}:generateContent?key={quote(api_key)}"
    request_body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.1,
            "maxOutputTokens": MAX_AI_OUTPUT_TOKENS,
        },
    }).encode("utf-8")
    with urlopen(Request(endpoint, data=request_body, headers={"Content-Type": "application/json"}), timeout=120) as response:
        response_bytes = response.read(MAX_AI_RESPONSE_BYTES + 1)
    if len(response_bytes) > MAX_AI_RESPONSE_BYTES:
        raise ValueError("AI response exceeds the hard byte budget")
    raw_response = json.loads(response_bytes.decode("utf-8"))
    response_text = raw_response["candidates"][0]["content"]["parts"][0]["text"]
    parsed = json.loads(response_text.replace("```json", "").replace("```", "").strip())
    for key in ("title","citation","year","summary","cardBullets","clinicalTags","searchTerms","evidence","details"):
        if key in parsed: record[key] = parsed[key]
    record["cardBullets"] = record.get("cardBullets", [])[:5]
    record["clinicalTags"] = record.get("clinicalTags", [])[:12]
    record["searchTerms"] = record.get("searchTerms", [])[:12]
    record["evidence"] = record.get("evidence", [])[:8]
    record["ingestion"]["model"] = model_name
    usage = raw_response.get("usageMetadata", {})
    if usage:
        record["ingestion"]["inputTokens"] = usage.get("promptTokenCount")
        record["ingestion"]["outputTokens"] = usage.get("candidatesTokenCount")
    return record

def validate_publishable(record: dict[str, Any]) -> None:
    validate_record(record)
    if not record.get("summary") or not record.get("cardBullets") or not record.get("evidence"):
        raise ValueError("Refusing production publish: AI evidence extraction is incomplete")

def scan_drive(args: argparse.Namespace) -> int:
    drive = load_drive_client(args.credentials)
    db = firestore_module = collection = None
    if writes_allowed(args.apply):
        db, firestore_module = load_firestore_client(args.credentials)
        collection = firestore_path(db, args.app_id)
    files = list_pdfs(drive, args.pending_folder)
    previews, seen_hashes = [], {}
    for item in files[:args.limit] if args.limit else files:
        try:
            raw = download_pdf(drive, item["id"])
            content_hash = hashlib.sha256(raw).hexdigest()
            if content_hash in seen_hashes:
                previews.append(duplicate_result(
                    item, "duplicate_in_batch", content_hash, seen_hashes[content_hash]
                ))
                continue
            seen_hashes[content_hash] = item["id"]
            candidate_id = stable_id(item["id"])
            if collection:
                duplicate_id = find_existing_duplicate(collection, content_hash, candidate_id)
                if duplicate_id:
                    previews.append(duplicate_result(
                        item, "duplicate_existing", content_hash, duplicate_id
                    ))
                    continue
            text = extract_pdf_text(raw)
            record = build_skeleton(item["id"], item["name"], f"https://drive.google.com/file/d/{item['id']}/view", text, item.get("folderHint", ""))
            record["source"]["contentHash"] = content_hash
            validate_record(record)
            selected = record.pop("_selectedText")
            if args.use_ai:
                enrich_with_ai(record, selected, args.model)
            previews.append({"file": item["name"], "status": "preview", "record": record,
                             "modelInputPreview": selected, "estimatedInputCharacters": len(selected)})
            if writes_allowed(args.apply):
                validate_publishable(record)
                existing_snap = collection.document(record["id"]).get()
                existing = existing_snap.to_dict() if existing_snap.exists else None
                merge_manual_override(record, existing)
                publish_record(collection, record, firestore_module)
                move_to_archive(drive, item["id"], item.get("parents") or [], args.archive_folder)
        except Exception as exc:
            previews.append({"file": item.get("name"), "status": "needs_review", "error": str(exc)})
        # Preserve partial work and error details after every document.
        Path(args.output).write_text(json.dumps(previews, indent=2), encoding="utf-8")
    Path(args.output).write_text(json.dumps(previews, indent=2), encoding="utf-8")
    print(f"{'APPLY' if writes_allowed(args.apply) else 'DRY RUN'}: {len(previews)} results written to {args.output}")
    return 0

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("input_json", nargs="?", help="local JSON containing fileId, name, url and extractedText")
    p.add_argument("--output", default="ingestion_preview.json")
    p.add_argument("--apply", action="store_true", help="request production writes (still requires environment acknowledgement)")
    p.add_argument("--scan-drive", action="store_true", help="scan the configured Pending folder")
    p.add_argument("--credentials", default=os.getenv("ATRIGUIDE_CREDENTIALS", "credentials.json"))
    p.add_argument("--app-id", default=os.getenv("ATRIGUIDE_APP_ID", "atricure-clinical-hub"))
    p.add_argument("--pending-folder", default=os.getenv("ATRIGUIDE_PENDING_FOLDER_ID", "1BOC7ooYHACcEmsVcfJJ3pZOFV-rQueBk"))
    p.add_argument("--archive-folder", default=os.getenv("ATRIGUIDE_ARCHIVE_FOLDER_ID", "1wl-qyPmjlr9eBBUFhhvD8diVk9mJp8ZH"))
    p.add_argument("--limit", type=int, default=0, help="maximum PDFs for a controlled test; 0 means all")
    p.add_argument("--use-ai", action="store_true", help="perform one bounded extraction call per unique PDF")
    p.add_argument("--model", default=os.getenv("ATRIGUIDE_INGESTION_MODEL", "gemini-2.5-flash"))
    args = p.parse_args()
    if args.apply and not writes_allowed(args.apply):
        raise SystemExit("BLOCKED: --apply also requires ATRIGUIDE_ENABLE_PRODUCTION_WRITES=YES")
    if args.apply and not args.use_ai:
        raise SystemExit("BLOCKED: --apply requires --use-ai so incomplete records cannot be published")
    if args.scan_drive: return scan_drive(args)
    if not args.input_json: p.error("provide input_json or --scan-drive")
    source = json.loads(Path(args.input_json).read_text(encoding="utf-8"))
    record = build_skeleton(source["fileId"], source["name"], source.get("url", ""), source["extractedText"], source.get("folderHint", ""))
    selected = record.pop("_selectedText")
    Path(args.output).write_text(json.dumps({"record": record, "modelInputPreview": selected}, indent=2), encoding="utf-8")
    if writes_allowed(args.apply):
        raise SystemExit("Use --scan-drive for an approved cloud apply")
    print(f"DRY RUN: preview written to {args.output}; no Firestore or Drive changes")
    return 0

if __name__ == "__main__": raise SystemExit(main())


