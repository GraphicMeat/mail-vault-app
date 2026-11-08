//! The platform secret store behind the engine's `SecretStore`: the iOS data-protection keychain,
//! or Keystore-encrypted SharedPreferences on Android, both through keyring-core. Service
//! `com.mailvault.app`, user = account id. Error strings come from the store and never include
//! the secret.
//!
//! On Android every call holds `android::enter` while it uses ndk-context (see `android.rs`).
//!
//! On iOS every entry is `AfterFirstUnlockThisDeviceOnly`: background fetch mostly runs on a
//! locked phone, and the store's default (`WhenUnlocked`) would refuse the read there.

use keyring_core::{CredentialStore, Entry, Error};
use mailvault_mobile_engine::SecretStore;
use std::collections::HashMap;
use std::sync::Arc;

const SERVICE: &str = "com.mailvault.app";

/// The modifiers every entry is built with.
#[cfg(target_os = "ios")]
const MODIFIERS: &[(&str, &str)] = &[("access-policy", "AfterFirstUnlockThisDeviceOnly")];
#[cfg(not(target_os = "ios"))]
const MODIFIERS: &[(&str, &str)] = &[];

/// The store, or why it could not be created. The app runs either way; every call then fails
/// with the reason.
pub struct KeyringSecrets(Result<Arc<CredentialStore>, String>);

impl KeyringSecrets {
    pub fn new() -> Self {
        #[cfg(target_os = "android")]
        let _ctx = crate::android::enter();
        Self(platform_store())
    }

    /// Why the store could not be created, if it could not.
    pub fn error(&self) -> Option<&str> {
        self.0.as_ref().err().map(String::as_str)
    }

    fn entry(&self, account_id: &str) -> Result<Entry, String> {
        let store = self.0.as_ref().map_err(Clone::clone)?;
        let modifiers: HashMap<&str, &str> = MODIFIERS.iter().copied().collect();
        store.build(SERVICE, account_id, (!modifiers.is_empty()).then_some(&modifiers)).map_err(|e| e.to_string())
    }

    /// Re-saves each account's secret so it carries [`MODIFIERS`]: an item written before keeps
    /// its old accessibility on update, so only a new item takes the policy (read, delete, set).
    /// Run once, before anything else can read a secret. `Err` names the first account that
    /// failed and the store's reason; the others are still moved. The accounts whose secret was
    /// deleted and could not be written back are in `lost`: they must sign in again.
    pub fn migrate_access_policy(&self, account_ids: &[String], lost: &mut Vec<String>) -> Result<(), String> {
        if MODIFIERS.is_empty() {
            return Ok(());
        }
        let mut first = None;
        for id in account_ids {
            if let Err(e) = resave(self, id, lost) {
                first.get_or_insert(format!("{id}: {e}"));
            }
        }
        first.map_or(Ok(()), Err)
    }
}

/// Re-saves one account's secret through `store`; an account whose secret was deleted and then
/// refused twice goes in `lost`.
pub(crate) fn resave(store: &dyn SecretStore, account_id: &str, lost: &mut Vec<String>) -> Result<(), String> {
    let Some(secret) = store.get(account_id)? else {
        return Ok(());
    };
    store.delete(account_id)?;
    // Between the delete and the set the secret lives only here: try the set twice.
    store.set(account_id, &secret).or_else(|_| store.set(account_id, &secret)).inspect_err(|_| lost.push(account_id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A store whose writes all fail after the first `ok_sets`.
    struct Failing {
        inner: mailvault_mobile_engine::MemorySecrets,
        ok_sets: AtomicUsize,
    }

    impl SecretStore for Failing {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            self.inner.get(id)
        }
        fn set(&self, id: &str, secret: &str) -> Result<(), String> {
            if self.ok_sets.load(Ordering::SeqCst) == 0 {
                return Err("keychain busy".into());
            }
            self.ok_sets.fetch_sub(1, Ordering::SeqCst);
            self.inner.set(id, secret)
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.inner.delete(id)
        }
    }

    #[test]
    fn a_secret_lost_between_delete_and_set_is_reported() {
        let store = Failing { inner: Default::default(), ok_sets: AtomicUsize::new(1) };
        store.set("acc_a", "pw").unwrap();
        let mut lost = Vec::new();
        assert!(resave(&store, "acc_a", &mut lost).is_err());
        assert_eq!(lost, vec!["acc_a".to_string()]);
        assert_eq!(store.get("acc_a").unwrap(), None);
        // A secret that goes back on the second try is not lost.
        let store = Failing { inner: Default::default(), ok_sets: AtomicUsize::new(2) };
        store.set("acc_b", "pw").unwrap();
        let mut lost = Vec::new();
        assert!(resave(&store, "acc_b", &mut lost).is_ok());
        assert!(lost.is_empty());
    }
}

#[cfg(target_os = "ios")]
fn platform_store() -> Result<Arc<CredentialStore>, String> {
    let store: Arc<CredentialStore> = apple_native_keyring_store::protected::Store::new().map_err(|e| e.to_string())?;
    Ok(store)
}

/// Needs the Android context in ndk-context, which tao sets when the activity starts.
#[cfg(target_os = "android")]
fn platform_store() -> Result<Arc<CredentialStore>, String> {
    let store: Arc<CredentialStore> = android_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
    Ok(store)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn platform_store() -> Result<Arc<CredentialStore>, String> {
    Err("no platform secret store on this target".into())
}

impl SecretStore for KeyringSecrets {
    fn get(&self, account_id: &str) -> Result<Option<String>, String> {
        #[cfg(target_os = "android")]
        let _ctx = crate::android::enter();
        match self.entry(account_id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account_id: &str, secret: &str) -> Result<(), String> {
        #[cfg(target_os = "android")]
        let _ctx = crate::android::enter();
        self.entry(account_id)?.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self, account_id: &str) -> Result<(), String> {
        #[cfg(target_os = "android")]
        let _ctx = crate::android::enter();
        match self.entry(account_id)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
