//! A one-time code sent by mail, read out of the subject and body text so the
//! corner bubble can offer to copy it. Picking a wrong number is worse than
//! picking none (the user pastes it somewhere that counts attempts), so a
//! number is a code only when the mail talks about codes, the number sits near
//! those words, and nothing around it says order, phone, money, date or link.
//!
//! Ported from the app's `verificationCode.js`, answer for answer:
//! `tests/fixtures/verification-code-cases.json` holds what that code
//! answered. Its distances (200 to the code words, 40 looked at before a
//! number, 12 after) were counted in UTF-16 code units, and its `\b`, `\w`
//! and `\d` were ASCII, so both are kept that way here.

use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

use crate::sender_check::js_space;

/// Words that say the mail carries a code, in the app's languages. Stems, so
/// "verification", "verify" and "verified" all count.
static KEYWORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?-u:\b)(?:codes?|otp|passcode|pin|2fa|mfa|one[- ]?time|verif[0-9A-Za-z_]*|authenticat[0-9A-Za-z_]*|security|token|confirm[0-9A-Za-z_]*|sign[- ]?in|log[- ]?in)(?-u:\b)",
        r"|c[oó]digo|verificaci[oó]n|codice|verifica|best[äa]tigung|sicherheits|verifizier|einmal|v[ée]rification|s[ée]curit[ée]",
        r"|認証|確認コード|検証|ワンタイム|인증|확인 코드|验证码|驗證碼|校验码",
    ))
    .unwrap()
});

/// A number right after one of these is something else with a number.
static NOT_A_CODE_BEFORE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)(?:promo|discount|coupon|voucher|referral|order|invoice|tracking|ticket|booking|reference|ref|account|customer|phone|tel|call|fax|zip|postal)(?-u:\b)[^0-9A-Za-z_]*(?:code|no|number|nr|id)?[^0-9A-Za-z_]*$").unwrap()
});

/// A unit or a percent sign after the number makes it a quantity.
static UNIT_AFTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]*(?:%|min(?:ute)?s?|sec(?:ond)?s?|h(?:ou)?rs?|days?|px|[kmg]b)(?-u:\b)").unwrap()
});

/// Money, a link, a tag or an email address right before the number.
const SIGN_BEFORE: &[char] = &['#', '$', '€', '£', '¥', '+', '/', '=', '@'];
/// What may not lead a candidate (besides an ASCII word character).
const NOT_A_LEAD: &[char] = &['#', '$', '€', '£', '¥', '+', '/', '=', '.', '@'];

/// The farthest a code may sit from the words that announce it.
const NEAR: usize = 200;
const LOOK_BEFORE: usize = 40;
const LOOK_AFTER: usize = 12;

/// ZWSP, ZWNJ, ZWJ, WORD JOINER, BOM, SOFT HYPHEN.
const INVISIBLE: &[char] = &['\u{200B}', '\u{200C}', '\u{200D}', '\u{2060}', '\u{FEFF}', '\u{AD}'];

fn clean(s: &str) -> String {
    s.nfkc().filter(|c| !INVISIBLE.contains(c)).collect()
}

fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The text the detector reads, by char, with each char's UTF-16 offset.
struct Text {
    joined: String,
    chars: Vec<char>,
    /// UTF-16 offset of each char, and the total length last.
    at16: Vec<usize>,
    /// Char index of each byte offset that starts a char (and of the end).
    char_of_byte: Vec<usize>,
}

impl Text {
    fn new(subject: &str, text: &str) -> Text {
        let joined = format!("{}\n{}", clean(subject), clean(text));
        let chars: Vec<char> = joined.chars().collect();
        let mut at16 = Vec::with_capacity(chars.len() + 1);
        let mut char_of_byte = vec![0; joined.len() + 1];
        let (mut u16s, mut bytes) = (0, 0);
        for (i, c) in chars.iter().enumerate() {
            at16.push(u16s);
            char_of_byte[bytes] = i;
            u16s += c.len_utf16();
            bytes += c.len_utf8();
        }
        at16.push(u16s);
        char_of_byte[bytes] = chars.len();
        Text { joined, chars, at16, char_of_byte }
    }

    /// Keyword spans, in UTF-16 offsets.
    fn keyword_spans(&self) -> Vec<(usize, usize)> {
        KEYWORDS
            .find_iter(&self.joined)
            .map(|m| (self.at16[self.char_of_byte[m.start()]], self.at16[self.char_of_byte[m.end()]]))
            .collect()
    }

    /// The chars whose UTF-16 offset falls in `[from, to)`.
    fn slice16(&self, from: usize, to: usize) -> String {
        let lo = self.at16.partition_point(|&p| p < from);
        let hi = self.at16[..self.chars.len()].partition_point(|&p| p < to);
        self.chars[lo..hi.max(lo)].iter().collect()
    }

    fn digits(&self, at: usize) -> usize {
        self.chars[at..].iter().take_while(|c| c.is_ascii_digit()).count()
    }

    /// Nothing that continues the token may follow: no word char, no `%`,
    /// and no space or dash leading into another digit.
    fn ends_clean(&self, end: usize) -> bool {
        match self.chars.get(end) {
            None => true,
            Some(&c) if word(c) || c == '%' => false,
            Some(' ' | '-') => !self.chars.get(end + 1).is_some_and(char::is_ascii_digit),
            Some(_) => true,
        }
    }

