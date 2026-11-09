//! The server half of a follow-up check over IMAP, on a session the caller
//! holds (the daemon's background pool, the phone's own connection).
//!
//! `UID SEARCH` with `imap::reply_search_criteria` (names the message, no
//! automatic reply) in INBOX and the special-use `\All`, `\Archive` and
//! `\Trash` folders that exist; a hit counts once a FETCH of its From shows it
//! is not the sender's own (the search cannot fold addresses). A folder other
//! than INBOX, or criteria, the server refuses are passed over; INBOX refused,
//! or a refusal it marks temporary, is a try to repeat. With every search
//! refused only a local read that found no answer (`cache_miss`) says "no
//! reply". No reply anywhere, it finds the Sent copy by Message-ID.
//!
//! Nothing is moved or flagged on the server.

use crate::app_db::follow_up::{FollowUp, Outcome};
use crate::follow_up::matcher;
use crate::imap::{self, ImapSession};
use tracing::{info, warn};

/// Look on the server for a reply to `row`'s message, from someone other than
/// `own`, and failing that for its Sent copy. `cache_miss`: the caller's local
/// read covered the account and found no answer, so a server that refuses
/// every reply search still settles the row.
///
/// `Ok((outcome, last selected mailbox))`: the session is fit to reuse.
/// `Err`: a failed command may have left unread bytes; drop the session.
pub async fn check(session: &mut ImapSession, row: &FollowUp, own: &[String], cache_miss: bool) -> Result<(Outcome, Option<String>), String> {
    let mut selected: Option<String> = None;
    let outcome = check_tracking(session, row, own, cache_miss, &mut selected).await?;
    Ok((outcome, selected))
}

async fn check_tracking(
    session: &mut ImapSession,
    row: &FollowUp,
    own: &[String],
    cache_miss: bool,
    selected: &mut Option<String>,
) -> Result<Outcome, String> {
    use Outcome::*;
    let (Some(criteria), Some(plain)) = (
        imap::reply_search_criteria(&row.message_id, true),
        imap::reply_search_criteria(&row.message_id, false),
    ) else {
        return Ok(SentCopyGone);
    };
    let boxes = imap::list_mailboxes(session).await?;
    let usable = |m: &&imap::MailboxInfo| !m.noselect;
    let with_role = |role: &str| boxes.iter().filter(usable).find(|m| m.special_use.as_deref() == Some(role)).map(|m| m.path.clone());
    let mut searched = vec!["INBOX".to_string()];
    let all = boxes.iter().filter(usable).find(|m| imap::has_attr(&m.flags, "All")).map(|m| m.path.clone());
    for path in [all, with_role("\\Archive"), with_role("\\Trash")].into_iter().flatten() {
        if !searched.iter().any(|s| s.eq_ignore_ascii_case(&path)) {
            searched.push(path);
        }
    }
    let mut answered = false;
    for mailbox in &searched {
        use imap::FolderSearch::*;
        *selected = Some(mailbox.clone());
        let mut answer = imap::uid_search_tolerant(session, mailbox, &criteria).await?;
        if let SearchRefused(why) | FolderRefused(why) = &answer {
            if matcher::temporary_refusal(why) {
                return Err(format!("{mailbox} turned the reply search away for now: {why}"));
            }
        }
        if let SearchRefused(why) = &answer {
            // The auto-reply terms are the unusual part (an empty HEADER
            // string, fields a server does not index). Without them an
            // out-of-office could count as an answer: better than no check.
            warn!("[follow-up] {mailbox} refused the reply search ({why}); asking again without the auto-reply terms");
            answer = imap::uid_search_tolerant(session, mailbox, &plain).await?;
        }
        match answer {
            Hits(found) => {
                answered = true;
                if !found.is_empty() && a_hit_from_someone_else(session, mailbox, &found, own).await? {
                    return Ok(Replied);
                }
            }
            // INBOX always exists: refusing it is the server's trouble.
            FolderRefused(why) if mailbox.eq_ignore_ascii_case("INBOX") => {
                return Err(format!("INBOX refused the SELECT: {why}"));
            }
            // A label hidden from IMAP, or criteria the server will not
            // take even without the auto-reply terms: no answer from it.
            FolderRefused(why) | SearchRefused(why) => {
                info!("[follow-up] {mailbox} refused the reply search for {} ({why})", row.id);
            }
        }
    }
    // No folder searched at all: only a local read that covered the account
    // can say "no reply". One that could not leaves the row to try again.
    if !answered && !cache_miss {
        return Err("every reply search was refused and the header cache could not answer".to_string());
    }
    // The folder the app filed the message in first; one that refuses
    // (renamed or removed since) or no longer holds the copy (the Sent
    // folder moved, the old one stayed) gives way to the server's own.
    let special_sent = with_role("\\Sent");
    let mut candidates: Vec<String> = Vec::new();
    for path in [Some(row.sent_mailbox.clone()).filter(|m| !m.is_empty()), special_sent].into_iter().flatten() {
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    }
    let (mut refused, mut answered) = (None, false);
    for sent in candidates {
        *selected = Some(sent.clone());
        match imap::message_id_uids_if_selectable(session, &sent, &row.message_id).await? {
            Some(found) => match found.iter().copied().max() {
                Some(uid) => return Ok(NoReply { sent_mailbox: sent, sent_uid: uid }),
                None => {
                    info!("[follow-up] {} holds no copy of {}; trying the server's Sent folder", sent, row.id);
                    answered = true;
                }
            },
            None => {
                info!("[follow-up] {} refused the search for {}; trying the server's Sent folder", sent, row.id);
                refused = Some(sent);
            }
        }
    }
    // A Sent folder answered and none holds it: gone. Every one refused:
    // a failure to retry, not a message gone.
    match refused {
        Some(sent) if !answered => Err(format!("{sent} refused the Message-ID search")),
        _ => Ok(SentCopyGone),
    }
}

/// Of `uids` in `mailbox`, is one from someone other than the sender (`own`,
/// folded like the app's `normalizeEmailIdentity`)? The search cannot fold a
/// Gmail address itself, so its hits are read back (at most a few dozen).
async fn a_hit_from_someone_else(session: &mut ImapSession, mailbox: &str, uids: &[u32], own: &[String]) -> Result<bool, String> {
    let newest: Vec<u32> = uids.iter().rev().take(50).copied().collect();
    let (headers, _) = imap::fetch_headers_by_uids(session, mailbox, &newest).await?;
    Ok(matcher::any_from_someone_else(headers.iter().map(|h| h.from.address.as_str()), own))
}
