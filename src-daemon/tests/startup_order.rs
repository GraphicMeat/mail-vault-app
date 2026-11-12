//! What the daemon starts, and in what order relative to the socket.
//!
//! A route may land the moment the socket answers, so every worker, watcher
//! and store a route reads must be started before `server::spawn_on_own_thread`;
//! the storage format resume runs after it. This pins the order in the source.
use std::path::Path;

fn source(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)).unwrap()
}

/// The text of `daemon_main`, up to the test module.
fn daemon_main() -> String {
    let main = source("src/main.rs");
    let start = main.find("async fn daemon_main()").expect("daemon_main");
    let end = main[start..].find("#[cfg(test)]").map_or(main.len(), |e| start + e);
    main[start..end].to_string()
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

/// Built while `DaemonState` is still being put together.
const BEFORE_STATE: &[&str] = &[
    "net.spawn_watchdog()",
    "credentials::install_events(",
    "mailvault_core::net_activity::subscribe(",
    "blitz::spawn_reaper(",
    "state::DaemonState {",
];

/// Once the state exists, before the socket.
const BEFORE_SOCKET: &[&str] = &[
    "state.idle.set_daemon(&state)",
    "state.sync_engine.set_daemon(&state)",
    "refresh_worker::start(",
    "account_lifecycle::start_bootstrap(",
    "custody::open_into(",
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
    "flush_contacts_if_open(&state)",
    "transfer_stats::global().flush(&app_dir",
    "tokio::signal::ctrl_c()",
];

const AFTER_SOCKET: &[&str] = &["format_migration_job::resume_journaled("];

#[test]
fn the_daemon_starts_everything_in_order_around_the_socket() {
    let mut needles: Vec<&str> = Vec::new();
    needles.extend(BEFORE_STATE);
    needles.extend(BEFORE_SOCKET);
    needles.push("server::spawn_on_own_thread(");
    needles.extend(AFTER_SOCKET);
    assert_in_order(&daemon_main(), &needles);
}
