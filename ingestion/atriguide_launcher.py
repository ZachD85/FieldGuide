"""Plain-English launcher for the AtriGuide ingestion pipeline."""

from __future__ import annotations

import html
import json
import os
from pathlib import Path
import subprocess
import sys
import webbrowser


HERE = Path(__file__).resolve().parent
PIPELINE = HERE / "atriguide_ingestion.py"
CREDENTIALS = HERE / "credentials.json"
PREVIEW_JSON = HERE / "latest_ingestion_preview.json"
INVENTORY_JSON = HERE / "latest_pending_inventory.json"
CANDIDATE_IDS_JSON = HERE / "new_candidate_ids.json"
PREVIEW_HTML = HERE / "latest_ingestion_report.html"


def pause() -> None:
    input("\nPress Enter to return to the menu...")


def dependencies_ready() -> bool:
    check = subprocess.run(
        [sys.executable, "-c", "import firebase_admin, googleapiclient, pypdf"],
        cwd=HERE,
        capture_output=True,
        text=True,
    )
    return check.returncode == 0


def install_dependencies() -> bool:
    print("\nOne-time setup: installing the Google/PDF helpers this tool needs...")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(HERE / "requirements.txt")],
        cwd=HERE,
    )
    return result.returncode == 0


def ensure_ready() -> bool:
    if not PIPELINE.exists():
        print("ERROR: atriguide_ingestion.py is missing from this folder.")
        return False
    if not CREDENTIALS.exists():
        print("ERROR: credentials.json is missing from this folder.")
        return False
    if dependencies_ready():
        return True
    return install_dependencies() and dependencies_ready()


def sync_queue(paths: list[Path]) -> None:
    command = [sys.executable, str(PIPELINE), "--sync-review-queue", "--apply",
               "--credentials", str(CREDENTIALS), "--output", str(HERE / "review_queue_sync.json")]
    for path in paths:
        if path.exists():
            command.extend(["--queue-input", str(path)])
    if not any(path.exists() for path in paths):
        return
    env = os.environ.copy()
    env["ATRIGUIDE_ENABLE_PRODUCTION_WRITES"] = "YES"
    subprocess.run(command, cwd=HERE, env=env)


