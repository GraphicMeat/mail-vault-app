//! Vault file reads and the attachment cache (Task 2.6, plan §"Daemon read
//! family and attachments"). Bodies are `mailvault_core::vault_files` (Task
//! 2.2), unchanged; this router only extracts JSON args, picks the gate
//! (`common::vault_root` for reads and `cached_attachment_path`,
//! `common::with_vault_write` for the two writers into `attachment_cache`),
//! and runs everything inside `handlers::common::blocking` — every method
//! here touches disk.
use crate::handlers::common::{blocking, done, opt_str_arg, str_arg, u32_arg, vault_root, vec_arg, with_mailbox_write, with_vault_write};
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
        // One call per message for its inline images (`hydrateInlineImages`):
        // the .eml is found and parsed once, one base64-or-null slot per index.
        "maildir_read_attachments" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let indices = req!(vec_arg::<usize>(&id, params, "attachmentIndices"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let parts = vault_files::read_attachments(&root, &account_id, &mailbox, uid, &indices)?;
                    serde_json::to_value(parts).map_err(|e| e.to_string())
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
        // Reads the .eml and writes N files OUTSIDE the vault (a folder the
        // app named under ~/Downloads). Not a vault write, so no
        // `with_vault_write`: the gate guards the vault's own files, and the
        // daemon inherits the app's sandbox (`com.apple.security.inherit`),
        // which is what lets it reach Downloads at all.
        "export_attachments" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let indices = req!(vec_arg::<usize>(&id, params, "indices"));
            let dest_dir = req!(str_arg(&id, params, "destDir"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let out = vault_files::export_attachments(
                        &root, &account_id, &mailbox, uid, &indices, std::path::Path::new(&dest_dir),
                    )?;
                    serde_json::to_value(out).map_err(|e| e.to_string())
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
        // Task 2.8: the six simple vault writers. Single-file writes
        // (`maildir_store`, `maildir_delete`, `maildir_set_flags`) go through
        // `with_vault_write` once, same as `cache_attachment`. The
        // whole-vault walkers (`maildir_clear_cache`,
        // `maildir_migrate_json_to_eml`, `maildir_migrate_email_dirs`) resolve
        // `root` once (fixed for the call) and pass a `gate` closure the core
        // fn calls once per file/mailbox batch — never once around the whole
        // walk, same reasoning as `prefetch_attachments` above.
        "maildir_store" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let raw_b64 = req!(str_arg(&id, params, "rawSourceBase64"));
            let flags = req!(vec_arg::<String>(&id, params, "flags"));
            let raw = match vault_files::decode_raw_source(&raw_b64) {
                Ok(r) => r,
                Err(e) => return Some(RpcResponse::error(id, crate::ipc::INVALID_PARAMS, e)),
            };
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    // Always overwrites (a differently-named old file for the
                    // same uid is removed after the new one lands —
                    // `vault_files::store`, oddity 1). Every successful write
                    // nudges the index: the registry's change hook does it.
                    with_mailbox_write(&state, &account_id, &mailbox, |root| {
                        vault_files::store(&state.vault_registry, root, &account_id, &mailbox, uid, &raw, &flags, true)
                    })?;
                    Ok(Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_delete" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    // A real removal nudges the index through the registry's
                    // change hook; an absent uid touches neither.
                    with_mailbox_write(&state, &account_id, &mailbox, |root| {
                        vault_files::delete(&state.vault_registry, root, &account_id, &mailbox, uid)
                    })?;
                    Ok(Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_set_flags" => {
            let account_id = req!(str_arg(&id, params, "accountId"));
            let mailbox = req!(str_arg(&id, params, "mailbox"));
            let uid = req!(u32_arg(&id, params, "uid"));
            let flags = req!(vec_arg::<String>(&id, params, "flags"));
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    // `vault_files::set_flags` answers `E_UID_NOT_IN_MAILDIR:`
                    // verbatim when the uid has no file — propagated as-is.
                    // A real rename nudges through the registry's change hook.
                    with_mailbox_write(&state, &account_id, &mailbox, |root| {
                        vault_files::set_flags(&state.vault_registry, root, &account_id, &mailbox, uid, &flags)
                    })?;
                    Ok(Value::Null)
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_clear_cache" => {
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let gate_state = Arc::clone(&state);
                    let gate = move |work: &mut dyn FnMut() -> Result<(), String>| with_vault_write(&gate_state, |_| work());
                    let result = vault_files::clear_cache(&root, &gate)?;
                    if result.deleted_count > 0 {
                        crate::search_index::sweep_soon(&state.search_index); // every folder of every account lost files
                    }
                    serde_json::to_value(result).map_err(|e| e.to_string())
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_migrate_json_to_eml" => {
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let gate_state = Arc::clone(&state);
                    let gate = move |work: &mut dyn FnMut() -> Result<(), String>| with_vault_write(&gate_state, |_| work());
                    // Legacy-only path; never nudges the index (inventory §4,
                    // kept unchanged — writes .eml files with no signal).
                    vault_files::migrate_json_to_eml(&root, &gate).map(Value::String)
                })
                .await
                .and_then(|r| r),
            )
        }
        "maildir_migrate_email_dirs" => {
            let Some(account_map) = params.get("accountMap").and_then(|v| serde_json::from_value::<std::collections::HashMap<String, String>>(v.clone()).ok()) else {
                return Some(RpcResponse::error(id, crate::ipc::INVALID_PARAMS, "Missing accountMap"));
            };
            let state = Arc::clone(state);
            done(
                id,
                blocking(move || -> Result<Value, String> {
                    let root = vault_root(&state)?;
                    let gate_state = Arc::clone(&state);
                    let gate = move |work: &mut dyn FnMut() -> Result<(), String>| with_vault_write(&gate_state, |_| work());
                    let migrated = vault_files::migrate_email_dirs(&root, &account_map, &gate)?;
                    if migrated > 0 {
                        crate::search_index::sweep_soon(&state.search_index); // folders moved between account dirs
                    }
                    Ok(serde_json::json!({ "migrated": migrated }))
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

    /// Task 2.8: the test seam Phase 1 added for nudges (`search_index.rs`'s
    /// own `manual_channel` test helper, same shape) — a manually installed
    /// `mpsc::Sender` in place of the real worker thread's, so a route's
    /// `nudge`/`sweep_soon` call can be observed directly instead of inferred
    /// from a side effect.
    fn signal_channel(s: &Arc<DaemonState>) -> std::sync::mpsc::Receiver<mailvault_core::search_index::plan::Signal> {
        let (tx, rx) = std::sync::mpsc::channel();
        *s.search_index.signals.lock().unwrap() = Some(tx);
        rx
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
    async fn maildir_read_attachments_has_a_null_slot_for_a_bad_index() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let r = call(&s, "maildir_read_attachments", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "attachmentIndices": [0, 3]})).await;
        // "data\r\n": the raw part keeps its CRLF before the boundary (see M1 below).
        assert_eq!(r.result, Some(json!(["ZGF0YQ0K", null])));
        let r = call(&s, "maildir_read_attachments", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 42, "attachmentIndices": [0]})).await;
        assert_eq!(r.error.unwrap().message, "Email UID 42 not found");
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
    async fn export_attachments_writes_the_folder_the_app_named() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("hi - Attachments");

        let r = call(&s, "export_attachments", json!({
            "accountId": "acc", "mailbox": "INBOX", "uid": 7,
            "indices": [0], "destDir": dest.to_string_lossy(),
        })).await;

        let v = r.result.expect("export_attachments must succeed");
        assert_eq!(v["dir"], json!(dest.to_string_lossy()));
        assert_eq!(v["files"], json!(["pixel.png"]));
        assert!(dest.join("pixel.png").exists());
        // The export is the user's folder, not the app's private cache.
        assert!(!t.path().join("attachment_cache").exists());
    }

    #[tokio::test]
    async fn export_attachments_without_indices_is_a_bad_request_not_an_empty_folder() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("empty");

        let r = call(&s, "export_attachments", json!({
            "accountId": "acc", "mailbox": "INBOX", "uid": 7,
            "indices": [], "destDir": dest.to_string_lossy(),
        })).await;

        assert!(r.error.is_some());
        assert!(!dest.exists());
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

    // ── Task 2.8: the six simple vault writers ──────────────────────────────

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[tokio::test]
    async fn maildir_store_writes_the_new_name_and_always_nudges() {
        let (t, s) = st(true);
        let rx = signal_channel(&s);
        let raw = b64(b"From: a@b.com\r\n\r\nbody");
        let r = call(&s, "maildir_store", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "rawSourceBase64": raw, "flags": ["seen"]})).await;
        assert!(r.error.is_none(), "{:?}", r.error);
        assert!(vault_files::cur_path(t.path(), "acc", "INBOX").join("7:2,S.eml").exists());
        assert_eq!(
            rx.try_recv().unwrap(),
            mailvault_core::search_index::plan::Signal::Nudge { account_id: "acc".into(), vault_dir: "INBOX".into() }
        );
    }

    /// Verified first, so the second answer can only come from the row the
    /// store wrote: a relisting would be visible in `listing_count`.
    #[tokio::test]
    async fn maildir_store_updates_a_verified_registry_without_a_relisting() {
        let (t, s) = st(true);
        let reg = &s.vault_registry;
        assert_eq!(reg.uid_sets(t.path(), "acc", "INBOX"), Some((vec![], vec![])));
        assert_eq!(reg.listing_count(), 1);
        let r = call(&s, "maildir_store", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "rawSourceBase64": b64(b"From: a@b.com\r\n\r\nbody"), "flags": ["archived"]})).await;
        assert!(r.error.is_none(), "{:?}", r.error);
        assert_eq!(reg.uid_sets(t.path(), "acc", "INBOX"), Some((vec![7], vec![7])));
        assert_eq!(reg.listing_count(), 1);
    }

    #[tokio::test]
    async fn maildir_store_overwrites_and_removes_the_old_differently_named_file() {
        let (t, s) = st(true);
        call(&s, "maildir_store", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "rawSourceBase64": b64(b"one"), "flags": ["seen"]})).await;
        call(&s, "maildir_store", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "rawSourceBase64": b64(b"two"), "flags": ["flagged", "seen"]})).await;
        let cur = vault_files::cur_path(t.path(), "acc", "INBOX");
        let names: Vec<String> = fs::read_dir(&cur).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["7:2,FS.eml"]);
    }

    #[tokio::test]
    async fn maildir_store_bad_base64_is_invalid_params_and_writes_nothing() {
        let (t, s) = st(true);
        let r = call(&s, "maildir_store", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "rawSourceBase64": "not-base64!!", "flags": []})).await;
        let err = r.error.unwrap();
        assert_eq!(err.code, crate::ipc::INVALID_PARAMS);
        assert!(!vault_files::cur_path(t.path(), "acc", "INBOX").exists());
    }

    #[tokio::test]
    async fn maildir_delete_nudges_only_when_a_file_was_removed() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let rx = signal_channel(&s);
        let r = call(&s, "maildir_delete", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7})).await;
        assert!(r.error.is_none());
        assert!(!vault_files::cur_path(t.path(), "acc", "INBOX").join("7:2,.eml").exists());
        assert!(rx.try_recv().is_ok(), "a real removal must nudge");

        // A second delete of the same (now absent) uid removes nothing and
        // must not nudge again.
        call(&s, "maildir_delete", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7})).await;
        assert!(rx.try_recv().is_err(), "deleting an already-gone uid must not nudge");
    }

    #[tokio::test]
    async fn maildir_set_flags_renames_nudges_and_reports_uid_not_in_maildir() {
        let (t, s) = st(true);
        seed_email(t.path(), "acc", "INBOX", 7);
        let rx = signal_channel(&s);
        let r = call(&s, "maildir_set_flags", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "flags": ["seen", "flagged"]})).await;
        assert!(r.error.is_none(), "{:?}", r.error);
        let cur = vault_files::cur_path(t.path(), "acc", "INBOX");
        assert!(cur.join("7:2,FS.eml").exists());
        assert!(rx.try_recv().is_ok(), "a real rename must nudge");

        // Re-applying the same flags is a no-rename no-op: no second nudge.
        call(&s, "maildir_set_flags", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7, "flags": ["seen", "flagged"]})).await;
        assert!(rx.try_recv().is_err(), "an unchanged filename must not nudge");

        let r = call(&s, "maildir_set_flags", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 999, "flags": ["seen"]})).await;
        assert_eq!(r.error.unwrap().message, "E_UID_NOT_IN_MAILDIR: Email UID 999 not found in Maildir");
    }

    #[tokio::test]
    async fn maildir_clear_cache_deletes_and_sweeps_when_something_was_deleted() {
        let (t, s) = st(true);
        let cur = vault_files::cur_path(t.path(), "acc", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join("1:2,S.eml"), b"a").unwrap();
        fs::write(cur.join("2:2,AS.eml"), b"b").unwrap(); // archived: must survive
        let rx = signal_channel(&s);

        let r = call(&s, "maildir_clear_cache", json!({})).await;
        let v = r.result.unwrap();
        assert_eq!(v["deletedCount"], json!(1));
        assert_eq!(v["skippedArchived"], json!(1));
        assert!(!cur.join("1:2,S.eml").exists());
        assert!(cur.join("2:2,AS.eml").exists());
        assert_eq!(rx.try_recv().unwrap(), mailvault_core::search_index::plan::Signal::Sweep);
    }

    #[tokio::test]
    async fn maildir_clear_cache_no_sweep_when_nothing_was_deleted() {
        let (t, s) = st(true);
        let cur = vault_files::cur_path(t.path(), "acc", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join("1:2,AS.eml"), b"a").unwrap(); // archived only
        let rx = signal_channel(&s);

        call(&s, "maildir_clear_cache", json!({})).await;
        assert!(rx.try_recv().is_err(), "nothing deleted must not sweep");
    }

    #[tokio::test]
    async fn maildir_migrate_json_to_eml_writes_the_eml_and_never_nudges() {
        let (t, s) = st(true);
        let cur = vault_files::cur_path(t.path(), "acc", "INBOX");
        fs::create_dir_all(&cur).unwrap();
        fs::write(cur.join("7.json"), json!({"rawSource": b64(b"body")}).to_string()).unwrap();
        let rx = signal_channel(&s);

        let r = call(&s, "maildir_migrate_json_to_eml", json!({})).await;
        let summary = r.result.unwrap();
        assert!(summary.as_str().unwrap().contains("Migrated: 1"), "{summary}");
        assert!(cur.join("7:2,AS.eml").exists());
        assert!(!cur.join("7.json").exists());
        assert!(rx.try_recv().is_err(), "inventory §4: this legacy-only path never nudges");
    }

    #[tokio::test]
    async fn maildir_migrate_email_dirs_moves_files_and_sweeps_when_migrated() {
        let (t, s) = st(true);
        let src_cur = vault_files::cur_path(t.path(), "user@example.com", "INBOX");
        fs::create_dir_all(&src_cur).unwrap();
        fs::write(src_cur.join("1:2,S.eml"), b"a").unwrap();
        let rx = signal_channel(&s);

        let r = call(&s, "maildir_migrate_email_dirs", json!({"accountMap": {"user@example.com": "uuid-123"}})).await;
        let v = r.result.unwrap();
        assert_eq!(v["migrated"], json!(1));
        assert!(vault_files::cur_path(t.path(), "uuid-123", "INBOX").join("1:2,S.eml").exists());
        assert_eq!(rx.try_recv().unwrap(), mailvault_core::search_index::plan::Signal::Sweep);
    }

    #[tokio::test]
    async fn maildir_migrate_email_dirs_no_sweep_when_nothing_migrated() {
        let (_t, s) = st(true);
        let rx = signal_channel(&s);
        let r = call(&s, "maildir_migrate_email_dirs", json!({"accountMap": {}})).await;
        assert_eq!(r.result.unwrap()["migrated"], json!(0));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn maildir_migrate_email_dirs_missing_account_map_is_invalid_params() {
        let (_t, s) = st(true);
        let r = call(&s, "maildir_migrate_email_dirs", json!({})).await;
        assert_eq!(r.error.unwrap().code, crate::ipc::INVALID_PARAMS);
    }

    // Two-tempdir gate proof (2.6/2.7 review I2/I3 pattern): every Task 2.8
    // writer refuses with `E_VAULT_UNAVAILABLE:` and creates nothing under
    // EITHER root, both when the folder is unreachable and while the vault
    // is closed for a move.
    async fn assert_task_2_8_writers_are_gated(vault: &std::path::Path, app_dir: &std::path::Path, s: &Arc<DaemonState>) {
        let raw = b64(b"x");
        for (method, params) in [
            ("maildir_store", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 1, "rawSourceBase64": raw, "flags": []})),
            ("maildir_delete", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 1})),
            ("maildir_set_flags", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 1, "flags": ["seen"]})),
            ("maildir_clear_cache", json!({})),
            ("maildir_migrate_json_to_eml", json!({})),
            ("maildir_migrate_email_dirs", json!({"accountMap": {}})),
        ] {
            let r = call(s, method, params).await;
            let err = r.error.unwrap_or_else(|| panic!("{method} must refuse while gated"));
            assert!(err.message.starts_with("E_VAULT_UNAVAILABLE:"), "{method}: {}", err.message);
        }
        assert!(!vault.join("Maildir").exists());
        assert!(!app_dir.join("Maildir").exists());
    }

    #[tokio::test]
    async fn every_task_2_8_writer_is_gated_when_the_folder_is_unreachable() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), false);
        assert_task_2_8_writers_are_gated(vault.path(), app_dir.path(), &s).await;
    }

    #[tokio::test]
    async fn every_task_2_8_writer_is_gated_while_the_vault_is_being_moved() {
        let vault = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(vault.path().to_path_buf(), app_dir.path().to_path_buf(), true);
        s.vault_closed.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_task_2_8_writers_are_gated(vault.path(), app_dir.path(), &s).await;
    }
}
