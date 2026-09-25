//! Portable mode RPCs (`portable.*`).
//!
//! A portable copy's secrets live in the sealed store on the drive
//! (`credentials::sealed`), locked at every launch. The app forwards its own
//! `get_credentials`/`store_credentials` here when portable, so the frontend
//! reads and writes accounts exactly as it does against the keychain.

use crate::credentials::{self, SealedStore};
use crate::handlers::common::{blocking, done, str_arg};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use zeroize::Zeroizing;

/// A `portable.*` store call reached an installed copy.
pub(crate) const E_PORTABLE_OFF: &str = "E_PORTABLE_OFF";

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// Free space on the volume holding `path`; `None` where unknown (Windows).
#[cfg(unix)]
pub(crate) fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: plain out-parameter call; `st` is fully written on success.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    #[allow(clippy::unnecessary_cast)]
    (unsafe { libc::statvfs(c.as_ptr(), &mut st) } == 0).then(|| st.f_bavail as u64 * st.f_frsize as u64)
}

// ponytail: no free-space figure on Windows (would need windows-sys in the
// daemon); the wizard shows "unknown" and the copy fails loudly if it fills up.
#[cfg(not(unix))]
pub(crate) fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

/// The app's `get_credentials` reply shape. Locked is "unavailable", never
/// "empty": the app treats empty as "no accounts yet" and would save over them.
pub(crate) fn credentials_reply(store: &SealedStore) -> Value {
    match store.secrets() {
        Ok(s) if s.credentials.is_empty() => json!({"status": "empty", "credentials": {}}),
        Ok(s) => json!({"status": "granted", "credentials": s.credentials}),
        Err(e) => json!({"status": "unavailable", "message": e}),
    }
}

fn status_json(store: Option<&SealedStore>) -> Value {
    let (Some(root), Some(store)) = (mailvault_core::paths::portable_root(), store) else {
        return json!({"portable": false});
    };
    json!({
        "portable": true,
        "root": root.to_string_lossy(),
        "drive": root.parent().unwrap_or(root).to_string_lossy(),
        "locked": store.is_locked(),
        "hasStore": store.path().exists(),
        "freeBytes": free_bytes(root),
    })
}

/// One `portable-status` per change, so the unlock card and the badge follow.
fn announce(state: &Arc<DaemonState>) {
    state.events.emit("portable-status", status_json(credentials::sealed()));
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("portable.") {
        return None;
    }
    let store = credentials::sealed();
    if method == "portable.status" {
        return Some(done(id, blocking(move || status_json(store)).await));
    }
    let Some(store) = store else {
        return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, E_PORTABLE_OFF.to_string()));
    };
    Some(match method {
        "portable.unlock" => {
            let passphrase = Zeroizing::new(req!(str_arg(&id, params, "passphrase")));
            // argon2 runs here: off the async workers.
            let result = blocking(move || store.unlock(&passphrase)).await.and_then(|r| r);
            if result.is_ok() {
                announce(state);
                // Rows the lock held back are due now, not at the next look.
                state.scheduled_send.wake();
            }
            done(id, result.map(|_| json!({"ok": true})))
        }
        "portable.lock" => {
            store.lock();
            announce(state);
            RpcResponse::success(id, json!({"ok": true}))
        }
        "portable.change_passphrase" => {
            let old = Zeroizing::new(req!(str_arg(&id, params, "old")));
            let new = Zeroizing::new(req!(str_arg(&id, params, "new")));
            if new.chars().count() < MIN_PASSPHRASE {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, E_PASSPHRASE_SHORT.to_string()));
            }
            let result = blocking(move || store.change_passphrase(&old, &new)).await.and_then(|r| r);
            if result.is_ok() {
                announce(state);
            }
            done(id, result.map(|_| json!({"ok": true})))
        }
        "portable.get_credentials" => RpcResponse::success(id, credentials_reply(store)),
        "portable.set_credentials" => {
            let blob: HashMap<String, String> = match params.get("credentials").cloned().map(serde_json::from_value) {
                Some(Ok(b)) => b,
                _ => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing or invalid credentials".to_string())),
            };
            done(id, blocking(move || store.set_credentials(blob)).await.and_then(|r| r).map(|_| Value::Null))
        }
        _ => return None,
    })
}

