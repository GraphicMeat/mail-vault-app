//! The directory name a mailbox gets under `Maildir/<account>/`. A leaf: the
//! vault registry and the vault files name directories with it, and neither
//! sits above the search index (`search_index::text` re-exports both).

/// Directory name a mailbox path gets under `Maildir/<account>/`: every char
/// outside alphanumeric (Unicode-aware), `.`, `-` and `_` becomes `_`. The
/// shared fixture (`vault_dir_names.json`) pins the unix names. On Windows it
/// additionally runs `avoid_reserved`, a second, platform-gated step rather
/// than folded into the fixture, so the fixture stays the same on every
/// platform and only the Windows-only step needs its own test. The app asks
/// the daemon for the reverse (`policy.vault_mailboxes`), never computes it.
pub fn vault_dir_name(mailbox: &str) -> String {
    let safe: String = mailbox.chars()
        .map(|c| if c.is_alphabetic() || c.is_numeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // `.` and `..` would name the account dir or climb out of it.
    let safe = if safe == "." || safe == ".." { safe.replace('.', "_") } else { safe };
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
