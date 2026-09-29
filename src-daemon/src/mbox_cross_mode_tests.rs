//! What only shows across the three MBOX import modes: mode 1 ("Import and
//! restore to the server", the upload job, run here against the mock server
//! through the job's own rig in `super::tests`), mode 2 ("Import into my
//! existing folders") and mode 3 ("Import as a separate folder"), both through
//! the `import_mbox` route on the same daemon state. So every mode meets the
//! same vault, header cache, search index and event bus.
//!
//! The imports send `mbox-import-progress` on the same bus the job does, so a
//! job's end is waited for by its id (`job_done`), never as "the next event
//! that is not active".

use super::tests::{
    call, config, control, fast, gmail, idless, labelled, mbox, mbox_bytes, msg, next, ok, setup, slow_appends, start, status_of, subjects,
    wait_until_not_live, wait_until_uploaded, Rig, DATE,
};
use super::*;
use crate::ipc;
use mailvault_core::maildir::{self, IMPORT_UID_BASE};
use mailvault_core::search_index::query::SearchRequest;
use mailvault_core::{local_folder, vault_files};
use std::collections::{BTreeMap, HashSet};

// ---- helpers ----

/// The daemon quit and started again over the same vault and app data. The
/// old state's header-cache store is closed first: it holds its file
/// exclusively, as the one process that owns it. The new state gets the
/// account's credentials, the job tuning and an event subscription of its own.
fn restart(rig: Rig, tuning: Tuning) -> Rig {
    let Rig { server, s, files, _vault, _app, .. } = rig;
    crate::custody::close(&s);
    drop(s);
    let s = DaemonState::for_test(_vault.path().to_path_buf(), _app.path().to_path_buf(), true);
    s.raw_messages.accounts.lock().unwrap().insert("acct1".into(), config(&server));
    *lock(&s.mbox_uploads.tuning) = Some(tuning);
    let rx = s.events.subscribe();
    Rig { server, s, rx, files, _vault, _app }
}

fn account_dir(rig: &Rig, account: &str) -> PathBuf {
    vault_files::account_dir(&rig._vault.path().join("Maildir"), account)
}

/// `(folder dir, file name, bytes)` of every file in each `cur/` of the
/// account, sorted. None when the account has no dir.
fn cur_files(account_dir: &Path) -> Vec<(String, String, Vec<u8>)> {
    let mut out = Vec::new();
    for folder in std::fs::read_dir(account_dir).into_iter().flatten().flatten() {
        if !folder.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let dir = folder.file_name().to_string_lossy().into_owned();
        for file in std::fs::read_dir(folder.path().join("cur")).into_iter().flatten().flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            out.push((dir.clone(), name, std::fs::read(file.path()).unwrap_or_default()));
        }
    }
    out.sort();
    out
}

/// The bytes of every regular file directly in `dir`.
fn files_in(dir: &Path) -> Vec<Vec<u8>> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| std::fs::read(e.path()).unwrap())
        .collect()
}

/// No half-written or stray file in any `cur/` of the account: each entry is
/// a message under a uid name (never a dot-prefixed temp) and holds bytes.
fn assert_no_garbage(account_dir: &Path) {
    for (dir, name, raw) in cur_files(account_dir) {
        assert!(!name.starts_with('.') && maildir::vault_filename_uid(&name).is_some(), "{dir}/cur/{name} is no message file");
        assert!(!raw.is_empty(), "{dir}/cur/{name} is empty");
    }
}

/// `(length, content fingerprint)` of each message, sorted: whole messages
/// compared without printing 200 KiB when they differ.
fn prints(messages: impl IntoIterator<Item = Vec<u8>>) -> Vec<(usize, u64)> {
    let mut out: Vec<(usize, u64)> = messages.into_iter().map(|m| (m.len(), fingerprint(&m))).collect();
    out.sort_unstable();
    out
}

/// Every entry under `root`, symlinks not followed: a file with its bytes, a
/// directory (or anything else) as `None`.
fn tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut out = BTreeMap::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => {
                    dirs.push(path.clone());
                    out.insert(path, None);
                }
                Ok(t) if t.is_file() => {
                    let bytes = std::fs::read(&path).unwrap_or_default();
                    out.insert(path, Some(bytes));
                }
                _ => {
                    out.insert(path, None);
                }
            }
        }
    }
    out
}

/// The account's cached folder list, as the app saves it.
fn save_listing(s: &Arc<DaemonState>, account: &str, paths: &[&str]) {
    let list: Vec<Value> =
        paths.iter().map(|p| json!({"name": p, "path": p, "specialUse": null, "flags": [], "delimiter": "/", "noselect": false, "children": []})).collect();
    crate::custody::with_conn(s, |c| cache::save_mailboxes(c, account, &json!({ "mailboxes": list }).to_string())).unwrap();
}

fn save_headers(s: &Arc<DaemonState>, account: &str, mailbox: &str, rows: &Value) {
    crate::custody::with_conn(s, |c| cache::save_headers(c, account, mailbox, &rows.to_string())).unwrap();
}

