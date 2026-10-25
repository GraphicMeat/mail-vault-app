//! Local-only drafts. Heavy preparation precedes the draft commit lock; all
//! file effects use existing mailbox -> vault -> custody units on workers.
use crate::{
    custody,
    handlers::common::{self, blocking, with_mailbox_write},
    ipc::{self, RpcResponse},
    server::DaemonState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use mailvault_core::{
    app_db::{
        self,
        compose_receipts::{self, Identity, Receipt, Scope},
        drafts as db,
    },
    custody::{cache, entries},
    drafts::{self, Copy, Intent, Location, Record, Save},
    message_store, smtp, vault_files,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, LazyLock, Mutex, Weak},
};
const PREPARED: &str = ".mailvault-draft-prepared";
static LOCKS: LazyLock<Mutex<HashMap<(PathBuf, String), Weak<Mutex<()>>>>> =
    LazyLock::new(Default::default);
fn draft_lock(s: &DaemonState, id: &str) -> Arc<Mutex<()>> {
    let mut map = LOCKS.lock().unwrap_or_else(|p| p.into_inner());
    map.retain(|_, v| v.strong_count() > 0);
    let key = (s.app_dir.clone(), id.into());
    if let Some(lock) = map.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    map.insert(key, Arc::downgrade(&lock));
    lock
}
fn load(s: &DaemonState, id: &str) -> Result<Record, String> {
    app_db::with(&s.app_dir, |c| db::load(c, id)).map(|r| r.unwrap_or_else(|| Record::new(id)))
}
fn persist(s: &DaemonState, r: &Record) -> Result<(), String> {
    app_db::with(&s.app_dir, |c| db::save(c, r))
}
fn account(
    s: &DaemonState,
    id: &str,
    from: &str,
    name: &str,
) -> Result<mailvault_core::imap::ImapConfig, String> {
    let raw = std::fs::read(s.app_dir.join("accounts.json"))
        .map_err(|e| format!("draft account read: {e}"))?;
    let rows: Vec<Value> =
        serde_json::from_slice(&raw).map_err(|e| format!("draft account parse: {e}"))?;
    let mut found = rows.iter().filter(|r| r["id"].as_str() == Some(id));
    let r = found.next().ok_or("draft account missing")?;
    if found.next().is_some() {
        return Err("duplicate draft account".into());
    }
    let email = r["email"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("draft identity missing")?;
    // MIME construction needs no token, password, network, or keychain read.
    serde_json::from_value(json!({"email":email,"imapHost":r["imapHost"].as_str().unwrap_or(""),"name":name,"fromEmail":if from.is_empty(){email}else{from}})).map_err(|e|e.to_string())
}
fn mailbox(s: &DaemonState, id: &str) -> Result<String, String> {
    let boxes = custody::with_conn(s, |c| cache::load_mailboxes(c, id))?;
    let value = boxes
        .map(|v| serde_json::from_str(&v).map_err(|e| format!("draft mailbox cache: {e}")))
        .transpose()?
        .unwrap_or(json!([]));
    Ok(drafts::drafts_mailbox(&value))
}
fn scheduled(s: &DaemonState, l: &Location) -> Result<bool, String> {
    app_db::with(&s.app_dir, |c| {
        c.query_row("SELECT EXISTS(SELECT 1 FROM scheduled_sends WHERE account_id=?1 AND mailbox=?2 AND uid=?3)",rusqlite::params![l.account_id,l.mailbox,l.uid],|r|r.get(0)).map_err(|e|e.to_string())
    })
}
struct Inventory {
    root: PathBuf,
    fence: mailvault_core::vault_registry::TargetFence,
    candidates: Vec<message_store::UidArtifact>,
}
fn inventory(s: &Arc<DaemonState>, l: &Location) -> Result<Inventory, String> {
    let (root, fence) = with_mailbox_write(s, &l.account_id, &l.mailbox, |root| {
        if !root.is_dir() {
            return Err("draft vault unavailable".into());
        }
        Ok((
            root.to_path_buf(),
            s.vault_registry
                .target_fence(root, &l.account_id, &l.mailbox, l.uid)
                .ok_or("draft registry unavailable")?,
        ))
    })?;
    let mut all = message_store::inventory_uid_artifacts(
        &root,
        &l.account_id,
        &l.mailbox,
        &HashSet::from([l.uid]),
        &AtomicBool::new(false),
    )
    .map_err(|e| e.to_string())?;
    Ok(Inventory {
        root,
        fence,
        candidates: all.remove(&l.uid).ok_or("draft inventory unavailable")?,
    })
}
fn checked_bytes(
    s: &DaemonState,
    root: &Path,
    l: &Location,
    i: &Inventory,
) -> Result<Option<Vec<u8>>, String> {
    if !root.is_dir()
        || root != i.root
        || s.vault_registry
            .target_fence(root, &l.account_id, &l.mailbox, l.uid)
            .as_ref()
            != Some(&i.fence)
    {
        return Err("draft storage changed".into());
    }
    let raw =
        message_store::read_uid_candidates(root, &l.account_id, &l.mailbox, l.uid, &i.candidates)
            .map_err(|e| e.to_string())?;
    if raw.iter().skip(1).any(|(_, b)| b != &raw[0].1) {
        return Err("conflicting draft artifacts".into());
    }
    Ok(raw.into_iter().next().map(|(_, b)| b))
}
fn receipt_history(s: &DaemonState, copy: &Copy, retire: bool) -> Result<(), String> {
    app_db::with(&s.app_dir, |c| {
        let proof = Receipt::present(copy.identity.clone());
        let history = compose_receipts::load(c, &copy.identity.scope)?;
        if history.iter().any(|p| p != &proof) {
            return Err("conflicting draft receipt history".into());
        }
        if retire && !history.is_empty() && !compose_receipts::retire(c, &proof)? {
            return Err("draft receipt changed".into());
        }
        Ok(())
    })
}
fn draft_owner(c: &rusqlite::Connection, l: &Location, expected: &Copy) -> Result<(), String> {
    let row = entries::get(c, &l.account_id, &l.mailbox, l.uid)?.ok_or("draft custody missing")?;
    if !drafts::editable(&row)
        || row["message_id"]
            .as_str()
            .and_then(mailvault_core::compose::normalize_message_id)
            .as_deref()
            != Some(&expected.identity.scope.message_id)
    {
        return Err("draft custody changed".into());
    }
    Ok(())
}
fn read_copy(
    s: &Arc<DaemonState>,
    copy: &Copy,
    require_owner: bool,
) -> Result<Option<Vec<u8>>, String> {
    let l = copy.location();
    let i = inventory(s, &l)?;
    with_mailbox_write(s, &l.account_id, &l.mailbox, |root| {
        custody::with_conn(s, |c| {
            let raw = checked_bytes(s, root, &l, &i)?;
            if require_owner || entries::get(c, &l.account_id, &l.mailbox, l.uid)?.is_some() {
                draft_owner(c, &l, copy)?;
            }
            if let Some(raw) = &raw {
                if !copy.identity.matches_bytes(raw) {
                    return Err("draft bytes changed".into());
                }
            }
            receipt_history(s, copy, false)?;
            Ok(raw)
        })
    })
}
fn adopt(s: &Arc<DaemonState>, r: &mut Record, l: &Location) -> Result<(), String> {
    if scheduled(s, l)? {
        return Err("scheduled ownership is not editable".into());
    }
    if app_db::with(&s.app_dir, |c| db::owner(c, l))?.is_some() {
        return Err("draft location already managed".into());
    }
    let i = inventory(s, l)?;
    with_mailbox_write(s, &l.account_id, &l.mailbox, |root| {
        custody::with_conn(s, |c| {
            let row =
                entries::get(c, &l.account_id, &l.mailbox, l.uid)?.ok_or("legacy draft missing")?;
            if !drafts::editable(&row) {
                return Err("not an editable local draft".into());
            }
            let raw = checked_bytes(s, root, l, &i)?.ok_or("draft body missing")?;
            let mid = row["message_id"]
                .as_str()
                .ok_or("legacy draft Message-ID missing")?;
            let proof = Scope::new(&l.account_id, &l.mailbox, l.uid, mid)
                .and_then(|scope| Identity::from_bytes(scope, &raw))
                .ok_or("draft identity mismatch")?;
            let copy = Copy {
                identity: proof,
                entry: row,
            };
            let history = app_db::with(&s.app_dir, |c| {
                compose_receipts::load(c, &copy.identity.scope)
            })?;
            if !history.is_empty() {
                return Err("staged compose ownership is not editable".into());
            }
            r.current = Some(copy);
            persist(s, r)
        })
    })
}
fn allocate(s: &Arc<DaemonState>, account: &str, mailbox: &str) -> Result<u32, String> {
    with_mailbox_write(s, account, mailbox, |root| {
        let mut uid = vault_files::free_local_uid(root, account, mailbox);
        loop {
            let loc = Location {
                account_id: account.into(),
                mailbox: mailbox.into(),
                uid,
            };
            if app_db::with(&s.app_dir, |c| db::owner(c, &loc))?.is_none()
                && !vault_files::exists(root, account, mailbox, uid)
                && !scheduled(s, &loc)?
            {
                return Ok(uid);
            }
            uid = uid.checked_add(1).ok_or("draft uid exhausted")?;
        }
    })
}
fn prepare_copy(
    s: &Arc<DaemonState>,
    account: &str,
    mailbox: &str,
    uid: u32,
    raw: Vec<u8>,
    flags: &[String],
) -> Result<message_store::Prepared, String> {
    common::with_vault_write(s, |root| {
        vault_files::prepare_store(root, account, mailbox, uid, raw, flags)
    })
}
fn install(
    s: &Arc<DaemonState>,
    copy: &Copy,
    prepared: &message_store::Prepared,
    flags: &[String],
) -> Result<(), String> {
    let l = copy.location();
    let i = inventory(s, &l)?;
    with_mailbox_write(s, &l.account_id, &l.mailbox, |root| {
        if root != prepared.root()
            || message_store::vault_format(root) != prepared.format()
            || prepared.uid() != l.uid
            || !copy.identity.matches_bytes(prepared.raw())
        {
            return Err("draft prepared identity changed".into());
        }
        let held = checked_bytes(s, root, &l, &i)?;
        if let Some(bytes) = held {
            if !copy.identity.matches_bytes(&bytes) {
                return Err("draft destination occupied".into());
            }
            return Ok(());
        }
        if !vault_files::store_prepared(
            &s.vault_registry,
            root,
            &l.account_id,
            &l.mailbox,
            prepared,
            flags,
            false,
        )? {
            return Err("draft destination occupied".into());
        }
        Ok(())
    })
}
fn retire(s: &Arc<DaemonState>, copy: &Copy, prepared: bool) -> Result<(), String> {
    let l = copy.location();
    if scheduled(s, &l)? {
        return Err("scheduled ownership cannot retire".into());
    }
    let i = inventory(s, &l)?;
    with_mailbox_write(s, &l.account_id, &l.mailbox, |root| {
        custody::with_conn(s, |c| {
            let raw = checked_bytes(s, root, &l, &i)?;
            if let Some(row) = entries::get(c, &l.account_id, &l.mailbox, l.uid)? {
                if !drafts::editable(&row)
                    || row["message_id"]
                        .as_str()
                        .and_then(mailvault_core::compose::normalize_message_id)
                        .as_deref()
                        != Some(&copy.identity.scope.message_id)
                {
                    return Err("draft cleanup custody conflict".into());
                }
            }
            if let Some(raw) = raw.as_deref() {
                if !copy.identity.matches_bytes(raw) {
                    return Err("draft cleanup bytes changed".into());
                }
                if !prepared {
                    let proof = Receipt::present(copy.identity.clone());
                    if crate::handlers::compose::retained_local_ownership_resolved_with_conn(
                        c,
                        &proof,
                        Some(raw),
                    )?
                    .is_none()
                    {
                        return Err("draft cleanup ownership changed".into());
                    }
                }
            }
            receipt_history(s, copy, true)?;
            probe(
                s,
                if prepared {
                    "retire_prepared"
                } else {
                    "retire"
                },
            )?;
            let result = vault_files::delete_uid_candidates(
                &s.vault_registry,
                root,
                &l.account_id,
                &l.mailbox,
                l.uid,
                &i.candidates,
            )?;
            if result.failed {
                return Err("draft cleanup incomplete".into());
            }
            entries::remove(c, &l.account_id, &l.mailbox, &[l.uid])?;
            Ok(())
        })
    })
}
fn cleanup(s: &Arc<DaemonState>, r: &mut Record) -> Result<(), String> {
    let copies = r.cleanup.clone();
    for copy in copies {
        let is_prepared = copy.entry.is_null() && copy.identity.scope.mailbox == PREPARED;
        if retire(s, &copy, is_prepared).is_ok() {
            r.cleanup.retain(|c| c.identity != copy.identity);
            persist(s, r)?;
        }
    }
    Ok(())
}
fn finish(
    s: &Arc<DaemonState>,
    r: &mut Record,
    ready: &message_store::Prepared,
) -> Result<(), String> {
    let Some(p) = r.pending.clone() else {
        return Ok(());
    };
    if r.discarded {
        r.cleanup.push(p.copy);
        r.cleanup.push(p.prepared);
        r.pending = None;
        persist(s, r)?;
        return cleanup(s, r);
    }
    if common::vault_root(s)? != p.root {
        return Err("pending draft vault moved".into());
    }
    let raw = read_copy(s, &p.prepared, false)?.ok_or("prepared draft body unavailable")?;
    probe(s, "before_destination")?;
    if !p.copy.identity.matches_bytes(&raw) {
        return Err("prepared draft changed".into());
    }
    install(s, &p.copy, ready, &drafts::FLAGS.map(String::from))?;
    probe(s, "after_bytes")?;
    let l = p.copy.location();
    let i = inventory(s, &l)?;
    with_mailbox_write(s, &l.account_id, &l.mailbox, |root| {
        custody::with_conn(s, |c| {
            let bytes = checked_bytes(s, root, &l, &i)?.ok_or("draft destination missing")?;
            if !p.copy.identity.matches_bytes(&bytes) {
                return Err("draft destination readback failed".into());
            }
            if let Some(row) = entries::get(c, &l.account_id, &l.mailbox, l.uid)? {
                if !drafts::editable(&row) || row["message_id"] != p.copy.entry["message_id"] {
                    return Err("draft destination custody conflict".into());
                }
            }
            entries::upsert(
                c,
                &l.account_id,
                &l.mailbox,
                std::slice::from_ref(&p.copy.entry),
            )?;
            Ok(())
        })
    })?;
    probe(s, "before_accept")?;
    // Keep destination custody from final proof through the metadata switch.
    let i = inventory(s, &l)?;
    with_mailbox_write(s, &l.account_id, &l.mailbox, |root| {
        custody::with_conn(s, |c| {
            let raw = checked_bytes(s, root, &l, &i)?.ok_or("draft destination missing")?;
            draft_owner(c, &l, &p.copy)?;
            if !p.copy.identity.matches_bytes(&raw) {
                return Err("draft destination changed before acceptance".into());
            }
            let expected = r.clone();
            if !same_attempt(&expected, &p) {
                return Err("draft attempt changed".into());
            }
            if let Some(old) = r.current.take() {
                add_cleanup(r, old);
            }
            add_cleanup(r, p.prepared);
            r.current = Some(p.copy);
            r.revision = p.revision;
            r.request_hash = Some(p.request_hash);
            r.fingerprint = Some(p.fingerprint);
            r.pending = None;
            r.retry = None;
            app_db::with(&s.app_dir, |c| db::save_if(c, &expected, r))
        })
    })?;
    cleanup(s, r)
}
fn same_attempt(record: &Record, pending: &Intent) -> bool {
    !record.discarded
        && record.epoch == pending.epoch
        && record.revision < pending.revision
        && record.pending.as_ref().is_some_and(|now| {
            now.attempt_id == pending.attempt_id
                && now.epoch == pending.epoch
                && now.revision == pending.revision
                && now.request_hash == pending.request_hash
                && now.fingerprint == pending.fingerprint
                && now.copy.identity == pending.copy.identity
                && now.prepared.identity == pending.prepared.identity
                && now.root == pending.root
        })
}

fn add_cleanup(record: &mut Record, copy: Copy) {
    if !record
        .cleanup
        .iter()
        .any(|old| old.identity == copy.identity)
    {
        record.cleanup.push(copy);
    }
}

// A named prepared message or the exact known JMAP backing blob can recover
// the original randomized MIME. Unreadable/foreign content never means absent.
fn pending_raw(s: &Arc<DaemonState>, pending: &Intent) -> Result<Option<Vec<u8>>, String> {
    if common::vault_root(s)? != pending.root {
        return Err("pending draft vault moved".into());
    }
    for copy in [&pending.prepared, &pending.copy] {
        if let Some(raw) = read_copy(s, copy, false)? {
            return Ok(Some(raw));
        }
    }
    common::with_vault_write(s, |root| {
        if root != pending.root {
            return Err("pending draft vault moved".into());
        }
        let id = format!("sha256-{}", pending.prepared.identity.sha256);
        match mailvault_core::jmap_store::blobs::get(root, &id) {
            Ok(raw) if pending.prepared.identity.matches_bytes(&raw) => Ok(Some(raw)),
            Ok(_) => Err("prepared draft backing bytes changed".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    })
}

// Both inventories are made outside draft/mailbox locks. Each absence proof
// transfers to durable cleanup while that scope's mailbox/gate/custody is held.
// The first transfer never clears pending. The second uses a full-attempt CAS.
fn abort_uninstalled(s: &Arc<DaemonState>, id: &str, pending: &Intent) -> Result<(), String> {
    let stage = pending.prepared.location();
    let destination = pending.copy.location();
    let stage_inventory = inventory(s, &stage)?;
    let destination_inventory = inventory(s, &destination)?;
    let lock = draft_lock(s, id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    with_mailbox_write(s, &stage.account_id, &stage.mailbox, |root| {
        custody::with_conn(s, |c| {
            if root != pending.root
                || checked_bytes(s, root, &stage, &stage_inventory)?.is_some()
                || entries::get(c, &stage.account_id, &stage.mailbox, stage.uid)?.is_some()
            {
                return Err("draft stage absence unresolved".into());
            }
            let expected = load(s, id)?;
            if !same_attempt(&expected, pending) {
                return Err("draft attempt changed".into());
            }
            let mut next = expected.clone();
            add_cleanup(&mut next, pending.prepared.clone());
            receipt_history(s, &pending.prepared, true)?;
            app_db::with(&s.app_dir, |c| db::save_if(c, &expected, &next))
        })
    })?;
    probe(s, "abort_stage_checked")?;
    with_mailbox_write(s, &destination.account_id, &destination.mailbox, |root| {
        custody::with_conn(s, |c| {
            if root != pending.root
                || s.vault_registry
                    .target_fence(root, &stage.account_id, &stage.mailbox, stage.uid)
                    .as_ref()
                    != Some(&stage_inventory.fence)
                || entries::get(c, &stage.account_id, &stage.mailbox, stage.uid)?.is_some()
                || checked_bytes(s, root, &destination, &destination_inventory)?.is_some()
                || entries::get(
                    c,
                    &destination.account_id,
                    &destination.mailbox,
                    destination.uid,
                )?
                .is_some()
            {
                return Err("draft destination absence unresolved".into());
            }
            let expected = load(s, id)?;
            if !same_attempt(&expected, pending) {
                return Err("draft attempt changed".into());
            }
            let mut next = expected.clone();
            add_cleanup(&mut next, pending.copy.clone());
            next.retry = Some(drafts::RetryConstraint {
                revision: pending.revision,
                request_hash: pending.request_hash.clone(),
                fingerprint: pending.fingerprint.clone(),
            });
            next.epoch = next.epoch.checked_add(1).ok_or("draft attempt exhausted")?;
            next.pending = None;
            receipt_history(s, &pending.copy, true)?;
            app_db::with(&s.app_dir, |c| db::save_if(c, &expected, &next))
        })
    })?;
    Err("draft pre-install attempt aborted; retry complete snapshot".into())
}

fn recover(s: &Arc<DaemonState>, id: &str) -> Result<(), String> {
    let pending = {
        let lock = draft_lock(s, id);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut r = load(s, id)?;
        if r.discarded {
            return cleanup(s, &mut r);
        }
        r.pending
    };
    let Some(p) = pending else { return Ok(()) };
    // Copy publication requires current local account membership. Terminal
    // cleanup remains independent of account configuration above this branch.
    let _ = account(s, &p.copy.identity.scope.account_id,
        p.copy.entry["from"]["address"].as_str().unwrap_or(""),
        p.copy.entry["from"]["name"].as_str().unwrap_or(""))?;
    // Restart/retry preparation uses retained vault bytes, outside draft locks.
    let Some(raw) = pending_raw(s, &p)? else {
        return abort_uninstalled(s, id, &p);
    };
    let stage = p.prepared.location();
    let stage_ready = prepare_copy(
        s,
        &stage.account_id,
        &stage.mailbox,
        stage.uid,
        raw.clone(),
        &["seen".into()],
    )?;
    let l = p.copy.location();
    let ready = prepare_copy(
        s,
        &l.account_id,
        &l.mailbox,
        l.uid,
        raw,
        &drafts::FLAGS.map(String::from),
    )?;
    let lock = draft_lock(s, id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let mut r = load(s, id)?;
    if r.discarded {
        return cleanup(s, &mut r);
    }
    if same_attempt(&r, &p) {
        install(s, &p.prepared, &stage_ready, &["seen".into()])?;
        finish(s, &mut r, &ready)?;
    }
    Ok(())
}

fn response(record: &Record, disposition: &str) -> Value {
    let pending = record.pending.as_ref().map(|intent| {
        json!({
            "revision": intent.revision,
            "identity": intent.copy.identity,
            "preparedIdentity": intent.prepared.identity,
        })
    });
    let mut value = json!({
        "draftId": record.draft_id,
        "revision": record.revision,
        "disposition": disposition,
        "cleanup": if record.cleanup.is_empty() { "complete" } else { "pending" },
        "current": record.current,
        "pending": pending,
        "cleanupIdentities": record.cleanup.iter().map(|copy| &copy.identity).collect::<Vec<_>>(),
        "discarded": record.discarded,
    });
    if let Some(copy) = &record.current {
        let location = copy.location();
        value["accountId"] = json!(location.account_id);
        value["mailbox"] = json!(location.mailbox);
        value["uid"] = json!(location.uid);
        value["entry"] = copy.entry.clone();
        value["entry"]["draftId"] = json!(record.draft_id);
        value["entry"]["revision"] = json!(record.revision);
    }
    value
}

fn resolve_attachments(s: &Arc<DaemonState>, r: &mut Save) -> Result<(), String> {
    let mut sources: HashMap<(String, String, u32), Vec<usize>> = HashMap::new();
    for (index, a) in r.snapshot.attachments.iter_mut().enumerate() {
        if let Some(content) = &a.content {
            a.content = Some(STANDARD.encode(STANDARD.decode(content).map_err(|e| e.to_string())?));
        } else {
            let src = a.source.as_ref().ok_or("attachment source missing")?;
            sources
                .entry((src.account_id.clone(), src.mailbox.clone(), src.uid))
                .or_default()
                .push(index);
        }
    }
    for ((account, mailbox, uid), indices) in sources {
        let loc = Location {
            account_id: account,
            mailbox,
            uid,
        };
        let i = inventory(s, &loc)?;
        let raw = with_mailbox_write(s, &loc.account_id, &loc.mailbox, |root| {
            checked_bytes(s, root, &loc, &i)
        })?
        .ok_or("attachment source unavailable")?;
        let requested: Vec<_> = indices
            .iter()
            .map(|i| {
                r.snapshot.attachments[*i]
                    .source
                    .as_ref()
                    .unwrap()
                    .attachment_index
            })
            .collect();
        let bytes = vault_files::attachments_of(&raw, &requested)?;
        for (index, content) in indices.into_iter().zip(bytes) {
            r.snapshot.attachments[index].content =
                Some(content.ok_or("attachment source unavailable")?);
        }
    }
    Ok(())
}
fn save(s: &Arc<DaemonState>, mut request: Save) -> Result<Value, String> {
    let request_hash = request.request_hash();
    recover(s, &request.draft_id)?;
    // Retry first reconciles retained bytes, never regenerates the pending MIME.
    {
        let lock = draft_lock(s, &request.draft_id);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut r = load(s, &request.draft_id)?;
        if r.discarded {
            return Err("draft discarded".into());
        }
        if r.pending.is_some() {
            return Err("draft pending retry".into());
        }
        cleanup(s, &mut r)?;
        if request.revision < r.revision {
            return Ok(response(&r, "superseded"));
        }
        if request.revision == r.revision {
            if r.request_hash.as_deref() != Some(&request_hash) {
                return Err("draft revision conflict".into());
            }
            if let Some(current) = &r.current {
                read_copy(s, current, true)?.ok_or("draft body missing")?;
            }
            return Ok(response(&r, "unchanged"));
        }
        if !r.cleanup.is_empty() {
            return Err("draft cleanup pending".into());
        }
    }
    let initial = load(s, &request.draft_id)?;
    let preparation_epoch = initial.epoch;
    let config = account(
        s,
        &request.account_id,
        &request.from_address,
        &request.display_name,
    )?;
    if request.from_address.is_empty() {
        request.from_address = config.email.clone();
    }
    resolve_attachments(s, &mut request)?;
    let fingerprint = request.content_hash();
    let raw = smtp::build_local_draft_mime(&config, &request.outgoing()?)?;
    let prepared_mailbox = match &initial.current {
        Some(c) if c.identity.scope.account_id == request.account_id => {
            c.identity.scope.mailbox.clone()
        }
        None if request
            .previous_identity
            .as_ref()
            .is_some_and(|l| l.account_id == request.account_id) =>
        {
            request.previous_identity.as_ref().unwrap().mailbox.clone()
        }
        _ => mailbox(s, &request.account_id)?,
    };
    let stage_ready = prepare_copy(
        s,
        &request.account_id,
        PREPARED,
        1,
        raw.clone(),
        &["seen".into()],
    )?;
    let destination_ready = prepare_copy(
        s,
        &request.account_id,
        &prepared_mailbox,
        1,
        raw.clone(),
        &drafts::FLAGS.map(String::from),
    )?;
    probe(s, "prepared")?;
    let lock = draft_lock(s, &request.draft_id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let mut r = load(s, &request.draft_id)?;
    if r.discarded {
        return Err("draft discarded".into());
    }
    if r.epoch != preparation_epoch {
        return Err("draft preparation attempt changed; retry".into());
    }
    if r.retry.as_ref().is_some_and(|retry| {
        retry.revision == request.revision
            && (retry.request_hash != request_hash || retry.fingerprint != fingerprint)
    }) {
        return Err("draft revision conflict".into());
    }
    if request.revision < r.revision {
        return Ok(response(&r, "superseded"));
    }
    if request.revision == r.revision {
        if r.request_hash.as_deref() != Some(&request_hash)
            || r.fingerprint.as_deref() != Some(&fingerprint)
        {
            return Err("draft revision conflict".into());
        }
        return Ok(response(&r, "unchanged"));
    }
    if r.pending.is_some() {
        return Err("draft pending retry".into());
    }
    // Current non-secret identity must still be configured after preparation.
    let current_account = account(
        s,
        &request.account_id,
        &request.from_address,
        &request.display_name,
    )?;
    if current_account.email != config.email {
        return Err("draft account changed during preparation".into());
    }
    cleanup(s, &mut r)?;
    if !r.cleanup.is_empty() {
        return Err("draft cleanup pending".into());
    }
    if r.current.is_none() {
        if let Some(loc) = &request.previous_identity {
            adopt(s, &mut r, loc)?;
        }
    }
    if let Some(current) = &r.current {
        read_copy(s, current, true)?.ok_or("draft current body missing")?;
    }
    let target_mailbox = match &r.current {
        Some(c) if c.identity.scope.account_id == request.account_id => {
            c.identity.scope.mailbox.clone()
        }
        _ => mailbox(s, &request.account_id)?,
    };
    if target_mailbox == PREPARED {
        return Err("reserved draft preparation mailbox".into());
    }
    if target_mailbox != prepared_mailbox {
        return Err("draft mailbox changed during preparation".into());
    }
    let uid = allocate(s, &request.account_id, &target_mailbox)?;
    let stage_uid = allocate(s, &request.account_id, PREPARED)?;
    let mid = mailvault_core::maildir::message_id_in(&raw)
        .and_then(|mid| mailvault_core::compose::normalize_message_id(&mid))
        .ok_or("draft Message-ID missing")?;
    let proof = |mailbox: &str, uid| {
        Identity::from_bytes(
            Scope::new(&request.account_id, mailbox, uid, &mid).unwrap(),
            &raw,
        )
        .unwrap()
    };
    let entry = request.row(uid, &mid, &mailvault_core::compose::now_iso());
    let prepared = Copy {
        identity: proof(PREPARED, stage_uid),
        entry: Value::Null,
    };
    let intent = Intent {
        attempt_id: uuid::Uuid::new_v4().to_string(),
        epoch: r.epoch,
        revision: request.revision,
        request_hash,
        fingerprint,
        copy: Copy {
            identity: proof(&target_mailbox, uid),
            entry,
        },
        prepared: prepared.clone(),
        root: common::vault_root(s)?,
    };
    r.pending = Some(intent);
    persist(s, &r)?;
    let stage_ready = stage_ready.with_local_uid(stage_uid)?;
    let destination_ready = destination_ready.with_local_uid(uid)?;
    probe(s, "before_prepared_store")?;
    install(s, &prepared, &stage_ready, &["seen".into()])?;
    probe(s, "after_prepared_store")?;
    finish(s, &mut r, &destination_ready)?;
    Ok(response(&r, "saved"))
}
fn discard(s: &Arc<DaemonState>, id: &str) -> Result<Value, String> {
    let lock = draft_lock(s, id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let mut r = load(s, id)?;
    r.discarded = true;
    if let Some(c) = r.current.take() {
        r.cleanup.push(c);
    }
    if let Some(p) = r.pending.take() {
        r.cleanup.push(p.copy);
        r.cleanup.push(p.prepared);
    }
    persist(s, &r)?;
    cleanup(s, &mut r)?;
    Ok(
        json!({"draftId":id,"discarded":true,"cleanup":if r.cleanup.is_empty(){"complete"}else{"pending"},"cleanupIdentities":r.cleanup.iter().map(|c|&c.identity).collect::<Vec<_>>()}),
    )
}
// A stable id is primary after COW retires its former physical tuple. A tuple
// supplied alongside it is still a checked association, never a historic alias.
fn validate_open_tuple(s: &Arc<DaemonState>, id: &str, record: &Record, location: &Location) -> Result<(), String> {
    if app_db::with(&s.app_dir, |c| db::owner(c, location))?.as_deref() != Some(id) {
        return Err("draft tuple is not currently associated with this draftId".into());
    }
    let copy = record.current.iter()
        .chain(&record.cleanup)
        .chain(record.pending.iter().map(|intent| &intent.copy))
        .find(|copy| copy.location() == *location && drafts::editable(&copy.entry))
        .ok_or("draft tuple is not editable")?;
    let _ = read_copy(s, copy, false)?;
    Ok(())
}

fn list_id(s: &Arc<DaemonState>, id: &str, exact: Option<&Location>, content: bool) -> Result<Value, String> {
    if id.is_empty() || id.len() > 200 { return Err("invalid draftId".into()); }
    let Some(mut record) = app_db::with(&s.app_dir, |c| db::load(c, id))? else {
        return Ok(json!({"drafts":[],"managed":[],"missingBody":true}));
    };
    if let Some(location) = exact { validate_open_tuple(s, id, &record, location)?; }
    if content && !record.discarded {
        // Recovery failure leaves the accepted copy and pending facts usable.
        let _ = recover(s, id);
        record = load(s, id)?;
        if let Some(location) = exact { validate_open_tuple(s, id, &record, location)?; }
    }
    let mut view = response(&record, "unchanged");
    if record.discarded {
        return Ok(json!({"drafts":[],"managed":[view],"terminal":true,"missingBody":false}));
    }
    if let Some(copy) = &record.current {
        if content {
            let Some(raw) = read_copy(s, copy, true)? else {
                return Ok(json!({"drafts":[],"managed":[view],"missingBody":true}));
            };
            view["eml"] = serde_json::to_value(mailvault_core::vault_eml::parse_eml_bytes(
                &raw, copy.identity.scope.uid, drafts::FLAGS.map(String::from).to_vec(),
            )?).map_err(|error| error.to_string())?;
        }
        return Ok(json!({"drafts":[view.clone()],"managed":[response(&record,"unchanged")],"missingBody":false}));
    }
    let pending = record.pending.is_some() || record.retry.is_some();
    Ok(json!({"drafts":[],"managed":[view],"pending":pending,"missingBody":!pending}))
}

fn list(s: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let exact = params
        .get("identity")
        .map(|v| serde_json::from_value::<Location>(v.clone()).map_err(|e| e.to_string()))
        .transpose()?;
    let content = params["includeContent"].as_bool().unwrap_or(false);
    if let Some(value) = params.get("draftId") {
        let id = value.as_str().ok_or("draftId must be a string")?;
        return list_id(s, id, exact.as_ref(), content);
    }
    if content && exact.is_none() {
        return Err("draft content requires exact identity".into());
    }
    let accounts = if let Some(id) = params["accountId"].as_str() {
        vec![id.into()]
    } else {
        crate::handlers::insights::configured_account_ids(&s.app_dir)?
    };
    let mut legacy = vec![];
    for account in accounts {
        let rows = custody::with_conn(s, |c| entries::entries_for_account(c, &account))?;
        for (mailbox, row) in rows {
            if !drafts::editable(&row) {
                continue;
            }
            let Some(uid) = entries::uid_of(&row) else {
                continue;
            };
            let l = Location {
                account_id: account.clone(),
                mailbox,
                uid,
            };
            if scheduled(s, &l)? || app_db::with(&s.app_dir, |c| db::owner(c, &l))?.is_some() {
                continue;
            }
            if let Some(scope) = row["message_id"]
                .as_str()
                .and_then(|mid| Scope::new(&l.account_id, &l.mailbox, l.uid, mid))
            {
                if !app_db::with(&s.app_dir, |c| compose_receipts::load(c, &scope))?.is_empty() {
                    continue;
                }
            }
            if content && exact.as_ref() == Some(&l) {
                let id = uuid::Uuid::new_v4().to_string();
                let lock = draft_lock(s, &id);
                let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
                let mut r = Record::new(&id);
                match adopt(s, &mut r, &l) {
                    Ok(()) => {}
                    Err(error) if error == "draft body missing" => {
                        return Ok(json!({"drafts":[],"missingBody":true}))
                    }
                    Err(error) => return Err(error),
                }
            } else {
                legacy.push(json!({
                    "draftId": Value::Null, "revision": 0,
                    "accountId": l.account_id, "mailbox": l.mailbox, "uid": l.uid,
                    "entry": row, "legacy": true, "disposition": "unadopted",
                }));
            }
        }
    }
    let mut records = app_db::with(&s.app_dir, db::all)?;
    let mut selected_id = None;
    if let Some(loc) = &exact {
        selected_id = app_db::with(&s.app_dir, |c| db::owner(c, loc))?;
        if let Some(id) = &selected_id {
            let r = load(s, id)?;
            let actual = r
                .current
                .iter()
                .chain(&r.cleanup)
                .find(|c| c.location() == *loc && drafts::editable(&c.entry));
            if let Some(copy) = actual {
                let raw = read_copy(s, copy, false)?;
                if r.discarded {
                    return Ok(
                        json!({"drafts":[],"managed":[response(&r,"unchanged")],"terminal":true,"missingBody":false}),
                    );
                }
                if raw.is_none() {
                    return Ok(json!({"drafts":[],"missingBody":true}));
                }
            } else if let Some(pending) = r.pending.as_ref().filter(|p| p.copy.location() == *loc) {
                let _ = read_copy(s, &pending.copy, false)?;
                return Ok(
                    json!({"drafts":[],"managed":[response(&r,"unchanged")],"pending":true,"missingBody":false}),
                );
            } else {
                return Err("draft identity is not editable".into());
            }
        }
    }
    let mut out = vec![];
    let mut managed = vec![];
    for r in &mut records {
        if exact.is_some() && selected_id.as_deref() != Some(&r.draft_id) {
            continue;
        }
        if exact.is_none()
            && params["accountId"].as_str().is_some_and(|a| {
                r.current
                    .as_ref()
                    .is_some_and(|c| c.identity.scope.account_id != a)
            })
        {
            continue;
        }
        if content {
            let _ = recover(s, &r.draft_id);
            *r = load(s, &r.draft_id)?;
        }
        let mut view = response(r, "unchanged");
        managed.push(view.clone());
        if r.discarded {
            continue;
        }
        if content {
            if let Some(copy) = &r.current {
                let Some(raw) = read_copy(s, copy, true)? else {
                    return Ok(json!({"drafts":[],"missingBody":true}));
                };
                let parsed = mailvault_core::vault_eml::parse_eml_bytes(
                    &raw,
                    copy.identity.scope.uid,
                    drafts::FLAGS.map(String::from).to_vec(),
                )?;
                view["eml"] = serde_json::to_value(parsed).map_err(|e| e.to_string())?;
            }
        }
        if r.current.is_some() {
            out.push(view);
        }
    }
    for candidate in legacy {
        let l:Location=serde_json::from_value(json!({"accountId":candidate["accountId"],"mailbox":candidate["mailbox"],"uid":candidate["uid"]})).map_err(|e|e.to_string())?;
        if exact.as_ref().is_some_and(|exact| exact != &l)
            || app_db::with(&s.app_dir, |c| db::owner(c, &l))?.is_some()
        {
            continue;
        }
        out.push(candidate);
    }
    Ok(
        json!({"drafts":out,"managed":managed,"missingBody":content&&exact.is_some()&&selected_id.is_none()}),
    )
}
pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    if !matches!(method, "drafts.save" | "drafts.discard" | "drafts.list") {
        return None;
    }
    let request = if method == "drafts.save" {
        match Save::parse(params.clone()) {
            Ok(r) => Some(r),
            Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, e)),
        }
    } else {
        None
    };
    let s = Arc::clone(state);
    let params = params.clone();
    let method = method.to_string();
    let result = blocking(move || match method.as_str() {
        "drafts.save" => save(&s, request.unwrap()),
        "drafts.discard" => params["draftId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("draftId required".into())
            .and_then(|id| discard(&s, id)),
        _ => list(&s, &params),
    })
    .await
    .and_then(|r| r);
    Some(common::done(id, result))
}
#[cfg(not(test))]
fn probe(_: &DaemonState, _: &str) -> Result<(), String> {
    Ok(())
}
#[cfg(test)]
fn probe(s: &DaemonState, point: &str) -> Result<(), String> {
    tests::probe(s, point)
}
#[cfg(test)]
mod tests;
