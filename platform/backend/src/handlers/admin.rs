//! Admin routes: users/roles, coupons CRUD, feature toggles + runtime settings,
//! stats, moderation (reviews/feedback), and the ops-token trio (legacy
//! migration + per-version stats/feedbacks).

use axum::{
    Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
    routing::{get, post},
};

use crate::authz::{require_admin_actor, require_ops_token};
use crate::coupons::{self, Coupon, CouponUsage, Discount};
use crate::errors::AppError;
use crate::facts::{self, MigrationResult};
use crate::features::Feature;
use crate::settings::Setting;
use crate::store::PublishedMeta;
use crate::{AppState, admin_stats, auth, feature_available, store};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/coupons",
            get(list_coupons_handler).post(create_coupon_handler),
        )
        .route("/api/admin/coupons/{coupon_id}", get(get_coupon_handler))
        .route(
            "/api/admin/coupons/{coupon_id}/save",
            post(save_coupon_handler),
        )
        .route(
            "/api/admin/coupons/{coupon_id}/delete",
            post(delete_coupon_handler),
        )
        .route(
            "/api/admin/versions/{snapshot_id}/stats",
            get(get_version_stats_handler),
        )
        .route(
            "/api/admin/versions/{snapshot_id}/feedbacks",
            get(get_version_feedbacks_handler),
        )
        .route("/api/admin/reviews", get(admin_list_reviews_handler))
        .route("/api/admin/reviews/hide", post(admin_hide_review_handler))
        .route(
            "/api/admin/reviews/unhide",
            post(admin_unhide_review_handler),
        )
        .route("/api/admin/feedback", get(admin_list_feedback_handler))
        .route(
            "/api/admin/feedback/resolve",
            post(admin_resolve_feedback_handler),
        )
        .route(
            "/api/admin/feedback/reopen",
            post(admin_reopen_feedback_handler),
        )
        .route("/api/admin/users", get(list_users_handler))
        .route(
            "/api/admin/users/{user_id}/role",
            post(set_user_role_handler),
        )
        .route("/api/admin/features", get(list_features_handler))
        .route("/api/admin/features/{key}", post(set_feature_handler))
        .route(
            "/api/admin/settings/{key}",
            get(get_setting_handler).post(set_setting_handler),
        )
        .route("/api/admin/stats", get(admin_stats_overview_handler))
        .route(
            "/api/admin/stats/{quest_id}",
            get(admin_stats_quest_handler),
        )
        .route("/api/migrate/legacy", post(run_migration_handler))
}

async fn get_version_stats_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(snapshot_id): Path<String>,
) -> Result<Json<facts::PerVersionStats>, AppError> {
    require_ops_token(&state, &headers)?;
    let grants_count = state.grants.list_all_grants().await?.len();
    Ok(Json(
        state
            .store
            .get_version_stats(&snapshot_id, grants_count)
            .await?,
    ))
}

async fn get_version_feedbacks_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(snapshot_id): Path<String>,
) -> Result<Json<Vec<facts::Fact>>, AppError> {
    require_ops_token(&state, &headers)?;
    Ok(Json(
        state.store.list_feedbacks_for_version(&snapshot_id).await?,
    ))
}

/// Resolved author identity for an admin surface: a display name, a provider
/// `kind`, and a single reachable contact — email (`mailto:`) for an email/Google
/// account, a Telegram `@username` (`t.me/…`) otherwise. Anonymous players (no
/// account row) carry no contact.
#[derive(serde::Serialize, Clone)]
struct AdminIdentityWire {
    user_id: String,
    display_name: Option<String>,
    /// "google" | "telegram" | "email" | "anon".
    kind: &'static str,
    /// Present (for `mailto:`) only when `kind` is google/email.
    email: Option<String>,
    /// Present (for `t.me/<username>`) only when `kind` is telegram with a handle.
    telegram_username: Option<String>,
}

