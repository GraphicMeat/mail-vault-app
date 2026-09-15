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
/// followed by an INLINE module (`mod name {`, or a `#[path...]`-attributed
/// one — both run to the end of the file in every watched file today). A bare
/// `mod x;` declaration is not a module body at all: those two lines are
/// skipped and scanning continues, so a watched file with an out-of-line test
/// module declared mid-file (e.g. `src-tauri/src/main.rs`'s `mod x;` pattern)
/// is not silently un-guarded past that point.
fn non_test_text(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = String::new();
    let mut skip_next = false;
    for (i, l) in lines.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if l.trim_start().starts_with("#[cfg(test)]") {
            if let Some(next) = lines.get(i + 1) {
                let n = next.trim_start();
                if n.starts_with("#[path") || (n.starts_with("mod ") && n.trim_end().ends_with('{')) {
                    break; // an inline test module: everything after this is test code
                }
                if n.starts_with("mod ") {
                    // `mod x;`: not a body, just a declaration. Skip only these
                    // two lines and keep scanning the rest of the file.
                    skip_next = true;
                    continue;
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
