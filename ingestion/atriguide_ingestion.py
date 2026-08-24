"""Safe, cost-conscious AtriGuide ingestion v3.

Dry-run is the default. Production mutation requires BOTH --apply and the exact
environment acknowledgement ATRIGUIDE_ENABLE_PRODUCTION_WRITES=YES.
"""
from __future__ import annotations

import argparse, hashlib, io, json, os, re, time, unicodedata
from difflib import SequenceMatcher
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PIPELINE_VERSION = "3.0"
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

@dataclass(frozen=True)
class DuplicateMatch:
    record_id: str; confidence: float; reason: str; definite: bool

def stable_id(drive_file_id: str) -> str:
    return hashlib.sha256(drive_file_id.encode()).hexdigest()[:32]

def evidence_page(value: Any) -> int | None:
    """Return a trustworthy positive page number from model output."""
    if isinstance(value, int) and value > 0:
        return value
    match = re.search(r"(?:\[?page\s+|\[PAGE\s+)(\d+)\]?", str(value or ""), re.I)
    return int(match.group(1)) if match and int(match.group(1)) > 0 else None

def normalize_evidence(items: Any) -> list[dict[str, Any]]:
    """Keep compact claim citations and derive page labels without inventing pages."""
    normalized = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict): continue
        claim = str(item.get("claim") or "").strip()[:700]
        if not claim: continue
        page = evidence_page(item.get("page")) or evidence_page(item.get("locator"))
        locator = f"page {page}" if page else str(item.get("locator") or "").strip()[:80]
        normalized.append({
            "claim": claim,
            "page": page,
            "locator": locator,
            "kind": str(item.get("kind") or "result").strip()[:40],
            "excerpt": str(item.get("excerpt") or "").strip()[:500],
        })
    return normalized[:8]

def has_page_citations(record: dict[str, Any]) -> bool:
    evidence = normalize_evidence(record.get("evidence"))
    return bool(evidence) and all(item.get("page") for item in evidence)

def drive_file_id_from_record(record: dict[str, Any]) -> str:
    """Read v3 source identity or recover it from a legacy Google Drive URL."""
    source = record.get("source") or {}
    direct = str(source.get("driveFileId") or "").strip()
    if direct: return direct
    url = str(source.get("driveUrl") or record.get("url") or "")
    match = re.search(r"drive\.google\.com/(?:file/d/|open\?id=)([A-Za-z0-9_-]+)", url)
    if not match:
        match = re.search(r"[?&]id=([A-Za-z0-9_-]+)", url)
    return match.group(1) if match else ""

def normalize_identity_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    value = re.sub(r"\b(?:pdf|full text|abstract|article summary|printed article|publication)\b", " ", value, flags=re.I)
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()

def extract_identifiers(text: str) -> dict[str, str]:
    doi_match = re.search(r"\b10\.\d{4,9}/[-._;()/:A-Z0-9]+", text or "", re.I)
    pmid_match = re.search(r"\bPMID\s*[:#]?\s*(\d{6,9})\b", text or "", re.I)
    doi = doi_match.group(0).rstrip(".,;)").lower() if doi_match else ""
    return {"doi": doi, "pmid": pmid_match.group(1) if pmid_match else ""}

def extract_title_candidates(name: str, text: str) -> list[str]:
    candidates = [Path(name).stem]
    for raw in (text or "")[:6000].splitlines()[:80]:
        line = re.sub(r"\s+", " ", raw).strip()
        normalized = normalize_identity_text(line)
        if 35 <= len(line) <= 260 and len(normalized.split()) >= 6 and not re.search(r"[.!?]$", line):
            if not re.search(r"copyright|doi|pmid|journal|volume|page \d|instructions for use", line, re.I):
                candidates.append(line)
    unique = []
    for candidate in candidates:
        normalized = normalize_identity_text(candidate)
        if normalized and normalized not in unique: unique.append(normalized)
    return unique[:12]

def content_passage_fingerprints(text: str) -> list[str]:
    """Compact exact-content signals; catches abstracts embedded in full papers."""
    blocks = re.split(r"\n\s*\n|(?<=[.!?])\s+(?=[A-Z])", (text or "")[:30000])
    hashes, seen = [], set()
    for block in blocks:
        normalized = normalize_identity_text(block)
        words = normalized.split()
        if 18 <= len(words) <= 220:
            fingerprint = hashlib.sha256(" ".join(words).encode()).hexdigest()[:20]
            if fingerprint not in seen:
                seen.add(fingerprint); hashes.append(fingerprint)
    # Preserve document order so front-matter/abstract passages are retained.
    return hashes[:120]

def build_source_identity(name: str, text: str) -> dict[str, Any]:
    identifiers = extract_identifiers(f"{name}\n{text[:30000]}")
    return {
        **identifiers,
        "titleCandidates": extract_title_candidates(name, text),
        "passageFingerprints": content_passage_fingerprints(text),
    }

