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

fn non_test_text(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        if l.trim_start().starts_with("#[cfg(test)]") {
            if let Some(next) = lines.get(i + 1) {
                let n = next.trim_start();
                if n.starts_with("mod ") || n.starts_with("#[path") { break; }
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
    let mut files = Vec::new();
    for w in WATCHED { rust_files(&root.join(w), &mut files); }
    assert!(files.iter().any(|f| f.ends_with("vault_eml.rs")), "the guard must see src-core/src/vault_eml.rs");
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
