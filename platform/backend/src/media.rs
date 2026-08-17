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

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::MediaConfig;
use crate::errors::AppError;

/// Reference returned after an upload; stored verbatim in quest JSON.
#[derive(serde::Serialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "MediaRefWire"))]
pub struct MediaRef {
    /// Public URL the bytes are served from (`"{public_base}/{hash}"`).
    pub url: String,
    /// Lowercase-hex sha256 of the bytes — the object key / content address.
    pub hash: String,
    pub content_type: String,
    #[cfg_attr(test, ts(type = "number"))]
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

/// The image formats this store keeps, with the file extension an export gives
/// them. ONE table: the upload gate, the `data:` decoder and the export archive
/// all read it, so adding a format is a single edit and cannot half-land.
const MEDIA_TYPES: [(&str, &str); 4] = [
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
];

/// The stored content-type for a raw `Content-Type` value (`"IMAGE/PNG; q=1"` →
/// `"image/png"`): parameters dropped, trimmed, lowercased. `None` when the type
/// is not one this store keeps. Every door into the store normalizes here, so
/// an inline `data:` image and an upload header can never be judged differently.
pub fn normalized_media_type(raw: &str) -> Option<String> {
    let ct = raw.split(';').next()?.trim().to_ascii_lowercase();
    MEDIA_TYPES.iter().any(|(t, _)| *t == ct).then_some(ct)
}

/// File extension for a stored content-type — `"bin"` for anything this store
/// does not know, so an export never fails on an unexpected blob.
pub fn extension_for(content_type: &str) -> &'static str {
    MEDIA_TYPES
        .iter()
        .find(|(t, _)| *t == content_type)
        .map_or("bin", |(_, ext)| *ext)
}

/// A `data:` image URI decoded into what the store needs. The ONE decoder in the
/// codebase: the icon composer and the cover externalizer both read it here, so
/// "what counts as an inline image" cannot drift between them.
pub struct DataUri {
    pub bytes: Bytes,
    pub content_type: String,
}

