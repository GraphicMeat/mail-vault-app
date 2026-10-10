//! Sending from a JMAP account (RFC 8621 §7): no SMTP server, so both send
//! paths (`send_built` for compose, `send_raw` for Scheduled Send) upload the
//! message, `Email/import` it into Drafts and submit it with
//! `EmailSubmission/set`, the server filing it in Sent on success.
//!
//! Every test runs its own mock (`mock_jmap::MockJmap`) on its own port.

use mailvault_core::imap::ImapConfig;
use mailvault_core::jmap::{JmapAuth, JmapClient, CORE, MAIL, SUBMISSION};
use mailvault_core::smtp::{self, FrozenEnvelope, OutgoingEmail};
use mock_jmap::{http_request, Fault, MockJmap, RecordedRequest, Scenario, ScenarioMailbox};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

mod common_jmap; // scenario() calls base::allow_loopback_for_tests()

const ACC: &str = "acc1";

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

/// `common_jmap::scenario()` (Inbox, Work, Work/Sub, Trash) plus a Sent
/// mailbox, a Drafts mailbox when `drafts`, and these identities (ids `id1`,
/// `id2`, ... in order).
fn send_scenario(identities: &[&str], drafts: bool) -> Scenario {
    let mut s = common_jmap::scenario();
    let account = &mut s.accounts[0];
    account.identities = identities.iter().map(|e| (e.to_string(), String::new())).collect();
    let mailbox = |id: &str, name: &str, role: &str| ScenarioMailbox {
        id: id.into(),
        name: name.into(),
        parent_id: None,
        role: Some(role.into()),
        emails: vec![],
    };
    account.mailboxes.push(mailbox("mb-sent", "Sent", "sent"));
    if drafts {
        account.mailboxes.push(mailbox("mb-drafts", "Drafts", "drafts"));
    }
    s
}

/// The JMAP account as the app stores it (Basic: the address + "pw"), sending
/// as `from` when set. Its IMAP and SMTP hosts lead nowhere.
fn jmap_config(m: &MockJmap, from: Option<&str>) -> ImapConfig {
    serde_json::from_value(json!({
        "email": "alice@example.test",
        "name": "Alice",
        "password": "pw",
        "imapHost": "127.0.0.1",
        "authType": "password",
        "jmapSessionUrl": m.session_url(),
        "jmapAuth": "basic",
        "fromEmail": from,
    }))
    .expect("ImapConfig")
}

fn outgoing(subject: &str, bcc: Option<&str>) -> OutgoingEmail {
    serde_json::from_value(json!({
        "to": "Bob <bob@example.test>",
        "bcc": bcc,
        "subject": subject,
        "text": "body",
        "messageId": format!("<{subject}@example.test>"),
    }))
    .expect("OutgoingEmail")
}

/// The unfolded header lines named `name` in `raw`'s header block.
fn header_lines(raw: &str, name: &str) -> Vec<String> {
    let block = raw.split("\r\n\r\n").next().unwrap_or("");
    let unfolded = block.replace("\r\n ", " ").replace("\r\n\t", " ");
    let prefix = format!("{}:", name.to_ascii_lowercase());
    unfolded.split("\r\n").filter(|l| l.to_ascii_lowercase().starts_with(&prefix)).map(str::to_string).collect()
}

fn uploads(m: &MockJmap) -> Vec<RecordedRequest> {
    m.requests().into_iter().filter(|r| r.path.starts_with("/jmap/upload/")).collect()
}

/// The API request bodies that carried a `method` call, parsed.
fn api_bodies_with(m: &MockJmap, method: &str) -> Vec<Value> {
    m.requests()
        .into_iter()
        .filter(|r| r.is_api() && r.calls.iter().any(|c| c == method))
        .map(|r| serde_json::from_str(&r.body).expect("an API body is JSON"))
        .collect()
}

/// The arguments of every `EmailSubmission/set` call the mock received.
fn submission_args(m: &MockJmap) -> Vec<Value> {
    api_bodies_with(m, "EmailSubmission/set")
        .into_iter()
        .flat_map(|b| b["methodCalls"].as_array().cloned().unwrap_or_default())
        .filter(|c| c[0] == "EmailSubmission/set")
        .map(|c| c[1].clone())
        .collect()
}