def identity_from_existing(record: dict[str, Any]) -> dict[str, Any]:
    source = record.get("source") or {}
    saved = source.get("identity") or {}
    combined = "\n".join(str(record.get(key, "")) for key in ("title", "citation", "author", "summary", "url"))
    identifiers = extract_identifiers(combined)
    title = normalize_identity_text(str(record.get("title", "")))
    return {
        "doi": saved.get("doi") or identifiers["doi"],
        "pmid": saved.get("pmid") or identifiers["pmid"],
        "titleCandidates": saved.get("titleCandidates") or ([title] if title else []),
        "passageFingerprints": saved.get("passageFingerprints") or content_passage_fingerprints(str(record.get("summary", ""))),
    }

def compare_duplicate_identity(candidate: dict[str, Any], existing: dict[str, Any]) -> tuple[float, str, bool] | None:
    for identifier, label in (("doi", "DOI"), ("pmid", "PMID")):
        if candidate.get(identifier) and candidate.get(identifier) == existing.get(identifier):
            return 1.0, f"same {label}", True
    candidate_titles = candidate.get("titleCandidates") or []
    existing_titles = existing.get("titleCandidates") or []
    best_title = max((SequenceMatcher(None, a, b).ratio() for a in candidate_titles for b in existing_titles), default=0.0)
    if any(a == b and len(a.split()) >= 6 for a in candidate_titles for b in existing_titles):
        return .99, "same normalized study title", True
    candidate_passages = set(candidate.get("passageFingerprints") or [])
    existing_passages = set(existing.get("passageFingerprints") or [])
    shared_passages = len(candidate_passages & existing_passages)
    if shared_passages >= 2:
        return .98, f"{shared_passages} identical substantive passages", True
    if best_title >= .94:
        return .96, "near-identical study title", True
    if best_title >= .82 and shared_passages >= 1:
        return .90, "similar study title plus identical content passage", False
    if best_title >= .88:
        return .86, "highly similar study title", False
    return None

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
        "id": stable_id(file_id), "schemaVersion": 3,
        "source": {"driveFileId": file_id, "driveUrl": url, "fileName": name,
                   "contentHash": hashlib.sha256(text.encode()).hexdigest(),
                   "identity": build_source_identity(name, text)},
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

def _citation_match_text(value: str) -> str:
    """Normalize common PDF extraction quirks without weakening grounding."""
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = re.sub(r"(?<=[A-Za-z])-\s*(?=[A-Za-z])", "", value)
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()

def page_texts(extracted_text: str) -> dict[int, str]:
    parts = re.split(r"\n\[PAGE\s+(\d+)\]\n", extracted_text)
    return {int(parts[index]): parts[index + 1] for index in range(1, len(parts) - 1, 2)}

def _ordered_excerpt_match(excerpt: str, page_text: str) -> bool:
    """Allow a small number of OCR-split words while preserving word order."""
    wanted = excerpt.split()
    available = page_text.split()
    if not wanted or not available: return False
    blocks = [block for block in SequenceMatcher(None, wanted, available, autojunk=False).get_matching_blocks()
              if block.size]
    matched = sum(block.size for block in blocks)
    required = max(6, int(len(wanted) * 0.88 + 0.999))
    span = blocks[-1].b + blocks[-1].size - blocks[0].b if blocks else 0
    return matched >= required and span <= len(wanted) * 2

def validate_evidence_grounding(evidence: list[dict[str, Any]], extracted_text: str) -> None:
    """Reject model citations unless their excerpt occurs on the stated PDF page."""
    pages = page_texts(extracted_text)
    for number, item in enumerate(evidence, start=1):
        page = evidence_page(item.get("page") or item.get("locator"))
        excerpt = _citation_match_text(item.get("excerpt", ""))
        page_text = _citation_match_text(pages.get(page or -1, ""))
        if not page or page not in pages:
            raise ValueError(f"Evidence claim {number} cites a missing PDF page")
        compact_match = excerpt.replace(" ", "") in page_text.replace(" ", "")
        if len(excerpt) < 20 or (excerpt not in page_text and not compact_match and
                                 not _ordered_excerpt_match(excerpt, page_text)):
            raise ValueError(f"Evidence claim {number} excerpt was not found on PDF page {page}")

def filter_grounded_evidence(evidence: list[dict[str, Any]], extracted_text: str) -> tuple[list[dict[str, Any]], int]:
    """Keep independently verified claims and count model claims that were rejected."""
    accepted = []
    for item in evidence:
        try:
            validate_evidence_grounding([item], extracted_text)
            accepted.append(item)
        except ValueError:
            pass
    return accepted, len(evidence) - len(accepted)

