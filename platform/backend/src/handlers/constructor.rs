//! Constructor dashboard routes — the authoring registry behind /quest-editor,
//! plus publish. Every endpoint is editor-gated (require_editor_actor: an
//! editor/admin session or the ops token). Completions ("прохождения") are derived per quest
//! from the fact log — never stored on the constructor row — so the metric stays
//! a pure projection.

use axum::{
    Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, header},
    response::Json,
    routing::{get, post},
};

use crate::auth;
use crate::authz::{
    require_constructor_admin, require_editor_actor, require_owned_constructor_quest,
    require_owned_constructor_summary,
};
use crate::errors::AppError;
use crate::store::{self, ConstructorQuest, ConstructorQuestSummary, PublishedMeta};
use crate::{AppState, export, snapshot};

pub fn router() -> Router<AppState> {
    // All mutations are POST — the router/CORS surface is GET+POST only by
    // design. Publish/create/save carry the full quest body, so they lift the
    // default 2 MiB body cap (see MAX_AUTHORING_BODY_BYTES); the GET list/one
    // and the tiny status/delete bodies keep the default.
    Router::new()
        .route(
            "/api/quests/publish",
            post(publish_quest_handler).layer(DefaultBodyLimit::max(MAX_AUTHORING_BODY_BYTES)),
        )
        .route(
            "/api/constructor/quests",
            get(list_constructor_quests_handler)
                .post(create_constructor_quest_handler)
                .layer(DefaultBodyLimit::max(MAX_AUTHORING_BODY_BYTES)),
        )
        .route(
            "/api/constructor/quests/{quest_id}",
            get(get_constructor_quest_handler),
        )
        .route(
            "/api/constructor/quests/{quest_id}/save",
            post(save_constructor_quest_handler)
                .layer(DefaultBodyLimit::max(MAX_AUTHORING_BODY_BYTES)),
        )
        .route("/api/constructor/authors", get(list_authors_handler))
        .route(
            "/api/constructor/quests/{quest_id}/status",
            post(set_constructor_status_handler),
        )
        .route(
            "/api/constructor/quests/{quest_id}/author",
            post(set_constructor_author_handler),
        )
        .route(
            "/api/constructor/quests/{quest_id}/delete",
            post(delete_constructor_quest_handler),
        )
        .route(
            "/api/constructor/quests/{quest_id}/export",
            get(export_constructor_quest_handler),
        )
}

/// Body-size ceiling for the authoring routes that carry a full quest payload —
/// create/save (the whole editable `body`) and publish (the frozen `snapshot`).
/// Axum's default extractor limit is 2 MiB, but a single quest legitimately
/// exceeds that: even a spec-compliant quest near the ≤5 MB bundle target blows
/// past 2 MiB.
///
/// Nothing is STORED inline any more — every authored payload is externalized on
/// the way in (see the create/save/publish handlers) — but an INCOMING one still
/// can be: an imported legacy quest reaches ~13 MB, and it has to be accepted
/// before it can be taken apart. Scoped to these editor-gated routes only; every
/// other route keeps the 2 MiB default.
const MAX_AUTHORING_BODY_BYTES: usize = 32 * 1024 * 1024;

#[derive(serde::Deserialize)]
struct PublishRequest {
    quest_id: String,
    name: String,
    primary_comic: Option<String>,
    template_summary: String,
    snapshot_version: Option<u32>,
    /// Frozen snapshot id new attempts bind to; defaults to "{quest_id}-v{version}".
    snapshot_id: Option<String>,
    /// Full frozen snapshot JSON (stored per version, immutable once set).
    snapshot: Option<serde_json::Value>,
    /// Real store-card fields the constructor collects; surfaced in the catalog so
    /// no card has to fabricate them. All optional (a blank field stays absent).
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    duration: Option<String>,
    #[serde(default)]
    price: Option<i64>,
    /// Store description shown on the product page (§3.1); blank stays absent.
    #[serde(default)]
    description: Option<String>,
    /// Marketing padding for the public players counter (real completions + this).
    /// Negative values are clamped to 0 at publish so the count never drops below
    /// the honest completions figure.
    #[serde(default)]
    players_bonus: Option<i64>,
}

