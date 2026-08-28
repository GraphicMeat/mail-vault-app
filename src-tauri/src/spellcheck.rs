//! Spell checking, and the one platform that cannot do it alone.
//!
//! macOS and Windows carry a system checker — WKWebView reads WebKit's
//! `WebContinuousSpellCheckingEnabled` (registered in `main`), WebView2
//! inherits Chromium's — so on both the editor's `spellcheck` attribute is the
//! whole story. WebKitGTK is different twice over: the checker is off until it
//! is switched on, and it needs a hunspell dictionary that plenty of desktops
//! (and every strictly-confined snap) do not have. With no dictionary the
//! switch is silent, which from the toolbar is indistinguishable from a broken
//! feature — so the app reports which of the two is true and offers the
//! install line instead of a toggle that would do nothing.
//!
//! Dictionary discovery itself lives in `mailvault_core::spellcheck`, where it
//! is plain enough to be tested on every platform rather than only on Linux.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellcheckStatus {
    /// True only where MailVault has to find its own dictionaries — Linux.
    /// Elsewhere the OS checks spelling and there is nothing to install.
    pub needs_dictionary: bool,
    /// Language tags available, e.g. `["en_GB", "lt_LT"]`. Empty alongside
    /// `needsDictionary` is the case that needs the instructions.
    pub dictionaries: Vec<String>,
    /// Running as a strictly-confined snap, where installing a dictionary on
    /// the host cannot help — the instructions have to say something else.
    pub confined: bool,
}

#[cfg(target_os = "linux")]
fn available_dictionaries() -> Vec<String> {
    mailvault_core::spellcheck::available()
}

#[cfg(not(target_os = "linux"))]
fn available_dictionaries() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
pub fn spellcheck_status() -> SpellcheckStatus {
    SpellcheckStatus {
        needs_dictionary: cfg!(target_os = "linux"),
        dictionaries: available_dictionaries(),
        confined: cfg!(target_os = "linux") && std::env::var_os("SNAP").is_some(),
    }
}

/// Switch WebKitGTK's checker on for the whole web context — every window the
/// app opens shares it — and point it at the dictionaries that exist. A no-op
/// everywhere else, where the OS checker needs no help.
#[cfg(target_os = "linux")]
pub fn enable_for_window(window: &tauri::WebviewWindow) {
    use webkit2gtk::{WebContextExt, WebViewExt};

    let found = available_dictionaries();
    if found.is_empty() {
        // Nothing to check against. Leaving it off costs nothing and keeps the
        // app's answer to `spellcheck_status` honest.
        tracing::info!("spellcheck: no dictionary found; WebKitGTK's checker stays off");
        return;
    }
    let langs = mailvault_core::spellcheck::preferred_languages(&found);
    tracing::info!("spellcheck: dictionaries {:?}, checking against {:?}", found, langs);
    let reached = window.with_webview(move |webview| {
        if let Some(context) = webview.inner().context() {
            let refs: Vec<&str> = langs.iter().map(String::as_str).collect();
            context.set_spell_checking_languages(&refs);
            context.set_spell_checking_enabled(true);
        }
    });
    if let Err(e) = reached {
        tracing::warn!("spellcheck: could not reach the webview: {}", e);
    }
}

#[cfg(not(target_os = "linux"))]
pub fn enable_for_window(_window: &tauri::WebviewWindow) {}
