//! Internet reachability — one probe, shared by the daemon's connectivity gate
//! and the Tauri `check_network_connectivity` command.
//!
//! Nothing here blocks a thread: the dials are `tokio::net` futures under a
//! timeout, and all of them run concurrently, so a probe costs one timeout
//! rather than one per host.

use crate::net_activity::{NetEvent, Pending, Protocol};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Well-known resolvers. Three independent operators: one being down proves
/// nothing, all of them being unreachable is the host.
///
/// Each is dialled on the DNS port, and two of them on 443 as well: many
/// corporate firewalls, VPNs and ISPs block outbound TCP 53, and on such a
/// network the DNS port alone read as "no internet" on a machine that was
/// online. 443 is almost never blocked.
pub const PROBE_HOSTS: [(&str, u16); 5] = [
    ("8.8.8.8", 53),        // Google
    ("1.1.1.1", 53),        // Cloudflare
    ("208.67.222.222", 53), // OpenDNS
    ("1.1.1.1", 443),       // Cloudflare, HTTPS port
    ("8.8.8.8", 443),       // Google, HTTPS port
];

/// Per-dial cap. Short on purpose — this runs on the failure path of a sync
/// that already stalled, so the answer has to arrive before the next tick.
/// A host name's lookup runs inside it too.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

const PURPOSE: &str = "connectivity check";

/// True when at least one probe host completes a TCP handshake.
///
/// A handshake, not a DNS lookup: a captive portal that resolves everything
/// still refuses a connection to an address it does not own. It is not proof
/// of a working *mail* path — no probe is — only that packets leave the machine.
///
/// Every dial is a Network Activity event, the ones cut short by the first
/// answer included ("cancelled").
pub async fn probe_internet() -> bool {
    probe_internet_with(Vec::new()).await
}

/// `probe_internet`, dialling `extra` (the user's own mail servers) at the
/// same time as the resolvers. Any single answer is online.
///
/// Added to the resolvers, never instead of them: with mail hosts alone, a
/// user whose one provider is down would be told the internet is gone.
pub async fn probe_internet_with(extra: Vec<(String, u16)>) -> bool {
    let mut hosts: Vec<(String, u16)> = PROBE_HOSTS.iter().map(|(h, p)| (h.to_string(), *p)).collect();
    hosts.extend(extra);
    probe(&hosts).await
}

/// Dial every `(host, port)` at once; true as soon as one answers. A host is
/// an IP literal or a name, and a name is looked up inside the dial's own
/// timeout. Public so a test can dial loopback instead of the resolvers.
pub async fn probe(hosts: &[(String, u16)]) -> bool {
    // `select_ok` panics on an empty list.
    if hosts.is_empty() {
        return false;
    }
    let dials = hosts
        .iter()
        .map(|(host, port)| Box::pin(dial(host, *port)))
        .collect::<Vec<_>>();

    futures::future::select_ok(dials).await.is_ok()
}

/// One dial, recorded as one Network Activity event however it ends.
async fn dial(host: &str, port: u16) -> Result<(), ()> {
    let literal = host.parse::<IpAddr>().ok();
    let mut ev = NetEvent::out(Protocol::TcpProbe, host, port, PURPOSE);
    ev.ip = literal.map(|ip| ip.to_string());
    let mut record = Pending::new(ev);
    let connect = async {
        match literal {
            Some(ip) => TcpStream::connect(SocketAddr::new(ip, port)).await,
            None => match lookup(host, port).await {
                Ok(addrs) => TcpStream::connect(&addrs[..]).await,
                Err(e) => Err(e),
            },
        }
    };
    let (result, out) = match timeout(PROBE_TIMEOUT, connect).await {
        Ok(Ok(stream)) => {
            if let Ok(peer) = stream.peer_addr() {
                record.ev.ip = Some(peer.ip().to_string());
            }
            ("ok".to_string(), Ok(()))
        }
        Ok(Err(e)) => (e.to_string(), Err(())),
        Err(_) => (format!("timed out after {}ms", PROBE_TIMEOUT.as_millis()), Err(())),
    };
    record.ev.result = result;
    out
}

