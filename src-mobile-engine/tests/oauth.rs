//! OAuth sign-in through the engine: `mobile.oauth.{begin,finish,cancel,reauth}` against a token
//! endpoint on this machine (core's debug override) backed by mock-imap's `TokenAuthority`, and the
//! mock IMAP server checking every XOAUTH2 token it is given. The browser is never involved: the
//! code reaches the flow through core's `deliver_code_for_tests`.
//!
//! The loopback listener port (19876) is one per machine, so every test that begins a flow holds
//! [`port`] for its whole run.

use base64::Engine as _;
use mailvault_mobile_engine::{Credential, Engine, MemorySecrets, SecretStore};
use mock_imap::oauth::{GrantSpec, TokenAuthority};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{MockImap, Scenario};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT: Duration = Duration::from_secs(60);
const CALLBACK_PORT: u16 = 19876;
const EMAIL: &str = "person@gmail.com";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Every test that binds the callback port holds this.
fn port() -> MutexGuard<'static, ()> {
    static PORT: Mutex<()> = Mutex::new(());
    PORT.lock().unwrap_or_else(|p| p.into_inner())
}

fn port_is_free() -> bool {
    TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).is_ok()
}

// ── A token endpoint: the code grant mints a grant, the refresh grant is the authority's ──────

struct TokenServer {
    addr: SocketAddr,
    /// code -> the address its id_token names.
    codes: Arc<Mutex<HashMap<String, String>>>,
    stop: Arc<AtomicBool>,
}

fn fake_id_token(email: &str) -> String {
    let b64 = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
    format!("{}.{}.sig", b64(&json!({ "alg": "none" })), b64(&json!({ "email": email })))
}

fn form_field(form: &str, key: &str) -> String {
    form.split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| {
            let v = v.replace('+', " ");
            let mut out = Vec::new();
            let b = v.as_bytes();
            let mut i = 0;
            while i < b.len() {
                if b[i] == b'%' && i + 2 < b.len() {
                    out.push(u8::from_str_radix(&v[i + 1..i + 3], 16).unwrap_or(b'?'));
                    i += 3;
                } else {
                    out.push(b[i]);
                    i += 1;
                }
            }
            String::from_utf8_lossy(&out).into_owned()
        })
        .unwrap_or_default()
}

impl TokenServer {
    fn start(authority: TokenAuthority) -> TokenServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let codes: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (c, s) = (Arc::clone(&codes), Arc::clone(&stop));
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let (auth, codes) = (authority.clone(), Arc::clone(&c));
                std::thread::spawn(move || {
                    let _ = serve(conn, &auth, &codes);
                });
            }
        });
        TokenServer { addr, codes, stop }
    }

    fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// The next exchange of `code` signs `email` in.
    fn expect_code(&self, code: &str, email: &str) {
        self.codes.lock().unwrap().insert(code.into(), email.into());
    }
}

impl Drop for TokenServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn serve(conn: TcpStream, authority: &TokenAuthority, codes: &Mutex<HashMap<String, String>>) -> std::io::Result<()> {
    let mut out = conn.try_clone()?;
    let mut reader = BufReader::new(conn);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let form = String::from_utf8_lossy(&body).into_owned();
    let (status, reply) = if form_field(&form, "grant_type") == "authorization_code" {
        let email = codes.lock().unwrap().remove(&form_field(&form, "code"));
        match email {
            Some(email) => {
                let s = authority.sign_in(GrantSpec { expires_in: 3600, ..GrantSpec::default() });
                (
                    200,
                    json!({ "access_token": s.access_token, "refresh_token": s.refresh_token, "expires_in": 3600, "token_type": "Bearer", "id_token": fake_id_token(&email) })
                        .to_string(),
                )
            }
            None => (400, json!({ "error": "invalid_grant", "error_description": "bad code" }).to_string()),
        }
    } else {
        let (status, reply, delay) = authority.answer(&form);
        if let Some(d) = delay {
            std::thread::sleep(d);
        }
        (status, reply)
    };
    write!(
        out,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
        reply.len()
    )?;
    out.flush()
}

// ── The fixture ─────────────────────────────────────────────────────────────

#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
}

impl Events {
    fn len(&self) -> usize {
        self.list.lock().unwrap().len()
    }

    fn all(&self) -> Vec<(String, Value)> {
        self.list.lock().unwrap().clone()
    }

