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
use std::sync::atomic::{AtomicBool, Ordering};
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
        "disconnected": DISCONNECTED.load(Ordering::SeqCst),
    })
}

/// Set once the drive this copy runs from went away; never cleared, since the
/// open databases on it are gone too: the banner asks for a restart.
static DISCONNECTED: AtomicBool = AtomicBool::new(false);

/// One look at the drive. On the first miss the vault closes (the same flag
/// `vault_close` sets, so every mail write is refused rather than landing on
/// the host or half on a drive that comes back) and the app hears it once.
pub(crate) async fn check_drive(state: &Arc<DaemonState>, root: &Path, gone: &AtomicBool) -> bool {
    let root = root.to_path_buf();
    // A stat on a yanked drive can stall: off the async workers.
    if blocking(move || mailvault_core::paths::is_portable_root(&root)).await.unwrap_or(false) {
        return false;
    }
    if gone.swap(true, Ordering::SeqCst) {
        return false;
    }
    tracing::warn!("[portable] the drive this copy runs from is gone; mail writes stop until a restart");
    state.vault_closed.store(true, Ordering::SeqCst);
    announce(state);
    true
}

/// Every few seconds while running from a drive.
pub(crate) fn watch_drive(state: Arc<DaemonState>) {
    let Some(root) = mailvault_core::paths::portable_root() else { return };
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            check_drive(&state, root, &DISCONNECTED).await;
        }
    });
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
    if method == "portable.estimate" {
        let dest = std::path::PathBuf::from(req!(str_arg(&id, params, "dest")));
        let state = Arc::clone(state);
        return Some(done(
            id,
            blocking(move || {
                let payload = this_app_payload();
                let mail = state.mail_dir_ok.then_some(state.data_dir.as_path());
                json!({
                    "freeBytes": free_bytes(&dest),
                    "neededBytes": mailvault_core::portable::estimate(payload.as_deref().unwrap_or_default(), &state.app_dir, mail),
                    "supported": payload.is_ok(),
                })
            })
            .await,
        ));
    }
    if method == "portable.create" {
        if store.is_some() {
            return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, E_FROM_PORTABLE.to_string()));
        }
        let passphrase = Zeroizing::new(req!(str_arg(&id, params, "passphrase")));
        if passphrase.chars().count() < MIN_PASSPHRASE {
            return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, E_PASSPHRASE_SHORT.to_string()));
        }
        let flag = |k: &str| params.get(k).and_then(Value::as_bool).unwrap_or(false);
        let (copy_mail, copy_config, remove_from_host) = (flag("copyMail"), flag("copyConfig"), flag("removeFromHost"));
        // Removing from the host is only ever offered for a full copy: what
        // is not on the drive would be gone everywhere.
        if remove_from_host && !(copy_mail && copy_config) {
            return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "removeFromHost needs copyMail and copyConfig".to_string()));
        }
        let dest = std::path::PathBuf::from(req!(str_arg(&id, params, "dest")));
        let payload = match this_app_payload() {
            Ok(p) => p,
            Err(e) => return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, e)),
        };
        let req = CreateRequest {
            dest,
            passphrase,
            copy_mail,
            copy_config,
            remove_from_host,
            params: mailvault_core::transfer::crypto::EXPORT_PARAMS,
        };
        return Some(done(id, run_create(state, req, payload).await));
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
/// What of this installed app goes to the drive. The daemon sits inside the
/// same bundle / folder / AppImage as the app, so it finds it from its own path.
fn this_app_payload() -> Result<Vec<std::path::PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let appimage = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from);
    mailvault_core::portable::app_payload(&exe, appimage.as_deref(), cfg!(windows))
}

/// A portable copy is made from an installed one, never from another.
pub(crate) const E_FROM_PORTABLE: &str = "E_PORTABLE_FROM_PORTABLE";

pub(crate) struct CreateRequest {
    pub dest: std::path::PathBuf,
    pub passphrase: Zeroizing<String>,
    pub copy_mail: bool,
    pub copy_config: bool,
    pub remove_from_host: bool,
    pub params: mailvault_core::transfer::crypto::Params,
}

async fn reopen_vault(state: &Arc<DaemonState>) {
    if let Some(resp) = crate::handlers::search_index::route(state, "vault_reopen", &json!({}), Value::Null).await {
        if let Some(err) = resp.error {
            tracing::warn!("[portable] vault_reopen after create failed: {}", err.message);
        }
    }
}