/// Resolve one player to an admin identity from a PRE-FETCHED account + its linked
/// identities (batched by the caller — never a per-row store hit). `kind` priority:
/// google > email > telegram > anon, arranged so a google/email kind always has an
/// email and a telegram kind never does — keeping the single contact unambiguous.
fn resolve_admin_identity(
    user_id: &str,
    account: Option<&auth::UserAccount>,
    identities: &[store::AuthIdentity],
) -> AdminIdentityWire {
    let has_google = identities.iter().any(|i| i.method == auth::PROVIDER_GOOGLE);
    let telegram = identities
        .iter()
        .find(|i| i.method == auth::PROVIDER_TELEGRAM);
    let email = account.and_then(|a| a.email.clone());
    // One chain co-locates each kind with the single contact it surfaces, so a
    // newly added kind can never silently fall through to "no contact".
    let (kind, email, telegram_username) = if has_google && email.is_some() {
        ("google", email, None)
    } else if email.is_some() {
        ("email", email, None)
    } else if let Some(tg) = telegram {
        ("telegram", None, tg.handle.clone())
    } else {
        ("anon", None, None)
    };
    AdminIdentityWire {
        user_id: user_id.to_string(),
        display_name: account.and_then(|a| a.display_name.clone()),
        kind,
        email,
        telegram_username,
    }
}

/// Resolve every quest's label, and hand back the listings the caller may also
/// need. THE entry point for naming a quest on an internal surface.
///
/// Which registries feed a label is decided here, once. A surface that reached
/// for `labels_by_quest()` alone would compile and read fine while silently
/// dropping the listing fallback — reintroducing, for legacy/direct publishes,
/// exactly the raw-id defect this seam exists to remove. The two reads are
/// independent, so they run concurrently; callers may nest this inside a wider
/// `tokio::join!` and keep their own concurrency.
async fn resolve_quest_labels(
    state: &AppState,
) -> Result<(store::QuestLabels, Vec<PublishedMeta>), AppError> {
    let (authored, published) = tokio::join!(
        state.constructor.labels_by_quest(),
        state.grants.list_published(),
    );
    let published = published?;
    Ok((
        store::QuestLabels::resolve(authored?, &published),
        published,
    ))
}

/// Batch-resolve identities for many players in exactly two store reads (accounts +
/// linked identities) — never an N+1. Returns `user_id -> identity`.
async fn resolve_admin_identities(
    state: &AppState,
    user_ids: &[String],
) -> Result<std::collections::HashMap<String, AdminIdentityWire>, AppError> {
    // Independent reads over the same ids — run concurrently (one RTT, not two).
    let (accounts, identities) = tokio::join!(
        state.auth.get_users_by_ids(user_ids),
        state.auth.identities_for_users(user_ids),
    );
    let accounts = accounts?;
    let identities = identities?;
    let empty: Vec<store::AuthIdentity> = Vec::new();
    Ok(user_ids
        .iter()
        .map(|pid| {
            let wire = resolve_admin_identity(
                pid,
                accounts.get(pid),
                identities.get(pid).unwrap_or(&empty),
            );
            (pid.clone(), wire)
        })
        .collect())
}

// ==================== Content moderation (Отзывы + Обратная связь) ====================
// Two admin-only surfaces over the immutable facts: a global reviews list with a
// per-(player,quest) hide, and a global feedback inbox grouped by (quest, version,
// step) with an open/resolved watermark. All gated by `require_admin_actor`; the
// read-side folds live in `facts` + `store` and never mutate a fact.

/// One row of the global reviews list: an effective per-`(player, quest)` rating
/// (star-only included), whether it is hidden, and the resolved author identity.
#[derive(serde::Serialize)]
struct AdminReviewWire {
    quest_id: String,
    quest_name: String,
    quest_city: Option<String>,
    rating: i64,
    /// `None` for a star-only rating (counts toward the average, no text).
    text: Option<String>,
    created_at: u64,
    hidden: bool,
    identity: AdminIdentityWire,
}

#[derive(serde::Serialize)]
struct AdminReviewsResponse {
    reviews: Vec<AdminReviewWire>,
}

