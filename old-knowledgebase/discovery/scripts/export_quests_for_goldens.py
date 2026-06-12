#!/usr/bin/env python3
"""
Export real quest + page_constructor data for goldens and mapping validation.
Run from the project root (or adjust ROOT).
Requires BUBBLE_BASE_URL and BUBBLE_API_TOKEN (admin token) in env.
Example:
  BUBBLE_BASE_URL=https://your-app.bubbleapps.io/version-test \
  BUBBLE_API_TOKEN=your-admin-token \
  python old-knowledgebase/discovery/scripts/export_quests_for_goldens.py \
    --quest-names "Mystery of the Fortress,Another Quest" \
    --output old-knowledgebase/discovery/exported-quests/

This extends the patterns from discover.py (Bearer auth, api_get with delay, etc.).
Outputs structured JSON per quest with steps mapped toward the new GameStep shape
(position, rich content, completion.mode/acceptable, supporting.gift/hint/navigator/etc.,
media roles, etc.). Use these as goldens for Phase 2 pure functions and tests.

Adjust field names/constraints based on your actual Bubble types (use discovery/parsed/data_types.json
or old-knowledgebase for reference).
"""

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "old-knowledgebase" / "discovery" / "raw"
PARSED = ROOT / "old-knowledgebase" / "discovery" / "parsed"
EXPORT_DIR = ROOT / "old-knowledgebase" / "discovery" / "exported-quests"

BASE_URL = os.environ.get("BUBBLE_BASE_URL", "https://geoquest.bubbleapps.io/version-test")
TOKEN = os.environ.get("BUBBLE_API_TOKEN", "")
API_DELAY = float(os.environ.get("API_DELAY_MS", "300")) / 1000  # Slightly higher for bulk exports


def api_get(path: str, params: str = "") -> dict | list | None:
    """Simple GET with Bearer auth (matches discover.py pattern)."""
    url = f"{BASE_URL}{path}"
    if params:
        url += f"?{params}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
            return data.get("response", data)  # Bubble often wraps in {response: ...}
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:800]
        print(f"HTTPError {e.code} for {url}: {body}")
        return {"_error": e.code, "_body": body, "_url": url}
    except Exception as e:
        print(f"Error for {url}: {e}")
        return {"_error": str(e), "_url": url}
    finally:
        time.sleep(API_DELAY)


def get_all_records(typename: str, constraints: list[dict] | None = None, limit: int = 100) -> list[dict]:
    """Paginate through Bubble Data API list endpoint with optional constraints."""
    results: list[dict] = []
    cursor = 0
    while True:
        params_parts = [f"limit={limit}", f"cursor={cursor}"]
        if constraints:
            import urllib.parse
            constraints_json = json.dumps(constraints)
            params_parts.append(f"constraints={urllib.parse.quote(constraints_json)}")
        params = "&".join(params_parts)
        data = api_get(f"/api/1.1/obj/{typename}", params)
        if not data or isinstance(data, dict) and data.get("_error"):
            break
        if isinstance(data, list):
            batch = data
        else:
            batch = data.get("results", data) if isinstance(data, dict) else []
        if not batch:
            break
        results.extend(batch)
        if len(batch) < limit:
            break
        cursor += len(batch)
        print(f"  Fetched {len(results)} {typename} so far...")
    return results


