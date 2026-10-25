//! Native account document capability; application adapter cutover is pending.
//!
//! Both daemon and callable shell fallback use the shared JsonDoc engine,
//! supported lock file, version fences, atomic replacement and backups.
//! Existing plugin-fs writers do not participate in its lock. A completed
//! intervening write is detected; no universal cross-process CAS is claimed.
//!
//! Legacy arrays remain readable, including old secret fields. Incoming
//! records have password and OAuth tokens stripped. Retained live secrets
//! are scrubbed only with an exact preserved-list and version proof checked
//! under the account writer. Preserve mode still permits explicit removal
//! or replacement. Newly created good backups are clean; historical backups
//! and raw corrupt copies are not retroactively scrubbed.
//!
//! put merges matching IDs or appends; ifAbsent also checks logical identity.
//! remove removes every matching entry, reorder keeps unspecified order,
//! replace_all accepts an optional base version. No account field is logged.

use crate::json_doc::{Change, DocError, JsonDoc, Kind, Persistence, Scrub, Spec};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Arc;

pub const FILE_NAME: &str = "accounts.json";
pub const SPEC: Spec = Spec {
    file: FILE_NAME,
    kind: Kind::Array,
    pretty: true,
    persistence: Persistence::PrivateDurable,
};
/// Stripped from incoming records and newly made good backups.
pub const SECRET_FIELDS: [&str; 3] = ["password", "oauth2AccessToken", "oauth2RefreshToken"];

/// The one instance for `app_dir` in this process.
pub fn shared(app_dir: &Path) -> Arc<JsonDoc> {
    JsonDoc::shared(app_dir, SPEC)
}

#[derive(Debug, Clone, PartialEq)]
pub enum AccountsError {
    Conflict { current: u64 },
    Invalid,
    Io(String),
}

impl AccountsError {
    /// The i18n catalog key the app shows for this error.
    pub fn catalog_key(&self) -> &'static str {
        match self {
            AccountsError::Conflict { .. } => "errors.accountsConflict",
            AccountsError::Invalid => "errors.accountsInvalid",
            AccountsError::Io(_) => "errors.accountsWriteFailed",
        }
    }
}

impl From<DocError> for AccountsError {
    fn from(e: DocError) -> Self {
        match e {
            DocError::Conflict { current } => AccountsError::Conflict { current },
            DocError::Invalid => AccountsError::Invalid,
            DocError::Io(e) => AccountsError::Io(e),
        }
    }
}