    fn wait(&self, from: usize, what: &str, pred: impl Fn(&str, &Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        let mut list = self.list.lock().unwrap();
        loop {
            if let Some((_, v)) = list.iter().skip(from).find(|(n, v)| pred(n, v)) {
                return v.clone();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no {what} event; got {:?}", &list[from.min(list.len())..]);
            list = self.cv.wait_timeout(list, left).unwrap().0;
        }
    }

    /// The end of the next sync pass of `account`: its `state` (`idle` or `error`) event.
    fn sync_end(&self, from: usize, account: &str) -> Value {
        self.wait(from, "sync end", |n, v| {
            n == "mobile.sync.state" && v["accountId"] == account && (v["state"] == "idle" || v["state"] == "error")
        })
    }
}

fn msg(uid: u32, subject: &str) -> Message {
    Message::new(
        uid,
        format!(
            "From: Alice <alice@example.com>\nTo: {EMAIL}\nSubject: {subject}\nDate: Thu, 01 Jan 2026 12:00:00 +0000\nMessage-ID: <m{uid}@example.com>\n\nBody {uid}.\n"
        ),
    )
    .with_internal_ms(now_ms() - 3_600_000 + uid as i64 * 1000)
}

fn scenario() -> Scenario {
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(msg(1, "One"));
    inbox.add(msg(2, "Two"));
    Scenario::new().mailbox(inbox).mailbox(Mailbox::new("Sent").with_attrs(&["\\HasNoChildren", "\\Sent"]))
}

/// The engine's secret store, counting the secrets it was given.
#[derive(Default)]
struct Spy {
    inner: MemorySecrets,
    sets: std::sync::atomic::AtomicUsize,
}

impl SecretStore for Spy {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        self.inner.get(id)
    }
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        self.sets.fetch_add(1, Ordering::SeqCst);
        self.inner.set(id, secret)
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.inner.delete(id)
    }
}

struct Fx {
    tmp: tempfile::TempDir,
    secrets: Arc<Spy>,
    engine: Engine,
    events: Arc<Events>,
    logs: Arc<Mutex<Vec<String>>>,
    authority: TokenAuthority,
    imap: MockImap,
    tokens: TokenServer,
    /// Every reply the test got, scanned for secrets at the end.
    replies: Mutex<Vec<String>>,
}

fn setup() -> Fx {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let authority = TokenAuthority::new();
    let imap = MockImap::start_checked(scenario(), Arc::new(authority.clone()));
    let tokens = TokenServer::start(authority.clone());
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(Spy::default());
    let engine = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::clone(&secrets) as _).unwrap();
    engine.set_action_backoff(Duration::from_millis(50), Duration::from_millis(200));
    engine.set_outbox_backoff(Duration::from_millis(50), Duration::from_millis(200));
    engine.set_oauth_token_endpoint(&tokens.origin());
    engine.set_oauth_google_servers((&imap.host(), imap.port(), "none"), (&imap.host(), imap.smtp_port(), "starttls"));
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    let logs: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = Arc::clone(&logs);
    assert!(engine.set_log_sink(move |line| l.lock().unwrap().push(line.to_string())));
    Fx { tmp, secrets, engine, events, logs, authority, imap, tokens, replies: Mutex::default() }
}

impl Fx {
    fn rpc(&self, method: &str, params: Value) -> Value {
        let r = self.engine.rpc(method, params).unwrap_or_else(|e| panic!("{method}: {e}"));
        self.replies.lock().unwrap().push(r.to_string());
        r
    }

    /// Runs a whole flow: begin (or `reauth` of `account`), the browser's code, finish.
    fn flow(&self, reauth: Option<&str>, code: &str, signs_in_as: &str) -> Value {
        let begun = match reauth {
            None => self.rpc("mobile.oauth.begin", json!({ "provider": "google" })),
            Some(id) => self.rpc("mobile.oauth.reauth", json!({ "accountId": id })),
        };
        let flow = begun["flowId"].as_str().unwrap().to_string();
        self.tokens.expect_code(code, signs_in_as);
        assert!(self.engine.oauth_deliver_code(&flow, code), "the flow takes the code");
        self.rpc("mobile.oauth.finish", json!({ "flowId": flow }))
    }

    fn sign_in(&self) -> String {
        let r = self.flow(None, "authcode-first-0001", EMAIL);
        assert_eq!(r["ok"], true, "{r}");
        r["account"]["id"].as_str().unwrap().to_string()
    }

    fn cred(&self, id: &str) -> Credential {
        Credential::parse(&self.secrets.get(id).unwrap().expect("a secret is stored"))
    }

