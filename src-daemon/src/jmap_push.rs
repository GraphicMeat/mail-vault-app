//! JMAP push: the daemon's ear on a JMAP account, the EventSource (RFC 8620
//! §7.3) counterpart of `idle_watch`'s IDLE.
//!
//! One task per JMAP account, spawned by `IdleWatchers::watch` into the same
//! task map as the IDLE watchers, so `sync.unwatch`, `sync.watch_status` and
//! shutdown cover it unchanged: they abort its handle, there is no stop flag.
//!
//! - The stream is `types=Email,Mailbox&closeafter=no&ping=30` on the push
//!   client (read-idle timeout only). After every connect, once the server
//!   has answered and before the first read, the INBOX sync runs: changes
//!   made while no stream was open raise no event on the new one.
//! - `event: state` for this JMAP account whose Email state is not the stored
//!   one (`JmapMeta::email_state`) runs the INBOX sync. JMAP changes are
//!   account-wide, so that one sync patches every cached mailbox and
//!   publishes each itself (`sync_jmap`): nothing here calls `note_change`.
//! - A Mailbox state the account's map has not seen refreshes the map
//!   (`AccountJmap::refresh`). The app has no folder-list event to hear it
//!   (IMAP has none either); it reloads its folders on its own.
//! - No bytes for `dead_after` (2 x ping + 5 s) is a dead stream: drop it and
//!   connect again after 1 s, 2 s, 4 s ... (at most 5 min). A stream that
//!   never delivered an event counts as a failure; one that did resets the
//!   count. After 3 failures in a row: sync every 2 min and try the stream
//!   again every 10 min. A session without `eventSourceUrl` only polls.
//!
//! The inbox arrivals a sync reports get their bodies kept as an IDLE
//! watcher's do (`handlers::imap::cache_arrivals`, which downloads a JMAP
//! account's by blob), on a task of their own so the stream is read again at
//! once. Arrivals in other mailboxes wake the hoarder (`sync_jmap`).

use crate::handlers::common::blocking;
use crate::idle_watch::WatchStatus;
use crate::jmap_sessions::JmapMeta;
use crate::server::DaemonState;
use crate::sync_engine::SyncAccount;
use mailvault_core::jmap::JmapError;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{info, warn};

/// The EventSource types the stream asks for.
const PUSH_TYPES: &str = "Email,Mailbox";

/// Longest SSE line kept: a server that never sends a newline cannot grow
/// the buffer without bound.
const MAX_LINE: usize = 1 << 20;

/// No bytes for this long, with pings asked for every `ping_secs`, is a dead
/// stream (a proxy that holds the socket open and forwards nothing).
pub const fn dead_after(ping_secs: u32) -> Duration {
    Duration::from_secs(2 * ping_secs as u64 + 5)
}

/// Every interval the push loop waits on. `PRODUCTION` in the daemon. Tests
/// shrink it (`IdleWatchers::set_push_timing`): the mock serves real sockets
/// from real threads, so paused tokio time cannot drive it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushTiming {
    /// The `ping` asked of the server, in seconds.
    pub ping_secs: u32,
    /// No bytes for this long: the stream is dead.
    pub dead_after: Duration,
    /// The server must answer the EventSource GET within this long.
    pub open_timeout: Duration,
    /// The wait after the first failure; doubles per failure in a row.
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    /// Failures in a row after which the loop polls.
    pub failures_before_poll: u32,
    /// The sync interval while polling.
    pub poll_every: Duration,
    /// While polling, how often the stream is tried again.
    pub stream_retry_every: Duration,
}

impl PushTiming {
    pub const PRODUCTION: PushTiming = PushTiming {
        ping_secs: 30,
        dead_after: dead_after(30),
        open_timeout: Duration::from_secs(65),
        backoff_base: Duration::from_secs(1),
        backoff_cap: Duration::from_secs(300),
        failures_before_poll: 3,
        poll_every: Duration::from_secs(120),
        stream_retry_every: Duration::from_secs(600),
    };

    /// The wait after the `failures`-th failure in a row (from 1): the base,
    /// doubled per failure, at most the cap.
    pub fn backoff(&self, failures: u32) -> Duration {
        let shift = failures.saturating_sub(1).min(31);
        self.backoff_base.saturating_mul(1u32 << shift).min(self.backoff_cap)
    }
}

