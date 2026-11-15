//! `mobile.ai.*` against a fake OpenAI-compatible endpoint on loopback: the settings gates, the
//! Gmail rule, the review rule, key hygiene and quick replies.

use super::*;
use crate::MemorySecrets;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

const KEY: &str = "sk-test-SECRET-1234";

fn engine() -> (tempfile::TempDir, Engine) {
    let tmp = tempfile::tempdir().unwrap();
    let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(MemorySecrets::default())).unwrap();
    e.write(|c| {
        c.execute_batch(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, kind, auth, provider, needs_auth, created_ms) VALUES
               ('plain', 'me@example.test', '', 'imap.example.test', 993, 'ssl', 'imap', 'password', NULL, 0, 1),
               ('gmail', 'me@gmail.com', '', 'imap.gmail.com', 993, 'ssl', 'imap', 'oauth2', 'google', 0, 2),
               ('gmailpw', 'pw@gmail.com', '', 'imap.gmail.com', 993, 'ssl', 'imap', 'password', NULL, 0, 3);",
        )
    })
    .unwrap();
    (tmp, e)
}

/// A stored message: `automated` is the sync's thread_json flag (`None`: a row from before it).
fn message(e: &Engine, account: &str, uid: i64, from: &str, subject: &str, text: &str, automated: Option<bool>) {
    let mut thread = json!({ "cc": [], "replyTo": [], "references": [format!("<root-{uid}@x>")], "inReplyTo": null, "date": null });
    if let Some(a) = automated {
        thread["automated"] = json!(a);
    }
    e.write(|c| {
        c.execute(
            "INSERT INTO messages (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, to_json, thread_json, message_id)
             VALUES (?1, 'INBOX', ?2, ?3, '', ?4, 0, '', 0, 0, 0, '[]', ?5, ?6)",
            rusqlite::params![account, uid, subject, from, thread.to_string(), format!("<m{uid}@x>")],
        )?;
        c.execute("INSERT INTO bodies (account_id, folder, uid, text, html) VALUES (?1, 'INBOX', ?2, ?3, NULL)", rusqlite::params![account, uid, text])?;
        Ok(())
    })
    .unwrap();
}

/// One request the fake endpoint got: its Authorization header and its body.
#[derive(Clone, Debug)]
struct Seen {
    auth: Option<String>,
    body: Value,
}

struct Fake {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Fake {
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

/// A loopback endpoint answering every request with `status` and `reply(auth)`.
fn fake(status: u16, reply: impl Fn(Option<&str>) -> String + Send + 'static) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/v1", listener.local_addr().unwrap().port());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut auth = None;
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some((k, v)) = line.split_once(':') {
                    match k.trim().to_ascii_lowercase().as_str() {
                        "authorization" => auth = Some(v.trim().to_string()),
                        "content-length" => length = v.trim().parse().unwrap_or(0),
                        _ => {}
                    }
                }
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            log.lock().unwrap().push(Seen { auth: auth.clone(), body: serde_json::from_slice(&body).unwrap_or(Value::Null) });
            let out = reply(auth.as_deref());
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                out.len()
            );
        }
    });
    Fake { url, seen }
}

fn chat(text: &str) -> String {
    json!({ "choices": [{ "message": { "role": "assistant", "content": text } }] }).to_string()
}

fn on(e: &Engine, url: &str) {
    e.rpc("mobile.prefs.set", json!({ "aiEnabled": true, "aiEndpointUrl": url, "aiEndpointModel": "llama3" })).unwrap();
}

fn read_action(uid: i64, account: &str, action: &str) -> Value {
    json!({ "action": action, "accountId": account, "folder": "INBOX", "uid": uid })
}

// ── Settings gates ────────────────────────────────────────────────────────────

#[test]
fn nothing_is_sent_while_off_or_without_an_endpoint() {
    let (_tmp, e) = engine();
    let server = fake(200, |_| chat("hi"));
    let test = json!({ "action": "test", "confirmed": true });
    assert_eq!(e.rpc("mobile.ai.run", test.clone()).unwrap(), json!({ "ok": false, "code": "AI_OFF" }));
    e.rpc("mobile.prefs.set", json!({ "aiEnabled": true })).unwrap();
    assert_eq!(e.rpc("mobile.ai.run", test.clone()).unwrap()["code"], "AI_NOT_CONFIGURED");
    e.rpc("mobile.prefs.set", json!({ "aiEndpointUrl": "localhost:11434/v1" })).unwrap();
    assert_eq!(e.rpc("mobile.ai.run", test.clone()).unwrap()["code"], "AI_NOT_CONFIGURED", "not an http(s) URL");
    assert!(server.seen().is_empty());
    e.rpc("mobile.prefs.set", json!({ "aiEndpointUrl": &server.url, "aiEndpointModel": "llama3" })).unwrap();
    assert_eq!(e.rpc("mobile.ai.run", test).unwrap(), json!({ "ok": true, "text": "hi" }));
    let seen = server.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].body["model"], "llama3");
    assert_eq!(seen[0].body["messages"][0]["content"], TEST_PROMPT);
    assert_eq!(seen[0].auth, None, "no key stored: no Authorization");
}

