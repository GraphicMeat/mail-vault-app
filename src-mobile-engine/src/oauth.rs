//! OAuth sign-in and token upkeep: `mobile.oauth.{begin,finish,cancel,reauth}` and
//! [`access_token`], over mailvault-core's `OAuth2Manager` (one per engine).
//!
//! A flow: `begin` binds core's loopback listener (`127.0.0.1:19876`, the redirect
//! `http://localhost:19876/callback`) and returns the provider's auth URL, which the page opens in
//! the system sign-in sheet. `finish` waits (at most 300 s) for the code the listener receives,
//! redeems it, reads the address (the id_token's `email` for Google, Graph `/me` for Microsoft),
//! signs in once to prove the grant works (an IMAP XOAUTH2 login for Google, one Graph folder list
//! for Microsoft) and only then stores the account: Google as `kind = imap`, Microsoft as
//! `kind = graph` (plan Ruling 5), both `auth = oauth2`. `cancel` ends a flow. The listener is shut
//! as soon as no flow is open, so the port is held only while a sign-in sheet is.
//!
//! Tokens live only in the secret store, as a [`Credential`] envelope with the issuing client's id.
//! No token and no authorization code goes into `mobile.db`, a log line, an event or a reply; the
//! auth URL carries the state and the PKCE challenge, neither of them a secret.
//!
//! Every place that signs in an OAuth account takes its token from [`access_token`]: the stored one
//! while it has more than a minute left, else a refresh, one at a time per account. A refresh the
//! provider refuses (an OAuth error answer such as `invalid_grant`) marks the account
//! `needs_auth = 1`, emits `mobile.sync.state {state: "error", code: "NEEDS_AUTH"}` and returns
//! [`Fail::auth`]. From then on the account is parked: `backend::open` refuses it with no network,
//! and the replay and outbox workers skip it, until `mobile.oauth.reauth` signs it in again.

use crate::accounts::{self, failure, load_account, map_error, AccountRow, Code};
use crate::db::{lock, Engine, Shared};
use crate::events::SYNC_STATE;
use crate::net::block_on;
use crate::rpc::{parse, RpcError};
use crate::secrets::Credential;
use crate::sync::Fail;
use mailvault_core::oauth2::{OAuth2Manager, TokenResponse};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long `finish` waits for the browser to come back with a code.
const FINISH_TIMEOUT: Duration = Duration::from_secs(300);
/// A stored access token is used only while it has at least this long left.
const REFRESH_MARGIN_MS: i64 = 60_000;
/// Distinct freshly refreshed tokens the server must refuse in a row before the account is parked:
/// the grant is valid, but the mailbox will not take it (IMAP turned off, a tenant policy), and
/// every further attempt would cost a refresh and two logins. One token refused by several workers
/// (sync, replay, outbox, live share it) counts once.
const MAX_FRESH_REFUSALS: usize = 3;
/// ... and the refusals must span at least this long: a provider incident that refuses every
/// token for a few minutes is not a revoked mailbox.
const REFUSAL_SPAN: Duration = Duration::from_secs(10 * 60);
/// Microsoft's Graph grant also asks for this, so `/me` can name the address.
const MICROSOFT_EXTRA_SCOPE: &str = "User.Read";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Provider {
    Google,
    Microsoft,
}

impl Provider {
    fn parse(s: &str) -> Option<Provider> {
        match s {
            "google" => Some(Provider::Google),
            "microsoft" => Some(Provider::Microsoft),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Microsoft => "microsoft",
        }
    }

    /// Ruling 5: Microsoft over Graph, Google over IMAP and SMTP.
    fn use_graph(self) -> bool {
        self == Provider::Microsoft
    }
}

/// Where a Google account's IMAP and SMTP live: Gmail's, or a test's mock (debug builds only).
#[derive(Clone, Debug)]
struct Servers {
    imap: (String, u16, String),
    smtp: (String, u16, String),
}

impl Default for Servers {
    fn default() -> Self {
        Servers { imap: ("imap.gmail.com".into(), 993, "ssl".into()), smtp: ("smtp.gmail.com".into(), 465, "ssl".into()) }
    }
}

struct Flow {
    /// Core's `state` for the flow (also in the auth URL).
    state: String,
    provider: Provider,
    /// The account a `reauth` flow signs in again.
    reauth: Option<String>,
    /// Set by `cancel`, so `finish` reads the failure it causes as `CANCELLED`.
    cancelled: AtomicBool,
    /// A `finish` is waiting on it (that wait has its own timeout, so it is never pruned).
    finishing: AtomicBool,
    started: Instant,
}

