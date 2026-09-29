//! `aliases.discover`: the addresses one account may send as, for Settings to
//! offer. Two answers side by side, `mailvault_core::aliases` doing the
//! parsing and ranking:
//!
//! - `provider`: what the provider lists. Gmail over OAuth only, with the
//!   token the app already holds (`https://mail.google.com/` covers
//!   `users.settings.sendAs.list`). A refusal is `denied`, never an RPC error.
//! - `detected`: what the account's own mail proves, read locally with no
//!   network: the `From` of its cached Sent headers and the delivery headers
//!   of its newest Inbox files in the vault.
//!
//! Neither half fails the RPC: a store that will not read contributes
//! nothing. The vault half runs on a thread of its own at background QoS and
//! yields to the user between batches of files.

use crate::custody as daemon_custody;
use crate::handlers::common::{str_arg, vault_root};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::aliases::{self, DetectedAlias, ProviderAliases, ProviderStatus, Source};
use mailvault_core::custody::cache as sql_cache;
use mailvault_core::{header_cache, vault_files};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if method != "aliases.discover" {
        return None;
    }
    let Some(account) = params.get("account").filter(|a| a.is_object()) else {
        return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing account"));
    };
    let account_id = match str_arg(&id, params, "accountId") {
        Ok(a) => a,
        Err(resp) => return Some(resp),
    };
    let login = account.get("email").and_then(Value::as_str).unwrap_or_default().to_string();
    let (provider, detected) = tokio::join!(provider(state, account, &login), detect(state, account_id, login.clone()));
    Some(RpcResponse::success(id, json!({ "provider": provider, "detected": detected })))
}

/// The provider's list, or why there is none.
async fn provider(state: &Arc<DaemonState>, account: &Value, login: &str) -> ProviderAliases {
    if !aliases::is_gmail_oauth(account) {
        return ProviderAliases::empty(ProviderStatus::Unsupported);
    }
    let token = account.get("oauth2AccessToken").and_then(Value::as_str).unwrap_or_default();
    if token.is_empty() {
        return ProviderAliases::empty(ProviderStatus::Denied);
    }
    if !state.net.is_online() {
        return ProviderAliases::empty(ProviderStatus::Error);
    }
    aliases::fetch_gmail_send_as(token, login).await
}

/// `scan` on a background-QoS thread of its own: a blocking-pool thread would
/// keep the lowered QoS for whatever it runs next.
async fn detect(state: &Arc<DaemonState>, account_id: String, login: String) -> Vec<DetectedAlias> {
    let state = Arc::clone(state);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let spawned = std::thread::Builder::new().name("alias-scan".into()).spawn(move || {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
        }
        let _ = tx.send(scan(&state, &account_id, &login));
    });
    if let Err(e) = spawned {
        tracing::warn!("[aliases] scan thread did not start: {e}");
        return Vec::new();
    }
    rx.await.unwrap_or_default()
}