/// The app's `accountLogicalKey`: same address and same server (or OAuth
/// provider) is the same account. `email@server`, both lowercased.
pub fn logical_key(entry: &Value) -> String {
    let text = |k: &str| {
        entry
            .get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let email = text("email").unwrap_or("").to_lowercase();
    let server = text("imapHost")
        .or_else(|| text("oauth2Provider"))
        .unwrap_or("")
        .to_lowercase();
    format!("{email}@{server}")
}

fn id_of(entry: &Value) -> Option<&str> {
    entry.get("id").and_then(Value::as_str)
}

/// An entry the app asked to write: an object with a non-empty string id,
/// its secrets dropped.
fn writable(entry: &Value) -> Result<Map<String, Value>, AccountsError> {
    let Value::Object(map) = entry else {
        return Err(AccountsError::Invalid);
    };
    if !map
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
    {
        return Err(AccountsError::Invalid);
    }
    let mut map = map.clone();
    for field in SECRET_FIELDS {
        map.remove(field);
    }
    Ok(map)
}

fn entries(list: &mut Value) -> Result<&mut Vec<Value>, DocError> {
    list.as_array_mut().ok_or(DocError::Invalid)
}

fn push_unique(ids: &mut Vec<String>, id: &str) {
    if !ids.iter().any(|i| i == id) {
        ids.push(id.to_string());
    }
}

/// Drops `SECRET_FIELDS` from every entry of the list (an older release
/// could leave a password or token in the file); answers the ids it cleaned.
/// The daemon runs it live only after the keychain holds every such account
/// (`handlers/accounts.rs`); every write runs it on the backup it takes.
pub fn scrub_secrets(list: &mut Value) -> Vec<String> {
    let mut cleaned = Vec::new();
    for entry in list.as_array_mut().into_iter().flatten() {
        let Value::Object(map) = entry else { continue };
        let mut hit = false;
        for field in SECRET_FIELDS {
            hit |= map.remove(field).is_some();
        }
        if hit {
            push_unique(
                &mut cleaned,
                map.get("id").and_then(Value::as_str).unwrap_or_default(),
            );
        }
    }
    cleaned
}

/// The entries that still carry a secret: `(id, the entry as JSON text)`,
/// what the keychain must hold before the list may be scrubbed. Values are
/// never logged.
pub fn legacy_secrets(list: &[Value]) -> Vec<(String, String)> {
    list.iter()
        .filter(|e| {
            SECRET_FIELDS
                .iter()
                .any(|f| e.get(f).is_some_and(|v| !v.is_null()))
        })
        .filter_map(|e| {
            Some((
                id_of(e).filter(|id| !id.is_empty())?.to_string(),
                e.to_string(),
            ))
        })
        .collect()
}

/// Every non-null legacy secret needs one unambiguous credential-map key.
/// Duplicates anywhere in the list make a secret-bearing ID ambiguous.
pub fn legacy_secrets_representable(list: &[Value]) -> bool {
    let mut counts = std::collections::HashMap::new();
    for id in list.iter().filter_map(id_of) {
        *counts.entry(id).or_insert(0usize) += 1;
    }
    list.iter()
        .filter(|entry| {
            SECRET_FIELDS
                .iter()
                .any(|field| entry.get(field).is_some_and(|v| !v.is_null()))
        })
        .all(|entry| {
            id_of(entry)
                .filter(|id| !id.is_empty())
                .is_some_and(|id| counts.get(id) == Some(&1))
        })
}

fn scrub(live: bool) -> Scrub<'static> {
    Scrub {
        clean: &scrub_secrets,
        live,
    }
}

/// What `list` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Listing {
    pub accounts: Vec<Value>,
    pub version: u64,
    pub recovered: Option<String>,
}

pub fn list(doc: &JsonDoc) -> Result<Listing, AccountsError> {
    let snap = doc.get()?;
    let accounts = match snap.value {
        Value::Array(a) => a,
        _ => Vec::new(),
    };
    Ok(Listing {
        accounts,
        version: snap.version,
        recovered: snap.recovered,
    })
}

/// Ephemeral authorization for live cleanup. The daemon constructs the proof
/// only after preserving the exact listing; the shell always uses Preserve.
#[derive(Clone, Copy)]
pub enum LiveScrub<'a> {
    Preserve,
    Preserved(&'a Listing),
}

fn mutate(
    doc: &JsonDoc,
    base: Option<u64>,
    policy: LiveScrub<'_>,
    apply: impl FnOnce(&mut Value) -> Result<Vec<String>, DocError>,
) -> Result<Change, AccountsError> {
    let proof = match policy {
        LiveScrub::Preserve => None,
        LiveScrub::Preserved(listing) => Some(listing),
    };
    let base = match proof {
        Some(proof) => {
            if base.is_some_and(|caller| caller != proof.version) {
                return Err(AccountsError::Conflict {
                    current: proof.version,
                });
            }
            Some(proof.version)
        }
        None => base,
    };
    // The generic engine prepares a clean backup but leaves live values
    // untouched for this comparison under its writer and supported OS lock.
    Ok(doc.write_op_scrubbed(base, Some(scrub(false)), |value| {
        if let Some(proof) = proof {
            if value.as_array() != Some(&proof.accounts) {
                return Err(DocError::Conflict {
                    current: proof.version,
                });
            }
        }
        let mut cleaned = if proof.is_some() {
            scrub_secrets(value)
        } else {
            Vec::new()
        };
        let mut changed = apply(value)?;
        for id in cleaned.drain(..) {
            push_unique(&mut changed, &id);
        }
        Ok(changed)
    })?)
}

