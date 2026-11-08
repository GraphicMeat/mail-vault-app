//! A routed Microsoft Graph on this machine for the engine's Graph tests.
//!
//! Core reads `MAILVAULT_GRAPH_BASE` once per process, so one mock serves the whole test binary:
//! [`mock`] starts it on first use and points the variable at it, and every test holds [`serial`]
//! for its whole run and calls [`GraphMock::reset`] first. The same listener answers the OAuth
//! token endpoint at `/oauth/token` (`Engine::set_oauth_token_endpoint`), backed by mock-imap's
//! [`TokenAuthority`]; every other request must carry a bearer token that authority issued and
//! still honours, or it gets Graph's 401.
//!
//! Strict where core could slip: ids end in `=` and paths are percent-decoded, so an id sent raw or
//! encoded both resolve, while a folder named by anything but its id or its lowercase well-known
//! name (`INBOX` included) is a 404; and the attachments collection answers 400 to a `$select` of
//! any property the base `attachment` type lacks (`contentId`, `contentBytes`), as Graph does.

#![allow(dead_code)]

use base64::Engine as _;
use mock_imap::oauth::{GrantSpec, TokenAuthority};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

/// Every Graph test holds this for its whole run.
pub fn serial() -> MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Clone, Debug)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// `inbox`, `deleteditems`, `sentitems`, ...
    pub well_known: Option<String>,
    pub parent: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Msg {
    pub id: String,
    pub folder: String,
    pub subject: String,
    pub from: String,
    pub received_ms: i64,
    /// `lastModifiedDateTime`: set on arrival, moved on by every change.
    pub modified_ms: i64,
    pub is_read: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    pub internet_message_id: String,
    /// `replyTo`'s one address, if any.
    pub reply_to: Option<String>,
    /// The body as Graph serves it (HTML).
    pub body_html: String,
    pub attachments: Vec<Att>,
}

#[derive(Clone, Debug)]
pub struct Att {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub inline: bool,
    pub content_id: Option<String>,
    /// `fileAttachment`, `itemAttachment` or `referenceAttachment`.
    pub odata: &'static str,
}

/// The properties of Graph's base `attachment` type, the only ones its collection can `$select`.
const ATTACHMENT_PROPS: &[&str] = &["id", "name", "contentType", "size", "isInline", "lastModifiedDateTime"];

#[derive(Default)]
pub struct State {
    pub folders: Vec<Folder>,
    pub messages: Vec<Msg>,
    /// `METHOD /decoded/path?query`, in arrival order.
    pub requests: Vec<String>,
    /// The next requests (token endpoint aside) answer 429 with this `Retry-After`.
    pub throttle: VecDeque<u64>,
    /// Decoded MIME of every `sendMail`.
    pub sent: Vec<Vec<u8>>,
    /// Authorization code -> nothing (any known code signs in as `me`).
    pub codes: Vec<String>,
    /// The address `/me` names.
    pub me: String,
    /// Every Graph request is refused with 401, valid tokens too.
    pub refuse_tokens: bool,
    /// `sendMail` reads the whole request, then closes the connection with no answer.
    pub drop_send: bool,
    /// `(n, folder id)`: after `n` more successful moves, the folder is deleted.
    pub delete_after_moves: Option<(u32, String)>,
    /// Listing a message's attachments answers 503.
    pub fail_attachments: bool,
    /// `(n, k)`: after `n` more successful moves, the next `k` moves answer 503.
    pub fail_moves_after: Option<(u32, u32)>,
    /// An attachment's `$value` is written 64 KiB at a time with this pause between.
    pub slow_value_ms: u64,
    /// A folder's message listing answers after this pause (a slow network, page by page).
    pub list_pause_ms: u64,
    next_id: u64,
}

impl State {
    fn new_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{:04}=", self.next_id)
    }

    /// A folder by its id or its well-known name (lowercase only, as Graph documents it).
    fn folder(&self, key: &str) -> Option<&Folder> {
        self.folders.iter().find(|f| f.id == key || f.well_known.as_deref() == Some(key))
    }
}

pub struct GraphMock {
    addr: SocketAddr,
    pub state: Arc<Mutex<State>>,
    pub authority: TokenAuthority,
}

