//! Local u32 uids for servers that name messages by opaque strings (Graph ids, JMAP ids), plan
//! Ruling 7: `remote_ids` maps `(account, folder, uid)` to the remote id, and `uid_seq` hands out
//! the account's uids, so paging, actions, bodies and attachments keep their
//! `(account, folder, uid)` identity. A remote id keeps its uid for as long as its row exists; a
//! message Graph moves gets a new remote id, so a new uid in its new folder, and the old mapping is
//! removed with the old row (`sync::delete_uids`) or by the move itself.
//!
//! Every write here runs inside the caller's write transaction, which holds at most 200 rows.

use rusqlite::{Connection, OptionalExtension};

/// The uid of `remote_id` in `folder`, allocated from `uid_seq` the first time it is seen. A
/// remote id mapped in another folder of the account (a server whose ids survive a move) moves
/// to `folder` with its uid.
#[allow(dead_code)] // The one-id form of the plan's interface; JMAP (Task 10) and the tests use it.
pub(crate) fn uid_for(tx: &Connection, account: &str, folder: &str, remote_id: &str) -> rusqlite::Result<u32> {
    Ok(uids_for(tx, account, folder, &[remote_id.to_string()])?[0])
}

/// [`uid_for`] of each of `ids`, in order; new ones get consecutive uids in the order given, with
/// one `uid_seq` write for all of them. Changes at most `ids.len() + 1` rows.
pub(crate) fn uids_for(tx: &Connection, account: &str, folder: &str, ids: &[String]) -> rusqlite::Result<Vec<u32>> {
    let mut next: Option<i64> = None;
    let mut out = Vec::with_capacity(ids.len());
    for remote_id in ids {
        let known: Option<(String, i64)> = tx
            .prepare_cached("SELECT folder, uid FROM remote_ids WHERE account_id = ?1 AND remote_id = ?2")?
            .query_row((account, remote_id), |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((was, uid)) = known {
            if was != folder {
                tx.execute("UPDATE remote_ids SET folder = ?3 WHERE account_id = ?1 AND remote_id = ?2", (account, remote_id, folder))?;
            }
            out.push(uid as u32);
            continue;
        }
        let uid = match next {
            Some(n) => n,
            None => tx.query_row("SELECT next FROM uid_seq WHERE account_id = ?1", [account], |r| r.get(0)).optional()?.unwrap_or(1),
        };
        tx.prepare_cached("INSERT INTO remote_ids (account_id, folder, uid, remote_id) VALUES (?1, ?2, ?3, ?4)")?
            .execute((account, folder, uid, remote_id))?;
        next = Some(uid + 1);
        out.push(uid as u32);
    }
    if let Some(n) = next {
        tx.execute(
            "INSERT INTO uid_seq (account_id, next) VALUES (?1, ?2) ON CONFLICT (account_id) DO UPDATE SET next = excluded.next",
            (account, n),
        )?;
    }
    Ok(out)
}

/// The remote id of `uid` in `folder`, `None` when it has none (never seen, or gone).
pub(crate) fn remote_for(c: &Connection, account: &str, folder: &str, uid: u32) -> rusqlite::Result<Option<String>> {
    c.query_row("SELECT remote_id FROM remote_ids WHERE account_id = ?1 AND folder = ?2 AND uid = ?3", (account, folder, uid as i64), |r| {
        r.get(0)
    })
    .optional()
}

/// Every mapping of `folder`: remote id -> uid.
pub(crate) fn folder_map(c: &Connection, account: &str, folder: &str) -> rusqlite::Result<std::collections::HashMap<String, u32>> {
    let mut st = c.prepare_cached("SELECT remote_id, uid FROM remote_ids WHERE account_id = ?1 AND folder = ?2")?;
    let rows = st.query_map((account, folder), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32)))?;
    rows.collect()
}

/// Removes the mapping of `uid` in `folder`.
pub(crate) fn forget(c: &Connection, account: &str, folder: &str, uid: u32) -> rusqlite::Result<usize> {
    c.execute("DELETE FROM remote_ids WHERE account_id = ?1 AND folder = ?2 AND uid = ?3", (account, folder, uid as i64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE remote_ids (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, remote_id TEXT NOT NULL,
               PRIMARY KEY (account_id, folder, uid), UNIQUE (account_id, remote_id)) WITHOUT ROWID;
             CREATE TABLE uid_seq (account_id TEXT PRIMARY KEY, next INTEGER NOT NULL) WITHOUT ROWID;",
        )
        .unwrap();
        c
    }

    #[test]
    fn uids_are_stable_per_remote_id_and_ascend_per_account() {
        let c = db();
        assert_eq!(uid_for(&c, "a", "INBOX", "m1").unwrap(), 1);
        assert_eq!(uid_for(&c, "a", "INBOX", "m2").unwrap(), 2);
        assert_eq!(uid_for(&c, "a", "INBOX", "m1").unwrap(), 1, "stable");
        assert_eq!(uid_for(&c, "a", "Other", "m3").unwrap(), 3, "one sequence per account");
        assert_eq!(uid_for(&c, "b", "INBOX", "m1").unwrap(), 1, "accounts are apart");
        assert_eq!(remote_for(&c, "a", "INBOX", 2).unwrap().as_deref(), Some("m2"));
        assert_eq!(remote_for(&c, "a", "Other", 2).unwrap(), None);
        assert_eq!(forget(&c, "a", "INBOX", 2).unwrap(), 1);
        assert_eq!(remote_for(&c, "a", "INBOX", 2).unwrap(), None);
        // A forgotten id seen again gets a new uid, never an old one.
        assert_eq!(uid_for(&c, "a", "INBOX", "m2").unwrap(), 4);
        // An id that moves folders keeps its uid.
        assert_eq!(uid_for(&c, "a", "Other", "m1").unwrap(), 1);
        assert_eq!(remote_for(&c, "a", "Other", 1).unwrap().as_deref(), Some("m1"));
        assert_eq!(folder_map(&c, "a", "INBOX").unwrap().len(), 1);
        // A batch: known ids keep theirs, new ones follow on in the order given.
        let ids: Vec<String> = ["m2", "n1", "n2"].iter().map(|s| s.to_string()).collect();
        assert_eq!(uids_for(&c, "a", "INBOX", &ids).unwrap(), vec![4, 5, 6]);
        assert_eq!(uid_for(&c, "a", "INBOX", "n3").unwrap(), 7);
    }
}
