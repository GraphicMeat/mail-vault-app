//! The deleted-mail bin (`mailvault_core::app_db::deleted`): capture before a
//! delete, recover, discard, and the hourly purge.
//!
//! `capture` runs inside the delete routes (`imap_delete_email`,
//! `graph_delete_message`, `maildir_delete` for a local-only message) before
//! anything is removed. The bytes come from the vault or the in-memory copy
//! when there is one (the original, never a decrypted copy), else from the
//! server, fetched without keeping a vault copy of a message that is about to
//! go. The bin sits beside app.db, never in the vault.
//!
//! `deleted.recover` puts a message back on the server (moved back out of the
//! Trash folder the delete put it in, when it is still there; else APPENDed
//! to the folder it came from) or into the vault as a local copy the user
//! keeps. Graph accounts recover locally only: the daemon holds no Graph
//! token.
use crate::handlers::common::{blocking, done, vec_arg, with_mailbox_write};
use crate::imap::{self, ImapConfig};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::app_db::{self, deleted::{self as bin, Capture, Deleted}};
use mailvault_core::custody::{cache, entries};
use mailvault_core::graph::GraphClient;
use mailvault_core::{vault_eml, vault_files};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

/// How often the purge looks for mail past its retention.
const PURGE_EVERY: Duration = Duration::from_secs(60 * 60);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Where a message about to be deleted can be read from when neither the
/// vault nor memory holds it.
pub(crate) enum Source<'a> {
    Imap(&'a ImapConfig),
    Graph(&'a GraphClient, &'a str),
    /// Only on this computer: the vault copy is all there is.
    Local,
}

/// Capture `uid` into the bin before it is deleted. `Ok(Some((id,
/// created)))`: it is there; `created` is false when an earlier call of the
/// same delete already put it there. `Ok(None)`: nothing to capture, the
/// message is already gone. `Err`: it could not be kept.
pub(crate) async fn capture(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, source: Source<'_>) -> Result<Option<(String, bool)>, String> {
    let local = crate::raw_message::local_message(state, account_id, mailbox, uid, false).await.ok().flatten();
    let (raw, server_flags) = match local {
        Some(raw) => (raw.to_vec(), None),
        None => match source {
            Source::Imap(config) => {
                let mb = mailbox.to_string();
                let fetch = state.imap_pool.run_read(config, true, |mut session| {
                    let mb = mb.clone();
                    async move {
                        let email = imap::fetch_email_by_uid_light(&mut session, &mb, uid).await?;
                        Ok((email, session, Some(mb)))
                    }
                });
                match tokio::time::timeout(crate::handlers::imap::BODY_FETCH_TIMEOUT, fetch).await {
                    Ok(Ok(Some(email))) if email.uid == uid => (email.raw_source_bytes, Some(email.flags)),
                    // Gone already: a retry of a delete that landed finds the
                    // copy its first attempt kept.
                    Ok(Ok(_)) => return kept_already(state, account_id, mailbox, uid).await,
                    Ok(Err(e)) => return Err(e),
                    Err(_) => return Err(format!("timed out after {}s", crate::handlers::imap::BODY_FETCH_TIMEOUT.as_secs())),
                }
            }
            Source::Graph(client, message_id) => (client.get_mime_content(message_id).await?, None),
            Source::Local => return Ok(None),
        },
    };
    let state = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    blocking(move || {
        // The row the list showed, else one parsed from the message itself.
        let listed = crate::custody::with_conn(&state, |c| cache::load_by_uids(c, &account_id, &mailbox, &[uid]))
            .ok()
            .and_then(|rows| rows.into_iter().next());
        let row = listed
            .or_else(|| vault_eml::light_row_json(&raw, uid).and_then(|r| serde_json::from_str(&r).ok()))
            .unwrap_or_else(|| json!({ "uid": uid }));
        let flags: Vec<String> = server_flags.unwrap_or_else(|| {
            row.get("flags").and_then(Value::as_array).map(|a| a.iter().filter_map(|f| f.as_str().map(str::to_string)).collect()).unwrap_or_default()
        });
        let message_id = row.get("messageId").or_else(|| row.get("message_id")).and_then(Value::as_str).map(str::to_string);
        let c = Capture { account_id: &account_id, mailbox: &mailbox, uid, message_id: message_id.as_deref(), flags: &flags, row: &row, deleted_at: now_ms() };
        app_db::with(&state.app_dir, |conn| bin::capture(conn, &state.app_dir, &c, &raw))
    })
    .await
    .and_then(|r| r)
    .map(Some)
}

