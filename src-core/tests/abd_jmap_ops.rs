//! `abd::jmap_ops::JmapOps` against the mock JMAP server: the
//! `abd_graph_ops.rs` GraphOps tests one by one with `MockJmap` in place of
//! the Graph stub, plus the label rule an archive-and-delete must keep (an
//! email another mailbox also holds keeps that mailbox).
//!
//! Fixture (`common_jmap::scenario`): Inbox (e1, e2), Work, Work/Sub (e3),
//! Trash; e1 is also in Work.

mod common_jmap;

use common_jmap::{E1_RAW, E2_RAW};
use mailvault_core::abd::jmap_ops::JmapOps;
use mailvault_core::abd::throttle::{classify_jmap, Signal};
use mailvault_core::abd::{FolderInfo, FolderPlan, FolderRole, ListedMsg, OpsError, Provider, ServerOps};
use mailvault_core::imap::ImapConfig;
use mailvault_core::jmap::JmapError;
use mock_jmap::{Fault, MockJmap, ScenarioEmail, ScenarioMailbox};

// ── helpers ─────────────────────────────────────────────────────────────────

fn config(session_url: &str, password: Option<&str>) -> ImapConfig {
    serde_json::from_value(serde_json::json!({
        "email": "alice@example.test",
        "imapHost": "127.0.0.1",
        "password": password,
        "jmapSessionUrl": session_url,
        "jmapAuth": "basic",
    }))
    .expect("a JMAP account config")
}

fn ops(m: &MockJmap) -> JmapOps {
    JmapOps::new(config(&m.session_url(), Some("pw")))
}

fn start() -> MockJmap {
    MockJmap::start(common_jmap::scenario())
}

fn folder(path: &str, id: &str, role: FolderRole) -> FolderInfo {
    FolderInfo { path: path.into(), name: path.into(), role, graph_id: Some(id.into()), selectable: true }
}

fn inbox() -> FolderInfo {
    folder("INBOX", "mb-inbox", FolderRole::Normal)
}

fn trash() -> FolderInfo {
    folder("Trash", "mb-trash", FolderRole::Trash)
}

fn listed(uid: u32, id: &str, message_id: Option<&str>) -> ListedMsg {
    ListedMsg { uid, graph_id: Some(id.into()), message_id: message_id.map(str::to_string), ..Default::default() }
}

/// The email's mailbox ids on the server, `None` once it is destroyed.
fn labels(m: &MockJmap, id: &str) -> Option<Vec<String>> {
    m.read(|s| s.email("acc1", id).map(|e| e.mailbox_ids.iter().cloned().collect()))
}

fn ms(t: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(t).unwrap().timestamp_millis()
}

fn row_ids(items: &[ListedMsg]) -> Vec<String> {
    items.iter().map(|r| r.graph_id.clone().unwrap_or_default()).collect()
}

/// The bodies of every API request that carried `method`.
fn bodies_with(m: &MockJmap, method: &str) -> Vec<String> {
    m.requests().into_iter().filter(|r| r.calls.iter().any(|c| c == method)).map(|r| r.body).collect()
}

/// A message with Message-ID `<message_id>` received on 2026-10-05.
fn with_message_id(id: &str, message_id: &str) -> ScenarioEmail {
    ScenarioEmail {
        id: id.into(),
        raw: format!("Message-ID: <{message_id}>\r\nSubject: {id}\r\n\r\nbody of {id}"),
        keywords: vec![],
        received_at: "2026-10-05T10:00:00Z".into(),
        also_in: vec![],
    }
}

// ── folders and listing ─────────────────────────────────────────────────────

