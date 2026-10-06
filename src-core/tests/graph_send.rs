//! Sending from an Outlook.com account signed in with Microsoft (the Graph
//! transport, `oauth2Transport: "graph"`). Its token carries Graph scopes only,
//! which SMTP refuses, so both send paths (`send_built` for compose,
//! `send_raw` for Scheduled Send) must go through `POST /me/sendMail` instead,
//! whatever SMTP host the account does or does not have.
//!
//! `graph::graph_base()` is a process-wide `OnceLock`, so this binary talks to
//! ONE stub, started once on its own thread with the base override set in the
//! same initialiser, before any client exists (the `abd_graph_ops.rs` pattern).
//! Tests share it, so each one marks its messages with its own Subject and
//! reads back only the requests carrying that marker.

use base64::Engine;
use mailparse::MailHeaderMap;
use mailvault_core::imap::ImapConfig;
use mailvault_core::smtp::{self, FrozenEnvelope, OutgoingEmail};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};

// ── the stub ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Req {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

impl Req {
    /// The MIME a `sendMail` body carries, base64-decoded.
    fn mime(&self) -> String {
        let bytes = base64::engine::general_purpose::STANDARD.decode(self.body.trim()).unwrap_or_default();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

struct Stub {
    port: u16,
    log: Mutex<Vec<Req>>,
}

fn read_request(stream: &mut TcpStream) -> Option<Req> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p;
        }
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut parts = lines.next()?.split(' ');
    let method = parts.next()?.to_string();
    let path = parts.next()?.split('?').next()?.to_string();
    let mut headers = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let want: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body: Vec<u8> = buf[head_end + 4..].to_vec();
    while body.len() < want {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some(Req { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() })
}

/// What Graph answers a `sendMail` whose Subject names one of the refusal
/// cases; 202 Accepted (and nothing else) for everything else.
fn answer(req: &Req) -> (u16, Vec<(&'static str, &'static str)>, String) {
    let mime = req.mime();
    let error = |code: &str, message: &str| serde_json::json!({"error": {"code": code, "message": message}}).to_string();
    if mime.contains("Subject: case-401") {
        (401, vec![], error("InvalidAuthenticationToken", "Access token has expired or is not yet valid."))
    } else if mime.contains("Subject: case-403") {
        (403, vec![], error("ErrorAccessDenied", "Access is denied. Check credentials and try again."))
    } else if mime.contains("Subject: case-send-as") {
        (
            403,
            vec![],
            error(
                "ErrorSendAsDenied",
                "The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account., Cannot submit message.",
            ),
        )
    } else if mime.contains("Subject: case-429") {
        (429, vec![("Retry-After", "7")], error("ApplicationThrottled", "Application is over its MailboxConcurrency limit."))
    } else if mime.contains("Subject: case-500") {
        (500, vec![], error("InternalServerError", "Something went wrong."))
    } else {
        (202, vec![], String::new())
    }
}

fn serve(stub: &'static Stub, mut stream: TcpStream) {
    let Some(req) = read_request(&mut stream) else { return };
    stub.log.lock().unwrap().push(req.clone());
    let (status, extra, body) = if req.method == "POST" && req.path == "/me/sendMail" {
        answer(&req)
    } else {
        (404, vec![], r#"{"error":{"code":"NotMocked"}}"#.to_string())
    };
    let mut head = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn stub() -> &'static Stub {
    static STUB: OnceLock<&'static Stub> = OnceLock::new();
    STUB.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let s: &'static Stub = Box::leak(Box::new(Stub { port, log: Mutex::new(Vec::new()) }));
        // Before any client exists: the base is read once per process.
        std::env::set_var("MAILVAULT_GRAPH_BASE", format!("http://127.0.0.1:{port}"));
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                std::thread::spawn(move || serve(s, conn));
            }
        });
        s
    })
}

