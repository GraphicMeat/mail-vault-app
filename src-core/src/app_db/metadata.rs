//! What every per-message store here has in common: it is keyed by
//! `identity::msg_key`, and a message that no longer exists anywhere should
//! not keep rows in it.

use super::db::in_txn;
use rusqlite::{params_from_iter, Connection};

/// Drop every tag assignment and custom field value for these identities.
///
/// The caller decides *which* identities are really gone. A message moved from
/// one folder to another leaves one index row and gains another under the same
/// identity, so "its row was removed" is never on its own a reason to forget
/// what a person wrote about it.
pub fn prune(conn: &Connection, account_id: &str, msg_keys: &[String]) -> Result<usize, String> {
    if msg_keys.is_empty() {
        return Ok(0);
    }
    in_txn(conn, || {
        let mut dropped = 0;
        for chunk in msg_keys.chunks(800) {
            let places = std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
            for table in ["tag_assignments", "field_values"] {
                let sql = format!("DELETE FROM {table} WHERE account_id = ?1 AND msg_key IN ({places})");
                let args = std::iter::once(account_id.to_string()).chain(chunk.iter().cloned());
                dropped += conn.execute(&sql, params_from_iter(args)).map_err(|e| e.to_string())?;
            }
        }
        Ok(dropped)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::{db, tags};

    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-meta-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn target(key: &str) -> tags::Target {
        tags::Target { account_id: "acct".into(), msg_key: key.into() }
    }

    #[test]
    fn pruning_forgets_the_identities_it_was_given_and_no_others() {
        let c = conn();
        let tag = tags::ensure(&c, "Receipts", "").unwrap();
        tags::assign(&c, &tag.id, &[target("gone@x"), target("kept@x")]).unwrap();
        assert_eq!(prune(&c, "acct", &["gone@x".to_string()]).unwrap(), 1);
        assert_eq!(tags::list(&c).unwrap()[0].count, 1);
        assert!(tags::for_messages(&c, "acct", &["gone@x".into()]).unwrap().is_empty());
        assert!(!tags::for_messages(&c, "acct", &["kept@x".into()]).unwrap().is_empty());
    }

    #[test]
    fn one_accounts_pruning_leaves_another_accounts_rows_alone() {
        let c = conn();
        let tag = tags::ensure(&c, "Receipts", "").unwrap();
        tags::assign(&c, &tag.id, &[target("shared@x"), tags::Target { account_id: "other".into(), msg_key: "shared@x".into() }])
            .unwrap();
        prune(&c, "acct", &["shared@x".to_string()]).unwrap();
        assert_eq!(tags::list(&c).unwrap()[0].count, 1);
        assert!(!tags::for_messages(&c, "other", &["shared@x".into()]).unwrap().is_empty());
    }

    #[test]
    fn pruning_nothing_is_not_pruning_everything() {
        let c = conn();
        let tag = tags::ensure(&c, "Receipts", "").unwrap();
        tags::assign(&c, &tag.id, &[target("kept@x")]).unwrap();
        assert_eq!(prune(&c, "acct", &[]).unwrap(), 0);
        assert_eq!(tags::list(&c).unwrap()[0].count, 1);
    }
}
