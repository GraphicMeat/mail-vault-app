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
    jiff::tz::TimeZone::try_system().map_err(|_| INVALID)
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
