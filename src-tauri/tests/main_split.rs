//! Guards for the `main.rs` split by concern (dependency-graph task T10).
//!
//! `main.rs` keeps `main()`, the builder chain and the `mod` declarations; the
//! commands, window, menu, tray, updater, daemon-bridge and credential code
//! live in sibling modules. Reads the crate sources only, starts nothing.

use std::fs;
use std::path::PathBuf;

fn main_rs() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join("main.rs");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Every command `main.rs` registers with `tauri::generate_handler!`, as the
/// frontend sees it, captured from the tree before the split. Sorted.
const REGISTERED_COMMANDS: &[&str] = &[
    "abd_attach",
    "abd_start",
    "abd_summarize",
    "accounts_fallback",
    "accounts_switch_transport",
    "apply_menu_labels",
    "attachment_export_start",
    "autostart_state",
    "backup_clear_external_location",
    "backup_copy_uids",
    "backup_get_external_location",
    "backup_migrate_legacy_path",
    "backup_purge_uids",
    "backup_run_account",
    "backup_save_external_location",
    "backup_scan_uids",
    "backup_status",
    "backup_validate_external_location",
    "check_for_updates_now",
    "check_network_connectivity",
    "check_running_from_dmg",
    "cleanup_run_now",
    "clear_logs",
    "daemon_channel_notify",
    "daemon_rpc",
    "e2e_queue_activation",
    "e2e_queue_mailto",
    "get_app_data_dir",
    "get_client_info",
    "get_credentials",
    "get_transfer_stats",
    "github_check_star",
    "github_device_poll",
    "github_device_start",
    "iap_is_entitled",
    "iap_purchase",
    "iap_restore",
    "install_pending_update",
    "log_from_frontend",
    "mailto_default_status",
    "mailto_make_default",
    "open_auxiliary_window",
    "open_compose_window",
    "open_email_window",
    "open_file",
    "open_with_dialog",
    "preview_notification_sound",
    "quit_app",
    "read_anonymous_logs",
    "read_dropped_files",
    "read_file_base64",
    "read_logs",
    "read_settings_json",
    "save_attachment_to",
    "send_notification",
    "set_app_icon",
    "set_autostart",
    "set_badge_count",
    "set_menu_bar_visible",
    "set_tray_accounts",
    "set_update_track",
    "show_in_folder",
    "spellcheck_status",
    "take_notification_deletes",
    "take_notification_open",
    "take_pending_activation",
    "take_pending_mailto",
    "vault_adopt",
    "vault_adopt_mailbox_dirs",
    "vault_apply_flags",
    "vault_get_status",
    "vault_inspect_folder",
    "vault_move_to",
    "vault_move_to_default",
    "vault_rename_mailbox",
    "vault_reset",
    "write_settings_json",
];

/// Upper bound for `main.rs`. It was 5508 lines. Lower this when it shrinks.
const MAIN_RS_MAX_LINES: usize = 560;

#[test]
fn main_rs_stays_small() {
    let lines = main_rs().lines().count();
    assert!(
        lines <= MAIN_RS_MAX_LINES,
        "src/main.rs is {lines} lines, over the {MAIN_RS_MAX_LINES} limit: move code into a module by concern, \
         and lower MAIN_RS_MAX_LINES in tests/main_split.rs when main.rs shrinks"
    );
}

#[test]
fn generate_handler_registers_exactly_the_known_commands() {
    let src = main_rs();
    let start = src.find("generate_handler![").expect("main.rs has no generate_handler!") + "generate_handler![".len();
    let end = start + src[start..].find("])").expect("unterminated generate_handler!");
    let without_comments: String = src[start..end]
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let mut found: Vec<String> = without_comments
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|path| path.rsplit("::").next().unwrap().to_string())
        .collect();
    found.sort();
    let mut dedup = found.clone();
    dedup.dedup();
    assert_eq!(found, dedup, "a command is registered twice");
    let expected: Vec<String> = REGISTERED_COMMANDS.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        found, expected,
        "the registered command set changed: a command was lost, renamed or added. \
         If that is intended, update REGISTERED_COMMANDS in tests/main_split.rs"
    );
}