def export_quest_data(quest_names: list[str] | None = None, output_dir: Path = EXPORT_DIR) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Exporting quests and page_constructor records for goldens...")

    # 1. Get quests (filter by name if provided; assume 'quest' type or 'Quest' – adjust per your data_types)
    quest_constraints = None
    if quest_names:
        # Bubble constraints example for name match (OR multiple names)
        quest_constraints = [{"key": "name", "constraint_type": "text contains", "value": name} for name in quest_names]
        # For exact, use "equals". For production, query published quests etc.

    quests = get_all_records("quest", constraints=quest_constraints)  # <-- Adjust typename if needed (see parsed/data_types.json)
    if not quests:
        print("No quests found. Check type name and token/URL. Trying 'Quest' or checking parsed data...")
        # Fallback probe
        quests = get_all_records("Quest", constraints=quest_constraints) or []

    print(f"Found {len(quests)} quest(s).")

    for quest in quests:
        qid = quest.get("_id") or quest.get("id")
        qname = quest.get("name") or quest.get("title") or qid
        safe_name = "".join(c if c.isalnum() or c in (" ", "-", "_") else "_" for c in qname).strip().replace(" ", "_")
        print(f"\nProcessing quest: {qname} ({qid})")

        # 2. Get page_constructor records for this quest (main source for steps)
        # From live probe: the linking field is "Quest_name" (not "quest"). Type is "page_constructor".
        pc_constraints = [
            {"key": "Quest_name", "constraint_type": "equals", "value": qid}
        ]
        pages = get_all_records("page_constructor", constraints=pc_constraints)
        if not pages:
            pages = get_all_records("Page_constructor", constraints=pc_constraints) or []
            if not pages:
                print("  No page_constructor found for this quest. Check relation field name.")
                continue

        print(f"  Found {len(pages)} page_constructor steps.")

        # 3. Basic mapping toward GameStep shape (expand as you validate against SPEC)
        steps = []
        for p in sorted(pages, key=lambda x: x.get("order") or x.get("position") or 0):
            step = {
                "position": p.get("order") or p.get("position") or p.get("index"),
                "internal_name": p.get("internal_name") or p.get("name"),
                "title": p.get("title") or p.get("main_text", "")[:80],
                "main_text": p.get("main_text") or p.get("description"),
                "place_text": p.get("place_text"),
                "completion": {
                    "mode": "answer" if p.get("Answer") or p.get("answers") or p.get("correct_answer") else "physical",
                    "acceptable": p.get("Answer") or p.get("answers") or [],  # list of strings
                    "allow_note": bool(p.get("allow_note")),
                },
                "supporting": {
                    "gift": {"coins": p.get("Gift_Coins") or p.get("gift_coins") or 0, "narrative_text": p.get("gift_narrative")},
                    "hint": {"cost_coins": p.get("hint_cost") or p.get("Buy_hint_cost") or 0} if p.get("hint_cost") or p.get("Buy_hint_cost") else None,
                    # navigator, bonus_animation, physical_action, etc. – map from your fields
                },
                "media": {
                    "task": p.get("task_image") or p.get("comic_task"),
                    "character": p.get("character_image"),
                    "hint": p.get("hint_image"),
                    "atmosphere": p.get("atmosphere_image"),
                },
                "raw_bubble_id": p.get("_id"),
                # Add more fields as needed for validation (geo, video, terminal, etc.)
            }
            # Clean empty supporting
            step["supporting"] = {k: v for k, v in step["supporting"].items() if v}
            steps.append(step)

        # 4. Write per-quest export
        export = {
            "quest_id": qid,
            "quest_name": qname,
            "bubble_raw_quest": quest,
            "steps": steps,
            "step_count": len(steps),
            "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "notes": "Raw export for goldens. Map further to exact GameStep shape in SPEC.md. Use for Phase 2 tests.",
        }
        out_path = output_dir / f"{safe_name}.json"
        out_path.write_text(json.dumps(export, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  Wrote {out_path}")

    print(f"\nExport complete. Files in {output_dir}. Use these for goldens in Phase 2 (isAnswerCorrect, projections, etc.).")
    print("Next: Validate mappings against CONCEPT/SPEC (e.g. how many physical vs answer, comic role usage).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export Bubble quest data for goldens.")
    parser.add_argument("--quest-names", nargs="*", help="Quest names (partial match) to export. Omit for all accessible.")
    parser.add_argument("--output", type=Path, default=EXPORT_DIR, help="Output directory.")
    args = parser.parse_args()

    if not TOKEN:
        print("ERROR: Set BUBBLE_API_TOKEN env var (admin token recommended for full data).")
        print("Also set BUBBLE_BASE_URL if not the default.")
        exit(1)

    export_quest_data(quest_names=args.quest_names, output_dir=args.output)
