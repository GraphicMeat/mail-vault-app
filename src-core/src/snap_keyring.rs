//! The keyring a snap build uses: the Secret portal instead of the Secret
//! Service.
//!
//! A strict snap reaches `org.freedesktop.secrets` only through the
//! `password-manager-service` plug, which snapd never connects on its own and
//! the Snap Store will not auto-connect for us (it exposes every secret in the
//! user's keyring). The store's answer is the Secret portal: oo7 detects the
//! snap, asks the portal for a per-app key and keeps our secrets in an
//! encrypted file under the snap's own data directory.
//!
//! `install_if_snap` swaps keyring-rs's default backend for this one, so every
//! `keyring::Entry` in the app and the daemon keeps working unchanged. Outside
//! a snap nothing changes.
//!
//! Users who connected the plug by hand before this build have their secrets
//! in the host keyring, stored by keyring-rs's Secret Service backend. A read
//! that finds nothing here copies that entry across once, and a delete removes
//! both, so a deleted account cannot come back from the old copy.

use std::any::Any;
use std::collections::HashMap;
use std::sync::OnceLock;

use keyring::credential::{Credential, CredentialApi, CredentialBuilder, CredentialBuilderApi};
use keyring::secret_service::SsCredential;
use keyring::{Error, Result};

/// Switch keyring-rs to the portal backend when running inside a snap.
/// Call once at startup, before the first `keyring::Entry` is created.
pub fn install_if_snap() {
    if std::env::var_os("SNAP").is_some() {
        keyring::set_default_credential_builder(Box::new(PortalBuilder));
        tracing::info!("keyring: snap detected, using the Secret portal");
    }
}

struct PortalBuilder;

