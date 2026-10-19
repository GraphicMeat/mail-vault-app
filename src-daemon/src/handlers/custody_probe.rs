//! `custody.probe_server_copy`: ask the server whether it still holds a
//! message anywhere, and keep the answer in the message's custody entry.
//!
//! Before this the app ran the sweep itself (`probeServerCopy.js`): read the
//! entry, sweep every folder for the Message-ID (`imap_find_message_id`),
//! stamp the entry. The app still resolves which message (the open view, the
//! row in memory), keeps the account's token fresh, and repaints its rows
//! from the answer; the reading, sweeping and stamping are here.
//!
//! Answers, as the app read them:
//! - `{state: "present", locations, cleared}`: a copy turned up (`cleared`:
//!   an earlier absence stamp was torn up);
//! - `{state: "absent", checkedAt, searched}`: every selectable folder
//!   answered and none holds it, stamped `serverAbsent` on the entry;
//! - `{state: "unknown", reason}`: `no-message-id`, `error` (the sweep
//!   failed), `incomplete` (with `failed`, the folders that would not open)
//!   or `not-in-vault` (nothing to stamp). Nothing is written for any of them.
//!
//! The sweep only SELECTs and SEARCHes; the custody connection is never held
//! across it.
use crate::custody as daemon_custody;
use crate::handlers::common::{blocking, opt_str_arg, str_arg, u32_arg};
use crate::handlers::custody::repair_generation_for;
use crate::handlers::imap::{account_arg, with_background};
use crate::imap;
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::custody::{entries, probe};
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::warn;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if method != "custody.probe_server_copy" {
        return None;
    }
    let account = req!(account_arg(&id, params));
    let account_id = req!(str_arg(&id, params, "accountId"));
    let mailbox = req!(str_arg(&id, params, "mailbox"));
    let uid = req!(u32_arg(&id, params, "uid"));
    let hint = opt_str_arg(params, "messageId");
    let fallback = params.get("fallbackEntry").filter(|v| v.is_object()).cloned();
    Some(RpcResponse::success(id, probe_server_copy(state, &account, account_id, mailbox, uid, hint, fallback).await))
}

/// The entry for `uid` after the mailbox's uid generation is checked: a uid
/// only names a message inside one UIDVALIDITY, so a stale vault would hand
/// over another message's Message-ID.
async fn read_entry(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32) -> Option<Value> {
    let (state, account_id, mailbox) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    blocking(move || {
        if let Err(e) = repair_generation_for(&state, &account_id, &mailbox) {
            warn!("[custody.probe_server_copy] generation repair for {account_id}/{mailbox}: {e}");
        }
        daemon_custody::with_conn(&state, |c| entries::get(c, &account_id, &mailbox, uid))
            .map_err(|e| warn!("[custody.probe_server_copy] read {account_id}/{mailbox}/{uid}: {e}"))
            .ok()
            .flatten()
    })
    .await
    .unwrap_or(None)
}

/// Merge `extra` into the entry as it stands now (or the app's fallback for a
/// message with none). False when there was nothing to stamp or the write failed.
async fn write_stamp(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, fallback: Option<Value>, extra: Value) -> bool {
    let (state, account_id, mailbox) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    blocking(move || {
        daemon_custody::with_conn(&state, |c| {
            let current = entries::get(c, &account_id, &mailbox, uid)?;
            let Some(entry) = probe::stamp(current.as_ref(), fallback.as_ref(), uid, &extra) else {
                return Ok(false);
            };
            entries::upsert(c, &account_id, &mailbox, &[entry]).map(|(written, _)| written == 1)
        })
        .unwrap_or_else(|e| {
            warn!("[custody.probe_server_copy] stamp {account_id}/{mailbox}/{uid}: {e}");
            false
        })
    })
    .await
    .unwrap_or(false)
}

