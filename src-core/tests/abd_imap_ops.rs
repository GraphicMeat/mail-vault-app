//! The IMAP half of the Archive & delete job (`abd::imap_ops::ImapOps`) against
//! the mock server: listing, moves that keep their COPYUID, exact expunges,
//! the refusals, Gmail's label model, reconnecting, and the vault plumbing the
//! job stores through (`archive::store_archived` + `maildir::verify_listed`).
//! The last group runs the whole engine (`plan_job` + `run`) over `ImapOps`.

mod abd_fake;
mod common;

use abd_fake::{ms, start_ms, year_bounds, FakeEnv, FakeLocal, Shared};
use common::{config_for, pool};
use mailvault_core::abd::imap_ops::{build_preview, ImapOps};
use mailvault_core::abd::*;
use mailvault_core::archive::{self, ArchiveCtx, ArchiveGate, ArchiveSinks};
use mailvault_core::imap::ImapPool;
use mailvault_core::vault_registry::VaultRegistry;
use mailvault_core::{maildir, vault_files};
use mock_imap::state::{synthetic_mailbox_with, Mailbox, Message};
use mock_imap::{Action, GmailMsg, MockImap, Scenario, Trigger};
use std::collections::HashMap;
use std::sync::Arc;

// ── helpers ─────────────────────────────────────────────────────────────────

fn msg(id: &str) -> String {
    format!("From: a@example.com\r\nTo: b@example.com\r\nSubject: {id}\r\nMessage-ID: <{id}@t.test>\r\n\r\nbody of {id}\r\n")
}

fn ops_for(server: &MockImap) -> ImapOps {
    ImapOps::new(Arc::new(pool()), config_for(server))
}

fn info(path: &str, role: FolderRole) -> FolderInfo {
    FolderInfo { path: path.to_string(), name: path.to_string(), role, graph_id: None, selectable: true }
}

fn listed(uid: u32) -> ListedMsg {
    ListedMsg { uid, ..Default::default() }
}

/// A mailbox whose message `i` (uid `i`) has Message-ID `<ids[i-1]@t.test>`.
fn mailbox_of(name: &str, ids: &[&str]) -> Mailbox {
    let mut mb = Mailbox::new(name);
    for (i, id) in ids.iter().enumerate() {
        mb.add(Message::new(i as u32 + 1, msg(id)));
    }
    mb
}

fn trash_box() -> Mailbox {
    Mailbox::new("Trash").with_attrs(&["\\HasNoChildren", "\\Trash"])
}

fn uids(server: &MockImap, mailbox: &str) -> Vec<u32> {
    server.state().find(mailbox).unwrap().messages.iter().map(|m| m.uid).collect()
}

fn gm_ids(server: &MockImap, mailbox: &str) -> Vec<u64> {
    server.state().find(mailbox).unwrap().messages.iter().map(|m| m.gm_msgid.unwrap()).collect()
}

/// Three messages in INBOX (a, b, c) and an empty Trash.
fn small_server() -> MockImap {
    MockImap::start(Scenario::new().mailbox(mailbox_of("INBOX", &["a", "b", "c"])).mailbox(trash_box()))
}

/// 111 in INBOX and Work, 222 in Work only, 333 with no label, 444 only starred
/// as important (a system label that says nothing about where it was filed).
fn gmail_server() -> MockImap {
    MockImap::start(
        Scenario::gmail()
            .gmail_message(GmailMsg::new(msg("one")).labels(&["\\Inbox", "Work"]).gm_msgid(111))
            .gmail_message(GmailMsg::new(msg("two")).labels(&["Work"]).gm_msgid(222))
            .gmail_message(GmailMsg::new(msg("three")).gm_msgid(333))
            .gmail_message(GmailMsg::new(msg("four")).labels(&["\\Important"]).gm_msgid(444)),
    )
}

const ALL_MAIL: &str = "[Gmail]/All Mail";

// ── listing ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn lists_internaldate_and_size_in_bounded_pages() {
    // 2024-12-31T22:30:00Z, stamped in two different zones by turns.
    let base = 1_735_684_200_000i64;
    let mb = synthetic_mailbox_with("Big", 4500, |i, m| {
        m.with_internal_at(base + i as i64 * 1000, if i % 2 == 0 { 120 } else { -300 })
    });
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let mut ops = ops_for(&server);
    let folder = info("Big", FolderRole::Normal);

    let mut pages: Vec<ListPage> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = ops.list_page(&folder, cursor.take()).await.expect("page");
        let next = page.next.clone();
        pages.push(page);
        match next {
            Some(n) => cursor = Some(n),
            None => break,
        }
    }

    let lens: Vec<usize> = pages.iter().map(|p| p.items.len()).collect();
    assert_eq!(lens, vec![2000, 2000, 500]);
    assert_eq!(pages[0].next.as_deref(), Some("2000"));
    assert_eq!(pages[1].next.as_deref(), Some("4000"));
    assert!(pages[2].next.is_none());
    for p in &pages {
        assert_eq!(p.uid_validity, Some(1));
    }

    let st = server.state();
    let mb = st.find("Big").unwrap();
    for (i, m) in pages.iter().flat_map(|p| p.items.iter()).enumerate() {
        let n = i as i64 + 1;
        assert_eq!(m.uid as i64, n);
        // The instant, whatever zone the server stamped it in.
        assert_eq!(m.internal_ms, base + n * 1000, "uid {n}");
        assert_eq!(m.size as usize, mb.by_uid(m.uid).unwrap().raw.len(), "uid {n}");
        assert!(m.gm_msgid.is_none() && m.unlabelled.is_none() && m.message_id.is_none());
    }
    // The uid list was read once, not once per page; one FETCH per page.
    assert_eq!(server.count_commands("1:*"), 1);
    assert_eq!(server.count_commands("INTERNALDATE"), 3);
}

