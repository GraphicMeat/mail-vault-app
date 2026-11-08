//! The subject of a reply or forward, one rule for desktop and mobile: drop any leading run
//! of reply/forward prefixes (`Re:`, `RE:`, `Aw:`, `WG:`, `Fwd:` ..., any case, any of the
//! localized forms the app's catalogs use), then put one prefix back.

/// Prefix words (lowercase, without the colon) that mail clients put in front of a subject.
const WORDS: &[&str] = &[
    // English and the common Latin-script forms
    "re", "fwd", "fw", "r", "res", "rif", "rv", "tr", "enc", "i", "fs", "vs", "sv", "vb",
    // German, Dutch, Scandinavian
    "aw", "wg", "antw", "doorst",
    // CJK
    "回复", "回覆", "答复", "转发", "轉發", "轉寄", "답장", "전달", "返信", "転送",
];

/// The rest of `s` after one leading prefix (`Re:`, `Re :`, `回复：`), or `None`.
fn strip_one(s: &str) -> Option<&str> {
    let s = s.trim_start();
    let colon = s.find([':', '：'])?;
    let word = s[..colon].trim_end();
    if word.is_empty() || word.chars().count() > 8 || word.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = word.to_lowercase();
    if !WORDS.contains(&lower.as_str()) {
        return None;
    }
    let after = &s[colon..];
    let width = after.chars().next().map_or(1, char::len_utf8);
    Some(after[width..].trim_start())
}

/// `subject` without any leading run of reply/forward prefixes, trimmed.
pub fn strip_prefixes(subject: &str) -> &str {
    let mut rest = subject.trim();
    while let Some(next) = strip_one(rest) {
        rest = next;
    }
    rest
}

/// The localized prefix (`Re:`, `WG:`, `Re :`) a caller's candidate puts before the original
/// subject. A candidate not shaped `<prefix> <subject>` gives `fallback`.
pub fn prefix_of<'a>(candidate: &'a str, subject: &str, fallback: &'a str) -> &'a str {
    candidate
        .strip_suffix(subject)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or(fallback)
}

/// The subject for a reply (`prefix` = `Re:`) or forward (`Fwd:`): `original` stripped, then
/// one `prefix` and a space. An empty remainder leaves the bare prefix.
pub fn subject_for(original: &str, prefix: &str) -> String {
    let rest = strip_prefixes(original);
    if rest.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix} {rest}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_subject_table() {
        let re = |s: &str| subject_for(s, "Re:");
        let fwd = |s: &str| subject_for(s, "Fwd:");
        assert_eq!(re("x"), "Re: x");
        assert_eq!(re("Re: x"), "Re: x");
        assert_eq!(re("Re: RE: x"), "Re: x");
        assert_eq!(re("RE: re: Re: x"), "Re: x");
        assert_eq!(re("AW: x"), "Re: x");
        assert_eq!(re("Aw: Re: x"), "Re: x");
        assert_eq!(re("Fwd: Re: x"), "Re: x");
        assert_eq!(re("WG: x"), "Re: x");
        assert_eq!(re("Re : x"), "Re: x");
        assert_eq!(re("re:x"), "Re: x");
        assert_eq!(re("  RE:   x  "), "Re: x");
        assert_eq!(re("回复: x"), "Re: x");
        assert_eq!(re("回复：转发: x"), "Re: x");
        assert_eq!(re("TR : Re : x"), "Re: x");
        assert_eq!(fwd("x"), "Fwd: x");
        assert_eq!(fwd("Fwd: x"), "Fwd: x");
        assert_eq!(fwd("Fw: x"), "Fwd: x");
        assert_eq!(fwd("FWD: Fwd: x"), "Fwd: x");
        assert_eq!(fwd("Re: x"), "Fwd: x");
        assert_eq!(fwd("Re: Fwd: x"), "Fwd: x");
        assert_eq!(fwd("WG: x"), "Fwd: x");
    }

    #[test]
    fn only_a_leading_run_is_stripped() {
        assert_eq!(subject_for("Plans re: later", "Re:"), "Re: Plans re: later");
        assert_eq!(subject_for("Re: Plans Re: later", "Re:"), "Re: Plans Re: later");
        assert_eq!(subject_for("Read: x", "Re:"), "Re: Read: x");
        assert_eq!(subject_for("Reminder: x", "Re:"), "Re: Reminder: x");
        assert_eq!(subject_for("Meeting: x", "Re:"), "Re: Meeting: x");
        assert_eq!(subject_for("Important note: x", "Re:"), "Re: Important note: x");
        assert_eq!(subject_for("Re x", "Re:"), "Re: Re x");
    }

    #[test]
    fn an_empty_subject_gets_the_bare_prefix() {
        assert_eq!(subject_for("", "Re:"), "Re:");
        assert_eq!(subject_for("  ", "Fwd:"), "Fwd:");
        assert_eq!(subject_for("Re:", "Re:"), "Re:");
        assert_eq!(subject_for("Re: Fwd:", "Re:"), "Re:");
    }

    #[test]
    fn the_localized_prefix_comes_from_the_candidate() {
        assert_eq!(prefix_of("WG: x", "x", "Fwd:"), "WG:");
        assert_eq!(prefix_of("Re : x", "x", "Re:"), "Re :");
        assert_eq!(prefix_of("回复: ", "", "Re:"), "回复:");
        assert_eq!(prefix_of("whatever", "x", "Re:"), "Re:");
        assert_eq!(prefix_of("x", "x", "Re:"), "Re:");
        assert_eq!(subject_for("Re: x", prefix_of("TR : Re: x", "Re: x", "Fwd:")), "TR : x");
    }

    #[test]
    fn every_catalog_prefix_is_recognised() {
        for p in ["Re:", "Re :", "WG:", "I:", "RV:", "Enc:", "TR :", "转发:", "回复:", "Fwd:"] {
            assert_eq!(strip_prefixes(&format!("{p} x")), "x", "{p}");
        }
    }
}
