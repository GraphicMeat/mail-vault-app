//! Pure, bounded backup schedule/config policy. No account IO or job ownership.
//! Every local setter uses ECMAScript Date's earlier-fold/forward-gap choice,
//! pinned against the separately captured real-JS oracle (not compose's different
//! two-pass wall-time conversion). The caller supplies a fresh machine zone.
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Timelike};
use serde_json::{json, Map, Value};

pub const NEVER: i64 = 9_007_199_254_740_991;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;
const INVALID: &str = "errors.settingsInvalid";
pub const CONFIG_KEYS: &[&str] = &[
    "backupGlobalEnabled",
    "backupGlobalConfig",
    "backupSchedules",
    "backupMailboxConcurrency",
    "backupNotifyOnSuccess",
    "backupNotifyOnFailure",
    "snapshotAutoEnabled",
    "snapshotCadence",
];

fn local(epoch: i64, zone: &jiff::tz::TimeZone) -> Result<NaiveDateTime, &'static str> {
    let ts = jiff::Timestamp::from_millisecond(epoch).map_err(|_| INVALID)?;
    chrono::DateTime::from_timestamp_millis(epoch)
        .and_then(|dt| {
            dt.naive_utc()
                .checked_add_signed(Duration::seconds(zone.to_offset(ts).seconds().into()))
        })
        .ok_or(INVALID)
}
fn resolve(dt: NaiveDateTime, zone: &jiff::tz::TimeZone) -> Result<i64, &'static str> {
    let wall = jiff::civil::DateTime::new(
        dt.year().try_into().map_err(|_| INVALID)?,
        dt.month() as i8,
        dt.day() as i8,
        dt.hour() as i8,
        dt.minute() as i8,
        dt.second() as i8,
        dt.nanosecond() as i32,
    )
    .map_err(|_| INVALID)?;
    zone.to_ambiguous_timestamp(wall)
        .compatible()
        .map(|t| t.as_millisecond())
        .map_err(|_| INVALID)
}
fn move_local(epoch: i64, delta: Duration, zone: &jiff::tz::TimeZone) -> Result<i64, &'static str> {
    resolve(
        local(epoch, zone)?
            .checked_add_signed(delta)
            .ok_or(INVALID)?,
        zone,
    )
}
fn validate_schedule(config: &Value) -> Result<(), &'static str> {
    if config.is_null() {
        return Ok(());
    }
    let map = config.as_object().ok_or(INVALID)?;
    for (key, value) in map {
        if value.is_null() {
            continue;
        }
        let valid = match key.as_str() {
            "enabled" => value.is_boolean(),
            "interval" => matches!(
                value.as_str(),
                Some("hourly" | "daily" | "weekly" | "hours")
            ),
            "dayOfWeek" => value.as_u64().is_some_and(|n| n < 7),
            "timeOfDay" => value.as_str().is_some_and(valid_time),
            "hourlyInterval" => value
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.abs() * 3_600_000.0 <= 8_640_000_000_000_000.0),
            // Legacy JS filters invalid and duplicate selected hours. This list
            // never controls loop length; next_eligible searches at most 48.
            "hours" => value.is_array(),
            _ => false,
        };
        if !valid {
            return Err(INVALID);
        }
    }
    Ok(())
}
fn valid_time(text: &str) -> bool {
    let Some((h, m)) = text.split_once(':') else {
        return false;
    };
    h.len() == 2
        && m.len() == 2
        && h.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit())
        && h.parse::<u8>().is_ok_and(|h| h < 24)
        && m.parse::<u8>().is_ok_and(|m| m < 60)
}
/// Validates a narrow settings merge patch. null explicitly removes a field.
pub fn validate_patch(patch: &Value) -> Result<(), &'static str> {
    for (key, value) in patch.as_object().ok_or(INVALID)? {
        if !CONFIG_KEYS.contains(&key.as_str()) {
            return Err(INVALID);
        }
        if value.is_null() {
            continue;
        }
        match key.as_str() {
            "backupGlobalConfig" => validate_schedule(value)?,
            "backupSchedules" => {
                for config in value.as_object().ok_or(INVALID)?.values() {
                    validate_schedule(config)?;
                }
            }
            "backupMailboxConcurrency" if value.as_u64().is_some_and(|n| (1..=5).contains(&n)) => {}
            "snapshotCadence"
                if matches!(
                    value.as_str(),
                    Some("after_every_backup" | "daily" | "weekly")
                ) => {}
            "backupGlobalEnabled"
            | "backupNotifyOnSuccess"
            | "backupNotifyOnFailure"
            | "snapshotAutoEnabled"
                if value.is_boolean() => {}
            _ => return Err(INVALID),
        }
    }
    Ok(())
}

