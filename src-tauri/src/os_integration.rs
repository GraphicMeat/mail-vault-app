//! OS integration commands: connectivity, notifications, badge, files and Finder/Explorer.

use super::*;

#[tauri::command]
pub(crate) async fn check_network_connectivity() -> Result<bool, String> {
    // Was a blocking `fn`: three sequential `TcpStream::connect_timeout` calls,
    // up to 4.5s of the UI thread with the window frozen. Now one async probe
    // that dials all three concurrently — 1.5s worst case, on the runtime.
    let online = mailvault_core::net::probe_internet().await;
    if online {
        info!("Network connectivity confirmed");
    } else {
        warn!("No network connectivity detected - all probe hosts unreachable");
    }
    Ok(online)
}

#[tauri::command]
pub(crate) fn send_notification(
    app_handle: tauri::AppHandle,
    title: String,
    body: String,
    sound: Option<String>,
    target: Option<notification_open::NotificationTarget>,
    actions: Option<notification_open::CodeActions>,
) -> Result<(), String> {
    // Title and body carry the subject and sender: Verbose logs only.
    info!("send_notification called");
    tracing::debug!("send_notification: {} - {}", title, body);

    // The banner shows the icon picked in Settings (`app_icon::SelectedAppIcon`).
    // The file lives in the app cache dir: a snapped Linux app has a private
    // /tmp the host notification daemon cannot read.
    let icon = app_handle.state::<app_icon::SelectedAppIcon>().get();
    let cache = app_handle.path().app_cache_dir().ok();

    // The plugin's banner cannot report a click; this one opens `target`.
    #[cfg(target_os = "macos")]
    if notification_open::mac::available() {
        let sound = notification_sound::sound_name(sound.as_deref());
        // The banner's own icon is the bundle's and cannot be changed, so a
        // non-default choice rides along as the attached thumbnail.
        let thumbnail = cache
            .as_deref()
            .filter(|_| icon != "purple")
            .and_then(|dir| app_icon::icon_file(dir, icon, true).ok());
        return notification_open::mac::show(&title, &body, sound, target.as_ref(), actions.as_ref(), thumbnail);
    }
    let _ = (target, actions);

    #[cfg(not(target_os = "macos"))]
    let icon_path = cache.and_then(|dir| match app_icon::icon_file(&dir, icon, false) {
        Ok(path) => Some(path),
        Err(e) => {
            warn!("[notification] icon not written, default icon used: {e}");
            None
        }
    });

    #[cfg(windows)]
    {
        let _ = sound;
        windows_toast(&app_handle, &title, &body, icon_path.as_deref())
    }

    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let notification = app_handle
            .notification()
            .builder()
            .title(&title)
            .body(&body);
        #[cfg(target_os = "macos")]
        let notification = match notification_sound::sound_name(sound.as_deref()) {
            Some(name) => notification.sound(name),
            None => notification,
        };
        #[cfg(not(target_os = "macos"))]
        let _ = sound;
        #[cfg(not(target_os = "macos"))]
        let notification = match icon_path {
            Some(path) => notification.icon(path.to_string_lossy().into_owned()),
            None => notification,
        };
        notification
            .show()
            .map_err(|e| format!("Failed to send notification: {}", e))?;
        Ok(())
    }
}

/// notify-rust drops the icon on Windows, so the toast is built here with the
/// chosen icon as its app logo. Same AppUserModelID rule as the plugin: the
/// identifier only when installed, or a toast from `target/debug|release`
/// vanishes.
#[cfg(windows)]
pub(crate) fn windows_toast(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    icon: Option<&std::path::Path>,
) -> Result<(), String> {
    use tauri_winrt_notification::{IconCrop, Toast};
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().map(|p| p.display().to_string()).unwrap_or_default();
    let sep = std::path::MAIN_SEPARATOR;
    let installed = !(dir.ends_with(&format!("{sep}target{sep}debug"))
        || dir.ends_with(&format!("{sep}target{sep}release")));
    let identifier = app.config().identifier.clone();
    let app_id = if installed { identifier.as_str() } else { Toast::POWERSHELL_APP_ID };
    let mut toast = Toast::new(app_id).title(title).text1(body);
    if let Some(icon) = icon {
        toast = toast.icon(icon, IconCrop::Square, "");
    }
    toast
        .show()
        .map_err(|e| format!("Failed to send notification: {e:?}"))
}

// `graph_ledger_path`/`GRAPH_ID_MAP_FILE` are gone (Phase 3 remainder, Task
// 5): the Graph backup was the app's last caller of the Outlook uid ledger,
// and it now allocates from `mailvault_core::graph_ledger` inside the
// daemon, alongside the (already moved) `graph_allocate_uids`/
// `load_graph_id_map` routes — one process, one lock, one path builder.