/// The engine's OAuth state, in [`Shared`].
pub(crate) struct OAuth {
    manager: OAuth2Manager,
    flows: Mutex<HashMap<String, Arc<Flow>>>,
    /// Held while a `begin` starts the listener and adds its flow, and while the last flow's end
    /// shuts the listener, so one never undoes the other.
    listener: Mutex<()>,
    /// The listener may be bound (cleared once it is shut).
    listening: AtomicBool,
    /// One refresh at a time per account.
    refresh_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    finish_timeout: Mutex<Duration>,
    google_servers: Mutex<Servers>,
    /// Per account: the fresh tokens the server refused in a row (hashes, never the tokens) and
    /// when the first was refused. At [`MAX_FRESH_REFUSALS`] over [`REFUSAL_SPAN`] the account is
    /// parked like a refused grant.
    fresh_refusals: Mutex<HashMap<String, Refusals>>,
    /// [`REFUSAL_SPAN`], shortened by tests.
    refusal_span: Mutex<Duration>,
}

#[derive(Default)]
struct Refusals {
    tokens: Vec<u64>,
    first: Option<Instant>,
}

impl Default for OAuth {
    fn default() -> Self {
        OAuth {
            manager: OAuth2Manager::new(),
            flows: Mutex::new(HashMap::new()),
            listener: Mutex::new(()),
            listening: AtomicBool::new(false),
            refresh_locks: Mutex::new(HashMap::new()),
            finish_timeout: Mutex::new(FINISH_TIMEOUT),
            google_servers: Mutex::new(Servers::default()),
            fresh_refusals: Mutex::new(HashMap::new()),
            refusal_span: Mutex::new(REFUSAL_SPAN),
        }
    }
}

impl OAuth {
    fn refresh_lock(&self, account: &str) -> Arc<Mutex<()>> {
        Arc::clone(lock(&self.refresh_locks).entry(account.to_string()).or_default())
    }

    /// Ends the flow `flow_id` (if it is still listed) and shuts the listener when no flow is left.
    fn end_flow(&self, flow_id: &str) {
        let _gate = lock(&self.listener);
        let flow = lock(&self.flows).remove(flow_id);
        if let Some(flow) = flow {
            block_on(self.manager.cancel_flow(&flow.state));
        }
        self.prune();
        if lock(&self.flows).is_empty() && self.listening.swap(false, Ordering::SeqCst) {
            block_on(self.manager.shutdown_callback_server());
        }
    }

    /// Drops flows begun longer ago than the finish window that no `finish` waits on: a page that
    /// called `begin` and then went away. Called with the listener gate held.
    fn prune(&self) {
        let window = *lock(&self.finish_timeout);
        let stale: Vec<Arc<Flow>> = {
            let mut flows = lock(&self.flows);
            let ids: Vec<String> = flows
                .iter()
                .filter(|(_, f)| !f.finishing.load(Ordering::SeqCst) && f.started.elapsed() > window)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| flows.remove(id)).collect()
        };
        for f in stale {
            block_on(self.manager.cancel_flow(&f.state));
        }
    }

    /// The engine is closing: every flow is dropped and the port freed.
    pub(crate) fn close(&self) {
        let ids: Vec<String> = lock(&self.flows).keys().cloned().collect();
        for id in &ids {
            if let Some(f) = lock(&self.flows).get(id) {
                f.cancelled.store(true, Ordering::SeqCst);
            }
            self.end_flow(id);
        }
        if self.listening.swap(false, Ordering::SeqCst) {
            block_on(self.manager.shutdown_callback_server());
        }
    }
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// `flow_` + 16 hex chars, random (the same source as account ids).
fn new_flow_id() -> String {
    format!("flow_{}", &accounts::new_account_id()[4..])
}

/// `text` with every secret in `secrets` replaced, for a log line.
fn scrub(text: &str, secrets: &[&str]) -> String {
    secrets.iter().filter(|s| !s.is_empty()).fold(text.to_string(), |t, s| t.replace(s, "***"))
}

// ── Access tokens ───────────────────────────────────────────────────────────

/// The token to sign `account_id` in with: the stored one while it has more than a minute left,
/// else a fresh one from the provider (stored before it is returned). One refresh at a time per
/// account: a caller that waited finds the token the first one stored. [`Fail::auth`] while the
/// account needs a new sign-in, and when the provider refuses the refresh (then it marks the
/// account and emits `NEEDS_AUTH`).
pub(crate) fn access_token(shared: &Shared, account_id: &str) -> Result<String, Fail> {
    token(shared, account_id, None)
}

