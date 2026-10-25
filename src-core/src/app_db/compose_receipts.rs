//! Native compose ownership in existing app.db meta. No UI value creates proof.
//! A receipt is scoped to one local tuple AND its exact bytes. Callers retain
//! the complete proof in pending work before exact retirement; receipts confer
//! no server UID, mirror or scheduled-queue authority.
use super::{db, Connection};
use crate::{bulk_worker::bytes_hash, compose::normalize_message_id, maildir};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub account_id: String,
    pub mailbox: String,
    pub uid: u32,
    pub message_id: String,
}
impl Scope {
    pub fn new(account_id: &str, mailbox: &str, uid: u32, message_id: &str) -> Option<Self> {
        if account_id.trim().is_empty() || mailbox.is_empty() || uid == 0 { return None; }
        Some(Self { account_id: account_id.into(), mailbox: mailbox.into(), uid, message_id: normalize_message_id(message_id)? })
    }
    fn prefix(&self) -> String {
        let tuple = serde_json::to_vec(self).expect("typed compose scope");
        format!("{}{}:", account_prefix(&self.account_id), bytes_hash(&tuple))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    #[serde(flatten)]
    pub scope: Scope,
    pub sha256: String,
}
impl Identity {
    pub fn from_bytes(scope: Scope, raw: &[u8]) -> Option<Self> {
        let mid = maildir::message_id_in(raw).and_then(|s| normalize_message_id(&s));
        (mid.as_deref() == Some(scope.message_id.as_str())).then(|| Self { scope, sha256: bytes_hash(raw) })
    }
    pub fn matches_bytes(&self, raw: &[u8]) -> bool {
        Self::from_bytes(self.scope.clone(), raw).as_ref() == Some(self)
    }
    fn key(&self) -> String { format!("{}{}", self.scope.prefix(), self.sha256) }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State { Present, Cleaned }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub version: u32,
    pub identity: Identity,
    pub state: State,
}
impl Receipt {
    pub fn present(identity: Identity) -> Self { Self { version: 1, identity, state: State::Present } }
    pub fn is_valid(&self) -> bool {
        let s = &self.identity.scope;
        self.version == 1 && Scope::new(&s.account_id, &s.mailbox, s.uid, &s.message_id).as_ref() == Some(s)
            && self.identity.sha256.len() == 64 && self.identity.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}
fn account_prefix(account: &str) -> String { format!("compose_receipt:{}:", bytes_hash(account.as_bytes())) }

/// Native lifecycle writer. A cleaned record is persisted BEFORE removing the
/// last custody evidence. Readers must still prove actual absence under the
/// mailbox lock; a crash can leave the exact copy present.
pub fn save(conn: &Connection, receipt: &Receipt) -> Result<(), String> {
    if !receipt.is_valid() { return Err("invalid compose receipt".into()); }
    db::meta_set(conn, &receipt.identity.key(), &serde_json::to_string(receipt).map_err(|e| e.to_string())?)
}

/// All digests for an exact tuple. Multiple digests need an original native
/// digest to disambiguate; a current same-MID file cannot choose for the caller.
pub fn load(conn: &Connection, scope: &Scope) -> Result<Vec<Receipt>, String> {
    let prefix = scope.prefix();
    let upper = format!("{prefix}~");
    let mut q = conn.prepare("SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2").map_err(|e| e.to_string())?;
    let rows = q.query_map(params![prefix, upper], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (key, raw) = row.map_err(|e| e.to_string())?;
        let receipt: Receipt = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if !receipt.is_valid() || receipt.identity.scope != *scope || receipt.identity.key() != key {
            return Err("invalid compose receipt".into());
        }
        out.push(receipt);
    }
    Ok(out)
}

/// Private read-only receipt inventory for one physical tuple across MIDs.
/// Enumeration runs off mailbox/custody/shared app.db locks. Keep this reader
/// alive, with no open statement or transaction, through the final scalar.
/// Participating publishers must also hold the tuple's mailbox serialization;
/// data_version alone does not fence arbitrary external SQL writers.
pub struct TupleInventory {
    conn: Connection,
    version: i64,
    receipts: Vec<Receipt>,
}

impl TupleInventory {
    /// Bounded freshness check only; never enumerate account history here.
    pub fn current(&self) -> Result<&[Receipt], String> {
        if !self.conn.is_autocommit() || data_version(&self.conn)? != self.version {
            return Err("compose receipt inventory changed; retry".into());
        }
        Ok(&self.receipts)
    }
}

fn data_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
thread_local! {
    static TUPLE_SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The ordinary app.db handle must already be initialized by the caller.
/// Missing/unreadable/unknown account evidence is unresolved, never absence.
pub fn inventory_tuple(
    app_dir: &std::path::Path,
    account: &str,
    mailbox: &str,
    uid: u32,
) -> Result<TupleInventory, String> {
    if account.trim().is_empty() || mailbox.is_empty() || uid == 0 {
        return Err("invalid compose receipt tuple".into());
    }
    let conn = Connection::open_with_flags(
        db::db_path(app_dir),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| error.to_string())?;
    let version = data_version(&conn)?;
    let prefix = account_prefix(account);
    let upper = format!("{prefix}~");
    #[cfg(test)]
    TUPLE_SCANS.with(|count| count.set(count.get() + 1));
    let receipts = {
        let mut query = conn
            .prepare("SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2")
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map(params![prefix, upper], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut matching = Vec::new();
        for row in rows {
            let (key, raw) = row.map_err(|error| error.to_string())?;
            let receipt: Receipt = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            if !receipt.is_valid()
                || receipt.identity.scope.account_id != account
                || receipt.identity.key() != key
            {
                return Err("invalid compose receipt account history".into());
            }
            if receipt.identity.scope.mailbox == mailbox && receipt.identity.scope.uid == uid {
                matching.push(receipt);
            }
        }
        matching
    };
    let inventory = TupleInventory {
        conn,
        version,
        receipts,
    };
    inventory.current()?;
    Ok(inventory)
}

/// Call only after durable pending work retains this complete proof. Exact
/// compare-and-delete cannot retire a later lifecycle state or another digest.
pub fn retire(conn: &Connection, receipt: &Receipt) -> Result<bool, String> {
    if !receipt.is_valid() { return Err("invalid compose receipt".into()); }
    let encoded = serde_json::to_string(receipt).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meta WHERE key = ?1 AND value = ?2", params![receipt.identity.key(), encoded])
        .map(|n| n == 1).map_err(|e| e.to_string())
}

/// Explicit account removal, never ordinary cache invalidation. Pending bulk
/// proof is separately owned. No wildcard interpretation of account IDs.
pub fn remove_account(conn: &Connection, account_id: &str) -> Result<usize, String> {
    if account_id.trim().is_empty() { return Err("missing compose receipt account".into()); }
    let prefix = account_prefix(account_id);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let upper = format!("{prefix}~");
    let n = tx.execute("DELETE FROM meta WHERE key >= ?1 AND key < ?2", params![prefix, upper]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    const RAW: &[u8] = b"Message-ID: <native@example.test>\r\n\r\noriginal";
    fn receipt(account: &str, mailbox: &str, uid: u32, raw: &[u8]) -> Receipt {
        Receipt::present(Identity::from_bytes(Scope::new(account, mailbox, uid, "native@example.test").unwrap(), raw).unwrap())
    }
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap(); c
    }
    #[test]
    fn compose_receipts_exact_tuple_digest_and_normalized_mid_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let r = receipt("a:_%", "Sent:child", 42, RAW);
        { let c = db::open(dir.path()).unwrap(); save(&c, &r).unwrap(); }
        let reopened = db::open(dir.path()).unwrap();
        let got = load(&reopened, &Scope::new("a:_%", "Sent:child", 42, "  <native@example.test> ").unwrap()).unwrap();
        assert_eq!(got, vec![r.clone()]);
        assert!(r.identity.matches_bytes(RAW));
        assert!(!r.identity.matches_bytes(b"Message-ID: <native@example.test>\r\n\r\nreplacement"));
        assert!(!r.identity.matches_bytes(b"Message-ID: <other@example.test>\r\n\r\noriginal"));
        for scope in [Scope::new("a", "Sent:child", 42, "native@example.test"), Scope::new("a:_%", "Sent", 42, "native@example.test"),
            Scope::new("a:_%", "Sent:child", 43, "native@example.test"), Scope::new("a:_%", "Sent:child", 42, "other@example.test")] {
            assert!(load(&reopened, &scope.unwrap()).unwrap().is_empty());
        }
    }
    #[test]
    fn compose_receipts_keep_same_tuple_different_bytes_distinguishable() {
        let c = db();
        let a = receipt("a", "Sent", 42, RAW);
        let b = receipt("a", "Sent", 42, b"Message-ID: <native@example.test>\r\n\r\nother");
        save(&c, &a).unwrap(); save(&c, &b).unwrap();
        let all = load(&c, &a.identity.scope).unwrap();
        assert_eq!(all.len(), 2); assert!(all.contains(&a)); assert!(all.contains(&b));
        assert!(retire(&c, &a).unwrap());
        assert_eq!(load(&c, &b.identity.scope).unwrap(), vec![b]);
    }
    #[test]
    fn compose_receipts_retirement_compares_the_exact_retained_lifecycle_proof() {
        let c = db(); let a = receipt("a", "Sent", 42, RAW); save(&c, &a).unwrap();
        let mut cleaned = a.clone(); cleaned.state = State::Cleaned; save(&c, &cleaned).unwrap();
        assert!(!retire(&c, &a).unwrap());
        assert_eq!(load(&c, &a.identity.scope).unwrap(), vec![cleaned.clone()]);
        assert!(retire(&c, &cleaned).unwrap()); assert!(!retire(&c, &cleaned).unwrap());
    }
    #[test]
    fn compose_receipts_account_removal_is_exact_idempotent_and_keeps_pending_proof() {
        let dir = tempfile::tempdir().unwrap();
        let c = db::open(dir.path()).unwrap(); let a = receipt("a_%:", "Sent", 42, RAW);
        let mut clean = receipt("a_%:", "Sent", 43, RAW); clean.state = State::Cleaned;
        let b = receipt("a_%:child", "Sent", 42, RAW);
        for r in [&a, &clean, &b] { save(&c, r).unwrap(); }
        db::meta_set(&c, "pending_operation", &serde_json::to_string(&a).unwrap()).unwrap();
        assert_eq!(remove_account(&c, "a_%:").unwrap(), 2);
        assert_eq!(remove_account(&c, "a_%:").unwrap(), 0);
        assert!(load(&c, &a.identity.scope).unwrap().is_empty());
        assert_eq!(load(&c, &b.identity.scope).unwrap(), vec![b]);
        assert_eq!(db::meta_get(&c, "pending_operation"), Some(serde_json::to_string(&a).unwrap()));
        drop(c);
        let reopened = db::open(dir.path()).unwrap();
        assert!(load(&reopened, &a.identity.scope).unwrap().is_empty());
    }
    #[test]
    fn compose_receipts_corrupt_unknown_and_failed_storage_never_become_proof() {
        let c = db(); let a = receipt("a", "Sent", 42, RAW); save(&c, &a).unwrap();
        let mut unsupported = a.clone(); unsupported.version = 999;
        db::meta_set(&c, &a.identity.key(), &serde_json::to_string(&unsupported).unwrap()).unwrap();
        assert!(load(&c, &a.identity.scope).is_err());
        c.execute_batch("DROP TABLE meta").unwrap();
        assert!(load(&c, &a.identity.scope).is_err()); assert!(save(&c, &a).is_err());
        assert!(remove_account(&c, "a").is_err());
    }
    fn tuple_receipt(account: &str, mailbox: &str, uid: u32, mid: &str) -> Receipt {
        let raw = format!("Message-ID: <{mid}>\r\n\r\nfixture");
        Receipt::present(
            Identity::from_bytes(
                Scope::new(account, mailbox, uid, mid).unwrap(),
                raw.as_bytes(),
            )
            .unwrap(),
        )
    }

    #[test]
    fn receipt_tuple_inventory_validates_all_account_history_and_keeps_only_tuple() {
        let dir = tempfile::tempdir().unwrap();
        let c = db::open(dir.path()).unwrap();
        let first = tuple_receipt("one", "Drafts", 7, "first@example.test");
        let mut other_mid = tuple_receipt("one", "Drafts", 7, "second@example.test");
        other_mid.state = State::Cleaned;
        let unrelated = tuple_receipt("one", "Other", 8, "other@example.test");
        for proof in [&first, &other_mid, &unrelated] {
            save(&c, proof).unwrap();
        }
        let inventory = inventory_tuple(dir.path(), "one", "Drafts", 7).unwrap();
        let tuple = inventory.current().unwrap();
        assert_eq!(tuple.len(), 2);
        assert!(tuple.contains(&first) && tuple.contains(&other_mid));
        assert!(!tuple.contains(&unrelated));
        for invalid in [
            "{broken".to_string(),
            {
                let mut future = unrelated.clone();
                future.version = 42;
                serde_json::to_string(&future).unwrap()
            },
            serde_json::to_string(&first).unwrap(),
        ] {
            db::meta_set(&c, &unrelated.identity.key(), &invalid).unwrap();
            assert!(inventory_tuple(dir.path(), "one", "Drafts", 7).is_err());
        }
    }

    #[test]
    fn receipt_tuple_inventory_rechecks_same_reader_without_rescanning_or_open_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let c = db::open(dir.path()).unwrap();
        let proof = tuple_receipt("one", "Drafts", 7, "one@example.test");
        save(&c, &proof).unwrap();
        let before = TUPLE_SCANS.with(|count| count.get());
        let inventory = inventory_tuple(dir.path(), "one", "Drafts", 7).unwrap();
        assert!(inventory.conn.is_autocommit());
        assert_eq!(inventory.current().unwrap(), &[proof]);
        let other = db::open(dir.path()).unwrap();
        db::meta_set(&other, "unrelated", "commit").unwrap();
        assert!(inventory.current().is_err());
        assert_eq!(TUPLE_SCANS.with(|count| count.get()), before + 1);
        assert!(inventory_tuple(dir.path(), "one", "Drafts", 7)
            .unwrap()
            .current()
            .is_ok());
    }

    #[test]
    fn receipt_tuple_inventory_private_read_failure_does_not_create_a_database() {
        let dir = tempfile::tempdir().unwrap();
        assert!(inventory_tuple(dir.path(), "one", "Drafts", 7).is_err());
        assert!(!db::db_path(dir.path()).exists());
        std::fs::create_dir(db::db_path(dir.path())).unwrap();
        assert!(inventory_tuple(dir.path(), "one", "Drafts", 7).is_err());
    }

}
