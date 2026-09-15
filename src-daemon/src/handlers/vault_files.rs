//! Vault file reads and the attachment cache (Task 2.6, plan §"Daemon read
//! family and attachments"). Bodies are `mailvault_core::vault_files` (Task
//! 2.2), unchanged; this router only extracts JSON args, picks the gate
//! (`common::vault_root` for reads and `cached_attachment_path`,
//! `common::with_vault_write` for the two writers into `attachment_cache`),
//! and runs everything inside `handlers::common::blocking` — every method
//! here touches disk.
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg, u32_arg, vault_root, vec_arg, with_vault_write};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::{maildir, vault_files};
use serde_json::Value;
use std::sync::Arc;

/// A required param, returning early from `route` on a missing key — mirrors
/// the `let Some(..) = .. else { return Some(..) }` shape `search_index.rs`
/// uses, but through the arg helpers so the error names the missing key.
macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "maildir_read" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let email = vault_files::read(&root, &account_id, &mailbox, uid)?;
                    serde_json::to_value(email).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_read_light" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let email = vault_files::read_light(&root, &account_id, &mailbox, uid)?;
                    serde_json::to_value(email).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_read_light_batch" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let batch = vault_files::read_light_batch(&root, &account_id, &mailbox, &uids);
                    serde_json::to_value(batch).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_read_raw_source" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    vault_files::read_raw_source(&root, &account_id, &mailbox, uid).map(Value::String)
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_read_attachment" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let index = req!(u32_arg(&id, params, "attachmentIndex")) as usize;
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    vault_files::read_attachment(&root, &account_id, &mailbox, uid, index).map(Value::String)
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_exists" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    Ok(Value::Bool(vault_files::exists(&root, &account_id, &mailbox, uid)))
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_list" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let require_flag = opt_str_arg(params, "requireFlag");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let list = vault_files::list(&root, &account_id, &mailbox, require_flag.as_deref())?;
                    serde_json::to_value(list).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_storage_stats" => {
            let account_id = opt_str_arg(params, "accountId");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let stats = vault_files::storage_stats(&root, account_id.as_deref());
                    serde_json::to_value(stats).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_orphan_stats" => {
            let account_id = opt_str_arg(params, "accountId");
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let base = root.join("Maildir");
                    let mut total = maildir::OrphanStats::default();
                    for mailbox_dir in vault_files::orphan_mailbox_dirs(&base, account_id.as_deref()) {
                        let s = maildir::orphan_stats(&mailbox_dir);
                        total.count += s.count;
                        total.bytes += s.bytes;
                    }
                    serde_json::to_value(total).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "cached_attachment_path" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let index = req!(u32_arg(&id, params, "attachmentIndex")) as usize;
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let path = vault_files::cached_attachment_path(&root, &account_id, &mailbox, uid, index)?;
                    serde_json::to_value(path).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        // Writes one file under <root>/attachment_cache: with_vault_write,
        // scoped to this one call (one file), per the Global constraint that
        // a write never spans more than one file/mailbox batch per gate check.
        "cache_attachment" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let index = req!(u32_arg(&id, params, "attachmentIndex")) as usize;
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    with_vault_write(&state, |root| vault_files::cache_attachment(root, &account_id, &mailbox, uid, index)).map(Value::String)
                })
                .await
                .and_then(|r| r),
            )
        }
        // A mailbox sweep can cover thousands of messages: taking
        // `with_vault_write` once for the whole call would hold `vault_gate`'s
        // read side for the sweep's entire duration, which can starve
        // `vault_close`'s writer-drain past the app's 120s `vault_close`
        // budget — and a `vault_close` that times out stops the daemon (I2
        // fix, `should_stop_after_lifecycle_call`) while this sweep is still
        // writing. So `root` is resolved once (fixed for the call — the
        // vault does not move mid-call, only closes), but `gate` re-takes
        // `with_vault_write` per file inside `vault_files::prefetch_attachments`
        // (core, Task 2.6 fix round): a move can interleave between files
        // instead of waiting out the whole sweep.
        "prefetch_attachments" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let _one_sweep_at_a_time = state.prefetch_lock.lock().unwrap_or_else(|p| p.into_inner());
                    let root = vault_root(&state)?;
                    let gate_state = Arc::clone(&state);
                    let gate = move || with_vault_write(&gate_state, |_| Ok(()));
                    vault_files::prefetch_attachments(&root, &account_id, &mailbox, &state.prefetch_high_water, &gate).map(|n| Value::from(n as u64))
                })
                .await
                .and_then(|r| r),
            )
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn st(mail_dir_ok: bool) -> (tempfile::TempDir, Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), tmp.path().to_path_buf(), mail_dir_ok);
        (tmp, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    fn seed_email(root: &std::path::Path, account: &str, mailbox: &str, uid: u32) {
        let cur = vault_files::cur_path(root, account, mailbox);
        fs::create_dir_all(&cur).unwrap();
        let raw = b"From: a@b.com\r\nTo: c@d.com\r\nSubject: hi\r\nContent-Type: multipart/mixed; boundary=X\r\n\r\n--X\r\nContent-Type: text/plain\r\n\r\nbody\r\n--X\r\nContent-Type: application/octet-stream; name=pixel.png\r\nContent-Disposition: attachment; filename=pixel.png\r\n\r\ndata\r\n--X--\r\n";
        fs::write(cur.join(vault_files::build_maildir_filename(uid, &[])), raw).unwrap();
    }

    #[tokio::test]
    async fn maildir_exists_answers_a_bare_bool() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "maildir_exists", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7})).await;
        assert_eq!(r.result, Some(json!(true)));
        let r = call(&s, "maildir_exists", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 8})).await;
        assert_eq!(r.result, Some(json!(false)));
    }

    #[tokio::test]
    async fn maildir_read_light_batch_has_a_null_slot_for_a_missing_uid() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "maildir_read_light_batch", json!({"accountId": "acc", "mailbox": "INBOX", "uids": [7, 9]})).await;
        let arr = r.result.unwrap();
        assert!(arr[0].is_object());
        assert_eq!(arr[1], Value::Null);
    }

    #[tokio::test]
    async fn maildir_read_attachment_not_found_names_the_uid() {
        let (_t, s) = st(true);
        let r = call(&s, "maildir_read_attachment", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 42, "attachmentIndex": 0})).await;
        let err = r.error.unwrap();
        assert_eq!(err.message, "Email UID 42 not found");
    }

    #[tokio::test]
    async fn cache_attachment_then_cached_attachment_path_agree_on_an_absolute_path_under_the_root() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let cached = call(&s, "cache_attachment", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "attachmentIndex": 0})).await.result.unwrap();
        let path = cached.as_str().unwrap();
        assert!(std::path::Path::new(path).is_absolute());
        assert!(path.contains(t.path().join("attachment_cache").to_str().unwrap()));
        assert!(path.ends_with("pixel.png"));

        let looked_up = call(&s, "cached_attachment_path", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "attachmentIndex": 0})).await.result.unwrap();
        assert_eq!(looked_up, Value::String(path.to_string()));
    }

    #[tokio::test]
    async fn a_gated_route_refuses_and_writes_nothing_under_the_fallback_root() {
        let (t, s) = st(false);
        let r = call(&s, "maildir_read_light", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 1})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
        assert!(!s.app_dir.join("Maildir").exists());
        let _ = t;
    }

    #[tokio::test]
    async fn a_gated_write_route_refuses_while_the_vault_is_unreachable() {
        let (_t, s) = st(false);
        let r = call(&s, "cache_attachment", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 1, "attachmentIndex": 0})).await;
        let err = r.error.unwrap();
        assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{}", err.message);
    }

    #[tokio::test]
    async fn prefetch_attachments_writes_the_one_new_attachment_and_returns_the_count() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "prefetch_attachments", json!({"accountId": "acc", "mailbox": "INBOX"})).await;
        assert_eq!(r.result, Some(json!(1)));
    }

    #[tokio::test]
    async fn maildir_list_camel_cases_the_summary_fields() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "maildir_list", json!({"accountId": "acc", "mailbox": "INBOX", "requireFlag": null})).await;
        let arr = r.result.unwrap();
        assert_eq!(arr[0]["uid"], json!(7));
        assert_eq!(arr[0]["isArchived"], json!(false));
    }

    #[tokio::test]
    async fn maildir_storage_stats_camel_cases_its_fields() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "maildir_storage_stats", json!({"accountId": Value::Null})).await;
        let v = r.result.unwrap();
        assert!(v.get("totalBytes").is_some());
        assert!(v.get("totalMB").is_some());
        assert!(v.get("emailCount").is_some());
    }

    #[tokio::test]
    async fn maildir_orphan_stats_is_zero_over_an_empty_vault() {
        let (_t, s) = st(true);
        let r = call(&s, "maildir_orphan_stats", json!({"accountId": Value::Null})).await;
        assert_eq!(r.result, Some(json!({"count": 0, "bytes": 0})));
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let (_t, s) = st(true);
        assert!(route(&s, "sync.now", &json!({}), json!(1)).await.is_none());
    }
}
