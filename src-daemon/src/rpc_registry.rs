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
//! Each row also states the app's reply budget for the method (`Budget`).
//! `methods.json` lists the same names and budgets; a test keeps the two
//! equal, the app's shell reads the budgets from it (`reply_timeout`) and
//! `scripts/gen-rpc-methods.mjs` turns its names into the frontend's list.

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
    /// How long the app waits for the reply. The daemon never reads it: it
    /// reaches the app through `methods.json` (`reply_timeout` in
    /// `src-tauri/src/rpc_proxy.rs`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) reply: Budget,
}

const fn row(name: &'static str, domain: Domain, reply: Budget) -> Method {
    Method { name, domain, strict: false, foreground: false, needs_mail_dir: false, reply }
}

/// The app's reply budget for one method (`daemon_rpc`'s C8 timeout). It
/// bounds the whole attempt: connect, auth, request and reply together.
/// Expiry is an unknown outcome, never a cancellation of the daemon's work.
/// Every row states one, so a new method cannot be left with a budget nobody
/// chose; `methods.json` carries it as `replySecs` (`null` for `Unbounded`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Budget {
    Secs(u64),
    /// No timeout: the app waits as long as the daemon takes.
    Unbounded,
}

const fn secs(n: u64) -> Budget {
    Budget::Secs(n)
}

/// Every legacy dotted method and every name added before budgets existed:
/// none, as before. A method that needs one gets it by name below.
const LEGACY: Budget = Budget::Unbounded;

/// Single-row or one-mailbox operations.
const ONE_ROW: Budget = secs(30);

/// One big read or write.
const BIG_READ: Budget = secs(120);

/// Vault-wide scans and migrations, and the mirror-spanning flag and rename
/// forwarders (`src-tauri/src/vault_flags.rs` shares this budget).
const VAULT_WIDE: Budget = secs(600);

/// The daemon itself waits up to 120s for the index worker to finish before
/// it replies, so this is the longest of its family.
const SEARCH_INDEX_DESTROY: Budget = secs(150);

/// Full draft MIME and attachment preparation may outlast a short UI read.
const DRAFT_SAVE: Budget = secs(600);

/// List can recover one selected body; discard validates exact local IO.
const DRAFT_LIST: Budget = secs(120);

/// The helper card's own probe (`isDaemonAvailable` -> `ping`). Unbounded, a
/// daemon that accepts the socket but never answers left Settings on
/// "Checking..." forever; a bounded failure at least says "Helper Not
/// Running" honestly. The dotted lifecycle methods stay unbounded, like every
/// other legacy dotted name.
const PING: Budget = secs(10);

/// Native changes bound admission at 5s, read at 20s and write at 20s. Leave
/// time for the daemon to report failure or uncertainty.
const CREDENTIALS: Budget = secs(50);

/// A message is framed only once its body scan answers: unbounded, a hung
/// daemon left every reader blank. Bounded, the app frames the body unscanned,
/// with remote images refused (services/bodyScan.js).
const BODY_SCAN: Budget = secs(30);

/// H3c: a message the vault has no copy of is downloaded by these
/// (`raw_message`). The daemon bounds its whole fallback at 60s
/// (`FALLBACK_BOUND`: this message's lock, keychain, connect, the 45s body
/// fetch, the cache write) and then answers the vault's error; 75s leaves room
/// for the parse after a download that just made it. A vault hit answers in
/// milliseconds, so the width is only ever spent on a real download.
/// `cached_attachment_path` never downloads and stays `ONE_ROW`.
const MESSAGE_DOWNLOAD: Budget = secs(75);

/// I3 (2.6 review): `maildir_read_light_batch` and `maildir_list` can be sent
/// for a whole mailbox's uids in one call (`getLocalEmails`,
/// `src/services/db/emails.js`), a full MIME parse per file, with no chunking
/// on this path (unlike `getArchivedEmails`, which chunks at 200). The old
/// Tauri commands they replace had no budget at all, so 30s can time out a
/// large archive on a slow drive that used to just run slow and succeed.
/// `vault_uid_sets` replaces `maildir_list` and lists a mailbox once per
/// session; `vault_light_rows` parses every never-parsed file of a mailbox on
/// its first call.
const WHOLE_MAILBOX: Budget = secs(120);

/// Final fix wave I-2: a `vault_close` can outlast 120s when the search index
/// worker is mid-batch or compacting. The app's budget must be strictly larger
/// than the daemon's own wait (`si::close`/`custody::close` inside
/// `handlers/search_index.rs`), or the app SIGTERMs the daemon mid-write just
/// before the vault move starts copying. Not consulted by
/// `daemon_vault_lifecycle_call` (it passes its own explicit `Duration`, as
/// for `vault_reopen`): kept here so the budget is documented in one table and
/// pinned by a test, matching every call site.
const VAULT_CLOSE: Budget = secs(300);

/// Task 3.5 decision 3: a 40k-uid archive or a large bulk delete runs far past
/// every other budget in this table. The JS awaits the reply directly, and the
/// way out of a long run is the daemon's own cancel_archive/cancel_bulk_delete,
/// not a timeout that turns a slow success into a failure (Phase 2's 2.6 I3
/// lesson).
const ARCHIVE_RUN: Budget = Budget::Unbounded;

