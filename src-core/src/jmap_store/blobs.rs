//! Content-addressed message blobs: `<vault>/message_blobs/<h0h1>/<hex>.eml`
//! holds the raw RFC 5322 bytes whose sha256 is `<hex>`. One file serves every
//! mailbox and account holding the same bytes (Gmail label copies dedupe).
//! Nothing here deletes a blob: garbage collection is a mark-and-sweep pass
//! over the records, and `put` refreshes an existing blob's mtime so a reused
//! old blob falls inside the sweep's grace period.

use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The blob directory under the vault root.
pub const BLOB_DIR: &str = "message_blobs";

const ID_PREFIX: &str = "sha256-";

#[cfg(test)]
thread_local! {
    static HASHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Test hook: how many message-sized hashes this thread has made since
/// `reset_hash_count`.
#[cfg(test)]
pub(crate) fn hash_count() -> usize {
    HASHES.with(|c| c.get())
}

#[cfg(test)]
pub(crate) fn reset_hash_count() {
    HASHES.with(|c| c.set(0));
}

fn hex_of(raw: &[u8]) -> String {
    #[cfg(test)]
    HASHES.with(|c| c.set(c.get() + 1));
    format!("{:x}", Sha256::digest(raw))
}

/// The local blob id of these bytes: `sha256-<64 lowercase hex>`.
pub fn blob_id(raw: &[u8]) -> String {
    format!("{ID_PREFIX}{}", hex_of(raw))
}

/// The digest part of an id made by `blob_id`, without hashing again.
pub(crate) fn digest_of(id: &str) -> &str {
    id.strip_prefix(ID_PREFIX).unwrap_or(id)
}

/// The hex digest of a well-formed id (`sha256-` then exactly 64 lowercase hex
/// digits), else `None`. Ids come back from `<uid>.json` files on disk, so an
/// id is checked before it becomes a path: `sha256-../../x` must not escape
/// the vault, and a short id must not panic on the shard slice.
fn id_hex(id: &str) -> Option<&str> {
    let hex = id.strip_prefix(ID_PREFIX)?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(hex)
}

/// Whether `id` is a well-formed local blob id.
pub fn is_valid_id(id: &str) -> bool {
    id_hex(id).is_some()
}

/// `<root>/message_blobs/<hex[0..2]>/<hex>.eml`. Pure path arithmetic that
/// never panics; `get` and `verify` refuse a malformed id before using it.
pub fn blob_path(root: &Path, id: &str) -> PathBuf {
    let hex = id.strip_prefix(ID_PREFIX).unwrap_or(id);
    let shard = hex.get(0..2).unwrap_or("00");
    root.join(BLOB_DIR).join(shard).join(format!("{hex}.eml"))
}

/// Store `raw` and return its id (one sha256 of `raw`). Absent: written with `write_atomic`.
/// Present: its size and bytes are checked against `raw` (byte-equal means the
/// hash matches); a mismatch (a corrupt or truncated file) is rewritten, an
/// intact file gets its mtime set to now so the blob sweep's grace period
/// covers the record about to point at it.
pub fn put(root: &Path, raw: &[u8]) -> Result<String, String> {
    put_as(root, raw, blob_id(raw))
}

/// `put` for a caller that already holds `raw`'s id (`blob_id(raw)`, made
/// while building the record), so the message is hashed once and not again
/// here. The id is trusted: a wrong one files `raw` under another blob's name,
/// and `verify` of that id is `false`.
pub(crate) fn put_as(root: &Path, raw: &[u8], id: String) -> Result<String, String> {
    let path = blob_path(root, &id);
    let intact = match fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() == raw.len() as u64 => {
            fs::read(&path).map_err(|e| format!("blob read {}: {e}", path.display()))? == raw
        }
        Ok(_) => false,
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("blob stat {}: {e}", path.display())),
    };
    if intact {
        fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|f| f.set_modified(SystemTime::now()))
            .map_err(|e| failure(&format!("blob touch {}", path.display()), &e))?;
        return Ok(id);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| failure(&format!("blob dir {}", parent.display()), &e))?;
    }
    crate::fsx::write_atomic(&path, raw).map_err(|e| failure(&format!("blob write {}", path.display()), &e))?;
    Ok(id)
}

/// Makes an existing blob young again (mtime now), as `put` does for a blob it
/// reuses, so the blob sweep's grace period covers a record about to name it.
/// A blob that is not there is left alone (`Ok`): there is nothing to protect.
pub(crate) fn touch(root: &Path, id: &str) -> Result<(), String> {
    let path = blob_path(root, id);
    match fs::File::options().write(true).open(&path).and_then(|f| f.set_modified(SystemTime::now())) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(failure(&format!("blob touch {}", path.display()), &e)),
    }
}

/// `what: e`, marked as the disk's own failure (`message_store::E_DISK`) when
/// it is one: a conversion stops on it.
fn failure(what: &str, e: &io::Error) -> String {
    crate::message_store::io_failure(what, e)
}

/// The bytes of blob `id`. A malformed id is `InvalidInput`.
pub fn get(root: &Path, id: &str) -> io::Result<Vec<u8>> {
    if !is_valid_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("invalid blob id: {id}")));
    }
    fs::read(blob_path(root, id))
}

