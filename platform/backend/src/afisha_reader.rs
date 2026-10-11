//! The «Афиша» reader: fetches the public pages of the channel and keeps the
//! announcements in step with its posts. The rules live in `crate::afisha`;
//! this is the I/O around them — the pages, the pictures, the store, the mail
//! to the admin and the IndexNow pings.
//!
//! Every page is public and read the way a visitor reads it: no bot, no
//! account, no Telegram keys. The feed is read every [`FEED_EVERY`];
//! upcoming announcements that have left the feed are checked one by one
//! once a day (an edited or deleted post). Tests swap the network for the
//! pages saved in `fixtures/afisha` ([`ChannelHttp::for_build`]).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use bytes::Bytes;
use serde_json::json;

use crate::AppState;
use crate::afisha::{self, AfishaEvent, AfishaStatus, ChannelPost};
use crate::errors::AppError;
use crate::features::{Feature, feature_enabled};
use crate::settings::Setting;
use crate::store::{now_rfc3339, now_secs};

/// How often the feed is read.
pub const FEED_EVERY: Duration = Duration::from_secs(600);

/// How often upcoming announcements outside the feed are checked one by one.
const CHECK_EVERY_SECS: u64 = 24 * 3600;

/// Older feed pages read to catch up after a pause (20 posts each).
const MAX_CATCH_UP_PAGES: usize = 5;

/// Biggest page or picture the reader downloads.
const MAX_FETCH_BYTES: usize = 15 * 1024 * 1024;

/// Failed reads in a row before the admin gets a mail.
const FAILURES_BEFORE_MAIL: u32 = 2;

/// The site's IndexNow key. The frontend serves the same value as
/// `/<key>.txt` (`frontend/public/`), which is how a search engine checks
/// that a ping comes from the site's owner; the key is public by design.
pub const INDEXNOW_KEY: &str = "9d49c07e9f9a553ad42a04a1d350f1ce";

const INDEXNOW_ENDPOINT: &str = "https://api.indexnow.org/indexnow";

const USER_AGENT: &str =
    "Mozilla/5.0 (compatible; GeohodAfisha/1.0; +https://quest.geohod.ru/afisha)";

/// A downloaded page or picture.
pub struct Fetched {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// How the reader reaches the network.
#[derive(Clone)]
pub enum ChannelHttp {
    /// The real pages: a blocking attohttpc call off the runtime (the
    /// `yookassa.rs` idiom).
    Live,
    /// The saved pages of `fixtures/afisha` — a test never touches the network.
    #[cfg(test)]
    Fake(std::sync::Arc<FakeChannel>),
}

impl ChannelHttp {
    /// The transport of this build: the network, or the saved pages under test.
    pub fn for_build() -> Self {
        #[cfg(test)]
        {
            Self::Fake(std::sync::Arc::new(FakeChannel::default()))
        }
        #[cfg(not(test))]
        {
            Self::Live
        }
    }

    async fn get(&self, url: &str) -> Result<Fetched, AppError> {
        match self {
            Self::Live => {
                let url = url.to_string();
                run_blocking(move || {
                    let resp = attohttpc::get(&url)
                        .header("User-Agent", USER_AGENT)
                        .timeout(Duration::from_secs(20))
                        .send()
                        .map_err(|e| fetch_err(&url, &e))?;
                    let status = resp.status().as_u16();
                    let content_type = resp
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    let body = resp.bytes().map_err(|e| fetch_err(&url, &e))?;
                    if body.len() > MAX_FETCH_BYTES {
                        return Err(fetch_err(&url, &"больше 15 МБ"));
                    }
                    Ok(Fetched {
                        status,
                        content_type,
                        body,
                    })
                })
                .await
            }
            #[cfg(test)]
            Self::Fake(fake) => Ok(fake.get(url)),
        }
    }

