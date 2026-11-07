//! One system picker at a time. The shell takes [`PickLock`] before it asks the native side for a
//! picker and releases it when the native call answers. A native answer can be lost (Android
//! drops an activity result when the activity that launched the picker is destroyed), which
//! would hold the lock forever; so a holder older than the stale limit is taken over. Each holder
//! has its own generation: a taken-over call's late release or answer finds it no longer holds the
//! lock and changes nothing.

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct PickLock {
    inner: Mutex<State>,
}

struct State {
    /// The current holder's generation and when it took the lock.
    holder: Option<(u64, Instant)>,
    next: u64,
}

impl PickLock {
    pub const fn new() -> PickLock {
        PickLock { inner: Mutex::new(State { holder: None, next: 0 }) }
    }

    /// The lock under a new generation, if it is free or its holder took it `stale_after` or more
    /// before `now`. None while a fresh pick runs.
    pub fn take(&self, now: Instant, stale_after: Duration) -> Option<u64> {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, since)) = s.holder {
            if now.saturating_duration_since(since) < stale_after {
                return None;
            }
        }
        s.next += 1;
        let generation = s.next;
        s.holder = Some((generation, now));
        Some(generation)
    }

    /// Whether `generation` still holds the lock (it was not taken over).
    pub fn holds(&self, generation: u64) -> bool {
        let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        matches!(s.holder, Some((g, _)) if g == generation)
    }

    /// Frees the lock if `generation` still holds it; a taken-over generation changes nothing.
    pub fn release(&self, generation: u64) {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(s.holder, Some((g, _)) if g == generation) {
            s.holder = None;
        }
    }
}

impl Default for PickLock {
    fn default() -> Self {
        PickLock::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STALE: Duration = Duration::from_secs(600);

    #[test]
    fn a_fresh_pick_is_exclusive_and_a_stale_one_is_taken_over() {
        let lock = PickLock::new();
        let t0 = Instant::now();
        let first = lock.take(t0, STALE).expect("free lock");
        assert!(lock.holds(first));
        // A second pick while the first is fresh: busy, right up to the limit.
        assert_eq!(lock.take(t0 + Duration::from_secs(60), STALE), None);
        assert_eq!(lock.take(t0 + STALE - Duration::from_millis(1), STALE), None);
        // The first answer was lost: after the limit a new pick takes over.
        let second = lock.take(t0 + STALE, STALE).expect("stale holder is taken over");
        assert_ne!(first, second);
        assert!(!lock.holds(first) && lock.holds(second));
        // The stale call answering late neither frees nor steals the new holder's lock.
        lock.release(first);
        assert!(lock.holds(second));
        assert_eq!(lock.take(t0 + STALE + Duration::from_secs(1), STALE), None);
        // The holder's own release frees it.
        lock.release(second);
        let third = lock.take(t0 + STALE + Duration::from_secs(2), STALE).expect("released");
        assert!(third > second && lock.holds(third));
    }

    #[test]
    fn a_clock_that_goes_backwards_does_not_take_over() {
        let lock = PickLock::new();
        let t0 = Instant::now() + Duration::from_secs(3600);
        let g = lock.take(t0, STALE).unwrap();
        assert_eq!(lock.take(t0 - Duration::from_secs(1), STALE), None);
        assert!(lock.holds(g));
    }
}
