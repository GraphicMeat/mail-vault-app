//! What the daemon starts, and in what order relative to the socket.
//!
//! A route may land the moment the socket answers, so every worker, watcher
//! and store a route reads must be started before `server::spawn_on_own_thread`;
//! the storage format resume runs after it. `daemon_main` builds the state,
//! runs `startup::steps()` for `BeforeSocket`, spawns the socket and runs the
//! `AfterSocket` steps. This pins both halves in the source; the unit test in
//! `startup.rs` pins the step names and phases.
use std::path::Path;

fn source(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)).unwrap()
}

/// The text of `file` from `from` up to `to` (or the end).
fn between(file: &str, from: &str, to: &str) -> String {
    let text = source(file);
    let start = text.find(from).unwrap_or_else(|| panic!("`{from}` not in {file}"));
    let end = text[start..].find(to).map_or(text.len(), |e| start + e);
    text[start..end].to_string()
}

/// Each needle is found, each after the one before it.
fn assert_in_order(text: &str, needles: &[&str]) {
    let mut prev: Option<(usize, &str)> = None;
    for needle in needles {
        let found = text.find(needle).unwrap_or_else(|| panic!("`{needle}` not found"));
        if let Some((at, before)) = prev {
            assert!(found > at, "`{needle}` starts before `{before}`");
        }
        prev = Some((found, needle));
    }
}

#[test]
fn daemon_main_builds_the_state_then_runs_the_steps_around_the_socket() {
    let main = between("src/main.rs", "async fn daemon_main()", "#[cfg(test)]");
    assert_in_order(
        &main,
        &[
            // Built while `DaemonState` is still being put together.
            "net.spawn_watchdog()",
            "credentials::install_events(",
            "mailvault_core::net_activity::subscribe(",
            "blitz::spawn_reaper(",
            "state::DaemonState {",
            "state.idle.set_daemon(&state)",
            "state.sync_engine.set_daemon(&state)",
            "startup::run(startup::Phase::BeforeSocket",
            "tokio::signal::ctrl_c()",
            "server::spawn_on_own_thread(",
            "startup::run(startup::Phase::AfterSocket",
        ],
    );
}

#[test]
fn the_steps_start_everything_in_order() {
    let steps = between("src/startup.rs", "pub(crate) fn steps()", "pub(crate) async fn run(");
    assert_in_order(
        &steps,
        &[
            "refresh_worker::start(",
            "account_lifecycle::start_bootstrap(",
            "open_custody",
            "custody::spawn_legacy_import(",
            "classification_worker::start_classification_worker(",
            "scheduled_send_worker::start(",
            "snooze_worker::start(",
            "follow_up_worker::start(",
            "oauth_tokens::start_persistence(",
            "launch_resync::start(",
            "delete_queue::spawn_worker(",
            "credentials::start_watcher(",
            "handlers::portable::watch_drive(",
            "auto_tag_worker::start(",
            "eviction_worker::start(",
            "handlers::deleted::start(",
            "hoarder_worker::start(",
            "abd_worker::start(",
            "cleanup_worker::start(",
            "backup_worker::start(",
            "search_index::start(",
            "people_index::spawn_backfill(",
            "people_snapshot::spawn(",
            "state.insights.start_cleanup()",
            "contacts_flush(",
            "transfer_stats_flush(",
            "format_migration_job::resume_journaled(",
        ],
    );
}
