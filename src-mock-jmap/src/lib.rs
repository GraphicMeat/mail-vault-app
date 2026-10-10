//! Scriptable mock JMAP server (RFC 8620 core, RFC 8621 mail) for MailVault tests.
//!
//! Plaintext HTTP/1.1 on loopback, blocking `std::net`, one thread per connection:
//! no async runtime, so it serves tokio tests in the daemon and plain `#[test]`s in
//! core alike. Same shape as `src-mock-imap`: a serde `Scenario` seeds the state,
//! `faults` inject provider misbehaviour, and the `mock-jmap-server` bin serves e2e.
//!
//! State strings are per-account counters. Every change appends one log entry per
//! changed id, so `Email/changes` with `maxChanges` hands out exact intermediate
//! states. Change the server from a test with `MockJmap::mutate` and the `State`
//! helpers (`set_keywords`, `add_email`, `destroy_email`, ...): they log the change,
//! and `mutate` pushes a StateChange to every open EventSource stream, even when
//! nothing changed (so `m.mutate(|_| {})` re-sends the current state).

pub mod http;
pub mod methods;
pub mod state;
pub mod testkit;

pub use state::{Account, Email, Identity, Kind, LogEntry, Mailbox, Op, SetError, State};
pub use testkit::*;

use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Server state plus faults. Every field is optional in JSON (the bin's stdin).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Scenario {
    pub accounts: Vec<ScenarioAccount>,
    pub faults: Vec<Fault>,
    pub limits: Limits,
}

/// One user with one mail account. Accounts get ids `acc1`, `acc2`, ... in order.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ScenarioAccount {
    pub username: String,
    pub password: String,
    /// Accepted as `Authorization: Bearer <token>`.
    pub token: Option<String>,
    pub mailboxes: Vec<ScenarioMailbox>,
    /// `(email, name)`. Identity ids are `id1`, `id2`, ... in order.
    pub identities: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ScenarioMailbox {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    /// RFC 8621 role: "inbox", "sent", "drafts", "trash", "junk", "archive", ...
    pub role: Option<String>,
    pub emails: Vec<ScenarioEmail>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ScenarioEmail {
    pub id: String,
    /// The RFC 5322 message. Header properties are parsed from it on demand.
    pub raw: String,
    /// JMAP keywords, e.g. "$seen". Stored lowercased.
    pub keywords: Vec<String>,
    /// UTC "YYYY-MM-DDTHH:MM:SSZ". Empty means 2026-01-01T00:00:00Z.
    pub received_at: String,
    /// Extra mailbox ids (labels) besides the mailbox that lists the email.
    pub also_in: Vec<String>,
}

/// Provider misbehaviour. All faults persist except `RateLimited`, which is used up
/// by the next `POST /jmap/api`. Faults live in `State::faults`, so a test can add or
/// remove them after start with `m.mutate(|s| s.faults.push(..))`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Fault {
    /// `Email/changes` and `Mailbox/changes` answer `cannotCalculateChanges`.
    CannotCalculateChanges,
    /// Every authenticated endpoint answers 401, whatever the credentials.
    Unauthorized,
    /// The next API call answers HTTP 429 with `Retry-After: <secs>`.
    RateLimited { retry_after_secs: u64 },
    /// `Email/import` stores the message with "\r\n" appended: blobId and size differ from the upload.
    ImportRepairs,
    /// `Email/import` answers `alreadyExists` + `existingId` when the Message-ID is already in the account.
    ImportAlreadyExists,
    /// `EmailSubmission/set` answers `notCreated` with type `forbiddenFrom`.
    SubmissionRejected,
    /// After N events (state or ping) an EventSource stream goes silent but stays open: a dead proxy.
    DropEventSourceAfter { events: usize },
    /// An EventSource stream sends one `state` event (the current state) right after its headers and closes: a proxy that hangs up after greeting.
    HangUpEventSourceAfterOneEvent,
    /// This method name answers `["error", {"type":"serverFail"}, tag]`.
    ServerFail { method: String },
}

