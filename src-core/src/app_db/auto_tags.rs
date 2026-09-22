//! Auto Tags: a natural-language rule that assigns an existing tag.
//!
//! `constraints` is a deterministic prefilter — no model involved — checked
//! in Rust before any candidate is ever handed to a model: cost control and
//! the correctness story in one. The instruction itself is evaluated by the
//! daemon (`src-daemon/src/handlers/auto_tags.rs`, which owns `llm::generate`)
//! against the strict verdict format `parse_verdict` below understands.
//!
//! This module never touches a mailbox, the vault or a server: `inbox_action`
//! is a stored fact the app's views layer reads to hide a row locally.
//! Nothing here imports `vault_files` or an IMAP session, and nothing ever
//! should — nothing about "auto tag" is allowed to move or delete mail.

use super::db::in_txn;
use super::tags::Target;
use rusqlite::{params, Connection, OptionalExtension};

// ── Rule storage ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxAction {
    Keep,
    Hide,
}

impl InboxAction {
    fn as_str(self) -> &'static str {
        match self {
            InboxAction::Keep => "keep",
            InboxAction::Hide => "hide",
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "keep" => Ok(InboxAction::Keep),
            "hide" => Ok(InboxAction::Hide),
            other => Err(format!("unknown inboxAction: {other}")),
        }
    }
}

/// The deterministic prefilter. Every field is an AND condition: absent means
/// "don't care". Only a `Candidate` that passes every set field ever reaches
/// a model.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Constraints {
    pub from_domain: Option<String>,
    pub from_address: Option<String>,
    pub subject_contains: Option<String>,
    pub mailbox: Option<String>,
    pub has_attachments: Option<bool>,
    /// The message must be at least this many days old.
    pub older_than_days: Option<i64>,
    /// The message must be at most this many days old.
    pub newer_than_days: Option<i64>,
    pub list_id_present: Option<bool>,
}

/// A candidate message, as much of it as the header cache carries. Kept
/// separate from `src-daemon`'s `EmailForClassification` because `src-core`
/// cannot depend on `src-daemon`.
#[derive(Debug, Clone, Default)]
pub struct Candidate {
    pub from: String,
    pub subject: String,
    pub mailbox: String,
    pub has_attachments: bool,
    pub list_id: Option<String>,
    /// Unix seconds; 0 when the header carried no parseable date, which never
    /// satisfies an age constraint (an unknown age is not "old enough").
    pub date: i64,
}

/// Whether `candidate` satisfies every constraint `c` sets. Pure and total —
/// no I/O, no model.
pub fn passes(c: &Constraints, candidate: &Candidate, now: i64) -> bool {
    if let Some(domain) = &c.from_domain {
        let actual = candidate.from.split('@').nth(1).unwrap_or("").split('>').next().unwrap_or("");
        if !actual.eq_ignore_ascii_case(domain) {
            return false;
        }
    }
    if let Some(addr) = &c.from_address {
        let actual = if let Some(start) = candidate.from.find('<') {
            candidate.from[start + 1..].trim_end_matches('>').trim()
        } else {
            candidate.from.trim()
        };
        if !actual.eq_ignore_ascii_case(addr) {
            return false;
        }
    }
    if let Some(sub) = &c.subject_contains {
        if !candidate.subject.to_lowercase().contains(&sub.to_lowercase()) {
            return false;
        }
    }
    if let Some(mailbox) = &c.mailbox {
        if !candidate.mailbox.eq_ignore_ascii_case(mailbox) {
            return false;
        }
    }
    if let Some(want) = c.has_attachments {
        if candidate.has_attachments != want {
            return false;
        }
    }
    if let Some(days) = c.older_than_days {
        if candidate.date == 0 || now - candidate.date < days * 86_400 {
            return false;
        }
    }
    if let Some(days) = c.newer_than_days {
        if candidate.date == 0 || now - candidate.date > days * 86_400 {
            return false;
        }
    }
    if let Some(want) = c.list_id_present {
        if candidate.list_id.is_some() != want {
            return false;
        }
    }
    true
}

