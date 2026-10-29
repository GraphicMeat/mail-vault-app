//! Pure decisions for the native download-ahead pipeline (Wave 4, S5).
//!
//! Which loaded rows a focused view may queue, which of them the account still
//! needs, how background header work is chunked and which folder is an account's
//! Sent folder. No I/O. The JS owners (`EmailPipelineManager`, `AccountPipeline`,
//! `usePipelineCoordinator`, `findSentMailboxPath`) stay in production until S7;
//! `tests/fixtures/pipeline-cases.json` holds what they answer, and the parity
//! tests below read it. Deliberate corrections of the JS are separate, named
//! tests, never edits of the corpus.

use crate::cleanup_rules::{js_date_ms, truthy};
use crate::fetch_mode::KeepBodies;
use serde_json::Value;
use std::collections::HashSet;

/// Slots of the focused account's content pass.
pub const ACTIVE_WORKERS: usize = 3;
/// Slots of each background account's header pass.
pub const BACKGROUND_HEADER_WORKERS: usize = 1;
/// Background accounts whose headers load together.
pub const BACKGROUND_HEADER_CHUNK: usize = 3;
/// Slots of each background account's content pass, walked one account at a time.
pub const BACKGROUND_CONTENT_WORKERS: usize = 1;
/// The wait after a list paints before the focused pass starts.
pub const ACTIVATION_DELAY_MS: u64 = 200;

/// A row of the list on screen, as a hint. The cache and the vault stay the
/// authority for what exists and what is kept.
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub account_id: String,
    pub mailbox: String,
    pub uid: u32,
    pub date: Option<Value>,
    pub internal_date: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Folder,
    Unified,
    Subtree,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Focus {
    pub account_id: String,
    /// The folder shown. `UNIFIED` only for the unified scope.
    pub mailbox: String,
    pub scope: Scope,
    pub rows: Vec<Observation>,
}

