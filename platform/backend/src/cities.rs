//! Cities: the admin «Города» page and the constructor's city dropdown.
//!
//! A quest names its city with a plain string — `meta.city` in the authoring
//! body, `city` on the published store card — exactly as before this page
//! existed, so offline clients and frozen snapshots keep reading the same
//! shape. What the admin edits per city (the picture for the main banner, the
//! slogan) lives in its own rows ([`crate::store::CityRecord`]), keyed by the
//! same name and holding no links to quests.
//!
//! The city LIST is therefore those rows plus every city a quest actually
//! uses, so a city typed into an old draft shows up without any seeding — a
//! misspelt duplicate («Нови-Сад» next to «Нови Сад») is visible with its
//! quest count and the admin merges it by renaming. Renaming moves every
//! quest's city string with it (drafts and store cards; frozen snapshots
//! stay as published).

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::AppState;
use crate::errors::AppError;
use crate::store::{self, CatalogListing, CityRecord, PublishedMeta, QuestLabel};

/// Longest city name: a real one is a couple of words.
pub const MAX_NAME_CHARS: usize = 60;

/// Longest slogan: one line over the banner picture.
pub const MAX_SLOGAN_CHARS: usize = 140;

/// Longest picture reference: a media URL, never inline bytes.
const MAX_IMAGE_CHARS: usize = 2048;

/// A city name as stored: trimmed, inner runs of spaces collapsed to one, so
/// «Нови  Сад» and « Нови Сад » cannot become two cities.
///
/// # Errors
///
/// `AppError::BadRequest` when the name is blank or longer than
/// [`MAX_NAME_CHARS`].
pub fn normalize_name(raw: &str) -> Result<String, AppError> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::BadRequest("введите название города".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::BadRequest(format!(
            "название города длиннее {MAX_NAME_CHARS} символов"
        )));
    }
    Ok(name)
}

/// The slogan as stored: trimmed, blank means none.
///
/// # Errors
///
/// `AppError::BadRequest` when it is longer than [`MAX_SLOGAN_CHARS`].
pub fn normalize_slogan(raw: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(slogan) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if slogan.chars().count() > MAX_SLOGAN_CHARS {
        return Err(AppError::BadRequest(format!(
            "слоган длиннее {MAX_SLOGAN_CHARS} символов"
        )));
    }
    Ok(Some(slogan.to_string()))
}

/// The picture reference as stored, after the caller externalized any inline
/// `data:` payload: blank means none, anything else must be a web or
/// same-origin URL.
///
/// # Errors
///
/// `AppError::BadRequest` for a non-URL value (still inline bytes, another
/// scheme) or one longer than 2048 characters.
pub fn check_image(image: Option<String>) -> Result<Option<String>, AppError> {
    let Some(image) = image
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let is_url =
        image.starts_with("https://") || image.starts_with("http://") || image.starts_with('/');
    if !is_url || image.chars().count() > MAX_IMAGE_CHARS {
        return Err(AppError::BadRequest(
            "картинка города должна быть загруженным изображением".into(),
        ));
    }
    Ok(Some(image))
}

/// How many quests carry one city.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CityUsage {
    /// Distinct quests whose draft OR store card names the city.
    pub quests: usize,
    /// Quests a player sees in the shop under this city.
    pub in_store: usize,
}

/// Count quests per city from both registries.
///
/// A quest counts under its draft's city and under its store card's city —
/// once per city, even when both name it; they differ only while an edited
/// draft waits for its next publish. «В магазине» follows the shop's own
/// visibility rule ([`store::listed_in_store`]).
///
/// # Arguments
///
/// * `labels` - Every constructor quest's label (authored city, trimmed)
/// * `published` - Every published store card
/// * `listings` - Constructor lifecycle per quest (shop visibility)
///
/// # Returns
///
/// Usage per city name; cities nothing uses are absent.
pub fn usage_by_city(
    labels: &HashMap<String, QuestLabel>,
    published: &[PublishedMeta],
    listings: &HashMap<String, CatalogListing>,
) -> HashMap<String, CityUsage> {
    let mut quests: HashMap<String, HashSet<&str>> = HashMap::new();
    let mut usage: HashMap<String, CityUsage> = HashMap::new();
    for (quest_id, label) in labels {
        if let Some(city) = &label.city {
            quests.entry(city.clone()).or_default().insert(quest_id);
        }
    }
    for meta in published {
        let Some(city) = card_city(meta) else {
            continue;
        };
        quests
            .entry(city.to_string())
            .or_default()
            .insert(&meta.quest_id);
        if store::listed_in_store(listings, &meta.quest_id) {
            usage.entry(city.to_string()).or_default().in_store += 1;
        }
    }
    for (city, ids) in quests {
        usage.entry(city).or_default().quests = ids.len();
    }
    usage
}