    async fn post_json(&self, url: &str, body: serde_json::Value) -> Result<u16, AppError> {
        match self {
            Self::Live => {
                let url = url.to_string();
                run_blocking(move || {
                    let resp = attohttpc::post(&url)
                        .header("User-Agent", USER_AGENT)
                        .timeout(Duration::from_secs(20))
                        .json(&body)
                        .map_err(|e| fetch_err(&url, &e))?
                        .send()
                        .map_err(|e| fetch_err(&url, &e))?;
                    Ok(resp.status().as_u16())
                })
                .await
            }
            #[cfg(test)]
            Self::Fake(fake) => {
                fake.pinged.lock().expect("fake channel").push(body);
                Ok(200)
            }
        }
    }
}

/// Run a blocking download off the async runtime.
async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("afisha download task: {e}")))?
}

fn fetch_err(url: &str, e: &dyn std::fmt::Display) -> AppError {
    AppError::Internal(anyhow::anyhow!("не удалось загрузить {url}: {e}"))
}

/// The channel as the saved pages show it. The feed can be swapped to play
/// an edited or a deleted post; every fetch and every ping is recorded.
#[cfg(test)]
#[derive(Default)]
pub struct FakeChannel {
    /// Replaces the saved feed when set.
    pub feed: Mutex<Option<String>>,
    pub fetched: Mutex<Vec<String>>,
    pub pinged: Mutex<Vec<serde_json::Value>>,
}

#[cfg(test)]
impl FakeChannel {
    const FEED: &str = include_str!("../fixtures/afisha/feed.html");
    const OLDER: &str = include_str!("../fixtures/afisha/feed-older.html");
    const EMBED_1087: &str = include_str!("../fixtures/afisha/embed-1087.html");
    const EMBED_MISSING: &str = include_str!("../fixtures/afisha/embed-missing.html");

    fn get(&self, url: &str) -> Fetched {
        self.fetched
            .lock()
            .expect("fake channel")
            .push(url.to_string());
        let page = |html: &str| Fetched {
            status: 200,
            content_type: "text/html; charset=utf-8".into(),
            body: html.as_bytes().to_vec(),
        };
        if url.contains("telesco.pe") {
            return Fetched {
                status: 200,
                content_type: "image/jpeg".into(),
                body: vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16],
            };
        }
        let feed = self
            .feed
            .lock()
            .expect("fake channel")
            .clone()
            .unwrap_or_else(|| Self::FEED.to_string());
        if url.contains("/s/") {
            // The saved older page holds posts 1078–1081: it answers for the
            // page before the feed, and nothing is older than it.
            let before: Option<i64> = url.split("before=").nth(1).and_then(|n| n.parse().ok());
            return match before {
                None => page(&feed),
                Some(id) if id > 1081 => page(Self::OLDER),
                Some(_) => page("<html></html>"),
            };
        }
        let Some((_, tail)) = url.split_once("t.me/") else {
            return Fetched {
                status: 404,
                content_type: String::new(),
                body: Vec::new(),
            };
        };
        let id = tail.split(['/', '?']).nth(1).unwrap_or_default();
        if id == "1087" {
            page(Self::EMBED_1087)
        } else if afisha::parse_channel_page(&feed)
            .iter()
            .any(|p| p.id.to_string() == id)
        {
            page(&feed)
        } else {
            page(Self::EMBED_MISSING)
        }
    }
}

/// What one pass did — the admin page shows it after a button.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaReportWire"))]
pub struct Report {
    /// Posts on the pages read.
    pub read: u32,
    pub created: u32,
    pub updated: u32,
    pub removed: u32,
    /// Archive import: the next page starts before this post; `null` = done.
    #[cfg_attr(test, ts(type = "number | null"))]
    pub next_before: Option<i64>,
}

/// The reader's runtime state: one pass at a time, and what the last one said.
#[derive(Default)]
pub struct ReaderState {
    /// Held while a pass runs, so the timer and the admin's buttons never
    /// read the channel at the same time.
    run: tokio::sync::Mutex<()>,
    status: Mutex<ReaderStatus>,
}

