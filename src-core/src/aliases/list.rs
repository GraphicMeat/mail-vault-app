//! The rules for one account's stored alias list (was the app's
//! `src/utils/aliasDiscovery.js`). Plain data in, plain data out: the daemon
//! (`handlers::alias_store`) reads the list from the settings document, runs
//! one of these and writes the result back.
//!
//! An alias is a JSON object `{address, name, source, ...}`, `source` being
//! where it came from: `provider` (the provider's send-as list), `detected`
//! (the account has sent as it) or `manual` (the user typed it). Entries are
//! kept as JSON values, never round-tripped through a struct: the app stores
//! more on them (an alias's own `signature`), and every field it stores
//! survives every rule here. The list never holds the login itself, and never
//! two spellings of one address (case-insensitive).
//!
//! `dismissed` is the account's list of lowercased addresses the user removed
//! or turned down: discovery never adds or suggests them again.

use serde::Serialize;
use serde_json::{json, Value};

/// The comparison key of an address: trimmed and lowercased.
pub fn key(address: &str) -> String {
    address.trim().to_lowercase()
}

fn key_of(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(key).unwrap_or_default()
}

fn clean(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|s| s.trim().to_string()).unwrap_or_default()
}

fn address_of(entry: &Value) -> String {
    key_of(entry.get("address"))
}

/// The characters an address part may not hold (the app's regex class).
fn banned(c: char) -> bool {
    c.is_whitespace() || matches!(c, '@' | '<' | '>' | '(' | ')' | '[' | ']' | ',' | ';' | ':' | '"')
}

/// One plain address: no display name, no brackets, no spaces, one `@`, and a
/// dot in the domain with something on both sides of it. The server decides
/// whether it will send as it.
pub fn is_valid_address(address: &str) -> bool {
    let address = address.trim();
    let Some((local, domain)) = address.split_once('@') else { return false };
    if local.is_empty() || local.chars().any(banned) || domain.chars().any(banned) {
        return false;
    }
    let chars: Vec<char> = domain.chars().collect();
    chars.len() >= 3 && chars[1..chars.len() - 1].contains(&'.')
}

/// Why an address cannot be added: the app shows a catalog line per reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Refusal {
    /// Not one plain address.
    Invalid,
    /// The account's own login.
    Login,
    /// Already on the list, in any case.
    Duplicate,
}

/// An account's list after `add`.
#[derive(Debug, Clone, PartialEq)]
pub struct Added {
    pub alias: Value,
    pub aliases: Vec<Value>,
    pub dismissed: Vec<String>,
}

/// The source an added alias may carry; anything else is `manual`.
fn add_source(source: &str) -> &'static str {
    match source {
        "provider" => "provider",
        "detected" => "detected",
        _ => "manual",
    }
}

/// Add one alias, trimmed, with its name and source. Adding an address by hand
/// takes it off the dismissed list.
pub fn add(aliases: &[Value], dismissed: &[String], login: &str, address: &str, name: &str, source: &str) -> Result<Added, Refusal> {
    let address = address.trim();
    if !is_valid_address(address) {
        return Err(Refusal::Invalid);
    }
    let k = key(address);
    if k == key(login) {
        return Err(Refusal::Login);
    }
    if aliases.iter().any(|a| address_of(a) == k) {
        return Err(Refusal::Duplicate);
    }
    let alias = json!({"address": address, "name": name.trim(), "source": add_source(source)});
    let mut next = aliases.to_vec();
    next.push(alias.clone());
    let dismissed = dismissed.iter().filter(|d| key(d) != k).cloned().collect();
    Ok(Added { alias, aliases: next, dismissed })
}

/// An account's list after `remove`.
#[derive(Debug, Clone, PartialEq)]
pub struct Removed {
    pub aliases: Vec<Value>,
    pub dismissed: Vec<String>,
}

/// Remove one alias for good: it goes on the dismissed list, so discovery
/// never brings it back. Whatever the entry held (its signature) goes with it.
pub fn remove(aliases: &[Value], dismissed: &[String], address: &str) -> Removed {
    let k = key(address);
    Removed { aliases: aliases.iter().filter(|a| address_of(a) != k).cloned().collect(), dismissed: dismiss(dismissed, address) }
}

