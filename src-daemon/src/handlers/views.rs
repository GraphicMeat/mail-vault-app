//! Saved-view RPCs.
//!
//! A view is a stored set of filters, evaluated here and never in the app: a
//! set difference against a partly loaded list is not a view, it is a guess.
//! The definition lives in `app.db`; the rows come from the search index, in
//! the same shape `mail_search` returns, so the list renders them unchanged.
use crate::handlers::common::{blocking, done};
use crate::handlers::vault_files::ExportJob;
use crate::ipc::RpcResponse;
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
    /// Its other own addresses (default From, aliases), which count for
    /// "addressed to me" / "not from me" as the login does.
    #[serde(default)]
    aliases: Vec<String>,
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
    if method == "views.export_attachments" {
        let Some(job_id) = params.get("jobId").and_then(Value::as_str).map(str::to_owned) else {
            return Some(done(id, Err("Missing jobId".to_string())));
        };
        if params.get("destDir").and_then(Value::as_str).is_none_or(str::is_empty) {
            return Some(done(id, Err("Missing destDir".to_string())));
        }
        // A job (`vault_files::ExportJob`): answered at once, reported in frames.
        let mut job = ExportJob::new(&state, job_id.clone(), 0);
        tokio::spawn(async move {
            let _ = blocking(move || {
                let result = export_attachments(&state, &params, &mut job);
                job.finish(result);
            })
            .await;
        });
        return Some(done(id, Ok(serde_json::json!({ "jobId": job_id }))));
    }
    let method = method.to_string();
    Some(done(id, blocking(move || run(&state, &method, &params)).await.and_then(|r| r)))
}

