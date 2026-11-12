//! Phone set-up by QR code. The desktop maps its accounts to a compact
//! [`PhoneBundle`] ([`phone_bundle`]), deflates and seals it with the
//! `.mvtransfer` envelope ([`super::crypto`], no new crypto) and shows the
//! ciphertext as cycling QR frames ([`frames`]). The phone collects the frames
//! in an [`Assembler`] and opens them with [`decode_phone_bundle`].
//!
//! The bundle uses the mobile engine's own vocabulary (`kind` imap, graph or
//! jmap; `auth` password, oauth2 or bearer; `security` ssl, starttls or none;
//! `smtpSecurity` ssl or starttls), so the engine writes rows without
//! re-mapping. Accounts the phone cannot sign in with are left out and named
//! in a [`Skipped`] list instead.
//!
//! Never log or put in an error: the password, a bundle, a frame or a secret.
pub mod frames;
pub mod qr;
#[cfg(test)]
mod tests;

pub use frames::{frames, parse_frame, Assembler, FrameError, FrameHeader, Progress, MAX_FRAMES, MAX_FRAME_CHARS};
pub use qr::qr_svg;

use super::crypto::{self, Params, TransferError};
use crate::provider::Provider;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use zeroize::{Zeroize, Zeroizing};

pub const PHONE_BUNDLE_VERSION: u32 = 1;
/// Same floor as the `.mvtransfer` export.
pub const MIN_PASSWORD_CHARS: usize = 12;
/// The inflated bundle may not exceed this (a hostile code must not inflate
/// into gigabytes).
pub const MAX_PLAIN_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PhoneKind {
    Imap,
    Graph,
    Jmap,
}

impl PhoneKind {
    /// The mobile `accounts.kind` value.
    pub fn as_str(self) -> &'static str {
        match self {
            PhoneKind::Imap => "imap",
            PhoneKind::Graph => "graph",
            PhoneKind::Jmap => "jmap",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PhoneAuth {
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "oauth2")]
    OAuth2,
    /// A JMAP API token, sent as a bearer token.
    #[serde(rename = "bearer")]
    Bearer,
}

impl PhoneAuth {
    /// The mobile `accounts.auth` value.
    pub fn as_str(self) -> &'static str {
        match self {
            PhoneAuth::Password => "password",
            PhoneAuth::OAuth2 => "oauth2",
            PhoneAuth::Bearer => "bearer",
        }
    }
}

/// One account as the phone stores it. `password` holds the password, app
/// password or JMAP token; `refresh` the OAuth refresh token and `client_id`
/// the OAuth client it was issued to (mobile `secrets::Credential`). Both
/// secrets are wiped on drop; `Debug` never prints them.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAccount {
    pub email: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub display_name: String,
    pub kind: PhoneKind,
    pub auth: PhoneAuth,
    /// `google` or `microsoft` for an OAuth account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_port: Option<u16>,
    /// IMAP: `ssl`, `starttls` or `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_port: Option<u16>,
    /// `ssl` or `starttls`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_security: Option<String>,
    /// A JMAP account's session URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jmap_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

impl Drop for PhoneAccount {
    fn drop(&mut self) {
        if let Some(p) = self.password.as_mut() {
            p.zeroize();
        }
        if let Some(r) = self.refresh.as_mut() {
            r.zeroize();
        }
    }
}