/// [`access_token`] after the server refused `refused`: a refresh, unless another caller has
/// already stored a different token.
pub(crate) fn access_token_after_refusal(shared: &Shared, account_id: &str, refused: &str) -> Result<String, Fail> {
    token(shared, account_id, Some(refused))
}

fn token(shared: &Shared, account: &str, refused: Option<&str>) -> Result<String, Fail> {
    let gate = shared.oauth.refresh_lock(account);
    let _one = lock(&gate);
    // Read under the lock: a caller that waited sees what the one before it stored.
    let row: Option<(Option<String>, String, i64)> = shared.read(|c| {
        c.query_row("SELECT provider, kind, needs_auth FROM accounts WHERE id = ?1", [account], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
    })?;
    let Some((provider, kind, needs_auth)) = row else {
        return Err(Fail::Gone);
    };
    if needs_auth != 0 {
        return Err(Fail::auth());
    }
    let cred = match shared.secrets().get(account) {
        Ok(Some(s)) => Credential::parse(&s),
        Ok(None) => return Err(Fail::Code(Code::AuthFailed, "no secret stored for the account".into())),
        Err(e) => return Err(Fail::Code(Code::Invalid, format!("secret store: {e}"))),
    };
    let Some(refresh) = cred.refresh.clone().filter(|r| !r.is_empty()) else {
        // Nothing can renew it: only a new sign-in helps.
        mark_needs_auth(shared, account, "no refresh token stored");
        return Err(Fail::auth());
    };
    if let (Some(access), Some(expires)) = (&cred.access, cred.expires_ms) {
        let fresh = expires - REFRESH_MARGIN_MS > accounts::now_ms();
        if !access.is_empty() && fresh && refused != Some(access.as_str()) {
            return Ok(access.clone());
        }
    }
    let provider = provider.unwrap_or_else(|| "google".into());
    let got = block_on(shared.oauth.manager.refresh_token(&refresh, Some(provider), None, None, kind == "graph", cred.client_id.clone()));
    let secrets: Vec<&str> = cred.secrets();
    match got {
        Ok(t) => {
            let next = Credential {
                refresh: Some(t.refresh_token.clone().filter(|r| !r.is_empty()).unwrap_or(refresh.clone())),
                access: Some(t.access_token.clone()),
                expires_ms: Some(t.expires_at as i64),
                client_id: Some(t.client_id.clone()).filter(|c| !c.is_empty()).or(cred.client_id.clone()),
                password: None,
            };
            let secret = next.to_secret();
            shared.secrets().set(account, &secret).map_err(|e| {
                let mut all = secrets.clone();
                all.extend([secret.as_str(), t.access_token.as_str()]);
                Fail::Code(Code::Invalid, format!("secret store: {}", scrub(&e, &all)))
            })?;
            Ok(t.access_token)
        }
        Err(e) => {
            let why = scrub(&e, &secrets);
            if is_refused_grant(&e) {
                mark_needs_auth(shared, account, &why);
                Err(Fail::auth())
            } else {
                shared.log(&format!("[oauth] {account}: refresh failed: {why}"));
                // Unreachable, slow or garbled: the caller retries as for any network failure.
                let code = match map_error(&why) {
                    Code::Invalid => Code::HostUnreachable,
                    c => c,
                };
                Err(Fail::Code(code, why))
            }
        }
    }
}

/// Core's refresh failed because the provider answered with an OAuth error (`Token refresh
/// failed: <error> — …`, a 400 or 401 such as `invalid_grant`, `invalid_client`,
/// `unauthorized_client`), or because the grant names a client this build lacks. Transient answers
/// (`temporarily_unavailable`, `server_error`) and failures to reach or read the endpoint are not.
fn is_refused_grant(e: &str) -> bool {
    if e.contains("Reconnect the account") {
        return true;
    }
    let Some(rest) = e.strip_prefix("Token refresh failed:") else {
        return false;
    };
    let code = rest.trim_start().split_whitespace().next().unwrap_or("").trim_matches('"');
    !matches!(code, "temporarily_unavailable" | "server_error")
}

/// Parks `account` until a new sign-in: `needs_auth = 1` and one `NEEDS_AUTH` event.
fn mark_needs_auth(shared: &Shared, account: &str, why: &str) {
    shared.log(&format!("[oauth] {account}: NEEDS_AUTH {why}"));
    match shared.write(|c| c.execute("UPDATE accounts SET needs_auth = 1 WHERE id = ?1 AND needs_auth = 0", [account])) {
        Ok(1) => {
            // A live listener on the account hangs up at its next stop check.
            shared.parks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            shared.emit(SYNC_STATE, json!({ "accountId": account, "state": "error", "code": Code::NeedsAuth.as_str() }))
        }
        Ok(_) => {}
        Err(e) => shared.log(&format!("[oauth] {account}: marking needs_auth failed: {e}")),
    }
}

/// The server refused `account`'s freshly refreshed `token`. Parks the account (and returns
/// [`Fail::auth`]) once [`MAX_FRESH_REFUSALS`] distinct fresh tokens were refused in a row over
/// at least the refusal span; `None` before. A token already counted (another worker used the same
/// one) does not count again.
pub(crate) fn fresh_token_refused(shared: &Shared, account: &str, token: &str) -> Option<Fail> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut h);
    let id = h.finish();
    let span = *lock(&shared.oauth.refusal_span);
    let (n, over) = {
        let mut m = lock(&shared.oauth.fresh_refusals);
        let r = m.entry(account.to_string()).or_default();
        if !r.tokens.contains(&id) {
            r.tokens.push(id);
        }
        let first = *r.first.get_or_insert_with(Instant::now);
        (r.tokens.len(), first.elapsed() >= span)
    };
    if n < MAX_FRESH_REFUSALS || !over {
        return None;
    }
    lock(&shared.oauth.fresh_refusals).remove(account);
    mark_needs_auth(shared, account, &format!("the server refused {n} fresh tokens in a row over {span:?}"));
    Some(Fail::auth())
}

