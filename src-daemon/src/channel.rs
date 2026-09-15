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
        // Addendum C1: never send while the mail dir is unreachable, same gate
        // `handle_request` applies to sync./snapshot./contacts_index. requests.
        // C2: only locks `signals` and sends on a non-blocking mpsc — no
        // `.await`, no disk, no `db` lock in either arm.
        "search_index.nudge" => {
            if state.mail_dir_ok {
                if let (Some(account), Some(mailbox)) = (params.get("accountId").and_then(Value::as_str), params.get("mailbox").and_then(Value::as_str)) {
                    crate::search_index::nudge(&state.search_index, account, mailbox);
                }
            }
        }
        "search_index.sweep_soon" => {
            if state.mail_dir_ok {
                crate::search_index::sweep_soon(&state.search_index);
            }
        }
        other => tracing::debug!("channel: ignoring notification {other}"),
    }
}

/// Drains the bus into the socket, one write per event. Its own task so a
/// write that blocks (the client isn't reading, e.g. it is itself stuck
/// writing a burst of notifications) never stalls `run`'s read loop below —
/// with both directions sharing one task and one `select!`, a blocked write
/// used to stop the read side from draining the client's outgoing buffer,
/// which could in turn block the client's own write, wedging both ends
/// forever once each side's ~8 KB socket buffer filled.
async fn forward_bus_to_socket(mut rx: broadcast::Receiver<Arc<str>>, mut writer: OwnedWriteHalf) {
    loop {
        match outgoing(rx.recv().await) {
            Some(line) => {
                let mut buf = line.into_bytes();
                buf.push(b'\n');
                if writer.write_all(&buf).await.is_err() {
                    return;
                }
            }
            None => return,
        }
    }
}

/// `rx` is subscribed BEFORE `channel.open` is answered, so no event emitted
/// after the client saw the answer is missed.
pub(crate) async fn run(
    state: Arc<DaemonState>,
    rx: broadcast::Receiver<Arc<str>>,
    mut lines: Lines<BufReader<OwnedReadHalf>>,
    writer: OwnedWriteHalf,
) -> std::io::Result<()> {
    let mut forwarder = tokio::spawn(forward_bus_to_socket(rx, writer));
    let result = loop {
        tokio::select! {
            // Cancel-safe (Lines::next_line); re-polling the JoinHandle on
            // the next iteration after this branch wins is also safe — its
            // state lives in the spawned task, not in this poll.
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    if let Ok(req) = ipc::parse_request(&l) {
                        dispatch(&state, &req.method, req.params).await;
                    } else {
                        tracing::debug!("channel: ignoring non-JSON-RPC notification line");
                    }
                }
                Ok(None) => break Ok(()),
                Err(e) => break Err(e),
            },
            // The forwarder ended (bus closed, or the write side is dead) —
            // a one-directional failure means the connection is dead either way.
            _ = &mut forwarder => break Ok(()),
        }
    };
    forwarder.abort();
    result
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

    #[tokio::test]
    async fn nudge_and_sweep_notifications_reach_the_index_worker_channel() {
        let tmp = tempfile::tempdir().unwrap();
        let state = crate::server::DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), true);
        let (tx, rx) = std::sync::mpsc::channel();
        *state.search_index.signals.lock().unwrap() = Some(tx);
        dispatch(&state, "search_index.nudge", json!({"accountId": "a1", "mailbox": "Projects/2026"})).await;
        dispatch(&state, "search_index.sweep_soon", json!({})).await;
        dispatch(&state, "search_index.nudge", json!({"mailbox": "INBOX"})).await; // no account: ignored
        use mailvault_core::search_index::plan::Signal;
        assert_eq!(rx.try_recv().unwrap(), Signal::Nudge { account_id: "a1".into(), vault_dir: mailvault_core::search_index::text::vault_dir_name("Projects/2026") });
        assert_eq!(rx.try_recv().unwrap(), Signal::Sweep);
        assert!(rx.try_recv().is_err());
    }

    /// Addendum C1 (Phase 0 carry): the two index-notification arms must never
    /// send while the vault is unreachable, the same gate `handle_request`
    /// already applies to `sync.*`/`snapshot.*`/`contacts_index.*` requests —
    /// `dispatch` has no such gate of its own, so these two arms check
    /// `mail_dir_ok` explicitly rather than relying on `open_into`'s own guard.
    #[tokio::test]
    async fn nudge_and_sweep_are_silent_when_the_mail_dir_is_unreachable() {
        let tmp = tempfile::tempdir().unwrap();
        let state = crate::server::DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), false);
        let (tx, rx) = std::sync::mpsc::channel();
        *state.search_index.signals.lock().unwrap() = Some(tx);
        dispatch(&state, "search_index.nudge", json!({"accountId": "a1", "mailbox": "INBOX"})).await;
        dispatch(&state, "search_index.sweep_soon", json!({})).await;
        assert!(rx.try_recv().is_err(), "no signal must be sent while the mail dir is unreachable");
    }
}
