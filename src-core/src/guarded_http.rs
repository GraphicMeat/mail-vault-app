//! The SSRF gate for a request to a URL that came from mail or a page (export mirrors, BIMI
//! logos, one-click unsubscribe on desktop and phone): http(s) only, no credentials in the URL,
//! no literal or resolved address in a loopback, private, link-local, metadata or multicast range,
//! and every redirect hop checked again by hand. Moved here from the daemon's `export_fetch` so the
//! phone engine sends through the same gate.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

const MAX_REDIRECTS: usize = 3;

/// True for loopback/private/link-local/unspecified/multicast/broadcast
/// addresses and known cloud metadata endpoints (169.254.169.254 and its
/// IPv6 equivalents) — anything a server-side fetch must not reach.
pub fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

/// Reserved v6 ranges, plus every form that carries an IPv4 address the
/// network will reach (mapped, compatible, NAT64, 6to4), judged by that v4.
pub fn is_blocked_ipv6(v6: &Ipv6Addr) -> bool {
    let seg = v6.segments();
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if let Some(mapped) = v6.to_ipv4_mapped() {
        return is_blocked_ipv4(&mapped);
    }
    // IPv4-compatible ::a.b.c.d (also covers :: and ::1).
    if seg[..6].iter().all(|s| *s == 0) {
        return is_blocked_ipv4(&embedded(seg[6], seg[7]));
    }
    // NAT64 well-known prefix 64:ff9b::/96.
    if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_blocked_ipv4(&embedded(seg[6], seg[7]));
    }
    // 6to4 2002:a.b.c.d::/48.
    if seg[0] == 0x2002 {
        return is_blocked_ipv4(&embedded(seg[1], seg[2]));
    }
    v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast()
        || (seg[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
        || (seg[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (seg[0] & 0xffc0) == 0xfec0 // site-local fec0::/10
        || (seg[0] == 0x64 && seg[1] == 0xff9b && seg[2] == 1) // local-use NAT64 64:ff9b:1::/48
        || (seg[0] == 0x2001 && seg[1] == 0) // Teredo 2001::/32: tunnels to an address it hides
        || (seg[0] == 0x2001 && seg[1] == 0xdb8) // documentation 2001:db8::/32
        || seg[..4] == [0x100, 0, 0, 0] // discard-only 100::/64
}

pub fn is_blocked_ipv4(v4: &Ipv4Addr) -> bool {
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local() // covers 169.254.169.254
        || v4.is_unspecified()
        || v4.is_multicast()
        || v4.is_broadcast()
        || v4.is_documentation()
        || v4.octets()[0] == 0 // "this network" 0.0.0.0/8
        || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64) // shared/CGNAT 100.64.0.0/10
        || (v4.octets()[0] == 198 && (v4.octets()[1] & 0xfe) == 18) // benchmarking 198.18.0.0/15
        || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 0) // IETF protocol 192.0.0.0/24
        || v4.octets()[0] >= 240 // reserved 240.0.0.0/4 (and broadcast)
}

pub fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("bad url: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refused scheme: {}", parsed.scheme()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("refused: credentials in url".into());
    }
    // A literal IP in the URL bypasses DNS entirely, so reject reserved
    // ranges here before any lookup happens.
    if let Some(url::Host::Ipv4(v4)) = parsed.host() {
        if is_blocked_ipv4(&v4) {
            return Err("refused: blocked ip literal".into());
        }
    }
    if let Some(url::Host::Ipv6(v6)) = parsed.host() {
        if is_blocked_ip(&IpAddr::V6(v6)) {
            return Err("refused: blocked ip literal".into());
        }
    }
    Ok(parsed)
}

/// Resolve a redirect `Location` header against the URL it came from and
/// re-run every static check `validate_url` runs on the original URL. Split
/// out from the redirect loop (and kept synchronous) so it can be unit
/// tested directly, without needing a real server to drive a real redirect.
pub fn validate_redirect_target(base: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let next = base.join(location).map_err(|e| format!("bad redirect: {}", e))?;
    if !matches!(next.scheme(), "http" | "https") {
        return Err(format!("refused redirect scheme: {}", next.scheme()));
    }
    if !next.username().is_empty() || next.password().is_some() {
        return Err("refused: credentials in redirect url".into());
    }
    validate_url(next.as_str())
}

/// Resolve the URL's host and reject it if any resolved address is blocked.
/// This is the SSRF gate: scheme/credential checks alone don't stop a
/// hostname (or an open-redirect hop) from resolving to loopback, a private
/// range, link-local, or a cloud metadata address. Returns the checked
/// addresses: the request must connect to exactly these (`hop_client`), or a
/// second lookup could rebind the host to a blocked address after the check.
pub async fn validate_resolved(parsed: &reqwest::Url) -> Result<Vec<SocketAddr>, String> {
    let host = parsed.host_str().ok_or_else(|| "refused: no host".to_string())?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("dns lookup failed: {}", e))?;
    let addrs: Vec<SocketAddr> = addrs.collect();
    for addr in &addrs {
        if is_blocked_ip(&addr.ip()) {
            return Err(format!("refused: {} resolves to blocked address {}", host, addr.ip()));
        }
    }
    if addrs.is_empty() {
        return Err("refused: host resolved to no addresses".into());
    }
    Ok(addrs)
}