/// A host name's addresses, as a DNS event of its own like every other lookup
/// the app makes.
async fn lookup(host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
    let mut query = Pending::new(NetEvent::out(Protocol::Dns, host, 53, PURPOSE));
    let found = match tokio::net::lookup_host((host, port)).await {
        Ok(addrs) => {
            let addrs: Vec<SocketAddr> = addrs.collect();
            if addrs.is_empty() {
                Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("no address found for {host}")))
            } else {
                Ok(addrs)
            }
        }
        Err(e) => Err(e),
    };
    query.ev.ip = found.as_ref().ok().and_then(|a| a.first()).map(|a| a.ip().to_string());
    query.ev.result = match &found {
        Ok(_) => "ok".into(),
        Err(e) => e.to_string(),
    };
    found
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

/// What a failed connection ran into, in the terms the app words it for the
/// user, with the remedy that fits. The daemon classifies, the app only maps
/// `code()` to a catalog message: no error text is parsed in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionFailure {
    /// The server name did not resolve.
    Dns,
    /// Something answered and refused: the port is closed.
    Refused,
    /// Nothing answered in time, or there is no route: typical of a firewall,
    /// VPN or network filter dropping the port.
    BlockedOrTimeout,
    /// The TLS handshake or the certificate check failed.
    Tls,
    /// The server rejected the credentials.
    Auth,
    /// The provider is rate limiting this account.
    Throttled,
    /// This machine has no network at all.
    Offline,
    Other,
}

impl ConnectionFailure {
    /// The stable code the app matches on. Never rename one.
    pub fn code(self) -> &'static str {
        match self {
            Self::Dns => "dns",
            Self::Refused => "refused",
            Self::BlockedOrTimeout => "blocked_or_timeout",
            Self::Tls => "tls",
            Self::Auth => "auth",
            Self::Throttled => "throttled",
            Self::Offline => "offline",
            Self::Other => "other",
        }
    }
}

/// Classify a connection or sync error string.
///
/// Order matters. Server answers come first: a Gmail throttle arrives as
/// "Login failed ... Too many simultaneous connections", so throttled is
/// checked before auth, and any other tagged `NO`/`BAD` is the server talking,
/// never the network. A certificate complaint is TLS even though it surfaces
/// from the handshake. Windows words socket errors in the system language, so
/// the `(os error N)` codes are matched as well as the English text.
pub fn classify_connection_error(err: &str) -> ConnectionFailure {
    use ConnectionFailure::*;
    let lowered = err.to_ascii_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|n| lowered.contains(n));

    if any(&[
        "too many simultaneous",
        "too many connections",
        "too many requests",
        "daily transfer limit",
        "exceeded bandwidth",
        "bandwidth limit",
        "throttled",
        "rate limit",
        "try again later",
    ]) {
        return Throttled;
    }
    if any(&["authenticationfailed", "authentication failed", "invalid credentials", "login failed", "auth failed"]) {
        return Auth;
    }
    if is_tagged_answer(err) {
        return Other;
    }
    if any(&["certificate"]) {
        return Tls;
    }
    if any(&[
        "dns resolve failed",
        "no ipv4 address found",
        "failed to lookup address",
        "nodename nor servname",
        "temporary failure in name resolution",
        "name or service not known",
        "no such host is known",
        "could not resolve",
        "(os error 11001)", // WSAHOST_NOT_FOUND
    ]) {
        return Dns;
    }
    if any(&[
        "network is unreachable",
        "network is down",
        "no internet connection", // the daemon's own label for a shut gate
        "(os error 50)",          // macOS ENETDOWN
        "(os error 51)",          // macOS ENETUNREACH
        "(os error 100)",         // Linux ENETDOWN
        "(os error 101)",         // Linux ENETUNREACH
        "(os error 10050)",       // WSAENETDOWN
        "(os error 10051)",       // WSAENETUNREACH
    ]) {
        return Offline;
    }
    if any(&["connection refused", "(os error 61)", "(os error 111)", "(os error 10061)"]) {
        return Refused;
    }
    if any(&[
        "timed out",
        "timeout",
        "no route to host",
        "host is unreachable",
        "(os error 60)",    // macOS ETIMEDOUT
        "(os error 65)",    // macOS EHOSTUNREACH
        "(os error 110)",   // Linux ETIMEDOUT
        "(os error 113)",   // Linux EHOSTUNREACH
        "(os error 10060)", // WSAETIMEDOUT
        "(os error 10065)", // WSAEHOSTUNREACH
    ]) {
        return BlockedOrTimeout;
    }
    if any(&["tls handshake", "starttls", "handshake"]) {
        return Tls;
    }
    Other
}

