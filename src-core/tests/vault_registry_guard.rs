//! Every vault writer keeps the vault registry current.
//!
//! The registry's contract (`src-core/src/vault_registry.rs` module doc):
//! "Writers update the rows themselves right after their fs op (`upsert`,
//! `rename`, `remove`); structural changes `invalidate`." A writer that skips
//! it leaves the registry answering for a file that is gone, or missing one
//! that is there, until the daemon restarts.
//!
//! The rule, per non-test `fn` body (from its opening `{`, brace-matched) in
//! `src-core/src` and `src-daemon/src` that either names a vault message dir
//! (`VAULT`, or the word `cur`) and writes a file (`CREATE`, `MOVE`), or
//! calls a `message_store` writer (the `message_store::` needles of `CREATE`
//! and `MOVE`), which needs no vault dir named: the store hides the path.
//! - a body that CREATES a file (`CREATE`) must call `upsert(` on a registry
//!   receiver (`reg.` / `registry.`). An `invalidate` alone does not do:
//!   every create writer today pairs its success-path `upsert` with an
//!   error-path `invalidate`, and dropping the `upsert` is the likely
//!   regression.
//! - a body that only renames or removes (`MOVE`) must call any of `upsert(`,
//!   `rename(`, `reflag(`, `remove(`, `invalidate` on a registry receiver.
//! Anything else is named in `ALLOWED` with a reason, and an `ALLOWED` entry
//! that no longer trips the rule fails too, so the list cannot rot.
//!
//! Known blind spots (the matcher is text, not a parser):
//! - A write inside a helper that takes a bare path (`vault_flags::rename_for`,
//!   `maildir::rename_dir_add_eml`, `do_move`) is invisible: the helper names
//!   no vault dir and its caller holds no fs call. Only the fn that has both
//!   in one body is checked. `message_store`'s own fns are such helpers; their
//!   callers are watched through the `message_store::` needles instead.
//! - A `message_store` writer is seen only when called by that path
//!   (`message_store::write(`, with any `crate::` or `mailvault_core::`
//!   before it): a `use message_store::write` and a bare `write(` call, or an
//!   alias, hides it. A body watched only for a store call also counts its
//!   plain `fs::write(`-style creates as creates.
//! - A registry call anywhere in the body counts, whether or not it follows
//!   the write it answers for, and a registry call in a trailing `//` comment
//!   counts too (only whole-line comments are blanked).
//! - Braces are counted raw: a `'{'` char literal or an unbalanced brace in a
//!   string would misplace a body's end. None exist in non-test code today.
//! - A signature holding `;` before its `{` (an array type `[u8; 4]`) reads
//!   as a declaration and is skipped.
//! - `#[cfg(test)]` is honoured only on an inline `mod x {`; a lone
//!   `#[cfg(test)] fn` is scanned like production code. `*_tests.rs` files
//!   are skipped whole.
//! - `fn ` inside a string literal yields a phantom body, and `ALLOWED` is
//!   keyed by (file, fn name), so a second fn of the same name in an allowed
//!   file is silenced with the first.
use std::path::{Path, PathBuf};

const WATCHED: &[&str] = &["src-core/src", "src-daemon/src"];
const CREATE: &[&str] = &[
    "fs::write(",
    "write_atomic(",
    "fs::copy(",
    "File::create",
    "File::options",
    "OpenOptions",
    "message_store::put(",
    "message_store::write(",
    "message_store::write_replacing(",
    "message_store::write_new(",
    "message_store::copy_in(",
    "message_store::write_named_at(",
    "message_store::commit(",
    "message_store::commit_at(",
    "message_store::commit_replacing(",
];
const MOVE: &[&str] = &[
    "fs::rename(",
    "fsx::retire(",
    "fs::remove_file(",
    "fs::remove_dir_all(",
    "message_store::rename_onto(",
    "message_store::unlink(",
    "message_store::unlink_stale(",
    "message_store::set_flags(",
    "message_store::remove(",
    "message_store::remove_listed(",
    "message_store::rebind_uids(",
    "message_store::set_flags_at(",
    "message_store::set_record_flags(",
    "message_store::unlink_other_format(",
    "message_store::remove_other_format(",
    "message_store::remove_other_format_at(",
];
/// The `CREATE`/`MOVE` needles that are `message_store` writers: one alone
/// makes a body a vault writer.
const STORE: &str = "message_store::";
const VAULT: &[&str] = &["cur_path", "cur_dir", "\"cur\"", "find_by_uid", "find_file_by_uid", "uid_file_map"];
const RECEIVERS: &[&str] = &["reg.", "registry."];

