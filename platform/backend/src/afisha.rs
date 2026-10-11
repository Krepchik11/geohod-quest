//! «Афиша»: the owner's group walks and group quests on the site, taken from
//! the public web page of the Telegram channel they are announced in.
//!
//! The channel stays the one place announcements are written and checked:
//! organizers send a post to the channel admin, the admin publishes it and
//! adds `#hiking` (a walk) or `#quest` (a group quest). The site reads the
//! channel's public page (`t.me/s/<channel>`, see `crate::afisha_reader`) and
//! turns every tagged post into a page. Nothing in this module talks to the
//! network — it is the pure part: reading the page markup, reading a post's
//! template, and deciding what an announcement looks like after a (re-)read.

use std::borrow::Cow;
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::admin_stats::{day_from_unix, parse_day};
use crate::errors::AppError;

/// The registration bot: a post linking to it announces the owner's own event.
pub const REGISTER_BOT: &str = "t.me/geohodton_bot";

/// Length assumed when a post names none — when the event counts as past and
/// what the page gives as its end.
const DEFAULT_DURATION_MIN: i64 = 180;

/// Cities on UTC+3 all year; every other city is on Central European time
/// (the channel is about Serbia).
const UTC3_CITIES: [&str; 3] = ["Стамбул", "Москва", "Istanbul"];

/// Longest title / one-line field / description the admin form accepts.
const MAX_TITLE_CHARS: usize = 200;
const MAX_LINE_CHARS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 5000;

/// What an announcement is about — the hashtag the admin adds to the post.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaKind"))]
#[serde(rename_all = "snake_case")]
pub enum AfishaKind {
    /// A walk or a hike (`#hiking`).
    Hiking,
    /// A group quest (`#quest`).
    Quest,
}

impl AfishaKind {
    const ALL: [Self; 2] = [Self::Hiking, Self::Quest];

    /// The hashtag that files a post under this kind.
    pub fn hashtag(self) -> &'static str {
        match self {
            Self::Hiking => "#hiking",
            Self::Quest => "#quest",
        }
    }

    /// The kind the post's hashtag names; the earlier tag wins when both appear.
    pub fn from_text(text: &str) -> Option<Self> {
        let lower = text.to_lowercase();
        Self::ALL
            .into_iter()
            .filter_map(|kind| find_tag(&lower, kind.hashtag()).map(|at| (at, kind)))
            .min_by_key(|(at, _)| *at)
            .map(|(_, kind)| kind)
    }

    /// The kind of an old, untagged post: a group quest when it says so.
    pub fn guess(text: &str) -> Self {
        if text.to_lowercase().contains("квест") {
            Self::Quest
        } else {
            Self::Hiking
        }
    }
}

/// Byte position of `tag` in `lower` as a whole hashtag, not the start of a
/// longer one (`#hikingclub`).
fn find_tag(lower: &str, tag: &str) -> Option<usize> {
    lower.match_indices(tag).map(|(at, _)| at).find(|&at| {
        lower[at + tag.len()..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
    })
}

/// Where an announcement stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaStatus"))]
#[serde(rename_all = "snake_case")]
pub enum AfishaStatus {
    /// On the site.
    Published,
    /// Tagged, but the date, time or city did not parse: waits for the admin.
    Draft,
    /// Taken off the site by the admin; a re-read never brings it back.
    Hidden,
    /// Has a registration link but no hashtag: listed for the admin only.
    Untagged,
    /// The post is gone from the channel.
    Removed,
}

/// What an announcement says, as read from the post's template or set by the
/// admin. Every value is the post's own wording; only the date and the time
/// are normalized (`YYYY-MM-DD`, `HH:MM`, local to the city).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "AfishaFieldsWire"))]
pub struct EventFields {
    pub title: String,
    pub date: Option<String>,
    pub time: Option<String>,
    pub city: Option<String>,
    /// The meeting point without the city.
    pub place: Option<String>,
    pub distance: Option<String>,
    pub duration: Option<String>,
    pub route: Option<String>,
    pub difficulty: Option<String>,
    /// Who leads it («С кем» / «Организатор»).
    pub guide: Option<String>,
    pub price: Option<String>,
    pub expenses: Option<String>,
    pub bring: Option<String>,
    pub description: Option<String>,
}

/// Apply `$m!` to every field name of [`EventFields`] — the one list the
/// merge, the diff and the validation walk.
macro_rules! each_optional_field {
    ($m:ident) => {
        $m!(
            date,
            time,
            city,
            place,
            distance,
            duration,
            route,
            difficulty,
            guide,
            price,
            expenses,
            bring,
            description
        )
    };
}

impl EventFields {
    /// Take every field of `fresh` except those the admin set by hand.
    fn keep_edited(&mut self, fresh: Self, edited: &BTreeSet<String>) {
        if !edited.contains("title") {
            self.title = fresh.title;
        }
        macro_rules! take {
            ($($f:ident),*) => {
                $(if !edited.contains(stringify!($f)) {
                    self.$f = fresh.$f;
                })*
            };
        }
        each_optional_field!(take);
    }

    /// Names of the fields whose value differs from `other`.
    fn changed(&self, other: &Self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.title != other.title {
            out.push("title");
        }
        macro_rules! diff {
            ($($f:ident),*) => {
                $(if self.$f != other.$f {
                    out.push(stringify!($f));
                })*
            };
        }
        each_optional_field!(diff);
        out
    }

    /// The admin's form as stored: every value trimmed, blank meaning none.
    ///
    /// # Errors
    ///
    /// `AppError::BadRequest` for a blank or too long title, a date that is
    /// not a real `YYYY-MM-DD`, a time that is not `HH:MM`, or a field longer
    /// than the form allows.
    pub fn normalized(mut self) -> Result<Self, AppError> {
        self.title = self.title.trim().to_string();
        if self.title.is_empty() {
            return Err(AppError::BadRequest("введите название".into()));
        }
        if self.title.chars().count() > MAX_TITLE_CHARS {
            return Err(AppError::BadRequest(format!(
                "название длиннее {MAX_TITLE_CHARS} символов"
            )));
        }
        macro_rules! trim {
            ($($f:ident),*) => {
                $(self.$f = self.$f.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);)*
            };
        }
        each_optional_field!(trim);
        if self.date.as_deref().is_some_and(|d| parse_day(d).is_none()) {
            return Err(AppError::BadRequest(
                "дата должна быть в виде ГГГГ-ММ-ДД".into(),
            ));
        }
        if self
            .time
            .as_deref()
            .is_some_and(|t| minute_of_day(t).is_none())
        {
            return Err(AppError::BadRequest(
                "время должно быть в виде ЧЧ:ММ".into(),
            ));
        }
        let too_long = |value: &Option<String>, max: usize| {
            value.as_deref().is_some_and(|v| v.chars().count() > max)
        };
        if too_long(&self.description, MAX_DESCRIPTION_CHARS) {
            return Err(AppError::BadRequest(format!(
                "описание длиннее {MAX_DESCRIPTION_CHARS} символов"
            )));
        }
        let lines = [
            &self.city,
            &self.place,
            &self.distance,
            &self.duration,
            &self.route,
            &self.difficulty,
            &self.guide,
            &self.price,
            &self.expenses,
            &self.bring,
        ];
        if lines.into_iter().any(|v| too_long(v, MAX_LINE_CHARS)) {
            return Err(AppError::BadRequest(format!(
                "поле длиннее {MAX_LINE_CHARS} символов"
            )));
        }
        Ok(self)
    }
}