/// The daemon's delete queue (src-daemon/src/delete_queue.rs). A submit
/// answers only after its whole retry schedule: six send rounds, each uid's
/// capture allowed 45s, plus 31s of waits, so a budget would turn a slow
/// delete into a failure the daemon is still finishing. A run is one replay
/// pass over every entry (one round each, uids in turn), so it is unbounded
/// too. List and cancel are one journal read or write, `ONE_ROW`.
const DELETE_QUEUE_RUN: Budget = Budget::Unbounded;

/// The undo of a delete (src-daemon/src/handlers/deleted.rs): a SEARCH and a
/// MOVE per group, an APPEND per bin fallback, all inside the daemon's own
/// 120s `RESTORE_BUDGET`, which answers first. Past this, the app hides the
/// rows again and reloads to see what came back.
const MESSAGES_RESTORE: Budget = secs(150);

/// Ungated, no vault access, one atomic store per registered token.
const CANCEL_TOKEN: Budget = secs(30);

/// Task 3.7, same reasoning as `ARCHIVE_RUN`: the inventory walk behind a
/// begin_snapshot reads every cached header of every account in scope (50k in
/// the e2e's LARGE mode) before it answers, and the JS awaits that reply.
const INSIGHTS_SNAPSHOT: Budget = Budget::Unbounded;

/// Task 4.2: its own internal reqwest timeout is 10s plus redirect overhead
/// (up to 3 hops); 30s is a safety margin around that, not a new cap this
/// budget could bind against in practice.
const FETCH_REMOTE_ASSET: Budget = secs(30);

/// The settings document (`handlers/settings.rs`): one small file read, or one
/// write and fsync. Every window hydrates through `settings.get`, so a daemon
/// that accepts and never answers must not hang the UI.
const SETTINGS: Budget = secs(30);

/// Task 4.4 and 4.6, decision 8, same reasoning as `ARCHIVE_RUN`: the whole
/// ZIP or mbox read-or-write pass happens within this RPC call and the JS
/// awaits the return value directly.
const INLINE_EXPORT_IMPORT: Budget = Budget::Unbounded;

/// MBOX import options: each answers from a bounded amount of work.
/// `mbox_probe` reads a capped sample of the file's start and the cached
/// folder list; `list_local_folders` one directory listing; the upload job's
/// routes read or steer a job that runs on its own thread (a resume's keychain
/// read is bounded at 20s by the daemon); `vault_gap_save` starts its run and
/// answers at once.
const MBOX_OPTIONS: Budget = secs(30);

/// Reads every cached header row of the account against the vault before it
/// answers: the first count of a very large folder is slow.
const VAULT_GAP_COUNT: Budget = secs(120);

/// Same reasoning as `ARCHIVE_RUN`: every message of the folder is copied into
/// the deleted-mail bin inline, within this call, and there is no cancel
/// route; a budget would turn a slow success on a big import into a reported
/// failure while the daemon goes on deleting.
const DELETE_LOCAL_FOLDER: Budget = Budget::Unbounded;

/// Task 4.8, decision 8: each either kicks off a spawned task and returns
/// almost immediately (progress flows over channel.open, not this reply) or is
/// a fast local read or flag flip.
const MIGRATION_CONTROL: Budget = secs(30);

/// Task 4.8, decision 8: a live IMAP LIST plus, when either side is Graph, an
/// HTTP list_folders call, bounded but genuinely network-bound.
const FOLDER_MAPPINGS: Budget = secs(120);

