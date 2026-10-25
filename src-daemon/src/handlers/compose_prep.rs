//! Bounded foreground reads for compose policy. No body lookup or mail mutation.
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::compose_prep::{self, Account, Context};
use mailvault_core::settings_doc::{SettingsDoc, Snapshot};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
const UNAVAILABLE: &str = "compose.preparationUnavailable";
struct Loaded {
    context: Context,
    accounts: Vec<u8>,
    snapshot: Snapshot,
}
fn accounts(path: &Path) -> Result<Vec<u8>, &'static str> {
    match std::fs::read(path.join("accounts.json")) {
        Ok(bytes) if bytes.len() <= compose_prep::MAX_REQUEST_BYTES => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(b"[]".to_vec()),
        _ => Err(UNAVAILABLE),
    }
}
fn snapshot(path: &Path) -> Result<Snapshot, &'static str> {
    let snap = SettingsDoc::shared(path)
        .get(None)
        .map_err(|_| UNAVAILABLE)?;
    if snap.recovered.is_some() {
        return Err(UNAVAILABLE);
    }
    Ok(snap)
}
fn load(path: &Path) -> Result<Loaded, &'static str> {
    let bytes = accounts(path)?;
    // Nonsecret records only. Deserialization ignores unrelated account fields;
    // no credential reader or account object from the request participates.
    let records: Vec<Account> = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    let mut ids = HashSet::new();
    if records
        .iter()
        .any(|a| a.id.trim().is_empty() || a.email.trim().is_empty() || !ids.insert(a.id.clone()))
    {
        return Err(UNAVAILABLE);
    }
    let snap = snapshot(path)?;
    let store = snap.values.get("mailvault-settings").ok_or(UNAVAILABLE)?;
    store
        .get("version")
        .and_then(Value::as_u64)
        .ok_or(UNAVAILABLE)?;
    let settings = store
        .get("state")
        .filter(|v| v.is_object())
        .ok_or(UNAVAILABLE)?
        .clone();
    // Missing optional maps are the real JS defaults in a coherently read store.
    // Present malformed identity lists cannot masquerade as no own addresses.
    for key in ["aliases", "sendAsAddresses"] {
        if settings
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_object())
        {
            return Err(UNAVAILABLE);
        }
    }
    for a in &records {
        let aliases = &settings["aliases"][&a.id];
        if !aliases.is_null() {
            let aliases = aliases.as_array().ok_or(UNAVAILABLE)?;
            if aliases.iter().any(|a| {
                !a.is_null()
                    && (!a.is_object()
                        || a.get("address")
                            .is_some_and(|v| !v.is_null() && !v.is_string()))
            }) {
                return Err(UNAVAILABLE);
            }
        }
        let default = &settings["sendAsAddresses"][&a.id];
        if !default.is_null() && !default.is_string() {
            return Err(UNAVAILABLE);
        }
    }
    let context = Context {
        accounts: records,
        settings,
        settings_version: snap.version,
    };
    Ok(Loaded {
        context,
        accounts: bytes,
        snapshot: snap,
    })
}
fn unchanged(path: &Path, loaded: &Loaded) -> Result<(), &'static str> {
    if accounts(path)? != loaded.accounts {
        return Err("errors.settingsConflict");
    }
    let current = snapshot(path)?;
    if current.version != loaded.snapshot.version || current.values != loaded.snapshot.values {
        return Err("errors.settingsConflict");
    }
    Ok(())
}
pub(crate) async fn route(
    state: &Arc<DaemonState>,
    method: &str,
    params: &Value,
    id: Value,
) -> Option<RpcResponse> {
    if !matches!(method, "compose.reply_context" | "compose.check") {
        return None;
    }
    let app = state.app_dir.clone();
    let params = params.clone();
    let method = method.to_string();
    let now = state.clock.now_ms();
    // All parsing, policy and local-file reads leave the IPC runtime. No vault
    // gate/mailbox lock is acquired, and no background task is scheduled.
    let answer = tokio::task::spawn_blocking(move || {
        let full_message = method == "compose.reply_context"
            && params.get("kind").and_then(Value::as_str) == Some("message");
        if !full_message
            && serde_json::to_vec(&params).map_err(|_| UNAVAILABLE)?.len()
                > compose_prep::MAX_REQUEST_BYTES
        {
            return Err(UNAVAILABLE);
        }
        let loaded = load(&app)?;
        let out = if method == "compose.check" {
            compose_prep::check(&params, &loaded.context, now)
        } else {
            compose_prep::reply_context(&params, &loaded.context)
        }?;
        #[cfg(test)]
        tests::before_finish(&app);
        unchanged(&app, &loaded)?;
        Ok(out)
    })
    .await
    .unwrap_or(Err(UNAVAILABLE));
    Some(match answer {
        Ok(value) => RpcResponse::success(id, value),
        Err(key) => RpcResponse::error(
            id,
            if key == "errors.settingsConflict" {
                ipc::INTERNAL_ERROR
            } else {
                ipc::INVALID_PARAMS
            },
            key,
        ),
    })
}
#[cfg(test)]
#[path = "compose_prep_tests.rs"]
mod tests;
