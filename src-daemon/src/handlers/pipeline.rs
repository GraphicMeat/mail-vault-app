//! Strict routes for the ordinary download-ahead focus (S5). The app reports the
//! view it shows; it never sends credentials, policy, selected uids or a date
//! cutoff, and a field outside the contract is refused before anything is read.

use crate::ipc::{self, RpcResponse};
use crate::pipeline_focus::{FocusInput, PipelineFocus};
use crate::server::DaemonState;
use mailvault_core::pipeline::{Focus, Observation, Scope};
use serde_json::{Map, Value};
use std::sync::Arc;

/// Rows are hints about the loaded list; the cache decides what exists.
const MAX_ROWS: usize = 20_000;

fn fields<'a>(value: &'a Value, allowed: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) { return None; }
    Some(object)
}

fn name(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty() && text.len() <= 1024 && !text.chars().any(char::is_control)).then(|| text.to_owned())
}

fn hint_date(value: Option<&Value>) -> Option<Option<Value>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) if text.len() <= 128 => Some(Some(Value::String(text.clone()))),
        Some(Value::Number(number)) if number.as_f64().is_some_and(f64::is_finite) => Some(Some(Value::Number(number.clone()))),
        _ => None,
    }
}

fn observation(value: &Value) -> Option<Observation> {
    let object = fields(value, &["accountId", "mailbox", "uid", "date", "internalDate"])?;
    let uid = object.get("uid")?.as_u64().filter(|uid| (1..=u64::from(u32::MAX)).contains(uid))? as u32;
    Some(Observation {
        account_id: name(object.get("accountId"))?,
        mailbox: name(object.get("mailbox"))?,
        uid,
        date: hint_date(object.get("date"))?,
        internal_date: hint_date(object.get("internalDate"))?,
    })
}

