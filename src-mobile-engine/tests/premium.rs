//! Premium entitlement in the engine (plan 4 Task 3): the server's answer cached until the expiry
//! it returned, the clock guard, store receipt verification, verified web sign-in, and no secret
//! (install id, customer id, receipt, sign-in code) in mobile.db, a log line, an event or a reply.
//!
//! The billing server is a stub on loopback: `MV_BILLING_BASE` points the engine at it (debug
//! builds only). One stub per process, so the tests take turns ([`serial`]).

use mailvault_mobile_engine::{Engine, MemorySecrets, RpcError, SecretStore};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};

const APPLE: &str = "/api/billing/store/apple/verify";
const GOOGLE: &str = "/api/billing/store/google/verify";
const STATUS: &str = "/api/billing/subscription-status";
const SIGNIN_START: &str = "/api/billing/signin/start";
const SIGNIN_VERIFY: &str = "/api/billing/signin/verify";

const HOUR: i64 = 3_600_000;
const JWS: &str = "jws-SECRET-receipt-0123456789";
const PLAY_TOKEN: &str = "play-SECRET-token-0123456789";
const CUSTOMER: &str = "cus_SECRETcustomer01";
const EMAIL: &str = "reader@example.test";
const CODE: &str = "493817";

// ── The billing stub ──────────────────────────────────────────────────────────

#[derive(Clone)]
enum Answer {
    Json(u16, Value),
    /// Reads the request and closes the socket without a reply: the network failed.
    Drop,
    /// The first answer whose text the request body contains, else the last one.
    ByBody(Vec<(&'static str, Answer)>, Box<Answer>),
    /// Holds the reply until the gate opens.
    Gated(Arc<Gate>, Box<Answer>),
}

#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn wait(&self) {
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.cv.wait(open).unwrap();
        }
    }

    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.cv.notify_all();
    }
}

#[derive(Clone, Debug)]
struct Req {
    method: String,
    path: String,
    query: String,
    body: String,
}

#[derive(Default)]
struct StubState {
    routes: HashMap<String, Answer>,
    requests: Vec<Req>,
}

struct Stub {
    state: Arc<Mutex<StubState>>,
}

fn stub() -> &'static Stub {
    static STUB: OnceLock<Stub> = OnceLock::new();
    STUB.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::env::set_var("MV_BILLING_BASE", format!("http://{addr}"));
        let state: Arc<Mutex<StubState>> = Arc::default();
        let s = Arc::clone(&state);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let s = Arc::clone(&s);
                std::thread::spawn(move || {
                    let _ = serve(conn, &s);
                });
            }
        });
        Stub { state }
    })
}

fn serve(conn: TcpStream, state: &Mutex<StubState>) -> std::io::Result<()> {
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    let answer = {
        let mut st = state.lock().unwrap_or_else(|p| p.into_inner());
        st.requests.push(Req { method, path: path.clone(), query, body: String::from_utf8_lossy(&body).into_owned() });
        st.routes.get(&path).cloned().unwrap_or(Answer::Json(404, json!({ "error": "not_found" })))
    };
    let mut conn = conn;
    let mut answer = answer;
    loop {
        answer = match answer {
            Answer::ByBody(list, other) => {
                let text = String::from_utf8_lossy(&body).into_owned();
                list.into_iter().find(|(k, _)| text.contains(k)).map(|(_, a)| a).unwrap_or(*other)
            }
            Answer::Gated(gate, then) => {
                gate.wait();
                *then
            }
            a => break a_reply(&mut conn, a),
        };
    }
}

fn a_reply(conn: &mut TcpStream, answer: Answer) -> std::io::Result<()> {
    match answer {
        Answer::Drop | Answer::ByBody(..) | Answer::Gated(..) => Ok(()),
        Answer::Json(status, v) => {
            let body = v.to_string();
            write!(
                conn,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )?;
            conn.flush()
        }
    }
}

impl Stub {
    fn st(&self) -> MutexGuard<'_, StubState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn reset(&self) {
        *self.st() = StubState::default();
    }

    fn route(&self, path: &str, answer: Answer) {
        self.st().routes.insert(path.to_string(), answer);
    }

    fn requests(&self, path: &str) -> Vec<Req> {
        self.st().requests.iter().filter(|r| r.path == path).cloned().collect()
    }

    fn all_requests(&self) -> Vec<Req> {
        self.st().requests.clone()
    }
}

fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn iso(ms: i64) -> String {
    // Days from civil, inverted: enough for the stub's period ends.
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms.rem_euclid(1000))
}

fn store_ok(expires_ms: i64, source: &str) -> Answer {
    Answer::Json(200, json!({ "entitled": true, "source": source, "expiresMs": expires_ms }))
}