def make_report(source_json: Path | None = None) -> None:
    source_json = source_json or (PREVIEW_JSON if PREVIEW_JSON.exists() else INVENTORY_JSON)
    if not source_json.exists():
        return
    try:
        rows = json.loads(source_json.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(rows, list):
        rows = [rows]
    cards = []
    for item in rows:
        record = item.get("record") or {}
        website = record.get("website") or {}
        title = record.get("title") or item.get("file") or item.get("id") or "Untitled"
        status = item.get("status", "unknown")
        category = " &gt; ".join(filter(None, [website.get("mainCategory"), website.get("subCategory")]))
        summary = record.get("summary") or item.get("error") or item.get("duplicateReason") or ""
        action = item.get("action", "")
        cards.append(
            '<article><h2>{}</h2><p class="status">{}</p><p>{}</p><p>{}</p><p>{}</p></article>'.format(
                html.escape(str(title)), html.escape(str(status)), category,
                html.escape(str(summary)), html.escape(str(action)),
            )
        )
    page = """<!doctype html><html><head><meta charset='utf-8'><title>AtriGuide ingestion report</title>
<style>body{{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 18px;background:#f5f7fa;color:#172033}}h1{{margin-bottom:6px}}.note{{color:#536170}}article{{background:white;border:1px solid #dce2ea;border-radius:12px;padding:18px;margin:16px 0;box-shadow:0 2px 8px #0000000d}}h2{{font-size:19px;margin:0 0 8px}}.status{{font-weight:700;color:#1769aa;text-transform:capitalize}}</style></head>
<body><h1>AtriGuide ingestion report</h1><p class='note'>Preview means nothing was published. Possible duplicates and needs-review items stay untouched.</p>{}</body></html>""".format("".join(cards) or "<p>No PDFs were found in Pending.</p>")
    PREVIEW_HTML.write_text(page, encoding="utf-8")


def process_pending() -> None:
    if not ensure_ready():
        pause()
        return
    print("\nProcessing everything in Pending.")
    print("New documents will be prepared for Admin review.")
    print("Obvious duplicates will be moved to Drive trash; nothing new publishes without your approval.")
    command = [
        sys.executable, str(PIPELINE), "--scan-drive", "--use-ai",
        "--credentials", str(CREDENTIALS), "--output", str(PREVIEW_JSON),
    ]
    result = subprocess.run(command, cwd=HERE, env=os.environ.copy())
    if result.returncode == 0 and PREVIEW_JSON.exists():
        rows = json.loads(PREVIEW_JSON.read_text(encoding="utf-8"))
        counts = {}
        for row in rows:
            counts[row.get("status", "unknown")] = counts.get(row.get("status", "unknown"), 0) + 1
        sync_queue([PREVIEW_JSON])
        env = os.environ.copy()
        env["ATRIGUIDE_ENABLE_PRODUCTION_WRITES"] = "YES"
        subprocess.run([
            sys.executable, str(PIPELINE), "--cleanup-inventory", str(PREVIEW_JSON), "--apply",
            "--credentials", str(CREDENTIALS), "--output", str(HERE / "duplicate_cleanup_receipt.json")
        ], cwd=HERE, env=env)
        print("\nProcessing complete:")
        print(f"  Obvious duplicates removed: {counts.get('already_imported', 0) + counts.get('duplicate_existing', 0) + counts.get('duplicate_in_batch', 0)}")
        print(f"  Possible duplicates needing review: {counts.get('possible_duplicate_needs_review', 0)}")
        print(f"  New documents ready for review: {counts.get('preview', 0)}")
    make_report(PREVIEW_JSON)
    if PREVIEW_HTML.exists():
        webbrowser.open(PREVIEW_HTML.as_uri())
    pause()


def run_ai_preview() -> None:
    if not ensure_ready():
        pause()
        return
    if not CANDIDATE_IDS_JSON.exists():
        print("Run option 1 first so existing documents can be removed from the AI queue.")
        pause()
        return
    candidate_ids = json.loads(CANDIDATE_IDS_JSON.read_text(encoding="utf-8"))
    if not candidate_ids:
        print("There are no new candidates to AI-scrub or publish.")
        pause()
        return
    command = [
        sys.executable, str(PIPELINE), "--scan-drive", "--use-ai",
        "--file-ids-file", str(CANDIDATE_IDS_JSON),
        "--credentials", str(CREDENTIALS), "--output", str(PREVIEW_JSON),
    ]
    env = os.environ.copy()
    print(f"\nAI-scrubbing {len(candidate_ids)} new candidate(s). Nothing will be published or moved...")
    result = subprocess.run(command, cwd=HERE, env=env)
    if result.returncode == 0:
        sync_queue([PREVIEW_JSON])
    make_report(PREVIEW_JSON)
    if PREVIEW_HTML.exists():
        webbrowser.open(PREVIEW_HTML.as_uri())
    print("\nFinished." if result.returncode == 0 else "\nThe run stopped with an error; nothing was force-published.")
    pause()


def apply_admin_decisions() -> None:
    if not ensure_ready():
        pause()
        return
    print("\nThis applies decisions already saved in the Admin Portal.")
    print("Approved records will publish, then their PDFs will move to Archive.")
    print("Confirmed duplicates will move to Archive without publishing.")
    if input('Type APPLY to continue: ').strip() != "APPLY":
        print("Cancelled. Nothing changed.")
        pause()
        return
    env = os.environ.copy()
    env["ATRIGUIDE_ENABLE_PRODUCTION_WRITES"] = "YES"
    result = subprocess.run([
        sys.executable, str(PIPELINE), "--apply-review-decisions", "--apply",
        "--credentials", str(CREDENTIALS), "--output", str(HERE / "applied_review_decisions.json")
    ], cwd=HERE, env=env)
    print("\nAdmin decisions applied." if result.returncode == 0 else "\nSome decisions need attention; review the queue status.")
    pause()


def main() -> int:
    while True:
        os.system("cls" if os.name == "nt" else "clear")
        print("=" * 58)
        print("              AtriGuide Article Importer")
        print("=" * 58)
        print("1. Process Pending PDFs")
        print("2. Open the latest report")
        print("3. Finish any 'Treat as New' decisions")
        print("4. Exit")
        choice = input("\nChoose 1, 2, 3, or 4: ").strip()
        if choice == "1":
            process_pending()
        elif choice == "2":
            make_report()
            if PREVIEW_HTML.exists():
                webbrowser.open(PREVIEW_HTML.as_uri())
            else:
                print("No preview exists yet. Choose option 1 first.")
                pause()
        elif choice == "3":
            apply_admin_decisions()
        elif choice == "4":
            return 0
        else:
            print("Please choose 1, 2, 3, or 4.")
            pause()


if __name__ == "__main__":
    raise SystemExit(main())