/// One Server-Sent Event: its `event:` type ("message" when none was given)
/// and its `data:` lines joined with "\n".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub kind: String,
    pub data: String,
}

/// An incremental `text/event-stream` parser: chunks go in as they arrive,
/// split anywhere, and each event a blank line completes comes out.
#[derive(Default)]
pub struct SseParser {
    line: Vec<u8>,
    kind: String,
    data: Vec<String>,
    /// Summed bytes of `data`: a pending event is capped at `MAX_LINE`.
    data_bytes: usize,
    /// The pending event outgrew the cap: its remaining lines are skipped up
    /// to the blank line that ends it.
    discarding: bool,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        for &b in chunk {
            if b != b'\n' {
                if self.line.len() < MAX_LINE {
                    self.line.push(b);
                }
                continue;
            }
            let raw = std::mem::take(&mut self.line);
            let text = String::from_utf8_lossy(&raw).into_owned();
            let line = text.strip_suffix('\r').unwrap_or(text.as_str());
            if line.is_empty() {
                self.data_bytes = 0;
                if std::mem::take(&mut self.discarding) {
                    continue;
                }
                if !self.kind.is_empty() || !self.data.is_empty() {
                    let kind = std::mem::take(&mut self.kind);
                    out.push(SseEvent {
                        kind: if kind.is_empty() { "message".to_string() } else { kind },
                        data: std::mem::take(&mut self.data).join("\n"),
                    });
                }
                continue;
            }
            if self.discarding {
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
                None => (line, ""),
            };
            match field {
                "event" => self.kind = value.to_string(),
                "data" => {
                    self.data_bytes = self.data_bytes.saturating_add(value.len());
                    if self.data_bytes > MAX_LINE {
                        // Endless `data:` lines with no blank line: drop the
                        // event (never logging its content) and skip the rest.
                        warn!("[push] an event grew past {} bytes without ending: dropped", MAX_LINE);
                        self.data.clear();
                        self.kind.clear();
                        self.discarding = true;
                    } else {
                        self.data.push(value.to_string());
                    }
                }
                _ => {}
            }
        }
        out
    }
}

/// How one stream ended.
enum Ended {
    /// The session has no `eventSourceUrl`: poll only.
    NoEventSource,
    /// Never opened, or lost. `healthy`: it delivered an event and then
    /// lived for at least `dead_after`; a stream that hangs up sooner is a
    /// failure however much it sent (R11), or a server that greets and
    /// closes would reconnect and sync every second forever.
    Lost { healthy: bool, error: String },
}

/// One JMAP account's push watcher. Loops until its task is aborted
/// (`IdleWatchers::unwatch`, a replaced watcher, shutdown).
///
/// `slot` is read at every connect and every sync, so credentials `watch`
/// hands over reach the next request. `status` is what `sync.watch_status`
/// reports: `mode` "stream" (listening, `idling` true), "backoff" (waiting to
/// connect again) or "polling" (syncing on a timer).
pub async fn run(
    state: Arc<DaemonState>,
    slot: Arc<Mutex<SyncAccount>>,
    status: Arc<Mutex<WatchStatus>>,
    timing: PushTiming,
) {
    let mut failures: u32 = 0;
    loop {
        if !state.net.is_online() {
            set_mode(&status, "backoff");
            tokio::time::sleep(timing.backoff_base).await;
            continue;
        }
        match stream_once(&state, &slot, &status, &timing).await {
            Ended::NoEventSource => {
                let email = slot.lock().unwrap().email.clone();
                info!("[push] {}: the server offers no EventSource: syncing every {:?}", email, timing.poll_every);
                set_mode(&status, "polling");
                loop {
                    sync_inbox(&state, &slot).await;
                    tokio::time::sleep(timing.poll_every).await;
                }
            }
            Ended::Lost { healthy, error } => {
                if healthy {
                    failures = 0;
                }
                failures = failures.saturating_add(1);
                let email = slot.lock().unwrap().email.clone();
                warn!("[push] {}: stream lost ({} in a row): {}", email, failures, error);
                let polling = failures >= timing.failures_before_poll;
                {
                    let mut s = status.lock().unwrap();
                    s.idling = false;
                    s.last_error = Some(error);
                    s.mode = Some(if polling { "polling" } else { "backoff" }.to_string());
                }
                if polling {
                    poll_until_retry(&state, &slot, &timing).await;
                } else {
                    tokio::time::sleep(timing.backoff(failures)).await;
                }
            }
        }
    }
}

