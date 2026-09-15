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
        // vault does not move mid-call, only closes), and `gate` wraps each
        // file's *entire* read+parse+write in its own `with_vault_write` call
        // (Task 2.6 fix round 1, I1): `vault_files::prefetch_attachments_in`
        // calls `gate(&mut work)` once per file, so the read side is held for
        // exactly that file's disk work, never left to run unguarded after a
        // bare pre-check — a move can still interleave between files instead
        // of waiting out the whole sweep.
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
                    let gate = move |work: &mut dyn FnMut() -> Result<(), String>| with_vault_write(&gate_state, |_| work());
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
        // I2 fix (2.6 review): the vault root and the app-dir fallback must be
        // distinct tempdirs, or "nothing written under the fallback root"
        // can never fail regardless of what the gate does. The app_dir here
        // is leaked (not a `TempDir` guard) so every existing `st(..)`
        // call site keeps returning just the vault root; tests that need to
        // inspect or seed the app_dir itself (the two below) build their own
        // `DaemonState` directly instead of going through `st`.
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), app_dir, mail_dir_ok);
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

    // M1 fix (2.6 review): `seed_email`'s fixed input pins every field of the
    // reads that only had structural coverage before. `text` is compared
    // separately with `.trim()` — mailparse's body-before-boundary trailing
    // CRLF is already handled the same way elsewhere in this crate
    // (`vault_files.rs`'s own `out[2].text.as_deref().map(str::trim)`), not a
    // new exception invented for this test.
    #[tokio::test]
    async fn maildir_read_returns_the_full_parse_as_literal_json() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "maildir_read", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7})).await;
        let mut got = r.result.unwrap();
        let text = got.as_object_mut().unwrap().remove("text").unwrap();
        assert_eq!(text.as_str().unwrap().trim(), "body");
        assert_eq!(got, json!({
            "uid": 7,
            "messageId": null,
            "subject": "hi",
            "from": {"name": null, "address": "a@b.com"},
            "to": [{"name": null, "address": "c@d.com"}],
            "cc": [],
            "bcc": [],
            "replyTo": [],
            "date": null,
            "flags": [],
            "html": null,
            // mailparse's raw body includes the trailing CRLF before the next
            // boundary marker (unlike `get_body()` for text, which trims it):
            // the fixture's part is "data\r\n" (6 bytes), not "data" (4).
            "attachments": [{
                "filename": "pixel.png",
                "contentType": "application/octet-stream",
                "contentDisposition": "Attachment",
                "size": 6,
                "contentId": null,
                "content": "ZGF0YQ0K"
            }],
            "rawSource": "RnJvbTogYUBiLmNvbQ0KVG86IGNAZC5jb20NClN1YmplY3Q6IGhpDQpDb250ZW50LVR5cGU6IG11bHRpcGFydC9taXhlZDsgYm91bmRhcnk9WA0KDQotLVgNCkNvbnRlbnQtVHlwZTogdGV4dC9wbGFpbg0KDQpib2R5DQotLVgNCkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtOyBuYW1lPXBpeGVsLnBuZw0KQ29udGVudC1EaXNwb3NpdGlvbjogYXR0YWNobWVudDsgZmlsZW5hbWU9cGl4ZWwucG5nDQoNCmRhdGENCi0tWC0tDQo=",
            "hasAttachments": true,
            "isArchived": false
        }));
    }

    #[tokio::test]
    async fn maildir_read_light_returns_the_light_parse_as_literal_json() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "maildir_read_light", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7})).await;
        let mut got = r.result.unwrap();
        let text = got.as_object_mut().unwrap().remove("text").unwrap();
        assert_eq!(text.as_str().unwrap().trim(), "body");
        assert_eq!(got, json!({
            "uid": 7,
            "messageId": null,
            "subject": "hi",
            "from": {"name": null, "address": "a@b.com"},
            "to": [{"name": null, "address": "c@d.com"}],
            "cc": [],
            "bcc": [],
            "replyTo": [],
            "date": null,
            "flags": [],
            "html": null,
            // Same trailing-CRLF-before-boundary note as `maildir_read`'s test.
            "attachments": [{
                "filename": "pixel.png",
                "contentType": "application/octet-stream",
                "contentDisposition": "Attachment",
                "size": 6,
                "contentId": null
            }],
            "hasAttachments": true,
            "isArchived": false
        }));
    }

    #[tokio::test]
    async fn maildir_read_raw_source_returns_the_whole_file_as_base64() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "maildir_read_raw_source", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7})).await;
        assert_eq!(
            r.result.unwrap(),
            json!("RnJvbTogYUBiLmNvbQ0KVG86IGNAZC5jb20NClN1YmplY3Q6IGhpDQpDb250ZW50LVR5cGU6IG11bHRpcGFydC9taXhlZDsgYm91bmRhcnk9WA0KDQotLVgNCkNvbnRlbnQtVHlwZTogdGV4dC9wbGFpbg0KDQpib2R5DQotLVgNCkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtOyBuYW1lPXBpeGVsLnBuZw0KQ29udGVudC1EaXNwb3NpdGlvbjogYXR0YWNobWVudDsgZmlsZW5hbWU9cGl4ZWwucG5nDQoNCmRhdGENCi0tWC0tDQo=")
        );
    }

    #[tokio::test]
    async fn cached_attachment_path_is_a_literal_absolute_path_under_the_root() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        call(&s, "cache_attachment", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "attachmentIndex": 0})).await;
        let r = call(&s, "cached_attachment_path", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "attachmentIndex": 0})).await;
        let want = t.path().join("attachment_cache").join("acc_INBOX_7_0_pixel.png").to_string_lossy().to_string();
        assert_eq!(r.result.unwrap(), json!(want));
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

    // I2 fix (2.6 review): the old version of this test used the same
    // tempdir for the vault root and the app_dir fallback, so "nothing
    // written under the fallback root" could never fail no matter what the
    // gate did. Two distinct dirs here, with an `.eml` seeded under app_dir
    // specifically — a route that silently fell back to `state.app_dir`
    // would find it and could cache something; the assertion below only
    // means something because that file exists and is reachable if the gate
    // is bypassed.
    #[tokio::test]
    async fn a_gated_route_creates_nothing_under_either_root_when_the_folder_is_unreachable() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), false);
        seed_email(app_dir.path(), "acc", "INBOX", 7);

        let r = call(&s, "maildir_read_light", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 1})).await;
        assert!(r.error.unwrap().message.starts_with("E_VAULT_UNAVAILABLE:"));
        let r = call(&s, "cache_attachment", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "attachmentIndex": 0})).await;
        assert!(r.error.unwrap().message.starts_with("E_VAULT_UNAVAILABLE:"));
        let r = call(&s, "prefetch_attachments", json!({"accountId": "acc", "mailbox": "INBOX"})).await;
        assert!(r.error.unwrap().message.starts_with("E_VAULT_UNAVAILABLE:"));

        assert!(!app_dir.path().join("attachment_cache").exists());
        assert!(!vault.path().join("attachment_cache").exists());
    }

    // I2 fix, second reason a route can be gated: `mail_dir_ok=true` but the
    // vault is mid-move (`vault_closed`). Same two-tempdir shape, seeded
    // under the vault root this time (the folder *is* reachable, just
    // temporarily closed).
    #[tokio::test]
    async fn a_gated_route_creates_nothing_under_either_root_while_the_vault_is_being_moved() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        seed_email(vault.path(), "acc", "INBOX", 7);
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);

        let r = call(&s, "maildir_read_light", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 1})).await;
        assert!(r.error.unwrap().message.starts_with("E_VAULT_UNAVAILABLE:"));
        let r = call(&s, "cache_attachment", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "attachmentIndex": 0})).await;
        assert!(r.error.unwrap().message.starts_with("E_VAULT_UNAVAILABLE:"));
        let r = call(&s, "prefetch_attachments", json!({"accountId": "acc", "mailbox": "INBOX"})).await;
        assert!(r.error.unwrap().message.starts_with("E_VAULT_UNAVAILABLE:"));

        assert!(!app_dir.path().join("attachment_cache").exists());
        assert!(!vault.path().join("attachment_cache").exists());
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
