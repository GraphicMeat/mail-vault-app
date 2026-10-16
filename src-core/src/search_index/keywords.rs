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

/// Words that name the number after them (`Kliento kodas 7712345`), lowercase.
const ID_LABELS: &[&str] = &[
    "nr", "no", "number", "numeris", "numero", "número", "numéro", "kodas", "kodo", "kliento", "abonento",
    "abonentas", "vartotojo", "objekto", "sutarties", "id", "account", "acct", "ref", "reference", "invoice",
    "customer", "contract", "konto", "kundennummer",
];
/// A bare number (no letters) this long, after a label, is an identifier.
const BARE_ID_DIGITS: std::ops::RangeInclusive<usize> = 7..=14;
/// Longest identifier kept, separators aside.
const MAX_ID_CHARS: usize = 24;
/// Hex-only tokens from this length are hashes, not references.
const HASH_MIN_CHARS: usize = 16;

fn trim_edges(token: &str) -> &str {
    token.trim_matches(|c: char| !c.is_alphanumeric())
}

fn label_of(token: &str) -> String {
    token.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

/// `20241013` style: a year 19xx/20xx then month then day.
fn looks_like_date(digits: &str) -> bool {
    if digits.len() != 8 || !(digits.starts_with("19") || digits.starts_with("20")) {
        return false;
    }
    let month: u32 = digits[4..6].parse().unwrap_or(0);
    let day: u32 = digits[6..8].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// Whether an ASCII token is a reference number on its own shape: letters and
/// at least four digits, letters of one case, not a hash or a unit.
fn is_reference_shape(token: &str) -> bool {
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | '_')) {
        return false;
    }
    let core: Vec<char> = token.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if !(5..=MAX_ID_CHARS).contains(&core.len()) {
        return false;
    }
    let digits = core.iter().filter(|c| c.is_ascii_digit()).count();
    let letters: Vec<&char> = core.iter().filter(|c| c.is_ascii_alphabetic()).collect();
    if digits < 4 || letters.is_empty() {
        return false;
    }
    if core.len() >= HASH_MIN_CHARS && core.iter().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let upper = letters.iter().filter(|c| c.is_ascii_uppercase()).count();
    if upper != 0 && upper != letters.len() {
        return false;
    }
    // `2024m`, `100kg`: a number with its unit.
    !(core[0].is_ascii_digit() && letters.len() <= 2 && upper == 0)
}

/// Tallies display strings by their lowercase key, first spelling shown.
struct Tally {
    seen: HashMap<String, (String, u32, usize)>,
    next: usize,
}

impl Tally {
    fn new() -> Self {
        Tally { seen: HashMap::new(), next: 0 }
    }
    fn add(&mut self, shown: String) {
        let key: String = shown.chars().map(fold_char).collect();
        let next = self.next;
        let e = self.seen.entry(key).or_insert_with(|| (shown, 0, next));
        if e.2 == next {
            self.next += 1;
        }
        e.1 = e.1.saturating_add(1);
    }
    fn top(self, max: usize) -> Vec<(String, u32)> {
        let mut out: Vec<(String, u32, usize)> = self.seen.into_values().map(|(s, n, first)| (s, n, first)).collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.2.cmp(&b.2)));
        out.truncate(max);
        out.into_iter().map(|(s, n, _)| (s, n)).collect()
    }
}

/// Reference numbers in `text`, as written: letters and digits in one case
/// (`BV530133`), or a bare number of 7 to 14 digits right after a label word
/// (`Kliento kodas 7712345`). Not dates, hashes, amounts, phones, URLs or
/// addresses. Most frequent first, ties by first occurrence.
pub fn identifiers(text: &str, max: usize) -> Vec<(String, u32)> {
    let mut tally = Tally::new();
    for line in text.lines() {
        let mut before: Vec<String> = Vec::new();
        for chunk in line.split_whitespace() {
            let token = trim_edges(chunk);
            let labels_it = before.iter().rev().take(2).any(|prev| ID_LABELS.contains(&prev.as_str()));
            before.push(label_of(chunk));
            if token.is_empty() || is_address_or_url(chunk) {
                continue;
            }
            if is_reference_shape(token) {
                tally.add(token.to_string());
                continue;
            }
            let digits: String = token.chars().filter(|c| c.is_ascii_digit()).collect();
            let bare = token.chars().all(|c| c.is_ascii_digit());
            if bare && labels_it && BARE_ID_DIGITS.contains(&digits.len()) && !looks_like_date(&digits) {
                tally.add(token.to_string());
            }
        }
    }
    tally.top(max)
}

