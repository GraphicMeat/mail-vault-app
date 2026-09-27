//! Log levels and address masking, shared by the app shell and the daemon.
//!
//! Standard logs (the default) run at INFO and replace every email address
//! with `<provider#hash>`: the hash is 4 hex chars of sha256(salt + address),
//! so one address reads the same across a support bundle without being in it.
//! Verbose logs run at DEBUG with raw values, for support sessions.

use regex::Regex;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}][\p{L}\p{N}._%+'-]*@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}").unwrap());

static VERBOSE: AtomicBool = AtomicBool::new(false);

/// Every address in `line` as `<provider#xxxx>`. Case-insensitive: the
/// address is lowercased before hashing, so `Foo@Gmail.com` and
/// `foo@gmail.com` get the same token.
pub fn redact(line: &str, salt: &[u8]) -> String {
    EMAIL
        .replace_all(line, |c: &regex::Captures| {
            let addr = c[0].to_lowercase();
            let hash = Sha256::new().chain_update(salt).chain_update(addr.as_bytes()).finalize();
            format!("<{}#{:02x}{:02x}>", provider(&addr), hash[0], hash[1])
        })
        .into_owned()
}

/// From the whole registrable domain: `me.com` is iCloud, `me.example.org`
/// is not. Outlook and Yahoo also have country domains (`hotmail.co.uk`).
fn provider(addr: &str) -> &'static str {
    let domain = addr.rsplit('@').next().unwrap_or("");
    match domain {
        "gmail.com" | "googlemail.com" => return "gmail",
        "icloud.com" | "me.com" | "mac.com" => return "icloud",
        _ => {}
    }
    let labels: Vec<&str> = domain.split('.').collect();
    let name = match labels.as_slice() {
        [name, _] | [name, "co" | "com", _] => *name,
        _ => return "imap",
    };
    match name {
        "outlook" | "hotmail" | "live" => "outlook",
        "yahoo" => "yahoo",
        _ => "imap",
    }
}

/// Switch between Verbose (DEBUG, raw) and Standard (INFO, masked).
pub fn set_verbose(on: bool) {
    // Level filters cache their answer per callsite; recompute on a change.
    if VERBOSE.swap(on, Ordering::Relaxed) != on {
        tracing::callsite::rebuild_interest_cache();
    }
}

pub fn is_verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed)
}

/// The most detailed level the current setting lets through.
pub fn max_level() -> tracing::Level {
    if is_verbose() { tracing::Level::DEBUG } else { tracing::Level::INFO }
}

/// `mailvault-settings.state.logVerbosity == "verbose"` in the app's
/// `frontend-settings.json`. Anything else, unreadable included, is Standard.
pub fn verbose_from_settings(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|s| s.get("mailvault-settings")?.get("state")?.get("logVerbosity")?.as_str().map(|v| v == "verbose"))
        .unwrap_or(false)
}

