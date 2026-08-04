//! Media routes: upload (editor-gated, lifts the body cap to a single image)
//! and the serve route (serves in-process AND R2 media through this origin).

use axum::{
    Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, header},
    response::Json,
    routing::{get, post},
};

use crate::AppState;
use crate::authz::require_editor;
use crate::errors::AppError;
use crate::media::MediaRef;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/media",
            post(upload_media_handler).layer(DefaultBodyLimit::max(MAX_MEDIA_BYTES)),
        )
        .route("/api/media/{hash}", get(get_media_handler))
}

/// Body-size ceiling for a single media upload. The client downscales images to
/// ≤2.5 MB before upload; 10 MiB is a generous ceiling that still rejects abuse.
const MAX_MEDIA_BYTES: usize = 10 * 1024 * 1024;

/// Image content-types accepted for upload (what the editor produces and the
/// import tool emits). Anything else is rejected before it reaches storage.
fn is_allowed_media_type(ct: &str) -> bool {
    matches!(ct, "image/jpeg" | "image/png" | "image/webp" | "image/gif")
}

/// POST /api/media — upload a quest image (editor-gated). The body is the raw
/// image bytes and `Content-Type` names the format. The SERVER hashes the bytes
/// (sha256) and stores them content-addressed in R2 (or the in-process store),
/// returning the public URL the quest JSON should reference. Idempotent: identical
/// bytes resolve to the same URL and are not re-stored.
async fn upload_media_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<MediaRef>, AppError> {
    require_editor(&state, &headers).await?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        // drop any "; charset=…" parameter the client may append (split always
        // yields ≥1 element, so the unwrap fallback is never taken)
        .map(|s| s.split(';').next().unwrap_or("").trim().to_string())
        .unwrap_or_default();
    if !is_allowed_media_type(&content_type) {
        return Err(AppError::BadRequest(format!(
            "unsupported media type '{content_type}' (allowed: jpeg, png, webp, gif)"
        )));
    }
    if body.is_empty() {
        return Err(AppError::BadRequest("empty media upload".into()));
    }
    let media_ref = state.media.put(body, &content_type).await?;
    Ok(Json(media_ref))
}

/// GET /api/media/{hash} — serve content-addressed media through the API's own
/// origin. Backs both stores: the in-process one (local dev / tests) and R2
/// (fetched from the bucket), so media is served without a public bucket domain.
/// A custom domain would instead serve R2 directly and this would 404 in prod.
async fn get_media_handler(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let Some(blob) = state.media.get(&hash).await? else {
        return Err(AppError::NotFound(format!("media '{hash}' not found")));
    };
    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, blob.content_type)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(axum::body::Body::from(blob.bytes))
        .map_err(|e| AppError::Internal(anyhow::anyhow!("media response build: {e}")))
}
