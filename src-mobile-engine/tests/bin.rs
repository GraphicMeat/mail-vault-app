//! The deleted-mail bin on the phone (`mobile.deleted.*`), against the mock IMAP server: a move to
//! Trash is recorded without its bytes and recovers by moving back; a permanent delete keeps the
//! whole message first and recovers by uploading it; a recover never makes a second copy; the
//! capture is in place before the delete goes out, survives a crash between the two, and goes
//! away when the delete does not happen; retention and account removal empty it.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const WAIT: Duration = Duration::from_secs(60);
const PASSWORD: &str = "pw-bin-test";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn raw(uid: u32, subject: &str) -> String {
    format!(
        "From: Sender {uid} <sender{uid}@example.com>\r\n\
         To: user@example.com\r\n\
         Subject: {subject}\r\n\
         Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
         Message-ID: <bin-{uid}@example.com>\r\n\
         Content-Type: text/plain; charset=UTF-8\r\n\
         \r\n\
         Body {uid}.\r\n"
    )
}

fn at(uid: u32) -> i64 {
    (now_ms() / DAY - 2) * DAY + uid as i64 * 1000
}

fn msg(uid: u32, subject: &str) -> Message {
    Message::new(uid, raw(uid, subject)).with_internal_ms(at(uid))
}

/// Another message that carries `uid`'s Message-ID: anyone can send one.
fn decoy(uid: u32, n: u32) -> Message {
    Message::new(n, raw(uid, "Totally the same message").replace("Sender", "Mallory")).with_internal_ms(at(uid))
}

fn mailbox(name: &str, attrs: &[&str], msgs: Vec<Message>) -> Mailbox {
    let mut mb = if attrs.is_empty() { Mailbox::new(name) } else { Mailbox::new(name).with_attrs(attrs) };
    for m in msgs {
        mb.add(m);
    }
    mb
}

/// INBOX with `inbox`, Trash with `trash` (uids as given).
fn scenario(inbox: &[u32], trash: &[u32]) -> Scenario {
    Scenario::new()
        .mailbox(mailbox("INBOX", &[], inbox.iter().map(|&u| msg(u, &format!("m{u}"))).collect()))
        .mailbox(mailbox("Trash", &["\\HasNoChildren", "\\Trash"], trash.iter().map(|&u| msg(u, &format!("t{u}")).with_flags(&["\\Seen", "\\Flagged"])).collect()))
}

#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
}

impl Events {
    fn len(&self) -> usize {
        self.list.lock().unwrap().len()
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

    /// The first `done`, `dropped` or `discarded` result for `seq`.
    fn final_result(&self, seq: i64) -> Value {
        self.wait(0, &format!("final action.result for {seq}"), |n, v| {
            n == "mobile.action.result" && v["seq"] == seq && v["outcome"] != "retrying"
        })
    }

    fn retrying(&self, seq: i64) -> Value {
        self.wait(0, &format!("retrying result for {seq}"), |n, v| n == "mobile.action.result" && v["seq"] == seq && v["outcome"] == "retrying")
    }

    fn wait_idle(&self, from: usize, account: &str) {
        let end = self.wait(from, "sync end", |n, v| {
            n == "mobile.sync.state" && v["accountId"] == account && (v["state"] == "idle" || v["state"] == "error")
        });
        assert_eq!(end["state"], "idle", "sync ended in error: {end}");
    }
}

struct Fixture {
    tmp: tempfile::TempDir,
    secrets: Arc<MemorySecrets>,
    engine: Arc<Engine>,
    events: Arc<Events>,
    account: String,
}

fn open(dir: &Path, secrets: &Arc<MemorySecrets>) -> (Arc<Engine>, Arc<Events>) {
    let engine = Arc::new(Engine::open(dir, &dir.join("cache"), Arc::clone(secrets) as _).unwrap());
    engine.set_action_backoff(Duration::from_millis(50), Duration::from_millis(200));
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    assert!(engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    }));
    (engine, events)
}

