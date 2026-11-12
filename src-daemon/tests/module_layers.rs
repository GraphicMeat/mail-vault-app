//! Layering of the daemon crate: state sits below the socket server.
//!
//! `DaemonState` lives in `state.rs`; `server.rs` keeps only socket accept and
//! request dispatch. Handlers, jobs and workers must not import `server`, or
//! the whole daemon collapses back into one module cycle.
use std::path::{Path, PathBuf};

#[path = "../../src-core/tests/support/rust_scan.rs"]
mod rust_scan;
use rust_scan::non_test_code;

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn src_files() -> Vec<(String, String)> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut paths = Vec::new();
    rust_files(&src, &mut paths);
    paths
        .into_iter()
        .map(|p| {
            let rel = p.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
            let text = std::fs::read_to_string(&p).unwrap();
            (rel, text)
        })
        .collect()
}

/// True when `text` imports `DaemonState` through `server`, in the path form
/// (`crate::server::DaemonState`, `server::DaemonState` inside a grouped
/// `use crate::{..}`) or the braced form (`crate::server::{.., DaemonState, ..}`).
fn imports_state_from_server(text: &str) -> bool {
    if text.contains("server::DaemonState") {
        return true;
    }
    let mut rest = text;
    while let Some(at) = rest.find("server::{") {
        let tail = &rest[at + "server::{".len()..];
        let group = tail.split('}').next().unwrap_or("");
        if group.split(',').any(|item| item.trim() == "DaemonState") {
            return true;
        }
        rest = tail;
    }
    false
}

#[test]
fn only_the_server_and_main_name_the_server_module_for_state() {
    let offenders: Vec<String> = src_files()
        .into_iter()
        .filter(|(rel, _)| rel != "server.rs" && rel != "main.rs")
        .filter(|(_, text)| imports_state_from_server(text))
        .map(|(rel, _)| rel)
        .collect();
    assert!(
        offenders.is_empty(),
        "import DaemonState from crate::state, not crate::server: {offenders:?}"
    );
}

#[test]
fn handlers_never_import_the_server_module() {
    let offenders: Vec<String> = src_files()
        .into_iter()
        .filter(|(rel, _)| rel.starts_with("handlers/"))
        .filter(|(_, text)| text.lines().any(|l| {
            let code = l.trim_start();
            !code.starts_with("//") && (code.contains("crate::server") || code.contains("super::server"))
        }))
        .map(|(rel, _)| rel)
        .collect();
    assert!(offenders.is_empty(), "handlers must not depend on server: {offenders:?}");
}

#[test]
fn state_module_stands_below_server() {
    let files = src_files();
    let (_, state) = files
        .iter()
        .find(|(rel, _)| rel == "state.rs")
        .expect("src/state.rs holds DaemonState");
    assert!(state.contains("pub struct DaemonState"), "DaemonState is defined in state.rs");
    assert!(!state.contains("crate::server"), "state.rs must not reference crate::server");
    let (_, server) = files.iter().find(|(rel, _)| rel == "server.rs").unwrap();
    assert!(
        !server.contains("pub struct DaemonState"),
        "server.rs must not define DaemonState"
    );
}

