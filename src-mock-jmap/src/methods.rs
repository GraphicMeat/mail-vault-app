//! JMAP request processing: back-references, dispatch and the method handlers.

use crate::state::{iso8601, now_iso, Account, Email, Kind, Mailbox, Op, SetError, State};
use crate::Fault;
use mailparse::{DispositionType, ParsedMail};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

pub const SESSION_STATE: &str = "s1";
const COUNT_PROPS: [&str; 4] = ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"];
const EMAIL_PROPS: [&str; 20] = [
    "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "messageId", "inReplyTo",
    "references", "sender", "from", "to", "cc", "bcc", "replyTo", "subject", "sentAt", "hasAttachment", "preview",
];

/// A method-level error: `["error", {"type": kind, "description": ...}, tag]`.
#[derive(Debug, Clone)]
pub struct MErr {
    pub kind: String,
    pub description: Option<String>,
}

impl MErr {
    fn to_json(&self) -> Value {
        match &self.description {
            Some(d) => json!({"type": self.kind, "description": d}),
            None => json!({"type": self.kind}),
        }
    }
}

fn merr(kind: &str, d: impl Into<String>) -> MErr {
    MErr { kind: kind.to_string(), description: Some(d.into()) }
}

type Args = Map<String, Value>;
type Out = Result<Vec<(String, Value)>, MErr>;

/// An RFC 7807 problem for a request-level error.
pub fn problem(status: u16, kind: &str, detail: &str) -> (u16, Value) {
    (status, json!({"type": kind, "status": status, "detail": detail}))
}

/// Run one `POST /jmap/api` body for the authenticated account.
/// `Err` is a request-level error: (HTTP status, problem JSON).
pub fn handle_request(state: &mut State, account: &str, body: &[u8]) -> Result<Value, (u16, Value)> {
    let req: Value = serde_json::from_slice(body)
        .map_err(|e| problem(400, "urn:ietf:params:jmap:error:notJSON", &e.to_string()))?;
    let calls = req
        .get("methodCalls")
        .and_then(Value::as_array)
        .ok_or_else(|| problem(400, "urn:ietf:params:jmap:error:notRequest", "methodCalls missing"))?;
    if calls.len() > state.limits.max_calls_in_request {
        let (status, mut p) = problem(400, "urn:ietf:params:jmap:error:limit", "too many method calls in one request");
        p["limit"] = json!("maxCallsInRequest");
        return Err((status, p));
    }
    let mut responses: Vec<Value> = Vec::new();
    for call in calls {
        let (name, args, tag) = match call.as_array().map(Vec::as_slice) {
            Some([Value::String(n), Value::Object(a), Value::String(t)]) => (n.clone(), a.clone(), t.clone()),
            _ => return Err(problem(400, "urn:ietf:params:jmap:error:notRequest", "malformed method call")),
        };
        let out = resolve_refs(&args, &responses).and_then(|args| {
            if state.server_fails(&name) {
                return Err(merr("serverFail", "injected ServerFail"));
            }
            dispatch(state, account, &name, &args)
        });
        match out {
            Ok(list) => {
                for (n, v) in list {
                    responses.push(json!([n, v, tag]));
                }
            }
            Err(e) => responses.push(json!(["error", e.to_json(), tag])),
        }
    }
    Ok(json!({"methodResponses": responses, "sessionState": SESSION_STATE}))
}

/// Replace every `#key: {resultOf, name, path}` with `key: <value>` (RFC 8620 §3.7).
fn resolve_refs(args: &Args, responses: &[Value]) -> Result<Args, MErr> {
    let mut out = Map::new();
    for (k, v) in args {
        let Some(key) = k.strip_prefix('#') else {
            out.insert(k.clone(), v.clone());
            continue;
        };
        if args.contains_key(key) {
            return Err(merr("invalidArguments", format!("both {key} and #{key} given")));
        }
        let (Some(of), Some(name), Some(path)) = (v["resultOf"].as_str(), v["name"].as_str(), v["path"].as_str()) else {
            return Err(merr("invalidResultReference", format!("malformed #{key}")));
        };
        let src = responses
            .iter()
            .find(|r| r[2] == of && r[0] == name)
            .ok_or_else(|| merr("invalidResultReference", format!("no {name} response tagged {of}")))?;
        let val = eval_path(&src[1], path).ok_or_else(|| merr("invalidResultReference", format!("path {path} not found")))?;
        out.insert(key.to_string(), val);
    }
    Ok(out)
}

/// JSON Pointer with the JMAP `*` extension: `*` maps over an array and flattens
/// array results one level.
pub fn eval_path(v: &Value, path: &str) -> Option<Value> {
    if path.is_empty() {
        return Some(v.clone());
    }
    let path = path.strip_prefix('/')?;
    let (head, rest) = match path.find('/') {
        Some(i) => (&path[..i], &path[i..]),
        None => (path, ""),
    };
    let head = head.replace("~1", "/").replace("~0", "~");
    if head == "*" {
        let mut out = Vec::new();
        for item in v.as_array()? {
            match eval_path(item, rest)? {
                Value::Array(a) if !rest.is_empty() => out.extend(a),
                x => out.push(x),
            }
        }
        return Some(Value::Array(out));
    }
    match v {
        Value::Object(m) => eval_path(m.get(&head)?, rest),
        Value::Array(a) => eval_path(a.get(head.parse::<usize>().ok()?)?, rest),
        _ => None,
    }
}

