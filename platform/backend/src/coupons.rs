//! Coupons: admin-managed discount codes redeemed at checkout, mirroring the
//! `grants.rs` split of pure helpers vs. storage.
//!
//! A coupon is identified by an immutable `coupon_id`; the human-facing `code`
//! is unique among coupons but editable. Redemptions are recorded once per
//! `(coupon_id, user_id, quest_id)` — the same natural granularity as access
//! grants ("buy once, own forever"), which makes a checkout retry idempotent
//! and closes the double-consume race between grant check and redemption.
//!
//! Statuses are DERIVED, never stored: `paused` is the only stored flag, while
//! expiry and exhaustion fall out of `valid_until` / `max_redemptions` against
//! the redemption log. The pure helpers here make every decision (validation,
//! status, redeemability, discount math); the stores own the critical section
//! and inject the wall clock, keeping this layer deterministic and testable.
//!
//! QR invitations: a coupon limited to ONE quest can carry a
//! QR code — the short link `/go/<qr_slug>` opens that quest's page with the
//! code applied. The slug is permanent and independent of the editable code;
//! scans are counted per day, nothing personal stored. [`coupon_funnel`]
//! follows the invited players from the scan to their next purchase.

use std::collections::HashMap;

use argon2::password_hash::rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::errors::AppError;
use crate::facts::QuestProgress;
use crate::grants::{AccessGrant, GrantSource};

/// The discount a coupon carries: a percentage of the price or a fixed ruble
/// amount (clamped to the price at redemption — a 300 ₽ coupon on a 200 ₽
/// quest yields a free checkout, not a negative charge).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "discount_type",
    content = "discount_value",
    rename_all = "snake_case"
)]
pub enum Discount {
    /// 1..=100 percent off.
    Percent(u8),
    /// Whole rubles off, > 0.
    Fixed(#[cfg_attr(test, ts(type = "number"))] i64),
}

/// An admin-managed discount code. `code` is stored normalized (uppercase,
/// trimmed); `quest_ids: None` means the coupon applies to every paid quest,
/// `Some(list)` restricts it to the listed quests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Coupon {
    pub coupon_id: String,
    pub code: String,
    #[serde(flatten)]
    pub discount: Discount,
    /// Inclusive last valid calendar date (UTC), `"YYYY-MM-DD"`; None = no expiry.
    pub valid_until: Option<String>,
    /// Total redemption cap; None = unlimited.
    pub max_redemptions: Option<u32>,
    /// Per-player redemption cap; None = unlimited.
    pub per_user_limit: Option<u32>,
    /// Applicable quests; None = all paid quests (including future ones).
    pub quest_ids: Option<Vec<String>>,
    pub paused: bool,
    pub created_at: String,
    /// Who hands the invitation out — the quest page a QR opens shows
    /// «Подарок от …» with it; None = no such line.
    pub gift_from: Option<String>,
    /// The permanent address of the coupon's QR link (`/go/<qr_slug>`); None
    /// until the admin makes the QR. Only the stores set it, never a save.
    pub qr_slug: Option<String>,
}

/// One recorded redemption: who applied which coupon to which quest, when,
/// and how many rubles it saved (audit + usage stats).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CouponRedemption {
    pub coupon_id: String,
    pub user_id: String,
    pub quest_id: String,
    pub amount_discounted: i64,
    pub redeemed_at: String,
}

/// Aggregate usage folded from the redemption log (admin list/detail).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CouponUsage {
    pub used: u32,
    pub last_redeemed_at: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub total_discounted: i64,
}

/// Derived lifecycle state. `Exhausted` and `Expired` are the automatic
/// archive states; precedence Exhausted > Expired > Paused > Active matches
/// the admin list badges (a spent coupon shows «Исчерпан» even past its date).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum CouponStatus {
    Active,
    Paused,
    Expired,
    Exhausted,
}

/// Why a code was refused; each maps to the player-facing message shown in the
/// purchase sheet, and travels as `reason` so the QR invitation picks its own
/// wording. The variants deliberately do not reveal more than a player may
/// know (an unknown and a deleted code read the same).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum RedeemReject {
    /// No coupon has this code (only a quote can say so — redemption runs on
    /// a coupon already found).
    NotFound,
    Paused,
    Expired,
    Exhausted,
    PerUserLimit,
    NotApplicable,
}

