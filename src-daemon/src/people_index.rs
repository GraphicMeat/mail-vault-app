//! Backfills `message_addr` for vaults that existed before it did. Runs on its
//! own background-QoS thread, one mailbox chunk (at most 500 rows) at a time,
//! and waits for a quiet UI before each chunk.
use crate::server::DaemonState;
use mailvault_core::people::message_addr::{backfill_chunk, backfill_done};
use std::sync::Arc;
use std::time::Duration;

const CHUNK: usize = 500;
const RETRY: Duration = Duration::from_secs(30);

pub(crate) fn run_until_done(state: &DaemonState, mut yield_fn: impl FnMut(), mut sleep_fn: impl FnMut(Duration)) -> u64 {
    let mut total = 0u64;
    loop {
        yield_fn();
        match crate::custody::with_conn(state, |c| backfill_chunk(c, CHUNK)) {
            Ok(p) => {
                total += p.indexed;
                state.events.emit("people-index-progress", serde_json::json!({"indexed": total, "done": p.done}));
                if p.done {
                    return total;
                }
            }
            Err(e) => {
                tracing::warn!("[people_index] backfill step failed: {e}");
                sleep_fn(RETRY);
            }
        }
    }
}

pub fn spawn_backfill(state: Arc<DaemonState>) {
    if crate::custody::with_conn(&state, |c| Ok(backfill_done(c))).unwrap_or(false) {
        return;
    }
    let _ = std::thread::Builder::new().name("people-index".into()).spawn(move || {
        crate::mbox_upload_job::background_qos();
        let search = Arc::clone(&state.search_index);
        run_until_done(&state, || crate::search_index::yield_to_foreground(&search), std::thread::sleep);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_to_completion_in_bounded_units_and_yields_between_them() {
        let d = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(d.path().to_path_buf(), d.path().to_path_buf(), true);
        crate::custody::with_conn(&s, |c| {
            let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
            for uid in 1..=1100u32 {
                tx.execute("INSERT INTO header_cache(account_id,mailbox_path,uid,sort_ms,updated_ms,header_json) VALUES ('a','INBOX',?1,?1,0,'{\"uid\":1,\"from\":{\"address\":\"x@y.io\"}}')", [uid]).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .unwrap();
        let mut yields = 0;
        let n = run_until_done(&s, || yields += 1, |_| {});
        assert_eq!(n, 1100);
        assert!(yields >= 3, "yielded to the UI between chunks, got {yields}");
        assert!(crate::custody::with_conn(&s, |c| Ok(backfill_done(c))).unwrap());
    }
}
