//! The one list of every RPC method the daemon answers.
//!
//! `METHODS` is a sorted table: a row per method, naming the router that
//! answers it (`Domain`) and the three facts the dispatcher used to keep in
//! scattered lists: whether it skips OAuth injection (`strict`), whether a
//! person waits on it (`foreground`), and whether it needs the mail folder to
//! be reachable (`needs_mail_dir`). `server::route_request` looks the method up
//! here and calls only that router; a method the table does not know, or a
//! router that declines one the table gave it, falls back to the old linear
//! chain (`server::route_chain`), so a wrong row can never turn a working
//! method into `METHOD_NOT_FOUND`.
//!
//! `methods.json` lists the same names; a test keeps the two equal and
//! `scripts/gen-rpc-methods.mjs` turns it into the frontend's list.

/// The router that answers a method. One variant per router in
/// `server::route_chain`, in that order, plus `Inline` for the methods the
/// chain's final `match` answers itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Domain {
    Daemon,
    SearchIndex,
    MailSearch,
    VaultFiles,
    Vault,
    Archive,
    BackupWorker,
    BackupSchedule,
    Backup,
    Abd,
    Insights,
    ExportFetch,
    Unsubscribe,
    Deleted,
    BackupZip,
    Mbox,
    Migration,
    FolderMove,
    Restore,
    Cache,
    Bulk,
    Journal,
    DeleteQueue,
    Custody,
    VaultFlags,
    Imap,
    Smtp,
    Drafts,
    ComposePrep,
    Compose,
    Graph,
    Oauth2,
    Dns,
    Tags,
    AutoTags,
    Views,
    Notes,
    Portable,
    Transfer,
    Fields,
    Scheduled,
    Snooze,
    FollowUp,
    Pgp,
    Ai,
    ReleaseNotes,
    Fonts,
    #[cfg(feature = "blitz-render")]
    Blitz,
    NetActivity,
    Aliases,
    AliasStore,
    People,
    StorageFormat,
    Learning,
    CustodyProbe,
    Message,
    Mailboxes,
    Accounts,
    Settings,
    Policy,
    Notify,
    Lifecycle,
    Body,
    Cleanup,
    Credentials,
    /// Answered by the final `match` of `server::route_inline`.
    Inline,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Method {
    pub(crate) name: &'static str,
    pub(crate) domain: Domain,
    /// Skips OAuth injection: the strict contracts reject account-bearing
    /// unknown fields without ever resolving credentials.
    pub(crate) strict: bool,
    /// A person waits on it: it holds the search index back (`note_foreground`).
    pub(crate) foreground: bool,
    /// Refused while the mail storage folder is unreachable.
    pub(crate) needs_mail_dir: bool,
}

const fn row(name: &'static str, domain: Domain) -> Method {
    Method { name, domain, strict: false, foreground: false, needs_mail_dir: false }
}

impl Method {
    const fn strict(self) -> Self {
        Method { strict: true, ..self }
    }
    const fn foreground(self) -> Self {
        Method { foreground: true, ..self }
    }
    const fn mail_dir(self) -> Self {
        Method { needs_mail_dir: true, ..self }
    }
}

