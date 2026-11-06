//! Where account secrets live. The engine never stores one in `mobile.db`, a log line or an event;
//! it asks the shell's platform store (Keychain on iOS, Keystore-backed storage on Android)
//! through this trait. Errors are plain strings and must never carry the secret.

use std::collections::HashMap;
use std::sync::Mutex;

pub trait SecretStore: Send + Sync {
    /// The secret for `account_id`, or `None` when none is stored.
    fn get(&self, account_id: &str) -> Result<Option<String>, String>;
    fn set(&self, account_id: &str, secret: &str) -> Result<(), String>;
    /// Removes the secret; removing a missing one succeeds.
    fn delete(&self, account_id: &str) -> Result<(), String>;
}

/// An in-memory store for tests and host builds. Forgets everything when dropped.
#[derive(Default)]
pub struct MemorySecrets(Mutex<HashMap<String, String>>);

impl MemorySecrets {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl SecretStore for MemorySecrets {
    fn get(&self, account_id: &str) -> Result<Option<String>, String> {
        Ok(self.map().get(account_id).cloned())
    }

    fn set(&self, account_id: &str, secret: &str) -> Result<(), String> {
        self.map().insert(account_id.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, account_id: &str) -> Result<(), String> {
        self.map().remove(account_id);
        Ok(())
    }
}

/// `mobile.debug.secretsRoundTrip`: set, read back, delete and read again one dummy entry in the
/// engine's store. Booleans only, so neither the value nor an error that might quote it is
/// returned.
#[cfg(feature = "perf-gate")]
pub(crate) fn round_trip(store: &dyn SecretStore) -> serde_json::Value {
    const ID: &str = "mv-debug-round-trip";
    let value = format!("probe-{}", std::process::id());
    let set = store.set(ID, &value).is_ok();
    let get = matches!(store.get(ID), Ok(Some(v)) if v == value);
    let delete = store.delete(ID).is_ok();
    let gone = matches!(store.get(ID), Ok(None));
    serde_json::json!({ "set": set, "get": get, "delete": delete, "gone": gone })
}
