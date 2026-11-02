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
use crate::account_lifecycle::{AccountStamp, OperationPermit};
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
    /// Worker-only original identity. Never substitutes an unbound local UID
    /// copy for the message proved by the selected provider connection.
    Bound {config:&'a ImapConfig,identity:&'a mailvault_core::bulk_worker::Identity},
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

/// Why a capture could not keep its copy, so the refusal can say so instead of
/// one generic sentence. The wire form is `E_BIN_CAPTURE:<reason>: <detail>`
/// (`wire`); the app maps `<reason>` to catalog copy and the detail only goes
/// to the log.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CaptureFailure {
    /// The server did not hand the message over.
    Fetch(String),
    /// The server did not answer within the body-fetch ceiling. The text of
    /// the fetch that ran out, when it named the message (the JMAP body
    /// fetch's "... UID n from <folder>"), is kept for the log; `None` is the
    /// capture's own ceiling, `timed out after 45s`.
    Timeout(Option<String>),
    /// The account is closing or being changed: the capture was not allowed to start or finish.
    Busy,
    /// The deleted-mail bin could not be written.
    BinWrite(String),
    /// This computer's own copy (the vault, or the bin's record of an
    /// earlier capture) could not be read. Local storage, never the mail
    /// server, so it shares `BinWrite`'s `write` reason.
    LocalRead(String),
}

/// The catalog key a busy account travels as.
const KEYCHAIN_BUSY: &str = "errors.keychainBusy";

impl CaptureFailure {
    /// `fetch|timeout|busy|write`, the `<reason>` of the wire form.
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Self::Fetch(_) => "fetch",
            Self::Timeout(_) => "timeout",
            Self::Busy => "busy",
            Self::BinWrite(_) | Self::LocalRead(_) => "write",
        }
    }

    /// The daemon's own text, for the log. Unchanged from the string errors
    /// this type replaced, so a caller that matches it (`is_auth_error`) still can.
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::Fetch(e) | Self::BinWrite(e) | Self::LocalRead(e) | Self::Timeout(Some(e)) => e.clone(),
            Self::Timeout(None) => format!("timed out after {}s", crate::handlers::imap::BODY_FETCH_TIMEOUT.as_secs()),
            Self::Busy => KEYCHAIN_BUSY.to_owned(),
        }
    }

    /// `E_BIN_CAPTURE:<reason>: <detail>`.
    pub(crate) fn wire(&self) -> String {
        format!("E_BIN_CAPTURE:{}: {}", self.reason(), self.detail())
    }

    /// A string error from a server read: a busy account and a ceiling that
    /// ran out keep their own reason (the timeout its text, which names the
    /// message), anything else is the server not handing over.
    pub(crate) fn read(e: String) -> Self {
        if e == KEYCHAIN_BUSY {
            Self::Busy
        } else if crate::handlers::jmap_bridge::is_timeout_text(&e) {
            Self::Timeout(Some(e))
        } else {
            Self::Fetch(e)
        }
    }

    /// A string error from a read of this computer's own copy: a busy
    /// account stays busy, anything else is local storage, never the server.
    fn local(e: String) -> Self {
        if e == KEYCHAIN_BUSY {
            Self::Busy
        } else {
            Self::LocalRead(e)
        }
    }
}

impl std::fmt::Display for CaptureFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail())
    }
}

/// The ceiling on the capture's body fetch. Tests shorten it per app dir
/// (`set_fetch_ceiling_for_test`) so the timeout path does not take 45s; the
/// error text keeps naming `BODY_FETCH_TIMEOUT`.
fn fetch_ceiling(_state: &DaemonState) -> Duration {
    #[cfg(test)]
    if let Some(d) = fetch_ceilings().lock().unwrap().get(&_state.app_dir) {
        return *d;
    }
    crate::handlers::imap::BODY_FETCH_TIMEOUT
}

#[cfg(test)]
fn fetch_ceilings() -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Duration>> {
    static CEILINGS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Duration>>> = std::sync::OnceLock::new();
    CEILINGS.get_or_init(Default::default)
}

#[cfg(test)]
pub(crate) fn set_fetch_ceiling_for_test(state: &DaemonState, ceiling: Duration) {
    fetch_ceilings().lock().unwrap().insert(state.app_dir.clone(), ceiling);
}

/// Capture `uid` into the bin before it is deleted. `Ok(Some((id,
/// created)))`: it is there; `created` is false when an earlier call of the
/// same delete already put it there. `Ok(None)`: nothing to capture, the
/// message is already gone. `Err`: it could not be kept.
pub(crate) async fn capture(
    state: &Arc<DaemonState>,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    source: Source<'_>,
) -> Result<Option<(String, bool)>, CaptureFailure> {
    let original = state.account_lifecycle.capture(account_id).map_err(|_| CaptureFailure::Busy)?;
    capture_stamped(state, original, account_id, mailbox, uid, source).await
}

