//! One-time move of the app data directory's JSON files into `app.db`.
//!
//! Runs on the first `db::handle` for a directory. Each file is imported and
//! then retired to `<name>.pre-db-<stamp>` (never deleted), so a second start
//! finds nothing to do and no build reads the old copy again.
//!
//! **The app and the daemon both open this store, and both can reach here at
//! the same launch.** Every row goes in under one `BEGIN IMMEDIATE`, and the
//! `legacy_import` marker is set in that same transaction: the second process
//! blocks on the write lock, then sees the marker and does nothing. Without
//! that, two importers would each add the same day's `transfer_stats` bytes —
//! those rows accumulate rather than replace. The file renames happen after
//! the commit, so a crash mid-import rolls back to "not imported" and the
//! next start retries from the files, which are still there.
//!
//! Idempotent by construction: absence is the done state, and a file that will
//! not parse is retired anyway — the JSON readers all treated an unparseable
//! store as empty, so keeping it around would only make every start retry a
//! file that can never import.
//!
//! A failure here is logged, never fatal. The stores it feeds are caches,
//! counters and retry journals; losing one is worse than a failed launch only
//! if it takes the launch with it.

use super::{classify, db, locations, ops, stats};
use crate::fsx::{retire, retire_stamp};
use rusqlite::Connection;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// The slots whose `<slot>-meta.json` + `<slot>-bookmark` pair moves into
/// `external_locations`. `vault-meta.json` is the vault slot's metadata file —
/// the daemon knew it under that name.
const SLOTS: [&str; 2] = ["external-backup", "vault"];

/// The `meta` key that says the one-time import already ran here.
const DONE: &str = "legacy_import";

pub fn run(conn: &Connection, app_dir: &Path) {
    if db::meta_get(conn, DONE).is_some() {
        return;
    }
    // IMMEDIATE, not the default deferred: the write lock has to be held from
    // the first read, or two processes both pass the marker check and both
    // import.
    if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE;") {
        warn!("[app_db] Could not start the legacy import: {e}");
        return;
    }
    if db::meta_get(conn, DONE).is_some() {
        let _ = conn.execute_batch("COMMIT;");
        return;
    }

    let stamp = retire_stamp();
    let mut retire_after_commit = Vec::new();
    let mut moved = 0usize;
    moved += import_locations(conn, app_dir, &mut retire_after_commit);
    moved += import_stats(conn, app_dir, &mut retire_after_commit);
    moved += import_classifications(conn, app_dir, &mut retire_after_commit);
    moved += import_models(conn, app_dir, &mut retire_after_commit);
    moved += import_queue(conn, app_dir, &mut retire_after_commit);
    moved += import_op_journal(conn, app_dir, &mut retire_after_commit);
    moved += import_pending_operation(conn, app_dir, &mut retire_after_commit);
    moved += import_purge_queue(conn, app_dir, &mut retire_after_commit);

    if let Err(e) = db::meta_set(conn, DONE, "1") {
        warn!("[app_db] Could not mark the legacy import done: {e}");
    }
    if let Err(e) = conn.execute_batch("COMMIT;") {
        // Nothing was written and nothing is retired: the files are still the
        // record, and the next start tries again.
        warn!("[app_db] Legacy import rolled back: {e}");
        let _ = conn.execute_batch("ROLLBACK;");
        return;
    }
    for path in retire_after_commit {
        if let Err(e) = retire(&path, stamp) {
            warn!("[app_db] Imported {} but could not retire it: {e}", path.display());
        }
    }
    if moved > 0 {
        info!("[app_db] Imported {moved} legacy JSON file(s) into app.db");
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Mark `path` imported: it is renamed out of the way once the transaction
/// commits, never before — a rollback must leave the files as the record.
fn done(path: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    retire_after_commit.push(path.to_path_buf());
    1
}

// ── external locations ──────────────────────────────────────────────────────

fn import_locations(conn: &Connection, app_dir: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    let mut moved = 0;
    for slot in SLOTS {
        let meta_path = app_dir.join(format!("{slot}-meta.json"));
        let bookmark_path = app_dir.join(format!("{slot}-bookmark"));
        // Bookmark first: `save_meta` must not clear a bookmark this import
        // has not written yet.
        if bookmark_path.is_file() {
            match std::fs::read(&bookmark_path) {
                Ok(bytes) => {
                    if let Err(e) = locations::save_bookmark(conn, slot, &bytes) {
                        warn!("[app_db] {slot} bookmark: {e}");
                    } else {
                        moved += done(&bookmark_path, retire_after_commit);
                    }
                }
                Err(e) => warn!("[app_db] read {}: {e}", bookmark_path.display()),
            }
        }
        if meta_path.is_file() {
            let meta = read_json(&meta_path).unwrap_or(Value::Null);
            let display_path = meta.get("displayPath").and_then(Value::as_str).unwrap_or("");
            let platform = meta
                .get("platform")
                .and_then(Value::as_str)
                .unwrap_or(std::env::consts::OS);
            let saved_at = meta.get("savedAt").and_then(Value::as_u64).unwrap_or(0);
            let legacy = meta.get("legacy").and_then(Value::as_bool).unwrap_or(false);
            if let Err(e) = locations::save_meta(conn, slot, display_path, platform, saved_at, legacy) {
                warn!("[app_db] {slot} meta: {e}");
            } else {
                moved += done(&meta_path, retire_after_commit);
            }
        }
    }
    moved
}

// ── transfer stats ──────────────────────────────────────────────────────────

fn import_stats(conn: &Connection, app_dir: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    let dir = app_dir.join("transfer_stats");
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    let mut moved = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((account_id, source)) = name
            .strip_suffix(".app.json")
            .map(|id| (id, "app"))
            .or_else(|| name.strip_suffix(".daemon.json").map(|id| (id, "daemon")))
        else {
            continue;
        };
        let path = entry.path();
        let days = read_json(&path)
            .and_then(|v| v.get("days").cloned())
            .and_then(|d| d.as_object().cloned())
            .unwrap_or_default();
        let mut ok = true;
        for (day, bucket) in &days {
            let down = bucket.get("down").and_then(Value::as_u64).unwrap_or(0);
            let up = bucket.get("up").and_then(Value::as_u64).unwrap_or(0);
            if let Err(e) = stats::add(conn, account_id, day, source, down, up) {
                warn!("[app_db] stats {account_id} {day}: {e}");
                ok = false;
            }
        }
        if ok {
            moved += done(&path, retire_after_commit);
        }
    }
    moved
}