/// Mode 2.
async fn import_local(rig: &Rig, account: &str, file: &Path, mailbox: &str, labels: bool) -> Value {
    let params = json!({"sourcePath": file.to_string_lossy(), "accountId": account, "mode": "local", "mailbox": mailbox, "useLabels": labels});
    ok(call(&rig.s, "import_mbox", params).await)
}

/// Mode 3.
async fn import_folder(rig: &Rig, account: &str, file: &Path) -> Value {
    ok(call(&rig.s, "import_mbox", json!({"sourcePath": file.to_string_lossy(), "accountId": account, "mode": "folder"})).await)
}

async fn local_folders(rig: &Rig, account: &str) -> Value {
    ok(call(&rig.s, "list_local_folders", json!({ "accountId": account })).await)
}

/// The job's last event. The imports on this bus send the same event name.
async fn job_done(rig: &mut Rig, job: &str) -> Value {
    next(&mut rig.rx, |e| e["jobId"] == json!(job) && e["active"] == json!(false)).await
}

/// Mode 1 over `file`, for acct1, to its end: its last event.
async fn upload(rig: &mut Rig, file: &Path, labels: bool) -> Value {
    let job = start(rig, file, labels).await;
    job_done(rig, &job).await
}

fn counts(last: &Value) -> (Value, Value, Value, Value) {
    (last["state"].clone(), last["uploadedCount"].clone(), last["skippedCount"].clone(), last["failedCount"].clone())
}

fn id_of(row: &Value) -> String {
    maildir::normalize_message_id(row["messageId"].as_str().unwrap_or(""))
}

/// The rows the app's list shows for acct1's `mailbox` (`deriveDisplayRows`,
/// view "all"), as `(uid, Message-ID)`: every row the header cache holds,
/// then every archived vault row whose uid none of them has. The vault side
/// is read through the routes the app reads (`vault_uid_sets`,
/// `vault_light_rows`), so the generation repair and the old-import pass run
/// first, as they do there.
async fn list_rows(rig: &Rig, mailbox: &str) -> Vec<(u64, String)> {
    let cached = crate::custody::with_conn(&rig.s, |c| cache::all_headers(c, "acct1", mailbox)).expect("the header cache reads");
    let mut rows: Vec<(u64, String)> = cached.iter().filter_map(|r| Some((r["uid"].as_u64()?, id_of(r)))).collect();
    let server: HashSet<u64> = rows.iter().map(|r| r.0).collect();
    let params = json!({"accountId": "acct1", "mailbox": mailbox});
    let sets = ok(call(&rig.s, "vault_uid_sets", params.clone()).await);
    let archived: HashSet<u64> = sets["archived"].as_array().expect("the vault folder reads").iter().filter_map(Value::as_u64).collect();
    let vault = ok(call(&rig.s, "vault_light_rows", params).await);
    for row in vault.as_array().expect("the vault folder reads") {
        let Some(uid) = row["uid"].as_u64() else { continue };
        if !server.contains(&uid) && archived.contains(&uid) {
            rows.push((uid, id_of(row)));
        }
    }
    rows
}

// ---- 1. dedupe across modes ----

/// Mode 2, then mode 1, over one file. An import copy is the vault's alone,
/// so the upload finds nothing on the server and puts each message there
/// once, keeping a vault copy under each server uid, and its completion sync
/// caches those uids as server rows. What must then hold: the server has each
/// message once, nothing is lost, and the list shows each message once.
///
/// Traced, not run: `import_rehome::plan` and `maildir::repair_generation`
/// leave import-range uids alone, the upload's dedupe asks only the header
/// cache and the server (never the vault), and the app's list adds a vault
/// row whose uid no server row has. So today the import copy (at
/// `IMPORT_UID_BASE`) lists beside the server's copy and the last assertion
/// fails, until the upload retires the import copy of what it restored.
#[tokio::test]
async fn a_file_imported_locally_then_restored_to_the_server_lists_each_message_once() {
    let mut rig = setup(gmail(), fast());
    let messages = [msg("m1@x", "one"), msg("m2@x", "two")];
    let file = mbox(&rig, &messages);

    let local = import_local(&rig, "acct1", &file, "INBOX", false).await;
    assert_eq!((local["emailCount"].clone(), local["skippedCount"].clone()), (json!(2), json!(0)));

    let last = upload(&mut rig, &file, false).await;
    assert_eq!(counts(&last), (json!(DONE), json!(2), json!(0), json!(0)), "an import copy is not on the server: {last}");

    // The server holds each message once.
    assert_eq!(rig.server.count_commands("APPEND"), 2);
    assert_eq!(subjects(&rig.server, "INBOX")[4..], ["one", "two"]);

    // The completion sync cached the uploads as server rows.
    let cached = crate::custody::with_conn(&rig.s, |c| cache::all_headers(c, "acct1", "INBOX")).unwrap();
    let uploaded: Vec<u64> = cached.iter().filter(|r| ["m1@x", "m2@x"].contains(&id_of(r).as_str())).filter_map(|r| r["uid"].as_u64()).collect();
    assert_eq!(uploaded.len(), 2, "the upload's completion sync caches both uploads as server rows: {cached:?}");

    // The vault keeps its copy under each server uid.
    let sets = ok(call(&rig.s, "vault_uid_sets", json!({"accountId": "acct1", "mailbox": "INBOX"})).await);
    for uid in &uploaded {
        assert!(sets["archived"].as_array().is_some_and(|a| a.contains(&json!(uid))), "the vault keeps the upload at the server's uid {uid}: {sets}");
    }

    // Nothing is lost: each message is still in the folder, in `cur/` or set aside.
    let inbox = account_dir(&rig, "acct1").join("INBOX");
    let held: Vec<Vec<u8>> = files_in(&inbox.join("cur")).into_iter().chain(files_in(&inbox.join(maildir::ORPHAN_DIR))).collect();
    for m in &messages {
        assert!(held.contains(m), "{} is in the folder", String::from_utf8_lossy(m));
    }
    assert_no_garbage(&account_dir(&rig, "acct1"));

    // One list row per message.
    let rows = list_rows(&rig, "INBOX").await;
    for id in ["m1@x", "m2@x"] {
        let n = rows.iter().filter(|r| r.1 == id).count();
        assert_eq!(n, 1, "<{id}> lists once after mode 2, mode 1 and the sync, not as its import copy beside the server's: {rows:?}");
    }
}

