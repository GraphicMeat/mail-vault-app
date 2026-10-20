//! The token-refresh hand-test checklist
//! (`docs/plans/2026-10-20-token-refresh-hand-tests.md`), run against mock
//! servers instead of real Google and Microsoft accounts.
//!
//! A mock token endpoint (`mock_imap::oauth::MockOAuth`) answers the daemon's
//! refreshes for this test's daemon only (`OAuth2Manager::
//! set_token_endpoint_for_tests`, debug builds only), and the mock IMAP and
//! SMTP servers accept a sign-in only with a token it issued that has not
//! expired. Time moves by `advance` on both clocks, never by sleeping and
//! never on the system clock.
//!
//! What this cannot prove: the consent screen, Google's and Microsoft's real
//! revoke pages, the real client ids and scopes those providers accept, how
//! Microsoft really rotates refresh tokens, and the macOS keychain prompts.

use crate::events::captured_logs;
use crate::ipc::RpcResponse;
use crate::server::{handle_request_for_test, DaemonState};
use mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID;
use mock_imap::oauth::{GrantSpec, MockOAuth, SignIn, TokenAuthority};
use mock_imap::state::{synthetic_mailbox, Message};
use mock_imap::{MockImap, Scenario};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// The scope the daemon refreshes a Gmail grant with.
const GOOGLE_SCOPE: &str = "https://mail.google.com/";
/// The scopes it refreshes an Outlook account on IMAP with, and on Graph.
const MS_IMAP_SCOPE: &str = "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send";
const GRAPH_SCOPE: &str = "offline_access Mail.ReadWrite Mail.Send";
const HOUR: Duration = Duration::from_secs(3600);

struct Rig {
    s: Arc<DaemonState>,
    auth: TokenAuthority,
    _oauth: MockOAuth,
    imap: MockImap,
    creds: PathBuf,
    rx: tokio::sync::broadcast::Receiver<Arc<str>>,
    /// Every RPC answer and event payload seen, for the leak scan. The answer
    /// to `oauth2.take_refreshed` is left out: handing the pair to the app is
    /// what it is for.
    seen: Vec<String>,
    /// Every event seen, oldest first.
    all_events: Vec<(String, Value)>,
    _env: std::sync::MutexGuard<'static, ()>,
}

