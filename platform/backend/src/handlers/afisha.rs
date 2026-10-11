//! «Афиша» routes: the data of the public announcement pages and the admin
//! «Афиша» page. The rules are `crate::afisha`, the channel I/O is
//! `crate::afisha_reader`.
//!
//! Public routes answer 404 while the `afisha` feature is off or no channel
//! is set, so the site shows nothing before the admin switches it on.

use axum::{
    Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{Json, Redirect},
    routing::{get, post},
};

use crate::AppState;
use crate::afisha::{self, AfishaEvent, AfishaKind, AfishaStatus, EventFields};
use crate::afisha_reader::{self, Report};
use crate::authz::require_admin_actor;
use crate::errors::AppError;
use crate::features::{Feature, feature_enabled};
use crate::settings::Setting;
use crate::store::now_secs;

/// Past announcements a page lists by default, and at most.
const PAST_DEFAULT: usize = 60;
const PAST_MAX: usize = 300;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/afisha", get(public_list_handler))
        .route("/api/afisha/{post_id}", get(public_event_handler))
        .route("/api/afisha/{post_id}/go", get(register_click_handler))
        .route("/api/admin/afisha", get(admin_page_handler))
        .route("/api/admin/afisha/save", post(admin_save_handler))
        .route(
            "/api/admin/afisha/visibility",
            post(admin_visibility_handler),
        )
        .route("/api/admin/afisha/import", post(admin_import_handler))
        .route("/api/admin/afisha/sync", post(admin_sync_handler))
        .route("/api/admin/afisha/archive", post(admin_archive_handler))
}

fn now() -> i64 {
    i64::try_from(now_secs()).unwrap_or(i64::MAX)
}

/// One announcement as its public page shows it. Only published
/// announcements are served, and they always have a date, a time and a city.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaEventWire"))]
pub(crate) struct AfishaEventWire {
    #[cfg_attr(test, ts(type = "number"))]
    post_id: i64,
    /// The page's path segment under `/afisha/`.
    slug: String,
    kind: AfishaKind,
    title: String,
    /// `YYYY-MM-DD` and `HH:MM`, local to the city.
    date: String,
    time: String,
    /// The instants with the city's UTC offset (`2026-10-11T12:45:00+02:00`).
    starts_at: String,
    ends_at: String,
    city: String,
    /// The city's path segment (`novi-sad`).
    city_slug: String,
    place: Option<String>,
    distance: Option<String>,
    duration: Option<String>,
    route: Option<String>,
    difficulty: Option<String>,
    guide: Option<String>,
    price: Option<String>,
    expenses: Option<String>,
    bring: Option<String>,
    description: Option<String>,
    /// Media URL of the post's picture.
    image: Option<String>,
    /// The registration bot's link; the site's button goes through
    /// `/api/afisha/{post_id}/go`, which counts the click.
    register_url: Option<String>,
    /// The post in the channel.
    post_url: String,
    /// Over already.
    past: bool,
}

impl AfishaEventWire {
    /// `None` for an announcement the public never sees (not published, or —
    /// defensively — missing what a published one always has).
    fn public(event: &AfishaEvent, now: i64) -> Option<Self> {
        if event.status != AfishaStatus::Published {
            return None;
        }
        let schedule = event.schedule()?;
        let f = &event.fields;
        let city = f.city.clone()?;
        Some(Self {
            post_id: event.post_id,
            slug: event.slug(),
            kind: event.kind?,
            title: f.title.clone(),
            date: f.date.clone()?,
            time: f.time.clone()?,
            starts_at: schedule.start_local(),
            ends_at: schedule.end_local(),
            city_slug: afisha::translit_slug(&city),
            city,
            place: f.place.clone(),
            distance: f.distance.clone(),
            duration: f.duration.clone(),
            route: f.route.clone(),
            difficulty: f.difficulty.clone(),
            guide: f.guide.clone(),
            price: f.price.clone(),
            expenses: f.expenses.clone(),
            bring: f.bring.clone(),
            description: f.description.clone(),
            image: event.image.clone(),
            register_url: event.register_url.clone(),
            post_url: event.post_url(),
            past: now >= schedule.end_utc,
        })
    }
}

/// The channel the public pages show, while the feature is on.
async fn public_channel(state: &AppState) -> Result<String, AppError> {
    if !feature_enabled(state, Feature::Afisha).await? {
        return Err(AppError::NotFound("афиша выключена".into()));
    }
    afisha_reader::configured_channel(state)
        .await?
        .ok_or_else(|| AppError::NotFound("канал афиши не указан".into()))
}

#[derive(serde::Deserialize)]
struct ListQuery {
    /// `upcoming` (default) or `past`.
    when: Option<String>,
    /// How many past announcements (newest first); upcoming ones are all listed.
    limit: Option<usize>,
}