/// `(file, fn, why it needs no registry call of its own)`.
const ALLOWED: &[(&str, &str, &str)] = &[
    ("src-core/src/backup.rs", "sync_locations", "pre-sync copy; its caller vault_uids_after_presync invalidates when a copy into the vault was attempted"),
    ("src-core/src/backup.rs", "purge_backup_files", "removes files from the external mirror's cur/, never the app vault"),
    ("src-core/src/backup.rs", "copy_to_backup", "copies vault files into the external mirror's cur/; it only reads the app vault"),
    ("src-core/src/import_rehome.rs", "record", "writes only the rehome ledger beside cur/, never a message; the renames are carry_out's"),
    ("src-core/src/import_rehome.rs", "carry_out", "moves or sets aside the files record planned; its daemon caller rehome_pass invalidates per chunk when anything moved or failed"),
    ("src-core/src/import_rehome.rs", "replay_into", "replays the rehome ledger onto the vault and the backup mirror; it returns whether the vault moved and its caller vault_uids_after_presync invalidates on that"),
    ("src-core/src/maildir.rs", "migrate_add_eml_extension", "startup rename sweep; daemon main runs it before the registry opens"),
    ("src-core/src/maildir.rs", "repair_generation", "renames and orphans wholesale; its caller maildir_repair_generation invalidates when anything moved"),
    ("src-core/src/maildir.rs", "rebind_uids", "re-files undone deletes under their new uids; its caller vault_rebind_uids invalidates when anything moved"),
    ("src-core/src/pgp.rs", "write_copy", "writes the decrypted copy into .decrypted/ beside cur/, which holds no registry row"),
    ("src-core/src/pgp.rs", "remove_copy", "removes the decrypted copy from .decrypted/ beside cur/, which holds no registry row"),
    ("src-core/src/vault_files.rs", "migrate_json_to_eml", "whole-vault legacy migration; one invalidate_all after the walk"),
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

/// `vault_format_guard.rs`'s `non_test_text` (brace-matched inline
/// `#[cfg(test)] mod x {` skip, one blank per skipped line), plus whole-line
/// `//` comments blanked so prose naming `cur` or the registry counts for
/// nothing.
fn non_test_text(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        if !l.trim_start().starts_with("//") {
            out.push_str(l);
        }
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

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn has_word(t: &str, w: &str) -> bool {
    let b = t.as_bytes();
    t.match_indices(w).any(|(i, _)| {
        let end = i + w.len();
        (i == 0 || !is_ident(b[i - 1])) && (end >= b.len() || !is_ident(b[end]))
    })
}

/// `(name, body)` for every `fn` with a body, the body running from its
/// opening `{` through the matching `}`. Nested fns are yielded too, and are
/// also part of their parent's body.
fn fn_bodies(t: &str) -> Vec<(String, &str)> {
    let b = t.as_bytes();
    let mut out = Vec::new();
    for (i, _) in t.match_indices("fn ") {
        if i > 0 && is_ident(b[i - 1]) {
            continue;
        }
        let name: String = t[i + 3..].trim_start().chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if name.is_empty() {
            continue;
        }
        let Some(k) = t[i..].find(|c| c == '{' || c == ';').map(|k| i + k) else { continue };
        if b[k] == b';' {
            continue;
        }
        let mut depth = 0i32;
        let mut e = k;
        while e < b.len() {
            match b[e] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            e += 1;
        }
        out.push((name, &t[k..(e + 1).min(t.len())]));
    }
    out
}

fn registry_call(body: &str, verbs: &[&str]) -> bool {
    RECEIVERS.iter().any(|r| verbs.iter().any(|v| body.contains(&format!("{r}{v}"))))
}

/// Whether the rule looks at this body at all: it names a vault dir and holds
/// a file write, or it calls a `message_store` writer.
fn inspected(body: &str) -> bool {
    let writes = |store: bool| CREATE.iter().chain(MOVE).any(|w| w.starts_with(STORE) == store && body.contains(w));
    writes(true) || ((VAULT.iter().any(|v| body.contains(v)) || has_word(body, "cur")) && writes(false))
}

fn violation(body: &str) -> Option<&'static str> {
    if !inspected(body) {
        return None;
    }
    if CREATE.iter().any(|w| body.contains(w)) {
        return (!registry_call(body, &["upsert("])).then_some("creates a file without a registry upsert");
    }
    (!registry_call(body, &["upsert(", "rename(", "reflag(", "remove(", "invalidate"])).then_some("renames or removes a file without a registry call")
}

/// `(inspected count, flagged (file, fn, why))` over the watched tree.
fn scan() -> (usize, Vec<(String, String, &'static str)>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for w in WATCHED {
        assert!(root.join(w).exists(), "watched path missing: {w}");
    }
    let mut files = Vec::new();
    for w in WATCHED { rust_files(&root.join(w), &mut files); }
    files.retain(|f| !f.to_string_lossy().ends_with("_tests.rs"));
    files.sort();
    let (mut count, mut flagged) = (0, Vec::new());
    for f in &files {
        let rel = f.strip_prefix(root).unwrap().display().to_string().replace('\\', "/");
        let text = non_test_text(&std::fs::read_to_string(f).unwrap());
        for (name, body) in fn_bodies(&text) {
            if inspected(body) {
                count += 1;
            }
            if let Some(why) = violation(body) {
                flagged.push((rel.clone(), name, why));
            }
        }
    }
    (count, flagged)
}

#[test]
fn every_vault_writer_keeps_the_registry_current() {
    let (count, flagged) = scan();
    // A renamed vault-dir helper would blind the matcher; today it sees 30.
    assert!(count >= 15, "the guard inspected only {count} vault writers; did a VAULT or CREATE/MOVE needle go stale?");
    let bad: Vec<String> = flagged
        .iter()
        .filter(|(f, n, _)| !ALLOWED.iter().any(|(af, an, _)| af == f && an == n))
        .map(|(f, n, why)| format!("{f} {n}: {why}"))
        .collect();
    assert!(
        bad.is_empty(),
        "vault writers that do not keep the registry current (add the registry call, or an ALLOWED entry with a reason):\n{}",
        bad.join("\n")
    );
}

#[test]
fn every_allowed_entry_is_still_needed() {
    let (_, flagged) = scan();
    let stale: Vec<String> = ALLOWED
        .iter()
        .filter(|(af, an, _)| !flagged.iter().any(|(f, n, _)| f == af && n == an))
        .map(|(f, n, _)| format!("{f} {n}"))
        .collect();
    assert!(stale.is_empty(), "ALLOWED entries that no longer trip the guard (fixed, renamed or deleted; drop them):\n{}", stale.join("\n"));
}

/// Non-vacuity on synthetic sources: the matcher finds a writer, flags it
/// without a registry call, passes it with an upsert, and does not accept an
/// invalidate alone for a created file.
#[test]
fn the_matcher_flags_a_create_writer_without_an_upsert() {
    let bare = "fn store(root: &Path) {\n    let cur = cur_path(root, a, m);\n    write_atomic(&cur.join(n), b)?;\n}\n";
    let upserted = bare.replace("b)?;", "b)?;\n    reg.upsert(a, m, uid, &p);");
    let invalidated = bare.replace("b)?;", "b)?;\n    reg.invalidate(a, m);");
    let one = |src: &str| {
        let text = non_test_text(src);
        let bodies = fn_bodies(&text);
        assert_eq!(bodies.len(), 1, "{bodies:?}");
        assert!(inspected(bodies[0].1), "a vault writer must be inspected: {src}");
        violation(bodies[0].1)
    };
    assert!(one(bare).is_some(), "no registry call must be flagged");
    assert_eq!(one(&upserted), None, "an upsert must pass");
    assert!(one(&invalidated).is_some(), "an invalidate alone must not pass for a created file");

    let removed = "fn delete(dir: &Path) {\n    fs::remove_file(dir.join(\"cur\").join(n))?;\n    state.vault_registry.remove(a, m, &[uid]);\n}\n";
    assert_eq!(one(removed), None, "a remove with a registry remove must pass");
    assert!(one(&removed.replace("state.vault_registry.remove", "gone.remove")).is_some(), "a non-registry `.remove(` must not count");

    let in_test_mod = format!("#[cfg(test)]\nmod tests {{\n{bare}}}\n");
    assert!(fn_bodies(&non_test_text(&in_test_mod)).is_empty(), "a test module's fns are skipped");
    let commented = "fn f(p: &Path) {\n    // reg.upsert(a, m, u, &p);\n    fs::write(p.join(\"cur\"), b)?;\n}\n";
    assert!(one(commented).is_some(), "a whole-line comment does not count as a registry call");
}

/// Non-vacuity for the `message_store` needles: a body that calls a store
/// writer is inspected with no vault dir named, a create needs an upsert, and
/// a rename or remove needs any registry call. The path-level helpers
/// `vault_files` calls are watched the same way.
#[test]
fn the_matcher_watches_message_store_writers() {
    let one = |src: &str| {
        let text = non_test_text(src);
        let bodies = fn_bodies(&text);
        assert_eq!(bodies.len(), 1, "{bodies:?}");
        assert!(inspected(bodies[0].1), "a message_store writer must be inspected: {src}");
        violation(bodies[0].1)
    };
    let write = "fn archive(root: &Path) {\n    message_store::write_replacing(root, a, m, uid, raw, f)?;\n}\n";
    assert!(one(write).is_some(), "a store write with no registry call must be flagged");
    assert_eq!(one(&write.replace("f)?;", "f)?;\n    reg.upsert(a, m, uid, &p);")), None, "a store write with an upsert must pass");
    assert!(one(&write.replace("f)?;", "f)?;\n    reg.invalidate(a, m);")).is_some(), "an invalidate alone must not pass for a store write");
    let plain = "fn import(root: &Path) {\n    crate::message_store::write(root, a, m, uid, raw, f)?;\n}\n";
    assert!(one(plain).is_some(), "`message_store::write(` is a create");
    assert_eq!(one(&plain.replace("f)?;", "f)?;\n    state.vault_registry.upsert(a, m, uid, &p);")), None);

    let starred = "fn star(root: &Path) {\n    mailvault_core::message_store::set_flags(root, a, m, uid, f)?;\n    state.vault_registry.rename(a, m, uid, &n);\n}\n";
    assert_eq!(one(starred), None, "a store flag change with a registry rename must pass");
    assert!(one(&starred.replace("state.vault_registry.rename", "names.rename")).is_some(), "a non-registry `.rename(` must not count");
    let removed = "fn drop_uid(root: &Path) {\n    message_store::remove(root, a, m, uid)?;\n    reg.invalidate(a, m);\n}\n";
    assert_eq!(one(removed), None, "a store remove with an invalidate must pass");
    assert!(one(&removed.replace("    reg.invalidate(a, m);\n", "")).is_some(), "a store remove with no registry call must be flagged");

    for call in [
        "message_store::put(&dir, uid, raw, f)?;",
        "message_store::unlink_stale(&dir, &n, &stale);",
        "message_store::rename_onto(&old, uid, f)?;",
        "message_store::unlink(&path, uid)?;",
        "message_store::write_new(root, a, m, uid, raw, f, true)?;",
        "message_store::remove_listed(root, a, m, uid, &listed);",
        "message_store::rebind_uids(root, a, m, &pairs);",
        "message_store::copy_in(&dir, uid, &flags, &src)?;",
        "message_store::set_flags_at(&path, uid, |f| f.to_vec())?;",
        "message_store::write_named_at(&folder, &name, raw)?;",
        "message_store::commit(root, a, m, &prepared, f)?;",
        "message_store::commit_at(root, &folder, &prepared, f)?;",
        "message_store::remove_other_format_at(root, &folder, uid, keep)?;",
        "message_store::commit_replacing(root, a, m, &prepared, f)?;",
    ] {
        assert!(one(&format!("fn f(dir: &Path) {{\n    crate::{call}\n}}\n")).is_some(), "{call} with no registry call must be flagged");
    }

    let read = "fn show(root: &Path) {\n    message_store::read_raw(root, a, m, uid)?;\n    fs::write(out, b)?;\n}\n";
    let text = non_test_text(read);
    assert!(!inspected(fn_bodies(&text)[0].1), "a store read next to an unrelated write is no vault writer");
}
