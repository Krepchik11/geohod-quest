//! The ONE owning module for reading a published quest snapshot (issue #64):
//! product-page chips, the start point and the quest colours, derived from the
//! frozen JSON.
//!
//! The frontend mirror is `lib/snapshot.ts`; the shared fixtures in
//! `../goldens/snapshot/` are executed by both suites, so any one-sided drift
//! in the snapshot readers breaks one of the two. (Media retention is NOT here:
//! it walks the authoring body, not the snapshot — see `export.rs`.)

/// Content chips for the product page, derived from the frozen snapshot at
/// publish time: page count, task count (task_no/task_answer templates) and
/// whether any step sells a paid hint. Tolerates foreign snapshot shapes by
/// returning None — the UI hides chips it cannot honestly claim.
pub fn snapshot_chips(
    snapshot: Option<&serde_json::Value>,
) -> (Option<u32>, Option<u32>, Option<bool>) {
    let Some(steps) = snapshot
        .and_then(|v| v.get("steps"))
        .and_then(|v| v.as_array())
    else {
        return (None, None, None);
    };
    let pages = steps.len() as u32;
    let tasks = steps
        .iter()
        .filter(|st| {
            st.get("template")
                .and_then(|t| t.as_str())
                .is_some_and(|t| t == "task_no" || t == "task_answer")
        })
        .count() as u32;
    let paid_hints = steps.iter().any(|st| {
        st.get("supporting")
            .and_then(|sup| sup.get("hint"))
            .is_some_and(|h| !h.is_null())
    });
    (Some(pages), Some(tasks), Some(paid_hints))
}

/// The quest's start point for the product page's «Место старта» button: the
/// author's quest-level `start_point`, frozen at publish. PRESENCE of the key —
/// not its value — decides who answers, since the constructor always writes it:
/// present ⇒ the author's word is final; absent ⇒ pre-field snapshot, and the
/// first step navigator stands in so old publishes keep their button.
pub fn snapshot_start_point(snapshot: Option<&serde_json::Value>) -> Option<StartPointWire> {
    let snapshot = snapshot?;
    if let Some(explicit) = snapshot.get("start_point") {
        return point_of(explicit);
    }
    let steps = snapshot.get("steps")?.as_array()?;
    steps
        .iter()
        .find_map(|st| point_of(st.get("supporting")?.get("navigator")?))
}

/// `{ lat, lng }` out of an untrusted JSON value; None for any other shape.
fn point_of(v: &serde_json::Value) -> Option<StartPointWire> {
    Some(StartPointWire {
        lat: v.get("lat")?.as_f64()?,
        lng: v.get("lng")?.as_f64()?,
    })
}

/// The quest's own colours, frozen at publish. Read out of the snapshot for the
/// per-quest PWA manifest: an installed quest must open on its OWN background,
/// not flash the default palette before the player paints. Any shape but three
/// `#rrggbb`-ish strings is no theme at all — the frontend's `parseTheme` makes
/// the same call, and both sides fall back to the default palette.
pub fn snapshot_theme(snapshot: Option<&serde_json::Value>) -> Option<ThemeWire> {
    let theme = snapshot?.get("theme")?;
    let hex = |key: &str| {
        let raw = theme.get(key)?.as_str()?.trim();
        let body = raw.strip_prefix('#')?;
        (matches!(body.len(), 3 | 6) && body.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| raw.to_string())
    };
    Some(ThemeWire {
        bg: hex("bg")?,
        ink: hex("ink")?,
        btn: hex("btn")?,
    })
}

/// Wire shape of the quest colours (see [`snapshot_theme`]).
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "ThemeWire"))]
pub struct ThemeWire {
    pub bg: String,
    pub ink: String,
    pub btn: String,
}

/// Wire shape of the quest start point (see [`snapshot_start_point`]). Bare
/// coordinates by design: the button reads «Место старта» and nothing else.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "StartPointWire"))]
pub struct StartPointWire {
    pub lat: f64,
    pub lng: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn theme_is_three_readable_colours_or_nothing() {
        let theme = |v: serde_json::Value| snapshot_theme(Some(&json!({ "theme": v })));
        assert_eq!(
            theme(json!({ "bg": "#101014", "ink": "#F2F2F5", "btn": "#fff" })),
            Some(ThemeWire {
                bg: "#101014".into(),
                ink: "#F2F2F5".into(),
                btn: "#fff".into(),
            })
        );
        // Anything the player would not paint with is no theme at all.
        assert_eq!(theme(json!({ "bg": "#101014", "ink": "#F2F2F5" })), None);
        assert_eq!(
            theme(json!({ "bg": "red", "ink": "#F2F2F5", "btn": "#fff" })),
            None
        );
        assert_eq!(theme(json!({ "bg": 1, "ink": 2, "btn": 3 })), None);
        assert_eq!(theme(json!(null)), None);
        assert_eq!(theme(json!("#fff")), None);
        // Pre-field snapshots simply have no colours.
        assert_eq!(snapshot_theme(Some(&json!({ "steps": [] }))), None);
        assert_eq!(snapshot_theme(None), None);
    }

