//! A connection after `channel.open`: bus events out, notifications in, no responses.
use crate::events::event_line;
use crate::ipc;
use crate::server::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader, Lines};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::broadcast::{self, error::RecvError};

pub(crate) fn outgoing(msg: Result<Arc<str>, RecvError>) -> Option<String> {
    match msg {
        Ok(line) => Some(line.to_string()),
        Err(RecvError::Lagged(missed)) => Some(event_line("daemon-events-lagged", json!({"missed": missed}))),
        Err(RecvError::Closed) => None,
    }
}

pub(crate) async fn dispatch(state: &Arc<DaemonState>, method: &str, params: Value) {
    match method {
        "daemon.ping" => state.events.emit("daemon-ping", params),
        other => tracing::debug!("channel: ignoring notification {other}"),
    }
}

/// `rx` is subscribed BEFORE `channel.open` is answered, so no event emitted
/// after the client saw the answer is missed.
pub(crate) async fn run(
    state: Arc<DaemonState>,
    mut rx: broadcast::Receiver<Arc<str>>,
    mut lines: Lines<BufReader<OwnedReadHalf>>,
    mut writer: OwnedWriteHalf,
) -> std::io::Result<()> {
    loop {
        tokio::select! {
            msg = rx.recv() => match outgoing(msg) {
                Some(line) => {
                    writer.write_all(line.as_bytes()).await?;
                    writer.write_all(b"\n").await?;
                }
                None => return Ok(()),
            },
            // Both branches are cancel-safe (broadcast recv, Lines::next_line).
            line = lines.next_line() => match line? {
                None => return Ok(()),
                Some(l) => {
                    if let Ok(req) = ipc::parse_request(&l) {
                        dispatch(&state, &req.method, req.params).await;
                    }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::broadcast::error::RecvError;

    #[test]
    fn a_forwarded_event_is_sent_as_is() {
        let line = crate::events::event_line("x", json!({"a": 1}));
        assert_eq!(outgoing(Ok(line.clone().into())), Some(line));
    }

    #[test]
    fn a_lagged_receiver_is_told_how_many_events_it_missed() {
        let out = outgoing(Err(RecvError::Lagged(7))).expect("a lag is reported, not fatal");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["method"], "event");
        assert_eq!(v["params"]["name"], "daemon-events-lagged");
        assert_eq!(v["params"]["payload"]["missed"], 7);
    }

    #[test]
    fn a_closed_bus_ends_the_channel() {
        assert_eq!(outgoing(Err(RecvError::Closed)), None);
    }

    #[tokio::test]
    async fn the_bus_drops_the_oldest_events_for_a_slow_subscriber() {
        let bus = crate::events::EventBus::new(2);
        let mut rx = bus.subscribe();
        for i in 0..5 {
            bus.emit("n", json!(i));
        }
        assert!(matches!(rx.recv().await, Err(RecvError::Lagged(3))));
    }
}
