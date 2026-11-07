//! `mobile.message.body` against the mock IMAP server. The LRU cap test is a unit test in
//! `src/body.rs`: the cap is overridable in unit tests only.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT: Duration = Duration::from_secs(60);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn recent(uid: u32, raw: String) -> Message {
    Message::new(uid, raw).with_internal_ms(now_ms() - 86_400_000 + uid as i64)
}

/// multipart/mixed [ alternative [ text, html ], application/pdf of 5 MB ].
fn with_big_attachment(uid: u32) -> Message {
    let pdf_b64: String = {
        let line = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0\r\n";
        line.repeat(5 * 1024 * 1024 / 57 + 1)
    };
    recent(
        uid,
        format!(
            "From: Ana <ana@example.com>\r\n\
             To: user@example.com\r\n\
             Subject: Quarterly report\r\n\
             Message-ID: <big-{uid}@example.com>\r\n\
             MIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=\"mix\"\r\n\
             \r\n\
             --mix\r\n\
             Content-Type: multipart/alternative; boundary=\"alt\"\r\n\
             \r\n\
             --alt\r\n\
             Content-Type: text/plain; charset=utf-8\r\n\
             Content-Transfer-Encoding: quoted-printable\r\n\
             \r\n\
             Hi,   the report   is =\r\n\
             attached. Gr=C3=BC=C3=9Fe\r\n\
             --alt\r\n\
             Content-Type: text/html; charset=utf-8\r\n\
             \r\n\
             <p>Hi, the report is attached.</p>\r\n\
             --alt--\r\n\
             --mix\r\n\
             Content-Type: application/pdf; name=\"report.pdf\"\r\n\
             Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
             Content-Transfer-Encoding: base64\r\n\
             \r\n\
             {pdf_b64}\
             --mix--\r\n"
        ),
    )
}

fn html_only(uid: u32, html: &str) -> Message {
    recent(
        uid,
        format!(
            "From: News <news@example.com>\r\nSubject: Newsletter\r\nMessage-ID: <news-{uid}@example.com>\r\n\
             Content-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n"
        ),
    )
}

#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
}

struct Fixture {
    _tmp: tempfile::TempDir,
    engine: Arc<Engine>,
    events: Arc<Events>,
    account: String,
}

fn setup(server: &MockImap) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let engine = Arc::new(Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap());
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    });
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": "pw-body-test", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    let f = Fixture { _tmp: tmp, engine, events, account };
    f.sync();
    f
}

impl Fixture {
    /// One full pass (folder list and INBOX), waited for until it ends idle.
    fn sync(&self) {
        let from = self.events.list.lock().unwrap().len();
        self.engine.rpc("mobile.sync.refresh", json!({ "accountId": self.account })).unwrap();
        let deadline = Instant::now() + WAIT;
        let mut list = self.events.list.lock().unwrap();
        loop {
            let end = list.iter().skip(from).find(|(n, v)| n == "mobile.sync.state" && (v["state"] == "idle" || v["state"] == "error"));
            if let Some((_, v)) = end {
                assert_eq!(v["state"], "idle", "sync ended in error: {v}");
                return;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "sync did not end");
            list = self.events.cv.wait_timeout(list, left).unwrap().0;
        }
    }

    fn body(&self, uid: u32) -> Value {
        self.engine.rpc("mobile.message.body", json!({ "accountId": self.account, "folder": "INBOX", "uid": uid })).unwrap()
    }

    fn snippet(&self, uid: i64) -> String {
        let page = self
            .engine
            .rpc("mobile.messages.page", json!({ "accountId": self.account, "folder": "INBOX", "cursor": null, "limit": 50 }))
            .unwrap();
        let row = page["rows"].as_array().unwrap().iter().find(|r| r["uid"] == uid).cloned().unwrap();
        row["snippet"].as_str().unwrap().to_string()
    }
}

fn fetches(server: &MockImap) -> Vec<String> {
    server.commands().into_iter().filter(|c| c.to_ascii_uppercase().contains("FETCH")).collect()
}

#[test]
fn body_fetches_only_text_parts() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(with_big_attachment(1))));
    let f = setup(&server);
    assert_eq!(f.snippet(1), "", "no snippet before the body lands");
    let before = fetches(&server).len();

    let body = f.body(1);
    assert_eq!(body["gone"], false, "{body}");
    assert_eq!(body["html"].as_str().unwrap().trim_end(), "<p>Hi, the report is attached.</p>");
    assert_eq!(body["text"].as_str().unwrap().trim_end(), "Hi,   the report   is attached. Grüße");
    assert_eq!(body["remoteImages"], 0);
    assert_eq!(body["trackers"], 0);
    let att = body["attachments"].as_array().unwrap();
    assert_eq!(att.len(), 1, "{body}");
    assert_eq!(att[0]["section"], "2");
    assert_eq!(att[0]["filename"], "report.pdf");
    assert_eq!(att[0]["mime"], "application/pdf");
    assert!(att[0]["size"].as_u64().unwrap() > 5_000_000, "{}", att[0]);

    let sent = fetches(&server)[before..].to_vec();
    assert!(sent.iter().any(|c| c.contains("BODY.PEEK[1.1]")), "{sent:?}");
    assert!(sent.iter().any(|c| c.contains("BODY.PEEK[1.2]")), "{sent:?}");
    assert!(!sent.iter().any(|c| c.contains("BODY.PEEK[]") || c.contains("BODY[]")), "{sent:?}");
    assert!(!sent.iter().any(|c| c.contains("[2]")), "the attachment was fetched: {sent:?}");

    assert_eq!(f.snippet(1), "Hi, the report is attached. Grüße");

    // Cached: the second open sends nothing.
    let n = server.commands().len();
    assert_eq!(f.body(1), body);
    assert_eq!(server.commands().len(), n, "a cached body went to the server");
}