/// The other order: mode 1, then mode 2 over the same file. The upload's
/// vault copy under each server uid answers mode 2's dedupe (same Message-ID,
/// Subject and content), so mode 2 writes nothing and the list shows each
/// message once.
#[tokio::test]
async fn a_file_restored_to_the_server_then_imported_locally_is_skipped_and_lists_once() {
    let mut rig = setup(gmail(), fast());
    let messages = [msg("m1@x", "one"), msg("m2@x", "two")];
    let file = mbox(&rig, &messages);

    let last = upload(&mut rig, &file, false).await;
    assert_eq!(counts(&last), (json!(DONE), json!(2), json!(0), json!(0)));

    let local = import_local(&rig, "acct1", &file, "INBOX", false).await;
    assert_eq!((local["emailCount"].clone(), local["skippedCount"].clone()), (json!(0), json!(2)), "{local}");
    assert_eq!(rig.server.count_commands("APPEND"), 2);

    let rows = list_rows(&rig, "INBOX").await;
    for id in ["m1@x", "m2@x"] {
        assert_eq!(rows.iter().filter(|r| r.1 == id).count(), 1, "<{id}>: {rows:?}");
    }
    assert_no_garbage(&account_dir(&rig, "acct1"));
}

// ---- 2. search finds imported mail in each mode ----

/// A body word finds the imported message whichever mode brought it in: a
/// mode 2 import into Work, a mode 3 folder, a mode 1 upload's vault copy in
/// INBOX. Once each, in its own folder, as a body match (the word is in no
/// header), after one full index pass over the vault.
#[tokio::test]
async fn a_body_word_finds_imported_mail_in_every_mode() {
    let mut rig = setup(gmail(), fast());
    let body = |id: &str, subject: &str, word: &str| {
        format!("From: Ann <ann@x.test>\r\nMessage-ID: <{id}>\r\nSubject: {subject}\r\nDate: {DATE}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe {word} is in the body only.")
            .into_bytes()
    };
    let filed = mbox(&rig, &[body("s2@x", "filed in a folder", "periwinkle")]);
    assert_eq!(import_local(&rig, "acct1", &filed, "Work", false).await["emailCount"], json!(1));
    let apart = mbox(&rig, &[body("s3@x", "kept apart", "marzipan")]);
    let made = import_folder(&rig, "acct1", &apart).await;
    let local_dir = made["folder"]["dir"].as_str().expect("a folder of its own").to_string();
    let restored = mbox(&rig, &[body("s1@x", "restored", "tamarind")]);
    assert_eq!(upload(&mut rig, &restored, false).await["uploadedCount"], json!(1));

    let root = rig._vault.path().to_path_buf();
    *mailvault_core::search_index::lock(&rig.s.search_index.db) = Some(mailvault_core::search_index::db::open(&root).unwrap());
    let config = mailvault_core::search_index::reconcile::IndexConfig { bodies: true, attachments: false, image_text: false };
    let generation = rig.s.search_index.operation_generation.load(std::sync::atomic::Ordering::SeqCst);
    let pass = crate::search_index::sweep(&rig.s.search_index, &root.join("Maildir"), config, None, generation);
    assert!(pass.success && pass.completed, "{:?}", pass.error);

    for (word, dir, server_uid) in [("periwinkle", "Work", false), ("marzipan", local_dir.as_str(), false), ("tamarind", "INBOX", true)] {
        let request = SearchRequest { account_id: "acct1".into(), query: word.into(), ..Default::default() };
        let reply = crate::search_index::search_reply(&rig.s.search_index, &request).expect("the index answers");
        let rows = reply["rows"].as_array().unwrap_or_else(|| panic!("{word}: {reply}"));
        assert_eq!(rows.len(), 1, "{word}: {reply}");
        assert_eq!(rows[0]["vaultDir"], json!(dir), "{word}");
        assert!(rows[0]["matchedIn"].as_array().is_some_and(|m| m.contains(&json!("body"))), "{word}: {}", rows[0]);
        let uid = rows[0]["uid"].as_u64().expect("a uid");
        assert_eq!(uid < u64::from(IMPORT_UID_BASE), server_uid, "{word}: uid {uid} (a server uid only for the upload)");
    }
}

