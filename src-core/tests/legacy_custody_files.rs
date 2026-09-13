//! No non-test Rust source outside the custody import names a legacy custody
//! file. A writer left on the old format is how v2.5.0 produced four months
//! of misnamed vault files; this fails the build the day one comes back.
use std::path::{Path, PathBuf};

const LITERALS: [&str; 2] = ["local-index.json", "archived_headers.json"];
const ALLOWED: [&str; 1] = ["src-core/src/custody/import.rs"];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// The text before the first test module (`#[cfg(test)]` followed by a `mod`
/// or `#[path` line). A `#[cfg(test)]` on a lone helper fn does not end it.
fn non_test_text(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        if line.trim() == "#[cfg(test)]" {
            let next = lines.get(i + 1).map(|l| l.trim_start()).unwrap_or("");
            if next.starts_with("mod ") || next.starts_with("#[path") {
                end = i;
                break;
            }
        }
    }
    lines[..end].join("\n")
}

#[test]
fn no_source_outside_the_custody_import_names_a_legacy_custody_file() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-core sits in the repo root");
    let mut files = vec![];
    for d in ["src-core/src", "src-tauri/src", "src-daemon/src"] {
        rust_files(&repo.join(d), &mut files);
    }
    assert!(
        files.len() > 50,
        "walked only {} files: wrong root?",
        files.len()
    );
    let mut hits = vec![];
    for f in files {
        let rel = f
            .strip_prefix(repo)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if ALLOWED.contains(&rel.as_str()) {
            continue;
        }
        let src = std::fs::read_to_string(&f).unwrap();
        for (n, line) in non_test_text(&src).lines().enumerate() {
            if LITERALS.iter().any(|l| line.contains(l)) {
                hits.push(format!("{rel}:{}: {}", n + 1, line.trim()));
            }
        }
    }
    assert!(
        hits.is_empty(),
        "a legacy custody file is named outside the import:\n{}",
        hits.join("\n")
    );
}
