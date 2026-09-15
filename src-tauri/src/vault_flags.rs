//! The three Tauri commands for read-state changes and mailbox renames — spec
//! deviation 1: they resolve the backup mirror's security-scoped bookmark
//! around every call, which a daemon cannot do, so they stay registered as
//! forwarders (Phase 2 keeps the app doing the actual file/custody work,
//! until Task 2.9b per that deviation). Everything that
//! does not need an `AppHandle` — `FlagChange`, `Applied`, `store_flags`,
//! `merge_flags`, `Dirs`, `apply_files`, `rename_dirs`, `Adopted`,
//! `adopt_dirs`, `AdoptReport`, `RenamePair` and their tests — moved to
//! `mailvault_core::vault_flags` (plan Task 2.4 Step 3).

use mailvault_core::vault_flags::{Applied, Dirs, FlagChange};
pub use mailvault_core::vault_flags::{AdoptReport, RenamePair};
use tracing::info;

pub(crate) fn dirs_for(
    app_handle: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
    account_email: Option<&str>,
    backup_root: Option<&str>,
) -> Result<Dirs, String> {
    let root = crate::vault::root(app_handle)?;
    Ok(mailvault_core::vault_flags::dirs_for(&root, account_id, mailbox, account_email, backup_root))
}

/// `apply_everywhere` plus the app's custody connection: the closure holds
/// `WRITER` for exactly as long as core's own `apply_everywhere` does, so the
/// file rename and the custody patch stay atomic with respect to a second
/// caller (the app's mark read/unread racing the backup's catch-up).
pub(crate) fn apply_everywhere(
    app: &tauri::AppHandle,
    account_id: &str,
    mailbox: &str,
    dirs: &Dirs,
    changes: &[FlagChange],
    sidecars: bool,
) -> Applied {
    mailvault_core::vault_flags::apply_everywhere(dirs, changes, sidecars, |patch| {
        match crate::custody::with_conn(app, |c| mailvault_core::custody::entries::patch_flags_many(c, account_id, mailbox, patch)) {
            Ok(n) => Ok(n),
            Err(e) => {
                tracing::warn!("vault_flags: custody patch failed for {}/{}: {}", account_id, mailbox, e);
                Ok(0)
            }
        }
    })
}