// ---- 3. restart persistence ----

/// A folder imported as a separate folder is still there after the daemon
/// restarts: listed the same, marker and all, and its messages read.
#[tokio::test]
async fn a_separate_folder_outlives_a_daemon_restart() {
    let rig = setup(gmail(), fast());
    let file = mbox(&rig, &[msg("a@x", "one"), msg("b@x", "two")]);
    let made = import_folder(&rig, "acct1", &file).await;
    let name = made["folder"]["name"].as_str().expect("a folder of its own").to_string();
    let listed = local_folders(&rig, "acct1").await;
    assert_eq!(listed.as_array().map(Vec::len), Some(1), "{listed}");

    let rig = restart(rig, fast());
    assert_eq!(local_folders(&rig, "acct1").await, listed, "the same folder, name, marker and all");
    let params = json!({"accountId": "acct1", "mailbox": name});
    let sets = ok(call(&rig.s, "vault_uid_sets", params.clone()).await);
    assert_eq!(sets["archived"], json!([IMPORT_UID_BASE, IMPORT_UID_BASE + 1]), "{sets}");
    let rows = ok(call(&rig.s, "vault_light_rows", params).await);
    let read: Vec<&str> = rows.as_array().expect("its messages read").iter().filter_map(|r| r["subject"].as_str()).collect();
    assert_eq!(read, ["one", "two"]);
}

/// An upload the daemon died in the middle of (two messages sent and
/// checkpointed, then killed: no last checkpoint, no event) is listed by the
/// next daemon as paused, and a resume there finishes it, each message on
/// the server once, with and without a Message-ID.
#[tokio::test]
async fn an_upload_cut_off_by_a_daemon_restart_is_listed_and_resumes_to_the_end() {
    let rig = setup(gmail(), Tuning { checkpoint_every: 1, crash_after: Some(2), ..fast() });
    let file = mbox(&rig, &[msg("a@x", "one"), idless("chat two"), msg("c@x", "three"), idless("chat four")]);
    let job = start(&rig, &file, false).await;
    wait_until_not_live(&rig, &job).await;
    let journal = read_journal(&rig.s.app_dir, &job).expect("the journal outlives the worker");
    assert_eq!((journal.uploaded, journal.state.as_str()), (2, RUNNING));
    assert!(journal.offset > 0 && journal.offset < journal.size, "{}", journal.offset);
    assert_eq!(rig.server.count_commands("APPEND"), 2);

    let mut rig = restart(rig, fast());
    crate::custody::with_conn(&rig.s, |_| Ok(())).expect("the new daemon has its header cache store again");
    let listed = status_of(&rig, &job).await;
    assert_eq!(
        (listed["live"].clone(), listed["state"].clone(), listed["uploadedCount"].clone(), listed["bytesDone"].clone()),
        (json!(false), json!(PAUSED), json!(2), json!(journal.offset)),
        "{listed}"
    );

    let resumed = ok(call(&rig.s, "mbox_upload_resume", json!({ "jobId": job })).await);
    assert_eq!(resumed, json!({"jobId": job, "resumed": true, "restarted": false}));
    let last = job_done(&mut rig, &job).await;
    assert_eq!(counts(&last), (json!(DONE), json!(4), json!(0), json!(0)), "{last}");
    assert_eq!(rig.server.count_commands("APPEND"), 4, "nothing sent twice");
    assert_eq!(subjects(&rig.server, "INBOX")[4..], ["one", "chat two", "three", "chat four"]);
    assert!(list_journals(&rig.s.app_dir).is_empty(), "a finished upload leaves no journal");
}

// ---- 4. malformed input ----

/// A file that breaks what an mbox can break: junk before the first
/// envelope, `>From ` and a bare `From ` inside a body, a header section past
/// the 128 KiB a vault header read covers, a label in Latin-1 bytes, labels
/// given twice, and a last message the file cuts off mid-line. The file, and
/// each message as the vault must keep it.
fn messy() -> (Vec<u8>, Vec<Vec<u8>>) {
    let mut messages: Vec<Vec<u8>> = vec![
        format!(
            "Message-ID: <esc@x>\r\nSubject: escaped\r\nDate: {DATE}\r\n\r\nline one\r\n>From the start of a line, escaped\r\nFrom mid-body, no blank line before it\r\nlast line"
        )
        .into_bytes(),
        format!("X-Filler: {}\r\nMessage-ID: <huge@x>\r\nSubject: huge header\r\nDate: {DATE}\r\n\r\nbody of the huge one", "f".repeat(200 * 1024)).into_bytes(),
        [&b"X-Gmail-Labels: Caf\xE9,Opened\r\n"[..], format!("Message-ID: <latin@x>\r\nSubject: latin label\r\nDate: {DATE}\r\n\r\nbody of latin").as_bytes()]
            .concat(),
        format!("X-Gmail-Labels: Work,Work,work,Opened,Opened\r\nMessage-ID: <dup@x>\r\nSubject: duplicate labels\r\nDate: {DATE}\r\n\r\nbody of dup")
            .into_bytes(),
    ];
    let cut = format!("Message-ID: <cut@x>\r\nSubject: truncated\r\nDate: {DATE}\r\n\r\nthe file ends in the middle of this sen").into_bytes();
    let mut file = b"junk before any envelope\n\n".to_vec();
    file.extend(mbox_bytes(&messages));
    file.extend_from_slice(b"From x@y Mon Jan  1 00:00:00 2026\n");
    file.extend_from_slice(&cut);
    messages.push(cut);
    (file, messages.iter().map(|m| crate::mbox::mbox_unescape_from(m)).collect())
}

