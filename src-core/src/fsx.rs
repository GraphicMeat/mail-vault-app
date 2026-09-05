//! Filesystem helpers shared by the app and the daemon.

use std::fs;
use std::path::Path;

/// Write `bytes` to `path` so a reader never sees half a file: the content
/// lands in a sibling temp file first and one rename puts it in place. A
/// process killed mid-write leaves the previous file intact.
///
// ponytail: no fsync — this protects against a killed process (the daemon gets
// SIGKILL 3s after SIGTERM), not against power loss. Add fsync of the file and
// its directory if crash-durability is ever a requirement.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "write_atomic: path has no file name")
    })?;
    // Pid plus a per-process counter: two tasks in one process writing the
    // same file at once (the classification worker and an override RPC both
    // rewrite an account's classifications) must not share a temp path, or one
    // rename could install the other's half-written temp.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_file_name(temp_name(name, seq));

    fs::write(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// `.<name>.tmp-<pid>-<seq>`. The leading dot matters: Maildir readers parse the
/// uid off the FRONT of a filename (`<uid>:2,S.eml`, `<uid>.eml`), so a temp
/// named `<uid>:2,S.eml.tmp-…` left by a kill mid-write would read as "uid
/// already stored" and the message would be skipped on every later run. A
/// dot-prefixed name parses as no uid at all and is ignored.
fn temp_name(name: &std::ffi::OsStr, seq: u64) -> std::ffi::OsString {
    let mut tmp = std::ffi::OsString::from(".");
    tmp.push(name);
    tmp.push(format!(".tmp-{}-{}", std::process::id(), seq));
    tmp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_temp_name_never_parses_as_a_maildir_uid() {
        let tmp = temp_name(std::ffi::OsStr::new("4711:2,S.eml"), 3).to_string_lossy().to_string();
        assert!(tmp.starts_with('.'), "temp must be a dotfile: {tmp}");
        // The rule every uid scanner uses: split on the first ':' '.' '_' and parse.
        let head = tmp.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or("");
        assert!(head.parse::<u32>().is_err(), "an orphaned temp read as uid {head}");
        assert!(!tmp.starts_with("4711:"), "find_file_by_uid would match it: {tmp}");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("mv-fsx-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn write_atomic_replaces_the_target_and_leaves_no_temp_file() {
        let dir = scratch("replace");
        let path = dir.join("state.json");

        write_atomic(&path, b"{\"v\":1}").unwrap();
        write_atomic(&path, b"{\"v\":2}").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"v\":2}");
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(entries.len(), 1, "a temp file survived the write: {entries:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_creates_a_missing_file() {
        let dir = scratch("create");
        let path = dir.join("new.json");

        write_atomic(&path, b"hello").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
