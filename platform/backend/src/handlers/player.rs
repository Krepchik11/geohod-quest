//! Player-facing routes: health probe, attempts + fact sync, bundle download,
//! marketplace catalog, product page, PWA icons, own grants, public feature
//! flags, measurement notes, and cross-attempt player stats.

use axum::{
    Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Json},
    routing::{get, post},
};

use crate::authz::{claimed_from_headers, resolve_user};
use crate::errors::AppError;
use crate::facts::{self, Fact, ProjectedState};
use crate::features::Feature;
use crate::grants::AccessGrant;
use crate::settings::Setting;
use crate::store::{self, AttemptMeta, PublishedMeta};
use crate::{AppState, icons, media, snapshot};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health_handler))
        .route("/api/attempts", post(create_attempt_handler))
        .route(
            "/api/attempts/{attempt_id}/facts",
            post(append_facts_handler),
        )
        .route("/api/attempts/{attempt_id}/state", get(get_state_handler))
        .route("/api/quests", get(list_quests_handler))
        .route("/api/quests/{quest_id}/bundle", get(get_bundle_handler))
        .route("/api/quests/{quest_id}", get(get_quest_product_handler))
        .route(
            "/api/quests/{quest_id}/reviews",
            get(get_quest_reviews_handler),
        )
        .route(
            "/api/quests/{quest_id}/icons/{icon}",
            get(get_quest_icon_handler),
        )
        .route("/api/grants", get(list_grants_handler))
        .route("/api/features", get(public_features_handler))
        .route("/api/measure/rates", get(get_measure_rates_handler))
        .route("/api/users/me/stats", get(get_my_stats_handler))
}

/// Health check response for probes, tests and the release gate.
///
/// One identity, and a derived one: see [`crate::config::AppConfig::build_id`] for
/// why the crate version is deliberately absent.
#[derive(serde::Serialize)]
struct HealthResponse {
    status: &'static str,
    build_id: String,
}

async fn health_handler(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    Ok((
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok",
            build_id: state.config.build_id.clone(),
        }),
    ))
}

/// Body for POST /api/attempts.
#[derive(serde::Deserialize, serde::Serialize)]
struct CreateAttemptRequest {
    user_id: String,
    quest_id: String,
}

/// Creates an attempt for a grant holder, bound to the quest's latest published
/// snapshot (the binding never changes — version freeze). 401 for a registered
/// identity without a session, 403 without a grant, 404 for unpublished quests.
async fn create_attempt_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateAttemptRequest>,
) -> Result<Json<AttemptMeta>, AppError> {
    let user_id = resolve_user(&state, &headers, &req.user_id).await?;
    if !state.grants.has_grant(&user_id, &req.quest_id).await? {
        return Err(AppError::Forbidden(format!(
            "no access grant for quest '{}'",
            req.quest_id
        )));
    }
    let snapshot_id = state
        .grants
        .get_published(&req.quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("quest '{}' is not published", req.quest_id)))?
        .snapshot_id;
    let meta = state
        .store
        .create_attempt(&user_id, &req.quest_id, &snapshot_id)
        .await?;
    Ok(Json(meta))
}

/// Body for POST /api/attempts/{id}/facts: a batch of player facts.
#[derive(serde::Deserialize, serde::Serialize)]
struct AppendRequest {
    facts: Vec<Fact>,
}

/// Sync response: newly accepted facts + the authoritative projection. No
/// corrections — clients diff their pre-sync projection against `projected`.
#[derive(serde::Serialize, serde::Deserialize)]
struct SyncResponse {
    accepted: Vec<Fact>,
    projected: ProjectedState,
    snapshot_id: String,
    fact_count: usize,
}

