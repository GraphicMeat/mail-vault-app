//! A mock OAuth2 token endpoint, and the authority that knows which access
//! tokens it handed out, so the mock IMAP and SMTP servers (and the e2e Graph
//! mock, over HTTP) accept only a token it issued and that has not expired.
//!
//! It answers the refresh grant the way Google and Microsoft do where it
//! matters to MailVault: the refresh token must belong to the posted
//! `client_id`, and a grant signed in with a scope string must be refreshed
//! with that same scope (Microsoft's `invalid_scope`), `expires_in` is
//! configurable per grant, and a grant can rotate its refresh token on every
//! refresh (Microsoft) while the old one keeps working (as Microsoft
//! documents). Failures on demand: a revoked grant (`invalid_grant`), a 5xx
//! with a non-JSON body, a slow answer, and an error body that echoes the
//! posted refresh token (to test that the client scrubs it). Every POST is
//! counted with the client id, scope and refresh token it carried.
//!
//! Time is the mock's own: `advance` moves it forward, so a test never sleeps
//! out a token lifetime and never touches the system clock.
//!
//! Control endpoints for the JS harness live under `/__mock/`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What a grant was signed in with.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GrantSpec {
    /// The OAuth client the grant belongs to: a refresh posted with another is
    /// refused (`unauthorized_client`).
    pub client_id: String,
    /// The scope string a refresh must post, when not empty (`invalid_scope`
    /// otherwise). Empty: any scope.
    pub scope: String,
    /// Seconds an access token lives.
    pub expires_in: u64,
    /// Hand out a new refresh token with every refresh (Microsoft).
    pub rotate: bool,
}

impl Default for GrantSpec {
    fn default() -> Self {
        GrantSpec { client_id: String::new(), scope: String::new(), expires_in: 3600, rotate: false }
    }
}

/// A sign-in: the grant's first refresh token and access token.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub refresh_token: String,
    pub access_token: String,
    /// Epoch ms on the mock's clock.
    pub expires_at: i64,
}

/// One POST to the token endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub grant_type: String,
    pub client_id: String,
    pub scope: String,
    pub refresh_token: String,
    /// The HTTP status it was answered with (0: never answered).
    pub status: u16,
}

/// One sign-in a mail server checked.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthAttempt {
    /// "imap", "smtp" or "graph".
    pub service: String,
    pub user: String,
    pub accepted: bool,
}

/// The next answer instead of a normal one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    /// 400 `invalid_grant`.
    InvalidGrant,
    /// 400 `invalid_grant` whose description echoes the posted refresh token.
    InvalidGrantEcho,
    /// 503 with a non-JSON body.
    ServerError,
    /// Answer normally, this many ms late.
    Slow(u64),
}

struct Grant {
    spec: GrantSpec,
    revoked: bool,
}

struct Issued {
    grant: usize,
    expires_at: i64,
}

#[derive(Default)]
struct Inner {
    offset_ms: i64,
    next: u64,
    grants: Vec<Grant>,
    /// Every refresh token, the rotated ones too, to its grant.
    refresh_tokens: HashMap<String, usize>,
    access_tokens: HashMap<String, Issued>,
    posts: Vec<Post>,
    failures: VecDeque<Failure>,
    /// The mail servers refuse every token, valid ones too (IMAP turned off
    /// for the account, a missing consent).
    refuse_valid: bool,
    /// Sessions whose token stopped being valid are ended (Outlook).
    end_sessions: bool,
    auth_log: Vec<AuthAttempt>,
}

impl Inner {
    fn now(&self) -> i64 {
        now_ms() + self.offset_ms
    }

    fn mint(&mut self, prefix: &str) -> String {
        // Never a real-looking token; unique across every authority in the
        // process, so a scan for one test's tokens never hits another's.
        static MINTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        self.next += 1;
        let n = MINTED.fetch_add(1, Ordering::SeqCst) + 1;
        format!("{prefix}-{n}-{:08x}", (std::process::id() as u64).wrapping_mul(2_654_435_761).wrapping_add(n * 40_503) as u32)
    }

    fn issue(&mut self, grant: usize) -> (String, i64) {
        let token = self.mint("mock-at");
        let expires_at = self.now() + self.grants[grant].spec.expires_in as i64 * 1000;
        self.access_tokens.insert(token.clone(), Issued { grant, expires_at });
        (token, expires_at)
    }

