//! Full offline with the app in front (`offline.rs`): the foreground downloader fills the offline
//! window beside the page, stops when the app leaves, and never makes a page's own pass wait
//! behind it. The window, the lapse, the network gating and offline attachments are unit tests in
//! `src/offline.rs` (Premium and the body cap are unit-test seams).

use mailvault_mobile_engine::{Engine, MemorySecrets};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const WAIT: Duration = Duration::from_secs(60);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn mail(uid: u32, days_ago: i64) -> Message {
    Message::new(
        uid,
        format!(
            "From: A <a@example.com>\r\nTo: u@example.test\r\nSubject: s{uid}\r\nMessage-ID: <fg-{uid}-{days_ago}@x>\r\n\
             Content-Type: text/plain; charset=utf-8\r\n\r\nBody {uid}.\r\n"
        ),
    )
    .with_internal_ms(now_ms() - days_ago * DAY + uid as i64 * 1000)
}

fn mailbox(name: &str, msgs: impl IntoIterator<Item = Message>) -> Mailbox {
    let mut mb = Mailbox::new(name);
    for m in msgs {
        mb.add(m);
    }
    mb
}

#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
}

struct Fx {
    tmp: tempfile::TempDir,
    engine: Arc<Engine>,
    events: Arc<Events>,
    account: String,
}

fn fx(server: &MockImap) -> Fx {
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
            json!({ "email": "u@example.test", "password": "pw-offline", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    let account = added["account"]["id"].as_str().unwrap().to_string();
    Fx { tmp, engine, events, account }
}

impl Fx {
    fn count(&self, sql: &str) -> i64 {
        let db = rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap();
        db.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn front(&self, on: bool) {
        self.engine.rpc("mobile.app.state", json!({ "foreground": on })).unwrap();
    }

    fn wait_for(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done() {
            assert!(Instant::now() < deadline, "{what}: timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Waits for the sync state of `folder`'s page pass to end after event `from`.
    fn wait_idle(&self, from: usize) -> Value {
        let deadline = Instant::now() + WAIT;
        let mut list = self.events.list.lock().unwrap();
        loop {
            if let Some((_, v)) = list
                .iter()
                .skip(from)
                .find(|(n, v)| n == "mobile.folder.changed" && v["folder"] == "INBOX" && v["added"].as_u64().unwrap_or(0) > 0)
            {
                return v.clone();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "the INBOX refresh never landed");
            list = self.events.cv.wait_timeout(list, left).unwrap().0;
        }
    }
}

/// In front, with no background run, every folder's headers and every body of the window come
/// down (folders the user never opened included); once the app leaves, nothing more is fetched.
#[test]
fn the_foreground_downloader_fills_the_window_while_the_app_is_in_front() {
    let server = MockImap::start(Scenario::new().mailboxes(vec![
        mailbox("INBOX", (1..=30).map(|u| mail(u, 3))),
        mailbox("Archive", (1..=20).map(|u| mail(u, 50))),
        mailbox("Receipts", (1..=5).map(|u| mail(u, 80))),
    ]));
    let f = fx(&server);
    f.front(true);
    f.wait_for("every body of the window", || f.count("SELECT count(*) FROM bodies") == 55);
    assert_eq!(f.count("SELECT count(*) FROM messages"), 55);
    let got = f.engine.rpc("mobile.offline.get", json!({})).unwrap();
    assert_eq!(got["accounts"][0]["offline"], 55, "{got}");
    assert_eq!(got["accounts"][0]["messages"], 55, "{got}");
    assert!(!f.engine.offline_pending(), "work left after the window is down");

    // Away: new mail is the background run's, not the foreground downloader's.
    f.front(false);
    std::thread::sleep(Duration::from_millis(300));
    let fetches = server.count_commands("BODY.PEEK[");
    server.mutate(|s| {
        let mb = s.find_mut("INBOX").unwrap();
        let uid = mb.uid_next;
        mb.add(mail(uid, 0));
    });
    f.engine.rpc("mobile.offline.downloadNow", json!({})).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(server.count_commands("BODY.PEEK["), fetches, "downloaded with the app away");
}

/// The foreground downloader is busy with a slow body when the user pulls to refresh INBOX: the
/// refresh runs as soon as that one body is in, not after the downloader's slice.
#[test]
fn a_page_refresh_does_not_wait_behind_the_foreground_downloader() {
    // Every body takes 400 ms: a slice of 20 s would hold 50 of them.
    let server = MockImap::start(
        Scenario::new()
            .mailboxes(vec![mailbox("INBOX", (1..=5).map(|u| mail(u, 1))), mailbox("Archive", (1..=200).map(|u| mail(u, 20)))])
            .fault(Trigger::with("FETCH", "BODY.PEEK["), Action::Delay(Duration::from_millis(400))),
    );
    let f = fx(&server);
    f.front(true);
    f.wait_for("the downloader is fetching bodies", || f.count("SELECT count(*) FROM bodies") >= 2);
    server.mutate(|s| {
        let mb = s.find_mut("INBOX").unwrap();
        let uid = mb.uid_next;
        mb.add(mail(uid, 0));
    });
    let from = f.events.list.lock().unwrap().len();
    let t0 = Instant::now();
    f.engine.rpc("mobile.sync.refresh", json!({ "accountId": f.account, "folder": "INBOX" })).unwrap();
    f.wait_idle(from);
    let took = t0.elapsed();
    assert!(took < Duration::from_secs(4), "the refresh waited {took:?} behind the downloader");
    f.front(false);
}

/// A constrained network (Low Data Mode) stops the foreground downloader; the network coming back
/// starts it again.
#[test]
fn low_data_mode_holds_the_foreground_downloader() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox("INBOX", (1..=10).map(|u| mail(u, 2)))));
    let f = fx(&server);
    assert_eq!(f.engine.rpc("mobile.network.state", json!({ "constrained": true, "expensive": true })).unwrap(), json!({}));
    f.front(true);
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(server.count_commands("BODY.PEEK["), 0, "downloaded in Low Data Mode");
    assert_eq!(f.engine.rpc("mobile.offline.get", json!({})).unwrap()["network"]["constrained"], true);
    f.engine.set_network(false, true);
    f.wait_for("the bodies after Low Data Mode ended", || f.count("SELECT count(*) FROM bodies") == 10);
    f.front(false);
}