async fn admin_list_reviews_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminReviewsResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    // Independent reads — the fold rows, the hidden set, and the quest labels —
    // run concurrently.
    let (rows, hidden, labels) = tokio::join!(
        state.store.quest_rating_rows(None),
        state.moderation.hidden_review_keys(),
        resolve_quest_labels(&state),
    );
    let rows = rows?;
    let hidden = hidden?;
    let (labels, _) = labels?;
    let user_ids: Vec<String> = rows.iter().map(|r| r.user_id.clone()).collect();
    let identities = resolve_admin_identities(&state, &user_ids).await?;
    let mut reviews: Vec<AdminReviewWire> = rows
        .into_iter()
        .map(|r| {
            let is_hidden = hidden.contains(&(r.user_id.clone(), r.quest_id.clone()));
            let label = labels.get(&r.quest_id);
            let identity = identities
                .get(&r.user_id)
                .cloned()
                .unwrap_or_else(|| resolve_admin_identity(&r.user_id, None, &[]));
            AdminReviewWire {
                quest_name: label.name,
                quest_city: label.city,
                quest_id: r.quest_id,
                rating: r.rating,
                text: r.text,
                created_at: r.created_at,
                hidden: is_hidden,
                identity,
            }
        })
        .collect();
    // Worst-first, then newest — the design's default moderation order.
    reviews.sort_by(|a, b| {
        a.rating
            .cmp(&b.rating)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
    Ok(Json(AdminReviewsResponse { reviews }))
}

/// Body for hide/unhide — the `(player, quest)` the moderation decision keys on.
#[derive(serde::Deserialize)]
struct ReviewHideRequest {
    user_id: String,
    quest_id: String,
}

async fn admin_hide_review_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ReviewHideRequest>,
) -> Result<StatusCode, AppError> {
    let actor = require_admin_actor(&state, &headers).await?;
    let by = actor.user_id.unwrap_or_else(|| "ops-token".to_string());
    state
        .moderation
        .hide_review(&req.user_id, &req.quest_id, store::now_secs(), &by)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn admin_unhide_review_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ReviewHideRequest>,
) -> Result<StatusCode, AppError> {
    require_admin_actor(&state, &headers).await?;
    state
        .moderation
        .unhide_review(&req.user_id, &req.quest_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// One report inside a feedback group — its note, server time, and author identity.
#[derive(serde::Serialize)]
struct AdminReportWire {
    note: String,
    recorded_at: u64,
    identity: AdminIdentityWire,
}

/// A feedback group `(quest, snapshot, step)` with its resolution status, the frozen
/// step label, its human version number, whether it is the current version, and its
/// reports newest-first.
#[derive(serde::Serialize)]
struct AdminFeedbackGroupWire {
    quest_id: String,
    quest_name: String,
    quest_city: Option<String>,
    snapshot_id: String,
    version: Option<u32>,
    step_position: i32,
    step_title: Option<String>,
    step_template: Option<String>,
    current: bool,
    resolved: bool,
    reports: Vec<AdminReportWire>,
}

#[derive(serde::Serialize)]
struct AdminFeedbackResponse {
    groups: Vec<AdminFeedbackGroupWire>,
}

async fn admin_list_feedback_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminFeedbackResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    // Independent reads — reports, resolutions, and the quest labels — run
    // concurrently.
    let (reports, resolutions, labels) = tokio::join!(
        state.store.all_feedback_reports(),
        state.moderation.feedback_resolutions(),
        resolve_quest_labels(&state),
    );
    let core = facts::group_feedback(reports?, &resolutions?);
    let (labels, published) = labels?;
    // Which snapshot each quest is serving RIGHT NOW — the only thing this view
    // legitimately asks the marketplace listing, since `current` is a statement
    // about the published version, not about the quest.
    let current_snapshot: std::collections::HashMap<&str, &str> = published
        .iter()
        .map(|m| (m.quest_id.as_str(), m.snapshot_id.as_str()))
        .collect();
    // Identities in one batch across every report.
    let user_ids: Vec<String> = core
        .iter()
        .flat_map(|g| g.reports.iter().map(|r| r.user_id.clone()))
        .collect();
    let identities = resolve_admin_identities(&state, &user_ids).await?;
    // Frozen snapshot JSON per DISTINCT snapshot (for version + step labels).
    let mut snapshots: std::collections::HashMap<String, Option<serde_json::Value>> =
        std::collections::HashMap::new();
    for g in &core {
        if !snapshots.contains_key(&g.snapshot_id) {
            let snap = state.grants.get_snapshot(&g.snapshot_id).await?;
            snapshots.insert(g.snapshot_id.clone(), snap);
        }
    }

    let groups = core
        .into_iter()
        .map(|g| {
            let label = labels.get(&g.quest_id);
            let current =
                current_snapshot.get(g.quest_id.as_str()) == Some(&g.snapshot_id.as_str());
            let snap = snapshots.get(&g.snapshot_id).and_then(|o| o.as_ref());
            let version = snap
                .and_then(|s| s.get("snapshot_version"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let steps = snap.map(admin_stats::snapshot_steps).unwrap_or_default();
            let (step_title, step_template) = usize::try_from(g.step_position)
                .ok()
                .and_then(|i| steps.get(i))
                .map(|(t, tmpl)| (Some(t.clone()), Some(tmpl.clone())))
                .unwrap_or((None, None));
            let reports = g
                .reports
                .into_iter()
                .map(|r| AdminReportWire {
                    note: r.note,
                    recorded_at: r.recorded_at,
                    identity: identities
                        .get(&r.user_id)
                        .cloned()
                        .unwrap_or_else(|| resolve_admin_identity(&r.user_id, None, &[])),
                })
                .collect();
            AdminFeedbackGroupWire {
                quest_name: label.name,
                quest_city: label.city,
                quest_id: g.quest_id,
                snapshot_id: g.snapshot_id,
                version,
                step_position: g.step_position,
                step_title,
                step_template,
                current,
                resolved: g.resolved,
                reports,
            }
        })
        .collect();
    Ok(Json(AdminFeedbackResponse { groups }))
}

/// Body for resolve/reopen — the `(quest, snapshot, step)` group key.
#[derive(serde::Deserialize)]
struct FeedbackResolveRequest {
    quest_id: String,
    snapshot_id: String,
    step_position: i32,
}

async fn admin_resolve_feedback_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<FeedbackResolveRequest>,
) -> Result<StatusCode, AppError> {
    let actor = require_admin_actor(&state, &headers).await?;
    let by = actor.user_id.unwrap_or_else(|| "ops-token".to_string());
    // Acknowledge exactly the reports currently in this (quest, snapshot, step)
    // group; a later report grows the count past this watermark and reopens it.
    let acknowledged = state
        .store
        .all_feedback_reports()
        .await?
        .into_iter()
        .filter(|r| {
            r.quest_id == req.quest_id
                && r.snapshot_id == req.snapshot_id
                && r.step_position == req.step_position
        })
        .count() as u64;
    state
        .moderation
        .resolve_feedback(
            &req.quest_id,
            &req.snapshot_id,
            req.step_position,
            acknowledged,
            &by,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn admin_reopen_feedback_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<FeedbackResolveRequest>,
) -> Result<StatusCode, AppError> {
    require_admin_actor(&state, &headers).await?;
    state
        .moderation
        .reopen_feedback(&req.quest_id, &req.snapshot_id, req.step_position)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
struct MigrateRequest {
    historical_grants: Option<Vec<serde_json::Value>>,
    answer_cards: Option<Vec<serde_json::Value>>,
    key: Option<String>,
}

async fn run_migration_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<MigrateRequest>,
) -> Result<Json<MigrationResult>, AppError> {
    require_ops_token(&state, &headers)?;
    let res = state
        .store
        .run_legacy_migration(
            req.historical_grants.unwrap_or_default(),
            req.answer_cards.unwrap_or_default(),
            &req.key.unwrap_or_else(|| "phase4-legacy:default".into()),
        )
        .await?;
    Ok(Json(res))
}

/// One registered account as served by the admin user list (admin-users spec).
/// Carries the public identity, role and registration time — never the password
/// hash or session tokens. The backend does not model telegram/phone, so the UI
/// renders contact fields present-only and simply omits the ones it has no data for.
#[derive(serde::Serialize)]
struct AdminUserWire {
    user_id: String,
    /// `null` for a social-only account (no login email).
    email: Option<String>,
    display_name: Option<String>,
    role: String,
    created_at: u64,
}

impl From<auth::UserAccount> for AdminUserWire {
    fn from(a: auth::UserAccount) -> Self {
        Self {
            user_id: a.user_id,
            email: a.email,
            display_name: a.display_name,
            role: a.role,
            created_at: a.created_at,
        }
    }
}

/// Body for POST /api/admin/users/{user_id}/role.
#[derive(serde::Deserialize)]
struct SetRoleRequest {
    role: String,
}

/// Admin user list: every registered account, newest registration first. Admin-gated
/// (session-admin or the shared `ADMIN_TOKEN`). Anonymous devices have no account row,
/// so only real accounts appear — bounded by the number of registrations.
/// Query for GET /api/admin/users: `?page=1` (1-based) opts into pagination
/// (§10.2 — 25 per page, newest first); without it the legacy full array is
/// returned so older clients keep working.
#[derive(serde::Deserialize)]
struct ListUsersQuery {
    page: Option<u32>,
}

const ADMIN_USERS_PER_PAGE: usize = 25;

async fn list_users_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<ListUsersQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let users = state.auth.list_users().await?;
    match q.page {
        None => Ok(Json(serde_json::json!(
            users
                .into_iter()
                .map(AdminUserWire::from)
                .collect::<Vec<_>>()
        ))),
        Some(page) => {
            let page = page.max(1) as usize;
            let total = users.len();
            let start = (page - 1) * ADMIN_USERS_PER_PAGE;
            let slice: Vec<AdminUserWire> = users
                .into_iter()
                .skip(start)
                .take(ADMIN_USERS_PER_PAGE)
                .map(AdminUserWire::from)
                .collect();
            Ok(Json(serde_json::json!({
                "users": slice,
                "total": total,
                "page": page,
                "per_page": ADMIN_USERS_PER_PAGE,
            })))
        }
    }
}

/// Assign a role to a registered account. Admin-gated, with three guards:
///   * an unknown role value → 400 ([`auth::validate_role`]);
///   * a session-admin changing THEIR OWN role → 409 (prevents accidental
///     self-lockout; the shared-secret ops path has no "self" and is exempt, so it
///     can still recover any state);
///   * an unknown/anonymous id → 404 (only registered accounts have a role).
async fn set_user_role_handler(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetRoleRequest>,
) -> Result<Json<AdminUserWire>, AppError> {
    let actor = require_admin_actor(&state, &headers).await?;
    auth::validate_role(&req.role)?;
    if actor.user_id.as_deref() == Some(user_id.as_str()) {
        return Err(AppError::Conflict(
            "an admin cannot change their own role".into(),
        ));
    }
    let updated = state.auth.set_role(&user_id, &req.role).await?;
    Ok(Json(updated.into()))
}

/// One feature-toggle row for the admin panel: the registry facts (key,
/// default) plus the runtime state (override, effective toggle) and whether
/// the deployment is configured for it at all.
#[derive(serde::Serialize)]
struct FeatureWire {
    key: &'static str,
    default_enabled: bool,
    /// The stored admin override; `null` = the code default applies.
    #[serde(rename = "override")]
    override_enabled: Option<bool>,
    /// The toggle verdict (`override ?? default`) — what the gated endpoints
    /// enforce. Independent of `available`.
    effective: bool,
    /// Capability: credentials configured. `effective && !available` means the
    /// switch is on but the feature is inert on this deployment.
    available: bool,
}

/// Assemble one wire row from an already-fetched override (callers own the
/// store read: the list handler fetches all overrides once, the mutation
/// already holds the value it just wrote).
fn feature_wire(state: &AppState, feature: Feature, override_enabled: Option<bool>) -> FeatureWire {
    FeatureWire {
        key: feature.key(),
        default_enabled: feature.default_enabled(),
        override_enabled,
        effective: feature.effective(override_enabled),
        available: feature_available(state, feature),
    }
}

/// GET /api/admin/features — every registered feature with its runtime state.
async fn list_features_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<FeatureWire>>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let overrides = state.flags.all().await?;
    let rows = Feature::ALL
        .into_iter()
        .map(|f| feature_wire(&state, f, overrides.get(f.key()).copied()))
        .collect();
    Ok(Json(rows))
}

/// Body for the feature-toggle mutation: `enabled: true|false` stores an
/// override, `enabled: null` clears it (back to the code default).
#[derive(serde::Deserialize)]
struct SetFeatureRequest {
    enabled: Option<bool>,
}

/// POST /api/admin/features/{key} — set or clear a feature override. Unknown
/// keys are 404 (the registry lives in code; nothing to create).
async fn set_feature_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetFeatureRequest>,
) -> Result<Json<FeatureWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let feature = Feature::parse(&key)
        .ok_or_else(|| AppError::NotFound(format!("unknown feature: {key}")))?;
    match req.enabled {
        Some(enabled) => state.flags.set(feature.key(), enabled).await?,
        None => state.flags.clear(feature.key()).await?,
    }
    Ok(Json(feature_wire(&state, feature, req.enabled)))
}

