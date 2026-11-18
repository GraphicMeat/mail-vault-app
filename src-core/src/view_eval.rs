//! How a saved view (`app_db::views`) becomes search-index requests: the part both apps share.
//! The daemon (`handlers/views.rs`) and the phone engine (`views.rs`) run these requests on their
//! own index and turn the hits into the rows their lists show; the definition, the tag and field
//! identities from `app.db`, and the per-account request are worked out here, the same way for
//! both.
//!
//! Every `app.db` read is [`definition`] and [`filter_keys`]: a caller does both before it takes
//! its index lock, and never holds the two at once.

use crate::app_db::{self, views::{self, ViewDef}};
use crate::search_index::query::SearchRequest;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

/// One account a view runs over, as the app knows it.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewAccount {
    pub account_id: String,
    /// The account's own address, for "addressed to me" / "not from me".
    #[serde(default)]
    pub address: String,
    /// Its other own addresses (default From, aliases), which count for
    /// "addressed to me" / "not from me" as the login does.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Server paths, so a row can name the mailbox it came from rather than
    /// the vault directory it is stored in.
    #[serde(default)]
    pub known_mailboxes: Vec<String>,
    /// IMAP special-use attribute to server path, for this account. A folder
    /// name is a per-mailbox word, so "not the bin" is only answerable here.
    #[serde(default)]
    pub special_use: HashMap<String, String>,
}

/// The definition to run: a saved view by id (`viewId`), or one handed over inline (`def`; which
/// is how "save this search as a view" previews before it is saved).
pub fn definition(conn: &Connection, params: &Value) -> Result<ViewDef, String> {
    if let Some(id) = params.get("viewId").and_then(Value::as_str) {
        return views::get(conn, id)?.map(|view| view.def).ok_or_else(|| format!("no such view: {id}"));
    }
    serde_json::from_value(params.get("def").cloned().unwrap_or(Value::Null)).map_err(|e| format!("def: {e}"))
}

/// Per account, the identities (`app_db::identity::msg_key`) that satisfy every tag and every
/// field condition the view names. Absent when the view narrows on neither — which is not the
/// same as an empty list, and the difference is "show everything" against "show nothing".
pub fn filter_keys(conn: &Connection, def: &ViewDef, accounts: &[ViewAccount]) -> Result<HashMap<String, Vec<String>>, String> {
    let mut keys = HashMap::new();
    if !narrows_by_metadata(def) {
        return Ok(keys);
    }
    for account in accounts {
        let mut allowed: Option<BTreeSet<String>> = None;
        if !def.tags.is_empty() {
            let carried = app_db::tags::messages_with_every_tag(conn, &account.account_id, &def.tags)?;
            allowed = Some(carried.into_iter().collect());
        }
        for filter in &def.fields {
            let matched: BTreeSet<String> = app_db::fields::messages_matching(conn, &account.account_id, filter)?.into_iter().collect();
            allowed = Some(match allowed {
                Some(existing) => existing.intersection(&matched).cloned().collect(),
                None => matched,
            });
        }
        keys.insert(account.account_id.clone(), allowed.unwrap_or_default().into_iter().collect());
    }
    Ok(keys)
}

/// Whether the view narrows on anything `app.db` holds rather than the index.
pub fn narrows_by_metadata(def: &ViewDef) -> bool {
    !def.tags.is_empty() || !def.fields.is_empty()
}

/// The login and every alias, lowercased, deduped, blanks dropped.
pub fn own_addresses(account: &ViewAccount) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in std::iter::once(&account.address).chain(account.aliases.iter()) {
        let address = raw.trim().to_lowercase();
        if !address.is_empty() && !out.contains(&address) {
            out.push(address);
        }
    }
    out
}

/// The index request for one account of a view at `now` (unix seconds). `keys`: [`filter_keys`].
pub fn request_for(def: &ViewDef, account: &ViewAccount, keys: &HashMap<String, Vec<String>>, now: i64) -> SearchRequest {
    let own = own_addresses(account);
    let (date_from, date_to) = views::date_window(def, now);
    SearchRequest {
        account_id: account.account_id.clone(),
        account_ids: Vec::new(),
        query: def.query.clone(),
        mailboxes: (!def.mailboxes.is_empty()).then(|| def.mailboxes.clone()),
        mailboxes_excluded: def
            .mailboxes_excluded
            .iter()
            .cloned()
            .chain(def.exclude_special.iter().filter_map(|use_| account.special_use.get(use_).cloned()))
            .collect(),
        sender: def.sender.clone(),
        // "The last N days" and "last month" are resolved now, not when the
        // view was saved.
        date_from,
        date_to,
        has_attachments: def.has_attachments,
        unread: def.unread,
        starred: def.starred,
        answered: def.answered,
        to_any: if def.to_me { own.clone() } else { Vec::new() },
        from_none: if def.not_from_me { own } else { Vec::new() },
        from_any: def.senders.clone(),
        from_not: def.exclude_senders.clone(),
        exclude_keys: def.exclude_messages.clone(),
        exclude_terms: Vec::new(),
        // A tag or field filter with no identities behind it matches nothing,
        // which is the correct answer for a tag nobody has used.
        msg_keys: narrows_by_metadata(def).then(|| keys.get(&account.account_id).cloned().unwrap_or_default()),
        limit: None,
        offset: 0,
    }
}

