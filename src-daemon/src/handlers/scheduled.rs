//! Scheduled Send RPCs. The queue lives in `app.db`
//! (`mailvault_core::app_db::scheduled`); this layer builds the frozen `.eml`
//! at schedule time, writes it into the account's vault `Scheduled` mailbox
//! (`.eml` first, row second — an orphan `.eml` is a stale draft, a row
//! pointing at a uid that was never written is unrepairable), and wakes
//! `scheduled_send_worker` on anything that changes what it should do next.
use crate::custody as daemon_custody;
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg, u64_arg, vault_root, with_mailbox_write};
use crate::ipc::{self, RpcResponse};
use crate::scheduled_send_worker;
use crate::server::DaemonState;
use mailvault_core::app_db::{self, scheduled};
use mailvault_core::custody::cache as sql_cache;
use mailvault_core::imap::ImapConfig;
use mailvault_core::smtp::{self, OutgoingEmail};
use mailvault_core::vault_files;
use serde_json::{json, Value};
use std::sync::Arc;

/// Same early-return shape `vault_files.rs` uses for its required-arg
/// extractors: an `Err(RpcResponse)` here returns straight out of `route`.
macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// The mailbox every frozen schedule lives in — one name, not a param: it is
/// an implementation detail of how this app stores its own drafts, not
/// something the caller chooses.
const MAILBOX: &str = "Scheduled";
const DRAFT_FLAGS: [&str; 3] = ["archived", "seen", "draft"];
/// What `update` answers when an edit arrives for a row that is no longer
/// waiting. The app maps the `E_` code to its catalog (`tErr`).
const NOT_EDITABLE: &str = "E_SCHEDULED_NOT_EDITABLE: This scheduled email is already being sent or is no longer scheduled";

fn account_arg(id: &Value, params: &Value) -> Result<ImapConfig, RpcResponse> {
    params
        .get("account")
        .and_then(|v| serde_json::from_value::<ImapConfig>(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "Missing or invalid account".to_string()))
}

fn email_arg(id: &Value, params: &Value) -> Result<OutgoingEmail, RpcResponse> {
    params
        .get("email")
        .and_then(|v| serde_json::from_value::<OutgoingEmail>(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "Missing or invalid email".to_string()))
}

fn json_of<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// The next uid free in this mailbox, second-resolution like
/// `localDrafts.js`'s `newDraftUid` — this mailbox is written only by this
/// app, one row at a time under `with_mailbox_write`, so a linear probe from
/// "now" is cheap and never races another writer.
fn allocate_uid(root: &std::path::Path, account_id: &str) -> u32 {
    let mut uid = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as u32;
    while vault_files::exists(root, account_id, MAILBOX, uid) {
        uid += 1;
    }
    uid
}

/// What `insert`/the envelope-replace branch of `update` store in the
/// `envelope` column: `smtp::FrozenEnvelope`'s four fields, flattened, plus
/// the Sent-folder append target — see `scheduled_send_worker::StoredEnvelope`,
/// the reader.
fn envelope_json(account: &ImapConfig, email: &OutgoingEmail, sent_mailbox: Option<&str>) -> String {
    json!({
        "from": account.from_address(),
        "to": email.to,
        "cc": email.cc.clone().unwrap_or_default(),
        "bcc": email.bcc.clone().unwrap_or_default(),
        "sentMailbox": sent_mailbox,
    })
    .to_string()
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "scheduled.list" => {
            let account_id = opt_str_arg(params, "accountId");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || app_db::with(&state.app_dir, |c| json_of(scheduled::list(c, account_id.as_deref())?)))
                    .await
                    .and_then(|r| r),
            )
        }

        "scheduled.create" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let account = req!(account_arg(&id, params));
            let email = req!(email_arg(&id, params));
            let local_time = req!(str_arg(&id, params, "localTime"));
            let tz = req!(str_arg(&id, params, "tz"));
            let fire_at = req!(u64_arg(&id, params, "fireAt")) as i64;
            let sent_mailbox = opt_str_arg(params, "sentMailbox");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || create(&state, &account_id, &account, &email, &local_time, &tz, fire_at, sent_mailbox.as_deref()))
                    .await
                    .and_then(|r| r),
            )
        }

        "scheduled.update" => {
            let row_id = req!(str_arg(&id, params, "id"));
            let rebuild = if params.get("account").is_some() || params.get("email").is_some() {
                Some((req!(account_arg(&id, params)), req!(email_arg(&id, params)), opt_str_arg(params, "sentMailbox")))
            } else {
                None
            };
            let reschedule = match (opt_str_arg(params, "localTime"), opt_str_arg(params, "tz"), params.get("fireAt").and_then(Value::as_u64))
            {
                (Some(local_time), Some(tz), Some(fire_at)) => Some((local_time, tz, fire_at as i64)),
                _ => None,
            };
            let state = Arc::clone(state);
            done(id, blocking(move || update(&state, &row_id, rebuild, reschedule)).await.and_then(|r| r))
        }

        "scheduled.cancel" => {
            let row_id = req!(str_arg(&id, params, "id"));
            let state = Arc::clone(state);
            done(id, blocking(move || cancel(&state, &row_id)).await.and_then(|r| r))
        }

        "scheduled.send_now" => {
            let row_id = req!(str_arg(&id, params, "id"));
            send_now(state, &row_id, id.clone()).await
        }

        "scheduled.suggest_tz" => {
            let address = req!(str_arg(&id, params, "address"));
            let state = Arc::clone(state);
            done(id, blocking(move || suggest_tz(&state, address.trim())).await)
        }

        _ => return None,
    })
}