/// `account` signed in: its run of refusals ends.
pub(crate) fn sign_in_worked(shared: &Shared, account: &str) {
    let mut m = lock(&shared.oauth.fresh_refusals);
    if !m.is_empty() {
        m.remove(account);
    }
}

/// The account is being removed: its refusal run and refresh lock go.
pub(crate) fn forget(shared: &Shared, account: &str) {
    lock(&shared.oauth.fresh_refusals).remove(account);
    lock(&shared.oauth.refresh_locks).remove(account);
}

impl Engine {
    /// The platform lost `account`'s secret (the shell's keychain policy move could not write it
    /// back): the account is parked (`needs_auth = 1`, one `NEEDS_AUTH` event) so the page asks
    /// for a new sign-in instead of every worker failing on a missing secret.
    pub fn secret_lost(&self, account: &str) {
        mark_needs_auth(self.shared(), account, "the stored secret was lost");
    }

    /// Tests: how long fresh-token refusals must span before they park an account.
    #[doc(hidden)]
    pub fn set_oauth_refusal_span(&self, span: Duration) {
        *lock(&self.shared().oauth.refusal_span) = span;
    }
}

// ── The flow RPCs ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginParams {
    provider: String,
    #[serde(default)]
    login_hint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowParams {
    flow_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReauthParams {
    account_id: String,
}

/// Starts the listener and a flow; `{flowId, url}`.
fn start(shared: &Shared, provider: Provider, login_hint: Option<String>, reauth: Option<String>) -> Result<Value, RpcError> {
    let oauth = &shared.oauth;
    let _gate = lock(&oauth.listener);
    oauth.prune();
    block_on(oauth.manager.start_callback_server()).map_err(|e| internal(format!("sign-in listener: {e}")))?;
    oauth.listening.store(true, Ordering::SeqCst);
    let extra = (provider == Provider::Microsoft).then_some(MICROSOFT_EXTRA_SCOPE);
    let built = block_on(oauth.manager.generate_auth_url_scoped(
        login_hint.clone(),
        Some(provider.as_str().to_string()),
        None,
        None,
        provider.use_graph(),
        None,
        extra,
    ));
    let url = match built {
        Ok(u) => u,
        Err(e) => {
            if lock(&oauth.flows).is_empty() && oauth.listening.swap(false, Ordering::SeqCst) {
                block_on(oauth.manager.shutdown_callback_server());
            }
            return Err(internal(format!("sign-in url: {e}")));
        }
    };
    let id = new_flow_id();
    let flow = Flow {
        state: url.state,
        provider,
        reauth,
        cancelled: AtomicBool::new(false),
        finishing: AtomicBool::new(false),
        started: Instant::now(),
    };
    lock(&oauth.flows).insert(id.clone(), Arc::new(flow));
    Ok(json!({ "flowId": id, "url": url.auth_url }))
}

/// `mobile.oauth.begin {provider: "google"|"microsoft", loginHint?}` -> `{flowId, url}`.
pub(crate) fn begin(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: BeginParams = parse(params)?;
    let provider = Provider::parse(&p.provider).ok_or_else(|| RpcError::Invalid("provider must be google or microsoft".into()))?;
    let hint = p.login_hint.map(|h| h.trim().to_string()).filter(|h| !h.is_empty());
    start(engine.shared(), provider, hint, None)
}

/// `mobile.oauth.reauth {accountId}` -> `{flowId, url}`: a flow that signs an OAuth account in
/// again; `finish` then replaces its tokens and clears `needs_auth`.
pub(crate) fn reauth(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ReauthParams = parse(params)?;
    let acct = load_account(engine.shared(), &p.account_id).map_err(internal)?.ok_or_else(|| RpcError::Invalid("unknown account".into()))?;
    let provider = acct
        .provider
        .as_deref()
        .and_then(Provider::parse)
        .filter(|_| acct.auth == "oauth2")
        .ok_or_else(|| RpcError::Invalid("the account does not sign in through a provider".into()))?;
    start(engine.shared(), provider, Some(acct.email), Some(p.account_id))
}

/// `mobile.oauth.cancel {flowId}` -> `{cancelled}`: a `finish` waiting on it returns `CANCELLED`.
pub(crate) fn cancel(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: FlowParams = parse(params)?;
    let oauth = &engine.shared().oauth;
    let found = match lock(&oauth.flows).get(&p.flow_id) {
        Some(f) => {
            f.cancelled.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    };
    oauth.end_flow(&p.flow_id);
    Ok(json!({ "cancelled": found }))
}

/// What a failed code exchange means for the user.
fn exchange_failure(e: &str) -> Code {
    let lower = e.to_ascii_lowercase();
    if lower.contains("access_denied") || lower.contains("declined") || lower.contains("cancel") {
        Code::Cancelled
    } else if lower.contains("timed out") {
        Code::Timeout
    } else if e.starts_with("Token request failed") {
        match map_error(e) {
            c @ (Code::TlsFailed | Code::Timeout) => c,
            _ => Code::HostUnreachable,
        }
    } else {
        Code::AuthFailed
    }
}

/// `mobile.oauth.finish {flowId}` -> `{ok: true, account}` or `{ok: false, code, message}` with
/// `code` one of `CANCELLED`, `TIMEOUT`, `AUTH_FAILED`, `DUPLICATE` (or a network code from the
/// sign-in check). Waits for the browser at most 300 s.
pub(crate) fn finish(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: FlowParams = parse(params)?;
    let oauth = &engine.shared().oauth;
    let flow = lock(&oauth.flows).get(&p.flow_id).cloned().ok_or_else(|| RpcError::Invalid("unknown flow".into()))?;
    flow.finishing.store(true, Ordering::SeqCst);
    let wait = *lock(&oauth.finish_timeout);
    let got = block_on(async { tokio::time::timeout(wait, oauth.manager.exchange_code(&flow.state)).await });
    // The listener has done its part, whatever came of it.
    oauth.end_flow(&p.flow_id);
    let tokens = match got {
        Err(_) => return Ok(failure(Code::Timeout, "the sign-in was not completed in time")),
        Ok(Err(_)) if flow.cancelled.load(Ordering::SeqCst) => return Ok(failure(Code::Cancelled, "the sign-in was cancelled")),
        Ok(Err(e)) => {
            let code = exchange_failure(&e);
            engine.shared().log(&format!("[oauth] finish: {} {e}", code.as_str()));
            return Ok(failure(code, "the provider did not complete the sign-in"));
        }
        Ok(Ok(t)) => t,
    };
    let secrets = [tokens.access_token.as_str(), tokens.refresh_token.as_deref().unwrap_or("")];
    Ok(match complete(engine, &flow, &tokens) {
        Ok(v) => v,
        Err((code, why)) => {
            let why = scrub(&why, &secrets);
            engine.shared().log(&format!("[oauth] finish: {} {why}", code.as_str()));
            failure(code, why)
        }
    })
}

type Refusal = (Code, String);

/// Graph's failure: a refused token (401, 403) is a failed sign-in.
fn graph_code(e: &str) -> Code {
    if e.contains("(401)") || e.contains("(403)") {
        Code::AuthFailed
    } else {
        match map_error(e) {
            Code::Invalid => Code::HostUnreachable,
            c => c,
        }
    }
}

/// The address the grant belongs to.
fn signed_in_address(flow: &Flow, tokens: &TokenResponse) -> Result<String, Refusal> {
    let address = match flow.provider {
        Provider::Google => tokens.email.clone(),
        Provider::Microsoft => {
            let client = mailvault_core::graph::GraphClient::for_purpose(&tokens.access_token, "sign-in");
            // Never the address the user typed: only one Microsoft confirms identifies the
            // mailbox (a reauth's identity check and the DUPLICATE check depend on it). A /me that
            // fails ends the sign-in, with nothing stored.
            match block_on(client.me_address()) {
                Ok(a) => Some(a),
                Err(e) => return Err((graph_code(&e), format!("Graph /me: {e}"))),
            }
        }
    };
    address
        .map(|a| a.trim().to_string())
        .filter(|a| a.contains('@'))
        .ok_or_else(|| (Code::AuthFailed, "the provider did not name the signed-in address".into()))
}

/// The row a new account of `provider` gets.
fn new_row(engine: &Engine, provider: Provider, address: &str) -> AccountRow {
    let mut row = match provider {
        Provider::Google => {
            let s = lock(&engine.shared().oauth.google_servers).clone();
            let mut row = AccountRow::password(address, &s.imap.0, s.imap.1, &s.imap.2);
            row.smtp_host = Some(s.smtp.0);
            row.smtp_port = Some(s.smtp.1);
            row.smtp_security = Some(s.smtp.2);
            row
        }
        // Graph needs no host; the column is required, so it holds Outlook's IMAP, unused.
        Provider::Microsoft => {
            let mut row = AccountRow::password(address, "outlook.office365.com", 993, "ssl");
            row.kind = "graph".into();
            row
        }
    };
    row.auth = "oauth2".into();
    row.provider = Some(provider.as_str().into());
    row.display_name = address.to_string();
    row
}

/// One sign-in with `cred` to prove the grant reaches the mailbox.
fn verify(row: &AccountRow, cred: &Credential) -> Result<(), Refusal> {
    if row.kind == "graph" {
        let token = cred.access.as_deref().unwrap_or("");
        let client = mailvault_core::graph::GraphClient::for_purpose(token, "sign-in");
        block_on(client.list_folders()).map(|_| ()).map_err(|e| (graph_code(&e), e))
    } else {
        crate::net::login(row, cred).map(|_| ()).map_err(|e| (map_error(&e), e))
    }
}

fn complete(engine: &Engine, flow: &Flow, tokens: &TokenResponse) -> Result<Value, Refusal> {
    let address = signed_in_address(flow, tokens)?;
    let mut cred = Credential {
        refresh: tokens.refresh_token.clone().filter(|r| !r.is_empty()),
        access: Some(tokens.access_token.clone()),
        expires_ms: Some(tokens.expires_at as i64),
        client_id: Some(tokens.client_id.clone()).filter(|c| !c.is_empty()),
        password: None,
    };
    match &flow.reauth {
        None => add_account(engine, flow, &address, cred),
        Some(id) => {
            let shared = engine.shared();
            let acct = load_account(shared, id).map_err(|e| (Code::Invalid, e.to_string()))?.ok_or_else(|| (Code::Invalid, String::from("the account is gone")))?;
            if mailvault_core::notes_to_self::normalize_identity(&acct.email) != mailvault_core::notes_to_self::normalize_identity(&address) {
                return Err((Code::AuthFailed, "signed in to a different account".into()));
            }
            if cred.refresh.is_none() {
                // A provider may skip the refresh token on a repeat consent: the old one stays.
                let old = shared.secrets().get(id).ok().flatten().map(|s| Credential::parse(&s));
                cred.refresh = old.and_then(|c| c.refresh);
            }
            if cred.refresh.is_none() {
                return Err((Code::AuthFailed, "the provider gave no refresh token".into()));
            }
            verify(&acct, &cred)?;
            {
                let gate = shared.oauth.refresh_lock(id);
                let _one = lock(&gate);
                let secret = cred.to_secret();
                shared.secrets().set(id, &secret).map_err(|e| (Code::Invalid, format!("secret store: {}", scrub(&e, &[&secret]))))?;
                shared
                    .write(|c| c.execute("UPDATE accounts SET needs_auth = 0 WHERE id = ?1", [id]))
                    .map_err(|e| (Code::Invalid, e.to_string()))?;
            }
            lock(&shared.oauth.fresh_refusals).remove(id);
            // Resume: the parked journal and outbox, and a sync of the account.
            engine.replay().wake(shared, Some(id));
            engine.outbox().wake(shared, Some(id));
            if let Err(e) = crate::sync::refresh(engine, json!({ "accountId": id })) {
                shared.log(&format!("[oauth] {id}: sync after sign-in: {e}"));
            }
            Ok(json!({ "ok": true, "account": reply_account(id, &acct) }))
        }
    }
}

fn add_account(engine: &Engine, flow: &Flow, address: &str, cred: Credential) -> Result<Value, Refusal> {
    if cred.refresh.is_none() {
        return Err((Code::AuthFailed, "the provider gave no refresh token".into()));
    }
    let taken = accounts::email_taken(engine, address).map_err(|e| (Code::Invalid, e.to_string()))?;
    if taken {
        return Err((Code::Duplicate, "this account is already added".into()));
    }
    let row = new_row(engine, flow.provider, address);
    verify(&row, &cred)?;
    let id = accounts::new_account_id();
    let secret = cred.to_secret();
    engine.secrets().set(&id, &secret).map_err(|e| (Code::Invalid, format!("secret store: {}", scrub(&e, &[&secret]))))?;
    let inserted = engine.write(|c| {
        c.execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, smtp_host, smtp_port, smtp_security,
                                   kind, auth, provider, needs_auth, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13)",
            rusqlite::params![
                &id,
                &row.email,
                &row.display_name,
                &row.imap_host,
                row.imap_port as i64,
                &row.security,
                &row.smtp_host,
                row.smtp_port.map(i64::from),
                &row.smtp_security,
                &row.kind,
                &row.auth,
                &row.provider,
                accounts::now_ms(),
            ],
        )?;
        Ok(())
    });
    if let Err(e) = inserted {
        let _ = engine.secrets().delete(&id);
        if accounts::is_unique_violation(&e.to_string()) {
            return Err((Code::Duplicate, "this account is already added".into()));
        }
        return Err((Code::Invalid, e.to_string()));
    }
    Ok(json!({ "ok": true, "account": reply_account(&id, &row) }))
}