/// Send one request through the SSRF gate, following up to `MAX_REDIRECTS`
/// redirects by hand. Also the transport for one-click unsubscribe and BIMI
/// logos (`handlers::unsubscribe`), which pass `https_only` so no hop may
/// drop to plain http.
///
/// Redirects are followed manually (Policy::none()) so each hop's resolved
/// address can be re-checked: reqwest's built-in redirect policy runs
/// synchronously and can't do the async DNS lookup an SSRF check needs, so a
/// hop could otherwise land on a blocked address. `build` makes the request
/// for each hop. reqwest is built here without the `cookies` feature, so the
/// client has no cookie store: nothing sent carries the user's session.
pub async fn send_guarded(
    url: &str,
    purpose: &str,
    timeout: Duration,
    https_only: bool,
    build: impl Fn(&reqwest::Client, reqwest::Url) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let scheme_ok = |u: &reqwest::Url| {
        if https_only && u.scheme() != "https" {
            Err(format!("refused scheme: {}", u.scheme()))
        } else {
            Ok(())
        }
    };
    let mut parsed = validate_url(url)?;
    scheme_ok(&parsed)?;
    let mut addrs = validate_resolved(&parsed).await?;

    let mut redirects = 0;
    loop {
        // A client per hop, pinned to the addresses just checked for that hop's host.
        let client = hop_client(purpose, timeout, &parsed, &addrs);
        let response = client
            .send(build(&client, parsed.clone()).header(reqwest::header::REFERER, ""))
            .await
            .map_err(|e| format!("fetch failed: {}", e))?;

        if !response.status().is_redirection() {
            return Ok(response);
        }
        redirects += 1;
        if redirects > MAX_REDIRECTS {
            return Err("too many redirects".into());
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "redirect with no location".to_string())?;
        let next = validate_redirect_target(&parsed, location)?;
        scheme_ok(&next)?;
        addrs = validate_resolved(&next).await?;
        parsed = next;
    }
}

/// The client for one hop: no redirects, and the URL's host pinned to the
/// addresses `validate_resolved` checked, so the connection never does a
/// lookup of its own (no DNS-rebinding window). An IP-literal host needs no
/// pin: there is no lookup to rebind.
pub(crate) fn hop_client(purpose: &str, timeout: Duration, url: &reqwest::Url, addrs: &[SocketAddr]) -> crate::net_activity::Tracked {
    let mut builder = reqwest::Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none());
    if let Some(url::Host::Domain(host)) = url.host() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    crate::net_activity::http_client_with(purpose, builder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    fn blocked(s: &str) -> bool {
        is_blocked_ip(&s.parse().unwrap())
    }

    #[test]
    fn blocks_shared_benchmark_reserved_and_this_network_v4() {
        for a in ["0.1.2.3", "100.64.0.1", "100.127.255.254", "198.18.0.1", "198.19.255.1", "240.0.0.1", "192.0.0.8"] {
            assert!(blocked(a), "{a} should be blocked");
        }
        for a in ["100.63.255.255", "100.128.0.1", "198.20.0.1", "93.184.216.34", "1.1.1.1"] {
            assert!(!blocked(a), "{a} should be allowed");
        }
    }

    #[test]
    fn blocks_v6_forms_that_carry_a_blocked_v4_or_are_reserved() {
        for a in [
            "fec0::1",              // site-local
            "::127.0.0.1",          // IPv4-compatible loopback
            "::10.0.0.1",           // IPv4-compatible private
            "64:ff9b::7f00:1",      // NAT64 of 127.0.0.1
            "64:ff9b::a9fe:a9fe",   // NAT64 of 169.254.169.254
            "64:ff9b:1::1",         // local-use NAT64
            "2002:7f00:1::1",       // 6to4 of 127.0.0.1
            "2002:c0a8:101::1",     // 6to4 of 192.168.1.1
            "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
            "100::1",               // discard-only
            "2001:db8::1",          // documentation
        ] {
            assert!(blocked(a), "{a} should be blocked");
        }
        for a in ["64:ff9b::5db8:d822", "2002:5db8:d822::1", "2606:2800:220:1:248:1893:25c8:1946"] {
            assert!(!blocked(a), "{a} should be allowed");
        }
    }

    #[tokio::test]
    async fn validate_resolved_returns_the_addresses_it_checked() {
        let url = reqwest::Url::parse("http://93.184.216.34:8080/x").unwrap();
        let addrs = validate_resolved(&url).await.unwrap();
        assert_eq!(addrs, vec!["93.184.216.34:8080".parse::<SocketAddr>().unwrap()]);
    }

    // The hop client must connect to the addresses the gate checked, never
    // look the host up again: `.invalid` never resolves, so this request only
    // succeeds if the connection goes to the pinned listener.
    #[tokio::test]
    async fn hop_client_connects_to_the_pinned_address_without_a_second_lookup() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let _ = s.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n").await;
        });
        let url = reqwest::Url::parse(&format!("http://pinned.invalid:{}/x", addr.port())).unwrap();
        let client = hop_client("test", Duration::from_secs(5), &url, &[addr]);
        let resp = client.send(client.get(url.clone())).await.expect("pinned connect");
        assert_eq!(resp.status().as_u16(), 204);
    }
}
