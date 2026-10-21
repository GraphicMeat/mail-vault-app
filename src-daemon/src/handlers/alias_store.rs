//! `aliases.list/add/remove/dismiss/refresh`: the daemon keeps every
//! account's send-as list (was the app's `services/aliasDiscovery.js` and
//! `utils/aliasDiscovery.js`). The rules are `mailvault_core::aliases::list`;
//! the lookup is `handlers::aliases::discover`.
//!
//! Where the lists live does not change: the settings store's blob in the
//! settings document, `mailvault-settings.state.aliases[accountId]` and
//! `.dismissedAliases[accountId]`. They are read and written only through
//! `SettingsDoc` (a read, then a merge patch of the account's own entries
//! against the version read, again on a conflict), and every write emits
//! `settings-changed` like `settings.patch` does. The app writes that blob
//! whole, so every write here answers the lists it left behind: the app puts
//! them in its store, and its next write carries them.
//!
//! - `aliases.list {accountId, loginEmail}`: `{aliases, dismissed}`, the
//!   login left out.
//! - `aliases.add {accountId, loginEmail, address, name?, source?}`:
//!   `{ok: true, alias, aliases, dismissed}` or `{ok: false, reason}`
//!   (`invalid`, `login`, `duplicate`).
//! - `aliases.remove {accountId, address}`: `{aliases, dismissed,
//!   defaultFromCleared}`; a default From that pointed at it falls back to
//!   the login.
//! - `aliases.dismiss {accountId, address}`: `{aliases, dismissed}`.
//! - `aliases.refresh {accountId, loginEmail, auto?}`: looks the account up
//!   and keeps what it finds: `{added, suggestions, providerStatus, aliases,
//!   dismissed, displayName}`. One lookup per account at a time; a second
//!   call shares it. With `auto: true` it answers `{scheduled}` at once and
//!   runs the lookup later, once per account per daemon run, one account at
//!   a time.
//!
//! The account is the daemon's to read, never the request's: its kind from
//! `accounts.json` (no secrets, no keychain), and the credential a lookup
//! needs (a Gmail token, a JMAP password) from the stored record through
//! `oauth_tokens`, refreshed when due. A lookup the user asked for may raise
//! the keychain prompt; the automatic one never does, and gives its turn back
//! when the credential is not readable yet.
//!
//! Nothing here logs an address, a name or a token.

use crate::handlers::common::{opt_str_arg, str_arg};
use crate::ipc::{self, RpcResponse};
use crate::oauth_tokens::{self, FailKind, Read, TokenError};
use crate::server::DaemonState;
use mailvault_core::aliases::{self, list};
use mailvault_core::settings_doc::{Change, SettingsDoc, SettingsError};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// The settings store's key in the settings document.
const STORE_KEY: &str = "mailvault-settings";
/// The catalog key for a write before the settings store was ever saved.
const NOT_LOADED: &str = "errors.settingsNotLoaded";
/// Writes tried against a document another writer keeps changing.
const WRITE_TRIES: usize = 5;
/// Long enough that the first paint and the first sync are done first.
const AUTO_DELAY: Duration = Duration::from_secs(8);
/// Between two automatic lookups.
const AUTO_SPACING: Duration = Duration::from_secs(3);

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !matches!(method, "aliases.list" | "aliases.add" | "aliases.remove" | "aliases.dismiss" | "aliases.refresh") {
        return None;
    }
    let account_id = match str_arg(&id, params, "accountId") {
        Ok(a) if !a.is_empty() => a,
        Ok(_) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accountId")),
        Err(resp) => return Some(resp),
    };
    let login = opt_str_arg(params, "loginEmail").unwrap_or_default();
    let answer = match method {
        "aliases.refresh" if params.get("auto").and_then(Value::as_bool) == Some(true) => {
            Ok(json!({"scheduled": schedule(state, &account_id, &login, AUTO_DELAY, AUTO_SPACING).is_some()}))
        }
        "aliases.refresh" => refresh_shared(state, &account_id, &login, Read::Guarded).await.reply,
        "aliases.list" => {
            let app_dir = state.app_dir.clone();
            blocking(move || list_reply(&app_dir, &account_id, &login)).await
        }
        _ => {
            let address = opt_str_arg(params, "address").unwrap_or_default();
            let op = match method {
                "aliases.add" => Op::Add {
                    login,
                    address,
                    name: opt_str_arg(params, "name").unwrap_or_default(),
                    source: opt_str_arg(params, "source").unwrap_or_default(),
                },
                "aliases.remove" => Op::Remove { address },
                _ => Op::Dismiss { address },
            };
            write(state, account_id, op).await
        }
    };
    Some(match answer {
        Ok(v) => RpcResponse::success(id, v),
        Err(key) => RpcResponse::error(id, ipc::INTERNAL_ERROR, key),
    })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.unwrap_or_else(|_| Err("errors.settingsWriteFailed".to_string()))
}

