//! What the daemon starts once `DaemonState` exists, in order.
//!
//! `daemon_main` runs the `BeforeSocket` steps, installs the shutdown handler,
//! spawns the socket server and then runs the `AfterSocket` steps. A route may
//! land the moment the socket answers, so anything a route reads (custody,
//! the classification queue, the search index worker's signal sender, the
//! Insights sweeper) starts before it. A step that fails is logged by its name
//! and the next one still runs.
use crate::state::DaemonState;
use crate::{
    abd_worker, account_lifecycle, auto_tag_worker, backup_worker, classification_worker,
    cleanup_worker, credentials, custody, delete_queue, eviction_worker, follow_up_worker,
    format_migration_job, hoarder_worker, launch_resync, oauth_tokens, people_index,
    people_snapshot, refresh_worker, scheduled_send_worker, search_index, snooze_worker,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tracing::{error, info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    BeforeSocket,
    AfterSocket,
}

type Awaited = Pin<Box<dyn Future<Output = Result<(), String>>>>;

#[derive(Clone, Copy)]
enum Run {
    /// Starts its worker and returns.
    Now(fn(&Arc<DaemonState>) -> Result<(), String>),
    /// Finishes before the next step starts.
    Awaited(fn(Arc<DaemonState>) -> Awaited),
}

#[derive(Clone, Copy)]
pub(crate) struct Step {
    pub(crate) name: &'static str,
    pub(crate) phase: Phase,
    run: Run,
}

fn now(name: &'static str, phase: Phase, run: fn(&Arc<DaemonState>) -> Result<(), String>) -> Step {
    Step { name, phase, run: Run::Now(run) }
}

/// Every step, in the order it runs.
pub(crate) fn steps() -> Vec<Step> {
    use Phase::*;
    vec![
        now("refresh_worker", BeforeSocket, |state| { refresh_worker::start(state); Ok(()) }),
        // One owned authoritative seed. A failed read leaves the gate Unready;
        // lifecycle-aware writers may request a finite retry later.
        now("account_bootstrap", BeforeSocket, |state| { account_lifecycle::start_bootstrap(Arc::clone(state)); Ok(()) }),
        // Custody, before the socket exists (Task 2.9b Step 1): a route that
        // reads an entry must never be served by a store that is not open yet.
        Step { name: "custody_open", phase: BeforeSocket, run: Run::Awaited(open_custody) },
        // The one-time legacy import, off the startup path (see `open_custody`).
        now("custody_legacy_import", BeforeSocket, |state| { custody::spawn_legacy_import(Arc::clone(state)); Ok(()) }),
        now("classification_worker", BeforeSocket, |state| { classification_worker::start_classification_worker(Arc::clone(state)); Ok(()) }),
        // Scheduled Send's worker: a catch-up pass over anything already due
        // (the normal case: the daemon dies with the app in on-demand mode),
        // then sleeps until the next fire_at or a wake from handlers::scheduled.
        now("scheduled_send_worker", BeforeSocket, |state| { scheduled_send_worker::start(Arc::clone(state)); Ok(()) }),
        // Snooze's and follow-up reminders' workers: same catch-up-then-sleep shape.
        now("snooze_worker", BeforeSocket, |state| { snooze_worker::start(Arc::clone(state)); Ok(()) }),
        now("follow_up_worker", BeforeSocket, |state| { follow_up_worker::start(Arc::clone(state)); Ok(()) }),
        // Keep refreshed OAuth token pairs through quiet, guarded daemon writes.
        now("oauth_token_persistence", BeforeSocket, |state| {
            oauth_tokens::start_persistence(Arc::clone(state))
                .map(drop)
                .ok_or_else(|| "already running".to_string())
        }),
        // Every cached mailbox is synced once, so no row keeps a pre-update cache shape.
        now("launch_resync", BeforeSocket, |state| { launch_resync::start(Arc::clone(state)); Ok(()) }),
        // The delete queue's replay: sends what the journal still owes, 20 s
        // after launch, when the link returns, every 5 min and on
        // `delete_queue.run`; background lane, quiet credentials.
        now("delete_queue_worker", BeforeSocket, |state| { delete_queue::spawn_worker(state); Ok(()) }),
        // Watches keychain access so a locked keychain is noticed without
        // waiting for something to ask for credentials; an unlock wakes the
        // queued sends and the snoozes it held back.
        now("credentials_watcher", BeforeSocket, |state| {
            let state = Arc::clone(state);
            credentials::start_watcher(move || {
                state.scheduled_send.wake();
                state.snooze.wake();
                state.follow_up.wake();
                state.tokens.wake_persistence();
            });
            Ok(())
        }),
        // A portable copy watches the drive it runs from.
        now("portable_drive_watch", BeforeSocket, |state| { crate::handlers::portable::watch_drive(Arc::clone(state)); Ok(()) }),
        // Auto Tags' standing worker: sweeps enabled rules over newly-cached
        // headers on every wake from a sync/IDLE arrival (`idle`'s
        // `set_auto_tag_notify` and `handlers::sync::handle_sync_now`), never
        // polls the vault on its own.
        now("auto_tag_worker", BeforeSocket, |state| { auto_tag_worker::start(Arc::clone(state)); Ok(()) }),
        // Download modes' eviction worker (Track H): deletes working-cache
        // copies a mode no longer keeps, only with fresh proof the server
        // still has each message. First pass after launch settles, then daily,
        // and at once on `storage.fetch_mode_changed`.
        now("eviction_worker", BeforeSocket, |state| { eviction_worker::start(Arc::clone(state)); Ok(()) }),
        // The deleted-mail bin's purge: hourly, past the Settings retention.
        now("deleted_purge", BeforeSocket, |state| { crate::handlers::deleted::start(Arc::clone(state)); Ok(()) }),
        // Hoarder (Track H4, Premium): downloads every folder's full history
        // in the background for Hoarder accounts with `fetchModePremium`.
        // Paced, one message at a time on the background lane.
        now("hoarder_worker", BeforeSocket, |state| { hoarder_worker::start(Arc::clone(state)); Ok(()) }),
        // Archive & delete jobs (Premium): one dedicated OS thread at
        // background priority, its own runtime; resumes whatever the last
        // daemon left unfinished.
        now("abd_worker", BeforeSocket, |state| { abd_worker::start(Arc::clone(state)); Ok(()) }),
        // Auto-cleanup rules (Premium): the daily run and `cleanup.run_now`,
        // on their own background thread, through the abd engine.
        now("cleanup_worker", BeforeSocket, |state| { cleanup_worker::start(Arc::clone(state)); Ok(()) }),
        now("backup_worker", BeforeSocket, |state| { backup_worker::start(Arc::clone(state)); Ok(()) }),
        // Its own OS thread; it opens nothing until the app configures it.
        now("search_index_worker", BeforeSocket, |state| { search_index::start(Arc::clone(&state.search_index)); Ok(()) }),
        // message_addr backfill for vaults that predate it: background QoS, yields to the UI.
        now("people_backfill", BeforeSocket, |state| { people_index::spawn_backfill(Arc::clone(state)); Ok(()) }),
        // contacts.vcf safety copy: restores into a vault with no people, then
        // rewrites 30 s after the last change. Custody stays the truth.
        now("people_snapshot", BeforeSocket, |state| { people_snapshot::spawn(Arc::clone(state)); Ok(()) }),
        // Insights' 300s snapshot expiry sweeper (Task 3.6).
        now("insights_sweeper", BeforeSocket, |state| { state.insights.start_cleanup(); Ok(()) }),
        now("contacts_flush", BeforeSocket, |state| { contacts_flush(state); Ok(()) }),
        now("transfer_stats_flush", BeforeSocket, |state| { transfer_stats_flush(state); Ok(()) }),
        // A storage format conversion a quit or a crash cut off carries on,
        // now that the socket answers.
        now("format_migration_resume", AfterSocket, |state| {
            let state = Arc::clone(state);
            tokio::task::spawn_blocking(move || format_migration_job::resume_journaled(&state));
            Ok(())
        }),
    ]
}

/// Run the steps of one phase, in order.
pub(crate) async fn run(phase: Phase, state: &Arc<DaemonState>) {
    for step in steps().into_iter().filter(|step| step.phase == phase) {
        let result = match step.run {
            Run::Now(start) => start(state),
            Run::Awaited(start) => start(Arc::clone(state)).await,
        };
        if let Err(e) = result {
            warn!("startup step {}: {e}", step.name);
        }
    }
}

/// Only the OPEN is awaited: schema migration, a few milliseconds.
///
/// The legacy JSON import is not (2026-09-20): it used to run inside
/// `open_into`, and on a vault whose header sidecars are still on disk it took
/// 416 s, during which the socket did not exist at all: the app showed an
/// endless mail loader and "Helper Not Running" while the daemon process was
/// plainly there. It runs on its own thread once the socket is up, taking the
/// custody lock one mailbox at a time. A mailbox not imported yet reads as "no
/// cached headers", never as wrong headers: the import only ever INSERTs rows
/// the store does not have.
fn open_custody(state: Arc<DaemonState>) -> Awaited {
    Box::pin(async move {
        let custody_state = Arc::clone(&state);
        let started = std::time::Instant::now();
        let outcome = tokio::task::spawn_blocking(move || custody::open_into(&custody_state)).await;
        let took = started.elapsed();
        match outcome {
            Ok(Ok(())) => {
                if took > std::time::Duration::from_secs(2) {
                    warn!("custody store: open took {:?} — the app only waits 3s for the daemon socket", took);
                } else {
                    info!("custody store: opened in {:?}", took);
                }
            }
            // `open_into` already logged the reason; this line is only about
            // timing, so it must not repeat "opened in" over a failure.
            Ok(Err(e)) => warn!("custody store: failed to open in {:?}: {e}", took),
            // A panic here would otherwise leave `custody.error` at `None`
            // (task-2.11 carry-in M3): `VaultAlertBanner` renders nothing for
            // a `None` error while every custody route still answers `custody
            // store unavailable: closed`. Record it so the banner has
            // something to show.
            Err(join_err) => {
                let msg = format!("custody store: startup open panicked: {join_err}");
                error!("{msg}");
                *state.custody.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
            }
        }
        Ok(())
    })
}

/// Debounced flush of the contacts index to disk (every 30s). Gated like
/// every other vault write (final fix wave I-1): ungated, dirty entries
/// accumulated before a `vault_close` used to land in the OLD root mid
/// vault-move copy, and `contacts_index` was never in `VAULT_DIRS`, so the
/// leftover was neither carried by the move nor cleaned up.
fn contacts_flush(state: &Arc<DaemonState>) {
    let state = Arc::clone(state);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let state = Arc::clone(&state);
            // spawn_blocking: `flush_dirty` does disk I/O and must never
            // run on a tokio worker (global constraint).
            let _ = tokio::task::spawn_blocking(move || crate::flush_contacts_if_open(&state)).await;
        }
    });
}