/// The bin copy an earlier attempt of this delete kept, if any.
async fn kept_already(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<(String, bool)>, String> {
    let state = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    blocking(move || app_db::with(&state.app_dir, |c| bin::find(c, &state.app_dir, &account_id, &mailbox, uid)))
        .await
        .and_then(|r| r)
        .map(|id| id.map(|id| (id, false)))
}

/// The delete it was captured for did not happen: a failed delete is
/// retried, and its retry captures again.
pub(crate) async fn forget(state: &Arc<DaemonState>, id: String) {
    let state = Arc::clone(state);
    let result = blocking(move || app_db::with(&state.app_dir, |c| bin::remove(c, &state.app_dir, &id))).await.and_then(|r| r);
    if let Err(e) = result {
        warn!("[deleted] could not drop the capture of a failed delete: {e}");
    }
}

/// Where the delete put the message, for a recover to move it back from.
pub(crate) async fn landed(state: &Arc<DaemonState>, id: String, trash: Option<String>, trash_uid: Option<u32>) {
    let state = Arc::clone(state);
    let result = blocking(move || app_db::with(&state.app_dir, |c| bin::set_trash(c, &id, trash.as_deref(), trash_uid))).await.and_then(|r| r);
    if let Err(e) = result {
        warn!("[deleted] could not record where a delete put the message: {e}");
    }
}

/// The vault's Maildir flags for a recovered copy: kept (`archived`), plus
/// the server's read, star and answered state.
fn vault_flags(flags: &[String]) -> Vec<String> {
    let mut out = vec!["archived".to_string()];
    for f in flags {
        match f.to_ascii_lowercase().as_str() {
            "\\seen" | "seen" => out.push("seen".into()),
            "\\flagged" | "flagged" => out.push("flagged".into()),
            "\\answered" | "replied" => out.push("replied".into()),
            "\\draft" | "draft" => out.push("draft".into()),
            _ => {}
        }
    }
    out
}

fn bare_message_id(d: &Deleted) -> Option<String> {
    d.message_id.as_deref().map(|m| m.trim().trim_start_matches('<').trim_end_matches('>').to_string()).filter(|m| !m.is_empty())
}

/// Into the vault under the uid it had, kept and marked as deleted from the
/// server by this app, which is what custody reads as "your only copy".
async fn recover_local(state: &Arc<DaemonState>, d: Deleted) -> Result<Value, String> {
    let state = Arc::clone(state);
    blocking(move || {
        let raw = bin::read_eml(&state.app_dir, &d.id)?;
        with_mailbox_write(&state, &d.account_id, &d.mailbox, |root| {
            vault_files::store(&state.vault_registry, root, &d.account_id, &d.mailbox, d.uid, &raw, &vault_flags(&d.flags), true)
        })?;
        let mut entry = if d.row.is_object() { d.row.clone() } else { json!({}) };
        let obj = entry.as_object_mut().expect("object");
        obj.insert("uid".into(), json!(d.uid));
        obj.insert("flags".into(), json!(d.flags));
        obj.insert("message_id".into(), json!(d.message_id));
        obj.insert("source".into(), json!("local"));
        obj.insert("serverDeleted".into(), json!(true));
        crate::custody::with_conn(&state, |c| entries::upsert(c, &d.account_id, &d.mailbox, &[entry]))?;
        app_db::with(&state.app_dir, |c| bin::remove(c, &state.app_dir, &d.id))?;
        Ok(json!({ "id": d.id, "accountId": d.account_id, "mailbox": d.mailbox, "uid": d.uid }))
    })
    .await
    .and_then(|r| r)
}

/// Back on the server: moved out of Trash when the delete put it there and it
/// still is, else APPENDed to the folder it was deleted from.
async fn recover_server(state: &Arc<DaemonState>, d: Deleted) -> Result<Value, String> {
    let config = crate::raw_message::account_config(state, &d.account_id).await?;
    if config.oauth2_transport.as_deref() == Some("graph") {
        return Err("deletedBin.graphServerUnsupported".to_string());
    }
    let app_dir = state.app_dir.clone();
    let id = d.id.clone();
    let raw = blocking(move || bin::read_eml(&app_dir, &id)).await.and_then(|r| r)?;
    let flags = d.flags.iter().filter(|f| !matches!(f.to_ascii_lowercase().as_str(), "\\deleted" | "\\recent")).cloned().collect::<Vec<_>>().join(" ");
    let message_id = bare_message_id(&d);
    let (pool, cfg) = (&state.imap_pool, &config);
    let (trash, mailbox) = (d.trash.clone(), d.mailbox.clone());
    let new_uid = crate::handlers::imap::with_priority(pool, cfg, |mut session| async move {
        if let (Some(trash), Some(mid)) = (trash.as_deref(), message_id.as_deref()) {
            imap::select_mailbox(&mut session, trash).await?;
            if let Some(in_trash) = imap::uid_of_message_id(&mut session, mid).await? {
                let has_move = pool.has_capability(cfg, "MOVE").await;
                let has_uidplus = pool.has_capability(cfg, "UIDPLUS").await;
                let moved = imap::move_uids(&mut session, trash, &mailbox, &[in_trash], has_move, has_uidplus).await?;
                return Ok((moved.new_uids.and_then(|u| u.first().copied()), session, Some(trash.to_string())));
            }
        }
        let (_, _, found) = imap::append_email_verified(&mut session, &mailbox, &raw, &flags, message_id.as_deref(), None).await?;
        Ok((found, session, Some(mailbox)))
    })
    .await?;

    // A kept vault copy is filed under the uid the delete retired, and
    // custody says the server lost it. Re-file it under the new uid, or it
    // renders as a second, "only copy" message beside the one just restored.
    if let Some(new_uid) = new_uid {
        let rebind = json!({ "accountId": d.account_id, "mailbox": d.mailbox, "pairs": [[d.uid, new_uid]] });
        let rebound = crate::handlers::custody::route(state, "vault_rebind_uids", &rebind, Value::Null).await;
        if rebound.and_then(|r| r.result).is_some_and(|r| r["rebound"].as_array().is_some_and(|a| !a.is_empty())) {
            let (st, acct, mb) = (Arc::clone(state), d.account_id.clone(), d.mailbox.clone());
            let restamped = blocking(move || {
                crate::custody::with_conn(&st, |c| {
                    let text = entries::read(c, &acct, &mb)?.unwrap_or_default();
                    let rows: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
                    let back: Vec<Value> = rows
                        .into_iter()
                        .filter(|e| entries::uid_of(e) == Some(new_uid))
                        .map(|mut e| {
                            e["serverDeleted"] = json!(false);
                            e
                        })
                        .collect();
                    entries::upsert(c, &acct, &mb, &back).map(|_| ())
                })
            })
            .await
            .and_then(|r| r);
            if let Err(e) = restamped {
                warn!("[deleted] recovered uid {new_uid}: vault copy still marked deleted: {e}");
            }
        }
    }

    let (app_dir, id) = (state.app_dir.clone(), d.id.clone());
    blocking(move || app_db::with(&app_dir, |c| bin::remove(c, &app_dir, &id))).await.and_then(|r| r)?;
    info!("[deleted] recovered {} to {}/{} (uid {:?})", d.id, d.account_id, d.mailbox, new_uid);
    Ok(json!({ "id": d.id, "accountId": d.account_id, "mailbox": d.mailbox, "uid": new_uid }))
}

/// One purge pass. Settings that cannot be read purge nothing: a pass that
/// cannot tell the retention must not guess a shorter one.
fn purge(state: &DaemonState) -> Result<usize, String> {
    let settings = crate::handlers::imap::read_settings_state(&state.app_dir)?;
    let days = bin::retention_days(&settings);
    app_db::with(&state.app_dir, |c| bin::purge_expired(c, &state.app_dir, now_ms(), days))
}

/// The hourly purge, on its own task; the work itself on the blocking pool.
pub(crate) fn start(state: Arc<DaemonState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(PURGE_EVERY);
        loop {
            ticker.tick().await;
            let st = Arc::clone(&state);
            match blocking(move || purge(&st)).await.and_then(|r| r) {
                Ok(0) => {}
                Ok(n) => info!("[deleted] purged {n} message(s) past their retention"),
                Err(e) => warn!("[deleted] purge skipped: {e}"),
            }
        }
    });
}