/// Copies on the server, in any folder, of the message with this Message-ID.
fn server_copies(rig: &Rig, id: &str) -> usize {
    let needle = format!("Message-ID: <{id}>");
    rig.server.state().mailboxes.iter().flat_map(|m| &m.messages).filter(|m| m.raw.windows(needle.len()).any(|w| w == needle.as_bytes())).count()
}

/// The messy file through every mode: the same five messages, each kept
/// whole and once, nothing else written, no panic. Mode 2 routes by label
/// into acct2's folders, mode 3 into a folder of acct3's own, mode 1 uploads
/// acct1's (the fallback is All Mail).
#[tokio::test]
async fn a_malformed_file_imports_the_same_whole_messages_in_every_mode() {
    let mut rig = setup(gmail(), fast());
    let (bytes, stored) = messy();
    let escaped = String::from_utf8_lossy(&stored[0]);
    assert!(escaped.contains("\r\nFrom the start of a line, escaped\r\n") && !escaped.contains(">From"), "`>From ` is unescaped: {escaped}");
    assert!(escaped.contains("\r\nFrom mid-body, no blank line before it\r\nlast line"), "a `From ` with no blank line before it is body: {escaped}");
    let file = rig.files.path().join("messy.mbox");
    std::fs::write(&file, &bytes).unwrap();
    let n = stored.len() as u64;

    save_listing(&rig.s, "acct2", &["INBOX", "Work"]);
    let r2 = import_local(&rig, "acct2", &file, "INBOX", true).await;
    assert_eq!((r2["emailCount"].clone(), r2["skippedCount"].clone()), (json!(n), json!(0)), "mode 2: {r2}");
    let r3 = import_folder(&rig, "acct3", &file).await;
    assert_eq!((r3["emailCount"].clone(), r3["skippedCount"].clone()), (json!(n), json!(0)), "mode 3: {r3}");
    let r1 = upload(&mut rig, &file, true).await;
    assert_eq!(counts(&r1), (json!(DONE), json!(n), json!(0), json!(0)), "mode 1: {r1}");

    // Each mode's vault holds each message whole, once, and nothing else.
    for (account, mode) in [("acct2", "mode 2"), ("acct3", "mode 3"), ("acct1", "mode 1")] {
        let dir = account_dir(&rig, account);
        assert_no_garbage(&dir);
        assert_eq!(prints(cur_files(&dir).into_iter().map(|f| f.2)), prints(stored.clone()), "{mode}: every message whole, once");
    }
    // Labels given twice file the message once, in its folder.
    let dup_in: Vec<String> = cur_files(&account_dir(&rig, "acct2")).into_iter().filter(|f| f.2 == stored[3]).map(|f| f.0).collect();
    assert_eq!(dup_in, ["Work"]);
    assert_eq!(subjects(&rig.server, "Work"), ["duplicate labels"]);

    // On the server: each message once; the Latin-1 label made as a 7-bit name.
    for id in ["esc@x", "huge@x", "latin@x", "dup@x", "cut@x"] {
        assert_eq!(server_copies(&rig, id), 1, "<{id}> on the server");
    }
    let creates: Vec<String> = rig.server.commands().into_iter().filter(|c| c.split_whitespace().nth(1).is_some_and(|w| w.eq_ignore_ascii_case("CREATE"))).collect();
    assert!(!creates.is_empty(), "the label with no folder is made on the server (R6)");
    for c in &creates {
        assert!(c.is_ascii() && !c.chars().any(char::is_control), "sent raw: {c:?}");
    }
}

/// A 0-byte file, and one message saved without its mbox envelope (an .eml
/// picked as an mbox): neither holds a message, so every mode answers with
/// nothing imported and writes no message file. Mode 3 may keep the folder
/// it made; if so, it lists, so the user can see and delete it.
#[tokio::test]
async fn an_empty_file_or_one_without_an_envelope_imports_nothing_in_every_mode() {
    let mut rig = setup(gmail(), fast());
    let empty = rig.files.path().join("empty.mbox");
    std::fs::write(&empty, b"").unwrap();
    let bare = rig.files.path().join("bare.mbox");
    std::fs::write(&bare, msg("solo@x", "no envelope")).unwrap();

    for (i, file) in [empty, bare].iter().enumerate() {
        let (local, apart) = (format!("local{i}"), format!("apart{i}"));
        let r2 = import_local(&rig, &local, file, "INBOX", false).await;
        assert_eq!((r2["emailCount"].clone(), r2["skippedCount"].clone()), (json!(0), json!(0)), "{file:?}: {r2}");
        assert!(cur_files(&account_dir(&rig, &local)).is_empty(), "{file:?}");

        let r3 = import_folder(&rig, &apart, file).await;
        assert_eq!(r3["emailCount"], json!(0), "{file:?}: {r3}");
        let dir = account_dir(&rig, &apart);
        assert!(cur_files(&dir).is_empty(), "{file:?}");
        let listed: BTreeSet<String> = local_folders(&rig, &apart).await.as_array().unwrap().iter().filter_map(|f| f["dir"].as_str().map(String::from)).collect();
        let present: BTreeSet<String> = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(present.is_subset(&listed), "{file:?}: every folder left behind lists: {present:?} against {listed:?}");

        let last = upload(&mut rig, file, false).await;
        assert_eq!(counts(&last), (json!(DONE), json!(0), json!(0), json!(0)), "{file:?}: {last}");
    }
    assert_eq!(rig.server.count_commands("APPEND"), 0);
    assert!(cur_files(&account_dir(&rig, "acct1")).is_empty());
    assert!(list_journals(&rig.s.app_dir).is_empty(), "nothing left to resume");
}

