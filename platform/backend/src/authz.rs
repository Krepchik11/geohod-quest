//! The one access-rule module: who you are ([`Actor`]) and what you may do
//! (capability checks). Every handler answers authorization here — explicit
//! calls, not extractors, because several checks depend on the request body.
//!
//! Credentials, in one place:
//! - `Authorization: Bearer <token>` — a session, resolved to an account.
//! - `X-User-Id` — an anonymous device id, honored only while unregistered.
//! - `X-Admin-Token` — the shared operator secret (`ADMIN_TOKEN`). It grants
//!   the admin surface and the editor gate but carries NO identity: it is
//!   exempt from the admin self-change guard, and in the constructor it never
//!   gains cross-author reach (see [`require_editor_actor`]).

use axum::http::{HeaderMap, header};

use crate::AppState;
use crate::auth;
use crate::errors::AppError;
use crate::store::{ConstructorQuest, ConstructorQuestSummary};

/// Resolve the acting user id for a player-scoped request (player-identity spec).
///
/// A valid `Authorization: Bearer <token>` wins and must match a non-empty
/// claimed id (mismatch = 403, catches client bugs). Without a token, the
/// claimed id is accepted ONLY while unregistered — once an account exists for
/// it, device possession is no longer a sufficient credential (401).
pub async fn resolve_user(
    state: &AppState,
    headers: &HeaderMap,
    claimed: &str,
) -> Result<String, AppError> {
    if let Some(value) = headers.get(header::AUTHORIZATION) {
        let raw = value
            .to_str()
            .map_err(|_| AppError::Unauthorized("malformed authorization header".into()))?;
        let token = raw
            .strip_prefix("Bearer ")
            .ok_or_else(|| AppError::Unauthorized("expected a bearer token".into()))?;
        let user_id = state
            .auth
            .get_session(&auth::session_hash(token))
            .await?
            .ok_or_else(|| AppError::Unauthorized("invalid session".into()))?;
        if !claimed.is_empty() && claimed != user_id {
            return Err(AppError::Forbidden(
                "session does not match the claimed user id".into(),
            ));
        }
        return Ok(user_id);
    }
    if claimed.is_empty() {
        return Err(AppError::Unauthorized("missing identity".into()));
    }
    if state.auth.get_user(claimed).await?.is_some() {
        return Err(AppError::Unauthorized(
            "registered account requires login (bearer token)".into(),
        ));
    }
    Ok(claimed.to_string())
}

/// Claimed identity for GET endpoints without a body: the `X-User-Id` header
/// (anonymous devices) — ignored when a Bearer token is present.
pub fn claimed_from_headers(headers: &HeaderMap) -> String {
    headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// Gate admin-only endpoints (per-version stats/feedbacks, legacy migration)
/// behind the shared `ADMIN_TOKEN` secret carried in `X-Admin-Token`. These
/// surfaces expose aggregate telemetry, raw feedback notes and device ids, so
/// they fail closed: when no secret is configured the endpoints are disabled.
pub fn require_ops_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state.config.admin_token.as_deref().ok_or_else(|| {
        AppError::Forbidden("admin endpoints are disabled (ADMIN_TOKEN not set)".into())
    })?;
    let provided = headers
        .get("x-admin-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if provided.is_empty() || !auth::secret_eq(provided, expected) {
        return Err(AppError::Unauthorized("invalid admin token".into()));
    }
    Ok(())
}

/// Extract a `Bearer <token>` value from the Authorization header when present and
/// well-formed. Returns None for a missing/malformed header (the caller decides the
/// fallback) — unlike [`resolve_user`] it never errors on a missing header.
pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.strip_prefix("Bearer "))
        .map(str::to_string)
}