pub fn next_eligible(
    state: &Value,
    config: &Value,
    now: i64,
    zone: &str,
) -> Result<i64, &'static str> {
    let zone = jiff::tz::db().get(zone).map_err(|_| INVALID)?;
    next_in_zone(state, config, now, &zone)
}
/// Uses the actual zone object so platform zones without an IANA name still
/// work. The provider is called on each configuration read, never persisted.
pub fn local_zone() -> Result<jiff::tz::TimeZone, &'static str> {
    if let Some(value) = std::env::var_os("TZ") {
        return zone_from_env(value.to_str().ok_or(INVALID)?);
    }
    // On non-mac Unix a copied /etc/localtime is authoritative; the native
    // name library may otherwise return a stale textual /etc/timezone value.
    let localtime = if cfg!(all(unix, not(target_os = "macos"))) {
        Some(std::path::Path::new("/etc/localtime"))
    } else {
        None
    };
    system_zone(
        || iana_time_zone::get_timezone().map_err(|_| INVALID),
        localtime,
    )
}
fn named_zone(name: &str) -> Result<jiff::tz::TimeZone, &'static str> {
    let zone = jiff::tz::db().get(name).map_err(|_| INVALID)?;
    if zone.is_unknown() {
        return Err(INVALID);
    }
    Ok(zone)
}
fn zoneinfo_name(path: &str) -> Option<&str> {
    path.rsplit_once("zoneinfo/").map(|(_, name)| name)
}
fn read_tzif(path: &std::path::Path) -> Result<jiff::tz::TimeZone, &'static str> {
    // Keep the complete rules and reread every time, including copied files.
    let bytes = std::fs::read(path).map_err(|_| INVALID)?;
    jiff::tz::TimeZone::tzif("local", &bytes).map_err(|_| INVALID)
}
fn zone_from_env(value: &str) -> Result<jiff::tz::TimeZone, &'static str> {
    if value.is_empty() {
        return Ok(jiff::tz::TimeZone::UTC);
    }
    // Preserve Jiff's POSIX rule before name/path precedence. A leading colon
    // selects the implementation/name/path form and is not a POSIX rule.
    if !value.starts_with(':') {
        if let Ok(zone) = jiff::tz::TimeZone::posix(value) {
            return Ok(zone);
        }
    }
    let path = value.strip_prefix(':').unwrap_or(value);
    if let Ok(zone) = named_zone(zoneinfo_name(path).unwrap_or(path)) {
        return Ok(zone);
    }
    read_tzif(std::path::Path::new(path))
}
fn system_zone(
    native_name: impl FnOnce() -> Result<String, &'static str>,
    localtime: Option<&std::path::Path>,
) -> Result<jiff::tz::TimeZone, &'static str> {
    if let Some(path) = localtime {
        if let Ok(target) = std::fs::read_link(path) {
            if let Some(name) = target.to_str().and_then(zoneinfo_name) {
                if let Ok(zone) = named_zone(name) {
                    return Ok(zone);
                }
            }
        }
        return read_tzif(path);
    }
    named_zone(&native_name()?)
}
pub fn next_in_zone(
    state: &Value,
    config: &Value,
    now: i64,
    zone: &jiff::tz::TimeZone,
) -> Result<i64, &'static str> {
    validate_schedule(config)?;
    let last = state["lastBackupTime"].as_i64().unwrap_or(0);
    if config["interval"] == "hours" {
        let hours: Vec<i64> = config["hours"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_i64)
            .filter(|h| (0..24).contains(h))
            .collect();
        if hours.is_empty() {
            return Ok(NEVER);
        }
        let floor = |t| -> Result<i64, &'static str> {
            let dt = local(t, zone)?;
            resolve(dt.date().and_hms_opt(dt.hour(), 0, 0).ok_or(INVALID)?, zone)
        };
        let mut cursor = floor(now)?;
        if last != 0 {
            cursor = cursor.max(move_local(floor(last)?, Duration::hours(1), zone)?);
        }
        for _ in 0..48 {
            if hours.contains(&(local(cursor, zone)?.hour() as i64)) {
                return Ok(cursor);
            }
            cursor = move_local(cursor, Duration::hours(1), zone)?;
        }
        return Ok(NEVER);
    }
    if last == 0 {
        return Ok(0);
    }
    let interval = match config["interval"].as_str() {
        Some("hourly") => {
            let n = config["hourlyInterval"]
                .as_f64()
                .filter(|n| *n != 0.0)
                .unwrap_or(1.0);
            (n * HOUR as f64) as i64
        }
        Some("weekly") => 7 * DAY,
        _ => DAY,
    };
    let mut next = last.checked_add(interval).ok_or(INVALID)?;
    if matches!(config["interval"].as_str(), Some("daily" | "weekly")) {
        let time = config["timeOfDay"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("03:00");
        let (h, m) = time.split_once(':').ok_or(INVALID)?;
        let dt = local(next, zone)?;
        let mut candidate = resolve(
            NaiveDate::from_ymd_opt(dt.year(), dt.month(), dt.day())
                .ok_or(INVALID)?
                .and_hms_opt(
                    h.parse().map_err(|_| INVALID)?,
                    m.parse().map_err(|_| INVALID)?,
                    0,
                )
                .ok_or(INVALID)?,
            zone,
        )?;
        if candidate < next {
            candidate = move_local(candidate, Duration::days(1), zone)?;
        }
        if config["interval"] == "weekly" {
            if let Some(day) = config["dayOfWeek"].as_u64() {
                for _ in 0..7 {
                    if local(candidate, zone)?.weekday().num_days_from_sunday() as u64 == day {
                        break;
                    }
                    candidate = move_local(candidate, Duration::days(1), zone)?;
                }
            }
        }
        next = candidate;
    }
    Ok(next.max(last.checked_add(HOUR).ok_or(INVALID)?))
}