def move_to_archive(drive: Any, file_id: str, parents: list[str], archive_folder_id: str) -> None:
    if not parents: raise ValueError("Refusing move without verified current parent")
    drive.files().update(fileId=file_id, addParents=archive_folder_id,
                         removeParents=",".join(parents), fields="id,parents").execute()

def trash_drive_file(drive: Any, file_id: str) -> None:
    """Remove a confirmed duplicate from Pending using Drive's recoverable trash."""
    drive.files().update(fileId=file_id, body={"trashed": True}, fields="id,trashed").execute()

def firestore_path(db: Any, app_id: str, shadow: bool = False):
    collection_name = "clinicalResources_ingestionTest" if shadow else "clinicalResources"
    return db.collection("artifacts").document(app_id).collection("public").document("data").collection(collection_name)

def review_queue_path(db: Any, app_id: str):
    return db.collection("artifacts").document(app_id).collection("public").document("data").collection("ingestionReviewQueue")

def shadow_writes_allowed(apply: bool, shadow: bool) -> bool:
    """Require a separate acknowledgement so a shadow test cannot enable production."""
    return bool(apply and shadow and os.getenv("ATRIGUIDE_ENABLE_SHADOW_WRITES") == "YES")

def production_writes_allowed(apply: bool, shadow: bool) -> bool:
    return bool(apply and not shadow and writes_allowed(apply))

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

def load_existing_records(collection: Any) -> list[tuple[str, dict[str, Any]]]:
    return [(snapshot.id, snapshot.to_dict() or {}) for snapshot in collection.stream()]

def find_content_duplicate(existing_records: list[tuple[str, dict[str, Any]]],
                           candidate: dict[str, Any]) -> DuplicateMatch | None:
    candidate_id = candidate["id"]
    candidate_hash = candidate.get("source", {}).get("contentHash", "")
    candidate_identity = candidate.get("source", {}).get("identity", {})
    best = None
    for record_id, existing in existing_records:
        if record_id == candidate_id: continue
        if candidate_hash and candidate_hash == (existing.get("source") or {}).get("contentHash"):
            return DuplicateMatch(record_id, 1.0, "identical extracted content", True)
        comparison = compare_duplicate_identity(candidate_identity, identity_from_existing(existing))
        if comparison:
            confidence, reason, definite = comparison
            match = DuplicateMatch(record_id, confidence, reason, definite)
            if best is None or match.confidence > best.confidence: best = match
    return best

def duplicate_result(item: dict[str, Any], status: str, content_hash: str,
                     duplicate_of: str, reason: str = "identical PDF content",
                     confidence: float = 1.0) -> dict[str, Any]:
    """Create an explicit, reviewable duplicate outcome with no publish action."""
    return {
        "file": item["name"],
        "fileId": item["id"],
        "status": status,
        "duplicateOf": duplicate_of,
        "duplicateReason": reason,
        "duplicateConfidence": confidence,
        "contentHash": content_hash,
        "action": "skipped_no_write_no_move",
    }

def validate_record(record: dict[str, Any]) -> None:
    website = record["website"]
    if website["mainCategory"] not in CATEGORIES or website["subCategory"] not in CATEGORIES[website["mainCategory"]]:
        raise ValueError("Invalid website placement")
    if record["documentType"] not in {"research_paper","meta_analysis","guideline_consensus","ifu","article_summary","brochure_other"}:
        raise ValueError("Invalid document type")

