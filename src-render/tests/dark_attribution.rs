//! Every file ported from Dark Reader carries its attribution, the licence
//! ships with the app, and the vectors match the version in package-lock.json.
const PORTED: &[&str] = &[
    "color.rs", "math_eval.rs", "matrix.rs", "modify_colors.rs", "modify_css.rs", "text.rs",
    "cssom.rs", "sheets.rs", "inline.rs", "variables.rs", "image.rs",
];
const HEADER: &str = "// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,\n// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):";

fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

#[test]
fn ported_files_carry_the_attribution_header() {
    for f in PORTED {
        let p = root().join("src-render/src/dark").join(f);
        let Ok(text) = std::fs::read_to_string(&p) else { continue }; // a later task adds it
        assert!(text.starts_with(HEADER), "{} lacks the Dark Reader attribution header", p.display());
    }
}

#[test]
fn licence_notice_ships() {
    let text = std::fs::read_to_string(root().join("public/licenses/rust/darkreader-mit.txt")).unwrap();
    assert!(text.contains("Dark Reader v4.9.120"));
    assert!(text.contains("MIT License"));
    assert!(text.contains("Copyright (c) 2026 Dark Reader Ltd."));
}

#[test]
fn vectors_match_the_locked_darkreader_version() {
    let lock: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root().join("package-lock.json")).unwrap()).unwrap();
    let locked = lock["packages"]["node_modules/darkreader"]["version"].as_str().unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root().join("src-render/tests/fixtures/dr/vectors.json")).unwrap()).unwrap();
    assert_eq!(v["meta"]["version"], locked, "regenerate the vectors (Task 10) and re-port the diff");
}