/// The `sendMail` requests whose MIME carries `marker`, oldest first.
fn sends_marked(marker: &str) -> Vec<Req> {
    stub().log.lock().unwrap().iter().filter(|r| r.path == "/me/sendMail" && r.mime().contains(marker)).cloned().collect()
}

// ── helpers ─────────────────────────────────────────────────────────────────

const TOKEN: &str = "graph-token-SECRET-123";
const ME: &str = "me@outlook.test";

/// An Outlook.com account as the app stores it: Graph transport, a Graph
/// token, and NO SMTP host or port at all.
fn graph_account() -> ImapConfig {
    stub();
    serde_json::from_value(serde_json::json!({
        "email": ME,
        "name": "Me Myself",
        "imapHost": "outlook.office365.com",
        "authType": "oauth2",
        "oauth2Transport": "graph",
        "oauth2AccessToken": TOKEN,
    }))
    .expect("ImapConfig")
}

fn email(subject: &str, bcc: Option<&str>) -> OutgoingEmail {
    serde_json::from_value(serde_json::json!({
        "to": "Partner <partner@example.com>",
        "bcc": bcc,
        "subject": subject,
        "text": "body",
        "messageId": format!("<{subject}@outlook.test>"),
    }))
    .expect("OutgoingEmail")
}

/// The header block of `mime` (everything before the first blank line).
fn header_block(mime: &str) -> &str {
    mime.split("\r\n\r\n").next().unwrap_or("")
}

/// The unfolded header lines named `name`, case-insensitively.
fn header_lines(mime: &str, name: &str) -> Vec<String> {
    let unfolded = header_block(mime).replace("\r\n ", " ").replace("\r\n\t", " ");
    let prefix = format!("{}:", name.to_ascii_lowercase());
    unfolded.split("\r\n").filter(|l| l.to_ascii_lowercase().starts_with(&prefix)).map(str::to_string).collect()
}

// ── compose (send_built) ────────────────────────────────────────────────────

/// The reported bug (discussion #22): every send from an Outlook.com account
/// went to smtp.office365.com with the Graph token and came back
/// "Authentication failed". It goes to `/me/sendMail`, as the MIME compose
/// built, Bcc included (Graph has no envelope: it reads recipients off the
/// headers), and it needs no SMTP server to do it.
#[tokio::test]
async fn a_graph_account_with_no_smtp_server_sends_through_send_mail() {
    let cfg = graph_account();
    assert!(cfg.smtp_host.is_none() && cfg.smtp_port.is_none());

    let result = smtp::send_email(&cfg, &email("graph-send-basic", Some("Hidden Person <hidden@example.com>")))
        .await
        .expect("a Graph account sends through Graph");

    let sent = sends_marked("graph-send-basic");
    assert_eq!(sent.len(), 1, "exactly one sendMail");
    let req = &sent[0];
    assert_eq!(req.method, "POST");
    assert_eq!(req.path, "/me/sendMail");
    assert!(req.headers.get("content-type").is_some_and(|v| v.starts_with("text/plain")), "{:?}", req.headers);
    assert_eq!(req.headers.get("authorization").map(String::as_str), Some(&*format!("Bearer {TOKEN}")));

    let mime = req.mime();
    let to = header_lines(&mime, "To");
    assert_eq!(to.len(), 1, "{mime}");
    assert!(to[0].contains("partner@example.com"), "{mime}");
    let bcc = header_lines(&mime, "Bcc");
    assert_eq!(bcc.len(), 1, "Graph reads Bcc off the MIME, so it must be there once: {mime}");
    assert!(bcc[0].contains("hidden@example.com"), "{mime}");
    assert_eq!(header_lines(&mime, "Message-ID"), vec!["Message-ID: <graph-send-basic@outlook.test>".to_string()], "{mime}");
    // The bytes handed back are the bytes that went out.
    assert_eq!(String::from_utf8_lossy(&result.raw_rfc2822), mime);

    // Network Activity shows it as this account's send, like the SMTP event.
    let port = stub().port;
    let events: Vec<_> = mailvault_core::net_activity::snapshot()
        .into_iter()
        .filter(|e| e.port == port && e.purpose == "send" && e.account.as_deref() == Some(ME))
        .collect();
    assert!(!events.is_empty(), "no Network Activity event for the send");
}

