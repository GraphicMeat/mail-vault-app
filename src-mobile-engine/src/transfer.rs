//! `mobile.transfer.import`: the phone's half of "Set up the mobile app". The page collects the
//! QR frames the desktop shows (it reads only their headers, for progress); here core assembles
//! them, opens the sealed bundle with the user's password ([`decode_phone_bundle`], argon2: the
//! shell already runs every RPC on a blocking thread) and each account becomes a row and a secret
//! through [`accounts::insert_new`], like every other add. No sign-in test: the first sync says
//! whether an account works, through the usual banners (a refused OAuth grant parks it as
//! `needsAuth`, a refused password holds it).
//!
//! Reply: `{ok: true, imported: [email], existing: [email], skipped: [{email, reason}]}`, or
//! `{ok: false, code}` with `PASSWORD_SHORT` (under 12 characters, nothing tried), `BAD_PASSWORD`
//! (wrong password or a modified code, indistinguishable) or `INVALID` (not a whole MailVault
//! code, or bad params). A skip `reason` is `invalid` (settings the phone cannot use),
//! `no-secret` or `internal` (the secret store refused it).
//!
//! Never logged or put in a reply or error: the password, a frame, the bundle or a secret.

use crate::accounts::{self, AccountRow, InsertError};
use crate::db::Engine;
use crate::rpc::RpcError;
use crate::secrets::Credential;
use mailvault_core::transfer::phone::{decode_phone_bundle, PhoneAccount, PhoneAuth, PhoneError, PhoneKind, MAX_FRAMES, MAX_FRAME_CHARS, MIN_PASSWORD_CHARS};
use serde_json::{json, Value};
use std::collections::HashSet;
use zeroize::Zeroizing;

/// The camera reads every frame many times; the page sends each once, but a few repeats are fine.
const MAX_FRAME_TEXTS: usize = MAX_FRAMES * 4;

fn refused(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// The params, read by hand: serde's errors quote the offending value, which here is the password
/// or a piece of the sealed bundle. Every error names the field only.
fn read_params(params: &Value) -> Result<(Vec<String>, Zeroizing<String>), &'static str> {
    let obj = params.as_object().ok_or("params must be an object")?;
    let password = match obj.get("password") {
        Some(Value::String(s)) => Zeroizing::new(s.clone()),
        _ => return Err("password must be a string"),
    };
    let Some(Value::Array(items)) = obj.get("frames") else {
        return Err("frames must be a list of strings");
    };
    if items.len() > MAX_FRAME_TEXTS {
        return Err("too many frames");
    }
    let mut frames = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(s) if s.len() <= MAX_FRAME_CHARS => frames.push(s.clone()),
            _ => return Err("frames must be a list of strings"),
        }
    }
    Ok((frames, password))
}

pub(crate) fn import(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let (frames, password) = match read_params(&params) {
        Ok(p) => p,
        Err(m) => return Ok(refused("INVALID", m)),
    };
    // Core enforces the floor on sealing only; a short password never reaches argon2 here either.
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Ok(refused("PASSWORD_SHORT", "the password has fewer than 12 characters"));
    }
    let bundle = match decode_phone_bundle(&password, &frames) {
        Ok(b) => b,
        Err(PhoneError::Password) => return Ok(refused("PASSWORD_SHORT", "the password has fewer than 12 characters")),
        Err(PhoneError::BadPassword) => return Ok(refused("BAD_PASSWORD", "the password does not open this code")),
        // Core's text names the problem, never the data.
        Err(e @ (PhoneError::Invalid(_) | PhoneError::Frame(_))) => return Ok(refused("INVALID", &e.to_string())),
    };
    drop(password);

    let mut imported = Vec::new();
    let mut existing = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = HashSet::new();
    for acct in &bundle.accounts {
        let email = acct.email.trim().to_string();
        // The same address twice in one code: the first one counts.
        if !seen.insert(email.to_lowercase()) {
            existing.push(email);
            continue;
        }
        let (row, cred) = match to_row(acct, &email) {
            Ok(r) => r,
            Err(reason) => {
                skipped.push(json!({ "email": email, "reason": reason }));
                continue;
            }
        };
        if accounts::email_taken(engine, &email)? {
            existing.push(email);
            continue;
        }
        match accounts::insert_new(engine, &row, &cred, |_, _| Ok(())) {
            Ok(_) => imported.push(email),
            Err(InsertError::Duplicate) => existing.push(email),
            Err(InsertError::Secret(_)) => skipped.push(json!({ "email": email, "reason": "internal" })),
            Err(InsertError::Db(e)) => return Err(RpcError::Internal(e)),
        }
    }
    Ok(json!({ "ok": true, "imported": imported, "existing": existing, "skipped": skipped }))
}

