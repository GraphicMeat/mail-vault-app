//! Process startup steps `main()` runs in order: before the builder exists, and the
//! service starts inside `setup`.

use super::*;

pub(crate) fn set_portable_webview_data_dir() {
    // WebView2 keeps localStorage/IndexedDB under the host's LOCALAPPDATA; a
    // portable copy keeps them on the drive. Set before any webview exists.
    // UNVERIFIED on a Windows box: that the variable wins over the
    // `data_directory` Tauri forces there.
    #[cfg(windows)]
    if let Some(root) = mailvault_core::paths::portable_root() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", root.join("webview"));
    }
}

pub(crate) fn hand_over_to_daemon_if_launcher() {
    // Autostart on Linux and Windows points at *this* binary rather than at
    // the sidecar, because the sidecar's path depends on the packaging (an
    // AppImage's mount root is gone by the next login). Started that way the
    // app is only a launcher: hand over to the daemon and leave, before a
    // window, a single-instance lock or a tray icon exists.
    if std::env::args().any(|a| a == mailvault_core::autostart::DAEMON_ONLY_FLAG) {
        std::process::exit(match spawn_detached_daemon() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        });
    }
}

pub(crate) fn install_panic_hook() {
    // Log panics before abort — set_hook fires even with panic = "abort"
    std::panic::set_hook(Box::new(|info| {
        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string panic".to_string()
        };
        eprintln!("PANIC at {}: {}", location, payload);
    }));
}

pub(crate) fn register_spellcheck_default() {
    // WebKit keeps its continuous-spell-checking state in NSUserDefaults and reads
    // it once, early. The key is absent in a fresh app domain, so the checker never
    // runs and the compose editor paints no squiggles no matter what its
    // `spellcheck` attribute says. Safari writes the same key; register ours before
    // any webview exists. Registration domain, not the app domain: a user who turns
    // spelling off in the webview's own context menu writes the app domain, and that
    // choice has to keep winning.
    #[cfg(target_os = "macos")]
    unsafe {
        let key = NSString::alloc(nil).init_str("WebContinuousSpellCheckingEnabled");
        let on: cocoa::base::id = msg_send![class!(NSNumber), numberWithBool: cocoa::base::YES];
        let defaults: cocoa::base::id = msg_send![class!(NSDictionary), dictionaryWithObject: on forKey: key];
        let user_defaults: cocoa::base::id = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let _: () = msg_send![user_defaults, registerDefaults: defaults];
    }
}

    // Linux fallback: flock-based lock to prevent multiple instances.
    // The tauri-plugin-single-instance uses D-Bus which may not work in all Linux environments
    // (AppImage, Snap, restricted D-Bus sessions). flock is kernel-managed: automatically
    // released on process exit (even SIGKILL/crash), works in Snap strict confinement,
    // and has no stale lock issues.
    // When a second instance detects the lock, it sends SIGUSR1 to the running instance
    // which triggers window show+focus (handles clicking the app icon while already running).
#[cfg(target_os = "linux")]
pub(crate) fn acquire_single_instance_lock(automation: bool) -> Option<fs::File> {
    if automation { None } else {
        use std::io::{Read as _, Write as _};
        use std::os::unix::io::AsRawFd;

        let lock_dir = mailvault_core::paths::app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("/tmp").join(mailvault_core::paths::APP_IDENTIFIER));
        let _ = fs::create_dir_all(&lock_dir);
        let lock_path = lock_dir.join("mailvault.lock");

        match fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path) {
            Ok(mut file) => {
                let fd = file.as_raw_fd();
                // LOCK_EX = exclusive lock, LOCK_NB = non-blocking (fail immediately if locked)
                let ret = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
                if ret != 0 {
                    // Already running — read the PID and signal it to show the window
                    let mut pid_str = String::new();
                    let _ = file.read_to_string(&mut pid_str);
                    if let Ok(pid) = pid_str.trim().parse::<i32>() {
                        unsafe { libc::kill(pid, libc::SIGUSR2); }
                    }
                    std::process::exit(0);
                }
                // Write our PID so second instances can signal us
                let _ = file.set_len(0);
                let _ = file.write_all(std::process::id().to_string().as_bytes());
                let _ = file.sync_all();
                // Keep the file handle alive for the entire process lifetime.
                // When the process exits (normally or crashes), the kernel releases the lock.
                Some(file)
            }
            Err(e) => {
                eprintln!("Warning: could not create lock file: {}", e);
                None
            }
        }
    }
}

pub(crate) fn start_transfer_stats_flush() {
    // Per-account transfer counters → `<app_data_dir>/transfer_stats/*.app.json`.
    // The daemon writes its own file; neither process locks the other's.
    if let Ok(stats_dir) = mailvault_core::paths::app_data_dir() {
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                mailvault_core::transfer_stats::global().flush(&stats_dir, "app");
            }
        });
    }
}

pub(crate) fn start_services(app: &mut tauri::App) {
    // Install the StoreKit transaction observer (no-op on non-MAS builds)
    iap::install_observer(&app.state::<iap::IapState>());

    info!("MailVault application starting");
    info!("App version: {}", env!("CARGO_PKG_VERSION"));

    // Resolve the mail storage location once, before anything reads
    // mail. On macOS this starts security-scoped access and holds it for
    // the process lifetime. A missing drive is not fatal — the frontend
    // shows the banner and asks for the folder.
    let vault_status = vault::resolve(&app.handle());
    info!(
        "Mail storage: {} ({})",
        if vault_status.display_path.is_empty() { "app data dir" } else { &vault_status.display_path },
        vault_status.status
    );
    // The custody store opens in the DAEMON now (Task 2.9b), before
    // its socket exists: `custody.db` is EXCLUSIVE, so exactly one
    // process may hold it, and the legacy JSON import runs there.
    daemon_channel::start(app.handle());

    // The app's own `.eml` startup sweep is deleted (Task 2.8): the
    // daemon already runs `migrate_add_eml_extension` at startup
    // (`src-daemon/src/main.rs`), so running it here too would be one
    // process racing the other over the same renames. As of the
    // Phase 3 remainder (Task 5) the app is out of `cur/`
    // altogether: `graph_cache_mime` (Task 5.6), `restore.rs` (4.7),
    // the mbox and ZIP importers (4.6, 4.4) and finally the backup
    // runners and `archive.rs`'s shim all write from the daemon now
    // (Task 2.8 review M3, closed).
}
