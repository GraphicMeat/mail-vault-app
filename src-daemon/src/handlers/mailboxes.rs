//! `mailboxes.load`: the account's folder list, from the stored copy when it is
//! young enough and from the server otherwise.
//!
//! The decisions are `mailvault_core::mailbox_policy` (ported from the app's
//! `activateAccount.js`); this handler reads the stored list, asks the server
//! through the same handler `imap_get_mailboxes` is (IMAP pool, or the JMAP
//! bridge for a JMAP account), retries a failed listing once, rejects an empty
//! answer over a real list, and stores what it keeps. The app renders what comes
//! back.
//!
//! Params: `{ accountId, account, force? }`. `account` is the account as
//! `imap_get_mailboxes` takes it (credentials resolved by the app; an OAuth2
//! token is replaced by the daemon's own before this runs). `force` skips the
//! stored copy (the one-shot Refresh flag). A Graph account is refused: its
//! listing is converted and key-adopted in the app, so the app loads it itself.
//!
//! Reply: `{ mailboxes, fetchedAt, source, suspectEmpty? }`. (The app decides
//! whether the list differs from the one on screen itself: the daemon only knows
//! the stored copy, which is not always what the sidebar shows.)
//! - `source: "cache"`: the stored list is fresh and complete; the server was
//!   not asked. `mailboxes` and `fetchedAt` are the stored ones.
//! - `source: "server"`: the server was asked. `suspectEmpty: false`, the list
//!   is the server's, already stored (`fetchedAt` is the store time).
//!   `suspectEmpty: true`: the server sent no folders where a real list was
//!   held; nothing was stored, `mailboxes`/`fetchedAt` are the stored ones.
//!
//! A failed listing (after its one retry) is the error `imap_get_mailboxes`
//! would have answered. A failed store is logged and does not fail the load.
//!
//! A stored list that cannot be READ is not the same as none: the decisions go
//! on as for no cache, but an empty server answer is then stored only after the
//! list is read again (to keep its last-known-good copy), and not at all when
//! that read fails too, so a read error never wipes a good list.

use crate::account_lifecycle::AccountStamp;
use crate::custody as daemon_custody;
use crate::handlers::common::{blocking, str_arg, with_vault_write};
use crate::ipc::{self, RpcResponse};
use crate::state::DaemonState;
use mailvault_core::clock::now_ms;
use mailvault_core::custody::cache as sql_cache;
use mailvault_core::imap::Transport;
use mailvault_core::mailbox_policy::{self, CacheEntry, Settled};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tracing::warn;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "mailboxes.load" => load(state, params, id).await,
        _ => return None,
    })
}

/// A failed listing: the code and text the inner handler answered with.
type Failure = (i32, String);

async fn load(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    macro_rules! ask {
        ($result:expr) => {
            match $result {
                Ok(v) => v,
                Err(resp) => return resp,
            }
        };
    }
    let account_id = ask!(str_arg(&id, params, "accountId"));
    let account = ask!(crate::handlers::imap::account_arg(&id, params));
    let force = params.get("force").and_then(Value::as_bool).unwrap_or(false);
    if account.transport() == Transport::Graph {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, "mailboxes.load does not list a Graph account");
    }
    // Before any network IO, the way the cache routes take it: an account being
    // removed, or one the daemon does not know, gets no listing and no store.
    let stamp = match state.account_lifecycle.capture(&account_id) {
        Ok(stamp) => stamp,
        Err(_) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.keychainBusy"),
    };

    let first_read = read_cache(state, &account_id).await;
    if let Err(error) = &first_read {
        warn!("[mailboxes.load] the stored folder list could not be read: {error}");
    }
    // Decisions go on as for no cache; the store step below tells the two apart.
    let cached = first_read.ok().flatten();
    if !force && mailbox_policy::should_use_fresh_cache(cached.as_ref(), now_ms()) {
        let cached = cached.unwrap_or_default();
        return RpcResponse::success(id, json!({
            "mailboxes": cached.mailboxes.unwrap_or_default(),
            "fetchedAt": cached.fetched_at,
            "source": "cache",
        }));
    }

    let fresh = match list_with_one_retry(state, params).await {
        Ok(fresh) => fresh,
        Err((code, message)) => return RpcResponse::error(id, code, message),
    };
    let now = now_ms();
    RpcResponse::success(id, match mailbox_policy::settle(cached.as_ref(), &fresh, now) {
        Settled::Suspect { mailboxes, fetched_at } => json!({
            "mailboxes": mailboxes,
            "fetchedAt": fetched_at,
            "source": "server",
            "suspectEmpty": true,
        }),
        Settled::Accepted { .. } => {
            // Only an empty list consults what is on file (its last-known-good
            // copy), and `db.saveMailboxes` read that at save time.
            let on_file = if fresh.is_empty() { Some(read_cache(state, &account_id).await) } else { None };
            match accepted_entry(&fresh, on_file.as_ref(), now) {
                Some(entry) => {
                    if let Err(error) = store(state, stamp, &account_id, entry.to_string()).await {
                        warn!("[mailboxes.load] the folder list was not stored: {error}");
                    }
                }
                None => warn!("[mailboxes.load] an empty folder list was not stored: the stored one could not be read"),
            }
            json!({
                "mailboxes": fresh,
                "fetchedAt": now,
                "source": "server",
                "suspectEmpty": false,
            })
        }
    })
}

