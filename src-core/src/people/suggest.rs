//! One suggestion list, deterministic, with the reasons behind every rank.
use crate::people::correspondence::stats;
use crate::people::message_addr::normalize;
use crate::people::store::{card_addresses, get_card};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;

fn err(e: rusqlite::Error) -> String { e.to_string() }

const DAY_MS: f64 = 86_400_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextMatch { NamePrefix, AddressPrefix, Substring }

#[derive(Debug, Clone)]
pub struct Features {
    pub text: TextMatch,
    pub sent_to: u64,
    pub received: u64,
    pub last_ms: Option<i64>,
    pub in_account: bool,
    pub pinned: bool,
    pub vip: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    pub key: &'static str,
    pub n: Option<u64>,
    pub ms: Option<i64>,
}

fn reason(key: &'static str, n: Option<u64>, ms: Option<i64>) -> Reason { Reason { key, n, ms } }

pub fn score(f: &Features, now_ms: i64) -> (f64, Vec<Reason>) {
    let mut s = match f.text {
        TextMatch::NamePrefix => 40.0,
        TextMatch::AddressPrefix => 35.0,
        TextMatch::Substring => 15.0,
    };
    let mut why = Vec::new();
    if f.sent_to > 0 {
        s += 20.0 * (1.0 + f.sent_to as f64).ln();
        why.push(reason("sentTo", Some(f.sent_to), None));
    }
    if f.received > 0 {
        s += 8.0 * (1.0 + f.received as f64).ln();
        why.push(reason("received", Some(f.received), None));
    }
    if let Some(last) = f.last_ms.filter(|l| *l > 0) {
        let age_days = ((now_ms - last).max(0) as f64) / DAY_MS;
        s += 25.0 * 0.5f64.powf(age_days / 180.0);
        why.push(reason("last", None, Some(last)));
        if age_days > 1095.0 {
            s -= 20.0;
            why.push(reason("stale", None, Some(last)));
        }
    }
    if f.in_account {
        s += 10.0;
        why.push(reason("account", None, None));
    }
    if f.vip {
        s += 10.0;
        why.push(reason("vip", None, None));
    }
    if f.pinned {
        s += 100.0;
        why.push(reason("pinned", None, None));
    }
    (s, why)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub person_id: Option<String>,
    pub address: String,
    pub name: String,
    pub score: f64,
    pub reasons: Vec<Reason>,
    pub in_book: bool,
}

fn like(q: &str) -> String {
    format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

fn text_match(q: &str, name: &str, address: &str) -> Option<TextMatch> {
    if q.is_empty() {
        return Some(TextMatch::NamePrefix);
    }
    let lname = name.to_lowercase();
    if lname.split_whitespace().any(|w| w.starts_with(q)) || lname.starts_with(q) {
        return Some(TextMatch::NamePrefix);
    }
    if address.starts_with(q) {
        return Some(TextMatch::AddressPrefix);
    }
    (lname.contains(q) || address.contains(q)).then_some(TextMatch::Substring)
}

pub fn suggest(conn: &Connection, query: &str, own: &[String], from_account: Option<&str>, limit: usize, now_ms: i64) -> Result<Vec<Suggestion>, String> {
    let q = query.trim().to_lowercase();
    let own_lc: Vec<String> = own.iter().filter_map(|a| normalize(a)).collect();
    let mut out: Vec<Suggestion> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM person WHERE deleted_ms IS NULL AND blocked=0 AND search_text LIKE ?1 ESCAPE '\\' ORDER BY pinned DESC, lower(display_name) LIMIT 60")
            .map_err(err)?;
        let rows = stmt.query_map(params![like(&q)], |r| r.get::<_, String>(0)).map_err(err)?;
        let ids = rows.collect::<Result<Vec<_>, _>>().map_err(err)?;
        ids
    };
    for id in ids {
        let Some(card) = get_card(conn, &id)? else { continue };
        for addr in card_addresses(&card) {
            if own_lc.contains(&addr) || !seen.insert(addr.clone()) {
                continue;
            }
            let Some(tm) = text_match(&q, &card.display_name, &addr) else { continue };
            let st = stats(conn, std::slice::from_ref(&addr), &own_lc, None)?;
            let in_account = match from_account {
                Some(a) => {
                    let s = stats(conn, std::slice::from_ref(&addr), &own_lc, Some(a))?;
                    s.received + s.sent_to + s.cc > 0
                }
                None => false,
            };
            let (sc, reasons) = score(
                &Features { text: tm, sent_to: st.sent_to, received: st.received, last_ms: st.last_ms, in_account, pinned: card.pinned, vip: card.vip },
                now_ms,
            );
            out.push(Suggestion { person_id: Some(card.id.clone()), address: addr, name: card.display_name.clone(), score: sc, reasons, in_book: true });
        }
    }

    if !own_lc.is_empty() && !q.is_empty() {
        let upper = own_lc.len() + 2;
        let ph = (1..=own_lc.len()).map(|i| format!("?{}", i + 1)).collect::<Vec<_>>().join(",");
        // Address prefix only, as a range the (address, sort_ms) index serves: a not-in-book
        // recipient is found by the start of its address, not by its name or a mid-address substring.
        let sql = format!(
            "SELECT m.address, MAX(m.name) FROM message_addr m \
             WHERE m.counted=1 AND m.role IN ('to','bcc') AND m.address >= ?1 AND m.address < ?{upper} \
               AND m.address NOT IN (SELECT address FROM record_address) \
               AND EXISTS(SELECT 1 FROM message_addr f WHERE f.account_id=m.account_id AND f.mailbox_path=m.mailbox_path AND f.uid=m.uid AND f.role='from' AND f.address IN ({ph})) \
             GROUP BY m.address LIMIT 60"
        );
        let mut stmt = conn.prepare(&sql).map_err(err)?;
        let mut args: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(q.clone())];
        args.extend(own_lc.iter().map(|a| rusqlite::types::Value::Text(a.clone())));
        args.push(rusqlite::types::Value::Text(format!("{q}\u{10FFFF}")));
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        for (addr, name) in rows {
            if own_lc.contains(&addr) || !seen.insert(addr.clone()) {
                continue;
            }
            let Some(tm) = text_match(&q, &name, &addr) else { continue };
            let st = stats(conn, std::slice::from_ref(&addr), &own_lc, None)?;
            let (sc, reasons) = score(
                &Features { text: tm, sent_to: st.sent_to, received: st.received, last_ms: st.last_ms, in_account: false, pinned: false, vip: false },
                now_ms,
            );
            out.push(Suggestion { person_id: None, address: addr, name, score: sc, reasons, in_book: false });
        }
    }

    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.address.cmp(&b.address)));
    out.truncate(limit);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::db;
    use crate::people::message_addr::index_row;
    use crate::people::store::{create_person, update_person, NewPerson, Patch};
    use serde_json::json;

    const DAY: i64 = 86_400_000;

    fn f() -> Features {
        Features { text: TextMatch::NamePrefix, sent_to: 0, received: 0, last_ms: None, in_account: false, pinned: false, vip: false }
    }

    #[test]
    fn writing_to_someone_outranks_only_hearing_from_them() {
        let now = 1_000 * DAY;
        let wrote = score(&Features { sent_to: 5, last_ms: Some(now - DAY), ..f() }, now).0;
        let heard = score(&Features { received: 5, last_ms: Some(now - DAY), ..f() }, now).0;
        assert!(wrote > heard);
    }

    #[test]
    fn recent_beats_old_and_very_old_is_penalised_with_a_reason() {
        let now = 3_000 * DAY;
        let (fresh, _) = score(&Features { sent_to: 3, last_ms: Some(now - DAY), ..f() }, now);
        let (old, why) = score(&Features { sent_to: 3, last_ms: Some(now - 2_000 * DAY), ..f() }, now);
        assert!(fresh > old);
        assert!(why.iter().any(|r| r.key == "stale"));
    }

    #[test]
    fn every_ranking_input_leaves_a_reason() {
        let now = 100 * DAY;
        let (_, r) = score(&Features { sent_to: 2, received: 4, last_ms: Some(now - DAY), in_account: true, pinned: true, vip: true, ..f() }, now);
        let keys: Vec<_> = r.iter().map(|x| x.key).collect();
        for k in ["sentTo", "received", "last", "account", "pinned", "vip"] {
            assert!(keys.contains(&k), "{k} missing in {keys:?}");
        }
    }

    #[test]
    fn name_prefix_beats_address_prefix_beats_substring() {
        let now = 10 * DAY;
        let s = |t| score(&Features { text: t, ..f() }, now).0;
        assert!(s(TextMatch::NamePrefix) > s(TextMatch::AddressPrefix));
        assert!(s(TextMatch::AddressPrefix) > s(TextMatch::Substring));
    }

    fn conn() -> (tempfile::TempDir, Connection) {
        let t = tempfile::tempdir().unwrap();
        let c = db::open(t.path()).unwrap();
        (t, c)
    }
    fn put(c: &Connection, mb: &str, uid: u32, ms: i64, from: &str, to: &str) {
        let h = json!({"uid": uid, "from": {"address": from}, "to": [{"name": "To Name", "address": to}]});
        c.execute(
            "INSERT OR REPLACE INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a',?1,?2,?3,0,?4)",
            params![mb, uid, ms, h.to_string()],
        )
        .unwrap();
        index_row(c, "a", mb, uid, ms, &h).unwrap();
    }

    #[test]
    fn suggests_people_and_unaccepted_recipients_but_never_receive_only_addresses_or_blocked_people() {
        let (_t, c) = conn();
        let own = vec!["me@h.io".to_string()];
        let known = create_person(&c, &NewPerson { display_name: "Anna Known".into(), emails: vec!["anna@x.io".into()], ..Default::default() }).unwrap();
        let blocked = create_person(&c, &NewPerson { display_name: "Anna Blocked".into(), emails: vec!["ab@x.io".into()], ..Default::default() }).unwrap();
        update_person(&c, &blocked, &Patch { blocked: Some(true), ..Default::default() }).unwrap();
        put(&c, "Sent", 1, 5_000, "me@h.io", "anne@y.io"); // wrote to, not in book
        put(&c, "INBOX", 2, 5_000, "annoying@y.io", "me@h.io"); // received only
        let out = suggest(&c, "ann", &own, None, 10, 6_000).unwrap();
        let addrs: Vec<_> = out.iter().map(|s| (s.address.as_str(), s.in_book)).collect();
        assert!(addrs.contains(&("anna@x.io", true)));
        assert!(addrs.contains(&("anne@y.io", false)));
        assert!(!addrs.iter().any(|(a, _)| *a == "annoying@y.io"));
        assert!(!addrs.iter().any(|(a, _)| *a == "ab@x.io"));
        assert_eq!(out.iter().find(|s| s.address == "anna@x.io").unwrap().person_id.as_deref(), Some(known.as_str()));
    }

    #[test]
    fn an_unknown_recipient_is_found_by_its_address_prefix_not_by_its_name_or_the_middle_of_its_address() {
        let (_t, c) = conn();
        let own = vec!["me@h.io".to_string()];
        put(&c, "Sent", 1, 5_000, "me@h.io", "zoe@y.io"); // its name is "To Name"
        let found = |q: &str| suggest(&c, q, &own, None, 10, 6_000).unwrap().iter().any(|s| s.address == "zoe@y.io" && !s.in_book);
        assert!(found("zo") && found("ZOE@y") && found("zoe@y.io"));
        assert!(!found("to name"), "the name of a not-in-book address is not searched");
        assert!(!found("oe@y"), "nor the middle of its address");
    }

    #[test]
    fn pinned_people_rank_first_and_empty_query_returns_the_best_known_people() {
        let (_t, c) = conn();
        let own = vec!["me@h.io".to_string()];
        let a = create_person(&c, &NewPerson { display_name: "Zed".into(), emails: vec!["z@x.io".into()], ..Default::default() }).unwrap();
        create_person(&c, &NewPerson { display_name: "Amy".into(), emails: vec!["amy@x.io".into()], ..Default::default() }).unwrap();
        put(&c, "Sent", 1, 5_000, "me@h.io", "amy@x.io");
        update_person(&c, &a, &Patch { pinned: Some(true), ..Default::default() }).unwrap();
        let out = suggest(&c, "", &own, None, 10, 6_000).unwrap();
        assert_eq!(out[0].address, "z@x.io");
    }

    #[test]
    fn a_hostile_query_is_just_text() {
        let (_t, c) = conn();
        create_person(&c, &NewPerson { display_name: "Plain".into(), emails: vec!["p@x.io".into()], ..Default::default() }).unwrap();
        assert!(suggest(&c, "%_\\'\"", &[], None, 10, 0).unwrap().is_empty());
    }
}
