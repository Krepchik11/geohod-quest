//! Media (image) storage: content-addressed blobs in Cloudflare R2, with an
//! in-process fallback for tests and local dev.
//!
//! Quest media (cover + per-step comics) used to live as base64 inside the quest
//! JSON — the structural cause of slow lists and publish 413s. Here it is
//! externalized: bytes are stored once under their sha256, and the JSON carries a
//! public URL. The SERVER hashes the bytes, so the content address is
//! authoritative — a client cannot store bytes-A under the key for bytes-B.
//!
//! Mirrors the storage layer's two-variant pattern (in-memory spec + durable
//! backend), here `MediaStores::{InMemory, R2}`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use sha2::{Digest, Sha256};

use crate::config::MediaConfig;
use crate::errors::AppError;

/// Reference returned after an upload; stored verbatim in quest JSON.
#[derive(serde::Serialize, Clone, Debug)]
pub struct MediaRef {
    /// Public URL the bytes are served from (`"{public_base}/{hash}"`).
    pub url: String,
    /// Lowercase-hex sha256 of the bytes — the object key / content address.
    pub hash: String,
    pub content_type: String,
    pub size: usize,
}

impl MediaRef {
    /// Build a ref from a content hash — the `"{public_base}/{hash}"` URL
    /// convention is owned here so both backends share it.
    fn new(public_base: &str, hash: String, content_type: &str, size: usize) -> Self {
        Self {
            url: format!("{public_base}/{hash}"),
            hash,
            content_type: content_type.to_string(),
            size,
        }
    }
}

/// Stored bytes + their content-type, for the in-process serving route. `bytes`
/// is `Bytes` (refcounted) so cloning it out from under the store lock is a
/// refcount bump, not a buffer copy.
#[derive(Clone)]
pub struct StoredBlob {
    pub bytes: Bytes,
    pub content_type: String,
}

/// Lowercase-hex sha256 of `bytes` — the universal content-address key (shared
/// by the import tool by convention, so identical images dedup across sources).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Extract the media hash from a stored-media reference: `https://…/{hash}` or
/// `/api/media/{hash}` — anything whose last path segment (query/fragment
/// stripped) is a 64-hex sha256. Suffix-based on purpose: the prefix differs
/// per environment (in-memory, R2, a future custom domain), so references stay
/// recognizable across environments — e.g. inside an exported archive.
pub fn media_hash_in_ref(reference: &str) -> Option<&str> {
    let tail = reference.split(['?', '#']).next()?.rsplit('/').next()?;
    (tail.len() == 64 && tail.bytes().all(|b| b.is_ascii_hexdigit())).then_some(tail)
}

/// In-process content-addressed store (tests + local dev). Bytes are kept in a
/// map and served back through the API at `GET /api/media/{hash}`.
pub struct InMemoryMediaStore {
    items: HashMap<String, StoredBlob>,
    public_base: String,
}

impl InMemoryMediaStore {
    pub fn new(public_base: String) -> Self {
        Self {
            items: HashMap::new(),
            public_base,
        }
    }

    fn put(&mut self, bytes: Bytes, content_type: &str) -> MediaRef {
        let hash = sha256_hex(&bytes);
        let size = bytes.len();
        // Content-addressed: identical bytes already present are a no-op.
        self.items.entry(hash.clone()).or_insert(StoredBlob {
            bytes,
            content_type: content_type.to_string(),
        });
        MediaRef::new(&self.public_base, hash, content_type, size)
    }

    fn get(&self, hash: &str) -> Option<StoredBlob> {
        self.items.get(hash).cloned()
    }
}

/// Cloudflare R2 (S3-compatible) content-addressed store.
pub struct R2MediaStore {
    bucket: Box<s3::Bucket>,
    public_base: String,
}