fn dispatch(state: &mut State, authed: &str, name: &str, args: &Args) -> Out {
    if name == "Core/echo" {
        return Ok(vec![(name.to_string(), Value::Object(args.clone()))]);
    }
    let acc = args
        .get("accountId")
        .and_then(Value::as_str)
        .ok_or_else(|| merr("invalidArguments", "accountId missing"))?
        .to_string();
    if acc != authed || !state.accounts.contains_key(&acc) {
        return Err(merr("accountNotFound", acc));
    }
    let one = |r: Result<Value, MErr>| -> Out { Ok(vec![(name.to_string(), r?)]) };
    match name {
        "Mailbox/get" => one(mailbox_get(state, &acc, args)),
        "Mailbox/changes" => one(changes(state, &acc, args, Kind::Mailbox)),
        "Mailbox/set" => one(mailbox_set(state, &acc, args)),
        "Email/query" => one(email_query(state, &acc, args)),
        "Email/queryChanges" => Err(merr("cannotCalculateChanges", "mock-jmap keeps no query history")),
        "Email/get" => one(email_get(state, &acc, args)),
        "Email/changes" => one(changes(state, &acc, args, Kind::Email)),
        "Email/set" => one(email_set(state, &acc, args)),
        "Email/import" => one(email_import(state, &acc, args)),
        "Identity/get" => one(identity_get(state, &acc, args)),
        "EmailSubmission/set" if state.advertise_submission => email_submission_set(state, &acc, args),
        _ => Err(merr("unknownMethod", name)),
    }
}

// ── argument helpers ────────────────────────────────────────────────────────

fn ids_arg(args: &Args, key: &str) -> Result<Option<Vec<String>>, MErr> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| v.as_str().map(str::to_string).ok_or_else(|| merr("invalidArguments", format!("{key} must hold strings"))))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(merr("invalidArguments", format!("{key} must be an array"))),
    }
}

fn obj_arg(args: &Args, key: &str) -> Result<Args, MErr> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err(merr("invalidArguments", format!("{key} must be an object"))),
    }
}

fn check_set_size(state: &State, n: usize) -> Result<(), MErr> {
    if n > state.limits.max_objects_in_set {
        return Err(merr("requestTooLarge", format!("{n} objects > maxObjectsInSet")));
    }
    Ok(())
}

fn check_get_size(state: &State, n: usize) -> Result<(), MErr> {
    if n > state.limits.max_objects_in_get {
        return Err(merr("requestTooLarge", format!("{n} ids > maxObjectsInGet")));
    }
    Ok(())
}

fn check_if_in_state(args: &Args, current: u64) -> Result<(), MErr> {
    match args.get("ifInState").and_then(Value::as_str) {
        Some(s) if s != current.to_string() => Err(merr("stateMismatch", format!("state is {current}"))),
        _ => Ok(()),
    }
}

/// `null` for an empty map, per RFC 8620 §5.3 ("null if none").
fn nz(m: Args) -> Value {
    if m.is_empty() {
        Value::Null
    } else {
        Value::Object(m)
    }
}

fn nz_vec(v: Vec<String>) -> Value {
    if v.is_empty() {
        Value::Null
    } else {
        json!(v)
    }
}

/// `{"a": true, "b": true}` -> set. `None` when not an object.
fn set_from_obj(v: &Value) -> Option<BTreeSet<String>> {
    v.as_object().map(|m| m.iter().filter(|(_, b)| **b == Value::Bool(true)).map(|(k, _)| k.clone()).collect())
}

fn set_to_obj(s: &BTreeSet<String>) -> Value {
    Value::Object(s.iter().map(|k| (k.clone(), Value::Bool(true))).collect())
}

fn unescape(p: &str) -> String {
    p.replace("~1", "/").replace("~0", "~")
}

// ── parsed message ──────────────────────────────────────────────────────────

/// Header and body facts about one raw message. A message mailparse rejects
/// parses as empty (no headers, no body) rather than failing the request.
struct Msg {
    /// (name, decoded value, raw value)
    headers: Vec<(String, String, String)>,
    body_text: String,
    has_attachment: bool,
}

impl Msg {
    fn parse(raw: &[u8]) -> Msg {
        match mailparse::parse_mail(raw) {
            Ok(p) => Msg {
                headers: p
                    .headers
                    .iter()
                    .map(|h| (h.get_key(), h.get_value(), String::from_utf8_lossy(h.get_value_raw()).into_owned()))
                    .collect(),
                body_text: first_text(&p).unwrap_or_default(),
                has_attachment: has_attachment(&p),
            },
            Err(_) => Msg { headers: vec![], body_text: String::new(), has_attachment: false },
        }
    }

    fn first(&self, name: &str) -> Option<&(String, String, String)> {
        self.headers.iter().find(|h| h.0.eq_ignore_ascii_case(name))
    }

    fn text(&self, name: &str) -> Value {
        self.first(name).map(|h| json!(h.1.trim())).unwrap_or(Value::Null)
    }

    fn ids(&self, name: &str) -> Value {
        match self.first(name).map(|h| extract_ids(&h.1)) {
            Some(ids) if !ids.is_empty() => json!(ids),
            _ => Value::Null,
        }
    }

    fn addrs(&self, name: &str) -> Value {
        self.first(name).map(|h| addresses(&h.1)).unwrap_or(Value::Null)
    }

    fn sent_at(&self) -> Value {
        self.first("Date")
            .and_then(|h| mailparse::dateparse(&h.1).ok())
            .map(|ts| json!(iso8601(ts)))
            .unwrap_or(Value::Null)
    }

    fn preview(&self) -> String {
        let collapsed = self.body_text.split_whitespace().collect::<Vec<_>>().join(" ");
        collapsed.chars().take(64).collect()
    }

