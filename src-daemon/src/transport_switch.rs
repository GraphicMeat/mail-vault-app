//! `accounts.switch_transport {id, transport, fields, expected}`: moves a
//! Microsoft account between Microsoft Graph and IMAP in place, keeping its
//! vault (`mailvault_core::transport_switch` has the why).
//!
//! The app signs in again with the new transport's scopes first and sends
//! the grant in `fields`, the same patch `accounts.update` takes. Then, in
//! order:
//!
//! 1. Refused while the op journal owes anything for the account: a queued
//!    op names uids of the old numbering.
//! 2. To IMAP: every vault folder's server listing (uid and Message-ID), read
//!    with the new grant. A failure here stops the switch with nothing
//!    changed. A vault folder IMAP has no folder of the same name for (Graph's
//!    `Trash` is Outlook's `Deleted` over IMAP) has an empty listing: its mail
//!    stays as local mail of that folder.
//! 3. Retire (`retire`): per folder under the mailbox lock, forget the old
//!    ledger, sidecars and stamp, and to IMAP re-file the vault under the
//!    server's uids; then drop the account's cached headers and per-uid
//!    classifications, and relist every folder.
//! 4. The account record takes the new transport (`accounts.update`).
//! 5. To IMAP, retire again: a Graph listing that finished between 3 and 4
//!    wrote a ledger or files under its own numbers; the same listing re-files
//!    those too. To Graph, only the headers IMAP cached meanwhile are dropped:
//!    Graph is already allocating into its new ledgers.
//!
//! A switch cut short between 3 and 4 leaves the old transport with a vault
//! it reads safely: Graph adopts files by Message-ID once its ledger is gone,
//! and IMAP's uids are the server's either way.
//!
//! Runs on the RPC's own task; the disk work on blocking threads, one folder
//! per hold of its lock.

use crate::custody as daemon_custody;
use crate::handlers::common::{vault_root, with_mailbox_write};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::custody::{cache, entries};
use mailvault_core::imap::{self, ImapConfig, MailboxInfo};
use mailvault_core::{app_db, message_store, transport_switch, vault_files};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use tracing::{info, warn};

/// The journal still owes ops for the account.
const PENDING: &str = "errors.transportSwitchPending";
/// Not a Microsoft OAuth account, or no such transport.
const INVALID: &str = "errors.accountsInvalid";
/// Microsoft's IMAP server refused the new grant or the folder listing.
const IMAP_REFUSED: &str = "errors.transportSwitchImapRefused";

/// One vault folder's server listing: its UIDVALIDITY and normalized
/// Message-ID -> uid.
#[derive(Debug, Default, Clone)]
pub(crate) struct Listed {
    pub uid_validity: Option<u32>,
    pub ids: HashMap<String, u32>,
}

/// Vault folder directory name -> its listing, for a switch to IMAP. A
/// folder absent here has no IMAP counterpart.
pub(crate) type Listing = HashMap<String, Listed>;

/// What `retire` did, for the reply and the log.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Retired {
    pub folders: u32,
    pub moved: u32,
    pub to_local: u32,
    pub errors: u32,
}

pub(crate) async fn route(state: &Arc<DaemonState>, params: &Value, id: Value) -> RpcResponse {
    match switch(state, params).await {
        Ok(reply) => RpcResponse::success(id, reply),
        Err(e) if e == PENDING || e == INVALID => RpcResponse::error(id, ipc::INVALID_PARAMS, &e),
        Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, &e),
    }
}

