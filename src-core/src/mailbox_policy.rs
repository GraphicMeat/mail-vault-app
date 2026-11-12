//! Pure decisions behind loading an account's folder list (`mailboxes.load`).
//!
//! Ported one to one from the app's `activateAccount.js` / `mailboxTree.js`
//! (`isMailboxCacheFresh`, `shouldUseFreshMailboxCache`,
//! `isSuspiciousEmptyMailboxResult`, `_mailboxesChanged`, `db.saveMailboxes`,
//! `getCachedMailboxEntry`), so the daemon and the JS copies that remain
//! (prefetch, refresh, the Graph listing) answer alike. No I/O and no clock:
//! the caller passes `now`.
//!
//! Folder nodes stay `serde_json::Value`: the cache holds whatever the listing
//! carried (`_graphFolderId`, `specialUseGuessed`, ...) and a typed struct
//! would drop what it did not name.

use crate::js_value::truthy;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// How long a stored folder list is answered without asking the server.
pub const CACHE_FRESH_MS: i64 = 10 * 60 * 1000;

/// The pause before the one retry of a failed listing (`retryOnce`'s default).
pub const RETRY_DELAY_MS: u64 = 1500;

/// A stored folder list, as the app reads it (`getCachedMailboxEntry`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CacheEntry {
    pub mailboxes: Option<Vec<Value>>,
    pub fetched_at: Option<i64>,
    pub last_known_good: Option<Vec<Value>>,
    pub last_known_good_at: Option<i64>,
}

fn list_of(value: Option<&Value>) -> Option<Vec<Value>> {
    value.and_then(Value::as_array).cloned()
}

fn millis(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_number()?;
    number.as_i64().or_else(|| number.as_f64().map(|f| f as i64))
}

/// The stored text read the way `getCachedMailboxEntry` reads it. `None` when
/// there is nothing usable (empty text, text that is not JSON, `null`): the
/// caller treats that as no cache. A bare array is a pre-timestamp cache.
pub fn parse_cache_entry(raw: &str) -> Option<CacheEntry> {
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(raw).ok()? {
        Value::Null => None,
        Value::Array(list) => Some(CacheEntry { mailboxes: Some(list), ..CacheEntry::default() }),
        Value::Object(entry) => {
            // `entry.fetchedAt ?? entry.lastSynced ?? null`
            let stamp = entry.get("fetchedAt").filter(|v| !v.is_null()).or_else(|| entry.get("lastSynced"));
            Some(CacheEntry {
                mailboxes: list_of(entry.get("mailboxes")),
                fetched_at: millis(stamp),
                last_known_good: list_of(entry.get("lastKnownGoodMailboxes")),
                last_known_good_at: millis(entry.get("lastKnownGoodAt")).filter(|at| *at != 0),
            })
        }
        // A number, string or bool has no such fields: an entry of nothing.
        _ => Some(CacheEntry::default()),
    }
}