    /// Any header `name` whose decoded value contains `needle`, case-insensitively.
    fn contains(&self, name: &str, needle: &str) -> bool {
        self.headers.iter().any(|h| h.0.eq_ignore_ascii_case(name) && ci_contains(&h.1, needle))
    }

    /// `header:{name}[:asRaw|:asText|:asMessageIds|:asAddresses][:all]` (RFC 8621 §4.1.3).
    fn header_prop(&self, spec: &str) -> Value {
        let mut parts: Vec<&str> = spec.split(':').collect();
        let all = parts.last() == Some(&"all");
        if all {
            parts.pop();
        }
        let name = parts.first().copied().unwrap_or_default();
        let form = parts.get(1).copied().unwrap_or("asRaw");
        let one = |h: &(String, String, String)| match form {
            "asText" => json!(h.1.trim()),
            "asMessageIds" => json!(extract_ids(&h.1)),
            "asAddresses" => addresses(&h.1),
            _ => json!(h.2),
        };
        let matching: Vec<Value> = self.headers.iter().filter(|h| h.0.eq_ignore_ascii_case(name)).map(one).collect();
        if all {
            json!(matching)
        } else {
            matching.into_iter().last().unwrap_or(Value::Null)
        }
    }
}

fn ci_contains(hay: &str, needle: &str) -> bool {
    hay.to_lowercase().contains(&needle.to_lowercase())
}

/// The ids inside `<...>`, without brackets (RFC 8621 messageId form).
fn extract_ids(v: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = v;
    while let Some(start) = rest.find('<') {
        let Some(len) = rest[start + 1..].find('>') else { break };
        out.push(rest[start + 1..start + 1 + len].trim().to_string());
        rest = &rest[start + 2 + len..];
    }
    if out.is_empty() && !v.trim().is_empty() {
        out.push(v.trim().to_string());
    }
    out
}

fn addresses(v: &str) -> Value {
    let Ok(list) = mailparse::addrparse(v) else { return Value::Null };
    let mut out = Vec::new();
    for a in list.iter() {
        match a {
            mailparse::MailAddr::Single(s) => out.push(json!({"name": s.display_name, "email": s.addr})),
            mailparse::MailAddr::Group(g) => {
                for s in &g.addrs {
                    out.push(json!({"name": s.display_name, "email": s.addr}));
                }
            }
        }
    }
    json!(out)
}

fn first_text(p: &ParsedMail) -> Option<String> {
    if p.subparts.is_empty() {
        let inline = p.get_content_disposition().disposition != DispositionType::Attachment;
        if inline && p.ctype.mimetype.eq_ignore_ascii_case("text/plain") {
            return p.get_body().ok();
        }
        return None;
    }
    p.subparts.iter().find_map(first_text)
}

fn has_attachment(p: &ParsedMail) -> bool {
    if !p.subparts.is_empty() {
        return p.subparts.iter().any(has_attachment);
    }
    let d = p.get_content_disposition();
    d.disposition == DispositionType::Attachment || d.params.contains_key("filename") || p.ctype.params.contains_key("name")
}

fn message_id_of(raw: &[u8]) -> Option<String> {
    match Msg::parse(raw).ids("Message-ID") {
        Value::Array(a) => a.first().and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

// ── Mailbox ─────────────────────────────────────────────────────────────────

fn mailbox_json(a: &Account, m: &Mailbox) -> Value {
    let members: Vec<&Email> = a.emails.values().filter(|e| e.mailbox_ids.contains(&m.id)).collect();
    let total = members.len();
    let unread = members.iter().filter(|e| !e.keywords.contains("$seen")).count();
    json!({
        "id": m.id, "name": m.name, "parentId": m.parent_id, "role": m.role, "sortOrder": m.sort_order,
        "totalEmails": total, "unreadEmails": unread, "totalThreads": total, "unreadThreads": unread,
        "isSubscribed": m.is_subscribed,
        "myRights": {"mayReadItems": true, "mayAddItems": true, "mayRemoveItems": true, "maySetSeen": true,
                     "maySetKeywords": true, "mayCreateChild": true, "mayRename": true, "mayDelete": true, "maySubmit": true},
    })
}

/// Keep only `props` (plus "id") when a property list was given.
fn pick(v: Value, props: &Option<Vec<String>>) -> Value {
    let (Some(props), Value::Object(m)) = (props, &v) else { return v };
    Value::Object(m.iter().filter(|(k, _)| *k == "id" || props.contains(k)).map(|(k, v)| (k.clone(), v.clone())).collect())
}

fn mailbox_get(state: &State, acc: &str, args: &Args) -> Result<Value, MErr> {
    let a = state.account(acc);
    let props = ids_arg(args, "properties")?;
    let ids = match ids_arg(args, "ids")? {
        Some(ids) => {
            check_get_size(state, ids.len())?;
            ids
        }
        None => a.mailboxes.keys().cloned().collect(),
    };
    let (mut list, mut not_found) = (vec![], vec![]);
    for id in ids {
        match a.mailboxes.get(&id) {
            Some(m) => list.push(pick(mailbox_json(a, m), &props)),
            None => not_found.push(id),
        }
    }
    Ok(json!({"accountId": acc, "state": a.mailbox_state.to_string(), "list": list, "notFound": not_found}))
}

/// `"#creationId"` (created earlier in this call) or a real id; `null` = top level.
fn parent_ref(v: &Value, created: &HashMap<String, String>) -> Result<Option<String>, SetError> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) => match s.strip_prefix('#') {
            Some(c) => created.get(c).cloned().map(Some).ok_or_else(|| SetError::props("invalidProperties", &["parentId"])),
            None => Ok(Some(s.clone())),
        },
        _ => Err(SetError::props("invalidProperties", &["parentId"])),
    }
}

