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
use std::path::Path;

/// The last time the daemon's delete queue was refused one uid of an entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Failure {
    /// The refusal as the daemon gave it (a catalog key or the server's text).
    pub message: String,
    /// Epoch ms.
    pub at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct OpEntry {
    /// Monotonic per file, assigned by `queue`.
    pub id: u64,
    /// "delete" | "flag" | "move".
    pub op: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub mailbox: String,
    pub uids: Vec<u32>,
    /// flag: `{"flags":[..],"action":"add"|"remove"}`; move: `{"target":".."}`;
    /// delete: `{}` from the app, or the daemon queue's `{"mode", "bin", ..}`.
    #[serde(default)]
    pub arg: serde_json::Value,
    /// Epoch ms.
    pub at: u64,
    /// Send rounds the daemon's delete queue made for this entry. 0 for an
    /// entry nothing has tried yet (and every entry the app writes): `queue`
    /// never takes it from the caller.
    #[serde(default)]
    pub attempts: u32,
    /// The latest refusal of each uid still owed (one per uid, the newest).
    /// Durable, unlike the app's old in-memory reasons, so Settings can say
    /// why after a restart. Never taken from the caller either.
    #[serde(default)]
    pub failures: BTreeMap<u32, Failure>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn row_to_entry(row: crate::app_db::ops::Full) -> OpEntry {
    OpEntry {
        id: row.id,
        op: row.op,
        account_id: row.account_id,
        mailbox: row.mailbox,
        uids: serde_json::from_str(&row.uids_json).unwrap_or_default(),
        arg: serde_json::from_str(&row.arg_json).unwrap_or_else(|_| serde_json::json!({})),
        at: row.at,
        attempts: row.attempts,
        failures: serde_json::from_str(&row.failures_json).unwrap_or_default(),
    }
}

/// Write `entry`'s uids and failures back, dropping the failures of uids it
/// no longer owes, or delete it when it owes nothing.
fn store_uids(conn: &crate::app_db::Connection, entry: &OpEntry) -> Result<(), String> {
    let uids = serde_json::to_string(&entry.uids).map_err(|e| e.to_string())?;
    let failures: BTreeMap<&u32, &Failure> = entry.failures.iter().filter(|(uid, _)| entry.uids.contains(uid)).collect();
    let failures = serde_json::to_string(&failures).map_err(|e| e.to_string())?;
    crate::app_db::ops::set_uids_and_failures(conn, entry.id, &uids, &failures, entry.uids.is_empty())
}

/// Every unfinished op, oldest first. A store that will not open reads as
/// empty for the same reason a corrupt journal used to: erroring here would
/// block the mutation the user is asking for now.
pub fn read(data_dir: &Path) -> Vec<OpEntry> {
    crate::app_db::with(data_dir, |conn| Ok(crate::app_db::ops::read_full(conn)))
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
        crate::app_db::db::in_txn(conn, || {
            for row in crate::app_db::ops::read_full(conn) {
                let mut entry = row_to_entry(row);
                if entry.op != op || entry.account_id != account_id || entry.mailbox != mailbox || entry.arg != *arg {
                    continue;
                }
                let before = entry.uids.len();
                entry.uids.retain(|uid| !uids.contains(uid));
                if entry.uids.len() != before {
                    store_uids(conn, &entry)?;
                }
            }
            Ok(())
        })
    })
}

/// One entry by id, `None` once it is answered or cancelled.
pub fn get(data_dir: &Path, id: u64) -> Result<Option<OpEntry>, String> {
    crate::app_db::with(data_dir, |conn| Ok(crate::app_db::ops::get(conn, id)?.map(row_to_entry)))
}

/// Forget these uids of entry `id`, whatever its `arg` (the daemon names the
/// entry it wrote, so no arg match is needed), with their failures; drop the
/// entry left with nothing. An entry that is already gone is not an error.
pub fn clear_by_id(data_dir: &Path, id: u64, uids: &[u32]) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::in_txn(conn, || {
            let Some(mut entry) = crate::app_db::ops::get(conn, id)?.map(row_to_entry) else { return Ok(()) };
            let before = entry.uids.len();
            entry.uids.retain(|uid| !uids.contains(uid));
            if entry.uids.len() == before {
                return Ok(());
            }
            store_uids(conn, &entry)
        })
    })
}

/// Record why `uid` of entry `id` was refused, replacing an older reason for
/// it. A uid the entry no longer owes (answered, cancelled) records nothing.
pub fn note_failure(data_dir: &Path, id: u64, uid: u32, message: &str) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::in_txn(conn, || {
            let Some(mut entry) = crate::app_db::ops::get(conn, id)?.map(row_to_entry) else { return Ok(()) };
            if !entry.uids.contains(&uid) {
                return Ok(());
            }
            entry.failures.insert(uid, Failure { message: message.to_string(), at: now_ms() });
            store_uids(conn, &entry)
        })
    })
}

