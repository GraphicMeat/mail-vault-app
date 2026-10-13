//! An email's distinctive words for the view builder: `candidates` counts the
//! open message's words, `rank` weighs them against how much of the mailbox
//! uses them. Pure; the caller supplies document frequency.

/// One ranked word: its weighted count in the message and how many indexed
/// messages contain it.
#[derive(Debug, Clone, PartialEq)]
pub struct Keyword {
    pub term: String,
    pub tf: u32,
    pub df: u64,
}

use std::collections::HashMap;

use super::text::{fold_char, is_cjk};

/// Subject words count this many times one body occurrence.
const SUBJECT_WEIGHT: u32 = 3;
/// Below this many indexed messages the "too common" cut is skipped: a
/// fifth of a tiny mailbox says nothing about a word.
const MIN_DOCS_FOR_COMMON_CUT: u64 = 50;

/// A whitespace chunk that is an email address (`\S+@\S+`) or a URL; its
/// pieces are not words of the message.
fn is_address_or_url(chunk: &str) -> bool {
    if let Some(at) = chunk.find('@') {
        if at > 0 && at + 1 < chunk.len() {
            return true;
        }
    }
    let lower = chunk.to_lowercase();
    if lower.contains("://") {
        return true;
    }
    lower.trim_start_matches(|c: char| !c.is_alphanumeric()).starts_with("www.")
}

fn keep_token(token: &str) -> bool {
    if matches!(token, "http" | "https" | "www") {
        return false;
    }
    if token.chars().all(|c| c.is_numeric()) {
        return false;
    }
    let n = token.chars().count();
    n >= 4 || (n >= 2 && token.chars().any(is_cjk))
}

fn count_words(text: &str, weight: u32, counts: &mut HashMap<String, u32>) {
    for chunk in text.split_whitespace() {
        if is_address_or_url(chunk) {
            continue;
        }
        let folded: String = chunk.chars().map(fold_char).collect();
        for token in folded.split(|c: char| !c.is_alphanumeric()) {
            if token.is_empty() || !keep_token(token) {
                continue;
            }
            let n = counts.entry(token.to_string()).or_insert(0);
            *n = n.saturating_add(weight);
        }
    }
}

/// The message's words with their weighted counts: lowercased, split on
/// anything not alphanumeric, at least 4 chars (2 when CJK), no numbers, no
/// pieces of URLs or email addresses. Subject words weigh 3x. Top `max` by
/// count, ties alphabetical.
pub fn candidates(subject: &str, body: &str, max: usize) -> Vec<(String, u32)> {
    let mut counts = HashMap::new();
    count_words(subject, SUBJECT_WEIGHT, &mut counts);
    count_words(body, 1, &mut counts);
    let mut out: Vec<(String, u32)> = counts.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.truncate(max);
    out
}