/// Wire shape of a runtime setting: its stable key and the stored value
/// (`null` = unset — settings have no default values).
#[derive(serde::Serialize)]
struct SettingWire {
    key: &'static str,
    value: Option<String>,
}

/// GET /api/admin/settings/{key} — the stored value of one registered setting.
/// Unknown keys are 404 (the registry lives in code; nothing to create).
async fn get_setting_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Result<Json<SettingWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let setting = Setting::parse(&key)
        .ok_or_else(|| AppError::NotFound(format!("unknown setting: {key}")))?;
    let value = state.settings.get(setting.key()).await?;
    Ok(Json(SettingWire {
        key: setting.key(),
        value,
    }))
}

/// Body for the setting mutation. The write is normalized by
/// [`Setting::normalize`]: the value is trimmed, and `null`/empty clears the
/// row — "unset" has exactly one representation.
#[derive(serde::Deserialize)]
struct SetSettingRequest {
    value: Option<String>,
}

/// POST /api/admin/settings/{key} — set or clear a setting value. Unknown
/// keys are 404, like the feature-toggle mutation.
async fn set_setting_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetSettingRequest>,
) -> Result<Json<SettingWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let setting = Setting::parse(&key)
        .ok_or_else(|| AppError::NotFound(format!("unknown setting: {key}")))?;
    let value = Setting::normalize(req.value.as_deref());
    match &value {
        Some(v) => state.settings.set(setting.key(), v.clone()).await?,
        None => state.settings.clear(setting.key()).await?,
    }
    Ok(Json(SettingWire {
        key: setting.key(),
        value,
    }))
}

