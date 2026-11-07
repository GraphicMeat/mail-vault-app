//! The mobile shell's one native plugin, kept in the repo because no official plugin does this at
//! Tauri 2.12: `tauri-plugin-opener`'s mobile `open_path` hands a raw file path to the URL opener
//! (no QuickLook on iOS, no FileProvider on Android), and there is no official share plugin.
//!
//! - `open_file`: QuickLook (`QLPreviewController`) on iOS, `ACTION_VIEW` through the app's
//!   FileProvider on Android.
//! - `share_file`: `UIActivityViewController` on iOS, an `ACTION_SEND` chooser on Android.
//! - `open_url`: the system browser or mail app (`UIApplication.open`, `ACTION_VIEW` +
//!   `CATEGORY_BROWSABLE`).
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

use serde::Serialize;
use std::path::Path;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mv_native);

/// Why a native call failed. `code` is one the page translates: `NO_APP` (nothing on the device
/// opens this), `BUSY` (a previewer is already up), `UNSUPPORTED` (not a phone), else `INTERNAL`.
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
                    _ => "INTERNAL",
                };
                NativeError::new(code, r.message.unwrap_or_default())
            }
            other => NativeError::new("INTERNAL", other.to_string()),
        }
    }
}

/// The native side. Every method blocks until the native call answers: on iOS `open_file` and
/// `share_file` answer when the previewer or sheet is dismissed. Never call one on the main thread.
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
}

/// How the shell hears about a navigation verdict: `(scheme, verdict)`, never the URL.
pub type NavLog = fn(&str, &str);

/// The plugin. `log` (perf-gate builds) hears each cancelled navigation.
pub fn init<R: Runtime>(log: Option<NavLog>) -> TauriPlugin<R> {
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
