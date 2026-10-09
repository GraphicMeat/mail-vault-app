//! Plain `std::net` HTTP/1.1 client helpers for tests, so no dev-dependency is needed.
//! They speak `http://` only, one request per connection.

use base64::Engine;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub fn base64_encode(input: impl AsRef<[u8]>) -> String {
    base64::engine::general_purpose::STANDARD.encode(input)
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    /// Names lowercased.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str())
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    /// The body as JSON, `Value::Null` when it is not JSON.
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

/// `http://host:port/path?q` -> ("host:port", "/path?q").
fn split_url(url: &str) -> (String, String) {
    let rest = url.strip_prefix("http://").unwrap_or_else(|| panic!("testkit speaks plain http only: {url}"));
    match rest.find('/') {
        Some(i) => (rest[..i].to_string(), rest[i..].to_string()),
        None => (rest.to_string(), "/".to_string()),
    }
}

fn absolutize(base: &str, location: &str) -> String {
    if location.starts_with("http://") || location.starts_with("https://") {
        return location.to_string();
    }
    let (host, _) = split_url(base);
    format!("http://{host}{location}")
}

/// One request; reads the response until the server closes the connection.
pub fn http_request(method: &str, url: &str, headers: &[(&str, &str)], body: &[u8]) -> HttpResponse {
    let (host, path) = split_url(url);
    let mut s = TcpStream::connect(&host).unwrap_or_else(|e| panic!("connect {host}: {e}"));
    s.set_read_timeout(Some(Duration::from_secs(30))).ok();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).expect("write request head");
    s.write_all(body).expect("write request body");
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).expect("read response");
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n").expect("response header block");
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next().and_then(|l| l.split(' ').nth(1)).and_then(|c| c.parse().ok()).expect("status line");
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    HttpResponse { status, headers, body: buf[end + 4..].to_vec() }
}

fn get(url: &str, auth: Option<&str>) -> HttpResponse {
    let mut url = url.to_string();
    for _ in 0..5 {
        let headers: Vec<(&str, &str)> = auth.map(|a| vec![("Authorization", a)]).unwrap_or_default();
        let r = http_request("GET", &url, &headers, b"");
        if matches!(r.status, 301 | 302 | 307 | 308) {
            if let Some(loc) = r.header("location") {
                url = absolutize(&url, loc);
                continue;
            }
        }
        return r;
    }
    panic!("too many redirects")
}

/// GET following up to 5 redirects. Returns (status, body text).
pub fn http_get(url: &str, auth: Option<&str>) -> (u16, String) {
    let r = get(url, auth);
    (r.status, r.text())
}

/// GET following up to 5 redirects. Returns (status, body bytes).
pub fn http_get_bytes(url: &str, auth: Option<&str>) -> (u16, Vec<u8>) {
    let r = get(url, auth);
    (r.status, r.body)
}

/// GET without following redirects. Returns (status, Location header or "").
pub fn http_get_no_follow(url: &str) -> (u16, String) {
    let r = http_request("GET", url, &[], b"");
    (r.status, r.header("location").unwrap_or_default().to_string())
}

/// POST a JSON body. Returns (status, body as JSON or `Value::Null`).
pub fn http_post_json(url: &str, auth: &str, body: &Value) -> (u16, Value) {
    let r = http_request(
        "POST",
        url,
        &[("Authorization", auth), ("Content-Type", "application/json")],
        body.to_string().as_bytes(),
    );
    (r.status, r.json())
}

/// POST raw bytes as `message/rfc822`. Returns (status, body text).
pub fn http_post_bytes(url: &str, auth: &str, body: &[u8]) -> (u16, String) {
    let r = http_request("POST", url, &[("Authorization", auth), ("Content-Type", "message/rfc822")], body);
    (r.status, r.text())
}

#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// An open EventSource connection. Dropping it closes the socket.
pub struct EventStream {
    pub status: u16,
    rx: mpsc::Receiver<SseEvent>,
    stream: TcpStream,
}

impl EventStream {
    /// The next non-ping event within `timeout`.
    pub fn next_event(&self, timeout: Duration) -> Option<SseEvent> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.checked_duration_since(Instant::now())?;
            match self.rx.recv_timeout(left) {
                Ok(e) if e.event == "ping" => continue,
                Ok(e) => return Some(e),
                Err(_) => return None,
            }
        }
    }

    /// The next event of any kind (pings included) within `timeout`.
    pub fn next_any_event(&self, timeout: Duration) -> Option<SseEvent> {
        self.rx.recv_timeout(timeout).ok()
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

/// Open an EventSource stream. Returns once the response header block is read, so a
/// change made after this call always reaches the stream as an event.
pub fn open_event_stream(url: &str, auth: &str) -> EventStream {
    let (host, path) = split_url(url);
    let mut s = TcpStream::connect(&host).unwrap_or_else(|e| panic!("connect {host}: {e}"));
    let head = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\nAccept: text/event-stream\r\n\r\n");
    s.write_all(head.as_bytes()).expect("write request");
    let mut r = BufReader::new(s.try_clone().expect("clone stream"));
    let mut line = String::new();
    r.read_line(&mut line).expect("status line");
    let status = line.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
            break;
        }
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut event, mut data) = (String::new(), String::new());
        loop {
            let mut l = String::new();
            match r.read_line(&mut l) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let l = l.trim_end_matches(['\r', '\n']);
            if l.is_empty() {
                if !event.is_empty() || !data.is_empty() {
                    let ev = SseEvent {
                        event: if event.is_empty() { "message".into() } else { std::mem::take(&mut event) },
                        data: std::mem::take(&mut data),
                    };
                    if tx.send(ev).is_err() {
                        break;
                    }
                }
            } else if let Some(v) = l.strip_prefix("event:") {
                event = v.trim().to_string();
            } else if let Some(v) = l.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(v.trim_start());
            }
        }
    });
    EventStream { status, rx, stream: s }
}
