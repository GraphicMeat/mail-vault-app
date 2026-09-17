//! mbox export/import (Task 4.5), ported from `src-tauri/src/main.rs`'s
//! `export_mbox_all`/`import_mbox`. The walk, the mbox `From ` envelope
//! format, and the escape/unescape rules are byte-identical to what shipped
//! before this move; see `handlers::mbox` for the router that calls these.
//!
//! `export_mbox` (the single-mailbox export command) is dead code, deleted
//! in this task rather than ported: zero callers, confirmed by grep before
//! deleting it.
//!
//! The archived-flag fix (plan decision 3, the point of this task):
//! `import_mbox` used to write new vault files with `build_maildir_filename(uid,
//! &[] as &[String])`, zero flags, no `archived`. `vault_files::clear_cache`
//! deletes any file without the `archived` flag, so an mbox-imported message
//! was silently eligible for deletion by "Clear cached emails". Fixed here:
//! every imported message is written with `vec!["archived".to_string()]`.
//!
//! Per-file gate (decision 10): `export_mbox_all`'s walk resolves the vault
//! root once up front (a read, not gate-sensitive); `import_mbox`'s
//! per-message loop calls `common::with_vault_write` inside the loop, once
//! per message, and breaks cleanly on a gate refusal instead of propagating
//! it as a hard error, matching `backup_zip::import`'s precedent.

use crate::handlers::common;
use crate::server::DaemonState;
use mailvault_core::vault_files::build_maildir_filename;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Debug, Serialize, Deserialize)]
pub struct MboxExportResult {
    #[serde(rename = "emailCount")]
    pub email_count: u32,
    #[serde(rename = "accountCount")]
    pub account_count: u32,
    #[serde(rename = "filePath")]
    pub file_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MboxImportResult {
    #[serde(rename = "emailCount")]
    pub email_count: u32,
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub mailbox: String,
}

/// Escape "From " at the start of lines in an email body for mbox format.
fn mbox_escape_from(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 256);
    for line in raw.split(|&b| b == b'\n') {
        if line.starts_with(b"From ") {
            out.push(b'>');
        }
        out.extend_from_slice(line);
        out.push(b'\n');
    }
    if raw.last() != Some(&b'\n') && out.last() == Some(&b'\n') {
        out.pop();
    }
    out
}

/// Unescape ">From " at start of lines back to "From " when importing mbox.
fn mbox_unescape_from(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    for line in raw.split(|&b| b == b'\n') {
        if line.starts_with(b">From ") {
            out.extend_from_slice(&line[1..]);
        } else {
            out.extend_from_slice(line);
        }
        out.push(b'\n');
    }
    if raw.last() != Some(&b'\n') && out.last() == Some(&b'\n') {
        out.pop();
    }
    out
}

/// Extract a usable "From " envelope line from raw .eml bytes. Falls back to
/// "unknown" sender and current time if headers can't be parsed.
fn mbox_from_line(raw: &[u8]) -> String {
    let sender = mailparse::parse_mail(raw)
        .ok()
        .and_then(|parsed| {
            parsed.headers.iter().find(|h| h.get_key().eq_ignore_ascii_case("from")).and_then(|h| {
                let val = h.get_value();
                if let Some(start) = val.find('<') {
                    val[start + 1..].split('>').next().map(|s| s.to_string())
                } else {
                    Some(val.trim().to_string())
                }
            })
        })
        .unwrap_or_else(|| "unknown@unknown".to_string());

    let date = mailparse::parse_mail(raw)
        .ok()
        .and_then(|parsed| {
            parsed
                .headers
                .iter()
                .find(|h| h.get_key().eq_ignore_ascii_case("date"))
                .and_then(|h| mailparse::dateparse(&h.get_value()).ok())
        })
        .map(|ts| {
            chrono::DateTime::from_timestamp(ts, 0)
                .unwrap_or_else(chrono::Utc::now)
                .format("%a %b %e %H:%M:%S %Y")
                .to_string()
        })
        .unwrap_or_else(|| chrono::Utc::now().format("%a %b %e %H:%M:%S %Y").to_string());

    format!("From {} {}", sender, date)
}

