// src-core/tests/jmap_client.rs
use mailvault_core::jmap::*;
use mock_jmap::{http_request, Fault, MockJmap};
mod common_jmap; // tests/common_jmap/mod.rs: scenario() calls base::allow_loopback_for_tests()

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

fn rt() -> tokio::runtime::Runtime { tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap() }
fn basic() -> JmapAuth { JmapAuth::Basic { username: "alice@example.test".into(), password: "pw".into() } }

#[test]
fn connect_reads_primary_account_and_limits() {
    let m = MockJmap::start(common_jmap::scenario()); // scenario() calls base::allow_loopback_for_tests()
    let c = rt().block_on(JmapClient::connect(&m.session_url(), basic(), "alice@example.test")).unwrap();
    assert_eq!(c.account_id(), "acc1");
    assert_eq!(c.limits().max_objects_in_get, 500);
}

#[test]
fn wrong_password_is_unauthorized() {
    let m = MockJmap::start(common_jmap::scenario());
    let bad = JmapAuth::Basic { username: "alice@example.test".into(), password: "nope".into() };
    assert_eq!(rt().block_on(JmapClient::connect(&m.session_url(), bad, "a")).err(), Some(JmapError::Unauthorized));
}

#[test]
fn get_emails_chunks_by_max_objects_in_get() {
    let mut s = common_jmap::scenario(); s.limits.max_objects_in_get = 2;
    let m = MockJmap::start(s);
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let ids: Vec<String> = vec!["e1".into(), "e2".into(), "e3".into(), "gone".into()];
    let got = rt.block_on(c.get_emails(&ids, headers::HEADER_PROPS)).unwrap();
    assert_eq!(got.list.len(), 3);
    assert_eq!(got.not_found, vec!["gone"]);
    assert!(!got.state.is_empty());
    assert_eq!(m.requests().iter().filter(|r| r.body_contains("Email/get")).count(), 2);
}

#[test]
fn rate_limit_surfaces_retry_after() {
    let mut s = common_jmap::scenario(); s.faults.push(Fault::RateLimited { retry_after_secs: 7 });
    let m = MockJmap::start(s);
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    assert_eq!(rt.block_on(c.mailboxes()).err(), Some(JmapError::RateLimited { retry_after: Some(7) }));
}

#[test]
fn cannot_calculate_changes_is_typed() {
    let m = MockJmap::start(common_jmap::scenario());
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    assert_eq!(rt.block_on(c.email_changes("bogus")).err(), Some(JmapError::CannotCalculateChanges));
}

#[test]
fn mailbox_tree_maps_inbox_role_and_nested_paths() {
    let list = vec![
        JMailbox { id: "1".into(), name: "Posteingang".into(), parent_id: None, role: Some("inbox".into()), total_emails: 0, unread_emails: 0, sort_order: 0 },
        JMailbox { id: "2".into(), name: "Work".into(), parent_id: None, role: None, total_emails: 0, unread_emails: 0, sort_order: 1 },
        JMailbox { id: "3".into(), name: "Sub".into(), parent_id: Some("2".into()), role: None, total_emails: 0, unread_emails: 0, sort_order: 0 },
        JMailbox { id: "4".into(), name: "Gesendet".into(), parent_id: None, role: Some("sent".into()), total_emails: 0, unread_emails: 0, sort_order: 2 },
    ];
    let (tree, ids) = mailbox_map::mailbox_tree(&list);
    assert_eq!(ids["INBOX"], "1");
    assert_eq!(ids["Work/Sub"], "3");
    assert_eq!(tree.iter().find(|m| m.path == "Gesendet").unwrap().special_use.as_deref(), Some("\\Sent"));
    assert_eq!(tree.iter().find(|m| m.path == "INBOX").unwrap().special_use.as_deref(), Some("\\Inbox"));
    // Flat like imap::list_mailboxes: the app derives the tree from path + delimiter.
    let paths: Vec<&str> = tree.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(paths, ["INBOX", "Work", "Work/Sub", "Gesendet"]);
    assert!(tree.iter().all(|m| m.children.is_empty() && m.delimiter.as_deref() == Some("/") && !m.special_use_guessed));
    assert_eq!(tree.iter().find(|m| m.path == "Work/Sub").unwrap().name, "Sub");
}