/// The render family: just above the daemon's own (open 8s; tile, textRuns and
/// fold 4s), so the daemon's `render_unavailable` arrives first. The GPU probe
/// (adapter, shader compile, one frame) has its own 15s cap. Everything else in
/// the family is quick. Only with the `blitz-render` feature; the app gives
/// these none without it.
#[cfg(feature = "blitz-render")]
const RENDER_OPEN: Budget = secs(10);
#[cfg(feature = "blitz-render")]
const RENDER_FRAME: Budget = secs(6);
#[cfg(feature = "blitz-render")]
const RENDER_IMAGE: Budget = secs(30);
#[cfg(feature = "blitz-render")]
const RENDER_GPU_STATUS: Budget = secs(20);
#[cfg(feature = "blitz-render")]
const RENDER_QUICK: Budget = secs(3);

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
    row("abd.attach", Domain::Abd, LEGACY),
    row("abd.attach_mirror", Domain::Abd, LEGACY),
    row("abd.cancel", Domain::Abd, LEGACY),
    row("abd.dismiss", Domain::Abd, LEGACY),
    row("abd.pause", Domain::Abd, LEGACY),
    row("abd.preview", Domain::Abd, LEGACY),
    row("abd.resume", Domain::Abd, LEGACY),
    row("abd.set_token", Domain::Abd, LEGACY),
    row("abd.start", Domain::Abd, LEGACY),
    row("abd.status", Domain::Abd, LEGACY),
    row("abd.summarize", Domain::Abd, LEGACY),
    row("accounts.add", Domain::Accounts, secs(305)),
    row("accounts.get", Domain::Accounts, secs(30)),
    row("accounts.list", Domain::Accounts, secs(30)),
    row("accounts.put", Domain::Accounts, secs(50)),
    row("accounts.remove_local", Domain::Accounts, secs(185)),
    row("accounts.reorder", Domain::Accounts, secs(50)),
    row("accounts.replace_all", Domain::Accounts, secs(50)),
    row("accounts.save", Domain::Accounts, secs(95)),
    row("accounts.switch_transport", Domain::Accounts, LEGACY),
    row("accounts.update", Domain::Accounts, secs(305)),
    row("ai.generate", Domain::Ai, LEGACY),
    row("ai.providers", Domain::Ai, LEGACY),
    row("ai.set_endpoint_key", Domain::Ai, LEGACY),
    row("aliases.add", Domain::AliasStore, LEGACY),
    row("aliases.discover", Domain::Aliases, LEGACY),
    row("aliases.dismiss", Domain::AliasStore, LEGACY),
    row("aliases.list", Domain::AliasStore, LEGACY),
    row("aliases.refresh", Domain::AliasStore, LEGACY),
    row("aliases.remove", Domain::AliasStore, LEGACY),
    row("app.release_commits", Domain::ReleaseNotes, LEGACY),
    row("app.release_notes", Domain::ReleaseNotes, LEGACY),
    row("archive_emails", Domain::Archive, ARCHIVE_RUN).foreground(),
    row("auto_tags.backfill", Domain::AutoTags, LEGACY),
    row("auto_tags.create", Domain::AutoTags, LEGACY),
    row("auto_tags.delete", Domain::AutoTags, LEGACY),
    row("auto_tags.list", Domain::AutoTags, LEGACY),
    row("auto_tags.preview", Domain::AutoTags, LEGACY),
    row("auto_tags.undo_backfill", Domain::AutoTags, LEGACY),
    row("auto_tags.update", Domain::AutoTags, LEGACY),
    row("backup.access_status", Domain::BackupWorker, SETTINGS).strict(),
    row("backup.attach_access", Domain::BackupWorker, SETTINGS).strict(),
    row("backup.cancel", Domain::BackupWorker, SETTINGS).strict(),
    row("backup.context", Domain::BackupWorker, SETTINGS).strict(),
    row("backup.run_now", Domain::BackupWorker, SETTINGS).strict(),
    row("backup.schedule.get", Domain::BackupSchedule, SETTINGS).strict(),
    row("backup.schedule.set", Domain::BackupSchedule, SETTINGS).strict(),
    row("backup.schedule.status", Domain::BackupWorker, SETTINGS).strict(),
    row("backup.stop", Domain::BackupWorker, SETTINGS).strict(),
    row("backup.surface_retire", Domain::BackupWorker, LEGACY).strict(),
    row("backup_cancel", Domain::Backup, LEGACY),
    row("backup_copy_uids", Domain::Backup, LEGACY),
    row("backup_purge_uids", Domain::Backup, LEGACY),
    row("backup_run_account", Domain::Backup, LEGACY),
    row("backup_scan_uids", Domain::Backup, LEGACY),
    row("backup_status", Domain::Backup, LEGACY),
    row("bimi_logo", Domain::Unsubscribe, LEGACY),
    row("body.classify_links", Domain::Body, BODY_SCAN),
    row("body.info", Domain::Body, BODY_SCAN),
    row("body.scan", Domain::Body, BODY_SCAN).foreground(),
    row("body.verdicts", Domain::Body, BODY_SCAN),
    row("bulk.cancel", Domain::Bulk, secs(30)),
    row("bulk.discard", Domain::Bulk, secs(30)),
    row("bulk.resume", Domain::Bulk, secs(30)),
    row("bulk.start", Domain::Bulk, secs(30)),
    row("bulk.status", Domain::Bulk, secs(30)),
    row("bulk_delete_emails", Domain::Archive, ARCHIVE_RUN).foreground(),
    row("cache_attachment", Domain::VaultFiles, MESSAGE_DOWNLOAD),
    row("cached_attachment_path", Domain::VaultFiles, ONE_ROW),
    row("cancel_archive", Domain::Archive, CANCEL_TOKEN),
    row("cancel_bulk_delete", Domain::Archive, CANCEL_TOKEN),
    row("cancel_migration", Domain::Migration, MIGRATION_CONTROL),
    row("cancel_restore", Domain::Restore, MIGRATION_CONTROL),
    row("classification.cancel", Domain::Inline, LEGACY),
    row("classification.override", Domain::Inline, LEGACY),
    row("classification.reclassify_all", Domain::Inline, LEGACY),
    row("classification.results", Domain::Inline, LEGACY),
    row("classification.run", Domain::Inline, LEGACY),
    row("classification.status", Domain::Inline, LEGACY),
    row("classification.summary", Domain::Inline, LEGACY),
    row("cleanup.preview", Domain::Cleanup, LEGACY),
    row("cleanup.rules.get", Domain::Cleanup, LEGACY),
    row("cleanup.run_now", Domain::Cleanup, LEGACY),
    row("cleanup.status", Domain::Cleanup, LEGACY),
    row("clear_email_cache", Domain::Cache, WHOLE_MAILBOX),
    row("clear_migration_state_cmd", Domain::Migration, MIGRATION_CONTROL),
    row("clear_pending_operation", Domain::Journal, ONE_ROW),
    row("compose.check", Domain::ComposePrep, secs(30)).strict().foreground(),
    row("compose.receipts.remove_account", Domain::Compose, LEGACY),
    row("compose.reply_context", Domain::ComposePrep, secs(30)).strict().foreground(),
    row("compose.send", Domain::Compose, LEGACY),
    row("compose.stage", Domain::Compose, LEGACY),
    row("contacts_index.get", Domain::Inline, LEGACY).mail_dir(),
    row("count_local_folder", Domain::Restore, MIGRATION_CONTROL),
    row("count_migration_folders", Domain::Migration, MIGRATION_CONTROL),
    row("counts.unread", Domain::Inline, secs(30)).strict(),
    row("credentials.delete", Domain::Credentials, CREDENTIALS),
    row("credentials.get", Domain::Credentials, CREDENTIALS),
    row("credentials.save", Domain::Credentials, CREDENTIALS),
    row("credentials.update", Domain::Credentials, CREDENTIALS),
    row("custody.probe_server_copy", Domain::CustodyProbe, LEGACY),
    row("custody_status", Domain::Custody, ONE_ROW),
    row("daemon.heartbeat", Domain::Daemon, LEGACY),
    row("daemon.shutdown", Domain::Daemon, LEGACY),
    row("daemon.status", Domain::Daemon, LEGACY),
    row("delete_local_folder", Domain::Mbox, DELETE_LOCAL_FOLDER),
    row("delete_mailbox_cache", Domain::Cache, ONE_ROW),
    row("delete_queue.cancel", Domain::DeleteQueue, ONE_ROW),
    row("delete_queue.list", Domain::DeleteQueue, ONE_ROW),
    row("delete_queue.run", Domain::DeleteQueue, DELETE_QUEUE_RUN),
    row("delete_queue.submit", Domain::DeleteQueue, DELETE_QUEUE_RUN).foreground(),
    row("deleted.discard", Domain::Deleted, LEGACY),
    row("deleted.list", Domain::Deleted, LEGACY),
    row("deleted.recover", Domain::Deleted, LEGACY),
    row("dkim_key", Domain::Dns, LEGACY),
    row("dns_mail_health", Domain::Dns, LEGACY),
    row("drafts.discard", Domain::Drafts, DRAFT_LIST),
    row("drafts.list", Domain::Drafts, DRAFT_LIST),
    row("drafts.save", Domain::Drafts, DRAFT_SAVE),
    row("export_attachments", Domain::VaultFiles, LEGACY),
    row("export_backup", Domain::BackupZip, INLINE_EXPORT_IMPORT),
    row("export_mbox_all", Domain::Mbox, INLINE_EXPORT_IMPORT),
    row("fetch_remote_asset", Domain::ExportFetch, FETCH_REMOTE_ASSET),
    row("fields.copy", Domain::Fields, LEGACY),
    row("fields.delete", Domain::Fields, LEGACY),
    row("fields.list", Domain::Fields, LEGACY),
    row("fields.option_usage", Domain::Fields, LEGACY),
    row("fields.reorder", Domain::Fields, LEGACY),
    row("fields.save", Domain::Fields, LEGACY),
    row("fields.set", Domain::Fields, LEGACY),
    row("fields.values", Domain::Fields, LEGACY),
    row("folder_move.cancel", Domain::FolderMove, LEGACY),
    row("folder_move.discard", Domain::FolderMove, LEGACY),
    row("folder_move.pause", Domain::FolderMove, LEGACY),
    row("folder_move.plan", Domain::FolderMove, LEGACY),
    row("folder_move.resume", Domain::FolderMove, LEGACY),
    row("folder_move.start", Domain::FolderMove, LEGACY),
    row("folder_move.status", Domain::FolderMove, LEGACY),
    row("folders.status", Domain::Inline, secs(125)).strict(),
    row("follow_up.create", Domain::FollowUp, LEGACY),
    row("follow_up.dismiss", Domain::FollowUp, LEGACY),
    row("follow_up.list", Domain::FollowUp, LEGACY),
    row("follow_up.mark_announced", Domain::FollowUp, LEGACY),
    row("follow_up.mark_seen", Domain::FollowUp, LEGACY),
    row("fonts.download", Domain::Fonts, LEGACY),
    row("fonts.list", Domain::Fonts, LEGACY),
    row("fonts.read", Domain::Fonts, LEGACY),
    row("fonts.remove", Domain::Fonts, LEGACY),
    row("get_folder_mappings", Domain::Migration, FOLDER_MAPPINGS),
    row("get_migration_state", Domain::Migration, MIGRATION_CONTROL),
    row("graph_allocate_uids", Domain::Cache, WHOLE_MAILBOX),
    row("graph_cache_mime", Domain::Graph, LEGACY),
    row("graph_create_folder", Domain::Graph, LEGACY),
    row("graph_delete_folder", Domain::Graph, LEGACY),
    row("graph_delete_message", Domain::Graph, LEGACY).foreground(),
    row("graph_get_message", Domain::Graph, LEGACY),
    row("graph_list_folders", Domain::Graph, LEGACY),
    row("graph_list_messages", Domain::Graph, LEGACY),
    row("graph_move_emails", Domain::Graph, LEGACY).foreground(),
    row("graph_move_folder", Domain::Graph, LEGACY),
    row("graph_rename_folder", Domain::Graph, LEGACY),
    row("graph_set_flagged", Domain::Graph, LEGACY).foreground(),
    row("graph_set_read", Domain::Graph, LEGACY).foreground(),
    row("header_cache_month_histogram", Domain::Cache, ONE_ROW),
    row("imap_check_mailbox_status", Domain::Imap, LEGACY),
    row("imap_create_mailbox", Domain::Imap, LEGACY),
    row("imap_delete_email", Domain::Imap, LEGACY).foreground(),
    row("imap_delete_mailbox", Domain::Imap, LEGACY),
    row("imap_disconnect", Domain::Imap, LEGACY),
    row("imap_ensure_sent_mailbox", Domain::Imap, LEGACY),
    row("imap_fetch_changed_flags", Domain::Imap, LEGACY),
    row("imap_fetch_headers_by_uids", Domain::Imap, LEGACY),
    row("imap_find_message_id", Domain::Imap, LEGACY),
    row("imap_folder_status", Domain::Imap, LEGACY),
    row("imap_get_email", Domain::Imap, LEGACY),
    row("imap_get_email_light", Domain::Imap, LEGACY),
    row("imap_get_emails", Domain::Imap, LEGACY),
    row("imap_get_mailboxes", Domain::Imap, LEGACY),
    row("imap_move_emails", Domain::Imap, LEGACY).foreground(),
    row("imap_rename_mailbox", Domain::Imap, LEGACY),
    row("imap_search_all_uids", Domain::Imap, LEGACY),
    row("imap_search_emails", Domain::Imap, LEGACY),
    row("imap_set_flags", Domain::Imap, LEGACY).foreground(),
    row("imap_test_connection", Domain::Imap, LEGACY),
    row("import_backup", Domain::BackupZip, INLINE_EXPORT_IMPORT),
    row("import_mbox", Domain::Mbox, INLINE_EXPORT_IMPORT),
    row("insights.aggregate", Domain::Insights, LEGACY),
    row("insights.build", Domain::Insights, LEGACY),
    row("insights.messages", Domain::Insights, LEGACY),
    row("insights.release", Domain::Insights, LEGACY),
    row("insights.status", Domain::Insights, LEGACY),
    row("insights_begin_snapshot", Domain::Insights, INSIGHTS_SNAPSHOT),
    row("insights_read_page", Domain::Insights, BIG_READ),
    row("insights_release_snapshot", Domain::Insights, ONE_ROW),
    row("keychain.retry", Domain::Inline, LEGACY),
    row("keychain.status", Domain::Inline, LEGACY),
    row("learning.delete_rule", Domain::Learning, LEGACY),
    row("learning.export", Domain::Learning, LEGACY),
    row("learning.import", Domain::Learning, LEGACY),
    row("learning.record_correction", Domain::Learning, LEGACY),
    row("learning.rules", Domain::Learning, LEGACY),
    row("learning.save_rule", Domain::Learning, LEGACY),
    row("learning.stats", Domain::Learning, LEGACY),
    row("lifecycle.dismiss", Domain::Lifecycle, LEGACY),
    row("lifecycle.mark_seen", Domain::Lifecycle, LEGACY),
    row("lifecycle.sync", Domain::Lifecycle, LEGACY),
    row("list_cached_uids", Domain::Cache, ONE_ROW),
    row("list_local_folders", Domain::Mbox, MBOX_OPTIONS),
    row("llm.cancel_download", Domain::Inline, LEGACY),
    row("llm.classify", Domain::Inline, LEGACY),
    row("llm.delete_model", Domain::Inline, LEGACY),
    row("llm.download", Domain::Inline, LEGACY),
    row("llm.list_models", Domain::Inline, LEGACY),
    row("llm.load", Domain::Inline, LEGACY),
    row("llm.status", Domain::Inline, LEGACY),
    row("llm.unload", Domain::Inline, LEGACY),
    row("load_email_cache", Domain::Cache, WHOLE_MAILBOX),
    row("load_email_cache_by_uids", Domain::Cache, ONE_ROW).foreground(),
    row("load_email_cache_meta", Domain::Cache, ONE_ROW),
    row("load_email_cache_partial", Domain::Cache, ONE_ROW).foreground(),
    row("load_email_cache_window", Domain::Cache, ONE_ROW).foreground(),
    row("load_graph_id_map", Domain::Cache, ONE_ROW),
    row("load_mailbox_cache", Domain::Cache, ONE_ROW),
    row("local_index_append", Domain::Custody, ONE_ROW),
    row("local_index_read", Domain::Custody, ONE_ROW),
    row("local_index_remove", Domain::Custody, ONE_ROW),
    row("logs.set_verbosity", Domain::Daemon, LEGACY),
    row("mail_search_cancel", Domain::MailSearch, ONE_ROW),
    row("mail_search_start", Domain::MailSearch, ONE_ROW).foreground(),
    row("mailboxes.load", Domain::Mailboxes, LEGACY),
    row("maildir_clear_cache", Domain::VaultFiles, VAULT_WIDE),
    row("maildir_delete", Domain::VaultFiles, ONE_ROW).foreground(),
    row("maildir_delete_many", Domain::Custody, ONE_ROW).foreground(),
    row("maildir_exists", Domain::VaultFiles, ONE_ROW),
    row("maildir_list", Domain::VaultFiles, WHOLE_MAILBOX),
    row("maildir_migrate_email_dirs", Domain::VaultFiles, VAULT_WIDE),
    row("maildir_migrate_json_to_eml", Domain::VaultFiles, VAULT_WIDE),
    row("maildir_orphan_stats", Domain::VaultFiles, ONE_ROW),
    row("maildir_purge_orphans", Domain::Custody, VAULT_WIDE),
    row("maildir_read", Domain::VaultFiles, ONE_ROW).foreground(),
    row("maildir_read_attachment", Domain::VaultFiles, MESSAGE_DOWNLOAD).foreground(),
    row("maildir_read_attachments", Domain::VaultFiles, MESSAGE_DOWNLOAD).foreground(),
    row("maildir_read_light", Domain::VaultFiles, ONE_ROW).foreground(),
    row("maildir_read_light_batch", Domain::VaultFiles, WHOLE_MAILBOX).foreground(),
    row("maildir_read_raw_source", Domain::VaultFiles, MESSAGE_DOWNLOAD).foreground(),
    row("maildir_repair_generation", Domain::Custody, ONE_ROW),
    row("maildir_set_flags", Domain::VaultFiles, ONE_ROW).foreground(),
    row("maildir_storage_stats", Domain::VaultFiles, WHOLE_MAILBOX),
    row("maildir_store", Domain::VaultFiles, ONE_ROW),
    row("mbox_probe", Domain::Mbox, MBOX_OPTIONS),
    row("mbox_upload_cancel", Domain::Mbox, MBOX_OPTIONS),
    row("mbox_upload_discard", Domain::Mbox, MBOX_OPTIONS),
    row("mbox_upload_pause", Domain::Mbox, MBOX_OPTIONS),
    row("mbox_upload_resume", Domain::Mbox, MBOX_OPTIONS),
    row("mbox_upload_status", Domain::Mbox, MBOX_OPTIONS),
    row("message.code", Domain::Message, LEGACY),
    row("message.verify_sender", Domain::Message, LEGACY),
    row("messages.restore", Domain::Deleted, MESSAGES_RESTORE).foreground(),
    row("net.activity", Domain::NetActivity, LEGACY),
    row("net.geo", Domain::NetActivity, LEGACY),
    row("net.probe", Domain::Inline, LEGACY),
    row("net.report", Domain::Inline, LEGACY),
    row("net.retention", Domain::NetActivity, LEGACY),
    row("net.set_retention", Domain::NetActivity, LEGACY),
    row("net.status", Domain::Inline, LEGACY),
    row("net.summary", Domain::NetActivity, LEGACY),
    row("notes.list", Domain::Notes, LEGACY),
    row("notes.set_done", Domain::Notes, LEGACY),
    row("notify.arrival", Domain::Notify, SETTINGS),
    row("notify.decide", Domain::Notify, SETTINGS),
    row("oauth2_auth_url", Domain::Oauth2, LEGACY),
    row("oauth2_exchange", Domain::Oauth2, LEGACY),
    row("oauth2_google_clients", Domain::Oauth2, LEGACY),
    row("oauth2_microsoft_personal", Domain::Oauth2, LEGACY),
    row("oauth2_refresh", Domain::Oauth2, LEGACY),
    row("op_journal_clear", Domain::Journal, ONE_ROW),
    row("op_journal_queue", Domain::Journal, ONE_ROW),
    row("op_journal_read", Domain::Journal, ONE_ROW),
    row("pause_migration", Domain::Migration, MIGRATION_CONTROL),
    row("people.contacts.names", Domain::People, LEGACY).mail_dir(),
    row("people.contacts.search", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.contacts.top", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.create", Domain::People, LEGACY).mail_dir(),
    row("people.delete", Domain::People, LEGACY).mail_dir(),
    row("people.export_vcf", Domain::People, LEGACY).mail_dir(),
    row("people.get", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.import_vcf", Domain::People, LEGACY).mail_dir(),
    row("people.journal", Domain::People, LEGACY).mail_dir(),
    row("people.list", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.merge", Domain::People, LEGACY).mail_dir(),
    row("people.merge_preview", Domain::People, LEGACY).mail_dir(),
    row("people.messages", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.owners", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.proposals", Domain::People, LEGACY).mail_dir(),
    row("people.review.accept", Domain::People, LEGACY).mail_dir(),
    row("people.review.dismiss", Domain::People, LEGACY).mail_dir(),
    row("people.review.list", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.senders", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.split", Domain::People, LEGACY).mail_dir(),
    row("people.stats", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.suggest", Domain::People, LEGACY).foreground().mail_dir(),
    row("people.undo", Domain::People, LEGACY).mail_dir(),
    row("people.update", Domain::People, LEGACY).mail_dir(),
    row("pgp.import_key", Domain::Pgp, LEGACY),
    row("pgp.list_keys", Domain::Pgp, LEGACY),
    row("pgp.remove_key", Domain::Pgp, LEGACY),
    row("ping", Domain::Daemon, PING),
    row("pipeline.focus", Domain::Inline, secs(30)).strict(),
    row("pipeline.status", Domain::Inline, secs(30)).strict(),
    row("policy.accounts", Domain::Policy, LEGACY),
    row("policy.vault_mailboxes", Domain::Policy, LEGACY),
    row("portable.change_passphrase", Domain::Portable, LEGACY),
    row("portable.create", Domain::Portable, LEGACY),
    row("portable.estimate", Domain::Portable, LEGACY),
    row("portable.get_credentials", Domain::Portable, LEGACY),
    row("portable.lock", Domain::Portable, LEGACY),
    row("portable.set_credentials", Domain::Portable, LEGACY),
    row("portable.status", Domain::Portable, LEGACY),
    row("portable.unlock", Domain::Portable, LEGACY),
    row("prefetch_attachments", Domain::VaultFiles, VAULT_WIDE),
    row("read_pending_operation", Domain::Journal, ONE_ROW),
    #[cfg(feature = "blitz-render")]
    row("render.close", Domain::Blitz, RENDER_QUICK),
    #[cfg(feature = "blitz-render")]
    row("render.fold", Domain::Blitz, RENDER_FRAME),
    #[cfg(feature = "blitz-render")]
    row("render.fonts", Domain::Blitz, RENDER_QUICK),
    #[cfg(feature = "blitz-render")]
    row("render.gpuStatus", Domain::Blitz, RENDER_GPU_STATUS),
    #[cfg(feature = "blitz-render")]
    row("render.hit", Domain::Blitz, RENDER_QUICK),
    #[cfg(feature = "blitz-render")]
    row("render.image", Domain::Blitz, RENDER_IMAGE),
    #[cfg(feature = "blitz-render")]
    row("render.inspect", Domain::Blitz, RENDER_FRAME),
    #[cfg(feature = "blitz-render")]
    row("render.open", Domain::Blitz, RENDER_OPEN).foreground(),
    #[cfg(feature = "blitz-render")]
    row("render.serialize", Domain::Blitz, RENDER_QUICK),
    #[cfg(feature = "blitz-render")]
    row("render.textRuns", Domain::Blitz, RENDER_FRAME).foreground(),
    #[cfg(feature = "blitz-render")]
    row("render.tile", Domain::Blitz, RENDER_FRAME).foreground(),
    row("resolve_email_settings", Domain::Dns, LEGACY),
    row("resume_migration", Domain::Migration, MIGRATION_CONTROL),
    row("save_email_cache", Domain::Cache, ONE_ROW),
    row("save_mailbox_cache", Domain::Cache, ONE_ROW),
    row("save_pending_operation", Domain::Journal, ONE_ROW),
    row("scheduled.cancel", Domain::Scheduled, LEGACY),
    row("scheduled.create", Domain::Scheduled, LEGACY),
    row("scheduled.list", Domain::Scheduled, LEGACY),
    row("scheduled.send_now", Domain::Scheduled, LEGACY),
    row("scheduled.suggest_tz", Domain::Scheduled, LEGACY),
    row("scheduled.update", Domain::Scheduled, LEGACY),
    row("search.suggest", Domain::SearchIndex, LEGACY).foreground(),
    row("search_index_configure", Domain::SearchIndex, ONE_ROW),
    row("search_index_destroy", Domain::SearchIndex, SEARCH_INDEX_DESTROY),
    row("search_index_rebuild", Domain::SearchIndex, ONE_ROW),
    row("search_index_status", Domain::SearchIndex, ONE_ROW),
    row("settings.get", Domain::Settings, SETTINGS),
    row("settings.patch", Domain::Settings, SETTINGS),
    row("settings.replace", Domain::Settings, SETTINGS),
    row("smtp_build_draft_mime", Domain::Smtp, LEGACY),
    row("smtp_build_mime", Domain::Smtp, LEGACY),
    row("smtp_send_email", Domain::Smtp, LEGACY),
    row("smtp_test_connection", Domain::Smtp, LEGACY),
    row("snapshot.create", Domain::Inline, LEGACY).mail_dir(),
    row("snapshot.create_from_maildir", Domain::Inline, LEGACY).mail_dir(),
    row("snapshot.delete", Domain::Inline, LEGACY).mail_dir(),
    row("snapshot.list", Domain::Inline, LEGACY).mail_dir(),
    row("snapshot.load", Domain::Inline, LEGACY).mail_dir(),
    row("snooze.cancel", Domain::Snooze, LEGACY),
    row("snooze.create", Domain::Snooze, LEGACY),
    row("snooze.ensure_folder", Domain::Snooze, LEGACY),
    row("snooze.list", Domain::Snooze, LEGACY),
    row("snooze.reschedule", Domain::Snooze, LEGACY),
    row("start_migration", Domain::Migration, MIGRATION_CONTROL),
    row("start_restore", Domain::Restore, MIGRATION_CONTROL),
    row("storage.body_indexed_uids", Domain::SearchIndex, LEGACY),
    row("storage.fetch_mode_changed", Domain::Inline, LEGACY),
    row("storage_format_cancel", Domain::StorageFormat, LEGACY),
    row("storage_format_convert", Domain::StorageFormat, LEGACY),
    row("storage_format_get", Domain::StorageFormat, LEGACY),
    row("storage_format_pause", Domain::StorageFormat, LEGACY),
    row("storage_format_purge_retired", Domain::StorageFormat, LEGACY),
    row("storage_format_resume", Domain::StorageFormat, LEGACY),
    row("storage_format_retired", Domain::StorageFormat, LEGACY),
    row("storage_reclaim_space", Domain::StorageFormat, LEGACY),
    row("sync.context", Domain::Inline, secs(30)).strict().mail_dir(),
    row("sync.events", Domain::Inline, LEGACY).mail_dir(),
    row("sync.now", Domain::Inline, LEGACY).mail_dir(),
    row("sync.probe", Domain::Inline, secs(30)).strict().mail_dir(),
    row("sync.refresh", Domain::Inline, secs(30)).strict().mail_dir(),
    row("sync.refresh_status", Domain::Inline, secs(30)).strict(),
    row("sync.status", Domain::Inline, LEGACY).mail_dir(),
    row("sync.unwatch", Domain::Inline, LEGACY).mail_dir(),
    row("sync.wait", Domain::Inline, LEGACY).mail_dir(),
    row("sync.watch", Domain::Inline, LEGACY).mail_dir(),
    row("sync.watch_status", Domain::Inline, LEGACY).mail_dir(),
    row("tags.assign", Domain::Tags, LEGACY),
    row("tags.delete", Domain::Tags, LEGACY),
    row("tags.ensure", Domain::Tags, LEGACY),
    row("tags.for_messages", Domain::Tags, LEGACY),
    row("tags.list", Domain::Tags, LEGACY),
    row("tags.migrate_legacy", Domain::Tags, LEGACY),
    row("tags.rename", Domain::Tags, LEGACY),
    row("tags.set_color", Domain::Tags, LEGACY),
    row("tags.unassign", Domain::Tags, LEGACY),
    row("transfer.apply_config", Domain::Transfer, LEGACY),
    row("transfer.decrypt", Domain::Transfer, LEGACY),
    row("transfer.export", Domain::Transfer, LEGACY),
    row("transfer.phone_qr", Domain::Transfer, LEGACY),
    row("unsubscribe", Domain::Unsubscribe, LEGACY),
    row("unsubscribe.history", Domain::Unsubscribe, LEGACY),
    row("unsubscribe.senders", Domain::Unsubscribe, LEGACY),
    row("vault_adopt", Domain::Vault, LEGACY),
    row("vault_adopt_mailbox_dirs", Domain::VaultFlags, VAULT_WIDE),
    row("vault_apply_flags", Domain::VaultFlags, VAULT_WIDE),
    row("vault_close", Domain::SearchIndex, VAULT_CLOSE),
    row("vault_gap_count", Domain::Backup, VAULT_GAP_COUNT),
    row("vault_gap_save", Domain::Backup, MBOX_OPTIONS),
    row("vault_get_status", Domain::Vault, LEGACY),
    row("vault_light_rows", Domain::VaultFiles, WHOLE_MAILBOX),
    row("vault_move_finalize", Domain::Vault, LEGACY),
    row("vault_move_to", Domain::Vault, LEGACY),
    row("vault_move_to_default", Domain::Vault, LEGACY),
    row("vault_rebind_uids", Domain::Custody, ONE_ROW),
    row("vault_rename_mailbox", Domain::VaultFlags, VAULT_WIDE),
    row("vault_reopen", Domain::SearchIndex, LEGACY),
    row("vault_reparse_rows", Domain::SearchIndex, LEGACY),
    row("vault_rows", Domain::SearchIndex, ONE_ROW).foreground(),
    row("vault_search", Domain::SearchIndex, ONE_ROW).foreground(),
    row("vault_uid_sets", Domain::VaultFiles, WHOLE_MAILBOX),
    row("verify_archived_emails", Domain::Archive, BIG_READ),
    row("views.counts", Domain::Views, LEGACY),
    row("views.delete", Domain::Views, LEGACY),
    row("views.evaluate", Domain::Views, LEGACY).foreground(),
    row("views.export_attachments", Domain::Views, LEGACY),
    row("views.hidden_members", Domain::Views, LEGACY),
    row("views.keyword_detail", Domain::Views, LEGACY).foreground(),
    row("views.keywords", Domain::Views, LEGACY).foreground(),
    row("views.list", Domain::Views, LEGACY),
    row("views.reorder", Domain::Views, LEGACY),
    row("views.save", Domain::Views, LEGACY),
    row("views.senders", Domain::Views, LEGACY).foreground(),
    row("views.suggest_senders", Domain::Views, LEGACY),
    row("views.suggest_terms", Domain::Views, LEGACY),
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
        "people.senders",
        "people.owners",
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
        let rows: Vec<serde_json::Value> = serde_json::from_str(&read("methods.json")).expect("methods.json is a JSON array");
        let json: Vec<(String, Budget)> = rows.iter().map(json_row).collect();
        let names_in_json: Vec<&str> = json.iter().map(|(n, _)| n.as_str()).collect();
        let mut sorted = names_in_json.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(names_in_json, sorted, "methods.json must be sorted without duplicates");
        // The blitz rows exist only with the feature; the list always carries them.
        let json: Vec<(String, Budget)> = json.into_iter().filter(|(n, _)| cfg!(feature = "blitz-render") || !n.starts_with("render.")).collect();
        let table: Vec<(String, Budget)> = METHODS.iter().map(|m| (m.name.to_owned(), m.reply)).collect();
        if json != table {
            let want: Vec<String> = METHODS.iter().map(|m| {
                let secs = match m.reply { Budget::Secs(s) => s.to_string(), Budget::Unbounded => "null".into() };
                format!("  {{\"name\": \"{}\", \"replySecs\": {secs}}}", m.name)
            }).collect();
            panic!("methods.json differs from METHODS; with the blitz-render feature on, it should read:\n[\n{}\n]", want.join(",\n"));
        }
    }

    /// One `methods.json` row: exactly `name` and `replySecs`, the budget
    /// written out even when there is none (`null`), so a row without one is
    /// an error rather than a silent "no budget".
    fn json_row(row: &serde_json::Value) -> (String, Budget) {
        let obj = row.as_object().unwrap_or_else(|| panic!("methods.json row is not an object: {row}"));
        let name = obj.get("name").and_then(|n| n.as_str()).unwrap_or_else(|| panic!("methods.json row without a name: {row}"));
        let reply = match obj.get("replySecs") {
            None => panic!("methods.json: {name} has no replySecs (write null for no budget)"),
            Some(serde_json::Value::Null) => Budget::Unbounded,
            Some(v) => Budget::Secs(v.as_u64().unwrap_or_else(|| panic!("methods.json: {name} replySecs is not whole seconds: {v}"))),
        };
        assert_eq!(obj.len(), 2, "methods.json: {name} has keys other than name and replySecs");
        (name.to_owned(), reply)
    }

    #[test]
    fn a_methods_json_row_without_a_budget_is_refused() {
        assert_eq!(json_row(&serde_json::json!({"name": "a.b", "replySecs": null})).1, Budget::Unbounded);
        assert_eq!(json_row(&serde_json::json!({"name": "a.b", "replySecs": 7})).1, Budget::Secs(7));
        assert!(std::panic::catch_unwind(|| json_row(&serde_json::json!({"name": "a.b"}))).is_err());
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