/// The process's one mock; sets `MAILVAULT_GRAPH_BASE` before any engine reads it.
pub fn mock() -> &'static GraphMock {
    static MOCK: OnceLock<GraphMock> = OnceLock::new();
    MOCK.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::env::set_var("MAILVAULT_GRAPH_BASE", format!("http://{addr}"));
        let state: Arc<Mutex<State>> = Arc::default();
        let authority = TokenAuthority::new();
        let (s, a) = (Arc::clone(&state), authority.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let (s, a) = (Arc::clone(&s), a.clone());
                std::thread::spawn(move || {
                    let _ = serve(conn, &s, &a, addr);
                });
            }
        });
        GraphMock { addr, state, authority }
    })
}

/// Epoch ms -> `2026-01-05T10:00:00Z`.
pub fn rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// `2026-01-05T10:00:00Z` (fraction allowed) -> epoch ms.
fn parse_rfc3339(s: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + hh * 3600 + mm * 60 + ss) * 1000)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| percent_decode(k) == key).map(|(_, v)| percent_decode(&v.replace('+', " ")))
}

fn form_field(form: &str, key: &str) -> String {
    query_param(form, key).unwrap_or_default()
}

impl GraphMock {
    pub fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn token_endpoint(&self) -> String {
        format!("{}/oauth/token", self.origin())
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A mailbox with the six default folders and nothing in them; `me` is its address.
    pub fn reset(&self, me: &str) {
        let mut st = self.st();
        *st = State { me: me.to_string(), ..State::default() };
        for (wk, name) in [
            ("inbox", "Posteingang"),
            ("sentitems", "Gesendete Elemente"),
            ("drafts", "Entwürfe"),
            ("deleteditems", "Gelöschte Elemente"),
            ("junkemail", "Junk-E-Mail"),
            ("archive", "Archiv"),
        ] {
            let id = st.new_id(&format!("fld-{wk}"));
            st.folders.push(Folder { id, name: name.into(), well_known: Some(wk.into()), parent: None });
        }
    }

    /// The id of a default folder.
    pub fn folder_id(&self, well_known: &str) -> String {
        self.st().folder(well_known).unwrap_or_else(|| panic!("no folder {well_known}")).id.clone()
    }

    /// A user folder under `parent` (an id) or at the top; its id.
    pub fn add_folder(&self, name: &str, parent: Option<&str>) -> String {
        let mut st = self.st();
        let id = st.new_id("fld-user");
        st.folders.push(Folder { id: id.clone(), name: name.into(), well_known: None, parent: parent.map(String::from) });
        id
    }

    /// A message in `folder` (an id or well-known name); its id.
    pub fn add_message(&self, folder: &str, subject: &str, received_ms: i64, body_html: &str) -> String {
        let mut st = self.st();
        let folder = st.folder(folder).unwrap_or_else(|| panic!("no folder {folder}")).id.clone();
        let id = st.new_id("msg");
        let n = st.next_id;
        st.messages.push(Msg {
            id: id.clone(),
            folder,
            subject: subject.into(),
            from: "alice@example.com".into(),
            received_ms,
            modified_ms: received_ms,
            is_read: false,
            flagged: false,
            has_attachments: false,
            internet_message_id: format!("<m{n}@example.com>"),
            reply_to: None,
            body_html: body_html.to_string(),
            attachments: Vec::new(),
        });
        id
    }

    /// A file attachment of message `msg`; its id.
    pub fn add_attachment(&self, msg: &str, name: &str, content_type: &str, bytes: Vec<u8>, inline: bool, content_id: Option<&str>) -> String {
        self.add_typed(msg, "fileAttachment", name, content_type, bytes, inline, content_id)
    }

    /// An attachment of `odata` type (`itemAttachment`: an attached message;
    /// `referenceAttachment`: a cloud link, whose `$value` Graph refuses); its id.
    #[allow(clippy::too_many_arguments)]
    pub fn add_typed(&self, msg: &str, odata: &'static str, name: &str, content_type: &str, bytes: Vec<u8>, inline: bool, content_id: Option<&str>) -> String {
        let mut st = self.st();
        let id = st.new_id("att");
        let m = st.messages.iter_mut().find(|m| m.id == msg).unwrap_or_else(|| panic!("no message {msg}"));
        m.attachments.push(Att { id: id.clone(), name: name.into(), content_type: content_type.into(), bytes, inline, content_id: content_id.map(String::from), odata });
        m.has_attachments |= !inline;
        id
    }

    pub fn fail_attachments(&self, on: bool) {
        self.st().fail_attachments = on;
    }

    pub fn slow_value(&self, pause_ms: u64) {
        self.st().slow_value_ms = pause_ms;
    }

    pub fn slow_listing(&self, pause_ms: u64) {
        self.st().list_pause_ms = pause_ms;
    }

    /// A raw `GET path_and_query` with `token`: the status.
    pub fn raw_get(&self, path_and_query: &str, token: &str) -> u16 {
        let mut c = TcpStream::connect(self.addr).unwrap();
        write!(c, "GET {path_and_query} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").unwrap();
        let mut line = String::new();
        BufReader::new(c).read_line(&mut line).unwrap();
        line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    pub fn refuse_tokens(&self, on: bool) {
        self.st().refuse_tokens = on;
    }

    pub fn drop_send(&self, on: bool) {
        self.st().drop_send = on;
    }

    /// After `n` more successful moves, the next `k` moves answer 503 (a transient failure).
    pub fn fail_moves_after(&self, n: u32, k: u32) {
        self.st().fail_moves_after = Some((n, k));
    }

    /// Message `id`'s Reply-To.
    pub fn set_reply_to(&self, id: &str, address: &str) {
        if let Some(m) = self.st().messages.iter_mut().find(|m| m.id == id) {
            m.reply_to = Some(address.to_string());
        }
    }

    /// After `n` more successful moves, folder `id` is deleted (with what is in it).
    pub fn delete_folder_after_moves(&self, n: u32, id: &str) {
        self.st().delete_after_moves = Some((n, id.to_string()));
    }

    pub fn message(&self, id: &str) -> Option<Msg> {
        self.st().messages.iter().find(|m| m.id == id).cloned()
    }

    /// Messages in the folder `well_known_or_id`, oldest first.
    pub fn messages_in(&self, folder: &str) -> Vec<Msg> {
        let st = self.st();
        let id = st.folder(folder).map(|f| f.id.clone()).unwrap_or_default();
        let mut v: Vec<Msg> = st.messages.iter().filter(|m| m.folder == id).cloned().collect();
        v.sort_by_key(|m| m.received_ms);
        v
    }

    pub fn set_read(&self, id: &str, read: bool) {
        if let Some(m) = self.st().messages.iter_mut().find(|m| m.id == id) {
            m.is_read = read;
            m.modified_ms += 1000;
        }
    }

    pub fn requests(&self) -> Vec<String> {
        self.st().requests.clone()
    }

    /// Requests whose line contains `needle`.
    pub fn count(&self, needle: &str) -> usize {
        self.st().requests.iter().filter(|r| r.contains(needle)).count()
    }

    pub fn clear_requests(&self) {
        self.st().requests.clear();
    }

    /// The next `n` Graph requests answer 429 with `Retry-After: secs`.
    pub fn throttle(&self, n: usize, secs: u64) {
        let mut st = self.st();
        for _ in 0..n {
            st.throttle.push_back(secs);
        }
    }

    pub fn sent(&self) -> Vec<Vec<u8>> {
        self.st().sent.clone()
    }

    /// The next code exchange of `code` signs in as `me`.
    pub fn expect_code(&self, code: &str) {
        self.st().codes.push(code.to_string());
    }

    /// A grant the authority honours: `(refresh, access, expires_ms)`.
    pub fn grant(&self) -> (String, String, i64) {
        let s = self.authority.sign_in(GrantSpec { expires_in: 3600, ..GrantSpec::default() });
        (s.refresh_token, s.access_token, s.expires_at)
    }
}

fn folder_json(st: &State, f: &Folder) -> Value {
    let msgs: Vec<&Msg> = st.messages.iter().filter(|m| m.folder == f.id).collect();
    json!({
        "id": f.id,
        "displayName": f.name,
        "parentFolderId": f.parent,
        "totalItemCount": msgs.len(),
        "unreadItemCount": msgs.iter().filter(|m| !m.is_read).count(),
        "childFolderCount": st.folders.iter().filter(|c| c.parent.as_deref() == Some(f.id.as_str())).count(),
    })
}

fn message_json(m: &Msg, me: &str) -> Value {
    json!({
        "id": m.id,
        "subject": m.subject,
        "from": { "emailAddress": { "name": "Alice", "address": m.from } },
        "toRecipients": [{ "emailAddress": { "name": null, "address": me } }],
        "ccRecipients": [],
        "receivedDateTime": rfc3339(m.received_ms),
        "sentDateTime": rfc3339(m.received_ms),
        "lastModifiedDateTime": rfc3339(m.modified_ms),
        "isRead": m.is_read,
        "hasAttachments": m.has_attachments,
        "internetMessageId": m.internet_message_id,
        "replyTo": m.reply_to.iter().map(|a| json!({ "emailAddress": { "name": "Reply Desk", "address": a } })).collect::<Vec<_>>(),
        "flag": { "flagStatus": if m.flagged { "flagged" } else { "notFlagged" } },
        "parentFolderId": m.folder,
        "body": { "contentType": "html", "content": m.body_html },
        "bodyPreview": m.body_html.chars().take(255).collect::<String>(),
    })
}

fn not_found() -> (u16, Vec<u8>, Vec<(String, String)>) {
    let body = json!({ "error": { "code": "ErrorItemNotFound", "message": "The specified object was not found in the store." } });
    (404, body.to_string().into_bytes(), Vec::new())
}

fn ok_json(v: Value) -> (u16, Vec<u8>, Vec<(String, String)>) {
    (200, v.to_string().into_bytes(), Vec::new())
}

struct Request {
    method: String,
    path: String,
    query: String,
    bearer: Option<String>,
    body: Vec<u8>,
}

fn read_request(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let (raw_path, query) = target.split_once('?').map(|(p, q)| (p.to_string(), q.to_string())).unwrap_or((target.clone(), String::new()));
    let mut len = 0usize;
    let mut bearer = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("authorization") {
                bearer = v.trim().strip_prefix("Bearer ").map(str::to_string);
            }
        }
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(Request { method, path: percent_decode(&raw_path), query, bearer, body }))
}

