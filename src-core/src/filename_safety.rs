//! Making sender- and server-supplied names safe to create on disk.
//!
//! A MIME `filename` or an attachment name from a server is attacker-controlled:
//! these functions are the one place that turns such a name into a path
//! component. Desktop (vault attachment cache, drag-out) and mobile (compose
//! attachment handles) both come through here.

use std::path::Path;

pub fn fs_safe(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// The one component of a sender-supplied filename that may name a file.
///
/// A MIME `filename` is attacker-controlled: `../../x` or an absolute path
/// would escape the directory it is being written into. Only the last
/// component survives, and a component that names a directory instead of a
/// file (empty, `.`, `..`) falls back.
pub fn safe_leaf(filename: &str) -> String {
    let leaf = Path::new(filename)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .filter(|f| !f.is_empty() && f != "." && f != "..")
        .unwrap_or_else(|| "attachment".to_string());
    // Unix keeps its names byte for byte: cached attachments are found again
    // by this name, so changing it there would orphan every cached file.
    #[cfg(windows)]
    let leaf = win32_safe(&leaf);
    leaf
}

/// `: < > " | ? *` and control characters become `_`. Win32 rejects them in
/// a file name, except `:`, which is worse: `a.pdf:x.exe` addresses an NTFS
/// alternate data stream of `a.pdf`, where no Mark-of-the-Web can follow.
/// `Re: invoice.pdf` is a real name this makes writable. Then reserved device
/// names and a trailing dot or space go through `avoid_reserved`, the rule
/// vault directories use: `CON.txt` -> `CON_.txt`.
///
/// Platform-independent so it is tested everywhere; only called on Windows.
/// Mirrored by `safeLeaf` in src/services/attachmentUtils.js.
pub fn win32_safe(leaf: &str) -> String {
    let chars: String = leaf.chars()
        .map(|c| if matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    crate::search_index::text::avoid_reserved(&chars)
}

/// A server's attachment name made safe as the last component of a handle.
pub fn safe_handle_name(name: &str) -> String {
    let mapped: String = name.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':') { '_' } else { c }).collect();
    // At most 200 bytes, cut on a character boundary: file systems count bytes (255 at most).
    let mut end = mapped.len().min(200);
    while !mapped.is_char_boundary(end) {
        end -= 1;
    }
    let cleaned = mapped[..end].trim().to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".into()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win32_safe_leaves_no_stream_or_invalid_character() {
        assert_eq!(win32_safe("a.pdf:x.exe"), "a.pdf_x.exe");
        assert_eq!(win32_safe("Re: invoice.pdf"), "Re_ invoice.pdf");
        assert_eq!(win32_safe("<a>|\"b\"?*\u{1}.txt"), "_a___b____.txt");
        assert_eq!(win32_safe("Rechnung März.pdf"), "Rechnung März.pdf");
        assert_eq!(win32_safe("CON.txt"), "CON_.txt");
        assert_eq!(win32_safe("invoice.pdf."), "invoice.pdf._");
    }

    #[test]
    fn server_names_become_safe_handle_names() {
        assert_eq!(safe_handle_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(safe_handle_name(".."), "attachment");
        assert_eq!(safe_handle_name("a:b\\c\0d.pdf"), "a_b_c_d.pdf");
        assert_eq!(safe_handle_name("  "), "attachment");
        let long = "ж".repeat(150) + ".pdf";
        let cut = safe_handle_name(&long);
        assert!(cut.len() <= 200 && cut.chars().all(|c| c == 'ж'), "{} bytes", cut.len());
    }

    #[test]
    fn safe_leaf_keeps_only_the_last_component() {
        for (input, want) in [
            ("../../x.pdf", "x.pdf"),
            ("/abs/path/y.txt", "y.txt"),
            ("plain.pdf", "plain.pdf"),
            ("", "attachment"),
            (".", "attachment"),
            ("..", "attachment"),
            ("dir/", "dir"),
        ] {
            assert_eq!(safe_leaf(input), want, "{input:?}");
        }
    }

    #[test]
    fn fs_safe_keeps_word_characters_only() {
        assert_eq!(fs_safe("a b/c:d.e-f_g"), "a_b_c_d.e-f_g");
        assert_eq!(fs_safe("Grüße"), "Grüße");
    }
}