impl Rig {
    fn new(scenario: Scenario) -> Rig {
        let env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        let dir = std::env::temp_dir().join(format!("mv-oauth-mock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let auth = TokenAuthority::new();
        let oauth = MockOAuth::start(auth.clone());
        s.oauth2.set_token_endpoint_for_tests(Some(oauth.origin()));
        let imap = MockImap::start_checked(scenario, Arc::new(auth.clone()));
        let creds = dir.join("credentials.json");
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        let rx = s.events.subscribe();
        Rig { s, auth, _oauth: oauth, imap, creds, rx, seen: Vec::new(), all_events: Vec::new(), _env: env }
    }

    fn sign_in(&self, scope: &str, rotate: bool) -> SignIn {
        let client_id = if scope == GOOGLE_SCOPE { GOOGLE_THUNDERBIRD_CLIENT_ID.to_string() } else { String::new() };
        self.auth.sign_in(GrantSpec { client_id, scope: scope.to_string(), expires_in: 3600, rotate })
    }

    /// The stored record of a signed-in OAuth2 account on the mock servers.
    fn record(&self, id: &str, email: &str, signed: &SignIn, extra: Value) -> Value {
        let mut r = json!({
            "id": id, "email": email,
            "imapHost": self.imap.host(), "imapPort": self.imap.port(), "imapSecure": true,
            "smtpHost": self.imap.host(), "smtpPort": self.imap.smtp_port(), "smtpSecure": false,
            "authType": "oauth2", "oauth2Provider": "google", "oauth2ClientId": GOOGLE_THUNDERBIRD_CLIENT_ID,
            "oauth2AccessToken": signed.access_token, "oauth2RefreshToken": signed.refresh_token,
            "oauth2ExpiresAt": signed.expires_at,
        });
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            r[k] = v;
        }
        r
    }

    fn store(&self, records: &[&Value]) {
        let blob: std::collections::HashMap<String, String> =
            records.iter().map(|r| (r["id"].as_str().unwrap().to_string(), r.to_string())).collect();
        std::fs::write(&self.creds, serde_json::to_string(&blob).unwrap()).unwrap();
    }

    /// The account object the app sends: the store's copy, its token stale.
    fn param(record: &Value) -> Value {
        let mut p = record.clone();
        p["oauth2AccessToken"] = json!("app-held-stale-token");
        p.as_object_mut().unwrap().remove("oauth2RefreshToken");
        p
    }

    /// Both clocks, the daemon's and the provider's.
    fn advance(&self, by: Duration) {
        self.s.tokens.advance_clock_for_tests(by);
        self.auth.advance(by);
    }

    async fn rpc(&mut self, method: &str, params: Value) -> RpcResponse {
        let r = handle_request_for_test(&self.s, method, params).await;
        if method != "oauth2.take_refreshed" {
            self.seen.push(serde_json::to_string(&r).unwrap_or_default());
        }
        r
    }

    fn events(&mut self) -> Vec<(String, Value)> {
        let events: Vec<(String, Value)> = std::iter::from_fn(|| self.rx.try_recv().ok())
            .filter_map(|line| mailvault_core::daemon_ipc::parse_event(&line))
            .collect();
        self.seen.extend(events.iter().map(|(n, p)| format!("{n} {p}")));
        self.all_events.extend(events.iter().cloned());
        events
    }

    /// Every issued token found in the daemon's log lines, its events and its
    /// RPC answers since the rig started. Must stay empty.
    fn leaks(&mut self) -> Vec<String> {
        let _ = self.events();
        let logged = String::from_utf8_lossy(&captured_logs().lock().unwrap_or_else(|p| p.into_inner())).to_string();
        let mut found = Vec::new();
        for token in self.auth.issued() {
            if logged.contains(&token) || self.seen.iter().any(|t| t.contains(&token)) {
                found.push(format!("{}...", &token[..token.len().min(12)]));
            }
        }
        found
    }

    fn posts(&self) -> usize {
        self.auth.posts().len()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        std::env::remove_var("MAILVAULT_TEST_CREDENTIALS");
    }
}

fn ok(r: &RpcResponse) -> bool {
    r.error.is_none()
}

fn message(r: &RpcResponse) -> String {
    r.error.as_ref().map(|e| e.message.clone()).unwrap_or_default()
}

/// A take of the pairs the daemon refreshed, saved as the app's
/// `oauthTokenSync` saves them (`updateOAuth2Tokens`: three fields over the
/// stored record), then `oauth2.credentials_changed`.
async fn app_saves_what_the_daemon_refreshed(rig: &mut Rig, records: &mut [Value]) -> usize {
    let taken = rig.rpc("oauth2.take_refreshed", json!({})).await.result.unwrap();
    let pairs = taken["tokens"].as_array().cloned().unwrap_or_default();
    for pair in &pairs {
        if let Some(r) = records.iter_mut().find(|r| r["id"] == pair["accountId"]) {
            r["oauth2AccessToken"] = pair["accessToken"].clone();
            r["oauth2RefreshToken"] = pair["refreshToken"].clone();
            r["oauth2ExpiresAt"] = pair["expiresAt"].clone();
        }
    }
    rig.store(&records.iter().collect::<Vec<_>>());
    assert!(ok(&rig.rpc("oauth2.credentials_changed", json!({})).await));
    crate::oauth_tokens::recheck_unsaved(&rig.s).await;
    pairs.len()
}

fn inbox() -> Scenario {
    Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)).mailbox(synthetic_mailbox("Sent", 0))
}

async fn wait_until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The next terminal `backup-progress` frame.
async fn backup_finished(rig: &mut Rig) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        for (name, payload) in rig.events() {
            if name == "backup-progress" && payload["active"] == json!(false) {
                return payload;
            }
        }
        assert!(std::time::Instant::now() < deadline, "the backup never finished");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

// ── 1. expiry, then use ─────────────────────────────────────────────────────

