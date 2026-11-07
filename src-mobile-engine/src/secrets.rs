//! Where account secrets live. The engine never stores one in `mobile.db`, a log line or an event;
//! it asks the shell's platform store (Keychain on iOS, Keystore-backed storage on Android)
//! through this trait. Errors are plain strings and must never carry the secret.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

/// What one account's secret string holds: a password (IMAP password, JMAP app password or bearer
/// token), or OAuth tokens. Stored as `{"v":1,"password":..}` or
/// `{"v":1,"refresh":..,"access":..,"expiresMs":..}`; a Plan 2 install stored the bare password,
/// which [`Credential::parse`] still reads. `Debug` prints which fields are set, never a value.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    /// When `access` expires, in Unix ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_ms: Option<i64>,
}

/// The stored form: the version beside the fields.
#[derive(Serialize, Deserialize)]
struct Envelope {
    v: u32,
    #[serde(flatten)]
    cred: Credential,
}

const ENVELOPE_VERSION: u32 = 1;

impl Credential {
    pub fn from_password(password: &str) -> Credential {
        Credential { password: Some(password.to_string()), ..Credential::default() }
    }

    pub fn from_tokens(refresh: &str, access: &str, expires_ms: i64) -> Credential {
        Credential { refresh: Some(refresh.into()), access: Some(access.into()), expires_ms: Some(expires_ms), password: None }
    }

    /// Reads a stored secret. Anything that is not a version 1 envelope holding at least one secret
    /// is a bare password: what Plan 2 stored, and a password may look like anything.
    pub fn parse(s: &str) -> Credential {
        match serde_json::from_str::<Envelope>(s) {
            Ok(Envelope { v: ENVELOPE_VERSION, cred }) if cred.password.is_some() || cred.refresh.is_some() || cred.access.is_some() => {
                cred
            }
            _ => Credential::from_password(s),
        }
    }

    /// The string the secret store keeps.
    pub fn to_secret(&self) -> String {
        serde_json::to_string(&Envelope { v: ENVELOPE_VERSION, cred: self.clone() }).expect("credential serializes")
    }

    /// Every non-empty secret it holds, to scrub out of an error before the error is logged.
    pub(crate) fn secrets(&self) -> Vec<&str> {
        [&self.password, &self.refresh, &self.access].into_iter().flatten().map(String::as_str).filter(|s| !s.is_empty()).collect()
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let set = |o: &Option<String>| if o.is_some() { "<set>" } else { "<none>" };
        f.debug_struct("Credential")
            .field("password", &set(&self.password))
            .field("refresh", &set(&self.refresh))
            .field("access", &set(&self.access))
            .field("expires_ms", &self.expires_ms)
            .finish()
    }
}

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
