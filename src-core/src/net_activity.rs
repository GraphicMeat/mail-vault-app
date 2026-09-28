//! Network Activity: every connection the helper makes, kept in memory only.
//!
//! A ring of the newest `CAPACITY` events, never persisted and gone on quit
//! (privacy). HTTP goes through `http_client` / `http_client_with`, whose
//! `Tracked::send` records one event per request. Events carry host and port
//! only, never a URL path or query (those can hold tokens), and `account` is
//! a masked label, never an address.
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
    /// Masked label, never a raw address.
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
            account: None,
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

/// Record one event: addresses masked first, then to the listener, then into
/// the ring (oldest dropped past `CAPACITY`).
///
/// The listener runs under the `LISTENER` read lock and before the push, so
/// the event is not yet in `snapshot()` when it sees it, and it must never
/// call `record` or `subscribe` (a deadlock on the lock).
pub fn record(mut ev: NetEvent) {
    ev.account = ev.account.map(|a| mask(&a));
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
/// account reads with the same token here as in the logs. Unset, a salt for
/// this process is used.
pub fn set_salt(salt: [u8; 16]) {
    let _ = SALT.set(salt);
}

/// Every address in `s` masked exactly as the Standard logs mask it,
/// whatever the log level: this page never shows a raw address.
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
    }
}

impl Tracked {
    pub fn purpose(&self) -> &str {
        &self.purpose
    }

    /// Send `req` and record it: host, port, resolved IP, status, duration,
    /// bytes up (body length when known), bytes down (content-length when
    /// known). A request that fails to build never reached the wire and is
    /// not recorded.
    pub async fn send(&self, req: reqwest::RequestBuilder) -> reqwest::Result<reqwest::Response> {
        let (out, ev) = measure(&self.purpose, req).await;
        if let Some(ev) = ev {
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
        account: None,
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
        // The listener forwards to the app, so it must get the masked event.
        let mut addressed = ev("listener-address", 1);
        addressed.account = Some("Listener.Person@gmail.com".into());
        addressed.result = "Login failed for listener.person@gmail.com".into();
        record(addressed);
        unsubscribe();
        let seen = seen.lock().unwrap();
        for p in ["listener-a", "listener-b", "listener-c", "listener-address"] {
            assert!(seen.iter().any(|s| s.contains(&format!("\"{p}\""))), "{p} not seen: {seen:?}");
        }
        assert!(
            seen.iter().all(|s| !s.to_lowercase().contains("listener.person@gmail.com")),
            "a raw address reached the listener: {seen:?}"
        );
        assert!(snapshot().iter().any(|e| e.purpose == "listener-c"));
    }

    #[test]
    fn an_address_is_masked_in_the_account_and_the_result() {
        let mut e = ev("mask-test", 2);
        e.account = Some("Masked.Person@gmail.com".into());
        e.result = "Login failed for masked.person@gmail.com: NO".into();
        record(e);
        let got = snapshot().into_iter().find(|e| e.purpose == "mask-test").expect("recorded");
        let json = serde_json::to_string(&got).unwrap().to_lowercase();
        assert!(!json.contains("masked.person@gmail.com"), "{json}");
        assert!(got.account.as_deref().is_some_and(|a| a.starts_with("<gmail#")), "{:?}", got.account);
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
