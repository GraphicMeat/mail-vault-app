//! Every address seen in mail, ranked for the compose pickers and named for
//! the privacy dictionary. The input is the daemon's per-account contacts
//! index (address, name, count, last seen); nothing here needs the address
//! book. Ported from the app's `src/utils/contactsIndex.js`.
use crate::notes_to_self::normalize_identity;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};

/// One address as one account's contacts index holds it.
#[derive(Debug, Clone, Default)]
pub struct Entry {
    pub address: String,
    pub name: String,
    pub count: u64,
    pub last_seen: i64,
}

/// One address across every account that saw it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub address: String,
    pub name: String,
    pub count: u64,
    pub last_seen: i64,
    pub account_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Top {
    pub latest: Vec<Contact>,
    pub popular: Vec<Contact>,
}

/// One row per address. The user's own addresses (logins, default From,
/// aliases; Gmail dot- and plus-folded) are left out. Counts add up across
/// accounts; the name is the one of the account that saw the address last.
pub fn merge(per_account: &[(String, Vec<Entry>)], own: &[String]) -> Vec<Contact> {
    let own: HashSet<String> = own.iter().map(|a| normalize_identity(a)).collect();
    let mut out: Vec<Contact> = Vec::new();
    // per address: its row in `out` and when its name was seen
    let mut at: HashMap<String, (usize, i64)> = HashMap::new();
    for (account, entries) in per_account {
        for e in entries {
            let address = e.address.trim().to_lowercase();
            if !address.contains('@') || own.contains(&normalize_identity(&address)) {
                continue;
            }
            let name = e.name.trim();
            let (i, name_seen) = match at.get(&address) {
                Some(&slot) => slot,
                None => {
                    out.push(Contact { address: address.clone(), name: String::new(), count: 0, last_seen: 0, account_ids: Vec::new() });
                    (out.len() - 1, i64::MIN)
                }
            };
            let c = &mut out[i];
            c.count += e.count;
            c.last_seen = c.last_seen.max(e.last_seen);
            if !c.account_ids.contains(account) {
                c.account_ids.push(account.clone());
            }
            let mut seen = name_seen;
            if !name.is_empty() && (c.name.is_empty() || e.last_seen >= name_seen) {
                c.name = name.to_string();
                seen = e.last_seen;
            }
            at.insert(address, (i, seen));
        }
    }
    out
}

fn in_account(c: &Contact, account: &str) -> bool {
    c.account_ids.iter().any(|a| a == account)
}

/// The picker popover's two lists, for one account (`None` = all of them).
pub fn top(contacts: &[Contact], account: Option<&str>, limit: usize) -> Top {
    let mut latest: Vec<Contact> = contacts.iter().filter(|c| account.is_none_or(|a| in_account(c, a))).cloned().collect();
    let mut popular = latest.clone();
    latest.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then_with(|| a.address.cmp(&b.address)));
    popular.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| b.last_seen.cmp(&a.last_seen)).then_with(|| a.address.cmp(&b.address)));
    latest.truncate(limit);
    popular.truncate(limit);
    Top { latest, popular }
}

/// Recipient autocomplete: the address starts with the query or the name
/// contains it. Contacts of `boost` come first; each tier is most recent first.
pub fn search(contacts: &[Contact], query: &str, boost: Option<&str>, limit: usize) -> Vec<Contact> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<(bool, &Contact)> = contacts
        .iter()
        .filter(|c| c.address.starts_with(&q) || c.name.to_lowercase().contains(&q))
        .map(|c| (boost.is_some_and(|a| in_account(c, a)), c))
        .collect();
    hits.sort_by(|(ba, a), (bb, b)| {
        bb.cmp(ba)
            .then_with(|| b.last_seen.cmp(&a.last_seen))
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.address.cmp(&b.address))
    });
    hits.into_iter().take(limit).map(|(_, c)| c.clone()).collect()
}

