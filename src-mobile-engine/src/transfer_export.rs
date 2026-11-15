//! `mobile.transfer.export` and `mobile.transfer.discard`: the phone's accounts to a computer, as
//! desktop's "Move to another computer" file. Each account (row and secret) becomes core's
//! [`PhoneAccount`], core maps it to the desktop's account object ([`desktop_bundle`], the inverse
//! of the mapping that makes the phone code) and seals the bundle with the `.mvtransfer` envelope
//! ([`crypto::encrypt`], argon2id and XChaCha20-Poly1305: the shell already runs every RPC on a
//! blocking thread). Desktop's import opens it as it opens its own export.
//!
//! The file is written as `<cache>/att/<64 hex>`, the one place the shell's share sheet takes a
//! file from (`mobile_share_file`, which leases it while it makes its named copy). It holds every
//! secret it carries, so the page discards it as soon as the share sheet answers; an export the
//! page never discarded goes with the next export, or with the attachment cache's eviction.
//!
//! `{password, accountIds?}` (every account when absent) answers `{ok: true, path, name, count,
//! skipped: [{email, reason: "no-secret"}]}` or `{ok: false, code}`: `PASSWORD_SHORT` (under 12
//! characters), `NO_ACCOUNTS` (nothing to export, nothing written), `INVALID`.
//! `{path}` deletes a file this engine exported; any other path is refused.
//!
//! Never logged or put in a reply or error: the password, the bundle or a secret.

use crate::accounts::LIST_ORDER;
use crate::db::Engine;
use crate::rpc::RpcError;
use crate::secrets::Credential;
use mailvault_core::transfer::crypto;
use mailvault_core::transfer::phone::{desktop_bundle, PhoneAccount, PhoneAuth, PhoneKind, MIN_PASSWORD_CHARS};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zeroize::Zeroizing;

/// The files this process exported and has not discarded yet.
static EXPORTED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn exported() -> std::sync::MutexGuard<'static, Vec<PathBuf>> {
    EXPORTED.lock().unwrap_or_else(|p| p.into_inner())
}

fn refused(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

fn read_rows(engine: &Engine) -> Result<Vec<(String, PhoneAccount)>, RpcError> {
    engine
        .read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT id, email, display_name, kind, auth, imap_host, imap_port, security, smtp_host, smtp_port, smtp_security,
                        provider, jmap_url, color, {hidden}
                 FROM accounts ORDER BY {LIST_ORDER}",
                hidden = crate::account_settings::HIDDEN_SQL.replace("{account}", "accounts.id")
            ))?;
            let rows = st.query_map([], |r| {
                let kind = match r.get::<_, String>(3)?.as_str() {
                    "graph" => PhoneKind::Graph,
                    "jmap" => PhoneKind::Jmap,
                    _ => PhoneKind::Imap,
                };
                let auth = match r.get::<_, String>(4)?.as_str() {
                    "oauth2" => PhoneAuth::OAuth2,
                    "bearer" => PhoneAuth::Bearer,
                    _ => PhoneAuth::Password,
                };
                let imap = kind == PhoneKind::Imap;
                Ok((
                    r.get::<_, String>(0)?,
                    PhoneAccount {
                        email: r.get(1)?,
                        display_name: r.get(2)?,
                        kind,
                        auth,
                        provider: r.get(11)?,
                        imap_host: if imap { Some(r.get(5)?) } else { None },
                        imap_port: if imap { Some(r.get::<_, i64>(6)? as u16) } else { None },
                        security: if imap { Some(r.get(7)?) } else { None },
                        smtp_host: if imap { r.get(8)? } else { None },
                        smtp_port: if imap { r.get::<_, Option<i64>>(9)?.map(|p| p as u16) } else { None },
                        smtp_security: if imap { r.get(10)? } else { None },
                        jmap_url: r.get(12)?,
                        password: None,
                        refresh: None,
                        client_id: None,
                        color: r.get(13)?,
                        order: None,
                        hidden: r.get(14)?,
                        settings: None,
                    },
                ))
            })?;
            rows.collect()
        })
        .map_err(|e| RpcError::Internal(e.to_string()))
}