/// Parent must exist, must not be the mailbox itself or below it, and no sibling may share the name.
fn check_placement(a: &Account, id: Option<&str>, m: &Mailbox) -> Result<(), SetError> {
    let mut cur = m.parent_id.clone();
    while let Some(p) = cur {
        if Some(p.as_str()) == id {
            return Err(SetError::props("invalidProperties", &["parentId"]).describe("would create a cycle"));
        }
        cur = match a.mailboxes.get(&p) {
            Some(parent) => parent.parent_id.clone(),
            None => return Err(SetError::props("invalidProperties", &["parentId"]).describe(format!("no mailbox {p}"))),
        };
    }
    if a.mailboxes.values().any(|o| Some(o.id.as_str()) != id && o.parent_id == m.parent_id && o.name == m.name) {
        return Err(SetError::props("invalidProperties", &["name"]).describe("a sibling already has this name"));
    }
    Ok(())
}

fn mailbox_create(a: &mut Account, spec: &Value, created: &HashMap<String, String>) -> Result<String, SetError> {
    let name = spec["name"]
        .as_str()
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| SetError::props("invalidProperties", &["name"]))?
        .to_string();
    let role = spec["role"].as_str().map(str::to_string);
    if role.is_some() && a.mailboxes.values().any(|m| m.role == role) {
        return Err(SetError::props("invalidProperties", &["role"]).describe("role already taken"));
    }
    let mut m = Mailbox {
        id: String::new(),
        name,
        parent_id: parent_ref(spec.get("parentId").unwrap_or(&Value::Null), created)?,
        role,
        sort_order: spec["sortOrder"].as_u64().unwrap_or(0) as u32,
        is_subscribed: spec["isSubscribed"].as_bool().unwrap_or(true),
    };
    check_placement(a, None, &m)?;
    m.id = a.new_id("MB");
    let id = m.id.clone();
    a.mailboxes.insert(id.clone(), m);
    a.record(Kind::Mailbox, &id, Op::Created, false);
    Ok(id)
}

fn mailbox_update(a: &mut Account, id: &str, patch: &Value, created: &HashMap<String, String>) -> Result<(), SetError> {
    let old = a.mailboxes.get(id).cloned().ok_or_else(|| SetError::new("notFound"))?;
    let obj = patch.as_object().ok_or_else(|| SetError::new("invalidPatch"))?;
    let mut m = old.clone();
    for (k, v) in obj {
        match k.as_str() {
            "name" => {
                m.name = v
                    .as_str()
                    .filter(|n| !n.trim().is_empty())
                    .ok_or_else(|| SetError::props("invalidProperties", &["name"]))?
                    .to_string()
            }
            "parentId" => m.parent_id = parent_ref(v, created)?,
            "sortOrder" => m.sort_order = v.as_u64().ok_or_else(|| SetError::props("invalidProperties", &["sortOrder"]))? as u32,
            "isSubscribed" => m.is_subscribed = v.as_bool().ok_or_else(|| SetError::props("invalidProperties", &["isSubscribed"]))?,
            "role" => m.role = v.as_str().map(str::to_string),
            other => return Err(SetError::props("invalidProperties", &[other])),
        }
    }
    check_placement(a, Some(id), &m)?;
    if m != old {
        a.mailboxes.insert(id.to_string(), m);
        a.record(Kind::Mailbox, id, Op::Updated, false);
    }
    Ok(())
}

fn mailbox_destroy(a: &mut Account, id: &str, remove_emails: bool) -> Result<(), SetError> {
    if !a.mailboxes.contains_key(id) {
        return Err(SetError::new("notFound"));
    }
    if a.mailboxes.values().any(|m| m.parent_id.as_deref() == Some(id)) {
        return Err(SetError::new("mailboxHasChild"));
    }
    let members: Vec<(String, BTreeSet<String>)> =
        a.emails.values().filter(|e| e.mailbox_ids.contains(id)).map(|e| (e.id.clone(), e.mailbox_ids.clone())).collect();
    if !members.is_empty() && !remove_emails {
        return Err(SetError::new("mailboxHasEmail"));
    }
    for (eid, mut mbs) in members {
        if mbs.len() == 1 {
            a.remove_email(&eid);
        } else {
            mbs.remove(id);
            a.update_email(&eid, None, Some(mbs))?;
        }
    }
    a.mailboxes.remove(id);
    a.record(Kind::Mailbox, id, Op::Destroyed, false);
    Ok(())
}

