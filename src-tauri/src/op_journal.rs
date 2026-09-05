//! Durable journal of server mutations the user confirmed but that may not have run.
//!
//! "Delete from server" is driven from the frontend: the row is hidden
//! optimistically and a session tombstone keeps it hidden, then the workflow
//! awaits one IMAP round-trip per message. Reload or quit the app inside that
//! window and the JS context dies before the command is ever sent — the message
//! is never deleted, nothing errors, nothing retries, and it is back on the next
//! launch. The user watched the row disappear and has every reason to believe it
//! is gone. The window is exactly as wide as the server is slow, so it is a real
//! provider problem, not a synthetic one.
//!
//! Writing the intent here before the first round-trip and clearing it after the
//! last lets the next launch finish what the user already confirmed.
//!
//! Generalised 2026-09-05 to flags and moves — Thunderbird replays twelve
//! offline op kinds; MailVault replayed one.
//!
//! UIDs are unique per mailbox and nowhere else, so the mailbox is part of every
//! entry — replaying a uid against the wrong one hits a stranger's mail.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpEntry {
    /// Monotonic per file, assigned by `queue`.
    pub id: u64,
    /// "delete" | "flag" | "move".
    pub op: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub mailbox: String,
    pub uids: Vec<u32>,
    /// flag: `{"flags":[..],"action":"add"|"remove"}`; move: `{"target":".."}`; delete: `{}`.
    #[serde(default)]
    pub arg: serde_json::Value,
    /// Epoch ms.
    pub at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Journal {
    next_id: u64,
    ops: Vec<OpEntry>,
}

pub fn journal_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pending_ops.json")
}

/// The pre-2026-09-05 delete-only journal: `{"<accountId>|<mailbox>": [uids]}`.
fn legacy_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pending_server_delete.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Turn the old delete-only journal into delete ops, once. Returns what it
/// imported; leaves the old file alone if the new one could not be written, so
/// a failed import retries rather than losing the user's confirmed deletes.
fn import_legacy(data_dir: &Path) -> Journal {
    let Ok(content) = std::fs::read_to_string(legacy_path(data_dir)) else {
        return Journal::default();
    };
    let old: BTreeMap<String, Vec<u32>> = serde_json::from_str(&content).unwrap_or_default();
    let mut journal = Journal::default();
    for (k, uids) in old {
        // A malformed key names no mailbox, and a uid without a mailbox is not
        // a message — drop it rather than guess at one.
        let Some((account_id, mailbox)) = k.split_once('|') else { continue };
        if uids.is_empty() {
            continue;
        }
        journal.ops.push(OpEntry {
            id: journal.next_id,
            op: "delete".into(),
            account_id: account_id.to_string(),
            mailbox: mailbox.to_string(),
            uids,
            arg: serde_json::json!({}),
            at: now_ms(),
        });
        journal.next_id += 1;
    }
    if journal.ops.is_empty() {
        let _ = std::fs::remove_file(legacy_path(data_dir));
        return journal;
    }
    if write(data_dir, &journal).is_ok() {
        let _ = std::fs::remove_file(legacy_path(data_dir));
    }
    journal
}

fn load(data_dir: &Path) -> Journal {
    let Ok(content) = std::fs::read_to_string(journal_path(data_dir)) else {
        return import_legacy(data_dir);
    };
    // A corrupt journal must not brick mutating mail. Starting over loses a
    // retry; erroring here would block the delete the user is asking for now.
    serde_json::from_str(&content).unwrap_or_default()
}

fn write(data_dir: &Path, journal: &Journal) -> Result<(), String> {
    if journal.ops.is_empty() {
        // Remove rather than write an empty journal — absence is the common
        // case, and it makes the launch check one failed open, not a parse.
        let _ = std::fs::remove_file(journal_path(data_dir));
        return Ok(());
    }
    let data = serde_json::to_string(journal).map_err(|e| format!("serialize op journal: {}", e))?;
    mailvault_core::fsx::write_atomic(&journal_path(data_dir), data.as_bytes())
        .map_err(|e| format!("write op journal: {}", e))
}

/// Every unfinished op, oldest first.
pub fn read(data_dir: &Path) -> Vec<OpEntry> {
    load(data_dir).ops
}

/// Record an intent. `entry.id` and `entry.at` are assigned here.
pub fn queue(data_dir: &Path, entry: OpEntry) -> Result<u64, String> {
    let mut journal = load(data_dir);
    let id = journal.next_id;
    journal.next_id += 1;
    journal.ops.push(OpEntry { id, at: now_ms(), ..entry });
    write(data_dir, &journal)?;
    Ok(id)
}

