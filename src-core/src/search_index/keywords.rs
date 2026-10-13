//! An email's distinctive words for the view builder: `candidates` counts the
//! open message's words, `rank` weighs them against how much of the mailbox
//! uses them. Pure; the caller supplies document frequency.

use std::collections::HashMap;

use super::text::{fold_char, is_cjk};

/// One ranked word: its weighted count in the message and how many indexed
/// messages contain it.
#[derive(Debug, Clone, PartialEq)]
pub struct Keyword {
    pub term: String,
    pub tf: u32,
    pub df: u64,
}

/// Subject words count this many times one body occurrence.
const SUBJECT_WEIGHT: u32 = 3;
/// Below this many indexed messages the "too common" cut is skipped: a
/// fifth of a tiny mailbox says nothing about a word.
const MIN_DOCS_FOR_COMMON_CUT: u64 = 50;
/// A non-CJK whitespace chunk longer than this is base64, a redirect URL or
/// a tracking blob, never prose.
const MAX_CHUNK_CHARS: usize = 40;
/// Longest non-CJK word kept.
const MAX_TOKEN_CHARS: usize = 25;
/// Longest CJK run kept: there is no segmentation, so a longer run is a
/// clause, not a word.
const MAX_CJK_TOKEN_CHARS: usize = 8;
/// From this length a token mixing digits and letters, or made only of hex
/// digits, is an id or hash.
const ID_MIN_CHARS: usize = 8;

/// A whitespace chunk that is an email address (`\S+@\S+`) or a URL; its
/// pieces are not words of the message. ASCII checks only, no allocation.
fn is_address_or_url(chunk: &str) -> bool {
    if let Some(at) = chunk.find('@') {
        if at > 0 && at + 1 < chunk.len() {
            return true;
        }
    }
    if chunk.contains("://") {
        return true;
    }
    let rest = chunk.trim_start_matches(|c: char| !c.is_alphanumeric()).as_bytes();
    rest.len() >= 4 && rest[..4].eq_ignore_ascii_case(b"www.")
}

fn is_junk_chunk(chunk: &str) -> bool {
    if is_address_or_url(chunk) {
        return true;
    }
    !chunk.chars().any(is_cjk) && chunk.chars().count() > MAX_CHUNK_CHARS
}

fn keep_token(token: &str) -> bool {
    if matches!(token, "http" | "https" | "www") {
        return false;
    }
    if token.chars().all(|c| c.is_numeric()) {
        return false;
    }
    let n = token.chars().count();
    if token.chars().any(is_cjk) {
        return (2..=MAX_CJK_TOKEN_CHARS).contains(&n);
    }
    if !(4..=MAX_TOKEN_CHARS).contains(&n) {
        return false;
    }
    if n >= ID_MIN_CHARS {
        let digits = token.chars().any(|c| c.is_numeric());
        let letters = token.chars().any(|c| c.is_alphabetic());
        if (digits && letters) || token.chars().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
    }
    true
}

/// Weighted count and first-occurrence position of each word.
struct Counts {
    words: HashMap<String, (u32, usize)>,
    next: usize,
}

impl Counts {
    fn add_line(&mut self, line: &str, weight: u32) {
        for chunk in line.split_whitespace() {
            if is_junk_chunk(chunk) {
                continue;
            }
            let folded: String = chunk.chars().map(fold_char).collect();
            for token in folded.split(|c: char| !c.is_alphanumeric()) {
                if token.is_empty() || !keep_token(token) {
                    continue;
                }
                let next = self.next;
                let e = self.words.entry(token.to_string()).or_insert_with(|| (0, next));
                if e.1 == next {
                    self.next += 1;
                }
                e.0 = e.0.saturating_add(weight);
            }
        }
    }
}

/// The message's words with their weighted counts: lowercased, split on
/// anything not alphanumeric, 4 to 25 chars (2 to 8 when CJK), no numbers,
/// ids, hashes, URL or email pieces, base64 or other long blobs, and no body
/// lines quoting an earlier message (`>`). Subject words weigh 3x. Top `max`
/// by count, ties by first occurrence (subject before body).
pub fn candidates(subject: &str, body: &str, max: usize) -> Vec<(String, u32)> {
    let mut counts = Counts { words: HashMap::new(), next: 0 };
    counts.add_line(subject, SUBJECT_WEIGHT);
    for line in body.lines() {
        if line.trim_start().starts_with('>') {
            continue;
        }
        counts.add_line(line, 1);
    }
    let mut out: Vec<(String, u32, usize)> =
        counts.words.into_iter().map(|(t, (tf, first))| (t, tf, first)).collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.2.cmp(&b.2)));
    out.truncate(max);
    out.into_iter().map(|(t, tf, _)| (t, tf)).collect()
}

