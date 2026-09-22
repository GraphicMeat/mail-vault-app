//! Proof-of-mechanism agent. Not a feature, and not shipped behaviour.
//!
//! Two questions cost a signed build each to answer, and neither can be
//! answered from an unsigned bundle or from outside the sandbox:
//!
//! 1. Does `SMAppService.register()` get past "Operation not permitted" when
//!    the agent's program is itself signed `com.apple.security.app-sandbox`?
//!    (It failed when the program was the unsandboxed daemon: a sandboxed app
//!    may not ask launchd to run a binary that escapes its sandbox.)
//! 2. Can an agent launchd started — which gets its *own* container, not the
//!    app's — still reach the `group.com.mailvault` container? That directory
//!    is where the daemon's socket would have to move for the real thing to
//!    work, so this has to be true before anything is migrated to it.
//!
//! So it writes one line into the group container and exits. The line carries
//! what this process actually sees, because the difference between the app's
//! view and a launchd-started agent's view is the entire problem.
//!
//! Run by `Contents/Library/LaunchAgents/com.mailvault.app.probe.plist`.

const GROUP: &str = "group.com.mailvault";

fn main() {
    let home = dirs::home_dir().unwrap_or_default();
    let dir = mailvault_core::autostart::group_container_dir(&home, GROUP);

    let line = format!(
        "{} pid={} home={} group_dir={} argv={:?} container_id={:?}\n",
        chrono::Local::now().to_rfc3339(),
        std::process::id(),
        home.display(),
        dir.display(),
        std::env::args().collect::<Vec<_>>(),
        std::env::var("APP_SANDBOX_CONTAINER_ID").ok(),
    );

    // stderr first: if the group container is unreachable, this is the only
    // trace, and `log show --predicate 'process == "mailvault-agent-probe"'`
    // still finds it.
    eprint!("mailvault-agent-probe: {line}");

    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("mailvault-agent-probe: create_dir_all {}: {e}", dir.display());
        std::process::exit(2);
    }
    let path = dir.join("agent-probe.log");
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            use std::io::Write;
            if let Err(e) = f.write_all(line.as_bytes()) {
                eprintln!("mailvault-agent-probe: write {}: {e}", path.display());
                std::process::exit(3);
            }
        }
        Err(e) => {
            eprintln!("mailvault-agent-probe: open {}: {e}", path.display());
            std::process::exit(4);
        }
    }
}