/// Count one send round for entry `id` (before it is sent, so a round the
/// daemon died in still counts). A gone entry is left gone.
pub fn note_attempt(data_dir: &Path, id: u64) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| crate::app_db::ops::bump_attempts(conn, id))
}

/// Where each uid of a queued delete is owed.
#[derive(Debug, Clone, PartialEq)]
pub struct Owed {
    /// The entry written for the uids no delete entry owed yet; `None` when
    /// every uid was owed already.
    pub id: Option<u64>,
    /// Every uid asked for (once each, in the caller's order) and the entry
    /// that owes it.
    pub owners: Vec<(u32, u64)>,
}

/// Queue a delete of `uids` in `mailbox`, owing each uid once: a uid a delete
/// entry for this account and folder already owes stays with that entry
/// (whatever its `arg`), so a second click or a replay racing a click never
/// makes a second entry that would be sent again later. The rest go in one
/// new entry with `arg`. Read and write in one transaction, as the app writes
/// this store too.
pub fn queue_delete(data_dir: &Path, account_id: &str, mailbox: &str, uids: &[u32], arg: &serde_json::Value) -> Result<Owed, String> {
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::in_txn(conn, || {
            let mut owned: BTreeMap<u32, u64> = BTreeMap::new();
            for row in crate::app_db::ops::read_full(conn) {
                let entry = row_to_entry(row);
                if entry.op == "delete" && entry.account_id == account_id && entry.mailbox == mailbox {
                    for uid in entry.uids {
                        owned.entry(uid).or_insert(entry.id);
                    }
                }
            }
            let mut asked: Vec<u32> = Vec::new();
            for uid in uids {
                if !asked.contains(uid) {
                    asked.push(*uid);
                }
            }
            let fresh: Vec<u32> = asked.iter().copied().filter(|uid| !owned.contains_key(uid)).collect();
            let id = if fresh.is_empty() {
                None
            } else {
                let json = serde_json::to_string(&fresh).map_err(|e| e.to_string())?;
                Some(crate::app_db::ops::queue(conn, "delete", account_id, mailbox, &json, &arg.to_string(), now_ms())?)
            };
            let owners = asked.iter().map(|uid| (*uid, owned.get(uid).copied().or(id).unwrap_or_default())).collect();
            Ok(Owed { id, owners })
        })
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
    let raw = crate::app_db::with(data_dir, |conn| {
        Ok(crate::app_db::db::meta_get(conn, crate::app_db::ops::PENDING_OPERATION_KEY))
    })?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|error| format!("parse pending operation: {error}"))).transpose()
}

pub fn pending_operation_save(data_dir: &Path, operation: &serde_json::Value) -> Result<(), String> {
    pending_operation_save_encoded(data_dir, &operation.to_string())
}

