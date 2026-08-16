# Shared goldens

Single source of truth for projection goldens, consumed by **both** test suites:

- Rust: `backend` integration test deserializes every `parity/*.json`, folds with
  `project_balance` / `project_state`, asserts `expected`.
- TypeScript: `frontend` vitest does the same with `projectBalance` / `projectState`.

Neither side may keep its own copy of expected values for these scenarios.
Editing a fixture must flip both suites together.

## Parity fixture format (`parity/*.json`)

```json
{
  "name": "scenario-slug",
  "description": "human-readable intent",
  "facts": [ { "type": "...", "step_position": 0, "submitted_value": null,
               "local_is_correct": true, "coins_delta": 0, "note": null,
               "device_id": "device-a" } ],
  "expected": { "balance": 0, "completed_steps": [], "revealed_hints": [] }
}
```

Fact wire format: externally tagged via `"type"` in `snake_case`
(`physical_confirmed`, `answer_submitted`, `gift_claimed`, `hint_purchased`,
`completion_bonus`, `attempt_completed`, `feedback_reported`, `navigator_used`).
All variants carry the same six fields. There are no correction fact types:
corrections are client-side projection diffs, never stored facts.

Fold rules pinned by these fixtures:

- balance = plain signed sum of `coins_delta`; **may be negative**, never clamped;
- a step is completed by `physical_confirmed`, `attempt_completed`, or
  `answer_submitted` **with `local_is_correct: true`** — wrong answers never
  complete a step;
- `hint_purchased` reveals its step's hint permanently;
- fixtures are post-dedup logs: append-time idempotency (device-agnostic natural
  key; completion bonus once per player+quest) is asserted by facts-sync tests,
  not here.

## Wire fixtures (`wire/*.json`)

Shared boundary rules (issue #66), run by both suites:

- `credentials.json` — email normalize (trim+lowercase) then validate
  (len>=3, has `@`, no whitespace), password min 8. Rust: `auth.rs` tests;
  TS: `lib/credentials.ts` via `wire-goldens.test.ts`.
- `natural-key.json` — byte-exact dedup key of play facts. Rust:
  `facts::natural_key_string`; TS: `queue.factNaturalKey`.
- `features-registry.json` — the ONE list of feature-flag keys and its
  client-visible slice. Rust: `features.rs`; TS: `FEATURE_KEYS`
  (admin-features) and `CLIENT_FEATURE_KEYS` (client-features).

## Snapshot fixtures (`snapshot/*.json`)

Pin the snapshot readers on both sides (issue #64):

- Rust: `backend/src/snapshot.rs` asserts `snapshot_chips` / `snapshot_start_point`
  against `expected` (fixture structs use `deny_unknown_fields`).
- TypeScript: `frontend/lib/snapshot.ts` asserts `mediaRefs` / `chips` / `startPoint`.

```json
{
  "name": "scenario-slug",
  "description": "human-readable intent",
  "snapshot": { "...": "full frozen QuestSnapshot" },
  "expected": { "media_refs": [], "pages": 0, "tasks": 0,
                "paid_hints": false, "start_point": null }
}
```

Rules pinned by these fixtures:

- `media_refs` = every media-bearing field (image roles, `media.video.ref`,
  `supporting.media_video`, bonus animation asset + voice), deduped preserving
  order — frontend-only (backend media retention walks the authoring body);
- `pages` = step count; `tasks` = `task_no`/`task_answer` steps; `paid_hints` =
  any step with a non-null `supporting.hint`;
- `start_point`: PRESENCE of the snapshot key decides — present (even null)
  is the author's word; absent = legacy snapshot, first valid step navigator.

## Quest goldens

- `golden-mystery-fortress-v1.json` — quest snapshot derived from a real export.
- `playthrough-happy-with-gift.json` — action script + expected emitted facts for
  the happy path (used by the frontend replay test).
