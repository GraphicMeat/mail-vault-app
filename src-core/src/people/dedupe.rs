//! Merge proposals: signals the user confirms, never applied automatically.
use crate::people::store::get_card;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub a: String,
    pub b: String,
    pub reason: String,
}

fn digits(s: &str) -> String { s.chars().filter(char::is_ascii_digit).collect() }

pub(crate) fn norm_name(s: &str) -> String { s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase() }

/// The last 10 digits of a phone number, the part two spellings of one number share.
pub(crate) fn phone_tail(s: &str) -> String {
    let d = digits(s);
    d[d.len().saturating_sub(10)..].to_string()
}

/// What the matcher needs from one person: normalised name and phone keys.
#[derive(Debug, Clone)]
pub struct PersonKeys {
    pub id: String,
    pub name: String,
    pub phones: Vec<String>,
}

/// Keys for up to `max_people` people with an id after `after` (exclusive,
/// ordered), plus the cursor for the next page. The daemon loops this, taking
/// the custody lock once per page, then calls `propose_from` with the lot, so
/// no single call parses every contact.
pub fn keys_page(conn: &Connection, after: &str, max_people: usize) -> Result<(Vec<PersonKeys>, Option<String>), String> {
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM person WHERE deleted_ms IS NULL AND id > ?1 ORDER BY id LIMIT ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![after, max_people as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let collected = rows.collect::<Result<Vec<String>, rusqlite::Error>>().map_err(|e| e.to_string())?;
        collected
    };
    let next = if ids.len() == max_people { ids.last().cloned() } else { None };
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(card) = get_card(conn, &id)? else { continue };
        let phones = card
            .phones
            .iter()
            .map(|p| digits(&p.number))
            .filter(|d| d.len() >= 7)
            .map(|d| d[d.len().saturating_sub(10)..].to_string())
            .collect();
        out.push(PersonKeys { id: card.id.clone(), name: norm_name(&card.display_name), phones });
    }
    Ok((out, next))
}

/// Same name or a shared phone number (7+ digits, last 10 compared) across two
/// different people.
pub fn propose_from(people: &[PersonKeys]) -> Vec<Proposal> {
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    let mut by_phone: HashMap<String, Vec<String>> = HashMap::new();
    for p in people {
        if !p.name.is_empty() { by_name.entry(p.name.clone()).or_default().push(p.id.clone()); }
        for key in &p.phones {
            let v = by_phone.entry(key.clone()).or_default();
            if !v.contains(&p.id) { v.push(p.id.clone()); }
        }
    }
    finish(by_name, by_phone)
}

/// Every page at once. Tests and small tools only: the daemon pages.
pub fn propose(conn: &Connection) -> Result<Vec<Proposal>, String> {
    let (mut all, mut cursor) = (Vec::new(), String::new());
    loop {
        let (page, next) = keys_page(conn, &cursor, 200)?;
        all.extend(page);
        match next {
            Some(n) => cursor = n,
            None => break,
        }
    }
    Ok(propose_from(&all))
}

fn finish(by_name: HashMap<String, Vec<String>>, by_phone: HashMap<String, Vec<String>>) -> Vec<Proposal> {
    let mut out: Vec<Proposal> = Vec::new();
    for (map, reason) in [(by_name, "name"), (by_phone, "phone")] {
        for ids in map.values().filter(|v| v.len() > 1) {
            for i in 0..ids.len() {
                for j in i + 1..ids.len() {
                    out.push(Proposal { a: ids[i].clone(), b: ids[j].clone(), reason: reason.into() });
                }
            }
        }
    }
    out.sort_by(|x, y| (&x.reason, &x.a, &x.b).cmp(&(&y.reason, &y.a, &y.b)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;
    use crate::people::store::{create_person, NewPerson};

    #[test]
    fn proposes_shared_phone_and_same_name_only_across_different_people() {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        let mk = |n: &str, e: &str, p: &str| {
            create_person(
                &c,
                &NewPerson {
                    display_name: n.into(),
                    emails: vec![e.into()],
                    phones: if p.is_empty() { vec![] } else { vec![p.into()] },
                    ..Default::default()
                },
            )
            .unwrap()
        };
        let a = mk("Jane  Doe", "j@a.io", "+1 (555) 010-0100");
        let b = mk("jane doe", "jd@b.io", "");
        let d = mk("Someone", "s@c.io", "15550100100");
        let _lonely = mk("Unique", "u@d.io", "");
        let props = propose(&c).unwrap();
        let has = |x: &str, y: &str, why: &str| props.iter().any(|p| p.reason == why && ((p.a == x && p.b == y) || (p.a == y && p.b == x)));
        assert!(has(&a, &b, "name"));
        assert!(has(&a, &d, "phone"));
        assert_eq!(props.len(), 2);
    }

    #[test]
    fn short_phone_numbers_are_not_a_signal() {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        for (n, e) in [("A", "a@x.io"), ("B", "b@x.io")] {
            create_person(&c, &NewPerson { display_name: n.into(), emails: vec![e.into()], phones: vec!["112".into()], ..Default::default() }).unwrap();
        }
        assert!(propose(&c).unwrap().is_empty());
    }
}