/// The status endpoint's answer for a subscriber, as `website/api/server.js` builds it.
fn web_status(granted: bool, premium: bool, period_end_ms: i64, replaced: Option<Value>) -> Answer {
    let mut v = json!({
        "customerId": CUSTOMER,
        "customerEmail": EMAIL,
        "hasSubscription": true,
        "status": "active",
        "priceId": "price_x",
        "interval": "month",
        "currentPeriodEnd": iso(period_end_ms),
        "cancelAtPeriodEnd": false,
        "premiumAccess": premium,
        "clientLimit": 5,
        "activeClientCount": 1,
        "activeClients": [{ "clientId": "someone-elses-install", "clientName": "Mac", "platform": "macos" }],
        "currentClientId": "echoed",
        "clientAccessGranted": granted,
    });
    if let Some(r) = replaced {
        v["replacedClient"] = r;
    }
    Answer::Json(200, v)
}

// ── Fixture ─────────────────────────────────────────────────────────────────

struct Fx {
    tmp: tempfile::TempDir,
    secrets: Arc<MemorySecrets>,
    logs: Arc<Mutex<Vec<String>>>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
    /// `None` only while [`Fx::reopen`] swaps it, and after a test dropped it.
    engine: Option<Engine>,
}

fn open_in(dir: &Path, secrets: &Arc<MemorySecrets>, logs: &Arc<Mutex<Vec<String>>>, events: &Arc<Mutex<Vec<(String, Value)>>>) -> Engine {
    let e = Engine::open(dir, &dir.join("cache"), Arc::clone(secrets) as Arc<dyn SecretStore>).unwrap();
    let l = Arc::clone(logs);
    e.set_log_sink(move |line| l.lock().unwrap().push(line.to_string()));
    let ev = Arc::clone(events);
    e.set_event_sink(move |name, payload| ev.lock().unwrap().push((name.to_string(), payload)));
    e
}

fn setup() -> (MutexGuard<'static, ()>, Fx) {
    let guard = serial();
    stub().reset();
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let logs = Arc::default();
    let events = Arc::default();
    let engine = open_in(tmp.path(), &secrets, &logs, &events);
    (guard, Fx { tmp, secrets, logs, events, engine: Some(engine) })
}

impl Fx {
    fn e(&self) -> &Engine {
        self.engine.as_ref().expect("engine open")
    }

    fn rpc(&self, method: &str, params: Value) -> Value {
        self.e().rpc(method, params).unwrap_or_else(|e| panic!("{method}: {e:?}"))
    }

    fn err(&self, method: &str, params: Value) -> RpcError {
        match self.e().rpc(method, params) {
            Ok(v) => panic!("{method}: expected an error, got {v}"),
            Err(e) => e,
        }
    }

    fn status(&self) -> Value {
        self.rpc("mobile.premium.status", json!({}))
    }

    fn premium(&self) -> bool {
        self.status()["premium"].as_bool().unwrap()
    }

    fn clock(&self, ms: i64) {
        self.e().set_premium_clock_for_tests(Some(ms));
    }

    /// Closes the engine (search.db is held EXCLUSIVE) and opens it again on the same files.
    fn reopen(&mut self) {
        drop(self.engine.take());
        self.engine = Some(open_in(self.tmp.path(), &self.secrets, &self.logs, &self.events));
    }

    fn secret(&self, key: &str) -> Option<String> {
        self.secrets.get(key).unwrap()
    }

    fn verify_apple(&self) -> Result<Value, RpcError> {
        self.e().rpc("mobile.premium.verify", json!({ "platform": "apple", "jws": JWS }))
    }

    fn sign_in(&self) -> Result<Value, RpcError> {
        self.e().rpc("mobile.premium.webSignIn.verify", json!({ "email": EMAIL, "code": CODE }))
    }

    fn premium_events(&self) -> Vec<Value> {
        self.events.lock().unwrap().iter().filter(|(n, _)| n == "mobile.premium.changed").map(|(_, v)| v.clone()).collect()
    }
}

