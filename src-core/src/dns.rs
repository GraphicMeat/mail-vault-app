use futures::future::BoxFuture;
use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use serde::Serialize;
use tracing::info;

use crate::jmap::discover::{self, Discovered, Fetch};
use crate::net_activity::{self, NetEvent, Pending, Protocol};

/// `lookup` as one Network Activity DNS event: host is the name asked
/// about, purpose whatever the caller scoped (`net_activity::with_purpose`).
async fn traced<T, E: std::fmt::Display>(
    name: &str,
    lookup: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let mut query = Pending::new(NetEvent::out(Protocol::Dns, name, 53, net_activity::purpose()));
    let out = lookup.await;
    query.ev.result = match &out {
        Ok(_) => "ok".into(),
        Err(e) => e.to_string(),
    };
    out
}

#[derive(Debug, Serialize, Clone, Default)]
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
    /// The JMAP session URL `jmap::discover` found, or the Fastmail preset:
    /// the final URL after redirects, ready for `JmapClient::connect`.
    #[serde(rename = "jmapSessionUrl")]
    pub jmap_session_url: Option<String>,
    /// The session host is not on the address's domain (an SRV target or a
    /// redirect elsewhere): the user must confirm `jmapHost` before the first
    /// authenticated request.
    #[serde(rename = "jmapNeedsHostConfirmation")]
    pub jmap_needs_host_confirmation: bool,
    /// The session URL's host for that confirmation, with a non-default port.
    #[serde(rename = "jmapHost")]
    pub jmap_host: Option<String>,
    /// "preset", "well-known" or "srv". The UI preselects JMAP for the first
    /// two only; an SRV-only hit is offered with IMAP still preselected.
    #[serde(rename = "jmapSource")]
    pub jmap_source: Option<String>,
}

impl EmailServerSettings {
    fn set_jmap(&mut self, d: Discovered) {
        self.jmap_session_url = Some(d.session_url);
        self.jmap_needs_host_confirmation = d.needs_host_confirmation;
        self.jmap_host = Some(d.host);
        self.jmap_source = Some(d.source.to_string());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MxRecord {
    pub preference: u16,
    /// Without the trailing dot.
    pub exchange: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SrvRecord {
    pub priority: u16,
    pub weight: u16,
    pub port: u16,
    /// Without the trailing dot; "" for the RFC 2782 "." (no service).
    pub target: String,
}

/// The DNS lookups account setup makes, injectable for tests. Records come
/// back in answer order. `Err` for any failure, NXDOMAIN included.
pub trait Resolver: Send + Sync {
    fn mx<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<Vec<MxRecord>, String>>;
    fn srv<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<SrvRecord>, String>>;
}

/// The system resolver, every lookup one Network Activity DNS event.
pub struct SystemResolver(TokioResolver);

impl SystemResolver {
    pub fn new() -> Result<Self, String> {
        let resolver = TokioResolver::builder_tokio()
            .map_err(|e| format!("Failed to create DNS resolver: {}", e))?
            .build()
            .map_err(|e| format!("Failed to build DNS resolver: {}", e))?;
        Ok(SystemResolver(resolver))
    }
}

impl Resolver for SystemResolver {
    fn mx<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<Vec<MxRecord>, String>> {
        Box::pin(async move {
            let resp = traced(domain, self.0.mx_lookup(domain)).await.map_err(|e| e.to_string())?;
            Ok(resp
                .answers()
                .iter()
                .filter_map(|r| match &r.data {
                    RData::MX(mx) => Some(MxRecord {
                        preference: mx.preference,
                        exchange: mx.exchange.to_ascii().trim_end_matches('.').to_string(),
                    }),
                    _ => None,
                })
                .collect())
        })
    }

    fn srv<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<SrvRecord>, String>> {
        Box::pin(async move {
            let resp = traced(name, self.0.srv_lookup(name)).await.map_err(|e| e.to_string())?;
            Ok(resp
                .answers()
                .iter()
                .filter_map(|r| match &r.data {
                    RData::SRV(srv) => Some(SrvRecord {
                        priority: srv.priority,
                        weight: srv.weight,
                        port: srv.port,
                        target: srv.target.to_ascii().trim_end_matches('.').to_string(),
                    }),
                    _ => None,
                })
                .collect())
        })
    }
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
            ..Default::default()
        });
    } else if mx.contains("fastmail") || mx.contains("messagingengine.com") {
        ("imap.fastmail.com", "smtp.fastmail.com", "fastmail")
    } else {
        return None;
    };

