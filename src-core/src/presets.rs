//! Provider presets both apps take a provider's servers from. Desktop's values: the account
//! form's `PROVIDER_CONFIGS` (JS) and the MX match in [`crate::dns`] agree with these, and mobile
//! stores them on a new account. Only Gmail so far; the rest of the table moves here as each
//! caller needs it.

/// One server of a preset. `security` is `ssl` (implicit TLS) or `starttls`, the words both
/// apps store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Server {
    pub host: &'static str,
    pub port: u16,
    pub security: &'static str,
}

/// A provider's IMAP and SMTP servers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preset {
    pub provider: &'static str,
    pub imap: Server,
    pub smtp: Server,
}

/// Gmail (and Google Workspace): SMTP on 587 with STARTTLS, desktop's value (plan Ruling 2).
pub const GMAIL: Preset = Preset {
    provider: "google",
    imap: Server { host: "imap.gmail.com", port: 993, security: "ssl" },
    smtp: Server { host: "smtp.gmail.com", port: 587, security: "starttls" },
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gmail_is_desktops_preset() {
        assert_eq!(GMAIL.imap, Server { host: "imap.gmail.com", port: 993, security: "ssl" });
        assert_eq!(GMAIL.smtp, Server { host: "smtp.gmail.com", port: 587, security: "starttls" });
        assert_eq!(GMAIL.provider, "google");
    }
}