    #[test]
    fn start_point_is_the_authors_quest_level_field() {
        let snap = json!({
            "start_point": { "lat": 44.8176, "lng": 20.4569 },
            "steps": [
                { "template": "task_no", "supporting": { "navigator": { "lat": 1.0, "lng": 2.0 } } }
            ]
        });
        assert_eq!(
            snapshot_start_point(Some(&snap)),
            Some(StartPointWire {
                lat: 44.8176,
                lng: 20.4569,
            })
        );
    }

    #[test]
    fn explicit_null_start_point_hides_the_button_despite_navigators() {
        let snap = json!({
            "start_point": null,
            "steps": [
                { "template": "task_no", "supporting": { "navigator": { "lat": 1.0, "lng": 2.0 } } }
            ]
        });
        assert_eq!(snapshot_start_point(Some(&snap)), None);
        // Same for a present-but-malformed value: honour the intent, guess nothing.
        let broken = json!({
            "start_point": { "lat": "45" },
            "steps": [
                { "template": "task_no", "supporting": { "navigator": { "lat": 1.0, "lng": 2.0 } } }
            ]
        });
        assert_eq!(snapshot_start_point(Some(&broken)), None);
    }

    #[test]
    fn legacy_snapshot_without_the_field_falls_back_to_the_first_navigator() {
        let snap = json!({ "steps": [
            { "template": "start", "supporting": { "is_start": true } },
            { "template": "task_no", "supporting": { "navigator": { "lat": 45.2551, "lng": 19.8451, "label": "Церковь" } } },
            { "template": "task_answer", "supporting": { "navigator": { "lat": 1.0, "lng": 2.0, "label": "Дальше" } } }
        ] });
        assert_eq!(
            snapshot_start_point(Some(&snap)),
            Some(StartPointWire {
                lat: 45.2551,
                lng: 19.8451,
            })
        );
    }

    #[test]
    fn start_point_absent_without_coordinates_and_tolerant_of_foreign_shapes() {
        let no_nav = json!({ "steps": [ { "template": "start" }, { "template": "congrats" } ] });
        assert_eq!(snapshot_start_point(Some(&no_nav)), None);
        assert_eq!(snapshot_start_point(None), None);
        assert_eq!(
            snapshot_start_point(Some(&json!({ "steps": "мусор" }))),
            None
        );
        // A malformed navigator (missing lat) is skipped, not a crash — and the
        // NEXT navigator wins.
        let mixed = json!({ "steps": [
            { "template": "task_no", "supporting": { "navigator": { "lng": 19.8 } } },
            { "template": "task_no", "supporting": { "navigator": { "lat": 1.5, "lng": 2.5, "label": "" } } }
        ] });
        assert_eq!(
            snapshot_start_point(Some(&mixed)),
            Some(StartPointWire { lat: 1.5, lng: 2.5 })
        );
    }

    /// Shared snapshot fixtures (platform/goldens/snapshot/) — the SAME files
    /// the frontend vitest suite reads. `media_refs` is asserted frontend-only
    /// (backend media retention walks the authoring body, not the snapshot),
    /// but the struct declares it so deny_unknown_fields keeps the format honest.
    #[test]
    fn snapshot_fixtures_read_identically() {
        use serde::Deserialize;

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Expected {
            #[allow(dead_code)]
            media_refs: Vec<String>,
            pages: u32,
            tasks: u32,
            paid_hints: bool,
            start_point: Option<StartPointWire>,
            theme: Option<ThemeWire>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fixture {
            name: String,
            #[allow(dead_code)]
            description: String,
            snapshot: serde_json::Value,
            expected: Expected,
        }

        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../goldens/snapshot");
        let mut count = 0;
        for entry in std::fs::read_dir(dir).expect("shared snapshot fixtures dir must exist") {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = std::fs::read_to_string(&path).expect("readable fixture");
            let fx: Fixture = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("fixture {} must deserialize: {e}", path.display()));

            let (pages, tasks, paid_hints) = snapshot_chips(Some(&fx.snapshot));
            assert_eq!(pages, Some(fx.expected.pages), "{}: pages", fx.name);
            assert_eq!(tasks, Some(fx.expected.tasks), "{}: tasks", fx.name);
            assert_eq!(
                paid_hints,
                Some(fx.expected.paid_hints),
                "{}: paid_hints",
                fx.name
            );
            assert_eq!(
                snapshot_start_point(Some(&fx.snapshot)),
                fx.expected.start_point,
                "{}: start_point",
                fx.name
            );
            assert_eq!(
                snapshot_theme(Some(&fx.snapshot)),
                fx.expected.theme,
                "{}: theme",
                fx.name
            );
            count += 1;
        }
        assert!(
            count >= 2,
            "expected the full shared fixture set, got {count}"
        );
    }
}