fn mailbox_set(state: &mut State, acc: &str, args: &Args) -> Result<Value, MErr> {
    let create = obj_arg(args, "create")?;
    let update = obj_arg(args, "update")?;
    let destroy = ids_arg(args, "destroy")?.unwrap_or_default();
    check_set_size(state, create.len() + update.len() + destroy.len())?;
    let remove_emails = args.get("onDestroyRemoveEmails") == Some(&Value::Bool(true));
    let a = state.account_mut(acc);
    check_if_in_state(args, a.mailbox_state)?;
    let old = a.mailbox_state.to_string();
    let mut ids_by_creation: HashMap<String, String> = HashMap::new();
    let (mut created, mut not_created) = (Map::new(), Map::new());
    // Create parents first: a `parentId: "#k"` waits until creation `k` has been tried.
    let mut pending: Vec<(&String, &Value)> = create.iter().collect();
    while !pending.is_empty() {
        let waits = |spec: &Value| {
            spec["parentId"].as_str().and_then(|p| p.strip_prefix('#')).is_some_and(|c| pending.iter().any(|(k, _)| *k == c))
        };
        let next = pending.iter().position(|(_, spec)| !waits(spec)).unwrap_or(0);
        let (k, spec) = pending.remove(next);
        match mailbox_create(a, spec, &ids_by_creation) {
            Ok(id) => {
                created.insert(k.clone(), json!({"id": id, "totalEmails": 0, "unreadEmails": 0, "totalThreads": 0, "unreadThreads": 0}));
                ids_by_creation.insert(k.clone(), id);
            }
            Err(e) => {
                not_created.insert(k.clone(), e.to_json());
            }
        }
    }
    let (mut updated, mut not_updated) = (Map::new(), Map::new());
    for (id, patch) in &update {
        match mailbox_update(a, id, patch, &ids_by_creation) {
            Ok(()) => updated.insert(id.clone(), Value::Null),
            Err(e) => not_updated.insert(id.clone(), e.to_json()),
        };
    }
    let (mut destroyed, mut not_destroyed) = (vec![], Map::new());
    for id in destroy {
        match mailbox_destroy(a, &id, remove_emails) {
            Ok(()) => destroyed.push(id),
            Err(e) => {
                not_destroyed.insert(id, e.to_json());
            }
        }
    }
    Ok(json!({
        "accountId": acc, "oldState": old, "newState": a.mailbox_state.to_string(),
        "created": nz(created), "updated": nz(updated), "destroyed": nz_vec(destroyed),
        "notCreated": nz(not_created), "notUpdated": nz(not_updated), "notDestroyed": nz(not_destroyed),
    }))
}

// ── */changes ───────────────────────────────────────────────────────────────

fn changes(state: &State, acc: &str, args: &Args, kind: Kind) -> Result<Value, MErr> {
    if state.faults.contains(&Fault::CannotCalculateChanges) {
        return Err(merr("cannotCalculateChanges", "injected CannotCalculateChanges"));
    }
    let since = args.get("sinceState").and_then(Value::as_str).ok_or_else(|| merr("invalidArguments", "sinceState missing"))?;
    let max = match args.get("maxChanges") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_u64() {
            Some(n) if n > 0 => Some(n as usize),
            _ => return Err(merr("invalidArguments", "maxChanges must be a positive integer")),
        },
    };
    let c = state
        .account(acc)
        .changes(kind, since, max)
        .ok_or_else(|| merr("cannotCalculateChanges", format!("unknown or expired state {since}")))?;
    let mut r = json!({
        "accountId": acc, "oldState": since, "newState": c.new_state, "hasMoreChanges": c.has_more,
        "created": c.created, "updated": c.updated, "destroyed": c.destroyed,
    });
    if kind == Kind::Mailbox {
        r["updatedProperties"] = if c.counts_only { json!(COUNT_PROPS) } else { Value::Null };
    }
    Ok(r)
}

// ── Email/get, Email/query ──────────────────────────────────────────────────

fn email_json(e: &Email, raw: &[u8], props: &Option<Vec<String>>) -> Value {
    let wanted: Vec<String> = match props {
        Some(p) => p.clone(),
        None => EMAIL_PROPS.iter().map(|s| s.to_string()).collect(),
    };
    let msg = Msg::parse(raw);
    let mut m = Map::new();
    m.insert("id".into(), json!(e.id));
    for p in wanted {
        let v = match p.as_str() {
            "id" => continue,
            "blobId" => json!(e.blob_id),
            "threadId" => json!(format!("T{}", e.id)),
            "mailboxIds" => set_to_obj(&e.mailbox_ids),
            "keywords" => set_to_obj(&e.keywords),
            "size" => json!(e.size),
            "receivedAt" => json!(e.received_at),
            "messageId" => msg.ids("Message-ID"),
            "inReplyTo" => msg.ids("In-Reply-To"),
            "references" => msg.ids("References"),
            "sender" => msg.addrs("Sender"),
            "from" => msg.addrs("From"),
            "to" => msg.addrs("To"),
            "cc" => msg.addrs("Cc"),
            "bcc" => msg.addrs("Bcc"),
            "replyTo" => msg.addrs("Reply-To"),
            "subject" => msg.text("Subject"),
            "sentAt" => msg.sent_at(),
            "hasAttachment" => json!(msg.has_attachment),
            "preview" => json!(msg.preview()),
            h => match h.strip_prefix("header:") {
                Some(spec) => msg.header_prop(spec),
                None => continue,
            },
        };
        m.insert(p, v);
    }
    Value::Object(m)
}

fn email_get(state: &State, acc: &str, args: &Args) -> Result<Value, MErr> {
    let a = state.account(acc);
    let props = ids_arg(args, "properties")?;
    if let Some(bad) = props.iter().flatten().find(|p| !EMAIL_PROPS.contains(&p.as_str()) && !p.starts_with("header:")) {
        return Err(merr("invalidArguments", format!("unknown Email property {bad}")));
    }
    let ids = match ids_arg(args, "ids")? {
        Some(ids) => ids,
        None => a.emails.keys().cloned().collect(),
    };
    check_get_size(state, ids.len())?;
    let mut seen = HashSet::new();
    let (mut list, mut not_found) = (vec![], vec![]);
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        match a.emails.get(&id) {
            Some(e) => {
                let raw = state.blobs.get(&e.blob_id).map(Vec::as_slice).unwrap_or_default();
                list.push(email_json(e, raw, &props));
            }
            None => not_found.push(id),
        }
    }
    Ok(json!({"accountId": acc, "state": a.email_state.to_string(), "list": list, "notFound": not_found}))
}

