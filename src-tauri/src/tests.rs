use super::*;

#[test]
fn daemon_ipc_paths_live_under_home_dot_mailvault() {
    let (endpoint, token) = crate::daemon_ipc_paths().unwrap();
    let home = mailvault_core::paths::home_dir().unwrap().join(".mailvault");
    assert_eq!(token, home.join("mv.token"), "the token is a real file on both platforms");
    assert_eq!(endpoint, mailvault_core::transport::endpoint(&home));
    #[cfg(unix)]
    assert_eq!(endpoint, home.join("mv.sock"));
}

#[test]
fn daemon_pid_path_lives_under_the_app_data_dir_not_the_ipc_dir() {
    // Must match src-daemon's get_data_dir() + write_pid_file, and must
    // differ from daemon_ipc_paths()'s ~/.mailvault — they are two
    // different directories the daemon writes into.
    let expected = mailvault_core::paths::app_data_dir().unwrap().join("daemon.pid");
    assert_eq!(crate::daemon_pid_path(), expected);
    let (sock, _) = crate::daemon_ipc_paths().unwrap();
    assert_ne!(crate::daemon_pid_path().parent(), sock.parent());
}

#[test]
fn parse_daemon_pid_reads_a_bare_integer() {
    assert_eq!(crate::parse_daemon_pid("4242"), Some(4242));
}

#[test]
fn parse_daemon_pid_tolerates_a_trailing_newline() {
    assert_eq!(crate::parse_daemon_pid("4242\n"), Some(4242));
    assert_eq!(crate::parse_daemon_pid("  4242  \n"), Some(4242));
}

#[test]
fn parse_daemon_pid_rejects_garbage() {
    assert_eq!(crate::parse_daemon_pid(""), None);
    assert_eq!(crate::parse_daemon_pid("not a pid"), None);
    assert_eq!(crate::parse_daemon_pid("-1"), None);
    assert_eq!(crate::parse_daemon_pid("0"), None);
}

#[test]
fn is_daemon_exe_name_matches_the_plain_binary_name() {
    assert!(crate::is_daemon_exe_name("mailvault-daemon"));
}

#[test]
fn is_daemon_exe_name_tolerates_the_proc_deleted_suffix() {
    // Linux's /proc/<pid>/exe readlink appends this after a package
    // upgrade replaces the file backing an already-running process.
    assert!(crate::is_daemon_exe_name("mailvault-daemon (deleted)"));
}

#[test]
fn is_daemon_exe_name_tolerates_the_windows_exe_suffix() {
    // `tasklist` reports the shipped filename, which is `.exe` on Windows.
    assert!(crate::is_daemon_exe_name("mailvault-daemon.exe"));
}

#[test]
fn is_daemon_exe_name_tolerates_the_exe_suffix_case_insensitively() {
    assert!(crate::is_daemon_exe_name("mailvault-daemon.EXE"));
}

#[test]
fn is_daemon_exe_name_rejects_anything_else() {
    assert!(!crate::is_daemon_exe_name("mailvault"));
    assert!(!crate::is_daemon_exe_name("mailvault-daemon-old"));
    assert!(!crate::is_daemon_exe_name("mailvault-daemon-old.exe"));
    assert!(!crate::is_daemon_exe_name(""));
}

#[test]
fn is_daemon_exe_name_does_not_panic_on_a_non_ascii_name() {
    // A stale pid file naming a reused pid can point at any executable —
    // a byte-index slice on the last 4 bytes must not panic when that
    // index lands inside a multi-byte character.
    assert!(!crate::is_daemon_exe_name("日本"));
}

#[test]
fn an_explicit_update_track_wins_over_the_build() {
    // The whole point of the setting: a nightly can go back to stable, and a
    // stable build can opt into nightlies, whatever version it was built as.
    assert_eq!(
        update_feed_override(Some("nightly"), "2.12.0").as_deref(),
        Some(NIGHTLY_APPCAST_URL)
    );
    assert_eq!(
        update_feed_override(Some("stable"), "2.12.0-nightly.abc1234"),
        None
    );
}

#[test]
fn with_no_choice_saved_the_build_picks_its_own_feed() {
    assert_eq!(
        update_feed_override(None, "2.12.0-nightly.abc1234").as_deref(),
        Some(NIGHTLY_APPCAST_URL)
    );
    assert_eq!(update_feed_override(None, "2.12.0"), None);
    // A value from an older or newer catalogue reads as "unset", not as nightly.
    assert_eq!(update_feed_override(Some("beta"), "2.12.0"), None);
}