fn files_under(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let p = entry.path();
        if p.is_dir() {
            files_under(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn contains_bytes(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn entitled_until_expiry_then_not_without_network() {
    let (_g, fx) = setup();
    let now = now_ms();
    let expires = now + HOUR;
    stub().route(APPLE, store_ok(expires, "apple"));
    assert_eq!(fx.status(), json!({ "premium": false, "source": null, "expiresMs": null }), "free before any purchase");

    let reply = fx.verify_apple().unwrap();
    assert_eq!(reply, json!({ "premium": true, "source": "apple", "expiresMs": expires }));
    assert_eq!(fx.status(), reply);
    let installs = stub().requests(APPLE);
    assert_eq!(installs.len(), 1);
    assert_eq!(installs[0].method, "POST");
    let body: Value = serde_json::from_str(&installs[0].body).unwrap();
    assert_eq!(body["signedTransaction"], JWS);
    let install = fx.secret("premium.installId").expect("install id in the secret store");
    assert_eq!(body["installId"], install.as_str());
    assert_eq!(
        fx.rpc("mobile.premium.installId", json!({})),
        json!({ "installId": install, "appAccountToken": mailvault_mobile_engine::apple_account_token(&install) })
    );

    fx.clock(expires - 60_000);
    assert!(fx.premium(), "still entitled a minute before the store's expiry");
    fx.clock(expires + 60_000);
    assert!(!fx.premium(), "no grace period after the store's expiry");

    // Offline after expiry: the check fails and nothing comes back.
    stub().route(APPLE, Answer::Drop);
    let e = fx.err("mobile.premium.refresh", json!({}));
    assert_eq!(e.code(), "NETWORK");
    assert!(!fx.premium());
    assert_eq!(stub().requests(APPLE).len(), 2, "an expired cache is always re-checked");

    // A Play purchase goes through the same path.
    fx.clock(now);
    stub().route(GOOGLE, store_ok(now + 2 * HOUR, "google"));
    let reply = fx
        .rpc("mobile.premium.verify", json!({ "platform": "google", "token": PLAY_TOKEN, "productId": "com.mailvault.app.premium.monthly" }));
    assert_eq!(reply, json!({ "premium": true, "source": "google", "expiresMs": now + 2 * HOUR }));
    let body: Value = serde_json::from_str(&stub().requests(GOOGLE)[0].body).unwrap();
    assert_eq!(body, json!({ "purchaseToken": PLAY_TOKEN, "productId": "com.mailvault.app.premium.monthly", "installId": install }));
    let events = fx.premium_events();
    assert!(events.contains(&json!({ "premium": true, "source": "google", "expiresMs": now + 2 * HOUR })), "{events:?}");
}

#[test]
fn verify_with_restore_sends_the_flag() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(APPLE, store_ok(now + HOUR, "apple"));
    stub().route(GOOGLE, store_ok(now + HOUR, "google"));
    fx.e().rpc("mobile.premium.verify", json!({ "platform": "apple", "jws": JWS, "restore": true })).unwrap();
    let body: Value = serde_json::from_str(&stub().requests(APPLE)[0].body).unwrap();
    assert_eq!(body["restore"], json!(true));
    // A plain verify leaves the key out; so does the refresh that re-posts the stored receipt.
    fx.verify_apple().unwrap();
    fx.clock(now + 2 * HOUR / 3);
    let _ = fx.rpc("mobile.premium.refresh", json!({ "force": true }));
    assert!(stub().requests(APPLE).len() >= 3, "the refresh re-posted the receipt");
    for r in &stub().requests(APPLE)[1..] {
        let b: Value = serde_json::from_str(&r.body).unwrap();
        assert!(b.get("restore").is_none(), "{b}");
    }
    fx.e().rpc("mobile.premium.verify", json!({ "platform": "google", "token": PLAY_TOKEN, "productId": "com.mailvault.app.premium.monthly", "restore": true })).unwrap();
    let body: Value = serde_json::from_str(&stub().requests(GOOGLE)[0].body).unwrap();
    assert_eq!(body["restore"], json!(true));
}

#[test]
fn verify_restore_passes_the_app_transaction() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(APPLE, store_ok(now + HOUR, "apple"));
    const APP_TX: &str = "apptx-SECRET-jws-0123456789";
    // Restore: the AppTransaction goes along as signedAppTransaction.
    fx.e()
        .rpc("mobile.premium.verify", json!({ "platform": "apple", "jws": JWS, "restore": true, "appTransaction": APP_TX }))
        .unwrap();
    let body: Value = serde_json::from_str(&stub().requests(APPLE)[0].body).unwrap();
    assert_eq!(body["restore"], json!(true));
    assert_eq!(body["signedAppTransaction"], json!(APP_TX));
    // Without restore it is not sent, and the refresh re-post never sends it.
    fx.e().rpc("mobile.premium.verify", json!({ "platform": "apple", "jws": JWS, "appTransaction": APP_TX })).unwrap();
    fx.clock(now + 2 * HOUR / 3);
    let _ = fx.rpc("mobile.premium.refresh", json!({ "force": true }));
    let requests = stub().requests(APPLE);
    assert!(requests.len() >= 3, "the refresh re-posted the receipt");
    for r in &requests[1..] {
        let b: Value = serde_json::from_str(&r.body).unwrap();
        assert!(b.get("signedAppTransaction").is_none() && b.get("restore").is_none(), "{b}");
    }
    // Restore without one: the key is left out.
    fx.e().rpc("mobile.premium.verify", json!({ "platform": "apple", "jws": JWS, "restore": true, "appTransaction": " " })).unwrap();
    let last: Value = serde_json::from_str(&stub().requests(APPLE).last().unwrap().body).unwrap();
    assert_eq!(last["restore"], json!(true));
    assert!(last.get("signedAppTransaction").is_none(), "{last}");
    // The AppTransaction is never stored, logged or returned.
    let receipt = fx.secret("premium.receipt").expect("receipt kept");
    assert!(!receipt.contains(APP_TX), "{receipt}");
    assert!(!fx.status().to_string().contains(APP_TX));
    assert!(fx.logs.lock().unwrap().iter().all(|l| !l.contains(APP_TX)));
    let mut files = Vec::new();
    files_under(fx.tmp.path(), &mut files);
    for f in files {
        assert!(!contains_bytes(&std::fs::read(&f).unwrap(), APP_TX), "{} holds the AppTransaction", f.display());
    }
}

#[test]
fn lapsed_then_clock_moved_back_offline_is_not_entitled() {
    let (_g, mut fx) = setup();
    let now = now_ms();
    stub().route(APPLE, store_ok(now + HOUR, "apple"));
    fx.verify_apple().unwrap();
    assert!(fx.premium());

    // The subscription lapses while the phone is offline.
    stub().route(APPLE, Answer::Drop);
    fx.clock(now + 2 * HOUR);
    assert!(!fx.premium(), "lapsed");

    // Setting the clock back inside the old period brings nothing back, even after a restart.
    fx.clock(now + HOUR / 2);
    assert!(!fx.premium(), "clock set back below the latest time seen");
    assert_eq!(fx.err("mobile.premium.refresh", json!({})).code(), "NETWORK");
    fx.reopen();
    fx.clock(now + HOUR / 2);
    assert!(!fx.premium(), "the latest time seen survives a restart");

    // A few minutes of drift is no tampering.
    fx.clock(now + 2 * HOUR - 4 * 60_000);
    assert!(!fx.premium(), "past expiry anyway");

    // Back online: a successful check is the answer again, whatever the clock said before.
    stub().route(APPLE, store_ok(now + 3 * HOUR, "apple"));
    fx.clock(now + HOUR / 2);
    let reply = fx.rpc("mobile.premium.refresh", json!({}));
    assert_eq!(reply["premium"], true, "{reply}");
    assert!(fx.premium());
}

#[test]
fn refused_receipt_clears_premium() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(APPLE, store_ok(now + HOUR, "apple"));
    fx.verify_apple().unwrap();
    assert!(fx.premium());

    stub().route(APPLE, Answer::Json(400, json!({ "error": "revoked" })));
    let e = fx.verify_apple().unwrap_err();
    assert_eq!(e.code(), "REFUSED");
    assert!(!e.to_string().contains("revoked"), "server text never reaches the reply: {e}");
    assert!(!fx.premium(), "a refused receipt ends Premium at once");
    assert_eq!(fx.premium_events().last().unwrap(), &json!({ "premium": false, "source": null, "expiresMs": null }));

    // A rate limit is not a refusal: Premium stays.
    stub().route(APPLE, store_ok(now + HOUR, "apple"));
    fx.verify_apple().unwrap();
    stub().route(APPLE, Answer::Json(429, json!({ "error": "rate_limited" })));
    assert_eq!(fx.verify_apple().unwrap_err().code(), "RATE_LIMITED");
    assert!(fx.premium());

    // Neither is a server error.
    stub().route(APPLE, Answer::Json(503, json!({ "error": "down" })));
    assert_eq!(fx.verify_apple().unwrap_err().code(), "NETWORK");
    assert!(fx.premium());

    // A store answer that is no longer entitled ends it too, with no error.
    stub().route(APPLE, Answer::Json(200, json!({ "entitled": false, "source": "apple", "expiresMs": now - HOUR })));
    assert_eq!(fx.verify_apple().unwrap()["premium"], false);
    assert!(!fx.premium());

    assert_eq!(fx.err("mobile.premium.verify", json!({ "platform": "apple" })).code(), "INVALID");
    assert_eq!(fx.err("mobile.premium.verify", json!({ "platform": "google", "token": "t" })).code(), "INVALID");
    assert_eq!(fx.err("mobile.premium.verify", json!({ "platform": "web", "jws": "x" })).code(), "INVALID");
}

#[test]
fn install_limit_is_its_own_code_and_keeps_the_receipt() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(APPLE, store_ok(now + HOUR, "apple"));
    fx.verify_apple().unwrap();
    assert!(fx.premium());
    let stored = fx.secret("premium.receipt").expect("receipt kept");
    let events = fx.premium_events().len();

    // A Restore the server will not add to a purchase already on five installs.
    stub().route(APPLE, Answer::Json(409, json!({ "error": "install_limit" })));
    let e = fx.err("mobile.premium.verify", json!({ "platform": "apple", "jws": "jws-other-purchase", "restore": true }));
    assert_eq!(e.code(), "INSTALL_LIMIT");
    assert!(!e.to_string().contains("install_limit"), "fixed text, never the server's: {e}");
    assert!(fx.premium(), "not a refusal: Premium stays");
    assert_eq!(fx.secret("premium.receipt").as_deref(), Some(stored.as_str()), "the stored receipt is untouched");
    assert_eq!(fx.premium_events().len(), events, "nothing changed");

    // Google the same way.
    stub().route(GOOGLE, Answer::Json(409, json!({ "error": "install_limit" })));
    let e = fx.err(
        "mobile.premium.verify",
        json!({ "platform": "google", "token": PLAY_TOKEN, "productId": "com.mailvault.app.premium.yearly", "restore": true }),
    );
    assert_eq!(e.code(), "INSTALL_LIMIT");
    assert_eq!(fx.secret("premium.receipt").as_deref(), Some(stored.as_str()));

    // Any other 409 stays a refusal.
    stub().route(APPLE, Answer::Json(409, json!({ "error": "conflict" })));
    assert_eq!(fx.verify_apple().unwrap_err().code(), "REFUSED");
    assert!(!fx.premium());
}

