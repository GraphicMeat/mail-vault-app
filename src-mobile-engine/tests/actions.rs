//! `mobile.actions.apply`, `mobile.actions.pending` and the replay worker, against the mock IMAP
//! server: an action applies locally at once, survives a restart in the journal, replays in order
//! when the server is reachable, and no sync pass undoes it while it is pending.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;
const WAIT: Duration = Duration::from_secs(60);
const PASSWORD: &str = "pw-actions-test";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn msg_at(uid: u32, subject: &str, at_ms: i64) -> Message {
    Message::new(
        uid,
        format!(
            "From: Sender {uid} <sender{uid}@example.com>\n\
             To: user@example.com\n\
             Subject: {subject}\n\
             Date: Thu, 01 Jan 2026 12:00:00 +0000\n\
             Message-ID: <act-{uid}-{at_ms}@example.com>\n\
             Content-Type: text/plain; charset=UTF-8\n\
             \n\
             Body {uid}.\n"
        ),
    )
    .with_internal_ms(at_ms)
}

/// A message `days_ago` days old. Dated by whole days, so a scenario built twice is the same.
fn msg(uid: u32, subject: &str, days_ago: i64) -> Message {
    msg_at(uid, subject, (now_ms() / DAY - days_ago) * DAY + uid as i64 * 1000)
}

fn mailbox(name: &str, attrs: &[&str], msgs: Vec<Message>) -> Mailbox {
    let mut mb = if attrs.is_empty() { Mailbox::new(name) } else { Mailbox::new(name).with_attrs(attrs) };
    for m in msgs {
        mb.add(m);
    }
    mb
}

