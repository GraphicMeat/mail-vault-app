//! What the long-running daemon jobs (`folder_move_job`, `mbox_upload_job`,
//! `format_migration_job`) share: a poison-tolerant lock, the clock, the job
//! id rule, the settled flag a quit waits on, the `<dir>/<id>.json` journal
//! store, the progress throttle and the background QoS of their threads.
//!
//! The control channels, runtimes, registries and work loops stay in each job:
//! they differ on purpose.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tracing::warn;

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub(crate) use mailvault_core::clock::now_ms_u64 as now_ms;

/// A job id names files: only what `uuid` writes gets through.
pub(crate) fn is_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Lowers the calling thread to background QoS (macOS; a no-op elsewhere).
pub(crate) fn background_qos() {
    #[cfg(target_os = "macos")]
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
    }
}

// ── settled ─────────────────────────────────────────────────────────────────

/// Whether a job is held at a checkpoint, or ended: what a quit waits for.
#[derive(Default)]
pub(crate) struct Settled {
    flag: Mutex<bool>,
    wake: Condvar,
}

impl Settled {
    pub(crate) fn set(&self, settled: bool) {
        *lock(&self.flag) = settled;
        self.wake.notify_all();
    }

    #[cfg(test)]
    pub(crate) fn is_set(&self) -> bool {
        *lock(&self.flag)
    }

    /// Waits until the flag is set, or `until`. Whether it was set.
    pub(crate) fn wait(&self, until: Instant) -> bool {
        let mut settled = lock(&self.flag);
        while !*settled {
            let now = Instant::now();
            if now >= until {
                return false;
            }
            settled = self.wake.wait_timeout(settled, until - now).unwrap_or_else(|p| p.into_inner()).0;
        }
        true
    }
}

// ── the journal store ───────────────────────────────────────────────────────

/// `<dir>/<id>.json`.
pub(crate) fn journal_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Writes `value` atomically as `<dir>/<id>.json`, creating `dir`. The errors
/// name `label` ("upload journal"): "Failed to create the {label} dir: ..." and
/// "Failed to write the {label}: ...".
pub(crate) fn write_json<T: Serialize>(dir: &Path, id: &str, value: &T, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create the {label} dir: {e}"))?;
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    mailvault_core::fsx::write_atomic(&journal_file(dir, id), &bytes).map_err(|e| format!("Failed to write the {label}: {e}"))
}

/// `None` for a missing file or one that does not parse as `T`. Whether the
/// parsed value is acceptable (its version, its id) is the job's to filter.
pub(crate) fn read_json<T: DeserializeOwned>(dir: &Path, id: &str) -> Option<T> {
    let raw = std::fs::read(journal_file(dir, id)).ok()?;
    serde_json::from_slice::<T>(&raw).ok()
}

/// Removes `path`; anything but "not there" is logged as
/// `[{tag}] job {id}: its journal was not removed: ...`.
pub(crate) fn remove_logged(path: &Path, tag: &str, id: &str) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!("[{tag}] job {id}: its journal was not removed: {e}");
        }
    }
}

/// Removes `<dir>/<id>.json`.
pub(crate) fn remove_json(dir: &Path, id: &str, tag: &str) {
    remove_logged(&journal_file(dir, id), tag, id);
}

/// The id of every `*.json` in `dir` whose stem is a job id. An atomic write's
/// temp file starts with a dot and never ends in `.json`, so it is never one.
pub(crate) fn list_ids(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".json").filter(|id| is_job_id(id)).map(str::to_string))
        .collect()
}

// ── progress ────────────────────────────────────────────────────────────────

/// At most one progress event per `every`, unless forced.
#[derive(Debug, Clone, Default)]
pub(crate) struct ProgressThrottle {
    last: Option<Instant>,
}

impl ProgressThrottle {
    /// Whether an event goes out at `now`; when it does, `now` is the new last.
    pub(crate) fn should_emit(&mut self, force: bool, every: Duration, now: Instant) -> bool {
        if force || self.last.is_none_or(|at| now.saturating_duration_since(at) >= every) {
            self.last = Some(now);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn settled_wait_times_out_when_unset_and_wakes_when_set_elsewhere() {
        let s = Arc::new(Settled::default());
        let started = Instant::now();
        assert!(!s.wait(started + Duration::from_millis(40)), "unset: false at the deadline");
        assert!(started.elapsed() >= Duration::from_millis(40));
        let s2 = Arc::clone(&s);
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            s2.set(true);
        });
        assert!(s.wait(Instant::now() + Duration::from_secs(10)), "set from another thread: true");
        setter.join().unwrap();
        assert!(s.is_set());
        assert!(s.wait(Instant::now()), "already set: true even at a passed deadline");
        s.set(false);
        assert!(!s.wait(Instant::now()), "cleared again");
    }

