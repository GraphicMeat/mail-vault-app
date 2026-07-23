use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use serde::Serialize;
use tracing::info;

#[derive(Debug, Serialize, Clone)]
pub struct EmailServerSettings {
    #[serde(rename = "imapHost")]
    pub imap_host: Option<String>,
    #[serde(rename = "imapPort")]
    pub imap_port: Option<u16>,
    #[serde(rename = "smtpHost")]
    pub smtp_host: Option<String>,
    #[serde(rename = "smtpPort")]
    pub smtp_port: Option<u16>,
    pub source: String,
    pub provider: Option<String>,
}

fn match_mx_to_provider(mx_host: &str) -> Option<EmailServerSettings> {
    let mx = mx_host.to_lowercase();

    let (imap, smtp, provider) = if mx.contains("google.com") || mx.contains("googlemail.com") {
        ("imap.gmail.com", "smtp.gmail.com", "google")
    } else if mx.contains("outlook.com") || mx.contains("microsoft.com") || mx.contains("office365") {
        ("outlook.office365.com", "smtp.office365.com", "microsoft")
    } else if mx.contains("hostinger") {
        ("imap.hostinger.com", "smtp.hostinger.com", "hostinger")
    } else if mx.contains("zoho.com") {
        ("imap.zoho.com", "smtp.zoho.com", "zoho")
    } else if mx.contains("yahoo") || mx.contains("yahoodns") {
        ("imap.mail.yahoo.com", "smtp.mail.yahoo.com", "yahoo")
    } else if mx.contains("protonmail") || mx.contains("proton.me") {
        return Some(EmailServerSettings {
            imap_host: Some("127.0.0.1".into()),
            imap_port: Some(1143),
            smtp_host: Some("127.0.0.1".into()),
            smtp_port: Some(1025),
            source: "mx".into(),
            provider: Some("protonmail".into()),
        });
    } else if mx.contains("fastmail") || mx.contains("messagingengine.com") {
        ("imap.fastmail.com", "smtp.fastmail.com", "fastmail")
    } else {
        return None;
    };

    Some(EmailServerSettings {
        imap_host: Some(imap.into()),
        imap_port: Some(993),
        smtp_host: Some(smtp.into()),
        smtp_port: Some(587),
        source: "mx".into(),
        provider: Some(provider.into()),
    })
}

fn patterns_from_mx(mx_host: &str) -> EmailServerSettings {
    let parts: Vec<&str> = mx_host.split('.').collect();
    let base_domain = if parts.len() >= 2 {
        format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        mx_host.to_string()
    };

    EmailServerSettings {
        imap_host: Some(format!("imap.{}", base_domain)),
        imap_port: Some(993),
        smtp_host: Some(format!("smtp.{}", base_domain)),
        smtp_port: Some(587),
        source: "mx-pattern".into(),
        provider: None,
    }
}

pub async fn resolve_email_settings(domain: &str) -> Result<EmailServerSettings, String> {
    let resolver = TokioResolver::builder_tokio()
        .map_err(|e| format!("Failed to create DNS resolver: {}", e))?
        .build()
        .map_err(|e| format!("Failed to build DNS resolver: {}", e))?;

    // 1. Try SRV records (RFC 6186)
    info!("[dns] Checking SRV records for {}", domain);
    if let Ok(settings) = try_srv_records(&resolver, domain).await {
        info!("[dns] Found SRV records for {}: imap={:?}", domain, settings.imap_host);
        return Ok(settings);
    }

    // 2. Try autoconfig XML
    info!("[dns] Checking autoconfig for {}", domain);
    if let Ok(settings) = try_autoconfig(domain).await {
        info!("[dns] Found autoconfig for {}: imap={:?}", domain, settings.imap_host);
        return Ok(settings);
    }

    // 3. Try MX record -> known provider mapping
    info!("[dns] Checking MX records for {}", domain);
    if let Ok(mx_response) = resolver.mx_lookup(domain).await {
        let mut first_mx_host: Option<String> = None;

        for record in mx_response.answers() {
            let RData::MX(mx) = &record.data else { continue };
            let mx_host = mx.exchange.to_ascii().trim_end_matches('.').to_string();
            info!("[dns] MX record: {} (priority {})", mx_host, mx.preference);

            if first_mx_host.is_none() {
                first_mx_host = Some(mx_host.clone());
            }

            if let Some(settings) = match_mx_to_provider(&mx_host) {
                return Ok(settings);
            }
        }

        // No known provider — derive patterns from first MX
        if let Some(mx_host) = first_mx_host {
            return Ok(patterns_from_mx(&mx_host));
        }
    }

    Err(format!("Could not resolve email settings for {}", domain))
}

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