fn create(
    state: &Arc<DaemonState>,
    account_id: &str,
    account: &ImapConfig,
    email: &OutgoingEmail,
    local_time: &str,
    tz: &str,
    fire_at: i64,
    sent_mailbox: Option<&str>,
) -> Result<Value, String> {
    let built = smtp::build_draft_mime(account, email)?;

    // The .eml first, the row second (Global constraint, restated in the
    // plan): an orphan .eml is just a stale draft, a row over a uid that was
    // never written is a permanent failure the user cannot repair.
    // The write nudges the index through the registry's change hook.
    let uid = with_mailbox_write(state, account_id, MAILBOX, |root| {
        let uid = allocate_uid(root, account_id);
        vault_files::store(&state.vault_registry, root, account_id, MAILBOX, uid, &built.raw_rfc2822, &DRAFT_FLAGS.map(String::from), true)?;
        Ok(uid)
    })?;

    let row_id = uuid::Uuid::new_v4().to_string();
    let envelope = envelope_json(account, email, sent_mailbox);
    app_db::with(&state.app_dir, |c| scheduled::insert(c, &row_id, account_id, MAILBOX, uid, &envelope, local_time, tz, fire_at))?;

    state.scheduled_send.wake();
    let row = app_db::with(&state.app_dir, |c| scheduled::get(c, &row_id))?
        .ok_or_else(|| "row vanished after insert".to_string())?;
    json_of(row)
}

/// Reschedule and/or replace the frozen message. Either half is optional —
/// `rebuild` replaces the `.eml` in place (same uid, `vault_files::store`'s
/// `overwrite` semantics) and its envelope, `reschedule` changes
/// `local_time`/`tz`/`fire_at` — and a caller may pass both in one call.
///
/// A rebuild is someone saving an edited scheduled email, which may have
/// fired while they typed. It holds the worker's own in-flight claim from the
/// status check to the last write, so the worker cannot start sending half
/// way through, and it refuses a row the worker holds or has already moved on
/// from: a fresh `.eml` under a `sent` row is a message that never goes out
/// behind a reply that says it was saved.
fn update(
    state: &Arc<DaemonState>,
    row_id: &str,
    rebuild: Option<(ImapConfig, OutgoingEmail, Option<String>)>,
    reschedule: Option<(String, String, i64)>,
) -> Result<Value, String> {
    let _claim = if rebuild.is_some() {
        Some(state.scheduled_send.claim(row_id).ok_or_else(|| NOT_EDITABLE.to_string())?)
    } else {
        None
    };
    let existing = app_db::with(&state.app_dir, |c| scheduled::get(c, row_id))?
        .ok_or_else(|| format!("No scheduled send {row_id}"))?;
    if rebuild.is_some() && !matches!(existing.status.as_str(), "queued" | "failed") {
        return Err(NOT_EDITABLE.to_string());
    }

    if let Some((account, email, sent_mailbox)) = rebuild {
        let built = smtp::build_draft_mime(&account, &email)?;
        with_mailbox_write(state, &existing.account_id, &existing.mailbox, |root| {
            vault_files::store(&state.vault_registry, root, &existing.account_id, &existing.mailbox, existing.uid, &built.raw_rfc2822, &DRAFT_FLAGS.map(String::from), true)
                .map(|_| ())
        })?;
        let envelope = envelope_json(&account, &email, sent_mailbox.as_deref());
        app_db::with(&state.app_dir, |c| {
            c.execute("UPDATE scheduled_sends SET envelope = ?2 WHERE id = ?1", rusqlite::params![row_id, envelope])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })?;
    }

    if let Some((local_time, tz, fire_at)) = reschedule {
        app_db::with(&state.app_dir, |c| scheduled::update_schedule(c, row_id, &local_time, &tz, fire_at))?;
    }

    state.scheduled_send.wake();
    let row = app_db::with(&state.app_dir, |c| scheduled::get(c, row_id))?
        .ok_or_else(|| "row vanished during update".to_string())?;
    json_of(row)
}

