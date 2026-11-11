//! Premium on the phone: decided only by the billing server's answer, cached until the expiry it
//! returned (spec: "Client trusts only the server's answer, cached until the store expiry it
//! returned. After that with no network: not entitled."; no grace period).
//!
//! - **Cache:** `settings` key `premium.state` (`{entitled, source: apple|google|web, expiresMs,
//!   checkedMs}`), held in memory from [`load`] on, so [`active`] never reads the database. Never a
//!   secret.
//! - **Clock guard:** `premium.clockHigh` is the latest wall-clock time the engine has seen,
//!   raised on every status read and background run. A clock more than 5 min below it makes the
//!   cache stale: not entitled until a network check succeeds. A successful check sets the mark to
//!   the device clock again (a clock that once ran ahead is not locked out for good) and moves the
//!   expiry onto the device clock by the server's `Date`, so a clock set back while online does
//!   not stretch the period.
//! - **Secrets:** the install id (`premium.installId`, plan Ruling 2), the web customer id
//!   (`premium.customer`) and the last accepted store receipt (`premium.receipt`, re-sent on a
//!   re-check, Ruling 3) live in the engine's [`SecretStore`](crate::SecretStore) under keys no
//!   account id can take (`acc_…`), and every one read or made is scrubbed out of the engine's
//!   log lines ([`Premium::scrub`]) and errors.
//! - **Web sign-in** (Rulings 4, 12): a mailed code proves the email; only then does the engine
//!   hold the customer id. The first status call after the code registers this install
//!   (`register=1`); every later check omits it, because the server's register path takes a
//!   revoked client back with no limit check. `premium.webRegister` (a flag, not a secret) keeps
//!   that first call pending across a failed attempt.

use crate::billing_client::{self as bc, ClientInfo, Fail, Replaced};
use crate::db::{lock, Engine, Shared};
use crate::events;
use crate::rpc::{parse, RpcError};
use crate::settings::{get_in, put_in, PREMIUM_CLOCK_HIGH, PREMIUM_STATE, PREMIUM_WEB_REGISTER};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::sync::{Mutex, RwLock};

const INSTALL_ID: &str = "premium.installId";
const CUSTOMER: &str = "premium.customer";
const RECEIPT: &str = "premium.receipt";

/// How far below the latest time seen the clock may be before the cache is stale.
const DRIFT_MS: i64 = 5 * 60_000;
/// Ruling 3: a cached answer is re-checked at most this often (and always once it expired).
const RECHECK_MS: i64 = 12 * 3_600_000;
/// The latest time seen is written to `settings` when it moved at least this far.
const PERSIST_STEP_MS: i64 = 60_000;
/// A server `Date` this far from the device clock moves the expiry onto the device clock.
const SKEW_MS: i64 = 60_000;

const APPLE: &str = "apple";
const GOOGLE: &str = "google";
const WEB: &str = "web";

/// The cached answer, as `premium.state` stores it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cached {
    entitled: bool,
    #[serde(default)]
    source: Option<String>,
    /// On the device clock (see the module doc).
    #[serde(default)]
    expires_ms: i64,
    /// When the server last gave a definite answer; 0: never.
    #[serde(default)]
    checked_ms: i64,
}

impl Cached {
    fn not_entitled(checked_ms: i64) -> Cached {
        Cached { entitled: false, source: None, expires_ms: 0, checked_ms }
    }

    fn store_source(&self) -> Option<&'static str> {
        match self.source.as_deref() {
            Some(APPLE) => Some(APPLE),
            Some(GOOGLE) => Some(GOOGLE),
            _ => None,
        }
    }
}

#[derive(Default)]
struct State {
    cached: Cached,
    high_water_ms: i64,
    persisted_high_ms: i64,
}

/// The engine's Premium state, in [`Shared`].
#[derive(Default)]
pub(crate) struct Premium {
    state: Mutex<State>,
    /// Serializes everything that calls the server or writes the cache. Never held by [`active`],
    /// so a 15 s check does not hold up a message open.
    checks: Mutex<()>,
    /// Makes the install id once. Its own lock, never `checks`: the native purchase code asks for
    /// the id right before the store sheet, and must not wait out a network check.
    minting: Mutex<()>,
    /// The secrets to scrub out of log lines and errors.
    scrub: RwLock<Vec<String>>,
    #[cfg(debug_assertions)]
    clock: Mutex<Option<i64>>,
}