/// Split raw mbox data into individual email messages. Each message starts
/// with a line matching "From " after a blank line (or at file start).
fn split_mbox(data: &[u8]) -> Vec<&[u8]> {
    let mut messages: Vec<&[u8]> = Vec::new();
    let mut start: Option<usize> = None;

    let mut i = 0;
    let len = data.len();

    while i < len {
        let is_from_line = if i + 5 <= len && &data[i..i + 5] == b"From " {
            i == 0
                || (i >= 1
                    && data[i - 1] == b'\n'
                    && (i >= 2 && data[i - 2] == b'\n' || (i >= 3 && data[i - 2] == b'\r' && data[i - 3] == b'\n')))
        } else {
            false
        };

        if is_from_line {
            if let Some(msg_start) = start {
                let mut end = i;
                while end > msg_start && (data[end - 1] == b'\n' || data[end - 1] == b'\r') {
                    end -= 1;
                }
                if end > msg_start {
                    messages.push(&data[msg_start..end]);
                }
            }

            let line_end = data[i..].iter().position(|&b| b == b'\n').map(|p| i + p + 1).unwrap_or(len);
            start = Some(line_end);
            i = line_end;
        } else {
            i += 1;
        }
    }

    if let Some(msg_start) = start {
        let mut end = len;
        while end > msg_start && (data[end - 1] == b'\n' || data[end - 1] == b'\r') {
            end -= 1;
        }
        if end > msg_start {
            messages.push(&data[msg_start..end]);
        }
    }

    messages
}

pub fn export_mbox_all(
    state: &Arc<DaemonState>,
    dest_path: PathBuf,
    archived_only: bool,
    emit: impl Fn(&str, Value),
) -> Result<MboxExportResult, String> {
    // Decision 10: a single up-front root resolution for the whole read-only
    // walk, matching backup_zip::export's precedent. No with_vault_write here.
    let root = common::vault_root(state)?;
    let maildir_base = root.join("Maildir");

    info!("export_mbox_all called: dest={}, archived_only={}", dest_path.display(), archived_only);

    if !maildir_base.exists() {
        return Err("No email data found".to_string());
    }

    let mut file = std::fs::File::create(&dest_path).map_err(|e| format!("Failed to create mbox file: {}", e))?;

    let mut email_count: u32 = 0;
    let mut account_count: u32 = 0;

    emit("mbox-export-progress", json!({"total": 0, "completed": 0, "active": true}));

    if let Ok(account_dirs) = std::fs::read_dir(&maildir_base) {
        for account_dir in account_dirs.flatten() {
            if !account_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                continue;
            }
            let mut account_has_emails = false;

            if let Ok(mailbox_dirs) = std::fs::read_dir(account_dir.path()) {
                for mailbox_dir in mailbox_dirs.flatten() {
                    if !mailbox_dir.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                        continue;
                    }
                    let cur_dir = mailbox_dir.path().join("cur");
                    if !cur_dir.exists() {
                        continue;
                    }

                    if let Ok(files) = std::fs::read_dir(&cur_dir) {
                        for file_entry in files.flatten() {
                            let fname = file_entry.file_name().to_string_lossy().to_string();
                            if !fname.contains(":2,") {
                                continue;
                            }
                            if archived_only && !fname.split(":2,").nth(1).map(|f| f.contains('A')).unwrap_or(false) {
                                continue;
                            }

                            let raw = match std::fs::read(file_entry.path()) {
                                Ok(c) => c,
                                Err(e) => {
                                    warn!("Failed to read {}: {}", file_entry.path().display(), e);
                                    continue;
                                }
                            };

                            let from_line = mbox_from_line(&raw);
                            writeln!(file, "{}", from_line).map_err(|e| format!("Failed to write mbox: {}", e))?;

                            let escaped = mbox_escape_from(&raw);
                            file.write_all(&escaped).map_err(|e| format!("Failed to write mbox: {}", e))?;

                            writeln!(file).map_err(|e| format!("Failed to write mbox: {}", e))?;

                            email_count += 1;
                            account_has_emails = true;

                            if email_count % 100 == 0 {
                                emit("mbox-export-progress", json!({"total": 0, "completed": email_count, "active": true}));
                            }
                        }
                    }
                }
            }

            if account_has_emails {
                account_count += 1;
            }
        }
    }

    emit("mbox-export-progress", json!({"total": email_count, "completed": email_count, "active": false}));

    info!("MBOX exported: {} emails from {} accounts to {}", email_count, account_count, dest_path.display());

    Ok(MboxExportResult { email_count, account_count, file_path: dest_path.to_string_lossy().to_string() })
}

