//! Who may put a connection into the `SharedConn` slot. Opening runs
//! `quick_check` (seconds) without the lock; a vault switch that starts and
//! ends meanwhile must not find that connection, opened on the old root,
//! installed after it.

use super::{lock, SharedConn};
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};

#[derive(Default)]
pub struct SwitchGuard {
    switching: AtomicBool,
    generation: AtomicU64,
}

impl SwitchGuard {
    /// A vault operation starts: every open begun before this is stale, and the
    /// current connection goes (drop = checkpoint).
    pub fn begin_switch(&self, db: &SharedConn) {
        let mut slot = lock(db);
        self.switching.store(true, SeqCst);
        self.generation.fetch_add(1, SeqCst);
        *slot = None;
    }

    pub fn end_switch(&self) {
        self.switching.store(false, SeqCst);
    }

    /// Capture before opening; pass to `install_if_current`.
    pub fn current(&self) -> u64 {
        self.generation.load(SeqCst)
    }

    pub fn is_switching(&self) -> bool {
        self.switching.load(SeqCst)
    }
}

/// Install `conn`, opened after `gen` was captured, only if no switch is in
/// progress and none started since. Checked under the db lock, which
/// `begin_switch` also takes, so the two cannot interleave. Otherwise `conn`
/// is dropped and the caller leaves root and phase alone.
pub fn install_if_current(db: &SharedConn, guard: &SwitchGuard, gen: u64, conn: Connection) -> bool {
    let mut slot = lock(db);
    if guard.is_switching() || guard.current() != gen {
        drop(slot); // release first: dropping `conn` checkpoints
        return false;
    }
    *slot = Some(conn);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn an_open_with_no_switch_is_installed() {
        let (db, guard): (SharedConn, SwitchGuard) = (Mutex::new(None), SwitchGuard::default());
        let gen = guard.current();
        assert!(install_if_current(&db, &guard, gen, conn()));
        assert!(lock(&db).is_some());
    }

    #[test]
    fn an_open_that_a_switch_started_behind_is_dropped() {
        let (db, guard): (SharedConn, SwitchGuard) = (Mutex::new(None), SwitchGuard::default());
        let gen = guard.current();
        guard.begin_switch(&db);
        assert!(!install_if_current(&db, &guard, gen, conn()));
        assert!(lock(&db).is_none(), "the vault is moving: no connection");
    }

    #[test]
    fn an_open_begun_after_the_switch_ended_is_installed() {
        let (db, guard): (SharedConn, SwitchGuard) = (Mutex::new(None), SwitchGuard::default());
        guard.begin_switch(&db);
        guard.end_switch();
        let gen = guard.current();
        assert!(install_if_current(&db, &guard, gen, conn()));
        assert!(lock(&db).is_some());
    }

    #[test]
    fn an_open_that_a_whole_switch_happened_behind_is_dropped() {
        let (db, guard): (SharedConn, SwitchGuard) = (Mutex::new(None), SwitchGuard::default());
        let gen = guard.current();
        guard.begin_switch(&db);
        guard.end_switch();
        assert!(!install_if_current(&db, &guard, gen, conn()), "opened on the old root");
        assert!(lock(&db).is_none());
    }

    #[test]
    fn begin_switch_drops_the_open_connection() {
        let (db, guard): (SharedConn, SwitchGuard) = (Mutex::new(Some(conn())), SwitchGuard::default());
        guard.begin_switch(&db);
        assert!(lock(&db).is_none());
        assert!(guard.is_switching());
        guard.end_switch();
        assert!(!guard.is_switching());
    }
}
