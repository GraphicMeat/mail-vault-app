//! Saved-view RPCs.
//!
//! A view is a stored set of filters, evaluated here and never in the app: a
//! set difference against a partly loaded list is not a view, it is a guess.
//! The definition lives in `app.db`; the rows come from the search index, in
//! the same shape `mail_search` returns, so the list renders them unchanged.
use crate::handlers::common::{blocking, done};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::app_db;
use serde_json::Value;
use std::sync::Arc;

use app_db::views::{self, View, ViewDef};
use mailvault_core::search_index::query::SearchRequest;
use std::collections::HashMap;

/// One account the view runs over, as the app already knows it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    account_id: String,
    /// The account's own address, for "addressed to me" / "not from me".
    #[serde(default)]
    address: String,
    /// Server paths, so a row can name the mailbox it came from rather than
    /// the vault directory it is stored in.
    #[serde(default)]
    known_mailboxes: Vec<String>,
    /// IMAP special-use attribute to server path, for this account. A folder
    /// name is a per-mailbox word, so "not the bin" is only answerable here.
    #[serde(default)]
    special_use: HashMap<String, String>,
}

/// One message a search put on screen.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    account_id: String,
    mailbox: String,
    uid: u32,
}

fn json_of<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn accounts_of(params: &Value) -> Result<Vec<Account>, String> {
    serde_json::from_value(params.get("accounts").cloned().unwrap_or(Value::Null)).map_err(|e| format!("accounts: {e}"))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("views.") {
        return None;
    }
    let state = Arc::clone(state);
    let params = params.clone();
    let method = method.to_string();
    Some(done(id, blocking(move || run(&state, &method, &params)).await.and_then(|r| r)))
}

fn run(state: &Arc<DaemonState>, method: &str, params: &Value) -> Result<Value, String> {
    let app_dir = state.app_dir.as_path();
    match method {
        "views.list" => app_db::with(app_dir, |conn| {
            views::ensure_starters(conn)?;
            json_of(views::list(conn)?)
        }),
        "views.save" => {
            let view: View =
                serde_json::from_value(params.get("view").cloned().unwrap_or(Value::Null)).map_err(|e| format!("view: {e}"))?;
            app_db::with(app_dir, |conn| json_of(views::save(conn, &view)?))
        }
        "views.delete" => {
            let id = params.get("id").and_then(Value::as_str).ok_or("Missing id")?.to_string();
            app_db::with(app_dir, |conn| views::delete(conn, &id).map(|_| Value::Null))
        }
        "views.reorder" => {
            let ids: Vec<String> = serde_json::from_value(params.get("ids").cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("ids: {e}"))?;
            app_db::with(app_dir, |conn| views::reorder(conn, &ids).map(|_| Value::Null))
        }
        "views.evaluate" => {
            let accounts = accounts_of(params)?;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(500) as usize;
            // Every app.db read happens here, before the index lock is taken.
            let (def, keys) = app_db::with(app_dir, |conn| {
                let def = definition(conn, params)?;
                Ok((def.clone(), filter_keys(conn, &def, &accounts)?))
            })?;
            evaluate(state, &def, &accounts, &keys, limit)
        }
        // Every real attachment the view finds, flat in one folder the app
        // named. The app narrows the definition first when a person picked
        // one month out of the range; `hasAttachments` is forced here so a
        // view without it cannot walk every message in the vault. A search
        // is not a view — its targets span folders and servers a definition
        // cannot name — so it hands over the rows on screen as `messages`.
        "views.export_attachments" => {
            let dest_dir = params.get("destDir").and_then(Value::as_str).filter(|d| !d.is_empty()).ok_or("Missing destDir")?;
            let messages = match params.get("messages") {
                Some(list) => serde_json::from_value::<Vec<Message>>(list.clone())
                    .map_err(|e| format!("messages: {e}"))?
                    .into_iter()
                    .map(|m| (m.account_id, m.mailbox, m.uid))
                    .collect(),
                None => {
                    let accounts = accounts_of(params)?;
                    let (mut def, keys) = app_db::with(app_dir, |conn| {
                        let def = definition(conn, params)?;
                        Ok((def.clone(), filter_keys(conn, &def, &accounts)?))
                    })?;
                    def.has_attachments = true;
                    messages_of(state, &def, &accounts, &keys)?
                }
            };
            let root = crate::handlers::common::vault_root(state)?;
            json_of(mailvault_core::vault_files::export_many_attachments(
                &state.vault_registry,
                &root,
                &messages,
                std::path::Path::new(dest_dir),
            )?)
        }
        "views.counts" => {
            let accounts = accounts_of(params)?;
            let (all, keys) = app_db::with(app_dir, |conn| {
                views::ensure_starters(conn)?;
                let all = views::list(conn)?;
                let mut keys = HashMap::new();
                for view in &all {
                    keys.insert(view.id.clone(), filter_keys(conn, &view.def, &accounts)?);
                }
                Ok((all, keys))
            })?;
            let mut counts = serde_json::Map::new();
            for view in &all {
                let empty = HashMap::new();
                let per_view = keys.get(&view.id).unwrap_or(&empty);
                let reply = evaluate(state, &view.def, &accounts, per_view, 0)?;
                // Zero is a claim about the mail. An index that cannot answer
                // has not made it, so the whole reply is empty rather than a
                // column of confident noughts.
                if reply.get("available").and_then(Value::as_bool) != Some(true) {
                    return Ok(Value::Object(serde_json::Map::new()));
                }
                counts.insert(view.id.clone(), reply.get("total").and_then(Value::as_u64).unwrap_or(0).into());
            }
            Ok(Value::Object(counts))
        }
        _ => Err(format!("Unknown method: {method}")),
    }
}