impl RedeemReject {
    /// Player-facing Russian message (the UI shows it verbatim).
    pub fn message(self) -> &'static str {
        match self {
            Self::NotFound => "промокод не найден",
            Self::Paused => "Промокод временно не действует",
            Self::Expired => "Срок действия промокода истёк",
            Self::Exhausted => "Промокод больше не действует — лимит исчерпан",
            Self::PerUserLimit => "Вы уже использовали этот промокод",
            Self::NotApplicable => "Промокод не действует на этот квест",
        }
    }
}

/// Normalize a coupon code: trim and uppercase (Unicode-aware, so codes stay
/// case-insensitive in any alphabet). The only rule is that the trimmed code
/// must be non-empty.
pub fn normalize_code(raw: &str) -> Result<String, AppError> {
    let code = raw.trim().to_uppercase();
    if code.is_empty() {
        return Err(AppError::BadRequest(
            "код купона не может быть пустым".into(),
        ));
    }
    Ok(code)
}

/// Validate a discount: percent 1..=100, fixed amount > 0 rubles.
pub fn validate_discount(discount: &Discount) -> Result<(), AppError> {
    match discount {
        Discount::Percent(p) if (1..=100).contains(p) => Ok(()),
        Discount::Percent(_) => Err(AppError::BadRequest("процент скидки — от 1 до 100".into())),
        Discount::Fixed(v) if *v > 0 => Ok(()),
        Discount::Fixed(_) => Err(AppError::BadRequest(
            "сумма скидки должна быть больше нуля".into(),
        )),
    }
}

/// Validate a `"YYYY-MM-DD"` calendar date (proleptic Gregorian, leap-aware).
/// Validity itself has ONE definition — [`crate::admin_stats::parse_day`] —
/// this wrapper only maps the failure to the coupon form's error message.
pub fn validate_date(date: &str) -> Result<(), AppError> {
    crate::admin_stats::parse_day(date)
        .map(|_| ())
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "некорректная дата '{date}' (нужен формат ГГГГ-ММ-ДД)"
            ))
        })
}

/// True when the coupon's last valid date lies strictly before `today`
/// (both `"YYYY-MM-DD"`, so lexicographic comparison is chronological).
/// «до 31.08.2026» is valid through the whole of 31.08.2026 UTC.
pub fn is_expired(valid_until: Option<&str>, today: &str) -> bool {
    valid_until.is_some_and(|until| until < today)
}

/// True when the total redemption cap is reached.
pub fn is_exhausted(max_redemptions: Option<u32>, used: u32) -> bool {
    max_redemptions.is_some_and(|max| used >= max)
}

/// Derive the lifecycle status shown in the admin UI.
pub fn coupon_status(coupon: &Coupon, used: u32, today: &str) -> CouponStatus {
    if is_exhausted(coupon.max_redemptions, used) {
        CouponStatus::Exhausted
    } else if is_expired(coupon.valid_until.as_deref(), today) {
        CouponStatus::Expired
    } else if coupon.paused {
        CouponStatus::Paused
    } else {
        CouponStatus::Active
    }
}

/// Pure redeemability decision (the logic the store runs under its lock, and
/// the validate endpoint runs for the price preview). Checks, in order:
/// applicability to the quest, pause, expiry, the total cap, the per-user cap.
pub fn check_redeemable(
    coupon: &Coupon,
    quest_id: &str,
    used_total: u32,
    used_by_player: u32,
    today: &str,
) -> Result<(), RedeemReject> {
    if let Some(quests) = &coupon.quest_ids
        && !quests.iter().any(|q| q == quest_id)
    {
        return Err(RedeemReject::NotApplicable);
    }
    if is_expired(coupon.valid_until.as_deref(), today) {
        return Err(RedeemReject::Expired);
    }
    if is_exhausted(coupon.max_redemptions, used_total) {
        return Err(RedeemReject::Exhausted);
    }
    if coupon.paused {
        return Err(RedeemReject::Paused);
    }
    if coupon
        .per_user_limit
        .is_some_and(|limit| used_by_player >= limit)
    {
        return Err(RedeemReject::PerUserLimit);
    }
    Ok(())
}

/// Rubles saved by `discount` on `price`. Percent rounds the FINAL price half
/// up (mirrors the storefront's `Math.round(price * (100 - p) / 100)`) and
/// returns the difference; fixed clamps to the price so the final never goes
/// negative. `price <= 0` yields no discount — there is nothing to discount.
pub fn discount_amount(discount: &Discount, price: i64) -> i64 {
    if price <= 0 {
        return 0;
    }
    match discount {
        Discount::Percent(p) => {
            let final_price =
                ((price as f64) * f64::from(100 - u32::from(*p)) / 100.0).round() as i64;
            price - final_price
        }
        Discount::Fixed(v) => (*v).min(price),
    }
}

