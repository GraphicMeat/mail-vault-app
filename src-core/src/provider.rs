//! Which mail provider (Google, Microsoft, Yahoo, ...) a host, an MX host or an
//! account belongs to: the one decision. A host belongs to a provider when it
//! IS one of the provider's domains or sits under one (`imap.gmail.com`,
//! `aspmx.l.google.com`); a provider's name anywhere else in a host
//! (`imap.gmail.com.evil.com`, `mail.notoutlook.example`) is not that provider.
//!
//! This is the provider axis. Which protocol an account speaks (IMAP, Graph,
//! JMAP) is the other one, `ImapConfig::transport()`. An email ADDRESS domain
//! (`me@hotmail.co.uk`) is a third: see `log_redact` and `learned_rules`.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Google,
    Microsoft,
    Yahoo,
    Zoho,
    Hostinger,
    Proton,
    Fastmail,
}

/// Each provider's domains: its IMAP and SMTP hosts and its MX hosts sit on or
/// under one of these. Hosts on one base domain already match each other in
/// `dns`, so this lists what ties different bases to one provider. Public for
/// the source ratchet (`tests/module_layers.rs`), whose provider words come
/// from here.
pub const DOMAINS: &[(Provider, &[&str])] = &[
    (Provider::Google, &["gmail.com", "googlemail.com", "google.com"]),
    // `mx.microsoft` is the MX zone of newer Exchange Online tenants;
    // `office365.us` serves the US government cloud.
    (
        Provider::Microsoft,
        &["outlook.com", "hotmail.com", "office365.com", "office365.us", "microsoft.com", "mx.microsoft"],
    ),
    (Provider::Hostinger, &["hostinger.com"]),
    (Provider::Zoho, &["zoho.com"]),
    (Provider::Yahoo, &["yahoo.com", "yahoodns.net"]),
    (Provider::Proton, &["protonmail.ch", "protonmail.com", "proton.me"]),
    (Provider::Fastmail, &["fastmail.com", "fastmail.fm", "messagingengine.com"]),
];

impl Provider {
    /// The provider of an IMAP, SMTP or MX host: the host equals one of its
    /// domains or ends with `.<domain>`. Trimmed, case-insensitive, a trailing
    /// root dot ignored.
    pub fn from_host(host: &str) -> Option<Provider> {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        DOMAINS.iter().find_map(|(provider, domains)| {
            domains
                .iter()
                .any(|d| host == *d || host.strip_suffix(d).is_some_and(|rest| rest.ends_with('.')))
                .then_some(*provider)
        })
    }

