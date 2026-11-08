//! Civil-day maths on chrono, for the code that turns epoch milliseconds into a calendar date and
//! back without a time zone: the insights model's ISO instants and the mobile engine's IMAP
//! `SINCE` dates and Graph/JMAP timestamps. All of it is UTC.
//!
//! Every function is total. Out-of-range input is clamped to chrono's range (about 262,000
//! years either side of 1970), far beyond any date a mail server sends.

use chrono::{Datelike, NaiveDate};

/// Days from 0001-01-01 (chrono's day 1) to 1970-01-01, plus the one chrono counts from.
const UNIX_FROM_CE: i64 = 719_163;

/// Days since 1970-01-01 of a proleptic Gregorian date. A `day` past the month's end carries into
/// the next month (Feb 31 is Mar 2 or 3), as the hand-rolled maths this replaces did; a month
/// outside 1..=12 is clamped.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let year = y.clamp(i64::from(NaiveDate::MIN.year()), i64::from(NaiveDate::MAX.year())) as i32;
    let first = NaiveDate::from_ymd_opt(year, m.clamp(1, 12) as u32, 1).unwrap_or(NaiveDate::default());
    i64::from(first.num_days_from_ce()) - UNIX_FROM_CE + (d - 1)
}

/// `(year, month 1-12, day 1-31)` of a day count since 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let lo = i64::from(NaiveDate::MIN.num_days_from_ce()) - UNIX_FROM_CE;
    let hi = i64::from(NaiveDate::MAX.num_days_from_ce()) - UNIX_FROM_CE;
    let date = NaiveDate::from_num_days_from_ce_opt((days.clamp(lo, hi) + UNIX_FROM_CE) as i32).unwrap_or(NaiveDate::default());
    (i64::from(date.year()), i64::from(date.month()), i64::from(date.day()))
}

/// `2026-01-05T00:00:00Z` for epoch milliseconds (whole seconds; years 0000 to 9999 are four
/// digits).
pub fn utc_timestamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        for z in [-800_000, -1, 0, 1, 365, 19_000, 20_454, 2_932_896] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
    }

    #[test]
    fn known_days() {
        let cases = [
            ((1970, 1, 1), 0),
            ((1969, 12, 31), -1),
            ((2000, 2, 29), 11_016),
            ((2026, 11, 6), 20_763),
            ((1, 1, 1), -719_162),
            ((9999, 12, 31), 2_932_896),
        ];
        for ((y, m, d), want) in cases {
            assert_eq!(days_from_civil(y, m, d), want, "{y}-{m}-{d}");
            assert_eq!(civil_from_days(want), (y, m, d), "{want}");
        }
    }

    #[test]
    fn a_day_past_the_month_end_carries_over() {
        assert_eq!(days_from_civil(2023, 2, 31), days_from_civil(2023, 3, 3));
        assert_eq!(days_from_civil(2024, 2, 31), days_from_civil(2024, 3, 2));
    }

    #[test]
    fn leap_years_follow_the_gregorian_rule() {
        for (y, leap) in [(1900, false), (2000, true), (2023, false), (2024, true), (2100, false)] {
            assert_eq!(days_from_civil(y, 3, 1) - days_from_civil(y, 2, 1), if leap { 29 } else { 28 }, "{y}");
        }
    }

    #[test]
    fn out_of_range_input_is_clamped_not_a_panic() {
        let _ = civil_from_days(i64::MAX);
        let _ = civil_from_days(i64::MIN);
        let _ = days_from_civil(i64::MAX, 13, 1);
        let _ = days_from_civil(i64::MIN, 0, 1);
    }

    #[test]
    fn timestamps_are_utc_second_precision() {
        let cases = [
            (0, "1970-01-01T00:00:00Z"),
            (1_767_571_200_000, "2026-01-05T00:00:00Z"),
            (1_767_571_200_999, "2026-01-05T00:00:00Z"),
            (-1, "1969-12-31T23:59:59Z"),
            (86_399_000, "1970-01-01T23:59:59Z"),
        ];
        for (ms, want) in cases {
            assert_eq!(utc_timestamp(ms), want, "{ms}");
        }
    }
}