#[test]
fn save_attachment_to_creates_missing_parent_directories() {
    use base64::Engine;
    let dir = tempfile::tempdir().unwrap();
    // Two levels that do not exist yet — what openInDefaultApp asks for
    // the first time an export is opened on a fresh machine.
    let dest = dir.path().join("mailvault-export").join("nested").join("shot.png");
    let written = save_attachment_to(
        "shot.png".into(),
        base64::engine::general_purpose::STANDARD.encode(b"pixels"),
        dest.to_string_lossy().to_string(),
    )
    .expect("write into a missing directory should succeed");
    assert_eq!(std::fs::read(&written).unwrap(), b"pixels");
}

/// Phase 3 remainder, Task 5: `backup.rs` resolves and releases the
/// backup mirror's bookmark and nothing else. Every write it used to do —
/// the mirror pre-sync's `fs::copy` in both directions, the Graph fetch
/// loop's `fs::write` into `cur/`, the purge queue's own file — moved to
/// `mailvault_core::backup`, running in the daemon. A write reappearing
/// here would be the app growing back a vault writer.
///
/// The real gate on this claim is `tests/unit/vaultInDaemon.test.js`,
/// which reads every file in this directory and runs in CI (`cargo test
/// -p mailvault` does not). This is the same check from inside the crate.
#[test]
fn backup_rs_has_no_vault_or_mirror_writers_left() {
    let src = std::fs::read_to_string("src/backup.rs").expect("run from the crate root");
    for call in ["fs::write", "fs::copy", "fs::remove_file", "fs::create_dir_all"] {
        assert!(!src.contains(call), "backup.rs should only resolve/release the bookmark now, found {call}");
    }
    // Not vacuous: the file is still the bookmark broker the daemon
    // cannot be, and it still forwards.
    assert!(src.contains("resolve_external_location"), "backup.rs stopped resolving the bookmark");
    assert!(src.contains("daemon_call_blocking"), "backup.rs stopped forwarding to the daemon");
}

// -----------------------------------------------------------------------
// Task 1.6b: daemon_rpc hardening — reply_timeout (C8)
// -----------------------------------------------------------------------

/// The daemon's method table states every method's budget
/// (`src-daemon/methods.json`, `replySecs`, `null` for none): the shell
/// answers exactly that for every row.
#[test]
fn reply_timeout_answers_every_methods_json_row_with_its_budget() {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../src-daemon/methods.json")).unwrap();
    assert!(rows.len() > 400, "{} rows", rows.len());
    let mut bounded = 0;
    for row in &rows {
        let name = row["name"].as_str().unwrap();
        let want = match row.get("replySecs").unwrap_or_else(|| panic!("{name}: no replySecs")) {
            serde_json::Value::Null => None,
            v => Some(std::time::Duration::from_secs(v.as_u64().unwrap())),
        };
        bounded += usize::from(want.is_some());
        assert_eq!(crate::reply_timeout(name), want, "method={name}");
    }
    assert!(bounded > 140, "{bounded} bounded rows");
}

#[test]
fn reply_timeout_bounds_the_helper_probe_so_settings_never_hangs_on_checking() {
    assert_eq!(crate::reply_timeout("ping"), Some(std::time::Duration::from_secs(10)));
}

#[test]
fn reply_timeout_outlasts_the_native_observation_deadlines() {
    assert_eq!(crate::reply_timeout("sync.probe"), Some(std::time::Duration::from_secs(30)));
    for method in ["sync.refresh", "sync.refresh_status", "sync.context"] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)));
    }
    assert_eq!(crate::reply_timeout("folders.status"), Some(std::time::Duration::from_secs(125)));
    for method in ["pipeline.focus", "pipeline.status"] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)));
    }
}

/// Just above the daemon's own render budgets, so its `render_unavailable`
/// arrives first.
#[cfg(feature = "blitz-render")]
#[test]
fn reply_timeout_bounds_the_render_family() {
    use std::time::Duration;
    assert_eq!(crate::reply_timeout("render.open"), Some(Duration::from_secs(10)));
    assert_eq!(crate::reply_timeout("render.gpuStatus"), Some(Duration::from_secs(20)));
    assert_eq!(crate::reply_timeout("render.image"), Some(Duration::from_secs(30)));
    for m in ["render.tile", "render.textRuns", "render.inspect", "render.fold"] {
        assert_eq!(crate::reply_timeout(m), Some(Duration::from_secs(6)), "{m}");
    }
    for m in ["render.hit", "render.close", "render.fonts", "render.serialize"] {
        assert_eq!(crate::reply_timeout(m), Some(Duration::from_secs(3)), "{m}");
    }
}

