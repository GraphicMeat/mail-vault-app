//! Minimal HTTP/1.1 server: routing, auth, the session object and EventSource.
//!
//! One thread per connection; every response carries `Content-Length` and
//! `Connection: close`, except the EventSource stream, which stays open.

use crate::methods::{self, SESSION_STATE};
use crate::state::State;
use crate::{Fault, RecordedRequest};
use serde_json::{json, Map, Value};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub(crate) struct Shared {
    pub state: Mutex<State>,
    /// Signalled whenever `State::notify_gen` moves (and on shutdown).
    pub changed: Condvar,
    pub stop: AtomicBool,
    pub requests: Mutex<Vec<RecordedRequest>>,
    /// `http://127.0.0.1:<port>` of the main listener.
    pub base: String,
    /// `http://127.0.0.1:<port>` of the download listener.
    pub download_base: String,
}

impl Shared {
    pub fn new(state: State, base: String, download_base: String) -> Shared {
        Shared {
            state: Mutex::new(state),
            changed: Condvar::new(),
            stop: AtomicBool::new(false),
            requests: Mutex::new(Vec::new()),
            base,
            download_base,
        }
    }

    /// Lock the state, surviving a panic in a test's `mutate` closure.
    pub fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn notify(&self) {
        self.changed.notify_all();
    }
}

pub(crate) fn serve(listener: TcpListener, shared: Arc<Shared>, download_only: bool) {
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if shared.stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(conn) = conn else { continue };
            let shared = shared.clone();
            std::thread::spawn(move || {
                let _ = handle(conn, &shared, download_only);
            });
        }
    });
}

struct Request {
    method: String,
    /// Path plus query, as sent.
    target: String,
    path: String,
    query: String,
    /// Names lowercased.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    fn query_param(&self, key: &str) -> Option<String> {
        self.query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| pct_decode(v))
    }
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
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

/// Read the request line, headers and the whole body (Content-Length or chunked).
/// The body is always drained before any response, so a 401 never resets the socket.
fn read_request(stream: &TcpStream) -> io::Result<Option<Request>> {
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    if r.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.trim_end().splitn(3, ' ');
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let find = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    let chunked = find("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let length = find("content-length").and_then(|v| v.parse::<usize>().ok());
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size = String::new();
            r.read_line(&mut size)?;
            let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
            if n == 0 {
                loop {
                    let mut trailer = String::new();
                    if r.read_line(&mut trailer)? == 0 || trailer.trim().is_empty() {
                        break;
                    }
                }
                break;
            }
            let mut chunk = vec![0; n];
            r.read_exact(&mut chunk)?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0u8; 2];
            r.read_exact(&mut crlf)?;
        }
    } else if let Some(n) = length {
        body = vec![0; n];
        r.read_exact(&mut body)?;
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    Ok(Some(Request { method, target, path, query, headers, body }))
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        301 => "Moved Permanently",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        _ => "Error",
    }
}

fn respond(stream: &TcpStream, status: u16, headers: &[(&str, String)], body: &[u8]) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
    let mut s = stream;
    s.write_all(head.as_bytes())?;
    s.write_all(body)?;
    s.flush()
}

fn json_response(stream: &TcpStream, status: u16, v: &Value) -> io::Result<()> {
    respond(stream, status, &[("Content-Type", "application/json".into())], v.to_string().as_bytes())
}

fn problem_response(stream: &TcpStream, status: u16, p: &Value, extra: &[(&str, String)]) -> io::Result<()> {
    let mut headers = vec![("Content-Type", "application/problem+json".to_string())];
    headers.extend(extra.iter().cloned());
    respond(stream, status, &headers, p.to_string().as_bytes())
}

fn unauthorized(stream: &TcpStream) -> io::Result<()> {
    let p = json!({"type": "about:blank", "status": 401, "detail": "authentication required"});
    problem_response(stream, 401, &p, &[("WWW-Authenticate", "Basic realm=\"mock-jmap\"".into())])
}

fn not_found(stream: &TcpStream) -> io::Result<()> {
    let p = json!({"type": "about:blank", "status": 404, "detail": "not found"});
    problem_response(stream, 404, &p, &[])
}

