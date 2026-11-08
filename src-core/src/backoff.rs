//! One retry backoff for every worker that waits out a failure: the wait doubles per failure
//! from `base` and never passes `cap`. Each caller keeps its own values as a `RetryPolicy`
//! constant (desktop scheduled send 30 s doubling for 3 attempts, the mobile outbox 5 s to 300 s
//! unbounded); the maths lives here once.

use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// The wait after the first failure.
    pub base: Duration,
    /// The wait never grows past this.
    pub cap: Duration,
    /// Attempts allowed before the work is given up on; `None` retries for ever.
    pub max_attempts: Option<u32>,
}

impl RetryPolicy {
    pub const fn new(base: Duration, cap: Duration, max_attempts: Option<u32>) -> RetryPolicy {
        RetryPolicy { base, cap, max_attempts }
    }

    /// The wait after the `attempt`th failure in a row (counted from 1; 0 counts as 1):
    /// `base`, doubled per further failure, at most `cap`.
    pub fn next_delay(&self, attempt: u32) -> Duration {
        let shift = attempt.saturating_sub(1).min(31);
        self.base.saturating_mul(1u32 << shift).min(self.cap)
    }

    /// `next_delay` for the queues that count attempts as `i64` and wait in unix milliseconds.
    pub fn next_delay_ms(&self, attempt: i64) -> i64 {
        let attempt = attempt.clamp(1, u32::MAX as i64) as u32;
        i64::try_from(self.next_delay(attempt).as_millis()).unwrap_or(i64::MAX)
    }

    /// True once `attempt` attempts have been made and the policy allows no more.
    pub fn exhausted(&self, attempt: u32) -> bool {
        self.max_attempts.is_some_and(|m| attempt >= m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(p: &RetryPolicy, n: std::ops::RangeInclusive<u32>) -> Vec<u64> {
        n.map(|a| p.next_delay(a).as_secs()).collect()
    }

    #[test]
    fn doubles_from_the_base_to_the_cap() {
        let cases: [(RetryPolicy, Vec<u64>); 4] = [
            // mobile outbox, replay and live: 5 s to 300 s
            (RetryPolicy::new(Duration::from_secs(5), Duration::from_secs(300), None), vec![5, 10, 20, 40, 80, 160, 300, 300, 300]),
            // desktop idle watch: 30 s to 300 s
            (RetryPolicy::new(Duration::from_secs(30), Duration::from_secs(300), None), vec![30, 60, 120, 240, 300, 300, 300, 300, 300]),
            // desktop JMAP push: 1 s to 300 s
            (RetryPolicy::new(Duration::from_secs(1), Duration::from_secs(300), None), vec![1, 2, 4, 8, 16, 32, 64, 128, 256]),
            // desktop scheduled send
            (RetryPolicy::new(Duration::from_secs(30), Duration::MAX, Some(3)), vec![30, 60, 120, 240, 480, 960, 1920, 3840, 7680]),
        ];
        for (p, want) in cases {
            assert_eq!(secs(&p, 1..=9), want, "{p:?}");
        }
    }

    #[test]
    fn a_huge_attempt_count_saturates_at_the_cap() {
        let p = RetryPolicy::new(Duration::from_secs(1), Duration::from_secs(300), None);
        assert_eq!(p.next_delay(40), Duration::from_secs(300));
        assert_eq!(p.next_delay(u32::MAX), Duration::from_secs(300));
    }

    #[test]
    fn attempt_zero_counts_as_the_first() {
        let p = RetryPolicy::new(Duration::from_secs(5), Duration::from_secs(300), None);
        assert_eq!(p.next_delay(0), Duration::from_secs(5));
    }

    #[test]
    fn a_base_above_the_cap_is_held_to_the_cap() {
        let p = RetryPolicy::new(Duration::from_secs(10), Duration::from_secs(4), None);
        assert_eq!(p.next_delay(1), Duration::from_secs(4));
    }

    #[test]
    fn millisecond_waits_for_the_row_queues() {
        let snooze = RetryPolicy::new(Duration::from_secs(30), Duration::from_secs(30 * 1024), Some(5));
        let got: Vec<i64> = [-3, 0, 1, 2, 3, 4, 11, 12, 500].map(|a| snooze.next_delay_ms(a)).to_vec();
        assert_eq!(got, vec![30_000, 30_000, 30_000, 60_000, 120_000, 240_000, 30_720_000, 30_720_000, 30_720_000]);
    }

    #[test]
    fn exhaustion_follows_max_attempts() {
        let three = RetryPolicy::new(Duration::from_secs(30), Duration::MAX, Some(3));
        assert_eq!([1, 2, 3, 4].map(|a| three.exhausted(a)), [false, false, true, true]);
        let forever = RetryPolicy::new(Duration::from_secs(5), Duration::from_secs(300), None);
        assert!(!forever.exhausted(u32::MAX));
    }
}
