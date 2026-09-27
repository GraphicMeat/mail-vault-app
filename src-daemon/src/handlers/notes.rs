//! Notes to Self: `notes.list` builds the board's deduped cards straight from
//! the search index; `notes.set_done` hides one by adding the app tag `Done`
//! to every copy, through the same store `tags.*` uses. Detection itself
//! (`is_note_to_self`, `classify`, `links`) lives in
//! `mailvault_core::notes_to_self` — spec: docs/superpowers/plans/
//! 2026-09-26-feedback-batch-sdd/track-I-spec.md.
use crate::handlers::common::{blocking, done, MessageRef};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::app_db::{self, tags};
use mailvault_core::notes_to_self::{self, normalize_identity, Column};
use mailvault_core::search_index::query::NoteAttachment;
use mailvault_core::vault_eml::parse_flags_from_filename;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// The app tag a "done" note carries. Same store, same name a user would type
/// themselves — removing it un-hides the card, nothing else changes.
const DONE_TAG: &str = "Done";

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    // Part of the wire shape the app sends (`{accountId, address}`); the
    // lookup below only ever needs the address, `accountId` on a card's
    // copies comes from the index row itself.
    #[allow(dead_code)]
    account_id: String,
    #[serde(default)]
    address: String,
}

fn accounts_of(params: &Value) -> Result<Vec<Account>, String> {
    serde_json::from_value(params.get("accounts").cloned().unwrap_or(Value::Null)).map_err(|e| format!("accounts: {e}"))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("notes.") {
        return None;
    }
    let state = Arc::clone(state);
    let params = params.clone();
    let method = method.to_string();
    Some(done(id, blocking(move || run(&state, &method, &params)).await.and_then(|r| r)))
}

fn run(state: &Arc<DaemonState>, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "notes.list" => list(state, params),
        "notes.set_done" => set_done(state, params),
        _ => Err(format!("Unknown method: {method}")),
    }
}

/// One dedupe group in progress: the newest copy's own fields for display,
/// every copy seen so far, and whether any copy is starred.
struct Card {
    subject: String,
    snippet: String,
    date_utc: i64,
    account_id: String,
    column: Column,
    links: Vec<String>,
    attachments: Vec<NoteAttachment>,
    starred: bool,
    /// (accountId, vaultDir, uid, messageId, msgKey) — the first four ship in
    /// the reply, `msgKey` is only for the `Done` tag lookup below.
    copies: Vec<(String, String, u32, Option<String>, String)>,
}

/// The dedupe key from the track spec's ruling: the Message-ID when the index
/// has one, else `(normalized from, subject, date to the second)` — `date_utc`
/// already is seconds.
fn dedupe_key(message_id: Option<&str>, from_addr_lc: &str, display_subject: &str, date_utc: i64) -> String {
    let id = message_id.unwrap_or("").trim();
    let id = id.strip_prefix('<').unwrap_or(id).strip_suffix('>').unwrap_or(id).trim();
    if !id.is_empty() {
        return format!("id:{id}");
    }
    format!("f:{}:{}:{date_utc}", normalize_identity(from_addr_lc), display_subject.to_lowercase())
}

fn column_name(column: &Column) -> String {
    match column {
        Column::Tag(name) => name.clone(),
        Column::Links => "Links".to_string(),
        Column::Files => "Files".to_string(),
        Column::Photos => "Photos".to_string(),
        Column::Notes => "Notes".to_string(),
    }
}

