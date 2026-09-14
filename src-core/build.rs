//! MAILVAULT_BUILD_ID: one value for the app and the daemon, because both read it
//! from this crate. Env var first (release scripts, runner clones without .git),
//! then `git rev-parse --short HEAD` plus `-dirty`, then "dev".
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=MAILVAULT_BUILD_ID");
    let id = match std::env::var("MAILVAULT_BUILD_ID") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => match git(&["rev-parse", "--short", "HEAD"]) {
            Some(sha) => {
                // Rebuild when HEAD moves (checkout, commit, merge, reset). `--git-path`
                // resolves through a worktree's `.git` file to the real per-worktree
                // gitdir on its own, so there's no need to parse `.git` by hand here.
                // Watch `logs/HEAD` rather than the branch ref file: `git gc` packs loose
                // refs away, and a watched path that vanishes forces a rebuild on every
                // build forever. `logs/HEAD` is appended to (never removed) by every
                // commit/checkout/merge/reset, so it stays a stable, always-present signal.
                if let Some(p) = git(&["rev-parse", "--git-path", "HEAD"]) {
                    println!("cargo:rerun-if-changed={p}");
                }
                if let Some(p) = git(&["rev-parse", "--git-path", "logs/HEAD"]) {
                    println!("cargo:rerun-if-changed={p}");
                }
                // ponytail: `-dirty` is read only when this script reruns; watching the
                // index would rebuild on every `git status`.
                let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
                if dirty { format!("{sha}-dirty") } else { sha }
            }
            None => "dev".to_string(),
        },
    };
    println!("cargo:rustc-env=MAILVAULT_BUILD_ID={id}");
}
