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
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg, vec_arg, with_vault_write};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::custody::entries;
use mailvault_core::vault_flags::{self, AdoptReport, Applied, FlagChange, RenamePair};
use serde_json::Value;
use std::sync::Arc;
use tracing::{info, warn};

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// One or more messages whose read state changed. The whole call — root
/// resolution, `dirs_for`, `apply_everywhere` (which holds `WRITER` across
/// both the rename and the custody patch) — runs inside one
/// `with_vault_write`: `changes` is bounded by the caller (a page of
/// messages, never a vault-wide walk), so a single gate check for the whole
/// call is the same granularity `maildir_set_flags` (Task 2.8) uses.
pub(crate) fn apply_flags(
    state: &Arc<DaemonState>,
    account_id: &str,
    mailbox: &str,
    account_email: Option<&str>,
    mirror_root: Option<&str>,
    changes: &[FlagChange],
    sidecars: bool,
) -> Result<Applied, String> {
    with_vault_write(state, |root| {
        let dirs = vault_flags::dirs_for(root, account_id, mailbox, account_email, mirror_root);
        Ok(vault_flags::apply_everywhere(&dirs, changes, sidecars, |patch| {
            match daemon_custody::with_conn(state, |c| entries::patch_flags_many(c, account_id, mailbox, patch)) {
                Ok(n) => Ok(n),
                Err(e) => {
                    warn!("vault_apply_flags: custody patch failed for {}/{}: {}", account_id, mailbox, e);
                    Ok(0)
                }
            }
        }))
    })
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
    let result = with_vault_write(state, |root| -> Result<(), String> {
        let mut failed: Vec<String> = Vec::new();
        for p in &pairs {
            let from = vault_flags::dirs_for(root, account_id, &p.from, account_email, mirror_root);
            let to = vault_flags::dirs_for(root, account_id, &p.to, account_email, mirror_root);
            let (n, mut bad) = vault_flags::rename_dirs(&from, &to);
            moved += n;
            failed.append(&mut bad);
            match daemon_custody::with_conn(state, |c| entries::rename_mailbox(c, account_id, &p.from, &p.to)) {
                Ok(rows) => moved += usize::from(rows > 0),
                Err(e) => failed.push(format!("custody {} -> {} ({})", p.from, p.to, e)),
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(format!("vault rename incomplete: {}", failed.join("; ")))
        }
    });
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
    let result = with_vault_write(state, |root| -> Result<AdoptReport, String> {
        let mut report = AdoptReport::default();
        for p in &pairs {
            let from = vault_flags::dirs_for(root, account_id, &p.from, account_email, mirror_root);
            let to = vault_flags::dirs_for(root, account_id, &p.to, account_email, mirror_root);
            let out = vault_flags::adopt_dirs(&from, &to);
            any_moved |= out.moved > 0;
            let label = format!("{} -> {}", p.from, p.to);
            if out.app_moved > 0 {
                if let Err(e) = daemon_custody::with_conn(state, |c| entries::rename_mailbox(c, account_id, &p.from, &p.to)) {
                    report.failed.push(format!("custody {} -> {} ({})", p.from, p.to, e));
                }
            }
            if !out.failed.is_empty() {
                report.failed.push(format!("{}: {}", label, out.failed.join("; ")));
            } else if out.moved > 0 {
                report.adopted.push(label);
            } else if out.blocked > 0 {
                report.skipped_both_exist.push(format!("{} (exists: {})", label, out.blocked_by.join(", ")));
            }
        }
        Ok(report)
    });
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
                    let applied = apply_flags(&state, &account_id, &mailbox, account_email.as_deref(), mirror_root.as_deref(), &changes, sidecars)?;
                    if applied.renamed > 0 {
                        crate::search_index::nudge(&state.search_index, &account_id, &mailbox);
                    }
                    if applied.total() > 0 {
                        info!(
                            "vault_flags: {}/{} — {} renamed, {} mirrored, {} index, {} sidecars",
                            account_id, mailbox, applied.renamed, applied.mirrored, applied.index_patched, applied.sidecars_patched
                        );
                    }
                    serde_json::to_value(applied).map_err(|e| e.to_string())
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
    use mailvault_core::vault_files;
    use std::fs;

    fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, true);
        daemon_custody::open_into(&s);
        (vault, s)
    }

    fn seed_file(root: &std::path::Path, account: &str, mailbox: &str, uid: u32, flags: &[&str]) {
        let cur = vault_files::cur_path(root, account, mailbox);
        fs::create_dir_all(&cur).unwrap();
        let name = vault_files::build_maildir_filename(uid, &flags.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        fs::write(cur.join(name), b"body").unwrap();
    }

    fn change(uid: u32, flags: &[&str]) -> FlagChange {
        FlagChange { uid, flags: flags.iter().map(|s| s.to_string()).collect() }
    }

    fn file_names(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
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
        assert_eq!(file_names(&cur), vec!["7:2,S.eml"]);
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
                vault_flags::apply_everywhere(&dirs, &[change(1, &["\\Seen"])], false, |patch| {
                    state_flag.store(1, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(SLOW_MS));
                    let r = daemon_custody::with_conn(s, |c| entries::patch_flags_many(c, "acc", "INBOX", patch));
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
        assert_eq!(file_names(&new_cur), vec!["1:2,.eml".to_string()]);
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
        assert_eq!(file_names(&new_cur), vec!["1:2,.eml".to_string()]);
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