/// What the admin page shows about the reader.
#[derive(Clone, Debug, Default)]
pub struct ReaderStatus {
    pub last_run: Option<String>,
    pub last_error: Option<String>,
    failures: u32,
    last_check: u64,
}

impl ReaderState {
    /// The latest status.
    pub fn status(&self) -> ReaderStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Whether a pass is running now.
    pub fn running(&self) -> bool {
        self.run.try_lock().is_err()
    }

    /// Start a pass unless one is running; the pass ends with the guard.
    pub fn try_run(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        self.run.try_lock().ok()
    }

    /// Whether the daily one-by-one check is due; marks it done when it is.
    fn check_due(&self, now: u64) -> bool {
        let Ok(mut status) = self.status.lock() else {
            return false;
        };
        let due = now.saturating_sub(status.last_check) >= CHECK_EVERY_SECS;
        if due {
            status.last_check = now;
        }
        due
    }
}

/// How a post reached the reader.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// The feed or the daily check: a tagged post or an own event.
    Feed,
    /// The archive: own announcements of the template; of the posts already
    /// stored, only untagged past ones are filed.
    Archive,
    /// The admin pasted its link: always applied, filed even without a tag.
    Import,
}

/// One pass over some posts: applies them, then pings and mails once.
struct Pass<'a> {
    state: &'a AppState,
    channel: &'a str,
    cities: Vec<String>,
    now: i64,
    report: Report,
    /// Pages search engines should re-read.
    changed_urls: Vec<String>,
    /// Posts that became drafts — the admin hears about them.
    drafts: Vec<AfishaEvent>,
    /// Published announcements whose post was deleted.
    removed: Vec<AfishaEvent>,
}

impl<'a> Pass<'a> {
    async fn new(state: &'a AppState, channel: &'a str) -> Result<Self, AppError> {
        let cities = crate::cities::load_rows(state)
            .await?
            .into_iter()
            .map(|row| row.record.name)
            .collect();
        Ok(Self {
            state,
            channel,
            cities,
            now: i64::try_from(now_secs()).unwrap_or(i64::MAX),
            report: Report::default(),
            changed_urls: Vec::new(),
            drafts: Vec::new(),
            removed: Vec::new(),
        })
    }

    /// Apply one post and store the result when anything changed.
    async fn read(
        &mut self,
        existing: Option<&AfishaEvent>,
        post: &ChannelPost,
        mode: Mode,
    ) -> Result<(), AppError> {
        match existing {
            None => {
                let wanted = match mode {
                    Mode::Feed => post.is_candidate(),
                    Mode::Archive => post.is_announcement(),
                    Mode::Import => true,
                };
                if !wanted {
                    return Ok(());
                }
            }
            // The archive leaves what is on the site alone; it only files the
            // past posts the feed met without a hashtag.
            Some(event)
                if mode == Mode::Archive
                    && (event.status != AfishaStatus::Untagged
                        || event.edited.contains("kind")) =>
            {
                return Ok(());
            }
            Some(_) if mode == Mode::Archive => {}
            Some(event) => {
                let unchanged = event.status != AfishaStatus::Removed
                    && event.post_text == post.text
                    && (event.image.is_some() || post.photo.is_none());
                if unchanged && mode == Mode::Feed {
                    return Ok(());
                }
            }
        }
        let image = self.copy_photo(post).await;
        let mut event = afisha::apply_post(existing, self.channel, post, &self.cities, image);
        match mode {
            Mode::Feed => {}
            Mode::Archive => afisha::file_archived(&mut event, self.now),
            Mode::Import => afisha::file_imported(&mut event),
        }
        let was_published = existing.is_some_and(|e| e.status == AfishaStatus::Published);
        if was_published || event.status == AfishaStatus::Published {
            self.changed_urls.push(page_url(self.state, &event));
        }
        let new_draft = event.status == AfishaStatus::Draft
            && existing.is_none_or(|e| e.status != AfishaStatus::Draft);
        if new_draft {
            self.drafts.push(event.clone());
        }
        if existing.is_some() {
            self.report.updated += 1;
        } else {
            self.report.created += 1;
        }
        self.state.afisha.upsert(event).await
    }