/// Without a Bcc there is no Bcc header at all, not an empty one.
#[tokio::test]
async fn a_graph_send_without_bcc_adds_no_bcc_header() {
    smtp::send_email(&graph_account(), &email("graph-send-nobcc", None)).await.expect("sent");
    let sent = sends_marked("graph-send-nobcc");
    assert_eq!(sent.len(), 1);
    assert!(header_lines(&sent[0].mime(), "Bcc").is_empty(), "{}", sent[0].mime());
}

// ── Scheduled Send (send_raw) ───────────────────────────────────────────────

fn envelope(bcc: &str) -> FrozenEnvelope {
    FrozenEnvelope { from: ME.to_string(), to: "partner@example.com".to_string(), cc: String::new(), bcc: bcc.to_string() }
}

/// A scheduled message is frozen through `build_draft_mime`, which (lettre's
/// default) leaves Bcc out of the bytes: the Bcc lives in the stored envelope.
/// For Graph it has to go back into the MIME, or those recipients get nothing.
#[tokio::test]
async fn send_raw_for_graph_puts_the_envelope_bcc_into_the_frozen_bytes() {
    let cfg = graph_account();
    let frozen = smtp::build_draft_mime(&cfg, &email("graph-raw-bcc", Some("Hidden Person <hidden@example.com>")))
        .expect("build_draft_mime")
        .raw_rfc2822;
    let frozen_text = String::from_utf8_lossy(&frozen).into_owned();
    assert!(header_lines(&frozen_text, "Bcc").is_empty(), "precondition: frozen bytes carry no Bcc: {frozen_text}");

    smtp::send_raw(&cfg, &envelope("Hidden Person <hidden@example.com>"), frozen.clone()).await.expect("sent through Graph");

    let sent = sends_marked("graph-raw-bcc");
    assert_eq!(sent.len(), 1);
    let mime = sent[0].mime();
    let bcc = header_lines(&mime, "Bcc");
    assert_eq!(bcc.len(), 1, "{mime}");
    assert!(bcc[0].contains("hidden@example.com"), "{mime}");
    // Nothing else about the frozen bytes changed: take the one inserted
    // header out again and they are what was frozen.
    let inserted = mime.split("\r\n").find(|l| l.to_ascii_lowercase().starts_with("bcc:")).unwrap();
    assert_eq!(mime.replacen(&format!("{inserted}\r\n"), "", 1), frozen_text);
}

/// A Bcc header already in the frozen bytes is theirs: left exactly as it is.
#[tokio::test]
async fn send_raw_for_graph_leaves_an_existing_bcc_header_alone() {
    let cfg = graph_account();
    let frozen = "From: me@outlook.test\r\nTo: partner@example.com\r\nBcc: kept@example.com\r\nSubject: graph-raw-kept\r\nMessage-ID: <graph-raw-kept@outlook.test>\r\n\r\nbody\r\n";

    smtp::send_raw(&cfg, &envelope("other@example.com"), frozen.as_bytes().to_vec()).await.expect("sent");

    let sent = sends_marked("graph-raw-kept");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].mime(), frozen, "the bytes must go out untouched");
}