async fn publish_quest_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut req): Json<PublishRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Publishing is the editor capability (role editor/admin or the ops token):
    // authoring lives behind /quest-editor, which only editors/admins can open, but
    // publish is a direct API call so the role is enforced here too. Author binding
    // (which editor owns which quest) remains a tracked follow-up.
    require_editor_actor(&state, &headers).await?;
    // The frozen snapshot is what every player downloads, so it is the payload
    // that must NOT carry pixels. Externalized before it is registered, because
    // afterwards it is immutable and nothing may rewrite it — and strictly AFTER
    // the gate above, so no unauthorized caller can put bytes in the store.
    if let Some(snapshot) = req.snapshot.as_mut() {
        state.media.externalize_tree(snapshot).await?;
    }
    let version = req.snapshot_version.unwrap_or(1);
    let (pages, tasks, paid_hints) = snapshot::snapshot_chips(req.snapshot.as_ref());
    let snapshot_id = req
        .snapshot_id
        .unwrap_or_else(|| format!("{}-v{}", req.quest_id, version));
    let meta = PublishedMeta {
        quest_id: req.quest_id.clone(),
        name: req.name,
        // Same rule as the authoring row: the catalog cover is a URL, never a
        // base64 blob the store card would carry megabytes of per listing.
        primary_comic: state.media.externalize(req.primary_comic).await?,
        template_summary: req.template_summary,
        snapshot_version: version,
        snapshot_id,
        // Normalize blank-string meta to None so the catalog omits the field
        // instead of rendering an empty pin/clock.
        city: req.city.filter(|s| !s.trim().is_empty()),
        duration: req.duration.filter(|s| !s.trim().is_empty()),
        price: req.price,
        description: req.description.filter(|s| !s.trim().is_empty()),
        pages,
        tasks,
        paid_hints,
        players_bonus: req.players_bonus.unwrap_or(0).max(0),
    };
    state
        .grants
        .register_published(&req.quest_id, meta, req.snapshot)
        .await?;
    // Reflect the publish in the constructor lifecycle: a quest tracked by the
    // dashboard flips to 'published'. Best-effort — a quest published straight
    // through the API (e.g. a seeded demo) simply has no constructor row.
    state
        .constructor
        .set_status(
            &req.quest_id,
            // No ownership was read to reach here — publish is gated on the
            // editor capability, not on the row.
            store::AuthorGuard::Unchecked,
            store::CTOR_STATUS_PUBLISHED,
            store::now_secs(),
        )
        .await?;
    Ok(Json(
        serde_json::json!({ "status": "published", "quest_id": req.quest_id }),
    ))
}

/// One dashboard list row.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "ConstructorQuestWire"))]
pub(crate) struct ConstructorQuestWire {
    quest_id: String,
    name: String,
    /// Display label of the author (denormalized at creation).
    author: String,
    author_id: String,
    #[cfg_attr(test, ts(type = "\"draft\" | \"test\" | \"published\""))]
    status: String,
    steps: u32,
    /// Distinct players who completed this quest (derived from the fact log).
    #[cfg_attr(test, ts(type = "number"))]
    completed: usize,
    /// Distinct grant holders — the honest «{N} купивших» for destructive
    /// status confirms (§9.1). Count only, no identities.
    #[cfg_attr(test, ts(type = "number"))]
    buyers: usize,
    /// Live published snapshot version, if any. None ⇒ the coherence guard will
    /// reject `test`/`published`, so the UI routes into the publish panel.
    published_version: Option<u32>,
    complexity: String,
    age_target: String,
    tags: Vec<String>,
    /// Media URL. Never a `data:` blob — those bloated the list by megabytes;
    /// every write externalizes ([`crate::media::MediaStores::externalize_tree`]).
    cover: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    created_at: u64,
    #[cfg_attr(test, ts(type = "number"))]
    updated_at: u64,
}

/// A single quest with its full editable body (for opening in the builder).
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "ConstructorQuestFullWire"))]
pub(crate) struct ConstructorQuestFullWire {
    quest_id: String,
    name: String,
    author: String,
    author_id: String,
    #[cfg_attr(test, ts(type = "\"draft\" | \"test\" | \"published\""))]
    status: String,
    steps: u32,
    #[cfg_attr(test, ts(type = "number"))]
    completed: usize,
    cover: Option<String>,
    complexity: String,
    age_target: String,
    tags: Vec<String>,
    #[cfg_attr(test, ts(type = "number"))]
    created_at: u64,
    #[cfg_attr(test, ts(type = "number"))]
    updated_at: u64,
    #[cfg_attr(test, ts(type = "unknown"))]
    body: serde_json::Value,
}

