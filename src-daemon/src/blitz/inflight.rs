//! Fetches the daemon is still running for each doc. `render.image` waits for
//! a doc's images before painting it, as the export frame waits for
//! `settleDocument` today; bounded, like SETTLE_TIMEOUT_MS (5 s).
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Default)]
pub struct InFlight {
    counts: Mutex<HashMap<u64, usize>>,
    changed: Notify,
}

impl InFlight {
    pub fn begin(&self, doc: u64) {
        *self.counts.lock().unwrap().entry(doc).or_default() += 1;
    }

    pub fn end(&self, doc: u64) {
        let mut m = self.counts.lock().unwrap();
        if let Some(n) = m.get_mut(&doc) {
            *n -= 1;
            if *n == 0 {
                m.remove(&doc);
            }
        }
        drop(m);
        self.changed.notify_waiters();
    }

    fn busy(&self, doc: u64) -> bool {
        self.counts.lock().unwrap().contains_key(&doc)
    }

    /// True when the doc had no fetch left within `cap`.
    pub async fn settled(&self, doc: u64, cap: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + cap;
        loop {
            // Created before the check, so an `end` between the check and the
            // await still wakes it.
            let wait = self.changed.notified();
            if !self.busy(doc) {
                return true;
            }
            if tokio::time::timeout_at(deadline, wait).await.is_err() {
                return !self.busy(doc);
            }
        }
    }
}

/// Ends one fetch however the fetch task exits.
pub struct FetchGuard(pub std::sync::Arc<InFlight>, pub u64);
impl Drop for FetchGuard {
    fn drop(&mut self) {
        self.0.end(self.1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn settled_at_once_with_nothing_in_flight() {
        assert!(InFlight::default().settled(1, Duration::from_millis(10)).await);
    }

    #[tokio::test]
    async fn waits_for_the_last_fetch_of_that_doc_only() {
        let f = Arc::new(InFlight::default());
        f.begin(1);
        f.begin(1);
        f.begin(2);
        let g = f.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            g.end(1);
            tokio::time::sleep(Duration::from_millis(20)).await;
            drop(FetchGuard(g.clone(), 1));
        });
        let t0 = std::time::Instant::now();
        assert!(f.settled(1, Duration::from_secs(2)).await);
        assert!(t0.elapsed() < Duration::from_secs(1), "doc 2's fetch did not hold doc 1: {:?}", t0.elapsed());
        assert!(!f.settled(2, Duration::from_millis(30)).await, "doc 2 still fetching");
    }

    #[tokio::test]
    async fn gives_up_at_the_cap() {
        let f = InFlight::default();
        f.begin(5);
        let t = std::time::Instant::now();
        assert!(!f.settled(5, Duration::from_millis(60)).await);
        assert!(t.elapsed() >= Duration::from_millis(55));
    }
}
