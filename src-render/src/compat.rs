//! CSS that mail uses and the style system does not parse, rewritten in the HTML text before
//! Blitz parses it (a declaration stylo drops cannot be put back afterwards).
use std::borrow::Cow;

/// `word-break: break-word` is deprecated, but Postmark, Stripe and Mailchimp templates put it on
/// every cell. CSS Text 3 defines it as `word-break: normal` plus `overflow-wrap: anywhere`;
/// stylo's servo build has no `break-word` value for `word-break` and ignores the declaration, so
/// a cell holding a long token kept it unbreakable (min-content as wide as the token) where WebKit
/// lets it break anywhere (the 20% column of a postmark invoice is 47.8px, not the token's
/// 75px). Only CSS is changed: `style` attribute values and the text of `<style>` elements, found
/// in one forward pass over the markup (`css_ranges`), so the cost is linear in the mail's size.
pub fn word_break_break_word(html: &str) -> Cow<'_, str> {
    let lower = html.to_ascii_lowercase();
    if !lower.contains("word-break") {
        return Cow::Borrowed(html);
    }
    let bytes = lower.as_bytes();
    let mut out: Option<String> = None;
    let mut copied = 0;
    for (lo, hi) in css_ranges(bytes) {
        let mut from = lo;
        while let Some(found) = lower[from..hi].find("word-break") {
            let start = from + found;
            from = start + "word-break".len();
            let skip_space = |mut i: usize| {
                while i < hi && bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                i
            };
            let mut i = skip_space(from);
            if i >= hi || bytes[i] != b':' {
                continue;
            }
            i = skip_space(i + 1);
            let value = "break-word";
            if !lower[i..hi].starts_with(value) {
                continue;
            }
            let end = i + value.len();
            if end < hi && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-' || bytes[end] == b'_') {
                continue;
            }
            let out = out.get_or_insert_with(|| String::with_capacity(html.len()));
            out.push_str(&html[copied..start]);
            out.push_str("overflow-wrap:anywhere");
            copied = end;
            from = end;
        }
    }
    match out {
        Some(mut out) => {
            out.push_str(&html[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(html),
    }
}

/// Elements whose text the HTML tokenizer reads raw, up to their own end tag (RAWTEXT and
/// RCDATA; `<style>` is handled apart). Markup inside them is not markup.
const RAW_TEXT: &[&[u8]] = &[b"script", b"textarea", b"title", b"xmp", b"iframe", b"noembed", b"noframes", b"noscript"];

/// Byte ranges of `lower` (the markup, ASCII-lowercased) that hold CSS: the value of every
/// `style` attribute and the text of every `<style>` element, in order. One forward pass, the
/// way the HTML tokenizer reads tags, attributes, comments and raw text.
fn css_ranges(lower: &[u8]) -> Vec<(usize, usize)> {
    let n = lower.len();
    let find = |from: usize, needle: &[u8]| -> Option<usize> {
        lower.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|p| p + from)
    };
    let name_end = |mut i: usize| {
        while i < n && !lower[i].is_ascii_whitespace() && !matches!(lower[i], b'/' | b'>' | b'=') {
            i += 1;
        }
        i
    };
    let skip_ws = |mut i: usize| {
        while i < n && lower[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    };
    let mut ranges = Vec::new();
    let mut i = 0;
    while let Some(lt) = lower[i..].iter().position(|&b| b == b'<').map(|p| p + i) {
        i = lt + 1;
        if lower[i..].starts_with(b"!--") {
            // A comment runs to `-->` (or the end of the input).
            i = find(i + 3, b"-->").map_or(n, |e| e + 3);
            continue;
        }
        if i < n && matches!(lower[i], b'!' | b'?' | b'/') {
            // Doctype, processing instruction (a bogus comment) or end tag: up to the next `>`.
            i = lower[i..].iter().position(|&b| b == b'>').map_or(n, |p| i + p + 1);
            continue;
        }
        if i >= n || !lower[i].is_ascii_alphabetic() {
            continue;
        }
        // A start tag: its name, then attributes up to `>`.
        let name_start = i;
        i = name_end(i);
        let tag = &lower[name_start..i];
        loop {
            i = skip_ws(i);
            if i >= n {
                break;
            }
            if lower[i] == b'>' {
                i += 1;
                break;
            }
            if lower[i] == b'/' {
                i += 1;
                continue;
            }
            let attr_start = i;
            // An attribute name may start with `=` (the tokenizer keeps it in the name).
            i = name_end(i + 1);
            let attr = &lower[attr_start..i];
            i = skip_ws(i);
            if i >= n || lower[i] != b'=' {
                continue;
            }
            i = skip_ws(i + 1);
            let (value_start, value_end) = match lower.get(i) {
                Some(&q @ (b'"' | b'\'')) => {
                    let end = lower[i + 1..].iter().position(|&b| b == q).map_or(n, |p| i + 1 + p);
                    let range = (i + 1, end);
                    i = (end + 1).min(n);
                    range
                }
                _ => {
                    let start = i;
                    while i < n && !lower[i].is_ascii_whitespace() && lower[i] != b'>' {
                        i += 1;
                    }
                    (start, i)
                }
            };
            if attr == b"style" {
                ranges.push((value_start, value_end));
            }
        }
        if tag == b"style" || RAW_TEXT.contains(&tag) {
            // The element's text runs to its end tag.
            let mut close = Vec::with_capacity(tag.len() + 2);
            close.extend_from_slice(b"</");
            close.extend_from_slice(tag);
            let end = find(i, &close).unwrap_or(n);
            if tag == b"style" {
                ranges.push((i, end));
            }
            i = end;
        }
    }
    ranges
}