/// Turn one address down without it being on the list (a suggestion the user
/// does not want): discovery never offers or adds it again.
pub fn dismiss(dismissed: &[String], address: &str) -> Vec<String> {
    let k = key(address);
    let mut next = dismissed.to_vec();
    if !k.is_empty() && !next.iter().any(|d| key(d) == k) {
        next.push(k);
    }
    next
}

/// The list as the app shows it: entries with an address, the login left out
/// (a default From saved before aliases existed can have become one).
pub fn visible(aliases: &[Value], login: &str) -> Vec<Value> {
    let login = key(login);
    aliases
        .iter()
        .filter(|a| {
            let k = address_of(a);
            a.is_object() && !k.is_empty() && k != login
        })
        .cloned()
        .collect()
}

/// What one `aliases.discover` answer does to an account's list.
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    pub aliases: Vec<Value>,
    pub added: Vec<Value>,
    /// Delivery addresses to offer, never stored.
    pub suggestions: Vec<Value>,
    pub provider_status: String,
    /// The account's name from the provider's primary entry, only when the
    /// account has none yet.
    pub display_name: Option<String>,
    /// Whether `aliases` differs from the list it was merged into.
    pub changed: bool,
}

/// Merge one `aliases.discover` answer (`{provider, detected}`) into an
/// account's aliases.
///
/// - Provider aliases (status `ok`): every non-primary one not marked
///   unverified is added as `provider`, with the provider's name.
/// - The provider's primary entry names the account (`display_name`) only
///   when the account has no name yet.
/// - Detected `sent_from` addresses are proven senders: added as `detected`.
/// - Detected `delivered_to` addresses are only suggestions: returned, never
///   stored.
/// - A dismissed, existing or login address is never added or suggested. An
///   existing alias keeps the name it has; one with no name takes the name
///   discovery found. Aliases the provider stopped listing are kept.
pub fn merge_discovery(aliases: &[Value], dismissed: &[String], login: &str, display_name: &str, result: &Value) -> Merged {
    if !result.is_object() {
        return Merged {
            aliases: aliases.to_vec(),
            added: Vec::new(),
            suggestions: Vec::new(),
            provider_status: "error".into(),
            display_name: None,
            changed: false,
        };
    }
    let login = key(login);
    let gone: Vec<String> = dismissed.iter().map(|d| key(d)).collect();
    // Nothing may hold the login; a default From saved before aliases existed
    // can have become one on upgrade.
    let mut next = visible(aliases, &login);
    let provider_status = result
        .get("provider")
        .and_then(|p| p.get("status"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("error")
        .to_string();
    let mut added = Vec::new();
    let mut seeded: Option<String> = None;

    let mut take = |next: &mut Vec<Value>, address: Option<&Value>, name: Option<&Value>, source: &str| {
        let Some(address) = address.and_then(Value::as_str) else { return };
        let k = key(address);
        if !is_valid_address(address) || k == login || gone.contains(&k) {
            return;
        }
        let name = clean(name);
        if let Some(existing) = next.iter_mut().find(|a| address_of(a) == k) {
            if clean(existing.get("name")).is_empty() && !name.is_empty() {
                existing["name"] = Value::String(name);
            }
            return;
        }
        let entry = json!({"address": address.trim(), "name": name, "source": source});
        next.push(entry.clone());
        added.push(entry);
    };

    if provider_status == "ok" {
        let listed = result.get("provider").and_then(|p| p.get("aliases")).and_then(Value::as_array);
        for alias in listed.into_iter().flatten() {
            if alias.get("isPrimary").and_then(Value::as_bool).unwrap_or(false) {
                let name = clean(alias.get("name"));
                if display_name.trim().is_empty() && !name.is_empty() && seeded.is_none() {
                    seeded = Some(name);
                }
                continue;
            }
            if alias.get("verified").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            take(&mut next, alias.get("address"), alias.get("name"), "provider");
        }
    }

    let detected: &[Value] = result.get("detected").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    for entry in detected {
        if entry.get("source").and_then(Value::as_str) == Some("sent_from") {
            take(&mut next, entry.get("address"), entry.get("name"), "detected");
        }
    }

    let mut suggestions = Vec::new();
    let mut suggested: Vec<String> = Vec::new();
    for entry in detected {
        if entry.get("source").and_then(Value::as_str) != Some("delivered_to") {
            continue;
        }
        let Some(address) = entry.get("address").and_then(Value::as_str) else { continue };
        let k = key(address);
        if !is_valid_address(address)
            || k == login
            || gone.contains(&k)
            || suggested.contains(&k)
            || next.iter().any(|a| address_of(a) == k)
        {
            continue;
        }
        suggested.push(k);
        suggestions.push(entry.clone());
    }

    let changed = next.as_slice() != aliases;
    Merged { aliases: next, added, suggestions, provider_status, display_name: seeded, changed }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOGIN: &str = "me@example.test";

    fn provider(aliases: Value, status: &str) -> Value {
        json!({"status": status, "aliases": aliases})
    }

    fn with(mut base: Value, extra: Value) -> Value {
        for (k, x) in extra.as_object().cloned().unwrap_or_default() {
            base[k] = x;
        }
        base
    }

    fn pa(address: &str, extra: Value) -> Value {
        with(json!({"address": address, "name": "", "isPrimary": false, "verified": true}), extra)
    }

    fn detected(address: &str, source: &str, extra: Value) -> Value {
        with(json!({"address": address, "name": "", "count": 1, "source": source}), extra)
    }

    fn alias(address: &str, name: &str, source: &str) -> Value {
        json!({"address": address, "name": name, "source": source})
    }

    fn merge(aliases: &[Value], dismissed: &[&str], display_name: &str, result: Value) -> Merged {
        let dismissed: Vec<String> = dismissed.iter().map(|s| s.to_string()).collect();
        merge_discovery(aliases, &dismissed, LOGIN, display_name, &result)
    }

    fn empty_result() -> Value {
        json!({"provider": provider(json!([]), "ok"), "detected": []})
    }

    // ── is_valid_address ───────────────────────────────────────────────

    #[test]
    fn a_plain_address_is_valid_and_nothing_else_is() {
        assert!(is_valid_address("desk@example.test"));
        assert!(is_valid_address(" desk@example.test "));
        assert!(is_valid_address("first.last+tag@sub.example.test"));
        for bad in ["", "desk", "desk@", "@example.test", "a b@example.test", "Desk <desk@example.test>", "a@b", "a@b.", "a@.b", "a@@b.test", "a@b.test;"] {
            assert!(!is_valid_address(bad), "{bad:?}");
        }
    }

    // ── add ────────────────────────────────────────────────────────────

    #[test]
    fn add_keeps_a_trimmed_address_with_its_name_and_source() {
        let out = add(&[], &[], LOGIN, " desk@example.test ", " Desk ", "manual").unwrap();
        assert_eq!(out.alias, alias("desk@example.test", "Desk", "manual"));
        assert_eq!(out.aliases, vec![alias("desk@example.test", "Desk", "manual")]);
    }

    #[test]
    fn add_takes_only_a_known_source() {
        assert_eq!(add(&[], &[], LOGIN, "a@example.test", "", "detected").unwrap().alias["source"], "detected");
        assert_eq!(add(&[], &[], LOGIN, "a@example.test", "", "anything").unwrap().alias["source"], "manual");
        assert_eq!(add(&[], &[], LOGIN, "a@example.test", "", "").unwrap().alias["source"], "manual");
    }

    #[test]
    fn add_refuses_a_malformed_address_the_login_and_a_duplicate_whatever_the_case() {
        let list = [alias("desk@example.test", "", "provider")];
        assert_eq!(add(&list, &[], LOGIN, "nope", "", "manual"), Err(Refusal::Invalid));
        assert_eq!(add(&list, &[], LOGIN, "ME@example.test", "", "manual"), Err(Refusal::Login));
        assert_eq!(add(&list, &[], LOGIN, "Desk@Example.test", "", "manual"), Err(Refusal::Duplicate));
    }

    #[test]
    fn adding_an_address_by_hand_takes_it_off_the_dismissed_list() {
        let dismissed = ["desk@example.test".to_string(), "other@example.test".to_string()];
        let out = add(&[], &dismissed, LOGIN, "Desk@example.test", "", "manual").unwrap();
        assert_eq!(out.dismissed, vec!["other@example.test".to_string()]);
    }

    #[test]
    fn refusals_read_as_the_app_s_reason_words() {
        assert_eq!(serde_json::to_value(Refusal::Invalid).unwrap(), "invalid");
        assert_eq!(serde_json::to_value(Refusal::Login).unwrap(), "login");
        assert_eq!(serde_json::to_value(Refusal::Duplicate).unwrap(), "duplicate");
    }

    // ── remove, dismiss, visible ───────────────────────────────────────

    #[test]
    fn remove_drops_the_alias_and_its_signature_and_remembers_it() {
        let list = [
            json!({"address": "Desk@example.test", "name": "", "source": "manual", "signature": {"html": "<p>D</p>", "text": "D"}}),
            alias("sales@example.test", "", "manual"),
        ];
        let out = remove(&list, &[], "desk@EXAMPLE.test");
        assert_eq!(out.aliases, vec![alias("sales@example.test", "", "manual")]);
        assert_eq!(out.dismissed, vec!["desk@example.test".to_string()]);
        // A second removal adds no second entry.
        assert_eq!(remove(&out.aliases, &out.dismissed, "DESK@example.test").dismissed, out.dismissed);
    }

    #[test]
    fn a_removed_alias_added_again_comes_back_without_its_old_signature() {
        let list = [json!({"address": "desk@example.test", "name": "", "source": "manual", "signature": {"html": "<p>D</p>", "text": "D"}})];
        let gone = remove(&list, &[], "desk@example.test");
        let back = add(&gone.aliases, &gone.dismissed, LOGIN, "desk@example.test", "", "manual").unwrap();
        assert_eq!(back.aliases, vec![alias("desk@example.test", "", "manual")]);
        assert!(back.dismissed.is_empty());
    }

    #[test]
    fn dismiss_adds_one_lowercased_entry_and_ignores_an_empty_address() {
        assert_eq!(dismiss(&[], " Shop@Example.test "), vec!["shop@example.test".to_string()]);
        assert_eq!(dismiss(&["shop@example.test".into()], "SHOP@example.test"), vec!["shop@example.test".to_string()]);
        assert_eq!(dismiss(&[], "  "), Vec::<String>::new());
    }

    #[test]
    fn visible_leaves_the_login_and_entries_without_an_address_out() {
        let list = [alias("ME@example.test", "", "manual"), alias("desk@example.test", "", "manual"), json!({"name": "x"}), json!(null)];
        assert_eq!(visible(&list, LOGIN), vec![alias("desk@example.test", "", "manual")]);
    }

    // ── merge_discovery ────────────────────────────────────────────────

    #[test]
    fn every_verified_provider_alias_is_added_with_the_provider_s_name() {
        let result = json!({"provider": provider(json!([pa(LOGIN, json!({"isPrimary": true})), pa("desk@example.test", json!({"name": "Front Desk"}))]), "ok"), "detected": []});
        let out = merge(&[], &[], "", result);
        assert_eq!(out.added, vec![alias("desk@example.test", "Front Desk", "provider")]);
        assert_eq!(out.aliases, out.added);
        assert_eq!(out.provider_status, "ok");
        assert!(out.changed);
    }

    #[test]
    fn the_primary_unverified_dismissed_existing_and_login_entries_are_skipped() {
        let out = merge(
            &[alias("kept@example.test", "Mine", "manual")],
            &["gone@example.test"],
            "",
            json!({"provider": provider(json!([
                pa("pending@example.test", json!({"verified": false})),
                pa("GONE@example.test", json!({})),
                pa("Kept@example.test", json!({"name": "Provider name"})),
                pa("ME@example.test", json!({})),
                pa("not an address", json!({})),
            ]), "ok"), "detected": []}),
        );
        assert!(out.added.is_empty());
        // The user's own name for an alias is never replaced.
        assert_eq!(out.aliases, vec![alias("kept@example.test", "Mine", "manual")]);
        assert!(!out.changed);
    }

    #[test]
    fn a_name_is_filled_in_only_where_the_alias_has_none() {
        let result = json!({"provider": provider(json!([pa("desk@example.test", json!({"name": "Front Desk"}))]), "ok"), "detected": []});
        let out = merge(&[alias("desk@example.test", "", "detected")], &[], "", result);
        assert_eq!(out.aliases, vec![alias("desk@example.test", "Front Desk", "detected")]);
        assert!(out.added.is_empty());
        assert!(out.changed);
    }

    #[test]
    fn an_alias_the_provider_no_longer_lists_is_kept() {
        let list = [alias("old@example.test", "", "provider")];
        let out = merge(&list, &[], "", empty_result());
        assert_eq!(out.aliases, list.to_vec());
        assert!(!out.changed);
    }

    #[test]
    fn the_account_name_comes_from_the_primary_entry_only_when_none_is_set() {
        let result = json!({"provider": provider(json!([pa(LOGIN, json!({"isPrimary": true, "name": "Me Myself"}))]), "ok"), "detected": []});
        assert_eq!(merge(&[], &[], "", result.clone()).display_name.as_deref(), Some("Me Myself"));
        assert_eq!(merge(&[], &[], "Chosen", result).display_name, None);
        assert_eq!(merge(&[], &[], "", empty_result()).display_name, None);
    }

    #[test]
    fn sent_from_addresses_are_added_and_delivery_addresses_only_suggested() {
        let out = merge(
            &[],
            &["nope@example.test"],
            "",
            json!({"provider": provider(json!([pa("desk@example.test", json!({}))]), "ok"), "detected": [
                detected("Sent@Example.test", "sent_from", json!({"name": "Sender"})),
                detected("desk@example.test", "sent_from", json!({})),
                detected("inbound@example.test", "delivered_to", json!({"count": 4})),
                detected("sent@example.test", "delivered_to", json!({})),
                detected("nope@example.test", "delivered_to", json!({})),
                detected("me@example.test", "delivered_to", json!({})),
                detected("inbound@example.test", "delivered_to", json!({})),
            ]}),
        );
        assert_eq!(out.added, vec![alias("desk@example.test", "", "provider"), alias("Sent@Example.test", "Sender", "detected")]);
        assert_eq!(out.suggestions, vec![detected("inbound@example.test", "delivered_to", json!({"count": 4}))]);
        let addresses: Vec<&str> = out.aliases.iter().map(|a| a["address"].as_str().unwrap()).collect();
        assert_eq!(addresses, ["desk@example.test", "Sent@Example.test"]);
    }

    #[test]
    fn the_account_s_own_mail_is_read_when_the_provider_cannot_answer() {
        let result = json!({"provider": provider(json!([pa("desk@example.test", json!({}))]), "denied"), "detected": [detected("sent@example.test", "sent_from", json!({}))]});
        let out = merge(&[], &[], "", result);
        assert_eq!(out.provider_status, "denied");
        assert_eq!(out.added, vec![alias("sent@example.test", "", "detected")]);
    }

    #[test]
    fn a_broken_reply_is_an_error_and_changes_nothing() {
        let list = [alias("desk@example.test", "", "manual")];
        for result in [Value::Null, json!("nope"), json!([1])] {
            let out = merge(&list, &[], "", result);
            let want = Merged {
                aliases: list.to_vec(),
                added: vec![],
                suggestions: vec![],
                provider_status: "error".into(),
                display_name: None,
                changed: false,
            };
            assert_eq!(out, want);
        }
        // An answer with no provider half is an error, its detected half kept.
        let out = merge(&[], &[], "", json!({"detected": [detected("sent@example.test", "sent_from", json!({}))]}));
        assert_eq!(out.provider_status, "error");
        assert_eq!(out.added.len(), 1);
    }

    #[test]
    fn an_alias_that_is_the_login_itself_is_dropped() {
        // A default From saved before aliases existed becomes a manual alias
        // on upgrade, and nothing there knew the login yet.
        let out = merge(&[alias("Me@Example.test", "", "manual")], &[], "", empty_result());
        assert!(out.aliases.is_empty());
        assert!(out.changed);
    }

    #[test]
    fn an_alias_signature_survives_discovery_and_a_name_fill() {
        let signed = |name: &str| json!({"address": "desk@example.test", "name": name, "source": "manual", "signature": {"html": "<p>Desk</p>", "text": "Desk"}});
        let result = json!({"provider": provider(json!([pa("desk@example.test", json!({"name": "Front Desk"}))]), "ok"), "detected": []});
        let out = merge(&[signed("")], &[], "", result);
        assert_eq!(out.aliases, vec![signed("Front Desk")]);
    }

    #[test]
    fn a_removed_alias_is_never_brought_back_by_discovery() {
        let gone = remove(&[alias("Desk@example.test", "", "manual")], &[], "desk@example.test");
        let result = json!({
            "provider": provider(json!([pa("desk@example.test", json!({}))]), "ok"),
            "detected": [detected("desk@example.test", "sent_from", json!({"count": 3}))],
        });
        let out = merge_discovery(&gone.aliases, &gone.dismissed, LOGIN, "", &result);
        assert!(out.aliases.is_empty());
        assert!(out.added.is_empty());
    }
}