#[test]
fn network_error_keeps_cached_premium_until_expiry() {
    let (_g, fx) = setup();
    let now = now_ms();
    let expires = now + 24 * HOUR;
    stub().route(APPLE, store_ok(expires, "apple"));
    fx.verify_apple().unwrap();

    stub().route(APPLE, Answer::Drop);
    assert_eq!(fx.err("mobile.premium.refresh", json!({ "force": true })).code(), "NETWORK");
    assert!(fx.premium(), "a failed check keeps the cached answer");
    stub().route(APPLE, Answer::Json(502, json!({})));
    assert_eq!(fx.err("mobile.premium.refresh", json!({ "force": true })).code(), "NETWORK");
    assert!(fx.premium());

    // Ruling 3: a fresh answer is not re-checked on every foreground.
    let before = stub().requests(APPLE).len();
    assert_eq!(fx.rpc("mobile.premium.refresh", json!({}))["premium"], true);
    assert_eq!(stub().requests(APPLE).len(), before, "checked minutes ago: no network");
    fx.clock(now + 13 * HOUR);
    assert_eq!(fx.err("mobile.premium.refresh", json!({})).code(), "NETWORK");
    assert_eq!(stub().requests(APPLE).len(), before + 1, "13 h after the last check: checked again");
    assert!(fx.premium(), "still the cached answer");

    // Until expiry, then not entitled.
    fx.clock(expires - 1000);
    assert!(fx.premium());
    fx.clock(expires + 1000);
    assert!(!fx.premium());
}

