//! Menu bar: native label localisation, the Linux bar toggle, and the app menu with its event handler.

use super::*;

/// Linux: the File/Logs menu bar, kept even while it is not attached (Settings >
/// Appearance > Layout > Menu bar off) so it can be attached later and relabeled.
#[cfg(target_os = "linux")]
pub(crate) struct LinuxMenuBar(pub(crate) tauri::menu::Menu<tauri::Wry>);

/// What the frontend last pushed through `apply_menu_labels`, for native text
/// no menu item holds: the update dialogs and the window titles.
#[derive(Default)]
pub(crate) struct NativeText(pub(crate) std::sync::Mutex<std::collections::HashMap<String, String>>);

/// The pushed text for `id`; `english` until the frontend has pushed any.
pub(crate) fn native_text(app: &tauri::AppHandle, id: &str, english: &str) -> String {
    app.try_state::<NativeText>()
        .and_then(|state| state.0.lock().ok().and_then(|labels| labels.get(id).cloned()))
        .unwrap_or_else(|| english.to_string())
}

#[tauri::command]
pub(crate) fn apply_menu_labels(
    app: tauri::AppHandle,
    labels: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    fn relabel(
        items: Vec<tauri::menu::MenuItemKind<tauri::Wry>>,
        labels: &std::collections::HashMap<String, String>,
    ) {
        for item in items {
            let id = item.id().0.clone();
            match item {
                tauri::menu::MenuItemKind::MenuItem(i) => {
                    if let Some(t) = labels.get(&id) {
                        let _ = i.set_text(t);
                    }
                }
                tauri::menu::MenuItemKind::Submenu(sub) => {
                    if let Some(t) = labels.get(&id) {
                        let _ = sub.set_text(t);
                    }
                    if let Ok(children) = sub.items() {
                        relabel(children, labels);
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(state) = app.try_state::<NativeText>() {
        if let Ok(mut held) = state.0.lock() {
            held.extend(labels.clone());
        }
    }
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            relabel(items, &labels);
        }
    }
    if let Some(tray) = app.try_state::<TrayMenu>() {
        if let Ok(items) = tray.0.items() {
            relabel(items, &labels);
        }
    }
    // A detached menu bar: `app.menu()` above does not see it.
    #[cfg(target_os = "linux")]
    if app.menu().is_none() {
        if let Some(bar) = app.try_state::<LinuxMenuBar>() {
            if let Ok(items) = bar.0.items() {
                relabel(items, &labels);
            }
        }
    }
    Ok(())
}

/// Linux: show or hide the File/Logs menu bar of the calling window
/// (Settings > Appearance > Layout > Menu bar). Every window runs this for
/// itself once the settings hydrate. A no-op elsewhere: macOS keeps its
/// global menu and Windows has no menu bar.
#[tauri::command]
pub(crate) fn set_menu_bar_visible(window: tauri::Window, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let app = window.app_handle();
        if visible {
            // Started with the bar off, the menu was never attached.
            if app.menu().is_none() {
                if let Some(bar) = app.try_state::<LinuxMenuBar>() {
                    app.set_menu(bar.0.clone()).map_err(|e| e.to_string())?;
                }
            }
            window.show_menu().map_err(|e| e.to_string())?;
        } else if app.menu().is_some() {
            window.hide_menu().map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (window, visible);
    Ok(())
}

/// Linux: Ctrl+Q from the page. A menu bar that was never attached (Settings >
/// Appearance > Layout > Menu bar off at launch) has no GTK accelerators, so
/// File > Quit's Ctrl+Q reaches the webview instead (utils/menuBar.js).
#[tauri::command]
pub(crate) fn quit_app(app: tauri::AppHandle) {
    info!("Application quitting via Ctrl+Q");
    app.exit(0);
}

/// What `setup_menu_bar` hands to `setup_tray`: the `check_updates` item, which the
/// Windows tray menu reuses. macOS without Sparkle has no such item.
#[cfg(any(not(target_os = "macos"), feature = "sparkle"))]
pub(crate) type CheckUpdatesItem = MenuItem<tauri::Wry>;
#[cfg(all(target_os = "macos", not(feature = "sparkle")))]
pub(crate) type CheckUpdatesItem = ();

pub(crate) fn setup_menu_bar(app: &mut tauri::App) -> Result<CheckUpdatesItem, Box<dyn std::error::Error>> {
    // --- Set up app menu ---
    // No "Check for Updates" on MAS builds — the App Store handles updates.
    #[cfg(any(not(target_os = "macos"), feature = "sparkle"))]
    let check_updates = MenuItem::with_id(app, "check_updates", "Check for Updates...", true, None::<&str>)?;
    #[cfg(target_os = "macos")]
    let open_settings = MenuItem::with_id(app, "open_settings", "Settings...", true, Some("cmd+,"))?;
    #[cfg(target_os = "linux")]
    let open_settings = MenuItem::with_id(app, "open_settings", "Settings...", true, Some("ctrl+,"))?;
    #[cfg(not(windows))]
    let report_bug = MenuItem::with_id(app, "report_bug", "Report Bug...", true, None::<&str>)?;
    #[cfg(not(windows))]
    let export_logs = MenuItem::with_id(app, "export_logs", "Export Logs...", true, None::<&str>)?;
    #[cfg(not(windows))]
    let logs_submenu = Submenu::with_id(app, "logs_submenu", "Logs", true)?;
    #[cfg(not(windows))]
    logs_submenu.append(&export_logs)?;
    #[cfg(not(windows))]
    let website_item = MenuItem::with_id(app, "open_website", "MailVault Website", true, None::<&str>)?;
    #[cfg(not(windows))]
    let blog_item = MenuItem::with_id(app, "open_blog", "Blog", true, None::<&str>)?;
    #[cfg(not(windows))]
    let more_apps_item = MenuItem::with_id(app, "open_more_apps", "More Apps by GraphicMeat", true, None::<&str>)?;

    #[cfg(target_os = "macos")]
    {
        let menu = Menu::default(app.handle())?;
        // Insert items below "About MailVault" in the app submenu
        if let Ok(items) = menu.items() {
            if let Some(first) = items.first() {
                if let Some(app_submenu) = first.as_submenu() {
                    let sep1 = PredefinedMenuItem::separator(app)?;
                    let sep2 = PredefinedMenuItem::separator(app)?;
                    let _ = app_submenu.insert(&sep1, 1);
                    #[cfg(feature = "sparkle")]
                    let _ = app_submenu.insert(&check_updates, 2);
                    #[cfg(feature = "sparkle")]
                    let _ = app_submenu.insert(&open_settings, 3);
                    #[cfg(not(feature = "sparkle"))]
                    let _ = app_submenu.insert(&open_settings, 2);
                    #[cfg(feature = "sparkle")]
                    let _ = app_submenu.insert(&report_bug, 4);
                    #[cfg(not(feature = "sparkle"))]
                    let _ = app_submenu.insert(&report_bug, 3);
                    #[cfg(feature = "sparkle")]
                    let _ = app_submenu.insert(&sep2, 5);
                    #[cfg(not(feature = "sparkle"))]
                    let _ = app_submenu.insert(&sep2, 4);
                }
            }
        }
        menu.append(&logs_submenu)?;

        // Populate the Help menu (default menu creates it empty)
        let shortcuts_item = MenuItem::with_id(app, "open_shortcuts", "Keyboard Shortcuts", true, Some("cmd+/"))?;
        if let Ok(items) = menu.items() {
            for item in &items {
                if let Some(sub) = item.as_submenu() {
                    if sub.text().unwrap_or_default() == "Help" {
                        let _ = sub.append(&website_item);
                        let _ = sub.append(&blog_item);
                        let _ = sub.append(&more_apps_item);
                        let _ = sub.append(&shortcuts_item);
                        break;
                    }
                }
            }
        }
        app.set_menu(menu)?;
    }

    // Windows gets no menu bar: a File/Logs strip under the title bar
    // is not how Windows apps look. Check for Updates moves to the
    // tray menu below; Settings and bug reports are in the app itself.
    #[cfg(target_os = "linux")]
    {
        let sep = PredefinedMenuItem::separator(app)?;
        let quit_item = MenuItem::with_id(app, "quit_app", "Quit", true, Some("ctrl+q"))?;
        let file_submenu = Submenu::with_id(app, "file_submenu", "File", true)?;
        file_submenu.append(&check_updates)?;
        file_submenu.append(&open_settings)?;
        file_submenu.append(&report_bug)?;
        file_submenu.append(&website_item)?;
        file_submenu.append(&blog_item)?;
        file_submenu.append(&more_apps_item)?;
        file_submenu.append(&sep)?;
        file_submenu.append(&quit_item)?;

        let menu = Menu::with_items(app, &[
            &file_submenu as &dyn tauri::menu::IsMenuItem<_>,
            &logs_submenu as &dyn tauri::menu::IsMenuItem<_>,
        ])?;
        // Attached only when shown (Settings > Appearance > Layout >
        // Menu bar): with the bar off no GTK menu bar is ever built.
        if persisted_show_menu_bar() {
            app.set_menu(menu.clone())?;
        }
        app.manage(LinuxMenuBar(menu));
    }

    #[cfg(any(not(target_os = "macos"), feature = "sparkle"))]
    return Ok(check_updates);
    #[cfg(all(target_os = "macos", not(feature = "sparkle")))]
    return Ok(());
}

pub(crate) fn setup_menu_events(app: &mut tauri::App) {
    // Handle app menu events
    let app_handle_for_menu = app.handle().clone();
    app.on_menu_event(move |_app, event| {
        if event.id().as_ref() == "check_updates" {
            let handle = app_handle_for_menu.clone();
            tauri::async_runtime::spawn(async move {
                check_for_updates(handle, true).await;
            });
        } else if event.id().as_ref() == "open_settings" {
            let _ = app_handle_for_menu.emit("open-settings", ());
        } else if event.id().as_ref() == "report_bug" {
            let _ = app_handle_for_menu.emit("report-bug", ());
        } else if event.id().as_ref() == "export_logs" {
            use tauri_plugin_dialog::DialogExt;
            let app_clone = app_handle_for_menu.clone();
            let log_dir = get_log_dir(&app_clone);
            app_clone.dialog()
                .file()
                .set_directory(&log_dir)
                .set_file_name("mailvault-logs.txt")
                .save_file(move |file_path| {
                    if let Some(file_path) = file_path {
                        if let Some(path) = file_path.as_path() {
                            if let Ok(logs) = read_latest_log(&log_dir, 500) {
                                let _ = fs::write(path, logs);
                            }
                        }
                    }
                });
        } else if event.id().as_ref() == "open_website" {
            use tauri_plugin_shell::ShellExt;
            let _ = app_handle_for_menu.shell().open("https://mailvaultapp.com", None::<tauri_plugin_shell::open::Program>);
        } else if event.id().as_ref() == "open_blog" {
            use tauri_plugin_shell::ShellExt;
            let _ = app_handle_for_menu.shell().open("https://mailvaultapp.com/blog.html", None::<tauri_plugin_shell::open::Program>);
        } else if event.id().as_ref() == "open_more_apps" {
            use tauri_plugin_shell::ShellExt;
            let _ = app_handle_for_menu.shell().open("https://graphicmeat.com", None::<tauri_plugin_shell::open::Program>);
        } else if event.id().as_ref() == "open_shortcuts" {
            let _ = app_handle_for_menu.emit("open-shortcuts", ());
        } else if event.id().as_ref() == "quit_app" {
            info!("Application quitting via menu");
            // Not `process::exit`: that skips RunEvent::Exit, so the
            // on-demand daemon child outlived every quit.
            app_handle_for_menu.exit(0);
        }
    });
}