impl Premium {
    /// `line` with every Premium secret the engine has read or made replaced.
    pub(crate) fn scrub<'a>(&self, line: &'a str) -> Cow<'a, str> {
        let list = self.scrub.read().unwrap_or_else(|p| p.into_inner());
        if list.is_empty() {
            return Cow::Borrowed(line);
        }
        let refs: Vec<&str> = list.iter().map(String::as_str).collect();
        Cow::Owned(mailvault_core::secret_scrub::scrub(line, &refs))
    }

    fn remember(&self, secret: &str) {
        if secret.is_empty() {
            return;
        }
        let mut list = self.scrub.write().unwrap_or_else(|p| p.into_inner());
        if !list.iter().any(|s| s == secret) {
            list.push(secret.to_string());
        }
    }
}

fn now(shared: &Shared) -> i64 {
    #[cfg(debug_assertions)]
    if let Some(t) = *lock(&shared.premium.clock) {
        return t;
    }
    let _ = shared;
    crate::compose::now_ms()
}

fn entitled_at(st: &State, now: i64) -> bool {
    let c = &st.cached;
    c.entitled && now < c.expires_ms && now >= st.high_water_ms - DRIFT_MS
}

/// Premium now: the cached answer is entitled, unexpired, and the clock is not more than 5 min
/// below the latest time seen. A memory read (the message body calls it on every open).
pub(crate) fn active(shared: &Shared) -> bool {
    let now = now(shared);
    let mut st = lock(&shared.premium.state);
    st.high_water_ms = st.high_water_ms.max(now);
    entitled_at(&st, now)
}

/// `{premium, source, expiresMs}`; `source` and `expiresMs` are null unless `premium`.
fn status_json(shared: &Shared) -> Value {
    let on = active(shared);
    let st = lock(&shared.premium.state);
    if on {
        json!({ "premium": true, "source": st.cached.source, "expiresMs": st.cached.expires_ms })
    } else {
        json!({ "premium": false, "source": null, "expiresMs": null })
    }
}

/// Reads the cache and the latest time seen into memory. At open; a value that does not read is
/// not entitled.
pub(crate) fn load(shared: &Shared) {
    let read = shared.read(|c| Ok((get_in(c, PREMIUM_STATE)?, get_in(c, PREMIUM_CLOCK_HIGH)?)));
    let (state, high) = match read {
        Ok(v) => v,
        Err(e) => {
            shared.log(&format!("[premium] reading the cache: {e}"));
            (None, None)
        }
    };
    let cached = state.and_then(|s| serde_json::from_str::<Cached>(&s).ok()).unwrap_or_default();
    let high: i64 = high.and_then(|h| h.parse().ok()).unwrap_or(0);
    let now = now(shared);
    let mut st = lock(&shared.premium.state);
    st.cached = cached;
    st.persisted_high_ms = high;
    st.high_water_ms = high.max(now);
}

/// Raises the latest time seen to now and writes it when it moved a minute or more. Every status
/// read and every background run.
pub(crate) fn observe_clock(shared: &Shared) {
    let now = now(shared);
    let high = {
        let mut st = lock(&shared.premium.state);
        st.high_water_ms = st.high_water_ms.max(now);
        if st.high_water_ms - st.persisted_high_ms < PERSIST_STEP_MS {
            return;
        }
        st.high_water_ms
    };
    match shared.write(|c| put_in(c, PREMIUM_CLOCK_HIGH, &high.to_string())) {
        Ok(()) => {
            let mut st = lock(&shared.premium.state);
            st.persisted_high_ms = st.persisted_high_ms.max(high);
        }
        Err(e) => shared.log(&format!("[premium] saving the clock mark: {e}")),
    }
}

