//! The label semantics rule, in one place.
//!
//! JMAP mail is label-like: one email can sit in several mailboxes, and
//! `Email/set destroy` removes it from every one of them. So a delete from one
//! mailbox is a label change unless nothing else holds the email. Every delete
//! path (the bridge, `JmapOps`, bulk delete, snooze, the workers) goes through
//! `remove_from`.

use super::client::JmapClient;
use super::types::{JmapError, SetOutcome};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveOutcome {
    /// Only the mailbox's label came off; the email lives on elsewhere.
    LabelRemoved,
    /// The email now sits in Trash only.
    MovedToTrash,
    /// `Email/set destroy`: gone from the server.
    Destroyed,
    /// The email was already gone, or already out of that mailbox.
    Gone,
}

/// Remove `email_id` from `mailbox_id`, following the label rule:
/// - Delete (not `permanent`), when the email is in a mailbox other than
///   `mailbox_id` and Trash: patch `mailboxIds/<mailbox_id>: null` only.
/// - Delete otherwise: move it to Trash alone (every other label null,
///   `mailboxIds/<trash>: true`). With no Trash mailbox this is refused
///   (`JmapError::NoTrash`), never turned into a destroy.
/// - Permanent delete or expunge, when nothing but `mailbox_id` and Trash
///   holds the email: `destroy`.
/// - Permanent delete otherwise: patch `mailboxIds/<mailbox_id>: null` (and
///   `mailboxIds/<trash>: null` when it is also in Trash).
///
/// For the usual expunge from Trash (`mailbox_id` is Trash) the last two are
/// the rule's "destroy when Trash is the only mailbox left, else drop the
/// Trash label".
pub async fn remove_from(
    client: &JmapClient,
    email_id: &str,
    mailbox_id: &str,
    trash_id: Option<&str>,
    permanent: bool,
) -> Result<RemoveOutcome, JmapError> {
    let got = client.get_emails(&[email_id.to_string()], &["mailboxIds"]).await?;
    let Some(email) = got.list.first() else { return Ok(RemoveOutcome::Gone) };
    let current: Vec<String> = email["mailboxIds"]
        .as_object()
        .map(|m| m.iter().filter(|(_, v)| v.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default();
    if !current.iter().any(|m| m == mailbox_id) {
        return Ok(RemoveOutcome::Gone);
    }
    let elsewhere = current.iter().any(|m| m != mailbox_id && Some(m.as_str()) != trash_id);

    if permanent && !elsewhere {
        let out = client.destroy(&[email_id.to_string()]).await?;
        return Ok(if applied(out, email_id)? { RemoveOutcome::Destroyed } else { RemoveOutcome::Gone });
    }
    let (toggles, outcome) = if permanent || elsewhere {
        let mut toggles = vec![(mailbox_id.to_string(), false)];
        let also_in_trash = trash_id.filter(|t| *t != mailbox_id && current.iter().any(|m| m.as_str() == *t));
        if let (true, Some(trash)) = (permanent, also_in_trash) {
            toggles.push((trash.to_string(), false));
        }
        (toggles, RemoveOutcome::LabelRemoved)
    } else {
        let trash = trash_id.ok_or(JmapError::NoTrash)?;
        let mut toggles: Vec<(String, bool)> = current.iter().filter(|m| m.as_str() != trash).map(|m| (m.clone(), false)).collect();
        toggles.push((trash.to_string(), true));
        (toggles, RemoveOutcome::MovedToTrash)
    };
    let out = client.set_mailboxes(&[(email_id.to_string(), toggles)]).await?;
    Ok(if applied(out, email_id)? { outcome } else { RemoveOutcome::Gone })
}

/// Did the `/set` apply to `email_id`? `false` when the server no longer has
/// it (`notFound`); any other SetError is an error.
fn applied(out: SetOutcome, email_id: &str) -> Result<bool, JmapError> {
    if out.ok.iter().any(|id| id == email_id) {
        return Ok(true);
    }
    match out.failed.into_iter().find(|(id, _)| id == email_id) {
        Some((_, kind)) if kind == "notFound" => Ok(false),
        Some((_, kind)) => Err(JmapError::Method { kind, description: None }),
        None => Err(JmapError::Protocol("Email/set did not answer for the email".into())),
    }
}
