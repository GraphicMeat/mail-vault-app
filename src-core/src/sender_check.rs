//! Sender verification: the reader's shield and its sender-details popover.
//! Spoofing signs read off a message's own headers (a display name that is
//! another address or another domain, a Reply-To or Return-Path on another
//! domain) and the receiving server's SPF/DKIM/DMARC verdicts in
//! Authentication-Results, plus what the message says about its DKIM
//! signature (algorithm, domain, selector).
//!
//! Ported from the app's `senderCheck.js`, answer for answer:
//! `tests/fixtures/sender-check-cases.json` holds what that code answered.
//! Text is not built here: an issue carries its catalog key and the values
//! the app's `t()` fills in, so the UI words it in the user's language.
//!
//! The JS regular expressions were ASCII-only (`\b`, `\w`, case folding) and
//! used JavaScript's own whitespace set, so every pattern here spells that out
//! rather than taking Rust's Unicode defaults.

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

/// SPF, DKIM and DMARC as the receiving server reported them, `None` when it
/// named no result for that method.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AuthResults {
    pub spf: Option<String>,
    pub dkim: Option<String>,
    pub dmarc: Option<String>,
}

impl AuthResults {
    pub fn any(&self) -> bool {
        self.spf.is_some() || self.dkim.is_some() || self.dmarc.is_some()
    }
}

/// What the message says about its DKIM signature.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DkimSignature {
    pub algorithm: Option<String>,
    pub domain: Option<String>,
    pub selector: Option<String>,
}

/// One line for the app to word: a catalog key and the values it takes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Line {
    pub key: &'static str,
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    /// `danger`, `warning` or `info`.
    pub level: &'static str,
    pub key: &'static str,
    pub params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// The verdict on a message's sender.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Verdict {
    /// `verified`, `warning`, `danger` or `none`.
    pub status: &'static str,
    /// The shield's tooltip, one line each.
    pub tooltip: Vec<Line>,
    /// Every issue found, `info` ones included; empty for `verified` and `none`.
    pub issues: Vec<Issue>,
    pub auth: AuthResults,
    pub dkim: Option<DkimSignature>,
}

const KEY_DISPLAY_NAME_IS_ADDRESS: &str = "util.senderCheck.displayNameShowsButActual";
const KEY_DISPLAY_NAME_IS_DOMAIN: &str = "util.senderCheck.senderNameImpersonatesDomainDiffers";
const KEY_REPLY_TO: &str = "util.senderCheck.replyAddressDiffersSender";
const KEY_RETURN_PATH: &str = "util.senderCheck.returnPathDomainDiffersSender";
const KEY_AUTH_FAILED: &str = "util.senderCheck.senderAuthenticationFailedEmailMay";
const KEY_VERIFIED: &str = "util.senderCheck.senderVerifiedSpfDkimPass";

/// JavaScript's `\s` (WhiteSpace plus LineTerminator): not Rust's
/// `char::is_whitespace`, which adds U+0085 and leaves out U+FEFF.
pub(crate) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn text(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// A non-empty string, as a JS truthiness test reads one.
fn truthy(v: Option<&Value>) -> Option<&str> {
    text(v).filter(|s| !s.is_empty())
}

/// The part after the first `@`, lowercased and trimmed; empty when there is none.
fn domain_of(address: &str) -> String {
    js_trim(&address.split('@').nth(1).unwrap_or("").to_lowercase()).to_string()
}

static SPF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\bspf=(pass|fail|softfail|neutral|none|temperror|permerror)\b").unwrap());
static DKIM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\bdkim=(pass|fail|none|neutral|temperror|permerror)\b").unwrap());
static DMARC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)\bdmarc=(pass|fail|none|bestguesspass)\b").unwrap());

/// The first SPF, DKIM and DMARC result each in an Authentication-Results value.
pub fn parse_auth_results(header: &str) -> AuthResults {
    let first = |re: &Regex| re.captures(header).map(|c| c[1].to_ascii_lowercase());
    AuthResults { spf: first(&SPF), dkim: first(&DKIM), dmarc: first(&DMARC) }
}

static HEADER_A: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u)\bheader\.a=([A-Za-z0-9-]+)").unwrap());
static HEADER_D: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u)\bheader\.d=([A-Za-z0-9.-]+)").unwrap());
static HEADER_S: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u)\bheader\.s=([A-Za-z0-9._-]+)").unwrap());

fn token_ok(v: &str, extra: &[char]) -> bool {
    !v.is_empty() && v.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || extra.contains(&c))
}