async fn get(state: &Arc<DaemonState>, id: String) -> Result<Deleted, String> {
    let st = Arc::clone(state);
    blocking(move || app_db::with(&st.app_dir, |c| bin::get(c, &id)))
        .await
        .and_then(|r| r)?
        .ok_or_else(|| "deletedBin.gone".to_string())
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        // Newest first, after a purge so nothing past its retention is offered.
        "deleted.list" => {
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || {
                    if let Err(e) = purge(&state) {
                        warn!("[deleted] purge before list skipped: {e}");
                    }
                    let rows = app_db::with(&state.app_dir, |c| bin::list(c, &state.app_dir))?;
                    serde_json::to_value(rows).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        // `target`: "server" | "local". Each id answers on its own.
        "deleted.recover" => {
            let ids = match vec_arg::<String>(&id, params, "ids") {
                Ok(v) => v,
                Err(resp) => return Some(resp),
            };
            let to_server = params.get("target").and_then(Value::as_str) != Some("local");
            let (mut recovered, mut failed) = (Vec::new(), Vec::new());
            for one in ids {
                let result = match get(state, one.clone()).await {
                    Ok(d) if to_server => recover_server(state, d).await,
                    Ok(d) => recover_local(state, d).await,
                    Err(e) => Err(e),
                };
                match result {
                    Ok(v) => recovered.push(v),
                    Err(e) => {
                        warn!("[deleted] recover {one} failed: {e}");
                        failed.push(json!({ "id": one, "error": e }));
                    }
                }
            }
            RpcResponse::success(id, json!({ "recovered": recovered, "failed": failed }))
        }
        // Delete now: gone from the bin for good.
        "deleted.discard" => {
            let ids = match vec_arg::<String>(&id, params, "ids") {
                Ok(v) => v,
                Err(resp) => return Some(resp),
            };
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || {
                    app_db::with(&state.app_dir, |c| {
                        for one in &ids {
                            bin::remove(c, &state.app_dir, one)?;
                        }
                        Ok(json!({ "discarded": ids.len() }))
                    })
                })
                .await
                .and_then(|r| r),
            )
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{Action, MockImap, Scenario, Trigger};

    const RAW: &str = "From: Ann <ann@example.com>\r\nTo: user@example.com\r\nSubject: Keep me\r\n\
                       Date: Thu, 01 Jan 2015 00:00:00 +0000\r\nMessage-ID: <keep1@example.com>\r\n\r\nThe body.\r\n";

    fn server(scenario: Scenario) -> MockImap {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
        MockImap::start(scenario.mailbox(inbox).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])))
    }

    fn account(server: &MockImap) -> Value {
        json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": server.host(), "imapPort": server.port()})
    }

    /// The vault root and the app data dir are one directory here, as in a
    /// default install: the bin sits beside `Maildir`, never inside it.
    fn state(server: &MockImap) -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-deleted-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = DaemonState::for_test(dir.clone(), dir, true);
        let config: ImapConfig = serde_json::from_value(account(server)).unwrap();
        s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), config);
        s
    }

    async fn delete(s: &Arc<DaemonState>, server: &MockImap, permanent: bool) -> RpcResponse {
        handle_request_for_test(s, "imap_delete_email", json!({"account": account(server), "uid": 1, "mailbox": "INBOX", "permanent": permanent})).await
    }

    fn binned(s: &DaemonState) -> Vec<Deleted> {
        app_db::with(&s.app_dir, |c| bin::list(c, &s.app_dir)).unwrap()
    }

    fn uids(server: &MockImap, mailbox: &str) -> Vec<u32> {
        server.state().find(mailbox).unwrap().messages.iter().map(|m| m.uid).collect()
    }

    #[tokio::test]
    async fn a_permanent_delete_keeps_the_servers_exact_message_first() {
        let server = server(Scenario::new());
        let s = state(&server);
        let result = delete(&s, &server, true).await.result.expect("deleted");
        assert!(uids(&server, "INBOX").is_empty());
        let rows = binned(&s);
        assert_eq!(rows.len(), 1);
        assert_eq!(result["binId"], json!(rows[0].id));
        assert_eq!(bin::read_eml(&s.app_dir, &rows[0].id).unwrap(), RAW.as_bytes());
        assert_eq!((rows[0].mailbox.as_str(), rows[0].uid, rows[0].flags.clone()), ("INBOX", 1, vec!["\\Seen".to_string()]));
        assert_eq!(rows[0].row["subject"], json!("Keep me"));
        // Beside the vault, never in it: no vault file, no folder, no header row.
        assert!(!bin::bin_dir(&s.app_dir).starts_with(s.data_dir.join("Maildir")));
        assert_eq!(s.vault_registry.uid_sets(&s.data_dir, "acc1", "INBOX").map(|(all, _)| all).unwrap_or_default(), Vec::<u32>::new());
        let folders = crate::custody::with_conn(&s, |c| cache::mailboxes_with_headers(c, None)).unwrap();
        assert!(folders.is_empty(), "{folders:?}");
    }

    #[tokio::test]
    async fn a_message_the_vault_holds_is_binned_without_downloading_it() {
        let server = server(Scenario::new());
        let s = state(&server);
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 1, RAW.as_bytes(), &[], false)).unwrap();
        let result = delete(&s, &server, false).await.result.expect("deleted");
        assert_eq!(server.count_commands("BODY.PEEK[]"), 0, "the vault copy is the capture");
        let rows = binned(&s);
        assert_eq!(result["binId"], json!(rows[0].id));
        assert_eq!(rows[0].trash.as_deref(), Some("Trash"), "where the delete put it is recorded");
    }

    #[tokio::test]
    async fn a_permanent_delete_that_errors_keeps_its_copy_for_the_retry() {
        // The mock still runs a command it answers NO to: the EXPUNGE lands
        // and its reply says it failed, the case a lost reply produces.
        let server = server(Scenario::new().fault(Trigger::on("EXPUNGE"), Action::Respond("NO".into(), "no".into())));
        let s = state(&server);
        assert!(delete(&s, &server, true).await.error.is_some());
        assert!(uids(&server, "INBOX").is_empty());
        let kept = binned(&s);
        assert_eq!(kept.len(), 1, "the only copy left");
        // The retry finds nothing on the server and reuses the copy.
        let _ = delete(&s, &server, true).await;
        assert_eq!(binned(&s).into_iter().map(|d| d.id).collect::<Vec<_>>(), vec![kept[0].id.clone()]);
    }

    #[tokio::test]
    async fn a_move_to_trash_that_errors_drops_its_copy() {
        let server = server(Scenario::new().fault(Trigger::on("MOVE"), Action::Respond("NO".into(), "no".into())).fault(Trigger::on("COPY"), Action::Respond("NO".into(), "no".into())));
        let s = state(&server);
        assert!(delete(&s, &server, false).await.error.is_some());
        assert!(binned(&s).is_empty(), "Trash or the folder still holds it, and the retry captures again");
    }

    #[tokio::test]
    async fn a_delete_opted_out_of_the_bin_keeps_nothing() {
        let server = server(Scenario::new());
        let s = state(&server);
        let r = handle_request_for_test(&s, "imap_delete_email", json!({"account": account(&server), "uid": 1, "mailbox": "INBOX", "permanent": true, "bin": false})).await;
        assert_eq!(r.result.expect("deleted")["binId"], Value::Null);
        assert!(binned(&s).is_empty());
    }

    async fn recover(s: &Arc<DaemonState>, target: &str) -> Value {
        let ids: Vec<String> = binned(s).into_iter().map(|d| d.id).collect();
        handle_request_for_test(s, "deleted.recover", json!({"ids": ids, "target": target})).await.result.expect("answered")
    }

    #[tokio::test]
    async fn recover_to_server_moves_it_back_out_of_trash() {
        let server = server(Scenario::new());
        let s = state(&server);
        delete(&s, &server, false).await.result.expect("deleted");
        assert_eq!(uids(&server, "Trash").len(), 1);
        let out = recover(&s, "server").await;
        assert_eq!(out["failed"], json!([]));
        assert!(uids(&server, "Trash").is_empty(), "moved, not copied");
        assert_eq!(uids(&server, "INBOX").len(), 1);
        assert_eq!(server.count_commands("APPEND"), 0);
        assert!(binned(&s).is_empty());
    }

    #[tokio::test]
    async fn recover_to_server_appends_what_no_folder_holds_any_more() {
        let server = server(Scenario::new());
        let s = state(&server);
        delete(&s, &server, true).await.result.expect("deleted");
        let out = recover(&s, "server").await;
        assert_eq!(out["failed"], json!([]));
        let inbox = server.state().find("INBOX").unwrap().messages.clone();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].raw, RAW.as_bytes());
        assert!(inbox[0].has_flag("\\Seen"), "the flags go back with it");
        assert!(binned(&s).is_empty());
    }

    #[tokio::test]
    async fn recover_locally_keeps_it_in_the_vault_as_a_copy_the_server_lost() {
        let server = server(Scenario::new());
        let s = state(&server);
        delete(&s, &server, true).await.result.expect("deleted");
        let out = recover(&s, "local").await;
        assert_eq!(out["recovered"][0]["uid"], json!(1));
        let name = s.vault_registry.known("acc1", "INBOX", 1).flatten().expect("a vault file");
        assert!(name.contains('A') && name.contains('S'), "kept and read: {name}");
        let text = crate::custody::with_conn(&s, |c| entries::read(c, "acc1", "INBOX")).unwrap().unwrap();
        let rows: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert_eq!(rows[0]["serverDeleted"], json!(true));
        assert!(uids(&server, "INBOX").is_empty(), "nothing went back to the server");
        assert!(binned(&s).is_empty());
    }

    #[tokio::test]
    async fn list_purges_what_is_past_the_retention() {
        let server = server(Scenario::new());
        let s = state(&server);
        std::fs::write(s.app_dir.join("frontend-settings.json"), json!({"mailvault-settings": {"state": {"deletedRetentionDays": 1}}}).to_string()).unwrap();
        delete(&s, &server, true).await.result.expect("deleted");
        let listed = handle_request_for_test(&s, "deleted.list", json!({})).await.result.unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        app_db::with(&s.app_dir, |c| c.execute("UPDATE deleted_messages SET deleted_at = deleted_at - 2 * 86400000", []).map_err(|e| e.to_string())).unwrap();
        let listed = handle_request_for_test(&s, "deleted.list", json!({})).await.result.unwrap();
        assert_eq!(listed, json!([]));
    }
}