/// Longest «От кого»: one line under the gift banner on a phone.
pub const GIFT_FROM_MAX_CHARS: usize = 60;

/// Validate «От кого»: trimmed, blank = no line, at most
/// [`GIFT_FROM_MAX_CHARS`] characters.
pub fn normalize_gift_from(raw: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(text) = raw.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if text.chars().count() > GIFT_FROM_MAX_CHARS {
        return Err(AppError::BadRequest(format!(
            "«От кого» — не длиннее {GIFT_FROM_MAX_CHARS} символов"
        )));
    }
    Ok(Some(text.to_string()))
}

/// The one quest a coupon is limited to. Only such a coupon may carry a QR:
/// the code of a wider coupon, read off the link, would open every paid quest.
pub fn single_quest(coupon: &Coupon) -> Option<&str> {
    match coupon.quest_ids.as_deref() {
        Some([only]) => Some(only.as_str()),
        _ => None,
    }
}

/// Characters of a QR slug: no lookalikes (0/O, 1/I/L) — the slug is printed
/// as text beside the QR and may be typed by hand. The admin's «Сгенерировать»
/// codes use the same set.
const QR_SLUG_ALPHABET: &[u8; 31] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// Length of a QR slug: 31^6 ≈ 887 million addresses — a short link keeps
/// the QR's modules big, and that many addresses cannot be guessed.
pub const QR_SLUG_LEN: usize = 6;

/// The slug random `bytes` spell, or None when they run out first. Bytes from
/// 248 (= 8 × 31) up are skipped, so every character is equally likely.
fn qr_slug_from(bytes: impl IntoIterator<Item = u8>) -> Option<String> {
    let slug: String = bytes
        .into_iter()
        .filter(|b| *b < 248)
        .take(QR_SLUG_LEN)
        .map(|b| char::from(QR_SLUG_ALPHABET[usize::from(b % 31)]))
        .collect();
    (slug.len() == QR_SLUG_LEN).then_some(slug)
}

/// A fresh random QR slug; uniqueness is the store's to enforce.
pub fn new_qr_slug() -> String {
    loop {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        if let Some(slug) = qr_slug_from(bytes) {
            return slug;
        }
    }
}

/// Whether a visit of a QR link comes from a robot, not a person: messengers
/// fetch a shared link for its preview card and crawlers follow links —
/// neither is a scan. The markers are how such agents sign; «bot» alone is
/// not one (a phone brand carries it). No agent at all is a script.
pub fn is_robot(user_agent: &str) -> bool {
    const MARKERS: [&str; 9] = [
        "bot/",
        "bot-",
        "bot (",
        "crawler",
        "spider",
        "facebookexternalhit",
        "whatsapp/",
        "vkshare",
        "skypeuripreview",
    ];
    let agent = user_agent.trim().to_ascii_lowercase();
    agent.is_empty() || MARKERS.iter().any(|m| agent.contains(m))
}

/// How long after getting a quest by invitation a purchase still counts as
/// one the invitation brought.
pub const FUNNEL_PURCHASE_DAYS: i64 = 30;

/// What became of a coupon's invitations, step by step (the admin funnel).
/// Every step after `scans` counts the players who got a quest with it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "CouponFunnelWire"))]
pub struct CouponFunnel {
    /// Visits of the QR link by people (robots excluded).
    #[cfg_attr(test, ts(type = "number"))]
    pub scans: u64,
    /// Got the quest with the coupon…
    pub got: u32,
    /// …started it…
    pub started: u32,
    /// …finished it…
    pub finished: u32,
    /// …rated it…
    pub rated: u32,
    /// …and paid for another quest within [`FUNNEL_PURCHASE_DAYS`] days.
    pub bought: u32,
}

