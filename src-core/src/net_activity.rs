//! Network Activity: every connection the helper makes.
//!
//! Recorded here into a ring of the newest `CAPACITY` events and handed to
//! the one listener; the daemon's listener forwards each to the app and to
//! `net_log`, which keeps them on this machine for the chosen period. HTTP
//! goes through `http_client` / `http_client_with`, whose `Tracked::send`
//! records one event per request. Events carry host and port only, never a
//! URL path or query (those can hold tokens). `account` is the account's own
//! address, shown on the page; any address in `result` is masked.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Out,
    In,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    Imap,
    Smtp,
    Https,
    Http,
    Dns,
    TcpProbe,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetEvent {
    pub at_ms: u64,
    pub direction: Direction,
    /// "helper" | "app"
    pub process: &'static str,
    pub protocol: Protocol,
    pub host: String,
    pub ip: Option<String>,
    pub port: u16,
    pub purpose: String,
    /// The account's address, when the connection is one account's.
    pub account: Option<String>,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub duration_ms: u64,
    /// "ok" or the error text.
    pub result: String,
    pub commands: Option<u32>,
}

impl NetEvent {
    /// An outgoing helper event starting now. `result` starts as
    /// "cancelled": a `Pending` dropped before its caller settled it (the
    /// future was dropped mid-flight) still says what happened.
    pub fn out(protocol: Protocol, host: &str, port: u16, purpose: &str) -> Self {
        NetEvent {
            at_ms: now_ms(),
            direction: Direction::Out,
            process: "helper",
            protocol,
            host: host.to_string(),
            ip: None,
            port,
            purpose: purpose.to_string(),
            account: account(),
            bytes_up: 0,
            bytes_down: 0,
            duration_ms: 0,
            result: "cancelled".into(),
            commands: None,
        }
    }
}

/// An event recorded when this is dropped, with the time since `new` as its
/// duration: a connection or lookup is on the page however it ended,
/// finished, failed or cancelled.
pub struct Pending {
    pub ev: NetEvent,
    started: Instant,
}

impl Pending {
    pub fn new(ev: NetEvent) -> Self {
        Pending { ev, started: Instant::now() }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        let mut ev = self.ev.clone();
        ev.duration_ms = self.started.elapsed().as_millis() as u64;
        record(ev);
    }
}

/// A `Pending` with two owners: a socket, and the sign-in running on it. It
/// is recorded when the last one lets go, so a sign-in that fails after its
/// socket is already gone (a TLS handshake that consumed the stream) still
/// writes its verdict first.
pub type Shared = std::sync::Arc<Mutex<Pending>>;

pub fn shared(p: Pending) -> Shared {
    std::sync::Arc::new(Mutex::new(p))
}

/// Set a shared event's result: "ok", or the error text.
pub fn settle<T, E: std::fmt::Display>(conn: &Shared, out: &Result<T, E>) {
    conn.lock().unwrap_or_else(|p| p.into_inner()).ev.result = match out {
        Ok(_) => "ok".into(),
        Err(e) => e.to_string(),
    };
}

impl std::fmt::Debug for Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pending").field("ev", &self.ev).finish()
    }
}

pub const CAPACITY: usize = 2000;

/// The ring the global wraps; its own type so tests get a fresh one.
struct Ring(VecDeque<NetEvent>);

impl Ring {
    const fn new() -> Self {
        Ring(VecDeque::new())
    }
    fn push(&mut self, ev: NetEvent) {
        if self.0.len() == CAPACITY {
            self.0.pop_front();
        }
        self.0.push_back(ev);
    }
    fn snapshot(&self) -> Vec<NetEvent> {
        self.0.iter().rev().cloned().collect()
    }
}

type Listener = Box<dyn Fn(&NetEvent) + Send + Sync>;

static RING: Mutex<Ring> = Mutex::new(Ring::new());
static LISTENER: RwLock<Option<Listener>> = RwLock::new(None);

/// Record one event: any address in the result masked first, then to the
/// listener, then into the ring (oldest dropped past `CAPACITY`). The
/// account stays the address: the page names the account it belongs to.
///
/// The listener runs under the `LISTENER` read lock and before the push, so
/// the event is not yet in `snapshot()` when it sees it, and it must never
/// call `record` or `subscribe` (a deadlock on the lock), nor wait on
/// anything slow: it runs on the connection's own task.
pub fn record(mut ev: NetEvent) {
    ev.result = mask(&ev.result);
    if let Some(f) = LISTENER.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
        f(&ev);
    }
    RING.lock().unwrap_or_else(|p| p.into_inner()).push(ev);
}