#[test]
fn body_strips_trackers_and_counts_remote_images() {
    let html = "<p>Hello</p>\
        <img src=\"https://cdn.example.com/hero.jpg\" width=\"600\" height=\"300\">\
        <img src=\"https://cdn.example.com/logo.png\" width=\"120\" height=\"40\">\
        <img src=\"https://track.example.net/open/abc123.gif\" width=\"1\" height=\"1\">";
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(html_only(1, html))));
    let f = setup(&server);

    let body = f.body(1);
    assert_eq!(body["gone"], false, "{body}");
    assert_eq!(body["trackers"], 1, "{body}");
    assert_eq!(body["remoteImages"], 2, "{body}");
    let stored = body["html"].as_str().unwrap();
    assert!(!stored.contains("track.example.net"), "the beacon is still there: {stored}");
    assert!(stored.contains("data-mv-tracker-blocked"), "{stored}");
    assert!(stored.contains("https://cdn.example.com/hero.jpg"), "remote images keep their URLs: {stored}");
    assert!(!stored.contains("util.trackerDetect"), "a catalog key leaked into the html: {stored}");
    assert_eq!(body["text"], Value::Null);
    assert_eq!(f.snippet(1), "Hello");
}

#[test]
fn gone_message_says_gone() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(html_only(1, "<p>soon gone</p>"))));
    let f = setup(&server);
    server.mutate(|s| s.find_mut("INBOX").unwrap().expunge(&[1], false));

    let body = f.body(1);
    assert_eq!(body, json!({ "html": null, "text": null, "attachments": [], "remoteImages": 0, "trackers": 0, "gone": true }));
    // Nothing was cached: once it is back under the same uid (a test-only trick), it is fetched.
    server.mutate(|s| {
        s.find_mut("INBOX").unwrap().add(html_only(1, "<p>back</p>"));
    });
    let n = server.commands().len();
    assert_eq!(f.body(1)["html"].as_str().unwrap().trim_end(), "<p>back</p>");
    assert!(server.commands().len() > n);
}

#[test]
fn unknown_folder_is_invalid() {
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")));
    let f = setup(&server);
    let err = f.engine.rpc("mobile.message.body", json!({ "accountId": f.account, "folder": "Nope", "uid": 1 })).unwrap_err();
    assert_eq!(err.code(), "INVALID");
}

/// Another client marks the message read mid-fetch: an unsolicited FLAGS FETCH for the same uid
/// arrives before each data reply. The body is still the real one, not an empty one.
#[test]
fn an_unsolicited_flags_fetch_does_not_empty_the_body() {
    let flags = || Action::InjectUntagged("* 1 FETCH (UID 1 FLAGS (\\Seen))".into());
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push_msg(with_big_attachment(1)))
            .fault(Trigger::with("FETCH", "(UID BODYSTRUCTURE)"), flags())
            .fault(Trigger::with("FETCH", "BODY.PEEK[1.1]"), flags())
            .fault(Trigger::with("FETCH", "BODY.PEEK[1.2]"), flags()),
    );
    let f = setup(&server);
    let body = f.body(1);
    assert_eq!(body["gone"], false, "{body}");
    assert_eq!(body["html"].as_str().unwrap().trim_end(), "<p>Hi, the report is attached.</p>");
    assert_eq!(body["text"].as_str().unwrap().trim_end(), "Hi,   the report   is attached. Grüße");
    assert_eq!(f.snippet(1), "Hi, the report is attached. Grüße");
}

/// A part whose encoding the reply does not name is an error, and nothing is cached: the next
/// open goes to the server again.
#[test]
fn an_undetermined_encoding_is_an_error_and_not_cached() {
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(html_only(1, "<p>x</p>"))).fault(
            Trigger::with("FETCH", "BODY.PEEK[1]"),
            Action::RespondRaw("* 1 FETCH (UID 1 BODY[1] {12}\r\nPHA+eDwvcD4=)\r\n{tag} OK FETCH completed\r\n".into()),
        ),
    );
    let f = setup(&server);
    for _ in 0..2 {
        let n = server.commands().len();
        let err = f.engine.rpc("mobile.message.body", json!({ "accountId": f.account, "folder": "INBOX", "uid": 1 })).unwrap_err();
        assert_eq!(err.code(), "INTERNAL", "{err}");
        assert!(server.commands().len() > n, "the second open was served from a cache");
    }
    assert_eq!(f.snippet(1), "");
}