/// INBOX with `uids`, plus an Archive and a Trash.
fn scenario(uids: &[u32]) -> Scenario {
    Scenario::new()
        .mailbox(mailbox("INBOX", &[], uids.iter().map(|&u| msg(u, &format!("m{u}"), 2)).collect()))
        .mailbox(mailbox("Archive", &["\\HasNoChildren", "\\Archive"], vec![]))
        .mailbox(mailbox("Trash", &["\\HasNoChildren", "\\Trash"], vec![]))
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

    /// The first `mobile.action.result` for `seq` at index `from` or later.
    fn result(&self, from: usize, seq: i64) -> Value {
        self.wait(from, &format!("action.result for {seq}"), |n, v| n == "mobile.action.result" && v["seq"] == seq)
    }

    /// The first final (`done` or `dropped`) result for `seq`.
    fn final_result(&self, seq: i64) -> Value {
        self.wait(0, &format!("final action.result for {seq}"), |n, v| {
            n == "mobile.action.result" && v["seq"] == seq && v["outcome"] != "retrying"
        })
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
    /// The platform secret store; a restart reopens with the same one, as the shell does.
    secrets: Arc<MemorySecrets>,
    engine: Arc<Engine>,
    events: Arc<Events>,
    account: String,
}

fn open(dir: &Path, secrets: &Arc<MemorySecrets>) -> (Arc<Engine>, Arc<Events>) {
    let engine = Arc::new(Engine::open(dir, &dir.join("cache"), Arc::clone(secrets) as _).unwrap());
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
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let (engine, events) = open(tmp.path(), &secrets);
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": PASSWORD, "imapHost": server.host(), "imapPort": server.port(), "security": "none" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    Fixture { tmp, secrets, engine, events, account }
}

impl Fixture {
    fn sync(&self, folder: Option<&str>) -> usize {
        let from = self.events.len();
        let mut p = json!({ "accountId": self.account });
        if let Some(f) = folder {
            p["folder"] = json!(f);
        }
        assert_eq!(self.engine.rpc("mobile.sync.refresh", p).unwrap(), json!({ "queued": true }));
        self.events.wait_idle(from, &self.account);
        from
    }

    fn try_apply(&self, kind: &str, folder: &str, uids: &[u32], target: Option<&str>) -> Result<Value, mailvault_mobile_engine::RpcError> {
        let mut p = json!({ "accountId": self.account, "folder": folder, "uids": uids, "kind": kind });
        if let Some(t) = target {
            p["target"] = json!(t);
        }
        self.engine.rpc("mobile.actions.apply", p)
    }

    /// Applies an action and returns its journal seq.
    fn apply(&self, kind: &str, folder: &str, uids: &[u32], target: Option<&str>) -> i64 {
        let r = self.try_apply(kind, folder, uids, target).unwrap();
        r["queued"].as_i64().unwrap_or_else(|| panic!("no seq in {r}"))
    }

    fn pending(&self) -> Vec<Value> {
        let r = self.engine.rpc("mobile.actions.pending", json!({ "accountId": self.account })).unwrap();
        r["pending"].as_array().unwrap().clone()
    }

    /// Polls `mobile.actions.pending` until it is empty.
    fn wait_pending_empty(&self) {
        let deadline = Instant::now() + WAIT;
        loop {
            let p = self.pending();
            if p.is_empty() {
                return;
            }
            assert!(Instant::now() < deadline, "journal never drained: {p:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn page(&self, folder: &str) -> Value {
        self.engine
            .rpc("mobile.messages.page", json!({ "accountId": self.account, "folder": folder, "cursor": null, "limit": 200 }))
            .unwrap()
    }

    fn row(&self, uid: i64) -> Option<Value> {
        self.page("INBOX")["rows"].as_array().unwrap().iter().find(|r| r["uid"] == uid).cloned()
    }

    fn uids(&self, folder: &str) -> Vec<i64> {
        self.page(folder)["rows"].as_array().unwrap().iter().map(|r| r["uid"].as_i64().unwrap()).collect()
    }

    /// `(local_seen, local_flagged, local_deleted)` of a stored row, `None` when there is no row.
    fn overrides(&self, uid: i64) -> Option<(Option<i64>, Option<i64>, Option<i64>)> {
        let db = rusqlite::Connection::open(self.tmp.path().join("mobile.db")).unwrap();
        db.query_row(
            "SELECT local_seen, local_flagged, local_deleted FROM messages WHERE account_id = ?1 AND folder = 'INBOX' AND uid = ?2",
            (&self.account, uid),
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok()
    }
}

fn server_flags(server: &MockImap, folder: &str, uid: u32) -> Vec<String> {
    server.state().find(folder).unwrap().by_uid(uid).unwrap_or_else(|| panic!("no uid {uid} in {folder}")).flags.clone()
}

fn has(flags: &[String], f: &str) -> bool {
    flags.iter().any(|x| x.eq_ignore_ascii_case(f))
}

/// Mark read with the server unreachable: the row reads seen at once, the action stays in the
/// journal through an engine restart, and replays once the server is back.
#[test]
fn mark_read_offline_then_replay() {
    let server = MockImap::start(scenario(&[1, 2]));
    let f = setup(&server);
    f.sync(None);
    assert_eq!(f.row(1).unwrap()["seen"], false);

    // Network down: every connection is dropped before the greeting.
    server.reset_scenario(scenario(&[1, 2]).fault(Trigger::OnConnect, Action::DropConnection));
    let from = f.events.len();
    let t0 = Instant::now();
    let seq = f.apply("seen", "INBOX", &[1], None);
    let took = t0.elapsed();
    eprintln!("mark_read_offline_then_replay: apply took {took:?} with the network down");
    assert!(took < Duration::from_millis(20), "apply took {took:?}");
    assert_eq!(f.row(1).unwrap()["seen"], true, "applied locally at once");
    let changed = f.events.wait(from, "folder.changed", |n, v| n == "mobile.folder.changed" && v["folder"] == "INBOX");
    assert_eq!(changed["updated"], 1, "{changed}");

    let r = f.events.result(from, seq);
    assert_eq!(r["outcome"], "retrying", "{r}");
    assert_eq!(r["reason"], "HOST_UNREACHABLE", "{r}");
    let pending = f.pending();
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert_eq!(pending[0]["seq"], seq);
    assert_eq!(pending[0]["kind"], "seen");
    assert_eq!(pending[0]["uids"], json!([1]));
    assert_eq!(pending[0]["state"], "retrying");
    assert_eq!(pending[0]["lastError"], "HOST_UNREACHABLE");
    assert!(!has(&server_flags(&server, "INBOX", 1), "\\Seen"));

    // Restart: drop the engine, bring the server back, open the same data dir.
    let Fixture { tmp, secrets, engine, events: _, account } = f;
    drop(engine);
    server.reset_scenario(scenario(&[1, 2]));
    let (engine, events) = open(tmp.path(), &secrets);
    let f = Fixture { tmp, secrets, engine, events, account };
    assert_eq!(f.row(1).unwrap()["seen"], true, "the override survives the restart");
    f.wait_pending_empty();
    assert!(has(&server_flags(&server, "INBOX", 1), "\\Seen"), "replayed to the server");
    assert!(!has(&server_flags(&server, "INBOX", 2), "\\Seen"));

    // A later sync agrees with the override, which then clears.
    f.sync(Some("INBOX"));
    assert_eq!(f.row(1).unwrap()["seen"], true);
    assert_eq!(f.overrides(1), Some((None, None, None)));
}

/// Review focus 1: a sync that reads the old flags while the action is pending does not undo it.
#[test]
fn sync_does_not_undo_pending_seen() {
    let server = MockImap::start(scenario(&[1, 2]));
    let f = setup(&server);
    f.sync(None);
    // Replay is held at its STORE, before the server changes.
    let mut pause = server.pause_command("STORE");
    let seq = f.apply("seen", "INBOX", &[1], None);
    assert!(pause.entered(WAIT), "replay never reached STORE");

    f.sync(Some("INBOX"));
    assert!(!has(&server_flags(&server, "INBOX", 1), "\\Seen"), "the sync read the old flags");
    assert_eq!(f.row(1).unwrap()["seen"], true, "sync undid a pending mark-read");
    assert_eq!(f.overrides(1), Some((Some(1), None, None)));

    pause.release();
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    f.wait_pending_empty();
    assert!(has(&server_flags(&server, "INBOX", 1), "\\Seen"));
    f.sync(Some("INBOX"));
    assert_eq!(f.row(1).unwrap()["seen"], true);
    assert_eq!(f.overrides(1), Some((None, None, None)), "a later sync that agrees clears the override");
}

/// Review focus 3: deleting a message another client already expunged drops with GONE.
#[test]
fn delete_of_gone_uid_drops_typed() {
    let server = MockImap::start(scenario(&[1, 2]));
    let f = setup(&server);
    f.sync(None);
    server.mutate(|s| s.find_mut("INBOX").unwrap().expunge(&[1], false));

    let seq = f.apply("delete", "INBOX", &[1], None);
    assert_eq!(f.uids("INBOX"), vec![2], "the deleted row is hidden at once");
    let r = f.events.final_result(seq);
    assert_eq!(r["outcome"], "dropped", "{r}");
    assert_eq!(r["reason"], "GONE", "{r}");
    assert!(f.pending().is_empty());
    assert_eq!(f.overrides(1), None, "the row is gone locally");
    assert!(server.state().find("Trash").unwrap().messages.is_empty(), "nothing went to Trash");
    assert!(server.state().find("INBOX").unwrap().by_uid(2).is_some());
}

/// A delete that does reach the server moves the message to Trash; one in Trash is permanent.
#[test]
fn delete_moves_to_trash_then_purges_there() {
    let server = MockImap::start(scenario(&[1, 2]));
    let f = setup(&server);
    f.sync(None);
    let seq = f.apply("delete", "INBOX", &[1], None);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert!(server.state().find("INBOX").unwrap().by_uid(1).is_none());
    assert_eq!(server.state().find("Trash").unwrap().messages.len(), 1);
    assert_eq!(f.overrides(1), None, "the deleted row is removed once done");

    f.sync(Some("Trash"));
    let trash_uid = f.uids("Trash")[0] as u32;
    let seq = f.apply("delete", "Trash", &[trash_uid], None);
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert!(server.state().find("Trash").unwrap().messages.is_empty(), "a delete in Trash is permanent");
    assert!(f.uids("Trash").is_empty());
}

#[test]
fn auth_failure_stays_queued() {
    let server = MockImap::start(scenario(&[1]));
    let f = setup(&server);
    f.sync(None);
    f.engine.set_action_backoff(Duration::from_millis(50), Duration::from_millis(200));
    server.reset_scenario(scenario(&[1]).fault(
        Trigger::on("LOGIN"),
        Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into()),
    ));

    let from = f.events.len();
    let seq = f.apply("flag", "INBOX", &[1], None);
    assert_eq!(f.row(1).unwrap()["flagged"], true);
    let first = f.events.result(from, seq);
    assert_eq!(first, json!({ "seq": seq, "accountId": f.account, "outcome": "retrying", "reason": "AUTH_FAILED" }));
    // It retries on the backoff, and stays queued.
    let n = f.events.len();
    let again = f.events.result(n, seq);
    assert_eq!(again["outcome"], "retrying");
    let p = f.pending();
    assert_eq!(p.len(), 1, "{p:?}");
    assert_eq!(p[0]["state"], "retrying");
    assert_eq!(p[0]["lastError"], "AUTH_FAILED");
    assert!(server.count_commands("LOGIN") >= 2, "{:?}", server.commands());
    assert!(!has(&server_flags(&server, "INBOX", 1), "\\Flagged"));
    assert_eq!(f.row(1).unwrap()["flagged"], true);

    // The password reaches no event and no journal row.
    assert!(!format!("{:?}", f.events.all()).contains(PASSWORD));
    let db = rusqlite::Connection::open(f.tmp.path().join("mobile.db")).unwrap();
    let journal: String = db
        .query_row("SELECT group_concat(coalesce(arg,'') || coalesce(last_error,'') || uids_json, '|') FROM pending_actions", [], |r| r.get(0))
        .unwrap();
    assert!(!journal.contains(PASSWORD), "{journal}");

    server.reset_scenario(scenario(&[1]));
    assert_eq!(f.events.final_result(seq)["outcome"], "done");
    assert!(has(&server_flags(&server, "INBOX", 1), "\\Flagged"));
    assert!(f.pending().is_empty());
}

/// Flag, move to Archive, unflag the moved copy: replayed in that order, the unflag following the
/// message to its new uid (UIDPLUS COPYUID).
#[test]
fn order_is_kept() {
    let server = MockImap::start(scenario(&[1, 2]));
    let f = setup(&server);
    f.sync(None);
    // Replay held at sign-in until all three are queued.
    let mut pause = server.pause_command("LOGIN");
    let s1 = f.apply("flag", "INBOX", &[1], None);
    let s2 = f.apply("move", "INBOX", &[1], Some("Archive"));
    let s3 = f.apply("unflag", "INBOX", &[1], None);
    assert!(s1 < s2 && s2 < s3);
    assert_eq!(f.uids("INBOX"), vec![2], "the moved row is hidden at once");
    assert!(pause.entered(WAIT));
    pause.release();
    for s in [s1, s2, s3] {
        assert_eq!(f.events.final_result(s)["outcome"], "done", "seq {s}: {:?}", f.events.all());
    }
    let st = server.state();
    assert!(st.find("INBOX").unwrap().by_uid(1).is_none());
    let archive = &st.find("Archive").unwrap().messages;
    assert_eq!(archive.len(), 1);
    assert!(!has(&archive[0].flags, "\\Flagged"), "the unflag reached the moved copy: {:?}", archive[0].flags);

    let cmds = server.commands();
    let at = |needle: &str| cmds.iter().position(|c| c.to_uppercase().contains(needle)).unwrap_or_else(|| panic!("no {needle} in {cmds:?}"));
    assert!(at("+FLAGS") < at("UID MOVE") && at("UID MOVE") < at("-FLAGS"), "{cmds:?}");
    assert!(f.pending().is_empty());
    assert_eq!(f.overrides(1), None, "the moved row left INBOX");
}

/// Without UIDPLUS the move has no new uid to offer: the follow-up drops with GONE and the server
/// keeps the truth.
#[test]
fn order_without_uidplus_drops_the_follow_up() {
    let server = MockImap::start(scenario(&[1, 2]).without_cap("UIDPLUS"));
    let f = setup(&server);
    f.sync(None);
    let mut pause = server.pause_command("LOGIN");
    let s1 = f.apply("flag", "INBOX", &[1], None);
    let s2 = f.apply("move", "INBOX", &[1], Some("Archive"));
    let s3 = f.apply("unflag", "INBOX", &[1], None);
    assert!(pause.entered(WAIT));
    pause.release();
    assert_eq!(f.events.final_result(s1)["outcome"], "done");
    assert_eq!(f.events.final_result(s2)["outcome"], "done");
    let r3 = f.events.final_result(s3);
    assert_eq!((r3["outcome"].as_str(), r3["reason"].as_str()), (Some("dropped"), Some("GONE")), "{r3}");
    let st = server.state();
    let archive = &st.find("Archive").unwrap().messages;
    assert_eq!(archive.len(), 1);
    assert!(has(&archive[0].flags, "\\Flagged"));
    assert!(f.pending().is_empty());
}

/// A move whose target folder is gone drops with FOLDER_GONE and the row comes back.
#[test]
fn move_to_a_gone_folder_drops_and_unhides() {
    let server = MockImap::start(scenario(&[1, 2]));
    let f = setup(&server);
    f.sync(None);
    let mut pause = server.pause_command("LOGIN");
    let seq = f.apply("move", "INBOX", &[1], Some("Archive"));
    assert_eq!(f.uids("INBOX"), vec![2]);
    assert!(pause.entered(WAIT));
    server.mutate(|s| s.mailboxes.retain(|m| m.name != "Archive"));
    pause.release();
    let r = f.events.final_result(seq);
    assert_eq!((r["outcome"].as_str(), r["reason"].as_str()), (Some("dropped"), Some("FOLDER_GONE")), "{r}");
    assert_eq!(f.uids("INBOX"), vec![2, 1], "the row is back in the list");
    assert!(server.state().find("INBOX").unwrap().by_uid(1).is_some());
}

/// The window removal never deletes a row with a pending action; once the action is done the
/// next pass may.
#[test]
fn sync_keeps_a_row_with_a_pending_action() {
    let server = MockImap::start(scenario(&[1, 2]));
    let f = setup(&server);
    f.sync(None);
    let mut pause = server.pause_command("STORE");
    let seq = f.apply("flag", "INBOX", &[1], None);
    assert!(pause.entered(WAIT));
    // Another client expunges it while our STORE is in flight.
    server.mutate(|s| s.find_mut("INBOX").unwrap().expunge(&[1], false));
    f.sync(Some("INBOX"));
    assert_eq!(f.row(1).map(|r| r["flagged"].clone()), Some(json!(true)), "a pending row was removed by sync");
    pause.release();
    f.events.final_result(seq);
    f.wait_pending_empty();
    f.sync(Some("INBOX"));
    assert_eq!(f.uids("INBOX"), vec![2], "a row with nothing pending follows the server");
}

/// A UIDVALIDITY change makes the journaled uids meaningless: the folder's pending actions drop
/// with GONE and nothing is sent for them.
#[test]
fn uidvalidity_change_drops_pending_with_gone() {
    let server = MockImap::start(scenario(&[1, 2]));
    let f = setup(&server);
    f.sync(None);
    let mut pause = server.pause_command("LOGIN");
    let seq = f.apply("seen", "INBOX", &[1], None);
    assert!(pause.entered(WAIT));
    server.mutate(|s| {
        let mb = s.find_mut("INBOX").unwrap();
        mb.uid_validity = 77;
        mb.messages.clear();
        mb.uid_next = 1;
        mb.add(msg(1, "new one", 3));
    });
    let from = f.sync(Some("INBOX"));
    let r = f.events.result(from, seq);
    assert_eq!((r["outcome"].as_str(), r["reason"].as_str()), (Some("dropped"), Some("GONE")), "{r}");
    assert!(f.pending().is_empty());
    pause.release();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!has(&server_flags(&server, "INBOX", 1), "\\Seen"), "nothing was sent for a dropped action");
    assert_eq!(server.count_commands("STORE"), 0, "{:?}", server.commands());
    assert_eq!(f.row(1).unwrap()["seen"], false);
    assert_eq!(f.row(1).unwrap()["subject"], "new one");
}

#[test]
fn apply_refuses_bad_params() {
    let server = MockImap::start(scenario(&[1]));
    let f = setup(&server);
    f.sync(None);
    let code = |r: Result<Value, mailvault_mobile_engine::RpcError>| serde_json::to_value(r.unwrap_err()).unwrap()["code"].clone();
    assert_eq!(code(f.try_apply("archive", "INBOX", &[1], None)), "INVALID");
    assert_eq!(code(f.try_apply("move", "INBOX", &[1], None)), "INVALID");
    assert_eq!(code(f.try_apply("move", "INBOX", &[1], Some("Nowhere"))), "INVALID");
    assert_eq!(code(f.try_apply("seen", "INBOX", &[1], Some("Archive"))), "INVALID");
    assert_eq!(code(f.try_apply("seen", "INBOX", &[], None)), "INVALID");
    assert_eq!(code(f.try_apply("seen", "Nowhere", &[1], None)), "INVALID");
    let many: Vec<u32> = (1..=200).collect();
    assert_eq!(code(f.try_apply("seen", "INBOX", &many, None)), "INVALID");
    let err = f.engine.rpc("mobile.actions.apply", json!({ "accountId": "acc_missing", "folder": "INBOX", "uids": [1], "kind": "seen" }));
    assert_eq!(code(err), "INVALID");
    assert!(f.pending().is_empty());
    let all = f.engine.rpc("mobile.actions.pending", json!({})).unwrap();
    assert_eq!(all, json!({ "pending": [] }));
}

/// `apply` returns in under 20 ms while a 5,000-header sync is writing: it waits behind at most one
/// 200-row batch.
#[test]
fn apply_returns_fast_while_sync_writes() {
    let server = MockImap::start(scenario(&[1]));
    let f = setup(&server);
    f.sync(None);
    // Replay held at its first STORE: this measures apply against sync alone.
    let mut pause = server.pause_command("STORE");
    let base = now_ms() - 60 * DAY;
    server.mutate(|s| {
        let mb = s.find_mut("INBOX").unwrap();
        for uid in 2..=5_001u32 {
            mb.add(msg_at(uid, &format!("bulk {uid}"), base + uid as i64 * 60_000));
        }
    });

    let stop = Arc::new(AtomicBool::new(false));
    let worker = {
        let (engine, account, stop) = (Arc::clone(&f.engine), f.account.clone(), Arc::clone(&stop));
        std::thread::spawn(move || {
            let apply = |kind: &str| {
                let t0 = Instant::now();
                engine.rpc("mobile.actions.apply", json!({ "accountId": account, "folder": "INBOX", "uids": [1], "kind": kind })).unwrap();
                t0.elapsed()
            };
            let total = || -> i64 {
                engine
                    .rpc("mobile.messages.page", json!({ "accountId": account, "folder": "INBOX", "cursor": null, "limit": 1 }))
                    .unwrap()["total"]
                    .as_i64()
                    .unwrap()
            };
            for i in 0..10 {
                apply(if i % 2 == 0 { "seen" } else { "unseen" });
            }
            let mut samples: Vec<(Duration, i64)> = Vec::new();
            let mut i = 0;
            while !stop.load(Ordering::SeqCst) {
                let took = apply(if i % 2 == 0 { "seen" } else { "unseen" });
                samples.push((took, total()));
                i += 1;
                std::thread::sleep(Duration::from_millis(5));
            }
            samples
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    f.sync(Some("INBOX"));
    stop.store(true, Ordering::SeqCst);
    let samples = worker.join().unwrap();
    pause.release();

    let mut lat: Vec<Duration> = samples.iter().map(|s| s.0).collect();
    lat.sort();
    let max = *lat.last().unwrap();
    let p99 = lat[(lat.len() * 99 / 100).min(lat.len() - 1)];
    let totals: HashSet<i64> = samples.iter().map(|s| s.1).collect();
    eprintln!(
        "apply_returns_fast_while_sync_writes: {} applies, {} distinct totals, p50 {:?}, p99 {p99:?}, max {max:?}",
        lat.len(),
        totals.len(),
        lat[lat.len() / 2]
    );
    assert!(totals.len() >= 4, "applies did not overlap the batch commits: totals {totals:?}");
    assert!(max < Duration::from_millis(20), "max apply latency {max:?} (p99 {p99:?})");
    assert_eq!(f.page("INBOX")["total"], 5_001);
}
