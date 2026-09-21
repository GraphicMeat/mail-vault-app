//! Tag RPCs. The store is `app.db` (`mailvault_core::app_db::tags`); this
//! layer only turns list rows into the stable `msg_key` the store is keyed by.
//!
//! The app sends what its rows already carry — account, mailbox, uid and the
//! `Message-ID` when the row has one — and the key rule stays here, in one
//! place, rather than being mirrored in JS.
use crate::handlers::common::{blocking, done};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::app_db;
use serde_json::Value;
use std::sync::Arc;

use crate::handlers::common::MessageRef as Item;
use app_db::tags::{self, Target};
use std::collections::HashMap;

/// A label the app is handing over from `frontend-settings.json`. The app
/// reads its own settings file and sends the contents; the daemon never opens
/// it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLabel {
    id: String,
    name: String,
    #[serde(default)]
    color: String,
}

/// One legacy `[accountId, mailbox, uid] -> labelId` pair, flattened by the app.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAssignment {
    label_id: String,
    account_id: String,
    mailbox: String,
    uid: u32,
}

fn items(params: &Value) -> Result<Vec<Item>, String> {
    serde_json::from_value(params.get("items").cloned().unwrap_or(Value::Null)).map_err(|e| format!("items: {e}"))
}

fn arg(params: &Value, name: &str) -> Result<String, String> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing {name}"))
}

fn json_of<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("tags.") {
        return None;
    }
    let app_dir = state.app_dir.clone();
    let params = params.clone();
    let method_owned = method.to_string();
    // `tags.migrate_legacy` reads the search index, which lives behind a
    // blocking mutex like the store itself.
    let index = Arc::clone(&state.search_index);
    Some(done(
        id,
        blocking(move || run(&app_dir, &index, &method_owned, &params)).await.and_then(|r| r),
    ))
}

fn run(
    app_dir: &std::path::Path,
    index: &Arc<crate::search_index::SearchIndexState>,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    // The index reads happen BEFORE the app.db lock is taken: `app_db::with`
    // holds a process-wide mutex for its whole closure, and taking the index
    // lock inside it would be the one path in the daemon that holds app.db
    // and then waits on the index. Nothing else needs to know the order if no
    // one ever holds both.
    if method == "tags.migrate_legacy" {
        let legacy: Legacy = serde_json::from_value(params.clone()).map_err(|e| e.to_string())?;
        let known = resolve_legacy(index, &legacy)?;
        return app_db::with(app_dir, |conn| migrate_legacy(conn, &legacy, &known));
    }
    app_db::with(app_dir, |conn| match method {
        "tags.list" => json_of(tags::list(conn)?),
        "tags.ensure" => json_of(tags::ensure(conn, &arg(params, "name")?, params.get("color").and_then(Value::as_str).unwrap_or(""))?),
        "tags.rename" => tags::rename(conn, &arg(params, "id")?, &arg(params, "name")?).map(|_| Value::Null),
        "tags.set_color" => tags::set_color(conn, &arg(params, "id")?, params.get("color").and_then(Value::as_str).unwrap_or(""))
            .map(|_| Value::Null),
        "tags.delete" => tags::delete(conn, &arg(params, "id")?).map(|_| Value::Null),
        "tags.assign" => {
            let targets: Vec<Target> = items(params)?.iter().map(Item::target).collect();
            let count = tags::assign(conn, &arg(params, "tagId")?, &targets)?;
            Ok(serde_json::json!({ "count": count }))
        }
        "tags.unassign" => {
            let targets: Vec<Target> = items(params)?.iter().map(Item::target).collect();
            let count = tags::unassign(conn, &arg(params, "tagId")?, &targets)?;
            Ok(serde_json::json!({ "count": count }))
        }
        "tags.for_messages" => {
            let items = items(params)?;
            // One entry per requested row, in request order: the app matches
            // them up by position rather than re-deriving the key in JS.
            let mut per_account: HashMap<String, Vec<String>> = HashMap::new();
            let targets: Vec<Target> = items.iter().map(Item::target).collect();
            for target in &targets {
                per_account.entry(target.account_id.clone()).or_default().push(target.msg_key.clone());
            }
            let mut found: HashMap<(String, String), Vec<String>> = HashMap::new();
            for (account_id, keys) in per_account {
                for (msg_key, tag_ids) in tags::for_messages(conn, &account_id, &keys)? {
                    found.insert((account_id.clone(), msg_key), tag_ids);
                }
            }
            let rows: Vec<Vec<String>> = targets
                .iter()
                .map(|t| found.get(&(t.account_id.clone(), t.msg_key.clone())).cloned().unwrap_or_default())
                .collect();
            Ok(serde_json::json!({ "tags": rows }))
        }
        _ => Err(format!("Unknown method: {method}")),
    })
}

