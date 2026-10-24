//! The two journals and the purge queue that used to be `pending_ops.json`,
//! `pending_operations.json` and `pending_backup_purge.json`.
//!
//! All three are work the user already confirmed, so nothing here starts over
//! on a read error the way the JSON readers did — a failed open is reported by
//! `app_db::db` and the caller decides.

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeMap;

/// The single in-flight bulk operation the UI is mid-way through.
pub const PENDING_OPERATION_KEY: &str = "pending_operation";

// ── Op journal ──────────────────────────────────────────────────────────────

/// One journal row: `(id, op, account_id, mailbox, uids_json, arg_json, at)`.
pub type Row = (u64, String, String, String, String, String, u64);

pub fn read(conn: &Connection) -> Vec<Row> {
    let Ok(mut stmt) = conn
        .prepare("SELECT id, op, account_id, mailbox, uids_json, arg_json, at FROM pending_ops ORDER BY id")
    else {
        return Vec::new();
    };
    stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)? as u64,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get::<_, i64>(6)? as u64,
        ))
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

/// Record an intent; the row id is assigned by the table.
pub fn queue(
    conn: &Connection,
    op: &str,
    account_id: &str,
    mailbox: &str,
    uids_json: &str,
    arg_json: &str,
    at: u64,
) -> Result<u64, String> {
    conn.execute(
        "INSERT INTO pending_ops(op, account_id, mailbox, uids_json, arg_json, at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![op, account_id, mailbox, uids_json, arg_json, at as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid() as u64)
}

/// Rewrite one row's uids, or delete it when nothing is left owed.
pub fn set_uids(conn: &Connection, id: u64, uids_json: &str, empty: bool) -> Result<(), String> {
    if empty {
        conn.execute("DELETE FROM pending_ops WHERE id = ?1", [id as i64]).map_err(|e| e.to_string())?;
    } else {
        conn.execute("UPDATE pending_ops SET uids_json = ?2 WHERE id = ?1", params![id as i64, uids_json])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Pending backup purge ────────────────────────────────────────────────────

/// One exact mirror target. Raw names are retained, never sanitized.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MirrorPurgeTarget {
    pub email: String,
    pub mailbox: String,
    pub uid: u32,
}
impl MirrorPurgeTarget {
    fn scope(&self) -> String { format!("{}|{}", self.email, self.mailbox) }
    fn valid(&self) -> bool {
        self.uid != 0 && crate::maildir::mirror_cur(std::path::Path::new("."), &self.email, &self.mailbox).is_ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum MirrorPurgeProvenance {
    Server { account_id: String, origin: String, identity: crate::bulk_worker::Identity },
    Local { receipt: crate::app_db::compose_receipts::Receipt },
}

/// Native-only handoff of an already validated original artifact. No RPC
/// accepts this type or a digest. The caller must validate original identity
/// and actual native bytes before retaining it; today's mirror supplies none.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MirrorPurgeProof {
    version: u32,
    target: MirrorPurgeTarget,
    provenance: MirrorPurgeProvenance,
    artifact: crate::bulk_worker::StoredProof,
}
impl MirrorPurgeProof {
    pub fn server(email: &str, group: &crate::bulk::Group, origin: &str,
        identity: &crate::bulk_worker::Identity, artifact: &crate::bulk_worker::StoredProof) -> Result<Self, String> {
        if !group.uids.contains(&artifact.uid) { return Err("artifact outside original group".into()); }
        // Keep only this target without cloning a whole mailbox's identity.
        let one = |ids: &std::collections::HashMap<u32,String>| ids.get(&artifact.uid)
            .map(|id| (artifact.uid,id.clone())).into_iter().collect();
        let identity = match identity {
            crate::bulk_worker::Identity::Imap { validity, message_ids } => crate::bulk_worker::Identity::Imap {
                validity: *validity, message_ids: one(message_ids),
            },
            crate::bulk_worker::Identity::Jmap { mailbox_id, ids } => crate::bulk_worker::Identity::Jmap {
                mailbox_id: mailbox_id.clone(), ids: one(ids),
            },
            crate::bulk_worker::Identity::Graph { ids } => crate::bulk_worker::Identity::Graph { ids: one(ids) },
        };
        let proof = Self { version: 1,
            target: MirrorPurgeTarget { email: email.into(), mailbox: group.mailbox.clone(), uid: artifact.uid },
            provenance: MirrorPurgeProvenance::Server { account_id: group.account_id.clone(), origin: origin.into(), identity },
            artifact: artifact.clone(),
        };
        proof.checked()
    }
    /// Only a freshly validated Present receipt can authorize a mirror
    /// artifact. Cleaned proves local absence and cannot authorize a collision.
    pub fn local(email: &str, receipt: &crate::app_db::compose_receipts::Receipt,
        artifact: &crate::bulk_worker::StoredProof) -> Result<Self, String> {
        Self { version: 1,
            target: MirrorPurgeTarget { email: email.into(), mailbox: receipt.identity.scope.mailbox.clone(), uid: artifact.uid },
            provenance: MirrorPurgeProvenance::Local { receipt: receipt.clone() }, artifact: artifact.clone(),
        }.checked()
    }
    pub fn target(&self) -> &MirrorPurgeTarget { &self.target }
    pub(crate) fn sha256(&self) -> &str { &self.artifact.sha256 }
    fn checked(self) -> Result<Self, String> {
        fn digest(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
        let uid = self.target.uid;
        let valid = self.version == 1 && self.target.valid() && self.artifact.uid == uid
            && digest(&self.artifact.sha256) && !self.artifact.name.is_empty()
            && !self.artifact.name.contains(['/', '\\', '\0'])
            && match &self.provenance {
                MirrorPurgeProvenance::Server { account_id, origin, identity } => {
                    !account_id.trim().is_empty() && digest(origin) && match identity {
                        crate::bulk_worker::Identity::Imap { validity, message_ids } => *validity != 0 && message_ids.keys().all(|u| *u == uid),
                        crate::bulk_worker::Identity::Jmap { mailbox_id, ids } => !mailbox_id.is_empty() && ids.len() == 1 && ids.get(&uid).is_some_and(|s| !s.is_empty()),
                        crate::bulk_worker::Identity::Graph { ids } => ids.len() == 1 && ids.get(&uid).is_some_and(|s| !s.is_empty()),
                    }
                }
                MirrorPurgeProvenance::Local { receipt } => receipt.is_valid()
                    && receipt.state == crate::app_db::compose_receipts::State::Present
                    && receipt.identity.scope.uid == uid && receipt.identity.scope.mailbox == self.target.mailbox
                    && receipt.identity.sha256 == self.artifact.sha256,
            };
        if valid { Ok(self) } else { Err("invalid mirror purge proof".into()) }
    }
}

/// Raw evidence stays inspectable even when this build cannot interpret it.
/// NULL is explicitly legacy UID policy; non-NULL never falls back to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeItem {
    pub scope: String,
    pub uid: u32,
    pub proof_json: Option<String>,
}
impl PurgeItem {
    pub fn proved(&self) -> Result<MirrorPurgeProof, String> {
        let proof: MirrorPurgeProof = serde_json::from_str(self.proof_json.as_deref().ok_or("legacy purge item")?).map_err(|e| e.to_string())?;
        let proof = proof.checked()?;
        if proof.target.scope() != self.scope || proof.target.uid != self.uid { return Err("mirror purge binding mismatch".into()); }
        Ok(proof)
    }
}

pub fn purge_items(conn: &Connection) -> Result<Vec<PurgeItem>, String> {
    let mut stmt = conn.prepare("SELECT scope,uid,proof_json FROM pending_backup_purge ORDER BY scope,uid").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(PurgeItem {scope:r.get(0)?,uid:r.get(1)?,proof_json:r.get(2)?})).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
}

pub fn purge_get(conn: &Connection, target: &MirrorPurgeTarget) -> Result<Option<PurgeItem>, String> {
    conn.query_row("SELECT scope,uid,proof_json FROM pending_backup_purge WHERE scope=?1 AND uid=?2",
        params![target.scope(),target.uid], |r| Ok(PurgeItem {scope:r.get(0)?,uid:r.get(1)?,proof_json:r.get(2)?}))
        .optional().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeEnqueue { Inserted, Existing, Conflict }

/// The existing key is never replaced, including legacy and future payloads.
pub fn purge_enqueue_proved(conn: &Connection, proof: &MirrorPurgeProof) -> Result<PurgeEnqueue, String> {
    proof.clone().checked()?;
    let raw = serde_json::to_string(proof).map_err(|e| e.to_string())?;
    crate::app_db::db::in_txn(conn, || {
        let n = conn.execute("INSERT OR IGNORE INTO pending_backup_purge(scope,uid,proof_json) VALUES (?1,?2,?3)",
            params![proof.target.scope(), proof.target.uid, raw]).map_err(|e| e.to_string())?;
        if n == 1 { return Ok(PurgeEnqueue::Inserted); }
        let existing: Option<String> = conn.query_row("SELECT proof_json FROM pending_backup_purge WHERE scope=?1 AND uid=?2",
            params![proof.target.scope(),proof.target.uid], |r| r.get(0)).map_err(|e| e.to_string())?;
        // Semantic equality also handles older equivalent JSON field order.
        let same = existing.as_deref().and_then(|s| serde_json::from_str::<MirrorPurgeProof>(s).ok())
            .and_then(|p| p.checked().ok()).as_ref() == Some(proof);
        Ok(if same { PurgeEnqueue::Existing } else { PurgeEnqueue::Conflict })
    })
}

/// Called after external IO and after releasing mirror exclusion. An old
/// snapshot cannot acknowledge a changed payload or any other queued target.
pub fn purge_ack(conn: &Connection, item: &PurgeItem) -> Result<bool, String> {
    conn.execute("DELETE FROM pending_backup_purge WHERE scope=?1 AND uid=?2 AND proof_json IS ?3",
        params![item.scope,item.uid,item.proof_json]).map(|n| n == 1).map_err(|e| e.to_string())
}

pub fn purge_append_legacy(conn: &Connection, queue: &BTreeMap<String, Vec<u32>>) -> Result<(), String> {
    crate::app_db::db::in_txn(conn, || {
        let mut stmt = conn.prepare_cached("INSERT OR IGNORE INTO pending_backup_purge(scope,uid) VALUES (?1,?2)").map_err(|e| e.to_string())?;
        for (scope,uids) in queue { for uid in uids { stmt.execute(params![scope,*uid]).map_err(|e| e.to_string())?; } }
        Ok(())
    })
}

pub fn purge_read(conn: &Connection) -> BTreeMap<String, Vec<u32>> {
    let Ok(mut stmt) = conn.prepare("SELECT scope, uid FROM pending_backup_purge WHERE proof_json IS NULL ORDER BY scope, uid") else {
        return BTreeMap::new();
    };
    let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))) else {
        return BTreeMap::new();
    };
    let mut out: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (scope, uid) in rows.filter_map(Result::ok) {
        out.entry(scope).or_default().push(uid);
    }
    out
}