/// The app's half: one or more messages whose read state just changed here.
/// `account_email` names the mirror directory; without it, or without a
/// configured external location, the mirror is simply not touched.
#[tauri::command]
pub async fn vault_apply_flags(
    app_handle: tauri::AppHandle,
    account_id: String,
    mailbox: String,
    account_email: Option<String>,
    changes: Vec<FlagChange>,
) -> Result<Applied, String> {
    tokio::task::spawn_blocking(move || {
        let (root, needs_release) = crate::backup::resolve_backup_path(&app_handle, None);
        let result = dirs_for(&app_handle, &account_id, &mailbox, account_email.as_deref(), root.as_deref())
            .map(|dirs| apply_everywhere(&app_handle, &account_id, &mailbox, &dirs, &changes, true));
        if needs_release {
            if let Some(ref p) = root {
                crate::backup::release_backup_path(p);
            }
        }
        let applied = result?;
        if applied.renamed > 0 {
            crate::nudge_index(&account_id, &mailbox); // filename-only updates
        }
        if applied.total() > 0 {
            info!(
                "vault_flags: {}/{} — {} renamed, {} mirrored, {} index, {} sidecars",
                account_id, mailbox, applied.renamed, applied.mirrored, applied.index_patched, applied.sidecars_patched
            );
        }
        Ok(applied)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// The one-time adoption of Graph folders written under localized names.
/// Every pair is attempted; the command fails only after all of them ran.
#[tauri::command]
pub async fn vault_adopt_mailbox_dirs(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_email: Option<String>,
    pairs: Vec<RenamePair>,
) -> Result<AdoptReport, String> {
    tokio::task::spawn_blocking(move || {
        // Shallowest first, as `vault_rename_mailbox` does: a no-op for the flat
        // storage keys sent today, and the order the nesting mirror needs the
        // day a localized folder with children is adopted.
        //
        // A user who switched UI language more than once has two legacy
        // directories for one folder ("Gesendet" and "Enviados", both -> "Sent"):
        // the first pair in this order wins and the other stays where it is,
        // because only a merge could do better and this command never merges.
        let mut pairs = pairs;
        pairs.sort_by_key(|p| p.from.len());
        let (root, needs_release) = crate::backup::resolve_backup_path(&app_handle, None);
        // Outside the closure: a pair that fails `dirs_for` returns early, and the
        // pairs that already moved still need the sweep.
        let mut any_moved = false;
        let result = (|| -> Result<AdoptReport, String> {
            let mut report = AdoptReport::default();
            for p in &pairs {
                let from = dirs_for(&app_handle, &account_id, &p.from, account_email.as_deref(), root.as_deref())?;
                let to = dirs_for(&app_handle, &account_id, &p.to, account_email.as_deref(), root.as_deref())?;
                let out = mailvault_core::vault_flags::adopt_dirs(&from, &to);
                any_moved |= out.moved > 0;
                let label = format!("{} -> {}", p.from, p.to);
                // The custody store holds what the retired local index and
                // archived-headers cache used to, so its rows follow the app-side
                // directories: a blocked pair or a mirror-only move renames
                // nothing, the rows stay with the directory that stayed.
                //
                // A failure here lands in `failed`, so the command returns Err, the
                // JS flag stays unset and the next launch retries the pair — by
                // then the directories are already moved, so only this rename is
                // redone. `UPDATE ... WHERE mailbox_path = from` matches nothing the
                // second time, which is the idempotence that retry needs.
                if out.app_moved > 0 {
                    match crate::custody::with_conn(&app_handle, |c| mailvault_core::custody::entries::rename_mailbox(c, &account_id, &p.from, &p.to)) {
                        Ok(_) => {}
                        Err(e) => report.failed.push(format!("custody {} -> {} ({})", p.from, p.to, e)),
                    }
                }
                if !out.failed.is_empty() {
                    report.failed.push(format!("{}: {}", label, out.failed.join("; ")));
                } else if out.moved > 0 {
                    report.adopted.push(label);
                } else if out.blocked > 0 {
                    report
                        .skipped_both_exist
                        .push(format!("{} (exists: {})", label, out.blocked_by.join(", ")));
                }
            }
            Ok(report)
        })();
        if any_moved {
            crate::sweep_index_soon(); // the old folders' rows go, the new ones' come
        }
        if needs_release {
            if let Some(ref p) = root {
                crate::backup::release_backup_path(p);
            }
        }
        let report = result?;
        let line = format!(
            "vault_adopt_mailbox_dirs: {} — adopted {:?}, left in place {:?}, failed {}",
            account_id, report.adopted, report.skipped_both_exist, report.failed.len()
        );
        // A left-behind legacy directory is the one outcome nobody will look for
        // until a mailbox reads short, so it logs at warn.
        if report.skipped_both_exist.is_empty() {
            info!("{}", line);
        } else {
            tracing::warn!("{}", line);
        }
        if !report.failed.is_empty() {
            return Err(format!("vault adopt incomplete: {}", report.failed.join("; ")));
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// The local half of a folder rename: the server already moved the subtree,
/// this moves the directories that hold its copies.
#[tauri::command]
pub async fn vault_rename_mailbox(
    app_handle: tauri::AppHandle,
    account_id: String,
    account_email: Option<String>,
    pairs: Vec<RenamePair>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let (root, needs_release) = crate::backup::resolve_backup_path(&app_handle, None);
        // Shallowest first — see `rename_dirs`: the mirror nests, so a
        // parent's move has to happen before its descendants' pairs.
        let mut pairs = pairs;
        pairs.sort_by_key(|p| p.from.len());
        let mut moved = 0;
        // EVERY pair is attempted before the first failure is reported: the
        // server has already renamed the whole subtree, so stopping halfway
        // would strand directories that could still have been moved.
        let mut failed: Vec<String> = Vec::new();
        let result = (|| -> Result<usize, String> {
            for p in &pairs {
                let from = dirs_for(&app_handle, &account_id, &p.from, account_email.as_deref(), root.as_deref())?;
                let to = dirs_for(&app_handle, &account_id, &p.to, account_email.as_deref(), root.as_deref())?;
                let (n, mut bad) = mailvault_core::vault_flags::rename_dirs(&from, &to);
                moved += n;
                failed.append(&mut bad);
                match crate::custody::with_conn(&app_handle, |c| mailvault_core::custody::entries::rename_mailbox(c, &account_id, &p.from, &p.to)) {
                    Ok(rows) => moved += usize::from(rows > 0),
                    Err(e) => failed.push(format!("custody {} -> {} ({})", p.from, p.to, e)),
                }
            }
            if !failed.is_empty() {
                return Err(format!("vault rename incomplete: {}", failed.join("; ")));
            }
            Ok(moved)
        })();
        if moved > 0 {
            crate::sweep_index_soon(); // the old folders' rows go, the new ones' come
        }
        if needs_release {
            if let Some(ref p) = root {
                crate::backup::release_backup_path(p);
            }
        }
        let moved = result?;
        info!(
            "vault_rename_mailbox: {} — {} location(s) moved for {} pair(s)",
            account_id,
            moved,
            pairs.len()
        );
        Ok(moved)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