impl std::fmt::Debug for PhoneAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let redact = |s: &Option<String>| s.as_ref().map(|_| "<redacted>");
        f.debug_struct("PhoneAccount")
            .field("email", &self.email)
            .field("kind", &self.kind)
            .field("auth", &self.auth)
            .field("provider", &self.provider)
            .field("imap_host", &self.imap_host)
            .field("imap_port", &self.imap_port)
            .field("security", &self.security)
            .field("smtp_host", &self.smtp_host)
            .field("smtp_port", &self.smtp_port)
            .field("smtp_security", &self.smtp_security)
            .field("jmap_url", &self.jmap_url)
            .field("password", &redact(&self.password))
            .field("refresh", &redact(&self.refresh))
            .field("client_id", &self.client_id)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneBundle {
    pub v: u32,
    pub accounts: Vec<PhoneAccount>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkipReason {
    /// No stored password or refresh token (a locked keychain, say).
    NoSecret,
    /// OAuth through a provider the phone cannot refresh (only Google and Microsoft).
    UnsupportedProvider,
    /// OAuth through a custom client id or tenant; the phone refreshes with the
    /// built-in clients only, so the token would stop working.
    CustomOauthClient,
    /// JMAP basic sign-in with a login other than the address; the phone signs
    /// in with the address.
    JmapLogin,
    /// Server settings missing or contradictory.
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub email: String,
    pub reason: SkipReason,
}

/// What the desktop shows: the frame texts and what was left out.
#[derive(Debug)]
pub struct PhoneQr {
    pub frames: Vec<String>,
    pub skipped: Vec<Skipped>,
}

#[derive(Debug)]
pub enum PhoneError {
    /// The password is shorter than [`MIN_PASSWORD_CHARS`].
    Password,
    /// Wrong password, or a modified code; deliberately indistinguishable.
    BadPassword,
    /// Not a phone bundle, or a damaged one.
    Invalid(String),
    Frame(FrameError),
}

impl std::fmt::Display for PhoneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PhoneError::Password => write!(f, "E_TRANSFER_PASSWORD"),
            PhoneError::BadPassword => write!(f, "E_TRANSFER_DECRYPT"),
            PhoneError::Invalid(d) => write!(f, "E_TRANSFER_FORMAT: {d}"),
            PhoneError::Frame(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for PhoneError {}

impl From<FrameError> for PhoneError {
    fn from(e: FrameError) -> Self {
        PhoneError::Frame(e)
    }
}

impl From<TransferError> for PhoneError {
    fn from(e: TransferError) -> Self {
        match e {
            TransferError::Decrypt => PhoneError::BadPassword,
            TransferError::Format(d) => PhoneError::Invalid(d),
        }
    }
}

/// Map the desktop's account objects (what `getAccounts()` returns, secrets
/// included) to a phone bundle. Pure; the order is kept.
pub fn phone_bundle(accounts: &Value) -> (PhoneBundle, Vec<Skipped>) {
    let mut out = Vec::new();
    let mut skipped = Vec::new();
    for a in accounts.as_array().map(Vec::as_slice).unwrap_or_default() {
        match phone_account(a) {
            Ok(acct) => out.push(acct),
            Err(reason) => skipped.push(Skipped { email: text(a, "email").unwrap_or("").to_string(), reason }),
        }
    }
    (PhoneBundle { v: PHONE_BUNDLE_VERSION, accounts: out }, skipped)
}

/// A non-blank trimmed string field.
fn text<'a>(a: &'a Value, key: &str) -> Option<&'a str> {
    a.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// A non-empty secret, untouched (a password may start or end with a space).
fn secret(a: &Value, key: &str) -> Option<String> {
    a.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// A port stored as a number or as the form's string.
fn port(a: &Value, key: &str) -> Option<u16> {
    let v = a.get(key)?;
    let n = v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))?;
    u16::try_from(n).ok().filter(|p| *p > 0)
}