#[test]
fn mailbox_name_with_a_slash_never_reads_as_a_delimiter() {
    let list = vec![
        JMailbox { id: "a".into(), name: "Q1/Q2".into(), parent_id: None, role: None, total_emails: 0, unread_emails: 0, sort_order: 0 },
        JMailbox { id: "b".into(), name: "Notes".into(), parent_id: Some("a".into()), role: None, total_emails: 0, unread_emails: 0, sort_order: 0 },
        JMailbox { id: "c".into(), name: "Orphan".into(), parent_id: Some("missing".into()), role: None, total_emails: 0, unread_emails: 0, sort_order: 0 },
    ];
    let (tree, ids) = mailbox_map::mailbox_tree(&list);
    assert_eq!(ids["Q1\u{2215}Q2"], "a");
    assert_eq!(ids["Q1\u{2215}Q2/Notes"], "b");
    assert_eq!(ids["Orphan"], "c");
    assert_eq!(tree.iter().find(|m| m.path == "Q1\u{2215}Q2").unwrap().name, "Q1/Q2");
}

#[test]
fn keywords_round_trip_to_imap_flags() {
    let flags = headers::keywords_to_flags(&serde_json::json!({"$seen":true,"$flagged":true,"custom":true}));
    assert_eq!(flags, vec!["\\Seen", "\\Flagged", "custom"]);
    assert_eq!(headers::flag_to_keyword("\\Answered"), "$answered");
}

#[test]
fn to_header_maps_jmap_properties_onto_the_app_header() {
    let m = MockJmap::start(common_jmap::scenario());
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let got = rt.block_on(c.get_emails(&["e2".to_string()], headers::HEADER_PROPS)).unwrap();
    let h = headers::to_header(&got.list[0], 42);
    assert_eq!((h.uid, h.seq), (42, 42));
    assert_eq!(h.message_id.as_deref(), Some("<e2@x>"));
    assert_eq!(h.in_reply_to.as_deref(), Some("<e1@x>"));
    assert_eq!(h.references, Some(vec!["<e1@x>".to_string()]));
    assert_eq!(h.subject, "two");
    assert_eq!((h.from.name.as_deref(), h.from.address.as_str()), (Some("Bob"), "bob@example.test"));
    assert_eq!(h.to.len(), 1);
    assert_eq!((h.to[0].name.as_deref(), h.to[0].address.as_str()), (Some("Alice"), "alice@example.test"));
    assert_eq!((h.cc[0].name.as_deref(), h.cc[0].address.as_str()), (None, "carol@example.test"));
    assert!(h.bcc.is_empty());
    assert_eq!(h.flags, vec!["\\Flagged"]);
    assert_eq!(h.received_at.as_deref(), Some("2026-10-02T10:00:00Z"));
    assert_eq!(h.date.as_deref(), Some("2026-10-02T10:00:00Z"));
    assert_eq!(h.sent_at.as_deref(), Some("2026-10-02T09:00:00Z"));
    assert_eq!(h.size, Some(common_jmap::E2_RAW.len() as u32));
    assert!(!h.has_attachments);
    assert_eq!(h.source.as_deref(), Some("jmap"));
    assert_eq!(h.list_unsubscribe.as_deref(), Some("<mailto:unsub@example.test>, <https://example.test/unsub>"));
    assert_eq!(h.auto_reply.as_deref(), Some("auto-replied"));
    assert_eq!(h.list_id, None);
}

#[test]
fn to_header_defaults_what_the_server_left_out() {
    let h = headers::to_header(&serde_json::json!({"id": "x", "keywords": {"$answered": true, "$seen": true, "$junk": false}}), 7);
    assert_eq!(h.subject, "(No Subject)");
    assert_eq!(h.message_id, None);
    assert_eq!(h.references, None);
    assert_eq!(h.from.address, "unknown@unknown.com");
    assert!(h.to.is_empty());
    assert_eq!(h.flags, vec!["\\Seen", "\\Answered"]);
    assert_eq!(h.size, None);
    assert_eq!(h.auto_reply, None);
}

#[test]
fn plain_http_endpoint_off_loopback_is_refused() {
    let m = MockJmap::start(common_jmap::scenario());
    m.mutate(|s| s.api_url_override = Some("http://evil.example/api".into()));
    assert!(matches!(rt().block_on(JmapClient::connect(&m.session_url(), basic(), "a")).err(), Some(JmapError::Protocol(_))));
}

#[test]
fn download_from_second_host_with_query_template_works() {
    let m = MockJmap::start(common_jmap::scenario());
    m.mutate(|s| s.download_host = Some("second".into()));
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let got = rt.block_on(c.get_emails(&["e1".to_string()], &["blobId"])).unwrap();
    let raw = rt.block_on(c.download(got.list[0]["blobId"].as_str().unwrap())).unwrap();
    assert!(raw.starts_with(b"Message-ID: <e1@x>"));
}