pub fn schedule_for(settings: &Value, id: &str) -> Value {
    if settings["backupGlobalEnabled"] == true {
        let mut config = settings["backupGlobalConfig"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        config.insert("enabled".into(), json!(true));
        Value::Object(config)
    } else {
        settings["backupSchedules"][id].clone()
    }
}
pub fn scheduled(settings: &Value, id: &str, now: i64) -> bool {
    crate::cleanup_rules::has_premium_access(settings, now)
        && settings["hiddenAccounts"][id] != true
        && schedule_for(settings, id)["enabled"] == true
}
pub fn automatic_due(
    settings: &Value,
    id: &str,
    now: i64,
    zone: &str,
    loading: bool,
    last_activity: i64,
    paused: bool,
) -> Result<bool, &'static str> {
    if paused
        || loading
        || now.saturating_sub(last_activity) < 180_000
        || !scheduled(settings, id, now)
    {
        return Ok(false);
    }
    Ok(now
        >= next_eligible(
            &settings["backupState"][id],
            &schedule_for(settings, id),
            now,
            zone,
        )?)
}
pub fn mailbox_concurrency(settings: &Value, now: i64) -> usize {
    if !crate::cleanup_rules::has_premium_access(settings, now) {
        return 1;
    }
    let n = settings["backupMailboxConcurrency"].as_f64().unwrap_or(3.0);
    (n.trunc() as i64).clamp(1, 5) as usize
}
pub fn retry_delay(retries: usize, manual_waiter: bool) -> Option<i64> {
    if manual_waiter {
        None
    } else {
        [30_000, 120_000, 300_000].get(retries).copied()
    }
}
pub fn limit_hold_until(now: i64, resume_after: Option<i64>) -> i64 {
    resume_after
        .unwrap_or_else(|| (now.div_euclid(DAY) + 1) * DAY)
        .saturating_add(30_000)
}
pub fn download_cap_changed(before: &Value, after: &Value) -> bool {
    (before["capEnabled"] == true) != (after["capEnabled"] == true)
        || before["dailyDownLimitBytes"] != after["dailyDownLimitBytes"]
}
pub fn snapshot_due(settings: &Value, id: &str, now: i64, success: bool) -> bool {
    if !success
        || !crate::cleanup_rules::has_premium_access(settings, now)
        || settings["snapshotAutoEnabled"] != true
    {
        return false;
    }
    let elapsed = now.saturating_sub(settings["snapshotLastTimes"][id].as_i64().unwrap_or(0));
    match settings["snapshotCadence"]
        .as_str()
        .unwrap_or("after_every_backup")
    {
        "after_every_backup" => true,
        "daily" => elapsed >= DAY,
        "weekly" => elapsed >= 7 * DAY,
        _ => false,
    }
}
pub fn config_view(settings: &Value) -> Value {
    Value::Object(
        CONFIG_KEYS
            .iter()
            .filter_map(|key| settings.get(*key).map(|v| ((*key).into(), v.clone())))
            .collect::<Map<_, _>>(),
    )
}