fn phone_account(a: &Value) -> Result<PhoneAccount, SkipReason> {
    use SkipReason::*;
    let email = text(a, "email").ok_or(Invalid)?.to_string();
    let oauth = a.get("authType").and_then(Value::as_str) == Some("oauth2");
    // Same reading as ImapConfig::uses_graph / uses_jmap.
    let graph = a.get("oauth2Transport").and_then(Value::as_str) == Some("graph");
    let jmap_url = text(a, "jmapSessionUrl");
    let kind = if graph {
        PhoneKind::Graph
    } else if jmap_url.is_some() {
        PhoneKind::Jmap
    } else {
        PhoneKind::Imap
    };
    let mut acct = PhoneAccount {
        display_name: text(a, "name").unwrap_or("").to_string(),
        email,
        kind,
        auth: PhoneAuth::Password,
        provider: None,
        imap_host: None,
        imap_port: None,
        security: None,
        smtp_host: None,
        smtp_port: None,
        smtp_security: None,
        jmap_url: None,
        password: None,
        refresh: None,
        client_id: None,
    };

    match kind {
        PhoneKind::Imap | PhoneKind::Graph if oauth => {
            // A missing tag on a Graph account is Microsoft; a tag naming no
            // provider, or one the phone cannot sign in to, is unsupported.
            let provider = match text(a, "oauth2Provider") {
                Some(tag) => Provider::from_tag(tag),
                None => graph.then_some(Provider::Microsoft),
            };
            let provider = provider.filter(|p| matches!(p, Provider::Google | Provider::Microsoft)).ok_or(UnsupportedProvider)?;
            if graph && provider != Provider::Microsoft {
                return Err(Invalid);
            }
            // The phone refreshes with the built-in clients and the default tenant only.
            let custom_tenant = text(a, "oauth2TenantId").is_some_and(|t| !t.eq_ignore_ascii_case("common"));
            if text(a, "oauth2CustomClientId").is_some() || custom_tenant {
                return Err(CustomOauthClient);
            }
            acct.refresh = Some(secret(a, "oauth2RefreshToken").ok_or(NoSecret)?);
            acct.auth = PhoneAuth::OAuth2;
            acct.provider = Some(provider.tag().to_string());
            acct.client_id = text(a, "oauth2ClientId").map(str::to_string);
        }
        PhoneKind::Graph => return Err(Invalid),
        PhoneKind::Jmap if oauth => return Err(Invalid),
        PhoneKind::Jmap => {
            acct.auth = match text(a, "jmapAuth").map(str::to_ascii_lowercase).as_deref() {
                Some("bearer") => PhoneAuth::Bearer,
                Some("basic") => {
                    // The phone signs in with the address; it has no separate login.
                    if text(a, "jmapUsername").is_some_and(|u| !u.eq_ignore_ascii_case(&acct.email)) {
                        return Err(JmapLogin);
                    }
                    PhoneAuth::Password
                }
                _ => return Err(Invalid),
            };
            acct.jmap_url = jmap_url.map(str::to_string);
            acct.password = Some(secret(a, "password").ok_or(NoSecret)?);
        }
        PhoneKind::Imap => acct.password = Some(secret(a, "password").ok_or(NoSecret)?),
    }

    if kind == PhoneKind::Imap {
        acct.imap_host = Some(text(a, "imapHost").ok_or(Invalid)?.to_string());
        acct.imap_port = Some(port(a, "imapPort").unwrap_or(993));
        // ImapConfig::effective_security: `imapSecurity` wins, else the legacy flag.
        let security = match a.get("imapSecurity").and_then(Value::as_str) {
            Some(s) => match s.to_ascii_lowercase().as_str() {
                "starttls" => "starttls",
                "none" => "none",
                _ => "ssl",
            },
            None if a.get("imapSecure").and_then(Value::as_bool) == Some(false) => "none",
            None => "ssl",
        };
        acct.security = Some(security.to_string());
        if let Some(host) = text(a, "smtpHost") {
            let smtp_port = port(a, "smtpPort").unwrap_or(587);
            let implicit = crate::smtp::use_implicit_tls(a.get("smtpSecure").and_then(Value::as_bool), smtp_port);
            acct.smtp_host = Some(host.to_string());
            acct.smtp_port = Some(smtp_port);
            acct.smtp_security = Some(if implicit { "ssl" } else { "starttls" }.to_string());
        }
    }
    Ok(acct)
}

fn check_password(password: &str) -> Result<(), PhoneError> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(PhoneError::Password);
    }
    Ok(())
}

/// Deflate and seal `bundle` (production key derivation parameters).
pub fn seal(password: &str, bundle: &PhoneBundle) -> Result<Vec<u8>, PhoneError> {
    seal_with(password, bundle, crypto::EXPORT_PARAMS)
}

/// [`seal`] with chosen key derivation parameters. For tests only: production
/// always uses [`seal`].
#[doc(hidden)]
pub fn seal_with(password: &str, bundle: &PhoneBundle, params: Params) -> Result<Vec<u8>, PhoneError> {
    check_password(password)?;
    // Every buffer that holds secrets is sized up front: a Vec that grows reallocates and leaves
    // the old, unwiped copy behind. A counting pass gives the JSON's exact length.
    let mut counter = ByteCount(0);
    serde_json::to_writer(&mut counter, bundle).map_err(|_| PhoneError::Invalid("bundle not serializable".into()))?;
    let mut json: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(counter.0));
    serde_json::to_writer(&mut *json, bundle).map_err(|_| PhoneError::Invalid("bundle not serializable".into()))?;
    // zlib's deflateBound: deflate never outgrows this, stored blocks included.
    let bound = json.len() + (json.len() >> 12) + (json.len() >> 14) + (json.len() >> 25) + 13 + 64;
    let mut deflated: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(bound));
    let mut enc = flate2::write::DeflateEncoder::new(&mut *deflated, flate2::Compression::best());
    enc.write_all(&json).and_then(|_| enc.finish().map(|_| ())).map_err(|_| PhoneError::Invalid("compression failed".into()))?;
    Ok(crypto::encrypt_with(password, &deflated, params)?)
}

