//! JMAP autodiscovery: which session URL an address's domain offers, and
//! whether the user must confirm its host before the first authenticated
//! request.
//!
//! No probe carries credentials. Steps, by priority:
//! 1. A known preset: the domain is Fastmail's, or its MX is
//!    `messagingengine.com` (a Fastmail custom domain).
//! 2. `https://<domain>/.well-known/jmap`.
//! 3. `https://jmap.<domain>/.well-known/jmap`.
//! 4. SRV `_jmap._tcp.<domain>` -> `https://<target>:<port>/.well-known/jmap`.
//!
//! Every step is bounded by `PROBE_TIMEOUT` and all four run concurrently,
//! so `discover` answers within about `PROBE_TIMEOUT` and never holds the
//! IMAP result back for longer (`dns::resolve_email_settings_with`). The
//! winner is picked by the priority above, not by which step finished first.
//!
//! An HTTP probe follows at most `MAX_REDIRECTS` redirects by hand, https
//! only. It succeeds on a 200 whose JSON body has `apiUrl`, or on a 401 with
//! `WWW-Authenticate` that the probe reached from `/.well-known/jmap` and
//! whose final path ends in `/jmap`, `/jmap/session` or `/.well-known/jmap`.
//! A bare 401 is not enough: any Basic-protected site answers that way.
//!
//! The session URL handed back is the FINAL URL, after redirects:
//! `JmapClient::connect` follows redirects only on its start URL's host, so
//! the starting well-known URL would make connect refuse the very hop the
//! user just confirmed (`JmapError::ForeignHost` names the host, not a URL).
//!
//! Host trust compares the hostname only, never the port, the same rule
//! `JmapClient::connect` applies to redirects. `Discovered::host` shows a
//! non-default port (`jmap.example.com:8443`), so the confirmation text names
//! exactly where the credentials will go.

use crate::dns::Resolver;
use crate::net_activity::{error_chain, http_client_with, Tracked};
use futures::future::BoxFuture;
use reqwest::header::{LOCATION, WWW_AUTHENTICATE};
use reqwest::redirect::Policy;
use serde_json::Value;
use std::time::Duration;
use url::Url;

/// Each step's bound: an HTTP probe with all its redirects, the MX lookup,
/// the SRV lookup plus its probe.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_REDIRECTS: usize = 5;
/// The most body a probe reads (a session object is a few kB).
const MAX_BODY: usize = 256 * 1024;
const WELL_KNOWN: &str = "/.well-known/jmap";

pub const FASTMAIL_SESSION_URL: &str = "https://api.fastmail.com/jmap/session";
pub const FASTMAIL_API_HOST: &str = "api.fastmail.com";
/// Fastmail's own address domains. Its many other personal domains are
/// found by MX, like a custom domain.
const FASTMAIL_DOMAINS: &[&str] = &["fastmail.com", "fastmail.fm", "messagingengine.com"];
/// MX hosts that mean "this domain's mail is at Fastmail".
const FASTMAIL_MX_DOMAINS: &[&str] = &["messagingengine.com", "fastmail.com"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovered {
    /// The session URL to connect to: the final URL after redirects.
    pub session_url: String,
    /// The session URL's host as the user should see it, with the port when
    /// it is not 443.
    pub host: String,
    pub needs_host_confirmation: bool,
    /// "preset", "well-known" or "srv".
    pub source: &'static str,
}

/// One unauthenticated GET that does not follow redirects.
#[derive(Debug, Clone, Default)]
pub struct FetchReply {
    pub status: u16,
    pub location: Option<String>,
    /// The response carried a `WWW-Authenticate` header.
    pub www_authenticate: bool,
    /// Read for a 200 only, at most `MAX_BODY` bytes.
    pub body: Vec<u8>,
}

/// The HTTP side of discovery, injectable for tests. An implementation sends
/// no credentials and follows no redirects: `discover_with` does that by hand.
pub trait Fetch: Send + Sync {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchReply, String>>;
}

/// The real `Fetch`: a tracked client (shown in Network Activity under the
/// purpose in scope), https only, redirects off, `PROBE_TIMEOUT` per request.
pub struct HttpFetch {
    client: Tracked,
}

impl HttpFetch {
    pub fn new() -> Self {
        let builder = reqwest::Client::builder().timeout(PROBE_TIMEOUT).redirect(Policy::none()).https_only(true);
        HttpFetch { client: http_client_with(crate::net_activity::purpose(), builder) }
    }
}

impl Default for HttpFetch {
    fn default() -> Self {
        Self::new()
    }
}

impl Fetch for HttpFetch {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchReply, String>> {
        Box::pin(async move {
            let mut resp = self
                .client
                .send(self.client.get(url))
                .await
                .map_err(|e| error_chain(&e.without_url()))?;
            let status = resp.status().as_u16();
            let location = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string);
            let www_authenticate = resp.headers().contains_key(WWW_AUTHENTICATE);
            let mut body = Vec::new();
            if status == 200 {
                while let Some(chunk) = resp.chunk().await.map_err(|e| error_chain(&e.without_url()))? {
                    body.extend_from_slice(&chunk);
                    if body.len() > MAX_BODY {
                        body.truncate(MAX_BODY);
                        break;
                    }
                }
            }
            Ok(FetchReply { status, location, www_authenticate, body })
        })
    }
}