#[test]
fn web_sign_in_needs_the_code_and_stores_customer_only_in_secrets() {
    let (_g, mut fx) = setup();
    let now = now_ms();
    stub().route(SIGNIN_START, Answer::Json(200, json!({ "ok": true })));
    assert_eq!(fx.rpc("mobile.premium.webSignIn.start", json!({ "email": EMAIL })), json!({ "ok": true }));
    let started = stub().requests(SIGNIN_START);
    assert_eq!(serde_json::from_str::<Value>(&started[0].body).unwrap(), json!({ "email": EMAIL }));
    // The page's language rides along, so the mail reads in it; a malformed tag is dropped.
    assert_eq!(fx.rpc("mobile.premium.webSignIn.start", json!({ "email": EMAIL, "lang": "pt-BR" })), json!({ "ok": true }));
    assert_eq!(fx.rpc("mobile.premium.webSignIn.start", json!({ "email": EMAIL, "lang": "x y;z" })), json!({ "ok": true }));
    let started = stub().requests(SIGNIN_START);
    assert_eq!(serde_json::from_str::<Value>(&started[1].body).unwrap(), json!({ "email": EMAIL, "lang": "pt-BR" }));
    assert_eq!(serde_json::from_str::<Value>(&started[2].body).unwrap(), json!({ "email": EMAIL }));
    stub().route(SIGNIN_START, Answer::Json(429, json!({ "error": "rate_limited" })));
    assert_eq!(fx.err("mobile.premium.webSignIn.start", json!({ "email": EMAIL })).code(), "RATE_LIMITED");
    assert_eq!(fx.err("mobile.premium.webSignIn.start", json!({ "email": "" })).code(), "INVALID");

    stub().route(STATUS, web_status(true, true, now + 30 * 24 * HOUR, None));
    for (answer, code) in [
        (json!({ "error": "code_wrong" }), "CODE_WRONG"),
        (json!({ "error": "code_expired" }), "CODE_EXPIRED"),
        (json!({ "error": "rate_limited" }), "RATE_LIMITED"),
    ] {
        stub().route(SIGNIN_VERIFY, Answer::Json(400, answer));
        assert_eq!(fx.sign_in().unwrap_err().code(), code);
        assert_eq!(fx.secret("premium.customer"), None, "no customer before a right code");
        assert!(!fx.premium());
    }
    assert!(stub().requests(STATUS).is_empty(), "no status call without a verified code");

    stub().route(SIGNIN_VERIFY, Answer::Json(200, json!({ "customerId": CUSTOMER })));
    let reply = fx.sign_in().unwrap();
    assert_eq!(reply["premium"], true, "{reply}");
    assert_eq!(reply["source"], "web");
    assert!(reply.get("replacedClient").is_none(), "{reply}");
    assert_eq!(serde_json::from_str::<Value>(&stub().requests(SIGNIN_VERIFY).last().unwrap().body).unwrap(), json!({ "email": EMAIL, "code": CODE }));
    assert_eq!(fx.secret("premium.customer").as_deref(), Some(CUSTOMER));
    let install = fx.secret("premium.installId").unwrap();

    let status = stub().requests(STATUS);
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].method, "GET");
    let q = &status[0].query;
    assert!(q.contains(&format!("customerId={CUSTOMER}")), "{q}");
    assert!(q.contains(&format!("clientId={install}")), "{q}");
    assert!(q.contains("register=1"), "{q}");
    assert!(q.contains("platform="), "{q}");
    assert!(!q.contains("email"), "status never goes by email: {q}");

    // The customer id is in the secret store and nowhere in mobile.db.
    drop(fx.engine.take());
    let mut files = Vec::new();
    files_under(fx.tmp.path(), &mut files);
    for f in files {
        let bytes = std::fs::read(&f).unwrap();
        assert!(!contains_bytes(&bytes, CUSTOMER), "{} holds the customer id", f.display());
        assert!(!contains_bytes(&bytes, &install), "{} holds the install id", f.display());
    }
}