/// FilterOperator / FilterCondition (RFC 8621 §4.4.1). Unknown conditions -> unsupportedFilter.
fn matches(e: &Email, msg: &Msg, f: &Value) -> Result<bool, MErr> {
    let obj = f.as_object().ok_or_else(|| merr("invalidArguments", "filter must be an object"))?;
    if let Some(op) = obj.get("operator") {
        let conds = obj
            .get("conditions")
            .and_then(Value::as_array)
            .ok_or_else(|| merr("invalidArguments", "operator without conditions"))?;
        let mut results = Vec::with_capacity(conds.len());
        for c in conds {
            results.push(matches(e, msg, c)?);
        }
        return match op.as_str() {
            Some("AND") => Ok(results.iter().all(|x| *x)),
            Some("OR") => Ok(results.iter().any(|x| *x)),
            Some("NOT") => Ok(!results.iter().any(|x| *x)),
            _ => Err(merr("unsupportedFilter", "unknown operator")),
        };
    }
    for (k, v) in obj {
        let s = v.as_str().unwrap_or_default();
        let ok = match k.as_str() {
            "inMailbox" => e.mailbox_ids.contains(s),
            "inMailboxOtherThan" => {
                let not: Vec<&str> = v.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                e.mailbox_ids.iter().any(|m| !not.contains(&m.as_str()))
            }
            "before" => e.received_at.as_str() < s,
            "after" => e.received_at.as_str() >= s,
            "minSize" => e.size >= v.as_u64().unwrap_or(0),
            "maxSize" => e.size < v.as_u64().unwrap_or(u64::MAX),
            "hasKeyword" => e.keywords.contains(&s.to_ascii_lowercase()),
            "notKeyword" => !e.keywords.contains(&s.to_ascii_lowercase()),
            "text" => ["From", "To", "Cc", "Bcc", "Subject"].iter().any(|h| msg.contains(h, s)) || ci_contains(&msg.body_text, s),
            "from" => msg.contains("From", s),
            "to" => msg.contains("To", s),
            "cc" => msg.contains("Cc", s),
            "bcc" => msg.contains("Bcc", s),
            "subject" => msg.contains("Subject", s),
            "body" => ci_contains(&msg.body_text, s),
            "header" => {
                let parts: Vec<&str> = v.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                match parts.as_slice() {
                    [name] => msg.first(name).is_some(),
                    [name, needle] => msg.contains(name, needle),
                    _ => return Err(merr("invalidArguments", "header filter takes 1 or 2 strings")),
                }
            }
            other => return Err(merr("unsupportedFilter", format!("filter {other}"))),
        };
        if !ok {
            return Ok(false);
        }
    }
    Ok(true)
}

fn email_query(state: &State, acc: &str, args: &Args) -> Result<Value, MErr> {
    let a = state.account(acc);
    let filter = args.get("filter").cloned().unwrap_or(Value::Null);
    let mut hits: Vec<&Email> = Vec::new();
    for e in a.emails.values() {
        let raw = state.blobs.get(&e.blob_id).map(Vec::as_slice).unwrap_or_default();
        if filter.is_null() || matches(e, &Msg::parse(raw), &filter)? {
            hits.push(e);
        }
    }
    // Default and only supported sort: receivedAt (descending unless isAscending: true).
    let ascending = match args.get("sort").and_then(Value::as_array).and_then(|s| s.first()) {
        None => false,
        Some(c) if c["property"] == "receivedAt" => c["isAscending"].as_bool().unwrap_or(true),
        Some(c) => return Err(merr("unsupportedSort", format!("sort by {}", c["property"]))),
    };
    hits.sort_by(|x, y| (&x.received_at, &x.id).cmp(&(&y.received_at, &y.id)));
    if !ascending {
        hits.reverse();
    }
    let total = hits.len();
    let position = match args.get("position").and_then(Value::as_i64).unwrap_or(0) {
        p if p < 0 => (total as i64 + p).max(0) as usize,
        p => (p as usize).min(total),
    };
    let cap = state.limits.max_query_limit;
    let requested = args.get("limit").and_then(Value::as_u64).map(|l| l as usize);
    let limit = requested.unwrap_or(cap).min(cap);
    let ids: Vec<&str> = hits[position..].iter().take(limit).map(|e| e.id.as_str()).collect();
    let mut r = json!({
        "accountId": acc, "queryState": a.email_state.to_string(), "canCalculateChanges": false,
        "position": position, "ids": ids,
    });
    if args.get("calculateTotal") == Some(&Value::Bool(true)) {
        r["total"] = json!(total);
    }
    if requested.map_or(total > cap, |l| l > cap) {
        r["limit"] = json!(cap);
    }
    Ok(r)
}

// ── Email/set, Email/import ─────────────────────────────────────────────────

fn toggle(set: &mut BTreeSet<String>, key: String, v: &Value, prop: &str) -> Result<(), SetError> {
    match v {
        Value::Bool(true) => {
            set.insert(key);
        }
        Value::Null => {
            set.remove(&key);
        }
        _ => return Err(SetError::props("invalidPatch", &[prop])),
    }
    Ok(())
}