/// What reading the stored list came to: `Ok(None)` is no list (or one with
/// nothing usable in it), `Err` is a read that failed.
type CacheRead = Result<Option<CacheEntry>, String>;

async fn read_cache(state: &Arc<DaemonState>, account_id: &str) -> CacheRead {
    let (state, account_id) = (Arc::clone(state), account_id.to_owned());
    let raw = blocking(move || crate::handlers::cache::load_mailbox_listing(&state, &account_id)).await??;
    Ok(raw.and_then(|raw| mailbox_policy::parse_cache_entry(&raw)))
}

/// The document to store for an accepted listing. `on_file` is the stored list
/// read just before the store (`None` when the listing is not empty and the
/// stored list does not matter). `None` back: do not store, because an empty
/// list would replace one that could not be read, last-known-good included.
fn accepted_entry(fresh: &[Value], on_file: Option<&CacheRead>, now: i64) -> Option<Value> {
    match on_file {
        None => Some(mailbox_policy::cache_entry_json(fresh, None, now)),
        Some(Ok(entry)) => Some(mailbox_policy::cache_entry_json(fresh, entry.as_ref(), now)),
        Some(Err(_)) => None,
    }
}

/// `save_mailbox_cache`'s write, under the same account stamp and vault gate.
async fn store(state: &Arc<DaemonState>, stamp: AccountStamp, account_id: &str, data: String) -> Result<(), String> {
    let (state, account_id) = (Arc::clone(state), account_id.to_owned());
    blocking(move || -> Result<(), String> {
        let _permit = state.account_lifecycle.try_commit(std::slice::from_ref(&stamp)).map_err(|_| "errors.keychainBusy".to_owned())?;
        with_vault_write(&state, |_root| {
            daemon_custody::with_conn(&state, |c| sql_cache::save_mailboxes(c, &account_id, &data))
        })
    })
    .await
    .and_then(|stored| stored)
}

/// `retryOnce`: a failed listing is asked for once more after a pause.
async fn list_with_one_retry(state: &Arc<DaemonState>, params: &Value) -> Result<Vec<Value>, Failure> {
    match list(state, params).await {
        Ok(listing) => Ok(listing),
        Err(_) => {
            tokio::time::sleep(Duration::from_millis(mailbox_policy::RETRY_DELAY_MS)).await;
            list(state, params).await
        }
    }
}