fn setup(server: &MockImap) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let (engine, events) = open(tmp.path(), &secrets);
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": PASSWORD, "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    Fixture { tmp, secrets, engine, events, account }
}

impl Fixture {
    fn sync(&self, folder: Option<&str>) {
        let from = self.events.len();
        let mut p = json!({ "accountId": self.account });
        if let Some(f) = folder {
            p["folder"] = json!(f);
        }
        assert_eq!(self.engine.rpc("mobile.sync.refresh", p).unwrap(), json!({ "queued": true }));
        self.events.wait_idle(from, &self.account);
    }

    fn delete(&self, folder: &str, uids: &[u32]) -> i64 {
        let r = self.engine.rpc("mobile.actions.apply", json!({ "accountId": self.account, "folder": folder, "uids": uids, "kind": "delete" })).unwrap();
        r["queued"].as_i64().unwrap_or_else(|| panic!("no seq in {r}"))
    }

    fn bin(&self) -> Vec<Value> {
        self.engine.rpc("mobile.deleted.list", json!({})).unwrap()["rows"].as_array().unwrap().clone()
    }

    fn recover(&self, id: &str) -> Value {
        self.engine.rpc("mobile.deleted.recover", json!({ "ids": [id] })).unwrap()
    }

    fn recover_seq(&self, id: &str) -> i64 {
        let r = self.recover(id);
        r["queued"][0]["seq"].as_i64().unwrap_or_else(|| panic!("not queued: {r}"))
    }

    fn eml(&self, id: &str) -> PathBuf {
        self.tmp.path().join("deleted").join(format!("{id}.eml"))
    }

    fn app_db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.tmp.path().join("core").join("app.db")).unwrap()
    }
}

fn copies(server: &MockImap, folder: &str, uid: u32) -> usize {
    let want = format!("<bin-{uid}@example.com>");
    server.state().find(folder).unwrap().messages.iter().filter(|m| String::from_utf8_lossy(&m.raw).contains(&want)).count()
}

/// A delete outside Trash moves the message there and records it without its bytes; recover moves
/// it back out of Trash, and the bin row goes.
#[test]
fn a_move_to_trash_is_recorded_bare_and_recovers_by_moving_back() {
    let server = MockImap::start(scenario(&[1, 2], &[]));
    let f = setup(&server);
    f.sync(None);
    assert!(f.bin().is_empty());
    let seq = f.delete("INBOX", &[1]);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert_eq!((copies(&server, "INBOX", 1), copies(&server, "Trash", 1)), (0, 1));

    let bin = f.bin();
    assert_eq!(bin.len(), 1, "{bin:?}");
    let row = &bin[0];
    assert_eq!(row["accountId"], f.account.as_str());
    assert_eq!(row["mailbox"], "INBOX");
    assert_eq!(row["uid"], 1);
    assert_eq!(row["messageId"], "<bin-1@example.com>");
    assert_eq!(row["hasEml"], false, "Trash holds it: no bytes kept");
    assert_eq!(row["trash"], "Trash");
    assert_eq!(row["row"]["subject"], "m1");
    assert_eq!(row["row"]["from"]["address"], "sender1@example.com");
    let id = row["id"].as_str().unwrap().to_string();
    assert!(!f.eml(&id).exists());

    let seq = f.recover_seq(&id);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert_eq!((copies(&server, "INBOX", 1), copies(&server, "Trash", 1)), (1, 0), "moved back, not copied");
    assert!(f.bin().is_empty(), "the row goes once it is back");
}