fn record(shared: &Shared, req: &Request, download_only: bool) {
    let calls = if req.path.starts_with("/jmap/api") {
        serde_json::from_slice::<Value>(&req.body)
            .ok()
            .and_then(|v| {
                v["methodCalls"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|c| c[0].as_str().map(str::to_string)).collect())
            })
            .unwrap_or_default()
    } else {
        vec![]
    };
    shared.requests.lock().unwrap_or_else(|e| e.into_inner()).push(RecordedRequest {
        method: req.method.clone(),
        path: req.target.clone(),
        authorization: req.header("authorization").map(str::to_string),
        calls,
        body: String::from_utf8_lossy(&req.body).into_owned(),
        download_listener: download_only,
    });
}

fn handle(stream: TcpStream, shared: &Shared, download_only: bool) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let Some(req) = read_request(&stream)? else { return Ok(()) };
    if shared.stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !req.path.starts_with("/_mock/") {
        record(shared, &req, download_only);
    }
    let segs: Vec<String> = req.path.split('/').filter(|s| !s.is_empty()).map(pct_decode).collect();
    let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
    let auth = req.header("authorization").map(str::to_string);
    let auth = auth.as_deref();
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["jmap", "download", acc, blob, ..]) => download(&stream, shared, auth, acc, blob, &req, download_only),
        _ if download_only => not_found(&stream),
        ("GET", [".well-known", "jmap"]) => {
            respond(&stream, 301, &[("Location", format!("{}/jmap/session", shared.base))], b"")
        }
        ("GET", ["jmap", "session"]) => session(&stream, shared, auth),
        ("POST", ["jmap", "api"]) => api(&stream, shared, auth, &req),
        ("POST", ["jmap", "upload", acc]) => upload(&stream, shared, auth, acc, &req),
        ("GET", ["jmap", "eventsource"]) => event_source(&stream, shared, auth, &req),
        ("GET", ["_mock", "submitted"]) => {
            let list: Vec<String> = shared.lock().submitted.iter().map(|m| String::from_utf8_lossy(m).into_owned()).collect();
            json_response(&stream, 200, &json!(list))
        }
        ("GET", ["_mock", "requests"]) => {
            let list = shared.requests.lock().unwrap_or_else(|e| e.into_inner()).clone();
            json_response(&stream, 200, &serde_json::to_value(list).unwrap_or_default())
        }
        ("POST", ["_mock", "deliver", acc, mailbox]) => deliver(&stream, shared, acc, mailbox, &req),
        _ => not_found(&stream),
    }
}

/// The RFC 8620 §2 Session object for one authenticated account.
fn session_json(st: &State, acc_id: &str, base: &str, download_base: &str) -> Value {
    const CORE: &str = "urn:ietf:params:jmap:core";
    const MAIL: &str = "urn:ietf:params:jmap:mail";
    const SUBMISSION: &str = "urn:ietf:params:jmap:submission";
    let a = st.account(acc_id);
    let l = &st.limits;
    let mut caps = Map::new();
    caps.insert(
        CORE.into(),
        json!({
            "maxSizeUpload": l.max_size_upload, "maxConcurrentUpload": 4, "maxSizeRequest": 10_000_000,
            "maxConcurrentRequests": 4, "maxCallsInRequest": l.max_calls_in_request,
            "maxObjectsInGet": l.max_objects_in_get, "maxObjectsInSet": l.max_objects_in_set,
            "collationAlgorithms": ["i;ascii-numeric", "i;ascii-casemap", "i;unicode-casemap"],
        }),
    );
    caps.insert(MAIL.into(), json!({}));
    let mut account_caps = Map::new();
    account_caps.insert(
        MAIL.into(),
        json!({
            "maxMailboxesPerEmail": null, "maxMailboxDepth": null, "maxSizeMailboxName": 255,
            "maxSizeAttachmentsPerEmail": 50_000_000, "emailQuerySortOptions": ["receivedAt"],
            "mayCreateTopLevelMailbox": true,
        }),
    );
    let mut primary = Map::new();
    primary.insert(MAIL.into(), json!(acc_id));
    if st.advertise_submission {
        caps.insert(SUBMISSION.into(), json!({}));
        account_caps.insert(SUBMISSION.into(), json!({"maxDelayedSend": 0, "submissionExtensions": {}}));
        primary.insert(SUBMISSION.into(), json!(acc_id));
    }
    let mut accounts = Map::new();
    accounts.insert(
        acc_id.into(),
        json!({"name": a.username, "isPersonal": true, "isReadOnly": false, "accountCapabilities": account_caps}),
    );
    let download = if st.download_host.is_some() { download_base } else { base };
    let mut s = json!({
        "capabilities": caps,
        "accounts": accounts,
        "primaryAccounts": primary,
        "username": a.username,
        "apiUrl": st.api_url_override.clone().unwrap_or_else(|| format!("{base}/jmap/api")),
        "downloadUrl": format!("{download}/jmap/download/{{accountId}}/{{blobId}}/{{name}}?type={{type}}"),
        "uploadUrl": format!("{base}/jmap/upload/{{accountId}}/"),
        "state": SESSION_STATE,
    });
    if st.advertise_event_source {
        s["eventSourceUrl"] = json!(format!("{base}/jmap/eventsource/?types={{types}}&closeafter={{closeafter}}&ping={{ping}}"));
    }
    s
}