pub(crate) async fn capture_stamped(
    state: &Arc<DaemonState>,
    original: AccountStamp,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    source: Source<'_>,
) -> Result<Option<(String, bool)>, CaptureFailure> {
    if original.id() != account_id { return Err(CaptureFailure::Busy); }
    let bound = matches!(&source, Source::Bound { .. });
    let local = if bound {
        None
    } else {
        crate::raw_message::local_message_stamped(state, &original, mailbox, uid, false).await.map_err(CaptureFailure::local)?
    };
    let (raw, server_flags) = match local {
        Some(raw) => (Some(raw.to_vec()), None),
        None => match source {
            Source::Imap {
                permanent: false, ..
            } => (None, None),
            Source::Imap {
                config, priority, ..
            } => {
                let mb = mailbox.to_string();
                let fetch = state.imap_pool.run_read(config, priority, |mut session| {
                    let mb = mb.clone();
                    async move {
                        let email = imap::fetch_email_by_uid_light(&mut session, &mb, uid).await?;
                        Ok((email, session, Some(mb)))
                    }
                });
                match tokio::time::timeout(fetch_ceiling(state), fetch).await {
                    Ok(Ok(Some(email))) if email.uid == uid => {
                        (Some(email.raw_source_bytes), Some(email.flags))
                    }
                    // Gone already: a retry of a delete that landed finds the
                    // copy its first attempt kept.
                    Ok(Ok(_)) => return kept_already(state, account_id, mailbox, uid).await,
                    Ok(Err(e)) => return Err(CaptureFailure::read(e)),
                    Err(_) => return Err(CaptureFailure::Timeout(None)),
                }
            }
            Source::Jmap { config } => match crate::handlers::jmap_bridge::fetch_for_capture(
                state, config, account_id, mailbox, uid,
            )
            .await
            {
                Ok(Some((raw, flags))) => (Some(raw), Some(flags)),
                // Gone already: a retry of a delete that landed finds the
                // copy its first attempt kept.
                Ok(None) => return kept_already(state, account_id, mailbox, uid).await,
                Err(e) => return Err(CaptureFailure::read(e)),
            },
            Source::Bound { config, identity } => {
                let fetched = match identity {
                    mailvault_core::bulk_worker::Identity::Imap {
                        validity,
                        message_ids,
                    } => {
                        let fetched =
                            state
                                .imap_pool
                                .run_read(config, false, |mut session| async move {
                                    let raw = imap::abd_cmds::fetch_raw_identified(
                                        &mut session,
                                        mailbox,
                                        uid,
                                        *validity,
                                        message_ids.get(&uid).map(String::as_str),
                                    )
                                    .await?;
                                    Ok((raw, session, Some(mailbox.to_string())))
                                });
                        tokio::time::timeout(crate::handlers::imap::BODY_FETCH_TIMEOUT, fetched)
                            .await
                            .map_err(|_| CaptureFailure::Fetch("errors.bulkIdentityUncertain".to_string()))?
                            .map_err(CaptureFailure::read)?
                            .map(|raw| (raw.raw, raw.flags))
                    }
                    mailvault_core::bulk_worker::Identity::Jmap { mailbox_id, ids } => {
                        let email_id = ids.get(&uid).ok_or_else(|| CaptureFailure::Fetch("errors.bulkIdentityUncertain".into()))?;
                        crate::handlers::jmap_bridge::fetch_for_capture_identified(
                            state, config, mailbox, mailbox_id, email_id,
                        )
                        .await
                        .map_err(CaptureFailure::read)?
                    }
                    _ => return Err(CaptureFailure::Fetch("errors.bulkGraphDeleteUnsupported".into())),
                };
                match fetched {
                    Some((raw, flags)) => (Some(raw), Some(flags)),
                    None => return kept_already(state, account_id, mailbox, uid).await,
                }
            }
            Source::Graph | Source::Local => return Ok(None),
        },
    };
    #[cfg(test)]
    let _capture_done = tests::capture_pause(state);
    let state = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    blocking(move || {
        let _permit = state.account_lifecycle.try_commit(&[original]).map_err(|_| CaptureFailure::Busy)?;
        // The row the list showed, else one parsed from the message itself.
        let listed = crate::custody::with_conn(&state, |c| {
            cache::load_by_uids(c, &account_id, &mailbox, &[uid])
        })
        .ok()
        .and_then(|rows| rows.into_iter().next());
        let row = listed
            .filter(|_| !bound)
            .or_else(|| {
                raw.as_deref()
                    .and_then(|raw| vault_eml::light_row_json(raw, uid))
                    .and_then(|r| serde_json::from_str(&r).ok())
            })
            .unwrap_or_else(|| json!({ "uid": uid }));
        let flags: Vec<String> = server_flags.unwrap_or_else(|| {
            row.get("flags")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|f| f.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        });
        let message_id = row
            .get("messageId")
            .or_else(|| row.get("message_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        // Byte-less, the Message-ID is the only way back to the Trash copy.
        if raw.is_none() && message_id.is_none() {
            return Ok(None);
        }
        let c = Capture {
            account_id: &account_id,
            mailbox: &mailbox,
            uid,
            message_id: message_id.as_deref(),
            flags: &flags,
            row: &row,
            deleted_at: now_ms(),
        };
        app_db::with(&state.app_dir, |conn| {
            let kept = bin::capture(conn, &state.app_dir, &c, raw.as_deref())?;
            if bound && !kept.1 {
                if let Some(raw) = raw.as_deref() {
                    if bin::read_eml(&state.app_dir, &kept.0)?.as_slice() != raw {
                        return Err("errors.bulkCopyChanged".into());
                    }
                }
            }
            Ok(kept)
        })
        .map(Some)
        .map_err(CaptureFailure::BinWrite)
    })
    .await
    .map_err(CaptureFailure::BinWrite)
    .and_then(|r| r)
}

/// The bin copy an earlier attempt of this delete kept, if any.
async fn kept_already(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<(String, bool)>, CaptureFailure> {
    let state = Arc::clone(state);
    let (account_id, mailbox) = (account_id.to_string(), mailbox.to_string());
    blocking(move || app_db::with(&state.app_dir, |c| bin::find(c, &state.app_dir, &account_id, &mailbox, uid)))
        .await
        .and_then(|r| r)
        .map(|id| id.map(|id| (id, false)))
        .map_err(CaptureFailure::LocalRead)
}

/// The delete it was captured for did not happen: a failed delete is
/// retried, and its retry captures again.
pub(crate) async fn forget(state: &Arc<DaemonState>, id: String) {
    let state = Arc::clone(state);
    let result = blocking(move || {
        let Some(row) = app_db::with(&state.app_dir, |c| bin::get(c, &id))? else { return Ok(()); };
        let original = state.account_lifecycle.capture(&row.account_id).map_err(|_| "errors.keychainBusy".to_owned())?;
        let _permit = state.account_lifecycle.try_commit(&[original]).map_err(|_| "errors.keychainBusy".to_owned())?;
        app_db::with(&state.app_dir, |c| bin::remove(c, &state.app_dir, &id))
    }).await.and_then(|r| r);
    if let Err(e) = result {
        warn!("[deleted] could not drop the capture of a failed delete: {e}");
    }
}

pub(crate) async fn forget_stamped(state: &Arc<DaemonState>, id: String, original: AccountStamp) {
    let state = Arc::clone(state);
    let result = blocking(move || {
        let Some(row) = app_db::with(&state.app_dir, |c| bin::get(c, &id))? else { return Ok(()); };
        if row.account_id != original.id() { return Err("deleted bin account changed".into()); }
        let _permit = state.account_lifecycle.try_commit(&[original]).map_err(|_| "errors.keychainBusy".to_owned())?;
        app_db::with(&state.app_dir, |c| bin::remove(c, &state.app_dir, &id))
    }).await.and_then(|r| r);
    if let Err(e) = result { warn!("[deleted] could not drop the capture of a failed delete: {e}"); }
}

/// Where the delete put the message, for a recover to move it back from.
pub(crate) async fn landed(state: &Arc<DaemonState>, id: String, trash: Option<String>, trash_uid: Option<u32>) {
    let state = Arc::clone(state);
    let result = blocking(move || {
        let Some(row) = app_db::with(&state.app_dir, |c| bin::get(c, &id))? else { return Ok(()); };
        let original = state.account_lifecycle.capture(&row.account_id).map_err(|_| "errors.keychainBusy".to_owned())?;
        let _permit = state.account_lifecycle.try_commit(&[original]).map_err(|_| "errors.keychainBusy".to_owned())?;
        app_db::with(&state.app_dir, |c| bin::set_trash(c, &id, trash.as_deref(), trash_uid))
    }).await.and_then(|r| r);
    if let Err(e) = result {
        warn!("[deleted] could not record where a delete put the message: {e}");
    }
}

pub(crate) async fn landed_stamped(state: &Arc<DaemonState>, id: String, trash: Option<String>, trash_uid: Option<u32>, original: AccountStamp) {
    let state = Arc::clone(state);
    let result = blocking(move || {
        let Some(row) = app_db::with(&state.app_dir, |c| bin::get(c, &id))? else { return Ok(()); };
        if row.account_id != original.id() { return Err("deleted bin account changed".into()); }
        let _permit = state.account_lifecycle.try_commit(&[original]).map_err(|_| "errors.keychainBusy".to_owned())?;
        app_db::with(&state.app_dir, |c| bin::set_trash(c, &id, trash.as_deref(), trash_uid))
    }).await.and_then(|r| r);
    if let Err(e) = result { warn!("[deleted] could not record where a delete put the message: {e}"); }
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
    let original = state.account_lifecycle.capture(&d.account_id).map_err(|_| "errors.keychainBusy".to_owned())?;
    let fetched = if d.has_eml { None } else { Some(from_trash(state, &d).await?) };
    #[cfg(test)]
    let _local_done = tests::local_recovery_pause(state);
    let state = Arc::clone(state);
    blocking(move || {
        let _permit = state.account_lifecycle.try_commit(&[original]).map_err(|_| "errors.keychainBusy".to_owned())?;
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
    let original = state.account_lifecycle.capture(&d.account_id).map_err(|_| "errors.keychainBusy".to_owned())?;
    let config = imap_config(state, &d.account_id).await?;
    let operation = state.account_lifecycle.try_operation(std::slice::from_ref(&original)).map_err(|_| "errors.keychainBusy".to_owned())?;
    let new_uid = if config.uses_jmap() {
        recover_on_jmap(state, &d, &config, original.clone(), operation.clone()).await?
    } else {
        recover_on_imap(state, &d, &config).await?
    };
    #[cfg(test)]
    let _recovery_done = tests::recovery_pause(state);

    // A kept vault copy is filed under the uid the delete retired, and
    // custody says the server lost it. Re-file it under the new uid, or it
    // renders as a second, "only copy" message beside the one just restored.
    // A JMAP label put back keeps the uid it had (ledger rows are never
    // removed): the copy is filed right already, only its stamp is wrong.
    if let Some(new_uid) = new_uid {
        let refiled = if new_uid == d.uid { true } else {
            crate::handlers::custody::rebind_uids_owned(state, original.clone(), d.mailbox.clone(), vec![(d.uid, new_uid)], operation.clone())
                .await.is_ok_and(|r| r["rebound"].as_array().is_some_and(|a| !a.is_empty()))
        };
        if refiled {
            if let Err(e) = lift_server_deleted(state, &d.account_id, &d.mailbox, vec![new_uid], operation.clone()).await {
                warn!("[deleted] recovered uid {new_uid}: vault copy still marked deleted: {e}");
            }
        }
    }

    let (app_dir, id) = (state.app_dir.clone(), d.id.clone());
    let child_owner = operation.clone();
    blocking(move || {
        let _child_owner = child_owner;
        app_db::with(&app_dir, |c| bin::remove(c, &app_dir, &id))
    }).await.and_then(|r| r)?;
    info!("[deleted] recovered {} to {}/{} (uid {:?})", d.id, d.account_id, d.mailbox, new_uid);
    Ok(json!({ "id": d.id, "accountId": d.account_id, "mailbox": d.mailbox, "uid": new_uid }))
}

/// The custody entries of `uids` stop saying "this app deleted the server
/// copy": the message is back on the server. A uid with no entry is left alone.
async fn lift_server_deleted(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uids: Vec<u32>, owner: OperationPermit) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    let (st, acct, mb) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    blocking(move || {
        let _owner = owner;
        crate::custody::with_conn(&st, |c| {
            let text = entries::read(c, &acct, &mb)?.unwrap_or_default();
            let rows: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
            let back: Vec<Value> = rows
                .into_iter()
                .filter(|e| entries::uid_of(e).is_some_and(|u| uids.contains(&u)))
                .map(|mut e| {
                    e["serverDeleted"] = json!(false);
                    e
                })
                .collect();
            if back.is_empty() {
                return Ok(());
            }
            entries::upsert(c, &acct, &mb, &back).map(|_| ())
        })
    })
    .await
    .and_then(|r| r)
}

/// The copy of `d` in the SELECTED Trash: the uid the delete recorded
/// (`trash_uid`, its COPYUID) while Trash still holds it, else the newest
/// one with its Message-ID. The recorded uid wins: two copies of one
/// Message-ID can sit in Trash, and only one is this delete's.
async fn copy_in_trash(session: &mut imap::pool::ImapSession, trash_uid: Option<u32>, message_id: Option<&str>) -> Result<Option<u32>, String> {
    if let Some(uid) = trash_uid {
        if imap::uids_present(session, &[uid]).await?.contains(&uid) {
            return Ok(Some(uid));
        }
    }
    match message_id {
        Some(mid) => imap::uid_of_message_id(session, mid).await,
        None => Ok(None),
    }
}

/// What the first pass of `recover_on_imap` found.
enum ImapRecover {
    /// Moved back out of Trash, under this uid when the server said.
    Moved(Option<u32>),
    /// Not in Trash. The uids in the folder it left that carry its
    /// Message-ID and sit above the retired uid: candidates for a copy an
    /// earlier restore put back after its answer was lost.
    NotInTrash(Vec<u32>),
}

/// `recover_server` on an IMAP account: moved back out of Trash when the
/// delete put it there and it still is (`copy_in_trash`); else, when the
/// folder it left already holds it again (a restore that landed after its
/// answer was lost, or timed out), that copy; else APPENDed to the folder.
/// Returns the uid the server gave it, when it said.
///
/// "Holds it again" is strict, or a legitimate duplicate (a second delivery,
/// a list copy, an import) would be claimed and the bin's copy dropped: a
/// copy counts only with a uid above the retired one (a MOVE or APPEND after
/// the delete always gets one) and when the header cache did not list it
/// before the delete.
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
    let (trash, mailbox, trash_uid, retired) = (d.trash.clone(), d.mailbox.clone(), d.trash_uid, d.uid);
    let mid = message_id.clone();
    let found = crate::handlers::imap::with_priority(pool, cfg, |mut session| async move {
        if let Some(trash) = trash.as_deref().filter(|_| trash_uid.is_some() || mid.is_some()) {
            imap::select_mailbox(&mut session, trash).await?;
            if let Some(in_trash) = copy_in_trash(&mut session, trash_uid, mid.as_deref()).await? {
                let has_move = pool.has_capability(cfg, "MOVE").await;
                let has_uidplus = pool.has_capability(cfg, "UIDPLUS").await;
                let moved = imap::move_uids(&mut session, trash, &mailbox, &[in_trash], has_move, has_uidplus).await?;
                return Ok((ImapRecover::Moved(moved.new_uids.and_then(|u| u.first().copied())), session, Some(trash.to_string())));
            }
        }
        let mut again = Vec::new();
        if let Some(mid) = mid.as_deref() {
            if imap::select_mailbox(&mut session, &mailbox).await.is_ok() {
                again = match imap::message_id_uids(&mut session, mid).await {
                    Ok(hits) => hits,
                    Err(e) if e == imap::NO_USABLE_MESSAGE_ID => Vec::new(),
                    Err(e) => return Err(e),
                };
                again.retain(|u| *u > retired);
            }
        }
        Ok((ImapRecover::NotInTrash(again), session, Some(mailbox)))
    })
    .await?;
    let again = match found {
        ImapRecover::Moved(new_uid) => return Ok(new_uid),
        ImapRecover::NotInTrash(again) => again,
    };
    if !again.is_empty() {
        let (st, acct, mb, at, asked) = (Arc::clone(state), d.account_id.clone(), d.mailbox.clone(), d.deleted_at, again.clone());
        // An unreadable cache claims nothing: an APPEND is the safe side.
        let twins = blocking(move || crate::custody::with_conn(&st, |c| cache::listed_before(c, &acct, &mb, &asked, at))).await.and_then(|r| r).unwrap_or_else(|_| again.clone());
        if let Some(back) = again.iter().rev().find(|u| !twins.contains(u)).copied() {
            info!("[deleted] {} is back in {}/{} already (uid {back}): nothing appended", d.id, d.account_id, d.mailbox);
            return Ok(Some(back));
        }
    }
    let Some(raw) = raw else { return Err("deletedBin.goneFromTrash".to_string()) };
    let mailbox = d.mailbox.clone();
    crate::handlers::imap::with_priority(pool, cfg, |mut session| async move {
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
async fn recover_on_jmap(state: &Arc<DaemonState>, d: &Deleted, config: &ImapConfig, original: AccountStamp, owner: OperationPermit) -> Result<Option<u32>, String> {
    crate::handlers::jmap_bridge::with_session_retry(state, config, |acct| recover_jmap_once(state, d, config, acct, original.clone(), owner.clone())).await
}

/// One pass of `recover_on_jmap` on `acct`. Safe to run twice: a second pass
/// finds the email the first one put back (or imported) and relabels it again.
async fn recover_jmap_once(state: &Arc<DaemonState>, d: &Deleted, config: &ImapConfig, acct: Arc<crate::jmap_sessions::AccountJmap>, original: AccountStamp, owner: OperationPermit) -> Result<Option<u32>, String> {
    use mailvault_core::jmap::ImportResult;
    let mailbox_id = crate::migration::ensure_dest_folder_jmap(&acct, &d.mailbox).await.map_err(|e| e.to_string())?;
    let boxes = acct.current().await.map_err(|e| e.to_string())?;
    let trash_id = crate::handlers::jmap_bridge::role_mailbox(&boxes, "trash").map(|(_, id)| id).filter(|t| *t != mailbox_id);
    let existing = match d.message_id.as_deref() {
        Some(mid) => crate::handlers::jmap_bridge::emails_with_message_id(&acct.client, None, mid).await.map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    // Two copies of one Message-ID can sit in an account; the one the bin row
    // names is the one the mailbox's ledger issued the row's uid to. The ledger
    // is read without a recheck: the delete took the email out of this mailbox,
    // and that is what is being undone. No such hit: the first one found.
    let named = match existing.is_empty() {
        true => None,
        false => acct.uid_to_id(state, &d.account_id, &d.mailbox, &[d.uid], false).await?.into_iter().find_map(|(_, id)| id),
    };
    let chosen = named.filter(|id| existing.contains(id)).or_else(|| existing.first().cloned());
    let email_id = match chosen {
        Some(id) => {
            crate::handlers::jmap_bridge::put_back(&acct, &id, &mailbox_id, trash_id, &d.mailbox).await?;
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
                    crate::handlers::jmap_bridge::put_back(&acct, &existing_id, &mailbox_id, trash_id, &d.mailbox).await?;
                    existing_id
                }
            }
        }
    };
    #[cfg(test)]
    let _ledger_done = tests::jmap_ledger_pause(state);
    let uids = acct.ids_to_uids_owned(state, original, &d.account_id, &d.mailbox, &[email_id], owner).await?;
    Ok(uids.first().copied())
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

// ── messages.restore: the undo of a delete ─────────────────────────────────
//
// The app's undo slot names what a delete put in Trash (or kept in the bin);
// the daemon does the rest, one (account, Trash, folder) group at a time:
// find each Trash copy (the recorded uid, else its Message-ID), MOVE the
// group back in one command, pair the old uids with the new ones, APPEND the
// bin copy of what Trash no longer holds, then re-key the header cache, re-file
// the vault copy, lift the custody stamp and drop the bin copy. The app keeps
// the slot, the rows on screen and the uid map its later clicks go through.

/// The ceiling on one whole `messages.restore`. The app's reply budget
/// (src-tauri `reply_timeout`, 150s) is above it, so the daemon always
/// answers first; a group still on the wire past it is answered
/// `deletedBin.restoreTimedOut` (the server may have it back already).
const RESTORE_BUDGET: Duration = Duration::from_secs(120);
const RESTORE_TIMED_OUT: &str = "deletedBin.restoreTimedOut";

/// `RESTORE_BUDGET`; tests shorten it per app dir (`set_restore_budget_for_test`).
fn restore_budget(_state: &DaemonState) -> Duration {
    #[cfg(test)]
    if let Some(d) = restore_budgets().lock().unwrap().get(&_state.app_dir) {
        return *d;
    }
    RESTORE_BUDGET
}

#[cfg(test)]
fn restore_budgets() -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Duration>> {
    static BUDGETS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Duration>>> = std::sync::OnceLock::new();
    BUDGETS.get_or_init(Default::default)
}

#[cfg(test)]
pub(crate) fn set_restore_budget_for_test(state: &DaemonState, budget: Duration) {
    restore_budgets().lock().unwrap().insert(state.app_dir.clone(), budget);
}
const GONE_FROM_TRASH: &str = "deletedBin.goneFromTrash";
/// A bin row another caller is putting back right now.
const RECOVER_BUSY: &str = "deletedBin.recoverBusy";
/// A uid the delete queue still owes: its queued delete would take it again.
const DELETE_STILL_QUEUED: &str = "deletedBin.deleteStillQueued";

/// Bin rows being put back right now (`messages.restore` and
/// `deleted.recover`), by app dir and bin id. One caller at a time: two at
/// once would both find the Trash copy gone once the first MOVE lands, and
/// the second would APPEND a duplicate. In memory only, held across the
/// network by design (an id, not a lock anything else waits on).
fn bin_claims() -> &'static std::sync::Mutex<std::collections::HashSet<(std::path::PathBuf, String)>> {
    static CLAIMS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<(std::path::PathBuf, String)>>> = std::sync::OnceLock::new();
    CLAIMS.get_or_init(Default::default)
}

/// A held claim on one bin row; released on drop.
struct BinClaim((std::path::PathBuf, String));

impl Drop for BinClaim {
    fn drop(&mut self) {
        bin_claims().lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

/// The claim on bin row `id`, or None while another caller holds it.
fn claim_bin(state: &DaemonState, id: &str) -> Option<BinClaim> {
    let key = (state.app_dir.clone(), id.to_string());
    bin_claims().lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone()).then(|| BinClaim(key))
}

/// The (account, folder, uid)s a delete entry of the queue still owes.
async fn owed_deletes(state: &Arc<DaemonState>) -> std::collections::HashSet<(String, String, u32)> {
    let st = Arc::clone(state);
    blocking(move || {
        let _lock = st.journal.lock().unwrap_or_else(|p| p.into_inner());
        mailvault_core::op_journal::read(&st.app_dir)
            .into_iter()
            .filter(|e| e.op == "delete")
            .flat_map(|e| e.uids.iter().map(|u| (e.account_id.clone(), e.mailbox.clone(), *u)).collect::<Vec<_>>())
            .collect()
    })
    .await
    .unwrap_or_default()
}
const RECOVER_FAILED: &str = "deletedBin.recoverFailed";

/// One message an undo asks back: where the delete took it from and where it
/// put it, as the delete answered (`Landed::Deleted`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreItem {
    account_id: String,
    mailbox: String,
    uid: u32,
    #[serde(default)]
    trash: Option<String>,
    #[serde(default)]
    trash_uid: Option<u32>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    bin_id: Option<String>,
    /// The list row the app showed, for the header cache (the bin's copy of
    /// the cache row when the app sends none).
    #[serde(default)]
    row: Option<Value>,
}

/// How one item ended.
#[derive(Debug, Clone, PartialEq)]
enum Restored {
    /// Back on the server, under this uid when the server named it.
    Back(Option<u32>),
    /// Not back, and why (a catalog key).
    Failed(String),
}

/// A daemon or server error as the app may show it: a catalog key passes,
/// anything else is logged and answered as `deletedBin.recoverFailed`.
fn restore_reason(e: &str) -> String {
    if e.starts_with("errors.") || e.starts_with("deletedBin.") {
        e.to_string()
    } else {
        RECOVER_FAILED.to_string()
    }
}

/// `messages.restore`: every item answers on its own, in the order asked.
async fn restore(state: &Arc<DaemonState>, items: Vec<RestoreItem>) -> Value {
    let deadline = tokio::time::Instant::now() + restore_budget(state);
    let mut out: Vec<Option<Restored>> = vec![None; items.len()];
    // A uid the queue still owes would be deleted again by its own entry;
    // a bin row another caller holds is theirs to put back. Both answered
    // now, with nothing sent.
    let owed = owed_deletes(state).await;
    let mut claims = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if owed.contains(&(item.account_id.clone(), item.mailbox.clone(), item.uid)) {
            out[i] = Some(Restored::Failed(DELETE_STILL_QUEUED.into()));
            continue;
        }
        if let Some(id) = item.bin_id.as_deref() {
            match claim_bin(state, id) {
                Some(claim) => claims.push(claim),
                None => out[i] = Some(Restored::Failed(RECOVER_BUSY.into())),
            }
        }
    }
    let mut groups: Vec<((String, Option<String>, String), Vec<usize>)> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if out[i].is_some() {
            continue;
        }
        let key = (item.account_id.clone(), item.trash.clone(), item.mailbox.clone());
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, idx)) => idx.push(i),
            None => groups.push((key, vec![i])),
        }
    }
    for (_, idx) in groups {
        let group: Vec<&RestoreItem> = idx.iter().map(|&i| &items[i]).collect();
        let answered = restore_group(state, &group, deadline).await;
        for (i, r) in idx.into_iter().zip(answered) {
            out[i] = Some(r);
        }
    }
    drop(claims);
    let (mut restored, mut failed) = (Vec::new(), Vec::new());
    for (item, r) in items.iter().zip(out) {
        match r.unwrap_or_else(|| Restored::Failed(RECOVER_FAILED.into())) {
            Restored::Back(new_uid) => restored.push(json!({"accountId": item.account_id, "mailbox": item.mailbox, "uid": item.uid, "newUid": new_uid})),
            Restored::Failed(error) => failed.push(json!({"accountId": item.account_id, "mailbox": item.mailbox, "uid": item.uid, "error": error})),
        }
    }
    json!({"restored": restored, "failed": failed})
}