    let mut settings = EmailServerSettings {
        imap_host: Some(imap.into()),
        imap_port: Some(993),
        smtp_host: Some(smtp.into()),
        smtp_port: Some(587),
        source: "mx".into(),
        provider: Some(provider.into()),
        ..Default::default()
    };
    // Kept here as well as in `discover`, so the preset survives a discovery
    // that timed out while this MX lookup answered.
    if provider == "fastmail" {
        settings.set_jmap(discover::fastmail_preset());
    }
    Some(settings)
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
        ..Default::default()
    }
}

/// How long JMAP discovery may keep running once the IMAP cascade has
/// answered. The cascade is what the user waits for; discovery only adds the
/// JMAP fields when it is quick. When the cascade finds nothing, discovery
/// keeps its whole `discover::PROBE_TIMEOUT` budget.
pub const JMAP_GRACE: std::time::Duration = std::time::Duration::from_millis(750);

/// IMAP/SMTP settings for `domain`, plus any JMAP session it offers.
pub async fn resolve_email_settings(domain: &str) -> Result<EmailServerSettings, String> {
    let resolver = SystemResolver::new()?;
    resolve_email_settings_with(domain, &resolver, &discover::HttpFetch::new()).await
}

/// `resolve_email_settings` over an injected resolver and JMAP fetcher. The
/// IMAP cascade returns at its first hit (SRV, autoconfig, MX), so JMAP
/// discovery is not a cascade step: it runs alongside and is merged in.
/// Every discovery step is bounded by `discover::PROBE_TIMEOUT` and they run
/// concurrently. Once the cascade has answered, discovery gets at most
/// `JMAP_GRACE` more, so the IMAP answer the user waits for is never held up
/// by a slow JMAP probe; when the cascade finds nothing, discovery keeps its
/// whole budget.
/// Autoconfig is not injected: it keeps its own client, which follows
/// redirects, exactly as before.
pub async fn resolve_email_settings_with(
    domain: &str,
    resolver: &dyn Resolver,
    fetch: &dyn Fetch,
) -> Result<EmailServerSettings, String> {
    use futures::future::{select, Either};
    let cascade = Box::pin(imap_cascade(resolver, domain));
    let jmap = Box::pin(discover::discover_with(domain, resolver, fetch));
    match select(cascade, jmap).await {
        // The IMAP cascade answered first. With an answer, JMAP discovery gets
        // a short grace and then the result goes without it; with none, it is
        // the only answer left and keeps its whole budget.
        Either::Left((cascade, jmap)) => {
            let jmap = if cascade.is_ok() { tokio::time::timeout(JMAP_GRACE, jmap).await.unwrap_or(None) } else { jmap.await };
            merge_jmap(cascade, jmap)
        }
        Either::Right((jmap, cascade)) => merge_jmap(cascade.await, jmap),
    }
}

/// The cascade's answer with discovery's added. A preset the MX row already
/// set stays. JMAP alone still answers (`source: "jmap"`, no IMAP fields);
/// only both failing is an error.
fn merge_jmap(
    cascade: Result<EmailServerSettings, String>,
    jmap: Option<Discovered>,
) -> Result<EmailServerSettings, String> {
    let mut settings = match cascade {
        Ok(s) => s,
        Err(e) if jmap.is_none() => return Err(e),
        Err(_) => EmailServerSettings { source: "jmap".into(), ..Default::default() },
    };
    if settings.jmap_session_url.is_none() {
        if let Some(d) = jmap {
            settings.set_jmap(d);
        }
    }
    Ok(settings)
}