pub fn put(
    doc: &JsonDoc,
    incoming: &[Value],
    if_absent: bool,
    base: Option<u64>,
    live: LiveScrub<'_>,
) -> Result<Change, AccountsError> {
    let incoming = incoming
        .iter()
        .map(writable)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(mutate(doc, base, live, move |list| {
        let list = entries(list)?;
        let mut changed = Vec::new();
        if if_absent {
            let ids: std::collections::HashSet<String> =
                list.iter().filter_map(id_of).map(str::to_owned).collect();
            let keys: std::collections::HashSet<String> = list.iter().map(logical_key).collect();
            for entry in incoming {
                let entry = Value::Object(entry);
                let id = id_of(&entry).unwrap_or_default().to_string();
                if ids.contains(&id) || keys.contains(&logical_key(&entry)) {
                    continue;
                }
                push_unique(&mut changed, &id);
                list.push(entry);
            }
            return Ok(changed);
        }
        for entry in incoming {
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match list.iter_mut().find(|e| id_of(e) == Some(id.as_str())) {
                Some(existing) => {
                    let before = existing.clone();
                    if let Value::Object(map) = existing {
                        for (k, v) in entry {
                            map.insert(k, v);
                        }
                    } else {
                        *existing = Value::Object(entry);
                    }
                    if *existing != before {
                        push_unique(&mut changed, &id);
                    }
                }
                None => {
                    list.push(Value::Object(entry));
                    push_unique(&mut changed, &id);
                }
            }
        }
        Ok(changed)
    })?)
}

pub fn remove(
    doc: &JsonDoc,
    ids: &[String],
    base: Option<u64>,
    live: LiveScrub<'_>,
) -> Result<Change, AccountsError> {
    Ok(mutate(doc, base, live, |list| {
        let list = entries(list)?;
        let mut changed = Vec::new();
        list.retain(|e| match id_of(e) {
            Some(id) if ids.iter().any(|i| i == id) => {
                push_unique(&mut changed, id);
                false
            }
            _ => true,
        });
        Ok(changed)
    })?)
}

pub fn reorder(
    doc: &JsonDoc,
    ids: &[String],
    base: Option<u64>,
    live: LiveScrub<'_>,
) -> Result<Change, AccountsError> {
    Ok(mutate(doc, base, live, |list| {
        let list = entries(list)?;
        let before: Vec<Value> = list.clone();
        let mut ordered: Vec<Value> = Vec::with_capacity(list.len());
        let mut rest: Vec<Value> = Vec::new();
        let mut taken = vec![false; before.len()];
        for id in ids {
            for (i, e) in before.iter().enumerate() {
                if !taken[i] && id_of(e) == Some(id.as_str()) {
                    taken[i] = true;
                    ordered.push(e.clone());
                }
            }
        }
        for (i, e) in before.iter().enumerate() {
            if !taken[i] {
                rest.push(e.clone());
            }
        }
        ordered.extend(rest);
        if ordered == before {
            return Ok(Vec::new());
        }
        *list = ordered;
        let mut changed = Vec::new();
        for id in ids {
            if list.iter().any(|e| id_of(e) == Some(id.as_str())) {
                push_unique(&mut changed, id);
            }
        }
        Ok(changed)
    })?)
}

pub fn replace_all(
    doc: &JsonDoc,
    incoming: &[Value],
    base: Option<u64>,
    live: LiveScrub<'_>,
) -> Result<Change, AccountsError> {
    let incoming: Vec<Value> = incoming
        .iter()
        .map(writable)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(Value::Object)
        .collect();
    Ok(mutate(doc, base, live, move |list| {
        let list = entries(list)?;
        if *list == incoming {
            return Ok(Vec::new());
        }
        let mut changed = Vec::new();
        for e in list.iter().chain(incoming.iter()) {
            let Some(id) = id_of(e) else { continue };
            let old: Vec<&Value> = list.iter().filter(|x| id_of(x) == Some(id)).collect();
            let new: Vec<&Value> = incoming.iter().filter(|x| id_of(x) == Some(id)).collect();
            if old != new {
                push_unique(&mut changed, id);
            }
        }
        if changed.is_empty() {
            // Only the order (or an entry without an id) moved.
            for id in incoming.iter().filter_map(id_of) {
                push_unique(&mut changed, id);
            }
        }
        *list = incoming;
        Ok(changed)
    })?)
}