/// Trimmed, lowercased, trailing dot dropped.
fn norm(name: &str) -> String {
    name.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// A plain DNS hostname: letters, digits, `-` and `.`, no empty label.
fn is_hostname(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

/// The domain of an address (the part after the last `@`), or `input`
/// itself when it is already a bare domain. `None` when it is not a hostname.
pub fn email_domain(input: &str) -> Option<String> {
    let raw = input.rsplit_once('@').map_or(input, |(_, d)| d);
    let d = norm(raw);
    is_hostname(&d).then_some(d)
}

fn is_fastmail_domain(domain: &str) -> bool {
    FASTMAIL_DOMAINS.contains(&domain)
}

fn is_fastmail_mx(host: &str) -> bool {
    let h = norm(host);
    FASTMAIL_MX_DOMAINS.iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

/// May credentials for an address at `email_domain` go to `host` without
/// asking? `host` is a bare hostname, no port. True for the domain itself,
/// any subdomain of it, and Fastmail's API host for Fastmail's own domains.
pub fn host_is_trusted(email_domain: &str, host: &str) -> bool {
    let d = norm(email_domain);
    let h = norm(host);
    if d.is_empty() || h.is_empty() {
        return false;
    }
    if h == d || h.ends_with(&format!(".{d}")) {
        return true;
    }
    is_fastmail_domain(&d) && h == FASTMAIL_API_HOST
}

/// The Fastmail preset: trusted by definition, whether the domain or its MX
/// named Fastmail.
pub fn fastmail_preset() -> Discovered {
    Discovered {
        session_url: FASTMAIL_SESSION_URL.to_string(),
        host: FASTMAIL_API_HOST.to_string(),
        needs_host_confirmation: false,
        source: "preset",
    }
}

fn is_jmap_path(path: &str) -> bool {
    let p = path.trim_end_matches('/');
    p.ends_with("/jmap") || p.ends_with("/jmap/session") || p.ends_with(WELL_KNOWN)
}

fn is_session_body(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body).ok().is_some_and(|v| v.get("apiUrl").is_some_and(Value::is_string))
}

/// One HTTP probe from `start`: the final URL when it answers like a JMAP
/// session resource, `None` otherwise.
async fn probe(fetch: &dyn Fetch, start: &str) -> Option<Url> {
    let mut url = Url::parse(start).ok()?;
    let from_well_known = url.path() == WELL_KNOWN;
    for _ in 0..=MAX_REDIRECTS {
        if url.scheme() != "https" {
            return None;
        }
        let reply = fetch.get(url.as_str()).await.ok()?;
        match reply.status {
            301 | 302 | 303 | 307 | 308 => {
                let mut next = url.join(reply.location.as_deref()?).ok()?;
                if next.scheme() != "https" || !next.username().is_empty() || next.password().is_some() {
                    return None;
                }
                next.set_fragment(None);
                url = next;
            }
            200 => return is_session_body(&reply.body).then_some(url),
            401 => return (reply.www_authenticate && from_well_known && is_jmap_path(url.path())).then_some(url),
            _ => return None,
        }
    }
    None
}

/// Step 4: the best `_jmap._tcp` target, then a probe of its well-known URL.
async fn srv_probe(resolver: &dyn Resolver, fetch: &dyn Fetch, domain: &str) -> Option<Url> {
    let mut targets = resolver.srv(&format!("_jmap._tcp.{domain}")).await.ok()?;
    targets.retain(|t| t.port != 0 && is_hostname(&norm(&t.target)));
    targets.sort_by_key(|t| (t.priority, std::cmp::Reverse(t.weight)));
    let t = targets.first()?;
    probe(fetch, &format!("https://{}:{}{WELL_KNOWN}", norm(&t.target), t.port)).await
}

/// Step 1 by MX: any exchange at Fastmail.
async fn mx_is_fastmail(resolver: &dyn Resolver, domain: &str) -> bool {
    resolver.mx(domain).await.is_ok_and(|mx| mx.iter().any(|m| is_fastmail_mx(&m.exchange)))
}

fn found(domain: &str, url: Url, source: &'static str) -> Discovered {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    // `Url::port` is None for the scheme's default (443).
    let shown = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    Discovered {
        session_url: url.to_string(),
        host: shown,
        needs_host_confirmation: !host_is_trusted(domain, &host),
        source,
    }
}

/// `discover` over an injected resolver and HTTP fetcher (tests).
/// `email` may also be a bare domain.
pub async fn discover_with(email: &str, resolver: &dyn Resolver, fetch: &dyn Fetch) -> Option<Discovered> {
    let domain = email_domain(email)?;
    if is_fastmail_domain(&domain) {
        return Some(fastmail_preset());
    }
    let apex = format!("https://{domain}{WELL_KNOWN}");
    let sub = format!("https://jmap.{domain}{WELL_KNOWN}");
    use futures::future::{select, Either};
    let mx = Box::pin(tokio::time::timeout(PROBE_TIMEOUT, mx_is_fastmail(resolver, &domain)));
    let probes = Box::pin(async {
        tokio::join!(
            tokio::time::timeout(PROBE_TIMEOUT, probe(fetch, &apex)),
            tokio::time::timeout(PROBE_TIMEOUT, probe(fetch, &sub)),
            tokio::time::timeout(PROBE_TIMEOUT, srv_probe(resolver, fetch, &domain)),
        )
    });
    // The MX check is raced against the HTTP probes: an MX at Fastmail is the
    // preset whatever the probes do, so it must not wait for a hung one (the
    // caller may give discovery only a short grace).
    let (fastmail, (apex, sub, srv)) = match select(mx, probes).await {
        Either::Left((mx, probes)) => {
            if mx.unwrap_or(false) {
                return Some(fastmail_preset());
            }
            (false, probes.await)
        }
        Either::Right((probes, mx)) => (mx.await.unwrap_or(false), probes),
    };
    if fastmail {
        return Some(fastmail_preset());
    }
    if let Some(url) = apex.ok().flatten().or_else(|| sub.ok().flatten()) {
        return Some(found(&domain, url, "well-known"));
    }
    srv.ok().flatten().map(|url| found(&domain, url, "srv"))
}

/// The JMAP session an address's domain offers, if any, over the system
/// resolver and real https. `email` may also be a bare domain.
pub async fn discover(email: &str) -> Option<Discovered> {
    let resolver = crate::dns::SystemResolver::new().ok()?;
    discover_with(email, &resolver, &HttpFetch::new()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_domain_takes_the_last_at_and_rejects_non_hostnames() {
        assert_eq!(email_domain("Alice@Example.COM.").as_deref(), Some("example.com"));
        assert_eq!(email_domain("example.com").as_deref(), Some("example.com"));
        assert_eq!(email_domain("a@b@example.com").as_deref(), Some("example.com"));
        assert_eq!(email_domain("alice@"), None);
        assert_eq!(email_domain("alice@evil.com/x"), None);
        assert_eq!(email_domain("alice@exa mple.com"), None);
        assert_eq!(email_domain("alice@a..b"), None);
    }

    #[test]
    fn jmap_paths_are_the_three_session_shapes() {
        assert!(is_jmap_path("/jmap"));
        assert!(is_jmap_path("/jmap/session/"));
        assert!(is_jmap_path("/.well-known/jmap"));
        assert!(!is_jmap_path("/admin"));
        assert!(!is_jmap_path("/"));
    }

    #[test]
    fn fastmail_mx_match_is_a_suffix_not_a_substring() {
        assert!(is_fastmail_mx("in1-smtp.messagingengine.com."));
        assert!(is_fastmail_mx("messagingengine.com"));
        assert!(!is_fastmail_mx("messagingengine.com.evil.net"));
        assert!(!is_fastmail_mx("notmessagingengine.com"));
    }
}