fn ctor_wire(
    s: ConstructorQuestSummary,
    completed: usize,
    buyers: usize,
    published_version: Option<u32>,
) -> ConstructorQuestWire {
    ConstructorQuestWire {
        quest_id: s.quest_id,
        name: s.name,
        author: s.author_name,
        author_id: s.author_id,
        status: s.status,
        steps: s.steps_count,
        completed,
        buyers,
        published_version,
        complexity: s.attrs.complexity,
        age_target: s.attrs.age_target,
        tags: s.attrs.tags,
        cover: s.cover,
        created_at: s.created_at,
        updated_at: s.updated_at,
    }
}

/// The list row for ONE quest: the three live figures [`ctor_wire`] folds in are
/// projections over three different tables, keyed only by `quest_id`, so they run
/// concurrently — one round trip, not three. Every single-quest route answers
/// through here, so a new column is added in one place instead of three.
async fn ctor_row(
    state: &AppState,
    summary: ConstructorQuestSummary,
) -> Result<ConstructorQuestWire, AppError> {
    let (completed, buyers, published) = tokio::try_join!(
        state.store.completions_for_quest(&summary.quest_id),
        state.grants.buyers_for_quest(&summary.quest_id),
        state.grants.get_published(&summary.quest_id),
    )?;
    Ok(ctor_wire(
        summary,
        completed,
        buyers,
        published.map(|m| m.snapshot_version),
    ))
}

async fn list_constructor_quests_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ConstructorQuestWire>>, AppError> {
    // Editors get a personal workspace: ONLY their own quests (the reported bug was
    // every editor seeing everyone's). An ADMIN is the superuser and sees every
    // author's quest so it can manage any of them. The id is the same one creation
    // stamps, so a non-admin always sees exactly what they made.
    let actor = require_editor_actor(&state, &headers).await?;
    let summaries = if actor.is_admin {
        state.constructor.list_all_summaries().await?
    } else {
        state
            .constructor
            .list_summaries_for_author(&actor.author_id)
            .await?
    };
    let completions = state.store.completions_by_quest().await?;
    let buyers = state.grants.buyers_by_quest().await?;
    let published_versions: std::collections::HashMap<String, u32> = state
        .grants
        .list_published()
        .await?
        .into_iter()
        .map(|m| (m.quest_id, m.snapshot_version))
        .collect();
    Ok(Json(
        summaries
            .into_iter()
            .map(|s| {
                let c = completions.get(&s.quest_id).copied().unwrap_or(0);
                let b = buyers.get(&s.quest_id).copied().unwrap_or(0);
                let v = published_versions.get(&s.quest_id).copied();
                ctor_wire(s, c, b, v)
            })
            .collect(),
    ))
}

async fn get_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<ConstructorQuestFullWire>, AppError> {
    let q = require_owned_constructor_quest(&state, &headers, &quest_id).await?;
    let completed = state.store.completions_for_quest(&q.quest_id).await?;
    Ok(Json(ConstructorQuestFullWire {
        quest_id: q.quest_id,
        name: q.name,
        author: q.author_name,
        author_id: q.author_id,
        status: q.status,
        steps: q.steps_count,
        completed,
        cover: q.cover,
        complexity: q.attrs.complexity,
        age_target: q.attrs.age_target,
        tags: q.attrs.tags,
        created_at: q.created_at,
        updated_at: q.updated_at,
        body: q.body,
    }))
}

/// GET /api/constructor/quests/{quest_id}/export — the full quest as a
/// downloadable zip: quest record (all steps, attributes, cover — media URLs
/// rewritten to point into the archive) and the media files themselves.
/// Content only — play/rating stats are live projections, not quest content.
/// Owner-or-admin gated, same as every other per-quest constructor route.
async fn export_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let quest = require_owned_constructor_quest(&state, &headers, &quest_id).await?;
    let filename = format!("quest-{}.zip", quest.quest_id);
    let zip_bytes = export::build_quest_export_zip(&state.media, quest).await?;

    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(axum::body::Body::from(zip_bytes))
        .map_err(|e| AppError::Internal(anyhow::anyhow!("export response build: {e}")))
}