/// One account, one real folder and the rows of the view that belong to it.
#[derive(Clone, Debug, PartialEq)]
pub struct Scoped {
    pub account_id: String,
    pub mailbox: String,
    pub rows: Vec<Observation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FocusError {
    Invalid,
}

pub const UNIFIED: &str = "UNIFIED";

fn name_ok(text: &str) -> bool {
    !text.is_empty() && text.len() <= 1024 && !text.chars().any(char::is_control)
}

/// Whether `text` is a name a provider could be asked to SELECT.
pub fn real_mailbox(text: &str) -> bool {
    name_ok(text) && text != UNIFIED
}

/// The account, the real folder and the rows that one focus may queue.
pub fn scope_focus(focus: &Focus) -> Result<Scoped, FocusError> {
    if !name_ok(&focus.account_id) { return Err(FocusError::Invalid); }
    let own = |row: &&Observation| row.account_id == focus.account_id;
    match focus.scope {
        // A uid names a message only inside one (account, folder): rows of any other
        // account or folder are not this view's, whatever the list on screen holds.
        Scope::Folder | Scope::Subtree => {
            if !real_mailbox(&focus.mailbox) { return Err(FocusError::Invalid); }
            let rows = focus.rows.iter().filter(own).filter(|row| row.mailbox == focus.mailbox).cloned().collect();
            Ok(Scoped { account_id: focus.account_id.clone(), mailbox: focus.mailbox.clone(), rows })
        }
        // The unified list stamps each row with the folder resolved for its account; the
        // account's first stamped row names the one folder the pass reads, INBOX when none.
        Scope::Unified => {
            if focus.mailbox != UNIFIED { return Err(FocusError::Invalid); }
            let stamped: Vec<&Observation> = focus.rows.iter().filter(own)
                .filter(|row| real_mailbox(&row.mailbox)).collect();
            let mailbox = stamped.first().map_or("INBOX", |row| row.mailbox.as_str()).to_owned();
            let rows = stamped.into_iter().filter(|row| row.mailbox == mailbox).cloned().collect();
            Ok(Scoped { account_id: focus.account_id.clone(), mailbox, rows })
        }
    }
}

/// `date || internalDate`, read the way `new Date(x).getTime()` reads it. An
/// unusable date is `None`: unknown, which every keeping mode keeps.
pub fn row_date_ms(row: &Observation) -> Option<i64> {
    let chosen = if truthy(row.date.as_ref()) { row.date.as_ref() } else { row.internal_date.as_ref() };
    js_date_ms(chosen)
}

/// `fetchesAhead`: `None` keep (hidden account, daemon unable to answer) fetches nothing.
pub fn fetches_ahead(keep: Option<KeepBodies>, date_ms: Option<i64>) -> bool {
    keep.is_some_and(|keep| keep.keeps(date_ms))
}

/// The uids whose body the account already keeps: the vault's, plus under Index
/// Only those the search index holds. An index that is unknown (`None`) or empty
/// leaves the vault's alone.
pub fn kept_uids(index_only: bool, saved: &HashSet<u32>, indexed: Option<&HashSet<u32>>) -> HashSet<u32> {
    match indexed {
        Some(indexed) if index_only && !indexed.is_empty() => saved.union(indexed).copied().collect(),
        _ => saved.clone(),
    }
}

/// The rows to fetch ahead, in list order: not kept, and wanted by the mode.
pub fn uncached_uids(rows: &[Observation], kept: &HashSet<u32>, keep: Option<KeepBodies>) -> Vec<u32> {
    rows.iter()
        .filter(|row| !kept.contains(&row.uid) && fetches_ahead(keep, row_date_ms(row)))
        .map(|row| row.uid)
        .collect()
}

/// Background accounts in header-loading chunks, order kept.
pub fn header_chunks(accounts: &[String], size: usize) -> Vec<Vec<String>> {
    accounts.chunks(size.max(1)).map(<[String]>::to_vec).collect()
}

/// The account's own Sent folder from its cached folder list (`path`, `name`,
/// `specialUse`, `children`): an override that still exists, else the first
/// folder flagged `\Sent`, else the first folder with a Sent-like name.
pub fn find_sent_mailbox_path(mailboxes: &[Value], override_path: Option<&str>) -> Option<String> {
    if mailboxes.is_empty() { return None; }
    if let Some(path) = override_path.filter(|path| !path.is_empty()) {
        if path_exists(mailboxes, path) { return Some(path.to_owned()); }
    }
    by_special_use(mailboxes).or_else(|| by_name(mailboxes))
}

fn text<'a>(folder: &'a Value, key: &str) -> Option<&'a str> {
    folder.get(key).and_then(Value::as_str)
}

