//! Counts and the by-date list of mail exchanged with a set of addresses (one
//! person's linked addresses). Everything reads `message_addr`; own addresses
//! come from the caller on every call, so aliases are always current.
use rusqlite::{params_from_iter, types::Value as Sql, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn err(e: rusqlite::Error) -> String { e.to_string() }

/// A message's identity across the folders of one account (Gmail shows one
/// message under several labels): account plus `msg_key`.
const KEY: &str = "m.account_id||char(31)||m.msg_key";

fn in_list(start: usize, n: usize) -> String {
    if n == 0 { return "NULL".into(); }
    (start..start + n).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",")
}

fn from_own(own_ph: &str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM message_addr f WHERE f.account_id=m.account_id AND f.mailbox_path=m.mailbox_path \
         AND f.uid=m.uid AND f.role='from' AND f.address IN ({own_ph}))"
    )
}

fn texts(v: &[String]) -> impl Iterator<Item = Sql> + '_ { v.iter().map(|a| Sql::Text(a.clone())) }

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub received: u64,
    pub sent_to: u64,
    pub cc: u64,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
    pub last_sent_ms: Option<i64>,
}

pub fn stats(conn: &Connection, addrs: &[String], own: &[String], account: Option<&str>) -> Result<Stats, String> {
    if addrs.is_empty() { return Ok(Stats::default()); }
    let mut args: Vec<Sql> = texts(addrs).collect();
    let addr_ph = in_list(1, addrs.len());
    let own_ph = in_list(args.len() + 1, own.len());
    args.extend(texts(own));
    let mut acct = String::new();
    if let Some(a) = account {
        args.push(Sql::Text(a.into()));
        acct = format!(" AND m.account_id=?{}", args.len());
    }
    let fo = from_own(&own_ph);
    let sql = format!(
        "SELECT \
           COUNT(DISTINCT CASE WHEN m.role='from' THEN {KEY} END), \
           COUNT(DISTINCT CASE WHEN m.role IN ('to','bcc') AND {fo} THEN {KEY} END), \
           COUNT(DISTINCT CASE WHEN m.role='cc' THEN {KEY} END), \
           MIN(CASE WHEN m.sort_ms > 0 THEN m.sort_ms END), \
           MAX(m.sort_ms), \
           MAX(CASE WHEN m.role IN ('to','bcc','cc') AND {fo} THEN m.sort_ms END) \
         FROM message_addr m WHERE m.address IN ({addr_ph}) AND m.counted=1{acct}"
    );
    conn.query_row(&sql, params_from_iter(args), |r| {
        Ok(Stats {
            received: r.get::<_, i64>(0)? as u64,
            sent_to: r.get::<_, i64>(1)? as u64,
            cc: r.get::<_, i64>(2)? as u64,
            first_ms: r.get(3)?,
            last_ms: r.get(4)?,
            last_sent_ms: r.get(5)?,
        })
    })
    .map_err(err)
}