/// A row that does not state its budget is refused, not read as "none".
#[test]
fn a_methods_json_row_without_reply_secs_is_refused() {
    let ok = crate::parse_reply_budgets(r#"[{"name": "a.b", "replySecs": null}, {"name": "c.d", "replySecs": 7}]"#).unwrap();
    assert_eq!(ok["a.b"], None);
    assert_eq!(ok["c.d"], Some(std::time::Duration::from_secs(7)));
    assert!(crate::parse_reply_budgets(r#"[{"name": "a.b"}]"#).is_err());
    assert!(crate::parse_reply_budgets(r#"[{"name": "a.b", "replySecs": "30"}]"#).is_err());
}

#[test]
fn reply_timeout_is_none_for_a_name_the_table_does_not_list() {
    assert_eq!(crate::reply_timeout("no.such_method"), None);
    assert_eq!(crate::reply_timeout("render.nonesuch"), None);
}

#[test]
fn reply_timeout_bounds_read_only_compose_preparation() {
    for method in ["compose.reply_context", "compose.check"] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)));
    }
}

#[test]
fn reply_timeout_bounds_draft_metadata_and_complete_io() {
    for (method, seconds) in [("drafts.list", 120), ("drafts.save", 600), ("drafts.discard", 120)] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(seconds)), "method={method}");
    }
}

#[test]
fn reply_timeout_gives_search_index_destroy_the_longest_budget() {
    assert_eq!(crate::reply_timeout("search_index_destroy"), Some(std::time::Duration::from_secs(150)));
}

#[test]
fn reply_timeout_gives_the_search_and_vault_index_family_thirty_seconds() {
    for method in ["vault_search", "vault_rows", "search_index_status", "search_index_configure", "search_index_rebuild"] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
    }
}

#[test]
fn reply_timeout_bounds_the_body_scan_so_a_hung_daemon_frames_unscanned() {
    for method in ["body.scan", "body.verdicts", "body.classify_links", "body.info"] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
    }
}

#[test]
fn reply_timeout_bounds_the_credential_rpcs_past_the_daemons_own_clocks() {
    for method in [
        "credentials.get",
        "credentials.save",
        "credentials.update",
        "credentials.delete",
    ] {
        let t = crate::reply_timeout(method).expect(method);
        assert!(
            t > std::time::Duration::from_secs(45) && t <= std::time::Duration::from_secs(55),
            "{method}: {t:?}"
        );
    }
}

#[test]
fn reply_timeout_is_none_for_legacy_dotted_methods() {
    assert_eq!(crate::reply_timeout("sync.now"), None);
    assert_eq!(crate::reply_timeout("daemon.heartbeat"), None);
    assert_eq!(crate::reply_timeout("snapshot.create"), None);
}

// -----------------------------------------------------------------------
// Task 2.5 Step 4: every Phase 2 daemon-owned name has a reply_timeout
// entry, added ahead of its route landing so a later task cannot forget it.
// -----------------------------------------------------------------------

#[test]
fn reply_timeout_gives_every_phase_2_thirty_second_method_thirty_seconds() {
    for method in [
        "maildir_read", "maildir_read_light", "maildir_exists", "maildir_store", "maildir_delete",
        "maildir_delete_many", "maildir_set_flags", "cached_attachment_path",
        "save_email_cache", "load_email_cache_partial", "load_email_cache_window", "load_email_cache_meta", "load_email_cache_by_uids",
        "list_cached_uids", "header_cache_month_histogram", "save_mailbox_cache", "load_mailbox_cache", "delete_mailbox_cache",
        "load_graph_id_map", "op_journal_queue", "op_journal_clear", "op_journal_read",
        "read_pending_operation", "save_pending_operation", "clear_pending_operation", "local_index_read",
        "local_index_append", "local_index_remove", "custody_status", "maildir_repair_generation",
        "maildir_orphan_stats", "mail_search_start", "mail_search_cancel", "vault_rebind_uids",
    ] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
    }
}

/// H3c: these can download the message when the vault has no copy.
#[test]
fn reply_timeout_outlasts_the_daemons_body_fetch_for_whole_message_reads() {
    // Above the daemon's 60s FALLBACK_BOUND (src-daemon/src/raw_message.rs).
    for method in ["maildir_read_attachment", "maildir_read_attachments", "maildir_read_raw_source", "cache_attachment"] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(75)), "method={method}");
    }
}

#[test]
fn reply_timeout_gives_every_phase_2_hundred_twenty_second_method_that_budget() {
    // I3 (2.6 review fix round 1): `maildir_read_light_batch`/`maildir_list`
    // moved here from the 30s tier — they can cover a whole mailbox's
    // uids in one unchunked call, a full MIME parse per file.
    for method in [
        "load_email_cache", "graph_allocate_uids", "maildir_storage_stats", "clear_email_cache",
        "maildir_read_light_batch", "maildir_list", "vault_uid_sets", "vault_light_rows",
    ] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(120)), "method={method}");
    }
}

/// Final fix wave I-2: raised from 120s so the app's budget is strictly
/// larger than the daemon's own close wait. RED on the pre-fix code
/// (120s).
#[test]
fn reply_timeout_gives_vault_close_a_five_minute_budget() {
    assert_eq!(crate::reply_timeout("vault_close"), Some(std::time::Duration::from_secs(300)));
}

