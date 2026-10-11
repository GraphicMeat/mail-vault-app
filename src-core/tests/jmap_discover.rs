// src-core/tests/jmap_discover.rs
//! JMAP autodiscovery (`jmap::discover`) and its merge into
//! `dns::resolve_email_settings_with`, over a fake resolver and either a
//! scripted fetcher or the loopback mock behind a host-mapping fetcher.
use futures::future::BoxFuture;
use mailvault_core::dns::{resolve_email_settings_with, MxRecord, Resolver, SrvRecord};
use mailvault_core::jmap::discover::{discover_with, host_is_trusted, Fetch, FetchReply, PROBE_TIMEOUT};
use mock_jmap::MockJmap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
mod common_jmap; // tests/common_jmap/mod.rs: scenario() calls base::allow_loopback_for_tests()

const FASTMAIL: &str = "https://api.fastmail.com/jmap/session";

/// DNS answers by name; any other name is NXDOMAIN.
#[derive(Default)]
struct FakeDns {
    mx: HashMap<String, Vec<MxRecord>>,
    srv: HashMap<String, Vec<SrvRecord>>,
}

impl FakeDns {
    fn with_mx(mut self, domain: &str, exchange: &str) -> Self {
        self.mx.entry(domain.into()).or_default().push(MxRecord { preference: 10, exchange: exchange.into() });
        self
    }
    fn with_srv(mut self, name: &str, target: &str, port: u16) -> Self {
        self.srv.entry(name.into()).or_default().push(SrvRecord { priority: 10, weight: 0, port, target: target.into() });
        self
    }
}

impl Resolver for FakeDns {
    fn mx<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<Vec<MxRecord>, String>> {
        let out = self.mx.get(domain).cloned().ok_or_else(|| "NXDOMAIN".to_string());
        Box::pin(async move { out })
    }
    fn srv<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<SrvRecord>, String>> {
        let out = self.srv.get(name).cloned().ok_or_else(|| "NXDOMAIN".to_string());
        Box::pin(async move { out })
    }
}

/// Canned replies by exact URL; any other URL fails to connect. Records every
/// URL asked for.
#[derive(Default)]
struct Scripted {
    routes: HashMap<String, FetchReply>,
    seen: Mutex<Vec<String>>,
}

impl Scripted {
    fn route(mut self, url: &str, reply: FetchReply) -> Self {
        self.routes.insert(url.into(), reply);
        self
    }
    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

impl Fetch for Scripted {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchReply, String>> {
        self.seen.lock().unwrap().push(url.to_string());
        let out = self.routes.get(url).cloned().ok_or_else(|| "connection refused".to_string());
        Box::pin(async move { out })
    }
}

fn redirect(to: &str) -> FetchReply {
    FetchReply { status: 301, location: Some(to.into()), ..Default::default() }
}

/// 401 with `WWW-Authenticate`.
fn challenge() -> FetchReply {
    FetchReply { status: 401, www_authenticate: true, ..Default::default() }
}

fn ok(body: &str) -> FetchReply {
    FetchReply { status: 200, body: body.as_bytes().to_vec(), ..Default::default() }
}

/// A preset must answer without a single HTTP request.
struct NoFetch;

impl Fetch for NoFetch {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchReply, String>> {
        panic!("a preset must not probe, but fetched {url}")
    }
}

/// Every request hangs for a minute.
#[derive(Default)]
struct Slow {
    calls: AtomicUsize,
}

impl Fetch for Slow {
    fn get<'a>(&'a self, _url: &'a str) -> BoxFuture<'a, Result<FetchReply, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Err("hung".to_string())
        })
    }
}

/// Sends `https://<authority>/path` to the loopback mock mapped to that
/// authority (plain http, no redirects followed), and maps a `Location` on
/// the mock's own base back onto `https://<authority>`, so discovery sees the
/// logical https host throughout. An unmapped authority fails to connect.
struct ToMock {
    hosts: HashMap<String, String>,
    client: reqwest::Client,
}

impl ToMock {
    fn new(routes: &[(&str, &MockJmap)]) -> Self {
        ToMock {
            hosts: routes.iter().map(|(authority, m)| (authority.to_string(), m.base_url())).collect(),
            client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(),
        }
    }
}

impl Fetch for ToMock {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchReply, String>> {
        Box::pin(async move {
            let u = url::Url::parse(url).map_err(|e| e.to_string())?;
            assert_eq!(u.scheme(), "https", "discovery fetched a non-https URL: {url}");
            let host = u.host_str().unwrap_or_default();
            let authority = match u.port() {
                Some(p) => format!("{host}:{p}"),
                None => host.to_string(),
            };
            let Some(base) = self.hosts.get(&authority) else {
                return Err(format!("no route to {authority}"));
            };
            let target = format!("{base}{}", &u[url::Position::BeforePath..]);
            let resp = self.client.get(target).send().await.map_err(|e| e.to_string())?;
            let status = resp.status().as_u16();
            let location = resp.headers().get("location").and_then(|v| v.to_str().ok()).map(|l| match l.strip_prefix(base.as_str()) {
                Some(rest) => format!("https://{authority}{rest}"),
                None => l.to_string(),
            });
            let www_authenticate = resp.headers().contains_key("www-authenticate");
            let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
            Ok(FetchReply { status, location, www_authenticate, body })
        })
    }
}