/// Counts bytes written, keeping none.
struct ByteCount(usize);

impl Write for ByteCount {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The desktop always seals with [`crypto::EXPORT_PARAMS`]; a code asking for more memory, time
/// or lanes was not made by MailVault, and must not make the phone derive (up to 1 GiB at the
/// container's own ceiling). A ceiling, not equality: tests seal with cheaper parameters. Read
/// from the header before any key derivation; too short a code falls through to `decrypt`.
fn check_kdf_ceiling(sealed: &[u8]) -> Result<(), PhoneError> {
    if sealed.len() < 19 {
        return Ok(());
    }
    let u32_at = |i: usize| u32::from_le_bytes([sealed[i], sealed[i + 1], sealed[i + 2], sealed[i + 3]]);
    let max = crypto::EXPORT_PARAMS;
    if u32_at(7) > max.m_kib || u32_at(11) > max.t || u32_at(15) > max.p {
        return Err(PhoneError::Invalid("key derivation parameters out of range".into()));
    }
    Ok(())
}

/// Open a sealed bundle.
pub fn open(password: &str, sealed: &[u8]) -> Result<PhoneBundle, PhoneError> {
    check_kdf_ceiling(sealed)?;
    let deflated = Zeroizing::new(crypto::decrypt(password, sealed)?);
    // The whole limit up front (1 MiB): `read_to_end` then never reallocates, so no unwiped copy
    // of the plain bundle is left behind.
    let mut plain: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(MAX_PLAIN_BYTES as usize + 1));
    flate2::read::DeflateDecoder::new(&deflated[..])
        .take(MAX_PLAIN_BYTES + 1)
        .read_to_end(&mut plain)
        .map_err(|_| PhoneError::Invalid("not a phone bundle".into()))?;
    if plain.len() as u64 > MAX_PLAIN_BYTES {
        return Err(PhoneError::Invalid("bundle too large".into()));
    }
    // serde_json's message can quote the input, so it never reaches the error.
    let bundle: PhoneBundle = serde_json::from_slice(&plain).map_err(|_| PhoneError::Invalid("not a phone bundle".into()))?;
    if bundle.v != PHONE_BUNDLE_VERSION {
        return Err(PhoneError::Invalid(format!("unsupported version {}", bundle.v)));
    }
    Ok(bundle)
}

/// The phone's whole path: assemble `frames` (any order, repeats allowed),
/// decrypt and parse. Runs argon2, so call it off the UI/RPC thread.
pub fn decode_phone_bundle<S: AsRef<str>>(password: &str, frames: &[S]) -> Result<PhoneBundle, PhoneError> {
    let mut assembler = Assembler::new();
    for frame in frames {
        assembler.push(frame.as_ref())?;
    }
    open(password, &assembler.finish()?)
}

/// The desktop's whole path: map, seal and split into frame texts. No
/// supported account means no frames (and no key derivation).
pub fn encode_phone_qr(password: &str, accounts: &Value) -> Result<PhoneQr, PhoneError> {
    encode_phone_qr_with(password, accounts, crypto::EXPORT_PARAMS)
}

/// [`encode_phone_qr`] with chosen key derivation parameters. For tests only.
#[doc(hidden)]
pub fn encode_phone_qr_with(password: &str, accounts: &Value, params: Params) -> Result<PhoneQr, PhoneError> {
    check_password(password)?;
    let (bundle, skipped) = phone_bundle(accounts);
    if bundle.accounts.is_empty() {
        return Ok(PhoneQr { frames: Vec::new(), skipped });
    }
    let sealed = seal_with(password, &bundle, params)?;
    Ok(PhoneQr { frames: frames::frames(&sealed, MAX_FRAME_CHARS)?, skipped })
}
