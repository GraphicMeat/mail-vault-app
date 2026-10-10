//! `JmapClient`: one JMAP session (RFC 8620) for one mail account (RFC 8621).
//!
//! Three tracked HTTP clients, every request sent through `Tracked::send` so it
//! shows in Network Activity as the account's:
//! - `api`: method calls and the session fetch, 60 s total, redirects off.
//! - `transfer`: blob upload and download, 15 s connect plus a read-idle
//!   timeout; an upload also gets a total timeout sized by its bytes, the
//!   way `smtp.rs` sizes sends.
//! - `push`: the EventSource stream, read-idle only (no total timeout).
//!
//! Credentials only ever go to URLs `base::url_allowed` accepts. The session
//! URL and its redirects must stay on the host the user saw; the endpoint
//! URLs the authenticated session names (`apiUrl`, `downloadUrl`, ...) are
//! authoritative (RFC 8620 §2) and may be on any https host.

use super::base;
use super::types::*;
use crate::net_activity::{error_chain, http_client_with, Tracked};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, LOCATION, RETRY_AFTER};
use reqwest::redirect::Policy;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use url::Url;

const API_TIMEOUT: Duration = Duration::from_secs(60);
const TRANSFER_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Three missed 30 s pings.
const PUSH_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_REDIRECTS: usize = 5;
const MAX_CHANGES: u64 = 500;
/// The ids `all_email_ids` asks for per `Email/query`.
const ID_PAGE: usize = 500;
/// The most hits a Message-ID lookup reads back (`find_message_id_in`).
const MESSAGE_ID_HITS: usize = 50;

pub struct JmapClient {
    api: Tracked,
    transfer: Tracked,
    push: Tracked,
    auth: JmapAuth,
    session: Session,
    account_id: String,
    limits: CoreLimits,
    trusted_host: String,
    email: String,
}

fn transport(e: reqwest::Error) -> JmapError {
    JmapError::Transport(error_chain(&e.without_url()))
}

fn retry_after(resp: &reqwest::Response) -> Option<u64> {
    resp.headers().get(RETRY_AFTER)?.to_str().ok()?.trim().parse().ok()
}

/// A 4xx/5xx body: a JMAP request-level problem (`urn:ietf:params:jmap:error:*`)
/// becomes `Method`, anything else `Protocol("HTTP <status>")`.
fn problem_error(status: u16, body: &[u8]) -> JmapError {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    match v["type"].as_str() {
        Some(kind) if kind.starts_with("urn:ietf:params:jmap:error:") => JmapError::Method {
            kind: kind.to_string(),
            description: v["detail"].as_str().or(v["limit"].as_str()).map(str::to_string),
        },
        _ => JmapError::Protocol(format!("HTTP {status}")),
    }
}

/// Map the status line: 401/403 `Unauthorized`, 429/503 `RateLimited`, any
/// other 3xx/4xx/5xx an error. 2xx passes through.
async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, JmapError> {
    match resp.status().as_u16() {
        401 | 403 => Err(JmapError::Unauthorized),
        429 | 503 => Err(JmapError::RateLimited { retry_after: retry_after(&resp) }),
        s if s >= 400 => {
            let body = resp.bytes().await.unwrap_or_default();
            Err(problem_error(s, &body))
        }
        s if s >= 300 => Err(JmapError::Protocol(format!("HTTP {s}"))),
        _ => Ok(resp),
    }
}