/// Forget these uids wherever this op/account/mailbox/arg owns them; drop
/// entries left with nothing. An entry for a *different* op keeps its uids —
/// the same message can be owed a flag and a move at once — and so does an
/// entry for the same op with a different `arg`: the live path writes one
/// entry per (flag, action), so `\Seen add` and `\Flagged add` are two entries
/// for one uid, and finishing either must leave the other owed.
pub fn clear(
    data_dir: &Path,
    op: &str,
    account_id: &str,
    mailbox: &str,
    uids: &[u32],
    arg: &serde_json::Value,
) -> Result<(), String> {
    let mut journal = load(data_dir);
    for entry in journal.ops.iter_mut() {
        if entry.op == op && entry.account_id == account_id && entry.mailbox == mailbox && entry.arg == *arg {
            entry.uids.retain(|uid| !uids.contains(uid));
        }
    }
    journal.ops.retain(|e| !e.uids.is_empty());
    write(data_dir, &journal)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp() -> tempfile::TempDir { tempfile::tempdir().unwrap() }
    fn entry(op: &str, uids: &[u32], arg: serde_json::Value) -> OpEntry {
        OpEntry { id: 0, op: op.into(), account_id: "acct".into(), mailbox: "INBOX".into(), uids: uids.to_vec(), arg, at: 0 }
    }

    #[test]
    fn missing_and_corrupt_journals_read_as_empty() {
        let d = tmp();
        assert!(read(d.path()).is_empty());
        std::fs::write(journal_path(d.path()), "{ not json").unwrap();
        assert!(read(d.path()).is_empty());
    }

    #[test]
    fn queue_assigns_increasing_ids_and_keeps_user_order() {
        let d = tmp();
        let a = queue(d.path(), entry("flag", &[7], serde_json::json!({"flags":["\\Flagged"],"action":"add"}))).unwrap();
        let b = queue(d.path(), entry("move", &[7], serde_json::json!({"target":"Archive"}))).unwrap();
        assert!(b > a);
        let ops = read(d.path());
        assert_eq!(ops.iter().map(|e| e.op.as_str()).collect::<Vec<_>>(), vec!["flag", "move"]);
        assert_eq!(ops[1].arg["target"], "Archive");
    }

    #[test]
    fn clear_removes_uids_from_matching_entries_only_and_drops_empty_ones() {
        let d = tmp();
        let seen = serde_json::json!({"flags":["\\Seen"],"action":"add"});
        queue(d.path(), entry("delete", &[1, 2, 3], serde_json::json!({}))).unwrap();
        queue(d.path(), entry("flag", &[2], seen.clone())).unwrap();
        clear(d.path(), "delete", "acct", "INBOX", &[2, 3], &serde_json::json!({})).unwrap();
        let ops = read(d.path());
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].uids, vec![1]);
        assert_eq!(ops[1].uids, vec![2], "a flag entry is not a delete entry");
        clear(d.path(), "delete", "acct", "INBOX", &[1], &serde_json::json!({})).unwrap();
        assert_eq!(read(d.path()).len(), 1);
        clear(d.path(), "flag", "acct", "INBOX", &[2], &seen).unwrap();
        assert!(read(d.path()).is_empty());
        assert!(!journal_path(d.path()).exists(), "empty journal is removed, not written as []");
    }

    // Two flag entries for one uid differ only in their `arg` — the live path
    // writes one per (flag, action). Clearing the one that succeeded must not
    // take the other one's uid with it: that entry is a change the user made
    // and the server has not heard about.
    #[test]
    fn clearing_one_flag_leaves_a_different_flag_for_the_same_uid() {
        let d = tmp();
        let seen = serde_json::json!({"flags":["\\Seen"],"action":"add"});
        let flagged = serde_json::json!({"flags":["\\Flagged"],"action":"add"});
        queue(d.path(), entry("flag", &[7], flagged.clone())).unwrap();
        queue(d.path(), entry("flag", &[7], seen.clone())).unwrap();

        clear(d.path(), "flag", "acct", "INBOX", &[7], &seen).unwrap();

        let ops = read(d.path());
        assert_eq!(ops.len(), 1, "the Seen entry is gone, the Flagged one is not");
        assert_eq!(ops[0].arg, flagged);
        assert_eq!(ops[0].uids, vec![7]);

        // And an arg that matches no entry clears nothing at all.
        clear(d.path(), "flag", "acct", "INBOX", &[7], &serde_json::json!({"flags":["\\Draft"],"action":"add"})).unwrap();
        assert_eq!(read(d.path())[0].uids, vec![7]);
    }

    #[test]
    fn the_old_pending_delete_file_is_imported_once_as_delete_ops() {
        let d = tmp();
        std::fs::write(d.path().join("pending_server_delete.json"), r#"{"acct|INBOX":[4,9],"acct|Sent":[2]}"#).unwrap();
        let ops = read(d.path());
        assert_eq!(ops.len(), 2);
        assert!(ops.iter().all(|e| e.op == "delete"));
        assert!(ops.iter().any(|e| e.mailbox == "INBOX" && e.uids == vec![4, 9]));
        assert!(!d.path().join("pending_server_delete.json").exists(), "imported file is removed");
        assert!(journal_path(d.path()).exists());
        assert_eq!(read(d.path()).len(), 2, "second read does not import twice");
    }
}
