//! The engine's own log file (Settings > Logs on the phone): every line [`Shared::log`] writes
//! also lands in `<data_dir>/logs/engine.log`, time-stamped, so the user can read it, copy it into
//! a bug report, or clear it. The shell's platform logger (unified log, logcat) still gets every
//! line as before; nobody can read that from the phone itself.
//!
//! - Detail (`logVerbosity`, a preference: `standard` | `verbose`, desktop's key and values):
//!   Standard masks every email address in the file as desktop's Standard logs do
//!   (`mailvault_core::log_redact`, the same `<provider#xxxx>` tokens, with a per-install salt in
//!   `<data_dir>/logs/log_salt`); Verbose keeps them, for a support session. The choice is held in
//!   memory (read at open, updated by `mobile.prefs.set`), so writing a line never reads the
//!   database.
//! - Size: past [`MAX_BYTES`] the file moves to `engine.log.1` (one older file kept) and a new one
//!   starts, so the log never takes more than twice that.
//! - `mobile.logs.get {lines?}` -> `{text, bytes}`: the newest `lines` (default 500, at most 5000)
//!   across both files. `mobile.logs.clear {}` -> `{}`: both files go.
//!
//! [`Shared::log`]: crate::db::Shared::log

use crate::db::{lock, Engine};
use crate::rpc::{parse, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// The preference key, as desktop names it.
pub(crate) const VERBOSITY: &str = "logVerbosity";
const FILE: &str = "engine.log";
const OLDER: &str = "engine.log.1";
/// The current file's size before it rolls over.
pub(crate) const MAX_BYTES: u64 = 512 * 1024;
const DEFAULT_LINES: usize = 500;
const MAX_LINES: usize = 5000;

#[derive(Default)]
pub(crate) struct Logs {
    dir: OnceLock<PathBuf>,
    salt: OnceLock<[u8; 16]>,
    verbose: AtomicBool,
    /// One writer at a time, so lines never interleave and a roll-over never loses one.
    write: Mutex<()>,
    /// Tests: a smaller roll-over size.
    cap: OnceLock<u64>,
}

impl Logs {
    /// Starts writing into `<data_dir>/logs`, at the detail `verbose`.
    pub(crate) fn open(&self, data_dir: &Path, verbose: bool) {
        let dir = data_dir.join("logs");
        let _ = std::fs::create_dir_all(&dir);
        let _ = self.salt.set(mailvault_core::log_redact::load_or_create_salt(&dir));
        let _ = self.dir.set(dir);
        self.set_verbose(verbose);
    }

    pub(crate) fn set_verbose(&self, on: bool) {
        self.verbose.store(on, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn set_cap_for_test(&self, bytes: u64) {
        let _ = self.cap.set(bytes);
    }

    /// The line as the file keeps it: addresses masked unless Verbose.
    fn shown(&self, line: &str) -> String {
        if self.verbose.load(Ordering::SeqCst) || !line.contains('@') {
            return line.to_string();
        }
        let salt = self.salt.get().copied().unwrap_or_default();
        mailvault_core::log_redact::redact(line, &salt)
    }

    /// Appends one line. A failure is dropped: the log must never fail what it describes.
    pub(crate) fn write(&self, line: &str) {
        let Some(dir) = self.dir.get() else { return };
        let text = format!("{} {}\n", stamp(), self.shown(line).replace('\n', " "));
        let _g = lock(&self.write);
        let path = dir.join(FILE);
        let cap = self.cap.get().copied().unwrap_or(MAX_BYTES);
        if std::fs::metadata(&path).is_ok_and(|m| m.len() + text.len() as u64 > cap) {
            let _ = std::fs::rename(&path, dir.join(OLDER));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(text.as_bytes());
        }
    }

    /// The newest `lines` lines, oldest first, and the bytes both files take.
    fn tail(&self, lines: usize) -> (String, u64) {
        let Some(dir) = self.dir.get() else { return (String::new(), 0) };
        let _g = lock(&self.write);
        let mut all = String::new();
        let mut bytes = 0;
        for name in [OLDER, FILE] {
            if let Ok(t) = std::fs::read(dir.join(name)) {
                bytes += t.len() as u64;
                all.push_str(&String::from_utf8_lossy(&t));
            }
        }
        let kept: Vec<&str> = all.lines().collect();
        let from = kept.len().saturating_sub(lines);
        (kept[from..].join("\n"), bytes)
    }

    fn clear(&self) -> std::io::Result<()> {
        let Some(dir) = self.dir.get() else { return Ok(()) };
        let _g = lock(&self.write);
        for name in [OLDER, FILE] {
            match std::fs::remove_file(dir.join(name)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        Ok(())
    }

    /// The bytes the log files take.
    pub(crate) fn bytes(&self) -> u64 {
        let Some(dir) = self.dir.get() else { return 0 };
        [OLDER, FILE].iter().filter_map(|n| std::fs::metadata(dir.join(n)).ok()).map(|m| m.len()).sum()
    }
}

/// Now as `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC).
fn stamp() -> String {
    let ms = crate::compose::now_ms();
    let day = mailvault_core::transfer_limits::day_key(ms);
    let t = ms.rem_euclid(86_400_000);
    format!("{day}T{:02}:{:02}:{:02}.{:03}Z", t / 3_600_000, t / 60_000 % 60, t / 1000 % 60, t % 1000)
}

/// `verbose` is the stored preference's meaning: anything but `"verbose"` is Standard.
pub(crate) fn is_verbose(stored: Option<&str>) -> bool {
    stored == Some("verbose")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetParams {
    #[serde(default)]
    lines: Option<usize>,
}

/// `mobile.logs.get {lines?}` -> `{text, bytes}`.
pub(crate) fn get(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: GetParams = parse(if params.is_null() { json!({}) } else { params })?;
    let lines = p.lines.unwrap_or(DEFAULT_LINES).clamp(1, MAX_LINES);
    let (text, bytes) = engine.shared().logs.tail(lines);
    Ok(json!({ "text": text, "bytes": bytes }))
}

/// `mobile.logs.clear {}` -> `{}`.
pub(crate) fn clear(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    engine.shared().logs.clear().map_err(|e| RpcError::Internal(e.to_string()))?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn engine() -> (tempfile::TempDir, Engine) {
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        (tmp, e)
    }

    fn text(e: &Engine) -> String {
        e.rpc("mobile.logs.get", json!({})).unwrap()["text"].as_str().unwrap().to_string()
    }

    /// Standard (the default) masks addresses in the file as desktop does; Verbose, chosen in the
    /// preferences, keeps them; back to Standard masks the next lines again.
    #[test]
    fn standard_masks_addresses_and_verbose_keeps_them() {
        let (_tmp, e) = engine();
        assert_eq!(e.rpc("mobile.prefs.get", json!({})).unwrap()[VERBOSITY], "standard");
        e.shared().log("[sync] login failed for someone@example.org");
        let t = text(&e);
        assert!(t.contains("[sync] login failed for <imap#"), "{t}");
        assert!(!t.contains("someone@example.org"), "{t}");

        e.rpc("mobile.prefs.set", json!({ VERBOSITY: "verbose" })).unwrap();
        e.shared().log("[sync] login failed for other@example.org");
        assert!(text(&e).contains("other@example.org"));

        e.rpc("mobile.prefs.set", json!({ VERBOSITY: "standard" })).unwrap();
        e.shared().log("[sync] third@example.org");
        assert!(!text(&e).contains("third@example.org"));
        assert!(e.rpc("mobile.prefs.set", json!({ VERBOSITY: "loud" })).is_err());
    }

    /// Verbose survives a restart: the engine reads the preference when it opens.
    #[test]
    fn the_detail_is_read_at_open() {
        let tmp = tempfile::tempdir().unwrap();
        let open = || Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        let e = open();
        e.rpc("mobile.prefs.set", json!({ VERBOSITY: "verbose" })).unwrap();
        drop(e);
        let e = open();
        e.shared().log("kept@example.org");
        assert!(text(&e).contains("kept@example.org"));
    }

    /// Lines carry a UTC time stamp, `lines` takes the newest, clear empties the log.
    #[test]
    fn get_returns_the_newest_lines_and_clear_empties_it() {
        let (_tmp, e) = engine();
        for i in 0..20 {
            e.shared().log(&format!("line {i}"));
        }
        let got = e.rpc("mobile.logs.get", json!({ "lines": 3 })).unwrap();
        let t = got["text"].as_str().unwrap();
        let lines: Vec<&str> = t.lines().collect();
        assert_eq!(lines.len(), 3, "{t}");
        assert!(lines[2].ends_with(" line 19"), "{t}");
        assert!(lines[0].contains('T') && lines[0].contains("Z line 17"), "{t}");
        assert!(got["bytes"].as_u64().unwrap() > 0);
        assert_eq!(e.rpc("mobile.logs.clear", json!({})).unwrap(), json!({}));
        assert_eq!(text(&e), "");
        assert_eq!(e.rpc("mobile.logs.get", json!({})).unwrap()["bytes"], 0);
    }

    /// Past the cap the file rolls over: one older file is kept, so the log stays bounded, and
    /// reading spans both.
    #[test]
    fn the_file_rolls_over_and_stays_bounded() {
        let (_tmp, e) = engine();
        e.shared().logs.set_cap_for_test(2000);
        for i in 0..400 {
            e.shared().log(&format!("a fairly long line number {i:04} to fill the file"));
        }
        let got = e.rpc("mobile.logs.get", json!({ "lines": 5000 })).unwrap();
        assert!(got["bytes"].as_u64().unwrap() <= 4000, "{}", got["bytes"]);
        assert!(got["text"].as_str().unwrap().ends_with("number 0399 to fill the file"));
    }
}
