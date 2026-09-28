//! The country a connection went to, for Network Activity's map.
//!
//! Looked up offline in the bundled DB-IP "IP to Country Lite" database
//! (`vendor/dbip`, CC BY 4.0, <https://db-ip.com>): no address ever leaves
//! the machine to be placed. Compiled into the daemon rather than shipped as
//! a resource, so every package (DMG, App Store, Windows, snap) finds it with
//! no path logic. Only the daemon calls in here, so the app binary does not
//! carry it.
use crate::net_activity::{NetEvent, Protocol};
use maxminddb::Reader;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};

static MMDB: &[u8] = include_bytes!("../../vendor/dbip/dbip-country-lite.mmdb");

/// The bucket for loopback, private and link-local addresses: this machine
/// or its network, never a place on the map.
pub const LOCAL: &str = "local";

fn reader() -> Option<&'static Reader<&'static [u8]>> {
    static READER: OnceLock<Option<Reader<&'static [u8]>>> = OnceLock::new();
    READER
        .get_or_init(|| {
            Reader::from_source(MMDB)
                .map_err(|e| tracing::warn!("[geo-ip] bundled database unreadable: {e}"))
                .ok()
        })
        .as_ref()
}

fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            // 100.64.0.0/10 is carrier-grade NAT: the provider's side of a
            // shared address, not a place either.
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_local(IpAddr::V4(v4)),
            None => {
                let first = v6.segments()[0];
                // fc00::/7 unique local, fe80::/10 link-local.
                v6.is_loopback() || v6.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
            }
        },
    }
}

/// ISO 3166-1 alpha-2 of `ip`, `LOCAL` for this machine or its network, or
/// `None` when the database does not place it.
pub fn country(ip: IpAddr) -> Option<String> {
    if is_local(ip) {
        return Some(LOCAL.into());
    }
    reader()?
        .lookup(ip)
        .ok()?
        .decode_path::<String>(&maxminddb::path!["country", "iso_code"])
        .ok()
        .flatten()
        // "ZZ" is the database's own "unknown or reserved".
        .filter(|code| code != "ZZ")
}

/// Newest DNS answers kept for events that carry no address of their own.
const ANSWERS_CAP: usize = 4096;

/// Places events as they are recorded. Remembers each lookup's answer, so a
/// connection that failed before it had a peer (or one whose library hides
/// it) is still placed by where its host resolved to.
#[derive(Default)]
pub struct Locator {
    answers: Mutex<HashMap<String, IpAddr>>,
}

impl Locator {
    /// The event's country. `None` for a lookup: it reaches the resolver, not
    /// the host it names.
    pub fn locate(&self, ev: &NetEvent) -> Option<String> {
        let ip = ev.ip.as_deref().and_then(|s| s.parse::<IpAddr>().ok());
        let mut answers = self.answers.lock().unwrap_or_else(|p| p.into_inner());
        if ev.protocol == Protocol::Dns {
            if let Some(ip) = ip {
                if answers.len() >= ANSWERS_CAP && !answers.contains_key(&ev.host) {
                    answers.clear();
                }
                answers.insert(ev.host.clone(), ip);
            }
            return None;
        }
        let ip = ip.or_else(|| answers.get(&ev.host).copied())?;
        drop(answers);
        country(ip)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ip: &str) -> Option<String> {
        country(ip.parse().unwrap())
    }

    #[test]
    fn the_bundled_database_places_a_public_address() {
        assert!(reader().is_some(), "the bundled mmdb must open");
        assert_eq!(at("8.8.8.8").as_deref(), Some("US"));
        let code = at("193.0.6.139").expect("RIPE's address is placed");
        assert_eq!(code.len(), 2, "{code}");
        assert!(code.chars().all(|c| c.is_ascii_uppercase()), "{code}");
    }

    #[test]
    fn loopback_private_and_link_local_are_local() {
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.3.4", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.2"] {
            assert_eq!(at(ip).as_deref(), Some(LOCAL), "{ip}");
        }
    }

    #[test]
    fn an_unplaced_address_is_none() {
        // TEST-NET-1, documentation only: in no allocation.
        assert_eq!(at("192.0.2.1"), None);
    }

    fn ev(protocol: Protocol, host: &str, ip: Option<&str>) -> NetEvent {
        let mut e = NetEvent::out(protocol, host, 993, "sync");
        e.ip = ip.map(str::to_string);
        e
    }

    #[test]
    fn an_event_without_an_address_is_placed_by_its_hosts_last_lookup() {
        let loc = Locator::default();
        assert_eq!(loc.locate(&ev(Protocol::Imap, "imap.a.test", None)), None, "nothing known yet");
        assert_eq!(loc.locate(&ev(Protocol::Dns, "imap.a.test", Some("8.8.8.8"))), None, "a lookup is not on the map");
        assert_eq!(loc.locate(&ev(Protocol::Imap, "imap.a.test", None)).as_deref(), Some("US"));
        assert_eq!(loc.locate(&ev(Protocol::Imap, "imap.a.test", Some("127.0.0.1"))).as_deref(), Some(LOCAL), "its own address wins");
        assert_eq!(loc.locate(&ev(Protocol::Smtp, "smtp.other.test", None)), None);
    }
}