/// Checklist 1: the token expired an hour ago. Loading INBOX, sending and a
/// backup run each need it: exactly one refresh, announced with the account
/// id only; the app takes and saves the pair; no token in any output.
#[tokio::test]
async fn checklist_1_an_expired_token_is_refreshed_once_for_inbox_send_and_backup() {
    let mut rig = Rig::new(inbox());
    let signed = rig.sign_in(GOOGLE_SCOPE, false);
    let mut records = vec![rig.record("g1", "me@gmail.test", &signed, json!({}))];
    rig.store(&[&records[0]]);
    rig.advance(HOUR + Duration::from_secs(60));
    let account = Rig::param(&records[0]);

    let inbox = rig.rpc("imap_get_emails", json!({"account": account, "mailbox": "INBOX"})).await;
    let sent = rig.rpc("smtp_send_email", json!({"account": account, "email": {"to": "you@x.test", "subject": "s", "text": "t"}})).await;
    let backup = rig.rpc("backup_run_account", json!({"accountId": "g1", "accountJson": account.to_string()})).await;
    let finished = backup_finished(&mut rig).await;

    assert!(ok(&inbox), "{}", message(&inbox));
    assert!(ok(&sent), "{}", message(&sent));
    assert!(ok(&backup), "{}", message(&backup));
    assert_eq!(finished["completed_emails"], json!(3), "{finished}");
    let posts = rig.auth.posts();
    assert_eq!(posts.len(), 1, "one refresh for three uses");
    assert_eq!(posts[0].refresh_token, signed.refresh_token);
    assert_eq!(posts[0].client_id, GOOGLE_THUNDERBIRD_CLIENT_ID);
    assert_eq!(posts[0].scope, GOOGLE_SCOPE);
    assert!(rig.auth.auth_log().iter().all(|a| a.accepted), "the app's stale token never reached a server");
    let _ = rig.events();
    let announced: Vec<Value> =
        rig.all_events.iter().filter(|(n, _)| n == "oauth2-tokens-refreshed").map(|(_, p)| p.clone()).collect();
    assert_eq!(announced, vec![json!({"accountId": "g1"})]);

    assert_eq!(app_saves_what_the_daemon_refreshed(&mut rig, &mut records).await, 1);
    assert!(rig.s.tokens.unsaved().is_empty(), "saved, no longer offered");
    assert_ne!(records[0]["oauth2AccessToken"], json!(signed.access_token));
    assert_eq!(rig.leaks(), Vec::<String>::new());
}

// ── 2. a revoked grant ──────────────────────────────────────────────────────

/// Checklist 2: the user revoked the app. The next request already fails as
/// a refused sign-in (the app's "sign in again" state), the token endpoint
/// is asked at most once however often the app asks again, and a new sign-in
/// works at once with nothing restarted.
#[tokio::test]
async fn checklist_2_a_revoked_grant_asks_for_a_sign_in_once_and_a_new_one_works_at_once() {
    let mut rig = Rig::new(inbox());
    let signed = rig.sign_in(GOOGLE_SCOPE, false);
    let record = rig.record("g1", "me@gmail.test", &signed, json!({}));
    rig.store(&[&record]);
    let account = Rig::param(&record);
    assert!(ok(&rig.rpc("imap_get_mailboxes", json!({"account": account})).await));

    rig.auth.revoke(&signed.refresh_token);
    // Gmail keeps a session that is already signed in: the revoke shows on
    // the next new connection. The pool's sessions end (an idle timeout, a
    // network change) and the app asks again.
    rig.s.imap_pool.shutdown().await;
    let first = rig.rpc("imap_get_mailboxes", json!({"account": account})).await;
    assert!(message(&first).contains("XOAUTH2 auth failed"), "the sign-in-again state at once: {}", message(&first));
    for _ in 0..50 {
        let again = rig.rpc("imap_get_mailboxes", json!({"account": account})).await;
        assert!(!ok(&again));
    }
    assert!(rig.posts() <= 1, "{} token requests in one cooldown", rig.posts());

    let reconnect = rig.sign_in(GOOGLE_SCOPE, false);
    let record = rig.record("g1", "me@gmail.test", &reconnect, json!({}));
    rig.store(&[&record]);
    assert!(ok(&rig.rpc("oauth2.credentials_changed", json!({})).await));
    let after = rig.rpc("imap_get_mailboxes", json!({"account": Rig::param(&record)})).await;
    assert!(ok(&after), "{}", message(&after));
    assert_eq!(rig.leaks(), Vec::<String>::new());
}