/// A delete in Trash is permanent: the whole message is kept in `<data>/deleted/` before it goes,
/// and recover uploads it back with its flags.
#[test]
fn a_permanent_delete_keeps_the_message_and_recovers_by_upload() {
    let server = MockImap::start(scenario(&[], &[5]));
    let f = setup(&server);
    f.sync(Some("Trash"));
    let seq = f.delete("Trash", &[5]);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert_eq!(copies(&server, "Trash", 5), 0, "gone from the server");

    let bin = f.bin();
    assert_eq!(bin.len(), 1, "{bin:?}");
    assert_eq!(bin[0]["hasEml"], true);
    assert_eq!(bin[0]["mailbox"], "Trash");
    let id = bin[0]["id"].as_str().unwrap().to_string();
    let kept = std::fs::read(f.eml(&id)).expect("the message is kept beside the data");
    assert_eq!(String::from_utf8_lossy(&kept), raw(5, "t5"), "the whole message, as the server had it");

    let seq = f.recover_seq(&id);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert_eq!(copies(&server, "Trash", 5), 1, "uploaded back where it was deleted from");
    let back = server.state().find("Trash").unwrap().messages[0].clone();
    assert!(back.has_flag("\\Seen") && back.has_flag("\\Flagged"), "with its flags: {:?}", back.flags);
    assert!(f.bin().is_empty());
    assert!(!f.eml(&id).exists(), "the file goes with its row");
}

/// A recover never makes a second copy: a folder that holds the message (put back by some other
/// client, or by an upload whose reply was lost) is the recovered copy.
#[test]
fn a_recover_never_uploads_a_second_copy() {
    let server = MockImap::start(scenario(&[], &[5]));
    let f = setup(&server);
    f.sync(Some("Trash"));
    let seq = f.delete("Trash", &[5]);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    let id = f.bin()[0]["id"].as_str().unwrap().to_string();
    // Another client put the same message back meanwhile (the same bytes, the same date).
    server.mutate(|s| {
        s.find_mut("Trash").unwrap().add(Message::new(9, raw(5, "t5")).with_internal_ms(at(5)));
    });
    let appends = server.count_commands("APPEND");
    let seq = f.recover_seq(&id);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert_eq!(copies(&server, "Trash", 5), 1, "no second copy");
    assert_eq!(server.count_commands("APPEND"), appends, "nothing uploaded");
    assert!(f.bin().is_empty());
}

/// A message moved to Trash that Trash no longer holds cannot come back: the recover drops with
/// GONE_FROM_TRASH and the row stays listed.
#[test]
fn a_recover_of_a_message_gone_from_trash_says_so() {
    let server = MockImap::start(scenario(&[1], &[]));
    let f = setup(&server);
    f.sync(None);
    let seq = f.delete("INBOX", &[1]);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    let id = f.bin()[0]["id"].as_str().unwrap().to_string();
    server.mutate(|s| {
        let t = s.find_mut("Trash").unwrap();
        let uids: Vec<u32> = t.messages.iter().map(|m| m.uid).collect();
        t.expunge(&uids, false);
    });
    let seq = f.recover_seq(&id);
    let r = f.events.final_result(seq);
    assert_eq!((r["outcome"].clone(), r["reason"].clone()), (json!("dropped"), json!("GONE_FROM_TRASH")), "{r}");
    assert_eq!(f.bin().len(), 1, "the row stays");
    assert_eq!(copies(&server, "INBOX", 1), 0);
}