fn session(stream: &TcpStream, shared: &Shared, auth: Option<&str>) -> io::Result<()> {
    let st = shared.lock();
    let Some(acc) = st.authenticate(auth) else {
        drop(st);
        return unauthorized(stream);
    };
    let v = session_json(&st, &acc, &shared.base, &shared.download_base);
    drop(st);
    json_response(stream, 200, &v)
}

fn api(stream: &TcpStream, shared: &Shared, auth: Option<&str>, req: &Request) -> io::Result<()> {
    let mut st = shared.lock();
    let Some(acc) = st.authenticate(auth) else {
        drop(st);
        return unauthorized(stream);
    };
    if st.take_unauthorized_once() {
        drop(st);
        return unauthorized(stream);
    }
    if let Some(secs) = st.take_rate_limit() {
        drop(st);
        let p = json!({"type": "about:blank", "status": 429, "detail": "rate limited"});
        return problem_response(stream, 429, &p, &[("Retry-After", secs.to_string())]);
    }
    let before = st.seq_sum();
    let submissions_before = st.submitted.len();
    let out = methods::handle_request(&mut st, &acc, &req.body);
    let lose_reply = if st.submitted.len() > submissions_before {
        if let Some(index) = st.faults.iter().position(|fault| matches!(fault, Fault::SubmissionReplyLostOnce)) {
            st.faults.remove(index);
            true
        } else { false }
    } else { false };
    let changed = st.seq_sum() != before;
    if changed {
        st.notify_gen += 1;
    }
    drop(st);
    if changed {
        shared.notify();
    }
    if lose_reply {
        return Ok(());
    }
    match out {
        Ok(v) => json_response(stream, 200, &v),
        Err((status, p)) => problem_response(stream, status, &p, &[]),
    }
}

fn download(
    stream: &TcpStream,
    shared: &Shared,
    auth: Option<&str>,
    acc: &str,
    blob: &str,
    req: &Request,
    download_only: bool,
) -> io::Result<()> {
    let st = shared.lock();
    // With a separate download host, the API host serves no blobs (Fastmail-style).
    if !download_only && st.download_host.is_some() {
        drop(st);
        return not_found(stream);
    }
    let Some(authed) = st.authenticate(auth) else {
        drop(st);
        return unauthorized(stream);
    };
    let bytes = if authed == acc { st.blobs.get(blob).cloned() } else { None };
    drop(st);
    let Some(bytes) = bytes else { return not_found(stream) };
    let ctype = req.query_param("type").unwrap_or_else(|| "application/octet-stream".into());
    respond(stream, 200, &[("Content-Type", ctype)], &bytes)
}

fn upload(stream: &TcpStream, shared: &Shared, auth: Option<&str>, acc: &str, req: &Request) -> io::Result<()> {
    let mut st = shared.lock();
    let Some(authed) = st.authenticate(auth) else {
        drop(st);
        return unauthorized(stream);
    };
    if authed != acc {
        drop(st);
        return not_found(stream);
    }
    if req.body.len() as u64 > st.limits.max_size_upload {
        drop(st);
        let p = json!({"type": "urn:ietf:params:jmap:error:limit", "limit": "maxSizeUpload", "status": 413,
                       "detail": "upload exceeds maxSizeUpload"});
        return problem_response(stream, 413, &p, &[]);
    }
    let blob_id = st.store_blob(req.body.clone());
    drop(st);
    let ctype = req.header("content-type").unwrap_or("application/octet-stream");
    json_response(stream, 201, &json!({"accountId": acc, "blobId": blob_id, "type": ctype, "size": req.body.len()}))
}

