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
    /// Server paths to leave out, whatever else matched — how a view says
    /// "not Trash, not Spam". Applied after `mailboxes`.
    pub mailboxes_excluded: Vec<String>,
    pub sender: Option<String>,
    /// Unix seconds, inclusive.
    pub date_from: Option<i64>,
    /// Unix seconds, inclusive.
    pub date_to: Option<i64>,
    pub has_attachments: bool,
    /// Saved-view filters. `None` leaves the flag alone; `Some(true)` demands
    /// it. Flags are the Maildir letters the file name carries (`S` seen,
    /// `F` flagged, `R` replied), which is the only place they live.
    pub unread: Option<bool>,
    pub starred: Option<bool>,
    pub answered: Option<bool>,
    /// Keep a message only if one of these appears among its addresses. Used
    /// by "Needs reply" for the account's own address; matched against
    /// `addrs_lc`, which merges To, Cc, Bcc and Reply-To, so a message that
    /// only Cc'd you counts.
    pub to_any: Vec<String>,
    /// Drop a message sent by any of these. "Needs reply" excludes your own
    /// sent mail this way.
    pub from_none: Vec<String>,
    /// Restrict to these identities (`app_db::identity::msg_key`). This is how
    /// a view filtered by tag or by a custom field narrows: the identities come
    /// from `app.db`, the rows from here. `Some(empty)` matches nothing, which
    /// is what a tag nobody has used means.
    pub msg_keys: Option<Vec<String>>,
    /// Default 500, max 2000.
    pub limit: Option<usize>,
    /// Hits to skip, for a caller that walks past the cap one page at a time.
    pub offset: usize,
}

/// The `msg_key` of a row, in SQL: the `Message-ID` without its angle
/// brackets, else the mailbox and uid. Mirrors `app_db::identity::msg_key`.
pub const MSG_KEY_SQL: &str =
    "COALESCE(NULLIF(trim(m.message_id, '<> '), ''), 'u:' || m.vault_dir || ':' || m.uid)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub vault_dir: String,
    pub uid: u32,
    pub filename: String,
    /// The Message-ID indexed for this uid, rechecked by the reader when opened.
    pub message_id: Option<String>,
    /// Stored list-row metadata. Search result assembly must not parse the `.eml`.
    pub row_json: String,
    /// Whether any matched query term appears in the indexed body column.
    pub body_matched: bool,
    /// Same, for the indexed attachment-text column. A hit the attachment
    /// alone carries is invisible in the message the reader opens, so the row
    /// has to say where the match actually lives.
    pub attach_matched: bool,
    /// Internal merge keys preserving SQLite's existing newest-first order across mailbox batches.
    pub date_utc: i64,
    pub row_id: i64,
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

