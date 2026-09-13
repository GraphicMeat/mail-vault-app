//! What the app records per stored message, one JSON object per (account,
//! raw mailbox path, uid). No field is modelled: `entry_json` is the object
//! the caller handed over, byte for byte, so nothing a future writer adds
//! is lost here. `mailbox_path` is the RAW server path (`Projects/2026`),
//! exactly what the per-mailbox files nested by.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashSet;

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// The entry's uid when it has a numeric one in u32 range; nothing else is
/// addressable (the old files kept such entries, and nothing could read them).
pub fn uid_of(entry: &Value) -> Option<u32> {
    entry.get("uid").and_then(|u| u.as_u64()).and_then(|u| u32::try_from(u).ok())
}

/// The mailbox's entries as one JSON array string, in uid order. `None` when
/// it has none: the caller falls back to a vault scan, as it did for a
/// mailbox without an index file.
pub fn read(conn: &Connection, account_id: &str, mailbox: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare_cached("SELECT entry_json FROM vault_entries WHERE account_id = ?1 AND mailbox_path = ?2 ORDER BY uid")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![account_id, mailbox], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    if rows.is_empty() {
        return Ok(None);
    }
    // Each stored value is a complete JSON object: the array is a join, no re-serialisation.
    Ok(Some(format!("[{}]", rows.join(","))))
}

/// Replace-by-uid, one transaction. `(written, skipped)`: entries without a
/// usable uid are skipped and counted.
pub fn upsert(conn: &Connection, account_id: &str, mailbox: &str, entries: &[Value]) -> Result<(usize, usize), String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let (mut written, mut skipped) = (0, 0);
    {
        let mut stmt = tx
            .prepare_cached("INSERT OR REPLACE INTO vault_entries(account_id, mailbox_path, uid, entry_json) VALUES (?1, ?2, ?3, ?4)")
            .map_err(err)?;
        for entry in entries {
            let Some(uid) = uid_of(entry) else {
                skipped += 1;
                continue;
            };
            let json = serde_json::to_string(entry).map_err(|e| e.to_string())?;
            stmt.execute(params![account_id, mailbox, uid, json]).map_err(err)?;
            written += 1;
        }
    }
    tx.commit().map_err(err)?;
    Ok((written, skipped))
}

pub fn remove(conn: &Connection, account_id: &str, mailbox: &str, uids: &[u32]) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut n = 0;
    {
        let mut stmt = tx
            .prepare_cached("DELETE FROM vault_entries WHERE account_id = ?1 AND mailbox_path = ?2 AND uid = ?3")
            .map_err(err)?;
        for uid in uids {
            n += stmt.execute(params![account_id, mailbox, uid]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)?;
    Ok(n)
}

/// Set `$.flags` on each uid's entry, one transaction; how many entries
/// changed. An entry that already says this, or a uid with no entry, counts 0.
pub fn patch_flags_many(conn: &Connection, account_id: &str, mailbox: &str, changes: &[(u32, Vec<String>)]) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut n = 0;
    {
        let mut stmt = tx
            .prepare_cached(
                "UPDATE vault_entries SET entry_json = json_set(entry_json, '$.flags', json(?4)) \
                 WHERE account_id = ?1 AND mailbox_path = ?2 AND uid = ?3 \
                   AND (json_extract(entry_json, '$.flags') IS NULL OR json_extract(entry_json, '$.flags') != json(?4))",
            )
            .map_err(err)?;
        for (uid, flags) in changes {
            let flags_json = serde_json::to_string(flags).map_err(|e| e.to_string())?;
            n += stmt.execute(params![account_id, mailbox, uid, flags_json]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)?;
    Ok(n)
}

/// Uids of messages composed here (`local_sent`, `local_draft`): a UID
/// reissue on the server says nothing about them.
pub fn local_uids(conn: &Connection, account_id: &str, mailbox: &str) -> Result<HashSet<u32>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT uid FROM vault_entries WHERE account_id = ?1 AND mailbox_path = ?2 \
             AND json_extract(entry_json, '$.source') IN ('local_sent', 'local_draft')",
        )
        .map_err(err)?;
    // Bound to a local: the collected result is a temporary borrowing `stmt`,
    // and as a tail expression it would outlive the statement it reads from.
    let uids = stmt
        .query_map(params![account_id, mailbox], |r| r.get::<_, u32>(0))
        .map_err(err)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(err)?;
    Ok(uids)
}

