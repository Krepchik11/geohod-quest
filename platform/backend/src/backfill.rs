//! One-off transfer of already-stored inline media into the media store.
//!
//! [`crate::media::MediaStores::externalize_tree`] closes the cause: no write
//! puts pixels in a row any more. It cannot reach what is already written —
//! quests authored before that rule still carry their cover and every step
//! image as base64 inside the row, so they show a letter tile in the dashboard,
//! push a quest record to ~13 MB, and ship the same picture twice in an export
//! (once as a file, once as a string in `quest.json`).
//!
//! This walks those rows and rewrites them, using exactly the same externalizer
//! a write uses. Safe to run repeatedly and safe to stop at any point: the media
//! store is content-addressed, so re-storing a picture is a no-op, and a row
//! that is already clean is skipped. It is NOT a database migration — the schema
//! does not change; the payloads have to be decoded and put in a bucket, which
//! SQL cannot do.

use crate::errors::AppError;
use crate::media::MediaStores;
use crate::store::{ConstructorStores, GrantStores};

/// What one run did. Rows, not bytes: the operator's question is "how much is
/// left", and the answer is [`Self::complete`].
#[derive(serde::Serialize, Default, Debug)]
pub struct MediaBackfillReport {
    /// Authoring rows read.
    pub quests_scanned: usize,
    /// Authoring rows rewritten.
    pub quests_rewritten: usize,
    /// Authoring rows an author's save beat us to. Not an error and not a loss —
    /// their save externalized the row anyway; the next run confirms it.
    pub quests_contended: usize,
    /// Catalog rows whose store-card cover was moved out.
    pub published_rewritten: usize,
    /// Frozen snapshots rewritten — every version, not just the live one, since
    /// a superseded snapshot is still bound by attempts that are mid-play.
    pub snapshots_rewritten: usize,
    /// Distinct pictures moved into the store. Counted per payload, so the same
    /// picture in two quests counts twice while the store keeps one copy.
    pub images_stored: usize,
    /// Everything was walked. `false` means the run stopped on its row budget —
    /// run it again; it picks up where the remaining work is.
    pub complete: bool,
}

/// Rows to rewrite per run when the caller names no budget. Bounded because a
/// legacy quest is megabytes that must be read, decoded and uploaded, and the
/// whole registry does not fit in one request's timeout.
pub const DEFAULT_LIMIT: usize = 10;

/// Cheap test for "this value still holds a picture". The full parse decodes
/// megabytes of base64; deciding whether a row needs work must not.
fn is_inline(value: Option<&str>) -> bool {
    value.is_some_and(|v| v.starts_with("data:"))
}

