//! JavaScript regular expressions, compiled for the `regex` crate with their
//! JavaScript meaning kept.
//!
//! The tracker table and the scan's own patterns were written for the app's
//! JS, where (without the `u` flag) case folding, `\d`, `\w`, `\s`, `\b` and
//! `.` differ from Rust's Unicode defaults:
//! - `i` folds ASCII only: `ſ` is not `s` and the Kelvin sign is not `k`.
//!   Patterns compile under `(?i-u)`.
//! - `\d` and `\w` are ASCII; `\b` sits between an ASCII word character and
//!   anything else; `\s` is JavaScript's set (U+FEFF in, U+0085 out).
//! - `.` is one UTF-16 code unit other than `\n`, `\r`, U+2028 and U+2029, so
//!   an astral character is two of them. [`js_units`] spells every astral
//!   character as two placeholder characters before a test.
//!
//! What it does not translate (lookaround, backreferences, a negated class
//! with letters in it) it refuses at compile time, so a new pattern of that
//! shape fails the build's tests instead of matching something else.

use regex::Regex;
use std::borrow::Cow;

/// JavaScript's `\s`, as the inside of a character class.
const JS_SPACE: &str = r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
const DOT: &str = r"(?u:[^\n\r\x{2028}\x{2029}])";

/// One placeholder per UTF-16 code unit of an astral character: never a
/// letter, digit, space or line terminator, as a lone surrogate is not.
const UNIT: char = '\u{E000}';

/// `s` as JavaScript's regular expressions see it, one char per code unit.
pub(crate) fn js_units(s: &str) -> Cow<'_, str> {
    if s.chars().all(|c| (c as u32) <= 0xFFFF) {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if (c as u32) > 0xFFFF {
            out.push(UNIT);
            out.push(UNIT);
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

fn class_escape(c: char, out: &mut String) {
    match c {
        'd' => out.push_str("0-9"),
        'w' => out.push_str("0-9A-Za-z_"),
        's' => out.push_str(JS_SPACE),
        '/' => out.push('/'),
        'D' | 'W' | 'S' => panic!("js_regex: \\{c} inside a class is not supported"),
        _ => {
            out.push('\\');
            out.push(c);
        }
    }
}

/// The Rust spelling of a JavaScript pattern's source (no flags).
pub(crate) fn translate(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len() + 16);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                let e = *chars.get(i + 1).expect("js_regex: trailing backslash");
                i += 1;
                match e {
                    'd' => out.push_str("[0-9]"),
                    'D' => out.push_str("(?u:[^0-9])"),
                    'w' => out.push_str("[0-9A-Za-z_]"),
                    'W' => out.push_str("(?u:[^0-9A-Za-z_])"),
                    's' => {
                        out.push_str("(?u:[");
                        out.push_str(JS_SPACE);
                        out.push_str("])");
                    }
                    'S' => {
                        out.push_str("(?u:[^");
                        out.push_str(JS_SPACE);
                        out.push_str("])");
                    }
                    'b' => out.push_str(r"\b"),
                    'B' => out.push_str(r"\B"),
                    '/' => out.push('/'),
                    '1'..='9' => panic!("js_regex: backreferences are not supported"),
                    _ => {
                        out.push('\\');
                        out.push(e);
                    }
                }
            }
            '.' => out.push_str(DOT),
            '[' => {
                i += 1;
                let negated = chars.get(i) == Some(&'^');
                if negated {
                    i += 1;
                }
                let mut inner = String::new();
                let mut letters = false;
                let mut first = true;
                loop {
                    let c = *chars.get(i).expect("js_regex: unclosed class");
                    if c == ']' && !first {
                        break;
                    }
                    first = false;
                    match c {
                        '\\' => {
                            i += 1;
                            let e = *chars.get(i).expect("js_regex: trailing backslash");
                            letters |= e == 'w';
                            class_escape(e, &mut inner);
                        }
                        '[' | '&' | '~' => {
                            inner.push('\\');
                            inner.push(c);
                        }
                        _ => {
                            letters |= c.is_ascii_alphabetic();
                            inner.push(c);
                        }
                    }
                    i += 1;
                }
                if negated {
                    assert!(!letters, "js_regex: a negated class with letters folds differently in Rust");
                    out.push_str("(?u:[^");
                    out.push_str(&inner);
                    out.push_str("])");
                } else if inner.contains(r"\x") {
                    out.push_str("(?u:[");
                    out.push_str(&inner);
                    out.push_str("])");
                } else {
                    out.push('[');
                    out.push_str(&inner);
                    out.push(']');
                }
            }
            '(' if chars.get(i + 1) == Some(&'?') => {
                match chars.get(i + 2) {
                    Some(':') => out.push_str("(?:"),
                    _ => panic!("js_regex: lookaround and named groups are not supported"),
                }
                i += 2;
            }
            _ => {
                assert!(c.is_ascii(), "js_regex: a literal non-ASCII character folds differently in Rust");
                out.push(c);
            }
        }
        i += 1;
    }
    out
}

/// A JavaScript pattern with the `i` flag.
pub(crate) fn compile_i(src: &str) -> Regex {
    let rust = format!("(?i-u:{})", translate(src));
    Regex::new(&rust).unwrap_or_else(|e| panic!("js_regex: {src:?} -> {rust:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test(src: &str, s: &str) -> bool {
        compile_i(src).is_match(&js_units(s))
    }

    #[test]
    fn case_folding_is_ascii() {
        assert!(test(r"substack\.com", "SUBSTACK.COM"));
        assert!(!test(r"substack\.com", "\u{17F}ubstack.com"));
        assert!(!test(r"klaviyo", "\u{212A}laviyo"));
    }

    #[test]
    fn classes_are_ascii_and_javascripts() {
        assert!(!test(r"a\d", "a\u{661}"));
        assert!(!test(r"a\w", "a\u{e9}"));
        assert!(test(r"tr\b", "tr\u{e4}"));
        assert!(!test(r"tr\b", "tr_"));
        assert!(test(r"a\sb", "a\u{FEFF}b"));
        assert!(!test(r"a\sb", "a\u{85}b"));
        assert!(test(r"[a-z0-9-]+\.x", "A-1.X"));
    }

    #[test]
    fn dot_is_one_utf16_unit_and_no_line_terminator() {
        assert!(test("a.b", "axb"));
        assert!(test("a.b", "a\u{e9}b"));
        assert!(!test("a.b", "a\u{1F600}b"));
        assert!(test("a..b", "a\u{1F600}b"));
        for t in ["\n", "\r", "\u{2028}", "\u{2029}"] {
            assert!(!test("a.b", &format!("a{t}b")), "{t:?}");
        }
    }

    #[test]
    fn negated_classes_take_any_character() {
        assert!(test("a[^;]+b", "a\u{1F600}\u{e9}b"));
        assert!(!test("a[^;]+b", "a;b"));
    }
}