// ── 3. the daemon outlives the token with the app closed ────────────────────

/// Checklist 3: the app is closed; the IDLE watcher lives on past the token's
/// expiry and renews it itself when mail arrives. The relaunched app takes
/// the pair, and nothing refreshes a second time.
#[tokio::test]
async fn checklist_3_the_idle_watcher_renews_the_token_and_the_relaunched_app_takes_the_pair() {
    let mut rig = Rig::new(inbox());
    let signed = rig.sign_in(GOOGLE_SCOPE, false);
    let mut records = vec![rig.record("g1", "me@gmail.test", &signed, json!({}))];
    rig.store(&[&records[0]]);
    let mut config = Rig::param(&records[0]);
    config.as_object_mut().unwrap().remove("oauth2AccessToken");
    let watch = rig.rpc("sync.watch", json!({"account": {"id": "g1", "email": "me@gmail.test", "imapConfig": config}})).await;
    assert!(ok(&watch), "{}", message(&watch));
    wait_until("the first IDLE", 10, || rig.imap.count_commands("IDLE") >= 1).await;
    assert_eq!(rig.posts(), 0);

    // The app is closed. Overnight, mail arrives after the token expired.
    rig.advance(HOUR + Duration::from_secs(60));
    rig.imap.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        let uid = mb.uid_next;
        mb.add(Message::new(uid, "Subject: overnight\r\n\r\nx"));
    });
    let auth = rig.auth.clone();
    wait_until("the watcher to renew and sign in again", 20, || {
        auth.posts().len() == 1 && auth.auth_log().iter().filter(|a| a.accepted).count() >= 2
    })
    .await;
    wait_until("IDLE again", 10, || rig.imap.count_commands("IDLE") >= 2).await;

    // The app opens: it takes the pair, and using the account refreshes nothing.
    assert_eq!(app_saves_what_the_daemon_refreshed(&mut rig, &mut records).await, 1);
    assert!(ok(&rig.rpc("imap_get_mailboxes", json!({"account": Rig::param(&records[0])})).await));
    assert_eq!(rig.posts(), 1, "no second refresh after the app saved the pair");
    let _ = rig.rpc("sync.unwatch", json!({"accountId": "g1"})).await;
    assert_eq!(rig.leaks(), Vec::<String>::new());
}

// ── 4. Microsoft rotation, then a reconnect ─────────────────────────────────

/// Checklist 4 (review finding 1): right after the daemon refreshed (and
/// Microsoft rotated the refresh token), the user reconnects, moving the
/// account from IMAP to Graph; the new token expires before the held one.
/// The old grant's pair is never offered for saving over the new sign-in, and
/// 90 minutes later the refresh posts the new grant's refresh token with
/// Graph's scopes, and succeeds.
#[tokio::test]
async fn checklist_4_a_reconnect_right_after_a_rotating_refresh_keeps_the_new_grant() {
    let mut rig = Rig::new(inbox());
    let imap_grant = rig.sign_in(MS_IMAP_SCOPE, true);
    let outlook = json!({"oauth2Provider": "microsoft", "oauth2ClientId": null});
    let record = rig.record("o1", "me@outlook.test", &imap_grant, outlook.clone());
    rig.store(&[&record]);
    rig.advance(HOUR + Duration::from_secs(60));
    assert!(ok(&rig.rpc("imap_get_mailboxes", json!({"account": Rig::param(&record)})).await));
    assert_eq!(rig.s.tokens.unsaved().len(), 1, "the rotated pair, not saved yet");

    // Reconnect: a new sign-in, Graph this time, expiring in 30 minutes.
    let graph_grant = rig.auth.sign_in(GrantSpec { client_id: String::new(), scope: GRAPH_SCOPE.into(), expires_in: 1800, rotate: true });
    let mut moved = outlook;
    moved["oauth2Transport"] = json!("graph");
    let reconnected = rig.record("o1", "me@outlook.test", &graph_grant, moved);
    rig.store(&[&reconnected]);
    assert!(ok(&rig.rpc("oauth2.credentials_changed", json!({})).await));
    crate::oauth_tokens::recheck_unsaved(&rig.s).await;
    let offered = rig.rpc("oauth2.take_refreshed", json!({})).await.result.unwrap();
    assert_eq!(offered["tokens"], json!([]), "the old grant's pair is not offered over the new sign-in");

    rig.advance(Duration::from_secs(90 * 60));
    let token = crate::oauth_tokens::access_token(&rig.s, "o1", crate::oauth_tokens::Read::Quiet).await;
    let posts = rig.auth.posts();
    let last = posts.last().unwrap();
    assert_eq!(last.refresh_token, graph_grant.refresh_token, "the new grant's refresh token");
    assert_eq!(last.scope, GRAPH_SCOPE);
    assert_eq!(last.status, 200);
    assert!(rig.auth.is_valid(&token.ok().flatten().unwrap()));
    assert_eq!(rig.leaks(), Vec::<String>::new());
}

