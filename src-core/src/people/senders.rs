//! Address lists over `message_addr`: the review queue (addresses not yet a
//! person) and All senders (every address that wrote to the user, saved or
//! not). One definition of the counts; a "sender" is defined here only.
use crate::people::message_addr::normalize;
use crate::people::store::Sort;
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde::Serialize;
use std::collections::HashMap;

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// `IN (...)` placeholders and bound values for the user's own addresses.
/// `x NOT IN (NULL)` is NULL, which would filter every row: an empty list is `''`.
pub(crate) fn own_list(own: &[String]) -> (String, Vec<Sql>) {
    let lc: Vec<String> = own.iter().filter_map(|a| normalize(a)).collect();
    let ph = if lc.is_empty() { "''".to_string() } else { (1..=lc.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",") };
    (ph, lc.into_iter().map(Sql::Text).collect())
}

/// Per-address aggregate over `message_addr`: address, newest name, messages
/// received from it, messages the user wrote to it, newest message. `filter`
/// is extra `AND ...` text on `m`, `having` an optional `HAVING ...` clause;
/// `own_ph` is the `IN (...)` placeholder list of the user's own addresses and
/// `after_n` / `lim` the parameter numbers of the paging cursor and page size.
pub(crate) fn aggregate_sql(own_ph: &str, filter: &str, having: &str, after_n: usize, lim: usize) -> String {
    let key = "m.account_id||char(31)||m.msg_key";
    format!(
        "SELECT m.address, MAX(m.name), \
           COUNT(DISTINCT CASE WHEN m.role='from' THEN {key} END), \
           COUNT(DISTINCT CASE WHEN m.role IN ('to','bcc') AND EXISTS(SELECT 1 FROM message_addr f WHERE f.account_id=m.account_id \
             AND f.mailbox_path=m.mailbox_path AND f.uid=m.uid AND f.role='from' AND f.address IN ({own_ph})) THEN {key} END), \
           MAX(m.sort_ms) \
         FROM message_addr m \
         WHERE m.counted=1 AND m.address > ?{after_n} {filter} \
         GROUP BY m.address {having} ORDER BY m.address LIMIT ?{lim}"
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sender {
    pub address: String,
    pub name: String,
    pub received: u64,
    pub sent_to: u64,
    pub last_ms: i64,
    pub person_id: Option<String>,
    pub favorite: bool,
}

/// One address-ordered page of senders after `after`: addresses with at least
/// one counted message *from* them, the user's own excluded, each linked to its
/// live contact. The daemon loops this and takes the lock once per page.
pub fn page(conn: &Connection, own: &[String], after: &str, max: usize) -> Result<(Vec<Sender>, Option<String>), String> {
    let (own_ph, mut args) = own_list(own);
    args.push(Sql::Text(after.to_string()));
    let after_n = args.len();
    args.push(Sql::Integer(max as i64));
    let lim = args.len();
    let filter = format!("AND m.address NOT IN ({own_ph})");
    let having = "HAVING COUNT(CASE WHEN m.role='from' THEN 1 END) > 0";
    let sql = aggregate_sql(&own_ph, &filter, having, after_n, lim);
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut rows = stmt
        .query_map(params_from_iter(args), |r| {
            Ok(Sender {
                address: r.get(0)?,
                name: r.get(1)?,
                received: r.get::<_, i64>(2)? as u64,
                sent_to: r.get::<_, i64>(3)? as u64,
                last_ms: r.get(4)?,
                person_id: None,
                favorite: false,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let next = (rows.len() == max).then(|| rows.last().map(|s| s.address.clone())).flatten();
    let addresses: Vec<String> = rows.iter().map(|s| s.address.clone()).collect();
    let owned = owners(conn, &addresses)?;
    for sender in &mut rows {
        if let Some((id, vip)) = owned.get(&sender.address) {
            sender.person_id = Some(id.clone());
            sender.favorite = *vip;
        }
    }
    Ok((rows, next))
}

/// Address to (live person id, favorite) for the addresses a saved contact owns.
pub fn owners(conn: &Connection, addresses: &[String]) -> Result<HashMap<String, (String, bool)>, String> {
    let mut out = HashMap::new();
    for chunk in addresses.chunks(500) {
        let ph = (1..=chunk.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT ra.address, p.id, p.vip FROM record_address ra \
             JOIN person_link l ON l.record_id=ra.record_id JOIN person p ON p.id=l.person_id \
             WHERE p.deleted_ms IS NULL AND ra.address IN ({ph})"
        );
        let mut stmt = conn.prepare(&sql).map_err(err)?;
        let rows = stmt
            .query_map(params_from_iter(chunk.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0)))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        out.extend(rows.into_iter().map(|(a, id, vip)| (a, (id, vip))));
    }
    Ok(out)
}

fn display(s: &Sender) -> String {
    if s.name.trim().is_empty() { s.address.to_lowercase() } else { s.name.to_lowercase() }
}

/// Filter the pooled senders by a case-insensitive substring of name or
/// address, sort, and cut one page. Returns the page and the filtered total. Pure.
pub fn pick(mut pool: Vec<Sender>, text: Option<&str>, sort: Sort, offset: usize, limit: usize) -> (Vec<Sender>, usize) {
    if let Some(q) = text.map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()) {
        pool.retain(|s| s.name.to_lowercase().contains(&q) || s.address.to_lowercase().contains(&q));
    }
    pool.sort_by(|a, b| {
        let by = match sort {
            Sort::Name => display(a).cmp(&display(b)),
            Sort::Total => (b.received + b.sent_to).cmp(&(a.received + a.sent_to)),
            Sort::Last => b.last_ms.cmp(&a.last_ms),
        };
        by.then_with(|| a.address.cmp(&b.address))
    });
    let total = pool.len();
    (pool.into_iter().skip(offset).take(limit).collect(), total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;
    use crate::people::message_addr::index_row;
    use crate::people::store::{create_person, update_person, delete_person, NewPerson, Patch};
    use serde_json::json;

    fn conn() -> (tempfile::TempDir, Connection) {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        (t, c)
    }
    fn own() -> Vec<String> { vec!["me@h.io".to_string()] }
    fn put(c: &Connection, mailbox: &str, uid: u32, ms: i64, from: &str, name: &str, to: &str) {
        let h = json!({"uid": uid, "messageId": format!("<{mailbox}-{uid}@t>"), "from": {"address": from, "name": name}, "to": [{"address": to}]});
        c.execute(
            "INSERT OR REPLACE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a',?1,?2,?3,0,?4)",
            rusqlite::params![mailbox, uid, ms, h.to_string()],
        )
        .unwrap();
        index_row(c, "a", mailbox, uid, ms, &h).unwrap();
    }
    fn all(c: &Connection) -> Vec<Sender> { page(c, &own(), "", 100).unwrap().0 }
    fn addrs(v: &[Sender]) -> Vec<&str> { v.iter().map(|s| s.address.as_str()).collect() }
    fn sender(address: &str, name: &str, received: u64, sent_to: u64, last_ms: i64) -> Sender {
        Sender { address: address.into(), name: name.into(), received, sent_to, last_ms, person_id: None, favorite: false }
    }
    fn person(c: &Connection, address: &str) -> String {
        create_person(c, &NewPerson { display_name: "P".into(), emails: vec![address.into()], ..Default::default() }).unwrap()
    }

    #[test]
    fn aggregate_sql_builds_the_one_grouping_query_both_lists_read() {
        let sql = aggregate_sql("?1,?2", "AND m.address NOT IN (?1,?2)", "HAVING COUNT(*) > 0", 3, 4);
        assert!(sql.contains("m.address > ?3 AND m.address NOT IN (?1,?2) GROUP BY m.address HAVING COUNT(*) > 0 ORDER BY m.address LIMIT ?4"), "{sql}");
        assert!(sql.contains("f.address IN (?1,?2)"), "{sql}");
        assert!(aggregate_sql("''", "", "", 1, 2).contains("GROUP BY m.address  ORDER BY"));
    }

    #[test]
    fn every_address_that_sent_mail_is_listed_saved_or_not() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "al@x.io", "Al", "me@h.io");
        put(&c, "INBOX", 2, 2_000, "al@x.io", "Al", "me@h.io");
        put(&c, "INBOX", 3, 3_000, "bo@x.io", "Bo", "me@h.io");
        person(&c, "bo@x.io");
        let out = all(&c);
        assert_eq!(addrs(&out), ["al@x.io", "bo@x.io"]);
        assert_eq!((out[0].received, out[0].last_ms, out[0].name.as_str()), (2, 2_000, "Al"));
        assert_eq!((out[1].received, out[1].last_ms), (1, 3_000));
    }

    #[test]
    fn own_addresses_and_trash_only_senders_are_not_listed() {
        let (_t, c) = conn();
        put(&c, "Sent", 1, 1_000, "me@h.io", "Me", "bo@x.io");
        put(&c, "Trash", 2, 1_000, "tr@x.io", "Tr", "me@h.io");
        put(&c, "INBOX.Junk", 3, 1_000, "sp@x.io", "Sp", "me@h.io");
        put(&c, "INBOX", 4, 1_000, "ok@x.io", "Ok", "me@h.io");
        assert_eq!(addrs(&all(&c)), ["ok@x.io"]);
    }

    #[test]
    fn an_address_the_user_only_wrote_to_is_not_a_sender() {
        let (_t, c) = conn();
        put(&c, "Sent", 1, 1_000, "me@h.io", "Me", "bo@x.io");
        put(&c, "INBOX", 2, 1_000, "al@x.io", "Al", "me@h.io");
        assert_eq!(addrs(&all(&c)), ["al@x.io"]);
    }

    #[test]
    fn a_saved_sender_carries_its_person_id_and_favorite_flag() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "al@x.io", "Al", "me@h.io");
        put(&c, "INBOX", 2, 1_000, "bo@x.io", "Bo", "me@h.io");
        let id = person(&c, "al@x.io");
        update_person(&c, &id, &Patch { vip: Some(true), ..Default::default() }).unwrap();
        let out = all(&c);
        assert_eq!((out[0].person_id.as_deref(), out[0].favorite), (Some(id.as_str()), true));
        assert_eq!((out[1].person_id.clone(), out[1].favorite), (None, false));
    }

    #[test]
    fn a_deleted_contact_no_longer_owns_its_address() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "al@x.io", "Al", "me@h.io");
        let id = person(&c, "al@x.io");
        delete_person(&c, &id).unwrap();
        assert_eq!(all(&c)[0].person_id, None);
    }

    #[test]
    fn pages_follow_the_cursor_and_cover_every_sender_once() {
        let (_t, c) = conn();
        for (i, a) in ["a@x.io", "b@x.io", "c@x.io"].iter().enumerate() {
            put(&c, "INBOX", i as u32 + 1, 1_000, a, "", "me@h.io");
        }
        let (p1, n1) = page(&c, &own(), "", 2).unwrap();
        assert_eq!(addrs(&p1), ["a@x.io", "b@x.io"]);
        let (p2, n2) = page(&c, &own(), n1.as_deref().unwrap(), 2).unwrap();
        assert_eq!(addrs(&p2), ["c@x.io"]);
        assert!(n2.is_none());
    }

    #[test]
    fn pick_filters_by_name_or_address_case_insensitively() {
        let pool = vec![sender("ann@x.io", "Zed", 1, 0, 1), sender("b@x.io", "Anna", 1, 0, 1), sender("c@x.io", "Cy", 1, 0, 1)];
        let (out, total) = pick(pool, Some("ANN"), Sort::Name, 0, 10);
        assert_eq!((addrs(&out), total), (vec!["b@x.io", "ann@x.io"], 2));
    }

    #[test]
    fn pick_sorts_by_name_total_and_last_and_pages() {
        let pool = || vec![sender("a@x.io", "Cy", 1, 0, 30), sender("b@x.io", "", 5, 5, 10), sender("c@x.io", "Al", 3, 0, 20), sender("d@x.io", "Bo", 2, 0, 5)];
        assert_eq!(addrs(&pick(pool(), None, Sort::Name, 0, 10).0), ["c@x.io", "b@x.io", "d@x.io", "a@x.io"]);
        assert_eq!(addrs(&pick(pool(), None, Sort::Total, 0, 10).0), ["b@x.io", "c@x.io", "d@x.io", "a@x.io"]);
        assert_eq!(addrs(&pick(pool(), None, Sort::Last, 0, 10).0), ["a@x.io", "c@x.io", "b@x.io", "d@x.io"]);
        let (out, total) = pick(pool(), None, Sort::Last, 1, 2);
        assert_eq!((addrs(&out), total), (vec!["c@x.io", "b@x.io"], 4));
    }

    #[test]
    fn owners_of_an_empty_list_is_empty() {
        let (_t, c) = conn();
        assert!(owners(&c, &[]).unwrap().is_empty());
    }
}