#[tokio::test]
async fn fastmail_domain_is_preset_and_trusted() {
    for email in ["alice@fastmail.com", "bob@FastMail.FM", "carol@messagingengine.com"] {
        let d = discover_with(email, &FakeDns::default(), &NoFetch).await.expect("preset");
        assert_eq!(d.source, "preset", "{email}");
        assert_eq!(d.session_url, FASTMAIL);
        assert_eq!(d.host, "api.fastmail.com");
        assert!(!d.needs_host_confirmation);
    }
}

#[test]
fn host_trust_rule() {
    assert!(host_is_trusted("example.com", "example.com"));
    assert!(host_is_trusted("example.com", "jmap.example.com"));
    assert!(!host_is_trusted("example.com", "example.com.evil.net"));
    assert!(!host_is_trusted("example.com", "mail.other.net"));
    assert!(host_is_trusted("fastmail.fm", "api.fastmail.com"));
    // Case and a trailing dot do not matter; a lookalike suffix does.
    assert!(host_is_trusted("Example.COM.", "JMAP.example.com"));
    assert!(!host_is_trusted("example.com", "notexample.com"));
    // Fastmail's API host is trusted for Fastmail's own domains only.
    assert!(!host_is_trusted("example.com", "api.fastmail.com"));
    assert!(!host_is_trusted("", "example.com"));
}

#[tokio::test]
async fn srv_pointing_off_domain_needs_confirmation() {
    let m = MockJmap::start(common_jmap::scenario());
    let dns = FakeDns::default().with_srv("_jmap._tcp.example.test", "mail.other.net", 8443);
    let fetch = ToMock::new(&[("mail.other.net:8443", &m)]);
    let d = discover_with("bob@example.test", &dns, &fetch).await.expect("srv hit");
    assert_eq!(d.source, "srv");
    // The final URL after the mock's redirect, with the SRV port kept.
    assert_eq!(d.session_url, "https://mail.other.net:8443/jmap/session");
    assert_eq!(d.host, "mail.other.net:8443");
    assert!(d.needs_host_confirmation);
    let reqs = m.requests();
    assert_eq!(reqs.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), ["/.well-known/jmap", "/jmap/session"]);
    assert!(reqs.iter().all(|r| r.authorization.is_none()), "discovery must never send credentials");
}

#[tokio::test]
async fn plain_http_redirect_is_rejected() {
    let fetch = Scripted::default()
        .route("https://example.test/.well-known/jmap", redirect("http://example.test/jmap/session"))
        .route("http://example.test/jmap/session", challenge())
        .route("https://jmap.example.test/.well-known/jmap", redirect("http://jmap.example.test/jmap"))
        .route("http://jmap.example.test/jmap", challenge());
    assert_eq!(discover_with("bob@example.test", &FakeDns::default(), &fetch).await, None);
    let seen = fetch.seen();
    assert!(seen.contains(&"https://example.test/.well-known/jmap".to_string()));
    assert!(seen.iter().all(|u| u.starts_with("https://")), "followed a plain-http redirect: {seen:?}");
}

#[tokio::test]
async fn bare_basic_auth_401_is_not_jmap() {
    let fetch = Scripted::default()
        .route("https://example.test/.well-known/jmap", redirect("/admin"))
        .route("https://example.test/admin", challenge())
        // A 401 on the right path without WWW-Authenticate is not a challenge either.
        .route("https://jmap.example.test/.well-known/jmap", FetchReply { status: 401, ..Default::default() });
    assert_eq!(discover_with("bob@example.test", &FakeDns::default(), &fetch).await, None);
    assert!(fetch.seen().contains(&"https://example.test/admin".to_string()));
}

#[tokio::test]
async fn fastmail_custom_domain_via_mx_is_trusted() {
    let dns = FakeDns::default().with_mx("example.test", "in1-smtp.messagingengine.com");
    // The domain answers well-known too: the preset still wins.
    let fetch = Scripted::default().route("https://example.test/.well-known/jmap", challenge());
    let d = discover_with("bob@example.test", &dns, &fetch).await.expect("preset by MX");
    assert_eq!(d.source, "preset");
    assert_eq!(d.session_url, FASTMAIL);
    assert_eq!(d.host, "api.fastmail.com");
    assert!(!d.needs_host_confirmation);
}

