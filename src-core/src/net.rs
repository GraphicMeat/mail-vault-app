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
    probe(&PROBE_HOSTS).await
}

/// `probe_internet` against `hosts`, so a test can dial loopback instead.
async fn probe(hosts: &[(&str, u16)]) -> bool {
    let dials = hosts
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

    fn dial_on(port: u16) -> crate::net_activity::NetEvent {
        crate::net_activity::snapshot()
            .into_iter()
            .find(|e| e.protocol == Protocol::TcpProbe && e.host == "127.0.0.1" && e.port == port)
            .unwrap_or_else(|| panic!("no probe event for port {port}"))
    }

    /// Every dial is on Network Activity. Loopback only: a unit test must not
    /// dial the public resolvers `PROBE_HOSTS` names.
    #[tokio::test]
    async fn a_dial_that_connects_is_recorded_ok() {
        let open = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = open.local_addr().unwrap().port();
        assert!(probe(&[("127.0.0.1", port)]).await, "a listening port answers");
        let e = dial_on(port);
        assert_eq!(e.result, "ok");
        assert_eq!(e.purpose, "connectivity check");
        assert_eq!(e.ip.as_deref(), Some("127.0.0.1"));
    }

    #[tokio::test]
    async fn a_refused_dial_is_recorded_as_failed() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(!probe(&[("127.0.0.1", port)]).await, "nothing listens there any more");
        let e = dial_on(port);
        assert_ne!(e.result, "ok");
        assert_ne!(e.result, "cancelled", "a dial that finished says how");
        assert_eq!(e.purpose, "connectivity check");
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