/// What the app hands over from `frontend-settings.json`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Legacy {
    #[serde(default)]
    labels: Vec<LegacyLabel>,
    #[serde(default)]
    assignments: Vec<LegacyAssignment>,
}

/// The `Message-ID` the index holds per `(account, mailbox, uid)` the legacy
/// assignments name. A uid absent here is one the index has no row for.
type Known = HashMap<(String, String), HashMap<u32, Option<String>>>;

fn not_ready(why: impl std::fmt::Display) -> String {
    format!("search index is not ready: {why}")
}

/// Look every legacy assignment up in the index. Index locks only, no app.db.
fn resolve_legacy(index: &Arc<crate::search_index::SearchIndexState>, legacy: &Legacy) -> Result<Known, String> {
    // An index that holds nothing for an account cannot tell "this message is
    // gone" from "this account has not been indexed yet", and the app clears
    // its legacy store on a success reply. Refuse; the next launch retries.
    for account_id in legacy.assignments.iter().map(|a| &a.account_id).collect::<std::collections::BTreeSet<_>>() {
        let holds = crate::search_index::holds_account(index, account_id).map_err(not_ready)?;
        if !holds {
            return Err(not_ready(format!("no rows for account {account_id} yet")));
        }
    }
    let mut by_folder: HashMap<(String, String), Vec<u32>> = HashMap::new();
    for a in &legacy.assignments {
        by_folder.entry((a.account_id.clone(), a.mailbox.clone())).or_default().push(a.uid);
    }
    let mut known: Known = HashMap::new();
    for ((account_id, mailbox), uids) in by_folder {
        let found = crate::search_index::known_message_ids(index, &account_id, &mailbox, &uids).map_err(not_ready)?;
        known.insert((account_id, mailbox), found);
    }
    Ok(known)
}

