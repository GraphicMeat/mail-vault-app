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
//! Where tokens are stored does not change: the app stays the only writer of
//! the credentials blob (the keychain item it created; the sealed store on a
//! portable drive). After a refresh this module emits `REFRESHED_EVENT` with
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
use std::time::{Duration, Instant};
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

#[derive(Clone)]
struct Entry {
    grant: Grant,
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
    cooldown: Option<(Instant, FailKind, String)>,
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
    let expires_at = record.get("oauth2ExpiresAt").and_then(Value::as_f64).map(|v| v as i64).unwrap_or(0);
    Some((grant, text("oauth2AccessToken").unwrap_or_default(), expires_at))
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
        self.entries().get(account_id).filter(|e| e.checked && !e.needs_refresh(now)).map(|e| e.access_token.clone())
    }

    /// Lay a just-read record over the held entry: the later expiry wins. A
    /// record the daemon does not manage (or none) drops the entry.
    fn reconcile(&self, account_id: &str, record: &Value) -> Option<Entry> {
        let mut entries = self.entries();
        let Some((grant, access_token, expires_at)) = grant_of(record) else {
            entries.remove(account_id);
            return None;
        };
        if let Some(held) = entries.get_mut(account_id) {
            let same_address = held.grant.email.eq_ignore_ascii_case(&grant.email);
            let saved = held.access_token == access_token && held.expires_at == expires_at;
            if same_address && (saved || held.expires_at > expires_at) {
                if saved {
                    held.unsaved = false;
                }
                held.checked = true;
                return Some(held.clone());
            }
        }
        let entry = Entry { grant, access_token, expires_at, unsaved: false, checked: true, rejected: false, cooldown: None };
        entries.insert(account_id.to_string(), entry.clone());
        Some(entry)
    }

    /// The app wrote the credentials blob: read it again before trusting a
    /// held token, so a new sign-in (or a removed account) takes effect.
    pub(crate) fn credentials_changed(&self) {
        for entry in self.entries().values_mut() {
            entry.checked = false;
        }
    }

    /// A server refused `token` for `account_id`: the next use refreshes.
    pub(crate) fn rejected(&self, account_id: &str, token: &str) {
        if let Some(entry) = self.entries().get_mut(account_id) {
            if entry.access_token == token {
                entry.rejected = true;
            }
        }
    }

    /// The pairs refreshed here that the stored record does not show yet, for
    /// the app to save: `{accountId, accessToken, refreshToken, expiresAt}`.
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
                })
            })
            .collect()
    }

    fn unsaved_ids(&self) -> Vec<String> {
        self.entries().iter().filter(|(_, e)| e.unsaved).map(|(id, _)| id.clone()).collect()
    }

    fn store_refresh(&self, account_id: &str, grant: &Grant, access_token: String, refresh_token: Option<String>, expires_at: i64) {
        let mut entries = self.entries();
        let Some(entry) = entries.get_mut(account_id) else { return };
        // The refresh token goes with the client it was posted with: only
        // the token itself rotates.
        entry.grant = grant.clone();
        if let Some(rt) = refresh_token.filter(|rt| !rt.is_empty()) {
            entry.grant.refresh_token = rt;
        }
        entry.access_token = access_token;
        entry.expires_at = expires_at;
        entry.unsaved = true;
        entry.rejected = false;
        entry.cooldown = None;
    }

    fn store_failure(&self, account_id: &str, kind: FailKind, message: &str) {
        let wait = if kind == FailKind::Refused { REFUSED_COOLDOWN } else { UNANSWERED_COOLDOWN };
        if let Some(entry) = self.entries().get_mut(account_id) {
            entry.cooldown = Some((Instant::now() + wait, kind, message.to_string()));
        }
    }
}

async fn read_record(account_id: &str, read: Read) -> Result<(ImapConfig, Value), String> {
    match read {
        Read::Guarded => credentials::resolve_account_with_record_guarded(account_id).await,
        Read::Quiet => credentials::resolve_account_with_record_quiet(account_id).await,
    }
}

/// The ONE function: a valid access token for `account_id`, refreshed first
/// when it is expired or within `REFRESH_MARGIN_MS` of it.
///
/// `Ok(None)`: the daemon does not manage this account's token (a password or
/// JMAP account, an OAuth2 one with no refresh token). `Err`: the token has
/// expired and could not be renewed, or the record could not be read.
pub(crate) async fn access_token(state: &Arc<DaemonState>, account_id: &str, read: Read) -> Result<Option<String>, TokenError> {
    if let Some(token) = state.tokens.cached(account_id, now_ms()) {
        return Ok(Some(token));
    }
    let (_, record) = read_record(account_id, read)
        .await
        .map_err(|e| TokenError { kind: FailKind::Unreadable, message: e, fallback: None })?;
    for_record(state, account_id, &record).await
}

/// `access_token` for a caller that has just read the record itself.
pub(crate) async fn for_record(state: &Arc<DaemonState>, account_id: &str, record: &Value) -> Result<Option<String>, TokenError> {
    let flight = state.tokens.flight(account_id);
    let _one_refresh = flight.lock().await;
    // A refresh that finished while this caller waited wins here: its expiry
    // is later than the record this caller read.
    let Some(entry) = state.tokens.reconcile(account_id, record) else { return Ok(None) };
    let now = now_ms();
    if !entry.needs_refresh(now) {
        return Ok(Some(entry.access_token));
    }
    if let Some((until, kind, message)) = entry.cooldown.clone().filter(|(until, ..)| Instant::now() < *until) {
        let _ = until;
        return if entry.still_valid(now) { Ok(Some(entry.access_token)) } else { Err(entry.failure(kind, message)) };
    }
    refresh(state, account_id, entry, now).await
}