/// Advertised in the session's core capability and enforced by the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Limits {
    pub max_objects_in_get: usize,
    pub max_objects_in_set: usize,
    pub max_calls_in_request: usize,
    pub max_size_upload: u64,
    /// Server cap on `Email/query` `limit` (not advertised; RFC 8620 §5.5 lets servers cap).
    pub max_query_limit: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_objects_in_get: 500,
            max_objects_in_set: 500,
            max_calls_in_request: 16,
            max_size_upload: 50_000_000,
            max_query_limit: 1000,
        }
    }
}

/// One HTTP request the mock received (control routes under `/_mock/` are not recorded).
#[derive(Debug, Clone, Serialize)]
pub struct RecordedRequest {
    /// HTTP method, e.g. "POST".
    pub method: String,
    /// Path plus query, as sent.
    pub path: String,
    pub authorization: Option<String>,
    /// JMAP method names of a `/jmap/api` request, in order. Empty for other routes.
    pub calls: Vec<String>,
    /// The body as lossy UTF-8.
    pub body: String,
    /// True when the request hit the second (download) listener.
    pub download_listener: bool,
}

impl RecordedRequest {
    pub fn body_contains(&self, needle: &str) -> bool {
        self.body.contains(needle)
    }
    pub fn is_api(&self) -> bool {
        self.path.starts_with("/jmap/api")
    }
}

pub struct MockJmap {
    shared: Arc<http::Shared>,
    addr: SocketAddr,
    download_addr: SocketAddr,
}

impl MockJmap {
    /// Bind two loopback listeners (API and download) and serve on background threads.
    pub fn start(scenario: Scenario) -> MockJmap {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock jmap");
        let download = TcpListener::bind("127.0.0.1:0").expect("bind mock jmap download host");
        let addr = listener.local_addr().expect("local_addr");
        let download_addr = download.local_addr().expect("local_addr");
        let shared = Arc::new(http::Shared::new(
            State::from_scenario(&scenario),
            format!("http://{addr}"),
            format!("http://{download_addr}"),
        ));
        http::serve(listener, shared.clone(), false);
        http::serve(download, shared.clone(), true);
        MockJmap { shared, addr, download_addr }
    }

    /// For example `http://127.0.0.1:53211`.
    pub fn base_url(&self) -> String {
        self.shared.base.clone()
    }

    /// `{base}/jmap/session`.
    pub fn session_url(&self) -> String {
        format!("{}/jmap/session", self.shared.base)
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// The second listener, advertised in `downloadUrl` while `State::download_host` is set.
    pub fn download_port(&self) -> u16 {
        self.download_addr.port()
    }

    /// Every request received so far, in order.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.shared.requests.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// How many method calls named `method` (e.g. "Email/get") the API received.
    pub fn count_calls(&self, method: &str) -> usize {
        self.requests().iter().flat_map(|r| r.calls.iter()).filter(|c| *c == method).count()
    }

    /// Raw messages that `EmailSubmission/set` accepted, in order.
    pub fn submitted(&self) -> Vec<Vec<u8>> {
        self.shared.lock().submitted.clone()
    }

    /// Read the server state without notifying EventSource streams.
    pub fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.shared.lock())
    }

    /// Change the server state, then push a StateChange to every open EventSource
    /// stream. Use the `State` helpers so the change lands in the change log.
    pub fn mutate<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let r = {
            let mut st = self.shared.lock();
            let r = f(&mut st);
            st.notify_gen += 1;
            r
        };
        self.shared.notify();
        r
    }
}

impl Drop for MockJmap {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.notify();
        // Wake both blocking accept() loops so their threads exit.
        let _ = TcpStream::connect(self.addr);
        let _ = TcpStream::connect(self.download_addr);
    }
}
