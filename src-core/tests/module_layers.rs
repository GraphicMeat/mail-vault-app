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

/// The file's code without its `#[cfg(test)]` modules, with `//` comments
/// (whole-line and trailing) blanked. A test module ends at the first `}`
/// line indented like its `mod` line (rustfmt's layout); one that never
/// closes that way runs to the end of the file. Code after a small test
/// helper module is still production code and is still scanned.
fn non_test_code(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let indent = |l: &str| l.len() - l.trim_start().len();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim() == "#[cfg(test)]" && lines.get(i + 1).is_some_and(|n| n.trim_start().starts_with("mod ") || n.trim_start().starts_with("pub mod ")) {
            let head = lines[i + 1];
            if head.trim_end().ends_with(';') {
                i += 2;
                continue;
            }
            let close = (i + 2..lines.len()).find(|&j| lines[j].trim() == "}" && indent(lines[j]) == indent(head));
            match close {
                Some(j) => {
                    i = j + 1;
                    continue;
                }
                None => break,
            }
        }
        let code = line.find("//").map_or(line, |at| &line[..at]);
        out.push_str(code);
        out.push('\n');
        i += 1;
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
    let after_helper = "#[cfg(test)]\nmod pause {\n    use crate::a;\n    fn f() {\n    }\n}\nuse crate::maildir;\n#[cfg(test)]\nmod tests {\n    use crate::b;\n}\n";
    let seen = non_test_code(after_helper);
    assert!(seen.contains("crate::maildir"), "code after a test helper module is production code");
    assert!(!seen.contains("crate::a") && !seen.contains("crate::b"), "{seen}");
    assert!(non_test_code("#[cfg(test)]\nmod tests;\nuse crate::maildir;\n").contains("crate::maildir"));
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

/// Source roots of the Rust crates that read the wall clock: core, daemon and
/// the Tauri shell.
fn clock_scanned_roots() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    ["src-core/src", "src-daemon/src", "src-tauri/src"].iter().map(|r| root.join(r)).collect()
}

/// What a source line (comments dropped) defines or reads that
/// `mailvault_core::clock` owns: a day or hour length constant of a number
/// type, a zero-argument `now_ms` / `now_millis`, or the epoch milliseconds
/// taken straight from `SystemTime::now()` or `Utc::now()`.
fn clock_copies(src: &str) -> Vec<String> {
    let constant = regex::Regex::new(r"\bconst\s+(DAY_MS|HOUR_MS|MINUTE_MS|DAY|HOUR)\s*:\s*(i64|u64|i32|u32|usize|f64)\b").unwrap();
    let direct = regex::Regex::new(r"SystemTime::now\(\)\s*\.duration_since\(\s*(?:std::time::)?(?:SystemTime::)?UNIX_EPOCH\s*\)[^;]*?\.as_millis\(\)").unwrap();
    let code: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    let mut found = Vec::new();
    for m in constant.find_iter(&code) {
        // `const DAY: u64 = clock::DAY_MS as u64;` only retypes the shared one.
        let statement = code[m.start()..].split(';').next().unwrap_or("");
        if !statement.contains("clock::") {
            found.push(m.as_str().to_string());
        }
    }
    for name in ["now_ms", "now_millis"] {
        if defines_fn(&code, name, true) {
            found.push(format!("fn {name}()"));
        }
    }
    for m in direct.find_iter(&code) {
        found.push(m.as_str().split_whitespace().collect::<Vec<_>>().join(" "));
    }
    if code.contains("Utc::now().timestamp_millis()") {
        found.push("Utc::now().timestamp_millis()".to_string());
    }
    found
}