/// A store card's city by the label rule: trimmed, blank means none.
fn card_city(meta: &PublishedMeta) -> Option<&str> {
    meta.city
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
}

/// One line of the city list: the admin's data (empty for a city only quests
/// name) and its usage.
#[derive(Clone, Debug, PartialEq)]
pub struct CityRow {
    pub record: CityRecord,
    pub usage: CityUsage,
}

/// The city list: saved rows plus every city quests use, the busiest first,
/// then by name.
///
/// # Arguments
///
/// * `records` - The admin's saved rows
/// * `usage` - Quest counts from [`usage_by_city`]
///
/// # Returns
///
/// One row per distinct name.
pub fn city_rows(records: Vec<CityRecord>, mut usage: HashMap<String, CityUsage>) -> Vec<CityRow> {
    let mut rows: BTreeMap<String, CityRow> = BTreeMap::new();
    for record in records {
        let usage = usage.remove(&record.name).unwrap_or_default();
        rows.insert(record.name.clone(), CityRow { record, usage });
    }
    for (name, usage) in usage {
        let record = CityRecord {
            name: name.clone(),
            image: None,
            slogan: None,
        };
        rows.insert(name, CityRow { record, usage });
    }
    let mut out: Vec<CityRow> = rows.into_values().collect();
    // BTreeMap already ordered the names; a stable sort keeps that order
    // within one count.
    out.sort_by_key(|row| std::cmp::Reverse(row.usage.quests));
    out
}

