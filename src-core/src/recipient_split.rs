//! Core's one recipient tokenizer and the whitespace rule it trims by. A leaf:
//! the SMTP builder and the compose check split with it, and the builder sits
//! below the compose layer. `compose_prep::split_recipients` re-exports it.

// ECMAScript whitespace differs from Rust's (FEFF yes, 0085 no).
pub(crate) fn ws(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}'|' '| '\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(ws)
}
/// A recipient line's addresses: split on `,` `;` and line breaks, never
/// inside a quoted display name or angle brackets, each trimmed, empties
/// skipped. Core's one recipient tokenizer: the check (`recipient_problem`)
/// and the MIME builder (`smtp::build_mime`) both split with it.
pub fn split_recipients(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut angle = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' && quoted {
            current.push(c);
            if let Some(c) = chars.next() {
                current.push(c)
            }
            continue;
        }
        if c == '"' {
            quoted = !quoted
        } else if c == '<' && !quoted {
            angle = true
        } else if c == '>' && !quoted {
            angle = false
        }
        if matches!(c, ',' | ';' | '\n' | '\r') && !quoted && !angle {
            if !trim(&current).is_empty() {
                out.push(trim(&current).into())
            }
            current.clear();
        } else {
            current.push(c);
        }
    }
    if !trim(&current).is_empty() {
        out.push(trim(&current).into())
    }
    out
}
