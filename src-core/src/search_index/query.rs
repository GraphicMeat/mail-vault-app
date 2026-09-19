//! Search queries over the index. Spec §6.4.
//!
//! User text reaches SQLite only as bound parameters. FTS strings are always
//! double-quoted with `"` doubled, so no FTS syntax (`OR`, `NEAR`, `*`, `:`)
//! passes through.

use crate::search_index::text::{cjk_units, is_cjk, vault_dir_name};
use rusqlite::types::Value;

pub const DEFAULT_LIMIT: usize = 500;
pub const MAX_LIMIT: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MatchPlan {
    /// FTS string for the whole query, when ≥3 chars.
    pub whole: Option<String>,
    /// `"t1" AND "t2"` over the long (≥3 chars) terms.
    pub all_long: Option<String>,
    /// FTS strings for `msg_cjk`, one per CJK-short term.
    pub cjk: Vec<String>,
    /// Lowercase query when every term is Latin-short.
    pub like: Option<String>,
    /// Lowercase strings for snippet / matched_in.
    pub needles: Vec<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchRequest {
    pub account_id: String,
    pub query: String,
    /// Server paths; sanitized here.
    pub mailboxes: Option<Vec<String>>,
    pub sender: Option<String>,
    /// Unix seconds, inclusive.
    pub date_from: Option<i64>,
    /// Unix seconds, inclusive.
    pub date_to: Option<i64>,
    pub has_attachments: bool,
    /// Default 500, max 2000.
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub vault_dir: String,
    pub uid: u32,
    pub filename: String,
    /// The Message-ID indexed for this uid, rechecked by the reader when opened.
    pub message_id: Option<String>,
    /// Stored list-row metadata. Search result assembly must not parse the `.eml`.
    pub row_json: String,
}

#[derive(Debug, Clone, Default)]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    pub total: u64,
    pub needles: Vec<String>,
}

