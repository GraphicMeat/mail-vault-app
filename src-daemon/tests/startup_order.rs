//! What the daemon starts, and in what order relative to the socket.
//!
//! A route may land the moment the socket answers, so every worker, watcher
//! and store a route reads must be started before `server::spawn_on_own_thread`;
//! the storage format resume runs after it. `daemon_main` builds the state,
//! runs `startup::steps()` for `BeforeSocket`, spawns the socket and runs the
//! `AfterSocket` steps. This pins both halves in the source, and that
//! `daemon_main` starts nothing outside the steps; the unit tests in
//! `startup.rs` pin the step names, order and phases.
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

/// What `daemon_main` itself may start, with why it is not a step: the four
/// built into `DaemonState` before a step can run, the socket, the signal
/// task and the shutdown pauses inside it.
const STARTED_INLINE: &[(&str, &str)] = &[
    ("net.spawn_watchdog()", "NetGate's watchdog, part of the state"),
    ("NetLog::start(", "the network activity log, part of the state"),
    ("blitz::spawn_reaper(", "the render pool's reaper, part of the state"),
    ("tokio::spawn(async move {", "the signal handler that runs the shutdown"),
    ("tokio::task::spawn_blocking(", "the shutdown's job pauses, inside the signal handler"),
    ("server::spawn_on_own_thread(", "the socket itself"),
];

/// Every worker, watcher and flush starts as a `startup::steps()` entry, where
/// its phase (before or after the socket) is stated and unit-tested; the
/// order of the steps is pinned in `startup.rs`. Here: `daemon_main` starts
/// nothing else (a line calling `::start(`, `.start(`, `::spawn(` or a
/// `spawn_..`) but the inline ones above.
#[test]
fn daemon_main_starts_no_worker_outside_the_steps() {
    let main = between("src/main.rs", "async fn daemon_main()", "#[cfg(test)]");
    let code: Vec<&str> = main.lines().map(|l| l.split("//").next().unwrap_or("")).collect();
    let starts = |l: &str| l.contains("::start(") || l.contains(".start(") || l.contains("::spawn(") || l.contains("spawn_");
    let stray: Vec<&str> = code
        .iter()
        .filter(|l| starts(l) && !STARTED_INLINE.iter().any(|(needle, _)| l.contains(needle)))
        .map(|l| l.trim())
        .collect();
    assert!(stray.is_empty(), "start it as a startup::steps() entry (or list it in STARTED_INLINE with why):\n{}", stray.join("\n"));
    for (needle, why) in STARTED_INLINE {
        assert!(code.iter().any(|l| l.contains(needle)), "`{needle}` ({why}) is gone from daemon_main: drop its row");
    }
}