    /// Rewrites the stored access token's expiry.
    fn expire_at(&self, id: &str, expires_ms: i64) {
        let mut c = self.cred(id);
        c.expires_ms = Some(expires_ms);
        self.secrets.set(id, &c.to_secret()).unwrap();
    }

    fn refresh_posts(&self) -> usize {
        self.authority.posts().iter().filter(|p| p.grant_type == "refresh_token").count()
    }

    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap()
    }

    fn needs_auth(&self, id: &str) -> i64 {
        self.db().query_row("SELECT needs_auth FROM accounts WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    }

    fn sync(&self, id: &str) -> Value {
        let from = self.events.len();
        self.rpc("mobile.sync.refresh", json!({ "accountId": id }));
        self.events.sync_end(from, id)
    }

    /// Every secret the run saw must be absent from the database file, the WAL, the logs, the
    /// events and the replies.
    fn assert_no_secret_leaked(&self, extra: &[&str]) {
        let mut secrets = self.authority.issued();
        secrets.extend(extra.iter().map(|s| s.to_string()));
        assert!(!secrets.is_empty());
        let mut haystacks: Vec<(String, Vec<u8>)> = Vec::new();
        for f in ["mobile.db", "mobile.db-wal"] {
            if let Ok(b) = std::fs::read(self.tmp.path().join(f)) {
                haystacks.push((f.into(), b));
            }
        }
        haystacks.push(("logs".into(), self.logs.lock().unwrap().join("\n").into_bytes()));
        haystacks.push(("events".into(), format!("{:?}", self.events.all()).into_bytes()));
        haystacks.push(("replies".into(), self.replies.lock().unwrap().join("\n").into_bytes()));
        for (name, hay) in &haystacks {
            for s in &secrets {
                assert!(!hay.windows(s.len()).any(|w| w == s.as_bytes()), "{name} holds a secret");
            }
        }
    }
}

// ── The tests ───────────────────────────────────────────────────────────────

#[test]
fn google_sign_in_stores_tokens_only_in_the_secret_store() {
    let _port = port();
    let f = setup();
    let begun = f.rpc("mobile.oauth.begin", json!({ "provider": "google", "loginHint": EMAIL }));
    let flow = begun["flowId"].as_str().unwrap().to_string();
    assert!(!port_is_free(), "the listener holds the callback port while the flow is open");
    f.tokens.expect_code("authcode-SECRET-77", EMAIL);
    assert!(f.engine.oauth_deliver_code(&flow, "authcode-SECRET-77"));
    let r = f.rpc("mobile.oauth.finish", json!({ "flowId": flow }));
    assert_eq!(r["ok"], true, "{r}");
    assert!(port_is_free(), "the listener is shut once no flow is open");
    let a = &r["account"];
    let id = a["id"].as_str().unwrap().to_string();
    assert_eq!((a["email"].clone(), a["kind"].clone(), a["provider"].clone(), a["needsAuth"].clone()), (json!(EMAIL), json!("imap"), json!("google"), json!(false)));

    // The row: imap over XOAUTH2, nothing secret.
    let row: (String, String, Option<String>, i64) = f
        .db()
        .query_row("SELECT kind, auth, provider, needs_auth FROM accounts WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap();
    assert_eq!(row, ("imap".into(), "oauth2".into(), Some("google".into()), 0));

    // The secret store holds the tokens, the expiry and the issuing client.
    let c = f.cred(&id);
    assert!(c.password.is_none(), "{c:?}");
    assert!(c.refresh.as_deref().is_some_and(|t| t.starts_with("mock-rt-")), "{c:?}");
    assert!(c.access.as_deref().is_some_and(|t| f.authority.is_valid(t)), "{c:?}");
    assert!(c.expires_ms.unwrap() > now_ms() + 3_000_000, "{c:?}");
    assert!(c.client_id.as_deref().is_some_and(|id| !id.is_empty()), "{c:?}");

    // The sign-in was proven by one XOAUTH2 login before anything was stored.
    let log = f.authority.auth_log();
    assert!(log.iter().any(|a| a.service == "imap" && a.user == EMAIL && a.accepted), "{log:?}");

    // The account syncs with the stored token, and a second sign-in of it is a duplicate.
    assert_eq!(f.sync(&id)["state"], "idle");
    let dup = f.flow(None, "authcode-second-02", EMAIL);
    assert_eq!((dup["ok"].clone(), dup["code"].clone()), (json!(false), json!("DUPLICATE")), "{dup}");
    assert_eq!(f.rpc("mobile.accounts.list", json!({}))["accounts"].as_array().unwrap().len(), 1);

    f.assert_no_secret_leaked(&["authcode-SECRET-77", "authcode-second-02"]);
}

#[test]
fn an_expiring_token_is_refreshed_once_for_parallel_callers() {
    let _port = port();
    let f = setup();
    let id = f.sign_in();
    let old = f.cred(&id);
    // Ten seconds left: inside the one-minute margin, so the next caller refreshes.
    f.expire_at(&id, now_ms() + 10_000);
    assert_eq!(f.refresh_posts(), 0);

    let engine = &f.engine;
    let barrier = Barrier::new(8);
    let got: Vec<Result<String, String>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                s.spawn(|| {
                    barrier.wait();
                    engine.oauth_access_token(&id)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let first = got[0].clone().expect("a token");
    assert!(got.iter().all(|t| t.as_ref() == Ok(&first)), "every caller gets the one new token: {got:?}");
    assert_ne!(Some(first.as_str()), old.access.as_deref(), "a new token");
    assert!(f.authority.is_valid(&first));
    assert_eq!(f.refresh_posts(), 1, "one refresh for eight callers");

    // Stored, with its new expiry; the next caller takes it without a request.
    let c = f.cred(&id);
    assert_eq!(c.access.as_deref(), Some(first.as_str()));
    assert!(c.expires_ms.unwrap() > now_ms() + 3_000_000);
    assert_eq!(c.refresh, old.refresh, "the refresh token stays");
    assert_eq!(f.engine.oauth_access_token(&id).as_deref(), Ok(first.as_str()));
    assert_eq!(f.refresh_posts(), 1);
    // The refresh posted the client that issued the grant.
    let post = f.authority.posts().into_iter().find(|p| p.grant_type == "refresh_token").unwrap();
    assert_eq!(Some(post.client_id.as_str()), old.client_id.as_deref());
    f.assert_no_secret_leaked(&[]);
}

#[test]
fn a_revoked_refresh_token_marks_the_account_and_stops() {
    let _port = port();
    let f = setup();
    let id = f.sign_in();
    assert_eq!(f.sync(&id)["state"], "idle");
    let cred = f.cred(&id);
    f.authority.revoke(cred.refresh.as_deref().unwrap());
    f.expire_at(&id, now_ms() - 1_000);

    // The next sync refreshes, the provider refuses: the account is marked, once, and says so.
    let from = f.events.len();
    let end = f.sync(&id);
    assert_eq!((end["state"].clone(), end["code"].clone()), (json!("error"), json!("NEEDS_AUTH")), "{end}");
    let marked = f.events.wait(from, "NEEDS_AUTH", |n, v| n == "mobile.sync.state" && v["code"] == "NEEDS_AUTH");
    assert_eq!(marked["accountId"], id.as_str());
    assert_eq!(f.needs_auth(&id), 1);
    assert_eq!(f.refresh_posts(), 1);
    let listed = f.rpc("mobile.accounts.list", json!({}));
    assert_eq!(listed["accounts"][0]["needsAuth"], true, "{listed}");

    // From here on nothing reaches the network: not sync, not the replay, not the outbox.
    let connections = f.imap.connection_count();
    let applied = f.rpc("mobile.actions.apply", json!({ "accountId": id, "folder": "INBOX", "uids": [1], "kind": "seen" }));
    assert!(applied["queued"].is_i64(), "{applied}");
    let sent = f.rpc(
        "mobile.compose.send",
        json!({ "accountId": id, "to": "rcpt@example.test", "cc": "", "bcc": "", "subject": "Held", "text": "Body", "attachments": [] }),
    );
    let out_id = sent["id"].as_str().unwrap().to_string();
    let before = f.events.len();
    let again = f.sync(&id);
    assert_eq!(again["code"], "NEEDS_AUTH", "{again}");
    let flashed = f.events.all()[before..].iter().any(|(n, v)| n == "mobile.sync.state" && v["state"] == "syncing");
    assert!(!flashed, "a parked account never reports a pass starting");
    assert_eq!(f.engine.oauth_access_token(&id), Err("NEEDS_AUTH".to_string()));
    // Many backoff periods (50 ms, capped at 200 ms) pass.
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(f.imap.connection_count(), connections, "no IMAP connection while the account needs a new sign-in");
    assert!(f.imap.sent_messages().is_empty(), "nothing was sent");
    assert_eq!(f.refresh_posts(), 1, "no second refresh of a revoked grant");
    let pending: i64 = f.db().query_row("SELECT count(*) FROM pending_actions WHERE account_id = ?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(pending, 1, "the action waits in the journal");
    let state: String = f.db().query_row("SELECT state FROM outbox WHERE id = ?1", [&out_id], |r| r.get(0)).unwrap();
    assert_eq!(state, "queued", "the send waits in the outbox");
    let sync_errors = f.events.all().iter().filter(|(n, v)| n == "mobile.sync.state" && v["code"] == "NEEDS_AUTH").count();
    assert!(sync_errors <= 4, "no spinning: {sync_errors} NEEDS_AUTH events");
    f.assert_no_secret_leaked(&[]);
}

#[test]
fn reauth_clears_needs_auth_and_resumes_sync() {
    let _port = port();
    let f = setup();
    let id = f.sign_in();
    assert_eq!(f.sync(&id)["state"], "idle");
    let old = f.cred(&id);
    f.authority.revoke(old.refresh.as_deref().unwrap());
    f.expire_at(&id, now_ms() - 1_000);
    assert_eq!(f.engine.oauth_access_token(&id), Err("NEEDS_AUTH".to_string()));
    assert_eq!(f.needs_auth(&id), 1);
    // Queued while parked.
    let applied = f.rpc("mobile.actions.apply", json!({ "accountId": id, "folder": "INBOX", "uids": [1], "kind": "seen" }));
    let seq = applied["queued"].as_i64().unwrap();

    // Signing in as somebody else does not replace this account's tokens.
    let other = f.flow(Some(&id), "authcode-other-0003", "someone.else@gmail.com");
    assert_eq!((other["ok"].clone(), other["code"].clone()), (json!(false), json!("AUTH_FAILED")), "{other}");
    assert_eq!(f.needs_auth(&id), 1);
    assert_eq!(f.cred(&id).refresh, old.refresh);

    // The reauth URL names the account.
    let begun = f.rpc("mobile.oauth.reauth", json!({ "accountId": id }));
    assert!(begun["url"].as_str().unwrap().contains("login_hint=person%40gmail.com"), "{begun}");
    f.rpc("mobile.oauth.cancel", json!({ "flowId": begun["flowId"] }));

    let from = f.events.len();
    let r = f.flow(Some(&id), "authcode-again-0004", EMAIL);
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["account"]["id"], id.as_str());
    assert_eq!(f.needs_auth(&id), 0);
    let fresh = f.cred(&id);
    assert_ne!(fresh.refresh, old.refresh, "the new grant's tokens are stored");
    assert!(f.authority.is_valid(fresh.access.as_deref().unwrap()));

    // Sync resumes on its own, and the parked action goes out.
    let end = f.events.sync_end(from, &id);
    assert_eq!(end["state"], "idle", "{end}");
    let done = f.events.wait(from, "action done", |n, v| n == "mobile.action.result" && v["seq"] == seq);
    assert_eq!(done["outcome"], "done", "{done}");
    let state = f.imap.state();
    let inbox = state.find("INBOX").unwrap();
    assert!(inbox.messages.iter().find(|m| m.uid == 1).unwrap().flags.iter().any(|x| x.eq_ignore_ascii_case("\\Seen")));
    assert_eq!(f.rpc("mobile.accounts.list", json!({}))["accounts"][0]["needsAuth"], false);
    f.assert_no_secret_leaked(&["authcode-other-0003", "authcode-again-0004"]);
}

#[test]
fn finish_times_out_and_cancel_releases_the_listener() {
    let _port = port();
    let f = setup();
    f.engine.set_oauth_finish_timeout(Duration::from_millis(300));

    // Nobody comes back: TIMEOUT, nothing stored, the port is free again.
    let flow = f.rpc("mobile.oauth.begin", json!({ "provider": "google" }))["flowId"].clone();
    assert!(!port_is_free(), "the listener holds the port while a flow is open");
    let r = f.rpc("mobile.oauth.finish", json!({ "flowId": flow }));
    assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!("TIMEOUT")), "{r}");
    assert!(port_is_free(), "a timed out flow frees the port");
    assert_eq!(f.rpc("mobile.accounts.list", json!({}))["accounts"].as_array().unwrap().len(), 0);

    // A cancel ends a waiting finish at once.
    f.engine.set_oauth_finish_timeout(Duration::from_secs(30));
    let flow = f.rpc("mobile.oauth.begin", json!({ "provider": "google" }))["flowId"].as_str().unwrap().to_string();
    let t0 = Instant::now();
    let r = std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_millis(200));
            f.rpc("mobile.oauth.cancel", json!({ "flowId": flow }))
        });
        f.rpc("mobile.oauth.finish", json!({ "flowId": flow }))
    });
    assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!("CANCELLED")), "{r}");
    assert!(t0.elapsed() < Duration::from_secs(10), "the cancel did not wait for the timeout");
    assert!(port_is_free(), "a cancelled flow frees the port");

    // The listener stays while any flow is open, and goes with the last.
    let a = f.rpc("mobile.oauth.begin", json!({ "provider": "google" }))["flowId"].clone();
    let b = f.rpc("mobile.oauth.begin", json!({ "provider": "microsoft" }))["flowId"].clone();
    assert_eq!(f.rpc("mobile.oauth.cancel", json!({ "flowId": a })), json!({ "cancelled": true }));
    assert!(!port_is_free(), "one flow is still open");
    assert!(!f.engine.oauth_deliver_code(a.as_str().unwrap(), "late-code"), "a cancelled flow takes no code");
    assert_eq!(f.engine.rpc("mobile.oauth.finish", json!({ "flowId": a })).unwrap_err().code(), "INVALID");
    assert_eq!(f.rpc("mobile.oauth.cancel", json!({ "flowId": b })), json!({ "cancelled": true }));
    assert!(port_is_free(), "the last cancel frees the port");
    assert_eq!(f.rpc("mobile.oauth.cancel", json!({ "flowId": b })), json!({ "cancelled": false }));

    // The engine going away frees it too.
    f.rpc("mobile.oauth.begin", json!({ "provider": "google" }));
    assert!(!port_is_free());
    let Fx { engine, .. } = f;
    drop(engine);
    assert!(port_is_free(), "dropping the engine frees the port");
}