#[test]
fn the_preview_is_exactly_what_is_sent() {
    let (_tmp, e) = engine();
    let server = fake(200, |_| chat("Short summary."));
    on(&e, &server.url);
    message(&e, "plain", 7, "ann@example.test", "Lunch", "Can we meet on Friday at noon?", Some(false));
    for action in ["summarize", "actionItems", "draftReply"] {
        let preview = e.rpc("mobile.ai.prompt", read_action(7, "plain", action)).unwrap();
        assert_eq!(preview["ok"], true, "{action}");
        assert_eq!(preview["destination"], server.url);
        assert_eq!(preview["leavesDevice"], false, "loopback is this device");
        assert!(preview["prompt"].as_str().unwrap().contains("Can we meet on Friday at noon?"));
        let mut run = read_action(7, "plain", action);
        run["confirmed"] = json!(true);
        assert_eq!(e.rpc("mobile.ai.run", run).unwrap(), json!({ "ok": true, "text": "Short summary." }));
        let sent = server.seen().last().unwrap().body.clone();
        assert_eq!(sent["messages"][0]["content"], preview["prompt"], "{action}: the reviewed text is the sent text");
    }
    let draft = json!({ "action": "tone", "tone": "formal", "accountId": "plain", "text": "hey, send it over pls" });
    let preview = e.rpc("mobile.ai.prompt", draft.clone()).unwrap();
    assert!(preview["prompt"].as_str().unwrap().contains("more formal tone"));
    assert!(preview["prompt"].as_str().unwrap().ends_with("hey, send it over pls"));
    assert_eq!(e.rpc("mobile.ai.prompt", json!({ "action": "shorten", "accountId": "plain", "text": "  " })).unwrap()["code"], "NO_TEXT");
    assert_eq!(e.rpc("mobile.ai.prompt", json!({ "action": "tone", "tone": "angry", "accountId": "plain", "text": "x" })).unwrap_err().code(), "INVALID");
    assert_eq!(e.rpc("mobile.ai.prompt", json!({ "action": "poem" })).unwrap_err().code(), "INVALID");
    assert_eq!(e.rpc("mobile.ai.prompt", read_action(99, "plain", "summarize")).unwrap()["code"], "NOT_FOUND");
}

