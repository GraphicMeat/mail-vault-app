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
//!
//! The stub also plays Graph's habit that started the alias work: a `sendMail`
//! goes out as the mailbox's primary address whatever the MIME's From says,
//! while a draft whose `from` was PATCHed to an alias goes out as that alias.

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
    /// The MIME of the message this request belongs to: its own body for a
    /// `sendMail` or a draft create, the draft's for a request on a draft.
    ctx: String,
}

impl Req {
    /// The MIME a `sendMail` body carries, base64-decoded.
    fn mime(&self) -> String {
        let bytes = base64::engine::general_purpose::STANDARD.decode(self.body.trim()).unwrap_or_default();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// A draft the stub holds. `from` is what Graph would send it as: the
/// primary address until a PATCH sets another.
struct Draft {
    mime: String,
    from: String,
    deleted: bool,
}

struct Stub {
    port: u16,
    log: Mutex<Vec<Req>>,
    drafts: Mutex<HashMap<String, Draft>>,
    /// Each message Graph accepted for delivery: its MIME and the address it
    /// went out as.
    delivered: Mutex<Vec<(String, String)>>,
    next_draft: std::sync::atomic::AtomicUsize,
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
    Some(Req { method, path, headers, body: String::from_utf8_lossy(&body).into_owned(), ctx: String::new() })
}

/// What Graph answers a `sendMail` whose Subject names one of the refusal
/// cases; 202 Accepted (and nothing else) for everything else.
fn answer(req: &Req) -> (u16, Vec<(&'static str, &'static str)>, String) {
    let mime = &req.ctx;
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
    let Some(mut req) = read_request(&mut stream) else { return };
    let draft_id = req.path.strip_prefix("/me/messages/").map(|rest| rest.split('/').next().unwrap_or("").to_string());
    req.ctx = match &draft_id {
        Some(id) => stub.drafts.lock().unwrap().get(id).map(|d| d.mime.clone()).unwrap_or_default(),
        None => req.mime(),
    };
    stub.log.lock().unwrap().push(req.clone());
    // Graph took the whole request, and the connection died before it
    // answered: from the client's side, the message may or may not have gone.
    let sending = req.path == "/me/sendMail" || (req.method == "POST" && req.path.ends_with("/send"));
    if sending && req.ctx.contains("Subject: case-drop") {
        return;
    }
    let (status, extra, body) = route(stub, &req, draft_id.as_deref());
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

fn route(stub: &Stub, req: &Req, draft_id: Option<&str>) -> (u16, Vec<(&'static str, &'static str)>, String) {
    let error = |code: &str, message: &str| serde_json::json!({"error": {"code": code, "message": message}}).to_string();
    match (req.method.as_str(), req.path.as_str()) {
        // Graph sends as the mailbox's primary address, the MIME's From aside.
        ("POST", "/me/sendMail") => {
            let out = answer(req);
            if out.0 == 202 {
                stub.delivered.lock().unwrap().push((req.ctx.clone(), ME.to_string()));
            }
            out
        }
        ("POST", "/me/messages") => {
            let out = answer(req);
            if out.0 != 202 {
                return out;
            }
            let id = format!("draft-{}", stub.next_draft.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
            stub.drafts.lock().unwrap().insert(id.clone(), Draft { mime: req.ctx.clone(), from: ME.to_string(), deleted: false });
            (201, vec![], serde_json::json!({"id": id}).to_string())
        }
        (method, path) if draft_id.is_some() => {
            let id = draft_id.unwrap();
            let rest = &path["/me/messages/".len() + id.len()..];
            let mut drafts = stub.drafts.lock().unwrap();
            let Some(draft) = drafts.get_mut(id).filter(|d| !d.deleted) else {
                return (404, vec![], error("ErrorItemNotFound", "The specified object was not found in the store."));
            };
            match (method, rest) {
                ("PATCH", "") => {
                    if draft.mime.contains("Subject: case-patch-denied") {
                        return (403, vec![], error("ErrorSendAsDenied", "The user account does not have the right to send mail on behalf of the specified sending account."));
                    }
                    let patch: serde_json::Value = serde_json::from_str(&req.body).unwrap_or_default();
                    if !draft.mime.contains("Subject: case-from-ignored") {
                        if let Some(address) = patch["from"]["emailAddress"]["address"].as_str() {
                            draft.from = address.to_string();
                        }
                    }
                    (200, vec![], serde_json::json!({"id": id}).to_string())
                }
                ("GET", "") if draft.mime.contains("Subject: case-verify-garbled") => (200, vec![], "<<not json>>".to_string()),
                ("GET", "") => (
                    200,
                    vec![],
                    serde_json::json!({"id": id, "from": {"emailAddress": {"address": draft.from, "name": ""}}}).to_string(),
                ),
                ("POST", "/send") if draft.mime.contains("Subject: case-send-throttled") => {
                    (429, vec![("Retry-After", "7")], error("ApplicationThrottled", "Application is over its MailboxConcurrency limit."))
                }
                ("POST", "/send") if draft.mime.contains("Subject: case-send-500") => {
                    (500, vec![], error("InternalServerError", "Something went wrong."))
                }
                ("POST", "/send") => {
                    stub.delivered.lock().unwrap().push((draft.mime.clone(), draft.from.clone()));
                    draft.deleted = true;
                    (202, vec![], String::new())
                }
                ("POST", "/permanentDelete") => {
                    draft.deleted = true;
                    (204, vec![], String::new())
                }
                _ => (404, vec![], r#"{"error":{"code":"NotMocked"}}"#.to_string()),
            }
        }
        _ => (404, vec![], r#"{"error":{"code":"NotMocked"}}"#.to_string()),
    }
}

fn stub() -> &'static Stub {
    static STUB: OnceLock<&'static Stub> = OnceLock::new();
    STUB.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let s: &'static Stub = Box::leak(Box::new(Stub {
            port,
            log: Mutex::new(Vec::new()),
            drafts: Mutex::new(HashMap::new()),
            delivered: Mutex::new(Vec::new()),
            next_draft: std::sync::atomic::AtomicUsize::new(1),
        }));
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

/// Every request of one message's send, oldest first, as `METHOD path` with
/// the draft's id written `{id}`: `sendMail` alone, or create, patch, send.
fn trail(marker: &str) -> Vec<String> {
    stub()
        .log
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.ctx.contains(marker))
        .map(|r| {
            let path = match r.path.strip_prefix("/me/messages/") {
                Some(rest) => format!("/me/messages/{{id}}{}", rest.split_once('/').map(|(_, tail)| format!("/{tail}")).unwrap_or_default()),
                None => r.path.clone(),
            };
            format!("{} {}", r.method, path)
        })
        .collect()
}

/// The requests of one message's send that start with `what` ("METHOD path"),
/// oldest first, cloned out so no assert runs under the stub's lock.
fn requests_marked(marker: &str, what: &str) -> Vec<Req> {
    stub()
        .log
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.ctx.contains(marker) && format!("{} {}", r.method, r.path).starts_with(what))
        .cloned()
        .collect()
}

/// The address each delivery of the message marked `marker` went out as.
fn delivered_from(marker: &str) -> Vec<String> {
    stub().delivered.lock().unwrap().iter().filter(|(mime, _)| mime.contains(marker)).map(|(_, from)| from.clone()).collect()
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

/// Graph read the whole request and the connection died before it answered,
/// so the message may well have gone out. That is not "could not reach
/// Microsoft", which Scheduled Send tries again into a second copy: it says to
/// check Sent, and no retry may follow it. Nothing here retried either.
#[tokio::test]
async fn a_send_graph_took_but_never_answered_may_have_gone_out() {
    let err = smtp::send_email(&graph_account(), &email("case-drop", None)).await.err().expect("no answer is not a success");
    assert!(err.contains("may have gone out"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "a send that may have gone out must never be retried: {err}");
    assert!(!err.contains("Could not reach"), "{err}");
    assert_eq!(sends_marked("Subject: case-drop").len(), 1, "sent once, never retried");
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

// ── sending as an alias ─────────────────────────────────────────────────────

/// An address of the same Microsoft account, other than the login.
const ALIAS: &str = "me-alias@outlook.test";

/// The account as compose sends it from `ALIAS`: the per-send `fromEmail`.
fn alias_account() -> ImapConfig {
    let mut cfg = graph_account();
    cfg.from_email = Some(ALIAS.to_string());
    cfg
}

const CREATE: &str = "POST /me/messages";
const PATCH: &str = "PATCH /me/messages/{id}";
const VERIFY: &str = "GET /me/messages/{id}";
const SEND: &str = "POST /me/messages/{id}/send";
const DISCARD: &str = "POST /me/messages/{id}/permanentDelete";

/// The reported bug: a mail sent from an alias of an Outlook.com account came
/// out as the login. `sendMail` takes its sender from the mailbox, whatever
/// the MIME's From says, so an alias goes through a draft whose `from` is set
/// to it: created from the MIME (every header and the Message-ID kept), the
/// `from` PATCHed, then sent.
#[tokio::test]
async fn a_graph_send_from_an_alias_goes_out_as_the_alias() {
    let result = smtp::send_email(&alias_account(), &email("graph-alias-basic", Some("Hidden Person <hidden@example.com>")))
        .await
        .expect("an alias send goes through Graph");

    assert_eq!(delivered_from("graph-alias-basic"), vec![ALIAS.to_string()], "the recipient must see the alias");
    assert_eq!(trail("graph-alias-basic"), vec![CREATE, PATCH, VERIFY, SEND], "a draft, never sendMail");

    let create = requests_marked("graph-alias-basic", "POST /me/messages").remove(0);
    assert!(create.headers.get("content-type").is_some_and(|v| v.starts_with("text/plain")), "{:?}", create.headers);
    assert_eq!(create.headers.get("authorization").map(String::as_str), Some(&*format!("Bearer {TOKEN}")));
    let mime = create.mime();
    assert_eq!(header_lines(&mime, "Message-ID"), vec!["Message-ID: <graph-alias-basic@outlook.test>".to_string()], "{mime}");
    assert!(header_lines(&mime, "From")[0].contains(ALIAS), "{mime}");
    let bcc = header_lines(&mime, "Bcc");
    assert_eq!(bcc.len(), 1, "Graph reads Bcc off the MIME, so it must be there once: {mime}");
    assert!(bcc[0].contains("hidden@example.com"), "{mime}");
    // The bytes handed back are the bytes the draft was made from.
    assert_eq!(String::from_utf8_lossy(&result.raw_rfc2822), mime);
    assert!(result.server_saved_sent, "Graph files the Sent copy of a sent draft itself");

    let patch = requests_marked("graph-alias-basic", "PATCH").remove(0);
    let body: serde_json::Value = serde_json::from_str(&patch.body).expect("a JSON patch");
    assert_eq!(body, serde_json::json!({"from": {"emailAddress": {"address": ALIAS, "name": "Me Myself"}}}));
    assert!(patch.headers.get("content-type").is_some_and(|v| v.starts_with("application/json")), "{:?}", patch.headers);
}

/// The login's own address keeps the one `sendMail` it always had, whatever
/// the case of the send-as setting: no draft, no extra permission.
#[tokio::test]
async fn a_graph_send_from_the_login_stays_one_send_mail() {
    for (marker, from_email) in [("graph-login-none", None), ("graph-login-same", Some(ME)), ("graph-login-case", Some("ME@Outlook.Test"))] {
        let mut cfg = graph_account();
        cfg.from_email = from_email.map(String::from);
        smtp::send_email(&cfg, &email(marker, None)).await.expect(marker);
        assert_eq!(trail(marker), vec!["POST /me/sendMail"], "{marker}");
        assert_eq!(delivered_from(marker), vec![ME.to_string()], "{marker}");
    }
}

/// A draft Microsoft keeps under the login after the PATCH is not sent: the
/// user chose the alias to keep the login private, so the send is refused,
/// with the wording of every other send-as refusal, and the draft goes.
#[tokio::test]
async fn an_alias_microsoft_does_not_apply_is_refused_and_the_draft_removed() {
    let err = smtp::send_email(&alias_account(), &email("case-from-ignored", None)).await.err().expect("the login must not stand in");
    assert!(err.contains(&format!("refused to send as {ALIAS}")), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "a refused sender is never retried: {err}");
    assert!(!err.contains("SMTP") && !err.contains('\u{2014}'), "{err}");
    assert_eq!(trail("case-from-ignored"), vec![CREATE, PATCH, VERIFY, DISCARD]);
    assert!(delivered_from("case-from-ignored").is_empty(), "nothing may go out as the login");
}

/// Microsoft refusing the PATCH itself says the same, and cleans up the same.
#[tokio::test]
async fn an_alias_microsoft_refuses_to_set_is_refused_and_the_draft_removed() {
    let err = smtp::send_email(&alias_account(), &email("case-patch-denied", None)).await.err().expect("refused");
    assert!(err.contains(&format!("refused to send as {ALIAS}")), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert_eq!(trail("case-patch-denied"), vec![CREATE, PATCH, DISCARD]);
    assert!(delivered_from("case-patch-denied").is_empty());
}

/// Graph read the send and never answered: as for `sendMail`, it may have
/// gone out, nothing retries it, and the draft is not touched.
#[tokio::test]
async fn an_alias_send_graph_took_but_never_answered_may_have_gone_out() {
    let err = smtp::send_email(&alias_account(), &email("case-drop-alias", None)).await.err().expect("no answer is not a success");
    assert!(err.contains("may have gone out"), "{err}");
    assert!(smtp::is_terminal_send_error(&err), "{err}");
    assert_eq!(trail("case-drop-alias"), vec![CREATE, PATCH, VERIFY, SEND], "sent once, no cleanup after an unconfirmed send");
}

/// A refusal of the draft itself (no sign-in, a throttle) is worded as it is
/// for `sendMail`, and there is no draft to remove.
#[tokio::test]
async fn an_alias_send_whose_draft_is_refused_is_worded_as_a_send_refusal() {
    let err = smtp::send_email(&alias_account(), &email("case-429-alias", None)).await.err().expect("throttled");
    assert!(err.contains("429") && err.contains("limiting"), "{err}");
    assert_eq!(trail("case-429-alias"), vec![CREATE]);
    assert!(delivered_from("case-429-alias").is_empty());
}

/// Scheduled Send: the stored account carries no per-send `fromEmail`; the
/// frozen envelope's From is the identity, and the name is the one the bytes
/// were built under (the alias's own), not the stored account's.
#[tokio::test]
async fn a_scheduled_graph_send_from_an_alias_goes_out_as_the_alias() {
    let mut built_as = alias_account();
    built_as.name = Some("Support Team".to_string());
    let frozen = smtp::build_draft_mime(&built_as, &email("graph-alias-raw", None)).expect("build").raw_rfc2822;
    let envelope = FrozenEnvelope { from: ALIAS.to_string(), to: "partner@example.com".to_string(), cc: String::new(), bcc: String::new() };

    smtp::send_raw(&graph_account(), &envelope, frozen).await.expect("sent through Graph");

    assert_eq!(delivered_from("graph-alias-raw"), vec![ALIAS.to_string()]);
    assert_eq!(trail("graph-alias-raw"), vec![CREATE, PATCH, VERIFY, SEND]);
    let patch = requests_marked("graph-alias-raw", "PATCH").remove(0);
    let body: serde_json::Value = serde_json::from_str(&patch.body).expect("a JSON patch");
    assert_eq!(body, serde_json::json!({"from": {"emailAddress": {"address": ALIAS, "name": "Support Team"}}}));
}

/// A name the MIME encodes (RFC 2047) is the name the draft gets, decoded.
#[tokio::test]
async fn an_alias_name_with_non_ascii_letters_reaches_the_draft_decoded() {
    let mut cfg = alias_account();
    cfg.name = Some("Jürgen Müller".to_string());
    smtp::send_email(&cfg, &email("graph-alias-name", None)).await.expect("sent");
    let patch = requests_marked("graph-alias-name", "PATCH").remove(0);
    let body: serde_json::Value = serde_json::from_str(&patch.body).expect("a JSON patch");
    assert_eq!(body["from"]["emailAddress"]["name"], "Jürgen Müller");
}

/// Graph says no to the send itself (a throttle): nothing went out, so the
/// draft goes, and the words are the throttle's.
#[tokio::test]
async fn an_alias_send_graph_refuses_outright_removes_the_draft() {
    let err = smtp::send_email(&alias_account(), &email("case-send-throttled", None)).await.err().expect("throttled");
    assert!(err.contains("429") && err.contains("7 seconds"), "{err}");
    assert!(!smtp::is_terminal_send_error(&err), "a throttle is tried again: {err}");
    assert_eq!(trail("case-send-throttled"), vec![CREATE, PATCH, VERIFY, SEND, DISCARD]);
    assert!(delivered_from("case-send-throttled").is_empty());
}

/// A server fault on the send can come from a gateway in front of an Exchange
/// that took the message: the draft may already be the sent mail, so it stays.
#[tokio::test]
async fn an_alias_send_that_fails_with_a_server_fault_keeps_the_draft() {
    let err = smtp::send_email(&alias_account(), &email("case-send-500", None)).await.err().expect("server fault");
    assert!(err.contains("500"), "{err}");
    assert_eq!(trail("case-send-500"), vec![CREATE, PATCH, VERIFY, SEND], "no delete after a send that may have gone");
}

/// An answer to the sender check that cannot be read says nothing about the
/// sender: not the final "refused to send as", a fault to try again.
#[tokio::test]
async fn an_unreadable_sender_check_is_not_a_refused_sender() {
    let err = smtp::send_email(&alias_account(), &email("case-verify-garbled", None)).await.err().expect("unreadable");
    assert!(!err.contains("refused to send as"), "{err}");
    assert!(!smtp::is_terminal_send_error(&err), "{err}");
    assert_eq!(trail("case-verify-garbled"), vec![CREATE, PATCH, VERIFY, DISCARD]);
    assert!(delivered_from("case-verify-garbled").is_empty());
}

/// The draft's body is capped like `sendMail`'s: refused before any request.
#[tokio::test]
async fn an_alias_send_over_4_mb_is_refused_before_any_request() {
    let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 3_500_000]);
    let mail: OutgoingEmail = serde_json::from_value(serde_json::json!({
        "to": "partner@example.com",
        "subject": "graph-alias-too-big",
        "text": "body",
        "attachments": [{"filename": "big.bin", "content": big, "contentType": "application/octet-stream"}],
    }))
    .unwrap();

    let err = smtp::send_email(&alias_account(), &mail).await.err().expect("over the cap must be refused");
    assert!(err.contains("4 MB"), "{err}");
    assert!(trail("graph-alias-too-big").is_empty(), "no request may be made for an oversized message");
}
