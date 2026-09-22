//! Auto Tags RPCs (Phase 4): natural-language rules that assign an existing
//! tag. The deterministic prefilter (`constraints`) and the model's verdict
//! format live in `mailvault_core::app_db::auto_tags`, unit-tested there with
//! no daemon, no model and no network involved.
//!
//! `evaluate` below is the single place a rule's instruction is ever run
//! against a model — preview and backfill both call it, so the privacy
//! opt-in (`allow_remote`) can never be skipped by a future caller of this
//! module. This module never imports `vault_files` or an IMAP session, and
//! never should: `inbox_action: hide` is a stored fact the app's views layer
//! reads to filter a row out of the Inbox locally — nothing about "auto tag"
//! is allowed to move or delete mail.
use crate::handlers::common::{blocking, done, MessageRef};
use crate::inference;
use crate::ipc::RpcResponse;
use crate::llm::{self, Provider};
use crate::server::DaemonState;
use mailvault_core::app_db::{self, auto_tags, tags::Target};
use mailvault_core::custody::cache;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("auto_tags.") {
        return None;
    }
    match method {
        "auto_tags.preview" => Some(done(id, run_preview(state, params).await)),
        "auto_tags.backfill" => Some(done(id, run_backfill(state, params).await)),
        _ => {
            let app_dir = state.app_dir.clone();
            let params = params.clone();
            let method = method.to_string();
            Some(done(id, blocking(move || run_sync(&app_dir, &method, &params)).await.and_then(|r| r)))
        }
    }
}

fn arg(params: &Value, name: &str) -> Result<String, String> {
    params.get(name).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| format!("Missing {name}"))
}

fn json_of<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn draft_of(params: &Value) -> Result<auto_tags::RuleDraft, String> {
    serde_json::from_value(params.get("rule").cloned().unwrap_or(Value::Null)).map_err(|e| format!("rule: {e}"))
}

fn provider_of(params: &Value) -> Result<Provider, String> {
    serde_json::from_value(params.get("provider").cloned().unwrap_or(Value::Null)).map_err(|e| format!("provider: {e}"))
}

pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// `auto_tags.list` / `.create` / `.update` / `.delete` / `.undo_backfill` —
/// every method that only ever touches `app.db`, none of it async.
fn run_sync(app_dir: &std::path::Path, method: &str, params: &Value) -> Result<Value, String> {
    app_db::with(app_dir, |conn| match method {
        "auto_tags.list" => json_of(auto_tags::list(conn)?),
        "auto_tags.create" => json_of(auto_tags::create(conn, draft_of(params)?)?),
        "auto_tags.update" => {
            let id = arg(params, "id")?;
            json_of(auto_tags::update(conn, &id, draft_of(params)?)?)
        }
        "auto_tags.delete" => auto_tags::delete(conn, &arg(params, "id")?).map(|_| Value::Null),
        "auto_tags.undo_backfill" => undo_backfill(conn, &arg(params, "batchId")?),
        _ => Err(format!("Unknown method: {method}")),
    })
}

/// Unassign exactly what one backfill batch assigned, then forget the batch.
/// The tag comes from the batch's own frozen `tag_id`, never the rule's
/// current one — a rule's tag can be repointed after a backfill runs, and
/// undo must still remove what THAT batch actually assigned. A batch id
/// nobody recognizes (already undone, or never existed) unassigns nothing
/// rather than erroring — undo is idempotent.
fn undo_backfill(conn: &app_db::Connection, batch_id: &str) -> Result<Value, String> {
    let Some((_rule_id, tag_id, targets)) = auto_tags::backfill_batch(conn, batch_id)? else {
        return Ok(json!({ "unassigned": 0 }));
    };
    let unassigned = mailvault_core::app_db::tags::unassign(conn, &tag_id, &targets)?;
    auto_tags::delete_backfill_batch(conn, batch_id)?;
    Ok(json!({ "unassigned": unassigned }))
}

