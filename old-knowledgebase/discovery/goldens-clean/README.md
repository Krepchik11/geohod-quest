# Clean Golden Fixtures for GeoQuest (New Blueprint Structure)

**Purpose**: These are the authoritative, clean, TDD-ready golden fixtures for the new system. They are derived from real exported quest data but normalized to the exact model in `../../blueprint/SPEC.md` + `CONCEPT.md` + `TECH.md`.

They will be used to:
- Test the pure functions (`isAnswerCorrect`, `validateForPublish`, `serializeToSnapshot`, `projectState`/`projectBalance`).
- Test full playthroughs, facts emission, projections, version freeze, client vs server fidelity, races, offline.
- Drive the Constructor "Test match" and pre-publish gates.
- Validate the 4 templates, supporting behaviors, media roles, facts model.

**Location**: This `goldens-clean/` is the "perfect new structure". Legacy raw exports stay in `exported-quests/`. We map + enrich from them (and future re-fetches) into this clean format.

## Clean Structure (v1 - after adversarial cycle)

### Quest Snapshot (frozen at publish - matches SPEC exactly)
```json
{
  "golden_id": "golden-mystery-fortress-v1",
  "name": "Mystery of the Fortress",
  "snapshot_version": 1,
  "steps": [
    {
      "position": 0,
      "template": "first_screen" | "task_no_answer" | "task_with_answer" | "continue",
      "rich_content": {
        "title": "string (RU)",
        "main_text": "string (RU task description)",
        "place_text": "string (RU)",
        "button_text": "string (RU)",
        "question_prompt": "string | null (for answer tasks)",
        "gift_narrative": "string | null",
        "hint_reveal_text": "string | null"
      },
      "media": {
        "task": "ref-or-url | null",
        "character": "ref-or-url | null",
        "hint": "ref-or-url | null (coin-gated)",
        "atmosphere": "ref-or-url | null"
      },
      "completion": {
        "mode": "physical" | "answer",
        "acceptable": ["string", ...] | null,   // only for answer; plain list
        "allow_note": boolean
      },
      "supporting": {
        "gift": { "coins": number, "narrative_text": "string" } | null,
        "hint": { "cost_coins": number, "reveal_text": "string", "reveal_geo": boolean } | null,
        "navigator": { "lat": number, "lng": number, "label": "string", "hint_only": boolean, "shortest_route_hint": boolean } | null,
        "bonus_animation": { "asset_ref": "string", "voice_ref": "string" } | null,
        "physical_action": { "description": "string", "confirm_label": "string" } | null,
        "terminal": boolean | null,
        "narrative_advance": boolean | null,
        "is_start": boolean | null,
        "media_video": "ref" | null
      }
    }
  ]
}
```

**Notes on this structure**:
- Directly mirrors SPEC "GameStep Shape".
- `template` added for convenience (derived from Page_type + completion in mapping; used in player rendering tests).
- All amounts (gift coins, hint cost) are frozen here.
- Media is explicitly 4-role as per CONCEPT + client requirement.
- Supporting is additive/optional as per blueprint.

### Playthrough Golden (for facts, projections, races, client match)
```json
{
  "golden_id": "golden-mystery-fortress-v1-happy-path",
  "quest_snapshot_id": "golden-mystery-fortress-v1",
  "description": "Happy path with one gift + one answer + terminal",
  "actions": [
    {
      "step_position": 0,
      "type": "physical_confirm" | "submit_answer",
      "value": "string | null",
      "note": "string | null",
      "device_id": "device-a",
      "local_ts": 1000,
      "local_is_correct": true   // what the client claims
    }
  ],
  "expected_facts": [
    {
      "type": "physical_confirmed" | "answer_submitted" | "gift_claimed" | "attempt_completed" | "hint_purchased",
      "step_position": 0,
      "submitted_value": "string | null",
      "local_is_correct": true,
      "coins_delta": 5,
      "note": "...",
      "device_id": "device-a"
    }
  ],
  "expected_final_balance": 10,
  "expected_revealed": [],
  "notes": "Synthesized facts for coverage of gift + answer + projection. Real answers from export used where possible."
}
```

