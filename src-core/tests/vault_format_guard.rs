//! Spec 2026-09-14 §5.1: the index reads the files the app writes, so the index
//! and the shared parser must never touch core's older `<uid>:archived,seen:<ts>.eml`
//! reader/writer. Those are deleted in Phase 2; until then nothing new may use them.
use std::path::{Path, PathBuf};

const WATCHED: &[&str] = &["src-core/src/vault_eml.rs", "src-core/src/search_index", "src-daemon/src/search_index.rs", "src-daemon/src/handlers/search_index.rs"];
const FORBIDDEN: &[&str] = &["read_light_batch(", "maildir::read_light", "EmailHeader", "build_filename", "parse_header(", "maildir::store(", "maildir::set_flags("];

fn rust_files(p: &Path, out: &mut Vec<PathBuf>) {
    if p.is_file() {
        if p.extension().is_some_and(|e| e == "rs") { out.push(p.to_path_buf()); }
        return;
    }
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() { rust_files(&e.path(), out); }
    }
}

/// Review M2 (task-1.2-review.md): stops only at `#[cfg(test)]` immediately
/// followed by an INLINE module (`mod name {`, ending the line with `{`,
/// which in every watched file today runs to the end of the file) — never at
/// a bare `mod x;` declaration or a `#[path = ".."]`-attributed one, neither
/// of which is a module BODY. Those lines carry no FORBIDDEN substring, so
/// leaving them in `out` is harmless; the fix is only to stop *breaking* on
/// them, so a watched file with an out-of-line test module declared mid-file
/// (e.g. `src-tauri/src/main.rs`'s `mod x;` pattern) is not silently
/// un-guarded past that point. No line is ever dropped from `out`, so hit
/// line numbers stay exact (the 1.2 review's own invariant: "truncation only
/// drops a tail").
fn non_test_text(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        if l.trim_start().starts_with("#[cfg(test)]") {
            if let Some(next) = lines.get(i + 1) {
                let n = next.trim_start();
                if n.starts_with("mod ") && n.trim_end().ends_with('{') {
                    break; // an inline test module: everything after this is test code
                }
            }
        }
        out.push_str(l);
        out.push('\n');
    }
    out
}

#[test]
fn index_and_parser_code_never_name_the_legacy_vault_reader_or_writer() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    // Review M3: a missing watched path (a rename, or a `.rs` file replaced by
    // a directory module) must fail loudly, not silently guard nothing.
    for w in WATCHED {
        assert!(root.join(w).exists(), "watched path missing: {w}");
    }
    let mut files = Vec::new();
    for w in WATCHED { rust_files(&root.join(w), &mut files); }
    let mut hits = Vec::new();
    for f in &files {
        let text = non_test_text(&std::fs::read_to_string(f).unwrap());
        for (n, line) in text.lines().enumerate() {
            if FORBIDDEN.iter().any(|w| line.contains(w)) {
                hits.push(format!("{}:{}: {}", f.strip_prefix(root).unwrap().display(), n + 1, line.trim()));
            }
        }
    }
    assert!(hits.is_empty(), "legacy vault format referenced:\n{}", hits.join("\n"));
}

/// Direct unit coverage of the M2 fix: no watched file today has a `mod x;`
/// test declaration mid-file, so the negative control on real files can't
/// exercise this branch. A synthetic source can.
#[test]
fn non_test_text_does_not_stop_at_a_bare_mod_declaration_and_keeps_line_numbers() {
    let src = "fn a() {}\n#[cfg(test)]\nmod unit_tests;\nfn b() { maildir::read_light(); }\n";
    let kept = non_test_text(src);
    let lines: Vec<&str> = kept.lines().collect();
    assert_eq!(lines.len(), 4, "no line dropped or added: {lines:?}");
    assert!(lines[3].contains("maildir::read_light"), "code after a bare `mod x;` must still be scanned: {lines:?}");
}

#[test]
fn non_test_text_stops_at_an_inline_test_module() {
    let src = "fn a() {}\n#[cfg(test)]\nmod tests {\n    fn hidden() { maildir::read_light(); }\n}\n";
    let kept = non_test_text(src);
    assert!(!kept.contains("read_light"), "code inside an inline test module must not be scanned: {kept:?}");
}
