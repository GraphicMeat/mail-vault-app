//! Per-account wire-byte accounting for IMAP transports.
//!
//! `CountingStream` sits directly on the TCP/TLS stream inside
//! `connect_transport`, so it counts real wire bytes — COMPRESS=DEFLATE wraps
//! *above* it and its savings show up here.
//!
//! Counters live in a process-global registry keyed by account **email**: that
//! is the only account identity `connect_transport` and the pool ever see
//! (`ImapConfig` has no id). Flushes translate email → the frontend's account
//! id via `accounts.json` so the stat files, and the ids the frontend reads
//! back, line up with everything else keyed per account.
//!
//! Persistence is lock-free across processes: the app and the daemon run their
//! own pool and write their own file (`{account_id}.app.json` /
//! `{account_id}.daemon.json`); readers sum the two. Losing the last flush
//! interval on a crash is fine — these are statistics, not accounting records.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};

use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use tracing::warn;

/// Day buckets older than this are dropped on flush.
const RETAIN_DAYS: i64 = 730;

// ── Counters ────────────────────────────────────────────────────────────────

/// Live byte counters for one account, shared with every stream it owns.
/// `flushed_*` is the snapshot the last flush persisted — the delta between
/// them is what still has to be written.
#[derive(Debug, Default)]
pub struct Counters {
    down: AtomicU64,
    up: AtomicU64,
    flushed_down: AtomicU64,
    flushed_up: AtomicU64,
}

impl Counters {
    /// Bytes not yet written to disk.
    fn pending(&self) -> DayBucket {
        DayBucket {
            // saturating: a concurrent flush can advance the snapshot between
            // these two loads — that is a zero delta, not an underflow panic.
            down: self.down.load(Ordering::Relaxed).saturating_sub(self.flushed_down.load(Ordering::Relaxed)),
            up: self.up.load(Ordering::Relaxed).saturating_sub(self.flushed_up.load(Ordering::Relaxed)),
        }
    }

    /// Pending bytes, marking them flushed.
    fn take_pending(&self) -> DayBucket {
        let down = self.down.load(Ordering::Relaxed);
        let up = self.up.load(Ordering::Relaxed);
        DayBucket {
            down: down.saturating_sub(self.flushed_down.swap(down, Ordering::Relaxed)),
            up: up.saturating_sub(self.flushed_up.swap(up, Ordering::Relaxed)),
        }
    }
}

// ── CountingStream ──────────────────────────────────────────────────────────

/// Transparent stream wrapper that counts bytes read (down) and written (up).
#[derive(Debug)]
pub struct CountingStream<S> {
    inner: S,
    counters: Arc<Counters>,
}

impl<S> CountingStream<S> {
    pub fn new(inner: S, counters: Arc<Counters>) -> Self {
        Self { inner, counters }
    }
}

impl<S: async_std::io::Read + Unpin> async_std::io::Read for CountingStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(n)) = polled {
            self.counters.down.fetch_add(n as u64, Ordering::Relaxed);
        }
        polled
    }
}

impl<S: async_std::io::Write + Unpin> async_std::io::Write for CountingStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let polled = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = polled {
            self.counters.up.fetch_add(n as u64, Ordering::Relaxed);
        }
        polled
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_close(cx)
    }
}

// ── On-disk format ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct DayBucket {
    #[serde(default)]
    pub down: u64,
    #[serde(default)]
    pub up: u64,
}

impl DayBucket {
    fn add(&mut self, other: DayBucket) {
        self.down += other.down;
        self.up += other.up;
    }
}

/// `<app_data_dir>/transfer_stats/{account_id}.{app|daemon}.json`
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StatsFile {
    #[serde(default)]
    pub days: BTreeMap<String, DayBucket>,
}

/// Merged per-account view returned by the read API.
#[derive(Debug, Default, Serialize)]
pub struct AccountStats {
    pub days: BTreeMap<String, DayBucket>,
    pub today: DayBucket,
    pub week: DayBucket,
    pub month: DayBucket,
    pub year: DayBucket,
}

// ── Registry ────────────────────────────────────────────────────────────────

/// Process-global byte counters, keyed by account email.
#[derive(Default)]
pub struct TransferStats {
    accounts: Mutex<HashMap<String, Arc<Counters>>>,
}

/// The one registry per process. Both binaries run exactly one `ImapPool`, so a
/// global is the whole plumbing.
// ponytail: global registry — thread it through ImapPool if a process ever runs two.
pub fn global() -> &'static TransferStats {
    static REGISTRY: OnceLock<TransferStats> = OnceLock::new();
    REGISTRY.get_or_init(TransferStats::default)
}

impl TransferStats {
    /// Counters for an account, created on first use.
    pub fn counters(&self, email: &str) -> Arc<Counters> {
        let mut map = self.accounts.lock().unwrap();
        Arc::clone(
            map.entry(email.to_ascii_lowercase())
                .or_insert_with(|| Arc::new(Counters::default())),
        )
    }