/// A request's `using` names the core, mail and submission capabilities.
fn assert_using_submission(body: &Value) {
    let using: Vec<&str> = body["using"].as_array().expect("using").iter().filter_map(Value::as_str).collect();
    for cap in [CORE, MAIL, SUBMISSION] {
        assert!(using.contains(&cap), "{cap} missing from using {using:?}");
    }
    assert!(using.contains(&"urn:ietf:params:jmap:submission"));
}

/// (id, keywords, mailbox ids) of every email in `mailbox`.
fn emails_in(m: &MockJmap, mailbox: &str) -> Vec<(String, Vec<String>, Vec<String>)> {
    m.read(|s| {
        s.emails_in(ACC, mailbox)
            .into_iter()
            .map(|id| {
                let e = s.email(ACC, &id).unwrap();
                (id, e.keywords.iter().cloned().collect(), e.mailbox_ids.iter().cloned().collect())
            })
            .collect()
    })
}

// ── compose (send_built) ────────────────────────────────────────────────────

/// One submission as the login's identity; the server's copy ends in Sent,
/// read and no longer a draft, and Drafts is empty again.
#[test]
fn send_submits_once_and_files_in_sent() {
    let m = MockJmap::start(send_scenario(&["alice@example.test"], true));
    let cfg = jmap_config(&m, None);
    assert!(cfg.smtp_host.is_none(), "a JMAP account has no SMTP server");

    let result = rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-basic", None))).expect("sent through JMAP");

    assert!(result.server_saved_sent, "the server files the Sent copy: no APPEND");
    assert_eq!(result.message_id, "<jmap-basic@example.test>");
    assert_eq!(m.submitted().len(), 1, "exactly one submission");
    assert_eq!(m.submitted()[0], result.raw_rfc2822, "the bytes handed back are the bytes that went out");

    let subs = submission_args(&m);
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0]["create"]["s"]["identityId"], json!("id1"));
    assert_eq!(
        subs[0]["onSuccessUpdateEmail"]["#s"],
        json!({"mailboxIds/mb-drafts": null, "mailboxIds/mb-sent": true, "keywords/$draft": null})
    );

    let sent = emails_in(&m, "mb-sent");
    assert_eq!(sent.len(), 1, "{sent:?}");
    let (id, keywords, mailboxes) = &sent[0];
    assert!(keywords.contains(&"$seen".to_string()), "{keywords:?}");
    assert!(!keywords.contains(&"$draft".to_string()), "{keywords:?}");
    assert_eq!(mailboxes, &vec!["mb-sent".to_string()]);
    assert_eq!(m.read(|s| s.raw(ACC, id)).unwrap(), result.raw_rfc2822);
    assert!(emails_in(&m, "mb-drafts").is_empty());

    // Task 2 deferred: `using` was never asserted. Identity/get and
    // EmailSubmission/set both need the submission capability in it.
    for method in ["Identity/get", "EmailSubmission/set"] {
        let bodies = api_bodies_with(&m, method);
        assert!(!bodies.is_empty(), "no {method} request");
        for body in &bodies {
            assert_using_submission(body);
        }
    }
}

/// A send-as address the server lists as an identity is sent as that one.
#[test]
fn send_as_alias_uses_matching_identity() {
    let m = MockJmap::start(send_scenario(&["alice@example.test", "sales@example.test"], true));
    let cfg = jmap_config(&m, Some("sales@example.test"));

    rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-alias", None))).expect("sent as sales@");

    let subs = submission_args(&m);
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0]["create"]["s"]["identityId"], json!("id2"));
    let sent = String::from_utf8_lossy(&m.submitted()[0]).into_owned();
    assert!(header_lines(&sent, "From")[0].contains("sales@example.test"), "{sent}");
}

/// An address the server lists no identity for is refused before anything is
/// uploaded or imported: nothing is left on the server.
#[test]
fn unknown_from_address_is_refused_before_upload() {
    let m = MockJmap::start(send_scenario(&["alice@example.test"], true));
    let cfg = jmap_config(&m, Some("other@example.test"));

    let err = rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-unknown", None))).err().expect("no identity, no send");

    assert!(err.starts_with("E_JMAP_NO_IDENTITY"), "{err}");
    assert!(err.contains("other@example.test"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert!(uploads(&m).is_empty(), "uploaded: {:?}", uploads(&m));
    assert_eq!(m.count_calls("Email/import"), 0);
    assert!(m.submitted().is_empty());
}

/// A wildcard identity covers every address on its domain.
#[test]
fn wildcard_identity_matches_any_address_on_domain() {
    let m = MockJmap::start(send_scenario(&["alice@example.test", "*@example.test"], true));
    let cfg = jmap_config(&m, Some("sales@example.test"));

    rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-wildcard", None))).expect("sent through the wildcard");

    let subs = submission_args(&m);
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0]["create"]["s"]["identityId"], json!("id2"));
}

