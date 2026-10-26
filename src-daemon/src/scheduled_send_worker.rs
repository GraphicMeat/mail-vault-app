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

use crate::account_lifecycle::{AccountStamp, OperationPermit};
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
/// The keychain watcher and `keychain.retry` wake the loop the moment the
/// gate clears; this only keeps due rows from being retried every second
/// while it stays blocked.
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
pub(crate) async fn process_due(state: &Arc<DaemonState>) -> usize {
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
    /// The follow-up reminder asked for at schedule time, in days; 0 is none.
    #[serde(default, rename = "remindDays")]
    remind_days: i64,
    /// The addresses the message is the user's under, for that reminder.
    #[serde(default, rename = "ownAddresses")]
    own_addresses: Vec<String>,
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
    if let Err(e) = attempt_row_with(state, snapshot, None, false).await {
        warn!("[scheduled-send] could not admit {}: {e}", snapshot.id);
    }
}

/// An explicit retry carries the stamp captured before its row lookup and
/// resets attempts only after the same attempt owns the account.
pub(crate) async fn attempt_row_explicit(state: &Arc<DaemonState>, snapshot: &scheduled::ScheduledSend, original: AccountStamp) -> Result<(), String> {
    attempt_row_with(state, snapshot, Some(original), true).await
}

async fn attempt_row_with(state: &Arc<DaemonState>, snapshot: &scheduled::ScheduledSend, original: Option<AccountStamp>, reset_failed: bool) -> Result<(), String> {
    let app_dir = state.app_dir.clone();
    let id = snapshot.id.clone();
    let Some(_in_flight) = state.scheduled_send.claim(&id) else {
        info!("[scheduled-send] {id} is already being sent; not sending it twice");
        return Ok(());
    };
    // The row as it is now, read under the claim. `snapshot` came from a
    // `due()` batch read before the rows ahead of it spent seconds each on
    // SMTP; a cancel, an edit or a reschedule that landed meanwhile has to
    // win, not be overwritten by `sending` and sent from a stale envelope.
    let row = match app_db::with(&app_dir, |c| scheduled::get(c, &id)) {
        Ok(Some(row)) => row,
        Ok(None) => return Ok(()),
        Err(e) => {
            warn!("[scheduled-send] could not re-read {id} before sending: {e}");
            return Ok(());
        }
    };
    if !matches!(row.status.as_str(), "queued" | "sending" | "failed")
        || (reset_failed && !matches!(row.status.as_str(), "queued" | "failed")) {
        return Ok(());
    }
    // Moved later since the batch was read: not due any more. (`send_now`
    // hands in a fresh read, so its own `fire_at` never differs.)
    if row.fire_at != snapshot.fire_at && row.fire_at > now_ms() {
        return Ok(());
    }
    let row = &row;
    let original = match original {
        Some(stamp) if stamp.id() == row.account_id => stamp,
        Some(_) => return Err("errors.keychainBusy".to_owned()),
        None => state.account_lifecycle.capture(&row.account_id).map_err(|_| "errors.keychainBusy".to_owned())?,
    };
    // Credential/keychain and OAuth preparation can prompt or wait. Only the
    // revocable original stamp crosses this seam; no semantic owner does.
    let prepared = prepare_send(state, row).await;
    let operation = state.account_lifecycle.try_operation(std::slice::from_ref(&original))
        .map_err(|_| "errors.keychainBusy".to_owned())?;
    if reset_failed {
        let (reset_app, reset_id, reset_owner) = (app_dir.clone(), id.clone(), operation.clone());
        crate::handlers::common::blocking(move || {
            let _reset_owner = reset_owner;
            app_db::with(&reset_app, |c| scheduled::reset_failed_attempts(c, &reset_id))
        }).await.and_then(|r| r)?;
    }
    let gate = app_db::with(&app_dir, |c| {
        scheduled::set_status(c, &id, "sending", "")?;
        scheduled::attempt_before_send(c, &id)
    });
    let attempt = match gate {
        Ok(scheduled::AttemptOutcome::Send { attempt }) => attempt,
        Ok(scheduled::AttemptOutcome::CeilingExceeded) => {
            emit(state, &id, "failed");
            return Ok(());
        }
        Err(e) => {
            warn!("[scheduled-send] could not gate {id}: {e}");
            return Ok(());
        }
    };

    let outcome = match prepared {
        Ok((account, stored)) => send_one(state, row, account, stored, operation.clone()).await,
        Err(outcome) => outcome,
    };
    #[cfg(test)]
    let _terminal_done = terminal_pause(&app_dir, &id).await;
    let (status, error) = match outcome {
        Outcome::Sent => {
            // The delete can list the mailbox under its lock: off the runtime.
            let (st, account_id, mailbox, uid) = (Arc::clone(state), row.account_id.clone(), row.mailbox.clone(), row.uid);
            let (child_owner, child_stamp) = (operation.clone(), original.clone());
            let removed = crate::handlers::common::blocking(move || {
                let _child_owner = child_owner;
                let _local = st.account_lifecycle.try_commit(&[child_stamp]).map_err(|_| "errors.keychainBusy".to_owned())?;
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
    Ok(())
}

#[cfg(test)]
struct TerminalGate {
    entered: std::sync::mpsc::Sender<()>,
    release: tokio::sync::oneshot::Receiver<()>,
    done: std::sync::mpsc::Sender<()>,
}
#[cfg(test)]
fn terminal_gates() -> &'static std::sync::Mutex<std::collections::BTreeMap<(std::path::PathBuf, String), TerminalGate>> {
    static GATES: std::sync::OnceLock<std::sync::Mutex<std::collections::BTreeMap<(std::path::PathBuf, String), TerminalGate>>> = std::sync::OnceLock::new();
    GATES.get_or_init(Default::default)
}
#[cfg(test)]
async fn terminal_pause(path: &std::path::Path, id: &str) -> Option<crate::credentials::TestTaskDone> {
    let gate = terminal_gates().lock().unwrap().remove(&(path.to_path_buf(), id.to_owned()));
    if let Some(gate) = gate {
        let _ = gate.entered.send(());
        let _ = gate.release.await;
        Some(crate::credentials::TestTaskDone(gate.done))
    } else { None }
}
#[cfg(test)]
pub(crate) struct TerminalPause {
    release: Option<tokio::sync::oneshot::Sender<()>>,
    entered: std::sync::mpsc::Receiver<()>,
    done: Option<std::sync::mpsc::Receiver<()>>,
}
#[cfg(test)]
impl TerminalPause {
    pub(crate) fn arm(state: &Arc<DaemonState>, id: &str) -> Self {
        let (release, gate) = tokio::sync::oneshot::channel();
        let (entered, notice) = std::sync::mpsc::channel();
        let (done, finished) = std::sync::mpsc::channel();
        terminal_gates().lock().unwrap().insert((state.app_dir.clone(), id.to_owned()), TerminalGate { entered, release: gate, done });
        Self { release: Some(release), entered: notice, done: Some(finished) }
    }
    pub(crate) fn entered(&self) { self.entered.recv_timeout(Duration::from_secs(5)).expect("actual terminal transport completed"); }
    pub(crate) fn finish(&mut self) {
        let _ = self.release.take().unwrap().send(());
        self.done.take().unwrap().recv_timeout(Duration::from_secs(5)).expect("terminal bookkeeping and child completed");
    }
}
#[cfg(test)]
impl Drop for TerminalPause {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() { let _ = release.send(()); }
        if let Some(done) = self.done.take() {
            if done.recv_timeout(Duration::from_secs(5)).is_err() { std::process::abort(); }
        }
    }
}

fn emit(state: &Arc<DaemonState>, id: &str, status: &str) {
    state.events.emit("scheduled-send", json!({"id": id, "status": status}));
}

/// The failures no retry may follow, as `smtp` words them: a rejected login
/// (SMTP, or a Graph sign-in Microsoft will not take, or an expired token that
/// could not be renewed), a sender this account is not allowed to send as, a
/// message over Graph's size limit, and a Graph send that may already have
/// gone out. Everything else (an SMTP timeout, a throttle, a host that refuses
/// for a moment, an SMTP hostname that won't resolve) gets the retry ladder.
fn is_terminal_smtp_error(msg: &str) -> bool {
    smtp::is_terminal_send_error(msg)
}

/// The keychain read, off the async worker and under a clock.
///
/// Two reasons, and only the second is about launchd. `keyring`'s read is
/// blocking, so calling it inline parks a runtime thread. And a keychain item
/// whose ACL decides to prompt blocks until somebody answers the dialog — at
/// login that is nobody, for as long as the machine is unattended. Without a
/// timeout that is not a failure the ladder can classify; it is a worker that
/// never comes back and takes the rest of the queue with it.
///
/// The stored record comes back too: `with_fresh_token` reads its OAuth2
/// fields.
async fn resolve_credentials(
    account_id: &str,
) -> Result<(ImapConfig, crate::credentials::RecordSnapshot), String> {
    crate::credentials::resolve_account_with_record_guarded(account_id).await
}

/// The account with an OAuth2 token good for the send, from the daemon's one
/// token source (`oauth_tokens`): the keychain holds whatever token the app
/// last stored, and a row due after a night with the app closed found one
/// that expired hours ago. Refreshed with the record's own provider, client
/// and scopes; no expiry on record means no refresh, as in the app.
///
/// A refresh that fails while the stored token is still valid leaves the
/// stored one, so a send that worked before this refresh existed still works.
/// Once it has expired there is nothing to send with, and `Err` says why: a
/// refusal (the provider said no, or a client this build cannot pair) asks
/// for a new sign-in (`smtp::SIGN_IN_AGAIN`, which ends the row); no usable
/// answer at all goes to the network probe: offline waits for the network,
/// online takes the retry ladder.
async fn with_fresh_token(
    state: &Arc<DaemonState>,
    account_id: &str,
    account: ImapConfig,
    record: &crate::credentials::RecordSnapshot,
) -> Result<ImapConfig, String> {
    let email = account.email.clone();
    match crate::oauth_tokens::fresh_config(state, account_id, account, record).await {
        Ok(account) => Ok(account),
        Err(e) if e.kind == crate::oauth_tokens::FailKind::Refused => Err(format!(
            "The sign-in for {} has expired and could not be renewed. {}",
            email,
            smtp::SIGN_IN_AGAIN
        )),
        Err(e) => Err(format!(
            "Could not renew the sign-in for {}: {}",
            email, e.message
        )),
    }
}

async fn prepare_send(state: &Arc<DaemonState>, row: &scheduled::ScheduledSend) -> Result<(ImapConfig, StoredEnvelope), Outcome> {
    // Resolved fresh at fire time, not carried in the row: credentials
    // (an OAuth2 token especially) can rotate between scheduling and firing,
    // and this is the exact seam `sync.now`/`sync.watch` already use to keep
    // a background job off whatever a stale RPC payload said.
    let (account, record) = match resolve_credentials(&row.account_id).await {
        Ok(found) => found,
        Err(e) => {
            let msg = format!("Could not load this account's credentials: {e}");
            // Waiting on the user to unlock the keychain is not a failure of
            // this row: like offline, it stays queued and keeps its tries.
            if crate::credentials::GATE.is_blocked() {
                return Err(Outcome::Offline(msg));
            }
            return Err(if within_credential_grace() { Outcome::Transient(msg) } else { Outcome::Terminal(msg) });
        }
    };
    let account = match with_fresh_token(state, &row.account_id, account, &record).await {
        Ok(a) => a,
        Err(e) if is_terminal_smtp_error(&e) => return Err(Outcome::Terminal(e)),
        // A renewal that got no answer always asks the probe, not
        // `note_failure`, whose needles only guess from the wording: the
        // cause can be in the system's language (Windows) or missing. An
        // expired token at wake, before the Wi-Fi joins, otherwise read as
        // online and spent the row's tries in 90 seconds.
        Err(e) => return Err(if state.net.confirm_online().await { Outcome::Transient(e) } else { Outcome::Offline(e) }),
    };

    let stored: StoredEnvelope = match serde_json::from_str(&row.envelope) {
        Ok(v) => v,
        Err(e) => return Err(Outcome::Terminal(format!("The scheduled message's envelope is corrupt: {e}"))),
    };
    Ok((account, stored))
}

async fn send_one(state: &Arc<DaemonState>, row: &scheduled::ScheduledSend, account: ImapConfig, stored: StoredEnvelope, operation: OperationPermit) -> Outcome {
    let root = match crate::handlers::common::vault_root(state) {
        // The vault being unreachable (an external drive unplugged) is not a
        // network problem and not unfixable — it is worth another try later.
        Err(e) => return Outcome::Transient(e),
        Ok(r) => r,
    };
    // Resolving can list the mailbox and reads SQLite: off the runtime.
    let (read_state, account_id, mailbox, uid) = (Arc::clone(state), row.account_id.clone(), row.mailbox.clone(), row.uid);
    let read_owner = operation.clone();
    let read = crate::handlers::common::blocking(move || {
        let _read_owner = read_owner;
        vault_files::read_eml(&read_state.vault_registry, &root, &account_id, &mailbox, uid)
    });
    let raw = match read.await.and_then(|r| r) {
        Ok(b) => b,
        Err(e) => return Outcome::Terminal(format!("The scheduled message could not be found: {e}")),
    };

    match smtp::send_raw(&account, &stored.envelope, raw).await {
        Ok(result) => {
            // Graph accounts get no reminder: the daemon has no token to
            // check for a reply with, and the app does not offer one there.
            if !account.uses_graph() {
                let recipients = stored.envelope.to.clone();
                let mut own = stored.own_addresses.clone();
                if !own.iter().any(|a| a.eq_ignore_ascii_case(&stored.envelope.from)) {
                    own.push(stored.envelope.from.clone());
                }
                crate::follow_up_worker::record_after_send(
                    state,
                    &row.account_id,
                    &result.raw_rfc2822,
                    &recipients,
                    stored.sent_mailbox.as_deref(),
                    &own,
                    stored.remind_days,
                );
            }
            append_to_sent(state, &account, &row.account_id, stored.sent_mailbox, &result, operation.clone());
            Outcome::Sent
        }
        // Ahead of the network probe: a Graph send that may have gone out
        // must end the row even when the network then looks down, because
        // the offline requeue would send it a second time.
        Err(e) if is_terminal_smtp_error(&e) => Outcome::Terminal(e),
        Err(e) => {
            // Same idiom `sync_engine::sync_account` uses: a success is proof
            // of reach, a connect-shaped failure only asks — `note_failure`
            // probes and the probe decides, so one provider's SMTP outage
            // never gates every other account's scheduled sends.
            if state.net.note_failure(&e).await {
                Outcome::Transient(e)
            } else {
                Outcome::Offline(e)
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
    operation: OperationPermit,
) {
    // Microsoft Graph filed its own Sent copy, and a Graph account has no
    // IMAP. (Nothing local was staged for a scheduled send, so there is no
    // completion event to send either.)
    if result.server_saved_sent {
        return;
    }
    let Some(mailbox) = sent_mailbox.filter(|m| !m.is_empty()) else { return };
    let raw_bytes = result.raw_rfc2822.clone();
    let account = account.clone();
    let state = Arc::clone(state);
    let account_id = account_id.to_string();
    let message_id = result.message_id.clone();
    tokio::spawn(async move {
        let _actual_owner = operation;
        #[cfg(test)]
        let _append_done = tests::append_pause(&state.app_dir).await;
        let mailbox_for_closure = mailbox.clone();
        let verified: Result<Result<(u32, u32, Option<u32>), String>, _> = tokio::time::timeout(
            Duration::from_secs(60),
            async {
                let mut session = crate::imap::create_imap_session_no_compress(&account, &state.imap_pool)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    struct AppendGate {
        entered: std::sync::mpsc::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
        done: std::sync::mpsc::Sender<()>,
    }
    fn append_gates() -> &'static std::sync::Mutex<std::collections::BTreeMap<std::path::PathBuf, AppendGate>> {
        static GATES: std::sync::OnceLock<std::sync::Mutex<std::collections::BTreeMap<std::path::PathBuf, AppendGate>>> = std::sync::OnceLock::new();
        GATES.get_or_init(Default::default)
    }
    pub(super) async fn append_pause(path: &std::path::Path) -> Option<crate::credentials::TestTaskDone> {
        let gate = append_gates().lock().unwrap().remove(path);
        if let Some(gate) = gate {
            let _ = gate.entered.send(());
            let _ = gate.release.await;
            Some(crate::credentials::TestTaskDone(gate.done))
        } else { None }
    }
    struct AppendPause {
        release: Option<tokio::sync::oneshot::Sender<()>>,
        entered: std::sync::mpsc::Receiver<()>,
        done: Option<std::sync::mpsc::Receiver<()>>,
    }
    impl AppendPause {
        fn arm(state: &Arc<DaemonState>) -> Self {
            let (release, gate) = tokio::sync::oneshot::channel();
            let (entered, notice) = std::sync::mpsc::channel();
            let (done, finished) = std::sync::mpsc::channel();
            append_gates().lock().unwrap().insert(state.app_dir.clone(), AppendGate { entered, release: gate, done });
            Self { release: Some(release), entered: notice, done: Some(finished) }
        }
        fn entered(&self) { self.entered.recv_timeout(Duration::from_secs(5)).expect("actual scheduled append child entered"); }
        fn finish(&mut self) {
            let _ = self.release.take().unwrap().send(());
            self.done.take().unwrap().recv_timeout(Duration::from_secs(10)).expect("actual scheduled append child completed");
        }
    }
    impl Drop for AppendPause {
        fn drop(&mut self) {
            if let Some(release) = self.release.take() { let _ = release.send(()); }
            if let Some(done) = self.done.take() {
                if done.recv_timeout(Duration::from_secs(10)).is_err() { std::process::abort(); }
            }
        }
    }

    fn st() -> Arc<DaemonState> {
        let dir =
            std::env::temp_dir().join(format!("mv-scheduled-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("accounts.json"), r#"[{"id":"acc1"},{"id":"acct1"},{"id":"b"}]"#).unwrap();
        let s = DaemonState::for_test(dir.clone(), dir, true);
        s.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&s.app_dir)).unwrap());
        s
    }

    #[tokio::test]
    async fn p3_stale_due_row_refuses_before_sending_gate() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _restore = crate::credentials::TestEnvRestore::capture();
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")),
        );
        let s = st();
        let account = json!({
            "email":"luke@mock.test", "password":"hunter2",
            "imapHost":server.host(), "imapPort":server.port(),
            "smtpHost":server.host(), "smtpPort":server.smtp_port(), "smtpSecure":false,
        });
        let creds = s.app_dir.join("credentials.json");
        std::fs::write(&creds, json!({"acc1":account.to_string()}).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        let params = json!({
            "accountId":"acc1", "account":account,
            "email":{"to":"partner@example.com", "subject":"Due", "text":"body"},
            "localTime":"2026-10-01T09:00", "tz":"Europe/Vilnius", "fireAt":1,
        });
        let created = crate::handlers::scheduled::route(&s, "scheduled.create", &params, json!(1)).await.unwrap();
        let row = created.result.expect("real scheduled row");
        let id = row["id"].as_str().unwrap();
        let before = app_db::with(&s.app_dir, |c| scheduled::get(c, id)).unwrap().unwrap();
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["acc1".to_owned()].into(), ..Default::default() },
        );
        let mut claim = s.account_lifecycle.try_close(lease, "acc1").unwrap();
        let drained = claim.wait_local_until(tokio::time::Instant::now() + Duration::from_secs(5)).await.unwrap();
        claim.mark_effects_started(drained).unwrap();
        claim.finish_retired().unwrap();

        attempt_row(&s, &before).await;
        let after = app_db::with(&s.app_dir, |c| scheduled::get(c, id)).unwrap().unwrap();
        assert!(s.account_lifecycle.try_operation(&[s.account_lifecycle.capture("b").unwrap()]).is_ok());
        assert!(after.status == before.status && after.attempts == before.attempts
            && after.fire_at == before.fire_at && server.sent_messages().is_empty(),
            "stale due row changed sending gate or sent bytes: before={before:?} after={after:?} sent={}",
            server.sent_messages().len());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p3_scheduled_append_outlives_row_and_blocks_close() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _restore = crate::credentials::TestEnvRestore::capture();
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new().mailbox(mock_imap::state::Mailbox::new("Sent")),
        );
        let s = st();
        let account = json!({
            "email":"luke@mock.test", "password":"hunter2",
            "imapHost":server.host(), "imapPort":server.port(),
            "smtpHost":server.host(), "smtpPort":server.smtp_port(), "smtpSecure":false,
        });
        let creds = s.app_dir.join("credentials.json");
        std::fs::write(&creds, json!({"acc1":account.to_string()}).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        let params = json!({
            "accountId":"acc1", "account":account,
            "email":{"to":"partner@example.com", "subject":"Due", "text":"body"},
            "localTime":"2026-10-01T09:00", "tz":"Europe/Vilnius", "fireAt":1,
            "sentMailbox":"Sent",
        });
        let created = crate::handlers::scheduled::route(&s, "scheduled.create", &params, json!(1)).await.unwrap();
        let row = created.result.expect("real scheduled row");
        let id = row["id"].as_str().unwrap();
        let uid = row["uid"].as_u64().unwrap() as u32;
        let mut append = AppendPause::arm(&s);
        let mut rx = s.events.subscribe();
        let sent = crate::handlers::scheduled::route(&s, "scheduled.send_now", &json!({"id":id}), json!(1)).await.unwrap();
        assert_eq!(sent.result.as_ref().unwrap()["status"], json!("sent"));
        append.entered();
        assert_eq!(server.sent_messages().len(), 1, "one actual transport");
        assert!(!vault_files::exists(&s.data_dir, "acc1", "Scheduled", uid), "frozen file removed after send");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["acc1".to_owned()].into(), ..Default::default() },
        );
        let early = s.account_lifecycle.try_close(lease, "acc1");
        let excluded = early.is_err();
        drop(early);
        assert!(s.account_lifecycle.try_operation(&[s.account_lifecycle.capture("b").unwrap()]).is_ok());
        append.finish();
        let payload = loop {
            let line = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
            let (event, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            if event == "send-server-append-complete" { break payload; }
        };
        assert_eq!(payload["ok"], json!(true), "{payload}");
        assert_eq!(server.state().find("Sent").unwrap().messages.len(), 1);
        attempt_row(&s, &app_db::with(&s.app_dir, |c| scheduled::get(c, id)).unwrap().unwrap()).await;
        assert_eq!(server.sent_messages().len(), 1, "sent row never fires twice while append finishes");
        assert!(excluded, "scheduled row returned sent before actual append child stopped excluding close");
        let lease = crate::account_workflows::AccountLease::detached_for_test(
            crate::account_workflows::AccountWriteScope { ids: ["acc1".to_owned()].into(), ..Default::default() },
        );
        assert!(s.account_lifecycle.try_close(lease, "acc1").is_ok());
    }

    /// A stored OAuth2 record whose token expired long ago, with `extra`
    /// merged in, and the `ImapConfig` the keychain read makes of it.
    fn expired_record(extra: Value) -> (ImapConfig, crate::credentials::RecordSnapshot) {
        let mut record = json!({
            "authType": "oauth2",
            "oauth2AccessToken": "token-stored",
            "oauth2RefreshToken": "rt-stored",
            "oauth2ExpiresAt": 1_000_000_000_000i64,
        });
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            record[k] = v;
        }
        (
            serde_json::from_value(record.clone()).expect("ImapConfig"),
            crate::credentials::RecordSnapshot {
                record,
                generation: crate::credentials::write_generation(),
            },
        )
    }

    fn field(body: &str, key: &str) -> Option<String> {
        url::form_urlencoded::parse(body.as_bytes())
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.to_string())
    }

    fn fresh(token: &str) -> (u16, String) {
        (
            200,
            json!({"access_token": token, "expires_in": 3600}).to_string(),
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_scheduled_send_rejects_a_stale_config_and_token_snapshot() {
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore = crate::credentials::TestEnvRestore::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        std::fs::write(dir.path().join("accounts.json"), r#"[{"id":"g"}]"#).unwrap();
        let mut record = json!({"id":"g","email":"me@gmail.test","imapHost":"imap.gmail.com","authType":"oauth2","oauth2Provider":"google","oauth2ClientId":mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID,"oauth2AccessToken":"synthetic-old-token","oauth2RefreshToken":"synthetic-old-refresh","oauth2ExpiresAt":chrono::Utc::now().timestamp_millis()+3_600_000});
        std::fs::write(&path, json!({"g":record.to_string()}).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &path);
        let state = DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), true);
        let (done, finished) = std::sync::mpsc::channel();
        let _cleanup = crate::credentials::TestTaskDrain(finished);
        let pause = crate::oauth_tokens::TestRecordReadPause::arm("g");
        let completion = crate::credentials::TestTaskDone(done);
        let s = Arc::clone(&state);
        let pending = tokio::spawn(async move {
            let _completion = completion;
            let (account, record) = resolve_credentials("g").await?;
            with_fresh_token(&s, "g", account, &record).await
        });
        pause.wait();
        record["oauth2AccessToken"] = json!("synthetic-new-token");
        record["oauth2RefreshToken"] = json!("synthetic-new-refresh");
        let reply = crate::server::handle_request_for_test(
            &state,
            "credentials.save",
            json!({"records":{"g":record.to_string()}}),
        )
        .await;
        assert!(reply.error.is_none());
        drop(pause);
        assert!(
            pending.await.unwrap().is_err(),
            "stale send must not receive its old config or fallback token"
        );
        let (account, snapshot) = resolve_credentials("g").await.unwrap();
        let current = with_fresh_token(&state, "g", account, &snapshot)
            .await
            .unwrap();
        assert!(current.access_token.as_deref() == Some("synthetic-new-token"));
    }

    /// A Gmail account refreshes with the Google client that issued its
    /// refresh token (the one stamped on the record) and Google's mail scope:
    /// never Graph's scopes, and never the other Google client, whose token
    /// endpoint would answer `invalid_grant` for a grant it did not issue.
    #[tokio::test]
    async fn a_google_record_refreshes_with_its_own_client_and_the_google_scope() {
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _tokens =
            crate::handlers::oauth2::test_token_mock(vec![fresh("g-fresh"), fresh("g-fresh-2")]);
        let s = st();
        let thunderbird = mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID;
        let google = |stamp: &str| {
            expired_record(json!({
                "email": "me@gmail.test",
                "imapHost": "imap.gmail.com",
                "smtpHost": "smtp.gmail.com",
                "oauth2Provider": "google",
                "oauth2ClientId": stamp,
            }))
        };

        let (account, record) = google(thunderbird);
        let _ = with_fresh_token(&s, "g-thunderbird", account, &record).await;
        let posts = crate::handlers::oauth2::test_token_posts();
        assert_eq!(posts.len(), 1, "{posts:?}");
        assert_eq!(
            field(&posts[0], "grant_type").as_deref(),
            Some("refresh_token")
        );
        assert_eq!(
            field(&posts[0], "refresh_token").as_deref(),
            Some("rt-stored")
        );
        assert_eq!(field(&posts[0], "client_id").as_deref(), Some(thunderbird));
        assert_eq!(
            field(&posts[0], "scope").as_deref(),
            Some("https://mail.google.com/")
        );

        // The other client: MailVault's own when this build carries it, else
        // one this build cannot pair, which must not fall back to Thunderbird's.
        let other = mailvault_core::oauth2::own_google_client_id()
            .unwrap_or("someone-else.apps.googleusercontent.com");
        let (account, record) = google(other);
        let _ = with_fresh_token(&s, "g-other", account, &record).await;
        let posts = crate::handlers::oauth2::test_token_posts();
        assert!(
            posts
                .iter()
                .all(|p| field(p, "client_id").as_deref() != Some(thunderbird)),
            "{posts:?}"
        );
        if mailvault_core::oauth2::own_google_client_id().is_some() {
            assert_eq!(posts.len(), 1, "{posts:?}");
            assert_eq!(field(&posts[0], "client_id").as_deref(), Some(other));
            assert_eq!(
                field(&posts[0], "scope").as_deref(),
                Some("https://mail.google.com/")
            );
        } else {
            assert!(
                posts.is_empty(),
                "a client this build cannot pair is never asked: {posts:?}"
            );
        }
    }

    /// An Outlook account on IMAP (not the Graph transport) refreshes with the
    /// IMAP and SMTP scopes it was signed in with. The Graph record beside it
    /// is the control: same provider, Graph's scopes.
    #[tokio::test]
    async fn a_microsoft_imap_record_refreshes_with_the_imap_scopes() {
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _tokens =
            crate::handlers::oauth2::test_token_mock(vec![fresh("ms-fresh"), fresh("graph-fresh")]);
        let s = st();
        let microsoft = |transport: Option<&str>| {
            expired_record(json!({
                "email": "me@contoso.test",
                "imapHost": "outlook.office365.com",
                "smtpHost": "smtp.office365.com",
                "oauth2Provider": "microsoft",
                "oauth2Transport": transport,
            }))
        };

        let (account, record) = microsoft(None);
        assert!(!account.uses_graph());
        let _ = with_fresh_token(&s, "ms-imap", account, &record).await;
        let (graph_account, graph_record) = microsoft(Some("graph"));
        assert!(graph_account.uses_graph());
        let _ = with_fresh_token(&s, "ms-graph", graph_account, &graph_record).await;

        let posts = crate::handlers::oauth2::test_token_posts();
        assert_eq!(posts.len(), 2, "{posts:?}");
        let imap_scope = field(&posts[0], "scope").unwrap_or_default();
        assert!(
            imap_scope.contains("https://outlook.office.com/IMAP.AccessAsUser.All"),
            "{imap_scope}"
        );
        assert!(
            imap_scope.contains("https://outlook.office.com/SMTP.Send"),
            "{imap_scope}"
        );
        assert!(
            !imap_scope.contains("Mail.Send") && !imap_scope.contains("Mail.ReadWrite"),
            "{imap_scope}"
        );
        assert_eq!(
            field(&posts[0], "refresh_token").as_deref(),
            Some("rt-stored")
        );
        let graph_scope = field(&posts[1], "scope").unwrap_or_default();
        assert!(
            graph_scope.contains("Mail.Send") && !graph_scope.contains("IMAP"),
            "control: {graph_scope}"
        );
        assert_ne!(
            field(&posts[0], "client_id").as_deref(),
            Some(mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID)
        );
    }

    /// A JMAP account's scheduled send (Task 9c pin): out through
    /// `send_via_jmap` (the server files the Sent copy, so no APPEND), never
    /// SMTP or IMAP, and its reminder is recorded and checked over JMAP.
    #[tokio::test]
    async fn jmap_a_scheduled_send_goes_through_jmap_and_its_reminder_is_checked_over_jmap() {
        use crate::jmap_test_support as support;
        use mailvault_core::app_db::follow_up;
        let _env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore = crate::credentials::TestEnvRestore::capture();
        let m = mock_jmap::MockJmap::start(support::scenario());
        let (trap, port) = support::imap_trap();
        let s = st();
        let dir = s.data_dir.clone();
        let creds = dir.join("credentials.json");
        std::fs::write(
            &creds,
            json!({ "acct1": support::account_json(&m, port).to_string() }).to_string(),
        )
        .unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        let raw = "From: alice@example.test\r\nTo: bob@example.test\r\nMessage-ID: <sched1@x>\r\nSubject: Later\r\nDate: Fri, 02 Oct 2026 09:00:00 +0000\r\n\r\nscheduled body\r\n";
        let cur = vault_files::cur_path(&dir, "acct1", "Drafts");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(
            cur.join(format!("7{}S.eml", mailvault_core::maildir::INFO_PREFIX)),
            raw,
        )
        .unwrap();
        s.vault_registry.invalidate("acct1", "Drafts");
        let envelope = json!({
            "from": "alice@example.test", "to": "bob@example.test", "cc": "", "bcc": "",
            "sentMailbox": "Sent", "remindDays": 3, "ownAddresses": ["alice@example.test"],
        })
        .to_string();
        app_db::with(&s.app_dir, |c| {
            scheduled::insert(
                c,
                "row1",
                "acct1",
                "Drafts",
                7,
                &envelope,
                "2026-10-02T09:00",
                "UTC",
                1_000,
            )
        })
        .unwrap();
        let row = app_db::with(&s.app_dir, |c| scheduled::get(c, "row1"))
            .unwrap()
            .expect("the row");

        let (account, envelope) = match prepare_send(&s, &row).await {
            Ok(prepared) => prepared,
            Err(_) => panic!("test credentials and envelope are valid"),
        };
        let stamp = s.account_lifecycle.capture("acct1").unwrap();
        let operation = s.account_lifecycle.try_operation(&[stamp]).unwrap();
        let sent = send_one(&s, &row, account, envelope, operation).await;
        let reminders = app_db::with(&s.app_dir, |c| follow_up::list(c, Some("acct1"))).unwrap();
        let checked = match reminders.first() {
            Some(reminder) => Some(crate::follow_up_worker::check_row(&s, reminder).await),
            None => None,
        };
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert!(matches!(sent, Outcome::Sent), "the scheduled send went out");
        assert_eq!(m.submitted().len(), 1, "one EmailSubmission");
        assert_eq!(reminders.len(), 1, "the reminder is recorded");
        assert_eq!(reminders[0].message_id, "<sched1@x>");
        assert!(
            matches!(checked, Some(follow_up::Outcome::NoReply { ref sent_mailbox, .. }) if sent_mailbox == "Sent"),
            "no reply yet, and the Sent copy is the server's: {checked:?}"
        );
        assert!(trap.accept().is_err(), "no IMAP dial");
    }
}