def enrich_with_ai(record: dict[str, Any], selected_text: str, model_name: str,
                   evidence_only: bool = False) -> dict[str, Any]:
    """One bounded structured extraction call; never reads a key from source code."""
    if len(selected_text) > MAX_AI_INPUT_CHARACTERS:
        raise ValueError("AI input exceeds the hard character budget")
    api_key = os.getenv("GEMINI_API_KEY")
    from urllib.parse import quote
    from urllib.request import Request, urlopen
    full_shape = {
        "title":"", "citation":"", "year":None, "summary":"",
        "cardBullets":["3-5 concise evidence bullets"], "clinicalTags":[], "searchTerms":[],
        "evidence":[{"claim":"numerical or authoritative claim", "page":4, "locator":"page 4", "kind":"result|safety|recommendation|labeling", "excerpt":"short supporting source text"}],
        "details":{"typeSpecificFields":"Use only fields defined for this documentType"}
    }
    shape = {"evidence": full_shape["evidence"]} if evidence_only else full_shape
    prompt = (
        "Extract only facts explicitly supported by the supplied text for an AtriGuide evidence card. "
        "Do not infer missing numbers or page numbers. Every evidence claim must use the [PAGE n] marker "
        "that contains its supporting text and include a short verbatim supporting excerpt. Return raw JSON only. "
        f"Document type: {record['documentType']}. Required compact shape: {json.dumps(shape)}\n\n{selected_text}"
    )
    headers = {"Content-Type": "application/json"}
    if api_key:
        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{quote(model_name)}:generateContent?key={quote(api_key)}"
        provider = "gemini_api_key"
    else:
        credentials_file = os.getenv("ATRIGUIDE_CREDENTIALS")
        if not credentials_file:
            raise RuntimeError("Set ATRIGUIDE_CREDENTIALS for Vertex AI or GEMINI_API_KEY")
        from google.auth.transport.requests import Request as AuthRequest
        from google.oauth2 import service_account
        credentials = service_account.Credentials.from_service_account_file(
            credentials_file, scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        credentials.refresh(AuthRequest())
        project = os.getenv("ATRIGUIDE_GCP_PROJECT") or credentials.project_id or "atricure-app"
        location = os.getenv("ATRIGUIDE_VERTEX_LOCATION", "us-central1")
        endpoint = (f"https://{location}-aiplatform.googleapis.com/v1/projects/{quote(project)}/"
                    f"locations/{quote(location)}/publishers/google/models/{quote(model_name)}:generateContent")
        headers["Authorization"] = f"Bearer {credentials.token}"
        provider = "vertex_ai"
    generation_config = {
        "responseMimeType": "application/json",
        "temperature": 0.1,
        "maxOutputTokens": 4096 if evidence_only else 3072,
        "thinkingConfig": {"thinkingBudget": 0},
    }
    if evidence_only:
        generation_config["responseJsonSchema"] = {
            "type": "object",
            "properties": {
                "evidence": {
                    "type": "array", "maxItems": 8,
                    "items": {
                        "type": "object",
                        "properties": {
                            "claim": {"type": "string"},
                            "page": {"type": "integer", "minimum": 1},
                            "locator": {"type": "string"},
                            "kind": {"type": "string"},
                            "excerpt": {"type": "string"},
                        },
                        "required": ["claim", "page", "locator", "kind", "excerpt"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["evidence"],
            "additionalProperties": False,
        }
    else:
        evidence_schema = {
            "type": "array", "maxItems": 8,
            "items": {
                "type": "object",
                "properties": {
                    "claim": {"type": "string", "maxLength": 500},
                    "page": {"type": "integer", "minimum": 1},
                    "locator": {"type": "string", "maxLength": 80},
                    "kind": {"type": "string", "maxLength": 40},
                    "excerpt": {"type": "string", "maxLength": 500},
                },
                "required": ["claim", "page", "locator", "kind", "excerpt"],
                "additionalProperties": False,
            },
        }
        generation_config["responseJsonSchema"] = {
            "type": "object",
            "properties": {
                "title": {"type": "string", "maxLength": 240},
                "citation": {"type": "string", "maxLength": 500},
                "year": {"type": "integer"},
                "summary": {"type": "string", "maxLength": 1200},
                "cardBullets": {"type": "array", "maxItems": 5, "items": {"type": "string", "maxLength": 400}},
                "clinicalTags": {"type": "array", "maxItems": 12, "items": {"type": "string", "maxLength": 80}},
                "searchTerms": {"type": "array", "maxItems": 12, "items": {"type": "string", "maxLength": 80}},
                "evidence": evidence_schema,
                "details": {
                    "type": "object",
                    "properties": {"typeSpecificFields": {"type": "string", "maxLength": 1000}},
                    "additionalProperties": False,
                },
            },
            "required": ["title", "citation", "summary", "cardBullets", "clinicalTags", "searchTerms", "evidence", "details"],
            "additionalProperties": False,
        }
    request_body = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": generation_config,
    }).encode("utf-8")
    try:
        with urlopen(Request(endpoint, data=request_body, headers=headers), timeout=120) as response:
            response_bytes = response.read(MAX_AI_RESPONSE_BYTES + 1)
    except Exception as exc:
        detail = ""
        if hasattr(exc, "read"):
            detail = exc.read(4096).decode("utf-8", errors="replace")
        raise RuntimeError(f"AI extraction request failed: {exc}; {detail}".strip()) from exc
    if len(response_bytes) > MAX_AI_RESPONSE_BYTES:
        raise ValueError("AI response exceeds the hard byte budget")
    raw_response = json.loads(response_bytes.decode("utf-8"))
    response_text = raw_response["candidates"][0]["content"]["parts"][0]["text"]
    parsed = json.loads(response_text.replace("```json", "").replace("```", "").strip())
    allowed_keys = ("evidence",) if evidence_only else ("title","citation","year","summary","cardBullets","clinicalTags","searchTerms","evidence","details")
    for key in allowed_keys:
        if key in parsed: record[key] = parsed[key]
    record["cardBullets"] = record.get("cardBullets", [])[:5]
    record["clinicalTags"] = record.get("clinicalTags", [])[:12]
    record["searchTerms"] = record.get("searchTerms", [])[:12]
    record["evidence"] = normalize_evidence(record.get("evidence"))
    record["ingestion"]["model"] = model_name
    record["ingestion"]["aiProvider"] = provider
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
    write_enabled = shadow_writes_allowed(args.apply, args.shadow) or production_writes_allowed(args.apply, args.shadow)
    # Preview mode must compare candidates with the existing library too.
    # This is a read-only collection load; Firestore writes remain guarded by
    # both --apply and the explicit environment acknowledgement below.
    db, firestore_module = load_firestore_client(args.credentials)
    collection = firestore_path(db, args.app_id, shadow=args.shadow)
    # One bounded collection read supports legacy records that predate
    # content hashes/DOIs, without repeating the read for every PDF.
    existing_records = load_existing_records(collection)
    files = list_pdfs(drive, args.pending_folder)
    if args.file_ids_file:
        requested_ids = set(json.loads(Path(args.file_ids_file).read_text(encoding="utf-8")))
        files = [item for item in files if item["id"] in requested_ids]
    selected_files = files[:args.limit] if args.limit else files
    print(f"Found {len(files)} PDF(s) in Pending; processing {len(selected_files)}.", flush=True)
    if not selected_files:
        print("Pending is empty. Nothing to preview or publish.", flush=True)
    previews, seen_hashes = [], {}
    existing_ids = {record_id for record_id, _ in existing_records}
    # Legacy records often have random Firestore document IDs, while retaining
    # the original Drive URL/ID in their source fields. Treat that Drive ID as
    # the authoritative already-imported match before downloading or using AI.
    for _, existing in existing_records:
        existing_drive_id = drive_file_id_from_record(existing)
        if existing_drive_id:
            existing_ids.add(stable_id(existing_drive_id))
    for index, item in enumerate(selected_files, start=1):
        try:
            candidate_id = stable_id(item["id"])
            if candidate_id in existing_ids and not args.reprocess_existing:
                print(f"[{index}/{len(selected_files)}] Already in library: {item['name']}", flush=True)
                previews.append({
                    "file": item["name"], "fileId": item["id"],
                    "status": "already_imported", "existingRecordId": candidate_id,
                    "action": "skipped_no_ai_no_write_no_move",
                })
                Path(args.output).write_text(json.dumps(previews, indent=2), encoding="utf-8")
                continue
            print(f"[{index}/{len(selected_files)}] Downloading: {item['name']}", flush=True)
            raw = download_pdf(drive, item["id"])
            content_hash = hashlib.sha256(raw).hexdigest()
            if content_hash in seen_hashes:
                previews.append(duplicate_result(
                    item, "duplicate_in_batch", content_hash, seen_hashes[content_hash]
                ))
                continue
            seen_hashes[content_hash] = item["id"]
            text = extract_pdf_text(raw)
            record = build_skeleton(item["id"], item["name"], f"https://drive.google.com/file/d/{item['id']}/view", text, item.get("folderHint", ""))
            record["source"]["contentHash"] = content_hash
            validate_record(record)
            if collection:
                print("  Checking the existing library for duplicates...", flush=True)
                duplicate_match = find_content_duplicate(existing_records, record)
                if duplicate_match:
                    if duplicate_match.definite:
                        previews.append(duplicate_result(
                            item, "duplicate_existing", content_hash,
                            duplicate_match.record_id, duplicate_match.reason,
                            duplicate_match.confidence,
                        ))
                    else:
                        previews.append({
                            "file": item["name"], "fileId": item["id"],
                            "status": "possible_duplicate_needs_review",
                            "record": record,
                            "duplicateOf": duplicate_match.record_id,
                            "duplicateReason": duplicate_match.reason,
                            "duplicateConfidence": duplicate_match.confidence,
                            "action": "held_no_write_no_move",
                        })
                    continue
            selected = record.pop("_selectedText")
            if args.use_ai:
                print("  AI scrubbing and building page-linked evidence...", flush=True)
                enrich_with_ai(record, selected, args.model)
                record["evidence"], rejected = filter_grounded_evidence(record.get("evidence") or [], text)
                record["ingestion"]["rejectedCitationCount"] = rejected
                if not record["evidence"]:
                    raise ValueError("No AI evidence claims passed page verification")
                print(f"  Finished: {len(record['evidence'])} verified claim(s); {rejected} rejected.", flush=True)
            status = "preview" if args.use_ai else "new_candidate"
            preview = {"file": item["name"], "fileId": item["id"], "status": status,
                       "record": record, "estimatedInputCharacters": len(selected)}
            if args.use_ai:
                preview["modelInputPreview"] = selected
            else:
                preview["action"] = "ready_for_ai_preview_no_write_no_move"
            previews.append(preview)
            if write_enabled:
                validate_publishable(record)
                existing_snap = collection.document(record["id"]).get()
                existing = existing_snap.to_dict() if existing_snap.exists else None
                merge_manual_override(record, existing)
                publish_record(collection, record, firestore_module)
                existing_records = [(record_id, value) for record_id, value in existing_records if record_id != record["id"]]
                existing_records.append((record["id"], record))
                if not args.shadow:
                    move_to_archive(drive, item["id"], item.get("parents") or [], args.archive_folder)
        except Exception as exc:
            previews.append({"file": item.get("name"), "fileId": item.get("id"),
                             "status": "needs_review", "error": str(exc)})
        # Preserve partial work and error details after every document.
        Path(args.output).write_text(json.dumps(previews, indent=2), encoding="utf-8")
    Path(args.output).write_text(json.dumps(previews, indent=2), encoding="utf-8")
    mode = "SHADOW APPLY" if write_enabled and args.shadow else "PRODUCTION APPLY" if write_enabled else "DRY RUN"
    print(f"{mode}: {len(previews)} results written to {args.output}")
    return 0

def backfill_citations(args: argparse.Namespace) -> int:
    """Enrich existing records in place; never delete or replace the library."""
    if not args.use_ai:
        raise SystemExit("BLOCKED: citation backfill requires --use-ai")
    drive = load_drive_client(args.credentials)
    db, firestore_module = load_firestore_client(args.credentials)
    collection = firestore_path(db, args.app_id, shadow=args.shadow)
    write_enabled = shadow_writes_allowed(args.apply, args.shadow) or production_writes_allowed(args.apply, args.shadow)
    records = load_existing_records(collection)
    previews = []
    eligible_attempts = 0
    for record_id, existing in records:
        enrichment = None
        try:
            if has_page_citations(existing):
                continue
            source = existing.get("source") or {}
            file_id = drive_file_id_from_record(existing)
            if not file_id:
                previews.append({"id": record_id, "status": "needs_review", "error": "missing source.driveFileId"})
                continue
            if args.limit and eligible_attempts >= args.limit:
                break
            eligible_attempts += 1
            print(f"Citation check {eligible_attempts}: {existing.get('title', record_id)}", flush=True)
            raw = download_pdf(drive, file_id)
            text = extract_pdf_text(raw)
            doc_type = existing.get("documentType") or detect_document_type(source.get("fileName", ""), text)[0]
            selected = select_text(text, doc_type)
            enrichment = {
                "documentType": doc_type,
                "evidence": [],
                "ingestion": dict(existing.get("ingestion") or {}),
            }
            enrich_with_ai(enrichment, selected, args.model, evidence_only=True)
            print(f"  AI returned {len(enrichment['evidence'])} claims; verifying page excerpts", flush=True)
            if not enrichment["evidence"]:
                raise ValueError("No page-linked evidence was extracted")
            enrichment["evidence"], rejected = filter_grounded_evidence(enrichment["evidence"], text)
            if len(enrichment["evidence"]) < 3:
                raise ValueError("Fewer than three evidence claims passed page verification")
            update = {
                "schemaVersion": 3,
                "evidence": enrichment["evidence"],
                "ingestion.citationModel": args.model,
                "ingestion.citationBackfilledAt": datetime.now(timezone.utc).isoformat(),
                "ingestion.rejectedCitationCount": rejected,
            }
            previews.append({"id": record_id, "title": existing.get("title", ""),
                             "status": "citation_preview", "update": update,
                             "action": "update_in_place" if write_enabled else "dry_run_no_write"})
            if write_enabled:
                collection.document(record_id).update(update)
        except Exception as exc:
            review = {"id": record_id, "title": existing.get("title", ""),
                      "status": "needs_review", "error": str(exc), "action": "unchanged"}
            if enrichment and enrichment.get("evidence"):
                review["candidateEvidence"] = enrichment["evidence"]
            previews.append(review)
        Path(args.output).write_text(json.dumps(previews, indent=2), encoding="utf-8")
    Path(args.output).write_text(json.dumps(previews, indent=2), encoding="utf-8")
    mode = "SHADOW APPLY" if write_enabled and args.shadow else "PRODUCTION APPLY" if write_enabled else "DRY RUN"
    print(f"{mode}: {len(previews)} citation-backfill results written to {args.output}")
    return 0

def load_json_rows(paths: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        rows.extend(value if isinstance(value, list) else [value])
    return rows

def sync_review_queue(args: argparse.Namespace) -> int:
    db, firestore_module = load_firestore_client(args.credentials)
    queue = review_queue_path(db, args.app_id)
    written = 0
    for row in load_json_rows(args.queue_input):
        status = row.get("status")
        if status not in {"preview", "possible_duplicate_needs_review", "needs_review"}:
            continue
        file_id = row.get("fileId") or row.get("record", {}).get("source", {}).get("driveFileId")
        if not file_id:
            continue
        queue_status = {"preview": "pending_review", "possible_duplicate_needs_review": "possible_duplicate", "needs_review": "needs_review"}[status]
        queue_ref = queue.document(stable_id(file_id))
        existing_queue = queue_ref.get()
        payload = {
            "fileId": file_id, "fileName": row.get("file", ""),
            "candidate": row.get("record"), "duplicateOf": row.get("duplicateOf"),
            "duplicateReason": row.get("duplicateReason"), "duplicateConfidence": row.get("duplicateConfidence"),
            "error": row.get("error"), "updatedAt": firestore_module.SERVER_TIMESTAMP,
        }
        if not existing_queue.exists:
            payload.update({"queueStatus": queue_status, "decision": "pending", "createdAt": firestore_module.SERVER_TIMESTAMP})
        queue_ref.set(payload, merge=True)
        written += 1
    print(f"REVIEW QUEUE: {written} real document(s) synchronized; no library records or Drive files changed.")
    return 0

def cleanup_inventory(args: argparse.Namespace) -> int:
    drive = load_drive_client(args.credentials)
    safe_statuses = {"already_imported", "duplicate_existing", "duplicate_in_batch"}
    receipts = []
    for row in load_json_rows([args.cleanup_inventory]):
        if row.get("status") not in safe_statuses or not row.get("fileId"):
            continue
        try:
            metadata = drive.files().get(fileId=row["fileId"], fields="id,name,trashed").execute()
            if not metadata.get("trashed"):
                trash_drive_file(drive, row["fileId"])
            receipts.append({"fileId": row["fileId"], "file": metadata.get("name"), "status": "duplicate_trashed"})
            print(f"Removed obvious duplicate: {metadata.get('name')}", flush=True)
        except Exception as exc:
            receipts.append({"fileId": row.get("fileId"), "file": row.get("file"), "status": "needs_review", "error": str(exc)})
        Path(args.output).write_text(json.dumps(receipts, indent=2), encoding="utf-8")
    print(f"CLEANUP: {sum(1 for item in receipts if item['status'] == 'duplicate_trashed')} obvious duplicate(s) moved to Drive trash.")
    return 0

def apply_review_decisions(args: argparse.Namespace) -> int:
    drive = load_drive_client(args.credentials)
    db, firestore_module = load_firestore_client(args.credentials)
    queue = review_queue_path(db, args.app_id)
    collection = firestore_path(db, args.app_id)
    receipts = []
    for snapshot in queue.stream():
        item = snapshot.to_dict() or {}
        decision = item.get("decision")
        if decision not in {"approved", "duplicate_confirmed", "reprocess_as_new"} or item.get("decisionApplied") is True:
            continue
        try:
            file_id = item["fileId"]
            metadata = drive.files().get(fileId=file_id, fields="id,name,parents").execute()
            if decision == "approved":
                record = item.get("candidate") or {}
                validate_publishable(record)
                publish_record(collection, record, firestore_module)
                final_status = "published_and_archived"
            elif decision == "reprocess_as_new":
                raw = download_pdf(drive, file_id)
                text = extract_pdf_text(raw)
                record = build_skeleton(file_id, metadata.get("name", item.get("fileName", "")),
                                        f"https://drive.google.com/file/d/{file_id}/view", text)
                selected = record.pop("_selectedText")
                enrich_with_ai(record, selected, args.model)
                record["evidence"], rejected = filter_grounded_evidence(record.get("evidence") or [], text)
                record["ingestion"]["rejectedCitationCount"] = rejected
                validate_publishable(record)
                snapshot.reference.update({
                    "candidate": record,
                    "queueStatus": "pending_review",
                    "decision": "pending",
                    "decisionApplied": False,
                    "duplicateOf": None,
                    "duplicateReason": None,
                    "duplicateConfidence": None,
                    "updatedAt": firestore_module.SERVER_TIMESTAMP,
                })
                receipts.append({"queueId": snapshot.id, "file": metadata.get("name"), "status": "returned_to_review"})
                print(f"Processed as new and returned to review: {metadata.get('name')}", flush=True)
                continue
            else:
                trash_drive_file(drive, file_id)
                final_status = "duplicate_trashed"
                snapshot.reference.update({"queueStatus": final_status, "decisionApplied": True, "appliedAt": firestore_module.SERVER_TIMESTAMP})
                receipts.append({"queueId": snapshot.id, "file": metadata.get("name"), "status": final_status})
                print(f"Removed confirmed duplicate: {metadata.get('name')}", flush=True)
                continue
            move_to_archive(drive, file_id, metadata.get("parents") or [], args.archive_folder)
            snapshot.reference.update({"queueStatus": final_status, "decisionApplied": True, "appliedAt": firestore_module.SERVER_TIMESTAMP})
            receipts.append({"queueId": snapshot.id, "file": metadata.get("name"), "status": final_status})
            print(f"Applied {decision}: {metadata.get('name')}", flush=True)
        except Exception as exc:
            snapshot.reference.update({"queueStatus": "apply_failed", "applyError": str(exc), "updatedAt": firestore_module.SERVER_TIMESTAMP})
            receipts.append({"queueId": snapshot.id, "file": item.get("fileName"), "status": "apply_failed", "error": str(exc)})
        Path(args.output).write_text(json.dumps(receipts, indent=2), encoding="utf-8")
    print(f"DECISIONS: {len(receipts)} decision(s) processed.")
    return 0

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("input_json", nargs="?", help="local JSON containing fileId, name, url and extractedText")
    p.add_argument("--output", default="ingestion_preview.json")
    p.add_argument("--apply", action="store_true", help="request production writes (still requires environment acknowledgement)")
    p.add_argument("--shadow", action="store_true", help="write only to the isolated ingestion-test collection; never move Drive files")
    p.add_argument("--scan-drive", action="store_true", help="scan the configured Pending folder")
    p.add_argument("--backfill-citations", action="store_true", help="enrich existing records in place with page-linked evidence")
    p.add_argument("--sync-review-queue", action="store_true", help="write real preview/held records to the Admin review queue")
    p.add_argument("--queue-input", action="append", default=[], help="preview or inventory JSON to synchronize")
    p.add_argument("--cleanup-inventory", help="inventory JSON whose already-imported and definite-duplicate files should be archived")
    p.add_argument("--apply-review-decisions", action="store_true", help="publish/archive decisions made in the Admin Portal")
    p.add_argument("--credentials", default=os.getenv("ATRIGUIDE_CREDENTIALS", "credentials.json"))
    p.add_argument("--app-id", default=os.getenv("ATRIGUIDE_APP_ID", "atricure-clinical-hub"))
    p.add_argument("--pending-folder", default=os.getenv("ATRIGUIDE_PENDING_FOLDER_ID", "1BOC7ooYHACcEmsVcfJJ3pZOFV-rQueBk"))
    p.add_argument("--archive-folder", default=os.getenv("ATRIGUIDE_ARCHIVE_FOLDER_ID", "1wl-qyPmjlr9eBBUFhhvD8diVk9mJp8ZH"))
    p.add_argument("--limit", type=int, default=0, help="maximum PDFs for a controlled test; 0 means all")
    p.add_argument("--file-ids-file", help="JSON list of Drive file IDs to process")
    p.add_argument("--reprocess-existing", action="store_true", help="intentionally process a Drive file already represented by the same library record")
    p.add_argument("--use-ai", action="store_true", help="perform one bounded extraction call per unique PDF")
    p.add_argument("--model", default=os.getenv("ATRIGUIDE_INGESTION_MODEL", "gemini-2.5-flash"))
    args = p.parse_args()
    # The command option is also the Vertex AI credential source. This keeps
    # the plain-English launcher self-contained without requiring users to
    # configure a separate environment variable.
    os.environ.setdefault("ATRIGUIDE_CREDENTIALS", args.credentials)
    if args.shadow and not args.apply:
        raise SystemExit("BLOCKED: --shadow also requires --apply")
    if args.apply and args.shadow and not shadow_writes_allowed(args.apply, args.shadow):
        raise SystemExit("BLOCKED: shadow apply also requires ATRIGUIDE_ENABLE_SHADOW_WRITES=YES")
    if args.apply and not args.shadow and not production_writes_allowed(args.apply, args.shadow):
        raise SystemExit("BLOCKED: production apply also requires ATRIGUIDE_ENABLE_PRODUCTION_WRITES=YES")
    operational_apply = args.sync_review_queue or bool(args.cleanup_inventory) or args.apply_review_decisions
    if args.apply and not args.use_ai and not operational_apply:
        raise SystemExit("BLOCKED: --apply requires --use-ai so incomplete records cannot be published")
    if operational_apply and not args.apply:
        raise SystemExit("BLOCKED: review/cleanup operations require --apply and production acknowledgement")
    if args.sync_review_queue:
        if not args.queue_input: raise SystemExit("BLOCKED: --sync-review-queue requires --queue-input")
        return sync_review_queue(args)
    if args.cleanup_inventory: return cleanup_inventory(args)
    if args.apply_review_decisions: return apply_review_decisions(args)
    if args.backfill_citations: return backfill_citations(args)
    if args.scan_drive: return scan_drive(args)
    if not args.input_json: p.error("provide input_json, --scan-drive, or --backfill-citations")
    source = json.loads(Path(args.input_json).read_text(encoding="utf-8"))
    record = build_skeleton(source["fileId"], source["name"], source.get("url", ""), source["extractedText"], source.get("folderHint", ""))
    selected = record.pop("_selectedText")
    Path(args.output).write_text(json.dumps({"record": record, "modelInputPreview": selected}, indent=2), encoding="utf-8")
    if args.apply:
        raise SystemExit("Use --scan-drive for an approved cloud apply")
    print(f"DRY RUN: preview written to {args.output}; no Firestore or Drive changes")
    return 0

if __name__ == "__main__": raise SystemExit(main())


