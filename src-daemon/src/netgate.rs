//! Connectivity gate — the daemon's answer to "is there any point dialling?".
//!
//! Rust has no NWPathMonitor, and a link-layer monitor would answer the wrong
//! question anyway (a joined Wi-Fi network with no uplink is "satisfied"). So
//! the gate is driven by the traffic the daemon already makes: a connect-shaped
//! failure asks for a probe, the probe decides, and while it says down, every
//! sync short-circuits instead of dialling nine accounts into a dead socket.
//!
//! One rule holds this together: **the error string only ever raises a
//! suspicion; `probe_internet()` is the only thing that changes the gate.**
//!
//! Three independent paths reopen it — the watchdog's backoff probe, an
//! explicit `net.probe` (the app forwards the webview's `online` event), and
//! any IMAP round trip that succeeds. A gate with one way back open is a gate
//! that eventually stays shut.

use mailvault_core::net;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, Notify};
use tracing::{info, warn};

/// Injection point for tests — see `NetGate::with_probe`.
pub type Probe = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// Concurrent failures share one probe: a verdict this fresh is reused rather
/// than re-dialled. Nine accounts failing together cost one probe, not nine.
const PROBE_TTL: Duration = Duration::from_secs(2);

/// Recovery backoff while the gate is shut.
const RECOVERY_MIN: Duration = Duration::from_secs(5);
const RECOVERY_MAX: Duration = Duration::from_secs(60);

pub struct NetGate {
    online: AtomicBool,
    /// Epoch millis of the last flip — lets the app say "offline since…".
    changed_at_ms: AtomicU64,
    /// Guards the single-flight probe AND caches its verdict. Held across the
    /// dial on purpose: a second caller queues, then reads the fresh answer.
    last_probe: Mutex<Option<(Instant, bool)>>,
    /// Raised when the gate shuts, so the watchdog starts its backoff.
    went_offline: Notify,
    probe: Probe,
    probe_ttl: Duration,
    recovery_min: Duration,
    recovery_max: Duration,
}