/// Scores each candidate `(1 + ln tf) * ln((N+1)/(df+1))` with `df` from the
/// caller. When `total_docs >= 50`, a word in more than a fifth of the mail
/// is dropped. A word with df 0 is dropped only when `drop_unseen` (the
/// message itself is indexed, so df 0 is noise); otherwise it is kept since
/// the message may not be indexed yet. Top `keep` by score; equal scores keep
/// the input order, which from `candidates` is first occurrence. A df error
/// aborts the rank.
pub fn rank(
    cands: Vec<(String, u32)>,
    total_docs: u64,
    mut df: impl FnMut(&str) -> Result<u64, String>,
    keep: usize,
    drop_unseen: bool,
) -> Result<Vec<Keyword>, String> {
    let n = total_docs;
    let mut scored: Vec<(f64, Keyword)> = Vec::with_capacity(cands.len());
    for (term, tf) in cands {
        let d = df(&term)?;
        if drop_unseen && d == 0 {
            continue;
        }
        if n >= MIN_DOCS_FOR_COMMON_CUT && d.saturating_mul(5) > n {
            continue;
        }
        let weight = if tf == 0 { 0.0 } else { 1.0 + (tf as f64).ln() };
        let idf = ((n as f64 + 1.0) / (d as f64 + 1.0)).ln();
        scored.push((weight * idf, Keyword { term, tf, df: d }));
    }
    // Stable: equal scores stay in input order.
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.truncate(keep);
    Ok(scored.into_iter().map(|(_, k)| k).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(c: &[(String, u32)]) -> Vec<&str> {
        c.iter().map(|(t, _)| t.as_str()).collect()
    }

    fn tf_of(c: &[(String, u32)], term: &str) -> Option<u32> {
        c.iter().find(|(t, _)| t == term).map(|(_, n)| *n)
    }

    fn ranked(r: &[Keyword]) -> Vec<&str> {
        r.iter().map(|k| k.term.as_str()).collect()
    }

    #[test]
    fn candidates_lowercase_and_drop_short_words() {
        let c = candidates("", "The Invoice for ACME is due", 10);
        // Equal tf: first occurrence first.
        assert_eq!(terms(&c), vec!["invoice", "acme"]);
    }

    #[test]
    fn candidates_strip_urls() {
        let body = "invoice https://example.com/billing/statement \
                    <http://tracker.example.org/pixel> WWW.shopping.example \
                    see http and https and www links";
        let c = candidates("", body, 50);
        for gone in ["http", "https", "www", "example", "billing", "statement", "tracker", "pixel", "shopping"] {
            assert!(tf_of(&c, gone).is_none(), "{gone} survived: {c:?}");
        }
        assert_eq!(tf_of(&c, "invoice"), Some(1));
        assert_eq!(tf_of(&c, "links"), Some(1));
    }

    #[test]
    fn candidates_strip_email_addresses() {
        let body = "reply to billing.team@acmecorp.com or <support@helpdesk.io> \
                    mailto:sales@vendor.net about the quarterly report";
        let c = candidates("", body, 50);
        for gone in ["billing", "team", "acmecorp", "support", "helpdesk", "mailto", "sales", "vendor"] {
            assert!(tf_of(&c, gone).is_none(), "{gone} survived: {c:?}");
        }
        assert_eq!(terms(&c), vec!["reply", "about", "quarterly", "report"]);
    }

    #[test]
    fn candidates_drop_all_digit_tokens_but_keep_mixed() {
        let c = candidates("", "order 20241013 ref 2024abc total 1234", 50);
        assert!(tf_of(&c, "20241013").is_none());
        assert!(tf_of(&c, "1234").is_none());
        assert_eq!(tf_of(&c, "2024abc"), Some(1));
        assert_eq!(tf_of(&c, "order"), Some(1));
        assert_eq!(tf_of(&c, "total"), Some(1));
    }

    #[test]
    fn candidates_skip_base64_lines() {
        let body = "attached scan\n\
                    SGVsbG8gd29ybGQsIHRoaXMgaXMgYSBiYXNlNjQgbGluZSB0aGF0IGlzIGxvbmc=\n\
                    dGhpcyBpcyBhIHRlc3Qgb2Ygc29tZQ\n\
                    thanks";
        let c = candidates("", body, 50);
        assert_eq!(terms(&c), vec!["attached", "scan", "thanks"]);
    }

    #[test]
    fn candidates_skip_long_redirect_chunks() {
        let body = "click track.example/r?u=aHR0cHM6Ly9leGFtcGxlLmNvbS9vZmZlcnM&id=99 offer";
        let c = candidates("", body, 50);
        assert_eq!(terms(&c), vec!["click", "offer"]);
    }

    #[test]
    fn candidates_drop_hex_ids_and_long_mixed_tokens() {
        let body = "ticket 3f2a9c8e1b7d4f6a0e5c9b2d8a1f7e3c ref deadbeefcafe \
                    code invoice9f8e7d order 2024abc";
        let c = candidates("", body, 50);
        assert!(tf_of(&c, "3f2a9c8e1b7d4f6a0e5c9b2d8a1f7e3c").is_none(), "{c:?}");
        assert!(tf_of(&c, "deadbeefcafe").is_none(), "{c:?}");
        assert!(tf_of(&c, "invoice9f8e7d").is_none(), "{c:?}");
        assert_eq!(terms(&c), vec!["ticket", "code", "order", "2024abc"]);
    }

    #[test]
    fn candidates_drop_overlong_plain_tokens() {
        let c = candidates("", "word supercalifragilisticexpialidociousness", 50);
        assert_eq!(terms(&c), vec!["word"]);
    }

    #[test]
    fn candidates_skip_quoted_reply_lines() {
        let body = "sounds good\n> original proposal text\n  >> older thread wording\nregards";
        let c = candidates("", body, 50);
        assert_eq!(terms(&c), vec!["sounds", "good", "regards"]);
        // A '>' inside a line does not quote it.
        let k = candidates("", "budget > forecast", 50);
        assert_eq!(terms(&k), vec!["budget", "forecast"]);
    }

    #[test]
    fn candidates_weigh_subject_three_times() {
        let c = candidates("Kickoff meeting", "meeting agenda agenda agenda agenda", 10);
        assert_eq!(tf_of(&c, "kickoff"), Some(3));
        assert_eq!(tf_of(&c, "meeting"), Some(4));
        assert_eq!(tf_of(&c, "agenda"), Some(4));
        // Highest tf first; ties by first occurrence, subject before body.
        assert_eq!(terms(&c), vec!["meeting", "agenda", "kickoff"]);
    }

    #[test]
    fn candidates_truncate_to_max_by_tf_then_first_occurrence() {
        let c = candidates("", "zeta zeta alpha beta gamma gamma delta", 3);
        assert_eq!(terms(&c), vec!["zeta", "gamma", "alpha"]);
        assert!(candidates("", "zeta alpha", 0).is_empty());
    }

    #[test]
    fn candidates_fold_non_ascii() {
        let c = candidates("", "ÜBERWEISUNG überweisung Straße", 10);
        assert_eq!(tf_of(&c, "überweisung"), Some(2));
        assert_eq!(tf_of(&c, "straße"), Some(1));
    }

    #[test]
    fn candidates_keep_two_char_cjk_tokens() {
        // Han words separated by spaces: 2 chars kept, 1 char dropped.
        let c = candidates("会议", "会议 请 确认 时间 東京", 10);
        assert_eq!(tf_of(&c, "会议"), Some(4));
        assert_eq!(tf_of(&c, "确认"), Some(1));
        assert_eq!(tf_of(&c, "東京"), Some(1));
        assert!(tf_of(&c, "请").is_none());
        // Hangul and kana too; a 3-char Latin token stays dropped.
        let k = candidates("", "회의 カタ abc", 10);
        assert_eq!(terms(&k), vec!["회의", "カタ"]);
    }

    #[test]
    fn candidates_drop_long_unsegmented_cjk() {
        // One 12-char Han clause is not a word; the short one after it is.
        let c = candidates("", "请确认明天下午的会议时间。谢谢！", 10);
        assert_eq!(terms(&c), vec!["谢谢"]);
        // 8 chars is still kept.
        let k = candidates("", "明天下午会议时间", 10);
        assert_eq!(terms(&k), vec!["明天下午会议时间"]);
    }

    #[test]
    fn candidates_empty_input() {
        assert!(candidates("", "", 10).is_empty());
        assert!(candidates("   ", " \n\t ", 10).is_empty());
    }

    fn df_table(pairs: &'static [(&'static str, u64)]) -> impl FnMut(&str) -> Result<u64, String> {
        move |t: &str| Ok(pairs.iter().find(|(k, _)| *k == t).map(|(_, v)| *v).unwrap_or(0))
    }

    #[test]
    fn rank_puts_rare_term_above_common_with_equal_tf() {
        let cands = vec![("common".to_string(), 2), ("rare".to_string(), 2)];
        let r = rank(cands, 1000, df_table(&[("common", 150), ("rare", 3)]), 10, false).unwrap();
        assert_eq!(ranked(&r), vec!["rare", "common"]);
        assert_eq!(r[0], Keyword { term: "rare".into(), tf: 2, df: 3 });
        assert_eq!(r[1].df, 150);
    }

    #[test]
    fn rank_drops_terms_in_more_than_a_fifth_of_mail() {
        let cands = vec![("edge".to_string(), 1), ("over".to_string(), 1), ("hello".to_string(), 9)];
        let r = rank(cands, 50, df_table(&[("edge", 10), ("over", 11), ("hello", 40)]), 10, false).unwrap();
        // df*5 == N is kept; df*5 > N is dropped.
        assert_eq!(ranked(&r), vec!["edge"]);
    }

    #[test]
    fn rank_keeps_common_terms_in_a_small_mailbox() {
        let cands = vec![("hello".to_string(), 1)];
        let r = rank(cands, 49, df_table(&[("hello", 40)]), 10, false).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].df, 40);
    }

    #[test]
    fn rank_keeps_df_zero_terms_unless_asked_to_drop_them() {
        let cands = vec![("unindexed".to_string(), 1), ("known".to_string(), 1)];
        let r = rank(cands.clone(), 500, df_table(&[("known", 20)]), 10, false).unwrap();
        assert_eq!(r[0], Keyword { term: "unindexed".into(), tf: 1, df: 0 });
        assert_eq!(r[1].term, "known");
        let d = rank(cands, 500, df_table(&[("known", 20)]), 10, true).unwrap();
        assert_eq!(ranked(&d), vec!["known"]);
    }

    #[test]
    fn rank_dampens_tf_sublinearly() {
        // Linear tf: 3 * ln(1001/100) ~ 6.911 would beat 1 * ln(1001) ~ 6.909.
        // Sublinear: (1 + ln 3) * ln(1001/100) ~ 4.834 loses to 6.909.
        let cands = vec![("often".to_string(), 3), ("lone".to_string(), 1)];
        let r = rank(cands, 1000, df_table(&[("lone", 0), ("often", 99)]), 10, false).unwrap();
        assert_eq!(ranked(&r), vec!["lone", "often"]);
        // Still more occurrences win at equal df.
        let cands = vec![("once".to_string(), 1), ("twice".to_string(), 2)];
        let r = rank(cands, 1000, df_table(&[]), 10, false).unwrap();
        assert_eq!(ranked(&r), vec!["twice", "once"]);
    }

    #[test]
    fn rank_ties_keep_input_order_and_truncate_to_keep() {
        let cands = vec![
            ("zulu".to_string(), 1),
            ("alpha".to_string(), 1),
            ("mike".to_string(), 1),
        ];
        let r = rank(cands, 1000, df_table(&[]), 2, false).unwrap();
        assert_eq!(ranked(&r), vec!["zulu", "alpha"]);
    }

    #[test]
    fn rank_surfaces_df_errors() {
        let cands = vec![("alpha".to_string(), 1)];
        let err = rank(cands, 1000, |_: &str| Err("index busy".to_string()), 10, false).unwrap_err();
        assert_eq!(err, "index busy");
    }

    #[test]
    fn rank_asks_df_once_per_candidate() {
        let mut asked = Vec::new();
        let cands = vec![("alpha".to_string(), 2), ("beta".to_string(), 1)];
        let r = rank(cands, 10, |t: &str| { asked.push(t.to_string()); Ok(1) }, 10, false).unwrap();
        assert_eq!(asked, vec!["alpha", "beta"]);
        assert_eq!(r.len(), 2);
    }
}
