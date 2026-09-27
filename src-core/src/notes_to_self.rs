//! Notes to Self: detecting a message the user sent to their own addresses,
//! and sorting it onto a board column. Spec: docs/superpowers/plans/
//! 2026-09-26-feedback-batch-sdd/track-I-spec.md.
//!
//! Pure functions only — no I/O, no index access. `search_index::query`
//! supplies the candidate rows (already narrowed to `from_addr_lc IN (own)`);
//! this module answers "is it really a note" and "which column".

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

const GMAIL_DOMAINS: [&str; 2] = ["gmail.com", "googlemail.com"];

/// Mirrors `src/utils/emailIdentity.js` `normalizeEmailIdentity` exactly:
/// lowercase, then for gmail.com/googlemail.com only, drop `+tag` and dots
/// from the local part. `tests/fixtures/email-identity-cases.json` is shared
/// with that file's vitest suite so the two can never drift.
pub fn normalize_identity(addr: &str) -> String {
    let trimmed = addr.trim().to_lowercase();
    let Some(at) = trimmed.rfind('@') else { return trimmed };
    let local = &trimmed[..at];
    let domain = &trimmed[at + 1..];
    if !GMAIL_DOMAINS.contains(&domain) {
        return format!("{local}@{domain}");
    }
    let canonical_local = local.split('+').next().unwrap_or("").replace('.', "");
    format!("{canonical_local}@gmail.com")
}

