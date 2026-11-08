//! The one single-message delete: capture into the deleted-mail bin, remove
//! on the provider, then record where it landed or drop the capture of a
//! delete that did not happen. `imap_delete_email` (IMAP, and a JMAP account
//! through `handlers::jmap_bridge`) and `graph_delete_message` read their
//! params and call `delete_one`; nothing else writes this sequence.
//!
//! - `Mode`: what the caller asked. `Auto` resolves by core's delete rule
//!   (`mailvault_core::actions::policy`, owner decision 1): outside Trash a
//!   move to Trash, inside Trash a permanent delete (`resolve`). Trash is the
//!   folder a move would land in (IMAP `resolve_trash_path`, one LIST; JMAP
//!   the `trash`-role mailbox of the last listing); INBOX is never Trash and
//!   asks nothing. An account with no Trash (ruling P6) keeps the old rule:
//!   INBOX moves (IMAP creates Trash, JMAP refuses), any other folder is a
//!   permanent delete, logged once per resolve (one per RPC, one per delete
//!   queue round). The app sends `mode` (default `auto`) and never reads a
//!   folder name.
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
//! - A refused IMAP move to Trash asks the folder once whether it still holds
//!   the uid (`imap::uids_present`): absent, the delete answers `gone` (an
//!   earlier move landed with its reply lost, or another client removed it)
//!   rather than an error the delete queue would retry for ever. A check
//!   that fails keeps the move's own error.
//! - A uid is a name only inside one UIDVALIDITY. The delete queue passes
//!   the generation it queued the uid in (`generation`); over IMAP every
//!   SELECT on the way (the bin capture's fetch, the remove, the
//!   still-there check) compares it, and on a mismatch (a reply with no
//!   UIDVALIDITY counts as one) nothing more is sent and the delete answers
//!   `Refusal::Renumbered`: the old uid may name another message now. A
//!   capture this call made is dropped then, permanent or not: nothing was
//!   sent. `None` (an entry with no recorded generation, every click outside
//!   the queue) is unchecked, as before. JMAP and Graph have no UIDVALIDITY
//!   and ignore it.
//!
//! IMAP removes on the priority lane (`run_uid_delete`, `priority: true`): a
//! click never queues behind a bulk run. The delete queue's background replay
//! is the one caller on the background lane (`delete_one_on`, `priority:
//! false`), for the capture's fetch and the remove alike.