/// The host of `url`, and the value of query field `key` (still percent-encoded).
fn host_of(url: &str) -> &str {
    url.split_once("://").unwrap().1.split(['/', '?']).next().unwrap()
}

fn query(url: &str, key: &str) -> Option<String> {
    url.split_once('?')?.1.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
}

#[test]
fn the_auth_url_targets_only_the_provider_host() {
    let _port = port();
    let f = setup();
    let g = f.rpc("mobile.oauth.begin", json!({ "provider": "google", "loginHint": EMAIL }));
    let url = g["url"].as_str().unwrap();
    assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"), "{url}");
    assert_eq!(host_of(url), "accounts.google.com");
    assert_eq!(url.matches("://").count(), 1, "no other URL in clear: {url}");
    assert_eq!(query(url, "redirect_uri").as_deref(), Some("http%3A%2F%2Flocalhost%3A19876%2Fcallback"));
    assert_eq!(query(url, "code_challenge_method").as_deref(), Some("S256"));
    assert!(query(url, "scope").unwrap().contains("https%3A%2F%2Fmail.google.com%2F"), "{url}");
    assert_eq!(query(url, "login_hint").as_deref(), Some("person%40gmail.com"));
    assert!(query(url, "state").is_some_and(|s| s.len() == 32));

    let m = f.rpc("mobile.oauth.begin", json!({ "provider": "microsoft" }));
    let url = m["url"].as_str().unwrap();
    assert!(url.starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"), "{url}");
    assert_eq!(host_of(url), "login.microsoftonline.com");
    assert_eq!(url.matches("://").count(), 1, "no other URL in clear: {url}");
    let scope = query(url, "scope").unwrap();
    // Graph (Ruling 5), plus the profile read `/me` needs; never the IMAP scopes.
    assert!(scope.contains("Mail.ReadWrite") && scope.contains("Mail.Send") && scope.contains("User.Read"), "{scope}");
    assert!(!scope.contains("IMAP"), "{scope}");
    assert_eq!(query(url, "redirect_uri").as_deref(), Some("http%3A%2F%2Flocalhost%3A19876%2Fcallback"));

    assert_eq!(f.engine.rpc("mobile.oauth.begin", json!({ "provider": "yahoo" })).unwrap_err().code(), "INVALID");
    // A password account cannot be signed in again through a provider.
    assert_eq!(f.engine.rpc("mobile.oauth.reauth", json!({ "accountId": "acc_missing" })).unwrap_err().code(), "INVALID");
    for flow in [&g["flowId"], &m["flowId"]] {
        f.rpc("mobile.oauth.cancel", json!({ "flowId": flow }));
    }
    assert!(port_is_free());
}

// ── Graph stub for the Microsoft address check ─────────────────────────────

/// A Graph base on this machine (`MAILVAULT_GRAPH_BASE`, read once per process). `"me401"`:
/// `/me` is refused with 401 while the mailbox itself answers (a folder list with an Inbox), so
/// only the address is missing. `"drop"`: every connection is closed unanswered.
struct GraphStub {
    mode: Arc<Mutex<&'static str>>,
}

fn graph_stub() -> &'static GraphStub {
    static STUB: std::sync::OnceLock<GraphStub> = std::sync::OnceLock::new();
    STUB.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::env::set_var("MAILVAULT_GRAPH_BASE", format!("http://{addr}"));
        let mode: Arc<Mutex<&'static str>> = Arc::new(Mutex::new("me401"));
        let m = Arc::clone(&mode);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let mode = *m.lock().unwrap();
                let mut out = conn.try_clone().unwrap();
                let mut reader = BufReader::new(conn);
                let mut request = String::new();
                let _ = reader.read_line(&mut request);
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = h.split_once(':') {
                        if k.eq_ignore_ascii_case("content-length") {
                            len = v.trim().parse().unwrap_or(0);
                        }
                    }
                }
                let mut body = vec![0u8; len];
                let _ = reader.read_exact(&mut body);
                if mode == "me401" {
                    let path = request.split_whitespace().nth(1).unwrap_or("");
                    let (status, body) = if path.starts_with("/me/mailFolders") {
                        ("200 OK", json!({ "value": [{ "id": "inbox-id", "displayName": "Inbox", "totalItemCount": 0, "unreadItemCount": 0 }] }).to_string())
                    } else if path.starts_with("/$batch") {
                        ("200 OK", json!({ "responses": [{ "id": "inbox", "status": 200, "body": { "id": "inbox-id" } }] }).to_string())
                    } else {
                        ("401 Unauthorized", json!({ "error": { "code": "Authorization_RequestDenied", "message": "Insufficient privileges" } }).to_string())
                    };
                    let _ = write!(out, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                }
                // "drop": closed with no answer.
            }
        });
        GraphStub { mode }
    })
}