/// Track I rule: sender in own identities AND every recipient (to + cc + bcc)
/// in own identities. `own` is already normalized; `from`/`recipients` are not.
pub fn is_note_to_self(from: &str, recipients: &[String], own: &HashSet<String>) -> bool {
    if recipients.is_empty() {
        return false;
    }
    if !own.contains(&normalize_identity(from)) {
        return false;
    }
    recipients.iter().all(|r| own.contains(&normalize_identity(r)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Column {
    Tag(String),
    Links,
    Files,
    Photos,
    Notes,
}

static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#(\w+)").unwrap());
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s<>]+").unwrap());

/// First `#tag` token in `subject` -> `(TitleCased, subject with that token
/// removed)`. A second tag is left in the returned subject untouched.
fn extract_tag(subject: &str) -> Option<(String, String)> {
    let m = TAG.find(subject)?;
    let word = &subject[m.start() + 1..m.end()];
    let mut rest = String::with_capacity(subject.len());
    rest.push_str(&subject[..m.start()]);
    rest.push_str(&subject[m.end()..]);
    let rest = rest.split_whitespace().collect::<Vec<_>>().join(" ");
    Some((title_case(word), rest))
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
    }
}

/// http(s) URLs in `subject` then `snippet`, in order found, deduped.
/// Trailing punctuation a sentence would add (`.`, `,`, `)`, closing quotes)
/// is trimmed off; a link buried deeper in a full body is never seen, since
/// only these two indexed columns are checked.
pub fn links(subject: &str, snippet: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for text in [subject, snippet] {
        for m in URL.find_iter(text) {
            let url = m.as_str().trim_end_matches(|c: char| ".,;:!?)\"']".contains(c));
            if !url.is_empty() && seen.insert(url.to_string()) {
                out.push(url.to_string());
            }
        }
    }
    out
}

/// Column rule, first match wins: `#tag` in subject -> `Tag`; any image
/// attachment -> `Photos`; any other attachment -> `Files`; any link ->
/// `Links`; else `Notes`. Returns the subject with a matched `#tag` token
/// stripped (unchanged for every other column).
pub fn classify(subject: &str, snippet: &str, attachments: &[(String, String)]) -> (Column, String) {
    if let Some((tag, stripped)) = extract_tag(subject) {
        return (Column::Tag(tag), stripped);
    }
    if attachments.iter().any(|(_, mime)| mime.starts_with("image/")) {
        return (Column::Photos, subject.to_string());
    }
    if !attachments.is_empty() {
        return (Column::Files, subject.to_string());
    }
    if !links(subject, snippet).is_empty() {
        return (Column::Links, subject.to_string());
    }
    (Column::Notes, subject.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const FIXTURE: &str = include_str!("../tests/fixtures/email-identity-cases.json");

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        input: String,
        expected: String,
    }

    #[test]
    fn normalize_identity_matches_js_fixture() {
        let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
        assert!(!fixture.cases.is_empty(), "fixture must not be empty");
        for case in fixture.cases {
            assert_eq!(normalize_identity(&case.input), case.expected, "case {}", case.name);
        }
    }

    fn set(addrs: &[&str]) -> HashSet<String> {
        addrs.iter().map(|a| normalize_identity(a)).collect()
    }

    #[test]
    fn self_to_self_is_a_note() {
        let own = set(&["me@example.com"]);
        assert!(is_note_to_self("me@example.com", &["me@example.com".into()], &own));
    }

    #[test]
    fn self_to_other_own_account_is_a_note() {
        let own = set(&["me@example.com", "work@example.com"]);
        assert!(is_note_to_self("me@example.com", &["work@example.com".into()], &own));
    }

    #[test]
    fn self_to_self_plus_a_stranger_is_not_a_note() {
        let own = set(&["me@example.com"]);
        assert!(!is_note_to_self(
            "me@example.com",
            &["me@example.com".into(), "stranger@other.com".into()],
            &own
        ));
    }

    #[test]
    fn empty_recipients_is_not_a_note() {
        let own = set(&["me@example.com"]);
        assert!(!is_note_to_self("me@example.com", &[], &own));
    }

    #[test]
    fn a_stranger_sender_is_not_a_note() {
        let own = set(&["me@example.com"]);
        assert!(!is_note_to_self("stranger@other.com", &["me@example.com".into()], &own));
    }

    #[test]
    fn plus_tag_variant_still_matches() {
        let own = set(&["me@gmail.com"]);
        assert!(is_note_to_self("me+work@gmail.com", &["me@gmail.com".into()], &own));
    }

    #[test]
    fn classify_tag_column_strips_the_tag() {
        let (col, subject) = classify("#recipes Pasta", "", &[]);
        assert_eq!(col, Column::Tag("Recipes".into()));
        assert_eq!(subject, "Pasta");
    }

    #[test]
    fn classify_two_tags_first_one_wins() {
        let (col, _) = classify("#recipes #dinner Pasta", "", &[]);
        assert_eq!(col, Column::Tag("Recipes".into()));
    }

    #[test]
    fn classify_photo_attachment() {
        let attachments = [("beach.jpg".to_string(), "image/jpeg".to_string())];
        let (col, subject) = classify("Beach day", "", &attachments);
        assert_eq!(col, Column::Photos);
        assert_eq!(subject, "Beach day");
    }

    #[test]
    fn classify_non_image_attachment() {
        let attachments = [("report.pdf".to_string(), "application/pdf".to_string())];
        let (col, _) = classify("Report", "", &attachments);
        assert_eq!(col, Column::Files);
    }

    #[test]
    fn classify_link_only() {
        let (col, _) = classify("Check this", "See https://example.com/page for details", &[]);
        assert_eq!(col, Column::Links);
    }

    #[test]
    fn classify_plain_note_falls_back() {
        let (col, subject) = classify("Just a thought", "", &[]);
        assert_eq!(col, Column::Notes);
        assert_eq!(subject, "Just a thought");
    }

    #[test]
    fn classify_tag_wins_over_photo_and_link() {
        let attachments = [("beach.jpg".to_string(), "image/jpeg".to_string())];
        let (col, _) = classify("#photos check https://example.com", "", &attachments);
        assert_eq!(col, Column::Tag("Photos".into()));
    }

    #[test]
    fn links_from_subject_and_snippet_deduped_in_order() {
        let found = links("See http://a.com!", "Also http://a.com and https://b.com/x.");
        assert_eq!(found, vec!["http://a.com".to_string(), "https://b.com/x".to_string()]);
    }

    #[test]
    fn links_none_found() {
        assert!(links("Just a subject", "and a snippet with no url").is_empty());
    }
}