/// One announcement as stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AfishaEvent {
    /// The channel the post was read from (its public name).
    pub channel: String,
    /// The post's number in the channel.
    pub post_id: i64,
    pub status: AfishaStatus,
    /// `None` until a hashtag (or the admin) says what it is.
    pub kind: Option<AfishaKind>,
    pub fields: EventFields,
    /// Field names (plus `kind`) the admin set by hand; a re-read post never
    /// overwrites them.
    #[serde(default)]
    pub edited: BTreeSet<String>,
    /// Media URL of the post's picture, copied into the site's media store.
    pub image: Option<String>,
    pub register_url: Option<String>,
    /// The post text as last read: the same text again changes nothing.
    pub post_text: String,
    /// When the post appeared in the channel (RFC3339 UTC).
    pub posted_at: String,
    /// Why a draft is a draft («нет даты, времени»).
    pub problem: Option<String>,
    /// Clicks on «Записаться»: counted by the store, never part of the body.
    #[serde(skip)]
    pub clicks: u64,
}

impl AfishaEvent {
    /// A post seen for the first time, before its text is applied.
    fn blank(channel: &str, post: &ChannelPost) -> Self {
        Self {
            channel: channel.to_string(),
            post_id: post.id,
            status: AfishaStatus::Untagged,
            kind: None,
            fields: EventFields::default(),
            edited: BTreeSet::new(),
            image: None,
            register_url: None,
            post_text: String::new(),
            posted_at: post.posted_at.clone(),
            problem: None,
            clicks: 0,
        }
    }

    /// Recompute the status from the kind and the fields. A hidden
    /// announcement stays hidden — only the admin shows it again.
    fn settle(&mut self) {
        self.problem = missing_fields(&self.fields);
        if self.status == AfishaStatus::Hidden {
            return;
        }
        self.status = match (self.kind, &self.problem) {
            (None, _) => AfishaStatus::Untagged,
            (Some(_), Some(_)) => AfishaStatus::Draft,
            (Some(_), None) => AfishaStatus::Published,
        };
    }

    /// Apply the admin's form: the fields that differ from the current ones
    /// (and the kind, when it changed) are marked as set by hand.
    ///
    /// # Errors
    ///
    /// `AppError::BadRequest` when the form does not validate
    /// ([`EventFields::normalized`]).
    pub fn edit(&mut self, kind: Option<AfishaKind>, fields: EventFields) -> Result<(), AppError> {
        let fields = fields.normalized()?;
        let changed = self.fields.changed(&fields);
        self.edited.extend(changed.into_iter().map(str::to_string));
        if kind != self.kind {
            self.edited.insert("kind".to_string());
            self.kind = kind;
        }
        self.fields = fields;
        self.settle();
        Ok(())
    }

    /// Take the announcement off the site.
    pub fn hide(&mut self) {
        self.status = AfishaStatus::Hidden;
    }

    /// Bring a hidden announcement back: it lands wherever its kind and
    /// fields put it (published, draft or untagged).
    pub fn show(&mut self) {
        self.status = AfishaStatus::Draft;
        self.settle();
    }

    /// The post was deleted from the channel.
    pub fn remove(&mut self) {
        self.status = AfishaStatus::Removed;
    }

    /// The URL path segment of the page: date, title words and the post
    /// number, which alone identifies it (`2026-10-11-progulyaemsya-1110`).
    pub fn slug(&self) -> String {
        let mut parts: Vec<String> = Vec::with_capacity(3);
        if let Some(date) = &self.fields.date {
            parts.push(date.clone());
        }
        let words = translit_slug(&self.fields.title);
        if !words.is_empty() {
            parts.push(truncate_slug(&words, 60).to_string());
        }
        parts.push(self.post_id.to_string());
        parts.join("-")
    }

    /// When it starts and ends; `None` without a date and a time.
    pub fn schedule(&self) -> Option<Schedule> {
        schedule(&self.fields)
    }

    /// Over already: the end has passed. An announcement without a schedule
    /// is never past.
    pub fn is_past(&self, now_secs: i64) -> bool {
        self.schedule().is_some_and(|s| now_secs >= s.end_utc)
    }

    /// The post in the channel.
    pub fn post_url(&self) -> String {
        format!("https://t.me/{}/{}", self.channel, self.post_id)
    }
}

/// «нет даты, времени, города» — what keeps a tagged post a draft.
fn missing_fields(fields: &EventFields) -> Option<String> {
    let missing: Vec<&str> = [
        (fields.date.is_none(), "даты"),
        (fields.time.is_none(), "времени"),
        (fields.city.is_none(), "города"),
    ]
    .into_iter()
    .filter_map(|(absent, name)| absent.then_some(name))
    .collect();
    (!missing.is_empty()).then(|| format!("нет {}", missing.join(", ")))
}

/// One post as the channel's public page shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct ChannelPost {
    pub id: i64,
    /// RFC3339 UTC.
    pub posted_at: String,
    /// Plain text: line breaks kept, markup and entities resolved.
    pub text: String,
    /// Every link in the text, in order.
    pub links: Vec<String>,
    /// The first picture (a photo, or a video's cover).
    pub photo: Option<String>,
}

impl ChannelPost {
    /// An announcement of the owner's template — «Место встречи» and a date
    /// in its first line — and no partner's post: what the archive takes.
    pub fn is_announcement(&self) -> bool {
        let lower = self.text.to_lowercase();
        let first_line = self.text.lines().map(str::trim).find(|l| !l.is_empty());
        lower.contains("место встречи")
            && !lower.contains("#партнерский")
            && first_line.is_some_and(|line| find_date(line).is_some())
    }

    /// Worth storing at all: tagged, or announcing an own event (the link to
    /// the registration bot) whose tag the admin may have forgotten.
    pub fn is_candidate(&self) -> bool {
        AfishaKind::from_text(&self.text).is_some() || register_link(&self.links).is_some()
    }
}

/// Every post on a channel page — the feed (`t.me/s/<channel>`), a search
/// result or one post's embed page — in page order. Posts without text (a
/// bare picture, a poll) are skipped.
pub fn parse_channel_page(html: &str) -> Vec<ChannelPost> {
    html.split("data-post=\"")
        .skip(1)
        .filter_map(parse_post)
        .collect()
}

/// Whether an embed page says the post does not exist.
pub fn is_missing_post(html: &str) -> bool {
    html.contains("tgme_widget_message_error")
}