/// Stores `new` as the cached answer. `answered`: the device time of the definite server answer
/// it comes from, to which the latest time seen goes back (`None` for a local change such as a
/// sign-out, which leaves the mark). Memory follows the committed write; the page hears
/// `mobile.premium.changed` when the status changed.
fn record(shared: &Shared, new: Cached, answered: Option<i64>) -> Result<(), RpcError> {
    let before = status_json(shared);
    let text = serde_json::to_string(&new).map_err(|e| RpcError::Internal(e.to_string()))?;
    shared
        .write(|c| {
            put_in(c, PREMIUM_STATE, &text)?;
            match answered {
                Some(t) => put_in(c, PREMIUM_CLOCK_HIGH, &t.to_string()),
                None => Ok(()),
            }
        })
        .map_err(|e| RpcError::Internal(e.to_string()))?;
    {
        let mut st = lock(&shared.premium.state);
        st.cached = new;
        if let Some(t) = answered {
            st.high_water_ms = t;
            st.persisted_high_ms = t;
        }
    }
    let after = status_json(shared);
    if after != before {
        shared.emit(events::PREMIUM_CHANGED, after);
    }
    Ok(())
}

fn cached(shared: &Shared) -> Cached {
    lock(&shared.premium.state).cached.clone()
}

/// A store or web expiry on the device clock: the server's own clock (`Date`) says how far the
/// device's is off.
fn device_expiry(expires_ms: i64, server_ms: Option<i64>, now: i64) -> i64 {
    match server_ms {
        Some(s) if (s - now).abs() > SKEW_MS => expires_ms - (s - now),
        _ => expires_ms,
    }
}

fn fail(f: Fail) -> RpcError {
    RpcError::Premium(match f {
        Fail::Network => "NETWORK",
        Fail::RateLimited => "RATE_LIMITED",
        Fail::Refused => "REFUSED",
        Fail::CodeWrong => "CODE_WRONG",
        Fail::CodeExpired => "CODE_EXPIRED",
        Fail::InstallLimit => "INSTALL_LIMIT",
    })
}

// ── Secrets ─────────────────────────────────────────────────────────────────

fn secret_err(shared: &Shared, what: &str, e: String) -> RpcError {
    RpcError::Internal(format!("secret store ({what}): {}", shared.premium.scrub(&e)))
}

fn secret_get(shared: &Shared, key: &str) -> Result<Option<String>, RpcError> {
    let v = shared.secrets().get(key).map_err(|e| secret_err(shared, key, e))?;
    if let Some(v) = &v {
        shared.premium.remember(v);
    }
    Ok(v)
}

fn secret_set(shared: &Shared, key: &str, value: &str) -> Result<(), RpcError> {
    shared.premium.remember(value);
    shared.secrets().set(key, value).map_err(|e| secret_err(shared, key, e))
}

fn secret_delete(shared: &Shared, key: &str) -> Result<(), RpcError> {
    shared.secrets().delete(key).map_err(|e| secret_err(shared, key, e))
}

/// This install's id: a random UUID made on first use (Ruling 2), once (`minting`). A secret store
/// that cannot be read (a locked keychain) is an error, never a reason to make a second id.
fn install_id(shared: &Shared) -> Result<String, RpcError> {
    let _once = lock(&shared.premium.minting);
    if let Some(id) = secret_get(shared, INSTALL_ID)?.filter(|s| !s.is_empty()) {
        return Ok(id);
    }
    let id = mailvault_core::people::model::new_id();
    secret_set(shared, INSTALL_ID, &id)?;
    Ok(id)
}

/// The last store receipt the server accepted.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "lowercase")]
enum Receipt {
    Apple { jws: String },
    Google {
        token: String,
        #[serde(rename = "productId")]
        product_id: String,
    },
}

impl Receipt {
    fn source(&self) -> &'static str {
        match self {
            Receipt::Apple { .. } => APPLE,
            Receipt::Google { .. } => GOOGLE,
        }
    }

    fn secret(&self) -> &str {
        match self {
            Receipt::Apple { jws } => jws,
            Receipt::Google { token, .. } => token,
        }
    }
}

fn stored_receipt(shared: &Shared) -> Result<Option<Receipt>, RpcError> {
    let Some(text) = secret_get(shared, RECEIPT)? else { return Ok(None) };
    let r = serde_json::from_str::<Receipt>(&text).ok();
    if let Some(r) = &r {
        shared.premium.remember(r.secret());
    }
    Ok(r)
}