/// The signature's algorithm, domain and selector, tag by tag from the
/// `a=; d=; s=` summary the daemon keeps of the DKIM-Signature header (the
/// last of a repeated tag wins), else from `header.a/d/s=` in
/// Authentication-Results. `None` when neither names any of them. The key's
/// size is not here: it is in DNS (`dkim_key`).
pub fn parse_dkim_signature(dkim_signature: &str, auth: &str) -> Option<DkimSignature> {
    let mut summary: Vec<(String, String)> = Vec::new();
    for part in dkim_signature.split(';') {
        let mut pieces = part.split('=');
        let name = js_trim(pieces.next().unwrap_or("")).to_lowercase();
        let value = js_trim(&pieces.collect::<Vec<_>>().join("=")).to_lowercase();
        summary.retain(|(n, _)| *n != name);
        summary.push((name, value));
    }
    let own = |tag: &str| summary.iter().find(|(n, _)| n == tag).map(|(_, v)| v.as_str());
    let pick = |tag: &str, extra: &[char], fallback: &Regex| -> Option<String> {
        match own(tag) {
            Some(v) if token_ok(v, extra) => Some(v.to_string()),
            _ => fallback.captures(auth).map(|c| c[1].to_lowercase()).filter(|v| !v.is_empty()),
        }
    };
    let out = DkimSignature {
        algorithm: pick("a", &[], &HEADER_A),
        domain: pick("d", &['.'], &HEADER_D),
        selector: pick("s", &['.', '_'], &HEADER_S),
    };
    (out.algorithm.is_some() || out.domain.is_some() || out.selector.is_some()).then_some(out)
}

/// `^[^\s@]+@[^\s@]+\.[^\s@]+$`: one `@`, no whitespace, and a dot with
/// something on both sides after it.
fn looks_like_address(s: &str) -> bool {
    if s.chars().any(js_space) {
        return false;
    }
    let mut parts = s.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let chars: Vec<char> = domain.chars().collect();
    !local.is_empty() && (1..chars.len().saturating_sub(1)).any(|i| chars[i] == '.')
}

/// `^[a-z0-9.-]+\.[a-z]{2,}$`, ASCII and case-blind.
fn looks_like_domain(s: &str) -> bool {
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return false;
    }
    match s.rfind('.') {
        Some(dot) if dot >= 1 => {
            let tld = &s[dot + 1..];
            tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())
        }
        _ => false,
    }
}

/// The display name as it is quoted: outer quotes and backslashes off, `\"` unescaped, trimmed.
fn clean_name(name: &str) -> String {
    let stripped = name.trim_start_matches(['"', '\\']).trim_end_matches(['"', '\\']);
    js_trim(&stripped.replace("\\\"", "\"")).to_string()
}

/// The Reply-To address: the first of a list, the address of one, or a bare string.
fn reply_to_address(reply_to: Option<&Value>) -> Option<String> {
    match reply_to? {
        Value::Array(list) => truthy(list.first().and_then(|r| r.get("address"))).map(str::to_string),
        Value::String(s) => (!s.is_empty()).then(|| s.clone()),
        Value::Object(o) => truthy(o.get("address")).map(str::to_string),
        _ => None,
    }
}

fn params(pairs: &[(&str, Option<&str>)]) -> Value {
    let mut map = Map::new();
    for (k, v) in pairs {
        if let Some(v) = v {
            map.insert((*k).to_string(), Value::String((*v).to_string()));
        }
    }
    Value::Object(map)
}