/// Every event held, newest first.
pub fn snapshot() -> Vec<NetEvent> {
    RING.lock().unwrap_or_else(|p| p.into_inner()).snapshot()
}

/// Set the one listener (the daemon forwards to its event bus). A second call
/// replaces the first.
pub fn subscribe(f: Listener) {
    *LISTENER.write().unwrap_or_else(|p| p.into_inner()) = Some(f);
}

/// Remove the listener, so a test's own does not outlive it.
#[cfg(test)]
fn unsubscribe() {
    *LISTENER.write().unwrap_or_else(|p| p.into_inner()) = None;
}

static SALT: OnceLock<[u8; 16]> = OnceLock::new();

/// The per-install log salt (`log_redact::load_or_create_salt`), so an
/// address in a result reads with the same token here as in the logs.
/// Unset, a salt for this process is used.
pub fn set_salt(salt: [u8; 16]) {
    let _ = SALT.set(salt);
}

/// Every address in `s` masked exactly as the Standard logs mask it,
/// whatever the log level: an error text never shows a raw address.
fn mask(s: &str) -> String {
    if s.contains('@') {
        crate::log_redact::redact(s, SALT.get_or_init(rand::random))
    } else {
        s.to_string()
    }
}

/// An event the app shell measured itself (its own HTTP requests), sent to
/// the daemon as `net.report { event }`. The same camelCase keys `NetEvent`
/// serializes to; `direction`, `process`, `account` and `commands` are not
/// taken from the sender.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reported {
    at_ms: u64,
    protocol: Protocol,
    host: String,
    ip: Option<String>,
    port: u16,
    purpose: String,
    bytes_up: u64,
    bytes_down: u64,
    duration_ms: u64,
    result: String,
}

/// Record an event the app reported: always outgoing, always `process: "app"`.
pub fn record_reported(event: serde_json::Value) -> Result<(), String> {
    let r: Reported = serde_json::from_value(event).map_err(|e| format!("net.report: {e}"))?;
    record(NetEvent {
        at_ms: r.at_ms,
        direction: Direction::Out,
        process: "app",
        protocol: r.protocol,
        host: r.host,
        ip: r.ip,
        port: r.port,
        purpose: r.purpose,
        account: None,
        bytes_up: r.bytes_up,
        bytes_down: r.bytes_down,
        duration_ms: r.duration_ms,
        result: r.result,
        commands: None,
    });
    Ok(())
}

tokio::task_local! {
    /// What the mail connections opened inside `with_purpose` are for.
    static PURPOSE: &'static str;
    /// Whose connections the ones opened inside `with_account` are.
    static ACCOUNT: String;
}

/// Run `fut` with every event it records shown as `email`'s: the account an
/// RPC names (`accountEmail`). A task-local like `with_purpose`, so a spawned
/// future needs its own scope. An event that names its account itself (IMAP,
/// SMTP, a `Tracked::for_account` client) keeps its own.
pub async fn with_account<F: Future>(email: String, fut: F) -> F::Output {
    ACCOUNT.scope(email, fut).await
}

/// The account in scope, if any.
fn account() -> Option<String> {
    ACCOUNT.try_with(String::clone).ok()
}

/// Run `fut` with `purpose` on every IMAP connection and DNS lookup it
/// makes. A task-local, so it does not cross `spawn`: scope the spawned
/// future too.
pub async fn with_purpose<F: Future>(purpose: &'static str, fut: F) -> F::Output {
    PURPOSE.scope(purpose, fut).await
}

/// `with_purpose`, unless an outer scope already set one: the pool's lane
/// default must not relabel a backup's background reads as "sync".
pub async fn with_default_purpose<F: Future>(purpose: &'static str, fut: F) -> F::Output {
    match PURPOSE.try_with(|p| *p) {
        Ok(_) => fut.await,
        Err(_) => PURPOSE.scope(purpose, fut).await,
    }
}

/// The purpose in scope; "sync" outside any.
pub fn purpose() -> &'static str {
    PURPOSE.try_with(|p| *p).unwrap_or("sync")
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A reqwest client that records every request sent through `send`.
/// Derefs to the client so call sites build requests as before, but the
/// deref'd client's own `.send()` bypasses recording: always send through
/// `Tracked::send(req)`.
#[derive(Clone)]
pub struct Tracked {
    client: reqwest::Client,
    purpose: String,
    account: Option<String>,
}

impl std::ops::Deref for Tracked {
    type Target = reqwest::Client;
    fn deref(&self) -> &reqwest::Client {
        &self.client
    }
}

