//! MailVault tags: user-authored labels that live only here.
//!
//! A tag never touches the `.eml`, never becomes an IMAP keyword and never
//! reaches a server, so it works the same on a provider with no label support
//! as on one with them. Assignments are keyed by
//! [`super::identity::msg_key`], not by mailbox+uid.
//!
//! This is the durable store on purpose: the search index is rebuildable by
//! design (`search_index::db::OpenError::Rebuildable`), so user-authored data
//! cannot live there.

use super::db::in_txn;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    /// How many messages carry it.
    pub count: i64,
}

/// One message a tag operation applies to.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub account_id: String,
    pub msg_key: String,
}

/// Every tag, with its assignment count, in display order.
pub fn list(conn: &Connection) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.color, t.position, COUNT(a.tag_id)
             FROM tags t LEFT JOIN tag_assignments a ON a.tag_id = t.id
             GROUP BY t.id ORDER BY t.position, t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                position: r.get(3)?,
                count: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// The tag named `name`, creating it when no tag has that name. Names are
/// compared case-insensitively, so this never trips the unique index — the
/// legacy import and a user typing an existing name both land on the same row.
pub fn ensure(conn: &Connection, name: &str, color: &str) -> Result<Tag, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a tag needs a name".into());
    }
    in_txn(conn, || {
        let existing: Option<String> = conn
            .query_row("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE", [name], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let id = match existing {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let position: i64 = conn
                    .query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM tags", [], |r| r.get(0))
                    .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO tags(id, name, color, position, created_at) VALUES (?1,?2,?3,?4,?5)",
                    params![id, name, color, position, now()],
                )
                .map_err(|e| e.to_string())?;
                id
            }
        };
        get(conn, &id)
    })
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a tag needs a name".into());
    }
    conn.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![id, name])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn set_color(conn: &Connection, id: &str, color: &str) -> Result<(), String> {
    conn.execute("UPDATE tags SET color = ?2 WHERE id = ?1", params![id, color])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Delete the tag and every assignment of it. The assignments go explicitly:
/// the foreign key documents the relationship, but this store never turns
/// `PRAGMA foreign_keys` on, so nothing would cascade on its own.
pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    in_txn(conn, || {
        conn.execute("DELETE FROM tag_assignments WHERE tag_id = ?1", [id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM tags WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Tag every target, skipping the ones that already carry it. Returns the
/// number of targets that now carry the tag (including the already-tagged).
pub fn assign(conn: &Connection, tag_id: &str, targets: &[Target]) -> Result<usize, String> {
    let targets = distinct(targets);
    in_txn(conn, || {
        let at = now();
        let mut stmt = conn
            .prepare_cached("INSERT OR IGNORE INTO tag_assignments(tag_id, account_id, msg_key, at) VALUES (?1,?2,?3,?4)")
            .map_err(|e| e.to_string())?;
        for target in &targets {
            stmt.execute(params![tag_id, target.account_id, target.msg_key, at]).map_err(|e| e.to_string())?;
        }
        Ok(targets.len())
    })
}

pub fn unassign(conn: &Connection, tag_id: &str, targets: &[Target]) -> Result<usize, String> {
    let targets = distinct(targets);
    in_txn(conn, || {
        let mut removed = 0;
        let mut stmt = conn
            .prepare_cached("DELETE FROM tag_assignments WHERE tag_id = ?1 AND account_id = ?2 AND msg_key = ?3")
            .map_err(|e| e.to_string())?;
        for target in &targets {
            removed += stmt.execute(params![tag_id, target.account_id, target.msg_key]).map_err(|e| e.to_string())?;
        }
        Ok(removed)
    })
}

/// Tag ids per `msg_key`, for one page of list rows. Keys with no tag are
/// absent rather than empty.
pub fn for_messages(conn: &Connection, account_id: &str, msg_keys: &[String]) -> Result<HashMap<String, Vec<String>>, String> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    // SQLite's default parameter limit is 999 and a whole list page is asked
    // for at once, so the keys go in chunks rather than in one `IN (...)`.
    for chunk in msg_keys.chunks(800) {
        let places = std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT a.msg_key, a.tag_id FROM tag_assignments a JOIN tags t ON t.id = a.tag_id
             WHERE a.account_id = ?1 AND a.msg_key IN ({places}) ORDER BY t.position, t.name COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let args = std::iter::once(account_id.to_string()).chain(chunk.iter().cloned());
        let rows = stmt
            .query_map(params_from_iter(args), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (key, tag_id) = row.map_err(|e| e.to_string())?;
            out.entry(key).or_default().push(tag_id);
        }
    }
    Ok(out)
}

fn get(conn: &Connection, id: &str) -> Result<Tag, String> {
    conn.query_row(
        "SELECT t.id, t.name, t.color, t.position, COUNT(a.tag_id)
         FROM tags t LEFT JOIN tag_assignments a ON a.tag_id = t.id
         WHERE t.id = ?1 GROUP BY t.id",
        [id],
        |r| {
            Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, position: r.get(3)?, count: r.get(4)? })
        },
    )
    .map_err(|e| e.to_string())
}

/// The same message can reach a bulk call twice (two list rows, one identity),
/// and the count a caller reports has to be of messages, not of clicks.
fn distinct(targets: &[Target]) -> Vec<Target> {
    let mut seen = std::collections::BTreeSet::new();
    targets
        .iter()
        .filter(|t| seen.insert((t.account_id.clone(), t.msg_key.clone())))
        .cloned()
        .collect()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-tags-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn t(account: &str, key: &str) -> Target {
        Target { account_id: account.into(), msg_key: key.into() }
    }

    #[test]
    fn a_new_tag_starts_at_zero_and_is_listed() {
        let c = conn();
        let tag = ensure(&c, "Receipts", "#f00").unwrap();
        assert_eq!(tag.name, "Receipts");
        assert_eq!(tag.count, 0);
        assert_eq!(list(&c).unwrap(), vec![tag]);
    }

    #[test]
    fn a_name_that_differs_only_in_case_is_the_same_tag() {
        let c = conn();
        let first = ensure(&c, "Receipts", "#f00").unwrap();
        let again = ensure(&c, "receipts", "#0f0").unwrap();
        assert_eq!(first.id, again.id, "one row, not a unique-index error");
        assert_eq!(list(&c).unwrap().len(), 1);
    }

    #[test]
    fn assigning_twice_leaves_one_assignment() {
        let c = conn();
        let tag = ensure(&c, "Clients", "").unwrap();
        assign(&c, &tag.id, &[t("acct", "abc@example.com")]).unwrap();
        assign(&c, &tag.id, &[t("acct", "abc@example.com")]).unwrap();
        assert_eq!(list(&c).unwrap()[0].count, 1);
    }

    #[test]
    fn assign_reports_how_many_targets_carry_the_tag() {
        let c = conn();
        let tag = ensure(&c, "Clients", "").unwrap();
        let targets = vec![t("acct", "one@example.com"), t("acct", "two@example.com")];
        assert_eq!(assign(&c, &tag.id, &targets).unwrap(), 2);
        assert_eq!(list(&c).unwrap()[0].count, 2);
    }

    #[test]
    fn unassign_removes_only_the_named_targets() {
        let c = conn();
        let tag = ensure(&c, "Clients", "").unwrap();
        assign(&c, &tag.id, &[t("acct", "one@example.com"), t("acct", "two@example.com")]).unwrap();
        assert_eq!(unassign(&c, &tag.id, &[t("acct", "one@example.com")]).unwrap(), 1);
        assert_eq!(list(&c).unwrap()[0].count, 1);
    }

    #[test]
    fn the_same_key_in_two_accounts_is_two_assignments() {
        let c = conn();
        let tag = ensure(&c, "Clients", "").unwrap();
        assign(&c, &tag.id, &[t("work", "abc@example.com"), t("home", "abc@example.com")]).unwrap();
        assert_eq!(list(&c).unwrap()[0].count, 2);
        assert_eq!(for_messages(&c, "work", &["abc@example.com".into()]).unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_tag_takes_its_assignments_with_it() {
        let c = conn();
        let tag = ensure(&c, "Clients", "").unwrap();
        assign(&c, &tag.id, &[t("acct", "one@example.com")]).unwrap();
        delete(&c, &tag.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
        assert!(for_messages(&c, "acct", &["one@example.com".into()]).unwrap().is_empty());
    }

    #[test]
    fn rename_and_recolor_survive_a_reopen() {
        let dir = std::env::temp_dir().join(format!("mv-tags-{}", uuid::Uuid::new_v4()));
        let id = {
            let c = db::open(&dir).unwrap();
            let tag = ensure(&c, "Clietns", "").unwrap();
            rename(&c, &tag.id, "Clients").unwrap();
            set_color(&c, &tag.id, "#123456").unwrap();
            tag.id
        };
        let c = db::open(&dir).unwrap();
        let tags = list(&c).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].id, id);
        assert_eq!(tags[0].name, "Clients");
        assert_eq!(tags[0].color, "#123456");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn for_messages_answers_only_for_the_keys_it_was_asked_about() {
        let c = conn();
        let a = ensure(&c, "A", "").unwrap();
        let b = ensure(&c, "B", "").unwrap();
        assign(&c, &a.id, &[t("acct", "one@example.com")]).unwrap();
        assign(&c, &b.id, &[t("acct", "one@example.com")]).unwrap();
        assign(&c, &a.id, &[t("acct", "two@example.com")]).unwrap();
        let got = for_messages(&c, "acct", &["one@example.com".into()]).unwrap();
        assert_eq!(got.len(), 1, "two@ was not asked for");
        let mut ids = got["one@example.com"].clone();
        ids.sort();
        let mut want = vec![a.id, b.id];
        want.sort();
        assert_eq!(ids, want);
    }

    #[test]
    fn a_page_of_keys_does_not_blow_the_parameter_limit() {
        let c = conn();
        let tag = ensure(&c, "Bulk", "").unwrap();
        let keys: Vec<String> = (0..2500).map(|n| format!("k{n}@example.com")).collect();
        let targets: Vec<Target> = keys.iter().map(|k| t("acct", k)).collect();
        assign(&c, &tag.id, &targets).unwrap();
        assert_eq!(for_messages(&c, "acct", &keys).unwrap().len(), 2500);
    }
}
