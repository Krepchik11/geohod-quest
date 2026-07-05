use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

/// Central application error type.
///
/// All fallible handlers return `Result<_, AppError>`, ensuring consistent JSON
/// error responses and structured logging via tracing.
#[derive(Debug, Error)]
pub enum AppError {
    /// Generic internal error. Details are logged, never leaked to clients. (500)
    #[error("internal server error")]
    Internal(#[from] anyhow::Error),

    /// Bad request (invalid payload, missing fields). (400)
    #[allow(dead_code)]
    #[error("bad request: {0}")]
    BadRequest(String),

    /// Missing/invalid credentials — e.g. claiming a registered player id without
    /// a valid session token, or a failed login. (401)
    #[error("unauthorized: {0}")]
    Unauthorized(String),

    /// Missing/insufficient access — e.g. attempt creation without a grant. (403)
    #[error("forbidden: {0}")]
    Forbidden(String),

    /// State conflict — e.g. registering an email that is already taken. (409)
    #[error("conflict: {0}")]
    Conflict(String),

    /// Unknown resource — e.g. facts for a non-existent attempt. (404)
    #[error("not found: {0}")]
    NotFound(String),

    /// Rate limit exceeded — e.g. the identify email-existence probe. (429)
    #[error("too many requests: {0}")]
    TooManyRequests(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        tracing::error!(error = ?self, "request failed");

        let (status, message) = match self {
            AppError::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error".to_string(),
            ),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            AppError::TooManyRequests(msg) => (StatusCode::TOO_MANY_REQUESTS, msg),
        };

        (status, Json(json!({ "error": message }))).into_response()
    }
}