/// Query for the admin statistics endpoints: an inclusive UTC day range.
/// Both bounds optional — `to` defaults to today, absent `from` means
/// «Всё время» (left bound = earliest recorded event, no previous-period
/// comparison).
#[derive(serde::Deserialize)]
struct StatsRangeQuery {
    from: Option<String>,
    to: Option<String>,
}

/// Resolve the requested range and load the three event streams behind it.
///
/// Bounded requests load one window covering the previous period too (the
/// folds re-filter, so one load serves both totals). Unbounded («Всё время»)
/// requests load everything up to `to` and anchor the range at the earliest
/// event of `quest` (or of any quest for the overview).
async fn load_stats_window(
    state: &AppState,
    q: &StatsRangeQuery,
    quest: Option<&str>,
) -> Result<(admin_stats::DayRange, bool, admin_stats::StatsEvents), AppError> {
    let bad_day = |field: &str| {
        AppError::BadRequest(format!("некорректная дата {field}: ожидается ГГГГ-ММ-ДД"))
    };
    let to_day = match &q.to {
        Some(t) => {
            admin_stats::parse_day(t).ok_or_else(|| bad_day("to"))?;
            t.clone()
        }
        None => store::today_utc(),
    };
    let load = |from_secs: i64, to_secs_excl: i64| async move {
        let (purchases, starts, finishes) = tokio::try_join!(
            state
                .grants
                .stats_purchase_events(from_secs, to_secs_excl, quest),
            state
                .store
                .stats_start_events(from_secs, to_secs_excl, quest),
            state
                .store
                .stats_finish_events(from_secs, to_secs_excl, quest),
        )?;
        Ok::<_, AppError>(admin_stats::StatsEvents {
            purchases,
            starts,
            finishes,
        })
    };
    match &q.from {
        Some(from_day) => {
            admin_stats::parse_day(from_day).ok_or_else(|| bad_day("from"))?;
            let range = admin_stats::DayRange::new(from_day, &to_day).ok_or_else(|| {
                AppError::BadRequest("начало периода позже его конца".to_string())
            })?;
            let ev = load(range.prev().start_secs(), range.end_secs_excl()).await?;
            Ok((range, true, ev))
        }
        None => {
            let to_excl = admin_stats::parse_day(&to_day).ok_or_else(|| bad_day("to"))? + 86_400;
            let ev = load(0, to_excl).await?;
            let from_day =
                admin_stats::earliest_event_day(&ev, quest).unwrap_or_else(|| to_day.clone());
            // Defensive min: an event later than `to` must not invert the range.
            let from_day = if from_day.as_str() <= to_day.as_str() {
                from_day
            } else {
                to_day.clone()
            };
            let range = admin_stats::DayRange::new(&from_day, &to_day)
                .ok_or_else(|| AppError::Internal(anyhow::anyhow!("all-time range invariant")))?;
            Ok((range, false, ev))
        }
    }
}