/// The account as `mobile.accounts.list` shows it.
fn reply_account(id: &str, row: &AccountRow) -> Value {
    let mut a = accounts::account_json(
        id,
        &row.email,
        &row.display_name,
        &row.imap_host,
        row.imap_port as i64,
        &row.security,
        (row.smtp_host.clone(), row.smtp_port.map(i64::from), row.smtp_security.clone()),
    );
    a["kind"] = json!(row.kind);
    a["provider"] = json!(row.provider);
    a["needsAuth"] = json!(false);
    a
}

// ── Test seams (debug builds only) ─────────────────────────────────────────

#[cfg(debug_assertions)]
impl Engine {
    /// Tests: post token requests to `origin`, a loopback http URL, instead of the provider's.
    #[doc(hidden)]
    pub fn set_oauth_token_endpoint(&self, origin: &str) {
        self.shared().oauth.manager.set_token_endpoint_for_tests(Some(origin.to_string()));
    }

    /// Tests: new Google accounts use these IMAP and SMTP servers `(host, port, security)`.
    #[doc(hidden)]
    pub fn set_oauth_google_servers(&self, imap: (&str, u16, &str), smtp: (&str, u16, &str)) {
        *lock(&self.shared().oauth.google_servers) = Servers {
            imap: (imap.0.into(), imap.1, imap.2.into()),
            smtp: (smtp.0.into(), smtp.1, smtp.2.into()),
        };
    }

