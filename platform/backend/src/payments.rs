//! Payment domain, two operations: [`checkout`] opens (or instantly settles)
//! a purchase, [`settle`] is THE ONLY place a redirect payment can mint a
//! grant. Providers: the always-approving mock (dev/test, selectable at
//! checkout) and YooKassa redirect payments (`yookassa.rs`). Checkout
//! dispatches per request on `CheckoutRequest.provider`; coupon-100% and free
//! paths bypass every provider — there is nothing to charge.

use crate::AppState;
use crate::auth;
use crate::coupons;
use crate::errors::AppError;
use crate::features::Feature;
use crate::grants::{AccessGrant, GrantSource};
use crate::store;
use crate::yookassa::{self, YookassaGateway};

/// Always-approving mock: settles instantly with a payment ref recorded on the
/// grant (`source_ref`) for audit. The ref is deterministic per (player, quest)
/// so the idempotent grant keeps a stable audit trail across retries and tests.
pub fn mock_payment_ref(user_id: &str, quest_id: &str) -> String {
    format!("mock-pay-{user_id}-{quest_id}")
}

/// Lifecycle of a redirect-provider payment (YooKassa). One-way:
/// `Pending -> Succeeded | Canceled`; the succeeded transition is a CAS in the
/// store so exactly one settle call wins (and redeems the attached coupon).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PendingStatus {
    Pending,
    Succeeded,
    Canceled,
}

impl PendingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Succeeded => "succeeded",
            Self::Canceled => "canceled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "succeeded" => Some(Self::Succeeded),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }
}

/// An in-flight redirect payment, persisted between checkout and settlement.
///
/// `id` is OUR identifier: it rides the return_url back to the frontend, keys
/// the poll endpoint, and doubles as the YooKassa `Idempotence-Key` (so a
/// crashed checkout retried with the same row cannot double-charge).
/// `coupon_code` is the promo held for settlement — redeemed ONLY when the
/// payment succeeds, so an abandoned payment never burns the code.
#[derive(Clone, Debug, PartialEq)]
pub struct PendingPayment {
    pub id: String,
    pub provider_payment_id: String,
    pub user_id: String,
    pub quest_id: String,
    pub coupon_code: Option<String>,
    /// Whole rubles actually charged (price minus any partial discount).
    pub amount: i64,
    /// Full quest price at checkout time — the discount base the settlement
    /// passes to the coupon redemption (no re-fetch, no repricing drift).
    pub price: i64,
    /// Payer-facing gateway page; replayed on repeat checkouts while pending.
    pub confirmation_url: String,
    pub status: PendingStatus,
    pub created_at: String,
}

#[derive(serde::Deserialize)]
pub struct CheckoutRequest {
    pub user_id: String,
    pub quest_id: String,
    /// Server-validated promo code; the discount lives in the coupon registry,
    /// never in the request (a client cannot name its own percentage).
    pub coupon_code: Option<String>,
    /// Payment provider: `"mock"` (default) settles instantly; `"yookassa"`
    /// starts a redirect flow (501 when the deployment has no credentials).
    pub provider: Option<String>,
}

/// Untagged: settled checkouts keep the historical `{grant, created}` shape;
/// redirect checkouts answer `{payment: {payment_id, confirmation_url}}`.
#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum CheckoutResponse {
    Settled { grant: AccessGrant, created: bool },
    Redirect { payment: RedirectPayment },
}

/// The client's marching orders for a redirect provider: send the payer to
/// `confirmation_url`, then poll `GET /api/payments/{payment_id}` on return.
#[derive(serde::Serialize)]
pub struct RedirectPayment {
    pub payment_id: String,
    pub confirmation_url: String,
}

/// Checkout, dispatched per request on `provider`: the mock settles instantly,
/// YooKassa opens a redirect flow settled later by [`settle`].
///
/// With a coupon code the registry is consulted: the redemption is recorded
/// atomically against the coupon's caps, and a discount that zeroes the price
/// grants as CouponRedemption bypassing every provider; a partial discount
/// still charges and grants as Payment. Idempotent (first grant + first audit
/// ref win), and a re-checkout of an owned quest never consumes a coupon.
pub async fn checkout(
    state: &AppState,
    user_id: &str,
    req: &CheckoutRequest,
) -> Result<CheckoutResponse, AppError> {
    if state.grants.has_grant(user_id, &req.quest_id).await? {
        // Already owned: return the stored grant unchanged (source is ignored
        // on an idempotent hit) without charging or spending a coupon.
        let (grant, created) = state
            .grants
            .create_grant_idemp(user_id, &req.quest_id, GrantSource::Payment, None)
            .await?;
        return Ok(CheckoutResponse::Settled { grant, created });
    }
    let provider = req.provider.as_deref().unwrap_or("mock");
    match provider {
        "mock" => {
            require_provider_enabled(state, Feature::PaymentsMock, provider).await?;
            mock_checkout(state, user_id, req).await
        }
        "yookassa" => {
            require_provider_enabled(state, Feature::PaymentsYookassa, provider).await?;
            yookassa_checkout(state, user_id, req).await
        }
        other => Err(AppError::BadRequest(format!(
            "unknown payment provider: {other}"
        ))),
    }
}