#[tokio::test]
async fn a_second_page_of_a_reissued_folder_fails_instead_of_mixing_generations() {
    let mb = synthetic_mailbox_with("Big", 2100, |_, m| m);
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let mut ops = ops_for(&server);
    let folder = info("Big", FolderRole::Normal);
    let first = ops.list_page(&folder, None).await.expect("first page");
    assert_eq!(first.items.len(), 2000);
    server.mutate(|st| st.find_mut("Big").unwrap().uid_validity = 77);
    let err = ops.list_page(&folder, first.next).await.expect_err("the folder was reissued");
    assert!(err.text().contains("UIDVALIDITY"), "{err:?}");
}

#[tokio::test]
async fn a_poisoned_row_never_yields_a_short_listing() {
    let mb = synthetic_mailbox_with("Big", 120, |_, m| m);
    let server = MockImap::start(Scenario::new().mailbox(mb).fault(Trigger::on("FETCH"), Action::PoisonFetchUid(60)));
    let mut ops = ops_for(&server);
    let folder = info("Big", FolderRole::Normal);
    // The uid list itself (`1:*`) is a FETCH too, so it is poisoned as well:
    // whatever step meets the bad row must fail, never return a short listing.
    let r = ops.list_page(&folder, None).await;
    assert!(r.is_err(), "a short listing must never come back as Ok: {:?}", r.map(|p| p.items.len()));
}

#[tokio::test]
async fn message_ids_for_a_uid_set() {
    let mut mb = mailbox_of("INBOX", &["a", "b", "c", "d"]);
    mb.add(Message::new(5, "Subject: no id\r\n\r\nbody\r\n"));
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let mut ops = ops_for(&server);
    let got: HashMap<u32, Option<String>> = ops
        .message_ids(&info("INBOX", FolderRole::Normal), &[1, 3, 5])
        .await
        .expect("ids")
        .into_iter()
        .collect();
    assert_eq!(got.len(), 3);
    assert_eq!(got[&1].as_deref(), Some("a@t.test"));
    assert_eq!(got[&3].as_deref(), Some("c@t.test"));
    assert_eq!(got[&5], None, "a message with no Message-ID answers None");
}

#[tokio::test]
async fn uid_validity_is_read_from_a_select() {
    let server = MockImap::start(Scenario::new().mailbox(mailbox_of("INBOX", &["a"]).with_uid_validity(4242)));
    let mut ops = ops_for(&server);
    assert_eq!(ops.uid_validity(&info("INBOX", FolderRole::Normal)).await.unwrap(), Some(4242));
}

// ── Gmail ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn gmail_is_detected_and_its_folders_get_their_roles() {
    let server = gmail_server();
    let mut ops = ops_for(&server).with_gmail_host(true);
    assert_eq!(ops.detect().await.unwrap(), Provider::Gmail);
    assert_eq!(ops.provider(), Provider::Gmail);
    let folders = ops.folders().await.unwrap();
    let role_of = |path: &str| folders.iter().find(|f| f.path == path).map(|f| f.role);
    assert_eq!(role_of(ALL_MAIL), Some(FolderRole::AllMail));
    assert_eq!(role_of("[Gmail]/Trash"), Some(FolderRole::Trash));
    assert_eq!(role_of("[Gmail]/Spam"), Some(FolderRole::Spam));
    assert_eq!(role_of("Work"), Some(FolderRole::Normal));
    assert!(!folders.iter().find(|f| f.path == "[Gmail]").unwrap().selectable, "[Gmail] is a container");
    assert_eq!(folders[0].path, "INBOX", "INBOX first");
    assert_eq!(ops.trash().await.unwrap().unwrap().path, "[Gmail]/Trash");
}

#[tokio::test]
async fn a_host_that_is_not_gmail_is_not_gmail_mode_even_with_all_mail() {
    let server = gmail_server();
    // 127.0.0.1 is not a Google host and there is no override.
    let mut ops = ops_for(&server);
    assert_eq!(ops.detect().await.unwrap(), Provider::Imap);
    let folders = ops.folders().await.unwrap();
    assert_eq!(folders.iter().find(|f| f.path == ALL_MAIL).unwrap().role, FolderRole::Normal);
    let page = ops.list_page(&info(ALL_MAIL, FolderRole::Normal), None).await.unwrap();
    assert!(page.items.iter().all(|m| m.gm_msgid.is_none() && m.unlabelled.is_none()));
    assert_eq!(server.count_commands("X-GM"), 0, "no Gmail item is asked of a server not treated as Gmail");
}

