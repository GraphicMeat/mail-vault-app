//! Background worker for Scheduled Send. Modeled on
//! `classification_worker.rs`'s shape (`Arc<DaemonState>` + a `Notify` +
//! its own task), but the state it owns is small enough to live inline here
//! rather than needing its own `ClassificationState`-sized struct.
//!
//! On start it runs a catch-up pass over everything already due — the daemon
//! dying with the app in on-demand mode is the NORMAL case here, so "already
//! past" is never refused, only sent. It then sleeps until the next
//! `fire_at` or until `handlers::scheduled` wakes it (create/update/cancel).
//!
//! `attempt_row` is the one place a row is actually sent — both this worker's
//! loop and `scheduled.send_now` call it, so "fire now" can never drift from
//! what the periodic pass does.

use crate::server::DaemonState;
use mailvault_core::app_db::{self, scheduled};
use mailvault_core::imap::ImapConfig;
use mailvault_core::smtp::{self, FrozenEnvelope};
use mailvault_core::vault_files;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

/// Registered on `DaemonState` so `handlers::scheduled`'s RPCs can wake the
/// loop the moment a row is created, rescheduled or cancelled rather than
/// waiting out its own sleep.
#[derive(Default)]
pub struct ScheduledSendState {
    pub notify: tokio::sync::Notify,
    /// Rows this process is dialling out for right now. `scheduled.send_now`
    /// deliberately skips the `fire_at` gate, so a click that lands in the
    /// same tick the row becomes due would otherwise hand the same frozen
    /// message to two senders -- the recipient gets it twice, and no status
    /// in the database can say so afterwards.
    in_flight: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl ScheduledSendState {
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    /// `Some(guard)` when this call is the one that gets to send `id`, and
    /// `None` when another already holds it. The guard releases on drop, so a
    /// panic in the send path cannot strand the row. `scheduled.update` takes
    /// the same claim while it replaces a row's message, so an edit and a send
    /// can never overlap.
    pub(crate) fn claim(&self, id: &str) -> Option<InFlight<'_>> {
        let mut held = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        held.insert(id.to_string()).then(|| InFlight { state: self, id: id.to_string() })
    }
}

pub(crate) struct InFlight<'a> {
    state: &'a ScheduledSendState,
    id: String,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut held = self.state.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        held.remove(&self.id);
    }
}

/// How often the loop re-checks while `NetGate` says offline. `NetGate` has
/// no "back online" push to subscribe to (only `is_online()`/
/// `confirm_online()`), so this is a plain poll.
// ponytail: fixed poll, not a subscription — add one if scheduled sends ever
// need to fire the instant connectivity returns rather than within 30s of it.
const OFFLINE_POLL: Duration = Duration::from_secs(30);
/// Upper bound on the sleep even with nothing due — a safety net against a
/// corrupt or far-future `fire_at` parking the worker for good.
const MAX_SLEEP: Duration = Duration::from_secs(3600);
/// Floor on the sleep for a tick that actually processed rows. Without it, a
/// row `attempt_row` failed to move off `due()` (a `set_status`/`push_fire_at`
/// write that itself errored — disk full, lock contention) would still be
/// `due` next tick, `next_wait` would answer `Duration::ZERO` again, and the
/// loop would spin hot instead of retrying at a sane pace.
const MIN_RETRY_WAIT: Duration = Duration::from_secs(1);
/// How often due rows are tried again while the keychain gate is blocked.
/// `keychain.retry` wakes the loop the moment the user unlocks, so this is
/// only the fallback for an unlock that happened some other way.
const KEYCHAIN_POLL: Duration = Duration::from_secs(5 * 60);

/// Exponential backoff between transient-failure retries: 30s, 60s for
/// `attempt` 1 and 2 (`attempt` 3 goes `failed` instead — see `attempt_row`).
/// Without this, a due row that fails for a reason `NetGate` does not
/// recognize as offline (a provider momentarily refusing, say) would be
/// picked straight back up on the worker's very next tick and hammer the
/// server instead of waiting.
fn backoff_ms(attempt: i64) -> i64 {
    30_000 * 2i64.pow((attempt.max(1) - 1) as u32)
}

/// When the daemon came up. A credential read that fails inside
/// `CREDENTIAL_GRACE` of that moment is treated as transient rather than
/// terminal: with always-on enabled, launchd starts the daemon at login, and
/// the login keychain is unlocked by login too — a read landing on the wrong
/// side of that race would otherwise kill every send due around boot, which
/// is exactly the window the catch-up pass always hits. Costing a dead
/// credential one extra retry is the cheaper mistake.
static STARTED_AT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
const CREDENTIAL_GRACE: Duration = Duration::from_secs(120);

