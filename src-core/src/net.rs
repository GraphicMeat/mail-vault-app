//! Internet reachability — one probe, shared by the daemon's connectivity gate
//! and the Tauri `check_network_connectivity` command.
//!
//! Nothing here blocks a thread: the dials are `tokio::net` futures under a
//! timeout, and all three run concurrently, so a probe costs one timeout rather
//! than three.

use crate::net_activity::{NetEvent, Pending, Protocol};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Well-known resolvers, dialled on the DNS port. Three independent operators:
/// one being down proves nothing, all three being unreachable is the host.
pub const PROBE_HOSTS: [(&str, u16); 3] = [
    ("8.8.8.8", 53),        // Google
    ("1.1.1.1", 53),        // Cloudflare
    ("208.67.222.222", 53), // OpenDNS
];

/// Per-dial cap. Short on purpose — this runs on the failure path of a sync
/// that already stalled, so the answer has to arrive before the next tick.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// True when at least one probe host completes a TCP handshake.
///
/// A handshake, not a DNS lookup: a captive portal that resolves everything
/// still refuses port 53 to an address it does not own. It is not proof of a
/// working *mail* path — no probe is — only that packets leave the machine.
///
/// Every dial is a Network Activity event, the ones cut short by the first
/// answer included ("cancelled").
pub async fn probe_internet() -> bool {
    let dials = PROBE_HOSTS
        .iter()
        .map(|(host, port)| {
            Box::pin(async move {
                let addr: SocketAddr = format!("{}:{}", host, port).parse().map_err(|_| ())?;
                let mut ev = NetEvent::out(Protocol::TcpProbe, host, *port, "connectivity check");
                ev.ip = Some(host.to_string());
                let mut dial = Pending::new(ev);
                let (result, out) = match timeout(PROBE_TIMEOUT, TcpStream::connect(addr)).await {
                    Ok(Ok(_stream)) => ("ok".to_string(), Ok(())),
                    Ok(Err(e)) => (e.to_string(), Err(())),
                    Err(_) => (format!("timed out after {}ms", PROBE_TIMEOUT.as_millis()), Err(())),
                };
                dial.ev.result = result;
                out
            })
        })
        .collect::<Vec<_>>();

    futures::future::select_ok(dials).await.is_ok()
}

/// Whether an error string is *shaped* like the network being down.
///
/// Deliberately generous, and deliberately not the decision: a true answer only
/// buys a `probe_internet()` call, and the probe is what settles it. That is
/// what keeps this list from having to be right — a provider outage that reads
/// as "connection refused" costs one 1.5s dial and no gate change.
///
/// Everything here is raised before or during connect, never by a server that
/// answered: a tagged `NO`/`BAD` means the network is fine.
pub fn looks_like_network_down(err: &str) -> bool {
    const NEEDLES: [&str; 12] = [
        "tcp connect to",          // imap::connect_transport's own wrapper
        "tls handshake with",      // handshake died before any IMAP byte
        "no ipv4 address found",   // resolver answered with nothing
        "failed to lookup address",
        "nodename nor servname",   // macOS getaddrinfo
        "temporary failure in name resolution", // glibc
        "network is unreachable",
        "network is down",
        "no route to host",
        "connection refused",
        "timed out",
        "operation timed out",
    ];
    let lowered = err.to_ascii_lowercase();
    NEEDLES.iter().any(|n| lowered.contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every probe host shows on Network Activity, whichever answered first.
    /// Other tests may probe too: this looks for each host since it started.
    #[tokio::test]
    async fn every_probe_dial_is_recorded() {
        let since = crate::net_activity::now_ms();
        let _ = probe_internet().await;
        let events = crate::net_activity::snapshot();
        for (host, port) in PROBE_HOSTS {
            let e = events
                .iter()
                .find(|e| e.at_ms >= since && e.protocol == Protocol::TcpProbe && e.host == host)
                .unwrap_or_else(|| panic!("no probe event for {host}: {events:?}"));
            assert_eq!(e.port, port);
            assert_eq!(e.purpose, "connectivity check");
            assert_eq!(e.ip.as_deref(), Some(host));
        }
    }

    #[test]
    fn connect_time_failures_are_network_shaped() {
        for err in [
            "TCP connect to imap.gmail.com:993 failed: operation timed out",
            "TLS handshake with imap.zoho.com failed: connection closed via error",
            "No IPv4 address found for imap.example.com",
            "Network is unreachable (os error 51)",
        ] {
            assert!(looks_like_network_down(err), "should suspect: {err}");
        }
    }

    #[test]
    fn a_server_that_answered_is_never_network_shaped() {
        // Tagged NO/BAD, auth rejections, missing mailboxes: the packets got
        // through, so gating sync on these would strand a perfectly online user.
        for err in [
            "NO [AUTHENTICATIONFAILED] Invalid credentials",
            "BAD Command Argument Error",
            "Mailbox does not exist",
            "Daily transfer limit reached",
        ] {
            assert!(!looks_like_network_down(err), "should NOT suspect: {err}");
        }
    }
}
