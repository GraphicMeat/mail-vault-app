//! The send-later rule both apps enforce: free up to 5 minutes, Premium up to
//! 24 hours. One function, so the desktop daemon and the phone engine cannot
//! drift apart. Whether the user is Premium is the caller's answer.

use std::time::Duration;

/// The longest delay without Premium (desktop's `FREE_DELAY_MINUTES`).
pub const FREE_DELAY_MINUTES: u32 = 5;
/// The longest delay with Premium (desktop's `MAX_DELAY_MINUTES`).
pub const MAX_DELAY_MINUTES: u32 = 24 * 60;

pub const FREE_DELAY: Duration = Duration::from_secs(FREE_DELAY_MINUTES as u64 * 60);
pub const MAX_DELAY: Duration = Duration::from_secs(MAX_DELAY_MINUTES as u64 * 60);

/// Why a delay is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleRefusal {
    /// Past the free 5 minutes without Premium.
    PremiumRequired,
    /// Past 24 hours, Premium or not.
    TooFar,
}

impl ScheduleRefusal {
    /// The code the phone's RPC returns (`PREMIUM_REQUIRED`).
    pub fn code(self) -> &'static str {
        match self {
            Self::PremiumRequired => "PREMIUM_REQUIRED",
            Self::TooFar => "SCHEDULE_TOO_FAR",
        }
    }
}

/// May a message be held back for `delay`? Zero and up to 5 minutes: always.
/// Up to 24 hours: Premium only. Longer: never.
pub fn schedule_allowed(delay: Duration, premium: bool) -> Result<(), ScheduleRefusal> {
    if delay > MAX_DELAY {
        Err(ScheduleRefusal::TooFar)
    } else if delay > FREE_DELAY && !premium {
        Err(ScheduleRefusal::PremiumRequired)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn the_rule_table() {
        use ScheduleRefusal::*;
        let table: [(Duration, bool, Result<(), ScheduleRefusal>); 14] = [
            (S(0), false, Ok(())),
            (S(0), true, Ok(())),
            (S(300), false, Ok(())),
            (S(300), true, Ok(())),
            (Duration::from_millis(300_001), false, Err(PremiumRequired)),
            (Duration::from_millis(300_001), true, Ok(())),
            (S(301), false, Err(PremiumRequired)),
            (S(3600), false, Err(PremiumRequired)),
            (S(3600), true, Ok(())),
            (S(86_400), false, Err(PremiumRequired)),
            (S(86_400), true, Ok(())),
            (Duration::from_millis(86_400_001), true, Err(TooFar)),
            (S(86_401), true, Err(TooFar)),
            (S(86_401), false, Err(TooFar)),
        ];
        for (delay, premium, want) in table {
            assert_eq!(schedule_allowed(delay, premium), want, "{delay:?} premium={premium}");
        }
    }

    #[test]
    fn the_constants_are_five_minutes_and_a_day() {
        assert_eq!(FREE_DELAY, S(300));
        assert_eq!(MAX_DELAY, S(86_400));
        assert_eq!(ScheduleRefusal::PremiumRequired.code(), "PREMIUM_REQUIRED");
    }
}
