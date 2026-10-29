//! Standalone mock IMAP server for JS tests.
//!
//! Reads a JSON `Scenario` on stdin, prints `{"port":N,"smtpPort":M}` on stdout,
//! then serves until killed. Same implementation as the in-process Rust harness
//! — one mock, both test tiers. The two ports are separate listeners.
//!
//! ```sh
//! echo '{"state":{"mailboxes":[...]},"faults":[]}' | mock-imap-server
//! ```

use mock_imap::{MockImap, Scenario};
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("read scenario from stdin");

    let scenario: Scenario = if input.trim().is_empty() {
        Scenario::new()
    } else {
        serde_json::from_str(&input).expect("parse scenario JSON")
    };

    let server = MockImap::start(scenario);
    println!("{{\"port\":{},\"smtpPort\":{}}}", server.port(), server.smtp_port());

    // Park forever — the parent test process kills us. With MOCK_IMAP_LOG_COMMANDS set, every
    // IMAP command line received is also written to stderr as `[cmd] <line>`, so a spec can
    // count what actually reached the server.
    if std::env::var_os("MOCK_IMAP_LOG_COMMANDS").is_some() {
        let mut seen = 0;
        loop {
            let all = server.commands();
            for line in all.iter().skip(seen) {
                eprintln!("[cmd] {line}");
            }
            seen = all.len();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
