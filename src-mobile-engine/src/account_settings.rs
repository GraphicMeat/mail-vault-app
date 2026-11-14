//! Each account's own settings: rows `acct.<accountId>.<name>` of the `settings` table (no schema
//! of their own), read and written by the page through `mobile.accountSettings.get` / `.set`, and
//! written by a desktop import for the accounts it adds ([`apply_import`]).
//!
//! | name            | stored as                     | default (the phone without it)        |
//! |-----------------|-------------------------------|---------------------------------------|
//! | `hidden`        | `true` / `false`              | `false`: in every list                |
//! | `signature`     | JSON `{html, text, enabled}`  | none                                  |
//! | `sendAs`        | address, `""` = the login     | `""`                                  |
//! | `aliases`       | JSON `[{address, name}]`      | `[]`                                  |
//! | `sentFolder`    | folder path                   | none: the phone finds its Sent folder |
//! | `notify`        | `true` / `false`              | `true`                                |
//! | `notifyFolders` | JSON `[path]`                 | `["INBOX"]`                           |
//! | `quietHours`    | JSON `{enabled, start, end}`  | none                                  |
//!
//! `displayName` is the account row's own column, read and written here too.
//! `offlineWindow` (`acct.<id>.offlineWindow`) shares the table but belongs to the offline
//! settings (`mobile.offline.*`); this module never writes it from the page.
//!
//! A hidden account stays an account (it syncs, it can be shown again in Settings): only the
//! account switcher, the folder drawer's account list and All Inboxes leave it out.
//! `notify` takes effect only while notifications are on (`notifications`): an import never turns
//! them on, since that needs the system's permission.

use crate::backend::Identity;
use crate::db::{Engine, Shared};
use crate::rpc::{parse, RpcError};
use crate::settings::{get_in, put_in};
use mailvault_core::transfer::phone::PhoneAccountSettings;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// The page may read and write these (besides `displayName`).
pub(crate) const NAMES: &[&str] = &["hidden", "signature", "sendAs", "aliases", "sentFolder", "notify", "notifyFolders", "quietHours"];
/// Longest signature (html and text each), in characters.
const MAX_SIGNATURE: usize = 64 * 1024;
/// Longest display name, in characters.
const MAX_NAME: usize = 200;

pub(crate) fn key(account_id: &str, name: &str) -> String {
    format!("acct.{account_id}.{name}")
}

/// SQL true for an account `{account}` hidden by its `acct.<id>.hidden` row.
pub(crate) const HIDDEN_SQL: &str = "EXISTS (SELECT 1 FROM settings s WHERE s.key = 'acct.' || {account} || '.hidden' AND s.value = 'true')";

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn one_line(s: &str, max: usize) -> bool {
    s.chars().count() <= max && !s.contains(['\n', '\r'])
}

fn address(s: &str) -> bool {
    one_line(s, 320) && (s.is_empty() || s.find('@').is_some_and(|i| i > 0 && i + 1 < s.len()) && !s.contains(char::is_whitespace))
}

fn hhmm(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5 && b[2] == b':' && s[..2].parse::<u8>().is_ok_and(|h| h < 24) && s[3..].parse::<u8>().is_ok_and(|m| m < 60)
}

