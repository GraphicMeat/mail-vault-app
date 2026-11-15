//! Data usage (Settings > Data usage on the phone, desktop's `DataUsageSettings`): what each
//! account downloaded and uploaded per day, its daily limits, the warning near a limit, and the
//! pause of background downloads at the download limit.
//!
//! Counting: core counts the wire bytes of every IMAP connection per account address
//! (`transfer_stats::CountingStream`, under TLS and COMPRESS), in this process's global counters.
//! [`flush`] takes this engine's accounts' bytes from them and adds them to the UTC day's row,
//! `acct.<accountId>.usage.<YYYY-MM-DD>` = `{"down":n,"up":n}` in `settings` (no table of its own;
//! rows older than [`KEEP_DAYS`] go, and all of them go with the account). A read adds the bytes
//! not flushed yet, so nothing waits for a flush. Graph and JMAP accounts talk HTTPS, which core
//! does not count per account: they are listed `measured: false` and no limit can stop them.
//!
//! Limits: `acct.<accountId>.transferLimits`, desktop's `transferLimits[accountId]` entry as is
//! (`{capEnabled, warnEnabled, dailyDownLimitBytes, dailyUpLimitBytes}`), shown and applied by
//! core's `transfer_limits` (an empty limit is Gmail's default on a Gmail host, else unlimited).
//! Desktop keeps them per machine (its transfer leaves them out), so an import never carries them.
//! - `capEnabled`: background downloads ([`background_capped`]: the offline downloader in front,
//!   a background run's download pass, attachment prefetch) stop for the day once today's download
//!   reaches the limit, and go on after midnight UTC. Everyday mail (a refresh, new mail for
//!   notifications, a message the user opens, a send) never stops for it, as on desktop.
//! - `warnEnabled`: once a day per account, the first time the day's transfer reaches
//!   `WARN_FRACTION` of a limit, [`tick`] emits `mobile.usage.warning`, which the page shows as a
//!   notice.
//!
//! RPCs: `mobile.dataUsage.get {}` and `mobile.dataUsage.set {accountId, ...}`.

use crate::db::{lock, Engine, Shared};
use crate::events::USAGE_WARNING;
use crate::rpc::{parse, RpcError};
use crate::settings::{get_in, put_in};
use mailvault_core::transfer_limits::{self, TransferLimits};
use mailvault_core::transfer_stats::{self, DayBucket};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Day rows older than this go.
const KEEP_DAYS: i64 = 400;
/// The sync worker keeps the counters at most this often ([`tick_soon`]).
const TICK_EVERY: Duration = Duration::from_secs(30);
/// A typed limit can be no larger (1 PB): anything above is a typo, not a limit.
const MAX_LIMIT: u64 = 1 << 50;
const DAY_MS: i64 = 86_400_000;

#[derive(Default)]
pub(crate) struct State {
    last_tick: Mutex<Option<Instant>>,
    /// One flush at a time, so two cannot read the same row and both add to it.
    flushing: Mutex<()>,
}

pub(crate) fn limits_key(account: &str) -> String {
    format!("acct.{account}.transferLimits")
}

fn day_row(account: &str, day: &str) -> String {
    format!("acct.{account}.usage.{day}")
}

fn warned_key(account: &str) -> String {
    format!("acct.{account}.usageWarned")
}