/// Every method, sorted by name (bytewise) with no duplicates: `lookup` binary-searches it.
pub(crate) const METHODS: &[Method] = &[
    row("abd.attach", Domain::Abd),
    row("abd.attach_mirror", Domain::Abd),
    row("abd.cancel", Domain::Abd),
    row("abd.dismiss", Domain::Abd),
    row("abd.pause", Domain::Abd),
    row("abd.preview", Domain::Abd),
    row("abd.resume", Domain::Abd),
    row("abd.set_token", Domain::Abd),
    row("abd.start", Domain::Abd),
    row("abd.status", Domain::Abd),
    row("abd.summarize", Domain::Abd),
    row("accounts.add", Domain::Accounts),
    row("accounts.get", Domain::Accounts),
    row("accounts.list", Domain::Accounts),
    row("accounts.put", Domain::Accounts),
    row("accounts.remove_local", Domain::Accounts),
    row("accounts.reorder", Domain::Accounts),
    row("accounts.replace_all", Domain::Accounts),
    row("accounts.save", Domain::Accounts),
    row("accounts.switch_transport", Domain::Accounts),
    row("accounts.update", Domain::Accounts),
    row("ai.generate", Domain::Ai),
    row("ai.providers", Domain::Ai),
    row("ai.set_endpoint_key", Domain::Ai),
    row("aliases.add", Domain::AliasStore),
    row("aliases.discover", Domain::Aliases),
    row("aliases.dismiss", Domain::AliasStore),
    row("aliases.list", Domain::AliasStore),
    row("aliases.refresh", Domain::AliasStore),
    row("aliases.remove", Domain::AliasStore),
    row("app.release_commits", Domain::ReleaseNotes),
    row("app.release_notes", Domain::ReleaseNotes),
    row("archive_emails", Domain::Archive).foreground(),
    row("auto_tags.backfill", Domain::AutoTags),
    row("auto_tags.create", Domain::AutoTags),
    row("auto_tags.delete", Domain::AutoTags),
    row("auto_tags.list", Domain::AutoTags),
    row("auto_tags.preview", Domain::AutoTags),
    row("auto_tags.undo_backfill", Domain::AutoTags),
    row("auto_tags.update", Domain::AutoTags),
    row("backup.access_status", Domain::BackupWorker).strict(),
    row("backup.attach_access", Domain::BackupWorker).strict(),
    row("backup.cancel", Domain::BackupWorker).strict(),
    row("backup.context", Domain::BackupWorker).strict(),
    row("backup.run_now", Domain::BackupWorker).strict(),
    row("backup.schedule.get", Domain::BackupSchedule).strict(),
    row("backup.schedule.set", Domain::BackupSchedule).strict(),
    row("backup.schedule.status", Domain::BackupWorker).strict(),
    row("backup.stop", Domain::BackupWorker).strict(),
    row("backup.surface_retire", Domain::BackupWorker).strict(),
    row("backup_cancel", Domain::Backup),
    row("backup_copy_uids", Domain::Backup),
    row("backup_purge_uids", Domain::Backup),
    row("backup_run_account", Domain::Backup),
    row("backup_scan_uids", Domain::Backup),
    row("backup_status", Domain::Backup),
    row("bimi_logo", Domain::Unsubscribe),
    row("body.classify_links", Domain::Body),
    row("body.info", Domain::Body),
    row("body.scan", Domain::Body).foreground(),
    row("body.verdicts", Domain::Body),
    row("bulk.cancel", Domain::Bulk),
    row("bulk.discard", Domain::Bulk),
    row("bulk.resume", Domain::Bulk),
    row("bulk.start", Domain::Bulk),
    row("bulk.status", Domain::Bulk),
    row("bulk_delete_emails", Domain::Archive).foreground(),
    row("cache_attachment", Domain::VaultFiles),
    row("cached_attachment_path", Domain::VaultFiles),
    row("cancel_archive", Domain::Archive),
    row("cancel_bulk_delete", Domain::Archive),
    row("cancel_migration", Domain::Migration),
    row("cancel_restore", Domain::Restore),
    row("classification.cancel", Domain::Inline),
    row("classification.override", Domain::Inline),
    row("classification.reclassify_all", Domain::Inline),
    row("classification.results", Domain::Inline),
    row("classification.run", Domain::Inline),
    row("classification.status", Domain::Inline),
    row("classification.summary", Domain::Inline),
    row("cleanup.preview", Domain::Cleanup),
    row("cleanup.rules.get", Domain::Cleanup),
    row("cleanup.run_now", Domain::Cleanup),
    row("cleanup.status", Domain::Cleanup),
    row("clear_email_cache", Domain::Cache),
    row("clear_migration_state_cmd", Domain::Migration),
    row("clear_pending_operation", Domain::Journal),
    row("compose.check", Domain::ComposePrep).strict().foreground(),
    row("compose.receipts.remove_account", Domain::Compose),
    row("compose.reply_context", Domain::ComposePrep).strict().foreground(),
    row("compose.send", Domain::Compose),
    row("compose.stage", Domain::Compose),
    row("contacts_index.get", Domain::Inline).mail_dir(),
    row("count_local_folder", Domain::Restore),
    row("count_migration_folders", Domain::Migration),
    row("counts.unread", Domain::Inline).strict(),
    row("credentials.delete", Domain::Credentials),
    row("credentials.get", Domain::Credentials),
    row("credentials.save", Domain::Credentials),
    row("credentials.update", Domain::Credentials),
    row("custody.probe_server_copy", Domain::CustodyProbe),
    row("custody_status", Domain::Custody),
    row("daemon.heartbeat", Domain::Daemon),
    row("daemon.shutdown", Domain::Daemon),
    row("daemon.status", Domain::Daemon),
    row("delete_local_folder", Domain::Mbox),
    row("delete_mailbox_cache", Domain::Cache),
    row("delete_queue.cancel", Domain::DeleteQueue),
    row("delete_queue.list", Domain::DeleteQueue),
    row("delete_queue.run", Domain::DeleteQueue),
    row("delete_queue.submit", Domain::DeleteQueue).foreground(),
    row("deleted.discard", Domain::Deleted),
    row("deleted.list", Domain::Deleted),
    row("deleted.recover", Domain::Deleted),
    row("dkim_key", Domain::Dns),
    row("dns_mail_health", Domain::Dns),
    row("drafts.discard", Domain::Drafts),
    row("drafts.list", Domain::Drafts),
    row("drafts.save", Domain::Drafts),
    row("export_attachments", Domain::VaultFiles),
    row("export_backup", Domain::BackupZip),
    row("export_mbox_all", Domain::Mbox),
    row("fetch_remote_asset", Domain::ExportFetch),
    row("fields.copy", Domain::Fields),
    row("fields.delete", Domain::Fields),
    row("fields.list", Domain::Fields),
    row("fields.option_usage", Domain::Fields),
    row("fields.reorder", Domain::Fields),
    row("fields.save", Domain::Fields),
    row("fields.set", Domain::Fields),
    row("fields.values", Domain::Fields),
    row("folder_move.cancel", Domain::FolderMove),
    row("folder_move.discard", Domain::FolderMove),
    row("folder_move.pause", Domain::FolderMove),
    row("folder_move.plan", Domain::FolderMove),
    row("folder_move.resume", Domain::FolderMove),
    row("folder_move.start", Domain::FolderMove),
    row("folder_move.status", Domain::FolderMove),
    row("folders.status", Domain::Inline).strict(),
    row("follow_up.create", Domain::FollowUp),
    row("follow_up.dismiss", Domain::FollowUp),
    row("follow_up.list", Domain::FollowUp),
    row("follow_up.mark_announced", Domain::FollowUp),
    row("follow_up.mark_seen", Domain::FollowUp),
    row("fonts.download", Domain::Fonts),
    row("fonts.list", Domain::Fonts),
    row("fonts.read", Domain::Fonts),
    row("fonts.remove", Domain::Fonts),
    row("get_folder_mappings", Domain::Migration),
    row("get_migration_state", Domain::Migration),
    row("graph_allocate_uids", Domain::Cache),
    row("graph_cache_mime", Domain::Graph),
    row("graph_create_folder", Domain::Graph),
    row("graph_delete_folder", Domain::Graph),
    row("graph_delete_message", Domain::Graph).foreground(),
    row("graph_get_message", Domain::Graph),
    row("graph_list_folders", Domain::Graph),
    row("graph_list_messages", Domain::Graph),
    row("graph_move_emails", Domain::Graph).foreground(),
    row("graph_move_folder", Domain::Graph),
    row("graph_rename_folder", Domain::Graph),
    row("graph_set_flagged", Domain::Graph).foreground(),
    row("graph_set_read", Domain::Graph).foreground(),
    row("header_cache_month_histogram", Domain::Cache),
    row("imap_check_mailbox_status", Domain::Imap),
    row("imap_create_mailbox", Domain::Imap),
    row("imap_delete_email", Domain::Imap).foreground(),
    row("imap_delete_mailbox", Domain::Imap),
    row("imap_disconnect", Domain::Imap),
    row("imap_ensure_sent_mailbox", Domain::Imap),
    row("imap_fetch_changed_flags", Domain::Imap),
    row("imap_fetch_headers_by_uids", Domain::Imap),
    row("imap_find_message_id", Domain::Imap),
    row("imap_folder_status", Domain::Imap),
    row("imap_get_email", Domain::Imap),
    row("imap_get_email_light", Domain::Imap),
    row("imap_get_emails", Domain::Imap),
    row("imap_get_mailboxes", Domain::Imap),
    row("imap_move_emails", Domain::Imap).foreground(),
    row("imap_rename_mailbox", Domain::Imap),
    row("imap_search_all_uids", Domain::Imap),
    row("imap_search_emails", Domain::Imap),
    row("imap_set_flags", Domain::Imap).foreground(),
    row("imap_test_connection", Domain::Imap),
    row("import_backup", Domain::BackupZip),
    row("import_mbox", Domain::Mbox),
    row("insights.aggregate", Domain::Insights),
    row("insights.build", Domain::Insights),
    row("insights.messages", Domain::Insights),
    row("insights.release", Domain::Insights),
    row("insights.status", Domain::Insights),
    row("insights_begin_snapshot", Domain::Insights),
    row("insights_read_page", Domain::Insights),
    row("insights_release_snapshot", Domain::Insights),
    row("keychain.retry", Domain::Inline),
    row("keychain.status", Domain::Inline),
    row("learning.delete_rule", Domain::Learning),
    row("learning.export", Domain::Learning),
    row("learning.import", Domain::Learning),
    row("learning.record_correction", Domain::Learning),
    row("learning.rules", Domain::Learning),
    row("learning.save_rule", Domain::Learning),
    row("learning.stats", Domain::Learning),
    row("lifecycle.dismiss", Domain::Lifecycle),
    row("lifecycle.mark_seen", Domain::Lifecycle),
    row("lifecycle.sync", Domain::Lifecycle),
    row("list_cached_uids", Domain::Cache),
    row("list_local_folders", Domain::Mbox),
    row("llm.cancel_download", Domain::Inline),
    row("llm.classify", Domain::Inline),
    row("llm.delete_model", Domain::Inline),
    row("llm.download", Domain::Inline),
    row("llm.list_models", Domain::Inline),
    row("llm.load", Domain::Inline),
    row("llm.status", Domain::Inline),
    row("llm.unload", Domain::Inline),
    row("load_email_cache", Domain::Cache),
    row("load_email_cache_by_uids", Domain::Cache).foreground(),
    row("load_email_cache_meta", Domain::Cache),
    row("load_email_cache_partial", Domain::Cache).foreground(),
    row("load_email_cache_window", Domain::Cache).foreground(),
    row("load_graph_id_map", Domain::Cache),
    row("load_mailbox_cache", Domain::Cache),
    row("local_index_append", Domain::Custody),
    row("local_index_read", Domain::Custody),
    row("local_index_remove", Domain::Custody),
    row("logs.set_verbosity", Domain::Daemon),
    row("mail_search_cancel", Domain::MailSearch),
    row("mail_search_start", Domain::MailSearch).foreground(),
    row("mailboxes.load", Domain::Mailboxes),
    row("maildir_clear_cache", Domain::VaultFiles),
    row("maildir_delete", Domain::VaultFiles).foreground(),
    row("maildir_delete_many", Domain::Custody).foreground(),
    row("maildir_exists", Domain::VaultFiles),
    row("maildir_list", Domain::VaultFiles),
    row("maildir_migrate_email_dirs", Domain::VaultFiles),
    row("maildir_migrate_json_to_eml", Domain::VaultFiles),
    row("maildir_orphan_stats", Domain::VaultFiles),
    row("maildir_purge_orphans", Domain::Custody),
    row("maildir_read", Domain::VaultFiles).foreground(),
    row("maildir_read_attachment", Domain::VaultFiles).foreground(),
    row("maildir_read_attachments", Domain::VaultFiles).foreground(),
    row("maildir_read_light", Domain::VaultFiles).foreground(),
    row("maildir_read_light_batch", Domain::VaultFiles).foreground(),
    row("maildir_read_raw_source", Domain::VaultFiles).foreground(),
    row("maildir_repair_generation", Domain::Custody),
    row("maildir_set_flags", Domain::VaultFiles).foreground(),
    row("maildir_storage_stats", Domain::VaultFiles),
    row("maildir_store", Domain::VaultFiles),
    row("mbox_probe", Domain::Mbox),
    row("mbox_upload_cancel", Domain::Mbox),
    row("mbox_upload_discard", Domain::Mbox),
    row("mbox_upload_pause", Domain::Mbox),
    row("mbox_upload_resume", Domain::Mbox),
    row("mbox_upload_status", Domain::Mbox),
    row("message.code", Domain::Message),
    row("message.verify_sender", Domain::Message),
    row("messages.restore", Domain::Deleted).foreground(),
    row("net.activity", Domain::NetActivity),
    row("net.geo", Domain::NetActivity),
    row("net.probe", Domain::Inline),
    row("net.report", Domain::Inline),
    row("net.retention", Domain::NetActivity),
    row("net.set_retention", Domain::NetActivity),
    row("net.status", Domain::Inline),
    row("net.summary", Domain::NetActivity),
    row("notes.list", Domain::Notes),
    row("notes.set_done", Domain::Notes),
    row("notify.arrival", Domain::Notify),
    row("notify.decide", Domain::Notify),
    row("oauth2_auth_url", Domain::Oauth2),
    row("oauth2_exchange", Domain::Oauth2),
    row("oauth2_google_clients", Domain::Oauth2),
    row("oauth2_microsoft_personal", Domain::Oauth2),
    row("oauth2_refresh", Domain::Oauth2),
    row("op_journal_clear", Domain::Journal),
    row("op_journal_queue", Domain::Journal),
    row("op_journal_read", Domain::Journal),
    row("pause_migration", Domain::Migration),
    row("people.contacts.names", Domain::People).mail_dir(),
    row("people.contacts.search", Domain::People).foreground().mail_dir(),
    row("people.contacts.top", Domain::People).foreground().mail_dir(),
    row("people.create", Domain::People).mail_dir(),
    row("people.delete", Domain::People).mail_dir(),
    row("people.export_vcf", Domain::People).mail_dir(),
    row("people.get", Domain::People).foreground().mail_dir(),
    row("people.import_vcf", Domain::People).mail_dir(),
    row("people.journal", Domain::People).mail_dir(),
    row("people.list", Domain::People).foreground().mail_dir(),
    row("people.merge", Domain::People).mail_dir(),
    row("people.merge_preview", Domain::People).mail_dir(),
    row("people.messages", Domain::People).foreground().mail_dir(),
    row("people.proposals", Domain::People).mail_dir(),
    row("people.review.accept", Domain::People).mail_dir(),
    row("people.review.dismiss", Domain::People).mail_dir(),
    row("people.review.list", Domain::People).foreground().mail_dir(),
    row("people.split", Domain::People).mail_dir(),
    row("people.stats", Domain::People).foreground().mail_dir(),
    row("people.suggest", Domain::People).foreground().mail_dir(),
    row("people.undo", Domain::People).mail_dir(),
    row("people.update", Domain::People).mail_dir(),
    row("pgp.import_key", Domain::Pgp),
    row("pgp.list_keys", Domain::Pgp),
    row("pgp.remove_key", Domain::Pgp),
    row("ping", Domain::Daemon),
    row("pipeline.focus", Domain::Inline).strict(),
    row("pipeline.status", Domain::Inline).strict(),
    row("policy.accounts", Domain::Policy),
    row("policy.vault_mailboxes", Domain::Policy),
    row("portable.change_passphrase", Domain::Portable),
    row("portable.create", Domain::Portable),
    row("portable.estimate", Domain::Portable),
    row("portable.get_credentials", Domain::Portable),
    row("portable.lock", Domain::Portable),
    row("portable.set_credentials", Domain::Portable),
    row("portable.status", Domain::Portable),
    row("portable.unlock", Domain::Portable),
    row("prefetch_attachments", Domain::VaultFiles),
    row("read_pending_operation", Domain::Journal),
    #[cfg(feature = "blitz-render")]
    row("render.close", Domain::Blitz),
    #[cfg(feature = "blitz-render")]
    row("render.fold", Domain::Blitz),
    #[cfg(feature = "blitz-render")]
    row("render.fonts", Domain::Blitz),
    #[cfg(feature = "blitz-render")]
    row("render.gpuStatus", Domain::Blitz),
    #[cfg(feature = "blitz-render")]
    row("render.hit", Domain::Blitz),
    #[cfg(feature = "blitz-render")]
    row("render.image", Domain::Blitz),
    #[cfg(feature = "blitz-render")]
    row("render.inspect", Domain::Blitz),
    #[cfg(feature = "blitz-render")]
    row("render.open", Domain::Blitz).foreground(),
    #[cfg(feature = "blitz-render")]
    row("render.serialize", Domain::Blitz),
    #[cfg(feature = "blitz-render")]
    row("render.textRuns", Domain::Blitz).foreground(),
    #[cfg(feature = "blitz-render")]
    row("render.tile", Domain::Blitz).foreground(),
    row("resolve_email_settings", Domain::Dns),
    row("resume_migration", Domain::Migration),
    row("save_email_cache", Domain::Cache),
    row("save_mailbox_cache", Domain::Cache),
    row("save_pending_operation", Domain::Journal),
    row("scheduled.cancel", Domain::Scheduled),
    row("scheduled.create", Domain::Scheduled),
    row("scheduled.list", Domain::Scheduled),
    row("scheduled.send_now", Domain::Scheduled),
    row("scheduled.suggest_tz", Domain::Scheduled),
    row("scheduled.update", Domain::Scheduled),
    row("search.suggest", Domain::SearchIndex).foreground(),
    row("search_index_configure", Domain::SearchIndex),
    row("search_index_destroy", Domain::SearchIndex),
    row("search_index_rebuild", Domain::SearchIndex),
    row("search_index_status", Domain::SearchIndex),
    row("settings.get", Domain::Settings),
    row("settings.patch", Domain::Settings),
    row("settings.replace", Domain::Settings),
    row("smtp_build_draft_mime", Domain::Smtp),
    row("smtp_build_mime", Domain::Smtp),
    row("smtp_send_email", Domain::Smtp),
    row("smtp_test_connection", Domain::Smtp),
    row("snapshot.create", Domain::Inline).mail_dir(),
    row("snapshot.create_from_maildir", Domain::Inline).mail_dir(),
    row("snapshot.delete", Domain::Inline).mail_dir(),
    row("snapshot.list", Domain::Inline).mail_dir(),
    row("snapshot.load", Domain::Inline).mail_dir(),
    row("snooze.cancel", Domain::Snooze),
    row("snooze.create", Domain::Snooze),
    row("snooze.ensure_folder", Domain::Snooze),
    row("snooze.list", Domain::Snooze),
    row("snooze.reschedule", Domain::Snooze),
    row("start_migration", Domain::Migration),
    row("start_restore", Domain::Restore),
    row("storage.body_indexed_uids", Domain::SearchIndex),
    row("storage.fetch_mode_changed", Domain::Inline),
    row("storage_format_cancel", Domain::StorageFormat),
    row("storage_format_convert", Domain::StorageFormat),
    row("storage_format_get", Domain::StorageFormat),
    row("storage_format_pause", Domain::StorageFormat),
    row("storage_format_purge_retired", Domain::StorageFormat),
    row("storage_format_resume", Domain::StorageFormat),
    row("storage_format_retired", Domain::StorageFormat),
    row("storage_reclaim_space", Domain::StorageFormat),
    row("sync.context", Domain::Inline).strict().mail_dir(),
    row("sync.events", Domain::Inline).mail_dir(),
    row("sync.now", Domain::Inline).mail_dir(),
    row("sync.probe", Domain::Inline).strict().mail_dir(),
    row("sync.refresh", Domain::Inline).strict().mail_dir(),
    row("sync.refresh_status", Domain::Inline).strict(),
    row("sync.status", Domain::Inline).mail_dir(),
    row("sync.unwatch", Domain::Inline).mail_dir(),
    row("sync.wait", Domain::Inline).mail_dir(),
    row("sync.watch", Domain::Inline).mail_dir(),
    row("sync.watch_status", Domain::Inline).mail_dir(),
    row("tags.assign", Domain::Tags),
    row("tags.delete", Domain::Tags),
    row("tags.ensure", Domain::Tags),
    row("tags.for_messages", Domain::Tags),
    row("tags.list", Domain::Tags),
    row("tags.migrate_legacy", Domain::Tags),
    row("tags.rename", Domain::Tags),
    row("tags.set_color", Domain::Tags),
    row("tags.unassign", Domain::Tags),
    row("transfer.apply_config", Domain::Transfer),
    row("transfer.decrypt", Domain::Transfer),
    row("transfer.export", Domain::Transfer),
    row("transfer.phone_qr", Domain::Transfer),
    row("unsubscribe", Domain::Unsubscribe),
    row("unsubscribe.history", Domain::Unsubscribe),
    row("unsubscribe.senders", Domain::Unsubscribe),
    row("vault_adopt", Domain::Vault),
    row("vault_adopt_mailbox_dirs", Domain::VaultFlags),
    row("vault_apply_flags", Domain::VaultFlags),
    row("vault_close", Domain::SearchIndex),
    row("vault_gap_count", Domain::Backup),
    row("vault_gap_save", Domain::Backup),
    row("vault_get_status", Domain::Vault),
    row("vault_light_rows", Domain::VaultFiles),
    row("vault_move_finalize", Domain::Vault),
    row("vault_move_to", Domain::Vault),
    row("vault_move_to_default", Domain::Vault),
    row("vault_rebind_uids", Domain::Custody),
    row("vault_rename_mailbox", Domain::VaultFlags),
    row("vault_reopen", Domain::SearchIndex),
    row("vault_reparse_rows", Domain::SearchIndex),
    row("vault_rows", Domain::SearchIndex).foreground(),
    row("vault_search", Domain::SearchIndex).foreground(),
    row("vault_uid_sets", Domain::VaultFiles),
    row("verify_archived_emails", Domain::Archive),
    row("views.counts", Domain::Views),
    row("views.delete", Domain::Views),
    row("views.evaluate", Domain::Views).foreground(),
    row("views.export_attachments", Domain::Views),
    row("views.hidden_members", Domain::Views),
    row("views.keyword_detail", Domain::Views).foreground(),
    row("views.keywords", Domain::Views).foreground(),
    row("views.list", Domain::Views),
    row("views.reorder", Domain::Views),
    row("views.save", Domain::Views),
    row("views.senders", Domain::Views).foreground(),
    row("views.suggest_senders", Domain::Views),
    row("views.suggest_terms", Domain::Views),
];