    /// Bytes counted but not yet written, keyed by account id.
    fn pending_by_id(&self, ids: &HashMap<String, String>) -> HashMap<String, DayBucket> {
        let map = self.accounts.lock().unwrap();
        let mut out: HashMap<String, DayBucket> = HashMap::new();
        for (email, counters) in map.iter() {
            out.entry(resolve_id(ids, email))
                .or_default()
                .add(counters.pending());
        }
        out
    }

    /// Fold this process's unflushed deltas into today's bucket of its own file.
    /// `tag` is the process name ("app" / "daemon") — each process owns one file
    /// per account, so no cross-process locking is needed.
    pub fn flush(&self, app_dir: &Path, tag: &str) {
        let deltas: Vec<(String, DayBucket)> = {
            let map = self.accounts.lock().unwrap();
            map.iter()
                .map(|(email, c)| (email.clone(), c.take_pending()))
                .filter(|(_, d)| d.down > 0 || d.up > 0)
                .collect()
        };
        if deltas.is_empty() {
            return;
        }

        let ids = account_ids(app_dir);
        let today = today_key();
        for (email, delta) in deltas {
            let path = stats_path(app_dir, &resolve_id(&ids, &email), tag);
            let mut file = read_stats_file(&path);
            file.days.entry(today.clone()).or_default().add(delta);
            prune(&mut file);
            if let Err(e) = write_stats_file(&path, &file) {
                warn!("[transfer_stats] Failed to write {}: {}", path.display(), e);
            }
        }
    }
}

// ── Read API ────────────────────────────────────────────────────────────────

/// Merged stats for every account with a stat file, plus this process's
/// unflushed bytes so the UI is not up to a flush interval stale.
pub fn read_all(app_dir: &Path) -> BTreeMap<String, AccountStats> {
    let mut days_by_id: BTreeMap<String, BTreeMap<String, DayBucket>> = BTreeMap::new();

    if let Ok(entries) = fs::read_dir(stats_dir(app_dir)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(id) = name
                .strip_suffix(".app.json")
                .or_else(|| name.strip_suffix(".daemon.json"))
            else {
                continue;
            };
            let file = read_stats_file(&entry.path());
            let merged = days_by_id.entry(id.to_string()).or_default();
            for (day, bucket) in file.days {
                merged.entry(day).or_default().add(bucket);
            }
        }
    }

    let today = today_key();
    for (id, pending) in global().pending_by_id(&account_ids(app_dir)) {
        if pending.down == 0 && pending.up == 0 {
            continue;
        }
        days_by_id
            .entry(id)
            .or_default()
            .entry(today.clone())
            .or_default()
            .add(pending);
    }

    days_by_id
        .into_iter()
        .map(|(id, days)| (id, aggregate(days)))
        .collect()
}

/// Today's usage for one account across both processes' files plus this
/// process's unflushed bytes. Used by the daemon's soft daily cap.
pub fn usage_today(app_dir: &Path, account_id: &str) -> DayBucket {
    let today = today_key();
    let mut total = DayBucket::default();
    for tag in ["app", "daemon"] {
        if let Some(b) = read_stats_file(&stats_path(app_dir, account_id, tag))
            .days
            .get(&today)
        {
            total.add(*b);
        }
    }
    if let Some(pending) = global()
        .pending_by_id(&account_ids(app_dir))
        .get(account_id)
    {
        total.add(*pending);
    }
    total
}

fn aggregate(days: BTreeMap<String, DayBucket>) -> AccountStats {
    let now = Utc::now().date_naive();
    let today = now.format("%Y-%m-%d").to_string();
    let week_start = (now - Duration::days(6)).format("%Y-%m-%d").to_string();
    let month = now.format("%Y-%m").to_string();
    let year = now.format("%Y").to_string();

    let mut stats = AccountStats::default();
    for (day, bucket) in &days {
        if *day == today {
            stats.today.add(*bucket);
        }
        if day.as_str() >= week_start.as_str() && day.as_str() <= today.as_str() {
            stats.week.add(*bucket);
        }
        if day.starts_with(&month) {
            stats.month.add(*bucket);
        }
        if day.starts_with(&year) {
            stats.year.add(*bucket);
        }
    }
    stats.days = days;
    stats
}

// ── Files ───────────────────────────────────────────────────────────────────

fn stats_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("transfer_stats")
}

fn stats_path(app_dir: &Path, account_id: &str, tag: &str) -> PathBuf {
    stats_dir(app_dir).join(format!("{}.{}.json", sanitize(account_id), tag))
}

