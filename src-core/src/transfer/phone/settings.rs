//! The desktop's settings in a phone bundle: the global ones ([`PhoneSettings`], applied by the
//! phone on the first import that carries them) and each account's own
//! ([`PhoneAccountSettings`], applied to accounts new on the phone).
//!
//! Every field is optional and read leniently ([`lenient`]): a newer desktop that changes a
//! field's shape loses that field, never the import. An older phone ignores the whole block
//! (the bundle has no `deny_unknown_fields`), an older desktop sends none.
//!
//! The QR code has room for a few frames of settings ([`SETTINGS_BUDGET_BYTES`]): when they do
//! not fit, [`fit`] drops templates first, then images inline in signatures, then signatures,
//! then the rest of the settings. Accounts and their secrets are never dropped for settings.
use super::PhoneBundle;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::io::Write;

/// A field read as JSON first, then as `T`: a value of another shape is `None`, not an error.
pub(crate) fn lenient<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Option<T>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).ok())
}

/// [`lenient`] for a struct: only a JSON object is one (serde would also read a list by position).
pub(crate) fn lenient_object<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Option<T>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.is_object().then(|| serde_json::from_value(v).ok()).flatten())
}

/// One of the desktop's message templates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneTemplate {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub body: String,
}

/// A sender whose mail notifies through quiet hours (or is marked important).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneImportantSender {
    #[serde(rename = "match")]
    pub matches: String,
    #[serde(default)]
    pub through_quiet_hours: bool,
}

/// The desktop's global settings the phone takes, in the desktop's own value vocabulary (the
/// phone maps values it does not have). Wire names are the desktop setting names.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneSettings {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub language: Option<String>,
    /// `light` | `dark`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub theme: Option<String>,
    /// `graphite` | `indigo` | `teal`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub palette: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub email_viewer_theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub date_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub custom_date_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub time_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub thread_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub thread_sort_order: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub mark_as_read_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub mark_as_read_delay: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub confirm_before_delete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub after_delete_select: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub swipe_left_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub swipe_right_action: Option<String>,
    /// Seconds a sent message waits (undo send); 0 sends at once.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub send_delay: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub auto_save_drafts: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub attachment_reminder: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub default_signature_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub hold_external_content: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub link_safety_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub link_safety_click_confirm: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub tracker_blocking_enabled: Option<bool>,
    /// `notificationSettings.showPreview`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub notification_preview: Option<bool>,
    /// `notificationSettings.importantSenders`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub important_senders: Option<Vec<PhoneImportantSender>>,
    /// `emailTemplates`, at most [`MAX_TEMPLATES`].
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub templates: Option<Vec<PhoneTemplate>>,
}

/// An account's signature: the desktop's html and text, and whether it is on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneSignature {
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub text: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneAlias {
    pub address: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PhoneQuietHours {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub end: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAccountNotifications {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub folders: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_object")]
    pub quiet_hours: Option<PhoneQuietHours>,
}

/// One account's own settings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAccountSettings {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_object")]
    pub signature: Option<PhoneSignature>,
    /// The default From: empty is the login.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub send_as: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub aliases: Option<Vec<PhoneAlias>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub sent_folder_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_object")]
    pub notifications: Option<PhoneAccountNotifications>,
    /// `1m` | `3m` | `6m` | `12m` | `all` ([`offline_window`]).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub offline_window: Option<String>,
}

impl PhoneAccountSettings {
    fn is_empty(&self) -> bool {
        *self == PhoneAccountSettings::default()
    }
}

/// The most templates a code carries.
pub const MAX_TEMPLATES: usize = 50;
/// The most characters of one template body or signature html a code carries.
pub const MAX_TEXT_CHARS: usize = 64 * 1024;
/// Deflated bytes the settings may add to a code: two frames.
pub const SETTINGS_BUDGET_BYTES: usize = 2 * super::frames::CHUNK_BYTES;
/// Plain JSON bytes the settings may add: well under what the phone inflates
/// ([`super::MAX_PLAIN_BYTES`]), whatever it deflates to.
pub const SETTINGS_PLAIN_BYTES: usize = 256 * 1024;

/// The phone's offline window for a desktop fetch mode (`fetchModes[id]`, else `fetchMode`) and
/// `localCacheDurationMonths`: `hoarder` keeps everything, `keepRecent` its months (the nearest of
/// 1, 3, 6 and 12; a tie takes the longer), anything else three months.
pub fn offline_window(fetch_mode: Option<&str>, months: Option<f64>) -> &'static str {
    match fetch_mode {
        Some("hoarder") => "all",
        Some("keepRecent") => match months {
            Some(m) if m.is_finite() && m > 0.0 => {
                let mut best = (f64::INFINITY, "3m");
                for (n, tag) in [(1.0, "1m"), (3.0, "3m"), (6.0, "6m"), (12.0, "12m")] {
                    let d = (m - n).abs();
                    if d <= best.0 {
                        best = (d, tag);
                    }
                }
                best.1
            }
            _ => "3m",
        },
        _ => "3m",
    }
}

fn clip(s: &mut String, max: usize) {
    if let Some((i, _)) = s.char_indices().nth(max) {
        s.truncate(i);
    }
}

