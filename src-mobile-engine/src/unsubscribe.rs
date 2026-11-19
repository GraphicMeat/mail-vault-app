//! Unsubscribe on the phone: `mobile.unsubscribe.list` and `mobile.unsubscribe.run`, the phone's
//! half of desktop's Settings > Unsubscribe (daemon `handlers/unsubscribe.rs`).
//!
//! Sync keeps each message's `List-Unsubscribe`, `List-Unsubscribe-Post` and
//! `Authentication-Results` (`messages.unsub_json`, only when it has a List-Unsubscribe; IMAP and
//! JMAP list them, Graph's list does not, so a Graph account lists no senders). A message synced
//! before this column has none until it is fetched again.
//!
//! `list {}`: `{senders: [{accountId, address, name, folder, lastMs, count, method}], history}`.
//! One sender per account and From address (case folded), described by its newest such message;
//! `count` counts messages once however many folders hold them. `method` is core's
//! [`plan`](mailvault_core::unsubscribe::plan), the one desktop uses: `one-click` only with a DKIM
//! pass claim, else `browser`, else `mailto`; a sender with none is left out. `history` is
//! core's `app_db::unsubscribe` history (newest first), kept in the phone's core `app.db`
//! (`net_activity.rs`).
//!
//! `run {accountId, address}`: unsubscribes from that sender's newest list message. One-click
//! POSTs `List-Unsubscribe=One-Click` through core's SSRF gate (`guarded_http`: https only, no
//! address on this phone's network, every redirect checked), shown on Network Activity as the
//! account's `unsubscribe`. A one-click that fails falls back to the list's web page, as desktop
//! does, and keeps its own `failed` row. Answers `{method, status, url, oneClickError}` with
//! `status` `ok` or `opened` (the page opens `url`: the web page, or the `mailto:` in Compose).
//! A sender with no list message is `INVALID`.

use crate::db::Engine;
use crate::rpc::RpcError;
use mailvault_core::app_db::unsubscribe::{self as store, Unsubscribe};
use mailvault_core::unsubscribe::{plan, UnsubscribeTargets, ONE_CLICK_BODY};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const ONE_CLICK_TIMEOUT: Duration = Duration::from_secs(15);

/// Core's [`plan`] as the phone follows it: the page opens a web link in the system browser only
/// when it is `https:` (core also offers an `http:` link, and admits nothing but `mailto:`,
/// `https:` and `http:` at all); a sender whose only web link is `http:` is unsubscribed by its
/// `mailto:`, or offers nothing.
fn phone_plan(list_unsubscribe: &str, post: Option<&str>, auth: Option<&str>) -> (Option<&'static str>, UnsubscribeTargets) {
    let (method, mut targets) = plan(list_unsubscribe, post, auth);
    if targets.http_url.as_deref().is_some_and(|u| !u.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("https://"))) {
        targets.http_url = None;
    }
    let method = match method {
        Some("browser") if targets.http_url.is_none() => targets.mailto.is_some().then_some("mailto"),
        m => m,
    };
    (method, targets)
}

/// What sync keeps of a message's list headers: `None` when it has no List-Unsubscribe.
pub(crate) fn unsub_json(h: &mailvault_core::imap::EmailHeader) -> Option<String> {
    let lu = h.list_unsubscribe.as_deref().map(str::trim).filter(|s| !s.is_empty())?;
    Some(
        json!({
            "listUnsubscribe": lu,
            "listUnsubscribePost": h.list_unsubscribe_post,
            "authenticationResults": h.authentication_results,
        })
        .to_string(),
    )
}

struct Headers {
    list_unsubscribe: String,
    post: Option<String>,
    auth: Option<String>,
}

fn headers(json_text: &str) -> Option<Headers> {
    let v: Value = serde_json::from_str(json_text).ok()?;
    let text = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string);
    Some(Headers { list_unsubscribe: text("listUnsubscribe")?, post: text("listUnsubscribePost"), auth: text("authenticationResults") })
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