/// The one place a rule's instruction is ever run against a model — preview,
/// backfill AND the standing worker (`auto_tag_worker.rs`) all call this,
/// never `llm::generate` directly. Checks the privacy opt-in BEFORE building
/// any request — an `Endpoint` provider on a rule without `allow_remote`
/// never reaches `llm::generate` at all, so it can never construct a
/// `reqwest::Client` or send anything anywhere.
pub(crate) async fn evaluate(
    provider: &Provider,
    inference: &inference::InferenceEngine,
    rule: &auto_tags::Rule,
    candidate: &auto_tags::Candidate,
) -> Result<auto_tags::Verdict, String> {
    if matches!(provider, Provider::Endpoint { .. }) && !rule.allow_remote {
        return Err("this rule does not allow a remote provider (allow_remote is false)".to_string());
    }
    let prompt = auto_tags::verdict_prompt(&rule.instruction, candidate);
    let text = llm::generate(provider, inference, &prompt, Some(auto_tags::VERDICT_SYSTEM_PROMPT), 32).await?;
    auto_tags::parse_verdict(&text)
}

/// The provider the STANDING worker evaluates `rule` through: whatever JSON
/// the rule itself carries, or on-device (`LocalGguf`) — the privacy
/// default — when that JSON is absent or unrecognized. `.preview`/
/// `.backfill` never call this; a caller of those RPCs is present to hand a
/// provider over each time (`provider_of`), which is what lets a rule be
/// tried against a different provider before it is ever saved.
pub(crate) fn provider_from_rule(rule: &auto_tags::Rule) -> Provider {
    serde_json::from_value(rule.provider.clone()).unwrap_or(Provider::LocalGguf)
}

/// Whether a verdict — or the refusal `evaluate` produced instead of one —
/// should result in a tag assignment. A refusal (unparseable text, a remote
/// provider not allowed, a network error) is never a match, exactly like a
/// plain `NoMatch` or a `Match` below the rule's own threshold: only a clean
/// `Ok(Match(c >= min_confidence))` ever assigns.
pub(crate) fn should_assign(verdict: &Result<auto_tags::Verdict, String>, min_confidence: f64) -> bool {
    matches!(verdict, Ok(v) if auto_tags::meets_threshold(*v, min_confidence))
}

/// One cached header, paired with the identity a tag assignment needs.
pub(crate) struct HeaderCandidate {
    pub(crate) msg_ref: MessageRef,
    pub(crate) subject: String,
    pub(crate) from: String,
    pub(crate) candidate: auto_tags::Candidate,
}

/// The last `limit` cached headers for `account_id`, across every mailbox,
/// newest first — "the last N cached headers" the spec previews/backfills
/// over, and what the worker treats as its own bounded catch-up scan.
/// Bounding BEFORE the prefilter (rather than after) is what the limit
/// actually means: a fixed-size, predictable read no matter how selective the
/// rule's constraints turn out to be.
pub(crate) fn load_candidates(state: &DaemonState, account_id: &str, limit: usize) -> Vec<HeaderCandidate> {
    let read = crate::custody::with_conn(state, |conn| {
        let mut out = Vec::new();
        for (_, mailbox) in cache::mailboxes_with_headers(conn, Some(account_id))? {
            for header in cache::all_headers(conn, account_id, &mailbox)? {
                out.push(header_candidate(&header, &mailbox, account_id));
            }
        }
        Ok(out)
    });
    let mut out: Vec<HeaderCandidate> = read.unwrap_or_default();
    out.sort_by(|a, b| b.candidate.date.cmp(&a.candidate.date));
    out.truncate(limit);
    out
}