/// A query written with `&&` / `||`, as a view's word groups are saved:
/// `jasinskio && 14a-37 || mindaugo 30`. Words joined by `&&` must all
/// appear; groups joined by `||` are alternatives. `None` when the query has
/// neither operator, which keeps the plain query on `plan_query`.
/// ponytail: one level only, an OR of ANDs; parentheses are decoration, not
/// nesting. Parse a tree if views ever need `a && (b || c)`.
pub fn boolean_groups(query: &str) -> Option<Vec<Vec<String>>> {
    if !query.contains("&&") && !query.contains("||") {
        return None;
    }
    Some(
        query
            .split("||")
            .map(|group| {
                group
                    .split("&&")
                    .map(|word| word.replace(['(', ')', '"'], " ").split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase())
                    .filter(|word| !word.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|group| !group.is_empty())
            .collect(),
    )
}

/// One `&&` word as a WHERE clause. A word of 3+ characters is a phrase the
/// trigram index must hold, so `mindaugo 30` needs the `30` too. A two-letter
/// Latin word is too short for a trigram on its own, so it is also looked for
/// with the space or line break before it (`" 30"`, `"\n30"`), which finds the
/// house number in "Mindaugo g. 30" but not the tail of "130".
/// ponytail: left boundary only, so `30` also matches "300"; a whole-word match
/// needs a unicode61 index over Latin text, which means a reindex.
fn word_clause(word: &str, args: &mut Vec<Value>) -> String {
    if word.chars().count() >= 3 {
        args.push(Value::Text(fts_string(word)));
        return "m.id IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)".into();
    }
    if word.chars().any(is_cjk) {
        args.push(Value::Text(fts_string(&cjk_units(word))));
        return "m.id IN (SELECT rowid FROM msg_cjk WHERE msg_cjk MATCH ?)".into();
    }
    for _ in 0..3 {
        args.push(Value::Text(like_pattern(word)));
    }
    let headers = "m.subject_lc LIKE ? ESCAPE '\\' OR m.from_addr_lc LIKE ? ESCAPE '\\' OR m.from_name_lc LIKE ? ESCAPE '\\'";
    // One character plus its boundary is still under a trigram: headers only.
    if word.chars().count() < 2 {
        return format!("({headers})");
    }
    args.push(Value::Text(format!("{} OR {}", fts_string(&format!(" {word}")), fts_string(&format!("\n{word}")))));
    format!("({headers} OR m.id IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?))")
}

fn like_pattern(s: &str) -> String {
    format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

/// The FTS probes that say whether one column carries a matched term.
/// Column names are literals from this file, never request text.
fn column_queries(plan: &MatchPlan, column: &str) -> Vec<(&'static str, String)> {
    let mut queries: Vec<(&'static str, String)> = Vec::new();
    if let Some(whole) = &plan.whole {
        queries.push(("msg_fts", format!("{column} : {whole}")));
    }
    // A LIKE plan's one needle is the header text, never a body probe.
    for needle in plan.needles.iter().skip(usize::from(plan.like.is_some())).filter(|needle| needle.chars().count() >= 3) {
        let query = format!("{column} : {}", fts_string(needle));
        if !queries.iter().any(|(table, existing)| *table == "msg_fts" && *existing == query) {
            queries.push(("msg_fts", query));
        }
    }
    for cjk in &plan.cjk {
        queries.push(("msg_cjk", format!("{column} : {cjk}")));
    }
    queries
}

fn column_match_sql(queries: &[(&'static str, String)]) -> String {
    if queries.is_empty() {
        return "0".to_string();
    }
    queries
        .iter()
        // Uncorrelated on purpose: FTS5 runs the MATCH once. A correlated
        // `EXISTS (... WHERE rowid = m.id ...)` re-probes per row (~30x slower at 50k).
        .map(|(table, _)| format!("m.id IN (SELECT rowid FROM {table} WHERE {table} MATCH ?)"))
        .collect::<Vec<_>>()
        .join(" OR ")
}

pub fn search(conn: &rusqlite::Connection, req: &SearchRequest) -> Result<SearchPage, String> {
    let groups = boolean_groups(&req.query);
    let plan = match &groups {
        // Every word is a needle, so a hit's snippet and body/attachment
        // probes see whichever group matched.
        Some(groups) => {
            let words: Vec<String> = groups.iter().flatten().cloned().collect();
            MatchPlan {
                cjk: words
                    .iter()
                    .filter(|w| w.chars().count() < 3 && w.chars().any(is_cjk))
                    .map(|w| fts_string(&cjk_units(w)))
                    .collect(),
                needles: words,
                ..MatchPlan::default()
            }
        }
        None => plan_query(&req.query),
    };
    // `clauses` and `args` grow together: every `?` is pushed with its value.
    let mut clauses: Vec<String> = vec!["m.account_id = ?".into()];
    let mut args: Vec<Value> = vec![Value::Text(req.account_id.clone())];

    if let Some(groups) = &groups {
        // Only operators and no words is no text filter at all.
        if !groups.is_empty() {
            let any: Vec<String> = groups
                .iter()
                .map(|group| {
                    let all: Vec<String> = group.iter().map(|word| word_clause(word, &mut args)).collect();
                    format!("({})", all.join(" AND "))
                })
                .collect();
            clauses.push(format!("({})", any.join(" OR ")));
        }
    } else if let Some(like) = &plan.like {
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
    if !req.mailboxes_excluded.is_empty() {
        clauses.push(format!("m.vault_dir NOT IN ({})", vec!["?"; req.mailboxes_excluded.len()].join(",")));
        args.extend(req.mailboxes_excluded.iter().map(|b| Value::Text(vault_dir_name(b))));
    }
    if let Some(sender) = req.sender.as_ref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()) {
        // `a && b || c`, the notation the query words use: every name in a
        // group must match the sender, any one group is enough. Without an
        // operator the whole text is one name, spaces and all.
        let groups = boolean_groups(&sender).unwrap_or_else(|| vec![vec![sender.clone()]]);
        let mut any = Vec::new();
        for group in groups {
            let mut all = Vec::new();
            for name in group {
                all.push("(m.from_addr_lc LIKE ? ESCAPE '\\' OR m.from_name_lc LIKE ? ESCAPE '\\')");
                args.push(Value::Text(like_pattern(&name)));
                args.push(Value::Text(like_pattern(&name)));
            }
            any.push(format!("({})", all.join(" AND ")));
        }
        if !any.is_empty() {
            clauses.push(format!("({})", any.join(" OR ")));
        }
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
    for (letter, wanted) in [('S', req.unread.map(|u| !u)), ('F', req.starred), ('R', req.answered)] {
        let Some(wanted) = wanted else { continue };
        clauses.push(format!("instr(m.flags, '{letter}') {} 0", if wanted { ">" } else { "=" }));
    }
    if !req.to_any.is_empty() {
        let mut branches = Vec::new();
        for address in &req.to_any {
            // A row indexed before `to_lc` existed has none, and falling back
            // to every address on the message is what this filter used to do:
            // looser, but never emptier than before a reindex.
            branches.push("(m.to_lc LIKE ? ESCAPE '\\' OR (m.to_lc = '' AND m.addrs_lc LIKE ? ESCAPE '\\'))".to_string());
            let pattern = like_pattern(&address.trim().to_lowercase());
            args.push(Value::Text(pattern.clone()));
            args.push(Value::Text(pattern));
        }
        clauses.push(format!("({})", branches.join(" OR ")));
    }
    for address in &req.from_none {
        clauses.push("m.from_addr_lc NOT LIKE ? ESCAPE '\\'".into());
        args.push(Value::Text(like_pattern(&address.trim().to_lowercase())));
    }
    if let Some(keys) = &req.msg_keys {
        // A temp table rather than an `IN (?, ?, ...)`: a view's identity list
        // is unbounded and SQLite's parameter limit is 999. Temp tables are
        // per-connection, and the index holds exactly one.
        conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS view_keys (k TEXT PRIMARY KEY); DELETE FROM view_keys;")
            .map_err(|e| e.to_string())?;
        {
            let mut insert =
                conn.prepare_cached("INSERT OR IGNORE INTO temp.view_keys(k) VALUES (?1)").map_err(|e| e.to_string())?;
            for key in keys {
                insert.execute([key]).map_err(|e| e.to_string())?;
            }
        }
        clauses.push(format!("{MSG_KEY_SQL} IN (SELECT k FROM temp.view_keys)"));
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
    let offset = req.offset;
    let body_queries = column_queries(&plan, "body");
    let attach_queries = column_queries(&plan, "attach");
    let body_match_sql = column_match_sql(&body_queries);
    let attach_match_sql = column_match_sql(&attach_queries);
    // Bound in the same order the SQL names them: the two column probes in the
    // SELECT list first, then the WHERE clause's own values.
    let mut select_args: Vec<Value> = body_queries
        .iter()
        .chain(attach_queries.iter())
        .map(|(_, query)| Value::Text(query.clone()))
        .collect();
    select_args.extend(args.iter().cloned());
    let mut st = conn
        .prepare(&format!(
            "SELECT m.vault_dir, m.uid, m.filename, m.message_id, m.row_json, ({body_match_sql}), ({attach_match_sql}), m.date_utc, m.id FROM messages m WHERE {where_sql} ORDER BY m.date_utc DESC, m.id DESC LIMIT {limit} OFFSET {offset}"
        ))
        .map_err(|e| e.to_string())?;
    let hits = st
        .query_map(rusqlite::params_from_iter(select_args.iter()), |r| {
            Ok(SearchHit { vault_dir: r.get(0)?, uid: r.get(1)?, filename: r.get(2)?, message_id: r.get(3)?, row_json: r.get(4)?, body_matched: r.get(5)?, attach_matched: r.get(6)?, date_utc: r.get(7)?, row_id: r.get(8)? })
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
    use crate::maildir::INFO_PREFIX;
    use crate::search_index::{db, reconcile::*, SharedConn};
    use std::sync::Mutex;

    #[test]
    fn column_match_sql_is_uncorrelated() {
        let sql = column_match_sql(&[("msg_fts", "body : \"a\"".into()), ("msg_cjk", "body : \"b\"".into())]);
        assert_eq!(sql.matches("m.id IN (SELECT rowid FROM").count(), 2);
        assert!(!sql.contains("rowid = m.id") && !sql.contains("EXISTS"), "correlated FTS probe is per-row slow: {sql}");
        assert_eq!(column_match_sql(&[]), "0");
    }

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
            // The production parser merges From, To, Cc, Bcc and Reply-To into
            // `addrs`, and keeps the recipients on their own in `to_addrs`.
            addrs: vec![from, h("To").unwrap_or_default()],
            to_addrs: h("To").into_iter().collect(),
            subject: h("Subject").unwrap_or_default(),
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
            std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}.eml")), format!("Message-ID: <{acct}.{dir}.{uid}@x.test>\r\n{content}")).unwrap();
        }
        for (a, d) in list_vault_dirs(&root.join("Maildir")).unwrap() {
            reconcile_mailbox(&db, &root.join("Maildir"), &a, &d, IndexConfig { bodies: true, attachments: false, image_text: false }, &parse, &|| true, &mut |_| {}).unwrap();
        }
        (tmp, db)
    }

    /// The fixture's files are all `:2,` with no flags, so a flag filter is
    /// tested by renaming one the way a star does and reconciling again.
    fn star(tmp: &tempfile::TempDir, db: &SharedConn, acct: &str, dir: &str, uid: u32, letters: &str) {
        let root = tmp.path().to_path_buf();
        let cur = root.join("Maildir").join(acct).join(dir).join("cur");
        std::fs::rename(cur.join(format!("{uid}{INFO_PREFIX}.eml")), cur.join(format!("{uid}{INFO_PREFIX}{letters}.eml"))).unwrap();
        reconcile_mailbox(db, &root.join("Maildir"), acct, dir, IndexConfig { bodies: true, attachments: false, image_text: false }, &parse, &|| true, &mut |_| {}).unwrap();
    }

    #[test]
    fn an_excluded_mailbox_is_left_out_whatever_else_matched() {
        let (_tmp, db) = fixture();
        let all = uids(&db, req("luke", ""));
        let kept = uids(&db, SearchRequest { mailboxes_excluded: vec!["Projects/2026".into()], ..req("luke", "") });
        assert_eq!(all.len(), 4);
        assert_eq!(kept.len(), 3);
        assert!(!kept.iter().any(|(dir, _)| dir == "Projects_2026"));
    }

    #[test]
    fn starred_narrows_to_the_flagged_messages() {
        let (tmp, db) = fixture();
        star(&tmp, &db, "luke", "INBOX", 2, "FS");
        let hits = uids(&db, SearchRequest { starred: Some(true), ..req("luke", "") });
        assert_eq!(hits, vec![("INBOX".to_string(), 2)]);
    }

    #[test]
    fn unread_is_the_absence_of_the_seen_flag() {
        let (tmp, db) = fixture();
        star(&tmp, &db, "luke", "INBOX", 2, "S");
        let unread = uids(&db, SearchRequest { unread: Some(true), ..req("luke", "") });
        assert!(!unread.contains(&("INBOX".to_string(), 2)), "uid 2 has been seen");
        assert_eq!(unread.len(), 3, "the other three luke messages are unread");
        let read = uids(&db, SearchRequest { unread: Some(false), ..req("luke", "") });
        assert_eq!(read, vec![("INBOX".to_string(), 2)]);
    }

    #[test]
    fn answered_filters_on_the_replied_flag() {
        let (tmp, db) = fixture();
        star(&tmp, &db, "luke", "INBOX", 1, "RS");
        assert_eq!(uids(&db, SearchRequest { answered: Some(true), ..req("luke", "") }), vec![("INBOX".to_string(), 1)]);
        let unanswered = uids(&db, SearchRequest { answered: Some(false), ..req("luke", "") });
        assert_eq!(unanswered.len(), 3);
    }

    #[test]
    fn to_any_matches_a_recipient_the_message_carries() {
        let (_tmp, db) = fixture();
        assert_eq!(uids(&db, SearchRequest { to_any: vec!["me@x.test".into()], ..req("luke", "") }).len(), 4);
        assert!(uids(&db, SearchRequest { to_any: vec!["nobody@x.test".into()], ..req("luke", "") }).is_empty());
    }

    /// "Addressed to me" must not mean "mentions me": every message carries its
    /// own sender among its addresses, so a filter that read them all would
    /// hand a person their own Sent folder.
    #[test]
    fn to_any_is_the_recipients_not_the_sender() {
        let (_tmp, db) = fixture();
        assert!(
            uids(&db, SearchRequest { to_any: vec!["ann@x.test".into()], ..req("luke", "") }).is_empty(),
            "ann sent uid 1, she did not receive it"
        );
    }

    #[test]
    fn from_none_drops_the_senders_it_names() {
        let (_tmp, db) = fixture();
        let hits = uids(&db, SearchRequest { from_none: vec!["billing@acme.test".into()], ..req("luke", "") });
        assert!(!hits.contains(&("INBOX".to_string(), 2)));
        assert_eq!(hits.len(), 3);
    }

    /// How a view filtered by tag finds its messages: the identities come from
    /// `app.db`, the rows from here.
    #[test]
    fn msg_keys_restrict_the_result_to_those_identities() {
        let (_tmp, db) = fixture();
        let keys = vec!["luke.INBOX.2@x.test".to_string()];
        assert_eq!(uids(&db, SearchRequest { msg_keys: Some(keys), ..req("luke", "") }), vec![("INBOX".to_string(), 2)]);
    }

    #[test]
    fn a_message_with_no_message_id_is_reachable_by_its_mailbox_and_uid() {
        let (tmp, db) = fixture();
        let root = tmp.path().to_path_buf();
        let cur = root.join("Maildir/luke/INBOX/cur");
        std::fs::write(cur.join(format!("9{INFO_PREFIX}.eml")), eml("No identity", "Ann <ann@x.test>", "Mon, 07 Sep 2026 10:00:00 +0000", "body")).unwrap();
        reconcile_mailbox(&db, &root.join("Maildir"), "luke", "INBOX", IndexConfig { bodies: true, attachments: false, image_text: false }, &parse, &|| true, &mut |_| {}).unwrap();
        let keys = vec!["u:INBOX:9".to_string()];
        assert_eq!(uids(&db, SearchRequest { msg_keys: Some(keys), ..req("luke", "") }), vec![("INBOX".to_string(), 9)]);
    }

    #[test]
    fn an_empty_identity_list_matches_nothing() {
        let (_tmp, db) = fixture();
        assert!(uids(&db, SearchRequest { msg_keys: Some(Vec::new()), ..req("luke", "") }).is_empty());
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
                rusqlite::params![account, vault_dir, uid, format!("{uid}{INFO_PREFIX}.eml"), body_state],
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
    fn reports_body_matches_from_fts_without_loading_body_text() {
        let (_t, db) = fixture();
        let g = crate::search_index::lock(&db);
        let body = search(g.as_ref().unwrap(), &req("luke", "attached")).unwrap();
        assert_eq!(body.hits.len(), 1);
        assert!(body.hits[0].body_matched);

        let subject = search(g.as_ref().unwrap(), &req("luke", "invoice")).unwrap();
        assert_eq!(subject.hits.len(), 1);
        assert!(!subject.hits[0].body_matched);
    }

    #[test]
    fn reports_attachment_matches_separately_from_body() {
        let (_t, db) = fixture();
        let g = crate::search_index::lock(&db);
        let conn = g.as_ref().unwrap();
        // What the extraction pass leaves behind: the FTS row rewritten with
        // the attachment's text in the `attach` column.
        let id: i64 = conn
            .query_row("SELECT id FROM messages WHERE account_id='luke' AND vault_dir='INBOX' AND uid=2", [], |r| r.get(0))
            .unwrap();
        conn.execute("DELETE FROM msg_fts WHERE rowid = ?1", [id]).unwrap();
        conn.execute(
            "INSERT INTO msg_fts(rowid, subject, addrs, body, attach) VALUES (?1, 'invoice po 4471', '', 'please find attached', 'quarterly fondue budget')",
            [id],
        )
        .unwrap();

        let attach = search(conn, &req("luke", "fondue")).unwrap();
        assert_eq!(attach.hits.len(), 1);
        assert!(attach.hits[0].attach_matched, "a term only the attachment carries must be reported as an attachment match");
        assert!(!attach.hits[0].body_matched);

        let body = search(conn, &req("luke", "attached")).unwrap();
        assert_eq!(body.hits.len(), 1);
        assert!(body.hits[0].body_matched);
        assert!(!body.hits[0].attach_matched, "a body-only term must not claim the attachment");
    }

    #[test]
    fn boolean_groups_split_or_then_and() {
        assert_eq!(boolean_groups("invoice PO"), None, "no operator keeps the plain plan");
        assert_eq!(
            boolean_groups("(Jasinskio && 14a-37) || (mindaugo  30) ||"),
            Some(vec![vec!["jasinskio".to_string(), "14a-37".to_string()], vec!["mindaugo 30".to_string()]])
        );
        assert_eq!(boolean_groups("|| &&"), Some(vec![]));
    }

    #[test]
    fn or_groups_match_either_and_words_must_all_appear() {
        let (_t, db) = fixture();
        // Group 1 needs both words; only message 1 has "luke" and "for".
        // Group 2 is the invoice. The budget mail matches neither.
        assert_eq!(
            uids(&db, req("luke", "(luke && for) || invoice")),
            vec![("INBOX".into(), 2), ("INBOX".into(), 1)]
        );
        assert!(uids(&db, req("luke", "luke && budget")).is_empty(), "AND demands every word");
        assert_eq!(uids(&db, req("luke", "zzz || 会議")), vec![("Projects_2026".into(), 1)], "short CJK word");
        assert_eq!(uids(&db, req("luke", "PO && invoice")), vec![("INBOX".into(), 2)], "short latin word");
    }

    #[test]
    fn a_word_with_a_short_number_keeps_the_number() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let db = Mutex::new(Some(db::open(&root).unwrap()));
        let cur = root.join("Maildir").join("a").join("INBOX").join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        for (uid, body) in [(1, "Deliver to Mindaugo g. 12"), (2, "Deliver to Mindaugo 30")] {
            let content = eml("Parcel", "Shop <s@x.test>", "Mon, 07 Sep 2026 10:00:00 +0000", body);
            std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}.eml")), format!("Message-ID: <{uid}@x.test>\r\n{content}")).unwrap();
        }
        reconcile_mailbox(&db, &root.join("Maildir"), "a", "INBOX", IndexConfig { bodies: true, attachments: false, image_text: false }, &parse, &|| true, &mut |_| {}).unwrap();
        assert_eq!(uids(&db, req("a", "jasinskio || mindaugo 30")), vec![("INBOX".into(), 2)]);
    }

    #[test]
    fn a_short_word_after_and_matches_in_the_body_too() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let db = Mutex::new(Some(db::open(&root).unwrap()));
        let cur = root.join("Maildir").join("a").join("INBOX").join("cur");
        std::fs::create_dir_all(&cur).unwrap();
        let bodies = [
            (1, "Deliver to Mindaugo g. 30, Vilnius"),
            (2, "Deliver to Mindaugo g. 12"),
            (3, "Deliver to Mindaugo g. 130"),
            (4, "Deliver to Mindaugo g.\r\n30 butas"),
            (5, "Deliver to Gedimino pr. 30"),
        ];
        for (uid, body) in bodies {
            let content = eml("Parcel", "Shop <s@x.test>", "Mon, 07 Sep 2026 10:00:00 +0000", body);
            std::fs::write(cur.join(format!("{uid}{INFO_PREFIX}.eml")), format!("Message-ID: <{uid}@x.test>\r\n{content}")).unwrap();
        }
        reconcile_mailbox(&db, &root.join("Maildir"), "a", "INBOX", IndexConfig { bodies: true, attachments: false, image_text: false }, &parse, &|| true, &mut |_| {}).unwrap();
        let mut got = uids(&db, req("a", "mindaugo && 30"));
        got.sort();
        // "30" after a space or at a line start; not the tail of "130".
        assert_eq!(got, vec![("INBOX".into(), 1), ("INBOX".into(), 4)]);
        // One character is below what the trigram index can hold: headers only.
        assert!(uids(&db, req("a", "mindaugo && g")).is_empty());
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
    fn senders_combine_with_and_and_or_like_the_query_words() {
        let (_t, db) = fixture();
        let from = |sender: &str| uids(&db, SearchRequest { account_id: "luke".into(), sender: Some(sender.into()), ..Default::default() });
        assert_eq!(from("acme || ann"), vec![("INBOX".into(), 2), ("INBOX".into(), 1)], "either sender");
        assert_eq!(from("billing && acme"), vec![("INBOX".into(), 2)], "both parts of one sender");
        assert!(from("ann && acme").is_empty(), "no single sender is both");
        assert_eq!(from("ann && x.test || billing"), vec![("INBOX".into(), 2), ("INBOX".into(), 1)]);
        // No operator: one name, spaces and all, exactly as before.
        assert!(from("ann ken").is_empty());
    }

    #[test]
    fn hits_expose_internal_merge_keys_in_existing_order() {
        let (_t, db) = fixture();
        let g = crate::search_index::lock(&db);
        let page = search(g.as_ref().unwrap(), &SearchRequest { account_id: "luke".into(), ..Default::default() }).unwrap();
        assert!(page.hits.windows(2).all(|pair| (pair[0].date_utc, pair[0].row_id) >= (pair[1].date_utc, pair[1].row_id)));
        assert!(page.hits.iter().all(|hit| hit.row_id > 0));
    }

    #[test]
    fn offset_walks_past_the_first_page() {
        let (_t, db) = fixture();
        let all = uids(&db, SearchRequest { account_id: "luke".into(), ..Default::default() });
        let second = uids(&db, SearchRequest { account_id: "luke".into(), limit: Some(2), offset: 2, ..Default::default() });
        assert_eq!(second, all[2..].to_vec());
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
