//! Daemon lifecycle methods: ping, heartbeat, status, shutdown.

use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

/// `None` = not a daemon-lifecycle method; the caller tries the next router.
pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, _params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "ping" => RpcResponse::success(id, json!({"pong": true})),
        "daemon.heartbeat" => RpcResponse::success(id, json!({
            "alive": true,
            "uptime_secs": state.started_at.elapsed().as_secs(),
            "version": env!("CARGO_PKG_VERSION"),
            "online": state.net.is_online(),
            "buildId": mailvault_core::BUILD_ID,
            "pid": std::process::id(),
        })),
        "daemon.status" => RpcResponse::success(id, json!({
            "version": env!("CARGO_PKG_VERSION"),
            "uptime_secs": state.started_at.elapsed().as_secs(),
            "data_dir": state.data_dir.to_string_lossy(),
            "buildId": mailvault_core::BUILD_ID,
        })),
        "daemon.shutdown" => {
            // Answer first: the shutdown task exits the process, and this reply must reach the socket.
            let notify = Arc::clone(&state.shutdown);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                notify.notify_one();
            });
            RpcResponse::success(id, json!({"ok": true}))
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use crate::server::DaemonState;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mv-dh-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn heartbeat_reports_the_core_build_id_and_pid() {
        let dir = scratch("beat");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let resp = super::route(&state, "daemon.heartbeat", &json!({}), json!(1)).await.expect("routed");
        let r = resp.result.expect("success");
        assert_eq!(r["buildId"], json!(mailvault_core::BUILD_ID));
        assert_eq!(r["pid"], json!(std::process::id()));
        assert_eq!(r["alive"], json!(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn status_reports_the_build_id() {
        let dir = scratch("status");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let r = super::route(&state, "daemon.status", &json!({}), json!(1)).await.unwrap().result.unwrap();
        assert_eq!(r["buildId"], json!(mailvault_core::BUILD_ID));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn shutdown_answers_ok_and_then_signals_the_shutdown() {
        let dir = scratch("shutdown");
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        let r = super::route(&state, "daemon.shutdown", &json!({}), json!(7)).await.unwrap();
        assert_eq!(r.result, Some(json!({"ok": true})));
        assert_eq!(r.id, json!(7));
        let signalled = tokio::time::timeout(std::time::Duration::from_secs(2), state.shutdown.notified()).await;
        assert!(signalled.is_ok(), "daemon.shutdown must wake the shutdown task");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_unknown_method_is_not_this_routers() {
        let dir = scratch("other");
        let state: Arc<DaemonState> = DaemonState::for_test(dir.clone(), dir.clone(), true);
        assert!(super::route(&state, "sync.now", &json!({}), json!(1)).await.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
