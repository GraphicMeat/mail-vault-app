use crate::search_index::{bodies_action, needs_full, plan, BodiesAction, Plan, Signal, SWEEP_EVERY};
use std::time::Duration;

fn eml_html() -> Vec<u8> {
    b"From: Ann Lee <ann@x.test>\r\nTo: Bob <bob@x.test>\r\nCc: carol@x.test\r\nSubject: Quarterly numbers\r\nMessage-ID: <q@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Revenue&nbsp;grew <b>12%</b></p><style>x{}</style>\r\n".to_vec()
}

#[test]
fn adapter_builds_doc_from_the_app_parser() {
    let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, "7:2,S.eml").expect("parses");
    assert_eq!(doc.subject, "Quarterly numbers");
    assert_eq!(doc.from_addr, "ann@x.test");
    assert_eq!(doc.from_name, "Ann Lee");
    assert!(doc.addrs.iter().any(|a| a.contains("bob@x.test")));
    assert!(doc.addrs.iter().any(|a| a.contains("carol@x.test")));
    assert_eq!(doc.body_text, "Revenue grew 12%");
    assert_eq!(doc.message_id.as_deref(), Some("<q@x.test>"));
    assert_eq!(doc.date_utc, Some(1789207200));
    let row: serde_json::Value = serde_json::from_str(&doc.row_json).unwrap();
    assert!(row.get("text").map_or(true, |v| v.is_null()), "row_json has no body");
    assert!(row.get("html").map_or(true, |v| v.is_null()));
    assert!(row.get("flags").is_none(), "flags come from the filename at read time");
    assert_eq!(row["subject"], "Quarterly numbers");
}

#[test]
fn search_index_signal_burst_collapses_into_one_pass() {
    let nudge = |a: &str, d: &str| Signal::Nudge { account_id: a.into(), vault_dir: d.into() };
    let quiet = || Plan { reopen: false, rebuild: false, only: None };

    // Many nudges for one folder stay scoped to it.
    assert_eq!(
        plan(vec![nudge("a", "INBOX"), nudge("a", "INBOX")]),
        Plan { only: Some(("a".into(), "INBOX".into())), ..quiet() }
    );
    // Two folders, a sweep or a configure widen to a full pass.
    assert_eq!(plan(vec![nudge("a", "INBOX"), nudge("b", "INBOX")]), quiet());
    assert_eq!(plan(vec![nudge("a", "INBOX"), Signal::Sweep]), quiet());
    assert_eq!(plan(vec![nudge("a", "INBOX"), Signal::Configure]), quiet());
    // Rebuild and reopen are never swallowed by the nudges queued behind them.
    assert_eq!(plan(vec![Signal::Rebuild, nudge("a", "INBOX")]), Plan { rebuild: true, ..quiet() });
    assert_eq!(plan(vec![Signal::Reopen, nudge("a", "INBOX")]), Plan { reopen: true, ..quiet() });
}

#[test]
fn search_index_bodies_setting_is_recorded_toggled_or_left() {
    // A fresh index has no flag: record it, nothing to strip.
    assert_eq!(bodies_action(None, true), BodiesAction::RecordOnly);
    assert_eq!(bodies_action(None, false), BodiesAction::RecordOnly);
    assert_eq!(bodies_action(Some("1"), true), BodiesAction::None);
    assert_eq!(bodies_action(Some("0"), false), BodiesAction::None);
    assert_eq!(bodies_action(Some("1"), false), BodiesAction::Toggle);
    assert_eq!(bodies_action(Some("0"), true), BodiesAction::Toggle);
}

#[test]
fn search_index_safety_sweep_is_not_starved_by_nudges() {
    let young = SWEEP_EVERY - Duration::from_secs(1);
    assert!(needs_full(SWEEP_EVERY, false), "an overdue scoped pass is promoted");
    assert!(needs_full(SWEEP_EVERY * 3, false));
    assert!(needs_full(Duration::ZERO, true), "a planned full pass stays full");
    assert!(!needs_full(young, false), "a scoped pass inside the window stays scoped");
}

fn eml_alternative(plain: &str, html: &str) -> Vec<u8> {
    format!(
        "From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Both parts\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{plain}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n--b--\r\n"
    )
    .into_bytes()
}

#[test]
fn adapter_indexes_the_html_when_the_text_part_is_a_stub() {
    let html = "<p>Your <b>September statement</b> is ready.</p><p>Balance due: 1,240.00 by October 5.</p>";
    let doc = crate::search_index::index_doc_from_light(&eml_alternative("View this email in your browser", html), 1, "1:2,.eml").expect("parses");
    assert!(doc.body_text.contains("September statement"), "{:?}", doc.body_text);
    assert!(doc.body_text.contains("Balance due"), "{:?}", doc.body_text);
}

