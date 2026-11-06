//! The platform secret store behind the engine's `SecretStore`: the iOS data-protection keychain,
//! or Keystore-encrypted SharedPreferences on Android, both through keyring-core. Service
//! `com.mailvault.app`, user = account id. Error strings come from the store and never include
//! the secret.

use keyring_core::{CredentialStore, Entry, Error};
use mailvault_mobile_engine::SecretStore;
use std::sync::Arc;

const SERVICE: &str = "com.mailvault.app";

/// The store, or why it could not be created. The app runs either way; every call then fails
/// with the reason.
pub struct KeyringSecrets(Result<Arc<CredentialStore>, String>);

impl KeyringSecrets {
    pub fn new() -> Self {
        Self(platform_store())
    }

    /// Why the store could not be created, if it could not.
    pub fn error(&self) -> Option<&str> {
        self.0.as_ref().err().map(String::as_str)
    }

    fn entry(&self, account_id: &str) -> Result<Entry, String> {
        let store = self.0.as_ref().map_err(Clone::clone)?;
        store.build(SERVICE, account_id, None).map_err(|e| e.to_string())
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
        match self.entry(account_id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account_id: &str, secret: &str) -> Result<(), String> {
        self.entry(account_id)?.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self, account_id: &str) -> Result<(), String> {
        match self.entry(account_id)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