// ── The lists in the settings document ──────────────────────────────────────

/// One account's entries in the settings store.
#[derive(Debug, Clone, Default)]
struct Lists {
    aliases: Vec<Value>,
    dismissed: Vec<String>,
    display_name: String,
    default_from: String,
}

/// The settings store's `state`, when the store was saved: an object with a
/// numeric `version` (a merge patch into anything else would leave a blob the
/// app reads as version 0 and migrates from scratch).
fn store_state(values: &Map<String, Value>) -> Option<&Map<String, Value>> {
    let blob = values.get(STORE_KEY)?;
    blob.get("version").and_then(Value::as_u64)?;
    blob.get("state")?.as_object()
}

fn lists_of(state: &Map<String, Value>, account_id: &str) -> Lists {
    let entry = |map: &str| state.get(map).and_then(|m| m.get(account_id));
    Lists {
        aliases: entry("aliases").and_then(Value::as_array).cloned().unwrap_or_default(),
        dismissed: entry("dismissedAliases")
            .and_then(Value::as_array)
            .map(|d| d.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default(),
        display_name: entry("displayNames").and_then(Value::as_str).unwrap_or_default().to_string(),
        default_from: entry("sendAsAddresses").and_then(Value::as_str).unwrap_or_default().to_string(),
    }
}

fn list_reply(app_dir: &std::path::Path, account_id: &str, login: &str) -> Result<Value, String> {
    let snap = SettingsDoc::shared(app_dir).get(Some(&[STORE_KEY.to_string()])).map_err(|e| e.catalog_key().to_string())?;
    let lists = store_state(&snap.values).map(|s| lists_of(s, account_id)).unwrap_or_default();
    Ok(json!({"aliases": list::visible(&lists.aliases, login), "dismissed": lists.dismissed}))
}

/// The patch for one account's entries in the store's `state`.
fn account_patch(account_id: &str, entries: &[(&str, Value)]) -> Value {
    let mut state = Map::new();
    for (map, value) in entries {
        state.insert((*map).to_string(), json!({ account_id: value }));
    }
    Value::Object(state)
}

/// Read the account's lists, let `f` decide (a `state` patch, or none to
/// write nothing, and the answer), and write against the version read.
fn update(
    app_dir: &std::path::Path,
    account_id: &str,
    f: impl Fn(&Lists) -> (Option<Value>, Value),
) -> Result<(Value, Option<Change>), String> {
    let doc = SettingsDoc::shared(app_dir);
    for _ in 0..WRITE_TRIES {
        let snap = doc.get(Some(&[STORE_KEY.to_string()])).map_err(|e| e.catalog_key().to_string())?;
        let Some(state) = store_state(&snap.values) else { return Err(NOT_LOADED.to_string()) };
        let (patch, answer) = f(&lists_of(state, account_id));
        let Some(patch) = patch else { return Ok((answer, None)) };
        match doc.patch(&json!({ STORE_KEY: { "state": patch } }), Some(snap.version)) {
            Ok(change) => return Ok((answer, Some(change))),
            Err(SettingsError::Conflict { .. }) => continue,
            Err(e) => return Err(e.catalog_key().to_string()),
        }
    }
    Err(SettingsError::Conflict { current: 0 }.catalog_key().to_string())
}

/// `update` off the async workers, and the `settings-changed` event every
/// window follows.
async fn update_and_tell(
    state: &Arc<DaemonState>,
    account_id: String,
    f: impl Fn(&Lists) -> (Option<Value>, Value) + Send + 'static,
) -> Result<Value, String> {
    let app_dir = state.app_dir.clone();
    let (answer, change) = blocking(move || update(&app_dir, &account_id, f)).await?;
    if let Some(change) = change.filter(|c| !c.changed.is_empty()) {
        state.events.emit(crate::handlers::settings::CHANGED_EVENT, json!({"keys": change.changed, "version": change.version}));
    }
    Ok(answer)
}

enum Op {
    Add { login: String, address: String, name: String, source: String },
    Remove { address: String },
    Dismiss { address: String },
}

async fn write(state: &Arc<DaemonState>, account_id: String, op: Op) -> Result<Value, String> {
    let id = account_id.clone();
    update_and_tell(state, account_id, move |lists| match &op {
        Op::Add { login, address, name, source } => {
            match list::add(&lists.aliases, &lists.dismissed, login, address, name, source) {
                Ok(added) => {
                    let patch = account_patch(&id, &[("aliases", json!(added.aliases)), ("dismissedAliases", json!(added.dismissed))]);
                    (Some(patch), json!({"ok": true, "alias": added.alias, "aliases": added.aliases, "dismissed": added.dismissed}))
                }
                Err(reason) => (None, json!({"ok": false, "reason": reason})),
            }
        }
        Op::Remove { address } => {
            let removed = list::remove(&lists.aliases, &lists.dismissed, address);
            let cleared = !list::key(address).is_empty() && list::key(&lists.default_from) == list::key(address);
            let mut entries = vec![("aliases", json!(removed.aliases)), ("dismissedAliases", json!(removed.dismissed))];
            if cleared {
                entries.push(("sendAsAddresses", json!("")));
            }
            let unchanged = removed.aliases == lists.aliases && removed.dismissed == lists.dismissed;
            let patch = (!unchanged || cleared).then(|| account_patch(&id, &entries));
            (patch, json!({"aliases": removed.aliases, "dismissed": removed.dismissed, "defaultFromCleared": cleared}))
        }
        Op::Dismiss { address } => {
            let dismissed = list::dismiss(&lists.dismissed, address);
            let patch = (dismissed != lists.dismissed).then(|| account_patch(&id, &[("dismissedAliases", json!(dismissed))]));
            (patch, json!({"aliases": lists.aliases, "dismissed": dismissed}))
        }
    })
    .await
}

// ── Refresh ─────────────────────────────────────────────────────────────────

/// What one lookup came to. `give_back`: the account or its credential could
/// not be read, so an automatic turn is handed back for a later ask.
#[derive(Clone)]
struct Refreshed {
    reply: Result<Value, String>,
    give_back: bool,
}

/// The account to look up with, read by the daemon: `None` when it cannot
/// be (no listing, no record, or a credential a lookup needs is unreadable).
async fn account_for(state: &Arc<DaemonState>, account_id: &str, login: &str, read: Read) -> Option<Value> {
    let (dir, id) = (state.app_dir.clone(), account_id.to_string());
    let listed = tokio::task::spawn_blocking(move || crate::ai_gate::listed_record(&dir, &id)).await.ok().flatten();
    let mut account = match listed {
        Some(listed) => listed,
        None => match read {
            Read::Quiet => crate::credentials::resolve_account_record_quiet(account_id).await.ok(),
            Read::Guarded => crate::credentials::resolve_account_with_record_guarded(account_id).await.ok().map(|(_, r)| r),
        }
        .or_else(|| (!login.trim().is_empty() && read == Read::Guarded).then(|| json!({"email": login})))?,
    };
    if account.get("email").and_then(Value::as_str).map_or(true, |e| e.trim().is_empty()) {
        account["email"] = json!(login);
    }
    if aliases::is_jmap(&account) {
        // Its server is asked with the stored password or token.
        let resolved = match read {
            Read::Quiet => crate::credentials::resolve_account_with_record_quiet(account_id).await,
            Read::Guarded => crate::credentials::resolve_account_with_record_guarded(account_id).await,
        };
        let Ok((config, record)) = resolved else { return (read == Read::Guarded).then_some(account) };
        let token = match oauth_tokens::fresh_config(state, account_id, config, &record).await {
            Ok(fresh) => fresh.access_token,
            Err(TokenError { fallback, .. }) => fallback,
        };
        let mut full = record;
        if let Some(token) = token {
            full["oauth2AccessToken"] = json!(token);
        }
        return Some(full);
    }
    if aliases::is_gmail_oauth(&account) {
        match oauth_tokens::access_token(state, account_id, read).await {
            Ok(Some(token)) | Err(TokenError { fallback: Some(token), .. }) => account["oauth2AccessToken"] = json!(token),
            Err(TokenError { kind: FailKind::NoRecord | FailKind::Unreadable, .. }) if read == Read::Quiet => return None,
            // No token the daemon holds: the provider half answers `denied`.
            _ => {
                if let Some(obj) = account.as_object_mut() {
                    obj.remove("oauth2AccessToken");
                }
            }
        }
    }
    Some(account)
}

async fn refresh_once(state: &Arc<DaemonState>, account_id: &str, login: &str, read: Read) -> Refreshed {
    let Some(account) = account_for(state, account_id, login, read).await else {
        let reply = json!({"added": [], "suggestions": [], "providerStatus": "error", "aliases": Value::Null, "dismissed": Value::Null, "displayName": Value::Null});
        return Refreshed { reply: Ok(reply), give_back: true };
    };
    let login = account.get("email").and_then(Value::as_str).unwrap_or(login).to_string();
    let result = super::aliases::discover(state, &account, account_id).await;
    let id = account_id.to_string();
    let reply = update_and_tell(state, account_id.to_string(), move |lists| {
        let merged = list::merge_discovery(&lists.aliases, &lists.dismissed, &login, &lists.display_name, &result);
        let mut entries = Vec::new();
        if merged.changed {
            entries.push(("aliases", json!(merged.aliases)));
        }
        if let Some(name) = &merged.display_name {
            entries.push(("displayNames", json!(name)));
        }
        let patch = (!entries.is_empty()).then(|| account_patch(&id, &entries));
        let answer = json!({
            "added": merged.added,
            "suggestions": merged.suggestions,
            "providerStatus": merged.provider_status,
            "aliases": merged.aliases,
            "dismissed": lists.dismissed,
            "displayName": merged.display_name,
        });
        (patch, answer)
    })
    .await;
    Refreshed { reply, give_back: false }
}

type Flights = HashMap<(PathBuf, String), Vec<tokio::sync::oneshot::Sender<Refreshed>>>;

/// The lookups running now, by app dir and account: their waiters.
fn flights() -> &'static Mutex<Flights> {
    static FLIGHTS: OnceLock<Mutex<Flights>> = OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `refresh_once`, shared by every caller asking for the account meanwhile.
async fn refresh_shared(state: &Arc<DaemonState>, account_id: &str, login: &str, read: Read) -> Refreshed {
    let key = (state.app_dir.clone(), account_id.to_string());
    let wait = {
        let mut running = flights().lock().unwrap_or_else(|e| e.into_inner());
        match running.get_mut(&key) {
            Some(waiters) => {
                let (tx, rx) = tokio::sync::oneshot::channel();
                waiters.push(tx);
                Some(rx)
            }
            None => {
                running.insert(key.clone(), Vec::new());
                None
            }
        }
    };
    if let Some(rx) = wait {
        return rx.await.unwrap_or(Refreshed { reply: Err("errors.settingsWriteFailed".into()), give_back: false });
    }
    // Taken out again even if this task is dropped mid-lookup.
    struct Leave(Option<(PathBuf, String)>, Option<Refreshed>);
    impl Drop for Leave {
        fn drop(&mut self) {
            let Some(key) = self.0.take() else { return };
            let waiters = flights().lock().unwrap_or_else(|e| e.into_inner()).remove(&key).unwrap_or_default();
            if let Some(done) = self.1.take() {
                for tx in waiters {
                    let _ = tx.send(done.clone());
                }
            }
        }
    }
    let mut leave = Leave(Some(key), None);
    let done = refresh_once(state, account_id, login, read).await;
    leave.1 = Some(done.clone());
    drop(leave);
    done
}

/// Accounts given their automatic lookup this daemon run.
fn scheduled() -> &'static Mutex<HashSet<(PathBuf, String)>> {
    static SCHEDULED: OnceLock<Mutex<HashSet<(PathBuf, String)>>> = OnceLock::new();
    SCHEDULED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// One automatic lookup at a time.
fn auto_lane() -> &'static tokio::sync::Mutex<()> {
    static LANE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LANE.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// The automatic lookup: once per account per daemon run, `delay` from now,
/// after any other account's (each `spacing` apart). `None`: this account's
/// was already asked for.
fn schedule(state: &Arc<DaemonState>, account_id: &str, login: &str, delay: Duration, spacing: Duration) -> Option<tokio::task::JoinHandle<()>> {
    let key = (state.app_dir.clone(), account_id.to_string());
    if !scheduled().lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone()) {
        return None;
    }
    let (state, account_id, login) = (Arc::clone(state), account_id.to_string(), login.to_string());
    Some(tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        let _lane = auto_lane().lock().await;
        let done = refresh_shared(&state, &account_id, &login, Read::Quiet).await;
        if done.give_back {
            scheduled().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        }
        if let Err(e) = &done.reply {
            tracing::warn!("[aliases] the automatic lookup was not kept: {e}");
        }
        tokio::time::sleep(spacing).await;
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody as daemon_custody;
    use crate::server::handle_request_for_test;
    use mailvault_core::custody::cache as sql_cache;
    use mailvault_core::maildir::INFO_PREFIX;
    use mailvault_core::vault_files;
    use std::path::Path;

    struct Rig {
        _mail: tempfile::TempDir,
        app: tempfile::TempDir,
        s: Arc<DaemonState>,
    }

    fn rig() -> Rig {
        let mail = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(mail.path().to_path_buf(), app.path().to_path_buf(), true);
        let _ = daemon_custody::open_into(&s);
        Rig { _mail: mail, app, s }
    }

    impl Rig {
        fn settings_path(&self) -> PathBuf {
            self.app.path().join("frontend-settings.json")
        }

        /// The settings store saved with `state`, beside another store's key.
        fn seed(&self, state: Value) {
            let doc = json!({STORE_KEY: {"state": state, "version": 17}, "mailvault-theme": {"state": {"theme": "dark"}, "version": 0}});
            std::fs::write(self.settings_path(), doc.to_string()).unwrap();
        }

        fn on_disk(&self) -> Value {
            serde_json::from_slice(&std::fs::read(self.settings_path()).unwrap()).unwrap()
        }

        fn state(&self) -> Value {
            self.on_disk()[STORE_KEY]["state"].clone()
        }

        fn version(&self) -> u64 {
            SettingsDoc::shared(self.app.path()).get(None).unwrap().version
        }

        fn list_accounts(&self, accounts: Value) {
            std::fs::write(self.app.path().join("accounts.json"), accounts.to_string()).unwrap();
        }

        async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            let resp = handle_request_for_test(&self.s, method, params).await;
            match resp.error {
                Some(e) => Err(e.message),
                None => Ok(resp.result.unwrap_or(Value::Null)),
            }
        }
    }

    const LOGIN: &str = "me@example.test";

    fn alias(address: &str, name: &str, source: &str) -> Value {
        json!({"address": address, "name": name, "source": source})
    }

    fn write_eml(root: &Path, account: &str, mailbox: &str, uid: u32, text: &str) {
        let cur = vault_files::cur_path(root, account, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}S.eml")), text).unwrap();
    }

    fn saw_settings_changed(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> bool {
        let mut seen = false;
        while let Ok(line) = rx.try_recv() {
            seen |= line.contains(crate::handlers::settings::CHANGED_EVENT);
        }
        seen
    }

    // ── Routing and params ─────────────────────────────────────────────

    #[tokio::test]
    async fn every_method_is_reachable_through_the_server_s_dispatch() {
        let r = rig();
        r.seed(json!({"aliases": {}, "dismissedAliases": {}}));
        for method in ["aliases.list", "aliases.add", "aliases.remove", "aliases.dismiss"] {
            let resp = handle_request_for_test(&r.s, method, json!({"accountId": "a", "loginEmail": LOGIN, "address": "x@example.test"})).await;
            assert!(resp.error.is_none(), "{method} is not routed: {:?}", resp.error);
        }
    }

    #[tokio::test]
    async fn another_domain_s_method_is_not_routed_here() {
        let r = rig();
        assert!(route(&r.s, "aliases.discover", &json!({}), json!(1)).await.is_none());
        assert!(route(&r.s, "settings.get", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn a_missing_account_id_is_invalid_params() {
        let r = rig();
        for params in [json!({}), json!({"accountId": ""}), json!({"accountId": 7})] {
            let resp = route(&r.s, "aliases.list", &params, json!(1)).await.unwrap();
            assert_eq!(resp.error.map(|e| e.code), Some(ipc::INVALID_PARAMS), "{params}");
        }
    }

    // ── list ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn list_answers_the_account_s_aliases_without_the_login_and_its_dismissals() {
        let r = rig();
        r.seed(json!({
            "aliases": {"a": [alias("ME@example.test", "", "manual"), alias("desk@example.test", "Desk", "provider")], "b": [alias("b@example.test", "", "manual")]},
            "dismissedAliases": {"a": ["gone@example.test"]},
        }));
        let got = r.call("aliases.list", json!({"accountId": "a", "loginEmail": LOGIN})).await.unwrap();
        assert_eq!(got, json!({"aliases": [alias("desk@example.test", "Desk", "provider")], "dismissed": ["gone@example.test"]}));
    }

    #[tokio::test]
    async fn list_with_no_settings_saved_is_empty_not_an_error() {
        let r = rig();
        let got = r.call("aliases.list", json!({"accountId": "a", "loginEmail": LOGIN})).await.unwrap();
        assert_eq!(got, json!({"aliases": [], "dismissed": []}));
        assert!(!r.settings_path().exists());
    }

    // ── add ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn add_writes_the_account_s_list_only_and_tells_every_window() {
        let r = rig();
        r.seed(json!({
            "aliases": {"b": [alias("b@example.test", "", "manual")]},
            "dismissedAliases": {"a": ["desk@example.test"]},
            "cacheLimitMB": 128,
        }));
        let mut rx = r.s.events.subscribe();
        let before = r.version();

        let got = r.call("aliases.add", json!({"accountId": "a", "loginEmail": LOGIN, "address": " Desk@example.test ", "name": " Desk "})).await.unwrap();

        assert_eq!(got, json!({"ok": true, "alias": alias("Desk@example.test", "Desk", "manual"),
            "aliases": [alias("Desk@example.test", "Desk", "manual")], "dismissed": []}));
        let disk = r.on_disk();
        assert_eq!(disk[STORE_KEY]["version"], 17);
        assert_eq!(disk[STORE_KEY]["state"]["cacheLimitMB"], 128);
        assert_eq!(disk[STORE_KEY]["state"]["aliases"], json!({"b": [alias("b@example.test", "", "manual")], "a": [alias("Desk@example.test", "Desk", "manual")]}));
        assert_eq!(disk[STORE_KEY]["state"]["dismissedAliases"], json!({"a": []}));
        assert_eq!(disk["mailvault-theme"], json!({"state": {"theme": "dark"}, "version": 0}));
        assert!(r.version() > before);
        assert!(saw_settings_changed(&mut rx));
    }

    #[tokio::test]
    async fn a_refused_add_says_why_and_writes_nothing() {
        let r = rig();
        r.seed(json!({"aliases": {"a": [alias("desk@example.test", "", "provider")]}}));
        let before = r.version();
        for (address, reason) in [("nope", "invalid"), ("ME@example.test", "login"), ("DESK@example.test", "duplicate")] {
            let got = r.call("aliases.add", json!({"accountId": "a", "loginEmail": LOGIN, "address": address})).await.unwrap();
            assert_eq!(got, json!({"ok": false, "reason": reason}), "{address}");
        }
        assert_eq!(r.version(), before);
    }

    #[tokio::test]
    async fn a_write_before_the_settings_store_was_ever_saved_is_refused_and_creates_nothing() {
        let r = rig();
        let err = r.call("aliases.add", json!({"accountId": "a", "loginEmail": LOGIN, "address": "desk@example.test"})).await.unwrap_err();
        assert_eq!(err, NOT_LOADED);
        assert!(!r.settings_path().exists());

        // A blob with no version would be read as version 0 and migrated from scratch.
        std::fs::write(r.settings_path(), json!({STORE_KEY: {"state": {}}}).to_string()).unwrap();
        let err = r.call("aliases.dismiss", json!({"accountId": "a", "address": "desk@example.test"})).await.unwrap_err();
        assert_eq!(err, NOT_LOADED);
        assert_eq!(r.on_disk(), json!({STORE_KEY: {"state": {}}}));
    }

    // ── remove, dismiss ────────────────────────────────────────────────

    #[tokio::test]
    async fn remove_drops_the_alias_and_its_signature_remembers_it_and_clears_a_default_from_on_it() {
        let r = rig();
        r.seed(json!({
            "aliases": {"a": [json!({"address": "desk@example.test", "name": "", "source": "manual", "signature": {"html": "<p>D</p>", "text": "D"}}), alias("sales@example.test", "", "manual")]},
            "sendAsAddresses": {"a": "Desk@example.test", "b": "b@example.test"},
        }));

        let got = r.call("aliases.remove", json!({"accountId": "a", "address": "sales@example.test"})).await.unwrap();
        assert_eq!(got["defaultFromCleared"], false);
        assert_eq!(r.state()["sendAsAddresses"]["a"], "Desk@example.test");

        let got = r.call("aliases.remove", json!({"accountId": "a", "address": "DESK@example.test"})).await.unwrap();
        assert_eq!(got, json!({"aliases": [], "dismissed": ["sales@example.test", "desk@example.test"], "defaultFromCleared": true}));
        let state = r.state();
        assert_eq!(state["aliases"]["a"], json!([]));
        assert_eq!(state["sendAsAddresses"], json!({"a": "", "b": "b@example.test"}));
    }

    #[tokio::test]
    async fn dismiss_turns_an_address_down_once_and_a_second_dismissal_writes_nothing() {
        let r = rig();
        r.seed(json!({"aliases": {"a": [alias("desk@example.test", "", "manual")]}}));
        let got = r.call("aliases.dismiss", json!({"accountId": "a", "address": " Shop@Example.test "})).await.unwrap();
        assert_eq!(got, json!({"aliases": [alias("desk@example.test", "", "manual")], "dismissed": ["shop@example.test"]}));
        let after = r.version();
        r.call("aliases.dismiss", json!({"accountId": "a", "address": "shop@example.test"})).await.unwrap();
        assert_eq!(r.version(), after);
        assert_eq!(r.state()["dismissedAliases"], json!({"a": ["shop@example.test"]}));
    }

    // ── refresh ────────────────────────────────────────────────────────

    /// A password account `accounts.json` lists, with one Sent row and one
    /// Inbox file: no keychain read, no network.
    fn password_rig() -> Rig {
        let r = rig();
        r.list_accounts(json!([{"id": "a", "email": LOGIN, "imapHost": "imap.example.test", "authType": "password"}]));
        let sent = json!({"emails": [{"uid": 1, "from": {"name": "Shop", "address": "shop@example.test"}}]}).to_string();
        daemon_custody::with_conn(&r.s, |c| sql_cache::save_headers(c, "a", "Sent", &sent)).unwrap();
        write_eml(r._mail.path(), "a", "INBOX", 5, "Delivered-To: sales@example.test\r\n\r\nbody");
        r
    }

    #[tokio::test]
    async fn refresh_keeps_what_the_account_s_mail_proves_and_offers_delivery_addresses() {
        let r = password_rig();
        r.seed(json!({"aliases": {"a": [json!({"address": "desk@example.test", "name": "", "source": "manual", "signature": {"html": "<p>D</p>", "text": "D"}})]}}));
        let mut rx = r.s.events.subscribe();

        let got = r.call("aliases.refresh", json!({"accountId": "a", "loginEmail": LOGIN})).await.unwrap();

        assert_eq!(got["providerStatus"], "unsupported");
        assert_eq!(got["added"], json!([alias("shop@example.test", "Shop", "detected")]));
        assert_eq!(got["suggestions"], json!([{"address": "sales@example.test", "name": "", "count": 1, "source": "delivered_to"}]));
        assert_eq!(got["displayName"], Value::Null);
        // The signature the app stored on an alias survives the lookup.
        let stored = json!([
            {"address": "desk@example.test", "name": "", "source": "manual", "signature": {"html": "<p>D</p>", "text": "D"}},
            alias("shop@example.test", "Shop", "detected"),
        ]);
        assert_eq!(got["aliases"], stored);
        assert_eq!(r.state()["aliases"]["a"], stored);
        assert!(saw_settings_changed(&mut rx));

        // A second lookup that finds nothing new writes nothing.
        let before = r.version();
        let again = r.call("aliases.refresh", json!({"accountId": "a", "loginEmail": LOGIN})).await.unwrap();
        assert_eq!(again["added"], json!([]));
        assert_eq!(r.version(), before);
    }

    #[tokio::test]
    async fn refresh_never_brings_back_an_address_the_user_removed() {
        let r = password_rig();
        r.seed(json!({"aliases": {"a": [alias("shop@example.test", "", "manual")]}}));
        r.call("aliases.remove", json!({"accountId": "a", "address": "shop@example.test"})).await.unwrap();
        let got = r.call("aliases.refresh", json!({"accountId": "a", "loginEmail": LOGIN})).await.unwrap();
        assert_eq!(got["added"], json!([]));
        assert_eq!(r.state()["aliases"]["a"], json!([]));
    }

    /// The credential blob the debug build reads instead of the keychain,
    /// and every other process-global this test sets, for its whole span.
    struct Env {
        _lock: std::sync::MutexGuard<'static, ()>,
        _dir: tempfile::TempDir,
        vars: Vec<&'static str>,
    }

    impl Env {
        fn with_records(records: &[Value]) -> Env {
            let lock = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
            let dir = tempfile::tempdir().unwrap();
            let blob: HashMap<String, String> = records.iter().map(|r| (r["id"].as_str().unwrap().to_string(), r.to_string())).collect();
            let path = dir.path().join("credentials.json");
            std::fs::write(&path, serde_json::to_string(&blob).unwrap()).unwrap();
            std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &path);
            Env { _lock: lock, _dir: dir, vars: vec!["MAILVAULT_TEST_CREDENTIALS"] }
        }

        fn set(&mut self, var: &'static str, value: &str) {
            std::env::set_var(var, value);
            self.vars.push(var);
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            for var in &self.vars {
                std::env::remove_var(var);
            }
        }
    }

    /// The Gmail send-as list is asked for with the token the daemon holds,
    /// read from the stored record: the request carries none.
    #[tokio::test]
    async fn a_gmail_account_is_asked_with_the_daemon_s_own_token_and_names_the_account() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let body = json!({"sendAs": [
                {"sendAsEmail": "me@gmail.com", "displayName": "Me Myself", "isPrimary": true, "verificationStatus": "accepted"},
                {"sendAsEmail": "desk@example.test", "displayName": "Front Desk", "verificationStatus": "accepted"},
            ]})
            .to_string();
            let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });
        let far = chrono::Utc::now().timestamp_millis() + 3_600_000;
        let record = json!({"id": "g", "email": "me@gmail.com", "imapHost": "imap.gmail.com", "authType": "oauth2", "oauth2Provider": "google",
                            "oauth2AccessToken": "daemon-held-token", "oauth2ExpiresAt": far});
        let mut env = Env::with_records(&[record]);
        env.set("MAILVAULT_GMAIL_API_BASE", &format!("http://127.0.0.1:{port}"));
        let r = rig();
        r.list_accounts(json!([{"id": "g", "email": "me@gmail.com", "imapHost": "imap.gmail.com", "authType": "oauth2", "oauth2Provider": "google"}]));
        r.seed(json!({"displayNames": {}}));

        let got = r.call("aliases.refresh", json!({"accountId": "g", "loginEmail": "me@gmail.com"})).await.unwrap();

        let request = server.await.unwrap();
        assert!(request.contains("authorization: bearer daemon-held-token"), "the lookup did not carry the daemon's token");
        assert_eq!(got["providerStatus"], "ok");
        assert_eq!(got["added"], json!([alias("desk@example.test", "Front Desk", "provider")]));
        assert_eq!(got["displayName"], "Me Myself");
        assert_eq!(r.state()["displayNames"], json!({"g": "Me Myself"}));
        drop(env);
    }

    /// A JMAP mock with one Inbox and these identities (`(email, name)`).
    fn jmap_mock(identities: &[(&str, &str)]) -> mock_jmap::MockJmap {
        mailvault_core::jmap::base::allow_loopback_for_tests();
        mock_jmap::MockJmap::start(mock_jmap::Scenario {
            accounts: vec![mock_jmap::ScenarioAccount {
                username: LOGIN.into(),
                password: "pw".into(),
                token: None,
                identities: identities.iter().map(|(e, n)| (e.to_string(), n.to_string())).collect(),
                mailboxes: vec![mock_jmap::ScenarioMailbox { id: "mb-inbox".into(), name: "Inbox".into(), parent_id: None, role: Some("inbox".into()), emails: vec![] }],
            }],
            ..Default::default()
        })
    }

    /// A JMAP account's server is asked with the password the daemon reads
    /// from the stored record, once for two lookups asked at the same time.
    #[tokio::test]
    async fn a_jmap_account_is_asked_with_the_stored_password_once_for_two_callers() {
        let m = jmap_mock(&[(LOGIN, "Me"), ("sales@example.test", "Sales")]);
        let shape = json!({"id": "j", "email": LOGIN, "imapHost": "127.0.0.1", "authType": "password", "jmapSessionUrl": m.session_url(), "jmapAuth": "basic"});
        let mut record = shape.clone();
        record["password"] = json!("pw");
        let env = Env::with_records(&[record]);
        let r = rig();
        r.list_accounts(json!([shape]));
        r.seed(json!({"displayNames": {"j": "Chosen"}}));

        let params = json!({"accountId": "j", "loginEmail": LOGIN});
        let (one, two) = tokio::join!(r.call("aliases.refresh", params.clone()), r.call("aliases.refresh", params));
        let (one, two) = (one.unwrap(), two.unwrap());

        assert_eq!(one, two);
        assert_eq!(one["providerStatus"], "ok");
        assert_eq!(one["added"], json!([alias("sales@example.test", "Sales", "provider")]));
        // The user named the account: the server's name does not replace it.
        assert_eq!(one["displayName"], Value::Null);
        assert_eq!(r.state()["displayNames"], json!({"j": "Chosen"}));
        assert_eq!(m.count_calls("Identity/get"), 1);
        drop(env);
    }

    #[tokio::test]
    async fn the_automatic_lookup_runs_once_per_account_and_gives_its_turn_back_when_the_account_is_unknown() {
        let env = Env::with_records(&[]);
        let r = rig();
        r.seed(json!({}));
        let first = schedule(&r.s, "nobody", LOGIN, Duration::ZERO, Duration::ZERO).expect("scheduled");
        first.await.unwrap();
        // Nothing to read it with: asked again, it runs again.
        let again = schedule(&r.s, "nobody", LOGIN, Duration::ZERO, Duration::ZERO).expect("the turn was given back");
        again.await.unwrap();

        let r2 = password_rig();
        r2.seed(json!({}));
        let ran = schedule(&r2.s, "a", LOGIN, Duration::ZERO, Duration::ZERO).expect("scheduled");
        assert!(schedule(&r2.s, "a", LOGIN, Duration::ZERO, Duration::ZERO).is_none(), "a second ask in the same run is not scheduled");
        ran.await.unwrap();
        assert_eq!(r2.state()["aliases"]["a"], json!([alias("shop@example.test", "Shop", "detected")]));
        drop(env);
    }

    #[tokio::test]
    async fn an_automatic_refresh_answers_at_once() {
        let r = rig();
        let got = r.call("aliases.refresh", json!({"accountId": "later", "loginEmail": LOGIN, "auto": true})).await.unwrap();
        assert_eq!(got, json!({"scheduled": true}));
        let got = r.call("aliases.refresh", json!({"accountId": "later", "loginEmail": LOGIN, "auto": true})).await.unwrap();
        assert_eq!(got, json!({"scheduled": false}));
    }
}
