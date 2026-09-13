//! What the app's index worker does with the signals it receives. Pure, so CI
//! tests it; the worker thread and its Tauri state live in the app crate.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// The longest gap between full passes, however many nudges arrive in between.
pub const SWEEP_EVERY: Duration = Duration::from_secs(15 * 60);

/// How long a burst of nudges keeps collecting before its pass starts.
pub const COALESCE: Duration = Duration::from_millis(1500);

#[derive(Debug, PartialEq, Eq)]
pub enum Signal {
    Sweep,
    Nudge { account_id: String, vault_dir: String },
    Rebuild,
    /// The config itself is read from state on every pass; this only wakes the worker.
    Configure,
    /// A vault operation finished: open the current root, then a full pass.
    Reopen,
}

/// What one drained burst of signals asks the worker to do.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub reopen: bool,
    pub rebuild: bool,
    /// `Some(folders)` when every signal was a nudge; otherwise a full pass.
    pub only: Option<Vec<(String, String)>>,
}

pub fn plan(queue: Vec<Signal>) -> Plan {
    let mut p = Plan { reopen: false, rebuild: false, only: None };
    let mut full = false;
    let mut nudges: Vec<(String, String)> = Vec::new();
    for s in queue {
        match s {
            Signal::Reopen => {
                p.reopen = true;
                full = true;
            }
            Signal::Rebuild => {
                p.rebuild = true;
                full = true;
            }
            Signal::Sweep | Signal::Configure => full = true,
            Signal::Nudge { account_id, vault_dir } => nudges.push((account_id, vault_dir)),
        }
    }
    if !full {
        // However many folders: a scoped pass over each costs dirents plus what
        // changed; a full pass lists every folder of every account.
        nudges.sort();
        nudges.dedup();
        p.only = Some(nudges);
    }
    p
}

/// `first`, everything already queued, and, while that is nudges only, what
/// arrives within `window`: a writer that caches message after message nudges
/// once per message, and those become one pass. Stops waiting at the first
/// other signal (its full pass is coming anyway) or a disconnect.
pub fn collect_burst(first: Signal, rx: &Receiver<Signal>, window: Duration) -> Vec<Signal> {
    let deadline = Instant::now() + window;
    let mut queue = vec![first];
    loop {
        let signal = if queue.iter().all(|s| matches!(s, Signal::Nudge { .. })) {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(s) => s,
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.try_recv() {
                Ok(s) => s,
                Err(_) => break,
            }
        };
        queue.push(signal);
    }
    queue
}

/// A scoped pass becomes a full one once the last full pass is `SWEEP_EVERY` old.
pub fn needs_full(since_last_full: Duration, planned_full: bool) -> bool {
    planned_full || since_last_full >= SWEEP_EVERY
}

#[derive(Debug, PartialEq, Eq)]
pub enum BodiesAction {
    None,
    /// No flag stored (fresh index): write it, nothing to strip or re-parse.
    RecordOnly,
    Toggle,
}

/// Compare the stored `bodies_enabled` flag with the configured setting.
pub fn bodies_action(stored: Option<&str>, want: bool) -> BodiesAction {
    match stored {
        None => BodiesAction::RecordOnly,
        Some(s) if s == if want { "1" } else { "0" } => BodiesAction::None,
        Some(_) => BodiesAction::Toggle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn nudge(a: &str, d: &str) -> Signal {
        Signal::Nudge { account_id: a.into(), vault_dir: d.into() }
    }

    fn quiet() -> Plan {
        Plan { reopen: false, rebuild: false, only: None }
    }

    fn folders(pairs: &[(&str, &str)]) -> Option<Vec<(String, String)>> {
        Some(pairs.iter().map(|(a, d)| (a.to_string(), d.to_string())).collect())
    }

    #[test]
    fn nudges_stay_scoped_to_their_folders() {
        assert_eq!(plan(vec![nudge("a", "INBOX"), nudge("a", "INBOX")]), Plan { only: folders(&[("a", "INBOX")]), ..quiet() });
        // Background caching nudges folder after folder: never promoted to a full pass by count.
        assert_eq!(
            plan(vec![nudge("b", "INBOX"), nudge("a", "INBOX"), nudge("b", "INBOX")]),
            Plan { only: folders(&[("a", "INBOX"), ("b", "INBOX")]), ..quiet() }
        );
    }

    #[test]
    fn anything_but_a_nudge_is_a_full_pass() {
        assert_eq!(plan(vec![nudge("a", "INBOX"), Signal::Sweep]), quiet());
        assert_eq!(plan(vec![nudge("a", "INBOX"), Signal::Configure]), quiet());
        // Rebuild and reopen are never swallowed by the nudges queued behind them.
        assert_eq!(plan(vec![Signal::Rebuild, nudge("a", "INBOX")]), Plan { rebuild: true, ..quiet() });
        assert_eq!(plan(vec![Signal::Reopen, nudge("a", "INBOX")]), Plan { reopen: true, ..quiet() });
    }

    #[test]
    fn the_safety_sweep_is_not_starved_by_nudges() {
        let young = SWEEP_EVERY - Duration::from_secs(1);
        assert!(needs_full(SWEEP_EVERY, false), "an overdue scoped pass is promoted");
        assert!(needs_full(SWEEP_EVERY * 3, false));
        assert!(needs_full(Duration::ZERO, true), "a planned full pass stays full");
        assert!(!needs_full(young, false), "a scoped pass inside the window stays scoped");
    }

    #[test]
    fn bodies_setting_is_recorded_toggled_or_left() {
        // A fresh index has no flag: record it, nothing to strip.
        assert_eq!(bodies_action(None, true), BodiesAction::RecordOnly);
        assert_eq!(bodies_action(None, false), BodiesAction::RecordOnly);
        assert_eq!(bodies_action(Some("1"), true), BodiesAction::None);
        assert_eq!(bodies_action(Some("0"), false), BodiesAction::None);
        assert_eq!(bodies_action(Some("1"), false), BodiesAction::Toggle);
        assert_eq!(bodies_action(Some("0"), true), BodiesAction::Toggle);
    }

    #[test]
    fn a_nudge_burst_waits_for_the_nudges_behind_it() {
        let (tx, rx) = channel();
        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            tx.send(nudge("a", "Archive")).unwrap();
            tx // kept alive until joined: a disconnect is not what this tests
        });
        let queue = collect_burst(nudge("a", "INBOX"), &rx, Duration::from_millis(1000));
        let _tx = sender.join().unwrap();
        assert_eq!(queue, vec![nudge("a", "INBOX"), nudge("a", "Archive")]);
    }

    #[test]
    fn a_burst_stops_waiting_once_it_holds_more_than_nudges() {
        let (tx, rx) = channel();
        tx.send(Signal::Configure).unwrap();
        let t = Instant::now();
        let queue = collect_burst(nudge("a", "INBOX"), &rx, Duration::from_secs(10));
        assert!(t.elapsed() < Duration::from_secs(5), "a full pass is coming anyway: {:?}", t.elapsed());
        assert_eq!(queue, vec![nudge("a", "INBOX"), Signal::Configure]);

        let t = Instant::now();
        assert_eq!(collect_burst(Signal::Sweep, &rx, Duration::from_secs(10)), vec![Signal::Sweep]);
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