fn children_of(node: &Value) -> &[Value] {
    node.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Every folder in the list, nested ones included.
pub fn count_mailboxes(mailboxes: &[Value]) -> usize {
    mailboxes.iter().map(|node| 1 + count_mailboxes(children_of(node))).sum()
}

/// A list worth trusting: non-empty, flat (the old nested format forces a
/// refresh), and more than a lone INBOX, which is what the placeholder is.
pub fn is_tree_complete(mailboxes: &[Value]) -> bool {
    let total = count_mailboxes(mailboxes);
    if total == 0 {
        return false;
    }
    if mailboxes.iter().any(|node| !children_of(node).is_empty()) {
        return false;
    }
    if total > 1 {
        return true;
    }
    mailboxes[0].get("path").and_then(Value::as_str) != Some("INBOX")
}

/// `isMailboxCacheFresh`: stamped, and younger than [`CACHE_FRESH_MS`].
pub fn cache_is_fresh(fetched_at: Option<i64>, now: i64) -> bool {
    fetched_at.is_some_and(|at| at != 0 && now - at < CACHE_FRESH_MS)
}

/// A Graph list cached before folders carried a count: however young, it
/// cannot say how long the folder is, and the list would read as one page.
fn lacks_graph_total(mailboxes: &[Value]) -> bool {
    mailboxes.iter().any(|node| truthy(node.get("_graphFolderId")) && node.get("_graphTotal").map_or(true, Value::is_null))
}

/// `shouldUseFreshMailboxCache`: the stored list answers without the server.
pub fn should_use_fresh_cache(entry: Option<&CacheEntry>, now: i64) -> bool {
    let Some(entry) = entry else { return false };
    let Some(mailboxes) = entry.mailboxes.as_deref() else { return false };
    cache_is_fresh(entry.fetched_at, now) && is_tree_complete(mailboxes) && !lacks_graph_total(mailboxes)
}

/// `isSuspiciousEmptyMailboxResult`: the server answered with no folders at all
/// where the app held a real list. A listing that did not arrive (`None`) is a
/// failure, not an empty answer.
pub fn is_suspicious_empty(fresh: Option<&[Value]>, cached: Option<&CacheEntry>) -> bool {
    let Some(fresh) = fresh else { return false };
    if !fresh.is_empty() {
        return false;
    }
    let Some(cached) = cached else { return false };
    let prior = cached.last_known_good.as_deref().or(cached.mailboxes.as_deref());
    prior.is_some_and(is_tree_complete)
}

fn path_key(node: &Value) -> String {
    node.get("path").map_or_else(|| "\u{0}undefined".to_owned(), Value::to_string)
}

/// JavaScript's template-literal rendering of a count (`${n._graphTotal ?? ''}`).
fn render_total(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9e15 => format!("{}", f as i64),
            _ => number.to_string(),
        },
        Some(other) => other.to_string(),
    }
}

fn shapes(nodes: &[Value], into: &mut HashMap<String, String>) {
    for node in nodes {
        // A Graph folder's own count counts too: the store's copy is what page
        // one is counted with, and a listing it ignored stayed on disk only.
        let shape = format!("{}|{}", children_of(node).len(), render_total(node.get("_graphTotal")));
        into.insert(path_key(node), shape);
        shapes(children_of(node), into);
    }
}

/// `_mailboxesChanged`: whether `fresh` differs from `current` in a way the
/// sidebar shows (a folder added or removed, a child count or Graph total
/// moved). A side that is missing counts as changed.
pub fn mailboxes_changed(current: Option<&[Value]>, fresh: Option<&[Value]>) -> bool {
    let (Some(current), Some(fresh)) = (current, fresh) else { return true };
    if current.len() != fresh.len() {
        return true;
    }
    let (mut before, mut after) = (HashMap::new(), HashMap::new());
    shapes(current, &mut before);
    shapes(fresh, &mut after);
    before.len() != after.len() || before.iter().any(|(path, shape)| after.get(path) != Some(shape))
}

/// The document `db.saveMailboxes` writes: the list and when it arrived, plus
/// the last-known-good copy. A non-empty list becomes the new last-known-good;
/// an empty one keeps the one already on file.
pub fn cache_entry_json(fresh: &[Value], existing: Option<&CacheEntry>, now: i64) -> Value {
    let mut entry = Map::new();
    entry.insert("mailboxes".into(), Value::Array(fresh.to_vec()));
    entry.insert("fetchedAt".into(), now.into());
    if !fresh.is_empty() {
        entry.insert("lastKnownGoodMailboxes".into(), Value::Array(fresh.to_vec()));
        entry.insert("lastKnownGoodAt".into(), now.into());
    } else if let Some(good) = existing.and_then(|e| e.last_known_good.as_ref()) {
        entry.insert("lastKnownGoodMailboxes".into(), Value::Array(good.clone()));
        entry.insert("lastKnownGoodAt".into(), existing.and_then(|e| e.last_known_good_at).map_or(Value::Null, Value::from));
    }
    Value::Object(entry)
}