#[tokio::test]
async fn lists_gm_msgid_and_label_emptiness_on_gmail() {
    let server = gmail_server();
    let mut ops = ops_for(&server).with_gmail_host(true);
    ops.detect().await.unwrap();

    let all = ops.list_page(&info(ALL_MAIL, FolderRole::AllMail), None).await.unwrap();
    let rows: Vec<(u32, Option<u64>, Option<bool>)> =
        all.items.iter().map(|m| (m.uid, m.gm_msgid, m.unlabelled)).collect();
    assert_eq!(
        rows,
        vec![
            (1, Some(111), Some(false)),
            (2, Some(222), Some(false)),
            (3, Some(333), Some(true)),
            (4, Some(444), Some(true)), // \Important alone is not a filing
        ]
    );

    // A label folder carries the id, and no emptiness (only All Mail is judged).
    let work = ops.list_page(&info("Work", FolderRole::Normal), None).await.unwrap();
    assert_eq!(work.items.iter().map(|m| m.gm_msgid).collect::<Vec<_>>(), vec![Some(111), Some(222)]);
    assert!(work.items.iter().all(|m| m.unlabelled.is_none()));
}

#[tokio::test]
async fn the_preview_keeps_all_mail_apart_on_gmail() {
    let server = gmail_server();
    let mut ops = ops_for(&server).with_gmail_host(true);
    let mut seen: Vec<(String, usize)> = Vec::new();
    let p = build_preview(&mut ops, "p1", 5, &mut |f, n| seen.push((f.to_string(), n))).await.unwrap();
    assert_eq!(p.provider, Provider::Gmail);
    assert!(p.caps.gmail_ext && p.caps.uidplus && p.caps.move_cmd);
    let (all_mail, validity, rows) = p.all_mail.as_ref().expect("All Mail listed");
    assert_eq!((all_mail.path.as_str(), *validity, rows.len()), (ALL_MAIL, 1, 4));
    assert!(p.folders.iter().all(|(f, _, _)| f.path != ALL_MAIL));
    let paths: Vec<&str> = p.folders.iter().map(|(f, _, _)| f.path.as_str()).collect();
    assert!(paths.contains(&"INBOX") && paths.contains(&"Work") && paths.contains(&"[Gmail]/Trash"), "{paths:?}");
    assert!(!paths.contains(&"[Gmail]"), "a container is not listed");
    assert_eq!(p.trash.as_ref().unwrap().path, "[Gmail]/Trash");
    assert_eq!(p.listed_at_ms, 5);
    assert!(seen.iter().any(|(f, n)| f == ALL_MAIL && *n == 4));
}

#[tokio::test]
async fn gmail_move_to_trash_removes_all_copies() {
    let server = gmail_server();
    let mut ops = ops_for(&server).with_gmail_host(true);
    ops.detect().await.unwrap();
    let folders = ops.folders().await.unwrap();
    let all_mail = folders.iter().find(|f| f.role == FolderRole::AllMail).unwrap().clone();
    let trash = ops.trash().await.unwrap().unwrap();

    // The All Mail uid of message 111, by X-GM-MSGID.
    assert_eq!(ops.locate(&all_mail, Some(111), None).await.unwrap(), vec![1]);
    let r = ops.move_to_trash(&all_mail, &[listed(1)], &trash).await.unwrap();
    assert_eq!(r.moved, vec![1]);
    assert_eq!(r.trash_uids, Some(vec![1]));
    assert_eq!(r.trash_validity, Some(1));

    assert!(uids(&server, "INBOX").is_empty(), "the INBOX label copy went with it");
    assert_eq!(gm_ids(&server, "Work"), vec![222]);
    assert_eq!(gm_ids(&server, ALL_MAIL), vec![222, 333, 444]);
    assert_eq!(gm_ids(&server, "[Gmail]/Trash"), vec![111]);
}

#[tokio::test]
async fn locate_falls_back_to_the_message_id_when_the_gm_msgid_is_gone() {
    let server = gmail_server();
    let mut ops = ops_for(&server).with_gmail_host(true);
    ops.detect().await.unwrap();
    let all_mail = info(ALL_MAIL, FolderRole::AllMail);
    assert_eq!(ops.locate(&all_mail, Some(999), Some("<one@t.test>")).await.unwrap(), vec![1]);
    assert_eq!(ops.locate(&all_mail, Some(999), None).await.unwrap(), Vec::<u32>::new());
    assert_eq!(ops.locate(&all_mail, None, Some("two@t.test")).await.unwrap(), vec![2]);
}

