//! Standalone mock JMAP server for e2e tests.
//!
//! Reads a JSON `Scenario` on stdin (to EOF), prints `{"port":N,"downloadPort":M}`
//! on stdout, then serves until killed. Same contract as `mock-imap-server`, and the
//! same implementation as the in-process Rust harness. A test drives it over HTTP:
//! the JMAP API itself, plus the no-auth control routes `GET /_mock/submitted`,
//! `GET /_mock/requests` and `POST /_mock/deliver/{accountId}/{mailboxId}`.
//!
//! ```sh
//! echo '{"accounts":[{"username":"a@x.test","password":"pw","mailboxes":[{"id":"mb-inbox","name":"Inbox","role":"inbox"}]}]}' | mock-jmap-server
//! ```

use mock_jmap::{MockJmap, Scenario};
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("read scenario from stdin");
    let scenario: Scenario = if input.trim().is_empty() {
        Scenario::default()
    } else {
        serde_json::from_str(&input).expect("parse scenario JSON")
    };
    let server = MockJmap::start(scenario);
    println!("{{\"port\":{},\"downloadPort\":{}}}", server.port(), server.download_port());
    // Park forever: the parent test process kills us.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