pub(crate) fn pending_operation_save_encoded(data_dir: &Path, encoded: &str) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::meta_set(conn, crate::app_db::ops::PENDING_OPERATION_KEY, encoded)
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
        OpEntry { op: op.into(), account_id: "acct".into(), mailbox: "INBOX".into(), uids: uids.to_vec(), arg, ..Default::default() }
    }

    /// What a fresh connection (not the store's cached handle) reads for row `id`.
    fn on_disk(dir: &Path, id: u64) -> Option<crate::app_db::ops::Full> {
        let conn = crate::app_db::db::open(dir).unwrap();
        crate::app_db::ops::get(&conn, id).unwrap()
    }

    // ── the delete queue's retry record ────────────────────────────────────

    #[test]
    fn an_entry_the_app_sends_without_a_retry_record_still_parses_and_starts_untried() {
        let raw = serde_json::json!({"id": 0, "op": "delete", "accountId": "a", "mailbox": "INBOX", "uids": [1], "arg": {}, "at": 0});
        let parsed: OpEntry = serde_json::from_value(raw).expect("attempts/failures default");
        assert_eq!((parsed.attempts, parsed.failures.len()), (0, 0));

        // And `queue` never takes a retry record from its caller.
        let d = tmp();
        let mut forged = entry("delete", &[1], serde_json::json!({}));
        forged.attempts = 9;
        forged.failures.insert(1, Failure { message: "forged".into(), at: 1 });
        let id = queue(d.path(), forged).unwrap();
        let back = get(d.path(), id).unwrap().unwrap();
        assert_eq!((back.attempts, back.failures.len()), (0, 0));
    }

    #[test]
    fn note_failure_persists_across_a_reopen_and_keeps_only_the_latest_per_uid() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1, 2], serde_json::json!({}))).unwrap();
        note_failure(d.path(), id, 1, "first").unwrap();
        note_failure(d.path(), id, 1, "second").unwrap();
        note_failure(d.path(), id, 2, "other").unwrap();

        let row = on_disk(d.path(), id).expect("still owed");
        let failures: BTreeMap<u32, Failure> = serde_json::from_str(&row.failures_json).unwrap();
        assert_eq!(failures.len(), 2, "one reason per uid");
        assert_eq!(failures[&1].message, "second", "the newest reason replaces the older one");
        assert_eq!(failures[&2].message, "other");
        assert!(failures[&1].at > 0);
        let read_back = read(d.path());
        assert_eq!(read_back[0].failures[&1].message, "second");
    }

    #[test]
    fn note_failure_for_a_uid_no_longer_owed_records_nothing() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1, 2], serde_json::json!({}))).unwrap();
        note_failure(d.path(), id, 7, "not owed").unwrap();
        clear_by_id(d.path(), id, &[2]).unwrap();
        note_failure(d.path(), id, 2, "answered meanwhile").unwrap();
        assert!(get(d.path(), id).unwrap().unwrap().failures.is_empty());
        // A gone entry is not an error either.
        clear_by_id(d.path(), id, &[1]).unwrap();
        note_failure(d.path(), id, 1, "cancelled meanwhile").unwrap();
        assert!(get(d.path(), id).unwrap().is_none());
    }

    #[test]
    fn note_attempt_counts_rounds_durably() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1], serde_json::json!({}))).unwrap();
        for _ in 0..6 {
            note_attempt(d.path(), id).unwrap();
        }
        assert_eq!(on_disk(d.path(), id).unwrap().attempts, 6);
        assert_eq!(read(d.path())[0].attempts, 6);
        note_attempt(d.path(), 999).unwrap();
    }

    #[test]
    fn clear_by_id_removes_only_the_named_uids_with_their_failures_and_drops_an_emptied_entry() {
        let d = tmp();
        let bulk = serde_json::json!({"total": 3, "messages": [{"uid": 1}, {"uid": 2}, {"uid": 3}]});
        let id = queue(d.path(), entry("delete", &[1, 2, 3], bulk)).unwrap();
        let other = queue(d.path(), entry("delete", &[2], serde_json::json!({}))).unwrap();
        note_failure(d.path(), id, 2, "refused").unwrap();
        note_failure(d.path(), id, 3, "refused").unwrap();

        // No arg is needed, and another entry owing the same uid keeps it.
        clear_by_id(d.path(), id, &[2]).unwrap();
        let left = get(d.path(), id).unwrap().unwrap();
        assert_eq!(left.uids, vec![1, 3]);
        assert_eq!(left.failures.keys().copied().collect::<Vec<_>>(), vec![3], "the cleared uid's reason goes with it");
        assert_eq!(get(d.path(), other).unwrap().unwrap().uids, vec![2]);

        clear_by_id(d.path(), id, &[1, 3]).unwrap();
        assert!(on_disk(d.path(), id).is_none(), "an emptied entry is deleted");
        assert_eq!(read(d.path()).len(), 1);
    }

    #[test]
    fn the_arg_matched_clear_drops_the_failures_of_what_it_clears() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1, 2], serde_json::json!({}))).unwrap();
        note_failure(d.path(), id, 1, "refused").unwrap();
        note_failure(d.path(), id, 2, "refused").unwrap();
        clear(d.path(), "delete", "acct", "INBOX", &[1], &serde_json::json!({})).unwrap();
        let left = get(d.path(), id).unwrap().unwrap();
        assert_eq!(left.uids, vec![2]);
        assert_eq!(left.failures.keys().copied().collect::<Vec<_>>(), vec![2]);
    }

    #[test]
    fn queue_delete_owes_each_uid_once() {
        let d = tmp();
        let arg = serde_json::json!({"mode": "auto", "bin": true});
        let first = queue_delete(d.path(), "acct", "INBOX", &[1, 2, 2], &arg).unwrap();
        let a = first.id.expect("a new entry");
        assert_eq!(first.owners, vec![(1, a), (2, a)]);

        // 2 is owed already; 3 is new. A flag entry or another folder owns nothing here.
        queue(d.path(), entry("flag", &[3], serde_json::json!({"flags": ["\\Seen"], "action": "add"}))).unwrap();
        let mut elsewhere = entry("delete", &[3], serde_json::json!({}));
        elsewhere.mailbox = "Archive".into();
        queue(d.path(), elsewhere).unwrap();
        let second = queue_delete(d.path(), "acct", "INBOX", &[2, 3], &arg).unwrap();
        let b = second.id.expect("3 needed an entry");
        assert_ne!(a, b);
        assert_eq!(second.owners, vec![(2, a), (3, b)]);
        assert_eq!(get(d.path(), b).unwrap().unwrap().uids, vec![3]);
        assert_eq!(get(d.path(), b).unwrap().unwrap().arg, arg);

        let third = queue_delete(d.path(), "acct", "INBOX", &[1, 3], &arg).unwrap();
        assert_eq!(third, Owed { id: None, owners: vec![(1, a), (3, b)] }, "nothing new is written");
        assert_eq!(read(d.path()).iter().filter(|e| e.op == "delete" && e.mailbox == "INBOX").count(), 2);
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