// ---- 5. the foreground while an upload runs ----

/// While an upload waits on the server (every APPEND held up), the user's own
/// reads, lists and flag changes on the account's other folders (a mode 2
/// folder and a mode 3 folder) do not wait for it: each one returns while the
/// job still runs.
#[tokio::test]
async fn reads_lists_and_flags_on_other_folders_answer_while_an_upload_runs() {
    let mut rig = setup(slow_appends(1500), fast());
    let other = mbox(&rig, &[msg("w@x", "elsewhere")]);
    assert_eq!(import_local(&rig, "acct1", &other, "Work", false).await["emailCount"], json!(1));
    let made = import_folder(&rig, "acct1", &other).await;
    let local = made["folder"]["name"].as_str().expect("a folder of its own").to_string();
    let b = IMPORT_UID_BASE;

    let messages: Vec<Vec<u8>> = (1..=4).map(|i| msg(&format!("q{i}@x"), &format!("q{i}"))).collect();
    let file = mbox(&rig, &messages);
    let job = start(&rig, &file, false).await;
    wait_until_uploaded(&rig, &job, 1).await;

    let at = |mailbox: &str| json!({"accountId": "acct1", "mailbox": mailbox, "uid": b});
    let flag = |mailbox: &str, flags: &[&str]| json!({"accountId": "acct1", "mailbox": mailbox, "uid": b, "flags": flags});
    let asks = [
        ("list_local_folders", json!({"accountId": "acct1"})),
        ("vault_light_rows", json!({"accountId": "acct1", "mailbox": "Work"})),
        ("maildir_read_light", at("Work")),
        ("maildir_set_flags", flag("Work", &["archived", "seen", "flagged"])),
        ("vault_light_rows", json!({"accountId": "acct1", "mailbox": local})),
        ("maildir_read_light", at(&local)),
        ("maildir_set_flags", flag(&local, &["archived", "seen"])),
    ];
    for (method, params) in asks {
        let answer = call(&rig.s, method, params.clone()).await;
        assert!(answer.error.is_none(), "{method} {params}: {:?}", answer.error);
        if method != "maildir_set_flags" {
            assert!(answer.result.as_ref().is_some_and(|v| !v.is_null()), "{method} {params} found nothing");
        }
        assert_eq!(status_of(&rig, &job).await["live"], json!(true), "{method} {params} answered only once the upload was over");
    }
    let work = ok(call(&rig.s, "vault_light_rows", json!({"accountId": "acct1", "mailbox": "Work"})).await);
    assert!(work[0]["flags"].as_array().is_some_and(|f| f.contains(&json!("\\Flagged"))), "the flag landed: {work}");

    control(&rig, "mbox_upload_cancel", &job).await;
    assert_eq!(job_done(&mut rig, &job).await["state"], json!(CANCELLED));
}

// ---- 6. account isolation ----

