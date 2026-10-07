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
    /// The follow-up reminder asked for at schedule time, in days; 0 is none.
    #[serde(default, rename = "remindDays")]
    remind_days: i64,
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
async fn resolve_credentials(account_id: &str) -> Result<(ImapConfig, serde_json::Value), String> {
    crate::credentials::resolve_account_with_record_guarded(account_id).await
}

/// Refresh this long before the stored expiry, as the app's
/// `ensureFreshToken` does (`REFRESH_BUFFER_MS`).
const TOKEN_REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;

/// The account with an OAuth2 token good for the send.
///
/// The keychain holds whatever token the app last stored, and the app only
/// refreshes while it is open: a row due after a night with the app closed
/// found one that expired hours ago. A token within the margin of its expiry
/// is refreshed here, with the record's own provider, client and scopes (a
/// Graph account's Graph scopes, `use_graph`), the way `oauth2_refresh` does
/// for the app. The new token is used for this send only and not written
/// back: the app rewrites the whole credentials blob from its own copy, so a
/// daemon write would race it, and the refresh token stays valid either way.
/// No expiry on record means no refresh, as in the app.
///
/// A refresh that fails while the stored token is still valid leaves the
/// stored one, so a send that worked before this refresh existed still works.
/// Once it has expired there is nothing to send with, and `Err` says why: a
/// refusal (the provider said no, or a client this build cannot pair) asks
/// for a new sign-in (`smtp::SIGN_IN_AGAIN`, which ends the row); no usable
/// answer at all (`renewal_unanswered`) goes to the network probe: offline
/// waits for the network, online takes the retry ladder.
async fn with_fresh_token(
    state: &Arc<DaemonState>,
    mut account: ImapConfig,
    record: &serde_json::Value,
) -> Result<ImapConfig, String> {
    if !account.is_oauth2() {
        return Ok(account);
    }
    let text = |k: &str| record.get(k).and_then(serde_json::Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned);
    let Some(refresh) = text("oauth2RefreshToken") else { return Ok(account) };
    let Some(expires_at) = record.get("oauth2ExpiresAt").and_then(serde_json::Value::as_f64).map(|v| v as i64) else {
        return Ok(account);
    };
    if now_ms() < expires_at - TOKEN_REFRESH_MARGIN_MS {
        return Ok(account);
    }
    let refreshed = state
        .oauth2
        .refresh_token(
            &refresh,
            text("oauth2Provider"),
            text("oauth2CustomClientId"),
            text("oauth2TenantId"),
            account.uses_graph(),
            text("oauth2ClientId"),
        )
        .await;
    let failure = match refreshed {
        Ok(tokens) if !tokens.access_token.is_empty() => {
            info!("[scheduled-send] refreshed the expiring token for {}", account.email);
            account.access_token = Some(tokens.access_token);
            return Ok(account);
        }
        Ok(_) => "the refresh returned no token".to_string(),
        Err(e) => e,
    };
    if now_ms() < expires_at {
        warn!("[scheduled-send] could not refresh the token for {}: {failure}; sending with the stored one, still valid", account.email);
        return Ok(account);
    }
    warn!("[scheduled-send] the token for {} has expired and could not be refreshed: {failure}", account.email);
    if renewal_unanswered(&failure) {
        // The provider's text can carry an em dash; ours does not.
        let failure = failure.replace(" \u{2014} ", ": ");
        return Err(format!("Could not renew the sign-in for {}: {}", account.email, failure));
    }
    Err(format!("The sign-in for {} has expired and could not be renewed. {}", account.email, smtp::SIGN_IN_AGAIN))
}

/// A refresh that got no usable answer, as `oauth2::refresh_token` words it:
/// the request failed, the reply was not a token response, or the provider
/// said it is down for now. Anything else is a refusal no retry will change.
fn renewal_unanswered(failure: &str) -> bool {
    failure.starts_with("Refresh request failed")
        || failure.starts_with("Refresh response parse failed")
        || failure.contains("temporarily_unavailable")
        || failure.contains("server_error")
}