async fn refresh(state: &Arc<DaemonState>, account_id: &str, entry: Entry, now: i64) -> Result<Option<String>, TokenError> {
    let grant = &entry.grant;
    let result = state
        .oauth2
        .refresh_token(
            &grant.refresh_token,
            grant.provider.clone(),
            grant.custom_client_id.clone(),
            grant.tenant_id.clone(),
            grant.use_graph,
            grant.client_id.clone(),
        )
        .await;
    let failure = match result {
        Ok(tokens) if !tokens.access_token.is_empty() => {
            let token = tokens.access_token.clone();
            state.tokens.store_refresh(account_id, grant, tokens.access_token, tokens.refresh_token, tokens.expires_at as i64);
            info!("[oauth] refreshed the access token of {}", grant.email);
            state.events.emit(REFRESHED_EVENT, json!({ "accountId": account_id }));
            return Ok(Some(token));
        }
        Ok(_) => "the refresh returned no token".to_string(),
        Err(e) => e,
    };
    let kind = if renewal_unanswered(&failure) { FailKind::Unanswered } else { FailKind::Refused };
    let message = scrub(&failure, &[&grant.refresh_token, &entry.access_token]);
    state.tokens.store_failure(account_id, kind, &message);
    if entry.still_valid(now) {
        warn!("[oauth] could not refresh the token of {}: {message}; using the stored one, still valid", grant.email);
        return Ok(Some(entry.access_token));
    }
    warn!("[oauth] the token of {} has expired and could not be refreshed: {message}", grant.email);
    Err(entry.failure(kind, message))
}

/// `config` (read with `record`) with the daemon's token in it. A failure
/// is the caller's to judge; its `fallback` is the expired token.
pub(crate) async fn fresh_config(
    state: &Arc<DaemonState>,
    account_id: &str,
    mut config: ImapConfig,
    record: &Value,
) -> Result<ImapConfig, TokenError> {
    if !config.is_oauth2() {
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
pub(crate) async fn resolve(state: &Arc<DaemonState>, account_id: &str, read: Read) -> Result<ImapConfig, String> {
    let (config, record) = read_record(account_id, read).await?;
    Ok(match fresh_config(state, account_id, config.clone(), &record).await {
        Ok(fresh) => fresh,
        Err(e) => {
            let mut stale = config;
            if e.fallback.is_some() {
                stale.access_token = e.fallback;
            }
            stale
        }
    })
}

/// After the app wrote credentials: read the record of every account with a
/// refreshed pair not yet seen stored, quietly, so `unsaved` stops offering
/// what was saved.
pub(crate) async fn recheck_unsaved(state: &Arc<DaemonState>) {
    for account_id in state.tokens.unsaved_ids() {
        if let Ok((_, record)) = read_record(&account_id, Read::Quiet).await {
            let flight = state.tokens.flight(&account_id);
            let _held = flight.lock().await;
            state.tokens.reconcile(&account_id, &record);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::oauth2::{test_token_mock, test_token_posts};
    use mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID;

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
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _mock = test_token_mock(Vec::new());
        let s = st();
        store(&s, &[("g1", &gmail(json!({"oauth2ExpiresAt": now_ms() + 3_600_000})))]);

        let token = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(token.ok().flatten().as_deref(), Some("at-stored-0001"));
        assert!(test_token_posts().is_empty(), "no refresh for a good token");
    }

    /// The record's own refresh token and Google client go to the token
    /// endpoint; the app hears an account id and nothing else.
    #[tokio::test]
    async fn an_expired_token_is_refreshed_with_the_records_grant_and_announced() {
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
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
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _mock = test_token_mock(vec![granted("at-fresh-0003", None)]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({"oauth2ExpiresAt": now_ms() + 120_000})))]);

        let token = access_token(&s, "g1", Read::Quiet).await;
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");

        assert_eq!(token.ok().flatten().as_deref(), Some("at-fresh-0003"));
        assert_eq!(test_token_posts().len(), 1);
    }

    /// As the app: a password account, an OAuth2 one without a refresh token
    /// and one whose record never gave an expiry are not refreshed.
    #[tokio::test]
    async fn accounts_the_daemon_does_not_manage_are_left_alone() {
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
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
        assert!(matches!(n, Ok(None)), "no refresh token");
        assert_eq!(e.ok().flatten().as_deref(), Some("at-stored-0001"), "no expiry on record");
        assert!(test_token_posts().is_empty());
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_refresh() {
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _mock = test_token_mock(vec![granted("at-fresh-0004", None), granted("at-second-0004", None)]);
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
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let logs = crate::events::captured_logs();
        let echo = json!({"error": "invalid_grant", "error_description": "Bad grant rt-stored-0001 for at-stored-0001"});
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
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _mock = test_token_mock(vec![(503, "Service Unavailable".to_string()), granted("at-late-0005", None)]);
        let s = st();
        store(&s, &[("g1", &gmail(json!({"oauth2ExpiresAt": now_ms() + 120_000})))]);

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
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _mock = test_token_mock(vec![granted("at-fresh-0006", None), granted("at-wrong-0006", None)]);
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
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _mock = test_token_mock(vec![granted("at-fresh-0007", Some("rt-rotated-0007")), granted("at-after-0007", None)]);
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
        let _env = credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
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
        assert_eq!(keys, vec!["accessToken", "accountId", "expiresAt", "refreshToken"], "never the client id");
        assert_eq!(offered[0]["accountId"], json!("g1"));
        assert_eq!(offered[0]["accessToken"], json!("at-fresh-0008"));
        assert_eq!(offered[0]["refreshToken"], json!("rt-rotated-0008"));
        assert_eq!(after_failed_save.len(), 1, "the record does not show it yet");
        assert!(after_save.is_empty(), "{after_save:?}");
    }
}
