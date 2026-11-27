//! `vault_apply_flags`, `vault_rename_mailbox`, `vault_adopt_mailbox_dirs`
//! (Task 2.9a): the daemon-side twin of `src-tauri/src/vault_flags.rs`'s
//! current three Tauri commands, built on core `vault_flags` (Task 2.4) and
//! the daemon's own custody (`crate::custody`) instead of an `AppHandle`'s.
//!
//! Not wired to the app yet — these routes exist so Task 2.9b can turn the
//! three Tauri commands into forwarders (spec deviation 1: a daemon cannot
//! resolve the backup mirror's security-scoped bookmark, so the app resolves
//! it and passes the already-resolved path here as `mirrorRoot`).
//!
//! Lock order (2.4 review F3, restated for this task): `apply_everywhere`
//! takes core's `vault_flags::WRITER` first, then calls into custody from
//! inside its own callback — never the reverse. No route here ever takes
//! custody's connection lock and then tries to take `WRITER`. `dirs_for`'s
//! root always comes from `common::vault_root`/`common::with_vault_write`
//! and nothing else (2.5/2.7 review constraint carried forward) — never a
//! bare `state.data_dir`.
use crate::custody as daemon_custody;
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg, vec_arg, with_mailbox_write, with_vault_write};
use crate::ipc::RpcResponse;
use crate::state::DaemonState;
use mailvault_core::custody::{cache, entries};
use mailvault_core::vault_flags::{self, AdoptReport, Applied, FlagChange, RenamePair};
use serde_json::Value;
use std::sync::Arc;
use tracing::{info, warn};

#[cfg(test)]
thread_local! {
    static AFTER_LOCAL: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = Default::default();
}

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// Serialize intent before local locks. Complete local files and custody,
/// release every local scope, then finish mirror work before replying.
pub(crate) fn apply_flags(
    state: &Arc<DaemonState>,
    account_id: &str,
    mailbox: &str,
    account_email: Option<&str>,
    mirror_root: Option<&str>,
    changes: &[FlagChange],
    sidecars: bool,
) -> Result<Applied, String> {
    vault_flags::serialized(|writer| {
      let (dirs, mut applied) = with_mailbox_write(state, account_id, mailbox, |root| {
        let dirs = vault_flags::dirs_for(root, account_id, mailbox, account_email, mirror_root);
        let applied = vault_flags::apply_local(writer, &state.vault_registry, &dirs, changes, |patch| {
            match daemon_custody::with_conn(state, |c| {
                let rows = entries::patch_flags_many(c, account_id, mailbox, patch)?;
                // `sidecars`: the header cache is what the next repaint reads,
                // so mark read/unread wants it patched; the backup reconcile
                // hands this every message a folder holds and does not.
                let headers = if sidecars { cache::patch_changes(c, account_id, mailbox, patch)? } else { 0 };
                Ok((rows, headers))
            }) {
                Ok(counts) => Ok(counts),
                Err(e) => {
                    warn!("vault_apply_flags: custody patch failed for {}/{}: {}", account_id, mailbox, e);
                    Ok((0, 0))
                }
            }
        });
        Ok((dirs, applied))
      })?;
      #[cfg(test)]
      AFTER_LOCAL.with(|hook| { if let Some(hook) = hook.borrow_mut().take() { hook(); } });
      applied.mirrored = vault_flags::apply_mirror(writer, &dirs, changes);
      Ok(applied)
    })
}

/// The flags a message carries whatever folder it is seen in. Gmail shows one
/// message under every label it has, and the vault keeps one copy per label
/// folder (INBOX, All Mail, Bin) under one Message-ID: read and starred are
/// the message's, so a copy left unread beside a read one is a lie.
const TWIN_FLAGS: &[&str] = &["\\Seen", "\\Flagged"];

/// `changes` as switches of `TWIN_FLAGS` only: `(uid, flags, on)`. A delta
/// keeps its direction; a full list (`on: None`) says, for each of the two,
/// whether the message now has it. Nothing else is carried to another copy.
fn twin_switches(changes: &[FlagChange]) -> Vec<(u32, Vec<String>, bool)> {
    let shared = |f: &String| TWIN_FLAGS.iter().any(|t| t.eq_ignore_ascii_case(f));
    let mut out = Vec::new();
    for change in changes {
        match change.on {
            Some(on) => {
                let flags: Vec<String> = change.flags.iter().filter(|f| shared(f)).cloned().collect();
                if !flags.is_empty() {
                    out.push((change.uid, flags, on));
                }
            }
            None => {
                for flag in TWIN_FLAGS {
                    let has = change.flags.iter().any(|f| f.eq_ignore_ascii_case(flag));
                    out.push((change.uid, vec![(*flag).to_string()], has));
                }
            }
        }
    }
    out
}