// ── 5. the keychain cannot be read ──────────────────────────────────────────

/// Checklist 5 (review finding 3): the credentials store cannot be read (the
/// file bypass stands in for a locked keychain: present, unreadable) and the
/// daemon holds no token: a Graph call says so with its code, never
/// "Missing accessToken". An account the store does not hold says sign in.
#[tokio::test]
async fn checklist_5_an_unreadable_store_answers_the_keychain_code_never_missing_access_token() {
    let mut rig = Rig::new(inbox());
    std::fs::write(&rig.creds, "{ not json").unwrap();
    let call = json!({"accountId": "o1", "accountEmail": "me@outlook.test"});
    let unreadable = rig.rpc("graph_list_folders", call.clone()).await;
    rig.store(&[]);
    let missing = rig.rpc("graph_list_folders", call).await;

    assert!(message(&unreadable).starts_with("E_OAUTH_KEYCHAIN_UNAVAILABLE:"), "{}", message(&unreadable));
    assert!(message(&missing).starts_with("E_OAUTH_SIGN_IN_NEEDED:"), "{}", message(&missing));
    for r in [&unreadable, &missing] {
        assert!(!message(r).contains("Missing accessToken"));
    }
}

// ── 7. a server that refuses a valid token ──────────────────────────────────

/// Checklist 7 (review finding 2): the server refuses even a valid token (IMAP
/// off for the account). 200 polling requests cost one token request in the
/// first minute, and the backoff allows one more only after it.
#[tokio::test]
async fn checklist_7_a_server_refusing_valid_tokens_costs_one_refresh_a_minute() {
    let mut rig = Rig::new(inbox());
    let signed = rig.sign_in(GOOGLE_SCOPE, false);
    let record = rig.record("g1", "me@gmail.test", &signed, json!({}));
    rig.store(&[&record]);
    rig.auth.refuse_valid_tokens(true);
    let account = Rig::param(&record);

    for _ in 0..200 {
        let r = rig.rpc("imap_get_mailboxes", json!({"account": account})).await;
        assert!(!ok(&r));
    }
    let first_minute = rig.posts();
    rig.advance(Duration::from_secs(61));
    for _ in 0..50 {
        let _ = rig.rpc("imap_get_mailboxes", json!({"account": account})).await;
    }

    assert_eq!(first_minute, 1, "one refresh for 200 refused requests");
    assert_eq!(rig.posts(), 2, "one more after the quiet minute");
    assert_eq!(rig.leaks(), Vec::<String>::new());
}

// ── found by these tests ────────────────────────────────────────────────────

/// Outlook ends a signed-in IMAP session once its token expires ("Session
/// invalidated - AccessTokenExpired"). The daemon refreshes five minutes
/// before expiry, so pooled sessions signed in with the old token outlive the
/// refresh and are ended a few minutes later: the next request on one failed
/// ("connection likely dropped") although a good token was held. A refresh
/// now retires the account's pooled sessions, so the next request signs in
/// with the new token.
#[tokio::test]
async fn a_pooled_session_ended_for_its_expired_token_costs_no_failed_request() {
    let mut rig = Rig::new(inbox());
    rig.auth.end_sessions_when_invalid(true);
    let signed = rig.sign_in(GOOGLE_SCOPE, false);
    let record = rig.record("g1", "me@gmail.test", &signed, json!({}));
    rig.store(&[&record]);
    let account = Rig::param(&record);

    assert!(ok(&rig.rpc("imap_get_mailboxes", json!({"account": account})).await), "signs in, the session is pooled");
    rig.advance(Duration::from_secs(56 * 60));
    let at_refresh = rig.rpc("imap_get_mailboxes", json!({"account": account})).await;
    rig.advance(Duration::from_secs(5 * 60));
    let after_old_expiry = rig.rpc("imap_get_mailboxes", json!({"account": account})).await;

    assert!(ok(&at_refresh), "{}", message(&at_refresh));
    assert_eq!(rig.posts(), 1, "refreshed inside the margin");
    assert!(ok(&after_old_expiry), "the old token's session must not be used: {}", message(&after_old_expiry));
}

