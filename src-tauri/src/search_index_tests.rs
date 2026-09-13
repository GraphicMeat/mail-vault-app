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

fn eml_with_one_attachment() -> Vec<u8> {
    b"From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Report attached\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee attached.\r\n--b\r\nContent-Type: text/plain; name=\"notes.txt\"\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nhello world\r\n--b--\r\n".to_vec()
}

/// C1: the real `ParseFn` must populate `attachment_candidates` from the
/// message's actual MIME parts, not hardcode an empty Vec — that hardcode is
/// what made the whole attachment-search feature inert in production (no
/// pending row was ever written, so extraction never ran).
#[test]
fn adapter_lists_a_real_attachment_as_a_candidate() {
    let raw = eml_with_one_attachment();
    let doc = crate::search_index::index_doc_from_light(&raw, 1, "1:2,.eml").expect("parses");
    assert_eq!(doc.attachment_candidates.len(), 1, "{:?}", doc.attachment_candidates);
    let candidate = &doc.attachment_candidates[0];
    assert_eq!(candidate.filename, "notes.txt");
    assert_eq!(candidate.mime, "text/plain");
    // Size is the ENCODED part size (raw bytes, headers included) as an
    // upper bound on the decoded body, not the exact decoded length (I2):
    // this part is 7-bit so encoding adds no bloat, but the value comes from
    // `encoded_part_size`, never from decoding the body.
    let part_raw = b"Content-Type: text/plain; name=\"notes.txt\"\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nhello world\r\n";
    assert_eq!(candidate.size, part_raw.len() as u64);
}

#[test]
fn adapter_lists_no_candidates_for_a_message_with_no_attachments() {
    let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, "7:2,S.eml").expect("parses");
    assert!(doc.attachment_candidates.is_empty(), "{:?}", doc.attachment_candidates);
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

#[test]
fn search_index_status_is_available_during_the_first_build_but_search_is_not() {
    use mailvault_core::search_index::{db, lock, query::SearchRequest};
    let tmp = tempfile::tempdir().unwrap();
    let st = crate::search_index::SearchIndexState::default();
    let status = || crate::search_index::status_json(&st);
    let search = || {
        let req = SearchRequest { account_id: "acct".into(), query: "budget".into(), ..Default::default() };
        crate::search_index::search_reply(&st, &req).unwrap()
    };
    assert_eq!((status()["available"].as_bool(), search()["available"].as_bool()), (Some(false), Some(false)), "closed");

    *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
    *st.root.lock().unwrap() = Some(tmp.path().to_path_buf());
    let s = status();
    assert_eq!(s["available"], true, "open: Settings shows the first build's progress and can Rebuild");
    assert_eq!(s["indexed"], 0);
    assert_eq!(search()["available"], false, "a first build misses mail the scan finds: search keeps scanning");

    db::meta_set(lock(&st.db).as_ref().unwrap(), db::FIRST_PASS_DONE, "1").unwrap();
    let reply = search();
    assert_eq!(reply["available"], true);
    assert_eq!(reply["rows"], serde_json::json!([]));
    assert_eq!(status()["available"], true);
}

#[test]
fn vault_rows_reads_flags_off_the_current_filename_and_skips_unindexed_uids() {
    use mailvault_core::search_index::{db, lock};
    let tmp = tempfile::tempdir().unwrap();
    let st = crate::search_index::SearchIndexState::default();
    assert!(crate::search_index::rows_reply(&st, "acct", "INBOX", &[3]).is_empty(), "closed: nothing, the caller reads the files");

    *lock(&st.db) = Some(db::open(tmp.path()).unwrap());
    {
        let guard = lock(&st.db);
        let conn = guard.as_ref().unwrap();
        // The row was parsed while the file was unread and unarchived; it has been renamed since.
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state, row_json) \
             VALUES ('acct', 'INBOX', 3, '3:2,AS.eml', 1, 1, 1, 1, '{\"uid\":3,\"subject\":\"Budget\",\"isArchived\":false,\"hasAttachments\":true}')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state, row_json) \
             VALUES ('acct', 'Projects_2026', 5, '5:2,.eml', 1, 1, 1, 1, '{\"uid\":5,\"subject\":\"Nested\"}')",
            [],
        ).unwrap();
    }
    let rows = crate::search_index::rows_reply(&st, "acct", "INBOX", &[4, 3]);
    assert_eq!(rows.len(), 1, "uid 4 is not indexed: left to the file path");
    assert_eq!(rows[0]["uid"], 3);
    assert_eq!(rows[0]["subject"], "Budget");
    assert_eq!(rows[0]["hasAttachments"], true);
    assert_eq!(rows[0]["isArchived"], true, "from the current name, not the parse-time value");
    let flags: Vec<String> = rows[0]["flags"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_string()).collect();
    assert!(flags.iter().any(|f| f == "\\Seen") && flags.iter().any(|f| f == "archived"), "{flags:?}");
    // The mailbox argument is the server path; the index keys by the sanitized dir.
    let nested = crate::search_index::rows_reply(&st, "acct", "Projects/2026", &[5]);
    assert_eq!(nested.len(), 1);
    assert_eq!(nested[0]["isArchived"], false);
    assert_eq!(nested[0]["flags"], serde_json::json!([]));
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
    for (a, d) in reconcile::list_vault_dirs(&maildir).unwrap() {
        let parse = &crate::search_index::index_doc_from_light;
        reconcile::reconcile_mailbox(&db, &maildir, &a, &d, IndexConfig { bodies: true, attachments: true, image_text: true }, parse, &|| true, &mut |_| {}).unwrap();
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