#[test]
fn reply_timeout_bounds_read_only_unread_reduction() {
    assert_eq!(crate::reply_timeout("counts.unread"), Some(std::time::Duration::from_secs(30)));
}

#[test]
fn reply_timeout_gives_every_phase_2_ten_minute_method_that_budget() {
    for method in [
        "maildir_clear_cache", "maildir_migrate_json_to_eml", "maildir_migrate_email_dirs",
        "maildir_purge_orphans", "prefetch_attachments", "vault_apply_flags", "vault_rename_mailbox",
        "vault_adopt_mailbox_dirs",
    ] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(600)), "method={method}");
    }
}

/// `vault_reopen` is deliberately absent from the plan's table (only the
/// blocking `daemon_call_blocking` call sites use it, each passing their
/// own explicit `Duration`, never through this async-`daemon_rpc` table).
#[test]
fn reply_timeout_is_none_for_vault_reopen() {
    assert_eq!(crate::reply_timeout("vault_reopen"), None);
}

// -----------------------------------------------------------------------
// Task 3.5 (F1 follow-up from 3.4's review): archive_emails, bulk_delete_
// emails, verify_archived_emails, cancel_archive, cancel_bulk_delete each
// now have an explicit reply_timeout arm.
// -----------------------------------------------------------------------

/// Decision 3: archive_emails and bulk_delete_emails get no budget at
/// all. Pinned explicitly (not just "happens to match the `_ => None`
/// catch-all") so a later change to that default cannot silently take
/// the budget away from these two.
#[test]
fn reply_timeout_is_none_for_archive_emails_and_bulk_delete_emails() {
    assert_eq!(crate::reply_timeout("archive_emails"), None);
    assert_eq!(crate::reply_timeout("bulk_delete_emails"), None);
}

/// The delete queue: a submit waits out its own retry schedule and a
/// run waits out a whole replay pass (no budget, pinned like archive's);
/// list and cancel are journal-sized.
#[test]
fn reply_timeout_is_none_for_a_delete_queue_submit_and_bounds_list_and_cancel() {
    assert_eq!(crate::reply_timeout("delete_queue.submit"), None);
    assert_eq!(crate::reply_timeout("delete_queue.run"), None);
    assert_eq!(crate::reply_timeout("delete_queue.list"), Some(std::time::Duration::from_secs(30)));
    assert_eq!(crate::reply_timeout("delete_queue.cancel"), Some(std::time::Duration::from_secs(30)));
}

/// The undo of a delete waits on the server (a SEARCH and a MOVE per
/// group, an APPEND per bin fallback), so it gets a finite budget, past
/// the daemon's own ceiling on the whole call (`RESTORE_BUDGET`, 120s in
/// src-daemon/src/handlers/deleted.rs): the app's wait never ends first.
#[test]
fn reply_timeout_bounds_messages_restore_past_the_daemons_own_ceiling() {
    assert_eq!(crate::reply_timeout("messages.restore"), Some(std::time::Duration::from_secs(150)));
}

#[test]
fn reply_timeout_gives_verify_archived_emails_two_minutes() {
    assert_eq!(crate::reply_timeout("verify_archived_emails"), Some(std::time::Duration::from_secs(120)));
}

#[test]
fn reply_timeout_gives_the_two_cancel_routes_thirty_seconds() {
    for method in ["cancel_archive", "cancel_bulk_delete"] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
    }
}

// -----------------------------------------------------------------------
// Task 3.7: the three insights methods.
// -----------------------------------------------------------------------

/// Decision 3 again: a begin_snapshot walks every cached header of every
/// account in scope before it answers, so it gets no budget at all.
/// Pinned explicitly rather than left to the `_ => None` catch-all.
#[test]
fn reply_timeout_is_none_for_insights_begin_snapshot() {
    assert_eq!(crate::reply_timeout("insights_begin_snapshot"), None);
}

#[test]
fn reply_timeout_gives_insights_read_page_two_minutes() {
    assert_eq!(crate::reply_timeout("insights_read_page"), Some(std::time::Duration::from_secs(120)));
}

#[test]
fn reply_timeout_gives_insights_release_snapshot_thirty_seconds() {
    assert_eq!(crate::reply_timeout("insights_release_snapshot"), Some(std::time::Duration::from_secs(30)));
}

// -----------------------------------------------------------------------
// Task 4.2: fetch_remote_asset.
// -----------------------------------------------------------------------

/// Pinned by its own name, not the `_ => None` default arm: its own
/// internal reqwest timeout is 10s plus redirect overhead, so 30s is a
/// safety margin around that budget, not a new cap.
#[test]
fn reply_timeout_gives_fetch_remote_asset_thirty_seconds() {
    assert_eq!(crate::reply_timeout("fetch_remote_asset"), Some(std::time::Duration::from_secs(30)));
}