// ── moving ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn move_to_trash_returns_copyuid_trash_uids() {
    let mut trash = trash_box();
    trash.add(Message::new(1, msg("x")));
    trash.add(Message::new(2, msg("y")));
    let server = MockImap::start(
        Scenario::new().mailbox(mailbox_of("INBOX", &["a", "b", "c", "d", "e"])).mailbox(trash),
    );
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().expect("a Trash");
    assert_eq!(trash.role, FolderRole::Trash);

    let r = ops
        .move_to_trash(&info("INBOX", FolderRole::Normal), &[listed(2), listed(4)], &trash)
        .await
        .unwrap();
    assert_eq!(r.moved, vec![2, 4]);
    assert_eq!(r.trash_uids, Some(vec![3, 4]), "positionally matching `moved`");
    assert_eq!(r.trash_validity, Some(1));
    assert_eq!(uids(&server, "INBOX"), vec![1, 3, 5]);
    assert_eq!(uids(&server, "Trash"), vec![1, 2, 3, 4]);
    let st = server.state();
    let raw = &st.find("Trash").unwrap().by_uid(3).unwrap().raw;
    assert!(String::from_utf8_lossy(raw).contains("Message-ID: <b@t.test>"));
}

#[tokio::test]
async fn the_copy_store_uid_expunge_fallback_touches_only_the_moved_uids() {
    // UIDPLUS but no MOVE. Message 3 was flagged \Deleted by another client.
    let mut inbox = mailbox_of("INBOX", &["a", "b"]);
    inbox.add(Message::new(3, msg("c")).with_flags(&["\\Deleted"]));
    let server = MockImap::start(Scenario::new().strict_caps().without_cap("MOVE").mailbox(inbox).mailbox(trash_box()));
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().unwrap();
    let r = ops
        .move_to_trash(&info("INBOX", FolderRole::Normal), &[listed(1), listed(2)], &trash)
        .await
        .unwrap();
    assert_eq!(r.moved, vec![1, 2]);
    assert_eq!(r.trash_uids, Some(vec![1, 2]));
    assert_eq!(uids(&server, "INBOX"), vec![3], "the neighbour's \\Deleted message stays");
    assert_eq!(uids(&server, "Trash"), vec![1, 2]);
    assert_eq!(server.count_commands("UID MOVE"), 0);
    assert_eq!(server.count_commands("UID COPY"), 1);
    assert_eq!(server.count_commands("UID EXPUNGE 1:2"), 1);
    assert_eq!(server.count_commands("EXPUNGE"), server.count_commands("UID EXPUNGE"), "no plain EXPUNGE");
}

#[tokio::test]
async fn move_without_uidplus_asks_the_server_which_uids_left() {
    let server = MockImap::start(
        Scenario::new()
            .strict_caps()
            .without_cap("UIDPLUS")
            .mailbox(mailbox_of("INBOX", &["a", "b", "c"]))
            .mailbox(trash_box()),
    );
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().unwrap();
    let r = ops
        .move_to_trash(&info("INBOX", FolderRole::Normal), &[listed(1), listed(3)], &trash)
        .await
        .unwrap();
    assert_eq!(r.moved, vec![1, 3]);
    assert_eq!(r.trash_uids, None, "no COPYUID without UIDPLUS: the engine finds them by Message-ID");
    assert_eq!(r.trash_validity, None);
    assert_eq!(uids(&server, "INBOX"), vec![2]);
}

#[tokio::test]
async fn a_server_with_neither_move_nor_uidplus_is_refused_before_anything_is_sent() {
    let server = MockImap::start(
        Scenario::new()
            .strict_caps()
            .without_cap("MOVE")
            .without_cap("UIDPLUS")
            .mailbox(mailbox_of("INBOX", &["a", "b"]))
            .mailbox(trash_box()),
    );
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().unwrap();
    let err = ops
        .move_to_trash(&info("INBOX", FolderRole::Normal), &[listed(1)], &trash)
        .await
        .expect_err("refused");
    assert!(matches!(err, OpsError::Other(_)) && err.text().contains("neither MOVE nor UIDPLUS"), "{err:?}");
    for cmd in ["MOVE", "COPY", "STORE", "EXPUNGE"] {
        assert_eq!(server.count_commands(cmd), 0, "{cmd} must not have been sent");
    }
    assert_eq!(uids(&server, "INBOX"), vec![1, 2]);
}

// ── expunging ───────────────────────────────────────────────────────────────

/// Trash already holds mail someone else flagged \Deleted (uid 1) and mail
/// they kept (uid 2); INBOX holds a, b, c.
fn server_with_a_busy_trash() -> MockImap {
    let mut trash = trash_box();
    trash.add(Message::new(1, msg("old")).with_flags(&["\\Deleted"]));
    trash.add(Message::new(2, msg("keep")));
    MockImap::start(Scenario::new().mailbox(mailbox_of("INBOX", &["a", "b", "c"])).mailbox(trash))
}

#[tokio::test]
async fn expunge_exact_leaves_other_trash_mail() {
    let server = server_with_a_busy_trash();
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().unwrap();
    let moved = ops
        .move_to_trash(&info("INBOX", FolderRole::Normal), &[listed(2)], &trash)
        .await
        .unwrap();
    assert_eq!(moved.trash_uids, Some(vec![3]));

    let gone = ops.expunge_exact(&trash, &[3], &[(3, "b@t.test".to_string())]).await.unwrap();
    assert_eq!(gone, vec![3]);
    assert_eq!(uids(&server, "Trash"), vec![1, 2], "only the moved message left");
    let st = server.state();
    assert!(st.find("Trash").unwrap().by_uid(1).unwrap().has_flag("\\Deleted"), "the neighbour's flag is untouched");
    assert_eq!(server.count_commands("UID STORE 3 +FLAGS"), 1);
    assert_eq!(server.count_commands("UID EXPUNGE 3"), 1);
    assert_eq!(server.count_commands("EXPUNGE"), server.count_commands("UID EXPUNGE"), "no plain EXPUNGE");
}