/// The server derives the recipients from To, Cc and Bcc (RFC 8621 §7.5), so
/// the Bcc is written into the bytes and no envelope is sent. The Sent copy
/// keeps the Bcc line.
#[test]
fn bcc_is_in_the_uploaded_message_and_no_envelope_is_sent() {
    let m = MockJmap::start(send_scenario(&["alice@example.test"], true));
    let cfg = jmap_config(&m, None);

    rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-bcc", Some("carol@example.test")))).expect("sent");

    let up = uploads(&m);
    assert_eq!(up.len(), 1);
    let bcc = header_lines(&up[0].body, "Bcc");
    assert_eq!(bcc.len(), 1, "{}", up[0].body);
    assert!(bcc[0].contains("carol@example.test"), "{}", up[0].body);

    let subs = submission_args(&m);
    assert_eq!(subs.len(), 1);
    assert!(subs[0]["create"]["s"].get("envelope").is_none(), "an envelope was sent: {}", subs[0]);

    let sent = String::from_utf8_lossy(&m.submitted()[0]).into_owned();
    assert_eq!(header_lines(&sent, "Bcc").len(), 1, "{sent}");
}

/// A refused submission is the server's own refusal, and the imported draft
/// is destroyed so a retry does not leave a second one.
#[test]
fn rejected_submission_destroys_the_draft() {
    let mut s = send_scenario(&["alice@example.test"], true);
    s.faults.push(Fault::SubmissionRejected);
    let m = MockJmap::start(s);
    let cfg = jmap_config(&m, None);

    let err = rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-rejected", None))).err().expect("refused");

    assert!(err.starts_with("E_JMAP_SUBMIT:forbiddenFrom"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert_eq!(m.count_calls("Email/import"), 1, "the draft was imported");
    assert!(emails_in(&m, "mb-drafts").is_empty(), "the unsent draft is left behind");
    assert!(emails_in(&m, "mb-sent").is_empty());
    assert!(m.submitted().is_empty());
}

/// With no Drafts mailbox the message is imported straight into Sent, read
/// and not a draft, and the submission patches nothing.
#[test]
fn no_drafts_role_imports_into_sent() {
    let m = MockJmap::start(send_scenario(&["alice@example.test"], false));
    let cfg = jmap_config(&m, None);

    rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-nodrafts", None))).expect("sent");

    assert_eq!(m.submitted().len(), 1);
    let sent = emails_in(&m, "mb-sent");
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(sent[0].1.contains(&"$seen".to_string()), "{sent:?}");
    assert!(!sent[0].1.contains(&"$draft".to_string()), "{sent:?}");
    let subs = submission_args(&m);
    assert!(subs[0].get("onSuccessUpdateEmail").is_none(), "nothing to move: {}", subs[0]);
}

/// A token without the Submission scope cannot send: refused before anything
/// is uploaded, with a code the app words as such.
#[test]
fn a_server_without_submission_is_refused_before_upload() {
    let m = MockJmap::start(send_scenario(&["alice@example.test"], true));
    m.mutate(|s| s.advertise_submission = false);
    let cfg = jmap_config(&m, None);

    let err = rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-nosub", None))).err().expect("no submission");

    assert!(err.starts_with("E_JMAP_NO_SUBMISSION"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert!(uploads(&m).is_empty());
    assert_eq!(m.count_calls("Email/import"), 0);
}

/// No password or token: `E_JMAP_AUTH` before any request leaves.
#[test]
fn a_jmap_account_without_credentials_is_refused_before_any_request() {
    let m = MockJmap::start(send_scenario(&["alice@example.test"], true));
    let mut cfg = jmap_config(&m, None);
    cfg.password = None;

    let err = rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-nocreds", None))).err().expect("no credentials");

    assert!(err.starts_with("E_JMAP_AUTH"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert!(m.requests().is_empty(), "{:?}", m.requests());
}

/// A message over the server's `maxSizeUpload` is refused before the upload.
#[test]
fn a_message_over_the_upload_limit_is_refused_before_upload() {
    let mut s = send_scenario(&["alice@example.test"], true);
    s.limits.max_size_upload = 100;
    let m = MockJmap::start(s);
    let cfg = jmap_config(&m, None);

    let err = rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-large", None))).err().expect("too large");

    assert!(err.starts_with("E_JMAP_TOO_LARGE"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert!(uploads(&m).is_empty());
}

// ── Scheduled Send (send_raw) ───────────────────────────────────────────────

/// A frozen message carries its Bcc in the envelope and its identity in the
/// envelope's From: Scheduled Send's account comes from the keychain, with no
/// send-as override, and must still go out as the alias it was written as.
#[test]
fn send_raw_sends_as_the_frozen_from_with_the_envelope_bcc() {
    let m = MockJmap::start(send_scenario(&["alice@example.test", "sales@example.test"], true));
    let cfg = jmap_config(&m, None);
    let as_sales = jmap_config(&m, Some("sales@example.test"));
    let frozen = smtp::build_draft_mime(&as_sales, &outgoing("jmap-raw", Some("carol@example.test"))).expect("build").raw_rfc2822;
    assert!(header_lines(&String::from_utf8_lossy(&frozen), "Bcc").is_empty(), "precondition: no Bcc in the frozen bytes");
    let envelope = FrozenEnvelope {
        from: "sales@example.test".into(),
        to: "bob@example.test".into(),
        cc: String::new(),
        bcc: "carol@example.test".into(),
    };

    let result = rt().block_on(smtp::send_raw(&cfg, &envelope, frozen)).expect("sent");

    assert!(result.server_saved_sent);
    let subs = submission_args(&m);
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0]["create"]["s"]["identityId"], json!("id2"), "sent as the frozen From, not the login");
    let up = uploads(&m);
    assert!(header_lines(&up[0].body, "Bcc")[0].contains("carol@example.test"), "{}", up[0].body);
}

// ── identities (Task 2 deferred: identities() and submit() untested) ────────

/// Every identity the server lists, with its id, address and name; the
/// request names the submission capability.
#[test]
fn jmap_identities_lists_every_identity() {
    let mut s = send_scenario(&[], true);
    s.accounts[0].identities = vec![("alice@example.test".into(), "Alice".into()), ("*@example.test".into(), "Anyone".into())];
    let m = MockJmap::start(s);
    let cfg = jmap_config(&m, None);

    let got = rt().block_on(smtp::jmap_identities(&cfg)).expect("identities");

    let flat: Vec<(&str, &str, &str)> = got.iter().map(|i| (i.id.as_str(), i.email.as_str(), i.name.as_str())).collect();
    assert_eq!(flat, vec![("id1", "alice@example.test", "Alice"), ("id2", "*@example.test", "Anyone")]);
    let bodies = api_bodies_with(&m, "Identity/get");
    assert_eq!(bodies.len(), 1);
    assert_using_submission(&bodies[0]);
}

/// `JmapClient::identities` and `submit` on their own: the submission goes
/// out for the given email as the given identity, with the patch applied.
#[test]
fn the_client_lists_identities_and_submits() {
    let m = MockJmap::start(send_scenario(&["alice@example.test"], true));
    let rt = rt();
    let auth = JmapAuth::Basic { username: "alice@example.test".into(), password: "pw".into() };
    let c = rt.block_on(JmapClient::connect(&m.session_url(), auth, "alice@example.test")).unwrap();
    assert!(c.has_submission());

    let ids = rt.block_on(c.identities()).unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!((ids[0].id.as_str(), ids[0].email.as_str()), ("id1", "alice@example.test"));

    let raw = b"From: alice@example.test\r\nTo: bob@example.test\r\nSubject: direct\r\nMessage-ID: <direct@example.test>\r\n\r\nbody";
    let blob = rt.block_on(c.upload(raw)).unwrap();
    let imported = match rt.block_on(c.import(&blob, &["mb-drafts".into()], &["$draft".into()], None)).unwrap() {
        mailvault_core::jmap::ImportResult::Created(i) => i,
        other => panic!("{other:?}"),
    };
    let sid = rt
        .block_on(c.submit(&imported.id, "id1", None, json!({"mailboxIds/mb-drafts": null, "mailboxIds/mb-sent": true})))
        .unwrap();
    assert!(!sid.is_empty());
    assert_eq!(m.submitted(), vec![raw.to_vec()]);
    assert_eq!(emails_in(&m, "mb-sent").len(), 1);
    assert!(emails_in(&m, "mb-drafts").is_empty());
}

// ── a submission whose answer never comes, or comes with an error ───────────

#[derive(Clone, Copy)]
enum Twist {
    /// Forward the submission, then close the connection without answering.
    DropAfterSubmission,
    /// Forward the submission, then answer nothing for 5 s.
    HangAfterSubmission,
    /// Forward the submission and append a method error to its answer, as a
    /// server whose implicit `Email/set` failed would.
    ImplicitSetFails,
}

/// A proxy in front of the mock's API (`State::api_url_override`) that passes
/// every request through and twists only the `EmailSubmission/set` one.
fn submission_proxy(m: Arc<MockJmap>, twist: Twist) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/jmap/api", listener.local_addr().unwrap());
    let api = format!("{}/jmap/api", m.base_url());
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { continue };
            let (auth, body) = read_post(&conn);
            let resp = http_request("POST", &api, &[("Authorization", auth.as_str()), ("Content-Type", "application/json")], &body);
            let mut answer = resp.body.clone();
            if String::from_utf8_lossy(&body).contains("EmailSubmission/set") {
                match twist {
                    Twist::DropAfterSubmission => {
                        let _ = conn.shutdown(std::net::Shutdown::Both);
                        continue;
                    }
                    Twist::HangAfterSubmission => {
                        std::thread::sleep(Duration::from_secs(5));
                        continue;
                    }
                    Twist::ImplicitSetFails => {
                        let mut v: Value = serde_json::from_slice(&resp.body).unwrap();
                        v["methodResponses"].as_array_mut().unwrap().push(json!(["error", {"type": "serverFail"}, "s"]));
                        answer = v.to_string().into_bytes();
                    }
                }
            }
            let head = format!(
                "HTTP/1.1 {} Proxied\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                resp.status,
                answer.len()
            );
            let _ = conn.write_all(head.as_bytes());
            let _ = conn.write_all(&answer);
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

fn proxied(twist: Twist) -> Arc<MockJmap> {
    let m = Arc::new(MockJmap::start(send_scenario(&["alice@example.test"], true)));
    let proxy = submission_proxy(Arc::clone(&m), twist);
    m.mutate(|s| s.api_url_override = Some(proxy));
    m
}

/// The server took the submission and the connection died before it
/// answered: the message may be out, so the error says so (terminal, never
/// retried) and the copy, by now the Sent copy, is kept.
#[test]
fn a_submission_with_no_answer_may_have_gone_out_and_keeps_the_copy() {
    let m = proxied(Twist::DropAfterSubmission);
    let cfg = jmap_config(&m, None);

    let err = rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-drop", None))).err().expect("no answer is not a success");

    assert!(err.contains("may have gone out"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert_eq!(m.submitted().len(), 1, "submitted once, never retried");
    assert_eq!(emails_in(&m, "mb-sent").len(), 1, "the Sent copy was destroyed");
    assert_eq!(m.count_calls("EmailSubmission/set"), 1);
}

/// `timeout` bounds the submission: an answer that does not come in time is
/// "may have gone out" too, and the copy is kept.
#[test]
fn a_submission_not_answered_in_time_may_have_gone_out() {
    let m = proxied(Twist::HangAfterSubmission);
    let cfg = jmap_config(&m, None);
    let raw = b"From: alice@example.test\r\nTo: bob@example.test\r\nSubject: jmap-hang\r\nMessage-ID: <jmap-hang@example.test>\r\n\r\nbody".to_vec();

    let err = rt().block_on(smtp::send_via_jmap(&cfg, raw, &[], Duration::from_secs(1))).err().expect("timed out");

    assert!(err.contains("timed out") && err.contains("may have gone out"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert_eq!(m.submitted().len(), 1);
    assert_eq!(emails_in(&m, "mb-sent").len(), 1, "the Sent copy was destroyed");
}

/// A created submission is a sent message even when the implicit `Email/set`
/// after it fails: reported as a failure, the copy would be destroyed and the
/// user would send it again.
#[test]
fn a_created_submission_is_sent_even_when_its_email_update_fails() {
    let m = proxied(Twist::ImplicitSetFails);
    let cfg = jmap_config(&m, None);

    let result = rt().block_on(smtp::send_email(&cfg, &outgoing("jmap-implicit", None))).expect("the submission was created");

    assert!(result.server_saved_sent);
    assert_eq!(m.submitted().len(), 1);
    assert_eq!(emails_in(&m, "mb-sent").len(), 1, "the sent copy was destroyed");
}