    /// The post is gone from the channel: its page goes too.
    async fn remove(&mut self, mut event: AfishaEvent) -> Result<(), AppError> {
        if event.status == AfishaStatus::Published {
            self.changed_urls.push(page_url(self.state, &event));
            self.removed.push(event.clone());
        }
        event.remove();
        self.report.removed += 1;
        self.state.afisha.upsert(event).await
    }

    /// The post's picture copied into the site's media store; `None` when it
    /// has none or the copy failed (logged — the text still goes up).
    async fn copy_photo(&self, post: &ChannelPost) -> Option<String> {
        let url = post.photo.as_deref()?;
        let fetched = match self.state.afisha_http.get(url).await {
            Ok(fetched) if fetched.status == 200 => fetched,
            Ok(fetched) => {
                tracing::warn!(
                    status = fetched.status,
                    post = post.id,
                    "afisha: picture not served"
                );
                return None;
            }
            Err(e) => {
                tracing::warn!(error = ?e, post = post.id, "afisha: picture download failed");
                return None;
            }
        };
        let content_type = crate::media::normalized_media_type(&fetched.content_type)?;
        match self
            .state
            .media
            .put(Bytes::from(fetched.body), &content_type)
            .await
        {
            Ok(stored) => Some(stored.url),
            Err(e) => {
                tracing::warn!(error = ?e, post = post.id, "afisha: picture not stored");
                None
            }
        }
    }

    /// Tell search engines and the admin, then hand back the report.
    async fn finish(self) -> Report {
        if !self.changed_urls.is_empty() {
            let mut urls = self.changed_urls;
            urls.push(hub_url(self.state));
            ping_indexnow(self.state, urls).await;
        }
        if !self.drafts.is_empty() {
            let posts: Vec<String> = self
                .drafts
                .iter()
                .map(|e| {
                    let problem = e.problem.as_deref().unwrap_or("не хватает строк");
                    format!("Пост {}: {} — {problem}", e.post_id, e.post_url())
                })
                .collect();
            let body = format!(
                "Пост с хештегом попал в черновики сайта: в нём не нашлось нужных строк.\n\n{}\n\n\
                 Исправьте пост в канале (сайт перечитает его в течение 10 минут) или заполните \
                 поля в админке: {}",
                posts.join("\n"),
                admin_url(self.state)
            );
            mail_admin(self.state, "Афиша: пост не разобран", &body).await;
        }
        if !self.removed.is_empty() {
            let posts: Vec<String> = self
                .removed
                .iter()
                .map(|e| format!("Пост {}: «{}»", e.post_id, e.fields.title))
                .collect();
            let body = format!(
                "Эти посты удалены из канала, их анонсы сняты с сайта:\n\n{}\n\nАдминка: {}",
                posts.join("\n"),
                admin_url(self.state)
            );
            mail_admin(self.state, "Афиша: пост удалён из канала", &body).await;
        }
        self.report
    }
}

fn site_base(state: &AppState) -> &str {
    state.config.frontend_base.trim_end_matches('/')
}

/// The announcement's page on the site.
pub fn page_url(state: &AppState, event: &AfishaEvent) -> String {
    format!("{}/afisha/{}", site_base(state), event.slug())
}

fn hub_url(state: &AppState) -> String {
    format!("{}/afisha", site_base(state))
}

fn admin_url(state: &AppState) -> String {
    format!("{}/admin/afisha", site_base(state))
}

fn feed_url(channel: &str, before: Option<i64>) -> String {
    match before {
        Some(id) => format!("https://t.me/s/{channel}?before={id}"),
        None => format!("https://t.me/s/{channel}"),
    }
}

fn embed_url(channel: &str, post_id: i64) -> String {
    format!("https://t.me/{channel}/{post_id}?embed=1&mode=tme")
}