/// Every mode writes into its own account only, and reads only its own.
/// Account B holds a server copy, an import copy, a local folder, a folder
/// list, and header rows that list the very messages A imports: none of it
/// is touched, and A imports everything (B's rows never count as A's).
#[tokio::test]
async fn importing_into_one_account_never_reads_or_writes_another() {
    let mut rig = setup(gmail(), fast());
    let other = "acct-b";
    let inbox = vault_files::cur_path(rig._vault.path(), other, "INBOX");
    std::fs::create_dir_all(&inbox).unwrap();
    std::fs::write(inbox.join("1:2,S.eml"), msg("old@x", "old one")).unwrap();
    std::fs::write(inbox.join(vault_files::build_maildir_filename(IMPORT_UID_BASE, &["archived".to_string()])), msg("a@x", "one")).unwrap();
    let marker = local_folder::Marker { kind: local_folder::KIND_IMPORT.into(), name: "MBOX import 2020-01-01".into(), created: 1, source: "old.mbox".into() };
    let theirs = account_dir(&rig, other).join("MBOX_import_2020-01-01");
    std::fs::create_dir_all(theirs.join("cur")).unwrap();
    std::fs::write(theirs.join("cur").join(vault_files::build_maildir_filename(IMPORT_UID_BASE, &["archived".to_string()])), msg("z@x", "theirs")).unwrap();
    local_folder::write_marker(&theirs, &marker).unwrap();
    save_listing(&rig.s, other, &["INBOX", "Work"]);
    let rows = json!({"uidValidity": 1, "totalEmails": 2, "emails": [
        {"uid": 1, "messageId": "<a@x>", "subject": "one", "messageDate": DATE},
        {"uid": 2, "messageId": "<b@x>", "subject": "two", "messageDate": DATE},
    ]});
    for mailbox in ["INBOX", "Work"] {
        save_headers(&rig.s, other, mailbox, &rows);
    }
    let headers = |s: &Arc<DaemonState>| -> Vec<Vec<Value>> {
        ["INBOX", "Work"].iter().map(|m| crate::custody::with_conn(s, |c| cache::all_headers(c, other, m)).unwrap()).collect()
    };
    let (b_tree, b_headers, b_folders) = (tree(&account_dir(&rig, other)), headers(&rig.s), local_folders(&rig, other).await);

    save_listing(&rig.s, "acct1", &["INBOX", "Work"]);
    let file = mbox(&rig, &[labelled("a@x", "one", "Inbox,Opened"), labelled("b@x", "two", "Work,Opened")]);
    let r2 = import_local(&rig, "acct1", &file, "INBOX", true).await;
    assert_eq!((r2["emailCount"].clone(), r2["skippedCount"].clone()), (json!(2), json!(0)), "B's header rows are not A's: {r2}");
    let r3 = import_folder(&rig, "acct1", &file).await;
    assert_eq!(r3["emailCount"], json!(2));
    let r1 = upload(&mut rig, &file, true).await;
    assert_eq!(counts(&r1), (json!(DONE), json!(2), json!(0), json!(0)), "{r1}");

    assert_eq!(tree(&account_dir(&rig, other)), b_tree, "B's vault is as it was");
    assert_eq!(headers(&rig.s), b_headers, "B's header rows are as they were");
    assert_eq!(local_folders(&rig, other).await, b_folders);
    let ours: Vec<Value> = local_folders(&rig, "acct1").await.as_array().unwrap().iter().map(|f| f["dir"].clone()).collect();
    assert_eq!(ours, [r3["folder"]["dir"].clone()], "A lists its own folder only");
}

/// Two Outlook (Graph) accounts keep their Sent folder under different
/// storage keys. An import into A files under A's key, from A's folder list
/// and A's header rows: never under B's key, the display name, or B's dir,
/// though B's header rows list the message under both keys.
#[tokio::test]
async fn a_graph_import_files_under_its_own_accounts_storage_keys() {
    let rig = setup(gmail(), fast());
    let g = |name: &str, path: &str, special: &str| {
        json!({"name": name, "path": path, "specialUse": special, "flags": [], "delimiter": "/", "noselect": false, "children": [], "_graphFolderId": "AAMk"})
    };
    for (account, key) in [("graph-a", "SentKeyA"), ("graph-b", "SentKeyB")] {
        let listing = json!({"mailboxes": [g("INBOX", "INBOX", "\\Inbox"), g("Gesendet", key, "\\Sent"), g("Archiv", "Archive", "\\Archive")]});
        crate::custody::with_conn(&rig.s, |c| cache::save_mailboxes(c, account, &listing.to_string())).unwrap();
    }
    let rows = json!({"uidValidity": 1, "totalEmails": 1, "emails": [{"uid": 7, "messageId": "<sent@x>", "subject": "sent one", "messageDate": DATE}]});
    for key in ["SentKeyA", "SentKeyB"] {
        save_headers(&rig.s, "graph-b", key, &rows);
    }

    let file = mbox(&rig, &[labelled("sent@x", "sent one", "Sent,Opened"), labelled("p@x", "plain", "Opened")]);
    let r = import_local(&rig, "graph-a", &file, "Archive", true).await;
    assert_eq!(r["folders"], json!([{"mailbox": "SentKeyA", "imported": 1, "skipped": 0}, {"mailbox": "Archive", "imported": 1, "skipped": 0}]), "{r}");
    let dirs: BTreeSet<String> = cur_files(&account_dir(&rig, "graph-a")).into_iter().map(|f| f.0).collect();
    assert_eq!(dirs, ["Archive", "SentKeyA"].into_iter().map(String::from).collect::<BTreeSet<String>>(), "never SentKeyB or Gesendet");
    assert_eq!(import_folder(&rig, "graph-a", &file).await["emailCount"], json!(2));
    assert!(!account_dir(&rig, "graph-b").exists(), "nothing of A's lands in B's dir");
    assert_eq!(local_folders(&rig, "graph-b").await, json!([]));
}

