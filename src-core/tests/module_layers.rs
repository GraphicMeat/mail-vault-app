//! Module layering of `src-core/src`: the lower module of each pair below must
//! not name the higher one in non-test code. A back-reference turns the two
//! into one cycle, and a cycle of fifteen files cannot be understood or moved
//! piece by piece.
//!
//! Intended order, low to high:
//! - storage: `fsx`/`paths`, then the format modules (`maildir`, `jmap_store`,
//!   `vault_eml`), then `message_store` as the one facade, then the index
//!   (`search_index`) and custody/registry (`vault_registry`);
//! - protocol: the `app_db` tables, `imap`, `smtp` and the plain-data leaves
//!   they share, then `bulk_worker`, `compose_prep`, `aliases`.
//!
//! Known edge left in place: `maildir::repair_generation` calls
//! `message_store::demote_records` (a JMAP mailbox's records become Maildir
//! files before the repair renames by file name). Removing it needs the daemon
//! to call a new entry point, which is a public-path change. It is not in the
//! table, so it is not enforced, and is the next edge to cut.

use std::path::{Path, PathBuf};

/// `(file or directory under src-core/src, module it must not reference)`.
/// A directory row covers every `.rs` file below it.
const FORBIDDEN: &[(&str, &str)] = &[
    // Storage: formats do not reach up to the facade or to each other's builders.
    ("maildir.rs", "vault_files"),
    ("maildir.rs", "vault_eml"),
    // Storage: the registry lists through a leaf, not through the index.
    ("vault_registry.rs", "search_index"),
    // Protocol: transports do not reach up to the coordinators and composers.
    ("imap/mod.rs", "bulk_worker"),
    ("smtp.rs", "compose_prep"),
    ("smtp.rs", "aliases"),
    // Protocol: the tables sit below the bulk coordinator and the journal.
    ("app_db", "bulk_worker"),
    ("app_db", "op_journal"),
];

fn rust_files(p: &Path, out: &mut Vec<PathBuf>) {
    if p.is_file() {
        if p.extension().is_some_and(|e| e == "rs") {
            out.push(p.to_path_buf());
        }
        return;
    }
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            rust_files(&e.path(), out);
        }
    }
}

/// The file's code before its first `#[cfg(test)]` that opens a `mod`, with
/// `//` comments (whole-line and trailing) blanked.
fn non_test_code(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        if line.trim() == "#[cfg(test)]" && lines.get(i + 1).is_some_and(|n| n.trim_start().starts_with("mod ") || n.trim_start().starts_with("pub mod ")) {
            break;
        }
        let code = line.find("//").map_or(*line, |at| &line[..at]);
        out.push_str(code);
        out.push('\n');
    }
    out
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether `code` names crate module `module`: `crate::module` as a path
/// segment, or `module` as a top-level item of a `crate::{ ... }` group.
fn references(code: &str, module: &str) -> bool {
    let direct = format!("crate::{module}");
    let mut from = 0;
    while let Some(at) = code[from..].find(&direct) {
        let end = from + at + direct.len();
        if !code[end..].chars().next().is_some_and(is_ident) {
            return true;
        }
        from = end;
    }
    let mut from = 0;
    while let Some(at) = code[from..].find("crate::{") {
        let start = from + at + "crate::{".len();
        let mut depth = 1;
        let mut item = String::new();
        let mut items = Vec::new();
        for c in code[start..].chars() {
            match c {
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                break;
            }
            if depth == 1 && c == ',' {
                items.push(std::mem::take(&mut item));
            } else {
                item.push(c);
            }
        }
        items.push(item);
        let first = |s: &str| s.trim_start().chars().take_while(|c| is_ident(*c)).collect::<String>();
        if items.iter().any(|i| first(i) == module) {
            return true;
        }
        from = start;
    }
    false
}

#[test]
fn lower_modules_do_not_reference_higher_ones() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut failures = Vec::new();
    for (target, module) in FORBIDDEN {
        let mut files = Vec::new();
        rust_files(&src.join(target), &mut files);
        assert!(!files.is_empty(), "row ({target}, {module}) names no source file");
        for file in files {
            let code = non_test_code(&std::fs::read_to_string(&file).unwrap());
            if references(&code, module) {
                let shown = file.strip_prefix(&src).unwrap_or(&file).display();
                failures.push(format!("{shown} must not reference crate::{module} (row {target} -> {module})"));
            }
        }
    }
    assert!(failures.is_empty(), "back-references:\n{}", failures.join("\n"));
}

#[test]
fn the_reference_scanner_sees_path_and_group_forms() {
    assert!(references("use crate::maildir::x;", "maildir"));
    assert!(references("let a = crate::maildir::x();", "maildir"));
    assert!(references("use crate::{bulk_worker::bytes_hash, maildir};", "maildir"));
    assert!(references("use crate::{bulk_worker::bytes_hash, maildir};", "bulk_worker"));
    assert!(references("use crate::{\n    a,\n    maildir::{self, y},\n};", "maildir"));
    assert!(!references("use crate::maildir_extra::x;", "maildir"));
    assert!(!references("use crate::{maildir_extra, a::maildir};", "maildir"));
    assert!(non_test_code("// crate::maildir::x\nlet a = 1; // crate::maildir\n").find("maildir").is_none());
    assert!(non_test_code("fn a() {}\n#[cfg(test)]\nmod tests {\n use crate::maildir;\n}\n").find("maildir").is_none());
    assert!(non_test_code("#[cfg(test)]\nthread_local! {}\nuse crate::maildir;\n").contains("crate::maildir"));
}

