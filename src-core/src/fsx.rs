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
    let mut tmp_name = name.to_os_string();
    tmp_name.push(format!(".tmp-{}-{}", std::process::id(), seq));
    let tmp = path.with_file_name(tmp_name);

    fs::write(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
