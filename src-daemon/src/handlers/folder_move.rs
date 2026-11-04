//! Daemon routes for moving a folder (`folder_move_job`): `folder_move.plan`
//! answers from the cached folder lists, `folder_move.start` starts the job
//! and answers at once with `{jobId}`, and `pause`, `resume`, `cancel`,
//! `discard` and `status` steer and list jobs. Progress is the
//! `folder-move-progress` event.

use crate::folder_move_job::{self, Request};
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::Arc;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// A job id names journal files: only a plain one gets through.
fn job_id_arg(id: &Value, params: &Value) -> Result<String, RpcResponse> {
    let job_id = str_arg(id, params, "jobId")?;
    if folder_move_job::is_job_id(&job_id) {
        Ok(job_id)
    } else {
        Err(RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "Invalid jobId"))
    }
}

/// `{sourceAccountId, sourcePath, sourceFolderId?, destAccountId, destPath|null, destFolderId?}`.
fn request(id: &Value, params: &Value) -> Result<Request, RpcResponse> {
    Ok(Request {
        source_account_id: str_arg(id, params, "sourceAccountId")?,
        source_path: str_arg(id, params, "sourcePath")?,
        source_folder_id: opt_str_arg(params, "sourceFolderId"),
        dest_account_id: str_arg(id, params, "destAccountId")?,
        dest_path: opt_str_arg(params, "destPath").filter(|p| !p.is_empty()),
        dest_folder_id: opt_str_arg(params, "destFolderId"),
    })
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "folder_move.plan" => {
            let req = req!(request(&id, params));
            let state = Arc::clone(state);
            done(id, blocking(move || folder_move_job::plan_cached(&state, &req)).await)
        }
        "folder_move.start" => {
            let req = req!(request(&id, params));
            done(id, folder_move_job::start(state, req).await)
        }
        "folder_move.status" => {
            let state = Arc::clone(state);
            done(id, blocking(move || folder_move_job::status(&state)).await)
        }
        "folder_move.pause" | "folder_move.cancel" | "folder_move.discard" => {
            let job_id = req!(job_id_arg(&id, params));
            let steer: fn(&DaemonState, &str) -> Result<Value, String> = match method {
                "folder_move.pause" => folder_move_job::pause,
                "folder_move.cancel" => folder_move_job::cancel,
                _ => folder_move_job::discard,
            };
            let state = Arc::clone(state);
            done(id, blocking(move || steer(&state, &job_id)).await.and_then(|r| r))
        }
        "folder_move.resume" => {
            let job_id = req!(job_id_arg(&id, params));
            done(id, folder_move_job::resume(state, &job_id).await)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use serde_json::json;

    fn st() -> (tempfile::TempDir, tempfile::TempDir, Arc<DaemonState>) {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        s.seed_accounts_for_test(&["src", "dst"]);
        (vault, app_dir, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    /// The app's cached folder list for `account`.
    fn cache(s: &Arc<DaemonState>, account: &str, boxes: Value) {
        let listing = json!({"mailboxes": boxes, "fetchedAt": 1}).to_string();
        crate::custody::with_conn(s, |c| mailvault_core::custody::cache::save_mailboxes(c, account, &listing)).unwrap();
    }

    fn node(path: &str, special_use: Option<&str>) -> Value {
        json!({"name": path, "path": path, "specialUse": special_use, "delimiter": "/", "flags": [], "noselect": false, "children": []})
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_v, _a, s) = st();
        assert!(route(&s, "start_migration", &json!({}), json!(1)).await.is_none());
    }

    #[tokio::test]
    async fn folder_move_start_reaches_its_router() {
        let (_v, _a, s) = st();
        for method in ["folder_move.plan", "folder_move.start", "folder_move.pause", "folder_move.resume", "folder_move.cancel", "folder_move.discard", "folder_move.status"] {
            let resp = handle_request_for_test(&s, method, json!({})).await;
            assert!(resp.error.as_ref().is_none_or(|e| e.code != ipc::METHOD_NOT_FOUND), "{method} did not reach handlers::folder_move::route");
        }
    }

    #[tokio::test]
    async fn start_missing_params_is_invalid_params() {
        let (_v, _a, s) = st();
        let resp = call(&s, "folder_move.start", json!({"sourceAccountId": "src", "sourcePath": "Clients"})).await;
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
        let resp = call(&s, "folder_move.pause", json!({"jobId": "../x"})).await;
        assert_eq!(resp.error.unwrap().code, ipc::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn start_refuses_inbox_and_special_use_roots() {
        let (_v, _a, s) = st();
        cache(&s, "src", json!([node("INBOX", Some("\\Inbox")), node("Sent", Some("\\Sent")), node("Clients", None)]));
        for root in ["INBOX", "inbox", "Sent"] {
            let params = json!({"sourceAccountId": "src", "sourcePath": root, "destAccountId": "src", "destPath": "Clients"});
            let err = call(&s, "folder_move.start", params.clone()).await.error.expect("refused").message;
            assert_eq!(err, "E_FOLDER_MOVE_RESERVED", "{root}");
            assert_eq!(call(&s, "folder_move.plan", params).await.result.unwrap()["refusal"], json!("E_FOLDER_MOVE_RESERVED"), "{root}");
        }
        assert_eq!(call(&s, "folder_move.status", json!({})).await.result.unwrap(), json!({"jobs": []}), "nothing started");
    }

    #[tokio::test]
    async fn plan_refuses_destination_inside_source() {
        let (_v, _a, s) = st();
        cache(&s, "src", json!([node("INBOX", Some("\\Inbox")), node("Clients", None), node("Clients/2025", None)]));
        cache(&s, "dst", json!([node("INBOX", Some("\\Inbox")), node("Archive", None)]));

        let inside = json!({"sourceAccountId": "src", "sourcePath": "Clients", "destAccountId": "src", "destPath": "Clients/2025"});
        let plan = call(&s, "folder_move.plan", inside.clone()).await.result.unwrap();
        assert_eq!((plan["refusal"].clone(), plan["items"].clone()), (json!("E_FOLDER_MOVE_INTO_ITSELF"), json!([])));
        assert_eq!(call(&s, "folder_move.start", inside).await.error.unwrap().message, "E_FOLDER_MOVE_INTO_ITSELF");

        let across = json!({"sourceAccountId": "src", "sourcePath": "Clients", "destAccountId": "dst", "destPath": "Archive"});
        let plan = call(&s, "folder_move.plan", across).await.result.unwrap();
        assert_eq!(plan["refusal"], Value::Null);
        assert_eq!(
            plan["items"],
            json!([{"src": "Clients", "dest": "Archive/Clients", "container": false}, {"src": "Clients/2025", "dest": "Archive/Clients/2025", "container": false}])
        );
        assert_eq!(plan["fastRename"], Value::Null, "another account is never a rename");
    }
}
