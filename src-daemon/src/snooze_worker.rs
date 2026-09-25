//! Background worker for Snooze. Same shape as `scheduled_send_worker.rs`:
//! a catch-up pass over everything already due when the daemon starts (the
//! daemon dying with the app is the normal case, so "already past" is only
//! ever woken, never refused), then a sleep until the next wake time or a
//! poke from `handlers::snooze`.

use mailvault_core::app_db::{self, snooze};
use std::path::Path;

/// Run every due row through `wake` and record what it came to. Returns
/// `(id, outcome, state afterwards)` per row, so the caller can emit and pace
/// itself. `wake` is the real IMAP move in the daemon and a stub in tests.
pub(crate) async fn process_due_with<F, Fut>(app_dir: &Path, now: i64, wake: F) -> Vec<(String, snooze::WakeOutcome, String)>
where
    F: FnMut(snooze::Snooze) -> Fut,
    Fut: std::future::Future<Output = snooze::WakeOutcome>,
{
    let _ = (app_dir, now, wake);
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use snooze::WakeOutcome;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn app_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-snooze-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(dir: &Path, id: &str, wake_at: i64) {
        app_db::with(dir, |c| snooze::insert(c, id, "acct", "INBOX", snooze::SNOOZED_MAILBOX, Some(3), "<m@x>", wake_at)).unwrap();
    }

    fn row(dir: &Path, id: &str) -> snooze::Snooze {
        app_db::with(dir, |c| snooze::get(c, id)).unwrap().unwrap()
    }

    /// The daemon was not running at wake time: the first pass after it
    /// starts must wake what is overdue, and only that.
    #[tokio::test]
    async fn an_overdue_row_is_woken_on_the_first_pass_and_a_future_one_is_left() {
        let dir = app_dir();
        seed(&dir, "overdue", 1_000);
        seed(&dir, "future", 9_000_000);
        let calls = AtomicUsize::new(0);
        let out = process_due_with(&dir, 5_000, |r| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(r.id, "overdue");
            async { WakeOutcome::Woken }
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out, vec![("overdue".to_string(), WakeOutcome::Woken, "woken".to_string())]);
        assert_eq!(row(&dir, "overdue").state, "woken");
        assert_eq!(row(&dir, "future").state, "snoozed");
    }

    #[tokio::test]
    async fn a_message_no_longer_in_snoozed_ends_the_row_without_an_error() {
        let dir = app_dir();
        seed(&dir, "a", 1_000);
        process_due_with(&dir, 5_000, |_| async { WakeOutcome::NotFound }).await;
        let r = row(&dir, "a");
        assert_eq!(r.state, "woken");
        assert_eq!(r.last_error, "");
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_later_not_on_the_same_pass() {
        let dir = app_dir();
        seed(&dir, "a", 1_000);
        process_due_with(&dir, 5_000, |_| async { WakeOutcome::Transient("server hiccup".into()) }).await;
        let r = row(&dir, "a");
        assert_eq!(r.state, "snoozed");
        assert_eq!(r.attempts, 1);
        let again = process_due_with(&dir, 5_000, |_| async { WakeOutcome::Woken }).await;
        assert!(again.is_empty(), "backing off, not due on the same tick");
        let later = process_due_with(&dir, 5_000 + snooze::backoff_ms(1), |_| async { WakeOutcome::Woken }).await;
        assert_eq!(later.len(), 1);
        assert_eq!(row(&dir, "a").state, "woken");
    }

    /// Locked keychain: the worker waits, the row is never marked failed.
    #[tokio::test]
    async fn locked_credentials_leave_the_row_due_and_unburned() {
        let dir = app_dir();
        seed(&dir, "a", 1_000);
        for _ in 0..(snooze::MAX_ATTEMPTS * 2) {
            process_due_with(&dir, 5_000, |_| async { WakeOutcome::Wait("keychain locked".into()) }).await;
        }
        let r = row(&dir, "a");
        assert_eq!(r.state, "snoozed");
        assert_eq!(r.attempts, 0);
    }
}