/// Body for POST /api/constructor/quests. The client mints the id (the same id
/// publish later binds), so it is required here.
#[derive(serde::Deserialize)]
struct CreateConstructorQuestRequest {
    quest_id: String,
    name: String,
    cover: Option<String>,
    steps_count: u32,
    /// Attributes are optional on the wire (old clients omit them) and fall back
    /// to the neutral defaults; present values must belong to the closed sets.
    complexity: Option<String>,
    age_target: Option<String>,
    tags: Option<Vec<String>>,
    body: serde_json::Value,
}

async fn create_constructor_quest_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut req): Json<CreateConstructorQuestRequest>,
) -> Result<Json<ConstructorQuestWire>, AppError> {
    let actor = require_editor_actor(&state, &headers).await?;
    if req.quest_id.trim().is_empty() {
        return Err(AppError::BadRequest("quest_id is required".into()));
    }
    let attrs = store::QuestAttributes::from_wire(req.complexity, req.age_target, req.tags)?;
    state.media.externalize_tree(&mut req.body).await?;
    let cover = state.media.externalize(req.cover).await?;
    let now = store::now_secs();
    let quest = ConstructorQuest {
        quest_id: req.quest_id,
        author_id: actor.author_id,
        author_name: actor.author_name,
        name: req.name,
        status: store::CTOR_STATUS_DRAFT.to_string(),
        cover,
        steps_count: req.steps_count,
        attrs,
        created_at: now,
        updated_at: now,
        body: req.body,
    };
    let summary = state.constructor.create(quest).await?;
    // A freshly created id can still carry a stale published row and old grants
    // (a re-created id); report them honestly rather than assuming zero.
    Ok(Json(ctor_row(&state, summary).await?))
}

/// Body for POST /api/constructor/quests/{id}/save (autosave).
#[derive(serde::Deserialize)]
struct SaveConstructorQuestRequest {
    name: String,
    cover: Option<String>,
    steps_count: u32,
    /// Same optional-with-defaults contract as on create.
    complexity: Option<String>,
    age_target: Option<String>,
    tags: Option<Vec<String>>,
    body: serde_json::Value,
}

async fn save_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Json(mut req): Json<SaveConstructorQuestRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let gated = require_owned_constructor_summary(&state, &headers, &quest_id).await?;
    let attrs = store::QuestAttributes::from_wire(req.complexity, req.age_target, req.tags)?;
    // A legacy body re-saved by the editor arrives with its pictures inside it;
    // they are ingested here so what lands in the row is references. The cover
    // column is normalized the same way and echoed back — the editor adopts it,
    // so the NEXT autosave carries a URL instead of re-shipping megabytes of
    // base64 on every keystroke pause.
    state.media.externalize_tree(&mut req.body).await?;
    let cover = state.media.externalize(req.cover).await?;
    let now = store::now_secs();
    let s = state
        .constructor
        .save_body(
            &quest_id,
            store::AuthorGuard::Is(&gated.author_id),
            &req.name,
            cover.clone(),
            req.steps_count,
            attrs,
            req.body,
            now,
        )
        .await?;
    Ok(Json(
        serde_json::json!({ "status": "saved", "quest_id": s.quest_id, "updated_at": s.updated_at, "cover": cover }),
    ))
}

/// Body for POST /api/constructor/quests/{id}/status.
#[derive(serde::Deserialize)]
struct SetConstructorStatusRequest {
    status: String,
}

async fn set_constructor_status_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetConstructorStatusRequest>,
) -> Result<Json<ConstructorQuestWire>, AppError> {
    let gated = require_owned_constructor_summary(&state, &headers, &quest_id).await?;
    store::validate_ctor_status(&req.status)?;
    // Coherence invariant: a quest can be `test` or `published` ONLY once a frozen
    // snapshot exists (created by the gated Publish in the editor). Without this, a
    // bare status flip could claim the quest is live while nothing is playable or
    // sellable — and because the store lists `status == published`, the author would
    // get a quest stuck at "published but never in the store" (the reported bug).
    // `draft` (delist / park) is always allowed. publish_quest_handler sets the
    // status directly AFTER registering the snapshot, so it is unaffected by this.
    let published_version = state
        .grants
        .get_published(&quest_id)
        .await?
        .map(|m| m.snapshot_version);
    if req.status != store::CTOR_STATUS_DRAFT && published_version.is_none() {
        return Err(AppError::BadRequest(
            "publish a version in the editor before marking the quest as «test» or «published»"
                .into(),
        ));
    }
    let now = store::now_secs();
    let updated = state
        .constructor
        .set_status(
            &quest_id,
            store::AuthorGuard::Is(&gated.author_id),
            &req.status,
            now,
        )
        .await?
        .ok_or_else(|| AppError::NotFound(format!("constructor quest '{quest_id}' not found")))?;
    Ok(Json(ctor_row(&state, updated).await?))
}