    /// The word stored for the provider: an account's `oauth2Provider`, the
    /// OAuth flow's `provider` parameter, `dns` settings' `provider`.
    pub fn tag(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Microsoft => "microsoft",
            Provider::Yahoo => "yahoo",
            Provider::Zoho => "zoho",
            Provider::Hostinger => "hostinger",
            Provider::Proton => "protonmail",
            Provider::Fastmail => "fastmail",
        }
    }

    /// The provider a stored tag names (trimmed, case-insensitive); `None` for
    /// a word that names none. A caller that treats a MISSING tag in its own
    /// way (Microsoft, for the OAuth flow) reads the field first.
    pub fn from_tag(tag: &str) -> Option<Provider> {
        let tag = tag.trim();
        DOMAINS.iter().map(|(p, _)| *p).find(|p| p.tag().eq_ignore_ascii_case(tag))
    }

    /// Whether an account record (an `accounts.json` entry or the keychain
    /// blob's copy) is this provider's: it signs in with this provider's OAuth
    /// (`authType` oauth2 and `oauth2Provider` naming it), or its IMAP host is
    /// this provider's (an app-password Gmail account is Google's too).
    pub fn owns_account(self, account: &Value) -> bool {
        let text = |key: &str| account.get(key).and_then(Value::as_str).unwrap_or_default();
        let oauth = text("authType").trim().eq_ignore_ascii_case("oauth2");
        (oauth && Provider::from_tag(text("oauth2Provider")) == Some(self)) || Provider::from_host(text("imapHost")) == Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every host and MX the old classifiers' tests (`transfer_limits`
    /// fixture, `dns`, `ai`, `aliases`) fed them, with the answer they gave.
    #[test]
    fn hosts_the_old_classifiers_knew_keep_their_provider() {
        let cases: &[(&str, Option<Provider>)] = &[
            ("imap.gmail.com", Some(Provider::Google)),
            ("IMAP.GMAIL.COM", Some(Provider::Google)),
            ("IMAP.GoogleMail.com", Some(Provider::Google)),
            ("imap.googlemail.com", Some(Provider::Google)),
            (" imap.gmail.com. ", Some(Provider::Google)),
            ("smtp.gmail.com", Some(Provider::Google)),
            ("aspmx.l.google.com", Some(Provider::Google)),
            ("alt1.aspmx.l.google.com", Some(Provider::Google)),
            ("aspmx2.googlemail.com", Some(Provider::Google)),
            ("outlook.office365.com", Some(Provider::Microsoft)),
            ("smtp.office365.com", Some(Provider::Microsoft)),
            ("example-com.mail.protection.outlook.com", Some(Provider::Microsoft)),
            ("contoso-com.r-v1.mx.microsoft", Some(Provider::Microsoft)),
            ("mx1.hotmail.com", Some(Provider::Microsoft)),
            ("mx1.hostinger.com", Some(Provider::Hostinger)),
            ("imap.hostinger.com", Some(Provider::Hostinger)),
            ("mx.zoho.com", Some(Provider::Zoho)),
            // Zoho's Australian data centre has its own servers (imap.zoho.com.au):
            // classed as Zoho, its MX was handed imap.zoho.com, the wrong server.
            ("mx.zoho.com.au", None),
            ("mta5.am0.yahoodns.net", Some(Provider::Yahoo)),
            ("imap.mail.yahoo.com", Some(Provider::Yahoo)),
            ("mail.protonmail.ch", Some(Provider::Proton)),
            ("in1-smtp.messagingengine.com", Some(Provider::Fastmail)),
            ("imap.fastmail.com", Some(Provider::Fastmail)),
            ("gmail.com", Some(Provider::Google)),
            ("imap.example.test", None),
            ("mx.example.test", None),
            ("mx1.example.test", None),
            ("mx2.other.test", None),
            ("127.0.0.1", None),
            ("", None),
        ];
        for (host, want) in cases {
            assert_eq!(Provider::from_host(host), *want, "host {host:?}");
        }
    }

    /// A provider's name inside some other domain is not that provider. The
    /// old substring rules (`transfer_limits`, `dns`) took every one of these.
    #[test]
    fn a_lookalike_host_names_no_provider() {
        for host in [
            "imap.gmail.com.evil.com",
            "mail.notgmail.example",
            "gmail",
            "aspmx.l.google.com.evil.com",
            "mail.notoutlook.example",
            "outlook.com.attacker.test",
            "yahoo.attacker.test",
            "myzoho.example",
            "notfastmail.example",
            "proton.example",
        ] {
            assert_eq!(Provider::from_host(host), None, "host {host:?}");
        }
    }

    #[test]
    fn a_tag_names_its_provider_and_round_trips() {
        assert_eq!(Provider::from_tag("google"), Some(Provider::Google));
        assert_eq!(Provider::from_tag(" Microsoft "), Some(Provider::Microsoft));
        assert_eq!(Provider::from_tag("gmail"), None);
        assert_eq!(Provider::from_tag(""), None);
        for (p, _) in DOMAINS {
            assert_eq!(Provider::from_tag(p.tag()), Some(*p));
        }
    }

    /// The cases `ai::is_google_account` and `aliases::is_gmail_oauth` pinned.
    #[test]
    fn a_google_account_is_google_oauth_or_a_google_imap_host() {
        let google = |a: Value| Provider::Google.owns_account(&a);
        assert!(google(json!({"authType": "oauth2", "oauth2Provider": "google"})));
        assert!(google(json!({"authType": " OAuth2 ", "oauth2Provider": "Google"})));
        assert!(google(json!({"authType": "password", "imapHost": "imap.gmail.com"})), "an app-password Gmail account");
        assert!(google(json!({"imapHost": "IMAP.GOOGLEMAIL.COM"})));
        assert!(google(json!({"imapHost": " imap.gmail.com. "})));
        assert!(google(json!({"authType": "oauth2", "imapHost": "IMAP.gmail.com"})), "no provider field, Gmail's host");
        assert!(google(json!({"authType": "oauth2", "oauth2Provider": "google", "imapHost": "imap.example.test"})), "Workspace");
        assert!(!google(json!({"authType": "oauth2", "oauth2Provider": "microsoft", "imapHost": "outlook.office365.com"})));
        assert!(!google(json!({"authType": "password", "imapHost": "imap.fastmail.com"})));
        assert!(!google(json!({"authType": "password", "oauth2Provider": "google"})), "a provider tag without OAuth is not a Google sign-in");
        assert!(!google(json!({"imapHost": "imap.gmail.com.evil.com"})));
        assert!(!google(json!({})));
        assert!(!google(json!(null)));
        assert!(Provider::Microsoft.owns_account(&json!({"authType": "oauth2", "oauth2Provider": "microsoft"})));
    }
}