async fn fetch_page(state: &AppState, url: &str) -> Result<String, AppError> {
    let fetched = state.afisha_http.get(url).await?;
    if fetched.status != 200 {
        return Err(fetch_err(url, &format!("HTTP {}", fetched.status)));
    }
    Ok(String::from_utf8_lossy(&fetched.body).into_owned())
}

/// The channel the reader follows: the admin's setting, read leniently
/// (`@name`, a link); `None` while unset or not a channel name.
///
/// # Errors
///
/// A storage failure reading the setting.
pub async fn configured_channel(state: &AppState) -> Result<Option<String>, AppError> {
    let raw = state.settings.get(Setting::AfishaChannel.key()).await?;
    Ok(raw.as_deref().and_then(afisha::channel_name))
}

/// Read the feed: new and edited posts are applied, posts deleted from the
/// part of the channel the pages covered are taken off the site. After a
/// pause the reader pages back until it meets a post it already knows.
///
/// # Errors
///
/// The channel page cannot be fetched or shows no posts (Telegram changed
/// its markup), or a storage failure.
pub async fn sync_feed(state: &AppState, channel: &str) -> Result<Report, AppError> {
    let mut posts = afisha::parse_channel_page(&fetch_page(state, &feed_url(channel, None)).await?);
    if posts.is_empty() {
        return Err(AppError::Internal(anyhow::anyhow!(
            "на странице канала t.me/s/{channel} не нашлось постов — возможно, Telegram изменил её вёрстку"
        )));
    }
    let known: HashMap<i64, AfishaEvent> = state
        .afisha
        .list(channel)
        .await?
        .into_iter()
        .map(|e| (e.post_id, e))
        .collect();
    if let Some(&newest_known) = known.keys().max() {
        for _ in 0..MAX_CATCH_UP_PAGES {
            let oldest = posts.iter().map(|p| p.id).min().unwrap_or(newest_known);
            if oldest <= newest_known + 1 {
                break;
            }
            let older = afisha::parse_channel_page(
                &fetch_page(state, &feed_url(channel, Some(oldest))).await?,
            );
            if older.is_empty() {
                break;
            }
            posts.extend(older);
        }
    }
    let mut pass = Pass::new(state, channel).await?;
    pass.report.read = u32::try_from(posts.len()).unwrap_or(u32::MAX);
    for post in &posts {
        pass.read(known.get(&post.id), post, Mode::Feed).await?;
    }
    let seen: HashSet<i64> = posts.iter().map(|p| p.id).collect();
    let covered = posts.iter().map(|p| p.id).min().unwrap_or(0)
        ..=posts.iter().map(|p| p.id).max().unwrap_or(0);
    let deleted = known.into_values().filter(|e| {
        covered.contains(&e.post_id)
            && !seen.contains(&e.post_id)
            && e.status != AfishaStatus::Removed
    });
    for event in deleted {
        pass.remove(event).await?;
    }
    Ok(pass.finish().await)
}

/// Check upcoming announcements one by one on their own post pages — the
/// ones that have left the feed are edited or deleted there too.
///
/// # Errors
///
/// A post page cannot be fetched, or a storage failure.
pub async fn check_upcoming(state: &AppState, channel: &str) -> Result<Report, AppError> {
    let mut pass = Pass::new(state, channel).await?;
    let upcoming: Vec<AfishaEvent> = state
        .afisha
        .list(channel)
        .await?
        .into_iter()
        .filter(|e| matches!(e.status, AfishaStatus::Published | AfishaStatus::Draft))
        .filter(|e| !e.is_past(pass.now))
        .collect();
    for event in upcoming {
        let html = fetch_page(state, &embed_url(channel, event.post_id)).await?;
        pass.report.read += 1;
        if afisha::is_missing_post(&html) {
            pass.remove(event).await?;
            continue;
        }
        let post = afisha::parse_channel_page(&html)
            .into_iter()
            .find(|p| p.id == event.post_id);
        if let Some(post) = post {
            pass.read(Some(&event), &post, Mode::Feed).await?;
        }
    }
    Ok(pass.finish().await)
}