/// The accounts of `accounts` a view runs over: those its definition names, or every one when it
/// names none (a view made before a second account was added must not empty itself when one
/// arrives).
pub fn in_scope<'a, 'd>(def: &'d ViewDef, accounts: &'a [ViewAccount]) -> impl Iterator<Item = &'a ViewAccount> + use<'a, 'd> {
    accounts.iter().filter(move |account| def.accounts.is_empty() || def.accounts.contains(&account.account_id))
}

/// The view's requests, one per group of accounts it filters alike, each with `account_ids` set to
/// its group (and `account_id` empty). Every FTS probe runs over the whole index whatever account
/// it is for, so one statement per account paid for the same match once per account: ~0.18s each
/// on a 19-account vault, held on the index lock a click waits on. An account whose filters differ
/// (its own address, its own bin, its own tags) gets its own.
pub fn batches<'a>(def: &ViewDef, accounts: &'a [ViewAccount], keys: &HashMap<String, Vec<String>>, now: i64) -> Vec<(SearchRequest, Vec<&'a ViewAccount>)> {
    let mut batches: Vec<(SearchRequest, Vec<&ViewAccount>)> = Vec::new();
    for account in in_scope(def, accounts) {
        let mut request = request_for(def, account, keys, now);
        request.account_id.clear();
        match batches.iter_mut().find(|(alike, _)| *alike == request) {
            Some((_, group)) => group.push(account),
            None => batches.push((request, vec![account])),
        }
    }
    for (request, group) in &mut batches {
        request.account_ids = group.iter().map(|account| account.account_id.clone()).collect();
    }
    batches
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn account(id: &str, address: &str) -> ViewAccount {
        ViewAccount { account_id: id.into(), address: address.into(), ..ViewAccount::default() }
    }

    #[test]
    fn own_addresses_are_the_login_and_aliases_once_each() {
        let a = ViewAccount { aliases: vec![" Me@X.test ".into(), "alt@x.test".into(), "".into()], ..account("a", "me@x.test") };
        assert_eq!(own_addresses(&a), vec!["me@x.test".to_string(), "alt@x.test".to_string()]);
    }

    #[test]
    fn a_view_with_no_metadata_filter_sends_no_identities() {
        let def = ViewDef { query: "invoice".into(), ..ViewDef::default() };
        let r = request_for(&def, &account("a", "me@x.test"), &HashMap::new(), 0);
        assert_eq!(r.msg_keys, None);
        let tagged = ViewDef { tags: vec!["t".into()], ..ViewDef::default() };
        assert_eq!(request_for(&tagged, &account("a", "me@x.test"), &HashMap::new(), 0).msg_keys, Some(Vec::new()), "a tag nobody used finds nothing");
    }

    #[test]
    fn needs_reply_resolves_the_bin_per_account_and_the_own_addresses() {
        let mut a = account("a", "me@x.test");
        a.special_use.insert("\\Trash".into(), "Papierkorb".into());
        let def = ViewDef { exclude_special: vec!["\\Trash".into(), "\\Junk".into()], to_me: true, not_from_me: true, ..ViewDef::default() };
        let r = request_for(&def, &a, &HashMap::new(), 0);
        assert_eq!(r.mailboxes_excluded, vec!["Papierkorb".to_string()]);
        assert_eq!(r.to_any, vec!["me@x.test".to_string()]);
        assert_eq!(r.from_none, vec!["me@x.test".to_string()]);
    }

    #[test]
    fn accounts_filtered_alike_share_one_request_and_a_named_scope_is_kept() {
        let accounts = vec![account("a", ""), account("b", ""), account("c", "c@x.test")];
        let def = ViewDef { starred: Some(true), ..ViewDef::default() };
        let got = batches(&def, &accounts, &HashMap::new(), 0);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0.account_ids, vec!["a", "b", "c"]);
        let mine = ViewDef { to_me: true, accounts: vec!["a".into(), "c".into()], ..ViewDef::default() };
        let got = batches(&mine, &accounts, &HashMap::new(), 0);
        assert_eq!(got.iter().map(|(r, _)| r.account_ids.clone()).collect::<Vec<_>>(), vec![vec!["a".to_string()], vec!["c".to_string()]]);
        assert_eq!(in_scope(&mine, &accounts).count(), 2);
    }

    #[test]
    fn a_definition_is_a_saved_view_or_one_handed_over() {
        let dir = std::env::temp_dir().join(format!("mv-view-eval-{}", uuid::Uuid::new_v4()));
        let c = app_db::db::open(&dir).unwrap();
        views::ensure_starters(&c).unwrap();
        assert_eq!(definition(&c, &json!({ "viewId": "builtin-starred" })).unwrap().starred, Some(true));
        assert!(definition(&c, &json!({ "viewId": "nope" })).is_err());
        assert!(definition(&c, &json!({ "def": { "hasAttachments": true } })).unwrap().has_attachments);
    }
}