async fn imap_cascade(resolver: &dyn Resolver, domain: &str) -> Result<EmailServerSettings, String> {
    // 1. Try SRV records (RFC 6186)
    info!("[dns] Checking SRV records for {}", domain);
    if let Ok(settings) = try_srv_records(resolver, domain).await {
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
    if let Ok(records) = resolver.mx(domain).await {
        if let Some(settings) = settings_from_mx(&records) {
            return Ok(settings);
        }
    }

    Err(format!("Could not resolve email settings for {}", domain))
}

/// Cascade step 3: the first MX naming a known provider, else patterns
/// derived from the first MX.
fn settings_from_mx(records: &[MxRecord]) -> Option<EmailServerSettings> {
    for mx in records {
        info!("[dns] MX record: {} (priority {})", mx.exchange, mx.preference);
        if let Some(settings) = match_mx_to_provider(&mx.exchange) {
            return Some(settings);
        }
    }
    // No known provider — derive patterns from first MX
    records.first().map(|mx| patterns_from_mx(&mx.exchange))
}

async fn try_srv_records(resolver: &dyn Resolver, domain: &str) -> Result<EmailServerSettings, String> {
    let imap_srv = format!("_imaps._tcp.{}", domain);
    let smtp_srv = format!("_submission._tcp.{}", domain);

    let imap = resolver.srv(&imap_srv).await
        .map_err(|e| format!("SRV lookup failed: {}", e))?;

    let imap_record = imap.into_iter().next()
        .ok_or_else(|| "No IMAP SRV records".to_string())?;

    let imap_host = imap_record.target;
    let imap_port = imap_record.port;

    let (smtp_host, smtp_port) = match resolver.srv(&smtp_srv).await.ok().and_then(|r| r.into_iter().next()) {
        Some(r) => (r.target, r.port),
        None => (imap_host.replace("imap", "smtp"), 587),
    };

    Ok(EmailServerSettings {
        imap_host: Some(imap_host),
        imap_port: Some(imap_port),
        smtp_host: Some(smtp_host),
        smtp_port: Some(smtp_port),
        source: "srv".into(),
        provider: None,
        ..Default::default()
    })
}

async fn try_autoconfig(domain: &str) -> Result<EmailServerSettings, String> {
    let url = format!("https://autoconfig.{}/mail/config-v1.1.xml", domain);

    let client = crate::net_activity::http_client("account setup", Some(std::time::Duration::from_secs(5)));

    let resp = client.send(client.get(&url)).await
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
            ..Default::default()
        })
    } else {
        Err("No IMAP/SMTP settings found in autoconfig XML".into())
    }
}

// ── Post-server-change DNS health probe ──────────────────────────────────────
// Moved from src-tauri/src/dns.rs (Task 5.8), verbatim, same relocate-then-
// re-export pattern Task 5.3 used for smtp.rs. No `crate::`-relative imports
// to fix — this code never referenced the app crate.

/// DKIM selectors commonly used by mainstream providers. A domain typically
/// publishes DKIM under exactly one, so most of these lookups are misses.
const DKIM_SELECTORS: &[&str] = &[
    "default", "google", "selector1", "selector2", "k1", "s1", "s2", "mail",
    "dkim", "zoho", "hostingermail1", "hostingermail2", "protonmail", "fm1",
    "fm2", "fm3", "purelymail1", "purelymail2", "purelymail3", "key1", "key2",
    "mx", "smtp", "mandrill", "everlytickey1", "everlytickey2",
    "s1-ionos", "s2-ionos",
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
        // Selector names are provider-specific and can't be enumerated from DNS,
        // so a miss across the common list is inconclusive — phrase it that way.
        w.push(format!(
            "Couldn't verify DKIM ({} common selectors checked) — if your provider uses a custom selector this is a false alarm; otherwise outgoing mail may be marked as spam.",
            dkim_checked
        ));
    }
    w
}

/// Fetch all TXT strings for a name. A lookup failure (NXDOMAIN etc.) yields an
/// empty list rather than aborting the caller's whole probe.
async fn txt_records(resolver: &TokioResolver, name: &str) -> Vec<String> {
    txt_records_strict(resolver, name).await.unwrap_or_default()
}