/// Follow a generation repair: orphaned uids' entries go, rebound ones move
/// to their new uid (the entry's own `uid` field too). One transaction. Every
/// moving entry is read before any is written, so a chain (5→6, 6→7) lands
/// each entry under the uid its file now has.
pub fn remap(conn: &Connection, account_id: &str, mailbox: &str, rebound: &[(u32, u32)], orphaned: &[u32]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    {
        let mut del = tx
            .prepare_cached("DELETE FROM vault_entries WHERE account_id = ?1 AND mailbox_path = ?2 AND uid = ?3")
            .map_err(err)?;
        for uid in orphaned {
            del.execute(params![account_id, mailbox, uid]).map_err(err)?;
        }
        let mut moving: Vec<(u32, Value)> = Vec::new();
        {
            let mut sel = tx
                .prepare_cached("SELECT entry_json FROM vault_entries WHERE account_id = ?1 AND mailbox_path = ?2 AND uid = ?3")
                .map_err(err)?;
            for (old, new) in rebound {
                let json: Option<String> = sel
                    .query_row(params![account_id, mailbox, old], |r| r.get(0))
                    .optional()
                    .map_err(err)?;
                if let Some(json) = json {
                    let mut entry: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
                    // Nothing this app wrote is anything but an object, and a row
                    // that is not one has no `uid` field to rewrite: it stays where
                    // it is rather than aborting the process on an index panic.
                    let Some(obj) = entry.as_object_mut() else { continue };
                    obj.insert("uid".to_string(), Value::from(*new));
                    moving.push((*old, entry));
                }
            }
        }
        for (old, _) in &moving {
            del.execute(params![account_id, mailbox, old]).map_err(err)?;
        }
        let mut ins = tx
            .prepare_cached("INSERT OR REPLACE INTO vault_entries(account_id, mailbox_path, uid, entry_json) VALUES (?1, ?2, ?3, ?4)")
            .map_err(err)?;
        for (_, entry) in &moving {
            let Some(uid) = uid_of(entry) else { continue };
            ins.execute(params![account_id, mailbox, uid, serde_json::to_string(entry).map_err(|e| e.to_string())?]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

/// A folder rename: the entries of `from` become entries of `to`. Exact path
/// only: the caller sends one pair per descendant (the server renames a
/// subtree in one command, the vault keeps a directory per full path). A row
/// already at `to` for the same uid is replaced.
pub fn rename_mailbox(conn: &Connection, account_id: &str, from: &str, to: &str) -> Result<usize, String> {
    conn.execute(
        "UPDATE OR REPLACE vault_entries SET mailbox_path = ?3 WHERE account_id = ?1 AND mailbox_path = ?2",
        params![account_id, from, to],
    )
    .map_err(err)
}

/// Every entry of one account as `(mailbox_path, entry)`, mailbox then uid order.
pub fn entries_for_account(conn: &Connection, account_id: &str) -> Result<Vec<(String, Value)>, String> {
    let mut stmt = conn
        .prepare_cached("SELECT mailbox_path, entry_json FROM vault_entries WHERE account_id = ?1 ORDER BY mailbox_path, uid")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![account_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows
        .into_iter()
        .filter_map(|(m, json)| serde_json::from_str::<Value>(&json).ok().map(|v| (m, v)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db::open;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, Connection) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open(tmp.path()).unwrap();
        (tmp, conn)
    }

    fn parsed(conn: &Connection, account: &str, mailbox: &str) -> Vec<Value> {
        read(conn, account, mailbox).unwrap().map(|s| serde_json::from_str(&s).unwrap()).unwrap_or_default()
    }

    /// Every custody field the 2026-09-13 reader/writer inventory found.
    fn full_entry() -> Value {
        json!({
            "uid": 7, "subject": "Invoice", "from": {"address": "a@x.test", "name": "Ann"},
            "to": [{"address": "b@x.test", "name": null}], "cc": [], "bcc": [],
            "date": "Tue, 08 Sep 2026 23:00:00 +0000", "messageDate": "2026-09-08T23:00:00Z",
            "receivedAt": "2026-09-09T00:30:00Z", "sentAt": null, "provider": null,
            "flags": ["\\Seen"], "has_attachments": true, "message_id": "<m7@x.test>",
            "in_reply_to": "<m1@x.test>", "references": ["<m0@x.test>", "<m1@x.test>"], "snippet": "hello",
            "listId": null, "listUnsubscribe": null, "precedence": null,
            "source": "local", "serverDeleted": true, "serverAbsent": false, "serverAbsentAt": null,
            "_external_copy_failed": true
        })
    }

    #[test]
    fn read_returns_none_for_a_mailbox_without_entries_and_the_array_otherwise() {
        let (_t, c) = store();
        assert_eq!(read(&c, "a", "INBOX").unwrap(), None);
        upsert(&c, "a", "INBOX", &[json!({"uid": 9, "source": "local"}), json!({"uid": 3, "source": "local_sent"})]).unwrap();
        let rows = parsed(&c, "a", "INBOX");
        assert_eq!(rows.iter().map(|e| e["uid"].as_u64().unwrap()).collect::<Vec<_>>(), vec![3, 9], "uid order");
        assert_eq!(read(&c, "a", "Archive").unwrap(), None, "another mailbox");
        assert_eq!(read(&c, "b", "INBOX").unwrap(), None, "another account");
    }

    #[test]
    fn upsert_replaces_by_uid_and_keeps_every_field_byte_for_byte() {
        let (_t, c) = store();
        assert_eq!(upsert(&c, "a", "INBOX", &[full_entry()]).unwrap(), (1, 0));
        assert_eq!(parsed(&c, "a", "INBOX"), vec![full_entry()]);
        // Re-appending the same uid with one more field replaces, never duplicates
        // (`markServerDeleted` re-appends an entry to add a field).
        let mut again = full_entry();
        again["serverAbsent"] = json!(true);
        upsert(&c, "a", "INBOX", &[again.clone()]).unwrap();
        assert_eq!(parsed(&c, "a", "INBOX"), vec![again]);
    }

    #[test]
    fn upsert_skips_an_entry_without_a_uid_and_says_so() {
        let (_t, c) = store();
        assert_eq!(upsert(&c, "a", "INBOX", &[json!({"subject": "no uid"}), json!({"uid": "7"}), json!({"uid": 8})]).unwrap(), (1, 2));
        assert_eq!(parsed(&c, "a", "INBOX").len(), 1);
    }

    #[test]
    fn mailbox_paths_are_stored_raw_and_nested() {
        let (_t, c) = store();
        upsert(&c, "a", "Projects/2026", &[json!({"uid": 1})]).unwrap();
        upsert(&c, "a", "Projects", &[json!({"uid": 2})]).unwrap();
        assert_eq!(parsed(&c, "a", "Projects/2026")[0]["uid"], 1);
        assert_eq!(parsed(&c, "a", "Projects")[0]["uid"], 2);
    }

    #[test]
    fn remove_deletes_only_the_named_uids() {
        let (_t, c) = store();
        upsert(&c, "a", "INBOX", &[json!({"uid": 101}), json!({"uid": 102}), json!({"uid": 103}), json!({"uid": 1010})]).unwrap();
        assert_eq!(remove(&c, "a", "INBOX", &[102, 999]).unwrap(), 1);
        assert_eq!(parsed(&c, "a", "INBOX").iter().map(|e| e["uid"].as_u64().unwrap()).collect::<Vec<_>>(), vec![101, 103, 1010]);
        assert_eq!(remove(&c, "a", "Nope", &[1]).unwrap(), 0, "an unknown mailbox is not an error");
    }

    #[test]
    fn patch_flags_many_patches_500_entries_in_one_call_and_counts_only_changes() {
        let (_t, c) = store();
        let entries: Vec<Value> = (1..=500).map(|uid| json!({"uid": uid, "flags": if uid % 2 == 0 { json!(["\\Seen"]) } else { json!([]) }})).collect();
        upsert(&c, "a", "INBOX", &entries).unwrap();
        let changes: Vec<(u32, Vec<String>)> = (1..=500).map(|uid| (uid, vec!["\\Seen".to_string()])).collect();
        assert_eq!(patch_flags_many(&c, "a", "INBOX", &changes).unwrap(), 250);
        let rows = parsed(&c, "a", "INBOX");
        assert!(rows.iter().all(|e| e["flags"] == json!(["\\Seen"])));
        assert_eq!(patch_flags_many(&c, "a", "INBOX", &changes).unwrap(), 0, "already says this");
        assert_eq!(patch_flags_many(&c, "a", "INBOX", &[(9999, vec![])]).unwrap(), 0, "no entry, nothing invented");
        assert_eq!(rows.len(), 500);
    }

    #[test]
    fn patch_flags_adds_a_flags_field_an_entry_never_had_and_keeps_the_rest() {
        let (_t, c) = store();
        upsert(&c, "a", "INBOX", &[json!({"uid": 7, "subject": "s", "source": "local_draft"})]).unwrap();
        assert_eq!(patch_flags_many(&c, "a", "INBOX", &[(7, vec!["\\Seen".into(), "\\Flagged".into()])]).unwrap(), 1);
        assert_eq!(parsed(&c, "a", "INBOX")[0], json!({"uid": 7, "subject": "s", "source": "local_draft", "flags": ["\\Seen", "\\Flagged"]}));
    }

    #[test]
    fn local_uids_names_only_sent_and_draft_entries() {
        let (_t, c) = store();
        upsert(&c, "a", "INBOX", &[
            json!({"uid": 1, "source": "local"}), json!({"uid": 2, "source": "local_sent"}),
            json!({"uid": 3, "source": "local_draft"}), json!({"uid": 4}),
        ]).unwrap();
        upsert(&c, "a", "Sent", &[json!({"uid": 5, "source": "local_sent"})]).unwrap();
        let got = local_uids(&c, "a", "INBOX").unwrap();
        assert_eq!(got, HashSet::from([2, 3]));
    }

    #[test]
    fn remap_moves_rebound_entries_and_drops_orphaned_ones_even_in_a_chain() {
        let (_t, c) = store();
        upsert(&c, "a", "INBOX", &[json!({"uid": 5, "k": "five"}), json!({"uid": 6, "k": "six"}), json!({"uid": 9, "k": "nine"}), json!({"uid": 20, "k": "stays"})]).unwrap();
        // 5 -> 6 and 6 -> 7 at once: the second pair's old uid is the first pair's new one.
        remap(&c, "a", "INBOX", &[(5, 6), (6, 7)], &[9]).unwrap();
        let rows = parsed(&c, "a", "INBOX");
        assert_eq!(rows, vec![json!({"uid": 6, "k": "five"}), json!({"uid": 7, "k": "six"}), json!({"uid": 20, "k": "stays"})]);
        remap(&c, "a", "INBOX", &[(404, 405)], &[406]).unwrap(); // nothing to move: not an error
        assert_eq!(parsed(&c, "a", "INBOX").len(), 3);
    }

    #[test]
    fn remap_leaves_a_row_that_is_not_an_object_alone() {
        let (_t, c) = store();
        c.execute("INSERT INTO vault_entries VALUES ('a','INBOX',5,'42')", []).unwrap();
        upsert(&c, "a", "INBOX", &[json!({"uid": 6})]).unwrap();
        remap(&c, "a", "INBOX", &[(5, 50), (6, 60)], &[]).unwrap();
        let rows: Vec<(u32, String)> = c
            .prepare("SELECT uid, entry_json FROM vault_entries WHERE account_id = 'a' AND mailbox_path = 'INBOX' ORDER BY uid")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows, vec![(5, "42".to_string()), (60, "{\"uid\":60}".to_string())]);
    }

    #[test]
    fn rename_mailbox_moves_only_the_exact_path() {
        let (_t, c) = store();
        upsert(&c, "a", "Projects", &[json!({"uid": 1})]).unwrap();
        upsert(&c, "a", "Projects/Alpha", &[json!({"uid": 2})]).unwrap();
        upsert(&c, "b", "Projects", &[json!({"uid": 3})]).unwrap();
        assert_eq!(rename_mailbox(&c, "a", "Projects", "Archive/Projects").unwrap(), 1);
        assert_eq!(parsed(&c, "a", "Archive/Projects")[0]["uid"], 1);
        assert_eq!(read(&c, "a", "Projects").unwrap(), None);
        assert_eq!(parsed(&c, "a", "Projects/Alpha")[0]["uid"], 2, "the descendant gets its own pair from the caller");
        assert_eq!(parsed(&c, "b", "Projects")[0]["uid"], 3, "another account");
        // A row already at the destination for the same uid is replaced, not doubled.
        upsert(&c, "a", "Old", &[json!({"uid": 1, "k": "old"})]).unwrap();
        assert_eq!(rename_mailbox(&c, "a", "Old", "Archive/Projects").unwrap(), 1);
        assert_eq!(parsed(&c, "a", "Archive/Projects"), vec![json!({"uid": 1, "k": "old"})]);
    }

    #[test]
    fn entries_for_account_returns_every_mailbox_in_order_and_nothing_from_another_account() {
        let (_t, c) = store();
        upsert(&c, "a", "Sent", &[json!({"uid": 2}), json!({"uid": 1})]).unwrap();
        upsert(&c, "a", "INBOX", &[json!({"uid": 9})]).unwrap();
        upsert(&c, "b", "INBOX", &[json!({"uid": 1})]).unwrap();
        let got = entries_for_account(&c, "a").unwrap();
        assert_eq!(
            got.iter().map(|(m, e)| (m.as_str(), e["uid"].as_u64().unwrap())).collect::<Vec<_>>(),
            vec![("INBOX", 9), ("Sent", 1), ("Sent", 2)]
        );
        assert!(entries_for_account(&c, "nobody").unwrap().is_empty());
    }
}