async fn append_facts_handler(
    State(state): State<AppState>,
    Path(attempt_id): Path<String>,
    Json(req): Json<AppendRequest>,
) -> Result<Json<SyncResponse>, AppError> {
    let accepted = state
        .store
        .append_idempotent(&attempt_id, req.facts)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown attempt '{attempt_id}'")))?;
    let (projected, snapshot_id, fact_count) = state
        .store
        .get_projected(&attempt_id)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("attempt vanished mid-request")))?;
    Ok(Json(SyncResponse {
        accepted,
        projected,
        snapshot_id,
        fact_count,
    }))
}

async fn get_state_handler(
    State(state): State<AppState>,
    Path(attempt_id): Path<String>,
) -> Result<Json<SyncResponse>, AppError> {
    let (projected, snapshot_id, fact_count) = state
        .store
        .get_projected(&attempt_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown attempt '{attempt_id}'")))?;
    Ok(Json(SyncResponse {
        accepted: vec![],
        projected,
        snapshot_id,
        fact_count,
    }))
}

#[derive(serde::Deserialize)]
struct BundleQuery {
    user_id: String,
}

/// The grant-gated bundle envelope: the frozen snapshot JSON plus its identity.
/// `primary_comic` is the catalog cover (lives in meta, not the frozen snapshot)
/// so the client can precache it for offline alongside the snapshot's media —
/// same value the store card resolves, so the precached bytes match what renders.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "BundleWire"))]
pub(crate) struct BundleWire {
    quest_id: String,
    snapshot_id: String,
    snapshot_version: u32,
    primary_comic: Option<String>,
    #[cfg_attr(test, ts(type = "unknown"))]
    snapshot: Option<serde_json::Value>,
}

/// Bundle download primitive: latest frozen snapshot JSON, gated by grant
/// (SPEC: "Grant before attempt/bundle"). Asset packing comes with the media
/// store phase.
async fn get_bundle_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Query(q): Query<BundleQuery>,
) -> Result<Json<BundleWire>, AppError> {
    let user_id = resolve_user(&state, &headers, &q.user_id).await?;
    let (meta, snapshot) = state
        .grants
        .get_bundle(&quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("quest '{quest_id}' is not published")))?;
    if !state.grants.has_grant(&user_id, &quest_id).await? {
        return Err(AppError::Forbidden(format!(
            "no access grant for quest '{quest_id}'"
        )));
    }
    Ok(Json(BundleWire {
        quest_id: meta.quest_id,
        snapshot_id: meta.snapshot_id,
        snapshot_version: meta.snapshot_version,
        primary_comic: meta.primary_comic,
        snapshot,
    }))
}

/// Marketplace catalog row: the stored [`PublishedMeta`] plus the live aggregate
/// rating. The rating is a pure projection of the current published version's
/// finale `quest_rated` facts (never stored), so a freshly published quest reports
/// `rating_count: 0` and the client shows "no ratings yet" instead of a fake score.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "PublishedQuestWire"))]
pub(crate) struct CatalogQuest {
    #[serde(flatten)]
    meta: PublishedMeta,
    rating_avg: f64,
    #[cfg_attr(test, ts(type = "number"))]
    rating_count: usize,
    /// Public players counter: real distinct completions + the author's marketing
    /// `players_bonus`. The raw bonus is never sent on its own (see PublishedMeta).
    #[cfg_attr(test, ts(type = "number"))]
    players: i64,
    /// Author attributes from the constructor row (store-page filters); `None` /
    /// empty for a legacy/direct publish that has no constructor row.
    complexity: Option<String>,
    age_target: Option<String>,
    tags: Vec<String>,
}