#[tokio::test]
async fn expunge_exact_skips_a_trash_uid_that_is_another_message() {
    let server = server_with_a_busy_trash();
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().unwrap();
    // uid 2 is "keep", not the message the job moved.
    let gone = ops.expunge_exact(&trash, &[2], &[(2, "b@t.test".to_string())]).await.unwrap();
    assert!(gone.is_empty());
    assert_eq!(uids(&server, "Trash"), vec![1, 2]);
    assert_eq!(server.count_commands("EXPUNGE"), 0);
    assert_eq!(server.count_commands("STORE"), 0);
}

#[tokio::test]
async fn expunge_exact_refuses_without_uidplus() {
    let mut trash = trash_box();
    trash.add(Message::new(1, msg("x")));
    let server = MockImap::start(
        Scenario::new().strict_caps().without_cap("UIDPLUS").mailbox(mailbox_of("INBOX", &["a"])).mailbox(trash),
    );
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().unwrap();
    let err = ops.expunge_exact(&trash, &[1], &[(1, "x@t.test".to_string())]).await.expect_err("refused");
    assert!(err.text().contains("UIDPLUS"), "{err:?}");
    assert_eq!(server.count_commands("EXPUNGE"), 0);
    assert_eq!(server.count_commands("STORE"), 0);
    assert_eq!(uids(&server, "Trash"), vec![1]);
}

#[tokio::test]
async fn find_in_trash_matches_message_ids_exactly() {
    let mut trash = trash_box();
    trash.add(Message::new(1, msg("x")));
    trash.add(Message::new(2, msg("xx")));
    trash.add(Message::new(3, msg("y")));
    let server = MockImap::start(Scenario::new().mailbox(mailbox_of("INBOX", &["a"])).mailbox(trash));
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().unwrap();
    // "x@t.test" is a substring of "xx@t.test": only the exact one comes back.
    let found = ops
        .find_in_trash(&trash, &["x@t.test".to_string(), "nope@t.test".to_string(), "y@t.test".to_string()])
        .await
        .unwrap();
    assert_eq!(found, vec![("x@t.test".to_string(), 1), ("y@t.test".to_string(), 3)]);
}

#[tokio::test]
async fn find_trash_never_creates_a_folder() {
    let server = MockImap::start(
        Scenario::new().mailbox(mailbox_of("INBOX", &["a"])).mailbox(Mailbox::new("Trash-old")),
    );
    let mut ops = ops_for(&server);
    assert!(ops.trash().await.unwrap().is_none(), "Trash-old is the user's folder, not the Trash");
    assert_eq!(server.count_commands("CREATE"), 0);
}

// ── presence ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn present_answers_from_a_uid_search() {
    let server = small_server();
    let mut ops = ops_for(&server);
    let got = ops.present(&info("INBOX", FolderRole::Normal), &[1, 2, 9]).await.unwrap();
    assert_eq!(got, vec![1, 2]);
}

#[tokio::test]
async fn present_is_tag_checked() {
    // The server hangs up on every SEARCH: that is an error, never "gone".
    let server = MockImap::start(
        Scenario::new().mailbox(mailbox_of("INBOX", &["a", "b", "c"])).fault(Trigger::on("SEARCH"), Action::DropConnection),
    );
    let mut ops = ops_for(&server);
    let err = ops.present(&info("INBOX", FolderRole::Normal), &[1, 2]).await.expect_err("a dead socket is not an answer");
    assert!(matches!(err, OpsError::Throttled { .. }), "{err:?}");
}

// ── refusals and classification ─────────────────────────────────────────────

async fn fetch_error_under(action: Action) -> OpsError {
    let server = MockImap::start(
        Scenario::new().mailbox(mailbox_of("INBOX", &["a"])).fault(Trigger::with("FETCH", "BODY.PEEK[]"), action),
    );
    let mut ops = ops_for(&server);
    ops.fetch(&info("INBOX", FolderRole::Normal), &listed(1)).await.expect_err("refused")
}

#[tokio::test]
async fn a_refused_throttled_fetch_classifies_as_throttled() {
    let e = fetch_error_under(Action::throttled()).await;
    assert!(matches!(e, OpsError::Throttled { .. }), "{e:?}");
}

#[tokio::test]
async fn a_gmail_bandwidth_refusal_classifies_as_provider_limit() {
    assert!(matches!(fetch_error_under(Action::gmail_bandwidth_limit()).await, OpsError::ProviderLimit(_)));
    assert!(matches!(fetch_error_under(Action::overquota()).await, OpsError::ProviderLimit(_)));
}

#[tokio::test]
async fn too_many_connections_is_its_own_signal() {
    assert!(matches!(fetch_error_under(Action::too_many_connections()).await, OpsError::TooManyConnections(_)));
}

