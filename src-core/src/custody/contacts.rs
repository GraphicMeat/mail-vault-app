//! The sender address book, one row per (account, address).
//!
//! Was `<vault>/contacts_index/<account>.json`, a whole-file rewrite on a
//! debounced timer. Derived data — it is rebuilt from the header cache when an
//! account has no rows — but it lives in `custody.db` rather than the search
//! index because it is keyed by account, not by message, and nothing rebuilds
//! it when the index is dropped.

use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;

/// `<vault>/contacts_index`, the directory the JSON files were in.
pub const LEGACY_DIR: &str = "contacts_index";

/// One stored contact. `folders_json` is the address's folder list, kept as
/// JSON for the same reason `entries` keeps its record that way: it is a list
/// the caller owns, not something this store queries into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub address: String,
    pub name: String,
    pub count: u64,
    pub last_seen: i64,
    pub folders_json: String,
}

pub fn load(conn: &Connection, account_id: &str) -> Vec<Row> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT address, name, count, last_seen, folders_json FROM contacts WHERE account_id = ?1",
    ) else {
        return Vec::new();
    };
    stmt.query_map([account_id], |r| {
        Ok(Row {
            address: r.get(0)?,
            name: r.get(1)?,
            count: r.get::<_, i64>(2)? as u64,
            last_seen: r.get(3)?,
            folders_json: r.get(4)?,
        })
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

/// Replace everything this account has — the JSON file was rewritten whole,
/// and an address the caller dropped has to disappear here too.
pub fn replace_account(conn: &Connection, account_id: &str, rows: &[Row]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM contacts WHERE account_id = ?1", [account_id]).map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO contacts(account_id, address, name, count, last_seen, folders_json)
                 VALUES (?1,?2,?3,?4,?5,?6)",
            )
            .map_err(|e| e.to_string())?;
        for row in rows {
            stmt.execute(params![
                account_id,
                row.address,
                row.name,
                row.count as i64,
                row.last_seen,
                row.folders_json
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Move `<vault>/contacts_index/<account>.json` into the store, once, and
/// retire it. Does nothing when the account already has rows: those were
/// written by this build and are newer than any file left beside them.
pub fn import_legacy(conn: &Connection, vault_root: &Path, account_id: &str) -> usize {
    let path = vault_root.join(LEGACY_DIR).join(format!("{}.json", sanitize(account_id)));
    if !path.is_file() {
        return 0;
    }
    let list: Vec<Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let rows: Vec<Row> = list
        .iter()
        .filter_map(|e| {
            let address = e.get("address")?.as_str()?.to_string();
            Some(Row {
                address,
                name: e.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                count: e.get("count").and_then(Value::as_u64).unwrap_or(0),
                last_seen: e.get("lastSeen").and_then(Value::as_i64).unwrap_or(0),
                folders_json: e.get("folders").cloned().unwrap_or_else(|| Value::Array(vec![])).to_string(),
            })
        })
        .collect();
    let imported = rows.len();
    if replace_account(conn, account_id, &rows).is_ok() {
        let _ = crate::fsx::retire(&path, crate::fsx::retire_stamp());
    }
    imported
}

/// The file-name sanitizer the JSON files were named with.
fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;

    fn vault(name: &str) -> (std::path::PathBuf, Connection) {
        let p = std::env::temp_dir().join(format!("mv-contacts-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        let c = db::open(&p).unwrap();
        (p, c)
    }

    fn row(address: &str, count: u64) -> Row {
        Row { address: address.into(), name: "N".into(), count, last_seen: 5, folders_json: "[\"INBOX\"]".into() }
    }

    #[test]
    fn contacts_round_trip_per_account() {
        let (dir, c) = vault("roundtrip");
        replace_account(&c, "a", &[row("x@example.com", 3)]).unwrap();
        replace_account(&c, "b", &[row("y@example.com", 1)]).unwrap();
        assert_eq!(load(&c, "a"), vec![row("x@example.com", 3)]);
        assert_eq!(load(&c, "b").len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_drops_addresses_the_caller_left_out() {
        let (dir, c) = vault("replace");
        replace_account(&c, "a", &[row("x@e.com", 1), row("y@e.com", 1)]).unwrap();
        replace_account(&c, "a", &[row("y@e.com", 2)]).unwrap();
        assert_eq!(load(&c, "a"), vec![row("y@e.com", 2)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_legacy_json_file_is_imported_once_and_retired() {
        let (dir, c) = vault("import");
        let legacy_dir = dir.join(LEGACY_DIR);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(
            legacy_dir.join("acc1.json"),
            serde_json::json!([{"address":"x@e.com","name":"X","count":4,"lastSeen":99,"folders":["INBOX"]}])
                .to_string(),
        )
        .unwrap();

        assert_eq!(import_legacy(&c, &dir, "acc1"), 1);
        let rows = load(&c, "acc1");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].count, 4);
        assert_eq!(rows[0].last_seen, 99);
        assert!(!legacy_dir.join("acc1.json").exists(), "the file is retired, never deleted");
        assert_eq!(import_legacy(&c, &dir, "acc1"), 0, "a second import finds nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_account_with_no_legacy_file_imports_nothing() {
        let (dir, c) = vault("none");
        assert_eq!(import_legacy(&c, &dir, "acc1"), 0);
        assert!(load(&c, "acc1").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