#[derive(Debug, Clone, Default)]
pub struct MsgFilter<'a> {
    pub account: Option<&'a str>,
    /// "received" | "sent" | "cc" | "other"
    pub direction: Option<&'a str>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub text: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub sort_ms: i64,
    pub account_id: String,
    pub mailbox_path: String,
    pub uid: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MsgRow {
    pub account_id: String,
    pub mailbox_path: String,
    pub uid: u32,
    pub sort_ms: i64,
    pub subject: String,
    pub direction: String,
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn messages(
    conn: &Connection,
    addrs: &[String],
    own: &[String],
    f: &MsgFilter,
    after: Option<&Cursor>,
    limit: usize,
) -> Result<Vec<MsgRow>, String> {
    if addrs.is_empty() { return Ok(Vec::new()); }
    let mut args: Vec<Sql> = texts(addrs).collect();
    let addr_ph = in_list(1, addrs.len());
    let own_ph = in_list(args.len() + 1, own.len());
    args.extend(texts(own));
    let push = |args: &mut Vec<Sql>, v: Sql| -> usize { args.push(v); args.len() };
    let mut inner = String::new();
    if let Some(a) = f.account {
        let n = push(&mut args, Sql::Text(a.into()));
        inner.push_str(&format!(" AND m.account_id=?{n}"));
    }
    if let Some(t) = f.from_ms {
        let n = push(&mut args, Sql::Integer(t));
        inner.push_str(&format!(" AND m.sort_ms>=?{n}"));
    }
    if let Some(t) = f.to_ms {
        let n = push(&mut args, Sql::Integer(t));
        inner.push_str(&format!(" AND m.sort_ms<?{n}"));
    }
    if let Some(t) = f.text.filter(|t| !t.is_empty()) {
        let n = push(&mut args, Sql::Text(format!("%{}%", escape_like(t))));
        inner.push_str(&format!(" AND COALESCE(json_extract(h.header_json,'$.subject'),'') LIKE ?{n} ESCAPE '\\'"));
    }
    let mut outer = String::from("1=1");
    if let Some(d) = f.direction {
        let n = push(&mut args, Sql::Text(d.into()));
        outer.push_str(&format!(" AND direction=?{n}"));
    }
    if let Some(c) = after {
        let s = push(&mut args, Sql::Integer(c.sort_ms));
        let a = push(&mut args, Sql::Text(c.account_id.clone()));
        let m = push(&mut args, Sql::Text(c.mailbox_path.clone()));
        let u = push(&mut args, Sql::Integer(c.uid as i64));
        outer.push_str(&format!(
            " AND (sort_ms<?{s} OR (sort_ms=?{s} AND (account_id,mailbox_path,uid)>(?{a},?{m},?{u})))"
        ));
    }
    let lim = push(&mut args, Sql::Integer(limit as i64));
    let with_subject = f.text.is_some_and(|t| !t.is_empty());
    let sql = page_sql(&addr_ph, &own_ph, &inner, &outer, lim, with_subject);
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt
        .query_map(params_from_iter(args), |r| {
            Ok(MsgRow {
                account_id: r.get(0)?,
                mailbox_path: r.get(1)?,
                uid: r.get(2)?,
                sort_ms: r.get(3)?,
                subject: r.get(4)?,
                direction: r.get(5)?,
            })
        })
        .map_err(err)?;
    let mut page = rows.collect::<Result<Vec<_>, _>>().map_err(err)?;
    if !with_subject {
        // the subjects of this one page only, not of every row the grouping walked
        let mut subject = conn
            .prepare_cached("SELECT COALESCE(json_extract(header_json,'$.subject'),'') FROM header_cache WHERE account_id=?1 AND mailbox_path=?2 AND uid=?3")
            .map_err(err)?;
        for row in &mut page {
            row.subject = subject
                .query_row(rusqlite::params![row.account_id, row.mailbox_path, row.uid], |r| r.get(0))
                .optional()
                .map_err(err)?
                .unwrap_or_default();
        }
    }
    Ok(page)
}

/// The grouping query behind `messages`. The subject is read (and `header_cache`
/// joined) only when the text filter needs it; otherwise the column is empty and
/// the caller fills in the subjects of the page it picked.
fn page_sql(addr_ph: &str, own_ph: &str, inner: &str, outer: &str, lim: usize, with_subject: bool) -> String {
    let fo = from_own(own_ph);
    let (subject, join) = if with_subject {
        (
            "COALESCE(json_extract(h.header_json,'$.subject'),'')",
            "JOIN header_cache h ON h.account_id=m.account_id AND h.mailbox_path=m.mailbox_path AND h.uid=m.uid ",
        )
    } else {
        ("''", "")
    };
    format!(
        "SELECT account_id, mailbox_path, uid, sort_ms, subject, direction FROM ( \
           SELECT m.account_id AS account_id, m.mailbox_path AS mailbox_path, m.uid AS uid, \
                  MAX(m.sort_ms) AS sort_ms, \
                  {subject} AS subject, \
                  CASE WHEN {fo} AND MAX(m.role IN ('to','bcc','cc')) THEN 'sent' \
                       WHEN MAX(m.role='from') THEN 'received' \
                       WHEN MAX(m.role='cc') THEN 'cc' ELSE 'other' END AS direction \
           FROM message_addr m \
           {join}\
           WHERE m.address IN ({addr_ph}) AND m.counted=1{inner} \
           GROUP BY m.account_id, m.msg_key \
         ) WHERE {outer} ORDER BY sort_ms DESC, account_id ASC, mailbox_path ASC, uid ASC LIMIT ?{lim}"
    )
}

/// Message count and latest date per address that belongs to a person, for
/// ONE page of addresses: at most `max_addresses` addresses after `after`
/// (exclusive, ordered), plus the cursor for the next page (`None` when done).
/// A caller that needs every address calls this in a loop, taking the custody
/// lock once per page, so no single call is a long scan. Used only when the
/// list is sorted by total or last contact. A person's total is the sum over
/// their addresses (a message to two of them counts twice here; the card's own
/// numbers come from `stats` and do not).
pub fn totals_page(conn: &Connection, after: &str, max_addresses: usize) -> Result<(HashMap<String, (u64, i64)>, Option<String>), String> {
    let mut stmt = conn
        .prepare(
            "SELECT address, COUNT(DISTINCT account_id||char(31)||msg_key), MAX(sort_ms) \
             FROM message_addr WHERE counted=1 AND address > ?1 AND address IN (SELECT address FROM record_address) \
             GROUP BY address ORDER BY address LIMIT ?2",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(rusqlite::params![after, max_addresses as i64], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)?))))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let next = (rows.len() == max_addresses).then(|| rows.last().map(|r| r.0.clone())).flatten();
    Ok((rows.into_iter().collect(), next))
}