/// Every display name any account saw, the user's own included: a missed
/// name is a name privacy mode does not mask.
pub fn names(per_account: &[(String, Vec<Entry>)]) -> Vec<String> {
    let set: BTreeSet<String> = per_account
        .iter()
        .flat_map(|(_, entries)| entries.iter())
        .map(|e| e.name.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    // The daemon contacts index for the parity fixture, as `contacts_index.get`
    // returned it on 2026-10-19 (two accounts, own addresses me@h.io,
    // me@work.io, me+alias@h.io; Trash and Archive are never indexed).
    const SNAPSHOT: &str = include_str!("../../tests/fixtures/seen-contacts-snapshot.json");
    const OWN: [&str; 3] = ["me@h.io", "me@work.io", "me+alias@h.io"];

    fn entries(v: &Value) -> Vec<Entry> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|e| Entry {
                address: e["address"].as_str().unwrap().into(),
                name: e["name"].as_str().unwrap().into(),
                count: e["count"].as_u64().unwrap(),
                last_seen: e["lastSeen"].as_i64().unwrap(),
            })
            .collect()
    }
    fn fixture() -> Vec<(String, Vec<Entry>)> {
        let v: Value = serde_json::from_str(SNAPSHOT).unwrap();
        ["a1", "a2"].iter().map(|a| (a.to_string(), entries(&v[*a]))).collect()
    }
    fn own() -> Vec<String> {
        OWN.iter().map(|s| s.to_string()).collect()
    }
    fn addrs(list: &[Contact]) -> Vec<&str> {
        list.iter().map(|c| c.address.as_str()).collect()
    }
    fn e(address: &str, name: &str, count: u64, last_seen: i64) -> Entry {
        Entry { address: address.into(), name: name.into(), count, last_seen }
    }

    /// What `searchContacts(index, q, 6, boost)` in contactsIndex.js returned
    /// for the same snapshot (vitest run on the mini, 2026-10-19).
    #[test]
    fn search_matches_the_js_index_query_for_query() {
        let all = merge(&fixture(), &own());
        let cases: &[(&str, Option<&str>, &[&str])] = &[
            ("ann", None, &["annoying@news.io", "anna@x.io", "ann.lee@y.io", "bob@b.io", "jo@d.io", "annabel@old.io"]),
            ("ann", Some("a1"), &["annoying@news.io", "anna@x.io", "ann.lee@y.io", "bob@b.io", "jo@d.io", "annabel@old.io"]),
            ("ann", Some("a2"), &["ann.lee@y.io", "annoying@news.io", "anna@x.io", "bob@b.io", "jo@d.io", "annabel@old.io"]),
            ("an", Some("a1"), &["annoying@news.io", "anna@x.io", "anders@q.io", "ann.lee@y.io", "bob@b.io", "jo@d.io"]),
            ("a", Some("a1"), &["annoying@news.io", "anna@x.io", "anders@q.io", "ann.lee@y.io", "bob@b.io", "carl@c.io"]),
            ("anna", None, &["anna@x.io", "jo@d.io", "annabel@old.io"]),
            ("ann l", None, &["ann.lee@y.io"]),
            ("lee", None, &["ann.lee@y.io"]),
            ("smith", None, &["anna@x.io"]),
            ("x.io", None, &[]),
            ("zoe", None, &["zoe@z.io"]),
            ("zoë", None, &["zoe@z.io"]),
            ("ang", None, &[]),
            ("doe", None, &["jo@d.io", "john.doe@d.io"]),
            ("john", None, &["john.doe@d.io"]),
            ("berg", None, &["bob@b.io"]),
            ("bob", None, &["bob@b.io"]),
            ("news", None, &[]),
            ("anders", None, &["anders@q.io"]),
            ("carl", None, &["carl@c.io"]),
            ("arch", None, &[]),
            ("andrea", Some("a1"), &["andrea@w.io"]),
            ("anne", None, &[]),
            ("  ANN L ", None, &["ann.lee@y.io"]),
            ("", None, &[]),
        ];
        for (q, boost, want) in cases {
            assert_eq!(addrs(&search(&all, q, *boost, 6)), *want, "query {q:?} boost {boost:?}");
        }
    }

    #[test]
    fn a_match_keeps_its_name_count_and_accounts() {
        let all = merge(&fixture(), &own());
        let lee = search(&all, "lee", None, 6).remove(0);
        assert_eq!(lee, Contact { address: "ann.lee@y.io".into(), name: "Ann Lee".into(), count: 3, last_seen: 1792054800000, account_ids: vec!["a1".into(), "a2".into()] });
    }

    /// `getContactsForAccount(index, account)` from contactsIndex.js, same run.
    #[test]
    fn the_picker_lists_match_the_js_index() {
        let all = merge(&fixture(), &own());
        let latest_all = ["annoying@news.io", "anna@x.io", "anders@q.io", "ann.lee@y.io", "bob@b.io", "carl@c.io", "jo@d.io", "zoe@z.io", "john.doe@d.io", "andrea@w.io", "annabel@old.io"];
        let popular_all = ["annoying@news.io", "anna@x.io", "ann.lee@y.io", "andrea@w.io", "anders@q.io", "bob@b.io", "carl@c.io", "jo@d.io", "zoe@z.io", "john.doe@d.io", "annabel@old.io"];
        let t = top(&all, None, 50);
        assert_eq!(addrs(&t.latest), latest_all);
        assert_eq!(addrs(&t.popular), popular_all);
        let t1 = top(&all, Some("a1"), 50);
        assert_eq!(addrs(&t1.latest), latest_all.iter().copied().filter(|a| *a != "andrea@w.io").collect::<Vec<_>>());
        assert_eq!(addrs(&t1.popular), popular_all.iter().copied().filter(|a| *a != "andrea@w.io").collect::<Vec<_>>());
        let t2 = top(&all, Some("a2"), 50);
        assert_eq!(addrs(&t2.latest), ["ann.lee@y.io", "andrea@w.io"]);
        assert_eq!(addrs(&t2.popular), ["ann.lee@y.io", "andrea@w.io"]);
        assert_eq!(top(&all, None, 3).latest.len(), 3);
    }

    #[test]
    fn own_addresses_are_never_contacts_gmail_folded() {
        let per = vec![("a1".to_string(), vec![e("j.doe+news@gmail.com", "Me", 1, 5), e("ME@H.IO", "", 1, 5), e("me+x@h.io", "", 1, 5)])];
        let all = merge(&per, &["jdoe@gmail.com".into(), "me@h.io".into()]);
        // Only Gmail folds a plus tag; me+x@h.io is someone else's inbox.
        assert_eq!(addrs(&all), ["me+x@h.io"]);
    }

    #[test]
    fn the_name_is_the_one_seen_last_and_an_empty_name_never_wins() {
        let per = vec![
            ("a1".to_string(), vec![e("pat@p.io", "Pat Old", 1, 100), e("q@p.io", "Quinn", 1, 100)]),
            ("a2".to_string(), vec![e("pat@p.io", "Patricia New", 1, 200), e("q@p.io", "", 1, 300)]),
        ];
        let all = merge(&per, &[]);
        let by = |a: &str| all.iter().find(|c| c.address == a).unwrap().clone();
        assert_eq!((by("pat@p.io").name.as_str(), by("pat@p.io").count), ("Patricia New", 2));
        assert_eq!((by("q@p.io").name.as_str(), by("q@p.io").last_seen), ("Quinn", 300));
    }

    /// Behaviour change: the JS index capped each account's count at 50
    /// (big and small both showed x50) and ranked small first by recency.
    #[test]
    fn popular_counts_are_not_capped() {
        let per = vec![("a1".to_string(), vec![e("big@x.io", "Big", 120, 1000), e("small@x.io", "Small", 60, 2000)])];
        let t = top(&merge(&per, &[]), None, 50);
        assert_eq!(addrs(&t.popular), ["big@x.io", "small@x.io"]);
        assert_eq!(t.popular[0].count, 120);
    }

    /// Behaviour change: the JS search stopped at the first 18 matches in map
    /// order before sorting, and returned m17..m12 here.
    #[test]
    fn search_ranks_every_match_not_the_first_eighteen() {
        let mut list = vec![e("small@x.io", "Small", 60, 2000)];
        list.extend((1..=25).map(|i| e(&format!("m{i:02}@m.io"), "", 1, 10_000 + i)));
        let all = merge(&[("a1".to_string(), list)], &[]);
        assert_eq!(addrs(&search(&all, "m", None, 6)), ["m25@m.io", "m24@m.io", "m23@m.io", "m22@m.io", "m21@m.io", "m20@m.io"]);
    }

    #[test]
    fn names_hold_every_name_any_account_saw_own_included() {
        let mut per = fixture();
        per.push(("a3".to_string(), vec![e("pat@p.io", "Pat Old", 1, 1), e("pat@p.io", "Patricia New", 1, 2), e("me@h.io", "Rokas Me", 1, 1)]));
        let n = names(&per);
        // contactsIndex.js gave the privacy dictionary these nine for the fixture.
        for want in ["Andrea Work", "Ann Lee", "Anna Smith", "Annabel Old", "Bob Annberg", "Carl Cc", "Doe, John", "Joanna Doe", "Zoë Ångström"] {
            assert!(n.iter().any(|x| x == want), "{want} missing from {n:?}");
        }
        for want in ["Pat Old", "Patricia New", "Rokas Me"] {
            assert!(n.iter().any(|x| x == want), "{want} missing from {n:?}");
        }
        assert_eq!(n.iter().filter(|x| *x == "Ann Lee").count(), 1);
        assert!(!n.iter().any(|x| x.trim().is_empty()));
    }
}