/// The post `"<channel>/<id>"…` that starts `chunk` (the markup up to the next
/// post).
fn parse_post(chunk: &str) -> Option<ChannelPost> {
    let (path, rest) = chunk.split_once('"')?;
    let id = path.rsplit('/').next()?.parse().ok()?;
    let text_html = element_inner(rest, "class=\"tgme_widget_message_text")?;
    let posted_at = attr_value(rest, "datetime=\"").and_then(utc_stamp)?;
    Some(ChannelPost {
        id,
        posted_at,
        text: html_to_text(text_html),
        links: hrefs(text_html),
        photo: photo_url(rest),
    })
}

/// The inner markup of the first `<div>` whose opening tag contains `marker`
/// (the text block holds no nested `<div>`).
fn element_inner<'a>(html: &'a str, marker: &str) -> Option<&'a str> {
    let start = html.find(marker)?;
    let open_end = start + html[start..].find('>')? + 1;
    let close = open_end + html[open_end..].find("</div>")?;
    Some(&html[open_end..close])
}

/// The value of the first `name="` attribute, up to its closing quote.
fn attr_value<'a>(html: &'a str, name: &str) -> Option<&'a str> {
    let start = html.find(name)? + name.len();
    let end = html[start..].find('"')?;
    Some(&html[start..start + end])
}

/// Telegram's `2026-10-07T12:37:49+00:00` as the platform's
/// `2026-10-07T12:37:49Z`. The page always states UTC.
fn utc_stamp(raw: &str) -> Option<String> {
    let stamp = raw.get(..19)?;
    let rest = &raw[19..];
    (stamp.as_bytes()[10] == b'T' && matches!(rest, "+00:00" | "Z")).then(|| format!("{stamp}Z"))
}

/// The picture of a post: a photo, else a video's cover.
fn photo_url(html: &str) -> Option<String> {
    const URL_START: &str = "background-image:url('";
    [
        "tgme_widget_message_photo_wrap",
        "tgme_widget_message_video_thumb",
    ]
    .into_iter()
    .find_map(|marker| {
        let rest = &html[html.find(marker)?..];
        let url_at = rest.find(URL_START)? + URL_START.len();
        let url = &rest[url_at..url_at + rest[url_at..].find('\'')?];
        url.starts_with("https://").then(|| url.to_string())
    })
}

/// Every `href` in the markup, entities resolved.
fn hrefs(html: &str) -> Vec<String> {
    html.split("href=\"")
        .skip(1)
        .filter_map(|rest| rest.split_once('"'))
        .map(|(url, _)| decode_entities(url).into_owned())
        .collect()
}

/// Markup to plain text: `<br>` becomes a line break, every other tag goes,
/// entities resolve and no-break spaces become plain ones.
fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        out.push_str(&decode_entities(&rest[..lt]));
        let Some(gt) = rest[lt..].find('>') else {
            rest = "";
            break;
        };
        let tag = rest[lt + 1..lt + gt].trim_end_matches('/').trim();
        if tag == "br" || tag.starts_with("br ") {
            out.push('\n');
        }
        rest = &rest[lt + gt + 1..];
    }
    out.push_str(&decode_entities(rest));
    out.replace('\u{a0}', " ")
}

/// Resolve the HTML entities Telegram writes (named and numeric).
fn decode_entities(s: &str) -> Cow<'_, str> {
    if !s.contains('&') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let decoded = tail
            .find(';')
            .filter(|&semi| semi <= 10)
            .and_then(|semi| entity(&tail[1..semi]).map(|c| (c, semi)));
        match decoded {
            Some((c, semi)) => {
                out.push(c);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some('\u{a0}'),
        _ => {
            let code = name.strip_prefix('#')?;
            let n = match code.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => code.parse().ok()?,
            };
            char::from_u32(n)
        }
    }
}

/// The link to the registration bot, as an `https://` URL.
pub fn register_link(links: &[String]) -> Option<String> {
    links.iter().find(|l| l.contains(REGISTER_BOT)).map(|l| {
        if l.starts_with("http") {
            l.clone()
        } else {
            format!("https://{}", l.trim_start_matches('/'))
        }
    })
}

/// The labelled lines of the announcement template.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Label {
    Place,
    Time,
    Distance,
    Duration,
    Route,
    Difficulty,
    Guide,
    Price,
    Expenses,
    Bring,
}

impl Label {
    /// The label a line starts with (`Время встречи:`), case and ё ignored.
    fn of(line: &str) -> Option<(Self, &str)> {
        let (label, value) = line.split_once(':')?;
        let key = label.to_lowercase().replace('ё', "е");
        let key = key.split_whitespace().collect::<Vec<_>>().join(" ");
        let label = match key.as_str() {
            "место встречи" | "место сбора" | "место старта" => {
                Self::Place
            }
            "время" | "время встречи" | "время старта" | "начало" => {
                Self::Time
            }
            "протяженность" | "дистанция" => Self::Distance,
            "длительность" | "продолжительность" => Self::Duration,
            "маршрут" => Self::Route,
            "сложность" => Self::Difficulty,
            "с кем" | "организатор" | "ведущий" | "гид" => Self::Guide,
            "стоимость" | "цена" => Self::Price,
            "личные расходы" | "расходы" => Self::Expenses,
            "что взять" | "что взять с собой" => Self::Bring,
            _ => return None,
        };
        Some((label, value))
    }
}

/// Read the announcement template. A post that does not follow it yields
/// what it has — the title is always its first line.
///
/// # Arguments
///
/// * `text` - The post as plain text ([`ChannelPost::text`])
/// * `known_cities` - The site's cities, so «Петроварадин (г.Нови Сад)» finds
///   «Нови Сад» and «Нови-Сад» is spelt the site's way
pub fn parse_fields(text: &str, known_cities: &[String]) -> EventFields {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut fields = EventFields::default();
    let Some(title_at) = lines.iter().position(|l| !l.is_empty()) else {
        return fields;
    };
    (fields.date, fields.title) = title_line(lines[title_at]);
    let mut first_label = None;
    for (at, line) in lines.iter().enumerate().skip(title_at + 1) {
        let Some((label, raw)) = Label::of(line) else {
            continue;
        };
        first_label.get_or_insert(at);
        let value = clean_value(raw);
        let slot = match label {
            Label::Place => {
                if fields.city.is_none() && fields.place.is_none() {
                    (fields.city, fields.place) = split_place(&value, known_cities);
                }
                continue;
            }
            Label::Time => {
                if fields.time.is_none() {
                    fields.time = parse_time(&value);
                }
                continue;
            }
            Label::Distance => &mut fields.distance,
            Label::Duration => &mut fields.duration,
            Label::Route => &mut fields.route,
            Label::Difficulty => &mut fields.difficulty,
            Label::Guide => &mut fields.guide,
            Label::Price => &mut fields.price,
            Label::Expenses => &mut fields.expenses,
            Label::Bring => &mut fields.bring,
        };
        if slot.is_none() && !value.is_empty() {
            *slot = Some(value);
        }
    }
    if fields.city.is_none() {
        // «Место встречи: Лиманский парк» — the title may still name the city.
        fields.city = known_city_in(lines[title_at], known_cities);
    }
    fields.description = description(&lines, title_at, first_label);
    fields
}

