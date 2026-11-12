// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[allow(unused_imports)]
use tauri::{Emitter, Manager};
#[allow(unused_imports)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(not(windows))]
#[allow(unused_imports)]
use tauri::menu::Submenu;
#[allow(unused_imports)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

// The `vault_eml` / `vault_files` / `header_cache` re-exports
// (`find_file_by_uid`, `parse_flags_from_filename`,
// `build_maildir_filename`, `cache_base_name`, ...) went with the backup
// runners in the Phase 3 remainder's Task 5: `backup.rs` was their last
// caller, and `mailvault_core::backup` now uses them in-crate.

#[allow(unused_imports)]
use std::fs;
#[allow(unused_imports)]
use std::path::{Path, PathBuf};
#[allow(unused_imports)]
use std::process::Command;
#[allow(unused_imports)]
use std::sync::atomic::{AtomicBool, Ordering};
#[allow(unused_imports)]
use keyring::Entry;
#[allow(unused_imports)]
use serde::{Deserialize, Serialize};
#[allow(unused_imports)]
use tracing::{info, warn, error, Level};
#[allow(unused_imports)]
use mailvault_core::log_redact;
#[allow(unused_imports)]
use tracing_subscriber::fmt::writer::MakeWriterExt;
#[allow(unused_imports)]
use tracing_subscriber::fmt::MakeWriter;
#[allow(unused_imports)]
use tracing_subscriber::prelude::*;
#[allow(unused_imports)]
use tracing_appender::rolling::{RollingFileAppender, Rotation};

mod abd;
mod bulk;
mod app_icon;
mod autostart;
mod backup;
mod cleanup;
#[cfg(feature = "blitz-render")]
mod blitz_tiles;
mod commands;
mod daemon_channel;
mod dropped_files;
// dns.rs is gone (Task 5.8) and smtp.rs is gone (Task 5.9): both had every
// #[tauri::command] on top of them moved to the daemon in an earlier task
// (5.8, 5.5) and were left as unreferenced re-export shims for that task to
// stay in scope; 5.9's cleanup pass confirmed each had zero remaining
// src-tauri callers and deleted both files outright, same treatment.
// archive.rs is gone the same way (Phase 3 remainder, Task 5): it was only
// the `run_with_backup` shim that built the core runner's context — root,
// the app's process-global `ImapPool`, a no-op write gate — for the app-side
// backup runner, and that runner now lives in the daemon, which builds the
// same context from its own state (`handlers::archive::archive_ctx`) under a
// real gate. Deleting it takes the app's last ungated vault writer with it.
mod external_location;
mod export_folder;
mod native_lease;
mod github;
// graph/imap/oauth2 all live in mailvault_core (shared with src-daemon) and
// src-tauri no longer references any of them: OAuth2Manager is constructed
// once in the daemon's DaemonState (Task 5.7), and the Phase 3 remainder's
// Task 5 moved the backup runners — this crate's last `GraphClient` and
// `ImapPool` callers — there too, so no re-export is left for any of the three.
mod iap;
mod activation_link;
mod mailto;
mod notification_open;
mod notification_sound;
mod spellcheck;
mod vault;
mod vault_flags;

// Code split out of this file by concern. The glob re-exports keep every moved item
// reachable as `crate::name`, which the sibling modules and the tests rely on.
mod tray;
#[allow(unused_imports)]
pub(crate) use tray::*;
mod menu;
#[allow(unused_imports)]
pub(crate) use menu::*;
mod logging;
#[allow(unused_imports)]
pub(crate) use logging::*;
mod deep_links;
#[allow(unused_imports)]
pub(crate) use deep_links::*;
mod client_info;
#[allow(unused_imports)]
pub(crate) use client_info::*;
mod settings;
#[allow(unused_imports)]
pub(crate) use settings::*;
mod credentials;
#[allow(unused_imports)]
pub(crate) use credentials::*;
mod os_integration;
#[allow(unused_imports)]
pub(crate) use os_integration::*;
mod app_windows;
#[allow(unused_imports)]
pub(crate) use app_windows::*;
mod vault_commands;
#[allow(unused_imports)]
pub(crate) use vault_commands::*;
mod updater;
#[allow(unused_imports)]
pub(crate) use updater::*;
mod daemon_lifecycle;
#[allow(unused_imports)]
pub(crate) use daemon_lifecycle::*;
mod reply_budgets;
mod rpc_proxy;
#[allow(unused_imports)]
pub(crate) use rpc_proxy::*;
mod startup;
#[allow(unused_imports)]
pub(crate) use startup::*;