#[test]
fn import_already_exists_is_not_a_failure() {
    let mut s = common_jmap::scenario(); s.faults.push(Fault::ImportAlreadyExists);
    let m = MockJmap::start(s);
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let blob = rt.block_on(c.upload(b"Message-ID: <e1@x>\r\nSubject: one\r\n\r\nbody")).unwrap();
    assert!(matches!(rt.block_on(c.import(&blob, &["mb-inbox".into()], &[], None)).unwrap(), ImportResult::AlreadyExists { .. }));
}

#[test]
fn oversize_batch_is_refused_not_split() {
    let mut s = common_jmap::scenario(); s.limits.max_calls_in_request = 1;
    let m = MockJmap::start(s);
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let two = vec![serde_json::json!(["Core/echo", {}, "a"]), serde_json::json!(["Core/echo", {}, "b"])];
    assert!(matches!(rt.block_on(c.call(two)).err(), Some(JmapError::Protocol(_))));
    assert_eq!(m.requests().iter().filter(|r| r.is_api()).count(), 0);
}

#[test]
fn remove_from_follows_label_rule() {
    let m = MockJmap::start(common_jmap::scenario());
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let trash = Some("mb-trash");
    let mailboxes_of = |id: &str| m.read(|s| s.email("acc1", id).map(|e| e.mailbox_ids.iter().cloned().collect::<Vec<_>>()));
    // e1 is in Inbox and Work: a delete from Inbox only drops the Inbox label.
    assert_eq!(rt.block_on(ops::remove_from(&c, "e1", "mb-inbox", trash, false)).unwrap(), RemoveOutcome::LabelRemoved);
    assert_eq!(mailboxes_of("e1"), Some(vec!["mb-work".to_string()]));
    // e2 is only in Inbox: it moves to Trash.
    assert_eq!(rt.block_on(ops::remove_from(&c, "e2", "mb-inbox", trash, false)).unwrap(), RemoveOutcome::MovedToTrash);
    assert_eq!(mailboxes_of("e2"), Some(vec!["mb-trash".to_string()]));
    // Expunged from Trash, its only mailbox: destroyed. A second try finds nothing.
    assert_eq!(rt.block_on(ops::remove_from(&c, "e2", "mb-trash", trash, true)).unwrap(), RemoveOutcome::Destroyed);
    assert_eq!(mailboxes_of("e2"), None);
    assert_eq!(rt.block_on(ops::remove_from(&c, "e2", "mb-trash", trash, true)).unwrap(), RemoveOutcome::Gone);
    // e1 in Work and Trash: an expunge from Trash drops the Trash label, e1 lives on in Work.
    m.mutate(|s| s.add_to_mailbox("acc1", "e1", "mb-trash"));
    assert_eq!(rt.block_on(ops::remove_from(&c, "e1", "mb-trash", trash, true)).unwrap(), RemoveOutcome::LabelRemoved);
    assert_eq!(mailboxes_of("e1"), Some(vec!["mb-work".to_string()]));
    // Out of a mailbox it is not in: nothing to do.
    assert_eq!(rt.block_on(ops::remove_from(&c, "e1", "mb-inbox", trash, false)).unwrap(), RemoveOutcome::Gone);
    // Never destroyed by a plain delete: e3 has no other mailbox and there is no Trash to move it to.
    let refused = rt.block_on(ops::remove_from(&c, "e3", "mb-sub", None, false));
    assert_eq!(refused, Err(JmapError::NoTrash), "a typed refusal, not a Protocol string to match");
    assert_eq!(JmapError::NoTrash.code(), "E_JMAP_NO_TRASH");
    assert!(JmapError::NoTrash.to_string().starts_with("E_JMAP_NO_TRASH: "));
    assert_eq!(mailboxes_of("e3"), Some(vec!["mb-sub".to_string()]));
    assert_eq!(m.count_calls("Email/set"), 4);
}

#[test]
fn query_mailbox_pages_past_a_server_limit_cap() {
    let mut s = common_jmap::scenario(); s.limits.max_query_limit = 1;
    let m = MockJmap::start(s);
    m.mutate(|s| s.add_email("acc1", "mb-inbox", common_jmap::email("e4", "four", "2026-10-04T10:00:00Z")));
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let (ids, total) = rt.block_on(c.query_mailbox("mb-inbox", 0, 100)).unwrap();
    assert_eq!(ids, vec!["e4", "e2", "e1"]);
    assert_eq!(total, Some(3));
    assert_eq!(m.count_calls("Email/query"), 3);
    let (window, _) = rt.block_on(c.query_mailbox("mb-inbox", 1, 1)).unwrap();
    assert_eq!(window, vec!["e2"]);
}