#[tokio::test]
async fn folders_use_the_mailbox_path_and_the_role() {
    let mut s = common_jmap::scenario();
    let extra = |id: &str, name: &str, role: &str| ScenarioMailbox {
        id: id.into(),
        name: name.into(),
        parent_id: None,
        role: Some(role.into()),
        emails: vec![],
    };
    s.accounts[0].mailboxes.push(extra("mb-junk", "Spam", "junk"));
    s.accounts[0].mailboxes.push(extra("mb-all", "All Mail", "all"));
    let m = MockJmap::start(s);
    let mut o = ops(&m);
    let folders = o.folders().await.unwrap();
    let by = |p: &str| folders.iter().find(|f| f.path == p).cloned().unwrap_or_else(|| panic!("no folder {p}"));
    assert_eq!(by("INBOX").graph_id.as_deref(), Some("mb-inbox"), "the folder's id is the JMAP mailbox id");
    assert_eq!(by("INBOX").name, "Inbox");
    assert_eq!(by("INBOX").role, FolderRole::Normal);
    assert_eq!(by("Work/Sub").graph_id.as_deref(), Some("mb-sub"));
    assert_eq!(by("Trash").role, FolderRole::Trash);
    assert_eq!(by("Spam").role, FolderRole::Spam);
    assert_eq!(by("All Mail").role, FolderRole::AllMail);
    assert!(folders.iter().all(|f| f.selectable));
    let trash = o.trash().await.unwrap().expect("a Trash mailbox");
    assert_eq!(trash.graph_id.as_deref(), Some("mb-trash"));
    assert_eq!(m.count_calls("Mailbox/get"), 1, "trash() reuses the folder listing");
    let caps = o.caps().await.unwrap();
    assert!(caps.move_cmd && caps.uidplus && !caps.gmail_ext);
    assert_eq!(o.uid_validity(&trash).await.unwrap(), None);
    assert_eq!(o.provider(), Provider::Jmap);
}

#[tokio::test]
async fn list_page_through_the_ops_gives_ledgerless_rows_and_a_position_cursor() {
    let m = start();
    let mut o = ops(&m).with_page_size(1);
    let f = inbox();
    let p1 = o.list_page(&f, None).await.unwrap();
    assert_eq!(p1.uid_validity, None);
    assert_eq!(p1.items.len(), 1);
    let r = &p1.items[0];
    assert_eq!(r.uid, 0, "uids come from the ledger at plan freeze");
    assert_eq!(r.graph_id.as_deref(), Some("e2"), "newest first");
    assert_eq!(r.message_id.as_deref(), Some("e2@x"));
    assert_eq!(r.size as usize, E2_RAW.len());
    assert_eq!(r.internal_ms, ms("2026-10-02T10:00:00Z"));
    assert_eq!(p1.next.as_deref(), Some("1"));
    let p2 = o.list_page(&f, p1.next).await.unwrap();
    assert_eq!(row_ids(&p2.items), vec!["e1"]);
    assert!(p2.next.is_none(), "the total is reached");
}

#[tokio::test]
async fn an_arrival_between_pages_is_not_listed_twice() {
    let m = start();
    let mut o = ops(&m).with_page_size(1);
    let f = inbox();
    let p1 = o.list_page(&f, None).await.unwrap();
    assert_eq!(row_ids(&p1.items), vec!["e2"]);
    // e4 arrives on top: position 1 is e2 again.
    m.mutate(|s| s.add_email("acc1", "mb-inbox", common_jmap::email("e4", "four", "2026-10-04T10:00:00Z")));
    let p2 = o.list_page(&f, p1.next).await.unwrap();
    assert!(p2.items.is_empty(), "e2 was already listed: a second row would fail the plan freeze");
    assert_eq!(p2.next.as_deref(), Some("2"));
    let p3 = o.list_page(&f, p2.next).await.unwrap();
    assert_eq!(row_ids(&p3.items), vec!["e1"]);
    assert!(p3.next.is_none());
    // A listing from the start lists everything, each once.
    let mut all = Vec::new();
    let mut cursor = None;
    loop {
        let p = o.list_page(&f, cursor).await.unwrap();
        all.extend(row_ids(&p.items));
        match p.next {
            Some(n) => cursor = Some(n),
            None => break,
        }
    }
    assert_eq!(all, vec!["e4", "e2", "e1"]);
}

// ── fetch, present, move ────────────────────────────────────────────────────

