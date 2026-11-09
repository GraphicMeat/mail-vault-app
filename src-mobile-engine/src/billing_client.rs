//! The engine's calls to the MailVault billing service (`website/api`): store receipt checks, the
//! web subscription status and the verified web sign-in. JSON over HTTPS with a 15 s limit, run
//! through [`net::block_on`](crate::net::block_on).
//!
//! The install id, the web customer id and receipts travel in these requests and nowhere else: a
//! failure is a [`Fail`] code, never reqwest's text (which quotes the URL, query and all), and a
//! reply is read into the few fields the engine uses, never kept or logged whole (the status
//! answer also carries the customer's email and every other device's client id).

use crate::net::block_on;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const BASE: &str = "https://mailvaultapp.com";
const TIMEOUT: Duration = Duration::from_secs(15);

/// Why a call gave no answer the engine can use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fail {
    /// No answer: no network, a timeout, a server error or a reply that does not read.
    Network,
    /// HTTP 429, or the server's `rate_limited`.
    RateLimited,
    /// The server read the request and said no (a 4xx): an invalid receipt, a bad email.
    Refused,
    /// signin/verify: the code is wrong.
    CodeWrong,
    /// signin/verify: the code is too old.
    CodeExpired,
}

/// A store's answer: `{entitled, source, expiresMs}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoreAnswer {
    pub entitled: bool,
    pub expires_ms: i64,
    /// The server's clock when it answered (`Date`), for the clock guard.
    pub server_ms: Option<i64>,
}

/// The device another sign-in signed out (`replacedClient`), without its client id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Replaced {
    pub client_name: Option<String>,
    pub platform: Option<String>,
    pub last_seen_ms: Option<i64>,
}

/// What the engine reads of `subscription-status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WebAnswer {
    /// `clientAccessGranted`: Premium and this install is one of the account's active clients.
    pub granted: bool,
    /// `premiumAccess`: the subscription grants Premium, whatever this install's place.
    pub premium_access: bool,
    /// `currentPeriodEnd` as epoch ms.
    pub period_end_ms: Option<i64>,
    pub replaced: Option<Replaced>,
    pub server_ms: Option<i64>,
}

/// What `register=1` sends beside the ids, so the account's device list names this phone.
#[derive(Debug, Clone, Default)]
pub(crate) struct ClientInfo {
    pub name: Option<String>,
    pub app_version: Option<String>,
    pub os_version: Option<String>,
}

impl ClientInfo {
    /// This phone, named "MailVault for iPhone" / "MailVault for Android" unless the page names it.
    pub(crate) fn phone(name: Option<String>, app_version: Option<String>, os_version: Option<String>) -> ClientInfo {
        let default = if platform() == "android" { "MailVault for Android" } else { "MailVault for iPhone" };
        ClientInfo { name: Some(name.unwrap_or_else(|| default.to_string())), app_version, os_version }
    }
}

/// The service's origin. Debug builds take `MV_BILLING_BASE` (tests point it at a loopback stub);
/// a release build always calls production.
fn base() -> String {
    #[cfg(debug_assertions)]
    if let Ok(b) = std::env::var("MV_BILLING_BASE") {
        if !b.trim().is_empty() {
            return b.trim().trim_end_matches('/').to_string();
        }
    }
    BASE.to_string()
}

pub(crate) fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "ios"
    }
}

/// One reply: status, the server's `Date`, and the body as JSON (`Null` when it does not read).
struct Reply {
    status: u16,
    server_ms: Option<i64>,
    body: Value,
}

/// Sends one request. Every transport failure is [`Fail::Network`]; the error itself is dropped
/// unread, since its text names the URL.
fn call(build: impl FnOnce(&reqwest::Client) -> reqwest::RequestBuilder) -> Result<Reply, Fail> {
    block_on(async move {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Fail::Network)?;
        let resp = build(&client).header("Accept", "application/json").send().await.map_err(|_| Fail::Network)?;
        let status = resp.status().as_u16();
        let server_ms = resp
            .headers()
            .get(reqwest::header::DATE)
            .and_then(|v| v.to_str().ok())
            .and_then(mailvault_core::maildir::header_date_secs)
            .map(|s| s * 1000);
        let bytes = resp.bytes().await.map_err(|_| Fail::Network)?;
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Ok(Reply { status, server_ms, body })
    })
}

