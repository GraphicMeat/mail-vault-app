//! [`Backend`] over IMAP, through mailvault-core. One signed-in session per backend; every method
//! runs core's futures on the calling thread through [`crate::net::block_on`].

use super::{ApplyOutcome, Backend, BeforeWire, Change, FolderInfo, FolderRow, Flags, Header, Moved, RawBody, Selected, SendFail, SendOutcome, StopFlag, Window};
use crate::accounts::{load_account, map_error, Code};
use crate::actions::Kind;
use crate::db::Shared;
use crate::net::block_on;
use crate::secrets::Credential;
use crate::sync::{self, Fail};
use mailvault_core::abd::ops::Caps;
use mailvault_core::imap::{self, abd_cmds, ImapPool, ImapSession, PartInfo};
use mailvault_core::smtp::{self, OutgoingEmail};
use std::collections::{HashMap, HashSet};

/// What signing in to an account takes: core's settings and the account's secrets (kept only to
/// scrub them out of an error before that error is logged). The one place the engine builds a
/// session's settings from an account row and its stored [`Credential`]; `Fail::Gone` when the
/// account does not exist.
struct SessionConfig {
    config: imap::ImapConfig,
    secrets: Vec<String>,
    /// Gmail files what its SMTP server accepted in Sent itself.
    gmail: bool,
    /// The access token an OAuth account signs in with; `None` for a password account.
    oauth_token: Option<String>,
}

impl SessionConfig {
    /// Removes every secret from a failure's log text. Core's text names the address, never the
    /// secret; this is the belt to that brace.
    fn scrub(&self, f: Fail) -> Fail {
        scrub(&self.secrets, f)
    }
}

fn scrub(secrets: &[String], f: Fail) -> Fail {
    match f {
        Fail::Code(code, why) => Fail::Code(code, secrets.iter().fold(why, |w, s| w.replace(s.as_str(), "***"))),
        other => other,
    }
}

fn session_config(shared: &Shared, account: &str, refused: Option<&str>) -> Result<SessionConfig, Fail> {
    let Some(acct) = load_account(shared, account)? else {
        return Err(Fail::Gone);
    };
    let mut cred = match shared.secrets().get(account) {
        Ok(Some(s)) => Credential::parse(&s),
        Ok(None) => return Err(Fail::Code(Code::AuthFailed, "no secret stored for the account".into())),
        Err(e) => return Err(Fail::Code(Code::Invalid, format!("secret store: {e}"))),
    };
    if acct.auth == "oauth2" {
        // Never the stored token as is: a fresh one, refreshed when it is about to expire (and
        // refused with `Fail::auth()` once the grant is gone). `refused` is the token the server
        // just turned away, which forces a refresh unless another caller already did one.
        cred.access = Some(match refused {
            None => crate::oauth::access_token(shared, account)?,
            Some(t) => crate::oauth::access_token_after_refusal(shared, account, t)?,
        });
    }
    let config = crate::net::core_config(&acct, &cred).map_err(|e| Fail::Code(Code::Invalid, e))?;
    let gmail = acct.provider.as_deref() == Some("google") || acct.imap_host.eq_ignore_ascii_case("imap.gmail.com");
    let oauth_token = if acct.auth == "oauth2" { cred.access.clone() } else { None };
    Ok(SessionConfig { config, secrets: cred.secrets().into_iter().map(String::from).collect(), gmail, oauth_token })
}

pub(crate) struct ImapBackend {
    session: Option<ImapSession>,
    /// Outlives the session it made.
    _pool: ImapPool,
    secrets: Vec<String>,
    /// CAPABILITY, asked once per session, on the first action.
    caps: Option<Caps>,
    /// The settings the session signed in with; a send's SMTP side uses them too.
    config: imap::ImapConfig,
    gmail: bool,
}

impl ImapBackend {
    /// Signs in to `account`. An OAuth account whose token the server refuses (revoked or expired
    /// early) gets one refresh and one more try; a grant the provider refuses too ends as
    /// [`Fail::auth`].
    pub(crate) fn open(shared: &Shared, account: &str) -> Result<ImapBackend, Fail> {
        let sc = session_config(shared, account, None)?;
        match Self::sign_in(sc) {
            Err((Fail::Code(Code::AuthFailed, _), Some(token))) => {
                let sc = session_config(shared, account, Some(&token))?;
                Self::sign_in(sc).map_err(|(f, _)| f)
            }
            other => other.map_err(|(f, _)| f),
        }
    }