#[test]
fn web_sign_in_reports_the_replaced_device() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(SIGNIN_VERIFY, Answer::Json(200, json!({ "customerId": CUSTOMER })));
    let replaced = json!({ "clientId": "old-phone-install-id", "clientName": "Old iPhone", "platform": "ios", "lastSeenAt": iso(now - 24 * HOUR) });
    stub().route(STATUS, web_status(true, true, now + 30 * 24 * HOUR, Some(replaced)));
    let reply = fx.sign_in().unwrap();
    assert_eq!(reply["premium"], true);
    assert_eq!(reply["replacedClient"], json!({ "clientName": "Old iPhone", "platform": "ios", "lastSeenMs": now - 24 * HOUR }));
    assert!(!reply.to_string().contains("old-phone-install-id"), "another device's id stays out of the reply: {reply}");
    assert!(!fx.logs.lock().unwrap().iter().any(|l| l.contains("old-phone-install-id")));
}

#[test]
fn a_replaced_phone_is_not_entitled() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(SIGNIN_VERIFY, Answer::Json(200, json!({ "customerId": CUSTOMER })));
    stub().route(STATUS, web_status(true, true, now + 30 * 24 * HOUR, None));
    fx.sign_in().unwrap();
    assert!(fx.premium());

    // Another device signed in and took this phone's place.
    stub().route(STATUS, web_status(false, true, now + 30 * 24 * HOUR, None));
    assert_eq!(fx.err("mobile.premium.refresh", json!({ "force": true })).code(), "DEVICE_REPLACED");
    assert!(!fx.premium());
    assert_eq!(fx.premium_events().last().unwrap()["premium"], false);

    // A lapsed web subscription is plain not entitled.
    stub().route(STATUS, web_status(false, false, now - HOUR, None));
    assert_eq!(fx.rpc("mobile.premium.refresh", json!({ "force": true }))["premium"], false);

    // Signing out forgets the customer.
    stub().route(STATUS, web_status(true, true, now + 30 * 24 * HOUR, None));
    fx.rpc("mobile.premium.refresh", json!({ "force": true }));
    assert!(fx.premium());
    assert_eq!(fx.rpc("mobile.premium.webSignOut", json!({}))["premium"], false);
    assert_eq!(fx.secret("premium.customer"), None);
    let calls = stub().requests(STATUS).len();
    fx.rpc("mobile.premium.refresh", json!({ "force": true }));
    assert_eq!(stub().requests(STATUS).len(), calls, "signed out: no web check");
}

#[test]
fn refresh_never_reregisters_a_replaced_phone() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(SIGNIN_VERIFY, Answer::Json(200, json!({ "customerId": CUSTOMER })));
    // The status call right after the code fails: sign-in is not done yet.
    stub().route(STATUS, Answer::Drop);
    assert_eq!(fx.sign_in().unwrap_err().code(), "NETWORK");
    assert!(!fx.premium());

    // The next check is still the first status answer after the code, so it registers.
    stub().route(STATUS, web_status(true, true, now + 30 * 24 * HOUR, None));
    assert_eq!(fx.rpc("mobile.premium.refresh", json!({}))["premium"], true);
    let status = stub().requests(STATUS);
    assert_eq!(status.len(), 2);
    assert!(status.iter().all(|r| r.query.contains("register=1")), "{status:?}");

    // From then on, never again: a replaced phone must not take its slot back.
    stub().route(STATUS, web_status(false, true, now + 30 * 24 * HOUR, None));
    for _ in 0..3 {
        assert_eq!(fx.err("mobile.premium.refresh", json!({ "force": true })).code(), "DEVICE_REPLACED");
    }
    let status = stub().requests(STATUS);
    assert_eq!(status.len(), 5);
    for r in &status[2..] {
        assert!(!r.query.contains("register"), "a refresh re-registered: {}", r.query);
    }
    assert!(stub().all_requests().iter().all(|r| !r.query.contains("email")));
    assert!(!fx.premium());
}