/// 2xx is the caller's to read; 429 is a rate limit; any other 4xx a refusal; the rest (5xx,
/// 3xx: redirects are not followed) no answer.
fn classify(r: &Reply) -> Result<(), Fail> {
    match r.status {
        200..=299 => Ok(()),
        429 => Err(Fail::RateLimited),
        400..=499 => Err(Fail::Refused),
        _ => Err(Fail::Network),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreBody {
    entitled: bool,
    #[serde(default)]
    expires_ms: Option<f64>,
}

fn store_answer(r: Reply) -> Result<StoreAnswer, Fail> {
    classify(&r)?;
    let b: StoreBody = serde_json::from_value(r.body).map_err(|_| Fail::Network)?;
    Ok(StoreAnswer { entitled: b.entitled, expires_ms: b.expires_ms.map(|v| v as i64).unwrap_or(0), server_ms: r.server_ms })
}

/// `POST /api/billing/store/apple/verify {signedTransaction, installId[, restore: true]}`.
/// `restore` (the user tapped Restore) lets the server bind a receipt bought on another install
/// to this one; it is left out of the body otherwise.
pub(crate) fn verify_apple(jws: &str, install_id: &str, restore: bool) -> Result<StoreAnswer, Fail> {
    let url = format!("{}/api/billing/store/apple/verify", base());
    let mut body = json!({ "signedTransaction": jws, "installId": install_id });
    if restore {
        body["restore"] = json!(true);
    }
    store_answer(call(|c| c.post(url).json(&body))?)
}

/// `POST /api/billing/store/google/verify {purchaseToken, productId, installId[, restore: true]}`.
pub(crate) fn verify_google(token: &str, product_id: &str, install_id: &str, restore: bool) -> Result<StoreAnswer, Fail> {
    let url = format!("{}/api/billing/store/google/verify", base());
    let mut body = json!({ "purchaseToken": token, "productId": product_id, "installId": install_id });
    if restore {
        body["restore"] = json!(true);
    }
    store_answer(call(|c| c.post(url).json(&body))?)
}

/// Epoch ms of a status date: the ISO string mysql2 dates serialize to, or a number.
fn date_ms(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => crate::sync::rfc3339_ms(s),
        Value::Number(n) => n.as_f64().map(|f| f as i64),
        _ => None,
    }
}

fn text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// `GET /api/billing/subscription-status?customerId&clientId[&register=1&platform&appVersion&osVersion&clientName]`.
/// `client_id` is this install's id. `register` only on the first status call after a verified
/// sign-in code: the server's register path takes a revoked client back with no limit check.
/// Never by email (anyone can type one).
pub(crate) fn web_status(customer_id: &str, client_id: &str, register: Option<&ClientInfo>) -> Result<WebAnswer, Fail> {
    let mut url = url::Url::parse(&format!("{}/api/billing/subscription-status", base())).map_err(|_| Fail::Network)?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("customerId", customer_id).append_pair("clientId", client_id);
        if let Some(info) = register {
            q.append_pair("register", "1").append_pair("platform", platform());
            for (k, v) in [("appVersion", &info.app_version), ("osVersion", &info.os_version), ("clientName", &info.name)] {
                if let Some(v) = v {
                    q.append_pair(k, v);
                }
            }
        }
    }
    let r = call(|c| c.get(url))?;
    match r.status {
        200..=299 => {}
        429 => return Err(Fail::RateLimited),
        // A customer id the server no longer knows answers 200 with no subscription; any other
        // status is no answer.
        _ => return Err(Fail::Network),
    }
    let b = &r.body;
    if !b.is_object() {
        return Err(Fail::Network);
    }
    let replaced = b.get("replacedClient").filter(|v| v.is_object()).map(|v| Replaced {
        client_name: text(&v["clientName"]),
        platform: text(&v["platform"]),
        last_seen_ms: date_ms(&v["lastSeenAt"]),
    });
    Ok(WebAnswer {
        granted: b["clientAccessGranted"].as_bool().unwrap_or(false),
        premium_access: b["premiumAccess"].as_bool().unwrap_or(false),
        period_end_ms: date_ms(&b["currentPeriodEnd"]),
        replaced,
        server_ms: r.server_ms,
    })
}

/// `POST /api/billing/signin/start {email}`: the server mails a 6-digit code. `{ok: true}` whether
/// or not the address is a subscriber's.
pub(crate) fn signin_start(email: &str) -> Result<(), Fail> {
    let url = format!("{}/api/billing/signin/start", base());
    let body = json!({ "email": email });
    classify(&call(|c| c.post(url).json(&body))?)
}

/// `POST /api/billing/signin/verify {email, code}` -> the customer id. The server's `error` is
/// read whatever the HTTP status.
pub(crate) fn signin_verify(email: &str, code: &str) -> Result<String, Fail> {
    let url = format!("{}/api/billing/signin/verify", base());
    let body = json!({ "email": email, "code": code });
    let r = call(|c| c.post(url).json(&body))?;
    match r.body.get("error").and_then(Value::as_str) {
        Some("code_wrong") => return Err(Fail::CodeWrong),
        Some("code_expired") => return Err(Fail::CodeExpired),
        Some("rate_limited") => return Err(Fail::RateLimited),
        _ => {}
    }
    match classify(&r) {
        Ok(()) => text(&r.body["customerId"]).ok_or(Fail::Network),
        // A refusal that names no code reason: the code did not work.
        Err(Fail::Refused) => Err(Fail::CodeWrong),
        Err(f) => Err(f),
    }
}
