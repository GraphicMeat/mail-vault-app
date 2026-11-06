//! The daemon polls IMAP session futures on tokio workers with the default 2 MiB stack.
//! Routing TLS through `imap::tls::connect` grew the session future from 4448 to 5152
//! bytes in a debug build, and the daemon overflowed its worker stack while opening a
//! session (SIGABRT from the stack guard; the app's reader never got a body). The
//! handshake future is boxed so the session future stays at its pre-seam size.
use mailvault_core::imap::{create_imap_session, ImapConfig, ImapPool};

/// Debug-build size of `create_imap_session`'s future on macOS before the TLS seam.
const PRE_SEAM_BYTES: usize = 4448;

#[test]
fn session_future_did_not_grow_past_the_pre_seam_size() {
    let config: ImapConfig = serde_json::from_value(serde_json::json!({
        "email": "user@example.com", "password": "x",
        "imapHost": "127.0.0.1", "imapPort": 1, "imapSecure": true,
    }))
    .unwrap();
    let pool = ImapPool::new();
    let size = std::mem::size_of_val(&create_imap_session(&config, &pool));
    if cfg!(all(target_os = "macos", debug_assertions)) {
        assert!(size <= PRE_SEAM_BYTES, "create_imap_session future is {size} bytes, over {PRE_SEAM_BYTES}");
    }
}