/// Where one item of a group stands after the server part.
#[derive(Debug, Clone, PartialEq)]
enum InTrash {
    /// Trash does not hold it: its bin copy is the way back.
    Missing,
    /// Out of Trash and back, under `new_uid` when the server named it.
    /// `proved`: the server's answer accounts for it (every uid paired by
    /// COPYUID, or a JMAP move that took all it was sent). Unproved, its bin
    /// row is kept.
    Moved { new_uid: Option<u32>, proved: bool },
    /// Still in Trash: the move did not take it. A catalog key.
    Stayed(String),
}

/// "The recorded uid, then the newest Message-ID hit, never one copy for two
/// items", the one rule both providers find Trash copies by.
struct Picker {
    found: Vec<Option<u32>>,
    taken: std::collections::HashSet<u32>,
}

impl Picker {
    /// Each item's recorded Trash uid, where Trash still holds it (`present`).
    fn recorded(wanted: &[(Option<u32>, Option<String>)], present: &[u32]) -> Self {
        let mut p = Picker { found: vec![None; wanted.len()], taken: Default::default() };
        for (i, (uid, _)) in wanted.iter().enumerate() {
            if let Some(uid) = uid.filter(|u| present.contains(u)) {
                if p.taken.insert(uid) {
                    p.found[i] = Some(uid);
                }
            }
        }
        p
    }

    /// The items still unfound that have a Message-ID to search by.
    fn wanting<'a>(&self, wanted: &'a [(Option<u32>, Option<String>)]) -> Vec<(usize, &'a str)> {
        wanted.iter().enumerate().filter(|(i, _)| self.found[*i].is_none()).filter_map(|(i, (_, mid))| mid.as_deref().map(|m| (i, m))).collect()
    }

    /// Item `i` takes the newest of `hits` no other item took.
    fn take_newest(&mut self, i: usize, hits: impl IntoIterator<Item = u32>) {
        if let Some(uid) = hits.into_iter().filter(|u| !self.taken.contains(u)).max() {
            self.taken.insert(uid);
            self.found[i] = Some(uid);
        }
    }

    /// The Trash uids to move, in item order.
    fn to_move(&self) -> Vec<u32> {
        self.found.iter().flatten().copied().collect()
    }
}

/// Per item, from what was found and what is still in Trash after a move the
/// server did not fully account for: still there is `Stayed`, gone is an
/// unproved `Moved`.
fn after_recheck(found: &[Option<u32>], still: &[u32]) -> Vec<InTrash> {
    found
        .iter()
        .map(|f| match f {
            None => InTrash::Missing,
            Some(t) if still.contains(t) => InTrash::Stayed(RECOVER_FAILED.into()),
            Some(_) => InTrash::Moved { new_uid: None, proved: false },
        })
        .collect()
}

/// Per item, after a move that failed outright: what was found stayed.
fn after_refusal(found: &[Option<u32>], reason: &str) -> Vec<InTrash> {
    found.iter().map(|f| if f.is_some() { InTrash::Stayed(restore_reason(reason)) } else { InTrash::Missing }).collect()
}

/// One message back on the server, for the local half (`settle_restored`):
/// its old uid, the new one when the server named it, its list row, and
/// whether the bin's own recover already re-filed and stamped it.
struct Settle {
    old: u32,
    new: Option<u32>,
    row: Option<Value>,
    refiled: bool,
}

/// One (account, Trash, folder) group: one MOVE back, the bin for what Trash
/// no longer holds, then the local bookkeeping in one pass.
async fn restore_group(state: &Arc<DaemonState>, items: &[&RestoreItem], deadline: tokio::time::Instant) -> Vec<Restored> {
    let fail_all = |e: &str| vec![Restored::Failed(restore_reason(e)); items.len()];
    let (account_id, mailbox, trash) = (items[0].account_id.clone(), items[0].mailbox.clone(), items[0].trash.clone());
    // The bin rows first: their record of where the delete put the message
    // fills in what the app's slot lacks, and their bytes are the fallback.
    let mut bins: Vec<Option<Deleted>> = Vec::with_capacity(items.len());
    for item in items {
        bins.push(match item.bin_id.clone() {
            Some(id) => get(state, id).await.ok().filter(|d| d.account_id == item.account_id && d.mailbox == item.mailbox && d.uid == item.uid),
            None => None,
        });
    }
    let Ok(original) = state.account_lifecycle.capture(&account_id) else { return fail_all(KEYCHAIN_BUSY) };
    let config = match imap_config(state, &account_id).await {
        Ok(c) => c,
        Err(e) => {
            warn!("[restore] {account_id}: no server credentials: {e}");
            return fail_all(&e);
        }
    };
    let Ok(operation) = state.account_lifecycle.try_operation(std::slice::from_ref(&original)) else { return fail_all(KEYCHAIN_BUSY) };

    let wanted: Vec<(Option<u32>, Option<String>)> = items
        .iter()
        .zip(&bins)
        .map(|(item, bin)| {
            let trash_uid = item.trash_uid.or_else(|| bin.as_ref().and_then(|d| d.trash_uid));
            let mid = item.message_id.clone().or_else(|| bin.as_ref().and_then(|d| d.message_id.clone()));
            let mid = mid.map(|m| m.trim().trim_start_matches('<').trim_end_matches('>').to_string()).filter(|m| !m.is_empty());
            (trash_uid, mid)
        })
        .collect();
    let moved: Vec<InTrash> = match trash.as_deref() {
        None => vec![InTrash::Missing; items.len()],
        Some(trash) => {
            let back = async {
                if config.uses_jmap() {
                    jmap_move_back(state, &config, &original, &account_id, trash, &mailbox, &wanted).await
                } else {
                    imap_move_back(state, &config, trash, &mailbox, &wanted).await
                }
            };
            match tokio::time::timeout_at(deadline, back).await {
                Ok(Ok(m)) => m,
                Ok(Err(e)) => {
                    warn!("[restore] {account_id}/{mailbox}: Trash could not be read: {e}");
                    return fail_all(&e);
                }
                Err(_) => {
                    warn!("[restore] {account_id}/{mailbox}: the move back out of {trash} ran past its budget");
                    return fail_all(RESTORE_TIMED_OUT);
                }
            }
        }
    };

    let mut answers: Vec<Restored> = Vec::with_capacity(items.len());
    let mut settle: Vec<Settle> = Vec::new();
    let mut discard: Vec<String> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        // The app's row first: it is what the list showed at the delete, its
        // read state included; the bin's is the header cache at capture,
        // which a flag change just before the delete may not have reached.
        let row = item.row.clone().filter(Value::is_object).or_else(|| bins[i].as_ref().map(|d| d.row.clone()).filter(Value::is_object));
        let answer = match moved[i].clone() {
            InTrash::Moved { new_uid, proved } => {
                settle.push(Settle { old: item.uid, new: new_uid, row, refiled: false });
                if proved {
                    discard.extend(bins[i].as_ref().map(|d| d.id.clone()));
                }
                Restored::Back(new_uid)
            }
            InTrash::Stayed(reason) => Restored::Failed(reason),
            // Trash does not hold it: the bin copy goes back, APPENDed to the
            // folder (or imported, on JMAP) by the bin's own recover, which
            // re-files the vault copy, lifts its stamp and drops the row itself.
            InTrash::Missing => match bins[i].clone() {
                Some(d) if d.has_eml => match tokio::time::timeout_at(deadline, recover_server(state, d)).await {
                    Ok(Ok(v)) => {
                        let new_uid = v["uid"].as_u64().and_then(|u| u32::try_from(u).ok());
                        // Re-filed and stamped already: only the header row is left.
                        if new_uid.is_some() {
                            settle.push(Settle { old: item.uid, new: new_uid, row, refiled: true });
                        }
                        Restored::Back(new_uid)
                    }
                    Ok(Err(e)) => {
                        warn!("[restore] {account_id}/{mailbox} uid {}: the bin copy did not go back: {e}", item.uid);
                        Restored::Failed(restore_reason(&e))
                    }
                    Err(_) => Restored::Failed(RESTORE_TIMED_OUT.into()),
                },
                _ => Restored::Failed(GONE_FROM_TRASH.into()),
            },
        };
        answers.push(answer);
    }
    settle_restored(state, original, operation, &account_id, &mailbox, settle, discard).await;
    info!("[restore] {account_id}/{mailbox}: {} of {} back", answers.iter().filter(|a| matches!(a, Restored::Back(_))).count(), items.len());
    answers
}