#[test]
fn no_secret_in_db_logs_or_replies() {
    let (_g, mut fx) = setup();
    let now = now_ms();
    let mut replies: Vec<String> = Vec::new();
    let mut call = |fx: &Fx, method: &str, params: Value| {
        let r = fx.e().rpc(method, params);
        replies.push(match &r {
            Ok(v) => v.to_string(),
            Err(e) => format!("{} {}", serde_json::to_string(e).unwrap(), e),
        });
    };

    stub().route(SIGNIN_START, Answer::Json(200, json!({ "ok": true })));
    stub().route(SIGNIN_VERIFY, Answer::Json(200, json!({ "customerId": CUSTOMER })));
    stub().route(STATUS, web_status(true, true, now + 30 * 24 * HOUR, None));
    stub().route(APPLE, store_ok(now + HOUR, "apple"));
    stub().route(GOOGLE, Answer::Json(400, json!({ "error": format!("bad token {PLAY_TOKEN}") })));
    call(&fx, "mobile.premium.webSignIn.start", json!({ "email": EMAIL }));
    call(&fx, "mobile.premium.webSignIn.verify", json!({ "email": EMAIL, "code": CODE }));
    call(&fx, "mobile.premium.verify", json!({ "platform": "apple", "jws": JWS }));
    call(&fx, "mobile.premium.verify", json!({ "platform": "google", "token": PLAY_TOKEN, "productId": "p" }));
    call(&fx, "mobile.premium.refresh", json!({ "force": true }));
    call(&fx, "mobile.premium.status", json!({}));
    stub().route(STATUS, Answer::Drop);
    stub().route(APPLE, Answer::Drop);
    call(&fx, "mobile.premium.refresh", json!({ "force": true }));
    stub().route(STATUS, web_status(false, true, now + 30 * 24 * HOUR, None));
    call(&fx, "mobile.premium.refresh", json!({ "force": true }));
    call(&fx, "mobile.settings.get", json!({}));
    fx.reopen();
    call(&fx, "mobile.premium.status", json!({}));
    call(&fx, "mobile.premium.webSignOut", json!({}));

    let install = fx.secret("premium.installId").expect("install id");
    let secrets = [CUSTOMER, install.as_str(), JWS, PLAY_TOKEN, CODE];
    for r in &replies {
        for s in secrets {
            assert!(!r.contains(s), "reply carries a secret: {r}");
        }
    }
    for (name, payload) in fx.events.lock().unwrap().iter() {
        for s in secrets {
            assert!(!payload.to_string().contains(s), "{name} carries a secret: {payload}");
        }
    }
    for line in fx.logs.lock().unwrap().iter() {
        for s in secrets {
            assert!(!line.contains(s), "log line carries a secret: {line}");
        }
    }
    let settings: Vec<(String, String)> = {
        let c = rusqlite::Connection::open(fx.tmp.path().join("mobile.db")).unwrap();
        let mut st = c.prepare("SELECT key, COALESCE(value, '') FROM settings").unwrap();
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        rows
    };
    assert!(settings.iter().any(|(k, _)| k == "premium.state"), "{settings:?}");
    for (k, v) in &settings {
        for s in secrets {
            assert!(!v.contains(s), "setting {k} holds a secret");
        }
    }
    drop(fx.engine.take());
    let mut files = Vec::new();
    files_under(fx.tmp.path(), &mut files);
    for f in files {
        let bytes = std::fs::read(&f).unwrap();
        for s in secrets {
            assert!(!contains_bytes(&bytes, s), "{} holds a secret", f.display());
        }
    }
}

#[test]
fn another_receipt_saying_no_never_ends_the_live_one() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(APPLE, store_ok(now + 30 * 24 * HOUR, "apple"));
    fx.verify_apple().unwrap();
    assert!(fx.premium());
    let stored = fx.secret("premium.receipt").expect("receipt kept");

    // The native listener hands over an older, expired transaction of the same store. The stored
    // receipt is checked again and still entitled: Premium and the stored receipt stay.
    let old = "jws-old-expired-transaction";
    stub().route(
        APPLE,
        Answer::ByBody(
            vec![(old, Answer::Json(200, json!({ "entitled": false, "source": "apple", "expiresMs": now - HOUR })))],
            Box::new(store_ok(now + 30 * 24 * HOUR, "apple")),
        ),
    );
    let before = stub().requests(APPLE).len();
    let reply = fx.rpc("mobile.premium.verify", json!({ "platform": "apple", "jws": old }));
    assert_eq!(reply["premium"], true, "{reply}");
    assert!(fx.premium());
    assert_eq!(fx.secret("premium.receipt").as_deref(), Some(stored.as_str()), "the stored receipt is not replaced");
    let asked = stub().requests(APPLE);
    assert_eq!(asked.len(), before + 2, "the stored receipt was checked again");
    assert!(asked[before + 1].body.contains(JWS), "{:?}", asked[before + 1]);
    assert!(!fx.premium_events().iter().any(|e| e["premium"] == false), "Premium never went off");

    // A revoked other transaction is refused, but the live one still decides.
    stub().route(
        APPLE,
        Answer::ByBody(
            vec![(old, Answer::Json(403, json!({ "error": "revoked" })))],
            Box::new(store_ok(now + 30 * 24 * HOUR, "apple")),
        ),
    );
    assert_eq!(fx.err("mobile.premium.verify", json!({ "platform": "apple", "jws": old })).code(), "REFUSED");
    assert!(fx.premium());
    assert_eq!(fx.secret("premium.receipt").as_deref(), Some(stored.as_str()));

    // When the stored receipt itself now says no, Premium ends (and it is kept for re-checks).
    stub().route(APPLE, Answer::Json(200, json!({ "entitled": false, "source": "apple", "expiresMs": now - HOUR })));
    assert_eq!(fx.rpc("mobile.premium.verify", json!({ "platform": "apple", "jws": old }))["premium"], false);
    assert!(!fx.premium());
    assert_eq!(fx.secret("premium.receipt").as_deref(), Some(stored.as_str()));

    // An entitled new receipt replaces the stored one.
    let new = "jws-new-yearly-transaction";
    stub().route(APPLE, store_ok(now + 365 * 24 * HOUR, "apple"));
    assert_eq!(fx.rpc("mobile.premium.verify", json!({ "platform": "apple", "jws": new }))["premium"], true);
    assert!(fx.secret("premium.receipt").unwrap().contains(new));
}

