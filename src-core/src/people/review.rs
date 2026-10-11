//! Review queue: addresses seen in the user's own mail that are not yet a
//! person. Read-only over `message_addr`, except `accept` and `dismiss`.
use crate::people::message_addr::normalize;
use crate::people::model::now_ms;
use crate::people::store::{create_person, find_person_by_address, NewPerson};
use rusqlite::{params, params_from_iter, types::Value as Sql, Connection};
use serde::{Deserialize, Serialize};

fn err(e: rusqlite::Error) -> String { e.to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub address: String,
    pub name: String,
    pub received: u64,
    pub sent_to: u64,
    pub last_ms: i64,
}

/// Addresses of machines, not people: never worth a review line.
fn automated(address: &str) -> bool {
    let local = address.split('@').next().unwrap_or("");
    let local = local.split('+').next().unwrap_or("");
    let squashed: String = local.chars().filter(|c| !matches!(c, '-' | '_' | '.')).flat_map(char::to_lowercase).collect();
    matches!(
        squashed.as_str(),
        "noreply" | "donotreply" | "mailerdaemon" | "postmaster" | "bounce" | "bounces" | "notification" | "notifications"
    )
}

/// One page of review candidates: up to `max_addresses` addresses after
/// `after` (exclusive, ordered by address), plus the cursor for the next page.
/// The daemon loops this and takes the custody lock once per page, so no call
/// is a long scan of `message_addr`. Pages hold raw candidates; `finalize`
/// ranks and filters them.
pub fn candidates_page(conn: &Connection, own: &[String], after: &str, max_addresses: usize) -> Result<(Vec<Candidate>, Option<String>), String> {
    let own_lc: Vec<String> = own.iter().filter_map(|a| normalize(a)).collect();
    // `x NOT IN (NULL)` is NULL, which would filter every row: an empty list is `''`.
    let own_ph = if own_lc.is_empty() { "''".to_string() } else { (1..=own_lc.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",") };
    let mut args: Vec<Sql> = own_lc.iter().map(|a| Sql::Text(a.clone())).collect();
    args.push(Sql::Text(after.to_string()));
    let after_n = args.len();
    args.push(Sql::Integer(max_addresses as i64));
    let lim = args.len();
    let key = "m.account_id||char(31)||m.msg_key";
    let sql = format!(
        "SELECT m.address, MAX(m.name), \
           COUNT(DISTINCT CASE WHEN m.role='from' THEN {key} END), \
           COUNT(DISTINCT CASE WHEN m.role IN ('to','bcc') AND EXISTS(SELECT 1 FROM message_addr f WHERE f.account_id=m.account_id \
             AND f.mailbox_path=m.mailbox_path AND f.uid=m.uid AND f.role='from' AND f.address IN ({own_ph})) THEN {key} END), \
           MAX(m.sort_ms) \
         FROM message_addr m \
         WHERE m.counted=1 AND m.address > ?{after_n} \
           AND m.address NOT IN (SELECT address FROM record_address) \
           AND m.address NOT IN (SELECT address FROM review_dismissed) \
           AND m.address NOT IN ({own_ph}) \
         GROUP BY m.address ORDER BY m.address LIMIT ?{lim}"
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt
        .query_map(params_from_iter(args), |r| {
            Ok(Candidate { address: r.get(0)?, name: r.get(1)?, received: r.get::<_, i64>(2)? as u64, sent_to: r.get::<_, i64>(3)? as u64, last_ms: r.get(4)? })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let next = (rows.len() == max_addresses).then(|| rows.last().map(|c| c.address.clone())).flatten();
    Ok((rows, next))
}

/// Rank the pooled candidates (most written-to first, then most received, then
/// newest) and return the best `limit`. Pure.
pub fn rank(mut pool: Vec<Candidate>, limit: usize) -> Vec<Candidate> {
    pool.retain(|c| !automated(&c.address));
    pool.sort_by(|a, b| {
        b.sent_to
            .cmp(&a.sent_to)
            .then(b.received.cmp(&a.received))
            .then(b.last_ms.cmp(&a.last_ms))
            .then_with(|| a.address.cmp(&b.address))
    });
    pool.truncate(limit);
    pool
}

/// Drop bulk senders (a List-Unsubscribe header on any message from them) from
/// the best `limit` ranked candidates, one small lookup each.
pub fn finalize(conn: &Connection, ranked: Vec<Candidate>, limit: usize) -> Result<Vec<Candidate>, String> {
    let mut out = Vec::new();
    for c in ranked {
        if is_bulk(conn, &c.address)? {
            continue;
        }
        out.push(c);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Every page at once. Tests and small tools only: the daemon pages.
pub fn candidates(conn: &Connection, own: &[String], limit: usize) -> Result<Vec<Candidate>, String> {
    let (mut pool, mut cursor) = (Vec::new(), String::new());
    loop {
        let (page, next) = candidates_page(conn, own, &cursor, 2000)?;
        pool.extend(page);
        match next {
            Some(n) => cursor = n,
            None => break,
        }
    }
    let ranked = rank(pool, limit * 4 + 50);
    finalize(conn, ranked, limit)
}

/// Any message from this sender carrying a List-Unsubscribe header marks it as bulk mail.
fn is_bulk(conn: &Connection, address: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM message_addr m JOIN header_cache h ON h.account_id=m.account_id AND h.mailbox_path=m.mailbox_path AND h.uid=m.uid \
         WHERE m.address=?1 AND m.role='from' AND json_extract(h.header_json,'$.listUnsubscribe') IS NOT NULL LIMIT 1)",
        [address],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .map_err(err)
}

pub fn accept(conn: &Connection, address: &str, name: &str) -> Result<String, String> {
    let a = normalize(address).ok_or("E_INVALID: not an email address")?;
    if let Some(id) = find_person_by_address(conn, &a)? {
        return Ok(id);
    }
    let display = if name.trim().is_empty() { a.clone() } else { name.trim().to_string() };
    create_person(conn, &NewPerson { display_name: display, emails: vec![a], ..Default::default() })
}

pub fn dismiss(conn: &Connection, addresses: &[String]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    for a in addresses.iter().filter_map(|a| normalize(a)) {
        tx.execute("INSERT OR REPLACE INTO review_dismissed(address,ts_ms) VALUES (?1,?2)", params![a, now_ms()]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;
    use crate::people::message_addr::index_row;
    use serde_json::{json, Value};

    fn conn() -> (tempfile::TempDir, Connection) {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        (t, c)
    }
    fn own() -> Vec<String> { vec!["me@h.io".to_string(), "alias@h.io".to_string()] }

    fn put_header(c: &Connection, mailbox: &str, uid: u32, ms: i64, h: Value) {
        c.execute(
            "INSERT OR REPLACE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a',?1,?2,?3,0,?4)",
            params![mailbox, uid, ms, h.to_string()],
        )
        .unwrap();
        index_row(c, "a", mailbox, uid, ms, &h).unwrap();
    }
    fn put(c: &Connection, mailbox: &str, uid: u32, ms: i64, from: &str, to: &str) {
        put_header(c, mailbox, uid, ms, json!({"uid": uid, "messageId": format!("<{mailbox}-{uid}@t>"), "from": {"address": from, "name": "Sender"}, "to": [{"address": to}]}));
    }
    fn addrs(v: &[Candidate]) -> Vec<&str> { v.iter().map(|c| c.address.as_str()).collect() }
    fn cand(address: &str, received: u64, sent_to: u64, last_ms: i64) -> Candidate {
        Candidate { address: address.into(), name: String::new(), received, sent_to, last_ms }
    }

    #[test]
    fn an_unknown_address_is_listed_with_its_counts() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "al@x.io", "me@h.io");
        put(&c, "INBOX", 2, 2_000, "al@x.io", "me@h.io");
        let out = candidates(&c, &own(), 10).unwrap();
        assert_eq!(addrs(&out), ["al@x.io"]);
        assert_eq!((out[0].received, out[0].sent_to, out[0].last_ms), (2, 0, 2_000));
        assert_eq!(out[0].name, "Sender");
    }

    #[test]
    fn an_address_only_in_trash_or_junk_is_not_listed() {
        let (_t, c) = conn();
        put(&c, "Trash", 1, 1_000, "tr@x.io", "me@h.io");
        put(&c, "INBOX.Junk", 1, 1_000, "sp@x.io", "me@h.io");
        put(&c, "INBOX", 1, 1_000, "ok@x.io", "me@h.io");
        assert_eq!(addrs(&candidates(&c, &own(), 10).unwrap()), ["ok@x.io"]);
    }

    #[test]
    fn own_addresses_are_never_candidates() {
        let (_t, c) = conn();
        put(&c, "Sent", 1, 1_000, "me@h.io", "bo@x.io");
        put(&c, "INBOX", 2, 1_000, "alias@h.io", "me@h.io");
        assert_eq!(addrs(&candidates(&c, &own(), 10).unwrap()), ["bo@x.io"]);
    }

    #[test]
    fn an_empty_own_list_filters_nothing() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "al@x.io", "me@h.io");
        let out = candidates(&c, &[], 10).unwrap();
        assert_eq!(addrs(&out), ["al@x.io", "me@h.io"]);
    }

    #[test]
    fn a_dismissed_address_is_not_listed() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "al@x.io", "me@h.io");
        put(&c, "INBOX", 2, 1_000, "bo@x.io", "me@h.io");
        dismiss(&c, &["  AL@x.io ".to_string(), "not an address".to_string()]).unwrap();
        assert_eq!(addrs(&candidates(&c, &own(), 10).unwrap()), ["bo@x.io"]);
    }

    #[test]
    fn an_address_already_on_a_record_is_not_listed() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "al@x.io", "me@h.io");
        put(&c, "INBOX", 2, 1_000, "bo@x.io", "me@h.io");
        create_person(&c, &NewPerson { display_name: "Al".into(), emails: vec!["al@x.io".into()], ..Default::default() }).unwrap();
        assert_eq!(addrs(&candidates(&c, &own(), 10).unwrap()), ["bo@x.io"]);
    }

    #[test]
    fn rank_removes_automated_senders() {
        let out = rank(
            vec![cand("noreply@x.io", 9, 0, 1), cand("No-Reply@x.io", 9, 0, 1), cand("mailer-daemon@x.io", 9, 0, 1), cand("bounces+ab12@x.io", 9, 0, 1), cand("jo@x.io", 1, 0, 1)],
            10,
        );
        assert_eq!(addrs(&out), ["jo@x.io"]);
    }

    #[test]
    fn rank_puts_the_people_written_to_first_and_truncates_to_the_limit() {
        let pool = vec![cand("a@x.io", 50, 0, 9), cand("b@x.io", 1, 3, 1), cand("c@x.io", 5, 0, 9), cand("d@x.io", 5, 0, 5), cand("e@x.io", 2, 3, 1)];
        let out = rank(pool, 4);
        assert_eq!(addrs(&out), ["e@x.io", "b@x.io", "a@x.io", "c@x.io"]);
    }

    #[test]
    fn people_the_user_writes_to_count_as_sent_to() {
        let (_t, c) = conn();
        put(&c, "Sent", 1, 1_000, "me@h.io", "bo@x.io");
        put(&c, "Sent", 2, 2_000, "alias@h.io", "bo@x.io");
        put(&c, "INBOX", 3, 3_000, "al@x.io", "me@h.io");
        let out = candidates(&c, &own(), 10).unwrap();
        assert_eq!(addrs(&out), ["bo@x.io", "al@x.io"]);
        assert_eq!((out[0].sent_to, out[0].received), (2, 0));
    }

    #[test]
    fn a_bulk_sender_is_removed_by_finalize() {
        let (_t, c) = conn();
        put_header(&c, "INBOX", 1, 1_000, json!({"uid": 1, "messageId": "<n1@t>", "listUnsubscribe": "<mailto:u@news.io>", "from": {"address": "news@news.io"}, "to": [{"address": "me@h.io"}]}));
        put(&c, "INBOX", 2, 1_000, "friend@x.io", "me@h.io");
        assert_eq!(addrs(&candidates(&c, &own(), 10).unwrap()), ["friend@x.io"]);
    }

    #[test]
    fn pages_follow_the_cursor_and_cover_every_address_once() {
        let (_t, c) = conn();
        for (i, a) in ["a@x.io", "b@x.io", "c@x.io"].iter().enumerate() {
            put(&c, "INBOX", i as u32 + 1, 1_000, a, "me@h.io");
        }
        let (p1, n1) = candidates_page(&c, &own(), "", 2).unwrap();
        assert_eq!(addrs(&p1), ["a@x.io", "b@x.io"]);
        let (p2, n2) = candidates_page(&c, &own(), n1.as_deref().unwrap(), 2).unwrap();
        assert_eq!(addrs(&p2), ["c@x.io"]);
        assert!(n2.is_none());
    }

    #[test]
    fn accept_links_an_existing_address_instead_of_duplicating() {
        let (_t, c) = conn();
        let id = create_person(&c, &NewPerson { display_name: "Al".into(), emails: vec!["al@x.io".into()], ..Default::default() }).unwrap();
        assert_eq!(accept(&c, " <AL@x.io> ", "Another Name").unwrap(), id);
        let n: i64 = c.query_row("SELECT count(*) FROM person", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn accept_creates_a_person_and_the_address_leaves_the_queue() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "bo@x.io", "me@h.io");
        let id = accept(&c, "bo@x.io", "  Bo  ").unwrap();
        assert_eq!(find_person_by_address(&c, "bo@x.io").unwrap(), Some(id.clone()));
        let name: String = c.query_row("SELECT display_name FROM person WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(name, "Bo");
        assert!(candidates(&c, &own(), 10).unwrap().is_empty());
        let unnamed = accept(&c, "cy@x.io", "").unwrap();
        let name: String = c.query_row("SELECT display_name FROM person WHERE id=?1", [&unnamed], |r| r.get(0)).unwrap();
        assert_eq!(name, "cy@x.io");
    }

    #[test]
    fn accept_of_a_non_address_errors() {
        let (_t, c) = conn();
        assert!(accept(&c, "not an address", "X").is_err());
    }

    #[test]
    #[ignore = "perf budget; run with --ignored on the runner"]
    fn one_candidates_page_holds_the_lock_for_tens_of_milliseconds_on_200k_messages() {
        let (_t, c) = conn();
        let tx = c.unchecked_transaction().unwrap();
        for i in 0..200_000u32 {
            let h = json!({"uid": i, "messageId": format!("<m{i}@x>"), "from": {"address": format!("s{}@x.io", i % 5000)}, "to": [{"address": "me@h.io"}]});
            index_row(&tx, "a", "INBOX", i, 1000 + i as i64, &h).unwrap();
        }
        tx.commit().unwrap();
        let t0 = std::time::Instant::now();
        let (_, _) = candidates_page(&c, &own(), "", 2000).unwrap();
        let one_page = t0.elapsed();
        eprintln!("one page of 2000 addresses over 200k messages: {one_page:?}");
        assert!(one_page < std::time::Duration::from_millis(250), "one page held the lock for {one_page:?}");
    }
}