/// GET /api/admin/stats — the admin analytics overview: KPI totals (+ previous
/// same-length window for bounded ranges), a zero-filled daily trend, and the
/// per-quest table over every published quest.
async fn admin_stats_overview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StatsRangeQuery>,
) -> Result<Json<admin_stats::OverviewResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let (range, with_prev, ev) = load_stats_window(&state, &q, None).await?;
    let (labels, metas) = resolve_quest_labels(&state).await?;
    Ok(Json(admin_stats::project_overview(
        &metas, &labels, &ev, &range, with_prev,
    )))
}

/// GET /api/admin/stats/{quest_id} — per-quest KPIs plus the step funnel over
/// the CURRENT published snapshot (labels are frozen per version).
async fn admin_stats_quest_handler(
    State(state): State<AppState>,
    Path(quest_id): Path<String>,
    headers: HeaderMap,
    Query(q): Query<StatsRangeQuery>,
) -> Result<Json<admin_stats::QuestStatsResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let (meta, snapshot) = state
        .grants
        .get_bundle(&quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("quest '{quest_id}' is not published")))?;
    let (range, with_prev, ev) = load_stats_window(&state, &q, Some(&quest_id)).await?;
    let (funnel_logs, authored) = tokio::join!(
        state
            .store
            .funnel_logs(&meta.snapshot_id, range.start_secs(), range.end_secs_excl()),
        state.constructor.label_for_quest(&quest_id),
    );
    // Same precedence as the overview table this page opens from, for one quest:
    // the authoring row, else the listing (which exists — `get_bundle` 404s above).
    let label = authored?.unwrap_or_else(|| store::QuestLabel::from_listing(&meta));
    Ok(Json(admin_stats::project_quest_detail(
        &meta,
        label,
        snapshot.as_ref(),
        &ev,
        &range,
        with_prev,
        &funnel_logs?,
    )))
}