    /// One sign-in; a failure comes back scrubbed, with the OAuth token it used.
    fn sign_in(sc: SessionConfig) -> Result<ImapBackend, (Fail, Option<String>)> {
        let pool = ImapPool::new();
        match block_on(imap::create_imap_session(&sc.config, &pool)) {
            Ok(session) => {
                Ok(ImapBackend { session: Some(session), _pool: pool, secrets: sc.secrets, caps: None, config: sc.config, gmail: sc.gmail })
            }
            Err(e) => Err((sc.scrub(Fail::from(e)), sc.oauth_token)),
        }
    }

    fn session(&mut self) -> &mut ImapSession {
        self.session.as_mut().expect("imap session is held until drop")
    }

    /// Runs one step on the session; its failure comes back scrubbed.
    fn step<T>(&mut self, f: impl AsyncFnOnce(&mut ImapSession) -> Result<T, Fail>) -> Result<T, Fail> {
        let out = block_on(f(self.session()));
        out.map_err(|e| scrub(&self.secrets, e))
    }
}

impl Drop for ImapBackend {
    fn drop(&mut self) {
        if let Some(mut session) = self.session.take() {
            let _ = block_on(async move { session.logout().await });
        }
    }
}

fn check_validity(got: Option<u32>, folder: &FolderRow) -> Result<(), Fail> {
    if got.map(i64::from) == folder.uid_validity && got.is_some() {
        Ok(())
    } else {
        // The next pass sees the new value and wipes.
        Err(Fail::Code(Code::Invalid, format!("UIDVALIDITY of {} changed during sync", folder.path)))
    }
}

/// Core's rendering of a command the server answered with a tagged NO or BAD: async-imap's
/// `no response: …` / `bad response: …`, or core's own `… failed: No …` / `… failed: Bad …` where it
/// reads the tag itself (COPYUID, SEARCH).
fn is_tagged_refusal(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("no response:") || lower.contains("bad response:") || err.contains("failed: No ") || err.contains("failed: Bad ")
}

/// An IMAP step's failure: only the server's tagged NO or BAD (and not one the network, a
/// timeout or the sign-in explains) becomes [`ApplyOutcome::Refused`]. Anything else, including a
/// transport error whose words no needle knows, stays a failure: retried with backoff, never
/// dropped, since three of them would otherwise throw away a delete the user made.
pub(crate) fn refused_or_fail(err: String) -> Result<ApplyOutcome, Fail> {
    if map_error(&err) == Code::Invalid && is_tagged_refusal(&err) {
        Ok(ApplyOutcome::Refused(err))
    } else {
        Err(Fail::from(err))
    }
}

/// After a failed SELECT or MOVE: `Ok(true)` when `path` is really gone, which only the server's
/// answer (not the network) followed by a whole LIST (one that includes INBOX) without it proves;
/// `Ok(false)` when the server refused but still lists the folder. A network failure stays one.
async fn confirm_folder_gone(session: &mut ImapSession, path: &str, err: &str) -> Result<bool, Fail> {
    if map_error(err) != Code::Invalid || !is_tagged_refusal(err) {
        return Err(Fail::from(err.to_string()));
    }
    let boxes = imap::list_mailboxes(session).await?;
    let whole = boxes.iter().any(|b| sync::is_inbox(&b.path));
    let listed = boxes.iter().any(|b| b.path == path || (sync::is_inbox(path) && sync::is_inbox(&b.path)));
    if !whole {
        // A short LIST proves nothing either way.
        return Err(Fail::from(err.to_string()));
    }
    Ok(!listed)
}

async fn parts_in(session: &mut ImapSession, folder: &FolderRow, uid: u32) -> Result<Option<Vec<PartInfo>>, Fail> {
    let (parts, validity) = imap::fetch_parts(session, &folder.path, uid).await?;
    let Some(parts) = parts else {
        return Ok(None);
    };
    if validity.map(i64::from) != folder.uid_validity {
        return Ok(None);
    }
    Ok(Some(parts))
}

/// One body part as text: `Ok(Some(None))` when there is no such part, `Ok(None)` when the uid
/// went away between the BODYSTRUCTURE and the part.
async fn read_part(session: &mut ImapSession, folder: &str, uid: u32, part: Option<&PartInfo>) -> Result<Option<Option<String>>, Fail> {
    let Some(part) = part else {
        return Ok(Some(None));
    };
    let bytes = imap::fetch_section(session, folder, uid, &part.section).await?;
    Ok(bytes.map(|b| Some(imap::parts::decode_text(&b, part.charset.as_deref()))))
}

