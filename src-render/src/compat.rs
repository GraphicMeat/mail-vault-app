//! CSS that mail uses and the style system does not parse, rewritten in the HTML text before
//! Blitz parses it (a declaration stylo drops cannot be put back afterwards).
use std::borrow::Cow;

/// `word-break: break-word` is deprecated, but Postmark, Stripe and Mailchimp templates put it on
/// every cell. CSS Text 3 defines it as `word-break: normal` plus `overflow-wrap: anywhere`;
/// stylo's servo build has no `break-word` value for `word-break` and ignores the declaration, so
/// a cell holding a long token kept it unbreakable (min-content as wide as the token) where WebKit
/// lets it break anywhere (the 20% column of a postmark invoice is 47.8px, not the token's
/// 75px). Only declarations inside a tag (a `style` attribute) or a `<style>` element are changed.
pub fn word_break_break_word(html: &str) -> Cow<'_, str> {
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut from = 0;
    while let Some(found) = lower[from..].find("word-break") {
        let start = from + found;
        from = start + "word-break".len();
        let mut i = from;
        let skip_space = |mut i: usize| {
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            i
        };
        i = skip_space(i);
        if bytes.get(i) != Some(&b':') {
            continue;
        }
        i = skip_space(i + 1);
        let value = "break-word";
        if !lower[i..].starts_with(value) {
            continue;
        }
        let end = i + value.len();
        if bytes.get(end).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_') {
            continue;
        }
        if !in_css(&lower, start) {
            continue;
        }
        let out = out.get_or_insert_with(|| String::with_capacity(html.len()));
        out.push_str(&html[copied..start]);
        out.push_str("overflow-wrap:anywhere");
        copied = end;
        from = end;
    }
    match out {
        Some(mut out) => {
            out.push_str(&html[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(html),
    }
}

/// Whether `at` lies inside a tag (an attribute value) or the text of a `<style>` element.
fn in_css(lower: &str, at: usize) -> bool {
    let before = &lower[..at];
    if let Some(open) = before.rfind('<') {
        let tag = &before[open..];
        if !tag.contains('>') && tag[1..].starts_with(|c: char| c.is_ascii_alphabetic()) {
            return true;
        }
    }
    match (before.rfind("<style"), before.rfind("</style")) {
        (Some(open), close) => close.map_or(true, |close| open > close) && before[open..].contains('>'),
        _ => false,
    }
}
