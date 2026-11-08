//! One outbox state machine for both apps.
//!
//! A row is `Queued` until a worker claims it (`Sending`, committed before the
//! network), then lands where the attempt's [`SendVerdict`] puts it
//! ([`next_state`]): `Sent`, `Failed`, `Uncertain` (the server may have the
//! message: never sent again on its own, the user picks Retry or Discard), or
//! `Queued` again after a wait. A row a crash left `Sending` may have gone
//! out, so opening the store turns it `Uncertain` ([`on_open`]), never back
//! into a send.
//!
//! The store is the platform's ([`OutboxStore`]): mobile keeps its SQLite
//! outbox, the desktop daemon its Scheduled Send rows in app.db. Retry counts
//! and waits come from each platform's own [`RetryPolicy`].

use crate::backoff::RetryPolicy;
use crate::send::classify::SendVerdict;
use std::time::Duration;

/// Where an outbox row stands. The strings are the ones both stores write.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OutboxState {
    /// Waiting to be sent (first time, or again after a proven-unsent failure).
    Queued,
    /// Claimed by a worker; the network may be in use. A row found here at
    /// open was cut off mid-send.
    Sending,
    /// The server took it.
    Sent,
    /// Nothing went out and nothing will on its own (a final refusal, or the
    /// retries ran out).
    Failed,
    /// It may have gone out. Never sent again on its own: the user decides.
    Uncertain,
}

impl OutboxState {
    pub const fn as_str(self) -> &'static str {
        match self {
            OutboxState::Queued => "queued",
            OutboxState::Sending => "sending",
            OutboxState::Sent => "sent",
            OutboxState::Failed => "failed",
            OutboxState::Uncertain => "uncertain",
        }
    }

    /// The state a stored string names; `None` for anything else (a store's
    /// own extra states, such as Scheduled Send's `cancelled`).
    pub fn parse(s: &str) -> Option<OutboxState> {
        Some(match s {
            "queued" => OutboxState::Queued,
            "sending" => OutboxState::Sending,
            "sent" => OutboxState::Sent,
            "failed" => OutboxState::Failed,
            "uncertain" => OutboxState::Uncertain,
            _ => return None,
        })
    }

    /// A user's Retry may send a row in this state (it is not on its way and
    /// has not gone out for sure).
    pub fn user_may_retry(self) -> bool {
        matches!(self, OutboxState::Queued | OutboxState::Failed | OutboxState::Uncertain)
    }
}

/// Where a row goes after attempt number `attempt` (counted from 1) ended
/// with `verdict`, and how long to wait before it is tried again (only for
/// `Queued`). A may-have-sent attempt is `Uncertain` whatever the count; a
/// transient one is `Failed` once the policy's attempts are spent.
pub fn next_state(verdict: SendVerdict, attempt: u32, policy: &RetryPolicy) -> (OutboxState, Option<Duration>) {
    match verdict {
        SendVerdict::Sent => (OutboxState::Sent, None),
        SendVerdict::MayHaveSent => (OutboxState::Uncertain, None),
        SendVerdict::Terminal => (OutboxState::Failed, None),
        SendVerdict::Transient if policy.exhausted(attempt) => (OutboxState::Failed, None),
        SendVerdict::Transient => (OutboxState::Queued, Some(policy.next_delay(attempt))),
    }
}

/// What a row found in `state` when the store opens becomes: `Sending` was cut
/// off mid-send and may have gone out, so it is `Uncertain`; the rest stay.
pub fn on_open(state: OutboxState) -> OutboxState {
    match state {
        OutboxState::Sending => OutboxState::Uncertain,
        other => other,
    }
}

/// A platform's outbox rows. Every write is a compare-and-set on the row's
/// state, so a row discarded, retried or edited while it was being sent is
/// left alone (the call answers `false`).
pub trait OutboxStore {
    type Error;

    /// `Queued` -> `Sending`, committed before the network. `false` when the
    /// row is not queued any more.
    fn claim_sending(&self, id: &str) -> Result<bool, Self::Error>;

    /// `from` -> `to` with the attempt's error text (`None` clears it),
    /// counting one attempt when `count_attempt`, and, for a row going back
    /// to `Queued`, the earliest time it may be sent again (`not_before_ms`,
    /// unix ms; `None` keeps the row's own time). `false` when the row was not
    /// in `from`.
    fn mark(
        &self,
        id: &str,
        from: OutboxState,
        to: OutboxState,
        error: Option<&str>,
        count_attempt: bool,
        not_before_ms: Option<i64>,
    ) -> Result<bool, Self::Error>;

