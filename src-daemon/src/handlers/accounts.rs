//! Callable native account capability; application adapter cutover is pending.
//!
//! - `accounts.list {}`: `{accounts, version}` (`recovered` names where the
//!   list came from when the file on disk is broken).
//! - `accounts.get {id}`: `{account, version}`, `account` null when unknown.
//! - `accounts.put {entries | entry, ifAbsent?, baseVersion?}`: each entry is
//!   merged onto the one with its id, or appended; with `ifAbsent` only ids
//!   and identities the list lacks are appended. `{version, changed}`.
//! - `accounts.remove {ids | id, baseVersion?}`, `accounts.reorder {ids,
//!   baseVersion?}`, `accounts.replace_all {entries, baseVersion?}`: `{version,
//!   changed}`.
//!
//! The params are never named `account`: `oauth_tokens::inject` puts tokens
//! into such params, and `inject` skips this namespace as well. A write that
//! changed something emits `accounts-changed {ids, version}`: ids only.
//! Errors are catalog keys (`errors.accounts*`).

use crate::account_lifecycle::{ImportTargetReservation, PersistenceAuthority, PersistenceOwner};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::accounts_doc::{self, AccountsError};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) const CHANGED_EVENT: &str = "accounts-changed";

pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    if matches!(method, "accounts.add" | "accounts.update") {
        return Some(
            Box::pin(crate::account_workflows::account_workflow(
                state,
                params,
                id,
                method == "accounts.add",
            ))
            .await,
        );
    }
    if method == "accounts.save" {
        return Some(crate::account_workflows::save(state, params, id).await);
    }
    if !accounts_doc::METHODS.contains(&method) {
        return None;
    }
    let state = Arc::clone(state);
    let method = method.to_owned();
    let params = params.clone();
    let failed_id = id.clone();
    // The operation/event owner survives a caller disappearing during either
    // preservation or a running blocking document write.
    Some(
        tokio::spawn(async move { run_owned(&state, &method, &params, id).await })
            .await
            .unwrap_or_else(|_| {
                RpcResponse::error(failed_id, ipc::INTERNAL_ERROR, "errors.accountsWriteFailed")
            }),
    )
}

fn scope(
    listed: Option<&accounts_doc::Listing>,
    method: &str,
    params: &Value,
) -> Result<crate::account_workflows::AccountWriteScope, AccountsError> {
    use crate::account_workflows::AccountWriteScope;
    let mut scope = AccountWriteScope::default();
    let Some(listed) = listed else {
        scope.whole_store = true;
        return Ok(scope);
    };
    if matches!(method, "accounts.replace_all" | "accounts.reorder")
        || !accounts_doc::legacy_secrets_representable(&listed.accounts)
    {
        scope.whole_store = true;
        return Ok(scope);
    }
    for (id, raw) in accounts_doc::legacy_secrets(&listed.accounts) {
        let v: Value = serde_json::from_str(&raw).map_err(|_| AccountsError::Invalid)?;
        scope.record(&id, &v);
    }
    let requested = if method == "accounts.put" {
        match (params.get("entries"), params.get("entry")) {
            (Some(Value::Array(v)), _) => v.clone(),
            (None, Some(v)) if v.is_object() => vec![v.clone()],
            _ => return Err(AccountsError::Invalid),
        }
    } else {
        let ids = if let Some(id) = params.get("id").and_then(Value::as_str) {
            vec![id.to_owned()]
        } else {
            params
                .get("ids")
                .and_then(Value::as_array)
                .ok_or(AccountsError::Invalid)?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or(AccountsError::Invalid))
                .collect::<Result<Vec<_>, _>>()?
        };
        ids.into_iter().map(|id| json!({"id":id})).collect()
    };
    for entry in requested {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(AccountsError::Invalid)?;
        scope.ids.insert(id.to_owned());
        let old = listed
            .accounts
            .iter()
            .find(|v| v.get("id").and_then(Value::as_str) == Some(id));
        if let Some(old) = old {
            scope.record(id, old);
        }
        if method == "accounts.put" {
            let mut new = old.cloned().unwrap_or_else(|| json!({}));
            new.as_object_mut()
                .ok_or(AccountsError::Invalid)?
                .extend(entry.as_object().ok_or(AccountsError::Invalid)?.clone());
            scope.record(id, &new);
        }
    }
    Ok(scope)
}

fn zip_completion(
    state: &DaemonState,
    method: &str,
    params: &Value,
) -> Result<Option<(String, Vec<(crate::backup_zip::AccountsJsonEntry, ImportTargetReservation)>)>, AccountsError> {
    let Some(fields) = params.as_object() else { return Err(AccountsError::Invalid) };
    if !fields.contains_key("importIntentId") { return Ok(None); }
    if method != "accounts.put" || fields.len() != 3
        || fields.get("ifAbsent") != Some(&Value::Bool(true))
    {
        return Err(AccountsError::Invalid);
    }
    let intent = fields.get("importIntentId").and_then(Value::as_str)
        .filter(|value| !value.is_empty()).ok_or(AccountsError::Invalid)?;
    let entries = fields.get("entries").and_then(Value::as_array)
        .filter(|entries| !entries.is_empty()).ok_or(AccountsError::Invalid)?;
    let mut ids = std::collections::BTreeSet::new();
    let mut emails = std::collections::BTreeSet::new();
    let mut targets = Vec::with_capacity(entries.len());
    for raw in entries {
        let descriptor: crate::backup_zip::AccountsJsonEntry = serde_json::from_value(raw.clone())
            .map_err(|_| AccountsError::Invalid)?;
        if serde_json::to_value(&descriptor).map_err(|_| AccountsError::Invalid)? != *raw
            || descriptor.id.is_empty()
            || !ids.insert(descriptor.id.clone())
            || !descriptor.email.as_ref().is_some_and(|email| !email.is_empty() && emails.insert(email.clone()))
        {
            return Err(AccountsError::Invalid);
        }
        let reservation = state.zip_intents.reservation_for(intent, &descriptor)
            .ok_or(AccountsError::Invalid)?;
        targets.push((descriptor, reservation));
    }
    Ok(Some((intent.to_owned(), targets)))
}

