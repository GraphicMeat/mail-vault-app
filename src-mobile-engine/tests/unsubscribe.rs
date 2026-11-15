//! Unsubscribe on the phone: sync keeps a message's List-Unsubscribe, List-Unsubscribe-Post and
//! Authentication-Results, `mobile.unsubscribe.list` groups them by sender as desktop's
//! Settings > Unsubscribe does (core's `unsubscribe::plan` picks the method), and
//! `mobile.unsubscribe.run` unsubscribes: one-click (RFC 8058) through core's SSRF-guarded client,
//! else hands back the web page or the `mailto:` for the page to open. Every run is kept in the
//! history.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{MockImap, Scenario};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const WAIT: Duration = Duration::from_secs(60);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn msg(uid: u32, from: &str, extra: &str, days_ago: i64) -> Message {
    Message::new(
        uid,
        format!(
            "From: List <{from}>\n\
             To: user@example.com\n\
             Subject: Issue {uid}\n\
             Date: Thu, 01 Jan 2026 12:00:00 +0000\n\
             Message-ID: <unsub-{uid}@example.com>\n\
             {extra}\
             Content-Type: text/plain; charset=UTF-8\n\
             \n\
             Body {uid}.\n"
        ),
    )
    .with_internal_ms(now_ms() - days_ago * DAY)
}

#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
}

impl Events {
    fn wait_idle(&self, from: usize, account: &str) {
        let deadline = Instant::now() + WAIT;
        let mut list = self.list.lock().unwrap();
        loop {
            let end = list.iter().skip(from).find(|(n, v)| {
                n == "mobile.sync.state" && v["accountId"] == account && (v["state"] == "idle" || v["state"] == "error")
            });
            if let Some((_, v)) = end {
                assert_eq!(v["state"], "idle", "sync ended in error: {v}");
                return;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no sync end");
            list = self.cv.wait_timeout(list, left).unwrap().0;
        }
    }
}

fn synced(server: &MockImap) -> (tempfile::TempDir, Engine, String) {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap();
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    });
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": "pw-unsub-test", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    let from = events.list.lock().unwrap().len();
    assert_eq!(engine.rpc("mobile.sync.refresh", json!({ "accountId": account })).unwrap(), json!({ "queued": true }));
    events.wait_idle(from, &account);
    (tmp, engine, account)
}

const ONE_CLICK: &str = "List-Unsubscribe: <mailto:leave@news.test>, <https://127.0.0.1:9/u/abc>\n\
                         List-Unsubscribe-Post: List-Unsubscribe=One-Click\n\
                         Authentication-Results: mx.example.com; dkim=pass header.d=news.test\n";
const MAILTO_ONLY: &str = "List-Unsubscribe: <mailto:off@letters.test?subject=unsubscribe>\n";

fn server() -> MockImap {
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(msg(1, "news@news.test", ONE_CLICK, 5));
    inbox.add(msg(2, "News@News.test", ONE_CLICK, 2));
    inbox.add(msg(3, "letters@letters.test", MAILTO_ONLY, 3));
    inbox.add(msg(4, "friend@example.com", "", 1));
    MockImap::start(Scenario::new().mailbox(inbox))
}

fn sender<'a>(list: &'a Value, address: &str) -> Option<&'a Value> {
    list["senders"].as_array().unwrap().iter().find(|s| s["address"] == address)
}

#[test]
fn senders_with_an_unsubscribe_link_are_listed_once_with_their_method() {
    let server = server();
    let (_tmp, e, account) = synced(&server);
    let list = e.rpc("mobile.unsubscribe.list", json!({})).unwrap();
    let news = sender(&list, "news@news.test").expect("the one-click list, one entry for both spellings");
    assert_eq!(news["count"], 2);
    assert_eq!(news["method"], "one-click");
    assert_eq!(news["accountId"], account.as_str());
    assert_eq!(news["name"], "List");
    assert!(news["lastMs"].as_i64().unwrap() > now_ms() - 3 * DAY);
    assert_eq!(sender(&list, "letters@letters.test").unwrap()["method"], "mailto");
    assert!(sender(&list, "friend@example.com").is_none(), "no link, not listed");
    assert_eq!(list["history"], json!([]));
}

#[test]
fn a_mailto_list_hands_back_its_address_and_is_kept_in_the_history() {
    let server = server();
    let (_tmp, e, account) = synced(&server);
    let r = e.rpc("mobile.unsubscribe.run", json!({ "accountId": account, "address": "letters@letters.test" })).unwrap();
    assert_eq!(r["method"], "mailto");
    assert_eq!(r["status"], "opened");
    assert_eq!(r["url"], "mailto:off@letters.test?subject=unsubscribe");
    let history = e.rpc("mobile.unsubscribe.list", json!({})).unwrap()["history"].clone();
    let rows = history.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["address"], "letters@letters.test");
    assert_eq!(rows[0]["accountId"], account.as_str());
    assert_eq!((rows[0]["method"].clone(), rows[0]["status"].clone()), (json!("mailto"), json!("opened")));
}

#[test]
fn a_one_click_url_on_this_network_is_refused_and_its_web_page_offered() {
    let server = server();
    let (_tmp, e, account) = synced(&server);
    let r = e.rpc("mobile.unsubscribe.run", json!({ "accountId": account, "address": "news@news.test" })).unwrap();
    // The SSRF gate refuses a loopback target before any request: a mail cannot make the phone
    // POST into its own network.
    assert_eq!(r["method"], "browser");
    assert_eq!(r["status"], "opened");
    assert_eq!(r["url"], "https://127.0.0.1:9/u/abc");
    assert!(r["oneClickError"].as_str().is_some_and(|e| e.contains("refused")), "{r}");
    let history = e.rpc("mobile.unsubscribe.list", json!({})).unwrap()["history"].clone();
    let methods: Vec<(String, String)> = history
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (h["method"].as_str().unwrap().to_string(), h["status"].as_str().unwrap().to_string()))
        .collect();
    assert!(methods.contains(&("one-click".into(), "failed".into())), "{methods:?}");
    assert!(methods.contains(&("browser".into(), "opened".into())), "{methods:?}");
}

#[test]
fn an_unknown_sender_is_refused() {
    let server = server();
    let (_tmp, e, account) = synced(&server);
    assert!(e.rpc("mobile.unsubscribe.run", json!({ "accountId": account, "address": "friend@example.com" })).is_err());
}