/// An HTTP client for `purpose`, with the given overall timeout.
pub fn http_client(purpose: &str, timeout: Option<Duration>) -> Tracked {
    let builder = reqwest::Client::builder();
    http_client_with(purpose, match timeout {
        Some(t) => builder.timeout(t),
        None => builder,
    })
}

/// `http_client` for a site that needs its own builder (redirect policy,
/// user agent).
pub fn http_client_with(purpose: &str, builder: reqwest::ClientBuilder) -> Tracked {
    Tracked {
        // The same failure `reqwest::Client::new()` panics on (TLS backend
        // init); with rustls and no proxy config it does not happen.
        client: builder.build().expect("HTTP client build failed"),
        purpose: purpose.to_string(),
        account: None,
    }
}

impl Tracked {
    pub fn purpose(&self) -> &str {
        &self.purpose
    }

    /// Every request shown as `email`'s, whatever scope sends it: for a run
    /// that knows its account (backup) or holds two at once (migration).
    pub fn for_account(mut self, email: &str) -> Self {
        self.account = Some(email.to_string());
        self
    }

    /// Send `req` and record it: host, port, resolved IP, status, duration,
    /// bytes up (body length when known), bytes down (content-length when
    /// known). A request that fails to build never reached the wire and is
    /// not recorded.
    pub async fn send(&self, req: reqwest::RequestBuilder) -> reqwest::Result<reqwest::Response> {
        let (out, ev) = measure(&self.purpose, req).await;
        if let Some(mut ev) = ev {
            if self.account.is_some() {
                ev.account = self.account.clone();
            }
            record(ev);
        }
        out
    }
}

/// Send `req` and return the event `Tracked::send` would record, without
/// recording it: for the app shell, which reports it to the daemon instead.
/// `None` when the request failed to build and never reached the wire.
pub async fn measure(
    purpose: &str,
    req: reqwest::RequestBuilder,
) -> (reqwest::Result<reqwest::Response>, Option<NetEvent>) {
    // The builder's own client carries the site's timeout and policy.
    let (client, request) = req.build_split();
    let request = match request {
        Ok(r) => r,
        Err(e) => return (Err(e), None),
    };
    let url = request.url();
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(0);
    let protocol = if url.scheme() == "https" { Protocol::Https } else { Protocol::Http };
    let bytes_up = request.body().and_then(|b| b.as_bytes()).map_or(0, |b| b.len() as u64);
    let at_ms = now_ms();
    let started = Instant::now();
    let out = client.execute(request).await;
    let (ip, bytes_down, result) = match &out {
        Ok(r) => (
            r.remote_addr().map(|a| a.ip().to_string()),
            r.content_length().unwrap_or(0),
            if r.status().as_u16() >= 400 { format!("HTTP {}", r.status().as_u16()) } else { "ok".into() },
        ),
        Err(e) => (None, 0, error_text(e, &host, port)),
    };
    let ev = NetEvent {
        at_ms,
        direction: Direction::Out,
        process: "helper",
        protocol,
        host,
        ip,
        port,
        purpose: purpose.to_string(),
        account: account(),
        bytes_up,
        bytes_down,
        duration_ms: started.elapsed().as_millis() as u64,
        result,
        commands: None,
    };
    (out, Some(ev))
}