/// Account ids and folder names a file or a server can hand the import:
/// `..`, `.`, `../x`, a NUL, Windows device names, one past any file name
/// limit. Modes 2 and 3 take or refuse each one (a name no file system holds
/// is refused), and nothing is ever written outside `Maildir/`. The vault
/// sits inside a scratch dir so a write that climbs out shows.
#[tokio::test]
async fn hostile_account_ids_and_folder_names_stay_inside_the_maildir_tree() {
    let scratch = tempfile::tempdir().unwrap();
    let (vault, app) = (scratch.path().join("vault"), scratch.path().join("app"));
    for dir in [&vault, &app] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let s = DaemonState::for_test(vault.clone(), app.clone(), true);
    let long = "x".repeat(300);

    // Folder names in the cached list, each the home of one message by its
    // label; the one no file system takes goes last.
    let names = ["..", ".", "../Escape", "a/../../b", "CON", "NUL.txt", long.as_str()];
    let listed: Vec<&str> = std::iter::once("INBOX").chain(names).collect();
    save_listing(&s, "acct1", &listed);
    let by_label = scratch.path().join("labels.mbox");
    let messages: Vec<Vec<u8>> = names.iter().enumerate().map(|(i, label)| labelled(&format!("n{i}@x"), &format!("n{i}"), label)).collect();
    std::fs::write(&by_label, mbox_bytes(&messages)).unwrap();
    let plain = scratch.path().join("plain.mbox");
    std::fs::write(&plain, mbox_bytes(&[msg("h@x", "hostile")])).unwrap();
    let before: BTreeSet<PathBuf> = tree(scratch.path()).into_keys().collect();

    let params = json!({"sourcePath": by_label.to_string_lossy(), "accountId": "acct1", "mode": "local", "mailbox": "INBOX", "useLabels": true});
    let r = ok(call(&s, "import_mbox", params).await);
    assert_eq!(r["emailCount"], json!(names.len() - 1), "every folder a file system holds took its message: {r}");

    let ids = ["..", ".", "../escape", "../../escape", "a/../../escape", "a\u{0}b", "CON", "NUL", "aux.txt", "COM1", long.as_str()];
    for id in ids {
        for mode in ["local", "folder"] {
            let resp = call(&s, "import_mbox", json!({"sourcePath": plain.to_string_lossy(), "accountId": id, "mode": mode, "mailbox": "INBOX"})).await;
            // Taken or refused, either is fine: what counts is where it wrote.
            if let Some(result) = resp.result {
                assert_eq!(result["emailCount"], json!(1), "{id:?} {mode}: {result}");
            }
        }
    }

    let maildir = vault.join("Maildir");
    let store = mailvault_core::custody::db::db_path(&vault).parent().unwrap().to_path_buf();
    for path in tree(scratch.path()).into_keys().filter(|p| !before.contains(p)) {
        assert!(path.starts_with(&maildir) || path.starts_with(&store) || path.starts_with(&app), "{path:?} was written outside the Maildir tree");
    }
    for escaped in [scratch.path().join("escape"), vault.join("escape"), vault.join("Escape"), vault.join("b"), scratch.path().join("b")] {
        assert!(!escaped.exists(), "{escaped:?}");
    }
}

/// Mode 1 with labels a Takeout can carry (`../..`, `..`, `.`, a Windows
/// device name, a NUL): every folder is made under a 7-bit name, and every
/// vault copy lands inside `Maildir/`. An account id that is not one plain
/// name never starts a job at all.
#[tokio::test]
async fn an_upload_keeps_hostile_labels_and_account_ids_inside_the_maildir_tree() {
    let mut rig = setup(gmail(), fast());
    let plain = mbox(&rig, &[msg("h@x", "hostile")]);
    for id in [".", "..", "a/b", "a\u{0}b", "../escape"] {
        let resp = call(&rig.s, "import_mbox", json!({"sourcePath": plain.to_string_lossy(), "accountId": id, "mode": "server"})).await;
        assert_eq!(resp.error.map(|e| e.code), Some(ipc::INVALID_PARAMS), "{id:?}");
    }
    assert!(list_journals(&rig.s.app_dir).is_empty(), "no job was started");

    let escape = format!("escape-{}", uuid::Uuid::new_v4());
    let labels = [format!("../../{escape}"), "..".to_string(), ".".to_string(), "CON".to_string(), "a\u{0}b".to_string()];
    let messages: Vec<Vec<u8>> = labels.iter().enumerate().map(|(i, l)| labelled(&format!("h{i}@x"), &format!("h{i}"), l)).collect();
    let file = mbox(&rig, &messages);
    let vault = rig._vault.path().to_path_buf();
    let before: BTreeSet<PathBuf> = tree(&vault).into_keys().collect();

    let last = upload(&mut rig, &file, true).await;
    let settled = last["uploadedCount"].as_u64().unwrap_or(0) + last["failedCount"].as_u64().unwrap_or(0);
    assert_eq!((last["state"].clone(), settled), (json!(DONE), labels.len() as u64), "{last}");

    let creates: Vec<String> = rig.server.commands().into_iter().filter(|c| c.split_whitespace().nth(1).is_some_and(|w| w.eq_ignore_ascii_case("CREATE"))).collect();
    assert!(!creates.is_empty());
    for c in &creates {
        assert!(c.is_ascii() && !c.chars().any(char::is_control), "sent raw: {c:?}");
    }
    let maildir = vault.join("Maildir");
    let store = mailvault_core::custody::db::db_path(&vault).parent().unwrap().to_path_buf();
    for path in tree(&vault).into_keys().filter(|p| !before.contains(p)) {
        assert!(path.starts_with(&maildir) || path.starts_with(&store), "{path:?} was written outside the Maildir tree");
    }
    assert!(!vault.join(&escape).exists() && !vault.parent().unwrap().join(&escape).exists());
}