use crate::account_lifecycle::AccountStamp;
use crate::handlers::deleted::{self, CaptureFailure, Source};
use crate::imap::{self, pool::ImapPool, ImapConfig};
use crate::server::DaemonState;
use mailvault_core::actions::policy::{delete_disposition, imap_trash_place, DeleteDisposition, FolderRole, TrashPlace, WithoutTrash};
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

    /// What core's rule says for `Auto` in `mailbox`, where Trash is
    /// `trash` from that folder. The other modes are what they say.
    pub(crate) fn by_rule(self, mailbox: &str, trash: TrashPlace) -> Mode {
        match self {
            Mode::Auto => match delete_disposition(FolderRole::of(mailbox, None), trash, WithoutTrash::Permanent) {
                DeleteDisposition::MoveToTrash => Mode::Trash,
                DeleteDisposition::Permanent => Mode::Permanent,
            },
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

    /// Whether this provider's capture reads the message from the server
    /// when there is no local copy (`Source::Imap` only for a permanent
    /// delete; a move to Trash keeps a byte-less row instead).
    fn asks_server(&self, permanent: bool) -> bool {
        match self {
            Provider::Imap(_) => permanent,
            Provider::Jmap(_) => true,
            Provider::Graph { .. } => false,
        }
    }

    fn source(&self, permanent: bool, priority: bool, generation: Option<u32>) -> Source<'_> {
        match self {
            Provider::Imap(config) => Source::Imap { config, permanent, priority, generation },
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
    /// The server no longer had the message: the capture asked for it and it
    /// was not there (an earlier delete landed with its reply lost, or another
    /// client removed it), and no earlier attempt kept a copy. Only a capture
    /// that asks the server can tell (a permanent IMAP delete, any JMAP one);
    /// a move to Trash over IMAP never knows and reports `false`.
    pub gone: bool,
}

/// Why nothing was deleted.
#[derive(Debug, PartialEq)]
pub(crate) enum Refusal {
    /// The bin copy a permanent delete requires could not be kept.
    BinCapture(CaptureFailure),
    /// The provider's own error (the message is still there, or the reply was lost).
    Server(String),
    /// The folder's UIDVALIDITY is not the generation the delete was queued
    /// in: the uid may name another message now, so nothing was sent.
    Renumbered,
}

/// What `imap` answers when a SELECT finds another generation than expected.
const IDENTITY_CHANGED: &str = "errors.bulkIdentityChanged";

/// Whether a SELECT that reported `selected` is outside `expected`. A
/// generation not asked for (`None`) is never outside; a reply that names
/// none is (the same rule as `imap::fetch_email_by_uid_light_timed_owned`).
fn outside(expected: Option<u32>, selected: Option<u32>) -> bool {
    expected.is_some() && selected != expected
}

/// What the provider did.
struct Removed {
    trash: Option<String>,
    trash_uid: Option<u32>,
    /// False when nothing changed (JMAP: already gone, or a plain delete from Trash).
    changed: bool,
}

/// What the delete of a message in `mailbox` really is on `provider`, never
/// `Auto`: Graph only moves to Deleted Items (its DELETE), whatever `mode`
/// says; `Auto` elsewhere by core's rule (`Mode::by_rule`), asking the
/// server where Trash is unless `mailbox` is INBOX. A lookup that fails is a
/// `Refusal::Server`: nothing was sent, a retry may work. A caller deleting
/// several uids of one folder resolves once and passes the result down.
pub(crate) async fn resolve(state: &Arc<DaemonState>, provider: &Provider<'_>, account_id: &str, mailbox: &str, mode: Mode, priority: bool) -> Result<Mode, Refusal> {
    if matches!(provider, Provider::Graph { .. }) {
        return Ok(Mode::Trash);
    }
    if mode != Mode::Auto {
        return Ok(mode);
    }
    let role = FolderRole::of(mailbox, None);
    if role == FolderRole::Inbox {
        // INBOX is never Trash: every answer the lookup could give moves it.
        return Ok(Mode::Trash);
    }
    let trash = match provider {
        Provider::Imap(config) => imap_trash_place(mailbox, imap_trash_path(state, config, priority).await.map_err(Refusal::Server)?.as_deref()),
        Provider::Jmap(config) => crate::handlers::jmap_bridge::trash_place(state, config, mailbox).await.map_err(Refusal::Server)?,
        Provider::Graph { .. } => unreachable!("Graph returned above"),
    };
    let resolved = mode.by_rule(mailbox, trash);
    if trash == TrashPlace::Missing && resolved == Mode::Permanent {
        warn!("[delete:{}] {account_id}/{mailbox}: the account has no Trash folder, so this delete is permanent (a bin copy first)", provider.name());
    }
    Ok(resolved)
}

/// The folder a move to Trash lands in (`imap::resolve_trash_path`, one
/// LIST), `None` when the account has none.
async fn imap_trash_path(state: &Arc<DaemonState>, config: &ImapConfig, priority: bool) -> Result<Option<String>, String> {
    state
        .imap_pool
        .run_read(config, priority, |mut session| async move {
            let trash = imap::resolve_trash_path(&mut session).await?;
            Ok((trash, session, None))
        })
        .await
        .map_err(|e| format!("Could not find the Trash folder: {e}"))
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
    delete_one_on(state, provider, account_id, mailbox, uid, mode, bin, true, None).await
}

/// `delete_one` on the IMAP pool's priority lane (`priority`, a click) or
/// its background lane (the delete queue's replay worker), sent only into
/// the folder generation `generation` names when it names one (IMAP; see
/// the module doc). JMAP and Graph have no lanes and no generation.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn delete_one_on(
    state: &Arc<DaemonState>,
    provider: Provider<'_>,
    account_id: &str,
    mailbox: &str,
    uid: u32,
    mode: Mode,
    bin: bool,
    priority: bool,
    generation: Option<u32>,
) -> Result<Outcome, Refusal> {
    let mode = resolve(state, &provider, account_id, mailbox, mode, priority).await?;
    let policy = capture_policy(mode, bin);
    let wants_stamp = policy != CapturePolicy::Skip || matches!(provider, Provider::Jmap(_));
    let original = if wants_stamp { state.account_lifecycle.capture(account_id).ok() } else { None };
    let generation = generation.filter(|_| matches!(provider, Provider::Imap(_)));
    run(state, original, provider, account_id, mailbox, uid, mode, policy, priority, generation).await
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
    let mode = resolve(state, &provider, account_id, mailbox, mode, true).await?;
    let policy = capture_policy(mode, bin);
    run(state, original, provider, account_id, mailbox, uid, mode, policy, true, None).await
}

/// The sequence, for a `mode` already resolved by `resolve` (never
/// `Auto`) and the `policy` that mode and `bin` give, in the IMAP folder
/// generation `generation` (`None`: unchecked).
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
    priority: bool,
    generation: Option<u32>,
) -> Result<Outcome, Refusal> {
    debug_assert_ne!(mode, Mode::Auto, "the caller resolves Auto against the folder");
    let tag = provider.name();
    let permanent = mode == Mode::Permanent;
    // JMAP addresses the message through the account's ledger, which needs
    // the stamp: without one there is nothing to delete with.
    if matches!(provider, Provider::Jmap(_)) && original.is_none() && policy != CapturePolicy::Required {
        return Err(Refusal::Server(KEYCHAIN_BUSY.into()));
    }

    let mut gone = false;
    let binned = match policy {
        CapturePolicy::Skip => None,
        CapturePolicy::BestEffort | CapturePolicy::Required => {
            let captured = match &original {
                Some(stamp) => deleted::capture_stamped(state, stamp.clone(), account_id, mailbox, uid, provider.source(permanent, priority, generation)).await,
                None => Err(CaptureFailure::Busy),
            };
            match captured {
                // The fetch found another generation: nothing kept, nothing sent.
                Err(CaptureFailure::Fetch(e)) if generation.is_some() && e == IDENTITY_CHANGED => {
                    warn!("[delete:{tag}] {account_id}/{mailbox} uid={uid} not deleted: the folder was renumbered on the server since it was queued");
                    return Err(Refusal::Renumbered);
                }
                Ok(binned) => {
                    // A capture that fetched from the server and kept nothing
                    // found nothing there (`deleted::capture_stamped`).
                    gone = binned.is_none() && provider.asks_server(permanent);
                    binned
                }
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
        Provider::Imap(config) => remove_imap(state, config, mailbox, uid, permanent, priority, generation).await,
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
            Ok(Outcome { trash: removed.trash, trash_uid: removed.trash_uid, bin_id, gone })
        }
        Err(e) => {
            // A move to Trash cannot tell "already gone" from its refusal:
            // the folder can, in the generation the uid was queued in.
            let presence = match &provider {
                Provider::Imap(_) if generation.is_some() && e == IDENTITY_CHANGED => Presence::Renumbered,
                Provider::Imap(config) if !permanent => uid_presence(state, config, mailbox, uid, priority, generation).await,
                _ => Presence::Unknown,
            };
            if presence == Presence::Renumbered {
                warn!("[delete:{tag}] {account_id}/{mailbox} uid={uid} not deleted: the folder was renumbered on the server since it was queued");
                // Nothing was sent: no delete to undo, permanent or not.
                if let Some((id, true)) = binned {
                    forget(state, id, original).await;
                }
                return Err(Refusal::Renumbered);
            }
            let gone = presence == Presence::Absent;
            if gone {
                warn!("[delete:{tag}] {account_id}/{mailbox} uid={uid}: the move was refused and the folder no longer holds it: gone ({e})");
            } else {
                error!("[delete:{tag}] {account_id}/{mailbox} uid={uid} failed: {e}");
            }
            if let Some((id, true)) = binned.filter(|_| !permanent) {
                forget(state, id, original).await;
            }
            if gone {
                return Ok(Outcome { gone: true, ..Default::default() });
            }
            Err(Refusal::Server(e))
        }
    }
}

/// What the folder says of a uid a move to Trash was refused.
#[derive(Debug, PartialEq)]
enum Presence {
    /// Known not to hold it.
    Absent,
    /// Holds it, or could not be asked: not known gone.
    Unknown,
    /// Another generation than the one the uid was queued in: the question
    /// has no answer, every old uid reads as absent there.
    Renumbered,
}

/// Whether `mailbox` is known not to hold `uid` (`UID SEARCH UID`, read
/// through its tagged OK), asked only in the generation `generation` names.
/// Any failure to ask is `Unknown`: not known gone.
async fn uid_presence(state: &Arc<DaemonState>, account: &ImapConfig, mailbox: &str, uid: u32, priority: bool, generation: Option<u32>) -> Presence {
    let checked = state
        .imap_pool
        .run_read(account, priority, |mut session| {
            let mailbox = mailbox.to_string();
            async move {
                let selected = imap::select_mailbox(&mut session, &mailbox).await?;
                if outside(generation, selected.uid_validity) {
                    return Ok((None, session, Some(mailbox)));
                }
                let present = imap::uids_present(&mut session, &[uid]).await?;
                Ok((Some(present), session, Some(mailbox)))
            }
        })
        .await;
    match checked {
        Ok(None) => Presence::Renumbered,
        Ok(Some(present)) if !present.contains(&uid) => Presence::Absent,
        Ok(Some(_)) => Presence::Unknown,
        Err(e) => {
            warn!("[delete] {mailbox} uid={uid}: could not ask whether it is still there: {e}");
            Presence::Unknown
        }
    }
}

const KEYCHAIN_BUSY: &str = "errors.keychainBusy";

async fn forget(state: &Arc<DaemonState>, id: String, original: Option<AccountStamp>) {
    if let Some(stamp) = original {
        deleted::forget_stamped(state, id, stamp).await;
    }
}

/// `imap::delete_email` on the priority lane (`priority`), or the background
/// lane for the delete queue's replay.
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
///
/// `generation`: compared after the SELECT, before anything is sent; another
/// one answers exactly `IDENTITY_CHANGED`.
async fn remove_imap(state: &Arc<DaemonState>, account: &ImapConfig, mailbox: &str, uid: u32, permanent: bool, priority: bool, generation: Option<u32>) -> Result<Removed, String> {
    let pool_ref: &ImapPool = &state.imap_pool;
    let acct = account;
    state
        .imap_pool
        .run_uid_delete(account, priority, |mut session| {
            let mailbox = mailbox.to_string();
            async move {
                let has_uidplus = pool_ref.has_capability(acct, "UIDPLUS").await;
                let outcome = imap::delete_email_in(&mut session, &mailbox, uid, permanent, has_uidplus, generation)
                    .await
                    .map_err(|e| if generation.is_some() && e == IDENTITY_CHANGED { e } else { format!("Failed to delete email: {}", e) })?;
                Ok((outcome, session, Some(mailbox)))
            }
        })
        .await
        .map(|outcome| Removed { trash: outcome.trash, trash_uid: outcome.trash_uid, changed: true })
}

#[cfg(test)]
mod tests;