/// `portable.create` with the app payload passed in (tests use a stub).
///
/// The vault is closed for the copy exactly as for a vault move, so custody
/// and the index are checkpointed and nothing writes under the copier. The
/// host is only touched after `portable::create` verified the drive copy and
/// marked it; on removal the vault stays closed, since the app quits next.
pub(crate) async fn run_create(state: &Arc<DaemonState>, req: CreateRequest, payload: Vec<std::path::PathBuf>) -> Result<Value, String> {
    if req.copy_mail && !state.mail_dir_ok {
        return Err("The current mail storage folder is unreachable, so there is no mail to copy right now.".to_string());
    }
    let secrets = if req.copy_config { credentials::read_host_secrets().await? } else { Default::default() };

    crate::handlers::search_index::route(state, "vault_close", &json!({}), Value::Null).await;
    let st = Arc::clone(state);
    let dest = req.dest.clone();
    let copy_payload = payload.clone();
    let created = blocking(move || {
        let events = st.events.clone();
        let progress = move |phase: &str, done: usize, total: usize| {
            events.emit("portable-create-progress", json!({"phase": phase, "done": done, "total": total}));
        };
        let opts = mailvault_core::portable::CreateOptions {
            dest: &dest,
            payload: &copy_payload,
            app_dir: &st.app_dir,
            mail_dir: req.copy_mail.then_some(st.data_dir.as_path()),
            secrets: &secrets,
            passphrase: &req.passphrase,
            params: req.params,
        };
        mailvault_core::portable::create(&opts, &progress)
    })
    .await
    .and_then(|r| r);
    let created = match created {
        Ok(c) => c,
        Err(e) => {
            reopen_vault(state).await;
            return Err(e);
        }
    };
    let quarantine_cleared = clear_quarantine(&req.dest, &payload);

    let removed = if req.remove_from_host {
        let st = Arc::clone(state);
        let dirs = created.mail_dirs.clone();
        blocking(move || {
            let mail = mailvault_core::vault_ops::remove_sources(&st.data_dir, &dirs);
            let secrets = credentials::delete_host_secrets().map_err(|e| tracing::warn!("[portable] {e}")).is_ok();
            let accounts = std::fs::remove_file(st.app_dir.join("accounts.json"));
            mail && secrets && accounts.map_or_else(|e| e.kind() == std::io::ErrorKind::NotFound, |_| true)
        })
        .await?
    } else {
        reopen_vault(state).await;
        false
    };
    Ok(json!({
        "root": created.root.to_string_lossy(),
        "files": created.files,
        "bytes": created.bytes,
        "removedFromHost": removed,
        "quarantineCleared": quarantine_cleared,
    }))
}

/// A sandboxed app's copies arrive quarantined, and a quarantined app run
/// from a drive is translocated to a random path, where it no longer sees
/// `MailVault Data` beside it. Best effort: the sandbox may refuse, and the
/// UI then tells the user how to clear it.
#[cfg(target_os = "macos")]
fn clear_quarantine(dest: &Path, payload: &[std::path::PathBuf]) -> bool {
    use std::os::unix::ffi::OsStrExt;
    fn walk(p: &Path, ok: &mut bool) {
        let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return };
        // SAFETY: both arguments are NUL-terminated C strings that outlive the call.
        let r = unsafe { libc::removexattr(c.as_ptr(), c"com.apple.quarantine".as_ptr(), libc::XATTR_NOFOLLOW) };
        if r != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOATTR) {
            *ok = false;
        }
        if std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()) {
            for entry in std::fs::read_dir(p).into_iter().flatten().flatten() {
                walk(&entry.path(), ok);
            }
        }
    }
    let mut ok = true;
    for item in payload {
        walk(&dest.join(item.file_name().unwrap_or_default()), &mut ok);
    }
    ok
}

#[cfg(not(target_os = "macos"))]
fn clear_quarantine(_dest: &Path, _payload: &[std::path::PathBuf]) -> bool {
    true
}

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
        // Never the runner's real keychain for the AI key.
        std::env::set_var("MAILVAULT_TEST_AI_KEY", h.creds.with_file_name("ai_key"));

        let reply = run_create(&h.state, request(&h, false), h.payload.clone()).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        std::env::remove_var("MAILVAULT_TEST_AI_KEY");

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
        // Never the runner's real keychain for the AI key.
        std::env::set_var("MAILVAULT_TEST_AI_KEY", h.creds.with_file_name("ai_key"));

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
        std::env::remove_var("MAILVAULT_TEST_AI_KEY");

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
        let orphan_mail = route(
            &s,
            "portable.create",
            &json!({"dest": "/tmp", "passphrase": "long enough passphrase", "copyMail": true, "copyConfig": false}),
            json!(1),
        )
        .await
        .unwrap();
        assert!(orphan_mail.error.is_some(), "mail is filed under accounts: it never goes without them");
    }

    /// Drive pulled while running: writes stop (no second archive on the
    /// host, no half-written files on a drive that is back later), once.
    #[tokio::test]
    async fn a_drive_that_disappears_closes_the_vault_once() {
        let s = st();
        let drive = tempfile::tempdir().unwrap();
        let root = drive.path().join("MailVault Data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("portable.json"), br#"{"version":1}"#).unwrap();
        let flag = std::sync::atomic::AtomicBool::new(false);
        let closed = || s.vault_closed.load(std::sync::atomic::Ordering::SeqCst);

        assert!(!check_drive(&s, &root, &flag).await, "present: nothing happens");
        assert!(!closed());

        std::fs::remove_dir_all(&root).unwrap();
        assert!(check_drive(&s, &root, &flag).await, "gone: reported");
        assert!(closed(), "vault writes refused while the drive is away");
        assert!(!check_drive(&s, &root, &flag).await, "reported once, not every tick");
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