async fn list_quests_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<CatalogQuest>>, AppError> {
    // Store visibility is governed by the AUTHORITATIVE lifecycle status
    // (constructor_quests.status) — the single source of truth — NOT by the mere
    // presence of a frozen snapshot. The marketplace lists ONLY `published` quests:
    // a quest the author moved to `test` or `draft` keeps its snapshot (still
    // resolvable by direct link, grant-gated) but disappears from the store. This is
    // the root-cause fix for "a test/draft quest still shows in the store": before,
    // the catalog returned every `published_quests` row regardless of status, so a
    // publish-then-unpublish left the row (and thus the store card) behind.
    //
    // A `published_quests` row with NO constructor row (a quest published straight
    // through the API, e.g. a legacy/operator publish) has no managed lifecycle and
    // is treated as published — preserving prior behavior for that path.
    //
    // The two reads hit different tables with no data dependency, so run them
    // concurrently.
    let (published, listings) = tokio::join!(
        state.grants.list_published(),
        state.constructor.listings_by_quest(),
    );
    let published = published?;
    let mut listings = listings?;
    // Keep only visible quests: `published` status, or NO constructor row at all
    // (legacy/direct publish). A `test`/`draft` quest keeps its snapshot but leaves
    // the store.
    let visible: Vec<PublishedMeta> = published
        .into_iter()
        .filter(|meta| {
            listings
                .get(&meta.quest_id)
                .map(|l| l.status.as_str())
                .is_none_or(|s| s == store::CTOR_STATUS_PUBLISHED)
        })
        .collect();
    // Ratings for EVERY visible quest: per-player, all-versions, hide-aware
    // (content-moderation) — one effective rating per (player, quest), dropping
    // hidden pairs. Ratings, completions, and the hidden set are independent reads,
    // run concurrently; the fold then groups the rows by quest.
    let quest_ids: Vec<String> = visible.iter().map(|m| m.quest_id.clone()).collect();
    let (rating_rows, completions, hidden) = tokio::join!(
        state.store.quest_rating_rows(Some(&quest_ids)),
        state.store.completions_by_quest(),
        state.moderation.hidden_review_keys(),
    );
    let rating_rows = rating_rows?;
    let completions = completions?;
    let hidden = hidden?;
    let mut rows_by_quest: std::collections::HashMap<String, Vec<facts::PlayerRatingRow>> =
        std::collections::HashMap::new();
    for row in rating_rows {
        rows_by_quest
            .entry(row.quest_id.clone())
            .or_default()
            .push(row);
    }
    let ratings: std::collections::HashMap<String, (f64, usize)> = rows_by_quest
        .into_iter()
        .map(|(q, rows)| (q, facts::fold_rating_rows(&rows, &hidden)))
        .collect();
    let out: Vec<CatalogQuest> = visible
        .into_iter()
        .map(|meta| {
            let (rating_avg, rating_count) =
                ratings.get(&meta.quest_id).copied().unwrap_or((0.0, 0));
            // Public players counter: real distinct completions + marketing bonus.
            let players =
                completions.get(&meta.quest_id).copied().unwrap_or(0) as i64 + meta.players_bonus;
            // Attributes from the constructor row; a legacy/direct publish has none.
            let attrs = listings.remove(&meta.quest_id).map(|l| l.attrs);
            CatalogQuest {
                meta,
                rating_avg,
                rating_count,
                players,
                complexity: attrs.as_ref().map(|a| a.complexity.clone()),
                age_target: attrs.as_ref().map(|a| a.age_target.clone()),
                tags: attrs.map(|a| a.tags).unwrap_or_default(),
            }
        })
        .collect();
    Ok(Json(out))
}

