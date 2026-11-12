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
    /// Background replay passes (the daemon's worker, not a submit's own
    /// rounds) that were refused this uid since it was queued. Carried over
    /// when a newer reason replaces this one; the worker's backoff reads it.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub passes: u32,
    /// The delete was stopped for good and nothing was sent (the server
    /// renumbered the folder since it was queued): the uid is no longer owed,
    /// but its entry stays listed with this reason until the user cancels it
    /// (`stop_by_id`). Absent from rows written before it existed.
    #[serde(default, skip_serializing_if = "is_false")]
    pub stopped: bool,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

fn is_false(b: &bool) -> bool {
    !*b
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

/// The `arg` key a daemon-queued delete keeps the folder's UIDVALIDITY
/// under: the generation its uids were read in.
pub const UID_VALIDITY_KEY: &str = "uidValidity";

/// `UID_VALIDITY_KEY` of `value` (an entry's `arg`, or the header cache's
/// meta, which keeps the same key): a UIDVALIDITY, or `None` for anything
/// that is not one (absent, 0, not a u32).
pub fn uid_validity_of(value: &serde_json::Value) -> Option<u32> {
    value.get(UID_VALIDITY_KEY).and_then(serde_json::Value::as_u64).and_then(|v| u32::try_from(v).ok()).filter(|v| *v != 0)
}

impl OpEntry {
    /// The folder generation (UIDVALIDITY) this entry was queued against.
    /// `None` for an entry the app wrote, one an older daemon wrote, or one
    /// queued while the generation was unknown: sent as before, unchecked.
    pub fn uid_validity(&self) -> Option<u32> {
        uid_validity_of(&self.arg)
    }
}

use crate::clock::now_ms_u64 as now_ms;

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
/// no longer owes (a stop's are kept: `Failure.stopped`), or delete it when
/// it owes nothing and lists no stop.
fn store_uids(conn: &crate::app_db::Connection, entry: &OpEntry) -> Result<(), String> {
    let uids = serde_json::to_string(&entry.uids).map_err(|e| e.to_string())?;
    let failures: BTreeMap<&u32, &Failure> = entry.failures.iter().filter(|(uid, f)| f.stopped || entry.uids.contains(uid)).collect();
    let empty = entry.uids.is_empty() && failures.is_empty();
    let failures = serde_json::to_string(&failures).map_err(|e| e.to_string())?;
    crate::app_db::ops::set_uids_and_failures(conn, entry.id, &uids, &failures, empty)
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
/// entry it wrote, so no arg match is needed), with their failures (a stop's
/// too: this is also the cancel); drop the entry left with nothing. An entry
/// that is already gone is not an error.
pub fn clear_by_id(data_dir: &Path, id: u64, uids: &[u32]) -> Result<(), String> {
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::in_txn(conn, || {
            let Some(mut entry) = crate::app_db::ops::get(conn, id)?.map(row_to_entry) else { return Ok(()) };
            let before = (entry.uids.len(), entry.failures.len());
            entry.uids.retain(|uid| !uids.contains(uid));
            entry.failures.retain(|uid, f| !(f.stopped && uids.contains(uid)));
            if (entry.uids.len(), entry.failures.len()) == before {
                return Ok(());
            }
            store_uids(conn, &entry)
        })
    })
}

/// Stop these `(uid, reason)` of entry `id` for good, nothing sent: each uid
/// the entry owes is no longer owed (no replay sends it, the app's list shows
/// its row again) and keeps `reason` as a stopped `Failure` (its pass count
/// carried), so the entry stays listed until the user cancels it
/// (`clear_by_id`). One transaction. A uid it does not owe, or a gone entry,
/// records nothing.
pub fn stop_by_id(data_dir: &Path, id: u64, stops: &[(u32, String)], at: u64) -> Result<(), String> {
    if stops.is_empty() {
        return Ok(());
    }
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::in_txn(conn, || {
            let Some(mut entry) = crate::app_db::ops::get(conn, id)?.map(row_to_entry) else { return Ok(()) };
            let mut stopped = false;
            for (uid, message) in stops {
                if entry.uids.contains(uid) {
                    let passes = entry.failures.get(uid).map_or(0, |f| f.passes);
                    entry.failures.insert(*uid, Failure { message: message.clone(), at, passes, stopped: true });
                    entry.uids.retain(|u| u != uid);
                    stopped = true;
                }
            }
            if !stopped {
                return Ok(());
            }
            store_uids(conn, &entry)
        })
    })
}

/// Record why each `(uid, reason)` of entry `id` was refused, replacing an
/// older reason for that uid (a uid named twice keeps the later reason). One
/// transaction and one row rewrite for the whole round, however many uids
/// failed: the daemon holds the journal lock across this call. A uid the
/// entry no longer owes (answered, cancelled) records nothing.
pub fn note_failures(data_dir: &Path, id: u64, failures: &[(u32, String)]) -> Result<(), String> {
    note_failures_at(data_dir, id, failures, now_ms(), false)
}