/// The per-install salt in `<dir>/log_salt`, created once (16 random bytes).
/// Shell and daemon both read it, so an address hashes the same in both logs.
/// Never fails: a file left short (a crash or a full disk mid-write) is
/// rewritten once; one that cannot be written gives a salt for this process.
pub fn load_or_create_salt(dir: &Path) -> [u8; 16] {
    let path = dir.join("log_salt");
    let _ = std::fs::create_dir_all(dir);
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            let salt: [u8; 16] = rand::random();
            let _ = f.write_all(&salt);
            return salt;
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return rand::random(),
    }
    // The other process may have created the file and not yet written it.
    for _ in 0..10 {
        let mut salt = [0u8; 16];
        if std::fs::File::open(&path).and_then(|mut f| f.read_exact(&mut salt)).is_ok() {
            return salt;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let salt: [u8; 16] = rand::random();
    let _ = std::fs::write(&path, salt);
    salt
}

/// An `io::Write` that masks addresses unless logging is Verbose. The fmt
/// layer hands over each event in one `write_all`, so an address is never
/// split across calls.
pub struct RedactingWriter<W> {
    pub inner: W,
    pub salt: [u8; 16],
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if is_verbose() || !buf.contains(&b'@') {
            return self.inner.write(buf);
        }
        self.inner.write_all(redact(&String::from_utf8_lossy(buf), &self.salt).as_bytes())?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

const MAX_LOG_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Delete rolled `mailvault.log.*` / `daemon.log.*` files last written more
/// than 7 days before `now`. The daily appender names every file, today's
/// included, `<prefix>.<date>`.
pub fn cleanup_old_logs(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("mailvault.log.") || name.starts_with("daemon.log.")) {
            continue;
        }
        let modified = entry.metadata().and_then(|m| m.modified());
        if modified.is_ok_and(|m| now.duration_since(m).is_ok_and(|age| age > MAX_LOG_AGE)) {
            tracing::info!("Removing old log file: {:?}", entry.path());
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The newest file in `dir` whose name starts with `prefix`.
pub fn latest_log(dir: &Path, prefix: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with(prefix) && !name.ends_with(".tmp")
        })
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH))
        .map(|e| e.path())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: &[u8] = b"0123456789abcdef";

    fn token(line: &str) -> String {
        redact(line, SALT)
    }

    #[test]
    fn masks_an_address_in_a_message() {
        let out = token("Fetching INBOX for rokas@gmail.com now");
        assert!(!out.contains("rokas"), "{out}");
        assert!(out.starts_with("Fetching INBOX for <gmail#"), "{out}");
        assert!(out.ends_with("> now"), "{out}");
        // `<gmail#` + 4 hex + `>`
        let tok = out.trim_start_matches("Fetching INBOX for ").trim_end_matches(" now");
        assert_eq!(tok.len(), "<gmail#3f2a>".len(), "{tok}");
    }

    #[test]
    fn masks_an_address_in_a_field() {
        let out = token(r#"account=me@outlook.com mailbox="INBOX""#);
        assert!(out.starts_with("account=<outlook#"), "{out}");
        assert!(out.ends_with(r#"> mailbox="INBOX""#), "{out}");
    }

    #[test]
    fn masks_every_address_and_keeps_them_distinct() {
        let out = token("a@icloud.com, b@yahoo.co.uk; c@example.org");
        assert!(!out.contains('@'), "{out}");
        assert!(out.contains("<icloud#") && out.contains("<yahoo#") && out.contains("<imap#"), "{out}");
        assert_ne!(token("a@example.org"), token("b@example.org"));
    }

    #[test]
    fn plus_tag_is_part_of_the_address() {
        let out = token("to user+news@googlemail.com");
        assert!(out.starts_with("to <gmail#") && !out.contains("news"), "{out}");
    }

    #[test]
    fn case_does_not_change_the_token() {
        assert_eq!(token("Rokas@Gmail.COM"), token("rokas@gmail.com"));
        assert!(token("ROKAS@HOTMAIL.COM").starts_with("<outlook#"));
    }

    #[test]
    fn a_host_and_port_after_the_address_survive() {
        let out = token("login user@mail.example.org:993 ok");
        assert!(out.starts_with("login <imap#") && out.ends_with(">:993 ok"), "{out}");
        // No domain dot: not an address, left alone.
        assert_eq!(token("connect user@host:993"), "connect user@host:993");
    }

    #[test]
    fn the_provider_is_the_whole_registrable_domain() {
        let label = |addr: &str| token(addr).split('#').next().unwrap().to_string();
        assert_eq!(label("a@me.com"), "<icloud");
        assert_eq!(label("a@mac.com"), "<icloud");
        assert_eq!(label("a@icloud.com"), "<icloud");
        assert_eq!(label("a@live.com"), "<outlook");
        assert_eq!(label("a@hotmail.co.uk"), "<outlook");
        assert_eq!(label("a@yahoo.co.jp"), "<yahoo");
        assert_eq!(label("a@googlemail.com"), "<gmail");
        assert_eq!(label("a@me.example.org"), "<imap");
        assert_eq!(label("a@gmail.example.com"), "<imap");
    }

    #[test]
    fn masks_apostrophes_and_non_ascii_addresses() {
        assert!(token("from o'brien@example.com").starts_with("from <imap#"), "{}", token("from o'brien@example.com"));
        assert!(token("José@Bücher.de ok").starts_with("<imap#"), "{}", token("José@Bücher.de ok"));
        assert_eq!(token("José@Bücher.de"), token("josé@bücher.de"));
        // A quote around the address stays outside the token.
        let quoted = token("'a@example.com'");
        assert!(quoted.starts_with("'<imap#") && quoted.ends_with(">'"), "{quoted}");
    }

    #[test]
    fn the_salt_changes_the_hash() {
        assert_ne!(redact("a@gmail.com", b"one"), redact("a@gmail.com", b"two"));
    }

    // One test owns the global flag, so no other test sees it flipped.
    #[test]
    fn writer_masks_in_standard_and_passes_through_in_verbose() {
        let write = |line: &str| {
            let mut w = RedactingWriter { inner: Vec::new(), salt: *b"0123456789abcdef" };
            w.write_all(line.as_bytes()).unwrap();
            String::from_utf8(w.inner).unwrap()
        };
        set_verbose(false);
        assert_eq!(max_level(), tracing::Level::INFO);
        assert_eq!(write("sync a@gmail.com\n"), token("sync a@gmail.com\n"));
        set_verbose(true);
        assert_eq!(max_level(), tracing::Level::DEBUG);
        assert_eq!(write("sync a@gmail.com\n"), "sync a@gmail.com\n");
        set_verbose(false);
    }

    #[test]
    fn verbosity_is_read_from_the_persisted_settings() {
        assert!(verbose_from_settings(r#"{"mailvault-settings":{"state":{"logVerbosity":"verbose"}}}"#));
        assert!(!verbose_from_settings(r#"{"mailvault-settings":{"state":{"logVerbosity":"standard"}}}"#));
        assert!(!verbose_from_settings(r#"{"mailvault-settings":{"state":{}}}"#));
        assert!(!verbose_from_settings("not json"));
    }

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-logr-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn salt_is_created_once_and_then_reused() {
        let dir = scratch("salt").join("not-yet");
        let first = load_or_create_salt(&dir);
        assert_eq!(std::fs::read(dir.join("log_salt")).unwrap(), first);
        assert_eq!(load_or_create_salt(&dir), first);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_short_salt_file_is_rewritten_once() {
        let dir = scratch("short-salt");
        std::fs::write(dir.join("log_salt"), b"abc").unwrap();
        let first = load_or_create_salt(&dir);
        assert_eq!(std::fs::read(dir.join("log_salt")).unwrap(), first);
        assert_eq!(load_or_create_salt(&dir), first, "the repaired file is used from then on");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_removes_rolled_logs_older_than_a_week_only() {
        let dir = scratch("clean");
        for name in ["mailvault.log.2026-09-01", "daemon.log.2026-09-01", "notes.txt", "log_salt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        cleanup_old_logs(&dir, SystemTime::now() + Duration::from_secs(6 * 24 * 60 * 60));
        assert!(dir.join("mailvault.log.2026-09-01").exists(), "six days old stays");
        cleanup_old_logs(&dir, SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60));
        assert!(!dir.join("mailvault.log.2026-09-01").exists());
        assert!(!dir.join("daemon.log.2026-09-01").exists());
        assert!(dir.join("notes.txt").exists() && dir.join("log_salt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_log_picks_the_newest_file_with_the_prefix() {
        let dir = scratch("latest");
        assert_eq!(latest_log(&dir, "daemon.log"), None);
        std::fs::write(dir.join("daemon.log.2026-09-26"), b"old").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("daemon.log.2026-09-27"), b"new").unwrap();
        std::fs::write(dir.join("mailvault.log.2026-09-28"), b"shell").unwrap();
        assert_eq!(latest_log(&dir, "daemon.log"), Some(dir.join("daemon.log.2026-09-27")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