fn set_mode(status: &Mutex<WatchStatus>, mode: &str) {
    let mut s = status.lock().unwrap();
    s.idling = false;
    s.mode = Some(mode.to_string());
}

/// Sync every `poll_every` until `stream_retry_every` has passed, then return
/// so the loop tries the stream again.
async fn poll_until_retry(state: &Arc<DaemonState>, slot: &Mutex<SyncAccount>, timing: &PushTiming) {
    let deadline = tokio::time::Instant::now() + timing.stream_retry_every;
    loop {
        sync_inbox(state, slot).await;
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return;
        }
        tokio::time::sleep(timing.poll_every.min(left)).await;
        if tokio::time::Instant::now() >= deadline {
            return;
        }
    }
}

/// Connect, catch up, then read the stream until it dies.
async fn stream_once(
    state: &Arc<DaemonState>,
    slot: &Mutex<SyncAccount>,
    status: &Mutex<WatchStatus>,
    timing: &PushTiming,
) -> Ended {
    let lost = |error: String| Ended::Lost { healthy: false, error };
    // Read at every connect: `watch` may have handed over new credentials.
    let (account_id, cfg) = {
        let account = slot.lock().unwrap();
        (account.id.clone(), account.imap_config.clone())
    };
    let acct = match state.jmap.get(&cfg).await {
        Ok(acct) => acct,
        Err(e) => return lost(e.to_string()),
    };
    if acct.client.event_source_url().is_none() {
        return Ended::NoEventSource;
    }
    let opened = tokio::time::timeout(timing.open_timeout, acct.client.open_event_source(PUSH_TYPES, timing.ping_secs)).await;
    let mut resp = match opened {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            // A revoked session: the next try connects afresh.
            if matches!(e, JmapError::Unauthorized) {
                state.jmap.forget(&cfg);
            }
            return lost(e.to_string());
        }
        Err(_) => return lost(format!("EventSource did not answer within {:?}", timing.open_timeout)),
    };
    let started = std::time::Instant::now();
    // The server counts changes from its answer on, so whatever changed
    // before it is found by this sync, and whatever changes during it still
    // arrives as an event.
    sync_inbox(state, slot).await;
    {
        let mut s = status.lock().unwrap();
        s.idling = true;
        s.last_error = None;
        s.mode = Some("stream".to_string());
    }
    let jmap_account = acct.client.account_id().to_string();
    let mut parser = SseParser::default();
    let mut got_event = false;
    let ended = |got_event: bool, error: String| Ended::Lost { healthy: got_event && started.elapsed() >= timing.dead_after, error };
    loop {
        let chunk = match tokio::time::timeout(timing.dead_after, resp.chunk()).await {
            Err(_) => return ended(got_event, format!("EventSource silent for {:?}", timing.dead_after)),
            Ok(Err(e)) => return ended(got_event, format!("EventSource read failed: {}", e.without_url())),
            Ok(Ok(None)) => return ended(got_event, "EventSource closed by the server".to_string()),
            Ok(Ok(Some(chunk))) => chunk,
        };
        for event in parser.feed(&chunk) {
            got_event = true;
            if event.kind == "state" {
                on_state(state, slot, status, &account_id, &jmap_account, &event.data).await;
            }
        }
    }
}

/// One `event: state`. Only this JMAP account's entry counts.
async fn on_state(
    state: &Arc<DaemonState>,
    slot: &Mutex<SyncAccount>,
    status: &Mutex<WatchStatus>,
    account_id: &str,
    jmap_account: &str,
    data: &str,
) {
    let Ok(change) = serde_json::from_str::<Value>(data) else {
        warn!("[push] {}: unreadable StateChange ({} bytes)", account_id, data.len());
        return;
    };
    let mine = &change["changed"][jmap_account];
    if let Some(pushed) = mine["Email"].as_str() {
        if stored_email_state(state, account_id, jmap_account).await.as_deref() != Some(pushed) {
            sync_inbox(state, slot).await;
            status.lock().unwrap().wakeups += 1;
        }
    }
    // After the sync: its `current()` already refreshed a map whose Mailbox
    // state moved, so this refreshes only what it left (a folder change
    // with no mail change).
    if let Some(pushed) = mine["Mailbox"].as_str() {
        let cfg = slot.lock().unwrap().imap_config.clone();
        if let Ok(acct) = state.jmap.get(&cfg).await {
            let known = acct.mailbox_state.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if known != pushed {
                if let Err(e) = acct.refresh().await {
                    warn!("[push] {}: mailbox refresh failed: {}", account_id, e);
                }
            }
        }
    }
}

