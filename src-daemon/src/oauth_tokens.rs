//! The daemon's one source of OAuth2 access tokens (Phase 1, step 0c).
//!
//! Every RPC and background worker that talks to Gmail, Outlook or Graph for
//! an OAuth2 account gets its access token here, by account id, instead of
//! trusting whatever the app put in the request. `access_token` returns a
//! token good for at least `REFRESH_MARGIN_MS`, refreshing it first when it
//! is expired or about to be, the way the app's `ensureFreshToken` did.
//!
//! What it holds, per account, in memory only: the newest token pair it knows
//! and the grant it came with (refresh token, provider, Google client stamp,
//! tenant, Graph scopes). A refresh always posts a refresh token together with
//! the client that issued it, both from the same source.
//!
//! Where tokens are stored does not change: the app remains the normal
//! credential persistence orchestrator (the existing keychain item or sealed
//! store). This token module never writes credentials itself. After a refresh
//! this module emits `REFRESHED_EVENT` with
//! the account id and nothing else; the app takes the new pair
//! (`oauth2.take_refreshed`) and saves it through its own `updateOAuth2Tokens`
//! path, then says it wrote (`oauth2.credentials_changed`).
//!
//! The stored record and the held entry are reconciled on every read of the
//! record: the one with the later expiry wins. A stale whole-blob write by the
//! app (an older expiry) never rolls a refreshed token back; a new sign-in
//! (a newer expiry) replaces the held one, refresh token and client included.
//!
//! Failures, as the app handled them: a refresh that fails while the held
//! token is still valid keeps using it; once it has expired the caller gets
//! a `TokenError` carrying the expired token as `fallback`, which RPCs still
//! send, so the server's refusal is what the user sees (the "sign in again"
//! state the app derives from it). After a failure no new attempt is made for
//! a while, so an offline machine does not pay a token round trip per call.
//!
//! No token ever reaches a log line, an event, or a `TokenError` message.

use crate::credentials;
use crate::imap::ImapConfig;
use crate::server::DaemonState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{info, warn};

/// Refresh this long before the stored expiry (the app's `REFRESH_BUFFER_MS`).
pub(crate) const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;
/// Emitted after a refresh, payload `{accountId}` only.
pub(crate) const REFRESHED_EVENT: &str = "oauth2-tokens-refreshed";
/// After a refresh that got no usable answer: no new attempt for this long.
const UNANSWERED_COOLDOWN: Duration = Duration::from_secs(30);
/// After the provider refused: no new attempt for this long, unless a new
/// sign-in replaces the grant first.
const REFUSED_COOLDOWN: Duration = Duration::from_secs(10 * 60);
/// After a refresh a server's refusal asked for: no refusal asks for another
/// one before this long has passed, doubling while refusals keep coming (a
/// server that refuses even a valid token: IMAP off for the account, a scope
/// it lacks) up to `REJECTION_BACKOFF_CAP`.
const REJECTION_BACKOFF: Duration = Duration::from_secs(60);
const REJECTION_BACKOFF_CAP: Duration = Duration::from_secs(10 * 60);

/// How the stored record may be read: `Guarded` may raise the keychain prompt
/// (only when the gate is clear, as every guarded read), `Quiet` never does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Read {
    Guarded,
    Quiet,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailKind {
    /// The provider said no (`invalid_grant`, a client this build cannot
    /// pair): only a new sign-in fixes it.
    Refused,
    /// No usable answer (offline, a timeout, the provider down for now).
    Unanswered,
    /// The stored record could not be read.
    Unreadable,
    /// The store holds no record for the account.
    NoRecord,
}

