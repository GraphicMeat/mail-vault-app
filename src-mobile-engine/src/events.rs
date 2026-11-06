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

/// Every event name the engine emits: the one list `events.json` must match (a test checks it) and
/// the page's `listen('…')` names are checked against.
pub const EVENTS: &[&str] = &[ACTION_RESULT, FOLDER_CHANGED, FOLDERS_CHANGED, SYNC_STATE];

pub(crate) type EventSink = Box<dyn Fn(&str, Value) + Send + Sync>;