/// Take one post by the link the admin pasted — a post without a hashtag
/// too (filed under a guessed kind).
///
/// # Errors
///
/// `AppError::BadRequest` for a link that is not a post of the channel or a
/// post without text, `AppError::NotFound` for a deleted post, or a failed
/// download / storage call.
pub async fn import_link(state: &AppState, channel: &str, link: &str) -> Result<Report, AppError> {
    let post_id = afisha::post_id_of_link(link, channel).ok_or_else(|| {
        AppError::BadRequest(format!("это не ссылка на пост канала t.me/{channel}"))
    })?;
    let html = fetch_page(state, &embed_url(channel, post_id)).await?;
    if afisha::is_missing_post(&html) {
        return Err(AppError::NotFound(format!("поста {post_id} в канале нет")));
    }
    let post = afisha::parse_channel_page(&html)
        .into_iter()
        .find(|p| p.id == post_id)
        .ok_or_else(|| AppError::BadRequest(format!("в посте {post_id} нет текста")))?;
    let existing = state.afisha.get(channel, post_id).await?;
    let mut pass = Pass::new(state, channel).await?;
    pass.report.read = 1;
    pass.read(existing.as_ref(), &post, Mode::Import).await?;
    Ok(pass.finish().await)
}

/// One page (20 posts) of the archive: the feed paged back from `before`
/// (the newest page without it), taking every own announcement of the
/// template ([`ChannelPost::is_announcement`]) — the channel's own search
/// only reaches recent posts. Posts already on the site are left as they are;
/// the report names where the next page starts.
///
/// # Errors
///
/// The feed page cannot be fetched, or a storage failure.
pub async fn import_archive_page(
    state: &AppState,
    channel: &str,
    before: Option<i64>,
) -> Result<Report, AppError> {
    let posts = afisha::parse_channel_page(&fetch_page(state, &feed_url(channel, before)).await?);
    let known: HashMap<i64, AfishaEvent> = state
        .afisha
        .list(channel)
        .await?
        .into_iter()
        .map(|e| (e.post_id, e))
        .collect();
    let mut pass = Pass::new(state, channel).await?;
    pass.report.read = u32::try_from(posts.len()).unwrap_or(u32::MAX);
    for post in &posts {
        pass.read(known.get(&post.id), post, Mode::Archive).await?;
    }
    pass.report.next_before = posts.iter().map(|p| p.id).min();
    Ok(pass.finish().await)
}

/// Remember how a pass went; the second failure in a row mails the admin
/// (once, until a pass succeeds again). Hands the result back.
pub async fn record(
    state: &AppState,
    channel: &str,
    result: Result<Report, AppError>,
) -> Result<Report, AppError> {
    let failures = {
        let Ok(mut status) = state.afisha_reader.status.lock() else {
            return result;
        };
        status.last_run = Some(now_rfc3339());
        match &result {
            Ok(_) => {
                status.last_error = None;
                status.failures = 0;
            }
            Err(e) => {
                status.last_error = Some(error_text(e));
                status.failures += 1;
            }
        }
        status.failures
    };
    if let Err(e) = &result {
        tracing::error!(error = ?e, channel, "afisha: reading the channel failed");
        if failures == FAILURES_BEFORE_MAIL {
            let body = format!(
                "Сайт {FAILURES_BEFORE_MAIL} раза подряд не смог прочитать страницу канала \
                 t.me/s/{channel}.\n\nОшибка: {}\n\nОпубликованные анонсы остаются на сайте. \
                 Новые можно добавить вручную: админка → Афиша → «Импорт по ссылке» — {}",
                error_text(e),
                admin_url(state)
            );
            mail_admin(state, "Афиша: не удаётся прочитать канал", &body).await;
        }
    }
    result
}