/// The date and the title of the first line: «В субботу 10.10.2026 гуляем по
/// лесу» → (`2026-10-10`, «Гуляем по лесу»).
fn title_line(line: &str) -> (Option<String>, String) {
    match find_date(line) {
        Some((date, start, end)) => {
            let after = line[end..].trim();
            let raw = if after.is_empty() {
                line[..start].trim()
            } else {
                after
            };
            (Some(date), clean_title(raw))
        }
        None => (None, clean_title(line)),
    }
}

/// The first `DD.MM.YYYY` in `line`: the ISO date and its byte span.
fn find_date(line: &str) -> Option<(String, usize, usize)> {
    let b = line.as_bytes();
    (0..b.len()).find_map(|start| {
        if start > 0 && b[start - 1].is_ascii_digit() {
            return None;
        }
        let (day, at) = digit_run(b, start, 1..=2)?;
        let (month, at) = digit_run(b, expect(b, at, b'.')?, 1..=2)?;
        let (year, end) = digit_run(b, expect(b, at, b'.')?, 4..=4)?;
        if b.get(end).is_some_and(u8::is_ascii_digit) {
            return None;
        }
        let iso = format!("{year:04}-{month:02}-{day:02}");
        parse_day(&iso).map(|_| (iso, start, end))
    })
}

/// The number written by the ASCII digits at `start`, when there are as many
/// as `len` allows; returns it with the index past it.
fn digit_run(b: &[u8], start: usize, len: std::ops::RangeInclusive<usize>) -> Option<(u32, usize)> {
    let count = b
        .get(start..)?
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count();
    if !len.contains(&count) {
        return None;
    }
    let value = std::str::from_utf8(&b[start..start + count])
        .ok()?
        .parse()
        .ok()?;
    Some((value, start + count))
}

/// The index past `byte` when it stands at `at`.
fn expect(b: &[u8], at: usize, byte: u8) -> Option<usize> {
    (b.get(at) == Some(&byte)).then_some(at + 1)
}

/// The first `H:MM` / `HH.MM` in a value, as `HH:MM`.
fn parse_time(value: &str) -> Option<String> {
    let b = value.as_bytes();
    (0..b.len()).find_map(|start| {
        if start > 0 && b[start - 1].is_ascii_digit() {
            return None;
        }
        let (hour, at) = digit_run(b, start, 1..=2)?;
        let sep = match b.get(at) {
            Some(b':' | b'.') => at + 1,
            _ => return None,
        };
        let (minute, _) = digit_run(b, sep, 2..=2)?;
        let time = format!("{hour:02}:{minute:02}");
        minute_of_day(&time).map(|_| time)
    })
}

/// Minutes since midnight of a strict `HH:MM`.
fn minute_of_day(time: &str) -> Option<i64> {
    let (h, m) = time.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (i64, i64) = (h.parse().ok()?, m.parse().ok()?);
    ((0..24).contains(&h) && (0..60).contains(&m)).then_some(h * 60 + m)
}

/// A title as the page shows it: symbols and emoji gone, a shouted tail
/// («… - ИГРАТЬ») dropped, trailing punctuation trimmed, first letter capital.
fn clean_title(raw: &str) -> String {
    const PUNCTUATION: &str = ".,:;!?«»\"'()-–—№";
    let kept: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || PUNCTUATION.contains(*c))
        .collect();
    let mut title = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    for dash in [" - ", " – ", " — "] {
        if let Some((head, tail)) = title.rsplit_once(dash) {
            let shouted =
                tail.chars().any(char::is_alphabetic) && !tail.chars().any(char::is_lowercase);
            if shouted {
                title = head.to_string();
            }
        }
    }
    let title = title.trim_end_matches(|c: char| ".,:;-–— ".contains(c));
    let mut chars = title.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// A labelled value: emoji in front and a closing full stop dropped.
fn clean_value(raw: &str) -> String {
    let value = raw
        .trim()
        .trim_start_matches(|c: char| !(c.is_alphanumeric() || "«(\"".contains(c)));
    let value = value.trim();
    match value.strip_suffix('.') {
        Some(rest) if !rest.ends_with('.') => rest.trim_end().to_string(),
        _ => value.to_string(),
    }
}

/// Lowercase letters and digits only, ё as е — how two spellings of a city
/// («Нови-Сад», «нови сад») meet. Mirrors `cityKey` in the frontend.
pub fn city_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ё' { 'е' } else { c })
        .collect()
}

/// Split «Нови Сад, Лиманский парк» into the city and the meeting point. A
/// known city named anywhere in the value wins (the earliest one); otherwise
/// the city is what stands before the first comma — when that reads like a
/// city name ([`city_like`]), not like «Лиманский парк на площади».
fn split_place(value: &str, known_cities: &[String]) -> (Option<String>, Option<String>) {
    let value = value.trim();
    if value.is_empty() {
        return (None, None);
    }
    let (head, tail) = value
        .split_once(',')
        .map_or((value, ""), |(h, t)| (h.trim(), t.trim()));
    let city = known_city_in(value, known_cities).or_else(|| city_like(head).map(str::to_string));
    let place = match &city {
        Some(city) if city_key(head) == city_key(city) => {
            (!tail.is_empty()).then(|| tail.to_string())
        }
        _ => Some(value.to_string()),
    };
    (city, place)
}

/// The site's city named earliest in `text` («г.Нови Сад», «в Белграде»).
fn known_city_in(text: &str, known_cities: &[String]) -> Option<String> {
    let text_key = city_key(text);
    known_cities
        .iter()
        .filter_map(|city| {
            let key = city_key(city);
            (!key.is_empty())
                .then(|| text_key.find(&key))
                .flatten()
                .map(|at| (at, city))
        })
        .min_by_key(|(at, _)| *at)
        .map(|(_, city)| city.clone())
}

/// The city name a meeting point starts with: brackets and a leading «г.»
/// dropped, at most three words, each capitalized («Сремски Карловци»).
fn city_like(head: &str) -> Option<&str> {
    let bare = head.split('(').next().unwrap_or_default().trim();
    let bare = bare
        .strip_prefix("г.")
        .or_else(|| bare.strip_prefix("г "))
        .unwrap_or(bare)
        .trim();
    let words: Vec<&str> = bare.split_whitespace().collect();
    let named = (1..=3).contains(&words.len())
        && words
            .iter()
            .all(|w| w.chars().next().is_some_and(char::is_uppercase));
    named.then_some(bare)
}