pub fn import_mbox(
    state: &Arc<DaemonState>,
    source_path: PathBuf,
    account_id: String,
    mailbox: String,
    emit: impl Fn(&str, Value),
) -> Result<MboxImportResult, String> {
    info!("import_mbox called: source={}, account={}, mailbox={}", source_path.display(), account_id, mailbox);

    let data = std::fs::read(&source_path).map_err(|e| format!("Failed to read mbox file: {}", e))?;

    // Decision 10: a single up-front read-only resolution to find the
    // mailbox's current max uid; the actual per-message write is gated
    // below, inside the loop.
    let root = common::vault_root(state)?;
    // account_id joins a filesystem path same as mailbox does, so it needs
    // the same sanitizer: an unsanitized id (this is an internal RPC
    // surface, not assumed-trusted) could otherwise escape the Maildir tree.
    let safe_account_id = common::sanitize_mailbox_name(&account_id);
    let safe_mailbox = common::sanitize_mailbox_name(&mailbox);
    let cur_dir = root.join("Maildir").join(&safe_account_id).join(&safe_mailbox).join("cur");
    std::fs::create_dir_all(&cur_dir).map_err(|e| format!("Failed to create maildir: {}", e))?;

    let mut max_uid: u32 = 0;
    if let Ok(files) = std::fs::read_dir(&cur_dir) {
        for f in files.flatten() {
            let fname = f.file_name().to_string_lossy().to_string();
            if let Some(uid_str) = fname.split(':').next() {
                if let Ok(uid) = uid_str.parse::<u32>() {
                    if uid > max_uid {
                        max_uid = uid;
                    }
                }
            }
        }
    }

    let messages = split_mbox(&data);
    let total = messages.len() as u32;
    emit("mbox-import-progress", json!({"total": total, "completed": 0, "active": true}));

    let mut email_count: u32 = 0;

    for msg_raw in &messages {
        let unescaped = mbox_unescape_from(msg_raw);

        // Decision 10: the gate is re-acquired here, inside the loop, once
        // per message, never once around the whole import. A refusal (e.g.
        // the vault closing mid-import for a move) stops the loop cleanly
        // instead of propagating as a hard error, matching
        // backup_zip::import's "resilient over noisy" precedent.
        let write_result = common::with_vault_write(state, |root| -> Result<(), String> {
            let cur_dir = root.join("Maildir").join(&safe_account_id).join(&safe_mailbox).join("cur");
            std::fs::create_dir_all(&cur_dir).map_err(|e| format!("Failed to create maildir: {}", e))?;

            max_uid += 1;
            // Decision 3, the fix this task exists for: seed "archived" so
            // vault_files::clear_cache does not treat mbox-imported mail as
            // disposable cache (was `&[] as &[String]`, zero flags).
            let filename = build_maildir_filename(max_uid, &["archived".to_string()]);
            let mut dest = cur_dir.join(&filename);
            if dest.exists() {
                max_uid += 1;
                let filename2 = build_maildir_filename(max_uid, &["archived".to_string()]);
                dest = cur_dir.join(&filename2);
            }
            std::fs::write(&dest, &unescaped).map_err(|e| format!("Failed to write .eml: {}", e))
        });

        match write_result {
            Ok(()) => {
                email_count += 1;
                if email_count % 50 == 0 || email_count == total {
                    emit("mbox-import-progress", json!({"total": total, "completed": email_count, "active": true}));
                }
            }
            Err(e) => {
                warn!("import_mbox: vault gate refused a write, stopping the import early: {}", e);
                break;
            }
        }
    }

    emit("mbox-import-progress", json!({"total": total, "completed": email_count, "active": false}));

    info!("MBOX imported: {} emails into {}/{}", email_count, account_id, mailbox);
    if email_count > 0 {
        // Decision 9: a whole mailbox of new files, the in-process
        // equivalent of the app's own sweep_index_soon() full pass.
        crate::search_index::sweep_soon(&state.search_index);
    }

    Ok(MboxImportResult { email_count, account_id, mailbox })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(mail_dir_ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir, mail_dir_ok);
        (vault, s)
    }

    fn seed_file(root: &std::path::Path, account: &str, mailbox: &str, uid: u32, flags: &[&str], body: &[u8]) {
        let flags: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
        let cur = mailvault_core::vault_files::cur_path(root, account, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(build_maildir_filename(uid, &flags)), body).unwrap();
    }

    fn write_mbox(dir: &std::path::Path, name: &str, messages: &[&str]) -> PathBuf {
        let path = dir.join(name);
        let mut content = String::new();
        for msg in messages {
            content.push_str("From sender@test.com Mon Jan  1 00:00:00 2026\n");
            content.push_str(msg);
            content.push('\n');
            content.push('\n');
        }
        std::fs::write(&path, content).unwrap();
        path
    }

    /// `count` trivial one-line messages, for tests that need to cross
    /// `import_mbox`'s every-50th-message progress-emit boundary.
    fn write_mbox_n(dir: &std::path::Path, name: &str, count: u32) -> PathBuf {
        let bodies: Vec<String> = (1..=count).map(|i| format!("Subject: msg{i}\r\n\r\nbody{i}")).collect();
        let refs: Vec<&str> = bodies.iter().map(String::as_str).collect();
        write_mbox(dir, name, &refs)
    }

    // -- split_mbox / escape roundtrip -----------------------------------

    #[test]
    fn split_mbox_separates_two_messages() {
        let data = b"From a@b.com Mon Jan  1 00:00:00 2026\nbody1\n\nFrom c@d.com Mon Jan  1 00:00:00 2026\nbody2\n";
        let messages = split_mbox(data);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0], b"body1");
        assert_eq!(messages[1], b"body2");
    }

    #[test]
    fn escape_and_unescape_from_lines_roundtrip() {
        let raw = b"Subject: x\n\nFrom the team,\nthanks";
        let escaped = mbox_escape_from(raw);
        assert!(escaped.starts_with(b"Subject: x\n\n>From the team,"), "{:?}", String::from_utf8_lossy(&escaped));
        let unescaped = mbox_unescape_from(&escaped);
        assert_eq!(unescaped, raw);
    }

    // -- export_mbox_all ---------------------------------------------------

    #[test]
    fn export_writes_a_well_formed_mbox_with_from_lines() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"], b"Subject: hi\r\n\r\nbody");
        let dest = tempfile::tempdir().unwrap().keep().join("out.mbox");
        let result = export_mbox_all(&s, dest.clone(), false, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1);
        assert_eq!(result.account_count, 1);
        let content = std::fs::read_to_string(&dest).unwrap();
        assert!(content.starts_with("From "), "{content}");
    }

    #[test]
    fn export_archived_only_skips_unarchived_files() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"], b"archived");
        seed_file(v.path(), "acct1", "INBOX", 2, &[], b"not archived");
        let dest = tempfile::tempdir().unwrap().keep().join("out.mbox");
        let result = export_mbox_all(&s, dest, true, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1, "only the archived file should be exported");
    }

    /// Decision 10: the export walk performs zero gate acquisitions. Holding
    /// the write side of `vault_gate` before calling export proves this: a
    /// `std::sync::RwLock` is not reentrant, so a regression that ever called
    /// `with_vault_write` here would block forever on this same thread's
    /// write lock; run on a background thread with a bounded wait so a
    /// regression fails the test instead of hanging the suite.
    #[test]
    fn export_never_touches_the_vault_write_gate() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 1, &["A"], b"body");
        let dest = tempfile::tempdir().unwrap().keep().join("out.mbox");

        let _write_guard = s.vault_gate.write().unwrap();
        let s2 = Arc::clone(&s);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let r = export_mbox_all(&s2, dest, false, |_, _| {});
            let _ = tx.send(r);
        });
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(Ok(result)) => assert_eq!(result.email_count, 1),
            Ok(Err(e)) => panic!("export failed: {e}"),
            Err(_) => panic!("export blocked on the vault write gate: it must never call with_vault_write"),
        }
    }

    // -- import_mbox / the archived-flag fix -------------------------------

    /// Decision 3, part 1: the concrete filename-shape proof. Not the load-
    /// bearing test (that is the `clear_cache` one below), but pins the
    /// mechanism the fix relies on: `build_maildir_filename` puts `A` in the
    /// flags segment when "archived" is passed.
    #[test]
    fn import_writes_the_archived_flag_into_the_filename() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: hi\r\n\r\nbody"]);

        let result = import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1);

        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        let names: Vec<String> = std::fs::read_dir(&cur).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names.len(), 1);
        assert!(names[0].contains(":2,") && names[0].split(":2,").nth(1).unwrap().starts_with('A'), "{:?}", names);
    }

    /// account_id joins a filesystem path the same way mailbox does; a
    /// crafted id must not be able to escape the vault root.
    #[test]
    fn import_mbox_sanitizes_a_path_traversal_account_id() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: hi\r\n\r\nbody"]);

        let result = import_mbox(&s, mbox_path, "../../../../../../tmp/evil".to_string(), "INBOX".to_string(), |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1);
        assert!(!std::path::Path::new("/tmp/evil").exists(), "must not escape the vault root via account_id");

        // The sanitizer keeps '.', so the escaped-looking id becomes one
        // dot-and-underscore-laden component, not a clean name -- check
        // containment (single component, still under the vault root), not
        // the absence of ".." as a substring.
        let maildir = v.path().join("Maildir");
        let entries: Vec<_> = std::fs::read_dir(&maildir).unwrap().map(|e| e.unwrap()).collect();
        assert_eq!(entries.len(), 1, "exactly one sanitized account dir, not a tree of '..' components");
        let account_dir = entries[0].path();
        assert_eq!(account_dir.components().count(), maildir.components().count() + 1, "must be a single path component under Maildir/, not a multi-level escape");
        let canonical_root = v.path().canonicalize().unwrap();
        let canonical_written = account_dir.canonicalize().unwrap();
        assert!(canonical_written.starts_with(&canonical_root), "escaped the vault root: {:?} not under {:?}", canonical_written, canonical_root);
    }

    /// Decision 3, part 2: the actual regression test for the data-loss bug.
    /// Before the fix, an mbox-imported message carried no flags at all, so
    /// `vault_files::clear_cache`'s deletion predicate (anything without
    /// "archived" is disposable cache) deleted it. This imports a message,
    /// then runs the real `clear_cache` over the same vault root and asserts
    /// the imported file survives, the mechanism the bug bypassed, not just
    /// a filename-shape assertion.
    #[test]
    fn imported_message_survives_clear_cache() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: hi\r\n\r\nbody"]);

        import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), |_, _| {}).unwrap();

        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 1, "the message must have been written before clear_cache runs");

        let noop_gate = |work: &mut dyn FnMut() -> Result<(), String>| work();
        let result = mailvault_core::vault_files::clear_cache(v.path(), &noop_gate).unwrap();

        assert_eq!(result.deleted_count, 0, "the imported message must not be deleted");
        assert_eq!(result.skipped_archived, 1, "clear_cache must recognize it as archived and skip it");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 1, "the file must still be on disk after clear_cache");
    }

    #[test]
    fn import_finds_more_than_one_message() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: one\r\n\r\nbody1", "Subject: two\r\n\r\nbody2"]);

        let result = import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), |_, _| {}).unwrap();
        assert_eq!(result.email_count, 2);
        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 2);
    }

    /// Decision 10: the gate is re-acquired per message, inside the loop, not
    /// once for the whole pass. `import_mbox` only emits intermediate
    /// progress every 50th message (plus the final one), so 51 messages are
    /// used here so the test's own `emit` closure has a deterministic hook
    /// to flip `vault_closed` right after message 50's write completes but
    /// before message 51's (no thread timing needed: `import_mbox` is
    /// synchronous, so this fires deterministically between the two).
    /// Proves a mid-loop refusal stops cleanly with a correct partial count
    /// rather than panicking or discarding what already landed.
    #[test]
    fn import_stops_cleanly_with_a_correct_partial_count_when_the_gate_fails_mid_loop() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox_n(dir.path(), "in.mbox", 51);

        let s2 = Arc::clone(&s);
        let result = import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), move |name, payload| {
            if name == "mbox-import-progress" && payload["completed"].as_u64() == Some(50) && payload["active"].as_bool() == Some(true) {
                s2.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        })
        .unwrap();

        assert_eq!(result.email_count, 50, "must stop after message 50 once the gate starts refusing");
        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 50, "the 50 messages that landed before the refusal must still be on disk");
    }
}