async fn switch(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account_id = params.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or(INVALID)?.to_owned();
    let transport = params.get("transport").and_then(Value::as_str).filter(|t| matches!(*t, "graph" | "imap")).ok_or(INVALID)?;
    let mut fields = params.get("fields").cloned().unwrap_or_else(|| json!({}));
    fields.as_object_mut().ok_or(INVALID)?.insert("oauth2Transport".into(), json!(transport));

    let (_, snapshot) = crate::credentials::resolve_account_with_record_guarded(&account_id).await?;
    let record = snapshot.record;
    let microsoft = record.get("authType").and_then(Value::as_str) == Some("oauth2")
        && record.get("oauth2Provider").and_then(Value::as_str).is_none_or(|p| p == "microsoft");
    if !microsoft {
        return Err(INVALID.into());
    }
    if pending_ops(state, &account_id) {
        return Err(PENDING.into());
    }
    let email = record.get("email").and_then(Value::as_str).ok_or(INVALID)?.to_owned();
    // The shell resolves the backup folder and sends it (`mirrorRoot`), or
    // refuses the switch while a configured one is unreachable.
    let mirror = params.get("mirrorRoot").and_then(Value::as_str).map(std::path::PathBuf::from);
    let scope = Scope { account_id: account_id.clone(), email, mirror };

    let to_imap = transport == "imap";
    let listing = if to_imap {
        let mut target = record.clone();
        if let (Some(target), Some(patch)) = (target.as_object_mut(), fields.as_object()) {
            target.extend(patch.clone());
        }
        let config = crate::credentials::config_from_record(&target).map_err(|_| INVALID.to_owned())?;
        let dirs = vault_dirs(state, &account_id)?;
        Some(list_server(state, &config, &dirs).await.map_err(|e| listing_failed(&account_id, e))?)
    } else {
        None
    };

    let first = retire_blocking(state, &scope, listing.clone()).await?;

    let mut update = json!({"id": account_id, "fields": fields});
    for key in ["expected", "unset"] {
        if let Some(value) = params.get(key) {
            update[key] = value.clone();
        }
    }
    let reply = crate::account_workflows::account_workflow(state, &update, json!(1), false).await;
    let refused = match (&reply.error, &reply.result) {
        (Some(error), _) => Some(error.message.clone()),
        (None, Some(r)) if r.get("ok") == Some(&json!(false)) => {
            Some(r.get("error").and_then(Value::as_str).unwrap_or("errors.accountsWriteFailed").to_owned())
        }
        _ => None,
    };
    if let Some(error) = refused {
        warn!("[transport] {account_id}: the account kept its transport: {error}");
        return Err(error);
    }

    // To Graph, the new transport is already allocating into fresh ledgers:
    // only rows IMAP cached meanwhile are dropped, never a ledger.
    let second = match listing {
        Some(_) => retire_blocking(state, &scope, listing).await?,
        None => {
            let state = Arc::clone(state);
            let id = account_id.clone();
            tokio::task::spawn_blocking(move || drop_cached_headers(&state, &id)).await.map_err(|e| e.to_string())??;
            Retired::default()
        }
    };
    info!("[transport] {account_id} now over {transport}: {first:?}, then {second:?}");
    Ok(json!({"account": reply.result.and_then(|r| r.get("account").cloned()), "retired": first}))
}

/// A switch to IMAP whose server listing failed: nothing changed yet. The
/// server's own reply goes to the log (a refused XOAUTH2 sign-in and
/// Outlook.com's "authenticated but not connected" read the same to the
/// user); a catalog key the listing already chose is kept.
fn listing_failed(account_id: &str, error: String) -> String {
    warn!("[transport] {account_id}: listing the server over IMAP failed, the account kept its transport: {error}");
    if error.starts_with("errors.") { error } else { IMAP_REFUSED.into() }
}

/// Whether the op journal owes anything for the account.
fn pending_ops(state: &DaemonState, account_id: &str) -> bool {
    mailvault_core::op_journal::read(&state.app_dir).iter().any(|e| e.account_id == account_id && !e.uids.is_empty())
}

/// The account's vault folder directory names.
pub(crate) fn vault_dirs(state: &Arc<DaemonState>, account_id: &str) -> Result<Vec<String>, String> {
    let root = vault_root(state)?;
    let account_dir = vault_files::account_dir(&root.join("Maildir"), account_id);
    let Some(name) = account_dir.file_name().map(|n| n.to_string_lossy().into_owned()) else { return Ok(Vec::new()) };
    Ok(message_store::mailbox_dirs(&root)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|(account, _)| *account == name)
        .map(|(_, mailbox)| mailbox)
        .collect())
}

/// The IMAP folder a vault folder directory holds: the one whose vault name
/// is the directory's (INBOX in any case).
fn imap_folder_for<'a>(dir: &str, paths: &'a [String]) -> Option<&'a String> {
    paths.iter().find(|p| {
        if dir.eq_ignore_ascii_case("INBOX") {
            p.eq_ignore_ascii_case("INBOX")
        } else {
            mailvault_core::search_index::text::vault_dir_name(p) == dir
        }
    })
}

fn selectable_paths(boxes: &[MailboxInfo], out: &mut Vec<String>) {
    for b in boxes {
        if !b.noselect {
            out.push(b.path.clone());
        }
        selectable_paths(&b.children, out);
    }
}

