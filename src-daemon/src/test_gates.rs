//! Pause gates for the daemon's tests, defined once.
//!
//! A test that needs a worker to stop at one point arms a gate under a key (the
//! vault's directory, or the directory plus a stage name). The code under test
//! calls [`Gates::pause`] at that point: it takes the gate out of the registry
//! (so it fires once), tells the test it has arrived, and waits to be released.
//! The test holds the other halves: [`Hold`] is the arrival it waits for and the
//! release it sends.

use std::borrow::Borrow;
use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::oneshot;

use crate::credentials::TestTaskDone;

/// The worker's half of a gate on a thread: `.0` says "arrived", `.1` waits
/// for the release.
pub(crate) type Gate = (Sender<()>, Receiver<()>);
/// The test's half: `.0` hears the arrival, `.1` releases.
pub(crate) type Hold = (Receiver<()>, Sender<()>);
/// [`Gate`] for code that awaits its release.
pub(crate) type AsyncGate = (oneshot::Sender<()>, oneshot::Receiver<()>);
/// [`Hold`] of an [`AsyncGate`].
pub(crate) type AsyncHold = (oneshot::Receiver<()>, oneshot::Sender<()>);

/// A gate on a thread that also reports when the guarded task has ended: the
/// pause point hands back a [`TestTaskDone`] to hold until the task is over.
pub(crate) struct DoneGate {
    entered: Sender<()>,
    release: Receiver<()>,
    done: Sender<()>,
}
/// [`DoneGate`] for async code, released through a `oneshot`.
pub(crate) struct AsyncDoneGate {
    entered: Sender<()>,
    release: oneshot::Receiver<()>,
    done: Sender<()>,
}

/// How long a thread waits for its release before it carries on, so a test
/// that forgets to release fails by timeout instead of hanging.
pub(crate) const RELEASE_WAIT: Duration = Duration::from_secs(5);

/// Armed gates (or any one-shot test hook) by key. A `static` registry:
/// `static GATES: Gates<PathBuf> = Gates::new();`.
pub(crate) struct Gates<K, G = Gate>(Mutex<BTreeMap<K, G>>);

impl<K, G> Gates<K, G> {
    pub(crate) const fn new() -> Self {
        Self(Mutex::new(BTreeMap::new()))
    }
}

impl<K: Ord, G> Gates<K, G> {
    fn map(&self) -> MutexGuard<'_, BTreeMap<K, G>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Arms `gate` under `key`; the gate it replaced, if any.
    pub(crate) fn arm(&self, key: K, gate: G) -> Option<G> {
        self.map().insert(key, gate)
    }

    /// Takes the gate armed under `key`: it fires once.
    pub(crate) fn take<Q: Ord + ?Sized>(&self, key: &Q) -> Option<G>
    where
        K: Borrow<Q>,
    {
        self.map().remove(key)
    }
}

impl<K: Ord> Gates<K, Gate> {
    /// Arms a new gate under `key` and returns the test's half.
    pub(crate) fn hold(&self, key: K) -> Hold {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        self.arm(key, (entered_tx, release_rx));
        (entered_rx, release_tx)
    }

    /// The pause point: reports the arrival, then waits for the release for at
    /// most [`RELEASE_WAIT`]. No gate armed under `key`: returns at once.
    pub(crate) fn pause<Q: Ord + ?Sized>(&self, key: &Q)
    where
        K: Borrow<Q>,
    {
        if let Some((entered, release)) = self.take(key) {
            let _ = entered.send(());
            let _ = release.recv_timeout(RELEASE_WAIT);
        }
    }

    /// [`Gates::pause`] without the time limit.
    pub(crate) fn pause_until_released<Q: Ord + ?Sized>(&self, key: &Q)
    where
        K: Borrow<Q>,
    {
        if let Some((entered, release)) = self.take(key) {
            let _ = entered.send(());
            let _ = release.recv();
        }
    }
}

impl<K: Ord> Gates<K, AsyncGate> {
    /// Arms a new gate under `key` and returns the test's half.
    pub(crate) fn hold(&self, key: K) -> AsyncHold {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        self.arm(key, (entered_tx, release_rx));
        (entered_rx, release_tx)
    }

    /// [`Gates::hold`] for a key that must not be armed already (`what` is
    /// the failure message): two held gates on one key is a test bug.
    pub(crate) fn hold_once(&self, key: K, what: &str) -> AsyncHold {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        assert!(self.arm(key, (entered_tx, release_rx)).is_none(), "{what}");
        (entered_rx, release_tx)
    }