pub fn fts_string(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

pub fn plan_query(query: &str) -> MatchPlan {
    let q = query.replace('"', " ").split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    if q.is_empty() {
        return MatchPlan::default();
    }
    let terms: Vec<&str> = q.split(' ').collect();
    let long: Vec<&str> = terms.iter().copied().filter(|t| t.chars().count() >= 3).collect();
    let cjk_short: Vec<&str> =
        terms.iter().copied().filter(|t| t.chars().count() < 3 && t.chars().any(is_cjk)).collect();
    let mut plan = MatchPlan::default();
    if long.is_empty() && cjk_short.is_empty() {
        plan.like = Some(q.clone());
        plan.needles = vec![q];
        return plan;
    }
    if q.chars().count() >= 3 {
        plan.whole = Some(fts_string(&q));
    }
    if !long.is_empty() {
        let all_long = long.iter().map(|t| fts_string(t)).collect::<Vec<_>>().join(" AND ");
        // One long word is the whole query: the same MATCH twice buys nothing.
        if plan.whole.as_ref() != Some(&all_long) {
            plan.all_long = Some(all_long);
        }
    }
    plan.cjk = cjk_short.iter().map(|t| fts_string(&cjk_units(t))).collect();
    plan.needles =
        std::iter::once(q.clone()).chain(long.iter().chain(cjk_short.iter()).map(|t| t.to_string())).collect();
    plan
}

fn like_pattern(s: &str) -> String {
    format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

pub fn search(conn: &rusqlite::Connection, req: &SearchRequest) -> Result<SearchPage, String> {
    let plan = plan_query(&req.query);
    // `clauses` and `args` grow together: every `?` is pushed with its value.
    let mut clauses: Vec<String> = vec!["m.account_id = ?".into()];
    let mut args: Vec<Value> = vec![Value::Text(req.account_id.clone())];

    if let Some(like) = &plan.like {
        clauses.push(
            "(m.subject_lc LIKE ? ESCAPE '\\' OR m.from_addr_lc LIKE ? ESCAPE '\\' OR m.from_name_lc LIKE ? ESCAPE '\\')"
                .into(),
        );
        for _ in 0..3 {
            args.push(Value::Text(like_pattern(like)));
        }
    } else if plan.whole.is_some() || plan.all_long.is_some() || !plan.cjk.is_empty() {
        let mut branches: Vec<String> = Vec::new();
        if let Some(w) = &plan.whole {
            branches.push("m.id IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)".into());
            args.push(Value::Text(w.clone()));
        }
        let mut all: Vec<String> = Vec::new();
        if let Some(l) = &plan.all_long {
            all.push("m.id IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)".into());
            args.push(Value::Text(l.clone()));
        }
        for c in &plan.cjk {
            all.push("m.id IN (SELECT rowid FROM msg_cjk WHERE msg_cjk MATCH ?)".into());
            args.push(Value::Text(c.clone()));
        }
        if !all.is_empty() {
            branches.push(format!("({})", all.join(" AND ")));
        }
        clauses.push(format!("({})", branches.join(" OR ")));
    }

    if let Some(boxes) = req.mailboxes.as_ref().filter(|b| !b.is_empty()) {
        clauses.push(format!("m.vault_dir IN ({})", vec!["?"; boxes.len()].join(",")));
        args.extend(boxes.iter().map(|b| Value::Text(vault_dir_name(b))));
    }
    if let Some(sender) = req.sender.as_ref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()) {
        clauses.push("(m.from_addr_lc LIKE ? ESCAPE '\\' OR m.from_name_lc LIKE ? ESCAPE '\\')".into());
        args.push(Value::Text(like_pattern(&sender)));
        args.push(Value::Text(like_pattern(&sender)));
    }
    if let Some(from) = req.date_from {
        clauses.push("m.date_utc >= ?".into());
        args.push(Value::Integer(from));
    }
    if let Some(to) = req.date_to {
        clauses.push("m.date_utc <= ?".into());
        args.push(Value::Integer(to));
    }
    if req.has_attachments {
        clauses.push("m.has_attachments = 1".into());
    }

    let where_sql = clauses.join(" AND ");
    let total: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM messages m WHERE {where_sql}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    // Formatted from the clamped usize only, never from request text.
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut st = conn
        .prepare(&format!(
            "SELECT m.vault_dir, m.uid, m.filename, m.message_id, m.row_json FROM messages m WHERE {where_sql} ORDER BY m.date_utc DESC, m.id DESC LIMIT {limit}"
        ))
        .map_err(|e| e.to_string())?;
    let hits = st
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok(SearchHit { vault_dir: r.get(0)?, uid: r.get(1)?, filename: r.get(2)?, message_id: r.get(3)?, row_json: r.get(4)? })
        })
        .map_err(|e| e.to_string())?
        // ponytail: a row that fails to decode (uid out of u32 range) is skipped, not fatal to the page.
        .filter_map(Result::ok)
        .collect();

    Ok(SearchPage { hits, total: u64::try_from(total).unwrap_or(0), needles: plan.needles })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search_index::{db, reconcile::*, SharedConn};
    use std::sync::Mutex;

    #[test]
    fn plan_routes_terms() {
        let p = plan_query("  body of Luke message 12 ");
        assert_eq!(p.whole.as_deref(), Some("\"body of luke message 12\""));
        assert_eq!(p.all_long.as_deref(), Some("\"body\" AND \"luke\" AND \"message\""));
        assert!(p.cjk.is_empty() && p.like.is_none());

        let p = plan_query("会議");
        assert_eq!(p.whole, None);
        assert_eq!(p.cjk, vec!["\"会 議\"".to_string()]);

        let p = plan_query("hi");
        assert_eq!(p.like.as_deref(), Some("hi"));
        assert!(p.whole.is_none() && p.all_long.is_none());

        assert_eq!(plan_query("   "), MatchPlan::default());
    }

    #[test]
    fn one_word_query_matches_once() {
        let p = plan_query("Invoice");
        assert_eq!(p.whole.as_deref(), Some("\"invoice\""));
        assert_eq!(p.all_long, None, "a second identical MATCH buys nothing");
        let p = plan_query("invoice 4471");
        assert_eq!(p.all_long.as_deref(), Some("\"invoice\" AND \"4471\""));
    }

    #[test]
    fn plan_never_passes_fts_syntax_through() {
        let p = plan_query("NEAR(a b) \"x\" OR y* col:z");
        for s in p.whole.iter().chain(p.all_long.iter()) {
            // every token is inside a double-quoted string; no bare operators
            let outside: String = s.split('"').step_by(2).collect();
            assert!(outside.chars().all(|c| c == ' ' || "AND".contains(c)), "{s}");
        }
    }

    fn eml(subject: &str, from: &str, date: &str, body: &str) -> String {
        // Declared charset: without it mailparse decodes the body as us-ascii (= windows-1252), so CJK/diacritic bodies turn to mojibake.
        format!("From: {from}\r\nTo: me@x.test\r\nSubject: {subject}\r\nDate: {date}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n")
    }

    fn parse(raw: &[u8], _uid: u32, _n: &str) -> Option<IndexDoc> {
        let m = mailparse::parse_mail(raw).ok()?;
        let h = |k: &str| m.headers.iter().find(|x| x.get_key().eq_ignore_ascii_case(k)).map(|x| x.get_value());
        let from = h("From").unwrap_or_default();
        Some(IndexDoc {
            message_id: h("Message-ID"),
            date_utc: h("Date").and_then(|d| mailparse::dateparse(&d).ok()),
            from_addr: from.clone(), from_name: String::new(),
            addrs: vec![from], subject: h("Subject").unwrap_or_default(),
            body_text: m.get_body().unwrap_or_default(),
            has_attachments: h("X-Has-Attachment").is_some(),
            ..Default::default()
        })
    }

    fn fixture() -> (tempfile::TempDir, SharedConn) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let db = Mutex::new(Some(db::open(&root).unwrap()));
        let files = [
            ("luke", "INBOX", 1, eml("Luke message 1", "Ann <ann@x.test>", "Mon, 07 Sep 2026 10:00:00 +0000", "Body of luke message 1 for luke@mock.test.")),
            ("luke", "INBOX", 2, eml("Invoice PO 4471", "Billing <billing@acme.test>", "Tue, 08 Sep 2026 10:00:00 +0000", "please find attached")),
            ("luke", "Projects_2026", 1, eml("明日の会議について", "Ken <ken@x.test>", "Wed, 09 Sep 2026 10:00:00 +0000", "資料を添付します")),
            ("luke", "INBOX", 3, eml("Réunion budget", "Zoé <zoe@x.test>", "Thu, 10 Sep 2026 10:00:00 +0000", "Ünïcödé naïve")),
            ("vader", "INBOX", 1, eml("Vader message 1", "Sid <sid@x.test>", "Fri, 11 Sep 2026 10:00:00 +0000", "Body of vader message 1 and luke message 1 quoted")),
        ];
        for (acct, dir, uid, content) in files {
            let cur = root.join("Maildir").join(acct).join(dir).join("cur");
            std::fs::create_dir_all(&cur).unwrap();
            std::fs::write(cur.join(format!("{uid}:2,.eml")), format!("Message-ID: <{acct}.{dir}.{uid}@x.test>\r\n{content}")).unwrap();
        }
        for (a, d) in list_vault_dirs(&root.join("Maildir")).unwrap() {
            reconcile_mailbox(&db, &root.join("Maildir"), &a, &d, IndexConfig { bodies: true, attachments: false, image_text: false }, &parse, &|| true, &mut |_| {}).unwrap();
        }
        (tmp, db)
    }

    fn uids(db: &SharedConn, req: SearchRequest) -> Vec<(String, u32)> {
        let g = crate::search_index::lock(db);
        search(g.as_ref().unwrap(), &req).unwrap().hits.into_iter().map(|h| (h.vault_dir, h.uid)).collect()
    }

    fn req(account: &str, q: &str) -> SearchRequest {
        SearchRequest { account_id: account.into(), query: q.into(), ..Default::default() }
    }

    fn coverage_fixture() -> (tempfile::TempDir, rusqlite::Connection) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        (tmp, conn)
    }

    fn seed_scan(conn: &rusqlite::Connection, account: &str, vault_dir: &str, file_count: i64) {
        conn.execute(
            "INSERT INTO mailbox_scan (account_id, vault_dir, scanned_at, file_count) VALUES (?1, ?2, 1, ?3)",
            rusqlite::params![account, vault_dir, file_count],
        ).unwrap();
    }

    fn seed_rows(conn: &rusqlite::Connection, account: &str, vault_dir: &str, count: u32, body_state: i64) {
        for uid in 1..=count {
            conn.execute(
                "INSERT INTO messages (account_id, vault_dir, uid, filename, size, mtime_ns, date_utc, body_state) VALUES (?1, ?2, ?3, ?4, 1, 1, 1, ?5)",
                rusqlite::params![account, vault_dir, uid, format!("{uid}:2,.eml"), body_state],
            ).unwrap();
        }
    }

    #[test]
    fn whole_phrase_substring_matches_like_includes_did() {
        let (_t, db) = fixture();
        assert_eq!(uids(&db, req("luke", "of luke message 1")), vec![("INBOX".into(), 1)]);
        assert_eq!(uids(&db, req("luke", "voic")), vec![("INBOX".into(), 2)]);
    }

    #[test]
    fn hits_carry_the_indexed_message_id() {
        let (_t, db) = fixture();
        let g = crate::search_index::lock(&db);
        let page = search(g.as_ref().unwrap(), &req("luke", "PO 4471")).unwrap();
        let ids: Vec<Option<&str>> = page.hits.iter().map(|h| h.message_id.as_deref()).collect();
        assert_eq!(ids, vec![Some("<luke.INBOX.2@x.test>")]);
    }

    #[test]
    fn short_words_do_not_kill_long_ones() {
        let (_t, db) = fixture();
        assert_eq!(uids(&db, req("luke", "PO 4471")), vec![("INBOX".into(), 2)]);
    }

    #[test]
    fn accounts_never_leak_into_each_other() {
        let (_t, db) = fixture();
        assert_eq!(uids(&db, req("vader", "luke message 1")), vec![("INBOX".into(), 1)], "vader's own quote only");
        assert!(uids(&db, req("luke", "vader")).is_empty());
    }

    #[test]
    fn cjk_two_chars_and_diacritics() {
        let (_t, db) = fixture();
        assert_eq!(uids(&db, req("luke", "会議")), vec![("Projects_2026".into(), 1)]);
        assert_eq!(uids(&db, req("luke", "資料")), vec![("Projects_2026".into(), 1)]);
        assert_eq!(uids(&db, req("luke", "unicode")), vec![("INBOX".into(), 3)]);
        assert_eq!(uids(&db, req("luke", "reunion")), vec![("INBOX".into(), 3)]);
    }

    #[test]
    fn short_latin_only_query_matches_headers_not_bodies() {
        let (_t, db) = fixture();
        assert_eq!(uids(&db, req("luke", "PO")), vec![("INBOX".into(), 2)]);
    }

    #[test]
    fn filters_and_order() {
        let (_t, db) = fixture();
        let all = uids(&db, SearchRequest { account_id: "luke".into(), ..Default::default() });
        assert_eq!(all, vec![("INBOX".into(), 3), ("Projects_2026".into(), 1), ("INBOX".into(), 2), ("INBOX".into(), 1)], "newest first");
        let scoped = uids(&db, SearchRequest { account_id: "luke".into(), mailboxes: Some(vec!["Projects/2026".into()]), ..Default::default() });
        assert_eq!(scoped, vec![("Projects_2026".into(), 1)]);
        let sender = uids(&db, SearchRequest { account_id: "luke".into(), sender: Some("ACME".into()), ..Default::default() });
        assert_eq!(sender, vec![("INBOX".into(), 2)]);
        // 2026-09-08T00:00:00Z .. 2026-09-09T23:59:59Z
        let dated = uids(&db, SearchRequest { account_id: "luke".into(), date_from: Some(1788825600), date_to: Some(1788998399), ..Default::default() });
        assert_eq!(dated, vec![("Projects_2026".into(), 1), ("INBOX".into(), 2)]);
    }

    #[test]
    fn limit_caps_hits_but_total_counts_all() {
        let (_t, db) = fixture();
        let g = crate::search_index::lock(&db);
        let page = search(g.as_ref().unwrap(), &SearchRequest { account_id: "luke".into(), limit: Some(2), ..Default::default() }).unwrap();
        assert_eq!((page.hits.len(), page.total), (2, 4));
    }

    #[test]
    fn scoped_coverage_names_only_incomplete_requested_folders() {
        let (_tmp, conn) = coverage_fixture();
        seed_scan(&conn, "a", "INBOX", 2);
        seed_scan(&conn, "a", "Archive", 3);
        seed_rows(&conn, "a", "INBOX", 2, 1);
        seed_rows(&conn, "a", "Archive", 1, 1);
        seed_scan(&conn, "b", "INBOX", 50);

        let coverage = db::scope_coverage(&conn, "a", Some(&["INBOX".into(), "Archive".into()])).unwrap();
        assert_eq!((coverage.indexed, coverage.total, coverage.complete), (3, 5, false));
        assert_eq!(coverage.uncovered_vault_dirs, vec!["Archive"]);
    }

    #[test]
    fn all_scope_coverage_includes_vault_only_and_body_pending_folders() {
        let (_tmp, conn) = coverage_fixture();
        seed_scan(&conn, "a", "vault-only", 4);
        seed_scan(&conn, "a", "pending", 1);
        seed_rows(&conn, "a", "pending", 1, crate::search_index::reconcile::BODY_PENDING);
        seed_scan(&conn, "b", "other-account", 99);

        let coverage = db::scope_coverage(&conn, "a", None).unwrap();
        assert_eq!((coverage.indexed, coverage.total, coverage.complete), (0, 5, false));
        assert_eq!(coverage.uncovered_vault_dirs, vec!["pending", "vault-only"]);
    }

    #[test]
    fn explicitly_requested_folder_without_scan_row_is_uncovered() {
        let (_tmp, conn) = coverage_fixture();
        let coverage = db::scope_coverage(&conn, "a", Some(&["Missing".into()])).unwrap();
        assert_eq!((coverage.indexed, coverage.total, coverage.complete), (0, 0, false));
        assert_eq!(coverage.uncovered_vault_dirs, vec!["Missing"]);
    }

    #[test]
    fn coverage_deduplicates_server_paths_that_share_a_vault_directory() {
        let (_tmp, conn) = coverage_fixture();
        seed_scan(&conn, "a", "Projects_2026", 2);
        seed_rows(&conn, "a", "Projects_2026", 2, 1);

        let coverage = db::scope_coverage(&conn, "a", Some(&["Projects/2026".into(), "Projects_2026".into()])).unwrap();
        assert_eq!((coverage.indexed, coverage.total, coverage.complete), (2, 2, true));
        assert!(coverage.uncovered_vault_dirs.is_empty());
    }
}
