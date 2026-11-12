//! The provider-origin fingerprint a stored job or header identity carries.

/// Fingerprint only the provider origin. Refreshing secrets keeps this stable;
/// changing the address, endpoint, transport or JMAP login invalidates a job.
pub fn origin_hash(config: &crate::imap::ImapConfig) -> String {
    use sha2::{Digest, Sha256};
    let origin = serde_json::json!([
        config.email,
        config.host.to_ascii_lowercase(),
        config.effective_port(),
        config.secure,
        config.security,
        config.oauth2_transport,
        config
            .jmap_session_url
            .as_deref()
            .and_then(|value| url::Url::parse(value).ok())
            .map(|mut value| {
                let _ = value.set_username("");
                let _ = value.set_password(None);
                value.set_fragment(None);
                value.to_string()
            }),
        config.jmap_username,
        config.jmap_auth
    ]);
    format!("{:x}", Sha256::digest(origin.to_string().as_bytes()))
}
