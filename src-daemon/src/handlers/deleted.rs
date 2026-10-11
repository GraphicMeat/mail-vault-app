//! The deleted-mail bin (`mailvault_core::app_db::deleted`): capture before a
//! delete, recover, discard, and the hourly purge.
//!
//! `capture` runs inside the delete routes (`imap_delete_email`,
//! `bulk_delete_emails`, `graph_delete_message`, `maildir_delete` for a
//! local-only message) before anything is removed. The bytes come from the
//! vault or the in-memory copy when there is one (the original, never a
//! decrypted copy). Past that only a permanent delete downloads them, since
//! nothing else will hold them, without keeping a vault copy of a message
//! that is about to go. A move to Trash with no local copy is recorded
//! byte-less: Trash holds it, and a bulk delete must not become a bulk
//! download. A JMAP account's delete downloads them either way
//! (`Source::Jmap`): its recover imports the bytes back, and a delete that
//! only takes a label off leaves no Trash copy to find. The bin sits beside
//! app.db, never in the vault.
//!
//! `deleted.recover` puts a message back on the server (moved back out of the
//! Trash folder the delete put it in, when it is still there; else APPENDed
//! to the folder it came from) or into the vault as a local copy the user
//! keeps. Graph accounts recover locally only: the daemon holds no Graph
//! token.
//!
//! A JMAP account recovers over its session, never IMAP
//! (`recover_on_jmap`). Its mail is label-like, so the email often still
//! exists: a delete that took one label off, or moved it to Trash. Found by
//! its exact Message-ID, it gets the original mailbox's label back (and
//! Trash's off), under the uid the ledger issued it before. Destroyed, the
//! bin's bytes are imported into the original mailbox
//! (`JmapSessions::import_raw`), which is made again when it is gone.
use crate::handlers::common::{blocking, done, vec_arg, with_mailbox_write};
use crate::imap::{self, ImapConfig};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::app_db::{self, deleted::{self as bin, Capture, Deleted}};
use mailvault_core::custody::{cache, entries};
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::{local_folder, vault_eml, vault_files};
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
    /// `permanent`: the server keeps nothing, so the bytes are downloaded
    /// when nothing local holds them. `priority`: the user's lane (a click),
    /// else the background lane (a bulk run).
    Imap { config: &'a ImapConfig, permanent: bool, priority: bool },
    /// Moved to Deleted Items. Only local bytes are kept: the daemon holds no
    /// Graph token to fetch the Deleted Items copy back, so a byte-less row
    /// could never be recovered.
    Graph,
    /// A JMAP account (`handlers::jmap_bridge`): the bytes are downloaded
    /// (blob download) whenever nothing local holds them, permanent or not.
    /// Its recover imports them back (`Email/import`), and a delete that only
    /// takes a label off leaves no Trash copy to find.
    Jmap { config: &'a ImapConfig },
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
        Some(raw) => (Some(raw.to_vec()), None),
        None => match source {
            Source::Imap { permanent: false, .. } => (None, None),
            Source::Imap { config, priority, .. } => {
                let mb = mailbox.to_string();
                let fetch = state.imap_pool.run_read(config, priority, |mut session| {
                    let mb = mb.clone();
                    async move {
                        let email = imap::fetch_email_by_uid_light(&mut session, &mb, uid).await?;
                        Ok((email, session, Some(mb)))
                    }
                });
                match tokio::time::timeout(crate::handlers::imap::BODY_FETCH_TIMEOUT, fetch).await {
                    Ok(Ok(Some(email))) if email.uid == uid => (Some(email.raw_source_bytes), Some(email.flags)),
                    // Gone already: a retry of a delete that landed finds the
                    // copy its first attempt kept.
                    Ok(Ok(_)) => return kept_already(state, account_id, mailbox, uid).await,
                    Ok(Err(e)) => return Err(e),
                    Err(_) => return Err(format!("timed out after {}s", crate::handlers::imap::BODY_FETCH_TIMEOUT.as_secs())),
                }
            }
            Source::Jmap { config } => match crate::handlers::jmap_bridge::fetch_for_capture(state, config, account_id, mailbox, uid).await {
                Ok(Some((raw, flags))) => (Some(raw), Some(flags)),
                // Gone already: a retry of a delete that landed finds the
                // copy its first attempt kept.
                Ok(None) => return kept_already(state, account_id, mailbox, uid).await,
                Err(e) => return Err(e),
            },
            Source::Graph | Source::Local => return Ok(None),
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
            .or_else(|| raw.as_deref().and_then(|raw| vault_eml::light_row_json(raw, uid)).and_then(|r| serde_json::from_str(&r).ok()))
            .unwrap_or_else(|| json!({ "uid": uid }));
        let flags: Vec<String> = server_flags.unwrap_or_else(|| {
            row.get("flags").and_then(Value::as_array).map(|a| a.iter().filter_map(|f| f.as_str().map(str::to_string)).collect()).unwrap_or_default()
        });
        let message_id = row.get("messageId").or_else(|| row.get("message_id")).and_then(Value::as_str).map(str::to_string);
        // Byte-less, the Message-ID is the only way back to the Trash copy.
        if raw.is_none() && message_id.is_none() {
            return Ok(None);
        }
        let c = Capture { account_id: &account_id, mailbox: &mailbox, uid, message_id: message_id.as_deref(), flags: &flags, row: &row, deleted_at: now_ms() };
        app_db::with(&state.app_dir, |conn| bin::capture(conn, &state.app_dir, &c, raw.as_deref())).map(Some)
    })
    .await
    .and_then(|r| r)
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

/// Whether the account's `mailbox` can only have been a vault-only (local)
/// folder: the cached folder list is known and has no folder of that name or
/// dir, and the header cache has never held a row or a count for it. Anything
/// unknown reads as no, so a server folder is never taken for a local one.
fn no_server_folder(state: &Arc<DaemonState>, account_id: &str, mailbox: &str) -> bool {
    let Ok(Some(listing)) = crate::handlers::cache::load_mailbox_listing(state, account_id) else { return false };
    let dir = vault_dir_name(mailbox);
    if mailvault_core::takeout::folder_refs_from_listing(&listing).iter().any(|f| f.path == mailbox || f.dir == dir) {
        return false;
    }
    crate::custody::with_conn(state, |c| Ok(cache::sync_meta(c, account_id, mailbox)? == (None, None) && cache::count(c, account_id, mailbox)? == 0))
        .unwrap_or(false)
}

/// A local folder's marker, written again when a recover brings mail back
/// into the folder after it was deleted: without it the mail lands in a dir
/// no view lists. A folder that still has its marker (or one that will not
/// read) is left as it is.
fn mark_local_folder_again(root: &std::path::Path, account_id: &str, mailbox: &str) {
    let account_dir = vault_files::account_dir(&root.join("Maildir"), account_id);
    let dir = vault_dir_name(mailbox);
    if !matches!(local_folder::read_marker(&account_dir, &dir), Ok(None)) {
        return;
    }
    let marker = local_folder::Marker {
        kind: local_folder::KIND_IMPORT.to_string(),
        name: mailbox.to_string(),
        created: mailvault_core::vault_layout::now_millis(),
        source: "recovered".to_string(),
    };
    match local_folder::write_marker(&account_dir.join(&dir), &marker) {
        Ok(()) => info!("[deleted] a recover brought back the local folder {dir} of {account_id}"),
        Err(e) => warn!("[deleted] the local folder {dir} of {account_id} was not marked again: {e}"),
    }
}

/// Into the vault under the uid it had, kept and marked as deleted from the
/// server by this app, which is what custody reads as "your only copy". A
/// message of a local folder the user has since deleted brings that folder
/// back, marked, so it lists again.
async fn recover_local(state: &Arc<DaemonState>, d: Deleted) -> Result<Value, String> {
    let fetched = if d.has_eml { None } else { Some(from_trash(state, &d).await?) };
    let state = Arc::clone(state);
    blocking(move || {
        let raw = match fetched {
            Some(raw) => raw,
            None => bin::read_eml(&state.app_dir, &d.id)?,
        };
        // Custody and the folder list are read before the mailbox lock.
        let local_only = no_server_folder(&state, &d.account_id, &d.mailbox);
        with_mailbox_write(&state, &d.account_id, &d.mailbox, |root| {
            vault_files::store(&state.vault_registry, root, &d.account_id, &d.mailbox, d.uid, &raw, &vault_flags(&d.flags), true)?;
            if local_only {
                mark_local_folder_again(root, &d.account_id, &d.mailbox);
            }
            Ok(())
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

/// The server credentials a recover uses; a Graph account has none here.
async fn imap_config(state: &Arc<DaemonState>, account_id: &str) -> Result<ImapConfig, String> {
    let config = crate::raw_message::account_config(state, account_id).await?;
    if config.oauth2_transport.as_deref() == Some("graph") {
        return Err("deletedBin.graphServerUnsupported".to_string());
    }
    Ok(config)
}

/// A byte-less row's bytes, read from the Trash copy the delete left.
async fn from_trash(state: &Arc<DaemonState>, d: &Deleted) -> Result<Vec<u8>, String> {
    let config = imap_config(state, &d.account_id).await?;
    let (Some(trash), Some(mid)) = (d.trash.clone(), bare_message_id(d)) else {
        return Err("deletedBin.goneFromTrash".to_string());
    };
    if config.uses_jmap() {
        return from_trash_jmap(state, &config, &trash, &mid).await;
    }
    let fetched = crate::handlers::imap::with_priority(&state.imap_pool, &config, |mut session| async move {
        imap::select_mailbox(&mut session, &trash).await?;
        let raw = match imap::uid_of_message_id(&mut session, &mid).await? {
            Some(in_trash) => imap::fetch_email_by_uid_light(&mut session, &trash, in_trash).await?.map(|e| e.raw_source_bytes),
            None => None,
        };
        Ok((raw, session, Some(trash)))
    });
    match tokio::time::timeout(crate::handlers::imap::BODY_FETCH_TIMEOUT, fetched).await {
        Ok(Ok(Some(raw))) => Ok(raw),
        Ok(Ok(None)) => Err("deletedBin.goneFromTrash".to_string()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("timed out after {}s", crate::handlers::imap::BODY_FETCH_TIMEOUT.as_secs())),
    }
}

/// Back on the server: moved out of Trash when the delete put it there and it
/// still is, else APPENDed to the folder it was deleted from. A byte-less row
/// has only the Trash copy: gone from there, it cannot come back.
async fn recover_server(state: &Arc<DaemonState>, d: Deleted) -> Result<Value, String> {
    let config = imap_config(state, &d.account_id).await?;
    let new_uid = if config.uses_jmap() {
        recover_on_jmap(state, &d, &config).await?
    } else {
        recover_on_imap(state, &d, &config).await?
    };

    // A kept vault copy is filed under the uid the delete retired, and
    // custody says the server lost it. Re-file it under the new uid, or it
    // renders as a second, "only copy" message beside the one just restored.
    // A JMAP label put back keeps the uid it had (ledger rows are never
    // removed): the copy is filed right already, only its stamp is wrong.
    if let Some(new_uid) = new_uid {
        let refiled = new_uid == d.uid || {
            let rebind = json!({ "accountId": d.account_id, "mailbox": d.mailbox, "pairs": [[d.uid, new_uid]] });
            let rebound = crate::handlers::custody::route(state, "vault_rebind_uids", &rebind, Value::Null).await;
            rebound.and_then(|r| r.result).is_some_and(|r| r["rebound"].as_array().is_some_and(|a| !a.is_empty()))
        };
        if refiled {
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

/// `recover_server` on an IMAP account: moved back out of Trash when the
/// delete put it there and it still is, else APPENDed to the folder it was
/// deleted from. Returns the uid the server gave it, when it said.
async fn recover_on_imap(state: &Arc<DaemonState>, d: &Deleted, config: &ImapConfig) -> Result<Option<u32>, String> {
    let raw = if d.has_eml {
        let (app_dir, id) = (state.app_dir.clone(), d.id.clone());
        Some(blocking(move || bin::read_eml(&app_dir, &id)).await.and_then(|r| r)?)
    } else {
        None
    };
    let flags = d.flags.iter().filter(|f| !matches!(f.to_ascii_lowercase().as_str(), "\\deleted" | "\\recent")).cloned().collect::<Vec<_>>().join(" ");
    let message_id = bare_message_id(d);
    let (pool, cfg) = (&state.imap_pool, config);
    let (trash, mailbox) = (d.trash.clone(), d.mailbox.clone());
    crate::handlers::imap::with_priority(pool, cfg, |mut session| async move {
        if let (Some(trash), Some(mid)) = (trash.as_deref(), message_id.as_deref()) {
            imap::select_mailbox(&mut session, trash).await?;
            if let Some(in_trash) = imap::uid_of_message_id(&mut session, mid).await? {
                let has_move = pool.has_capability(cfg, "MOVE").await;
                let has_uidplus = pool.has_capability(cfg, "UIDPLUS").await;
                let moved = imap::move_uids(&mut session, trash, &mailbox, &[in_trash], has_move, has_uidplus).await?;
                return Ok((moved.new_uids.and_then(|u| u.first().copied()), session, Some(trash.to_string())));
            }
        }
        let Some(raw) = raw else { return Err("deletedBin.goneFromTrash".to_string()) };
        let (_, _, found) = imap::append_email_verified(&mut session, &mailbox, &raw, &flags, message_id.as_deref(), None).await?;
        Ok((found, session, Some(mailbox)))
    })
    .await
}

/// `recover_server` on a JMAP account (`uses_jmap`), over its session:
/// - The email still exists (a label taken off, or moved to Trash), found by
///   its exact Message-ID anywhere in the account: the original mailbox's
///   label goes back on and Trash's comes off, one `mailboxIds` patch.
/// - It is gone: the bin's bytes are imported into the original mailbox with
///   the captured flags as keywords and the message's own Date as
///   `receivedAt` (`JmapSessions::import_raw`: deduped by Message-ID, the new
///   id recorded as this daemon's own, so the sync never announces it).
///   A byte-less row has nothing to import (`deletedBin.goneFromTrash`).
///
/// The original mailbox is made again when it is gone
/// (`migration::ensure_dest_folder_jmap`). Returns the uid the mailbox's
/// ledger gives the email: the old one for a label put back.
async fn recover_on_jmap(state: &Arc<DaemonState>, d: &Deleted, config: &ImapConfig) -> Result<Option<u32>, String> {
    crate::handlers::jmap_bridge::with_session_retry(state, config, |acct| recover_jmap_once(state, d, config, acct)).await
}

/// One pass of `recover_on_jmap` on `acct`. Safe to run twice: a second pass
/// finds the email the first one put back (or imported) and relabels it again.
async fn recover_jmap_once(state: &Arc<DaemonState>, d: &Deleted, config: &ImapConfig, acct: Arc<crate::jmap_sessions::AccountJmap>) -> Result<Option<u32>, String> {
    use mailvault_core::jmap::ImportResult;
    let mailbox_id = crate::migration::ensure_dest_folder_jmap(&acct, &d.mailbox).await.map_err(|e| e.to_string())?;
    let boxes = acct.current().await.map_err(|e| e.to_string())?;
    let trash_id = crate::handlers::jmap_bridge::role_mailbox(&boxes, "trash").map(|(_, id)| id).filter(|t| *t != mailbox_id);
    let existing = match d.message_id.as_deref() {
        Some(mid) => crate::handlers::jmap_bridge::emails_with_message_id(&acct.client, None, mid).await.map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    let email_id = match existing.into_iter().next() {
        Some(id) => {
            put_back(&acct, &id, &mailbox_id, trash_id, &d.mailbox).await?;
            id
        }
        None => {
            if !d.has_eml {
                return Err("deletedBin.goneFromTrash".to_string());
            }
            let (app_dir, bin_id) = (state.app_dir.clone(), d.id.clone());
            let raw = blocking(move || bin::read_eml(&app_dir, &bin_id)).await.and_then(|r| r)?;
            let keywords = mailvault_core::jmap::headers::flags_to_keywords(d.flags.iter().map(String::as_str));
            let received_at = mailvault_core::jmap::client::received_at_of(&raw);
            match state.jmap.import_raw_on(config, &acct, &raw, &mailbox_id, &keywords, received_at.as_deref()).await.map_err(|e| e.to_string())? {
                ImportResult::Created(imported) => imported.id,
                // The server held the message already (a copy another client
                // or an earlier pass made): it may sit in another mailbox, so
                // it gets the label back like an email found by Message-ID.
                ImportResult::AlreadyExists { existing_id } => {
                    put_back(&acct, &existing_id, &mailbox_id, trash_id, &d.mailbox).await?;
                    existing_id
                }
            }
        }
    };
    let uids = acct.ids_to_uids(state, &d.account_id, &d.mailbox, &[email_id]).await?;
    Ok(uids.first().copied())
}

/// One `mailboxIds` patch: `mailbox_id`'s label on, Trash's off.
async fn put_back(acct: &crate::jmap_sessions::AccountJmap, id: &str, mailbox_id: &str, trash_id: Option<String>, mailbox: &str) -> Result<(), String> {
    let mut toggles = vec![(mailbox_id.to_string(), true)];
    toggles.extend(trash_id.map(|t| (t, false)));
    let out = acct.client.set_mailboxes(&[(id.to_string(), toggles)]).await.map_err(|e| e.to_string())?;
    if !out.ok.iter().any(|ok| ok == id) {
        let kind = out.failed.iter().find(|(f, _)| f == id).map_or("serverFail", |(_, k)| k.as_str());
        return Err(format!("E_JMAP_METHOD: {kind}: {id} was not put back in {mailbox}"));
    }
    Ok(())
}

/// A byte-less row's bytes on a JMAP account: the email in `trash` whose
/// Message-ID is `mid`, by blob download. An expired session reconnects once.
async fn from_trash_jmap(state: &Arc<DaemonState>, config: &ImapConfig, trash: &str, mid: &str) -> Result<Vec<u8>, String> {
    crate::handlers::jmap_bridge::with_session_retry(state, config, |acct| async move {
        let gone = || "deletedBin.goneFromTrash".to_string();
        let boxes = acct.current().await.map_err(|e| e.to_string())?;
        let trash_id = boxes.ids.get(trash).ok_or_else(gone)?;
        let found = crate::handlers::jmap_bridge::emails_with_message_id(&acct.client, Some(trash_id), mid).await.map_err(|e| e.to_string())?;
        let email_id = found.into_iter().next().ok_or_else(gone)?;
        let got = acct.client.get_emails(&[email_id], &["id", "blobId"]).await.map_err(|e| e.to_string())?;
        let blob = got.list.first().and_then(|e| e["blobId"].as_str()).ok_or_else(gone)?;
        tokio::time::timeout(crate::handlers::imap::BODY_FETCH_TIMEOUT, acct.client.download(blob))
            .await
            .map_err(|_| format!("timed out after {}s", crate::handlers::imap::BODY_FETCH_TIMEOUT.as_secs()))?
            .map_err(|e| e.to_string())
    })
    .await
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
        // The list row the app showed, as a sync leaves it.
        let headers = json!({"emails": [{"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]}]}).to_string();
        crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();
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
        // Beside the vault, never in it: no vault file, no folder of its own.
        assert!(!bin::bin_dir(&s.app_dir).starts_with(s.data_dir.join("Maildir")));
        assert_eq!(s.vault_registry.uid_sets(&s.data_dir, "acc1", "INBOX").map(|(all, _)| all).unwrap_or_default(), Vec::<u32>::new());
        let folders = crate::custody::with_conn(&s, |c| cache::mailboxes_with_headers(c, None)).unwrap();
        assert_eq!(folders, vec![("acc1".to_string(), "INBOX".to_string())], "only the folder the sync listed");
    }

    #[tokio::test]
    async fn a_move_to_trash_with_no_local_copy_downloads_nothing_and_still_records_it() {
        let server = server(Scenario::new());
        let s = state(&server);
        let result = delete(&s, &server, false).await.result.expect("deleted");
        assert_eq!(server.count_commands("BODY.PEEK[]"), 0, "a bulk delete must not become a bulk download");
        let rows = binned(&s);
        assert_eq!(rows.len(), 1);
        assert_eq!(result["binId"], json!(rows[0].id));
        assert!(!rows[0].has_eml, "Trash holds the only copy");
        assert_eq!(rows[0].message_id.as_deref(), Some("<keep1@example.com>"));
        assert_eq!(rows[0].trash.as_deref(), Some("Trash"));
        assert_eq!(rows[0].row["subject"], json!("Keep me"), "the list row the header cache held");
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
    async fn a_bulk_delete_keeps_each_message_before_expunging_it() {
        let bulk = |srv: &MockImap, bin: bool| json!({"accountId": "acc1", "accountJson": account(srv).to_string(), "mailbox": "INBOX", "uids": [1], "bin": bin});
        let kept = server(Scenario::new());
        let s = state(&kept);
        let r = handle_request_for_test(&s, "bulk_delete_emails", bulk(&kept, true)).await.result.expect("ran");
        assert_eq!((r["completed"].clone(), r["errors"].clone()), (json!(1), json!(0)));
        assert!(uids(&kept, "INBOX").is_empty());
        let rows = binned(&s);
        assert_eq!(rows.len(), 1);
        assert_eq!(bin::read_eml(&s.app_dir, &rows[0].id).unwrap(), RAW.as_bytes());

        // Archive-and-delete opts out: its vault copies were verified first.
        let skipped = server(Scenario::new());
        let s = state(&skipped);
        handle_request_for_test(&s, "bulk_delete_emails", bulk(&skipped, false)).await.result.expect("ran");
        assert!(binned(&s).is_empty());
        assert_eq!(skipped.count_commands("BODY.PEEK[]"), 0);
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
        assert!(!binned(&s)[0].has_eml, "the byte-less row, Trash is all it has");
        let out = recover(&s, "server").await;
        assert_eq!(out["failed"], json!([]));
        assert!(uids(&server, "Trash").is_empty(), "moved, not copied");
        assert_eq!(uids(&server, "INBOX").len(), 1);
        assert_eq!(server.count_commands("APPEND"), 0);
        assert!(binned(&s).is_empty());
    }

    #[tokio::test]
    async fn a_byte_less_row_gone_from_trash_says_so_and_stays() {
        let server = server(Scenario::new());
        let s = state(&server);
        delete(&s, &server, false).await.result.expect("deleted");
        server.mutate(|st| st.find_mut("Trash").unwrap().messages.clear());
        let out = recover(&s, "server").await;
        assert_eq!(out["failed"][0]["error"], json!("deletedBin.goneFromTrash"));
        let out = recover(&s, "local").await;
        assert_eq!(out["failed"][0]["error"], json!("deletedBin.goneFromTrash"));
        assert_eq!(binned(&s).len(), 1);
        assert_eq!(server.count_commands("APPEND"), 0);
    }

    #[tokio::test]
    async fn recover_locally_reads_a_byte_less_row_from_trash() {
        let server = server(Scenario::new());
        let s = state(&server);
        delete(&s, &server, false).await.result.expect("deleted");
        let out = recover(&s, "local").await;
        assert_eq!(out["failed"], json!([]));
        assert_eq!(server.count_commands("BODY.PEEK[]"), 1, "one download, at recover time, from Trash");
        let name = s.vault_registry.known("acc1", "INBOX", 1).flatten().expect("a vault file");
        let cur = vault_files::cur_path(&s.data_dir, "acc1", "INBOX");
        assert_eq!(std::fs::read(cur.join(name)).unwrap(), RAW.as_bytes());
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

    // ── JMAP (Task 9c) ─────────────────────────────────────────────────────

    /// A daemon whose recover reads the JMAP account `support::config`
    /// names, and the INBOX uids a listing issued (e1 then e2).
    async fn jmap_state(m: &mock_jmap::MockJmap, port: u16) -> (Arc<DaemonState>, u32, u32) {
        use crate::jmap_test_support as support;
        let dir = std::env::temp_dir().join(format!("mv-deleted-jmap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = DaemonState::for_test(dir.clone(), dir, true);
        s.raw_messages.accounts.lock().unwrap().insert("acct1".into(), support::config(m, port));
        let listing = handle_request_for_test(&s, "imap_get_emails", json!({"account": support::account_json(m, port), "mailbox": "INBOX", "page": 1, "limit": 50}))
            .await
            .result
            .expect("listed");
        let uid = |mid: &str| listing["emails"].as_array().unwrap().iter().find(|e| e["messageId"] == mid).unwrap()["uid"].as_u64().unwrap() as u32;
        let (e1, e2) = (uid("<e1@x>"), uid("<e2@x>"));
        (s, e1, e2)
    }

    fn jmap_labels(m: &mock_jmap::MockJmap, email_id: &str) -> std::collections::BTreeSet<String> {
        m.read(|st| st.email("acc1", email_id).map(|e| e.mailbox_ids.clone()).unwrap_or_default())
    }

    /// e1 sits in INBOX and Work. Deleted from INBOX it only lost that label;
    /// the recover puts the label back, under the uid it had, and imports
    /// nothing.
    #[tokio::test]
    async fn jmap_recover_puts_the_label_back_on_an_email_that_still_exists() {
        use crate::jmap_test_support as support;
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, e1, _) = jmap_state(&m, port).await;
        handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": e1, "mailbox": "INBOX", "permanent": false}))
            .await
            .result
            .expect("deleted");
        assert_eq!(jmap_labels(&m, "e1"), support::set(&["mb-work"]));
        assert!(binned(&s)[0].has_eml, "a JMAP capture keeps the bytes");

        let out = recover(&s, "server").await;

        assert_eq!(out["failed"], json!([]));
        assert_eq!(out["recovered"][0]["uid"], json!(e1), "the uid it had: ledger rows are never removed");
        assert_eq!(jmap_labels(&m, "e1"), support::set(&["mb-inbox", "mb-work"]));
        assert_eq!(m.count_calls("Email/import"), 0, "nothing imported: the email was there");
        assert!(binned(&s).is_empty());
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// e2 sits in INBOX alone: a permanent delete destroys it. The recover
    /// imports the bin's bytes back into INBOX under the message's own date,
    /// as this daemon's own (never announced as an arrival), and answers the
    /// uid the INBOX ledger gives the new email.
    #[tokio::test]
    async fn jmap_recover_imports_a_destroyed_email_into_its_mailbox() {
        use crate::jmap_test_support as support;
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, _, e2) = jmap_state(&m, port).await;
        handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": e2, "mailbox": "INBOX", "permanent": true}))
            .await
            .result
            .expect("deleted");
        assert!(m.read(|st| st.email("acc1", "e2").is_none()), "destroyed");

        let out = recover(&s, "server").await;

        assert_eq!(out["failed"], json!([]));
        let back = support::emails_in(&m, "mb-inbox").into_iter().find(|e| e.raw == support::raw("e2", "two")).expect("imported back into INBOX");
        assert_ne!(back.id, "e2", "a new email");
        assert_eq!(back.received_at, "2019-03-05T08:15:00Z", "its own Date");
        assert_eq!(m.count_calls("Email/import"), 1);
        let ledger = mailvault_core::graph_ledger::load(&crate::jmap_sessions::jmap_ledger_path(&s.data_dir, "acct1", "INBOX")).unwrap();
        let new_uid = ledger.iter().find(|(_, id)| **id == back.id).map(|(uid, _)| *uid).expect("a ledger uid");
        assert_eq!(out["recovered"][0]["uid"], json!(new_uid));
        assert!(s.jmap.is_own(&support::config(&m, port), &back.id), "never announced as an arrival");
        assert!(binned(&s).is_empty());
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// A byte-less row of a JMAP account recovers locally from the Trash copy,
    /// found by Message-ID and downloaded by blob, never over IMAP.
    #[tokio::test]
    async fn jmap_a_byte_less_row_recovers_locally_from_the_trash_copy() {
        use crate::jmap_test_support as support;
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, _, e2) = jmap_state(&m, port).await;
        m.mutate(|st| st.set_mailboxes("acc1", "e2", &["mb-trash"]));
        let row = json!({"uid": e2, "messageId": "<e2@x>"});
        let capture = Capture { account_id: "acct1", mailbox: "INBOX", uid: e2, message_id: Some("<e2@x>"), flags: &[], row: &row, deleted_at: now_ms() };
        let (id, _) = app_db::with(&s.app_dir, |c| bin::capture(c, &s.app_dir, &capture, None)).unwrap();
        app_db::with(&s.app_dir, |c| bin::set_trash(c, &id, Some("Trash"), None)).unwrap();

        let out = recover(&s, "local").await;

        assert_eq!(out["failed"], json!([]));
        let cur = vault_files::cur_path(&s.data_dir, "acct1", "INBOX");
        let kept = std::fs::read_dir(&cur)
            .unwrap()
            .flatten()
            .find(|e| mailvault_core::maildir::vault_filename_uid(&e.file_name().to_string_lossy()) == Some(e2))
            .expect("a vault file under the uid the row had");
        assert_eq!(std::fs::read(kept.path()).unwrap(), support::raw("e2", "two").as_bytes());
        assert_eq!(m.requests().iter().filter(|r| r.path.starts_with("/jmap/download/")).count(), 1);
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// A JMAP account's bulk delete (Task 9c), never the IMAP pool: each
    /// email into the bin with its bytes first, then the label semantics
    /// rule. e1 sits in INBOX and Work, so it loses only its INBOX label; e2
    /// sits in INBOX alone, so it is destroyed. Both uids count as deleted.
    #[tokio::test]
    async fn jmap_bulk_delete_applies_the_label_rule_and_keeps_the_bytes() {
        use crate::jmap_test_support as support;
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, e1, e2) = jmap_state(&m, port).await;

        let r = handle_request_for_test(
            &s,
            "bulk_delete_emails",
            json!({"accountId": "acct1", "accountJson": support::account_json(&m, port).to_string(), "mailbox": "INBOX", "uids": [e1, e2]}),
        )
        .await
        .result
        .expect("ran");

        assert_eq!((r["completed"].clone(), r["errors"].clone()), (json!(2), json!(0)), "{r}");
        assert_eq!(jmap_labels(&m, "e1"), support::set(&["mb-work"]), "e1 keeps its Work label");
        assert!(m.read(|st| st.email("acc1", "e2").is_none()), "e2 had no other label: destroyed");
        let rows = binned(&s);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|d| d.has_eml), "no byte-less capture: a label taken off leaves no Trash copy");
        let e2_row = rows.iter().find(|d| d.uid == e2).expect("e2 binned");
        assert_eq!(bin::read_eml(&s.app_dir, &e2_row.id).unwrap(), support::raw("e2", "two").as_bytes());
        assert!(trap.accept().is_err(), "no IMAP dial");
    }
    fn session_fetches(m: &mock_jmap::MockJmap) -> usize {
        m.requests().iter().filter(|r| r.path.starts_with("/jmap/session")).count()
    }

    /// The import dedupes to an email the account holds in another mailbox
    /// (the row has no Message-ID to find it by first): it gets the original
    /// mailbox's label too, or the recover would answer a uid the mailbox
    /// does not list.
    #[tokio::test]
    async fn jmap_recover_labels_the_copy_an_import_deduped_to() {
        use crate::jmap_test_support as support;
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, e1, _) = jmap_state(&m, port).await;
        m.mutate(|st| {
            st.set_mailboxes("acc1", "e1", &["mb-work"]);
            st.faults.push(mock_jmap::Fault::ImportAlreadyExists);
        });
        let row = json!({"uid": e1});
        let capture = Capture { account_id: "acct1", mailbox: "INBOX", uid: e1, message_id: None, flags: &[], row: &row, deleted_at: now_ms() };
        app_db::with(&s.app_dir, |c| bin::capture(c, &s.app_dir, &capture, Some(support::raw("e1", "one").as_bytes()))).unwrap();

        let out = recover(&s, "server").await;

        assert_eq!(out["failed"], json!([]));
        assert_eq!(m.count_calls("Email/import"), 1, "the dedupe came from the server");
        assert_eq!(jmap_labels(&m, "e1"), support::set(&["mb-inbox", "mb-work"]), "the copy carries the target mailbox");
        assert_eq!(out["recovered"][0]["uid"], json!(e1), "the uid the ledger issued it");
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// An expired session (the server answers 401 once): the recover forgets
    /// it, connects again once and succeeds.
    #[tokio::test]
    async fn jmap_recover_reconnects_once_on_an_expired_session() {
        use crate::jmap_test_support as support;
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, e1, _) = jmap_state(&m, port).await;
        handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": e1, "mailbox": "INBOX", "permanent": false}))
            .await
            .result
            .expect("deleted");
        let fetches = session_fetches(&m);
        m.mutate(|st| st.faults.push(mock_jmap::Fault::UnauthorizedOnce));

        let out = recover(&s, "server").await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(session_fetches(&m), fetches + 1, "exactly one reconnect");
        assert_eq!(jmap_labels(&m, "e1"), support::set(&["mb-inbox", "mb-work"]));
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// The same for a byte-less row's local recover (`from_trash_jmap`).
    #[tokio::test]
    async fn jmap_from_trash_reconnects_once_on_an_expired_session() {
        use crate::jmap_test_support as support;
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, _, e2) = jmap_state(&m, port).await;
        m.mutate(|st| st.set_mailboxes("acc1", "e2", &["mb-trash"]));
        let row = json!({"uid": e2, "messageId": "<e2@x>"});
        let capture = Capture { account_id: "acct1", mailbox: "INBOX", uid: e2, message_id: Some("<e2@x>"), flags: &[], row: &row, deleted_at: now_ms() };
        let (id, _) = app_db::with(&s.app_dir, |c| bin::capture(c, &s.app_dir, &capture, None)).unwrap();
        app_db::with(&s.app_dir, |c| bin::set_trash(c, &id, Some("Trash"), None)).unwrap();
        let fetches = session_fetches(&m);
        m.mutate(|st| st.faults.push(mock_jmap::Fault::UnauthorizedOnce));

        let out = recover(&s, "local").await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(session_fetches(&m), fetches + 1, "exactly one reconnect");
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// A bulk delete whose session expired before the first copy was kept:
    /// the capture connects again once, the run completes.
    #[tokio::test]
    async fn jmap_bulk_delete_reconnects_once_on_an_expired_session() {
        use crate::jmap_test_support as support;
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, e1, e2) = jmap_state(&m, port).await;
        let fetches = session_fetches(&m);
        m.mutate(|st| st.faults.push(mock_jmap::Fault::UnauthorizedOnce));

        let r = handle_request_for_test(
            &s,
            "bulk_delete_emails",
            json!({"accountId": "acct1", "accountJson": support::account_json(&m, port).to_string(), "mailbox": "INBOX", "uids": [e1, e2]}),
        )
        .await
        .result
        .expect("ran");

        assert_eq!((r["completed"].clone(), r["errors"].clone()), (json!(2), json!(0)), "{r}");
        assert_eq!(session_fetches(&m), fetches + 1, "exactly one reconnect");
        assert_eq!(binned(&s).len(), 2);
        assert!(trap.accept().is_err(), "no IMAP dial");
    }
}
