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

use serde::{Deserialize, Serialize};

use crate::errors::AppError;

/// The discount a coupon carries: a percentage of the price or a fixed ruble
/// amount (clamped to the price at redemption — a 300 ₽ coupon on a 200 ₽
/// quest yields a free checkout, not a negative charge).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "discount_type",
    content = "discount_value",
    rename_all = "snake_case"
)]
pub enum Discount {
    /// 1..=100 percent off.
    Percent(u8),
    /// Whole rubles off, > 0.
    Fixed(i64),
}

/// An admin-managed discount code. `code` is stored normalized (uppercase,
/// trimmed); `quest_ids: None` means the coupon applies to every paid quest,
/// `Some(list)` restricts it to the listed quests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
pub struct CouponUsage {
    pub used: u32,
    pub last_redeemed_at: Option<String>,
    pub total_discounted: i64,
}

/// Derived lifecycle state. `Exhausted` and `Expired` are the automatic
/// archive states; precedence Exhausted > Expired > Paused > Active matches
/// the admin list badges (a spent coupon shows «Исчерпан» even past its date).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CouponStatus {
    Active,
    Paused,
    Expired,
    Exhausted,
}

/// Why a redemption was refused; each maps to the player-facing message shown
/// in the purchase sheet. The variants deliberately do not reveal more than a
/// player may know (an unknown and a deleted code read the same).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RedeemReject {
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
}
