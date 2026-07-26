//! Shared helpers for the IMAP protocol tests.
//!
//! Included by each test binary separately, so helpers only some of them use
//! would otherwise warn as dead code.
#![allow(dead_code)]

use mailvault_core::imap::{ImapConfig, ImapPool};
use mock_imap::MockImap;
use std::sync::Once;

static PLAINTEXT: Once = Once::new();

/// Build an `ImapConfig` pointed at a running mock, with the client's TLS wrap
/// disabled. The client only honors `MAILVAULT_IMAP_PLAINTEXT` for loopback, and
/// the mock always binds 127.0.0.1.
pub fn config_for(server: &MockImap) -> ImapConfig {
    PLAINTEXT.call_once(|| std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1"));

    serde_json::from_value(serde_json::json!({
        "email": "user@example.com",
        "password": "hunter2",
        "imapHost": server.host(),
        "imapPort": server.port(),
        "imapSecure": true,
    }))
    .expect("build ImapConfig")
}

/// A fresh pool per test — pooling is global state we do not want shared.
pub fn pool() -> ImapPool {
    ImapPool::new()
}

/// Connect + authenticate against a mock, returning a live session.
pub async fn session(server: &MockImap) -> mailvault_core::imap::ImapSession {
    let config = config_for(server);
    let pool = pool();
    mailvault_core::imap::create_imap_session(&config, &pool)
        .await
        .expect("session")
}

/// A readable test message.
pub fn eml(subject: &str, from: &str, body: &str) -> String {
    format!(
        "From: {from}\r\n\
         To: user@example.com\r\n\
         Subject: {subject}\r\n\
         Date: Thu, 01 Jan 2026 12:00:00 +0000\r\n\
         Message-ID: <{}@example.com>\r\n\
         Content-Type: text/plain; charset=UTF-8\r\n\
         \r\n\
         {body}\r\n",
        subject.to_lowercase().replace(' ', "-")
    )
}