/// Apply an Email/set PatchObject: full `keywords` / `mailboxIds`, or
/// `keywords/<k>` and `mailboxIds/<id>` set to `true` or `null`.
pub fn apply_email_patch(a: &mut Account, id: &str, patch: &Value) -> Result<(), SetError> {
    let cur = a.emails.get(id).ok_or_else(|| SetError::new("notFound"))?;
    let obj = patch.as_object().ok_or_else(|| SetError::new("invalidPatch"))?;
    let (mut kw, mut mbs) = (cur.keywords.clone(), cur.mailbox_ids.clone());
    for (path, v) in obj {
        if path == "keywords" {
            kw = set_from_obj(v).ok_or_else(|| SetError::props("invalidProperties", &["keywords"]))?;
        } else if path == "mailboxIds" {
            mbs = set_from_obj(v).ok_or_else(|| SetError::props("invalidProperties", &["mailboxIds"]))?;
        } else if let Some(k) = path.strip_prefix("keywords/") {
            toggle(&mut kw, unescape(k).to_ascii_lowercase(), v, "keywords")?;
        } else if let Some(m) = path.strip_prefix("mailboxIds/") {
            toggle(&mut mbs, unescape(m), v, "mailboxIds")?;
        } else {
            return Err(SetError::props("invalidProperties", &[path.as_str()]));
        }
    }
    a.update_email(id, Some(kw), Some(mbs))
}

fn email_set(state: &mut State, acc: &str, args: &Args) -> Result<Value, MErr> {
    let create = obj_arg(args, "create")?;
    let update = obj_arg(args, "update")?;
    let destroy = ids_arg(args, "destroy")?.unwrap_or_default();
    check_set_size(state, create.len() + update.len() + destroy.len())?;
    let a = state.account_mut(acc);
    check_if_in_state(args, a.email_state)?;
    let old = a.email_state.to_string();
    let mut not_created = Map::new();
    for k in create.keys() {
        let e = SetError::new("forbidden").describe("mock-jmap does not support Email/set create; use Email/import");
        not_created.insert(k.clone(), e.to_json());
    }
    let (mut updated, mut not_updated) = (Map::new(), Map::new());
    for (id, patch) in &update {
        match apply_email_patch(a, id, patch) {
            Ok(()) => updated.insert(id.clone(), Value::Null),
            Err(e) => not_updated.insert(id.clone(), e.to_json()),
        };
    }
    let (mut destroyed, mut not_destroyed) = (vec![], Map::new());
    for id in destroy {
        if a.remove_email(&id) {
            destroyed.push(id);
        } else {
            not_destroyed.insert(id, SetError::new("notFound").to_json());
        }
    }
    Ok(json!({
        "accountId": acc, "oldState": old, "newState": a.email_state.to_string(),
        "created": Value::Null, "updated": nz(updated), "destroyed": nz_vec(destroyed),
        "notCreated": nz(not_created), "notUpdated": nz(not_updated), "notDestroyed": nz(not_destroyed),
    }))
}

fn import_one(state: &mut State, acc: &str, spec: &Value) -> Result<Value, SetError> {
    let blob_id = spec["blobId"].as_str().ok_or_else(|| SetError::props("invalidProperties", &["blobId"]))?;
    let mut raw = state
        .blobs
        .get(blob_id)
        .cloned()
        .ok_or_else(|| SetError::new("blobNotFound").with("notFound", json!([blob_id])))?;
    let mailbox_ids = set_from_obj(&spec["mailboxIds"])
        .filter(|s| !s.is_empty())
        .ok_or_else(|| SetError::props("invalidProperties", &["mailboxIds"]))?;
    let keywords: BTreeSet<String> = match spec.get("keywords") {
        None | Some(Value::Null) => BTreeSet::new(),
        Some(v) => set_from_obj(v).ok_or_else(|| SetError::props("invalidProperties", &["keywords"]))?,
    };
    {
        let a = state.account(acc);
        if mailbox_ids.iter().any(|m| !a.mailboxes.contains_key(m)) {
            return Err(SetError::props("invalidProperties", &["mailboxIds"]));
        }
        if state.faults.contains(&Fault::ImportAlreadyExists) {
            if let Some(mid) = message_id_of(&raw) {
                let existing = a.emails.values().find(|e| {
                    state.blobs.get(&e.blob_id).and_then(|r| message_id_of(r)).as_deref() == Some(mid.as_str())
                });
                if let Some(e) = existing {
                    return Err(SetError::new("alreadyExists")
                        .describe(format!("Message-ID <{mid}> is already in this account"))
                        .with("existingId", json!(e.id)));
                }
            }
        }
    }
    if state.faults.contains(&Fault::ImportRepairs) {
        raw.extend_from_slice(b"\r\n");
    }
    let received_at = spec["receivedAt"].as_str().map(str::to_string).unwrap_or_else(now_iso);
    let size = raw.len() as u64;
    let blob = state.store_blob(raw);
    let a = state.account_mut(acc);
    let id = a.new_id("M");
    a.insert_email(Email {
        id: id.clone(),
        blob_id: blob.clone(),
        mailbox_ids,
        keywords: keywords.iter().map(|k| k.to_ascii_lowercase()).collect(),
        received_at,
        size,
    });
    Ok(json!({"id": id, "blobId": blob, "threadId": format!("T{id}"), "size": size}))
}

fn email_import(state: &mut State, acc: &str, args: &Args) -> Result<Value, MErr> {
    let emails = obj_arg(args, "emails")?;
    check_set_size(state, emails.len())?;
    check_if_in_state(args, state.account(acc).email_state)?;
    let old = state.account(acc).email_state.to_string();
    let (mut created, mut not_created) = (Map::new(), Map::new());
    for (k, spec) in &emails {
        match import_one(state, acc, spec) {
            Ok(v) => created.insert(k.clone(), v),
            Err(e) => not_created.insert(k.clone(), e.to_json()),
        };
    }
    Ok(json!({
        "accountId": acc, "oldState": old, "newState": state.account(acc).email_state.to_string(),
        "created": nz(created), "notCreated": nz(not_created),
    }))
}