// ── classifications, models, queue ──────────────────────────────────────────

fn import_classifications(conn: &Connection, app_dir: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    per_account_files(app_dir.join("classifications"), |account_id, path| {
        let map = read_json(path).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        let rows: Vec<(String, String)> = map.into_iter().map(|(k, v)| (k, v.to_string())).collect();
        classify::replace_account(conn, account_id, &rows)
    }, retire_after_commit)
}

fn import_models(conn: &Connection, app_dir: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    per_account_files(app_dir.join("classification_models"), |account_id, path| {
        let Some(model) = read_json(path) else { return Ok(()) };
        classify::save_model(conn, account_id, &model.to_string())
    }, retire_after_commit)
}

/// `<dir>/<account_id>.json`, one row set per file.
fn per_account_files(
    dir: PathBuf,
    mut import: impl FnMut(&str, &Path) -> Result<(), String>,
    retire_after_commit: &mut Vec<PathBuf>,
) -> usize {
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    let mut moved = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(account_id) = name.strip_suffix(".json") else { continue };
        let path = entry.path();
        match import(account_id, &path) {
            Ok(()) => moved += done(&path, retire_after_commit),
            Err(e) => warn!("[app_db] import {}: {e}", path.display()),
        }
    }
    moved
}

fn import_queue(conn: &Connection, app_dir: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    let path = app_dir.join("classification_queue").join("queue.json");
    if !path.is_file() {
        return 0;
    }
    // `{"items":[...]}` — `PersistedQueue`'s serde shape.
    let items: Vec<(String, String)> = read_json(&path)
        .and_then(|v| v.get("items").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|item| (queue_key(&item), item.to_string()))
        .collect();
    match classify::queue_replace(conn, &items) {
        Ok(()) => done(&path, retire_after_commit),
        Err(e) => {
            warn!("[app_db] classification queue: {e}");
            0
        }
    }
}

/// The dedupe key the queue's own `HashSet` used: `QueueItem::message_id`.
pub fn queue_key(item: &Value) -> String {
    item.get("message_id").and_then(Value::as_str).unwrap_or("").to_string()
}

// ── journals ────────────────────────────────────────────────────────────────

