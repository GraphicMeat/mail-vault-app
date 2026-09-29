//! Raw IMAP commands for the Archive & delete job (`abd::imap_ops`).
//!
//! A child of `imap`, so it can call the parent's private helpers
//! (`collect_fetches_strict`, `uid_search_to_tag`, `run_checked`, ...) without
//! widening their visibility. Every command here reads its reply through the
//! tagged status: a dead socket is an error, never an empty answer, because a
//! caller that reads "empty" as "gone" is one step from deleting mail.
//!
//! Nothing here sends a plain `EXPUNGE` and nothing CREATEs a folder.

use super::{
    compress_uid_ranges, list_mailboxes, patient, quote_mailbox, run_checked, select_mailbox, uid_search_to_tag,
    uids_of, ImapSession, MailboxInfo,
};
use crate::abd::ops::Caps;

// ── Capability probe ─────────────────────────────────────────────────────────

/// MOVE, UIDPLUS and X-GM-EXT-1, asked of the connection itself: the pool's
/// capability cache is empty until a connect has filled it, and the answer
/// must be about THIS session.
pub async fn capabilities(session: &mut ImapSession) -> Result<Caps, String> {
    use async_imap::types::Capability;
    let caps = session.capabilities().await.map_err(|e| format!("CAPABILITY failed: {}", e))?;
    let has = |name: &str| caps.iter().any(|c| matches!(c, Capability::Atom(s) if s.eq_ignore_ascii_case(name)));
    Ok(Caps { uidplus: has("UIDPLUS"), move_cmd: has("MOVE"), gmail_ext: has("X-GM-EXT-1") })
}

// ── Folder roles ─────────────────────────────────────────────────────────────

/// `MailboxInfo.flags` holds the `{:?}` of the parser's `NameAttribute`:
/// `All`, `Trash`, `Extension("\\Important")`.
pub fn has_attr(flags: &[String], name: &str) -> bool {
    flags.iter().any(|f| {
        f.eq_ignore_ascii_case(name)
            || f.strip_prefix("Extension(\"")
                .and_then(|rest| rest.strip_suffix("\")"))
                .is_some_and(|attr| attr.trim_start_matches('\\').eq_ignore_ascii_case(name))
    })
}

/// The account's Trash among `boxes`: the folder the server DECLARED `\Trash`,
/// else one of the well-known names (whole path, or its last segment). Never a
/// substring guess ("Trash-old" is a folder of the user's) and never a folder
/// that cannot be selected. `None` when there is none: the job refuses to
/// delete rather than CREATE one.
pub fn resolve_trash(boxes: &[MailboxInfo]) -> Option<String> {
    let usable = |b: &&MailboxInfo| !b.noselect;
    if let Some(b) = boxes.iter().filter(usable).find(|b| has_attr(&b.flags, "Trash")) {
        return Some(b.path.clone());
    }
    for cand in ["Trash", "Deleted Items", "Deleted", "[Gmail]/Trash"] {
        if let Some(b) = boxes.iter().filter(usable).find(|b| b.path.eq_ignore_ascii_case(cand)) {
            return Some(b.path.clone());
        }
        if let Some(b) = boxes.iter().filter(usable).find(|b| {
            let last = b
                .delimiter
                .as_deref()
                .filter(|d| !d.is_empty())
                .and_then(|d| b.path.rsplit_once(d))
                .map(|(_, t)| t)
                .unwrap_or(b.path.as_str());
            last.eq_ignore_ascii_case(cand)
        }) {
            return Some(b.path.clone());
        }
    }
    None
}

/// The Trash folder's path. Never CREATEs one.
pub async fn find_trash(session: &mut ImapSession) -> Result<Option<String>, String> {
    Ok(resolve_trash(&list_mailboxes(session).await?))
}

// ── Reading ──────────────────────────────────────────────────────────────────

/// `UID SEARCH <criteria>` in `mailbox`, tag-checked: a socket that dies
/// mid-reply is an error, not "no such message".
pub async fn uid_search(session: &mut ImapSession, mailbox: &str, criteria: &str) -> Result<Vec<u32>, String> {
    select_mailbox(session, mailbox).await?;
    let mut found = patient(uid_search_to_tag(session, criteria)).await?;
    found.sort_unstable();
    found.dedup();
    Ok(found)
}