/// Every real attachment the view finds, flat in one folder the person
/// picked. The app narrows the definition first when a person picked one
/// month or year out of the range; `hasAttachments` is forced here so a view
/// without it cannot walk every message in the vault. A search is not a view
/// (its targets span folders and servers a definition cannot name), so it
/// hands over the rows on screen as `messages`. Progress is counted in
/// messages: how many files a view holds is unknown until each is parsed.
fn export_attachments(state: &Arc<DaemonState>, params: &Value, job: &mut ExportJob) -> Result<Value, String> {
    let app_dir = state.app_dir.as_path();
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
    // An unreachable vault fails the export whole, as before; a message it
    // has no copy of comes from the server (`raw_message`).
    crate::handlers::common::vault_root(state)?;
    // Called on a blocking thread (`route`), so it may wait here.
    let handle = tokio::runtime::Handle::current();
    let total = messages.len();
    json_of(mailvault_core::vault_files::export_many_attachments(
        &messages,
        std::path::Path::new(dest_dir),
        &mut |account_id, mailbox, uid| handle.block_on(crate::raw_message::raw_message(state, account_id, mailbox, uid, true)).map(|raw| raw.to_vec()),
        &mut |done| job.step(done, total, None),
    )?)
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
        // The editor's sender typeahead: `[{ address, name, count }]`, from
        // the same index the view runs on. No accounts named is every account.
        "views.suggest_senders" => {
            let prefix = params.get("prefix").and_then(Value::as_str).unwrap_or("");
            let accounts: Vec<String> = serde_json::from_value(params.get("accounts").cloned().unwrap_or(Value::Null))
                .unwrap_or_default();
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(8).min(50) as usize;
            json_of(crate::search_index::suggest_senders(&state.search_index, &accounts, prefix, limit)?)
        }
        // The editor's query-field typeahead: `[{ term, count }]`, 20 per
        // page by default. No accounts named is every account.
        "views.suggest_terms" => {
            let prefix = params.get("prefix").and_then(Value::as_str).unwrap_or("");
            let accounts: Vec<String> = serde_json::from_value(params.get("accounts").cloned().unwrap_or(Value::Null))
                .unwrap_or_default();
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(20).min(50) as usize;
            json_of(crate::search_index::suggest_terms(&state.search_index, &accounts, prefix, offset, limit)?)
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

/// The login and every alias, lowercased, deduped, blanks dropped.
fn own_addresses(account: &Account) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in std::iter::once(&account.address).chain(account.aliases.iter()) {
        let address = raw.trim().to_lowercase();
        if !address.is_empty() && !out.contains(&address) {
            out.push(address);
        }
    }
    out
}

fn request_for(def: &ViewDef, account: &Account, keys: &HashMap<String, Vec<String>>, now: i64) -> SearchRequest {
    let own = own_addresses(account);
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
        to_any: if def.to_me { own.clone() } else { Vec::new() },
        from_none: if def.not_from_me { own } else { Vec::new() },
        exclude_terms: Vec::new(),
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

/// The flags of a row that holds no vault file come from the server, not from
/// the index. Such a row's file name is the only place the index keeps its
/// flags, and with no file there is nothing for a read-state change to rename,
/// so the row shows the flags it was indexed with for good. The header cache is
/// what every read-state writer (a sync, a mark read) patches, and it names the
/// same flags a file name would spell. A row with a vault copy keeps its file
/// name, which the reconcile renames; a row the cache has no entry for keeps
/// what the index says.
fn overlay_server_flags(state: &DaemonState, account_id: &str, rows: &mut [Value]) {
    let mut wanted: HashMap<String, Vec<u32>> = HashMap::new();
    for row in rows.iter() {
        let held = row.get("isArchived").and_then(Value::as_bool) == Some(true)
            || row.get("_localOnlyFolder").and_then(Value::as_bool) == Some(true);
        let (Some(mailbox), Some(uid)) = (
            row.get("_mailbox").and_then(Value::as_str),
            row.get("uid").and_then(Value::as_u64).and_then(|uid| u32::try_from(uid).ok()),
        ) else {
            continue;
        };
        if !held {
            wanted.entry(mailbox.to_owned()).or_default().push(uid);
        }
    }
    let mut server: HashMap<(String, u32), Vec<String>> = HashMap::new();
    for (mailbox, uids) in wanted {
        let Ok(headers) = crate::custody::with_conn(state, |conn| {
            mailvault_core::custody::cache::load_by_uids(conn, account_id, &mailbox, &uids)
        }) else {
            continue;
        };
        for header in headers {
            let Some(uid) = header.get("uid").and_then(Value::as_u64).and_then(|uid| u32::try_from(uid).ok()) else { continue };
            let imap: Vec<String> = header
                .get("flags")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            let name = mailvault_core::vault_files::build_maildir_filename(uid, &mailvault_core::vault_flags::merge_flags(&[], &imap));
            server.insert((mailbox.clone(), uid), mailvault_core::vault_eml::parse_flags_from_filename(&name));
        }
    }
    for row in rows.iter_mut() {
        let key = (
            row.get("_mailbox").and_then(Value::as_str).unwrap_or("").to_owned(),
            row.get("uid").and_then(Value::as_u64).and_then(|uid| u32::try_from(uid).ok()).unwrap_or(0),
        );
        if let (Some(flags), Some(object)) = (server.get(&key), row.as_object_mut()) {
            object.insert("flags".into(), serde_json::json!(flags));
        }
    }
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
                overlay_server_flags(state, &account.account_id, &mut page);
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

    /// A message that holds no vault file has no file name to rename when its
    /// read state changes, so the index row keeps the flags it was indexed
    /// with. The server's flags (the header cache, patched by every read-state
    /// writer) are what such a row must show.
    #[tokio::test]
    async fn a_row_with_no_vault_copy_shows_the_server_flags_not_the_indexed_ones() {
        let s = st();
        index(&s);
        crate::custody::with_conn(&s, |conn| {
            let header = |uid: u32, flags: Value| json!({ "uid": uid, "flags": flags, "date": "Mon, 07 Sep 2026 10:00:00 +0000" });
            mailvault_core::custody::cache::save_headers(
                conn, "a", "INBOX",
                &json!({ "emails": [header(3, json!(["\\Seen"])), header(1, json!(["\\Seen"]))] }).to_string(),
            )
        })
        .unwrap();
        let out = call(&s, "views.evaluate", json!({ "def": {}, "accounts": accounts() })).await;
        let flags_of = |uid: u64| -> Vec<String> {
            let row = out["rows"].as_array().unwrap().iter().find(|r| r["uid"] == uid).unwrap();
            row["flags"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_owned()).collect()
        };
        assert!(flags_of(3).contains(&"\\Seen".to_owned()), "read on the server, indexed unread: {:?}", flags_of(3));
        // Nothing cached for uid 2: its own file name stays the answer.
        assert!(flags_of(2).contains(&"\\Seen".to_owned()), "{:?}", flags_of(2));
        // The other way round: indexed starred, the server has since dropped the star.
        assert!(!flags_of(1).contains(&"\\Flagged".to_owned()), "{:?}", flags_of(1));
    }

    /// "Addressed to me" and "not from me" mean every address the account
    /// owns: mail to an alias is to you, and mail sent from one is yours.
    #[test]
    fn to_me_and_not_from_me_cover_every_alias() {
        let account: Account = serde_json::from_value(json!({
            "accountId": "a", "address": "Me@x.test", "aliases": ["Desk@x.test", "me@x.test", " "]
        }))
        .unwrap();
        let def = ViewDef { to_me: true, not_from_me: true, ..Default::default() };
        let request = request_for(&def, &account, &HashMap::new(), 0);
        assert_eq!(request.to_any, vec!["me@x.test".to_string(), "desk@x.test".to_string()]);
        assert_eq!(request.from_none, request.to_any);

        // An app that sends no aliases still gets the login alone.
        let bare: Account = serde_json::from_value(json!({ "accountId": "a", "address": "me@x.test" })).unwrap();
        assert_eq!(request_for(&def, &bare, &HashMap::new(), 0).to_any, vec!["me@x.test".to_string()]);
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
        let mut events = s.events.subscribe();
        let started = call(&s, "views.export_attachments", json!({
            "def": {}, "accounts": accounts(), "destDir": dest.to_string_lossy(), "jobId": "v-1",
        })).await;
        assert_eq!(started, json!({"jobId": "v-1"}));
        let (progress, last) = crate::handlers::vault_files::finished_export(&mut events, "v-1").await;
        // Counted in messages: the one message the view found with an attachment.
        assert_eq!(progress.last().map(|f| (f["done"].clone(), f["total"].clone())), Some((json!(1), json!(1))));
        let out = &last["result"];
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
        let mut events = s.events.subscribe();
        call(&s, "views.export_attachments", json!({
            "messages": [{ "accountId": "a", "mailbox": "INBOX", "uid": 5 }, { "accountId": "a", "mailbox": "INBOX", "uid": 6 }],
            "destDir": dest.to_string_lossy(), "jobId": "v-2",
        })).await;
        let (_, last) = crate::handlers::vault_files::finished_export(&mut events, "v-2").await;
        let out = &last["result"];
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

    /// The view editor's sender typeahead reads the same index the view runs
    /// on: every sender it offers is one the view can find.
    #[tokio::test]
    async fn suggest_senders_offers_the_indexed_senders_with_their_counts() {
        let s = st();
        index(&s);
        let out = call(&s, "views.suggest_senders", json!({ "prefix": "An", "accounts": ["a"], "limit": 8 })).await;
        assert_eq!(out, json!([{ "address": "ann@x.test", "name": "", "count": 3 }]));
        let other = call(&s, "views.suggest_senders", json!({ "prefix": "an", "accounts": ["b"] })).await;
        assert_eq!(other, json!([]), "another account's senders are not offered");
    }

    /// A suggestion list is a convenience: while the index is closed there is
    /// nothing to offer, which is not a failure the editor should show.
    #[tokio::test]
    async fn suggest_senders_offers_nothing_while_the_index_is_closed() {
        let s = st();
        let out = call(&s, "views.suggest_senders", json!({ "prefix": "ann", "accounts": ["a"] })).await;
        assert_eq!(out, json!([]));
    }

    /// The view editor's query-field typeahead reads the same index the view
    /// runs on: every term it offers is one that index's subjects carry.
    #[tokio::test]
    async fn suggest_terms_offers_indexed_terms_with_counts() {
        let s = st();
        index(&s);
        let out = call(&s, "views.suggest_terms", json!({ "prefix": "sta", "accounts": ["a"] })).await;
        assert_eq!(out, json!([{ "term": "starred", "count": 1 }]));
        let other = call(&s, "views.suggest_terms", json!({ "prefix": "sta", "accounts": ["b"] })).await;
        assert_eq!(other, json!([]), "another account's terms are not offered");
    }

    /// Same convenience rule as `suggest_senders`: nothing to offer while the
    /// index is closed is not a failure.
    #[tokio::test]
    async fn suggest_terms_offers_nothing_while_the_index_is_closed() {
        let s = st();
        let out = call(&s, "views.suggest_terms", json!({ "prefix": "sta", "accounts": ["a"] })).await;
        assert_eq!(out, json!([]));
    }
}
