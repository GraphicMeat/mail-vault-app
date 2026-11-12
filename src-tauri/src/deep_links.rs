//! `mailto:` / activation-link queues, their e2e hatches and the deep-link registration at startup.

use super::*;

// ── Client identity (persistent per-install UUID for device registration) ────

/// Stands in for the OS handing over a `mailto:` URL.
///
/// The e2e harness disables `tauri-plugin-single-instance` (see the automation
/// carve-out below), and that plugin is exactly what forwards a real deep link
/// to the running app — so no test can produce a genuine handover. This injects
/// one at the same seam the real one uses (queue, then wake-up) and is inert
/// outside the `webdriver` build.
/// Test-only twin of e2e_queue_mailto for `mailvault://activate` links.
#[tauri::command]
pub(crate) fn e2e_queue_activation(app: tauri::AppHandle, url: String) {
    #[cfg(feature = "webdriver")]
    {
        app.state::<activation_link::PendingActivation>().push(url);
        let _ = app.emit("activation-open", ());
    }
    #[cfg(not(feature = "webdriver"))]
    {
        let _ = (app, url);
    }
}

#[tauri::command]
pub(crate) fn e2e_queue_mailto(app: tauri::AppHandle, url: String) {
    #[cfg(feature = "webdriver")]
    {
        app.state::<mailto::PendingMailto>().push(url);
        let _ = app.emit("mailto-open", ());
    }
    #[cfg(not(feature = "webdriver"))]
    {
        let _ = (app, url);
    }
}

#[tauri::command]
pub(crate) fn take_pending_mailto(state: tauri::State<mailto::PendingMailto>) -> Vec<String> {
    state.take()
}

#[tauri::command]
pub(crate) fn take_pending_activation(state: tauri::State<activation_link::PendingActivation>) -> Vec<String> {
    state.take()
}

#[tauri::command]
pub(crate) fn mailto_default_status() -> mailto::MailtoStatus {
    mailto::portable_status().unwrap_or_else(mailto::status)
}

#[tauri::command]
pub(crate) async fn mailto_make_default() -> mailto::MailtoStatus {
    if let Some(status) = mailto::portable_status() {
        return status;
    }
    // macOS launches a helper and then polls LaunchServices for up to five
    // seconds; Linux shells out to `xdg-settings`. Neither belongs on the main
    // thread — the window would freeze for the duration.
    tauri::async_runtime::spawn_blocking(mailto::make_default)
        .await
        .unwrap_or_else(|_| mailto::status())
}

pub(crate) fn setup_deep_links(app: &mut tauri::App) {
    // `mailto:` from the OS. The queue is the source of truth and the
    // event is only a wake-up: when the click *launches* the app the URL
    // lands here before the webview exists, so a listener alone would
    // drop the first mailto of every cold start.
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            let mailto_queue = handle.state::<mailto::PendingMailto>();
            let activation_queue = handle.state::<activation_link::PendingActivation>();
            let (mut mail, mut activation) = (false, false);
            for url in event.urls() {
                if activation_link::is_activation_url(url.as_str()) {
                    activation_queue.push(url.to_string());
                    activation = true;
                } else {
                    mailto_queue.push(url.to_string());
                    mail = true;
                }
            }
            if let Some(window) = handle.get_webview_window("main") {
                show_main_window(&window);
            }
            if mail {
                let _ = handle.emit("mailto-open", ());
            }
            if activation {
                let _ = handle.emit("activation-open", ());
            }
        });
        // The URL this process was launched with, if any.
        if let Ok(Some(urls)) = app.deep_link().get_current() {
            let mailto_queue = app.state::<mailto::PendingMailto>();
            let activation_queue = app.state::<activation_link::PendingActivation>();
            for url in urls {
                if activation_link::is_activation_url(url.as_str()) {
                    activation_queue.push(url.to_string());
                } else {
                    mailto_queue.push(url.to_string());
                }
            }
        }
        // Linux and Windows register at runtime; macOS is static, from
        // `CFBundleURLTypes` in the bundle.
        // Never from a portable copy: it would make the host open mail
        // links with an app on a drive that may not be plugged in.
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if mailvault_core::paths::portable_root().is_none() {
            let _ = app.deep_link().register_all();
            // The scheme alone does not put MailVault in Windows' Default
            // apps list; the registered-application entry does.
            #[cfg(target_os = "windows")]
            mailto::register();
        }
    }
}