/// The folder's UIDVALIDITY as a SELECT reports it.
pub async fn uid_validity(session: &mut ImapSession, mailbox: &str) -> Result<Option<u32>, String> {
    Ok(select_mailbox(session, mailbox).await?.uid_validity)
}

// ── Reading a FETCH through its tagged status ───────────────────────────────
//
// async-imap's `uid_fetch` stream ends at the tagged reply and drops it: a
// `NO [THROTTLED]` or Gmail's bandwidth refusal reads as a FETCH that returned
// nothing. For a listing that is a folder with no messages; for a body it is a
// message that "has no content". So the job reads FETCH replies itself, up to
// and including the tag, and a refusal is an error carrying the server's text.

/// The attributes of one untagged `* n FETCH (...)` line.
#[derive(Debug, Clone, Default)]
struct FetchAttrs {
    uid: Option<u32>,
    size: Option<u32>,
    internal_date: Option<String>,
    gm_msgid: Option<u64>,
    labels: Option<Vec<String>>,
    flags: Vec<String>,
    /// BODY[] / RFC822
    body: Option<Vec<u8>>,
    /// BODY[HEADER.FIELDS (..)] / BODY[HEADER]
    header: Option<Vec<u8>>,
    /// The line carried no attribute at all: the vendored parser's lenient
    /// read of a line it could not frame.
    empty: bool,
}

/// The instant of an INTERNALDATE, zone included. `None` when it does not read.
fn internal_date_ms(text: &str) -> Option<i64> {
    let t = text.trim_end();
    // RFC 3501 date-day-fixed is space-padded ("1-Jan-2026"): pad with a zero.
    let t = match t.strip_prefix(' ') {
        Some(rest) => format!("0{rest}"),
        None => t.to_string(),
    };
    chrono::DateTime::parse_from_str(&t, "%d-%b-%Y %H:%M:%S %z").ok().map(|d| d.timestamp_millis())
}