#[test]
fn query_mailbox_restarts_once_when_the_query_state_moves() {
    let mut s = common_jmap::scenario(); s.limits.max_query_limit = 1;
    let m = Arc::new(MockJmap::start(s));
    // e9 arrives right after the first page: it pushes e2 down to position 1.
    let proxy = query_hook_proxy(m.clone(), |m, n| {
        if n == 0 {
            m.mutate(|s| s.add_email("acc1", "mb-inbox", common_jmap::email("e9", "nine", "2026-10-09T10:00:00Z")));
        }
    });
    m.mutate(|s| s.api_url_override = Some(proxy));
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let (ids, total) = rt.block_on(c.query_mailbox("mb-inbox", 0, 100)).unwrap();
    // Without the restart the second page repeats e2 and e9 is never listed.
    assert_eq!(ids, vec!["e9", "e2", "e1"]);
    assert_eq!(total, Some(3));
    assert_eq!(m.count_calls("Email/query"), 5);
}

#[test]
fn query_mailbox_accepts_a_query_state_that_keeps_moving() {
    let mut s = common_jmap::scenario(); s.limits.max_query_limit = 1;
    let m = Arc::new(MockJmap::start(s));
    // Every page moves the Email state (a flag toggle) but not the list.
    let proxy = query_hook_proxy(m.clone(), |m, n| {
        let keywords: &[&str] = if n % 2 == 0 { &["$flagged"] } else { &[] };
        m.mutate(|s| s.set_keywords("acc1", "e1", keywords));
    });
    m.mutate(|s| s.api_url_override = Some(proxy));
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let (ids, total) = rt.block_on(c.query_mailbox("mb-inbox", 0, 100)).unwrap();
    assert_eq!(ids, vec!["e2", "e1"]);
    assert_eq!(total, Some(2));
    // One page, one restart, then two pages under a state that keeps moving.
    assert_eq!(m.count_calls("Email/query"), 4);
}

#[test]
fn event_source_url_is_expanded_and_streams() {
    let m = MockJmap::start(common_jmap::scenario());
    let rt = rt();
    let c = rt.block_on(JmapClient::connect(&m.session_url(), basic(), "a")).unwrap();
    let mut stream = rt.block_on(c.open_event_source("*", 1)).unwrap();
    m.mutate(|s| s.set_keywords("acc1", "e1", &[]));
    let chunk = rt
        .block_on(async { tokio::time::timeout(Duration::from_secs(5), stream.chunk()).await })
        .expect("an event within 5 s")
        .unwrap()
        .expect("an open stream");
    assert!(String::from_utf8_lossy(&chunk).contains("event: "));
    let opened = m.requests().into_iter().find(|r| r.path.starts_with("/jmap/eventsource")).unwrap();
    assert!(opened.path.ends_with("?types=%2A&closeafter=no&ping=1"), "{}", opened.path);
}

/// A loopback proxy for the mock's API (set as `apiUrl` through
/// `api_url_override`). After forwarding the n-th `Email/query` (from 0) it runs
/// `after_query(&mock, n)` before it answers, so a test can move the server
/// state between two pages of one `query_mailbox`.
fn query_hook_proxy(m: Arc<MockJmap>, after_query: impl Fn(&MockJmap, usize) + Send + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/jmap/api", listener.local_addr().unwrap());
    let api = format!("{}/jmap/api", m.base_url());
    std::thread::spawn(move || {
        let mut queries = 0;
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { continue };
            let (auth, body) = read_post(&conn);
            let resp = http_request("POST", &api, &[("Authorization", auth.as_str()), ("Content-Type", "application/json")], &body);
            if String::from_utf8_lossy(&body).contains("Email/query") {
                after_query(&m, queries);
                queries += 1;
            }
            let head = format!(
                "HTTP/1.1 {} Proxied\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                resp.status,
                resp.body.len()
            );
            let _ = conn.write_all(head.as_bytes());
            let _ = conn.write_all(&resp.body);
        }
    });
    url
}

/// One request off `conn`: its Authorization header and its Content-Length body.
fn read_post(conn: &TcpStream) -> (String, Vec<u8>) {
    let mut r = BufReader::new(conn);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let (mut auth, mut len) = (String::new(), 0usize);
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("authorization") {
                auth = v.trim().to_string();
            } else if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body).unwrap();
    (auth, body)
}
