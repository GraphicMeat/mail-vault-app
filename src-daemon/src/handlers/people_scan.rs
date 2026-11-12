//! Lock-paged custody scans behind the `people.*` RPCs. Each loop takes the
//! custody lock once per page, so no call is one long scan.
use super::people::blocking_db;
use crate::state::DaemonState;
use mailvault_core::people::{correspondence as corr, review, seen, senders};
use std::sync::Arc;

// The paged loops below take the custody lock once per page. `people.list` and
// `people.review.list` are foreground requests themselves, so their loops never
// wait for a quiet UI (they would wait on their own marker); only the
// background-ish `people.proposals` scan does.

pub(crate) async fn all_totals(state: &Arc<DaemonState>) -> Result<std::collections::HashMap<String, (u64, i64)>, String> {
    let (mut all, mut cursor) = (std::collections::HashMap::new(), String::new());
    loop {
        let cur = cursor.clone();
        let (page, next) = blocking_db(state, move |c| corr::totals_page(c, &cur, 500)).await?;
        all.extend(page);
        let Some(n) = next else { return Ok(all) };
        cursor = n;
    }
}

pub(crate) async fn review_candidates(state: &Arc<DaemonState>, own: Vec<String>, limit: usize) -> Result<Vec<review::Candidate>, String> {
    let (mut pool, mut cursor) = (Vec::new(), String::new());
    loop {
        let (cur, o) = (cursor.clone(), own.clone());
        let (page, next) = blocking_db(state, move |c| review::candidates_page(c, &o, &cur, 2000)).await?;
        pool.extend(page);
        let Some(n) = next else { break };
        cursor = n;
    }
    let ranked = review::rank(pool, limit * 4 + 50);
    // drop bulk senders 25 candidates per lock until `limit` are kept
    let mut kept: Vec<review::Candidate> = Vec::new();
    for chunk in ranked.chunks(25) {
        if kept.len() >= limit {
            break;
        }
        let (chunk, want) = (chunk.to_vec(), limit - kept.len());
        kept.extend(blocking_db(state, move |c| review::finalize(c, chunk, want)).await?);
    }
    Ok(kept)
}

pub(crate) async fn all_proposals(state: &Arc<DaemonState>) -> Result<Vec<mailvault_core::people::dedupe::Proposal>, String> {
    use mailvault_core::people::dedupe;
    let (mut people, mut cursor) = (Vec::new(), String::new());
    loop {
        let cur = cursor.clone();
        let (page, next) = blocking_db(state, move |c| dedupe::keys_page(c, &cur, 200)).await?;
        people.extend(page);
        let Some(n) = next else { break };
        cursor = n;
        crate::search_index::wait_foreground_quiet(&state.search_index).await;
    }
    Ok(dedupe::propose_from(&people))
}

/// The daemon's contacts index for these accounts, in their order. The first
/// call for an account may seed it from the header cache, so it runs off the
/// async workers.
pub(crate) async fn seen_contacts(state: &Arc<DaemonState>, ids: Vec<String>) -> Result<Vec<(String, Vec<seen::Entry>)>, String> {
    let contacts = Arc::clone(&state.contacts);
    tokio::task::spawn_blocking(move || {
        let mut snap = contacts.get_snapshot(&ids);
        ids.into_iter()
            .map(|id| {
                let entries = snap.remove(&id).unwrap_or_default().into_iter();
                let entries = entries.map(|e| seen::Entry { address: e.address, name: e.name, count: e.count, last_seen: e.last_seen }).collect();
                (id, entries)
            })
            .collect()
    })
    .await
    .map_err(|e| format!("task join error: {e}"))
}

/// Every sender in the vault, pooled from lock-paged scans. It is a foreground
/// request itself, so it never waits for a quiet UI (it would wait on its own marker).
// shortcut: re-aggregates on every page request, cache the pool per index epoch if one call passes 1 s on a big vault
pub(crate) async fn all_senders(state: &Arc<DaemonState>, own: Vec<String>) -> Result<Vec<senders::Sender>, String> {
    let (mut pool, mut cursor) = (Vec::new(), String::new());
    loop {
        let (cur, o) = (cursor.clone(), own.clone());
        let (page, next) = blocking_db(state, move |c| senders::page(c, &o, &cur, 2000)).await?;
        pool.extend(page);
        let Some(n) = next else { return Ok(pool) };
        cursor = n;
    }
}