fn focus_input(params: &Value) -> Option<FocusInput> {
    let object = fields(params, &["revision", "focus", "online"])?;
    let revision = object.get("revision")?.as_u64().filter(|value| *value <= 9_007_199_254_740_991)?;
    let online = object.get("online")?.as_bool()?;
    let focus = match object.get("focus")? {
        Value::Null => None,
        value => {
            let focus = fields(value, &["accountId", "mailbox", "scope", "rows"])?;
            let scope = match focus.get("scope")?.as_str()? {
                "folder" => Scope::Folder,
                "unified" => Scope::Unified,
                "subtree" => Scope::Subtree,
                _ => return None,
            };
            let rows = match focus.get("rows") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(rows)) if rows.len() <= MAX_ROWS =>
                    rows.iter().map(observation).collect::<Option<Vec<_>>>()?,
                _ => return None,
            };
            let focus = Focus { account_id: name(focus.get("accountId"))?, mailbox: name(focus.get("mailbox"))?, scope, rows };
            // The shape of the view is checked here; the account itself is checked natively.
            mailvault_core::pipeline::scope_focus(&focus).ok()?;
            Some(focus)
        }
    };
    Some(FocusInput { revision, online, focus })
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: Value, id: Value) -> RpcResponse {
    match method {
        "pipeline.focus" => {
            let Some(input) = focus_input(&params) else {
                return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
            };
            match PipelineFocus::accept(state, input) {
                Ok(answer) => RpcResponse::success(id, answer),
                Err(key) => RpcResponse::error(id, ipc::INVALID_PARAMS, key),
            }
        }
        "pipeline.status" => {
            if fields(&params, &[]).is_none() && !params.is_null() {
                return RpcResponse::error(id, ipc::INVALID_PARAMS, "errors.accountsInvalid");
            }
            RpcResponse::success(id, PipelineFocus::status(state).await)
        }
        _ => RpcResponse::error(id, ipc::METHOD_NOT_FOUND, "errors.syncUnavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use serde_json::json;
    use std::path::Path;

    const NOW_ISO: fn() -> String = || chrono::Utc::now().to_rfc3339();

    fn seed_accounts(state: &Arc<DaemonState>, ids: &[&str]) {
        let rows: Vec<Value> = ids.iter().map(|id| json!({"id": id, "email": format!("{id}@example.test"),
            "authType": "password", "imapHost": "127.0.0.1", "imapPort": 143, "imapSecure": false})).collect();
        std::fs::write(state.app_dir.join("accounts.json"), Value::Array(rows).to_string()).unwrap();
        state.account_lifecycle.seed(&mailvault_core::accounts_doc::list(
            &mailvault_core::accounts_doc::shared(&state.app_dir)).unwrap());
    }

    fn settings(dir: &Path, state: Value) {
        std::fs::write(dir.join("frontend-settings.json"),
            json!({"mailvault-settings": {"state": state}}).to_string()).unwrap();
    }

    fn cache(state: &Arc<DaemonState>, account: &str, mailbox: &str, rows: &[(u32, &str)]) {
        let emails: Vec<Value> = rows.iter().map(|(uid, date)| json!({"uid": uid, "date": date, "internalDate": date,
            "subject": format!("s{uid}"), "flags": []})).collect();
        let body = json!({"emails": emails, "totalEmails": emails.len()}).to_string();
        crate::custody::with_conn(state, |conn| mailvault_core::custody::cache::save_headers(conn, account, mailbox, &body)).unwrap();
    }

    async fn vault(state: &Arc<DaemonState>, account: &str, mailbox: &str, uid: u32) {
        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD.encode(b"From: a@example.test\r\n\r\nbody");
        let stored = handle_request_for_test(state, "maildir_store", json!({"accountId": account, "mailbox": mailbox,
            "uid": uid, "rawSourceBase64": raw, "flags": []})).await;
        assert!(stored.error.is_none(), "{stored:?}");
    }

    fn row(account: &str, mailbox: &str, uid: u32) -> Value {
        json!({"accountId": account, "mailbox": mailbox, "uid": uid, "date": NOW_ISO()})
    }

    async fn focus(state: &Arc<DaemonState>, revision: u64, online: bool, focus: Value) -> RpcResponse {
        handle_request_for_test(state, "pipeline.focus", json!({"revision": revision, "online": online, "focus": focus})).await
    }

    async fn status(state: &Arc<DaemonState>) -> Value {
        handle_request_for_test(state, "pipeline.status", json!({})).await.result.expect("status answers")
    }

    fn fresh() -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        settings(dir.path(), json!({"fetchMode": "hoarder"}));
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        (dir, state)
    }

    #[tokio::test]
    async fn s5_a_focus_spanning_two_accounts_with_the_same_uid_queues_only_the_focused_pair() {
        let (_dir, state) = fresh();
        seed_accounts(&state, &["acc1", "acc2"]);
        let now = NOW_ISO();
        cache(&state, "acc1", "INBOX", &[(7, &now), (8, &now)]);
        cache(&state, "acc2", "INBOX", &[(7, &now), (9, &now)]);
        let answer = focus(&state, 1, false, json!({"accountId": "acc1", "mailbox": "INBOX", "scope": "folder",
            "rows": [row("acc1", "INBOX", 7), row("acc2", "INBOX", 7), row("acc1", "INBOX", 8), row("acc2", "INBOX", 9)]})).await;
        assert_eq!(answer.result, Some(json!({"revision": 1, "accepted": true})), "{answer:?}");
        state.hoarder_worker.pipeline.quiet().await;
        assert_eq!(state.hoarder_worker.pipeline.runnable(), vec![("acc1".to_owned(), "INBOX".to_owned(), vec![7, 8])]);
        let status = status(&state).await;
        assert_eq!(status["accounts"]["acc1"]["queued"], json!(2), "{status}");
        assert!(status["accounts"].get("acc2").is_none() || status["accounts"]["acc2"]["queued"] == json!(0), "{status}");
    }

    #[tokio::test]
    async fn s5_a_sent_uid_never_becomes_inbox_work() {
        // The JS shared one row list between the Sent warm and the INBOX content pass (the
        // `legacySentRowsFeedInboxContent` trace); native keys candidates by (account, folder).
        let (_dir, state) = fresh();
        seed_accounts(&state, &["acc1"]);
        let now = NOW_ISO();
        cache(&state, "acc1", "INBOX", &[(1, &now)]);
        cache(&state, "acc1", "Sent", &[(7, &now)]);
        let answer = focus(&state, 1, false, json!({"accountId": "acc1", "mailbox": "INBOX", "scope": "folder",
            "rows": [row("acc1", "INBOX", 1), row("acc1", "Sent", 7)]})).await;
        assert!(answer.error.is_none(), "{answer:?}");
        state.hoarder_worker.pipeline.quiet().await;
        assert_eq!(state.hoarder_worker.pipeline.runnable(), vec![("acc1".to_owned(), "INBOX".to_owned(), vec![1])]);
    }

    #[tokio::test]
    async fn s5_a_unified_focus_resolves_a_real_folder_and_only_its_own_account() {
        let (_dir, state) = fresh();
        seed_accounts(&state, &["acc1", "acc2"]);
        let now = NOW_ISO();
        cache(&state, "acc1", "Archive", &[(7, &now)]);
        cache(&state, "acc2", "INBOX", &[(7, &now)]);
        let answer = focus(&state, 1, false, json!({"accountId": "acc1", "mailbox": "UNIFIED", "scope": "unified",
            "rows": [row("acc2", "INBOX", 7), row("acc1", "Archive", 7)]})).await;
        assert!(answer.error.is_none(), "{answer:?}");
        state.hoarder_worker.pipeline.quiet().await;
        assert_eq!(state.hoarder_worker.pipeline.runnable(), vec![("acc1".to_owned(), "Archive".to_owned(), vec![7])]);
    }

    #[tokio::test]
    async fn s5_rows_missing_from_the_cache_and_kept_bodies_are_not_work() {
        let (_dir, state) = fresh();
        seed_accounts(&state, &["acc1"]);
        let now = NOW_ISO();
        cache(&state, "acc1", "INBOX", &[(1, &now), (2, &now), (3, &now)]);
        vault(&state, "acc1", "INBOX", 2).await;
        let answer = focus(&state, 1, false, json!({"accountId": "acc1", "mailbox": "INBOX", "scope": "folder",
            "rows": [row("acc1", "INBOX", 1), row("acc1", "INBOX", 2), row("acc1", "INBOX", 3), row("acc1", "INBOX", 99)]})).await;
        assert!(answer.error.is_none(), "{answer:?}");
        state.hoarder_worker.pipeline.quiet().await;
        assert_eq!(state.hoarder_worker.pipeline.runnable(), vec![("acc1".to_owned(), "INBOX".to_owned(), vec![1, 3])]);
    }

    #[tokio::test]
    async fn s5_policy_decides_what_is_fetched_ahead() {
        for (mode, expect) in [("onDemand", vec![]), ("hoarder", vec![1, 2])] {
            let dir = tempfile::tempdir().unwrap();
            settings(dir.path(), json!({"fetchMode": mode}));
            let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
            seed_accounts(&state, &["acc1"]);
            let now = NOW_ISO();
            cache(&state, "acc1", "INBOX", &[(1, &now), (2, &now)]);
            let answer = focus(&state, 1, false, json!({"accountId": "acc1", "mailbox": "INBOX", "scope": "folder",
                "rows": [row("acc1", "INBOX", 1), row("acc1", "INBOX", 2)]})).await;
            assert!(answer.error.is_none(), "{answer:?}");
            state.hoarder_worker.pipeline.quiet().await;
            assert_eq!(state.hoarder_worker.pipeline.runnable(), vec![("acc1".to_owned(), "INBOX".to_owned(), expect)], "{mode}");
        }
    }

    #[tokio::test]
    async fn s5_an_unknown_vault_is_unknown_not_empty() {
        let (_dir, state) = fresh();
        seed_accounts(&state, &["acc1"]);
        let now = NOW_ISO();
        cache(&state, "acc1", "INBOX", &[(1, &now)]);
        // The vault is being moved: it cannot be read, which is not the same as holding nothing.
        state.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let answer = focus(&state, 1, false, json!({"accountId": "acc1", "mailbox": "INBOX", "scope": "folder",
            "rows": [row("acc1", "INBOX", 1)]})).await;
        assert!(answer.error.is_none(), "{answer:?}");
        state.hoarder_worker.pipeline.quiet().await;
        let status = status(&state).await;
        assert_eq!(status["accounts"]["acc1"]["pausedReason"], json!("vaultUnknown"), "{status}");
        assert_eq!(status["accounts"]["acc1"]["queued"], json!(0), "an unreadable vault must not queue every body again");
    }

    #[tokio::test]
    async fn s5_a_focus_on_a_removed_or_reconfigured_account_leaves_no_work() {
        let (dir, state) = fresh();
        seed_accounts(&state, &["acc1", "acc2"]);
        let now = NOW_ISO();
        cache(&state, "acc1", "INBOX", &[(1, &now)]);
        cache(&state, "acc2", "INBOX", &[(1, &now)]);
        for account in ["acc1", "acc2"] {
            let answer = focus(&state, if account == "acc1" { 1 } else { 2 }, false, json!({"accountId": account,
                "mailbox": "INBOX", "scope": "folder", "rows": [row(account, "INBOX", 1)]})).await;
            assert!(answer.error.is_none(), "{answer:?}");
            state.hoarder_worker.pipeline.quiet().await;
        }
        assert_eq!(status(&state).await["accounts"]["acc2"]["queued"], json!(1));
        // The account is reconfigured in place: what was derived under the old server is gone.
        let reconfigured = json!([{"id": "acc2", "email": "acc2@example.test", "authType": "password",
            "imapHost": "other.example.test", "imapPort": 993, "imapSecure": true}]);
        std::fs::write(dir.path().join("accounts.json"), reconfigured.to_string()).unwrap();
        let after = status(&state).await;
        assert!(after["accounts"].get("acc2").is_none(), "a reconfigured account keeps no stale queue: {after}");
        assert!(after["accounts"].get("acc1").is_none(), "a removed account keeps no stale queue: {after}");
        // And a focus that names an account that is gone queues nothing.
        let ghost = focus(&state, 3, false, json!({"accountId": "acc1", "mailbox": "INBOX", "scope": "folder",
            "rows": [row("acc1", "INBOX", 1)]})).await;
        assert!(ghost.error.is_none(), "{ghost:?}");
        state.hoarder_worker.pipeline.quiet().await;
        assert!(state.hoarder_worker.pipeline.runnable().is_empty());
    }

    #[tokio::test]
    async fn s5_a_repeated_focus_is_idempotent_and_a_stale_revision_is_ignored() {
        let (_dir, state) = fresh();
        seed_accounts(&state, &["acc1"]);
        let now = NOW_ISO();
        cache(&state, "acc1", "INBOX", &[(1, &now)]);
        let view = json!({"accountId": "acc1", "mailbox": "INBOX", "scope": "folder", "rows": [row("acc1", "INBOX", 1)]});
        let first = focus(&state, 5, false, view.clone()).await;
        let again = focus(&state, 5, false, view.clone()).await;
        assert_eq!(first.result, Some(json!({"revision": 5, "accepted": true})));
        assert_eq!(again.result, first.result, "the identical retry is accepted without new work");
        state.hoarder_worker.pipeline.quiet().await;
        let stale = focus(&state, 4, false, json!(null)).await;
        assert_eq!(stale.result, Some(json!({"revision": 5, "accepted": false})), "{stale:?}");
        assert_eq!(state.hoarder_worker.pipeline.runnable().len(), 1, "a stale clear changes nothing");
        let conflict = focus(&state, 5, false, json!({"accountId": "acc1", "mailbox": "Archive", "scope": "folder", "rows": []})).await;
        assert!(conflict.error.is_some(), "the same revision with another view is refused");
        let status = status(&state).await;
        assert_eq!(status["revision"], json!(5));
        assert!(status["instanceId"].is_string());
        let cleared = focus(&state, 6, false, json!(null)).await;
        assert_eq!(cleared.result, Some(json!({"revision": 6, "accepted": true})));
        assert!(state.hoarder_worker.pipeline.runnable().is_empty());
    }

    #[tokio::test]
    async fn s5_the_contract_is_strict() {
        let (_dir, state) = fresh();
        seed_accounts(&state, &["acc1"]);
        let bad = [
            json!({"revision": 1, "online": true}),
            json!({"revision": -1, "online": true, "focus": null}),
            json!({"revision": 1, "online": "yes", "focus": null}),
            json!({"revision": 1, "online": true, "focus": null, "extra": 1}),
            json!({"revision": 1, "online": true, "focus": {"accountId": "acc1", "mailbox": "INBOX", "scope": "all"}}),
            json!({"revision": 1, "online": true, "focus": {"accountId": "acc1", "mailbox": "UNIFIED", "scope": "folder"}}),
            json!({"revision": 1, "online": true, "focus": {"accountId": "acc1", "mailbox": "INBOX", "scope": "folder", "password": "x"}}),
            json!({"revision": 1, "online": true, "focus": {"accountId": "acc1", "mailbox": "INBOX", "scope": "folder",
                "rows": [{"accountId": "acc1", "mailbox": "INBOX", "uid": 0}]}}),
            json!({"revision": 1, "online": true, "focus": {"accountId": "acc1", "mailbox": "INBOX", "scope": "folder",
                "rows": [{"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "token": "t"}]}}),
        ];
        for params in bad {
            let answer = handle_request_for_test(&state, "pipeline.focus", params.clone()).await;
            assert!(answer.result.is_none() && answer.error.is_some(), "{params} -> {answer:?}");
        }
        let extra = handle_request_for_test(&state, "pipeline.status", json!({"accountId": "acc1"})).await;
        assert!(extra.error.is_some(), "status takes no parameters");
    }
}