fn attrs_of(list: &[imap_proto::types::AttributeValue<'_>]) -> FetchAttrs {
    use imap_proto::types::{AttributeValue, MessageSection, SectionPath};
    let mut a = FetchAttrs { empty: list.is_empty(), ..Default::default() };
    for v in list {
        match v {
            AttributeValue::Uid(u) => a.uid = Some(*u),
            AttributeValue::Rfc822Size(n) => a.size = Some(*n),
            AttributeValue::InternalDate(d) => a.internal_date = Some(d.to_string()),
            AttributeValue::GmailMsgId(id) => a.gm_msgid = Some(*id),
            AttributeValue::GmailLabels(l) => a.labels = Some(l.iter().map(|s| s.to_string()).collect()),
            AttributeValue::Flags(f) => {
                a.flags = f.iter().map(|s| s.to_string()).filter(|s| !s.eq_ignore_ascii_case("\\Recent")).collect()
            }
            AttributeValue::Rfc822(Some(d)) => a.body = Some(d.to_vec()),
            AttributeValue::BodySection { section: None, data: Some(d), .. } => a.body = Some(d.to_vec()),
            AttributeValue::BodySection {
                section: Some(SectionPath::Full(MessageSection::Header) | SectionPath::Part(_, Some(MessageSection::Header))),
                data: Some(d),
                ..
            } => a.header = Some(d.to_vec()),
            AttributeValue::Rfc822Header(Some(d)) => a.header = Some(d.to_vec()),
            _ => {}
        }
    }
    a
}

/// A tagged NO/BAD as text. The parser lifts a known `[ALERT]` code out of the
/// text; the throttle classifier looks for it, so it is put back.
fn refusal(
    command: &str,
    status: &imap_proto::Status,
    code: &Option<imap_proto::ResponseCode<'_>>,
    information: Option<&str>,
) -> String {
    let alert = if matches!(code, Some(imap_proto::ResponseCode::Alert)) { "[ALERT] " } else { "" };
    format!("{} failed: {:?} {}{}", command, status, alert, information.unwrap_or(""))
}

/// Run a FETCH-shaped command and return every `* n FETCH` it produced, read
/// through the tagged status. A tagged NO/BAD, a server BYE and a socket that
/// ends first are errors that keep the server's own words.
async fn fetch_to_tag(session: &mut ImapSession, command: String) -> Result<Vec<FetchAttrs>, String> {
    use imap_proto::{Response, Status};
    patient(async {
        let id = session.run_command(&command).await.map_err(|e| format!("{} failed: {}", command, e))?;
        let mut rows: Vec<FetchAttrs> = Vec::new();
        let mut bye: Option<String> = None;
        loop {
            let rd = match session.read_response().await.map_err(|e| format!("{} failed: {}", command, e))? {
                Some(rd) => rd,
                None => {
                    return Err(match bye {
                        Some(text) => format!("{} failed: connection lost (server said BYE {})", command, text),
                        None => format!("{} failed: connection lost", command),
                    })
                }
            };
            match rd.parsed() {
                Response::Done { tag, status, code, information } if *tag == id => {
                    return match status {
                        Status::Ok => Ok(rows),
                        _ => Err(refusal(&command, status, code, information.as_deref())),
                    };
                }
                Response::Fetch(_, attrs) => rows.push(attrs_of(attrs)),
                Response::Data { status: Status::Bye, information, .. } => {
                    bye = Some(information.as_deref().unwrap_or("").to_string());
                }
                _ => {}
            }
        }
    })
    .await
}

/// Every uid in the folder, ascending, with the UIDVALIDITY of the SELECT they
/// were read under. Fails when the listing comes back shorter than EXISTS: a
/// reply cut short must not read as a folder that shrank.
pub async fn list_uids(session: &mut ImapSession, mailbox: &str) -> Result<(Option<u32>, Vec<u32>), String> {
    let mbox = select_mailbox(session, mailbox).await?;
    if mbox.exists == 0 {
        // Nothing to list, and some servers refuse `1:*` on an empty folder.
        return Ok((mbox.uid_validity, Vec::new()));
    }
    let rows = fetch_to_tag(session, "UID FETCH 1:* (UID)".to_string()).await?;
    let mut uids: Vec<u32> = rows.iter().filter_map(|r| r.uid).collect();
    uids.sort_unstable();
    uids.dedup();
    if (uids.len() as u32) < mbox.exists {
        return Err(format!(
            "UID FETCH 1:* for {} returned {} UIDs but SELECT reported EXISTS={}: truncated response, refusing to report a partial list",
            mailbox,
            uids.len(),
            mbox.exists
        ));
    }
    Ok((mbox.uid_validity, uids))
}

/// One row of a scoped listing.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedRow {
    pub uid: u32,
    pub internal_ms: Option<i64>,
    pub size: u32,
    pub gm_msgid: Option<u64>,
    pub labels: Option<Vec<String>>,
}

/// Gmail's All Mail row is "unlabelled" when its X-GM-LABELS hold nothing but
/// `\Important` and `\Starred`, which say nothing about where the user filed it.
pub fn is_unlabelled(labels: &[String]) -> bool {
    labels.iter().all(|l| {
        let l = l.trim_matches('"');
        l.eq_ignore_ascii_case("\\Important") || l.eq_ignore_ascii_case("\\Starred")
    })
}