/// Checkout gate for one payment provider's feature toggle. Same 501 as an
/// unconfigured provider — the client treats "disabled by an admin toggle"
/// and "deployment lacks credentials" identically.
async fn require_provider_enabled(
    state: &AppState,
    feature: Feature,
    provider: &str,
) -> Result<(), AppError> {
    if crate::feature_enabled(state, feature).await? {
        Ok(())
    } else {
        Err(AppError::NotImplemented(format!(
            "payment provider {provider} is disabled on this server"
        )))
    }
}

/// The historical synchronous path: the mock settles instantly, so the coupon
/// is redeemed and the grant created in the same request.
async fn mock_checkout(
    state: &AppState,
    user_id: &str,
    req: &CheckoutRequest,
) -> Result<CheckoutResponse, AppError> {
    let (source, source_ref) = match &req.coupon_code {
        Some(raw) => {
            let code = coupons::normalize_code(raw)?;
            let price = quest_price(state, &req.quest_id).await?.ok_or_else(|| {
                AppError::Conflict(coupons::RedeemReject::NotApplicable.message().into())
            })?;
            let redemption = state
                .coupons
                .redeem(&code, user_id, &req.quest_id, price)
                .await?;
            if redemption.amount_discounted >= price {
                (GrantSource::CouponRedemption, None)
            } else {
                let payment_ref = mock_payment_ref(user_id, &req.quest_id);
                (GrantSource::Payment, Some(payment_ref))
            }
        }
        None => {
            let payment_ref = mock_payment_ref(user_id, &req.quest_id);
            (GrantSource::Payment, Some(payment_ref))
        }
    };
    let (grant, created) = state
        .grants
        .create_grant_idemp(user_id, &req.quest_id, source, source_ref)
        .await?;
    Ok(CheckoutResponse::Settled { grant, created })
}

/// A quest's positive price; `None` for free (0), unpriced, or unpublished.
async fn quest_price(state: &AppState, quest_id: &str) -> Result<Option<i64>, AppError> {
    Ok(state
        .grants
        .get_published(quest_id)
        .await?
        .and_then(|meta| meta.price)
        .filter(|p| *p > 0))
}

/// Quote a normalized coupon against a priced quest: preview + redeemability +
/// the priced discount. Never consumes the code. The inner `Err` is the
/// player-facing reason (unknown and deleted codes read the same, by design);
/// `Ok` carries the coupon's canonical code and the discount in rubles.
pub async fn quote_coupon(
    state: &AppState,
    code: &str,
    user_id: &str,
    quest_id: &str,
    price: i64,
) -> Result<Result<(String, i64), &'static str>, AppError> {
    let Some((coupon, used_total, used_by_player)) = state.coupons.preview(code, user_id).await?
    else {
        return Ok(Err("промокод не найден"));
    };
    if let Err(reject) = coupons::check_redeemable(
        &coupon,
        quest_id,
        used_total,
        used_by_player,
        &store::today_utc(),
    ) {
        return Ok(Err(reject.message()));
    }
    let discount = coupons::discount_amount(&coupon.discount, price);
    Ok(Ok((coupon.code, discount)))
}

/// The configured YooKassa transport, or 501 (fail-closed) when absent.
fn yookassa_gateway(state: &AppState) -> Result<&YookassaGateway, AppError> {
    state.yookassa.as_ref().ok_or_else(|| {
        AppError::NotImplemented("card payments are not configured on this deployment".into())
    })
}