/// A line made only of 〰️ — the template's frame around the description.
fn is_separator(line: &str) -> bool {
    let mut wavy = false;
    for c in line.chars() {
        match c {
            '〰' => wavy = true,
            '\u{fe0f}' => {}
            c if c.is_whitespace() => {}
            _ => return false,
        }
    }
    wavy
}

/// The description: what the 〰️ frame holds, or else the lines between the
/// title and the first labelled line. Hashtags and leading emoji go.
fn description(lines: &[&str], title_at: usize, first_label: Option<usize>) -> Option<String> {
    let separators: Vec<usize> = (0..lines.len())
        .filter(|&i| is_separator(lines[i]))
        .collect();
    let body = match separators.first() {
        Some(&open) => &lines[open + 1..separators.get(1).copied().unwrap_or(lines.len())],
        None => &lines[title_at + 1..first_label.unwrap_or(title_at + 1).max(title_at + 1)],
    };
    let kept: Vec<String> = body
        .iter()
        .map(|line| {
            let words: Vec<&str> = line
                .split_whitespace()
                .filter(|w| AfishaKind::from_text(w).is_none())
                .collect();
            let line = words.join(" ");
            line.trim_start_matches(|c: char| !(c.is_alphanumeric() || "«(\"".contains(c)))
                .to_string()
        })
        .collect();
    let text = kept.join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// When an announcement happens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Schedule {
    /// Unix seconds.
    pub start_utc: i64,
    pub end_utc: i64,
    /// The city's offset from UTC at the start, in minutes.
    pub offset_min: i64,
}

impl Schedule {
    /// `2026-10-11T12:45:00+02:00` — the instant in the city's local time.
    pub fn start_local(&self) -> String {
        local_stamp(self.start_utc, self.offset_min)
    }

    pub fn end_local(&self) -> String {
        local_stamp(self.end_utc, self.offset_min)
    }
}

fn local_stamp(utc: i64, offset_min: i64) -> String {
    let local = crate::store::rfc3339_from_unix((utc + offset_min * 60).max(0) as u64);
    let sign = if offset_min < 0 { '-' } else { '+' };
    let off = offset_min.abs();
    format!("{}{sign}{:02}:{:02}", &local[..19], off / 60, off % 60)
}

/// Start and end of the event; `None` without a date and a time.
pub fn schedule(fields: &EventFields) -> Option<Schedule> {
    let day = parse_day(fields.date.as_deref()?)? / 86_400;
    let minute = minute_of_day(fields.time.as_deref()?)?;
    let offset_min = utc_offset_min(fields.city.as_deref(), day, minute);
    let start_utc = day * 86_400 + minute * 60 - offset_min * 60;
    let length = fields
        .duration
        .as_deref()
        .and_then(duration_minutes)
        .unwrap_or(DEFAULT_DURATION_MIN);
    Some(Schedule {
        start_utc,
        end_utc: start_utc + length * 60,
        offset_min,
    })
}

/// «4 часа» → 240, «1,5 часа» → 90, «90 минут» → 90: the first number,
/// in hours unless the value speaks of minutes only.
fn duration_minutes(text: &str) -> Option<i64> {
    let lower = text.to_lowercase();
    let start = lower.find(|c: char| c.is_ascii_digit())?;
    let number: String = lower[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ',' || *c == '.')
        .collect();
    let value: f64 = number
        .replace(',', ".")
        .trim_end_matches('.')
        .parse()
        .ok()?;
    let minutes = if lower.contains("мин") && !lower.contains("час") {
        value
    } else {
        value * 60.0
    };
    (1.0..=4320.0)
        .contains(&minutes)
        .then(|| minutes.round() as i64)
}

/// Minutes east of UTC of the wall clock in `city` on `day` (days since the
/// epoch) at `minute` past midnight. Central European time follows the EU
/// rule: summer time from 01:00 UTC on the last Sunday of March to 01:00 UTC
/// on the last Sunday of October.
fn utc_offset_min(city: Option<&str>, day: i64, minute: i64) -> i64 {
    if city.is_some_and(|c| UTC3_CITIES.iter().any(|f| city_key(f) == city_key(c))) {
        return 180;
    }
    let year: i64 = day_from_unix(day * 86_400)[..4].parse().unwrap_or(1970);
    let (Some(spring), Some(autumn)) = (last_sunday(year, 3), last_sunday(year, 10)) else {
        return 60;
    };
    let as_winter_utc = day * 86_400 + minute * 60 - 3600;
    let summer = spring * 86_400 + 3600..autumn * 86_400 + 3600;
    if summer.contains(&as_winter_utc) {
        120
    } else {
        60
    }
}

/// Days since the epoch of the last Sunday of a 31-day month.
fn last_sunday(year: i64, month: u32) -> Option<i64> {
    let last = parse_day(&format!("{year:04}-{month:02}-31"))? / 86_400;
    // 1970-01-01 was a Thursday: (days + 4) % 7 counts from Sunday = 0.
    Some(last - (last + 4).rem_euclid(7))
}

/// Latin URL words of a Russian or Serbian text: «Врдничка кула» →
/// `vrdnichka-kula`.
pub fn translit_slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        let latin = match c {
            'а' => "a",
            'б' => "b",
            'в' => "v",
            'г' => "g",
            'д' => "d",
            'е' | 'ё' | 'э' => "e",
            'ж' => "zh",
            'з' => "z",
            'и' => "i",
            'й' | 'ы' => "y",
            'к' => "k",
            'л' => "l",
            'м' => "m",
            'н' => "n",
            'о' => "o",
            'п' => "p",
            'р' => "r",
            'с' => "s",
            'т' => "t",
            'у' => "u",
            'ф' => "f",
            'х' => "h",
            'ц' => "ts",
            'ч' => "ch",
            'ш' => "sh",
            'щ' => "sch",
            'ъ' | 'ь' => "",
            'ю' => "yu",
            'я' => "ya",
            'ђ' | 'đ' => "dj",
            'ј' => "j",
            'љ' => "lj",
            'њ' => "nj",
            'ћ' | 'č' | 'ć' => "c",
            'џ' => "dz",
            'š' => "s",
            'ž' => "z",
            c if c.is_ascii_alphanumeric() => {
                out.push(c);
                continue;
            }
            _ => "-",
        };
        out.push_str(latin);
    }
    out.split('-')
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// At most `max` bytes of a slug, cut at a word boundary.
fn truncate_slug(slug: &str, max: usize) -> &str {
    if slug.len() <= max {
        return slug;
    }
    slug[..=max]
        .rfind('-')
        .map_or(&slug[..max], |at| &slug[..at])
}

