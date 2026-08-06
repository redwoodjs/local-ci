use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const EVENT_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedEvent {
    pub event: String,
    #[serde(flatten)]
    pub fields: BTreeMap<String, Value>,
}

/// Normalize NDJSON event payloads for stable contracts by dropping volatile fields.
pub fn normalize_event_value(mut value: Value) -> Option<NormalizedEvent> {
    let object = value.as_object_mut()?;
    let event = object.get("event")?.as_str()?.to_owned();
    for key in ["ts", "runId", "durationMs", "logPath", "debugLogPath"] {
        object.remove(key);
    }
    let fields = object
        .iter()
        .filter(|(key, _)| key.as_str() != "event")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Some(NormalizedEvent { event, fields })
}

pub fn normalize_event_lines(input: &str) -> Vec<NormalizedEvent> {
    input
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(normalize_event_value)
        .collect()
}

pub fn normalized_events_to_value(events: &[NormalizedEvent]) -> Value {
    Value::Array(
        events
            .iter()
            .map(|event| {
                let mut object = serde_json::Map::new();
                object.insert("event".to_owned(), Value::String(event.event.clone()));
                for (key, value) in &event.fields {
                    object.insert(key.clone(), value.clone());
                }
                Value::Object(object)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn normalizes_volatile_event_fields() {
        let events = normalize_event_lines(
            r#"{"event":"run.start","ts":"now","runId":"run-1","schemaVersion":1}
{"event":"job.finish","ts":"later","job":"test","durationMs":42,"status":"passed"}"#,
        );

        assert_eq!(
            normalized_events_to_value(&events),
            json!([
                {"event":"run.start","schemaVersion":1},
                {"event":"job.finish","job":"test","status":"passed"}
            ])
        );
    }

    #[test]
    fn event_fixture_contracts_match_snapshots() {
        let fixtures =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../local-ci/fixtures/events");
        let mut entries = fs::read_dir(&fixtures)
            .expect("event fixtures directory should exist")
            .collect::<Result<Vec<_>, _>>()
            .expect("event fixtures should be readable")
            .into_iter()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.path());
        assert!(!entries.is_empty(), "expected event fixtures");

        for entry in entries {
            let fixture: serde_json::Value = serde_json::from_slice(
                &fs::read(entry.path()).expect("event fixture should be readable"),
            )
            .expect("event fixture should be valid JSON");
            let input = fixture
                .get("input")
                .and_then(serde_json::Value::as_array)
                .expect("event fixture should include input events");
            let actual = input
                .iter()
                .filter_map(|event| normalize_event_value(event.clone()))
                .collect::<Vec<_>>();
            assert_eq!(
                normalized_events_to_value(&actual),
                fixture["normalized"],
                "event fixture mismatch: {}",
                entry.path().display()
            );
        }
    }
}
