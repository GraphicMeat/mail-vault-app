//! `mobile.autoTags.*` and the worker against fake OpenAI-compatible endpoints: the gates (in
//! core's order), the Google rule with an endpoint off this device, what one request carries, the
//! go-forward window, resuming, back-off, the network gate, and backfill with its undo.

use super::*;
use crate::MemorySecrets;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, UdpSocket};
use std::sync::atomic::{AtomicUsize, Ordering};

const NOW_MS: fn() -> i64 = crate::compose::now_ms;

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

/// A message dated `days_ago`, with its body held unless `body` is `None`; `list_id`: the
/// sync's `listId` (`None`: a row from before it, unknown).
fn message(e: &Engine, account: &str, uid: i64, subject: &str, days_ago: i64, body: Option<&str>, list_id: Option<Option<&str>>) {
    let mut thread = json!({ "cc": [], "replyTo": [], "references": [], "inReplyTo": null, "date": null });
    if let Some(l) = list_id {
        thread["listId"] = json!(l);
    }
    let date = NOW_MS() - days_ago * 86_400_000;
    e.write(|c| {
        c.execute(
            "INSERT INTO messages (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments, to_json, thread_json, message_id)
             VALUES (?1, 'INBOX', ?2, ?3, 'Shop', 'billing@shop.example', ?4, '', 0, 0, 1, '[]', ?5, ?6)",
            rusqlite::params![account, uid, subject, date, thread.to_string(), format!("<{account}-{uid}@x>")],
        )?;
        if let Some(text) = body {
            c.execute("INSERT INTO bodies (account_id, folder, uid, text, html) VALUES (?1, 'INBOX', ?2, ?3, NULL)", rusqlite::params![account, uid, text])?;
        }
        Ok(())
    })
    .unwrap();
}

fn chat(text: &str) -> String {
    json!({ "choices": [{ "message": { "role": "assistant", "content": text } }] }).to_string()
}

/// A fake endpoint answering every request with `status` and `content`, counting connections and
/// keeping each request's Authorization header and body.
struct Fake {
    url: String,
    hits: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<(Option<String>, Value)>>>,
}

fn serve(listener: TcpListener, url: String, status: u16, content: &str) -> Fake {
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (h, s) = (hits.clone(), seen.clone());
    let out = if status == 200 { chat(content) } else { content.to_string() };
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            h.fetch_add(1, Ordering::SeqCst);
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let (mut auth, mut length) = (None, 0usize);
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
            s.lock().unwrap().push((auth, serde_json::from_slice(&body).unwrap_or(Value::Null)));
            let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
        }
    });
    Fake { url, hits, seen }
}

/// On loopback: an endpoint on this device, which the Google rule allows.
fn loopback(status: u16, content: &str) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/v1", listener.local_addr().unwrap().port());
    serve(listener, url, status, content)
}

/// On this machine's LAN address, not loopback: an endpoint off this device as the Google rule
/// counts it (desktop's `ai_gate` tests do the same), yet reachable, so a request that is made is
/// counted. A test that needs one fails without one rather than passing quietly.
fn lan(content: &str) -> Fake {
    let probe = UdpSocket::bind("0.0.0.0:0").unwrap();
    probe.connect("192.0.2.1:80").unwrap(); // no packet is sent: this only picks a route
    let ip = probe.local_addr().unwrap().ip();
    assert!(!ip.is_loopback() && !ip.is_unspecified() && matches!(ip, IpAddr::V4(_)), "this test needs a LAN IPv4 address, got {ip}");
    let listener = TcpListener::bind((ip, 0)).unwrap();
    let url = format!("http://{ip}:{}/v1", listener.local_addr().unwrap().port());
    assert!(!endpoint_is_on_device(&url));
    serve(listener, url, 200, content)
}

fn set_endpoint(e: &Engine, url: &str) {
    e.rpc("mobile.prefs.set", json!({ "aiEndpointUrl": url, "aiEndpointModel": "m" })).unwrap();
}

fn tag(e: &Engine, name: &str) -> String {
    e.rpc("mobile.tags.create", json!({ "name": name })).unwrap()["tag"]["id"].as_str().unwrap().to_string()
}

fn draft(tag_id: &str, allow_remote: bool, url: Option<&str>, enabled: bool) -> Value {
    json!({
        "name": "Receipts", "instruction": "receipts and invoices", "constraints": {},
        "tagId": tag_id, "inboxAction": "keep", "minConfidence": 0.5, "allowRemote": allow_remote,
        "provider": url.map(|u| json!({ "type": "endpoint", "url": u, "model": "m" })), "enabled": enabled,
    })
}

