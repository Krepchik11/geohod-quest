//! Quest export: bundle a constructor quest's full record — attributes, the
//! opaque authoring body (all steps), every media file it references, and
//! play/rating stats — into a single self-contained zip archive.
//!
//! Media discovery is structural, not a hardcoded field list: the quest JSON
//! is scanned recursively for any string value whose last path segment is a
//! sha256 hex digest (the media store's content-address key). This tracks
//! whatever media roles the authoring body shape has today AND any it grows
//! later, with no coupling to `constructor-model.ts` field names.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

use serde_json::Value;

use crate::errors::AppError;
use crate::facts::PerVersionStats;
use crate::media::MediaStores;
use crate::store::{ConstructorQuest, ReviewRow};

pub const FORMAT_VERSION: u32 = 1;

/// A sha256 hex digest is exactly 64 lowercase hex chars. Matching it as the
/// LAST path segment of a string (rather than requiring a configured
/// public_base prefix) keeps this decoupled from where media is hosted —
/// in-memory, R2, or a future custom domain all differ in prefix but agree on
/// this suffix.
fn media_hash_in_url(value: &str) -> Option<&str> {
    let candidate = value.rsplit('/').next()?;
    (candidate.len() == 64 && candidate.bytes().all(|b| b.is_ascii_hexdigit())).then_some(candidate)
}

fn collect_media_hashes(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::String(s) => {
            if let Some(hash) = media_hash_in_url(s) {
                out.insert(hash.to_string());
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect_media_hashes(v, out)),
        Value::Object(map) => map.values().for_each(|v| collect_media_hashes(v, out)),
        _ => {}
    }
}

/// Rewrite every media URL in `value` to its zip-relative path, in place.
/// Hashes with no entry in `hash_to_path` (the blob was missing from the
/// media store — an orphaned reference) are left untouched: the export still
/// succeeds, that one field just keeps pointing at the live URL.
fn rewrite_media_urls(value: &mut Value, hash_to_path: &BTreeMap<String, String>) {
    match value {
        Value::String(s) => {
            if let Some(path) = media_hash_in_url(s).and_then(|h| hash_to_path.get(h)) {
                *s = path.clone();
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|v| rewrite_media_urls(v, hash_to_path)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|v| rewrite_media_urls(v, hash_to_path)),
        _ => {}
    }
}

fn extension_for(content_type: &str) -> &'static str {
    match content_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

/// Play/rating stats bundled alongside the quest record.
#[derive(serde::Serialize)]
struct ExportStats {
    /// Completions of the constructor quest across all its snapshots (the
    /// same "completed" count shown on the author dashboard).
    completed: usize,
    buyers: usize,
    /// The live published snapshot version, if any (a draft or a quest that
    /// was never published has none, and `version_stats` is then `None` too —
    /// there is no snapshot to fold facts against).
    published_version: Option<u32>,
    reviews: Vec<ReviewRow>,
    version_stats: Option<PerVersionStats>,
}

#[derive(serde::Serialize)]
struct ExportManifest {
    format_version: u32,
    exported_at: u64,
    quest_id: String,
}

/// Everything the caller has already fetched, handed to the zip builder as
/// plain data — this module does no store/media-store lookups of its own
/// beyond fetching the referenced blobs, so it stays testable without a store.
pub struct ExportInputs {
    pub quest: ConstructorQuest,
    pub completed: usize,
    pub buyers: usize,
    pub published_version: Option<u32>,
    pub reviews: Vec<ReviewRow>,
    pub version_stats: Option<PerVersionStats>,
}

/// Build the export zip: `manifest.json`, `quest.json` (the full constructor
/// quest record with every discovered media URL rewritten to a zip-relative
/// `media/<hash>.<ext>` path), `stats.json`, and the media files themselves.
pub async fn build_quest_export_zip(
    media: &MediaStores,
    inputs: ExportInputs,
) -> Result<Vec<u8>, AppError> {
    let quest_id = inputs.quest.quest_id.clone();
    let mut quest_json = serde_json::to_value(&inputs.quest)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("serialize quest for export: {e}")))?;

    let mut hashes = BTreeSet::new();
    collect_media_hashes(&quest_json, &mut hashes);

    let mut hash_to_path = BTreeMap::new();
    let mut media_files: Vec<(String, bytes::Bytes)> = Vec::new();
    for hash in &hashes {
        let Some(blob) = media.get(hash).await? else {
            continue;
        };
        let path = format!("media/{hash}.{}", extension_for(&blob.content_type));
        hash_to_path.insert(hash.clone(), path.clone());
        media_files.push((path, blob.bytes));
    }
    rewrite_media_urls(&mut quest_json, &hash_to_path);

    let stats = ExportStats {
        completed: inputs.completed,
        buyers: inputs.buyers,
        published_version: inputs.published_version,
        reviews: inputs.reviews,
        version_stats: inputs.version_stats,
    };
    let manifest = ExportManifest {
        format_version: FORMAT_VERSION,
        exported_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        quest_id,
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("serialize export manifest: {e}")))?;
    let quest_bytes = serde_json::to_vec_pretty(&quest_json)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("serialize export quest.json: {e}")))?;
    let stats_bytes = serde_json::to_vec_pretty(&stats)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("serialize export stats: {e}")))?;

    // Zip compression is CPU-bound; run it on the blocking pool so it never
    // stalls the async runtime's worker threads for other requests.
    tokio::task::spawn_blocking(move || {
        write_zip(manifest_bytes, quest_bytes, stats_bytes, media_files)
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("export zip task panicked: {e}")))?
}

