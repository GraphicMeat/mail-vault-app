//! System tray: the account rows `set_tray_accounts` keeps in the tray menu, and the tray icon itself.
//! Moved out of `main.rs` verbatim; `setup_tray` is the former tray block of `setup`.

use super::*;

/// Localize the menu bar without rebuilding it.
///
/// The menu is built in `setup`, before the webview exists. The chosen language
/// lives in the frontend's zustand store, persisted to the webview's
/// localStorage — which Rust cannot read. So Rust builds English at startup and
/// the frontend pushes translated labels down once it knows the locale, and
/// again on every change.
///
/// Setting text on the existing items beats rebuilding the menu: the `#[cfg]`
/// guards around `check_updates` (absent on MAS builds) and the per-platform
/// Settings accelerator stay exactly where they are.
/// Handle to the tray menu, kept because `TrayIcon` exposes no way back to it,
/// and how many account rows (their separator included) `set_tray_accounts`
/// last put in it.
pub(crate) struct TrayMenu(pub(crate) tauri::menu::Menu<tauri::Wry>, pub(crate) std::sync::Mutex<usize>);

/// Where the account rows start: under Compose and its separator.
pub(crate) const TRAY_ACCOUNTS_AT: usize = 2;
/// Menu id prefix of an account row; the rest of the id is the account id.
pub(crate) const TRAY_ACCOUNT_PREFIX: &str = "tray_account:";

#[derive(Deserialize)]
pub(crate) struct TrayAccount {
    id: String,
    label: String,
    unread: u32,
}

/// An account row's text: the sidebar's label and, when there is any, its
/// unread count. A bare `&` on Windows underlines the next letter instead.
pub(crate) fn tray_account_text(label: &str, unread: u32) -> String {
    let label = if cfg!(windows) { label.replace('&', "&&") } else { label.to_string() };
    if unread > 0 { format!("{label} ({unread})") } else { label }
}

/// The tray menu's account rows, one per sidebar account in its order, with the
/// unread counts the sidebar shows (the dock badge is their sum). The frontend
/// pushes them whenever one changes; the rows are swapped out wholesale, so the
/// fixed items keep the labels `apply_menu_labels` gave them.
#[tauri::command]
pub(crate) fn set_tray_accounts(app: tauri::AppHandle, accounts: Vec<TrayAccount>) -> Result<(), String> {
    let Some(tray) = app.try_state::<TrayMenu>() else { return Ok(()) };
    let mut shown = tray.1.lock().map_err(|e| e.to_string())?;
    while *shown > 0 {
        tray.0.remove_at(TRAY_ACCOUNTS_AT).map_err(|e| e.to_string())?;
        *shown -= 1;
    }
    if accounts.is_empty() {
        return Ok(());
    }
    for (i, account) in accounts.iter().enumerate() {
        let item = MenuItem::with_id(
            &app,
            format!("{TRAY_ACCOUNT_PREFIX}{}", account.id),
            tray_account_text(&account.label, account.unread),
            true,
            None::<&str>,
        ).map_err(|e| e.to_string())?;
        tray.0.insert(&item, TRAY_ACCOUNTS_AT + i).map_err(|e| e.to_string())?;
        *shown += 1;
    }
    let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    tray.0.insert(&sep, TRAY_ACCOUNTS_AT + accounts.len()).map_err(|e| e.to_string())?;
    *shown += 1;
    Ok(())
}