/// RFC 6570 level 1: replace every `{var}` anywhere in `tpl` (path or query)
/// with its value, percent-encoding everything but unreserved characters. A
/// variable `vars` does not name expands to "".
pub fn expand_template(tpl: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = &after[..close];
        if let Some((_, value)) = vars.iter().find(|(k, _)| *k == name) {
            pct_encode(value, &mut out);
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

fn pct_encode(value: &str, out: &mut String) {
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
}

/// An endpoint the session named must parse and be allowed to carry credentials.
fn check_endpoint(tpl: &str) -> Result<(), JmapError> {
    let url = Url::parse(&expand_template(tpl, &[]))
        .map_err(|e| JmapError::Protocol(format!("bad JMAP endpoint URL: {e}")))?;
    if base::url_allowed(&url) {
        Ok(())
    } else {
        Err(JmapError::Protocol("JMAP endpoint must be https".into()))
    }
}

/// JSON Pointer escaping for a patch path segment (RFC 6901): `~` and `/`.
fn pointer_escape(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn true_map(keys: &[String]) -> Value {
    Value::Object(keys.iter().map(|k| (k.clone(), Value::Bool(true))).collect())
}

/// A method-level `["error", {type, description}, tag]` response's arguments
/// as an error: `cannotCalculateChanges` typed, anything else `Method`.
fn method_error(args: &Value) -> JmapError {
    let kind = args["type"].as_str().unwrap_or("serverFail").to_string();
    if kind == "cannotCalculateChanges" {
        JmapError::CannotCalculateChanges
    } else {
        JmapError::Method { kind, description: args["description"].as_str().map(str::to_string) }
    }
}

/// Fold one `/set` response's update and destroy results into `out`.
fn collect_set(r: &Value, out: &mut SetOutcome) {
    if let Some(m) = r["updated"].as_object() {
        out.ok.extend(m.keys().cloned());
    }
    out.ok.extend(strings(&r["destroyed"]));
    for key in ["notUpdated", "notDestroyed"] {
        if let Some(m) = r[key].as_object() {
            for (id, e) in m {
                out.failed.push((id.clone(), e["type"].as_str().unwrap_or("serverFail").to_string()));
            }
        }
    }
}

/// An upload's total timeout: a minute plus a second per 50 kB, at most ten
/// minutes (`smtp.rs`'s send sizing).
fn transfer_timeout(bytes: usize) -> Duration {
    Duration::from_secs(60 + (bytes / 50_000) as u64).min(Duration::from_secs(600))
}

/// A message's own `Date:` as a JMAP UTCDate ("2019-03-05T08:15:00Z", RFC
/// 8620 §1.4: `Z`, never "+00:00"): the `receivedAt` an import keeps it
/// under, as an APPEND keeps its INTERNALDATE. `None` without a readable
/// Date: the server then stamps the import time.
pub fn received_at_of(raw: &[u8]) -> Option<String> {
    let secs = crate::import_rehome::head_of(raw).date_secs?;
    chrono::DateTime::from_timestamp(secs, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

impl JmapClient {
    /// Fetch and check the session at `session_url`, authenticated as `auth`.
    /// Every request is shown as `email`'s, under the Network Activity purpose
    /// in scope (`net_activity::with_purpose`).
    pub async fn connect(session_url: &str, auth: JmapAuth, email: &str) -> Result<Self, JmapError> {
        let start = Url::parse(session_url.trim()).map_err(|e| JmapError::Protocol(format!("bad session URL: {e}")))?;
        if !base::url_allowed(&start) {
            return Err(JmapError::Protocol("JMAP requires https".into()));
        }
        let trusted_host = start.host_str().unwrap_or_default().to_ascii_lowercase();
        let purpose = crate::net_activity::purpose();
        let api = http_client_with(purpose, reqwest::Client::builder().timeout(API_TIMEOUT).redirect(Policy::none()))
            .for_account(email);
        let transfer = http_client_with(
            purpose,
            reqwest::Client::builder()
                .connect_timeout(TRANSFER_CONNECT_TIMEOUT)
                .read_timeout(TRANSFER_IDLE_TIMEOUT)
                .redirect(Policy::none()),
        )
        .for_account(email);
        let push = http_client_with(
            purpose,
            reqwest::Client::builder()
                .connect_timeout(TRANSFER_CONNECT_TIMEOUT)
                .read_timeout(PUSH_IDLE_TIMEOUT)
                .redirect(Policy::none()),
        )
        .for_account(email);

        // Follow redirects by hand: only on the host the user saw, never to http.
        let auth_header = auth.header();
        let mut url = start;
        let mut hops = 0;
        let resp = loop {
            let req = api.get(url.clone()).header(AUTHORIZATION, auth_header.as_str());
            let resp = api.send(req).await.map_err(transport)?;
            if !matches!(resp.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                break resp;
            }
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err(JmapError::Protocol("too many redirects".into()));
            }
            let location = resp
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| JmapError::Protocol("redirect without Location".into()))?;
            let next = url.join(location).map_err(|e| JmapError::Protocol(format!("bad redirect: {e}")))?;
            let host = next.host_str().unwrap_or_default().to_ascii_lowercase();
            if host != trusted_host {
                return Err(JmapError::ForeignHost { host });
            }
            if !base::url_allowed(&next) {
                return Err(JmapError::Protocol("JMAP requires https".into()));
            }
            url = next;
        };
        let resp = check_status(resp).await?;
        let session: Session = resp
            .json()
            .await
            .map_err(|e| JmapError::Protocol(format!("bad JMAP session: {}", error_chain(&e.without_url()))))?;

        let account_id = session
            .primary_accounts
            .get(MAIL)
            .cloned()
            .ok_or_else(|| JmapError::Protocol("session has no JMAP mail account".into()))?;
        check_endpoint(&session.api_url)?;
        check_endpoint(&session.download_url)?;
        check_endpoint(&session.upload_url)?;
        if let Some(es) = &session.event_source_url {
            check_endpoint(es)?;
        }
        let limits = CoreLimits::from_capability(session.capabilities.get(CORE));
        Ok(JmapClient { api, transfer, push, auth, session, account_id, limits, trusted_host, email: email.to_string() })
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn limits(&self) -> &CoreLimits {
        &self.limits
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    /// The host the session URL named: the one the user saw.
    pub fn trusted_host(&self) -> &str {
        &self.trusted_host
    }

    /// The account address every request is shown under.
    pub fn email(&self) -> &str {
        &self.email
    }

    pub fn has_submission(&self) -> bool {
        self.session.capabilities.contains_key(SUBMISSION)
    }

    pub fn event_source_url(&self) -> Option<&str> {
        self.session.event_source_url.as_deref()
    }

    fn using(&self) -> Vec<&'static str> {
        let mut using = vec![CORE, MAIL];
        if self.has_submission() {
            using.push(SUBMISSION);
        }
        using
    }

    /// One API request carrying `calls` (`[name, args, tag]` triples), in order.
    /// A batch over `maxCallsInRequest` is refused, never split: splitting
    /// breaks `#ids` back-references. Callers that page chunk themselves.
    /// The first `["error", {type}, tag]` response fails the whole call.
    pub async fn call(&self, calls: Vec<Value>) -> Result<Vec<Value>, JmapError> {
        let out = self.call_unchecked(calls).await?;
        if let Some(r) = out.iter().find(|r| r[0] == "error") {
            return Err(method_error(&r[1]));
        }
        Ok(out)
    }

    /// `call` without failing on `["error", ...]` responses: every response,
    /// errors included, in order. For a caller that must read one response
    /// whatever its neighbours say (`submit`).
    async fn call_unchecked(&self, calls: Vec<Value>) -> Result<Vec<Value>, JmapError> {
        if calls.len() > self.limits.max_calls_in_request.max(1) {
            return Err(JmapError::Protocol("batch over maxCallsInRequest".into()));
        }
        let body = json!({ "using": self.using(), "methodCalls": calls });
        let req = self.api.post(self.session.api_url.as_str()).header(AUTHORIZATION, self.auth.header()).json(&body);
        let resp = check_status(self.api.send(req).await.map_err(transport)?).await?;
        let v: Value = resp
            .json()
            .await
            .map_err(|e| JmapError::Protocol(format!("bad JMAP response: {}", error_chain(&e.without_url()))))?;
        v["methodResponses"]
            .as_array()
            .cloned()
            .ok_or_else(|| JmapError::Protocol("no methodResponses".into()))
    }

    /// One method call in its own request, `accountId` filled in; its arguments back.
    async fn method(&self, name: &str, mut args: Value) -> Result<Value, JmapError> {
        if !args.is_object() {
            return Err(JmapError::Protocol(format!("{name} arguments must be an object")));
        }
        args["accountId"] = json!(self.account_id);
        let mut out = self.call(vec![json!([name, args, "0"])]).await?;
        let first = out.first_mut().ok_or_else(|| JmapError::Protocol(format!("no response to {name}")))?;
        if first[0] != name {
            return Err(JmapError::Protocol(format!("expected a {name} response, got {}", first[0])));
        }
        Ok(first[1].take())
    }

    /// Every mailbox, and the Mailbox state.
    pub async fn mailboxes(&self) -> Result<(Vec<JMailbox>, String), JmapError> {
        let r = self
            .method(
                "Mailbox/get",
                json!({"ids": null, "properties": ["id", "name", "parentId", "role", "totalEmails", "unreadEmails", "sortOrder"]}),
            )
            .await?;
        let count = |m: &Value, key: &str| m[key].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32;
        let list = r["list"]
            .as_array()
            .ok_or_else(|| JmapError::Protocol("Mailbox/get without list".into()))?
            .iter()
            .map(|m| JMailbox {
                id: m["id"].as_str().unwrap_or_default().to_string(),
                name: m["name"].as_str().unwrap_or_default().to_string(),
                parent_id: m["parentId"].as_str().map(str::to_string),
                role: m["role"].as_str().map(str::to_string),
                total_emails: count(m, "totalEmails"),
                unread_emails: count(m, "unreadEmails"),
                sort_order: count(m, "sortOrder"),
            })
            .filter(|m| !m.id.is_empty())
            .collect();
        Ok((list, r["state"].as_str().unwrap_or_default().to_string()))
    }

    /// Up to `limit` email ids in `mailbox_id`, newest first, from `position`,
    /// and the mailbox's total. Pages by what each answer holds (a server may
    /// cap `limit`) and stops at the total. If the `queryState` moves between
    /// pages the run starts over from `position` once, then accepts the
    /// moving state.
    pub async fn query_mailbox(
        &self,
        mailbox_id: &str,
        position: usize,
        limit: usize,
    ) -> Result<(Vec<String>, Option<usize>), JmapError> {
        let mut ids: Vec<String> = Vec::new();
        let mut pos = position;
        let mut total: Option<usize> = None;
        let mut query_state: Option<String> = None;
        let mut restarted = false;
        while ids.len() < limit {
            let r = self
                .method(
                    "Email/query",
                    json!({
                        "filter": {"inMailbox": mailbox_id},
                        "sort": [{"property": "receivedAt", "isAscending": false}],
                        "position": pos,
                        "limit": limit - ids.len(),
                        "calculateTotal": true,
                    }),
                )
                .await?;
            let state = r["queryState"].as_str().unwrap_or_default().to_string();
            match query_state.as_deref() {
                None => query_state = Some(state),
                Some(prev) if prev != state => {
                    query_state = Some(state);
                    if !restarted {
                        restarted = true;
                        ids.clear();
                        pos = position;
                        total = None;
                        continue;
                    }
                }
                Some(_) => {}
            }
            if let Some(t) = r["total"].as_u64() {
                total = Some(t as usize);
            }
            let page = strings(&r["ids"]);
            if page.is_empty() {
                break;
            }
            pos += page.len();
            ids.extend(page);
            if total.is_some_and(|t| pos >= t) {
                break;
            }
        }
        ids.truncate(limit);
        Ok((ids, total))
    }

    /// `Email/get` for `ids`, one request per `maxObjectsInGet` chunk.
    pub async fn get_emails(&self, ids: &[String], properties: &[&str]) -> Result<EmailsGot, JmapError> {
        if ids.is_empty() {
            return Ok(EmailsGot { state: self.email_state().await?, ..EmailsGot::default() });
        }
        let mut got = EmailsGot::default();
        for chunk in ids.chunks(self.limits.max_objects_in_get.max(1)) {
            let r = self.method("Email/get", json!({"ids": chunk, "properties": properties})).await?;
            if let Some(list) = r["list"].as_array() {
                got.list.extend(list.iter().cloned());
            }
            got.not_found.extend(strings(&r["notFound"]));
            if got.state.is_empty() {
                got.state = r["state"].as_str().unwrap_or_default().to_string();
            }
        }
        Ok(got)
    }

    /// Every Email change since `since`, `maxChanges` 500 per request, following
    /// `hasMoreChanges` and folding the pages into one set.
    pub async fn email_changes(&self, since: &str) -> Result<EmailChanges, JmapError> {
        #[derive(Clone, Copy, PartialEq)]
        enum Seen {
            Created,
            Updated,
            Destroyed,
            Vanished,
        }
        let mut seen: HashMap<String, Seen> = HashMap::new();
        let mut out = EmailChanges { old_state: since.to_string(), new_state: since.to_string(), ..EmailChanges::default() };
        loop {
            let r = self.method("Email/changes", json!({"sinceState": out.new_state, "maxChanges": MAX_CHANGES})).await?;
            let new_state = r["newState"]
                .as_str()
                .ok_or_else(|| JmapError::Protocol("Email/changes without newState".into()))?
                .to_string();
            let has_more = r["hasMoreChanges"].as_bool().unwrap_or(false);
            for id in strings(&r["created"]) {
                if !seen.contains_key(&id) {
                    seen.insert(id.clone(), Seen::Created);
                    out.created.push(id);
                }
            }
            for id in strings(&r["updated"]) {
                if !seen.contains_key(&id) {
                    seen.insert(id.clone(), Seen::Updated);
                    out.updated.push(id);
                }
            }
            for id in strings(&r["destroyed"]) {
                match seen.get(&id).copied() {
                    Some(Seen::Created) => {
                        seen.insert(id, Seen::Vanished);
                    }
                    Some(Seen::Destroyed) | Some(Seen::Vanished) => {}
                    Some(Seen::Updated) | None => {
                        seen.insert(id.clone(), Seen::Destroyed);
                        out.destroyed.push(id);
                    }
                }
            }
            if has_more && new_state == out.new_state {
                return Err(JmapError::Protocol("Email/changes did not advance".into()));
            }
            out.new_state = new_state;
            if !has_more {
                break;
            }
        }
        out.created.retain(|id| seen.get(id) == Some(&Seen::Created));
        out.updated.retain(|id| seen.get(id) == Some(&Seen::Updated));
        Ok(out)
    }

    /// The current Email state (`Email/get` with no ids).
    pub async fn email_state(&self) -> Result<String, JmapError> {
        let r = self.method("Email/get", json!({"ids": []})).await?;
        r["state"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| JmapError::Protocol("Email/get without state".into()))
    }

    /// Per email, keywords to add (`true`) or remove (`false`).
    pub async fn set_keywords(&self, patches: &[(String, Vec<(String, bool)>)]) -> Result<SetOutcome, JmapError> {
        self.patch_emails("keywords", patches).await
    }

    /// Per email, mailbox ids to add (`true`) or remove (`false`).
    pub async fn set_mailboxes(&self, patches: &[(String, Vec<(String, bool)>)]) -> Result<SetOutcome, JmapError> {
        self.patch_emails("mailboxIds", patches).await
    }

    async fn patch_emails(&self, prop: &str, patches: &[(String, Vec<(String, bool)>)]) -> Result<SetOutcome, JmapError> {
        let mut outcome = SetOutcome::default();
        for chunk in patches.chunks(self.limits.max_objects_in_set.max(1)) {
            let mut update = Map::new();
            for (id, toggles) in chunk {
                let patch: Map<String, Value> = toggles
                    .iter()
                    .map(|(key, on)| (format!("{prop}/{}", pointer_escape(key)), if *on { Value::Bool(true) } else { Value::Null }))
                    .collect();
                update.insert(id.clone(), Value::Object(patch));
            }
            let r = self.method("Email/set", json!({"update": update})).await?;
            collect_set(&r, &mut outcome);
        }
        Ok(outcome)
    }

    /// `Email/set destroy`: gone from every mailbox (label semantics: use
    /// `ops::remove_from` for a delete from one mailbox).
    pub async fn destroy(&self, ids: &[String]) -> Result<SetOutcome, JmapError> {
        let mut outcome = SetOutcome::default();
        for chunk in ids.chunks(self.limits.max_objects_in_set.max(1)) {
            let r = self.method("Email/set", json!({"destroy": chunk})).await?;
            collect_set(&r, &mut outcome);
        }
        Ok(outcome)
    }

    /// `Mailbox/set` with `args` (create, update, destroy, ...); `accountId`
    /// is filled in. Returns the response arguments.
    pub async fn mailbox_set(&self, args: Value) -> Result<Value, JmapError> {
        self.method("Mailbox/set", args).await
    }

    /// The raw message behind `blob_id`, from the session's `downloadUrl`.
    pub async fn download(&self, blob_id: &str) -> Result<Vec<u8>, JmapError> {
        let url = expand_template(
            &self.session.download_url,
            &[("accountId", &self.account_id), ("blobId", blob_id), ("type", "message/rfc822"), ("name", "message.eml")],
        );
        let req = self.transfer.get(url.as_str()).header(AUTHORIZATION, self.auth.header());
        let resp = check_status(self.transfer.send(req).await.map_err(transport)?).await?;
        Ok(resp.bytes().await.map_err(transport)?.to_vec())
    }

    /// Upload a raw message; its blob id. Refused locally over `maxSizeUpload`.
    pub async fn upload(&self, raw: &[u8]) -> Result<String, JmapError> {
        if raw.len() as u64 > self.limits.max_size_upload {
            return Err(JmapError::Method {
                kind: "urn:ietf:params:jmap:error:limit".into(),
                description: Some("maxSizeUpload".into()),
            });
        }
        let url = expand_template(&self.session.upload_url, &[("accountId", &self.account_id)]);
        let req = self
            .transfer
            .post(url.as_str())
            .header(AUTHORIZATION, self.auth.header())
            .header(CONTENT_TYPE, "message/rfc822")
            .timeout(transfer_timeout(raw.len()))
            .body(raw.to_vec());
        let resp = check_status(self.transfer.send(req).await.map_err(transport)?).await?;
        let v: Value = resp
            .json()
            .await
            .map_err(|e| JmapError::Protocol(format!("bad upload answer: {}", error_chain(&e.without_url()))))?;
        v["blobId"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| JmapError::Protocol("upload answer without blobId".into()))
    }

    /// `Email/import` one uploaded blob into `mailbox_ids` with `keywords`.
    /// `alreadyExists` is a dedupe (`ImportResult::AlreadyExists`), not a failure.
    pub async fn import(
        &self,
        blob_id: &str,
        mailbox_ids: &[String],
        keywords: &[String],
        received_at: Option<&str>,
    ) -> Result<ImportResult, JmapError> {
        let mut spec = json!({"blobId": blob_id, "mailboxIds": true_map(mailbox_ids), "keywords": true_map(keywords)});
        if let Some(at) = received_at {
            spec["receivedAt"] = json!(at);
        }
        let r = self.method("Email/import", json!({"emails": {"k": spec}})).await?;
        if let Some(c) = r["created"].get("k") {
            return Ok(ImportResult::Created(Imported {
                id: c["id"].as_str().unwrap_or_default().to_string(),
                blob_id: c["blobId"].as_str().unwrap_or_default().to_string(),
                size: c["size"].as_u64().unwrap_or(0),
            }));
        }
        let e = &r["notCreated"]["k"];
        let description = e["description"].as_str().map(str::to_string);
        match (e["type"].as_str(), e["existingId"].as_str()) {
            (Some("alreadyExists"), Some(existing)) => Ok(ImportResult::AlreadyExists { existing_id: existing.to_string() }),
            (Some(kind), _) => Err(JmapError::Method { kind: kind.to_string(), description }),
            (None, _) => Err(JmapError::Protocol("Email/import answered neither created nor notCreated".into())),
        }
    }

    /// Upload + `Email/import` one raw message into `mailbox_id`, unless the
    /// mailbox already holds its Message-ID (`find_message_id_in`): then
    /// nothing is sent and the answer is `AlreadyExists` naming the copy
    /// there, the rule `mbox_upload` applies to IMAP. A server-side dedupe
    /// (`alreadyExists`) is `AlreadyExists` too: present, never failed.
    ///
    /// A server that repairs the message (different blobId/size) still
    /// counts as imported: the server copy is the server's business, the
    /// vault keeps our bytes. Its Message-ID is unchanged, so a second run
    /// finds it and imports nothing.
    pub async fn import_raw(
        &self,
        raw: &[u8],
        mailbox_id: &str,
        keywords: &[String],
        received_at: Option<&str>,
    ) -> Result<ImportResult, JmapError> {
        if let Some(existing_id) = self.find_message_id_in(mailbox_id, raw).await? {
            return Ok(ImportResult::AlreadyExists { existing_id });
        }
        let blob_id = self.upload(raw).await?;
        self.import(&blob_id, &[mailbox_id.to_string()], keywords, received_at).await
    }

    /// The email in `mailbox_id` whose Message-ID is `raw`'s, exactly. The
    /// `header` filter matches a substring (RFC 8621 §4.4.1), so each hit is
    /// read back (`messageId`) and only an equal id counts: `<pre-e1@x>`
    /// never stands in for `<e1@x>`. `None` for a message without one.
    pub async fn find_message_id_in(&self, mailbox_id: &str, raw: &[u8]) -> Result<Option<String>, JmapError> {
        let Some(wanted) = crate::maildir::message_id_in(raw) else { return Ok(None) };
        let r = self
            .method(
                "Email/query",
                json!({"filter": {"inMailbox": mailbox_id, "header": ["Message-ID", wanted]}, "limit": MESSAGE_ID_HITS}),
            )
            .await?;
        let hits = strings(&r["ids"]);
        if hits.is_empty() {
            return Ok(None);
        }
        let got = self.get_emails(&hits, &["id", "messageId"]).await?;
        Ok(got
            .list
            .iter()
            .find(|e| strings(&e["messageId"]).iter().any(|m| crate::maildir::normalize_message_id(m) == wanted))
            .and_then(|e| e["id"].as_str())
            .map(str::to_string))
    }

    /// Every email id in `mailbox_id`, newest first: `query_mailbox`
    /// `ID_PAGE` at a time until a short page or the total. An id a shifting
    /// window hands out twice is kept once.
    pub async fn all_email_ids(&self, mailbox_id: &str) -> Result<Vec<String>, JmapError> {
        let mut ids: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut position = 0;
        loop {
            let (page, total) = self.query_mailbox(mailbox_id, position, ID_PAGE).await?;
            let got = page.len();
            position += got;
            ids.extend(page.into_iter().filter(|id| seen.insert(id.clone())));
            if got < ID_PAGE || total.is_some_and(|t| position >= t) {
                return Ok(ids);
            }
        }
    }

    /// The sending identities (`Identity/get`).
    pub async fn identities(&self) -> Result<Vec<Identity>, JmapError> {
        let r = self.method("Identity/get", json!({"ids": null})).await?;
        Ok(r["list"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|i| Identity {
                        id: i["id"].as_str().unwrap_or_default().to_string(),
                        email: i["email"].as_str().unwrap_or_default().to_string(),
                        name: i["name"].as_str().unwrap_or_default().to_string(),
                        may_delete: i["mayDelete"].as_bool().unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// `EmailSubmission/set` create for `email_id` as `identity_id`, with
    /// `on_success` (a PatchObject, or null for none) as `onSuccessUpdateEmail`.
    /// Returns the submission id.
    ///
    /// Reads its own response whatever follows it: once the submission is
    /// created the message is on its way, so an error in the implicit
    /// `Email/set` that `onSuccessUpdateEmail` runs (RFC 8621 §7.5) is logged,
    /// never returned. Returned, it would read as a failed send, and the
    /// caller would destroy the sent copy and the user would send again.
    pub async fn submit(
        &self,
        email_id: &str,
        identity_id: &str,
        envelope: Option<Value>,
        on_success: Value,
    ) -> Result<String, JmapError> {
        if !self.has_submission() {
            return Err(JmapError::Method {
                kind: "urn:ietf:params:jmap:error:unknownCapability".into(),
                description: Some(SUBMISSION.into()),
            });
        }
        let mut create = json!({"emailId": email_id, "identityId": identity_id});
        if let Some(envelope) = envelope {
            create["envelope"] = envelope;
        }
        let mut args = json!({"accountId": self.account_id, "create": {"s": create}});
        if !on_success.is_null() {
            args["onSuccessUpdateEmail"] = json!({"#s": on_success});
        }
        let responses = self.call_unchecked(vec![json!(["EmailSubmission/set", args, "s"])]).await?;
        let error = responses.iter().find(|r| r[0] == "error").map(|r| method_error(&r[1]));
        let Some(sub) = responses.iter().find(|r| r[0] == "EmailSubmission/set") else {
            return Err(error.unwrap_or_else(|| JmapError::Protocol("no EmailSubmission/set response".into())));
        };
        if let Some(id) = sub[1]["created"]["s"]["id"].as_str() {
            if let Some(e) = error {
                tracing::warn!("[jmap] submission {id} created; its Email/set update failed: {e}");
            }
            return Ok(id.to_string());
        }
        let e = &sub[1]["notCreated"]["s"];
        Err(JmapError::Method {
            kind: e["type"].as_str().unwrap_or("serverFail").to_string(),
            description: e["description"].as_str().map(str::to_string),
        })
    }

    /// Open the session's EventSource stream on the push client (read-idle
    /// timeout only): `types` is "*" or a comma list, `ping_secs` the
    /// keep-alive interval, `closeafter=no`. The caller reads the body.
    pub async fn open_event_source(&self, types: &str, ping_secs: u32) -> Result<reqwest::Response, JmapError> {
        let tpl = self
            .session
            .event_source_url
            .as_deref()
            .ok_or_else(|| JmapError::Protocol("server offers no EventSource".into()))?;
        let ping = ping_secs.to_string();
        let url = expand_template(tpl, &[("types", types), ("closeafter", "no"), ("ping", &ping)]);
        let req = self
            .push
            .get(url.as_str())
            .header(AUTHORIZATION, self.auth.header())
            .header(ACCEPT, "text/event-stream");
        check_status(self.push.send(req).await.map_err(transport)?).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_template_fills_path_and_query_variables() {
        let tpl = "https://dl.example/jmap/download/{accountId}/{blobId}/{name}?type={type}";
        let url = expand_template(tpl, &[("accountId", "u1"), ("blobId", "B 9"), ("name", "message.eml"), ("type", "message/rfc822")]);
        assert_eq!(url, "https://dl.example/jmap/download/u1/B%209/message.eml?type=message%2Frfc822");
    }

    #[test]
    fn expand_template_drops_unknown_variables_and_keeps_an_unclosed_brace() {
        assert_eq!(expand_template("https://h/{x}/a", &[]), "https://h//a");
        assert_eq!(expand_template("https://h/?types={types}&ping={ping}", &[("types", "*"), ("ping", "30")]), "https://h/?types=%2A&ping=30");
        assert_eq!(expand_template("https://h/{open", &[]), "https://h/{open");
    }

    #[test]
    fn request_level_problems_become_method_errors() {
        let limit = br#"{"type":"urn:ietf:params:jmap:error:limit","limit":"maxCallsInRequest"}"#;
        assert_eq!(
            problem_error(400, limit),
            JmapError::Method { kind: "urn:ietf:params:jmap:error:limit".into(), description: Some("maxCallsInRequest".into()) }
        );
        assert_eq!(problem_error(500, b"<html>"), JmapError::Protocol("HTTP 500".into()));
    }

    #[test]
    fn missing_or_zero_core_limits_fall_back_to_defaults() {
        let core = json!({"maxObjectsInGet": 7, "maxCallsInRequest": 0});
        let l = CoreLimits::from_capability(Some(&core));
        assert_eq!(l, CoreLimits { max_objects_in_get: 7, ..CoreLimits::default() });
        assert_eq!(CoreLimits::from_capability(None), CoreLimits::default());
    }
}
