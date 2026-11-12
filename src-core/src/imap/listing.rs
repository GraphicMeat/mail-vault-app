//! LIST replies and role mailbox lookup.

use super::{unescape_quoted, ImapSession};
use futures::StreamExt;

pub(super) struct ListedName {
    pub name: String,
    pub delimiter: Option<String>,
    pub attrs: Vec<String>,
}

/// Run a LIST and collect its names, failing on the first stream error.
///
/// Every item must be checked. `filter_map(Result::ok)` here turned a socket
/// that died mid-LIST into `Ok(vec![])` — a broken pipe reported as "this server
/// has no folders", which no caller can tell from the real thing. The frontend
/// raised "Server returned empty folder list unexpectedly" and kept showing
/// cached folders; `ensure_role_mailbox` would have created a duplicate
/// Archive/Trash instead of finding the existing one.
pub(super) async fn list_names(session: &mut ImapSession) -> Result<Vec<ListedName>, String> {
    let names_stream = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| format!("LIST failed: {}", e))?;

    let names = names_stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("LIST stream failed: {}", e))?
        .into_iter()
        .map(|name| ListedName {
            name: name.name().to_string(),
            delimiter: name.delimiter().map(str::to_string),
            attrs: name.attributes().iter().map(|attr| format!("{attr:?}")).collect(),
        })
        .collect::<Vec<_>>();

    // A socket that dies mid-LIST does not yield an error item — the stream
    // simply ends, so EOF and "the server said nothing" are the same thing here.
    // An authenticated account always has at least INBOX, so zero names is never
    // a real answer; reporting it as one is what produced "Server returned empty
    // folder list unexpectedly" while the pool was still holding a broken pipe.
    // "connection lost" makes the pool discard this session and retry the read
    // on a fresh connection.
    if names.is_empty() {
        return Err("LIST failed: connection lost (the reply ended before any mailbox)".to_string());
    }
    Ok(names)
}

/// Why `ensure_role_mailbox` came back without a folder. `Refused`: the
/// server answered CREATE with a tagged NO or BAD and will say the same again
/// (another namespace, no permission, a hidden name, no hierarchy to nest
/// under). `Failed`: it did not answer (LIST, a dropped connection).
pub(super) enum RoleMailboxError {
    Refused(String),
    Failed(String),
}

impl From<RoleMailboxError> for String {
    fn from(e: RoleMailboxError) -> String {
        match e {
            RoleMailboxError::Refused(m) | RoleMailboxError::Failed(m) => m,
        }
    }
}

fn create_error(e: async_imap::error::Error, message: String) -> RoleMailboxError {
    match e {
        async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_) => RoleMailboxError::Refused(message),
        _ => RoleMailboxError::Failed(message),
    }
}

/// The names a Trash folder goes by on a server that declares none (no
/// SPECIAL-USE), in the order `delete_email_in` tries them.
pub const TRASH_CANDIDATES: &[&str] = &["Trash", "Deleted Items", "Deleted", "[Gmail]/Trash"];

/// The lookup half of `ensure_role_mailbox`, over LIST entries `(path, attrs)`
/// (`attrs` as the `{:?}` of each name attribute): the first folder with an
/// attribute containing `attr_substring`, else the first candidate by whole
/// path, then by its last `/` or `.` segment, case-insensitive. `None` is
/// where `ensure_role_mailbox` would CREATE one.
pub fn find_role_mailbox(entries: &[(String, Vec<String>)], attr_substring: &str, candidates: &[&str]) -> Option<String> {
    for (path, attrs) in entries {
        if attrs.iter().any(|a| a.to_lowercase().contains(attr_substring)) {
            return Some(path.clone());
        }
    }
    for cand in candidates {
        if let Some((path, _)) = entries.iter().find(|(p, _)| p.eq_ignore_ascii_case(cand)) {
            return Some(path.clone());
        }
        if let Some((path, _)) = entries.iter().find(|(p, _)| {
            p.rsplit_once(|c: char| c == '/' || c == '.').map(|(_, t)| t).unwrap_or(p)
                .eq_ignore_ascii_case(cand)
        }) {
            return Some(path.clone());
        }
    }
    None
}

fn role_entries(names: &[ListedName]) -> Vec<(String, Vec<String>)> {
    names
        .iter()
        .map(|n| {
            (unescape_quoted(&n.name), n.attrs.clone())
        })
        .collect()
}

/// The folder a non-permanent `delete_email_in` moves to, by the same lookup.
/// `None` when it would CREATE one. Never CREATEs. A caller deciding whether a
/// delete is permanent ("already in Trash") asks this, so it never moves a
/// message onto itself.
pub async fn resolve_trash_path(session: &mut ImapSession) -> Result<Option<String>, String> {
    let names = list_names(session).await?;
    Ok(find_role_mailbox(&role_entries(&names), "trash", TRASH_CANDIDATES))
}

pub(super) async fn ensure_role_mailbox(
    session: &mut ImapSession,
    attr_substring: &str,
    create_name: &str,
    candidates: &[&str],
) -> Result<String, RoleMailboxError> {
    let names = list_names(session).await.map_err(RoleMailboxError::Failed)?;
    if let Some(path) = find_role_mailbox(&role_entries(&names), attr_substring, candidates) {
        return Ok(path);
    }

    // A server whose personal namespace is `INBOX.` (Dovecot/Courier on many
    // hosts) refuses a root-level CREATE: `[CANNOT] ... NAME NOT ALLOWED`. The
    // folder then goes under INBOX, with the delimiter INBOX's LIST line gave.
    // Not NAMESPACE: imap-proto 0.16 does not parse its reply, and an untagged
    // line it cannot parse fails the session mid-command.
    let inbox_delimiter = names
        .iter()
        .find(|n| n.name.eq_ignore_ascii_case("INBOX"))
        .and_then(|n| n.delimiter.as_deref())
        .map(unescape_quoted)
        .filter(|d| !d.is_empty() && !create_name.contains(d.as_str()));
    let path = match session.create(create_name).await {
        Ok(()) => create_name.to_string(),
        Err(async_imap::error::Error::No(msg)) if inbox_delimiter.is_some() && !msg.to_uppercase().contains("ALREADYEXISTS") => {
            let nested = format!("INBOX{}{}", inbox_delimiter.unwrap_or_default(), create_name);
            tracing::warn!("[ensure_role_mailbox] CREATE '{}' refused ({}); trying '{}'", create_name, msg, nested);
            if let Err(e) = session.create(&nested).await {
                let message = format!("CREATE {} failed after CREATE {} was refused ({}): {}", nested, create_name, msg, e);
                return Err(create_error(e, message));
            }
            nested
        }
        Err(e) => {
            let message = format!("CREATE {} failed: {}", create_name, e);
            return Err(create_error(e, message));
        }
    };
    let _ = session.subscribe(&path).await;
    tracing::info!("[ensure_role_mailbox] Created '{}' (no existing match for attr '{}')", path, attr_substring);
    Ok(path)
}