    /// The pause point for async code: reports the arrival, then awaits the
    /// release. No gate armed under `key`: returns at once.
    pub(crate) async fn pause<Q: Ord + ?Sized>(&self, key: &Q)
    where
        K: Borrow<Q>,
    {
        if let Some((entered, release)) = self.take(key) {
            let _ = entered.send(());
            let _ = release.await;
        }
    }
}

impl<K: Ord> Gates<K, DoneGate> {
    /// Arms a new gate under `key`; the test gets `(arrival, release, done)`.
    pub(crate) fn hold_done(&self, key: K) -> (Receiver<()>, Sender<()>, Receiver<()>) {
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (done, done_rx) = mpsc::channel();
        self.arm(key, DoneGate { entered, release: release_rx, done });
        (entered_rx, release, done_rx)
    }

    /// The pause point: reports the arrival, waits for the release without a
    /// time limit, and hands back the completion signal to hold.
    pub(crate) fn pause_done<Q: Ord + ?Sized>(&self, key: &Q) -> Option<TestTaskDone>
    where
        K: Borrow<Q>,
    {
        self.take(key).map(|gate| {
            let _ = gate.entered.send(());
            let _ = gate.release.recv();
            TestTaskDone(gate.done)
        })
    }
}

impl<K: Ord> Gates<K, AsyncDoneGate> {
    /// Arms a new gate under `key`; the test gets `(arrival, release, done)`.
    pub(crate) fn hold_done(&self, key: K) -> (Receiver<()>, oneshot::Sender<()>, Receiver<()>) {
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = oneshot::channel();
        let (done, done_rx) = mpsc::channel();
        self.arm(key, AsyncDoneGate { entered, release: release_rx, done });
        (entered_rx, release, done_rx)
    }

    /// [`Gates::pause_done`] for async code.
    pub(crate) async fn pause_done<Q: Ord + ?Sized>(&self, key: &Q) -> Option<TestTaskDone>
    where
        K: Borrow<Q>,
    {
        let gate = self.take(key)?;
        let _ = gate.entered.send(());
        let _ = gate.release.await;
        Some(TestTaskDone(gate.done))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn a_gate_fires_once_and_reports_the_arrival_before_it_waits() {
        static GATES: Gates<PathBuf> = Gates::new();
        let dir = PathBuf::from("vault");
        let (entered, release) = GATES.hold(dir.clone());
        let worker = std::thread::spawn({
            let dir = dir.clone();
            move || {
                GATES.pause(dir.as_path());
                GATES.pause(Path::new("vault"));
            }
        });
        entered.recv_timeout(Duration::from_secs(5)).expect("the worker reached the gate");
        assert!(!worker.is_finished(), "the worker waits for the release");
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(GATES.take(&dir).is_none(), "a fired gate is gone");
    }

    #[test]
    fn no_armed_gate_means_no_wait_and_a_tuple_key_is_a_stage() {
        static GATES: Gates<(PathBuf, &'static str)> = Gates::new();
        let key = |stage| (PathBuf::from("vault"), stage);
        GATES.pause(&key("none"));
        let (entered, release) = GATES.hold(key("a"));
        GATES.pause_until_released(&key("b"));
        std::thread::scope(|s| {
            s.spawn(|| GATES.pause_until_released(&key("a")));
            entered.recv_timeout(Duration::from_secs(5)).expect("stage a reached");
            release.send(()).unwrap();
        });
    }

    #[tokio::test]
    async fn an_async_gate_holds_until_released_and_refuses_a_second_arming() {
        static GATES: Gates<PathBuf, AsyncGate> = Gates::new();
        let dir = PathBuf::from("vault");
        let (entered, release) = GATES.hold_once(dir.clone(), "one gate");
        let task = tokio::spawn({
            let dir = dir.clone();
            async move { GATES.pause(&dir).await }
        });
        entered.await.expect("the task reached the gate");
        assert!(!task.is_finished());
        release.send(()).unwrap();
        task.await.unwrap();
        let _again = GATES.hold_once(dir.clone(), "one gate");
        let second = std::panic::catch_unwind(|| GATES.hold_once(PathBuf::from("vault"), "one gate"));
        assert!(second.is_err(), "arming a held key twice is a test bug");
    }
}
