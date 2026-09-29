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
//!
//! A Google Takeout import with labels (`use_labels`) files each message in
//! its home folder among the account's cached folders; each folder keeps its
//! own uid range, dedupe and server view (`Dest`).
//!
//! Mode 3 ("Import as a separate folder") imports into a new vault-only
//! folder (`mailvault_core::local_folder`: a directory no server lists, known
//! by its marker), which `list_local_folders` and `delete_local_folder` read
//! and remove.

use crate::handlers::common::{self, blocking};
use crate::handlers::deleted::{capture, Source};
use crate::server::DaemonState;
use mailvault_core::import_rehome;
use mailvault_core::local_folder;
use mailvault_core::maildir::{has_info, info_flags, is_info_sep, IMPORT_UID_BASE};
use mailvault_core::search_index::text::vault_dir_name;
use mailvault_core::takeout;
use mailvault_core::vault_files::build_maildir_filename;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
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
    /// Messages the folder already held, in the vault or on the server
    /// (`import_rehome`'s same-message rule),
    /// not written again.
    #[serde(rename = "skippedCount")]
    pub skipped_count: u32,
    /// Per destination folder, in the order the import first routed to it.
    pub folders: Vec<FolderCount>,
    /// True when the messages were routed by the account's folder list
    /// (`use_labels` and a cached listing). False without `use_labels`, and
    /// with it when the list is unknown: then everything went to `mailbox`.
    #[serde(rename = "foldersKnown")]
    pub folders_known: bool,
    /// Mode "folder": the vault-only folder this import made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<LocalFolderRef>,
}