fn within_credential_grace() -> bool {
    STARTED_AT.get().is_some_and(|t| t.elapsed() < CREDENTIAL_GRACE)
}

pub(crate) fn start(state: Arc<DaemonState>) {
    let _ = STARTED_AT.set(std::time::Instant::now());
    tokio::spawn(async move { run(state).await });
}

async fn run(state: Arc<DaemonState>) {
    info!("[scheduled-send] worker started");
    loop {
        let online = state.net.is_online();
        let processed = if online { process_due(&state).await } else { 0 };
        let wait = if online {
            let next = next_wait(&state).await;
            // A tick that processed rows but still has something immediately
            // due again means a row did not actually move off `due()` — floor
            // the sleep so that retries at a pace, rather than spinning.
            if processed > 0 { next.max(MIN_RETRY_WAIT) } else { next }
        } else {
            OFFLINE_POLL
        };
        let wait = if crate::credentials::GATE.is_blocked() { wait.max(KEYCHAIN_POLL) } else { wait };
        tokio::select! {
            _ = state.scheduled_send.notify.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

async fn next_wait(state: &Arc<DaemonState>) -> Duration {
    let next = app_db::with(&state.app_dir, |c| scheduled::next_fire_at(c)).ok().flatten();
    match next {
        Some(fire_at) => {
            let now = now_ms();
            if fire_at <= now {
                Duration::ZERO
            } else {
                Duration::from_millis((fire_at - now) as u64).min(MAX_SLEEP)
            }
        }
        None => MAX_SLEEP,
    }
}

/// Returns how many rows this pass attempted, so `run` can floor its next
/// sleep instead of spinning if one of them didn't actually move off `due()`.
async fn process_due(state: &Arc<DaemonState>) -> usize {
    let now = now_ms();
    let due = match app_db::with(&state.app_dir, |c| scheduled::due(c, now)) {
        Ok(v) => v,
        Err(e) => {
            warn!("[scheduled-send] could not read due rows: {e}");
            return 0;
        }
    };
    let count = due.len();
    for row in due {
        attempt_row(&state, &row).await;
    }
    count
}

/// What `envelope` deserializes into: `smtp::FrozenEnvelope`'s four fields,
/// flattened, plus the one extra piece this worker needs that a frozen
/// envelope has no reason to carry on its own — where to file the Sent-folder
/// copy. `scheduled.create` (`handlers/scheduled.rs`) is the only writer.
#[derive(Debug, Clone, serde::Deserialize)]
struct StoredEnvelope {
    #[serde(flatten)]
    envelope: FrozenEnvelope,
    #[serde(default, rename = "sentMailbox")]
    sent_mailbox: Option<String>,
}

enum Outcome {
    Sent,
    /// Genuinely offline per `NetGate`, or the keychain gate is blocked —
    /// never counted against the row and never terminal, whatever `attempts`
    /// already says.
    Offline(String),
    /// Worth trying again — the ladder in `attempt_row` below decides whether
    /// `MAX_ATTEMPTS` has run out.
    Transient(String),
    /// Nothing a retry can fix.
    Terminal(String),
}

/// Run one due row through to a terminal state or back to `queued`. Public to
/// the crate: `handlers::scheduled`'s `scheduled.send_now` calls this
/// directly (skipping `due()`'s `fire_at` gate, never its retry/idempotency
/// gate) so "fire now" is the same send path, not a second one.
pub(crate) async fn attempt_row(state: &Arc<DaemonState>, snapshot: &scheduled::ScheduledSend) {
    let app_dir = state.app_dir.clone();
    let id = snapshot.id.clone();
    let Some(_in_flight) = state.scheduled_send.claim(&id) else {
        info!("[scheduled-send] {id} is already being sent; not sending it twice");
        return;
    };
    // The row as it is now, read under the claim. `snapshot` came from a
    // `due()` batch read before the rows ahead of it spent seconds each on
    // SMTP; a cancel, an edit or a reschedule that landed meanwhile has to
    // win, not be overwritten by `sending` and sent from a stale envelope.
    let row = match app_db::with(&app_dir, |c| scheduled::get(c, &id)) {
        Ok(Some(row)) => row,
        Ok(None) => return,
        Err(e) => {
            warn!("[scheduled-send] could not re-read {id} before sending: {e}");
            return;
        }
    };
    if !matches!(row.status.as_str(), "queued" | "sending" | "failed") {
        return;
    }
    // Moved later since the batch was read: not due any more. (`send_now`
    // hands in a fresh read, so its own `fire_at` never differs.)
    if row.fire_at != snapshot.fire_at && row.fire_at > now_ms() {
        return;
    }
    let row = &row;
    let gate = app_db::with(&app_dir, |c| {
        scheduled::set_status(c, &id, "sending", "")?;
        scheduled::attempt_before_send(c, &id)
    });
    let attempt = match gate {
        Ok(scheduled::AttemptOutcome::Send { attempt }) => attempt,
        Ok(scheduled::AttemptOutcome::CeilingExceeded) => {
            emit(state, &id, "failed");
            return;
        }
        Err(e) => {
            warn!("[scheduled-send] could not gate {id}: {e}");
            return;
        }
    };

    let (status, error) = match send_one(state, row).await {
        Outcome::Sent => {
            // The delete can list the mailbox under its lock: off the runtime.
            let (st, account_id, mailbox, uid) = (Arc::clone(state), row.account_id.clone(), row.mailbox.clone(), row.uid);
            let removed = crate::handlers::common::blocking(move || {
                crate::handlers::common::with_mailbox_write(&st, &account_id, &mailbox, |root| {
                    vault_files::delete(&st.vault_registry, root, &account_id, &mailbox, uid)
                })
            });
            if let Err(e) = removed.await.and_then(|r| r) {
                warn!("[scheduled-send] sent {id} but could not remove the frozen draft: {e}");
            }
            ("sent", String::new())
        }
        // Offline overrides the ceiling: a row must never go `failed` just
        // because the network happened to be down `MAX_ATTEMPTS` times. No
        // backoff either — `run`'s own offline poll already paces retries.
        // `attempt_before_send` above already bumped `attempts` for this try
        // before we knew it would turn out offline, so that bump is undone
        // here — otherwise three offline firings would burn the ladder and
        // the fourth would mark a message that was never sent `failed`.
        Outcome::Offline(msg) => {
            if let Err(e) = app_db::with(&app_dir, |c| scheduled::release_attempt(c, &id)) {
                warn!("[scheduled-send] could not release the attempt for {id} after an offline outcome: {e}");
            }
            ("queued", msg)
        }
        Outcome::Transient(msg) => {
            if attempt >= scheduled::MAX_ATTEMPTS {
                ("failed", msg)
            } else {
                // Push fire_at forward so the very next tick does not
                // immediately re-fire this row into the same failure.
                let requeue_at = now_ms() + backoff_ms(attempt);
                if let Err(e) = app_db::with(&app_dir, |c| scheduled::push_fire_at(c, &id, requeue_at)) {
                    warn!("[scheduled-send] could not back off {id}: {e}");
                }
                ("queued", msg)
            }
        }
        Outcome::Terminal(msg) => ("failed", msg),
    };
    if let Err(e) = app_db::with(&app_dir, |c| scheduled::set_status(c, &id, status, &error)) {
        warn!("[scheduled-send] could not record '{status}' for {id}: {e}");
    }
    emit(state, &id, status);
}

fn emit(state: &Arc<DaemonState>, id: &str, status: &str) {
    state.events.emit("scheduled-send", json!({"id": id, "status": status}));
}

/// `smtp::friendly_smtp_error`'s own wording for the two failures a retry can
/// never fix: a rejected login, and a sender this account is not allowed to
/// send as. Everything else it produces (a timeout, a host that refuses for a
/// moment, an SMTP hostname that won't resolve) gets the retry ladder.
fn is_terminal_smtp_error(msg: &str) -> bool {
    msg.contains("Authentication failed for") || msg.contains("refused to send as")
}

/// The keychain read, off the async worker and under a clock.
///
/// Two reasons, and only the second is about launchd. `keyring`'s read is
/// blocking, so calling it inline parks a runtime thread. And a keychain item
/// whose ACL decides to prompt blocks until somebody answers the dialog — at
/// login that is nobody, for as long as the machine is unattended. Without a
/// timeout that is not a failure the ladder can classify; it is a worker that
/// never comes back and takes the rest of the queue with it.
async fn resolve_credentials(account_id: &str) -> Result<ImapConfig, String> {
    crate::credentials::resolve_account_credentials_guarded(account_id).await
}

async fn send_one(state: &Arc<DaemonState>, row: &scheduled::ScheduledSend) -> Outcome {
    // Resolved fresh at fire time, not carried in the row: credentials
    // (an OAuth2 token especially) can rotate between scheduling and firing,
    // and this is the exact seam `sync.now`/`sync.watch` already use to keep
    // a background job off whatever a stale RPC payload said.
    let account = match resolve_credentials(&row.account_id).await {
        Ok(a) => a,
        Err(e) => {
            let msg = format!("Could not load this account's credentials: {e}");
            // Waiting on the user to unlock the keychain is not a failure of
            // this row: like offline, it stays queued and keeps its tries.
            if crate::credentials::GATE.is_blocked() {
                return Outcome::Offline(msg);
            }
            return if within_credential_grace() { Outcome::Transient(msg) } else { Outcome::Terminal(msg) };
        }
    };

    let stored: StoredEnvelope = match serde_json::from_str(&row.envelope) {
        Ok(v) => v,
        Err(e) => return Outcome::Terminal(format!("The scheduled message's envelope is corrupt: {e}")),
    };

    let root = match crate::handlers::common::vault_root(state) {
        // The vault being unreachable (an external drive unplugged) is not a
        // network problem and not unfixable — it is worth another try later.
        Err(e) => return Outcome::Transient(e),
        Ok(r) => r,
    };
    // Resolving can list the mailbox and reads SQLite: off the runtime.
    let (read_state, account_id, mailbox, uid) = (Arc::clone(state), row.account_id.clone(), row.mailbox.clone(), row.uid);
    let read = crate::handlers::common::blocking(move || {
        vault_files::read_eml(&read_state.vault_registry, &root, &account_id, &mailbox, uid)
    });
    let raw = match read.await.and_then(|r| r) {
        Ok(b) => b,
        Err(e) => return Outcome::Terminal(format!("The scheduled message could not be found: {e}")),
    };

    match smtp::send_raw(&account, &stored.envelope, raw).await {
        Ok(result) => {
            append_to_sent(state, &account, &row.account_id, stored.sent_mailbox, &result);
            Outcome::Sent
        }
        Err(e) => {
            // Same idiom `sync_engine::sync_account` uses: a success is proof
            // of reach, a connect-shaped failure only asks — `note_failure`
            // probes and the probe decides, so one provider's SMTP outage
            // never gates every other account's scheduled sends.
            let online_after = state.net.note_failure(&e).await;
            if !online_after {
                Outcome::Offline(e)
            } else if is_terminal_smtp_error(&e) {
                Outcome::Terminal(e)
            } else {
                Outcome::Transient(e)
            }
        }
    }
}

/// Best-effort Sent-folder append, mirroring `handlers::smtp::smtp_send_email`'s
/// background branch: dedicated no-compress session (never the pool — the
/// Hostinger APPEND hang `smtp.rs` documents), same completion event name so
/// nothing in the frontend needs to learn a second one. Never gates the row's
/// own `sent` status — that already landed before this is spawned.
fn append_to_sent(
    state: &Arc<DaemonState>,
    account: &ImapConfig,
    account_id: &str,
    sent_mailbox: Option<String>,
    result: &smtp::SendResult,
) {
    let Some(mailbox) = sent_mailbox.filter(|m| !m.is_empty()) else { return };
    let raw_bytes = result.raw_rfc2822.clone();
    let account = account.clone();
    let state = Arc::clone(state);
    let account_id = account_id.to_string();
    let message_id = result.message_id.clone();
    tokio::spawn(async move {
        let mailbox_for_closure = mailbox.clone();
        let verified: Result<Result<(u32, u32, Option<u32>), String>, _> = tokio::time::timeout(
            Duration::from_secs(60),
            async {
                let mut session = crate::imap::create_imap_session_no_compress(&account)
                    .await
                    .map_err(|e| format!("dedicated session create failed: {e}"))?;
                let res = crate::imap::append_email_verified(&mut session, &mailbox_for_closure, &raw_bytes, "\\Seen", None, None).await;
                let _ = session.logout().await;
                res
            },
        )
        .await;
        let (ok, verify_payload) = match verified {
            Ok(Ok((before, after, found_uid))) => {
                (true, json!({"existsBefore": before, "existsAfter": after, "foundUid": found_uid}))
            }
            Ok(Err(e)) => (false, json!({"error": e})),
            Err(_) => (false, json!({"error": "timeout"})),
        };
        state.events.emit(
            "send-server-append-complete",
            json!({"accountId": account_id, "mailbox": mailbox, "messageId": message_id, "ok": ok, "verify": verify_payload}),
        );
    });
}