This allows testing:
- isAnswerCorrect against real acceptable lists.
- Fact emission + idempotency.
- Projection fold (client and server must produce same balance/state).
- Version binding (old snapshot amounts used even if new version exists).

## How Data Was Populated (Mapping Rules from Legacy Exports)

We started from the exported quest data (raw_bubble_ids + partial answers) + re-fetched full raw page_constructor records using the admin token for accuracy.

Mapping rules (applied with skepticism):
- Page_type "Question" or presence of "Answer" field → template: "task_with_answer", completion.mode = "answer", acceptable = the Answer list (real synonyms preserved, e.g. "ПУПИН" / "МИХАЙЛО ПУПИН").
- Page_type "Start" → template: "first_screen", is_start: true, completion: physical.
- Page_type "Congratulations" or "Continue" → template: "continue", terminal: true.
- Main_text_RU / Page_name_RU / Button_text_RU → rich_content (RU only for v1).
- Hint_Image or Image_link → media.hint or media.task (legacy has 1 image; we map to the most relevant role and leave others null. Full 4-role will come from Constructor in future).
- Gift_Coins (when present in raw) → supporting.gift.coins.
- For missing supporting (navigator, bonus_animation, physical_action, meaningful gifts): 
  - Left null where legacy has none (honest).
  - One or two steps per golden augmented with realistic values ONLY for test coverage of the full SPEC model (marked in "notes").
- Position: derived from order in export (legacy order is stable for the snapshot).
- Acceptable lists: taken directly from real data where available (strong for isAnswerCorrect testing).

**Skepticism applied**:
- We do NOT pretend all legacy steps had 4-role comics or navigator — most did not. Augmentations are explicit.
- Real answer lists with synonyms are gold (tests the "basic membership" rule + future normalization).
- Physical steps are treated uniformly ("no difference") per blueprint.

## Created Samples (in this directory)

- `golden-mystery-fortress-v1.json` — one full snapshot (mixed physical/answer, using real texts + answers from export 1717918496002..., mapped Page_type, one terminal).
- `golden-short-terminal-v1.json` — short quest focused on first_screen + continue (tests terminal + review prompt path).
- `playthrough-happy-with-gift.json` — actions using real acceptable, expected gift fact + balance projection.
- `playthrough-wrong-then-hint.json` — tests wrong answer, hint spend (even if hint cost 0 in legacy for now), client claim vs fact.

These are the starting "perfect" goldens. Future exports can be transformed into more using the same mapping.

## Iteration History (Chief Critical Analyst)

**v0 (naive)**: Just take the current exported-quests/*.json and call them goldens.
- Deconstruct: 80%+ fields null (main_text, media, gifts). No facts/projections. No 4-role. Violates "rich content primary".
- Exposed: Useless for 90% of the risks in PLAN (frozen content, coin economy, navigator, popup hints, client projection).
- Rebuild: This file + clean structure + populated samples from re-fetched raw.

**v1 (current)**: The structure above + samples.
- Self-critique: Still relies on some synthesis for supporting (because legacy didn't have navigator/gifts in the sampled steps). This is acceptable per YAGNI + robustness (untested paths are the biggest risk per the adversarial analyses). Next iteration (when more exports or ctor data arrives): re-generate with real Gift_Coins, real 4 images per step, real navigator geo from the "Mystery of the Fortress" statue example.
- Robustness win: Real synonym answers + variety of Page_type → templates. Explicit "synthesized" markers. Pure JSON → works for Rust/TS/Python tests.
- Maintainability: One source of truth structure. Easy to add new goldens. DRY (mapping rules documented once).

This survives the cycle because:
- Directly satisfies the invariants and "goldens from real exported quests" requirement in PLAN.md.
- Covers the core TDD needs for Phase 2 pure functions.
- Highest readability (matches blueprint field names exactly).
- Extreme skepticism applied: every null is explained, every augmentation justified.

Use these as the foundation. When implementing the shared code, load these JSONs and assert the pure fns produce the expected facts/projections/client outcomes.

---
Chief Staff Engineer + Critical Analyst mode. Iterated until it felt robust. Re-open this README and the samples when adding more goldens or when real ctor data arrives.