/// The verdict on a message: `message` is the header object the app holds
/// (`from {name, address}`, `replyTo`, `returnPath`, `authenticationResults`,
/// `dkimSignature`).
pub fn verify_sender(message: &Value) -> Verdict {
    let auth_header = text(message.get("authenticationResults")).unwrap_or("");
    let auth = parse_auth_results(auth_header);
    let dkim = parse_dkim_signature(text(message.get("dkimSignature")).unwrap_or(""), auth_header);
    let none = |auth: AuthResults, dkim| Verdict { status: "none", tooltip: vec![], issues: vec![], auth, dkim };

    let from = match message.get("from") {
        Some(f) if !f.is_null() && f != &Value::Bool(false) && f.as_str() != Some("") => f,
        _ => return none(auth, dkim),
    };
    let raw_address = text(from.get("address"));
    let from_address = js_trim(&raw_address.unwrap_or("").to_lowercase()).to_string();
    let from_domain = domain_of(&from_address);
    let mut issues: Vec<Issue> = Vec::new();

    // Layer 0: a display name that is another address, or another domain.
    let from_name = clean_name(text(from.get("name")).unwrap_or(""));
    let from_name_lower = from_name.to_lowercase();
    if !from_name.is_empty() {
        let name_is_address = looks_like_address(&from_name);
        if name_is_address && from_name_lower != from_address {
            let name_domain = domain_of(&from_name_lower);
            // A subdomain either way is the same sender.
            let related = name_domain == from_domain
                || from_domain.ends_with(&format!(".{name_domain}"))
                || name_domain.ends_with(&format!(".{from_domain}"));
            if !related {
                issues.push(Issue {
                    level: "danger",
                    key: KEY_DISPLAY_NAME_IS_ADDRESS,
                    params: params(&[("fromName", Some(&from_name)), ("email", raw_address)]),
                    details: Some(params(&[
                        ("displayName", Some(&from_name)),
                        ("actualAddress", raw_address),
                        ("displayDomain", Some(&name_domain)),
                        ("actualDomain", Some(&from_domain)),
                    ])),
                });
            }
        }
        if !name_is_address && looks_like_domain(&from_name_lower) && from_name_lower != from_domain {
            let related = from_domain.ends_with(&format!(".{from_name_lower}")) || from_name_lower.ends_with(&format!(".{from_domain}"));
            if !related {
                issues.push(Issue {
                    level: "warning",
                    key: KEY_DISPLAY_NAME_IS_DOMAIN,
                    params: params(&[("fromName", Some(&from_name)), ("fromDomain", Some(&from_domain))]),
                    details: Some(params(&[("displayName", Some(&from_name)), ("actualDomain", Some(&from_domain))])),
                });
            }
        }
    }

    // Layer 1: headers that point somewhere else.
    if let Some(reply_to) = reply_to_address(message.get("replyTo")) {
        let reply_domain = domain_of(&reply_to);
        if !reply_domain.is_empty() && reply_domain != from_domain {
            issues.push(Issue { level: "warning", key: KEY_REPLY_TO, params: params(&[("replyToAddr", Some(&reply_to))]), details: None });
        }
    }
    if let Some(return_path) = truthy(message.get("returnPath")) {
        let return_domain = domain_of(return_path);
        if !return_domain.is_empty() && return_domain != from_domain {
            issues.push(Issue { level: "info", key: KEY_RETURN_PATH, params: params(&[("returnPathDomain", Some(&return_domain))]), details: None });
        }
    }

    // Layer 2: the receiving server's verdicts.
    if auth.any() {
        let mut failures = Vec::new();
        if matches!(auth.spf.as_deref(), Some("fail" | "softfail")) {
            failures.push("SPF");
        }
        if auth.dkim.as_deref() == Some("fail") {
            failures.push("DKIM");
        }
        if auth.dmarc.as_deref() == Some("fail") {
            failures.push("DMARC");
        }
        if !failures.is_empty() {
            issues.push(Issue {
                level: "danger",
                key: KEY_AUTH_FAILED,
                params: json!({"failures": failures.join(", ")}),
                details: None,
            });
        }
    }

    for level in ["danger", "warning"] {
        if issues.iter().any(|i| i.level == level) {
            let tooltip = issues.iter().map(|i| Line { key: i.key, params: i.params.clone() }).collect();
            return Verdict { status: level, tooltip, issues, auth, dkim };
        }
    }
    if auth.any() && auth.spf.as_deref() == Some("pass") && auth.dkim.as_deref() == Some("pass") {
        let tooltip = vec![Line { key: KEY_VERIFIED, params: json!({}) }];
        return Verdict { status: "verified", tooltip, issues: vec![], auth, dkim };
    }
    none(auth, dkim)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/sender-check-cases.json");

    /// Every case the JS answered, answered the same.
    #[test]
    fn matches_every_case_the_js_answered() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 60);
        let mut wrong = Vec::new();
        for case in cases {
            let got = serde_json::to_value(verify_sender(&case["input"])).unwrap();
            if got != case["expected"] {
                wrong.push(format!("{}: got {got}\n  want {}", case["name"], case["expected"]));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn the_first_result_per_method_counts() {
        let r = parse_auth_results("mx; spf=fail; spf=pass; dkim=pass; dkim=fail");
        assert_eq!(r.spf.as_deref(), Some("fail"));
        assert_eq!(r.dkim.as_deref(), Some("pass"));
        assert_eq!(r.dmarc, None);
    }

    #[test]
    fn case_folding_and_word_edges_are_ascii() {
        // U+017F (long s) folds to `s` and U+212A (Kelvin) to `k` in Unicode; JS did not fold them.
        let r = parse_auth_results("mx; spf=pa\u{17F}s; d\u{212A}im=fail");
        assert_eq!(r, AuthResults::default());
        assert_eq!(parse_auth_results("spf=pass\u{E9}").spf.as_deref(), Some("pass"));
    }

    #[test]
    fn whitespace_is_javascripts() {
        assert!(!js_space('\u{85}'));
        assert!(js_space('\u{FEFF}'));
        assert_eq!(js_trim("\u{FEFF} a \u{A0}"), "a");
    }
}