#[tokio::test]
async fn fetch_returns_the_message_and_its_flags_and_counts_its_bytes_once() {
    let m = start();
    let mut o = ops(&m);
    let f = inbox();
    let got = o.fetch(&f, &listed(5, "e1", Some("e1@x"))).await.unwrap();
    assert_eq!(got.raw, E1_RAW.as_bytes());
    assert_eq!(got.flags, vec!["\\Seen".to_string()], "the keywords, as IMAP flags");
    assert_eq!(got.message_id.as_deref(), Some("e1@x"));
    assert_eq!(o.uncounted_bytes(), E1_RAW.len() as u64);
    assert_eq!(o.uncounted_bytes(), 0, "reading the tally resets it");
    // Gone from the server, or no longer in this folder: Gone, not an error to retry.
    match o.fetch(&f, &listed(6, "missing", None)).await {
        Err(OpsError::Gone) => {}
        other => panic!("expected Gone, got {other:?}"),
    }
    match o.fetch(&f, &listed(7, "e3", None)).await {
        Err(OpsError::Gone) => {}
        other => panic!("e3 is in Work/Sub, not INBOX: expected Gone, got {other:?}"),
    }
    assert_eq!(o.uncounted_bytes(), 0);
}

#[tokio::test]
async fn present_asks_the_server_and_treats_an_unknown_uid_as_present() {
    let m = start();
    let mut o = ops(&m);
    o.remember("INBOX", [(1, "e1".to_string()), (2, "e3".to_string()), (3, "gone".to_string())]);
    let mut got = o.present(&inbox(), &[1, 2, 3, 99]).await.unwrap();
    got.sort_unstable();
    // 2 lives in another mailbox and 3 is gone; 99 has no known id, so it is
    // assumed still there.
    assert_eq!(got, vec![1, 99]);
}

#[tokio::test]
async fn move_to_trash_follows_the_label_rule() {
    let m = start();
    let mut o = ops(&m);
    let msgs = vec![listed(11, "e1", Some("e1@x")), listed(12, "e2", Some("e2@x")), listed(13, "missing", None)];
    let r = o.move_to_trash(&inbox(), &msgs, &trash(), None).await.unwrap();
    // e1 also sits in Work: only its INBOX label came off. Both left INBOX;
    // the missing one did not move, so the engine keeps it.
    assert_eq!(r.moved, vec![11, 12]);
    assert_eq!(r.graph_new_ids, Some(vec![(12, "e2".to_string())]), "only e2 reached Trash, under its own id");
    assert!(r.trash_uids.is_none(), "Trash uids are found by Message-ID, so a restart loses nothing");
    assert_eq!(labels(&m, "e1"), Some(vec!["mb-work".to_string()]));
    assert_eq!(labels(&m, "e2"), Some(vec!["mb-trash".to_string()]));
    assert_eq!(m.count_calls("Email/set"), 2, "one patch per email that moved");
    assert!(bodies_with(&m, "Email/set").iter().all(|b| !b.contains("\"destroy\"")), "a move never destroys");
}

// ── emptying Trash ──────────────────────────────────────────────────────────

#[tokio::test]
async fn find_in_trash_keeps_a_duplicate_visible_and_present_follows_its_uids() {
    let m = start();
    m.mutate(|s| {
        s.set_mailboxes("acc1", "e2", &["mb-trash"]);
        s.add_email("acc1", "mb-trash", with_message_id("d1", "dup@x"));
        s.add_email("acc1", "mb-trash", with_message_id("d2", "dup@x"));
        // Contains "dup@x" but is another Message-ID: the header filter may
        // match it, the answer must not.
        s.add_email("acc1", "mb-trash", with_message_id("d3", "predup@x"));
        // The same Message-ID outside Trash is no Trash hit.
        s.add_email("acc1", "mb-inbox", with_message_id("d4", "dup@x"));
    });
    let mut o = ops(&m);
    let t = trash();
    let ids = vec!["e2@x".to_string(), "dup@x".to_string(), "none@x".to_string()];
    let found = o.find_in_trash(&t, &ids).await.unwrap();
    let of = |id: &str| found.iter().filter(|(k, _)| k == id).map(|(_, u)| *u).collect::<Vec<u32>>();
    assert_eq!(of("e2@x").len(), 1);
    assert_eq!(of("dup@x").len(), 2, "a duplicate stays visible so the engine keeps it; the lookalike is not one");
    assert!(of("none@x").is_empty());
    let mut all: Vec<u32> = found.iter().map(|(_, u)| *u).collect();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), 3, "each Trash hit gets its own uid");
    assert!(all.iter().all(|u| *u >= 0x8000_0000), "synthetic uids sit above any ledger uid");
    assert_eq!(o.present(&t, &of("e2@x")).await.unwrap(), of("e2@x"));
}