/// Mark cancelled and remove the frozen `.eml`. Best-effort on the file: a
/// schedule already sent (or a previous cancel that failed midway through)
/// leaves nothing there to remove, and that is not this call's problem.
fn cancel(state: &Arc<DaemonState>, row_id: &str) -> Result<Value, String> {
    let Some(row) = app_db::with(&state.app_dir, |c| scheduled::get(c, row_id))? else {
        return Ok(Value::Null);
    };
    let _ = with_mailbox_write(state, &row.account_id, &row.mailbox, |root| {
        Ok(vault_files::delete(&state.vault_registry, root, &row.account_id, &row.mailbox, row.uid).unwrap_or(false))
    });
    app_db::with(&state.app_dir, |c| scheduled::cancel(c, row_id))?;
    Ok(Value::Null)
}

/// Facts for the app's timezone suggestion for a recipient, not a zone:
/// picking one needs `Intl`'s DST rules, which live in the app. Each half is
/// best-effort on its own, so a closed custody store (a vault mid-move) still
/// answers with the remembered zone, and an unknown address is all nulls,
/// never an error. No `@`, no lookup: an empty address would LIKE-match
/// every row.
fn suggest_tz(state: &Arc<DaemonState>, address: &str) -> Value {
    let lookup = address.contains('@');
    let clock = lookup
        .then(|| {
            vault_root(state).and_then(|_| daemon_custody::with_conn(state, |c| sql_cache::sender_clock(c, address))).ok().flatten()
        })
        .flatten();
    let remembered =
        lookup.then(|| app_db::with(&state.app_dir, |c| scheduled::last_tz_for(c, address)).ok().flatten()).flatten();
    json!({
        "headerOffsetMinutes": clock.map(|(offset, _)| offset),
        "headerDateMs": clock.and_then(|(_, at)| at),
        "rememberedTz": remembered,
    })
}