/// `POST /_mock/deliver/{accountId}/{mailboxId}[?keywords=$seen,$flagged]`, no auth:
/// an e2e test's way to make mail arrive. Answers `{"id": "<new email id>"}`.
fn deliver(stream: &TcpStream, shared: &Shared, acc: &str, mailbox: &str, req: &Request) -> io::Result<()> {
    let keywords = req.query_param("keywords").unwrap_or_default();
    let keywords: Vec<&str> = keywords.split(',').filter(|k| !k.is_empty()).collect();
    let id = {
        let mut st = shared.lock();
        if !st.accounts.get(acc).is_some_and(|a| a.mailboxes.contains_key(mailbox)) {
            drop(st);
            return not_found(stream);
        }
        let id = st.deliver(acc, mailbox, &req.body, &keywords);
        st.notify_gen += 1;
        id
    };
    shared.notify();
    json_response(stream, 200, &json!({"id": id}))
}

fn state_change(st: &State, acc: &str, types: &Option<Vec<String>>) -> String {
    let a = st.account(acc);
    let wants = |t: &str| types.as_ref().map_or(true, |list| list.iter().any(|x| x == t));
    let mut changed = Map::new();
    if wants("Email") {
        changed.insert("Email".into(), json!(a.email_state.to_string()));
    }
    if wants("Mailbox") {
        changed.insert("Mailbox".into(), json!(a.mailbox_state.to_string()));
    }
    let mut by_account = Map::new();
    by_account.insert(acc.to_string(), Value::Object(changed));
    json!({"@type": "StateChange", "changed": by_account}).to_string()
}

/// `GET /jmap/eventsource/?types=..&closeafter=..&ping=N` (RFC 8620 §7.3). Sends
/// `event: state` whenever `notify_gen` moves and `event: ping` every N seconds of
/// silence. The 200 header block goes out only after the generation is snapshotted,
/// so a change made after the client has read the headers always produces an event.
fn event_source(stream: &TcpStream, shared: &Shared, auth: Option<&str>, req: &Request) -> io::Result<()> {
    let ping = req.query_param("ping").and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
    let close_after_state = req.query_param("closeafter").as_deref() == Some("state");
    let types: Option<Vec<String>> = match req.query_param("types") {
        Some(t) if t != "*" => Some(t.split(',').map(|s| s.trim().to_string()).collect()),
        _ => None,
    };
    let (acc, mut seen_gen, drop_after, hang_up_first) = {
        let st = shared.lock();
        let Some(acc) = st.authenticate(auth) else {
            drop(st);
            return unauthorized(stream);
        };
        (acc, st.notify_gen, st.drop_event_source_after(), st.hangs_up_event_source())
    };
    let mut s = stream;
    s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n")?;
    s.flush()?;
    if hang_up_first {
        let data = state_change(&shared.lock(), &acc, &types);
        s.write_all(format!("event: state\ndata: {data}\n\n").as_bytes())?;
        s.flush()?;
        return Ok(());
    }
    let mut sent = 0usize;
    let mut last_event = Instant::now();
    loop {
        if drop_after.is_some_and(|n| sent >= n) {
            // Dead proxy: keep the socket open, never write again.
            while !shared.stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
            }
            return Ok(());
        }
        let payload = {
            let mut st = shared.lock();
            loop {
                if shared.stop.load(Ordering::SeqCst) {
                    return Ok(());
                }
                if st.notify_gen != seen_gen {
                    seen_gen = st.notify_gen;
                    break Some(state_change(&st, &acc, &types));
                }
                let wait = if ping > 0 {
                    let left = Duration::from_secs(ping).saturating_sub(last_event.elapsed());
                    if left.is_zero() {
                        break None;
                    }
                    left.min(Duration::from_millis(500))
                } else {
                    Duration::from_millis(500)
                };
                st = shared.changed.wait_timeout(st, wait).unwrap_or_else(|e| e.into_inner()).0;
            }
        };
        let frame = match &payload {
            Some(data) => format!("event: state\ndata: {data}\n\n"),
            None => format!("event: ping\ndata: {{\"interval\":{ping}}}\n\n"),
        };
        s.write_all(frame.as_bytes())?;
        s.flush()?;
        sent += 1;
        last_event = Instant::now();
        if payload.is_some() && close_after_state {
            return Ok(());
        }
    }
}