fn list(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let accounts = accounts_of(params)?;
    let include_done = params.get("includeDone").and_then(Value::as_bool).unwrap_or(false);

    // The SQL prefilter widens past `own_normalized`: `from_addr_lc` is the
    // raw lowercased header address, never Gmail-dot-stripped, so a
    // configured login address that itself has a dot (`j.doe@gmail.com`,
    // extremely common) would otherwise never match its own normalized form
    // and the board would come back empty for that account. `is_note_to_self`
    // below re-checks against the true normalized set, so widening the SQL
    // net can only add candidates, never wrongly admit one.
    let mut own_normalized: HashSet<String> = HashSet::new();
    let mut sql_own: HashSet<String> = HashSet::new();
    for account in &accounts {
        let addr = account.address.trim();
        if addr.is_empty() {
            continue;
        }
        let normalized = normalize_identity(addr);
        sql_own.insert(addr.to_lowercase());
        sql_own.insert(normalized.clone());
        own_normalized.insert(normalized);
    }
    if own_normalized.is_empty() {
        return Ok(serde_json::json!({ "cards": [] }));
    }

    let candidates = crate::search_index::notes_candidates(&state.search_index, &sql_own)?;

    let mut order: Vec<String> = Vec::new();
    let mut cards: HashMap<String, Card> = HashMap::new();
    for candidate in candidates {
        let recipients = notes_to_self::split_to_lc(&candidate.to_lc);
        if !notes_to_self::is_note_to_self(&candidate.from_addr_lc, &recipients, &own_normalized) {
            continue;
        }
        let snippet = candidate.snippet.clone().unwrap_or_default();
        let attachment_pairs: Vec<(String, String)> =
            candidate.attachments.iter().map(|a| (a.filename.clone(), a.mime.clone())).collect();
        let (column, display_subject) = notes_to_self::classify(&candidate.subject, &snippet, &attachment_pairs);
        let links = notes_to_self::links(&candidate.subject, &snippet);
        let starred = parse_flags_from_filename(&candidate.filename).iter().any(|f| f == "\\Flagged");
        let msg_key = app_db::identity::msg_key(candidate.message_id.as_deref(), &candidate.vault_dir, candidate.uid);
        let key = dedupe_key(candidate.message_id.as_deref(), &candidate.from_addr_lc, &display_subject, candidate.date_utc);
        let copy = (candidate.account_id.clone(), candidate.vault_dir.clone(), candidate.uid, candidate.message_id.clone(), msg_key);
        let date_utc = candidate.date_utc;
        let is_new = !cards.contains_key(&key);
        let card = cards.entry(key.clone()).or_insert_with(|| Card {
            subject: display_subject,
            snippet,
            date_utc,
            account_id: candidate.account_id,
            column,
            links,
            attachments: candidate.attachments,
            starred: false,
            copies: Vec::new(),
        });
        card.starred = card.starred || starred;
        card.copies.push(copy);
        if is_new {
            order.push(key);
        }
    }

    // "Done" per copy: the tag may not exist yet (nobody has finished a note),
    // in which case nothing is done and no app.db write happens just to look.
    let mut per_account_keys: HashMap<String, Vec<String>> = HashMap::new();
    for card in cards.values() {
        for (account_id, _, _, _, msg_key) in &card.copies {
            per_account_keys.entry(account_id.clone()).or_default().push(msg_key.clone());
        }
    }
    let done_of: HashMap<(String, String), bool> = app_db::with(&state.app_dir, |conn| {
        let mut out = HashMap::new();
        let Some(tag_id) = tags::list(conn)?.into_iter().find(|t| t.name.eq_ignore_ascii_case(DONE_TAG)).map(|t| t.id)
        else {
            return Ok(out);
        };
        for (account_id, keys) in &per_account_keys {
            for (msg_key, tag_ids) in tags::for_messages(conn, account_id, keys)? {
                out.insert((account_id.clone(), msg_key), tag_ids.contains(&tag_id));
            }
        }
        Ok(out)
    })?;

    let mut out = Vec::new();
    for key in order {
        let card = cards.remove(&key).expect("just inserted");
        let is_done = card
            .copies
            .iter()
            .any(|(account_id, _, _, _, msg_key)| done_of.get(&(account_id.clone(), msg_key.clone())).copied().unwrap_or(false));
        if is_done && !include_done {
            continue;
        }
        let copies: Vec<Value> = card
            .copies
            .iter()
            .map(|(account_id, vault_dir, uid, message_id, _)| {
                serde_json::json!({ "accountId": account_id, "mailbox": vault_dir, "uid": uid, "messageId": message_id })
            })
            .collect();
        let attachments: Vec<Value> = card
            .attachments
            .iter()
            .map(|a| serde_json::json!({ "name": a.filename, "mime": a.mime, "partIndex": a.part_index }))
            .collect();
        out.push(serde_json::json!({
            "key": key,
            "copies": copies,
            "subject": card.subject,
            "snippet": card.snippet,
            "date": card.date_utc,
            "accountId": card.account_id,
            "column": column_name(&card.column),
            "links": card.links,
            "attachments": attachments,
            "starred": card.starred,
            "done": is_done,
        }));
    }
    Ok(serde_json::json!({ "cards": out }))
}

