//! The mobile shell's one native plugin, kept in the repo because no official plugin does this at
//! Tauri 2.12: `tauri-plugin-opener`'s mobile `open_path` hands a raw file path to the URL opener
//! (no QuickLook on iOS, no FileProvider on Android), and there is no official share plugin.
//!
//! - `open_file`: QuickLook (`QLPreviewController`) on iOS, `ACTION_VIEW` through the app's
//!   FileProvider on Android.
//! - `share_file`: `UIActivityViewController` on iOS, an `ACTION_SEND` chooser on Android.
//! - `open_url`: the system browser or mail app (`UIApplication.open`, `ACTION_VIEW` +
//!   `CATEGORY_BROWSABLE`).
//! - `pick_files`: the system document picker or photo picker for outgoing attachments. The
//!   native side copies each pick into a scratch dir the shell names; the shell names and moves the
//!   copies ([`files::finish_pick`]).
//! - `open_auth` / `close_auth`: the system sign-in sheet for an OAuth flow
//!   (`ASWebAuthenticationSession` on iOS, a Custom Tab on Android), only for a URL
//!   [`links::auth_url_ok`] accepts. The provider redirects to the engine's loopback listener, so the
//!   sheet never hands a code back here: `open_auth` answers when the sheet closes, by the user's
//!   cancel (`cancelled`) or by `close_auth`.
//! - `set_background_refresh` / `request_notifications`: the OS's periodic background run (iOS
//!   `BGAppRefreshTask` requests, Android WorkManager unique periodic work `mv-refresh`) on or off,
//!   and the notification permission. The background run itself and notification taps reach the
//!   shell directly (`src-tauri-mobile/src/background.rs`), with no app or webview needed.
//! - `store_products` / `store_purchase` / `store_restore`: App Store (StoreKit 2) and Google Play
//!   (Billing 7) subscriptions ([`store`]). The native side hands every transaction to the engine
//!   through the shell's own export and finishes it (iOS) only when the server answered; these
//!   calls answer the outcome and the engine's verdict, never a receipt. The native side also
//!   listens for transactions from the moment the plugin loads (renewals, approvals, purchases a
//!   killed app never verified).
//! - A navigation hook: every navigation of the webview goes through [`links::decide`]. Web and
//!   mail links are cancelled and handed to `open_url`; anything but the app page and the mail
//!   frame's own document is cancelled. A popup never becomes a Tauri webview: iOS opens none
//!   (wry has no `createWebView` there), Android catches it in a bare, unshown WebView without
//!   JavaScript that only reads the URL and is destroyed (`android/.../PopupChromeClient.kt`); an
//!   accepted URL (`PopupUrlPolicy`) goes straight to the system, never to the app's WebView.
//!
//! The plugin registers no commands, so JS cannot call it: the shell calls it from Rust, after
//! checking the path it was given (`files`).

pub mod files;
pub mod links;
pub mod pick;
pub mod store;

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mv_native);

/// Why a native call failed. `code` is one the page translates: `NO_APP` (nothing on the device
/// opens this), `BUSY` (a previewer, sheet or picker is already up), `UNSUPPORTED` (not a phone),
/// the store's `UNAVAILABLE` (no store, not signed in, billing off, no network), `NOT_FOUND` (the
/// store does not offer the product) and `OWNED` (Play: already subscribed, Restore instead),
/// else `INTERNAL`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NativeError {
    pub code: String,
    pub message: String,
}

impl NativeError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        NativeError { code: code.to_string(), message: message.into() }
    }
}

#[cfg(mobile)]
impl From<tauri::plugin::mobile::PluginInvokeError> for NativeError {
    fn from(e: tauri::plugin::mobile::PluginInvokeError) -> Self {
        use tauri::plugin::mobile::PluginInvokeError;
        match e {
            PluginInvokeError::InvokeRejected(r) => {
                let code = match r.code.as_deref() {
                    Some("NO_APP") => "NO_APP",
                    Some("BUSY") => "BUSY",
                    Some("UNAVAILABLE") => "UNAVAILABLE",
                    Some("NOT_FOUND") => "NOT_FOUND",
                    Some("OWNED") => "OWNED",
                    _ => "INTERNAL",
                };
                NativeError::new(code, r.message.unwrap_or_default())
            }
            other => NativeError::new("INTERNAL", other.to_string()),
        }
    }
}

/// The native side. Every method blocks until the native call answers: on iOS `open_file` and
/// `share_file` answer when the previewer or sheet is dismissed, and `pick_files` on both
/// platforms when the picker closes. Never call one on the main thread.
pub struct MvNative<R: Runtime> {
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(mobile))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