#[test]
fn adapter_keeps_the_text_part_when_it_says_more_than_the_html() {
    let plain = "Hi Bob, the full minutes of Tuesday's meeting are below, with every action item and owner.";
    let doc = crate::search_index::index_doc_from_light(&eml_alternative(plain, "<p>See minutes</p>"), 1, "1:2,.eml").expect("parses");
    assert_eq!(doc.body_text.trim(), plain);
}

#[test]
fn adapter_falls_back_to_html_when_the_text_part_is_whitespace() {
    let doc = crate::search_index::index_doc_from_light(&eml_alternative("  \r\n\t", "<p>From <b>html</b></p>"), 1, "1:2,.eml").expect("parses");
    assert_eq!(doc.body_text, "From html");
}

#[test]
fn assemble_rows_keeps_hit_order_and_adds_snippet_and_matched_in() {
    use mailvault_core::search_index::query::{SearchHit, SearchPage};
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for (dir, uid, subject, body) in [("INBOX", 3u32, "Budget", "the quarterly budget is attached"), ("Archive", 9, "Lunch", "no budget words here? budget!")] {
        let cur = root.join("Maildir/acct").join(dir).join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(format!("{uid}:2,S.eml")), format!("From: A <a@x.test>\r\nTo: b@x.test\r\nSubject: {subject}\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\n{body}\r\n")).unwrap();
    }
    let page = SearchPage {
        hits: vec![
            SearchHit { vault_dir: "Archive".into(), uid: 9, filename: "9:2,S.eml".into(), message_id: None },
            SearchHit { vault_dir: "INBOX".into(), uid: 3, filename: "3:2,S.eml".into(), message_id: None },
            SearchHit { vault_dir: "INBOX".into(), uid: 404, filename: "404:2,.eml".into(), message_id: None },
        ],
        total: 3,
        needles: vec!["budget".into()],
    };
    let rows = crate::search_index::assemble_rows(root, "acct", &page);
    assert_eq!(rows.len(), 2, "a hit whose file vanished is dropped, not an error");
    assert_eq!(rows[0]["uid"], 9);
    assert_eq!(rows[0]["vaultDir"], "Archive");
    assert_eq!(rows[1]["uid"], 3);
    assert!(rows[1]["snippet"].as_str().unwrap().to_lowercase().contains("budget"));
    let matched: Vec<&str> = rows[1]["matchedIn"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert!(matched.contains(&"subject") && matched.contains(&"body"));
    assert!(rows[0]["flags"].as_array().unwrap().iter().any(|f| f == "\\Seen"), "flags from the filename");

    // matchedIn reads names and addresses, not the JSON around them.
    let keys = SearchPage { needles: vec!["address".into()], ..page };
    let rows = crate::search_index::assemble_rows(root, "acct", &keys);
    assert!(rows.iter().all(|r| r["matchedIn"].as_array().unwrap().is_empty()), "{rows:?}");
    assert!(rows.iter().all(|r| r["snippet"].is_null()));
}

#[test]
fn assemble_rows_drops_a_hit_whose_uid_now_holds_another_message() {
    use mailvault_core::search_index::query::{SearchHit, SearchPage};
    let tmp = tempfile::tempdir().unwrap();
    let cur = tmp.path().join("Maildir/acct/INBOX/cur");
    std::fs::create_dir_all(&cur).unwrap();
    for (uid, id) in [(5u32, "<reissued@x.test>"), (6, "<six@x.test>")] {
        std::fs::write(cur.join(format!("{uid}:2,.eml")), format!("From: a@x.test\r\nSubject: Budget {uid}\r\nMessage-ID: {id}\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\n\r\nbudget\r\n")).unwrap();
    }
    let hit = |uid: u32, id: &str| SearchHit { vault_dir: "INBOX".into(), uid, filename: format!("{uid}:2,.eml"), message_id: Some(id.into()) };
    // Indexed before a UID reissue repair gave uid 5 to another message.
    let page = SearchPage { hits: vec![hit(5, "<indexed@x.test>"), hit(6, "<six@x.test>")], total: 2, needles: vec!["budget".into()] };
    let rows = crate::search_index::assemble_rows(tmp.path(), "acct", &page);
    let uids: Vec<u64> = rows.iter().filter_map(|r| r["uid"].as_u64()).collect();
    assert_eq!(uids, vec![6], "the reissued uid's row is another message: dropped, never shown for this hit");
}

