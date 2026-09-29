//! Old mbox imports moved out of the server's uid range.
//!
//! Before imports got a range of their own (`maildir::IMPORT_UID_BASE`), mbox
//! import numbered its messages from `max local uid + 1`: uids the server has
//! or will give its own mail. Such a file sits at `cur/<U>:2,A…` and hides the
//! server's message U three ways: the list shows the server row and drops the
//! import, the cache believes U is already stored, and backup counts U as
//! backed up. A folder's pass sorts every archived file at a server uid:
//!
//! - its Message-ID is the one the server lists under U: a real copy, left;
//! - the server does not list it at all: moved into the import range;
//! - the server lists it under another uid V (a copy of server mail the old
//!   importer brought in): set aside in `orphaned/` when it is the same
//!   message as V (`same_message`), else moved into the import range. An
//!   Outlook (Graph) folder leaves it where it is.
//!
//! Nothing is deleted. Every move and set-aside goes into the folder's ledger,
//! which `replay` applies to the backup folder too: the backup's pre-sync copies
//! by uid in both directions, and would otherwise put U straight back.

use crate::maildir::{self, IMPORT_UID_BASE, ORPHAN_DIR};
use crate::pgp::DECRYPTED_DIR;
use mailparse::MailHeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

/// Beside `cur/`: every move and set-aside a pass made, cumulative.
pub const LEDGER_FILE: &str = ".import-rehome.json";
/// Beside `cur/`: a full pass ran on this folder. Written by the caller.
pub const DONE_FILE: &str = ".import-rehome-done";

/// Below this many compared files the fence never trips: too few to tell.
const FENCE_MIN: u32 = 10;

/// What the same-message rule reads of one message's header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    /// Normalized, as `maildir::read_message_id` gives it.
    pub id: Option<String>,
    /// Decoded, whitespace runs squashed to one space.
    pub subject: String,
    pub date_secs: Option<i64>,
}

/// The header of a message in memory. `raw` may be the whole message.
pub fn head_of(raw: &[u8]) -> Head {
    let (subject, date_secs) = match mailparse::parse_headers(maildir::header_section(raw)) {
        Ok((headers, _)) => (
            headers.get_first_value("Subject").unwrap_or_default(),
            headers.get_first_value("Date").and_then(|d| maildir::header_date_secs(&d)),
        ),
        Err(_) => (String::new(), None),
    };
    Head { id: maildir::message_id_in(raw), subject: squash(&subject), date_secs }
}

/// `head_of` a vault file, from its first 128 KiB.
pub fn read_head(path: &Path) -> Option<Head> {
    Some(head_of(maildir::read_header_text(path)?.as_bytes()))
}

/// The content the rule compares: the bytes after the header section, CRLF
/// read as LF, trailing whitespace dropped.
pub fn body_of(raw: &[u8]) -> Vec<u8> {
    let rest = &raw[maildir::header_section(raw).len()..];
    let mut out = Vec::with_capacity(rest.len());
    for (i, &b) in rest.iter().enumerate() {
        if b == b'\r' && rest.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(b);
    }
    while out.last().is_some_and(u8::is_ascii_whitespace) {
        out.pop();
    }
    out
}

