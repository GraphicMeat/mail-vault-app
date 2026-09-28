//! Network Activity, kept: every recorded event lands in `app.db`'s
//! `net_events` and stays for the period the user chose (`Retention`,
//! a week unless changed), pruned when the daemon starts, every hour, and as
//! soon as the period changes. Never leaves the machine.
//!
//! `net_activity::record` runs inside `Drop`, inside tokio tasks and under
//! the listener lock, so it must never wait on SQLite: the daemon's listener
//! only `push`es onto a bounded channel, and one writer thread drains it in
//! batches. A full channel drops the event from the store (it still reached
//! the live page) rather than stall a connection.
//!
//! The writer and the readers each hold a connection of their own rather
//! than `app_db::handle`'s shared one: a month-wide GROUP BY must not hold up
//! the op journal or the stats flush, which share that one.
use crate::app_db::db;
use crate::net_activity::{now_ms, NetEvent};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long events are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Retention {
    Day,
    #[default]
    Week,
    TwoWeeks,
    Month,
}

impl Retention {
    pub fn ms(self) -> u64 {
        const DAY: u64 = 24 * 60 * 60 * 1000;
        match self {
            Retention::Day => DAY,
            Retention::Week => 7 * DAY,
            Retention::TwoWeeks => 14 * DAY,
            Retention::Month => 30 * DAY,
        }
    }
}

const RETENTION_KEY: &str = "net_activity_retention";
/// A ceiling under any period, so a month of a very busy install cannot grow
/// the store without bound: past it the oldest rows go first.
pub const MAX_ROWS: i64 = 250_000;
/// The table's rows: the newest this many that match.
pub const TABLE_ROWS: usize = 2000;
/// Queued events the writer has not stored yet; past it new ones are dropped.
const QUEUE: usize = 10_000;
/// How long the writer waits for a burst to finish before one transaction.
const BATCH_WINDOW: Duration = Duration::from_millis(250);
const BATCH_MAX: usize = 500;
const PRUNE_EVERY: Duration = Duration::from_secs(60 * 60);
/// Top hosts listed per country on the map.
const TOP_HOSTS: usize = 3;

pub fn retention(conn: &Connection) -> Retention {
    db::meta_get(conn, RETENTION_KEY)
        .and_then(|v| serde_json::from_value(serde_json::Value::String(v)).ok())
        .unwrap_or_default()
}

pub fn set_retention(conn: &Connection, r: Retention) -> Result<(), String> {
    let v = serde_json::to_value(r).map_err(|e| e.to_string())?;
    db::meta_set(conn, RETENTION_KEY, v.as_str().unwrap_or_default())
}

/// Drop what is older than the period (by start time), then anything past
/// `MAX_ROWS` (oldest arrivals first). Returns the rows removed.
pub fn prune(conn: &Connection, now: u64) -> Result<usize, String> {
    let cutoff = now.saturating_sub(retention(conn).ms());
    let old = conn.execute("DELETE FROM net_events WHERE at_ms < ?1", [cutoff as i64]).map_err(|e| e.to_string())?;
    let over = conn
        .execute(
            "DELETE FROM net_events WHERE id <= (SELECT id FROM net_events ORDER BY id DESC LIMIT 1 OFFSET ?1)",
            [MAX_ROWS],
        )
        .map_err(|e| e.to_string())?;
    Ok(old + over)
}