#[test]
fn backup_access_private_controls_reject_both_forwarding_paths() {
    for connected in [false, true] {
        for method in [
            "backup.attach_access",
            "backup.access_status",
            "backup.owner_attach",
            "backup.surface_retire",
            "channel.open",
        ] {
            assert!(super::webview_rpc_token(method, connected, 1, Some("native-token")).is_err());
        }
    }
    assert!(super::webview_rpc_token("backup.run_now", false, 0, None)
        .unwrap()
        .is_none());
    assert!(
        super::webview_rpc_token("backup.run_now", true, 1, Some("native-token"))
            .unwrap()
            .is_some()
    );
}

/// Every window's hydration waits on `settings.get`: bounded by name.
#[test]
fn reply_timeout_bounds_the_settings_rpcs() {
    for method in [
        "settings.get",
        "settings.patch",
        "settings.replace",
        "backup.schedule.get",
        "backup.schedule.set",
        "backup.run_now",
        "backup.cancel",
        "backup.stop",
        "backup.schedule.status",
        "backup.context",
        "backup.attach_access",
        "backup.access_status",
    ] {
        assert_eq!(
            crate::reply_timeout(method),
            Some(std::time::Duration::from_secs(30)),
            "method={method}"
        );
    }
}

/// Task 4.4, decision 8: pinned by name, not the `_ => None` default,
/// the whole ZIP read-or-write pass runs inline within the RPC call.
#[test]
fn reply_timeout_is_none_for_export_backup_and_import_backup() {
    assert_eq!(crate::reply_timeout("export_backup"), None);
    assert_eq!(crate::reply_timeout("import_backup"), None);
}

/// Task 4.6, same reasoning as export_backup/import_backup above: pinned
/// by name, not the `_ => None` default, the whole mbox read-or-write
/// pass runs inline within the RPC call.
#[test]
fn reply_timeout_is_none_for_export_mbox_all_and_import_mbox() {
    assert_eq!(crate::reply_timeout("export_mbox_all"), None);
    assert_eq!(crate::reply_timeout("import_mbox"), None);
}

/// MBOX import options: the probe, the local folder list, the upload
/// job's routes and the gap save answer from bounded work; a daemon that
/// never answers them no longer leaves the app waiting for ever.
#[test]
fn reply_timeout_gives_the_mbox_option_and_upload_routes_thirty_seconds() {
    for method in [
        "mbox_probe", "list_local_folders", "mbox_upload_status", "mbox_upload_pause", "mbox_upload_resume",
        "mbox_upload_cancel", "mbox_upload_discard", "vault_gap_save",
    ] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
    }
}

/// The first count of a very large folder is slow; two minutes, as the
/// other single-pass readers.
#[test]
fn reply_timeout_gives_vault_gap_count_two_minutes() {
    assert_eq!(crate::reply_timeout("vault_gap_count"), Some(std::time::Duration::from_secs(120)));
}

/// Pinned by name, not the `_ => None` default: the whole folder goes
/// into the deleted-mail bin inline, with no cancel route.
#[test]
fn reply_timeout_is_none_for_delete_local_folder() {
    assert_eq!(crate::reply_timeout("delete_local_folder"), None);
}

// -----------------------------------------------------------------------
// Task 4.8: migration and restore.
// -----------------------------------------------------------------------

/// Pinned by name, not the `_ => None` default: each of these either
/// spawns and returns almost immediately (progress arrives over
/// channel.open, not this reply) or is a fast local read/flag flip.
#[test]
fn reply_timeout_gives_the_ten_migration_and_restore_kickoff_routes_thirty_seconds() {
    for method in [
        "start_migration", "resume_migration", "count_migration_folders", "start_restore",
        "cancel_migration", "pause_migration", "cancel_restore", "clear_migration_state_cmd",
        "get_migration_state", "count_local_folder",
    ] {
        assert_eq!(crate::reply_timeout(method), Some(std::time::Duration::from_secs(30)), "method={method}");
    }
}

/// Pinned by name: a live IMAP LIST plus, when either side is Graph, an
/// HTTP list_folders call, bounded but genuinely network-bound.
#[test]
fn reply_timeout_gives_get_folder_mappings_two_minutes() {
    assert_eq!(crate::reply_timeout("get_folder_mappings"), Some(std::time::Duration::from_secs(120)));
}

// -----------------------------------------------------------------------
// Task 2.5 fix round 1 (I1): map_call_error / is_stale_daemon_method
// -----------------------------------------------------------------------

#[test]
fn map_call_error_a_stale_method_not_found_becomes_the_outdated_catalog_key() {
    let e = mailvault_core::daemon_ipc::CallError::Rpc("Unknown method: vault_close".to_string());
    assert_eq!(crate::map_call_error("vault_close", e), crate::DAEMON_OUTDATED);
}