/// The detected half. The custody lock is held for one query at a time and
/// the JSON parsed after it is released; the vault files are read with no
/// lock at all.
fn scan(state: &Arc<DaemonState>, account_id: &str, login: &str) -> Vec<DetectedAlias> {
    let Ok(root) = vault_root(state) else { return Vec::new() };
    let list = daemon_custody::with_conn(state, |c| sql_cache::load_mailboxes(c, account_id))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    // Graph's storage keys are these two names as well.
    let sent = aliases::mailbox_by_role(&list, "\\Sent").unwrap_or_else(|| "Sent".into());
    let inbox = aliases::mailbox_by_role(&list, "\\Inbox").unwrap_or_else(|| "INBOX".into());

    let order = if header_cache::uid_tracks_arrival(&root, account_id, &sent) {
        sql_cache::HeaderOrder::Arrival
    } else {
        sql_cache::HeaderOrder::Date
    };
    let rows = daemon_custody::with_conn(state, |c| sql_cache::load_headers(c, account_id, &sent, Some(aliases::SCAN_LIMIT), order))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|mut v| v.get_mut("emails").map(Value::take))
        .and_then(|emails| match emails {
            Value::Array(rows) => Some(rows),
            _ => None,
        })
        .unwrap_or_default();
    let sent_from = aliases::rank(Source::SentFrom, &aliases::senders_of_rows(&rows), login);

    let yield_now = || crate::search_index::yield_to_foreground(&state.search_index);
    yield_now();
    let inbox_dir = vault_files::cur_path(&root, account_id, &inbox);
    let delivered = aliases::scan_delivery_addresses(&inbox_dir, aliases::SCAN_LIMIT, yield_now);
    let delivered_to = aliases::rank(Source::DeliveredTo, &delivered, login);

    aliases::merge([sent_from, delivered_to])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mailvault_core::maildir::{INFO_PREFIX, IMPORT_UID_BASE};
    use std::path::Path;

    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), app_dir, mail_dir_ok);
        if mail_dir_ok {
            let _ = daemon_custody::open_into(&s);
        }
        (tmp, s)
    }

    fn password_account() -> Value {
        json!({"email": "me@example.test", "imapHost": "imap.example.test", "imapPort": 993, "authType": "password"})
    }

    async fn discover(s: &Arc<DaemonState>, params: Value) -> RpcResponse {
        route(s, "aliases.discover", &params, json!(1)).await.expect("routed")
    }

    fn write_eml(root: &Path, mailbox: &str, uid: u32, text: &str) {
        let cur = vault_files::cur_path(root, "a", mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}S.eml")), text).unwrap();
    }

    /// Registration guard: a module never wired into `server::handle_request`
    /// answers "Unknown method" to an app that looks healthy otherwise.
    #[tokio::test]
    async fn the_route_is_reachable_through_the_servers_dispatch() {
        let (_t, s) = st(true);
        let resp = handle_request_for_test(&s, "aliases.discover", json!({"account": password_account(), "accountId": "a"})).await;
        let result = resp.result.unwrap_or_else(|| panic!("aliases.discover is not routed: {:?}", resp.error));
        assert_eq!(result, json!({"provider": {"status": "unsupported", "aliases": []}, "detected": []}));
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_t, s) = st(true);
        assert!(route(&s, "search_index_status", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn a_missing_account_or_account_id_is_invalid_params() {
        let (_t, s) = st(true);
        for params in [json!({"accountId": "a"}), json!({"account": "me@example.test", "accountId": "a"}), json!({"account": password_account()})] {
            let resp = discover(&s, params.clone()).await;
            assert_eq!(resp.error.map(|e| e.code), Some(ipc::INVALID_PARAMS), "{params}");
        }
    }

    #[tokio::test]
    async fn a_gmail_oauth_account_without_a_token_is_denied_and_asks_nobody() {
        let (_t, s) = st(true);
        let account = json!({"email": "me@gmail.com", "imapHost": "imap.gmail.com", "authType": "oauth2", "oauth2Provider": "google"});
        let result = discover(&s, json!({"account": account, "accountId": "a"})).await.result.unwrap();
        assert_eq!(result["provider"], json!({"status": "denied", "aliases": []}));
    }

    #[tokio::test]
    async fn an_outlook_oauth_account_is_unsupported() {
        let (_t, s) = st(true);
        let account = json!({"email": "me@outlook.test", "imapHost": "outlook.office365.com", "authType": "oauth2",
                             "oauth2Provider": "microsoft", "oauth2AccessToken": "test-token"});
        let result = discover(&s, json!({"account": account, "accountId": "a"})).await.result.unwrap();
        assert_eq!(result["provider"]["status"], "unsupported");
    }

    #[tokio::test]
    async fn sent_mail_and_inbox_delivery_headers_are_detected_and_the_login_and_imports_are_not() {
        let (t, s) = st(true);
        let list = json!({"mailboxes": [
            {"path": "INBOX", "specialUse": "\\Inbox", "children": []},
            {"path": "Sent Items", "specialUse": "\\Sent", "children": []},
        ]})
        .to_string();
        let sent = json!({"emails": [
            {"uid": 1, "from": {"name": "Shop", "address": "shop@example.test"}},
            {"uid": 2, "from": {"name": null, "address": "me@example.test"}},
            {"uid": 3, "from": {"name": "", "address": "Shop@example.test"}},
            {"uid": 4, "from": {"name": "Both", "address": "both@example.test"}},
        ], "totalEmails": 4})
        .to_string();
        daemon_custody::with_conn(&s, |c| sql_cache::save_mailboxes(c, "a", &list)).unwrap();
        daemon_custody::with_conn(&s, |c| sql_cache::save_headers(c, "a", "Sent Items", &sent)).unwrap();

        let root = t.path();
        write_eml(root, "INBOX", 10, "Delivered-To: me@example.test\r\nX-Original-To: sales@example.test\r\nSubject: a\r\n\r\nbody");
        write_eml(root, "INBOX", 11, "Delivered-To: sales@example.test\r\nSubject: b\r\n\r\nbody");
        write_eml(root, "INBOX", 12, "Delivered-To: both@example.test\r\nTo: colleague@example.test\r\n\r\nbody");
        write_eml(root, "INBOX", IMPORT_UID_BASE + 1, "Delivered-To: imported@elsewhere.test\r\n\r\n");

        let result = discover(&s, json!({"account": password_account(), "accountId": "a"})).await.result.unwrap();
        assert_eq!(
            result["detected"],
            json!([
                {"address": "shop@example.test", "name": "Shop", "count": 2, "source": "sent_from"},
                {"address": "both@example.test", "name": "Both", "count": 1, "source": "sent_from"},
                {"address": "sales@example.test", "name": "", "count": 2, "source": "delivered_to"},
            ])
        );
    }

    #[tokio::test]
    async fn with_no_folder_list_the_sent_and_inbox_names_are_the_defaults() {
        let (t, s) = st(true);
        let sent = json!({"emails": [{"uid": 1, "from": {"name": "Alias", "address": "alias@example.test"}}]}).to_string();
        daemon_custody::with_conn(&s, |c| sql_cache::save_headers(c, "a", "Sent", &sent)).unwrap();
        write_eml(t.path(), "INBOX", 1, "Delivered-To: in@example.test\r\n\r\n");
        let result = discover(&s, json!({"account": password_account(), "accountId": "a"})).await.result.unwrap();
        let addresses: Vec<&str> = result["detected"].as_array().unwrap().iter().map(|d| d["address"].as_str().unwrap()).collect();
        assert_eq!(addresses, ["alias@example.test", "in@example.test"]);
    }

    #[tokio::test]
    async fn an_unreachable_vault_answers_with_nothing_detected_not_an_error() {
        let (_t, s) = st(false);
        let resp = handle_request_for_test(&s, "aliases.discover", json!({"account": password_account(), "accountId": "a"})).await;
        let result = resp.result.unwrap_or_else(|| panic!("an error instead of an empty answer: {:?}", resp.error));
        assert_eq!(result["detected"], json!([]));
        assert_eq!(result["provider"]["status"], "unsupported");
    }
}