/// Street words that follow the street name (`Mindaugo g.`, `Baker Street`).
const STREET_AFTER: &[&str] = &[
    "g", "gatve", "gatvė", "pr", "prospektas", "al", "aleja", "skg", "pl", "st", "street", "rd", "road", "ave",
    "avenue", "ln", "lane", "blvd", "dr", "drive", "str", "strasse", "straße", "weg", "platz",
];
/// Street words that come before the name (`Rue Lafayette`).
const STREET_BEFORE: &[&str] = &["rue", "via", "calle", "avenida", "ul", "ulica"];

fn is_house_number(token: &str) -> bool {
    let token = token.trim_end_matches(|c: char| matches!(c, ',' | ';' | '.'));
    let mut parts = 0;
    for part in token.split(|c| c == '-' || c == '/') {
        parts += 1;
        let digits = part.chars().take_while(|c| c.is_ascii_digit()).count();
        let rest = &part[digits..];
        if !(1..=4).contains(&digits) || rest.chars().count() > 1 || !rest.chars().all(|c| c.is_ascii_alphabetic()) {
            return false;
        }
    }
    (1..=2).contains(&parts)
}

fn marker_in(token: &str, set: &[&str]) -> bool {
    let word = token.trim_end_matches(|c: char| matches!(c, ',' | ';' | '.' | ':')).to_lowercase();
    !word.is_empty() && set.contains(&word.as_str())
}

fn is_name_word(token: &str) -> bool {
    let word = token.trim_matches(|c: char| !c.is_alphanumeric());
    word.chars().next().is_some_and(char::is_uppercase) && word.chars().all(char::is_alphabetic) && word.chars().count() >= 2
}

fn plain(token: &str) -> &str {
    token.trim_end_matches(|c: char| matches!(c, ',' | ';' | ':'))
}

/// Street addresses in `text`, as written: `Mindaugo g. 30-49`,
/// `Main St 12B`, `221 Baker Street`, `Rue Lafayette 5`. A street word and a
/// house number are both required, within one line. Most frequent first.
pub fn phrases(text: &str, max: usize) -> Vec<(String, u32)> {
    let mut tally = Tally::new();
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for i in 0..t.len() {
            // Name, street word, number.
            if marker_in(t[i], STREET_AFTER) && i >= 1 && i + 1 < t.len() && is_name_word(t[i - 1]) && is_house_number(t[i + 1]) {
                spans.push((i - 1, i + 1));
            }
            // Street word, name, number.
            if marker_in(t[i], STREET_BEFORE) && i + 2 < t.len() && is_name_word(t[i + 1]) && is_house_number(t[i + 2]) {
                spans.push((i, i + 2));
            }
            // Number, name (one or two), street word.
            if is_house_number(t[i]) {
                for names in 1..=2usize {
                    let end = i + names + 1;
                    if end < t.len() && t[i + 1..=i + names].iter().all(|w| is_name_word(w)) && marker_in(t[end], STREET_AFTER) {
                        spans.push((i, end));
                        break;
                    }
                }
            }
        }
        for (from, to) in spans {
            let mut words: Vec<String> = Vec::new();
            for (n, w) in t[from..=to].iter().enumerate() {
                let w = plain(w);
                // The street word keeps its dot (`g.`); the last word drops
                // any sentence period.
                words.push(if n + from == to { w.trim_end_matches('.').to_string() } else { w.to_string() });
            }
            tally.add(words.join(" "));
        }
    }
    tally.top(max)
}

