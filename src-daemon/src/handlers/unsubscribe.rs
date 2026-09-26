//! One-click unsubscribe (RFC 8058), the Settings > Unsubscribe page's data,
//! and BIMI sender logos.
//!
//! `unsubscribe` POSTs `List-Unsubscribe=One-Click` itself when the message
//! allows it, and otherwise answers which fallback the app should open (the
//! list's web page, or a prefilled compose for a `mailto:`). Every answer is
//! recorded in app.db (`app_db::unsubscribe`). `unsubscribe.senders` pages an
//! Insights snapshot (`handlers::insights::begin_snapshot`) rather than
//! scanning the header cache a second way.
use crate::export_fetch::send_guarded;
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg};
use crate::handlers::insights::{begin_snapshot, configured_account_ids};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use base64::Engine;
use mailvault_core::app_db::{self, unsubscribe::{self as store, Unsubscribe}};
use mailvault_core::unsubscribe::{self as parse, ONE_CLICK_BODY};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tracing::warn;

const ONE_CLICK_TIMEOUT: Duration = Duration::from_secs(15);
const BIMI_TIMEOUT: Duration = Duration::from_secs(10);
const BIMI_MAX_BYTES: usize = 64 * 1024;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const BIMI_TTL_MS: i64 = 7 * DAY_MS;
const BIMI_NEGATIVE_TTL_MS: i64 = DAY_MS;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The one-click request itself. Kept apart from the SSRF gate so a test can
/// send it to a loopback server the gate (rightly) refuses.
fn one_click_request(client: &reqwest::Client, url: reqwest::Url) -> reqwest::RequestBuilder {
    client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(ONE_CLICK_BODY)
}

async fn one_click_post(url: &str) -> Result<(), String> {
    let response = send_guarded(url, ONE_CLICK_TIMEOUT, true, one_click_request).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("http {}", response.status().as_u16()))
    }
}

/// How this message would be unsubscribed from: one-click only with a DKIM
/// pass claim (RFC 8058 needs the headers DKIM-covered; the app cannot
/// re-verify the signature itself), else the web page, else email.
fn plan(list_unsubscribe: &str, post: Option<&str>, auth: Option<&str>) -> (Option<&'static str>, parse::UnsubscribeTargets) {
    let targets = parse::parse(list_unsubscribe, post);
    let method = if targets.one_click_url.is_some() && auth.is_some_and(parse::dkim_pass) {
        Some("one-click")
    } else if targets.http_url.is_some() {
        Some("browser")
    } else if targets.mailto.is_some() {
        Some("mailto")
    } else {
        None
    };
    (method, targets)
}

