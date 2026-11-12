//! Update checks and the update track.

use super::*;

/// Process-wide guard preventing overlapping update checks.
pub(crate) struct UpdateCheckGuard(pub(crate) AtomicBool);
impl Default for UpdateCheckGuard {
    fn default() -> Self { Self(AtomicBool::new(false)) }
}

#[cfg(any(target_os = "linux", windows))]
pub(crate) type PendingUpdate = std::sync::Mutex<Option<tauri_plugin_updater::Update>>;

#[cfg(any(target_os = "linux", windows))]
#[tauri::command]
pub(crate) async fn install_pending_update(handle: tauri::AppHandle) -> Result<(), String> {
    let state = handle.state::<PendingUpdate>();
    // Mutex::lock().unwrap() is safe — poison only occurs on panic in critical section
    let update = state.lock().unwrap().take();
    match update {
        Some(u) => {
            let h = handle.clone();
            let mut total_downloaded: u64 = 0;
            u.download_and_install(
                move |chunk_length, content_length| {
                    total_downloaded += chunk_length as u64;
                    let percent = content_length
                        .map(|total| ((total_downloaded as f64 / total as f64) * 100.0).min(100.0) as u8)
                        .unwrap_or(0);
                    let _ = h.emit("update-download-progress", serde_json::json!({
                        "downloaded": total_downloaded,
                        "total": content_length,
                        "percent": percent
                    }));
                },
                || {},
            ).await.map_err(|e| e.to_string())?;
            info!("Update installed successfully, restarting...");
            handle.restart();
        }
        None => Err("No pending update".to_string()),
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) async fn install_pending_update(_handle: tauri::AppHandle) -> Result<(), String> {
    Err("macOS updates are installed via DMG download".to_string())
}

// ── Update track ────────────────────────────────────────────────────────────
// Two Sparkle feeds: the stable one is SUFeedURL in Info.plist, the nightly one
// rides the rolling `nightly` prerelease and is applied through the delegate's
// feed-URL override.

pub(crate) const NIGHTLY_APPCAST_URL: &str =
    "https://github.com/GraphicMeat/mail-vault-app/releases/download/nightly/appcast.xml";

// tauri-plugin-updater (Windows) reads latest.json: the stable one is the
// endpoint in tauri.conf.json, the nightly one rides the same prerelease.
#[cfg(any(target_os = "linux", windows))]
pub(crate) const NIGHTLY_LATEST_JSON_URL: &str =
    "https://github.com/GraphicMeat/mail-vault-app/releases/download/nightly/latest.json";

/// Sparkle feed override for the chosen update track. `None` = use the
/// stable feed from Info.plist. With no saved choice a nightly build follows
/// the nightly feed and a stable build the stable one.
#[allow(dead_code)] // Only the macOS + Sparkle build applies it; the tests read it everywhere.
pub(crate) fn update_feed_override(track: Option<&str>, app_version: &str) -> Option<String> {
    mailvault_core::update_track::follows_nightly(track, app_version)
        .then(|| NIGHTLY_APPCAST_URL.to_string())
}

/// The frontend's persisted `updateTrack`, read straight off disk — this runs in
/// `setup()`, long before a window could be asked. Any problem reads as "unset".
pub(crate) fn persisted_update_track() -> Option<String> {
    let path = mailvault_core::paths::app_data_dir()
        .ok()?
        .join(mailvault_core::settings_doc::FILE_NAME);
    let raw = fs::read_to_string(path).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&raw).ok()?;
    mailvault_core::settings_doc::app_state(&settings)?
        .get("updateTrack")?
        .as_str()
        .map(String::from)
}

#[cfg(all(target_os = "macos", feature = "sparkle"))]
pub(crate) fn apply_update_track(handle: &tauri::AppHandle, track: Option<&str>) {
    use tauri_plugin_sparkle_updater::SparkleUpdaterExt;

    let sparkle = match handle.sparkle_updater() {
        Some(s) => s,
        None => {
            warn!("Sparkle updater not available (dev mode?) — update track not applied");
            return;
        }
    };

    let feed = update_feed_override(track, env!("CARGO_PKG_VERSION"));
    let in_effect = feed.clone().unwrap_or_else(|| "stable feed".to_string());
    match sparkle.set_feed_url_override(feed) {
        Ok(()) => info!(
            "Update track '{}' — {}",
            track.unwrap_or("(unset)"),
            in_effect
        ),
        Err(e) => error!("Failed to set the Sparkle feed override: {}", e),
    }
}