/// Body for coupon create/save: the editable fields exactly as the admin form
/// collects them. `quest_ids: null` = «Все квесты»; a list = «Выбранные».
#[derive(serde::Deserialize)]
struct CouponPayload {
    code: String,
    #[serde(flatten)]
    discount: Discount,
    valid_until: Option<String>,
    max_redemptions: Option<u32>,
    per_user_limit: Option<u32>,
    quest_ids: Option<Vec<String>>,
    #[serde(default)]
    paused: bool,
}

impl CouponPayload {
    /// Validate every field and build the stored record. `coupon_id` and
    /// `created_at` come from the caller: fresh for create, preserved for save.
    fn into_coupon(self, coupon_id: String, created_at: String) -> Result<Coupon, AppError> {
        let code = coupons::normalize_code(&self.code)?;
        coupons::validate_discount(&self.discount)?;
        if let Some(date) = &self.valid_until {
            coupons::validate_date(date)?;
        }
        if self.max_redemptions == Some(0) || self.per_user_limit == Some(0) {
            return Err(AppError::BadRequest(
                "лимит использований должен быть больше нуля".into(),
            ));
        }
        if self.quest_ids.as_ref().is_some_and(|q| q.is_empty()) {
            return Err(AppError::BadRequest(
                "выберите хотя бы один квест или переключитесь на «Все квесты»".into(),
            ));
        }
        Ok(Coupon {
            coupon_id,
            code,
            discount: self.discount,
            valid_until: self.valid_until,
            max_redemptions: self.max_redemptions,
            per_user_limit: self.per_user_limit,
            quest_ids: self.quest_ids,
            paused: self.paused,
            created_at,
        })
    }
}