#[test]
fn map_call_error_a_daemon_answered_error_passes_through_verbatim() {
    let e = mailvault_core::daemon_ipc::CallError::Rpc(
        "E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved".to_string(),
    );
    assert_eq!(
        crate::map_call_error("maildir_store", e),
        "E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved"
    );
}

#[test]
fn map_call_error_an_unreachable_daemon_becomes_the_unavailable_catalog_key() {
    let e = mailvault_core::daemon_ipc::CallError::Unreachable("cannot connect to daemon: os error 61".to_string());
    assert_eq!(crate::map_call_error("vault_close", e), crate::DAEMON_UNAVAILABLE);
}

#[test]
fn a_method_not_found_reply_is_recognized_as_a_stale_daemon_method() {
    assert!(crate::is_stale_daemon_method(crate::DAEMON_OUTDATED));
}

#[test]
fn other_daemon_errors_are_not_mistaken_for_a_stale_method() {
    assert!(!crate::is_stale_daemon_method(crate::DAEMON_UNAVAILABLE));
    assert!(!crate::is_stale_daemon_method("custody store unavailable: closed"));
}

// -----------------------------------------------------------------------
// Task 2.5 fix round 1 (I2): should_stop_after_lifecycle_call
// -----------------------------------------------------------------------

#[test]
fn a_failed_lifecycle_call_must_stop_the_daemon() {
    assert!(crate::should_stop_after_lifecycle_call(&Err("errors.daemonUnavailable".to_string())));
}

#[test]
fn a_successful_lifecycle_call_must_not_stop_the_daemon() {
    assert!(!crate::should_stop_after_lifecycle_call(&Ok(serde_json::Value::Null)));
}

// -----------------------------------------------------------------------
// Task 1.6b: daemon_rpc hardening — rpc_fast_path (C7)
// -----------------------------------------------------------------------

#[test]
fn rpc_fast_path_allows_a_connected_verified_cached_call() {
    assert_eq!(crate::rpc_fast_path(true, 42, Some("tok")), Some("tok".to_string()));
}

#[test]
fn rpc_fast_path_refuses_when_the_channel_is_not_connected() {
    assert_eq!(crate::rpc_fast_path(false, 42, Some("tok")), None);
}

#[test]
fn rpc_fast_path_refuses_an_unverified_inode() {
    assert_eq!(crate::rpc_fast_path(true, 0, Some("tok")), None);
}

#[test]
fn rpc_fast_path_refuses_without_a_cached_token() {
    assert_eq!(crate::rpc_fast_path(true, 42, None), None);
}

// -----------------------------------------------------------------------
// Task 1.6b: daemon_rpc hardening — map_rpc_error (C5)
// -----------------------------------------------------------------------

#[test]
fn map_rpc_error_method_not_found_becomes_the_outdated_catalog_key() {
    let err = serde_json::json!({"code": -32601, "message": "Unknown method: search_index_status"});
    assert_eq!(crate::map_rpc_error(&err, "search_index_status"), "errors.daemonOutdated");
}

#[test]
fn map_rpc_error_any_other_code_keeps_the_daemons_own_message() {
    let err = serde_json::json!({"code": -32000, "message": "vault is busy"});
    assert_eq!(crate::map_rpc_error(&err, "vault_search"), "vault is busy");
}

#[test]
fn map_rpc_error_falls_back_when_the_message_is_missing() {
    let err = serde_json::json!({"code": -32000});
    assert_eq!(crate::map_rpc_error(&err, "vault_search"), "Unknown daemon error");
}

// -----------------------------------------------------------------------
// Task 1.6b fix round 1 (I2, M3): rpc_attempt's retryable classification
// and the whole-call timeout, against a scripted mock daemon. No
// AppHandle needed — rpc_attempt takes only a socket path and a token.
// The mock listens over the same endpoint `mailvault_core::transport`
// gives the real daemon: a unix socket file on unix, a named pipe on
// Windows.
// -----------------------------------------------------------------------

fn tmp_socket_path() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let path = dir.path().join("mv.sock");
    #[cfg(windows)]
    let path = std::path::PathBuf::from(format!(r"\\.\pipe\mailvault-test-{}", uuid::Uuid::new_v4()));
    (dir, path)
}

/// The one-shot mock listener a test scripts a fake daemon reply on.
/// Created synchronously, before the client ever gets to dial: on unix
/// `bind` alone starts listening (the client can connect before
/// `accept()` runs), and a Windows named pipe *instance* is the listener
/// — `create()` is what makes the name dialable at all, `connect()`
/// below is only the handshake. Doing this before `tokio::spawn` is load
/// bearing: a mock built inside the spawned task races the client, and
/// on Windows a lost race reads as "no daemon" instead of exercising
/// whatever the mock was scripted to say.
#[cfg(unix)]
fn mock_listen(path: &std::path::Path) -> tokio::net::UnixListener {
    tokio::net::UnixListener::bind(path).unwrap()
}
#[cfg(windows)]
fn mock_listen(path: &std::path::Path) -> tokio::net::windows::named_pipe::NamedPipeServer {
    tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(true)
        .create(path.to_string_lossy().as_ref())
        .unwrap()
}

