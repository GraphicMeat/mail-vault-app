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
//! Every file but the store calls it by path (`message_store::write(`):
//! `no_store_item_imports` refuses a `use` of a store item or an alias of
//! the module, which would hide a writer call from `vault_registry_guard`.
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
    "src-core/src/archive.rs",
    "src-core/src/backup.rs",
    "src-core/src/vault_flags.rs",
    "src-daemon/src/abd_local.rs",
    "src-daemon/src/backup_zip.rs",
    "src-daemon/src/handlers/abd.rs",
    "src-daemon/src/handlers/archive.rs",
    "src-daemon/src/handlers/custody.rs",
    "src-daemon/src/mbox.rs",
    "src-daemon/src/mbox_upload.rs",
    "src-daemon/src/mbox_upload_job.rs",
    "src-daemon/src/restore.rs",
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

/// Every watched file but `*_tests.rs`: its repo-relative path and its
/// `non_test_text`.
fn watched_texts() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for w in WATCHED {
        assert!(root.join(w).exists(), "watched path missing: {w}");
    }
    let mut files = Vec::new();
    for w in WATCHED { rust_files(&root.join(w), &mut files); }
    files.retain(|f| !f.to_string_lossy().ends_with("_tests.rs"));
    files
        .iter()
        .map(|f| {
            let rel = f.strip_prefix(root).unwrap().display().to_string().replace('\\', "/");
            (rel, non_test_text(&std::fs::read_to_string(f).unwrap()))
        })
        .collect()
}

/// Every watched file with a forbidden token, keyed by its repo-relative
/// path, with its `line: text` hits.
fn offenders() -> BTreeMap<String, Vec<String>> {
    let mut hits: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (rel, text) in watched_texts() {
        for (n, line) in text.lines().enumerate() {
            if FORBIDDEN.iter().any(|t| line.contains(t)) {
                hits.entry(rel.clone()).or_default().push(format!("{}: {}", n + 1, line.trim()));
            }
        }
    }
    hits
}

/// The `use` statements of `text`, each from its `use` to its `;` joined
/// onto one line, with the 1-based line it starts on.
fn use_statements(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut open: Option<(usize, String)> = None;
    for (n, line) in text.lines().enumerate() {
        let t = line.trim();
        if open.is_none() {
            let bare = t.trim_start_matches("pub(crate) ").trim_start_matches("pub(super) ").trim_start_matches("pub ");
            if !bare.starts_with("use ") {
                continue;
            }
            open = Some((n + 1, String::new()));
        }
        let (start, mut stmt) = open.take().unwrap();
        stmt.push_str(t);
        stmt.push(' ');
        if t.contains(';') {
            out.push((start, stmt));
        } else {
            open = Some((start, stmt));
        }
    }
    out
}

/// Whether the `use` statement `stmt` brings in an item of `message_store`
/// (`message_store::write`, `message_store::{list, write}`, a glob) or
/// renames the module (`message_store as store`). Either hides a writer
/// call from `vault_registry_guard`, which sees a store writer only by its
/// path (`message_store::write(`). Importing the module itself is fine.
fn imports_store_item(stmt: &str) -> bool {
    stmt.contains("message_store::") || stmt.contains("message_store as ")
}

/// Store calls stay path-qualified everywhere but in the store itself,
/// owners included (`vault_files` calls the crate-private writers).
#[test]
fn no_store_item_imports() {
    let mut hits = Vec::new();
    for (rel, text) in watched_texts() {
        if rel == "src-core/src/message_store.rs" {
            continue;
        }
        for (n, stmt) in use_statements(&text) {
            if imports_store_item(&stmt) {
                hits.push(format!("{rel}:{n}: {}", stmt.trim()));
            }
        }
    }
    assert!(
        hits.is_empty(),
        "imports of message_store items (call them as `message_store::name(` instead, so vault_registry_guard sees every store writer):\n{}",
        hits.join("\n")
    );
}

/// Non-vacuity for `no_store_item_imports`, on synthetic sources.
#[test]
fn the_import_matcher_catches_store_items_and_aliases() {
    let caught = [
        "use mailvault_core::message_store::write;\n",
        "use crate::message_store::{list, write};\n",
        "pub(crate) use crate::message_store::*;\n",
        "use mailvault_core::message_store as store;\n",
        "use mailvault_core::{\n    header_cache,\n    message_store::write_replacing,\n};\n",
    ];
    for src in caught {
        let stmts = use_statements(src);
        assert_eq!(stmts.len(), 1, "one statement: {src}");
        assert!(imports_store_item(&stmts[0].1), "must be caught: {src}");
    }
    let fine = [
        "use crate::message_store;\n",
        "use mailvault_core::{header_cache, message_store};\n",
        "use mailvault_core::{\n    graph_ledger,\n    message_store,\n};\n",
        "    let e = message_store::write(root, a, m, uid, raw, f)?;\n",
    ];
    for src in fine {
        assert!(!use_statements(src).iter().any(|(_, s)| imports_store_item(s)), "must pass: {src}");
    }
    assert_eq!(use_statements("fn f() {}\nuse a::{\n    b,\n};\n")[0].0, 2, "a statement keeps the line it starts on");
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