/// Fold the funnel: for each redemption, its player's progress on the quest
/// they got, and whether they paid for ANOTHER quest in the purchase window.
/// `progress` and `grants` may be wider than the redemptions (extra rows are
/// ignored).
pub fn coupon_funnel(
    scans: u64,
    redemptions: &[CouponRedemption],
    progress: &[QuestProgress],
    grants: &[AccessGrant],
) -> CouponFunnel {
    let progress: HashMap<(&str, &str), &QuestProgress> = progress
        .iter()
        .map(|p| ((p.user_id.as_str(), p.quest_id.as_str()), p))
        .collect();
    let mut paid: HashMap<&str, Vec<&AccessGrant>> = HashMap::new();
    for grant in grants.iter().filter(|g| g.source == GrantSource::Payment) {
        paid.entry(grant.user_id.as_str()).or_default().push(grant);
    }
    let mut funnel = CouponFunnel {
        scans,
        ..CouponFunnel::default()
    };
    for r in redemptions {
        funnel.got += 1;
        if let Some(p) = progress.get(&(r.user_id.as_str(), r.quest_id.as_str())) {
            funnel.started += 1;
            funnel.finished += u32::from(p.finished);
            funnel.rated += u32::from(p.rated);
        }
        let bought = paid.get(r.user_id.as_str()).is_some_and(|grants| {
            grants.iter().any(|g| {
                g.quest_id != r.quest_id && in_purchase_window(&r.redeemed_at, &g.granted_at)
            })
        });
        funnel.bought += u32::from(bought);
    }
    funnel
}