pub(crate) fn lookup(name: &str) -> Option<&'static Method> {
    METHODS.binary_search_by(|m| m.name.cmp(name)).ok().map(|i| &METHODS[i])
}

/// Skips OAuth injection. An unknown method is not strict.
pub(crate) fn is_strict(name: &str) -> bool {
    lookup(name).is_some_and(|m| m.strict)
}

/// A person waits on it. An unknown method is not foreground.
pub(crate) fn is_foreground(name: &str) -> bool {
    lookup(name).is_some_and(|m| m.foreground)
}

/// Refused while the mail storage folder is unreachable. A method the table
/// does not know is gated by the prefix rule the gate always had.
pub(crate) fn needs_mail_dir(name: &str) -> bool {
    match lookup(name) {
        Some(m) => m.needs_mail_dir,
        None => unknown_needs_mail_dir(name),
    }
}

fn unknown_needs_mail_dir(name: &str) -> bool {
    (name.starts_with("sync.") && name != "sync.refresh_status")
        || name.starts_with("snapshot.")
        || name.starts_with("contacts_index.")
        || name.starts_with("people.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// The `matches!` list `server::handle_request` used before the table, pasted
    /// here as the oracle: a row is `strict` exactly when its name is in it.
    const OLD_STRICT: &[&str] = &[
        "sync.probe",
        "counts.unread",
        "sync.refresh",
        "sync.refresh_status",
        "sync.context",
        "pipeline.focus",
        "pipeline.status",
        "folders.status",
        "compose.reply_context",
        "compose.check",
        "backup.schedule.get",
        "backup.schedule.set",
        "backup.run_now",
        "backup.cancel",
        "backup.stop",
        "backup.schedule.status",
        "backup.attach_access",
        "backup.access_status",
        "backup.context",
        "backup.surface_retire",
    ];

    /// `search_index::is_foreground_method` before the table (oracle).
    const OLD_FOREGROUND: &[&str] = &[
        "maildir_read",
        "maildir_read_light",
        "maildir_read_light_batch",
        "maildir_read_raw_source",
        "maildir_read_attachment",
        "maildir_read_attachments",
        "maildir_set_flags",
        "maildir_delete",
        "maildir_delete_many",
        "load_email_cache_partial",
        "load_email_cache_window",
        "load_email_cache_by_uids",
        "vault_rows",
        "vault_search",
        "mail_search_start",
        "imap_set_flags",
        "imap_delete_email",
        "delete_queue.submit",
        "messages.restore",
        "imap_move_emails",
        "graph_set_read",
        "graph_set_flagged",
        "graph_delete_message",
        "graph_move_emails",
        "archive_emails",
        "bulk_delete_emails",
        "search.suggest",
        "views.evaluate",
        "body.scan",
        "views.keywords",
        "views.keyword_detail",
        "views.senders",
        "people.list",
        "people.get",
        "people.stats",
        "people.messages",
        "people.suggest",
        "people.review.list",
        "people.contacts.top",
        "people.contacts.search",
        "compose.reply_context",
        "compose.check",
    ];

    /// `blitz::is_foreground` before the table (oracle); only rows that exist
    /// when the `blitz-render` feature is on.
    #[cfg(feature = "blitz-render")]
    const OLD_BLITZ_FOREGROUND: &[&str] = &["render.open", "render.tile", "render.textRuns"];

    /// The `mail_dir_ok` prefix gate in `server::route_request` before the table (oracle).
    fn old_mail_dir_gate(method: &str) -> bool {
        (method.starts_with("sync.") && method != "sync.refresh_status")
            || method.starts_with("snapshot.")
            || method.starts_with("contacts_index.")
            || method.starts_with("people.")
    }

    fn old_foreground(name: &str) -> bool {
        #[cfg(feature = "blitz-render")]
        if OLD_BLITZ_FOREGROUND.contains(&name) {
            return true;
        }
        OLD_FOREGROUND.contains(&name)
    }

    /// Routers that claim every method with their prefix (`if !method.starts_with(..) { return None }`).
    /// A row with such a prefix owned by another domain would be answered by
    /// the claimer today, so the table must give it to the claimer.
    const PREFIX_CLAIMS: &[(&str, Domain)] = &[
        ("tags.", Domain::Tags),
        ("auto_tags.", Domain::AutoTags),
        ("views.", Domain::Views),
        ("notes.", Domain::Notes),
        ("portable.", Domain::Portable),
        ("transfer.", Domain::Transfer),
        ("fields.", Domain::Fields),
        ("pgp.", Domain::Pgp),
        ("ai.", Domain::Ai),
        ("people.", Domain::People),
        ("body.", Domain::Body),
    ];

    /// Literals a router mentions in a method position that are deliberately
    /// not table rows. `accounts.remove` is the AccountDoc helper's name: the
    /// router returns `None` for it, it is never a public method.
    const NOT_A_METHOD: &[&str] = &["accounts.remove"];

    /// Per domain, the source files whose method-position literals must all be rows.
    /// (Methods a router names through a `const`, `lifecycle.*` and `notify.*`,
    /// are covered by `every_row_is_a_literal_in_its_domain_files`.)
    const SOURCES: &[(Domain, &[&str])] = &[
        (Domain::Daemon, &["src/handlers/daemon.rs"]),
        (Domain::SearchIndex, &["src/handlers/search_index.rs"]),
        (Domain::MailSearch, &["src/handlers/mail_search.rs"]),
        (Domain::VaultFiles, &["src/handlers/vault_files.rs"]),
        (Domain::Vault, &["src/handlers/vault.rs"]),
        (Domain::Archive, &["src/handlers/archive.rs"]),
        (Domain::BackupWorker, &["src/backup_worker.rs", "src/backup_access.rs"]),
        (Domain::BackupSchedule, &["src/handlers/backup_schedule.rs"]),
        (Domain::Backup, &["src/handlers/backup.rs"]),
        (Domain::Abd, &["src/handlers/abd.rs"]),
        (Domain::Insights, &["src/handlers/insights.rs", "src/handlers/insights_aggregate.rs"]),
        (Domain::ExportFetch, &["src/handlers/export_fetch.rs"]),
        (Domain::Unsubscribe, &["src/handlers/unsubscribe.rs"]),
        (Domain::Deleted, &["src/handlers/deleted.rs"]),
        (Domain::BackupZip, &["src/handlers/backup_zip.rs"]),
        (Domain::Mbox, &["src/handlers/mbox.rs"]),
        (Domain::Migration, &["src/handlers/migration.rs"]),
        (Domain::FolderMove, &["src/handlers/folder_move.rs"]),
        (Domain::Restore, &["src/handlers/restore.rs"]),
        (Domain::Cache, &["src/handlers/cache.rs"]),
        (Domain::Bulk, &["src/handlers/bulk.rs"]),
        (Domain::Journal, &["src/handlers/journal.rs"]),
        (Domain::DeleteQueue, &["src/delete_queue.rs"]),
        (Domain::Custody, &["src/handlers/custody.rs"]),
        (Domain::VaultFlags, &["src/handlers/vault_flags.rs"]),
        (Domain::Imap, &["src/handlers/imap.rs"]),
        (Domain::Smtp, &["src/handlers/smtp.rs"]),
        (Domain::Drafts, &["src/handlers/drafts.rs"]),
        (Domain::ComposePrep, &["src/handlers/compose_prep.rs"]),
        (Domain::Compose, &["src/handlers/compose.rs"]),
        (Domain::Graph, &["src/handlers/graph.rs"]),
        (Domain::Oauth2, &["src/handlers/oauth2.rs"]),
        (Domain::Dns, &["src/handlers/dns.rs"]),
        (Domain::Tags, &["src/handlers/tags.rs"]),
        (Domain::AutoTags, &["src/handlers/auto_tags.rs"]),
        (Domain::Views, &["src/handlers/views.rs"]),
        (Domain::Notes, &["src/handlers/notes.rs"]),
        (Domain::Portable, &["src/handlers/portable.rs"]),
        (Domain::Transfer, &["src/handlers/transfer.rs"]),
        (Domain::Fields, &["src/handlers/fields.rs"]),
        (Domain::Scheduled, &["src/handlers/scheduled.rs"]),
        (Domain::Snooze, &["src/handlers/snooze.rs"]),
        (Domain::FollowUp, &["src/handlers/follow_up.rs"]),
        (Domain::Pgp, &["src/handlers/pgp.rs"]),
        (Domain::Ai, &["src/handlers/ai.rs"]),
        (Domain::ReleaseNotes, &["src/handlers/release_notes.rs"]),
        (Domain::Fonts, &["src/handlers/fonts.rs"]),
        #[cfg(feature = "blitz-render")]
        (Domain::Blitz, &["src/blitz/routes.rs"]),
        (Domain::NetActivity, &["src/handlers/net_activity.rs"]),
        (Domain::Aliases, &["src/handlers/aliases.rs"]),
        (Domain::AliasStore, &["src/handlers/alias_store.rs"]),
        (Domain::People, &["src/handlers/people.rs", "src/handlers/people_write.rs"]),
        (Domain::StorageFormat, &["src/handlers/storage_format.rs"]),
        (Domain::Learning, &["src/handlers/learning.rs"]),
        (Domain::CustodyProbe, &["src/handlers/custody_probe.rs"]),
        (Domain::Message, &["src/handlers/message.rs"]),
        (Domain::Mailboxes, &["src/handlers/mailboxes.rs"]),
        (Domain::Accounts, &["src/handlers/accounts.rs"]),
        (Domain::Settings, &["src/handlers/settings.rs"]),
        (Domain::Policy, &["src/handlers/policy.rs"]),
        (Domain::Notify, &["src/handlers/notify.rs"]),
        (Domain::Lifecycle, &["src/handlers/lifecycle.rs"]),
        (Domain::Body, &["src/handlers/body.rs"]),
        (Domain::Cleanup, &["src/handlers/cleanup.rs"]),
        (Domain::Credentials, &["src/handlers/credentials.rs"]),
        (Domain::Inline, &["src/server.rs"]),
    ];

    /// Rows whose name lives in another crate's table (`accounts_doc::METHODS`).
    const CORE_ACCOUNTS_DOC: &str = "../src-core/src/accounts_doc.rs";

    fn read(rel: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    /// `src` without `//` comments; string literals stay whole and a char
    /// literal becomes `' '`, so a quote inside one never opens a string.
    fn strip_comments(src: &str) -> String {
        let b = src.as_bytes();
        let mut out = String::with_capacity(src.len());
        let mut i = 0;
        while i < b.len() {
            let c = b[i];
            if c == b'"' {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    if b[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                let end = (j + 1).min(b.len());
                out.push_str(&src[i..end]);
                i = end;
            } else if c == b'r'
                && b.get(i + 1) == Some(&b'#')
                && b.get(i + 2) == Some(&b'"')
                && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_'))
            {
                let end = src[i + 3..].find("\"#").map_or(b.len(), |p| i + 3 + p + 2);
                out.push_str("\"\"");
                i = end;
            } else if c == b'/' && b.get(i + 1) == Some(&b'/') {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            } else if c == b'\'' {
                if b.get(i + 1) == Some(&b'\\') {
                    let mut j = i + 2;
                    while j < b.len() && b[j] != b'\'' {
                        j += 1;
                    }
                    out.push_str("' '");
                    i = (j + 1).min(b.len());
                } else if let Some(ch) = src[i + 1..].chars().next().filter(|ch| src[i + 1 + ch.len_utf8()..].starts_with('\'')) {
                    out.push_str("' '");
                    i += 2 + ch.len_utf8();
                } else {
                    out.push('\'');
                    i += 1;
                }
            } else {
                let ch = src[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
        out
    }

    fn trailing_ident(s: &str) -> &str {
        let s = s.strip_suffix(".as_str()").unwrap_or(s);
        let start = s.rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).map_or(0, |p| p + 1);
        &s[start..]
    }

    /// Every string literal that names a method: a match arm (`"a" | "b" =>`,
    /// with or without an `if` guard), the right side of `method ==`/`!=`, or
    /// an alternative list in `matches!(method, ..)`.
    fn method_position_literals(src: &str) -> Vec<String> {
        let t = strip_comments(src);
        let b = t.as_bytes();
        let mut lits: Vec<(usize, usize, &str)> = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'"' {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    if b[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                let end = (j + 1).min(b.len());
                lits.push((i, end, &t[i + 1..end - 1]));
                i = end;
            } else {
                i += 1;
            }
        }
        let mut found = Vec::new();
        for &(start, end, content) in &lits {
            let before = t[..start].trim_end();
            if before.ends_with('|') && !before.ends_with("||") {
                continue; // an alternative: handled from the first literal of its chain
            }
            let mut names = vec![content];
            let mut k = end;
            loop {
                let rest = t[k..].trim_start();
                if rest.starts_with('|') && !rest.starts_with("||") {
                    let after = rest[1..].trim_start();
                    if after.starts_with('"') {
                        let pos = t.len() - after.len();
                        if let Ok(n) = lits.binary_search_by_key(&pos, |l| l.0) {
                            names.push(lits[n].2);
                            k = lits[n].1;
                            continue;
                        }
                    }
                }
                break;
            }
            let rest = t[k..].trim_start();
            let mut is_position = rest.starts_with("=>");
            if !is_position && rest.starts_with("if") && !rest[2..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
                let rb = rest.as_bytes();
                for p in 0..rb.len() {
                    if matches!(rb[p], b';' | b'{' | b'}') {
                        break;
                    }
                    if rest[p..].starts_with("=>") {
                        is_position = true;
                        break;
                    }
                }
            }
            if !is_position {
                if let Some(left) = before.strip_suffix("==").or_else(|| before.strip_suffix("!=")) {
                    is_position = trailing_ident(left.trim_end()).contains("method");
                } else if let Some(left) = before.strip_suffix(',') {
                    let left = left.trim_end();
                    let left = left.strip_suffix(".as_str()").unwrap_or(left);
                    let ident = trailing_ident(left);
                    let head = left[..left.len() - ident.len()].trim_end().trim_end_matches(['*', '&']).trim_end();
                    is_position = (ident.contains("method") || ident == "m") && head.ends_with("matches!(");
                }
            }
            if is_position {
                found.extend(names.into_iter().map(str::to_owned));
            }
        }
        found
    }

    fn without_tests(src: &str) -> &str {
        match src.find("\n#[cfg(test)]\nmod tests") {
            Some(p) => &src[..p],
            None => src,
        }
    }

    /// A name a person could mistake for a method: dotted or snake_case.
    /// (Plain words in arms, `"sent" =>`, are state labels, not methods;
    /// bare method names, `ping`, are covered by the reverse test.)
    fn looks_like_method(s: &str) -> bool {
        !s.is_empty()
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
            && (s.contains('.') || s.contains('_'))
    }

    fn scanned_text(domain: Domain, file: &str) -> String {
        let src = read(file);
        if domain == Domain::Inline {
            let from = src.find("async fn route_inline").expect("route_inline in server.rs");
            return without_tests(&src[from..]).to_owned();
        }
        without_tests(&src).to_owned()
    }

    fn names() -> Vec<&'static str> {
        METHODS.iter().map(|m| m.name).collect()
    }

    #[test]
    fn table_is_sorted_with_no_duplicate_names() {
        for pair in METHODS.windows(2) {
            assert!(pair[0].name < pair[1].name, "{:?} must sort strictly before {:?}", pair[0].name, pair[1].name);
        }
    }

    #[test]
    fn lookup_finds_every_row_and_nothing_else() {
        for m in METHODS {
            assert_eq!(lookup(m.name).map(|f| f.domain), Some(m.domain), "{}", m.name);
        }
        assert!(lookup("no.such_method").is_none());
        assert!(lookup("").is_none());
        assert_eq!(lookup("ping").map(|m| m.domain), Some(Domain::Daemon));
        assert_eq!(lookup("sync.now").map(|m| m.domain), Some(Domain::Inline));
    }

    #[test]
    fn methods_json_lists_exactly_the_table() {
        let json: Vec<String> = serde_json::from_str(&read("methods.json")).expect("methods.json is a JSON array of strings");
        let mut sorted = json.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(json, sorted, "methods.json must be sorted without duplicates");
        // The blitz rows exist only with the feature; the list always carries them.
        let json: Vec<&str> = json.iter().map(String::as_str).filter(|n| cfg!(feature = "blitz-render") || !n.starts_with("render.")).collect();
        assert_eq!(json, names());
    }

    #[test]
    fn strict_flag_equals_the_old_matches_list() {
        for m in METHODS {
            assert_eq!(m.strict, OLD_STRICT.contains(&m.name), "strict: {}", m.name);
        }
        for old in OLD_STRICT {
            assert!(lookup(old).is_some_and(|m| m.strict), "old strict method missing from the table: {old}");
        }
        assert!(!is_strict("not.a_method"));
    }

    #[test]
    fn foreground_flag_equals_the_old_list() {
        for m in METHODS {
            assert_eq!(m.foreground, old_foreground(m.name), "foreground: {}", m.name);
        }
        for old in OLD_FOREGROUND {
            assert!(lookup(old).is_some_and(|m| m.foreground), "old foreground method missing from the table: {old}");
        }
        assert!(!is_foreground("not.a_method"));
        #[cfg(feature = "blitz-render")]
        for m in METHODS.iter().filter(|m| m.name.starts_with("render.")) {
            assert_eq!(m.foreground, crate::blitz::is_foreground(m.name), "blitz::is_foreground: {}", m.name);
        }
    }

    #[test]
    fn mail_dir_flag_equals_the_old_prefix_gate() {
        for m in METHODS {
            assert_eq!(m.needs_mail_dir, old_mail_dir_gate(m.name), "needs_mail_dir: {}", m.name);
            assert_eq!(needs_mail_dir(m.name), old_mail_dir_gate(m.name), "needs_mail_dir(): {}", m.name);
        }
    }

    #[test]
    fn an_unknown_method_is_gated_by_the_old_prefix_rule_only() {
        for unknown in ["sync.nonesuch", "snapshot.nonesuch", "contacts_index.nonesuch", "people.nonesuch", "nonesuch", "tags.nonesuch"] {
            assert!(lookup(unknown).is_none(), "{unknown} must stay out of the table for this test");
            assert_eq!(needs_mail_dir(unknown), old_mail_dir_gate(unknown), "{unknown}");
            assert!(!is_strict(unknown));
            assert!(!is_foreground(unknown));
        }
        assert!(needs_mail_dir("people.nonesuch"));
        assert!(!needs_mail_dir("sync.refresh_status"));
        assert!(!needs_mail_dir("tags.nonesuch"));
    }

    #[test]
    fn every_domain_has_a_source_entry_and_every_row_a_known_domain() {
        let listed: Vec<Domain> = SOURCES.iter().map(|(d, _)| *d).collect();
        let unique: BTreeSet<String> = listed.iter().map(|d| format!("{d:?}")).collect();
        assert_eq!(unique.len(), listed.len(), "a domain is listed twice in SOURCES");
        for m in METHODS {
            assert!(listed.contains(&m.domain), "{} names a domain with no SOURCES entry: {:?}", m.name, m.domain);
        }
    }

    #[test]
    fn every_method_position_literal_in_a_router_is_a_row_of_that_router() {
        for (domain, files) in SOURCES {
            for file in *files {
                for name in method_position_literals(&scanned_text(*domain, file)) {
                    if !looks_like_method(&name) || NOT_A_METHOD.contains(&name.as_str()) {
                        continue;
                    }
                    let row = lookup(&name).unwrap_or_else(|| panic!("{file} answers {name:?} but the table has no row for it"));
                    assert_eq!(row.domain, *domain, "{name} is listed under {:?} but {file} (domain {domain:?}) answers it", row.domain);
                }
            }
        }
    }

    #[test]
    fn every_row_is_a_literal_in_its_domain_files() {
        for m in METHODS {
            let (_, files) = SOURCES.iter().find(|(d, _)| *d == m.domain).expect("SOURCES entry");
            let mut texts: Vec<String> = files.iter().map(|f| read(f)).collect();
            if m.domain == Domain::Accounts {
                texts.push(read(CORE_ACCOUNTS_DOC));
            }
            let quoted = format!("\"{}\"", m.name);
            assert!(texts.iter().any(|t| t.contains(&quoted)), "{} is not a literal in the files of {:?}", m.name, m.domain);
        }
    }

    #[test]
    fn a_prefix_claiming_router_owns_every_row_with_its_prefix() {
        for m in METHODS {
            for (prefix, owner) in PREFIX_CLAIMS {
                if m.name.starts_with(prefix) {
                    assert_eq!(m.domain, *owner, "{} starts with {prefix}, which {owner:?} claims whole", m.name);
                }
            }
        }
    }

    #[test]
    fn the_scanner_reads_arms_guards_comparisons_and_matches() {
        let src = r#"
            match method {
                "a.one" | "a.two" => 1,
                "b.guarded" if x == 1 => 2, // "c.commented" =>
                _ => 0,
            }
            if method == "d.cmp" { }
            if !matches!(method, "e.one" | "e.two") { }
            if matches!(method.as_str(), "h.one" | "h.two") { }
            let q = '"'; // a quote char must not open a string
            let not_a_method = other == "f.not_method";
            let s = "g.string_with_arrow =>";
        "#;
        let mut got = method_position_literals(src);
        got.sort();
        assert_eq!(got, ["a.one", "a.two", "b.guarded", "d.cmp", "e.one", "e.two", "h.one", "h.two"]);
    }
}