/// The error with its cause chain, the URL (path and query can carry
/// tokens) cut down to host:port.
fn error_text(e: &reqwest::Error, host: &str, port: u16) -> String {
    let mut text = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        text.push_str(": ");
        text.push_str(&s.to_string());
        source = s.source();
    }
    match e.url() {
        Some(u) => text.replace(u.as_str(), &format!("{host}:{port}")),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn ev(purpose: &str, port: u16) -> NetEvent {
        NetEvent {
            at_ms: 1,
            direction: Direction::Out,
            process: "helper",
            protocol: Protocol::TcpProbe,
            host: "h".into(),
            ip: None,
            port,
            purpose: purpose.into(),
            account: None,
            bytes_up: 0,
            bytes_down: 0,
            duration_ms: 0,
            result: "ok".into(),
            commands: None,
        }
    }

    /// Other tests record into the global ring in parallel: pick ours by port.
    fn events_on(port: u16) -> Vec<NetEvent> {
        snapshot().into_iter().filter(|e| e.port == port && e.host == "127.0.0.1").collect()
    }

    #[test]
    fn the_ring_keeps_the_newest_capacity_events_newest_first() {
        let mut ring = Ring::new();
        for i in 0..(CAPACITY + 5) {
            ring.push(ev(&i.to_string(), 0));
        }
        let snap = ring.snapshot();
        assert_eq!(snap.len(), CAPACITY);
        assert_eq!(snap[0].purpose, (CAPACITY + 4).to_string());
        assert_eq!(snap[CAPACITY - 1].purpose, "5");
    }

    /// The only test that subscribes: the listener is global, and a second
    /// one in parallel would replace this one.
    #[test]
    fn the_listener_sees_every_record() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        subscribe(Box::new(move |e| sink.lock().unwrap().push(serde_json::to_string(e).unwrap())));
        for p in ["listener-a", "listener-b", "listener-c"] {
            record(ev(p, 1));
        }
        // The listener forwards to the app and the store: the account as its
        // address, the result masked.
        let mut addressed = ev("listener-address", 1);
        addressed.account = Some("Listener.Person@gmail.com".into());
        addressed.result = "Login failed for listener.person@gmail.com".into();
        record(addressed);
        unsubscribe();
        let seen = seen.lock().unwrap();
        for p in ["listener-a", "listener-b", "listener-c", "listener-address"] {
            assert!(seen.iter().any(|s| s.contains(&format!("\"{p}\""))), "{p} not seen: {seen:?}");
        }
        let addressed: serde_json::Value =
            serde_json::from_str(seen.iter().find(|s| s.contains("\"listener-address\"")).unwrap()).unwrap();
        assert_eq!(addressed["account"], "Listener.Person@gmail.com");
        let result = addressed["result"].as_str().unwrap();
        assert!(!result.to_lowercase().contains("listener.person@gmail.com"), "a raw address in the result: {result}");
        assert!(snapshot().iter().any(|e| e.purpose == "listener-c"));
    }

    #[test]
    fn the_account_is_its_address_and_an_address_in_the_result_is_masked() {
        let mut e = ev("mask-test", 2);
        e.account = Some("Masked.Person@gmail.com".into());
        e.result = "Login failed for masked.person@gmail.com: NO".into();
        record(e);
        let got = snapshot().into_iter().find(|e| e.purpose == "mask-test").expect("recorded");
        assert_eq!(got.account.as_deref(), Some("Masked.Person@gmail.com"));
        assert!(!got.result.to_lowercase().contains("masked.person@gmail.com"), "{}", got.result);
        assert!(got.result.starts_with("Login failed for <gmail#"), "{}", got.result);
    }

    #[test]
    fn a_reported_event_is_always_the_apps_and_outgoing() {
        let sent = serde_json::json!({
            "atMs": 5, "direction": "in", "process": "helper", "protocol": "https",
            "host": "github.com", "ip": null, "port": 443, "purpose": "report-test",
            "account": "someone@example.com", "bytesUp": 10, "bytesDown": 20,
            "durationMs": 30, "result": "ok", "commands": 4,
        });
        record_reported(sent).expect("a well-formed report");
        let got = snapshot().into_iter().find(|e| e.purpose == "report-test").expect("recorded");
        assert_eq!(got.process, "app");
        assert_eq!(got.direction, Direction::Out);
        assert_eq!(got.protocol, Protocol::Https);
        assert_eq!((got.host.as_str(), got.port), ("github.com", 443));
        assert_eq!((got.bytes_up, got.bytes_down, got.duration_ms), (10, 20, 30));
        assert_eq!(got.account, None, "the app never names an account");
        assert_eq!(got.commands, None);
        assert!(record_reported(serde_json::json!({"host": "x"})).is_err(), "a malformed report is refused");
    }

    #[tokio::test]
    async fn a_scoped_purpose_wins_over_the_lane_default() {
        assert_eq!(purpose(), "sync", "outside any scope");
        assert_eq!(with_default_purpose("open message", async { purpose() }).await, "open message");
        let nested = with_purpose("backup", with_default_purpose("sync", async { purpose() })).await;
        assert_eq!(nested, "backup", "a backup's background reads stay backup");
    }

    #[test]
    fn a_pending_event_is_recorded_when_dropped() {
        let p = Pending::new(NetEvent::out(Protocol::Dns, "pending.test", 53, "pending-test"));
        drop(p);
        let got = snapshot().into_iter().find(|e| e.purpose == "pending-test").expect("recorded on drop");
        assert_eq!(got.result, "cancelled", "never settled");
        assert_eq!(got.process, "helper");
    }

    #[tokio::test]
    async fn a_sent_request_is_recorded_with_host_port_and_purpose() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello").await.unwrap();
        });
        let client = http_client("sync", Some(Duration::from_secs(5)));
        let resp = client
            .send(client.post(format!("http://127.0.0.1:{port}/p?token=abc")).body("12345678"))
            .await
            .unwrap();
        assert!(resp.status().is_success());
        let events = events_on(port);
        assert_eq!(events.len(), 1, "{events:?}");
        let e = &events[0];
        assert_eq!(e.result, "ok");
        assert_eq!(e.purpose, "sync");
        assert_eq!(e.protocol, Protocol::Http);
        assert_eq!(e.direction, Direction::Out);
        assert_eq!(e.process, "helper");
        assert_eq!(e.ip.as_deref(), Some("127.0.0.1"));
        assert_eq!(e.bytes_up, 8);
        assert_eq!(e.bytes_down, 5);
    }

    /// A loopback server answering one request with an empty 200.
    async fn serve_once() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await.unwrap();
        });
        port
    }

    /// The account an RPC names reaches every event recorded under it: a
    /// request, one the shell measures, and a lookup built in scope.
    #[tokio::test]
    async fn an_account_scope_names_the_account_on_requests_and_lookups() {
        let port = serve_once().await;
        let client = http_client("open message", Some(Duration::from_secs(5)));
        let sent = client.send(client.get(format!("http://127.0.0.1:{port}/")));
        with_account("scoped@example.test".into(), sent).await.unwrap();
        let events = events_on(port);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].account.as_deref(), Some("scoped@example.test"));

        let port = serve_once().await;
        let measured = measure("export", reqwest::Client::new().get(format!("http://127.0.0.1:{port}/")));
        let (_, ev) = with_account("measured@example.test".into(), measured).await;
        assert_eq!(ev.expect("sent").account.as_deref(), Some("measured@example.test"));

        let lookup = with_account("dns@example.test".into(), async { NetEvent::out(Protocol::Dns, "bimi.test", 53, "open message") }).await;
        assert_eq!(lookup.account.as_deref(), Some("dns@example.test"));
        assert_eq!(NetEvent::out(Protocol::Dns, "bimi.test", 53, "sync").account, None, "no scope, no account");
    }

    /// A migration holds the source's and the destination's clients in one
    /// future: each client's own account wins over whatever scope sends it.
    #[tokio::test]
    async fn a_clients_own_account_wins_over_the_scope() {
        let port = serve_once().await;
        let client = http_client("sync", Some(Duration::from_secs(5))).for_account("source@example.test");
        let sent = client.send(client.get(format!("http://127.0.0.1:{port}/")));
        with_account("dest@example.test".into(), sent).await.unwrap();
        assert_eq!(events_on(port)[0].account.as_deref(), Some("source@example.test"));
    }

    /// The shell's own requests are never an account's, whatever scope the
    /// report arrives in.
    #[tokio::test]
    async fn a_reported_event_names_no_account_even_inside_a_scope() {
        let sent = serde_json::json!({
            "atMs": 5, "protocol": "https", "host": "github.com", "ip": null, "port": 443,
            "purpose": "report-scope-test", "bytesUp": 1, "bytesDown": 2, "durationMs": 3, "result": "ok",
        });
        with_account("scope@example.test".into(), async move { record_reported(sent).unwrap() }).await;
        let got = snapshot().into_iter().find(|e| e.purpose == "report-scope-test").expect("recorded");
        assert_eq!(got.account, None);
    }

    #[tokio::test]
    async fn a_refused_connection_is_recorded_without_the_url_and_still_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let client = http_client("export", Some(Duration::from_secs(5)));
        let out = client.send(client.get(format!("http://127.0.0.1:{port}/secret?token=abc"))).await;
        assert!(out.is_err());
        let events = events_on(port);
        assert_eq!(events.len(), 1, "{events:?}");
        let e = &events[0];
        assert_ne!(e.result, "ok");
        assert!(!e.result.is_empty());
        assert!(!e.result.contains("token=abc"), "{}", e.result);
        assert!(!e.result.contains("/secret"), "{}", e.result);
        assert_eq!(e.purpose, "export");
    }

    #[test]
    fn events_serialize_camel_case() {
        let mut e = ev("sync", 993);
        e.protocol = Protocol::TcpProbe;
        e.bytes_up = 3;
        let v = serde_json::to_value(&e).unwrap();
        for key in ["atMs", "bytesUp", "bytesDown", "durationMs"] {
            assert!(v.get(key).is_some(), "{key} missing: {v}");
        }
        assert!(v.get("bytes_up").is_none());
        assert_eq!(v["direction"], "out");
        assert_eq!(v["protocol"], "tcpProbe");
        assert_eq!(v["process"], "helper");
    }
}