async fn probe_server_copy(
    state: &Arc<DaemonState>,
    account: &imap::ImapConfig,
    account_id: String,
    mailbox: String,
    uid: u32,
    hint: Option<String>,
    fallback: Option<Value>,
) -> Value {
    let entry = read_entry(state, &account_id, &mailbox, uid).await;
    let Some(message_id) = probe::message_id(entry.as_ref(), hint.as_deref()) else {
        return json!({"state": "unknown", "reason": "no-message-id"});
    };

    // Presence needs one hit, absence needs every folder: the common answer
    // (it is still there) costs one round trip.
    let swept = with_background(&state.imap_pool, account, |mut session| async move {
        let result = imap::find_message_id(&mut session, &message_id, true).await?;
        Ok((result, session, None))
    })
    .await;
    let sweep = match swept {
        Ok(sweep) => sweep,
        Err(e) => {
            // A sweep that errored says nothing about the server's contents.
            warn!("[custody.probe_server_copy] sweep for {account_id}/{mailbox}/{uid} failed: {e}");
            return json!({"state": "unknown", "reason": "error"});
        }
    };

    if !sweep.found.is_empty() {
        // On the server after all: an earlier absence stamp is now a lie on disk.
        let cleared = probe::stamped_absent(entry.as_ref());
        if cleared {
            write_stamp(state, &account_id, &mailbox, uid, fallback, probe::present_fields()).await;
        }
        return json!({"state": "present", "locations": sweep.found, "cleared": cleared});
    }
    if !sweep.complete {
        return json!({"state": "unknown", "reason": "incomplete", "failed": sweep.failed});
    }

    // Every selectable folder answered and none of them has it. No vault
    // copy, no claim: gold says the vault is what is left.
    let checked_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if !write_stamp(state, &account_id, &mailbox, uid, fallback, probe::absent_fields(&checked_at)).await {
        return json!({"state": "unknown", "reason": "not-in-vault"});
    }
    json!({"state": "absent", "checkedAt": checked_at, "searched": sweep.searched})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mock_imap::state::Mailbox;
    use mock_imap::{Action, MockImap, Scenario, Trigger};

    fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, true);
        let _ = daemon_custody::open_into(&s);
        (vault, s)
    }

    fn plaintext() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    }

    fn account(server: &MockImap) -> Value {
        json!({"email": "user@example.com", "password": "hunter2", "imapHost": server.host(), "imapPort": server.port()})
    }

    fn message(message_id: &str) -> String {
        format!("From: a@x.test\r\nSubject: kept\r\nMessage-ID: {message_id}\r\nContent-Type: text/plain\r\n\r\nbody\r\n")
    }

    fn put(s: &Arc<DaemonState>, entry: Value) {
        daemon_custody::with_conn(s, |c| entries::upsert(c, "acc", "INBOX", &[entry])).unwrap();
    }

    fn entry(s: &Arc<DaemonState>) -> Option<Value> {
        daemon_custody::with_conn(s, |c| entries::get(c, "acc", "INBOX", 7)).unwrap()
    }

    async fn ask(s: &Arc<DaemonState>, server: &MockImap, extra: Value) -> Value {
        let mut params = json!({"account": account(server), "accountId": "acc", "mailbox": "INBOX", "uid": 7});
        for (k, v) in extra.as_object().unwrap() {
            params[k] = v.clone();
        }
        let resp = handle_request_for_test(s, "custody.probe_server_copy", params).await;
        assert!(resp.error.is_none(), "routed and answered: {:?}", resp.error);
        resp.result.unwrap()
    }

    fn two_folders(holding: Option<&str>) -> MockImap {
        let inbox = Mailbox::new("INBOX").push(message("<other@x.test>"));
        let archive = match holding {
            Some(id) => Mailbox::new("Archive").push(message(id)),
            None => Mailbox::new("Archive"),
        };
        MockImap::start(Scenario::new().mailbox(inbox).mailbox(archive))
    }

    #[tokio::test]
    async fn a_completed_sweep_that_finds_nothing_stamps_the_entry() {
        plaintext();
        let (_v, s) = st();
        put(&s, json!({"uid": 7, "message_id": "<kept@x.test>", "subject": "Aruodas", "source": "local"}));
        let server = two_folders(None);

        let r = ask(&s, &server, json!({})).await;
        assert_eq!(r["state"], "absent");
        assert_eq!(r["searched"].as_array().unwrap().len(), 2);
        let stored = entry(&s).unwrap();
        assert_eq!(stored["serverAbsent"], json!(true));
        assert_eq!(stored["serverAbsentAt"], r["checkedAt"]);
        assert!(r["checkedAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(stored["subject"], "Aruodas", "the rest of the entry is kept");
    }

    #[tokio::test]
    async fn a_copy_in_another_folder_is_present_and_writes_nothing() {
        plaintext();
        let (_v, s) = st();
        let stored = json!({"uid": 7, "message_id": "<kept@x.test>", "subject": "Aruodas"});
        put(&s, stored.clone());
        let server = two_folders(Some("<kept@x.test>"));

        let r = ask(&s, &server, json!({})).await;
        assert_eq!(r["state"], "present");
        assert_eq!(r["locations"], json!([{"mailbox": "Archive", "uid": 1}]));
        assert_eq!(r["cleared"], json!(false));
        assert_eq!(entry(&s).unwrap(), stored);
    }

    #[tokio::test]
    async fn a_found_copy_tears_up_an_earlier_absence_stamp() {
        plaintext();
        let (_v, s) = st();
        put(&s, json!({"uid": 7, "message_id": "<kept@x.test>", "serverAbsent": true, "serverAbsentAt": "2026-01-01T00:00:00.000Z"}));
        let server = two_folders(Some("<kept@x.test>"));

        let r = ask(&s, &server, json!({})).await;
        assert_eq!(r["state"], "present");
        assert_eq!(r["cleared"], json!(true));
        let stored = entry(&s).unwrap();
        assert_eq!(stored["serverAbsent"], json!(false));
        assert_eq!(stored["serverAbsentAt"], Value::Null);
        assert_eq!(stored["message_id"], "<kept@x.test>");
    }

    #[tokio::test]
    async fn no_message_id_anywhere_is_unknown_and_never_reaches_the_server() {
        let (_v, s) = st();
        put(&s, json!({"uid": 7, "message_id": null}));
        // Nothing listens here: a sweep would be an error, not this answer.
        let params = json!({"account": {"email": "u@x.test", "password": "x", "imapHost": "127.0.0.1", "imapPort": 1},
            "accountId": "acc", "mailbox": "INBOX", "uid": 7});
        let r = handle_request_for_test(&s, "custody.probe_server_copy", params).await.result.unwrap();
        assert_eq!(r, json!({"state": "unknown", "reason": "no-message-id"}));
        assert_eq!(entry(&s).unwrap(), json!({"uid": 7, "message_id": null}));
    }

    #[tokio::test]
    async fn the_rows_message_id_is_used_when_there_is_no_entry() {
        plaintext();
        let (_v, s) = st();
        let server = two_folders(Some("<mine@x.test>"));
        let r = ask(&s, &server, json!({"messageId": "<mine@x.test>"})).await;
        assert_eq!(r["state"], "present");
        assert_eq!(entry(&s), None, "a present answer with no entry writes nothing");
    }

    #[tokio::test]
    async fn the_entrys_message_id_wins_over_the_rows() {
        plaintext();
        let (_v, s) = st();
        put(&s, json!({"uid": 7, "message_id": "<kept@x.test>"}));
        let server = two_folders(Some("<row@x.test>"));
        let r = ask(&s, &server, json!({"messageId": "<row@x.test>"})).await;
        assert_eq!(r["state"], "absent", "swept for the entry's Message-ID, not the row's");
    }

    #[tokio::test]
    async fn absent_with_no_entry_and_no_vault_copy_claims_nothing() {
        plaintext();
        let (_v, s) = st();
        let server = two_folders(None);
        let r = ask(&s, &server, json!({"messageId": "<gone@x.test>"})).await;
        assert_eq!(r, json!({"state": "unknown", "reason": "not-in-vault"}));
        assert_eq!(entry(&s), None);
    }

    #[tokio::test]
    async fn absent_with_no_entry_writes_the_apps_row_for_a_vault_copy() {
        plaintext();
        let (_v, s) = st();
        let server = two_folders(None);
        let row = json!({"uid": 7, "subject": "Aruodas", "message_id": "<gone@x.test>", "source": "local"});
        let r = ask(&s, &server, json!({"messageId": "<gone@x.test>", "fallbackEntry": row})).await;
        assert_eq!(r["state"], "absent");
        let stored = entry(&s).unwrap();
        assert_eq!(stored["subject"], "Aruodas");
        assert_eq!(stored["serverAbsent"], json!(true));
    }

    #[tokio::test]
    async fn a_folder_that_would_not_open_is_unknown_and_writes_nothing() {
        plaintext();
        let (_v, s) = st();
        let stored = json!({"uid": 7, "message_id": "<kept@x.test>"});
        put(&s, stored.clone());
        let server = MockImap::start(
            Scenario::new()
                .mailbox(Mailbox::new("INBOX"))
                .mailbox(Mailbox::new("Spam"))
                .fault(Trigger::with("SELECT", "Spam"), Action::Respond("NO".into(), "[NOPERM] Not yours".into())),
        );

        let r = ask(&s, &server, json!({})).await;
        assert_eq!(r, json!({"state": "unknown", "reason": "incomplete", "failed": ["Spam"]}));
        assert_eq!(entry(&s).unwrap(), stored);
    }

    #[tokio::test]
    async fn a_sweep_that_errors_is_unknown_and_writes_nothing() {
        let (_v, s) = st();
        let stored = json!({"uid": 7, "message_id": "<kept@x.test>"});
        put(&s, stored.clone());
        let params = json!({"account": {"email": "u@x.test", "password": "x", "imapHost": "127.0.0.1", "imapPort": 1},
            "accountId": "acc", "mailbox": "INBOX", "uid": 7});
        let r = handle_request_for_test(&s, "custody.probe_server_copy", params).await.result.unwrap();
        assert_eq!(r, json!({"state": "unknown", "reason": "error"}));
        assert_eq!(entry(&s).unwrap(), stored);
    }

    #[tokio::test]
    async fn a_missing_account_is_invalid_params() {
        let (_v, s) = st();
        let resp = handle_request_for_test(&s, "custody.probe_server_copy", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7})).await;
        assert_eq!(resp.error.expect("an error").code, crate::ipc::INVALID_PARAMS);
    }
}