/// The serde name of a unit enum variant ("out", "tcpProbe"), as stored.
fn name<T: Serialize>(v: T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// Store `batch` in one transaction, in the order given.
pub fn insert(conn: &Connection, batch: &[(NetEvent, Option<String>)]) -> Result<(), String> {
    db::in_txn(conn, || {
        let mut stmt = conn
            .prepare_cached(
                "INSERT INTO net_events(at_ms, direction, process, protocol, host, ip, port, purpose, account,
                    bytes_up, bytes_down, duration_ms, result, commands, country)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            )
            .map_err(|e| e.to_string())?;
        for (e, country) in batch {
            stmt.execute(params![
                e.at_ms as i64,
                name(e.direction),
                e.process,
                name(e.protocol),
                e.host,
                e.ip,
                e.port,
                e.purpose,
                e.account,
                e.bytes_up as i64,
                e.bytes_down as i64,
                e.duration_ms as i64,
                e.result,
                e.commands,
                country,
            ])
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// What the page asks for: a start-time window, one account, one country.
/// Every field is optional; `country` applies to the table only.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub since_ms: Option<u64>,
    pub until_ms: Option<u64>,
    pub account: Option<String>,
    pub country: Option<String>,
}

/// The WHERE clause every read shares, over `?1..?4`.
const FILTER: &str = "(?1 IS NULL OR at_ms >= ?1) AND (?2 IS NULL OR at_ms < ?2)
    AND (?3 IS NULL OR account = ?3) AND (?4 IS NULL OR country = ?4)";

fn bind(q: &Query) -> (Option<i64>, Option<i64>, Option<&str>, Option<&str>) {
    (
        q.since_ms.map(|v| v as i64),
        q.until_ms.map(|v| v as i64),
        q.account.as_deref().filter(|a| !a.is_empty()),
        q.country.as_deref().filter(|c| !c.is_empty()),
    )
}

/// One stored event, in the camelCase shape `NetEvent` serializes to, plus
/// its country.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub at_ms: u64,
    pub direction: String,
    pub process: String,
    pub protocol: String,
    pub host: String,
    pub ip: Option<String>,
    pub port: u16,
    pub purpose: String,
    pub account: Option<String>,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub duration_ms: u64,
    pub result: String,
    pub commands: Option<u32>,
    pub country: Option<String>,
}

/// The newest `limit` rows matching `q`, newest ARRIVAL first (by id, never
/// by `at_ms`).
pub fn recent(conn: &Connection, q: &Query, limit: usize) -> Result<Vec<Row>, String> {
    let (since, until, account, country) = bind(q);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT at_ms, direction, process, protocol, host, ip, port, purpose, account,
                    bytes_up, bytes_down, duration_ms, result, commands, country
             FROM net_events WHERE {FILTER} ORDER BY id DESC LIMIT ?5"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![since, until, account, country, limit as i64], |r| {
            Ok(Row {
                at_ms: r.get::<_, i64>(0)? as u64,
                direction: r.get(1)?,
                process: r.get(2)?,
                protocol: r.get(3)?,
                host: r.get(4)?,
                ip: r.get(5)?,
                port: r.get(6)?,
                purpose: r.get(7)?,
                account: r.get(8)?,
                bytes_up: r.get::<_, i64>(9)? as u64,
                bytes_down: r.get::<_, i64>(10)? as u64,
                duration_ms: r.get::<_, i64>(11)? as u64,
                result: r.get(12)?,
                commands: r.get(13)?,
                country: r.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// One country on the map: `country` is ISO alpha-2 or `geo_ip::LOCAL`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub country: String,
    pub connections: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    /// The most-contacted hosts, most first.
    pub hosts: Vec<String>,
}

/// Where the outgoing connections in `q`'s window went, most first. Lookups
/// are left out (they reach the resolver, not the host they name), and so is
/// what could not be placed. `q.country` is ignored: the map shows them all.
pub fn geo(conn: &Connection, q: &Query) -> Result<Vec<Place>, String> {
    let (since, until, account, _) = bind(q);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT country, host, COUNT(*), SUM(bytes_up), SUM(bytes_down) FROM net_events
             WHERE {FILTER} AND country IS NOT NULL AND protocol != 'dns' AND direction = 'out'
             GROUP BY country, host"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![since, until, account, None::<&str>], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)? as u64,
                r.get::<_, i64>(3)? as u64,
                r.get::<_, i64>(4)? as u64,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut by_country: HashMap<String, (Place, Vec<(u64, String)>)> = HashMap::new();
    for row in rows {
        let (country, host, n, up, down) = row.map_err(|e| e.to_string())?;
        let (place, hosts) = by_country.entry(country.clone()).or_insert_with(|| {
            (Place { country, connections: 0, bytes_up: 0, bytes_down: 0, hosts: Vec::new() }, Vec::new())
        });
        place.connections += n;
        place.bytes_up += up;
        place.bytes_down += down;
        hosts.push((n, host));
    }
    let mut places: Vec<Place> = by_country
        .into_values()
        .map(|(mut place, mut hosts)| {
            hosts.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            place.hosts = hosts.into_iter().take(TOP_HOSTS).map(|(_, h)| h).collect();
            place
        })
        .collect();
    places.sort_by(|a, b| b.connections.cmp(&a.connections).then_with(|| a.country.cmp(&b.country)));
    Ok(places)
}

/// The totals over `q`'s window, and the accounts seen in it (for the
/// account filter, so it ignores `q.account`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Distinct hosts MailVault reached out to: not a lookup's name (that
    /// contacts the resolver) nor an inbound hit.
    pub hosts: u64,
    pub sent: u64,
    pub received: u64,
    pub accounts: Vec<String>,
}

pub fn summary(conn: &Connection, q: &Query) -> Result<Summary, String> {
    let (since, until, account, _) = bind(q);
    let (hosts, sent, received) = conn
        .query_row(
            &format!(
                "SELECT COUNT(DISTINCT CASE WHEN direction = 'out' AND protocol != 'dns' THEN host END),
                        COALESCE(SUM(bytes_up), 0), COALESCE(SUM(bytes_down), 0)
                 FROM net_events WHERE {FILTER}"
            ),
            params![since, until, account, None::<&str>],
            |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)),
        )
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT DISTINCT account FROM net_events WHERE {FILTER} AND account IS NOT NULL ORDER BY account"
        ))
        .map_err(|e| e.to_string())?;
    let accounts = stmt
        .query_map(params![since, until, None::<&str>, None::<&str>], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(Summary { hosts, sent, received, accounts })
}