async fn apply_in(
    session: &mut ImapSession,
    caps: &Caps,
    folder: &FolderRow,
    kind: Kind,
    uids: &[u32],
    target: Option<&str>,
    before_wire: BeforeWire<'_>,
) -> Result<ApplyOutcome, Fail> {
    let path = folder.path.as_str();
    let mbox = match imap::select_mailbox(session, path).await {
        Ok(m) => m,
        Err(e) => {
            if confirm_folder_gone(session, path, &e).await? {
                return Ok(ApplyOutcome::FolderGone);
            }
            return Ok(ApplyOutcome::Refused(e));
        }
    };
    if let Some(v) = folder.uid_validity {
        if mbox.uid_validity.map(i64::from) != Some(v) {
            return Ok(ApplyOutcome::OtherGeneration);
        }
    }
    // Absence is proven by the server's tagged answer, never inferred: a STORE or MOVE on a uid
    // that is gone answers OK too.
    let found: HashSet<u32> = match abd_cmds::uid_search(session, path, &format!("UID {}", sync::uid_list(uids))).await {
        Ok(f) => f.into_iter().collect(),
        Err(e) => return refused_or_fail(e),
    };
    let (present, gone): (Vec<u32>, Vec<u32>) = uids.iter().partition(|u| found.contains(u));
    if present.is_empty() {
        return Ok(ApplyOutcome::NonePresent);
    }
    let mut moved = None;
    match kind {
        Kind::Seen | Kind::Unseen | Kind::Flag | Kind::Unflag => {
            let flag = if matches!(kind, Kind::Seen | Kind::Unseen) { "\\Seen" } else { "\\Flagged" };
            let op = if kind.value() == 1 { "add" } else { "remove" };
            for uid in &present {
                if let Err(e) = imap::set_flags(session, path, *uid, &[flag.to_string()], op).await {
                    return refused_or_fail(e);
                }
            }
        }
        Kind::Delete => {
            // In Trash already: a delete is permanent. Elsewhere core moves it to Trash. "Trash" is
            // the folder core's delete would move to (SPECIAL-USE, then by name), not the stored
            // `special_use`, whose name guess also matches "Trash-old": asking anything else either
            // expunges outside Trash or moves a message onto itself. A LIST failure is a `Fail`.
            let trash = imap::resolve_trash_path(session).await?;
            let permanent = trash.as_deref() == Some(path);
            let expected = folder.uid_validity.map(|v| v as u32);
            before_wire()?;
            for uid in &present {
                match imap::delete_email_in(session, path, *uid, permanent, caps.uidplus, expected).await {
                    Ok(_) => {}
                    Err(e) if e == "errors.bulkIdentityChanged" => return Ok(ApplyOutcome::OtherGeneration),
                    Err(e) => return refused_or_fail(e),
                }
            }
        }
        Kind::Move => {
            let Some(target) = target else {
                return Ok(ApplyOutcome::FolderGone);
            };
            before_wire()?;
            match imap::move_uids(session, path, target, &present, caps.move_cmd, caps.uidplus).await {
                Ok(out) => {
                    // COPYUID pairs the source set, ascending, with the new uids in order.
                    if let Some(new) = out.new_uids.filter(|n| n.len() == present.len()) {
                        let uid_validity = abd_cmds::uid_validity(session, target).await.ok().flatten().map(i64::from);
                        moved = Some(Moved { pairs: present.iter().copied().zip(new).collect(), uid_validity });
                    }
                }
                Err(e) => {
                    if confirm_folder_gone(session, target, &e).await? {
                        return Ok(ApplyOutcome::FolderGone);
                    }
                    return Ok(ApplyOutcome::Refused(e));
                }
            }
        }
    }
    Ok(ApplyOutcome::Done { gone, moved })
}

impl Backend for ImapBackend {
    fn folders(&mut self) -> Result<Vec<FolderInfo>, Fail> {
        self.step(async |session| {
            let infos = imap::list_mailboxes(session).await?;
            let selectable: Vec<String> = infos.iter().filter(|m| !m.noselect).map(|m| m.path.clone()).collect();
            let statuses = imap::mailbox_statuses(session, &selectable).await?;
            let counts: HashMap<&str, (i64, i64)> =
                statuses.iter().map(|s| (s.path.as_str(), (s.unseen.unwrap_or(0) as i64, s.messages as i64))).collect();
            Ok(infos
                .iter()
                .map(|m| FolderInfo {
                    path: m.path.clone(),
                    name: m.name.clone(),
                    special_use: m.special_use.clone(),
                    delimiter: m.delimiter.clone(),
                    noselect: m.noselect,
                    counts: counts.get(m.path.as_str()).copied(),
                })
                .collect())
        })
    }

    fn select(&mut self, folder: &str) -> Result<Selected, Fail> {
        self.step(async |session| {
            let mbox = imap::select_mailbox(session, folder).await?;
            let validity = mbox.uid_validity.ok_or_else(|| Fail::from(format!("SELECT {folder}: no UIDVALIDITY")))?;
            Ok(Selected { uid_validity: validity as i64, uid_next: mbox.uid_next.map(i64::from), total: mbox.exists as i64 })
        })
    }