/// Apply a (re-)read post to its announcement: the fields the admin did not
/// edit follow the text, the kind follows the hashtag unless the admin set
/// it, and the status follows from both (a hidden one stays hidden, a removed
/// one that shows up again comes back).
///
/// # Arguments
///
/// * `existing` - The stored announcement, `None` for a post seen first
/// * `channel` - The channel the post was read from
/// * `post` - The post as read
/// * `known_cities` - The site's cities ([`parse_fields`])
/// * `image` - The post's picture copied to the media store; `None` keeps the
///   stored one while the post still has a picture (a failed copy), and
///   clears it once the post has none
pub fn apply_post(
    existing: Option<&AfishaEvent>,
    channel: &str,
    post: &ChannelPost,
    known_cities: &[String],
    image: Option<String>,
) -> AfishaEvent {
    let mut event = existing
        .cloned()
        .unwrap_or_else(|| AfishaEvent::blank(channel, post));
    let fresh = parse_fields(&post.text, known_cities);
    event.fields.keep_edited(fresh, &event.edited);
    if !event.edited.contains("kind") {
        event.kind = AfishaKind::from_text(&post.text);
    }
    event.register_url = register_link(&post.links);
    event.post_text = post.text.clone();
    event.posted_at = post.posted_at.clone();
    match (image, post.photo.is_some()) {
        (Some(url), _) => event.image = Some(url),
        (None, false) => event.image = None,
        (None, true) => {}
    }
    if event.status == AfishaStatus::Removed {
        event.status = AfishaStatus::Untagged;
    }
    event.settle();
    event
}

/// A post the admin imported by its link: an untagged one is filed under a
/// guessed kind, marked as set by hand so a re-read keeps it.
pub fn file_imported(event: &mut AfishaEvent) {
    if event.kind.is_none() {
        event.kind = Some(AfishaKind::guess(&event.post_text));
        event.edited.insert("kind".to_string());
        event.settle();
    }
}

/// An old post from the archive import: a complete untagged post of a past
/// event is filed like an imported one. An upcoming one still waits for its
/// hashtag, and an incomplete one stays untagged — the archive makes no
/// drafts for the admin to chase.
pub fn file_archived(event: &mut AfishaEvent, now_secs: i64) {
    if event.is_past(now_secs) && missing_fields(&event.fields).is_none() {
        file_imported(event);
    }
}

/// The channel's public name from what the admin typed: `@name`,
/// `t.me/name` and `https://t.me/s/name/` all give `name`.
pub fn channel_name(raw: &str) -> Option<String> {
    let rest = raw.trim();
    let rest = rest
        .strip_prefix("https://")
        .or_else(|| rest.strip_prefix("http://"))
        .unwrap_or(rest);
    let rest = rest.strip_prefix("t.me/").unwrap_or(rest);
    let rest = rest.strip_prefix("s/").unwrap_or(rest);
    let name = rest.trim_start_matches('@').split(['/', '?']).next()?;
    let valid = (4..=32).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    valid.then(|| name.to_string())
}

