//! The chat view (`viewStyle` chat; desktop's Settings > Appearance > Mail view, its
//! `ChatViewWrapper`): a folder's mail by person, then one person's conversations.
//!
//! - `mobile.chat.people {accountId, folder}` -> `{people: [{email, name, count, unread,
//!   lastDateMs, lastSubject}]}`, the person with the newest message first. A message's person is
//!   desktop's `getCorrespondent` (`src/utils/emailParser.js`): its sender, or its first recipient
//!   when the sender is one of the account's own addresses (the login, `sendAs` and every alias,
//!   compared as core's `normalize_identity` folds them: case, and Gmail's dots and `+tags`).
//!   The name is desktop's too: a display name with a space wins over a bare one; an address alone
//!   is named by its local part.
//! - `mobile.chat.topics {accountId, folder, email}` -> `{rows}`: the folder's conversations
//!   (`threads.rs`, the list's own grouping, so a topic opens on the same conversation screen)
//!   that hold a message of that person, newest first, each as its newest message's list row with
//!   the conversation fields the threaded list adds.
//!
//! Both read the folder's listed rows only (what the list shows): a folder the phone has not
//! synced has no people yet, and Sent mail joins only in the Sent folder itself.

use crate::db::Engine;
use crate::rpc::{parse, RpcError};
use mailvault_core::notes_to_self::normalize_identity;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PeopleParams {
    account_id: String,
    folder: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TopicsParams {
    account_id: String,
    folder: String,
    email: String,
}

/// One listed message as the grouping reads it, newest first.
struct Row {
    uid: i64,
    date_ms: i64,
    subject: String,
    seen: bool,
    /// (folded key, address as written, display name) of the other party; `None` when it has none.
    person: Option<(String, String, String)>,
}

/// The account's own addresses, folded: its login, `sendAs` and aliases.
fn own_addresses(c: &Connection, account: &str) -> rusqlite::Result<HashSet<String>> {
    use rusqlite::OptionalExtension;
    let mut out = HashSet::new();
    if let Some(login) = c.query_row("SELECT email FROM accounts WHERE id = ?1", [account], |r| r.get::<_, String>(0)).optional()? {
        out.insert(normalize_identity(&login));
    }
    let sending = crate::account_settings::own_addresses(c, &[account.to_string()]);
    if let Some(s) = sending["sendAsAddresses"][account].as_str() {
        out.insert(normalize_identity(s));
    }
    for a in sending["aliases"][account].as_array().into_iter().flatten() {
        if let Some(s) = a["address"].as_str() {
            out.insert(normalize_identity(s));
        }
    }
    out.remove("");
    Ok(out)
}

/// Desktop's `cleanName`: surrounding quotes dropped; a name that is an address (or none) reads as
/// the address's local part.
fn clean_name(name: &str, address: &str) -> String {
    let mut n = name.trim();
    if n.len() >= 2 && n.starts_with('"') && n.ends_with('"') {
        n = &n[1..n.len() - 1];
    }
    let n = n.replace("\\\"", "\"");
    let n = n.trim();
    let local = |a: &str| a.split('@').next().unwrap_or(a).to_string();
    if n.is_empty() {
        return if address.is_empty() { "Unknown".to_string() } else { local(address) };
    }
    if n.contains('@') {
        return local(if address.is_empty() { n } else { address });
    }
    n.to_string()
}

/// The other party of one message: the sender, or the first recipient of the user's own mail.
fn person(own: &HashSet<String>, from_name: &str, from_address: &str, to_json: &str) -> Option<(String, String, String)> {
    let (name, address) = if own.contains(&normalize_identity(from_address)) {
        let to: Value = serde_json::from_str(to_json).unwrap_or(Value::Null);
        let first = to.as_array().and_then(|l| l.first()).cloned().unwrap_or(Value::Null);
        (first["name"].as_str().unwrap_or("").to_string(), first["address"].as_str().unwrap_or("").to_string())
    } else {
        (from_name.to_string(), from_address.to_string())
    };
    let address = address.trim().to_lowercase();
    if address.is_empty() {
        return None;
    }
    let name = clean_name(&name, &address);
    Some((normalize_identity(&address), address, name))
}

fn read_rows(c: &Connection, account: &str, folder: &str) -> rusqlite::Result<Vec<Row>> {
    let own = own_addresses(c, account)?;
    let mut st = c.prepare_cached(&format!(
        "SELECT uid, date_ms, subject, COALESCE(local_seen, seen), from_name, from_address, to_json
         FROM messages WHERE {} ORDER BY date_ms DESC, uid DESC",
        crate::rpc::LISTED
    ))?;
    let rows = st
        .query_map((account, folder), |r| {
            let from_name: String = r.get(4)?;
            let from_address: String = r.get(5)?;
            let to_json: String = r.get(6)?;
            Ok(Row {
                uid: r.get(0)?,
                date_ms: r.get(1)?,
                subject: r.get(2)?,
                seen: r.get::<_, i64>(3)? != 0,
                person: person(&own, &from_name, &from_address, &to_json),
            })
        })?
        .collect();
    rows
}

struct Person {
    email: String,
    name: String,
    count: u64,
    unread: u64,
    last_date_ms: i64,
    last_subject: String,
}

/// The folder's people, newest first (rows arrive newest first, so the first message of a person
/// is their newest).
fn group(rows: &[Row]) -> Vec<Person> {
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut out: Vec<Person> = Vec::new();
    for r in rows {
        let Some((key, address, name)) = &r.person else { continue };
        let i = *index.entry(key.as_str()).or_insert_with(|| {
            out.push(Person {
                email: address.clone(),
                name: name.clone(),
                count: 0,
                unread: 0,
                last_date_ms: r.date_ms,
                last_subject: r.subject.clone(),
            });
            out.len() - 1
        });
        let p = &mut out[i];
        p.count += 1;
        if !r.seen {
            p.unread += 1;
        }
        // Desktop's rule: a name with a space wins over one without (or over an address).
        if !name.contains('@') && name.contains(' ') && (p.name.contains('@') || !p.name.contains(' ')) {
            p.name = name.clone();
        }
    }
    out
}

fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::Internal(e.to_string())
}

