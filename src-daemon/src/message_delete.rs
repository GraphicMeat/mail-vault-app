//! The one single-message delete: capture into the deleted-mail bin, remove
//! on the provider, then record where it landed or drop the capture of a
//! delete that did not happen. `imap_delete_email` (IMAP, and a JMAP account
//! through `handlers::jmap_bridge`) and `graph_delete_message` read their
//! params and call `delete_one`; nothing else writes this sequence.
//!
//! - `Mode`: what the caller asked. `Auto` resolves from the folder's role:
//!   INBOX (matched case-insensitively, RFC 3501) is a move to Trash, any
//!   other folder a permanent delete. This is the only place that rule lives:
//!   the app sends `mode` (default `auto`) and never reads a folder name.
//! - `capture_policy`: whether the bin copy is skipped, best effort or
//!   required. Required exactly when the delete is permanent and `bin` is on:
//!   the bin would be the only copy, so a capture that fails refuses the
//!   delete (`Refusal::BinCapture`, wire `CaptureFailure::wire`). The bulk
//!   paths (`handlers::archive::delete_with_config`, the purge in
//!   `bulk_worker`) share this decision only; they keep their own concurrency
//!   and progress frames.
//! - A failed remove drops a capture this call created, unless the delete was
//!   permanent: its EXPUNGE may have landed with the reply lost, and the retry
//!   finds nothing left to capture and reuses the row. A capture an earlier
//!   attempt made is never dropped here.
//! - Graph has one delete, a move to Deleted Items, so it is never permanent
//!   and its capture is at most best effort.
//!
//! IMAP removes on the priority lane (`run_uid_delete`, `priority: true`): a
//! click never queues behind a bulk run.

use crate::account_lifecycle::AccountStamp;
use crate::handlers::deleted::{self, CaptureFailure, Source};
use crate::imap::{self, pool::ImapPool, ImapConfig};
use crate::server::DaemonState;
use serde_json::Value;
use std::sync::Arc;
use tracing::{error, warn};

/// What the caller asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    /// By the folder's role (`resolve`).
    Auto,
    /// Move to the account's Trash.
    Trash,
    /// Remove for good.
    Permanent,
}

impl Mode {
    /// The RPC's `mode` (`auto` | `trash` | `permanent`); absent is `Trash`,
    /// so a caller that states no intent never destroys mail (the app always
    /// sends `auto` or more). The old `permanent` flag is not read: the app
    /// sends intent and this module decides what it means for the folder.
    pub(crate) fn from_params(params: &Value) -> Result<Mode, String> {
        match params.get("mode") {
            None | Some(Value::Null) => Ok(Mode::Trash),
            Some(Value::String(m)) => match m.as_str() {
                "auto" => Ok(Mode::Auto),
                "trash" => Ok(Mode::Trash),
                "permanent" => Ok(Mode::Permanent),
                other => Err(format!("Invalid mode: {other} (auto, trash or permanent)")),
            },
            Some(other) => Err(format!("Invalid mode: {other}")),
        }
    }

    /// `Auto` by the role of `mailbox`: INBOX (case-insensitive, RFC 3501)
    /// is a move to Trash, any other folder a permanent delete. The other
    /// modes are what they say.
    pub(crate) fn resolve(self, mailbox: &str) -> Mode {
        match self {
            Mode::Auto if mailbox.eq_ignore_ascii_case("INBOX") => Mode::Trash,
            Mode::Auto => Mode::Permanent,
            m => m,
        }
    }
}

/// Whether a delete keeps a bin copy first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapturePolicy {
    /// The caller opted out (`bin: false`).
    Skip,
    /// Kept when it can be; a failure is logged and the delete goes ahead
    /// (the server still holds the message, in Trash).
    BestEffort,
    /// The bin would be the only copy: no copy, no delete.
    Required,
}

/// `Required` exactly when the delete is permanent and `bin` is on. An
/// unresolved `Auto` may be permanent, so it is treated as one.
pub(crate) fn capture_policy(mode: Mode, bin: bool) -> CapturePolicy {
    match (mode, bin) {
        (_, false) => CapturePolicy::Skip,
        (Mode::Trash, true) => CapturePolicy::BestEffort,
        (Mode::Permanent | Mode::Auto, true) => CapturePolicy::Required,
    }
}