/// Product page payload (§3.1/§12.9): ONLY model data — the published card, the
/// live rating aggregates, the constructor's store description, author display
/// name + how many of their quests are on sale, and snapshot-derived content
/// chips. Visibility matches the catalog: a delisted quest 404s here too.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "ProductPageWire"))]
pub(crate) struct ProductPageWire {
    #[serde(flatten)]
    meta: PublishedMeta,
    rating_avg: f64,
    #[cfg_attr(test, ts(type = "number"))]
    rating_count: usize,
    /// Public players counter: real distinct completions + marketing `players_bonus`.
    #[cfg_attr(test, ts(type = "number"))]
    players: i64,
    /// Author display label from the constructor row; None for legacy/direct
    /// publishes that have no constructor lifecycle.
    author_name: Option<String>,
    /// How many of this author's quests are currently on sale.
    author_published_count: u32,
    /// §11 reviews: newest-written first — the first page; the rest comes from
    /// GET /api/quests/{id}/reviews.
    reviews: Vec<ReviewWire>,
    /// Total ratings that carry text («{M} с отзывом»).
    #[cfg_attr(test, ts(type = "number"))]
    reviews_total: usize,
    /// «Место старта» — see [`snapshot_start_point`]; None hides the button.
    start_point: Option<snapshot::StartPointWire>,
    /// The quest's own colours — see [`snapshot_theme`]. Read by the per-quest
    /// PWA manifest so an installed quest opens on its own background.
    theme: Option<snapshot::ThemeWire>,
}

/// §11: one public review — author FIRST NAME only (display name's first word;
/// anonymous → «Игрок»), never an email; month-precision timestamp client-side.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "ReviewWire"))]
pub(crate) struct ReviewWire {
    author: String,
    #[cfg_attr(test, ts(type = "number"))]
    rating: i64,
    text: String,
    #[cfg_attr(test, ts(type = "number"))]
    created_at: u64,
}

/// Default (and product-page) review page size; `limit` on the reviews
/// endpoint is capped at [`REVIEWS_PAGE_MAX`].
const REVIEWS_PAGE: usize = 10;
const REVIEWS_PAGE_MAX: usize = 50;

/// §11 pagination: one page of a quest's reviews («Показать ещё» past the
/// first ten on the product page).
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "ReviewsPageWire"))]
pub(crate) struct ReviewsPageWire {
    reviews: Vec<ReviewWire>,
    #[cfg_attr(test, ts(type = "number"))]
    total: usize,
}

#[derive(serde::Deserialize)]
struct ReviewsQuery {
    offset: Option<usize>,
    limit: Option<usize>,
}

/// GET /api/quests/{id}/reviews?offset=&limit= — visibility matches the
/// product page (published only).
async fn get_quest_reviews_handler(
    State(state): State<AppState>,
    axum::extract::Path(quest_id): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<ReviewsQuery>,
) -> Result<Json<ReviewsPageWire>, AppError> {
    state
        .grants
        .get_published(&quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound("quest is not published".into()))?;
    let (rating_rows, hidden) = tokio::join!(
        state
            .store
            .quest_rating_rows(Some(std::slice::from_ref(&quest_id))),
        state.moderation.hidden_review_keys(),
    );
    let (page, total) = facts::quest_reviews(
        &rating_rows?,
        &hidden?,
        q.offset.unwrap_or(0),
        q.limit.unwrap_or(REVIEWS_PAGE).min(REVIEWS_PAGE_MAX),
    );
    let reviews = review_wires(&state, page).await?;
    Ok(Json(ReviewsPageWire { reviews, total }))
}

/// Author display names in ONE round-trip (one get_user per review would be an
/// N+1), shaped into the public wire rows.
async fn review_wires(
    state: &AppState,
    page: Vec<facts::PlayerReview>,
) -> Result<Vec<ReviewWire>, AppError> {
    let author_ids: Vec<String> = page.iter().map(|r| r.user_id.clone()).collect();
    let authors = state.auth.get_users_by_ids(&author_ids).await?;
    Ok(page
        .into_iter()
        .map(|r| ReviewWire {
            author: review_author_label(
                authors
                    .get(&r.user_id)
                    .and_then(|a| a.display_name.as_deref()),
            ),
            rating: r.rating,
            text: r.text,
            created_at: r.created_at,
        })
        .collect())
}

/// First word of the display name; accounts without one (and anonymous
/// players) are «Игрок». Emails never leak into reviews.
fn review_author_label(display_name: Option<&str>) -> String {
    display_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.split_whitespace().next())
        .unwrap_or("Игрок")
        .to_string()
}