// ── Identity, EmailSubmission ───────────────────────────────────────────────

fn identity_get(state: &State, acc: &str, args: &Args) -> Result<Value, MErr> {
    let a = state.account(acc);
    let ids = ids_arg(args, "ids")?;
    let mut list = vec![];
    for i in &a.identities {
        if ids.as_ref().map_or(true, |ids| ids.contains(&i.id)) {
            list.push(json!({"id": i.id, "name": i.name, "email": i.email, "replyTo": null, "bcc": null,
                             "textSignature": "", "htmlSignature": "", "mayDelete": false}));
        }
    }
    let not_found: Vec<String> =
        ids.unwrap_or_default().into_iter().filter(|id| !a.identities.iter().any(|i| &i.id == id)).collect();
    Ok(json!({"accountId": acc, "state": "1", "list": list, "notFound": not_found}))
}

/// Validate and "send" one submission. Returns (submission id, email id).
fn submit_one(state: &mut State, acc: &str, spec: &Value) -> Result<(String, String), SetError> {
    let email_id = spec["emailId"].as_str().ok_or_else(|| SetError::props("invalidProperties", &["emailId"]))?.to_string();
    let identity_id = spec["identityId"].as_str().ok_or_else(|| SetError::props("invalidProperties", &["identityId"]))?;
    let raw = {
        let a = state.account(acc);
        let e = a
            .emails
            .get(&email_id)
            .ok_or_else(|| SetError::props("invalidProperties", &["emailId"]).describe("no such Email"))?;
        let ident = a
            .identities
            .iter()
            .find(|i| i.id == identity_id)
            .ok_or_else(|| SetError::props("invalidProperties", &["identityId"]).describe("no such Identity"))?;
        if state.faults.contains(&Fault::SubmissionRejected) {
            return Err(SetError::new("forbiddenFrom").describe(format!("may not send as {}", ident.email)));
        }
        state.blobs.get(&e.blob_id).cloned().unwrap_or_default()
    };
    let has_rcpt = match spec.get("envelope") {
        Some(env) if !env.is_null() => env["rcptTo"].as_array().is_some_and(|r| !r.is_empty()),
        _ => {
            let m = Msg::parse(&raw);
            ["To", "Cc", "Bcc"].iter().any(|h| m.first(h).is_some_and(|v| !v.1.trim().is_empty()))
        }
    };
    if !has_rcpt {
        return Err(SetError::new("noRecipients"));
    }
    state.submitted.push(raw);
    let a = state.account_mut(acc);
    let sid = a.new_id("S");
    a.submission_state += 1;
    a.submissions.insert(sid.clone(), email_id.clone());
    Ok((sid, email_id))
}

/// EmailSubmission/set create, then the implicit Email/set for `onSuccessUpdateEmail` /
/// `onSuccessDestroyEmail` as a second response with the same tag (RFC 8621 §7.5).
fn email_submission_set(state: &mut State, acc: &str, args: &Args) -> Out {
    let create = obj_arg(args, "create")?;
    let update = obj_arg(args, "update")?;
    let destroy = ids_arg(args, "destroy")?.unwrap_or_default();
    check_set_size(state, create.len() + update.len() + destroy.len())?;
    let old = state.account(acc).submission_state.to_string();
    let (mut created, mut not_created) = (Map::new(), Map::new());
    let mut email_by_creation: HashMap<String, String> = HashMap::new();
    for (k, spec) in &create {
        match submit_one(state, acc, spec) {
            Ok((sid, email_id)) => {
                created.insert(k.clone(), json!({"id": sid, "undoStatus": "final", "sendAt": now_iso()}));
                email_by_creation.insert(k.clone(), email_id);
            }
            Err(e) => {
                not_created.insert(k.clone(), e.to_json());
            }
        }
    }
    // Submissions are final the moment they are created: nothing to update or cancel.
    let not_updated: Args = update.keys().map(|k| (k.clone(), SetError::new("notFound").to_json())).collect();
    let not_destroyed: Args = destroy.iter().map(|k| (k.clone(), SetError::new("notFound").to_json())).collect();
    let a = state.account(acc);
    let sub = json!({
        "accountId": acc, "oldState": old, "newState": a.submission_state.to_string(),
        "created": nz(created), "updated": Value::Null, "destroyed": Value::Null,
        "notCreated": nz(not_created), "notUpdated": nz(not_updated), "notDestroyed": nz(not_destroyed),
    });
    let email_for = |key: &str| match key.strip_prefix('#') {
        Some(c) => email_by_creation.get(c).cloned(),
        None => a.submissions.get(key).cloned(),
    };
    let mut patches = Map::new();
    for (key, patch) in obj_arg(args, "onSuccessUpdateEmail")? {
        if let Some(email) = email_for(&key) {
            patches.insert(email, patch);
        }
    }
    let destroys: Vec<Value> =
        ids_arg(args, "onSuccessDestroyEmail")?.unwrap_or_default().iter().filter_map(|k| email_for(k)).map(Value::String).collect();
    let mut out = vec![("EmailSubmission/set".to_string(), sub)];
    if !patches.is_empty() || !destroys.is_empty() {
        let mut eargs = Map::new();
        eargs.insert("accountId".into(), json!(acc));
        eargs.insert("update".into(), Value::Object(patches));
        eargs.insert("destroy".into(), Value::Array(destroys));
        out.push(("Email/set".to_string(), email_set(state, acc, &eargs)?));
    }
    Ok(out)
}