#[tokio::test]
async fn imap_cascade_result_is_kept_alongside_jmap() {
    let m = MockJmap::start(common_jmap::scenario());
    let dns = FakeDns::default()
        .with_srv("_imaps._tcp.example.test", "imap.example.test", 993)
        .with_srv("_submission._tcp.example.test", "smtp.example.test", 587);
    let fetch = ToMock::new(&[("example.test", &m)]);
    let s = resolve_email_settings_with("example.test", &dns, &fetch).await.expect("settings");
    assert_eq!(s.source, "srv");
    assert_eq!((s.imap_host.as_deref(), s.imap_port), (Some("imap.example.test"), Some(993)));
    assert_eq!((s.smtp_host.as_deref(), s.smtp_port), (Some("smtp.example.test"), Some(587)));
    assert_eq!(s.jmap_session_url.as_deref(), Some("https://example.test/jmap/session"));
    assert_eq!(s.jmap_host.as_deref(), Some("example.test"));
    assert_eq!(s.jmap_source.as_deref(), Some("well-known"));
    assert!(!s.jmap_needs_host_confirmation);
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v["imapHost"], "imap.example.test");
    assert_eq!(v["jmapSessionUrl"], "https://example.test/jmap/session");
    assert_eq!(v["jmapNeedsHostConfirmation"], false);
    assert!(m.requests().iter().all(|r| r.authorization.is_none()), "discovery must never send credentials");
}

#[tokio::test]
async fn slow_probe_does_not_delay_the_imap_result() {
    let dns = FakeDns::default()
        .with_srv("_imaps._tcp.slow.test", "imap.slow.test", 993)
        .with_srv("_jmap._tcp.slow.test", "jmap.slow.test", 443);
    let fetch = Slow::default();
    let started = Instant::now();
    let s = resolve_email_settings_with("slow.test", &dns, &fetch).await.expect("settings");
    let elapsed = started.elapsed();
    assert_eq!(s.imap_host.as_deref(), Some("imap.slow.test"));
    assert_eq!(s.jmap_session_url, None);
    // Apex, jmap. and SRV probes all started and all hung.
    assert_eq!(fetch.calls.load(Ordering::SeqCst), 3);
    assert!(
        elapsed < PROBE_TIMEOUT + Duration::from_secs(1),
        "IMAP result waited {elapsed:?} on a hung JMAP probe"
    );
}

#[tokio::test]
async fn redirect_onto_a_subdomain_stays_trusted_and_shows_its_port() {
    let fetch = Scripted::default()
        .route("https://example.test/.well-known/jmap", redirect("https://jmap.example.test:8443/jmap/session"))
        .route("https://jmap.example.test:8443/jmap/session", challenge());
    let d = discover_with("bob@example.test", &FakeDns::default(), &fetch).await.expect("well-known hit");
    assert_eq!(d.source, "well-known");
    assert_eq!(d.session_url, "https://jmap.example.test:8443/jmap/session");
    assert_eq!(d.host, "jmap.example.test:8443");
    assert!(!d.needs_host_confirmation);
}

#[tokio::test]
async fn redirect_off_domain_needs_confirmation() {
    let fetch = Scripted::default()
        .route("https://example.test/.well-known/jmap", redirect("https://jmap.host.example/jmap/session"))
        .route("https://jmap.host.example/jmap/session", challenge());
    let d = discover_with("bob@example.test", &FakeDns::default(), &fetch).await.expect("well-known hit");
    assert_eq!(d.source, "well-known");
    assert_eq!(d.session_url, "https://jmap.host.example/jmap/session");
    assert_eq!(d.host, "jmap.host.example");
    assert!(d.needs_host_confirmation);
}

#[tokio::test]
async fn redirect_chain_is_capped_at_five_hops() {
    fn chain(hops: usize) -> Scripted {
        let mut f = Scripted::default();
        for i in 0..hops {
            let from = if i == 0 {
                "https://example.test/.well-known/jmap".to_string()
            } else {
                format!("https://example.test/hop{i}/jmap")
            };
            f = f.route(&from, redirect(&format!("/hop{}/jmap", i + 1)));
        }
        f.route(&format!("https://example.test/hop{hops}/jmap"), challenge())
    }
    let d = discover_with("bob@example.test", &FakeDns::default(), &chain(5)).await.expect("five hops");
    assert_eq!(d.session_url, "https://example.test/hop5/jmap");
    assert_eq!(discover_with("bob@example.test", &FakeDns::default(), &chain(6)).await, None);
}

#[tokio::test]
async fn session_json_is_a_hit_html_is_not_and_the_domain_outranks_srv() {
    let html = Scripted::default().route("https://example.test/.well-known/jmap", ok("<html>welcome</html>"));
    assert_eq!(discover_with("bob@example.test", &FakeDns::default(), &html).await, None);

    let session = r#"{"apiUrl":"https://jmap.example.test/api/","capabilities":{}}"#;
    let dns = FakeDns::default().with_srv("_jmap._tcp.example.test", "jmap.srv.example", 443);
    let fetch = Scripted::default()
        .route("https://example.test/.well-known/jmap", ok("<html>welcome</html>"))
        .route("https://jmap.example.test/.well-known/jmap", ok(session))
        .route("https://jmap.srv.example/.well-known/jmap", ok(session));
    let d = discover_with("bob@example.test", &dns, &fetch).await.expect("well-known hit");
    assert_eq!(d.source, "well-known");
    assert_eq!(d.session_url, "https://jmap.example.test/.well-known/jmap");
    assert_eq!(d.host, "jmap.example.test");
    assert!(!d.needs_host_confirmation);
}