/// A saved rule, its go-forward window opened at the epoch so the test's mail counts as new.
fn rule(e: &Engine, d: Value) -> String {
    let id = e.rpc("mobile.autoTags.create", json!({ "rule": d })).unwrap()["rule"]["id"].as_str().unwrap().to_string();
    e.shared().app_db.with(|c| c.execute("UPDATE auto_tag_rules SET enabled_at = 0 WHERE id = ?1 AND enabled_at IS NOT NULL", [&id]).map_err(|x| x.to_string())).unwrap();
    id
}

fn decided(e: &Engine, rule_id: &str) -> i64 {
    e.shared().app_db.with(|c| c.query_row("SELECT COUNT(*) FROM auto_tag_decisions WHERE rule_id = ?1", [rule_id], |r| r.get(0)).map_err(|x| x.to_string())).unwrap()
}

fn tagged(e: &Engine, account: &str, uid: u32) -> Vec<Vec<String>> {
    e.rpc("mobile.tags.forMessages", json!({ "items": [{ "accountId": account, "folder": "INBOX", "uid": uid }] })).unwrap()["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect())
        .collect()
}

fn events(e: &Engine) -> Arc<Mutex<Vec<(String, Value)>>> {
    let got = Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    e.set_event_sink(move |name, payload| g.lock().unwrap().push((name.to_string(), payload)));
    got
}

// ── The Google rule ─────────────────────────────────────────────────────────

/// The privacy rule: with an endpoint off this device, a Google account's mail is never sent,
/// by the worker, a preview or a backfill, and stays undecided; the same rule still asks about
/// another account's mail (one request: the endpoint was reachable all along).
#[test]
fn a_google_accounts_mail_never_reaches_an_endpoint_off_this_device() {
    let (_tmp, e) = engine();
    let server = lan("MATCH: yes\nCONFIDENCE: 0.9");
    set_endpoint(&e, &server.url);
    for account in ["plain", "gmail", "gmailpw"] {
        message(&e, account, 1, "Your receipt", 0, Some("body"), Some(None));
    }
    let t = tag(&e, "Receipts");
    let id = rule(&e, draft(&t, true, Some(&server.url), true));

    let (judged, how) = sweep(e.shared());
    assert_eq!((judged, how), (1, Swept::Done));
    assert_eq!(server.hits.load(Ordering::SeqCst), 1, "only the non-Google account's message was sent");
    assert_eq!(tagged(&e, "plain", 1), vec![vec![t.clone()]]);
    assert_eq!(tagged(&e, "gmail", 1), vec![Vec::<String>::new()]);
    assert_eq!(decided(&e, &id), 1, "the Google accounts' mail stays undecided");

    for account in ["gmail", "gmailpw", "unknown-account"] {
        let preview = e.rpc("mobile.autoTags.preview", json!({ "ruleId": id, "accountId": account })).unwrap();
        assert_eq!(preview, json!({ "ok": false, "code": "E_GOOGLE_MAIL_ON_DEVICE_ONLY" }), "{account}");
        let backfill = e.rpc("mobile.autoTags.backfill", json!({ "ruleId": id, "accountId": account })).unwrap();
        assert_eq!(backfill["code"], "E_GOOGLE_MAIL_ON_DEVICE_ONLY", "{account}");
    }
    assert_eq!(run_jobs(e.shared()), 0, "nothing was queued");
    sweep(e.shared());
    assert_eq!(server.hits.load(Ordering::SeqCst), 1, "still only the one request");
    let status = e.rpc("mobile.autoTags.status", json!({})).unwrap();
    assert_eq!(status["leavesDevice"], true);
    assert_eq!(status["googleSkipped"], json!(["gmail", "gmailpw"]));
}

#[test]
fn an_endpoint_on_this_device_may_judge_google_mail() {
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: yes\nCONFIDENCE: 0.9");
    set_endpoint(&e, &server.url);
    message(&e, "gmail", 1, "Your receipt", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    rule(&e, draft(&t, true, Some(&server.url), true));
    assert_eq!(sweep(e.shared()).0, 1);
    assert_eq!(tagged(&e, "gmail", 1), vec![vec![t]]);
    assert_eq!(e.rpc("mobile.autoTags.status", json!({})).unwrap()["googleSkipped"], json!([]));
}

// ── The rule's own gates ────────────────────────────────────────────────────

#[test]
fn a_rule_runs_only_with_its_opt_in_and_on_the_endpoint_it_was_allowed_for() {
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: yes\nCONFIDENCE: 0.9");
    message(&e, "plain", 1, "Your receipt", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");

    // No endpoint at all.
    let id = rule(&e, draft(&t, true, Some(&server.url), true));
    assert_eq!(sweep(e.shared()).0, 0);
    assert_eq!(e.rpc("mobile.autoTags.preview", json!({ "ruleId": id, "accountId": "plain" })).unwrap()["code"], "AI_NOT_CONFIGURED");
    set_endpoint(&e, &server.url);

    // Without "Allow a remote AI provider": refused before any request, the preview says so.
    let off = rule(&e, draft(&t, false, None, true));
    e.rpc("mobile.autoTags.delete", json!({ "id": id })).unwrap();
    assert_eq!(sweep(e.shared()).0, 0);
    let rows = e.rpc("mobile.autoTags.preview", json!({ "ruleId": off, "accountId": "plain" })).unwrap();
    assert_eq!(rows["candidates"][0]["matched"], false);
    assert_eq!(rows["candidates"][0]["refused"], store::REMOTE_NOT_ALLOWED);
    assert_eq!(e.rpc("mobile.autoTags.backfill", json!({ "ruleId": off, "accountId": "plain" })).unwrap()["code"], "NEEDS_REMOTE");

    // Allowed for another endpoint: the same.
    let elsewhere = rule(&e, draft(&t, true, Some("https://ai.example.test/v1"), true));
    e.rpc("mobile.autoTags.delete", json!({ "id": off })).unwrap();
    assert_eq!(sweep(e.shared()).0, 0);
    assert_eq!(e.rpc("mobile.autoTags.backfill", json!({ "ruleId": elsewhere, "accountId": "plain" })).unwrap()["code"], "NEEDS_REMOTE");
    assert_eq!(server.hits.load(Ordering::SeqCst), 0, "nothing was sent");

    // Allowed for this one.
    rule(&e, draft(&t, true, Some(&server.url), true));
    assert_eq!(sweep(e.shared()).0, 1);
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);
}

#[test]
fn a_disabled_rule_is_never_swept() {
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: yes");
    set_endpoint(&e, &server.url);
    message(&e, "plain", 1, "Your receipt", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    rule(&e, draft(&t, true, Some(&server.url), false));
    assert_eq!(sweep(e.shared()).0, 0);
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
}

// ── What is sent ────────────────────────────────────────────────────────────

#[test]
fn one_request_is_desktops_header_only_verdict_prompt() {
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: no");
    set_endpoint(&e, &server.url);
    e.rpc("mobile.ai.setKey", json!({ "key": "sk-test-KEY" })).unwrap();
    message(&e, "plain", 1, "Your receipt", 0, Some("THE SECRET BODY TEXT"), Some(None));
    let t = tag(&e, "Receipts");
    rule(&e, draft(&t, true, Some(&server.url), true));
    sweep(e.shared());

    let seen = server.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    let (auth, body) = &seen[0];
    assert_eq!(auth.as_deref(), Some("Bearer sk-test-KEY"), "the stored key, to the URL it is kept for");
    assert_eq!(body["model"], "m");
    assert_eq!(body["max_tokens"], store::VERDICT_MAX_TOKENS);
    assert_eq!(body["messages"][0], json!({ "role": "system", "content": store::VERDICT_SYSTEM_PROMPT }));
    let candidate = Candidate {
        from: "Shop <billing@shop.example>".into(),
        subject: "Your receipt".into(),
        mailbox: "INBOX".into(),
        has_attachments: true,
        list_id: None,
        date: 0,
    };
    assert_eq!(body["messages"][1]["content"], store::verdict_prompt("receipts and invoices", &candidate));
    assert!(!body.to_string().contains("SECRET BODY"), "never the body");
}

// ── Which messages ──────────────────────────────────────────────────────────

#[test]
fn only_held_mail_in_the_window_and_after_the_rule_was_turned_on_is_judged() {
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: yes");
    set_endpoint(&e, &server.url);
    // Dated a day back, so the rule turned on below (this second) cannot count it as new.
    message(&e, "plain", 1, "Held", 1, Some("body"), Some(None));
    message(&e, "plain", 2, "Not held", 0, None, Some(None));
    message(&e, "plain", 3, "Outside the 3 month window", 200, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    let id = rule(&e, draft(&t, true, Some(&server.url), true));
    assert_eq!(sweep(e.shared()).0, 1);
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);

    // A rule turned on now does not look back: that is a backfill's.
    message(&e, "plain", 4, "Yesterday", 1, Some("body"), Some(None));
    let fresh = e.rpc("mobile.autoTags.create", json!({ "rule": draft(&t, true, Some(&server.url), true) })).unwrap()["rule"]["id"].as_str().unwrap().to_string();
    e.rpc("mobile.autoTags.delete", json!({ "id": id })).unwrap();
    assert_eq!(sweep(e.shared()).0, 0);
    assert_eq!(decided(&e, &fresh), 0);
}

#[test]
fn a_list_header_question_skips_rows_whose_header_was_not_recorded() {
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: yes");
    set_endpoint(&e, &server.url);
    message(&e, "plain", 1, "A list", 0, Some("body"), Some(Some("<news.shop.example>")));
    message(&e, "plain", 2, "Not a list", 0, Some("body"), Some(None));
    message(&e, "plain", 3, "Unknown", 0, Some("body"), None);
    let t = tag(&e, "Receipts");
    let mut d = draft(&t, true, Some(&server.url), true);
    d["constraints"] = json!({ "listIdPresent": true });
    rule(&e, d);
    assert_eq!(sweep(e.shared()).0, 1);
    assert_eq!(tagged(&e, "plain", 1), vec![vec![t.clone()]]);
    assert_eq!(tagged(&e, "plain", 3), vec![Vec::<String>::new()]);
}

// ── Resume, back-off, the network ───────────────────────────────────────────

#[test]
fn a_sweep_records_each_verdict_announces_the_tag_and_never_asks_twice() {
    let (_tmp, e) = engine();
    let got = events(&e);
    let server = loopback(200, "MATCH: yes\nCONFIDENCE: 0.9");
    set_endpoint(&e, &server.url);
    message(&e, "plain", 1, "Your receipt", 0, Some("body"), Some(None));
    message(&e, "plain", 2, "Lunch?", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    let id = rule(&e, draft(&t, true, Some(&server.url), true));
    assert_eq!(sweep(e.shared()).0, 2);
    assert_eq!(decided(&e, &id), 2);
    let assigned: Vec<Value> = got.lock().unwrap().iter().filter(|(n, _)| n == TAGS_ASSIGNED).map(|(_, p)| p.clone()).collect();
    assert_eq!(assigned.len(), 2, "one per message, as it lands");
    assert_eq!(assigned[0]["tagId"], json!(t));

    // A relaunch, or the next wake: nothing left to ask.
    assert_eq!(sweep(e.shared()).0, 0);
    assert_eq!(server.hits.load(Ordering::SeqCst), 2);
}

#[test]
fn a_failing_endpoint_records_nothing_and_backs_off() {
    let (_tmp, e) = engine();
    let server = loopback(500, "{}");
    set_endpoint(&e, &server.url);
    message(&e, "plain", 1, "Your receipt", 0, Some("body"), Some(None));
    message(&e, "plain", 2, "Another", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    let id = rule(&e, draft(&t, true, Some(&server.url), true));
    assert_eq!(sweep(e.shared()).0, 0);
    assert_eq!(server.hits.load(Ordering::SeqCst), 1, "the rule stops at its first failure");
    assert_eq!(decided(&e, &id), 0, "a failure is not a verdict");
    assert!(backing_off(e.shared(), &id));
    sweep(e.shared());
    assert_eq!(server.hits.load(Ordering::SeqCst), 1, "waiting out its back-off");
}

#[test]
fn retries_wait_longer_each_time_up_to_an_hour() {
    assert_eq!(retry_wait(1), RETRY_BASE);
    assert_eq!(retry_wait(2), RETRY_BASE * 2);
    assert_eq!(retry_wait(3), RETRY_BASE * 4);
    assert_eq!(retry_wait(40), RETRY_MAX);
}

#[test]
fn a_constrained_network_pauses_the_worker() {
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: yes");
    set_endpoint(&e, &server.url);
    message(&e, "plain", 1, "Your receipt", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    rule(&e, draft(&t, true, Some(&server.url), true));
    e.set_network(true, true);
    assert_eq!(sweep(e.shared()), (0, Swept::Paused));
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
    e.set_network(false, true);
    assert_eq!(sweep(e.shared()).0, 1, "a metered network is fine: the request is small");
}

// ── Backfill and undo ───────────────────────────────────────────────────────

#[test]
fn a_backfill_runs_on_the_worker_reports_and_undo_removes_exactly_its_batch() {
    let (_tmp, e) = engine();
    let got = events(&e);
    let server = loopback(200, "MATCH: yes\nCONFIDENCE: 0.9");
    set_endpoint(&e, &server.url);
    message(&e, "plain", 1, "Old receipt", 30, Some("body"), Some(None));
    message(&e, "plain", 2, "Already tagged", 31, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    e.rpc("mobile.tags.assign", json!({ "tagId": t, "items": [{ "accountId": "plain", "folder": "INBOX", "uid": 2 }] })).unwrap();
    // Off: a backfill is the explicit way to apply a rule to what is here.
    let id = rule(&e, draft(&t, true, Some(&server.url), false));

    let batch = e.rpc("mobile.autoTags.backfill", json!({ "ruleId": id, "accountId": "plain" })).unwrap()["batchId"].as_str().unwrap().to_string();
    assert_eq!(server.hits.load(Ordering::SeqCst), 0, "queued, not run on the caller's thread");
    assert_eq!(run_jobs(e.shared()), 1);
    assert_eq!(server.hits.load(Ordering::SeqCst), 2);
    let last = got.lock().unwrap().iter().filter(|(n, _)| n == AUTO_TAGS_PROGRESS).last().unwrap().1.clone();
    assert_eq!(last, json!({ "batchId": batch, "ruleId": id, "processed": 2, "total": 2, "matched": 2, "done": true, "assigned": 1 }));
    assert_eq!(e.rpc("mobile.autoTags.status", json!({})).unwrap()["backfills"][&id], last);
    assert_eq!(tagged(&e, "plain", 1), vec![vec![t.clone()]]);

    let undone = e.rpc("mobile.autoTags.undoBackfill", json!({ "batchId": batch })).unwrap();
    assert_eq!(undone, json!({ "unassigned": 1, "tagId": t }));
    assert_eq!(tagged(&e, "plain", 1), vec![Vec::<String>::new()]);
    assert_eq!(tagged(&e, "plain", 2), vec![vec![t.clone()]], "a tag it carried before stays");
    assert_eq!(e.rpc("mobile.autoTags.undoBackfill", json!({ "batchId": batch })).unwrap(), json!({ "unassigned": 0 }));
}

#[test]
fn a_backfill_stops_at_a_failing_endpoint_and_says_so() {
    let (_tmp, e) = engine();
    let got = events(&e);
    let server = loopback(503, "{}");
    set_endpoint(&e, &server.url);
    message(&e, "plain", 1, "One", 0, Some("body"), Some(None));
    message(&e, "plain", 2, "Two", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    let id = rule(&e, draft(&t, true, Some(&server.url), false));
    e.rpc("mobile.autoTags.backfill", json!({ "ruleId": id, "accountId": "plain" })).unwrap();
    run_jobs(e.shared());
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    let last = got.lock().unwrap().iter().filter(|(n, _)| n == AUTO_TAGS_PROGRESS).last().unwrap().1.clone();
    assert_eq!((last["done"].clone(), last["code"].clone(), last["assigned"].clone()), (json!(true), json!("AI_FAILED"), json!(0)));
}

// ── Preview and rules ───────────────────────────────────────────────────────

#[test]
fn a_preview_of_an_unsaved_rule_writes_nothing() {
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: yes\nCONFIDENCE: 0.8");
    set_endpoint(&e, &server.url);
    message(&e, "plain", 1, "Your receipt", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    let out = e.rpc("mobile.autoTags.preview", json!({ "rule": draft(&t, true, Some(&server.url), false), "accountId": "plain" })).unwrap();
    let row = &out["candidates"][0];
    assert_eq!((row["matched"].clone(), row["confidence"].clone(), row["subject"].clone()), (json!(true), json!(0.8), json!("Your receipt")));
    assert_eq!(tagged(&e, "plain", 1), vec![Vec::<String>::new()]);
    assert!(e.rpc("mobile.autoTags.list", json!({})).unwrap()["rules"].as_array().unwrap().is_empty());
}

#[test]
fn rules_round_trip_through_create_update_and_delete() {
    let (_tmp, e) = engine();
    let t = tag(&e, "Receipts");
    let created = e.rpc("mobile.autoTags.create", json!({ "rule": draft(&t, false, None, false) })).unwrap();
    let id = created["rule"]["id"].as_str().unwrap().to_string();
    assert_eq!(created["rules"].as_array().unwrap().len(), 1);
    let mut d = draft(&t, false, None, true);
    d["name"] = json!("Bills");
    let updated = e.rpc("mobile.autoTags.update", json!({ "id": id, "rule": d })).unwrap();
    assert_eq!((updated["rule"]["name"].clone(), updated["rule"]["enabled"].clone()), (json!("Bills"), json!(true)));
    assert!(updated["rule"]["enabledAt"].is_i64());
    assert_eq!(e.rpc("mobile.autoTags.create", json!({ "rule": { "name": "" } })).unwrap_err().code(), "INVALID");
    assert_eq!(e.rpc("mobile.autoTags.delete", json!({ "id": id })).unwrap(), json!({ "rules": [] }));
}

/// A rule that arrives in a code (anyone's QR) never grants itself the right to send mail: even
/// naming the phone's own endpoint and allowed on the desktop, it sends nothing until the phone's
/// owner turns "Allow a remote AI provider" on, here.
#[test]
fn an_imported_rule_sends_nothing_until_the_phone_allows_it() {
    use mailvault_core::app_db::auto_tags::InboxAction;
    use mailvault_core::transfer::phone::{PhoneAutoTag, PhoneAutoTags, PhoneEndpoint};
    let (_tmp, e) = engine();
    let server = loopback(200, "MATCH: yes\nCONFIDENCE: 0.9");
    message(&e, "plain", 1, "Your receipt", 0, Some("body"), Some(None));
    let t = tag(&e, "Receipts");
    set_endpoint(&e, &server.url);
    let block = PhoneAutoTags {
        list: vec![PhoneAutoTag {
            id: "imported".into(), name: "Receipts".into(), instruction: "receipts and invoices".into(), constraints: Default::default(),
            tag: "Receipts".into(), inbox_action: InboxAction::Keep, min_confidence: 0.5, allow_remote: true,
            endpoint: Some(PhoneEndpoint { url: server.url.clone(), model: "m".into() }), enabled: true,
        }],
    };
    assert_eq!(crate::transfer::apply_auto_tags(&e, &block), json!({ "autoTags": 1 }));
    e.shared().app_db.with(|c| c.execute("UPDATE auto_tag_rules SET enabled_at = 0 WHERE id = 'imported'", []).map_err(|x| x.to_string())).unwrap();
    let got = e.shared().app_db.with(|c| store::get(c, "imported")).unwrap().unwrap();
    assert!(!got.allow_remote, "arrives off");
    assert_eq!(got.provider["url"], json!(server.url), "the endpoint stays, for the phone's toggle to confirm");
    assert_eq!(sweep(e.shared()).0, 0);
    assert_eq!(server.hits.load(Ordering::SeqCst), 0, "nothing was sent");

    // The phone's own yes, for that endpoint: now it runs.
    e.rpc("mobile.autoTags.update", json!({ "id": "imported", "rule": draft(&t, true, Some(&server.url), true) })).unwrap();
    e.shared().app_db.with(|c| c.execute("UPDATE auto_tag_rules SET enabled_at = 0 WHERE id = 'imported'", []).map_err(|x| x.to_string())).unwrap();
    assert_eq!(sweep(e.shared()).0, 1);
    // A second import of the same rule keeps the phone's yes.
    crate::transfer::apply_auto_tags(&e, &block);
    assert!(e.shared().app_db.with(|c| store::get(c, "imported")).unwrap().unwrap().allow_remote);
}

/// A preview stops at the first endpoint failure, as a backfill does: one request, not one per
/// message, each waiting out the same failure on the caller's thread.
#[test]
fn a_preview_stops_at_a_failing_endpoint() {
    let (_tmp, e) = engine();
    let server = loopback(503, "{}");
    set_endpoint(&e, &server.url);
    for (uid, subject) in [(1, "One"), (2, "Two"), (3, "Three")] {
        message(&e, "plain", uid, subject, 0, Some("body"), Some(None));
    }
    let t = tag(&e, "Receipts");
    let id = rule(&e, draft(&t, true, Some(&server.url), false));
    let r = e.rpc("mobile.autoTags.preview", json!({ "ruleId": id, "accountId": "plain" })).unwrap();
    assert_eq!(server.hits.load(Ordering::SeqCst), 1, "{r}");
    assert_eq!(r["candidates"].as_array().unwrap().len(), 1, "{r}");
    assert_eq!(r["candidates"][0]["refused"], "AI_FAILED");
    assert_eq!(r["stopped"], "AI_FAILED");
}