/// A Microsoft flow (or a reauth of `reauth`) whose code redeems; the finish reply.
fn microsoft_flow(f: &Fx, reauth: Option<&str>, code: &str) -> Value {
    let begun = match reauth {
        None => f.rpc("mobile.oauth.begin", json!({ "provider": "microsoft", "loginHint": "typed@outlook.com" })),
        Some(id) => f.rpc("mobile.oauth.reauth", json!({ "accountId": id })),
    };
    let flow = begun["flowId"].as_str().unwrap().to_string();
    f.tokens.expect_code(code, "ignored@outlook.com");
    assert!(f.engine.oauth_deliver_code(&flow, code));
    f.rpc("mobile.oauth.finish", json!({ "flowId": flow }))
}

#[test]
fn microsoft_finish_refuses_when_graph_cannot_name_the_address() {
    let _port = port();
    let stub = graph_stub();
    let f = setup();

    // Graph will not name the address (the mailbox itself answers): AUTH_FAILED, and the typed
    // address is never taken instead.
    *stub.mode.lock().unwrap() = "me401";
    let r = microsoft_flow(&f, None, "authcode-ms-0005");
    assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!("AUTH_FAILED")), "{r}");
    // Graph cannot be reached: a network code the user can retry on.
    *stub.mode.lock().unwrap() = "drop";
    let r = microsoft_flow(&f, None, "authcode-ms-0006");
    assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!("HOST_UNREACHABLE")), "{r}");
    assert!(port_is_free(), "the flows ended");
    let rows: i64 = f.db().query_row("SELECT count(*) FROM accounts", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "nothing stored");
    assert_eq!(f.secrets.sets.load(Ordering::SeqCst), 0, "no secret stored");

    // A reauth whose /me fails leaves the account and its credential as they were.
    f.db()
        .execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, provider, needs_auth, created_ms)
             VALUES ('acc_00000000000000aa', 'owner@outlook.com', 'owner@outlook.com', 'outlook.office365.com', 993, 'ssl', 'graph', 'oauth2', 'microsoft', 1, 1)",
            [],
        )
        .unwrap();
    let old = Credential::from_tokens("old-rt-ms", "old-at-ms", 1);
    f.secrets.set("acc_00000000000000aa", &old.to_secret()).unwrap();
    for mode in ["me401", "drop"] {
        *stub.mode.lock().unwrap() = mode;
        let r = microsoft_flow(&f, Some("acc_00000000000000aa"), &format!("authcode-ms-re-{mode}"));
        assert_eq!(r["ok"], false, "{r}");
        assert_eq!(f.cred("acc_00000000000000aa"), old, "the stored credential is untouched");
        assert_eq!(f.needs_auth("acc_00000000000000aa"), 1);
    }
    assert!(port_is_free());
    f.assert_no_secret_leaked(&["authcode-ms-0005", "authcode-ms-0006", "authcode-ms-re-me401", "authcode-ms-re-drop"]);
}