#[tokio::test]
async fn expunge_exact_destroys_exactly_the_given_ids_and_only_when_the_message_id_matches() {
    let m = start();
    m.mutate(|s| {
        for id in ["ta", "tb", "tu"] {
            s.add_email("acc1", "mb-trash", common_jmap::email(id, id, "2026-10-05T10:00:00Z"));
        }
    });
    let mut o = ops(&m);
    let t = trash();
    o.remember("Trash", [(7, "ta".to_string()), (8, "tb".to_string()), (9, "tc-gone".to_string()), (10, "tu".to_string())]);
    let expect = vec![(7, "ta@x".to_string()), (8, "b@x".to_string()), (9, "tc@x".to_string()), (99, "z@x".to_string())];
    let done = o.expunge_exact(&t, &[7, 8, 9, 99], &expect, None).await.unwrap();
    // 8 now holds another Message-ID: refused. 9 is already gone: done. 99
    // has no known id.
    assert_eq!(done, vec![7, 9]);
    assert_eq!(labels(&m, "ta"), None, "ta was in Trash only: destroyed");
    assert!(labels(&m, "tb").is_some(), "a Message-ID that does not match is never deleted");
    assert!(labels(&m, "tu").is_some(), "an id that was not asked for is never touched");
    let sets = bodies_with(&m, "Email/set");
    assert_eq!(sets.len(), 1, "{sets:?}");
    assert!(sets[0].contains(r#""destroy":["ta"]"#), "{}", sets[0]);
}

#[tokio::test]
async fn expunge_takes_only_the_trash_label_off_an_email_another_mailbox_holds() {
    let m = start();
    // e1 in Work and Trash.
    m.mutate(|s| s.set_mailboxes("acc1", "e1", &["mb-work", "mb-trash"]));
    let mut o = ops(&m);
    o.remember("Trash", [(4, "e1".to_string())]);
    let done = o.expunge_exact(&trash(), &[4], &[(4, "e1@x".to_string())], None).await.unwrap();
    assert_eq!(done, vec![4], "out of Trash: nothing left to empty");
    assert_eq!(labels(&m, "e1"), Some(vec!["mb-work".to_string()]), "the Work copy survives");
    assert!(bodies_with(&m, "Email/set").iter().all(|b| !b.contains("\"destroy\"")));
}

#[tokio::test]
async fn expunge_exact_propagates_a_throttle_so_the_retry_finishes_the_rest() {
    let m = start();
    m.mutate(|s| s.set_mailboxes("acc1", "e2", &["mb-trash"]));
    let mut o = ops(&m);
    let t = trash();
    o.remember("Trash", [(1, "e2".to_string())]);
    // Signed in first, so the throttle lands on the expunge's own request.
    o.trash().await.unwrap();
    m.mutate(|s| s.faults.push(Fault::RateLimited { retry_after_secs: 3 }));
    match o.expunge_exact(&t, &[1], &[(1, "e2@x".to_string())], None).await {
        Err(OpsError::Throttled { retry_after_secs: Some(3), .. }) => {}
        other => panic!("expected a throttle with retry_after 3, got {other:?}"),
    }
    assert!(labels(&m, "e2").is_some(), "nothing was deleted");
    assert_eq!(o.expunge_exact(&t, &[1], &[(1, "e2@x".to_string())], None).await.unwrap(), vec![1]);
    assert_eq!(labels(&m, "e2"), None);
}

#[tokio::test]
async fn remember_plan_lets_present_and_expunge_find_messages_this_run_never_fetched() {
    let m = start();
    m.mutate(|s| s.set_mailboxes("acc1", "e2", &["mb-trash"]));
    let plan = FolderPlan {
        version: 1,
        path: "Trash".into(),
        graph_folder_id: Some("mb-trash".into()),
        uid_validity: None,
        uids: vec![4, 5],
        internal_ms: vec![0, 0],
        sizes: vec![0, 0],
        message_ids: vec![None, None],
        gm_msgids: None,
        graph_ids: Some(vec!["e2".into(), "gone".into()]),
    };
    let mut o = ops(&m);
    o.remember_plan(&plan);
    let t = trash();
    assert_eq!(o.present(&t, &[4, 5]).await.unwrap(), vec![4], "5 was looked up and is gone, not assumed present");
    let done = o.expunge_exact(&t, &[4], &[(4, "e2@x".to_string())], None).await.unwrap();
    assert_eq!(done, vec![4]);
    assert_eq!(labels(&m, "e2"), None);
}

#[tokio::test]
async fn a_refusal_a_retry_cannot_fix_reports_what_is_already_deleted() {
    let m = start();
    m.mutate(|s| {
        for id in ["rb", "rc"] {
            s.add_email("acc1", "mb-trash", common_jmap::email(id, id, "2026-10-05T10:00:00Z"));
        }
    });
    let mut o = ops(&m);
    let t = trash();
    o.remember("Trash", [(1, "ra-gone".to_string()), (2, "rb".to_string()), (3, "rc".to_string())]);
    m.mutate(|s| s.faults.push(Fault::ServerFail { method: "Email/set".into() }));
    let expect = vec![(1, "ra-gone@x".to_string()), (2, "rb@x".to_string()), (3, "rc@x".to_string())];
    // uid 1 is already gone (done), uid 2 is refused: the answer keeps uid 1
    // as done instead of an Err that would count it as kept.
    let done = o.expunge_exact(&t, &[1, 2, 3], &expect, None).await.unwrap();
    assert_eq!(done, vec![1]);
    let sets = bodies_with(&m, "Email/set");
    assert_eq!(sets.len(), 1, "it stops at the refusal: {sets:?}");
    assert!(sets[0].contains("rb") && !sets[0].contains("rc"), "{}", sets[0]);
    assert!(labels(&m, "rb").is_some() && labels(&m, "rc").is_some());
}

#[tokio::test]
async fn find_in_trash_asks_with_the_bare_message_id() {
    let m = start();
    m.mutate(|s| s.set_mailboxes("acc1", "e2", &["mb-trash"]));
    let mut o = ops(&m);
    let found = o.find_in_trash(&trash(), &["<e2@x>".to_string(), "missing@x".to_string()]).await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, "<e2@x>", "answered under the id the engine asked with");
    let queries = bodies_with(&m, "Email/query");
    assert_eq!(queries.len(), 2, "one query per id: {queries:?}");
    assert!(queries[0].contains(r#""header":["Message-ID","e2@x"]"#), "{}", queries[0]);
    assert!(queries[0].contains(r#""inMailbox":"mb-trash""#), "{}", queries[0]);
}

// ── errors and credentials ──────────────────────────────────────────────────

#[tokio::test]
async fn a_401_is_a_sign_in_signal_and_the_password_never_reaches_the_error() {
    let m = start();
    let mut o = JmapOps::new(config(&m.session_url(), Some("wrong-SECRET-pw")));
    let f = inbox();
    match o.fetch(&f, &listed(1, "e1", None)).await {
        Err(OpsError::SignIn(t)) => {
            assert!(!t.contains("wrong-SECRET-pw"), "password leaked: {t}");
            assert!(t.starts_with("E_JMAP_AUTH"), "{t}");
        }
        other => panic!("expected SignIn, got {other:?}"),
    }
    // The keychain's fixed credentials reach the next run: it signs in again.
    o.set_config(config(&m.session_url(), Some("pw")));
    assert_eq!(o.fetch(&f, &listed(1, "e1", None)).await.unwrap().raw, E1_RAW.as_bytes());

    // A session the server stops accepting is dropped: the next call opens a new one.
    let sessions = |m: &MockJmap| m.requests().iter().filter(|r| r.path.starts_with("/jmap/session")).count();
    let before = sessions(&m);
    m.mutate(|s| s.faults.push(Fault::Unauthorized));
    assert!(matches!(o.fetch(&f, &listed(1, "e1", None)).await, Err(OpsError::SignIn(_))));
    m.mutate(|s| s.faults.retain(|x| x != &Fault::Unauthorized));
    assert!(o.fetch(&f, &listed(1, "e1", None)).await.is_ok());
    assert_eq!(sessions(&m), before + 1, "one new session after the 401");
}

#[tokio::test]
async fn a_429_carries_retry_after() {
    let m = start();
    let mut o = ops(&m);
    o.trash().await.unwrap();
    m.mutate(|s| s.faults.push(Fault::RateLimited { retry_after_secs: 42 }));
    match o.fetch(&inbox(), &listed(1, "e1", None)).await {
        Err(OpsError::Throttled { retry_after_secs: Some(42), .. }) => {}
        other => panic!("expected Throttled with retry_after 42, got {other:?}"),
    }
}

#[tokio::test]
async fn an_unreachable_server_is_waited_out_not_counted_against_a_message() {
    mailvault_core::jmap::base::allow_loopback_for_tests();
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut o = JmapOps::new(config(&format!("http://127.0.0.1:{port}/jmap/session"), Some("pw")));
    match o.fetch(&inbox(), &listed(1, "e1", None)).await {
        Err(OpsError::Throttled { .. }) => {}
        other => panic!("expected a throttle to wait out, got {other:?}"),
    }
}

#[tokio::test]
async fn missing_credentials_are_refused_before_any_request() {
    let m = start();
    let mut o = JmapOps::new(config(&m.session_url(), None));
    match o.fetch(&inbox(), &listed(1, "e1", None)).await {
        Err(OpsError::SignIn(t)) => assert!(t.starts_with("E_JMAP_AUTH"), "{t}"),
        other => panic!("expected SignIn, got {other:?}"),
    }
    assert!(m.requests().is_empty(), "no request may leave without credentials");
}

#[test]
fn classify_jmap_reads_the_typed_error() {
    assert_eq!(classify_jmap(&JmapError::Unauthorized), (Signal::SignIn, None));
    assert_eq!(classify_jmap(&JmapError::RateLimited { retry_after: Some(7) }), (Signal::Throttled, Some(7)));
    assert_eq!(classify_jmap(&JmapError::RateLimited { retry_after: None }), (Signal::Throttled, None));
    let method = |kind: &str| JmapError::Method { kind: kind.into(), description: None };
    assert_eq!(classify_jmap(&method("serverUnavailable")), (Signal::Throttled, None));
    assert_eq!(classify_jmap(&method("serverFail")), (Signal::Other, None));
    assert_eq!(classify_jmap(&JmapError::Transport("operation timed out".into())), (Signal::Timeout, None));
    assert_eq!(classify_jmap(&JmapError::Transport("error sending request: connection refused".into())), (Signal::ConnectionLost, None));
    assert_eq!(classify_jmap(&JmapError::Protocol("HTTP 500".into())), (Signal::Other, None));
    assert_eq!(classify_jmap(&JmapError::CannotCalculateChanges), (Signal::Other, None));
    assert_eq!(classify_jmap(&JmapError::ForeignHost { host: "evil.test".into() }), (Signal::Other, None));
    assert!(matches!(
        OpsError::from_jmap(&JmapError::RateLimited { retry_after: Some(7) }),
        OpsError::Throttled { retry_after_secs: Some(7), .. }
    ));
    assert!(matches!(OpsError::from_jmap(&JmapError::Unauthorized), OpsError::SignIn(_)));
    let t = OpsError::from_jmap(&JmapError::Method { kind: "forbidden".into(), description: Some("no access for alice@example.test".into()) })
        .text();
    assert!(t.starts_with("E_JMAP_METHOD: forbidden"), "{t}");
    assert!(!t.contains("alice@example.test"), "an address in a server's words is masked: {t}");
}

// ── no Trash (ruling R5) ────────────────────────────────────────────────────

#[tokio::test]
async fn an_account_without_trash_offers_no_trash_and_the_refusal_is_typed() {
    let mut s = common_jmap::scenario();
    s.accounts[0].mailboxes.retain(|mb| mb.id != "mb-trash");
    let m = MockJmap::start(s);
    let mut o = ops(&m);
    assert!(o.trash().await.unwrap().is_none(), "no Trash: the engine refuses every delete");
    // Even handed a Trash folder with no mailbox id, nothing is sent.
    let no_id = FolderInfo { graph_id: None, ..trash() };
    assert!(matches!(o.move_to_trash(&inbox(), &[listed(12, "e2", None)], &no_id, None).await, Err(OpsError::Other(_))));
    assert_eq!(m.count_calls("Email/set"), 0);
    assert_eq!(labels(&m, "e2"), Some(vec!["mb-inbox".to_string()]), "untouched, never destroyed");
    // The typed refusal counts against the message; it is never a wait.
    assert_eq!(classify_jmap(&JmapError::NoTrash), (Signal::Other, None));
    match OpsError::from_jmap(&JmapError::NoTrash) {
        OpsError::Other(t) => assert!(t.starts_with("E_JMAP_NO_TRASH"), "{t}"),
        other => panic!("expected Other, got {other:?}"),
    }
}

// ── archive and delete of INBOX, e1 also in Work ────────────────────────────

/// The job's server calls in order for INBOX: list, fetch, move, find in
/// Trash, check, expunge. e1 also carries the Work label, so it never goes to
/// Trash and is never destroyed: it ends up in Work and nowhere else.
#[tokio::test]
async fn archive_and_delete_of_inbox_leaves_e1_in_work_and_nowhere_else() {
    let m = start();
    let mut o = ops(&m);
    let f = inbox();
    let t = o.trash().await.unwrap().expect("a Trash mailbox");
    let page = o.list_page(&f, None).await.unwrap();
    assert!(page.next.is_none());
    // The plan freeze hands out uids 1 and 2.
    let msgs: Vec<ListedMsg> =
        page.items.iter().enumerate().map(|(k, r)| ListedMsg { uid: k as u32 + 1, ..r.clone() }).collect();
    assert_eq!(row_ids(&msgs), vec!["e2", "e1"]);
    for msg in &msgs {
        assert!(!o.fetch(&f, msg).await.unwrap().raw.is_empty());
    }
    let moved = o.move_to_trash(&f, &msgs, &t, None).await.unwrap();
    assert_eq!(moved.moved, vec![1, 2]);
    let wanted: Vec<String> = msgs.iter().map(|r| r.message_id.clone().unwrap()).collect();
    let found = o.find_in_trash(&t, &wanted).await.unwrap();
    assert_eq!(found.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), vec!["e2@x"], "e1 never reached Trash");
    let tuids: Vec<u32> = found.iter().map(|(_, u)| *u).collect();
    assert_eq!(o.present(&t, &tuids).await.unwrap(), tuids);
    let expect: Vec<(u32, String)> = found.iter().map(|(id, u)| (*u, id.clone())).collect();
    assert_eq!(o.expunge_exact(&t, &tuids, &expect, None).await.unwrap(), tuids);
    assert_eq!(labels(&m, "e1"), Some(vec!["mb-work".to_string()]), "e1 is still in Work, and nowhere else");
    assert_eq!(labels(&m, "e2"), None, "e2 was in INBOX only: destroyed");
    assert!(m.read(|s| s.emails_in("acc1", "mb-inbox").is_empty() && s.emails_in("acc1", "mb-trash").is_empty()));
    assert_eq!(labels(&m, "e3"), Some(vec!["mb-sub".to_string()]), "another folder is never touched");
}