/// GET /api/afisha — upcoming announcements soonest first, or with
/// `?when=past` the past ones newest first.
async fn public_list_handler(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<AfishaEventWire>>, AppError> {
    let channel = public_channel(&state).await?;
    let now = now();
    let past = match q.when.as_deref() {
        None | Some("upcoming") => false,
        Some("past") => true,
        Some(other) => return Err(AppError::BadRequest(format!("when: {other}?"))),
    };
    let mut events: Vec<AfishaEventWire> = state
        .afisha
        .list(&channel)
        .await?
        .iter()
        .filter_map(|e| AfishaEventWire::public(e, now))
        .filter(|e| e.past == past)
        .collect();
    events.sort_by(|a, b| {
        a.starts_at
            .cmp(&b.starts_at)
            .then(a.post_id.cmp(&b.post_id))
    });
    if past {
        events.reverse();
        events.truncate(q.limit.unwrap_or(PAST_DEFAULT).min(PAST_MAX));
    }
    Ok(Json(events))
}

/// GET /api/afisha/{post_id} — one published announcement.
async fn public_event_handler(
    State(state): State<AppState>,
    Path(post_id): Path<i64>,
) -> Result<Json<AfishaEventWire>, AppError> {
    let channel = public_channel(&state).await?;
    state
        .afisha
        .get(&channel, post_id)
        .await?
        .and_then(|e| AfishaEventWire::public(&e, now()))
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("анонса {post_id} нет")))
}

/// GET /api/afisha/{post_id}/go — the «Записаться» button: counts the click
/// and sends the visitor on to the registration bot.
async fn register_click_handler(
    State(state): State<AppState>,
    Path(post_id): Path<i64>,
) -> Result<Redirect, AppError> {
    let channel = public_channel(&state).await?;
    let url = state
        .afisha
        .get(&channel, post_id)
        .await?
        .filter(|e| e.status == AfishaStatus::Published)
        .and_then(|e| e.register_url)
        .ok_or_else(|| AppError::NotFound(format!("у анонса {post_id} нет записи")))?;
    state.afisha.add_click(&channel, post_id).await?;
    Ok(Redirect::to(&url))
}

/// One announcement in the admin list — every status.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AdminAfishaWire"))]
pub(crate) struct AdminAfishaWire {
    #[cfg_attr(test, ts(type = "number"))]
    post_id: i64,
    slug: String,
    status: AfishaStatus,
    kind: Option<AfishaKind>,
    fields: EventFields,
    /// Fields (and `kind`) the admin set by hand — a re-read keeps them.
    edited: Vec<String>,
    image: Option<String>,
    register_url: Option<String>,
    post_url: String,
    /// When the post appeared in the channel (RFC3339 UTC).
    posted_at: String,
    /// Why a draft is a draft.
    problem: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    clicks: u64,
    past: bool,
    /// The start with the city's offset; `null` without a date and a time.
    starts_at: Option<String>,
}

impl AdminAfishaWire {
    fn from_event(event: AfishaEvent, now: i64) -> Self {
        let schedule = event.schedule();
        Self {
            post_id: event.post_id,
            slug: event.slug(),
            status: event.status,
            kind: event.kind,
            post_url: event.post_url(),
            past: schedule.is_some_and(|s| now >= s.end_utc),
            starts_at: schedule.map(|s| s.start_local()),
            fields: event.fields,
            edited: event.edited.into_iter().collect(),
            image: event.image,
            register_url: event.register_url,
            posted_at: event.posted_at,
            problem: event.problem,
            clicks: event.clicks,
        }
    }
}

/// The admin «Афиша» page: its settings, the reader's state and every
/// announcement, newest post first. Every action answers with it.
#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AdminAfishaResponse"))]
pub(crate) struct AdminAfishaResponse {
    /// The channel as the reader understood the setting; `null` while unset
    /// or not a channel name.
    channel: Option<String>,
    admin_email: Option<String>,
    /// The `afisha` feature: the public pages and the timer.
    enabled: bool,
    /// A pass is reading the channel right now.
    running: bool,
    last_run: Option<String>,
    last_error: Option<String>,
    events: Vec<AdminAfishaWire>,
    /// What the action just did (a pass, an import); `null` otherwise.
    report: Option<Report>,
}

async fn admin_page(
    state: &AppState,
    report: Option<Report>,
) -> Result<Json<AdminAfishaResponse>, AppError> {
    let channel = afisha_reader::configured_channel(state).await?;
    let mut events = match &channel {
        Some(channel) => state.afisha.list(channel).await?,
        None => Vec::new(),
    };
    events.sort_by_key(|e| std::cmp::Reverse(e.post_id));
    let now = now();
    let status = state.afisha_reader.status();
    Ok(Json(AdminAfishaResponse {
        admin_email: state.settings.get(Setting::AfishaAdminEmail.key()).await?,
        enabled: feature_enabled(state, Feature::Afisha).await?,
        running: state.afisha_reader.running(),
        last_run: status.last_run,
        last_error: status.last_error,
        events: events
            .into_iter()
            .map(|e| AdminAfishaWire::from_event(e, now))
            .collect(),
        channel,
        report,
    }))
}

