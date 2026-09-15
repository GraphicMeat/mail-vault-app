#![cfg(not(target_os = "macos"))]
//! The daemon re-execs itself as `mailvault-daemon --extract-pdf` so a
//! pdf-extract panic kills a child, not the index worker.
use std::io::Write;

#[test]
fn extract_pdf_subprocess_mode_reads_stdin_writes_stdout() {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hello.pdf")).unwrap();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_mailvault-daemon"))
        .arg("--extract-pdf")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&bytes).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("Hello"));
}