#[test]
fn a_token_the_server_keeps_refusing_parks_the_account() {
    let _port = port();
    let f = setup();
    let id = f.sign_in();
    assert_eq!(f.sync(&id)["state"], "idle");
    // Refusals count at once here; the span rule has its own test.
    f.engine.set_oauth_refusal_span(Duration::ZERO);

    // The grant refreshes fine, but the mailbox refuses every token (IMAP turned off).
    f.authority.refuse_valid_tokens(true);
    for _ in 0..2 {
        let end = f.sync(&id);
        assert_eq!(end["code"], "AUTH_FAILED", "{end}");
    }
    assert_eq!(f.needs_auth(&id), 0, "two refusals do not park it");
    // A sign-in that works ends the run.
    f.authority.refuse_valid_tokens(false);
    assert_eq!(f.sync(&id)["state"], "idle");
    f.authority.refuse_valid_tokens(true);
    for _ in 0..2 {
        assert_eq!(f.sync(&id)["code"], "AUTH_FAILED");
    }
    assert_eq!(f.needs_auth(&id), 0, "the count started again");
    let posts = f.refresh_posts();
    let end = f.sync(&id);
    assert_eq!(end["code"], "NEEDS_AUTH", "the third refusal in a row parks the account: {end}");
    assert_eq!(f.needs_auth(&id), 1);
    assert_eq!(f.refresh_posts(), posts + 1, "one refresh per attempt");

    // Parked: no more logins or refreshes.
    let connections = f.imap.connection_count();
    let posts = f.refresh_posts();
    assert_eq!(f.sync(&id)["code"], "NEEDS_AUTH");
    assert_eq!(f.imap.connection_count(), connections);
    assert_eq!(f.refresh_posts(), posts);
    f.assert_no_secret_leaked(&[]);
}