/// The post number of a link to a post of `channel`
/// (`https://t.me/<channel>/1110`, the `/s/` page form too).
pub fn post_id_of_link(link: &str, channel: &str) -> Option<i64> {
    let rest = link.trim();
    let rest = rest
        .strip_prefix("https://")
        .or_else(|| rest.strip_prefix("http://"))
        .unwrap_or(rest)
        .strip_prefix("t.me/")?;
    let rest = rest.strip_prefix("s/").unwrap_or(rest);
    let (name, tail) = rest.split_once('/')?;
    if !name.eq_ignore_ascii_case(channel) {
        return None;
    }
    tail.split(['?', '/', '#']).next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = include_str!("../fixtures/afisha/feed.html");
    const OLDER: &str = include_str!("../fixtures/afisha/feed-older.html");
    const EMBED_1087: &str = include_str!("../fixtures/afisha/embed-1087.html");
    const EMBED_MISSING: &str = include_str!("../fixtures/afisha/embed-missing.html");

    fn cities() -> Vec<String> {
        vec!["Нови Сад".into(), "Белград".into(), "Стамбул".into()]
    }

    fn post(posts: &[ChannelPost], id: i64) -> &ChannelPost {
        posts.iter().find(|p| p.id == id).expect("post on the page")
    }

    fn text_post(text: &str) -> ChannelPost {
        ChannelPost {
            id: 7,
            posted_at: "2026-10-01T10:00:00Z".into(),
            text: text.into(),
            links: Vec::new(),
            photo: None,
        }
    }

    #[test]
    fn feed_page_yields_every_post_with_text_links_and_photo() {
        let posts = parse_channel_page(FEED);
        let ids: Vec<i64> = posts.iter().map(|p| p.id).collect();
        assert_eq!(ids, [1108, 1109, 1110, 1111, 1112, 1113]);

        let walk = post(&posts, 1110);
        assert_eq!(walk.posted_at, "2026-10-07T12:37:49Z");
        assert!(
            walk.text
                .starts_with("В воскресенье 11.10.2026 прогуляемся")
        );
        assert!(
            walk.text
                .contains("Место встречи: Нови Сад, Лиманский парк")
        );
        assert!(!walk.text.contains('<') && !walk.text.contains("&nbsp;"));
        assert!(
            walk.photo
                .as_deref()
                .is_some_and(|u| u.starts_with("https://cdn"))
        );
        assert_eq!(
            register_link(&walk.links).as_deref(),
            Some("https://t.me/geohodton_bot?startapp=AuBzZx4JZ00fgAgfWuYVL7E")
        );
        assert_eq!(AfishaKind::from_text(&walk.text), Some(AfishaKind::Hiking));
    }

    #[test]
    fn only_tagged_posts_and_own_events_are_candidates() {
        let posts = parse_channel_page(FEED);
        let candidates: Vec<i64> = posts
            .iter()
            .filter(|p| p.is_candidate())
            .map(|p| p.id)
            .collect();
        // 1109 links to the registration bot but has no tag; the partner
        // posts and the weekend digest are neither.
        assert_eq!(candidates, [1109, 1110, 1111]);
    }

    #[test]
    fn walk_template_reads_into_fields() {
        let posts = parse_channel_page(FEED);
        let f = parse_fields(&post(&posts, 1110).text, &cities());
        assert_eq!(f.title, "Прогуляемся к римской башне Врдничка кула");
        assert_eq!(f.date.as_deref(), Some("2026-10-11"));
        assert_eq!(f.time.as_deref(), Some("12:45"));
        assert_eq!(f.city.as_deref(), Some("Нови Сад"));
        assert_eq!(
            f.place.as_deref(),
            Some("Лиманский парк, на площади с флагами")
        );
        assert_eq!(f.distance.as_deref(), Some("7 км"));
        assert_eq!(f.duration.as_deref(), Some("5 часов"));
        assert_eq!(f.route.as_deref(), Some("линейный (старт тут, финиш тут)"));
        assert_eq!(f.difficulty.as_deref(), Some("средняя (дети от 10 лет)"));
        assert_eq!(f.guide.as_deref(), Some("Марьяна Постриган"));
        assert_eq!(f.price.as_deref(), Some("донат по желанию"));
        assert_eq!(f.expenses.as_deref(), Some("билет на городской автобус"));
        assert_eq!(f.bring.as_deref(), Some("читайте в Памятке"));
        let description = f.description.expect("framed description");
        assert!(description.starts_with("Маршрут начинается у смотровой площадки"));
        assert!(
            !description.contains("зарегистрируйтесь"),
            "the footer is not description"
        );
        assert!(!description.contains("#hiking"));
    }

    #[test]
    fn belgrade_walk_takes_the_city_before_the_comma() {
        let posts = parse_channel_page(FEED);
        let f = parse_fields(&post(&posts, 1111).text, &cities());
        assert_eq!(f.city.as_deref(), Some("Белград"));
        assert_eq!(f.time.as_deref(), Some("11:00"));
        assert_eq!(f.date.as_deref(), Some("2026-10-10"));
    }

    #[test]
    fn quest_template_finds_the_city_in_brackets_and_the_organizer() {
        let posts = parse_channel_page(EMBED_1087);
        let quest = post(&posts, 1087);
        let f = parse_fields(&quest.text, &cities());
        assert_eq!(
            f.title,
            "Гуляем по Петроварадинской крепости и проходим квест Тайна крепости"
        );
        assert_eq!(f.date.as_deref(), Some("2025-09-18"));
        assert_eq!(f.time.as_deref(), Some("16:00"));
        assert_eq!(f.city.as_deref(), Some("Нови Сад"));
        assert!(
            f.place
                .as_deref()
                .is_some_and(|p| p.starts_with("Петроварадин (г.Нови Сад)"))
        );
        assert_eq!(f.guide.as_deref(), Some("Сергей Шестак"));
        assert_eq!(f.price.as_deref(), Some("бесплатно"));
        assert_eq!(
            f.description.as_deref(),
            Some("Возрастных ограничений нет. Приходите с детьми.")
        );
        assert_eq!(AfishaKind::from_text(&quest.text), None);
        assert_eq!(AfishaKind::guess(&quest.text), AfishaKind::Quest);
    }

    #[test]
    fn missing_post_page_is_recognized() {
        assert!(is_missing_post(EMBED_MISSING));
        assert!(parse_channel_page(EMBED_MISSING).is_empty());
        assert!(!is_missing_post(EMBED_1087));
    }

    #[test]
    fn archive_takes_own_announcements_only() {
        let older = parse_channel_page(OLDER);
        assert_eq!(
            older.iter().map(|p| p.id).collect::<Vec<_>>(),
            [1078, 1079, 1081]
        );
        assert!(older.iter().all(ChannelPost::is_announcement));
        let feed = parse_channel_page(FEED);
        let taken: Vec<i64> = feed
            .iter()
            .filter(|p| p.is_announcement())
            .map(|p| p.id)
            .collect();
        // 1108 and 1112 are partners' posts, 1113 the weekend digest.
        assert_eq!(taken, [1109, 1110, 1111]);
    }

    #[test]
    fn unknown_city_falls_back_to_the_first_part() {
        let f = parse_fields(
            "В субботу 03.10.2026 идём в горы\nМесто встречи: Сремски Карловци, у собора.\nВремя: 9:30",
            &cities(),
        );
        assert_eq!(f.city.as_deref(), Some("Сремски Карловци"));
        assert_eq!(f.place.as_deref(), Some("у собора"));
        assert_eq!(f.time.as_deref(), Some("09:30"));
        let place = |value: &str| split_place(value, &[]);
        assert_eq!(
            place("г. Нови Сад, у вокзала").0.as_deref(),
            Some("Нови Сад")
        );
        assert_eq!(
            place("Петроварадин (г.Нови Сад), у входа").0.as_deref(),
            Some("Петроварадин")
        );
        let (city, at) = place("Лиманский парк на площади с флагами");
        assert_eq!(city, None, "a landmark is no city");
        assert_eq!(at.as_deref(), Some("Лиманский парк на площади с флагами"));
        assert_eq!(place("около Локомотива, г. Нови Сад").0, None);
        assert_eq!(
            split_place("около Локомотива, г. Нови Сад", &cities())
                .0
                .as_deref(),
            Some("Нови Сад"),
            "a known city is found anywhere"
        );
    }

    #[test]
    fn hashtags_are_whole_words_and_the_first_wins() {
        assert_eq!(
            AfishaKind::from_text("текст #Quest"),
            Some(AfishaKind::Quest)
        );
        assert_eq!(
            AfishaKind::from_text("#hiking и #quest"),
            Some(AfishaKind::Hiking)
        );
        assert_eq!(AfishaKind::from_text("#hikingclub"), None);
        assert_eq!(AfishaKind::from_text("без тегов"), None);
    }

    #[test]
    fn dates_and_times_are_validated() {
        assert_eq!(find_date("в 31.02.2026").map(|d| d.0), None);
        assert_eq!(
            find_date("с 1.5.2026 по").map(|d| d.0).as_deref(),
            Some("2026-05-01")
        );
        assert_eq!(
            parse_time("сбор в 7.05, старт 7:30").as_deref(),
            Some("07:05")
        );
        assert_eq!(parse_time("25:10"), None);
        assert_eq!(minute_of_day("12:45"), Some(765));
        assert_eq!(minute_of_day("1:45"), None);
    }

    #[test]
    fn durations_read_hours_and_minutes() {
        assert_eq!(duration_minutes("4 часа"), Some(240));
        assert_eq!(duration_minutes("1,5 часа"), Some(90));
        assert_eq!(duration_minutes("90 минут"), Some(90));
        assert_eq!(duration_minutes("весь день"), None);
    }

    #[test]
    fn central_european_summer_time_follows_the_eu_rule() {
        let fields = |date: &str, time: &str, city: &str| EventFields {
            date: Some(date.into()),
            time: Some(time.into()),
            city: Some(city.into()),
            duration: Some("2 часа".into()),
            ..EventFields::default()
        };
        let summer = schedule(&fields("2026-10-11", "12:45", "Нови Сад")).expect("schedule");
        assert_eq!(summer.start_local(), "2026-10-11T12:45:00+02:00");
        assert_eq!(summer.end_local(), "2026-10-11T14:45:00+02:00");
        // Summer time ends on the last Sunday of October 2026 (the 25th).
        let winter = schedule(&fields("2026-10-25", "12:00", "Белград")).expect("schedule");
        assert_eq!(winter.start_local(), "2026-10-25T12:00:00+01:00");
        let spring = schedule(&fields("2026-03-29", "10:00", "Нови Сад")).expect("schedule");
        assert_eq!(spring.offset_min, 120);
        let istanbul = schedule(&fields("2026-01-10", "10:00", "Стамбул")).expect("schedule");
        assert_eq!(istanbul.start_local(), "2026-01-10T10:00:00+03:00");
        assert_eq!(istanbul.start_utc % 86_400, 7 * 3600);
    }

    #[test]
    fn slugs_are_latin_and_end_with_the_post_number() {
        let posts = parse_channel_page(FEED);
        let event = apply_post(None, "serbia_progulki", post(&posts, 1110), &cities(), None);
        assert_eq!(
            event.slug(),
            "2026-10-11-progulyaemsya-k-rimskoy-bashne-vrdnichka-kula-1110"
        );
        assert_eq!(translit_slug("Нови Сад"), "novi-sad");
        assert_eq!(translit_slug("Čarda Aqua Doria!"), "carda-aqua-doria");
        assert_eq!(truncate_slug("aaa-bbb-ccc", 6), "aaa");
    }

    #[test]
    fn tagged_complete_post_publishes_and_untagged_waits() {
        let posts = parse_channel_page(FEED);
        let walk = apply_post(
            None,
            "ch",
            post(&posts, 1110),
            &cities(),
            Some("/m/1".into()),
        );
        assert_eq!(walk.status, AfishaStatus::Published);
        assert_eq!(walk.kind, Some(AfishaKind::Hiking));
        assert_eq!(walk.image.as_deref(), Some("/m/1"));
        assert_eq!(walk.post_url(), "https://t.me/ch/1110");

        let untagged = apply_post(None, "ch", post(&posts, 1109), &cities(), None);
        assert_eq!(untagged.status, AfishaStatus::Untagged);
        assert_eq!(untagged.kind, None);
    }

    #[test]
    fn tagged_post_without_a_date_is_a_draft_with_the_reason() {
        let event = apply_post(
            None,
            "ch",
            &text_post("Скоро прогулка #hiking\nМесто встречи: Белград"),
            &cities(),
            None,
        );
        assert_eq!(event.status, AfishaStatus::Draft);
        assert_eq!(event.problem.as_deref(), Some("нет даты, времени"));
    }

    #[test]
    fn rereading_keeps_hand_edits_hidden_status_and_the_picture() {
        let posts = parse_channel_page(FEED);
        let walk = post(&posts, 1110);
        let mut event = apply_post(None, "ch", walk, &cities(), Some("/m/1".into()));
        let mut fields = event.fields.clone();
        fields.title = "Врдничка кула".into();
        event
            .edit(Some(AfishaKind::Quest), fields)
            .expect("valid form");
        assert!(event.edited.contains("title") && event.edited.contains("kind"));
        event.hide();

        let mut edited_post = walk.clone();
        edited_post.text = edited_post.text.replace("12:45", "13:15");
        let again = apply_post(Some(&event), "ch", &edited_post, &cities(), None);
        assert_eq!(again.fields.title, "Врдничка кула", "hand edit kept");
        assert_eq!(
            again.fields.time.as_deref(),
            Some("13:15"),
            "the post wins elsewhere"
        );
        assert_eq!(again.kind, Some(AfishaKind::Quest));
        assert_eq!(again.status, AfishaStatus::Hidden);
        assert_eq!(
            again.image.as_deref(),
            Some("/m/1"),
            "a failed copy keeps the picture"
        );

        let mut shown = again.clone();
        shown.show();
        assert_eq!(shown.status, AfishaStatus::Published);
    }

    #[test]
    fn removing_the_hashtag_takes_the_post_off_the_site() {
        let posts = parse_channel_page(FEED);
        let walk = post(&posts, 1110);
        let event = apply_post(None, "ch", walk, &cities(), None);
        let mut untagged = walk.clone();
        untagged.text = untagged.text.replace("#hiking", "");
        let again = apply_post(Some(&event), "ch", &untagged, &cities(), None);
        assert_eq!(again.status, AfishaStatus::Untagged);
    }

    #[test]
    fn admin_form_is_validated() {
        let valid = EventFields {
            title: "  Прогулка ".into(),
            date: Some("2026-10-11".into()),
            time: Some(" 12:45".into()),
            city: Some("  ".into()),
            ..EventFields::default()
        };
        let f = valid.normalized().expect("valid");
        assert_eq!(f.title, "Прогулка");
        assert_eq!(f.time.as_deref(), Some("12:45"));
        assert_eq!(f.city, None, "blank is none");
        for bad in [
            EventFields::default(),
            EventFields {
                title: "x".into(),
                date: Some("11.10.2026".into()),
                ..Default::default()
            },
            EventFields {
                title: "x".into(),
                time: Some("9:00".into()),
                ..Default::default()
            },
        ] {
            assert!(bad.normalized().is_err());
        }
    }

    #[test]
    fn archived_untagged_past_post_is_filed_under_a_guessed_kind() {
        let posts = parse_channel_page(EMBED_1087);
        let mut event = apply_post(None, "ch", post(&posts, 1087), &cities(), None);
        assert_eq!(event.status, AfishaStatus::Untagged);
        let now = parse_day("2026-10-11").expect("day");
        file_archived(&mut event, now);
        assert_eq!(event.kind, Some(AfishaKind::Quest));
        assert_eq!(event.status, AfishaStatus::Published);
        assert!(event.is_past(now));

        let mut cityless = apply_post(None, "ch", post(&posts, 1087), &[], None);
        cityless.fields.city = None;
        file_archived(&mut cityless, now);
        assert_eq!(
            cityless.status,
            AfishaStatus::Untagged,
            "no draft from the archive"
        );
        assert_eq!(cityless.kind, None);
    }

    #[test]
    fn a_title_names_the_city_the_meeting_point_omits() {
        let f = parse_fields(
            "В субботу 03.06.2023 гуляем по окраинам г. Нови Сад
Место встречи: Лиманский парк
Время: 11:00",
            &cities(),
        );
        assert_eq!(f.city.as_deref(), Some("Нови Сад"));
        assert_eq!(f.place.as_deref(), Some("Лиманский парк"));
    }

    #[test]
    fn channel_names_and_post_links_are_read_leniently() {
        for raw in [
            "serbia_progulki",
            "@serbia_progulki",
            "https://t.me/serbia_progulki",
            "t.me/s/serbia_progulki/",
        ] {
            assert_eq!(
                channel_name(raw).as_deref(),
                Some("serbia_progulki"),
                "{raw}"
            );
        }
        assert_eq!(channel_name("канал"), None);
        assert_eq!(channel_name(""), None);
        assert_eq!(
            post_id_of_link("https://t.me/serbia_progulki/1110", "serbia_progulki"),
            Some(1110)
        );
        assert_eq!(
            post_id_of_link("t.me/s/serbia_progulki/1110?single", "serbia_progulki"),
            Some(1110)
        );
        assert_eq!(
            post_id_of_link("https://t.me/other/1110", "serbia_progulki"),
            None
        );
        assert_eq!(
            post_id_of_link("https://example.com/serbia_progulki/1", "serbia_progulki"),
            None
        );
    }

    #[test]
    fn entities_decode_named_and_numeric() {
        assert_eq!(
            decode_entities("a&amp;b &#33; &#x41; &nbsp;&bogus; &"),
            "a&b ! A \u{a0}&bogus; &"
        );
        assert_eq!(html_to_text("a<br/>b<b>c</b>&nbsp;d"), "a\nbc d");
    }
}