fn stale_snapshot() -> TokenError {
    TokenError {
        kind: FailKind::Unreadable,
        message: "Stored credentials changed during this request. Try again.".to_string(),
        fallback: None,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TokenError {
    pub kind: FailKind,
    /// Why, with every token this account holds cut out.
    pub message: String,
    /// The newest access token held, expired: what a caller sends anyway so
    /// the server's own refusal reaches the user, as the app did.
    pub fallback: Option<String>,
}

/// What a refresh needs, from the record its refresh token came from.
#[derive(Clone)]
struct Grant {
    email: String,
    refresh_token: String,
    provider: Option<String>,
    custom_client_id: Option<String>,
    tenant_id: Option<String>,
    use_graph: bool,
    /// The Google client that issued `refresh_token` (`oauth2ClientId`).
    client_id: Option<String>,
}

impl Grant {
    /// The same sign-in as `other` (a record read back), refresh token
    /// rotations aside: same address, provider, Google client, custom client,
    /// tenant and transport, and `other`'s refresh token is one this chain
    /// has held. Anything else is a new grant (a Reconnect, a switch of the
    /// Google sign-in app, IMAP to Graph), which replaces the held entry
    /// whatever the expiries say.
    fn same_grant(&self, lineage: &[String], other: &Grant) -> bool {
        self.email.eq_ignore_ascii_case(&other.email)
            && self.provider == other.provider
            && self.client_id == other.client_id
            && self.custom_client_id == other.custom_client_id
            && self.tenant_id == other.tenant_id
            && self.use_graph == other.use_graph
            && lineage.iter().any(|rt| *rt == other.refresh_token)
    }

    /// One refresh token of this grant, named without the token itself: the
    /// app computes the same over a stored record (`grantFingerprint`) and
    /// never writes this grant's pair over another grant's sign-in.
    fn fingerprint(&self, refresh_token: &str) -> String {
        use sha2::{Digest, Sha256};
        let named = json!([
            refresh_token,
            self.client_id.as_deref().unwrap_or(""),
            if self.use_graph { "graph" } else { "" },
            self.tenant_id.as_deref().unwrap_or(""),
            self.custom_client_id.as_deref().unwrap_or(""),
        ]);
        Sha256::digest(named.to_string().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[derive(Clone)]
struct Entry {
    grant: Grant,
    /// Every refresh token this grant has had here, the record's first: a
    /// stale write of the record still names one of them.
    lineage: Vec<String>,
    access_token: String,
    /// Epoch ms; 0 when the record never said (no refresh then, as the app).
    expires_at: i64,
    /// Refreshed here and not yet seen in the stored record.
    unsaved: bool,
    /// The stored record was read since the app last wrote credentials.
    checked: bool,
    /// A server refused `access_token`: refresh before using it again.
    rejected: bool,
    /// After a failed refresh: none before this, and why it failed.
    cooldown: Option<(i64, FailKind, String)>,
    /// A refusal before this does not ask for a refresh (`REJECTION_BACKOFF`).
    rejection_quiet_until: Option<i64>,
    /// The quiet time the next refusal-driven refresh starts; zero when a
    /// request has gone through since.
    rejection_backoff: Duration,
}

impl Entry {
    fn needs_refresh(&self, now: i64) -> bool {
        self.rejected || self.access_token.is_empty() || (self.expires_at > 0 && now >= self.expires_at - REFRESH_MARGIN_MS)
    }

    fn still_valid(&self, now: i64) -> bool {
        !self.rejected && !self.access_token.is_empty() && (self.expires_at == 0 || now < self.expires_at)
    }

    fn failure(&self, kind: FailKind, message: String) -> TokenError {
        TokenError { kind, message, fallback: (!self.access_token.is_empty()).then(|| self.access_token.clone()) }
    }
}

/// Per account: the held entry, and the lock one refresh holds so concurrent
/// callers wait for it instead of posting their own.
#[derive(Default)]
pub(crate) struct TokenStore {
    entries: Mutex<HashMap<String, Entry>>,
    flights: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Debug builds only: how far a test moved this store's clock, so token
    /// lifetimes and cooldowns pass without sleeping and without touching the
    /// system clock. A release build has no such field.
    #[cfg(debug_assertions)]
    clock_offset_ms: std::sync::atomic::AtomicI64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The grant, token and expiry of a stored record, or `None` when the daemon
/// does not manage its token: not OAuth2, or no refresh token (the app left
/// such an account untouched too).
fn grant_of(record: &Value) -> Option<(Grant, String, i64)> {
    let text = |k: &str| record.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned);
    if record.get("authType").and_then(Value::as_str) != Some("oauth2") {
        return None;
    }
    let grant = Grant {
        email: text("email").unwrap_or_default(),
        refresh_token: text("oauth2RefreshToken")?,
        provider: text("oauth2Provider"),
        custom_client_id: text("oauth2CustomClientId"),
        tenant_id: text("oauth2TenantId"),
        use_graph: record.get("oauth2Transport").and_then(Value::as_str) == Some("graph"),
        client_id: text("oauth2ClientId"),
    };
    let expires_at = record
        .get("oauth2ExpiresAt")
        .and_then(Value::as_f64)
        .map(|v| v as i64)
        .unwrap_or(0);
    Some((
        grant,
        text("oauth2AccessToken").unwrap_or_default(),
        expires_at,
    ))
}

/// A stored record's grant fingerprint for `refresh_token` (its own when
/// `None`): what `unsaved()` names in `chain`, so a writer can tell whether a
/// refreshed pair belongs to the grant stored now. `None` for a record with
/// no OAuth2 grant. Never logged.
pub(crate) fn record_fingerprint(record: &Value, refresh_token: Option<&str>) -> Option<String> {
    let (grant, _, _) = grant_of(record)?;
    Some(grant.fingerprint(refresh_token.unwrap_or(&grant.refresh_token)))
}

/// The stored token of an OAuth2 record with no refresh token: used as it
/// is, nothing can renew it.
fn unrefreshable_token(record: &Value) -> Option<String> {
    (record.get("authType").and_then(Value::as_str) == Some("oauth2"))
        .then(|| record.get("oauth2AccessToken").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned))
        .flatten()
}

/// A refresh that got no usable answer, as `oauth2::refresh_token` words it:
/// the request failed, the reply was not a token response, or the provider
/// said it is down for now. Anything else is a refusal no retry will change.
pub(crate) fn renewal_unanswered(failure: &str) -> bool {
    failure.starts_with("Refresh request failed")
        || failure.starts_with("Refresh response parse failed")
        || failure.contains("temporarily_unavailable")
        || failure.contains("server_error")
}

/// `text` with every secret cut out, and the provider's em dash made a colon.
fn scrub(text: &str, secrets: &[&str]) -> String {
    let mut out = text.replace(" \u{2014} ", ": ");
    for secret in secrets.iter().filter(|s| s.len() >= 4) {
        out = out.replace(secret, "[redacted]");
    }
    out
}

impl TokenStore {
    /// Epoch ms: the system clock, moved by a test in a debug build.
    pub(crate) fn now(&self) -> i64 {
        #[cfg(debug_assertions)]
        return now_ms()
            + self
                .clock_offset_ms
                .load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(debug_assertions))]
        now_ms()
    }

    /// Debug builds only: move this store's clock forward (tests).
    #[cfg(debug_assertions)]
    pub(crate) fn advance_clock_for_tests(&self, by: Duration) {
        self.clock_offset_ms
            .fetch_add(by.as_millis() as i64, std::sync::atomic::Ordering::SeqCst);
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn flight(&self, account_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut flights = self.flights.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(flights.entry(account_id.to_string()).or_default())
    }

    /// The held token, when it is good past the margin and the stored record
    /// was read since the app last wrote. No I/O: the hot path.
    fn cached(&self, account_id: &str, now: i64) -> Option<String> {
        self.entries()
            .get(account_id)
            .filter(|e| e.checked && !e.needs_refresh(now))
            .map(|e| e.access_token.clone())
    }

    /// Lay a just-read record over the held entry: the later expiry wins. A
    /// record the daemon does not manage (or none) drops the entry.
    fn reconcile(
        &self,
        account_id: &str,
        snapshot: &credentials::RecordSnapshot,
    ) -> Result<Option<Entry>, TokenError> {
        #[cfg(test)]
        tests::before_publication(account_id);
        let mut entries = self.entries();
        if snapshot.generation != credentials::write_generation() {
            return Err(stale_snapshot());
        }
        let record = &snapshot.record;
        let Some((grant, access_token, expires_at)) = grant_of(record) else {
            entries.remove(account_id);
            return Ok(None);
        };
        if let Some(held) = entries.get_mut(account_id) {
            let same_grant = held.grant.same_grant(&held.lineage, &grant);
            let saved = held.access_token == access_token && held.expires_at == expires_at;
            if same_grant && (saved || held.expires_at > expires_at) {
                if saved {
                    held.unsaved = false;
                }
                held.checked = true;
                return Ok(Some(held.clone()));
            }
        }
        // A new grant (or none held): the record's pair, and nothing of the
        // old grant's, unsaved pair included, survives.
        let lineage = vec![grant.refresh_token.clone()];
        let entry = Entry {
            grant,
            lineage,
            access_token,
            expires_at,
            unsaved: false,
            checked: true,
            rejected: false,
            cooldown: None,
            rejection_quiet_until: None,
            rejection_backoff: Duration::ZERO,
        };
        entries.insert(account_id.to_string(), entry.clone());
        Ok(Some(entry))
    }

    #[cfg(test)]
    pub(crate) fn has_trusted_token_for_test(&self, account_id: &str) -> bool {
        self.cached(account_id, self.now()).is_some()
    }

    /// The app wrote the credentials blob: read it again before trusting a
    /// held token, so a new sign-in (or a removed account) takes effect.
    pub(crate) fn credentials_changed(&self) {
        for entry in self.entries().values_mut() {
            entry.checked = false;
        }
    }

    /// A server refused `token` for `account_id`: the next use refreshes,
    /// unless a refusal already asked for one within the quiet time.
    pub(crate) fn rejected(&self, account_id: &str, token: &str) {
        let now = self.now();
        if let Some(entry) = self.entries().get_mut(account_id) {
            let quiet = entry.rejection_quiet_until.is_some_and(|until| now < until);
            if entry.access_token == token && !quiet {
                entry.rejected = true;
            }
        }
    }

    /// A request went through with `token`: the next refusal-driven refresh
    /// starts the backoff afresh (the current quiet time still runs out).
    pub(crate) fn accepted(&self, account_id: &str, token: &str) {
        if let Some(entry) = self.entries().get_mut(account_id) {
            if entry.access_token == token {
                entry.rejection_backoff = Duration::ZERO;
            }
        }
    }

    /// The pairs refreshed here that the stored record does not show yet, for
    /// the app to save: `{accountId, accessToken, refreshToken, expiresAt,
    /// chain}`, `chain` being the fingerprints of the refresh tokens this
    /// grant has had (the app writes only over a record of the same grant).
    /// Kept until a read of the record shows them, so a save that failed is
    /// offered again.
    pub(crate) fn unsaved(&self) -> Vec<Value> {
        self.entries()
            .iter()
            .filter(|(_, e)| e.unsaved)
            .map(|(id, e)| {
                json!({
                    "accountId": id,
                    "accessToken": e.access_token,
                    "refreshToken": e.grant.refresh_token,
                    "expiresAt": e.expires_at,
                    "chain": e.lineage.iter().map(|rt| e.grant.fingerprint(rt)).collect::<Vec<_>>(),
                })
            })
            .collect()
    }

    /// The held token's expiry, epoch ms (0: the record never said).
    pub(crate) fn expires_at(&self, account_id: &str) -> Option<i64> {
        self.entries().get(account_id).map(|e| e.expires_at)
    }

    /// The address the held token was issued for.
    fn email(&self, account_id: &str) -> Option<String> {
        self.entries()
            .get(account_id)
            .map(|e| e.grant.email.clone())
    }

    fn unsaved_ids(&self) -> Vec<String> {
        self.entries()
            .iter()
            .filter(|(_, e)| e.unsaved)
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn store_refresh(
        &self,
        account_id: &str,
        grant: &Grant,
        access_token: String,
        refresh_token: Option<String>,
        expires_at: i64,
        generation: u64,
        events: &crate::events::EventBus,
    ) -> Result<(), TokenError> {
        let now = self.now();
        let mut entries = self.entries();
        if generation != credentials::write_generation() {
            return Err(stale_snapshot());
        }
        let Some(entry) = entries.get_mut(account_id) else {
            return Err(stale_snapshot());
        };
        if entry.rejected {
            let wait = if entry.rejection_backoff.is_zero() {
                REJECTION_BACKOFF
            } else {
                (entry.rejection_backoff * 2).min(REJECTION_BACKOFF_CAP)
            };
            entry.rejection_backoff = wait;
            entry.rejection_quiet_until = Some(now + wait.as_millis() as i64);
        }
        // The refresh token goes with the client it was posted with: only
        // the token itself rotates.
        entry.grant = grant.clone();
        if let Some(rt) = refresh_token.filter(|rt| !rt.is_empty()) {
            if !entry.lineage.contains(&rt) {
                entry.lineage.push(rt.clone());
            }
            entry.grant.refresh_token = rt;
        }
        entry.access_token = access_token;
        entry.expires_at = expires_at;
        entry.unsaved = true;
        entry.rejected = false;
        entry.cooldown = None;
        // Publication and its event precede any completed invalidation.
        events.emit(REFRESHED_EVENT, json!({ "accountId": account_id }));
        Ok(())
    }

    fn store_failure(
        &self,
        account_id: &str,
        kind: FailKind,
        message: &str,
        generation: u64,
    ) -> Result<(), TokenError> {
        let wait = if kind == FailKind::Refused {
            REFUSED_COOLDOWN
        } else {
            UNANSWERED_COOLDOWN
        };
        let now = self.now();
        let mut entries = self.entries();
        if generation != credentials::write_generation() {
            return Err(stale_snapshot());
        }
        if let Some(entry) = entries.get_mut(account_id) {
            entry.cooldown = Some((now + wait.as_millis() as i64, kind, message.to_string()));
        }
        Ok(())
    }
}

async fn read_record(
    account_id: &str,
    read: Read,
) -> Result<(ImapConfig, credentials::RecordSnapshot), String> {
    #[cfg(test)]
    tests::record_credential_lookup(account_id);
    let result = match read {
        Read::Guarded => credentials::resolve_account_with_record_guarded(account_id).await,
        Read::Quiet => credentials::resolve_account_with_record_quiet(account_id).await,
    };
    result
}

/// The ONE function: a valid access token for `account_id`, refreshed first
/// when it is expired or within `REFRESH_MARGIN_MS` of it.
///
/// `Ok(None)`: not an OAuth2 account (a password or JMAP one). An OAuth2 one
/// with no refresh token gets its stored token, never refreshed. `Err`: the token has
/// expired and could not be renewed, or the record could not be read.
pub(crate) async fn access_token(state: &DaemonState, account_id: &str, read: Read) -> Result<Option<String>, TokenError> {
    if let Some(token) = state.tokens.cached(account_id, state.tokens.now()) {
        return Ok(Some(token));
    }
    let (_, record) = read_record(account_id, read)
        .await
        .map_err(|e| {
            // `account_from_blob`'s words for an account the store does not hold.
            let kind = if e.starts_with("no credentials found") { FailKind::NoRecord } else { FailKind::Unreadable };
            TokenError { kind, message: e, fallback: None }
        })?;
    for_record(state, account_id, &record).await
}

/// `access_token` for a caller that has just read the record itself.
pub(crate) async fn for_record(
    state: &DaemonState,
    account_id: &str,
    record: &credentials::RecordSnapshot,
) -> Result<Option<String>, TokenError> {
    let flight = state.tokens.flight(account_id);
    let _one_refresh = flight.lock().await;
    // A refresh that finished while this caller waited wins here: its expiry
    // is later than the record this caller read.
    let Some(entry) = state.tokens.reconcile(account_id, record)? else {
        return Ok(unrefreshable_token(&record.record));
    };
    let now = state.tokens.now();
    if !entry.needs_refresh(now) {
        return Ok(Some(entry.access_token));
    }
    if let Some((until, kind, message)) = entry.cooldown.clone().filter(|(until, ..)| now < *until)
    {
        let _ = until;
        return if entry.still_valid(now) {
            Ok(Some(entry.access_token))
        } else {
            Err(entry.failure(kind, message))
        };
    }
    let config = serde_json::from_value::<ImapConfig>(record.record.clone()).ok();
    refresh(
        state,
        account_id,
        entry,
        now,
        config.as_ref(),
        record.generation,
    )
    .await
}

async fn refresh(
    state: &DaemonState,
    account_id: &str,
    entry: Entry,
    now: i64,
    config: Option<&ImapConfig>,
    generation: u64,
) -> Result<Option<String>, TokenError> {
    let grant = &entry.grant;
    // Network Activity shows the refresh as the account's, from a worker too.
    let request = state.oauth2.refresh_token(
        &grant.refresh_token,
        grant.provider.clone(),
        grant.custom_client_id.clone(),
        grant.tenant_id.clone(),
        grant.use_graph,
        grant.client_id.clone(),
    );
    let result = mailvault_core::net_activity::with_account(grant.email.clone(), request).await;
    #[cfg(test)]
    tests::before_refresh_publication(account_id);
    let failure = match result {
        Ok(tokens) if !tokens.access_token.is_empty() => {
            let token = tokens.access_token.clone();
            // The provider's lifetime counted on this store's clock (the core
            // stamps the system clock, which a debug test may have moved past).
            let expires_at = tokens.expires_at as i64 + (state.tokens.now() - now_ms());
            // Pooled IMAP sessions signed in with the old token would be
            // ended under a request once it expires (Outlook): sign in anew.
            if let Some(config) = config.filter(|c| !c.uses_graph() && !c.uses_jmap()) {
                state.imap_pool.retire_idle(config).await;
            }
            // Retiring sessions can await; publish only after it, then emit
            // under the same short cache critical section as invalidation.
            state.tokens.store_refresh(
                account_id,
                grant,
                tokens.access_token,
                tokens.refresh_token,
                expires_at,
                generation,
                &state.events,
            )?;
            info!("[oauth] refreshed the access token of {}", grant.email);
            return Ok(Some(token));
        }
        Ok(_) => "the refresh returned no token".to_string(),
        Err(e) => e,
    };
    let kind = if renewal_unanswered(&failure) {
        FailKind::Unanswered
    } else {
        FailKind::Refused
    };
    let message = scrub(&failure, &[&grant.refresh_token, &entry.access_token]);
    state
        .tokens
        .store_failure(account_id, kind, &message, generation)?;
    if entry.still_valid(now) {
        warn!("[oauth] could not refresh the token of {}: {message}; using the stored one, still valid", grant.email);
        return Ok(Some(entry.access_token));
    }
    warn!(
        "[oauth] the token of {} has expired and could not be refreshed: {message}",
        grant.email
    );
    Err(entry.failure(kind, message))
}

/// `config` (read with `record`) with the daemon's token in it. A failure
/// is the caller's to judge; its `fallback` is the expired token.
pub(crate) async fn fresh_config(
    state: &DaemonState,
    account_id: &str,
    mut config: ImapConfig,
    record: &credentials::RecordSnapshot,
) -> Result<ImapConfig, TokenError> {
    if !config.is_oauth2() {
        let _entries = state.tokens.entries();
        if record.generation != credentials::write_generation() {
            return Err(stale_snapshot());
        }
        return Ok(config);
    }
    if let Some(token) = for_record(state, account_id, record).await? {
        config.access_token = Some(token);
    }
    Ok(config)
}

/// The account's stored config with a fresh token: what the
/// `credentials::resolve_account_*` readers return, for a caller that sends
/// with it. A refresh that failed leaves the newest token held in it, as the
/// app did: the server's refusal is what the caller reports.
pub(crate) async fn resolve(
    state: &DaemonState,
    account_id: &str,
    read: Read,
) -> Result<ImapConfig, String> {
    let (config, record) = read_record(account_id, read).await?;
    Ok(
        match fresh_config(state, account_id, config.clone(), &record).await {
            Ok(fresh) => fresh,
            Err(TokenError {
                kind: FailKind::Unreadable,
                message,
                fallback: None,
            }) => return Err(message),
            Err(e) => {
                let mut stale = config;
                if e.fallback.is_some() {
                    stale.access_token = e.fallback;
                }
                stale
            }
        },
    )
}

#[cfg(test)]
pub(crate) fn record_read_finished_for_test(id: &str) {
    tests::record_read_finished(id);
}

#[cfg(test)]
pub(crate) struct TestRecordReadPause {
    id: String,
    release: Option<std::sync::mpsc::Sender<()>>,
    entered: std::sync::mpsc::Receiver<()>,
}
#[cfg(test)]
impl TestRecordReadPause {
    pub(crate) fn arm(id: &str) -> Self {
        let (release, gate) = std::sync::mpsc::channel();
        let (entered, notice) = std::sync::mpsc::channel();
        tests::install_record_pause(id, entered, gate);
        Self {
            id: id.into(),
            release: Some(release),
            entered: notice,
        }
    }
    pub(crate) fn wait(&self) {
        self.entered
            .recv_timeout(Duration::from_secs(5))
            .expect("stored snapshot captured");
    }
}
#[cfg(test)]
impl Drop for TestRecordReadPause {
    fn drop(&mut self) {
        self.release.take();
        tests::clear_record_pause(&self.id);
    }
}

#[cfg(test)]
pub(crate) static TEST_RECHECK_DONE: Mutex<Option<(usize, std::sync::mpsc::Sender<()>)>> =
    Mutex::new(None);

#[cfg(test)]
pub(crate) struct RecheckCompletion(std::sync::mpsc::Sender<()>);

#[cfg(test)]
impl Drop for RecheckCompletion {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

/// Consume before spawn, so cancellation before the first poll also settles
/// the scoped fixture's one-shot completion acknowledgement.
#[cfg(test)]
pub(crate) fn recheck_completion_for_test(state: &Arc<DaemonState>) -> Option<RecheckCompletion> {
    let mut hook = TEST_RECHECK_DONE.lock().unwrap_or_else(|e| e.into_inner());
    if hook
        .as_ref()
        .is_some_and(|(owner, _)| *owner == Arc::as_ptr(state) as usize)
    {
        hook.take().map(|(_, done)| RecheckCompletion(done))
    } else {
        None
    }
}

/// After the app wrote credentials: read the record of every account with a
/// refreshed pair not yet seen stored, quietly, so `unsaved` stops offering
/// what was saved.
pub(crate) async fn recheck_unsaved(state: &DaemonState) {
    for account_id in state.tokens.unsaved_ids() {
        if let Ok((_, record)) = read_record(&account_id, Read::Quiet).await {
            let flight = state.tokens.flight(&account_id);
            let _held = flight.lock().await;
            let _ = state.tokens.reconcile(&account_id, &record);
        }
    }
}

// ── Requests: the daemon's token over whatever the app sent ─────────────────

/// Params that carry a whole account, as an object or as its JSON text.
const ACCOUNT_PARAMS: [&str; 4] = ["account", "accountJson", "sourceAccount", "destAccount"];

/// A token `inject` put in a request, so a server refusing it can be noted.
pub(crate) struct Injected {
    account_id: String,
    token: String,
}

/// The daemon's token for `account_id`, when it holds one issued for `email`
/// (a request may name an id the store holds for another address).
async fn daemon_token(state: &DaemonState, account_id: &str, email: Option<&str>) -> Result<String, NoToken> {
    let token = match access_token(state, account_id, Read::Guarded).await {
        Ok(Some(token)) => token,
        Ok(None) => return Err(NoToken::SignIn),
        Err(TokenError { fallback: Some(token), .. }) => token,
        Err(TokenError { kind: FailKind::Unreadable, .. }) => return Err(NoToken::Keychain),
        Err(_) => return Err(NoToken::SignIn),
    };
    if let Some(email) = email.filter(|e| !e.is_empty()) {
        let held = state.tokens.email(account_id);
        // An entry exists for every refreshable account; a record without a
        // refresh token is checked against the record's own address below.
        let matches = match held {
            Some(held) => held.eq_ignore_ascii_case(email),
            None => read_record(account_id, Read::Quiet)
                .await
                .is_ok_and(|(config, _)| config.email.eq_ignore_ascii_case(email)),
        };
        if !matches {
            return Err(NoToken::SignIn);
        }
    }
    Ok(token)
}

/// A list batch binds the configuration and token from one stored record.
/// Reading a separate configuration after token resolution could name a later account edit.
async fn daemon_list_token(state: &DaemonState, account_id: &str, email: Option<&str>) -> Result<(String, Option<String>), NoToken> {
    let (config, record) = read_record(account_id, Read::Guarded).await.map_err(|_| NoToken::Keychain)?;
    if email.filter(|s| !s.is_empty()).is_some_and(|e| !config.email.eq_ignore_ascii_case(e)) {
        return Err(NoToken::SignIn);
    }
    let token = match for_record(state, account_id, &record).await {
        Ok(Some(token)) | Err(TokenError { fallback: Some(token), .. }) => token,
        Err(TokenError { kind: FailKind::Unreadable, .. }) => return Err(NoToken::Keychain),
        _ => return Err(NoToken::SignIn),
    };
    Ok((token, Some(mailvault_core::bulk_worker::origin_hash(&config))))
}

/// Why the daemon has no token for a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NoToken {
    /// No stored OAuth2 sign-in for this account and address (or one that
    /// was refused and has expired): the user signs in again.
    SignIn,
    /// The keychain did not answer (locked, a prompt nobody answered).
    Keychain,
}

impl NoToken {
    /// The error a request that needs a token gets: a stable code the app
    /// maps to its sign-in or keychain state (`oauthErrorState`), a catalog key
    /// (`errors.E_OAUTH_*`).
    fn message(self) -> &'static str {
        match self {
            NoToken::SignIn => "E_OAUTH_SIGN_IN_NEEDED: Sign in to this account again under Settings, Accounts.",
            NoToken::Keychain => {
                "E_OAUTH_KEYCHAIN_UNAVAILABLE: The keychain could not be read for this account's sign-in. Unlock it, then try again."
            }
        }
    }
}

/// The daemon's token into one account a request carries (`slot`, an object
/// or its JSON text), identified by its own `id` or else `fallback_id`.
async fn inject_account(state: &DaemonState, slot: &mut Value, fallback_id: Option<&str>) -> Option<Injected> {
    let as_text = slot.is_string();
    let mut account = match &*slot {
        Value::String(text) => serde_json::from_str::<Value>(text).ok()?,
        other => other.clone(),
    };
    if account.get("authType").and_then(Value::as_str) != Some("oauth2") {
        return None;
    }
    let own_id = account.get("id").and_then(Value::as_str).filter(|a| !a.is_empty()).map(str::to_owned);
    let account_id = own_id.or_else(|| fallback_id.map(str::to_owned))?;
    let email = account.get("email").and_then(Value::as_str).map(str::to_owned);
    let token = daemon_token(state, &account_id, email.as_deref()).await.ok()?;
    // A sign-in that just happened (Reconnect testing its new token before
    // saving it) carries a later expiry than anything held: it is newer than
    // the daemon's, the same rule `reconcile` applies to the store.
    let sent = account.get("oauth2AccessToken").and_then(Value::as_str).filter(|t| !t.is_empty());
    let sent_expiry = account.get("oauth2ExpiresAt").and_then(Value::as_f64).map(|v| v as i64);
    let held_expiry = state.tokens.expires_at(&account_id);
    if sent.is_some() && matches!((sent_expiry, held_expiry), (Some(sent), Some(held)) if sent > held) {
        return None;
    }
    account["oauth2AccessToken"] = json!(token);
    *slot = if as_text { Value::String(account.to_string()) } else { account };
    Some(Injected { account_id, token })
}

/// Put the daemon's own token into a request, over any the app sent: in each
/// OAuth2 account the params carry (`account` and the other `ACCOUNT_PARAMS`,
/// as an object or as JSON text, identified by its `id` or the request's
/// `accountId`; and `targets[].account`, a mail search's, by the target's
/// `accountId`), and as `accessToken` in a `graph_*` call naming `accountId`.
/// A token the app sent is kept only when the daemon has none for that
/// account (one being added, not stored yet). Old callers keep working.
///
/// A `graph_*` call that names its account and carries no token at all, when
/// the daemon has none either, is answered with why (`refusal`) instead of
/// going on to a bare "Missing accessToken".
pub(crate) async fn inject(state: &DaemonState, method: &str, params: &mut Value) -> Injection {
    let mut injected = Vec::new();
    // Persistence stores exactly the app-supplied records. Even extraneous
    // account-bearing params must not trigger a credential read or refresh.
    if method.starts_with("accounts.") || method.starts_with("credentials.") {
        return Injection {
            injected,
            refusal: None,
        };
    }
    let Some(obj) = params.as_object_mut() else {
        return Injection {
            injected,
            refusal: None,
        };
    };
    let request_account = obj
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty())
        .map(str::to_owned);
    for key in ACCOUNT_PARAMS {
        let names_request_account = key == "account" || key == "accountJson";
        let fallback = request_account.as_deref().filter(|_| names_request_account);
        if let Some(slot) = obj.get_mut(key) {
            injected.extend(inject_account(state, slot, fallback).await);
        }
    }
    if let Some(Value::Array(targets)) = obj.get_mut("targets") {
        for target in targets.iter_mut() {
            let target_account = target.get("accountId").and_then(Value::as_str).map(str::to_owned);
            if let Some(slot) = target.get_mut("account") {
                injected.extend(inject_account(state, slot, target_account.as_deref()).await);
            }
        }
    }
    let mut refusal = None;
    // `graph_allocate_uids` is the vault's uid ledger: no network, no token.
    if method.starts_with("graph_") && method != "graph_allocate_uids" {
        obj.remove("_nativeOriginHash");
        if let Some(account_id) = request_account {
            let email = obj.get("accountEmail").and_then(Value::as_str).map(str::to_owned);
            let resolved = if method == "graph_list_messages" {
                daemon_list_token(state, &account_id, email.as_deref()).await
            } else {
                daemon_token(state, &account_id, email.as_deref()).await.map(|token| (token, None))
            };
            match resolved {
                Ok((token, origin)) => {
                    if let Some(origin) = origin { obj.insert("_nativeOriginHash".into(), json!(origin)); }
                    obj.insert("accessToken".to_string(), json!(token));
                    injected.push(Injected { account_id, token });
                }
                Err(why) if obj.get("accessToken").and_then(Value::as_str).map_or(true, str::is_empty) => {
                    refusal = Some(why.message().to_string());
                }
                Err(_) => {}
            }
        }
    }
    Injection { injected, refusal }
}

/// What `inject` did to a request.
pub(crate) struct Injection {
    /// The tokens it put in, for `note_refusal` / `note_accepted`.
    pub(crate) injected: Vec<Injected>,
    /// Set when the request needs a token nobody has: the error to answer.
    pub(crate) refusal: Option<String>,
}

/// A request answered with a sign-in refusal: the tokens it carried are not
/// handed out again, the next use refreshes first.
pub(crate) fn note_refusal(state: &DaemonState, injected: &[Injected], error: &str) {
    let refused = error.contains("XOAUTH2 auth failed") || mailvault_core::graph::GraphClient::is_token_expired(error);
    if refused {
        for i in injected {
            state.tokens.rejected(&i.account_id, &i.token);
        }
    }
}

/// A request that went through with the tokens it carried.
pub(crate) fn note_accepted(state: &DaemonState, injected: &[Injected]) {
    for i in injected {
        state.tokens.accepted(&i.account_id, &i.token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::oauth2::{test_token_mock, test_token_posts};
    use mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID;

    // A trap at the actual credential-resolution entry, before either guarded
    // or quiet read. Registered only for the unique fake account under test.
    static CREDENTIAL_LOOKUPS: std::sync::LazyLock<
        Mutex<HashMap<String, Arc<std::sync::atomic::AtomicUsize>>>,
    > = std::sync::LazyLock::new(Default::default);
    pub(super) fn record_credential_lookup(account_id: &str) {
        if let Some(count) = CREDENTIAL_LOOKUPS.lock().unwrap().get(account_id) {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    struct LookupTrap(String);
    impl Drop for LookupTrap {
        fn drop(&mut self) {
            CREDENTIAL_LOOKUPS.lock().unwrap().remove(&self.0);
        }
    }
    fn lookup_trap(id: &str) -> (LookupTrap, Arc<std::sync::atomic::AtomicUsize>) {
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        CREDENTIAL_LOOKUPS
            .lock()
            .unwrap()
            .insert(id.into(), count.clone());
        (LookupTrap(id.into()), count)
    }

    type ReadHook = (
        String,
        std::sync::mpsc::Sender<()>,
        Option<std::sync::mpsc::Receiver<()>>,
    );
    static RECORD_READ_HOOK: Mutex<Option<ReadHook>> = Mutex::new(None);
    static PUBLICATION_HOOK: Mutex<Option<ReadHook>> = Mutex::new(None);
    static REFRESH_RESULT_HOOK: Mutex<Option<ReadHook>> = Mutex::new(None);

    fn run_read_hook(hook: &Mutex<Option<ReadHook>>, id: &str) {
        let taken = {
            let mut held = hook.lock().unwrap_or_else(|e| e.into_inner());
            if held.as_ref().is_some_and(|(owner, _, _)| owner == id) {
                held.take()
            } else {
                None
            }
        };
        if let Some((_, entered, gate)) = taken {
            let _ = entered.send(());
            if let Some(gate) = gate {
                let _ = gate.recv();
            }
        }
    }
    pub(super) fn install_record_pause(
        id: &str,
        entered: std::sync::mpsc::Sender<()>,
        gate: std::sync::mpsc::Receiver<()>,
    ) {
        *RECORD_READ_HOOK.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((id.into(), entered, Some(gate)));
    }
    pub(super) fn clear_record_pause(id: &str) {
        let mut hook = RECORD_READ_HOOK.lock().unwrap_or_else(|e| e.into_inner());
        if hook.as_ref().is_some_and(|(owner, _, _)| owner == id) {
            hook.take();
        }
    }
    pub(super) fn record_read_finished(id: &str) {
        run_read_hook(&RECORD_READ_HOOK, id);
    }
    pub(super) fn before_publication(id: &str) {
        run_read_hook(&PUBLICATION_HOOK, id);
    }
    pub(super) fn before_refresh_publication(id: &str) {
        run_read_hook(&REFRESH_RESULT_HOOK, id);
    }

    struct FreshRig {
        _dir: tempfile::TempDir,
        state: Arc<DaemonState>,
        releases: Vec<std::sync::mpsc::Sender<()>>,
        tasks: Vec<(tokio::task::JoinHandle<()>, std::sync::mpsc::Receiver<()>)>,
        write: Option<credentials::TestWritePause>,
        shared: Option<Arc<credentials::TestSharedBlobRead>>,
        shared_done: Option<std::sync::mpsc::Receiver<()>>,
        quiet_done: Option<std::sync::mpsc::Receiver<()>>,
        _restore: credentials::TestEnvRestore,
        _env: std::sync::MutexGuard<'static, ()>,
    }

    impl FreshRig {
        fn new(record: Value) -> Self {
            let env = credentials::test_env_lock()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let restore = credentials::TestEnvRestore::capture();
            let dir = tempfile::tempdir().unwrap();
            let state =
                DaemonState::for_test(dir.path().join("vault"), dir.path().to_path_buf(), true);
            store(&state, &[("g", &record)]);
            Self {
                _dir: dir,
                state,
                releases: vec![],
                tasks: vec![],
                write: None,
                shared: None,
                shared_done: None,
                quiet_done: None,
                _restore: restore,
                _env: env,
            }
        }
        fn spawn<T: Send + 'static>(
            &mut self,
            future: impl std::future::Future<Output = T> + Send + 'static,
        ) -> std::sync::mpsc::Receiver<T> {
            let (result, receiver) = std::sync::mpsc::channel();
            let (done, completion) = std::sync::mpsc::channel();
            let guard = credentials::TestTaskDone(done);
            let task = tokio::spawn(async move {
                let _guard = guard;
                let value = future.await;
                let _ = result.send(value);
            });
            self.tasks.push((task, completion));
            receiver
        }
        fn access(&mut self) -> std::sync::mpsc::Receiver<Result<Option<String>, TokenError>> {
            let state = Arc::clone(&self.state);
            self.spawn(async move { access_token(&state, "g", Read::Quiet).await })
        }
        fn request(
            &mut self,
            method: &'static str,
            params: Value,
        ) -> std::sync::mpsc::Receiver<crate::ipc::RpcResponse> {
            let state = Arc::clone(&self.state);
            self.spawn(async move {
                crate::server::handle_request_for_test(&state, method, params).await
            })
        }
        fn shared_pause(&mut self) -> std::sync::mpsc::Receiver<()> {
            let (release, gate) = std::sync::mpsc::channel();
            let (captured, read) = std::sync::mpsc::channel();
            let (finished, done) = std::sync::mpsc::channel();
            let control = Arc::new(credentials::TestSharedBlobRead {
                path: self.state.app_dir.join("credentials.json"),
                gate: Mutex::new(Some(gate)),
                captured: Mutex::new(Some(captured)),
                finished: Mutex::new(Some(finished)),
                joined: Mutex::new(None),
                starts: 0.into(),
                active: 0.into(),
                max_active: 0.into(),
            });
            *credentials::TEST_SHARED_BLOB_READ
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&control));
            self.shared = Some(control);
            self.shared_done = Some(done);
            self.releases.push(release);
            read
        }
        fn join_notice(&self) -> std::sync::mpsc::Receiver<()> {
            let (joined, notice) = std::sync::mpsc::channel();
            *self
                .shared
                .as_ref()
                .unwrap()
                .joined
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(joined);
            notice
        }
        fn hook(
            &mut self,
            target: &Mutex<Option<ReadHook>>,
            gated: bool,
        ) -> std::sync::mpsc::Receiver<()> {
            let (entered, notice) = std::sync::mpsc::channel();
            let gate = if gated {
                let (release, gate) = std::sync::mpsc::channel();
                self.releases.push(release);
                Some(gate)
            } else {
                None
            };
            *target.lock().unwrap_or_else(|e| e.into_inner()) = Some(("g".into(), entered, gate));
            notice
        }
        fn release_all(&mut self) {
            self.releases.clear();
        }
        fn quiet_notice(&mut self) {
            let (done, notice) = std::sync::mpsc::channel();
            *TEST_RECHECK_DONE.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((Arc::as_ptr(&self.state) as usize, done));
            self.quiet_done = Some(notice);
        }
        fn finish_quiet(&mut self) {
            recv(self.quiet_done.as_ref().unwrap());
            self.quiet_done.take();
        }
    }
    fn recv<T>(receiver: &std::sync::mpsc::Receiver<T>) -> T {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("synthetic task/barrier completion")
    }
    fn stale(result: &Result<Option<String>, TokenError>) -> bool {
        matches!(
            result,
            Err(TokenError {
                kind: FailKind::Unreadable,
                fallback: None,
                ..
            })
        )
    }
    fn fresh_grant(rt: &str, token: &str) -> Value {
        gmail(
            json!({"id":"g","oauth2RefreshToken":rt,"oauth2AccessToken":token,"oauth2ExpiresAt":now_ms()+3_600_000}),
        )
    }
    fn changed_request(record: &Value, delete: bool) -> (&'static str, Value) {
        if delete {
            ("credentials.delete", json!({"ids":["g"]}))
        } else {
            (
                "credentials.save",
                json!({"records":{"g":record.to_string()}}),
            )
        }
    }

    impl Drop for FreshRig {
        fn drop(&mut self) {
            self.release_all();
            self.write.take();
            for (_, done) in self.tasks.drain(..) {
                if done.recv_timeout(Duration::from_secs(5)).is_err() {
                    eprintln!("freshness test tasks did not drain");
                    std::process::abort();
                }
            }
            if let Some(done) = self.shared_done.take() {
                if self
                    .shared
                    .as_ref()
                    .is_some_and(|s| s.starts.load(std::sync::atomic::Ordering::SeqCst) > 0)
                    && done.recv_timeout(Duration::from_secs(5)).is_err()
                {
                    eprintln!("synthetic backend read did not drain");
                    std::process::abort();
                }
            }
            if let Some(done) = self.quiet_done.take() {
                let unused = {
                    let mut hook = TEST_RECHECK_DONE.lock().unwrap_or_else(|e| e.into_inner());
                    if hook
                        .as_ref()
                        .is_some_and(|(owner, _)| *owner == Arc::as_ptr(&self.state) as usize)
                    {
                        hook.take();
                        true
                    } else {
                        false
                    }
                };
                if !unused && done.recv_timeout(Duration::from_secs(5)).is_err() {
                    eprintln!("freshness quiet recheck did not drain");
                    std::process::abort();
                }
            }
            credentials::TEST_SHARED_BLOB_READ
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            RECORD_READ_HOOK
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            PUBLICATION_HOOK
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            REFRESH_RESULT_HOOK
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
        }
    }

    async fn post_completion_join(delete: bool) {
        use std::sync::atomic::Ordering::SeqCst;
        let old = fresh_grant("synthetic-old-grant", "synthetic-old-token");
        let new = fresh_grant("synthetic-new-grant", "synthetic-new-token");
        let mut rig = FreshRig::new(old);
        let captured = rig.shared_pause();
        rig.write = Some(credentials::TestWritePause::arm());
        let (method, params) = changed_request(&new, delete);
        let write = rig.request(method, params);
        rig.write.as_ref().unwrap().wait_until_entered();
        let timed = recv(&write);
        let old_reader = rig.access();
        recv(&captured);
        rig.write.as_mut().unwrap().finish();
        rig.write.take();
        let joined = rig.join_notice();
        let current = rig.access();
        recv(&joined);
        let starts_before_release = rig.shared.as_ref().unwrap().starts.load(SeqCst);
        let active_before_release = rig.shared.as_ref().unwrap().active.load(SeqCst);
        rig.release_all();
        let prior = recv(&old_reader);
        let answer = recv(&current);
        assert_eq!(timed.error.unwrap().message, "errors.keychainWriteFailed");
        assert_eq!(starts_before_release, 1);
        assert_eq!(active_before_release, 1);
        if delete {
            assert!(
                matches!(
                    answer,
                    Err(TokenError {
                        kind: FailKind::NoRecord,
                        ..
                    })
                ),
                "post-completion delete read used the pre-write grant"
            );
        } else {
            assert!(
                answer.ok().flatten().as_deref() == Some("synthetic-new-token"),
                "post-completion OAuth read used the pre-write grant"
            );
        }
        assert!(
            stale(&prior),
            "the earlier read must refuse after invalidation"
        );
        assert_eq!(rig.shared.as_ref().unwrap().starts.load(SeqCst), 2);
        assert_eq!(rig.shared.as_ref().unwrap().max_active.load(SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn post_completion_oauth_read_does_not_join_old_blob() {
        post_completion_join(false).await;
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn post_completion_delete_read_does_not_join_old_blob() {
        post_completion_join(true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn prewrite_reader_cannot_publish_after_invalidation() {
        for delete in [false, true] {
            let old = fresh_grant("synthetic-old-grant", "synthetic-old-token");
            let new = fresh_grant("synthetic-new-grant", "synthetic-new-token");
            let mut rig = FreshRig::new(old);
            let flight = rig.state.tokens.flight("g");
            let held = flight.lock().await;
            let read = rig.hook(&RECORD_READ_HOOK, false);
            let pending = rig.access();
            recv(&read);
            let (method, params) = changed_request(&new, delete);
            let reply = recv(&rig.request(method, params));
            drop(held);
            let answer = recv(&pending);
            assert!(reply.error.is_none());
            assert!(
                stale(&answer),
                "a pre-write reader re-trusted its old grant after completed invalidation"
            );
            let next = recv(&rig.access());
            if delete {
                assert!(matches!(
                    next,
                    Err(TokenError {
                        kind: FailKind::NoRecord,
                        ..
                    })
                ));
            } else {
                assert!(next.ok().flatten().as_deref() == Some("synthetic-new-token"));
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_does_not_fall_back_to_a_stale_config() {
        let mut rig = FreshRig::new(fresh_grant("synthetic-old-grant", "synthetic-old-token"));
        let read = rig.hook(&RECORD_READ_HOOK, true);
        let state = Arc::clone(&rig.state);
        let pending = rig.spawn(async move { resolve(&state, "g", Read::Quiet).await });
        recv(&read);
        let new = fresh_grant("synthetic-new-grant", "synthetic-new-token");
        assert!(
            recv(&rig.request("credentials.save", json!({"records":{"g":new.to_string()}})))
                .error
                .is_none()
        );
        rig.release_all();
        assert!(
            recv(&pending).is_err(),
            "resolve must not swallow stale unreadable into its old config"
        );
        assert!(recv(&rig.access()).ok().flatten().as_deref() == Some("synthetic-new-token"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn publication_fence_rejects_invalidation_before_entry_lock() {
        let mut rig = FreshRig::new(fresh_grant("synthetic-old-grant", "synthetic-old-token"));
        let reached = rig.hook(&PUBLICATION_HOOK, true);
        let pending = rig.access();
        recv(&reached);
        let new = fresh_grant("synthetic-new-grant", "synthetic-new-token");
        assert!(
            recv(&rig.request("credentials.save", json!({"records":{"g":new.to_string()}})))
                .error
                .is_none()
        );
        rig.release_all();
        let answer = recv(&pending);
        assert!(
            stale(&answer),
            "publication after invalidation must be refused under the entries lock"
        );
        assert!(!rig.state.tokens.has_trusted_token_for_test("g"));
        assert!(recv(&rig.access()).ok().flatten().as_deref() == Some("synthetic-new-token"));
        assert!(
            recv(&rig.request("credentials.delete", json!({"ids":["g"]})))
                .error
                .is_none()
        );
        assert!(
            !rig.state.tokens.has_trusted_token_for_test("g"),
            "publication first must then be invalidated"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_recheck_cannot_retrust_its_prewrite_record() {
        let mut old = fresh_grant("synthetic-old-grant", "synthetic-expired-token");
        old["oauth2ExpiresAt"] = json!(1);
        let mut rig = FreshRig::new(old);
        let _mock = test_token_mock(vec![granted(
            "synthetic-refreshed-token",
            Some("synthetic-rotated-refresh"),
        )]);
        assert!(recv(&rig.access()).is_ok());
        assert_eq!(rig.state.tokens.unsaved().len(), 1);
        let flight = rig.state.tokens.flight("g");
        let held = flight.lock().await;
        let read = rig.hook(&RECORD_READ_HOOK, false);
        let state = Arc::clone(&rig.state);
        let explicit = rig.spawn(async move { recheck_unsaved(&state).await });
        recv(&read);
        let newer_read = rig.hook(&RECORD_READ_HOOK, true);
        rig.quiet_notice();
        let new = fresh_grant("synthetic-new-grant", "synthetic-new-token");
        assert!(
            recv(&rig.request("credentials.save", json!({"records":{"g":new.to_string()}})))
                .error
                .is_none()
        );
        recv(&newer_read);
        drop(held);
        recv(&explicit);
        let trusted = rig.state.tokens.has_trusted_token_for_test("g");
        let unsaved = rig.state.tokens.unsaved().len();
        rig.release_all();
        rig.finish_quiet();
        assert!(
            !trusted,
            "an obsolete quiet recheck must leave the entry unchecked"
        );
        assert_eq!(unsaved, 1);
        assert!(recv(&rig.access()).ok().flatten().as_deref() == Some("synthetic-new-token"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn obsolete_refresh_result_cannot_publish_token_or_cooldown() {
        for granted_result in [true, false] {
            let mut old = fresh_grant("synthetic-old-grant", "synthetic-expired-token");
            old["oauth2ExpiresAt"] = json!(1);
            let mut rig = FreshRig::new(old);
            let response = if granted_result {
                granted(
                    "synthetic-obsolete-refresh",
                    Some("synthetic-obsolete-rotation"),
                )
            } else {
                (400, json!({"error":"invalid_grant"}).to_string())
            };
            let _mock = test_token_mock(vec![response]);
            let reached = rig.hook(&REFRESH_RESULT_HOOK, true);
            let pending = rig.access();
            recv(&reached);
            let mut events = rig.state.events.subscribe();
            let new = fresh_grant("synthetic-new-grant", "synthetic-new-token");
            assert!(recv(
                &rig.request("credentials.save", json!({"records":{"g":new.to_string()}}))
            )
            .error
            .is_none());
            rig.release_all();
            let answer = recv(&pending);
            assert!(
                stale(&answer),
                "an obsolete refresh completion must refuse without an old fallback"
            );
            assert!(rig.state.tokens.unsaved().is_empty());
            assert!(rig
                .state
                .tokens
                .entries()
                .get("g")
                .unwrap()
                .cooldown
                .is_none());
            let announced: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
                .filter_map(|line| mailvault_core::daemon_ipc::parse_event(&line))
                .filter(|(name, _)| name == REFRESHED_EVENT)
                .collect();
            assert!(announced.is_empty());
            assert_eq!(test_token_posts().len(), 1, "no internal retry");
            assert!(recv(&rig.access()).ok().flatten().as_deref() == Some("synthetic-new-token"));
        }
    }

    // Every test here takes `credentials::test_env_lock` first and the token
    // mock's lock second, the order every other test that takes both uses.

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-oauth-tokens-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    /// The credentials blob the app writes, in the debug file bypass.
    fn store(s: &Arc<DaemonState>, records: &[(&str, &Value)]) {
        let blob: HashMap<String, String> = records.iter().map(|(id, r)| (id.to_string(), r.to_string())).collect();
        let path = s.app_dir.join("credentials.json");
        std::fs::write(&path, serde_json::to_string(&blob).unwrap()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &path);
    }

    /// A Gmail record stamped with Thunderbird's client, `extra` merged in.
    fn gmail(extra: Value) -> Value {
        let mut record = json!({
            "id": "g1",
            "email": "me@gmail.test",
            "imapHost": "imap.gmail.com",
            "authType": "oauth2",
            "oauth2Provider": "google",
            "oauth2ClientId": GOOGLE_THUNDERBIRD_CLIENT_ID,
            "oauth2AccessToken": "at-stored-0001",
            "oauth2RefreshToken": "rt-stored-0001",
            "oauth2ExpiresAt": now_ms() - 60_000,
        });
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            record[k] = v;
        }
        record
    }

    fn granted(token: &str, refresh: Option<&str>) -> (u16, String) {
        let mut body = json!({"access_token": token, "expires_in": 3600});
        if let Some(rt) = refresh {
            body["refresh_token"] = json!(rt);
        }
        (200, body.to_string())
    }

    fn field(body: &str, key: &str) -> Option<String> {
        url::form_urlencoded::parse(body.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.to_string())
    }

    fn events(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>) -> Vec<(String, Value)> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|line| mailvault_core::daemon_ipc::parse_event(&line))
            .collect()
    }

    #[tokio::test]
    async fn a_token_good_past_the_margin_is_used_without_a_refresh() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(Vec::new());
        let s = st();
        store(
            &s,
            &[(
                "g1",
                &gmail(json!({"oauth2ExpiresAt": now_ms() + 3_600_000})),
            )],
        );

        let token = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(token.ok().flatten().as_deref(), Some("at-stored-0001"));
        assert!(test_token_posts().is_empty(), "no refresh for a good token");
    }

    #[tokio::test]
    async fn credential_store_namespace_does_not_read_or_refresh_tokens() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(v) => std::env::set_var("MAILVAULT_TEST_CREDENTIALS", v),
                    None => std::env::remove_var("MAILVAULT_TEST_CREDENTIALS"),
                }
            }
        }
        let _restore = Restore(std::env::var_os("MAILVAULT_TEST_CREDENTIALS"));
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("synthetic-control-token", None)]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({})))]);
        let account = json!({"id":"g1", "email":"me@gmail.test", "authType":"oauth2"});
        let (_trap, lookups) = lookup_trap("g1");
        let original = json!({"records":{}, "account":account, "accountId":"g1"});
        let mut params = original.clone();
        let injected = inject(&s, "credentials.save", &mut params).await;
        assert!(
            injected.injected.is_empty(),
            "credential writes must not receive native tokens"
        );
        assert_eq!(params, original);
        assert_eq!(
            lookups.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "credential writes must not read a grant"
        );
        assert!(
            test_token_posts().is_empty(),
            "credential writes must not refresh an expired stored grant"
        );
        let mut control = json!({"account":account});
        assert_eq!(
            inject(&s, "imap_get_mailboxes", &mut control)
                .await
                .injected
                .len(),
            1
        );
        assert_eq!(test_token_posts().len(), 1);
    }

    /// The record's own refresh token and Google client go to the token
    /// endpoint; the app hears an account id and nothing else.
    #[tokio::test]
    async fn an_expired_token_is_refreshed_with_the_records_grant_and_announced() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("at-fresh-0002", None)]);
        let s = st();
        let mut rx = s.events.subscribe();
        store(&s, &[("g1", &gmail(json!({})))]);

        let token = access_token(&s, "g1", Read::Quiet).await;
        let again = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let posts = test_token_posts();

        assert_eq!(token.ok().flatten().as_deref(), Some("at-fresh-0002"));
        assert_eq!(again.ok().flatten().as_deref(), Some("at-fresh-0002"), "held, not refreshed twice");
        assert_eq!(posts.len(), 1, "{posts:?}");
        assert_eq!(field(&posts[0], "grant_type").as_deref(), Some("refresh_token"));
        assert_eq!(field(&posts[0], "refresh_token").as_deref(), Some("rt-stored-0001"));
        assert_eq!(field(&posts[0], "client_id").as_deref(), Some(GOOGLE_THUNDERBIRD_CLIENT_ID));
        assert_eq!(events(&mut rx), vec![(REFRESHED_EVENT.to_string(), json!({"accountId": "g1"}))]);
    }

    #[tokio::test]
    async fn a_token_inside_the_margin_is_refreshed() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("at-fresh-0003", None)]);
        let s = st();
        store(
            &s,
            &[("g1", &gmail(json!({"oauth2ExpiresAt": now_ms() + 120_000})))],
        );

        let token = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(token.ok().flatten().as_deref(), Some("at-fresh-0003"));
        assert_eq!(test_token_posts().len(), 1);
    }

    /// As the app: a password account, an OAuth2 one without a refresh token
    /// and one whose record never gave an expiry are not refreshed. The two
    /// OAuth2 ones get their stored token.
    #[tokio::test]
    async fn accounts_the_daemon_does_not_manage_are_left_alone() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(Vec::new());
        let s = st();
        let password = json!({"id": "p1", "email": "p@x.test", "imapHost": "imap.x.test", "authType": "password", "password": "pw"});
        let no_refresh = gmail(json!({"id": "n1", "oauth2RefreshToken": ""}));
        let mut no_expiry = gmail(json!({"id": "e1"}));
        no_expiry.as_object_mut().unwrap().remove("oauth2ExpiresAt");
        store(&s, &[("p1", &password), ("n1", &no_refresh), ("e1", &no_expiry)]);

        let p = access_token(&s, "p1", Read::Quiet).await;
        let n = access_token(&s, "n1", Read::Quiet).await;
        let e = access_token(&s, "e1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert!(matches!(p, Ok(None)), "password account");
        assert_eq!(n.ok().flatten().as_deref(), Some("at-stored-0001"), "no refresh token");
        assert_eq!(e.ok().flatten().as_deref(), Some("at-stored-0001"), "no expiry on record");
        assert!(test_token_posts().is_empty());
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_refresh() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![
            granted("at-fresh-0004", None),
            granted("at-second-0004", None),
        ]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({})))]);

        let calls = (0..8).map(|_| access_token(&s, "g1", Read::Quiet));
        let tokens = futures::future::join_all(calls).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(test_token_posts().len(), 1, "one refresh for eight callers");
        for token in tokens {
            assert_eq!(token.ok().flatten().as_deref(), Some("at-fresh-0004"));
        }
    }

    /// A provider that echoes the refresh token back in its error text: no
    /// token reaches the error, an event or a log line. The expired token is
    /// the error's fallback, for the server's own refusal to reach the user.
    #[tokio::test]
    async fn a_refused_refresh_never_carries_a_token_into_the_error_an_event_or_a_log() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let logs = crate::events::captured_logs();
        let echo = json!({"error": "invalid_grant", "error_description": "Bad grant rt-stored-0001 for at-stored-0001"});
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![(400, echo.to_string())]);
        let s = st();
        let mut rx = s.events.subscribe();
        store(&s, &[("g1", &gmail(json!({})))]);

        let failed = access_token(&s, "g1", Read::Quiet).await.expect_err("an expired token that was refused");
        let again = access_token(&s, "g1", Read::Quiet).await.expect_err("still refused");
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(failed.kind, FailKind::Refused);
        assert!(failed.message.contains("invalid_grant"), "{}", failed.message);
        for secret in ["rt-stored-0001", "at-stored-0001"] {
            assert!(!failed.message.contains(secret), "{}", failed.message);
            assert!(!again.message.contains(secret), "{}", again.message);
            let logged = String::from_utf8_lossy(&logs.lock().unwrap_or_else(|p| p.into_inner())).to_string();
            assert!(!logged.contains(secret), "a token reached the log");
        }
        assert!(!failed.message.contains('\u{2014}'), "{}", failed.message);
        assert_eq!(failed.fallback.as_deref(), Some("at-stored-0001"));
        assert!(events(&mut rx).is_empty(), "nothing announced for a failure");
        assert_eq!(test_token_posts().len(), 1, "a refusal is not retried at once");
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_a_still_valid_token_and_does_not_retry_at_once() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![
            (503, "Service Unavailable".to_string()),
            granted("at-late-0005", None),
        ]);
        let s = st();
        store(
            &s,
            &[("g1", &gmail(json!({"oauth2ExpiresAt": now_ms() + 120_000})))],
        );

        let first = access_token(&s, "g1", Read::Quiet).await;
        let second = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(first.ok().flatten().as_deref(), Some("at-stored-0001"));
        assert_eq!(second.ok().flatten().as_deref(), Some("at-stored-0001"));
        assert_eq!(test_token_posts().len(), 1, "no second round trip inside the cooldown");
    }

    /// The app writes its whole blob from its own copy, which still holds the
    /// token the daemon replaced: that write must not roll the token back.
    #[tokio::test]
    async fn a_stale_stored_record_does_not_roll_back_a_refreshed_token() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![
            granted("at-fresh-0006", None),
            granted("at-wrong-0006", None),
        ]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({})))]);

        let refreshed = access_token(&s, "g1", Read::Quiet).await;
        s.tokens.credentials_changed();
        let after_write = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(refreshed.ok().flatten().as_deref(), Some("at-fresh-0006"));
        assert_eq!(after_write.ok().flatten().as_deref(), Some("at-fresh-0006"));
        assert_eq!(test_token_posts().len(), 1);
    }

    /// A reconnect stores a new pair with a later expiry: it replaces the
    /// held one, and the next refresh posts the NEW refresh token with the
    /// record's client, never the one an earlier refresh rotated in.
    #[tokio::test]
    async fn a_new_sign_in_replaces_the_held_token_and_its_grant() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![
            granted("at-fresh-0007", Some("rt-rotated-0007")),
            granted("at-after-0007", None),
        ]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({})))]);
        let _ = access_token(&s, "g1", Read::Quiet).await;

        let reconnect = gmail(json!({
            "oauth2AccessToken": "at-signin-0007",
            "oauth2RefreshToken": "rt-signin-0007",
            "oauth2ExpiresAt": now_ms() + 3_700_000,
        }));
        store(&s, &[("g1", &reconnect)]);
        s.tokens.credentials_changed();
        let signed_in = access_token(&s, "g1", Read::Quiet).await;
        s.tokens.rejected("g1", "at-signin-0007");
        let after_rejection = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let posts = test_token_posts();

        assert_eq!(signed_in.ok().flatten().as_deref(), Some("at-signin-0007"));
        assert_eq!(after_rejection.ok().flatten().as_deref(), Some("at-after-0007"));
        assert_eq!(posts.len(), 2, "{posts:?}");
        assert_eq!(field(&posts[1], "refresh_token").as_deref(), Some("rt-signin-0007"));
        assert_eq!(field(&posts[1], "client_id").as_deref(), Some(GOOGLE_THUNDERBIRD_CLIENT_ID));
    }

    /// The pair is offered for the app to save until a read of the stored
    /// record shows it saved: a save that failed is offered again.
    #[tokio::test]
    async fn a_refreshed_pair_is_offered_until_the_stored_record_shows_it() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("at-fresh-0008", Some("rt-rotated-0008"))]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({})))]);
        let _ = access_token(&s, "g1", Read::Quiet).await;

        let offered = s.tokens.unsaved();
        recheck_unsaved(&s).await;
        let after_failed_save = s.tokens.unsaved();
        let expires_at = offered.first().map(|o| o["expiresAt"].clone()).unwrap_or(Value::Null);
        store(&s, &[("g1", &gmail(json!({
            "oauth2AccessToken": "at-fresh-0008",
            "oauth2RefreshToken": "rt-rotated-0008",
            "oauth2ExpiresAt": expires_at,
        })))]);
        s.tokens.credentials_changed();
        recheck_unsaved(&s).await;
        let after_save = s.tokens.unsaved();
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(offered.len(), 1, "{offered:?}");
        let mut keys: Vec<&String> = offered[0].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["accessToken", "accountId", "chain", "expiresAt", "refreshToken"], "never the client id");
        assert_eq!(offered[0]["accountId"], json!("g1"));
        assert_eq!(offered[0]["accessToken"], json!("at-fresh-0008"));
        assert_eq!(offered[0]["refreshToken"], json!("rt-rotated-0008"));
        assert_eq!(after_failed_save.len(), 1, "the record does not show it yet");
        assert!(after_save.is_empty(), "{after_save:?}");
    }

    // ── requests ────────────────────────────────────────────────────────────

    /// Every place a request carries an OAuth2 token for a stored account
    /// gets the daemon's: an account object, an account as JSON text, and a
    /// Graph call's `accessToken` (added when the app sent none).
    #[tokio::test]
    async fn a_request_carries_the_daemons_token_not_the_one_the_app_sent() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("at-fresh-0009", None)]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({})))]);
        let account = json!({"id": "g1", "email": "me@gmail.test", "authType": "oauth2", "oauth2AccessToken": "from-the-app"});

        let mut object = json!({"account": account, "mailbox": "INBOX"});
        let mut text = json!({"accountId": "g1", "accountJson": account.to_string()});
        let mut graph = json!({"accountId": "g1", "folderId": "f"});
        let mut graph_old = json!({"accountId": "g1", "accessToken": "from-the-app"});
        inject(&s, "imap_get_emails", &mut object).await;
        inject(&s, "backup_run_account", &mut text).await;
        inject(&s, "graph_list_messages", &mut graph).await;
        inject(&s, "graph_list_folders", &mut graph_old).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(object["account"]["oauth2AccessToken"], json!("at-fresh-0009"));
        assert_eq!(object["mailbox"], json!("INBOX"), "nothing else touched");
        let parsed: Value = serde_json::from_str(text["accountJson"].as_str().unwrap()).unwrap();
        assert_eq!(parsed["oauth2AccessToken"], json!("at-fresh-0009"));
        assert_eq!(graph["accessToken"], json!("at-fresh-0009"));
        assert_eq!(graph_old["accessToken"], json!("at-fresh-0009"));
        assert_eq!(test_token_posts().len(), 1);
    }

    /// The app's token stays where the daemon has none of its own: an
    /// account being added (not stored yet), a stored id that belongs to
    /// another address, a password account, a migration account with no id,
    /// and a non-Graph call's bare `accessToken`.
    #[tokio::test]
    async fn the_apps_token_is_kept_only_where_the_daemon_has_none() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(Vec::new());
        let s = st();
        let password = json!({"id": "p1", "email": "p@x.test", "imapHost": "imap.x.test", "authType": "password", "password": "pw"});
        store(&s, &[("g1", &gmail(json!({"oauth2ExpiresAt": now_ms() + 3_600_000}))), ("p1", &password)]);
        let oauth = |id: Value, email: &str| json!({"id": id, "email": email, "authType": "oauth2", "oauth2AccessToken": "from-the-app"});

        let mut new_account = json!({"account": oauth(json!("not-stored"), "new@gmail.test")});
        let mut other_address = json!({"account": oauth(json!("g1"), "someone-else@gmail.test")});
        let mut password_account = json!({"account": {"id": "p1", "email": "p@x.test", "authType": "password", "password": "pw"}});
        let mut no_id = json!({"sourceAccount": oauth(Value::Null, "me@gmail.test").to_string()});
        let mut not_graph = json!({"accountId": "g1", "accessToken": "from-the-app"});
        let injected = [
            inject(&s, "imap_test_connection", &mut new_account).await.injected.len(),
            inject(&s, "imap_get_mailboxes", &mut other_address).await.injected.len(),
            inject(&s, "imap_get_mailboxes", &mut password_account).await.injected.len(),
            inject(&s, "start_migration", &mut no_id).await.injected.len(),
            inject(&s, "abd.set_token", &mut not_graph).await.injected.len(),
        ];
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(injected, [0, 0, 0, 0, 0]);
        assert_eq!(new_account["account"]["oauth2AccessToken"], json!("from-the-app"));
        assert_eq!(other_address["account"]["oauth2AccessToken"], json!("from-the-app"));
        assert_eq!(password_account["account"]["password"], json!("pw"));
        assert!(no_id["sourceAccount"].as_str().unwrap().contains("from-the-app"));
        assert_eq!(not_graph["accessToken"], json!("from-the-app"));
    }

    /// A mail search carries one account per target, named by the target's
    /// `accountId`: each gets its own account's token.
    #[tokio::test]
    async fn every_mail_search_target_carries_its_own_accounts_token() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("at-search-0012", None)]);
        let s = st();
        let password = json!({"id": "p1", "email": "p@x.test", "imapHost": "imap.x.test", "authType": "password", "password": "pw"});
        store(&s, &[("g1", &gmail(json!({}))), ("p1", &password)]);
        let mut params = json!({"searchId": "s1", "targets": [
            {"accountId": "g1", "account": {"email": "me@gmail.test", "authType": "oauth2", "oauth2AccessToken": "from-the-app"}},
            {"accountId": "p1", "account": {"email": "p@x.test", "authType": "password", "password": "pw"}},
            {"accountId": "g1", "account": null},
        ]});

        let injected = inject(&s, "mail_search_start", &mut params).await.injected;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(injected.len(), 1);
        assert_eq!(params["targets"][0]["account"]["oauth2AccessToken"], json!("at-search-0012"));
        assert_eq!(params["targets"][1]["account"]["password"], json!("pw"));
        assert!(params["targets"][2]["account"].is_null());
    }

    /// Reconnect tests the token it just got before saving it: that one is
    /// newer than the daemon's (a later expiry) and goes out as sent.
    #[tokio::test]
    async fn a_new_sign_in_still_being_tested_keeps_its_own_token() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(Vec::new());
        let s = st();
        store(
            &s,
            &[(
                "g1",
                &gmail(json!({"oauth2ExpiresAt": now_ms() + 3_000_000})),
            )],
        );
        let account = |token: &str, expires: i64| {
            json!({"account": {
                "id": "g1", "email": "me@gmail.test", "authType": "oauth2", "oauth2AccessToken": token, "oauth2ExpiresAt": expires,
            }})
        };

        let mut reconnect = account("at-just-signed-in", now_ms() + 3_600_000);
        let mut stale = account("at-older-copy", now_ms() + 1_000_000);
        inject(&s, "imap_test_connection", &mut reconnect).await;
        inject(&s, "imap_get_mailboxes", &mut stale).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(reconnect["account"]["oauth2AccessToken"], json!("at-just-signed-in"));
        assert_eq!(stale["account"]["oauth2AccessToken"], json!("at-stored-0001"));
    }

    /// A server that refuses the daemon's token: the next request refreshes
    /// first instead of sending the refused token again.
    #[tokio::test]
    async fn a_token_a_server_refused_is_refreshed_before_the_next_request() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("at-renewed-0010", None)]);
        let s = st();
        store(
            &s,
            &[(
                "g1",
                &gmail(json!({"oauth2ExpiresAt": now_ms() + 3_600_000})),
            )],
        );
        let request =
            || json!({"account": {"id": "g1", "email": "me@gmail.test", "authType": "oauth2"}});

        let mut first = request();
        let injected = inject(&s, "imap_get_mailboxes", &mut first).await.injected;
        note_refusal(&s, &injected, "Login failed for me@gmail.test: something else");
        let mut unrelated = request();
        inject(&s, "imap_get_mailboxes", &mut unrelated).await;
        note_refusal(&s, &injected, "XOAUTH2 auth failed for me@gmail.test: [AUTHENTICATIONFAILED]");
        let mut second = request();
        inject(&s, "imap_get_mailboxes", &mut second).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(first["account"]["oauth2AccessToken"], json!("at-stored-0001"));
        assert_eq!(unrelated["account"]["oauth2AccessToken"], json!("at-stored-0001"), "only a sign-in refusal counts");
        assert_eq!(second["account"]["oauth2AccessToken"], json!("at-renewed-0010"));
        assert_eq!(test_token_posts().len(), 1);
    }

    /// Through the RPC layer: a Graph call that names only its account goes
    /// out with the daemon's fresh token, and the app can take the new pair
    /// to save and say it saved it.
    #[tokio::test]
    async fn a_graph_call_naming_only_its_account_is_sent_with_a_fresh_token() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _graph = crate::handlers::graph::test_graph_mock_with(vec![(200, "{}".to_string())]);
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("at-graph-0011", Some("rt-graph-0011"))]);
        let s = st();
        let outlook = json!({
            "id": "o1", "email": "me@outlook.test", "imapHost": "outlook.office365.com", "authType": "oauth2",
            "oauth2Provider": "microsoft", "oauth2Transport": "graph",
            "oauth2AccessToken": "at-old-0011", "oauth2RefreshToken": "rt-old-0011", "oauth2ExpiresAt": 1_000_000_000_000i64,
        });
        store(&s, &[("o1", &outlook)]);

        let listed = crate::server::handle_request_for_test(&s, "graph_set_read", json!({"accountId": "o1", "messageId": "m1", "isRead": true})).await;
        let taken = crate::server::handle_request_for_test(&s, "oauth2.take_refreshed", json!({})).await;
        let changed = crate::server::handle_request_for_test(&s, "oauth2.credentials_changed", json!({})).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let requests = crate::handlers::graph::test_graph_requests();
        let posts = test_token_posts();

        assert!(listed.error.is_none(), "{:?}", listed.error);
        assert_eq!(requests.len(), 1, "{requests:?}");
        assert_eq!(requests[0].headers.get("authorization").map(String::as_str), Some("Bearer at-graph-0011"));
        assert!(field(&posts[0], "scope").is_some_and(|sc| sc.contains("Mail.ReadWrite")), "Graph scopes: {posts:?}");
        let tokens = taken.result.expect("take_refreshed")["tokens"].clone();
        assert_eq!(tokens, json!([{
            "accountId": "o1", "accessToken": "at-graph-0011", "refreshToken": "rt-graph-0011",
            "expiresAt": tokens[0]["expiresAt"], "chain": tokens[0]["chain"],
        }]));
        assert_eq!(tokens[0]["chain"].as_array().map(Vec::len), Some(2), "the record's refresh token and the rotated one");
        assert_eq!(changed.result, Some(json!({"ok": true})));
    }

    // ── review fixes ────────────────────────────────────────────────────────

    /// A Reconnect is a new grant: it replaces the held entry even when its
    /// token expires before the held one (Microsoft's lifetimes vary), the
    /// held pair of the old grant is no longer offered, and the next refresh
    /// posts the new refresh token with the new grant's client.
    #[tokio::test]
    async fn a_new_grant_replaces_the_held_entry_even_with_an_earlier_expiry() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![
            granted("at-a-fresh-0013", Some("rt-a-rotated-0013")),
            granted("at-b-fresh-0013", None),
        ]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({})))]);
        let _ = access_token(&s, "g1", Read::Quiet).await;

        let reconnect = gmail(json!({
            "oauth2AccessToken": "at-b-signin-0013",
            "oauth2RefreshToken": "rt-b-0013",
            "oauth2ExpiresAt": now_ms() + 1_800_000,
        }));
        store(&s, &[("g1", &reconnect)]);
        s.tokens.credentials_changed();
        let signed_in = access_token(&s, "g1", Read::Quiet).await;
        let offered = s.tokens.unsaved();
        s.tokens.rejected("g1", "at-b-signin-0013");
        let renewed = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let posts = test_token_posts();

        assert_eq!(signed_in.ok().flatten().as_deref(), Some("at-b-signin-0013"));
        assert!(offered.is_empty(), "the old grant's pair must not be saved over the sign-in: {}", offered.len());
        assert_eq!(renewed.ok().flatten().as_deref(), Some("at-b-fresh-0013"));
        assert_eq!(posts.len(), 2, "{}", posts.len());
        assert_eq!(field(&posts[1], "refresh_token").as_deref(), Some("rt-b-0013"));
        assert_eq!(field(&posts[1], "client_id").as_deref(), Some(GOOGLE_THUNDERBIRD_CLIENT_ID));
    }

    /// A Reconnect that moves an Outlook account from IMAP to Graph refreshes
    /// with Graph's scopes from then on, though its token expires first.
    #[tokio::test]
    async fn a_reconnect_from_imap_to_graph_refreshes_with_graph_scopes() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![
            granted("at-imap-0014", None),
            granted("at-graph-0014", None),
        ]);
        let s = st();
        let outlook = |extra: Value| {
            let mut r = json!({
                "id": "o1", "email": "me@outlook.test", "imapHost": "outlook.office365.com", "authType": "oauth2",
                "oauth2Provider": "microsoft", "oauth2AccessToken": "at-old-0014", "oauth2RefreshToken": "rt-old-0014",
                "oauth2ExpiresAt": now_ms() - 60_000,
            });
            for (k, v) in extra.as_object().cloned().unwrap_or_default() {
                r[k] = v;
            }
            r
        };
        store(&s, &[("o1", &outlook(json!({})))]);
        let _ = access_token(&s, "o1", Read::Quiet).await;
        store(&s, &[("o1", &outlook(json!({
            "oauth2Transport": "graph", "oauth2AccessToken": "at-graph-signin-0014",
            "oauth2RefreshToken": "rt-graph-0014", "oauth2ExpiresAt": now_ms() + 1_800_000,
        })))]);
        s.tokens.credentials_changed();
        let signed_in = access_token(&s, "o1", Read::Quiet).await;
        s.tokens.rejected("o1", "at-graph-signin-0014");
        let _ = access_token(&s, "o1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let posts = test_token_posts();

        assert_eq!(signed_in.ok().flatten().as_deref(), Some("at-graph-signin-0014"));
        assert_eq!(posts.len(), 2, "{}", posts.len());
        let scope = field(&posts[1], "scope").unwrap_or_default();
        assert!(scope.contains("Mail.ReadWrite") && !scope.contains("IMAP"), "{scope}");
        assert_eq!(field(&posts[1], "refresh_token").as_deref(), Some("rt-graph-0014"));
    }

    /// The app's stale write after a refresh that rotated the refresh token is
    /// still the same grant: the held, newer pair stays.
    #[tokio::test]
    async fn a_stale_write_after_a_rotation_keeps_the_held_pair() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![
            granted("at-rotated-0015", Some("rt-rotated-0015")),
            granted("at-wrong-0015", None),
        ]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({})))]);
        let _ = access_token(&s, "g1", Read::Quiet).await;
        s.tokens.credentials_changed();
        let after_write = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(after_write.ok().flatten().as_deref(), Some("at-rotated-0015"));
        assert_eq!(test_token_posts().len(), 1);
        assert_eq!(s.tokens.unsaved().len(), 1, "still offered for the app to save");
    }

    /// A server that refuses a token that is valid (IMAP turned off for the
    /// account, a Graph scope it lacks) must not cost a token round trip per
    /// request: one refresh, then none for at least a minute.
    #[tokio::test]
    async fn a_server_refusing_valid_tokens_gets_at_most_one_refresh_a_minute() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let answers = (0..200)
            .map(|i| granted(&format!("at-loop-{i:04}"), None))
            .collect();
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(answers);
        let s = st();
        store(
            &s,
            &[(
                "g1",
                &gmail(json!({"oauth2ExpiresAt": now_ms() + 3_600_000})),
            )],
        );

        for _ in 0..200 {
            let mut request = json!({"account": {"id": "g1", "email": "me@gmail.test", "authType": "oauth2"}});
            let injected = inject(&s, "imap_get_mailboxes", &mut request).await.injected;
            note_refusal(&s, &injected, "XOAUTH2 auth failed for me@gmail.test: [AUTHENTICATIONFAILED]");
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        let posts = test_token_posts().len();
        assert!(posts <= 1, "{posts} refreshes for 200 refused requests");
    }

    /// A Graph call naming an account the daemon has no token for says why,
    /// with a code the app turns into its sign-in or keychain state, instead
    /// of "Missing accessToken".
    #[tokio::test]
    async fn a_graph_call_without_a_token_says_whether_to_sign_in_or_unlock() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(Vec::new());
        let s = st();
        let password = json!({"id": "p1", "email": "p@x.test", "imapHost": "imap.x.test", "authType": "password", "password": "pw"});
        store(&s, &[("p1", &password)]);
        let call = json!({"accountId": "o9", "accountEmail": "o9@outlook.test", "messageId": "m1", "isRead": true});

        let no_record = crate::server::handle_request_for_test(&s, "graph_set_read", call.clone()).await;
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", s.app_dir.join("not-there.json"));
        let unreadable = crate::server::handle_request_for_test(&s, "graph_set_read", call).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        let message = |r: &crate::ipc::RpcResponse| r.error.as_ref().map(|e| e.message.clone()).unwrap_or_default();
        assert!(message(&no_record).starts_with("E_OAUTH_SIGN_IN_NEEDED:"), "{}", message(&no_record));
        assert!(message(&unreadable).starts_with("E_OAUTH_KEYCHAIN_UNAVAILABLE:"), "{}", message(&unreadable));
    }

    /// The pairs offered to the app name the grants they belong to, by a
    /// fingerprint the app computes the same way (`grantFingerprint`), so it
    /// never writes one grant's pair over another's sign-in.
    #[tokio::test]
    async fn an_offered_pair_names_its_grant_by_fingerprint() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(vec![granted("at-fp-0016", Some("rt-fp-rotated-0016"))]);
        let s = st();
        let record = json!({
            "id": "o1", "email": "me@outlook.test", "imapHost": "outlook.office365.com", "authType": "oauth2",
            "oauth2Provider": "microsoft", "oauth2Transport": "graph", "oauth2ClientId": "cid-x", "oauth2TenantId": "tid-x",
            "oauth2AccessToken": "at-old-0016", "oauth2RefreshToken": "rt-x", "oauth2ExpiresAt": now_ms() - 60_000,
        });
        store(&s, &[("o1", &record)]);
        let _ = access_token(&s, "o1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        let offered = s.tokens.unsaved();
        assert_eq!(offered.len(), 1);
        let chain = offered[0]["chain"].as_array().cloned().unwrap_or_default();
        assert!(chain.contains(&json!("7cb5dadde1643c0110dc129996d0d6278fb0844eb6b2e801d1db96af59d65734")), "{chain:?}");
        assert!(!offered[0].to_string().contains("cid-x"), "no client id is handed over");
    }
    #[tokio::test]
    async fn backup_controls_reject_account_payloads_before_credentials() {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock(
            (0..20)
                .map(|_| granted("at-backup-control-trap", None))
                .collect(),
        );
        let dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(dir.path().join("vault"), dir.path().join("app"), true);
        std::fs::create_dir_all(&s.app_dir).unwrap();
        let account = gmail(json!({"id":"backup-control-trap","email":"fake@gmail.test"}));
        store(&s, &[("backup-control-trap", &account)]);
        for method in [
            "backup.run_now",
            "backup.cancel",
            "backup.stop",
            "backup.schedule.status",
        ] {
            let (_trap, lookups) = lookup_trap("backup-control-trap");
            let before = test_token_posts().len();
            let response=crate::server::handle_request_for_test(&s,method,json!({"accountId":"backup-control-trap","requestId":"control","accountJson":account.to_string()})).await;
            assert_eq!(response.error.unwrap().message, "errors.settingsInvalid");
            assert_eq!(
                lookups.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "{method} resolved rejected credentials"
            );
            assert_eq!(
                test_token_posts().len(),
                before,
                "{method} refreshed rejected credentials"
            );
        }
    }

    async fn compose_prep_rejected_fields(method: &str) {
        let _env = credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore_env = credentials::TestEnvRestore::capture();
        let _mock = test_token_mock((0..20).map(|_| granted("at-prep-trap", None)).collect());
        let logs = crate::events::captured_logs();
        let mut observed = Vec::new();
        for kind in if method == "compose.check" {
            vec!["check"]
        } else {
            vec!["message", "mailto"]
        } {
            for field in [
                "account",
                "accountJson",
                "sourceAccount",
                "destAccount",
                "targets",
            ] {
                let dir = tempfile::tempdir().unwrap();
                std::fs::create_dir_all(dir.path().join("app")).unwrap();
                std::fs::create_dir_all(dir.path().join("vault")).unwrap();
                let s =
                    DaemonState::for_test(dir.path().join("vault"), dir.path().join("app"), true);
                let record = gmail(json!({"id":"compose-prep-oauth-trap","email":"me@gmail.test"}));
                store(&s, &[("compose-prep-oauth-trap", &record)]);
                std::fs::write(
                    s.app_dir.join("accounts.json"),
                    json!([{"id":"compose-prep-oauth-trap","email":"me@gmail.test"}]).to_string(),
                )
                .unwrap();
                std::fs::write(
                    s.app_dir.join("frontend-settings.json"),
                    json!({"mailvault-settings":{"version":1,"state":{}}}).to_string(),
                )
                .unwrap();
                let mut params = match kind {
                    "check" => {
                        json!({"requestId":"check","accountId":"compose-prep-oauth-trap","fromAddress":"me@gmail.test","mode":"new","to":"friend@example.test","bcc":"bcc-prep-trap-sentinel@example.test","authoredBodyText":"body-prep-trap-sentinel","attachmentCount":0,"timeZone":"UTC"})
                    }
                    "mailto" => {
                        json!({"kind":"mailto","requestId":"mailto","href":"mailto:friend@example.test?bcc=bcc-prep-trap-sentinel@example.test&body=body-prep-trap-sentinel"})
                    }
                    _ => {
                        json!({"kind":"message","requestId":"message","mode":"reply","original":{"header":{"from":{"address":"friend@example.test"},"bcc":[{"address":"bcc-prep-trap-sentinel@example.test"}]},"html":"<p>body-prep-trap-sentinel</p>"},"presentation":{"originalLabel":"Original","dateLabel":"","subjectCandidate":"Re: "}})
                    }
                };
                let oauth = json!({"id":"compose-prep-oauth-trap","authType":"oauth2","email":"me@gmail.test"});
                params[field] = match field {
                    "accountJson" => json!(oauth.to_string()),
                    "targets" => json!([{"accountId":"compose-prep-oauth-trap","account":oauth}]),
                    _ => oauth,
                };
                let (_trap, lookups) = lookup_trap("compose-prep-oauth-trap");
                let before_posts = test_token_posts().len();
                let response = crate::server::handle_request_for_test(&s, method, params).await;
                observed.push((
                    kind,
                    field,
                    lookups.load(std::sync::atomic::Ordering::SeqCst),
                    test_token_posts().len() - before_posts,
                    s.tokens.unsaved().len(),
                ));
                assert_eq!(
                    response.error.unwrap().message,
                    "compose.preparationUnavailable"
                );
            }
        }
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
        let logged = String::from_utf8_lossy(&logs.lock().unwrap()).to_string();
        for sentinel in [
            "body-prep-trap-sentinel",
            "bcc-prep-trap-sentinel",
            "at-prep-trap",
            "rt-stored-0001",
        ] {
            assert!(!logged.contains(sentinel), "sentinel reached the log");
        }
        assert!(
            observed
                .iter()
                .all(|(_, _, reads, posts, offered)| *reads == 0 && *posts == 0 && *offered == 0),
            "credential/refresh side effects before schema rejection: {observed:?}"
        );
    }
    #[tokio::test]
    async fn compose_prep_check_rejects_oauth_fields_before_credentials() {
        compose_prep_rejected_fields("compose.check").await;
    }
    #[tokio::test]
    async fn compose_prep_reply_rejects_oauth_fields_before_credentials() {
        compose_prep_rejected_fields("compose.reply_context").await;
    }

}