/// The redirect path: create a YooKassa payment and answer with its payer page.
/// NOTHING settles here — the grant (and any coupon redemption) waits for a
/// verified `succeeded` in [`settle`]. Free and coupon-100% orders
/// never reach the gateway (nothing to charge).
async fn yookassa_checkout(
    state: &AppState,
    user_id: &str,
    req: &CheckoutRequest,
) -> Result<CheckoutResponse, AppError> {
    let gateway = yookassa_gateway(state)?;
    // An open payment for this order is replayed instead of double-creating at
    // the gateway (the payer may have closed the tab mid-confirmation).
    if let Some(open) = state
        .payment_rows
        .find_pending_for(user_id, &req.quest_id)
        .await?
    {
        return Ok(CheckoutResponse::Redirect {
            payment: RedirectPayment {
                payment_id: open.id,
                confirmation_url: open.confirmation_url,
            },
        });
    }
    let meta = state
        .grants
        .get_published(&req.quest_id)
        .await?
        .ok_or_else(|| AppError::NotFound("quest is not published".into()))?;
    let Some(price) = meta.price.filter(|p| *p > 0) else {
        // Free quest: nothing to charge — grant immediately, provider bypassed.
        let (grant, created) = state
            .grants
            .create_grant_idemp(user_id, &req.quest_id, GrantSource::FreeQuest, None)
            .await?;
        return Ok(CheckoutResponse::Settled { grant, created });
    };
    // A coupon prices the charge now but is redeemed only at settlement — an
    // abandoned payment must not burn the code. Coupon-100% has nothing to
    // charge, so it settles instantly through the synchronous path (redeem +
    // CouponRedemption grant), never reaching the gateway.
    let (coupon_code, amount) = match &req.coupon_code {
        Some(raw) => {
            let code = coupons::normalize_code(raw)?;
            let (_, discount) = quote_coupon(state, &code, user_id, &req.quest_id, price)
                .await?
                .map_err(|reason| AppError::Conflict(reason.into()))?;
            if discount >= price {
                return mock_checkout(state, user_id, req).await;
            }
            (Some(code), price - discount)
        }
        None => (None, price),
    };
    // Our id keys the poll endpoint, rides the return_url, and doubles as the
    // YooKassa Idempotence-Key (64 hex chars — within the 64-char cap).
    let payment_id = auth::generate_token();
    let return_url = format!(
        "{}/quest/{}/about?payment={}",
        state.config.frontend_base.trim_end_matches('/'),
        req.quest_id,
        payment_id
    );
    let body = yookassa::build_create_payment(
        amount,
        &format!("Квест «{}»", meta.name),
        &return_url,
        user_id,
        &req.quest_id,
    );
    let remote = gateway.create_payment(&payment_id, body).await?;
    let confirmation_url = remote.confirmation_url.clone().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!(
            "yookassa created payment {} without a confirmation_url",
            remote.id
        ))
    })?;
    state
        .payment_rows
        .insert(PendingPayment {
            id: payment_id.clone(),
            provider_payment_id: remote.id,
            user_id: user_id.to_string(),
            quest_id: req.quest_id.clone(),
            coupon_code,
            amount,
            price,
            confirmation_url: confirmation_url.clone(),
            status: PendingStatus::Pending,
            created_at: store::now_rfc3339(),
        })
        .await?;
    Ok(CheckoutResponse::Redirect {
        payment: RedirectPayment {
            payment_id,
            confirmation_url,
        },
    })
}

/// Re-check a pending payment against YooKassa and apply the outcome. Safe to
/// call from the webhook and the owner poll concurrently: the status flip is a
/// store CAS, the grant is `create_grant_idemp`, and only the CAS winner
/// redeems the held coupon. The notification body is never trusted — this is
/// the only place a redirect payment can mint a grant, and it always re-fetches
/// the authoritative status from the API.
pub async fn settle(
    state: &AppState,
    row: &PendingPayment,
) -> Result<(PendingStatus, Option<AccessGrant>), AppError> {
    let status = match row.status {
        PendingStatus::Pending => {
            let remote = yookassa_gateway(state)?
                .fetch_payment(&row.provider_payment_id)
                .await?;
            match remote.status {
                yookassa::RemoteStatus::Succeeded => {
                    let won = state.payment_rows.settle_succeeded(&row.id).await?;
                    if won && let Some(code) = &row.coupon_code {
                        // The money is taken: a cap exhausted since checkout
                        // must not block the grant — log and move on.
                        if let Err(e) = state
                            .coupons
                            .redeem(code, &row.user_id, &row.quest_id, row.price)
                            .await
                        {
                            tracing::warn!(
                                payment = %row.id,
                                code,
                                error = ?e,
                                "coupon redemption failed at settlement; grant created anyway"
                            );
                        }
                    }
                    PendingStatus::Succeeded
                }
                yookassa::RemoteStatus::Canceled => {
                    state.payment_rows.mark_canceled(&row.id).await?;
                    PendingStatus::Canceled
                }
                yookassa::RemoteStatus::Pending | yookassa::RemoteStatus::WaitingForCapture => {
                    PendingStatus::Pending
                }
            }
        }
        settled => settled,
    };
    if status != PendingStatus::Succeeded {
        return Ok((status, None));
    }
    let (grant, _) = state
        .grants
        .create_grant_idemp(
            &row.user_id,
            &row.quest_id,
            GrantSource::Payment,
            Some(row.provider_payment_id.clone()),
        )
        .await?;
    Ok((PendingStatus::Succeeded, Some(grant)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_status_round_trips_and_rejects_unknown() {
        for s in [
            PendingStatus::Pending,
            PendingStatus::Succeeded,
            PendingStatus::Canceled,
        ] {
            assert_eq!(PendingStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(PendingStatus::parse("waiting_for_capture"), None);
    }

    #[test]
    fn mock_ref_is_deterministic_per_player_and_quest() {
        assert_eq!(
            mock_payment_ref("dev:abc", "quest-q"),
            mock_payment_ref("dev:abc", "quest-q"),
            "stable ref for the idempotent grant"
        );
        assert_eq!(
            mock_payment_ref("dev:abc", "quest-q"),
            "mock-pay-dev:abc-quest-q"
        );
    }
}