/// The inserted header is a real one: a non-ASCII name is RFC 2047 encoded,
/// a long list is folded under the line limit, and a MIME parser reads every
/// address back.
#[tokio::test]
async fn send_raw_for_graph_encodes_and_folds_the_inserted_bcc() {
    let cfg = graph_account();
    let frozen = smtp::build_draft_mime(&cfg, &email("graph-raw-fold", None)).expect("build").raw_rfc2822;
    let many = "Jürgen Müller <j@example.com>, a.long.address.one@example.com, a.long.address.two@example.com, \
                a.long.address.three@example.com, a.long.address.four@example.com, \"Doe, Jane\" <jane@example.com>";

    smtp::send_raw(&cfg, &envelope(many), frozen).await.expect("sent");

    let sent = sends_marked("graph-raw-fold");
    assert_eq!(sent.len(), 1);
    let mime = sent[0].mime();
    let block = header_block(&mime);
    assert!(block.lines().all(|l| l.len() <= 998), "{block}");
    assert!(block.to_ascii_lowercase().contains("=?utf-8?"), "the non-ASCII name must be encoded: {block}");
    assert!(block.is_ascii(), "{block}");

    let parsed = mailparse::parse_mail(mime.as_bytes()).expect("a parseable message");
    let bcc = parsed.headers.get_first_value("Bcc").expect("a Bcc header");
    for want in [
        "Jürgen Müller",
        "j@example.com",
        "a.long.address.one@example.com",
        "a.long.address.two@example.com",
        "a.long.address.three@example.com",
        "a.long.address.four@example.com",
        "jane@example.com",
    ] {
        assert!(bcc.contains(want), "{want} missing from {bcc:?}");
    }
}

// ── refusals ────────────────────────────────────────────────────────────────

/// Graph caps a request body at 4 MB, and the MIME goes base64-encoded, so a
/// message much over 3 MB cannot go this way. It is refused before any
/// request, with the limit named, rather than sent to be bounced.
#[tokio::test]
async fn a_graph_send_over_4_mb_is_refused_before_any_request() {
    let cfg = graph_account();
    let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 3_500_000]);
    let mail: OutgoingEmail = serde_json::from_value(serde_json::json!({
        "to": "partner@example.com",
        "subject": "graph-too-big",
        "text": "body",
        "attachments": [{"filename": "big.bin", "content": big, "contentType": "application/octet-stream"}],
    }))
    .unwrap();

    let err = smtp::send_email(&cfg, &mail).await.err().expect("over the cap must be refused");
    assert!(err.contains("4 MB"), "the error must name the limit: {err}");
    assert!(!err.contains("SMTP"), "{err}");
    let made = stub().log.lock().unwrap().iter().filter(|r| r.path == "/me/sendMail" && r.body.len() > 4 * 1024 * 1024).count();
    assert_eq!(made, 0, "no request may be made for an oversized message");
}

/// What the user reads when Graph says no. Never the SMTP "Authentication
/// failed for smtp.office365.com" the bug report quoted: there was no SMTP.
#[tokio::test]
async fn graph_refusals_are_worded_for_what_happened() {
    let cfg = graph_account();
    let cases = [
        ("case-401", "Sign in to this account again"),
        ("case-403", "Sign in to this account again"),
        ("case-send-as", "refused to send as me@outlook.test"),
        ("case-429", "429"),
        ("case-500", "500"),
    ];
    for (subject, want) in cases {
        let err = smtp::send_email(&cfg, &email(subject, None)).await.err().expect(subject);
        assert!(err.contains(want), "{subject}: {err}");
        assert!(!err.contains("Authentication failed for"), "{subject}: {err}");
        assert!(!err.contains("SMTP"), "{subject}: {err}");
        assert!(!err.contains('\u{2014}'), "{subject}: no em dash in a new message: {err}");
        assert_eq!(sends_marked(&format!("Subject: {subject}")).len(), 1, "{subject}: sent once, never retried");
    }
}

/// No token at all is a sign-in problem too, and nothing is sent.
#[tokio::test]
async fn a_graph_account_without_a_token_is_told_to_sign_in_again() {
    let mut cfg = graph_account();
    cfg.access_token = None;
    let err = smtp::send_email(&cfg, &email("graph-no-token", None)).await.err().expect("no token");
    assert!(err.contains("Sign in to this account again"), "{err}");
    assert!(sends_marked("graph-no-token").is_empty());
}