/// Accept the mock's one connection and split it for line-based IO, the
/// same `tokio::io::split` production's `rpc_attempt_inner` and
/// `daemon_channel::connect` use for their own client halves.
#[cfg(unix)]
async fn mock_accept(listener: tokio::net::UnixListener) -> (impl tokio::io::AsyncRead + Unpin, impl tokio::io::AsyncWrite + Unpin) {
    let (stream, _) = listener.accept().await.unwrap();
    tokio::io::split(stream)
}
#[cfg(windows)]
async fn mock_accept(
    listener: tokio::net::windows::named_pipe::NamedPipeServer,
) -> (impl tokio::io::AsyncRead + Unpin, impl tokio::io::AsyncWrite + Unpin) {
    listener.connect().await.unwrap();
    tokio::io::split(listener)
}

#[tokio::test]
async fn rpc_attempt_is_retryable_when_no_daemon_is_listening() {
    let (_dir, path) = tmp_socket_path(); // nothing bound here — connect fails immediately
    match rpc_attempt(&path, "tok", "sync.now", &serde_json::json!({}), None).await {
        RpcOutcome::Unavailable { retryable: true, .. } => {}
        other => panic!("expected a retryable Unavailable, got {other:?}"),
    }
}

#[tokio::test]
async fn rpc_attempt_is_retryable_when_auth_is_rejected() {
    let (_dir, path) = tmp_socket_path();
    let listener = mock_listen(&path);
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (r, mut w) = mock_accept(listener).await;
        let mut lines = BufReader::new(r).lines();
        let _auth_line = lines.next_line().await.unwrap();
        w.write_all(b"{\"error\":\"bad token\"}\n").await.unwrap();
    });

    // Assert the specific message, not just retryable: true — a failed
    // *connect* (no mock reached at all, e.g. a lost create/dial race on
    // a Windows named pipe) also comes back retryable: true, which would
    // let this test pass without ever exercising the auth-rejected path.
    match rpc_attempt(&path, "tok", "sync.now", &serde_json::json!({}), None).await {
        RpcOutcome::Unavailable { retryable: true, message } => {
            assert_eq!(message, "daemon authentication failed");
        }
        other => panic!("expected a retryable Unavailable, got {other:?}"),
    }
}

/// Negative control for this test (documented, not run automatically):
/// on the runner copy only, flip `rpc_attempt_inner`'s post-write EOF arm
/// (`"daemon closed connection before responding"`) from `retryable:
/// false` to `retryable: true`, rerun this test — it must fail — then
/// restore the file from the worktree via rsync and confirm the md5s
/// match again.
#[tokio::test]
async fn rpc_attempt_is_not_retryable_once_the_request_was_sent_and_the_server_drops() {
    let (_dir, path) = tmp_socket_path();
    let listener = mock_listen(&path);
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (r, mut w) = mock_accept(listener).await;
        let mut lines = BufReader::new(r).lines();
        let _auth_line = lines.next_line().await.unwrap();
        w.write_all(b"{}\n").await.unwrap();
        let _request_line = lines.next_line().await.unwrap(); // the request landed
        // Drop the connection here, deliberately answering nothing.
    });

    match rpc_attempt(&path, "tok", "search_index_status", &serde_json::json!({}), None).await {
        RpcOutcome::Unavailable { retryable: false, .. } => {}
        other => panic!("expected a non-retryable Unavailable, got {other:?}"),
    }
}

#[tokio::test]
async fn rpc_attempt_maps_method_not_found_to_the_outdated_key() {
    let (_dir, path) = tmp_socket_path();
    let listener = mock_listen(&path);
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (r, mut w) = mock_accept(listener).await;
        let mut lines = BufReader::new(r).lines();
        let _auth_line = lines.next_line().await.unwrap();
        w.write_all(b"{}\n").await.unwrap();
        let _request_line = lines.next_line().await.unwrap();
        w.write_all(b"{\"error\":{\"code\":-32601,\"message\":\"Unknown method: x\"}}\n").await.unwrap();
    });

    match rpc_attempt(&path, "tok", "some_new_method", &serde_json::json!({}), None).await {
        RpcOutcome::Direct(msg) => assert_eq!(msg, "errors.daemonOutdated"),
        other => panic!("expected Direct(errors.daemonOutdated), got {other:?}"),
    }
}