#[derive(Serialize)]
struct FileArgs<'a> {
    path: &'a str,
    mime: &'a str,
}

#[derive(Serialize)]
struct UrlArgs<'a> {
    url: &'a str,
}

/// Which system picker [`MvNative::pick_files`] shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickKind {
    /// The document picker (Files on iOS, the storage access framework on Android).
    Files,
    /// The photo picker; no photo library or storage permission on either platform.
    Photos,
}

#[derive(Serialize)]
struct PickArgs<'a> {
    kind: &'a str,
    dir: &'a str,
}

#[derive(Serialize)]
struct RefreshArgs {
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PurchaseArgs<'a> {
    product_id: &'a str,
}

#[derive(Serialize)]
struct NoArgs {}

#[derive(Serialize)]
struct CloseArgs<'a> {
    url: Option<&'a str>,
}

#[derive(Serialize)]
struct PermissionArgs {
    prompt: bool,
}

#[derive(Deserialize)]
struct GrantReply {
    #[serde(default)]
    granted: bool,
}

/// How the sign-in sheet closed: `cancelled` when the user closed it (or it was replaced by a newer
/// one), not when `close_auth` did.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct AuthReply {
    #[serde(default)]
    pub cancelled: bool,
}

/// One pick as the native side reports it: `file` is the copy's name in the scratch dir (its
/// decimal index), `name` and `mime` what the provider said. `error` (`UNREADABLE`) instead of
/// `file` when the provider could not hand over every byte. Nothing here is trusted.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawPick {
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct PickReply {
    #[serde(default)]
    items: Vec<RawPick>,
}

impl<R: Runtime> MvNative<R> {
    /// Shows `path` (a staged, named file under the share directory) in the system previewer.
    pub fn open_file(&self, path: &Path, mime: &str) -> Result<(), NativeError> {
        self.file_call("openFile", path, mime)
    }

    /// Offers `path` to the system share sheet.
    pub fn share_file(&self, path: &Path, mime: &str) -> Result<(), NativeError> {
        self.file_call("shareFile", path, mime)
    }

    /// Opens an http(s) or mailto URL outside the app. Callers pass only what [`links::decide`]
    /// returned as `External`.
    pub fn open_url(&self, url: &str) -> Result<(), NativeError> {
        if !matches!(links::decide_str(url, links::AppOrigin::current()), links::Nav::External(_)) {
            return Err(NativeError::new("INTERNAL", "not a link the system may open"));
        }
        self.call("openUrl", UrlArgs { url })
    }

    /// Shows the system picker and blocks until it closes. Each pick is copied into `dir` (an
    /// existing, empty scratch directory) as `<dir>/<index>`; cancel is an empty list.
    pub fn pick_files(&self, kind: PickKind, dir: &Path) -> Result<Vec<RawPick>, NativeError> {
        let dir = dir.to_str().ok_or_else(|| NativeError::new("INTERNAL", "path is not UTF-8"))?;
        let kind = match kind {
            PickKind::Files => "files",
            PickKind::Photos => "photos",
        };
        let reply: PickReply = self.call_for("pickFiles", PickArgs { kind, dir })?;
        Ok(reply.items)
    }

    /// Shows the provider's sign-in page in the system sign-in sheet and blocks until it closes.
    /// Refuses (`INVALID`) anything [`links::auth_url_ok`] does not accept.
    pub fn open_auth(&self, url: &str) -> Result<AuthReply, NativeError> {
        if !links::auth_url_ok(url) {
            return Err(NativeError::new("INVALID", "not a sign-in page this app opens"));
        }
        self.call_for("openAuth", UrlArgs { url })
    }

    /// Closes the sign-in sheet of `url` if it is up (its `open_auth` then answers
    /// `cancelled: false`). Idempotent. A close of `url` that arrives before that sheet's open
    /// (the two calls take different threads) is remembered, and that open answers at once
    /// without showing anything. `None` closes whatever sheet is up. Answers at once.
    pub fn close_auth(&self, url: Option<&str>) -> Result<(), NativeError> {
        self.call("closeAuth", CloseArgs { url })
    }

    /// Turns the periodic background run on (queued unless already queued) or off.
    pub fn set_background_refresh(&self, enabled: bool) -> Result<(), NativeError> {
        self.call("setBackgroundRefresh", RefreshArgs { enabled })
    }

    /// Asks for the notification permission when the platform has one to ask for (iOS, Android 13
    /// and later); `true` when notifications may be posted. Blocks until the user has chosen.
    /// With `prompt` false it only reads the current answer (the user may have changed it in the
    /// system settings), never asking.
    pub fn request_notifications(&self, prompt: bool) -> Result<bool, NativeError> {
        let reply: GrantReply = self.call_for("requestNotifications", PermissionArgs { prompt })?;
        Ok(reply.granted)
    }