/// Not a gate. The app parser over 50k ~3 KB multipart files, then what
/// `vault_search` does per query (`search`, then `assemble_rows`), on a warm
/// page cache (the files were just written). On the mini (a release test binary
/// finds Sparkle only through DYLD_FRAMEWORK_PATH):
/// DYLD_FRAMEWORK_PATH=$PWD/src-tauri SPARKLE_FRAMEWORK_PATH=$PWD/src-tauri cargo test -p mailvault --release search_index_bench -- --ignored --nocapture
#[test]
#[ignore]
fn search_index_bench_50k_real_parser() {
    use mailvault_core::search_index::{db, lock, query::{search, SearchRequest}, reconcile::{self, IndexConfig}};
    use std::time::Instant;

    // splitmix64: which messages carry a word is set by its rate alone.
    fn mix(mut x: u64) -> u64 {
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        x ^ (x >> 31)
    }
    // No filler word contains a dictionary word, "update" or a digit.
    const FILLER: [&str; 32] = [
        "please", "review", "attached", "notes", "thanks", "regards", "schedule", "team", "project", "status",
        "follow", "question", "morning", "office", "travel", "weekend", "details", "summary", "action", "items",
        "customer", "product", "launch", "design", "draft", "final", "approve", "agenda", "call", "friday",
        "monday", "report",
    ];
    // (word, percent of messages whose body carries it)
    const DICT: [(&str, u64); 10] = [
        ("invoice", 5), ("meeting", 6), ("budget", 8), ("shipment", 3), ("contract", 4),
        ("会議", 3), ("資料", 2), ("Réunion", 1), ("delivery", 10), ("quarterly", 7),
    ];
    const N: u32 = 50_000;
    const NEWEST: i64 = 1_789_207_200; // Sat, 12 Sep 2026 10:00:00 +0000; message i is i*10 minutes older

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let t = Instant::now();
    let mut bytes = 0usize;
    for i in 1..=N {
        let seed = u64::from(i) << 20;
        let mut words: Vec<&str> = (0..200).map(|k| FILLER[(mix(seed | k) % FILLER.len() as u64) as usize]).collect();
        for (k, (w, pct)) in DICT.iter().enumerate() {
            let k = k as u64;
            if mix(seed | (1000 + k)) % 100 < *pct {
                let at = (mix(seed | (2000 + k)) % words.len() as u64) as usize;
                words.insert(at, *w);
            }
        }
        let text = words.chunks(20).map(|c| c.join(" ")).collect::<Vec<_>>().join("\r\n");
        let html = words.chunks(20).map(|c| format!("<p>{}</p>", c.join(" "))).collect::<String>();
        let subject = FILLER[(mix(seed | 3000) % FILLER.len() as u64) as usize];
        let date = chrono::DateTime::from_timestamp(NEWEST - i64::from(i) * 600, 0).unwrap().to_rfc2822();
        let eml = format!(
            "From: Sender {s} <sender{s}@x.test>\r\nTo: Me <me@x.test>\r\nSubject: {subject} update {i}\r\nMessage-ID: <{i}@x.test>\r\nDate: {date}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body>{html}</body></html>\r\n--b--\r\n",
            s = i % 50
        );
        bytes += eml.len();
        let cur = root.join("Maildir/bench").join(["INBOX", "Archive", "Sent"][(i % 3) as usize]).join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(format!("{i}:2,S.eml")), eml).unwrap();
    }
    println!("corpus n={N} avg_bytes={} write={:?}", bytes / N as usize, t.elapsed());

    let db: mailvault_core::search_index::SharedConn = std::sync::Mutex::new(Some(db::open(root).unwrap()));
    let maildir = root.join("Maildir");
    let t = Instant::now();
    for (a, d) in reconcile::list_vault_dirs(&maildir) {
        let parse = &crate::search_index::index_doc_from_light;
        reconcile::reconcile_mailbox(&db, &maildir, &a, &d, IndexConfig { bodies: true }, parse, &|| true, &mut |_| {}).unwrap();
    }
    println!("index_build n={N} elapsed={:?}", t.elapsed());
    {
        let g = lock(&db);
        let conn = g.as_ref().unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        let t = Instant::now();
        let c = db::counts(conn);
        println!("db_bytes={} counts indexed={} total={} elapsed={:?}", db::db_size_bytes(root), c.indexed, c.total, t.elapsed());
    }

    let req = |q: &str| SearchRequest { account_id: "bench".into(), query: q.into(), ..Default::default() };
    let week = SearchRequest { date_from: Some(NEWEST - 7 * 86_400), date_to: Some(NEWEST), ..req("") };
    for (label, r) in [("invoice", req("invoice")), ("budget meeting", req("budget meeting")), ("会議", req("会議")), ("update 4999", req("update 4999")), ("<empty>, last 7 days", week)] {
        let t = Instant::now();
        let page = search(lock(&db).as_ref().unwrap(), &r).unwrap();
        let searched = t.elapsed();
        let t = Instant::now();
        let rows = crate::search_index::assemble_rows(root, "bench", &page);
        println!("query {label:?} total={} hits={} rows={} search={searched:?} assemble={:?}", page.total, page.hits.len(), rows.len(), t.elapsed());
    }
}