/// What a rule needs to be created or edited. Separate from `Rule` because
/// `id`/`createdAt`/`updatedAt` are the store's to assign, not the caller's.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDraft {
    pub name: String,
    pub instruction: String,
    #[serde(default)]
    pub constraints: Constraints,
    pub tag_id: String,
    pub inbox_action: InboxAction,
    pub min_confidence: f64,
    /// Privacy opt-in: a rule without this can never be evaluated through a
    /// remote (`Endpoint`) provider — see `src-daemon/src/handlers/auto_tags.rs`.
    #[serde(default)]
    pub allow_remote: bool,
    /// The JSON-encoded `llm::Provider` the STANDING worker evaluates this
    /// rule through (a daemon-only type this store never parses). Null/absent
    /// means on-device — the privacy default. `.preview`/`.backfill` take
    /// their own `provider` param instead and never read this field, since a
    /// caller there is present to hand one over each time.
    #[serde(default)]
    pub provider: serde_json::Value,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub instruction: String,
    pub constraints: Constraints,
    pub tag_id: String,
    pub inbox_action: InboxAction,
    pub min_confidence: f64,
    pub allow_remote: bool,
    #[serde(default)]
    pub provider: serde_json::Value,
    pub enabled: bool,
    /// When this rule most recently turned on; `None` while disabled (or
    /// never yet enabled). The worker only considers mail at or after this —
    /// see the `SCHEMA_V4` doc comment in `db.rs` for why.
    #[serde(default)]
    pub enabled_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn list(conn: &Connection) -> Result<Vec<Rule>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, instruction, constraints, tag_id, inbox_action, min_confidence,
                    allow_remote, provider, enabled, enabled_at, created_at, updated_at
             FROM auto_tag_rules ORDER BY created_at, name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_rule).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?.into_iter().collect()
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Rule>, String> {
    let row: Option<Result<Rule, String>> = conn
        .query_row(
            "SELECT id, name, instruction, constraints, tag_id, inbox_action, min_confidence,
                    allow_remote, provider, enabled, enabled_at, created_at, updated_at
             FROM auto_tag_rules WHERE id = ?1",
            [id],
            row_to_rule,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.transpose()
}

pub fn create(conn: &Connection, draft: RuleDraft) -> Result<Rule, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let at = now();
    let enabled_at = draft.enabled.then_some(at);
    save(conn, &id, &draft, at, at, enabled_at)
}

pub fn update(conn: &Connection, id: &str, draft: RuleDraft) -> Result<Rule, String> {
    let existing = get(conn, id)?.ok_or_else(|| format!("no such auto-tag rule: {id}"))?;
    // The worker's go-forward window resets on every OFF→ON transition (an
    // edit made while already enabled keeps its window; turning it off drops
    // it, so re-enabling later starts fresh rather than silently catching up
    // on whatever arrived while it was off).
    let enabled_at = match (existing.enabled, draft.enabled) {
        (false, true) => Some(now()),
        (true, true) => existing.enabled_at,
        (_, false) => None,
    };
    save(conn, id, &draft, existing.created_at, now(), enabled_at)
}

fn save(
    conn: &Connection,
    id: &str,
    draft: &RuleDraft,
    created_at: i64,
    updated_at: i64,
    enabled_at: Option<i64>,
) -> Result<Rule, String> {
    let name = draft.name.trim();
    if name.is_empty() {
        return Err("an auto-tag rule needs a name".into());
    }
    if draft.instruction.trim().is_empty() {
        return Err("an auto-tag rule needs an instruction".into());
    }
    if draft.tag_id.trim().is_empty() {
        return Err("an auto-tag rule needs a tag".into());
    }
    let constraints_json = serde_json::to_string(&draft.constraints).map_err(|e| e.to_string())?;
    let provider_json = serde_json::to_string(&draft.provider).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO auto_tag_rules
           (id, name, instruction, constraints, tag_id, inbox_action, min_confidence, allow_remote, provider, enabled, enabled_at, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            id,
            name,
            draft.instruction.trim(),
            constraints_json,
            draft.tag_id,
            draft.inbox_action.as_str(),
            draft.min_confidence,
            draft.allow_remote,
            provider_json,
            draft.enabled,
            enabled_at,
            created_at,
            updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    get(conn, id)?.ok_or_else(|| "rule vanished immediately after being saved".to_string())
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM auto_tag_rules WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string())
}