/// Re-key the app's old `localMailLabels` onto stable identities.
///
/// A uid the index has no row for is **dropped**, never guessed at: writing
/// the uid fallback for a message that does have a Message-ID would attach the
/// tag to a key nothing else ever computes.
fn migrate_legacy(conn: &app_db::Connection, legacy: &Legacy, known: &Known) -> Result<Value, String> {
    let mut tag_of_label: HashMap<String, String> = HashMap::new();
    for label in &legacy.labels {
        // Case-insensitive duplicates in the legacy store merge here rather
        // than failing on the unique index.
        let tag = tags::ensure(conn, &label.name, &label.color)?;
        tag_of_label.insert(label.id.clone(), tag.id);
    }

    let mut per_tag: HashMap<String, Vec<Target>> = HashMap::new();
    let mut dropped = 0usize;
    for a in &legacy.assignments {
        let Some(tag_id) = tag_of_label.get(&a.label_id) else {
            dropped += 1;
            continue;
        };
        let Some(message_id) = known.get(&(a.account_id.clone(), a.mailbox.clone())).and_then(|m| m.get(&a.uid)) else {
            dropped += 1;
            continue;
        };
        let vault_dir = mailvault_core::search_index::text::vault_dir_name(&a.mailbox);
        per_tag.entry(tag_id.clone()).or_default().push(Target {
            account_id: a.account_id.clone(),
            msg_key: app_db::identity::msg_key(message_id.as_deref(), &vault_dir, a.uid),
        });
    }

    let mut migrated = 0usize;
    for (tag_id, targets) in per_tag {
        migrated += tags::assign(conn, &tag_id, &targets)?;
    }
    tracing::info!("tags.migrate_legacy: migrated {migrated}, dropped {dropped}");
    // The app rewrites its own quick-action config (`params.labelId`) off this
    // map, so a configured tag action keeps working after the swap.
    Ok(serde_json::json!({ "migrated": migrated, "dropped": dropped, "tagOfLabel": tag_of_label }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::search_index::{db as index_db, lock};
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-tags-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    async fn tag_named(s: &Arc<DaemonState>, name: &str) -> String {
        call(s, "tags.ensure", json!({"name": name, "color": ""})).await["id"].as_str().unwrap().to_string()
    }

    /// One index row, so the migration has something to resolve against.
    fn seed_index(s: &Arc<DaemonState>, account: &str, vault_dir: &str, uid: u32, message_id: &str) {
        let conn = index_db::open(&s.data_dir).unwrap();
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, message_id, date_utc)
             VALUES (?1,?2,?3,?4,0,0,?5,0)",
            rusqlite::params![account, vault_dir, uid, format!("{uid}:2,S.eml"), message_id],
        )
        .unwrap();
        *lock(&s.search_index.db) = Some(conn);
    }

    /// Registration guard, not a behaviour test: the routes are reached through
    /// `server::handle_request`, and a module that is never wired in answers
    /// "Unknown method" to an app that looks entirely healthy otherwise.
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "tags.list", json!({})).await;
        assert!(resp.result.is_some(), "tags.list is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn a_tagged_message_is_counted_and_comes_back_for_its_row() {
        let s = st();
        let tag = tag_named(&s, "Receipts").await;
        let item = json!({"accountId": "a", "mailbox": "INBOX", "uid": 7, "messageId": "<abc@example.com>"});
        let applied = call(&s, "tags.assign", json!({"tagId": tag, "items": [item.clone()]})).await;
        assert_eq!(applied["count"], 1);

        let listed = call(&s, "tags.list", json!({})).await;
        assert_eq!(listed[0]["count"], 1);

        let got = call(&s, "tags.for_messages", json!({"items": [item]})).await;
        assert_eq!(got["tags"], json!([[tag]]), "one entry per requested row, in order");
    }

    #[tokio::test]
    async fn the_same_message_id_carries_its_tag_into_another_folder() {
        let s = st();
        let tag = tag_named(&s, "Clients").await;
        call(
            &s,
            "tags.assign",
            json!({"tagId": tag, "items": [{"accountId": "a", "mailbox": "INBOX", "uid": 7, "messageId": "<abc@example.com>"}]}),
        )
        .await;
        // Moved: new mailbox, new uid, same message.
        let moved = json!({"accountId": "a", "mailbox": "Archive", "uid": 4102, "messageId": "<abc@example.com>"});
        let got = call(&s, "tags.for_messages", json!({"items": [moved]})).await;
        assert_eq!(got["tags"], json!([[tag]]));
    }

    #[tokio::test]
    async fn a_row_without_a_message_id_is_keyed_by_its_mailbox_and_uid() {
        let s = st();
        let tag = tag_named(&s, "Clients").await;
        let item = json!({"accountId": "a", "mailbox": "INBOX", "uid": 7});
        call(&s, "tags.assign", json!({"tagId": tag, "items": [item.clone()]})).await;

        let same = call(&s, "tags.for_messages", json!({"items": [item]})).await;
        assert_eq!(same["tags"], json!([[tag]]));
        let elsewhere = json!({"accountId": "a", "mailbox": "Archive", "uid": 7});
        let other = call(&s, "tags.for_messages", json!({"items": [elsewhere]})).await;
        assert_eq!(other["tags"], json!([[]]), "a bare uid never crosses folders");
    }

    /// A move is a removal plus an insertion and the halves can land in either
    /// order, so a removed row is not on its own a reason to forget what
    /// someone wrote about the message.
    #[tokio::test]
    async fn a_message_that_moved_keeps_its_tags_when_the_old_row_goes() {
        let s = st();
        seed_index(&s, "a", "Archive", 4102, "<abc@example.com>");
        let tag = tag_named(&s, "Clients").await;
        let item = json!({"accountId": "a", "mailbox": "INBOX", "uid": 7, "messageId": "<abc@example.com>"});
        call(&s, "tags.assign", json!({"tagId": tag, "items": [item.clone()]})).await;

        // INBOX's row is gone; the Archive copy is the same message.
        let pruned = crate::search_index::prune_metadata(&s.search_index, "a", &["abc@example.com".to_string()]).unwrap();
        assert_eq!(pruned, 0);
        let still = call(&s, "tags.for_messages", json!({"items": [item]})).await;
        assert_eq!(still["tags"], json!([[tag]]));
    }

    #[tokio::test]
    async fn the_last_copy_going_takes_the_tag_assignment_with_it() {
        let s = st();
        seed_index(&s, "a", "INBOX", 7, "<abc@example.com>");
        let tag = tag_named(&s, "Clients").await;
        let item = json!({"accountId": "a", "mailbox": "INBOX", "uid": 7, "messageId": "<abc@example.com>"});
        call(&s, "tags.assign", json!({"tagId": tag, "items": [item.clone()]})).await;
        {
            let guard = mailvault_core::search_index::lock(&s.search_index.db);
            guard.as_ref().unwrap().execute("DELETE FROM messages", []).unwrap();
        }
        let pruned = crate::search_index::prune_metadata(&s.search_index, "a", &["abc@example.com".to_string()]).unwrap();
        assert_eq!(pruned, 1);
        let gone = call(&s, "tags.for_messages", json!({"items": [item]})).await;
        assert_eq!(gone["tags"], json!([[]]));
        assert_eq!(call(&s, "tags.list", json!({})).await[0]["count"], 0, "the tag itself stays");
    }

    #[tokio::test]
    async fn untagging_leaves_the_tag_itself_alone() {
        let s = st();
        let tag = tag_named(&s, "Clients").await;
        let item = json!({"accountId": "a", "mailbox": "INBOX", "uid": 7, "messageId": "<abc@example.com>"});
        call(&s, "tags.assign", json!({"tagId": tag, "items": [item.clone()]})).await;
        let removed = call(&s, "tags.unassign", json!({"tagId": tag, "items": [item]})).await;
        assert_eq!(removed["count"], 1);
        let listed = call(&s, "tags.list", json!({})).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["count"], 0);
    }

    #[tokio::test]
    async fn the_legacy_labels_arrive_keyed_by_the_message_id_the_index_holds() {
        let s = st();
        seed_index(&s, "a", "INBOX", 7, "<abc@example.com>");
        let out = call(
            &s,
            "tags.migrate_legacy",
            json!({
                "labels": [{"id": "L1", "name": "Receipts", "color": "#f00"}],
                "assignments": [{"labelId": "L1", "accountId": "a", "mailbox": "INBOX", "uid": 7}]
            }),
        )
        .await;
        assert_eq!(out["migrated"], 1);
        assert_eq!(out["dropped"], 0);

        // Keyed by identity, so the moved copy of that message carries it.
        let moved = json!({"accountId": "a", "mailbox": "Archive", "uid": 999, "messageId": "<abc@example.com>"});
        let got = call(&s, "tags.for_messages", json!({"items": [moved]})).await;
        let tag_id = call(&s, "tags.list", json!({})).await[0]["id"].as_str().unwrap().to_string();
        assert_eq!(got["tags"], json!([[tag_id]]));
    }

    /// The app rewrites its own quick-action config off this map: a `tag`
    /// quick action stores the label id, and without the mapping every
    /// configured one would point at a label that no longer exists.
    #[tokio::test]
    async fn the_migration_says_which_tag_each_legacy_label_became() {
        let s = st();
        seed_index(&s, "a", "INBOX", 7, "<abc@example.com>");
        let out = call(
            &s,
            "tags.migrate_legacy",
            json!({
                "labels": [{"id": "L1", "name": "Receipts", "color": ""}, {"id": "L2", "name": "Clients", "color": ""}],
                "assignments": []
            }),
        )
        .await;
        let listed = call(&s, "tags.list", json!({})).await;
        let receipts = listed.as_array().unwrap().iter().find(|t| t["name"] == "Receipts").unwrap()["id"].clone();
        assert_eq!(out["tagOfLabel"]["L1"], receipts);
        assert!(out["tagOfLabel"]["L2"].is_string());
    }

    #[tokio::test]
    async fn a_legacy_assignment_the_index_cannot_place_is_dropped_not_guessed() {
        let s = st();
        seed_index(&s, "a", "INBOX", 7, "<abc@example.com>");
        let out = call(
            &s,
            "tags.migrate_legacy",
            json!({
                "labels": [{"id": "L1", "name": "Receipts", "color": ""}],
                "assignments": [{"labelId": "L1", "accountId": "a", "mailbox": "INBOX", "uid": 4242}]
            }),
        )
        .await;
        assert_eq!(out["migrated"], 0);
        assert_eq!(out["dropped"], 1);
        assert_eq!(call(&s, "tags.list", json!({})).await[0]["name"], "Receipts", "the label itself still arrives");
    }

    #[tokio::test]
    async fn two_legacy_labels_that_differ_only_in_case_merge_into_one_tag() {
        let s = st();
        seed_index(&s, "a", "INBOX", 7, "<abc@example.com>");
        call(
            &s,
            "tags.migrate_legacy",
            json!({
                "labels": [{"id": "L1", "name": "Receipts", "color": ""}, {"id": "L2", "name": "receipts", "color": ""}],
                "assignments": [{"labelId": "L2", "accountId": "a", "mailbox": "INBOX", "uid": 7}]
            }),
        )
        .await;
        let listed = call(&s, "tags.list", json!({})).await;
        assert_eq!(listed.as_array().unwrap().len(), 1, "one tag, not a unique-index failure");
        assert_eq!(listed[0]["count"], 1);
    }

    /// Migrating against an index that holds nothing for the account would
    /// drop every assignment and report success, so the app would clear its
    /// legacy store on the strength of it. Refuse instead and let the next
    /// launch retry.
    #[tokio::test]
    async fn migration_refuses_while_the_index_knows_nothing_about_the_account() {
        let s = st();
        let resp = route(
            &s,
            "tags.migrate_legacy",
            &json!({
                "labels": [{"id": "L1", "name": "Receipts", "color": ""}],
                "assignments": [{"labelId": "L1", "accountId": "a", "mailbox": "INBOX", "uid": 7}]
            }),
            json!(1),
        )
        .await
        .expect("routed");
        assert!(resp.result.is_none(), "not a success");
        assert!(format!("{:?}", resp.error).contains("not ready"), "says why: {:?}", resp.error);
    }
}
