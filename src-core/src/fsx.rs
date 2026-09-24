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

/// Mark a file written from an email as downloaded from the Internet (the
/// Mark-of-the-Web), the way browsers and Outlook do: an NTFS alternate data
/// stream `Zone.Identifier` with `ZoneId=3`. Without it, opening a cached
/// `.exe`/`.bat`/`.js`/`.lnk` runs it with no SmartScreen or Attachment
/// Manager prompt. No-op off Windows.
///
/// Errors are ignored: FAT/exFAT and network shares have no streams, and a
/// missing mark must not cost the user the file.
pub fn mark_from_internet(path: &Path) {
    #[cfg(windows)]
    {
        let mut ads = path.as_os_str().to_owned();
        ads.push(":Zone.Identifier");
        let _ = fs::write(ads, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// `<name>` → `<name>.pre-db-<stamp>`: how a JSON file that has been imported
/// into a SQLite store is put beyond every reader's reach without deleting it.
/// The same convention `custody::import` uses for the vault's legacy files.
///
/// `rename` replaces its destination without a word, so the name has to be
/// free by `symlink_metadata` (`exists()` says false for a broken symlink and
/// for anything it cannot stat) — this is the one path that could destroy an
/// already-retired file.
pub fn retire(path: &Path, stamp: u64) -> std::io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "retire: path has no file name"))?
        .to_string_lossy()
        .to_string();
    let mut target = path.with_file_name(format!("{name}.pre-db-{stamp}"));
    let mut n = 1;
    while target.symlink_metadata().is_ok() {
        target = path.with_file_name(format!("{name}.pre-db-{stamp}-{n}"));
        n += 1;
    }
    fs::rename(path, &target)
}