fn import_op_journal(conn: &Connection, app_dir: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    let mut moved = 0;
    // The pre-2026-09-05 delete-only shape, which `op_journal` used to fold
    // into `pending_ops.json` on first read. Imported first so a directory
    // holding both ends up with the newer file's rows last.
    let legacy = app_dir.join("pending_server_delete.json");
    if legacy.is_file() {
        let map = read_json(&legacy).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        for (key, uids) in map {
            let (account_id, mailbox) = key.split_once('|').unwrap_or((key.as_str(), ""));
            let uids_json = uids.to_string();
            if let Err(e) = ops::queue(conn, "delete", account_id, mailbox, &uids_json, "{}", 0) {
                warn!("[app_db] legacy delete journal: {e}");
            }
        }
        moved += done(&legacy, retire_after_commit);
    }

    let path = app_dir.join("pending_ops.json");
    if path.is_file() {
        let journal = read_json(&path).unwrap_or(Value::Null);
        let entries = journal.get("ops").and_then(Value::as_array).cloned().unwrap_or_default();
        for entry in entries {
            let get = |k: &str| entry.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let uids = entry.get("uids").cloned().unwrap_or_else(|| Value::Array(vec![]));
            let arg = entry.get("arg").cloned().unwrap_or_else(|| Value::Object(Default::default()));
            let at = entry.get("at").and_then(Value::as_u64).unwrap_or(0);
            if let Err(e) = ops::queue(
                conn,
                &get("op"),
                &get("accountId"),
                &get("mailbox"),
                &uids.to_string(),
                &arg.to_string(),
                at,
            ) {
                warn!("[app_db] op journal: {e}");
            }
        }
        moved += done(&path, retire_after_commit);
    }
    moved
}

fn import_pending_operation(conn: &Connection, app_dir: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    let path = app_dir.join("pending_operations.json");
    if !path.is_file() {
        return 0;
    }
    let Some(value) = read_json(&path) else {
        // Unparseable: the old reader errored rather than swallowing it, but
        // there is nothing to carry forward and re-reading it every start
        // would keep the same error alive forever.
        return done(&path, retire_after_commit);
    };
    match db::meta_set(conn, ops::PENDING_OPERATION_KEY, &value.to_string()) {
        Ok(()) => done(&path, retire_after_commit),
        Err(e) => {
            warn!("[app_db] pending operation: {e}");
            0
        }
    }
}

