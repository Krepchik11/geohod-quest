//! HTTP handler modules, one per surface. Each exports only
//! `pub fn router() -> Router<AppState>`; `build_router` in `main.rs`
//! merges them and applies the shared middleware.

pub mod admin;
pub mod auth;
pub mod constructor;
pub mod media;
pub mod payments;
pub mod player;