/// Same floor as the `.mvtransfer` password: the store sits on a drive that
/// can be lost, so the passphrase is all that stands in front of it.
pub(crate) const MIN_PASSPHRASE: usize = 12;
pub(crate) const E_PASSPHRASE_SHORT: &str = "E_PORTABLE_PASSPHRASE_SHORT";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-portable-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    /// Registration guard: an unwired module answers "Unknown method".
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        for method in [
            "portable.status",
            "portable.unlock",
            "portable.lock",
            "portable.change_passphrase",
            "portable.get_credentials",
            "portable.set_credentials",
        ] {
            let resp = crate::server::handle_request_for_test(&s, method, json!({})).await;
            if let Some(err) = &resp.error {
                assert!(!err.message.contains("Unknown method"), "{method} is not routed: {err:?}");
            }
        }
    }

    /// The test binary is not beside a `MailVault Data` folder: an installed copy.
    #[tokio::test]
    async fn an_installed_copy_reports_not_portable_and_refuses_the_store_calls() {
        let s = st();
        let status = route(&s, "portable.status", &json!({}), json!(1)).await.unwrap();
        assert_eq!(status.result.unwrap()["portable"], json!(false));
        for method in ["portable.unlock", "portable.set_credentials", "portable.change_passphrase"] {
            let resp = route(&s, method, &json!({"passphrase": "x", "credentials": {}, "old": "x", "new": "y"}), json!(1)).await.unwrap();
            assert!(resp.error.unwrap().message.starts_with(E_PORTABLE_OFF), "{method}");
        }
    }

    /// A host whose mail sits in the app data dir, one account in the (test)
    /// keychain, and a stub app bundle to copy.
    struct Host {
        _tmp: tempfile::TempDir,
        state: Arc<DaemonState>,
        creds: std::path::PathBuf,
        payload: Vec<std::path::PathBuf>,
        dest: std::path::PathBuf,
        eml: std::path::PathBuf,
    }

    fn host() -> Host {
        let tmp = tempfile::tempdir().unwrap();
        let app_dir = tmp.path().join("host");
        let cur = app_dir.join("Maildir/acct/INBOX/cur");
        std::fs::create_dir_all(&cur).unwrap();
        let eml = cur.join("1.eml:2,S");
        std::fs::write(&eml, b"From: a@example.com\r\n\r\nhello").unwrap();
        let creds = tmp.path().join("credentials.json");
        std::fs::write(&creds, json!({"acct-1": "{\"email\":\"a@example.com\",\"password\":\"hunter2\"}"}).to_string()).unwrap();
        let app = tmp.path().join("MailVault.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/MailVault"), b"binary").unwrap();
        let dest = tmp.path().join("USB");
        std::fs::create_dir_all(&dest).unwrap();
        let state = DaemonState::for_test(app_dir.clone(), app_dir, true);
        Host { state, creds, payload: vec![app], dest, eml, _tmp: tmp }
    }

    fn request(h: &Host, remove_from_host: bool) -> CreateRequest {
        CreateRequest {
            dest: h.dest.clone(),
            passphrase: Zeroizing::new("drive passphrase".to_string()),
            copy_mail: true,
            copy_config: true,
            remove_from_host,
            params: mailvault_core::transfer::crypto::Params { m_kib: mailvault_core::transfer::crypto::MIN_M_KIB, t: 1, p: 1 },
        }
    }

    #[tokio::test]
    async fn create_seals_the_keychain_accounts_onto_the_drive_and_keeps_the_host() {
        let _guard = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let h = host();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &h.creds);

        let reply = run_create(&h.state, request(&h, false), h.payload.clone()).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        let reply = reply.expect("created");
        assert_eq!(reply["removedFromHost"], json!(false));
        let data = h.dest.join("MailVault Data/data");
        let sealed = mailvault_core::portable::read_sealed(&data.join("credentials.sealed"), "drive passphrase").unwrap();
        assert!(sealed.credentials.contains_key("acct-1"));
        assert!(data.join("Maildir/acct/INBOX/cur/1.eml:2,S").exists());
        assert!(h.eml.exists() && h.creds.exists(), "nothing removed unless asked");
        assert!(!h.state.vault_closed.load(std::sync::atomic::Ordering::SeqCst), "the vault is open again");
    }

    #[tokio::test]
    async fn removal_from_the_host_happens_only_after_a_verified_copy() {
        let _guard = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let h = host();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &h.creds);

        // A finished portable copy is already there: create refuses, so
        // nothing may leave the host.
        std::fs::create_dir_all(h.dest.join("MailVault Data")).unwrap();
        std::fs::write(h.dest.join("MailVault Data/portable.json"), br#"{"version":1}"#).unwrap();
        let refused = run_create(&h.state, request(&h, true), h.payload.clone()).await;
        assert!(refused.is_err());
        assert!(h.eml.exists() && h.creds.exists(), "a failed copy removes nothing");

        std::fs::remove_dir_all(h.dest.join("MailVault Data")).unwrap();
        let reply = run_create(&h.state, request(&h, true), h.payload.clone()).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(reply.expect("created")["removedFromHost"], json!(true));
        assert!(!h.eml.exists(), "host mail removed after the verified copy");
        assert!(!h.creds.exists(), "host credentials removed after the verified copy");
        assert!(h.dest.join("MailVault Data/data/Maildir/acct/INBOX/cur/1.eml:2,S").exists());
    }

    #[tokio::test]
    async fn create_refuses_a_short_passphrase_and_removal_without_a_full_copy() {
        let s = st();
        let short = route(&s, "portable.create", &json!({"dest": "/tmp", "passphrase": "short"}), json!(1)).await.unwrap();
        assert!(short.error.unwrap().message.starts_with(E_PASSPHRASE_SHORT));
        let partial = route(
            &s,
            "portable.create",
            &json!({"dest": "/tmp", "passphrase": "long enough passphrase", "copyMail": false, "copyConfig": true, "removeFromHost": true}),
            json!(1),
        )
        .await
        .unwrap();
        assert!(partial.error.is_some(), "removing from the host needs the mail and the accounts on the drive");
    }

    #[tokio::test]
    async fn get_credentials_while_locked_is_unavailable_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::credentials::SealedStore::new(
            dir.path().join("credentials.sealed"),
            mailvault_core::transfer::crypto::Params { m_kib: mailvault_core::transfer::crypto::MIN_M_KIB, t: 1, p: 1 },
        );
        // "empty" would let the app save a fresh blob over every account.
        assert_eq!(credentials_reply(&store)["status"], json!("unavailable"));
        store.unlock("drive passphrase").unwrap();
        assert_eq!(credentials_reply(&store)["status"], json!("empty"));
    }
}