/// Parse `data:<image type>;base64,<payload>`. `None` for anything else — a
/// URL, a type this store will not keep, or a payload that is not base64 — so a
/// caller can pass the original value through untouched instead of losing it.
pub fn parse_data_uri(value: &str) -> Option<DataUri> {
    use base64::Engine;
    let (meta, payload) = value.strip_prefix("data:")?.split_once(",")?;
    let content_type = normalized_media_type(meta.strip_suffix(";base64")?)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    (!bytes.is_empty()).then(|| DataUri {
        bytes: Bytes::from(bytes),
        content_type,
    })
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

/// Read every string value in a JSON tree, in document order.
///
/// THE recursive walk over authored content. A media reference can sit anywhere
/// in a quest body — cover, step image, its uncropped origin, whatever role the
/// shape grows next — so both directions (finding references for an export,
/// replacing inline images on a write) ride on this one walk instead of on a
/// field list that silently misses whatever nobody remembered to add.
pub fn visit_strings(value: &Value, f: &mut impl FnMut(&str)) {
    match value {
        Value::String(s) => f(s),
        Value::Array(items) => {
            for item in items {
                visit_strings(item, f);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                visit_strings(item, f);
            }
        }
        _ => {}
    }
}

/// [`visit_strings`]'s writing twin: replace a string wherever `f` returns one,
/// leave it alone on `None`.
pub fn map_strings(value: &mut Value, f: &mut impl FnMut(&str) -> Option<String>) {
    match value {
        Value::String(s) => {
            if let Some(replacement) = f(s) {
                *s = replacement;
            }
        }
        Value::Array(items) => {
            for item in items {
                map_strings(item, f);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                map_strings(item, f);
            }
        }
        _ => {}
    }
}

/// Uploads in flight per payload while externalizing. A quest carries one image
/// per step, so a handful of parallel round trips is the whole win.
const MAX_CONCURRENT_UPLOADS: usize = 8;

/// One finished upload, folded into the replacement map. A task that produced no
/// storable image contributes nothing, so its string stays as authored.
fn collect_upload(
    joined: Result<Result<Option<(String, String)>, AppError>, tokio::task::JoinError>,
    stored: &mut HashMap<String, String>,
) -> Result<(), AppError> {
    let uploaded = joined
        .map_err(|e| AppError::Internal(anyhow::anyhow!("media externalize task panicked: {e}")))?;
    if let Some((uri, url)) = uploaded? {
        stored.insert(uri, url);
    }
    Ok(())
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

    /// Move EVERY inline image in an authored payload into the store: each
    /// `data:` image anywhere in the tree is stored once and replaced by its
    /// content-addressed URL. Returns how many distinct images moved.
    ///
    /// Structural, not a field list. The cover was externalized by name once,
    /// which is exactly why the step images were not — a rule that names fields
    /// only covers the fields somebody remembered. Riding on [`visit_strings`]
    /// makes the rule "no authored payload is stored with pixels inside it",
    /// whatever roles the body shape has today or grows later.
    ///
    /// Distinct payloads upload concurrently, [`MAX_CONCURRENT_UPLOADS`] at a
    /// time: a legacy quest carries one image per step, and serializing those
    /// round trips would dominate a save. Identical payloads collapse before
    /// upload, and identical BYTES collapse again at the content address, so a
    /// picture reused across steps is stored once.
    pub async fn externalize_tree(&self, value: &mut Value) -> Result<usize, AppError> {
        // The cheap prefix test, not a full parse: deciding what is really an
        // image would decode megabytes of base64 twice, once here and once on
        // upload. Anything that turns out not to be a storable image simply
        // yields no replacement below and is left untouched.
        let mut inline = BTreeSet::new();
        visit_strings(value, &mut |s| {
            if s.starts_with("data:") {
                inline.insert(s.to_string());
            }
        });
        if inline.is_empty() {
            return Ok(0);
        }
        let mut uploads = tokio::task::JoinSet::new();
        let mut stored: HashMap<String, String> = HashMap::new();
        for uri in inline {
            // Wait for a slot before opening another. The payload decides how
            // many distinct images it contains, so an unbounded fan-out would
            // let one pathological body open a connection per image.
            if uploads.len() >= MAX_CONCURRENT_UPLOADS
                && let Some(joined) = uploads.join_next().await
            {
                collect_upload(joined, &mut stored)?;
            }
            let store = self.clone();
            uploads.spawn(async move {
                match parse_data_uri(&uri) {
                    Some(data) => store
                        .put(data.bytes, &data.content_type)
                        .await
                        .map(|stored| Some((uri, stored.url))),
                    None => Ok(None),
                }
            });
        }
        while let Some(joined) = uploads.join_next().await {
            collect_upload(joined, &mut stored)?;
        }
        map_strings(value, &mut |s| stored.get(s).cloned());
        Ok(stored.len())
    }

    /// The stored-media URL for a single authored image reference: an inline
    /// `data:` image is ingested once and replaced by its content-addressed URL;
    /// a URL, `None`, and an unreadable `data:` payload pass through unchanged.
    ///
    /// The scalar door for the denormalized cover column, defined in terms of
    /// [`Self::externalize_tree`] so the column and the body inside it cannot be
    /// judged by different rules and end up disagreeing about the same picture.
    pub async fn externalize(&self, value: Option<String>) -> Result<Option<String>, AppError> {
        let Some(raw) = value else { return Ok(None) };
        let mut one = Value::String(raw);
        self.externalize_tree(&mut one).await?;
        match one {
            Value::String(s) => Ok(Some(s)),
            other => Err(AppError::Internal(anyhow::anyhow!(
                "externalize returned a non-string: {other}"
            ))),
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
    fn parse_data_uri_reads_base64_images_only() {
        let uri = "data:image/png;base64,AAAA";
        let parsed = parse_data_uri(uri).expect("png");
        assert_eq!(parsed.content_type, "image/png");
        assert_eq!(parsed.bytes.as_ref(), &[0u8, 0, 0]);
        // Charset-style parameters ride between the type and the ;base64 marker.
        assert_eq!(
            parse_data_uri("data:IMAGE/JPEG;charset=binary;base64,AAAA")
                .expect("jpeg")
                .content_type,
            "image/jpeg"
        );
        // Everything a caller must pass through untouched rather than lose.
        assert!(parse_data_uri("/api/media/abc").is_none(), "a URL");
        assert!(
            parse_data_uri("data:image/png,plain").is_none(),
            "not base64"
        );
        assert!(
            parse_data_uri("data:text/html;base64,AAAA").is_none(),
            "not an image"
        );
        assert!(
            parse_data_uri("data:image/png;base64,!!!!").is_none(),
            "bad payload"
        );
        assert!(parse_data_uri("data:image/png;base64,").is_none(), "empty");
    }

    #[tokio::test]
    async fn externalize_stores_blobs_and_passes_urls_through() {
        let store = MediaStores::InMemory(Arc::new(Mutex::new(InMemoryMediaStore::new(
            "/api/media".to_string(),
        ))));
        let hash = sha256_hex(&[0u8, 0, 0]);
        assert_eq!(
            store
                .externalize(Some("data:image/png;base64,AAAA".into()))
                .await
                .expect("externalize"),
            Some(format!("/api/media/{hash}")),
        );
        assert_eq!(
            store.get(&hash).await.expect("get").expect("stored").bytes,
            Bytes::from_static(&[0u8, 0, 0]),
        );
        for untouched in ["/api/media/x", "data:image/png,plain"] {
            assert_eq!(
                store
                    .externalize(Some(untouched.into()))
                    .await
                    .expect("externalize"),
                Some(untouched.to_string()),
            );
        }
        assert_eq!(store.externalize(None).await.expect("externalize"), None);
    }

    /// The rule that replaced "externalize the fields we remembered": every
    /// inline image in the tree moves, at any depth and under any key, and
    /// everything that is not a storable image is left exactly as authored.
    #[tokio::test]
    async fn externalize_tree_moves_every_inline_image_at_any_depth() {
        let store = MediaStores::InMemory(Arc::new(Mutex::new(InMemoryMediaStore::new(
            "/api/media".to_string(),
        ))));
        let png = "data:image/png;base64,AAAA";
        let jpeg = "data:image/jpeg;base64,AQID";
        let mut body = serde_json::json!({
            "meta": { "cover": png, "title": "Квест" },
            "steps": [
                { "image": { "url": jpeg, "origin": { "url": png, "rect": { "x": 0 } } } },
                { "image": { "url": "/api/media/already-a-url" }, "hint": null },
                { "note": "data:text/html;base64,AAAA", "bad": "data:image/png;base64,!!!!" },
            ],
        });

        // Three inline strings, but only two distinct images: the repeated cover
        // collapses before it is ever uploaded.
        assert_eq!(store.externalize_tree(&mut body).await.expect("tree"), 2);

        let png_url = format!("/api/media/{}", sha256_hex(&[0u8, 0, 0]));
        let jpeg_url = format!("/api/media/{}", sha256_hex(&[1u8, 2, 3]));
        assert_eq!(body["meta"]["cover"], png_url);
        assert_eq!(body["steps"][0]["image"]["url"], jpeg_url);
        assert_eq!(body["steps"][0]["image"]["origin"]["url"], png_url);
        // Untouched: an already-stored URL, a non-image data URI, an undecodable
        // payload, and every value that is not a string.
        assert_eq!(body["steps"][1]["image"]["url"], "/api/media/already-a-url");
        assert_eq!(body["steps"][2]["note"], "data:text/html;base64,AAAA");
        assert_eq!(body["steps"][2]["bad"], "data:image/png;base64,!!!!");
        assert_eq!(body["meta"]["title"], "Квест");
        assert_eq!(body["steps"][0]["image"]["origin"]["rect"]["x"], 0);

        // The bytes really are in the store, addressed by their content.
        assert_eq!(
            store
                .get(&sha256_hex(&[1u8, 2, 3]))
                .await
                .expect("get")
                .expect("stored")
                .bytes,
            Bytes::from_static(&[1u8, 2, 3]),
        );

        // Idempotent: a second pass finds nothing inline and changes nothing.
        let once = body.clone();
        assert_eq!(store.externalize_tree(&mut body).await.expect("tree"), 0);
        assert_eq!(body, once);
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