/// The server part of a group on an IMAP account, on the priority lane: the
/// Trash copies (`Picker`: recorded uids checked in one SEARCH, then a
/// Message-ID search for the rest), one MOVE back, and the old uids paired
/// with COPYUID's: its destination set follows the source set, which servers
/// send ascending. A COPYUID that names fewer uids than were sent pairs
/// nothing: Trash is checked again, and what is still there stayed. A MOVE
/// refused outright fails only what it would have moved. `Err`: Trash could
/// not be read, nothing was sent.
async fn imap_move_back(state: &Arc<DaemonState>, config: &ImapConfig, trash: &str, mailbox: &str, wanted: &[(Option<u32>, Option<String>)]) -> Result<Vec<InTrash>, String> {
    let pool = &state.imap_pool;
    let has_move = pool.has_capability(config, "MOVE").await;
    let has_uidplus = pool.has_capability(config, "UIDPLUS").await;
    let (trash, mailbox, wanted) = (trash.to_string(), mailbox.to_string(), wanted.to_vec());
    // What the search found, and whether the MOVE was answered OK, for a
    // command that errs after it: its session is not returned to the pool,
    // so its answer cannot travel back with it.
    let picked: Arc<std::sync::Mutex<Option<(Vec<Option<u32>>, bool)>>> = Default::default();
    let seen = Arc::clone(&picked);
    let answered = crate::handlers::imap::with_priority(pool, config, |mut session| async move {
        imap::select_mailbox(&mut session, &trash).await?;
        let recorded: Vec<u32> = wanted.iter().filter_map(|(uid, _)| *uid).collect();
        let present = imap::uids_present(&mut session, &recorded).await?;
        let mut pick = Picker::recorded(&wanted, &present);
        for (i, mid) in pick.wanting(&wanted) {
            let hits = match imap::message_id_uids(&mut session, mid).await {
                Ok(hits) => hits,
                // An id the server cannot be asked about finds nothing.
                Err(e) if e == imap::NO_USABLE_MESSAGE_ID => Vec::new(),
                Err(e) => return Err(e),
            };
            pick.take_newest(i, hits);
        }
        let to_move = pick.to_move();
        if to_move.is_empty() {
            return Ok((vec![InTrash::Missing; wanted.len()], session, Some(trash)));
        }
        *seen.lock().unwrap_or_else(|p| p.into_inner()) = Some((pick.found.clone(), false));
        let moved = imap::move_uids(&mut session, &trash, &mailbox, &to_move, has_move, has_uidplus).await?;
        *seen.lock().unwrap_or_else(|p| p.into_inner()) = Some((pick.found.clone(), true));
        let out = match moved.new_uids {
            Some(mut dst) if dst.len() == to_move.len() => {
                let mut src = to_move.clone();
                src.sort_unstable();
                dst.sort_unstable();
                let pairs: std::collections::HashMap<u32, u32> = src.into_iter().zip(dst).collect();
                pick.found.iter().map(|f| match f {
                    Some(t) => InTrash::Moved { new_uid: pairs.get(t).copied(), proved: true },
                    None => InTrash::Missing,
                }).collect()
            }
            // A server without UIDPLUS never names uids, and one whose
            // COPYUID is short did not account for them all: what left
            // Trash is back, unproved (its bin row stays; a later recover
            // finds the copy back in its folder and appends nothing).
            _ => {
                let still = imap::uids_present(&mut session, &to_move).await?;
                after_recheck(&pick.found, &still)
            }
        };
        Ok((out, session, Some(trash)))
    })
    .await;
    match answered {
        Ok(out) => Ok(out),
        Err(e) => match picked.lock().unwrap_or_else(|p| p.into_inner()).take() {
            // Refused: nothing it would have moved left Trash.
            Some((found, false)) => {
                warn!("[restore] the move back was refused: {e}");
                Ok(after_refusal(&found, &e))
            }
            // Answered OK, then the check of Trash failed: nothing is taken
            // as back, nothing settled; the bin rows stay.
            Some((found, true)) => {
                warn!("[restore] moved back, but Trash could not be checked again: {e}");
                Ok(after_refusal(&found, RECOVER_FAILED))
            }
            None => Err(e),
        },
    }
}

/// The server part of a group on a JMAP account, over its session through
/// the bridge's own arms: the recorded Trash uids the ledger still files in
/// Trash, a Message-ID search in Trash for the rest (`Picker`), one move
/// back, and the new uids by position (the bridge answers them in the order
/// sent; ledger uids need not rise with Trash's). A label put back keeps its
/// old uid. A move that took fewer than it was sent is checked against Trash
/// again; one refused outright fails only what it would have moved.
async fn jmap_move_back(state: &Arc<DaemonState>, config: &ImapConfig, original: &AccountStamp, account_id: &str, trash: &str, mailbox: &str, wanted: &[(Option<u32>, Option<String>)]) -> Result<Vec<InTrash>, String> {
    use crate::handlers::jmap_bridge::{answer_for, uids_present};
    let recorded: Vec<u32> = wanted.iter().filter_map(|(uid, _)| *uid).collect();
    let present = if recorded.is_empty() { Vec::new() } else { uids_present(state, config, account_id, trash, &recorded).await? };
    let mut pick = Picker::recorded(wanted, &present);
    for (i, mid) in pick.wanting(wanted) {
        let probe = answer_for(state, "imap_find_message_id", &json!({"accountId": account_id, "messageId": mid, "stopOnFirst": false}), config, original).await?;
        let hits: Vec<u32> = probe["found"].as_array().into_iter().flatten().filter(|l| l["mailbox"] == json!(trash)).filter_map(|l| l["uid"].as_u64().and_then(|u| u32::try_from(u).ok())).collect();
        pick.take_newest(i, hits);
    }
    let to_move = pick.to_move();
    if to_move.is_empty() {
        return Ok(vec![InTrash::Missing; wanted.len()]);
    }
    let r = match answer_for(state, "imap_move_emails", &json!({"accountId": account_id, "uids": to_move, "sourceMailbox": trash, "targetMailbox": mailbox}), config, original).await {
        Ok(r) => r,
        Err(e) => {
            warn!("[restore] the move back was refused: {e}");
            return Ok(after_refusal(&pick.found, &e));
        }
    };
    let moved = r["moved"].as_u64().unwrap_or(0) as usize;
    if moved == 0 {
        return Ok(after_refusal(&pick.found, RECOVER_FAILED));
    }
    if moved < to_move.len() {
        return Ok(match uids_present(state, config, account_id, trash, &to_move).await {
            Ok(still) => after_recheck(&pick.found, &still),
            Err(e) => {
                warn!("[restore] a partial move back, and Trash could not be checked again: {e}");
                after_refusal(&pick.found, RECOVER_FAILED)
            }
        });
    }
    let dst: Option<Vec<u32>> = r["newUids"].as_array().map(|a| a.iter().filter_map(|u| u.as_u64().and_then(|u| u32::try_from(u).ok())).collect()).filter(|d: &Vec<u32>| d.len() == to_move.len());
    let mut next = dst.into_iter().flatten();
    Ok(pick.found.iter().map(|f| match f {
        Some(_) => InTrash::Moved { new_uid: next.next(), proved: true },
        None => InTrash::Missing,
    }).collect())
}

/// The local half of a restored group, once the server has the messages: the
/// bin copies go first (kept, a later Cmd+Z would put a second copy back),
/// then the header cache lists each message under its new uid with the
/// retired one pruned, the vault copy is re-filed under it, and custody stops
/// calling it the only copy. Each step is best effort and logged: the
/// messages are back on the server either way. One that came back through
/// the bin's own recover (`refiled`) only needs its header row.
async fn settle_restored(state: &Arc<DaemonState>, original: AccountStamp, operation: OperationPermit, account_id: &str, mailbox: &str, back: Vec<Settle>, discard: Vec<String>) {
    if !discard.is_empty() {
        let (app_dir, owner) = (state.app_dir.clone(), operation.clone());
        let dropped = blocking(move || {
            let _owner = owner;
            app_db::with(&app_dir, |c| discard.iter().try_for_each(|id| bin::remove(c, &app_dir, id)))
        })
        .await
        .and_then(|r| r);
        if let Err(e) = dropped {
            warn!("[restore] {account_id}/{mailbox}: back on the server, but the bin copies stay: {e}");
        }
    }
    let mut rows = Vec::new();
    let mut retired = Vec::new();
    let mut rebind = Vec::new();
    let mut lift = Vec::new();
    for Settle { old, new: new_uid, row, refiled: header_only } in back {
        match new_uid {
            Some(new) => {
                if let Some(mut r) = row.filter(Value::is_object) {
                    if let Some(o) = r.as_object_mut() {
                        o.remove("_nativeIdentity");
                        o.remove("_nativeExpectedIdentity");
                        o.insert("uid".into(), json!(new));
                    }
                    rows.push(r);
                }
                if new != old {
                    retired.push(old);
                }
                if header_only {
                    continue;
                }
                if new == old {
                    // A JMAP label put back keeps its ledger uid: filed right already.
                    lift.push(old);
                } else {
                    rebind.push((old, new));
                }
            }
            // Back, under a uid only a reload learns: the entry under the old
            // uid stops claiming it is the only copy.
            None if !header_only => lift.push(old),
            None => {}
        }
    }
    if !rows.is_empty() || !retired.is_empty() {
        let (st, acct, mb, owner) = (Arc::clone(state), account_id.to_string(), mailbox.to_string(), operation.clone());
        let mut data = json!({"emails": rows});
        if !retired.is_empty() {
            data["removedUids"] = json!(retired);
        }
        let written = blocking(move || {
            let _owner = owner;
            crate::custody::with_conn(&st, |c| cache::save_headers(c, &acct, &mb, &data.to_string()))?;
            crate::handlers::cache::after_rows_removed(&st, &acct, &mb, &retired);
            Ok::<_, String>(())
        })
        .await
        .and_then(|r| r);
        if let Err(e) = written {
            warn!("[restore] {account_id}/{mailbox}: the header cache was not re-keyed: {e}");
        }
    }
    if !rebind.is_empty() {
        match crate::handlers::custody::rebind_uids_owned(state, original, mailbox.to_string(), rebind, operation.clone()).await {
            Ok(r) => lift.extend(
                r["rebound"].as_array().into_iter().flatten().filter_map(|p| p.get(1).and_then(Value::as_u64)).filter_map(|u| u32::try_from(u).ok()),
            ),
            Err(e) => warn!("[restore] {account_id}/{mailbox}: the vault copies stay under the retired uids: {e}"),
        }
    }
    if let Err(e) = lift_server_deleted(state, account_id, mailbox, lift, operation).await {
        warn!("[restore] {account_id}/{mailbox}: the vault copies still say the server lost them: {e}");
    }
}