/// The account's secret into it: `false` when there is none it can sign in with.
fn with_secret(engine: &Engine, id: &str, a: &mut PhoneAccount) -> bool {
    let Ok(Some(stored)) = engine.shared().secrets().get(id) else { return false };
    let cred = Credential::parse(&stored);
    match a.auth {
        PhoneAuth::OAuth2 => {
            a.refresh = cred.refresh.clone().filter(|s| !s.is_empty());
            a.client_id = cred.client_id.clone();
            a.refresh.is_some()
        }
        PhoneAuth::Password | PhoneAuth::Bearer => {
            a.password = cred.password.clone().filter(|s| !s.is_empty());
            a.password.is_some()
        }
    }
}

fn read_params(params: &mut Value) -> Result<(Zeroizing<String>, Option<HashSet<String>>), &'static str> {
    let obj = params.as_object_mut().ok_or("params must be an object")?;
    let password = match obj.get_mut("password") {
        Some(Value::String(s)) => Zeroizing::new(std::mem::take(s)),
        _ => return Err("password must be a string"),
    };
    let ids = match obj.get("accountIds") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(items.iter().map(|v| v.as_str().map(str::to_string).ok_or("accountIds must be strings")).collect::<Result<_, _>>()?),
        Some(_) => return Err("accountIds must be a list"),
    };
    Ok((password, ids))
}

/// `YYYY-MM-DD` (UTC) of `ms`, for the file's name as desktop names its own export.
fn utc_date(ms: u64) -> String {
    // Days since 1970-01-01 to a civil date (Howard Hinnant's `civil_from_days`).
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Writes `bytes` as `<dir>/<sha-256 of bytes, hex>`: the sealed file starts with a fresh random
/// salt and nonce, so the name is new every time, and it is the spelling the share sheet takes.
fn write_file(dir: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    use sha2::{Digest, Sha256};
    std::fs::create_dir_all(dir)?;
    let name: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    let tmp = dir.join(format!("{name}.export"));
    let path = dir.join(&name);
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Deletes every earlier export: one file with secrets at a time, at most.
fn drop_earlier() {
    for p in exported().drain(..) {
        let _ = std::fs::remove_file(p);
    }
}

pub(crate) fn export(engine: &Engine, mut params: Value) -> Result<Value, RpcError> {
    let (password, ids) = match read_params(&mut params) {
        Ok(p) => p,
        Err(m) => return Ok(refused("INVALID", m)),
    };
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Ok(refused("PASSWORD_SHORT", "the password has fewer than 12 characters"));
    }
    let mut chosen = Vec::new();
    let mut skipped = Vec::new();
    for (id, mut a) in read_rows(engine)? {
        if ids.as_ref().is_some_and(|ids| !ids.contains(&id)) {
            continue;
        }
        if with_secret(engine, &id, &mut a) {
            chosen.push((id, a));
        } else {
            skipped.push(json!({ "email": a.email, "reason": "no-secret" }));
        }
    }
    if chosen.is_empty() {
        return Ok(refused("NO_ACCOUNTS", "no account to export"));
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let bundle = desktop_bundle(&chosen, now);
    let count = chosen.len();
    drop(chosen);
    let plain = Zeroizing::new(serde_json::to_vec(&bundle).map_err(|e| RpcError::Internal(e.to_string()))?);
    drop(bundle);
    let sealed = crypto::encrypt(&password, &plain).map_err(|e| RpcError::Internal(e.to_string()))?;
    drop(plain);
    drop_earlier();
    let path = write_file(engine.attachments().dir(), &sealed).map_err(|e| RpcError::Internal(e.to_string()))?;
    exported().push(path.clone());
    let date = utc_date(now);
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "name": format!("MailVault-transfer-{date}.mvtransfer"),
        "count": count,
        "skipped": skipped,
    }))
}

pub(crate) fn discard(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let path = params.get("path").and_then(Value::as_str).ok_or_else(|| RpcError::Invalid("path must be a string".into()))?;
    let path = PathBuf::from(path);
    let mut list = exported();
    let Some(i) = list.iter().position(|p| *p == path) else {
        return Err(RpcError::Invalid("not an export of this app".into()));
    };
    let p = list.remove(i);
    drop(list);
    let _ = engine;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "ok": true })),
        Err(e) => Err(RpcError::Internal(e.to_string())),
    }
}