/// The definition to run: a saved view by id, or one handed over inline (which
/// is how "save this search as a view" previews before it is saved).
fn definition(conn: &app_db::Connection, params: &Value) -> Result<ViewDef, String> {
    if let Some(id) = params.get("viewId").and_then(Value::as_str) {
        return views::get(conn, id)?.map(|view| view.def).ok_or_else(|| format!("no such view: {id}"));
    }
    serde_json::from_value(params.get("def").cloned().unwrap_or(Value::Null)).map_err(|e| format!("def: {e}"))
}

/// Per account, the identities that satisfy every tag and every field
/// condition the view names. Absent when the view narrows on neither — which
/// is not the same as an empty list, and the difference is "show everything"
/// against "show nothing".
fn filter_keys(
    conn: &app_db::Connection,
    def: &ViewDef,
    accounts: &[Account],
) -> Result<HashMap<String, Vec<String>>, String> {
    let mut keys = HashMap::new();
    if !narrows_by_metadata(def) {
        return Ok(keys);
    }
    for account in accounts {
        let mut allowed: Option<std::collections::BTreeSet<String>> = None;
        if !def.tags.is_empty() {
            let carried = app_db::tags::messages_with_every_tag(conn, &account.account_id, &def.tags)?;
            allowed = Some(carried.into_iter().collect());
        }
        for filter in &def.fields {
            let matched: std::collections::BTreeSet<String> =
                app_db::fields::messages_matching(conn, &account.account_id, filter)?.into_iter().collect();
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
fn narrows_by_metadata(def: &ViewDef) -> bool {
    !def.tags.is_empty() || !def.fields.is_empty()
}

fn request_for(def: &ViewDef, account: &Account, keys: &HashMap<String, Vec<String>>, now: i64) -> SearchRequest {
    let address = account.address.trim().to_lowercase();
    let (date_from, date_to) = views::date_window(def, now);
    SearchRequest {
        account_id: account.account_id.clone(),
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
        to_any: (def.to_me && !address.is_empty()).then(|| vec![address.clone()]).unwrap_or_default(),
        from_none: (def.not_from_me && !address.is_empty()).then(|| vec![address]).unwrap_or_default(),
        // A tag or field filter with no identities behind it matches nothing,
        // which is the correct answer for a tag nobody has used.
        msg_keys: narrows_by_metadata(def).then(|| keys.get(&account.account_id).cloned().unwrap_or_default()),
        limit: None,
        offset: 0,
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Every message a view finds as `(account, mailbox, uid)`, walked page by
/// page past the index's per-query cap. The index lock is taken per page and
/// released before any file is read.
fn messages_of(
    state: &DaemonState,
    def: &ViewDef,
    accounts: &[Account],
    keys: &HashMap<String, Vec<String>>,
) -> Result<Vec<(String, String, u32)>, String> {
    use mailvault_core::search_index::query::MAX_LIMIT;
    let now = now_secs();
    let mut out = Vec::new();
    // Mail indexed mid-walk shifts later pages by a row; the same message
    // twice would land as `photo.png` and `photo (1).png`.
    let mut seen = std::collections::HashSet::new();
    for account in accounts.iter().filter(|account| def.accounts.is_empty() || def.accounts.contains(&account.account_id)) {
        let mut request = SearchRequest { limit: Some(MAX_LIMIT), ..request_for(def, account, keys, now) };
        loop {
            let page = crate::search_index::search_page_reply(&state.search_index, &request)?
                .map_err(|reason| format!("search index unavailable: {reason}"))?
                .page;
            for hit in &page.hits {
                let (mailbox, local_only, _) =
                    crate::handlers::mail_search::mailbox_for_vault_dir(&hit.vault_dir, &account.known_mailboxes);
                let mailbox = if local_only { hit.vault_dir.clone() } else { mailbox };
                let message = (account.account_id.clone(), mailbox, hit.uid);
                if seen.insert(message.clone()) {
                    out.push(message);
                }
            }
            if page.hits.len() < MAX_LIMIT {
                break;
            }
            request.offset += page.hits.len();
        }
    }
    Ok(out)
}

fn evaluate(
    state: &DaemonState,
    def: &ViewDef,
    accounts: &[Account],
    keys: &HashMap<String, Vec<String>>,
    limit: usize,
) -> Result<Value, String> {
    let now = now_secs();
    let mut rows: Vec<Value> = Vec::new();
    let mut total = 0u64;
    // No account named is every account: a view made before a second account
    // was added must not empty itself when one arrives.
    let in_scope = accounts.iter().filter(|account| def.accounts.is_empty() || def.accounts.contains(&account.account_id));
    for account in in_scope {
        let request = request_for(def, account, keys, now);
        match crate::search_index::search_page_reply(&state.search_index, &request)? {
            // An index that cannot answer says so. An empty list would read as
            // "nothing matches this view", which is a different statement.
            Err(reason) => return Ok(serde_json::json!({ "available": false, "reason": reason, "rows": [] })),
            Ok(result) => {
                total += result.page.total;
                // `views.counts` wants the totals and nothing else. Assembling
                // every row's JSON per view per account, on the sidebar path,
                // only to throw it away is the 50k cliff.
                if limit == 0 {
                    continue;
                }
                let mut page = crate::search_index::assemble_rows(&result.page);
                // The same custody proof search reads: an archived copy the
                // server no longer holds is "local only" here too, not a row
                // that still offers to delete itself from the server.
                let custody = crate::custody::with_conn(state, |conn| {
                    mailvault_core::custody::entries::entries_for_account(conn, &account.account_id)
                })
                .map(crate::handlers::mail_search::custody_by_vault_uid)
                .unwrap_or_default();
                for row in &mut page {
                    let vault_dir = row.get("vaultDir").and_then(Value::as_str).unwrap_or("").to_owned();
                    crate::handlers::mail_search::stamp_local_row(
                        row,
                        &account.account_id,
                        &vault_dir,
                        &account.known_mailboxes,
                        false,
                        &custody,
                    );
                }
                rows.append(&mut page);
            }
        }
    }
    // Newest first across every account, the way the list already reads.
    // Cached key: re-parsing each date inside the comparator would run
    // `dateparse` O(n log n) times.
    rows.sort_by_cached_key(|row| {
        std::cmp::Reverse(row.get("date").and_then(Value::as_str).and_then(|d| mailparse::dateparse(d).ok()).unwrap_or(0))
    });
    rows.truncate(limit);
    Ok(serde_json::json!({ "available": true, "rows": rows, "total": total }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::search_index::{db as index_db, lock};
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-views-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    /// One indexed message. `filename` carries the flags, exactly as the vault
    /// spells them.
    fn seed(conn: &rusqlite::Connection, uid: u32, filename: &str, subject: &str, attachments: bool, message_id: &str) {
        let row = json!({ "uid": uid, "subject": subject, "messageId": message_id, "from": {"address": "ann@x.test"} });
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc,
               from_addr_lc, from_name_lc, subject_lc, addrs_lc, has_attachments, body_state, row_json, flags)
             VALUES ('a','INBOX',?1,?2,0,0,?3,1788825600,'ann@x.test','ann',?4,'me@x.test',?5,1,?6,?7)",
            rusqlite::params![
                uid,
                filename,
                message_id,
                subject.to_lowercase(),
                attachments,
                row.to_string(),
                mailvault_core::search_index::reconcile::flags_of(filename),
            ],
        )
        .unwrap();
    }

    fn index(s: &Arc<DaemonState>) {
        let conn = index_db::open(&s.data_dir).unwrap();
        let p = mailvault_core::maildir::INFO_PREFIX;
        seed(&conn, 1, &format!("1{p}FS.eml"), "Starred one", false, "<one@x.test>");
        seed(&conn, 2, &format!("2{p}S.eml"), "Plain two", true, "<two@x.test>");
        seed(&conn, 3, &format!("3{p}.eml"), "Unread three", false, "<three@x.test>");
        index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
        *lock(&s.search_index.db) = Some(conn);
    }

    fn accounts() -> Value {
        json!([{ "accountId": "a", "address": "me@x.test", "knownMailboxes": ["INBOX"] }])
    }

    /// "Download attachments" on a view: only the messages it finds that carry
    /// one, even when the view itself does not ask for attachments.
    #[tokio::test]
    async fn exporting_a_views_attachments_writes_only_what_it_finds() {
        let s = st();
        index(&s);
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let p = mailvault_core::maildir::INFO_PREFIX;
        let eml = "From: ann@x.test\r\nSubject: Plain two\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--B--\r\n";
        std::fs::write(cur.join(format!("2{p}S.eml")), eml).unwrap();
        let dest = s.data_dir.join("out").join("View - Attachments");
        let out = call(&s, "views.export_attachments", json!({
            "def": {}, "accounts": accounts(), "destDir": dest.to_string_lossy(),
        })).await;
        assert_eq!(out["files"], 1, "{out}");
        assert_eq!(out["skipped"], 0, "{out}");
        assert!(dest.join("a.pdf").exists());
    }

    #[tokio::test]
    async fn exporting_a_searchs_rows_reads_exactly_those_messages() {
        let s = st();
        let cur = mailvault_core::vault_files::cur_path(&s.data_dir, "a", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let p = mailvault_core::maildir::INFO_PREFIX;
        let eml = "From: ann@x.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: application/pdf; name=\"b.pdf\"\r\nContent-Disposition: attachment; filename=\"b.pdf\"\r\n\r\nx\r\n--B--\r\n";
        std::fs::write(cur.join(format!("5{p}S.eml")), eml).unwrap();
        let dest = s.data_dir.join("out").join("Search - Attachments");
        let out = call(&s, "views.export_attachments", json!({
            "messages": [{ "accountId": "a", "mailbox": "INBOX", "uid": 5 }, { "accountId": "a", "mailbox": "INBOX", "uid": 6 }],
            "destDir": dest.to_string_lossy(),
        })).await;
        assert_eq!((out["files"].as_u64(), out["skipped"].as_u64()), (Some(1), Some(1)), "{out}");
        assert!(dest.join("b.pdf").exists());
    }

    /// The app knows which folder is the bin on this account; the daemon must
    /// never guess it from a name.
    #[tokio::test]
    async fn a_special_use_exclusion_is_resolved_through_the_account_that_named_it() {
        let s = st();
        {
            let conn = index_db::open(&s.data_dir).unwrap();
            let p = mailvault_core::maildir::INFO_PREFIX;
            seed(&conn, 1, &format!("1{p}S.eml"), "Kept", false, "<one@x.test>");
            conn.execute(
                "UPDATE messages SET vault_dir = 'Papierkorb' WHERE uid = 1",
                [],
            )
            .unwrap();
            seed(&conn, 2, &format!("2{p}S.eml"), "Also kept", false, "<two@x.test>");
            index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
            *lock(&s.search_index.db) = Some(conn);
        }
        let accounts = json!([{
            "accountId": "a", "address": "me@x.test",
            "knownMailboxes": ["INBOX", "Papierkorb"],
            "specialUse": { "\\Trash": "Papierkorb" }
        }]);
        let out = call(&s, "views.evaluate", json!({
            "def": { "excludeSpecial": ["\\Trash"] }, "accounts": accounts
        }))
        .await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![2], "the message in this account's bin is left out");
    }

    /// The editor's account buttons narrow the view. The app hands over every
    /// account it has; the definition decides which of them the view reads.
    #[tokio::test]
    async fn a_view_reads_only_the_accounts_its_definition_names() {
        let s = st();
        index(&s);
        let both = json!([
            { "accountId": "a", "address": "me@x.test", "knownMailboxes": ["INBOX"] },
            { "accountId": "b", "address": "you@x.test", "knownMailboxes": ["INBOX"] }
        ]);
        let total = |out: Value| out["total"].as_u64().unwrap();
        let only_b = call(&s, "views.evaluate", json!({ "def": { "accounts": ["b"] }, "accounts": both })).await;
        assert_eq!(total(only_b), 0, "account a's mail is outside a view scoped to b");
        let only_a = call(&s, "views.evaluate", json!({ "def": { "accounts": ["a"] }, "accounts": both })).await;
        assert_eq!(total(only_a), 3);
        let every = call(&s, "views.evaluate", json!({ "def": { "accounts": [] }, "accounts": both })).await;
        assert_eq!(total(every), 3, "no account named is every account");
    }

    /// A view reads the same custody proof search does. An archived copy the
    /// server has deleted used to come back as a plain server row, offering to
    /// delete itself from a server that no longer holds it.
    #[tokio::test]
    async fn an_archived_copy_deleted_on_the_server_is_local_only_in_a_view() {
        let s = st();
        {
            let conn = index_db::open(&s.data_dir).unwrap();
            let p = mailvault_core::maildir::INFO_PREFIX;
            seed(&conn, 4, &format!("4{p}AS.eml"), "Deleted upstream", false, "<four@x.test>");
            index_db::meta_set(&conn, index_db::FIRST_PASS_DONE, "1").unwrap();
            *lock(&s.search_index.db) = Some(conn);
        }
        crate::custody::open_into(&s).unwrap();
        crate::custody::with_conn(&s, |conn| {
            mailvault_core::custody::entries::upsert(
                conn,
                "a",
                "INBOX",
                &[json!({"uid": 4, "source": "local", "serverDeleted": true})],
            )
            .map(|_| ())
        })
        .unwrap();
        let out = evaluate(&s, json!({})).await;
        let row = &out["rows"][0];
        assert_eq!(row["uid"], 4);
        assert_eq!(row["serverDeleted"], true);
        assert_eq!(row["source"], "local-only");
    }

    async fn evaluate(s: &Arc<DaemonState>, def: Value) -> Value {
        call(s, "views.evaluate", json!({ "def": def, "accounts": accounts() })).await
    }

    #[tokio::test]
    async fn the_starters_are_there_the_first_time_the_app_asks() {
        let s = st();
        let listed = call(&s, "views.list", json!({})).await;
        let builtins: Vec<&str> = listed.as_array().unwrap().iter().filter_map(|v| v["builtin"].as_str()).collect();
        assert_eq!(builtins, vec!["needs-reply", "starred", "attachments"]);
    }

    /// Registration guard: the routes are reached through
    /// `server::handle_request`, and a module that is never wired in answers
    /// "Unknown method" to an app that looks entirely healthy otherwise.
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "views.list", json!({})).await;
        assert!(resp.result.is_some(), "views.list is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn a_view_round_trips_and_can_be_deleted() {
        let s = st();
        let saved = call(&s, "views.save", json!({ "view": {
            "id": "v1", "name": "Receipts", "icon": "tag", "position": 0, "builtin": null,
            "def": { "query": "invoice", "hasAttachments": true }
        }})).await;
        assert_eq!(saved["name"], "Receipts");
        assert!(call(&s, "views.list", json!({})).await.as_array().unwrap().iter().any(|v| v["id"] == "v1"));
        call(&s, "views.delete", json!({ "id": "v1" })).await;
        assert!(!call(&s, "views.list", json!({})).await.as_array().unwrap().iter().any(|v| v["id"] == "v1"));
    }

    #[tokio::test]
    async fn reorder_route_persists_the_sidebar_order() {
        let s = st();
        let listed = call(&s, "views.list", json!({})).await;
        let mut ids: Vec<String> = listed.as_array().unwrap().iter()
            .map(|view| view["id"].as_str().unwrap().to_string()).collect();
        ids.reverse();
        call(&s, "views.reorder", json!({ "ids": ids })).await;
        let after = call(&s, "views.list", json!({})).await;
        let order: Vec<&str> = after.as_array().unwrap().iter().map(|view| view["id"].as_str().unwrap()).collect();
        assert_eq!(order, ids.iter().map(String::as_str).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn starred_returns_only_the_flagged_message() {
        let s = st();
        index(&s);
        let out = evaluate(&s, json!({ "starred": true })).await;
        assert_eq!(out["available"], true);
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![1]);
    }

    #[tokio::test]
    async fn a_row_carries_the_account_and_mailbox_the_list_needs() {
        let s = st();
        index(&s);
        let out = evaluate(&s, json!({ "starred": true })).await;
        let row = &out["rows"][0];
        assert_eq!(row["_accountId"], "a");
        assert_eq!(row["_mailbox"], "INBOX");
        let flags: Vec<&str> = row["flags"].as_array().unwrap().iter().filter_map(|f| f.as_str()).collect();
        assert!(flags.contains(&"\\Flagged"), "{flags:?}");
    }

    #[tokio::test]
    async fn unread_is_the_messages_with_no_seen_flag() {
        let s = st();
        index(&s);
        let out = evaluate(&s, json!({ "unread": true })).await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![3]);
    }

    /// The identities come from `app.db`, the rows from the index. Neither
    /// store knows about the other; the handler is what puts them together.
    #[tokio::test]
    async fn a_view_filtered_by_tag_returns_only_the_tagged_messages() {
        let s = st();
        index(&s);
        let tag = crate::handlers::tags::route(&s, "tags.ensure", &json!({"name": "Receipts"}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("ensure");
        let tag_id = tag["id"].as_str().unwrap().to_string();
        crate::handlers::tags::route(
            &s,
            "tags.assign",
            &json!({"tagId": tag_id, "items": [{"accountId": "a", "mailbox": "INBOX", "uid": 2, "messageId": "<two@x.test>"}]}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("assign");

        let carried = crate::handlers::tags::route(
            &s,
            "tags.for_messages",
            &json!({"items": [{"accountId": "a", "mailbox": "INBOX", "uid": 2, "messageId": "<two@x.test>"}]}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("for_messages");
        assert_eq!(carried["tags"], json!([[tag_id]]), "the assignment landed");

        let out = evaluate(&s, json!({ "tags": [tag_id] })).await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![2]);
    }

    /// Custom fields narrow a view the same way tags do: the identities come
    /// from `app.db`, the rows from the index.
    #[tokio::test]
    async fn a_view_filtered_by_a_custom_field_returns_only_the_messages_holding_that_value() {
        let s = st();
        index(&s);
        crate::handlers::fields::route(
            &s,
            "fields.save",
            &json!({"field": {"id": "f1", "scope": "a", "name": "Priority", "kind": "select",
                              "options": [{"id": "hi", "label": "High"}]}}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("save");
        crate::handlers::fields::route(
            &s,
            "fields.set",
            &json!({"item": {"accountId": "a", "mailbox": "INBOX", "uid": 3, "messageId": "<three@x.test>"},
                    "fieldId": "f1", "value": "hi"}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("set");

        let out = evaluate(&s, json!({ "fields": [{"fieldId": "f1", "op": "is", "value": "hi"}] })).await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![3]);
    }

    /// Two filters are an AND, not a pile: a message has to satisfy both.
    #[tokio::test]
    async fn a_tag_and_a_field_together_narrow_to_what_carries_both() {
        let s = st();
        index(&s);
        let tag = crate::handlers::tags::route(&s, "tags.ensure", &json!({"name": "Clients"}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("ensure")["id"]
            .as_str()
            .unwrap()
            .to_string();
        crate::handlers::tags::route(
            &s,
            "tags.assign",
            &json!({"tagId": tag, "items": [
                {"accountId": "a", "mailbox": "INBOX", "uid": 2, "messageId": "<two@x.test>"},
                {"accountId": "a", "mailbox": "INBOX", "uid": 3, "messageId": "<three@x.test>"}
            ]}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("assign");
        crate::handlers::fields::route(
            &s,
            "fields.save",
            &json!({"field": {"id": "f1", "scope": "a", "name": "Priority", "kind": "text"}}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("save");
        crate::handlers::fields::route(
            &s,
            "fields.set",
            &json!({"item": {"accountId": "a", "mailbox": "INBOX", "uid": 3, "messageId": "<three@x.test>"},
                    "fieldId": "f1", "value": "urgent"}),
            json!(1),
        )
        .await
        .expect("routed")
        .result
        .expect("set");

        let out = evaluate(&s, json!({
            "tags": [tag],
            "fields": [{"fieldId": "f1", "op": "is", "value": "urgent"}]
        }))
        .await;
        let uids: Vec<u64> = out["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_u64().unwrap()).collect();
        assert_eq!(uids, vec![3]);
    }

    #[tokio::test]
    async fn a_view_filtered_by_a_tag_nobody_used_returns_nothing_not_everything() {
        let s = st();
        index(&s);
        let out = evaluate(&s, json!({ "tags": ["no-such-tag"] })).await;
        assert_eq!(out["available"], true);
        assert_eq!(out["rows"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn counts_answer_per_view_without_the_rows() {
        let s = st();
        index(&s);
        call(&s, "views.list", json!({})).await;
        let counts = call(&s, "views.counts", json!({ "accounts": accounts() })).await;
        let starred_id = call(&s, "views.list", json!({})).await.as_array().unwrap().iter()
            .find(|v| v["builtin"] == "starred").unwrap()["id"].as_str().unwrap().to_string();
        assert_eq!(counts[starred_id], 1);
    }

    /// A count of zero is a claim about the mail. While the index cannot
    /// answer, the honest reply is no counts at all.
    #[tokio::test]
    async fn counts_say_nothing_rather_than_zero_while_the_index_is_closed() {
        let s = st();
        call(&s, "views.list", json!({})).await;
        let counts = call(&s, "views.counts", json!({ "accounts": accounts() })).await;
        assert_eq!(counts, json!({}));
    }

    /// An index that cannot answer must say so. Returning an empty list would
    /// read as "nothing matches this view", which is a different statement.
    #[tokio::test]
    async fn a_closed_index_says_it_cannot_answer_rather_than_answering_nothing() {
        let s = st();
        let out = evaluate(&s, json!({ "starred": true })).await;
        assert_eq!(out["available"], false);
        assert_eq!(out["reason"], "unavailable");
        assert!(out["rows"].as_array().map_or(true, |rows| rows.is_empty()));
    }
}