fn import_purge_queue(conn: &Connection, app_dir: &Path, retire_after_commit: &mut Vec<PathBuf>) -> usize {
    let path = app_dir.join("pending_backup_purge.json");
    if !path.is_file() {
        return 0;
    }
    let map = read_json(&path).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let mut queue: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (scope, uids) in map {
        let list = uids
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_u64).map(|u| u as u32).collect())
            .unwrap_or_default();
        queue.insert(scope, list);
    }
    // Merge, never replace: a purge queued between this process opening the
    // store and the import would otherwise be dropped.
    let mut existing = ops::purge_read(conn);
    for (scope, uids) in queue {
        existing.entry(scope).or_default().extend(uids);
    }
    for uids in existing.values_mut() {
        uids.sort_unstable();
        uids.dedup();
    }
    match ops::purge_write(conn, &existing) {
        Ok(()) => done(&path, retire_after_commit),
        Err(e) => {
            warn!("[app_db] purge queue: {e}");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-appimport-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn retired(dir: &Path, name: &str) -> bool {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(&format!("{name}.pre-db-")))
    }

    #[test]
    fn the_vault_meta_file_becomes_the_vault_slot() {
        let dir = scratch("vault-meta");
        write(&dir, "vault-meta.json", &json!({"displayPath":"/Volumes/Mail","platform":"macos","savedAt":42}).to_string());
        write(&dir, "vault-bookmark", "bookmark-bytes");
        let conn = db::open(&dir).unwrap();
        run(&conn, &dir);
        assert_eq!(locations::display_path(&conn, "vault").as_deref(), Some("/Volumes/Mail"));
        assert_eq!(locations::bookmark(&conn, "vault").as_deref(), Some(&b"bookmark-bytes"[..]));
        assert!(retired(&dir, "vault-meta.json"));
        assert!(retired(&dir, "vault-bookmark"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transfer_stats_keep_their_source_apart() {
        let dir = scratch("stats");
        write(&dir, "transfer_stats/acc1.app.json", &json!({"days":{"2026-09-20":{"down":10,"up":1}}}).to_string());
        write(&dir, "transfer_stats/acc1.daemon.json", &json!({"days":{"2026-09-20":{"down":5,"up":2}}}).to_string());
        let conn = db::open(&dir).unwrap();
        run(&conn, &dir);
        assert_eq!(stats::day_total(&conn, "acc1", "2026-09-20"), (15, 3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_legacy_delete_journal_and_the_new_one_both_land() {
        let dir = scratch("journal");
        write(&dir, "pending_server_delete.json", &json!({"acct|INBOX":[4,9]}).to_string());
        write(
            &dir,
            "pending_ops.json",
            &json!({"next_id":3,"ops":[{"id":2,"op":"flag","accountId":"acct","mailbox":"Sent","uids":[7],"arg":{"action":"add"},"at":99}]}).to_string(),
        );
        let conn = db::open(&dir).unwrap();
        run(&conn, &dir);
        let rows = ops::read(&conn);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1, "delete");
        assert_eq!(rows[0].4, "[4,9]");
        assert_eq!(rows[1].1, "flag");
        assert!(retired(&dir, "pending_ops.json"));
        assert!(retired(&dir, "pending_server_delete.json"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_purge_queue_survives() {
        let dir = scratch("purge");
        write(&dir, "pending_backup_purge.json", &json!({"acct|INBOX":[4,9]}).to_string());
        let conn = db::open(&dir).unwrap();
        run(&conn, &dir);
        assert_eq!(ops::purge_read(&conn).get("acct|INBOX"), Some(&vec![4u32, 9]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn classifications_models_and_queue_move_together() {
        let dir = scratch("classify");
        write(&dir, "classifications/acc1.json", &json!({"k1":{"category":"work"}}).to_string());
        write(&dir, "classification_models/acc1.json", &json!({"total":3}).to_string());
        write(
            &dir,
            "classification_queue/queue.json",
            &json!({"items":[{"account_id":"acc1","message_id":"<m1@example.com>","tier":"New","email":{}}]}).to_string(),
        );
        let conn = db::open(&dir).unwrap();
        run(&conn, &dir);
        assert_eq!(classify::load(&conn, "acc1").unwrap().len(), 1);
        assert!(classify::load_model(&conn, "acc1").is_some());
        assert_eq!(classify::queue_load(&conn).len(), 1);
        assert_eq!(classify::queue_load(&conn)[0].0, "<m1@example.com>");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_run_imports_nothing_twice() {
        let dir = scratch("idempotent");
        write(&dir, "pending_backup_purge.json", &json!({"a":[1]}).to_string());
        write(&dir, "transfer_stats/acc1.app.json", &json!({"days":{"2026-09-20":{"down":10,"up":0}}}).to_string());
        let conn = db::open(&dir).unwrap();
        run(&conn, &dir);
        run(&conn, &dir);
        assert_eq!(stats::day_total(&conn, "acc1", "2026-09-20"), (10, 0), "a re-import would double the bytes");
        assert_eq!(ops::purge_read(&conn).get("a"), Some(&vec![1u32]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_process_reaching_the_import_does_not_double_the_counters() {
        // The app and the daemon both open this store at launch. The marker
        // is set in the same transaction as the rows, and `transfer_stats`
        // rows accumulate, so a second importer would add the same bytes again.
        let dir = scratch("two-processes");
        write(&dir, "transfer_stats/acc1.app.json", &json!({"days":{"2026-09-20":{"down":10,"up":0}}}).to_string());
        let first = db::open(&dir).unwrap();
        run(&first, &dir);
        // A second connection, as a second process would have.
        let second = db::open(&dir).unwrap();
        run(&second, &dir);
        assert_eq!(stats::day_total(&second, "acc1", "2026-09-20"), (10, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unretirable_file_does_not_stop_the_import_committing() {
        // A read-only app dir: the rows land, the rename cannot.
        let dir = scratch("unretirable");
        write(&dir, "pending_backup_purge.json", &json!({"a":[1]}).to_string());
        let conn = db::open(&dir).unwrap();
        let mut perms = std::fs::metadata(&dir).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o500);
            std::fs::set_permissions(&dir, perms.clone()).unwrap();
        }
        run(&conn, &dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o700);
            std::fs::set_permissions(&dir, perms).unwrap();
        }
        assert_eq!(ops::purge_read(&conn).get("a"), Some(&vec![1u32]), "the rows committed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_directory_imports_nothing() {
        let dir = scratch("empty");
        let conn = db::open(&dir).unwrap();
        run(&conn, &dir);
        assert!(ops::read(&conn).is_empty());
        assert!(locations::all(&conn).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unparseable_file_is_retired_not_retried_forever() {
        let dir = scratch("garbage");
        write(&dir, "pending_operations.json", "not json at all");
        let conn = db::open(&dir).unwrap();
        run(&conn, &dir);
        assert!(retired(&dir, "pending_operations.json"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