/// Where the message is removed. Enum dispatch: the crate has no
/// `async-trait`.
pub(crate) enum Provider<'a> {
    Imap(&'a ImapConfig),
    Jmap(&'a ImapConfig),
    Graph { message_id: &'a str, token: &'a str },
}

impl Provider<'_> {
    fn name(&self) -> &'static str {
        match self {
            Provider::Imap(_) => "imap",
            Provider::Jmap(_) => "jmap",
            Provider::Graph { .. } => "graph",
        }
    }

    /// What the delete really is on this provider: Graph only moves to
    /// Deleted Items.
    fn mode(&self, mode: Mode, mailbox: &str) -> Mode {
        match self {
            Provider::Graph { .. } => Mode::Trash,
            _ => mode.resolve(mailbox),
        }
    }

    fn source(&self, permanent: bool) -> Source<'_> {
        match self {
            Provider::Imap(config) => Source::Imap { config, permanent, priority: true },
            Provider::Jmap(config) => Source::Jmap { config },
            Provider::Graph { .. } => Source::Graph,
        }
    }
}

/// Where the message went. `trash`/`trash_uid`: the Trash folder and its uid
/// there, for an undo (both `None` for a permanent delete). `bin_id`: its bin
/// copy, for an undo the server cannot do.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Outcome {
    pub trash: Option<String>,
    pub trash_uid: Option<u32>,
    pub bin_id: Option<String>,
}

/// Why nothing was deleted.
#[derive(Debug, PartialEq)]
pub(crate) enum Refusal {
    /// The bin copy a permanent delete requires could not be kept.
    BinCapture(CaptureFailure),
    /// The provider's own error (the message is still there, or the reply was lost).
    Server(String),
}

/// What the provider did.
struct Removed {
    trash: Option<String>,
    trash_uid: Option<u32>,
    /// False when nothing changed (JMAP: already gone, or a plain delete from Trash).
    changed: bool,
}

/// Delete `uid` of `mailbox`, capture first (`capture_policy`). The account
/// stamp is taken here; `delete_one_stamped` takes one the caller holds.
pub(crate) async fn delete_one(
    state: &Arc<DaemonState>,
    provider: Provider<'_>,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    mode: Mode,
    bin: bool,
) -> Result<Outcome, Refusal> {
    let mode = provider.mode(mode, mailbox);
    let policy = capture_policy(mode, bin);
    let wants_stamp = policy != CapturePolicy::Skip || matches!(provider, Provider::Jmap(_));
    let original = if wants_stamp { state.account_lifecycle.capture(account_id).ok() } else { None };
    run(state, original, provider, account_id, mailbox, uid, mode, policy).await
}

/// `delete_one` under the account stamp `original` (`None`: the account is
/// closing or being changed).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn delete_one_stamped(
    state: &Arc<DaemonState>,
    original: Option<AccountStamp>,
    provider: Provider<'_>,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    mode: Mode,
    bin: bool,
) -> Result<Outcome, Refusal> {
    let mode = provider.mode(mode, mailbox);
    let policy = capture_policy(mode, bin);
    run(state, original, provider, account_id, mailbox, uid, mode, policy).await
}