#[tokio::test]
async fn a_throttled_refusal_leaves_the_next_call_to_reconnect_and_succeed() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(mailbox_of("INBOX", &["a", "b"]))
            .fault(Trigger::nth_with("FETCH", "BODY.PEEK[]", 1), Action::throttled()),
    );
    let mut ops = ops_for(&server);
    let inbox = info("INBOX", FolderRole::Normal);
    assert!(matches!(ops.fetch(&inbox, &listed(1)).await, Err(OpsError::Throttled { .. })));
    let f = ops.fetch(&inbox, &listed(1)).await.expect("the second ask goes through");
    assert_eq!(f.message_id.as_deref(), Some("a@t.test"));
    assert_eq!(server.connection_count(), 2, "the refused session was discarded");
}

#[tokio::test]
async fn a_refused_login_is_a_sign_in_signal() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(mailbox_of("INBOX", &["a"]))
            .fault(Trigger::on("LOGIN"), Action::RefuseWith("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into())),
    );
    let mut ops = ops_for(&server);
    let e = ops.uid_validity(&info("INBOX", FolderRole::Normal)).await.expect_err("no session");
    assert!(matches!(e, OpsError::SignIn(_)), "{e:?}");
}

#[tokio::test]
async fn a_server_that_cannot_be_reached_is_offline() {
    let server = small_server();
    let mut config = config_for(&server);
    config.port = Some(1); // nothing listens on port 1 of loopback
    let mut ops = ImapOps::new(Arc::new(ImapPool::new()), config);
    let e = ops.uid_validity(&info("INBOX", FolderRole::Normal)).await.expect_err("nobody home");
    assert!(matches!(e, OpsError::Offline(_)), "{e:?}");
}

#[tokio::test]
async fn a_missing_message_is_gone() {
    let server = small_server();
    let mut ops = ops_for(&server);
    let e = ops.fetch(&info("INBOX", FolderRole::Normal), &listed(99)).await.expect_err("no such uid");
    assert!(matches!(e, OpsError::Gone), "{e:?}");
}

// ── connections ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn one_session_is_held_across_calls_and_returned_on_release() {
    let server = small_server();
    let mut ops = ops_for(&server);
    let inbox = info("INBOX", FolderRole::Normal);
    ops.uid_validity(&inbox).await.unwrap();
    ops.present(&inbox, &[1]).await.unwrap();
    ops.message_ids(&inbox, &[1]).await.unwrap();
    assert_eq!(server.connection_count(), 1, "one held connection served every call");
    ops.release().await;
    // The released session went back to the pool, so a new ImapOps on the same
    // pool would reuse it; here the same ops connects or reuses without error.
    ops.uid_validity(&inbox).await.unwrap();
    assert!(server.connection_count() <= 2);
}

#[tokio::test]
async fn a_dropped_connection_is_reconnected_for_a_read() {
    let server = MockImap::start(
        Scenario::new().mailbox(mailbox_of("INBOX", &["a", "b"])).fault(Trigger::nth("SEARCH", 1), Action::DropConnection),
    );
    let mut ops = ops_for(&server);
    let got = ops.present(&info("INBOX", FolderRole::Normal), &[1, 2]).await.expect("retried on a fresh connection");
    assert_eq!(got, vec![1, 2]);
    assert_eq!(server.connection_count(), 2);
}

#[tokio::test]
async fn a_move_is_never_resent_inside_one_call() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(mailbox_of("INBOX", &["a", "b"]))
            .mailbox(trash_box())
            .fault(Trigger::nth("MOVE", 1), Action::DropConnection),
    );
    let mut ops = ops_for(&server);
    let trash = ops.trash().await.unwrap().unwrap();
    let inbox = info("INBOX", FolderRole::Normal);

    let err = ops.move_to_trash(&inbox, &[listed(1)], &trash).await.expect_err("the connection dropped");
    assert!(matches!(err, OpsError::Throttled { .. }), "{err:?}");
    assert_eq!(server.count_commands("UID MOVE"), 1, "not asked again behind the caller's back");
    assert_eq!(uids(&server, "INBOX"), vec![1, 2]);

    // The engine asks again; the session was discarded, so this reconnects.
    let r = ops.move_to_trash(&inbox, &[listed(1)], &trash).await.expect("second ask");
    assert_eq!(r.moved, vec![1]);
    assert_eq!(server.count_commands("UID MOVE"), 2);
    assert_eq!(uids(&server, "INBOX"), vec![2]);
}

// ── the vault plumbing ──────────────────────────────────────────────────────

fn noop_sinks() -> ArchiveSinks {
    ArchiveSinks { emit: Arc::new(|_, _| {}), custody_append: Arc::new(|_, _, _| Ok(0)) }
}

fn always_open_gate() -> ArchiveGate {
    Arc::new(|work| work())
}

struct Vault {
    _app: tempfile::TempDir,
    root: tempfile::TempDir,
    ctx: ArchiveCtx,
}

fn vault() -> Vault {
    let app = tempfile::tempdir().expect("tempdir");
    let root = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(VaultRegistry::open(app.path(), root.path()));
    let ctx = ArchiveCtx {
        root: root.path().to_path_buf(),
        pool: Arc::new(ImapPool::new()),
        gate: always_open_gate(),
        sinks: noop_sinks(),
        registry,
    };
    Vault { _app: app, root, ctx }
}