fn read_stats_file(path: &Path) -> StatsFile {
    fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn write_stats_file(path: &Path, file: &StatsFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn prune(file: &mut StatsFile) {
    let cutoff = (Utc::now().date_naive() - Duration::days(RETAIN_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    file.days.retain(|day, _| {
        NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok() && day.as_str() >= cutoff.as_str()
    });
}

fn today_key() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

/// email → account id, from the app's `accounts.json`. Accounts the app has not
/// written yet fall back to their sanitized email, so no traffic goes unnamed.
fn account_ids(app_dir: &Path) -> HashMap<String, String> {
    let raw = fs::read_to_string(app_dir.join("accounts.json")).unwrap_or_default();
    serde_json::from_str::<Vec<serde_json::Value>>(&raw)
        .unwrap_or_default()
        .iter()
        .filter_map(|a| {
            Some((
                a.get("email")?.as_str()?.to_ascii_lowercase(),
                a.get("id")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

fn resolve_id(ids: &HashMap<String, String>, email: &str) -> String {
    sanitize(ids.get(email).map(String::as_str).unwrap_or(email))
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_std::io::{Cursor, ReadExt, WriteExt};

    #[test]
    fn counting_stream_counts_both_directions() {
        let counters = Arc::new(Counters::default());
        async_std::task::block_on(async {
            let mut reader = CountingStream::new(Cursor::new(b"hello world".to_vec()), Arc::clone(&counters));
            let mut buf = Vec::new();
            reader.read_to_end(&mut buf).await.unwrap();
            assert_eq!(buf, b"hello world");

            let mut writer = CountingStream::new(Cursor::new(Vec::new()), Arc::clone(&counters));
            writer.write_all(b"A1 NOOP\r\n").await.unwrap();
            writer.flush().await.unwrap();
        });

        assert_eq!(counters.down.load(Ordering::Relaxed), 11);
        assert_eq!(counters.up.load(Ordering::Relaxed), 9);
        assert_eq!(counters.pending(), DayBucket { down: 11, up: 9 });
        assert_eq!(counters.take_pending(), DayBucket { down: 11, up: 9 });
        assert_eq!(counters.pending(), DayBucket::default(), "flushed bytes must not be counted twice");
    }

    #[test]
    fn merges_both_process_files_and_aggregates() {
        let dir = tempfile::tempdir().unwrap();
        let today = today_key();

        let mut app = StatsFile::default();
        app.days.insert(today.clone(), DayBucket { down: 100, up: 10 });
        app.days.insert("2000-01-01".into(), DayBucket { down: 7, up: 7 });
        write_stats_file(&stats_path(dir.path(), "acc1", "app"), &app).unwrap();

        let mut daemon = StatsFile::default();
        daemon.days.insert(today.clone(), DayBucket { down: 400, up: 40 });
        write_stats_file(&stats_path(dir.path(), "acc1", "daemon"), &daemon).unwrap();

        let all = read_all(dir.path());
        let acc = all.get("acc1").expect("acc1 stats");
        assert_eq!(acc.today, DayBucket { down: 500, up: 50 }, "both files must be summed");
        assert_eq!(acc.week, DayBucket { down: 500, up: 50 });
        assert_eq!(acc.year.down, 500, "the 2000-01-01 bucket is outside this year");
        assert_eq!(acc.days.len(), 2, "raw day buckets are returned as-is");

        assert_eq!(usage_today(dir.path(), "acc1"), DayBucket { down: 500, up: 50 });
        assert_eq!(usage_today(dir.path(), "unknown"), DayBucket::default());
    }

    #[test]
    fn flush_accumulates_into_todays_bucket_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let stats = TransferStats::default();
        let counters = stats.counters("user@example.com");

        // Pre-existing file with an ancient bucket that must be pruned.
        let mut old = StatsFile::default();
        old.days.insert("2000-01-01".into(), DayBucket { down: 5, up: 5 });
        let path = stats_path(dir.path(), "user_example_com", "daemon");
        write_stats_file(&path, &old).unwrap();

        counters.down.fetch_add(1_000, Ordering::Relaxed);
        counters.up.fetch_add(100, Ordering::Relaxed);
        stats.flush(dir.path(), "daemon");
        counters.down.fetch_add(500, Ordering::Relaxed);
        stats.flush(dir.path(), "daemon");

        let file = read_stats_file(&path);
        assert_eq!(file.days.len(), 1, "buckets older than 2 years must be pruned");
        assert_eq!(file.days[&today_key()], DayBucket { down: 1_500, up: 100 });
    }

    #[test]
    fn flush_names_the_file_by_the_frontend_account_id() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("accounts.json"),
            r#"[{"id":"3f9c-uuid","email":"User@Example.com"}]"#,
        )
        .unwrap();

        let stats = TransferStats::default();
        stats.counters("user@example.com").down.fetch_add(42, Ordering::Relaxed);
        stats.flush(dir.path(), "app");

        assert!(stats_path(dir.path(), "3f9c-uuid", "app").exists());
        assert_eq!(read_all(dir.path()).get("3f9c-uuid").unwrap().today.down, 42);
    }
}
