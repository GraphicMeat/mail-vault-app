//! Network Activity: every connection the helper makes, kept in memory only.
//!
//! A ring of the newest `CAPACITY` events, never persisted and gone on quit
//! (privacy). HTTP goes through `http_client` / `http_client_with`, whose
//! `Tracked::send` records one event per request. Events carry host and port
//! only, never a URL path or query (those can hold tokens), and `account` is
//! a masked label, never an address.
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Out,
    In,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

/// Record one event: into the ring (oldest dropped past `CAPACITY`), then to
/// the listener.
pub fn record(ev: NetEvent) {
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

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A reqwest client that records every request sent through `send`.
/// Derefs to the client so call sites build requests as before.
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
        // The builder's own client carries the site's timeout and policy.
        let (client, request) = req.build_split();
        let request = request?;
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
        record(NetEvent {
            at_ms,
            direction: Direction::Out,
            process: "helper",
            protocol,
            host,
            ip,
            port,
            purpose: self.purpose.clone(),
            account: None,
            bytes_up,
            bytes_down,
            duration_ms: started.elapsed().as_millis() as u64,
            result,
            commands: None,
        });
        out
    }
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

    #[test]
    fn the_listener_sees_every_record() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        subscribe(Box::new(move |e| sink.lock().unwrap().push(e.purpose.clone())));
        for p in ["listener-a", "listener-b", "listener-c"] {
            record(ev(p, 1));
        }
        let seen = seen.lock().unwrap();
        for p in ["listener-a", "listener-b", "listener-c"] {
            assert!(seen.iter().any(|s| s == p), "{p} not seen: {seen:?}");
        }
        assert!(snapshot().iter().any(|e| e.purpose == "listener-c"));
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