/// `UID FETCH <uids> (UID INTERNALDATE RFC822.SIZE [X-GM-MSGID [X-GM-LABELS]])`.
///
/// One attempt, one command. A refusal is an error with the server's words. A
/// reply with a row that names no uid fails the page (`page incomplete`): a
/// short listing would read as a folder with fewer messages. The caller
/// discards the session and retries a smaller page.
pub async fn list_rows(
    session: &mut ImapSession,
    mailbox: &str,
    uids: &[u32],
    gmail: bool,
    with_labels: bool,
) -> Result<Vec<ListedRow>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    select_mailbox(session, mailbox).await?;
    let mut spec = String::from("(UID INTERNALDATE RFC822.SIZE");
    if gmail {
        spec.push_str(" X-GM-MSGID");
        if with_labels {
            spec.push_str(" X-GM-LABELS");
        }
    }
    spec.push(')');
    let fetched = fetch_to_tag(session, format!("UID FETCH {} {}", compress_uid_ranges(uids), spec)).await?;

    let mut nameless = 0usize;
    let mut rows: Vec<ListedRow> = Vec::with_capacity(fetched.len());
    for f in fetched {
        let Some(uid) = f.uid else {
            // A line with attributes but none we asked for is an unsolicited
            // flag update; a line with NO attribute is one the parser could
            // not frame, and a line with our attributes but no uid is a row
            // we cannot name. Both of the latter lose a message.
            if f.empty || f.size.is_some() || f.internal_date.is_some() {
                nameless += 1;
            }
            continue;
        };
        rows.push(ListedRow {
            uid,
            internal_ms: f.internal_date.as_deref().and_then(internal_date_ms),
            size: f.size.unwrap_or(0),
            gm_msgid: f.gm_msgid,
            labels: f.labels,
        });
    }
    if nameless > 0 {
        return Err(format!(
            "abd_list_rows: {} FETCH item(s) named no UID (unparseable); page incomplete",
            nameless
        ));
    }
    rows.sort_unstable_by_key(|r| r.uid);
    rows.dedup_by_key(|r| r.uid);
    Ok(rows)
}

/// Message-IDs (normalized, no angle brackets) for `uids`, 500 per command.
/// A uid the server did not answer is absent from the result; a message with no
/// Message-ID header answers `None`.
pub async fn message_ids(
    session: &mut ImapSession,
    mailbox: &str,
    uids: &[u32],
) -> Result<Vec<(u32, Option<String>)>, String> {
    let mut out: Vec<(u32, Option<String>)> = Vec::with_capacity(uids.len());
    if uids.is_empty() {
        return Ok(out);
    }
    select_mailbox(session, mailbox).await?;
    for chunk in uids.chunks(500) {
        let command = format!("UID FETCH {} (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])", compress_uid_ranges(chunk));
        for f in fetch_to_tag(session, command).await? {
            let Some(uid) = f.uid else { continue };
            let id = f.header.as_deref().and_then(crate::maildir::message_id_in);
            out.push((uid, id));
        }
    }
    Ok(out)
}

/// The uids in `mailbox` whose Message-ID is exactly `message_id`. The server's
/// HEADER search matches a substring, so every hit is re-read and compared
/// after normalizing, and only exact matches come back. Tag-checked.
pub async fn uids_by_message_id(
    session: &mut ImapSession,
    mailbox: &str,
    message_id: &str,
) -> Result<Vec<u32>, String> {
    let term = super::message_id_search_term(message_id);
    if term.is_empty() {
        return Err("Message-ID search: empty Message-ID".to_string());
    }
    let want = crate::maildir::normalize_message_id(message_id);
    let hits = uid_search(session, mailbox, &format!("HEADER Message-ID \"{}\"", term)).await?;
    if hits.is_empty() {
        return Ok(hits);
    }
    let read = message_ids(session, mailbox, &hits).await?;
    Ok(read
        .into_iter()
        .filter(|(_, id)| id.as_deref().map(crate::maildir::normalize_message_id).as_deref() == Some(want.as_str()))
        .map(|(uid, _)| uid)
        .collect())
}

/// One message as the server holds it, unparsed.
#[derive(Debug, Clone)]
pub struct RawMessage {
    pub raw: Vec<u8>,
    pub flags: Vec<String>,
    pub internal_ms: Option<i64>,
}