/// Every mailbox path the account's custody store names, to read an index
/// row's vault directory back as the folder custody and the header cache key
/// by ("_Google_Mail__Bin" is "[Google Mail]/Bin").
fn known_mailboxes(state: &Arc<DaemonState>, account_id: &str) -> Vec<String> {
    daemon_custody::with_conn(state, |c| {
        let mut stmt = c
            .prepare(
                "SELECT mailbox_path FROM header_cache_meta WHERE account_id=?1
                 UNION SELECT DISTINCT mailbox_path FROM header_cache WHERE account_id=?1
                 UNION SELECT DISTINCT mailbox_path FROM vault_entries WHERE account_id=?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([account_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .unwrap_or_default()
}

/// Carry a flag change on `mailbox`'s messages to their other copies in the
/// same account (other folders, same Message-ID), through `apply_flags`, so
/// each twin's file, mirror copy, custody entry and header sidecar move as
/// the named copy's did. Runs after the named folder's own change returned:
/// no lock of it is held here, and each twin folder takes its own in turn.
/// Found through the search index; with the index closed nothing is carried
/// (logged), never an error for the change the caller asked for. Returns how
/// many twin copies were changed.
pub(crate) fn apply_to_twins(
    state: &Arc<DaemonState>,
    account_id: &str,
    mailbox: &str,
    account_email: Option<&str>,
    mirror_root: Option<&str>,
    changes: &[FlagChange],
    sidecars: bool,
) -> usize {
    use mailvault_core::search_index::text::{mailboxes_from_vault_dirs, vault_dir_name};
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    let switches = twin_switches(changes);
    if switches.is_empty() {
        return 0;
    }
    let uids: Vec<u32> = switches.iter().map(|(uid, _, _)| *uid).collect::<BTreeSet<_>>().into_iter().collect();
    let ids = match crate::search_index::known_message_ids(&state.search_index, account_id, mailbox, &uids) {
        Ok(ids) => ids,
        Err(e) => {
            info!("vault_flags: {}/{} twins not looked up: {}", account_id, mailbox, e);
            return 0;
        }
    };
    let id_of: HashMap<u32, String> = ids.into_iter().filter_map(|(uid, id)| id.filter(|i| !i.trim().is_empty()).map(|i| (uid, i))).collect();
    let wanted: Vec<String> = id_of.values().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    if wanted.is_empty() {
        return 0;
    }
    let twins = match crate::search_index::message_id_twins(&state.search_index, account_id, &vault_dir_name(mailbox), &wanted) {
        Ok(twins) if !twins.is_empty() => twins,
        Ok(_) => return 0,
        Err(e) => {
            info!("vault_flags: {}/{} twins not looked up: {}", account_id, mailbox, e);
            return 0;
        }
    };
    let dirs: Vec<String> = twins.iter().map(|(dir, _, _)| dir.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    let folder_of: HashMap<String, String> =
        dirs.iter().cloned().zip(mailboxes_from_vault_dirs(&dirs, &known_mailboxes(state, account_id))).collect();
    // One `apply_flags` per (twin folder, direction): a full list can switch
    // \Seen on and \Flagged off on one copy, and a change holds one `on`.
    let mut work: BTreeMap<(String, bool), Vec<FlagChange>> = BTreeMap::new();
    let mut copies: BTreeSet<(String, u32)> = BTreeSet::new();
    for (dir, twin_uid, id) in &twins {
        let folder = &folder_of[dir];
        for (uid, flags, on) in &switches {
            if id_of.get(uid) == Some(id) {
                work.entry((folder.clone(), *on)).or_default().push(FlagChange { uid: *twin_uid, flags: flags.clone(), on: Some(*on) });
                copies.insert((folder.clone(), *twin_uid));
            }
        }
    }
    for ((folder, _), twin_changes) in &work {
        if let Err(e) = apply_flags(state, account_id, folder, account_email, mirror_root, twin_changes, sidecars) {
            warn!("vault_flags: {}/{} twin copies in {} not updated: {}", account_id, mailbox, folder, e);
        }
    }
    info!("vault_flags: {}/{} carried to {} twin cop(ies) in {} folder(s)", account_id, mailbox, copies.len(), folder_of.len());
    copies.len()
}

/// Shallowest-pair-first, matching the app's own ordering (the mirror nests,
/// so a parent's move has to land before its descendants' pairs). Every pair
/// is attempted before the first failure is reported — the server has
/// already renamed the whole subtree, so stopping halfway would strand
/// directories that could still have moved. `moved` is tracked outside the
/// gate's `Result` so a partial failure still sweeps for whatever did move,
/// exactly as the app command does today.
pub(crate) fn rename_mailbox(
    state: &Arc<DaemonState>,
    account_id: &str,
    account_email: Option<&str>,
    mirror_root: Option<&str>,
    mut pairs: Vec<RenamePair>,
) -> (usize, Result<(), String>) {
    pairs.sort_by_key(|p| p.from.len());
    let mut moved = 0usize;
    let result = (|| {
      let mut mirror_work = Vec::new();
      let mut failed = with_vault_write(state, |root| {
        let mut failed: Vec<String> = Vec::new();
        for p in &pairs {
            let from = vault_flags::dirs_for(root, account_id, &p.from, account_email, mirror_root);
            let to = vault_flags::dirs_for(root, account_id, &p.to, account_email, mirror_root);
            let (n, mut bad) = vault_flags::rename_local_dirs(&state.vault_registry, &from, &to);
            moved += n;
            failed.append(&mut bad);
            mirror_work.push((from, to));
            match daemon_custody::with_conn(state, |c| entries::rename_mailbox(c, account_id, &p.from, &p.to)) {
                Ok(rows) => moved += usize::from(rows > 0),
                Err(e) => failed.push(format!("custody {} -> {} ({})", p.from, p.to, e)),
            }
            if let Err(e) = daemon_custody::with_conn(state, |c| cache::rename_mailbox(c, account_id, &p.from, &p.to)) {
                failed.push(format!("header cache {} -> {} ({})", p.from, p.to, e));
            }
        }
        Ok(failed)
      })?;
      for (from, to) in mirror_work {
          let (n, bad) = vault_flags::rename_mirror_dirs(&from, &to);
          moved += n; failed.extend(bad);
      }
      if failed.is_empty() { Ok(()) }
      else { Err(format!("vault rename incomplete: {}", failed.join("; "))) }
    })();
    (moved, result)
}

/// As `rename_mailbox`, but the inner loop never itself returns `Err` — every
/// pair's outcome (adopted / left in place / failed) lands in the report, and
/// only the caller decides whether `report.failed` makes this an error. Kept
/// distinct from `rename_mailbox` because `adopt_dirs`'s report shape
/// (adopted/skipped/failed) differs from a plain moved count.
pub(crate) fn adopt_mailbox_dirs(
    state: &Arc<DaemonState>,
    account_id: &str,
    account_email: Option<&str>,
    mirror_root: Option<&str>,
    mut pairs: Vec<RenamePair>,
) -> (bool, Result<AdoptReport, String>) {
    pairs.sort_by_key(|p| p.from.len());
    let mut any_moved = false;
    let result = (|| {
      let work = with_vault_write(state, |root| {
        let mut work = Vec::new();
        for p in &pairs {
            let from = vault_flags::dirs_for(root, account_id, &p.from, account_email, mirror_root);
            let to = vault_flags::dirs_for(root, account_id, &p.to, account_email, mirror_root);
            let out = vault_flags::adopt_local_dirs(&state.vault_registry, &from, &to);
            any_moved |= out.moved > 0;
            let mut failures = Vec::new();
            if out.app_moved > 0 {
                if let Err(e) = daemon_custody::with_conn(state, |c| entries::rename_mailbox(c, account_id, &p.from, &p.to)) {
                    failures.push(format!("custody {} -> {} ({})", p.from, p.to, e));
                }
                if let Err(e) = daemon_custody::with_conn(state, |c| cache::rename_mailbox(c, account_id, &p.from, &p.to)) {
                    failures.push(format!("header cache {} -> {} ({})", p.from, p.to, e));
                }
            }
            work.push((format!("{} -> {}", p.from, p.to), from, to, out, failures));
        }
        Ok(work)
      })?;
      let mut report = AdoptReport::default();
      for (label, from, to, mut out, failures) in work {
          vault_flags::adopt_mirror_dirs(&from, &to, &mut out);
          any_moved |= out.moved > 0;
          report.failed.extend(failures);
          if !out.failed.is_empty() { report.failed.push(format!("{}: {}", label, out.failed.join("; "))); }
          else if out.moved > 0 { report.adopted.push(label); }
          else if out.blocked > 0 { report.skipped_both_exist.push(format!("{} (exists: {})", label, out.blocked_by.join(", "))); }
      }
      Ok(report)
    })();
    (any_moved, result)
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "vault_apply_flags" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let account_email = opt_str_arg(params, "accountEmail");
            let mirror_root = opt_str_arg(params, "mirrorRoot");
            let changes = req!(vec_arg::<FlagChange>(&id, params, "changes"));
            let sidecars = params.get("sidecars").and_then(Value::as_bool).unwrap_or(true);
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    // Each rename nudges the index through the registry's change hook.
                    let applied = apply_flags(&state, &account_id, &mailbox, account_email.as_deref(), mirror_root.as_deref(), &changes, sidecars)?;
                    if applied.total() > 0 {
                        info!(
                            "vault_flags: {}/{} — {} renamed, {} mirrored, {} index, {} sidecars",
                            account_id, mailbox, applied.renamed, applied.mirrored, applied.index_patched, applied.sidecars_patched
                        );
                    }
                    // Only here, never in `apply_flags`: the backup's reconcile
                    // hands that every message of one folder as that folder's
                    // server holds it, and must not overwrite another folder.
                    let twins = apply_to_twins(&state, &account_id, &mailbox, account_email.as_deref(), mirror_root.as_deref(), &changes, sidecars);
                    let mut out = serde_json::to_value(applied).map_err(|e| e.to_string())?;
                    out["twins"] = serde_json::json!(twins);
                    Ok(out)
                })
                .await
                .and_then(|r| r),
            )
        }
        "vault_rename_mailbox" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let account_email = opt_str_arg(params, "accountEmail");
            let mirror_root = opt_str_arg(params, "mirrorRoot");
            let pairs = req!(vec_arg::<RenamePair>(&id, params, "pairs"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let pair_count = pairs.len();
                    let (moved, result) = rename_mailbox(&state, &account_id, account_email.as_deref(), mirror_root.as_deref(), pairs);
                    if moved > 0 {
                        crate::search_index::sweep_soon(&state.search_index); // old folders' rows go, new ones' come
                    }
                    result?;
                    info!("vault_rename_mailbox: {} — {} location(s) moved for {} pair(s)", account_id, moved, pair_count);
                    Ok(serde_json::json!(moved))
                })
                .await
                .and_then(|r| r),
            )
        }
        "vault_adopt_mailbox_dirs" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let account_email = opt_str_arg(params, "accountEmail");
            let mirror_root = opt_str_arg(params, "mirrorRoot");
            let pairs = req!(vec_arg::<RenamePair>(&id, params, "pairs"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let (any_moved, result) = adopt_mailbox_dirs(&state, &account_id, account_email.as_deref(), mirror_root.as_deref(), pairs);
                    if any_moved {
                        crate::search_index::sweep_soon(&state.search_index);
                    }
                    let report = result?;
                    let line = format!(
                        "vault_adopt_mailbox_dirs: {} — adopted {:?}, left in place {:?}, failed {}",
                        account_id, report.adopted, report.skipped_both_exist, report.failed.len()
                    );
                    if report.skipped_both_exist.is_empty() {
                        info!("{}", line);
                    } else {
                        warn!("{}", line);
                    }
                    if !report.failed.is_empty() {
                        return Err(format!("vault adopt incomplete: {}", report.failed.join("; ")));
                    }
                    serde_json::to_value(report).map_err(|e| e.to_string())
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
    use mailvault_core::maildir::INFO_PREFIX;
    use mailvault_core::vault_files;
    use std::fs;

    fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, true);
        let _ = daemon_custody::open_into(&s);
        (vault, s)
    }

    fn seed_file(root: &std::path::Path, account: &str, mailbox: &str, uid: u32, flags: &[&str]) {
        let cur = vault_files::cur_path(root, account, mailbox);
        fs::create_dir_all(&cur).unwrap();
        let name = vault_files::build_maildir_filename(uid, &flags.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        fs::write(cur.join(name), b"body").unwrap();
    }

    fn change(uid: u32, flags: &[&str]) -> FlagChange {
        FlagChange { uid, flags: flags.iter().map(|s| s.to_string()).collect(), on: None }
    }

    fn file_names(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn mirror_exclusion_paused_flags_leave_local_and_bulk_controls_responsive() {
        use mailvault_core::mirror_mutation::MirrorRoot;
        use std::sync::mpsc;
        use std::time::Duration;
        let (vault, state) = st();
        let mirror = tempfile::tempdir().unwrap();
        let cur = mailvault_core::maildir::mirror_cur(mirror.path(), "me@test", "INBOX").unwrap();
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join("7.eml"), b"body").unwrap();
        seed_file(vault.path(), "acc", "INBOX", 7, &[]);
        daemon_custody::with_conn(&state, |c| entries::upsert(c, "acc", "INBOX", &[serde_json::json!({"uid":7,"flags":[]})])).unwrap();
        let scope = serde_json::from_value(serde_json::json!({"keys":[]})).unwrap();
        let intent = mailvault_core::bulk::FrozenIntent::freeze(mailvault_core::bulk::Action::Delete, scope, &[], &[]);
        state.bulk.lock().unwrap().claim(&state.app_dir, "mirror-control", intent).unwrap();
        let root = MirrorRoot::resolve(mirror.path()).unwrap();
        let (local_tx, local_rx) = mpsc::channel();
        let (first_tx, first_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        let (attempt_tx, attempt_rx) = mpsc::channel();
        std::thread::scope(|threads| {
            root.mutate(|_| {
                let state = &state;
                let mirror = mirror.path();
                threads.spawn(move || {
                    AFTER_LOCAL.with(|hook| *hook.borrow_mut() = Some(Box::new(move || local_tx.send(()).unwrap())));
                    first_tx.send(apply_flags(state, "acc", "INBOX", Some("me@test"), Some(mirror.to_str().unwrap()), &[change(7, &["\\Seen"])], false)).unwrap();
                });
                local_rx.recv_timeout(Duration::from_secs(10)).expect("first flag never completed local phase");
                threads.spawn(move || {
                    attempt_tx.send(()).unwrap();
                    second_tx.send(apply_flags(state, "acc", "INBOX", Some("me@test"), Some(mirror.to_str().unwrap()), &[change(7, &["\\Flagged"])], false)).unwrap();
                });
                attempt_rx.recv().unwrap();
                let (control_tx, control_rx) = mpsc::channel();
                threads.spawn(move || {
                    with_mailbox_write(state, "acc", "INBOX", |_| {
                        daemon_custody::with_conn(state, |c| entries::read(c, "acc", "INBOX"))?;
                        Ok(())
                    }).unwrap();
                    let runtime = tokio::runtime::Runtime::new().unwrap();
                    runtime.block_on(async {
                        let status = crate::handlers::bulk::route(state, "bulk.status", &serde_json::json!({}), serde_json::json!(1)).await.unwrap();
                        assert!(status.error.is_none());
                        let cancel = crate::handlers::bulk::route(state, "bulk.cancel", &serde_json::json!({"operationId":"mirror-control"}), serde_json::json!(2)).await.unwrap();
                        assert!(cancel.error.is_none());
                    });
                    control_tx.send(()).unwrap();
                });
                control_rx.recv_timeout(Duration::from_secs(10)).expect("mirror wait or WRITER waiter retained local/bulk locks");
                assert!(first_rx.try_recv().is_err(), "reply released before mirror phase");
                assert!(second_rx.try_recv().is_err(), "second flag bypassed WRITER");
                Ok(())
            }).unwrap();
            assert_eq!(first_rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap().mirrored, 1);
            assert_eq!(second_rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap().mirrored, 1);
        });
        assert_eq!(file_names(&cur), vec![mailvault_core::maildir::mirror_filename(7, &["flagged".into()])]);
        let stored = daemon_custody::with_conn(&state, |c| entries::read(c, "acc", "INBOX")).unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap()[0]["flags"], serde_json::json!(["\\Flagged"]));
    }

    #[test]
    fn apply_flags_renames_and_patches_custody_in_one_call() {
        let (vault, s) = st();
        seed_file(vault.path(), "acc", "INBOX", 7, &[]);
        daemon_custody::with_conn(&s, |c| entries::upsert(c, "acc", "INBOX", &[serde_json::json!({"uid": 7, "flags": []})])).unwrap();

        let applied = apply_flags(&s, "acc", "INBOX", None, None, &[change(7, &["\\Seen"])], true).unwrap();

        assert_eq!(applied.renamed, 1);
        assert_eq!(applied.index_patched, 1);
        let cur = vault_files::cur_path(vault.path(), "acc", "INBOX");
        assert_eq!(file_names(&cur), vec![format!("7{INFO_PREFIX}S.eml")]);
        let text = daemon_custody::with_conn(&s, |c| entries::read(c, "acc", "INBOX")).unwrap().unwrap();
        let rows: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert_eq!(rows[0]["flags"], serde_json::json!(["\\Seen"]));
    }

    /// 2.9a review focus: the daemon must finish (or abandon) every mirror
    /// rename before it replies — a route that returned after only SOME of a
    /// batch's mirror files were renamed would let the app's forwarder
    /// (Task 2.9b) release the backup's security-scoped bookmark while a
    /// rename was still in flight. `apply_flags` never spawns the mirror work
    /// away: it is one synchronous call into `apply_everywhere`, which loops
    /// every change before returning. A mirror holding N stale files (all N
    /// disagreeing with the server's flags) must show `mirrored == N` in the
    /// one reply, not a partial count.
    #[test]
    fn apply_flags_finishes_every_mirror_rename_before_replying() {
        let (vault, s) = st();
        let cur = vault_files::cur_path(vault.path(), "acc", "INBOX");
        let mirror_cur = vault.path().join("mirror").join("me@mock.test").join("INBOX").join("cur");
        fs::create_dir_all(&cur).unwrap();
        fs::create_dir_all(&mirror_cur).unwrap();
        const N: u32 = 12;
        let mut changes = Vec::new();
        for uid in 0..N {
            fs::write(cur.join(vault_files::build_maildir_filename(uid, &[])), b"body").unwrap();
            fs::write(mirror_cur.join(vault_files::build_maildir_filename(uid, &[])), b"body").unwrap();
            changes.push(change(uid, &["\\Seen"]));
        }

        let applied = apply_flags(
            &s,
            "acc",
            "INBOX",
            Some("me@mock.test"),
            Some(vault.path().join("mirror").to_str().unwrap()),
            &changes,
            false,
        )
        .unwrap();

        assert_eq!(applied.renamed, N as usize, "every vault-side stale copy must be renamed by the time the call returns");
        assert_eq!(applied.mirrored, N as usize, "every mirror-side stale copy must be renamed by the time the call returns");
        for uid in 0..N {
            assert!(mirror_cur.join(vault_files::build_maildir_filename(uid, &["seen".to_string()])).exists(), "uid {uid} mirror copy not renamed");
        }
    }

    /// The params exactly as `api.vaultApplyFlags` sends a note's star: one
    /// flag on, over whatever the file, the custody entry and the cached
    /// header hold by then. A note read since the board loaded stays read.
    #[tokio::test]
    async fn a_delta_through_the_route_moves_one_flag_on_every_record() {
        let (vault, s) = st();
        seed_file(vault.path(), "acc", "INBOX", 7, &["archived", "seen"]);
        daemon_custody::with_conn(&s, |c| {
            entries::upsert(c, "acc", "INBOX", &[serde_json::json!({"uid": 7, "flags": ["\\Seen"]})])?;
            cache::save_headers(c, "acc", "INBOX", &serde_json::json!({"emails": [{"uid": 7, "flags": ["\\Seen", "$Forwarded"]}]}).to_string())?;
            Ok(())
        })
        .unwrap();
        let star = |on: bool| serde_json::json!({"accountId": "acc", "mailbox": "INBOX", "accountEmail": null, "changes": [{"uid": 7, "flags": ["\\Flagged"], "on": on}]});
        let header_flags = || {
            daemon_custody::with_conn(&s, |c| {
                c.query_row("SELECT header_json FROM header_cache WHERE account_id='acc' AND uid=7", [], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())
            })
            .map(|text| serde_json::from_str::<Value>(&text).unwrap()["flags"].clone())
            .unwrap()
        };
        let entry_flags = || {
            let text = daemon_custody::with_conn(&s, |c| entries::read(c, "acc", "INBOX")).unwrap().unwrap();
            serde_json::from_str::<Vec<Value>>(&text).unwrap()[0]["flags"].clone()
        };
        let cur = vault_files::cur_path(vault.path(), "acc", "INBOX");

        let resp = route(&s, "vault_apply_flags", &star(true), serde_json::json!(1)).await.unwrap();
        assert!(resp.error.is_none(), "{:?}", resp.error.map(|e| e.message));
        assert_eq!(file_names(&cur), vec![format!("7{INFO_PREFIX}AFS.eml")]);
        assert_eq!(entry_flags(), serde_json::json!(["\\Seen", "\\Flagged"]));
        assert_eq!(header_flags(), serde_json::json!(["\\Seen", "$Forwarded", "\\Flagged"]));

        route(&s, "vault_apply_flags", &star(false), serde_json::json!(2)).await.unwrap();
        assert_eq!(file_names(&cur), vec![format!("7{INFO_PREFIX}AS.eml")]);
        assert_eq!(entry_flags(), serde_json::json!(["\\Seen"]));
        assert_eq!(header_flags(), serde_json::json!(["\\Seen", "$Forwarded"]));
    }

    /// Gmail keeps one vault copy per label folder, all with one Message-ID.
    /// Marking the INBOX copy read must mark its Bin twin read too (file,
    /// custody, header sidecar), and leave a different message alone.
    #[tokio::test]
    async fn a_flag_change_reaches_the_same_message_in_the_accounts_other_folders() {
        use mailvault_core::search_index::{db as index_db, lock};
        let (vault, s) = st();
        let bin = "[Google Mail]/Bin";
        seed_file(vault.path(), "acc", "INBOX", 1, &["archived"]);
        seed_file(vault.path(), "acc", bin, 7, &["archived"]);
        seed_file(vault.path(), "acc", bin, 8, &["archived"]);
        seed_file(vault.path(), "other", bin, 7, &["archived"]);
        daemon_custody::with_conn(&s, |c| {
            cache::save_headers(c, "acc", "INBOX", &serde_json::json!({"emails": [{"uid": 1, "flags": [], "messageId": "<x@y>"}]}).to_string())?;
            cache::save_headers(c, "acc", bin, &serde_json::json!({"emails": [
                {"uid": 7, "flags": [], "messageId": "<x@y>"},
                {"uid": 8, "flags": [], "messageId": "<z@y>"}
            ]}).to_string())?;
            entries::upsert(c, "acc", bin, &[serde_json::json!({"uid": 7, "flags": []})])?;
            Ok(())
        })
        .unwrap();
        let conn = index_db::open(&s.data_dir).unwrap();
        for (account, mailbox, uid, id) in [("acc", "INBOX", 1, "<x@y>"), ("acc", bin, 7, "<x@y>"), ("acc", bin, 8, "<z@y>"), ("other", bin, 7, "<x@y>")] {
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc) VALUES (?1,?2,?3,?4,0,0,?5,0)",
                rusqlite::params![account, mailvault_core::search_index::text::vault_dir_name(mailbox), uid, format!("{uid}{INFO_PREFIX}A.eml"), id],
            )
            .unwrap();
        }
        *lock(&s.search_index.db) = Some(conn);

        let seen = |on: bool| serde_json::json!({"accountId": "acc", "mailbox": "INBOX", "accountEmail": null, "changes": [{"uid": 1, "flags": ["\\Seen"], "on": on}]});
        let header_flags = |mailbox: &str, uid: u32| {
            daemon_custody::with_conn(&s, |c| {
                c.query_row(
                    "SELECT header_json FROM header_cache WHERE account_id='acc' AND mailbox_path=?1 AND uid=?2",
                    rusqlite::params![mailbox, uid],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|e| e.to_string())
            })
            .map(|text| serde_json::from_str::<Value>(&text).unwrap()["flags"].clone())
            .unwrap()
        };
        let inbox = vault_files::cur_path(vault.path(), "acc", "INBOX");
        let bin_cur = vault_files::cur_path(vault.path(), "acc", bin);
        let other_cur = vault_files::cur_path(vault.path(), "other", bin);

        let resp = route(&s, "vault_apply_flags", &seen(true), serde_json::json!(1)).await.unwrap();
        let result = resp.result.unwrap_or_else(|| panic!("{:?}", resp.error.map(|e| e.message)));
        assert_eq!(result["twins"], serde_json::json!(1), "{result}");
        assert_eq!(file_names(&inbox), vec![format!("1{INFO_PREFIX}AS.eml")]);
        assert_eq!(file_names(&bin_cur), vec![format!("7{INFO_PREFIX}AS.eml"), format!("8{INFO_PREFIX}A.eml")], "the twin is read, the other message is not");
        assert_eq!(file_names(&other_cur), vec![format!("7{INFO_PREFIX}A.eml")], "another account's copy is never touched");
        assert_eq!(header_flags(bin, 7), serde_json::json!(["\\Seen"]));
        assert_eq!(header_flags(bin, 8), serde_json::json!([]));

        route(&s, "vault_apply_flags", &seen(false), serde_json::json!(2)).await.unwrap();
        assert_eq!(file_names(&inbox), vec![format!("1{INFO_PREFIX}A.eml")]);
        assert_eq!(file_names(&bin_cur), vec![format!("7{INFO_PREFIX}A.eml"), format!("8{INFO_PREFIX}A.eml")]);
        assert_eq!(header_flags(bin, 7), serde_json::json!([]));
    }

    #[test]
    fn apply_flags_refuses_while_the_vault_is_being_moved() {
        let (_vault, s) = st();
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let err = apply_flags(&s, "acc", "INBOX", None, None, &[change(7, &["\\Seen"])], true).unwrap_err();
        assert!(err.starts_with("E_VAULT_UNAVAILABLE:"), "{err}");
    }

    /// 2.4 review F3, restated for the daemon: `apply_everywhere` must hold
    /// `WRITER` across BOTH the rename and the custody patch. An ordering
    /// probe, not a timing guess (2.4 review I1's own fix, copied here
    /// against the daemon's own custody instead of a test closure): the
    /// first caller's callback flips a shared `AtomicU8` 0 -> 1 on entry ->
    /// 2 on return; the second caller waits (bounded poll) for `1` before
    /// even calling `apply_flags`, then asserts from inside ITS OWN custody
    /// callback that it reads `2` — which can only be true if the first
    /// caller's callback had already returned, i.e. `WRITER` was still held
    /// across it.
    #[test]
    fn apply_flags_holds_writer_across_the_custody_callback_not_just_the_rename() {
        let (vault, s) = st();
        seed_file(vault.path(), "acc", "INBOX", 1, &[]);
        seed_file(vault.path(), "acc", "INBOX", 2, &[]);
        daemon_custody::with_conn(&s, |c| {
            entries::upsert(c, "acc", "INBOX", &[serde_json::json!({"uid": 1, "flags": []}), serde_json::json!({"uid": 2, "flags": []})])
        })
        .unwrap();
        const SLOW_MS: u64 = 150;
        let state_flag = std::sync::atomic::AtomicU8::new(0);
        let state_flag = &state_flag;
        let s = &s;
        // Own the path, not the `TempDir` guard: moving `vault` itself into
        // thread A's closure would drop (and recursively delete) the whole
        // vault directory the instant that closure body finishes — which can
        // race thread B's own directory listing right after WRITER releases,
        // intermittently deleting uid 2's file before B ever sees it. Keeping
        // `vault` alive in the test function's own frame until `scope()`
        // returns is what `two_hundred_rounds_...` below already does.
        let vault_path = vault.path().to_path_buf();

        std::thread::scope(|scope| {
            scope.spawn(move || {
                // A's custody write is the slow one: patch_flags_many runs
                // inside apply_everywhere's callback, so sleeping right
                // before it keeps WRITER held for SLOW_MS while custody is
                // untouched yet — the probe is entirely inside the window
                // `apply_everywhere` promises to hold WRITER for.
                let dirs = vault_flags::dirs_for(&vault_path, "acc", "INBOX", None, None);
                vault_flags::apply_everywhere(&s.vault_registry, &dirs, &[change(1, &["\\Seen"])], |patch| {
                    state_flag.store(1, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(SLOW_MS));
                    let r = daemon_custody::with_conn(s, |c| entries::patch_flags_many(c, "acc", "INBOX", patch))
                        .map(|n| (n, 0));
                    state_flag.store(2, std::sync::atomic::Ordering::SeqCst);
                    r
                });
            });

            let poll_start = std::time::Instant::now();
            while state_flag.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                assert!(poll_start.elapsed() < std::time::Duration::from_secs(10), "A never entered its callback");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }

            scope.spawn(move || {
                let applied = apply_flags(s, "acc", "INBOX", None, None, &[change(2, &["\\Flagged"])], false).unwrap();
                assert_eq!(
                    state_flag.load(std::sync::atomic::Ordering::SeqCst),
                    2,
                    "B's apply_flags call must not proceed until A's callback (rename AND custody patch) has returned"
                );
                assert_eq!(applied.renamed, 1);
            });
        });
    }

    /// Step 5: two threads applying OPPOSITE flags to ONE uid must never end
    /// with the filename saying one thing and the custody row saying the
    /// other — repeated to flush out ordering flakiness a single run could
    /// miss. Whichever call's `WRITER` acquisition runs last determines both
    /// halves' outcome (each computes its rename fresh from what is on disk
    /// right now, and custody stores that same call's raw imap flags), so
    /// this also proves `apply_everywhere` never releases `WRITER` between
    /// the two callers' full applications.
    ///
    /// Two long-lived worker threads handshake per round over channels,
    /// rather than `thread::scope`-ing a fresh pair 200 times: 400 short-lived
    /// OS threads was needless churn once the real interference (see the
    /// sibling test's fix below) was found and fixed. Same two-caller race
    /// every round; far fewer threads.
    #[test]
    fn two_hundred_rounds_of_opposite_concurrent_flags_never_split_filename_from_custody() {
        let (vault, s) = st();
        let cur = vault_files::cur_path(vault.path(), "acc", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        daemon_custody::with_conn(&s, |c| entries::upsert(c, "acc", "INBOX", &[serde_json::json!({"uid": 7, "flags": []})])).unwrap();
        let s = &s;

        let (go_a_tx, go_a_rx) = std::sync::mpsc::channel::<()>();
        let (go_b_tx, go_b_rx) = std::sync::mpsc::channel::<()>();
        let (done_a_tx, done_a_rx) = std::sync::mpsc::channel::<()>();
        let (done_b_tx, done_b_rx) = std::sync::mpsc::channel::<()>();

        std::thread::scope(|scope| {
            scope.spawn(move || {
                for _ in 0..200 {
                    if go_a_rx.recv().is_err() {
                        break;
                    }
                    apply_flags(s, "acc", "INBOX", None, None, &[change(7, &["\\Seen"])], false).unwrap();
                    done_a_tx.send(()).unwrap();
                }
            });
            scope.spawn(move || {
                for _ in 0..200 {
                    if go_b_rx.recv().is_err() {
                        break;
                    }
                    apply_flags(s, "acc", "INBOX", None, None, &[change(7, &["\\Flagged"])], false).unwrap();
                    done_b_tx.send(()).unwrap();
                }
            });

            for i in 0..200 {
                for entry in fs::read_dir(&cur).unwrap().flatten() {
                    fs::remove_file(entry.path()).unwrap();
                }
                fs::write(cur.join(vault_files::build_maildir_filename(7, &[])), b"body").unwrap();

                go_a_tx.send(()).unwrap();
                go_b_tx.send(()).unwrap();
                done_a_rx.recv().unwrap();
                done_b_rx.recv().unwrap();

                let files = file_names(&cur);
                assert_eq!(files.len(), 1, "round {i}: expected exactly one file, got {files:?}");
                let file_flags = mailvault_core::vault_eml::parse_flags_from_filename(&files[0]);
                let file_seen = file_flags.iter().any(|f| f == "\\Seen");
                let file_flagged = file_flags.iter().any(|f| f == "\\Flagged");
                assert_ne!(file_seen, file_flagged, "round {i}: exactly one change must have won on disk");

                let text = daemon_custody::with_conn(s, |c| entries::read(c, "acc", "INBOX")).unwrap().unwrap();
                let rows: Vec<Value> = serde_json::from_str(&text).unwrap();
                let custody_flags: Vec<String> = serde_json::from_value(rows[0]["flags"].clone()).unwrap();
                let custody_seen = custody_flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen"));
                let custody_flagged = custody_flags.iter().any(|f| f.eq_ignore_ascii_case("\\Flagged"));

                assert_eq!(file_seen, custody_seen, "round {i}: filename and custody disagree on \\Seen");
                assert_eq!(file_flagged, custody_flagged, "round {i}: filename and custody disagree on \\Flagged");
            }
        });
    }

    #[test]
    fn rename_mailbox_moves_the_maildir_and_sidecar_dirs_and_the_custody_rows() {
        let (vault, s) = st();
        seed_file(vault.path(), "acc", "Projects", 1, &[]);
        let sidecar = mailvault_core::header_cache::sidecar_dir(vault.path(), "acc", "Projects");
        fs::create_dir_all(&sidecar).unwrap();
        fs::write(sidecar.join("1.json"), r#"{"uid":1,"flags":[]}"#).unwrap();
        daemon_custody::with_conn(&s, |c| entries::upsert(c, "acc", "Projects", &[serde_json::json!({"uid": 1, "flags": []})])).unwrap();

        let (moved, result) = rename_mailbox(&s, "acc", None, None, vec![RenamePair { from: "Projects".into(), to: "Work".into() }]);
        result.unwrap();
        assert!(moved >= 2, "expected the maildir dir, the sidecar dir and the custody row to move: moved={moved}");

        let new_cur = vault_files::cur_path(vault.path(), "acc", "Work");
        assert_eq!(file_names(&new_cur), vec![format!("1{INFO_PREFIX}.eml")]);
        let new_sidecar = mailvault_core::header_cache::sidecar_dir(vault.path(), "acc", "Work");
        assert!(new_sidecar.join("1.json").exists());
        assert_eq!(daemon_custody::with_conn(&s, |c| entries::read(c, "acc", "Projects")).unwrap(), None);
        assert!(daemon_custody::with_conn(&s, |c| entries::read(c, "acc", "Work")).unwrap().is_some());
    }

    #[test]
    fn adopt_mailbox_dirs_moves_the_app_side_as_a_unit_and_renames_custody_rows() {
        let (vault, s) = st();
        seed_file(vault.path(), "acc", "Gesendet", 1, &[]);
        let sidecar = mailvault_core::header_cache::sidecar_dir(vault.path(), "acc", "Gesendet");
        fs::create_dir_all(&sidecar).unwrap();
        daemon_custody::with_conn(&s, |c| entries::upsert(c, "acc", "Gesendet", &[serde_json::json!({"uid": 1, "flags": []})])).unwrap();

        let (any_moved, result) = adopt_mailbox_dirs(&s, "acc", None, None, vec![RenamePair { from: "Gesendet".into(), to: "Sent".into() }]);
        let report = result.unwrap();
        assert!(any_moved);
        assert_eq!(report.adopted, vec!["Gesendet -> Sent"]);
        assert!(report.failed.is_empty());

        let new_cur = vault_files::cur_path(vault.path(), "acc", "Sent");
        assert_eq!(file_names(&new_cur), vec![format!("1{INFO_PREFIX}.eml")]);
        assert!(daemon_custody::with_conn(&s, |c| entries::read(c, "acc", "Sent")).unwrap().is_some());
    }

    #[test]
    fn adopt_mailbox_dirs_reports_blocked_when_the_destination_already_exists() {
        let (vault, s) = st();
        seed_file(vault.path(), "acc", "Gesendet", 1, &[]);
        seed_file(vault.path(), "acc", "Sent", 2, &[]);

        let (_any_moved, result) = adopt_mailbox_dirs(&s, "acc", None, None, vec![RenamePair { from: "Gesendet".into(), to: "Sent".into() }]);
        let report = result.unwrap();
        assert!(report.adopted.is_empty());
        assert_eq!(report.skipped_both_exist.len(), 1);
    }
}