async fn try_srv_records(resolver: &TokioResolver, domain: &str) -> Result<EmailServerSettings, String> {
    let imap_srv = format!("_imaps._tcp.{}", domain);
    let smtp_srv = format!("_submission._tcp.{}", domain);

    let imap = resolver.srv_lookup(&imap_srv).await
        .map_err(|e| format!("SRV lookup failed: {}", e))?;

    let imap_record = imap.answers().iter()
        .find_map(|r| match &r.data { RData::SRV(srv) => Some(srv.clone()), _ => None })
        .ok_or_else(|| "No IMAP SRV records".to_string())?;

    let imap_host = imap_record.target.to_ascii().trim_end_matches('.').to_string();
    let imap_port = imap_record.port;

    let (smtp_host, smtp_port) = if let Ok(smtp) = resolver.srv_lookup(&smtp_srv).await {
        if let Some(r) = smtp.answers().iter()
            .find_map(|r| match &r.data { RData::SRV(srv) => Some(srv.clone()), _ => None })
        {
            (r.target.to_ascii().trim_end_matches('.').to_string(), r.port)
        } else {
            (imap_host.replace("imap", "smtp"), 587)
        }
    } else {
        (imap_host.replace("imap", "smtp"), 587)
    };

    Ok(EmailServerSettings {
        imap_host: Some(imap_host),
        imap_port: Some(imap_port),
        smtp_host: Some(smtp_host),
        smtp_port: Some(smtp_port),
        source: "srv".into(),
        provider: None,
    })
}

async fn try_autoconfig(domain: &str) -> Result<EmailServerSettings, String> {
    let url = format!("https://autoconfig.{}/mail/config-v1.1.xml", domain);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client.get(&url).send().await
        .map_err(|e| format!("Autoconfig fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Autoconfig returned {}", resp.status()));
    }

    let xml = resp.text().await
        .map_err(|e| format!("Failed to read autoconfig response: {}", e))?;

    parse_autoconfig_xml(&xml)
}

fn parse_autoconfig_xml(xml: &str) -> Result<EmailServerSettings, String> {
    let mut imap_host = None;
    let mut imap_port = None;
    let mut smtp_host = None;
    let mut smtp_port = None;
    let mut in_incoming = false;
    let mut in_outgoing = false;

    for line in xml.lines() {
        let trimmed = line.trim();
        if trimmed.contains("incomingServer") && trimmed.contains("imap") {
            in_incoming = true;
            in_outgoing = false;
        } else if trimmed.contains("outgoingServer") && trimmed.contains("smtp") {
            in_outgoing = true;
            in_incoming = false;
        } else if trimmed.contains("/incomingServer") {
            in_incoming = false;
        } else if trimmed.contains("/outgoingServer") {
            in_outgoing = false;
        }

        if in_incoming || in_outgoing {
            if trimmed.starts_with("<hostname>") {
                let val = trimmed
                    .trim_start_matches("<hostname>")
                    .trim_end_matches("</hostname>")
                    .trim();
                if in_incoming && imap_host.is_none() { imap_host = Some(val.to_string()); }
                if in_outgoing && smtp_host.is_none() { smtp_host = Some(val.to_string()); }
            }
            if trimmed.starts_with("<port>") {
                let val = trimmed
                    .trim_start_matches("<port>")
                    .trim_end_matches("</port>")
                    .trim();
                if let Ok(p) = val.parse::<u16>() {
                    if in_incoming && imap_port.is_none() { imap_port = Some(p); }
                    if in_outgoing && smtp_port.is_none() { smtp_port = Some(p); }
                }
            }
        }
    }

    if imap_host.is_some() || smtp_host.is_some() {
        Ok(EmailServerSettings {
            imap_host,
            imap_port: imap_port.or(Some(993)),
            smtp_host,
            smtp_port: smtp_port.or(Some(587)),
            source: "autoconfig".into(),
            provider: None,
        })
    } else {
        Err("No IMAP/SMTP settings found in autoconfig XML".into())
    }
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
