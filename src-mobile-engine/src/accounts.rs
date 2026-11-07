//! Accounts: `mobile.accounts.{list,test,add,remove}` (IMAP password accounts so far) and
//! [`AccountRow`], the one way the engine reads an account's settings.
//!
//! The secret goes to the platform secret store, as a [`Credential`] envelope, and nowhere else:
//! never into `mobile.db`, a reply, a log line or an error message (core's error strings carry the
//! address, not the password, and [`scrub`] strips the password anyway before a message leaves
//! this module).

use crate::db::{Engine, EngineError, Shared, PER_ACCOUNT_TABLES};
use crate::rpc::{parse, RpcError};
use crate::secrets::Credential;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

/// The typed failure codes of the accounts RPCs. The UI translates them; the message beside each
/// is for logs only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    AuthFailed,
    HostUnreachable,
    TlsFailed,
    Timeout,
    Duplicate,
    Invalid,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::AuthFailed => "AUTH_FAILED",
            Code::HostUnreachable => "HOST_UNREACHABLE",
            Code::TlsFailed => "TLS_FAILED",
            Code::Timeout => "TIMEOUT",
            Code::Duplicate => "DUPLICATE",
            Code::Invalid => "INVALID",
        }
    }
}

/// The one place core's `String` errors become codes. Order matters: a TLS failure wins over the
/// connection words its text may also hold, a timeout over everything (core words a stalled LOGIN
/// "Login for X timed out", which must not read as a wrong password), and "connection lost while
/// signing in" is a network failure even though it mentions signing in.
///
/// Anything unrecognised is `Invalid` with core's message, except text that names a connection
/// level failure, which is `HostUnreachable`.
pub fn map_error(msg: &str) -> Code {
    let m = msg.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| m.contains(n));
    if has(&["tls handshake", "certificate"]) {
        Code::TlsFailed
    } else if has(&["timed out", "timeout"]) {
        Code::Timeout
    } else if has(&["connection lost", "connection abort", "not connected", "broken pipe", "connection reset"])
        || mailvault_core::imap::pool::is_connection_lost(msg)
    {
        Code::HostUnreachable
    } else if has(&["login failed", "auth failed", "authenticationfailed", "invalid credentials", "authentication failed"]) {
        Code::AuthFailed
    } else if has(&[
        "tcp connect",
        "dns resolve failed",
        "no ipv4 address",
        "failed to read server greeting",
        "connection refused",
        "network is unreachable",
        "no route to host",
    ]) {
        Code::HostUnreachable
    } else {
        Code::Invalid
    }
}

/// The error message for a reply: core's text with the password removed.
fn scrub(msg: &str, password: &str) -> String {
    if password.is_empty() {
        msg.to_string()
    } else {
        msg.replace(password, "***")
    }
}

fn failure(code: Code, message: impl Into<String>) -> Value {
    json!({ "ok": false, "code": code.as_str(), "message": message.into() })
}

/// What signing in to an account needs from its row. `auth` is `password`, `oauth2` or `bearer`;
/// `security` and `smtp_security` are `ssl`, `starttls` or `none`.
pub(crate) struct AccountRow {
    pub(crate) email: String,
    pub(crate) auth: String,
    pub(crate) imap_host: String,
    pub(crate) imap_port: u16,
    pub(crate) security: String,
    pub(crate) smtp_host: Option<String>,
    pub(crate) smtp_port: Option<u16>,
    pub(crate) smtp_security: Option<String>,
}

impl AccountRow {
    /// A password account that has no row yet (the add form, `net::test_login`).
    pub(crate) fn password(email: &str, imap_host: &str, imap_port: u16, security: &str) -> AccountRow {
        AccountRow {
            email: email.into(),
            auth: "password".into(),
            imap_host: imap_host.into(),
            imap_port,
            security: security.into(),
            smtp_host: None,
            smtp_port: None,
            smtp_security: None,
        }
    }
}

/// Account `id`'s row, or `None` when there is no such account.
pub(crate) fn load_account(shared: &Shared, id: &str) -> Result<Option<AccountRow>, EngineError> {
    shared.read(|c| {
        c.query_row(
            "SELECT email, auth, imap_host, imap_port, security, smtp_host, smtp_port, smtp_security FROM accounts WHERE id = ?1",
            [id],
            |r| {
                Ok(AccountRow {
                    email: r.get(0)?,
                    auth: r.get(1)?,
                    imap_host: r.get(2)?,
                    imap_port: r.get::<_, i64>(3)? as u16,
                    security: r.get(4)?,
                    smtp_host: r.get(5)?,
                    smtp_port: r.get::<_, Option<i64>>(6)?.map(|p| p as u16),
                    smtp_security: r.get(7)?,
                })
            },
        )
        .optional()
    })
}