    /// The candidate starting at `s`, as an end offset: six digits in two
    /// groups, four to eight digits, or six to eight capitals and digits with
    /// at least one of each among the first eight.
    fn candidate_at(&self, s: usize) -> Option<usize> {
        let c = &self.chars;
        let digit = |i: usize| c.get(i).is_some_and(char::is_ascii_digit);
        if (0..3).all(|k| digit(s + k)) && matches!(c.get(s + 3), Some(' ' | '-')) && (4..7).all(|k| digit(s + k)) && self.ends_clean(s + 7) {
            return Some(s + 7);
        }
        let run = self.digits(s).min(8);
        if let Some(len) = (4..=run).rev().find(|&len| self.ends_clean(s + len)) {
            return Some(s + len);
        }
        let caps = c[s..].iter().take_while(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit()).count();
        let head = &c[s..s + caps.min(8)];
        if head.iter().any(char::is_ascii_digit) && head.iter().any(char::is_ascii_uppercase) {
            if let Some(len) = (6..=caps.min(8)).rev().find(|&len| self.ends_clean(s + len)) {
                return Some(s + len);
            }
        }
        None
    }
}

/// True when the mail talks about a code at all, whether or not one is in the text.
pub fn looks_like_code_mail(subject: &str, text: &str) -> bool {
    KEYWORDS.is_match(&format!("{}\n{}", clean(subject), clean(text)))
}

/// The code in the mail, as the user would type it.
pub fn find_verification_code(subject: &str, text: &str) -> Option<String> {
    let t = Text::new(subject, text);
    let spans = t.keyword_spans();
    if spans.is_empty() {
        return None;
    }
    let mut best: Option<(usize, String)> = None;
    // Candidates are taken left to right without overlap, each led by the
    // start of the text or by one char that is not a word char or a sign.
    let mut s = 0;
    let mut free_from = 0;
    while s < t.chars.len() {
        let led = s == 0 || (s > free_from && !word(t.chars[s - 1]) && !NOT_A_LEAD.contains(&t.chars[s - 1]));
        let Some(e) = led.then(|| t.candidate_at(s)).flatten() else {
            s += 1;
            continue;
        };
        free_from = e;
        let raw: String = t.chars[s..e].iter().collect();
        let (start, end) = (t.at16[s], t.at16[e]);
        s = e + 1;

        let before = t.slice16(start.saturating_sub(LOOK_BEFORE), start);
        let after = t.slice16(end, end + LOOK_AFTER);
        let mut tail = before.chars().rev();
        if matches!((tail.next(), tail.next()), (Some(' ' | '-'), Some(d)) if d.is_ascii_digit()) {
            continue;
        }
        if before.trim_end_matches(js_space).ends_with(SIGN_BEFORE) {
            continue;
        }
        if NOT_A_CODE_BEFORE.is_match(&before) || UNIT_AFTER.is_match(&after) {
            continue;
        }
        if raw.len() == 4 && (raw.starts_with("19") || raw.starts_with("20")) && raw.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let gap = spans
            .iter()
            .map(|&(a, b)| if a >= end { a - end } else if start >= b { start - b } else { 0 })
            .min()
            .unwrap_or(usize::MAX);
        if gap > NEAR || best.as_ref().is_some_and(|(g, _)| *g <= gap) {
            continue;
        }
        let code = if raw.starts_with(|c: char| c.is_ascii_digit()) { raw.replace([' ', '-'], "") } else { raw };
        best = Some((gap, code));
    }
    best.map(|(_, code)| code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const FIXTURE: &str = include_str!("../tests/fixtures/verification-code-cases.json");

    /// A field as the JS `String(x ?? '')` read it.
    fn field(input: &Value, name: &str) -> String {
        match &input[name] {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }

    /// Every case the JS answered, answered the same.
    #[test]
    fn matches_every_case_the_js_answered() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let mut wrong = Vec::new();
        let codes = fixture["codes"].as_array().unwrap();
        assert!(codes.len() > 90);
        for case in codes {
            let got = find_verification_code(&field(&case["input"], "subject"), &field(&case["input"], "text"));
            if Value::from(got.clone()) != case["expected"] {
                wrong.push(format!("{}: got {got:?}, want {}", case["name"], case["expected"]));
            }
        }
        for case in fixture["looks"].as_array().unwrap() {
            let got = looks_like_code_mail(&field(&case["input"], "subject"), &field(&case["input"], "text"));
            if Value::from(got) != case["expected"] {
                wrong.push(format!("looks {}: got {got}, want {}", case["name"], case["expected"]));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn distances_are_utf16_units() {
        // 98 emoji are 196 units: the code sits 197 away and is near; 101 are 202.
        let near = format!("{} 615243", "\u{1F600}".repeat(98));
        let far = format!("{} 615243", "\u{1F600}".repeat(101));
        assert_eq!(find_verification_code("Your code", &near).as_deref(), Some("615243"));
        assert_eq!(find_verification_code("Your code", &far), None);
    }
}