pub(crate) fn list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    // SQLite gives the bare columns of the row MAX() picked: each sender's newest list message.
    let groups = engine
        .read(|c| {
            let mut st = c.prepare(
                "SELECT account_id, lower(from_address) AS addr, MAX(date_ms), from_name, folder, unsub_json,
                        COUNT(DISTINCT CASE WHEN message_id != '' THEN message_id ELSE folder || char(0) || uid END)
                 FROM messages
                 WHERE unsub_json IS NOT NULL AND from_address != '' AND local_deleted IS NOT 1
                 GROUP BY account_id, addr",
            )?;
            let rows = st.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .map_err(internal)?;
    let mut senders = Vec::new();
    for (account, address, last, name, folder, unsub, count) in groups {
        let Some(h) = headers(&unsub) else { continue };
        let (Some(method), _) = phone_plan(&h.list_unsubscribe, h.post.as_deref(), h.auth.as_deref()) else { continue };
        senders.push(json!({
            "accountId": account, "address": address, "name": name.trim(), "folder": folder,
            "lastMs": last, "count": count, "method": method,
        }));
    }
    senders.sort_by(|a, b| b["lastMs"].as_i64().cmp(&a["lastMs"].as_i64()));
    let history = engine.shared().net_log.read(|c| store::history(c, None)).map_err(internal)?;
    Ok(json!({ "senders": senders, "history": history }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    account_id: String,
    address: String,
}

/// The one-click POST (RFC 8058).
fn one_click(url: &str, account_email: String) -> Result<(), String> {
    crate::net::block_on(mailvault_core::net_activity::with_account(account_email, async {
        let response = mailvault_core::guarded_http::send_guarded(url, "unsubscribe", ONE_CLICK_TIMEOUT, true, |client, url| {
            client.post(url).header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(ONE_CLICK_BODY)
        })
        .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("http {}", response.status().as_u16()))
        }
    }))
}

pub(crate) fn run(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: RunParams = crate::rpc::parse(params)?;
    let address = p.address.trim().to_lowercase();
    let found = engine
        .read(|c| {
            c.query_row(
                "SELECT m.unsub_json, a.email FROM messages m JOIN accounts a ON a.id = m.account_id
                 WHERE m.account_id = ?1 AND lower(m.from_address) = ?2 AND m.unsub_json IS NOT NULL
                   AND m.local_deleted IS NOT 1
                 ORDER BY m.date_ms DESC LIMIT 1",
                [&p.account_id, &address],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
        })
        .map_err(internal)?;
    let Some((unsub, account_email)) = found else {
        return Err(RpcError::Invalid("no unsubscribe link from this sender".into()));
    };
    let h = headers(&unsub).ok_or_else(|| RpcError::Invalid("no unsubscribe link from this sender".into()))?;
    let (method, targets) = phone_plan(&h.list_unsubscribe, h.post.as_deref(), h.auth.as_deref());
    let mut method = method.ok_or_else(|| RpcError::Invalid("no unsubscribe link from this sender".into()))?;
    let mut status = "opened";
    let mut error = None;
    if method == "one-click" {
        match one_click(targets.one_click_url.as_deref().unwrap_or_default(), account_email) {
            Ok(()) => status = "ok",
            Err(e) => {
                // Not the error's text: reqwest's names the URL, whose token is the subscription's.
                engine.shared().log("[unsubscribe] one-click POST failed; offering the web page");
                method = "browser";
                error = Some(e);
            }
        }
    }
    let url = match method {
        "browser" => targets.http_url,
        "mailto" => targets.mailto,
        _ => None,
    };
    let now = mailvault_core::clock::now_ms();
    let row = |method: &str, status: &str| Unsubscribe {
        address: address.clone(),
        account_id: p.account_id.clone(),
        unsubscribed_at: now,
        method: method.into(),
        status: status.into(),
    };
    let mut rows = Vec::new();
    if error.is_some() {
        rows.push(row("one-click", "failed"));
    }
    rows.push(row(method, status));
    engine.shared().net_log.read(|c| rows.iter().try_for_each(|r| store::record(c, r))).map_err(internal)?;
    Ok(json!({ "method": method, "status": status, "url": url, "oneClickError": error }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page only ever opens an `https:` page: never `http:`, `javascript:` or `file:`.
    #[test]
    fn the_phone_opens_only_an_https_page() {
        let (m, t) = phone_plan("<https://list.test/u>", None, None);
        assert_eq!((m, t.http_url.as_deref()), (Some("browser"), Some("https://list.test/u")));
        let (m, t) = phone_plan("<http://list.test/u>", None, None);
        assert_eq!((m, t.http_url), (None, None), "an http page alone offers nothing");
        let (m, t) = phone_plan("<http://list.test/u>, <mailto:u@list.test?subject=stop>", None, None);
        assert_eq!((m, t.http_url, t.mailto.as_deref()), (Some("mailto"), None, Some("mailto:u@list.test?subject=stop")));
        for bad in ["<javascript:alert(1)>", "<file:///etc/passwd>", "<JAVASCRIPT:x>"] {
            let (m, t) = phone_plan(bad, None, None);
            assert_eq!((m, t.http_url, t.mailto), (None, None, None), "{bad}");
        }
        // One-click stays (its URL is https by core's rule).
        let (m, _) = phone_plan("<https://list.test/u>", Some("List-Unsubscribe=One-Click"), Some("mx; dkim=pass header.d=list.test"));
        assert_eq!(m, Some("one-click"));
    }
}