/// What a server listing amounts to once weighed against the stored one.
#[derive(Debug, Clone, PartialEq)]
pub enum Settled {
    /// An empty answer where a real list was held: nothing is stored, and the
    /// stored list stays what the app shows.
    Suspect { mailboxes: Vec<Value>, fetched_at: Option<i64> },
    /// The listing to keep: the document to store, and whether it differs from
    /// the stored list.
    Accepted { entry: Value, changed: bool },
}

pub fn settle(cached: Option<&CacheEntry>, fresh: &[Value], now: i64) -> Settled {
    if is_suspicious_empty(Some(fresh), cached) {
        return Settled::Suspect {
            mailboxes: cached.and_then(|c| c.mailboxes.clone()).unwrap_or_default(),
            fetched_at: cached.and_then(|c| c.fetched_at),
        };
    }
    Settled::Accepted {
        entry: cache_entry_json(fresh, cached, now),
        changed: mailboxes_changed(cached.and_then(|c| c.mailboxes.as_deref()), Some(fresh)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;

    fn mailbox(name: &str, children: Vec<Value>) -> Value {
        json!({"name": name, "path": name, "specialUse": null, "flags": [], "delimiter": "/", "noselect": false, "children": children})
    }

    fn flat(names: &[&str]) -> Vec<Value> {
        names.iter().map(|n| mailbox(n, vec![])).collect()
    }

    fn entry(mailboxes: Option<Vec<Value>>, fetched_at: Option<i64>) -> CacheEntry {
        let last_known_good = mailboxes.clone().filter(|m| !m.is_empty());
        CacheEntry { mailboxes, fetched_at, last_known_good, last_known_good_at: fetched_at }
    }

    // tests/unit/emptyCacheCorruption.test.js and mailboxTree.test.js, isMailboxTreeComplete / countMailboxes.
    #[test]
    fn tree_completeness_table() {
        let cases: Vec<(&str, Vec<Value>, bool)> = vec![
            ("empty list", vec![], false),
            ("lone INBOX is the placeholder", flat(&["INBOX"]), false),
            ("INBOX and Sent", flat(&["INBOX", "Sent"]), true),
            ("a single folder that is not INBOX", flat(&["Sent"]), true),
            ("nested tree is the old format", vec![mailbox("INBOX", flat(&["Subfolder"]))], false),
            ("nested below a second root", vec![mailbox("INBOX", vec![]), mailbox("A", flat(&["B"]))], false),
            ("node without a path is not INBOX", vec![json!({"name": "x"})], true),
        ];
        for (name, list, want) in cases {
            assert_eq!(is_tree_complete(&list), want, "{name}");
        }
    }

    #[test]
    fn counting_walks_children_and_treats_nothing_as_zero() {
        assert_eq!(count_mailboxes(&[]), 0);
        assert_eq!(count_mailboxes(&flat(&["a", "b"])), 2);
        let tree = vec![mailbox("INBOX", vec![mailbox("A", flat(&["B"]))]), mailbox("Sent", vec![])];
        assert_eq!(count_mailboxes(&tree), 4);
        assert_eq!(count_mailboxes(&[json!({"name": "no children key"})]), 1);
    }

    #[test]
    fn freshness_is_stamped_and_younger_than_ten_minutes() {
        assert!(!cache_is_fresh(None, NOW));
        assert!(!cache_is_fresh(Some(0), NOW), "0 is falsy in the JS");
        assert!(cache_is_fresh(Some(NOW), NOW));
        assert!(cache_is_fresh(Some(NOW - CACHE_FRESH_MS + 1), NOW));
        assert!(!cache_is_fresh(Some(NOW - CACHE_FRESH_MS), NOW), "exactly the TTL is stale");
        assert!(cache_is_fresh(Some(NOW + 5_000), NOW), "a stamp from the future reads as fresh, like the JS");
    }

    #[test]
    fn fresh_cache_decision_table() {
        let two = flat(&["INBOX", "Archive"]);
        let graph_old = vec![json!({"path": "INBOX", "_graphFolderId": "g1"}), json!({"path": "Sent", "_graphFolderId": "g2", "_graphTotal": 4})];
        let graph_new = vec![json!({"path": "INBOX", "_graphFolderId": "g1", "_graphTotal": 0}), json!({"path": "Sent", "_graphFolderId": "g2", "_graphTotal": 4})];
        let graph_null_total = vec![json!({"path": "INBOX", "_graphFolderId": "g1", "_graphTotal": null}), json!({"path": "Sent"})];
        let empty_graph_id = vec![json!({"path": "INBOX", "_graphFolderId": ""}), json!({"path": "Sent"})];
        let cases: Vec<(&str, Option<CacheEntry>, bool)> = vec![
            ("no entry", None, false),
            ("young and complete", Some(entry(Some(two.clone()), Some(NOW - 1_000))), true),
            ("stamped this very millisecond", Some(entry(Some(two.clone()), Some(NOW))), true),
            ("stale", Some(entry(Some(two.clone()), Some(NOW - CACHE_FRESH_MS - 1))), false),
            ("never stamped", Some(entry(Some(two.clone()), None)), false),
            ("lone INBOX placeholder", Some(entry(Some(flat(&["INBOX"])), Some(NOW))), false),
            ("nested pre-flattening cache", Some(entry(Some(vec![mailbox("INBOX", flat(&["x"]))]), Some(NOW))), false),
            ("no list", Some(entry(None, Some(NOW))), false),
            ("Graph folder without a count", Some(entry(Some(graph_old), Some(NOW))), false),
            ("Graph folder with null count", Some(entry(Some(graph_null_total), Some(NOW))), false),
            ("Graph folders all counted, zero included", Some(entry(Some(graph_new), Some(NOW))), true),
            ("a falsy Graph id is not a Graph folder", Some(entry(Some(empty_graph_id), Some(NOW))), true),
        ];
        for (name, entry, want) in cases {
            assert_eq!(should_use_fresh_cache(entry.as_ref(), NOW), want, "{name}");
        }
    }

    // tests/unit/emptyCacheCorruption.test.js, isSuspiciousEmptyMailboxResult.
    #[test]
    fn suspicious_empty_table() {
        let full = entry(Some(flat(&["INBOX", "Sent", "Trash"])), Some(NOW));
        let stub_only = entry(Some(flat(&["INBOX"])), Some(NOW));
        let corrupted_with_good_copy = CacheEntry {
            mailboxes: Some(vec![]),
            fetched_at: Some(NOW),
            last_known_good: Some(flat(&["INBOX", "Sent"])),
            last_known_good_at: Some(NOW - 60_000),
        };
        let empty_good_copy_hides_current = CacheEntry {
            mailboxes: Some(flat(&["INBOX", "Sent"])),
            last_known_good: Some(vec![]),
            ..CacheEntry::default()
        };
        let nothing = CacheEntry::default();
        let none: Vec<Value> = vec![];
        let two = flat(&["INBOX", "Sent"]);
        let cases: Vec<(&str, Option<&[Value]>, Option<&CacheEntry>, bool)> = vec![
            ("non-empty answer", Some(two.as_slice()), Some(&full), false),
            ("fewer folders than the cache is not suspicious", Some(&two[..1]), Some(&full), false),
            ("empty over a complete cache", Some(none.as_slice()), Some(&full), true),
            ("empty for a brand-new account", Some(none.as_slice()), None, false),
            ("empty over a stub INBOX", Some(none.as_slice()), Some(&stub_only), false),
            ("empty over a corrupted cache with a good copy", Some(none.as_slice()), Some(&corrupted_with_good_copy), true),
            ("an empty good copy wins over the list, as `||` does for []", Some(none.as_slice()), Some(&empty_good_copy_hides_current), false),
            ("no answer at all is a failure, not an empty list", None, Some(&full), false),
            ("an entry that holds nothing", Some(none.as_slice()), Some(&nothing), false),
        ];
        for (name, fresh, cached, want) in cases {
            assert_eq!(is_suspicious_empty(fresh, cached), want, "{name}");
        }
    }

    #[test]
    fn change_detection_table() {
        let base = flat(&["INBOX", "Sent"]);
        let graph = |total: Value| vec![json!({"path": "INBOX", "children": [], "_graphTotal": total}), json!({"path": "Sent", "children": []})];
        let (g3, g4, g_null, g0) = (graph(json!(3)), graph(json!(4)), graph(Value::Null), graph(json!(0)));
        let g_absent = vec![json!({"path": "INBOX", "children": []}), json!({"path": "Sent", "children": []})];
        let renamed = flat(&["INBOX", "Archive"]);
        let swapped = vec![base[1].clone(), base[0].clone()];
        let nested = vec![mailbox("INBOX", flat(&["a"])), mailbox("Sent", vec![])];
        let nested_more = vec![mailbox("INBOX", flat(&["a", "b"])), mailbox("Sent", vec![])];
        let empty: Vec<Value> = vec![];
        let cases: Vec<(&str, Option<&[Value]>, Option<&[Value]>, bool)> = vec![
            ("same list", Some(base.as_slice()), Some(base.as_slice()), false),
            ("current missing", None, Some(base.as_slice()), true),
            ("fresh missing", Some(base.as_slice()), None, true),
            ("length differs", Some(base.as_slice()), Some(&base[..1]), true),
            ("a folder renamed", Some(base.as_slice()), Some(renamed.as_slice()), true),
            ("child count moved", Some(nested.as_slice()), Some(nested_more.as_slice()), true),
            ("same nested list", Some(nested.as_slice()), Some(nested.as_slice()), false),
            ("Graph total moved", Some(g3.as_slice()), Some(g4.as_slice()), true),
            ("Graph total same", Some(g3.as_slice()), Some(g3.as_slice()), false),
            ("Graph total appeared", Some(g_null.as_slice()), Some(g0.as_slice()), true),
            ("Graph total null equals absent", Some(g_null.as_slice()), Some(g_absent.as_slice()), false),
            ("order alone is not a change", Some(base.as_slice()), Some(swapped.as_slice()), false),
            ("both empty", Some(empty.as_slice()), Some(empty.as_slice()), false),
        ];
        for (name, current, fresh, want) in cases {
            assert_eq!(mailboxes_changed(current, fresh), want, "{name}");
        }
    }

    #[test]
    fn a_stored_entry_reads_like_get_cached_mailbox_entry() {
        let two = flat(&["INBOX", "Sent"]);
        let full = json!({"mailboxes": two, "fetchedAt": 5, "lastKnownGoodMailboxes": two, "lastKnownGoodAt": 4}).to_string();
        let parsed = parse_cache_entry(&full).unwrap();
        assert_eq!(parsed.mailboxes.as_deref(), Some(two.as_slice()));
        assert_eq!((parsed.fetched_at, parsed.last_known_good_at), (Some(5), Some(4)));
        assert_eq!(parsed.last_known_good.as_deref(), Some(two.as_slice()));

        // The pre-timestamp format: a bare array.
        let bare = parse_cache_entry(&json!(two).to_string()).unwrap();
        assert_eq!(bare, CacheEntry { mailboxes: Some(two.clone()), ..CacheEntry::default() });

        // `lastSynced` stands in for a missing or null `fetchedAt`.
        assert_eq!(parse_cache_entry(r#"{"mailboxes":[],"lastSynced":9}"#).unwrap().fetched_at, Some(9));
        assert_eq!(parse_cache_entry(r#"{"fetchedAt":null,"lastSynced":9}"#).unwrap().fetched_at, Some(9));
        assert_eq!(parse_cache_entry(r#"{"fetchedAt":7,"lastSynced":9}"#).unwrap().fetched_at, Some(7));
        // A stamp stored as a float still reads.
        assert_eq!(parse_cache_entry(r#"{"fetchedAt":1.8e12}"#).unwrap().fetched_at, Some(1_800_000_000_000));
        // `lastKnownGoodAt: 0` is `|| null`.
        assert_eq!(parse_cache_entry(r#"{"lastKnownGoodAt":0}"#).unwrap().last_known_good_at, None);
        // An empty list is kept (`[] || null` is `[]`).
        assert_eq!(parse_cache_entry(r#"{"mailboxes":[]}"#).unwrap().mailboxes, Some(vec![]));

        for unusable in ["", "not json", "null", "{"] {
            assert_eq!(parse_cache_entry(unusable), None, "{unusable:?}");
        }
        assert_eq!(parse_cache_entry("5"), Some(CacheEntry::default()));
    }

    #[test]
    fn the_stored_document_matches_save_mailboxes() {
        let two = flat(&["INBOX", "Sent"]);
        let existing = CacheEntry {
            mailboxes: Some(two.clone()),
            fetched_at: Some(1),
            last_known_good: Some(two.clone()),
            last_known_good_at: Some(2),
        };
        // A non-empty list becomes the last-known-good as well.
        let next = flat(&["INBOX", "Sent", "Trash"]);
        assert_eq!(
            cache_entry_json(&next, Some(&existing), NOW),
            json!({"mailboxes": next, "fetchedAt": NOW, "lastKnownGoodMailboxes": next, "lastKnownGoodAt": NOW})
        );
        // An empty list keeps the one on file, with its own stamp.
        assert_eq!(
            cache_entry_json(&[], Some(&existing), NOW),
            json!({"mailboxes": [], "fetchedAt": NOW, "lastKnownGoodMailboxes": two, "lastKnownGoodAt": 2})
        );
        // A good copy with no stamp keeps a null one (`entry.lastKnownGoodAt || null`).
        let unstamped = CacheEntry { last_known_good: Some(two.clone()), ..CacheEntry::default() };
        assert_eq!(
            cache_entry_json(&[], Some(&unstamped), NOW),
            json!({"mailboxes": [], "fetchedAt": NOW, "lastKnownGoodMailboxes": two, "lastKnownGoodAt": null})
        );
        // Nothing on file to keep.
        assert_eq!(cache_entry_json(&[], None, NOW), json!({"mailboxes": [], "fetchedAt": NOW}));
        assert_eq!(cache_entry_json(&[], Some(&CacheEntry::default()), NOW), json!({"mailboxes": [], "fetchedAt": NOW}));
    }

    #[test]
    fn settling_a_listing_rejects_a_suspect_empty_and_keeps_anything_else() {
        let full = entry(Some(flat(&["INBOX", "Sent", "Trash"])), Some(NOW - 1));
        assert_eq!(
            settle(Some(&full), &[], NOW),
            Settled::Suspect { mailboxes: flat(&["INBOX", "Sent", "Trash"]), fetched_at: Some(NOW - 1) }
        );

        // A brand-new account may really have no folders: kept, and stored as [].
        match settle(None, &[], NOW) {
            Settled::Accepted { entry, changed } => {
                assert_eq!(entry, json!({"mailboxes": [], "fetchedAt": NOW}));
                assert!(changed, "no stored list counts as changed");
            }
            other => panic!("{other:?}"),
        }

        // The same list again: stored fresh, not changed.
        let same = flat(&["INBOX", "Sent", "Trash"]);
        match settle(Some(&full), &same, NOW) {
            Settled::Accepted { entry, changed } => {
                assert_eq!(entry["fetchedAt"], json!(NOW));
                assert!(!changed);
            }
            other => panic!("{other:?}"),
        }

        // A folder fewer: kept, changed.
        match settle(Some(&full), &same[..2], NOW) {
            Settled::Accepted { changed, .. } => assert!(changed),
            other => panic!("{other:?}"),
        }
    }
}