fn today() -> String {
    transfer_limits::day_key(crate::compose::now_ms())
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// What usage needs of an account row.
struct Acct {
    id: String,
    email: String,
    host: String,
    /// IMAP: core counts its bytes.
    measured: bool,
}

fn accounts_in(c: &Connection, only: Option<&str>) -> rusqlite::Result<Vec<Acct>> {
    let mut st = c.prepare(&format!(
        "SELECT id, email, imap_host, kind FROM accounts WHERE ?1 IS NULL OR id = ?1 ORDER BY {}",
        crate::accounts::LIST_ORDER
    ))?;
    let rows = st
        .query_map([only], |r| {
            Ok(Acct { id: r.get(0)?, email: r.get(1)?, host: r.get(2)?, measured: r.get::<_, String>(3)? == "imap" })
        })?
        .collect();
    rows
}

fn bucket(v: Option<String>) -> DayBucket {
    v.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn add(a: DayBucket, b: DayBucket) -> DayBucket {
    DayBucket { down: a.down.saturating_add(b.down), up: a.up.saturating_add(b.up) }
}

/// Takes this engine's accounts' counted bytes and adds them to today's rows. Bytes a failed
/// write could not keep are lost: these are statistics.
pub(crate) fn flush(shared: &Shared) {
    let _one = lock(&shared.usage.flushing);
    let Ok(accounts) = shared.read(|c| accounts_in(c, None)) else { return };
    let taken: Vec<(String, DayBucket)> = accounts
        .iter()
        .filter(|a| a.measured)
        .map(|a| (a.id.clone(), transfer_stats::global().take_for(&a.email)))
        .filter(|(_, d)| d.down > 0 || d.up > 0)
        .collect();
    if taken.is_empty() {
        return;
    }
    let day = today();
    let cutoff = transfer_limits::day_key(crate::compose::now_ms() - KEEP_DAYS * DAY_MS);
    let out = shared.write(|c| {
        for (id, d) in &taken {
            let key = day_row(id, &day);
            let sum = add(bucket(get_in(c, &key)?), *d);
            put_in(c, &key, &serde_json::to_string(&sum).unwrap_or_default())?;
            // `acct.<id>.usage.` is followed by the 10-character day.
            let prefix = format!("acct.{id}.usage.");
            c.execute(
                "DELETE FROM settings WHERE substr(key, 1, ?2) = ?1 AND length(key) = ?2 + 10 AND substr(key, ?2 + 1) < ?3",
                rusqlite::params![prefix, prefix.chars().count() as i64, cutoff],
            )?;
        }
        Ok(())
    });
    if let Err(e) = out {
        shared.log(&format!("[usage] keeping the counters: {e}"));
    }
}

/// Every day row of `account`: `(YYYY-MM-DD, bucket)`.
fn days_in(c: &Connection, account: &str) -> rusqlite::Result<Vec<(String, DayBucket)>> {
    let prefix = format!("acct.{account}.usage.");
    let mut st = c.prepare("SELECT substr(key, ?2 + 1), value FROM settings WHERE substr(key, 1, ?2) = ?1 AND length(key) = ?2 + 10")?;
    let rows = st
        .query_map(rusqlite::params![prefix, prefix.chars().count() as i64], |r| Ok((r.get::<_, String>(0)?, bucket(r.get(1)?))))?
        .collect();
    rows
}

/// Today's transfer of `a`: the kept row plus what is counted and not kept yet.
fn today_of(c: &Connection, a: &Acct) -> rusqlite::Result<DayBucket> {
    let kept = bucket(get_in(c, &day_row(&a.id, &today()))?);
    Ok(if a.measured { add(kept, transfer_stats::global().peek_for(&a.email)) } else { kept })
}

fn limits_in(c: &Connection, account: &str) -> rusqlite::Result<Option<Value>> {
    Ok(get_in(c, &limits_key(account))?.and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object))
}

/// Background downloads of `account` stop now: its cap is on and today's download reached the
/// limit (the typed one, or the provider's default on a Gmail host). A read failure, an account
/// core does not count, or no limit: they go on.
pub(crate) fn background_capped(shared: &Shared, account: &str) -> bool {
    shared
        .read(|c| {
            let Some(entry) = limits_in(c, account)? else { return Ok(false) };
            let Some(a) = accounts_in(c, Some(account))?.into_iter().next() else { return Ok(false) };
            if !a.measured {
                return Ok(false);
            }
            let limits: Option<TransferLimits> = serde_json::from_value(entry).ok();
            let Some(limit) = transfer_limits::background_down_limit(limits.as_ref(), &a.host) else { return Ok(false) };
            Ok(today_of(c, &a)?.down >= limit)
        })
        .unwrap_or(false)
}

/// Keeps the counters and warns of a limit near: at most once per account and UTC day, for an
/// account whose warning is on.
pub(crate) fn tick(shared: &Shared) {
    *lock(&shared.usage.last_tick) = Some(Instant::now());
    flush(shared);
    let day = today();
    let due: Vec<(String, transfer_limits::Warning)> = shared
        .read(|c| {
            let mut out = Vec::new();
            for a in accounts_in(c, None)?.into_iter().filter(|a| a.measured) {
                let shown = transfer_limits::display_limits(limits_in(c, &a.id)?.as_ref(), &a.host);
                let Some(w) = transfer_limits::warning(&shown, today_of(c, &a)?) else { continue };
                if get_in(c, &warned_key(&a.id))?.as_deref() != Some(day.as_str()) {
                    out.push((a.id, w));
                }
            }
            Ok(out)
        })
        .unwrap_or_default();
    for (id, w) in due {
        if shared.write(|c| put_in(c, &warned_key(&id), &day)).is_ok() {
            let percent = (w.fraction * 100.0).floor().min(999.0) as u64;
            shared.emit(USAGE_WARNING, json!({ "accountId": id, "direction": w.direction, "percent": percent }));
        }
    }
}

/// [`tick`], unless one ran in the last [`TICK_EVERY`]: what the sync worker calls after a pass.
pub(crate) fn tick_soon(shared: &Shared) {
    let recent = lock(&shared.usage.last_tick).is_some_and(|t| t.elapsed() < TICK_EVERY);
    if !recent {
        tick(shared);
    }
}

/// `{down, up}` totals of the days in `days` that `keep` takes.
fn total(days: &[(String, DayBucket)], keep: impl Fn(&str) -> bool) -> DayBucket {
    days.iter().filter(|(d, _)| keep(d)).fold(DayBucket::default(), |s, (_, b)| add(s, *b))
}

fn account_json(c: &Connection, a: &Acct) -> rusqlite::Result<Value> {
    let now = crate::compose::now_ms();
    let today = transfer_limits::day_key(now);
    let week_from = transfer_limits::day_key(now - 6 * DAY_MS);
    let mut days = days_in(c, &a.id)?;
    // Today as kept plus what is not kept yet.
    days.retain(|(d, _)| *d != today);
    days.push((today.clone(), today_of(c, a)?));
    let entry = limits_in(c, &a.id)?;
    let shown = transfer_limits::display_limits(entry.as_ref(), &a.host);
    let today_b = total(&days, |d| d == today);
    let warning = transfer_limits::warning(&shown, today_b);
    let typed = |name: &str| entry.as_ref().and_then(|e| e.get(name)).and_then(Value::as_u64);
    Ok(json!({
        "accountId": a.id,
        "measured": a.measured,
        "today": today_b,
        "week": total(&days, |d| d >= week_from.as_str()),
        "month": total(&days, |d| d.get(..7) == today.get(..7)),
        "year": total(&days, |d| d.get(..4) == today.get(..4)),
        "limits": shown,
        // What the user typed (the fields), apart from what applies (`limits`).
        "typed": { "dailyDownLimitBytes": typed("dailyDownLimitBytes"), "dailyUpLimitBytes": typed("dailyUpLimitBytes") },
        "paused": a.measured && shown.cap_enabled && background_capped_in(c, a, entry.as_ref())?,
        "warning": warning,
    }))
}

fn background_capped_in(c: &Connection, a: &Acct, entry: Option<&Value>) -> rusqlite::Result<bool> {
    let limits: Option<TransferLimits> = entry.and_then(|e| serde_json::from_value(e.clone()).ok());
    let Some(limit) = transfer_limits::background_down_limit(limits.as_ref(), &a.host) else { return Ok(false) };
    Ok(today_of(c, a)?.down >= limit)
}

/// `mobile.dataUsage.get {}` -> `{accounts: [{accountId, measured, today, week, month, year:
/// {down, up}, limits: {gmail, capEnabled, warnEnabled, down, up: {limitBytes, isProviderDefault,
/// defaultCapOn, defaultCapOff}}, typed: {dailyDownLimitBytes, dailyUpLimitBytes}, paused,
/// warning: {direction, fraction}|null}]}` in the account list's order. Days are UTC, as on
/// desktop; `week` is the last seven days.
pub(crate) fn get(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    flush(engine.shared());
    let accounts = engine
        .read(|c| {
            let mut out = Vec::new();
            for a in accounts_in(c, None)? {
                out.push(account_json(c, &a)?);
            }
            Ok(out)
        })
        .map_err(internal)?;
    Ok(json!({ "accounts": accounts }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetParams {
    account_id: String,
    #[serde(default)]
    cap_enabled: Option<bool>,
    #[serde(default)]
    warn_enabled: Option<bool>,
    /// `null` empties the field (the provider default, or unlimited); absent leaves it.
    #[serde(default, deserialize_with = "some_value")]
    daily_down_limit_bytes: Option<Value>,
    #[serde(default, deserialize_with = "some_value")]
    daily_up_limit_bytes: Option<Value>,
}

/// A present field, `null` included, as `Some`.
fn some_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

fn limit_value(v: &Value) -> Option<Value> {
    match v {
        Value::Null => Some(Value::Null),
        _ => v.as_u64().filter(|n| *n <= MAX_LIMIT).map(Value::from),
    }
}

/// `mobile.dataUsage.set {accountId, capEnabled?, warnEnabled?, dailyDownLimitBytes?,
/// dailyUpLimitBytes?}` -> the account's entry as `get` lists it. A limit is a whole number of
/// bytes or `null` (empty). Anything else, or an unknown account, is `INVALID` and changes nothing.
/// A raised or lifted limit wakes the offline downloader, so a paused download goes on now.
pub(crate) fn set(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SetParams = parse(params)?;
    let mut patch = Map::new();
    if let Some(v) = p.cap_enabled {
        patch.insert("capEnabled".into(), json!(v));
    }
    if let Some(v) = p.warn_enabled {
        patch.insert("warnEnabled".into(), json!(v));
    }
    for (name, v) in [("dailyDownLimitBytes", &p.daily_down_limit_bytes), ("dailyUpLimitBytes", &p.daily_up_limit_bytes)] {
        if let Some(v) = v {
            let ok = limit_value(v).ok_or_else(|| RpcError::Invalid(format!("{name} is a whole number of bytes or null")))?;
            patch.insert(name.into(), ok);
        }
    }
    let out = engine
        .write(|c| {
            let known = c.query_row("SELECT 1 FROM accounts WHERE id = ?1", [&p.account_id], |_| Ok(())).optional()?.is_some();
            if !known {
                return Ok(None);
            }
            let mut entry = limits_in(c, &p.account_id)?.and_then(|v| v.as_object().cloned()).unwrap_or_default();
            for (k, v) in &patch {
                if v.is_null() {
                    entry.remove(k);
                } else {
                    entry.insert(k.clone(), v.clone());
                }
            }
            put_in(c, &limits_key(&p.account_id), &Value::Object(entry).to_string())?;
            Ok(Some(()))
        })
        .map_err(internal)?;
    if out.is_none() {
        return Err(RpcError::Invalid("unknown account".into()));
    }
    engine.offline_wake();
    engine
        .read(|c| {
            let a = accounts_in(c, Some(&p.account_id))?.into_iter().next();
            a.map(|a| account_json(c, &a)).transpose()
        })
        .map_err(internal)?
        .ok_or_else(|| RpcError::Invalid("unknown account".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{MockImap, Scenario};
    use std::sync::Arc;

    fn mail(uid: u32) -> Message {
        Message::new(
            uid,
            format!(
                "From: A <a@example.com>\r\nTo: u@example.test\r\nSubject: s{uid}\r\nMessage-ID: <usage-{uid}@x>\r\n\
                 Content-Type: text/plain; charset=utf-8\r\n\r\nBody {uid} {}.\r\n",
                "x".repeat(2000)
            ),
        )
        .with_internal_ms(crate::compose::now_ms() - DAY_MS + uid as i64 * 1000)
    }

    struct Fx {
        _tmp: tempfile::TempDir,
        e: Engine,
        account: String,
        events: Arc<Mutex<Vec<(String, Value)>>>,
    }

    /// An engine with one IMAP account under `email`: core's counters are per process and keyed by
    /// address, so every test takes an address of its own.
    fn fx(server: &MockImap, email: &str) -> Fx {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        e.set_front_downloads_for_tests(false);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        e.set_event_sink(move |n, v| sink.lock().unwrap().push((n.to_string(), v)));
        let added = e
            .rpc(
                "mobile.accounts.add",
                json!({ "email": email, "password": "pw", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
            )
            .unwrap();
        let account = added["account"]["id"].as_str().unwrap().to_string();
        Fx { _tmp: tmp, e, account, events }
    }

    impl Fx {
        fn get(&self) -> Value {
            self.e.rpc("mobile.dataUsage.get", json!({})).unwrap()["accounts"][0].clone()
        }

        fn set(&self, patch: Value) -> Result<Value, RpcError> {
            let mut p = patch;
            p["accountId"] = json!(self.account);
            self.e.rpc("mobile.dataUsage.set", p)
        }

        fn bodies(&self) -> i64 {
            self.e.read(|c| c.query_row("SELECT count(*) FROM bodies", [], |r| r.get(0))).unwrap()
        }

        fn download(&self) {
            match crate::sync::download_now_for_test(self.e.shared(), &self.account, false) {
                Ok(()) => {}
                Err(crate::sync::Fail::Code(code, why)) => panic!("download failed: {} {why}", code.as_str()),
                Err(_) => panic!("download stopped early"),
            }
        }

        fn warnings(&self) -> Vec<Value> {
            self.events.lock().unwrap().iter().filter(|(n, _)| n == USAGE_WARNING).map(|(_, v)| v.clone()).collect()
        }
    }

    fn server() -> MockImap {
        let mut mb = Mailbox::new("INBOX");
        for uid in 1..=3 {
            mb.add(mail(uid));
        }
        MockImap::start(Scenario::new().mailbox(mb))
    }

    /// A sync's wire bytes show as today's, kept by day in `settings`, and nothing is counted
    /// twice: what was kept leaves core's counters.
    #[test]
    fn traffic_is_counted_and_kept_by_day() {
        let server = server();
        let f = fx(&server, "usage-count@example.test");
        let before = f.get();
        assert_eq!(before["measured"], true);
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        let got = f.get();
        let down = got["today"]["down"].as_u64().unwrap();
        assert!(down > before["today"]["down"].as_u64().unwrap(), "{got}");
        assert!(got["today"]["up"].as_u64().unwrap() > 0, "{got}");
        assert_eq!(got["week"], got["today"]);
        assert_eq!(got["month"], got["today"]);
        assert_eq!(transfer_stats::global().peek_for("usage-count@example.test"), DayBucket::default(), "kept bytes were left in the counters");
        let row = f.e.read(|c| get_in(c, &day_row(&f.account, &today()))).unwrap().unwrap();
        assert_eq!(bucket(Some(row)).down, down);
        // A second read adds nothing.
        assert_eq!(f.get()["today"]["down"], down);
        // No limits: nothing applies, the warning is on.
        assert_eq!(got["limits"]["capEnabled"], false);
        assert_eq!(got["limits"]["warnEnabled"], true);
        assert_eq!(got["limits"]["down"]["limitBytes"], Value::Null);
        assert_eq!(got["paused"], false);
    }

    /// With the cap on and today's download past the limit, a background download fetches
    /// nothing and the account reads paused; lifting the limit lets the next download through.
    /// A refresh (everyday mail) is never stopped.
    #[test]
    fn the_cap_pauses_background_downloads_at_the_daily_limit() {
        let server = server();
        let f = fx(&server, "usage-cap@example.test");
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        let entry = f.set(json!({ "capEnabled": true, "dailyDownLimitBytes": 1 })).unwrap();
        assert_eq!(entry["limits"]["down"]["limitBytes"], 1);
        assert_eq!(entry["typed"]["dailyDownLimitBytes"], 1);
        assert_eq!(entry["paused"], true);
        assert!(background_capped(f.e.shared(), &f.account));
        f.download();
        assert_eq!(f.bodies(), 0, "a capped download fetched bodies");
        // Everyday mail still syncs.
        server.mutate(|s| { s.find_mut("INBOX").unwrap().add(mail(4)); });
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        let rows: i64 = f.e.read(|c| c.query_row("SELECT count(*) FROM messages", [], |r| r.get(0))).unwrap();
        assert_eq!(rows, 4);

        // An empty field off Gmail is unlimited: the download goes on.
        let entry = f.set(json!({ "dailyDownLimitBytes": null })).unwrap();
        assert_eq!(entry["limits"]["down"]["limitBytes"], Value::Null);
        assert_eq!(entry["paused"], false);
        f.download();
        assert_eq!(f.bodies(), 4);
    }

    /// The cap off: a limit only warns, it never pauses.
    #[test]
    fn a_limit_without_the_cap_never_pauses() {
        let server = server();
        let f = fx(&server, "usage-nocap@example.test");
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        f.set(json!({ "dailyDownLimitBytes": 1 })).unwrap();
        assert!(!background_capped(f.e.shared(), &f.account));
        f.download();
        assert_eq!(f.bodies(), 3);
    }

    /// Past 80% of a limit the warning goes out once a day; switched off, never.
    #[test]
    fn the_warning_goes_out_once_a_day_and_only_when_on() {
        let server = server();
        let f = fx(&server, "usage-warn@example.test");
        f.set(json!({ "warnEnabled": false, "dailyDownLimitBytes": 1 })).unwrap();
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        tick(f.e.shared());
        assert!(f.warnings().is_empty(), "warned with the warning off");
        assert!(f.get()["warning"].is_null());

        f.set(json!({ "warnEnabled": true })).unwrap();
        assert_eq!(f.get()["warning"]["direction"], "download");
        tick(f.e.shared());
        tick(f.e.shared());
        let w = f.warnings();
        assert_eq!(w.len(), 1, "{w:?}");
        assert_eq!(w[0]["accountId"], json!(f.account));
        assert_eq!(w[0]["direction"], "download");
        assert!(w[0]["percent"].as_u64().unwrap() >= 80);
    }

    #[test]
    fn set_refuses_what_is_not_a_limit() {
        let server = server();
        let f = fx(&server, "usage-set@example.test");
        for bad in [json!({ "dailyDownLimitBytes": -1 }), json!({ "dailyDownLimitBytes": "5" }), json!({ "dailyUpLimitBytes": 1.5 }), json!({ "capEnabled": "yes" }), json!({ "other": 1 })] {
            assert!(f.set(bad.clone()).is_err(), "{bad}");
        }
        assert!(f.e.rpc("mobile.dataUsage.set", json!({ "accountId": "nope", "capEnabled": true })).is_err());
        assert!(f.e.read(|c| get_in(c, &limits_key(&f.account))).unwrap().is_none(), "a refused set wrote");
        let got = f.set(json!({ "dailyUpLimitBytes": 5 * transfer_limits::MB, "warnEnabled": false })).unwrap();
        assert_eq!(got["limits"]["up"]["limitBytes"], 5 * transfer_limits::MB);
        assert_eq!(got["limits"]["warnEnabled"], false);
        // Kept as desktop keeps the entry.
        let stored: Value = serde_json::from_str(&f.e.read(|c| get_in(c, &limits_key(&f.account))).unwrap().unwrap()).unwrap();
        assert_eq!(stored, json!({ "dailyUpLimitBytes": 5 * transfer_limits::MB, "warnEnabled": false }));
    }

    /// Day rows go with the account.
    #[test]
    fn removing_the_account_drops_its_usage() {
        let server = server();
        let f = fx(&server, "usage-remove@example.test");
        crate::sync::sync_now_for_test(f.e.shared(), &f.account, Some("INBOX"));
        f.set(json!({ "capEnabled": true })).unwrap();
        f.get();
        f.e.rpc("mobile.accounts.remove", json!({ "accountId": f.account })).unwrap();
        let left: i64 = f.e.read(|c| c.query_row("SELECT count(*) FROM settings WHERE key LIKE 'acct.%'", [], |r| r.get(0))).unwrap();
        assert_eq!(left, 0);
    }
}
