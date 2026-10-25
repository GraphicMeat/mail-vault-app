//! The public settings facade for `<app_data_dir>/frontend-settings.json`.
//!
//! JsonDoc owns storage, versions, backup and recovery. This facade owns the
//! object shape, RFC 7396 patches, whole-store replacement and Wave 3 rebase
//! policy. Daemon readers stay strict; UI get may recover without a live write.
//! Nothing here logs values.

use crate::json_doc::{lock_file, write_durable, DocError, JsonDoc, Kind, Persistence, Spec};
pub use crate::json_doc::{Change, BACKUP_INTERVAL, BACKUP_KEEP, BACKUP_MIN_SPACING};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tracing::warn;

pub const FILE_NAME: &str = "frontend-settings.json";
pub const LOCK_NAME: &str = "frontend-settings.json.lock";
pub const VERSION_NAME: &str = "frontend-settings.version.json";
pub const CORRUPT_NAME: &str = "frontend-settings.json.corrupt";
const SPEC: Spec = Spec {
    file: FILE_NAME,
    kind: Kind::Object,
    pretty: false,
    persistence: Persistence::SettingsCompatible,
};
const SHELL_LOCK_WAIT: Duration = Duration::from_secs(2);

pub fn backup_name(n: usize) -> String {
    SPEC.backup_name(n)
}

/// What `settings.get` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub values: Map<String, Value>,
    pub version: u64,
    /// Set when the file on disk could not be parsed and the values came from
    /// elsewhere: `"memory"` (what this process last read or wrote), or the
    /// backup's file name. The next write replaces the broken file.
    pub recovered: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SettingsError {
    /// The caller passed a `baseVersion` that is no longer current.
    Conflict { current: u64 },
    /// The patch, the values or the resulting document is not a JSON object.
    NotAnObject,
    /// The file could not be written (the old one is intact).
    Io(String),
}

impl SettingsError {
    /// The i18n catalog key the app shows for this error.
    pub fn catalog_key(&self) -> &'static str {
        match self {
            SettingsError::Conflict { .. } => "errors.settingsConflict",
            SettingsError::NotAnObject => "errors.settingsInvalid",
            SettingsError::Io(_) => "errors.settingsWriteFailed",
        }
    }
}

