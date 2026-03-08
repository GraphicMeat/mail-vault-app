use hickory_resolver::TokioResolver;
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
        .build();

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

        for mx in mx_response.iter() {
            let mx_host = mx.exchange().to_ascii().trim_end_matches('.').to_string();
            info!("[dns] MX record: {} (priority {})", mx_host, mx.preference());

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

async fn try_srv_records(resolver: &TokioResolver, domain: &str) -> Result<EmailServerSettings, String> {
    let imap_srv = format!("_imaps._tcp.{}", domain);
    let smtp_srv = format!("_submission._tcp.{}", domain);

    let imap = resolver.srv_lookup(&imap_srv).await
        .map_err(|e| format!("SRV lookup failed: {}", e))?;

    let imap_record = imap.iter().next()
        .ok_or_else(|| "No IMAP SRV records".to_string())?;

    let imap_host = imap_record.target().to_ascii().trim_end_matches('.').to_string();
    let imap_port = imap_record.port();

    let (smtp_host, smtp_port) = if let Ok(smtp) = resolver.srv_lookup(&smtp_srv).await {
        if let Some(r) = smtp.iter().next() {
            (r.target().to_ascii().trim_end_matches('.').to_string(), r.port())
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