// MAS builds update through the App Store: no feed to override.
#[cfg(all(target_os = "macos", not(feature = "sparkle")))]
pub(crate) fn apply_update_track(_handle: &tauri::AppHandle, _track: Option<&str>) {}

/// The track tauri-plugin-updater checks against, held in memory so a change
/// in Settings applies to the very next check without waiting for the
/// frontend's settings file to be written.
#[cfg(any(target_os = "linux", windows))]
pub(crate) static UPDATE_TRACK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(any(target_os = "linux", windows))]
pub(crate) fn apply_update_track(_handle: &tauri::AppHandle, track: Option<&str>) {
    *UPDATE_TRACK.lock().unwrap_or_else(|e| e.into_inner()) = track.map(String::from);
}

#[tauri::command]
pub(crate) fn set_update_track(handle: tauri::AppHandle, track: String) -> Result<(), String> {
    apply_update_track(&handle, Some(&track));
    Ok(())
}

/// Settings' "Check for updates" on Windows, which has no app menu to hold
/// one. macOS asks Sparkle from the frontend instead.
#[tauri::command]
pub(crate) async fn check_for_updates_now(handle: tauri::AppHandle) {
    check_for_updates(handle, true).await;
}

/// A portable copy is updated by the user replacing the app on the drive with
/// a newer one (`MailVault Data` beside it stays), never in place: an updater
/// would install onto the host or rewrite a bundle on a drive that may leave
/// mid-install.
#[cfg(any(not(target_os = "macos"), feature = "sparkle"))]
pub(crate) fn portable_skips_updates(handle: &tauri::AppHandle, show_no_update: bool) -> bool {
    if mailvault_core::paths::portable_root().is_none() {
        return false;
    }
    info!("Portable copy: update check skipped");
    if show_no_update {
        use tauri_plugin_dialog::DialogExt;
        handle.dialog()
            .message(native_text(&handle, "dlg_portable", "This is a portable copy of MailVault, so it does not update itself. To update it, quit MailVault and replace the app on the drive with a newer version. The MailVault Data folder beside it keeps your mail and settings."))
            .title(native_text(&handle, "dlg_updates_title", "Updates"))
            .show(|_| {});
    }
    true
}