async fn run_owned(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> RpcResponse {
    let doc = accounts_doc::shared(&state.app_dir);
    let mut owner: Option<PersistenceOwner> = None;
    let mut zip_owners: Option<(String, Vec<(crate::backup_zip::AccountsJsonEntry, PersistenceOwner)>)> = None;
    let mut preserved = None;
    let mut recovery = None;
    if accounts_doc::writes(method) {
        if !state.account_lifecycle.is_ready() {
            crate::account_lifecycle::start_bootstrap(Arc::clone(state));
        }
        let read = Arc::clone(&doc);
        let listed = tokio::task::spawn_blocking(move || accounts_doc::list(&read))
            .await
            .ok()
            .and_then(Result::ok);
        let Some(listed) = listed else {
            return RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.accountsWriteFailed");
        };
        let mut scope = match scope(Some(&listed), method, params) {
            Ok(s) => s,
            Err(e) => return RpcResponse::error(id, ipc::INVALID_PARAMS, e.catalog_key()),
        };
        let zip_targets = match zip_completion(state, method, params) {
            Ok(targets) => targets,
            Err(e) => return RpcResponse::error(id, ipc::INVALID_PARAMS, e.catalog_key()),
        };
        if scope.whole_store {
            scope
                .ids
                .extend(accounts_doc::authoritative_ids(&listed.accounts));
            if method == "accounts.replace_all" {
                if let Some(entries) = params.get("entries").and_then(Value::as_array) {
                    scope.ids.extend(accounts_doc::authoritative_ids(entries));
                }
            }
        }
        let held = match state.account_admission.try_reserve(scope.clone()) {
            Ok(l) => l,
            Err(e) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, e.catalog_key()),
        };
        let mut lifecycle_scope = scope;
        let present = accounts_doc::authoritative_ids(&listed.accounts);
        if method == "accounts.remove" {
            lifecycle_scope.ids.retain(|id| present.contains(id));
        }
        let mut skipped_put = std::collections::BTreeSet::new();
        let additions: std::collections::BTreeSet<String> = match method {
            "accounts.put" => {
                let entries = params
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| params.get("entry").cloned().into_iter().collect());
                let if_absent = params.get("ifAbsent").and_then(Value::as_bool) == Some(true);
                let mut seen_ids: std::collections::HashSet<String> = listed
                    .accounts
                    .iter()
                    .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
                    .collect();
                let mut seen_keys: std::collections::HashSet<String> = listed
                    .accounts
                    .iter()
                    .map(accounts_doc::logical_key)
                    .collect();
                let mut added = std::collections::BTreeSet::new();
                for entry in entries {
                    let Some(target) = entry.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let key = accounts_doc::logical_key(&entry);
                    if if_absent && (seen_ids.contains(target) || seen_keys.contains(&key)) {
                        skipped_put.insert(target.to_owned());
                        continue;
                    }
                    seen_ids.insert(target.to_owned());
                    seen_keys.insert(key);
                    if !present.contains(target) {
                        added.insert(target.to_owned());
                    }
                }
                added
            }
            "accounts.replace_all" => params
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    accounts_doc::authoritative_ids(entries)
                        .difference(&present)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default(),
            _ => Default::default(),
        };
        lifecycle_scope.ids.extend(additions.iter().cloned());
        for skipped in &skipped_put {
            if !present.contains(skipped) && !additions.contains(skipped) {
                lifecycle_scope.ids.remove(skipped);
            }
        }
        let held_owner = if let Some((intent, targets)) = zip_targets {
            let target_ids: std::collections::BTreeSet<_> = targets.iter().map(|(descriptor, _)| descriptor.id.clone()).collect();
            if additions != target_ids || !skipped_put.is_empty() {
                return RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.accountsConflict");
            }
            let preservation_ids: std::collections::BTreeSet<_> = lifecycle_scope.ids.difference(&additions).cloned().collect();
            let mut acquired = Vec::with_capacity(targets.len());
            for (descriptor, reservation) in targets {
                let mut ids = preservation_ids.clone();
                ids.insert(descriptor.id.clone());
                let target_scope = crate::account_workflows::AccountWriteScope {
                    ids, keys: lifecycle_scope.keys.clone(), whole_store: false,
                };
                let acquired_owner = match state.account_lifecycle.try_import_persistence(
                    held.clone(), &target_scope, &reservation,
                ) {
                    Ok(owner) => owner,
                    Err(_) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.keychainBusy"),
                };
                acquired.push((descriptor, acquired_owner));
            }
            let preservation_owner = acquired[0].1.clone();
            zip_owners = Some((intent, acquired));
            preservation_owner
        } else {
            let authority = if additions.is_empty() {
                PersistenceAuthority::Ordinary
            } else {
                match state.account_lifecycle.reserve_creation(&held, &listed, &additions) {
                    Ok(reservation) => PersistenceAuthority::Create(reservation),
                    Err(_) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.keychainBusy"),
                }
            };
            match state.account_lifecycle.try_persistence(held, &lifecycle_scope, authority) {
                Ok(owner) => owner,
                Err(_) => return RpcResponse::error(id, ipc::INTERNAL_ERROR, "errors.keychainBusy"),
            }
        };
        {
            if accounts_doc::legacy_secrets_representable(&listed.accounts) {
                let records: std::collections::HashMap<_, _> =
                    accounts_doc::legacy_secrets(&listed.accounts)
                        .into_iter()
                        .collect();
                if records.is_empty() {
                    preserved = Some(listed)
                } else {
                    #[cfg(test)]
                    PRESERVATION_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    match crate::credentials::change_credentials_admitted_owned(
                        state,
                        crate::credentials::CredChange::SaveIfAbsent(records),
                        held_owner.clone(),
                    )
                    .await
                    {
                        Ok(_) => preserved = Some(listed),
                        // No preservation write was started. Retain the existing
                        // live-secret read-failure policy under this valid lease.
                        Err(crate::credentials::CredError::Unavailable) => {}
                        Err(e) => {
                            return RpcResponse::error(id, ipc::INTERNAL_ERROR, e.catalog_key())
                        }
                    }
                }
            }
        }
        if zip_owners.is_none() { owner = Some(held_owner); }
        #[cfg(test)]
        pause_after_preservation(&state.app_dir).await;
    } else if method == "accounts.list" {
        if let Some(marker) = state.account_lifecycle.pending_uncertain() {
            if let Ok(lease) =
                state
                    .account_admission
                    .try_reserve(crate::account_workflows::AccountWriteScope {
                        whole_store: true,
                        ..Default::default()
                    })
            {
                recovery = Some((marker, lease));
            }
        }
    }
    let method = method.to_owned();
    let params = params.clone();
    let state = Arc::clone(state);
    let joined = tokio::task::spawn_blocking(move || {
        let _owner = owner;
        let _zip_owners = zip_owners;
        #[cfg(test)]
        let _done = pause_document(&state.app_dir);
        let policy = preserved
            .as_ref()
            .map(accounts_doc::LiveScrub::Preserved)
            .unwrap_or(accounts_doc::LiveScrub::Preserve);
        let out = accounts_doc::run(&doc, &method, &params, policy)?;
        if let Some((marker, lease)) = recovery {
            let listing = accounts_doc::Listing {
                accounts: out.reply["accounts"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                version: out.reply["version"].as_u64().unwrap_or_default(),
                recovered: out
                    .reply
                    .get("recovered")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
            let _ = state
                .account_lifecycle
                .recover_uncertain_membership(&marker, &lease, &listing);
        }
        if let Some((intent, owners)) = &_zip_owners {
            for (descriptor, owner) in owners {
                state.account_lifecycle.apply_committed_membership(Some(owner), &out.membership);
                state.zip_intents.consume_confirmed(intent, descriptor, &out.membership.added);
            }
        } else {
            state.account_lifecycle.apply_committed_membership(_owner.as_ref(), &out.membership);
        }
        if let Some(change) = &out.changed {
            state.events.emit(
                CHANGED_EVENT,
                json!({"ids":change.changed,"version":change.version}),
            );
        }
        Ok::<_, AccountsError>(out)
    })
    .await;
    match joined.unwrap_or_else(|_| Err(AccountsError::Io("accounts task failed".into()))) {
        Ok(out) => RpcResponse::success(id, out.reply),
        Err(e) => RpcResponse::error(
            id,
            if matches!(e, AccountsError::Invalid) {
                ipc::INVALID_PARAMS
            } else {
                ipc::INTERNAL_ERROR
            },
            e.catalog_key(),
        ),
    }
}

#[cfg(test)]
struct DocumentGate {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
    done: std::sync::mpsc::Sender<()>,
}
#[cfg(test)]
fn document_gates(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, DocumentGate>> {
    static GATES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, DocumentGate>>,
    > = std::sync::OnceLock::new();
    GATES.get_or_init(Default::default)
}
#[cfg(test)]
fn pause_document(path: &std::path::Path) -> Option<crate::credentials::TestTaskDone> {
    let gate = document_gates().lock().unwrap().remove(path);
    gate.map(|gate| {
        let _ = gate.entered.send(());
        let _ = gate.release.recv();
        crate::credentials::TestTaskDone(gate.done)
    })
}

#[cfg(test)]
static PRESERVATION_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
type PreservationPause = (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);
#[cfg(test)]
fn preservation_pauses(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, PreservationPause>> {
    static PAUSES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, PreservationPause>>,
    > = std::sync::OnceLock::new();
    PAUSES.get_or_init(Default::default)
}
#[cfg(test)]
async fn pause_after_preservation(path: &std::path::Path) {
    let pause = preservation_pauses().lock().unwrap().get(path).cloned();
    if let Some((entered, release)) = pause {
        entered.notify_one();
        release.notified().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{handle_request_for_test, DaemonState};
    use std::io::Write;

    fn p6_zip_fixture(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("p6-accounts.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        let manifest = crate::backup_zip::BackupManifest {
            version: 2,
            exported_at: "2026-01-01T00:00:00Z".into(),
            accounts: ["alice@test.com", "bob@test.com"].into_iter().map(|email| {
                crate::backup_zip::BackupAccount {
                    email: email.into(), imap_server: Some("imap.test".into()), smtp_server: None,
                }
            }).collect(),
            settings: None,
        };
        zip.start_file("mailvault-backup/manifest.json", options).unwrap();
        zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
        for (email, uid) in [("alice@test.com", 11u32), ("bob@test.com", 12u32)] {
            zip.start_file(format!("mailvault-backup/emails/{email}/INBOX/{uid}:2,.eml"), options).unwrap();
            zip.write_all(b"Subject: imported\r\n\r\nsynthetic body").unwrap();
        }
        zip.finish().unwrap();
        path
    }

    struct DocPause {
        release: Option<std::sync::mpsc::Sender<()>>,
        entered: std::sync::mpsc::Receiver<()>,
        done: Option<std::sync::mpsc::Receiver<()>>,
    }
    impl DocPause {
        fn arm(state: &Arc<DaemonState>) -> Self {
            let (release, gate) = std::sync::mpsc::channel();
            let (entered, notice) = std::sync::mpsc::channel();
            let (done, finished) = std::sync::mpsc::channel();
            document_gates().lock().unwrap().insert(
                state.app_dir.clone(),
                DocumentGate {
                    entered,
                    release: gate,
                    done,
                },
            );
            Self {
                release: Some(release),
                entered: notice,
                done: Some(finished),
            }
        }
        fn entered(&self) {
            self.entered
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("real document child entered");
        }
        fn finish(&mut self) {
            self.release.take();
            self.done
                .take()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("real document child and event drained");
        }
    }
    impl Drop for DocPause {
        fn drop(&mut self) {
            self.release.take();
            if let Some(done) = self.done.take() {
                if done
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .is_err()
                {
                    std::process::abort();
                }
            }
        }
    }

    struct TestScope {
        dir: tempfile::TempDir,
        _restore: crate::credentials::TestEnvRestore,
        _env: std::sync::MutexGuard<'static, ()>,
    }
    impl std::ops::Deref for TestScope {
        type Target = tempfile::TempDir;
        fn deref(&self) -> &Self::Target {
            &self.dir
        }
    }
    fn rig() -> (TestScope, Arc<DaemonState>) {
        let env = crate::credentials::test_env_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let restore = crate::credentials::TestEnvRestore::capture();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(
            "MAILVAULT_TEST_CREDENTIALS",
            dir.path().join("credentials.json"),
        );
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        (
            TestScope {
                dir,
                _restore: restore,
                _env: env,
            },
            state,
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p6_zip_batch_activates_only_exact_reserved_descriptors() {
        let (dir, state) = rig();
        std::fs::write(dir.path().join("accounts.json"), "[]").unwrap();
        std::fs::write(dir.path().join("credentials.json"), "{}").unwrap();
        let imported = crate::backup_zip::import(&state, p6_zip_fixture(dir.path()), Vec::new(), |_, _| {}).unwrap();
        assert!(imported.complete);
        assert_eq!(imported.new_accounts.len(), 2);
        let entries = serde_json::to_value(&imported.new_accounts).unwrap();
        for descriptor in &imported.new_accounts {
            let uid = if descriptor.email.as_deref() == Some("alice@test.com") { 11u32 } else { 12u32 };
            assert!(mailvault_core::message_store::read_raw(&dir.path().join("mail"), &descriptor.id, "INBOX", uid).unwrap().is_some());
            assert!(state.account_lifecycle.capture(&descriptor.id).is_err());
        }
        assert_eq!(call(&state, "accounts.put", json!({"entries":entries.clone(),"ifAbsent":true})).await,
            Err("errors.keychainBusy".into()));
        assert_eq!(on_disk(&dir), json!([]));
        let mut forged = entries.clone();
        forged[0]["imapHost"] = json!("forged.test");
        assert!(call(&state, "accounts.put", json!({"entries":forged,"ifAbsent":true,"importIntentId":imported.import_intent_id.clone()})).await.is_err());
        assert_eq!(on_disk(&dir), json!([]));
        let completed = call(&state, "accounts.put", json!({"entries":entries,"ifAbsent":true,"importIntentId":imported.import_intent_id})).await.unwrap();
        assert_eq!(completed["changed"].as_array().unwrap().len(), 2);
        assert_eq!(on_disk(&dir).as_array().unwrap().len(), 2);
        for descriptor in &imported.new_accounts {
            assert!(state.account_lifecycle.capture(&descriptor.id).is_ok());
            assert!(state.zip_intents.reservation_for(&imported.import_intent_id, descriptor).is_none());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p6_zip_late_document_child_consumes_actual_membership() {
        let (dir, state) = rig();
        std::fs::write(dir.path().join("accounts.json"), "[]").unwrap();
        std::fs::write(dir.path().join("credentials.json"), "{}").unwrap();
        let imported = crate::backup_zip::import(&state, p6_zip_fixture(dir.path()), Vec::new(), |_, _| {}).unwrap();
        let entries = serde_json::to_value(&imported.new_accounts).unwrap();
        let mut pause = DocPause::arm(&state);
        let held = Arc::clone(&state);
        let intent = imported.import_intent_id.clone();
        let waiter = tokio::spawn(async move {
            call(&held, "accounts.put", json!({"entries":entries,"ifAbsent":true,"importIntentId":intent})).await
        });
        pause.entered();
        assert_eq!(on_disk(&dir), json!([]));
        for descriptor in &imported.new_accounts {
            assert!(state.account_lifecycle.capture(&descriptor.id).is_err());
        }
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        pause.finish();
        assert_eq!(on_disk(&dir).as_array().unwrap().len(), 2);
        for descriptor in &imported.new_accounts {
            assert!(state.account_lifecycle.capture(&descriptor.id).is_ok());
            assert!(state.zip_intents.reservation_for(&imported.import_intent_id, descriptor).is_none());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p6_zip_failed_or_unknown_commit_never_fabricates_activation() {
        let (dir, state) = rig();
        std::fs::write(dir.path().join("accounts.json"), "[]").unwrap();
        std::fs::write(dir.path().join("credentials.json"), "{}").unwrap();
        let imported = crate::backup_zip::import(&state, p6_zip_fixture(dir.path()), Vec::new(), |_, _| {}).unwrap();
        let entries = serde_json::to_value(&imported.new_accounts).unwrap();
        let mut pause = DocPause::arm(&state);
        let held = Arc::clone(&state);
        let intent = imported.import_intent_id.clone();
        let waiter = tokio::spawn(async move {
            call(&held, "accounts.put", json!({"entries":entries,"ifAbsent":true,"importIntentId":intent})).await
        });
        pause.entered();
        let path = dir.path().join("accounts.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        pause.finish();
        for descriptor in &imported.new_accounts {
            assert!(state.account_lifecycle.capture(&descriptor.id).is_err());
            assert!(state.zip_intents.reservation_for(&imported.import_intent_id, descriptor).is_some());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_n2_new_target_reservation_activates_after_document_commit() {
        let (dir, state) = rig();
        std::fs::write(dir.path().join("accounts.json"), "[]").unwrap();
        state
            .account_lifecycle
            .seed(&accounts_doc::list(&accounts_doc::shared(dir.path())).unwrap());
        let mut pause = DocPause::arm(&state);
        let held = Arc::clone(&state);
        let pending = tokio::spawn(async move {
            call(
                &held,
                "accounts.put",
                json!({"entry":{"id":"a","email":"a@example.test"}}),
            )
            .await
        });
        pause.entered();
        let before = state.account_lifecycle.capture("a").is_err();
        pause.finish();
        let added = pending.await.unwrap();
        let open = state.account_lifecycle.capture("a").is_ok();
        let replaced = call(
            &state,
            "accounts.replace_all",
            json!({"entries":[{"id":"b"}]}),
        )
        .await;
        let retired = matches!(
            state.account_lifecycle.capture("a"),
            Err(crate::account_lifecycle::LifecycleError::RetiredIds(_))
        );
        let b_open = state.account_lifecycle.capture("b").is_ok();
        let retry = call(&state, "accounts.put", json!({"entry":{"id":"a"}})).await;
        assert!(before && added.is_ok() && open && replaced.is_ok() && retired && b_open && retry == Err("errors.keychainBusy".into()),
            "N2 reservation: before={before}, added={}, open={open}, replaced={}, retired={retired}, b_open={b_open}, retry={retry:?}", added.is_ok(), replaced.is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_closing_other_legacy_id_refuses_preservation() {
        let (dir, state) = rig();
        let metadata = json!([
            {"id":"a","email":"a@example.test","imapHost":"h"},
            {"id":"b","email":"b@example.test","imapHost":"h","password":"synthetic-legacy"}
        ]);
        std::fs::write(dir.path().join("accounts.json"), metadata.to_string()).unwrap();
        std::fs::write(dir.path().join("credentials.json"), "{}").unwrap();
        state
            .account_lifecycle
            .seed(&accounts_doc::list(&accounts_doc::shared(dir.path())).unwrap());
        let mut exact = crate::account_workflows::AccountWriteScope::default();
        exact.ids.insert("b".into());
        let claim = state
            .account_lifecycle
            .try_close(
                crate::account_workflows::AccountLease::detached_for_test(exact),
                "b",
            )
            .unwrap();
        let result = call(
            &state,
            "accounts.put",
            json!({"entry":{"id":"a","name":"forbidden"}}),
        )
        .await;
        let blob: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("credentials.json")).unwrap())
                .unwrap();
        let preserved_other = blob.get("b").is_some();
        let document_changed = on_disk(&dir) != metadata;
        assert!(result.is_err() && !preserved_other && !document_changed,
            "real N2 route must refuse another Closing legacy ID; preserved_other={preserved_other}, document_changed={document_changed}");
        assert_eq!(on_disk(&dir), metadata);
        assert_eq!(blob, json!({}));
        drop(claim);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_preservation_and_document_child_keep_other_id_owner() {
        let (dir, state) = rig();
        std::fs::write(
            dir.path().join("accounts.json"),
            json!([
                {"id":"a","email":"a@example.test","imapHost":"h"},
                {"id":"b","email":"b@example.test","imapHost":"h","password":"synthetic-legacy"}
            ])
            .to_string(),
        )
        .unwrap();
        std::fs::write(dir.path().join("credentials.json"), "{}").unwrap();
        state
            .account_lifecycle
            .seed(&accounts_doc::list(&accounts_doc::shared(dir.path())).unwrap());
        let pause = (
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
        );
        preservation_pauses()
            .lock()
            .unwrap()
            .insert(state.app_dir.clone(), pause.clone());
        let guard = PauseGuard(state.app_dir.clone(), pause.clone());
        let state_for_task = Arc::clone(&state);
        let writing = tokio::spawn(async move {
            call(
                &state_for_task,
                "accounts.put",
                json!({"entry":{"id":"a","name":"changed"}}),
            )
            .await
        });
        pause.0.notified().await;
        let mut exact = crate::account_workflows::AccountWriteScope::default();
        exact.ids.insert("b".into());
        let busy_during_preservation = state
            .account_lifecycle
            .try_close(
                crate::account_workflows::AccountLease::detached_for_test(exact.clone()),
                "b",
            )
            .is_err();
        pause.1.notify_one();
        drop(guard);
        let written = writing.await.unwrap();
        let eligible_after_document = state
            .account_lifecycle
            .try_close(
                crate::account_workflows::AccountLease::detached_for_test(exact),
                "b",
            )
            .is_ok();
        assert!(written.is_ok() && busy_during_preservation && eligible_after_document,
            "N2 owner: written_ok={}, busy_during_preservation={busy_during_preservation}, eligible_after_document={eligible_after_document}", written.is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_late_document_remove_retires_after_real_child_and_replace_all_retires() {
        let (dir, state) = rig();
        std::fs::write(
            dir.path().join("accounts.json"),
            json!([
                {"id":"a","email":"a@example.test","imapHost":"h"},
                {"id":"b","email":"b@example.test","imapHost":"h"}
            ])
            .to_string(),
        )
        .unwrap();
        state
            .account_lifecycle
            .seed(&accounts_doc::list(&accounts_doc::shared(dir.path())).unwrap());
        let mut pause = DocPause::arm(&state);
        let state_for_task = Arc::clone(&state);
        let task = tokio::spawn(async move {
            call(&state_for_task, "accounts.remove", json!({"id":"a"})).await
        });
        pause.entered();
        let open_before_commit = state.account_lifecycle.capture("a").is_ok();
        task.abort();
        let _ = task.await;
        pause.finish();
        let retired_after_child = matches!(
            state.account_lifecycle.capture("a"),
            Err(crate::account_lifecycle::LifecycleError::RetiredIds(_))
        );
        let b_open = state.account_lifecycle.capture("b").is_ok();
        let document_removed = on_disk(&dir)
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["id"] != "a");
        let replaced = call(&state, "accounts.replace_all", json!({"entries":[]})).await;
        let b_retired = matches!(
            state.account_lifecycle.capture("b"),
            Err(crate::account_lifecycle::LifecycleError::RetiredIds(_))
        );
        assert!(open_before_commit && retired_after_child && b_open && document_removed && replaced.is_ok() && b_retired,
            "late membership: open_before_commit={open_before_commit}, retired_after_child={retired_after_child}, b_open={b_open}, document_removed={document_removed}, replaced_ok={}, b_retired={b_retired}", replaced.is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn p1_document_noops_reorder_and_metadata_edit_preserve_membership() {
        let (dir, state) = rig();
        std::fs::write(
            dir.path().join("accounts.json"),
            json!([
                {"id":"a","email":"a@example.test","imapHost":"h"},
                {"id":"b","email":"b@example.test","imapHost":"h"}
            ])
            .to_string(),
        )
        .unwrap();
        state
            .account_lifecycle
            .seed(&accounts_doc::list(&accounts_doc::shared(dir.path())).unwrap());
        let missing = call(&state, "accounts.remove", json!({"id":"missing"})).await;
        let reorder = call(&state, "accounts.reorder", json!({"ids":["b","a"]})).await;
        let edited = call(
            &state,
            "accounts.put",
            json!({"entry":{"id":"a","name":"metadata"}}),
        )
        .await;
        let a_open = state.account_lifecycle.capture("a").is_ok();
        let b_open = state.account_lifecycle.capture("b").is_ok();
        let missing_unknown = matches!(
            state.account_lifecycle.capture("missing"),
            Err(crate::account_lifecycle::LifecycleError::Unknown)
        );
        assert!(missing.is_ok() && reorder.is_ok() && edited.is_ok() && a_open && b_open && missing_unknown,
            "document no-ops preserve membership: missing_ok={}, reorder_ok={}, edited_ok={}, a_open={a_open}, b_open={b_open}, missing_unknown={missing_unknown}", missing.is_ok(), reorder.is_ok(), edited.is_ok());
    }

    fn on_disk(dir: &tempfile::TempDir) -> Value {
        serde_json::from_slice(&std::fs::read(dir.path().join("accounts.json")).unwrap()).unwrap()
    }

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> Result<Value, String> {
        let resp = handle_request_for_test(state, method, params).await;
        match resp.error {
            Some(e) => Err(e.message),
            None => Ok(resp.result.unwrap_or(Value::Null)),
        }
    }

    struct PauseGuard(std::path::PathBuf, PreservationPause);
    impl Drop for PauseGuard {
        fn drop(&mut self) {
            preservation_pauses().lock().unwrap().remove(&self.0);
            self.1 .1.notify_one();
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn metadata_preservation_reserves_legacy_ids_through_document_completion() {
        let (dir, state) = rig();
        std::fs::write(dir.path().join("accounts.json"), json!([{"id":"b","email":"b@example.test","imapHost":"h","password":"synthetic-legacy"}]).to_string()).unwrap();
        std::fs::write(dir.path().join("credentials.json"), "{}").unwrap();
        let pause = (
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
        );
        preservation_pauses()
            .lock()
            .unwrap()
            .insert(state.app_dir.clone(), pause.clone());
        let _guard = PauseGuard(state.app_dir.clone(), pause.clone());
        let writing = call(
            &state,
            "accounts.put",
            json!({"entry":{"id":"a","email":"a@example.test","imapHost":"h"}}),
        );
        let competing = async {
            pause.0.notified().await;
            let result = call(
                &state,
                "credentials.update",
                json!({"id":"b","fields":{"password":"synthetic-other"}}),
            )
            .await;
            pause.1.notify_one();
            result
        };
        let (written, competing) = tokio::join!(writing, competing);
        assert!(written.is_ok());
        assert_eq!(
            competing,
            Err("errors.keychainBusy".to_string()),
            "legacy scope must remain reserved until actual document completion"
        );
        let blob: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("credentials.json")).unwrap())
                .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(blob["b"].as_str().unwrap()).unwrap()["password"],
            "synthetic-legacy"
        );
    }

    async fn snapshot_race(initial_secret: bool) {
        let (dir, state) = rig();
        let a = if initial_secret {
            json!({"id":"a", "password":"legacy-A"})
        } else {
            json!({"id":"a"})
        };
        let path = dir.path().join("accounts.json");
        std::fs::write(&path, json!([a.clone()]).to_string()).unwrap();
        let creds = dir.path().join("credentials.json");
        std::fs::write(&creds, "{}").unwrap();
        let pause = (
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
        );
        preservation_pauses()
            .lock()
            .unwrap()
            .insert(state.app_dir.clone(), pause.clone());
        let guard = PauseGuard(state.app_dir.clone(), pause.clone());
        let mut rx = state.events.subscribe();
        let requested = call(&state, "accounts.put", json!({"entry":{"id":"x"}}));
        let intervene = async {
            pause.0.notified().await;
            let blob: Value = serde_json::from_slice(&std::fs::read(&creds).unwrap()).unwrap();
            assert_eq!(
                blob.get("a").is_some(),
                initial_secret,
                "preservation completed before pause"
            );
            // A compatibility writer completes while preservation holds no document lock.
            let bytes = serde_json::to_vec(&json!([a, {"id":"b", "password":"only-B"}])).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            // A core read can also finish while the route is paused.
            accounts_doc::run(
                &accounts_doc::shared(dir.path()),
                "accounts.reorder",
                &json!({"ids":[]}),
                accounts_doc::LiveScrub::Preserve,
            )
            .unwrap();
            pause.1.notify_one();
            bytes
        };
        let (result, rewritten) = tokio::join!(requested, intervene);
        drop(guard);
        let blob: Value = serde_json::from_slice(&std::fs::read(&creds).unwrap()).unwrap();
        assert!(
            blob.get("b").is_none(),
            "B was not in the preserved snapshot"
        );
        assert_eq!(result, Err("errors.accountsConflict".to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), rewritten);
        assert!(!dir.path().join("accounts.json.bak1").exists());
        while let Ok(line) = rx.try_recv() {
            let (name, _) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            assert_ne!(name, CHANGED_EVENT);
        }
        // The compatibility writer is outside lifecycle ownership. A fresh
        // daemon bootstrap sees its now-authoritative B before retrying X.
        let restarted =
            DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        restarted
            .account_lifecycle
            .seed(&accounts_doc::list(&accounts_doc::shared(dir.path())).unwrap());
        let fresh = call(&restarted, "accounts.list", json!({})).await.unwrap()["version"]
            .as_u64()
            .unwrap();
        call(
            &restarted,
            "accounts.put",
            json!({"entry":{"id":"x"}, "baseVersion":fresh}),
        )
        .await
        .unwrap();
        let blob: Value = serde_json::from_slice(&std::fs::read(&creds).unwrap()).unwrap();
        let b: Value = serde_json::from_str(blob["b"].as_str().unwrap()).unwrap();
        assert_eq!(b["password"], "only-B");
        assert!(on_disk(&dir)
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == "x"));
        assert!(!std::fs::read_to_string(&path).unwrap().contains("only-B"));
    }
    async fn unrepresentable_legacy_retains_fields(entries: Value) {
        let (dir, state) = rig();
        let path = dir.path().join("accounts.json");
        let creds = dir.path().join("credentials.json");
        std::fs::write(&path, entries.to_string()).unwrap();
        std::fs::write(&creds, "{}").unwrap();
        call(&state, "accounts.put", json!({"entry":{"id":"x"}}))
            .await
            .unwrap();
        let live = on_disk(&dir);
        assert_eq!(
            &live.as_array().unwrap()[..entries.as_array().unwrap().len()],
            entries.as_array().unwrap().as_slice(),
            "retained legacy entries must not lose their fields"
        );
        assert_eq!(
            std::fs::read_to_string(&creds).unwrap(),
            "{}",
            "an unrepresentable list skips preservation entirely"
        );
        assert!(
            !std::fs::read_to_string(dir.path().join("accounts.json.bak1"))
                .unwrap()
                .contains("only-secret")
        );
    }
    async fn review_fix_replace_anonymous(legacy: Value) {
        let (dir, state) = rig();
        let path = dir.path().join("accounts.json");
        let creds = dir.path().join("credentials.json");
        std::fs::write(&path, legacy.to_string()).unwrap();
        std::fs::write(&creds, "{}").unwrap();
        let calls = PRESERVATION_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        let generation = crate::credentials::write_generation();
        let mut rx = state.events.subscribe();
        let version = call(&state, "accounts.list", json!({})).await.unwrap()["version"]
            .as_u64()
            .unwrap();
        let out = call(&state, "accounts.replace_all", json!({"entries":[]}))
            .await
            .unwrap();
        assert_eq!(
            PRESERVATION_CALLS.load(std::sync::atomic::Ordering::SeqCst),
            calls
        );
        assert_eq!(crate::credentials::write_generation(), generation);
        assert_eq!(std::fs::read_to_string(&creds).unwrap(), "{}");
        assert_eq!(on_disk(&dir), json!([]));
        assert!(out["version"].as_u64().unwrap() > version);
        assert_eq!(out["changed"], json!([]));
        let event = rx.try_recv().unwrap();
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&event).unwrap();
        assert_eq!(name, CHANGED_EVENT);
        assert_eq!(payload, json!({"ids":[],"version":out["version"]}));
        assert!(
            rx.try_recv().is_err(),
            "no credential event or duplicate account event"
        );
        let bytes = std::fs::read(&path).unwrap();
        let again = call(&state, "accounts.replace_all", json!({"entries":[]}))
            .await
            .unwrap();
        assert_eq!(again, out);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(rx.try_recv().is_err());
        assert_eq!(
            PRESERVATION_CALLS.load(std::sync::atomic::Ordering::SeqCst),
            calls
        );
    }
    #[tokio::test]
    async fn review_fix_replace_missing_id_rows_commits_and_emits_empty_ids() {
        review_fix_replace_anonymous(json!([{"password":"only-secret"}])).await;
    }
    #[tokio::test]
    async fn review_fix_replace_nonstring_id_rows_commits_and_emits_empty_ids() {
        review_fix_replace_anonymous(json!([{"id":7,"password":"only-secret"}])).await;
    }
    #[tokio::test]
    async fn review_fix_if_absent_route_keeps_first_batch_identity_and_distinct_rows() {
        let (dir, state) = rig();
        let mut rx = state.events.subscribe();
        let out = call(&state,"accounts.put",json!({"ifAbsent":true,"entries":[{"id":"a","email":"a@x.test"},{"id":"a","email":"other@x.test"},{"id":"b","email":"A@X.TEST"},{"id":"c","email":"c@x.test"}]})).await.unwrap();
        assert_eq!(
            on_disk(&dir),
            json!([{"id":"a","email":"a@x.test"},{"id":"c","email":"c@x.test"}])
        );
        assert_eq!(out["changed"], json!(["a", "c"]));
        let event = rx.try_recv().unwrap();
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&event).unwrap();
        assert_eq!(name, CHANGED_EVENT);
        assert_eq!(payload, json!({"ids":["a","c"],"version":out["version"]}));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn unrepresentable_legacy_missing_id_is_retained() {
        unrepresentable_legacy_retains_fields(json!([{"password":"only-secret"}])).await;
    }
    #[tokio::test]
    async fn unrepresentable_legacy_empty_id_is_retained() {
        unrepresentable_legacy_retains_fields(json!([{"id":"", "password":"only-secret"}])).await;
    }
    #[tokio::test]
    async fn unrepresentable_legacy_nonstring_id_is_retained() {
        unrepresentable_legacy_retains_fields(json!([{"id":7, "password":"only-secret"}])).await;
    }
    #[tokio::test]
    async fn unrepresentable_legacy_duplicate_secret_ids_are_retained() {
        unrepresentable_legacy_retains_fields(
            json!([{"id":"a", "password":"only-secret-A"},{"id":"a", "password":"only-secret-B"}]),
        )
        .await;
    }
    #[tokio::test]
    async fn unrepresentable_legacy_id_duplicated_by_clean_record_is_retained() {
        unrepresentable_legacy_retains_fields(
            json!([{"id":"a", "password":"only-secret"},{"id":"a"}]),
        )
        .await;
    }

    #[tokio::test]
    async fn changed_legacy_snapshot_is_refused_before_live_scrub() {
        snapshot_race(true).await;
    }
    #[tokio::test]
    async fn changed_no_legacy_snapshot_is_refused_before_live_scrub() {
        snapshot_race(false).await;
    }

    #[tokio::test]
    async fn every_method_is_routed_through_the_server_chain() {
        let (_dir, state) = rig();
        for method in accounts_doc::METHODS {
            let resp = handle_request_for_test(&state, method, json!({})).await;
            if let Some(e) = &resp.error {
                assert!(
                    e.message.starts_with("errors.accounts"),
                    "{method} is not routed: {}",
                    e.message
                );
            }
        }
    }

    #[tokio::test]
    async fn ui_deletion_order_crosschecks_legacy_credential_preservation() {
        let (dir, state) = rig();
        let path = dir.path().join("accounts.json");
        let creds = dir.path().join("credentials.json");
        let a = json!({"id":"a","email":"a@x.test","password":"synthetic-A"});
        let b = json!({"id":"b","email":"b@x.test","password":"synthetic-B"});
        let initial = json!({"a":a.to_string(),"b":b.to_string()});
        let read = || -> Value { serde_json::from_slice(&std::fs::read(&creds).unwrap()).unwrap() };

        std::fs::write(&path, json!([a.clone(), b.clone()]).to_string()).unwrap();
        std::fs::write(&creds, initial.to_string()).unwrap();
        call(&state, "credentials.delete", json!({"ids":["a"]}))
            .await
            .unwrap();
        assert!(read().get("a").is_none());
        call(&state, "accounts.remove", json!({"ids":["a"]}))
            .await
            .unwrap();
        assert_eq!(read()["a"], a.to_string(), "old UI order resurrects A");
        assert_eq!(read()["b"], b.to_string());
        assert_eq!(on_disk(&dir), json!([{"id":"b","email":"b@x.test"}]));

        drop(read);
        drop(state);
        drop(dir);
        // The second UI order is a separate account lifetime. Restoring an
        // already-retired ID by editing the file would violate P1 authority.
        let (dir, state) = rig();
        let path = dir.path().join("accounts.json");
        let creds = dir.path().join("credentials.json");
        let read = || -> Value { serde_json::from_slice(&std::fs::read(&creds).unwrap()).unwrap() };
        std::fs::write(&path, json!([a.clone(), b.clone()]).to_string()).unwrap();
        std::fs::write(&creds, initial.to_string()).unwrap();
        call(&state, "accounts.remove", json!({"ids":["a"]}))
            .await
            .unwrap();
        assert_eq!(
            read()["a"],
            a.to_string(),
            "metadata removal preserves before deleting"
        );
        call(&state, "credentials.delete", json!({"ids":["a"]}))
            .await
            .unwrap();
        assert!(read().get("a").is_none(), "new UI order leaves A absent");
        assert_eq!(read()["b"], b.to_string());
        assert_eq!(on_disk(&dir), json!([{"id":"b","email":"b@x.test"}]));
        // Both awaited credential routes have drained before TestScope restores env.
    }

    #[tokio::test]
    async fn put_list_remove_round_trip_and_keep_the_file_format() {
        let (dir, state) = rig();
        std::fs::write(
            dir.path().join("accounts.json"),
            "[\n  {\n    \"id\": \"old\",\n    \"email\": \"old@x.test\"\n  }\n]",
        )
        .unwrap();
        let listed = call(&state, "accounts.list", json!({})).await.unwrap();
        assert_eq!(
            listed["accounts"],
            json!([{"id": "old", "email": "old@x.test"}])
        );
        let v0 = listed["version"].as_u64().unwrap();

        let put = call(
            &state,
            "accounts.put",
            json!({"entries": [{"id": "a", "email": "a@x.test"}]}),
        )
        .await
        .unwrap();
        assert_eq!(put["changed"], json!(["a"]));
        assert!(put["version"].as_u64().unwrap() > v0);
        assert_eq!(
            on_disk(&dir),
            json!([{"id": "old", "email": "old@x.test"}, {"id": "a", "email": "a@x.test"}])
        );

        let got = call(&state, "accounts.get", json!({"id": "a"}))
            .await
            .unwrap();
        assert_eq!(got["account"], json!({"id": "a", "email": "a@x.test"}));

        call(&state, "accounts.remove", json!({"ids": ["old"]}))
            .await
            .unwrap();
        assert_eq!(on_disk(&dir), json!([{"id": "a", "email": "a@x.test"}]));
        let stale = call(
            &state,
            "accounts.replace_all",
            json!({"entries": [], "baseVersion": v0}),
        )
        .await;
        assert_eq!(stale, Err("errors.accountsConflict".to_string()));
        assert_eq!(
            call(&state, "accounts.put", json!({"entries": [{"email": "x"}]})).await,
            Err("errors.accountsInvalid".to_string())
        );
    }

    /// A usable unexpired synthetic grant would populate the trusted cache
    /// if injection ran. An extra account param must not trigger that IO;
    /// mutation outputs still contain only nonsecret metadata.
    #[tokio::test]
    async fn no_secret_reaches_the_file_the_event_or_the_reply() {
        let (dir, state) = rig();
        let _mock = crate::handlers::oauth2::test_token_mock(Vec::new());
        let native_token = "synthetic-native-token";
        let stored = json!({
            "id":"g", "email":"g@gmail.test", "imapHost":"imap.gmail.com",
            "authType":"oauth2", "oauth2Provider":"google",
            "oauth2ClientId":mailvault_core::oauth2::GOOGLE_THUNDERBIRD_CLIENT_ID,
            "oauth2AccessToken":native_token, "oauth2RefreshToken":"synthetic-refresh",
            "oauth2ExpiresAt":chrono::Utc::now().timestamp_millis() + 3_600_000,
        });
        std::fs::write(
            dir.path().join("credentials.json"),
            json!({"g":stored.to_string()}).to_string(),
        )
        .unwrap();
        let mut rx = state.events.subscribe();
        let secret = "ya29.SECRET-token";
        let reply = call(
            &state,
            "accounts.put",
            json!({
                "entry": {"id": "g", "email": "g@gmail.test", "authType": "oauth2", "oauth2AccessToken": secret, "oauth2RefreshToken": secret, "password": secret},
                "account": {"id": "g", "email": "g@gmail.test", "authType": "oauth2"},
            }),
        )
        .await
        .unwrap();
        assert!(
            !state.tokens.has_trusted_token_for_test("g"),
            "native account routes must not look up an OAuth grant"
        );
        assert!(!reply.to_string().contains(secret));
        let text = std::fs::read_to_string(dir.path().join("accounts.json")).unwrap();
        assert!(
            !text.contains(secret) && !text.contains("oauth2AccessToken"),
            "{text}"
        );
        let line = rx.try_recv().expect("an event");
        assert!(
            !line.contains("g@gmail.test") && !line.contains(secret),
            "the event carries ids only: {line}"
        );
        let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
        assert_eq!(name, CHANGED_EVENT);
        assert_eq!(payload, json!({"ids": ["g"], "version": reply["version"]}));
        // A write that changes nothing is silent.
        call(
            &state,
            "accounts.put",
            json!({"entry": {"id": "g", "email": "g@gmail.test", "authType": "oauth2"}}),
        )
        .await
        .unwrap();
        assert!(rx.try_recv().is_err());
        let token =
            crate::oauth_tokens::access_token(&state, "g", crate::oauth_tokens::Read::Quiet)
                .await
                .unwrap();
        assert_eq!(token.as_deref(), Some(native_token));
        assert!(state.tokens.has_trusted_token_for_test("g"));
        assert!(crate::handlers::oauth2::test_token_posts().is_empty());
    }

    /// An older release left passwords and tokens in accounts.json. The
    /// first write copies each one the keychain lacks into it, then the list
    /// and its backup are written without them.
    #[tokio::test]
    async fn legacy_secrets_move_into_the_keychain_before_the_list_is_scrubbed() {
        let (dir, state) = rig();
        let creds = dir.path().join("credentials.json");
        let kept = json!({"id": "b", "email": "b@x.test", "password": "keychain-pw"}).to_string();
        std::fs::write(&creds, json!({"b": kept}).to_string()).unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        let legacy = json!([
            {"id": "a", "email": "a@x.test", "password": "LEGACY-only-copy"},
            {"id": "b", "email": "b@x.test", "password": "LEGACY-stale"},
        ]);
        std::fs::write(
            dir.path().join("accounts.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let put = call(
            &state,
            "accounts.put",
            json!({"entry": {"id": "c", "email": "c@x.test"}}),
        )
        .await;
        let blob: std::collections::HashMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(&creds).unwrap()).unwrap();
        put.unwrap();

        let a: Value = serde_json::from_str(&blob["a"]).unwrap();
        assert_eq!(
            a["password"],
            json!("LEGACY-only-copy"),
            "the only copy of a's password is now in the keychain"
        );
        assert_eq!(
            blob["b"], kept,
            "the keychain's own record wins over the file's"
        );
        for entry in std::fs::read_dir(dir.path()).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("accounts") {
                let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                assert!(
                    !text.contains("LEGACY"),
                    "{name} still holds a legacy secret"
                );
            }
        }
        assert!(dir.path().join("accounts.json.bak1").exists());
    }

    /// The keychain cannot be read: nothing is moved and the list keeps its
    /// secrets (no loss), but the backup the write takes holds none.
    #[tokio::test]
    async fn an_unreadable_keychain_leaves_the_legacy_secrets_in_place() {
        let (dir, state) = rig();
        let creds = dir.path().join("credentials.json");
        std::fs::write(&creds, "{\"broken").unwrap();
        std::env::set_var("MAILVAULT_TEST_CREDENTIALS", &creds);
        std::fs::write(
            dir.path().join("accounts.json"),
            json!([{"id": "a", "password": "LEGACY-only-copy"}]).to_string(),
        )
        .unwrap();
        let put = call(&state, "accounts.put", json!({"entry": {"id": "c"}})).await;
        put.unwrap();
        assert!(std::fs::read_to_string(dir.path().join("accounts.json"))
            .unwrap()
            .contains("LEGACY-only-copy"));
        assert!(
            !std::fs::read_to_string(dir.path().join("accounts.json.bak1"))
                .unwrap()
                .contains("LEGACY")
        );
        assert_eq!(std::fs::read_to_string(&creds).unwrap(), "{\"broken");
    }

    #[tokio::test]
    async fn six_native_routes_complete_successfully() {
        let (_dir, state) = rig();
        assert_eq!(
            call(&state, "accounts.list", json!({})).await.unwrap()["accounts"],
            json!([])
        );
        call(
            &state,
            "accounts.put",
            json!({"entries":[{"id":"a"},{"id":"b"}]}),
        )
        .await
        .unwrap();
        assert_eq!(
            call(&state, "accounts.get", json!({"id":"a"}))
                .await
                .unwrap()["account"],
            json!({"id":"a"})
        );
        call(&state, "accounts.reorder", json!({"ids":["b"]}))
            .await
            .unwrap();
        assert_eq!(
            call(&state, "accounts.list", json!({})).await.unwrap()["accounts"][0]["id"],
            "b"
        );
        call(&state, "accounts.remove", json!({"id":"b"}))
            .await
            .unwrap();
        call(
            &state,
            "accounts.replace_all",
            json!({"entries":[{"id":"c", "password":"incoming"}]}),
        )
        .await
        .unwrap();
        assert_eq!(
            call(&state, "accounts.list", json!({})).await.unwrap()["accounts"],
            json!([{"id":"c"}])
        );
    }
    #[tokio::test]
    async fn scrub_only_emits_once_then_clean_noop_is_stable() {
        let (dir, state) = rig();
        std::fs::write(
            dir.path().join("accounts.json"),
            json!([{"id":"a", "password":"only-A"}]).to_string(),
        )
        .unwrap();
        let mut rx = state.events.subscribe();
        let first = call(&state, "accounts.reorder", json!({"ids":["a"]}))
            .await
            .unwrap();
        assert_eq!(first["changed"], json!(["a"]));
        let mut account_events = 0;
        let mut credential_events = 0;
        while let Ok(line) = rx.try_recv() {
            let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            if name == CHANGED_EVENT {
                account_events += 1;
                assert_eq!(payload["ids"], json!(["a"]));
            }
            if name == crate::handlers::credentials::CHANGED_EVENT {
                credential_events += 1;
            }
        }
        assert_eq!(account_events, 1);
        assert_eq!(
            credential_events, 1,
            "N1 finalizer owns one preservation notification"
        );
        let bytes = std::fs::read(dir.path().join("accounts.json")).unwrap();
        let second = call(&state, "accounts.reorder", json!({"ids":["a"]}))
            .await
            .unwrap();
        assert_eq!(second, json!({"version":first["version"], "changed":[]}));
        assert_eq!(
            std::fs::read(dir.path().join("accounts.json")).unwrap(),
            bytes
        );
        assert!(rx.try_recv().is_err());
        assert_eq!(
            call(&state, "accounts.put", json!({"entry":{}}))
                .await
                .unwrap_err(),
            "errors.accountsInvalid"
        );
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn the_route_logs_counts_and_keys_only() {
        let src = include_str!("accounts.rs");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        for line in code
            .lines()
            .filter(|l| l.contains("info!(") || l.contains("warn!(") || l.contains("error!("))
        {
            assert!(
                !line.contains("records")
                    && !line.contains("params")
                    && !line.contains("listed")
                    && !line.contains("ids)"),
                "{line}"
            );
        }
    }
}