/// Whether `later` falls between `start` and [`FUNNEL_PURCHASE_DAYS`] days
/// after it (both RFC3339 UTC, as the stores stamp them).
fn in_purchase_window(start: &str, later: &str) -> bool {
    use crate::admin_stats::parse_rfc3339_utc;
    match (parse_rfc3339_utc(start), parse_rfc3339_utc(later)) {
        (Some(s), Some(l)) => (s..=s + FUNNEL_PURCHASE_DAYS * 86_400).contains(&l),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: &str = "2026-07-15";

    fn coupon(discount: Discount) -> Coupon {
        Coupon {
            coupon_id: "cpn-1".into(),
            code: "LETO-20".into(),
            discount,
            valid_until: None,
            max_redemptions: None,
            per_user_limit: None,
            quest_ids: None,
            paused: false,
            created_at: "2026-06-01T00:00:00Z".into(),
            gift_from: None,
            qr_slug: None,
        }
    }

    #[test]
    fn code_normalizes_and_rejects_only_empty() {
        assert_eq!(normalize_code("  leto-20 ").unwrap(), "LETO-20");
        assert_eq!(normalize_code("GEOHOD300").unwrap(), "GEOHOD300");
        assert_eq!(
            normalize_code("лето-20").unwrap(),
            "ЛЕТО-20",
            "cyrillic allowed"
        );
        assert_eq!(normalize_code("ab").unwrap(), "AB", "short allowed");
        assert_eq!(
            normalize_code(&"A".repeat(64)).unwrap(),
            "A".repeat(64),
            "long allowed"
        );
        assert_eq!(normalize_code("A B").unwrap(), "A B", "inner space allowed");
        assert_eq!(
            normalize_code("---").unwrap(),
            "---",
            "any characters allowed"
        );
        assert!(normalize_code("").is_err(), "empty rejected");
        assert!(normalize_code("   ").is_err(), "whitespace-only rejected");
    }

    #[test]
    fn discount_validation_bounds() {
        assert!(validate_discount(&Discount::Percent(1)).is_ok());
        assert!(validate_discount(&Discount::Percent(100)).is_ok());
        assert!(validate_discount(&Discount::Percent(0)).is_err());
        assert!(validate_discount(&Discount::Percent(101)).is_err());
        assert!(validate_discount(&Discount::Fixed(300)).is_ok());
        assert!(validate_discount(&Discount::Fixed(0)).is_err());
        assert!(validate_discount(&Discount::Fixed(-5)).is_err());
    }

    #[test]
    fn date_validation_accepts_calendar_dates_only() {
        assert!(validate_date("2026-09-15").is_ok());
        assert!(validate_date("2028-02-29").is_ok(), "leap day");
        assert!(validate_date("2026-02-29").is_err(), "not a leap year");
        assert!(validate_date("2026-13-01").is_err());
        assert!(validate_date("2026-00-10").is_err());
        assert!(validate_date("2026-06-31").is_err());
        assert!(validate_date("15.09.2026").is_err(), "wrong format");
        assert!(validate_date("2026-9-5").is_err(), "unpadded");
    }

    #[test]
    fn expiry_is_inclusive_of_the_last_day() {
        assert!(
            !is_expired(Some(TODAY), TODAY),
            "valid through its last day"
        );
        assert!(!is_expired(Some("2026-08-31"), TODAY));
        assert!(is_expired(Some("2026-07-14"), TODAY));
        assert!(!is_expired(None, TODAY), "no expiry");
    }

    #[test]
    fn status_precedence_exhausted_over_expired_over_paused() {
        let mut c = coupon(Discount::Percent(10));
        assert_eq!(coupon_status(&c, 0, TODAY), CouponStatus::Active);
        c.paused = true;
        assert_eq!(coupon_status(&c, 0, TODAY), CouponStatus::Paused);
        c.valid_until = Some("2026-07-01".into());
        assert_eq!(coupon_status(&c, 0, TODAY), CouponStatus::Expired);
        c.max_redemptions = Some(25);
        assert_eq!(coupon_status(&c, 25, TODAY), CouponStatus::Exhausted);
    }

    #[test]
    fn redeemability_covers_every_rejection() {
        let mut c = coupon(Discount::Percent(20));
        assert_eq!(check_redeemable(&c, "q1", 0, 0, TODAY), Ok(()));

        c.quest_ids = Some(vec!["q2".into()]);
        assert_eq!(
            check_redeemable(&c, "q1", 0, 0, TODAY),
            Err(RedeemReject::NotApplicable)
        );
        assert_eq!(check_redeemable(&c, "q2", 0, 0, TODAY), Ok(()));
        c.quest_ids = None;

        c.valid_until = Some("2026-07-14".into());
        assert_eq!(
            check_redeemable(&c, "q1", 0, 0, TODAY),
            Err(RedeemReject::Expired)
        );
        c.valid_until = None;

        c.max_redemptions = Some(50);
        assert_eq!(
            check_redeemable(&c, "q1", 50, 0, TODAY),
            Err(RedeemReject::Exhausted)
        );
        assert_eq!(check_redeemable(&c, "q1", 49, 0, TODAY), Ok(()));
        c.max_redemptions = None;

        c.paused = true;
        assert_eq!(
            check_redeemable(&c, "q1", 0, 0, TODAY),
            Err(RedeemReject::Paused)
        );
        c.paused = false;

        c.per_user_limit = Some(1);
        assert_eq!(
            check_redeemable(&c, "q1", 0, 1, TODAY),
            Err(RedeemReject::PerUserLimit)
        );
        assert_eq!(check_redeemable(&c, "q1", 0, 0, TODAY), Ok(()));
    }

    #[test]
    fn discount_math_matches_storefront_rounding_and_clamps() {
        // Math.round(900 * 80 / 100) = 720 -> saved 180
        assert_eq!(discount_amount(&Discount::Percent(20), 900), 180);
        // Math.round(750 * 85 / 100) = Math.round(637.5) = 638 -> saved 112
        assert_eq!(discount_amount(&Discount::Percent(15), 750), 112);
        assert_eq!(discount_amount(&Discount::Percent(100), 900), 900);
        assert_eq!(discount_amount(&Discount::Fixed(300), 900), 300);
        assert_eq!(discount_amount(&Discount::Fixed(300), 200), 200, "clamped");
        assert_eq!(discount_amount(&Discount::Fixed(300), 0), 0, "free quest");
        assert_eq!(discount_amount(&Discount::Percent(50), -10), 0);
    }

    #[test]
    fn discount_serde_shape_is_tagged_type_plus_value() {
        let c = coupon(Discount::Fixed(300));
        let v = serde_json::to_value(&c).expect("serialize");
        assert_eq!(v["discount_type"], "fixed");
        assert_eq!(v["discount_value"], 300);
        let back: Coupon = serde_json::from_value(v).expect("deserialize");
        assert_eq!(back, c);
    }

    #[test]
    fn gift_from_is_trimmed_optional_and_capped() {
        assert_eq!(normalize_gift_from(None).unwrap(), None);
        assert_eq!(
            normalize_gift_from(Some("   ")).unwrap(),
            None,
            "blank = none"
        );
        assert_eq!(
            normalize_gift_from(Some("  хостела Fortress ")).unwrap(),
            Some("хостела Fortress".into())
        );
        let longest = "я".repeat(GIFT_FROM_MAX_CHARS);
        assert_eq!(
            normalize_gift_from(Some(&longest)).unwrap(),
            Some(longest.clone()),
            "the cap counts characters, not bytes"
        );
        assert!(normalize_gift_from(Some(&format!("{longest}я"))).is_err());
    }

    #[test]
    fn only_a_one_quest_coupon_has_a_single_quest() {
        let mut c = coupon(Discount::Percent(100));
        assert_eq!(single_quest(&c), None, "all quests");
        c.quest_ids = Some(vec!["q1".into(), "q2".into()]);
        assert_eq!(single_quest(&c), None, "two quests");
        c.quest_ids = Some(vec!["q1".into()]);
        assert_eq!(single_quest(&c), Some("q1"));
    }

    #[test]
    fn qr_slug_skips_biased_bytes_and_avoids_lookalikes() {
        // 248..=255 would bias the modulo — skipped, the next bytes are used.
        assert_eq!(
            qr_slug_from([255, 0, 248, 1, 2, 30, 31, 62]),
            Some("ABC9AA".into())
        );
        assert_eq!(qr_slug_from([0, 1, 2]), None, "too few bytes");
        assert_eq!(qr_slug_from([250; 32]), None, "only skipped bytes");
        for _ in 0..200 {
            let slug = new_qr_slug();
            assert_eq!(slug.len(), QR_SLUG_LEN);
            assert!(
                slug.bytes().all(|b| QR_SLUG_ALPHABET.contains(&b)),
                "{slug}: outside the alphabet"
            );
            assert!(!slug.contains(['0', 'O', '1', 'I', 'L']), "{slug}");
        }
    }

    #[test]
    fn robots_are_told_from_people() {
        for robot in [
            "TelegramBot (like TwitterBot)",
            "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
            "facebookexternalhit/1.1",
            "WhatsApp/2.23.20.0 A",
            "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
            "vkShare; +http://vk.com/dev/Share",
            "",
            "   ",
        ] {
            assert!(is_robot(robot), "{robot:?} is a robot");
        }
        for person in [
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 \
             (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
            "Mozilla/5.0 (Linux; Android 13; CUBOT KINGKONG 9) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
            "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 Telegram-Android/11.2.3",
        ] {
            assert!(!is_robot(person), "{person:?} is a person");
        }
    }

    fn redemption(user: &str, quest: &str, at: &str) -> CouponRedemption {
        CouponRedemption {
            coupon_id: "cpn-1".into(),
            user_id: user.into(),
            quest_id: quest.into(),
            amount_discounted: 900,
            redeemed_at: at.into(),
        }
    }

    fn progress(user: &str, quest: &str, finished: bool, rated: bool) -> QuestProgress {
        QuestProgress {
            user_id: user.into(),
            quest_id: quest.into(),
            finished,
            rated,
        }
    }

    fn grant(user: &str, quest: &str, at: &str, source: GrantSource) -> AccessGrant {
        AccessGrant {
            user_id: user.into(),
            quest_id: quest.into(),
            granted_at: at.into(),
            source,
            source_ref: None,
        }
    }

    #[test]
    fn funnel_follows_each_invited_player_to_the_next_purchase() {
        let got_at = "2026-07-01T10:00:00Z";
        let redemptions = [
            redemption("a", "gift", got_at),
            redemption("b", "gift", got_at),
            redemption("c", "gift", got_at),
            redemption("d", "gift", got_at),
        ];
        let progress = [
            progress("a", "gift", true, true),
            progress("b", "gift", true, false),
            progress("c", "gift", false, false),
            // Another player's play and another quest are not this funnel's.
            progress("z", "gift", true, true),
            progress("d", "other", true, true),
        ];
        let grants = [
            // a: the gift itself, then a paid quest within the window.
            grant("a", "gift", got_at, GrantSource::CouponRedemption),
            grant("a", "next", "2026-07-31T09:59:59Z", GrantSource::Payment),
            // b: paid too late; c: got another quest free; d: no purchase.
            grant("b", "next", "2026-08-01T10:00:01Z", GrantSource::Payment),
            grant("c", "next", "2026-07-02T10:00:00Z", GrantSource::FreeQuest),
        ];
        assert_eq!(
            coupon_funnel(12, &redemptions, &progress, &grants),
            CouponFunnel {
                scans: 12,
                got: 4,
                started: 3,
                finished: 2,
                rated: 1,
                bought: 1,
            }
        );
        assert_eq!(
            coupon_funnel(0, &[], &progress, &grants),
            CouponFunnel::default(),
            "no redemptions, an empty funnel"
        );
    }

    #[test]
    fn purchase_window_is_inclusive_and_forward_only() {
        let start = "2026-07-01T10:00:00Z";
        assert!(in_purchase_window(start, start));
        assert!(in_purchase_window(start, "2026-07-31T10:00:00Z"), "day 30");
        assert!(!in_purchase_window(start, "2026-07-31T10:00:01Z"));
        assert!(!in_purchase_window(start, "2026-07-01T09:59:59Z"), "before");
        assert!(!in_purchase_window(start, "not a date"));
    }
}