#[cfg(test)]
mod zone_provider_tests {
    use super::*;
    mod data {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/support/backup_zone_tzif.rs"
        ));
    }
    fn offsets(zone: &jiff::tz::TimeZone) -> Vec<i32> {
        [1_699_999_999_000, 1_750_000_000_000, 1_800_000_001_000]
            .into_iter()
            .map(|t| {
                zone.to_offset(jiff::Timestamp::from_millisecond(t).unwrap())
                    .seconds()
            })
            .collect()
    }
    #[test]
    fn native_names_are_requested_fresh_and_errors_never_become_utc() {
        for (name, expected) in [
            ("UTC", 1792918800000),
            ("Europe/Vilnius", 1792911600000),
            ("America/New_York", 1792933200000),
            ("UTC", 1792918800000),
        ] {
            let zone = system_zone(|| Ok(name.into()), None).unwrap();
            assert_eq!(
                next_in_zone(
                    &json!({}),
                    &json!({"interval":"hours","hours":[9]}),
                    1792888200000,
                    &zone
                )
                .unwrap(),
                expected
            );
        }
        assert!(system_zone(|| Err(INVALID), None).is_err());
        assert!(system_zone(|| Ok("not-a-zone".into()), None).is_err());
    }
    #[test]
    fn copied_current_localtime_rules_beat_stale_text_and_are_reread() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("localtime");
        let stale = directory.path().join("timezone");
        std::fs::write(&stale, "America/New_York").unwrap();
        let fallback = || std::fs::read_to_string(&stale).map_err(|_| INVALID);
        std::fs::write(&current, data::tzif(7200)).unwrap();
        assert_eq!(
            offsets(&system_zone(fallback, Some(&current)).unwrap()),
            vec![7200, 10800, 7200]
        );
        std::fs::write(&current, data::tzif(0)).unwrap();
        assert_eq!(
            offsets(&system_zone(fallback, Some(&current)).unwrap()),
            vec![0, 3600, 0]
        );
        std::fs::write(&current, b"broken").unwrap();
        assert!(system_zone(fallback, Some(&current)).is_err());
        std::fs::remove_file(&current).unwrap();
        assert!(system_zone(fallback, Some(&current)).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn current_named_localtime_link_uses_bundled_rules() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("localtime");
        std::os::unix::fs::symlink("/not-present/zoneinfo/Europe/Vilnius", &current).unwrap();
        let zone = system_zone(
            || panic!("stale textual fallback cannot win"),
            Some(&current),
        )
        .unwrap();
        assert_eq!(zone.iana_name(), Some("Europe/Vilnius"));
    }
}