impl CredentialBuilderApi for PortalBuilder {
    fn build(&self, target: Option<&str>, service: &str, user: &str) -> Result<Box<Credential>> {
        Ok(Box::new(PortalCredential {
            attributes: attributes(target, service, user),
            label: format!("MailVault: {service} {user}"),
            legacy: SsCredential::new_with_target(target, service, user)?,
        }))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// The attributes keyring-rs's Secret Service backend writes, so a secret
/// looks the same whichever of the two stores holds it.
fn attributes(target: Option<&str>, service: &str, user: &str) -> HashMap<String, String> {
    HashMap::from([
        ("target".into(), target.unwrap_or("default").into()),
        ("service".into(), service.into()),
        ("username".into(), user.into()),
        ("application".into(), "rust-keyring".into()),
    ])
}

struct PortalCredential {
    attributes: HashMap<String, String>,
    label: String,
    legacy: SsCredential,
}

impl CredentialApi for PortalCredential {
    fn set_secret(&self, secret: &[u8]) -> Result<()> {
        let owned = secret.to_vec();
        match run(|k| async move { k.create_item(&self.label, &self.attributes, owned, true).await }) {
            Err(Failure::Open(e)) => self.fall_back(e).set_secret(secret),
            other => other.map_err(Failure::into_keyring),
        }
    }

    fn get_secret(&self) -> Result<Vec<u8>> {
        match self.read() {
            Ok(Some(secret)) => return Ok(secret),
            Ok(None) => {}
            Err(Failure::Open(e)) => return self.fall_back(e).get_secret(),
            Err(e) => return Err(e.into_keyring()),
        }
        // Nothing here yet: a secret stored before the portal switch, or none.
        let secret = match self.legacy.get_secret() {
            Ok(secret) => secret,
            // Any failure (no entry, or AppArmor refusing an unconnected plug)
            // means there is nothing to migrate.
            Err(_) => return Err(Error::NoEntry),
        };
        self.set_secret(&secret)?;
        tracing::info!("keyring: moved {} from the host keyring to the Secret portal", self.label);
        Ok(secret)
    }

    fn delete_credential(&self) -> Result<()> {
        match self.read() {
            Ok(Some(_)) => {}
            // Only the old copy can be left; an unconnected plug means none.
            Ok(None) => return self.legacy.delete_credential().or(Err(Error::NoEntry)),
            Err(Failure::Open(e)) => return self.fall_back(e).delete_credential(),
            Err(e) => return Err(e.into_keyring()),
        }
        let _ = self.legacy.delete_credential();
        run(|k| async move { k.delete(&self.attributes).await }).map_err(Failure::into_keyring)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

impl PortalCredential {
    fn read(&self) -> std::result::Result<Option<Vec<u8>>, Failure> {
        run(|k| async move {
            match k.search_items(&self.attributes).await?.first() {
                Some(item) => Ok(Some(item.secret().await?.as_bytes().to_vec())),
                None => Ok(None),
            }
        })
    }

    /// No usable Secret portal (a desktop without a backend for it): oo7 does
    /// not fall back on its own, so use the Secret Service as before. With the
    /// plug unconnected that is the AppArmor refusal `snap_keyring_hint` turns
    /// into the `snap connect` advice.
    fn fall_back(&self, e: oo7::Error) -> &SsCredential {
        tracing::warn!("keyring: Secret portal unavailable ({e}), using the Secret Service");
        &self.legacy
    }
}

enum Failure {
    /// The keyring could not be opened at all.
    Open(oo7::Error),
    /// It opened, and the operation on it failed.
    Op(oo7::Error),
    Panicked,
}

impl Failure {
    fn into_keyring(self) -> Error {
        match self {
            Failure::Open(e) | Failure::Op(e) => Error::PlatformFailure(e.to_string().into()),
            Failure::Panicked => Error::PlatformFailure("keyring thread panicked".into()),
        }
    }
}

/// Opens the keyring and runs one operation on it, waiting for the result.
///
/// Opened fresh every time: the file backend reads the file once when opened,
/// and the app and the daemon each write it, so a keyring kept open would miss
/// the other's changes and could write over them. Keyring calls are rare; the
/// cost is one portal call and one small file read each.
///
/// keyring-rs is synchronous and its callers sit on tokio worker, blocking-pool
/// and plain threads alike; `block_on` from inside a runtime panics, so the
/// wait happens on a fresh thread that has no runtime of its own.
fn run<F, Fut, T>(op: F) -> std::result::Result<T, Failure>
where
    F: FnOnce(oo7::Keyring) -> Fut + Send,
    Fut: std::future::Future<Output = oo7::Result<T>>,
    T: Send,
{
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("keyring runtime")
    });
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                runtime.block_on(async {
                    let keyring = oo7::Keyring::new().await.map_err(Failure::Open)?;
                    op(keyring).await.map_err(Failure::Op)
                })
            })
            .join()
            .unwrap_or(Err(Failure::Panicked))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_match_the_secret_service_backend() {
        let ours = attributes(None, "com.mailvault.app", "credentials");
        let legacy = SsCredential::new_with_target(None, "com.mailvault.app", "credentials").unwrap();
        assert_eq!(ours, legacy.attributes);
    }

    /// A real round trip. Needs a session bus with an unlocked Secret Service
    /// (or, inside a snap, the Secret portal), so it only runs when asked:
    /// `cargo test -p mailvault-core snap_keyring -- --ignored`.
    #[test]
    #[ignore]
    fn stores_reads_and_deletes_through_oo7() {
        let entry = keyring::Entry::new_with_credential(
            PortalBuilder.build(None, "com.mailvault.selftest", "roundtrip").unwrap(),
        );
        let _ = entry.delete_credential();
        entry.set_password("s3cret").unwrap();
        assert_eq!(entry.get_password().unwrap(), "s3cret");
        entry.set_password("changed").unwrap();
        assert_eq!(entry.get_password().unwrap(), "changed");
        entry.delete_credential().unwrap();
        assert!(matches!(entry.get_password(), Err(Error::NoEntry)));
    }
}