/// Whether `code` compares an `oauth2_transport` field against the literal
/// `"graph"` on one line (the raw provider test that `ImapConfig::transport`
/// replaces).
fn compares_oauth2_transport_to_graph(code: &str) -> bool {
    code.lines().any(|l| l.contains("oauth2_transport") && l.contains("\"graph\""))
}

#[test]
fn only_imap_mod_compares_oauth2_transport_to_graph() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut failures = Vec::new();
    for file in files {
        let shown = file.strip_prefix(&src).unwrap_or(&file).to_path_buf();
        if shown == Path::new("imap/mod.rs") {
            continue;
        }
        let code = non_test_code(&std::fs::read_to_string(&file).unwrap());
        if compares_oauth2_transport_to_graph(&code) {
            failures.push(shown.display().to_string());
        }
    }
    assert!(failures.is_empty(), "pick the provider with ImapConfig::transport() / Transport::from_fields, not a raw compare:\n{}", failures.join("\n"));
}

#[test]
fn the_graph_compare_scanner_sees_the_raw_forms() {
    assert!(compares_oauth2_transport_to_graph("if a.oauth2_transport.as_deref() == Some(\"graph\") {"));
    assert!(compares_oauth2_transport_to_graph("self.oauth2_transport == Some(\"graph\".into())"));
    assert!(!compares_oauth2_transport_to_graph("let t = a.oauth2_transport.clone();"));
    assert!(!compares_oauth2_transport_to_graph("let s = \"graph\";"));
}

/// Whether `code` defines a free or associated `fn <name>`. With `zero_arg`,
/// only a definition that takes no parameters counts: `fn now_ms(&self)` is a
/// clock trait method, not a second wall clock.
fn defines_fn(code: &str, name: &str, zero_arg: bool) -> bool {
    let needle = format!("fn {name}");
    let mut from = 0;
    while let Some(at) = code[from..].find(&needle) {
        let start = from + at;
        let end = start + needle.len();
        let before_ok = !code[..start].chars().next_back().is_some_and(is_ident);
        let rest = &code[end..];
        let after_ok = !rest.chars().next().is_some_and(is_ident);
        if before_ok && after_ok {
            if !zero_arg {
                return true;
            }
            let rest = rest.trim_start();
            if let Some(args) = rest.strip_prefix('(') {
                if args.trim_start().starts_with(')') {
                    return true;
                }
            }
        }
        from = end;
    }
    false
}

/// `(file under src-core/src, function, why it may define it)`. A file listed
/// here is the shared definition itself, or a variant that accepts other
/// inputs or answers another type than the shared one.
const MAY_DEFINE: &[(&str, &str, &str)] = &[
    ("clock.rs", "now_ms", "the shared wall clock"),
    ("js_value.rs", "truthy", "the shared JS truthiness"),
    ("sender_check.rs", "truthy", "variant: a non-empty STRING of an Option<&Value>, returns Option<&str>"),
    ("custody/probe.rs", "truthy", "variant: a non-empty STRING field of an entry by key, returns Option<&str>"),
    ("maildir.rs", "flag_letter", "the one word-to-letter mapping (jmap_store re-uses it)"),
];

#[test]
fn the_wall_clock_truthiness_and_flag_letter_are_defined_once() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut failures = Vec::new();
    for file in files {
        let shown = file.strip_prefix(&src).unwrap_or(&file).to_string_lossy().replace('\\', "/");
        let code = non_test_code(&std::fs::read_to_string(&file).unwrap());
        for (name, zero_arg) in [("now_ms", true), ("truthy", false), ("letter_of", false), ("flag_letter", false)] {
            if defines_fn(&code, name, zero_arg) && !MAY_DEFINE.iter().any(|(f, n, _)| *f == shown && *n == name) {
                failures.push(format!("{shown} defines its own fn {name}: use the shared one (crate::clock, crate::js_value, crate::maildir::flag_letter)"));
            }
        }
    }
    assert!(failures.is_empty(), "duplicated helpers:\n{}", failures.join("\n"));
}

#[test]
fn every_may_define_row_is_still_needed() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for (file, name, why) in MAY_DEFINE {
        let code = non_test_code(&std::fs::read_to_string(src.join(file)).unwrap_or_else(|_| panic!("{file} is gone: drop its row")));
        assert!(defines_fn(&code, name, *name == "now_ms"), "{file} no longer defines {name} ({why}): drop its row");
    }
}

#[test]
fn the_fn_scanner_sees_definitions_and_skips_methods_with_arguments() {
    assert!(defines_fn("fn now_ms() -> i64 {", "now_ms", true));
    assert!(defines_fn("pub fn now_ms ( ) -> u64 {", "now_ms", true));
    assert!(!defines_fn("fn now_ms(&self) -> i64 {", "now_ms", true), "a clock method has a receiver");
    assert!(!defines_fn("fn now_ms_u64() -> u64 {", "now_ms", true), "a longer name is another fn");
    assert!(!defines_fn("fn my_now_ms() {", "now_ms", true));
    assert!(defines_fn("fn truthy(v: Option<&Value>) -> bool {", "truthy", false));
    assert!(defines_fn("fn truthy<'a>(e: &'a Value) -> Option<&'a str> {", "truthy", false));
    assert!(!defines_fn("fn truthy_value(v: &Value) -> bool {", "truthy", false));
}