fn cur_of(v: &Vault) -> std::path::PathBuf {
    vault_files::cur_path(v.root.path(), "acc", "INBOX")
}

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut n: Vec<String> = std::fs::read_dir(dir)
        .map(|it| it.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    n.sort();
    n
}

#[tokio::test]
async fn store_archived_writes_the_a_flag_atomically_and_upserts_the_registry() {
    let v = vault();
    let raw = msg("solo").into_bytes();
    let (path, entry) =
        archive::store_archived(&v.ctx, "acc", "INBOX", 7, raw.clone(), &["\\Seen".to_string()], false).await.unwrap();

    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(maildir::carries_archived(&name), "{name}");
    assert_eq!(maildir::vault_filename_uid(&name), Some(7));
    assert!(name.contains('S'), "the server's \\Seen rides along: {name}");
    assert_eq!(std::fs::read(&path).unwrap(), raw);
    // Atomic: no temp file is left beside it.
    assert_eq!(names(&cur_of(&v)), vec![name.clone()]);
    // The registry knows the file.
    let resolved = v.ctx.registry.resolve(v.root.path(), "acc", "INBOX", 7);
    let resolved_name = resolved.and_then(|r| r).and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
    assert_eq!(resolved_name, Some(name.clone()));

    // The custody entry has the keys `fetch_and_store` files.
    assert_eq!(entry["uid"], 7);
    assert_eq!(entry["message_id"], "<solo@t.test>");
    assert_eq!(entry["subject"], "solo");
    assert_eq!(entry["from"]["address"], "a@example.com");
    assert_eq!(entry["source"], "local");
    assert_eq!(entry["flags"][0], "\\Seen");
}

#[tokio::test]
async fn store_archived_never_overwrites_an_archived_copy() {
    let v = vault();
    let first = msg("first").into_bytes();
    let (p1, _) = archive::store_archived(&v.ctx, "acc", "INBOX", 7, first.clone(), &[], false).await.unwrap();
    for listed_archived in [false, true] {
        let (p2, _) = archive::store_archived(&v.ctx, "acc", "INBOX", 7, msg("second").into_bytes(), &[], listed_archived)
            .await
            .unwrap();
        assert_eq!(p2, p1, "the archived copy is the one that is returned");
    }
    assert_eq!(std::fs::read(&p1).unwrap(), first, "and it was not rewritten");
    assert_eq!(names(&cur_of(&v)).len(), 1);
}

#[tokio::test]
async fn store_archived_replaces_a_cache_copy() {
    let v = vault();
    // A working-cache copy (an opened message): no A flag.
    vault_files::store(&v.ctx.registry, v.root.path(), "acc", "INBOX", 7, b"old cache copy", &["seen".to_string()], true)
        .unwrap();
    assert_eq!(names(&cur_of(&v)).len(), 1);

    let raw = msg("fresh").into_bytes();
    let (path, _) = archive::store_archived(&v.ctx, "acc", "INBOX", 7, raw.clone(), &["\\Seen".to_string()], false)
        .await
        .unwrap();
    let after = names(&cur_of(&v));
    assert_eq!(after.len(), 1, "one file for the uid, not a cache copy beside an archive: {after:?}");
    assert!(maildir::carries_archived(&after[0]));
    assert_eq!(std::fs::read(&path).unwrap(), raw);
}

#[tokio::test]
async fn a_fetched_body_stores_and_verifies_against_its_message_id() {
    let server = small_server();
    let mut ops = ops_for(&server);
    let fetched = ops.fetch(&info("INBOX", FolderRole::Normal), &listed(2)).await.unwrap();
    assert_eq!(fetched.message_id.as_deref(), Some("b@t.test"));
    let st = server.state();
    assert_eq!(fetched.raw, st.find("INBOX").unwrap().by_uid(2).unwrap().raw);

    let v = vault();
    let (path, _) = archive::store_archived(&v.ctx, "acc", "INBOX", 2, fetched.raw.clone(), &fetched.flags, false)
        .await
        .unwrap();
    let cur = cur_of(&v);
    let listing = maildir::archived_file_map(&cur);
    assert_eq!(listing.get(&2), Some(&path));

    let expect_b: HashMap<u32, String> = HashMap::from([(2, "b@t.test".to_string())]);
    assert_eq!(maildir::verify_listed(&cur, &listing, &[2], Some(&expect_b)), (vec![2], vec![], vec![]));
    let expect_other: HashMap<u32, String> = HashMap::from([(2, "zzz@t.test".to_string())]);
    assert_eq!(maildir::verify_listed(&cur, &listing, &[2], Some(&expect_other)), (vec![], vec![], vec![2]));
    // A uid the listing lacks is missing, and so is a file removed since.
    assert_eq!(maildir::verify_listed(&cur, &listing, &[3], None), (vec![], vec![3], vec![]));
    std::fs::remove_file(&path).unwrap();
    assert_eq!(maildir::verify_listed(&cur, &listing, &[2], Some(&expect_b)), (vec![], vec![2], vec![]));
}

// ── the engine over ImapOps ─────────────────────────────────────────────────