/// Ratchet: files outside `server.rs` that still reach into `crate::server::`.
/// Lower this when it drops, never raise it.
#[test]
fn server_import_ratchet() {
    const MAX_FILES_NAMING_SERVER: usize = 0;
    // test_support.rs is cfg(test) only and drives the real dispatch, so it may import server.
    let naming: Vec<String> = src_files()
        .into_iter()
        .filter(|(rel, _)| rel != "server.rs" && rel != "test_support.rs")
        .filter(|(_, text)| text.contains("crate::server::"))
        .map(|(rel, _)| rel)
        .collect();
    assert!(
        naming.len() <= MAX_FILES_NAMING_SERVER,
        "{} files name crate::server:: (max {MAX_FILES_NAMING_SERVER}); lower the max when it drops: {naming:?}",
        naming.len()
    );
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether `code` defines a parameterless `fn <name>()`: a second wall clock.
/// `fn now_ms(&self)` or `fn now_ms(state: &DaemonState)` answer from
/// something else and are not copies.
fn defines_zero_arg_fn(code: &str, name: &str) -> bool {
    let needle = format!("fn {name}");
    let mut from = 0;
    while let Some(at) = code[from..].find(&needle) {
        let start = from + at;
        let end = start + needle.len();
        let before_ok = !code[..start].chars().next_back().is_some_and(is_ident);
        let rest = &code[end..];
        if before_ok && !rest.chars().next().is_some_and(is_ident) {
            if let Some(args) = rest.trim_start().strip_prefix('(') {
                if args.trim_start().starts_with(')') {
                    return true;
                }
            }
        }
        from = end;
    }
    false
}

/// Daemon files that may define `fn now_ms()`, each with the reason. Empty:
/// the daemon reads `mailvault_core::clock` (or `job_support::now_ms`, its
/// unsigned re-export).
const MAY_DEFINE_NOW_MS: &[(&str, &str)] = &[];

#[test]
fn the_daemon_defines_no_wall_clock_of_its_own() {
    let offenders: Vec<String> = src_files()
        .into_iter()
        .filter(|(rel, _)| !MAY_DEFINE_NOW_MS.iter().any(|(f, _)| f == rel))
        .filter(|(_, text)| defines_zero_arg_fn(&non_test_code(text), "now_ms"))
        .map(|(rel, _)| rel)
        .collect();
    assert!(offenders.is_empty(), "use mailvault_core::clock::now_ms (or crate::job_support::now_ms for u64): {offenders:?}");
}

/// Whether `code` compares an `oauth2_transport` field against the literal
/// `"graph"` on one line: the raw provider test `ImapConfig::transport()` /
/// `uses_graph()` replace.
fn compares_oauth2_transport_to_graph(code: &str) -> bool {
    code.lines().any(|l| l.contains("oauth2_transport") && l.contains("\"graph\""))
}

/// Daemon files that may still compare `oauth2_transport` to `"graph"`, with
/// the reason. Empty: a Graph-only guard says `uses_graph()`, a JMAP-then-Graph
/// ladder is a `match cfg.transport()`.
const MAY_COMPARE_GRAPH: &[(&str, &str)] = &[];

#[test]
fn the_daemon_picks_the_provider_through_the_transport_not_a_raw_compare() {
    let offenders: Vec<String> = src_files()
        .into_iter()
        .filter(|(rel, _)| !MAY_COMPARE_GRAPH.iter().any(|(f, _)| f == rel))
        .filter(|(_, text)| compares_oauth2_transport_to_graph(&non_test_code(text)))
        .map(|(rel, _)| rel)
        .collect();
    assert!(offenders.is_empty(), "use cfg.uses_graph() / cfg.transport(), not oauth2_transport == \"graph\": {offenders:?}");
}

#[test]
fn the_daemon_scanners_see_the_raw_forms() {
    assert!(defines_zero_arg_fn("fn now_ms() -> i64 {", "now_ms"));
    assert!(defines_zero_arg_fn("pub(crate) fn now_ms () -> u64 {", "now_ms"));
    assert!(!defines_zero_arg_fn("fn now_ms(state: &DaemonState) -> i64 {", "now_ms"));
    assert!(!defines_zero_arg_fn("fn now_ms(&self) -> i64 {", "now_ms"));
    assert!(!defines_zero_arg_fn("pub(crate) use mailvault_core::clock::now_ms;", "now_ms"));
    assert!(compares_oauth2_transport_to_graph("if config.oauth2_transport.as_deref() == Some(\"graph\") {"));
    assert!(!compares_oauth2_transport_to_graph("let t = config.oauth2_transport.clone();"));
    assert!(!compares_oauth2_transport_to_graph("row.get(\"oauth2Transport\") == Some(\"graph\")"));
    rust_scan::assert_non_test_code_sees_production_code();
}