enum Msg {
    Event(NetEvent, Option<String>),
    /// Store everything queued before this, then answer.
    Flush(SyncSender<()>),
}

/// The daemon's store of events: the writer thread's queue, and a reader
/// connection for the page's queries.
pub struct NetLog {
    app_dir: PathBuf,
    tx: SyncSender<Msg>,
    read: Mutex<Option<Connection>>,
}

impl NetLog {
    /// Start the writer for `<app_dir>/app.db`. It prunes first, then every
    /// hour; it ends when the `NetLog` is dropped.
    pub fn start(app_dir: &Path) -> NetLog {
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let dir = app_dir.to_path_buf();
        let spawned = std::thread::Builder::new().name("net-log".into()).spawn(move || writer(&dir, rx));
        if let Err(e) = spawned {
            tracing::warn!("[net-log] writer thread did not start: {e}");
        }
        NetLog { app_dir: app_dir.to_path_buf(), tx, read: Mutex::new(None) }
    }

    /// Queue `ev` for the store; never blocks.
    pub fn push(&self, ev: &NetEvent, country: Option<String>) {
        if let Err(TrySendError::Full(_)) = self.tx.try_send(Msg::Event(ev.clone(), country)) {
            tracing::warn!("[net-log] queue full, an event was not kept");
        }
    }

    /// Wait until everything pushed so far is stored (or the writer is gone).
    pub fn flush(&self) {
        let (done, wait) = mpsc::sync_channel(1);
        if self.tx.send(Msg::Flush(done)).is_ok() {
            let _ = wait.recv();
        }
    }

    /// Run `f` on the reader connection, opening it on first use. Blocking:
    /// call from `spawn_blocking`.
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let mut slot = self.read.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_none() {
            *slot = Some(db::open(&self.app_dir).map_err(|e| e.to_string())?);
        }
        f(slot.as_ref().expect("opened above"))
    }

    /// Set the period and prune to it at once. Blocking.
    pub fn set_retention(&self, r: Retention) -> Result<(), String> {
        self.read(|conn| {
            set_retention(conn, r)?;
            prune(conn, now_ms()).map(|_| ())
        })
    }
}