/// The channel every admin action works on.
async fn admin_channel(state: &AppState) -> Result<String, AppError> {
    afisha_reader::configured_channel(state)
        .await?
        .ok_or_else(|| AppError::BadRequest("сначала укажите канал афиши".into()))
}

/// One announcement the admin acts on.
async fn admin_event(state: &AppState, post_id: i64) -> Result<(String, AfishaEvent), AppError> {
    let channel = admin_channel(state).await?;
    let event = state
        .afisha
        .get(&channel, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("анонса {post_id} нет")))?;
    Ok((channel, event))
}

/// Store an announcement the admin changed and tell search engines.
async fn save_admin_change(state: &AppState, event: AfishaEvent) -> Result<(), AppError> {
    let url = afisha_reader::page_url(state, &event);
    state.afisha.upsert(event).await?;
    afisha_reader::ping_indexnow(state, vec![url]).await;
    Ok(())
}

/// GET /api/admin/afisha — the admin page.
async fn admin_page_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminAfishaResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    admin_page(&state, None).await
}

/// Body of the edit form: the kind and every field.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaSaveBody"))]
pub(crate) struct AfishaSaveRequest {
    #[cfg_attr(test, ts(type = "number"))]
    post_id: i64,
    kind: Option<AfishaKind>,
    fields: EventFields,
}

/// POST /api/admin/afisha/save — the admin's corrections; the changed fields
/// stay as set even when the post is edited later.
async fn admin_save_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AfishaSaveRequest>,
) -> Result<Json<AdminAfishaResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let (_, mut event) = admin_event(&state, req.post_id).await?;
    event.edit(req.kind, req.fields)?;
    save_admin_change(&state, event).await?;
    admin_page(&state, None).await
}

/// Body for taking an announcement off the site or bringing it back.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaVisibilityBody"))]
pub(crate) struct AfishaVisibilityRequest {
    #[cfg_attr(test, ts(type = "number"))]
    post_id: i64,
    hidden: bool,
}

/// POST /api/admin/afisha/visibility — «Скрыть» / «Показать».
async fn admin_visibility_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AfishaVisibilityRequest>,
) -> Result<Json<AdminAfishaResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let (_, mut event) = admin_event(&state, req.post_id).await?;
    if req.hidden {
        event.hide();
    } else {
        event.show();
    }
    save_admin_change(&state, event).await?;
    admin_page(&state, None).await
}

/// Body for taking one post by its link.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaImportBody"))]
pub(crate) struct AfishaImportRequest {
    url: String,
}

/// A pass the admin started; 409 while another one reads the channel.
fn busy() -> AppError {
    AppError::Conflict("канал уже читается — попробуйте через минуту".into())
}

/// POST /api/admin/afisha/import — take one post by its link (a post the
/// admin forgot to tag, or one from before the reader).
async fn admin_import_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AfishaImportRequest>,
) -> Result<Json<AdminAfishaResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let channel = admin_channel(&state).await?;
    let report = {
        let _running = state.afisha_reader.try_run().ok_or_else(busy)?;
        afisha_reader::import_link(&state, &channel, &req.url).await?
    };
    admin_page(&state, Some(report)).await
}

/// POST /api/admin/afisha/sync — read the channel now, as the timer does.
async fn admin_sync_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminAfishaResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let channel = admin_channel(&state).await?;
    let report = {
        let _running = state.afisha_reader.try_run().ok_or_else(busy)?;
        let read = afisha_reader::sync_feed(&state, &channel).await;
        afisha_reader::record(&state, &channel, read).await?
    };
    admin_page(&state, Some(report)).await
}

/// Body for one archive page: start before this post; `null` = the newest.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaArchiveBody"))]
pub(crate) struct AfishaArchiveRequest {
    #[cfg_attr(test, ts(type = "number | null"))]
    before: Option<i64>,
    /// Only posts published from this year on; `null` = the whole channel.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number | null"))]
    since_year: Option<i32>,
}

/// POST /api/admin/afisha/archive — import one page (20 posts) of the
/// channel's own announcements (optionally from `since_year` on); the page
/// calls again with `report.next_before` until it is `null`.
async fn admin_archive_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AfishaArchiveRequest>,
) -> Result<Json<AdminAfishaResponse>, AppError> {
    require_admin_actor(&state, &headers).await?;
    let channel = admin_channel(&state).await?;
    let report = {
        let _running = state.afisha_reader.try_run().ok_or_else(busy)?;
        afisha_reader::import_archive_page(&state, &channel, req.before, req.since_year).await?
    };
    admin_page(&state, Some(report)).await
}
