use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use serde::Serialize;

// Shared resolver core (EmailServerSettings, resolve_email_settings, SRV/
// autoconfig/MX discovery) lives in mailvault_core::dns so the daemon shares
// the same implementation. This module keeps only the Tauri-specific
// post-server-change DNS health probe layered on top.
pub use mailvault_core::dns::*;

// ── Post-server-change DNS health probe ──────────────────────────────────────

/// DKIM selectors commonly used by mainstream providers. A domain typically
/// publishes DKIM under exactly one, so most of these lookups are misses.
const DKIM_SELECTORS: &[&str] = &[
    "default", "google", "selector1", "selector2", "k1", "s1", "s2", "mail",
    "dkim", "zoho", "hostingermail1", "hostingermail2", "protonmail", "fm1",
    "fm2", "fm3",
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MailDnsHealth {
    pub domain: String,
    pub mx_hosts: Vec<String>,
    pub mx_matches_new_server: Option<bool>,
    pub spf_found: bool,
    pub spf_record: Option<String>,
    pub dmarc_found: bool,
    pub dmarc_record: Option<String>,
    pub dkim_selectors_found: Vec<String>,
    pub dkim_selectors_checked: Vec<String>,
    pub warnings: Vec<String>,
}

/// Registrable base domain: the last two labels, lowercased.
fn base_domain(host: &str) -> String {
    let h = host.trim_end_matches('.').to_lowercase();
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() >= 2 {
        format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        h
    }
}

/// Provider alias group for a hostname, so provider-owned MX and IMAP hosts on
/// different base domains still match (e.g. aspmx.l.google.com ↔ imap.gmail.com).
/// Mirrors the provider knowledge in `match_mx_to_provider`.
fn provider_group(host: &str) -> Option<&'static str> {
    let h = host.to_lowercase();
    if h.contains("google") || h.contains("gmail") || h.contains("googlemail") {
        Some("google")
    } else if h.contains("outlook") || h.contains("office365") || h.contains("microsoft") || h.contains("hotmail") {
        Some("microsoft")
    } else if h.contains("hostinger") {
        Some("hostinger")
    } else if h.contains("zoho") {
        Some("zoho")
    } else if h.contains("yahoo") || h.contains("yahoodns") {
        Some("yahoo")
    } else if h.contains("proton") {
        Some("proton")
    } else if h.contains("fastmail") || h.contains("messagingengine") {
        Some("fastmail")
    } else {
        None
    }
}

/// Does any MX host point at the same mail server as `imap_host`? Compares
/// registrable base domains plus provider alias groups. `None` when there are
/// no MX hosts to judge against.
fn mx_matches_host(mx_hosts: &[String], imap_host: &str) -> Option<bool> {
    if mx_hosts.is_empty() {
        return None;
    }
    let imap_base = base_domain(imap_host);
    let imap_group = provider_group(imap_host);
    for mx in mx_hosts {
        if base_domain(mx) == imap_base {
            return Some(true);
        }
        if let (Some(g), Some(ig)) = (provider_group(mx), imap_group) {
            if g == ig {
                return Some(true);
            }
        }
    }
    Some(false)
}

fn is_spf(record: &str) -> bool {
    record.trim_start().to_lowercase().starts_with("v=spf1")
}

fn is_dmarc(record: &str) -> bool {
    record.trim_start().to_lowercase().starts_with("v=dmarc1")
}

fn is_dkim(record: &str) -> bool {
    let lower = record.to_lowercase();
    lower.contains("v=dkim1") || lower.contains("p=")
}

fn build_warnings(
    mx_matches: Option<bool>,
    spf_found: bool,
    dmarc_found: bool,
    dkim_found: bool,
    dkim_checked: usize,
) -> Vec<String> {
    let mut w = Vec::new();
    if mx_matches == Some(false) {
        w.push("MX records don't point to your new mail server — incoming mail may still go to the old server.".to_string());
    }
    if !spf_found {
        w.push("No SPF record found — outgoing mail may be marked as spam.".to_string());
    }
    if !dmarc_found {
        w.push("No DMARC record found.".to_string());
    }
    if !dkim_found {
        w.push(format!(
            "No DKIM record found (checked {} common selectors) — outgoing mail may be marked as spam.",
            dkim_checked
        ));
    }
    w
}

/// Fetch all TXT strings for a name. A lookup failure (NXDOMAIN etc.) yields an
/// empty list rather than aborting the caller's whole probe.
async fn txt_records(resolver: &TokioResolver, name: &str) -> Vec<String> {
    let Ok(resp) = resolver.txt_lookup(name).await else {
        return Vec::new();
    };
    resp.answers()
        .iter()
        .filter_map(|record| match &record.data {
            RData::TXT(txt) => Some(
                txt.txt_data
                    .iter()
                    .map(|b| String::from_utf8_lossy(b))
                    .collect::<String>(),
            ),
            _ => None,
        })
        .collect()
}

