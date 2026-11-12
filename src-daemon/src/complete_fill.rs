//! `sync.now { complete: true }`: after the ordinary sync of one (account,
//! mailbox) the daemon makes the cache hold the WHOLE folder, for every
//! provider. The app used to page the provider itself, 200 rows at a time,
//! and hold every row in memory; that is heavy work and lives here.
//!
//! - IMAP: `backfill_mailbox` (UID SEARCH, then header chunks).
//! - JMAP: `sync_jmap::complete_headers_with_stamp`, the walk the refresh
//!   worker already runs for `Extent::Complete`, here with the prune on.
//! - Graph: the ordinary sync of a Graph account is one page of the newest
//!   mail (`Extent::RefreshPage`); it settles the ticket. The fill is then
//!   `refresh_worker::graph_unit` with `Extent::Complete` and the prune on.
//!   `sync.now` for a Graph account never reached `run_ticket`'s IMAP pool
//!   with `complete`; the automatic refresh keeps its RefreshPage rule.
//!
//! The flag the app polls (`sync.status` `backfilling`) is raised by
//! `SyncEngine::begin_fill` before `sync.now` returns and dropped with the
//! `FillGuard` the spawned task owns, so every exit clears it and there is no
//! window where a fill that is about to run reads as idle.
//!
//! Prune (Graph and JMAP): after a walk that ran to the end, when the listed
//! count is the provider's own folder total, the folder is exactly the listed
//! set, so rows that were cached BEFORE the walk and are not listed are gone
//! from the provider and leave the cache. A mismatch prunes nothing. A uid the
//! op journal still owes a move or delete is neither written by the walk nor
//! pruned.

use crate::refresh_worker::{self, Extent};
use crate::state::DaemonState;
use crate::sync_engine::{FillGuard, SyncAccount, SyncResult};
use crate::sync_observation;
use std::sync::Arc;
use tracing::{info, warn};

/// IMAP and JMAP: runs after the ordinary sync answered its ticket, on the
/// folder that sync actually served (`result.mailbox`, which resolves a
/// generic name such as "Sent" to the provider's own path).
pub(crate) async fn fill(state: &Arc<DaemonState>, account: &SyncAccount, result: &SyncResult) {
    let outcome = if account.imap_config.uses_jmap() {
        match state.account_lifecycle.capture(&account.id) {
            Ok(stamp) => crate::sync_jmap::complete_headers_with_stamp(state, account,
                &result.mailbox, &stamp, result.total_emails, true).await,
            Err(_) => Err("errors.keychainBusy".to_owned()),
        }
    } else {
        // An explicit request: a give-up recorded for the automatic backfill
        // must not turn the user's own "load everything" into a no-op.
        state.sync_engine.forget_backfill_gave_up(&account.id, &result.mailbox).await;
        state.sync_engine.backfill_mailbox(account, &result.mailbox).await;
        Ok(())
    };
    match outcome {
        Ok(()) => info!("[fill] {} ({}) filled", account.email, result.mailbox),
        Err(error) => warn!("[fill] {} ({}) not filled: {error}", account.email, result.mailbox),
    }
}

/// A Graph account: the newest page settles `ticket`; with `complete`, the
/// whole folder follows. `guard` is dropped when the task ends.
pub(crate) async fn graph(state: Arc<DaemonState>, account: SyncAccount, mailbox: String,
    ticket: u64, complete: bool, guard: Option<FillGuard>) {
    let engine = &state.sync_engine;
    let failed = |error: String| SyncResult {
        account_id: account.id.clone(), mailbox: mailbox.clone(),
        new_emails: 0, arrivals: 0, updated_flags: 0, total_emails: 0,
        success: false, error: Some(error), offline: false, error_code: None,
        arrival_uids: Vec::new(), announced: false,
    };
    let run_fill = complete && guard.as_ref().is_none_or(|guard| guard.owner());
    let target = match graph_target(&state, &account.id).await {
        Ok(target) => target,
        Err(error) => {
            engine.settle_external_ticket(ticket, failed(error)).await;
            return;
        }
    };
    let (origin, config, _operation) = target;
    let page = graph_run(&state, &origin, &config, &mailbox, Extent::RefreshPage, false).await;
    let ok = page.is_ok();
    let settled = match page {
        Ok(run) => SyncResult {
            account_id: account.id.clone(), mailbox: mailbox.clone(),
            new_emails: run.added, arrivals: 0, updated_flags: 0,
            total_emails: u32::try_from(run.provider_total).unwrap_or(0),
            success: true, error: None, offline: false, error_code: None,
            arrival_uids: Vec::new(), announced: false,
        },
        Err(error) => failed(error),
    };
    engine.settle_external_ticket(ticket, settled).await;
    if ok && run_fill {
        match graph_run(&state, &origin, &config, &mailbox, Extent::Complete, true).await {
            Ok(run) => info!("[fill] {} ({mailbox}) filled: {} added", account.email, run.added),
            Err(error) => warn!("[fill] {} ({mailbox}) not filled: {error}", account.email),
        }
    }
    drop(guard);
}

/// What `run_unit` establishes before a Graph unit: the authoritative origin,
/// the stored config with a fresh token (its hash must be the origin's) and an
/// operation permit that keeps the account alive for the walk.
async fn graph_target(state: &Arc<DaemonState>, id: &str) -> Result<(sync_observation::Origin,
    crate::imap::ImapConfig, crate::account_lifecycle::OperationPermit), String> {
    let stamp = state.account_lifecycle.capture(id).map_err(|_| "errors.keychainBusy".to_owned())?;
    let origin = sync_observation::origin(state, stamp).await?;
    if !origin.graph { return Err("errors.bulkIdentityChanged".into()); }
    let config = crate::oauth_tokens::resolve(state, id, crate::oauth_tokens::Read::Guarded).await
        .map_err(|_| "errors.syncCredentialsMissing".to_owned())?;
    if mailvault_core::bulk_worker::origin_hash(&config) != origin.hash {
        return Err("errors.bulkIdentityChanged".into());
    }
    let permit = state.account_lifecycle.try_operation(std::slice::from_ref(&origin.original))
        .map_err(|_| "errors.keychainBusy".to_owned())?;
    Ok((origin, config, permit))
}

async fn graph_run(state: &Arc<DaemonState>, origin: &sync_observation::Origin,
    config: &crate::imap::ImapConfig, mailbox: &str, extent: Extent, fill: bool)
    -> Result<refresh_worker::GraphRun, String> {
    let id = origin.original.id();
    state.sync_observation.invalidate_probe(id, Some(mailbox));
    state.sync_observation.invalidate_folder(id);
    let evidence = state.sync_observation.issue_ticket(origin, mailbox);
    refresh_worker::graph_unit(state, origin, config, mailbox, extent, fill, &evidence).await
}