/// One cached header row → an evaluation candidate. Mirrors
/// `classification_worker::email_from_header`'s field reads (same header
/// cache, same JSON shape) — kept separate because that function also fills
/// in classification-only fields (`to_count`, `in_reply_to`, ...) this rule
/// prefilter never uses.
fn header_candidate(val: &Value, mailbox: &str, account_id: &str) -> HeaderCandidate {
    let uid = val.get("uid").and_then(Value::as_u64).unwrap_or(0) as u32;
    let message_id = val.get("messageId").and_then(Value::as_str).map(String::from);
    let subject = val.get("subject").and_then(Value::as_str).unwrap_or("").to_string();
    let from_addr = val.get("from").and_then(|f| f.get("address")).and_then(Value::as_str).unwrap_or("");
    let from_name = val.get("from").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
    let from = if from_name.is_empty() { from_addr.to_string() } else { format!("{from_name} <{from_addr}>") };
    let has_attachments = val.get("hasAttachments").and_then(Value::as_bool).unwrap_or(false);
    let list_id = val.get("listId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    let date = val.get("date").and_then(Value::as_str).and_then(|d| mailparse::dateparse(d).ok()).unwrap_or(0);
    HeaderCandidate {
        msg_ref: MessageRef { account_id: account_id.to_string(), mailbox: mailbox.to_string(), uid, message_id },
        subject: subject.clone(),
        from: from.clone(),
        candidate: auto_tags::Candidate { from, subject, mailbox: mailbox.to_string(), has_attachments, list_id, date },
    }
}

/// A saved rule (`ruleId`) or one handed over inline (`rule`) — how "preview
/// this before you've even saved it" previews at all. Backfill only ever
/// takes the saved form (`run_backfill` requires `ruleId`): a batch has to
/// point undo at a real row in `auto_tag_rules`.
async fn rule_for_eval(state: &Arc<DaemonState>, params: &Value) -> Result<auto_tags::Rule, String> {
    if let Some(rule_id) = params.get("ruleId").and_then(Value::as_str) {
        let rule_id = rule_id.to_string();
        let app_dir = state.app_dir.clone();
        let rid = rule_id.clone();
        let found = blocking(move || app_db::with(&app_dir, |conn| auto_tags::get(conn, &rid))).await.and_then(|r| r)?;
        return found.ok_or_else(|| format!("no such auto-tag rule: {rule_id}"));
    }
    let draft = draft_of(params)?;
    Ok(auto_tags::Rule {
        id: String::new(),
        name: draft.name,
        instruction: draft.instruction,
        constraints: draft.constraints,
        tag_id: draft.tag_id,
        inbox_action: draft.inbox_action,
        min_confidence: draft.min_confidence,
        allow_remote: draft.allow_remote,
        provider: draft.provider,
        enabled: draft.enabled,
        enabled_at: None,
        created_at: 0,
        updated_at: 0,
    })
}

/// Run a rule over the last N cached headers WITHOUT writing anything —
/// what the app shows before "enable" is ever pressed.
async fn run_preview(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account_id = arg(params, "accountId")?;
    let provider = provider_of(params)?;
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
    let rule = rule_for_eval(state, params).await?;

    let state_clone = Arc::clone(state);
    let account = account_id.clone();
    let candidates = blocking(move || load_candidates(&state_clone, &account, limit)).await?;

    let now = now_secs();
    let mut rows = Vec::new();
    for c in candidates {
        if !auto_tags::passes(&rule.constraints, &c.candidate, now) {
            continue;
        }
        let verdict = evaluate(&provider, &state.inference, &rule, &c.candidate).await;
        let matched = should_assign(&verdict, rule.min_confidence);
        let (confidence, refused) = match &verdict {
            Ok(auto_tags::Verdict::Match(c)) => (Some(*c), None),
            Ok(auto_tags::Verdict::NoMatch) => (None, None),
            Err(e) => (None, Some(e.clone())),
        };
        rows.push(json!({
            "accountId": c.msg_ref.account_id,
            "mailbox": c.msg_ref.mailbox,
            "uid": c.msg_ref.uid,
            "messageId": c.msg_ref.message_id,
            "subject": c.subject,
            "from": c.from,
            "matched": matched,
            "confidence": confidence,
            "refused": refused,
        }));
    }
    Ok(json!({ "candidates": rows }))
}

/// Bounded, one-shot backfill: evaluate the rule over its last N cached
/// headers and assign the tag to everything that clears the threshold,
/// recording a batch so it can be undone. Runs to completion inline, which is
/// what makes it the explicit action: mail arriving from now on is handled by
/// `auto_tag_worker`, which sweeps enabled rules and calls straight back into
/// `evaluate` above, so history is only ever touched by someone pressing this.
async fn run_backfill(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account_id = arg(params, "accountId")?;
    let provider = provider_of(params)?;
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
    let rule_id = arg(params, "ruleId")?;

    let app_dir = state.app_dir.clone();
    let rid = rule_id.clone();
    let rule = blocking(move || app_db::with(&app_dir, |conn| auto_tags::get(conn, &rid)))
        .await
        .and_then(|r| r)?
        .ok_or_else(|| format!("no such auto-tag rule: {rule_id}"))?;

    let state_clone = Arc::clone(state);
    let account = account_id.clone();
    let candidates = blocking(move || load_candidates(&state_clone, &account, limit)).await?;

    let batch_id = uuid::Uuid::new_v4().to_string();
    let now = now_secs();
    let total = candidates.len();
    let mut processed = 0usize;
    let mut matched = 0usize;
    let mut targets: Vec<Target> = Vec::new();

    for c in candidates {
        processed += 1;
        if auto_tags::passes(&rule.constraints, &c.candidate, now) {
            let verdict = evaluate(&provider, &state.inference, &rule, &c.candidate).await;
            if should_assign(&verdict, rule.min_confidence) {
                matched += 1;
                targets.push(c.msg_ref.target());
            }
        }
        // Every 10 messages and on the last one — frequent enough to feel
        // live, rare enough not to spam the event bus over a 200-message run.
        if processed % 10 == 0 || processed == total {
            state.events.emit(
                "auto-tag-backfill-progress",
                json!({ "batchId": batch_id, "ruleId": rule.id, "processed": processed, "total": total, "matched": matched }),
            );
        }
    }

    let app_dir = state.app_dir.clone();
    let rule_id_for_batch = rule.id.clone();
    let tag_id = rule.tag_id.clone();
    let batch_for_write = batch_id.clone();
    let assigned = blocking(move || {
        app_db::with(&app_dir, |conn| {
            // Only what this batch NEWLY tagged is recorded, so undoing it
            // can never strip a tag a message already carried going in.
            let newly = exclude_already_tagged(conn, &tag_id, targets)?;
            mailvault_core::app_db::tags::assign(conn, &tag_id, &newly)?;
            auto_tags::record_backfill(conn, &batch_for_write, &rule_id_for_batch, &tag_id, &newly)?;
            Ok(newly.len())
        })
    })
    .await
    .and_then(|r| r)?;

    state.events.emit(
        "auto-tag-backfill-complete",
        json!({ "batchId": batch_id, "ruleId": rule.id, "processed": processed, "total": total, "matched": matched, "assigned": assigned }),
    );
    Ok(json!({ "batchId": batch_id, "processed": processed, "total": total, "matched": matched, "assigned": assigned }))
}

/// `targets` minus whichever of them already carry `tag_id` — so a backfill's
/// own undo can never remove a tag the message carried before it ran.
fn exclude_already_tagged(conn: &app_db::Connection, tag_id: &str, targets: Vec<Target>) -> Result<Vec<Target>, String> {
    let mut per_account: HashMap<String, Vec<String>> = HashMap::new();
    for t in &targets {
        per_account.entry(t.account_id.clone()).or_default().push(t.msg_key.clone());
    }
    let mut already: HashSet<(String, String)> = HashSet::new();
    for (account_id, keys) in per_account {
        for (msg_key, tag_ids) in mailvault_core::app_db::tags::for_messages(conn, &account_id, &keys)? {
            if tag_ids.iter().any(|t| t == tag_id) {
                already.insert((account_id.clone(), msg_key));
            }
        }
    }
    Ok(targets.into_iter().filter(|t| !already.contains(&(t.account_id.clone(), t.msg_key.clone()))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-autotags-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    async fn call_err(s: &Arc<DaemonState>, method: &str, params: Value) -> String {
        let resp = route(s, method, &params, json!(1)).await.expect("routed");
        resp.error.map(|e| e.message).unwrap_or_else(|| panic!("{method} was expected to fail"))
    }

    /// `for_test(dir, dir, true)` already opens the custody store over that
    /// dir (same idiom `classification_worker.rs`'s own tests use) — no
    /// second connection or lock swap needed.
    fn seed_header(s: &Arc<DaemonState>, account: &str, mailbox: &str, uid: u32, subject: &str, from: &str, has_attachments: bool) {
        let header = json!({
            "uid": uid, "subject": subject, "from": {"address": from},
            "date": "2026-08-01T00:00:00Z", "hasAttachments": has_attachments,
        });
        crate::custody::with_conn(s, |conn| cache::save_headers(conn, account, mailbox, &json!({"emails": [header]}).to_string()))
            .unwrap();
    }

    /// `tags.*` is a sibling router, not `auto_tags::route` — go straight to
    /// it rather than through this module's `call()`, which only ever
    /// dispatches `auto_tags.*`.
    async fn tag_count(s: &Arc<DaemonState>) -> i64 {
        let listed = crate::handlers::tags::route(s, "tags.list", &json!({}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("tags.list");
        listed[0]["count"].as_i64().unwrap()
    }

    async fn tag_named(s: &Arc<DaemonState>, name: &str) -> String {
        crate::handlers::tags::route(s, "tags.ensure", &json!({"name": name, "color": ""}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("ensure")["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn rule_json(tag_id: &str, allow_remote: bool) -> Value {
        json!({
            "name": "Receipts", "instruction": "receipts and invoices", "constraints": {},
            "tagId": tag_id, "inboxAction": "keep", "minConfidence": 0.7,
            "allowRemote": allow_remote, "enabled": false,
        })
    }

    /// Registration guard, not a behaviour test: reached through
    /// `server::handle_request`, an unwired module answers "Unknown method"
    /// to an app that looks entirely healthy otherwise.
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        let resp = crate::server::handle_request_for_test(&s, "auto_tags.list", json!({})).await;
        assert!(resp.result.is_some(), "auto_tags.list is not routed: {:?}", resp.error);
    }

    #[tokio::test]
    async fn a_rule_round_trips_through_create_update_and_delete() {
        let s = st();
        let tag = tag_named(&s, "Receipts").await;
        let created = call(&s, "auto_tags.create", json!({"rule": rule_json(&tag, false)})).await;
        assert_eq!(created["name"], "Receipts");
        assert_eq!(created["enabled"], false);

        let id = created["id"].as_str().unwrap();
        let mut edited = rule_json(&tag, false);
        edited["enabled"] = json!(true);
        let updated = call(&s, "auto_tags.update", json!({"id": id, "rule": edited})).await;
        assert_eq!(updated["enabled"], true);
        assert_eq!(updated["id"], id);

        call(&s, "auto_tags.delete", json!({"id": id})).await;
        assert!(call(&s, "auto_tags.list", json!({})).await.as_array().unwrap().is_empty());
    }

    // ── Privacy: a rule without allow_remote never reaches the network ──

    #[tokio::test]
    async fn evaluate_refuses_an_endpoint_provider_without_the_rules_opt_in() {
        let s = st();
        let tag = tag_named(&s, "Receipts").await;
        let rule = auto_tags::Rule {
            id: "r1".into(),
            allow_remote: false,
            ..core_rule(&tag)
        };
        let provider = Provider::Endpoint { url: "http://127.0.0.1:1".into(), model: "m".into() };
        let err = evaluate(&provider, &s.inference, &rule, &auto_tags::Candidate::default()).await.unwrap_err();
        assert!(err.contains("allow_remote"), "{err}");
        // Proof this never even tried to reach the network: a real attempt
        // against a closed port fails with reqwest's own wording, not ours.
        assert!(!err.to_lowercase().contains("endpoint request failed"), "{err}");
    }

    #[tokio::test]
    async fn preview_reports_the_remote_refusal_per_candidate_rather_than_a_guessed_match() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example", false);
        let tag = tag_named(&s, "Receipts").await;
        let rule = rule_json(&tag, false); // allow_remote: false
        let provider = json!({"type": "endpoint", "url": "http://127.0.0.1:1", "model": "m"});
        let out = call(&s, "auto_tags.preview", json!({"accountId": "a", "provider": provider, "rule": rule})).await;
        let rows = out["candidates"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["matched"], false);
        assert!(rows[0]["refused"].as_str().unwrap().contains("allow_remote"));
        assert_eq!(tag_count(&s).await, 0, "preview must never write");
    }

    // ── Preview never writes ─────────────────────────────────────────

    #[tokio::test]
    async fn preview_with_local_gguf_and_no_model_loaded_refuses_but_writes_nothing() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example", true);
        let tag = tag_named(&s, "Receipts").await;
        let out = call(
            &s,
            "auto_tags.preview",
            json!({"accountId": "a", "provider": {"type": "localGguf"}, "rule": rule_json(&tag, false)}),
        )
        .await;
        let rows = out["candidates"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["matched"], false);
        assert!(rows[0]["refused"].as_str().unwrap().contains("No model loaded"), "{:?}", rows[0]["refused"]);
        assert_eq!(tag_count(&s).await, 0);
    }

    #[tokio::test]
    async fn a_candidate_the_prefilter_rejects_never_reaches_the_model_at_all() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Weekend plans", "friend@example.com", false);
        let tag = tag_named(&s, "Receipts").await;
        let mut rule = rule_json(&tag, false);
        rule["constraints"] = json!({"fromDomain": "shop.example"});
        let out = call(&s, "auto_tags.preview", json!({"accountId": "a", "provider": {"type": "localGguf"}, "rule": rule})).await;
        assert!(out["candidates"].as_array().unwrap().is_empty(), "the domain constraint excludes this sender");
    }

    // ── Backfill assigns and undo reverses exactly that batch ────────

    /// Hand-rolled single-response HTTP mock, same shape `handlers/graph.rs`'s
    /// tests use — sufficient for one canned `/chat/completions` reply per
    /// connection, no request inspection needed.
    fn mock_endpoint_once(content: &str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock endpoint");
        let port = listener.local_addr().unwrap().port();
        let content = content.to_string();
        std::thread::spawn(move || {
            if let Some(Ok(stream)) = listener.incoming().next() {
                respond(stream, &content);
            }
        });
        port
    }

    fn respond(mut stream: TcpStream, content: &str) {
        let mut buf = [0u8; 8192];
        let _ = stream.read(&mut buf);
        let body = json!({"choices": [{"message": {"content": content}}]}).to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes());
    }

    #[tokio::test]
    async fn backfill_assigns_the_tag_and_undo_removes_exactly_that_batch() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example", true);
        let tag = tag_named(&s, "Receipts").await;
        let mut rule = rule_json(&tag, true); // allow_remote: true
        rule["minConfidence"] = json!(0.5);
        let created = call(&s, "auto_tags.create", json!({"rule": rule})).await;
        let rule_id = created["id"].as_str().unwrap().to_string();

        let port = mock_endpoint_once("MATCH: yes\nCONFIDENCE: 0.9");
        let provider = json!({"type": "endpoint", "url": format!("http://127.0.0.1:{port}"), "model": "m"});
        let out = call(&s, "auto_tags.backfill", json!({"accountId": "a", "ruleId": rule_id, "provider": provider})).await;
        assert_eq!(out["matched"], 1);
        assert_eq!(out["assigned"], 1);
        let batch_id = out["batchId"].as_str().unwrap().to_string();

        assert_eq!(tag_count(&s).await, 1, "the backfill assigned the tag");

        let undone = call(&s, "auto_tags.undo_backfill", json!({"batchId": batch_id})).await;
        assert_eq!(undone["unassigned"], 1);
        assert_eq!(tag_count(&s).await, 0, "undo removed exactly what the batch assigned");

        // A second undo of the same (now-forgotten) batch is a harmless no-op.
        let again = call(&s, "auto_tags.undo_backfill", json!({"batchId": batch_id})).await;
        assert_eq!(again["unassigned"], 0);
    }

    /// The rule's `tag_id` can be repointed after a backfill runs; undo must
    /// still remove the tag that batch actually assigned, not whatever the
    /// rule points at by the time undo is called.
    #[tokio::test]
    async fn undo_removes_the_tag_originally_assigned_even_after_the_rules_tag_id_changes() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example", true);
        let original_tag = tag_named(&s, "Receipts").await;
        let other_tag = tag_named(&s, "Other").await;
        let mut rule = rule_json(&original_tag, true);
        rule["minConfidence"] = json!(0.5);
        let created = call(&s, "auto_tags.create", json!({"rule": rule})).await;
        let rule_id = created["id"].as_str().unwrap().to_string();

        let port = mock_endpoint_once("MATCH: yes\nCONFIDENCE: 0.9");
        let provider = json!({"type": "endpoint", "url": format!("http://127.0.0.1:{port}"), "model": "m"});
        let out = call(&s, "auto_tags.backfill", json!({"accountId": "a", "ruleId": rule_id, "provider": provider})).await;
        assert_eq!(out["assigned"], 1);
        let batch_id = out["batchId"].as_str().unwrap().to_string();

        // Repoint the rule at a different tag entirely.
        let mut repointed = rule_json(&other_tag, true);
        repointed["minConfidence"] = json!(0.5);
        call(&s, "auto_tags.update", json!({"id": rule_id, "rule": repointed})).await;

        call(&s, "auto_tags.undo_backfill", json!({"batchId": batch_id})).await;

        // `tags.*` is a sibling router — see `tag_count`'s own comment.
        let listed = crate::handlers::tags::route(&s, "tags.list", &json!({}), json!(1))
            .await
            .expect("routed")
            .result
            .expect("tags.list");
        let listed = listed.as_array().unwrap();
        let original_count = listed.iter().find(|t| t["id"] == original_tag).unwrap()["count"].as_i64().unwrap();
        let other_count = listed.iter().find(|t| t["id"] == other_tag).unwrap()["count"].as_i64().unwrap();
        assert_eq!(original_count, 0, "the tag the batch actually assigned must come off");
        assert_eq!(other_count, 0, "the rule's new tag was never touched by this batch and must stay untouched");
    }

    #[tokio::test]
    async fn a_message_already_carrying_the_tag_keeps_it_after_a_backfills_undo() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example", true);
        let tag = tag_named(&s, "Receipts").await;
        // Pre-tag the message by hand, as if the user (or an earlier batch) already did.
        crate::handlers::tags::route(
            &s,
            "tags.assign",
            &json!({"tagId": tag, "items": [{"accountId": "a", "mailbox": "INBOX", "uid": 1}]}),
            json!(1),
        )
        .await;

        let mut rule = rule_json(&tag, true);
        rule["minConfidence"] = json!(0.5);
        let created = call(&s, "auto_tags.create", json!({"rule": rule})).await;
        let rule_id = created["id"].as_str().unwrap().to_string();

        let port = mock_endpoint_once("MATCH: yes\nCONFIDENCE: 0.9");
        let provider = json!({"type": "endpoint", "url": format!("http://127.0.0.1:{port}"), "model": "m"});
        let out = call(&s, "auto_tags.backfill", json!({"accountId": "a", "ruleId": rule_id, "provider": provider})).await;
        assert_eq!(out["matched"], 1, "the model still says yes");
        assert_eq!(out["assigned"], 0, "already-tagged messages are not this batch's to undo");

        let batch_id = out["batchId"].as_str().unwrap().to_string();
        call(&s, "auto_tags.undo_backfill", json!({"batchId": batch_id})).await;
        assert_eq!(tag_count(&s).await, 1, "the pre-existing tag must survive the undo");
    }

    #[tokio::test]
    async fn a_confidence_below_the_rules_threshold_assigns_nothing() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example", true);
        let tag = tag_named(&s, "Receipts").await;
        let mut rule = rule_json(&tag, true);
        rule["minConfidence"] = json!(0.9);
        let created = call(&s, "auto_tags.create", json!({"rule": rule})).await;
        let rule_id = created["id"].as_str().unwrap().to_string();

        let port = mock_endpoint_once("MATCH: yes\nCONFIDENCE: 0.4");
        let provider = json!({"type": "endpoint", "url": format!("http://127.0.0.1:{port}"), "model": "m"});
        let out = call(&s, "auto_tags.backfill", json!({"accountId": "a", "ruleId": rule_id, "provider": provider})).await;
        assert_eq!(out["matched"], 0, "0.4 never clears a 0.9 threshold");
        assert_eq!(out["assigned"], 0);
        assert_eq!(tag_count(&s).await, 0);
    }

    #[tokio::test]
    async fn an_unparseable_model_reply_refuses_and_assigns_nothing() {
        let s = st();
        seed_header(&s, "a", "INBOX", 1, "Your receipt", "billing@shop.example", true);
        let tag = tag_named(&s, "Receipts").await;
        let rule = rule_json(&tag, true);
        let created = call(&s, "auto_tags.create", json!({"rule": rule})).await;
        let rule_id = created["id"].as_str().unwrap().to_string();

        let port = mock_endpoint_once("Sure, this looks like a receipt!");
        let provider = json!({"type": "endpoint", "url": format!("http://127.0.0.1:{port}"), "model": "m"});
        let out = call(&s, "auto_tags.backfill", json!({"accountId": "a", "ruleId": rule_id, "provider": provider})).await;
        assert_eq!(out["matched"], 0, "an unparseable reply is a refusal, never a guessed match");
        assert_eq!(out["assigned"], 0);
    }

    #[tokio::test]
    async fn backfill_requires_a_saved_rule_id_not_an_inline_draft() {
        let s = st();
        let err = call_err(&s, "auto_tags.backfill", json!({"accountId": "a", "provider": {"type": "localGguf"}})).await;
        assert!(err.contains("ruleId"), "{err}");
    }

    // ── should_assign: the shared assign/refuse gate ──────────────────

    #[test]
    fn should_assign_requires_a_match_at_or_above_threshold() {
        assert!(should_assign(&Ok(auto_tags::Verdict::Match(0.9)), 0.7));
        assert!(!should_assign(&Ok(auto_tags::Verdict::Match(0.5)), 0.7));
        assert!(!should_assign(&Ok(auto_tags::Verdict::NoMatch), 0.0));
    }

    #[test]
    fn should_assign_never_assigns_on_a_refusal() {
        assert!(!should_assign(&Err("unparseable auto-tag verdict, refusing rather than guessing a match".into()), 0.0));
    }

    fn core_rule(tag_id: &str) -> auto_tags::Rule {
        auto_tags::Rule {
            id: "r1".into(),
            name: "Receipts".into(),
            instruction: "receipts and invoices".into(),
            constraints: auto_tags::Constraints::default(),
            tag_id: tag_id.into(),
            inbox_action: auto_tags::InboxAction::Keep,
            min_confidence: 0.7,
            allow_remote: false,
            provider: Value::Null,
            enabled: false,
            enabled_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }
}