/// The reply's `result` is moved out, not copied: a present result comes
/// back whole, and a missing or null one reads as Null.
#[tokio::test]
async fn rpc_attempt_returns_the_result_or_null_when_absent() {
    for (reply, expected) in [
        (&b"{\"result\":{\"a\":[1,2]}}\n"[..], serde_json::json!({"a": [1, 2]})),
        (&b"{\"result\":null}\n"[..], serde_json::Value::Null),
        (&b"{}\n"[..], serde_json::Value::Null),
    ] {
        let (_dir, path) = tmp_socket_path();
        let listener = mock_listen(&path);
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let (r, mut w) = mock_accept(listener).await;
            let mut lines = BufReader::new(r).lines();
            let _auth_line = lines.next_line().await.unwrap();
            w.write_all(b"{}\n").await.unwrap();
            let _request_line = lines.next_line().await.unwrap();
            w.write_all(reply).await.unwrap();
        });

        match rpc_attempt(&path, "tok", "sync.now", &serde_json::json!({}), None).await {
            RpcOutcome::Ok(v) => assert_eq!(v, expected),
            other => panic!("expected Ok({expected}), got {other:?}"),
        }
    }
}

/// M3: a listener that answers the auth handshake and then never replies
/// to the request must still be caught by the whole-call budget, and
/// must never be retried.
#[tokio::test]
async fn rpc_attempt_response_timeout_is_bounded_and_not_retryable() {
    let (_dir, path) = tmp_socket_path();
    let listener = mock_listen(&path);
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (r, mut w) = mock_accept(listener).await;
        let mut lines = BufReader::new(r).lines();
        let _auth_line = lines.next_line().await.unwrap();
        w.write_all(b"{}\n").await.unwrap();
        let _request_line = lines.next_line().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(10)).await; // never replies
    });

    let started = std::time::Instant::now();
    let outcome = rpc_attempt(&path, "tok", "vault_search", &serde_json::json!({}), Some(std::time::Duration::from_millis(100))).await;
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "the whole-call timeout must fire near its 100ms budget, not hang");
    match outcome {
        RpcOutcome::Unavailable { retryable: false, message } => assert!(message.contains("no reply in 0s"), "{message}"),
        other => panic!("expected a non-retryable timeout, got {other:?}"),
    }
}

/// M3: the whole-call budget also covers the auth phase, not just the
/// response read — a daemon that accepts the connection and then hangs
/// before ever answering auth must not block `daemon_rpc` forever, and
/// (per the controller's ruling) must not be retried either, even though
/// an immediate auth failure normally would be.
#[tokio::test]
async fn rpc_attempt_auth_timeout_is_bounded_and_not_retryable() {
    let (_dir, path) = tmp_socket_path();
    let listener = mock_listen(&path);
    tokio::spawn(async move {
        let (_r, _w) = mock_accept(listener).await; // accepted, never read, never replied
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    });

    let started = std::time::Instant::now();
    let outcome = rpc_attempt(&path, "tok", "vault_search", &serde_json::json!({}), Some(std::time::Duration::from_millis(100))).await;
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "the whole-call timeout must fire near its 100ms budget, not hang");
    match outcome {
        RpcOutcome::Unavailable { retryable: false, .. } => {}
        other => panic!("even a hang during auth must be non-retryable under a whole-call budget, got {other:?}"),
    }
}

// -----------------------------------------------------------------------
// Task 1.7: DAEMON_SUSPENDED (addendum D) — both tests serialize on this
// lock since they're the only two touching the shared DAEMON_SUSPENDED
// static and cargo runs tests in parallel by default.
// -----------------------------------------------------------------------
static SUSPEND_TEST_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn a_suspended_daemon_is_never_spawned() {
    let _serial = SUSPEND_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    assert!(may_spawn_daemon(), "baseline: nothing suspended yet");
    let guard = suspend_daemon();
    assert!(!may_spawn_daemon(), "must not spawn while a vault handler holds the guard");
    drop(guard);
    assert!(may_spawn_daemon(), "clears once the guard drops normally");
}

#[test]
fn the_suspension_clears_when_the_guard_drops_during_a_panic() {
    let _serial = SUSPEND_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    assert!(may_spawn_daemon(), "baseline: nothing suspended yet");
    let _ = std::panic::catch_unwind(|| {
        let _guard = suspend_daemon();
        panic!("simulated crash mid vault-move");
    });
    assert!(may_spawn_daemon(), "a panic must not leave the daemon permanently suspended");
}

// Task 1.7's MoveFollowUp/after_failed_move (the root-before/root-after
// guess) is gone as of Phase 6: the two-phase daemon move protocol
// (vault_move_to/vault_move_to_default copy-and-verify, then
// vault_move_finalize commits or aborts based on whether the bookmark
// the app just saved actually resolves) makes the guess unnecessary —
// the app never touches the bookmark until the daemon has already
// confirmed the copy, so a failure never leaves it wondering which root
// is current. See src-daemon/src/handlers/vault.rs and the phase 6 plan
// doc's "Restart-ordering fix".