fn write_zip(
    manifest_bytes: Vec<u8>,
    quest_bytes: Vec<u8>,
    stats_bytes: Vec<u8>,
    media_files: Vec<(String, bytes::Bytes)>,
) -> Result<Vec<u8>, AppError> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let write_entry =
        |zip: &mut zip::ZipWriter<_>, name: &str, bytes: &[u8]| -> Result<(), AppError> {
            zip.start_file(name, options)
                .map_err(|e| AppError::Internal(anyhow::anyhow!("zip start_file '{name}': {e}")))?;
            zip.write_all(bytes)
                .map_err(|e| AppError::Internal(anyhow::anyhow!("zip write '{name}': {e}")))
        };
    write_entry(&mut zip, "manifest.json", &manifest_bytes)?;
    write_entry(&mut zip, "quest.json", &quest_bytes)?;
    write_entry(&mut zip, "stats.json", &stats_bytes)?;
    for (path, bytes) in &media_files {
        write_entry(&mut zip, path, bytes)?;
    }
    zip.finish()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("zip finish: {e}")))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_hash_in_url_matches_trailing_hex64() {
        let hash = "a".repeat(64);
        let url = format!("https://cdn.example.com/api/media/{hash}");
        assert_eq!(media_hash_in_url(&url), Some(hash.as_str()));
    }

    #[test]
    fn media_hash_in_url_rejects_short_or_non_hex() {
        assert_eq!(media_hash_in_url("https://x/api/media/tooshort"), None);
        assert_eq!(media_hash_in_url("plain text, no url here"), None);
        assert_eq!(media_hash_in_url(&"g".repeat(64)), None);
    }

    #[test]
    fn collect_and_rewrite_round_trip_nested_urls() {
        let hash = "b".repeat(64);
        let url = format!("https://cdn.example.com/api/media/{hash}");
        let mut value = serde_json::json!({
            "meta": { "cover": url },
            "steps": [{ "image": url, "hint": { "image": Value::Null } }],
        });

        let mut hashes = BTreeSet::new();
        collect_media_hashes(&value, &mut hashes);
        assert_eq!(hashes.len(), 1);
        assert!(hashes.contains(&hash));

        let mut hash_to_path = BTreeMap::new();
        hash_to_path.insert(hash.clone(), format!("media/{hash}.png"));
        rewrite_media_urls(&mut value, &hash_to_path);

        assert_eq!(value["meta"]["cover"], format!("media/{hash}.png"));
        assert_eq!(value["steps"][0]["image"], format!("media/{hash}.png"));
    }

    #[tokio::test]
    async fn build_quest_export_zip_bundles_manifest_quest_stats_and_media() {
        let media = MediaStores::InMemory(std::sync::Arc::new(std::sync::Mutex::new(
            crate::media::InMemoryMediaStore::new("http://test.local/api/media".to_string()),
        )));
        let media_ref = media
            .put(bytes::Bytes::from_static(b"fake-png-bytes"), "image/png")
            .await
            .unwrap();

        let quest = ConstructorQuest {
            quest_id: "q-export-1".to_string(),
            author_id: "author-1".to_string(),
            author_name: "Автор".to_string(),
            name: "Тестовый квест".to_string(),
            status: "draft".to_string(),
            cover: Some(media_ref.url.clone()),
            steps_count: 1,
            attrs: crate::store::QuestAttributes::default(),
            created_at: 1,
            updated_at: 2,
            body: serde_json::json!({
                "meta": { "cover": media_ref.url },
                "steps": [{ "image": media_ref.url }],
            }),
        };

        let zip_bytes = build_quest_export_zip(
            &media,
            ExportInputs {
                quest,
                completed: 3,
                buyers: 5,
                published_version: Some(1),
                reviews: vec![],
                version_stats: None,
            },
        )
        .await
        .unwrap();

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        let expected_media_path = format!("media/{}.png", media_ref.hash);
        assert_eq!(
            names,
            vec![
                "manifest.json".to_string(),
                expected_media_path.clone(),
                "quest.json".to_string(),
                "stats.json".to_string(),
            ]
        );

        let mut quest_entry = archive.by_name("quest.json").unwrap();
        let mut quest_out = String::new();
        std::io::Read::read_to_string(&mut quest_entry, &mut quest_out).unwrap();
        let quest_value: Value = serde_json::from_str(&quest_out).unwrap();
        assert_eq!(quest_value["cover"], expected_media_path);
        assert_eq!(quest_value["body"]["meta"]["cover"], expected_media_path);
        assert_eq!(
            quest_value["body"]["steps"][0]["image"],
            expected_media_path
        );
    }
}