/// One account a quest may be handed to.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "ConstructorAuthorWire"))]
pub(crate) struct ConstructorAuthorWire {
    user_id: String,
    /// The label the quest row will carry once it moves here.
    name: String,
    #[cfg_attr(test, ts(type = "\"admin\" | \"editor\""))]
    role: String,
}

/// GET /api/constructor/authors — who a quest may be transferred to: the accounts
/// that can author one ([`auth::role_can_author`]), admins first then editors,
/// alphabetical within a role. Admin-gated: this is the account registry, and the
/// transfer it feeds is an admin decision.
async fn list_authors_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ConstructorAuthorWire>>, AppError> {
    require_constructor_admin(&state, &headers).await?;
    let mut authors: Vec<ConstructorAuthorWire> = state
        .auth
        .list_users_with_roles(auth::AUTHOR_ROLES)
        .await?
        .into_iter()
        .map(|u| ConstructorAuthorWire {
            name: u.author_label(),
            user_id: u.user_id,
            role: u.role,
        })
        .collect();
    // Admins first, then by name — `auth::ROLES` is the one place display order
    // for a role is decided.
    let rank = |r: &str| auth::ROLES.iter().position(|known| *known == r);
    authors.sort_by(|a, b| (rank(&a.role), &a.name).cmp(&(rank(&b.role), &b.name)));
    Ok(Json(authors))
}

/// Body for POST /api/constructor/quests/{id}/author.
#[derive(serde::Deserialize)]
struct SetConstructorAuthorRequest {
    author_id: String,
}

/// POST /api/constructor/quests/{id}/author — hand the quest to another author.
///
/// Admin-only, because it is a change of access, not of content: the previous
/// author loses the quest outright. The target must be an account that can author
/// quests — handing one to a player would strand it where nobody may edit it.
/// Idempotent: transferring to the current owner is a no-op that still answers OK.
async fn set_constructor_author_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetConstructorAuthorRequest>,
) -> Result<Json<ConstructorQuestWire>, AppError> {
    require_constructor_admin(&state, &headers).await?;
    let target = state
        .auth
        .get_user(&req.author_id)
        .await?
        .filter(|u| auth::role_can_author(&u.role))
        .ok_or_else(|| {
            AppError::BadRequest(
                "the new author must be a registered editor or administrator".into(),
            )
        })?;
    let updated = state
        .constructor
        .set_author(
            &quest_id,
            &target.user_id,
            &target.author_label(),
            store::now_secs(),
        )
        .await?
        .ok_or_else(|| AppError::NotFound(format!("constructor quest '{quest_id}' not found")))?;
    Ok(Json(ctor_row(&state, updated).await?))
}

/// Deleting a quest takes it off sale too. The store lists a published quest with
/// NO constructor row as published (the path for quests published straight
/// through the API), so dropping only the constructor row left a deleted quest
/// on sale for good, with nothing left in the editor to hide it. The listing goes
/// FIRST: should the row delete then fail, the quest is merely hidden and still
/// on the dashboard — the reverse order would mint exactly that orphan. Buyers
/// lose access (the owner's decision); frozen snapshots, grants, attempts and
/// facts stay, so played history and balances are untouched.
async fn delete_constructor_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let gated = require_owned_constructor_summary(&state, &headers, &quest_id).await?;
    state.grants.unpublish(&quest_id).await?;
    if !state
        .constructor
        .delete(&quest_id, store::AuthorGuard::Is(&gated.author_id))
        .await?
    {
        return Err(AppError::NotFound(format!(
            "constructor quest '{quest_id}' not found"
        )));
    }
    Ok(Json(
        serde_json::json!({ "status": "deleted", "quest_id": quest_id }),
    ))
}