#[tauri::command]
pub(crate) fn check_running_from_dmg() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        // Check if the app is running from a DMG (mounted volume)
        if let Ok(exe_path) = std::env::current_exe() {
            let path_str = exe_path.to_string_lossy();
            // DMG volumes are typically mounted under /Volumes/
            // But we need to exclude /Volumes/Macintosh HD which is the main disk
            if path_str.starts_with("/Volumes/") && !path_str.contains("Macintosh HD") {
                info!("Warning: App appears to be running from a DMG at: {}", path_str);
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn set_badge_count(_app_handle: tauri::AppHandle, count: i32) -> Result<(), String> {
    tracing::debug!("set_badge_count called with count: {}", count);

    #[cfg(target_os = "macos")]
    {
        unsafe {
            let app = NSApplication::sharedApplication(nil);
            let dock_tile: cocoa::base::id = msg_send![app, dockTile];

            if count > 0 {
                let badge_string = NSString::alloc(nil).init_str(&count.to_string());
                let _: () = msg_send![dock_tile, setBadgeLabel: badge_string];
            } else {
                let _: () = msg_send![dock_tile, setBadgeLabel: nil];
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Other platforms don't have native dock badges
        info!("Badge not supported on this platform");
    }

    Ok(())
}

/// Reads the user-chosen account transfer file for the import dialog.
/// Thin on purpose (app is a shell): the bytes go to the webview, which hands
/// them to the daemon's `transfer.decrypt`, so the daemon never sees a path.
/// Any webview script can call this, so it reads only a capped `.mvtransfer`
/// file, and logs only the byte count, never the path or content.
#[tauri::command(async)]
pub(crate) fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    // ponytail: a transfer file is accounts + settings, a few MB at most.
    const MAX_BYTES: u64 = 64 * 1024 * 1024;

    let p = std::path::Path::new(&path);
    if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mvtransfer")) {
        return Err("E_TRANSFER_FORMAT: not a .mvtransfer file".to_string());
    }
    let len = fs::metadata(p).map_err(|e| format!("E_TRANSFER_READ: {e}"))?.len();
    if len > MAX_BYTES {
        return Err("E_TRANSFER_FORMAT: file too large".to_string());
    }
    let bytes = fs::read(p).map_err(|e| format!("E_TRANSFER_READ: {e}"))?;
    info!("read_file_base64: {} bytes", bytes.len());
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub(crate) fn save_attachment_to(
    filename: String,
    content_base64: String,
    dest_path: String,
) -> Result<String, String> {
    use base64::Engine;

    info!("save_attachment_to called for: {} -> {}", filename, dest_path);

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&content_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // A "Save As" destination always exists, but an export written into a
    // cache subdirectory of our own naming does not. fs::write does not create
    // parents, so it is created here — once, for every caller — rather than in
    // a second write command that would drift from this one.
    if let Some(parent) = std::path::Path::new(&dest_path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }

    fs::write(&dest_path, &decoded)
        .map_err(|e| format!("Failed to write file: {}", e))?;
    mailvault_core::fsx::mark_from_internet(std::path::Path::new(&dest_path));

    info!("Attachment saved to: {}", dest_path);
    Ok(dest_path)
}

#[tauri::command]
pub(crate) fn show_in_folder(path: String) -> Result<(), String> {
    info!("show_in_folder called for: {}", path);

    #[cfg(target_os = "macos")]
    {
        return finder_open(&path, true, None);
    }

    #[cfg(target_os = "windows")]
    {
        // explorer splits its command line on commas, so the path goes in
        // quotes, verbatim: `.arg` would quote the whole `/select,...` when the
        // path has a space, which explorer ignores. No Windows file name can
        // hold a `"`, so one here is not a real path.
        use std::os::windows::process::CommandExt;
        if path.contains('"') {
            return Err(format!("Not a file path: {}", path));
        }
        Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("/")))
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(())
}

/// Hand a path to Finder, holding the security-scoped bookmark that covers it.
///
/// A path outside the sandbox container is refused unless the app holds the
/// bookmark's scope at that moment — and `.spawn()`ing `/usr/bin/open` threw
/// away the refusal, so the button appeared to do nothing.
#[cfg(target_os = "macos")]
pub(crate) fn finder_open(path: &str, reveal: bool, app: Option<&str>) -> Result<(), String> {
    let data_dir = mailvault_core::paths::app_data_dir()
        .map_err(|e| format!("Could not get app data directory: {}", e))?;
    external_location::open_in_finder(&data_dir, path, reveal, app)
}

#[tauri::command]
pub(crate) fn open_file(path: String) -> Result<(), String> {
    info!("open_file called for: {}", path);

    #[cfg(target_os = "macos")]
    {
        // LaunchServices takes any folder ending in `.app` for a bundle — and
        // the app data dir is named `com.mailvault.app`. Opening it would try
        // to LAUNCH it, fail with "executable is missing", and show nothing.
        // Reveal such a folder in its parent instead; everything else opens.
        // ponytail: only `.app` is special-cased; add `.bundle`/`.framework`
        // if a data folder ever gets one of those names.
        let p = std::path::Path::new(&path);
        let reveal = p.is_dir() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app"));
        return finder_open(&path, reveal, None);
    }

    #[cfg(target_os = "windows")]
    {
        // ShellExecuteExW takes the path whole. Not `cmd /C start` (an `&` in a
        // sender-chosen attachment name runs whatever follows it) and not
        // `explorer <path>` (explorer splits its argument on commas).
        open::that_detached(&path).map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub(crate) fn open_with_dialog(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    info!("open_with_dialog called for: {}", path);

    // The attachment name is chosen by whoever sent the mail. It used to be
    // spliced into an AppleScript, where a quote or a backslash in it ran a
    // shell command. Now the app is picked in a native panel and the file is
    // handed to NSWorkspace as an object: nothing parses the name.
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_dialog::DialogExt;
        app_handle
            .dialog()
            .file()
            .set_directory("/Applications")
            .add_filter("Applications", &["app"])
            .pick_file(move |picked| {
                let Some(app) = picked.and_then(|p| p.into_path().ok()) else { return };
                if let Err(e) = finder_open(&path, false, Some(&app.to_string_lossy())) {
                    error!("Open With failed: {}", e);
                }
            });
    }

    #[cfg(not(target_os = "macos"))]
    let _ = &app_handle;

    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .args(["shell32.dll,OpenAs_RunDLL", &path])
            .spawn()
            .map_err(|e| format!("Failed to open 'Open With' dialog: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}