// ── Checks ──────────────────────────────────────────────────────────────────

/// One source's answer.
enum Check {
    Entitled { source: &'static str, expires_ms: i64 },
    /// A definite no.
    Not { source: &'static str },
    /// Web: Premium, but this install lost its place to another device.
    Replaced,
    /// Store: the server says the receipt is invalid.
    Refused { source: &'static str },
    /// No answer.
    Failed(Fail),
}

/// `restore` only on the user's own verify call. The refresh re-post never sends it: once the
/// server has put this install in the purchase's set a plain check answers, and an install the
/// server no longer counts (idle 30 days) must take a place back through Restore, not silently.
/// `app_transaction` (Apple's account proof) goes along only with `restore`; it is never stored.
fn check_store(receipt: &Receipt, install: &str, now: i64, restore: bool, app_transaction: Option<&str>) -> Check {
    let answer = match receipt {
        Receipt::Apple { jws } => bc::verify_apple(jws, install, restore, app_transaction.filter(|_| restore)),
        Receipt::Google { token, product_id } => bc::verify_google(token, product_id, install, restore),
    };
    let source = receipt.source();
    match answer {
        Ok(a) => {
            let expires_ms = device_expiry(a.expires_ms, a.server_ms, now);
            if a.entitled && expires_ms > now {
                Check::Entitled { source, expires_ms }
            } else {
                Check::Not { source }
            }
        }
        Err(Fail::Refused) => Check::Refused { source },
        Err(f) => Check::Failed(f),
    }
}

/// The web subscription's answer, and the device a registering call replaced. A definite answer
/// ends a pending registration.
fn check_web(shared: &Shared, customer: &str, install: &str, info: Option<&ClientInfo>, now: i64) -> (Check, Option<Replaced>) {
    // A pending registration carries what the sign-in named this phone (an older flag, "1", none).
    let register = match info {
        Some(i) => Some(i.clone()),
        None => shared
            .read(|c| get_in(c, PREMIUM_WEB_REGISTER))
            .ok()
            .flatten()
            .map(|v| serde_json::from_str::<ClientInfo>(&v).unwrap_or_else(|_| ClientInfo::phone(None, None, None))),
    };
    let w = match bc::web_status(customer, install, register.as_ref()) {
        Ok(w) => w,
        Err(f) => return (Check::Failed(f), None),
    };
    if register.is_some() {
        if let Err(e) = shared.write(|c| c.execute("DELETE FROM settings WHERE key = ?1", [PREMIUM_WEB_REGISTER]).map(|_| ())) {
            shared.log(&format!("[premium] clearing the pending registration: {e}"));
        }
    }
    let check = if w.granted {
        // Web entitlement is the server's `clientAccessGranted` only, until `currentPeriodEnd`.
        match w.period_end_ms.map(|e| device_expiry(e, w.server_ms, now)) {
            Some(expires_ms) if expires_ms > now => Check::Entitled { source: WEB, expires_ms },
            _ => Check::Not { source: WEB },
        }
    } else if w.premium_access {
        Check::Replaced
    } else {
        Check::Not { source: WEB }
    };
    (check, w.replaced)
}

/// Folds the answers into the cache. An entitled answer wins (the latest expiry); otherwise a
/// definite no from the cached source clears it and a failed check keeps it. The error, if any:
/// a replaced device first, then a refused receipt, then the first failure.
fn settle(shared: &Shared, checks: &[Check], now: i64) -> Result<(), RpcError> {
    let best = checks
        .iter()
        .filter_map(|c| match c {
            Check::Entitled { source, expires_ms } => Some((*source, *expires_ms)),
            _ => None,
        })
        .max_by_key(|(_, e)| *e);
    let current = cached(shared);
    let answered = checks.iter().any(|c| !matches!(c, Check::Failed(_)));
    if let Some((source, expires_ms)) = best {
        record(shared, Cached { entitled: true, source: Some(source.into()), expires_ms, checked_ms: now }, Some(now))?;
        return Ok(());
    }
    let said_no = |s: &str| {
        checks.iter().any(|c| match c {
            Check::Not { source } | Check::Refused { source } => *source == s,
            Check::Replaced => s == WEB,
            _ => false,
        })
    };
    if answered {
        let keep = current.entitled && current.source.as_deref().is_some_and(|s| !said_no(s));
        if !keep {
            record(shared, Cached::not_entitled(now), Some(now))?;
        }
    }
    if checks.iter().any(|c| matches!(c, Check::Replaced)) {
        return Err(RpcError::Premium("DEVICE_REPLACED"));
    }
    if checks.iter().any(|c| matches!(c, Check::Refused { .. })) {
        return Err(RpcError::Premium("REFUSED"));
    }
    match checks.iter().find_map(|c| if let Check::Failed(f) = c { Some(*f) } else { None }) {
        Some(f) => Err(fail(f)),
        None => Ok(()),
    }
}

// ── RPCs ────────────────────────────────────────────────────────────────────

/// `mobile.premium.status {}` -> `{premium, source, expiresMs}`. No network.
pub(crate) fn status(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    let shared = engine.shared();
    observe_clock(shared);
    Ok(status_json(shared))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefreshParams {
    #[serde(default)]
    force: bool,
}

/// `mobile.premium.refresh {force?}` -> status. Re-checks with the server (Ruling 3) when `force`,
/// when the cache expired or the clock is stale, when no definite answer was had yet, or when the
/// last one is 12 h old; otherwise answers from the cache. Errors: `NETWORK`/`RATE_LIMITED` (the
/// cache stays), `DEVICE_REPLACED`, `REFUSED` (a stored receipt the server no longer takes).
pub(crate) fn refresh(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: RefreshParams = parse(params)?;
    let shared = engine.shared();
    let _one = lock(&shared.premium.checks);
    observe_clock(shared);
    let now = now(shared);
    let receipt = stored_receipt(shared)?;
    let customer = secret_get(shared, CUSTOMER)?.filter(|s| !s.is_empty());
    let current = cached(shared);
    if receipt.is_none() && customer.is_none() {
        if current.entitled {
            record(shared, Cached::not_entitled(current.checked_ms), None)?;
        }
        return Ok(status_json(shared));
    }
    let stale = {
        let st = lock(&shared.premium.state);
        now < st.high_water_ms - DRIFT_MS
    };
    let due = p.force
        || stale
        || current.checked_ms == 0
        || now - current.checked_ms >= RECHECK_MS
        || now < current.checked_ms - DRIFT_MS
        || (current.entitled && now >= current.expires_ms);
    if !due {
        return Ok(status_json(shared));
    }
    let install = install_id(shared)?;
    let mut checks = Vec::new();
    if let Some(r) = &receipt {
        let c = check_store(r, &install, now, false, None);
        if matches!(c, Check::Refused { .. }) {
            secret_delete(shared, RECEIPT)?;
        }
        checks.push(c);
    }
    if let Some(customer) = &customer {
        checks.push(check_web(shared, customer, &install, None, now).0);
    }
    settle(shared, &checks, now)?;
    Ok(status_json(shared))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyParams {
    platform: String,
    #[serde(default)]
    jws: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    product_id: Option<String>,
    /// The user tapped Restore: the receipt may name another install.
    #[serde(default)]
    restore: bool,
    /// Apple, with `restore`: the StoreKit 2 AppTransaction JWS, the server's proof that this
    /// phone is signed into the purchasing Apple account. Sent by the native code (Task 6).
    #[serde(default)]
    app_transaction: Option<String>,
}

fn present(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}

/// `mobile.premium.verify {platform: "apple", jws}` or `{platform: "google", token, productId}`,
/// each with an optional `restore: true` (Restore Purchases: bind a receipt bought elsewhere;
/// Apple adds `appTransaction`, the AppTransaction JWS, as proof of the same account) -> status. The server's yes or no becomes the cache; an accepted receipt is kept for re-checks.
/// `REFUSED` (an invalid receipt) ends a store entitlement at once; `NETWORK`/`RATE_LIMITED` keep
/// the cache. `INSTALL_LIMIT` (a Restore of a purchase already on its most installs) keeps the
/// cache and any stored receipt: the receipt is valid, only this install was not added, so it is
/// not a refusal. A web entitlement is not touched by a store answer.
///
/// A receipt that is not the stored one (the native listener hands over every transaction, an
/// older or refunded one too) replaces it only when it is entitled. When it is not, and the stored
/// receipt of the same store is what Premium stands on, the stored one is checked again and that
/// answer decides: an expired earlier period never ends a live subscription.
pub(crate) fn verify(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: VerifyParams = parse(params)?;
    let receipt = match p.platform.as_str() {
        APPLE => Receipt::Apple { jws: present(p.jws).ok_or_else(|| RpcError::Invalid("apple needs jws".into()))? },
        GOOGLE => Receipt::Google {
            token: present(p.token).ok_or_else(|| RpcError::Invalid("google needs token".into()))?,
            product_id: present(p.product_id).ok_or_else(|| RpcError::Invalid("google needs productId".into()))?,
        },
        _ => return Err(RpcError::Invalid("platform is \"apple\" or \"google\"".into())),
    };
    let app_transaction = present(p.app_transaction);
    let shared = engine.shared();
    shared.premium.remember(receipt.secret());
    if let Some(a) = &app_transaction {
        shared.premium.remember(a);
    }
    let _one = lock(&shared.premium.checks);
    observe_clock(shared);
    let now = now(shared);
    let install = install_id(shared)?;
    let mut check = check_store(&receipt, &install, now, p.restore, app_transaction.as_deref());
    let refused = matches!(check, Check::Refused { .. });
    if let Check::Failed(f) = check {
        // No answer (or the install limit): the cache and any stored receipt stay, and the caller
        // must not take the purchase as accepted.
        return Err(fail(f));
    }
    let stored = stored_receipt(shared)?;
    let source = receipt.source();
    let same = stored.as_ref().is_some_and(|r| r.source() == source && r.secret() == receipt.secret());
    let current = cached(shared);
    let save = |r: &Receipt| -> Result<(), RpcError> {
        let text = serde_json::to_string(r).map_err(|e| RpcError::Internal(e.to_string()))?;
        secret_set(shared, RECEIPT, &text)
    };
    if matches!(check, Check::Entitled { .. }) {
        save(&receipt)?;
    } else if same {
        if refused {
            secret_delete(shared, RECEIPT)?;
        }
    } else if let Some(old) = stored.as_ref().filter(|r| r.source() == source) {
        // Another receipt of this store said no. When the stored one is what Premium stands on, it
        // answers for its store instead: it alone can end that entitlement.
        if current.entitled && current.source.as_deref() == Some(source) {
            check = check_store(old, &install, now, false, None);
            if matches!(check, Check::Refused { .. }) {
                secret_delete(shared, RECEIPT)?;
            }
        }
    } else if stored.is_none() && !refused {
        // Nothing stored: a receipt the server knows is kept for re-checks (it answers that
        // subscription's current state, a renewal too).
        save(&receipt)?;
    }
    // A store answer speaks for the store: a web entitlement stays (and the later expiry wins).
    let mut checks = vec![check];
    if current.source.as_deref() == Some(WEB) && entitled_now(shared, now) {
        checks.push(Check::Entitled { source: WEB, expires_ms: current.expires_ms });
    }
    settle(shared, &checks, now)?;
    // The verdict on this receipt, whatever else keeps Premium on.
    if refused {
        return Err(RpcError::Premium("REFUSED"));
    }
    Ok(status_json(shared))
}

fn entitled_now(shared: &Shared, now: i64) -> bool {
    entitled_at(&lock(&shared.premium.state), now)
}

/// StoreKit's `appAccountToken` for an install: the first 16 bytes of
/// `SHA-256("mailvault/appAccountToken/v1:" + lower-case id)` as an RFC 9562 version 8 UUID.
/// One way: anyone holding a receipt can read its token, and the install id posted with it is
/// what proves the buying install, so the token must not give the id away. The billing server
/// (`website/api/store-billing.js` `appleAccountToken`) makes the same value; both pin a vector.
pub fn apple_account_token(install_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("mailvault/appAccountToken/v1:{}", install_id.to_lowercase()).as_bytes());
    let mut b = [0u8; 16];
    b.copy_from_slice(&digest[..16]);
    b[6] = (b[6] & 0x0f) | 0x80;
    b[8] = (b[8] & 0x3f) | 0x80;
    let x: String = b.iter().map(|v| format!("{v:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &x[..8], &x[8..12], &x[12..16], &x[16..20], &x[20..])
}

/// `mobile.premium.installId {}` -> `{installId, appAccountToken}`: for the native purchase code
/// (StoreKit buys with `appAccountToken`, Play hashes the id into `obfuscatedAccountId`). The one
/// reply that carries the id.
pub(crate) fn install(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    let id = install_id(engine.shared())?;
    Ok(json!({ "appAccountToken": apple_account_token(&id), "installId": id }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartParams {
    email: String,
    /// The page's language, so the mailed code reads in it. A short language tag or nothing.
    #[serde(default)]
    lang: Option<String>,
}

fn email(raw: &str) -> Result<String, RpcError> {
    let e = raw.trim();
    if e.is_empty() || e.len() > 320 || !e.contains('@') {
        return Err(RpcError::Invalid("email is not an address".into()));
    }
    Ok(e.to_string())
}

/// `mobile.premium.webSignIn.start {email, lang?}` -> `{ok: true}`: the server mails a code (it answers
/// the same whether or not the address subscribes). `RATE_LIMITED`, `NETWORK`.
pub(crate) fn sign_in_start(_engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: StartParams = parse(params)?;
    let email = email(&p.email)?;
    let lang = p.lang.as_deref().map(str::trim).filter(|l| !l.is_empty() && l.len() <= 16 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    match bc::signin_start(&email, lang) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(Fail::Refused) => Err(RpcError::Invalid("email is not an address".into())),
        Err(f) => Err(fail(f)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignInParams {
    email: String,
    code: String,
    /// What the account's device list calls this phone (default "MailVault for iPhone" /
    /// "MailVault for Android").
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    os_version: Option<String>,
}

/// `mobile.premium.webSignIn.verify {email, code, clientName?, appVersion?, osVersion?}` -> status,
/// plus `replacedClient: {clientName, platform, lastSeenMs}` when this sign-in signed another
/// device out (Ruling 12). Only a right code gives the engine the customer id; it goes to the
/// secret store and this install registers with the account. `CODE_WRONG`, `CODE_EXPIRED`,
/// `RATE_LIMITED`, `NETWORK` (the code was right: the next refresh finishes the registration),
/// `DEVICE_REPLACED`. An account with no Premium answers the status (`premium` from any store
/// purchase) and is not kept.
pub(crate) fn sign_in_verify(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SignInParams = parse(params)?;
    let email = email(&p.email)?;
    let code = p.code.trim().to_string();
    if code.is_empty() || code.len() > 32 {
        return Err(RpcError::Invalid("code is not a sign-in code".into()));
    }
    let shared = engine.shared();
    let _one = lock(&shared.premium.checks);
    observe_clock(shared);
    let customer = bc::signin_verify(&email, &code).map_err(|f| match f {
        // The server refused the request without judging the code (a malformed address).
        Fail::Refused => RpcError::Invalid("the server refused the sign-in request".into()),
        f => fail(f),
    })?;
    secret_set(shared, CUSTOMER, &customer)?;
    let info = ClientInfo::phone(present(p.client_name), present(p.app_version), present(p.os_version));
    // The pending registration keeps the names, so a later refresh that finishes it registers the
    // phone as this call would (no secret in it).
    let pending = serde_json::to_string(&info).map_err(|e| RpcError::Internal(e.to_string()))?;
    shared.write(|c| put_in(c, PREMIUM_WEB_REGISTER, &pending)).map_err(|e| RpcError::Internal(e.to_string()))?;
    let install = install_id(shared)?;
    let now = now(shared);
    let (check, replaced) = check_web(shared, &customer, &install, Some(&info), now);
    match check {
        // The registration stays pending: the next refresh sends it.
        Check::Failed(f) => return Err(fail(f)),
        // No Premium on that account: nothing to keep.
        Check::Not { .. } => secret_delete(shared, CUSTOMER)?,
        _ => {}
    }
    let lost_place = matches!(check, Check::Replaced);
    let mut checks = vec![check];
    let current = cached(shared);
    if let Some(source) = current.store_source().filter(|_| entitled_now(shared, now)) {
        // A sign-in speaks for the web: a store entitlement stays.
        checks.push(Check::Entitled { source, expires_ms: current.expires_ms });
    }
    settle(shared, &checks, now)?;
    if lost_place {
        return Err(RpcError::Premium("DEVICE_REPLACED"));
    }
    let mut reply = status_json(shared);
    if let Some(r) = replaced {
        reply["replacedClient"] = json!({ "clientName": r.client_name, "platform": r.platform, "lastSeenMs": r.last_seen_ms });
    }
    Ok(reply)
}

/// `mobile.premium.webSignOut {}` -> status: forgets the customer id; a web entitlement ends, a
/// store one stays.
pub(crate) fn sign_out(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    let shared = engine.shared();
    let _one = lock(&shared.premium.checks);
    secret_delete(shared, CUSTOMER)?;
    shared
        .write(|c| c.execute("DELETE FROM settings WHERE key = ?1", [PREMIUM_WEB_REGISTER]).map(|_| ()))
        .map_err(|e| RpcError::Internal(e.to_string()))?;
    let current = cached(shared);
    if current.source.as_deref() == Some(WEB) {
        record(shared, Cached::not_entitled(current.checked_ms), None)?;
    }
    Ok(status_json(shared))
}

// ── Test seams (debug builds only) ─────────────────────────────────────────

#[cfg(debug_assertions)]
impl Engine {
    /// Tests: Premium's clock reads `now_ms` instead of the wall clock (`None`: the wall clock).
    #[doc(hidden)]
    pub fn set_premium_clock_for_tests(&self, now_ms: Option<i64>) {
        *lock(&self.shared().premium.clock) = now_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_account_token_is_a_one_way_uuid_of_the_install_id() {
        // Same vectors as website/__tests__/store-billing.test.js.
        assert_eq!(apple_account_token("3f1c2b7a-9d4e-4c51-8a2f-6b0e5d9c1a77"), "5d24a09b-88e1-8e7f-93d2-e47a42508791");
        assert_eq!(apple_account_token("3F2504E0-4F89-11D3-9A0C-0305E82C3301"), "5d5455f2-5303-8fc6-a255-dca43b552558");
        assert_eq!(apple_account_token("3F2504E0-4F89-11D3-9A0C-0305E82C3301"), apple_account_token("3f2504e0-4f89-11d3-9a0c-0305e82c3301"));
    }

    #[test]
    fn a_server_clock_far_off_moves_the_expiry_onto_the_device_clock() {
        let now = 1_000_000_000;
        assert_eq!(device_expiry(now + 3_600_000, None, now), now + 3_600_000);
        assert_eq!(device_expiry(now + 3_600_000, Some(now + 30_000), now), now + 3_600_000, "a few seconds of skew is noise");
        // The device clock was set a day back: the period ends a day earlier on it.
        assert_eq!(device_expiry(now + 3_600_000, Some(now + 86_400_000), now), now + 3_600_000 - 86_400_000);
        assert_eq!(device_expiry(now + 3_600_000, Some(now - 600_000), now), now + 3_600_000 + 600_000);
    }

    #[test]
    fn the_clock_guard_allows_five_minutes_of_drift() {
        let st = State { cached: Cached { entitled: true, source: Some(APPLE.into()), expires_ms: 10_000_000, checked_ms: 1 }, high_water_ms: 5_000_000, persisted_high_ms: 0 };
        assert!(entitled_at(&st, 5_000_000 - DRIFT_MS));
        assert!(!entitled_at(&st, 5_000_000 - DRIFT_MS - 1));
        assert!(!entitled_at(&st, 10_000_000));
    }

    #[test]
    fn a_receipt_round_trips_as_its_platform() {
        let r: Receipt = serde_json::from_str(r#"{"platform":"google","token":"t","productId":"p"}"#).unwrap();
        assert_eq!(r.source(), GOOGLE);
        assert_eq!(serde_json::to_value(&r).unwrap(), json!({ "platform": "google", "token": "t", "productId": "p" }));
        let a = Receipt::Apple { jws: "j".into() };
        assert_eq!(serde_json::to_value(&a).unwrap(), json!({ "platform": "apple", "jws": "j" }));
    }
}