/// True when the shared `ADMIN_TOKEN` is configured AND the request presents it in
/// `X-Admin-Token`. This is the operator/bootstrap credential the admin and editor
/// gates share; it carries no identity (no "self"), so it is exempt from the
/// self-change guard. Fails closed when no token is configured.
pub fn ops_token_ok(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = state.config.admin_token.as_deref() else {
        return false;
    };
    let provided = headers
        .get("x-admin-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    !provided.is_empty() && auth::secret_eq(provided, expected)
}

/// The registered account behind a valid `Bearer` session, if any. A missing or
/// malformed token, an unknown session, and an anonymous id (no account row) all
/// collapse to `None`, so callers express authorization as a plain role check.
pub async fn session_account(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<auth::UserAccount>, AppError> {
    let Some(token) = bearer_token(headers) else {
        return Ok(None);
    };
    // One round-trip (session⋈users), not get_session then get_user — this runs on
    // the front of nearly every authenticated request.
    state
        .auth
        .account_for_session(&auth::session_hash(&token))
        .await
}

/// Who the caller is, resolved once (one ops-token check, at most one session
/// read). The ops token wins outright and short-circuits the session lookup —
/// exactly the precedence the old gates had — so an ops-token actor has no
/// identity (`user_id: None`) even when a Bearer header rides along.
pub struct Actor {
    pub user_id: Option<String>,
    pub role: Option<String>,
    pub via_ops_token: bool,
}

impl Actor {
    pub async fn resolve(state: &AppState, headers: &HeaderMap) -> Result<Self, AppError> {
        if ops_token_ok(state, headers) {
            return Ok(Self {
                user_id: None,
                role: None,
                via_ops_token: true,
            });
        }
        let (user_id, role) = match session_account(state, headers).await? {
            Some(account) => (Some(account.user_id), Some(account.role)),
            None => (None, None),
        };
        Ok(Self {
            user_id,
            role,
            via_ops_token: false,
        })
    }

    /// The admin surface: the shared ops token, or a session whose role is `admin`.
    pub fn can_admin(&self) -> bool {
        self.via_ops_token || self.role.as_deref() == Some(auth::ROLE_ADMIN)
    }
}

/// The identity authorized to act on the admin user-management surface. `user_id`
/// is `Some` for a session-admin (the acting account) and `None` for the shared
/// `ADMIN_TOKEN` ops path (no "self"); the role handler uses this to forbid an admin
/// from changing their own role while leaving the ops path unrestricted.
pub struct AdminActor {
    pub user_id: Option<String>,
}

/// Authorize an admin user-management request. Two accepted credentials:
///
/// 1. The shared `ADMIN_TOKEN` in `X-Admin-Token` — the ops/bootstrap path that
///    promotes the first admin (and recovers if every admin is demoted). It carries
///    no identity, so it is exempt from the self-change guard.
/// 2. A `Bearer` session whose account has role `admin` — the user-facing path the
///    admin page uses once an admin exists.
///
/// Every other caller (anonymous, non-admin account, bad/expired token) gets a
/// single opaque 403 that never reveals which credential was tried or missing.
pub async fn require_admin_actor(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AdminActor, AppError> {
    let actor = Actor::resolve(state, headers).await?;
    if actor.can_admin() {
        return Ok(AdminActor {
            user_id: actor.user_id,
        });
    }
    Err(AppError::Forbidden("admin access required".into()))
}

/// The authorized editor identity for a constructor request: who authored rows
/// are attributed to, and whether the actor has admin (cross-author) reach.
pub struct EditorActor {
    pub author_id: String,
    pub author_name: String,
    pub is_admin: bool,
}

/// Authorize a quest-authoring request (the constructor / `/quest-editor` surface)
/// and resolve the acting editor — ONE ops-token check, ONE session read.
///
/// The gate is the `editor` capability: a `Bearer` session whose account role is
/// `editor` or `admin` (admin ⊃ editor), OR the shared `ADMIN_TOKEN` operator
/// credential (which needs no session at all). Anonymous devices and plain
/// `player` accounts get an opaque 403.
///
/// The identity prefers the `Bearer` session when one resolves — the real account
/// (admin iff role == admin) — even when the ops token also rides along. Without
/// a session, the ops path (no "self") is labeled generically, keyed by the
/// claimed device id, and is NEVER admin: the constructor keeps that bootstrap
/// path author-scoped so an operator never gains cross-author reach.
///
/// This is the server-side half of the role model — the `/quest-editor` page hides
/// itself from non-editors, but publish is a direct API call, so it must be gated
/// here too (a player could otherwise POST `/api/quests/publish` straight).
pub async fn require_editor_actor(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<EditorActor, AppError> {
    let via_ops_token = ops_token_ok(state, headers);
    let account = session_account(state, headers).await?;
    let can_edit = via_ops_token
        || account
            .as_ref()
            .is_some_and(|a| auth::role_can_author(&a.role));
    if !can_edit {
        return Err(AppError::Forbidden("editor access required".into()));
    }
    Ok(match account {
        Some(account) => EditorActor {
            is_admin: account.role == auth::ROLE_ADMIN,
            author_name: account.author_label(),
            author_id: account.user_id,
        },
        None => {
            let claimed = claimed_from_headers(headers);
            EditorActor {
                author_id: if claimed.is_empty() {
                    "ops".to_string()
                } else {
                    claimed
                },
                author_name: "Оператор".to_string(),
                is_admin: false,
            }
        }
    })
}

/// Authorize the caller for `quest_id` and return its LIST row (no body, no cover).
///
/// Authoring is editor-gated (capability), then ownership-gated: a quest stays the
/// author's, but an ADMIN is the superuser and may act on any author's quest in any
/// state (the stated lifecycle: a published quest is "owned by author" yet "can be
/// edited by admin"). For a non-admin, a quest they did not author is
/// indistinguishable from one that does not exist — the same opaque 404, never a
/// signal that another author's quest exists. This is the single chokepoint every
/// per-quest constructor handler routes through — including
/// [`require_owned_constructor_quest`] and [`require_constructor_admin`] —
/// so the owner-or-admin rule exists in exactly one place and cannot be re-derived
/// (and forgotten) per call site.
///
/// `author_id` is mutable (an admin may transfer a quest), so the returned row is
/// a snapshot of ownership at gate time. Every mutation that follows it is keyed
/// by `quest_id` and rewrites the whole field it touches, so a transfer landing in
/// between costs the loser their edit, never the quest.
///
/// The admin widening comes from [`require_editor_actor`]'s session check ONLY:
/// the bare ops token satisfies the editor gate but is never admin here, so it
/// cannot reach another author's quest.
///
/// Authorizing on the SUMMARY is what keeps the heavy read opt-in: save, status
/// and delete only need to know who owns the quest, and the authoring body they
/// used to load along the way runs to megabytes for a media-rich import.
pub async fn require_owned_constructor_summary(
    state: &AppState,
    headers: &HeaderMap,
    quest_id: &str,
) -> Result<ConstructorQuestSummary, AppError> {
    let actor = require_editor_actor(state, headers).await?;
    state
        .constructor
        .summary_for_quest(quest_id)
        .await?
        .filter(|q| actor.is_admin || q.author_id == actor.author_id)
        .ok_or_else(|| AppError::NotFound(format!("constructor quest '{quest_id}' not found")))
}

/// The editor gate narrowed to a session ADMIN — for constructor surfaces that
/// are administration, not authoring: who a quest may be handed to, and the
/// handover itself.
///
/// The ops token deliberately does NOT pass. It satisfies the editor gate but
/// carries no identity and is never admin in the constructor
/// ([`require_editor_actor`]), so it can neither reach another author's quest nor
/// move one — an operator credential must not silently redistribute authorship.
pub async fn require_constructor_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<EditorActor, AppError> {
    let actor = require_editor_actor(state, headers).await?;
    if !actor.is_admin {
        return Err(AppError::Forbidden("admin access required".into()));
    }
    Ok(actor)
}

/// The same gate, then the FULL entity — for the two callers that genuinely read
/// the authoring body (GET-one and export). Everything else takes the summary.
pub async fn require_owned_constructor_quest(
    state: &AppState,
    headers: &HeaderMap,
    quest_id: &str,
) -> Result<ConstructorQuest, AppError> {
    require_owned_constructor_summary(state, headers, quest_id).await?;
    state
        .constructor
        .get(quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("constructor quest '{quest_id}' not found")))
}