async fn get_quest_product_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
) -> Result<Json<ProductPageWire>, AppError> {
    let not_found = || AppError::NotFound(format!("quest '{quest_id}' not found"));
    let meta = state
        .grants
        .get_published(&quest_id)
        .await?
        .ok_or_else(not_found)?;
    // Same visibility rule as the catalog: the authoritative lifecycle status
    // hides test/draft quests; a missing constructor row means a legacy/direct
    // publish and stays visible.
    //
    // The SUMMARY, never the full row: this is the public product page, and all
    // it wants from the authoring registry is a status and an author. Loading the
    // whole entity shipped the authoring body AND the base64 cover — megabytes
    // for an imported quest — over the hottest read path in the product.
    let ctor = state.constructor.summary_for_quest(&quest_id).await?;
    if ctor
        .as_ref()
        .is_some_and(|q| q.status != store::CTOR_STATUS_PUBLISHED)
    {
        return Err(not_found());
    }
    let (author_name, author_published_count) = match &ctor {
        None => (None, 0),
        Some(q) => {
            let published = state
                .constructor
                .list_summaries_for_author(&q.author_id)
                .await?
                .into_iter()
                .filter(|s| s.status == store::CTOR_STATUS_PUBLISHED)
                .count() as u32;
            (Some(q.author_name.clone()), published)
        }
    };
    // Ratings: one effective rating per (player, quest) across all versions, with
    // hidden pairs dropped (content-moderation). The public page and the backend
    // admin list fold identically here; the frontend hide-preview is a same-grain
    // TS mirror kept in step by tests. These reads — ratings, the hidden overlay,
    // the completions counter, and the frozen snapshot — are independent, so run
    // them concurrently (public hot path).
    let (rating_rows, hidden, completions, snapshot) = tokio::join!(
        state
            .store
            .quest_rating_rows(Some(std::slice::from_ref(&quest_id))),
        state.moderation.hidden_review_keys(),
        state.store.completions_for_quest(&quest_id),
        state.grants.get_snapshot(&meta.snapshot_id),
    );
    let rating_rows = rating_rows?;
    let hidden = hidden?;
    let (rating_avg, rating_count) = facts::fold_rating_rows(&rating_rows, &hidden);
    let (page, reviews_total) = facts::quest_reviews(&rating_rows, &hidden, 0, REVIEWS_PAGE);
    let reviews = review_wires(&state, page).await?;
    // Public players counter: real distinct completions + marketing bonus, same
    // basis as the store card so the two never disagree.
    let players = completions? as i64 + meta.players_bonus;
    // «Место старта»: derived from the frozen snapshot on read (kept out of
    // PublishedMeta so no storage migration is needed for old publishes).
    // Same rule for the colours: derived from the frozen snapshot on read.
    let snapshot = snapshot?;
    let start_point = snapshot::snapshot_start_point(snapshot.as_ref());
    let theme = snapshot::snapshot_theme(snapshot.as_ref());
    Ok(Json(ProductPageWire {
        meta,
        rating_avg,
        rating_count,
        players,
        author_name,
        author_published_count,
        reviews,
        reviews_total,
        start_point,
        theme,
    }))
}

/// §5/§12.7 — GET /api/quests/{id}/icons/{192|512}.png: the per-quest PWA
/// home-screen icon, composed from the published cover (center-crop, maskable
/// padding on brand navy). Immutable per published version — the manifest keys
/// the URL with ?v={snapshot_version}, so far-future caching is safe.
async fn get_quest_icon_handler(
    State(state): State<AppState>,
    Path((quest_id, icon)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let size: u32 = match icon.as_str() {
        "192.png" => 192,
        "512.png" => 512,
        _ => return Err(AppError::NotFound(format!("icon '{icon}' not found"))),
    };
    let meta = state
        .grants
        .get_published(&quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("quest '{quest_id}' not found")))?;
    let cover = meta
        .primary_comic
        .as_deref()
        .ok_or_else(|| AppError::NotFound("quest has no cover".into()))?;
    let hash = media::media_hash_in_ref(cover)
        .ok_or_else(|| AppError::NotFound("cover is not a resolvable media ref".into()))?;
    let bytes = state
        .media
        .get(hash)
        .await?
        .ok_or_else(|| AppError::NotFound("cover media not found".into()))?
        .bytes;
    let png = icons::compose_icon(&bytes, size)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("icon compose failed: {e}")))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png".to_string()),
            (
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable".to_string(),
            ),
        ],
        png,
    ))
}