/// The capture is in place before the delete goes out: a delete that fails on the wire leaves the
/// message on the server and its copy in the bin; the engine dies there and comes back, the delete
/// replays, finds its capture again (one row, the same file) and lands. A recover asked for while
/// the delete is still owed is refused, since that delete would take the message again.
#[test]
fn a_crash_between_the_capture_and_the_delete_keeps_one_copy() {
    let server = MockImap::start(scenario(&[], &[5]).fault(Trigger::on("STORE"), Action::DropConnection));
    let f = setup(&server);
    // The fault is on STORE only: sync reads the folder.
    f.sync(Some("Trash"));
    let seq = f.delete("Trash", &[5]);
    assert_eq!(f.events.retrying(seq)["outcome"], "retrying");
    assert_eq!(copies(&server, "Trash", 5), 1, "still on the server");
    let bin = f.bin();
    assert_eq!(bin.len(), 1, "captured before the wire: {bin:?}");
    let id = bin[0]["id"].as_str().unwrap().to_string();
    assert!(f.eml(&id).exists());
    let refused = f.recover(&id);
    assert_eq!(refused["queued"], json!([]), "{refused}");
    assert_eq!(refused["failed"][0]["error"], "deletedBin.deleteStillQueued", "{refused}");

    // The crash, then a healthy server: the engine is gone before the server heals, so no attempt
    // of the old one lands the delete.
    let Fixture { tmp, secrets, engine, events: _, account } = f;
    drop(engine);
    server.reset_scenario(scenario(&[], &[5]));
    let (engine, events) = open(tmp.path(), &secrets);
    let f = Fixture { tmp, secrets, engine, events, account };
    f.engine.rpc("mobile.actions.retry", json!({})).unwrap();
    let r = f.events.final_result(seq);
    assert_eq!(r["outcome"], "done", "{r}");
    assert_eq!(copies(&server, "Trash", 5), 0);
    let bin = f.bin();
    assert_eq!(bin.len(), 1, "one row, not one per attempt: {bin:?}");
    assert_eq!(bin[0]["id"], id.as_str());
    assert_eq!(std::fs::read_dir(f.tmp.path().join("deleted")).unwrap().count(), 1, "one file");
}

