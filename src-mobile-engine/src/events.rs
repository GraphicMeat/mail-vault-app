//! What the engine pushes to the shell. The shell installs one sink with
//! [`Engine::set_event_sink`](crate::Engine::set_event_sink) and forwards each event to the page.
//! Payloads carry ids, paths and counts only: never a secret, never core's error text.

use serde_json::Value;

/// `{accountId, folder, added, removed, updated, listGen}`: a sync pass changed a folder's rows.
pub const FOLDER_CHANGED: &str = "mobile.folder.changed";
/// `{accountId}`: the account's folder list or a folder's counts changed.
pub const FOLDERS_CHANGED: &str = "mobile.folders.changed";
/// `{accountId, state: "idle"|"syncing"|"error", code?}`; `code` is an accounts error code.
pub const SYNC_STATE: &str = "mobile.sync.state";

/// `{seq, accountId, outcome: "done"|"dropped"|"retrying", reason?}`: one replay attempt at a
/// journaled action ended. `reason` is `GONE` or `FOLDER_GONE` for `dropped`, an accounts error
/// code for `retrying`.
pub const ACTION_RESULT: &str = "mobile.action.result";

/// `{jobId, received, total}`: an attachment download moved on. Both counts are transfer-encoded
/// octets (`total` is the part's size as the server reports it), so `received` can end a little
/// off `total`.
pub const ATTACHMENT_PROGRESS: &str = "mobile.attachment.progress";
/// `{jobId, path}`: the part is whole on disk at `path` (fsynced, under its final name).
pub const ATTACHMENT_DONE: &str = "mobile.attachment.done";
/// `{jobId, code}`: the download stopped. `code` is `GONE` (the message, the part or the account
/// is no longer there), `CANCELLED`, or an accounts error code (the `.part` stays for a resume).
pub const ATTACHMENT_FAILED: &str = "mobile.attachment.failed";

/// Every event name the engine emits: the one list `events.json` must match (a test checks it) and
/// the page's `listen('…')` names are checked against.
pub const EVENTS: &[&str] = &[
    ACTION_RESULT,
    ATTACHMENT_DONE,
    ATTACHMENT_FAILED,
    ATTACHMENT_PROGRESS,
    FOLDER_CHANGED,
    FOLDERS_CHANGED,
    SYNC_STATE,
];

pub(crate) type EventSink = Box<dyn Fn(&str, Value) + Send + Sync>;