/// A vault-only folder: its display name and its vault dir.
#[derive(Debug, Serialize, Deserialize)]
pub struct LocalFolderRef {
    pub name: String,
    pub dir: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderCount {
    /// The folder's mailbox key (server path; storage key on Graph).
    pub mailbox: String,
    pub imported: u32,
    pub skipped: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MboxProbe {
    pub bytes: u64,
    #[serde(rename = "hasLabels")]
    pub has_labels: bool,
    #[serde(rename = "foldersKnown")]
    pub folders_known: bool,
    #[serde(rename = "sampledMessages")]
    pub sampled_messages: u32,
}

/// A delete asked of a directory with no import marker (a server folder's,
/// an unmarked one, a symlink); the app shows `errors.E_NOT_LOCAL_FOLDER`.
const E_NOT_LOCAL_FOLDER: &str = "E_NOT_LOCAL_FOLDER";
/// A local folder whose delete left mail in it (one message whose bin copy
/// could not be made or matched); it stays listed and can be deleted again.
const E_LOCAL_FOLDER_NOT_EMPTY: &str = "E_LOCAL_FOLDER_NOT_EMPTY";

const PROBE_MESSAGES: u32 = 200;
const PROBE_BYTES: u64 = 8 << 20;

/// What the import options dialog needs before it asks: the file's size,
/// whether its first messages carry Takeout labels, and whether the account's
/// folder list is known. Reads at most `PROBE_MESSAGES` messages within the
/// first `PROBE_BYTES`, never the whole file.
pub fn probe_mbox(state: &Arc<DaemonState>, source_path: &Path, account_id: &str) -> Result<MboxProbe, String> {
    let file = std::fs::File::open(source_path).map_err(|e| format!("Failed to read mbox file: {}", e))?;
    let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let (has_labels, sampled_messages) = sample_labels(file, PROBE_MESSAGES, PROBE_BYTES)?;
    let folders_known = account_folders(state, account_id).is_ok_and(|f| !f.is_empty());
    Ok(MboxProbe { bytes, has_labels, folders_known, sampled_messages })
}

/// `(any sampled message labelled, messages sampled)` over at most
/// `max_messages` messages in the first `max_bytes` bytes. The byte limit sits
/// under the buffer; a message it cuts still counts, its header was read.
fn sample_labels(r: impl Read, max_messages: u32, max_bytes: u64) -> Result<(bool, u32), String> {
    let (mut labelled, mut sampled) = (false, 0);
    for_each_mbox_message(std::io::BufReader::new(r.take(max_bytes)), |msg, _| {
        sampled += 1;
        labelled |= !takeout::labels_of(msg).is_empty();
        sampled < max_messages
    })
    .map_err(|e| format!("Failed to read mbox file: {}", e))?;
    Ok((labelled, sampled))
}

/// The account's folders from its cached listing, read the way
/// `load_mailbox_cache` reads it. Empty, meaning unknown, when there is none.
/// A list that cannot be read is an error, never "none": an import would
/// file everything in the fallback.
fn account_folders(state: &Arc<DaemonState>, account_id: &str) -> Result<Vec<takeout::FolderRef>, String> {
    let listing = crate::handlers::cache::load_mailbox_listing(state, account_id)?;
    Ok(listing.map(|l| takeout::folder_refs_from_listing(&l)).unwrap_or_default())
}

/// The uid a vault file name starts with: `<uid>:2,...` (`;2,` on Windows)
/// or a bare `<uid>.eml`.
fn name_uid(name: &str) -> Option<u32> {
    name.split(|c| is_info_sep(c) || c == '.').next()?.parse().ok()
}

/// Whether any file in `cur_dir` is named for `uid`, whatever its flags.
fn uid_on_disk(cur_dir: &Path, uid: u32) -> bool {
    std::fs::read_dir(cur_dir).into_iter().flatten().flatten().any(|e| name_uid(&e.file_name().to_string_lossy()) == Some(uid))
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
pub(crate) fn mbox_unescape_from(raw: &[u8]) -> Vec<u8> {
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
                .and_then(|h| mailvault_core::maildir::header_date_secs(&h.get_value()))
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

/// Stream an mbox one message at a time, so peak memory is one message and
/// never the file (a 55 GB Google Takeout mbox used to be read whole and
/// run the machine out of memory). A message starts at a "From " line at
/// file start or right after a blank line (`\n` or `\r\n`); its trailing
/// CR/LF is trimmed. `f` gets each message and the bytes read so far, and
/// returns `false` to stop early.
fn for_each_mbox_message(mut r: impl BufRead, mut f: impl FnMut(&[u8], u64) -> bool) -> std::io::Result<()> {
    let mut line = Vec::new();
    let mut msg = Vec::new();
    let mut in_msg = false;
    let mut prev_blank = true;
    let mut read: u64 = 0;
    let mut flush = |msg: &mut Vec<u8>, read: u64| -> bool {
        while matches!(msg.last(), Some(b'\n' | b'\r')) {
            msg.pop();
        }
        let go_on = msg.is_empty() || f(msg, read);
        msg.clear();
        go_on
    };
    loop {
        line.clear();
        let n = r.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        read += n as u64;
        if prev_blank && line.starts_with(b"From ") {
            if in_msg && !flush(&mut msg, read) {
                return Ok(());
            }
            in_msg = true;
            prev_blank = false;
            continue;
        }
        prev_blank = line == b"\n" || line == b"\r\n";
        if in_msg {
            msg.extend_from_slice(&line);
        }
    }
    if in_msg {
        flush(&mut msg, read);
    }
    Ok(())
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
                            if !has_info(&fname) {
                                continue;
                            }
                            if archived_only && !info_flags(&fname).map(|f| f.contains('A')).unwrap_or(false) {
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

/// Import an mbox into the account's vault, every message into `mailbox`. With
/// `use_labels` (a Google Takeout file) each message instead goes to its home
/// folder among the account's existing ones (`takeout::home_folder`, never a
/// new folder), `mailbox` taking the rest, and carries its Starred and read
/// state as flags.
pub fn import_mbox(
    state: &Arc<DaemonState>,
    source_path: PathBuf,
    account_id: String,
    mailbox: String,
    use_labels: bool,
    emit: impl Fn(&str, Value),
) -> Result<MboxImportResult, String> {
    info!("import_mbox called: source={}, account={}, mailbox={}, labels={}", source_path.display(), account_id, mailbox, use_labels);

    let file = std::fs::File::open(&source_path).map_err(|e| format!("Failed to read mbox file: {}", e))?;
    let bytes_total = file.metadata().map(|m| m.len()).unwrap_or(0);
    import_from(state, std::io::BufReader::with_capacity(1 << 20, file), bytes_total, account_id, mailbox, use_labels, emit)
}

/// One folder an import writes into, set up on the first message routed to it.
struct Dest {
    /// The mailbox key custody and the result name it by (server path; the
    /// storage key on Graph).
    mailbox: String,
    /// Its vault dir, `vault_dir_name(mailbox)`: the one sync writes.
    dir: String,
    max_uid: u32,
    server: import_rehome::ServerView,
    /// Message-ID -> copies in the folder, read on the first message with an id.
    known: Option<HashMap<String, Vec<PathBuf>>>,
    /// The vault registry holds this folder, so it can say whether a uid is
    /// taken without a directory scan. Cleared when it stops answering.
    listed: bool,
    imported: u32,
    skipped: u32,
}

impl Dest {
    /// Imports take their own range, past any uid a server hands out, and
    /// continue after the last import already in the folder. The server's
    /// listing is read here, before any write, so custody is never taken
    /// under the mailbox lock.
    fn open(state: &Arc<DaemonState>, account_dir: &Path, account_id: &str, mailbox: String, dir: String) -> Self {
        let mut max_uid: u32 = IMPORT_UID_BASE - 1;
        for f in std::fs::read_dir(account_dir.join(&dir).join("cur")).into_iter().flatten().flatten() {
            if let Some(uid) = name_uid(&f.file_name().to_string_lossy()) {
                max_uid = max_uid.max(uid);
            }
        }
        let server = crate::custody::with_conn(state, |c| mailvault_core::custody::cache::all_headers(c, account_id, &mailbox))
            .map(|rows| import_rehome::ServerView::from_headers(&rows))
            .unwrap_or_default();
        Dest { mailbox, dir, max_uid, server, known: None, listed: false, imported: 0, skipped: 0 }
    }
}

/// Takeout labels as vault flags: archived like every import, flagged for
/// `Starred`, seen unless `Unread` (R5: it beats `Opened`; neither is read).
pub(crate) fn label_flags(labels: &[String]) -> Vec<String> {
    let attrs = takeout::attrs_of(labels);
    let mut flags = vec!["archived".to_string()];
    if attrs.flagged {
        flags.push("flagged".to_string());
    }
    if !attrs.unread {
        flags.push("seen".to_string());
    }
    flags
}

fn import_from(
    state: &Arc<DaemonState>,
    reader: impl BufRead,
    bytes_total: u64,
    account_id: String,
    mailbox: String,
    use_labels: bool,
    emit: impl Fn(&str, Value),
) -> Result<MboxImportResult, String> {
    // Decision 10: a single up-front read-only check of the vault; the actual
    // per-message write is gated below, inside the loop.
    let root = common::vault_root(state)?;
    // account_id joins a filesystem path same as mailbox does, so it gets
    // the same sanitizer (belt and braces: `vault_files::account_dir` already
    // keeps any id inside the Maildir tree).
    let safe_account_id = common::sanitize_mailbox_name(&account_id);
    let account_dir = mailvault_core::vault_files::account_dir(&root.join("Maildir"), &safe_account_id);

    // Folder dirs come from core's `vault_dir_name`, the function sync writes
    // with, which also keeps a `.` or `..` name inside the account dir. With
    // no folder list every message goes to `mailbox`.
    let folders = if use_labels { account_folders(state, &account_id)? } else { Vec::new() };
    let fallback_dir = vault_dir_name(&mailbox);
    // One destination per vault dir, never per name: two names that share a
    // dir must share its uid allocator.
    let mut dests: Vec<Dest> = Vec::new();
    let mut by_dir: HashMap<String, usize> = HashMap::new();

    // The message count is unknown until the stream ends: `total` stays 0
    // while active (as export does) and progress runs on bytes.
    emit("mbox-import-progress", json!({"total": 0, "completed": 0, "active": true, "bytesDone": 0, "bytesTotal": bytes_total}));

    let mut email_count: u32 = 0;
    let mut skipped_count: u32 = 0;
    let mut write_error: Option<String> = None;

    let streamed = for_each_mbox_message(reader, |msg_raw, bytes_done| {
        let unescaped = mbox_unescape_from(msg_raw);
        let labels = if use_labels { takeout::labels_of(&unescaped) } else { Vec::new() };
        let (name, dir) = match takeout::home_folder(&labels, &folders, false) {
            takeout::Home::Folder(f) => (f.path, f.dir),
            // Without `create_missing` there is no `Create`: mode 2 never makes a folder (D3).
            takeout::Home::Create(_) | takeout::Home::Fallback => (mailbox.clone(), fallback_dir.clone()),
        };
        let i = *by_dir.entry(dir.clone()).or_insert_with(|| {
            dests.push(Dest::open(state, &account_dir, &account_id, name, dir));
            dests.len() - 1
        });
        let d = &mut dests[i];

        // A message the folder already holds is not written twice: not the
        // same file imported again, not a duplicate inside the file, not mail
        // the server lists there. Each folder answers for itself.
        let head = import_rehome::head_of(&unescaped);
        if let Some(id) = &head.id {
            let copies = d.known.get_or_insert_with(|| folder_message_ids(&account_dir.join(&d.dir).join("cur")));
            let body = import_rehome::body_of(&unescaped);
            // A copy in the folder decides by its content; with none, the
            // server's header decides by Subject and Date.
            let same = match copies.get(id) {
                Some(paths) => paths.iter().any(|p| import_rehome::same_as_copy(&head, &body, p)),
                None => d.server.lists_same(&head),
            };
            if same {
                d.skipped += 1;
                skipped_count += 1;
                if (email_count + skipped_count) % 50 == 0 {
                    emit("mbox-import-progress", json!({"total": 0, "completed": email_count, "active": true, "bytesDone": bytes_done, "bytesTotal": bytes_total, "skippedCount": skipped_count}));
                }
                return true;
            }
        }

        // Decision 3: "archived" always, so vault_files::clear_cache does not
        // treat mbox-imported mail as disposable cache; the label flags only
        // when labels were asked for, so the old call shape writes what it did.
        let flags = if use_labels { label_flags(&labels) } else { vec!["archived".to_string()] };

        if !d.listed {
            // One listing, outside the mailbox lock (a registry listing takes
            // it), so the registry answers for this folder's uids below.
            d.listed = state.vault_registry.files(&root, &safe_account_id, &d.dir).is_some();
        }

        // Decision 10: the gate is re-acquired here, inside the loop, once
        // per message, never once around the whole import. A refusal (e.g.
        // the vault closing mid-import for a move) stops the loop cleanly
        // instead of propagating as a hard error, matching
        // backup_zip::import's "resilient over noisy" precedent.
        //
        // Under the vault registry's lock for the folder (keyed by the
        // sanitized names, the directory itself), and each file lands as a
        // row right after its write.
        let write_result = common::with_mailbox_write(state, &safe_account_id, &d.dir, |root| -> Result<PathBuf, String> {
            let cur_dir = mailvault_core::vault_files::account_dir(&root.join("Maildir"), &safe_account_id).join(&d.dir).join("cur");
            std::fs::create_dir_all(&cur_dir).map_err(|e| format!("Failed to create maildir: {}", e))?;

            // The next uid no file holds, under any flags: another writer (the
            // rehome pass, a second import) may have taken some since `open`
            // seeded the allocator. The registry answers while it holds the
            // folder (`known` takes no mailbox lock); otherwise the disk does.
            let mut uid = d.max_uid;
            loop {
                uid = uid.checked_add(1).ok_or("The import uid range is full")?;
                let taken = match state.vault_registry.known(&safe_account_id, &d.dir, uid) {
                    Some(row) => row.is_some(),
                    None => {
                        d.listed = false;
                        uid_on_disk(&cur_dir, uid)
                    }
                };
                if !taken {
                    break;
                }
            }
            // Spent even if the write below fails: a uid is never reused.
            d.max_uid = uid;
            let dest = cur_dir.join(build_maildir_filename(uid, &flags));
            // Atomic: readers that take no lock (the backup's mirror copy)
            // list this folder mid-import and copy once what they find, so the
            // uid name appears only with the whole message behind it. A failed
            // write leaves nothing under it: at most a dot-prefixed temp no
            // uid scanner reads, so the registry has nothing to correct.
            if let Err(e) = mailvault_core::fsx::write_atomic(&dest, &unescaped) {
                return Err(format!("Failed to write .eml: {}", e));
            }
            state.vault_registry.upsert(&safe_account_id, &d.dir, uid, &dest);
            Ok(dest)
        });

        match write_result {
            Ok(dest) => {
                d.imported += 1;
                email_count += 1;
                if let (Some(id), Some(known)) = (head.id, d.known.as_mut()) {
                    known.entry(id).or_default().push(dest);
                }
                if (email_count + skipped_count) % 50 == 0 {
                    emit("mbox-import-progress", json!({"total": 0, "completed": email_count, "active": true, "bytesDone": bytes_done, "bytesTotal": bytes_total, "skippedCount": skipped_count}));
                }
                true
            }
            Err(e) => {
                warn!("import_mbox: a write failed (vault gate or disk), stopping the import early: {}", e);
                write_error = Some(e);
                false
            }
        }
    });
    // What already landed stays landed: an error here would tell the user
    // nothing changed. Only a run that got through no message is a failure.
    if let Err(e) = streamed {
        if email_count + skipped_count == 0 {
            return Err(format!("Failed to read mbox file: {}", e));
        }
        warn!("import_mbox: read failed after {} messages, keeping them: {}", email_count, e);
    }
    if let (0, 0, Some(e)) = (email_count, skipped_count, write_error) {
        return Err(e);
    }

    emit("mbox-import-progress", json!({"total": email_count, "completed": email_count, "active": false, "bytesDone": bytes_total, "bytesTotal": bytes_total, "skippedCount": skipped_count}));

    info!("MBOX imported: {} emails into {} folder(s) of {}, {} already there skipped", email_count, dests.len(), account_id, skipped_count);
    if email_count > 0 {
        // Decision 9: a whole mailbox of new files, the in-process
        // equivalent of the app's own sweep_index_soon() full pass.
        crate::search_index::sweep_soon(&state.search_index);
    }

    let per_folder = dests.into_iter().map(|d| FolderCount { mailbox: d.mailbox, imported: d.imported, skipped: d.skipped }).collect();
    Ok(MboxImportResult { email_count, account_id, mailbox, skipped_count, folders: per_folder, folders_known: !folders.is_empty(), folder: None })
}

/// Import an mbox as a folder of its own, kept only in the vault (mode 3): a
/// new `MBOX import <today>` folder with its marker, every message into it,
/// labels not read. Its uids come from the import range (no server shares
/// the folder) and its dedupe covers this folder alone, so importing a file
/// again makes and fills another folder.
pub fn import_mbox_as_folder(state: &Arc<DaemonState>, source_path: PathBuf, account_id: String, emit: impl Fn(&str, Value)) -> Result<MboxImportResult, String> {
    info!("import_mbox as a folder: source={}, account={}", source_path.display(), account_id);
    // Opened before the folder is made: a missing file leaves none behind.
    let file = std::fs::File::open(&source_path).map_err(|e| format!("Failed to read mbox file: {}", e))?;
    let bytes_total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let source = source_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let (marker, dir) = create_local_folder(state, &account_id, &today, &source)?;
    let reader = std::io::BufReader::with_capacity(1 << 20, file);
    match import_from(state, reader, bytes_total, account_id.clone(), marker.name.clone(), false, emit) {
        Ok(mut result) => {
            result.folder = Some(LocalFolderRef { name: marker.name, dir });
            Ok(result)
        }
        Err(e) => {
            // Nothing landed (the import's own rule for an error), so the new
            // folder is empty and goes with the error.
            let safe_account_id = common::sanitize_mailbox_name(&account_id);
            let removed = common::with_mailbox_write(state, &safe_account_id, &dir, |root| {
                local_folder::remove_if_no_mail(&local_account_dir(root, &safe_account_id).join(&dir))
            });
            if !matches!(removed, Ok(true)) {
                warn!("import_mbox: the empty folder {dir} of a failed import stays: {removed:?}");
            }
            Err(e)
        }
    }
}

/// The account dir an import writes, keyed by the sanitized id as `import_from` does.
fn local_account_dir(root: &Path, safe_account_id: &str) -> PathBuf {
    mailvault_core::vault_files::account_dir(&root.join("Maildir"), safe_account_id)
}

/// Makes the next free `MBOX import <date>` folder of the account, under the
/// vault gate: one directory and one small file.
fn create_local_folder(state: &Arc<DaemonState>, account_id: &str, date: &str, source: &str) -> Result<(local_folder::Marker, String), String> {
    let safe_account_id = common::sanitize_mailbox_name(account_id);
    common::with_vault_write(state, |root| {
        let created = mailvault_core::vault_layout::now_millis();
        local_folder::create_import_folder(&local_account_dir(root, &safe_account_id), date, source, created)
            .map_err(|e| format!("Failed to create the import folder: {e}"))
    })
}

/// The account's vault-only folders, oldest first: `[{name, dir, kind,
/// created, source}]`. One directory listing plus one small read per folder
/// that has a marker, and no lock: nothing a foreground read waits on.
pub fn list_local_folders(state: &Arc<DaemonState>, account_id: &str) -> Result<Value, String> {
    let root = common::vault_root(state)?;
    let account_dir = local_account_dir(&root, &common::sanitize_mailbox_name(account_id));
    let folders = local_folder::list(&account_dir).map_err(|e| format!("Failed to list local folders: {e}"))?;
    Ok(Value::Array(
        folders.into_iter().map(|(dir, m)| json!({"name": m.name, "dir": dir, "kind": m.kind, "created": m.created, "source": m.source})).collect(),
    ))
}

/// Delete a vault-only folder: every message into the deleted-mail bin the
/// way a local-only message's delete puts it there (`maildir_delete` with
/// `bin`: capture, then `vault_files::delete`, which updates the registry and
/// through it the search index), then the folder with its marker. Only a
/// folder whose marker says an import made it: never a server folder's
/// directory, an unmarked one, or a symlink. `name` is the display name or
/// the dir (`vault_dir_name` maps both to the dir). A folder already gone is
/// a success.
pub async fn delete_local_folder(state: &Arc<DaemonState>, account_id: &str, name: &str) -> Result<Value, String> {
    let safe_account_id = common::sanitize_mailbox_name(account_id);
    let dir = vault_dir_name(name);
    let (st, acct, d) = (Arc::clone(state), safe_account_id.clone(), dir.clone());
    let found = blocking(move || -> Result<Option<(String, Vec<u32>)>, String> {
        let root = common::vault_root(&st)?;
        let account_dir = local_account_dir(&root, &acct);
        match std::fs::symlink_metadata(account_dir.join(&d)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Failed to read the folder {d}: {e}")),
            Ok(meta) if !meta.is_dir() => return Err(format!("{E_NOT_LOCAL_FOLDER}: {d} is not a folder")),
            Ok(_) => {}
        }
        let marker = match local_folder::read_marker(&account_dir, &d) {
            Ok(Some(m)) if m.kind == local_folder::KIND_IMPORT => m,
            Ok(_) => return Err(format!("{E_NOT_LOCAL_FOLDER}: {d} carries no import marker")),
            Err(e) => return Err(format!("{E_NOT_LOCAL_FOLDER}: {d}: {e}")),
        };
        // One registry listing, outside the mailbox lock (it takes it).
        let files = st.vault_registry.files(&root, &acct, &d).ok_or_else(|| format!("Failed to list the folder {d}"))?;
        Ok(Some((marker.name, files.into_iter().map(|f| f.0).collect())))
    })
    .await
    .and_then(|r| r)?;
    let Some((folder_name, uids)) = found else {
        return Ok(json!({"dir": dir, "deleted": 0}));
    };

    // One message per unit: its capture, then its removal under the
    // mailbox lock, so a foreground read never waits on more than one.
    let mut deleted = 0u32;
    let mut removed = false;
    let result = async {
        for uid in uids {
            let kept = match capture(state, &safe_account_id, &folder_name, uid, Source::Local).await {
                Ok(Some((_, true))) => true,
                // The bin already held a copy under this key: a delete cut off
                // after its capture, or a deleted folder of the same name whose
                // uid came back. Only these very bytes count as kept.
                Ok(Some((bin_id, false))) => kept_as_is(state, &safe_account_id, &folder_name, uid, bin_id).await,
                // `Source::Local` reads nothing into this too: leave the message,
                // the folder then stays and the delete says so.
                Ok(None) => false,
                Err(e) => return Err(format!("E_BIN_CAPTURE: {e}")),
            };
            if !kept {
                continue;
            }
            let (st, acct, n) = (Arc::clone(state), safe_account_id.clone(), folder_name.clone());
            blocking(move || common::with_mailbox_write(&st, &acct, &n, |root| mailvault_core::vault_files::delete(&st.vault_registry, root, &acct, &n, uid)))
                .await
                .and_then(|r| r)?;
            deleted += 1;
        }

        // The folder goes last, under its lock, and only with no mail left in it.
        let (st, acct, d) = (Arc::clone(state), safe_account_id.clone(), dir.clone());
        removed = blocking(move || {
            common::with_mailbox_write(&st, &acct, &d, |root| {
                let folder = local_account_dir(root, &acct).join(&d);
                if folder.symlink_metadata().is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
                    return Ok(true);
                }
                let removed = local_folder::remove_if_no_mail(&folder);
                st.vault_registry.invalidate(&acct, &d);
                removed
            })
        })
        .await
        .and_then(|r| r)?;
        if !removed {
            return Err(format!("{E_LOCAL_FOLDER_NOT_EMPTY}: {deleted} moved to the deleted bin, some mail is left in {dir}"));
        }
        Ok(())
    }
    .await;
    // The per-file nudges cannot drop these search rows: a scoped pass keeps
    // the row of a gone file its folder has no server listing for, and does
    // nothing for a folder that is gone. A full pass prunes a gone folder's
    // rows. Asked for whenever this delete changed the vault, a partial one
    // included.
    if deleted > 0 || removed {
        crate::search_index::sweep_soon(&state.search_index);
    }
    result?;
    info!("local folder {dir} of {safe_account_id} deleted, {deleted} message(s) into the deleted bin");
    Ok(json!({"dir": dir, "deleted": deleted}))
}

/// Whether the bin copy `bin_id` holds exactly the vault's bytes for `uid`.
async fn kept_as_is(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, bin_id: String) -> bool {
    let (st, acct, mb) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
    blocking(move || -> Result<bool, String> {
        let root = common::vault_root(&st)?;
        let raw = mailvault_core::vault_files::read_message(&st.vault_registry, &root, &acct, &mb, uid, false)?;
        Ok(raw.is_some() && raw == Some(mailvault_core::app_db::deleted::read_eml(&st.app_dir, &bin_id)?))
    })
    .await
    .and_then(|r| r)
    .unwrap_or(false)
}

/// Message-ID -> every vault file in `cur_dir` carrying it, one bounded
/// header read per file.
fn folder_message_ids(cur_dir: &Path) -> HashMap<String, Vec<PathBuf>> {
    let mut ids: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for entry in std::fs::read_dir(cur_dir).into_iter().flatten().flatten() {
        if !has_info(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if let Some(id) = mailvault_core::maildir::read_message_id(&entry.path()) {
            ids.entry(id).or_default().push(entry.path());
        }
    }
    ids
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

    /// Writes a file under an exact, caller-chosen name -- `seed_file` always
    /// goes through `build_maildir_filename`, which on darwin only ever
    /// emits `:`, so it cannot produce a `;`-spelled (Windows) fixture.
    fn seed_file_named(root: &std::path::Path, account: &str, mailbox: &str, filename: &str, body: &[u8]) {
        let cur = mailvault_core::vault_files::cur_path(root, account, mailbox);
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(filename), body).unwrap();
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

    // -- streaming split / escape roundtrip -------------------------------

    fn split_mbox(data: &[u8]) -> Vec<Vec<u8>> {
        split_from(std::io::Cursor::new(data.to_vec()))
    }

    fn split_from(r: impl BufRead) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for_each_mbox_message(r, |m, _| {
            out.push(m.to_vec());
            true
        })
        .unwrap();
        out
    }

    /// Hands out at most `step` bytes per read, so every boundary, blank
    /// line and CRLF pair also lands across a buffer refill.
    struct Trickle {
        data: Vec<u8>,
        pos: usize,
        step: usize,
        fail_at: Option<usize>,
    }

    impl std::io::Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.fail_at.is_some_and(|at| self.pos >= at) {
                return Err(std::io::Error::other("disk went away"));
            }
            let n = self.step.min(buf.len()).min(self.data.len() - self.pos);
            buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    fn trickle(data: &[u8], step: usize, fail_at: Option<usize>) -> std::io::BufReader<Trickle> {
        std::io::BufReader::with_capacity(step, Trickle { data: data.to_vec(), pos: 0, step, fail_at })
    }

    #[test]
    fn split_keeps_the_boundary_rules_across_tiny_reads() {
        let data: &[u8] = b"junk before any envelope\n\n\
From a@b Mon Jan  1 00:00:00 2026\r\nSubject: one\r\n\r\n>From the team\r\nnot From here\r\n\r\n\
From c@d Mon Jan  1 00:00:00 2026\nSubject: two\n\nline\nFrom mid-body, no blank before\n\n\n\
From e@f Mon Jan  1 00:00:00 2026\nSubject: three\n\nno trailing newline";
        let want: Vec<Vec<u8>> = vec![
            b"Subject: one\r\n\r\n>From the team\r\nnot From here".to_vec(),
            b"Subject: two\n\nline\nFrom mid-body, no blank before".to_vec(),
            b"Subject: three\n\nno trailing newline".to_vec(),
        ];
        assert_eq!(split_mbox(data), want);
        for step in [1, 2, 5, 7] {
            assert_eq!(split_from(trickle(data, step, None)), want, "step {step}");
        }
    }

    #[test]
    fn split_reports_bytes_read_and_stops_when_told() {
        let data = b"From a\nm1\n\nFrom b\nm2\n\nFrom c\nm3\n";
        let mut seen = Vec::new();
        for_each_mbox_message(std::io::Cursor::new(&data[..]), |m, read| {
            seen.push((m.to_vec(), read));
            seen.len() < 2
        })
        .unwrap();
        assert_eq!(seen.len(), 2, "must stop after the callback says so");
        assert_eq!(seen[0].0, b"m1");
        assert!(seen[0].1 > 0 && seen[1].1 > seen[0].1 && seen[1].1 <= data.len() as u64);
    }

    #[test]
    fn import_keeps_what_landed_when_the_read_fails_mid_file() {
        let (v, s) = state(true);
        let data = b"From a\nSubject: 1\n\nb1\n\nFrom a\nSubject: 2\n\nb2\n\nFrom a\nSubject: 3\n\nb3\n".to_vec();
        let fail_at = data.len() - 4;
        let result = import_from(&s, trickle(&data, 4, Some(fail_at)), data.len() as u64, "acct1".into(), "INBOX".into(), false, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 2, "the two whole messages before the failure are kept, not reported as an error");
        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 2);
    }

    #[test]
    fn import_that_writes_nothing_before_a_read_failure_is_an_error() {
        let (_v, s) = state(true);
        let data = b"From a\nSubject: 1\n\nb1\n".to_vec();
        assert!(import_from(&s, trickle(&data, 4, Some(8)), data.len() as u64, "acct1".into(), "INBOX".into(), false, |_, _| {}).is_err());
    }

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

    /// Task 1b: a `;2,`-spelled (Windows) vault file must be recognized both
    /// as a vault message at all (`has_info`, was a bare `contains(":2,")`)
    /// and for its flags (`info_flags`, was `split(":2,").nth(1)`). Two
    /// fixtures, one spelling each, so a test that vacuously passes on both
    /// (e.g. because the filter was skipped entirely) would show up as
    /// exporting 2 rather than the expected 1.
    #[test]
    fn export_reads_files_under_either_info_separator() {
        let (v, s) = state(true);
        seed_file_named(v.path(), "acct1", "INBOX", "1;2,A.eml", b"archived, semicolon");
        seed_file_named(v.path(), "acct1", "INBOX", "2;2,.eml", b"not archived, semicolon");
        let dest = tempfile::tempdir().unwrap().keep().join("out.mbox");
        let result = export_mbox_all(&s, dest, true, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1, "only the archived ';2,' file should be exported");
    }

    /// Not in the task brief's enumeration: `import_mbox`'s own scan for the
    /// mailbox's current max uid (line ~291) also hardcoded `:` as the only
    /// separator. A `;`-spelled existing file was invisible to it, so a new
    /// import would start back at uid 1 instead of continuing past the
    /// existing files -- silently risking a uid collision on a Windows
    /// vault. Same defect class as the brief's sites; fixed alongside them.
    #[test]
    fn import_continues_the_uid_sequence_past_semicolon_named_files() {
        let (v, s) = state(true);
        seed_file_named(v.path(), "acct1", "INBOX", &format!("{};2,S.eml", IMPORT_UID_BASE + 50), b"existing, semicolon");
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: new\r\n\r\nbody"]);

        import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), false, |_, _| {}).unwrap();

        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        let names: Vec<String> = std::fs::read_dir(&cur).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        let want = (IMPORT_UID_BASE + 51).to_string();
        assert!(names.iter().any(|n| n.starts_with(&want)), "expected uid {want} (past the existing import), got {:?}", names);
    }

    /// A Takeout import used to number from `max local + 1`, which is a uid
    /// the server has or will give its own mail: the server row then hid the
    /// import, and that server message opened the imported body.
    #[test]
    fn import_numbers_past_every_server_uid_and_continues_its_own_range() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 5, &["S"], b"a server message");
        let dir = tempfile::tempdir().unwrap();

        let first = write_mbox(dir.path(), "a.mbox", &["Subject: one\r\n\r\nb1"]);
        import_mbox(&s, first, "acct1".into(), "INBOX".into(), false, |_, _| {}).unwrap();
        let second = write_mbox(dir.path(), "b.mbox", &["Subject: two\r\n\r\nb2"]);
        import_mbox(&s, second, "acct1".into(), "INBOX".into(), false, |_, _| {}).unwrap();

        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        let mut uids: Vec<u32> = std::fs::read_dir(&cur)
            .unwrap()
            .filter_map(|e| mailvault_core::maildir::vault_filename_uid(&e.unwrap().file_name().to_string_lossy()))
            .collect();
        uids.sort_unstable();
        assert_eq!(uids, vec![5, IMPORT_UID_BASE, IMPORT_UID_BASE + 1]);
        assert_eq!(std::fs::read(mailvault_core::maildir::find_by_uid(&cur, 5).unwrap()).unwrap(), b"a server message");
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

        let result = import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), false, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 1);

        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        let names: Vec<String> = std::fs::read_dir(&cur).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names.len(), 1);
        let prefix = mailvault_core::maildir::INFO_PREFIX;
        assert!(names[0].contains(prefix) && names[0].split(prefix).nth(1).unwrap().starts_with('A'), "{:?}", names);
    }

    /// account_id joins a filesystem path the same way mailbox does; a
    /// crafted id must not be able to escape the vault root.
    #[test]
    fn import_mbox_sanitizes_a_path_traversal_account_id() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: hi\r\n\r\nbody"]);

        let result = import_mbox(&s, mbox_path, "../../../../../../tmp/evil".to_string(), "INBOX".to_string(), false, |_, _| {}).unwrap();
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
    /// Each imported message lands in the vault registry as it is written:
    /// a folder verified before the import answers with the new uids and no
    /// relisting.
    #[test]
    fn import_records_each_message_in_a_verified_registry() {
        let (v, s) = state(true);
        seed_file(v.path(), "acct1", "INBOX", 3, &["archived"], b"already");
        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(v.path(), "acct1", "INBOX"), Some((vec![3], vec![3])));

        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: one\r\n\r\nbody", "Subject: two\r\n\r\nbody"]);
        let result = import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), false, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 2);

        let b = IMPORT_UID_BASE;
        assert_eq!(reg.uid_sets(v.path(), "acct1", "INBOX"), Some((vec![3, b, b + 1], vec![3, b, b + 1])));
        assert_eq!(reg.listing_count(), 1, "the rows came from the import, not a relisting");
    }

    #[test]
    fn imported_message_survives_clear_cache() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: hi\r\n\r\nbody"]);

        import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), false, |_, _| {}).unwrap();

        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 1, "the message must have been written before clear_cache runs");

        let noop_gate = |work: &mut dyn FnMut() -> Result<(), String>| work();
        let result = mailvault_core::vault_files::clear_cache(&s.vault_registry, v.path(), &noop_gate).unwrap();

        assert_eq!(result.deleted_count, 0, "the imported message must not be deleted");
        assert_eq!(result.skipped_archived, 1, "clear_cache must recognize it as archived and skip it");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 1, "the file must still be on disk after clear_cache");
    }

    #[test]
    fn import_finds_more_than_one_message() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let mbox_path = write_mbox(dir.path(), "in.mbox", &["Subject: one\r\n\r\nbody1", "Subject: two\r\n\r\nbody2"]);

        let result = import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), false, |_, _| {}).unwrap();
        assert_eq!(result.email_count, 2);
        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 2);
    }

    const DATE: &str = "Mon, 1 Jan 2024 10:00:00 +0000";

    fn msg(id: &str, subject: &str, body: &str) -> String {
        format!("Message-ID: <{id}>\r\nSubject: {subject}\r\nDate: {DATE}\r\n\r\n{body}")
    }

    fn import(s: &Arc<DaemonState>, dir: &std::path::Path, name: &str, messages: &[&str]) -> MboxImportResult {
        import_mbox(s, write_mbox(dir, name, messages), "acct1".into(), "INBOX".into(), false, |_, _| {}).unwrap()
    }

    fn cur_count(root: &std::path::Path) -> usize {
        std::fs::read_dir(mailvault_core::vault_files::cur_path(root, "acct1", "INBOX")).unwrap().count()
    }

    #[test]
    fn importing_the_same_mbox_twice_skips_every_message_the_second_time() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let (a, b, c) = (msg("a@x", "one", "body a"), msg("b@x", "two", "body b"), msg("c@x", "three", "body c"));
        let first = import(&s, dir.path(), "a.mbox", &[&a, &b, &c]);
        assert_eq!((first.email_count, first.skipped_count), (3, 0));

        let events = std::sync::Mutex::new(Vec::new());
        let again = import_mbox(&s, write_mbox(dir.path(), "b.mbox", &[&a, &b, &c]), "acct1".into(), "INBOX".into(), false, |n, p| events.lock().unwrap().push((n.to_string(), p))).unwrap();
        assert_eq!((again.email_count, again.skipped_count), (0, 3));
        assert_eq!(cur_count(v.path()), 3, "no new files");
        let last = events.into_inner().unwrap().pop().unwrap();
        assert_eq!(last.1["skippedCount"], 3, "the final progress event carries the skipped count");
    }

    #[test]
    fn the_same_id_with_another_body_is_imported_under_a_new_import_uid() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        import(&s, dir.path(), "a.mbox", &[&msg("a@x", "one", "first body")]);
        let r = import(&s, dir.path(), "b.mbox", &[&msg("a@x", "one", "a different body")]);
        assert_eq!((r.email_count, r.skipped_count), (1, 0));
        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert!(mailvault_core::maildir::find_by_uid(&cur, IMPORT_UID_BASE + 1).is_some());
    }

    #[test]
    fn a_message_the_server_lists_with_the_same_subject_and_date_is_skipped() {
        let (v, s) = state(true);
        let headers = json!({"uidValidity": 1, "totalEmails": 1, "emails": [{"uid": 7, "messageId": "<a@x>", "subject": "one", "messageDate": DATE}]});
        crate::custody::with_conn(&s, |c| mailvault_core::custody::cache::save_headers(c, "acct1", "INBOX", &headers.to_string())).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let r = import(&s, dir.path(), "a.mbox", &[&msg("a@x", "one", "body"), &msg("b@x", "one", "body")]);
        assert_eq!((r.email_count, r.skipped_count), (1, 1));
        assert_eq!(cur_count(v.path()), 1);
    }

    #[test]
    fn a_duplicate_inside_one_mbox_is_written_once() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let a = msg("a@x", "one", "body");
        let r = import(&s, dir.path(), "a.mbox", &[&a, &a]);
        assert_eq!((r.email_count, r.skipped_count), (1, 1));
        assert_eq!(cur_count(v.path()), 1);
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
        let result = import_mbox(&s, mbox_path, "acct1".to_string(), "INBOX".to_string(), false, move |name, payload| {
            if name == "mbox-import-progress" && payload["completed"].as_u64() == Some(50) && payload["active"].as_bool() == Some(true) {
                s2.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        })
        .unwrap();

        assert_eq!(result.email_count, 50, "must stop after message 50 once the gate starts refusing");
        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "INBOX");
        assert_eq!(std::fs::read_dir(&cur).unwrap().count(), 50, "the 50 messages that landed before the refusal must still be on disk");
    }

    // -- Takeout labels: each message to its home folder --------------------

    /// A Gmail account's cached folder list, as the app saves it.
    fn gmail_listing() -> Value {
        let f = |path: &str, su: Option<&str>, flags: &[&str]| {
            json!({"name": path, "path": path, "specialUse": su, "flags": flags, "delimiter": "/", "noselect": false, "children": []})
        };
        json!({"mailboxes": [
            f("INBOX", Some("\\Inbox"), &[]),
            f("[Gmail]/All Mail", None, &["All"]),
            f("[Gmail]/Sent Mail", Some("\\Sent"), &["Sent"]),
            f("[Gmail]/Trash", Some("\\Trash"), &["Trash"]),
            f("Work", None, &[]),
            f("Work/Clients", None, &[]),
            f("Receipts", None, &[]),
        ]})
    }

    fn save_listing(s: &Arc<DaemonState>, listing: &Value) {
        crate::custody::with_conn(s, |c| mailvault_core::custody::cache::save_mailboxes(c, "acct1", &listing.to_string())).unwrap();
    }

    fn save_server_row(s: &Arc<DaemonState>, mailbox: &str, id: &str, subject: &str) {
        let headers = json!({"uidValidity": 1, "totalEmails": 1, "emails": [{"uid": 7, "messageId": format!("<{id}>"), "subject": subject, "messageDate": DATE}]});
        crate::custody::with_conn(s, |c| mailvault_core::custody::cache::save_headers(c, "acct1", mailbox, &headers.to_string())).unwrap();
    }

    /// A Takeout message; `labels` is the `X-Gmail-Labels` value, `None` for no such header.
    fn tmsg(id: &str, subject: &str, labels: Option<&str>) -> String {
        let labels = labels.map(|l| format!("X-Gmail-Labels: {l}\r\n")).unwrap_or_default();
        format!("{labels}Message-ID: <{id}>\r\nSubject: {subject}\r\nDate: {DATE}\r\n\r\nbody of {subject}")
    }

    fn import_labelled(s: &Arc<DaemonState>, dir: &Path, name: &str, fallback: &str, messages: &[String]) -> MboxImportResult {
        let refs: Vec<&str> = messages.iter().map(String::as_str).collect();
        import_mbox(s, write_mbox(dir, name, &refs), "acct1".into(), fallback.into(), true, |_, _| {}).unwrap()
    }

    /// File names in the vault dir sync writes for `mailbox`, sorted; empty when there is none.
    fn names_in(root: &Path, mailbox: &str) -> Vec<String> {
        let cur = mailvault_core::vault_files::cur_path(root, "acct1", mailbox);
        let mut names: Vec<String> = std::fs::read_dir(cur).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn uids_in(root: &Path, mailbox: &str) -> Vec<u32> {
        let mut uids: Vec<u32> = names_in(root, mailbox).iter().filter_map(|n| mailvault_core::maildir::vault_filename_uid(n)).collect();
        uids.sort_unstable();
        uids
    }

    fn counts(r: &MboxImportResult) -> Vec<(&str, u32, u32)> {
        r.folders.iter().map(|f| (f.mailbox.as_str(), f.imported, f.skipped)).collect()
    }

    #[test]
    fn labels_send_each_message_to_its_own_folder() {
        let (v, s) = state(true);
        save_listing(&s, &gmail_listing());
        let dir = tempfile::tempdir().unwrap();
        let r = import_labelled(&s, dir.path(), "t.mbox", "INBOX", &[
            tmsg("a@x", "one", Some("Opened,Work")),
            tmsg("b@x", "two", Some("Category Promotions,Receipts,Important")),
            tmsg("c@x", "three", Some("work/clients")),
        ]);
        assert_eq!(counts(&r), vec![("Work", 1, 0), ("Receipts", 1, 0), ("Work/Clients", 1, 0)]);
        assert!(r.folders_known);
        assert_eq!((r.email_count, r.skipped_count), (3, 0));
        for folder in ["Work", "Receipts", "Work/Clients"] {
            assert_eq!(names_in(v.path(), folder).len(), 1, "{folder}");
        }
        assert!(names_in(v.path(), "INBOX").is_empty(), "nothing fell back");
    }

    #[test]
    fn a_system_label_wins_over_a_custom_label_listed_before_it() {
        let (v, s) = state(true);
        save_listing(&s, &gmail_listing());
        let dir = tempfile::tempdir().unwrap();
        let r = import_labelled(&s, dir.path(), "t.mbox", "[Gmail]/All Mail", &[
            tmsg("a@x", "one", Some("Receipts,Sent")),
            tmsg("b@x", "two", Some("Work,Trash,Inbox")),
            tmsg("c@x", "three", Some("Work/Clients,Trash")),
        ]);
        assert_eq!(counts(&r), vec![("[Gmail]/Sent Mail", 1, 0), ("INBOX", 1, 0), ("[Gmail]/Trash", 1, 0)]);
        for folder in ["Receipts", "Work", "Work/Clients", "[Gmail]/All Mail"] {
            assert!(names_in(v.path(), folder).is_empty(), "{folder}");
        }
    }

    #[test]
    fn a_label_with_no_folder_goes_to_the_fallback_and_no_folder_is_made_for_it() {
        let (v, s) = state(true);
        save_listing(&s, &gmail_listing());
        let dir = tempfile::tempdir().unwrap();
        let r = import_labelled(&s, dir.path(), "t.mbox", "[Gmail]/All Mail", &[
            tmsg("a@x", "one", Some("Ghost/Sub,Opened")),
            tmsg("b@x", "two", Some("Important,Category Updates")),
            tmsg("c@x", "three", None),
            tmsg("d@x", "four", Some("Ghost,Work")),
        ]);
        assert_eq!(counts(&r), vec![("[Gmail]/All Mail", 3, 0), ("Work", 1, 0)]);
        assert_eq!(names_in(v.path(), "[Gmail]/All Mail").len(), 3);
        assert!(names_in(v.path(), "Ghost").is_empty() && names_in(v.path(), "Ghost/Sub").is_empty());
    }

    #[test]
    fn without_a_cached_listing_every_message_goes_to_the_fallback() {
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let r = import_labelled(&s, dir.path(), "t.mbox", "Archive", &[tmsg("a@x", "one", Some("Work")), tmsg("b@x", "two", Some("Sent"))]);
        assert_eq!(counts(&r), vec![("Archive", 2, 0)]);
        assert!(!r.folders_known, "the result says the folders were unknown");
        assert!(names_in(v.path(), "Work").is_empty());
    }

    /// `load_mailbox_cache`'s own read: a list still in the pre-SQL file is used.
    #[test]
    fn a_listing_still_in_the_legacy_file_routes_too() {
        let (v, s) = state(true);
        let legacy = mailvault_core::header_cache::legacy_mailbox_cache(v.path(), "acct1");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, gmail_listing().to_string()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let r = import_labelled(&s, dir.path(), "t.mbox", "INBOX", &[tmsg("a@x", "one", Some("Work"))]);
        assert_eq!(counts(&r), vec![("Work", 1, 0)]);
        assert!(r.folders_known);
    }

    /// Starred is flagged; read unless `Unread` (which beats `Opened`), and a
    /// message with no labels is read (R5). Read back the way the list reads a
    /// vault folder.
    #[test]
    fn label_flags_land_in_the_file_name_and_read_back_as_flags() {
        let (v, s) = state(true);
        save_listing(&s, &gmail_listing());
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            ("starred", Some("Work,Starred,Opened"), "AFS"),
            ("unread", Some("Work,Unread"), "A"),
            ("opened", Some("Opened,Work"), "AS"),
            ("both", Some("Opened,Unread,Work"), "A"),
            ("starred unread", Some("Unread,Starred,Work"), "AF"),
            ("no labels", None, "AS"),
        ];
        let msgs: Vec<String> = cases.iter().enumerate().map(|(i, (subject, labels, _))| tmsg(&format!("{i}@x"), subject, *labels)).collect();
        import_labelled(&s, dir.path(), "t.mbox", "INBOX", &msgs);

        for (subject, _, letters) in cases {
            let folder = if subject == "no labels" { "INBOX" } else { "Work" };
            let rows = s.vault_registry.light_rows(v.path(), "acct1", folder, None).expect("the folder reads");
            let row = rows.iter().find(|r| r["subject"] == subject).unwrap_or_else(|| panic!("{subject} not in {folder}"));
            let flags: Vec<&str> = row["flags"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
            assert!(flags.contains(&"archived"), "{subject}: {flags:?}");
            assert_eq!(flags.contains(&"\\Seen"), letters.contains('S'), "{subject}: {flags:?}");
            assert_eq!(flags.contains(&"\\Flagged"), letters.contains('F'), "{subject}: {flags:?}");
            let uid = row["uid"].as_u64().unwrap().to_string();
            let name = names_in(v.path(), folder).into_iter().find(|n| n.split(is_info_sep).next() == Some(uid.as_str())).unwrap();
            assert_eq!(info_flags(&name).map(|f| f.trim_end_matches(".eml")), Some(letters), "{subject}: {name}");
        }
    }

    /// The old call shape stays exactly as it was: one folder, `A` only, even
    /// for a Takeout message whose labels say starred and read.
    #[test]
    fn without_use_labels_a_takeout_message_keeps_the_archived_flag_only() {
        let (v, s) = state(true);
        save_listing(&s, &gmail_listing());
        let dir = tempfile::tempdir().unwrap();
        let path = write_mbox(dir.path(), "t.mbox", &[&tmsg("a@x", "one", Some("Work,Starred,Opened"))]);
        let r = import_mbox(&s, path, "acct1".into(), "INBOX".into(), false, |_, _| {}).unwrap();
        assert_eq!(counts(&r), vec![("INBOX", 1, 0)]);
        assert!(!r.folders_known, "no folder list was used");
        let names = names_in(v.path(), "INBOX");
        assert_eq!(names.len(), 1);
        assert_eq!(info_flags(&names[0]).map(|f| f.trim_end_matches(".eml")), Some("A"), "{names:?}");
        assert!(names_in(v.path(), "Work").is_empty());
    }

    /// Dedupe is per target folder: a second run imports nothing, and one
    /// message filed under two folders lands in both.
    #[test]
    fn dedupe_runs_per_target_folder() {
        let (v, s) = state(true);
        save_listing(&s, &gmail_listing());
        let dir = tempfile::tempdir().unwrap();
        let msgs = [tmsg("a@x", "same", Some("Work")), tmsg("a@x", "same", Some("Receipts")), tmsg("b@x", "two", Some("Receipts"))];
        let first = import_labelled(&s, dir.path(), "a.mbox", "INBOX", &msgs);
        assert_eq!(counts(&first), vec![("Work", 1, 0), ("Receipts", 2, 0)]);
        let again = import_labelled(&s, dir.path(), "b.mbox", "INBOX", &msgs);
        assert_eq!((again.email_count, again.skipped_count), (0, 3));
        assert_eq!(counts(&again), vec![("Work", 0, 1), ("Receipts", 0, 2)]);
        assert_eq!((names_in(v.path(), "Work").len(), names_in(v.path(), "Receipts").len()), (1, 2));
    }

    /// Each folder's server listing decides for that folder only.
    #[test]
    fn each_folder_is_checked_against_its_own_server_listing() {
        let (_v, s) = state(true);
        save_listing(&s, &gmail_listing());
        save_server_row(&s, "Work", "a@x", "one");
        let dir = tempfile::tempdir().unwrap();
        let r = import_labelled(&s, dir.path(), "t.mbox", "INBOX", &[tmsg("a@x", "one", Some("Work")), tmsg("a@x", "one", Some("Receipts"))]);
        assert_eq!(counts(&r), vec![("Work", 0, 1), ("Receipts", 1, 0)]);
    }

    #[test]
    fn each_folder_numbers_its_imports_from_the_import_base_and_continues_its_own_range() {
        let (v, s) = state(true);
        save_listing(&s, &gmail_listing());
        seed_file(v.path(), "acct1", "Work", 7, &["S"], b"a server message");
        seed_file(v.path(), "acct1", "Work", IMPORT_UID_BASE + 4, &["A"], b"an earlier import");
        let dir = tempfile::tempdir().unwrap();
        import_labelled(&s, dir.path(), "t.mbox", "INBOX", &[
            tmsg("a@x", "one", Some("Work")),
            tmsg("b@x", "two", Some("Receipts")),
            tmsg("c@x", "three", Some("Work")),
        ]);
        let b = IMPORT_UID_BASE;
        assert_eq!(uids_in(v.path(), "Work"), vec![7, b + 4, b + 5, b + 6]);
        assert_eq!(uids_in(v.path(), "Receipts"), vec![b]);
    }

    /// R7: a Graph folder's vault dir is the one sync writes for its storage
    /// key (`path`), never its display name, and its header cache is read
    /// under that key too.
    #[test]
    fn a_graph_account_files_under_the_storage_key_sync_uses() {
        let (v, s) = state(true);
        let g = |name: &str, path: &str, su: Option<&str>| {
            json!({"name": name, "path": path, "specialUse": su, "flags": [], "delimiter": "/", "noselect": false, "children": [], "_graphFolderId": "AAMk"})
        };
        save_listing(&s, &json!({"mailboxes": [
            g("INBOX", "INBOX", Some("\\Inbox")),
            g("Gesendet", "Sent", Some("\\Sent")),
            g("Archiv", "Archive", Some("\\Archive")),
            g("Project X", "Project X", None),
        ]}));
        save_server_row(&s, "Sent", "old@x", "already there");
        let dir = tempfile::tempdir().unwrap();
        let r = import_labelled(&s, dir.path(), "t.mbox", "Archive", &[
            tmsg("new@x", "hi", Some("Sent")),
            tmsg("old@x", "already there", Some("Sent")),
            tmsg("p@x", "plan", Some("Project X")),
        ]);
        assert_eq!(counts(&r), vec![("Sent", 1, 1), ("Project X", 1, 0)]);
        assert_eq!(names_in(v.path(), "Sent").len(), 1);
        assert!(names_in(v.path(), "Gesendet").is_empty(), "the display name is not a dir");
        let project = mailvault_core::vault_files::cur_path(v.path(), "acct1", "Project X");
        assert!(project.ends_with("Project_X/cur") && std::fs::read_dir(&project).unwrap().count() == 1, "{project:?}");
    }

    /// `..` names the account dir's parent; a mailbox (or fallback) spelled so
    /// must still land inside the account dir.
    #[test]
    fn a_dot_dot_mailbox_stays_inside_the_account_dir() {
        for use_labels in [false, true] {
            let (v, s) = state(true);
            let dir = tempfile::tempdir().unwrap();
            let path = write_mbox(dir.path(), "t.mbox", &[&tmsg("a@x", "one", Some("Ghost"))]);
            import_mbox(&s, path, "acct1".into(), "..".into(), use_labels, |_, _| {}).unwrap();
            assert!(!v.path().join("Maildir").join("cur").exists(), "escaped the account dir (labels: {use_labels})");
            assert_eq!(names_in(v.path(), "..").len(), 1, "labels: {use_labels}");
        }
    }

    /// Another writer (the rehome pass, a second import) takes the next import
    /// uid after this import seeded its allocator, under other flags than the
    /// import's own. The import must step past it, never write a second file
    /// under that uid. Once with the taker's row in the registry, once with
    /// the registry invalidated as the rehome pass leaves it (disk decides).
    #[test]
    fn a_uid_another_writer_took_after_the_seed_is_skipped_whatever_its_flags() {
        for registry_row in [true, false] {
            let (v, s) = state(true);
            save_listing(&s, &gmail_listing());
            let dir = tempfile::tempdir().unwrap();
            let msgs: Vec<String> = (0..51).map(|i| tmsg(&format!("{i}@x"), &format!("m{i}"), Some("Work,Opened"))).collect();
            let refs: Vec<&str> = msgs.iter().map(String::as_str).collect();
            let taken = IMPORT_UID_BASE + 50;
            let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "Work");
            let planted = cur.join(build_maildir_filename(taken, &["archived".to_string(), "flagged".to_string()]));
            let s2 = Arc::clone(&s);
            let p2 = planted.clone();
            let r = import_mbox(&s, write_mbox(dir.path(), "t.mbox", &refs), "acct1".into(), "INBOX".into(), true, move |name, payload| {
                // Right after message 50 landed at BASE + 49, before message 51.
                if name == "mbox-import-progress" && payload["completed"] == 50 && payload["active"] == true {
                    std::fs::write(&p2, b"Subject: taken\r\n\r\nanother writer's message").unwrap();
                    if registry_row {
                        s2.vault_registry.upsert("acct1", "Work", taken, &p2);
                    } else {
                        s2.vault_registry.invalidate("acct1", "Work");
                    }
                }
            })
            .unwrap();
            assert_eq!(r.email_count, 51, "registry row: {registry_row}");

            let uids = uids_in(v.path(), "Work");
            let mut unique = uids.clone();
            unique.dedup();
            assert_eq!(uids, unique, "two files under one uid (registry row: {registry_row})");
            assert_eq!(uids.len(), 52, "registry row: {registry_row}");
            assert_eq!(std::fs::read(&planted).unwrap(), b"Subject: taken\r\n\r\nanother writer's message");
            let last = mailvault_core::maildir::find_by_uid(&cur, taken + 1).expect("message 51 lands past the taken uid");
            assert!(std::fs::read_to_string(last).unwrap().contains("Subject: m50"), "registry row: {registry_row}");
        }
    }

    /// A label import whose folder list cannot be read fails before writing:
    /// filing a whole Takeout in the fallback could not be undone. An import
    /// without labels never reads the list; the probe degrades to "unknown".
    #[test]
    fn an_unreadable_folder_list_fails_a_label_import_and_writes_nothing() {
        let (v, s) = state(true);
        save_listing(&s, &gmail_listing());
        crate::custody::close(&s);
        let dir = tempfile::tempdir().unwrap();
        let path = write_mbox(dir.path(), "t.mbox", &[&tmsg("a@x", "one", Some("Work"))]);

        assert!(import_mbox(&s, path.clone(), "acct1".into(), "INBOX".into(), true, |_, _| {}).is_err());
        assert!(!mailvault_core::vault_files::account_dir(&v.path().join("Maildir"), "acct1").exists(), "nothing was written");

        assert!(!probe_mbox(&s, &path, "acct1").unwrap().folders_known);
        let plain = import_mbox(&s, path, "acct1".into(), "INBOX".into(), false, |_, _| {}).unwrap();
        assert_eq!(counts(&plain), vec![("INBOX", 1, 0)]);
    }

    /// Nothing landed and a write failed: the run is an error, never
    /// "0 imported" (the up-front `create_dir_all` this replaced answered so).
    #[test]
    fn an_import_that_cannot_write_its_first_message_is_an_error() {
        for use_labels in [false, true] {
            let (v, s) = state(true);
            save_listing(&s, &gmail_listing());
            let account = mailvault_core::vault_files::account_dir(&v.path().join("Maildir"), "acct1");
            std::fs::create_dir_all(&account).unwrap();
            std::fs::write(account.join("INBOX"), b"a file where the folder dir belongs").unwrap();
            let dir = tempfile::tempdir().unwrap();
            let path = write_mbox(dir.path(), "t.mbox", &[&tmsg("a@x", "one", Some("Inbox"))]);
            let r = import_mbox(&s, path, "acct1".into(), "INBOX".into(), use_labels, |_, _| {});
            assert!(r.is_err(), "labels: {use_labels}: {r:?}");
        }
    }

    /// Readers that take no lock (the backup's local-folder pass, the
    /// pre-sync) list `cur/` while an import writes, and copy what they find
    /// once, for good. So a message's own name may only ever hold the whole
    /// message. A watcher lists the folder through an import of large
    /// messages and reads the size of every file a uid scanner would take
    /// (`mirror_filename_uid`, the rule the mirror copy uses): none is ever
    /// short, and no temp is left once the import is done.
    #[test]
    fn a_reader_listing_the_folder_mid_import_never_sees_half_a_message() {
        use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
        const BODY: usize = 16 << 20;
        const MESSAGES: usize = 6;
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let line = format!("{}\r\n", "x".repeat(75));
        let body = line.repeat(BODY / line.len() + 1);
        let messages: Vec<String> = (0..MESSAGES).map(|i| format!("Message-ID: <big-{i}@x>\r\nSubject: big {i}\r\n\r\n{body}")).collect();
        let refs: Vec<&str> = messages.iter().map(String::as_str).collect();
        let path = write_mbox(dir.path(), "big.mbox", &refs);
        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "Big");

        let done = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (cur, done) = (cur.clone(), Arc::clone(&done));
            std::thread::spawn(move || {
                let (mut looked, mut short) = (0usize, Vec::new());
                loop {
                    let last = done.load(SeqCst);
                    for entry in std::fs::read_dir(&cur).into_iter().flatten().flatten() {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        if mailvault_core::maildir::mirror_filename_uid(&name).is_none() {
                            continue;
                        }
                        looked += 1;
                        let len = entry.metadata().map(|m| m.len() as usize).unwrap_or(0);
                        if len < BODY {
                            short.push((name, len));
                        }
                    }
                    if last {
                        return (looked, short);
                    }
                }
            })
        };
        let r = import_mbox(&s, path, "acct1".into(), "Big".into(), false, |_, _| {});
        done.store(true, SeqCst);
        let (looked, short) = watcher.join().unwrap();

        assert_eq!(r.unwrap().email_count, MESSAGES as u32);
        assert!(looked >= MESSAGES, "the watcher saw the folder's files ({looked})");
        assert!(short.is_empty(), "a uid name held part of a message {} times, e.g. {:?}", short.len(), &short[..short.len().min(3)]);
        let names = names_in(v.path(), "Big");
        assert_eq!(names.len(), MESSAGES, "one file per message, no temp left: {names:?}");
        assert!(names.iter().all(|n| mailvault_core::maildir::vault_filename_uid(n).is_some()), "{names:?}");
    }

    /// A message write the disk refuses (here a `cur/` that takes no new
    /// file) stops the import as an error and leaves nothing in the folder:
    /// no file under the uid, no temp beside it, and the registry still
    /// answers for the folder as it is.
    #[cfg(unix)]
    #[test]
    fn a_refused_message_write_leaves_nothing_in_the_folder() {
        use std::os::unix::fs::PermissionsExt;
        let (v, s) = state(true);
        let dir = tempfile::tempdir().unwrap();
        let path = write_mbox(dir.path(), "t.mbox", &[&tmsg("a@x", "one", None)]);
        let cur = mailvault_core::vault_files::cur_path(v.path(), "acct1", "Big");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::set_permissions(&cur, std::fs::Permissions::from_mode(0o555)).unwrap();
        if std::fs::write(cur.join("probe"), b"").is_ok() {
            // Root ignores the mode: nothing to prove here.
            return;
        }

        let r = import_mbox(&s, path, "acct1".into(), "Big".into(), false, |_, _| {});
        std::fs::set_permissions(&cur, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(r.is_err(), "{r:?}");
        assert_eq!(names_in(v.path(), "Big"), Vec::<String>::new());
        let listed = s.vault_registry.files(v.path(), "acct1", "Big").expect("the registry answers");
        assert!(listed.is_empty(), "{listed:?}");
    }

    // -- probe ---------------------------------------------------------------

    fn mbox_bytes(messages: &[String]) -> Vec<u8> {
        messages.iter().flat_map(|m| format!("From sender@test.com Mon Jan  1 00:00:00 2026\n{m}\n\n").into_bytes()).collect()
    }

    #[test]
    fn sampling_finds_labels_on_any_sampled_message() {
        let plain = |i: u32| tmsg(&format!("{i}@x"), "plain", None);
        let labelled = mbox_bytes(&[plain(1), plain(2), tmsg("3@x", "t", Some("Inbox,Opened"))]);
        assert_eq!(sample_labels(&labelled[..], 200, 1 << 20).unwrap(), (true, 3));
        let unlabelled = mbox_bytes(&[plain(1), tmsg("2@x", "empty value", Some(" "))]);
        assert_eq!(sample_labels(&unlabelled[..], 200, 1 << 20).unwrap(), (false, 2));
    }

    #[test]
    fn sampling_stops_at_the_message_cap() {
        let mut msgs: Vec<String> = (0..300).map(|i| tmsg(&format!("{i}@x"), "plain", None)).collect();
        msgs[250] = tmsg("250@x", "late", Some("Work"));
        assert_eq!(sample_labels(&mbox_bytes(&msgs)[..], 200, 1 << 30).unwrap(), (false, 200));
    }

    /// The byte budget sits under the buffer: a reader that fails the moment
    /// anything past the budget is asked for must never be hit.
    #[test]
    fn sampling_never_reads_past_the_byte_budget() {
        let head = mbox_bytes(&(0..20).map(|i| tmsg(&format!("{i}@x"), "plain", None)).collect::<Vec<_>>());
        let mut data = head.clone();
        data.extend(mbox_bytes(&[tmsg("late@x", "late", Some("Work"))]));
        let budget = head.len();
        let r = Trickle { data, pos: 0, step: 3, fail_at: Some(budget) };
        assert_eq!(sample_labels(r, 200, budget as u64).unwrap(), (false, 20));
    }
}
