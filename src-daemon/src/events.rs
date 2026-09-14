//! Daemon to app push. Any module (tokio task or plain thread) emits; each open
//! channel connection forwards. No subscriber = the event is dropped: no app is listening.
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast;

pub const CAPACITY: usize = 1024;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Arc<str>>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn emit(&self, name: &str, payload: Value) {
        let _ = self.tx.send(event_line(name, payload).into());
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.tx.subscribe()
    }
}

pub fn event_line(name: &str, payload: Value) -> String {
    json!({"jsonrpc": "2.0", "method": "event", "params": {"name": name, "payload": payload}}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app's blocking client parses whatever the daemon puts on the wire
    /// (`mailvault_core::daemon_ipc::parse_event`, Task 0.4).
    #[test]
    fn an_emitted_line_round_trips_through_the_apps_event_parser() {
        let line = event_line("search-index-progress", json!({"indexed": 5}));
        assert_eq!(
            mailvault_core::daemon_ipc::parse_event(&line),
            Some(("search-index-progress".to_string(), json!({"indexed": 5})))
        );
    }

    /// The Phase 1 search-index worker emits from a plain OS thread, not a
    /// tokio task — `emit` must not reach for `Handle::current()`.
    #[tokio::test]
    async fn emit_works_from_a_plain_os_thread() {
        let bus = EventBus::new(CAPACITY);
        let mut rx = bus.subscribe();
        let emitter = bus.clone();
        let handle = std::thread::spawn(move || {
            emitter.emit("from-a-thread", json!({"ok": true}));
        });
        handle.join().unwrap();

        let line = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("emit from a plain thread must reach a tokio subscriber")
            .unwrap();
        assert_eq!(
            mailvault_core::daemon_ipc::parse_event(&line),
            Some(("from-a-thread".to_string(), json!({"ok": true})))
        );
    }
}