#[test]
fn time_constants_and_the_wall_clock_live_in_clock_only() {
    let mut failures = Vec::new();
    for root in clock_scanned_roots() {
        let mut files = Vec::new();
        rust_files(&root, &mut files);
        assert!(!files.is_empty(), "{} holds no source", root.display());
        for file in files {
            let shown = file.to_string_lossy().replace('\\', "/");
            if shown.ends_with("src-core/src/clock.rs") {
                continue;
            }
            for copy in clock_copies(&std::fs::read_to_string(&file).unwrap()) {
                failures.push(format!("{shown}: {copy}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "use mailvault_core::clock::{{DAY_MS, HOUR_MS, now_ms, now_ms_u64}} instead of a local copy:\n{}",
        failures.join("\n")
    );
}

#[test]
fn the_clock_copy_scanner_sees_each_form_and_skips_the_legitimate_ones() {
    assert_eq!(clock_copies("const DAY_MS: i64 = 24 * 60 * 60 * 1000;").len(), 1);
    assert_eq!(clock_copies("    pub const HOUR_MS: u64 = 3_600_000;").len(), 1);
    assert_eq!(clock_copies("const DAY: f64 = 1.0;").len(), 1);
    assert_eq!(clock_copies("fn now_ms() -> i64 { 0 }").len(), 1);
    assert_eq!(clock_copies("fn now_millis() -> u64 { 0 }").len(), 1);
    assert_eq!(clock_copies("let n = std::time::SystemTime::now()\n    .duration_since(std::time::UNIX_EPOCH)\n    .unwrap()\n    .as_millis() as i64;").len(), 1);
    assert_eq!(clock_copies("let n = chrono::Utc::now().timestamp_millis();").len(), 1);
    assert!(clock_copies("const DAY: Duration = Duration::from_secs(86_400);").is_empty(), "a Duration is not a ms constant");
    assert!(clock_copies("const DAY: u64 = mailvault_core::clock::DAY_MS as u64;").is_empty(), "a retyped use of the shared constant is fine");
    assert!(clock_copies("const DAY: &str = \"2026-09-29\";").is_empty());
    assert!(clock_copies("fn now_ms(&self) -> i64;").is_empty(), "an injectable clock method is not a second wall clock");
    assert!(clock_copies("// const DAY_MS: i64 = 1;").is_empty());
    assert!(clock_copies("let s = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();").is_empty(), "seconds are not epoch ms");
    assert!(clock_copies("let m = meta.modified().duration_since(UNIX_EPOCH).as_millis();").is_empty(), "a file mtime is not the clock");
}

/// What a source line (comments dropped) does that `crate::provider` owns:
/// compares a provider's name or host (`== "google"`, `"imap.gmail.com" ==`,
/// `"microsoft" =>`) or looks for one inside a host (`.contains("gmail")`).
/// A literal counts when one of its dot-separated labels is a provider word,
/// so `"[gmail]/trash"` (a folder) and `"oauth2_google_clients"` (an RPC
/// name) do not.
fn provider_checks(code: &str) -> Vec<String> {
    let lit = r#""\.?(?:[a-z0-9-]+\.)*(?:gmail|googlemail|google|outlook|hotmail|office365|microsoft|yahoo|yahoodns|icloud)(?:\.[a-z0-9-]+)*""#;
    let check = regex::Regex::new(&format!(
        r"(?i)(?:==|!=)\s*&?{lit}|{lit}\s*(?:==|!=|=>)|\.(?:contains|starts_with|ends_with|eq_ignore_ascii_case|strip_suffix)\(\s*&?{lit}"
    ))
    .unwrap();
    code.lines().filter(|l| check.is_match(l)).map(|l| l.trim().to_string()).collect()
}

/// `(file, text on the line, why it may compare a provider word itself)`.
/// Each row is an ADDRESS-domain rule (what an email address's domain means),
/// not which provider serves a host or an account.
const MAY_CHECK_PROVIDER: &[(&str, &str, &str)] = &[
    ("src-core/src/log_redact.rs", "=>", "an address domain to its log token (`<gmail#..>`), country domains included"),
    ("src-core/src/aliases.rs", "domain !=", "Gmail's address identity (dots and +tag ignored), mirrors src/utils/emailIdentity.js"),
];

/// Source roots scanned for provider checks: core, daemon and the shell.
fn provider_scanned_files() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut out = Vec::new();
    for r in ["src-core/src", "src-daemon/src", "src-tauri/src"] {
        let mut files = Vec::new();
        rust_files(&root.join(r), &mut files);
        assert!(!files.is_empty(), "{r} holds no source");
        for file in files {
            let shown = format!("{r}/{}", file.strip_prefix(root.join(r)).unwrap().to_string_lossy().replace('\\', "/"));
            // Whole-file test modules carry no `#[cfg(test)]` of their own.
            if shown.ends_with("tests.rs") || shown == "src-core/src/provider.rs" {
                continue;
            }
            out.push((shown, non_test_code(&std::fs::read_to_string(&file).unwrap())));
        }
    }
    out
}

#[test]
fn provider_identity_is_decided_in_provider_rs_only() {
    let mut failures = Vec::new();
    for (shown, code) in provider_scanned_files() {
        for line in provider_checks(&code) {
            if !MAY_CHECK_PROVIDER.iter().any(|(f, needle, _)| *f == shown && line.contains(needle)) {
                failures.push(format!("{shown}: {line}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "decide the provider with mailvault_core::provider::Provider (from_host, from_tag, owns_account), not a local compare:\n{}",
        failures.join("\n")
    );
}

#[test]
fn every_may_check_provider_row_is_still_needed() {
    let files = provider_scanned_files();
    for (file, needle, why) in MAY_CHECK_PROVIDER {
        let (_, code) = files.iter().find(|(f, _)| f == file).unwrap_or_else(|| panic!("{file} is gone: drop its row"));
        assert!(provider_checks(code).iter().any(|l| l.contains(needle)), "{file} no longer checks a provider word ({why}): drop its row");
    }
}

#[test]
fn the_provider_check_scanner_sees_each_form_and_skips_the_legitimate_ones() {
    for hit in [
        r#"if host.contains("gmail") || host.contains("googlemail") {"#,
        r#"} else if mx.contains("outlook.com") || mx.contains("microsoft.com") {"#,
        r#"let google = text("oauth2Provider") == "google";"#,
        r#"if provider_name == "microsoft" {"#,
        r#"host == "imap.gmail.com" || host == "imap.googlemail.com""#,
        r#""google" => {"#,
        r#".is_none_or(|p| p == "microsoft")"#,
        r#"if h.ends_with(".yahoo.com") {"#,
        r#"if h.eq_ignore_ascii_case("IMAP.GMAIL.COM") {"#,
    ] {
        assert_eq!(provider_checks(hit).len(), 1, "{hit}");
    }
    for miss in [
        r#"|| lower.starts_with("[gmail]/trash")"#,
        r#""oauth2_google_clients" => RpcResponse::success("#,
        r#"json!({"oauth2Provider": "google", "imapHost": "imap.gmail.com"})"#,
        r#"provider: "google","#,
        r#""outlook.com","#,
        r#"Provider::from_host(host) == Some(Provider::Google)"#,
        r#"let p = "outlook";"#,
    ] {
        assert!(provider_checks(miss).is_empty(), "{miss}");
    }
}

/// Source roots that read the settings document: core, daemon and the shell.
fn settings_scanned_files() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut out = Vec::new();
    for r in ["src-core/src", "src-daemon/src", "src-tauri/src"] {
        let mut files = Vec::new();
        rust_files(&root.join(r), &mut files);
        assert!(!files.is_empty(), "{r} holds no source");
        for file in files {
            let shown = format!("{r}/{}", file.strip_prefix(root.join(r)).unwrap().to_string_lossy().replace('\\', "/"));
            if shown.ends_with("tests.rs") || shown == "src-core/src/settings_doc.rs" {
                continue;
            }
            out.push((shown, non_test_code(&std::fs::read_to_string(&file).unwrap())));
        }
    }
    out
}

/// The frontend settings store's persist name is the key every Rust reader
/// looks under. It is spelled once, as `settings_doc::STORE`, which a vitest
/// (`src/stores/__tests__/settingsStoreRustKey.test.js`) pins to the Zustand
/// store: a rename on either side then fails a test instead of reading "off".
#[test]
fn the_settings_store_key_is_spelled_in_settings_doc_only() {
    let failures: Vec<String> = settings_scanned_files()
        .into_iter()
        .filter(|(_, code)| code.contains("\"mailvault-settings\""))
        .map(|(shown, _)| shown)
        .collect();
    assert!(
        failures.is_empty(),
        "read the settings store through mailvault_core::settings_doc::{{STORE, app_state}}, not the literal:\n{}",
        failures.join("\n")
    );
}