/// The account's stored Email state, `None` when there is none or it cannot
/// be read (the caller then syncs).
async fn stored_email_state(state: &Arc<DaemonState>, account_id: &str, jmap_account: &str) -> Option<String> {
    let (st, aid, ja) = (Arc::clone(state), account_id.to_string(), jmap_account.to_string());
    blocking(move || crate::custody::with_conn(&st, |c| Ok(JmapMeta::email_state(c, &aid, &ja))))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
}

/// The INBOX sync, through the engine (gate, folder lock, `SyncState`).
/// `sync_jmap` publishes every mailbox it touched and sets `announced`, so
/// nothing is published again here.
async fn sync_inbox(state: &Arc<DaemonState>, slot: &Mutex<SyncAccount>) {
    let account = slot.lock().unwrap().clone();
    let result = state.sync_engine.sync_account_announcing(&account, "INBOX").await;
    if !result.success {
        warn!("[push] {}: sync failed: {:?}", account.email, result.error);
        return;
    }
    // Auto Tags' wake signal, as `handle_sync_now` sends it on new mail.
    if result.new_emails > 0 {
        state.auto_tag_worker.wake();
    }
    // The arrivals' bodies, as `idle_watch` keeps an IDLE arrival's: on a
    // task of their own, so the stream is read again now.
    if !result.arrival_uids.is_empty() {
        let (state, mailbox, uids) = (Arc::clone(state), result.mailbox.clone(), result.arrival_uids);
        tokio::spawn(async move {
            crate::handlers::imap::cache_arrivals(&state, &account, &mailbox, &uids).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_jmap::{Fault, Limits, MockJmap, Scenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};
    use serde_json::json;

    // Real sockets on real threads (the mock), so real time: every interval
    // is short instead of paused. Pings every second; a stream is dead after
    // 2.5 s without a byte, more than two pings missed.
    fn timing() -> PushTiming {
        PushTiming {
            ping_secs: 1,
            dead_after: Duration::from_millis(2_500),
            open_timeout: Duration::from_secs(5),
            backoff_base: Duration::from_millis(50),
            backoff_cap: Duration::from_millis(400),
            failures_before_poll: 3,
            poll_every: Duration::from_millis(200),
            stream_retry_every: Duration::from_secs(60),
        }
    }

    /// A plain message with a Message-ID of `<{id}@x>`.
    fn email(id: &str, subject: &str, received_at: &str) -> ScenarioEmail {
        ScenarioEmail {
            id: id.into(),
            raw: format!("Message-ID: <{id}@x>\r\nSubject: {subject}\r\n\r\nbody of {subject}"),
            keywords: vec![],
            received_at: received_at.into(),
            also_in: vec![],
        }
    }

    /// One account (`acc1` on the server): Inbox (e1, e2) and Trash. Also
    /// lets this process send credentials to the mock's loopback http.
    fn scenario(faults: Vec<Fault>) -> Scenario {
        mailvault_core::jmap::base::allow_loopback_for_tests();
        let mailbox = |id: &str, name: &str, role: &str, emails: Vec<ScenarioEmail>| ScenarioMailbox {
            id: id.into(),
            name: name.into(),
            parent_id: None,
            role: Some(role.into()),
            emails,
        };
        Scenario {
            accounts: vec![ScenarioAccount {
                username: "alice@example.test".into(),
                password: "pw".into(),
                token: Some("tok".into()),
                identities: vec![("alice@example.test".into(), "Alice".into())],
                mailboxes: vec![
                    mailbox(
                        "mb-inbox",
                        "Inbox",
                        "inbox",
                        vec![email("e1", "one", "2026-10-01T10:00:00Z"), email("e2", "two", "2026-10-02T10:00:00Z")],
                    ),
                    mailbox("mb-trash", "Trash", "trash", vec![]),
                ],
            }],
            faults,
            limits: Limits::default(),
        }
    }

    /// The JMAP account as the app registers it (Basic: the address + "pw").
    fn account_for(m: &MockJmap) -> SyncAccount {
        serde_json::from_value(json!({
            "id": "acct-1",
            "email": "alice@example.test",
            "imapConfig": {
                "id": "acct-1",
                "email": "alice@example.test",
                "authType": "password",
                "jmapSessionUrl": m.session_url(),
                "jmapAuth": "basic",
                "password": "pw",
                "imapHost": "127.0.0.1",
            }
        }))
        .unwrap()
    }

    /// A daemon state on a scratch vault with `timing` for its push watchers,
    /// the mock (after `before` ran on its state), and the account, whose
    /// INBOX is synced once so every later sync is a delta.
    async fn setup_with(
        faults: Vec<Fault>,
        timing: PushTiming,
        before: impl FnOnce(&mut mock_jmap::State),
    ) -> (tempfile::TempDir, Arc<DaemonState>, MockJmap, SyncAccount) {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.idle.set_push_timing(timing);
        let m = MockJmap::start(scenario(faults));
        m.mutate(before);
        let account = account_for(&m);
        let primed = state.sync_engine.sync_account(&account, "INBOX").await;
        assert!(primed.success, "priming sync: {:?}", primed.error);
        (dir, state, m, account)
    }

    async fn setup(faults: Vec<Fault>, timing: PushTiming) -> (tempfile::TempDir, Arc<DaemonState>, MockJmap, SyncAccount) {
        setup_with(faults, timing, |_| {}).await
    }

    async fn watch(state: &Arc<DaemonState>, account: &SyncAccount) {
        state.idle.watch(account.clone(), Duration::from_secs(29 * 60)).await;
    }

    /// EventSource GETs the mock received.
    fn streams_opened(m: &MockJmap) -> usize {
        m.requests().iter().filter(|r| r.path.starts_with("/jmap/eventsource")).count()
    }

    async fn status_of(state: &Arc<DaemonState>) -> WatchStatus {
        state.idle.status().await.into_iter().next().expect("one watcher")
    }

    /// The watcher's status once `cond` holds; panics after `timeout_ms`.
    async fn wait_status(
        state: &Arc<DaemonState>,
        cond: impl Fn(&WatchStatus) -> bool,
        timeout_ms: u64,
        what: &str,
    ) -> WatchStatus {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let s = status_of(state).await;
            if cond(&s) {
                return s;
            }
            if std::time::Instant::now() >= deadline {
                panic!("timed out after {timeout_ms}ms waiting for: {what} (status {s:?})");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_until(mut cond: impl FnMut() -> bool, timeout_ms: u64, what: &str) {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        while std::time::Instant::now() < deadline {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out after {timeout_ms}ms waiting for: {what}");
    }

    // ── the brief's list ───────────────────────────────────────────────────

    #[tokio::test]
    async fn state_event_triggers_sync_and_change_record() {
        let (_dir, state, m, account) = setup(vec![], timing()).await;
        watch(&state, &account).await;
        wait_status(&state, |s| s.idling, 5_000, "the stream open and caught up").await;

        let g0 = state.sync_engine.change_gen();
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        let (g, records) = state.sync_engine.wait_changes(g0, 3_000).await;
        assert!(g > g0, "a pushed state change must sync within 3 s");
        assert!(records.iter().any(|r| r.mailbox == "INBOX" && r.new_emails == 1), "{records:?}");
        let s = wait_status(&state, |s| s.wakeups >= 1, 3_000, "the event counted").await;
        assert_eq!(s.mode.as_deref(), Some("stream"));
        // `sync_jmap` publishes the arrival itself: the push loop must not
        // publish it a second time.
        let (_, all) = state.sync_engine.wait_changes(g0, 0).await;
        assert_eq!(all.iter().filter(|r| r.new_emails > 0).count(), 1, "announced once: {all:?}");
        state.idle.shutdown().await;
    }

    #[tokio::test]
    async fn silent_stream_falls_back_to_polling() {
        let timing = PushTiming { dead_after: Duration::from_secs(1), stream_retry_every: Duration::from_secs(4), ..timing() };
        let (_dir, state, m, account) = setup(vec![Fault::DropEventSourceAfter { events: 0 }], timing).await;
        watch(&state, &account).await;

        let s = wait_status(&state, |s| s.mode.as_deref() == Some("polling"), 15_000, "polling after three silent streams").await;
        assert_eq!(streams_opened(&m), 3, "three tries, then polling");
        assert!(!s.idling);
        assert!(s.last_error.as_deref().is_some_and(|e| e.contains("silent")), "{s:?}");

        // Polling: syncs on the timer, and no stream until the retry is due.
        let (changes0, streams0) = (m.count_calls("Email/changes"), streams_opened(&m));
        wait_until(|| m.count_calls("Email/changes") >= changes0 + 2, 2_000, "two polls").await;
        assert_eq!(streams_opened(&m), streams0, "no stream attempt while polling");

        // Every `stream_retry_every` the stream is tried again.
        wait_until(|| streams_opened(&m) > streams0, 6_000, "the stream tried again").await;
        state.idle.shutdown().await;
    }

    #[tokio::test]
    async fn unwatch_stops_the_stream() {
        let (_dir, state, m, account) = setup(vec![], timing()).await;
        watch(&state, &account).await;
        wait_status(&state, |s| s.idling, 5_000, "the stream open").await;

        state.idle.unwatch("acct-1").await;
        assert!(state.idle.status().await.is_empty());
        let before = m.requests().len();
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let after = m.requests();
        assert_eq!(after.len(), before, "an unwatched account sends nothing: {:?}", &after[before..]);
        state.idle.shutdown().await;
    }

    #[tokio::test]
    async fn reconnect_catches_up_changes_made_while_down() {
        // Pings every 30 s: the stream's one event is the first change below,
        // never a ping.
        let timing = PushTiming { ping_secs: 30, dead_after: Duration::from_millis(1_500), ..timing() };
        let (_dir, state, m, account) = setup(vec![Fault::DropEventSourceAfter { events: 1 }], timing).await;
        watch(&state, &account).await;
        wait_status(&state, |s| s.idling, 5_000, "the first stream open").await;

        // The stream's one event: it syncs, then the stream goes silent.
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        wait_status(&state, |s| s.wakeups == 1, 5_000, "the first event synced").await;

        // Down: this change raises no event on the silent stream.
        let g1 = state.sync_engine.change_gen();
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e10", "ten", "2026-10-05T10:00:00Z")));
        let (g, records) = state.sync_engine.wait_changes(g1, 10_000).await;
        assert!(g > g1, "the reconnect must sync what changed while the stream was down");
        assert!(records.iter().any(|r| r.mailbox == "INBOX" && r.new_emails == 1), "{records:?}");
        assert_eq!(streams_opened(&m), 2, "found by the second stream's catch-up");
        assert_eq!(status_of(&state).await.wakeups, 1, "no event carried the second change");
        state.idle.shutdown().await;
    }

    #[tokio::test]
    async fn event_with_unchanged_state_does_not_sync() {
        let (_dir, state, m, account) = setup(vec![], timing()).await;
        watch(&state, &account).await;
        wait_status(&state, |s| s.idling, 5_000, "the stream open and caught up").await;
        let changes0 = m.count_calls("Email/changes");

        // Two pushes of the state the daemon already holds: a `mutate` that
        // changes nothing re-sends the current state.
        m.mutate(|_| {});
        m.mutate(|_| {});
        // A real change behind them. One stream handles its events in order,
        // so once this one has synced, the two before it were handled.
        let g0 = state.sync_engine.change_gen();
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        let (g, _) = state.sync_engine.wait_changes(g0, 5_000).await;
        assert!(g > g0, "the real change synced");
        let s = wait_status(&state, |s| s.wakeups >= 1, 3_000, "the real change counted").await;
        assert_eq!(m.count_calls("Email/changes"), changes0 + 1, "only the real change ran a delta");
        assert_eq!(s.wakeups, 1);
        state.idle.shutdown().await;
    }

    // ── status, polling-only, the pieces ───────────────────────────────────

    #[tokio::test]
    async fn status_reports_a_live_stream() {
        let (_dir, state, m, account) = setup(vec![], timing()).await;
        watch(&state, &account).await;
        let s = wait_status(&state, |s| s.idling, 5_000, "the stream open").await;
        assert_eq!(s.mode.as_deref(), Some("stream"));
        assert_eq!((s.last_error.clone(), s.reason.clone()), (None, None));
        let wire = serde_json::to_value(&s).unwrap();
        assert_eq!(wire["mode"], json!("stream"));
        assert_eq!(wire["accountId"], json!("acct-1"));
        // An IDLE watcher's status keeps its shape: no `mode` key at all.
        let imap = WatchStatus { account_id: "a".into(), idling: true, wakeups: 0, last_error: None, reason: None, mode: None };
        assert!(serde_json::to_value(&imap).unwrap().get("mode").is_none());

        // Pings keep a quiet stream alive past `dead_after`.
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(streams_opened(&m), 1, "a pinging stream is never dropped as dead");
        assert!(status_of(&state).await.idling);
        state.idle.shutdown().await;
    }

    #[tokio::test]
    async fn status_reports_backoff_after_a_silent_stream() {
        // A first wait long enough to look at.
        let timing = PushTiming {
            dead_after: Duration::from_millis(500),
            backoff_base: Duration::from_secs(60),
            backoff_cap: Duration::from_secs(60),
            ..timing()
        };
        let (_dir, state, m, account) = setup(vec![Fault::DropEventSourceAfter { events: 0 }], timing).await;
        watch(&state, &account).await;
        let s = wait_status(&state, |s| s.mode.as_deref() == Some("backoff"), 5_000, "backing off").await;
        assert!(!s.idling);
        assert!(s.last_error.as_deref().is_some_and(|e| e.contains("silent")), "{s:?}");
        assert_eq!(s.reason, None, "still running");
        assert_eq!(streams_opened(&m), 1);
        state.idle.shutdown().await;
    }

    #[tokio::test]
    async fn a_session_without_event_source_only_polls() {
        let (_dir, state, m, account) = setup_with(vec![], timing(), |s| s.advertise_event_source = false).await;
        watch(&state, &account).await;
        let s = wait_status(&state, |s| s.mode.as_deref() == Some("polling"), 5_000, "polling").await;
        assert_eq!(s.last_error, None, "a server without EventSource is not an error");

        let changes0 = m.count_calls("Email/changes");
        wait_until(|| m.count_calls("Email/changes") >= changes0 + 2, 3_000, "two polls").await;
        let g0 = state.sync_engine.change_gen();
        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        let (g, records) = state.sync_engine.wait_changes(g0, 3_000).await;
        assert!(g > g0, "a poll finds the arrival");
        assert!(records.iter().any(|r| r.mailbox == "INBOX" && r.new_emails == 1), "{records:?}");
        assert_eq!(streams_opened(&m), 0, "never asked for a stream");
        state.idle.shutdown().await;
    }

    #[tokio::test]
    async fn a_stream_that_greets_and_hangs_up_falls_back_to_polling() {
        // Every attempt: one state event, then EOF, well inside `dead_after`.
        // The event must not reset the failure count (R11).
        let timing = PushTiming { dead_after: Duration::from_secs(3), stream_retry_every: Duration::from_secs(60), ..timing() };
        let (_dir, state, m, account) = setup(vec![Fault::HangUpEventSourceAfterOneEvent], timing).await;
        watch(&state, &account).await;

        let s = wait_status(&state, |s| s.mode.as_deref() == Some("polling"), 10_000, "polling after three hang-ups").await;
        assert_eq!(streams_opened(&m), 3, "three tries, then polling");
        assert!(s.last_error.as_deref().is_some_and(|e| e.contains("closed")), "{s:?}");

        // Polling syncs on the timer and opens no stream.
        let (changes0, streams0) = (m.count_calls("Email/changes"), streams_opened(&m));
        wait_until(|| m.count_calls("Email/changes") >= changes0 + 2, 3_000, "two polls").await;
        assert_eq!(streams_opened(&m), streams0, "no stream attempt while polling");
        state.idle.shutdown().await;
    }

    #[test]
    fn sse_parser_caps_a_pending_event() {
        let mut p = SseParser::default();
        let line = format!("data: {}\n", "x".repeat(1000));
        let mut got = Vec::new();
        for _ in 0..(MAX_LINE / 1000 + 10) {
            got.extend(p.feed(line.as_bytes()));
        }
        assert!(got.is_empty());
        assert!(p.data.is_empty(), "the oversized event was dropped");
        assert!(p.data_bytes <= MAX_LINE + 1000);
        // Its blank line ends it without emitting; the next event is fine.
        assert!(p.feed(b"\n").is_empty());
        let got = p.feed(b"event: state\ndata: {}\n\n");
        assert_eq!(got, vec![SseEvent { kind: "state".into(), data: "{}".into() }]);
    }

    #[test]
    fn sse_parser_reassembles_events_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.feed(b"event: st").is_empty());
        assert!(p.feed(b"ate\r\ndata: {\"a\":").is_empty());
        let got = p.feed(b"1}\r\n\r\n: a comment\n\nevent: ping\ndata: {}\n\ndata: x\ndata: y\n\n");
        assert_eq!(
            got,
            vec![
                SseEvent { kind: "state".into(), data: "{\"a\":1}".into() },
                SseEvent { kind: "ping".into(), data: "{}".into() },
                SseEvent { kind: "message".into(), data: "x\ny".into() },
            ]
        );
        assert!(p.feed(b"event: state\ndata: half").is_empty(), "no blank line yet");
    }

    #[test]
    fn production_timing_is_the_briefs() {
        let t = PushTiming::PRODUCTION;
        assert_eq!(t.ping_secs, 30);
        assert_eq!(t.dead_after, Duration::from_secs(65), "2 x ping + 5 s");
        assert_eq!(t.open_timeout, Duration::from_secs(65));
        assert_eq!(dead_after(1), Duration::from_secs(7));
        let waits: Vec<u64> = (1..=10).map(|n| t.backoff(n).as_secs()).collect();
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 32, 64, 128, 256, 300]);
        assert_eq!(t.backoff(40), Duration::from_secs(300));
        assert_eq!(t.failures_before_poll, 3);
        assert_eq!(t.poll_every, Duration::from_secs(120));
        assert_eq!(t.stream_retry_every, Duration::from_secs(600));
    }

    /// A pushed inbox arrival has its body kept, as an IDLE arrival's is
    /// (`cache_arrivals`, by blob download; Task 9c), and no IMAP is dialled.
    #[tokio::test]
    async fn jmap_a_pushed_arrival_body_is_kept_in_the_vault() {
        let (trap, port) = crate::jmap_test_support::imap_trap();
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        state.idle.set_push_timing(timing());
        let m = MockJmap::start(scenario(vec![]));
        let mut account = account_for(&m);
        // The trap is part of the exact native origin: configure it before
        // priming, rather than requesting an unproved identity takeover later.
        account.imap_config.port = Some(port);
        let primed = state.sync_engine.sync_account(&account, "INBOX").await;
        assert!(primed.success, "priming sync: {:?}", primed.error);
        let owner = crate::custody::with_conn(&state, |conn| {
            mailvault_core::custody::cache::native_identity(conn, &account.id, "INBOX")
        }).unwrap().unwrap();
        assert_eq!(owner, mailvault_core::imap::NativeHeaderIdentity::new(
            &account.imap_config, &account.id, "INBOX", Some(1),
        ).with_jmap_mailbox("mb-inbox"));
        std::fs::write(
            dir.path().join("frontend-settings.json"),
            json!({"mailvault-settings": {"state": {"fetchMode": "hoarder"}}}).to_string(),
        )
        .unwrap();
        watch(&state, &account).await;
        wait_status(&state, |s| s.idling, 5_000, "the stream open and caught up").await;

        m.mutate(|s| s.add_email("acc1", "mb-inbox", email("e9", "nine", "2026-10-04T10:00:00Z")));
        let cur = mailvault_core::vault_files::cur_path(dir.path(), "acct-1", "INBOX");
        let kept = || {
            std::fs::read_dir(&cur)
                .map(|d| d.flatten().any(|e| std::fs::read(e.path()).is_ok_and(|b| String::from_utf8_lossy(&b).contains("body of nine"))))
                .unwrap_or(false)
        };
        wait_until(kept, 5_000, "the arrival's body in the vault").await;
        assert_eq!(m.requests().iter().filter(|r| r.path.starts_with("/jmap/download/")).count(), 1, "the arrival only");
        assert!(trap.accept().is_err(), "no IMAP dial");
    }
}