/// Like `txt_records`, but only "the name has no TXT records" (NXDOMAIN or
/// NODATA) is an empty answer; a timeout or SERVFAIL is an `Err`, since it
/// says nothing about the name and must not be cached as "none".
async fn txt_records_strict(resolver: &TokioResolver, name: &str) -> Result<Vec<String>, String> {
    let resp = match traced(name, resolver.txt_lookup(name)).await {
        Ok(resp) => resp,
        Err(e) if e.is_no_records_found() => return Ok(Vec::new()),
        Err(e) => return Err(format!("TXT lookup for {name} failed: {e}")),
    };
    Ok(resp.answers()
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
        .collect())
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
    if let Ok(resp) = traced(domain, resolver.mx_lookup(domain)).await {
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

// ── BIMI ────────────────────────────────────────────────────────────────────

/// `k=v; k=v` tags of a DMARC or BIMI record, keys lowercased.
fn record_tags(record: &str) -> Vec<(String, String)> {
    record
        .split(';')
        .filter_map(|t| {
            let (k, v) = t.split_once('=')?;
            Some((k.trim().to_ascii_lowercase(), v.trim().to_string()))
        })
        .collect()
}

fn tag<'a>(tags: &'a [(String, String)], key: &str) -> Option<&'a str> {
    tags.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn is_bimi(record: &str) -> bool {
    tag(&record_tags(record), "v").is_some_and(|v| v.eq_ignore_ascii_case("BIMI1"))
}

/// The https logo URL a `v=BIMI1` record publishes. None for any other
/// record, and for one that declines (`l=` empty). The `a=` evidence (a VMC
/// certificate) is NOT validated: the logo is shown on the domain's DMARC
/// enforcement alone, and nothing here claims a verified mark.
pub fn bimi_logo_url(record: &str) -> Option<String> {
    if !is_bimi(record) {
        return None;
    }
    tag(&record_tags(record), "l")?
        .split(',')
        .map(str::trim)
        .find(|u| u.len() > 8 && u[..8].eq_ignore_ascii_case("https://"))
        .map(String::from)
}

/// Does this DMARC record enforce (quarantine or reject, on every message)?
/// `subdomain`: the record came from the org domain for a subdomain sender,
/// so its `sp=` wins when present.
pub fn dmarc_enforces(record: &str, subdomain: bool) -> bool {
    if !is_dmarc(record) {
        return false;
    }
    let tags = record_tags(record);
    let policy = subdomain.then(|| tag(&tags, "sp")).flatten().or_else(|| tag(&tags, "p"));
    let enforced = policy.is_some_and(|p| p.eq_ignore_ascii_case("quarantine") || p.eq_ignore_ascii_case("reject"));
    enforced && tag(&tags, "pct").is_none_or(|p| p.parse::<u32>().is_ok_and(|n| n >= 100))
}

/// The first TXT record at `<prefix>.<domain>` that `keep` accepts, falling
/// back to the org domain. The bool says the org domain answered.
/// ponytail: `base_domain` is the last two labels, wrong under public
/// suffixes like co.uk (it then asks the suffix, which has no record); a
/// public-suffix list would fix it.
async fn txt_with_org_fallback(
    resolver: &TokioResolver,
    prefix: &str,
    domain: &str,
    keep: fn(&str) -> bool,
) -> Result<Option<(String, bool)>, String> {
    let org = base_domain(domain);
    for (name, from_org) in [(domain, false), (org.as_str(), true)] {
        if from_org && name == domain {
            break;
        }
        let found = txt_records_strict(resolver, &format!("{prefix}.{name}")).await?;
        if let Some(r) = found.into_iter().find(|r| keep(r)) {
            return Ok(Some((r, from_org)));
        }
    }
    Ok(None)
}

/// A From domain's BIMI logo URL, only when its DMARC policy enforces.
/// `Ok(None)` is a definitive "no logo" (cacheable); `Err` is a lookup that
/// failed and says nothing.
pub async fn bimi_logo_url_for(domain: &str) -> Result<Option<String>, String> {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    let resolver = TokioResolver::builder_tokio()
        .map_err(|e| format!("Failed to create DNS resolver: {}", e))?
        .build()
        .map_err(|e| format!("Failed to build DNS resolver: {}", e))?;
    let dmarc = txt_with_org_fallback(&resolver, "_dmarc", &domain, is_dmarc).await?;
    if !dmarc.is_some_and(|(record, from_org)| dmarc_enforces(&record, from_org)) {
        return Ok(None);
    }
    Ok(txt_with_org_fallback(&resolver, "default._bimi", &domain, is_bimi)
        .await?
        .and_then(|(record, _)| bimi_logo_url(&record)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }


    #[test]
    fn bimi_record_parse() {
        assert_eq!(
            bimi_logo_url("v=BIMI1; l=https://brand.test/logo.svg; a=https://brand.test/vmc.pem").as_deref(),
            Some("https://brand.test/logo.svg")
        );
        assert_eq!(bimi_logo_url("v=BIMI1;l=https://a.test/x.svg").as_deref(), Some("https://a.test/x.svg"));
        assert_eq!(bimi_logo_url("v=BIMI1; l=; a=;"), None, "an empty l= declines");
        assert_eq!(bimi_logo_url("v=BIMI1; l=http://brand.test/logo.svg"), None, "https only");
        assert_eq!(bimi_logo_url("v=spf1 -all"), None);
        assert_eq!(bimi_logo_url("l=https://brand.test/logo.svg"), None, "no version tag");
    }

    #[test]
    fn dmarc_policy_gate() {
        assert!(dmarc_enforces("v=DMARC1; p=reject; rua=mailto:d@brand.test", false));
        assert!(dmarc_enforces("v=DMARC1; p=quarantine; pct=100", false));
        assert!(!dmarc_enforces("v=DMARC1; p=quarantine; pct=50", false), "partial pct is not enforcement");
        assert!(!dmarc_enforces("v=DMARC1; p=none", false));
        assert!(!dmarc_enforces("v=DMARC1", false));
        assert!(!dmarc_enforces("v=spf1 p=reject", false));
        // A subdomain sender under the org record: sp= wins when present.
        assert!(!dmarc_enforces("v=DMARC1; p=reject; sp=none", true));
        assert!(dmarc_enforces("v=DMARC1; p=reject; sp=none", false));
        assert!(dmarc_enforces("v=DMARC1; p=reject", true));
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
    fn dkim_selectors_cover_ionos() {
        // IONOS publishes DKIM under s1-ionos / s2-ionos; without them the
        // post-save check warned about a DKIM setup that was fine.
        for sel in ["s1-ionos", "s2-ionos"] {
            assert!(DKIM_SELECTORS.contains(&sel), "missing selector {sel}");
        }
    }

    #[test]
    fn warnings_all_missing() {
        let w = build_warnings(Some(false), false, false, false, 26);
        assert_eq!(w.len(), 4);
        assert!(w[0].contains("MX records"));
        assert!(w[3].contains("26 common selectors"));
    }

    #[test]
    fn warnings_all_healthy() {
        assert!(build_warnings(Some(true), true, true, true, 16).is_empty());
    }

    #[test]
    fn fastmail_mx_row_carries_the_jmap_preset() {
        let s = match_mx_to_provider("in1-smtp.messagingengine.com").unwrap();
        assert_eq!(s.imap_host.as_deref(), Some("imap.fastmail.com"));
        assert_eq!(s.smtp_host.as_deref(), Some("smtp.fastmail.com"));
        assert_eq!(s.source, "mx");
        assert_eq!(s.jmap_session_url.as_deref(), Some("https://api.fastmail.com/jmap/session"));
        assert_eq!(s.jmap_host.as_deref(), Some("api.fastmail.com"));
        assert_eq!(s.jmap_source.as_deref(), Some("preset"));
        assert!(!s.jmap_needs_host_confirmation);
        let g = match_mx_to_provider("aspmx.l.google.com").unwrap();
        assert_eq!(g.imap_host.as_deref(), Some("imap.gmail.com"));
        assert_eq!(g.jmap_session_url, None);
        assert_eq!(g.jmap_source, None);
    }

    #[test]
    fn mx_step_prefers_a_known_provider_then_patterns_from_the_first() {
        let mx = |preference, exchange: &str| MxRecord { preference, exchange: exchange.to_string() };
        let s = settings_from_mx(&[mx(10, "mx.example.test"), mx(20, "aspmx.l.google.com")]).unwrap();
        assert_eq!(s.provider.as_deref(), Some("google"));
        assert_eq!(s.source, "mx");
        let s = settings_from_mx(&[mx(10, "mx1.example.test"), mx(20, "mx2.other.test")]).unwrap();
        assert_eq!(s.imap_host.as_deref(), Some("imap.example.test"));
        assert_eq!(s.smtp_host.as_deref(), Some("smtp.example.test"));
        assert_eq!(s.source, "mx-pattern");
        assert!(settings_from_mx(&[]).is_none());
    }

    #[derive(Default)]
    struct FakeDns {
        srv: Vec<(String, Vec<SrvRecord>)>,
    }

    impl Resolver for FakeDns {
        fn mx<'a>(&'a self, _domain: &'a str) -> BoxFuture<'a, Result<Vec<MxRecord>, String>> {
            Box::pin(async { Err("NXDOMAIN".to_string()) })
        }
        fn srv<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<SrvRecord>, String>> {
            let out = self.srv.iter().find(|(n, _)| n == name).map(|(_, r)| r.clone()).ok_or_else(|| "NXDOMAIN".to_string());
            Box::pin(async move { out })
        }
    }

    fn srv_rec(target: &str, port: u16) -> SrvRecord {
        SrvRecord { priority: 10, weight: 0, port, target: target.to_string() }
    }

    #[tokio::test]
    async fn srv_step_reads_the_first_imaps_record_and_guesses_smtp() {
        let dns = FakeDns {
            srv: vec![(
                "_imaps._tcp.example.test".into(),
                vec![srv_rec("imap.example.test", 993), srv_rec("imap2.example.test", 994)],
            )],
        };
        let s = try_srv_records(&dns, "example.test").await.unwrap();
        assert_eq!((s.imap_host.as_deref(), s.imap_port), (Some("imap.example.test"), Some(993)));
        assert_eq!((s.smtp_host.as_deref(), s.smtp_port), (Some("smtp.example.test"), Some(587)));
        assert_eq!(s.source, "srv");
        assert_eq!(s.jmap_session_url, None);
    }

    #[tokio::test]
    async fn srv_step_takes_submission_when_published_and_fails_without_imaps() {
        let dns = FakeDns {
            srv: vec![
                ("_imaps._tcp.example.test".into(), vec![srv_rec("mail.example.test", 993)]),
                ("_submission._tcp.example.test".into(), vec![srv_rec("out.example.test", 465)]),
            ],
        };
        let s = try_srv_records(&dns, "example.test").await.unwrap();
        assert_eq!((s.smtp_host.as_deref(), s.smtp_port), (Some("out.example.test"), Some(465)));
        assert!(try_srv_records(&FakeDns::default(), "example.test").await.is_err());
    }

    fn discovered(source: &'static str) -> Discovered {
        Discovered {
            session_url: "https://jmap.example.test:8443/jmap/session".into(),
            host: "jmap.example.test:8443".into(),
            needs_host_confirmation: false,
            source,
        }
    }

    #[test]
    fn merge_keeps_the_cascade_and_adds_discovery() {
        let cascade = EmailServerSettings { imap_host: Some("imap.example.test".into()), source: "srv".into(), ..Default::default() };
        let s = merge_jmap(Ok(cascade), Some(discovered("well-known"))).unwrap();
        assert_eq!(s.imap_host.as_deref(), Some("imap.example.test"));
        assert_eq!(s.source, "srv");
        assert_eq!(s.jmap_session_url.as_deref(), Some("https://jmap.example.test:8443/jmap/session"));
        assert_eq!(s.jmap_host.as_deref(), Some("jmap.example.test:8443"));
        assert_eq!(s.jmap_source.as_deref(), Some("well-known"));
    }

    #[test]
    fn merge_answers_jmap_alone_when_the_cascade_failed() {
        let s = merge_jmap(Err("Could not resolve".into()), Some(discovered("srv"))).unwrap();
        assert_eq!(s.imap_host, None);
        assert_eq!(s.smtp_host, None);
        assert_eq!(s.source, "jmap");
        assert_eq!(s.jmap_source.as_deref(), Some("srv"));
        assert_eq!(merge_jmap(Err("Could not resolve".into()), None).unwrap_err(), "Could not resolve");
    }

    #[test]
    fn merge_keeps_the_mx_row_preset_over_discovery() {
        let cascade = match_mx_to_provider("in1-smtp.messagingengine.com").unwrap();
        let s = merge_jmap(Ok(cascade), Some(discovered("well-known"))).unwrap();
        assert_eq!(s.jmap_session_url.as_deref(), Some("https://api.fastmail.com/jmap/session"));
        assert_eq!(s.jmap_source.as_deref(), Some("preset"));
    }

    #[test]
    fn email_server_settings_serialize_the_jmap_keys() {
        let v = serde_json::to_value(merge_jmap(Err("x".into()), Some(discovered("srv"))).unwrap()).unwrap();
        assert_eq!(v["jmapSessionUrl"], "https://jmap.example.test:8443/jmap/session");
        assert_eq!(v["jmapNeedsHostConfirmation"], false);
        assert_eq!(v["jmapHost"], "jmap.example.test:8443");
        assert_eq!(v["jmapSource"], "srv");
        assert!(v["imapHost"].is_null());
    }

    #[test]
    fn warnings_mx_none_no_mx_warning() {
        // Undecidable MX (no hint / no records) must not emit the MX warning.
        let w = build_warnings(None, true, true, true, 16);
        assert!(w.is_empty());
    }
}