/// Whether the vault file at `copy` is the message `head`/`body` describe:
/// same Message-ID, same Subject, same content. Never the whole file: headers
/// differ between two copies of one message (Takeout adds X-GM-THRID and
/// X-Gmail-Labels).
pub fn same_as_copy(head: &Head, body: &[u8], copy: &Path) -> bool {
    head.id.is_some()
        && read_head(copy).is_some_and(|c| c.id == head.id && c.subject == head.subject)
        && fs::read(copy).is_ok_and(|raw| body_of(&raw) == body)
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

struct ServerRow {
    message_id: String,
    subject: String,
    date_secs: Option<i64>,
}

/// What the header cache says the server holds in one folder.
#[derive(Default)]
pub struct ServerView {
    by_uid: HashMap<u32, ServerRow>,
    by_id: HashMap<String, u32>,
    /// Subject and Date of the dated rows with no Message-ID: all a message
    /// without one (a Takeout chat or draft) can be matched by. Kept apart so
    /// the rehome plan, which keys files by the server's id, never sees them.
    no_id: HashSet<(String, i64)>,
}

impl ServerView {
    /// From the header cache's rows (`custody::cache::all_headers`). A row
    /// without a uid says nothing here and is skipped; one without a
    /// Message-ID counts only for a message without one.
    pub fn from_headers(rows: &[Value]) -> Self {
        let mut view = Self::default();
        for row in rows {
            let text = |k: &str| row.get(k).and_then(Value::as_str);
            let Some(uid) = row.get("uid").and_then(Value::as_u64).and_then(|u| u32::try_from(u).ok()) else { continue };
            // Rows written by the frontend carry `messageId`; ones serialized
            // from `EmailHeader` carry `message_id`.
            let id = maildir::normalize_message_id(text("messageId").or_else(|| text("message_id")).unwrap_or(""));
            // `messageDate` is the Date header; a row without one has it in `date`.
            let date_secs = text("messageDate").or_else(|| text("date")).and_then(maildir::header_date_secs);
            let subject = squash(text("subject").unwrap_or(""));
            if id.is_empty() {
                if let Some(date) = date_secs {
                    view.no_id.insert((subject, date));
                }
                continue;
            }
            view.by_id.insert(id.clone(), uid);
            view.by_uid.insert(uid, ServerRow { message_id: id, subject, date_secs });
        }
        view
    }

    /// Whether the server lists a message with `head`'s Message-ID, Subject
    /// and Date: the same-message rule when only its header is known. A
    /// message with no Message-ID matches a dated row with none, by Subject
    /// and Date alone.
    pub fn lists_same(&self, head: &Head) -> bool {
        match &head.id {
            Some(id) => self.by_id.get(id).is_some_and(|v| self.row_matches(*v, head)),
            None => head.date_secs.is_some_and(|date| self.no_id.contains(&(head.subject.clone(), date))),
        }
    }

    /// Count a message the caller just put on the server, under `uid` when the
    /// server said which, so the same message later in one run reads as there.
    /// False when it cannot be placed (a Message-ID with no uid): the caller
    /// then asks the server instead.
    pub fn add(&mut self, uid: Option<u32>, head: &Head) -> bool {
        match (&head.id, uid) {
            (Some(id), Some(uid)) => {
                self.by_id.insert(id.clone(), uid);
                self.by_uid.insert(uid, ServerRow { message_id: id.clone(), subject: head.subject.clone(), date_secs: head.date_secs });
                true
            }
            (Some(_), None) => false,
            (None, _) => {
                if let Some(date) = head.date_secs {
                    self.no_id.insert((head.subject.clone(), date));
                }
                true
            }
        }
    }

    fn row_matches(&self, uid: u32, head: &Head) -> bool {
        self.by_uid.get(&uid).is_some_and(|row| {
            head.id.as_deref() == Some(row.message_id.as_str())
                && row.subject == head.subject
                && head.date_secs.is_some()
                && row.date_secs == head.date_secs
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    /// The file's exact name in `cur/`.
    pub name: String,
    pub uid: u32,
    pub message_id: String,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub to_import: Vec<Planned>,
    pub set_aside: Vec<Planned>,
    /// Archived files at a uid the server lists, whose Message-ID was compared.
    pub compared: u32,
    /// Of those, the ones whose Message-ID is not the server's at their uid.
    pub mismatched: u32,
    /// The fence tripped and nothing is planned; the caller warns.
    pub suspicious: bool,
}

/// What a pass would do to `<mailbox_dir>/cur`. Reads only, so it runs
/// outside the mailbox lock; `apply` re-checks every name it acts on.
///
/// Only archived files below the import range at a uid the server lists are
/// read, one bounded header read each. `protected` holds uids of mail composed
/// here, never the importer's.
///
/// The fence: a normalization bug on either side would read every file as
/// "not the server's" and move a whole vault. That bug has one signature, no
/// file's Message-ID found anywhere on the server, so with at least
/// `FENCE_MIN` files compared and not one of them confirmed (listed at its
/// own uid or under another), nothing is planned. A folder full of old
/// imports still confirms through its real copies, or through imports of
/// mail the server holds under another uid.
pub fn plan(mailbox_dir: &Path, server: &ServerView, is_graph: bool, protected: &HashSet<u32>) -> Plan {
    let mut plan = Plan::default();
    let files = maildir::uid_file_map(&mailbox_dir.join("cur"));
    let mut uids: Vec<u32> = files.keys().copied().filter(|u| *u < IMPORT_UID_BASE && !protected.contains(u)).collect();
    uids.sort_unstable();
    let mut confirmed = 0u32;
    for uid in uids {
        let path = &files[&uid];
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !maildir::carries_archived(&name) {
            continue;
        }
        let Some(row) = server.by_uid.get(&uid) else { continue };
        let Some(head) = read_head(path) else { continue };
        let Some(id) = head.id.clone() else { continue };
        plan.compared += 1;
        let listed_at = server.by_id.get(&id).copied();
        if id == row.message_id || listed_at == Some(uid) {
            confirmed += 1;
            continue;
        }
        plan.mismatched += 1;
        let planned = Planned { name, uid, message_id: id };
        match listed_at {
            None => plan.to_import.push(planned),
            Some(v) => {
                confirmed += 1;
                if is_graph {
                    continue;
                }
                if same_message(path, &head, v, server, &files) {
                    plan.set_aside.push(planned);
                } else {
                    plan.to_import.push(planned);
                }
            }
        }
    }
    if plan.compared >= FENCE_MIN && confirmed == 0 {
        plan.to_import.clear();
        plan.set_aside.clear();
        plan.suspicious = true;
    }
    plan
}

/// Whether the file at `path` is the message the server lists under `v`:
/// same Message-ID (the caller's lookup), same Subject, same content. The
/// content is compared with the vault's own copy at `v` when it holds one
/// with that Message-ID.
///
/// Without such a copy only the server's header is known, so Subject and
/// Date stand in for the content: two messages sharing a Message-ID, a
/// Subject and a Date but not a body read as the same one. Telling them apart
/// would take downloading V.
fn same_message(path: &Path, head: &Head, v: u32, server: &ServerView, files: &HashMap<u32, PathBuf>) -> bool {
    if let Some(copy) = files.get(&v).filter(|c| read_head(c).is_some_and(|c| c.id == head.id)) {
        return fs::read(path).is_ok_and(|raw| same_as_copy(head, &body_of(&raw), copy));
    }
    server.row_matches(v, head)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// `(from, to)`: files moved into the import range.
    pub moved: Vec<(u32, u32)>,
    /// Uids set aside in `orphaned/`.
    pub set_aside: Vec<u32>,
    /// Planned names gone by the time the lock was held: not a full pass.
    pub skipped: u32,
    pub errors: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LedgerEntry {
    from: u32,
    /// `None`: set aside.
    to: Option<u32>,
    #[serde(rename = "messageId")]
    message_id: String,
}

/// No ledger reads as empty; one that cannot be parsed is an error, so a pass
/// never writes a new one over entries it could not read.
fn read_ledger(mailbox_dir: &Path) -> Result<Vec<LedgerEntry>, String> {
    match fs::read(mailbox_dir.join(LEDGER_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{LEDGER_FILE} unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{LEDGER_FILE} unreadable: {e}")),
    }
}

/// Carry out `plan` on `<mailbox_dir>/cur`. The caller holds the mailbox lock.
/// A planned name that is gone (renamed, deleted since the plan) is skipped.
/// A move takes the next uid of the import range this folder has not used,
/// in `cur/` or in the ledger, and keeps the file's flags.
///
/// The ledger is written before any rename: a pass cut short leaves entries
/// whose files never moved, which `replay` then completes.
pub fn apply(mailbox_dir: &Path, plan: &Plan) -> Result<Report, String> {
    let mut report = Report::default();
    let cur = mailbox_dir.join("cur");
    let still_there = |p: &&Planned| cur.join(&p.name).is_file();
    let moves: Vec<&Planned> = plan.to_import.iter().filter(still_there).collect();
    let asides: Vec<&Planned> = plan.set_aside.iter().filter(still_there).collect();
    report.skipped = (plan.to_import.len() + plan.set_aside.len() - moves.len() - asides.len()) as u32;
    if moves.is_empty() && asides.is_empty() {
        return Ok(report);
    }
    let mut ledger = read_ledger(mailbox_dir)?;
    let mut next = next_import_uid(&cur, &ledger);
    let mut targets = Vec::with_capacity(moves.len());
    for p in &moves {
        let to = next.ok_or("The import uid range is full")?;
        next = to.checked_add(1);
        targets.push(to);
        ledger.push(LedgerEntry { from: p.uid, to: Some(to), message_id: p.message_id.clone() });
    }
    ledger.extend(asides.iter().map(|p| LedgerEntry { from: p.uid, to: None, message_id: p.message_id.clone() }));
    let json = serde_json::to_vec(&ledger).map_err(|e| e.to_string())?;
    crate::fsx::write_atomic(&mailbox_dir.join(LEDGER_FILE), &json).map_err(|e| format!("Failed to write {LEDGER_FILE}: {e}"))?;

    for (p, to) in moves.into_iter().zip(targets) {
        match fs::rename(cur.join(&p.name), cur.join(maildir::with_uid(&p.name, to))) {
            Ok(()) => {
                move_decrypted(mailbox_dir, p.uid, Some(to));
                report.moved.push((p.uid, to));
            }
            Err(e) => {
                warn!("import_rehome: move {} failed: {}", p.name, e);
                report.errors += 1;
            }
        }
    }
    for p in asides {
        match set_aside(mailbox_dir, &cur.join(&p.name), &p.name) {
            Ok(()) => {
                move_decrypted(mailbox_dir, p.uid, None);
                report.set_aside.push(p.uid);
            }
            Err(e) => {
                warn!("import_rehome: set aside {} failed: {}", p.name, e);
                report.errors += 1;
            }
        }
    }
    Ok(report)
}

/// One past every import-range uid in `cur/` and in the ledger, or the base.
/// `None` once the range is full.
fn next_import_uid(cur: &Path, ledger: &[LedgerEntry]) -> Option<u32> {
    let in_cur = fs::read_dir(cur)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| maildir::vault_filename_uid(&e.file_name().to_string_lossy()));
    in_cur
        .chain(ledger.iter().filter_map(|e| e.to))
        .filter(|u| *u >= IMPORT_UID_BASE)
        .max()
        .map_or(Some(IMPORT_UID_BASE), |m| m.checked_add(1))
}

fn set_aside(mailbox_dir: &Path, path: &Path, name: &str) -> Result<(), String> {
    let orphan_dir = mailbox_dir.join(ORPHAN_DIR);
    fs::create_dir_all(&orphan_dir).map_err(|e| e.to_string())?;
    fs::rename(path, maildir::free_orphan_path(&orphan_dir, name)).map_err(|e| e.to_string())
}

/// An OpenPGP message's decrypted copy follows its file: renamed with a move,
/// into `orphaned/.decrypted/` with a set-aside. Left behind, it would open as
/// the body of whatever message lands on the old uid next.
fn move_decrypted(mailbox_dir: &Path, from: u32, to: Option<u32>) {
    let dir = mailbox_dir.join(DECRYPTED_DIR);
    let src = dir.join(format!("{from}.eml"));
    if !src.exists() {
        return;
    }
    let dst = match to {
        Some(to) => dir.join(format!("{to}.eml")),
        None => {
            let aside = mailbox_dir.join(ORPHAN_DIR).join(DECRYPTED_DIR);
            if let Err(e) = fs::create_dir_all(&aside) {
                warn!("import_rehome: {:?}: {}", aside, e);
                return;
            }
            maildir::free_orphan_path(&aside, &format!("{from}.eml"))
        }
    };
    if let Err(e) = fs::rename(&src, &dst) {
        warn!("import_rehome: {:?} -> {:?}: {}", src, dst, e);
    }
}

/// Apply the vault folder's ledger to both copies of the folder, the vault's
/// and the backup folder's: a file at an entry's `from` that still carries its
/// Message-ID moves to `to` when that uid is free there, else is set aside.
/// The backup's pre-sync copies by uid both ways outside the mailbox lock, so
/// a folder the vault already re-homed gets U back from the backup folder
/// unless this runs first. Returns whether it changed the vault's `cur/`.
///
/// Costs a missing-file open when the folder has no ledger, and one header
/// read per entry whose `from` a side still holds.
pub fn replay(vault_mailbox_dir: &Path, mirror_mailbox_dir: &Path) -> bool {
    let ledger = match read_ledger(vault_mailbox_dir) {
        Ok(ledger) if !ledger.is_empty() => ledger,
        Ok(_) => return false,
        Err(e) => {
            warn!("import_rehome: replay skipped for {:?}: {}", vault_mailbox_dir, e);
            return false;
        }
    };
    let vault_touched = replay_into(vault_mailbox_dir, maildir::uid_file_map(&vault_mailbox_dir.join("cur")), &ledger);
    replay_into(mirror_mailbox_dir, maildir::mirror_file_map(&mirror_mailbox_dir.join("cur")), &ledger);
    vault_touched
}

fn replay_into(mailbox_dir: &Path, mut files: HashMap<u32, PathBuf>, ledger: &[LedgerEntry]) -> bool {
    let cur = mailbox_dir.join("cur");
    let mut changed = false;
    for entry in ledger {
        let Some(path) = files.get(&entry.from).cloned() else { continue };
        if maildir::read_message_id(&path).as_deref() != Some(entry.message_id.as_str()) {
            continue;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // The uid is the name's leading digits under either side's rule.
        let target = entry
            .to
            .filter(|to| !files.contains_key(to))
            .and_then(|to| name.strip_prefix(&entry.from.to_string()).map(|rest| (to, cur.join(format!("{to}{rest}")))));
        let result = match &target {
            Some((_, dst)) => fs::rename(&path, dst).map_err(|e| e.to_string()),
            None => set_aside(mailbox_dir, &path, &name),
        };
        match result {
            Ok(()) => {
                files.remove(&entry.from);
                let to = target.map(|(to, dst)| {
                    files.insert(to, dst);
                    to
                });
                move_decrypted(mailbox_dir, entry.from, to);
                changed = true;
            }
            Err(e) => warn!("import_rehome: replay of {:?} failed: {}", path, e),
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maildir::INFO_PREFIX;
    use serde_json::json;

    const DATE: &str = "Mon, 1 Jan 2024 10:00:00 +0000";

    fn eml(id: &str, subject: &str, date: &str, extra: &str, body: &str) -> String {
        format!("Message-ID: {id}\r\nSubject: {subject}\r\nDate: {date}\r\n{extra}\r\n{body}\r\n")
    }

    fn name(uid: u32, flags: &str) -> String {
        format!("{uid}{INFO_PREFIX}{flags}.eml")
    }

    fn put(mailbox: &Path, uid: u32, flags: &str, content: &str) -> PathBuf {
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();
        let path = cur.join(name(uid, flags));
        fs::write(&path, content).unwrap();
        path
    }

    fn row(uid: u32, id: &str, subject: &str, date: &str) -> Value {
        json!({"uid": uid, "messageId": id, "subject": subject, "messageDate": date})
    }

    fn view(rows: &[Value]) -> ServerView {
        ServerView::from_headers(rows)
    }

    fn cur_uids(mailbox: &Path) -> Vec<u32> {
        let mut uids: Vec<u32> = maildir::uid_file_map(&mailbox.join("cur")).into_keys().collect();
        uids.sort_unstable();
        uids
    }

    fn run(mailbox: &Path, server: &ServerView, is_graph: bool) -> (Plan, Report) {
        let plan = plan(mailbox, server, is_graph, &HashSet::new());
        let report = apply(mailbox, &plan).unwrap();
        (plan, report)
    }

    /// A message with no Message-ID (a Takeout chat or draft) has only its
    /// Subject and Date to go by, and matches only a row with no id either: a
    /// row carrying an id names some other message. No Date, no match.
    #[test]
    fn a_message_without_an_id_matches_an_idless_row_by_subject_and_date() {
        let chat = head_of(b"Subject: Chat with  Ann\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\n\r\nhi");
        let idless = |date: &str| json!({"uid": 3, "subject": "Chat with Ann", "messageDate": date});
        assert!(view(&[idless(DATE)]).lists_same(&chat));
        assert!(!view(&[idless("Mon, 1 Jan 2024 10:00:01 +0000")]).lists_same(&chat), "another second, another chat");
        assert!(!view(&[row(3, "<c@x>", "Chat with Ann", DATE)]).lists_same(&chat), "a row with an id is another message");
        let undated = head_of(b"Subject: Chat with Ann\r\n\r\nhi");
        assert!(!view(&[json!({"uid": 3, "subject": "Chat with Ann"})]).lists_same(&undated));
        // The rehome plan never sees such a row: it keys files by the server's id.
        assert!(view(&[idless(DATE)]).by_uid.is_empty());
    }

    #[test]
    fn a_message_added_to_the_view_is_listed_by_it() {
        let mut v = ServerView::default();
        let with_id = head_of(eml("<n@x>", "New", DATE, "", "body").as_bytes());
        let chat = head_of(b"Subject: Chat\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\n\r\nhi");
        assert!(!v.lists_same(&with_id) && !v.lists_same(&chat));
        assert!(v.add(Some(9), &with_id));
        assert!(v.add(None, &chat), "an idless message needs no uid");
        assert!(v.lists_same(&with_id) && v.lists_same(&chat));
        let other = head_of(eml("<n@x>", "Another subject", DATE, "", "body").as_bytes());
        assert!(!v.lists_same(&other), "the rule is unchanged: same id, another subject is another message");
        let unplaced = head_of(eml("<u@x>", "Unplaced", DATE, "", "body").as_bytes());
        assert!(!v.add(None, &unplaced), "an id with no uid cannot be placed");
        assert!(!v.lists_same(&unplaced));
    }

    #[test]
    fn a_bracketed_id_in_the_file_matches_a_bare_one_on_the_server() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 5, "A", &eml("<A@x>", "Hi", DATE, "", "body"));
        let p = plan(t.path(), &view(&[row(5, "A@x", "Hi", DATE)]), false, &HashSet::new());
        assert_eq!((p.compared, p.mismatched), (1, 0));
        assert!(p.to_import.is_empty() && p.set_aside.is_empty());
    }

    #[test]
    fn a_clean_mailbox_moves_nothing_and_counts_what_it_compared() {
        let t = tempfile::tempdir().unwrap();
        let mut rows = Vec::new();
        for uid in 1..=3 {
            put(t.path(), uid, "AS", &eml(&format!("<m{uid}@x>"), "Hi", DATE, "", "body"));
            rows.push(row(uid, &format!("<m{uid}@x>"), "Hi", DATE));
        }
        let (p, r) = run(t.path(), &view(&rows), false);
        assert_eq!((p.compared, p.mismatched), (3, 0));
        assert!(r.moved.is_empty() && r.set_aside.is_empty());
        assert_eq!(cur_uids(t.path()), vec![1, 2, 3]);
        assert!(!t.path().join(LEDGER_FILE).exists(), "a pass that moved nothing writes no ledger");
    }

    #[test]
    fn an_unknown_id_at_a_server_uid_moves_into_the_import_range_with_its_flags() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 5, "AS", &eml("<import@x>", "Old", DATE, "", "imported"));
        let (_, r) = run(t.path(), &view(&[row(5, "<server@x>", "Real", DATE)]), false);
        assert_eq!(r.moved, vec![(5, IMPORT_UID_BASE)]);
        assert!(t.path().join("cur").join(name(IMPORT_UID_BASE, "AS")).is_file(), "flags kept");

        // A later pass continues after it.
        put(t.path(), 6, "A", &eml("<import2@x>", "Old", DATE, "", "imported 2"));
        let (_, r) = run(t.path(), &view(&[row(5, "<server@x>", "Real", DATE), row(6, "<server6@x>", "Real", DATE)]), false);
        assert_eq!(r.moved, vec![(6, IMPORT_UID_BASE + 1)]);
        assert_eq!(read_ledger(t.path()).unwrap().len(), 2, "the ledger is cumulative");
    }

    #[test]
    fn a_copy_of_server_mail_with_a_matching_vault_copy_is_set_aside_not_deleted() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 5, "A", &eml("<dup@x>", "Hi", DATE, "X-Gmail-Labels: Inbox\r\nX-GM-THRID: 1\r\n", "same body"));
        put(t.path(), 9, "S", &eml("<dup@x>", "Hi", DATE, "Received: by mx\r\n", "same body\r\n\r\n"));
        let server = view(&[row(5, "<other@x>", "Other", DATE), row(9, "<dup@x>", "Hi", DATE)]);
        let (_, r) = run(t.path(), &server, false);
        assert_eq!(r.set_aside, vec![5]);
        assert_eq!(cur_uids(t.path()), vec![9]);
        assert!(t.path().join(ORPHAN_DIR).join(name(5, "A")).is_file(), "set aside, still on disk");
    }

    #[test]
    fn a_copy_whose_body_differs_from_the_vault_copy_moves_into_the_import_range() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 5, "A", &eml("<dup@x>", "Hi", DATE, "", "one body"));
        put(t.path(), 9, "S", &eml("<dup@x>", "Hi", DATE, "", "another body"));
        let server = view(&[row(5, "<other@x>", "Other", DATE), row(9, "<dup@x>", "Hi", DATE)]);
        let (_, r) = run(t.path(), &server, false);
        assert_eq!(r.moved, vec![(5, IMPORT_UID_BASE)]);
        assert!(r.set_aside.is_empty());
    }

    #[test]
    fn without_a_vault_copy_subject_and_date_stand_in_for_the_content() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 5, "A", &eml("<same@x>", "Hi", DATE, "", "body"));
        put(t.path(), 6, "A", &eml("<later@x>", "Hi", "Tue, 2 Jan 2024 10:00:00 +0000", "", "body"));
        // The server's subject is decoded; the file's may be RFC 2047.
        put(t.path(), 7, "A", &eml("<enc@x>", "=?UTF-8?B?R3LDvMOfZQ==?=", DATE, "", "body"));
        let server = view(&[
            row(5, "<s5@x>", "S", DATE),
            row(6, "<s6@x>", "S", DATE),
            row(7, "<s7@x>", "S", DATE),
            row(20, "<same@x>", "Hi", DATE),
            row(21, "<later@x>", "Hi", DATE),
            row(22, "<enc@x>", "Grüße", DATE),
        ]);
        let (_, r) = run(t.path(), &server, false);
        assert_eq!(r.set_aside, vec![5, 7]);
        assert_eq!(r.moved, vec![(6, IMPORT_UID_BASE)], "a different Date is a different message");
    }

    #[test]
    fn an_outlook_folder_leaves_a_copy_of_server_mail_where_it_is() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 5, "A", &eml("<dup@x>", "Hi", DATE, "", "body"));
        let server = view(&[row(5, "<other@x>", "Other", DATE), row(20, "<dup@x>", "Hi", DATE)]);
        let (p, r) = run(t.path(), &server, true);
        assert_eq!(p.mismatched, 1);
        assert!(r.moved.is_empty() && r.set_aside.is_empty());
        assert_eq!(cur_uids(t.path()), vec![5]);
    }

    #[test]
    fn no_message_id_no_server_row_no_archived_flag_or_a_protected_uid_is_left() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 1, "A", "Subject: no id\r\n\r\nbody\r\n");
        put(t.path(), 2, "A", &eml("<unknown@x>", "Hi", DATE, "", "body"));
        put(t.path(), 3, "S", &eml("<cache@x>", "Hi", DATE, "", "body"));
        put(t.path(), 4, "A", &eml("<draft@x>", "Hi", DATE, "", "body"));
        let server = view(&[row(1, "<s1@x>", "S", DATE), row(3, "<s3@x>", "S", DATE), row(4, "<s4@x>", "S", DATE)]);
        let p = plan(t.path(), &server, false, &HashSet::from([4]));
        assert!(p.to_import.is_empty() && p.set_aside.is_empty(), "{p:?}");
        assert_eq!(p.compared, 0);
    }

    #[test]
    fn the_fence_moves_nothing_when_no_file_is_found_on_the_server() {
        let t = tempfile::tempdir().unwrap();
        let mut rows = Vec::new();
        for uid in 1..=10 {
            put(t.path(), uid, "A", &eml(&format!("<file{uid}@x>"), "Hi", DATE, "", "body"));
            rows.push(row(uid, &format!("<server{uid}@x>"), "Hi", DATE));
        }
        let (p, r) = run(t.path(), &view(&rows), false);
        assert!(p.suspicious);
        assert_eq!((p.compared, p.mismatched), (10, 10));
        assert!(r.moved.is_empty() && r.set_aside.is_empty());
        assert_eq!(cur_uids(t.path()).len(), 10);
    }

    /// The folder this repair is for: a few real copies among many more old
    /// imports. More than half mismatch, which is not the fence's signature.
    #[test]
    fn a_folder_mostly_of_old_imports_is_repaired() {
        let t = tempfile::tempdir().unwrap();
        let mut rows = Vec::new();
        for uid in 1..=2 {
            put(t.path(), uid, "AS", &eml(&format!("<real{uid}@x>"), "Hi", DATE, "", "body"));
            rows.push(row(uid, &format!("<real{uid}@x>"), "Hi", DATE));
        }
        for uid in 3..=14 {
            put(t.path(), uid, "A", &eml(&format!("<import{uid}@x>"), "Hi", DATE, "", "body"));
            rows.push(row(uid, &format!("<server{uid}@x>"), "Hi", DATE));
        }
        let (p, r) = run(t.path(), &view(&rows), false);
        assert!(!p.suspicious);
        assert_eq!(r.moved.len(), 12);
        assert_eq!(cur_uids(t.path())[..2], [1, 2]);
    }

    #[test]
    fn a_decrypted_copy_moves_with_its_file() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 5, "A", &eml("<import@x>", "Old", DATE, "", "body"));
        put(t.path(), 6, "A", &eml("<dup@x>", "Hi", DATE, "", "body"));
        let dec = t.path().join(DECRYPTED_DIR);
        fs::create_dir_all(&dec).unwrap();
        fs::write(dec.join("5.eml"), "plain 5").unwrap();
        fs::write(dec.join("6.eml"), "plain 6").unwrap();
        let server = view(&[row(5, "<s5@x>", "S", DATE), row(6, "<s6@x>", "S", DATE), row(20, "<dup@x>", "Hi", DATE)]);
        let (_, r) = run(t.path(), &server, false);
        assert_eq!((r.moved.clone(), r.set_aside.clone()), (vec![(5, IMPORT_UID_BASE)], vec![6]));
        assert_eq!(fs::read_to_string(dec.join(format!("{IMPORT_UID_BASE}.eml"))).unwrap(), "plain 5");
        assert!(!dec.join("5.eml").exists() && !dec.join("6.eml").exists());
        assert_eq!(fs::read_to_string(t.path().join(ORPHAN_DIR).join(DECRYPTED_DIR).join("6.eml")).unwrap(), "plain 6");
        assert_eq!(maildir::orphan_stats(t.path()).count, 1, "the decrypted copy is not counted as orphaned mail");
    }

    #[test]
    fn a_name_renamed_since_the_plan_is_skipped() {
        let t = tempfile::tempdir().unwrap();
        let path = put(t.path(), 5, "A", &eml("<import@x>", "Old", DATE, "", "body"));
        let p = plan(t.path(), &view(&[row(5, "<s@x>", "S", DATE)]), false, &HashSet::new());
        fs::rename(&path, t.path().join("cur").join(name(5, "AS"))).unwrap();
        let r = apply(t.path(), &p).unwrap();
        assert!(r.moved.is_empty());
        assert_eq!(r.skipped, 1);
        assert!(!t.path().join(LEDGER_FILE).exists());
    }

    #[test]
    fn replay_carries_the_vault_moves_to_the_backup_folder_and_back() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        let content = eml("<import@x>", "Old", DATE, "", "body");
        put(vault.path(), 5, "A", &content);
        put(mirror.path(), 5, "A", &content);
        let (_, r) = run(vault.path(), &view(&[row(5, "<s@x>", "S", DATE)]), false);
        let b = IMPORT_UID_BASE;
        assert_eq!(r.moved, vec![(5, b)]);

        assert!(!replay(vault.path(), mirror.path()), "the vault already holds B");
        assert_eq!(cur_uids(mirror.path()), vec![b]);

        // The pre-sync restored U into the vault anyway: moved again, and with
        // B taken, set aside.
        put(vault.path(), 5, "A", &content);
        assert!(replay(vault.path(), mirror.path()));
        assert_eq!(cur_uids(vault.path()), vec![b]);
        assert!(vault.path().join(ORPHAN_DIR).join(name(5, "A")).is_file());

        // With B free, U goes to B.
        fs::remove_file(vault.path().join("cur").join(name(b, "A"))).unwrap();
        put(vault.path(), 5, "A", &content);
        assert!(replay(vault.path(), mirror.path()));
        assert_eq!(cur_uids(vault.path()), vec![b]);
    }

    #[test]
    fn replay_leaves_the_real_message_that_later_took_the_uid() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        put(vault.path(), 5, "A", &eml("<import@x>", "Old", DATE, "", "body"));
        run(vault.path(), &view(&[row(5, "<s@x>", "S", DATE)]), false);
        put(vault.path(), 5, "A", &eml("<s@x>", "S", DATE, "", "the server's own"));
        put(mirror.path(), 5, "A", &eml("<s@x>", "S", DATE, "", "the server's own"));
        assert!(!replay(vault.path(), mirror.path()));
        assert_eq!(cur_uids(vault.path()), vec![5, IMPORT_UID_BASE]);
        assert_eq!(cur_uids(mirror.path()), vec![5]);
    }

    #[test]
    fn replay_without_a_ledger_reads_nothing() {
        let vault = tempfile::tempdir().unwrap();
        let mirror = tempfile::tempdir().unwrap();
        put(vault.path(), 5, "A", &eml("<a@x>", "S", DATE, "", "body"));
        put(mirror.path(), 5, "A", &eml("<a@x>", "S", DATE, "", "body"));
        let before = maildir::READ_MESSAGE_ID_CALLS.with(|c| c.get());
        assert!(!replay(vault.path(), mirror.path()));
        assert_eq!(maildir::READ_MESSAGE_ID_CALLS.with(|c| c.get()), before);
    }

    #[test]
    fn an_unreadable_ledger_stops_a_pass_before_it_moves_anything() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), 5, "A", &eml("<import@x>", "Old", DATE, "", "body"));
        fs::write(t.path().join(LEDGER_FILE), "not json").unwrap();
        let p = plan(t.path(), &view(&[row(5, "<s@x>", "S", DATE)]), false, &HashSet::new());
        assert!(apply(t.path(), &p).is_err());
        assert_eq!(cur_uids(t.path()), vec![5]);
    }
}