// ── also ────────────────────────────────────────────────────────────────────

/// 20 requests in parallel at expiry: one refresh, every request signed in.
#[tokio::test]
async fn twenty_parallel_requests_at_expiry_share_one_refresh() {
    let rig = Rig::new(inbox());
    let signed = rig.sign_in(GOOGLE_SCOPE, false);
    let record = rig.record("g1", "me@gmail.test", &signed, json!({}));
    rig.store(&[&record]);
    rig.advance(HOUR + Duration::from_secs(60));
    let account = Rig::param(&record);

    let s = Arc::clone(&rig.s);
    let calls = (0..20).map(|_| {
        let (s, account) = (Arc::clone(&s), account.clone());
        async move { handle_request_for_test(&s, "imap_get_mailboxes", json!({"account": account})).await }
    });
    let answers = futures::future::join_all(calls).await;

    assert!(answers.iter().all(ok), "{:?}", answers.iter().map(message).collect::<Vec<_>>());
    assert_eq!(rig.posts(), 1);
}

/// Two accounts with the same address (two sign-ins, two ids) never share a
/// token: each refresh posts its own refresh token, each id gets its own pair.
#[tokio::test]
async fn two_accounts_with_one_address_keep_their_own_tokens() {
    let mut rig = Rig::new(inbox());
    let (a, b) = (rig.sign_in(GOOGLE_SCOPE, false), rig.sign_in(GOOGLE_SCOPE, false));
    let ra = rig.record("a1", "me@gmail.test", &a, json!({}));
    let rb = rig.record("a2", "me@gmail.test", &b, json!({}));
    rig.store(&[&ra, &rb]);
    rig.advance(HOUR + Duration::from_secs(60));

    assert!(ok(&rig.rpc("imap_get_mailboxes", json!({"account": Rig::param(&ra)})).await));
    assert!(ok(&rig.rpc("imap_get_mailboxes", json!({"account": Rig::param(&rb)})).await));
    let posted: Vec<String> = rig.auth.posts().into_iter().map(|p| p.refresh_token).collect();
    let pairs = rig.s.tokens.unsaved();
    let pair = |id: &str| pairs.iter().find(|p| p["accountId"] == json!(id)).cloned().unwrap();

    assert_eq!(posted, vec![a.refresh_token.clone(), b.refresh_token.clone()]);
    assert_eq!(pair("a1")["refreshToken"], json!(a.refresh_token));
    assert_eq!(pair("a2")["refreshToken"], json!(b.refresh_token));
    assert_ne!(pair("a1")["accessToken"], pair("a2")["accessToken"]);
}

/// The daemon's token goes only to the server the account object names: a
/// second mock server on the same authority sees no connection at all.
#[tokio::test]
async fn the_token_goes_only_to_the_host_the_account_names() {
    let mut rig = Rig::new(inbox());
    let elsewhere = MockImap::start_checked(inbox(), Arc::new(rig.auth.clone()));
    let signed = rig.sign_in(GOOGLE_SCOPE, false);
    let record = rig.record("g1", "me@gmail.test", &signed, json!({}));
    rig.store(&[&record]);

    assert!(ok(&rig.rpc("imap_get_mailboxes", json!({"account": Rig::param(&record)})).await));
    assert!(rig.imap.connection_count() >= 1);
    assert_eq!(elsewhere.connection_count(), 0);
    assert!(rig.auth.auth_log().iter().all(|a| a.accepted), "the stale token in the request was never sent");
}