/// A delete that does not happen takes its capture back: the user cancels a move to Trash that the
/// server keeps failing, the message stays where it was, and the bin holds nothing.
#[test]
fn a_cancelled_delete_leaves_nothing_in_the_bin() {
    let server = MockImap::start(scenario(&[1], &[]).fault(Trigger::on("MOVE"), Action::DropConnection));
    let f = setup(&server);
    f.sync(None);
    let seq = f.delete("INBOX", &[1]);
    f.events.retrying(seq);
    assert_eq!(f.bin().len(), 1, "captured before the wire");
    assert_eq!(f.engine.rpc("mobile.actions.discard", json!({ "seq": seq })).unwrap()["discarded"], true);
    // A replay attempt between its capture and its journal check takes its own capture out too.
    let deadline = Instant::now() + WAIT;
    while !f.bin().is_empty() {
        assert!(Instant::now() < deadline, "the capture stayed: {:?}", f.bin());
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(copies(&server, "INBOX", 1), 1);
}

/// Retention: a row older than the setting is purged with its file (a list purges, as the sweep
/// does); removing the account removes the rest; discard removes one or all.
#[test]
fn retention_account_removal_and_discard_empty_the_bin() {
    let server = MockImap::start(scenario(&[], &[5, 6, 7]));
    let f = setup(&server);
    f.sync(Some("Trash"));
    let seq = f.delete("Trash", &[5, 6, 7]);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    let bin = f.bin();
    assert_eq!(bin.len(), 3);
    let ids: Vec<String> = bin.iter().map(|r| r["id"].as_str().unwrap().to_string()).collect();

    // One row is two days old: the default day's retention purges it at the next list.
    f.app_db().execute("UPDATE deleted_messages SET deleted_at = ?2 WHERE id = ?1", (&ids[0], now_ms() - 2 * DAY)).unwrap();
    assert_eq!(f.engine.rpc("mobile.prefs.set", json!({ "deletedRetentionDays": 3 })).unwrap()["deletedRetentionDays"], 3);
    assert_eq!(f.bin().len(), 3, "three days keep it");
    f.engine.rpc("mobile.prefs.set", json!({ "deletedRetentionDays": 1 })).unwrap();
    assert_eq!(f.bin().len(), 2, "a day does not");
    assert!(!f.eml(&ids[0]).exists());

    // Paged, newest first, and the pages meet.
    let first = f.engine.rpc("mobile.deleted.list", json!({ "limit": 1 })).unwrap();
    assert_eq!(first["rows"].as_array().unwrap().len(), 1);
    let second = f.engine.rpc("mobile.deleted.list", json!({ "limit": 1, "after": first["next"] })).unwrap();
    assert_eq!(second["rows"].as_array().unwrap().len(), 1);
    assert_ne!(first["rows"][0]["id"], second["rows"][0]["id"]);

    assert_eq!(f.engine.rpc("mobile.deleted.discard", json!({ "ids": [ids[1]] })).unwrap()["removed"], 1);
    assert_eq!(f.bin().len(), 1);
    assert!(!f.eml(&ids[1]).exists());

    f.engine.rpc("mobile.accounts.remove", json!({ "accountId": f.account })).unwrap();
    assert!(f.bin().is_empty(), "the account's rows go with it");
    assert!(!f.eml(&ids[2]).exists());
}

/// A Message-ID proves nothing: a message that only carries the kept one's Message-ID (anyone can
/// mail one) is neither taken for it nor relabelled. The kept bytes are uploaded beside it.
#[test]
fn a_decoy_with_the_same_message_id_is_not_the_recovered_message() {
    let server = MockImap::start(scenario(&[], &[5]));
    let f = setup(&server);
    f.sync(Some("Trash"));
    let seq = f.delete("Trash", &[5]);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    let id = f.bin()[0]["id"].as_str().unwrap().to_string();
    server.mutate(|s| {
        s.find_mut("Trash").unwrap().add(decoy(5, 20));
    });
    let appends = server.count_commands("APPEND");
    let seq = f.recover_seq(&id);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert_eq!(server.count_commands("APPEND"), appends + 1, "the kept message was uploaded");
    let trash = server.state().find("Trash").unwrap().messages.clone();
    assert_eq!(trash.len(), 2, "the decoy and the recovered message");
    assert!(trash.iter().any(|m| m.raw == raw(5, "t5").into_bytes()), "the kept bytes are back");
    assert!(f.bin().is_empty());
}

/// A move back out of Trash takes only the message the bin recorded: a decoy in Trash with its
/// Message-ID stays where it is, and one in Junk is never even looked at.
#[test]
fn a_move_back_never_takes_a_decoy_from_trash_or_junk() {
    let server = MockImap::start(scenario(&[1], &[]).mailbox(mailbox("Junk", &["\\HasNoChildren", "\\Junk"], vec![])));
    let f = setup(&server);
    f.sync(None);
    let seq = f.delete("INBOX", &[1]);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    let id = f.bin()[0]["id"].as_str().unwrap().to_string();
    // The real one leaves Trash; a decoy lands there, and another in Junk.
    server.mutate(|s| {
        let t = s.find_mut("Trash").unwrap();
        let uids: Vec<u32> = t.messages.iter().map(|m| m.uid).collect();
        t.expunge(&uids, false);
        t.add(decoy(1, 30));
        s.find_mut("Junk").unwrap().add(decoy(1, 31));
    });
    let seq = f.recover_seq(&id);
    let r = f.events.final_result(seq);
    assert_eq!((r["outcome"].clone(), r["reason"].clone()), (json!("dropped"), json!("GONE_FROM_TRASH")), "{r}");
    assert_eq!(server.state().find("Trash").unwrap().messages.len(), 1, "the decoy stays in Trash");
    assert_eq!(server.state().find("Junk").unwrap().messages.len(), 1, "and in Junk");
    assert!(server.state().find("INBOX").unwrap().messages.is_empty(), "nothing moved into the Inbox");
    assert_eq!(f.bin().len(), 1, "the row stays");

    // With the real one back in Trash beside the decoy, the real one comes back.
    server.mutate(|s| {
        s.find_mut("Trash").unwrap().add(Message::new(40, raw(1, "m1")).with_internal_ms(at(1)));
    });
    let seq = f.recover_seq(&id);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    let inbox = server.state().find("INBOX").unwrap().messages.clone();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].raw, raw(1, "m1").into_bytes(), "the real one, not the decoy");
}