/// `n` messages "m<i>" in INBOX (2025) and a Trash that already holds mail:
/// uid 1 flagged \Deleted by someone, uid 2 kept.
fn driver_server(n: usize) -> MockImap {
    let mut inbox = Mailbox::new("INBOX");
    for i in 1..=n {
        inbox.add(
            Message::new(i as u32, msg(&format!("m{i}"))).with_internal_ms(ms(2025, 6, 1, 12, 0) + i as i64 * 1000),
        );
    }
    let mut trash = trash_box();
    trash.add(Message::new(1, msg("old")).with_flags(&["\\Deleted"]));
    trash.add(Message::new(2, msg("keep")));
    MockImap::start(Scenario::new().mailbox(inbox).mailbox(trash))
}

struct Ran {
    job: JobFile,
    local: FakeLocal,
    env: FakeEnv,
}

async fn drive(server: &MockImap, mode: Mode, delete_mode: DeleteMode) -> Ran {
    let sh = Shared::new(start_ms());
    let local = FakeLocal::new(sh.clone());
    let env = FakeEnv::new(sh.clone());
    let ctl = Control::new();
    let mut ops = ops_for(server);

    let preview = build_preview(&mut ops, "p1", sh.clock.get(), &mut |_, _| {}).await.expect("preview");
    assert_eq!(preview.provider, Provider::Imap);
    let mut job = JobFile::create(NewJob {
        account_id: "acc1".to_string(),
        account_email: "user@example.com".to_string(),
        host: "127.0.0.1".to_string(),
        provider: preview.provider,
        mode,
        timing: Timing::AfterAll,
        delete_mode,
        scope: Scope {
            folders: vec!["INBOX".to_string()],
            dates: DateScope::All,
            date_choice: "all".to_string(),
            year_bounds: year_bounds(0, 2015, 2030),
        },
        now_ms: sh.clock.get(),
    });
    let mut plans = PlanStore::new();
    assert_eq!(plan_job(&mut job, &preview, &mut plans, &mut ops, &local, &env, &ctl).await, RunExit::Completed);
    assert_eq!(run(&mut job, &plans, &mut ops, &local, &env, &ctl).await, RunExit::Completed);
    Ran { job, local, env }
}

fn trash_ids(server: &MockImap) -> Vec<String> {
    let st = server.state();
    let mut ids: Vec<String> = st
        .find("Trash")
        .unwrap()
        .messages
        .iter()
        .filter_map(|m| maildir::message_id_in(&m.raw))
        .collect();
    ids.sort();
    ids
}

#[tokio::test]
async fn the_engine_archives_backs_up_and_moves_to_trash_over_imap() {
    let server = driver_server(30);
    let ran = drive(&server, Mode::ArchiveBackupDelete, DeleteMode::MoveToTrash).await;

    assert_eq!(ran.job.status, JobStatus::Completed);
    assert!(uids(&server, "INBOX").is_empty(), "everything left the server's INBOX");
    let mut want: Vec<String> = (1..=30).map(|i| format!("m{i}@t.test")).collect();
    want.extend(["old@t.test".to_string(), "keep@t.test".to_string()]);
    want.sort();
    assert_eq!(trash_ids(&server), want, "moved, not deleted: the 30 sit in Trash beside what was there");

    let all: Vec<u32> = (1..=30).collect();
    assert_eq!(ran.local.vault_uids("INBOX"), all);
    assert_eq!(ran.local.mirror_uids("INBOX"), all, "backup mode mirrored every message first");
    assert_eq!(ran.job.folders[0].deleted.len(), 30);
    assert!(ran.env.yields.get() > 0);
}

#[tokio::test]
async fn the_engine_in_archive_mode_never_touches_the_mirror_over_imap() {
    let server = driver_server(30);
    let ran = drive(&server, Mode::ArchiveDelete, DeleteMode::MoveToTrash).await;

    assert_eq!(ran.job.status, JobStatus::Completed);
    assert!(uids(&server, "INBOX").is_empty());
    assert_eq!(ran.local.vault_uids("INBOX").len(), 30);
    assert_eq!(ran.local.mirror_copy_calls.get(), 0);
    assert!(ran.local.mirror_uids("INBOX").is_empty());
    assert_eq!(trash_ids(&server).len(), 32);
}

#[tokio::test]
async fn the_engine_empties_only_what_it_moved_and_leaves_other_trash_mail() {
    let server = driver_server(30);
    let ran = drive(&server, Mode::ArchiveDelete, DeleteMode::MoveToTrashAndEmpty).await;

    assert_eq!(ran.job.status, JobStatus::Completed);
    assert!(uids(&server, "INBOX").is_empty());
    assert_eq!(trash_ids(&server), vec!["keep@t.test".to_string(), "old@t.test".to_string()]);
    let st = server.state();
    assert!(
        st.find("Trash").unwrap().by_uid(1).unwrap().has_flag("\\Deleted"),
        "the message someone else flagged is still there, still flagged"
    );
    assert_eq!(server.count_commands("EXPUNGE"), server.count_commands("UID EXPUNGE"), "never a plain EXPUNGE");
    assert_eq!(ran.local.vault_uids("INBOX").len(), 30);
}