    fn valid(&self, token: &str) -> bool {
        self.access_tokens
            .get(token)
            .is_some_and(|i| !self.grants[i.grant].revoked && self.now() < i.expires_at)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Checks a bearer token a client signed in with. The mock IMAP and SMTP
/// servers take one; `TokenAuthority` is the in-process one, `RemoteTokenCheck`
/// asks a `MockOAuth` in another process.
pub trait TokenCheck: Send + Sync {
    fn check(&self, service: &str, user: &str, token: &str) -> bool;

    /// Whether a session signed in with `token` is ended (`* BYE`) at its
    /// next command once the token stopped being valid, as Outlook does
    /// ("Session invalidated - AccessTokenExpired"). Off by default: Gmail
    /// keeps a signed-in session until it reconnects.
    fn ends_session(&self, _token: &str) -> bool {
        false
    }
}

/// Grants, issued tokens and everything posted. Cheap to clone; every clone is
/// the same authority.
#[derive(Clone, Default)]
pub struct TokenAuthority(Arc<Mutex<Inner>>);

impl TokenAuthority {
    pub fn new() -> Self {
        Self::default()
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A user signs in: a new grant, its refresh token and a first access token.
    pub fn sign_in(&self, spec: GrantSpec) -> SignIn {
        let mut inner = self.inner();
        inner.grants.push(Grant { spec, revoked: false });
        let grant = inner.grants.len() - 1;
        let refresh_token = inner.mint("mock-rt");
        inner.refresh_tokens.insert(refresh_token.clone(), grant);
        let (access_token, expires_at) = inner.issue(grant);
        SignIn { refresh_token, access_token, expires_at }
    }

    /// The user revoked the app: the grant's refresh tokens and every access
    /// token it issued stop working.
    pub fn revoke(&self, refresh_token: &str) {
        let mut inner = self.inner();
        if let Some(&grant) = inner.refresh_tokens.get(refresh_token) {
            inner.grants[grant].revoked = true;
        }
    }

    /// Mail servers end a signed-in session at its next command once its
    /// token expired or was revoked, as Outlook does.
    pub fn end_sessions_when_invalid(&self, on: bool) {
        self.inner().end_sessions = on;
    }

    /// Mail servers refuse every token from now on, valid ones too.
    pub fn refuse_valid_tokens(&self, on: bool) {
        self.inner().refuse_valid = on;
    }

    /// The next token request gets this instead of a normal answer.
    pub fn fail_next(&self, failure: Failure) {
        self.inner().failures.push_back(failure);
    }

    /// Move the mock's clock forward.
    pub fn advance(&self, by: Duration) {
        self.inner().offset_ms += by.as_millis() as i64;
    }

    /// Epoch ms on the mock's clock.
    pub fn now(&self) -> i64 {
        self.inner().now()
    }

    /// Whether `token` is an access token this authority issued, unexpired,
    /// of a grant not revoked.
    pub fn is_valid(&self, token: &str) -> bool {
        self.inner().valid(token)
    }

    pub fn posts(&self) -> Vec<Post> {
        self.inner().posts.clone()
    }

    pub fn auth_log(&self) -> Vec<AuthAttempt> {
        self.inner().auth_log.clone()
    }

    /// Every token this authority issued, refresh and access, for a test that
    /// scans logs and events for any of them.
    pub fn issued(&self) -> Vec<String> {
        let inner = self.inner();
        inner.refresh_tokens.keys().chain(inner.access_tokens.keys()).cloned().collect()
    }

    /// The token endpoint: a form body in, (status, body) out.
    pub fn answer(&self, form: &str) -> (u16, String, Option<Duration>) {
        let field = |key: &str| {
            url_decode_pairs(form).into_iter().find(|(k, _)| k == key).map(|(_, v)| v).unwrap_or_default()
        };
        let (grant_type, client_id, scope, refresh_token) =
            (field("grant_type"), field("client_id"), field("scope"), field("refresh_token"));
        let mut inner = self.inner();
        let failure = inner.failures.pop_front();
        let mut delay = None;
        let (status, body) = match failure {
            Some(Failure::InvalidGrant) => (400, invalid_grant(None)),
            Some(Failure::InvalidGrantEcho) => (400, invalid_grant(Some(&refresh_token))),
            Some(Failure::ServerError) => (503, "Service Unavailable".to_string()),
            Some(Failure::Slow(ms)) => {
                delay = Some(Duration::from_millis(ms));
                refresh(&mut inner, &grant_type, &client_id, &scope, &refresh_token)
            }
            None => refresh(&mut inner, &grant_type, &client_id, &scope, &refresh_token),
        };
        inner.posts.push(Post { grant_type, client_id, scope, refresh_token, status });
        (status, body, delay)
    }
}

fn invalid_grant(echo: Option<&str>) -> String {
    let description = match echo {
        Some(rt) => format!("Token {rt} has been expired or revoked."),
        None => "Token has been expired or revoked.".to_string(),
    };
    json!({"error": "invalid_grant", "error_description": description}).to_string()
}

fn refresh(inner: &mut Inner, grant_type: &str, client_id: &str, scope: &str, refresh_token: &str) -> (u16, String) {
    if grant_type != "refresh_token" {
        return (400, json!({"error": "unsupported_grant_type"}).to_string());
    }
    let Some(&grant) = inner.refresh_tokens.get(refresh_token) else { return (400, invalid_grant(None)) };
    if inner.grants[grant].revoked {
        return (400, invalid_grant(None));
    }
    let spec = inner.grants[grant].spec.clone();
    if !spec.client_id.is_empty() && spec.client_id != client_id {
        return (400, json!({"error": "unauthorized_client", "error_description": "Unauthorized"}).to_string());
    }
    if !spec.scope.is_empty() && spec.scope != scope {
        return (400, json!({"error": "invalid_scope", "error_description": "AADSTS70011: The provided scope is not valid."}).to_string());
    }
    let (access_token, _) = inner.issue(grant);
    let mut body = json!({"access_token": access_token, "expires_in": spec.expires_in, "token_type": "Bearer", "scope": scope});
    if spec.rotate {
        let rotated = inner.mint("mock-rt");
        inner.refresh_tokens.insert(rotated.clone(), grant);
        body["refresh_token"] = json!(rotated);
    }
    (200, body.to_string())
}

impl TokenCheck for TokenAuthority {
    fn check(&self, service: &str, user: &str, token: &str) -> bool {
        let mut inner = self.inner();
        let accepted = !inner.refuse_valid && inner.valid(token);
        inner.auth_log.push(AuthAttempt { service: service.to_string(), user: user.to_string(), accepted });
        accepted
    }

    fn ends_session(&self, token: &str) -> bool {
        let inner = self.inner();
        inner.end_sessions && !inner.valid(token)
    }
}

/// A `TokenCheck` against a `MockOAuth` in another process (the standalone
/// mock IMAP server in e2e asks the mock token endpoint the harness started).
pub struct RemoteTokenCheck {
    pub origin: String,
}

impl TokenCheck for RemoteTokenCheck {
    fn check(&self, service: &str, user: &str, token: &str) -> bool {
        let body = json!({"service": service, "user": user, "token": token}).to_string();
        http_post(&self.origin, "/__mock/check", &body)
            .ok()
            .and_then(|reply| serde_json::from_str::<Value>(&reply).ok())
            .is_some_and(|v| v["accepted"] == json!(true))
    }
}

/// Decode an XOAUTH2 initial response (`user=..\x01auth=Bearer ..\x01\x01`,
/// base64 or not) into (user, token).
pub fn parse_xoauth2(blob: &str) -> Option<(String, String)> {
    use base64::Engine;
    let blob = blob.trim();
    let raw = base64::engine::general_purpose::STANDARD
        .decode(blob)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| blob.to_string());
    let mut user = None;
    let mut token = None;
    for part in raw.split('\x01') {
        if let Some(u) = part.strip_prefix("user=") {
            user = Some(u.to_string());
        } else if let Some(a) = part.strip_prefix("auth=") {
            token = a.strip_prefix("Bearer ").map(str::to_string);
        }
    }
    Some((user?, token?))
}

// ── the HTTP server ─────────────────────────────────────────────────────────

/// A token endpoint on a loopback port, answering for `authority`.
pub struct MockOAuth {
    addr: SocketAddr,
    authority: TokenAuthority,
    stop: Arc<AtomicBool>,
}

impl MockOAuth {
    pub fn start(authority: TokenAuthority) -> MockOAuth {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock oauth");
        let addr = listener.local_addr().expect("local_addr");
        let stop = Arc::new(AtomicBool::new(false));
        let (auth, halt) = (authority.clone(), stop.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if halt.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let auth = auth.clone();
                std::thread::spawn(move || {
                    let _ = serve(conn, &auth);
                });
            }
        });
        MockOAuth { addr, authority, stop }
    }