/// An IMAP server's tagged `NO`/`BAD`, as the error text carries it. Case
/// sensitive on purpose: "No route to host" is not an answer.
fn is_tagged_answer(err: &str) -> bool {
    err.starts_with("NO ") || err.starts_with("BAD ") || err.contains(": NO ") || err.contains(": BAD ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dial_on(host: &str, port: u16) -> crate::net_activity::NetEvent {
        crate::net_activity::snapshot()
            .into_iter()
            .find(|e| e.protocol == Protocol::TcpProbe && e.host == host && e.port == port)
            .unwrap_or_else(|| panic!("no probe event for {host}:{port}"))
    }

    fn hosts(list: &[(&str, u16)]) -> Vec<(String, u16)> {
        list.iter().map(|(h, p)| (h.to_string(), *p)).collect()
    }

    /// Every dial is on Network Activity. Loopback only: a unit test must not
    /// dial the public resolvers `PROBE_HOSTS` names.
    #[tokio::test]
    async fn a_dial_that_connects_is_recorded_ok() {
        let open = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = open.local_addr().unwrap().port();
        assert!(probe(&hosts(&[("127.0.0.1", port)])).await, "a listening port answers");
        let e = dial_on("127.0.0.1", port);
        assert_eq!(e.result, "ok");
        assert_eq!(e.purpose, "connectivity check");
        assert_eq!(e.ip.as_deref(), Some("127.0.0.1"));
    }

    #[tokio::test]
    async fn a_refused_dial_is_recorded_as_failed() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(!probe(&hosts(&[("127.0.0.1", port)])).await, "nothing listens there any more");
        let e = dial_on("127.0.0.1", port);
        assert_ne!(e.result, "ok");
        assert_ne!(e.result, "cancelled", "a dial that finished says how");
        assert_eq!(e.purpose, "connectivity check");
    }

    /// A mail server is a name, not an address. "imap.gmail.com:993" never
    /// parsed as a socket address, so before names were looked up such a host
    /// reported "failed" without a packet being sent.
    #[tokio::test]
    async fn a_host_name_is_looked_up_and_dialled() {
        let open = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = open.local_addr().unwrap().port();
        assert!(probe(&hosts(&[("localhost", port)])).await, "localhost resolves and answers");
        let e = dial_on("localhost", port);
        assert_eq!(e.result, "ok");
        assert_eq!(e.purpose, "connectivity check");
        // ::1 or 127.0.0.1, whichever the resolver put first and answered.
        assert!(e.ip.is_some(), "the address the name resolved to is recorded");
    }

    /// The resolvers and the mail hosts race: one answer anywhere is online,
    /// which is what lets a network that blocks one port still read as online.
    #[tokio::test]
    async fn one_answer_among_several_hosts_is_online() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let open = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = open.local_addr().unwrap().port();
        assert!(probe(&hosts(&[("127.0.0.1", closed), ("localhost", port)])).await);
    }

    #[tokio::test]
    async fn nothing_to_dial_is_not_online() {
        assert!(!probe(&[]).await);
    }

    #[test]
    fn the_resolvers_are_also_dialled_on_the_https_port() {
        // TCP 53 is blocked on many corporate networks and VPNs.
        assert!(PROBE_HOSTS.iter().filter(|(_, p)| *p == 443).count() >= 2);
        assert!(PROBE_HOSTS.iter().filter(|(_, p)| *p == 53).count() >= 3);
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

    /// The strings the daemon really produces (imap, smtp, the gate), each
    /// with what it tells the user to do.
    #[test]
    fn connection_failures_are_classified_by_what_failed() {
        use ConnectionFailure::*;
        for (err, want) in [
            ("DNS resolve failed for imap.zoho.com:993: nodename nor servname provided, or not known", Dns),
            ("No IPv4 address found for imap.example.com", Dns),
            ("Connection test failed: failed to lookup address information: nodename nor servname provided", Dns),
            ("Could not resolve SMTP host smtp.example.com.", Dns),
            ("TCP connect to imap.example.com:993 failed: Der Host ist unbekannt. (os error 11001)", Dns),
            ("TCP connect to imap.example.com:993 failed: Connection refused (os error 61)", Refused),
            ("TCP connect failed: connection refused", Refused),
            ("TCP connect to imap.example.com:993 failed: Es konnte keine Verbindung hergestellt werden (os error 10061)", Refused),
            ("TCP connect to imap.gmail.com:993 failed: operation timed out", BlockedOrTimeout),
            ("TCP connect to imap.example.com:993 failed: No route to host (os error 65)", BlockedOrTimeout),
            ("TCP connect to imap.example.com:993 failed: Ein Verbindungsversuch ist fehlgeschlagen (os error 10060)", BlockedOrTimeout),
            ("TLS handshake with imap.example.com failed: timed out after 15s", BlockedOrTimeout),
            ("Connection to smtp.example.com:587 timed out.", BlockedOrTimeout),
            ("Connection test timed out for me@example.com", BlockedOrTimeout),
            ("SMTP connection test timed out for me@example.com", BlockedOrTimeout),
            ("TLS handshake with imap.zoho.com failed: connection closed via error", Tls),
            ("TLS handshake with imap.example.com failed: invalid peer certificate: UnknownIssuer", Tls),
            ("Network is unreachable (os error 51)", Offline),
            ("TCP connect to imap.example.com:993 failed: Network is down (os error 50)", Offline),
            ("No internet connection", Offline),
            ("Login failed for user@example.com: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)", Auth),
            ("XOAUTH2 auth failed for user@example.com: NO Invalid credentials (Failure)", Auth),
            ("Authentication failed for smtp.example.com:587", Auth),
            ("Login failed for user@example.com: NO [ALERT] Too many simultaneous connections. (Failure)", Throttled),
            ("UID FETCH 42 failed: NO Account exceeded bandwidth limits. (Failure)", Throttled),
            ("BYE [THROTTLED] Too much traffic", Throttled),
            ("Daily transfer limit reached", Throttled),
            ("Graph list_messages failed (429) Too Many Requests", Throttled),
            ("SELECT INBOX failed: NO [NONEXISTENT] Unknown Mailbox: NoSuchFolder (Failure)", Other),
            ("BAD Command Argument Error", Other),
            ("Mailbox does not exist", Other),
        ] {
            assert_eq!(classify_connection_error(err), want, "{err}");
        }
    }

    #[test]
    fn every_code_is_stable_snake_case() {
        use ConnectionFailure::*;
        let codes: Vec<&str> = [Dns, Refused, BlockedOrTimeout, Tls, Auth, Throttled, Offline, Other]
            .into_iter()
            .map(ConnectionFailure::code)
            .collect();
        assert_eq!(codes, ["dns", "refused", "blocked_or_timeout", "tls", "auth", "throttled", "offline", "other"]);
    }
}