fn set_done(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let copies: Vec<MessageRef> =
        serde_json::from_value(params.get("copies").cloned().unwrap_or(Value::Null)).map_err(|e| format!("copies: {e}"))?;
    let want_done = params.get("done").and_then(Value::as_bool).ok_or("Missing done")?;
    let targets: Vec<tags::Target> = copies.iter().map(MessageRef::target).collect();
    app_db::with(&state.app_dir, move |conn| {
        // Created on first use, exactly as if the user had typed the name
        // themselves — this is the only writer that ever creates it.
        let tag = tags::ensure(conn, DONE_TAG, "")?;
        let count = if want_done { tags::assign(conn, &tag.id, &targets)? } else { tags::unassign(conn, &tag.id, &targets)? };
        Ok(serde_json::json!({ "count": count }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::maildir::INFO_PREFIX;
    use mailvault_core::search_index::{db as index_db, lock};
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-notes-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    /// One indexed message with a `to_lc` (Track I's "recipients" column) and
    /// flags riding the vault filename the way a real one does.
    #[allow(clippy::too_many_arguments)]
    fn note_row(
        conn: &rusqlite::Connection,
        account: &str,
        vault_dir: &str,
        uid: u32,
        flags: &str,
        message_id: Option<&str>,
        from_addr_lc: &str,
        to_lc: &str,
        subject: &str,
        date_utc: i64,
    ) {
        let row_json = json!({ "subject": subject }).to_string();
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
               from_addr_lc, subject_lc, row_json, to_lc, snippet)
             VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?6, ?7, ?8, ?9, ?10, 'a snippet')",
            rusqlite::params![
                account, vault_dir, uid, format!("{uid}{INFO_PREFIX}{flags}.eml"), message_id, date_utc,
                from_addr_lc, subject.to_lowercase(), row_json, to_lc,
            ],
        )
        .unwrap();
    }

    fn open_index(s: &Arc<DaemonState>) -> rusqlite::Connection {
        let conn = index_db::open(&s.data_dir).unwrap();
        index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
        conn
    }

    fn install(s: &Arc<DaemonState>, conn: rusqlite::Connection) {
        *lock(&s.search_index.db) = Some(conn);
    }

    fn accounts(pairs: &[(&str, &str)]) -> Value {
        json!(pairs.iter().map(|(id, addr)| json!({ "accountId": id, "address": addr })).collect::<Vec<_>>())
    }

    /// Registration guard: the routes are reached through
    /// `server::handle_request`, and a module that is never wired in answers
    /// "Unknown method" to an app that looks entirely healthy otherwise.
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "notes.list", json!({ "accounts": accounts(&[]) })).await;
        assert!(resp.result.is_some(), "notes.list is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn a_self_to_self_note_in_sent_and_inbox_is_one_card_with_two_copies() {
        let s = st();
        let conn = open_index(&s);
        note_row(&conn, "a", "Sent", 1, "S", Some("<n1@x.test>"), "me@x.test", "me@x.test", "A note", 100);
        note_row(&conn, "a", "INBOX", 7, "S", Some("<n1@x.test>"), "me@x.test", "me@x.test", "A note", 100);
        install(&s, conn);
        let out = call(&s, "notes.list", json!({ "accounts": accounts(&[("a", "me@x.test")]) })).await;
        let cards = out["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 1, "{cards:?}");
        assert_eq!(cards[0]["copies"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_note_from_one_own_account_to_another_is_a_card() {
        let s = st();
        let conn = open_index(&s);
        note_row(&conn, "a", "Sent", 1, "S", Some("<n2@x.test>"), "work@x.test", "personal@x.test", "Cross-account", 100);
        install(&s, conn);
        let accts = accounts(&[("a", "work@x.test"), ("b", "personal@x.test")]);
        let out = call(&s, "notes.list", json!({ "accounts": accts })).await;
        let cards = out["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["subject"], "Cross-account");
    }

    #[tokio::test]
    async fn mail_to_a_stranger_is_excluded() {
        let s = st();
        let conn = open_index(&s);
        note_row(&conn, "a", "Sent", 1, "S", Some("<n3@x.test>"), "me@x.test", "stranger@other.test", "Not a note", 100);
        install(&s, conn);
        let out = call(&s, "notes.list", json!({ "accounts": accounts(&[("a", "me@x.test")]) })).await;
        assert_eq!(out["cards"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn a_hash_tag_in_the_subject_makes_its_own_column() {
        let s = st();
        let conn = open_index(&s);
        note_row(&conn, "a", "Sent", 1, "S", Some("<n4@x.test>"), "me@x.test", "me@x.test", "#recipes Pasta", 100);
        install(&s, conn);
        let out = call(&s, "notes.list", json!({ "accounts": accounts(&[("a", "me@x.test")]) })).await;
        let card = &out["cards"][0];
        assert_eq!(card["column"], "Recipes");
        assert_eq!(card["subject"], "Pasta");
    }

    #[tokio::test]
    async fn set_done_hides_the_card_and_include_done_shows_it_again() {
        let s = st();
        let conn = open_index(&s);
        note_row(&conn, "a", "Sent", 1, "S", Some("<n5@x.test>"), "me@x.test", "me@x.test", "Finish me", 100);
        install(&s, conn);
        let accts = accounts(&[("a", "me@x.test")]);
        let before = call(&s, "notes.list", json!({ "accounts": accts })).await;
        assert_eq!(before["cards"].as_array().unwrap().len(), 1);
        let copies = before["cards"][0]["copies"].clone();

        call(&s, "notes.set_done", json!({ "copies": copies, "done": true })).await;

        let after = call(&s, "notes.list", json!({ "accounts": accts })).await;
        assert_eq!(after["cards"].as_array().unwrap().len(), 0, "a done card hides by default");

        let with_done = call(&s, "notes.list", json!({ "accounts": accts, "includeDone": true })).await;
        assert_eq!(with_done["cards"].as_array().unwrap().len(), 1);
        assert_eq!(with_done["cards"][0]["done"], true);

        call(&s, "notes.set_done", json!({ "copies": copies, "done": false })).await;
        let restored = call(&s, "notes.list", json!({ "accounts": accts })).await;
        assert_eq!(restored["cards"].as_array().unwrap().len(), 1, "removing the tag brings it back");
    }

    #[tokio::test]
    async fn starred_reflects_the_flagged_flag_on_any_copy() {
        let s = st();
        let conn = open_index(&s);
        note_row(&conn, "a", "Sent", 1, "S", Some("<n6@x.test>"), "me@x.test", "me@x.test", "Starred note", 100);
        note_row(&conn, "a", "INBOX", 8, "FS", Some("<n6@x.test>"), "me@x.test", "me@x.test", "Starred note", 100);
        install(&s, conn);
        let out = call(&s, "notes.list", json!({ "accounts": accounts(&[("a", "me@x.test")]) })).await;
        assert_eq!(out["cards"][0]["starred"], true, "the inbox copy carries \\Flagged");
    }

    /// The SQL prefilter must not miss a dotted Gmail login address: its own
    /// sent mail's `from_addr_lc` carries the dot literally, while the
    /// account's own identity normalizes it away.
    #[tokio::test]
    async fn a_dotted_gmail_login_still_finds_its_own_notes() {
        let s = st();
        let conn = open_index(&s);
        note_row(&conn, "a", "Sent", 1, "S", Some("<n7@x.test>"), "j.doe@gmail.com", "j.doe@gmail.com", "Dotted", 100);
        install(&s, conn);
        let out = call(&s, "notes.list", json!({ "accounts": accounts(&[("a", "j.doe@gmail.com")]) })).await;
        assert_eq!(out["cards"].as_array().unwrap().len(), 1);
    }
}
