//! A learned classification rule as the classifier applies it.
//!
//! `learning.*` keeps rules as raw JSON in `<app_dir>/ai-feedback/<accountId>.json`
//! (the shape the app, the export file and the golden fixture all share:
//! `{id, type, pattern: {fromDomain, fromAddress, subjectContains,
//! bodyContains}, category, importance, action, confidence, ...}`). That
//! stored shape is the canonical one; this is its typed reading, and the
//! pattern key names below are the ones `learning` writes.
//!
//! What a rule matches, all after trimming, NFKC and lowercasing both sides:
//! - `fromDomain`: the sender's domain, exactly (no subdomains).
//! - `fromAddress`: the sender's address, exactly.
//! - `subjectContains` / `bodyContains`: a substring of the subject / body.
//!
//! A `fromDomain` of a shared mailbox provider (gmail.com, outlook.com, ...;
//! [`is_shared_mail_domain`]) never matches: it would sort every stranger
//! there.
//!
//! Every field a rule sets must match. A rule that sets none, or sets one it
//! cannot use (empty, blank, not text, or subject/body text shorter than
//! [`MIN_TEXT_CHARS`]), never matches: dropping just the bad field would make
//! the rule broader than the one the user saved, and an empty text field
//! would match every message.
//!
//! When several rules match, the most specific wins (address 4, domain 2,
//! subject 1, body 1, summed), then the higher confidence (repeated
//! corrections raise it), then the rule saved later.

use crate::learning::{sender_address, sender_domain};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

pub const FROM_DOMAIN: &str = "fromDomain";
pub const FROM_ADDRESS: &str = "fromAddress";
pub const SUBJECT_CONTAINS: &str = "subjectContains";
pub const BODY_CONTAINS: &str = "bodyContains";

/// The shortest subject or body text a rule may look for. Learned subject
/// words are 4+; a manual one of 1 or 2 letters would match most mail.
pub const MIN_TEXT_CHARS: usize = 3;

/// Confidence of a rule that stores none (or not a number): what an import
/// gives a rule without one.
pub const DEFAULT_CONFIDENCE: f64 = 0.8;

/// A rule's pattern, every field already trimmed and normalized.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RulePattern {
    pub from_domain: Option<String>,
    pub from_address: Option<String>,
    pub subject_contains: Option<String>,
    pub body_contains: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LearnedRule {
    pub id: Option<String>,
    pub pattern: RulePattern,
    pub category: String,
    pub importance: Option<String>,
    pub action: Option<String>,
    /// In 0..=1. Reported with the result and breaks ties between rules of
    /// equal specificity; it is not a threshold.
    pub confidence: f64,
}

/// Mailbox providers whose domain thousands of unrelated people share.
const SHARED_DOMAINS: &[&str] = &[
    "gmail.com", "googlemail.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com",
    "proton.me", "pm.me", "protonmail.com", "protonmail.ch", "web.de", "mail.com", "mail.ru",
    "qq.com", "163.com", "126.com", "zoho.com", "hey.com", "ymail.com", "rocketmail.com",
];

/// Providers with a domain per country: `<name>.<tld>`, `<name>.co.<cc>`,
/// `<name>.com.<cc>` (yahoo.co.uk, hotmail.fr, gmx.de, yandex.ru, ...).
const SHARED_DOMAIN_FAMILIES: &[&str] = &["yahoo", "hotmail", "outlook", "live", "gmx", "yandex", "fastmail"];

/// Whether `domain` belongs to a shared mailbox provider, where a domain rule
/// would sort every stranger with an address there. Learning makes an
/// address rule for these instead, and a stored domain rule for one never
/// matches.
pub fn is_shared_mail_domain(domain: &str) -> bool {
    let d = normalize(domain);
    let d = d.trim_end_matches('.');
    if SHARED_DOMAINS.contains(&d) {
        return true;
    }
    let Some((name, rest)) = d.split_once('.') else { return false };
    if !SHARED_DOMAIN_FAMILIES.contains(&name) {
        return false;
    }
    let labels: Vec<&str> = rest.split('.').collect();
    match labels.as_slice() {
        [tld] => !tld.is_empty(),
        [second, cc] => matches!(*second, "co" | "com" | "ne" | "or") && !cc.is_empty(),
        _ => false,
    }
}