#[test]
fn a_stale_flow_releases_the_listener() {
    let _port = port();
    let f = setup();
    f.engine.set_oauth_finish_timeout(Duration::from_millis(200));

    // Begun and abandoned: the next flow call past the finish window drops it and frees the port.
    let a = f.rpc("mobile.oauth.begin", json!({ "provider": "google" }))["flowId"].as_str().unwrap().to_string();
    assert!(!port_is_free());
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(f.rpc("mobile.oauth.cancel", json!({ "flowId": "flow_0000000000000000" })), json!({ "cancelled": false }));
    assert!(port_is_free(), "the stale flow was dropped and the listener shut");
    assert!(!f.engine.oauth_deliver_code(&a, "late"), "a dropped flow takes no code");

    // A new begin drops a stale flow too, and the listener stays for the new one.
    let b = f.rpc("mobile.oauth.begin", json!({ "provider": "google" }))["flowId"].as_str().unwrap().to_string();
    std::thread::sleep(Duration::from_millis(400));
    let c = f.rpc("mobile.oauth.begin", json!({ "provider": "google" }))["flowId"].clone();
    assert!(!f.engine.oauth_deliver_code(&b, "late"), "the stale flow is gone");
    assert!(!port_is_free(), "the new flow keeps the listener");
    assert_eq!(f.rpc("mobile.oauth.cancel", json!({ "flowId": c })), json!({ "cancelled": true }));
    assert!(port_is_free());
}

#[test]
fn fresh_token_refusals_park_only_when_they_span_time() {
    let _port = port();
    let f = setup();
    let id = f.sign_in();
    assert_eq!(f.sync(&id)["state"], "idle");
    f.engine.set_oauth_refusal_span(Duration::from_millis(1500));

    // A provider hiccup: three fresh tokens refused in a moment do not park the account.
    f.authority.refuse_valid_tokens(true);
    for _ in 0..4 {
        assert_eq!(f.sync(&id)["code"], "AUTH_FAILED");
    }
    assert_eq!(f.needs_auth(&id), 0, "refusals inside a short span never park");
    // Refusals that go on over the span do.
    std::thread::sleep(Duration::from_millis(1600));
    let end = f.sync(&id);
    assert_eq!(end["code"], "NEEDS_AUTH", "{end}");
    assert_eq!(f.needs_auth(&id), 1);
    f.assert_no_secret_leaked(&[]);
}