#[test]
fn install_id_does_not_wait_for_a_network_check() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(APPLE, store_ok(now + HOUR, "apple"));
    fx.verify_apple().unwrap();
    let id = fx.rpc("mobile.premium.installId", json!({}))["installId"].as_str().unwrap().to_string();

    // A refresh is stuck on the server; the purchase sheet asks for the install id meanwhile.
    let gate = Arc::new(Gate::default());
    stub().route(APPLE, Answer::Gated(Arc::clone(&gate), Box::new(store_ok(now + HOUR, "apple"))));
    let before = stub().requests(APPLE).len();
    let e = fx.e();
    std::thread::scope(|s| {
        let refresh = s.spawn(|| e.rpc("mobile.premium.refresh", json!({ "force": true })));
        while stub().requests(APPLE).len() == before {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        s.spawn(move || {
            let _ = tx.send(e.rpc("mobile.premium.installId", json!({})));
        });
        let got = rx.recv_timeout(std::time::Duration::from_secs(10));
        // Open the gate whatever happened, so the threads end.
        gate.release();
        let got = got.expect("installId waited for the network check").unwrap();
        assert_eq!(got["installId"], id.as_str());
        refresh.join().unwrap().unwrap();
    });
    // Made once: the same id after the check.
    assert_eq!(fx.rpc("mobile.premium.installId", json!({}))["installId"], id.as_str());
}

#[test]
fn a_refresh_that_meets_the_install_limit_keeps_receipt_and_cache() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(APPLE, store_ok(now + 24 * HOUR, "apple"));
    fx.verify_apple().unwrap();
    let stored = fx.secret("premium.receipt").unwrap();
    // An install idle for a month whose purchase's live set filled up meanwhile.
    stub().route(APPLE, Answer::Json(409, json!({ "error": "install_limit" })));
    assert_eq!(fx.err("mobile.premium.refresh", json!({ "force": true })).code(), "INSTALL_LIMIT");
    assert!(fx.premium(), "the cache stays until its expiry");
    assert_eq!(fx.secret("premium.receipt").as_deref(), Some(stored.as_str()));
}

#[test]
fn a_sign_in_the_server_refuses_without_a_reason_is_not_a_wrong_code() {
    let (_g, fx) = setup();
    stub().route(SIGNIN_VERIFY, Answer::Json(400, json!({ "error": "invalid_request" })));
    assert_eq!(fx.sign_in().unwrap_err().code(), "INVALID");
    stub().route(SIGNIN_VERIFY, Answer::Json(400, json!({})));
    assert_eq!(fx.sign_in().unwrap_err().code(), "INVALID");
    stub().route(SIGNIN_VERIFY, Answer::Json(401, json!({ "error": "code_wrong" })));
    assert_eq!(fx.sign_in().unwrap_err().code(), "CODE_WRONG");
    assert_eq!(fx.secret("premium.customer"), None);
}

#[test]
fn a_registration_finished_by_refresh_names_the_phone_as_the_sign_in_did() {
    let (_g, fx) = setup();
    let now = now_ms();
    stub().route(SIGNIN_VERIFY, Answer::Json(200, json!({ "customerId": CUSTOMER })));
    stub().route(STATUS, Answer::Drop);
    let params = json!({ "email": EMAIL, "code": CODE, "clientName": "Rita's phone", "appVersion": "2.23.0", "osVersion": "18.1" });
    assert_eq!(fx.err("mobile.premium.webSignIn.verify", params).code(), "NETWORK");
    stub().route(STATUS, web_status(true, true, now + 30 * 24 * HOUR, None));
    assert_eq!(fx.rpc("mobile.premium.refresh", json!({}))["premium"], true);
    let status = stub().requests(STATUS);
    let last = &status.last().unwrap().query;
    assert!(last.contains("register=1"), "{last}");
    for part in ["appVersion=2.23.0", "osVersion=18.1", "clientName=Rita%27s+phone"] {
        assert!(last.contains(part), "{part} missing from {last}");
    }
}