fn row_to_rule(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Rule, String>> {
    // Every fallible-in-SQLite field is read up front with `?` (rusqlite's own
    // error type, matching this function's own `Result`); only the fields
    // that can fail for a *content* reason (bad JSON, an unknown action word)
    // go through the inner `String`-error closure below.
    let id: String = r.get(0)?;
    let name: String = r.get(1)?;
    let instruction: String = r.get(2)?;
    let constraints_json: String = r.get(3)?;
    let tag_id: String = r.get(4)?;
    let inbox_action_str: String = r.get(5)?;
    let min_confidence: f64 = r.get(6)?;
    let allow_remote: bool = r.get(7)?;
    let provider_json: String = r.get(8)?;
    let enabled: bool = r.get(9)?;
    let enabled_at: Option<i64> = r.get(10)?;
    let created_at: i64 = r.get(11)?;
    let updated_at: i64 = r.get(12)?;
    Ok((|| -> Result<Rule, String> {
        Ok(Rule {
            id,
            name,
            instruction,
            constraints: serde_json::from_str(&constraints_json).map_err(|e| e.to_string())?,
            tag_id,
            inbox_action: InboxAction::parse(&inbox_action_str)?,
            min_confidence,
            allow_remote,
            provider: serde_json::from_str(&provider_json).unwrap_or(serde_json::Value::Null),
            enabled,
            enabled_at,
            created_at,
            updated_at,
        })
    })())
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ── Backfill batches (reversibility) ────────────────────────────────────

/// Record what one backfill batch assigned, so it can be undone later. The
/// tag is frozen here, at write time — undo removes exactly this tag, never
/// whatever the rule's `tag_id` happens to be when undo runs.
/// `INSERT OR IGNORE`: a target already recorded for this batch (should never
/// happen — the caller passes each target once) is not an error.
pub fn record_backfill(conn: &Connection, batch_id: &str, rule_id: &str, tag_id: &str, targets: &[Target]) -> Result<(), String> {
    in_txn(conn, || {
        let at = now();
        let mut stmt = conn
            .prepare_cached(
                "INSERT OR IGNORE INTO auto_tag_backfills(batch_id, rule_id, tag_id, account_id, msg_key, at) VALUES (?1,?2,?3,?4,?5,?6)",
            )
            .map_err(|e| e.to_string())?;
        for t in targets {
            stmt.execute(params![batch_id, rule_id, tag_id, t.account_id, t.msg_key, at]).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// The rule id, the tag id it assigned, and every target one backfill batch
/// assigned. The tag id is the one frozen in the batch at `record_backfill`
/// time — never looked up from the rule's current `tag_id`, so an edit to
/// the rule between a backfill and its undo can never make undo remove the
/// wrong tag.
pub fn backfill_batch(conn: &Connection, batch_id: &str) -> Result<Option<(String, String, Vec<Target>)>, String> {
    let mut stmt = conn
        .prepare("SELECT rule_id, tag_id, account_id, msg_key FROM auto_tag_backfills WHERE batch_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([batch_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let Some((rule_id, tag_id, _, _)) = rows.first().cloned() else { return Ok(None) };
    let targets = rows.into_iter().map(|(_, _, account_id, msg_key)| Target { account_id, msg_key }).collect();
    Ok(Some((rule_id, tag_id, targets)))
}

pub fn delete_backfill_batch(conn: &Connection, batch_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM auto_tag_backfills WHERE batch_id = ?1", [batch_id]).map(|_| ()).map_err(|e| e.to_string())
}

// ── Worker decisions (dedupe) ────────────────────────────────────────────

/// Record that `rule_id` has an outcome for `target` — `matched` either way.
/// This is the worker's whole dedupe: the idea behind `classification_queue`'s
/// own "never re-ask about a message with a result on record" (see the
/// `SCHEMA_V4` doc comment in `db.rs`), scoped per rule. `INSERT OR REPLACE`:
/// a later decision for the same rule+message (the rule's constraints or
/// instruction changed) simply overwrites the earlier one.
pub fn record_decision(conn: &Connection, rule_id: &str, target: &Target, matched: bool) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO auto_tag_decisions(rule_id, account_id, msg_key, matched, at) VALUES (?1,?2,?3,?4,?5)",
        params![rule_id, target.account_id, target.msg_key, matched, now()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// `targets` minus whichever of them already have a recorded decision for
/// `rule_id`.
///
/// ponytail: one point query per target rather than a single `IN (...)`
/// (`tags::for_messages`'s chunking pattern) — plenty fast at the trickle of
/// new mail this runs against; batch it the way `for_messages` does if a
/// real backlog ever makes this show up in profiling.
pub fn undecided(conn: &Connection, rule_id: &str, targets: &[Target]) -> Result<Vec<Target>, String> {
    let mut out = Vec::new();
    for t in targets {
        let seen: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM auto_tag_decisions WHERE rule_id = ?1 AND account_id = ?2 AND msg_key = ?3",
                params![rule_id, t.account_id, t.msg_key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if seen.is_none() {
            out.push(t.clone());
        }
    }
    Ok(out)
}

// ── Model verdicts ───────────────────────────────────────────────────────

/// A model's answer for one candidate against one rule's instruction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict {
    /// The model says this candidate matches, with this confidence (0..=1).
    Match(f64),
    /// The model says this candidate does not match. Distinct from a parse
    /// failure: a rule producing all "no"s is working, not refusing.
    NoMatch,
}

/// The system prompt every verdict call uses: a strict, two-line format so an
/// answer that doesn't parse is a refusal, never a guessed match.
pub const VERDICT_SYSTEM_PROMPT: &str = "You decide whether ONE email matches a rule someone wrote in plain English. \
Answer with EXACTLY these two lines and nothing else, no explanation:\nMATCH: yes or no\nCONFIDENCE: a number from 0 to 1";

/// The user-turn prompt for one candidate.
///
/// ponytail: the header cache this runs against carries no message body
/// (`EmailForClassification::body_preview` is always empty there), so an
/// instruction about body content can never be answered from what this
/// prompt shows. Ceiling: thread a real body preview through if that turns
/// out to matter for real rules.
pub fn verdict_prompt(instruction: &str, candidate: &Candidate) -> String {
    format!(
        "Rule: {instruction}\n\n\
         Email:\n\
         From: {}\n\
         Subject: {}\n\
         Mailbox: {}\n\
         Has attachments: {}\n\n\
         Does this email match the rule?",
        candidate.from, candidate.subject, candidate.mailbox, candidate.has_attachments
    )
}

/// Parse a model's reply into a `Verdict`. `Err` is a refusal: the caller
/// must never fall back to guessing a match from text it could not read.
pub fn parse_verdict(text: &str) -> Result<Verdict, String> {
    let mut is_match: Option<bool> = None;
    let mut confidence: Option<f64> = None;
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once(':') else { continue };
        let value = value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "match" => {
                is_match = match value.to_ascii_lowercase().as_str() {
                    "yes" | "true" => Some(true),
                    "no" | "false" => Some(false),
                    _ => None,
                };
            }
            "confidence" => confidence = value.parse::<f64>().ok(),
            _ => {}
        }
    }
    match (is_match, confidence) {
        (Some(false), _) => Ok(Verdict::NoMatch),
        (Some(true), Some(c)) if (0.0..=1.0).contains(&c) => Ok(Verdict::Match(c)),
        _ => Err(format!("unparseable auto-tag verdict, refusing rather than guessing a match: {text:?}")),
    }
}

/// Whether `verdict` clears `min_confidence`. A `NoMatch` never clears any
/// threshold, whatever it is set to.
pub fn meets_threshold(verdict: Verdict, min_confidence: f64) -> bool {
    matches!(verdict, Verdict::Match(c) if c >= min_confidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-autotags-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn draft(name: &str) -> RuleDraft {
        RuleDraft {
            name: name.into(),
            instruction: "receipts and invoices".into(),
            constraints: Constraints::default(),
            tag_id: "tag-1".into(),
            inbox_action: InboxAction::Keep,
            min_confidence: 0.7,
            allow_remote: false,
            provider: serde_json::Value::Null,
            enabled: false,
        }
    }

    fn candidate() -> Candidate {
        Candidate {
            from: "Billing <billing@shop.example>".into(),
            subject: "Your receipt".into(),
            mailbox: "INBOX".into(),
            has_attachments: true,
            list_id: Some("<digest.shop.example>".into()),
            date: 1_000_000,
        }
    }

    // ── CRUD ─────────────────────────────────────────────────────────

    #[test]
    fn a_created_rule_reads_back_whole() {
        let c = conn();
        let rule = create(&c, draft("Receipts")).unwrap();
        assert_eq!(rule.name, "Receipts");
        assert_eq!(rule.inbox_action, InboxAction::Keep);
        assert!(!rule.allow_remote);
        assert!(!rule.enabled);
        assert_eq!(rule.provider, serde_json::Value::Null, "on-device by default");
        assert_eq!(rule.enabled_at, None, "never enabled yet");
        assert_eq!(get(&c, &rule.id).unwrap(), Some(rule));
    }

    #[test]
    fn a_rule_created_already_enabled_gets_an_enabled_at_immediately() {
        let c = conn();
        let rule = create(&c, RuleDraft { enabled: true, ..draft("Receipts") }).unwrap();
        assert!(rule.enabled_at.is_some());
    }

    #[test]
    fn a_rules_provider_survives_a_reopen() {
        let dir = std::env::temp_dir().join(format!("mv-autotags-{}", uuid::Uuid::new_v4()));
        let id = {
            let c = db::open(&dir).unwrap();
            let provider = serde_json::json!({"type": "endpoint", "url": "http://localhost:11434", "model": "m"});
            create(&c, RuleDraft { provider, ..draft("Receipts") }).unwrap().id
        };
        let c = db::open(&dir).unwrap();
        let rule = get(&c, &id).unwrap().unwrap();
        assert_eq!(rule.provider["type"], "endpoint");
        assert_eq!(rule.provider["url"], "http://localhost:11434");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rule_needs_a_name_an_instruction_and_a_tag() {
        let c = conn();
        assert!(create(&c, RuleDraft { name: "  ".into(), ..draft("x") }).is_err());
        assert!(create(&c, RuleDraft { instruction: "  ".into(), ..draft("x") }).is_err());
        assert!(create(&c, RuleDraft { tag_id: "".into(), ..draft("x") }).is_err());
    }

    #[test]
    fn updating_a_rule_keeps_its_id_and_created_at_but_bumps_updated_at() {
        let c = conn();
        let created = create(&c, draft("Receipts")).unwrap();
        let edited = update(&c, &created.id, RuleDraft { enabled: true, ..draft("Receipts, edited") }).unwrap();
        assert_eq!(edited.id, created.id);
        assert_eq!(edited.created_at, created.created_at);
        assert_eq!(edited.name, "Receipts, edited");
        assert!(edited.enabled);
    }

    /// The worker's go-forward window: turning a rule on sets `enabled_at`,
    /// editing it while it stays on leaves that window alone, and turning it
    /// off clears it so a later re-enable does not silently catch up on
    /// everything that arrived while it was off.
    #[test]
    fn enabled_at_tracks_only_the_off_to_on_transition() {
        let c = conn();
        let created = create(&c, draft("Receipts")).unwrap();
        assert_eq!(created.enabled_at, None);

        let turned_on = update(&c, &created.id, RuleDraft { enabled: true, ..draft("Receipts") }).unwrap();
        let first_enabled_at = turned_on.enabled_at.expect("turning on sets it");

        let renamed_while_on =
            update(&c, &created.id, RuleDraft { name: "Receipts v2".into(), enabled: true, ..draft("Receipts") }).unwrap();
        assert_eq!(renamed_while_on.enabled_at, Some(first_enabled_at), "an edit while still on keeps the window");

        let turned_off = update(&c, &created.id, RuleDraft { enabled: false, ..draft("Receipts") }).unwrap();
        assert_eq!(turned_off.enabled_at, None, "turning off drops the window");

        let turned_on_again = update(&c, &created.id, RuleDraft { enabled: true, ..draft("Receipts") }).unwrap();
        assert!(
            turned_on_again.enabled_at.unwrap() >= first_enabled_at,
            "re-enabling starts a fresh window, not the old one"
        );
    }

    #[test]
    fn updating_a_rule_that_does_not_exist_is_an_error() {
        let c = conn();
        assert!(update(&c, "nope", draft("x")).is_err());
    }

    #[test]
    fn deleting_a_rule_removes_it_from_the_list() {
        let c = conn();
        let rule = create(&c, draft("Receipts")).unwrap();
        delete(&c, &rule.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn rules_list_in_creation_order() {
        let c = conn();
        let a = create(&c, draft("A")).unwrap();
        let b = create(&c, draft("B")).unwrap();
        assert_eq!(list(&c).unwrap().iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![a.id, b.id]);
    }

    #[test]
    fn a_rules_constraints_survive_a_reopen() {
        let dir = std::env::temp_dir().join(format!("mv-autotags-{}", uuid::Uuid::new_v4()));
        let id = {
            let c = db::open(&dir).unwrap();
            let constraints = Constraints { from_domain: Some("example.com".into()), has_attachments: Some(true), ..Default::default() };
            create(&c, RuleDraft { constraints, ..draft("Receipts") }).unwrap().id
        };
        let c = db::open(&dir).unwrap();
        let rule = get(&c, &id).unwrap().unwrap();
        assert_eq!(rule.constraints.from_domain.as_deref(), Some("example.com"));
        assert_eq!(rule.constraints.has_attachments, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Prefilter: one test per constraint kind ─────────────────────

    const NOW: i64 = 1_000_000_000;

    #[test]
    fn no_constraints_passes_everything() {
        assert!(passes(&Constraints::default(), &candidate(), NOW));
    }

    #[test]
    fn from_domain_matches_case_insensitively_and_rejects_others() {
        let c = Constraints { from_domain: Some("SHOP.example".into()), ..Default::default() };
        assert!(passes(&c, &candidate(), NOW));
        let miss = Constraints { from_domain: Some("other.example".into()), ..Default::default() };
        assert!(!passes(&miss, &candidate(), NOW));
    }

    #[test]
    fn from_address_matches_the_address_inside_a_display_name() {
        let c = Constraints { from_address: Some("billing@shop.example".into()), ..Default::default() };
        assert!(passes(&c, &candidate(), NOW));
        let miss = Constraints { from_address: Some("someone-else@shop.example".into()), ..Default::default() };
        assert!(!passes(&miss, &candidate(), NOW));
    }

    #[test]
    fn subject_contains_is_case_insensitive_substring() {
        let c = Constraints { subject_contains: Some("RECEIPT".into()), ..Default::default() };
        assert!(passes(&c, &candidate(), NOW));
        let miss = Constraints { subject_contains: Some("invoice".into()), ..Default::default() };
        assert!(!passes(&miss, &candidate(), NOW));
    }

    #[test]
    fn mailbox_must_match_exactly_case_insensitive() {
        let c = Constraints { mailbox: Some("inbox".into()), ..Default::default() };
        assert!(passes(&c, &candidate(), NOW));
        let miss = Constraints { mailbox: Some("Archive".into()), ..Default::default() };
        assert!(!passes(&miss, &candidate(), NOW));
    }

    #[test]
    fn has_attachments_is_an_exact_boolean_match() {
        let want_true = Constraints { has_attachments: Some(true), ..Default::default() };
        assert!(passes(&want_true, &candidate(), NOW));
        let want_false = Constraints { has_attachments: Some(false), ..Default::default() };
        assert!(!passes(&want_false, &candidate(), NOW));
    }

    #[test]
    fn older_than_days_requires_a_known_date_at_least_that_old() {
        let ten_days_old = Candidate { date: NOW - 10 * 86_400, ..candidate() };
        let c = Constraints { older_than_days: Some(5), ..Default::default() };
        assert!(passes(&c, &ten_days_old, NOW));
        let too_recent = Candidate { date: NOW - 2 * 86_400, ..candidate() };
        assert!(!passes(&c, &too_recent, NOW));
        let unknown_date = Candidate { date: 0, ..candidate() };
        assert!(!passes(&c, &unknown_date, NOW), "an unknown age is never old enough");
    }

    #[test]
    fn newer_than_days_requires_a_known_date_at_most_that_old() {
        let two_days_old = Candidate { date: NOW - 2 * 86_400, ..candidate() };
        let c = Constraints { newer_than_days: Some(5), ..Default::default() };
        assert!(passes(&c, &two_days_old, NOW));
        let too_old = Candidate { date: NOW - 10 * 86_400, ..candidate() };
        assert!(!passes(&c, &too_old, NOW));
        let unknown_date = Candidate { date: 0, ..candidate() };
        assert!(!passes(&c, &unknown_date, NOW));
    }

    #[test]
    fn list_id_present_checks_for_the_headers_presence_not_its_value() {
        let want_present = Constraints { list_id_present: Some(true), ..Default::default() };
        assert!(passes(&want_present, &candidate(), NOW));
        let no_list = Candidate { list_id: None, ..candidate() };
        assert!(!passes(&want_present, &no_list, NOW));
        let want_absent = Constraints { list_id_present: Some(false), ..Default::default() };
        assert!(passes(&want_absent, &no_list, NOW));
        assert!(!passes(&want_absent, &candidate(), NOW));
    }

    #[test]
    fn constraints_combine_as_an_and_not_an_or() {
        let c = Constraints { from_domain: Some("shop.example".into()), mailbox: Some("Archive".into()), ..Default::default() };
        assert!(!passes(&c, &candidate(), NOW), "the mailbox alone fails to match");
    }

    // ── Backfill batch reversal ──────────────────────────────────────

    #[test]
    fn a_backfill_batch_records_and_returns_its_targets() {
        let c = conn();
        let targets = vec![
            Target { account_id: "a".into(), msg_key: "one@example.com".into() },
            Target { account_id: "a".into(), msg_key: "two@example.com".into() },
        ];
        record_backfill(&c, "batch-1", "rule-1", "tag-1", &targets).unwrap();
        let (rule_id, tag_id, got) = backfill_batch(&c, "batch-1").unwrap().unwrap();
        assert_eq!(rule_id, "rule-1");
        assert_eq!(tag_id, "tag-1");
        let mut keys: Vec<_> = got.into_iter().map(|t| t.msg_key).collect();
        keys.sort();
        assert_eq!(keys, vec!["one@example.com".to_string(), "two@example.com".to_string()]);
    }

    /// The whole point of freezing `tag_id` in the batch: a rule's tag can be
    /// repointed after a backfill runs, and undo must still remove the tag it
    /// actually assigned, not whatever the rule points at now.
    #[test]
    fn a_batchs_tag_id_is_frozen_even_if_the_rules_tag_changes_later() {
        let c = conn();
        let rule = create(&c, draft("Receipts")).unwrap(); // tag_id: "tag-1"
        let t = vec![Target { account_id: "a".into(), msg_key: "one@example.com".into() }];
        record_backfill(&c, "batch-1", &rule.id, &rule.tag_id, &t).unwrap();

        update(&c, &rule.id, RuleDraft { tag_id: "tag-2".into(), ..draft("Receipts") }).unwrap();

        let (_, tag_id, _) = backfill_batch(&c, "batch-1").unwrap().unwrap();
        assert_eq!(tag_id, "tag-1", "the batch remembers what it actually assigned");
    }

    #[test]
    fn an_unknown_batch_id_has_no_targets() {
        let c = conn();
        assert_eq!(backfill_batch(&c, "nope").unwrap(), None);
    }

    #[test]
    fn deleting_a_batch_makes_it_unreadable_but_leaves_a_sibling_batch() {
        let c = conn();
        let t = vec![Target { account_id: "a".into(), msg_key: "one@example.com".into() }];
        record_backfill(&c, "batch-1", "rule-1", "tag-1", &t).unwrap();
        record_backfill(&c, "batch-2", "rule-1", "tag-1", &t).unwrap();
        delete_backfill_batch(&c, "batch-1").unwrap();
        assert_eq!(backfill_batch(&c, "batch-1").unwrap(), None);
        assert!(backfill_batch(&c, "batch-2").unwrap().is_some());
    }

    // ── Worker decisions (dedupe) ─────────────────────────────────────

    #[test]
    fn a_recorded_decision_makes_a_target_no_longer_undecided() {
        let c = conn();
        let targets = vec![
            Target { account_id: "a".into(), msg_key: "one@example.com".into() },
            Target { account_id: "a".into(), msg_key: "two@example.com".into() },
        ];
        record_decision(&c, "rule-1", &targets[0], true).unwrap();
        let left = undecided(&c, "rule-1", &targets).unwrap();
        assert_eq!(left, vec![targets[1].clone()]);
    }

    #[test]
    fn a_decision_is_scoped_to_its_own_rule() {
        let c = conn();
        let target = Target { account_id: "a".into(), msg_key: "one@example.com".into() };
        record_decision(&c, "rule-1", &target, false).unwrap();
        assert!(undecided(&c, "rule-1", &[target.clone()]).unwrap().is_empty());
        assert_eq!(
            undecided(&c, "rule-2", &[target.clone()]).unwrap(),
            vec![target],
            "a different rule has not decided anything about this message"
        );
    }

    #[test]
    fn a_no_match_decision_still_counts_as_decided() {
        let c = conn();
        let target = Target { account_id: "a".into(), msg_key: "one@example.com".into() };
        record_decision(&c, "rule-1", &target, false).unwrap();
        assert!(undecided(&c, "rule-1", &[target]).unwrap().is_empty(), "a 'no' is still a decision, not a retry candidate");
    }

    // ── Verdict parsing: unparseable is a refusal, never a guess ─────

    #[test]
    fn a_clear_yes_with_confidence_is_a_match() {
        assert_eq!(parse_verdict("MATCH: yes\nCONFIDENCE: 0.92").unwrap(), Verdict::Match(0.92));
    }

    #[test]
    fn a_clear_no_is_never_a_match_whatever_the_confidence_says() {
        assert_eq!(parse_verdict("MATCH: no\nCONFIDENCE: 0.99").unwrap(), Verdict::NoMatch);
    }

    #[test]
    fn parsing_is_case_and_whitespace_tolerant() {
        assert_eq!(parse_verdict("  match:  YES  \n  confidence: 0.5 ").unwrap(), Verdict::Match(0.5));
    }

    #[test]
    fn a_yes_with_no_confidence_at_all_is_a_refusal_not_a_guess() {
        assert!(parse_verdict("MATCH: yes").is_err());
    }

    #[test]
    fn a_yes_with_an_out_of_range_confidence_is_a_refusal() {
        assert!(parse_verdict("MATCH: yes\nCONFIDENCE: 1.5").is_err());
    }

    #[test]
    fn free_form_prose_is_a_refusal_not_a_silent_no_match() {
        let err = parse_verdict("Sure, this looks like a receipt to me!").unwrap_err();
        assert!(err.contains("unparseable"), "{err}");
    }

    #[test]
    fn an_empty_reply_is_a_refusal() {
        assert!(parse_verdict("").is_err());
    }

    #[test]
    fn meets_threshold_gates_on_confidence_and_never_on_a_no_match() {
        assert!(meets_threshold(Verdict::Match(0.8), 0.7));
        assert!(!meets_threshold(Verdict::Match(0.5), 0.7));
        assert!(!meets_threshold(Verdict::NoMatch, 0.0));
    }
}
