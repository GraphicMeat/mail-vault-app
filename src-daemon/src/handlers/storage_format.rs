//! Settings > Storage > Message format (Plan B, Task 8): the vault's storage
//! format, its conversion job (`format_migration_job`), the old files a
//! conversion set aside, and the blob sweep. Flat names, like the rest of
//! `DAEMON_OWNED`. The vault marker is the source of truth for the format, so
//! it travels with the vault and the app keeps no settings key for it.
//!
//! Every route runs on a blocking thread. The reads take the vault gate's
//! check (`vault_root`); everything that writes a journal, a marker or a file
//! goes through `with_vault_write`, so a vault move waits it out.

use crate::format_migration_job::{self as job, OldFiles};
use crate::handlers::common::{blocking, done, vault_root, with_vault_write};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::message_store;
use serde_json::Value;
use std::sync::Arc;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// `to`: `"jmap"` or `"maildir"`, nothing else.
fn to_arg(id: &Value, params: &Value) -> Result<message_store::Format, RpcResponse> {
    match params.get("to").and_then(Value::as_str) {
        Some("jmap") => Ok(message_store::Format::Jmap),
        Some("maildir") => Ok(message_store::Format::Maildir),
        _ => Err(RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "to must be \"jmap\" or \"maildir\"")),
    }
}