/// Every endpoint call is a Network Activity row ("AI model"), shown as the account's when it
/// carries one account's mail; a test call names no account.
#[test]
fn ai_calls_are_recorded_in_network_activity() {
    let (_tmp, e) = engine();
    let server = fake(200, |_| chat("Short summary."));
    let port: u16 = server.url.rsplit(':').next().unwrap().trim_end_matches("/v1").parse().unwrap();
    on(&e, &server.url);
    message(&e, "plain", 8, "ann@example.test", "Lunch", "Can we meet on Friday at noon?", Some(false));
    let mut run = read_action(8, "plain", "summarize");
    run["confirmed"] = json!(true);
    assert_eq!(e.rpc("mobile.ai.run", run).unwrap()["ok"], true);
    assert_eq!(e.rpc("mobile.ai.run", json!({ "action": "test", "confirmed": true })).unwrap()["ok"], true);
    let ours: Vec<_> = mailvault_core::net_activity::snapshot().into_iter().filter(|ev| ev.port == port).collect();
    assert_eq!(ours.len(), 2, "{ours:?}");
    assert!(ours.iter().all(|ev| ev.purpose == "AI model"), "{ours:?}");
    // Newest first: the test call, then the summary.
    assert_eq!(ours[0].account, None, "{ours:?}");
    assert_eq!(ours[1].account.as_deref(), Some("me@example.test"), "{ours:?}");
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

#[test]
fn gmail_and_unnamed_mail_never_reach_a_network_endpoint() {
    let (_tmp, e) = engine();
    // Not this device, and nothing listens there: a refusal must come before any request.
    on(&e, "https://ai.example.test/v1");
    message(&e, "gmail", 1, "x@example.test", "Hi", "Body", Some(false));
    message(&e, "gmailpw", 2, "x@example.test", "Hi", "Body", Some(false));
    for (uid, account) in [(1, "gmail"), (2, "gmailpw")] {
        for method in ["mobile.ai.prompt", "mobile.ai.run"] {
            let mut p = read_action(uid, account, "summarize");
            p["confirmed"] = json!(true);
            assert_eq!(e.rpc(method, p).unwrap(), json!({ "ok": false, "code": GOOGLE_REFUSED }), "{method} {account}");
        }
    }
    let draft = |account: &str| json!({ "action": "shorten", "accountId": account, "text": "Some draft", "confirmed": true });
    assert_eq!(e.rpc("mobile.ai.run", draft("gmail")).unwrap()["code"], GOOGLE_REFUSED);
    assert_eq!(e.rpc("mobile.ai.run", draft("no-such-account")).unwrap()["code"], GOOGLE_REFUSED, "an unknown account is not provably safe");
    assert_eq!(e.rpc("mobile.ai.run", json!({ "action": "shorten", "text": "x" })).unwrap_err().code(), "INVALID", "a draft names its account");
    assert!(e.setting(CONSENTED_URL).unwrap().is_none(), "a refused run consents to nothing");
}

#[test]
fn gmail_may_use_an_endpoint_on_this_device() {
    let (_tmp, e) = engine();
    let server = fake(200, |_| chat("ok"));
    on(&e, &server.url);
    message(&e, "gmail", 1, "x@example.test", "Hi", "Body", Some(false));
    let mut p = read_action(1, "gmail", "summarize");
    p["confirmed"] = json!(true);
    assert_eq!(e.rpc("mobile.ai.run", p).unwrap()["ok"], true);
}

// ── Review ────────────────────────────────────────────────────────────────────

#[test]
fn a_run_needs_a_review_unless_skipped_for_a_reviewed_url() {
    let (_tmp, e) = engine();
    let server = fake(200, |_| chat("ok"));
    let other = fake(200, |_| chat("other"));
    on(&e, &server.url);
    let test = json!({ "action": "test" });
    assert_eq!(e.rpc("mobile.ai.run", test.clone()).unwrap()["code"], "REVIEW_REQUIRED");
    e.rpc("mobile.prefs.set", json!({ "aiSkipPreview": true })).unwrap();
    assert_eq!(e.rpc("mobile.ai.run", test.clone()).unwrap()["code"], "REVIEW_REQUIRED", "skipping needs one review first");
    assert_eq!(e.rpc("mobile.ai.status", json!({})).unwrap()["reviewed"], false);
    assert!(server.seen().is_empty());

    assert_eq!(e.rpc("mobile.ai.run", json!({ "action": "test", "confirmed": true })).unwrap()["ok"], true);
    assert_eq!(e.rpc("mobile.ai.status", json!({})).unwrap()["reviewed"], true);
    assert_eq!(e.rpc("mobile.ai.run", test.clone()).unwrap()["ok"], true, "reviewed and skipping");

    e.rpc("mobile.prefs.set", json!({ "aiEndpointUrl": &other.url })).unwrap();
    assert_eq!(e.rpc("mobile.ai.run", test.clone()).unwrap()["code"], "REVIEW_REQUIRED", "another URL is reviewed again");
    assert_eq!(e.rpc("mobile.ai.status", json!({})).unwrap()["reviewed"], false);
    e.rpc("mobile.prefs.set", json!({ "aiSkipPreview": false, "aiEndpointUrl": &server.url })).unwrap();
    assert_eq!(e.rpc("mobile.ai.run", test).unwrap()["code"], "REVIEW_REQUIRED", "without skipping, every run is reviewed");
    assert!(other.seen().is_empty());
}

#[test]
fn the_review_and_dismissals_are_the_engines_own() {
    let (_tmp, e) = engine();
    assert!(e.set_setting(CONSENTED_URL, "https://evil.example").is_err());
    assert!(e.set_setting(DISMISSED, "[]").is_err());
    assert_eq!(e.rpc("mobile.prefs.set", json!({ "ai.consentedUrl": "https://evil.example" })).unwrap_err().code(), "INVALID");
}

// ── The key ───────────────────────────────────────────────────────────────────

#[test]
fn the_key_goes_to_the_secret_store_and_never_comes_back() {
    let (_tmp, e) = engine();
    // The server refuses and quotes the Authorization header back, as a careless one might.
    let server = fake(401, |auth| json!({ "error": format!("bad key {}", auth.unwrap_or("")) }).to_string());
    on(&e, &server.url);
    assert_eq!(e.rpc("mobile.ai.status", json!({})).unwrap()["hasKey"], false);
    assert_eq!(e.rpc("mobile.ai.setKey", json!({ "key": format!("  {KEY} ") })).unwrap(), json!({ "hasKey": true }));
    assert_eq!(e.secrets().get(KEY_ID).unwrap().as_deref(), Some(KEY));
    let stored: Vec<String> = e
        .read(|c| c.prepare("SELECT value FROM settings")?.query_map([], |r| r.get::<_, String>(0))?.collect())
        .unwrap();
    assert!(stored.iter().all(|v| !v.contains(KEY)), "never in mobile.db");

    let reply = e.rpc("mobile.ai.run", json!({ "action": "test", "confirmed": true })).unwrap();
    assert_eq!(reply, json!({ "ok": false, "code": "AI_FAILED", "status": 401 }));
    assert_eq!(server.seen()[0].auth.as_deref(), Some(format!("Bearer {KEY}").as_str()));
    for reply in [reply, e.rpc("mobile.ai.status", json!({})).unwrap(), e.rpc("mobile.prefs.get", json!({})).unwrap()] {
        assert!(!reply.to_string().contains(KEY), "{reply}");
    }

    assert_eq!(e.rpc("mobile.ai.setKey", json!({ "key": "" })).unwrap(), json!({ "hasKey": false }));
    assert_eq!(e.secrets().get(KEY_ID).unwrap(), None);
}

#[test]
fn an_unreachable_or_odd_endpoint_fails_quietly() {
    let (_tmp, e) = engine();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = format!("http://127.0.0.1:{}/v1", listener.local_addr().unwrap().port());
    drop(listener);
    on(&e, &dead);
    assert_eq!(e.rpc("mobile.ai.run", json!({ "action": "test", "confirmed": true })).unwrap(), json!({ "ok": false, "code": "AI_FAILED", "reason": "network" }));
    let odd = fake(200, |_| "{\"nope\":1}".into());
    e.rpc("mobile.prefs.set", json!({ "aiEndpointUrl": &odd.url })).unwrap();
    assert_eq!(e.rpc("mobile.ai.run", json!({ "action": "test", "confirmed": true })).unwrap(), json!({ "ok": false, "code": "AI_FAILED", "reason": "reply" }));
}

// ── Quick replies ─────────────────────────────────────────────────────────────

fn quick(e: &Engine, account: &str, uid: i64, generate: bool) -> Value {
    e.rpc("mobile.ai.quickReplies", json!({ "accountId": account, "folder": "INBOX", "uid": uid, "generate": generate })).unwrap()
}

#[test]
fn quick_replies_show_by_shape_and_generate_only_for_a_reviewed_endpoint() {
    let (_tmp, e) = engine();
    let server = fake(200, |_| chat("1. Sounds good\n- Friday works\n* Let me check\nExtra line"));
    message(&e, "plain", 1, "ann@example.test", "Lunch", "Does Friday at noon work for you?", Some(false));
    message(&e, "plain", 2, "ann@example.test", "Report", "Is the report done?", Some(false));
    message(&e, "plain", 3, "ann@example.test", "Report", "Please send the report.", Some(false));
    assert_eq!(quick(&e, "plain", 1, true), json!({ "show": true, "shape": "proposedTime", "starters": null }), "AI off");
    assert_eq!(quick(&e, "plain", 2, false)["shape"], "question");
    assert_eq!(quick(&e, "plain", 3, false)["shape"], "request");

    on(&e, &server.url);
    assert_eq!(quick(&e, "plain", 1, true)["starters"], Value::Null, "never reviewed: nothing automatic is sent");
    assert!(server.seen().is_empty());
    e.rpc("mobile.ai.run", json!({ "action": "test", "confirmed": true })).unwrap();
    assert_eq!(quick(&e, "plain", 1, true)["starters"], json!(["Sounds good", "Friday works", "Let me check"]));
    assert_eq!(quick(&e, "plain", 1, false)["starters"], Value::Null, "only asked to generate");
    let prompt = server.seen().last().unwrap().body["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(prompt.contains("Subject: Lunch") && prompt.contains("Does Friday at noon work for you?"), "{prompt}");
}

#[test]
fn quick_replies_stay_off_for_lists_own_mail_and_dismissed_conversations() {
    let (_tmp, e) = engine();
    let server = fake(200, |_| chat("Yes"));
    on(&e, &server.url);
    e.rpc("mobile.ai.run", json!({ "action": "test", "confirmed": true })).unwrap();
    let before = server.seen().len();
    message(&e, "plain", 1, "news@example.test", "Weekly", "Read more?", Some(true));
    message(&e, "plain", 2, "me@example.test", "Mine", "Sent by me?", Some(false));
    message(&e, "plain", 3, "ann@example.test", "Old row", "From before the flag?", None);
    message(&e, "plain", 4, "ann@example.test", "Hi", "Coffee?", Some(false));
    message(&e, "gmail", 5, "ann@example.test", "Hi", "Coffee?", Some(false));
    assert_eq!(quick(&e, "plain", 1, true)["show"], false, "a list message");
    assert_eq!(quick(&e, "plain", 2, true)["show"], false, "the account's own");
    assert_eq!(quick(&e, "plain", 3, true), json!({ "show": true, "shape": "question", "starters": null }), "unknown: no generation");
    assert_eq!(quick(&e, "plain", 99, true)["show"], false, "no such message");
    assert_eq!(server.seen().len(), before, "none of those reached the endpoint");

    e.write(|c| c.execute("UPDATE messages SET thread_json = json_set(thread_json, '$.replyTo', json('[{\"name\":\"\",\"address\":\"bounce@lists.test\"}]')) WHERE uid = 4", [])).unwrap();
    assert_eq!(quick(&e, "plain", 4, false)["show"], false, "a Reply-To elsewhere reads as bulk");
    e.write(|c| c.execute("UPDATE messages SET thread_json = json_set(thread_json, '$.replyTo', json('[]')) WHERE uid = 4", [])).unwrap();
    assert_eq!(quick(&e, "plain", 4, false)["show"], true);
    assert_eq!(e.rpc("mobile.ai.dismissQuickReplies", json!({ "accountId": "plain", "folder": "INBOX", "uid": 4 })).unwrap(), json!({}));
    assert_eq!(quick(&e, "plain", 4, false)["show"], false, "dismissed");
    assert_eq!(quick(&e, "plain", 3, false)["show"], true, "another conversation is not");
    // Gmail, not on this device: shown, never generated. Loopback is this device, so move it off.
    e.write(|c| put_in(c, CONSENTED_URL, "https://ai.example.test/v1")).unwrap();
    e.rpc("mobile.prefs.set", json!({ "aiEndpointUrl": "https://ai.example.test/v1" })).unwrap();
    assert_eq!(quick(&e, "gmail", 5, true), json!({ "show": true, "shape": "question", "starters": null }));
}

#[test]
fn dismissals_keep_the_newest_conversations() {
    let (_tmp, e) = engine();
    for uid in 1..=(MAX_DISMISSED as i64 + 2) {
        message(&e, "plain", uid, "ann@example.test", "Hi", "Hi", Some(false));
        e.rpc("mobile.ai.dismissQuickReplies", json!({ "accountId": "plain", "folder": "INBOX", "uid": uid })).unwrap();
    }
    let list = dismissed(&e).unwrap();
    assert_eq!(list.len(), MAX_DISMISSED);
    assert_eq!(list.last().map(String::as_str), Some(format!("<root-{}@x>", MAX_DISMISSED + 2).as_str()));
    assert_eq!(quick(&e, "plain", 1, false)["show"], true, "the oldest dismissal fell off");
}

// ── Pure pieces ───────────────────────────────────────────────────────────────

#[test]
fn shapes_follow_desktops_heuristics() {
    for (subject, text, want) in [
        ("Lunch", "How about Friday?", Shape::ProposedTime),
        ("", "Are you available tomorrow at 3pm", Shape::ProposedTime),
        ("Call", "Does 10:30 am work", Shape::ProposedTime),
        ("Call", "does that work for monday", Shape::ProposedTime),
        ("Meeting today", "Agenda attached.", Shape::ProposedTime),
        ("", "We are unavailable on Friday?", Shape::Question),
        ("", "Is 110am a time?", Shape::Question),
        ("", "Scheduled for Friday.", Shape::Request),
        ("Today", "Please review the doc.", Shape::Request),
        ("", "Send it over", Shape::Request),
    ] {
        assert_eq!(shape(subject, text), want, "{subject:?} {text:?}");
    }
}

#[test]
fn starters_lose_their_list_marks() {
    assert_eq!(parse_starters("1) Yes\n\n  2. No  \n- Maybe\n* Four"), vec!["Yes", "No", "Maybe"]);
    assert!(parse_starters(" \n- \n").is_empty());
}