/// All pages at once. Tests and small tools only: the daemon pages.
pub fn totals_by_address(conn: &Connection) -> Result<HashMap<String, (u64, i64)>, String> {
    let (mut all, mut cursor) = (HashMap::new(), String::new());
    loop {
        let (page, next) = totals_page(conn, &cursor, 500)?;
        all.extend(page);
        match next { Some(n) => cursor = n, None => return Ok(all) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;
    use crate::people::message_addr::index_row;
    use rusqlite::params;
    use serde_json::json;

    fn conn() -> (tempfile::TempDir, Connection) {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        (t, c)
    }
    /// Also write the header_cache row, since `messages` joins it for the subject.
    fn put(c: &Connection, mailbox: &str, uid: u32, ms: i64, subject: &str, from: &str, to: &[&str], cc: &[&str]) {
        put_id(c, mailbox, uid, ms, subject, from, to, cc, &format!("id-{mailbox}-{uid}"));
    }
    /// Same, with an explicit Message-ID so a test can put one message in two folders.
    fn put_id(c: &Connection, mailbox: &str, uid: u32, ms: i64, subject: &str, from: &str, to: &[&str], cc: &[&str], message_id: &str) {
        let h = json!({
            "uid": uid, "subject": subject, "messageId": message_id,
            "from": {"address": from},
            "to": to.iter().map(|a| json!({"address": a})).collect::<Vec<_>>(),
            "cc": cc.iter().map(|a| json!({"address": a})).collect::<Vec<_>>(),
        });
        c.execute(
            "INSERT OR REPLACE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a',?1,?2,?3,0,?4)",
            params![mailbox, uid, ms, h.to_string()],
        ).unwrap();
        index_row(c, "a", mailbox, uid, ms, &h).unwrap();
    }
    fn s(v: &[&str]) -> Vec<String> { v.iter().map(|x| x.to_string()).collect() }

    #[test]
    fn stats_split_received_sent_and_cc() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "hi", "al@x.io", &["me@h.io"], &[]);
        put(&c, "INBOX", 2, 2_000, "re", "al@x.io", &["me@h.io"], &[]);
        put(&c, "Sent", 1, 3_000, "yo", "me@h.io", &["al@x.io"], &[]);
        put(&c, "INBOX", 3, 4_000, "fyi", "bo@x.io", &["me@h.io"], &["al@x.io"]);
        let st = stats(&c, &s(&["al@x.io"]), &s(&["me@h.io"]), None).unwrap();
        assert_eq!((st.received, st.sent_to, st.cc), (2, 1, 1));
        assert_eq!(st.first_ms, Some(1_000));
        assert_eq!(st.last_ms, Some(4_000));
        assert_eq!(st.last_sent_ms, Some(3_000));
    }

    #[test]
    fn a_person_with_two_addresses_on_one_message_counts_it_once() {
        let (_t, c) = conn();
        put(&c, "Sent", 1, 5_000, "x", "me@h.io", &["al@x.io", "al@work.io"], &[]);
        let st = stats(&c, &s(&["al@x.io", "al@work.io"]), &s(&["me@h.io"]), None).unwrap();
        assert_eq!(st.sent_to, 1);
    }

    #[test]
    fn trash_and_junk_do_not_count_and_unknown_dates_do_not_set_first_seen() {
        let (_t, c) = conn();
        put(&c, "Trash", 1, 9_000, "x", "al@x.io", &["me@h.io"], &[]);
        put(&c, "INBOX", 2, i64::MIN + 2, "undated", "al@x.io", &["me@h.io"], &[]);
        put(&c, "INBOX", 3, 7_000, "dated", "al@x.io", &["me@h.io"], &[]);
        let st = stats(&c, &s(&["al@x.io"]), &s(&["me@h.io"]), None).unwrap();
        assert_eq!(st.received, 2);
        assert_eq!(st.first_ms, Some(7_000));
    }

    #[test]
    fn one_message_in_two_gmail_label_folders_is_counted_once_and_listed_once() {
        let (_t, c) = conn();
        // the same received message, visible as INBOX and as label folder "Work" (Gmail IMAP)
        put_id(&c, "INBOX", 10, 5_000, "Quarterly", "al@x.io", &["me@h.io"], &[], "<q1@x.io>");
        put_id(&c, "Work", 4, 5_000, "Quarterly", "al@x.io", &["me@h.io"], &[], "<q1@x.io>");
        // and a message I sent, also in All Mail
        put_id(&c, "Sent", 3, 6_000, "Re: Quarterly", "me@h.io", &["al@x.io"], &[], "<q2@h.io>");
        put_id(&c, "[Gmail]/All Mail", 99, 6_000, "Re: Quarterly", "me@h.io", &["al@x.io"], &[], "<q2@h.io>");
        let own = s(&["me@h.io"]);
        let a = s(&["al@x.io"]);
        let st = stats(&c, &a, &own, None).unwrap();
        assert_eq!((st.received, st.sent_to), (1, 1));
        let list = messages(&c, &a, &own, &MsgFilter::default(), None, 10).unwrap();
        assert_eq!(list.len(), 2, "{list:?}");
        // the same Message-ID in two DIFFERENT accounts is two messages
        c.execute("UPDATE message_addr SET account_id='b' WHERE mailbox_path='Work'", []).unwrap();
        assert_eq!(stats(&c, &a, &own, None).unwrap().received, 2);
    }

    #[test]
    fn empty_address_list_is_zero_not_an_error() {
        let (_t, c) = conn();
        assert_eq!(stats(&c, &[], &[], None).unwrap().received, 0);
        assert!(messages(&c, &[], &[], &MsgFilter::default(), None, 10).unwrap().is_empty());
    }

    #[test]
    fn messages_page_newest_first_with_a_stable_cursor() {
        let (_t, c) = conn();
        for i in 1..=5u32 { put(&c, "INBOX", i, 1_000 * i as i64, &format!("m{i}"), "al@x.io", &["me@h.io"], &[]); }
        let own = s(&["me@h.io"]);
        let a = s(&["al@x.io"]);
        let p1 = messages(&c, &a, &own, &MsgFilter::default(), None, 2).unwrap();
        assert_eq!(p1.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["m5", "m4"]);
        let last = p1.last().unwrap();
        let cur = Cursor { sort_ms: last.sort_ms, account_id: last.account_id.clone(), mailbox_path: last.mailbox_path.clone(), uid: last.uid };
        let p2 = messages(&c, &a, &own, &MsgFilter::default(), Some(&cur), 10).unwrap();
        assert_eq!(p2.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["m3", "m2", "m1"]);
    }

    #[test]
    fn a_page_of_a_long_correspondence_has_the_right_subjects_and_the_grouping_skips_header_cache_without_a_text_filter() {
        let (_t, c) = conn();
        for i in 1..=300u32 { put(&c, "INBOX", i, 1_000 * i as i64, &format!("m{i}"), "al@x.io", &["me@h.io"], &[]); }
        let (own, a) = (s(&["me@h.io"]), s(&["al@x.io"]));
        let p1 = messages(&c, &a, &own, &MsgFilter::default(), None, 50).unwrap();
        assert_eq!(p1.len(), 50);
        assert_eq!((p1[0].subject.as_str(), p1[49].subject.as_str()), ("m300", "m251"));
        assert!(p1.iter().all(|r| r.direction == "received"));
        let last = p1.last().unwrap();
        let cur = Cursor { sort_ms: last.sort_ms, account_id: last.account_id.clone(), mailbox_path: last.mailbox_path.clone(), uid: last.uid };
        let p2 = messages(&c, &a, &own, &MsgFilter::default(), Some(&cur), 50).unwrap();
        assert_eq!((p2[0].subject.as_str(), p2[49].subject.as_str()), ("m250", "m201"));
        let hit = messages(&c, &a, &own, &MsgFilter { text: Some("m17"), ..Default::default() }, None, 50).unwrap();
        assert_eq!(hit.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["m179", "m178", "m177", "m176", "m175", "m174", "m173", "m172", "m171", "m170", "m17"]);

        assert!(!page_sql("?1", "?2", "", "1=1", 3, false).contains("header_cache"));
        assert!(page_sql("?1", "?2", "", "1=1", 3, true).contains("header_cache"));
    }

    #[test]
    fn messages_carry_a_direction_and_filter_by_it_text_and_year() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "Invoice March", "al@x.io", &["me@h.io"], &[]);
        put(&c, "Sent", 1, 2_000, "Re: Invoice", "me@h.io", &["al@x.io"], &[]);
        put(&c, "INBOX", 2, 3_000, "Lunch", "bo@x.io", &["me@h.io"], &["al@x.io"]);
        let own = s(&["me@h.io"]);
        let a = s(&["al@x.io"]);
        let all = messages(&c, &a, &own, &MsgFilter::default(), None, 10).unwrap();
        let dirs: Vec<_> = all.iter().map(|r| (r.subject.as_str(), r.direction.as_str())).collect();
        assert_eq!(dirs, [("Lunch", "cc"), ("Re: Invoice", "sent"), ("Invoice March", "received")]);
        let sent = messages(&c, &a, &own, &MsgFilter { direction: Some("sent"), ..Default::default() }, None, 10).unwrap();
        assert_eq!(sent.len(), 1);
        let text = messages(&c, &a, &own, &MsgFilter { text: Some("invoice"), ..Default::default() }, None, 10).unwrap();
        assert_eq!(text.len(), 2);
        let ranged = messages(&c, &a, &own, &MsgFilter { from_ms: Some(1_500), to_ms: Some(2_500), ..Default::default() }, None, 10).unwrap();
        assert_eq!(ranged.len(), 1);
    }

    #[test]
    fn text_filter_treats_percent_and_underscore_literally() {
        let (_t, c) = conn();
        put(&c, "INBOX", 1, 1_000, "100% done", "al@x.io", &["me@h.io"], &[]);
        put(&c, "INBOX", 2, 2_000, "plain", "al@x.io", &["me@h.io"], &[]);
        let r = messages(&c, &s(&["al@x.io"]), &[], &MsgFilter { text: Some("%"), ..Default::default() }, None, 10).unwrap();
        assert_eq!(r.len(), 1);
    }
}