    #[test]
    fn job_id_rule() {
        assert!(is_job_id(&uuid::Uuid::new_v4().to_string()));
        assert!(is_job_id("a-B-9"));
        assert!(is_job_id(&"a".repeat(64)));
        for bad in ["", "../x", "a/b", "a.b", "a b", "a\\b", "é"] {
            assert!(!is_job_id(bad), "{bad}");
        }
        assert!(!is_job_id(&"a".repeat(65)));
    }

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct Doc {
        job_id: String,
        n: u32,
    }

    #[test]
    fn journal_round_trip_missing_and_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("jobs");
        let doc = Doc { job_id: "abc-1".into(), n: 7 };
        assert_eq!(read_json::<Doc>(&dir, "abc-1"), None, "no dir, no file: None");
        write_json(&dir, "abc-1", &doc, "test journal").unwrap();
        assert_eq!(journal_file(&dir, "abc-1"), dir.join("abc-1.json"));
        assert_eq!(read_json::<Doc>(&dir, "abc-1"), Some(doc));
        assert_eq!(read_json::<Doc>(&dir, "nope"), None, "missing file: None");
        std::fs::write(journal_file(&dir, "torn"), b"{\"job_id\": \"torn\", ").unwrap();
        assert_eq!(read_json::<Doc>(&dir, "torn"), None, "corrupt file: None");
        std::fs::write(journal_file(&dir, "empty"), b"").unwrap();
        assert_eq!(read_json::<Doc>(&dir, "empty"), None, "empty file: None");
    }

    #[test]
    fn write_errors_carry_the_label_verbatim() {
        let tmp = tempfile::tempdir().unwrap();
        let blocker = tmp.path().join("file");
        std::fs::write(&blocker, b"x").unwrap();
        let err = write_json(&blocker.join("jobs"), "id", &Doc { job_id: "id".into(), n: 1 }, "upload journal").unwrap_err();
        assert!(err.starts_with("Failed to create the upload journal dir: "), "{err}");
    }

    #[test]
    fn remove_deletes_and_tolerates_missing() {
        let tmp = tempfile::tempdir().unwrap();
        write_json(tmp.path(), "gone", &Doc { job_id: "gone".into(), n: 1 }, "j").unwrap();
        assert!(journal_file(tmp.path(), "gone").exists());
        remove_json(tmp.path(), "gone", "test");
        assert!(!journal_file(tmp.path(), "gone").exists());
        remove_json(tmp.path(), "gone", "test");
    }

    #[test]
    fn list_ids_keeps_only_json_files_with_a_job_id_stem() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        assert!(list_ids(&dir.join("missing")).is_empty());
        for name in ["one.json", "two-2.json", "three.tail", ".tmp123", ".one.json.tmp", "bad name.json", "..json", "notes.txt"] {
            std::fs::write(dir.join(name), b"{}").unwrap();
        }
        let mut ids = list_ids(dir);
        ids.sort();
        assert_eq!(ids, vec!["one".to_string(), "two-2".to_string()]);
    }

    #[test]
    fn progress_throttle_semantics() {
        let every = Duration::from_millis(500);
        let t0 = Instant::now();
        let mut t = ProgressThrottle::default();
        assert!(t.should_emit(false, every, t0), "the first call emits");
        assert!(!t.should_emit(false, every, t0 + Duration::from_millis(499)), "inside the interval is suppressed");
        assert!(t.should_emit(true, every, t0 + Duration::from_millis(499)), "forced emits inside the interval");
        assert!(!t.should_emit(false, every, t0 + Duration::from_millis(998)), "a forced emit restarts the interval");
        assert!(t.should_emit(false, every, t0 + Duration::from_millis(999)), "emits once the interval has passed");
        let mut zero = ProgressThrottle::default();
        assert!(zero.should_emit(false, Duration::ZERO, t0));
        assert!(zero.should_emit(false, Duration::ZERO, t0), "a zero interval never suppresses");
    }

    /// The scaffold lives here only: the three jobs keep no copy of it.
    #[test]
    fn the_three_jobs_keep_no_copy_of_the_scaffold() {
        let sources = [
            ("folder_move_job.rs", include_str!("folder_move_job.rs")),
            ("mbox_upload_job.rs", include_str!("mbox_upload_job.rs")),
            ("format_migration_job.rs", include_str!("format_migration_job.rs")),
        ];
        for (name, src) in sources {
            assert!(!src.contains("fn lock<"), "{name} defines its own lock");
            assert!(!src.contains("fn now_ms"), "{name} defines its own now_ms");
            assert!(!src.contains("fn is_job_id"), "{name} defines its own is_job_id");
            assert!(!src.contains("fn background_qos"), "{name} defines its own background_qos");
            let lines: Vec<&str> = src.lines().collect();
            let at = lines.iter().position(|l| l.contains("fn wait_settled")).unwrap_or_else(|| panic!("{name} lost wait_settled"));
            let body = lines[at + 1..].iter().take_while(|l| l.trim() != "}").count();
            assert!(body <= 1, "{name}: wait_settled is {body} lines, a forwarder is one");
        }
    }
}