    fn window(&mut self, folder: &str, window_start_ms: i64) -> Result<Window, Fail> {
        self.step(async |session| {
            let uids = abd_cmds::uid_search(session, folder, &sync::since_criteria(window_start_ms)).await?;
            let unseen = abd_cmds::uid_search(session, folder, "UNSEEN").await?.len() as i64;
            Ok(Window { uids, unseen })
        })
    }

    fn headers(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<Header>, Fail> {
        self.step(async |session| {
            let ((headers, _), got) = imap::fetch_headers_by_uids_bound(session, &folder.path, uids).await?;
            check_validity(got, folder)?;
            Ok(headers)
        })
    }

    fn flags(&mut self, folder: &FolderRow, uids: &[u32]) -> Result<Vec<(u32, Flags)>, Fail> {
        let Some(from) = uids.iter().copied().min() else {
            // `UID FETCH n:*` on an empty mailbox is an error on some servers: ask nothing.
            return Ok(Vec::new());
        };
        let wanted: HashSet<u32> = uids.iter().copied().collect();
        self.step(async |session| {
            let (got, flags) = imap::uid_flags_from_in_generation(session, &folder.path, from).await?;
            check_validity(got, folder)?;
            Ok(flags.iter().filter(|(uid, _)| wanted.contains(uid)).map(|(uid, fl)| (*uid, Flags::of(fl))).collect())
        })
    }

    fn parts(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<Vec<PartInfo>>, Fail> {
        self.step(async |session| parts_in(session, folder, uid).await)
    }

    fn body(&mut self, folder: &FolderRow, uid: u32) -> Result<Option<RawBody>, Fail> {
        self.step(async |session| {
            let Some(parts) = parts_in(session, folder, uid).await? else {
                return Ok(None);
            };
            let (html_part, text_part) = crate::body::body_part_infos(&parts);
            let Some(html) = read_part(session, &folder.path, uid, html_part).await? else {
                return Ok(None);
            };
            let Some(text) = read_part(session, &folder.path, uid, text_part).await? else {
                return Ok(None);
            };
            Ok(Some(RawBody { parts, html, text }))
        })
    }

    fn part_range(&mut self, folder: &FolderRow, uid: u32, section: &str, offset: u64, len: u32) -> Result<Option<Vec<u8>>, Fail> {
        self.step(async |session| Ok(imap::fetch_selected_section_range(session, &folder.path, uid, section, offset, len).await?))
    }

    fn apply(
        &mut self,
        folder: &FolderRow,
        kind: Kind,
        uids: &[u32],
        target: Option<&str>,
        before_wire: BeforeWire<'_>,
    ) -> Result<ApplyOutcome, Fail> {
        let caps = match self.caps.clone() {
            Some(c) => c,
            None => {
                let c = self.step(async |session| Ok(abd_cmds::capabilities(session).await?))?;
                self.caps = Some(c.clone());
                c
            }
        };
        self.step(async |session| apply_in(session, &caps, folder, kind, uids, target, before_wire).await)
    }

    fn send(&mut self, email: &OutgoingEmail) -> Result<SendOutcome, SendFail> {
        let config = &self.config;
        let built = smtp::build_mime(config, email).map_err(|e| SendFail {
            fail: scrub(&self.secrets, Fail::Code(Code::Invalid, e)),
            may_have_sent: false,
            terminal: true,
        })?;
        // Phased: core says whether a failure came before or after the point of no return, which
        // its message text alone cannot (a connect timeout and a lost final reply read the same).
        match block_on(smtp::send_built_phased(config, email, built)) {
            Ok(sent) => Ok(SendOutcome { raw: sent.raw_rfc2822, server_saved_sent: sent.server_saved_sent || self.gmail }),
            Err(e) => Err(SendFail {
                terminal: e.permanent || smtp::is_terminal_send_error(&e.message),
                may_have_sent: e.phase == smtp::SendPhase::MayHaveSent,
                fail: scrub(&self.secrets, Fail::from(e.message)),
            }),
        }
    }

    fn file_sent(&mut self, sent: &SendOutcome) -> Result<(), Fail> {
        if sent.server_saved_sent {
            return Ok(());
        }
        self.step(async |session| {
            let sent_box = imap::ensure_sent_mailbox(session).await?;
            imap::append_email(session, &sent_box, &sent.raw, "\\Seen", None).await?;
            Ok(())
        })
    }

    fn wait_for_change(&mut self, _folder: &FolderRow, _stop: &StopFlag) -> Result<Change, Fail> {
        Err(Fail::unsupported("wait for change"))
    }
}
