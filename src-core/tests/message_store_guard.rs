//! Plan B (JMAP storage format) Task 1: every read or write of a vault
//! message, and every "which uids are taken" question, goes through
//! `mailvault_core::message_store`. Nothing outside `OWNERS` builds a `cur/`
//! path, finds a file by uid, parses or builds a vault filename, or scans the
//! uid space itself.
//!
//! `PENDING` is the to-do list of files that still do (Tasks 2-5 empty it).
//! It can only shrink: a file not listed that offends fails
//! `no_new_direct_cur_access`, and a listed file that no longer offends fails
//! `pending_list_only_shrinks` until its row is deleted.
//!
//! Matching is text: a token in a comment or a string counts. Inline
//! `#[cfg(test)] mod x {` bodies and `*_tests.rs` files are skipped. Paths
//! are relative to the repo root with `/` separators on every platform.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const WATCHED: &[&str] = &["src-core/src", "src-daemon/src", "src-tauri/src"];

const FORBIDDEN: &[&str] = &[
    "cur_path(",
    "find_by_uid",
    "find_file_by_uid(",
    "find_listed_by_uid(",
    "uid_file_map(",
    "archived_file_map(",
    "join(\"cur\")",
    "read_cur(",
    "build_maildir_filename(",
    "vault_filename_uid(",
    "mirror_filename_uid(",
    "parse_flags_from_filename(",
    "INFO_PREFIX",
    "INFO_SEP",
    "IMPORT_UID_BASE",
    "graph_ledger::scan(",
];

/// Always allowed: the store itself and the Maildir code it is built on.
/// `vault_eml.rs` holds the `find_by_uid as find_file_by_uid` re-export.
const OWNERS: &[&str] = &[
    "src-core/src/maildir.rs",
    "src-core/src/message_store.rs",
    "src-core/src/vault_eml.rs",
    "src-core/src/vault_files.rs",
    "src-core/src/vault_registry.rs",
];

/// Files that still reach the Maildir layout directly. Delete a row when its
/// task moves the file behind `message_store`; never add one.
const PENDING: &[&str] = &[
    "src-core/src/aliases.rs",
    "src-core/src/archive.rs",
    "src-core/src/backup.rs",
    "src-core/src/graph_ledger.rs",
    "src-core/src/import_rehome.rs",
    "src-core/src/vault_flags.rs",
    "src-daemon/src/abd_local.rs",
    "src-daemon/src/backup_zip.rs",
    "src-daemon/src/handlers/abd.rs",
    "src-daemon/src/handlers/aliases.rs",
    "src-daemon/src/handlers/archive.rs",
    "src-daemon/src/handlers/cache.rs",
    "src-daemon/src/handlers/custody.rs",
    "src-daemon/src/handlers/pgp.rs",
    "src-daemon/src/handlers/vault_files.rs",
    "src-daemon/src/handlers/views.rs",
    "src-daemon/src/insights.rs",
    "src-daemon/src/jmap_sessions.rs",
    "src-daemon/src/mbox.rs",
    "src-daemon/src/mbox_upload.rs",
    "src-daemon/src/mbox_upload_job.rs",
    "src-daemon/src/restore.rs",
    "src-daemon/src/snapshot.rs",
];

fn rust_files(p: &Path, out: &mut Vec<PathBuf>) {
    if p.is_file() {
        if p.extension().is_some_and(|e| e == "rs") { out.push(p.to_path_buf()); }
        return;
    }
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() { rust_files(&e.path(), out); }
    }
}

/// Copied from `vault_format_guard.rs`: skips only the brace-matched body of
/// `#[cfg(test)]` followed by an inline `mod name {`, resumes right after its
/// closing brace, and blanks each skipped line so line numbers stay exact.
fn non_test_text(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        out.push_str(l);
        out.push('\n');
        if l.trim_start().starts_with("#[cfg(test)]") {
            if let Some(next) = lines.get(i + 1) {
                let n = next.trim_start();
                if n.starts_with("mod ") && n.trim_end().ends_with('{') {
                    let mut depth = 0i32;
                    let mut j = i + 1;
                    loop {
                        let body_line = lines[j];
                        depth += body_line.matches('{').count() as i32;
                        depth -= body_line.matches('}').count() as i32;
                        out.push('\n');
                        j += 1;
                        if depth <= 0 || j >= lines.len() {
                            break;
                        }
                    }
                    i = j;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// Every watched file with a forbidden token, keyed by its repo-relative
/// path, with its `line: text` hits.
fn offenders() -> BTreeMap<String, Vec<String>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for w in WATCHED {
        assert!(root.join(w).exists(), "watched path missing: {w}");
    }
    let mut files = Vec::new();
    for w in WATCHED { rust_files(&root.join(w), &mut files); }
    files.retain(|f| !f.to_string_lossy().ends_with("_tests.rs"));
    let mut hits: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in &files {
        let rel = f.strip_prefix(root).unwrap().display().to_string().replace('\\', "/");
        let text = non_test_text(&std::fs::read_to_string(f).unwrap());
        for (n, line) in text.lines().enumerate() {
            if FORBIDDEN.iter().any(|t| line.contains(t)) {
                hits.entry(rel.clone()).or_default().push(format!("{}: {}", n + 1, line.trim()));
            }
        }
    }
    hits
}

#[test]
fn no_new_direct_cur_access() {
    let hits = offenders();
    let new: Vec<&String> = hits.keys().filter(|f| !OWNERS.contains(&f.as_str()) && !PENDING.contains(&f.as_str())).collect();
    let detail: Vec<String> = new.iter().flat_map(|f| hits[*f].iter().map(move |h| format!("{f}:{h}"))).collect();
    assert!(
        new.is_empty(),
        "files that reach the Maildir layout directly instead of going through message_store ({} files):\n{}\n\nhits:\n{}",
        new.len(),
        new.iter().map(|f| format!("    \"{f}\",")).collect::<Vec<_>>().join("\n"),
        detail.join("\n")
    );
}

#[test]
fn pending_list_only_shrinks() {
    let hits = offenders();
    let stale: Vec<&str> = PENDING.iter().copied().filter(|p| !hits.contains_key(*p)).collect();
    assert!(stale.is_empty(), "PENDING rows that no longer offend (delete them):\n{}", stale.join("\n"));
}