pub(crate) fn people(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: PeopleParams = parse(params)?;
    let rows = engine.read(|c| read_rows(c, &p.account_id, &p.folder)).map_err(internal)?;
    let people: Vec<Value> = group(&rows)
        .into_iter()
        .map(|x| {
            json!({
                "email": x.email,
                "name": x.name,
                "count": x.count,
                "unread": x.unread,
                "lastDateMs": x.last_date_ms,
                "lastSubject": x.last_subject,
            })
        })
        .collect();
    Ok(json!({ "people": people }))
}

pub(crate) fn topics(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: TopicsParams = parse(params)?;
    let key = normalize_identity(&p.email);
    let list_gen = engine.shared().list_gen(&p.account_id, &p.folder).map_err(internal)?;
    engine
        .read(|c| {
            let theirs: HashSet<i64> = read_rows(c, &p.account_id, &p.folder)?
                .into_iter()
                .filter(|r| r.person.as_ref().is_some_and(|(k, ..)| *k == key))
                .map(|r| r.uid)
                .collect();
            let f = crate::threads::folder_threads(engine.shared(), c, &p.account_id, &p.folder, list_gen)?;
            let mut rows = Vec::new();
            for t in f.threads.iter().filter(|t| t.members.iter().any(|m| theirs.contains(&m.uid))) {
                if let Some(mut row) = crate::threads::row_of(c, &p.account_id, &p.folder, t.head().uid)? {
                    crate::threads::decorate(&mut row, t);
                    rows.push(row);
                }
            }
            Ok(json!({ "rows": rows }))
        })
        .map_err(internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_read_like_desktop() {
        assert_eq!(clean_name("\"Ann Lee\"", "ann@x.test"), "Ann Lee");
        assert_eq!(clean_name("", "ann@x.test"), "ann");
        assert_eq!(clean_name("ann@x.test", "ann@x.test"), "ann");
        assert_eq!(clean_name("", ""), "Unknown");
    }

    #[test]
    fn own_mail_is_about_its_first_recipient() {
        let own: HashSet<String> = [normalize_identity("John.Doe+x@gmail.com")].into_iter().collect();
        let to = r#"[{"name":"Ann","address":"Ann@X.test"},{"name":"","address":"b@x.test"}]"#;
        assert_eq!(person(&own, "Me", "johndoe@gmail.com", to).unwrap().1, "ann@x.test");
        assert_eq!(person(&own, "Bob", "bob@x.test", to).unwrap().1, "bob@x.test");
        assert!(person(&own, "Me", "johndoe@gmail.com", "[]").is_none());
    }
}