/// A bundle account as the row and secret every add path stores, or why the phone cannot use it.
/// The bundle speaks the engine's vocabulary already; this checks it, since a code is input.
fn to_row(a: &PhoneAccount, email: &str) -> Result<(AccountRow, Credential), &'static str> {
    let at = email.find('@');
    if at.is_none_or(|i| i == 0 || i + 1 >= email.len()) || email.chars().any(char::is_whitespace) {
        return Err("invalid");
    }
    let nonblank = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let secret = |s: &Option<String>| s.as_deref().filter(|s| !s.is_empty()).map(str::to_string);

    let cred = match a.auth {
        PhoneAuth::Password | PhoneAuth::Bearer => Credential::from_password(&secret(&a.password).ok_or("no-secret")?),
        PhoneAuth::OAuth2 => Credential { refresh: Some(secret(&a.refresh).ok_or("no-secret")?), client_id: nonblank(&a.client_id), ..Credential::default() },
    };
    let mut row = match a.kind {
        PhoneKind::Imap => {
            let host = nonblank(&a.imap_host).ok_or("invalid")?;
            let security = nonblank(&a.security).unwrap_or_else(|| "ssl".into());
            if !matches!(security.as_str(), "ssl" | "starttls" | "none") {
                return Err("invalid");
            }
            let mut row = AccountRow::password(email, &host, a.imap_port.filter(|p| *p > 0).unwrap_or(993), &security);
            // No SMTP server on the computer: none here either (sending then says so), never a guess.
            if let Some(smtp) = nonblank(&a.smtp_host) {
                let smtp_security = nonblank(&a.smtp_security).unwrap_or_else(|| "ssl".into());
                if !matches!(smtp_security.as_str(), "ssl" | "starttls") {
                    return Err("invalid");
                }
                let default_port = if smtp_security == "ssl" { 465 } else { 587 };
                row.smtp_host = Some(smtp);
                row.smtp_port = Some(a.smtp_port.filter(|p| *p > 0).unwrap_or(default_port));
                row.smtp_security = Some(smtp_security);
            }
            match a.auth {
                PhoneAuth::Password => {}
                PhoneAuth::OAuth2 => {
                    let provider = nonblank(&a.provider).ok_or("invalid")?;
                    if provider != "google" && provider != "microsoft" {
                        return Err("invalid");
                    }
                    row.auth = "oauth2".into();
                    row.provider = Some(provider);
                }
                PhoneAuth::Bearer => return Err("invalid"),
            }
            row
        }
        PhoneKind::Graph => {
            if a.auth != PhoneAuth::OAuth2 || nonblank(&a.provider).as_deref() != Some("microsoft") {
                return Err("invalid");
            }
            // Graph needs no host; the column is required, so it holds Outlook's IMAP, unused (as a
            // Microsoft sign-in stores it).
            let mut row = AccountRow::password(email, "outlook.office365.com", 993, "ssl");
            row.kind = "graph".into();
            row.auth = "oauth2".into();
            row.provider = Some("microsoft".into());
            row
        }
        PhoneKind::Jmap => {
            let auth = match a.auth {
                PhoneAuth::Password => "password",
                PhoneAuth::Bearer => "bearer",
                PhoneAuth::OAuth2 => return Err("invalid"),
            };
            // The add form's own check: https only, no user name or password in the URL.
            let url = crate::backend::jmap::session_url(&nonblank(&a.jmap_url).ok_or("invalid")?).map_err(|_| "invalid")?;
            let (host, port) = crate::backend::jmap::host_port(&url);
            let mut row = AccountRow::password(email, &host, port, "ssl");
            row.kind = "jmap".into();
            row.auth = auth.into();
            row.jmap_url = Some(url.to_string());
            row
        }
    };
    let name = a.display_name.trim();
    row.display_name = if name.is_empty() { email.to_string() } else { name.to_string() };
    Ok((row, cred))
}
