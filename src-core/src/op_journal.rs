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
use std::path::Path;

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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn row_to_entry(row: crate::app_db::ops::Row) -> OpEntry {
    let (id, op, account_id, mailbox, uids_json, arg_json, at) = row;
    OpEntry {
        id,
        op,
        account_id,
        mailbox,
        uids: serde_json::from_str(&uids_json).unwrap_or_default(),
        arg: serde_json::from_str(&arg_json).unwrap_or_else(|_| serde_json::json!({})),
        at,
    }
}

/// Every unfinished op, oldest first. A store that will not open reads as
/// empty for the same reason a corrupt journal used to: erroring here would
/// block the mutation the user is asking for now.
pub fn read(data_dir: &Path) -> Vec<OpEntry> {
    crate::app_db::with(data_dir, |conn| Ok(crate::app_db::ops::read(conn)))
        .unwrap_or_default()
        .into_iter()
        .map(row_to_entry)
        .collect()
}

/// Record an intent. `entry.id` and `entry.at` are assigned here.
pub fn queue(data_dir: &Path, entry: OpEntry) -> Result<u64, String> {
    let uids = serde_json::to_string(&entry.uids).map_err(|e| e.to_string())?;
    let arg = entry.arg.to_string();
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::ops::queue(conn, &entry.op, &entry.account_id, &entry.mailbox, &uids, &arg, now_ms())
    })
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
    crate::app_db::with(data_dir, |conn| {
        for row in crate::app_db::ops::read(conn) {
            let entry = row_to_entry(row);
            if entry.op != op || entry.account_id != account_id || entry.mailbox != mailbox || entry.arg != *arg {
                continue;
            }
            let kept: Vec<u32> = entry.uids.iter().copied().filter(|uid| !uids.contains(uid)).collect();
            if kept.len() == entry.uids.len() {
                continue;
            }
            let json = serde_json::to_string(&kept).map_err(|e| e.to_string())?;
            crate::app_db::ops::set_uids(conn, entry.id, &json, kept.is_empty())?;
        }
        Ok(())
    })
}

// ── Pending operation persistence ──────────────────────────────
//
// A single in-flight bulk operation the UI is mid-way through (separate from
// the op journal above, which is confirmed-but-unconfirmed server mutations).
// Lives in the app data dir for the same reason the journal does: it has to
// be readable before a relocatable vault is necessarily present.

/// `None` when there is no pending operation. An unreadable store is an
/// error, same as an unparseable file was — swallowing it would silently drop
/// the one piece of state that lets the UI resume.
pub fn pending_operation_read(data_dir: &Path) -> Result<Option<serde_json::Value>, String> {
    crate::app_db::with(data_dir, |conn| {
        let Some(raw) = crate::app_db::db::meta_get(conn, crate::app_db::ops::PENDING_OPERATION_KEY) else {
            return Ok(None);
        };
        serde_json::from_str(&raw).map(Some).map_err(|e| format!("parse pending operation: {}", e))
    })
}

pub fn pending_operation_save(data_dir: &Path, operation: &serde_json::Value) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::meta_set(conn, crate::app_db::ops::PENDING_OPERATION_KEY, &operation.to_string())
    })
}

pub fn pending_operation_clear(data_dir: &Path) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::meta_clear(conn, crate::app_db::ops::PENDING_OPERATION_KEY)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp() -> tempfile::TempDir { tempfile::tempdir().unwrap() }
    fn entry(op: &str, uids: &[u32], arg: serde_json::Value) -> OpEntry {
        OpEntry { id: 0, op: op.into(), account_id: "acct".into(), mailbox: "INBOX".into(), uids: uids.to_vec(), arg, at: 0 }
    }

    #[test]
    fn a_missing_store_reads_as_empty() {
        let d = tmp();
        assert!(read(d.path()).is_empty());
    }

    #[test]
    fn a_corrupt_legacy_journal_reads_as_empty() {
        // Written before the first read: the import runs on the first open.
        let d = tmp();
        std::fs::write(d.path().join("pending_ops.json"), "{ not json").unwrap();
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
        assert!(read(d.path()).is_empty(), "an emptied entry is deleted, not kept with no uids");
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
        assert!(!d.path().join("pending_server_delete.json").exists(), "imported file is retired");
        assert_eq!(read(d.path()).len(), 2, "second read does not import twice");
    }

    #[test]
    fn pending_operation_round_trips_and_clears() {
        let d = tmp();
        assert_eq!(pending_operation_read(d.path()).unwrap(), None);

        let op = serde_json::json!({"kind": "bulkDelete", "uids": [1, 2, 3]});
        pending_operation_save(d.path(), &op).unwrap();
        assert_eq!(pending_operation_read(d.path()).unwrap(), Some(op));

        pending_operation_clear(d.path()).unwrap();
        assert_eq!(pending_operation_read(d.path()).unwrap(), None);
        // Clearing an already-absent operation is not an error.
        pending_operation_clear(d.path()).unwrap();
    }

    #[test]
    fn pending_operation_save_creates_the_data_directory() {
        let parent = tmp();
        let d = parent.path().join("not-yet-created");
        assert!(!d.exists());
        pending_operation_save(&d, &serde_json::json!({"a": 1})).unwrap();
        assert_eq!(pending_operation_read(&d).unwrap(), Some(serde_json::json!({"a": 1})));
    }

    #[test]
    fn an_unparseable_legacy_pending_operation_file_does_not_resurrect() {
        // The old reader errored on it forever; the import retires it instead,
        // so the UI starts clean rather than failing every launch.
        let d = tmp();
        std::fs::write(d.path().join("pending_operations.json"), "{ not json").unwrap();
        assert_eq!(pending_operation_read(d.path()).unwrap(), None);
    }
}
