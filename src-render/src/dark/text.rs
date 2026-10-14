// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/utils/text.ts, src/utils/css-text/parse-gradient.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use fancy_regex::Regex;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

/// `getMatches(regex, input, group)`: every match's `group`, in order.
/// (DR's loop needs a global regex; `captures_iter` walks the same matches.)
/// None when the regex gives up (fancy-regex's backtrack limit, which JS regexes do not
/// have): its iterator does not advance past an error, so retrying would loop forever, and a
/// partial list would rewrite only part of the value. The caller leaves the value alone.
pub fn get_matches(re: &Regex, input: &str, group: usize) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for caps in re.captures_iter(input) {
        let caps = caps.ok()?;
        // A group that did not take part is `undefined` in JS and ends up as a hole.
        out.push(caps.get(group).map_or(String::new(), |m| m.as_str().to_string()));
    }
    Some(out)
}

pub fn get_parentheses_range(input: &str, search_start: usize) -> Option<TextRange> {
    get_open_close_range(input, search_start, "(", ")", &[])
}

/// `indexOf(token, pos)` as a byte offset; `None` is JS's -1.
fn index_of(input: &str, token: &str, pos: usize) -> Option<usize> {
    input.get(pos..)?.find(token).map(|i| i + pos)
}

/// `indexOfExcluding`: skips matches inside an excluded range, restarting at its end.
fn index_of_excluding(input: &str, search: &str, position: usize, exclude: &[TextRange]) -> Option<usize> {
    let i = index_of(input, search, position)?;
    if let Some(r) = exclude.iter().find(|r| i >= r.start && i < r.end) {
        return index_of_excluding(input, search, r.end, exclude);
    }
    Some(i)
}

pub fn get_open_close_range(input: &str, search_start: usize, open: &str, close: &str, exclude: &[TextRange]) -> Option<TextRange> {
    let index_of_tok = |token: &str, pos: usize| -> Option<usize> {
        if exclude.is_empty() {
            index_of(input, token, pos)
        } else {
            index_of_excluding(input, token, pos, exclude)
        }
    };
    let length = input.len();
    let mut depth = 0usize;
    let mut first_open: usize = 0;
    let mut i = search_start;
    while i < length {
        if depth == 0 {
            let Some(open_index) = index_of_tok(open, i) else { break };
            first_open = open_index;
            depth += 1;
            i = open_index;
        } else {
            let Some(close_index) = index_of_tok(close, i) else { break };
            match index_of_tok(open, i) {
                Some(open_index) if close_index > open_index => {
                    depth += 1;
                    i = open_index;
                }
                _ => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(TextRange { start: first_open, end: close_index + 1 });
                    }
                    i = close_index;
                }
            }
        }
        i += 1;
    }
    None
}

/// `splitExcluding`: split at every `separator` outside the excluded ranges, trimmed.
pub fn split_excluding(input: &str, separator: &str, exclude: &[TextRange]) -> Vec<String> {
    let mut parts = Vec::new();
    let mut curr = 0usize;
    while let Some(comma) = index_of_excluding(input, separator, curr, exclude) {
        parts.push(input.get(curr..comma).unwrap_or("").trim().to_string());
        curr = comma + 1;
    }
    parts.push(input.get(curr..).unwrap_or("").trim().to_string());
    parts
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedGradient {
    pub type_gradient: String,
    pub matched: String,
    pub has_comma: bool,
    pub index: usize,
    pub offset: usize,
}

/// JS `String.prototype.slice`: a negative index counts from the end.
fn js_slice(s: &str, start: isize, end: isize) -> &str {
    let len = s.len() as isize;
    let norm = |i: isize| if i < 0 { (len + i).max(0) } else { i.min(len) } as usize;
    let (a, b) = (norm(start), norm(end));
    if a >= b {
        return "";
    }
    s.get(a..b).unwrap_or("")
}

const CONIC: &str = "conic-";
const RADIAL: &str = "radial-";
const LINEAR: &str = "linear-";
const GRADIENT_LEN: usize = "gradient".len();

pub fn parse_gradient(value: &str) -> Vec<ParsedGradient> {
    let mut result: Vec<ParsedGradient> = Vec::new();
    let mut start_index = CONIC.len();
    while let Some(index) = index_of(value, "gradient", start_index) {
        let mut type_gradient: Option<String> = None;
        for possible in [LINEAR, RADIAL, CONIC] {
            let n = possible.len();
            if index >= n && value.get(index - n..index) == Some(possible) {
                let before = index as isize - n as isize;
                type_gradient = Some(if js_slice(value, before - 10, before - 1) == "repeating" {
                    format!("repeating-{possible}gradient")
                } else if js_slice(value, before - 8, before - 1) == "-webkit" {
                    format!("-webkit-{possible}gradient")
                } else {
                    format!("{possible}gradient")
                });
                break;
            }
        }
        let Some(type_gradient) = type_gradient else { break };
        // DR destructures the range, so an unclosed gradient throws there; stop here.
        let Some(TextRange { start, end }) = get_parentheses_range(value, index + GRADIENT_LEN) else { break };
        let matched = value.get(start + 1..end - 1).unwrap_or("").to_string();
        start_index = end + 1 + CONIC.len();
        let idx = (index as isize - type_gradient.len() as isize + GRADIENT_LEN as isize).max(0) as usize;
        let offset = type_gradient.len() + 2;
        result.push(ParsedGradient { type_gradient, matched, offset, index: idx, has_comma: true });
    }
    if let Some(last) = result.last_mut() {
        last.has_comma = false;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parentheses_range_nests() {
        assert_eq!(get_parentheses_range("a(b(c)d)e", 0), Some(TextRange { start: 1, end: 8 }));
        assert_eq!(get_parentheses_range("no parens", 0), None);
        assert_eq!(get_parentheses_range("a(b", 0), None);
    }

    #[test]
    fn split_skips_excluded_ranges() {
        let s = "a, b(c, d), e";
        let r = get_parentheses_range(s, 0).unwrap();
        assert_eq!(split_excluding(s, ",", &[r]), vec!["a", "b(c, d)", "e"]);
    }

    #[test]
    fn repeating_gradient() {
        let g = parse_gradient("repeating-linear-gradient(red, blue 10px)");
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].type_gradient, "repeating-linear-gradient");
        assert_eq!(g[0].matched, "red, blue 10px");
        assert_eq!(g[0].offset, "repeating-linear-gradient".len() + 2);
        assert_eq!(g[0].index, 0);
        assert!(!g[0].has_comma);
    }

    #[test]
    fn webkit_gradient() {
        let g = parse_gradient("-webkit-linear-gradient(top, #fff, #000)");
        assert_eq!(g[0].type_gradient, "-webkit-linear-gradient");
        assert_eq!(g[0].matched, "top, #fff, #000");
    }

    #[test]
    fn two_gradients_mark_the_comma() {
        let g = parse_gradient("linear-gradient(red, blue), radial-gradient(green, black)");
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].type_gradient, "linear-gradient");
        assert!(g[0].has_comma);
        assert_eq!(g[1].type_gradient, "radial-gradient");
        assert!(!g[1].has_comma);
        assert_eq!(g[1].matched, "green, black");
    }

    #[test]
    fn no_gradient() {
        assert!(parse_gradient("url(x.png)").is_empty());
    }

    #[test]
    fn js_slice_counts_negatives_from_the_end() {
        assert_eq!(js_slice("abcdef", -3, -1), "de");
        assert_eq!(js_slice("abc", -10, 2), "ab");
        assert_eq!(js_slice("abc", 2, 1), "");
    }
}