/// Re-hash blob `id`: `Ok(true)` when the file's sha256 is the id's,
/// `Ok(false)` when it differs or the file is missing, `Err` for a malformed
/// id or an unreadable file.
pub fn verify(root: &Path, id: &str) -> Result<bool, String> {
    let Some(hex) = id_hex(id) else { return Err(format!("invalid blob id: {id}")) };
    match fs::read(blob_path(root, id)) {
        Ok(bytes) => Ok(hex_of(&bytes) == hex),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("blob read {id}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    const RAW: &[u8] = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\n\r\nbody\r\n";

    /// Every file under `<root>/message_blobs`, temp files included.
    fn blob_files(root: &Path) -> Vec<PathBuf> {
        walkdir::WalkDir::new(root.join(BLOB_DIR))
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| e.into_path())
            .collect()
    }

    #[test]
    fn blob_id_and_path_follow_the_on_disk_layout() {
        let root = Path::new("/vault");
        let id = blob_id(RAW);
        let hex = id.strip_prefix("sha256-").expect("sha256- prefix");
        assert_eq!(hex.len(), 64);
        assert!(hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{hex}");
        assert_eq!(hex, format!("{:x}", Sha256::digest(RAW)));
        assert_eq!(
            blob_path(root, &id),
            root.join("message_blobs").join(&hex[0..2]).join(format!("{hex}.eml"))
        );
        assert!(is_valid_id(&id));
    }

    #[test]
    fn blob_put_is_idempotent_and_detects_corruption() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let id = put(root, RAW).unwrap();
        assert_eq!(put(root, RAW).unwrap(), id);
        assert_eq!(blob_files(root), vec![blob_path(root, &id)], "one file, no temp left behind");
        assert!(verify(root, &id).unwrap());

        fs::write(blob_path(root, &id), b"junk").unwrap();
        assert!(!verify(root, &id).unwrap());

        assert_eq!(put(root, RAW).unwrap(), id);
        assert!(verify(root, &id).unwrap());
        assert_eq!(get(root, &id).unwrap(), RAW);
        assert_eq!(blob_files(root).len(), 1);

        // Same length, different bytes: the size check alone would miss it.
        let mut flipped = RAW.to_vec();
        flipped[0] = b'X';
        fs::write(blob_path(root, &id), &flipped).unwrap();
        assert!(!verify(root, &id).unwrap());
        put(root, RAW).unwrap();
        assert_eq!(get(root, &id).unwrap(), RAW);
    }

    #[test]
    fn blob_put_refreshes_the_mtime_of_an_existing_blob() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let id = put(root, RAW).unwrap();
        let path = blob_path(root, &id);
        let old = UNIX_EPOCH + Duration::from_secs(1000);
        fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old);

        put(root, RAW).unwrap();

        let now = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(now > old + Duration::from_secs(86_400), "mtime not refreshed: {now:?}");
        assert_eq!(get(root, &id).unwrap(), RAW);
    }

    #[test]
    fn verify_of_a_missing_blob_is_false() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!verify(tmp.path(), &blob_id(RAW)).unwrap());
        assert_eq!(get(tmp.path(), &blob_id(RAW)).unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn malformed_ids_are_refused_before_they_become_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let upper = format!("sha256-{}", "A".repeat(64));
        for bad in ["sha256-../../etc/passwd", "sha256-a", "", "sha256-", "md5-abc", upper.as_str()] {
            assert_eq!(get(root, bad).unwrap_err().kind(), io::ErrorKind::InvalidInput, "{bad:?}");
            assert!(verify(root, bad).is_err(), "{bad:?}");
            assert!(!is_valid_id(bad), "{bad:?}");
            let _ = blob_path(root, bad); // never panics
        }
    }

    #[test]
    fn eight_bit_and_crlf_bytes_survive() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut raw: Vec<u8> = Vec::new();
        raw.extend_from_slice(b"From: a@example.com\r\nSubject: caf\xe9\r\nX-Lone: lf\nMIME-Version: 1.0\r\n");
        raw.extend_from_slice(b"Content-Type: multipart/mixed; boundary=\"b\"\r\n\r\n");
        raw.extend_from_slice(b"--b\r\nContent-Type: text/plain; charset=iso-8859-1\r\n");
        raw.extend_from_slice(b"Content-Transfer-Encoding: 8bit\r\n\r\nna\xefve r\xe9sum\xe9\nlone lf\r\ncr only\r\r\n");
        raw.extend_from_slice(b"--b\r\nContent-Type: application/octet-stream\r\n");
        raw.extend_from_slice(b"Content-Transfer-Encoding: binary\r\n\r\n");
        raw.extend((0u8..=255).collect::<Vec<u8>>());
        raw.extend_from_slice(b"\r\n--b--\r\n");

        let id = put(root, &raw).unwrap();
        assert_eq!(id, blob_id(&raw));
        assert_eq!(get(root, &id).unwrap(), raw);
        assert!(verify(root, &id).unwrap());

        let rec = crate::jmap_store::record::build(9, "INBOX", &raw, &[], None, None).unwrap();
        assert_eq!(rec.blob, id);
        assert_eq!(rec.size, raw.len() as u64);
        assert_eq!(rec.email["hasAttachment"], true);
    }
}
