//! Standalone mock IMAP server for JS tests.
//!
//! Reads a JSON `Scenario` on stdin, prints `{"port":N}` on stdout, then serves
//! until killed. Same implementation as the in-process Rust harness — one mock,
//! both test tiers.
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
    println!("{{\"port\":{}}}", server.port());

    // Park forever — the parent test process kills us.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