/// One purge pass. Settings that cannot be read purge nothing: a pass that
/// cannot tell the retention must not guess a shorter one.
fn purge(state: &DaemonState) -> Result<usize, String> {
    let settings = crate::handlers::imap::read_settings_state(&state.app_dir)?;
    let days = bin::retention_days(&settings);
    let _owner = state.account_lifecycle.try_unscoped_operation().map_err(|_| "errors.keychainBusy".to_owned())?;
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
                    let _owner = state.account_lifecycle.try_unscoped_operation().map_err(|_| "errors.keychainBusy".to_owned())?;
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
                let Some(_claim) = claim_bin(state, &one) else {
                    failed.push(json!({ "id": one, "error": RECOVER_BUSY }));
                    continue;
                };
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
        // The undo of a delete: `{ items: [{ accountId, mailbox, uid, trash,
        // trashUid, messageId, binId, row? }] }` -> `{ restored: [{ accountId,
        // mailbox, uid, newUid }], failed: [{ accountId, mailbox, uid, error }] }`.
        "messages.restore" => {
            let items = match vec_arg::<RestoreItem>(&id, params, "items") {
                Ok(v) => v,
                Err(resp) => return Some(resp),
            };
            RpcResponse::success(id, restore(state, items).await)
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
                    let known = app_db::with(&state.app_dir, |c| ids.iter()
                        .map(|id| bin::get(c, id))
                        .collect::<Result<Vec<_>, _>>())?;
                    let account_ids: std::collections::BTreeSet<_> = known.iter().flatten().map(|row| row.account_id.clone()).collect();
                    let stamps = account_ids.into_iter()
                        .map(|account| state.account_lifecycle.capture(&account).map_err(|_| "errors.keychainBusy".to_owned()))
                        .collect::<Result<Vec<_>, _>>()?;
                    let _permit = if stamps.is_empty() { None } else {
                        Some(state.account_lifecycle.try_commit(&stamps).map_err(|_| "errors.keychainBusy".to_owned())?)
                    };
                    app_db::with(&state.app_dir, |c| {
                        for one in known.into_iter().flatten() {
                            bin::remove(c, &state.app_dir, &one.id)?;
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
    use std::sync::{mpsc, Mutex, OnceLock};

    #[test]
    fn a_capture_failure_wires_as_reason_then_detail() {
        assert_eq!(CaptureFailure::Fetch("no body".into()).wire(), "E_BIN_CAPTURE:fetch: no body");
        assert_eq!(CaptureFailure::Timeout(None).wire(), "E_BIN_CAPTURE:timeout: timed out after 45s");
        assert_eq!(CaptureFailure::LocalRead("read vault copy: denied".into()).wire(), "E_BIN_CAPTURE:write: read vault copy: denied");
        assert_eq!(CaptureFailure::Busy.wire(), "E_BIN_CAPTURE:busy: errors.keychainBusy");
        assert_eq!(CaptureFailure::BinWrite("create deleted bin: denied".into()).wire(), "E_BIN_CAPTURE:write: create deleted bin: denied");
    }

    #[test]
    fn a_capture_failure_keeps_the_detail_the_string_error_had() {
        // `is_auth_error` and the logs read the detail, never the wire form.
        let e = CaptureFailure::Fetch("E_JMAP_AUTH: session expired".into());
        assert_eq!(e.detail(), "E_JMAP_AUTH: session expired");
        assert_eq!(e.to_string(), "E_JMAP_AUTH: session expired");
    }

    #[test]
    fn a_read_error_keeps_its_own_reason() {
        assert_eq!(CaptureFailure::read("errors.keychainBusy".into()), CaptureFailure::Busy);
        let named = "Timed out after 45s fetching message UID 3 from INBOX";
        assert_eq!(CaptureFailure::read(named.into()), CaptureFailure::Timeout(Some(named.into())));
        assert_eq!(CaptureFailure::read(named.into()).wire(), format!("E_BIN_CAPTURE:timeout: {named}"), "the uid and folder stay in the detail");
        assert_eq!(CaptureFailure::read("timed out after 45s".into()).reason(), "timeout");
        assert_eq!(CaptureFailure::read("Server returned no body".into()), CaptureFailure::Fetch("Server returned no body".into()));
    }

    /// A failed read of this computer's own copy blames local storage, never
    /// the mail server; a busy account stays busy.
    #[test]
    fn a_local_read_error_is_local_storage_not_the_server() {
        assert_eq!(CaptureFailure::local("errors.keychainBusy".into()), CaptureFailure::Busy);
        let e = CaptureFailure::local("Permission denied (os error 13)".into());
        assert_eq!(e, CaptureFailure::LocalRead("Permission denied (os error 13)".into()));
        assert_eq!(e.reason(), "write");
    }

    struct RecoveryGate {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        done: mpsc::Sender<()>,
    }
    fn recovery_gates() -> &'static Mutex<std::collections::HashMap<std::path::PathBuf, RecoveryGate>> {
        static GATES: OnceLock<Mutex<std::collections::HashMap<std::path::PathBuf, RecoveryGate>>> = OnceLock::new();
        GATES.get_or_init(Default::default)
    }
    fn capture_gates() -> &'static Mutex<std::collections::HashMap<std::path::PathBuf, RecoveryGate>> {
        static GATES: OnceLock<Mutex<std::collections::HashMap<std::path::PathBuf, RecoveryGate>>> = OnceLock::new();
        GATES.get_or_init(Default::default)
    }
    fn jmap_ledger_gates() -> &'static Mutex<std::collections::HashMap<std::path::PathBuf, RecoveryGate>> {
        static GATES: OnceLock<Mutex<std::collections::HashMap<std::path::PathBuf, RecoveryGate>>> = OnceLock::new();
        GATES.get_or_init(Default::default)
    }
    fn local_recovery_gates() -> &'static Mutex<std::collections::HashMap<std::path::PathBuf, RecoveryGate>> {
        static GATES: OnceLock<Mutex<std::collections::HashMap<std::path::PathBuf, RecoveryGate>>> = OnceLock::new();
        GATES.get_or_init(Default::default)
    }
    pub(super) fn local_recovery_pause(s: &DaemonState) -> Option<crate::credentials::TestTaskDone> {
        local_recovery_gates().lock().unwrap().remove(&s.app_dir).map(|gate| {
            let _ = gate.entered.send(());
            let _ = gate.release.recv();
            crate::credentials::TestTaskDone(gate.done)
        })
    }
    pub(super) fn jmap_ledger_pause(s: &DaemonState) -> Option<crate::credentials::TestTaskDone> {
        jmap_ledger_gates().lock().unwrap().remove(&s.app_dir).map(|gate| {
            let _ = gate.entered.send(());
            let _ = gate.release.recv();
            crate::credentials::TestTaskDone(gate.done)
        })
    }
    pub(super) fn capture_pause(s: &DaemonState) -> Option<crate::credentials::TestTaskDone> {
        capture_gates().lock().unwrap().remove(&s.app_dir).map(|gate| {
            let _ = gate.entered.send(());
            let _ = gate.release.recv();
            crate::credentials::TestTaskDone(gate.done)
        })
    }
    pub(super) fn recovery_pause(s: &DaemonState) -> Option<crate::credentials::TestTaskDone> {
        recovery_gates().lock().unwrap().remove(&s.app_dir).map(|gate| {
            let _ = gate.entered.send(());
            let _ = gate.release.recv();
            crate::credentials::TestTaskDone(gate.done)
        })
    }
    struct RecoveryPause {
        release: Option<mpsc::Sender<()>>,
        entered: mpsc::Receiver<()>,
        done: Option<mpsc::Receiver<()>>,
    }
    impl RecoveryPause {
        fn arm(s: &DaemonState) -> Self {
            let (entered, notice) = mpsc::channel();
            let (release, resume) = mpsc::channel();
            let (done, finished) = mpsc::channel();
            recovery_gates().lock().unwrap().insert(s.app_dir.clone(), RecoveryGate { entered, release: resume, done });
            Self { release: Some(release), entered: notice, done: Some(finished) }
        }
        fn arm_capture(s: &DaemonState) -> Self {
            let (entered, notice) = mpsc::channel();
            let (release, resume) = mpsc::channel();
            let (done, finished) = mpsc::channel();
            capture_gates().lock().unwrap().insert(s.app_dir.clone(), RecoveryGate { entered, release: resume, done });
            Self { release: Some(release), entered: notice, done: Some(finished) }
        }
        fn arm_jmap_ledger(s: &DaemonState) -> Self {
            let (entered, notice) = mpsc::channel();
            let (release, resume) = mpsc::channel();
            let (done, finished) = mpsc::channel();
            jmap_ledger_gates().lock().unwrap().insert(s.app_dir.clone(), RecoveryGate { entered, release: resume, done });
            Self { release: Some(release), entered: notice, done: Some(finished) }
        }
        fn arm_local(s: &DaemonState) -> Self {
            let (entered, notice) = mpsc::channel();
            let (release, resume) = mpsc::channel();
            let (done, finished) = mpsc::channel();
            local_recovery_gates().lock().unwrap().insert(s.app_dir.clone(), RecoveryGate { entered, release: resume, done });
            Self { release: Some(release), entered: notice, done: Some(finished) }
        }
        fn entered(&self) { self.entered.recv_timeout(Duration::from_secs(5)).expect("remote recover accepted"); }
        fn finish(&mut self) {
            self.release.take();
            self.done.take().unwrap().recv_timeout(Duration::from_secs(5)).expect("actual recovery completed");
        }
    }
    impl Drop for RecoveryPause {
        fn drop(&mut self) {
            self.release.take();
            if let Some(done) = self.done.take() {
                if done.recv_timeout(Duration::from_secs(5)).is_err() { std::process::abort(); }
            }
        }
    }

    fn lifecycle_lease(id: &str) -> crate::account_workflows::AccountLease {
        crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: [id.to_owned()].into(), ..Default::default() },
        )
    }

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
        std::fs::write(s.app_dir.join("accounts.json"), r#"[{"id":"acc1"},{"id":"other"}]"#).unwrap();
        s.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&s.app_dir)).unwrap());
        let config: ImapConfig = serde_json::from_value(account(server)).unwrap();
        s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), config);
        // The list row the app showed, as a sync leaves it.
        let headers = json!({"emails": [{"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]}]}).to_string();
        crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();
        s
    }

    async fn delete(s: &Arc<DaemonState>, server: &MockImap, permanent: bool) -> RpcResponse {
        handle_request_for_test(s, "imap_delete_email", json!({"account": account(server), "uid": 1, "mailbox": "INBOX", "mode": if permanent { "permanent" } else { "trash" }})).await
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p3_capture_refuses_bin_publication_after_original_account_retires() {
        let server = server(Scenario::new());
        let s = state(&server);
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 1, RAW.as_bytes(), &[], false)).unwrap();
        let mut pause = RecoveryPause::arm_capture(&s);
        let (done, completed) = mpsc::channel();
        let st = s.clone();
        let waiter = tokio::spawn(async move {
            let result = capture(&st, "acc1", "INBOX", 1, Source::Local).await;
            let _ = done.send(result);
        });
        pause.entered();
        drop(waiter);
        let mut claim = s.account_lifecycle.try_close(lifecycle_lease("acc1"), "acc1").unwrap();
        let drained = claim.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
        let other = s.account_lifecycle.capture("other").unwrap();
        assert!(s.account_lifecycle.try_commit(&[other]).is_ok(), "unrelated B remains writable");
        pause.finish();
        let result = completed.recv_timeout(Duration::from_secs(5)).unwrap();
        let bin_rows = binned(&s).len();
        assert!(result.is_err() && bin_rows == 0,
            "retired capture published bin row or bytes: result={result:?} bin_rows={bin_rows}");
    }

    #[tokio::test]
    async fn p3_retired_bin_helpers_and_discard_preserve_exact_copy() {
        let server = server(Scenario::new());
        let s = state(&server);
        let row = json!({"uid":1,"messageId":"<keep1@example.com>","subject":"Keep me"});
        let proof = Capture { account_id: "acc1", mailbox: "INBOX", uid: 1, message_id: Some("<keep1@example.com>"), flags: &[], row: &row, deleted_at: now_ms() };
        let (id, _) = app_db::with(&s.app_dir, |c| bin::capture(c, &s.app_dir, &proof, Some(RAW.as_bytes()))).unwrap();
        let mut claim = s.account_lifecycle.try_close(lifecycle_lease("acc1"), "acc1").unwrap();
        let drained = claim.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
        landed(&s, id.clone(), Some("Trash".into()), Some(9)).await;
        let after_landed = app_db::with(&s.app_dir, |c| bin::get(c, &id)).unwrap();
        forget(&s, id.clone()).await;
        let discarded = handle_request_for_test(&s, "deleted.discard", json!({"ids":[id.clone()]})).await;
        let retained = app_db::with(&s.app_dir, |c| bin::get(c, &id)).unwrap();
        let bytes = bin::read_eml(&s.app_dir, &id).ok();
        assert!(after_landed.as_ref().is_some_and(|row| row.trash.is_none())
            && discarded.error.is_some() && retained.is_some() && bytes.as_deref() == Some(RAW.as_bytes()),
            "retired bin helper or discard changed exact copy: after_landed={after_landed:?} discarded={discarded:?} retained={retained:?} bytes={bytes:?}");
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
        let r = handle_request_for_test(&s, "imap_delete_email", json!({"account": account(&server), "uid": 1, "mailbox": "INBOX", "mode": "permanent", "bin": false})).await;
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p3_server_recovery_owner_survives_provider_and_local_children() {
        let server = server(Scenario::new());
        let s = state(&server);
        delete(&s, &server, false).await.result.expect("deleted");
        let mut pause = RecoveryPause::arm(&s);
        let (done, completed) = mpsc::channel();
        let st = s.clone();
        let waiter = tokio::spawn(async move {
            let result = recover(&st, "server").await;
            let _ = done.send(result);
        });
        pause.entered();
        assert_eq!(uids(&server, "INBOX").len(), 1, "provider MOVE accepted before pause");
        drop(waiter);
        let mut claim = match s.account_lifecycle.try_close(lifecycle_lease("acc1"), "acc1") {
            Ok(claim) => Some(claim),
            Err(crate::account_lifecycle::LifecycleError::Busy) => None,
            Err(error) => panic!("unexpected close result: {error:?}"),
        };
        let early = if let Some(held) = claim.as_ref() {
            let premature = tokio::time::timeout(Duration::from_millis(50),
                held.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5))).await;
            if let Ok(Ok(drained)) = premature {
                claim.as_mut().unwrap().mark_effects_started(drained).unwrap();
                claim.take().unwrap().finish_retired().unwrap();
                true
            } else { false }
        } else { false };
        let other = s.account_lifecycle.capture("other").unwrap();
        assert!(s.account_lifecycle.try_commit(&[other]).is_ok(), "unrelated account remains usable");
        pause.finish();
        let result = completed.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut remaining = claim.take().unwrap_or_else(|| s.account_lifecycle.try_close(lifecycle_lease("acc1"), "acc1").unwrap());
        let drained = remaining.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
        remaining.mark_effects_started(drained).unwrap();
        remaining.finish_retired().unwrap();
        let bin_rows = binned(&s).len();
        assert!(!early && result["failed"] == json!([]) && bin_rows == 0,
            "provider recovery escaped account owner: early={early} result={result:?} bin_rows={bin_rows}");
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p3_local_recovery_rechecks_original_after_trash_download() {
        let server = server(Scenario::new());
        let s = state(&server);
        delete(&s, &server, false).await.result.expect("deleted into Trash");
        let mut pause = RecoveryPause::arm_local(&s);
        let (done, completed) = mpsc::channel();
        let st = s.clone();
        let waiter = tokio::spawn(async move { let _ = done.send(recover(&st, "local").await); });
        pause.entered();
        assert_eq!(server.count_commands("BODY.PEEK[]"), 1, "Trash body downloaded before pause");
        drop(waiter);
        let mut claim = s.account_lifecycle.try_close(lifecycle_lease("acc1"), "acc1").unwrap();
        let drained = claim.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
        pause.finish();
        let result = completed.recv_timeout(Duration::from_secs(5)).unwrap();
        let file = mailvault_core::message_store::read_raw(&s.data_dir, "acc1", "INBOX", 1).unwrap();
        let custody = crate::custody::with_conn(&s, |c| entries::get(c, "acc1", "INBOX", 1)).unwrap();
        assert!(result["recovered"] == json!([]) && result["failed"].as_array().is_some_and(|v| v.len() == 1)
            && file.is_none() && custody.is_none() && binned(&s).len() == 1,
            "late local recovery published after retirement: result={result:?} file={} custody={custody:?} bin={:?}", file.is_some(), binned(&s));
        let other = s.account_lifecycle.capture("other").unwrap();
        assert!(s.account_lifecycle.try_commit(&[other]).is_ok());
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
        std::fs::write(s.app_dir.join("accounts.json"), r#"[{"id":"acct1"}]"#).unwrap();
        s.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&s.app_dir)).unwrap());
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
        handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": e1, "mailbox": "INBOX", "mode": "trash"}))
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
        handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": e2, "mailbox": "INBOX", "mode": "permanent"}))
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p3_jmap_recovery_import_and_relabel_keep_owner_through_ledger_and_bin() {
        use crate::jmap_test_support as support;
        for import in [false, true] {
            let m = mock_jmap::MockJmap::start(support::scenario());
            let (trap, port) = support::imap_trap();
            let (s, e1, e2) = jmap_state(&m, port).await;
            let uid = if import { e2 } else { e1 };
            handle_request_for_test(&s, "imap_delete_email", json!({
                "account": support::account_json(&m, port), "uid": uid, "mailbox": "INBOX", "mode": if import { "permanent" } else { "trash" }
            })).await.result.expect("deleted before recovery");
            let mut pause = RecoveryPause::arm_jmap_ledger(&s);
            let (done, completed) = mpsc::channel();
            let st = s.clone();
            let waiter = tokio::spawn(async move { let _ = done.send(recover(&st, "server").await); });
            pause.entered();
            drop(waiter);
            if import {
                assert_eq!(m.count_calls("Email/import"), 1, "server import accepted before ledger pause");
                assert!(support::emails_in(&m, "mb-inbox").iter().any(|e| e.raw == support::raw("e2", "two")), "imported body is on server");
            } else {
                assert!(jmap_labels(&m, "e1").contains("mb-inbox"), "server relabel accepted before ledger pause");
                assert_eq!(m.count_calls("Email/import"), 0);
            }
            assert_eq!(binned(&s).len(), 1, "bin remains until ledger and local child complete");
            assert!(matches!(s.account_lifecycle.try_close(lifecycle_lease("acct1"), "acct1"), Err(crate::account_lifecycle::LifecycleError::Busy)), "JMAP recovery owns account through ledger child");
            pause.finish();
            let result = completed.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(result["failed"], json!([]), "recovery result: {result:?}");
            assert!(binned(&s).is_empty(), "bin removed after complete recovery");
            let mut claim = s.account_lifecycle.try_close(lifecycle_lease("acct1"), "acct1").unwrap();
            let drained = claim.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
            claim.mark_effects_started(drained).unwrap();
            claim.finish_retired().unwrap();
            assert!(trap.accept().is_err(), "JMAP recovery dialled IMAP");
        }
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let (s, _, e2) = jmap_state(&m, port).await;
        handle_request_for_test(&s, "imap_delete_email", json!({
            "account": support::account_json(&m, port), "uid": e2, "mailbox": "INBOX", "mode": "permanent"
        })).await.result.expect("deleted before close");
        let mut claim = s.account_lifecycle.try_close(lifecycle_lease("acct1"), "acct1").unwrap();
        let drained = claim.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();
        let before = m.requests().len();
        let result = recover(&s, "server").await;
        assert_eq!(result["recovered"], json!([]));
        assert_eq!(m.requests().len(), before, "retired recovery sent a provider request");
        assert_eq!(binned(&s).len(), 1, "retired bin remains for later authority");
        assert!(trap.accept().is_err());
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

    /// Two copies of one Message-ID: a recover relabels the copy the bin row's
    /// uid names through the mailbox ledger, not whichever copy the search
    /// lists first. Either order of the two deletes would go wrong for a
    /// first-hit pick, so both are run.
    #[tokio::test]
    async fn jmap_recover_relabels_the_copy_the_bin_rows_uid_names() {
        use crate::jmap_test_support as support;
        let mut scenario = support::scenario();
        for (id, received) in [("ca", "2026-10-05T10:00:00Z"), ("cb", "2026-10-06T10:00:00Z")] {
            let mut e = support::email(id, id, received);
            e.raw = e.raw.replace(&format!("<{id}@x>"), "<dup@x>");
            scenario.accounts[0].mailboxes[0].emails.push(e);
        }
        let m = mock_jmap::MockJmap::start(scenario);
        let (trap, port) = support::imap_trap();
        let (s, _, _) = jmap_state(&m, port).await;
        let listing = handle_request_for_test(&s, "imap_get_emails", json!({"account": support::account_json(&m, port), "mailbox": "INBOX", "page": 1, "limit": 50}))
            .await
            .result
            .expect("listed");
        let uid_of = |subject: &str| listing["emails"].as_array().unwrap().iter().find(|e| e["subject"] == subject).unwrap()["uid"].as_u64().unwrap() as u32;
        for copy in ["ca", "cb"] {
            handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": uid_of(copy), "mailbox": "INBOX", "mode": "trash"}))
                .await
                .result
                .expect("deleted");
            assert_eq!(jmap_labels(&m, copy), support::set(&["mb-trash"]), "{copy} sits in Trash");

            let out = recover(&s, "server").await;

            assert_eq!(out["failed"], json!([]), "{copy}");
            assert_eq!(jmap_labels(&m, copy), support::set(&["mb-inbox"]), "{copy} is the copy that came back");
            assert_eq!(out["recovered"][0]["uid"], json!(uid_of(copy)), "{copy} under its own uid");
        }
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
        handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": e1, "mailbox": "INBOX", "mode": "trash"}))
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

    /// Task 7: in a JMAP vault the bin's capture of a vault-held message is
    /// still `deleted/<id>.eml`, the message's exact bytes, read from the blob.
    #[tokio::test]
    async fn deleted_bin_capture_stays_eml() {
        let server = server(Scenario::new());
        let s = state(&server);
        mailvault_core::message_store::set_vault_format(&s.data_dir, mailvault_core::message_store::Format::Jmap).unwrap();
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 1, RAW.as_bytes(), &[], false)).unwrap();
        assert!(mailvault_core::message_store::mailbox_dir(&s.data_dir, "acc1", "INBOX").join("jmap").join("1.json").is_file());
        delete(&s, &server, false).await.result.expect("deleted");
        assert_eq!(server.count_commands("BODY.PEEK[]"), 0, "the vault copy is the capture");
        let rows = binned(&s);
        assert!(rows[0].has_eml);
        let captured = bin::bin_dir(&s.app_dir).join(format!("{}.eml", rows[0].id));
        assert_eq!(std::fs::read(&captured).unwrap(), RAW.as_bytes());
    }

    // ── messages.restore (Task 8: the undo of a delete, in the daemon) ──────

    const RAW2: &str = "From: Bo <bo@example.com>\r\nTo: user@example.com\r\nSubject: Keep me too\r\n\
                        Date: Fri, 02 Jan 2015 00:00:00 +0000\r\nMessage-ID: <keep2@example.com>\r\n\r\nThe other body.\r\n";

    /// INBOX holds 1 (RAW) and 2 (RAW2), and the header cache lists both.
    fn server2() -> MockImap {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
        inbox.add(Message::new(2, RAW2));
        MockImap::start(Scenario::new().mailbox(inbox).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])))
    }

    /// `server2` with faults.
    fn server2_with(scenario: Scenario) -> MockImap {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
        inbox.add(Message::new(2, RAW2));
        MockImap::start(scenario.mailbox(inbox).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])))
    }

    fn state2(server: &MockImap) -> Arc<DaemonState> {
        let s = state(server);
        let headers = json!({"emails": [
            {"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]},
            {"uid": 2, "messageId": "<keep2@example.com>", "subject": "Keep me too", "flags": []},
        ]}).to_string();
        crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();
        s
    }

    /// One delete to Trash of INBOX `uid`, answered as the app's undo record keeps it.
    async fn delete_to_trash(s: &Arc<DaemonState>, server: &MockImap, uid: u32, mid: &str) -> Value {
        let r = handle_request_for_test(s, "imap_delete_email", json!({"account": account(server), "uid": uid, "mailbox": "INBOX", "mode": "trash"}))
            .await
            .result
            .expect("deleted");
        json!({"accountId": "acc1", "mailbox": "INBOX", "uid": uid, "trash": r["trash"], "trashUid": r["trashUid"], "messageId": mid, "binId": r["binId"]})
    }

    async fn restore(s: &Arc<DaemonState>, items: Vec<Value>) -> Value {
        handle_request_for_test(s, "messages.restore", json!({"items": items})).await.result.expect("answered")
    }

    fn new_uid_of(out: &Value, uid: u32) -> u32 {
        out["restored"].as_array().unwrap().iter().find(|r| r["uid"] == json!(uid)).unwrap_or_else(|| panic!("uid {uid} restored: {out}"))["newUid"]
            .as_u64()
            .unwrap_or_else(|| panic!("uid {uid} has a new uid: {out}")) as u32
    }

    fn cached(s: &DaemonState, account: &str, mailbox: &str, uid: u32) -> Option<Value> {
        crate::custody::with_conn(s, |c| cache::load_by_uids(c, account, mailbox, &[uid])).unwrap().into_iter().next()
    }

    fn inbox_raw(server: &MockImap, uid: u32) -> Vec<u8> {
        server.state().find("INBOX").unwrap().messages.iter().find(|m| m.uid == uid).expect("in INBOX").raw.clone()
    }

    /// Two messages of one folder in one Trash: one MOVE back, not one per
    /// message, and each old uid paired with the uid its own copy got. They
    /// are deleted in the reverse order, so the Trash uids run the other way
    /// round from the INBOX uids: a pairing by position would swap them.
    #[tokio::test]
    async fn restore_moves_a_group_back_in_one_move_and_pairs_each_uid_with_its_own_copy() {
        let server = server2();
        let s = state2(&server);
        let second = delete_to_trash(&s, &server, 2, "<keep2@example.com>").await;
        let first = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        assert!(first["trashUid"].as_u64() > second["trashUid"].as_u64(), "{first} {second}");
        let moves = server.count_commands("UID MOVE");

        let out = restore(&s, vec![first, second]).await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(server.count_commands("UID MOVE") - moves, 1, "one MOVE for the group");
        assert!(uids(&server, "Trash").is_empty());
        let (one, two) = (new_uid_of(&out, 1), new_uid_of(&out, 2));
        assert_eq!(inbox_raw(&server, one), RAW.as_bytes(), "uid 1's new uid names its own message");
        assert_eq!(inbox_raw(&server, two), RAW2.as_bytes());
        for r in out["restored"].as_array().unwrap() {
            assert_eq!((r["accountId"].clone(), r["mailbox"].clone()), (json!("acc1"), json!("INBOX")));
        }
        // The header cache lists them under the new uids, the old ones gone.
        assert_eq!(cached(&s, "acc1", "INBOX", one).expect("row under the new uid")["subject"], json!("Keep me"));
        assert_eq!(cached(&s, "acc1", "INBOX", two).expect("row under the new uid")["subject"], json!("Keep me too"));
        assert!(cached(&s, "acc1", "INBOX", 1).is_none() && cached(&s, "acc1", "INBOX", 2).is_none(), "the retired uids are pruned");
        assert!(binned(&s).is_empty(), "back on the server: the bin copies are dropped");
    }

    /// A server that named no Trash uid (no UIDPLUS, or an already-gone uid:
    /// `Deleted{trash: Some, trash_uid: None}`): the copy is found by its
    /// Message-ID in Trash and moved back (Review Focus 11).
    #[tokio::test]
    async fn restore_without_a_trash_uid_finds_the_copy_by_message_id() {
        let server = server(Scenario::new());
        let s = state(&server);
        let mut item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        item["trashUid"] = Value::Null;

        let out = restore(&s, vec![item]).await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert!(uids(&server, "Trash").is_empty(), "moved out of Trash");
        assert_eq!(inbox_raw(&server, new_uid_of(&out, 1)), RAW.as_bytes());
        assert_eq!(server.count_commands("APPEND"), 0);
        assert!(binned(&s).is_empty());
    }

    /// Trash no longer holds the copy: the bin's bytes are APPENDed back to
    /// the folder it left, with its flags (Review Focus 12).
    #[tokio::test]
    async fn restore_falls_back_to_the_bin_copy_when_trash_lost_it() {
        let server = server(Scenario::new());
        let s = state(&server);
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 1, RAW.as_bytes(), &[], false)).unwrap();
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        assert!(binned(&s)[0].has_eml);
        server.mutate(|st| st.find_mut("Trash").unwrap().messages.clear());

        let out = restore(&s, vec![item]).await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(server.count_commands("APPEND"), 1);
        let back = new_uid_of(&out, 1);
        assert_eq!(inbox_raw(&server, back), RAW.as_bytes());
        assert!(server.state().find("INBOX").unwrap().messages[0].has_flag("\\Seen"), "the flags go back with it");
        assert_eq!(cached(&s, "acc1", "INBOX", back).expect("row under the new uid")["subject"], json!("Keep me"));
        assert!(binned(&s).is_empty());
    }

    /// Trash lost it and the bin holds nothing to put back: a catalog key
    /// says so, never the server's text, and the bin row stays (it is
    /// discarded only once the message is back).
    #[tokio::test]
    async fn restore_with_no_copy_anywhere_fails_with_a_catalog_reason_and_keeps_the_bin_row() {
        let server = server(Scenario::new());
        let s = state(&server);
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        assert!(!binned(&s)[0].has_eml, "a byte-less row: Trash was all it had");
        server.mutate(|st| st.find_mut("Trash").unwrap().messages.clear());
        let mut unbinned = item.clone();
        unbinned["binId"] = Value::Null;

        for one in [unbinned, item] {
            let out = restore(&s, vec![one]).await;
            assert_eq!(out["restored"], json!([]), "{out}");
            assert_eq!(out["failed"], json!([{"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "error": "deletedBin.goneFromTrash"}]));
        }
        assert_eq!(binned(&s).len(), 1, "kept: nothing came back");
        assert_eq!(server.count_commands("APPEND"), 0);
    }

    /// A MOVE the server refuses fails the group in catalog words, and keeps
    /// the bin copies for a later try.
    #[tokio::test]
    async fn restore_refused_by_the_server_fails_in_catalog_words() {
        let server = server(Scenario::new().fault(Trigger::with("MOVE", "\"INBOX\""), Action::RefuseWith("NO".into(), "no route".into())));
        let s = state(&server);
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 1, RAW.as_bytes(), &[], false)).unwrap();
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let out = restore(&s, vec![item]).await;
        assert_eq!(out["restored"], json!([]), "{out}");
        assert_eq!(out["failed"][0]["error"], json!("deletedBin.recoverFailed"));
        assert_eq!(uids(&server, "Trash").len(), 1, "still in Trash");
        assert_eq!(server.count_commands("APPEND"), 0, "never a second copy beside the one Trash still holds");
        assert_eq!(binned(&s).len(), 1);
    }

    /// A server without UIDPLUS names no uid for the copy it moved back: the
    /// item is restored with `newUid: null` (the app reloads to learn it) and
    /// the custody stamp comes off the entry under the old uid. Nothing proves
    /// which message left Trash, so the bin copy stays; a later recover finds
    /// the message back in its folder and appends nothing.
    #[tokio::test]
    async fn restore_on_a_server_that_names_no_uid_answers_null_and_still_lifts_the_stamp() {
        let server = server(Scenario::new().without_cap("UIDPLUS"));
        let s = state(&server);
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        assert_eq!(item["trashUid"], Value::Null, "no COPYUID: {item}");
        let entry = json!({"uid": 1, "message_id": "<keep1@example.com>", "subject": "Keep me", "source": "local", "serverDeleted": true});
        crate::custody::with_conn(&s, |c| entries::upsert(c, "acc1", "INBOX", &[entry])).unwrap();

        let out = restore(&s, vec![item]).await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(out["restored"], json!([{"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "newUid": null}]));
        assert_eq!(uids(&server, "INBOX").len(), 1, "back on the server");
        let custody = crate::custody::with_conn(&s, |c| entries::get(c, "acc1", "INBOX", 1)).unwrap().expect("custody entry");
        assert_eq!(custody["serverDeleted"], json!(false));
        assert_eq!(binned(&s).len(), 1, "unproved: the bin copy stays");

        let again = recover(&s, "server").await;

        assert_eq!(again["failed"], json!([]), "{again}");
        assert_eq!(server.count_commands("APPEND"), 0, "never a second copy");
        assert_eq!(uids(&server, "INBOX").len(), 1);
        assert!(binned(&s).is_empty());
    }

    /// The vault copy the delete left is filed under the new uid, and custody
    /// stops calling it the only copy.
    #[tokio::test]
    async fn restore_rebinds_the_vault_copy_and_lifts_the_custody_stamp() {
        let server = server(Scenario::new());
        let s = state(&server);
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 1, RAW.as_bytes(), &[], false)).unwrap();
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let entry = json!({"uid": 1, "message_id": "<keep1@example.com>", "subject": "Keep me", "source": "local", "serverDeleted": true});
        crate::custody::with_conn(&s, |c| entries::upsert(c, "acc1", "INBOX", &[entry])).unwrap();

        let out = restore(&s, vec![item]).await;

        let back = new_uid_of(&out, 1);
        assert_ne!(back, 1);
        assert_eq!(mailvault_core::message_store::read_raw(&s.data_dir, "acc1", "INBOX", back).unwrap().as_deref(), Some(RAW.as_bytes()), "filed under the new uid");
        assert!(mailvault_core::message_store::read_raw(&s.data_dir, "acc1", "INBOX", 1).unwrap().is_none(), "not under the retired one");
        let custody = crate::custody::with_conn(&s, |c| entries::get(c, "acc1", "INBOX", back)).unwrap().expect("custody entry under the new uid");
        assert_eq!(custody["serverDeleted"], json!(false));
    }

    /// Two copies of one Message-ID sit in Trash; the bin row recorded which
    /// one the delete made. `deleted.recover` moves that one back, not the
    /// highest uid a Message-ID search finds.
    #[tokio::test]
    async fn recover_prefers_the_recorded_trash_uid_over_a_message_id_search() {
        let server = server(Scenario::new());
        let s = state(&server);
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let recorded = item["trashUid"].as_u64().expect("COPYUID") as u32;
        let dup = RAW.replace("Subject: Keep me", "Subject: Another copy");
        server.mutate(|st| { st.find_mut("Trash").unwrap().add(Message::new(recorded + 5, dup.clone())); });

        let out = recover(&s, "server").await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(uids(&server, "Trash"), vec![recorded + 5], "the other copy stays");
        let inbox = server.state().find("INBOX").unwrap().messages.clone();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].raw, RAW.as_bytes(), "the copy this delete made came back");
    }

    /// The same for `messages.restore`: the recorded Trash uid wins.
    #[tokio::test]
    async fn restore_moves_the_recorded_trash_uid_not_a_duplicate() {
        let server = server(Scenario::new());
        let s = state(&server);
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let recorded = item["trashUid"].as_u64().unwrap() as u32;
        let dup = RAW.replace("Subject: Keep me", "Subject: Another copy");
        server.mutate(|st| { st.find_mut("Trash").unwrap().add(Message::new(recorded + 5, dup.clone())); });

        let out = restore(&s, vec![item]).await;

        assert_eq!(uids(&server, "Trash"), vec![recorded + 5]);
        assert_eq!(inbox_raw(&server, new_uid_of(&out, 1)), RAW.as_bytes());
    }

    /// A JMAP account: one move per group over its session, answered in the
    /// order sent (positional), and a label put back keeps the uid it had,
    /// so its header row comes back under that uid with nothing pruned.
    #[tokio::test]
    async fn jmap_restore_pairs_by_position_and_keeps_the_uid_a_label_put_back() {
        use crate::jmap_test_support as support;
        let mut scenario = support::scenario();
        for (id, received) in [("ca", "2026-10-05T10:00:00Z"), ("cb", "2026-10-06T10:00:00Z")] {
            scenario.accounts[0].mailboxes[0].emails.push(support::email(id, id, received));
        }
        let m = mock_jmap::MockJmap::start(scenario);
        let (trap, port) = support::imap_trap();
        let (s, _, _) = jmap_state(&m, port).await;
        let listing = handle_request_for_test(&s, "imap_get_emails", json!({"account": support::account_json(&m, port), "mailbox": "INBOX", "page": 1, "limit": 50}))
            .await
            .result
            .expect("listed");
        let uid_of = |subject: &str| listing["emails"].as_array().unwrap().iter().find(|e| e["subject"] == subject).unwrap()["uid"].as_u64().unwrap() as u32;
        // The higher INBOX uid goes to Trash first, so it gets the lower Trash uid.
        let (low, high) = if uid_of("ca") < uid_of("cb") { ("ca", "cb") } else { ("cb", "ca") };
        let mut items = Vec::new();
        for copy in [high, low] {
            let r = handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": uid_of(copy), "mailbox": "INBOX", "mode": "trash"}))
                .await
                .result
                .expect("deleted");
            assert_eq!(r["trash"], json!("Trash"), "{copy} went to Trash: {r}");
            items.push(json!({"accountId": "acct1", "mailbox": "INBOX", "uid": uid_of(copy), "trash": r["trash"], "trashUid": r["trashUid"], "messageId": format!("<{copy}@x>"), "binId": r["binId"]}));
        }
        assert!(items[0]["trashUid"].as_u64() < items[1]["trashUid"].as_u64(), "{items:?}");

        let out = restore(&s, items).await;

        assert_eq!(out["failed"], json!([]), "{out}");
        for copy in [low, high] {
            assert_eq!(jmap_labels(&m, copy), support::set(&["mb-inbox"]), "{copy} is back in INBOX only");
            assert_eq!(new_uid_of(&out, uid_of(copy)), uid_of(copy), "{copy} keeps its ledger uid");
            assert_eq!(cached(&s, "acct1", "INBOX", uid_of(copy)).expect("row back under its uid")["subject"], json!(copy));
        }
        assert!(binned(&s).is_empty());
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    // ── messages.restore, fix round 1 ───────────────────────────────────────

    /// One group, two messages: Trash still holds the first, the second's
    /// Trash copy is gone but the bin kept its bytes. One MOVE for the first,
    /// one APPEND for the second, both answered with their new uids.
    #[tokio::test]
    async fn restore_moves_what_trash_holds_and_appends_the_rest_in_one_call() {
        let server = server2();
        let s = state2(&server);
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 2, RAW2.as_bytes(), &[], false)).unwrap();
        let first = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let second = delete_to_trash(&s, &server, 2, "<keep2@example.com>").await;
        let gone = second["trashUid"].as_u64().unwrap() as u32;
        server.mutate(|st| st.find_mut("Trash").unwrap().messages.retain(|m| m.uid != gone));
        let (moves, appends) = (server.count_commands("UID MOVE"), server.count_commands("APPEND"));

        let out = restore(&s, vec![first, second]).await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(server.count_commands("UID MOVE") - moves, 1);
        assert_eq!(server.count_commands("APPEND") - appends, 1);
        assert_eq!(inbox_raw(&server, new_uid_of(&out, 1)), RAW.as_bytes());
        assert_eq!(inbox_raw(&server, new_uid_of(&out, 2)), RAW2.as_bytes());
        assert!(binned(&s).is_empty());
    }

    /// A MOVE the server refuses fails only what it would have moved: an item
    /// Trash no longer holds still goes back from its bin copy.
    #[tokio::test]
    async fn a_refused_move_still_puts_back_from_the_bin_what_trash_lost() {
        let server = server2_with(Scenario::new().fault(Trigger::with("MOVE", "\"INBOX\""), Action::RefuseWith("NO".into(), "no route".into())));
        let s = state2(&server);
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 2, RAW2.as_bytes(), &[], false)).unwrap();
        let first = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let second = delete_to_trash(&s, &server, 2, "<keep2@example.com>").await;
        let gone = second["trashUid"].as_u64().unwrap() as u32;
        server.mutate(|st| st.find_mut("Trash").unwrap().messages.retain(|m| m.uid != gone));

        let out = restore(&s, vec![first, second]).await;

        assert_eq!(out["failed"], json!([{"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "error": "deletedBin.recoverFailed"}]), "{out}");
        assert_eq!(inbox_raw(&server, new_uid_of(&out, 2)), RAW2.as_bytes(), "the bin copy went back");
        assert_eq!(uids(&server, "Trash").len(), 1, "the refused one is still in Trash");
        assert_eq!(binned(&s).len(), 1, "only the refused one's bin row stays");
    }

    /// COPYUID names fewer uids than were sent (a copy left Trash between the
    /// SEARCH and the MOVE): nothing is paired by guess. Trash is checked
    /// again; what left it answers back with no uid and keeps its bin row
    /// (a later recover finds it by Message-ID and appends nothing).
    #[tokio::test]
    async fn a_short_copyuid_pairs_nothing_and_keeps_the_bin_rows() {
        let raw = "* OK [COPYUID 1 1 9] Moved\r\n{tag} OK MOVE completed\r\n".to_string();
        let server = server2_with(Scenario::new().fault(Trigger::with("MOVE", "\"INBOX\""), Action::RespondRaw(raw)));
        let s = state2(&server);
        let first = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let second = delete_to_trash(&s, &server, 2, "<keep2@example.com>").await;

        let out = restore(&s, vec![first, second]).await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(out["restored"], json!([
            {"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "newUid": null},
            {"accountId": "acc1", "mailbox": "INBOX", "uid": 2, "newUid": null},
        ]));
        assert_eq!(binned(&s).len(), 2, "unproved: the bin copies stay");
    }

    /// A group still on the wire past the budget answers
    /// `deletedBin.restoreTimedOut` and keeps its bin row. Its MOVE lands
    /// later; a recover then finds the message back in its folder by
    /// Message-ID and appends nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_timed_out_restore_keeps_the_bin_row_and_a_later_recover_appends_nothing() {
        let server = server(Scenario::new().fault(Trigger::with("MOVE", "\"INBOX\""), Action::Delay(Duration::from_millis(1500))));
        let s = state(&server);
        with_mailbox_write(&s, "acc1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acc1", "INBOX", 1, RAW.as_bytes(), &[], false)).unwrap();
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        set_restore_budget_for_test(&s, Duration::from_millis(300));

        let out = restore(&s, vec![item]).await;

        assert_eq!(out["failed"], json!([{"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "error": "deletedBin.restoreTimedOut"}]), "{out}");
        assert_eq!(binned(&s).len(), 1);
        for _ in 0..50 {
            if uids(&server, "INBOX").len() == 1 { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(uids(&server, "INBOX").len(), 1, "the delayed MOVE landed");
        let appends = server.count_commands("APPEND");

        let again = recover(&s, "server").await;

        assert_eq!(again["failed"], json!([]), "{again}");
        assert_eq!(server.count_commands("APPEND"), appends, "never a second copy");
        assert_eq!(uids(&server, "INBOX").len(), 1);
        assert!(binned(&s).is_empty());
    }

    /// A message already back in the folder it left (an earlier restore that
    /// landed after its answer was lost): a recover finds it by Message-ID,
    /// answers its uid and drops the bin row, and appends nothing.
    #[tokio::test]
    async fn recover_finds_a_copy_already_back_in_its_folder_and_appends_nothing() {
        let server = server(Scenario::new());
        let s = state(&server);
        delete(&s, &server, true).await.result.expect("deleted");
        server.mutate(|st| { st.find_mut("INBOX").unwrap().add(Message::new(50, RAW)); });

        let out = recover(&s, "server").await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(out["recovered"][0]["uid"], json!(50));
        assert_eq!(server.count_commands("APPEND"), 0);
        assert_eq!(uids(&server, "INBOX"), vec![50]);
        assert!(binned(&s).is_empty());
    }

    /// One bin row is put back by one caller at a time: while a recover holds
    /// it, a restore or a second recover naming it is refused at once, in
    /// catalog words, with nothing sent to the server.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_bin_row_being_put_back_is_refused_to_a_second_caller() {
        let server = server(Scenario::new());
        let s = state(&server);
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let mut pause = RecoveryPause::arm(&s);
        let (done, completed) = mpsc::channel();
        let st = s.clone();
        let first = tokio::spawn(async move { let _ = done.send(recover(&st, "server").await); });
        pause.entered();
        let (moves, searches) = (server.count_commands("UID MOVE"), server.count_commands("SEARCH"));

        let restored = restore(&s, vec![item]).await;
        let recovered = recover(&s, "server").await;

        assert_eq!(restored["failed"], json!([{"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "error": "deletedBin.recoverBusy"}]), "{restored}");
        assert_eq!(recovered["failed"][0]["error"], json!("deletedBin.recoverBusy"), "{recovered}");
        assert_eq!((server.count_commands("UID MOVE"), server.count_commands("SEARCH")), (moves, searches), "nothing sent");
        pause.finish();
        let _ = first.await;
        assert_eq!(completed.recv_timeout(Duration::from_secs(5)).unwrap()["failed"], json!([]));
        assert_eq!(uids(&server, "INBOX").len(), 1, "one copy back");
    }

    /// A uid the delete queue still owes is not put back: its queued delete
    /// would take it again (a JMAP label put back keeps its uid). The item
    /// says so in catalog words and nothing is sent.
    #[tokio::test]
    async fn restore_refuses_a_uid_the_delete_queue_still_owes() {
        let server = server(Scenario::new());
        let s = state(&server);
        let item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        mailvault_core::op_journal::queue_delete(&s.app_dir, "acc1", "INBOX", &[1], &json!({})).unwrap();
        let moves = server.count_commands("UID MOVE");

        let out = restore(&s, vec![item]).await;

        assert_eq!(out["failed"], json!([{"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "error": "deletedBin.deleteStillQueued"}]), "{out}");
        assert_eq!(server.count_commands("UID MOVE"), moves);
        assert_eq!(uids(&server, "Trash").len(), 1);
        assert_eq!(binned(&s).len(), 1);
    }

    /// JMAP: the server takes fewer emails out of Trash than it was sent and
    /// does not say which. Trash is checked again: the one still there fails
    /// and keeps its bin row and custody stamp; the one that left answers
    /// back with no uid, its bin row kept (unproved).
    #[tokio::test]
    async fn jmap_restore_rechecks_trash_after_a_partial_move() {
        use crate::jmap_test_support as support;
        let mut scenario = support::scenario();
        for (id, received) in [("ca", "2026-10-05T10:00:00Z"), ("cb", "2026-10-06T10:00:00Z")] {
            scenario.accounts[0].mailboxes[0].emails.push(support::email(id, id, received));
        }
        let m = mock_jmap::MockJmap::start(scenario);
        let (trap, port) = support::imap_trap();
        let (s, _, _) = jmap_state(&m, port).await;
        let listing = handle_request_for_test(&s, "imap_get_emails", json!({"account": support::account_json(&m, port), "mailbox": "INBOX", "page": 1, "limit": 50}))
            .await
            .result
            .expect("listed");
        let uid_of = |subject: &str| listing["emails"].as_array().unwrap().iter().find(|e| e["subject"] == subject).unwrap()["uid"].as_u64().unwrap() as u32;
        let mut items = Vec::new();
        for copy in ["ca", "cb"] {
            let r = handle_request_for_test(&s, "imap_delete_email", json!({"account": support::account_json(&m, port), "uid": uid_of(copy), "mailbox": "INBOX", "mode": "trash"}))
                .await
                .result
                .expect("deleted");
            items.push(json!({"accountId": "acct1", "mailbox": "INBOX", "uid": uid_of(copy), "trash": r["trash"], "trashUid": r["trashUid"], "messageId": format!("<{copy}@x>"), "binId": r["binId"]}));
        }
        m.mutate(|st| st.faults.push(mock_jmap::Fault::UpdateNotFound { id: "cb".into() }));

        let out = restore(&s, items).await;

        assert_eq!(out["failed"], json!([{"accountId": "acct1", "mailbox": "INBOX", "uid": uid_of("cb"), "error": "deletedBin.recoverFailed"}]), "{out}");
        assert_eq!(out["restored"], json!([{"accountId": "acct1", "mailbox": "INBOX", "uid": uid_of("ca"), "newUid": null}]));
        assert_eq!(jmap_labels(&m, "ca"), support::set(&["mb-inbox"]));
        assert_eq!(jmap_labels(&m, "cb"), support::set(&["mb-trash"]), "still in Trash");
        assert_eq!(binned(&s).len(), 2, "neither move is proved: both bin rows stay");
        assert!(trap.accept().is_err(), "no IMAP dial");
    }

    /// The header row a restore writes is the app's row (what the list showed
    /// at the delete, its read state included), not the bin's copy of the
    /// header cache, which a flag change just before the delete may not have
    /// reached: marked unread and deleted, it must come back unread, or the
    /// unread count stays one short.
    #[tokio::test]
    async fn restore_writes_the_apps_row_over_the_bins_stale_copy() {
        let server = server(Scenario::new());
        let s = state(&server);
        let mut item = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        assert_eq!(binned(&s)[0].row["flags"], json!(["\\Seen"]), "the bin kept the cache's read row");
        item["row"] = json!({"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": []});

        let out = restore(&s, vec![item]).await;

        let row = cached(&s, "acc1", "INBOX", new_uid_of(&out, 1)).expect("row under the new uid");
        assert_eq!(row["flags"], json!([]), "unread, as the app showed it: {row}");
    }

    // ── fix round 2 ─────────────────────────────────────────────────────────

    /// A duplicate (same Message-ID, delivered twice) sits in the folder with
    /// a HIGHER uid than the deleted copy, and the header cache listed it
    /// before the delete. A recover must not take it for the restored one:
    /// the bin copy is APPENDed, and the twin is left as it was.
    #[tokio::test]
    async fn recover_does_not_claim_a_twin_the_folder_held_before_the_delete() {
        let twin = RAW.replace("Subject: Keep me", "Subject: Twin");
        let server = server(Scenario::new());
        server.mutate(|st| { st.find_mut("INBOX").unwrap().add(Message::new(2, twin.clone())); });
        let s = state(&server);
        let headers = json!({"emails": [
            {"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]},
            {"uid": 2, "messageId": "<keep1@example.com>", "subject": "Twin", "flags": []},
        ]}).to_string();
        crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();
        delete(&s, &server, true).await.result.expect("deleted");
        assert_eq!(uids(&server, "INBOX"), vec![2]);

        let out = recover(&s, "server").await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(server.count_commands("APPEND"), 1, "the bin copy went back");
        let inbox = server.state().find("INBOX").unwrap().messages.clone();
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox.iter().find(|m| m.uid == 2).unwrap().raw, twin.as_bytes(), "the twin is untouched");
        let back = out["recovered"][0]["uid"].as_u64().unwrap() as u32;
        assert!(back > 2, "the appended copy, not the twin: {out}");
        assert!(binned(&s).is_empty());
    }

    /// A twin with a LOWER uid than the deleted copy: a restore that landed
    /// always gets a uid above the retired one, so the twin is never it.
    #[tokio::test]
    async fn recover_does_not_claim_a_twin_with_a_lower_uid() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let twin = RAW.replace("Subject: Keep me", "Subject: Twin");
        let mut inbox = Mailbox::new("INBOX");
        inbox.add(Message::new(1, twin.clone()));
        inbox.add(Message::new(2, RAW).with_flags(&["\\Seen"]));
        let server = MockImap::start(Scenario::new().mailbox(inbox).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])));
        let s = state(&server);
        let headers = json!({"emails": [{"uid": 2, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]}]}).to_string();
        crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();
        handle_request_for_test(&s, "imap_delete_email", json!({"account": account(&server), "uid": 2, "mailbox": "INBOX", "mode": "permanent"})).await.result.expect("deleted");

        let out = recover(&s, "server").await;

        assert_eq!(out["failed"], json!([]), "{out}");
        assert_eq!(server.count_commands("APPEND"), 1);
        assert_eq!(uids(&server, "INBOX").len(), 2);
        assert_ne!(out["recovered"][0]["uid"], json!(1), "not the twin");
        assert!(binned(&s).is_empty());
    }

    /// The check of Trash after a move the server did not fully account for
    /// fails itself: nothing is taken as back. Both items fail in catalog
    /// words and keep their bin rows; nothing is settled.
    #[tokio::test]
    async fn a_failed_recheck_after_a_short_copyuid_settles_nothing() {
        let raw = "* OK [COPYUID 1 1 9] Moved\r\n{tag} OK MOVE completed\r\n".to_string();
        let server = server2_with(Scenario::new()
            .fault(Trigger::with("MOVE", "\"INBOX\""), Action::RespondRaw(raw))
            .fault(Trigger::with("SEARCH", "UID 1:2"), Action::RefuseWith("NO".into(), "search refused".into())));
        let s = state2(&server);
        let first = delete_to_trash(&s, &server, 1, "<keep1@example.com>").await;
        let mut second = delete_to_trash(&s, &server, 2, "<keep2@example.com>").await;
        // Found by Message-ID (no recorded Trash uid, no bin row to lend
        // one), so the first check (`UID 1`) and the re-check (`UID 1:2`)
        // differ and only the re-check is refused.
        second["trashUid"] = Value::Null;
        second["binId"] = Value::Null;

        let out = restore(&s, vec![first, second]).await;

        assert_eq!(out["restored"], json!([]), "{out}");
        assert_eq!(out["failed"], json!([
            {"accountId": "acc1", "mailbox": "INBOX", "uid": 1, "error": "deletedBin.recoverFailed"},
            {"accountId": "acc1", "mailbox": "INBOX", "uid": 2, "error": "deletedBin.recoverFailed"},
        ]));
        assert_eq!(binned(&s).len(), 2);
        // Both moved (the server's own answer was short): no row written
        // under the uids they got, as nothing was taken as back.
        assert_eq!(uids(&server, "INBOX"), vec![3, 4]);
        assert!(cached(&s, "acc1", "INBOX", 3).is_none() && cached(&s, "acc1", "INBOX", 4).is_none(), "nothing settled");
    }
}