fn children(folder: &Value) -> &[Value] {
    folder.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn path_exists(mailboxes: &[Value], path: &str) -> bool {
    mailboxes.iter().any(|folder| text(folder, "path") == Some(path) || path_exists(children(folder), path))
}

fn by_special_use(mailboxes: &[Value]) -> Option<String> {
    for folder in mailboxes {
        if text(folder, "specialUse") == Some("\\Sent") {
            if let Some(path) = text(folder, "path") { return Some(path.to_owned()); }
        }
        if let Some(found) = by_special_use(children(folder)) { return Some(found); }
    }
    None
}

fn by_name(mailboxes: &[Value]) -> Option<String> {
    for folder in mailboxes {
        if sent_name().is_match(text(folder, "name").unwrap_or("").trim()) {
            if let Some(path) = text(folder, "path") { return Some(path.to_owned()); }
        }
        if let Some(found) = by_name(children(folder)) { return Some(found); }
    }
    None
}

/// The leaf names of a Sent folder in the languages the app ships, as the JS lists them.
fn sent_name() -> &'static regex::Regex {
    static NAME: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    NAME.get_or_init(|| regex::Regex::new(concat!(
        "(?i)^(sent|sent items|sent mail|sent messages|outbox|gesendet|gesendete elemente|gesendete objekte|",
        "envoy[e\u{e9}]s|messages envoy[e\u{e9}]s|enviados|elementos enviados|correo enviado|inviati|posta inviata|",
        "verzonden|verzonden items|skickat|skickade objekt|sendt|sendte elementer|l[\u{e4}a]hetetyt|wyslane|",
        "wys[l\u{142}]ane|\u{43e}\u{442}\u{43f}\u{440}\u{430}\u{432}\u{43b}\u{435}\u{43d}\u{43d}\u{44b}\u{435}|",
        "\u{5df2}\u{53d1}\u{9001}|\u{5df2}\u{5bc4}\u{51fa}|\u{9001}\u{4fe1}\u{6e08}\u{307f}|",
        "\u{bcf4}\u{b0b8} \u{d3b8}\u{c9c0}\u{d568})$")).expect("sent folder names"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn corpus() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/pipeline-cases.json")).unwrap()
    }

    fn keep_of(policy: &Value) -> Option<KeepBodies> {
        // The JS policy is the daemon's `keep` answer; null or "unavailable" is no policy.
        let object = policy.as_object()?;
        match object.get("keep")?.as_str()? {
            "none" => Some(KeepBodies::None),
            "all" => Some(KeepBodies::All),
            "since" => Some(KeepBodies::Since(object.get("keepSinceMs")?.as_i64()?)),
            _ => None,
        }
    }

    fn set(value: &Value) -> HashSet<u32> {
        value.as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect()
    }

    fn sorted(set: &HashSet<u32>) -> Vec<u32> {
        let mut out: Vec<u32> = set.iter().copied().collect();
        out.sort_unstable();
        out
    }

    fn obs(account: &str, mailbox: &str, uid: u32) -> Observation {
        Observation { account_id: account.into(), mailbox: mailbox.into(), uid, date: Some(json!("2026-08-10T12:00:00Z")),
            internal_date: None }
    }

    fn row_of(value: &Value, account: &str, mailbox: &str) -> Observation {
        let text = |key: &str| match value.get(key) { Some(Value::Null) | None => None, Some(v) => Some(v.clone()) };
        Observation {
            account_id: value["accountId"].as_str().unwrap_or(account).to_owned(),
            mailbox: value["mailbox"].as_str().unwrap_or(mailbox).to_owned(),
            uid: value["uid"].as_u64().unwrap() as u32,
            date: text("date"),
            internal_date: text("internalDate"),
        }
    }

    // ── Parity with the real JS corpus ──

    #[test]
    fn candidates_match_the_js_manager() {
        let corpus = corpus();
        let cases = corpus["candidates"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let input = &case["input"];
            let policy = &input["policy"];
            let keep = keep_of(policy);
            let index_only = policy["mode"] == "indexOnly";
            let saved = set(&input["saved"]);
            let indexed = input["indexed"].as_array().map(|_| set(&input["indexed"]));
            let kept = kept_uids(index_only, &saved, indexed.as_ref());
            let rows: Vec<Observation> = input["rows"].as_array().unwrap().iter()
                .map(|row| row_of(row, "acc", "INBOX")).collect();
            let uids = uncached_uids(&rows, &kept, keep);
            let name = case["name"].as_str().unwrap();
            assert_eq!(sorted(&kept), sorted(&set(&case["output"]["kept"])), "kept: {name}");
            let expected: Vec<u32> = case["output"]["uids"].as_array().unwrap().iter()
                .map(|v| v.as_u64().unwrap() as u32).collect();
            assert_eq!(uids, expected, "uids: {name}");
        }
    }

    #[test]
    fn fetches_ahead_matches_the_js_per_date() {
        for case in corpus()["fetchesAhead"].as_array().unwrap() {
            let date = match &case["dateMs"] { Value::String(_) => None, v => v.as_i64() };
            let got = fetches_ahead(keep_of(&case["policy"]), date);
            assert_eq!(got, case["output"].as_bool().unwrap(), "{case}");
        }
    }

    #[test]
    fn scope_and_candidates_match_the_js_active_pipeline() {
        let corpus = corpus();
        let mut checked = 0;
        for case in corpus["scope"].as_array().unwrap() {
            let input = &case["input"];
            // Hidden, credential-less and unknown accounts never reach the scoping block in
            // the daemon either; their start-nothing answer is a daemon test.
            let started = case["output"]["started"].as_array().unwrap();
            if started.is_empty() { continue; }
            let account = input["accountId"].as_str().unwrap();
            let active = input["activeMailbox"].as_str().unwrap();
            let scope = if active == UNIFIED { Scope::Unified } else if input["mailboxScope"].is_object() { Scope::Subtree } else { Scope::Folder };
            let rows: Vec<Observation> = input["rows"].as_array().unwrap().iter().map(|row| {
                let mailbox = row["mailbox"].as_str().unwrap_or(if scope == Scope::Unified { "" } else { active });
                let mut r = row_of(row, account, mailbox);
                if scope != Scope::Unified { r.account_id = account.to_owned(); }
                r
            }).filter(|r| scope != Scope::Unified || !r.mailbox.is_empty()).collect();
            let focus = Focus { account_id: account.to_owned(), mailbox: active.to_owned(), scope, rows };
            let scoped = scope_focus(&focus).unwrap_or_else(|e| panic!("{}: {e:?}", case["name"]));
            let keep = keep_of(&input["policy"]);
            let prefix = format!("{}:{}:", account, scoped.mailbox);
            let saved: HashSet<u32> = input["saved"].as_array().unwrap().iter().filter_map(|k| k.as_str())
                .filter_map(|k| k.strip_prefix(prefix.as_str())).filter_map(|n| n.parse().ok()).collect();
            let indexed = input["indexed"].as_array().map(|_| set(&input["indexed"]));
            let index_only = input["policy"]["mode"] == "indexOnly";
            let kept = kept_uids(index_only, &saved, indexed.as_ref());
            let uids = uncached_uids(&scoped.rows, &kept, keep);
            let expected = &started[0];
            assert_eq!(scoped.mailbox, expected["mailbox"].as_str().unwrap(), "{}", case["name"]);
            let want: Vec<u32> = expected["uids"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
            assert_eq!(uids, want, "{}", case["name"]);
            checked += 1;
        }
        assert!(checked >= 12, "only {checked} scope cases ran");
    }

    #[test]
    fn sent_lookup_matches_the_js() {
        for case in corpus()["sent"].as_array().unwrap() {
            let list = case["input"]["mailboxes"].as_array().cloned().unwrap_or_default();
            let override_path = case["input"]["override"].as_str();
            let got = find_sent_mailbox_path(&list, override_path);
            assert_eq!(got.as_deref(), case["output"].as_str(), "{}", case["name"]);
        }
    }

    #[test]
    fn header_chunks_match_the_js_background_walk() {
        let corpus = corpus();
        assert_eq!(corpus["constants"]["backgroundHeaderChunk"], json!(BACKGROUND_HEADER_CHUNK));
        assert_eq!(corpus["constants"]["activeWorkers"], json!(ACTIVE_WORKERS));
        assert_eq!(corpus["constants"]["backgroundHeaderWorkers"], json!(BACKGROUND_HEADER_WORKERS));
        assert_eq!(corpus["constants"]["backgroundContentWorkers"], json!(BACKGROUND_CONTENT_WORKERS));
        assert_eq!(corpus["constants"]["activationDelayMs"], json!(ACTIVATION_DELAY_MS));
        // Background accounts of the trace: everyone but the active, hidden and credential-less ones.
        let accounts: Vec<String> = ["a1", "a2", "a3", "a4", "a5"].iter().map(|s| s.to_string()).collect();
        let chunks = header_chunks(&accounts, BACKGROUND_HEADER_CHUNK);
        assert_eq!(chunks, vec![vec!["a1", "a2", "a3"], vec!["a4", "a5"]]);
        // The JS trace starts the second chunk only after the whole first one finished.
        let steps = corpus["headerChunks"]["steps"].as_array().unwrap();
        assert_eq!(steps[0]["started"], json!(["a1:INBOX", "a2:INBOX", "a3:INBOX"]));
        assert_eq!(steps[1]["started"].as_array().unwrap().iter().filter(|s| s.as_str().unwrap().starts_with("a4")).count(), 0);
        assert!(header_chunks(&[], 3).is_empty());
        assert_eq!(header_chunks(&accounts, 0).len(), 5, "a zero chunk size still makes progress one by one");
    }

    // ── Named deliberate corrections of the JS ──

    #[test]
    fn correction_unified_rows_are_filtered_to_the_resolved_folder() {
        // The JS filtered a unified list by account only, so a stray row of another folder of
        // the same account was queued against the resolved folder.
        let focus = Focus { account_id: "a".into(), mailbox: UNIFIED.into(), scope: Scope::Unified, rows: vec![
            obs("a", "INBOX", 7), obs("a", "Archive", 7), obs("b", "INBOX", 7)] };
        let scoped = scope_focus(&focus).unwrap();
        assert_eq!(scoped.mailbox, "INBOX");
        assert_eq!(scoped.rows.iter().map(|r| (r.account_id.as_str(), r.mailbox.as_str(), r.uid)).collect::<Vec<_>>(),
            vec![("a", "INBOX", 7)]);
    }

    #[test]
    fn correction_a_folder_focus_ignores_foreign_account_and_other_folder_rows() {
        let focus = Focus { account_id: "a".into(), mailbox: "INBOX".into(), scope: Scope::Folder, rows: vec![
            obs("a", "INBOX", 1), obs("b", "INBOX", 1), obs("a", "Sent", 7)] };
        let scoped = scope_focus(&focus).unwrap();
        assert_eq!(scoped.rows.len(), 1);
        assert_eq!((scoped.rows[0].account_id.as_str(), scoped.rows[0].mailbox.as_str(), scoped.rows[0].uid), ("a", "INBOX", 1));
    }

    #[test]
    fn correction_sent_rows_never_become_inbox_work() {
        // JS: the Sent load overwrote the rows the INBOX content pass used (see the
        // `legacySentRowsFeedInboxContent` trace). Native rows carry their own folder.
        let focus = Focus { account_id: "a".into(), mailbox: "INBOX".into(), scope: Scope::Folder, rows: vec![
            obs("a", "INBOX", 1), obs("a", "Sent", 7), obs("a", "Sent", 8)] };
        let scoped = scope_focus(&focus).unwrap();
        let uids = uncached_uids(&scoped.rows, &HashSet::new(), Some(KeepBodies::All));
        assert_eq!(uids, vec![1]);
    }

    // ── Focus validation ──

    #[test]
    fn a_literal_unified_mailbox_is_never_provider_work() {
        for scope in [Scope::Folder, Scope::Subtree] {
            let focus = Focus { account_id: "a".into(), mailbox: UNIFIED.into(), scope, rows: vec![] };
            assert_eq!(scope_focus(&focus), Err(FocusError::Invalid), "{scope:?}");
        }
        let unified = Focus { account_id: "a".into(), mailbox: "INBOX".into(), scope: Scope::Unified, rows: vec![] };
        assert_eq!(scope_focus(&unified), Err(FocusError::Invalid), "unified names UNIFIED itself");
        let rows_named_unified = Focus { account_id: "a".into(), mailbox: UNIFIED.into(), scope: Scope::Unified,
            rows: vec![obs("a", UNIFIED, 3)] };
        let scoped = scope_focus(&rows_named_unified).unwrap();
        assert_eq!(scoped.mailbox, "INBOX", "a row cannot name the literal as its folder");
        assert!(scoped.rows.is_empty());
    }

    #[test]
    fn names_and_accounts_must_be_well_formed() {
        for (account, mailbox) in [("", "INBOX"), ("a", ""), ("a", "IN\nBOX"), ("a\u{0}", "INBOX")] {
            let focus = Focus { account_id: account.into(), mailbox: mailbox.into(), scope: Scope::Folder, rows: vec![] };
            assert_eq!(scope_focus(&focus), Err(FocusError::Invalid), "{account:?} {mailbox:?}");
        }
    }

    #[test]
    fn a_subtree_focus_queues_the_roots_own_rows_only() {
        let focus = Focus { account_id: "a".into(), mailbox: "Projects".into(), scope: Scope::Subtree, rows: vec![
            obs("a", "Projects", 2), obs("a", "Projects/Child", 3)] };
        let scoped = scope_focus(&focus).unwrap();
        assert_eq!(scoped.mailbox, "Projects");
        assert_eq!(scoped.rows.iter().map(|r| r.uid).collect::<Vec<_>>(), vec![2]);
    }
}