/// Every vault folder's server listing, one fresh connection.
async fn list_server(state: &Arc<DaemonState>, config: &ImapConfig, dirs: &[String]) -> Result<Listing, String> {
    let mut guard = state.imap_pool.get_background_fresh(config).await?;
    let result = async {
        let mut paths = Vec::new();
        selectable_paths(&imap::list_mailboxes(&mut guard.session).await?, &mut paths);
        let mut listing = Listing::new();
        for dir in dirs {
            let Some(path) = imap_folder_for(dir, &paths) else { continue };
            let (validity, flags) = imap::search_all_uid_flags_in_generation(&mut guard.session, path).await?;
            let uids: Vec<u32> = flags.into_iter().map(|(uid, _)| uid).collect();
            let (same, read) = imap::abd_cmds::message_ids_in_generation(&mut guard.session, path, &uids).await?;
            if same != validity {
                return Err("errors.bulkIdentityChanged".to_owned());
            }
            let mut ids = HashMap::new();
            let mut read = read;
            read.sort_unstable_by_key(|(uid, _)| *uid);
            for (uid, id) in read {
                if let Some(id) = id {
                    ids.entry(id).or_insert(uid);
                }
            }
            listing.insert(dir.clone(), Listed { uid_validity: validity, ids });
        }
        Ok::<_, String>(listing)
    }
    .await;
    match &result {
        Ok(_) => state.imap_pool.return_background(config, guard).await,
        Err(_) => state.imap_pool.discard(config, guard).await,
    }
    result
}

/// The account a switch retires, and its backup folder when there is one.
#[derive(Debug, Clone)]
pub(crate) struct Scope {
    pub account_id: String,
    /// The backup folder keys an account by address, not by id.
    pub email: String,
    pub mirror: Option<std::path::PathBuf>,
}

