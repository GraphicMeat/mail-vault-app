//! Text helpers for indexing and snippets.

/// Directory name a mailbox path gets under `Maildir/<account>/`. Mirrors
/// `vaultDirName` in src/stores/slices/unifiedHelpers.js
/// (`/[^\p{Alphabetic}\p{N}.\-_]/gu` → `_`); the shared fixture keeps the two
/// sanitizers equal on unix. On Windows both sides additionally run
/// `avoid_reserved`/`avoidReserved` — kept as a second, platform-gated step
/// rather than folded into the fixture, so the fixture stays the same on
/// every platform and only the Windows-only step needs its own test.
pub fn vault_dir_name(mailbox: &str) -> String {
    let safe: String = mailbox.chars()
        .map(|c| if c.is_alphabetic() || c.is_numeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // Unix keeps the fixture's output byte for byte: existing vault directories
    // are named by this function and must not move.
    #[cfg(windows)]
    let safe = avoid_reserved(&safe);
    safe
}

/// Win32 reserved device names, and names Win32 silently rewrites.
///
/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9` and `LPT1`-`LPT9` cannot be used
/// as a path component at all, in any case, with or without an extension, and
/// Win32 ignores trailing spaces before the extension (`CON .txt` is the
/// device too). The `_` goes on the stem, before the first dot: `CON.txt_`
/// would still be `CON` plus an extension, while `CON_.txt` is an ordinary
/// file that keeps its extension (and so the app that opens it).
///
/// A trailing dot or space is stripped by the API rather than rejected, which
/// would quietly collide two mailboxes onto one directory; it gets one
/// trailing `_`.
///
/// Platform-independent so it can be tested anywhere; only called under
/// `cfg(windows)`, because on unix it would rename directories that already
/// exist.
pub fn avoid_reserved(name: &str) -> String {
    const DEVICES: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    let (stem, rest) = name.split_at(name.find('.').unwrap_or(name.len()));
    let upper = stem.trim_end_matches(' ').to_ascii_uppercase();
    let numbered = |prefix: &str| {
        upper.strip_prefix(prefix).is_some_and(|rest| {
            rest.len() == 1 && matches!(rest.as_bytes()[0], b'1'..=b'9')
        })
    };
    if DEVICES.contains(&upper.as_str()) || numbered("COM") || numbered("LPT") {
        return format!("{stem}_{rest}");
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return format!("{name}_");
    }
    name.to_string()
}

pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // Hiragana, Katakana
        | 0x3400..=0x4DBF // CJK Ext A
        | 0x4E00..=0x9FFF // CJK Unified
        | 0xF900..=0xFAFF // CJK Compatibility
        | 0x1100..=0x11FF // Hangul Jamo
        | 0x3130..=0x318F // Hangul Compatibility Jamo
        | 0xAC00..=0xD7AF // Hangul Syllables
        | 0x20000..=0x2FA1F)
}

/// CJK characters as separate tokens for the unicode61 table; every run of
/// other text becomes the token `0`, so characters separated by other text
/// never look adjacent to a phrase query.
pub fn cjk_units(s: &str) -> String {
    if !s.chars().any(is_cjk) { return String::new(); } // one pass; Latin mail costs nothing
    let mut out = String::with_capacity(s.len());
    let mut in_other = false;
    for c in s.chars() {
        if is_cjk(c) {
            if !out.is_empty() { out.push(' '); }
            out.push(c);
            in_other = false;
        } else if !in_other {
            if !out.is_empty() { out.push(' '); }
            out.push('0');
            in_other = true;
        }
    }
    out
}

/// Tags dropped, `<style>`/`<script>`/`<head>` contents dropped, block tags
/// become line breaks, common entities decoded. A char state machine: no regex
/// dependency, no byte slicing of mail data.
pub fn html_to_text(html: &str) -> String {
    const BLOCK: [&str; 14] = ["br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol"];
    let chars: Vec<char> = html.chars().collect();
    // Known once, so a '<' after the last '>' costs O(1), not a scan to the end
    // (a body of many unclosed '<' would otherwise be quadratic).
    let last_gt = chars.iter().rposition(|&x| x == '>');
    let last_lt = chars.iter().rposition(|&x| x == '<');
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0;
    let mut skip_until: Option<&str> = None; // "style" | "script" | "head"
    while i < chars.len() {
        let c = chars[i];
        if c == '<' {
            let close = match last_gt {
                Some(g) if g > i => chars[i..].iter().position(|&x| x == '>'),
                _ => None,
            };
            let Some(close) = close else {
                // No '>' anywhere after. A later '<' means this one is plain
                // text ("a < b"); the last one starts an unclosed tag: drop it.
                if last_lt.is_some_and(|l| l > i) { out.push(c); i += 1; continue; }
                break;
            };
            let tag: String = chars[i + 1..i + close].iter().collect();
            let lower = tag.trim().to_lowercase();
            let name: String = lower.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            let closing = lower.starts_with('/');
            if let Some(until) = skip_until {
                if closing && name == until { skip_until = None; }
            } else if !closing && (name == "style" || name == "script" || name == "head") {
                skip_until = Some(match name.as_str() { "style" => "style", "script" => "script", _ => "head" });
            } else if BLOCK.contains(&name.as_str()) {
                out.push('\n');
            }
            i += close + 1;
            continue;
        }
        if skip_until.is_some() { i += 1; continue; }
        if c == '&' {
            if let Some(len) = chars[i..].iter().take(12).position(|&x| x == ';') {
                let entity: String = chars[i + 1..i + len].iter().collect();
                if let Some(decoded) = decode_entity(&entity) {
                    out.push(decoded);
                    i += len + 1;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    normalize_ws(&out)
}

fn decode_entity(e: &str) -> Option<char> {
    match e {
        "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'), "quot" => Some('"'),
        "apos" => Some('\''), "nbsp" => Some(' '), "ouml" => Some('ö'), "auml" => Some('ä'),
        "uuml" => Some('ü'), "eacute" => Some('é'), "egrave" => Some('è'), "szlig" => Some('ß'),
        _ => {
            let num = e.strip_prefix('#')?;
            let code = match num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => num.parse::<u32>().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// Collapse spaces/tabs inside lines, drop empty lines, trim.
fn normalize_ws(s: &str) -> String {
    s.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn cap_chars(s: String, max: usize) -> String {
    if s.len() <= max { return s; } // byte length ≥ char count
    s.chars().take(max).collect()
}

/// First char of `to_lowercase`, so folding never changes a string's char count.
pub fn fold_char(c: char) -> char { c.to_lowercase().next().unwrap_or(c) }

fn folded(s: &str) -> Vec<char> { s.chars().map(fold_char).collect() }

fn find_folded(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() { return None; }
    hay.windows(needle.len()).position(|w| w == needle)
}

pub fn contains_folded(haystack: &str, needle: &str) -> bool {
    find_folded(&folded(haystack), &folded(needle)).is_some()
}

/// About `max_chars` of `text` around the earliest match of any needle
/// (case-folded), whitespace collapsed, `…` marking cut ends. `None` when no
/// needle occurs.
pub fn snippet(text: &str, needles: &[String], max_chars: usize) -> Option<String> {
    let original: Vec<char> = text.chars().collect();
    let hay: Vec<char> = original.iter().map(|c| fold_char(*c)).collect();
    let at = needles.iter().filter_map(|n| find_folded(&hay, &folded(n))).min()?;
    let start = at.saturating_sub(max_chars / 3);
    let end = (start + max_chars).min(original.len());
    let body: String = original.get(start..end)?.iter().collect();
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(format!("{}{}{}", if start > 0 { "…" } else { "" }, body, if end < original.len() { "…" } else { "" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_windows_names_get_a_suffix() {
        // Reserved device names, with or without an extension, any case.
        for name in ["CON", "con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9", "CON.txt", "CON .txt"] {
            let out = avoid_reserved(name);
            assert_ne!(out, name, "{name} must not survive unchanged");
            let stem = out.split('.').next().unwrap_or_default();
            assert!(stem.ends_with('_'), "{name} -> {out}: the suffix belongs on the stem");
        }
        // `CON.txt_` would still be the device; the extension also survives.
        assert_eq!(avoid_reserved("CON.txt"), "CON_.txt");
        assert_eq!(avoid_reserved("nul.tar.gz"), "nul_.tar.gz");
        // A trailing dot or space is silently stripped by Win32 and would make
        // two mailboxes collide on one directory.
        assert_eq!(avoid_reserved("Inbox."), "Inbox._");
        assert_eq!(avoid_reserved("Inbox "), "Inbox _");
        // Everything else is left exactly as it was.
        for name in ["INBOX", "Sent", "CONTRACTS", "COM", "COM10", "Inbox.Spam", "_meta"] {
            assert_eq!(avoid_reserved(name), name, "{name} must be untouched");
        }
        assert_eq!(avoid_reserved(""), "");
    }

    #[test]
    fn vault_dir_name_matches_shared_fixture() {
        let raw = include_str!("../../tests/fixtures/vault_dir_names.json");
        let cases: Vec<(String, String)> = serde_json::from_str(raw).unwrap();
        for (input, want) in cases {
            assert_eq!(vault_dir_name(&input), want, "{input:?}");
        }
    }

    #[test]
    fn cjk_units_splits_characters_and_marks_breaks() {
        assert_eq!(cjk_units("明日の会議について"), "明 日 の 会 議 に つ い て");
        assert_eq!(cjk_units("会 x 議"), "会 0 議");
        assert_eq!(cjk_units("PDF資料 attached"), "0 資 料 0");
        assert_eq!(cjk_units("hello world"), "");
        assert_eq!(cjk_units("회의 일정"), "회 의 0 일 정");
    }

    #[test]
    fn html_to_text_drops_markup_style_script_and_decodes_entities() {
        let html = "<html><head><style>p{color:red}</style><script>var a='<b>';</script></head>\
                    <body><p>Hello&nbsp;<b>W&ouml;rld</b> &amp; friends</p><div>line&#50;</div>x&#x41;<br>end</body></html>";
        assert_eq!(html_to_text(html), "Hello Wörld & friends\nline2\nxA\nend");
    }

    #[test]
    fn html_to_text_survives_broken_markup() {
        assert_eq!(html_to_text("a < b and <unclosed"), "a < b and");
        assert_eq!(html_to_text("&bogus; &#xZZ; &"), "&bogus; &#xZZ; &");
    }

    #[test]
    fn cap_chars_never_splits_a_character() {
        assert_eq!(cap_chars("héllo".to_string(), 2), "hé");
        assert_eq!(cap_chars("abc".to_string(), 10), "abc");
    }

    #[test]
    fn snippet_centres_on_first_match_case_insensitively() {
        let text = "Lorem ipsum dolor sit amet, the INVOICE for September is attached, regards";
        let s = snippet(text, &["invoice".to_string()], 30).unwrap();
        assert!(s.to_lowercase().contains("invoice"), "{s}");
        assert!(s.chars().count() <= 32, "{s}"); // 30 + two ellipses
        assert_eq!(snippet(text, &["absent".to_string()], 30), None);
        let s = snippet("İstanbul office", &["istanbul".to_string()], 40).expect("lowercase needle finds İstanbul");
        assert!(s.contains("İstanbul"), "{s}");
        let s = snippet("İstanbul office", &["İSTANBUL".to_string()], 40).expect("uppercase needle finds İstanbul");
        assert!(s.contains("İstanbul"), "{s}");
    }

    #[test]
    fn contains_folded_is_char_safe() {
        assert!(contains_folded("Réunion Budget", "budget"));
        assert!(!contains_folded("abc", "abcd"));
        assert!(contains_folded("会議について", "会議"));
    }
}