/// Seconds since the epoch — the stamp `retire` suffixes with.
pub fn retire_stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The last `n` lines of a text file, joined with `\n` (no trailing newline,
/// CRLF stripped, invalid UTF-8 replaced). Reads backwards from the end in
/// chunks, so a multi-megabyte log costs only the bytes of its tail.
pub fn tail_lines(path: &Path, n: usize) -> std::io::Result<String> {
    tail_lines_from(&mut fs::File::open(path)?, n, 64 * 1024)
}

fn tail_lines_from<R: std::io::Read + std::io::Seek>(r: &mut R, n: usize, chunk: usize) -> std::io::Result<String> {
    use std::io::SeekFrom;
    let end = r.seek(SeekFrom::End(0))?;
    let mut pos = end;
    // Bytes [pos, end). Split points are only ever just after a `\n` (0x0A),
    // which never occurs inside a multi-byte UTF-8 sequence, so decoding once
    // at the end never sees a code point cut in half.
    let mut buf: Vec<u8> = Vec::new();
    let mut start = 0;
    let mut seen = 0;
    'read: while pos > 0 && n > 0 {
        let take = chunk.min(pos as usize);
        pos -= take as u64;
        r.seek(SeekFrom::Start(pos))?;
        let mut piece = vec![0; take];
        r.read_exact(&mut piece)?;
        piece.extend_from_slice(&buf);
        buf = piece;
        for i in (0..take).rev() {
            // The file's own final newline terminates the last line; it does
            // not start another one.
            if buf[i] == b'\n' && pos + i as u64 != end - 1 {
                seen += 1;
                if seen == n {
                    start = i + 1;
                    break 'read;
                }
            }
        }
    }
    Ok(String::from_utf8_lossy(&buf[start..]).lines().collect::<Vec<_>>().join("\n"))
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
        use crate::maildir::{INFO_PREFIX, INFO_SEP};
        let orig = format!("4711{INFO_PREFIX}S.eml");
        let tmp = temp_name(std::ffi::OsStr::new(&orig), 3).to_string_lossy().to_string();
        assert!(tmp.starts_with('.'), "temp must be a dotfile: {tmp}");
        // The rule every uid scanner uses: split on the first ':' '.' '_' and parse.
        let head = tmp.split(|c: char| c == INFO_SEP || c == '.' || c == '_').next().unwrap_or("");
        assert!(head.parse::<u32>().is_err(), "an orphaned temp read as uid {head}");
        assert!(!tmp.starts_with(&format!("4711{INFO_SEP}")), "find_file_by_uid would match it: {tmp}");
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

    fn tail(s: &[u8], n: usize, chunk: usize) -> String {
        tail_lines_from(&mut std::io::Cursor::new(s), n, chunk).unwrap()
    }

    #[test]
    fn tail_returns_every_line_when_the_file_has_fewer() {
        assert_eq!(tail(b"a\nb\n", 500, 3), "a\nb");
    }

    #[test]
    fn tail_returns_exactly_the_limit() {
        assert_eq!(tail(b"a\nb\nc\n", 3, 2), "a\nb\nc");
        assert_eq!(tail(b"a\nb\nc\n", 2, 2), "b\nc");
    }

    #[test]
    fn tail_keeps_the_last_line_without_a_trailing_newline() {
        assert_eq!(tail(b"a\nb\nc", 2, 2), "b\nc");
        assert_eq!(tail(b"only", 5, 2), "only");
    }

    #[test]
    fn tail_keeps_empty_lines() {
        assert_eq!(tail(b"a\n\n", 1, 4), "");
        assert_eq!(tail(b"a\n\nb\n", 2, 4), "\nb");
    }

    #[test]
    fn tail_strips_crlf_even_when_split_across_chunks() {
        let s = b"one\r\ntwo\r\nthree\r\n";
        // 17 bytes; a first read of 13 starts at byte 4, so the first line's
        // `\r` and `\n` land in different chunks.
        assert_eq!(s[3], b'\r');
        assert_eq!(s[4], b'\n');
        assert_eq!(tail(s, 5, 13), "one\ntwo\nthree");
        assert_eq!(tail(s, 2, 13), "two\nthree");
    }

    #[test]
    fn tail_of_an_empty_file_is_empty() {
        assert_eq!(tail(b"", 500, 4), "");
        assert_eq!(tail(b"a\nb\n", 0, 4), "");
    }

    #[test]
    fn tail_never_splits_a_utf8_character_across_chunks() {
        let s = "x\n\u{e9}t\u{e9}\nfin\n".as_bytes(); // é = C3 A9
        // 12 bytes; a first read of 9 starts at byte 3, the A9 of the first é.
        assert_eq!(s[3] & 0xC0, 0x80, "boundary must fall inside a character");
        assert_eq!(tail(s, 2, 9), "\u{e9}t\u{e9}\nfin");
        assert_eq!(tail(s, 5, 9), "x\n\u{e9}t\u{e9}\nfin");
    }

    #[test]
    fn tail_decodes_invalid_utf8_lossily() {
        assert_eq!(tail(b"a\n\xff\n", 1, 4), "\u{fffd}");
    }

    #[test]
    fn tail_lines_reads_a_file_larger_than_one_chunk() {
        let dir = scratch("tail");
        let path = dir.join("mailvault.log");
        let body: String = (0..10_000).map(|i| format!("line {i}\r\n")).collect();
        assert!(body.len() > 64 * 1024);
        std::fs::write(&path, &body).unwrap();

        let got = tail_lines(&path, 500).unwrap();
        let want: Vec<String> = (9_500..10_000).map(|i| format!("line {i}")).collect();
        assert_eq!(got, want.join("\n"));
        // More lines than one 64 KiB chunk holds forces a second read.
        assert_eq!(tail_lines(&path, 9_000).unwrap().lines().count(), 9_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_marked_file_carries_zone_3() {
        let dir = scratch("motw");
        let path = dir.join("invoice.exe");
        write_atomic(&path, b"MZ").unwrap();

        mark_from_internet(&path);

        let zone = std::fs::read_to_string(dir.join("invoice.exe:Zone.Identifier")).unwrap();
        assert!(zone.contains("ZoneId=3"), "{zone}");
        assert_eq!(std::fs::read(&path).unwrap(), b"MZ", "the mark must not touch the content");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
