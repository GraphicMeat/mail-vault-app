//! Standalone mock OAuth2 token endpoint for the e2e harness.
//!
//! Prints `{"port":N}` on stdout, then serves until killed. The harness signs
//! users in through `POST /__mock/sign-in` and points the app's debug build at
//! it (`MAILVAULT_GOOGLE_TOKEN_ENDPOINT`, `MAILVAULT_MS_TOKEN_ENDPOINT`); the
//! standalone mock IMAP server checks tokens against it (`tokenCheckOrigin`).

use mock_imap::oauth::{MockOAuth, TokenAuthority};

fn main() {
    let server = MockOAuth::start(TokenAuthority::new());
    println!("{{\"port\":{}}}", server.port());
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