    /// `http://127.0.0.1:<port>`: the token endpoint answers a POST to any path.
    pub fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn authority(&self) -> &TokenAuthority {
        &self.authority
    }
}

impl Drop for MockOAuth {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn serve(conn: TcpStream, authority: &TokenAuthority) -> std::io::Result<()> {
    let mut out = conn.try_clone()?;
    let mut reader = BufReader::new(conn);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let body = String::from_utf8_lossy(&body).to_string();
    let path = target.split('?').next().unwrap_or("/").to_string();

    let (status, reply, delay) = if path.starts_with("/__mock/") {
        let (s, r) = control(authority, &method, &path, &body);
        (s, r, None)
    } else if method == "POST" {
        authority.answer(&body)
    } else {
        (404, "{}".to_string(), None)
    };
    if let Some(d) = delay {
        std::thread::sleep(d);
    }
    let reason = if status < 300 { "OK" } else { "Mock Error" };
    let content_type = if reply.starts_with('{') || reply.starts_with('[') { "application/json" } else { "text/plain" };
    write!(
        out,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
        reply.len()
    )?;
    out.flush()
}

/// The harness's controls. Nothing here prints a token except `/sign-in`
/// (which hands the seed its own) and `/issued` (for a leak scan).
fn control(authority: &TokenAuthority, method: &str, path: &str, body: &str) -> (u16, String) {
    let input: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    match (method, path) {
        ("POST", "/__mock/sign-in") => {
            let spec: GrantSpec = serde_json::from_value(input).unwrap_or_default();
            (200, serde_json::to_string(&authority.sign_in(spec)).unwrap_or_default())
        }
        ("POST", "/__mock/revoke") => {
            authority.revoke(input["refreshToken"].as_str().unwrap_or(""));
            (200, "{}".to_string())
        }
        ("POST", "/__mock/refuse") => {
            authority.refuse_valid_tokens(input["on"].as_bool().unwrap_or(true));
            (200, "{}".to_string())
        }
        ("POST", "/__mock/fail") => match serde_json::from_value::<Failure>(input) {
            Ok(f) => {
                authority.fail_next(f);
                (200, "{}".to_string())
            }
            Err(e) => (400, json!({"error": e.to_string()}).to_string()),
        },
        ("POST", "/__mock/advance") => {
            authority.advance(Duration::from_millis(input["ms"].as_u64().unwrap_or(0)));
            (200, "{}".to_string())
        }
        ("POST", "/__mock/check") => {
            let accepted = authority.check(
                input["service"].as_str().unwrap_or(""),
                input["user"].as_str().unwrap_or(""),
                input["token"].as_str().unwrap_or(""),
            );
            (200, json!({"accepted": accepted}).to_string())
        }
        // Counts without tokens: who posted, with what client and scope.
        ("GET", "/__mock/posts") => {
            let posts: Vec<Value> = authority
                .posts()
                .iter()
                .map(|p| json!({"grantType": p.grant_type, "clientId": p.client_id, "scope": p.scope, "status": p.status}))
                .collect();
            (200, Value::Array(posts).to_string())
        }
        ("GET", "/__mock/auth-log") => (200, serde_json::to_string(&authority.auth_log()).unwrap_or_default()),
        ("GET", "/__mock/issued") => (200, json!(authority.issued()).to_string()),
        _ => (404, "{}".to_string()),
    }
}

fn url_decode_pairs(form: &str) -> Vec<(String, String)> {
    form.split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (url_decode(k), url_decode(v))
        })
        .collect()
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => {
                        out.push(b);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// A tiny blocking HTTP/1.1 POST to a loopback origin, for `RemoteTokenCheck`.
fn http_post(origin: &str, path: &str, body: &str) -> std::io::Result<String> {
    let host = origin.trim_start_matches("http://").trim_end_matches('/');
    let mut stream = TcpStream::connect(host)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply)?;
    Ok(reply.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(pairs: &[(&str, &str)]) -> String {
        pairs.iter().map(|(k, v)| format!("{k}={}", v.replace(' ', "+").replace(':', "%3A").replace('/', "%2F"))).collect::<Vec<_>>().join("&")
    }

    #[test]
    fn a_refresh_issues_a_token_the_mail_servers_accept_until_it_expires() {
        let a = TokenAuthority::new();
        let s = a.sign_in(GrantSpec { client_id: "cid".into(), expires_in: 120, ..Default::default() });
        let (status, body, _) = a.answer(&form(&[("grant_type", "refresh_token"), ("client_id", "cid"), ("refresh_token", &s.refresh_token)]));
        assert_eq!(status, 200, "{body}");
        let token = serde_json::from_str::<Value>(&body).unwrap()["access_token"].as_str().unwrap().to_string();
        assert!(a.check("imap", "me", &token));
        a.advance(Duration::from_secs(121));
        assert!(!a.check("imap", "me", &token), "expired");
        assert_eq!(a.posts().len(), 1);
    }

    #[test]
    fn the_wrong_client_or_scope_is_refused_and_a_revoked_grant_is_invalid_grant() {
        let a = TokenAuthority::new();
        let s = a.sign_in(GrantSpec { client_id: "cid".into(), scope: "offline_access Mail.ReadWrite".into(), ..Default::default() });
        let post = |client: &str, scope: &str| a.answer(&form(&[("grant_type", "refresh_token"), ("client_id", client), ("scope", scope), ("refresh_token", &s.refresh_token)]));
        assert!(post("other", "offline_access Mail.ReadWrite").1.contains("unauthorized_client"));
        assert!(post("cid", "offline_access IMAP").1.contains("invalid_scope"));
        assert_eq!(post("cid", "offline_access Mail.ReadWrite").0, 200);
        a.revoke(&s.refresh_token);
        assert!(post("cid", "offline_access Mail.ReadWrite").1.contains("invalid_grant"));
        assert!(!a.is_valid(&s.access_token), "a revoked grant's tokens stop working");
    }

    #[test]
    fn a_rotating_grant_hands_out_a_new_refresh_token_and_the_old_one_still_works() {
        let a = TokenAuthority::new();
        let s = a.sign_in(GrantSpec { rotate: true, ..Default::default() });
        let (_, body, _) = a.answer(&form(&[("grant_type", "refresh_token"), ("refresh_token", &s.refresh_token)]));
        let rotated = serde_json::from_str::<Value>(&body).unwrap()["refresh_token"].as_str().unwrap().to_string();
        assert_ne!(rotated, s.refresh_token);
        assert_eq!(a.answer(&form(&[("grant_type", "refresh_token"), ("refresh_token", &rotated)])).0, 200);
        assert_eq!(a.answer(&form(&[("grant_type", "refresh_token"), ("refresh_token", &s.refresh_token)])).0, 200);
    }

    #[test]
    fn failures_on_demand_and_the_echoing_error() {
        let a = TokenAuthority::new();
        let s = a.sign_in(GrantSpec::default());
        let f = form(&[("grant_type", "refresh_token"), ("refresh_token", &s.refresh_token)]);
        a.fail_next(Failure::ServerError);
        a.fail_next(Failure::InvalidGrantEcho);
        assert_eq!(a.answer(&f).0, 503);
        let (status, body, _) = a.answer(&f);
        assert_eq!(status, 400);
        assert!(body.contains(&s.refresh_token), "echoes on demand");
        assert_eq!(a.answer(&f).0, 200);
    }

    #[test]
    fn xoauth2_blobs_parse_raw_or_base64() {
        use base64::Engine;
        let raw = "user=me@x.test\x01auth=Bearer tok-1\x01\x01";
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
        assert_eq!(parse_xoauth2(raw), Some(("me@x.test".into(), "tok-1".into())));
        assert_eq!(parse_xoauth2(&b64), Some(("me@x.test".into(), "tok-1".into())));
    }

    #[test]
    fn the_http_endpoint_answers_and_a_remote_check_reaches_it() {
        let a = TokenAuthority::new();
        let s = a.sign_in(GrantSpec::default());
        let server = MockOAuth::start(a.clone());
        let check = RemoteTokenCheck { origin: server.origin() };
        assert!(check.check("graph", "me", &s.access_token));
        assert!(!check.check("graph", "me", "never-issued"));
        let reply = http_post(&server.origin(), "/token", &form(&[("grant_type", "refresh_token"), ("refresh_token", &s.refresh_token)])).unwrap();
        assert!(reply.contains("access_token"), "{reply}");
        assert_eq!(a.auth_log().len(), 2);
    }
}
