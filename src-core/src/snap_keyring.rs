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
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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
            Err(f) if f.portal_unusable() => self.fall_back(&f).set_secret(secret),
            other => other.map_err(Failure::into_keyring),
        }
    }

    fn get_secret(&self) -> Result<Vec<u8>> {
        match self.read() {
            Ok(Some(secret)) => return Ok(secret),
            Ok(None) => {}
            Err(f) if f.portal_unusable() => return self.fall_back(&f).get_secret(),
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
            Err(f) if f.portal_unusable() => return self.fall_back(&f).delete_credential(),
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

    /// No usable Secret portal (a desktop without a backend for it, or one that
    /// will not hand over a key): oo7 does not fall back on its own, so use the
    /// Secret Service as before. With the plug unconnected that is the AppArmor
    /// refusal `snap_keyring_hint` turns into the `snap connect` advice; with it
    /// connected it works on any default keyring, whatever its name.
    fn fall_back(&self, why: &Failure) -> &SsCredential {
        tracing::warn!("keyring: Secret portal unavailable ({}), using the Secret Service", why.describe());
        &self.legacy
    }
}

enum Failure {
    /// The keyring could not be opened at all.
    Open(oo7::Error),
    /// The portal never answered, or did not for the last few minutes.
    Hung,
    /// It opened, and the operation on it failed.
    Op(oo7::Error),
    Panicked,
}

impl Failure {
    /// The portal gave no key, so the Secret Service is the only way left.
    fn portal_unusable(&self) -> bool {
        matches!(self, Failure::Open(_) | Failure::Hung)
    }

    fn describe(&self) -> String {
        match self {
            Failure::Open(e) | Failure::Op(e) => e.to_string(),
            Failure::Hung => "it did not answer".into(),
            Failure::Panicked => "keyring thread panicked".into(),
        }
    }

    fn into_keyring(self) -> Error {
        Error::PlatformFailure(self.describe().into())
    }
}

/// How long the portal gets to hand over the key. It answers in well under a
/// second. Kept inside the app's own five-second first attempt at reading the
/// keyring, so the error that follows (with its `snap connect` advice) reaches
/// the user instead of a bare timeout.
const PORTAL_TIMEOUT: Duration = Duration::from_secs(4);
/// After a hang the portal is left alone this long, so one broken desktop costs
/// one wait rather than one per keyring call, and a desktop whose keyring gets
/// unlocked a little late is used again soon.
const PORTAL_COOLDOWN: Duration = Duration::from_secs(30);
/// A hung call never frees its runtime thread, so a portal that hangs this many
/// times is left alone until the process restarts, not retried for ever.
const PORTAL_MAX_HANGS: u32 = 10;

/// Remembers how often, and when last, the portal hung.
struct PortalGate {
    hangs: Mutex<(u32, Option<Instant>)>,
}

impl PortalGate {
    const fn new() -> Self {
        Self { hangs: Mutex::new((0, None)) }
    }

    fn cooling_down(&self, cooldown: Duration) -> bool {
        let (count, last) = *self.hangs.lock().unwrap_or_else(|e| e.into_inner());
        count >= PORTAL_MAX_HANGS || last.is_some_and(|at| at.elapsed() < cooldown)
    }

    fn mark_hung(&self) {
        let mut hangs = self.hangs.lock().unwrap_or_else(|e| e.into_inner());
        *hangs = (hangs.0 + 1, Some(Instant::now()));
    }
}

static GATE: PortalGate = PortalGate::new();

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
    run_with(&GATE, PORTAL_TIMEOUT, PORTAL_COOLDOWN, oo7::Keyring::new, op)
}

/// `run` with the portal's deadline and its opening spelled out.
///
/// Only the opening is bounded. oo7 asks the portal for the file's key through
/// ashpd, which ignores the portal's error reply and reads the key's socket
/// until it closes. gnome-keyring, asked for a `login` keyring the desktop does
/// not have (automatic login leaves only a "Default keyring"), replies with an
/// error and keeps the socket open, so the call never returns. The stuck read
/// stays on a runtime thread until the process ends; the gate keeps that to a
/// few.
fn run_with<O, OFut, F, Fut, T>(
    gate: &PortalGate,
    timeout: Duration,
    cooldown: Duration,
    open: O,
    op: F,
) -> std::result::Result<T, Failure>
where
    O: FnOnce() -> OFut + Send,
    OFut: std::future::Future<Output = oo7::Result<oo7::Keyring>>,
    F: FnOnce(oo7::Keyring) -> Fut + Send,
    Fut: std::future::Future<Output = oo7::Result<T>>,
    T: Send,
{
    if gate.cooling_down(cooldown) {
        return Err(Failure::Hung);
    }
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
                    let keyring = match tokio::time::timeout(timeout, open()).await {
                        Ok(opened) => opened.map_err(Failure::Open)?,
                        Err(_) => {
                            gate.mark_hung();
                            return Err(Failure::Hung);
                        }
                    };
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

    fn never_opens() -> std::future::Pending<oo7::Result<oo7::Keyring>> {
        std::future::pending()
    }

    async fn nothing_to_do(_: oo7::Keyring) -> oo7::Result<()> {
        Ok(())
    }

    /// gnome-keyring answers the portal with an error when the desktop has no
    /// `login` keyring (automatic login), and ashpd then waits on the key's
    /// socket for ever. Without a bound the caller hangs with it.
    #[test]
    fn a_portal_that_never_answers_is_given_up_on_and_then_skipped() {
        let gate = PortalGate::new();
        let started = Instant::now();
        let first = run_with(&gate, Duration::from_millis(200), Duration::from_secs(60), never_opens, nothing_to_do);
        assert!(matches!(first, Err(Failure::Hung)));
        assert!(started.elapsed() >= Duration::from_millis(200), "gave up before the deadline");
        assert!(started.elapsed() < Duration::from_secs(5), "waited far past the deadline");

        let again = Instant::now();
        let second = run_with(&gate, Duration::from_millis(200), Duration::from_secs(60), never_opens, nothing_to_do);
        assert!(matches!(second, Err(Failure::Hung)));
        assert!(again.elapsed() < Duration::from_millis(100), "the cooldown did not skip the portal");
    }

    #[test]
    fn the_portal_is_tried_again_once_the_cooldown_is_over() {
        let gate = PortalGate::new();
        let _ = run_with(&gate, Duration::from_millis(100), Duration::ZERO, never_opens, nothing_to_do);
        let retried = Instant::now();
        let second = run_with(&gate, Duration::from_millis(100), Duration::ZERO, never_opens, nothing_to_do);
        assert!(matches!(second, Err(Failure::Hung)));
        assert!(retried.elapsed() >= Duration::from_millis(100), "a spent cooldown still skipped the portal");
    }

    #[test]
    fn a_portal_that_keeps_hanging_is_left_alone_for_good() {
        let gate = PortalGate::new();
        for _ in 0..PORTAL_MAX_HANGS {
            let _ = run_with(&gate, Duration::from_millis(50), Duration::ZERO, never_opens, nothing_to_do);
        }
        let started = Instant::now();
        let after = run_with(&gate, Duration::from_millis(50), Duration::ZERO, never_opens, nothing_to_do);
        assert!(matches!(after, Err(Failure::Hung)));
        assert!(started.elapsed() < Duration::from_millis(40), "a spent portal was tried again");
    }

    #[test]
    fn a_hung_portal_falls_back_like_a_missing_one() {
        assert!(Failure::Hung.portal_unusable());
        assert!(!Failure::Panicked.portal_unusable());
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