/// `value` as stored under `name`, or `None` when it is not one `name` takes.
pub(crate) fn encode(name: &str, value: &Value) -> Option<String> {
    match name {
        "hidden" | "notify" => value.as_bool().map(|b| b.to_string()),
        "signature" => {
            let o = value.as_object()?;
            let text = |k: &str| match o.get(k) {
                None | Some(Value::Null) => Some(String::new()),
                Some(Value::String(s)) if s.chars().count() <= MAX_SIGNATURE => Some(s.clone()),
                _ => None,
            };
            let enabled = match o.get("enabled") {
                None | Some(Value::Null) => true,
                Some(Value::Bool(b)) => *b,
                _ => return None,
            };
            Some(json!({ "html": text("html")?, "text": text("text")?, "enabled": enabled }).to_string())
        }
        "sendAs" => value.as_str().filter(|s| address(s)).map(str::to_string),
        "aliases" => {
            let list = value.as_array()?;
            if list.len() > 100 {
                return None;
            }
            let mut out = Vec::with_capacity(list.len());
            for a in list {
                let addr = a.get("address")?.as_str().filter(|s| !s.is_empty() && address(s))?;
                let name = match a.get("name") {
                    None | Some(Value::Null) => "",
                    Some(Value::String(s)) if one_line(s, MAX_NAME) => s,
                    _ => return None,
                };
                out.push(json!({ "address": addr, "name": name }));
            }
            Some(Value::Array(out).to_string())
        }
        "sentFolder" => value.as_str().filter(|s| !s.is_empty() && one_line(s, 1000)).map(str::to_string),
        "notifyFolders" => {
            let list = value.as_array()?;
            if list.len() > 200 || !list.iter().all(|f| f.as_str().is_some_and(|s| !s.is_empty() && one_line(s, 1000))) {
                return None;
            }
            Some(value.to_string())
        }
        "quietHours" => {
            let o = value.as_object()?;
            let enabled = o.get("enabled").map_or(Some(false), Value::as_bool)?;
            let start = o.get("start")?.as_str().filter(|s| hhmm(s))?;
            let end = o.get("end")?.as_str().filter(|s| hhmm(s))?;
            Some(json!({ "enabled": enabled, "start": start, "end": end }).to_string())
        }
        _ => None,
    }
}

fn decode(name: &str, stored: Option<String>) -> Value {
    let default = || match name {
        "hidden" => json!(false),
        "notify" => json!(true),
        "sendAs" => json!(""),
        "aliases" => json!([]),
        "notifyFolders" => json!(["INBOX"]),
        _ => Value::Null,
    };
    let Some(s) = stored else { return default() };
    let v = match name {
        "hidden" | "notify" => match s.as_str() {
            "true" => json!(true),
            "false" => json!(false),
            _ => return default(),
        },
        "sendAs" | "sentFolder" => json!(s),
        _ => match serde_json::from_str::<Value>(&s) {
            Ok(v) => v,
            Err(_) => return default(),
        },
    };
    if encode(name, &v).is_some() {
        v
    } else {
        default()
    }
}

fn account_name(c: &Connection, account_id: &str) -> rusqlite::Result<Option<String>> {
    c.query_row("SELECT display_name FROM accounts WHERE id = ?1", [account_id], |r| r.get(0)).optional()
}