/// What one operation answers: the reply, and the ids it changed with the
/// version after it (for the `accounts-changed` event), when it wrote.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub reply: Value,
    pub changed: Option<Change>,
}

fn base(params: &Value) -> Option<u64> {
    params.get("baseVersion").and_then(Value::as_u64)
}

fn strings(v: Option<&Value>) -> Result<Vec<String>, AccountsError> {
    let Some(Value::Array(items)) = v else {
        return Err(AccountsError::Invalid);
    };
    items
        .iter()
        .map(|i| i.as_str().map(str::to_owned).ok_or(AccountsError::Invalid))
        .collect()
}

/// `entries` (an array) or `entry` (one object).
fn incoming(params: &Value) -> Result<Vec<Value>, AccountsError> {
    match (params.get("entries"), params.get("entry")) {
        (Some(Value::Array(items)), _) => Ok(items.clone()),
        (None, Some(entry @ Value::Object(_))) => Ok(vec![entry.clone()]),
        _ => Err(AccountsError::Invalid),
    }
}

fn wrote(change: Change) -> Outcome {
    let reply = json!({"version": change.version, "changed": change.changed});
    let changed = (!change.changed.is_empty()).then_some(change);
    Outcome { reply, changed }
}

/// The methods both the daemon and the shell's fallback answer.
pub const METHODS: [&str; 6] = [
    "accounts.list",
    "accounts.get",
    "accounts.put",
    "accounts.remove",
    "accounts.reorder",
    "accounts.replace_all",
];

/// The methods that write.
pub fn writes(method: &str) -> bool {
    matches!(
        method,
        "accounts.put" | "accounts.remove" | "accounts.reorder" | "accounts.replace_all"
    )
}

/// One `accounts.*` operation on `doc`. Blocking file IO: call it off the
/// async workers. A preserved proof authorizes live cleanup only while its
/// complete values and version still match. Newly made good backups are clean.
pub fn run(
    doc: &JsonDoc,
    method: &str,
    params: &Value,
    scrub_live: LiveScrub<'_>,
) -> Result<Outcome, AccountsError> {
    let live = scrub_live;
    match method {
        "accounts.list" => {
            let l = list(doc)?;
            let mut reply = json!({"accounts": l.accounts, "version": l.version});
            if let Some(from) = l.recovered {
                reply["recovered"] = Value::String(from);
            }
            Ok(Outcome {
                reply,
                changed: None,
            })
        }
        "accounts.get" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or(AccountsError::Invalid)?;
            let l = list(doc)?;
            let account = l
                .accounts
                .into_iter()
                .find(|e| id_of(e) == Some(id))
                .unwrap_or(Value::Null);
            Ok(Outcome {
                reply: json!({"account": account, "version": l.version}),
                changed: None,
            })
        }
        "accounts.put" => {
            let if_absent = params
                .get("ifAbsent")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(wrote(put(
                doc,
                &incoming(params)?,
                if_absent,
                base(params),
                live,
            )?))
        }
        "accounts.remove" => {
            let ids = match params.get("id").and_then(Value::as_str) {
                Some(id) => vec![id.to_string()],
                None => strings(params.get("ids"))?,
            };
            Ok(wrote(remove(doc, &ids, base(params), live)?))
        }
        "accounts.reorder" => Ok(wrote(reorder(
            doc,
            &strings(params.get("ids"))?,
            base(params),
            live,
        )?)),
        "accounts.replace_all" => {
            let Some(Value::Array(items)) = params.get("entries") else {
                return Err(AccountsError::Invalid);
            };
            Ok(wrote(replace_all(doc, items, base(params), live)?))
        }
        _ => Err(AccountsError::Invalid),
    }
}

#[cfg(test)]
mod tests;