/// Per-account transfer counters → `<app_data_dir>/transfer_stats/*.daemon.json`.
/// The app writes the `*.app.json` half; neither process locks the other's.
fn transfer_stats_flush(state: &Arc<DaemonState>) {
    let app_dir = state.app_dir.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            mailvault_core::transfer_stats::global().flush(&app_dir, "daemon");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The order `daemon_main` started these in before they became a list
    /// (`tests/startup_order.rs` pinned it on the old code).
    #[test]
    fn the_steps_keep_their_order_and_phase() {
        let got: Vec<(&str, Phase)> = steps().iter().map(|s| (s.name, s.phase)).collect();
        use Phase::{AfterSocket as A, BeforeSocket as B};
        assert_eq!(
            got,
            vec![
                ("refresh_worker", B),
                ("account_bootstrap", B),
                ("custody_open", B),
                ("custody_legacy_import", B),
                ("classification_worker", B),
                ("scheduled_send_worker", B),
                ("snooze_worker", B),
                ("follow_up_worker", B),
                ("oauth_token_persistence", B),
                ("launch_resync", B),
                ("delete_queue_worker", B),
                ("credentials_watcher", B),
                ("portable_drive_watch", B),
                ("auto_tag_worker", B),
                ("eviction_worker", B),
                ("deleted_purge", B),
                ("hoarder_worker", B),
                ("abd_worker", B),
                ("cleanup_worker", B),
                ("backup_worker", B),
                ("search_index_worker", B),
                ("people_backfill", B),
                ("people_snapshot", B),
                ("insights_sweeper", B),
                ("contacts_flush", B),
                ("transfer_stats_flush", B),
                ("format_migration_resume", A),
            ]
        );
    }

    /// Only the custody open is awaited; every other step starts and returns.
    #[test]
    fn only_the_custody_open_is_awaited() {
        let awaited: Vec<&str> = steps()
            .iter()
            .filter(|s| matches!(s.run, Run::Awaited(_)))
            .map(|s| s.name)
            .collect();
        assert_eq!(awaited, vec!["custody_open"]);
    }
}