fn serve(conn: TcpStream, state: &Mutex<State>, authority: &TokenAuthority, addr: SocketAddr) -> std::io::Result<()> {
    let mut out = conn.try_clone()?;
    let mut reader = BufReader::new(conn);
    // Keep-alive: reqwest reuses connections.
    while let Some(req) = read_request(&mut reader)? {
        let (status, body, headers) = answer(&req, state, authority, addr);
        if status == 0 {
            // Took the whole request, answers nothing: a connection lost after the upload.
            return Ok(());
        }
        let reason = match status {
            200 => "OK",
            201 => "Created",
            202 => "Accepted",
            204 => "No Content",
            400 => "Bad Request",
            401 => "Unauthorized",
            404 => "Not Found",
            429 => "Too Many Requests",
            503 => "Service Unavailable",
            _ => "X",
        };
        let mut head = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n", body.len());
        if !body.is_empty() && !headers.iter().any(|(k, _)| k == "Content-Type") {
            head.push_str("Content-Type: application/json\r\n");
        }
        let slow: u64 = headers.iter().find(|(k, _)| k == "X-Mock-Slow-Ms").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
        let delay: u64 = headers.iter().find(|(k, _)| k == "X-Mock-Delay-Ms").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
        if delay > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
        for (k, v) in headers.iter().filter(|(k, _)| k != "X-Mock-Slow-Ms" && k != "X-Mock-Delay-Ms") {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        out.write_all(head.as_bytes())?;
        if slow > 0 {
            for piece in body.chunks(64 * 1024) {
                out.write_all(piece)?;
                out.flush()?;
                std::thread::sleep(std::time::Duration::from_millis(slow));
            }
        } else {
            out.write_all(&body)?;
        }
        out.flush()?;
    }
    Ok(())
}

fn answer(req: &Request, state: &Mutex<State>, authority: &TokenAuthority, addr: SocketAddr) -> (u16, Vec<u8>, Vec<(String, String)>) {
    let line = if req.query.is_empty() { format!("{} {}", req.method, req.path) } else { format!("{} {}?{}", req.method, req.path, percent_decode(&req.query)) };
    if req.path == "/oauth/token" {
        let form = String::from_utf8_lossy(&req.body).into_owned();
        if form_field(&form, "grant_type") == "authorization_code" {
            let code = form_field(&form, "code");
            let known = {
                let mut st = state.lock().unwrap_or_else(|p| p.into_inner());
                st.requests.push("POST /oauth/token code".into());
                let i = st.codes.iter().position(|c| *c == code);
                i.map(|i| st.codes.remove(i)).is_some()
            };
            if !known {
                return (400, json!({ "error": "invalid_grant", "error_description": "bad code" }).to_string().into_bytes(), Vec::new());
            }
            let s = authority.sign_in(GrantSpec { expires_in: 3600, ..GrantSpec::default() });
            let body = json!({ "access_token": s.access_token, "refresh_token": s.refresh_token, "expires_in": 3600, "token_type": "Bearer" });
            return ok_json(body);
        }
        state.lock().unwrap_or_else(|p| p.into_inner()).requests.push("POST /oauth/token refresh".into());
        let (status, reply, _) = authority.answer(&form);
        return (status, reply.into_bytes(), Vec::new());
    }

    let mut st = state.lock().unwrap_or_else(|p| p.into_inner());
    st.requests.push(line);
    if !req.bearer.as_deref().is_some_and(|t| authority.is_valid(t)) {
        let body = json!({ "error": { "code": "InvalidAuthenticationToken", "message": "Access token has expired or is not yet valid." } });
        return (401, body.to_string().into_bytes(), Vec::new());
    }
    if st.refuse_tokens {
        let body = json!({ "error": { "code": "InvalidAuthenticationToken", "message": "Access token validation failure." } });
        return (401, body.to_string().into_bytes(), Vec::new());
    }
    if let Some(secs) = st.throttle.pop_front() {
        let body = json!({ "error": { "code": "TooManyRequests", "message": "Please retry again later." } });
        return (429, body.to_string().into_bytes(), vec![("Retry-After".into(), secs.to_string())]);
    }
    let me = st.me.clone();
    let segs: Vec<&str> = req.path.trim_start_matches('/').split('/').collect();
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["me"]) => ok_json(json!({ "mail": me, "userPrincipalName": me })),
        ("POST", ["$batch"]) => {
            let body: Value = serde_json::from_slice(&req.body).unwrap_or_default();
            let responses: Vec<Value> = body["requests"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| {
                    let id = r["id"].as_str().unwrap_or("");
                    let url = r["url"].as_str().unwrap_or("");
                    let name = url.trim_start_matches("/me/mailFolders/").split('?').next().unwrap_or("");
                    match st.folders.iter().find(|f| f.well_known.as_deref() == Some(name)) {
                        Some(f) => json!({ "id": id, "status": 200, "body": { "id": f.id } }),
                        None => json!({ "id": id, "status": 404, "body": { "error": { "code": "ErrorItemNotFound" } } }),
                    }
                })
                .collect();
            ok_json(json!({ "responses": responses }))
        }
        ("GET", ["me", "mailFolders"]) => {
            let v: Vec<Value> = st.folders.iter().filter(|f| f.parent.is_none()).map(|f| folder_json(&st, f)).collect();
            ok_json(json!({ "value": v }))
        }
        ("GET", ["me", "mailFolders", key]) => match st.folder(key) {
            Some(f) => ok_json(folder_json(&st, f)),
            None => not_found(),
        },
        ("GET", ["me", "mailFolders", key, "childFolders"]) => match st.folder(key) {
            Some(f) => {
                let id = f.id.clone();
                let v: Vec<Value> = st.folders.iter().filter(|c| c.parent.as_deref() == Some(id.as_str())).map(|c| folder_json(&st, c)).collect();
                ok_json(json!({ "value": v }))
            }
            None => not_found(),
        },
        ("GET", ["me", "mailFolders", key, "messages"]) => {
            let Some(f) = st.folder(key) else { return not_found() };
            let fid = f.id.clone();
            let q = &req.query;
            let top: usize = query_param(q, "$top").and_then(|t| t.parse().ok()).unwrap_or(10);
            let skip: usize = query_param(q, "$skip").and_then(|t| t.parse().ok()).unwrap_or(0);
            let since = query_param(q, "$filter").and_then(|f| f.strip_prefix("receivedDateTime ge ").and_then(|d| parse_rfc3339(d.trim())));
            let mut list: Vec<&Msg> = st.messages.iter().filter(|m| m.folder == fid && since.is_none_or(|s| m.received_ms >= s)).collect();
            // Newest first unless asked otherwise.
            list.sort_by(|a, b| b.received_ms.cmp(&a.received_ms));
            if query_param(q, "$orderby").is_some_and(|o| o.trim().ends_with("asc")) {
                list.reverse();
            }
            let page: Vec<Value> = list.iter().skip(skip).take(top).map(|m| message_json(m, &me)).collect();
            let mut out = json!({ "value": page });
            if skip + top < list.len() {
                let mut pairs: Vec<String> = q
                    .split('&')
                    .filter(|kv| !kv.starts_with("$skip=") && !kv.starts_with("%24skip="))
                    .map(str::to_string)
                    .collect();
                pairs.push(format!("$skip={}", skip + top));
                out["@odata.nextLink"] = json!(format!("http://{addr}/me/mailFolders/{}/messages?{}", fid, pairs.join("&")));
            }
            let mut answer = ok_json(out);
            if st.list_pause_ms > 0 {
                answer.2.push(("X-Mock-Delay-Ms".into(), st.list_pause_ms.to_string()));
            }
            answer
        }
        ("GET", ["me", "messages", id]) => match st.messages.iter().find(|m| m.id == *id) {
            Some(m) => ok_json(message_json(m, &me)),
            None => not_found(),
        },
        ("GET", ["me", "messages", id, "attachments"]) => {
            if st.fail_attachments {
                return (503, json!({ "error": { "code": "ServiceUnavailable" } }).to_string().into_bytes(), Vec::new());
            }
            // Only the base type's properties can be selected on the collection.
            let select: Vec<String> = query_param(&req.query, "$select").map(|s| s.split(',').map(|p| p.trim().to_string()).collect()).unwrap_or_default();
            if let Some(bad) = select.iter().find(|p| !ATTACHMENT_PROPS.contains(&p.as_str())) {
                let body = json!({ "error": { "code": "BadRequest", "message": format!("Could not find a property named '{bad}' on type 'microsoft.graph.attachment'.") } });
                return (400, body.to_string().into_bytes(), Vec::new());
            }
            match st.messages.iter().find(|m| m.id == *id) {
                Some(m) => {
                    let v: Vec<Value> = m
                        .attachments
                        .iter()
                        .map(|a| {
                            let mut full = json!({
                                "@odata.type": format!("#microsoft.graph.{}", a.odata),
                                "id": a.id, "name": a.name, "contentType": a.content_type, "size": a.bytes.len() + 120,
                                "isInline": a.inline, "lastModifiedDateTime": "2026-01-01T00:00:00Z",
                                "contentId": a.content_id, "contentBytes": "(bytes)",
                            });
                            if !select.is_empty() {
                                let o = full.as_object_mut().unwrap();
                                o.retain(|k, _| k == "@odata.type" || select.contains(k));
                            }
                            full
                        })
                        .collect();
                    ok_json(json!({ "value": v }))
                }
                None => not_found(),
            }
        }
        ("GET", ["me", "messages", id, "attachments", att, "$value"]) => {
            match st.messages.iter().find(|m| m.id == *id).and_then(|m| m.attachments.iter().find(|a| a.id == *att)) {
                Some(a) if a.odata == "referenceAttachment" => {
                    (400, json!({ "error": { "code": "ErrorInvalidRequest", "message": "A reference attachment has no content." } }).to_string().into_bytes(), Vec::new())
                }
                Some(a) => {
                    let mut h = vec![("Content-Type".into(), a.content_type.clone())];
                    if st.slow_value_ms > 0 {
                        h.push(("X-Mock-Slow-Ms".into(), st.slow_value_ms.to_string()));
                    }
                    (200, a.bytes.clone(), h)
                }
                None => not_found(),
            }
        }
        ("PATCH", ["me", "messages", id]) => {
            let body: Value = serde_json::from_slice(&req.body).unwrap_or_default();
            let Some(m) = st.messages.iter_mut().find(|m| m.id == *id) else { return not_found() };
            if let Some(r) = body["isRead"].as_bool() {
                m.is_read = r;
            }
            if let Some(s) = body["flag"]["flagStatus"].as_str() {
                m.flagged = s == "flagged";
            }
            m.modified_ms += 1000;
            let v = message_json(m, &me);
            ok_json(v)
        }
        ("POST", ["me", "messages", id, "move"]) => {
            match st.fail_moves_after {
                Some((0, k)) => {
                    st.fail_moves_after = (k > 1).then_some((0, k - 1));
                    let body = json!({ "error": { "code": "ServiceUnavailable", "message": "Try again." } });
                    return (503, body.to_string().into_bytes(), Vec::new());
                }
                Some((n, k)) => st.fail_moves_after = Some((n - 1, k)),
                None => {}
            }
            let body: Value = serde_json::from_slice(&req.body).unwrap_or_default();
            let dest = body["destinationId"].as_str().unwrap_or("").to_string();
            let Some(target) = st.folder(&dest).map(|f| f.id.clone()) else { return not_found() };
            let Some(i) = st.messages.iter().position(|m| m.id == *id) else { return not_found() };
            // Exchange gives a moved message a new id.
            let new_id = st.new_id("msg");
            let m = &mut st.messages[i];
            m.id = new_id;
            m.folder = target;
            let v = message_json(m, &me);
            if let Some((n, gone)) = st.delete_after_moves.clone() {
                if n <= 1 {
                    st.delete_after_moves = None;
                    st.folders.retain(|f| f.id != gone);
                    st.messages.retain(|m| m.folder != gone);
                } else {
                    st.delete_after_moves = Some((n - 1, gone));
                }
            }
            (201, v.to_string().into_bytes(), Vec::new())
        }
        ("POST", ["me", "messages", id, "permanentDelete"]) => match st.messages.iter().position(|m| m.id == *id) {
            Some(i) => {
                st.messages.remove(i);
                (204, Vec::new(), Vec::new())
            }
            None => not_found(),
        },
        ("DELETE", ["me", "messages", id]) => {
            let Some(trash) = st.folder("deleteditems").map(|f| f.id.clone()) else { return not_found() };
            let Some(i) = st.messages.iter().position(|m| m.id == *id) else { return not_found() };
            let new_id = st.new_id("msg");
            st.messages[i].id = new_id;
            st.messages[i].folder = trash;
            (204, Vec::new(), Vec::new())
        }
        ("POST", ["me", "sendMail"]) => {
            let text: String = String::from_utf8_lossy(&req.body).chars().filter(|c| !c.is_whitespace()).collect();
            let Ok(mime) = base64::engine::general_purpose::STANDARD.decode(text.as_bytes()) else {
                return (400, json!({ "error": { "code": "ErrorMimeContentInvalid" } }).to_string().into_bytes(), Vec::new());
            };
            st.sent.push(mime);
            if st.drop_send {
                return (0, Vec::new(), Vec::new());
            }
            // Graph files its own copy in Sent Items.
            if let Some(sent) = st.folder("sentitems").map(|f| f.id.clone()) {
                let id = st.new_id("msg");
                st.messages.push(Msg {
                    id,
                    folder: sent,
                    subject: "(sent)".into(),
                    from: me.clone(),
                    received_ms: 0,
                    modified_ms: 0,
                    is_read: true,
                    flagged: false,
                    has_attachments: false,
                    internet_message_id: String::new(),
                    reply_to: None,
                    body_html: String::new(),
                    attachments: Vec::new(),
                });
            }
            (202, Vec::new(), Vec::new())
        }
        _ => {
            let body = json!({ "error": { "code": "BadRequest", "message": format!("mock: no route for {} {}", req.method, req.path) } });
            (400, body.to_string().into_bytes(), Vec::new())
        }
    }
}