#[cfg(test)]
mod tests;

#[cfg(target_os = "macos")]
#[allow(unused_imports)]
use cocoa::appkit::NSApplication;
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
use cocoa::base::nil;
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
use cocoa::foundation::NSString;
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
use objc::{class, msg_send, sel, sel_impl};

#[allow(unused_imports)]
use std::sync::{LazyLock, Mutex, MutexGuard};

fn main() {
    startup::set_portable_webview_data_dir();

    startup::hand_over_to_daemon_if_launcher();

    startup::install_panic_hook();

    startup::register_spellcheck_default();

    // Under WebDriver automation (tauri-wd sets this), single-instance protection is an
    // anti-feature: each spec launches a fresh app instance, and a leftover instance from a
    // failed session would make every subsequent launch exit(0) immediately — the harness
    // then reports "App did not report plugin port in time" for the rest of the suite.
    let automation = std::env::var_os("TAURI_WEBVIEW_AUTOMATION").is_some();
    let portable = mailvault_core::paths::portable_root().is_some();

    #[cfg(target_os = "linux")]
    let _lock_file = startup::acquire_single_instance_lock(automation);

    let builder = tauri::Builder::default();
    // Same automation carve-out as the flock above: the D-Bus single-instance plugin
    // would make a second test-launched instance forward-and-exit instead of starting.
    // A portable copy skips it too: the plugin keys on the bundle identifier,
    // so an installed MailVault running on this host would take the portable
    // launch and close it. Linux keeps its flock, which lives in the (per-drive)
    // data dir. ponytail: two launches of one portable copy on macOS/Windows
    // both open; the daemon's own singleton lock keeps the data safe.
    let builder = if automation || portable {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // When a second instance is launched, focus the main window
            if let Some(window) = app.get_webview_window("main") {
                show_main_window(&window);
            }
        }))
    };
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Dragging an attachment OUT to Finder: WKWebView's own HTML5 drag
        // hands the Desktop a .webloc, not the file, so the page cancels it
        // and this starts a real AppKit/Win32/GTK drag session instead.
        .plugin(tauri_plugin_drag::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    // Updater plugins — Sparkle on macOS (non-MAS), tauri-plugin-updater on
    // Linux and Windows. MAS builds (`appstore`, no `sparkle` feature) get
    // updates via the App Store.
    // Not at all in a portable copy: Sparkle schedules checks of its own, and
    // switching them off would persist into the host's defaults, which an
    // installed copy shares.
    #[cfg(all(target_os = "macos", feature = "sparkle"))]
    let builder = if portable { builder } else { builder.plugin(tauri_plugin_sparkle_updater::init()) };
    #[cfg(any(target_os = "linux", windows))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // No `ImapPool` in this process at all any more: Task 5.4b moved the
    // interactive commands to the daemon's own pool, and the Phase 3
    // remainder's Task 5 moved the backup runners there too — with them went
    // `backup.rs`'s process-global `pool()` and `archive.rs`'s shim, the last
    // app-side IMAP callers.
    let builder = builder
        .manage(NativeText::default())
        .manage(native_lease::Leases::default())
        .manage(backup::NativeBackupAccess::default())
        .manage(bulk::HeldBulkPaths::default())
        .manage(dropped_files::DroppedPaths::default())
        .manage(iap::IapState::new())
        .manage(UpdateCheckGuard::default())
        .manage(vault::VaultState::default())
        .manage(mailto::PendingMailto::default())
        .manage(activation_link::PendingActivation::default())
        .manage(notification_open::PendingNotificationOpen::default())
        .manage(notification_open::PendingNotificationDeletes::default())
        .manage(app_icon::SelectedAppIcon::default());

    #[cfg(any(target_os = "linux", windows))]
    let builder = builder.manage(PendingUpdate::default());

    #[cfg(feature = "blitz-render")]
    let builder = blitz_tiles::register(builder);

    let app = builder
        .invoke_handler(tauri::generate_handler![
            app_icon::set_app_icon,
            menu::apply_menu_labels,
            menu::set_menu_bar_visible,
            menu::quit_app,
            dropped_files::read_dropped_files,
            deep_links::take_pending_mailto,
            deep_links::take_pending_activation,
            notification_open::take_notification_open,
            notification_open::take_notification_deletes,
            deep_links::e2e_queue_mailto,
            deep_links::e2e_queue_activation,
            deep_links::mailto_default_status,
            deep_links::mailto_make_default,
            spellcheck::spellcheck_status,
            logging::log_from_frontend,
            updater::install_pending_update,
            updater::set_update_track,
            updater::check_for_updates_now,
            client_info::get_client_info,
            settings::get_app_data_dir,
            settings::read_settings_json,
            settings::write_settings_json,
            settings::accounts_fallback,
            autostart::autostart_state,
            autostart::set_autostart,
            credentials::get_credentials,
            logging::read_logs,
            logging::read_anonymous_logs,
            logging::clear_logs,
            os_integration::check_network_connectivity,
            os_integration::send_notification,
            notification_sound::preview_notification_sound,
            os_integration::set_badge_count,
            tray::set_tray_accounts,
            os_integration::check_running_from_dmg,
            os_integration::save_attachment_to,
            os_integration::read_file_base64,
            os_integration::show_in_folder,
            os_integration::open_file,
            os_integration::open_with_dialog,
            app_windows::open_email_window,
            app_windows::open_compose_window,
            app_windows::open_auxiliary_window,
            vault_flags::vault_apply_flags,
            vault_flags::vault_rename_mailbox,
            vault_flags::vault_adopt_mailbox_dirs,
            // smtp_test_connection, smtp_build_mime, smtp_build_draft_mime and
            // smtp_send_email moved to the daemon (Task 5.5,
            // src-daemon/src/handlers/smtp.rs) — routed via transport.js's
            // DAEMON_OWNED, no Tauri command left to register.
            // oauth2_auth_url, oauth2_exchange and oauth2_refresh moved to
            // the daemon (Task 5.7, src-daemon/src/handlers/oauth2.rs) —
            // routed via transport.js's DAEMON_OWNED, no Tauri command left
            // to register.
            // graph_list_folders, graph_list_messages, graph_get_message,
            // graph_cache_mime, graph_set_read, graph_set_flagged,
            // graph_delete_message, graph_move_emails, graph_create_folder,
            // graph_rename_folder, graph_move_folder and graph_delete_folder
            // moved to the daemon (Task 5.6, src-daemon/src/handlers/
            // graph.rs) — routed via transport.js's DAEMON_OWNED, no Tauri
            // command left to register. graph_get_mime is not among them: it
            // had 0 callers (confirmed by grep) and was deleted outright,
            // not ported.
            // resolve_email_settings and dns_mail_health moved to the daemon
            // (Task 5.8, src-daemon/src/handlers/dns.rs) — routed via
            // transport.js's DAEMON_OWNED, no Tauri command left to register.
            export_folder::attachment_export_start,
            commands::backup_run_account,
            commands::backup_status,
            commands::backup_save_external_location,
            commands::backup_get_external_location,
            commands::backup_validate_external_location,
            commands::backup_clear_external_location,
            commands::iap_is_entitled,
            commands::iap_purchase,
            commands::iap_restore,
            commands::backup_migrate_legacy_path,
            backup::backup_purge_uids,
            backup::backup_copy_uids,
            backup::accounts_switch_transport,
            backup::backup_scan_uids,
            abd::abd_summarize,
            abd::abd_start,
            abd::abd_attach,
            cleanup::cleanup_run_now,
            commands::get_transfer_stats,
            github::github_device_start,
            github::github_device_poll,
            github::github_check_star,
            rpc_proxy::daemon_rpc,
            vault_commands::vault_get_status, vault_commands::vault_inspect_folder, vault_commands::vault_adopt, vault_commands::vault_move_to, vault_commands::vault_move_to_default, vault_commands::vault_reset,
            rpc_proxy::daemon_channel_notify
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            notification_open::mac::install(app.handle());
            deep_links::setup_deep_links(app);
            app_windows::setup_main_window(app);
            logging::setup_logging_and_data_dir(app);
            startup::start_transfer_stats_flush();
            startup::start_services(app);
            let check_updates = menu::setup_menu_bar(app)?;
            menu::setup_menu_events(app);
            tray::setup_tray(app, check_updates)?;
            updater::setup_updates(app);

            info!("Application setup complete");
            Ok(())
        })
        .on_window_event(app_windows::handle_window_event)
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Linux: listen for SIGUSR1 from second instances to show+focus the window
    #[cfg(target_os = "linux")]
    let sigusr1_flag = {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _ = signal_hook::flag::register(signal_hook::consts::SIGUSR2, std::sync::Arc::clone(&flag));
        flag
    };

    app.run(move |app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        show_main_window(&window);
                    }
                }
                tauri::RunEvent::Exit => {
                    info!("Application exiting — flushing transfer stats, cleaning up daemon child if on-demand");
                    // Before anything else: stops a reconnect blocked inside
                    // ensure_daemon_running from spawning an orphan daemon
                    // once shutdown_daemon_child() below has released DAEMON_CHILD.
                    APP_EXITING.store(true, Ordering::SeqCst);
                    // Runs on the main thread and blocks the quit, so keep the
                    // budget tight: an unreachable server must cost the user a
                    // beachball, not a hang. Worst case here plus
                    // DAEMON_STOP_GRACE below.
                    if let Ok(dir) = mailvault_core::paths::app_data_dir() {
                        mailvault_core::transfer_stats::global().flush(&dir, "app");
                    }
                    // No IMAP sessions to log out of here any more: the app
                    // process holds no `ImapPool` at all since the backup
                    // runners moved to the daemon (Phase 3 remainder, Task
                    // 5), which owns the only pool and shuts it down itself.
                    daemon_channel::stop();
                    // "Keep the daemon running in the background": leave the
                    // child alive and let init adopt it. Its stdio is already
                    // null and it holds no handle on us, so nothing here is
                    // keeping it alive — only this SIGTERM would end it.
                    // `stop_daemon()` (vault moves, restarts) still stops it;
                    // this is the app-quit path alone.
                    if daemon_always_on() {
                        info!("daemon left running in the background at app exit (always-on is on)");
                    } else {
                        shutdown_daemon_child();
                    }
                }
                #[cfg(target_os = "linux")]
                tauri::RunEvent::MainEventsCleared => {
                    if sigusr1_flag.load(std::sync::atomic::Ordering::Relaxed) {
                        sigusr1_flag.store(false, std::sync::atomic::Ordering::Relaxed);
                        info!("SIGUSR2 received — bringing window to front");
                        if let Some(window) = app_handle.get_webview_window("main") {
                            show_main_window(&window);
                        }
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod verify_copies_tests {
    use std::collections::HashMap;

    // The verify_copies cases live with it in mailvault_core::maildir.
    #[test]
    fn expected_ids_cross_the_ipc_boundary_as_string_keys() {
        // The engine builds `{ [uid]: messageId }`, and JSON object keys are
        // strings. The command declares HashMap<u32, String>; if serde stopped
        // parsing "12" into 12u32 the whole Message-ID check would be skipped
        // silently and every present file would verify again.
        let value = serde_json::json!({ "12": "<a@host.test>", "7": "b@host.test" });
        let map: Option<HashMap<u32, String>> = serde_json::from_value(value).unwrap();
        let map = map.unwrap();
        assert_eq!(map.get(&12).map(String::as_str), Some("<a@host.test>"));
        assert_eq!(map.get(&7).map(String::as_str), Some("b@host.test"));
    }
}

#[cfg(test)]
#[test]
fn reply_timeout_bounds_account_workflows() {
    for method in ["accounts.add", "accounts.update"] {
        assert_eq!(
            crate::reply_timeout(method),
            Some(std::time::Duration::from_secs(305))
        );
    }
    assert_eq!(
        crate::reply_timeout("accounts.save"),
        Some(std::time::Duration::from_secs(95))
    );
}

#[cfg(test)]
mod accounts_fallback_tests {
    #[test]
    fn retired_public_account_remove_has_no_reply_budget() {
        assert_eq!(crate::reply_timeout("accounts.remove"), None);
    }
    #[test]
    fn account_save_has_its_own_whole_attempt_budget() {
        assert_eq!(
            crate::reply_timeout("accounts.save"),
            Some(std::time::Duration::from_secs(95))
        );
    }
    #[tokio::test]
    async fn production_account_fallback_refuses_mutations_before_any_file_access() {
        assert_eq!(
            crate::accounts_fallback_at(
                None,
                "accounts.put".into(),
                serde_json::json!({"entries":[]})
            )
            .await,
            Err("errors.daemonOutdated".into())
        );
    }
    use super::*;
    use serde_json::json;
    #[test]
    fn reply_timeout_bounds_the_account_rpcs() {
        for (method, seconds) in [
            ("accounts.list", 30),
            ("accounts.get", 30),
            ("accounts.put", 50),
            ("accounts.remove_local", 185),
            ("accounts.reorder", 50),
            ("accounts.replace_all", 50),
        ] {
            assert_eq!(
                reply_timeout(method),
                Some(std::time::Duration::from_secs(seconds))
            );
        }
    }
    #[tokio::test]
    async fn actual_delegate_retains_live_secrets_and_cleans_new_backups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        fs::write(
            &path,
            json!([{"id":"a", "password":"legacy-only"}]).to_string(),
        )
        .unwrap();
        let credentials = dir.path().join("credentials.json");
        fs::write(&credentials, "synthetic-unreadable").unwrap();
        let call = |method: &str, params| {
            accounts_fallback_at(Some(dir.path().to_path_buf()), method.to_owned(), params)
        };
        let list = call("accounts.list", json!({})).await.unwrap();
        let base = list["version"].as_u64().unwrap();
        assert_eq!(
            call("accounts.get", json!({"id":"a"})).await.unwrap()["account"]["password"],
            "legacy-only"
        );
        call(
            "accounts.put",
            json!({"entry":{"id":"b", "password":"incoming"}}),
        )
        .await
        .unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("legacy-only"));
        assert!(!fs::read_to_string(dir.path().join("accounts.json.bak1"))
            .unwrap()
            .contains("legacy-only"));
        assert!(!fs::read_to_string(&path).unwrap().contains("incoming"));
        assert_eq!(
            call("accounts.remove", json!({"id":"a", "baseVersion":base}))
                .await
                .unwrap_err(),
            "errors.accountsConflict"
        );
        call("accounts.reorder", json!({"ids":["b","a"]}))
            .await
            .unwrap();
        call("accounts.remove", json!({"id":"b"})).await.unwrap();
        call(
            "accounts.replace_all",
            json!({"entries":[{"id":"c", "password":"incoming"}]}),
        )
        .await
        .unwrap();
        assert_eq!(
            call("accounts.list", json!({})).await.unwrap()["accounts"],
            json!([{"id":"c"}])
        );
        assert_eq!(
            call("accounts.put", json!({"entry":{}})).await.unwrap_err(),
            "errors.accountsInvalid"
        );
        assert_eq!(
            fs::read_to_string(credentials).unwrap(),
            "synthetic-unreadable"
        );
    }
}