/// RFC 7396 JSON merge patch: `null` deletes a key, an object merges into an
/// object, anything else (arrays included) replaces.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(entries) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let Value::Object(map) = target else {
        unreachable!()
    };
    for (key, value) in entries {
        if value.is_null() {
            map.remove(key);
        } else {
            merge_patch(map.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

/// The top-level keys whose value differs between two documents.
fn changed_keys(before: &Map<String, Value>, after: &Map<String, Value>) -> Vec<String> {
    let mut keys: Vec<String> = before
        .keys()
        .chain(after.keys())
        .filter(|k| before.get(*k) != after.get(*k))
        .cloned()
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

impl From<DocError> for SettingsError {
    fn from(error: DocError) -> Self {
        match error {
            DocError::Conflict { current } => Self::Conflict { current },
            DocError::Invalid => Self::NotAnObject,
            DocError::Io(reason) => Self::Io(reason),
        }
    }
}

/// The settings policy facade over one shared cache and writer.
pub struct SettingsDoc {
    doc: Arc<JsonDoc>,
}

impl SettingsDoc {
    /// Preserve the facade's Arc identity while sharing the production engine.
    pub fn shared(app_dir: &Path) -> Arc<SettingsDoc> {
        static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<SettingsDoc>>>> = OnceLock::new();
        let mut map = REGISTRY
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        Arc::clone(map.entry(app_dir.to_path_buf()).or_insert_with(|| {
            Arc::new(SettingsDoc {
                doc: JsonDoc::shared(app_dir, SPEC),
            })
        }))
    }

    /// A private instance (tests; `shared` is what production uses).
    pub fn open(app_dir: &Path) -> SettingsDoc {
        Self::open_with(app_dir, BACKUP_INTERVAL)
    }

    pub fn open_with(app_dir: &Path, backup_interval: Duration) -> SettingsDoc {
        SettingsDoc {
            doc: Arc::new(JsonDoc::open_with(app_dir, SPEC, backup_interval)),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.doc.path()
    }

    pub fn read(&self) -> Result<Arc<Value>, String> {
        self.doc.read()
    }

    /// The whole document, or the requested present keys. Never writes it.
    pub fn get(&self, keys: Option<&[String]>) -> Result<Snapshot, SettingsError> {
        let snapshot = self.doc.get()?;
        let Value::Object(mut values) = snapshot.value else {
            return Err(SettingsError::NotAnObject);
        };
        if let Some(keys) = keys {
            values.retain(|key, _| keys.contains(key));
        }
        Ok(Snapshot {
            values,
            version: snapshot.version,
            recovered: snapshot.recovered,
        })
    }

    /// Applies a merge patch (see [`merge_patch`]) to the document.
    pub fn patch(&self, patch: &Value, base_version: Option<u64>) -> Result<Change, SettingsError> {
        if !patch.is_object() {
            return Err(SettingsError::NotAnObject);
        }
        self.write_op(base_version, |doc| merge_patch(doc, patch))
    }

    /// Replaces the listed top-level keys wholesale; `null` deletes one. What
    /// the app's persisted stores need: each key holds a whole serialized
    /// store, and a merge patch cannot drop a nested key the store removed.
    pub fn replace(
        &self,
        values: &Value,
        base_version: Option<u64>,
    ) -> Result<Change, SettingsError> {
        let Value::Object(entries) = values else {
            return Err(SettingsError::NotAnObject);
        };
        self.write_op(base_version, |doc| {
            if let Value::Object(map) = doc {
                for (key, value) in entries {
                    if value.is_null() {
                        map.remove(key);
                    } else {
                        map.insert(key.clone(), value.clone());
                    }
                }
            }
        })
    }

    /// Apply a whole-store UI write using its last accepted baseline. Only
    /// mailvault-settings is shared at nested field granularity with native
    /// writers. Other stores retain replace semantics. Null removes a store;
    /// nested null is a value, unlike JSON merge patch's deletion operator.
    pub fn replace_rebased(
        &self,
        values: &Value,
        bases: &Value,
        base_version: Option<u64>,
    ) -> Result<Change, SettingsError> {
        let entries = values.as_object().ok_or(SettingsError::NotAnObject)?;
        let bases = bases.as_object().ok_or(SettingsError::NotAnObject)?;
        self.write_op(base_version, |doc| {
            let map = doc.as_object_mut().expect("settings document object");
            for (key, value) in entries {
                if value.is_null() {
                    map.remove(key);
                } else if key == "mailvault-settings" && bases.contains_key(key) {
                    apply_store_delta(
                        map.entry(key.clone()).or_insert(Value::Null),
                        &bases[key],
                        value,
                    );
                } else {
                    map.insert(key.clone(), value.clone());
                }
            }
        })
    }

    fn write_op(
        &self,
        base_version: Option<u64>,
        apply: impl FnOnce(&mut Value),
    ) -> Result<Change, SettingsError> {
        self.doc
            .write_op(base_version, |doc| {
                let before = doc.as_object().ok_or(DocError::Invalid)?.clone();
                apply(doc);
                let after = doc.as_object().ok_or(DocError::Invalid)?;
                Ok(changed_keys(&before, after))
            })
            .map_err(Into::into)
    }
}

fn apply_store_delta(current: &mut Value, before: &Value, after: &Value) {
    if before == after {
        return;
    }
    if let Some(next) = after
        .as_object()
        .filter(|_| before.is_object() || before.is_null())
    {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let current = current.as_object_mut().unwrap();
        if let Some(previous) = before.as_object() {
            for key in previous.keys().filter(|key| !next.contains_key(*key)) {
                current.remove(key);
            }
        }
        for (key, value) in next {
            let prior = before.get(key).unwrap_or(&Value::Null);
            // A present null added to an absent field is an explicit value.
            if before.get(key).is_none() && value.is_null() {
                current.insert(key.clone(), Value::Null);
            } else if before.get(key) != Some(value) {
                apply_store_delta(
                    current.entry(key.clone()).or_insert(Value::Null),
                    prior,
                    value,
                );
            }
        }
    } else {
        *current = after.clone();
    }
}

/// The shell's fallback write (`write_settings_json`, for a daemon without
/// `settings.*`): the whole document, refused unless it is a JSON object,
/// written atomically under the same lock the daemon takes. The error is a
/// catalog key; the reason goes to the log.
pub fn write_document(app_dir: &Path, data: &str) -> Result<(), String> {
    write_document_waiting(app_dir, data, SHELL_LOCK_WAIT)
}

fn write_document_waiting(app_dir: &Path, data: &str, wait: Duration) -> Result<(), String> {
    match serde_json::from_str::<Value>(data) {
        Ok(v) if v.is_object() => {}
        _ => {
            warn!(
                "settings: refused a fallback write that is not a JSON object ({} bytes)",
                data.len()
            );
            return Err(SettingsError::NotAnObject.catalog_key().to_string());
        }
    }
    let result = lock_file(app_dir, LOCK_NAME, wait, SPEC.persistence).and_then(|_lock| {
        write_durable(&app_dir.join(FILE_NAME), data.as_bytes(), SPEC.persistence)
    });
    result.map_err(|e| {
        warn!("settings: fallback write failed, the file is unchanged: {e}");
        SettingsError::Io(e.to_string()).catalog_key().to_string()
    })
}

#[cfg(test)]
mod tests;