async fn send_one(state: &Arc<DaemonState>, row: &scheduled::ScheduledSend) -> Outcome {
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
                return Outcome::Offline(msg);
            }
            return if within_credential_grace() { Outcome::Transient(msg) } else { Outcome::Terminal(msg) };
        }
    };
    let account = match with_fresh_token(state, account, &record).await {
        Ok(a) => a,
        Err(e) if is_terminal_smtp_error(&e) => return Outcome::Terminal(e),
        // A renewal that got no answer always asks the probe, not
        // `note_failure`, whose needles only guess from the wording: the
        // cause can be in the system's language (Windows) or missing. An
        // expired token at wake, before the Wi-Fi joins, otherwise read as
        // online and spent the row's tries in 90 seconds.
        Err(e) => return if state.net.confirm_online().await { Outcome::Transient(e) } else { Outcome::Offline(e) },
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
            // Graph accounts get no reminder: the daemon has no token to
            // check for a reply with, and the app does not offer one there.
            if !account.uses_graph() {
                let recipients = stored.envelope.to.clone();
                crate::follow_up_worker::record_after_send(
                    state,
                    &row.account_id,
                    &result.raw_rfc2822,
                    &recipients,
                    stored.sent_mailbox.as_deref(),
                    stored.remind_days,
                );
            }
            append_to_sent(state, &account, &row.account_id, stored.sent_mailbox, &result);
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

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-scheduled-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    /// A stored OAuth2 record whose token expired long ago, with `extra`
    /// merged in, and the `ImapConfig` the keychain read makes of it.
    fn expired_record(extra: Value) -> (ImapConfig, Value) {
        let mut record = json!({
            "authType": "oauth2",
            "oauth2AccessToken": "token-stored",
            "oauth2RefreshToken": "rt-stored",
            "oauth2ExpiresAt": 1_000_000_000_000i64,
        });
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            record[k] = v;
        }
        (serde_json::from_value(record.clone()).expect("ImapConfig"), record)
    }

    fn field(body: &str, key: &str) -> Option<String> {
        url::form_urlencoded::parse(body.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.to_string())
    }

    fn fresh(token: &str) -> (u16, String) {
        (200, json!({"access_token": token, "expires_in": 3600}).to_string())
    }

    /// A Gmail account refreshes with the Google client that issued its
    /// refresh token (the one stamped on the record) and Google's mail scope:
    /// never Graph's scopes, and never the other Google client, whose token
    /// endpoint would answer `invalid_grant` for a grant it did not issue.
    #[tokio::test]
    async fn a_google_record_refreshes_with_its_own_client_and_the_google_scope() {
        let _tokens = crate::handlers::oauth2::test_token_mock(vec![fresh("g-fresh"), fresh("g-fresh-2")]);
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
        let _ = with_fresh_token(&s, account, &record).await;
        let posts = crate::handlers::oauth2::test_token_posts();
        assert_eq!(posts.len(), 1, "{posts:?}");
        assert_eq!(field(&posts[0], "grant_type").as_deref(), Some("refresh_token"));
        assert_eq!(field(&posts[0], "refresh_token").as_deref(), Some("rt-stored"));
        assert_eq!(field(&posts[0], "client_id").as_deref(), Some(thunderbird));
        assert_eq!(field(&posts[0], "scope").as_deref(), Some("https://mail.google.com/"));

        // The other client: MailVault's own when this build carries it, else
        // one this build cannot pair, which must not fall back to Thunderbird's.
        let other = mailvault_core::oauth2::own_google_client_id().unwrap_or("someone-else.apps.googleusercontent.com");
        let (account, record) = google(other);
        let _ = with_fresh_token(&s, account, &record).await;
        let posts = crate::handlers::oauth2::test_token_posts();
        assert!(posts.iter().all(|p| field(p, "client_id").as_deref() != Some(thunderbird)), "{posts:?}");
        if mailvault_core::oauth2::own_google_client_id().is_some() {
            assert_eq!(posts.len(), 1, "{posts:?}");
            assert_eq!(field(&posts[0], "client_id").as_deref(), Some(other));
            assert_eq!(field(&posts[0], "scope").as_deref(), Some("https://mail.google.com/"));
        } else {
            assert!(posts.is_empty(), "a client this build cannot pair is never asked: {posts:?}");
        }
    }

    /// An Outlook account on IMAP (not the Graph transport) refreshes with the
    /// IMAP and SMTP scopes it was signed in with. The Graph record beside it
    /// is the control: same provider, Graph's scopes.
    #[tokio::test]
    async fn a_microsoft_imap_record_refreshes_with_the_imap_scopes() {
        let _tokens = crate::handlers::oauth2::test_token_mock(vec![fresh("ms-fresh"), fresh("graph-fresh")]);
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
        let _ = with_fresh_token(&s, account, &record).await;
        let (graph_account, graph_record) = microsoft(Some("graph"));
        assert!(graph_account.uses_graph());
        let _ = with_fresh_token(&s, graph_account, &graph_record).await;

        let posts = crate::handlers::oauth2::test_token_posts();
        assert_eq!(posts.len(), 2, "{posts:?}");
        let imap_scope = field(&posts[0], "scope").unwrap_or_default();
        assert!(imap_scope.contains("https://outlook.office.com/IMAP.AccessAsUser.All"), "{imap_scope}");
        assert!(imap_scope.contains("https://outlook.office.com/SMTP.Send"), "{imap_scope}");
        assert!(!imap_scope.contains("Mail.Send") && !imap_scope.contains("Mail.ReadWrite"), "{imap_scope}");
        assert_eq!(field(&posts[0], "refresh_token").as_deref(), Some("rt-stored"));
        let graph_scope = field(&posts[1], "scope").unwrap_or_default();
        assert!(graph_scope.contains("Mail.Send") && !graph_scope.contains("IMAP"), "control: {graph_scope}");
        assert_ne!(field(&posts[0], "client_id").as_deref(), Some(mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID));
    }
}