/// `UID FETCH <uid> (UID FLAGS INTERNALDATE BODY.PEEK[])`.
///
/// Raw bytes are kept as they are: a message `mailparse` would choke on is
/// still archived. `Ok(None)` only when the server answered OK and no longer
/// holds the uid (proved by a tag-checked search); an OK reply with no body for
/// a uid that is still there is an error.
pub async fn fetch_raw(session: &mut ImapSession, mailbox: &str, uid: u32) -> Result<Option<RawMessage>, String> {
    select_mailbox(session, mailbox).await?;
    let rows = fetch_to_tag(session, format!("UID FETCH {} (UID FLAGS INTERNALDATE BODY.PEEK[])", uid)).await?;
    match rows.into_iter().find(|f| f.uid == Some(uid)) {
        Some(f) => {
            let raw = f.body.ok_or_else(|| format!("No body in FETCH response for UID {}", uid))?;
            Ok(Some(RawMessage {
                raw,
                flags: f.flags,
                internal_ms: f.internal_date.as_deref().and_then(internal_date_ms),
            }))
        }
        None => {
            let still = patient(uid_search_to_tag(session, &format!("UID {}", uid))).await?;
            if still.contains(&uid) {
                Err(format!("Server returned no body for UID {}, but the message is still in {}", uid, mailbox))
            } else {
                Ok(None)
            }
        }
    }
}

// ── Moving and expunging ─────────────────────────────────────────────────────

/// What a COPY/MOVE said it did (RFC 4315): the destination's UIDVALIDITY, the
/// source uids that were copied and the uids they got, position for position.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CopyUid {
    pub validity: Option<u32>,
    pub src: Vec<u32>,
    pub dst: Vec<u32>,
}

/// Run a COPY/MOVE-shaped command and keep its COPYUID whole. The tagged OK
/// carries it for COPY, an untagged `* OK [COPYUID ..]` for MOVE (RFC 6851).
/// `None` when the server sent none. `imap::run_collecting_copyuid` keeps only
/// the destination uids; the job needs the source set to know WHICH messages
/// moved, and the validity to name the destination generation.
async fn run_copyuid(session: &mut ImapSession, command: String) -> Result<Option<CopyUid>, String> {
    use imap_proto::{Response, ResponseCode, Status};
    patient(async {
        let id = session.run_command(&command).await.map_err(|e| format!("{} failed: {}", command, e))?;
        let mut got: Option<CopyUid> = None;
        let mut bye: Option<String> = None;
        loop {
            let rd = match session.read_response().await.map_err(|e| format!("{} failed: {}", command, e))? {
                Some(rd) => rd,
                None => {
                    return Err(match bye {
                        Some(text) => format!("{} failed: connection lost (server said BYE {})", command, text),
                        None => format!("{} failed: connection lost", command),
                    })
                }
            };
            match rd.parsed() {
                Response::Done { tag, status, code, information } if *tag == id => {
                    if let Some(ResponseCode::CopyUid(v, src, dst)) = code {
                        got = Some(CopyUid { validity: Some(*v), src: uids_of(src), dst: uids_of(dst) });
                    }
                    return match status {
                        Status::Ok => Ok(got),
                        _ => Err(refusal(&command, status, code, information.as_deref())),
                    };
                }
                Response::Data { code: Some(ResponseCode::CopyUid(v, src, dst)), .. } => {
                    got = Some(CopyUid { validity: Some(*v), src: uids_of(src), dst: uids_of(dst) });
                }
                Response::Data { status: Status::Bye, information, .. } => {
                    bye = Some(information.as_deref().unwrap_or("").to_string());
                }
                _ => {}
            }
        }
    })
    .await
}

/// Move `uids` out of `src` into `dst`, without ever sending an unscoped
/// expunge.
///
/// - With MOVE: `UID MOVE`.
/// - Without MOVE but with UIDPLUS: `UID COPY`, `UID STORE +FLAGS (\Deleted)`
///   and `UID EXPUNGE` of exactly these uids.
/// - Neither: refused before anything goes on the wire, because the only
///   expunge left removes every `\Deleted` message in the folder, other
///   clients' included.
///
/// Returns the COPYUID the server reported, if any.
pub async fn move_uids_scoped(
    session: &mut ImapSession,
    src: &str,
    dst: &str,
    uids: &[u32],
    has_move: bool,
    has_uidplus: bool,
) -> Result<Option<CopyUid>, String> {
    if uids.is_empty() {
        return Ok(None);
    }
    if !has_move && !has_uidplus {
        return Err("This server has neither MOVE nor UIDPLUS: refusing to delete".to_string());
    }
    select_mailbox(session, src).await?;
    let set = compress_uid_ranges(uids);
    let target = quote_mailbox(dst)?;
    if has_move {
        return run_copyuid(session, format!("UID MOVE {} {}", set, target)).await;
    }
    let copied = run_copyuid(session, format!("UID COPY {} {}", set, target)).await?;
    run_checked(session, format!("UID STORE {} +FLAGS (\\Deleted)", set), "STORE \\Deleted").await?;
    run_checked(session, format!("UID EXPUNGE {}", set), "UID EXPUNGE").await?;
    Ok(copied)
}