impl Engine {
    /// Every account id, oldest first. For the shell's one-time secret re-save at startup, which
    /// must not go through [`Engine::rpc`]: the first RPC starts the journal replay, and replay
    /// reads secrets.
    pub fn account_ids(&self) -> Result<Vec<String>, EngineError> {
        self.read(|c| {
            let mut st = c.prepare_cached("SELECT id FROM accounts ORDER BY created_ms, id")?;
            let ids = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(ids)
        })
    }
}

struct Form {
    email: String,
    password: String,
    imap_host: String,
    imap_port: u16,
    security: String,
    display_name: Option<String>,
}

/// Reads the form by hand: serde's errors echo the offending value ("invalid type: integer
/// `12345`"), which for the password field would put the secret in a reply. Every error here names
/// the field only.
fn read_form(params: &Value) -> Result<Form, String> {
    let obj = params.as_object().ok_or("params must be an object")?;
    let text = |k: &str| -> Result<String, String> {
        match obj.get(k) {
            Some(Value::String(s)) => Ok(s.clone()),
            _ => Err(format!("{k} must be a string")),
        }
    };
    let port = match obj.get("imapPort").and_then(Value::as_u64) {
        Some(p) if (1..=65535).contains(&p) => p as u16,
        _ => return Err("imapPort must be 1-65535".into()),
    };
    let display_name = match obj.get("displayName") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        _ => return Err("displayName must be a string".into()),
    };
    Ok(Form {
        email: text("email")?,
        password: text("password")?,
        imap_host: text("imapHost")?,
        imap_port: port,
        security: text("security")?,
        display_name,
    })
}

impl Form {
    /// Trims the text fields; the first problem comes back as the reply's message.
    fn from_params(params: &Value) -> Result<Form, Value> {
        read_form(params).and_then(Form::validate).map_err(|m| failure(Code::Invalid, m))
    }

    fn validate(mut self) -> Result<Form, String> {
        self.email = self.email.trim().to_string();
        self.imap_host = self.imap_host.trim().to_string();
        let at = self.email.find('@');
        if at.is_none_or(|i| i == 0 || i + 1 >= self.email.len()) || self.email.chars().any(char::is_whitespace) {
            return Err("email is not an address".into());
        }
        if self.imap_host.is_empty() {
            return Err("imapHost is empty".into());
        }
        if self.imap_port == 0 {
            return Err("imapPort must be 1-65535".into());
        }
        if self.password.is_empty() {
            return Err("password is empty".into());
        }
        if !matches!(self.security.as_str(), "ssl" | "starttls" | "none") {
            return Err("security must be ssl, starttls or none".into());
        }
        Ok(self)
    }