/// One `imap_get_mailboxes` answer (the JMAP bridge answers it for a JMAP
/// account), as the list or the failure.
async fn list(state: &Arc<DaemonState>, params: &Value) -> Result<Vec<Value>, Failure> {
    let ask = json!({ "account": params.get("account").cloned().unwrap_or(Value::Null) });
    let reply = crate::handlers::imap::route(state, "imap_get_mailboxes", &ask, Value::Null)
        .await
        .ok_or_else(|| (ipc::INTERNAL_ERROR, "Failed to fetch mailboxes".to_owned()))?;
    if let Some(error) = reply.error {
        return Err((error.code, error.message));
    }
    reply
        .result
        .as_ref()
        .and_then(|result| result.get("mailboxes"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| (ipc::INTERNAL_ERROR, "Failed to fetch mailboxes".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::handle_request_for_test;
    use mock_imap::state::Mailbox;
    use mock_imap::{MockImap, Scenario};

    fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), app_dir, true);
        std::fs::write(s.app_dir.join("accounts.json"), r#"[{"id":"acc1"}]"#).unwrap();
        s.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&s.app_dir)).unwrap());
        let _ = crate::custody::open_into(&s);
        (tmp, s)
    }

    fn plaintext() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    }

    /// An account whose server is nowhere: any attempt to list it fails.
    fn unreachable_account() -> Value {
        json!({"id": "acc1", "email": "user@example.com", "password": "pw", "imapHost": "127.0.0.1", "imapPort": 1})
    }

    fn account_of(server: &MockImap) -> Value {
        json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": server.host(), "imapPort": server.port()})
    }

    fn two_folders() -> Value {
        json!([
            {"name": "INBOX", "path": "INBOX", "specialUse": null, "flags": [], "delimiter": "/", "noselect": false, "children": []},
            {"name": "Old", "path": "Old", "specialUse": null, "flags": [], "delimiter": "/", "noselect": false, "children": []},
        ])
    }

    async fn put_cache(s: &Arc<DaemonState>, entry: Value) {
        let saved = handle_request_for_test(s, "save_mailbox_cache", json!({"accountId": "acc1", "data": entry.to_string()})).await;
        assert!(saved.error.is_none(), "{:?}", saved.error.map(|e| e.message));
    }

    async fn stored(s: &Arc<DaemonState>) -> Value {
        let raw = handle_request_for_test(s, "load_mailbox_cache", json!({"accountId": "acc1"})).await.result.unwrap();
        serde_json::from_str(raw.as_str().expect("a cache entry is stored")).unwrap()
    }

    fn paths(list: &Value) -> Vec<&str> {
        list.as_array().unwrap().iter().map(|m| m["path"].as_str().unwrap()).collect()
    }

    /// RED before: no `mailboxes.load` row, so the dispatch answers METHOD_NOT_FOUND.
    /// A fresh, complete stored list answers without a connection: the account
    /// points at a closed port, so reaching for the server would be an error.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fresh_complete_cache_answers_without_touching_the_network() {
        let (_t, s) = st();
        let fetched_at = now_ms() - 1_000;
        put_cache(&s, json!({"mailboxes": two_folders(), "fetchedAt": fetched_at})).await;

        let resp = handle_request_for_test(&s, "mailboxes.load", json!({"accountId": "acc1", "account": unreachable_account(), "force": false})).await;

        let result = resp.result.unwrap_or_else(|| panic!("{:?}", resp.error.map(|e| e.message)));
        assert_eq!(result["source"], json!("cache"));
        assert_eq!(result["fetchedAt"], json!(fetched_at));
        assert_eq!(paths(&result["mailboxes"]), ["INBOX", "Old"]);
    }

    /// RED before: no handler. `force` must skip the fresh copy: the same setup
    /// as above now has to ask the server, and the closed port makes that an error.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn force_skips_the_cache_and_asks_the_server() {
        let (_t, s) = st();
        put_cache(&s, json!({"mailboxes": two_folders(), "fetchedAt": now_ms()})).await;

        let resp = handle_request_for_test(&s, "mailboxes.load", json!({"accountId": "acc1", "account": unreachable_account(), "force": true})).await;

        let error = resp.error.expect("the server was asked, and it is not there");
        assert!(!error.message.is_empty());
        // The stored list is untouched by a failed listing.
        assert_eq!(paths(&stored(&s).await["mailboxes"]), ["INBOX", "Old"]);
    }

    /// RED before: no handler. A stale list is replaced by the server's, the
    /// reply says it changed, and the store holds it with a last-known-good copy.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stale_cache_is_replaced_by_the_servers_list_and_stored() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(Mailbox::new("Archive")));
        let (_t, s) = st();
        put_cache(&s, json!({"mailboxes": two_folders(), "fetchedAt": now_ms() - 11 * 60 * 1000})).await;

        let resp = handle_request_for_test(&s, "mailboxes.load", json!({"accountId": "acc1", "account": account_of(&server)})).await;

        let result = resp.result.unwrap_or_else(|| panic!("{:?}", resp.error.map(|e| e.message)));
        assert_eq!(result["source"], json!("server"));
        assert_eq!(result["suspectEmpty"], json!(false));
        let listed = paths(&result["mailboxes"]);
        assert!(listed.contains(&"INBOX") && listed.contains(&"Archive") && !listed.contains(&"Old"), "{listed:?}");

        let entry = stored(&s).await;
        assert_eq!(entry["mailboxes"], result["mailboxes"]);
        assert_eq!(entry["lastKnownGoodMailboxes"], result["mailboxes"]);
        assert_eq!(entry["fetchedAt"], result["fetchedAt"]);
        assert_eq!(entry["lastKnownGoodAt"], result["fetchedAt"]);
    }

    /// RED before: no handler. No stored list at all (a first activation): the
    /// server is asked, whatever `force` says, and the answer is stored.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_nothing_stored_the_server_is_asked_and_the_answer_stored() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(Mailbox::new("Archive")));
        let (_t, s) = st();

        let resp = handle_request_for_test(&s, "mailboxes.load", json!({"accountId": "acc1", "account": account_of(&server)})).await;

        let result = resp.result.unwrap_or_else(|| panic!("{:?}", resp.error.map(|e| e.message)));
        assert_eq!(result["source"], json!("server"));
        assert_eq!(stored(&s).await["mailboxes"], result["mailboxes"]);
    }

    fn good_entry() -> CacheEntry {
        CacheEntry {
            mailboxes: Some(vec![]),
            fetched_at: Some(1),
            last_known_good: serde_json::from_value(two_folders()).ok(),
            last_known_good_at: Some(1),
        }
    }

    /// RED before: `accepted_entry` did not exist; a failed read was folded into "no cache"
    /// and an empty server answer was stored without the last-known-good copy.
    #[test]
    fn an_empty_listing_is_stored_only_when_the_stored_list_could_be_read() {
        // Read failed again at store time: nothing is stored.
        let failed: CacheRead = Err("database is locked".to_owned());
        assert_eq!(accepted_entry(&[], Some(&failed), 5), None);
        // Read fine: the last-known-good copy on file is kept.
        let read: CacheRead = Ok(Some(good_entry()));
        let entry = accepted_entry(&[], Some(&read), 5).expect("stored");
        assert_eq!(entry["mailboxes"], json!([]));
        assert_eq!(entry["lastKnownGoodMailboxes"], two_folders());
        // Nothing on file and nothing wrong: the empty list is stored as it is.
        let none: CacheRead = Ok(None);
        let entry = accepted_entry(&[], Some(&none), 5).expect("stored");
        assert_eq!(entry["mailboxes"], json!([]));
        assert!(entry.get("lastKnownGoodMailboxes").is_none());
    }

    /// A non-empty listing becomes the new last-known-good whatever was on file.
    #[test]
    fn a_listing_with_folders_is_stored_without_reading_the_stored_one() {
        let fresh: Vec<Value> = serde_json::from_value(two_folders()).unwrap();
        let entry = accepted_entry(&fresh, None, 7).expect("stored");
        assert_eq!(entry["lastKnownGoodMailboxes"], two_folders());
        assert_eq!(entry["lastKnownGoodAt"], json!(7));
        assert_eq!(entry["fetchedAt"], json!(7));
    }

    /// RED before: no handler. An account the daemon does not know gets the
    /// error its sibling cache routes give, before any connection is made.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unknown_account_errors_like_the_cache_routes() {
        let (_t, s) = st();
        let mut account = unreachable_account();
        account["id"] = json!("nobody");

        let resp = handle_request_for_test(&s, "mailboxes.load", json!({"accountId": "nobody", "account": account})).await;
        let sibling = handle_request_for_test(&s, "save_mailbox_cache", json!({"accountId": "nobody", "data": "[]"})).await;

        assert_eq!(resp.error.map(|e| e.message), Some("errors.keychainBusy".to_owned()));
        assert_eq!(sibling.error.map(|e| e.message), Some("errors.keychainBusy".to_owned()));
    }

    /// RED before: no handler. Missing or invalid params are INVALID_PARAMS, and
    /// a Graph account is refused (its listing is converted in the app).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bad_params_and_a_graph_account_are_refused() {
        let (_t, s) = st();
        let no_account = handle_request_for_test(&s, "mailboxes.load", json!({"accountId": "acc1"})).await;
        let no_id = handle_request_for_test(&s, "mailboxes.load", json!({"account": unreachable_account()})).await;
        let mut graph = unreachable_account();
        graph["oauth2Transport"] = json!("graph");
        let graph = handle_request_for_test(&s, "mailboxes.load", json!({"accountId": "acc1", "account": graph})).await;

        for resp in [no_account, no_id, graph] {
            assert_eq!(resp.error.map(|e| e.code), Some(ipc::INVALID_PARAMS));
        }
    }
}