impl R2MediaStore {
    pub fn new(
        account_id: &str,
        access_key_id: &str,
        secret_access_key: &str,
        bucket: &str,
        public_base: String,
        endpoint: Option<&str>,
    ) -> Result<Self, AppError> {
        let region = s3::Region::Custom {
            region: "auto".to_string(),
            // Default to the account endpoint; an override points at a local S3
            // mock (MinIO) in tests.
            endpoint: endpoint
                .map(str::to_string)
                .unwrap_or_else(|| format!("https://{account_id}.r2.cloudflarestorage.com")),
        };
        let credentials = s3::creds::Credentials::new(
            Some(access_key_id),
            Some(secret_access_key),
            None,
            None,
            None,
        )
        .map_err(|e| AppError::Internal(anyhow::anyhow!("R2 credentials: {e}")))?;
        // Path-style (`endpoint/bucket/key`) — the documented-safe addressing for
        // R2's account endpoint.
        let bucket = s3::Bucket::new(bucket, region, credentials)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("R2 bucket init: {e}")))?
            .with_path_style();
        Ok(Self {
            bucket,
            public_base,
        })
    }

    async fn put(&self, bytes: Bytes, content_type: &str) -> Result<MediaRef, AppError> {
        let hash = sha256_hex(&bytes);
        let key = format!("/{hash}");
        let size = bytes.len();
        // Content-addressed → identical bytes already in the bucket need no
        // re-upload. HEAD 200 == present; treat anything else as absent and PUT.
        // (This makes idempotent re-imports/re-saves cheap — they skip the body.)
        let exists = matches!(self.bucket.head_object(&key).await, Ok((_, 200)));
        if !exists {
            let resp = self
                .bucket
                .put_object_with_content_type(&key, &bytes, content_type)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("R2 upload failed: {e}")))?;
            let code = resp.status_code();
            if !(200..300).contains(&code) {
                return Err(AppError::Internal(anyhow::anyhow!(
                    "R2 upload returned status {code}"
                )));
            }
        }
        Ok(MediaRef::new(&self.public_base, hash, content_type, size))
    }

    /// Fetch stored bytes by content hash so the API can serve R2 media through
    /// its OWN origin (`GET /api/media/{hash}`) when the bucket has no public
    /// custom domain. A missing key is `Ok(None)`, not an error: with `fail-on-err`
    /// off (see Cargo.toml) rust-s3 surfaces a 404 as `Ok` carrying that status.
    async fn get(&self, hash: &str) -> Result<Option<StoredBlob>, AppError> {
        let key = format!("/{hash}");
        let resp = self
            .bucket
            .get_object(&key)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("R2 get failed: {e}")))?;
        match resp.status_code() {
            200 => {
                // Echo back the content-type we stored on PUT; default defensively.
                let content_type = resp
                    .headers()
                    .into_iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                    .map(|(_, v)| v)
                    .unwrap_or_else(|| "application/octet-stream".to_string());
                Ok(Some(StoredBlob {
                    bytes: resp.into_bytes(),
                    content_type,
                }))
            }
            404 => Ok(None),
            code => Err(AppError::Internal(anyhow::anyhow!(
                "R2 get returned status {code}"
            ))),
        }
    }
}

/// Media store selected at startup (mirrors the storage enums). Both variants
/// wrap their backend in an `Arc` so the per-request `AppState` clone is a
/// refcount bump, not a deep clone of the store.
#[derive(Clone)]
pub enum MediaStores {
    InMemory(Arc<Mutex<InMemoryMediaStore>>),
    R2(Arc<R2MediaStore>),
}

impl MediaStores {
    /// Build the store the config selects. R2 client init can fail (bad creds);
    /// the in-process store is infallible.
    pub fn from_config(cfg: &MediaConfig) -> Result<Self, AppError> {
        match cfg {
            MediaConfig::R2 {
                account_id,
                access_key_id,
                secret_access_key,
                bucket,
                public_base,
                endpoint,
            } => Ok(Self::R2(Arc::new(R2MediaStore::new(
                account_id,
                access_key_id,
                secret_access_key,
                bucket,
                public_base.clone(),
                endpoint.as_deref(),
            )?))),
            MediaConfig::Local { public_base } => Ok(Self::InMemory(Arc::new(Mutex::new(
                InMemoryMediaStore::new(public_base.clone()),
            )))),
        }
    }