/// `oldFiles`: `"retire"` or `"delete"`. Required: deleting is never a default.
fn old_files_arg(id: &Value, params: &Value) -> Result<OldFiles, RpcResponse> {
    match params.get("oldFiles").and_then(Value::as_str) {
        Some("retire") => Ok(OldFiles::Retire),
        Some("delete") => Ok(OldFiles::Delete),
        _ => Err(RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "oldFiles must be \"retire\" or \"delete\"")),
    }
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    let st = Arc::clone(state);
    let result = match method {
        "storage_format_get" => blocking(move || vault_root(&st).map(|root| job::get(&st, &root))).await,
        "storage_format_convert" => {
            let to = req!(to_arg(&id, params));
            let old_files = req!(old_files_arg(&id, params));
            blocking(move || with_vault_write(&st, |root| job::start(&st, root, to, old_files))).await
        }
        "storage_format_pause" => blocking(move || with_vault_write(&st, |root| job::pause(&st, root))).await,
        "storage_format_resume" => blocking(move || with_vault_write(&st, |root| job::resume(&st, root))).await,
        "storage_format_cancel" => blocking(move || with_vault_write(&st, |root| job::cancel(&st, root))).await,
        "storage_format_retired" => blocking(move || vault_root(&st).map(|root| job::retired(&root))).await,
        "storage_format_purge_retired" => blocking(move || with_vault_write(&st, |root| job::purge_retired(&st, root))).await,
        "storage_reclaim_space" => blocking(move || with_vault_write(&st, |root| job::reclaim(&st, root))).await,
        _ => return None,
    };
    Some(done(id, result.and_then(|r| r)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use mailvault_core::vault_layout::read_marker_value;
    use serde_json::json;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), mail_dir_ok);
        s.seed_accounts_for_test(&[]);
        // These tests steer a job; they do not convert. The job holds before
        // it plans, at 0 of 0, until it is paused or cancelled.
        crate::format_migration_job::faults(&s).hold = true;
        (vault, app_dir, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    fn ok(resp: RpcResponse) -> Value {
        match resp.result {
            Some(v) => v,
            None => panic!("expected a result, got {:?}", resp.error.map(|e| e.message)),
        }
    }

    fn err(resp: RpcResponse) -> String {
        resp.error.expect("expected an error").message
    }

    /// Polls `storage_format_get` until its migration reads `want`.
    async fn migration_until(s: &Arc<DaemonState>, want: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let got = ok(call(s, "storage_format_get", json!({})).await);
            if got["migration"]["state"] == want {
                return got["migration"].clone();
            }
            assert!(Instant::now() < deadline, "the migration never read {want}: {got}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn marker(root: &Path, key: &str) -> Option<String> {
        read_marker_value(root, key)
    }

    fn journal(app_dir: &Path, job_id: &str) -> Value {
        let raw = std::fs::read(app_dir.join("format_migrations").join(format!("{job_id}.json"))).expect("journal");
        serde_json::from_slice(&raw).unwrap()
    }

    async fn start(s: &Arc<DaemonState>, to: &str) -> String {
        let r = ok(call(s, "storage_format_convert", json!({"to": to, "oldFiles": "retire"})).await);
        r["jobId"].as_str().expect("a job id").to_string()
    }

    /// Ends the stub job so its thread does not outlive the test.
    async fn cancel_and_wait(s: &Arc<DaemonState>) {
        ok(call(s, "storage_format_cancel", json!({})).await);
        migration_until(s, "cancelled").await;
    }

    #[tokio::test]
    async fn storage_format_get_on_a_fresh_vault_is_maildir_with_no_migration() {
        let (_v, _a, s) = st(true);
        // Through the server, so the router line in server.rs is pinned.
        let resp = handle_request_for_test(&s, "storage_format_get", json!({})).await;
        assert_eq!(ok(resp), json!({"format": "maildir", "migration": null, "blobs": false, "leftover": false}));
    }

    #[tokio::test]
    async fn storage_format_another_domains_method_is_not_routed_here() {
        let (_v, _a, s) = st(true);
        assert!(route(&s, "mbox_upload_status", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn storage_format_convert_answers_a_job_id_and_a_second_convert_is_busy() {
        let (v, a, s) = st(true);
        let id = start(&s, "jmap").await;
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");

        // The marker is the source of truth: the target format and the job.
        assert_eq!(marker(v.path(), "storageFormat").as_deref(), Some("jmap"));
        assert_eq!(marker(v.path(), "storageMigration").as_deref(), Some(id.as_str()));
        assert_eq!(message_store::vault_format(v.path()), message_store::Format::Jmap);

        let got = ok(call(&s, "storage_format_get", json!({})).await);
        assert_eq!(got["format"], json!("jmap"));
        assert_eq!(
            got["migration"],
            json!({"jobId": id, "to": "jmap", "oldFiles": "retire", "state": "running", "active": true,
                   "done": 0, "total": 0, "failed": 0, "error": null})
        );

        // The journal, as Task 9 will keep it.
        let j = journal(a.path(), &id);
        for key in ["version", "jobId", "vault", "to", "oldFiles", "stamp", "mailboxes", "done", "total", "failed", "state", "updatedAt"] {
            assert!(j.get(key).is_some(), "journal key {key}: {j}");
        }
        assert_eq!((j["version"].clone(), j["to"].clone(), j["oldFiles"].clone()), (json!(1), json!("jmap"), json!("retire")));
        assert_eq!(j["vault"], json!(v.path().to_string_lossy()));

        for (method, params) in [
            ("storage_format_convert", json!({"to": "maildir", "oldFiles": "retire"})),
            ("storage_format_convert", json!({"to": "jmap", "oldFiles": "delete"})),
            ("storage_format_purge_retired", json!({})),
            ("storage_reclaim_space", json!({})),
        ] {
            assert_eq!(err(call(&s, method, params).await), format!("E_FORMAT_BUSY: {id}"), "{method}");
        }
        cancel_and_wait(&s).await;
    }

    #[tokio::test]
    async fn storage_format_convert_to_the_vaults_own_format_is_refused_when_nothing_is_pending() {
        let (v, a, s) = st(true);
        let msg = err(call(&s, "storage_format_convert", json!({"to": "maildir", "oldFiles": "retire"})).await);
        assert!(msg.starts_with("E_FORMAT_SAME:"), "{msg}");
        assert!(!a.path().join("format_migrations").exists(), "no journal");
        assert_eq!(marker(v.path(), "storageMigration"), None, "no marker row");
    }

    #[tokio::test]
    async fn storage_format_convert_wants_a_target_and_an_old_files_choice() {
        let (v, a, s) = st(true);
        for params in [
            json!({"oldFiles": "retire"}),
            json!({"to": "eml", "oldFiles": "retire"}),
            json!({"to": "jmap"}),
            json!({"to": "jmap", "oldFiles": "keep"}),
        ] {
            assert_eq!(call(&s, "storage_format_convert", params.clone()).await.error.expect("refused").code, ipc::INVALID_PARAMS, "{params}");
        }
        assert!(!a.path().join("format_migrations").exists(), "nothing started");
        assert_eq!(message_store::vault_format(v.path()), message_store::Format::Maildir);
    }

    #[tokio::test]
    async fn storage_format_pause_holds_and_resume_wakes_the_same_job() {
        let (_v, a, s) = st(true);
        let id = start(&s, "jmap").await;
        assert_eq!(ok(call(&s, "storage_format_pause", json!({})).await), json!({"jobId": id, "paused": true}));
        let held = migration_until(&s, "paused").await;
        assert_eq!((held["jobId"].clone(), held["active"].clone()), (json!(id), json!(true)), "held, not ended");
        assert_eq!(journal(a.path(), &id)["state"], json!("paused"), "checkpointed when it held");

        assert_eq!(ok(call(&s, "storage_format_resume", json!({})).await), json!({"jobId": id, "resumed": true}));
        let running = migration_until(&s, "running").await;
        assert_eq!(running["jobId"], json!(id), "the same job");
        assert_eq!(journal(a.path(), &id)["state"], json!("running"));
        cancel_and_wait(&s).await;
    }

    #[tokio::test]
    async fn storage_format_cancel_keeps_the_target_format_and_offers_resume_and_convert_back() {
        let (v, a, s) = st(true);
        let id = start(&s, "jmap").await;
        assert_eq!(ok(call(&s, "storage_format_cancel", json!({})).await), json!({"jobId": id, "cancelled": true}));
        let stopped = migration_until(&s, "cancelled").await;
        assert_eq!((stopped["jobId"].clone(), stopped["active"].clone()), (json!(id), json!(false)));

        // Nothing rolled back: the vault stays in the target format, and the
        // job is no longer in progress (a move is allowed again).
        let got = ok(call(&s, "storage_format_get", json!({})).await);
        assert_eq!(got["format"], json!("jmap"));
        assert_eq!(marker(v.path(), "storageFormat").as_deref(), Some("jmap"));
        assert_eq!(marker(v.path(), "storageMigration").as_deref(), Some(""));
        assert_eq!(journal(a.path(), &id)["state"], json!("cancelled"));

        // A cancelled job is not one to pause; cancelling it again is fine.
        assert_eq!(ok(call(&s, "storage_format_pause", json!({})).await), json!({"jobId": id, "paused": false}));
        assert_eq!(ok(call(&s, "storage_format_cancel", json!({})).await), json!({"jobId": id, "cancelled": true}));

        // Resume: the same job again.
        assert_eq!(ok(call(&s, "storage_format_resume", json!({})).await), json!({"jobId": id, "resumed": true}));
        assert_eq!(migration_until(&s, "running").await["jobId"], json!(id));
        assert_eq!(marker(v.path(), "storageMigration").as_deref(), Some(id.as_str()));
        cancel_and_wait(&s).await;

        // Convert back: a new job the other way, which replaces the stopped one.
        let back = start(&s, "maildir").await;
        assert_ne!(back, id);
        assert_eq!(message_store::vault_format(v.path()), message_store::Format::Maildir);
        assert_eq!(marker(v.path(), "storageMigration").as_deref(), Some(back.as_str()));
        assert!(!a.path().join("format_migrations").join(format!("{id}.json")).exists(), "the stopped journal is replaced");
        let got = ok(call(&s, "storage_format_get", json!({})).await);
        assert_eq!((got["migration"]["jobId"].clone(), got["migration"]["to"].clone()), (json!(back), json!("maildir")));
        cancel_and_wait(&s).await;
    }

    /// A daemon restart leaves a journal with no worker: it reads as paused,
    /// resumes, and a journal of another vault is never shown.
    #[tokio::test]
    async fn storage_format_a_journal_left_by_a_restart_reads_as_paused_and_resumes() {
        let (v, a, s) = st(true);
        let dir = a.path().join("format_migrations");
        std::fs::create_dir_all(&dir).unwrap();
        let entry = |id: &str, vault: &str| {
            json!({"version": 1, "jobId": id, "vault": vault, "to": "jmap", "oldFiles": "delete", "stamp": "20261009-141200",
                   "mailboxes": [{"account": "acct", "dir": "INBOX", "state": "pending"}],
                   "done": 4, "total": 9, "failed": [{"account": "acct", "dir": "INBOX", "uid": 7, "reason": "E_BLOB_VERIFY"}],
                   "state": "running", "updatedAt": 1})
        };
        let id = "3f1e0c1a-0000-4000-8000-000000000001";
        let other = "3f1e0c1a-0000-4000-8000-000000000002";
        std::fs::write(dir.join(format!("{id}.json")), entry(id, &v.path().to_string_lossy()).to_string()).unwrap();
        std::fs::write(dir.join(format!("{other}.json")), entry(other, "/some/other/vault").to_string()).unwrap();
        message_store::set_vault_format(v.path(), message_store::Format::Jmap).unwrap();
        mailvault_core::vault_layout::write_marker_value(v.path(), "storageMigration", id).unwrap();

        let got = ok(call(&s, "storage_format_get", json!({})).await);
        assert_eq!(
            got["migration"],
            json!({"jobId": id, "to": "jmap", "oldFiles": "delete", "state": "paused", "active": false,
                   "done": 4, "total": 9, "failed": 1, "error": null})
        );

        assert_eq!(ok(call(&s, "storage_format_resume", json!({})).await), json!({"jobId": id, "resumed": true}));
        let running = migration_until(&s, "running").await;
        assert_eq!((running["active"].clone(), running["done"].clone(), running["failed"].clone()), (json!(true), json!(4), json!(1)), "the journal carried on");
        cancel_and_wait(&s).await;
        assert_eq!(journal(a.path(), other)["state"], json!("running"), "another vault's journal is left alone");
    }

    #[tokio::test]
    async fn storage_format_steering_with_no_job_is_not_found() {
        let (_v, _a, s) = st(true);
        for method in ["storage_format_pause", "storage_format_resume", "storage_format_cancel"] {
            let msg = err(call(&s, method, json!({})).await);
            assert!(msg.starts_with("E_FORMAT_NOT_FOUND:"), "{method}: {msg}");
        }
    }

    #[tokio::test]
    async fn storage_format_retired_files_are_counted_and_purged() {
        let (v, _a, s) = st(true);
        assert_eq!(ok(call(&s, "storage_format_retired", json!({})).await), json!({"bytes": 0, "count": 0}));
        let one = v.path().join("retired/format-20261009-141200/acct/INBOX/cur");
        let two = v.path().join("retired/format-20261010-090000/acct/Work/jmap");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&two).unwrap();
        std::fs::write(one.join("1.eml"), vec![b'a'; 100]).unwrap();
        std::fs::write(two.join("2.json"), vec![b'b'; 50]).unwrap();
        // Not a conversion's: left alone.
        let keep = v.path().join("retired/other");
        std::fs::create_dir_all(&keep).unwrap();
        std::fs::write(keep.join("note.txt"), b"mine").unwrap();

        assert_eq!(ok(call(&s, "storage_format_retired", json!({})).await), json!({"bytes": 150, "count": 2}));
        assert_eq!(ok(call(&s, "storage_format_purge_retired", json!({})).await), json!({"bytes": 150, "count": 2}));
        assert_eq!(ok(call(&s, "storage_format_retired", json!({})).await), json!({"bytes": 0, "count": 0}));
        assert!(!v.path().join("retired/format-20261009-141200").exists());
        assert!(keep.join("note.txt").exists(), "only format-* directories go");
    }

    #[tokio::test]
    async fn storage_format_reclaim_space_sweeps_old_unreferenced_blobs() {
        use mailvault_core::jmap_store::blobs;
        let (v, _a, s) = st(true);
        // A sweep refuses a vault that has blobs and no Maildir/ (b849746e7).
        std::fs::create_dir_all(v.path().join("Maildir")).unwrap();
        let old = blobs::put(v.path(), b"an old blob nobody names").unwrap();
        let young = blobs::put(v.path(), b"a young blob nobody names").unwrap();
        let file = std::fs::File::options().write(true).open(blobs::blob_path(v.path(), &old)).unwrap();
        file.set_modified(std::time::SystemTime::now() - Duration::from_secs(2 * 24 * 3600)).unwrap();
        drop(file);

        assert_eq!(ok(call(&s, "storage_reclaim_space", json!({})).await), json!({"removed": 1, "bytes": 24}));
        assert!(!blobs::blob_path(v.path(), &old).exists());
        assert!(blobs::blob_path(v.path(), &young).exists(), "inside the 24h grace");
    }

    /// R32: Settings offers Reclaim in Maildir format while a blob store is
    /// there (a convert back leaves blobs inside their grace), and Convert
    /// remaining while the leftover hint is set: `storage_format_get` says
    /// both, from one stat and one marker row. A Reclaim in Maildir format
    /// that leaves no blob takes the emptied store away; in JMAP format the
    /// store stays.
    #[tokio::test]
    async fn storage_format_get_tells_of_blobs_and_files_left_and_a_maildir_reclaim_takes_the_empty_store() {
        use mailvault_core::jmap_store::blobs;
        let (v, _a, s) = st(true);
        let root = v.path();
        std::fs::create_dir_all(root.join("Maildir")).unwrap();
        let aged = |id: &str| {
            let file = std::fs::File::options().write(true).open(blobs::blob_path(root, id)).unwrap();
            file.set_modified(std::time::SystemTime::now() - Duration::from_secs(2 * 24 * 3600)).unwrap();
        };
        let id = blobs::put(root, b"a blob a convert back left").unwrap();
        message_store::set_leftover(root, true).unwrap();
        let got = ok(call(&s, "storage_format_get", json!({})).await);
        assert_eq!((got["format"].clone(), got["blobs"].clone(), got["leftover"].clone()), (json!("maildir"), json!(true), json!(true)), "{got}");

        ok(call(&s, "storage_reclaim_space", json!({})).await);
        assert!(blobs::blob_path(root, &id).exists(), "inside its grace");
        assert_eq!(ok(call(&s, "storage_format_get", json!({})).await)["blobs"], json!(true), "the store stays while it holds a blob");

        aged(&id);
        assert_eq!(ok(call(&s, "storage_reclaim_space", json!({})).await)["removed"], json!(1));
        assert!(!root.join(blobs::BLOB_DIR).exists(), "in Maildir format the emptied store goes");
        assert_eq!(ok(call(&s, "storage_format_get", json!({})).await)["blobs"], json!(false));

        message_store::set_vault_format(root, message_store::Format::Jmap).unwrap();
        let id = blobs::put(root, b"a JMAP vault's blob").unwrap();
        aged(&id);
        assert_eq!(ok(call(&s, "storage_reclaim_space", json!({})).await)["removed"], json!(1));
        assert!(root.join(blobs::BLOB_DIR).exists(), "in JMAP format writers put blobs: the store stays");
    }

    /// Makes the marker refuse one row, as a busy or full marker database does.
    fn refuse_marker_row(root: &Path, key: &str, value_is: &str) {
        mailvault_core::vault_layout::write_marker_value(root, "storageMigration", "").unwrap();
        let conn = rusqlite::Connection::open(root.join(mailvault_core::vault_layout::MARKER_FILE)).unwrap();
        conn.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS refuse; CREATE TRIGGER refuse BEFORE INSERT ON marker \
             WHEN NEW.key = '{key}' AND NEW.value = '{value_is}' BEGIN SELECT RAISE(ABORT, 'refused'); END;"
        ))
        .unwrap();
    }

    fn allow_marker_rows(root: &Path) {
        let conn = rusqlite::Connection::open(root.join(mailvault_core::vault_layout::MARKER_FILE)).unwrap();
        conn.execute_batch("DROP TRIGGER IF EXISTS refuse;").unwrap();
    }

    fn journals(app_dir: &Path) -> usize {
        std::fs::read_dir(app_dir.join("format_migrations")).map_or(0, |d| d.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".json")).count())
    }

    /// A marker write that fails in the middle of a start must not leave the
    /// vault in the target format with no job: a retry would answer
    /// E_FORMAT_SAME and the conversion could never be started.
    #[tokio::test]
    async fn storage_format_a_start_whose_job_row_write_fails_leaves_the_vault_unflipped_and_retryable() {
        let (v, a, s) = st(true);
        // Any job id: the row write that names a job is the refused one.
        mailvault_core::vault_layout::write_marker_value(v.path(), "storageMigration", "").unwrap();
        let conn = rusqlite::Connection::open(v.path().join(mailvault_core::vault_layout::MARKER_FILE)).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER refuse BEFORE INSERT ON marker WHEN NEW.key = 'storageMigration' AND NEW.value <> '' \
             BEGIN SELECT RAISE(ABORT, 'refused'); END;",
        )
        .unwrap();

        let msg = err(call(&s, "storage_format_convert", json!({"to": "jmap", "oldFiles": "retire"})).await);
        assert_eq!(message_store::vault_format(v.path()), message_store::Format::Maildir, "not flipped: {msg}");
        assert!(msg.starts_with("E_FORMAT_IO:"), "{msg}");
        assert_eq!(journals(a.path()), 0, "no journal for a job that never started");

        allow_marker_rows(v.path());
        let retry = ok(call(&s, "storage_format_convert", json!({"to": "jmap", "oldFiles": "retire"})).await);
        assert!(retry["jobId"].is_string(), "{retry}");
        cancel_and_wait(&s).await;
    }

    /// The format row is the second write: when it fails, the job row written
    /// before it is taken back, so no move is blocked by a job that is not there.
    #[tokio::test]
    async fn storage_format_a_start_whose_format_row_write_fails_takes_the_job_row_back() {
        let (v, a, s) = st(true);
        refuse_marker_row(v.path(), "storageFormat", "jmap");

        let msg = err(call(&s, "storage_format_convert", json!({"to": "jmap", "oldFiles": "retire"})).await);
        assert!(msg.starts_with("E_FORMAT_IO:"), "{msg}");
        assert_eq!(message_store::vault_format(v.path()), message_store::Format::Maildir);
        assert_eq!(marker(v.path(), "storageMigration").as_deref(), Some(""), "the job row is cleared");
        assert_eq!(journals(a.path()), 0);

        allow_marker_rows(v.path());
        start(&s, "jmap").await;
        cancel_and_wait(&s).await;
    }

    /// The refusals and failures the app shows carry a stable code, never the
    /// daemon's English detail: the app maps the code to a catalog sentence.
    #[tokio::test]
    async fn storage_format_a_failed_reclaim_answers_its_code() {
        use mailvault_core::jmap_store::blobs;
        let (v, _a, s) = st(true);
        // Blobs and no Maildir/: the sweep refuses to run on a partial listing.
        blobs::put(v.path(), b"a blob").unwrap();
        let msg = err(call(&s, "storage_reclaim_space", json!({})).await);
        assert!(msg.starts_with("E_FORMAT_RECLAIM_FAILED:"), "{msg}");
        assert!(!msg.contains(&*v.path().to_string_lossy()), "no path in what the app gets: {msg}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn storage_format_a_failed_purge_answers_its_code() {
        use std::os::unix::fs::PermissionsExt;
        let (v, _a, s) = st(true);
        let dir = v.path().join("retired/format-20261009-141200");
        std::fs::create_dir_all(dir.join("acct")).unwrap();
        std::fs::write(dir.join("acct/1.eml"), b"x").unwrap();
        // A directory that cannot be emptied.
        std::fs::set_permissions(dir.join("acct"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let msg = err(call(&s, "storage_format_purge_retired", json!({})).await);
        std::fs::set_permissions(dir.join("acct"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(msg.starts_with("E_FORMAT_PURGE_FAILED:"), "{msg}");
        assert!(!msg.contains(&*v.path().to_string_lossy()), "no path in what the app gets: {msg}");
    }

    #[tokio::test]
    async fn storage_format_every_route_refuses_while_the_vault_is_unavailable() {
        let (_v, _a, s) = st(false);
        for (method, params) in [
            ("storage_format_get", json!({})),
            ("storage_format_convert", json!({"to": "jmap", "oldFiles": "retire"})),
            ("storage_format_pause", json!({})),
            ("storage_format_resume", json!({})),
            ("storage_format_cancel", json!({})),
            ("storage_format_retired", json!({})),
            ("storage_format_purge_retired", json!({})),
            ("storage_reclaim_space", json!({})),
        ] {
            let msg = err(call(&s, method, params).await);
            assert!(msg.starts_with("E_VAULT_UNAVAILABLE:"), "{method}: {msg}");
        }
    }
}