/// Trim, NFKC, lowercase: how both a rule and a message are compared.
pub fn normalize(s: &str) -> String {
    s.trim().nfkc().collect::<String>().to_lowercase()
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

impl LearnedRule {
    /// Read a stored rule. `None` when it cannot be applied safely: no
    /// category, no usable pattern field, or a pattern field it cannot use.
    pub fn from_stored(rule: &Value) -> Option<LearnedRule> {
        let pattern = rule.get("pattern")?.as_object()?;
        // Absent or null: not set. Anything else must be usable text.
        let field = |key: &str, min_chars: usize| -> Result<Option<String>, ()> {
            match pattern.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) => {
                    let n = normalize(s);
                    if n.is_empty() || n.chars().count() < min_chars { Err(()) } else { Ok(Some(n)) }
                }
                Some(_) => Err(()),
            }
        };
        let pattern = RulePattern {
            from_domain: field(FROM_DOMAIN, 1).ok()?,
            from_address: field(FROM_ADDRESS, 1).ok()?,
            subject_contains: field(SUBJECT_CONTAINS, MIN_TEXT_CHARS).ok()?,
            body_contains: field(BODY_CONTAINS, MIN_TEXT_CHARS).ok()?,
        };
        if pattern == RulePattern::default() || pattern.from_domain.as_deref().is_some_and(is_shared_mail_domain) {
            return None;
        }
        let confidence = rule
            .get("confidence")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite())
            .map_or(DEFAULT_CONFIDENCE, |c| c.clamp(0.0, 1.0));
        Some(LearnedRule {
            id: text(rule.get("id")),
            pattern,
            category: text(rule.get("category"))?,
            importance: text(rule.get("importance")),
            action: text(rule.get("action")),
            confidence,
        })
    }

    pub fn specificity(&self) -> u8 {
        let p = &self.pattern;
        4 * u8::from(p.from_address.is_some())
            + 2 * u8::from(p.from_domain.is_some())
            + u8::from(p.subject_contains.is_some())
            + u8::from(p.body_contains.is_some())
    }

    /// Whether a message with this `From`, subject and body matches.
    pub fn matches(&self, from: &str, subject: &str, body: &str) -> bool {
        self.matches_message(&Message::new(from, subject, body))
    }

    fn matches_message(&self, m: &Message) -> bool {
        let p = &self.pattern;
        p.from_domain.as_ref().map_or(true, |d| m.domain.as_ref() == Some(d))
            && p.from_address.as_ref().map_or(true, |a| m.address.as_ref() == Some(a))
            && p.subject_contains.as_ref().map_or(true, |w| m.subject.contains(w.as_str()))
            && p.body_contains.as_ref().map_or(true, |w| m.body.contains(w.as_str()))
    }
}

/// A message's sender, subject and body, normalized once for every rule.
struct Message {
    domain: Option<String>,
    address: Option<String>,
    subject: String,
    body: String,
}

impl Message {
    fn new(from: &str, subject: &str, body: &str) -> Message {
        Message {
            domain: sender_domain(from).map(|d| normalize(&d)),
            address: sender_address(from).map(|a| normalize(&a)),
            subject: normalize(subject),
            body: normalize(body),
        }
    }
}

/// Every stored rule the classifier can apply, in file order.
pub fn parse_all(stored: &[Value]) -> Vec<LearnedRule> {
    stored.iter().filter_map(LearnedRule::from_stored).collect()
}