pub(crate) fn setup_tray(app: &mut tauri::App, _check_updates: menu::CheckUpdatesItem) -> Result<(), Box<dyn std::error::Error>> {
    // --- Set up system tray ---
    // Compose, then the account rows (`set_tray_accounts` inserts them
    // at TRAY_ACCOUNTS_AT once the frontend knows the accounts).
    let tray_compose = MenuItem::with_id(app, "tray_compose", "Compose", true, None::<&str>)?;
    let tray_show = MenuItem::with_id(app, "show", "Show MailVault", true, None::<&str>)?;
    let tray_view_logs = MenuItem::with_id(app, "tray_view_logs", "View Logs", true, None::<&str>)?;
    let tray_quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let tray_menu = Menu::with_items(app, &[
        &tray_compose as &dyn tauri::menu::IsMenuItem<_>,
        &sep0 as &dyn tauri::menu::IsMenuItem<_>,
        &tray_show as &dyn tauri::menu::IsMenuItem<_>,
        &sep1 as &dyn tauri::menu::IsMenuItem<_>,
        &tray_view_logs as &dyn tauri::menu::IsMenuItem<_>,
        &sep2 as &dyn tauri::menu::IsMenuItem<_>,
        &tray_quit as &dyn tauri::menu::IsMenuItem<_>,
    ])?;
    // No menu bar on Windows, so the tray is where a manual update
    // check lives. Same id as the menu bar item: the app-wide
    // `on_menu_event` above already handles it, and
    // `apply_menu_labels` localizes it.
    #[cfg(windows)]
    tray_menu.insert(&_check_updates, 4)?;
    // Linux: the menu bar can be hidden, so the tray offers the update
    // check too. A separate item with the same id, since the File menu
    // already holds `check_updates`.
    #[cfg(target_os = "linux")]
    {
        let tray_check_updates = MenuItem::with_id(app, "check_updates", "Check for Updates...", true, None::<&str>)?;
        tray_menu.insert(&tray_check_updates, 4)?;
    }

    // TrayIcon exposes no `menu()` accessor, so keep a handle to the tray
    // menu in state — `apply_menu_labels` relabels it alongside the menu bar.
    app.manage(TrayMenu(tray_menu.clone(), std::sync::Mutex::new(0)));

    // The black template glyph suits the macOS menu bar only; on a dark
    // Windows taskbar or GNOME top bar it all but disappears. Everything
    // else gets the app icon cropped to its artwork: the bundle icon keeps
    // the macOS margin (art fills 78% of the square), which drew it
    // visibly smaller than its tray neighbours (issue #16).
    #[cfg(target_os = "macos")]
    let tray_icon_image = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .expect("Failed to load tray icon");
    #[cfg(not(target_os = "macos"))]
    let tray_icon_image = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon-color.png"))
        .expect("Failed to load tray icon");

    TrayIconBuilder::with_id("mailvault-tray")
        .icon(tray_icon_image)
        .icon_as_template(true)
        .menu(&tray_menu)
        // A menu bar extra opens its menu on a click; a Windows or
        // Linux tray icon brings the window back and keeps the menu
        // on the right button.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    show_main_window(&window);
                }
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // Compose and an account row bring the window forward
            // first; the page does the rest, as the sidebar would.
            if id == "tray_compose" || id.starts_with(TRAY_ACCOUNT_PREFIX) {
                if let Some(window) = app.get_webview_window("main") {
                    show_main_window(&window);
                }
                if let Some(account_id) = id.strip_prefix(TRAY_ACCOUNT_PREFIX) {
                    let _ = app.emit_to("main", "tray-open-account", account_id);
                } else {
                    let _ = app.emit_to("main", "tray-compose", ());
                }
                return;
            }
            match id {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        show_main_window(&window);
                    }
                }
                "tray_view_logs" => {
                    if let Some(log_dir) = app.try_state::<LogDir>() {
                        #[cfg(target_os = "macos")]
                        let _ = std::process::Command::new("open").arg(&log_dir.0).spawn();
                        #[cfg(target_os = "windows")]
                        let _ = std::process::Command::new("explorer").arg(&log_dir.0).spawn();
                        #[cfg(target_os = "linux")]
                        let _ = std::process::Command::new("xdg-open").arg(&log_dir.0).spawn();
                    }
                }
                "quit" => {
                    info!("Application quitting via tray menu");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}