/// The words of an error the admin can read (internal ones carry the cause).
fn error_text(e: &AppError) -> String {
    match e {
        AppError::Internal(inner) => format!("{inner:#}"),
        other => other.to_string(),
    }
}

/// The timer: read the feed every [`FEED_EVERY`] while the feature is on
/// and a channel is set, and check upcoming announcements once a day.
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(FEED_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if let Err(e) = scheduled_pass(&state).await {
            tracing::error!(error = ?e, "afisha: scheduled pass failed");
        }
    }
}

async fn scheduled_pass(state: &AppState) -> Result<(), AppError> {
    if !feature_enabled(state, Feature::Afisha).await? {
        return Ok(());
    }
    let Some(channel) = configured_channel(state).await? else {
        return Ok(());
    };
    let Some(_running) = state.afisha_reader.try_run() else {
        return Ok(());
    };
    if record(state, &channel, sync_feed(state, &channel).await)
        .await
        .is_ok()
        && state.afisha_reader.check_due(now_secs())
    {
        // Failures are recorded and logged inside.
        let _ = record(state, &channel, check_upcoming(state, &channel).await).await;
    }
    Ok(())
}

/// Tell search engines the page changed (it appeared, changed or went):
/// Bing and Yandex take IndexNow pings. Only a public `https` site pings —
/// never dev or tests.
pub async fn ping_indexnow(state: &AppState, urls: Vec<String>) {
    let base = site_base(state);
    let Some(host) = indexable_host(base) else {
        return;
    };
    let body = json!({
        "host": host,
        "key": INDEXNOW_KEY,
        "keyLocation": format!("{base}/{INDEXNOW_KEY}.txt"),
        "urlList": urls,
    });
    match state.afisha_http.post_json(INDEXNOW_ENDPOINT, body).await {
        Ok(status) if status < 300 => {}
        Ok(status) => tracing::warn!(status, "afisha: IndexNow refused the ping"),
        Err(e) => tracing::warn!(error = ?e, "afisha: IndexNow ping failed"),
    }
}

/// The host of a public `https` origin; `None` for a local one.
fn indexable_host(base: &str) -> Option<&str> {
    let host = base.strip_prefix("https://")?.split('/').next()?;
    let local = host.is_empty() || host.starts_with("localhost") || host.starts_with("127.");
    (!local).then_some(host)
}

/// Mail the address the admin set for the «Афиша»; best effort — nothing to
/// send to while it is unset, and a failed send only logs.
async fn mail_admin(state: &AppState, subject: &str, body: &str) {
    let to = match state.settings.get(Setting::AfishaAdminEmail.key()).await {
        Ok(Some(to)) => to,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(error = ?e, "afisha: admin email setting unreadable");
            return;
        }
    };
    if let Err(e) = state.mailer.send(&to, subject, body).await {
        tracing::warn!(error = %e, "afisha: mail to the admin failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_https_sites_ping() {
        assert_eq!(
            indexable_host("https://quest.geohod.ru"),
            Some("quest.geohod.ru")
        );
        assert_eq!(indexable_host("http://quest.geohod.ru"), None);
        assert_eq!(indexable_host("https://localhost:3000"), None);
        assert_eq!(indexable_host("http://localhost:3000"), None);
    }

    #[test]
    fn page_addresses_follow_the_channel() {
        assert_eq!(feed_url("ch", None), "https://t.me/s/ch");
        assert_eq!(feed_url("ch", Some(10)), "https://t.me/s/ch?before=10");
        assert_eq!(embed_url("ch", 7), "https://t.me/ch/7?embed=1&mode=tme");
    }

    /// The key file the frontend serves must hold this very key.
    #[test]
    fn indexnow_key_file_is_served_by_the_frontend() {
        let path = format!(
            "{}/../frontend/public/{INDEXNOW_KEY}.txt",
            env!("CARGO_MANIFEST_DIR")
        );
        let served = std::fs::read_to_string(path).expect("key file in frontend/public");
        assert_eq!(served.trim(), INDEXNOW_KEY);
    }
}
