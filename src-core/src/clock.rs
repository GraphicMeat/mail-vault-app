//! The wall clock in epoch milliseconds, defined once for the crate.
//!
//! A clock before the epoch reads as 0 rather than failing, which is what every
//! private copy this replaced did.

use std::time::{SystemTime, UNIX_EPOCH};

/// An hour and a day in epoch milliseconds: the one copy of these lengths.
pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 24 * HOUR_MS;

/// Milliseconds since the Unix epoch (0 if the system clock is before it).
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// [`now_ms`] for the callers that keep their stamps unsigned.
pub fn now_ms_u64() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_widths_read_the_same_present_instant() {
        // 2020-09-13 in epoch ms: any real clock is past it.
        assert!(now_ms() > 1_600_000_000_000);
        let (signed, unsigned) = (now_ms(), now_ms_u64());
        assert!(unsigned as i64 >= signed, "the unsigned read came second");
        assert!((unsigned as i64 - signed).abs() < 5_000, "the two reads are the same instant");
    }
}