async fn unsubscribe(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let account_id = opt_str_arg(params, "accountId").unwrap_or_default();
    let sender = opt_str_arg(params, "sender").unwrap_or_default();
    let list_unsubscribe = opt_str_arg(params, "listUnsubscribe").unwrap_or_default();
    let post = opt_str_arg(params, "listUnsubscribePost");
    let auth = opt_str_arg(params, "authenticationResults");
    let (method, targets) = plan(&list_unsubscribe, post.as_deref(), auth.as_deref());
    let mut method = method.ok_or_else(|| "This message has no unsubscribe link".to_string())?;
    let mut status = "opened";
    let mut error = None;
    if method == "one-click" {
        match one_click_post(targets.one_click_url.as_deref().unwrap_or_default()).await {
            Ok(()) => status = "ok",
            Err(e) => {
                warn!("[unsubscribe] one-click POST failed: {e}");
                // Its web page is the same list's own way out: open that
                // rather than leave the user with an error.
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
    let row = Unsubscribe {
        address: sender,
        account_id,
        unsubscribed_at: now_ms(),
        method: method.into(),
        status: status.into(),
    };
    let app_dir = state.app_dir.clone();
    blocking(move || app_db::with(&app_dir, |c| store::record(c, &row))).await??;
    Ok(json!({"method": method, "status": status, "url": url, "oneClickError": error}))
}

/// Subscription senders in snapshot rows: one entry per From address whose
/// mail carries List-Unsubscribe, described by its newest such message.
/// Rows are deduplicated per message, since a message kept in the vault and
/// still on the server arrives once from each.
fn senders_from_rows(rows: &[Value]) -> Vec<Value> {
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string);
    let mut seen = HashSet::new();
    let mut by_sender: BTreeMap<String, (u64, Value)> = BTreeMap::new();
    for row in rows {
        let (Some(list_unsubscribe), Some(address)) = (text(row, "listUnsubscribe"), text(&row["from"], "address")) else {
            continue;
        };
        let account = text(row, "accountId").unwrap_or_default();
        let identity = text(row, "messageId")
            .map(|m| format!("{account}\u{0}{m}"))
            .unwrap_or_else(|| format!("{account}\u{0}{}\u{0}{}", text(row, "mailbox").unwrap_or_default(), row["uid"]));
        if !seen.insert(identity) {
            continue;
        }
        let at = text(row, "receivedAt").or_else(|| text(row, "sentAt")).or_else(|| text(row, "messageDate"));
        let post = text(row, "listUnsubscribePost");
        let auth = text(row, "authenticationResults");
        let (method, _) = plan(&list_unsubscribe, post.as_deref(), auth.as_deref());
        let Some(method) = method else { continue };
        let key = address.to_lowercase();
        let entry = by_sender.entry(key.clone()).or_insert((0, Value::Null));
        entry.0 += 1;
        let newer = entry.1.is_null() || at.as_deref() > entry.1["lastAt"].as_str();
        if newer {
            entry.1 = json!({
                "address": key, "name": text(&row["from"], "name"), "accountId": account, "lastAt": at,
                "method": method, "listUnsubscribe": list_unsubscribe, "listUnsubscribePost": post,
                "authenticationResults": auth,
            });
        }
    }
    by_sender
        .into_values()
        .map(|(count, mut v)| {
            v["count"] = json!(count);
            v
        })
        .collect()
}

/// Page a whole Insights snapshot of `account_ids` into senders.
fn senders(state: &Arc<DaemonState>, account_id: Option<String>) -> Result<Value, String> {
    let account_ids = match account_id {
        Some(a) => vec![a],
        None => configured_account_ids(&state.app_dir)?,
    };
    if account_ids.is_empty() {
        return Ok(json!([]));
    }
    // A sync writing headers mid-walk makes a snapshot stale; that is a
    // reason to look again, not a failure to show.
    let mut attempt = 0;
    loop {
        attempt += 1;
        match read_snapshot(state, &account_ids) {
            Err(code) if code == "snapshotStale" && attempt < 3 => continue,
            other => return other.map(|rows| Value::Array(senders_from_rows(&rows))),
        }
    }
}

fn read_snapshot(state: &Arc<DaemonState>, account_ids: &[String]) -> Result<Vec<Value>, String> {
    let begin = begin_snapshot(state, account_ids);
    if begin["ok"] != true {
        return Err(begin["error"]["code"].as_str().unwrap_or("snapshotUnavailable").to_string());
    }
    let id = begin["snapshotId"].as_str().unwrap_or_default().to_string();
    let gen_fn = || crate::custody::generation(state);
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    let read = loop {
        match state.insights.read(&id, cursor.as_deref(), &gen_fn) {
            Ok(page) => {
                rows.extend(page["rows"].as_array().cloned().unwrap_or_default());
                cursor = page["nextCursor"].as_str().map(str::to_string);
                if cursor.is_none() {
                    break Ok(());
                }
            }
            Err(e) => break Err(e["code"].as_str().unwrap_or("snapshotUnavailable").to_string()),
        }
    };
    state.insights.release(&id);
    read.map(|()| rows)
}

/// Is this a response body a sender logo may be? SVG only (an `<img>` never
/// runs its scripts), under the cap.
fn svg_ok(content_type: &str, len: usize) -> bool {
    content_type.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("image/svg+xml") && len <= BIMI_MAX_BYTES
}

/// The logo for a domain: `Ok(None)` is a definitive "no logo" worth caching,
/// `Err` a failure that says nothing about the domain.
async fn fetch_bimi(domain: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(url) = mailvault_core::dns::bimi_logo_url_for(domain).await? else {
        return Ok(None);
    };
    let mut response = send_guarded(&url, BIMI_TIMEOUT, true, |c, u| c.get(u)).await?;
    let status = response.status();
    if status.is_server_error() {
        return Err(format!("http {}", status.as_u16()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !status.is_success() || !svg_ok(&content_type, response.content_length().unwrap_or(0) as usize) {
        return Ok(None);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("read failed: {e}"))? {
        body.extend_from_slice(&chunk);
        if !svg_ok(&content_type, body.len()) {
            return Ok(None);
        }
    }
    Ok(Some(body))
}

fn valid_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 253
        && domain.contains('.')
        && domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

async fn bimi_logo(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let domain = opt_str_arg(params, "domain").unwrap_or_default().trim().trim_end_matches('.').to_ascii_lowercase();
    let auth = opt_str_arg(params, "authenticationResults").unwrap_or_default();
    // The receiving server must say this message passed DMARC for exactly
    // this domain; the domain's policy is checked in `fetch_bimi`.
    if !valid_domain(&domain) || !parse::dmarc_pass_for(&auth, &domain) {
        return Ok(json!({"logo": null}));
    }
    let as_logo = |svg: Option<Vec<u8>>| {
        json!({"logo": svg.map(|b| format!("data:image/svg+xml;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))})
    };
    let app_dir = state.app_dir.clone();
    let key = domain.clone();
    if let Some(hit) = blocking(move || app_db::with(&app_dir, |c| store::bimi_get(c, &key, now_ms()))).await?? {
        return Ok(as_logo(hit));
    }
    let svg = match fetch_bimi(&domain).await {
        Ok(svg) => svg,
        Err(e) => {
            warn!("[bimi] {domain}: {e}");
            return Ok(json!({"logo": null}));
        }
    };
    let ttl = if svg.is_some() { BIMI_TTL_MS } else { BIMI_NEGATIVE_TTL_MS };
    let app_dir = state.app_dir.clone();
    let cached = svg.clone();
    blocking(move || app_db::with(&app_dir, |c| store::bimi_put(c, &domain, cached.as_deref(), now_ms() + ttl))).await??;
    Ok(as_logo(svg))
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "unsubscribe" => {
            if let Err(resp) = str_arg(&id, params, "listUnsubscribe") {
                return Some(resp);
            }
            done(id, unsubscribe(state, params).await)
        }
        "unsubscribe.history" => {
            let account_id = opt_str_arg(params, "accountId");
            let app_dir = state.app_dir.clone();
            done(
                id,
                blocking(move || {
                    app_db::with(&app_dir, |c| store::history(c, account_id.as_deref()))
                        .and_then(|rows| serde_json::to_value(rows).map_err(|e| e.to_string()))
                })
                .await
                .and_then(|r| r),
            )
        }
        "unsubscribe.senders" => {
            let account_id = opt_str_arg(params, "accountId");
            let state = Arc::clone(state);
            done(id, blocking(move || senders(&state, account_id)).await.and_then(|r| r))
        }
        "bimi_logo" => done(id, bimi_logo(state, params).await),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        (dir, s)
    }

    const LIST: &str = "<mailto:leave@list.test?subject=unsubscribe>, <https://list.test/u/1>";
    const PASS: &str = "mx.test; dkim=pass header.d=list.test; spf=pass";

    #[test]
    fn one_click_needs_the_post_header_and_a_dkim_pass() {
        let post = Some("List-Unsubscribe=One-Click");
        assert_eq!(plan(LIST, post, Some(PASS)).0, Some("one-click"));
        assert_eq!(plan(LIST, post, Some("mx.test; dkim=fail")).0, Some("browser"));
        assert_eq!(plan(LIST, post, None).0, Some("browser"));
        assert_eq!(plan(LIST, None, Some(PASS)).0, Some("browser"));
        assert_eq!(plan("<mailto:leave@list.test>", post, Some(PASS)).0, Some("mailto"));
        assert_eq!(plan("", post, Some(PASS)).0, None);
    }

    /// Without a DKIM pass the route never touches the network: it answers
    /// the browser fallback and records it.
    #[tokio::test]
    async fn without_dkim_the_route_answers_the_browser_fallback_and_records_it() {
        let (_dir, s) = st();
        let v = handle_request_for_test(&s, "unsubscribe", json!({
            "accountId": "acc", "sender": "News@List.test", "listUnsubscribe": LIST,
            "listUnsubscribePost": "List-Unsubscribe=One-Click", "authenticationResults": "mx.test; dkim=none",
        }))
        .await
        .result
        .unwrap();
        assert_eq!(v["method"], "browser");
        assert_eq!(v["url"], "https://list.test/u/1");
        let history = handle_request_for_test(&s, "unsubscribe.history", json!({"accountId": "acc"})).await.result.unwrap();
        assert_eq!(history[0]["address"], "news@list.test");
        assert_eq!(history[0]["method"], "browser");
        assert_eq!(history[0]["status"], "opened");
        let other = handle_request_for_test(&s, "unsubscribe.history", json!({"accountId": "other"})).await.result.unwrap();
        assert_eq!(other, json!([]));
    }

    #[tokio::test]
    async fn mailto_only_answers_the_mailto_uri() {
        let (_dir, s) = st();
        let v = handle_request_for_test(&s, "unsubscribe", json!({
            "accountId": "acc", "sender": "a@list.test", "listUnsubscribe": "<mailto:leave@list.test?subject=stop>",
        }))
        .await
        .result
        .unwrap();
        assert_eq!(v["method"], "mailto");
        assert_eq!(v["url"], "mailto:leave@list.test?subject=stop");
    }

    /// The SSRF gate stays on for one-click: a list URL on loopback is
    /// refused before any request, so the route falls back to the browser.
    #[tokio::test]
    async fn a_one_click_url_on_loopback_is_refused_and_falls_back() {
        assert!(one_click_post("https://127.0.0.1:9/u").await.is_err());
        assert!(one_click_post("http://list.test/u").await.unwrap_err().contains("refused scheme"));
        let (_dir, s) = st();
        let v = handle_request_for_test(&s, "unsubscribe", json!({
            "accountId": "acc", "sender": "a@list.test", "listUnsubscribe": "<https://127.0.0.1:9/u>",
            "listUnsubscribePost": "List-Unsubscribe=One-Click", "authenticationResults": PASS,
        }))
        .await
        .result
        .unwrap();
        assert_eq!(v["method"], "browser");
        assert!(v["oneClickError"].is_string(), "{v}");
    }

    /// The request the gate would send, sent straight to a loopback server:
    /// POST, form content type, the RFC 8058 body, no cookie.
    #[tokio::test]
    async fn the_one_click_request_is_a_form_post_of_the_rfc_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            while !String::from_utf8_lossy(&buf).ends_with(ONE_CLICK_BODY) {
                let n = sock.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await.unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });
        let client = reqwest::Client::new();
        let url = reqwest::Url::parse(&format!("http://{addr}/u/1?t=abc")).unwrap();
        let response = one_click_request(&client, url).send().await.unwrap();
        assert!(response.status().is_success());
        let request = server.await.unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(request.starts_with("POST /u/1?t=abc HTTP/1.1\r\n"), "{request}");
        assert!(lower.contains("content-type: application/x-www-form-urlencoded\r\n"), "{request}");
        assert!(!lower.contains("\r\ncookie:"), "{request}");
        assert!(request.ends_with("\r\n\r\nList-Unsubscribe=One-Click"), "{request}");
    }

    #[test]
    fn senders_dedupe_copies_and_describe_the_newest_message() {
        let row = |account: &str, mailbox: &str, uid: u32, mid: &str, at: &str, list: Option<&str>| {
            json!({"accountId": account, "mailbox": mailbox, "uid": uid, "messageId": mid, "receivedAt": at,
                "from": {"address": "News@Brand.test", "name": "Brand"}, "listUnsubscribe": list,
                "listUnsubscribePost": "List-Unsubscribe=One-Click", "authenticationResults": PASS})
        };
        let rows = vec![
            row("a", "INBOX", 1, "<1@b>", "2026-09-01T00:00:00Z", Some("<https://brand.test/u>")),
            // The same message's vault copy: counted once.
            row("a", "INBOX", 1, "<1@b>", "2026-09-01T00:00:00Z", Some("<https://brand.test/u>")),
            row("a", "INBOX", 2, "<2@b>", "2026-09-03T00:00:00Z", Some("<https://brand.test/u2>")),
            row("a", "INBOX", 3, "<3@b>", "2026-09-05T00:00:00Z", None),
            json!({"accountId": "a", "uid": 9, "from": {"address": "friend@x.test"}, "listUnsubscribe": null}),
        ];
        let senders = senders_from_rows(&rows);
        assert_eq!(senders.len(), 1);
        assert_eq!(senders[0]["address"], "news@brand.test");
        assert_eq!(senders[0]["count"], 2);
        assert_eq!(senders[0]["lastAt"], "2026-09-03T00:00:00Z");
        assert_eq!(senders[0]["listUnsubscribe"], "<https://brand.test/u2>");
        assert_eq!(senders[0]["method"], "one-click");
    }

    /// Through the real Insights snapshot: the sender shows under all
    /// accounts and its own, never under another account.
    #[tokio::test]
    async fn senders_route_is_scoped_by_account() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        std::fs::write(app_dir.path().join("accounts.json"), json!([{"id": "a"}, {"id": "b"}]).to_string()).unwrap();
        let seed = |account: &str, from: &str, list: Option<&str>| {
            crate::custody::with_conn(&s, |c| {
                use mailvault_core::custody::cache;
                cache::save_mailboxes(c, account, &json!({"mailboxes":[{"path": "INBOX"}]}).to_string())?;
                let emails = json!({"emails":[{"uid": 1, "messageId": format!("<1@{account}>"), "subject": "s",
                    "from": {"address": from}, "listUnsubscribe": list, "receivedAt": "2026-09-01T00:00:00Z"}]});
                cache::save_headers(c, account, "INBOX", &emails.to_string())
            })
            .unwrap();
        };
        seed("a", "news@brand.test", Some("<mailto:leave@brand.test>"));
        seed("b", "friend@x.test", None);
        let listed = |v: Value| v.as_array().unwrap().iter().map(|s| s["address"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let all = handle_request_for_test(&s, "unsubscribe.senders", json!({"accountId": null})).await.result.unwrap();
        assert_eq!(listed(all), vec!["news@brand.test"]);
        let a = handle_request_for_test(&s, "unsubscribe.senders", json!({"accountId": "a"})).await.result.unwrap();
        assert_eq!(listed(a.clone()), vec!["news@brand.test"]);
        assert_eq!(a[0]["method"], "mailto");
        let b = handle_request_for_test(&s, "unsubscribe.senders", json!({"accountId": "b"})).await.result.unwrap();
        assert_eq!(b, json!([]));
    }

    #[test]
    fn a_logo_must_be_svg_under_the_cap() {
        assert!(svg_ok("image/svg+xml", 10));
        assert!(svg_ok("image/svg+xml; charset=utf-8", BIMI_MAX_BYTES));
        assert!(!svg_ok("image/svg+xml", BIMI_MAX_BYTES + 1));
        assert!(!svg_ok("image/png", 10));
        assert!(!svg_ok("text/html", 10));
        assert!(!svg_ok("", 10));
    }

    #[tokio::test]
    async fn bimi_needs_a_dmarc_pass_for_the_domain_before_any_lookup() {
        let (_dir, s) = st();
        for params in [
            json!({"domain": "brand.test", "authenticationResults": "mx.test; dmarc=fail header.from=brand.test"}),
            json!({"domain": "brand.test", "authenticationResults": "mx.test; dmarc=pass header.from=other.test"}),
            json!({"domain": "../etc", "authenticationResults": "mx.test; dmarc=pass"}),
        ] {
            let v = handle_request_for_test(&s, "bimi_logo", params).await.result.unwrap();
            assert_eq!(v, json!({"logo": null}));
        }
    }

    #[tokio::test]
    async fn a_cached_logo_is_answered_without_a_lookup() {
        let (_dir, s) = st();
        app_db::with(&s.app_dir, |c| store::bimi_put(c, "brand.test", Some(b"<svg/>"), now_ms() + DAY_MS)).unwrap();
        let v = handle_request_for_test(&s, "bimi_logo", json!({
            "domain": "Brand.test", "authenticationResults": "mx.test; dmarc=pass header.from=brand.test",
        }))
        .await
        .result
        .unwrap();
        assert_eq!(v["logo"], "data:image/svg+xml;base64,PHN2Zy8+");
    }
}