/// Shared update check logic for both manual menu trigger and startup auto-check.
/// `show_no_update` controls whether to show a dialog when already up-to-date.
#[cfg(any(target_os = "linux", windows))]
pub(crate) async fn check_for_updates(handle: tauri::AppHandle, show_no_update: bool) {
    use tauri_plugin_updater::UpdaterExt;
    use tauri_plugin_dialog::DialogExt;

    if portable_skips_updates(&handle, show_no_update) {
        return;
    }

    // Single-flight guard: reject overlapping checks
    let guard = handle.state::<UpdateCheckGuard>();
    if guard.0.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        if show_no_update {
            info!("Manual update check ignored — another check is already in progress");
        }
        return;
    }
    // Ensure the flag is cleared on every exit path
    struct ClearGuard<'a>(&'a AtomicBool);
    impl Drop for ClearGuard<'_> {
        fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
    }
    let _clear = ClearGuard(&guard.0);

    // Snap packages update via the Snap Store — skip Tauri updater
    if std::env::var("SNAP").is_ok() {
        info!("Running as snap — updates managed by Snap Store");
        if show_no_update {
            handle.dialog()
                .message(native_text(&handle, "dlg_snap", "This app was installed from the Snap Store.\nUpdates are delivered automatically through the Snap Store."))
                .title(native_text(&handle, "dlg_updates_title", "Updates"))
                .show(|_| {});
        }
        return;
    }

    info!("Checking for updates (manual={})", show_no_update);

    // Check for updates via latest.json
    // Note: Auto-update only works for AppImage installs. For .deb installs,
    // we can detect new versions but users must download manually.
    // On Windows the updater launches the NSIS installer and exits through
    // `process::exit`, skipping RunEvent::Exit. A daemon still running then
    // holds mailvault-daemon.exe open and the installer cannot replace it, so
    // stop it here, always-on or not (the NSIS pre-install hook force-kills
    // whatever this misses). `cleanup_before_exit` is the plugin's own default
    // hook, which setting ours replaces.
    let exit_handle = handle.clone();
    let mut builder = handle
        .updater_builder()
        // Nightly-aware order, the same one Sparkle applies on macOS.
        .version_comparator(|installed, release| {
            mailvault_core::update_track::is_newer(
                &installed.to_string(),
                &release.version.to_string(),
            )
        })
        .on_before_exit(move || {
            APP_EXITING.store(true, Ordering::SeqCst);
            daemon_channel::stop();
            stop_daemon();
            shutdown_daemon_child();
            exit_handle.cleanup_before_exit();
        });
    // Linux has no nightlies; only Windows switches feeds.
    if cfg!(windows)
        && mailvault_core::update_track::follows_nightly(
            UPDATE_TRACK.lock().unwrap_or_else(|e| e.into_inner()).as_deref(),
            env!("CARGO_PKG_VERSION"),
        )
    {
        info!("Update track: nightly");
        builder = match builder.endpoints(vec![NIGHTLY_LATEST_JSON_URL.parse().expect("static URL")]) {
            Ok(b) => b,
            Err(e) => {
                error!("Failed to set the nightly update endpoint: {}", e);
                return;
            }
        };
    }
    let updater = match builder.build() {
        Ok(u) => u,
        Err(e) => {
            error!("Failed to create updater: {}", e);
            if show_no_update {
                handle.dialog()
                    .message(native_text(&handle, "dlg_unsupported_install", "Auto-update is not available for this installation type.\nVisit https://mailvaultapp.com to check for new versions."))
                    .title(native_text(&handle, "dlg_updates_title", "Updates"))
                    .show(|_| {});
            }
            return;
        }
    };

    // Network Activity: the check is this shell's own HTTP. Both feeds
    // (tauri.conf.json's endpoint and NIGHTLY_LATEST_JSON_URL) are on
    // github.com; the download that may follow is not reported.
    let mut event = mailvault_core::net_activity::NetEvent::out(
        mailvault_core::net_activity::Protocol::Https,
        "github.com",
        443,
        "update check",
    );
    let started = std::time::Instant::now();
    let checked = updater.check().await;
    event.duration_ms = started.elapsed().as_millis() as u64;
    event.result = match &checked {
        Ok(_) => "ok".into(),
        Err(e) => e.to_string(),
    };
    daemon_channel::report_net(&event);

    match checked {
        Ok(Some(update)) => {
            info!("Update available: {} -> {}", env!("CARGO_PKG_VERSION"), update.version);
            let version = update.version.clone();
            let body = update.body.clone().unwrap_or_default();

            // Emit to frontend — React handles the UI
            let _ = handle.emit("update-available", serde_json::json!({
                "version": version,
                "notes": body,
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "isManualCheck": show_no_update
            }));

            // Store the update object for later install
            let state = handle.state::<PendingUpdate>();
            // Mutex::lock().unwrap() is safe — poison only occurs on panic in critical section
            *state.lock().unwrap() = Some(update);
        }
        Ok(None) => {
            info!("No updates available");
            if show_no_update {
                handle.dialog()
                    .message(native_text(&handle, "dlg_latest", "You're running the latest version (v{{version}}).").replace("{{version}}", env!("CARGO_PKG_VERSION")))
                    .title(native_text(&handle, "dlg_no_updates_title", "No Updates Available"))
                    .show(|_| {});
            }
        }
        Err(e) => {
            error!("Update check failed: {}", e);
            if show_no_update {
                handle.dialog()
                    .message(native_text(&handle, "dlg_check_failed_site", "Could not check for updates.\nVisit https://mailvaultapp.com to check for new versions."))
                    .title(native_text(&handle, "dlg_update_error_title", "Update Error"))
                    .show(|_| {});
            }
        }
    }
}