/// Fire immediately, through `scheduled_send_worker::attempt_row` — the exact
/// same send path the periodic worker uses, not a second one that could
/// drift from it.
async fn send_now(state: &Arc<DaemonState>, row_id: &str, id: Value) -> RpcResponse {
    let app_dir = state.app_dir.clone();
    let lookup_id = row_id.to_string();
    let row = match blocking(move || app_db::with(&app_dir, |c| scheduled::get(c, &lookup_id))).await {
        Ok(Ok(Some(row))) => row,
        Ok(Ok(None)) => return RpcResponse::error(id, ipc::INVALID_PARAMS, format!("No scheduled send {row_id}")),
        Ok(Err(e)) | Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    };
    if !matches!(row.status.as_str(), "queued" | "failed") {
        return RpcResponse::error(id, ipc::INVALID_PARAMS, format!("Cannot send a schedule that is {}", row.status));
    }

    scheduled_send_worker::attempt_row(state, &row).await;

    let app_dir = state.app_dir.clone();
    let final_id = row.id.clone();
    match blocking(move || app_db::with(&app_dir, |c| scheduled::get(c, &final_id))).await {
        Ok(Ok(Some(updated))) => match json_of(updated) {
            Ok(v) => RpcResponse::success(id, v),
            Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
        },
        Ok(Ok(None)) => RpcResponse::error(id, ipc::INTERNAL_ERROR, "row vanished after send".to_string()),
        Ok(Err(e)) | Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::{MockImap, Scenario};
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-scheduled-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    fn account_json() -> Value {
        json!({"email": "luke@mock.test", "imapHost": "imap.mock.test"})
    }

    fn email_json() -> Value {
        json!({"to": "partner@example.com", "subject": "Later", "text": "body"})
    }

    fn create_params(account_id: &str) -> Value {
        json!({
            "accountId": account_id,
            "account": account_json(),
            "email": email_json(),
            "localTime": "2026-10-01T09:00",
            "tz": "Europe/Vilnius",
            "fireAt": 9_999_999_999_999i64,
        })
    }

    /// Registration guard, same reason `tags.rs`'s equivalent test gives: a
    /// module never wired into `server::handle_request` answers "Unknown
    /// method" to an app that otherwise looks entirely healthy.
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "scheduled.list", json!({})).await;
        assert!(resp.result.is_some(), "scheduled.list is not routed: {:?}", resp.error);
        let resp = crate::server::handle_request_for_test(&s, "scheduled.suggest_tz", json!({"address": "x@example.com"})).await;
        assert!(resp.result.is_some(), "scheduled.suggest_tz is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn create_writes_the_eml_before_the_row_and_lists_it_queued() {
        let s = st();
        let row = call(&s, "scheduled.create", create_params("acc1")).await;
        assert_eq!(row["status"], json!("queued"));
        assert_eq!(row["accountId"], json!("acc1"));
        assert_eq!(row["mailbox"], json!("Scheduled"));
        let uid = row["uid"].as_u64().unwrap() as u32;
        assert!(
            mailvault_core::vault_files::exists(&s.data_dir, "acc1", "Scheduled", uid),
            "the frozen .eml must exist once the row does"
        );

        let listed = call(&s, "scheduled.list", json!({"accountId": "acc1"})).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["id"], row["id"]);
    }

    #[tokio::test]
    async fn cancel_marks_the_row_cancelled_and_removes_the_frozen_eml() {
        let s = st();
        let row = call(&s, "scheduled.create", create_params("acc1")).await;
        let uid = row["uid"].as_u64().unwrap() as u32;
        let id = row["id"].as_str().unwrap().to_string();

        call(&s, "scheduled.cancel", json!({"id": id})).await;

        let stored = mailvault_core::app_db::with(&s.app_dir, |c| mailvault_core::app_db::scheduled::get(c, &id))
            .unwrap()
            .expect("the row itself is kept, only marked cancelled");
        assert_eq!(stored.status, "cancelled");
        assert!(
            !mailvault_core::vault_files::exists(&s.data_dir, "acc1", "Scheduled", uid),
            "a cancelled row's frozen .eml must be removed"
        );
    }

    #[tokio::test]
    async fn cancelling_an_unknown_id_is_a_quiet_no_op() {
        let s = st();
        let result = route(&s, "scheduled.cancel", &json!({"id": "nope"}), json!(1)).await.expect("routed");
        assert!(result.result.is_some(), "an already-gone row is not an error: {:?}", result.error);
    }

    /// The mock server cannot pretend to be a second daemon process — this
    /// test proves `send_now` calls the same worker path a restart's
    /// catch-up pass would, by giving it nothing BUT what a restart would
    /// have: an account resolved via `credentials::resolve_account_credentials`
    /// (the `MAILVAULT_TEST_CREDENTIALS` file bypass here), not the `account`
    /// object `scheduled.create` was given.
    #[tokio::test]
    async fn create_then_send_now_delivers_and_cleans_up() {
        let _env_guard = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");

        let server = MockImap::start(Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")));
        let s = st();

        let creds_path = s.app_dir.join("credentials.json");
        let account_json = json!({
            "email": "luke@mock.test",
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
            "smtpHost": server.host(),
            "smtpPort": server.smtp_port(),
            "smtpSecure": false,
        })
        .to_string();
        let mut blob = std::collections::HashMap::new();
        blob.insert("acc1".to_string(), account_json);
        std::fs::write(&creds_path, serde_json::to_string(&blob).unwrap()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds_path);

        let mut params = create_params("acc1");
        params["sentMailbox"] = json!("Sent");
        let row = call(&s, "scheduled.create", params).await;
        let uid = row["uid"].as_u64().unwrap() as u32;
        let id = row["id"].as_str().unwrap().to_string();

        let sent = call(&s, "scheduled.send_now", json!({"id": id})).await;

        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        // The two PLAINTEXT vars are deliberately NOT removed. They are
        // process-global, and this is the only test in the daemon binary that
        // ever cleared them — every other one (`handlers::smtp`, `imap`,
        // `archive`, `restore`, `migration`, `mail_search`, `sync_engine`,
        // `server`, `idle_watch`) only ever sets them, and none of them takes
        // `test_env_lock`. So clearing them here yanked loopback TLS relaxation
        // out from under whichever of those happened to be running in parallel,
        // and the four `handlers::smtp` tests failed with the RPC erroring out.
        // Green alone, red in the suite, and only once the test count crossed
        // some scheduling threshold. Leaving them set is harmless: they only
        // relax TLS for loopback, inside this test binary, and every other test
        // wants them set anyway.

        assert_eq!(sent["status"], json!("sent"), "row: {sent:?}");
        assert_eq!(server.sent_messages().len(), 1, "commands: {:?}", server.smtp_commands());
        assert!(
            !mailvault_core::vault_files::exists(&s.data_dir, "acc1", "Scheduled", uid),
            "a sent row's frozen .eml must be removed"
        );
    }

    fn edit_params(id: &str, to: &str) -> Value {
        json!({
            "id": id,
            "account": account_json(),
            "email": {"to": to, "subject": "Later, edited", "text": "edited body"},
            "localTime": "2026-10-02T10:00",
            "tz": "Europe/Vilnius",
            "fireAt": 9_999_999_999_999i64,
        })
    }

    fn frozen_bytes(s: &Arc<DaemonState>, uid: u32) -> Option<String> {
        mailvault_core::vault_files::read_raw_source(&s.data_dir, "acc1", "Scheduled", uid).ok()
    }

    fn stored(s: &Arc<DaemonState>, id: &str) -> mailvault_core::app_db::scheduled::ScheduledSend {
        mailvault_core::app_db::with(&s.app_dir, |c| mailvault_core::app_db::scheduled::get(c, id)).unwrap().unwrap()
    }

    /// Saving an edit replaces the row's message and envelope in place: same
    /// id, same uid, new recipients and time.
    #[tokio::test]
    async fn an_edit_replaces_a_queued_rows_message_and_time() {
        let s = st();
        let row = call(&s, "scheduled.create", create_params("acc1")).await;
        let id = row["id"].as_str().unwrap().to_string();
        let uid = row["uid"].as_u64().unwrap() as u32;
        let before = frozen_bytes(&s, uid).expect("frozen .eml");

        let updated = call(&s, "scheduled.update", edit_params(&id, "someone.else@example.com")).await;

        assert_eq!(updated["id"], json!(id));
        assert_eq!(updated["uid"], json!(uid));
        assert_eq!(updated["status"], json!("queued"));
        assert_eq!(updated["localTime"], json!("2026-10-02T10:00"));
        assert!(stored(&s, &id).envelope.contains("someone.else@example.com"), "the envelope must carry the new recipient");
        assert_ne!(frozen_bytes(&s, uid).expect("frozen .eml"), before, "the .eml must be the edited message");
    }

    /// A row that fired while the user was editing: the edit is refused with
    /// the code the app maps to a catalog key, and nothing is rewritten.
    #[tokio::test]
    async fn an_edit_of_a_sent_or_cancelled_row_is_refused_and_writes_nothing() {
        let s = st();
        let row = call(&s, "scheduled.create", create_params("acc1")).await;
        let id = row["id"].as_str().unwrap().to_string();
        let uid = row["uid"].as_u64().unwrap() as u32;
        let before = frozen_bytes(&s, uid);
        mailvault_core::app_db::with(&s.app_dir, |c| mailvault_core::app_db::scheduled::set_status(c, &id, "sent", "")).unwrap();

        let resp = route(&s, "scheduled.update", &edit_params(&id, "x@example.com"), json!(1)).await.expect("routed");
        let err = resp.error.expect("an edit of a sent row must be refused").message;
        assert!(err.starts_with("E_SCHEDULED_NOT_EDITABLE:"), "{err}");
        assert_eq!(frozen_bytes(&s, uid), before, "a refused edit must not rewrite the .eml");
        let after = stored(&s, &id);
        assert_eq!(after.status, "sent");
        assert!(!after.envelope.contains("x@example.com"));

        let cancelled = call(&s, "scheduled.create", create_params("acc1")).await;
        let cid = cancelled["id"].as_str().unwrap().to_string();
        call(&s, "scheduled.cancel", json!({"id": cid})).await;
        let resp = route(&s, "scheduled.update", &edit_params(&cid, "x@example.com"), json!(1)).await.expect("routed");
        assert!(resp.error.expect("an edit of a cancelled row must be refused").message.starts_with("E_SCHEDULED_NOT_EDITABLE:"));
        assert_eq!(stored(&s, &cid).status, "cancelled", "a refused edit must not re-arm the row");
    }

    /// The worker holds the claim for as long as it is sending: an edit that
    /// arrives then is refused rather than written under a send in progress.
    #[tokio::test]
    async fn an_edit_while_the_worker_holds_the_row_is_refused() {
        let s = st();
        let row = call(&s, "scheduled.create", create_params("acc1")).await;
        let id = row["id"].as_str().unwrap().to_string();
        let uid = row["uid"].as_u64().unwrap() as u32;
        let before = frozen_bytes(&s, uid);

        let held = s.scheduled_send.claim(&id).expect("free");
        let resp = route(&s, "scheduled.update", &edit_params(&id, "x@example.com"), json!(1)).await.expect("routed");
        assert!(resp.error.expect("refused while claimed").message.starts_with("E_SCHEDULED_NOT_EDITABLE:"));
        assert_eq!(frozen_bytes(&s, uid), before);
        drop(held);

        call(&s, "scheduled.update", edit_params(&id, "x@example.com")).await;
        assert!(s.scheduled_send.claim(&id).is_some(), "the edit must release the claim when it is done");
    }

    /// The worker reads a whole `due()` batch, then sends it row by row. A
    /// row cancelled while the rows ahead of it were sending must stay
    /// cancelled, not be flipped to `sending` from the stale batch copy.
    #[tokio::test]
    async fn the_worker_does_not_send_a_stale_copy_of_a_cancelled_row() {
        let s = st();
        let row = call(&s, "scheduled.create", create_params("acc1")).await;
        let id = row["id"].as_str().unwrap().to_string();
        let stale = stored(&s, &id);
        call(&s, "scheduled.cancel", json!({"id": id})).await;

        crate::scheduled_send_worker::attempt_row(&s, &stale).await;

        let after = stored(&s, &id);
        assert_eq!(after.status, "cancelled");
        assert_eq!(after.attempts, 0, "a skipped row must not count as a try");
    }

    /// The facts behind the compose timezone suggestion: the offset of the
    /// newest message the recipient sent us, and the zone last used when
    /// scheduling to them, whatever case and spacing the app sends.
    #[tokio::test]
    async fn suggest_tz_reports_the_senders_offset_and_the_zone_last_used_for_them() {
        let s = st();
        call(&s, "scheduled.create", create_params("acc1")).await;
        let headers = json!({"emails": [{"uid": 5, "from": {"name": "Partner", "address": "partner@example.com"},
            "date": "Tue, 14 Jul 2026 12:00:00 -0400"}]})
        .to_string();
        crate::custody::with_conn(&s, |c| mailvault_core::custody::cache::save_headers(c, "acc1", "INBOX", &headers)).unwrap();

        let facts = call(&s, "scheduled.suggest_tz", json!({"address": " Partner@Example.com "})).await;
        assert_eq!(facts["headerOffsetMinutes"], json!(-240));
        assert_eq!(facts["headerDateMs"], json!(1_784_044_800_000i64), "2026-07-14 16:00 UTC");
        assert_eq!(facts["rememberedTz"], json!("Europe/Vilnius"));

        let none = json!({"headerOffsetMinutes": null, "headerDateMs": null, "rememberedTz": null});
        assert_eq!(call(&s, "scheduled.suggest_tz", json!({"address": "stranger@example.com"})).await, none);
        assert_eq!(call(&s, "scheduled.suggest_tz", json!({"address": ""})).await, none, "no address, no lookup");
    }

    #[tokio::test]
    async fn send_now_on_an_already_sent_row_is_refused() {
        let s = st();
        let row = call(&s, "scheduled.create", create_params("acc1")).await;
        let id = row["id"].as_str().unwrap().to_string();
        mailvault_core::app_db::with(&s.app_dir, |c| mailvault_core::app_db::scheduled::set_status(c, &id, "sent", "")).unwrap();

        let resp = route(&s, "scheduled.send_now", &json!({"id": id}), json!(1)).await.expect("routed");
        assert!(resp.result.is_none(), "a sent row must not be resent");
    }
}