impl NetGate {
    /// The real gate: probes the internet.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::build(
            Arc::new(|| Box::pin(net::probe_internet())),
            PROBE_TTL,
            RECOVERY_MIN,
            RECOVERY_MAX,
        ))
    }

    /// A gate driven by a caller-supplied probe, with the waits collapsed.
    /// Tests hand it a mock connectivity object and script the answers.
    pub fn with_probe(probe: Probe) -> Arc<Self> {
        Arc::new(Self::build(
            probe,
            Duration::ZERO,
            Duration::from_millis(5),
            Duration::from_millis(20),
        ))
    }

    fn build(probe: Probe, probe_ttl: Duration, recovery_min: Duration, recovery_max: Duration) -> Self {
        Self {
            // Optimistic: a daemon that starts up gated would refuse to sync
            // until something failed, and nothing fails while it refuses.
            online: AtomicBool::new(true),
            changed_at_ms: AtomicU64::new(now_ms()),
            last_probe: Mutex::new(None),
            went_offline: Notify::new(),
            probe,
            probe_ttl,
            recovery_min,
            recovery_max,
        }
    }

    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::Relaxed)
    }

    /// Run (or join) a probe and adopt its verdict.
    pub async fn confirm_online(&self) -> bool {
        let mut cached = self.last_probe.lock().await;
        if let Some((at, verdict)) = *cached {
            if at.elapsed() < self.probe_ttl {
                return verdict;
            }
        }
        let verdict = (self.probe)().await;
        *cached = Some((Instant::now(), verdict));
        drop(cached);
        self.set_online(verdict);
        verdict
    }

    /// A completed round trip. The cheapest possible proof of reachability, and
    /// the reason a user opening one email reopens the gate for every account.
    pub fn note_success(&self) {
        self.set_online(true);
    }

    /// Feed every failure here. Returns whether the daemon is online *after*
    /// the check, so the caller can label its own result.
    ///
    /// Only connect-shaped text costs a probe; a server that answered "NO"
    /// leaves the gate exactly as it was.
    pub async fn note_failure(&self, err: &str) -> bool {
        if !net::looks_like_network_down(err) {
            return self.is_online();
        }
        self.confirm_online().await
    }

    fn set_online(&self, next: bool) {
        let was = self.online.swap(next, Ordering::Relaxed);
        if was == next {
            return;
        }
        self.changed_at_ms.store(now_ms(), Ordering::Relaxed);
        if next {
            info!("[net] Connectivity restored — sync resumes");
        } else {
            warn!("[net] No connectivity — pausing all sync until a probe succeeds");
            self.went_offline.notify_one();
        }
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "online": self.is_online(),
            "changedAtMs": self.changed_at_ms.load(Ordering::Relaxed),
        })
    }

    /// Poll for recovery while the gate is shut, then go back to sleep.
    ///
    /// Costs nothing when online: the loop parks on a `Notify` rather than
    /// waking on a timer to ask a question whose answer is already yes.
    pub fn spawn_watchdog(self: &Arc<Self>) {
        let gate = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                gate.went_offline.notified().await;
                let mut delay = gate.recovery_min;
                while !gate.is_online() {
                    tokio::time::sleep(delay).await;
                    if gate.confirm_online().await {
                        break;
                    }
                    delay = (delay * 2).min(gate.recovery_max);
                }
            }
        });
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// Mock connectivity object: answers whatever the test last set, and counts
    /// how many times it was asked so single-flight can be proven.
    #[derive(Clone)]
    struct MockNet {
        online: Arc<AtomicBool>,
        calls: Arc<AtomicUsize>,
    }

    impl MockNet {
        fn new(online: bool) -> Self {
            Self {
                online: Arc::new(AtomicBool::new(online)),
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
        fn set(&self, online: bool) {
            self.online.store(online, Ordering::SeqCst);
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
        fn probe(&self) -> Probe {
            let me = self.clone();
            Arc::new(move || {
                let me = me.clone();
                Box::pin(async move {
                    me.calls.fetch_add(1, Ordering::SeqCst);
                    me.online.load(Ordering::SeqCst)
                })
            })
        }
    }

    #[tokio::test]
    async fn starts_open_so_a_cold_daemon_can_sync() {
        let gate = NetGate::with_probe(MockNet::new(true).probe());
        assert!(gate.is_online());
    }

    #[tokio::test]
    async fn a_server_refusal_never_shuts_the_gate() {
        let net = MockNet::new(false); // even with the network truly down
        let gate = NetGate::with_probe(net.probe());

        let online = gate.note_failure("NO [AUTHENTICATIONFAILED] Invalid credentials").await;

        assert!(online, "an answered command is not a connectivity failure");
        assert!(gate.is_online());
        assert_eq!(net.calls(), 0, "a tagged NO must not cost a probe");
    }

    #[tokio::test]
    async fn a_connect_failure_shuts_the_gate_only_when_the_probe_agrees() {
        let net = MockNet::new(true); // one provider down, internet fine
        let gate = NetGate::with_probe(net.probe());

        let online = gate.note_failure("TCP connect to imap.gmail.com:993 failed: timed out").await;

        assert!(online, "the probe, not the error text, decides");
        assert!(gate.is_online());
        assert_eq!(net.calls(), 1);

        net.set(false); // now the host really is offline
        let online = gate.note_failure("TCP connect to imap.gmail.com:993 failed: timed out").await;
        assert!(!online);
        assert!(!gate.is_online());
    }

    #[tokio::test]
    async fn concurrent_failures_share_one_probe() {
        let net = MockNet::new(false);
        // Production TTL, not `with_probe`'s zero — the single-flight IS what
        // this test is about, and a zero TTL would let all nine dial.
        let gate = Arc::new(NetGate::build(
            net.probe(),
            Duration::from_secs(2),
            Duration::from_millis(5),
            Duration::from_millis(20),
        ));
        let err = "TLS handshake with imap.zoho.com failed: connection closed via error";
        let mut tasks = Vec::new();
        for _ in 0..9 {
            let gate = Arc::clone(&gate);
            tasks.push(tokio::spawn(async move { gate.note_failure(err).await }));
        }
        for t in tasks {
            assert!(!t.await.unwrap());
        }
        assert_eq!(net.calls(), 1, "nine accounts, one probe");
    }

    #[tokio::test]
    async fn a_successful_round_trip_reopens_the_gate_without_probing() {
        let net = MockNet::new(false);
        let gate = NetGate::with_probe(net.probe());
        gate.note_failure("Network is unreachable").await;
        assert!(!gate.is_online());

        let before = net.calls();
        gate.note_success();

        assert!(gate.is_online());
        assert_eq!(net.calls(), before, "proof in hand needs no probe");
    }

    #[tokio::test]
    async fn the_watchdog_reopens_the_gate_when_the_network_returns() {
        let net = MockNet::new(false);
        let gate = NetGate::with_probe(net.probe());
        gate.spawn_watchdog();

        gate.note_failure("No route to host").await;
        assert!(!gate.is_online(), "gate must shut first");

        net.set(true);

        // The watchdog is the ONLY path back when nothing else runs — a gate
        // that shuts while every caller is short-circuited can never reopen
        // on its own otherwise.
        for _ in 0..200 {
            if gate.is_online() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(gate.is_online(), "watchdog never reopened the gate");
    }

    #[tokio::test]
    async fn status_reports_the_flip() {
        let net = MockNet::new(false);
        let gate = NetGate::with_probe(net.probe());
        assert_eq!(gate.status()["online"], serde_json::json!(true));
        gate.note_failure("Network is down").await;
        assert_eq!(gate.status()["online"], serde_json::json!(false));
    }
}