    fn lock_inmem(
        m: &Mutex<InMemoryMediaStore>,
    ) -> Result<std::sync::MutexGuard<'_, InMemoryMediaStore>, AppError> {
        m.lock()
            .map_err(|e| AppError::Internal(anyhow::anyhow!("media store lock poisoned: {e}")))
    }

    /// Store `bytes` content-addressed and return the public reference. Idempotent:
    /// identical bytes resolve to the same URL and are not re-stored.
    pub async fn put(&self, bytes: Bytes, content_type: &str) -> Result<MediaRef, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.put(bytes, content_type)),
            Self::R2(r) => r.put(bytes, content_type).await,
        }
    }

    /// Fetch stored bytes for the `GET /api/media/{hash}` serve route. Both
    /// backends serve through this origin: the in-process store from memory, the
    /// R2 store by fetching the object — so media works without a public bucket
    /// domain. `None` = no such key (404).
    pub async fn get(&self, hash: &str) -> Result<Option<StoredBlob>, AppError> {
        match self {
            Self::InMemory(m) => Ok(Self::lock_inmem(m)?.get(hash)),
            Self::R2(r) => r.get(hash).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_is_deterministic_and_distinct() {
        assert_eq!(sha256_hex(b"hello"), sha256_hex(b"hello"));
        assert_ne!(sha256_hex(b"hello"), sha256_hex(b"world"));
        // Known vector: sha256("") = e3b0c44298fc1c14...
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn media_hash_in_ref_extracts_sha256_tails_only() {
        let h = "a".repeat(64);
        assert_eq!(
            media_hash_in_ref(&format!("https://media.geohod.ru/{h}")),
            Some(h.as_str())
        );
        assert_eq!(
            media_hash_in_ref(&format!("/api/media/{h}?x=1")),
            Some(h.as_str())
        );
        assert_eq!(media_hash_in_ref("https://x/img.jpg"), None);
        assert_eq!(media_hash_in_ref("data:image/png;base64,xxxx"), None);
    }

    #[test]
    fn inmem_put_is_content_addressed_and_round_trips() {
        let mut store = InMemoryMediaStore::new("http://x/api/media".to_string());
        let r1 = store.put(Bytes::from_static(b"abc"), "image/png");
        // URL = base/hash; hash = sha256; size = byte length.
        assert_eq!(r1.url, format!("http://x/api/media/{}", r1.hash));
        assert_eq!(r1.hash, sha256_hex(b"abc"));
        assert_eq!(r1.size, 3);
        // Same bytes -> same ref (dedup); a different content-type doesn't fork it.
        let r2 = store.put(Bytes::from_static(b"abc"), "image/jpeg");
        assert_eq!(r1.hash, r2.hash);
        assert_eq!(store.items.len(), 1);
        // Round-trips the original bytes + content-type.
        let blob = store.get(&r1.hash).expect("stored");
        assert_eq!(blob.bytes.as_ref(), b"abc");
        assert_eq!(blob.content_type, "image/png");
        assert!(store.get("deadbeef").is_none());
    }

    /// Round-trips an upload through a real S3 server (MinIO) to prove the R2
    /// put/get path end-to-end against the actual rust-s3 client — including that
    /// a missing key is `None` (404) and the stored content-type comes back.
    ///
    /// Gated on `R2_TEST_ENDPOINT` so CI without MinIO skips it. Run locally with:
    ///   podman run -d -p 9000:9000 -e MINIO_ROOT_USER=minioadmin \
    ///     -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data
    ///   R2_TEST_ENDPOINT=http://127.0.0.1:9000 cargo test r2_put_then_get
    #[tokio::test]
    async fn r2_put_then_get_round_trips_via_s3() {
        let Ok(endpoint) = std::env::var("R2_TEST_ENDPOINT") else {
            eprintln!("skipping r2_put_then_get_round_trips_via_s3: set R2_TEST_ENDPOINT (MinIO)");
            return;
        };
        let bucket = "geohod-quest-media-test";
        // Pre-create the bucket (idempotent: a re-run / existing bucket is ignored).
        let region = s3::Region::Custom {
            region: "auto".to_string(),
            endpoint: endpoint.clone(),
        };
        let creds =
            s3::creds::Credentials::new(Some("minioadmin"), Some("minioadmin"), None, None, None)
                .unwrap();
        let _ = s3::Bucket::create_with_path_style(
            bucket,
            region,
            creds,
            s3::BucketConfiguration::default(),
        )
        .await;

        let store = R2MediaStore::new(
            "minioadmin",
            "minioadmin",
            "minioadmin",
            bucket,
            "http://example.test/api/media".to_string(),
            Some(&endpoint),
        )
        .unwrap();

        // Missing key -> None (clean 404, not an error).
        assert!(store.get(&sha256_hex(b"absent")).await.unwrap().is_none());

        // Put -> ref carries the public base + sha256 content address.
        let png = Bytes::from_static(b"\x89PNG\r\n\x1a\n-fake");
        let r = store.put(png.clone(), "image/png").await.unwrap();
        assert_eq!(r.hash, sha256_hex(&png));
        assert_eq!(r.url, format!("http://example.test/api/media/{}", r.hash));

        // Get -> exact bytes + stored content-type returned.
        let blob = store
            .get(&r.hash)
            .await
            .unwrap()
            .expect("present after put");
        assert_eq!(blob.bytes, png);
        assert_eq!(blob.content_type, "image/png");
    }
}