/// Delete exactly `uids` from `mailbox` for good: `UID STORE +FLAGS (\Deleted)`
/// on those uids, then `UID EXPUNGE` of the same set. Needs UIDPLUS (RFC 4315);
/// without it the only expunge takes every `\Deleted` message in the folder, so
/// this refuses instead.
pub async fn expunge_exact(
    session: &mut ImapSession,
    mailbox: &str,
    uids: &[u32],
    has_uidplus: bool,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    if !has_uidplus {
        return Err("UIDPLUS is required for an exact expunge; refusing to expunge".to_string());
    }
    select_mailbox(session, mailbox).await?;
    let set = compress_uid_ranges(uids);
    run_checked(session, format!("UID STORE {} +FLAGS (\\Deleted)", set), "STORE \\Deleted").await?;
    run_checked(session, format!("UID EXPUNGE {}", set), "UID EXPUNGE").await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mb(path: &str, delim: &str, flags: &[&str], noselect: bool) -> MailboxInfo {
        MailboxInfo {
            name: path.rsplit(delim).next().unwrap_or(path).to_string(),
            path: path.to_string(),
            special_use: None,
            special_use_guessed: false,
            flags: flags.iter().map(|s| s.to_string()).collect(),
            delimiter: Some(delim.to_string()),
            noselect,
            children: Vec::new(),
        }
    }

    #[test]
    fn a_declared_trash_wins_over_a_folder_named_like_one() {
        let boxes = vec![mb("Trash", "/", &[], false), mb("[Gmail]/Bin", "/", &["Trash"], false)];
        assert_eq!(resolve_trash(&boxes).as_deref(), Some("[Gmail]/Bin"));
    }

    #[test]
    fn an_extension_attribute_counts_as_declared() {
        let boxes = vec![mb("Corbeille", "/", &["Extension(\"\\\\Trash\")"], false)];
        assert_eq!(resolve_trash(&boxes).as_deref(), Some("Corbeille"));
    }

    #[test]
    fn a_folder_that_merely_contains_trash_is_not_the_trash() {
        let boxes = vec![mb("Trash-old", "/", &[], false), mb("INBOX", "/", &[], false)];
        assert_eq!(resolve_trash(&boxes), None);
    }

    #[test]
    fn a_namespaced_trash_resolves_by_its_last_segment() {
        let boxes = vec![mb("INBOX", ".", &[], false), mb("INBOX.Trash", ".", &[], false)];
        assert_eq!(resolve_trash(&boxes).as_deref(), Some("INBOX.Trash"));
    }

    #[test]
    fn an_unselectable_trash_is_skipped() {
        let boxes = vec![mb("Trash", "/", &["Trash", "NoSelect"], true)];
        assert_eq!(resolve_trash(&boxes), None);
    }

    #[test]
    fn important_and_starred_do_not_make_a_message_labelled() {
        let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_unlabelled(&l(&[])));
        assert!(is_unlabelled(&l(&["\\Important", "\\Starred"])));
        assert!(!is_unlabelled(&l(&["\\Important", "Work"])));
        assert!(!is_unlabelled(&l(&["\\Sent"])));
    }

    #[test]
    fn has_attr_reads_both_attribute_spellings() {
        let f = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(has_attr(&f(&["All"]), "All"));
        assert!(has_attr(&f(&["Extension(\"\\\\All\")"]), "all"));
        assert!(!has_attr(&f(&["Extension(\"\\\\Important\")"]), "All"));
    }
}