/// Move every already-stored inline image into the media store, at most `limit`
/// rows per run. See [`MediaBackfillReport`].
pub async fn run_media_backfill(
    media: &MediaStores,
    constructor: &ConstructorStores,
    grants: &GrantStores,
    limit: usize,
) -> Result<MediaBackfillReport, AppError> {
    let mut report = MediaBackfillReport::default();
    let mut budget = limit;

    // The authoring registry: the row the dashboard lists and the editor opens.
    for summary in constructor.list_all_summaries().await? {
        if budget == 0 {
            return Ok(report);
        }
        let Some(quest) = constructor.get(&summary.quest_id).await? else {
            continue; // deleted between the list and the read
        };
        report.quests_scanned += 1;
        let cover_inline = is_inline(quest.cover.as_deref());
        let mut body = quest.body;
        let moved = media.externalize_tree(&mut body).await?;
        // The cover COLUMN is denormalized from the body, so its picture is
        // normally one the body walk already stored — content addressing makes
        // this a lookup, not a second upload, and keeps it out of the count.
        let cover = media.externalize(quest.cover).await?;
        // Still inline afterwards means the payload is not a storable image (a
        // truncated blob, a type this store does not keep). Nothing was moved,
        // so counting or rewriting the row would claim progress that never
        // happens — and would repeat, uselessly, on every future run.
        let cover_moved = cover_inline && !is_inline(cover.as_deref());
        if moved == 0 && !cover_moved {
            continue; // already clean, or nothing here can be moved
        }
        report.images_stored += moved;
        if constructor
            .rewrite_media(&quest.quest_id, quest.updated_at, cover, body)
            .await?
        {
            report.quests_rewritten += 1;
        } else {
            report.quests_contended += 1;
        }
        budget -= 1;
    }

    // The catalog row: its cover is what every store card renders.
    for meta in grants.list_published().await? {
        if budget == 0 {
            return Ok(report);
        }
        if !is_inline(meta.primary_comic.as_deref()) {
            continue;
        }
        let quest_id = meta.quest_id.clone();
        let mut meta = meta;
        meta.primary_comic = media.externalize(meta.primary_comic).await?;
        if is_inline(meta.primary_comic.as_deref()) {
            continue; // not a storable image; see the authoring loop above
        }
        report.images_stored += 1;
        // `None` for the snapshot: this writes the catalog row only. The frozen
        // content is rewritten below, through the one call allowed to touch it.
        grants.register_published(&quest_id, meta, None).await?;
        report.published_rewritten += 1;
        budget -= 1;
    }

    // The frozen snapshots: what a player actually downloads and plays offline.
    for snapshot_id in grants.list_snapshot_ids().await? {
        if budget == 0 {
            return Ok(report);
        }
        let Some(mut data) = grants.get_snapshot(&snapshot_id).await? else {
            continue;
        };
        let moved = media.externalize_tree(&mut data).await?;
        if moved == 0 {
            continue;
        }
        report.images_stored += moved;
        if grants.rewrite_snapshot_media(&snapshot_id, data).await? {
            report.snapshots_rewritten += 1;
        }
        budget -= 1;
    }

    report.complete = true;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{InMemoryMediaStore, sha256_hex};
    use crate::store::{
        ConstructorQuest, InMemoryConstructorStore, InMemoryGrantStore, PublishedMeta,
        QuestAttributes,
    };
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    /// "AAAA" and "AQID" are the two pictures every case below uses; the store
    /// addresses them by the sha256 of the bytes they decode to.
    const PNG: &str = "data:image/png;base64,AAAA";
    const JPEG: &str = "data:image/jpeg;base64,AQID";

    fn png_url() -> String {
        format!("/api/media/{}", sha256_hex(&[0u8, 0, 0]))
    }

    fn jpeg_url() -> String {
        format!("/api/media/{}", sha256_hex(&[1u8, 2, 3]))
    }

    struct World {
        media: MediaStores,
        constructor: ConstructorStores,
        grants: GrantStores,
    }

    impl World {
        fn new() -> Self {
            Self {
                media: MediaStores::InMemory(Arc::new(Mutex::new(InMemoryMediaStore::new(
                    "/api/media".to_string(),
                )))),
                constructor: Arc::new(Mutex::new(InMemoryConstructorStore::default())),
                grants: Arc::new(Mutex::new(InMemoryGrantStore::default())),
            }
        }

        async fn run(&self, limit: usize) -> MediaBackfillReport {
            run_media_backfill(&self.media, &self.constructor, &self.grants, limit)
                .await
                .expect("backfill")
        }

        /// A quest written the way rows were written before media was
        /// externalized: pictures inside the row. Unreachable through the API
        /// now — the write path takes them apart — so it goes in through the
        /// store, which is exactly where production's rows already are.
        async fn legacy_quest(&self, quest_id: &str, cover: Option<&str>, body: Value) {
            self.constructor
                .create(ConstructorQuest {
                    quest_id: quest_id.to_string(),
                    author_id: "author-1".to_string(),
                    author_name: "Автор".to_string(),
                    name: "Легаси".to_string(),
                    status: crate::store::CTOR_STATUS_DRAFT.to_string(),
                    cover: cover.map(str::to_string),
                    steps_count: 1,
                    attrs: QuestAttributes::default(),
                    created_at: 10,
                    updated_at: 20,
                    body,
                })
                .await
                .expect("create");
        }

        async fn legacy_publish(&self, quest_id: &str, snapshot_id: &str, comic: Option<&str>) {
            self.grants
                .register_published(
                    quest_id,
                    PublishedMeta {
                        quest_id: quest_id.to_string(),
                        name: "Легаси".to_string(),
                        primary_comic: comic.map(str::to_string),
                        template_summary: "demo".to_string(),
                        snapshot_version: 1,
                        snapshot_id: snapshot_id.to_string(),
                        city: None,
                        duration: None,
                        price: None,
                        description: None,
                        pages: None,
                        tasks: None,
                        paid_hints: None,
                        players_bonus: 0,
                    },
                    Some(json!({ "steps": [{ "image": PNG }, { "image": JPEG }] })),
                )
                .await
                .expect("publish");
        }

        async fn quest(&self, quest_id: &str) -> ConstructorQuest {
            self.constructor
                .get(quest_id)
                .await
                .expect("get")
                .expect("row")
        }
    }

    /// The whole point: a row written with its pictures inside it comes out with
    /// references, everywhere they can sit, and the pictures are in the store.
    #[tokio::test]
    async fn rewrites_a_legacy_quest_row_and_leaves_updated_at_alone() {
        let w = World::new();
        w.legacy_quest(
            "q-legacy",
            Some(PNG),
            json!({
                "meta": { "cover": PNG },
                "steps": [{ "image": { "url": JPEG, "origin": { "url": PNG } } }],
            }),
        )
        .await;

        let report = w.run(DEFAULT_LIMIT).await;
        assert_eq!(report.quests_scanned, 1);
        assert_eq!(report.quests_rewritten, 1);
        assert_eq!(report.quests_contended, 0);
        assert_eq!(report.images_stored, 2, "two distinct pictures");
        assert!(report.complete);

        let q = w.quest("q-legacy").await;
        assert_eq!(q.cover.as_deref(), Some(png_url().as_str()));
        assert_eq!(q.body["meta"]["cover"], png_url());
        assert_eq!(q.body["steps"][0]["image"]["url"], jpeg_url());
        assert_eq!(q.body["steps"][0]["image"]["origin"]["url"], png_url());
        assert_eq!(
            q.updated_at, 20,
            "moving a picture is not an edit — the author saved nothing"
        );
        assert!(
            w.media
                .get(&sha256_hex(&[1u8, 2, 3]))
                .await
                .expect("get")
                .is_some(),
            "the bytes the reference now points at are really stored"
        );
    }

    /// Every version, not only the live one: an attempt created before the next
    /// publish is still bound to the superseded snapshot and still downloads it.
    #[tokio::test]
    async fn rewrites_catalog_covers_and_every_frozen_snapshot() {
        let w = World::new();
        w.legacy_publish("q-pub", "q-pub-v1", Some(PNG)).await;
        // v2 supersedes v1 in the catalog; v1 stays in the snapshot table.
        w.legacy_publish("q-pub", "q-pub-v2", Some(PNG)).await;

        let report = w.run(DEFAULT_LIMIT).await;
        assert_eq!(report.published_rewritten, 1, "one catalog row");
        assert_eq!(report.snapshots_rewritten, 2, "both versions");
        assert!(report.complete);

        let meta = w
            .grants
            .get_published("q-pub")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(meta.primary_comic.as_deref(), Some(png_url().as_str()));
        for snapshot_id in ["q-pub-v1", "q-pub-v2"] {
            let data = w
                .grants
                .get_snapshot(snapshot_id)
                .await
                .expect("get")
                .expect("frozen");
            assert_eq!(data["steps"][0]["image"], png_url(), "{snapshot_id}");
            assert_eq!(data["steps"][1]["image"], jpeg_url(), "{snapshot_id}");
        }
    }

    /// Restartable and safe to re-run: a clean registry costs reads and changes
    /// nothing, which is also what makes stopping on the budget harmless.
    #[tokio::test]
    async fn is_idempotent_and_converges_across_budgeted_runs() {
        let w = World::new();
        for i in 0..3 {
            w.legacy_quest(&format!("q-{i}"), Some(PNG), json!({ "step": JPEG }))
                .await;
        }

        let first = w.run(2).await;
        assert_eq!(first.quests_rewritten, 2);
        assert!(!first.complete, "stopped on the budget, work remains");

        let second = w.run(2).await;
        assert_eq!(second.quests_rewritten, 1, "only the row still inline");
        assert_eq!(
            second.quests_scanned, 3,
            "the clean rows are read and skipped"
        );
        assert!(second.complete);

        let third = w.run(2).await;
        assert_eq!(third.quests_rewritten, 0);
        assert_eq!(third.images_stored, 0);
        assert!(third.complete);
    }

    /// A `data:` value this store cannot keep — a truncated payload, a type it
    /// does not store — is not progress. Counting or rewriting it would claim a
    /// move that never happened, and would do so again on every future run.
    #[tokio::test]
    async fn leaves_a_data_value_it_cannot_store_alone() {
        let w = World::new();
        let broken = "data:image/png;base64,!!!!";
        w.legacy_quest(
            "q-broken",
            Some(broken),
            json!({ "note": "data:text/html;base64,AAAA" }),
        )
        .await;
        w.legacy_publish("q-broken-pub", "q-broken-pub-v1", Some(broken))
            .await;

        let report = w.run(DEFAULT_LIMIT).await;
        assert_eq!(report.quests_scanned, 1);
        assert_eq!(report.quests_rewritten, 0);
        assert_eq!(report.published_rewritten, 0);
        assert_eq!(report.images_stored, 2, "only the snapshot's real pictures");
        assert!(report.complete);
        assert_eq!(w.quest("q-broken").await.cover.as_deref(), Some(broken));
    }

    /// A row someone saved while the backfill was reading it is left alone
    /// rather than overwritten — the author's edit is worth more than one
    /// row's worth of migration, and the next run takes it.
    #[tokio::test]
    async fn skips_a_row_that_moved_under_it() {
        let w = World::new();
        w.legacy_quest("q-busy", Some(PNG), json!({ "step": JPEG }))
            .await;
        // What an autosave landing mid-run does: the row is no longer the one
        // the backfill read, so its optimistic guard refuses the write.
        assert!(
            !w.constructor
                .rewrite_media("q-busy", 999, None, json!({}))
                .await
                .expect("rewrite"),
            "a stale updated_at cannot write"
        );
        let report = w.run(DEFAULT_LIMIT).await;
        assert_eq!(
            report.quests_rewritten, 1,
            "the current version still writes"
        );
    }
}