/// Scores each candidate `tf * ln((N+1)/(df+1))` with `df` from the caller.
/// When `total_docs >= 50`, a word in more than a fifth of the mail is
/// dropped. A word with df 0 is kept: the message itself may not be indexed
/// yet. Top `keep` by score, ties alphabetical. A df error aborts the rank.
pub fn rank(
    cands: Vec<(String, u32)>,
    total_docs: u64,
    mut df: impl FnMut(&str) -> Result<u64, String>,
    keep: usize,
) -> Result<Vec<Keyword>, String> {
    let n = total_docs;
    let mut scored: Vec<(f64, Keyword)> = Vec::with_capacity(cands.len());
    for (term, tf) in cands {
        let d = df(&term)?;
        if n >= MIN_DOCS_FOR_COMMON_CUT && d.saturating_mul(5) > n {
            continue;
        }
        let idf = ((n as f64 + 1.0) / (d as f64 + 1.0)).ln();
        scored.push((tf as f64 * idf, Keyword { term, tf, df: d }));
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.term.cmp(&b.1.term)));
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

    #[test]
    fn candidates_lowercase_and_drop_short_words() {
        let c = candidates("", "The Invoice for ACME is due", 10);
        assert_eq!(terms(&c), vec!["acme", "invoice"]);
    }

    #[test]
    fn candidates_strip_urls() {
        let body = "invoice https://example.com/billing/statement \
                    <http://tracker.example.org/pixel> www.shopping.example \
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
        assert_eq!(terms(&c), vec!["about", "quarterly", "reply", "report"]);
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
    fn candidates_weigh_subject_three_times() {
        let c = candidates("Kickoff meeting", "meeting agenda agenda agenda agenda", 10);
        assert_eq!(tf_of(&c, "kickoff"), Some(3));
        assert_eq!(tf_of(&c, "meeting"), Some(4));
        assert_eq!(tf_of(&c, "agenda"), Some(4));
        // Ties alphabetical, highest tf first.
        assert_eq!(terms(&c), vec!["agenda", "meeting", "kickoff"]);
    }

    #[test]
    fn candidates_truncate_to_max_by_tf_then_alphabetical() {
        let c = candidates("", "zeta zeta alpha beta gamma gamma delta", 3);
        assert_eq!(terms(&c), vec!["gamma", "zeta", "alpha"]);
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
        assert_eq!(terms(&k), vec!["カタ", "회의"]);
    }

    #[test]
    fn candidates_unspaced_cjk_does_not_panic() {
        let c = candidates("", "请确认明天下午的会议时间。谢谢！", 10);
        assert_eq!(c.len(), 2);
        assert!(c.iter().all(|(t, _)| t.chars().count() >= 2));
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
        let r = rank(cands, 1000, df_table(&[("common", 150), ("rare", 3)]), 10).unwrap();
        assert_eq!(r.iter().map(|k| k.term.as_str()).collect::<Vec<_>>(), vec!["rare", "common"]);
        assert_eq!(r[0], Keyword { term: "rare".into(), tf: 2, df: 3 });
        assert_eq!(r[1].df, 150);
    }

    #[test]
    fn rank_drops_terms_in_more_than_a_fifth_of_mail() {
        let cands = vec![("edge".to_string(), 1), ("over".to_string(), 1), ("hello".to_string(), 9)];
        let r = rank(cands, 50, df_table(&[("edge", 10), ("over", 11), ("hello", 40)]), 10).unwrap();
        // df*5 == N is kept; df*5 > N is dropped.
        assert_eq!(r.iter().map(|k| k.term.as_str()).collect::<Vec<_>>(), vec!["edge"]);
    }

    #[test]
    fn rank_keeps_common_terms_in_a_small_mailbox() {
        let cands = vec![("hello".to_string(), 1)];
        let r = rank(cands, 49, df_table(&[("hello", 40)]), 10).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].df, 40);
    }

    #[test]
    fn rank_keeps_df_zero_terms() {
        let cands = vec![("unindexed".to_string(), 1), ("known".to_string(), 1)];
        let r = rank(cands, 500, df_table(&[("known", 20)]), 10).unwrap();
        assert_eq!(r[0], Keyword { term: "unindexed".into(), tf: 1, df: 0 });
        assert_eq!(r[1].term, "known");
    }

    #[test]
    fn rank_scores_tf_times_idf() {
        // tf 3 at df 99 (ln(1001/100) ~ 2.30, score ~6.91) beats tf 1 at df 0
        // (ln(1001) ~ 6.91, score ~6.909).
        let cands = vec![("lone".to_string(), 1), ("often".to_string(), 3)];
        let r = rank(cands, 1000, df_table(&[("lone", 0), ("often", 99)]), 10).unwrap();
        let expect = |tf: f64, df: f64| tf * ((1001.0f64) / (df + 1.0)).ln();
        assert!(expect(3.0, 99.0) > expect(1.0, 0.0));
        assert_eq!(r.iter().map(|k| k.term.as_str()).collect::<Vec<_>>(), vec!["often", "lone"]);
    }

    #[test]
    fn rank_ties_alphabetical_and_truncates_to_keep() {
        let cands = vec![
            ("zulu".to_string(), 1),
            ("alpha".to_string(), 1),
            ("mike".to_string(), 1),
        ];
        let r = rank(cands, 1000, df_table(&[]), 2).unwrap();
        assert_eq!(r.iter().map(|k| k.term.as_str()).collect::<Vec<_>>(), vec!["alpha", "mike"]);
    }

    #[test]
    fn rank_surfaces_df_errors() {
        let cands = vec![("alpha".to_string(), 1)];
        let err = rank(cands, 1000, |_: &str| Err("index busy".to_string()), 10).unwrap_err();
        assert_eq!(err, "index busy");
    }

    #[test]
    fn rank_asks_df_once_per_candidate() {
        let mut asked = Vec::new();
        let cands = vec![("alpha".to_string(), 2), ("beta".to_string(), 1)];
        let r = rank(cands, 10, |t: &str| { asked.push(t.to_string()); Ok(1) }, 10).unwrap();
        assert_eq!(asked, vec!["alpha", "beta"]);
        assert_eq!(r.len(), 2);
    }
}