async fn retire_blocking(state: &Arc<DaemonState>, scope: &Scope, listing: Option<Listing>) -> Result<Retired, String> {
    let state = Arc::clone(state);
    let scope = scope.clone();
    tokio::task::spawn_blocking(move || retire(&state, &scope, listing.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Step 3 of the module doc. `listing` is `Some` for a switch to IMAP.
///
/// With a backup folder, each vault folder is pre-synced with it first, as a
/// backup run does: a message only the mirror still holds comes into the
/// vault and is re-filed with the rest, else the mirror would copy it back
/// under its old number. The re-file is replayed onto the mirror at once.
pub(crate) fn retire(state: &Arc<DaemonState>, scope: &Scope, listing: Option<&Listing>) -> Result<Retired, String> {
    let account_id = scope.account_id.as_str();
    let stamp = state.account_lifecycle.capture(account_id).map_err(|_| "errors.keychainBusy".to_owned())?;
    let dirs = vault_dirs(state, account_id)?;
    let cached = daemon_custody::with_conn(state, |c| cached_mailboxes(c, account_id)).unwrap_or_default();
    // The folder each vault directory holds: custody, classifications, the
    // registry and the mirror key by folder path ("My Folder"), the disk by
    // directory ("My_Folder").
    let folders = mailvault_core::search_index::text::mailboxes_from_vault_dirs(&dirs, &cached);
    let dir_of: HashMap<&str, &str> = folders.iter().map(String::as_str).zip(dirs.iter().map(String::as_str)).collect();
    // Every folder the old transport may have kept sidecars or cached
    // headers under, vault folder or not: a ledger left for a folder never
    // backed up would name uids of the old numbering on the next switch back.
    let mut names: BTreeSet<String> = folders.iter().cloned().collect();
    names.extend(cached);
    names.extend(mailvault_core::graph::WELL_KNOWN.iter().map(|(_, key)| key.to_string()));

    let mut report = Retired::default();
    for name in &names {
        let dir = dir_of.get(name.as_str()).copied();
        if let (Some(mirror), Some(_)) = (&scope.mirror, dir) {
            let root = vault_root(state)?;
            if let Err(e) = mailvault_core::backup::presync_folder(&state.vault_registry, &root, account_id, &scope.email, name, mirror) {
                warn!("[transport] {account_id}/{name}: backup folder not pre-synced: {e}");
            }
        }
        let _permit = state.account_lifecycle.try_commit(std::slice::from_ref(&stamp)).map_err(|_| "errors.keychainBusy".to_owned())?;
        let rekeyed = with_mailbox_write(state, account_id, name, |root| {
            transport_switch::forget_namespace(root, account_id, name)?;
            let (Some(listing), Some(dir)) = (listing, dir) else { return Ok(None) };
            let protected = daemon_custody::with_conn(state, |c| entries::local_uids(c, account_id, name))?;
            let listed = listing.get(dir).cloned().unwrap_or_default();
            let mailbox_dir = message_store::mailbox_dir(root, account_id, name);
            transport_switch::rekey_to_server(&mailbox_dir, &listed.ids, &protected, listed.uid_validity).map(Some)
        });
        let rekeyed = match rekeyed {
            Ok(r) => r,
            Err(e) if e.starts_with("E_VAULT_UNAVAILABLE:") => return Err(e),
            Err(e) => {
                warn!("[transport] {account_id}/{name}: {e}");
                report.errors += 1;
                continue;
            }
        };
        if let Some(r) = rekeyed {
            report.folders += 1;
            report.moved += r.moved.len() as u32;
            report.to_local += r.to_local;
            report.errors += r.errors;
            if !r.moved.is_empty() {
                if let Err(e) = daemon_custody::with_conn(state, |c| entries::remap(c, account_id, name, &r.moved, &[])) {
                    warn!("[transport] {account_id}/{name}: custody remap failed: {e}");
                }
                if let Some(mirror) = &scope.mirror {
                    let replayed = vault_root(state).and_then(|root| mailvault_core::backup::replay_folder(&root, account_id, &scope.email, name, mirror));
                    if let Err(e) = replayed {
                        warn!("[transport] {account_id}/{name}: backup folder not re-filed yet, the next backup does it: {e}");
                    }
                }
            }
        }
        if let Err(e) = app_db::with(&state.app_dir, |c| app_db::classify::remove_mailbox(c, account_id, name)) {
            warn!("[transport] {account_id}/{name}: classifications not dropped: {e}");
        }
    }
    drop_cached_headers(state, account_id)?;
    Ok(report)
}

/// Cached headers carry the old numbering; the new transport lists afresh.
fn drop_cached_headers(state: &Arc<DaemonState>, account_id: &str) -> Result<(), String> {
    daemon_custody::with_conn(state, |c| cache::clear_headers(c, Some(account_id), None))?;
    state.vault_registry.invalidate_all();
    Ok(())
}

/// The folders the header cache holds rows for, for the account.
fn cached_mailboxes(conn: &mailvault_core::custody::Connection, account_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT mailbox_path FROM header_cache_meta WHERE account_id=?1 UNION SELECT DISTINCT mailbox_path FROM header_cache WHERE account_id=?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([account_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::{graph_ledger, header_cache, maildir};
    use std::fs;

    fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, true);
        fs::write(s.app_dir.join("accounts.json"), r#"[{"id":"acc"}]"#).unwrap();
        s.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&s.app_dir)).unwrap());
        let _ = daemon_custody::open_into(&s);
        (vault, s)
    }

    fn eml(id: &str) -> String {
        format!("Message-ID: <{id}>\r\nSubject: {id}\r\n\r\nbody\r\n")
    }

    fn put(root: &std::path::Path, mailbox: &str, uid: u32, id: &str) {
        let mailbox_dir = message_store::mailbox_dir(root, "acc", mailbox);
        message_store::create_messages_dir_at(&mailbox_dir).unwrap();
        message_store::write_named_at(&mailbox_dir, &message_store::entry_name(uid, &[]), eml(id).as_bytes()).unwrap();
    }

    fn held(root: &std::path::Path, mailbox: &str) -> HashMap<u32, String> {
        message_store::uid_message_ids(root, "acc", mailbox)
            .unwrap()
            .into_iter()
            .filter_map(|(uid, id)| Some((uid, id?)))
            .collect()
    }

    /// The daemon side of a Graph -> IMAP switch: a Graph Inbox (ledger,
    /// sidecar headers, cached rows) whose numbers the server gives other
    /// messages ends with every vault uid naming the server's message, the
    /// ledger and cached rows gone, and a never-backed-up folder's ledger
    /// gone too.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retiring_a_graph_vault_for_imap_leaves_no_uid_naming_two_messages() {
        let (vault, state) = st();
        let root = vault.path();
        put(root, "INBOX", 1, "a@x");
        put(root, "INBOX", 2, "b@x");
        put(root, "INBOX", 3, "gone@x");
        let inbox_sidecar = header_cache::sidecar_dir(root, "acc", "INBOX");
        fs::create_dir_all(&inbox_sidecar).unwrap();
        fs::write(inbox_sidecar.join(graph_ledger::LEDGER_FILE), r#"{"1":"g-a","2":"g-b","3":"g-gone"}"#).unwrap();
        // Junk was listed over Graph but never backed up: a ledger, no vault dir.
        let junk_sidecar = header_cache::sidecar_dir(root, "acc", "Junk");
        fs::create_dir_all(&junk_sidecar).unwrap();
        fs::write(junk_sidecar.join(graph_ledger::LEDGER_FILE), r#"{"1":"g-j"}"#).unwrap();
        // The backup folder holds the vault's 3 and one message the vault no
        // longer has (a flagless copy "Clear cached emails" removed) at Graph
        // uid 4, which the server gives to another message.
        let mirror = tempfile::tempdir().unwrap();
        let mirror_cur = maildir::mirror_cur(mirror.path(), "me@outlook.com", "INBOX").unwrap();
        fs::create_dir_all(&mirror_cur).unwrap();
        fs::write(mirror_cur.join(message_store::entry_name(3, &[])), eml("gone@x")).unwrap();
        fs::write(mirror_cur.join(message_store::entry_name(4, &[])), eml("mirror-only@x")).unwrap();
        let rows = json!({"totalEmails":2,"emails":[{"uid":1,"messageId":"<a@x>"},{"uid":2,"messageId":"<b@x>"}]});
        daemon_custody::with_conn(&state, |c| cache::save_headers(c, "acc", "INBOX", &rows.to_string())).unwrap();
        // Before: the vault's 1 is a, the server's 1 is b.
        let server: HashMap<String, u32> = [("b@x".to_string(), 1), ("a@x".to_string(), 2), ("new@x".to_string(), 3), ("new2@x".to_string(), 4)].into();
        assert_eq!(held(root, "INBOX")[&1], "a@x");

        let listing: Listing = [("INBOX".to_string(), Listed { uid_validity: Some(42), ids: server.clone() })].into();
        let scope = Scope { account_id: "acc".into(), email: "me@outlook.com".into(), mirror: Some(mirror.path().to_path_buf()) };
        let report = retire(&state, &scope, Some(&listing)).unwrap();

        let mut local = Vec::new();
        for (uid, id) in held(root, "INBOX") {
            if message_store::is_import_uid(uid) {
                local.push(id);
            } else {
                assert_eq!(server.get(&id), Some(&uid), "vault uid {uid} names {id}, the server's {uid} is another message");
            }
        }
        local.sort();
        assert_eq!(local, vec!["gone@x".to_string(), "mirror-only@x".to_string()]);
        assert_eq!((report.folders, report.moved, report.to_local), (1, 4, 2));
        // The backup folder is re-filed the same way: its next pre-sync has
        // nothing under an old number to copy back.
        for (uid, path) in maildir::mirror_file_map(&mirror_cur) {
            let id = maildir::read_message_id(&path).unwrap();
            assert!(message_store::is_import_uid(uid) || server.get(&id) == Some(&uid), "backup uid {uid} still holds {id}");
        }
        assert!(!inbox_sidecar.exists() && !junk_sidecar.exists(), "no ledger of the Graph numbering is left");
        assert_eq!(maildir::read_generation(&message_store::mailbox_dir(root, "acc", "INBOX")), Some(42));
        let cached = daemon_custody::with_conn(&state, |c| cache::load_headers(c, "acc", "INBOX", None, cache::HeaderOrder::Arrival)).unwrap();
        assert!(cached.as_deref().is_none_or(|rows| !rows.contains("a@x")), "cached rows of the Graph numbering are dropped: {cached:?}");
    }

    #[test]
    fn a_vault_folder_finds_its_imap_folder_by_vault_name() {
        let paths: Vec<String> = ["Inbox", "Sent", "Deleted", "Projekt Nystart"].iter().map(|s| s.to_string()).collect();
        assert_eq!(imap_folder_for("INBOX", &paths).map(String::as_str), Some("Inbox"));
        assert_eq!(imap_folder_for("Sent", &paths).map(String::as_str), Some("Sent"));
        assert_eq!(imap_folder_for("Projekt_Nystart", &paths).map(String::as_str), Some("Projekt Nystart"));
        assert_eq!(imap_folder_for("Trash", &paths), None, "Graph's Trash is not Outlook's Deleted by name");
    }

    #[test]
    fn a_failed_imap_listing_reads_as_an_imap_refusal_and_keeps_catalog_keys() {
        let refused = "XOAUTH2 auth failed for me@outlook.com: no response: code: None, info: Some(\"AUTHENTICATE failed.\")";
        assert_eq!(listing_failed("acc", refused.to_owned()), IMAP_REFUSED);
        assert_eq!(listing_failed("acc", "BAD User is authenticated but not connected.".to_owned()), IMAP_REFUSED);
        assert_eq!(listing_failed("acc", "errors.bulkIdentityChanged".to_owned()), "errors.bulkIdentityChanged");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_switch_is_refused_while_the_journal_owes_the_account_an_op() {
        let (_vault, state) = st();
        assert!(!pending_ops(&state, "acc"));
        mailvault_core::op_journal::queue_delete(&state.app_dir, "acc", "INBOX", &[5], &json!({})).unwrap();
        assert!(pending_ops(&state, "acc"));
        assert!(!pending_ops(&state, "other"));
    }
}
