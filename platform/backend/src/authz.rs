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
//!   gains cross-author reach (see [`acting_author_role`]).

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
            .get_session(token)
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
    if provided.is_empty() || provided != expected {
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
    !provided.is_empty() && provided == expected
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
    state.auth.account_for_session(&token).await
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

    /// The authoring surface: `editor` or anything [`can_admin`](Self::can_admin)
    /// grants (admin ⊃ editor).
    pub fn can_edit(&self) -> bool {
        self.can_admin() || self.role.as_deref() == Some(auth::ROLE_EDITOR)
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

/// Authorize a quest-authoring request (the constructor / `/quest-editor` surface).
///
/// Authoring is the `editor` capability: a `Bearer` session whose account role is
/// `editor` or `admin` (admin ⊃ editor), OR the shared `ADMIN_TOKEN` operator
/// credential. Anonymous devices and plain `player` accounts get an opaque 403.
///
/// This is the server-side half of the role model — the `/quest-editor` page hides
/// itself from non-editors, but publish is a direct API call, so it must be gated
/// here too (a player could otherwise POST `/api/quests/publish` straight). It does
/// NOT bind authorship to the editor (any editor may publish any quest); per-author
/// ownership remains a separate, tracked follow-up.
pub async fn require_editor(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    if Actor::resolve(state, headers).await?.can_edit() {
        return Ok(());
    }
    Err(AppError::Forbidden("editor access required".into()))
}

/// The acting editor's (id, display label, is_admin) for a constructor request,
/// resolved from a SINGLE session lookup. A Bearer session resolves to the real
/// account (admin iff role == admin); the ops-token path (no "self") is labeled
/// generically, keyed by the claimed device id, and is never admin — the
/// constructor keeps that bootstrap path author-scoped so an operator never gains
/// cross-author reach. Callers that also need the admin flag use this directly
/// instead of a second `session_account` round-trip.
pub async fn acting_author_role(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, String, bool), AppError> {
    if let Some(account) = session_account(state, headers).await? {
        let is_admin = account.role == auth::ROLE_ADMIN;
        let name = account
            .display_name
            .filter(|s| !s.trim().is_empty())
            .or(account.email)
            .unwrap_or_else(|| account.user_id.clone());
        return Ok((account.user_id, name, is_admin));
    }
    let claimed = claimed_from_headers(headers);
    let id = if claimed.is_empty() {
        "ops".to_string()
    } else {
        claimed
    };
    Ok((id, "Оператор".to_string(), false))
}

/// The acting editor's (id, display label) for author attribution. See
/// [`acting_author_role`] when the admin flag is also needed.
pub async fn acting_author(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, String), AppError> {
    let (id, name, _) = acting_author_role(state, headers).await?;
    Ok((id, name))
}

/// Authorize the caller for `quest_id` and return its LIST row (no body, no cover).
///
/// Authoring is editor-gated (capability), then ownership-gated: a quest stays the
/// author's, but an ADMIN is the superuser and may act on any author's quest in any
/// state (the stated lifecycle: a published quest is "owned by author" yet "can be
/// edited by admin"). For a non-admin, a quest they did not author is
/// indistinguishable from one that does not exist — the same opaque 404, never a
/// signal that another author's quest exists. `author_id` is immutable (there is
/// no quest-transfer), so the fetched row can be reused for the follow-up
/// mutation with no TOCTOU ownership gap. This is the single chokepoint every
/// per-quest constructor handler routes through — including
/// [`require_owned_constructor_quest`] — so the owner-or-admin rule exists in
/// exactly one place and cannot be re-derived (and forgotten) per call site.
///
/// The admin widening comes from [`acting_author_role`]'s session check ONLY:
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
    require_editor(state, headers).await?;
    let (author_id, _, admin) = acting_author_role(state, headers).await?;
    state
        .constructor
        .summary_for_quest(quest_id)
        .await?
        .filter(|q| admin || q.author_id == author_id)
        .ok_or_else(|| AppError::NotFound(format!("constructor quest '{quest_id}' not found")))
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