    /// At open, before any worker runs: every `Sending` row becomes
    /// `Uncertain` ([`on_open`]). Answers whether queued rows wait.
    fn on_open(&self, now_ms: i64) -> Result<bool, Self::Error>;

    /// `account`'s queued rows whose not-before time has come (`<= now_ms`;
    /// a scheduled row's fire time, or a retry's wait), oldest first.
    fn queued(&self, account: &str, now_ms: i64) -> Result<Vec<String>, Self::Error>;

    /// The attempts counted for row `id` so far (0 for a row never tried or
    /// not found).
    fn attempts(&self, id: &str) -> Result<u32, Self::Error>;
}

/// Ends a claimed (`Sending`) row's attempt: counts it, moves the row where
/// [`next_state`] says and, for a requeue, sets its wait from `now_ms`.
/// Answers the new state, or `None` when the row had left `Sending` (the user
/// discarded it meanwhile).
pub fn finish<S: OutboxStore + ?Sized>(
    store: &S,
    id: &str,
    verdict: SendVerdict,
    error: Option<&str>,
    now_ms: i64,
    policy: &RetryPolicy,
) -> Result<Option<OutboxState>, S::Error> {
    let attempt = store.attempts(id)?.saturating_add(1);
    let (to, wait) = next_state(verdict, attempt, policy);
    let not_before = wait.map(|w| now_ms.saturating_add(i64::try_from(w.as_millis()).unwrap_or(i64::MAX)));
    let error = if to == OutboxState::Sent { None } else { error };
    Ok(store.mark(id, OutboxState::Sending, to, error, true, not_before)?.then_some(to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    const DESKTOP: RetryPolicy = RetryPolicy::new(Duration::from_secs(30), Duration::MAX, Some(3));
    const MOBILE: RetryPolicy = RetryPolicy::new(Duration::from_secs(5), Duration::from_secs(300), None);

    #[test]
    fn next_state_table() {
        use OutboxState::*;
        use SendVerdict as V;
        let s = Duration::from_secs;
        let cases: [(V, u32, RetryPolicy, (OutboxState, Option<Duration>)); 14] = [
            (V::Sent, 1, DESKTOP, (Sent, None)),
            (V::Sent, 3, DESKTOP, (Sent, None)),
            (V::MayHaveSent, 1, DESKTOP, (Uncertain, None)),
            (V::MayHaveSent, 9, MOBILE, (Uncertain, None)),
            (V::Terminal, 1, DESKTOP, (Failed, None)),
            (V::Terminal, 1, MOBILE, (Failed, None)),
            (V::Transient, 1, DESKTOP, (Queued, Some(s(30)))),
            (V::Transient, 2, DESKTOP, (Queued, Some(s(60)))),
            (V::Transient, 3, DESKTOP, (Failed, None)),
            (V::Transient, 4, DESKTOP, (Failed, None)),
            (V::Transient, 1, MOBILE, (Queued, Some(s(5)))),
            (V::Transient, 2, MOBILE, (Queued, Some(s(10)))),
            (V::Transient, 9, MOBILE, (Queued, Some(s(300)))),
            (V::Transient, 1000, MOBILE, (Queued, Some(s(300)))),
        ];
        for (verdict, attempt, policy, want) in cases {
            assert_eq!(next_state(verdict, attempt, &policy), want, "{verdict:?} attempt {attempt} {policy:?}");
        }
    }

    #[test]
    fn a_row_cut_off_mid_send_opens_uncertain() {
        use OutboxState::*;
        for (found, opened) in [(Queued, Queued), (Sending, Uncertain), (Sent, Sent), (Failed, Failed), (Uncertain, Uncertain)] {
            assert_eq!(on_open(found), opened);
        }
    }

    #[test]
    fn states_round_trip_their_stored_strings() {
        use OutboxState::*;
        for st in [Queued, Sending, Sent, Failed, Uncertain] {
            assert_eq!(OutboxState::parse(st.as_str()), Some(st));
        }
        assert_eq!(OutboxState::parse("cancelled"), None);
        assert!(Uncertain.user_may_retry() && Failed.user_may_retry() && Queued.user_may_retry());
        assert!(!Sending.user_may_retry() && !Sent.user_may_retry());
    }

    /// The contract, on an in-memory store shaped like both apps' tables.
    #[derive(Default)]
    struct Mem {
        rows: RefCell<BTreeMap<String, (String, OutboxState, u32, i64, Option<String>)>>,
    }

    impl Mem {
        fn add(&self, id: &str, account: &str, not_before: i64) {
            self.rows.borrow_mut().insert(id.into(), (account.into(), OutboxState::Queued, 0, not_before, None));
        }
        fn state(&self, id: &str) -> OutboxState {
            self.rows.borrow()[id].1
        }
    }

    impl OutboxStore for Mem {
        type Error = ();
        fn claim_sending(&self, id: &str) -> Result<bool, ()> {
            self.mark(id, OutboxState::Queued, OutboxState::Sending, None, false, None)
        }
        fn mark(&self, id: &str, from: OutboxState, to: OutboxState, error: Option<&str>, count: bool, not_before: Option<i64>) -> Result<bool, ()> {
            let mut rows = self.rows.borrow_mut();
            match rows.get_mut(id) {
                Some(row) if row.1 == from => {
                    row.1 = to;
                    row.2 += count as u32;
                    row.4 = error.map(str::to_owned);
                    if let Some(at) = not_before {
                        row.3 = at;
                    }
                    Ok(true)
                }
                _ => Ok(false),
            }
        }
        fn on_open(&self, _now: i64) -> Result<bool, ()> {
            let mut rows = self.rows.borrow_mut();
            for row in rows.values_mut() {
                row.1 = on_open(row.1);
            }
            Ok(rows.values().any(|r| r.1 == OutboxState::Queued))
        }
        fn queued(&self, account: &str, now: i64) -> Result<Vec<String>, ()> {
            let rows = self.rows.borrow();
            let mut ids: Vec<_> = rows
                .iter()
                .filter(|(_, r)| r.0 == account && r.1 == OutboxState::Queued && r.3 <= now)
                .map(|(id, r)| (r.3, id.clone()))
                .collect();
            ids.sort();
            Ok(ids.into_iter().map(|(_, id)| id).collect())
        }
        fn attempts(&self, id: &str) -> Result<u32, ()> {
            Ok(self.rows.borrow().get(id).map_or(0, |r| r.2))
        }
    }

    #[test]
    fn a_may_have_sent_attempt_is_never_queued_again() {
        let store = Mem::default();
        store.add("a", "acc", 0);
        assert!(store.claim_sending("a").unwrap());
        assert_eq!(finish(&store, "a", SendVerdict::MayHaveSent, Some("dropped"), 1_000, &DESKTOP).unwrap(), Some(OutboxState::Uncertain));
        assert!(store.queued("acc", i64::MAX).unwrap().is_empty());
        assert!(!store.claim_sending("a").unwrap(), "an uncertain row is never claimed by a worker");
    }

    #[test]
    fn a_transient_attempt_waits_then_fails_when_the_policy_runs_out() {
        let store = Mem::default();
        store.add("a", "acc", 0);
        let mut now = 1_000;
        for (n, want) in [(1, OutboxState::Queued), (2, OutboxState::Queued), (3, OutboxState::Failed)] {
            assert_eq!(store.queued("acc", now).unwrap(), vec!["a".to_string()], "attempt {n} is due");
            assert!(store.claim_sending("a").unwrap());
            assert_eq!(finish(&store, "a", SendVerdict::Transient, Some("timeout"), now, &DESKTOP).unwrap(), Some(want));
            assert_eq!(store.attempts("a").unwrap(), n);
            if want == OutboxState::Queued {
                assert!(store.queued("acc", now).unwrap().is_empty(), "not before its wait");
                now += DESKTOP.next_delay_ms(n as i64);
            }
        }
        assert_eq!(store.state("a"), OutboxState::Failed);
    }

    #[test]
    fn a_row_discarded_mid_send_is_left_alone() {
        let store = Mem::default();
        store.add("a", "acc", 0);
        assert!(store.claim_sending("a").unwrap());
        store.rows.borrow_mut().remove("a");
        assert_eq!(finish(&store, "a", SendVerdict::Sent, None, 0, &MOBILE).unwrap(), None);
    }

    #[test]
    fn opening_turns_a_crash_left_sending_row_uncertain_and_keeps_scheduled_rows_waiting() {
        let store = Mem::default();
        store.add("crashed", "acc", 0);
        store.add("later", "acc", 5_000);
        assert!(store.claim_sending("crashed").unwrap());
        assert!(store.on_open(1_000).unwrap(), "a queued row waits");
        assert_eq!(store.state("crashed"), OutboxState::Uncertain);
        assert!(store.queued("acc", 1_000).unwrap().is_empty(), "the scheduled row is not due yet, the crashed one never");
        assert_eq!(store.queued("acc", 5_000).unwrap(), vec!["later".to_string()]);
    }
}
