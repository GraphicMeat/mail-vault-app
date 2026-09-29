//! Send-as aliases for one account, from two places: what the provider lists
//! (Gmail's send-as settings, OAuth accounts only) and what the account's own
//! mail proves. The proof is narrow on purpose: an address this mailbox sent
//! as (the `From` of its Sent mail), or one mail was delivered to here (the
//! `Delivered-To` family of headers the receiving server stamps). To/Cc
//! membership proves neither and is never read (the app mined it once and it
//! offered people who were merely copied alongside the user).
//!
//! Parsing and ranking live here; `handlers::aliases` in the daemon does the
//! store reads and calls `fetch_gmail_send_as`.

use crate::maildir::{uid_file_map, IMPORT_UID_BASE};
use crate::net_activity;
use crate::vault_eml::parse_address_str;
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, Read};
use std::path::Path;
use std::time::Duration;

/// The Network Activity purpose of the provider lookup.
pub const PURPOSE: &str = "alias lookup";
/// How many of a folder's newest messages detection reads.
pub const SCAN_LIMIT: usize = 300;
/// At most this many suggestions per source.
pub const MAX_PER_SOURCE: usize = 8;
/// Vault files read between two yields to the foreground.
pub const SCAN_BATCH: usize = 50;
/// A header block longer than this is cut: detection only needs the top.
const HEAD_CAP: u64 = 64 * 1024;
const GMAIL_SEND_AS_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// The headers a receiving server stamps with the address it delivered to.
const DELIVERY_HEADERS: [&str; 4] = ["Delivered-To", "X-Original-To", "X-Delivered-To", "Envelope-To"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAlias {
    pub address: String,
    /// "" when the provider holds no display name.
    pub name: String,
    pub is_primary: bool,
    pub verified: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderStatus {
    Ok,
    /// Not a provider we can ask (password accounts, Outlook, iCloud, IMAP).
    Unsupported,
    /// The provider refused (API off on the client's project, token without
    /// access). Not an error: detection still answers.
    Denied,
    /// Offline, timed out, or a server error.
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProviderAliases {
    pub status: ProviderStatus,
    pub aliases: Vec<ProviderAlias>,
}

impl ProviderAliases {
    pub fn empty(status: ProviderStatus) -> Self {
        ProviderAliases { status, aliases: Vec::new() }
    }
}

/// Where a detected address was seen. Declared strongest first: sending as
/// an address is better proof than receiving at it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    SentFrom,
    DeliveredTo,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DetectedAlias {
    pub address: String,
    /// "" when no header carried one.
    pub name: String,
    pub count: u32,
    pub source: Source,
}

/// One address as one message carried it.
#[derive(Debug, Clone, PartialEq)]
pub struct Seen {
    pub address: String,
    pub name: String,
}

// ── Provider ────────────────────────────────────────────────────────────────

/// Whether the account signs in to Gmail with OAuth: the only one whose
/// aliases we can list with the token the app already holds.
pub fn is_gmail_oauth(account: &Value) -> bool {
    let text = |key: &str| account.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_ascii_lowercase();
    if text("authType") != "oauth2" || text("oauth2Transport") == "graph" {
        return false;
    }
    let host = text("imapHost");
    text("oauth2Provider") == "google" || host == "imap.gmail.com" || host == "imap.googlemail.com"
}

/// A `users.settings.sendAs.list` answer. Every entry comes back, the primary
/// too (`isPrimary`): the app decides what to show. Anything that is not the
/// documented shape reads as no aliases.
pub fn parse_gmail_send_as(json: &Value) -> Vec<ProviderAlias> {
    let Some(items) = json.get("sendAs").and_then(Value::as_array) else { return Vec::new() };
    items
        .iter()
        .filter_map(|item| {
            let text = |key: &str| item.get(key).and_then(Value::as_str);
            let address = clean_address(text("sendAsEmail")?)?;
            Some(ProviderAlias {
                address,
                name: text("displayName").unwrap_or_default().trim().to_string(),
                is_primary: item.get("isPrimary").and_then(Value::as_bool).unwrap_or(false),
                verified: text("verificationStatus").map_or(true, |s| s.eq_ignore_ascii_case("accepted")),
            })
        })
        .collect()
}

/// What an HTTP status from the send-as list means for the app.
pub fn gmail_status(code: u16) -> ProviderStatus {
    match code {
        200..=299 => ProviderStatus::Ok,
        401 | 403 | 404 => ProviderStatus::Denied,
        _ => ProviderStatus::Error,
    }
}

/// Ask Gmail for the account's send-as addresses. One recorded request, shown
/// on Network Activity as this account's "alias lookup".
pub async fn fetch_gmail_send_as(access_token: &str, account_email: &str) -> ProviderAliases {
    fetch_send_as_at(GMAIL_SEND_AS_URL, access_token, account_email).await
}

/// `fetch_gmail_send_as` against `url`. No override reaches this from outside
/// the tests: a bearer token only ever goes to Google.
async fn fetch_send_as_at(url: &str, access_token: &str, account_email: &str) -> ProviderAliases {
    let client = net_activity::http_client(PURPOSE, Some(FETCH_TIMEOUT)).for_account(account_email);
    let resp = match client.send(client.get(url).bearer_auth(access_token)).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[aliases] send-as lookup failed: {e}");
            return ProviderAliases::empty(ProviderStatus::Error);
        }
    };
    let status = gmail_status(resp.status().as_u16());
    if status != ProviderStatus::Ok {
        tracing::info!("[aliases] send-as lookup answered HTTP {}", resp.status().as_u16());
        return ProviderAliases::empty(status);
    }
    match resp.json::<Value>().await {
        Ok(body) => ProviderAliases { status, aliases: parse_gmail_send_as(&body) },
        Err(e) => {
            tracing::warn!("[aliases] send-as answer did not read: {e}");
            ProviderAliases::empty(ProviderStatus::Error)
        }
    }
}

// ── Detection ───────────────────────────────────────────────────────────────

/// The address as one mailbox: Gmail ignores dots and a `+tag` in the local
/// part, and googlemail.com is gmail.com. Every other domain compares by
/// case only. Mirrors `src/utils/emailIdentity.js`; used to drop the login
/// address, never to merge two different aliases.
pub fn mailbox_identity(address: &str) -> String {
    let lower = address.trim().to_lowercase();
    let Some((local, domain)) = lower.rsplit_once('@') else { return lower };
    if domain != "gmail.com" && domain != "googlemail.com" {
        return lower;
    }
    let local = local.split('+').next().unwrap_or_default().replace('.', "");
    format!("{local}@gmail.com")
}

/// A bare `local@domain.tld`, lowercased; `None` for anything else.
fn clean_address(raw: &str) -> Option<String> {
    let a = raw.trim().trim_start_matches('<').trim_end_matches('>').trim();
    let (local, domain) = a.rsplit_once('@')?;
    let bad = |c: char| c.is_whitespace() || matches!(c, ',' | ';' | '<' | '>' | '"' | '@');
    let ok = !local.is_empty() && !local.chars().any(bad) && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !domain.chars().any(bad);
    ok.then(|| a.to_lowercase())
}

/// The addresses one message's delivery headers name (`Delivered-To`,
/// `X-Original-To`, `X-Delivered-To`, `Envelope-To`), once each, in header
/// order. Only the header block is read: a body line that looks like one of
/// these headers is not one.
pub fn extract_delivery_addresses(header_block: &str) -> Vec<String> {
    let Ok((headers, _)) = mailparse::parse_headers(header_block.as_bytes()) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for header in &headers {
        let key = header.get_key();
        if !DELIVERY_HEADERS.iter().any(|k| key.trim().eq_ignore_ascii_case(k)) {
            continue;
        }
        for parsed in parse_address_str(&header.get_value()) {
            if let Some(address) = clean_address(&parsed.address) {
                if !out.contains(&address) {
                    out.push(address);
                }
            }
        }
    }
    out
}

/// The senders of cached Sent rows (the header cache's `from`), in the order
/// given. A row mbox import numbered is skipped: its mail was sent from some
/// other mailbox.
pub fn senders_of_rows(rows: &[Value]) -> Vec<Seen> {
    rows.iter()
        .filter(|row| row.get("uid").and_then(Value::as_u64).map_or(true, |uid| uid < IMPORT_UID_BASE as u64))
        .filter_map(|row| {
            let from = row.get("from")?;
            Some(Seen {
                address: from.get("address")?.as_str()?.to_string(),
                name: from.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// Count one source's sightings (newest first) into at most `MAX_PER_SOURCE`
/// suggestions, most frequent first, ties newest first. The login address is
/// dropped, Gmail's dot and `+tag` spellings of it too. The name is the
/// newest non-empty one.
pub fn rank(source: Source, seen: &[Seen], login: &str) -> Vec<DetectedAlias> {
    let own = mailbox_identity(login);
    let mut out: Vec<DetectedAlias> = Vec::new();
    for s in seen {
        let Some(address) = clean_address(&s.address) else { continue };
        if mailbox_identity(&address) == own {
            continue;
        }
        let name = s.name.trim();
        match out.iter_mut().find(|d| d.address == address) {
            Some(d) => {
                d.count += 1;
                if d.name.is_empty() {
                    d.name = name.to_string();
                }
            }
            None => out.push(DetectedAlias { address, name: name.to_string(), count: 1, source }),
        }
    }
    // Stable: equal counts keep first-seen, which is newest.
    out.sort_by(|a, b| b.count.cmp(&a.count));
    out.truncate(MAX_PER_SOURCE);
    out
}

/// One list from every source's ranking: an address seen by two sources keeps
/// the stronger one (its count and source), and a name either carried.
/// Stronger sources first, then by count.
pub fn merge(lists: impl IntoIterator<Item = Vec<DetectedAlias>>) -> Vec<DetectedAlias> {
    let mut out: Vec<DetectedAlias> = Vec::new();
    for d in lists.into_iter().flatten() {
        match out.iter_mut().find(|o| o.address == d.address) {
            Some(o) if d.source < o.source => {
                let name = if d.name.is_empty() { std::mem::take(&mut o.name) } else { d.name.clone() };
                *o = DetectedAlias { name, ..d };
            }
            Some(o) => {
                if o.name.is_empty() {
                    o.name = d.name;
                }
            }
            None => out.push(d),
        }
    }
    out.sort_by(|a, b| a.source.cmp(&b.source).then(b.count.cmp(&a.count)));
    out
}

/// The path of the folder with `role` (`\Sent`, `\Inbox`) in a cached folder
/// list: the stored `{"mailboxes": [...]}` or a bare array, children
/// included. `None` when the list names no such folder.
pub fn mailbox_by_role(list: &Value, role: &str) -> Option<String> {
    fn walk(boxes: &[Value], role: &str) -> Option<String> {
        for b in boxes {
            let selectable = !b.get("noselect").and_then(Value::as_bool).unwrap_or(false);
            if selectable && b.get("specialUse").and_then(Value::as_str) == Some(role) {
                if let Some(path) = b.get("path").and_then(Value::as_str) {
                    return Some(path.to_string());
                }
            }
            if let Some(hit) = b.get("children").and_then(Value::as_array).and_then(|c| walk(c, role)) {
                return Some(hit);
            }
        }
        None
    }
    let boxes = list.get("mailboxes").and_then(Value::as_array).or_else(|| list.as_array())?;
    walk(boxes, role)
}

/// A message file's header block, up to and including the blank line that
/// ends it, and never more than `HEAD_CAP` bytes: the body is not read.
pub fn read_head(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file.take(HEAD_CAP));
    let mut buf = Vec::new();
    loop {
        let start = buf.len();
        if reader.read_until(b'\n', &mut buf).ok()? == 0 {
            break;
        }
        let line = &buf[start..];
        if line == b"\n" || line == b"\r\n" {
            break;
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// The delivery addresses of a vault folder's newest `limit` messages (by uid;
/// mbox imports skipped, their headers belong to another mailbox), one
/// `Seen` per message and address, newest first. One directory pass and no
/// lock; `between_batches` runs after every `SCAN_BATCH` files so the caller
/// can yield to the user.
pub fn scan_delivery_addresses(cur_dir: &Path, limit: usize, mut between_batches: impl FnMut()) -> Vec<Seen> {
    let files = uid_file_map(cur_dir);
    let mut uids: Vec<u32> = files.keys().copied().filter(|&uid| uid < IMPORT_UID_BASE).collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(limit);
    let mut out = Vec::new();
    for (i, uid) in uids.iter().enumerate() {
        if i > 0 && i % SCAN_BATCH == 0 {
            between_batches();
        }
        let Some(head) = files.get(uid).and_then(|path| read_head(path)) else { continue };
        out.extend(extract_delivery_addresses(&head).into_iter().map(|address| Seen { address, name: String::new() }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn seen(address: &str, name: &str) -> Seen {
        Seen { address: address.into(), name: name.into() }
    }

    fn detected(address: &str, name: &str, count: u32, source: Source) -> DetectedAlias {
        DetectedAlias { address: address.into(), name: name.into(), count, source }
    }

    // ── Gmail send-as ──────────────────────────────────────────────────

    #[test]
    fn a_typical_send_as_list_keeps_every_entry_with_its_flags() {
        let body = json!({"sendAs": [
            {"sendAsEmail": "me@gmail.com", "displayName": "", "isPrimary": true, "isDefault": true, "treatAsAlias": false},
            {"sendAsEmail": "Work@Example.test", "displayName": " Me at Work ", "replyToAddress": "", "isDefault": false,
             "treatAsAlias": true, "verificationStatus": "accepted", "signature": "<b>x</b>"},
        ]});
        assert_eq!(
            parse_gmail_send_as(&body),
            vec![
                ProviderAlias { address: "me@gmail.com".into(), name: "".into(), is_primary: true, verified: true },
                ProviderAlias { address: "work@example.test".into(), name: "Me at Work".into(), is_primary: false, verified: true },
            ]
        );
    }

    #[test]
    fn a_pending_alias_is_listed_unverified() {
        let body = json!({"sendAs": [{"sendAsEmail": "new@example.test", "displayName": "New", "verificationStatus": "pending"}]});
        let got = parse_gmail_send_as(&body);
        assert_eq!(got.len(), 1);
        assert!(!got[0].verified);
        assert!(!got[0].is_primary);
    }

    #[test]
    fn a_missing_display_name_is_an_empty_name() {
        let got = parse_gmail_send_as(&json!({"sendAs": [{"sendAsEmail": "a@example.test"}]}));
        assert_eq!(got[0].name, "");
        assert!(got[0].verified, "no verification status is a verified address (the primary carries none)");
    }

    #[test]
    fn an_empty_or_malformed_answer_is_no_aliases() {
        for body in [
            json!({}),
            json!({"sendAs": []}),
            json!({"sendAs": "me@example.test"}),
            json!({"sendAs": {"sendAsEmail": "me@example.test"}}),
            json!([{"sendAsEmail": "me@example.test"}]),
            json!(null),
            json!("garbage"),
            json!({"sendAs": [{"displayName": "no address"}, {"sendAsEmail": 7}, {"sendAsEmail": "not an address"}]}),
        ] {
            assert!(parse_gmail_send_as(&body).is_empty(), "{body}");
        }
    }

    #[test]
    fn a_refusal_is_denied_and_a_server_fault_is_an_error() {
        assert_eq!(gmail_status(200), ProviderStatus::Ok);
        for code in [401, 403, 404] {
            assert_eq!(gmail_status(code), ProviderStatus::Denied, "{code}");
        }
        for code in [400, 429, 500, 502, 503] {
            assert_eq!(gmail_status(code), ProviderStatus::Error, "{code}");
        }
    }

    #[test]
    fn only_a_gmail_oauth_account_is_asked() {
        let gmail = json!({"email": "me@gmail.com", "authType": "oauth2", "oauth2Provider": "google", "imapHost": "imap.gmail.com"});
        assert!(is_gmail_oauth(&gmail));
        assert!(is_gmail_oauth(&json!({"authType": "oauth2", "imapHost": "IMAP.gmail.com"})), "no provider field, Gmail's host");
        assert!(is_gmail_oauth(&json!({"authType": "oauth2", "oauth2Provider": "google", "imapHost": "imap.example.test"})), "Workspace");
        assert!(!is_gmail_oauth(&json!({"authType": "password", "imapHost": "imap.gmail.com"})), "app password");
        assert!(!is_gmail_oauth(&json!({"imapHost": "imap.gmail.com"})), "no auth type is a password account");
        assert!(!is_gmail_oauth(&json!({"authType": "oauth2", "oauth2Provider": "microsoft", "imapHost": "outlook.office365.com"})));
        assert!(!is_gmail_oauth(&json!({"authType": "oauth2", "oauth2Provider": "google", "oauth2Transport": "graph"})));
        assert!(!is_gmail_oauth(&json!({"authType": "password", "imapHost": "imap.fastmail.com"})));
    }

    /// One loopback answer to one request; the handle yields the request text.
    async fn serve(status_line: &'static str, body: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let reply = format!(
                "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });
        (port, handle)
    }

    fn events_on(port: u16) -> Vec<net_activity::NetEvent> {
        net_activity::snapshot().into_iter().filter(|e| e.port == port).collect()
    }

    #[tokio::test]
    async fn the_lookup_sends_the_token_reads_the_list_and_is_on_network_activity_as_the_accounts() {
        let (port, request) = serve("200 OK", r#"{"sendAs":[{"sendAsEmail":"alias@example.test","displayName":"Alias","verificationStatus":"accepted"}]}"#).await;
        let got = fetch_send_as_at(&format!("http://127.0.0.1:{port}/send-as"), "test-token", "me@example.test").await;
        assert_eq!(got.status, ProviderStatus::Ok);
        assert_eq!(got.aliases, vec![ProviderAlias { address: "alias@example.test".into(), name: "Alias".into(), is_primary: false, verified: true }]);
        assert!(request.await.unwrap().contains("authorization: bearer test-token"));
        let events = events_on(port);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].purpose, PURPOSE);
        assert_eq!(events[0].account.as_deref(), Some("me@example.test"));
        assert_eq!(events[0].result, "ok");
    }

    #[tokio::test]
    async fn a_refused_lookup_is_denied_with_no_aliases_and_still_recorded() {
        for status_line in ["403 Forbidden", "401 Unauthorized", "404 Not Found"] {
            let (port, _) = serve(status_line, r#"{"error":{"code":403,"message":"Gmail API has not been used"}}"#).await;
            let got = fetch_send_as_at(&format!("http://127.0.0.1:{port}/"), "test-token", "me@example.test").await;
            assert_eq!(got, ProviderAliases::empty(ProviderStatus::Denied), "{status_line}");
            assert_eq!(events_on(port).len(), 1, "{status_line}");
        }
    }

    #[tokio::test]
    async fn a_server_fault_or_an_unreadable_body_is_an_error() {
        let (port, _) = serve("500 Internal Server Error", "{}").await;
        let got = fetch_send_as_at(&format!("http://127.0.0.1:{port}/"), "test-token", "me@example.test").await;
        assert_eq!(got, ProviderAliases::empty(ProviderStatus::Error));

        let (port, _) = serve("200 OK", "not json").await;
        let got = fetch_send_as_at(&format!("http://127.0.0.1:{port}/"), "test-token", "me@example.test").await;
        assert_eq!(got, ProviderAliases::empty(ProviderStatus::Error));
    }

    #[tokio::test]
    async fn an_unreachable_server_is_an_error_and_is_recorded() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let got = fetch_send_as_at(&format!("http://127.0.0.1:{port}/"), "test-token", "me@example.test").await;
        assert_eq!(got, ProviderAliases::empty(ProviderStatus::Error));
        let events = events_on(port);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_ne!(events[0].result, "ok");
        assert_eq!(events[0].purpose, PURPOSE);
    }

    // ── Delivery headers ───────────────────────────────────────────────

    #[test]
    fn delivery_headers_yield_their_addresses_in_every_spelling() {
        let cases: &[(&str, &[&str])] = &[
            ("Delivered-To: alias@example.test\r\nSubject: hi\r\n\r\n", &["alias@example.test"]),
            ("delivered-to: <Alias@Example.test>\n\n", &["alias@example.test"]),
            ("X-Original-To: \"The Shop\" <shop@example.test>\r\n\r\n", &["shop@example.test"]),
            ("X-Delivered-To: a@example.test\r\nEnvelope-To: b@example.test\r\n\r\n", &["a@example.test", "b@example.test"]),
            // Two hops stamp two lines; the same address twice counts once per message.
            ("Delivered-To: first@example.test\r\nReceived: x\r\nDelivered-To: second@example.test\r\nX-Original-To: FIRST@example.test\r\n\r\n",
             &["first@example.test", "second@example.test"]),
            // A folded header.
            ("X-Original-To: one@example.test,\r\n two@example.test\r\nSubject: s\r\n\r\n", &["one@example.test", "two@example.test"]),
            // To/Cc prove nothing and are never read.
            ("To: someone@example.test\r\nCc: other@example.test\r\n\r\n", &[]),
            // Junk values.
            ("Delivered-To: \r\nX-Original-To: not an address\r\nEnvelope-To: user@localhost\r\nX-Delivered-To: @example.test\r\n\r\n", &[]),
            ("", &[]),
        ];
        for (block, want) in cases {
            assert_eq!(extract_delivery_addresses(block), want.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{block:?}");
        }
    }

    #[test]
    fn a_body_line_that_looks_like_a_delivery_header_is_not_one() {
        let msg = "From: a@example.test\r\nSubject: s\r\n\r\nDelivered-To: body@example.test\r\n";
        assert!(extract_delivery_addresses(msg).is_empty());
    }

    #[test]
    fn a_header_block_that_does_not_parse_is_nothing_not_a_panic() {
        assert!(extract_delivery_addresses(" leading space\r\nDelivered-To: a@example.test\r\n\r\n").is_empty());
        assert!(extract_delivery_addresses("\u{0}\u{1}\u{2}").is_empty());
    }

    // ── Ranking ────────────────────────────────────────────────────────

    #[test]
    fn the_login_is_never_suggested_under_any_gmail_spelling() {
        let rows = [
            seen("John.Doe@gmail.com", ""),
            seen("johndoe+news@googlemail.com", ""),
            seen("JOHNDOE@GMAIL.COM", ""),
            seen("john.doe.work@gmail.com", "Work"),
        ];
        let got = rank(Source::SentFrom, &rows, "johndoe@gmail.com");
        assert_eq!(got, vec![detected("john.doe.work@gmail.com", "Work", 1, Source::SentFrom)]);
    }

    #[test]
    fn dots_and_tags_are_folded_only_at_gmail() {
        let rows = [seen("me+shop@example.test", ""), seen("m.e@example.test", "")];
        let got = rank(Source::DeliveredTo, &rows, "me@example.test");
        assert_eq!(got.len(), 2, "a custom domain's plus and dot addresses are other mailboxes: {got:?}");
    }

    #[test]
    fn counts_are_case_insensitive_most_frequent_first_and_the_newest_name_wins() {
        let rows = [
            seen("b@example.test", ""),
            seen("A@example.test", "Newest A"),
            seen("a@example.test", "Older A"),
            seen("a@example.test", ""),
            seen("b@example.test", "B"),
            seen("junk", "x"),
        ];
        let got = rank(Source::SentFrom, &rows, "me@example.test");
        assert_eq!(
            got,
            vec![detected("a@example.test", "Newest A", 3, Source::SentFrom), detected("b@example.test", "B", 2, Source::SentFrom)]
        );
    }

    #[test]
    fn a_tie_keeps_the_newest_first_and_each_source_is_capped() {
        let rows: Vec<Seen> = (0..12).map(|i| seen(&format!("a{i}@example.test"), "")).collect();
        let got = rank(Source::DeliveredTo, &rows, "me@example.test");
        assert_eq!(got.len(), MAX_PER_SOURCE);
        assert_eq!(got[0].address, "a0@example.test");
        assert_eq!(got[MAX_PER_SOURCE - 1].address, format!("a{}@example.test", MAX_PER_SOURCE - 1));
    }

    #[test]
    fn merging_keeps_the_stronger_source_and_any_name() {
        let sent = vec![detected("shared@example.test", "", 2, Source::SentFrom), detected("out@example.test", "Out", 1, Source::SentFrom)];
        let delivered = vec![
            detected("in@example.test", "", 9, Source::DeliveredTo),
            detected("shared@example.test", "Shared", 5, Source::DeliveredTo),
        ];
        assert_eq!(
            merge([sent.clone(), delivered.clone()]),
            vec![
                detected("shared@example.test", "Shared", 2, Source::SentFrom),
                detected("out@example.test", "Out", 1, Source::SentFrom),
                detected("in@example.test", "", 9, Source::DeliveredTo),
            ]
        );
        assert_eq!(merge([delivered, sent]), merge([
            vec![detected("shared@example.test", "", 2, Source::SentFrom), detected("out@example.test", "Out", 1, Source::SentFrom)],
            vec![detected("in@example.test", "", 9, Source::DeliveredTo), detected("shared@example.test", "Shared", 5, Source::DeliveredTo)],
        ]), "the order the sources arrive in does not matter");
    }

    #[test]
    fn the_json_shape_is_what_the_app_reads() {
        let v = serde_json::to_value(detected("a@example.test", "", 1, Source::DeliveredTo)).unwrap();
        assert_eq!(v, json!({"address": "a@example.test", "name": "", "count": 1, "source": "delivered_to"}));
        let v = serde_json::to_value(ProviderAliases {
            status: ProviderStatus::Denied,
            aliases: vec![ProviderAlias { address: "a@example.test".into(), name: "A".into(), is_primary: true, verified: false }],
        })
        .unwrap();
        assert_eq!(v, json!({"status": "denied", "aliases": [{"address": "a@example.test", "name": "A", "isPrimary": true, "verified": false}]}));
    }

    #[test]
    fn sent_rows_give_their_senders_and_skip_mbox_imports() {
        let rows = vec![
            json!({"uid": 3, "from": {"name": "Shop", "address": "shop@example.test"}}),
            json!({"uid": 2, "from": {"name": null, "address": "me@example.test"}}),
            json!({"uid": (IMPORT_UID_BASE as u64 + 1), "from": {"name": "", "address": "old@elsewhere.test"}}),
            json!({"uid": 1}),
        ];
        assert_eq!(senders_of_rows(&rows), vec![seen("shop@example.test", "Shop"), seen("me@example.test", "")]);
    }

    #[test]
    fn a_role_is_found_in_the_stored_list_and_its_children() {
        let list = json!({"mailboxes": [
            {"path": "INBOX", "specialUse": "\\Inbox", "children": []},
            {"path": "[Gmail]", "noselect": true, "children": [
                {"path": "[Gmail]/Sent Mail", "specialUse": "\\Sent", "children": []},
            ]},
        ], "fetchedAt": 1});
        assert_eq!(mailbox_by_role(&list, "\\Sent").as_deref(), Some("[Gmail]/Sent Mail"));
        assert_eq!(mailbox_by_role(&list, "\\Inbox").as_deref(), Some("INBOX"));
        assert_eq!(mailbox_by_role(&json!([{"path": "Sent Items", "specialUse": "\\Sent"}]), "\\Sent").as_deref(), Some("Sent Items"));
        assert_eq!(mailbox_by_role(&json!([{"path": "X", "specialUse": "\\Sent", "noselect": true}]), "\\Sent"), None);
        assert_eq!(mailbox_by_role(&json!(null), "\\Sent"), None);
    }

    // ── The vault scan ─────────────────────────────────────────────────

    fn write_eml(cur: &Path, uid: u32, text: &str) {
        std::fs::write(cur.join(format!("{uid}{}S.eml", crate::maildir::INFO_PREFIX)), text).unwrap();
    }

    #[test]
    fn the_head_stops_at_the_blank_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.eml");
        std::fs::write(&path, "Delivered-To: a@example.test\r\nSubject: s\r\n\r\nDelivered-To: body@example.test\r\n").unwrap();
        let head = read_head(&path).unwrap();
        assert!(head.contains("a@example.test"));
        assert!(!head.contains("body@example.test"), "{head:?}");
        assert!(read_head(&dir.path().join("missing.eml")).is_none());
    }

    #[test]
    fn the_head_of_a_file_with_no_body_is_the_whole_file_and_a_huge_head_is_cut() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.eml");
        std::fs::write(&path, "Delivered-To: a@example.test").unwrap();
        assert_eq!(read_head(&path).unwrap(), "Delivered-To: a@example.test");
        let huge = format!("X-Pad: {}\r\n", "x".repeat(200 * 1024));
        std::fs::write(&path, huge).unwrap();
        assert!(read_head(&path).unwrap().len() as u64 <= HEAD_CAP);
    }

    #[test]
    fn the_scan_reads_the_newest_messages_skips_imports_and_yields_between_batches() {
        let dir = tempfile::tempdir().unwrap();
        let cur = dir.path();
        for uid in 1..=120 {
            write_eml(cur, uid, &format!("Delivered-To: n{uid}@example.test\r\nSubject: s\r\n\r\nbody"));
        }
        write_eml(cur, IMPORT_UID_BASE + 5, "Delivered-To: imported@elsewhere.test\r\n\r\n");
        std::fs::write(cur.join("stray.txt"), "Delivered-To: stray@example.test\r\n\r\n").unwrap();

        let mut yields = 0;
        let got = scan_delivery_addresses(cur, 110, || yields += 1);
        assert_eq!(got.len(), 110);
        assert_eq!(got[0], seen("n120@example.test", ""), "newest first");
        assert_eq!(got[109].address, "n11@example.test");
        assert!(got.iter().all(|s| s.address != "imported@elsewhere.test" && s.address != "stray@example.test"));
        assert_eq!(yields, 2, "after files 50 and 100, never before the first");
    }

    #[test]
    fn a_missing_folder_scans_to_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan_delivery_addresses(&dir.path().join("nope"), SCAN_LIMIT, || {}).is_empty());
    }
}