/// The current city list, read from every store it is assembled from.
///
/// # Errors
///
/// Any store failure.
pub async fn load_rows(state: &AppState) -> Result<Vec<CityRow>, AppError> {
    let (records, labels, published, listings) = tokio::join!(
        state.cities.list(),
        state.constructor.labels_by_quest(),
        state.grants.list_published(),
        state.constructor.listings_by_quest(),
    );
    let usage = usage_by_city(&labels?, &published?, &listings?);
    Ok(city_rows(records?, usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(city: Option<&str>) -> QuestLabel {
        QuestLabel::from_authored("Квест".into(), city)
    }

    fn card(quest_id: &str, city: Option<&str>) -> PublishedMeta {
        PublishedMeta {
            quest_id: quest_id.into(),
            name: "Квест".into(),
            primary_comic: None,
            template_summary: String::new(),
            snapshot_version: 1,
            snapshot_id: format!("{quest_id}-v1"),
            city: city.map(str::to_string),
            duration: None,
            duration_min: store::DEFAULT_DURATION_MIN,
            distance_km: store::DEFAULT_DISTANCE_KM,
            price: None,
            description: None,
            pages: None,
            tasks: None,
            paid_hints: None,
            players_bonus: 0,
        }
    }

    fn listing(status: &str) -> CatalogListing {
        CatalogListing {
            status: status.into(),
            attrs: store::QuestAttributes::default(),
        }
    }

    #[test]
    fn names_are_trimmed_and_inner_spaces_collapsed() {
        assert_eq!(normalize_name("  Нови   Сад ").unwrap(), "Нови Сад");
        assert_eq!(normalize_name("Белград").unwrap(), "Белград");
        assert!(normalize_name("   ").is_err());
        assert!(normalize_name(&"я".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert!(normalize_name(&"я".repeat(MAX_NAME_CHARS)).is_ok());
    }

    #[test]
    fn slogan_blank_is_none_and_long_is_rejected() {
        assert_eq!(normalize_slogan(None).unwrap(), None);
        assert_eq!(normalize_slogan(Some("  ")).unwrap(), None);
        assert_eq!(
            normalize_slogan(Some(" Город у Дуная "))
                .unwrap()
                .as_deref(),
            Some("Город у Дуная")
        );
        assert!(normalize_slogan(Some(&"а".repeat(MAX_SLOGAN_CHARS + 1))).is_err());
    }

    #[test]
    fn image_must_be_a_url() {
        assert_eq!(check_image(None).unwrap(), None);
        assert_eq!(check_image(Some(" ".into())).unwrap(), None);
        assert_eq!(
            check_image(Some("https://api.example/api/media/ab".into()))
                .unwrap()
                .as_deref(),
            Some("https://api.example/api/media/ab")
        );
        assert!(check_image(Some("/api/media/ab".into())).is_ok());
        assert!(check_image(Some("data:image/png;base64,AAAA".into())).is_err());
        assert!(check_image(Some("javascript:alert(1)".into())).is_err());
    }

    /// A quest counts once per city, under its draft AND its card; the shop
    /// count follows the store's visibility rule.
    #[test]
    fn usage_counts_drafts_and_cards_once_per_city() {
        let labels = HashMap::from([
            ("q1".to_string(), label(Some(" Нови Сад "))),
            ("q2".to_string(), label(Some("Нови Сад"))),
            ("q3".to_string(), label(Some("Нови Сад"))),
            ("q4".to_string(), label(Some("Белград"))),
            ("q5".to_string(), label(None)),
        ]);
        let published = vec![
            card("q1", Some("Нови Сад")),
            // Draft moved to Нови Сад, card still says Нови-Сад until republished.
            card("q2", Some("Нови-Сад ")),
            // Published but back in test — off the shop.
            card("q4", Some("Белград")),
            // A legacy publish with no constructor row is in the shop.
            card("legacy", Some("Стамбул")),
            card("q5", Some("  ")),
        ];
        let listings = HashMap::from([
            ("q1".to_string(), listing(store::CTOR_STATUS_PUBLISHED)),
            ("q2".to_string(), listing(store::CTOR_STATUS_PUBLISHED)),
            ("q3".to_string(), listing("draft")),
            ("q4".to_string(), listing("test")),
            ("q5".to_string(), listing(store::CTOR_STATUS_PUBLISHED)),
        ]);
        let usage = usage_by_city(&labels, &published, &listings);
        let at = |c: &str| usage.get(c).copied().unwrap_or_default();
        assert_eq!(
            at("Нови Сад"),
            CityUsage {
                quests: 3,
                in_store: 1
            }
        );
        assert_eq!(
            at("Нови-Сад"),
            CityUsage {
                quests: 1,
                in_store: 1
            }
        );
        assert_eq!(
            at("Белград"),
            CityUsage {
                quests: 1,
                in_store: 0
            }
        );
        assert_eq!(
            at("Стамбул"),
            CityUsage {
                quests: 1,
                in_store: 1
            }
        );
        assert_eq!(usage.len(), 4, "a blank city is no city");
    }

    #[test]
    fn rows_join_saved_cities_with_used_ones_busiest_first() {
        let records = vec![
            CityRecord {
                name: "Москва".into(),
                image: None,
                slogan: Some("Скоро".into()),
            },
            CityRecord {
                name: "Нови Сад".into(),
                image: Some("/api/media/x".into()),
                slogan: None,
            },
        ];
        let usage = HashMap::from([
            (
                "Нови Сад".to_string(),
                CityUsage {
                    quests: 5,
                    in_store: 4,
                },
            ),
            (
                "Белград".to_string(),
                CityUsage {
                    quests: 1,
                    in_store: 1,
                },
            ),
            (
                "Стамбул".to_string(),
                CityUsage {
                    quests: 1,
                    in_store: 1,
                },
            ),
        ]);
        let rows = city_rows(records, usage);
        let names: Vec<&str> = rows.iter().map(|r| r.record.name.as_str()).collect();
        assert_eq!(names, vec!["Нови Сад", "Белград", "Стамбул", "Москва"]);
        assert_eq!(rows[0].record.image.as_deref(), Some("/api/media/x"));
        assert_eq!(rows[0].usage.in_store, 4);
        assert_eq!(
            rows[3].usage,
            CityUsage::default(),
            "a saved city with no quests"
        );
        assert_eq!(
            rows[1].record.slogan, None,
            "a city only quests name has no data"
        );
    }
}