    /// The store's offer for our products, raw: `{products: [...]}`; read it with
    /// [`store::products`].
    pub fn store_products(&self) -> Result<serde_json::Value, NativeError> {
        self.call_for("storeProducts", NoArgs {})
    }

    /// Runs the store's purchase sheet for `product_id` and blocks until it closes and a bought
    /// subscription has been handed to the engine. Refuses (`INVALID`) a product not ours. Raw
    /// reply; read it with [`store::purchase_reply`].
    pub fn store_purchase(&self, product_id: &str) -> Result<serde_json::Value, NativeError> {
        if !store::product_ok(product_id) {
            return Err(NativeError::new("INVALID", "not a MailVault product"));
        }
        self.call_for("storePurchase", PurchaseArgs { product_id })
    }

    /// Restore Purchases: syncs with the store (iOS may ask the user to sign in) and hands each
    /// subscription the store account holds to the engine as a restore. Raw reply; read it with
    /// [`store::restore_reply`].
    pub fn store_restore(&self) -> Result<serde_json::Value, NativeError> {
        self.call_for("storeRestore", NoArgs {})
    }

    fn file_call(&self, method: &str, path: &Path, mime: &str) -> Result<(), NativeError> {
        let path = path.to_str().ok_or_else(|| NativeError::new("INTERNAL", "path is not UTF-8"))?;
        let mime = files::sanitize_mime(mime);
        self.call(method, FileArgs { path, mime: &mime })
    }

    #[cfg(mobile)]
    fn call<A: Serialize>(&self, method: &str, args: A) -> Result<(), NativeError> {
        self.handle.run_mobile_plugin::<serde_json::Value>(method, args).map(|_| ()).map_err(NativeError::from)
    }

    #[cfg(not(mobile))]
    fn call<A: Serialize>(&self, method: &str, _args: A) -> Result<(), NativeError> {
        Err(NativeError::new("UNSUPPORTED", format!("{method}: phones only")))
    }

    #[cfg(mobile)]
    fn call_for<A: Serialize, T: serde::de::DeserializeOwned>(&self, method: &str, args: A) -> Result<T, NativeError> {
        self.handle.run_mobile_plugin::<T>(method, args).map_err(NativeError::from)
    }

    #[cfg(not(mobile))]
    fn call_for<A: Serialize, T: serde::de::DeserializeOwned>(&self, method: &str, _args: A) -> Result<T, NativeError> {
        Err(NativeError::new("UNSUPPORTED", format!("{method}: phones only")))
    }
}

/// How the shell hears about a navigation verdict: `(scheme, verdict)`, never the URL.
pub type NavLog = fn(&str, &str);

/// The navigation guard, a plugin of its own with no native part, so registering it cannot fail
/// or wait: the shell adds it on the builder, before any webview loads. Every navigation is
/// decided by [`links::decide`] (deny unless allowed). A web or mail link is cancelled and, if the
/// native plugin ([`init`]) is loaded, handed to the system; without it nothing opens.
/// `log` (perf-gate builds) hears each cancelled navigation.
pub fn nav_guard<R: Runtime>(log: Option<NavLog>) -> TauriPlugin<R> {
    Builder::new("mv-nav")
        .on_navigation(move |webview, url| {
            let verdict = links::decide(url, links::AppOrigin::current());
            if let Some(log) = log {
                match verdict {
                    links::Nav::Allow => {}
                    links::Nav::External(_) => log(links::scheme_of(url), "external"),
                    links::Nav::Deny => log(links::scheme_of(url), "deny"),
                }
            }
            match verdict {
                links::Nav::Allow => true,
                links::Nav::Deny => false,
                links::Nav::External(target) => {
                    // The hook runs on the UI thread and the native call waits for the UI thread:
                    // hand it to another thread and cancel the navigation now.
                    let app = webview.app_handle().clone();
                    std::thread::spawn(move || {
                        if let Some(native) = app.try_state::<MvNative<R>>() {
                            let _ = native.open_url(&target);
                        }
                    });
                    false
                }
            }
        })
        .build()
}

/// The native plugin (previewer, share sheet, pickers, sign-in sheet, links out, store purchases). On Android registering it waits until
/// the webview exists, so the shell adds it at the end of its setup.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mv-native")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin("com.mailvault.mvnative", "MvNativePlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_mv_native)?;
            #[cfg(mobile)]
            app.manage(MvNative::<R> { handle });
            #[cfg(not(mobile))]
            {
                let _ = api;
                app.manage(MvNative::<R> { _runtime: std::marker::PhantomData });
            }
            Ok(())
        })
        .build()
}