/// `note_failures` at `at` (epoch ms, the caller's clock), counting one more
/// replay pass for each uid when `pass` (the worker's round; a submit's
/// rounds keep the count as it was).
pub fn note_failures_at(data_dir: &Path, id: u64, failures: &[(u32, String)], at: u64, pass: bool) -> Result<(), String> {
    if failures.is_empty() {
        return Ok(());
    }
    crate::app_db::with(data_dir, |conn| {
        crate::app_db::db::in_txn(conn, || {
            let Some(mut entry) = crate::app_db::ops::get(conn, id)?.map(row_to_entry) else { return Ok(()) };
            let mut noted = false;
            // A uid named twice in one round is one pass.
            let mut counted = std::collections::BTreeSet::new();
            for (uid, message) in failures {
                if entry.uids.contains(uid) {
                    let before = entry.failures.get(uid).map_or(0, |f| f.passes);
                    let passes = if pass && counted.insert(*uid) { before.saturating_add(1) } else { before };
                    entry.failures.insert(*uid, Failure { message: message.clone(), at, passes, stopped: false });
                    noted = true;
                }
            }
            if !noted {
                return Ok(());
            }
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
        forged.failures.insert(1, Failure { message: "forged".into(), at: 1, passes: 4, stopped: false });
        let id = queue(d.path(), forged).unwrap();
        let back = get(d.path(), id).unwrap().unwrap();
        assert_eq!((back.attempts, back.failures.len()), (0, 0));
    }

    #[test]
    fn note_failures_persist_across_a_reopen_and_keep_only_the_latest_per_uid() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1, 2], serde_json::json!({}))).unwrap();
        note_failures(d.path(), id, &[(1, "first".into())]).unwrap();
        note_failures(d.path(), id, &[(1, "second".into()), (2, "other".into())]).unwrap();

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
    fn note_failures_for_a_uid_no_longer_owed_record_nothing() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1, 2], serde_json::json!({}))).unwrap();
        note_failures(d.path(), id, &[(7, "not owed".into())]).unwrap();
        clear_by_id(d.path(), id, &[2]).unwrap();
        note_failures(d.path(), id, &[(2, "answered meanwhile".into())]).unwrap();
        assert!(get(d.path(), id).unwrap().unwrap().failures.is_empty());
        // A gone entry is not an error either.
        clear_by_id(d.path(), id, &[1]).unwrap();
        note_failures(d.path(), id, &[(1, "cancelled meanwhile".into())]).unwrap();
        assert!(get(d.path(), id).unwrap().is_none());
    }

    /// The daemon writes a whole round's refusals in one call: every reason
    /// lands, a uid named twice keeps the later one, a uid the entry does not
    /// owe is skipped, and the row is rewritten once.
    #[test]
    fn note_failures_writes_a_whole_round_at_once() {
        let d = tmp();
        let uids: Vec<u32> = (1..=50).collect();
        let id = queue(d.path(), entry("delete", &uids, serde_json::json!({}))).unwrap();
        let mut round: Vec<(u32, String)> = uids.iter().map(|uid| (*uid, format!("refused {uid}"))).collect();
        round.push((7, "refused again".into()));
        round.push((999, "not owed".into()));
        note_failures(d.path(), id, &round).unwrap();
        let row = on_disk(d.path(), id).unwrap();
        let failures: BTreeMap<u32, Failure> = serde_json::from_str(&row.failures_json).unwrap();
        assert_eq!(failures.len(), 50);
        assert_eq!(failures[&7].message, "refused again");
        assert_eq!(failures[&50].message, "refused 50");
        assert!(!failures.contains_key(&999));
        assert_eq!(row.uids_json, serde_json::to_string(&uids).unwrap(), "the uids are untouched");
        note_failures(d.path(), id, &[]).unwrap();
    }

    /// The worker's backoff count: one per replay pass that refused the uid,
    /// carried over a submit's rounds and a change of reason, durable, and
    /// absent from rows written before it existed.
    #[test]
    fn note_failures_at_counts_replay_passes_per_uid_and_keeps_them_over_a_submit() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1, 2], serde_json::json!({}))).unwrap();
        note_failures_at(d.path(), id, &[(1, "submit".into())], 10, false).unwrap();
        assert_eq!(get(d.path(), id).unwrap().unwrap().failures[&1], Failure { message: "submit".into(), at: 10, passes: 0, stopped: false });
        note_failures_at(d.path(), id, &[(1, "pass".into()), (1, "pass again".into()), (2, "pass".into())], 20, true).unwrap();
        note_failures_at(d.path(), id, &[(1, "other reason".into())], 30, true).unwrap();
        note_failures_at(d.path(), id, &[(1, "a submit round".into())], 40, false).unwrap();
        let e = get(d.path(), id).unwrap().unwrap();
        assert_eq!(e.failures[&1], Failure { message: "a submit round".into(), at: 40, passes: 2, stopped: false }, "two passes, the submit kept the count");
        assert_eq!(e.failures[&2].passes, 1);
        // A row written before the count existed reads as no passes, and a
        // zero count is not written at all.
        let old: Failure = serde_json::from_value(serde_json::json!({"message": "m", "at": 1})).unwrap();
        assert_eq!(old.passes, 0);
        assert_eq!(serde_json::to_value(&old).unwrap(), serde_json::json!({"message": "m", "at": 1}));
    }

    // ── a delete the server's renumbering stopped ──────────────────────────

    /// A stopped uid is no longer owed (nothing replays it, the app shows its
    /// row again), but the entry and the reason stay for Settings until the
    /// user cancels it there.
    #[test]
    fn a_stopped_uid_is_no_longer_owed_but_its_entry_and_reason_stay_until_cancelled() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1, 2], serde_json::json!({"uidValidity": 1}))).unwrap();
        note_failures_at(d.path(), id, &[(1, "refused".into())], 5, true).unwrap();
        stop_by_id(d.path(), id, &[(1, "errors.renumbered".into()), (2, "errors.renumbered".into()), (9, "not owed".into())], 10).unwrap();
        let e = get(d.path(), id).unwrap().expect("kept for Settings");
        assert!(e.uids.is_empty(), "nothing owed: {e:?}");
        assert_eq!(e.failures[&1], Failure { message: "errors.renumbered".into(), at: 10, passes: 1, stopped: true }, "the pass count is carried");
        assert!(e.failures[&2].stopped);
        assert!(!e.failures.contains_key(&9), "a uid the entry did not owe records nothing");
        assert_eq!(read(d.path()).len(), 1, "durable");

        // A late round's reason for a uid no longer owed records nothing.
        note_failures(d.path(), id, &[(1, "late".into())]).unwrap();
        assert_eq!(get(d.path(), id).unwrap().unwrap().failures[&1].message, "errors.renumbered");

        // The cancel clears what it names, and the emptied entry goes.
        clear_by_id(d.path(), id, &[1]).unwrap();
        assert_eq!(get(d.path(), id).unwrap().unwrap().failures.keys().copied().collect::<Vec<_>>(), vec![2]);
        clear_by_id(d.path(), id, &[2]).unwrap();
        assert!(on_disk(d.path(), id).is_none(), "cancelled: gone");
    }

    #[test]
    fn a_stop_leaves_the_rest_of_the_entry_owed_and_a_landing_keeps_the_stop() {
        let d = tmp();
        let id = queue(d.path(), entry("delete", &[1, 2], serde_json::json!({}))).unwrap();
        stop_by_id(d.path(), id, &[(1, "errors.renumbered".into())], 10).unwrap();
        let e = get(d.path(), id).unwrap().unwrap();
        assert_eq!(e.uids, vec![2]);
        assert!(e.failures[&1].stopped);
        // uid 2 lands: nothing is owed, the stop is still listed.
        clear_by_id(d.path(), id, &[2]).unwrap();
        let e = get(d.path(), id).unwrap().expect("the stop keeps the entry");
        assert!(e.uids.is_empty());
        assert_eq!(e.failures.keys().copied().collect::<Vec<_>>(), vec![1]);
        stop_by_id(d.path(), 999, &[(1, "x".into())], 1).unwrap();
    }

    #[test]
    fn a_failure_written_before_stops_existed_reads_as_not_stopped() {
        let old: Failure = serde_json::from_value(serde_json::json!({"message": "m", "at": 1, "passes": 2})).unwrap();
        assert!(!old.stopped);
        assert_eq!(serde_json::to_value(&old).unwrap(), serde_json::json!({"message": "m", "at": 1, "passes": 2}), "false is not written");
        let stopped = Failure { message: "m".into(), at: 1, passes: 0, stopped: true };
        assert_eq!(serde_json::to_value(&stopped).unwrap(), serde_json::json!({"message": "m", "at": 1, "stopped": true}));
    }

    /// The folder generation a delete was queued against, from its `arg`:
    /// absent (an app entry, an older daemon's, or none known) or not a
    /// UIDVALIDITY is `None`.
    #[test]
    fn the_recorded_generation_is_read_from_the_arg() {
        let with = |arg| OpEntry { arg, ..Default::default() }.uid_validity();
        assert_eq!(with(serde_json::json!({"mode": "trash", "uidValidity": 7})), Some(7));
        assert_eq!(with(serde_json::json!({"mode": "trash"})), None);
        assert_eq!(with(serde_json::json!({})), None);
        assert_eq!(with(serde_json::Value::Null), None);
        assert_eq!(with(serde_json::json!({"uidValidity": 0})), None, "0 is no UIDVALIDITY");
        assert_eq!(with(serde_json::json!({"uidValidity": "7"})), None);
        assert_eq!(with(serde_json::json!({"uidValidity": 1u64 << 33})), None);
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
        note_failures(d.path(), id, &[(2, "refused".into())]).unwrap();
        note_failures(d.path(), id, &[(3, "refused".into())]).unwrap();

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
        note_failures(d.path(), id, &[(1, "refused".into())]).unwrap();
        note_failures(d.path(), id, &[(2, "refused".into())]).unwrap();
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