/// Grants for the resolved caller ONLY. Previously returned every player's
/// grants (incl. payment refs) to anyone — a cross-player data leak. The
/// marketplace/cabinet only ever need the caller's own ownership set.
async fn list_grants_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AccessGrant>>, AppError> {
    let claimed = claimed_from_headers(&headers);
    let user_id = resolve_user(&state, &headers, &claimed).await?;
    Ok(Json(state.grants.grants_for_user(&user_id).await?))
}

async fn get_measure_rates_handler(
    State(_state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Sync corrections are client-derived (no stored correction facts), so there is
    // no server-side correction rate; bundle measurement comes with the real packer.
    Ok(Json(serde_json::json!({
        "note": "post-MVP measurement: bundle sizes with real assets, ctor velocity, hint/navigator UX feedback",
        "bundle_est_note": "real ~4-5MB with 4-role comics + audio (measure with packer)"
    })))
}

/// Wire shape of GET /api/features: the client-visible flags' effective
/// verdicts plus the values the player runtime needs alongside them. The
/// universal answer is plaintext by design — the same trust model as the
/// acceptable lists inside quest snapshots (the client is the matcher).
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "PublicFeatures"))]
pub(crate) struct PublicFeaturesResponse {
    flags: std::collections::HashMap<&'static str, bool>,
    /// The platform-wide universal answer; `None` unless the
    /// `player_universal_answer` flag is on AND a value is set.
    universal_answer: Option<String>,
}

/// GET /api/features — effective verdicts of the client-visible flags only
/// (`Feature::client_visible`). Public by design: the player runtime keys UI
/// behavior off these without credentials; server-enforced flags never appear.
async fn public_features_handler(
    State(state): State<AppState>,
) -> Result<Json<PublicFeaturesResponse>, AppError> {
    // One concurrent pass over both stores: the setting is fetched
    // unconditionally (and discarded when its flag is off) rather than
    // serializing a second round-trip behind the overrides read.
    let (overrides, stored_answer) = tokio::try_join!(
        state.flags.all(),
        state.settings.get(Setting::UniversalAnswer.key())
    )?;
    let flags: std::collections::HashMap<&'static str, bool> = Feature::ALL
        .into_iter()
        .filter(|f| f.client_visible())
        .map(|f| (f.key(), f.effective(overrides.get(f.key()).copied())))
        .collect();
    let universal_answer = if flags[Feature::PlayerUniversalAnswer.key()] {
        stored_answer
    } else {
        None
    };
    Ok(Json(PublicFeaturesResponse {
        flags,
        universal_answer,
    }))
}

/// Cross-attempt player statistics: storage gathers the logs, the pure
/// projector folds them (player-stats spec; never re-folded in SQL).
async fn get_my_stats_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<facts::PlayerStats>, AppError> {
    let claimed = claimed_from_headers(&headers);
    let user_id = resolve_user(&state, &headers, &claimed).await?;
    let logs = state.store.attempt_logs_for_user(&user_id).await?;
    // Caller-scoped, PK-indexed lookup — never load every player's grants to count one's own.
    let grants_count = state.grants.grants_for_user(&user_id).await?.len();
    Ok(Json(facts::project_player_stats(&logs, grants_count)))
}