/// The most document frequency `rank` needs to see for a mailbox of
/// `total_docs`: a word in more than a fifth of the mail is dropped whatever
/// its exact count, so a probe may stop counting at `n/5 + 1`. `None` below
/// the size where that cut applies (every count matters there).
pub fn df_cap(total_docs: u64) -> Option<u64> {
    (total_docs >= MIN_DOCS_FOR_COMMON_CUT).then(|| total_docs / 5 + 1)
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

    /// A count capped at `df_cap` ranks exactly as the true count: above the
    /// cut it is still dropped, below it it is the exact df.
    #[test]
    fn a_df_capped_at_df_cap_ranks_like_the_exact_df() {
        assert_eq!(df_cap(49), None, "a small mailbox needs every count");
        let n = 60;
        let cap = df_cap(n).unwrap();
        assert_eq!(cap, 13);
        let cands = vec![("common".to_string(), 1), ("edge".to_string(), 1), ("rare".to_string(), 1)];
        let exact = |t: &str| Ok(match t { "common" => 40, "edge" => 12, _ => 2 });
        let capped = |t: &str| exact(t).map(|d: u64| d.min(cap));
        let a = rank(cands.clone(), n, exact, 10, true).unwrap();
        let b = rank(cands, n, capped, 10, true).unwrap();
        assert_eq!(a, b);
        assert_eq!(ranked(&b), vec!["rare", "edge"]);
        // Exactly a fifth stays; one more is cut.
        let at = rank(vec![("fifth".to_string(), 1)], n, |_| Ok(12), 10, true).unwrap();
        assert_eq!(ranked(&at), vec!["fifth"]);
        let over = rank(vec![("over".to_string(), 1)], n, |_| Ok(cap), 10, true).unwrap();
        assert!(over.is_empty());
    }

    #[test]
    fn rank_asks_df_once_per_candidate() {
        let mut asked = Vec::new();
        let cands = vec![("alpha".to_string(), 2), ("beta".to_string(), 1)];
        let r = rank(cands, 10, |t: &str| { asked.push(t.to_string()); Ok(1) }, 10, false).unwrap();
        assert_eq!(asked, vec!["alpha", "beta"]);
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn identifiers_keep_a_reference_number_and_its_case() {
        let text = "Sąskaita faktūra BV530133\nKliento kodas: SFR04153491, mokėti iki 2026-09-30";
        let ids = identifiers(text, 10);
        assert_eq!(ids, vec![("BV530133".to_string(), 1), ("SFR04153491".to_string(), 1)]);
    }

    #[test]
    fn identifiers_count_repeats_and_fold_case_for_the_tally() {
        let ids = identifiers("BV530133 and again bv530133 then BV530133", 10);
        assert_eq!(ids, vec![("BV530133".to_string(), 3)]);
    }

    #[test]
    fn identifiers_skip_hashes_dates_amounts_and_plain_numbers() {
        let text = "2026-09-30 10:30 30kg 12.50 +37060012345 3f9a1c77d2e04b58a6c1 AbC9xZ12qW tel 800 19118 order 20241013";
        assert!(identifiers(text, 10).is_empty(), "{:?}", identifiers(text, 10));
    }

    #[test]
    fn identifiers_take_a_bare_number_only_after_a_label() {
        let ids = identifiers("Kliento kodas 7712345 ir 9988776 be pavadinimo", 10);
        assert_eq!(ids, vec![("7712345".to_string(), 1)]);
        let ids = identifiers("Invoice no. 20457811 due", 10);
        assert_eq!(ids, vec![("20457811".to_string(), 1)]);
    }

    #[test]
    fn identifiers_skip_urls_and_addresses() {
        let text = "https://pay.example.com/BV530133 info@vv.lt";
        assert!(identifiers(text, 10).is_empty());
    }

    #[test]
    fn phrases_find_a_street_address() {
        let text = "Paslaugos vieta: Mindaugo g. 30-49, Vilnius\nSąskaita BV530133";
        assert_eq!(phrases(text, 10), vec![("Mindaugo g. 30-49".to_string(), 1)]);
    }

    #[test]
    fn phrases_find_western_street_shapes() {
        let text = "Ship to 221 Baker Street, London. Or Main St 12B. Rue Lafayette 5";
        let found: Vec<String> = phrases(text, 10).into_iter().map(|(p, _)| p).collect();
        assert_eq!(found, vec!["221 Baker Street", "Main St 12B", "Rue Lafayette 5"]);
    }

    #[test]
    fn phrases_need_a_street_marker_and_a_house_number() {
        assert!(phrases("Mindaugo 30 and page 3 of 5 and Vilnius g. alone", 10).is_empty());
    }

    #[test]
    fn phrases_count_repeats() {
        let text = "Mindaugo g. 30-49\nlater: MINDAUGO G. 30-49";
        assert_eq!(phrases(text, 10), vec![("Mindaugo g. 30-49".to_string(), 2)]);
    }
}
