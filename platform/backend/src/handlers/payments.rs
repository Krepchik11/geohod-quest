//! Payment routes: checkout, payment status/webhook settlement, provider
//! discovery, and the purchase-sheet coupon preview. Thin HTTP shims over
//! `crate::payments`.

use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
    routing::{get, post},
};

use crate::authz::{claimed_from_headers, resolve_user};
use crate::errors::AppError;
use crate::features::{Feature, feature_available};
use crate::grants::AccessGrant;
use crate::{AppState, coupons, payments, yookassa};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/checkout", post(checkout_handler))
        .route("/api/payments/providers", get(payment_providers_handler))
        .route(
            "/api/payments/yookassa/webhook",
            post(yookassa_webhook_handler),
        )
        .route("/api/payments/{payment_id}", get(payment_status_handler))
        .route("/api/coupons/validate", post(validate_coupon_handler))
}

/// Thin HTTP shim over [`payments::checkout`]: resolve the identity, then let
/// the payment module run the provider dispatch and coupon rules.
async fn checkout_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<payments::CheckoutRequest>,
) -> Result<Json<payments::CheckoutResponse>, AppError> {
    let user_id = resolve_user(&state, &headers, &req.user_id).await?;
    Ok(Json(payments::checkout(&state, &user_id, &req).await?))
}

#[derive(serde::Serialize)]
struct PaymentStatusResponse {
    status: &'static str,
    grant: Option<AccessGrant>,
}

/// Owner poll for a redirect payment: lazily settles a still-pending row (the
/// return page lands here before the webhook on local/dev deployments).
async fn payment_status_handler(
    State(state): State<AppState>,
    Path(payment_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<PaymentStatusResponse>, AppError> {
    let claimed = claimed_from_headers(&headers);
    let user_id = resolve_user(&state, &headers, &claimed).await?;
    let row = state
        .payment_rows
        .get(&payment_id)
        .await?
        // A foreign payment reads as absent — ids must not be probeable.
        .filter(|p| p.user_id == user_id)
        .ok_or_else(|| AppError::NotFound("payment not found".into()))?;
    let (status, grant) = payments::settle(&state, &row).await?;
    Ok(Json(PaymentStatusResponse {
        status: status.as_str(),
        grant,
    }))
}

/// YooKassa HTTP notification. The body is only a pointer: settlement verifies
/// against the API, so a forged notification is harmless (and still gets 200).
/// Transient failures return 5xx so YooKassa keeps retrying (24h window).
async fn yookassa_webhook_handler(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, AppError> {
    let Some(provider_payment_id) = yookassa::notification_payment_id(&body) else {
        return Ok(StatusCode::OK); // not a payment event — nothing to settle
    };
    let Some(row) = state
        .payment_rows
        .find_by_provider_id(&provider_payment_id)
        .await?
    else {
        tracing::info!(payment = %provider_payment_id, "webhook for unknown payment ignored");
        return Ok(StatusCode::OK);
    };
    payments::settle(&state, &row).await?;
    Ok(StatusCode::OK)
}

/// Providers this deployment can charge through — drives the purchase sheet's
/// payment-method choice (a single entry renders no selector; an empty list
/// disables paying). A provider is listed only when it is both configured
/// (capability) and switched on (feature toggle).
async fn payment_providers_handler(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let overrides = state.flags.all().await?;
    let on =
        |f: Feature| feature_available(&state, f) && f.effective(overrides.get(f.key()).copied());
    let mut providers = Vec::new();
    if on(Feature::PaymentsMock) {
        providers.push("mock");
    }
    if on(Feature::PaymentsYookassa) {
        providers.push("yookassa");
    }
    Ok(Json(serde_json::json!({ "providers": providers })))
}

#[derive(serde::Deserialize)]
struct ValidateCouponRequest {
    user_id: String,
    quest_id: String,
    code: String,
}

/// Purchase-sheet promo preview: never mutates, always 200 with a verdict.
/// `{valid: true, ...}` carries the priced discount; `{valid: false, message}`
/// carries the player-facing reason (unknown and deleted codes read the same).
async fn validate_coupon_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ValidateCouponRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = resolve_user(&state, &headers, &req.user_id).await?;
    let invalid = |message: &str| serde_json::json!({"valid": false, "message": message});
    let Ok(code) = coupons::normalize_code(&req.code) else {
        return Ok(Json(invalid("промокод не найден")));
    };
    let Some(price) = payments::quest_price(&state, &req.quest_id).await? else {
        return Ok(Json(invalid(
            coupons::RedeemReject::NotApplicable.message(),
        )));
    };
    let (code, discount_amount) =
        match payments::quote_coupon(&state, &code, &user_id, &req.quest_id, price).await? {
            Ok(quote) => quote,
            Err(reason) => return Ok(Json(invalid(reason))),
        };
    Ok(Json(serde_json::json!({
        "valid": true,
        "code": code,
        "price": price,
        "discount_amount": discount_amount,
        "final_price": price - discount_amount,
    })))
}
