//! Quest export: bundle a constructor quest's full record — attributes, the
//! opaque authoring body (all steps) and every media file it references —
//! into a single self-contained zip archive. Content only: play/rating stats
//! are live projections of the fact log, not quest content, so they do not
//! belong in a backup/migration artifact.
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
use crate::icons::cover_media_hash;
use crate::media::MediaStores;
use crate::store::ConstructorQuest;

pub const FORMAT_VERSION: u32 = 1;

// Media URLs are recognized by their trailing sha256 segment via the shared
// `icons::cover_media_hash` (rather than a configured public_base prefix),
// which keeps this decoupled from where media is hosted — in-memory, R2, or a
// future custom domain all differ in prefix but agree on this suffix.

fn collect_media_hashes(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::String(s) => {
            if let Some(hash) = cover_media_hash(s) {
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
            if let Some(path) = cover_media_hash(s).and_then(|h| hash_to_path.get(h)) {
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

#[derive(serde::Serialize)]
struct ExportManifest {
    format_version: u32,
    exported_at: u64,
    quest_id: String,
}

/// Build the export zip: `manifest.json`, `quest.json` (the full constructor
/// quest record with every discovered media URL rewritten to a zip-relative
/// `media/<hash>.<ext>` path), and the media files themselves.
pub async fn build_quest_export_zip(
    media: &MediaStores,
    quest: ConstructorQuest,
) -> Result<Vec<u8>, AppError> {
    let quest_id = quest.quest_id.clone();
    let mut quest_json = serde_json::to_value(&quest)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("serialize quest for export: {e}")))?;

    let mut hashes = BTreeSet::new();
    collect_media_hashes(&quest_json, &mut hashes);

    // Fetch the referenced blobs concurrently — on R2 each get is a network
    // round-trip, and serializing tens of them would dominate export latency.
    // BTreeMap keeps the archive ordering deterministic regardless of which
    // fetch finishes first.
    let mut fetches = tokio::task::JoinSet::new();
    for hash in hashes {
        let media = media.clone();
        fetches.spawn(async move { (media.get(&hash).await, hash) });
    }
    let mut hash_to_path = BTreeMap::new();
    let mut media_by_path = BTreeMap::new();
    while let Some(joined) = fetches.join_next().await {
        let (blob, hash) = joined
            .map_err(|e| AppError::Internal(anyhow::anyhow!("export media fetch panicked: {e}")))?;
        // A missing blob (orphaned reference) is skipped; see rewrite_media_urls.
        if let Some(blob) = blob? {
            let path = format!("media/{hash}.{}", extension_for(&blob.content_type));
            hash_to_path.insert(hash, path.clone());
            media_by_path.insert(path, blob.bytes);
        }
    }
    let media_files: Vec<(String, bytes::Bytes)> = media_by_path.into_iter().collect();
    rewrite_media_urls(&mut quest_json, &hash_to_path);

    let manifest = ExportManifest {
        format_version: FORMAT_VERSION,
        exported_at: crate::store::now_secs(),
        quest_id,
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("serialize export manifest: {e}")))?;
    let quest_bytes = serde_json::to_vec_pretty(&quest_json)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("serialize export quest.json: {e}")))?;

    // Zip compression is CPU-bound; run it on the blocking pool so it never
    // stalls the async runtime's worker threads for other requests.
    tokio::task::spawn_blocking(move || write_zip(manifest_bytes, quest_bytes, media_files))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("export zip task panicked: {e}")))?
}

fn write_zip(
    manifest_bytes: Vec<u8>,
    quest_bytes: Vec<u8>,
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

    // URL→hash extraction itself is covered by icons.rs tests (the shared
    // `cover_media_hash`); here we only test the recursive walk + rewrite.
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
    async fn build_quest_export_zip_bundles_manifest_quest_and_media() {
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

        let zip_bytes = build_quest_export_zip(&media, quest).await.unwrap();

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