// MAS builds have no Sparkle — the App Store handles updates. No-op so the
// menu item and startup auto-check still link.
#[cfg(all(target_os = "macos", not(feature = "sparkle")))]
pub(crate) async fn check_for_updates(_handle: tauri::AppHandle, _show_no_update: bool) {
    info!("Update check skipped — updates are managed by the Mac App Store");
}

#[cfg(all(target_os = "macos", feature = "sparkle"))]
pub(crate) async fn check_for_updates(handle: tauri::AppHandle, show_no_update: bool) {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_sparkle_updater::SparkleUpdaterExt;

    if portable_skips_updates(&handle, show_no_update) {
        return;
    }

    // Single-flight guard: reject overlapping checks
    let guard = handle.state::<UpdateCheckGuard>();
    if guard.0.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        if show_no_update {
            info!("Manual update check ignored — another check is already in progress");
        }
        return;
    }
    struct ClearGuard<'a>(&'a AtomicBool);
    impl Drop for ClearGuard<'_> {
        fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
    }
    let _clear = ClearGuard(&guard.0);

    info!("Checking for updates via Sparkle (manual={})", show_no_update);

    let sparkle = match handle.sparkle_updater() {
        Some(s) => s,
        None => {
            warn!("Sparkle updater not available (dev mode?)");
            if show_no_update {
                handle.dialog()
                    .message(native_text(&handle, "dlg_dev_mode", "Auto-update is not available in development mode."))
                    .title(native_text(&handle, "dlg_updates_title", "Updates"))
                    .show(|_| {});
            }
            return;
        }
    };

    // Trigger a probe-only check — fires Sparkle events without showing native UI.
    // The frontend JS side listens for sparkle://did-find-valid-update directly.
    // Here we also poll last_found_update() to bridge into the existing update-available event.
    if let Err(e) = sparkle.check_for_update_information() {
        error!("Failed to initiate Sparkle update check: {}", e);
        if show_no_update {
            handle.dialog()
                .message(native_text(&handle, "dlg_check_failed_retry", "Could not check for updates. Please try again later."))
                .title(native_text(&handle, "dlg_update_error_title", "Update Error"))
                .show(|_| {});
        }
        return;
    }

    // Give Sparkle time to fetch and parse the appcast
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    // Check if Sparkle found an update
    match sparkle.last_found_update() {
        Ok(Some(update_info)) => {
            let version = update_info.version.clone();
            let notes = update_info.release_notes.clone().unwrap_or_default();

            info!("Update available: {} -> {}", env!("CARGO_PKG_VERSION"), version);
            let _ = handle.emit("update-available", serde_json::json!({
                "version": version,
                "notes": notes,
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "isManualCheck": show_no_update
            }));
        }
        _ => {
            info!("No updates available");
            if show_no_update {
                handle.dialog()
                    .message(native_text(&handle, "dlg_latest", "You're running the latest version (v{{version}}).").replace("{{version}}", env!("CARGO_PKG_VERSION")))
                    .title(native_text(&handle, "dlg_no_updates_title", "No Updates Available"))
                    .show(|_| {});
            }
        }
    }
}

pub(crate) fn setup_updates(app: &mut tauri::App) {
    // Point Sparkle at the right feed before anything can check it —
    // both the delayed check below and Sparkle's own schedule.
    apply_update_track(&app.handle(), persisted_update_track().as_deref());

    // Check for updates in background
    let update_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        // Delay update check to let the app initialize first
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        check_for_updates(update_handle.clone(), false).await;

        // Sparkle schedules its own checks. tauri-plugin-updater only
        // checks when asked, and a Windows app can run for weeks, so
        // check again once a day. Wall clock, polled hourly: a monotonic
        // 24h sleep would not count the hours the machine slept.
        #[cfg(any(target_os = "linux", windows))]
        {
            const DAY: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
            let mut last_check = std::time::SystemTime::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
                if last_check.elapsed().map_or(true, |e| e >= DAY) {
                    last_check = std::time::SystemTime::now();
                    check_for_updates(update_handle.clone(), false).await;
                }
            }
        }
    });
}