/// The account's settings, every name of [`NAMES`] and `displayName`; `None` when no such account.
pub(crate) fn read_in(c: &Connection, account_id: &str) -> rusqlite::Result<Option<Value>> {
    let Some(name) = account_name(c, account_id)? else { return Ok(None) };
    let mut out = Map::new();
    out.insert("accountId".into(), json!(account_id));
    out.insert("displayName".into(), json!(name));
    for n in NAMES {
        out.insert((*n).into(), decode(n, get_in(c, &key(account_id, n))?));
    }
    Ok(Some(Value::Object(out)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetParams {
    account_id: String,
}

/// `mobile.accountSettings.get {accountId}` -> `{accountId, displayName, hidden, signature,
/// sendAs, aliases, sentFolder, notify, notifyFolders, quietHours}`. `INVALID` for an account the
/// phone does not have.
pub(crate) fn get(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: GetParams = parse(params)?;
    engine.read(|c| read_in(c, &p.account_id)).map_err(internal)?.ok_or_else(|| RpcError::Invalid("no such account".into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetParams {
    account_id: String,
    values: Map<String, Value>,
}

/// `mobile.accountSettings.set {accountId, values: {displayName?, <name of NAMES>?}}` -> the
/// account's settings after the write. `null` clears a name (back to its default). A name not
/// listed, or a value it does not take, is `INVALID` and changes nothing.
pub(crate) fn set(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: SetParams = parse(params)?;
    let mut writes: Vec<(String, Option<String>)> = Vec::new();
    let mut display_name = None;
    for (name, value) in &p.values {
        if name == "displayName" {
            let s = value.as_str().map(str::trim).filter(|s| one_line(s, MAX_NAME)).ok_or_else(|| RpcError::Invalid("displayName must be one line of text".into()))?;
            display_name = Some(s.to_string());
            continue;
        }
        if !NAMES.contains(&name.as_str()) {
            return Err(RpcError::Invalid(format!("{name} is not an account setting")));
        }
        let stored = if value.is_null() {
            None
        } else {
            Some(encode(name, value).ok_or_else(|| RpcError::Invalid(format!("{name} has a value it does not take")))?)
        };
        writes.push((key(&p.account_id, name), stored));
    }
    let out = engine
        .write(|c| {
            let Some(email) = c.query_row("SELECT email FROM accounts WHERE id = ?1", [&p.account_id], |r| r.get::<_, String>(0)).optional()? else {
                return Ok(None);
            };
            if let Some(n) = &display_name {
                // Blank is the address, as on add.
                let n = if n.is_empty() { email.as_str() } else { n.as_str() };
                c.execute("UPDATE accounts SET display_name = ?1 WHERE id = ?2", (n, &p.account_id))?;
            }
            for (k, v) in &writes {
                match v {
                    Some(v) => put_in(c, k, v)?,
                    None => {
                        c.execute("DELETE FROM settings WHERE key = ?1", [k])?;
                    }
                }
            }
            read_in(c, &p.account_id)
        })
        .map_err(internal)?;
    out.ok_or_else(|| RpcError::Invalid("no such account".into()))
}

/// What an import writes for an account new on the phone: its `hidden` flag and its desktop
/// settings, each checked like a page write (a value it does not take is left out), and its
/// offline window (`offlineWindow`, one of `1m 3m 6m 12m all`). Inside the import's write.
pub(crate) fn apply_import(c: &Connection, account_id: &str, hidden: bool, s: Option<&PhoneAccountSettings>) -> rusqlite::Result<()> {
    let put = |name: &str, value: Value| -> rusqlite::Result<()> {
        if let Some(v) = encode(name, &value) {
            put_in(c, &key(account_id, name), &v)?;
        }
        Ok(())
    };
    if hidden {
        put("hidden", json!(true))?;
    }
    let Some(s) = s else { return Ok(()) };
    if let Some(sig) = &s.signature {
        put("signature", json!({ "html": sig.html, "text": sig.text, "enabled": sig.enabled }))?;
    }
    if let Some(a) = s.send_as.as_deref().filter(|a| !a.is_empty()) {
        put("sendAs", json!(a))?;
    }
    if let Some(list) = s.aliases.as_ref().filter(|l| !l.is_empty()) {
        put("aliases", json!(list.iter().map(|a| json!({ "address": a.address, "name": a.name })).collect::<Vec<_>>()))?;
    }
    if let Some(f) = s.sent_folder_override.as_deref().filter(|f| !f.is_empty()) {
        put("sentFolder", json!(f))?;
    }
    if let Some(n) = &s.notifications {
        if let Some(on) = n.enabled {
            put("notify", json!(on))?;
        }
        if let Some(folders) = &n.folders {
            put("notifyFolders", json!(folders))?;
        }
        if let Some(q) = &n.quiet_hours {
            put("quietHours", json!({ "enabled": q.enabled, "start": q.start, "end": q.end }))?;
        }
    }
    if let Some(w) = s.offline_window.as_deref().filter(|w| ["1m", "3m", "6m", "12m", "all"].contains(w)) {
        put_in(c, &key(account_id, "offlineWindow"), w)?;
    }
    Ok(())
}

/// Every `acct.<id>.*` row of an account that is removed. Inside the removal's write.
pub(crate) fn forget(c: &Connection, account_id: &str) -> rusqlite::Result<()> {
    let prefix = format!("acct.{account_id}.");
    c.execute("DELETE FROM settings WHERE substr(key, 1, ?2) = ?1", rusqlite::params![prefix, prefix.chars().count() as i64])?;
    Ok(())
}

/// The account's notifications are on (`acct.<id>.notify`, on unless `false`). A read failure
/// counts as on.
pub(crate) fn notify_on(shared: &crate::db::Shared, account_id: &str) -> bool {
    shared
        .read(|c| c.query_row("SELECT value FROM settings WHERE key = ?1", [key(account_id, "notify")], |r| r.get::<_, String>(0)).optional())
        .ok()
        .flatten()
        .as_deref()
        != Some("false")
}

/// The account's `sendAs` and `aliases` (address, name), read once.
fn sending(c: &Connection, account_id: &str) -> rusqlite::Result<(String, Vec<(String, String)>)> {
    let send_as = decode("sendAs", get_in(c, &key(account_id, "sendAs"))?).as_str().unwrap_or("").trim().to_string();
    let aliases = decode("aliases", get_in(c, &key(account_id, "aliases"))?)
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["address"].as_str()?.trim().to_string(), a["name"].as_str().unwrap_or("").trim().to_string())))
        .collect();
    Ok((send_as, aliases))
}

/// Whether account `account_id` (signing in as `login`) may send from `from`: the login, its
/// `sendAs` or one of its aliases, in any case. Checked when a message is queued, with no network.
pub(crate) fn may_send_from(c: &Connection, account_id: &str, login: &str, from: &str) -> rusqlite::Result<bool> {
    let from = from.trim();
    if from.eq_ignore_ascii_case(login.trim()) {
        return Ok(true);
    }
    let (send_as, aliases) = sending(c, account_id)?;
    Ok(send_as.eq_ignore_ascii_case(from) || aliases.iter().any(|(a, _)| a.eq_ignore_ascii_case(from)))
}

/// Who a message of account `account_id` goes out as. `from` is the address compose picked
/// (checked by [`may_send_from`] when it was queued); empty is the account's default, its `sendAs`
/// or else the login. The name is the alias's own when it has one, else the account's name
/// (`display_name`). An alias removed while its message waited still sends from the address it
/// was written from, under the account's name. A read failure counts as no `sendAs` and no aliases.
pub(crate) fn identity(shared: &Shared, account_id: &str, login: &str, display_name: &str, from: &str) -> Identity {
    let (send_as, aliases) = shared.read(|c| sending(c, account_id)).unwrap_or_default();
    let address = match from.trim() {
        "" if !send_as.is_empty() => send_as,
        "" => login.trim().to_string(),
        picked => picked.to_string(),
    };
    let own = aliases.iter().find(|(a, n)| a.eq_ignore_ascii_case(&address) && !n.is_empty()).map(|(_, n)| n.clone());
    Identity { name: own.unwrap_or_else(|| display_name.trim().to_string()), address }
}

/// The folder the user picked for the account's Sent copies (`sentFolder`), if any.
pub(crate) fn sent_folder_in(c: &Connection, account_id: &str) -> rusqlite::Result<Option<String>> {
    Ok(decode("sentFolder", get_in(c, &key(account_id, "sentFolder"))?).as_str().map(str::to_string))
}

impl Engine {
    /// The account's notifications are on (`acct.<id>.notify`, on unless set to `false`). Counts
    /// only while `notifications` is on. A read failure counts as on: the global switch decides.
    pub fn account_notifications_on(&self, account_id: &str) -> bool {
        self.setting(&key(account_id, "notify")).ok().flatten().as_deref() != Some("false")
    }
}