/// The global settings from the desktop's snapshot, capped.
pub fn global_settings(v: Option<&Value>) -> Option<PhoneSettings> {
    let mut s: PhoneSettings = serde_json::from_value(v.filter(|v| v.is_object())?.clone()).ok()?;
    if let Some(t) = s.templates.as_mut() {
        t.truncate(MAX_TEMPLATES);
        for tpl in t.iter_mut() {
            clip(&mut tpl.name, 200);
            clip(&mut tpl.body, MAX_TEXT_CHARS);
        }
        if t.is_empty() {
            s.templates = None;
        }
    }
    (s != PhoneSettings::default()).then_some(s)
}

/// One account's settings from the desktop's account object: its `phoneSettings` block, with the
/// offline window from its `fetchMode` and `cacheMonths`.
pub fn account_settings(a: &Value) -> Option<PhoneAccountSettings> {
    let block = a.get("phoneSettings").filter(|b| b.is_object());
    let mut s: PhoneAccountSettings = block.and_then(|b| serde_json::from_value(b.clone()).ok()).unwrap_or_default();
    if let Some(sig) = s.signature.as_mut() {
        clip(&mut sig.html, MAX_TEXT_CHARS);
        clip(&mut sig.text, MAX_TEXT_CHARS);
    }
    if let Some(b) = block {
        let mode = b.get("fetchMode").and_then(Value::as_str);
        let months = b.get("cacheMonths").and_then(Value::as_f64);
        if mode.is_some() || months.is_some() {
            s.offline_window = Some(offline_window(mode, months).to_string());
        }
    }
    (!s.is_empty()).then_some(s)
}

/// `html` without its `<img>` tags whose source is a `data:` URI (an image pasted into a
/// signature, often far bigger than the rest of the code).
pub fn strip_data_images(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    while let Some(rel) = lower[at..].find("<img") {
        let start = at + rel;
        let end = lower[start..].find('>').map_or(html.len(), |e| start + e + 1);
        out.push_str(&html[at..start]);
        let tag = &lower[start..end];
        if !tag.contains("data:") {
            out.push_str(&html[start..end]);
        }
        at = end;
    }
    out.push_str(&html[at..]);
    out
}

/// Deflated length of `bundle` as JSON (what the code carries, before the fixed sealing overhead)
/// and the JSON's own length. The JSON (passwords and tokens in it) is streamed into the encoder
/// and never held: a buffer that grows reallocates and leaves the old block, secrets and all,
/// unwiped.
fn deflated_len(bundle: &PhoneBundle) -> Option<(usize, usize)> {
    let mut counter = Counter(0);
    let json_len = {
        let enc = flate2::write::DeflateEncoder::new(&mut counter, flate2::Compression::best());
        let mut plain = Counted { n: 0, inner: enc };
        serde_json::to_writer(&mut plain, bundle).ok()?;
        let Counted { n, inner } = plain;
        inner.finish().ok()?;
        n
    };
    Some((counter.0, json_len))
}

/// Passes writes on to `inner`, counting the bytes.
struct Counted<W> {
    n: usize,
    inner: W,
}

impl<W: Write> Write for Counted<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.n += n;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

struct Counter(usize);

impl Write for Counter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// How far [`fit`] had to cut, in its order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Degrade {
    Full,
    NoTemplates,
    NoSignatureImages,
    NoSignatures,
    NoSettings,
}

/// Cuts `bundle`'s settings until they fit the code's settings budget: deflated, they add at most
/// [`SETTINGS_BUDGET_BYTES`]; inflated, at most [`SETTINGS_PLAIN_BYTES`]; and the whole code stays
/// within [`super::MAX_FRAMES`]. Drops templates, then `data:` images in signatures, then
/// signatures, then every setting. Never touches an account's sign-in. Deflates only (no
/// sealing), so it is cheap.
pub fn fit(bundle: &mut PhoneBundle) -> Degrade {
    let bare = {
        let mut b = bundle.clone();
        strip_all(&mut b);
        deflated_len(&b)
    };
    let Some((bare_deflated, bare_plain)) = bare else {
        strip_all(bundle);
        return Degrade::NoSettings;
    };
    let fits = |b: &PhoneBundle| {
        deflated_len(b).is_some_and(|(d, p)| {
            let frames = (d + super::SEALED_OVERHEAD).div_ceil(super::frames::CHUNK_BYTES);
            d.saturating_sub(bare_deflated) <= SETTINGS_BUDGET_BYTES
                && p.saturating_sub(bare_plain) <= SETTINGS_PLAIN_BYTES
                && frames <= super::MAX_FRAMES
        })
    };
    if fits(bundle) {
        return Degrade::Full;
    }
    if let Some(s) = bundle.settings.as_mut() {
        s.templates = None;
    }
    if fits(bundle) {
        return Degrade::NoTemplates;
    }
    for a in bundle.accounts.iter_mut() {
        if let Some(sig) = a.settings.as_mut().and_then(|s| s.signature.as_mut()) {
            sig.html = strip_data_images(&sig.html);
        }
    }
    if fits(bundle) {
        return Degrade::NoSignatureImages;
    }
    for a in bundle.accounts.iter_mut() {
        if let Some(s) = a.settings.as_mut() {
            s.signature = None;
        }
    }
    if fits(bundle) {
        return Degrade::NoSignatures;
    }
    strip_all(bundle);
    Degrade::NoSettings
}

fn strip_all(b: &mut PhoneBundle) {
    b.settings = None;
    for a in b.accounts.iter_mut() {
        a.settings = None;
    }
}
