//! The engine reaches IMAP through mailvault-core, driven by `net::block_on`.

use mock_imap::state::synthetic_mailbox;
use mock_imap::{MockImap, Scenario};

#[test]
fn connects_to_mock_imap_through_core() {
    // The mock speaks plaintext; core honours this only for loopback peers (see
    // src-core/tests/common/mod.rs).
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
    let count = mailvault_mobile_engine::net::test_login(&server.host(), server.port(), "u@example.test", "pw");
    assert_eq!(count, Ok(3));
}