/// The sequence, for a `mode` already resolved by `Provider::mode` (never
/// `Auto`) and the `policy` that mode and `bin` give.
#[allow(clippy::too_many_arguments)]
async fn run(
    state: &Arc<DaemonState>,
    original: Option<AccountStamp>,
    provider: Provider<'_>,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    mode: Mode,
    policy: CapturePolicy,
) -> Result<Outcome, Refusal> {
    debug_assert_ne!(mode, Mode::Auto, "the caller resolves Auto against the folder");
    let tag = provider.name();
    let permanent = mode == Mode::Permanent;
    // JMAP addresses the message through the account's ledger, which needs
    // the stamp: without one there is nothing to delete with.
    if matches!(provider, Provider::Jmap(_)) && original.is_none() && policy != CapturePolicy::Required {
        return Err(Refusal::Server(KEYCHAIN_BUSY.into()));
    }

    let binned = match policy {
        CapturePolicy::Skip => None,
        CapturePolicy::BestEffort | CapturePolicy::Required => {
            let captured = match &original {
                Some(stamp) => deleted::capture_stamped(state, stamp.clone(), account_id, mailbox, uid, provider.source(permanent)).await,
                None => Err(CaptureFailure::Busy),
            };
            match captured {
                Ok(binned) => binned,
                Err(e) if policy == CapturePolicy::Required => {
                    error!("[delete:{tag}] {account_id}/{mailbox} uid={uid} not deleted: could not keep a copy first: {e}");
                    return Err(Refusal::BinCapture(e));
                }
                Err(e) => {
                    warn!("[delete:{tag}] {account_id}/{mailbox} uid={uid} goes ahead without a bin copy (the server keeps it): {e}");
                    None
                }
            }
        }
    };

    let removed = match &provider {
        Provider::Imap(config) => remove_imap(state, config, mailbox, uid, permanent).await,
        Provider::Jmap(config) => match &original {
            Some(stamp) => crate::handlers::jmap_bridge::remove_for_delete(state, config, stamp, account_id, mailbox, uid, permanent)
                .await
                .map(|(trash, trash_uid, changed)| Removed { trash, trash_uid, changed }),
            None => Err(KEYCHAIN_BUSY.into()),
        },
        Provider::Graph { message_id, token } => mailvault_core::graph::GraphClient::new(token)
            .delete_message(message_id)
            .await
            .map(|()| Removed { trash: None, trash_uid: None, changed: true }),
    };

    match removed {
        Ok(removed) => {
            let bin_id = match binned {
                // Nothing changed on the server: no delete to undo.
                Some((id, true)) if !removed.changed => {
                    forget(state, id, original.clone()).await;
                    None
                }
                other => other.map(|(id, _)| id),
            };
            // Graph has no Trash folder or uid to record.
            if let (Some(id), Some(stamp), true, false) = (bin_id.clone(), original, removed.changed, matches!(provider, Provider::Graph { .. })) {
                deleted::landed_stamped(state, id, removed.trash.clone(), removed.trash_uid, stamp).await;
            }
            Ok(Outcome { trash: removed.trash, trash_uid: removed.trash_uid, bin_id })
        }
        Err(e) => {
            error!("[delete:{tag}] {account_id}/{mailbox} uid={uid} failed: {e}");
            if let Some((id, true)) = binned.filter(|_| !permanent) {
                forget(state, id, original).await;
            }
            Err(Refusal::Server(e))
        }
    }
}

const KEYCHAIN_BUSY: &str = "errors.keychainBusy";

async fn forget(state: &Arc<DaemonState>, id: String, original: Option<AccountStamp>) {
    if let Some(stamp) = original {
        deleted::forget_stamped(state, id, stamp).await;
    }
}

/// `imap::delete_email` on the priority lane.
///
/// `run_uid_delete`, not `with_priority`: a pooled socket the peer closed
/// while it sat idle fails this before the SELECT lands, and the frontend
/// restores the row it had already taken out, a delete that reads as a
/// message coming back from the dead. See the pool's own doc for why a
/// uid-addressed delete is the one mutation safe to re-send. Capabilities are
/// cached when a session is CREATED, so they are read inside the closure,
/// after checkout. `pool_ref`/`acct` are bound outside the closure because
/// `run_uid_delete` wants `Fn`, not `FnOnce` (the dead-socket retry can call
/// it twice).
async fn remove_imap(state: &Arc<DaemonState>, account: &ImapConfig, mailbox: &str, uid: u32, permanent: bool) -> Result<Removed, String> {
    let pool_ref: &ImapPool = &state.imap_pool;
    let acct = account;
    state
        .imap_pool
        .run_uid_delete(account, true, |mut session| {
            let mailbox = mailbox.to_string();
            async move {
                let has_uidplus = pool_ref.has_capability(acct, "UIDPLUS").await;
                let outcome = imap::delete_email(&mut session, &mailbox, uid, permanent, has_uidplus)
                    .await
                    .map_err(|e| format!("Failed to delete email: {}", e))?;
                Ok((outcome, session, Some(mailbox)))
            }
        })
        .await
        .map(|outcome| Removed { trash: outcome.trash, trash_uid: outcome.trash_uid, changed: true })
}

#[cfg(test)]
mod tests;