    /// Tests: parks `account_id` as a refused grant does (`needs_auth = 1`, the event, the live
    /// listener told).
    #[doc(hidden)]
    pub fn park_account_for_tests(&self, account_id: &str) {
        mark_needs_auth(self.shared(), account_id, "parked by a test");
    }

    /// Tests: how long `finish` waits, in place of 300 s.
    #[doc(hidden)]
    pub fn set_oauth_finish_timeout(&self, wait: Duration) {
        *lock(&self.shared().oauth.finish_timeout) = wait;
    }

    /// Tests: hand `code` to flow `flow_id` as the browser's redirect would. `false` when the flow
    /// is unknown or no longer waits.
    #[doc(hidden)]
    pub fn oauth_deliver_code(&self, flow_id: &str, code: &str) -> bool {
        let state = lock(&self.shared().oauth.flows).get(flow_id).map(|f| f.state.clone());
        match state {
            Some(s) => block_on(self.shared().oauth.manager.deliver_code_for_tests(&s, code)),
            None => false,
        }
    }

    /// Tests: [`access_token`] for `account_id`; the error is the code only.
    #[doc(hidden)]
    pub fn oauth_access_token(&self, account_id: &str) -> Result<String, String> {
        access_token(self.shared(), account_id).map_err(|f| match f {
            Fail::Code(c, _) => c.as_str().to_string(),
            Fail::Gone => "GONE".into(),
            Fail::Closing => "CLOSING".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_oauth_error_answer_needs_a_new_sign_in() {
        assert!(is_refused_grant("Token refresh failed: \"invalid_grant\" — Token has been expired or revoked."));
        assert!(is_refused_grant("Token refresh failed: \"invalid_client\" — x"));
        assert!(is_refused_grant("This Google account was connected with a Google client this build does not include (x). Reconnect the account to fix it."));
        assert!(!is_refused_grant("Token refresh failed: \"temporarily_unavailable\" — busy"));
        assert!(!is_refused_grant("Refresh request failed: error sending request: connection refused"));
        assert!(!is_refused_grant("Refresh response parse failed: expected value at line 1"));
    }

    #[test]
    fn exchange_failures_read_as_codes() {
        assert_eq!(exchange_failure("OAuth callback error: access_denied"), Code::Cancelled);
        assert_eq!(exchange_failure("OAuth callback error: AADSTS65004: User declined to consent"), Code::Cancelled);
        assert_eq!(exchange_failure("OAuth callback error: OAuth flow timed out"), Code::Timeout);
        assert_eq!(exchange_failure("Token request failed: error sending request"), Code::HostUnreachable);
        assert_eq!(exchange_failure("Token error: \"invalid_grant\" — bad code"), Code::AuthFailed);
    }

    fn engine() -> (tempfile::TempDir, Engine) {
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), std::sync::Arc::new(crate::MemorySecrets::default())).unwrap();
        e.write(|c| {
            c.execute(
                "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, provider, needs_auth, created_ms)
                 VALUES ('acc_x', 'x@gmail.com', '', 'imap.gmail.com', 993, 'ssl', 'imap', 'oauth2', 'google', 0, 1)",
                [],
            )
        })
        .unwrap();
        (tmp, e)
    }

    fn parked(e: &Engine) -> bool {
        e.read(|c| c.query_row("SELECT needs_auth FROM accounts WHERE id = 'acc_x'", [], |r| r.get::<_, i64>(0))).unwrap() != 0
    }

    /// One refreshed token refused by every worker that used it (sync, replay, outbox, live)
    /// counts once; only distinct fresh tokens, refused over the span, park the account.
    #[test]
    fn a_fresh_token_counts_once_however_many_workers_it_fails() {
        let (_tmp, e) = engine();
        e.set_oauth_refusal_span(Duration::ZERO);
        for _ in 0..5 {
            assert!(fresh_token_refused(e.shared(), "acc_x", "token-a").is_none());
        }
        assert!(!parked(&e), "one token, many refusals: not three");
        assert!(fresh_token_refused(e.shared(), "acc_x", "token-b").is_none());
        assert!(fresh_token_refused(e.shared(), "acc_x", "token-c").is_some(), "three distinct fresh tokens refused");
        assert!(parked(&e));
    }

    #[test]
    fn refusals_inside_the_span_do_not_park_and_a_sign_in_starts_over() {
        let (_tmp, e) = engine();
        e.set_oauth_refusal_span(Duration::from_secs(600));
        for t in ["t1", "t2", "t3", "t4"] {
            assert!(fresh_token_refused(e.shared(), "acc_x", t).is_none(), "{t}");
        }
        assert!(!parked(&e));
        sign_in_worked(e.shared(), "acc_x");
        e.set_oauth_refusal_span(Duration::ZERO);
        assert!(fresh_token_refused(e.shared(), "acc_x", "t1").is_none(), "the count started again");
        assert!(fresh_token_refused(e.shared(), "acc_x", "t2").is_none());
        assert!(fresh_token_refused(e.shared(), "acc_x", "t3").is_some());
    }

    #[test]
    fn scrub_removes_every_secret() {
        assert_eq!(scrub("a rt-1 b at-2 c", &["rt-1", "at-2", ""]), "a *** b *** c");
    }
}