/// Compatibility replacement touches only legacy rows. Protected, malformed
/// and future non-NULL payloads cannot be downgraded or dropped here.
pub fn purge_write(conn: &Connection, queue: &BTreeMap<String, Vec<u32>>) -> Result<(), String> {
    crate::app_db::db::in_txn(conn, || {
        conn.execute("DELETE FROM pending_backup_purge WHERE proof_json IS NULL", []).map_err(|e| e.to_string())?;
        purge_append_legacy(conn, queue)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn(name: &str) -> (std::path::PathBuf, Connection) {
        let p = std::env::temp_dir().join(format!("mv-ops-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        let c = db::open(&p).unwrap();
        (p, c)
    }

    #[test]
    fn queued_ops_come_back_oldest_first_with_rising_ids() {
        let (dir, c) = conn("order");
        let a = queue(&c, "delete", "acc", "INBOX", "[1]", "{}", 10).unwrap();
        let b = queue(&c, "flag", "acc", "INBOX", "[2]", "{\"action\":\"add\"}", 11).unwrap();
        assert!(b > a);
        let rows = read(&c);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1, "delete");
        assert_eq!(rows[1].1, "flag");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_emptied_row_is_removed() {
        let (dir, c) = conn("empty");
        let id = queue(&c, "delete", "acc", "INBOX", "[1]", "{}", 1).unwrap();
        set_uids(&c, id, "[]", true).unwrap();
        assert!(read(&c).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn protected_purge_legacy_roundtrip_preserves_opaque_proof() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE pending_backup_purge(scope TEXT NOT NULL, uid INTEGER NOT NULL, proof_json TEXT, PRIMARY KEY(scope,uid));
            INSERT INTO pending_backup_purge VALUES ('a|INBOX',7,'{future opaque proof}');
            INSERT INTO pending_backup_purge VALUES ('a|INBOX',8,NULL);").unwrap();
        assert_eq!(purge_read(&c), BTreeMap::from([("a|INBOX".into(), vec![8])]));
        purge_write(&c, &BTreeMap::from([("a|INBOX".into(), vec![7,9])])).unwrap();
        let proof: String = c.query_row("SELECT proof_json FROM pending_backup_purge WHERE uid=7", [], |r| r.get(0)).unwrap();
        assert_eq!(proof, "{future opaque proof}");
        assert_eq!(purge_read(&c), BTreeMap::from([("a|INBOX".into(), vec![9])]));
        purge_write(&c, &BTreeMap::new()).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM pending_backup_purge", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
    }

    fn protected_proof(bytes: &[u8]) -> MirrorPurgeProof {
        MirrorPurgeProof::server("me@test", &crate::bulk::Group {
            account_id: "account".into(), mailbox: "INBOX".into(), uids: vec![7],
        }, &"a".repeat(64), &crate::bulk_worker::Identity::Imap {
            validity: 19, message_ids: Default::default(),
        }, &crate::bulk_worker::StoredProof {
            uid: 7, name: "7.eml".into(), sha256: crate::bulk_worker::bytes_hash(bytes),
        }).unwrap()
    }

    #[test]
    fn protected_purge_enqueue_is_atomic_idempotent_and_conflict_preserving() {
        let (dir, c) = conn("protected-enqueue");
        let a = protected_proof(b"A");
        let b = protected_proof(b"B");
        assert_eq!(purge_enqueue_proved(&c, &a).unwrap(), PurgeEnqueue::Inserted);
        assert_eq!(purge_enqueue_proved(&c, &a).unwrap(), PurgeEnqueue::Existing);
        assert_eq!(purge_enqueue_proved(&c, &b).unwrap(), PurgeEnqueue::Conflict);
        let rows = purge_items(&c).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].proved().unwrap(), a);
        assert!(purge_read(&c).is_empty());
        assert!(purge_ack(&c, &rows[0]).unwrap());
        purge_append_legacy(&c, &BTreeMap::from([("me@test|INBOX".into(), vec![7])])).unwrap();
        assert_eq!(purge_enqueue_proved(&c, &a).unwrap(), PurgeEnqueue::Conflict);
        assert_eq!(purge_read(&c).get("me@test|INBOX"), Some(&vec![7]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn protected_purge_ack_compares_payload_and_preserves_concurrent_items() {
        let (dir, c) = conn("protected-ack");
        purge_enqueue_proved(&c, &protected_proof(b"A")).unwrap();
        let stale = purge_items(&c).unwrap().remove(0);
        let other = db::open(&dir).unwrap();
        other.execute("UPDATE pending_backup_purge SET proof_json='future changed payload' WHERE uid=7", []).unwrap();
        purge_append_legacy(&other, &BTreeMap::from([("another|Sent".into(), vec![8])])).unwrap();
        assert!(!purge_ack(&c, &stale).unwrap());
        assert_eq!(purge_items(&c).unwrap().len(), 2);
        let changed = purge_items(&c).unwrap().into_iter().find(|r| r.uid == 7).unwrap();
        assert_eq!(changed.proof_json.as_deref(), Some("future changed payload"));
        assert!(changed.proved().is_err());
        let legacy = purge_items(&c).unwrap().into_iter().find(|r| r.uid == 8).unwrap();
        assert!(purge_ack(&c, &legacy).unwrap());
        assert_eq!(purge_items(&c).unwrap(), vec![changed]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn protected_purge_native_provenance_rejects_cleaned_or_mismatched_local_receipt() {
        use crate::app_db::compose_receipts::{Identity, Scope, Receipt, State};
        let raw = b"Message-ID: <m@test>\r\n\r\nA";
        let mut receipt = Receipt::present(Identity::from_bytes(Scope::new("account", "Drafts", 7, "m@test").unwrap(), raw).unwrap());
        let artifact = crate::bulk_worker::StoredProof {uid:7, name:"7.eml".into(), sha256:crate::bulk_worker::bytes_hash(raw)};
        let proof = MirrorPurgeProof::local("me@test", &receipt, &artifact).unwrap();
        let (dir,c) = conn("protected-local");
        purge_enqueue_proved(&c,&proof).unwrap();
        assert_eq!(purge_items(&c).unwrap()[0].proved().unwrap(), proof);
        receipt.state = State::Cleaned;
        assert!(MirrorPurgeProof::local("me@test", &receipt, &artifact).is_err());
        receipt.state = State::Present;
        receipt.identity.sha256 = crate::bulk_worker::bytes_hash(b"B");
        assert!(MirrorPurgeProof::local("me@test", &receipt, &artifact).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_purge_queue_round_trips() {
        let (dir, c) = conn("purge");
        let mut q = BTreeMap::new();
        q.insert("acc|INBOX".to_string(), vec![4u32, 9]);
        q.insert("acc|Sent".to_string(), vec![2u32]);
        purge_write(&c, &q).unwrap();
        assert_eq!(purge_read(&c), q);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_the_purge_queue_replaces_it() {
        let (dir, c) = conn("purge-replace");
        let mut q = BTreeMap::new();
        q.insert("a".to_string(), vec![1u32, 2]);
        purge_write(&c, &q).unwrap();
        purge_write(&c, &BTreeMap::new()).unwrap();
        assert!(purge_read(&c).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pending_operation_is_one_meta_row() {
        let (dir, c) = conn("pending-op");
        assert_eq!(db::meta_get(&c, PENDING_OPERATION_KEY), None);
        db::meta_set(&c, PENDING_OPERATION_KEY, "{\"kind\":\"delete\"}").unwrap();
        assert_eq!(db::meta_get(&c, PENDING_OPERATION_KEY).as_deref(), Some("{\"kind\":\"delete\"}"));
        db::meta_clear(&c, PENDING_OPERATION_KEY).unwrap();
        assert_eq!(db::meta_get(&c, PENDING_OPERATION_KEY), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