/// The rule that decides a message: the most specific match, then the most
/// confident, then the one saved later.
pub fn best_match<'a>(rules: &'a [LearnedRule], from: &str, subject: &str, body: &str) -> Option<&'a LearnedRule> {
    if rules.is_empty() {
        return None;
    }
    let message = Message::new(from, subject, body);
    rules
        .iter()
        .enumerate()
        .filter(|(_, r)| r.matches_message(&message))
        .max_by(|(ia, a), (ib, b)| {
            a.specificity()
                .cmp(&b.specificity())
                .then(a.confidence.total_cmp(&b.confidence))
                .then(ia.cmp(ib))
        })
        .map(|(_, r)| r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learning::{record_correction, save_rule, Feedback};
    use serde_json::json;

    fn rule(pattern: Value) -> Value {
        json!({ "id": "r1", "type": "sender-action", "pattern": pattern, "category": "promotional", "action": "archive", "confidence": 0.95 })
    }

    fn parsed(pattern: Value) -> Option<LearnedRule> {
        LearnedRule::from_stored(&rule(pattern))
    }

    #[test]
    fn a_learned_domain_rule_matches_its_domain_only() {
        let r = parsed(json!({ "fromDomain": "shop.com" })).unwrap();
        assert!(r.matches("Shop <news@shop.com>", "anything", ""));
        assert!(r.matches("deals@SHOP.COM", "", ""));
        assert!(!r.matches("news@mail.shop.com", "", ""), "a subdomain is another domain");
        assert!(!r.matches("news@shop.com.evil.test", "", ""));
        assert!(!r.matches("shop.com <x@other.test>", "", ""), "the display name is not the domain");
    }

    #[test]
    fn an_address_rule_matches_that_address_only() {
        let r = parsed(json!({ "fromAddress": "billing@shop.com" })).unwrap();
        assert!(r.matches("Billing <Billing@Shop.com>", "", ""));
        assert!(!r.matches("news@shop.com", "", ""));
    }

    #[test]
    fn a_subject_rule_matches_a_substring_and_every_set_field_must_match() {
        let r = parsed(json!({ "fromDomain": "shop.com", "subjectContains": "weekly" })).unwrap();
        assert!(r.matches("news@shop.com", "Your WEEKLY deals", ""));
        assert!(!r.matches("news@shop.com", "Daily deals", ""));
        assert!(!r.matches("news@other.test", "Weekly deals", ""));
    }

    #[test]
    fn an_empty_or_blank_pattern_never_matches() {
        for p in [
            json!({}),
            json!({ "fromDomain": "" }),
            json!({ "subjectContains": "" }),
            json!({ "subjectContains": "   " }),
            json!({ "fromAddress": " \t" }),
            json!({ "bodyContains": "" }),
            json!({ "fromDomain": null, "subjectContains": null }),
            json!({ "from": "shop.com" }),
        ] {
            assert_eq!(parsed(p.clone()), None, "{p}");
        }
        assert_eq!(LearnedRule::from_stored(&json!({ "category": "x" })), None, "no pattern at all");
        assert_eq!(LearnedRule::from_stored(&json!({ "category": "x", "pattern": "shop.com" })), None);
    }

    #[test]
    fn a_bad_field_disables_the_whole_rule_rather_than_widening_it() {
        // Ignoring the blank subject would turn this into "all of shop.com".
        assert_eq!(parsed(json!({ "fromDomain": "shop.com", "subjectContains": " " })), None);
        assert_eq!(parsed(json!({ "fromDomain": "shop.com", "subjectContains": 7 })), None);
        assert_eq!(parsed(json!({ "fromDomain": ["shop.com"] })), None);
    }

    #[test]
    fn subject_and_body_text_shorter_than_three_characters_is_refused() {
        assert_eq!(parsed(json!({ "subjectContains": "a" })), None);
        assert_eq!(parsed(json!({ "subjectContains": " re " })), None);
        assert_eq!(parsed(json!({ "bodyContains": "hi" })), None);
        assert!(parsed(json!({ "subjectContains": "vat" })).is_some());
        assert!(parsed(json!({ "subjectContains": "請求書" })).is_some(), "three characters, not three bytes");
    }

    #[test]
    fn patterns_are_trimmed_case_folded_and_nfkc_normalized() {
        let r = parsed(json!({ "fromDomain": "  Shop.COM ", "subjectContains": " Café " })).unwrap();
        assert_eq!(r.pattern.from_domain.as_deref(), Some("shop.com"));
        // Decomposed e + combining acute in the subject, composed in the rule.
        assert!(r.matches("a@shop.com", "Le cafe\u{301} du jour", ""));
        // Full-width letters fold to ASCII under NFKC.
        let wide = parsed(json!({ "subjectContains": "ＩＮＶＯＩＣＥ" })).unwrap();
        assert!(wide.matches("a@b.test", "Your invoice", ""));
        let upper = parsed(json!({ "subjectContains": "ÜNÏCÖDÉ" })).unwrap();
        assert!(upper.matches("a@b.test", "daily ünïcödé digest", ""));
    }

    #[test]
    fn a_rule_without_a_category_is_not_applied() {
        let mut r = rule(json!({ "fromDomain": "shop.com" }));
        r["category"] = Value::Null;
        assert_eq!(LearnedRule::from_stored(&r), None);
        r["category"] = json!("  ");
        assert_eq!(LearnedRule::from_stored(&r), None);
    }

    #[test]
    fn confidence_is_clamped_and_defaults_when_missing() {
        let mut r = rule(json!({ "fromDomain": "shop.com" }));
        r["confidence"] = Value::Null; // what strengthening a non-number stores
        assert_eq!(LearnedRule::from_stored(&r).unwrap().confidence, DEFAULT_CONFIDENCE);
        r["confidence"] = json!(7);
        assert_eq!(LearnedRule::from_stored(&r).unwrap().confidence, 1.0);
        r.as_object_mut().unwrap().remove("confidence");
        assert_eq!(LearnedRule::from_stored(&r).unwrap().confidence, DEFAULT_CONFIDENCE);
        r.as_object_mut().unwrap().remove("id");
        assert!(LearnedRule::from_stored(&r).is_some(), "a rule without an id still applies");
    }

    #[test]
    fn the_most_specific_rule_wins_then_confidence_then_the_later_rule() {
        let make = |pattern: Value, category: &str, confidence: f64| {
            LearnedRule::from_stored(&json!({ "pattern": pattern, "category": category, "confidence": confidence })).unwrap()
        };
        let rules = vec![
            make(json!({ "fromAddress": "billing@shop.com" }), "transactional", 0.95),
            make(json!({ "fromDomain": "shop.com" }), "promotional", 0.99),
            make(json!({ "fromDomain": "shop.com", "subjectContains": "weekly" }), "newsletter", 0.9),
        ];
        let pick = |from: &str, subject: &str| best_match(&rules, from, subject, "").map(|r| r.category.as_str());
        assert_eq!(pick("billing@shop.com", "weekly"), Some("transactional"));
        assert_eq!(pick("news@shop.com", "Weekly news"), Some("newsletter"));
        assert_eq!(pick("news@shop.com", "Hello"), Some("promotional"));
        assert_eq!(pick("news@other.test", "Weekly"), None);

        let ties = vec![
            make(json!({ "fromDomain": "shop.com" }), "older", 0.95),
            make(json!({ "fromDomain": "shop.com" }), "newer", 0.95),
            make(json!({ "fromDomain": "shop.com" }), "weaker", 0.9),
        ];
        assert_eq!(best_match(&ties, "a@shop.com", "", "").unwrap().category, "newer");
        let stronger = vec![
            make(json!({ "fromDomain": "shop.com" }), "strengthened", 0.96),
            make(json!({ "fromDomain": "shop.com" }), "newer", 0.95),
        ];
        assert_eq!(best_match(&stronger, "a@shop.com", "", "").unwrap().category, "strengthened");
    }

    fn correct_once(fb: &mut Feedback, from: &str, category: &str) {
        record_correction(
            fb,
            &json!({ "messageId": "<m@x>", "from": from, "subject": "Lunch on Friday" }),
            &json!({ "correctedCategory": category, "correctedAction": "keep" }),
            0,
        );
    }

    /// One friend's gmail.com message corrected to personal must not sort
    /// every gmail.com sender as personal: learn the address instead.
    #[test]
    fn a_correction_from_a_freemail_sender_learns_the_address_not_the_domain() {
        for from in ["Pal <pal@gmail.com>", "pal@Hotmail.co.uk", "pal@yahoo.fr", "pal@gmx.de", "pal@outlook.com"] {
            let mut fb = Feedback::default();
            correct_once(&mut fb, from, "personal");
            correct_once(&mut fb, from, "personal");
            assert!(fb.rules.iter().all(|r| r["pattern"].get(FROM_DOMAIN).is_none()), "{from}: {:?}", fb.rules);
            assert!(fb.rules.iter().any(|r| r["pattern"].get(FROM_ADDRESS).is_some()), "{from}: {:?}", fb.rules);
        }
    }

    #[test]
    fn a_company_domain_still_learns_a_domain_rule() {
        let mut fb = Feedback::default();
        correct_once(&mut fb, "Billing <billing@acme-corp.test>", "transactional");
        assert_eq!(fb.rules.len(), 1);
        assert_eq!(fb.rules[0]["pattern"], json!({ FROM_DOMAIN: "acme-corp.test" }));
    }

    /// Rules already on disk from before the guard.
    #[test]
    fn a_stored_freemail_domain_rule_never_matches() {
        for domain in ["gmail.com", "GMAIL.COM ", "yahoo.co.jp", "icloud.com", "proton.me", "yandex.ru"] {
            assert_eq!(parsed(json!({ "fromDomain": domain })), None, "{domain}");
            assert_eq!(parsed(json!({ "fromDomain": domain, "subjectContains": "lunch" })), None, "{domain}");
        }
        assert!(parsed(json!({ "fromAddress": "pal@gmail.com" })).is_some(), "an address at a freemail domain is fine");
        assert!(parsed(json!({ "fromDomain": "gmail.company.test" })).is_some());
        assert!(parsed(json!({ "fromDomain": "mygmail.com" })).is_some());
    }

    /// The drift guard: every rule `record_correction` writes reads back as a
    /// rule that matches the message it was learned from, and every learned
    /// rule (with a category) in the golden fixture reads back at all.
    #[test]
    fn every_rule_learning_writes_is_one_the_classifier_applies() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/learning-cases.json")).unwrap();
        let mut learned = 0;
        for scenario in fixture["scenarios"].as_array().unwrap() {
            for step in scenario["steps"].as_array().unwrap() {
                let rule = &step["expect"]["rule"];
                if step["op"] == "recordCorrection" && rule.is_object() && rule["category"].is_string() {
                    let r = LearnedRule::from_stored(rule).unwrap_or_else(|| panic!("{rule} must parse"));
                    let from = step["email"]["from"].as_str().unwrap_or("");
                    let subject = step["email"]["subject"].as_str().unwrap_or("");
                    assert!(r.matches(from, subject, ""), "{rule} must match the mail it came from ({from})");
                    learned += 1;
                }
            }
            let last = scenario["steps"].as_array().unwrap().last().unwrap();
            for r in last["after"]["rules"].as_array().unwrap() {
                if r["source"] == "learned" && r["category"].is_string() {
                    assert!(LearnedRule::from_stored(r).is_some(), "{r} must parse");
                }
            }
        }
        assert!(learned >= 8, "the fixture's generated rules were checked ({learned})");

        // Subject rules are not in the answer: build one and check it too.
        let mut fb = Feedback::default();
        for subject in ["Weekly deals inside", "More weekly deals"] {
            record_correction(
                &mut fb,
                &json!({ "messageId": "<m@x>", "from": "news@shop.com", "subject": subject }),
                &json!({ "correctedCategory": "promotional", "correctedAction": "archive" }),
                0,
            );
        }
        let rules = parse_all(&fb.rules);
        assert_eq!(rules.len(), fb.rules.len());
        assert!(rules.iter().any(|r| r.pattern.subject_contains.as_deref() == Some("weekly")));

        // And what the Settings form saves.
        save_rule(&mut fb, json!({ "id": "m", "type": "sender-action", "pattern": { "fromAddress": "a@b.test" }, "category": "invoices", "action": "review", "confidence": 0.95, "source": "manual" }));
        assert_eq!(parse_all(&fb.rules).len(), fb.rules.len());
    }
}