/// One coupon as served to the admin UI: the stored record plus the DERIVED
/// status and the usage fold (never persisted — always честный пересчёт).
#[derive(serde::Serialize)]
struct AdminCouponWire {
    #[serde(flatten)]
    coupon: Coupon,
    status: coupons::CouponStatus,
    #[serde(flatten)]
    usage: CouponUsage,
}

impl AdminCouponWire {
    fn build(coupon: Coupon, usage: CouponUsage, today: &str) -> Self {
        let status = coupons::coupon_status(&coupon, usage.used, today);
        Self {
            coupon,
            status,
            usage,
        }
    }
}

/// Admin coupon list, newest first, each with derived status + usage.
async fn list_coupons_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminCouponWire>>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let today = store::today_utc();
    let rows = state.coupons.list_with_usage().await?;
    Ok(Json(
        rows.into_iter()
            .map(|(c, u)| AdminCouponWire::build(c, u, &today))
            .collect(),
    ))
}

/// Create a coupon. 400 on any invalid field, 409 on a duplicate code.
async fn create_coupon_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CouponPayload>,
) -> Result<Json<AdminCouponWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let coupon_id = format!("cpn-{}", &auth::generate_token()[..12]);
    let coupon = payload.into_coupon(coupon_id, store::now_rfc3339())?;
    let created = state.coupons.create(coupon).await?;
    Ok(Json(AdminCouponWire::build(
        created,
        CouponUsage::default(),
        &store::today_utc(),
    )))
}

/// One coupon with usage (admin editor).
async fn get_coupon_handler(
    State(state): State<AppState>,
    Path(coupon_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AdminCouponWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let (coupon, usage) = state
        .coupons
        .get_with_usage(&coupon_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown coupon '{coupon_id}'")))?;
    Ok(Json(AdminCouponWire::build(
        coupon,
        usage,
        &store::today_utc(),
    )))
}

/// Save every editable field of a coupon (identity and created_at preserved;
/// the redemption log is untouched, so usage stats survive edits and pauses).
async fn save_coupon_handler(
    State(state): State<AppState>,
    Path(coupon_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<CouponPayload>,
) -> Result<Json<AdminCouponWire>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let existing = state
        .coupons
        .get(&coupon_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown coupon '{coupon_id}'")))?;
    let coupon = payload.into_coupon(existing.coupon_id, existing.created_at)?;
    let updated = state.coupons.update(coupon).await?;
    let (_, usage) = state
        .coupons
        .get_with_usage(&coupon_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("unknown coupon '{coupon_id}'")))?;
    Ok(Json(AdminCouponWire::build(
        updated,
        usage,
        &store::today_utc(),
    )))
}

/// Delete a coupon and its redemption log. Already-granted quests stay owned
/// («удаление необратимо; уже применённые скидки сохраняются»).
async fn delete_coupon_handler(
    State(state): State<AppState>,
    Path(coupon_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    require_admin_actor(&state, &headers).await?;
    state.coupons.delete(&coupon_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