/// Probe MX/SPF/DMARC/DKIM for `domain` after a server change. Individual
/// lookup failures degrade to "not found"; only resolver construction fails hard.
pub async fn mail_dns_health(
    domain: &str,
    new_imap_host: Option<&str>,
) -> Result<MailDnsHealth, String> {
    let resolver = TokioResolver::builder_tokio()
        .map_err(|e| format!("Failed to create DNS resolver: {}", e))?
        .build()
        .map_err(|e| format!("Failed to build DNS resolver: {}", e))?;

    // MX, sorted by preference (lowest first).
    let mut mx: Vec<(u16, String)> = Vec::new();
    if let Ok(resp) = resolver.mx_lookup(domain).await {
        for record in resp.answers() {
            if let RData::MX(m) = &record.data {
                mx.push((m.preference, m.exchange.to_ascii().trim_end_matches('.').to_string()));
            }
        }
    }
    mx.sort_by_key(|(pref, _)| *pref);
    let mx_hosts: Vec<String> = mx.into_iter().map(|(_, h)| h).collect();

    let mx_matches_new_server = new_imap_host.and_then(|h| mx_matches_host(&mx_hosts, h));

    // SPF
    let spf_record = txt_records(&resolver, domain).await.into_iter().find(|r| is_spf(r));
    let spf_found = spf_record.is_some();

    // DMARC
    let dmarc_record = txt_records(&resolver, &format!("_dmarc.{}", domain))
        .await
        .into_iter()
        .find(|r| is_dmarc(r));
    let dmarc_found = dmarc_record.is_some();

    // DKIM — probe each common selector.
    // ponytail: sequential lookups; parallelize with join_all if latency bites.
    let mut dkim_selectors_found = Vec::new();
    for sel in DKIM_SELECTORS {
        let name = format!("{}._domainkey.{}", sel, domain);
        if txt_records(&resolver, &name).await.iter().any(|r| is_dkim(r)) {
            dkim_selectors_found.push(sel.to_string());
        }
    }
    let dkim_selectors_checked: Vec<String> =
        DKIM_SELECTORS.iter().map(|s| s.to_string()).collect();

    let warnings = build_warnings(
        mx_matches_new_server,
        spf_found,
        dmarc_found,
        !dkim_selectors_found.is_empty(),
        dkim_selectors_checked.len(),
    );

    Ok(MailDnsHealth {
        domain: domain.to_string(),
        mx_hosts,
        mx_matches_new_server,
        spf_found,
        spf_record,
        dmarc_found,
        dmarc_record,
        dkim_selectors_found,
        dkim_selectors_checked,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn mx_match_same_base_domain() {
        assert_eq!(mx_matches_host(&v(&["mx1.hostinger.com"]), "imap.hostinger.com"), Some(true));
    }

    #[test]
    fn mx_match_google_alias_group() {
        // MX on google.com base, imap on gmail.com base — different base, same provider.
        assert_eq!(mx_matches_host(&v(&["aspmx.l.google.com"]), "imap.gmail.com"), Some(true));
    }

    #[test]
    fn mx_match_microsoft_alias_group() {
        assert_eq!(
            mx_matches_host(&v(&["example-com.mail.protection.outlook.com"]), "outlook.office365.com"),
            Some(true)
        );
    }

    #[test]
    fn mx_mismatch_different_providers() {
        assert_eq!(mx_matches_host(&v(&["aspmx.l.google.com"]), "imap.hostinger.com"), Some(false));
    }

    #[test]
    fn mx_empty_is_undecidable() {
        assert_eq!(mx_matches_host(&[], "imap.gmail.com"), None);
    }

    #[test]
    fn record_classifiers() {
        assert!(is_spf("v=spf1 include:_spf.google.com ~all"));
        assert!(is_spf("  V=SPF1 -all"));
        assert!(!is_spf("google-site-verification=abc"));

        assert!(is_dmarc("v=DMARC1; p=reject"));
        assert!(!is_dmarc("v=spf1 -all"));

        assert!(is_dkim("v=DKIM1; k=rsa; p=MIGf..."));
        assert!(is_dkim("k=rsa; p=MIGf...")); // p= alone counts
        assert!(!is_dkim("v=spf1 -all"));
    }

    #[test]
    fn warnings_all_missing() {
        let w = build_warnings(Some(false), false, false, false, 16);
        assert_eq!(w.len(), 4);
        assert!(w[0].contains("MX records"));
        assert!(w[3].contains("16 common selectors"));
    }

    #[test]
    fn warnings_all_healthy() {
        assert!(build_warnings(Some(true), true, true, true, 16).is_empty());
    }

    #[test]
    fn warnings_mx_none_no_mx_warning() {
        // Undecidable MX (no hint / no records) must not emit the MX warning.
        let w = build_warnings(None, true, true, true, 16);
        assert!(w.is_empty());
    }
}
