//! A throttled call's `Retry-After`, read once. The Graph client formats a throttle as
//! `(429:retry_after=N)` in its error text; every caller that waits it out (the desktop's
//! migration and move engines, both mobile backends) reads the `N` and bounds the wait here.

const MARKER: &str = "(429:retry_after=";

/// The `N` seconds of a `(429:retry_after=N)` error text; `None` when the text carries no such
/// marker or no digits after it. Case-insensitive.
pub fn retry_after_from(err: &str) -> Option<u64> {
    let lower;
    let err = if err.bytes().any(|b| b.is_ascii_uppercase()) {
        lower = err.to_ascii_lowercase();
        lower.as_str()
    } else {
        err
    };
    let rest = &err[err.find(MARKER)? + MARKER.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// How long to wait out a throttle: the server's `retry_after` seconds, or `default_secs` when
/// it named none, held within `1..=max_secs`.
pub fn throttle_wait(retry_after: Option<u64>, default_secs: u64, max_secs: u64) -> std::time::Duration {
    std::time::Duration::from_secs(retry_after.unwrap_or(default_secs).clamp(1, max_secs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn reads_the_seconds_out_of_the_error_text() {
        let cases: [(&str, Option<u64>); 12] = [
            ("Graph list_messages failed (429:retry_after=3) slow down", Some(3)),
            ("Graph set_read_status failed (429:retry_after=30) slow down", Some(30)),
            ("Graph $batch sub-request 4 answered (429:retry_after=0)", Some(0)),
            ("x (429:retry_after=120)", Some(120)),
            ("(429:retry_after=7", Some(7)),
            ("GRAPH FAILED (429:RETRY_AFTER=9) X", Some(9)),
            ("Graph x failed (429) body", None),
            ("Graph x failed (429:) body", None),
            ("(429:retry_after=) empty", None),
            ("(429:retry_after=abc)", None),
            ("Graph x failed (500) (429:retry_after=oops)", None),
            ("Graph x failed (503) body", None),
        ];
        for (text, want) in cases {
            assert_eq!(retry_after_from(text), want, "{text}");
        }
    }

    #[test]
    fn an_absurd_number_is_no_number() {
        assert_eq!(retry_after_from("(429:retry_after=99999999999999999999999)"), None);
    }

    #[test]
    fn the_wait_is_bounded_and_defaults() {
        let cases = [
            (None, 5, 30, 5),
            (Some(0), 5, 30, 1),
            (Some(1), 5, 30, 1),
            (Some(12), 5, 30, 12),
            (Some(30), 5, 30, 30),
            (Some(31), 5, 30, 30),
            (Some(u64::MAX), 5, 30, 30),
            (None, 99, 30, 30),
        ];
        for (named, default, max, want) in cases {
            assert_eq!(throttle_wait(named, default, max), Duration::from_secs(want), "{named:?}");
        }
    }
}