fn writer(app_dir: &Path, rx: Receiver<Msg>) {
    let conn = match db::open(app_dir) {
        Ok(c) => c,
        Err(e) => {
            // Nothing is kept this run; the live page still works. Drain so
            // `flush` callers are answered and pushes do not fill the queue.
            tracing::warn!("[net-log] app store unavailable, events will not be kept: {e}");
            while let Ok(msg) = rx.recv() {
                if let Msg::Flush(done) = msg {
                    let _ = done.send(());
                }
            }
            return;
        }
    };
    let prune_now = |conn: &Connection| {
        if let Err(e) = prune(conn, now_ms()) {
            tracing::warn!("[net-log] prune failed: {e}");
        }
    };
    prune_now(&conn);
    let mut last_prune = Instant::now();
    loop {
        let wait = PRUNE_EVERY.saturating_sub(last_prune.elapsed());
        let first = match rx.recv_timeout(wait) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => {
                prune_now(&conn);
                last_prune = Instant::now();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut batch = Vec::new();
        let mut flushes = Vec::new();
        let mut next = Some(first);
        let deadline = Instant::now() + BATCH_WINDOW;
        while let Some(msg) = next.take() {
            match msg {
                Msg::Event(ev, country) => batch.push((ev, country)),
                // A flush ends the batch: its caller is waiting.
                Msg::Flush(done) => {
                    flushes.push(done);
                    break;
                }
            }
            if batch.len() >= BATCH_MAX {
                break;
            }
            next = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok();
        }
        if !batch.is_empty() {
            if let Err(e) = insert(&conn, &batch) {
                tracing::warn!("[net-log] {} events not kept: {e}", batch.len());
            }
        }
        for done in flushes {
            let _ = done.send(());
        }
        if last_prune.elapsed() >= PRUNE_EVERY {
            prune_now(&conn);
            last_prune = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net_activity::{Direction, Protocol};

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-netlog-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn ev(host: &str, at_ms: u64) -> NetEvent {
        let mut e = NetEvent::out(Protocol::Imap, host, 993, "sync");
        e.at_ms = at_ms;
        e.result = "ok".into();
        e
    }

    fn hosts(rows: &[Row]) -> Vec<&str> {
        rows.iter().map(|r| r.host.as_str()).collect()
    }

    #[test]
    fn pushed_events_are_stored_through_the_writer_newest_arrival_first() {
        let dir = scratch("writer");
        let log = NetLog::start(&dir);
        let now = now_ms();
        // A long session is recorded last with the oldest start time: it
        // still lists first.
        log.push(&ev("first.test", now - 10), Some("DE".into()));
        log.push(&ev("second.test", now - 5), None);
        log.push(&ev("long-session.test", now - 60_000), Some("US".into()));
        log.flush();
        let rows = log.read(|c| recent(c, &Query::default(), TABLE_ROWS)).unwrap();
        assert_eq!(hosts(&rows), ["long-session.test", "second.test", "first.test"]);
        assert_eq!(rows[0].country.as_deref(), Some("US"));
        assert_eq!(rows[0].direction, "out");
        assert_eq!(rows[0].protocol, "imap");
        assert_eq!(rows[0].process, "helper");
        let json = serde_json::to_value(&rows[0]).unwrap();
        for key in ["atMs", "bytesUp", "bytesDown", "durationMs", "country"] {
            assert!(json.get(key).is_some(), "{key} missing: {json}");
        }
        drop(log);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_table_is_capped_at_the_newest_rows() {
        let dir = scratch("cap");
        let conn = db::open(&dir).unwrap();
        let batch: Vec<_> = (0..5).map(|i| (ev(&format!("h{i}.test"), now_ms()), None)).collect();
        insert(&conn, &batch).unwrap();
        assert_eq!(hosts(&recent(&conn, &Query::default(), 2).unwrap()), ["h4.test", "h3.test"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_only_the_chosen_period() {
        let dir = scratch("prune");
        let conn = db::open(&dir).unwrap();
        let now = now_ms();
        let day = Retention::Day.ms();
        insert(&conn, &[
            (ev("three-weeks.test", now - 21 * day), None),
            (ev("ten-days.test", now - 10 * day), None),
            (ev("two-days.test", now - 2 * day), None),
            (ev("hour.test", now - 60 * 60 * 1000), None),
        ])
        .unwrap();
        assert_eq!(retention(&conn), Retention::Week, "a week unless changed");
        assert_eq!(prune(&conn, now).unwrap(), 2);
        assert_eq!(hosts(&recent(&conn, &Query::default(), 10).unwrap()), ["hour.test", "two-days.test"]);
        set_retention(&conn, Retention::Day).unwrap();
        assert_eq!(retention(&conn), Retention::Day);
        prune(&conn, now).unwrap();
        assert_eq!(hosts(&recent(&conn, &Query::default(), 10).unwrap()), ["hour.test"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setting_the_period_prunes_at_once() {
        let dir = scratch("set");
        let log = NetLog::start(&dir);
        let now = now_ms();
        log.push(&ev("three-days.test", now - 3 * Retention::Day.ms()), None);
        log.push(&ev("now.test", now), None);
        log.flush();
        log.set_retention(Retention::Day).unwrap();
        let (kept, r) = log.read(|c| Ok((recent(c, &Query::default(), 10)?, retention(c)))).unwrap();
        assert_eq!(hosts(&kept), ["now.test"]);
        assert_eq!(r, Retention::Day);
        drop(log);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_serializes_as_the_page_names_it() {
        assert_eq!(serde_json::to_value(Retention::TwoWeeks).unwrap(), "twoWeeks");
        assert_eq!(serde_json::from_value::<Retention>("month".into()).unwrap(), Retention::Month);
        assert!(serde_json::from_value::<Retention>("year".into()).is_err());
    }

    #[test]
    fn reads_filter_by_window_account_and_country() {
        let dir = scratch("filter");
        let conn = db::open(&dir).unwrap();
        let mut a = ev("a.test", 1000);
        a.account = Some("one@example.test".into());
        let mut b = ev("b.test", 2000);
        b.account = Some("two@example.test".into());
        let c = ev("c.test", 3000);
        insert(&conn, &[(a, Some("DE".into())), (b, Some("US".into())), (c, Some("DE".into()))]).unwrap();
        let q = |since, until, account: Option<&str>, country: Option<&str>| Query {
            since_ms: since,
            until_ms: until,
            account: account.map(str::to_string),
            country: country.map(str::to_string),
        };
        assert_eq!(hosts(&recent(&conn, &q(Some(2000), None, None, None), 10).unwrap()), ["c.test", "b.test"]);
        assert_eq!(hosts(&recent(&conn, &q(None, Some(3000), None, None), 10).unwrap()), ["b.test", "a.test"]);
        assert_eq!(hosts(&recent(&conn, &q(None, None, Some("one@example.test"), None), 10).unwrap()), ["a.test"]);
        assert_eq!(hosts(&recent(&conn, &q(None, None, None, Some("DE")), 10).unwrap()), ["c.test", "a.test"]);
        assert_eq!(hosts(&recent(&conn, &q(None, None, Some(""), Some("")), 10).unwrap()).len(), 3, "empty means any");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn geo_groups_outgoing_placed_connections_by_country_with_top_hosts() {
        let dir = scratch("geo");
        let conn = db::open(&dir).unwrap();
        let with = |host: &str, at: u64, account: Option<&str>, up: u64, down: u64| {
            let mut e = ev(host, at);
            e.account = account.map(str::to_string);
            e.bytes_up = up;
            e.bytes_down = down;
            e
        };
        let mut lookup = with("imap.de.test", 100, Some("one@x.test"), 0, 0);
        lookup.protocol = Protocol::Dns;
        let mut inbound = with("127.0.0.1", 100, None, 1, 1);
        inbound.direction = Direction::In;
        insert(&conn, &[
            (with("imap.de.test", 100, Some("one@x.test"), 10, 100), Some("DE".into())),
            (with("imap.de.test", 200, Some("one@x.test"), 10, 100), Some("DE".into())),
            (with("api.de.test", 300, None, 1, 2), Some("DE".into())),
            (with("smtp.us.test", 400, Some("two@x.test"), 5, 5), Some("US".into())),
            (with("nas.local", 500, None, 7, 7), Some("local".into())),
            (with("unplaced.test", 600, None, 9, 9), None),
            // A lookup (resolver, not the host) and an inbound hit stay off the map.
            (lookup, Some("DE".into())),
            (inbound, Some("local".into())),
        ])
        .unwrap();
        let all = geo(&conn, &Query::default()).unwrap();
        let de = &all[0];
        assert_eq!(de.country, "DE");
        assert_eq!((de.connections, de.bytes_up, de.bytes_down), (3, 21, 202));
        assert_eq!(de.hosts, ["imap.de.test", "api.de.test"]);
        assert_eq!(all.iter().map(|p| p.country.as_str()).collect::<Vec<_>>(), ["DE", "US", "local"]);
        let local = all.iter().find(|p| p.country == "local").unwrap();
        assert_eq!(local.connections, 1, "the inbound hit is not counted");

        let one = geo(&conn, &Query { account: Some("one@x.test".into()), ..Default::default() }).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!((one[0].country.as_str(), one[0].connections), ("DE", 2));
        let late = geo(&conn, &Query { since_ms: Some(350), until_ms: Some(450), ..Default::default() }).unwrap();
        assert_eq!(late.iter().map(|p| p.country.as_str()).collect::<Vec<_>>(), ["US"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn summary_counts_hosts_reached_and_bytes_and_lists_every_account_in_the_window() {
        let dir = scratch("summary");
        let conn = db::open(&dir).unwrap();
        let mut a = ev("imap.a.test", 100);
        a.account = Some("one@x.test".into());
        a.bytes_up = 10;
        a.bytes_down = 100;
        let mut b = ev("imap.a.test", 200);
        b.account = Some("one@x.test".into());
        b.bytes_up = 5;
        let mut lookup = ev("only-looked-up.test", 200);
        lookup.protocol = Protocol::Dns;
        let mut c = ev("smtp.b.test", 300);
        c.account = Some("two@x.test".into());
        c.bytes_up = 1000;
        insert(&conn, &[(a, None), (b, None), (lookup, None), (c, None)]).unwrap();
        let all = summary(&conn, &Query::default()).unwrap();
        assert_eq!((all.hosts, all.sent, all.received), (2, 1015, 100));
        assert_eq!(all.accounts, ["one@x.test", "two@x.test"]);
        let one = summary(&conn, &Query { account: Some("one@x.test".into()), ..Default::default() }).unwrap();
        assert_eq!((one.hosts, one.sent), (1, 15));
        assert_eq!(one.accounts, ["one@x.test", "two@x.test"], "the filter's own options ignore the filter");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