    /// Signs in with the form's values. `Err` is the reply to send.
    fn test_login(&self) -> Result<u32, Value> {
        let row = AccountRow::password(&self.email, &self.imap_host, self.imap_port, &self.security);
        crate::net::login(&row, &Credential::from_password(&self.password)).map_err(|e| {
            let code = map_error(&e);
            let message = scrub(&e, &self.password);
            failure(code, message)
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `acc_` + 16 hex chars from a random u64: the per-process `RandomState` keys come from the OS,
/// mixed with the clock so two ids in one process differ. Never derived from the email.
fn new_account_id() -> String {
    let mut h = RandomState::new().build_hasher();
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    format!("acc_{:016x}", h.finish())
}

fn account_json(id: &str, email: &str, display_name: &str, host: &str, port: i64, security: &str) -> Value {
    json!({ "id": id, "email": email, "displayName": display_name, "imapHost": host, "imapPort": port, "security": security })
}

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

pub(crate) fn list(engine: &Engine, _: Value) -> Result<Value, RpcError> {
    let accounts = engine
        .read(|c| {
            let mut st = c.prepare_cached(
                "SELECT id, email, display_name, imap_host, imap_port, security FROM accounts ORDER BY created_ms, id",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(account_json(
                        &r.get::<_, String>(0)?,
                        &r.get::<_, String>(1)?,
                        &r.get::<_, String>(2)?,
                        &r.get::<_, String>(3)?,
                        r.get(4)?,
                        &r.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(internal)?;
    Ok(json!({ "accounts": accounts }))
}

pub(crate) fn test(_: &Engine, params: Value) -> Result<Value, RpcError> {
    let form = match Form::from_params(&params) {
        Ok(f) => f,
        Err(reply) => return Ok(reply),
    };
    Ok(match form.test_login() {
        Ok(count) => json!({ "ok": true, "messageCount": count }),
        Err(reply) => reply,
    })
}

fn email_taken(engine: &Engine, email: &str) -> Result<bool, RpcError> {
    engine
        .read(|c| {
            c.query_row("SELECT 1 FROM accounts WHERE email = ?1 COLLATE NOCASE", [email], |_| Ok(()))
                .optional()
                .map(|o| o.is_some())
        })
        .map_err(internal)
}

pub(crate) fn add(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let form = match Form::from_params(&params) {
        Ok(f) => f,
        Err(reply) => return Ok(reply),
    };
    if email_taken(engine, &form.email)? {
        return Ok(failure(Code::Duplicate, "this account is already added"));
    }
    // Always test here: a prior `accounts.test` proves nothing about these values.
    if let Err(reply) = form.test_login() {
        return Ok(reply);
    }
    let id = new_account_id();
    let secret = Credential::from_password(&form.password).to_secret();
    engine.secrets().set(&id, &secret).map_err(|e| internal(scrub(&scrub(&e, &secret), &form.password)))?;
    let display_name = form.display_name.as_deref().map(str::trim).filter(|d| !d.is_empty()).unwrap_or(&form.email).to_string();
    let inserted = engine.write(|c| {
        c.execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (&id, &form.email, &display_name, &form.imap_host, form.imap_port as i64, &form.security, now_ms()),
        )?;
        Ok(())
    });
    if let Err(e) = inserted {
        // Best effort: if this fails too, the secret is unreferenced and `remove` can never reach it,
        // but nothing reads an id without a row.
        let _ = engine.secrets().delete(&id);
        // A second add of the same address that raced past the check above.
        if is_unique_violation(&e.to_string()) {
            return Ok(failure(Code::Duplicate, "this account is already added"));
        }
        return Err(internal(e));
    }
    Ok(json!({
        "ok": true,
        "account": account_json(&id, &form.email, &display_name, &form.imap_host, form.imap_port as i64, &form.security),
    }))
}

fn is_unique_violation(db_error: &str) -> bool {
    db_error.contains("UNIQUE constraint failed")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    account_id: String,
}

pub(crate) fn remove(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: RemoveParams = parse(params)?;
    let existed = engine
        .write(|c| {
            for t in PER_ACCOUNT_TABLES {
                c.execute(&format!("DELETE FROM {t} WHERE account_id = ?1"), [&p.account_id])?;
            }
            Ok(c.execute("DELETE FROM accounts WHERE id = ?1", [&p.account_id])? > 0)
        })
        .map_err(internal)?;
    // Rows first: a failure here leaves a secret for an account that is gone, and repeating the
    // call (which still reaches this line) removes it.
    engine.secrets().delete(&p.account_id).map_err(internal)?;
    Ok(json!({ "removed": existed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_failed() {
        assert_eq!(map_error("Login failed for u@example.test: NO [AUTHENTICATIONFAILED] Invalid credentials"), Code::AuthFailed);
        assert_eq!(map_error("XOAUTH2 auth failed for u@x: NO Invalid credentials"), Code::AuthFailed);
    }

    #[test]
    fn socket_errors_are_network() {
        for e in [
            "STORE flags failed: io: Software caused connection abort (os error 53)",
            "UID MOVE 1 failed: io: Socket is not connected (os error 57)",
            "SEARCH failed: io: Broken pipe (os error 32)",
            "STORE flags failed: io: Connection reset by peer (os error 54)",
        ] {
            assert_eq!(map_error(e), Code::HostUnreachable, "{e}");
        }
    }

    #[test]
    fn host_unreachable() {
        assert_eq!(map_error("TCP connect to h:993 failed: Connection refused (os error 111)"), Code::HostUnreachable);
        assert_eq!(map_error("DNS resolve failed for h:993: failed to lookup address information"), Code::HostUnreachable);
        assert_eq!(map_error("No IPv4 address found for h"), Code::HostUnreachable);
        assert_eq!(map_error("connection lost while signing in to h: x"), Code::HostUnreachable);
        assert_eq!(map_error("Failed to read server greeting: io"), Code::HostUnreachable);
    }

    #[test]
    fn tls_failed() {
        assert_eq!(map_error("TLS handshake with h failed: certificate has expired"), Code::TlsFailed);
        assert_eq!(map_error("STARTTLS TLS handshake with h failed: x"), Code::TlsFailed);
    }

    #[test]
    fn timeout() {
        assert_eq!(map_error("timed out after 15s"), Code::Timeout);
        assert_eq!(map_error("Login for u@example.test timed out after 30s"), Code::Timeout);
        assert_eq!(map_error("TCP connect to h:993 failed: future timed out"), Code::Timeout);
    }

    #[test]
    fn invalid_is_the_fallback_and_duplicate_is_never_mapped() {
        assert_eq!(map_error("SELECT INBOX failed: weird"), Code::Invalid);
        assert_eq!(map_error("Password missing"), Code::Invalid);
        assert_eq!(Code::Duplicate.as_str(), "DUPLICATE");
    }

    #[test]
    fn scrub_removes_the_password() {
        assert_eq!(scrub("bad pw hunter2 here", "hunter2"), "bad pw *** here");
    }

    #[test]
    fn ids_are_acc_plus_16_hex_and_differ() {
        let a = new_account_id();
        assert!(a.starts_with("acc_") && a.len() == 20 && a[4..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, new_account_id());
    }
}
