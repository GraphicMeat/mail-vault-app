//! Mailbox / message state for the mock server.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Message {
    pub uid: u32,
    pub flags: Vec<String>,
    /// IMAP INTERNALDATE, pre-rendered: "01-Jan-2026 12:00:00 +0000"
    pub internal_date: String,
    pub modseq: u64,
    /// Full RFC 5322 bytes. ENVELOPE / BODYSTRUCTURE / RFC822.SIZE / BODY[...]
    /// are all derived from this — fixtures stay readable .eml text.
    #[serde(with = "raw_bytes")]
    pub raw: Vec<u8>,
    /// Gmail's user labels (`X-GM-LABELS`, X-GM-EXT-1), as `STORE` left
    /// them. Left out of a serialized state while empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    /// Gmail's X-GM-MSGID: one number shared by every copy of a message across
    /// the label folders and All Mail. `None` on a server that is not Gmail.
    pub gm_msgid: Option<u64>,
}

/// An IMAP INTERNALDATE string ("01-Jan-2026 12:00:00 +0000") for an instant
/// (UTC milliseconds) shown in a zone `offset_minutes` east of UTC. The same
/// instant with two offsets is what a year-bucketing test needs: a message
/// received 2024-12-31T22:30Z is "31-Dec-2024 22:30:00 +0000" on one server
/// and "01-Jan-2025 00:30:00 +0200" on another.
pub fn internal_date_string(ms_utc: i64, offset_minutes: i32) -> String {
    use chrono::{DateTime, FixedOffset};
    let off = FixedOffset::east_opt(offset_minutes * 60).expect("offset within a day");
    let at = DateTime::from_timestamp_millis(ms_utc).expect("instant in range");
    at.with_timezone(&off).format("%d-%b-%Y %H:%M:%S %z").to_string()
}

mod raw_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&String::from_utf8_lossy(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        Ok(String::deserialize(d)?.replace("\r\n", "\n").replace('\n', "\r\n").into_bytes())
    }
}

// Hand-written so JSON scenarios that omit fields get usable values:
// a derived Default would hand out modseq 0 / an empty INTERNALDATE.
impl Default for Message {
    fn default() -> Self {
        Message {
            uid: 0,
            flags: vec![],
            internal_date: "01-Jan-2026 12:00:00 +0000".to_string(),
            modseq: 1,
            raw: Vec::new(),
            labels: Vec::new(),
            gm_msgid: None,
        }
    }
}

impl Message {
    pub fn new(uid: u32, raw: impl Into<Vec<u8>>) -> Self {
        let raw = raw.into();
        // Normalize to CRLF — IMAP literals must be network line endings, and
        // RFC822.SIZE has to match the bytes actually sent.
        let raw = String::from_utf8_lossy(&raw)
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
            .into_bytes();
        Message { uid, raw, ..Default::default() }
    }

    pub fn with_flags(mut self, flags: &[&str]) -> Self {
        self.flags = flags.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn with_modseq(mut self, modseq: u64) -> Self {
        self.modseq = modseq;
        self
    }

    pub fn with_internal_date(mut self, d: &str) -> Self {
        self.internal_date = d.to_string();
        self
    }

    /// INTERNALDATE from an instant, rendered in UTC.
    pub fn with_internal_ms(self, ms_utc: i64) -> Self {
        self.with_internal_at(ms_utc, 0)
    }

    /// INTERNALDATE from an instant, rendered in a zone `offset_minutes` east
    /// of UTC (`120` = +0200). The instant is what a client buckets by; the
    /// zone is only how this server happened to stamp it.
    pub fn with_internal_at(mut self, ms_utc: i64, offset_minutes: i32) -> Self {
        self.internal_date = internal_date_string(ms_utc, offset_minutes);
        self
    }

    pub fn with_gm_msgid(mut self, id: u64) -> Self {
        self.gm_msgid = Some(id);
        self
    }

    pub fn has_flag(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f.eq_ignore_ascii_case(flag))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Mailbox {
    pub name: String,
    /// LIST attributes, e.g. `\HasNoChildren`, `\Sent`, `\Trash`, `\Noselect`
    pub attrs: Vec<String>,
    pub uid_validity: u32,
    pub uid_next: u32,
    pub highest_modseq: u64,
    pub messages: Vec<Message>,
    /// (uid, modseq it was expunged at): what a QRESYNC SELECT reports as
    /// `VANISHED (EARLIER)` to a client that last saw an older modseq.
    pub expunged: Vec<(u32, u64)>,
}

// Likewise: a derived Default would give uid_validity 0 and uid_next 0, and a
// UIDNEXT of 0 breaks APPEND on the first message.
impl Default for Mailbox {
    fn default() -> Self {
        Mailbox::new("")
    }
}

impl Mailbox {
    pub fn new(name: &str) -> Self {
        Mailbox {
            name: name.to_string(),
            attrs: vec!["\\HasNoChildren".to_string()],
            uid_validity: 1,
            uid_next: 1,
            highest_modseq: 1,
            messages: vec![],
            expunged: vec![],
        }
    }

    pub fn with_attrs(mut self, attrs: &[&str]) -> Self {
        self.attrs = attrs.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn with_uid_validity(mut self, v: u32) -> Self {
        self.uid_validity = v;
        self
    }

    /// Append a message, assigning the next UID and bumping MODSEQ.
    pub fn push(mut self, raw: impl Into<Vec<u8>>) -> Self {
        let uid = self.uid_next;
        self.add(Message::new(uid, raw));
        self
    }

    pub fn push_msg(mut self, mut msg: Message) -> Self {
        if msg.uid == 0 {
            msg.uid = self.uid_next;
        }
        self.add(msg);
        self
    }

    pub fn add(&mut self, msg: Message) -> u32 {
        let uid = msg.uid;
        self.uid_next = self.uid_next.max(uid + 1);
        self.highest_modseq = self.highest_modseq.max(msg.modseq);
        self.messages.push(msg);
        self.messages.sort_by_key(|m| m.uid);
        uid
    }

    /// 1-based sequence number of a UID.
    pub fn seq_of(&self, uid: u32) -> Option<u32> {
        self.messages.iter().position(|m| m.uid == uid).map(|i| i as u32 + 1)
    }

    pub fn by_uid(&self, uid: u32) -> Option<&Message> {
        self.messages.iter().find(|m| m.uid == uid)
    }

    pub fn by_uid_mut(&mut self, uid: u32) -> Option<&mut Message> {
        self.messages.iter_mut().find(|m| m.uid == uid)
    }

    /// Remove these UIDs and remember when. `bump_modseq` is RFC 7162's
    /// "an expunge is a change": a QRESYNC server moves HIGHESTMODSEQ for it.
    /// Off for everything else, so a CONDSTORE-only scenario reads exactly as
    /// it did before the mock learned QRESYNC.
    pub fn expunge(&mut self, uids: &[u32], bump_modseq: bool) {
        let gone: Vec<u32> = self.messages.iter().map(|m| m.uid).filter(|u| uids.contains(u)).collect();
        if gone.is_empty() {
            return;
        }
        if bump_modseq {
            self.highest_modseq += 1;
        }
        self.messages.retain(|m| !gone.contains(&m.uid));
        let at = self.highest_modseq;
        self.expunged.extend(gone.into_iter().map(|u| (u, at)));
    }

    pub fn is_all_mail(&self) -> bool {
        self.attrs.iter().any(|a| a.eq_ignore_ascii_case("\\All"))
    }

    pub fn is_trash(&self) -> bool {
        self.attrs.iter().any(|a| a.eq_ignore_ascii_case("\\Trash"))
    }

    pub fn is_spam(&self) -> bool {
        self.attrs.iter().any(|a| a.eq_ignore_ascii_case("\\Junk"))
    }

    pub fn unseen(&self) -> u32 {
        self.messages.iter().filter(|m| !m.has_flag("\\Seen")).count() as u32
    }
}

/// Build a mailbox of `n` synthetic messages — for backfill / pagination tests.
pub fn synthetic_mailbox(name: &str, n: u32) -> Mailbox {
    let mut mb = Mailbox::new(name);
    for i in 1..=n {
        mb.add(Message::new(
            i,
            format!(
                "From: Sender {i} <sender{i}@example.com>\n\
                 To: user@example.com\n\
                 Subject: Message {i}\n\
                 Date: Thu, 01 Jan 2026 12:00:00 +0000\n\
                 Message-ID: <synthetic-{i}@example.com>\n\
                 Content-Type: text/plain; charset=UTF-8\n\
                 \n\
                 Body of message {i}.\n"
            ),
        ));
    }
    mb
}

/// `synthetic_mailbox` where the caller shapes each message (its INTERNALDATE,
/// flags, size...) from its 1-based number.
pub fn synthetic_mailbox_with(name: &str, n: u32, shape: impl Fn(u32, Message) -> Message) -> Mailbox {
    let mut mb = synthetic_mailbox(name, 0);
    for i in 1..=n {
        let msg = Message::new(
            i,
            format!(
                "From: Sender {i} <sender{i}@example.com>\n\
                 To: user@example.com\n\
                 Subject: Message {i}\n\
                 Date: Thu, 01 Jan 2026 12:00:00 +0000\n\
                 Message-ID: <synthetic-{i}@example.com>\n\
                 Content-Type: text/plain; charset=UTF-8\n\
                 \n\
                 Body of message {i}.\n"
            ),
        );
        mb.add(shape(i, msg));
    }
    mb
}

/// One message as Gmail holds it: a copy in every label folder it carries plus
/// one in All Mail, all sharing a single X-GM-MSGID (each copy has its own uid).
#[derive(Debug, Clone, Default)]
pub struct GmailMsg {
    pub raw: Vec<u8>,
    /// Folder names (`"Work"`, `"INBOX"`, `"[Gmail]/Starred"`) or Gmail system
    /// labels (`\Inbox`, `\Sent`, `\Starred`, `\Important`, `\Draft`,
    /// `\Spam`, `\Trash`). Empty = All Mail only. A Spam or Trash label puts
    /// the message in that folder alone: Gmail keeps both out of All Mail.
    pub labels: Vec<String>,
    pub flags: Vec<String>,
    /// `None` keeps the default INTERNALDATE.
    pub internal_date: Option<String>,
    /// `None` = the server hands out the next free id.
    pub gm_msgid: Option<u64>,
}

impl GmailMsg {
    pub fn new(raw: impl Into<Vec<u8>>) -> Self {
        GmailMsg { raw: raw.into(), ..Default::default() }
    }
    pub fn labels(mut self, labels: &[&str]) -> Self {
        self.labels = labels.iter().map(|s| s.to_string()).collect();
        self
    }
    pub fn flags(mut self, flags: &[&str]) -> Self {
        self.flags = flags.iter().map(|s| s.to_string()).collect();
        self
    }
    pub fn internal_date(mut self, d: &str) -> Self {
        self.internal_date = Some(d.to_string());
        self
    }
    pub fn internal_ms(mut self, ms_utc: i64) -> Self {
        self.internal_date = Some(internal_date_string(ms_utc, 0));
        self
    }
    pub fn gm_msgid(mut self, id: u64) -> Self {
        self.gm_msgid = Some(id);
        self
    }
}

pub const GMAIL_ALL_MAIL: &str = "[Gmail]/All Mail";
pub const GMAIL_TRASH: &str = "[Gmail]/Trash";
pub const GMAIL_SPAM: &str = "[Gmail]/Spam";

/// Gmail system label -> the folder that holds it. Anything else is taken as a
/// folder name already.
fn label_folder(label: &str) -> String {
    match label {
        "\\Inbox" => "INBOX",
        "\\Sent" => "[Gmail]/Sent Mail",
        "\\Starred" => "[Gmail]/Starred",
        "\\Important" => "[Gmail]/Important",
        "\\Draft" | "\\Drafts" => "[Gmail]/Drafts",
        "\\Spam" => GMAIL_SPAM,
        "\\Trash" => GMAIL_TRASH,
        other => other,
    }
    .to_string()
}

/// The label a folder shows in X-GM-LABELS: system labels for the folders that
/// have one, the folder name otherwise.
pub fn folder_label(folder: &str) -> String {
    if folder.eq_ignore_ascii_case("INBOX") {
        return "\\Inbox".to_string();
    }
    match folder {
        "[Gmail]/Sent Mail" => "\\Sent",
        "[Gmail]/Starred" => "\\Starred",
        "[Gmail]/Important" => "\\Important",
        "[Gmail]/Drafts" => "\\Draft",
        GMAIL_SPAM => "\\Spam",
        GMAIL_TRASH => "\\Trash",
        other => other,
    }
    .to_string()
}

/// The full server: a set of mailboxes plus advertised capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerState {
    pub mailboxes: Vec<Mailbox>,
    pub delimiter: String,
    pub capabilities: Vec<String>,
    /// Credentials the server accepts. `None` accepts anything.
    pub expect_login: Option<(String, String)>,
    /// What SELECT advertises as PERMANENTFLAGS, and what STORE will keep.
    /// `None` = the five system flags plus `\*` (the container is already
    /// `#[serde(default)]`, so an omitted field lands here).
    pub permanent_flags: Option<Vec<String>>,
    /// Bumped to close every connection parked in IDLE, silently, with no
    /// EXISTS for whatever changes next: a network blip as the client sees
    /// it. `Action::DropIdlers` bumps it; a Rust test can bump it in the same
    /// `mutate` that adds the message the dropped client must catch up on.
    pub idle_drops: u64,
    /// The personal namespace prefix (`INBOX.`) on a Dovecot/Courier-style
    /// server that keeps every folder under INBOX: CREATE of any other name is
    /// refused, and nothing is created. `None` = folders anywhere.
    pub personal_namespace: Option<String>,
    /// Gmail's label model: a MOVE or COPY into the `\Trash` folder takes every
    /// copy of that X-GM-MSGID out of every non-Trash, non-Spam folder (All Mail
    /// included) and leaves one in Trash; a MOVE or EXPUNGE out of a label
    /// folder removes that folder's copy only, and All Mail keeps its own.
    /// `Scenario::gmail()` turns it on.
    pub gmail: bool,
    /// The next X-GM-MSGID `add_gmail_message` hands out.
    pub next_gm_msgid: u64,
    /// A server that refuses what it did not advertise: MOVE without the MOVE
    /// capability, UID EXPUNGE without UIDPLUS, X-GM-* FETCH items without
    /// X-GM-EXT-1, and any FETCH item it does not know all answer BAD. Off by
    /// default, so scenarios that toggle capabilities keep their old, lenient
    /// behaviour (`Scenario::strict_caps()`).
    pub strict_caps: bool,
}

impl Default for ServerState {
    fn default() -> Self {
        ServerState {
            mailboxes: vec![Mailbox::new("INBOX")],
            delimiter: "/".to_string(),
            capabilities: vec![
                "IMAP4rev1".to_string(),
                "UIDPLUS".to_string(),
                "MOVE".to_string(),
                "CONDSTORE".to_string(),
                "IDLE".to_string(),
                "SPECIAL-USE".to_string(),
                "AUTH=XOAUTH2".to_string(),
            ],
            expect_login: None,
            permanent_flags: None,
            idle_drops: 0,
            personal_namespace: None,
            gmail: false,
            next_gm_msgid: 1_780_000_000_000_000_001,
            strict_caps: false,
        }
    }
}

impl ServerState {
    pub fn find(&self, name: &str) -> Option<&Mailbox> {
        self.mailboxes.iter().find(|m| m.name.eq_ignore_ascii_case(name))
    }

    pub fn find_mut(&mut self, name: &str) -> Option<&mut Mailbox> {
        self.mailboxes.iter_mut().find(|m| m.name.eq_ignore_ascii_case(name))
    }

    pub fn has_cap(&self, cap: &str) -> bool {
        self.capabilities.iter().any(|c| c.eq_ignore_ascii_case(cap))
    }

    /// Put a Gmail message into the folders its labels name plus All Mail,
    /// creating the folders that are missing. Returns its X-GM-MSGID. Works on
    /// a live server through `MockImap::mutate` (new mail arriving) as well as
    /// on a `Scenario`.
    pub fn add_gmail_message(&mut self, msg: GmailMsg) -> u64 {
        let id = msg.gm_msgid.unwrap_or_else(|| {
            let id = self.next_gm_msgid;
            self.next_gm_msgid += 1;
            id
        });
        let mut folders: Vec<String> = Vec::new();
        for l in &msg.labels {
            let f = label_folder(l);
            if !folders.iter().any(|x| x.eq_ignore_ascii_case(&f)) {
                folders.push(f);
            }
        }
        let outside_all_mail = folders
            .iter()
            .any(|f| f.eq_ignore_ascii_case(GMAIL_TRASH) || f.eq_ignore_ascii_case(GMAIL_SPAM));
        if !outside_all_mail {
            folders.push(GMAIL_ALL_MAIL.to_string());
        }
        for f in folders {
            if self.find(&f).is_none() {
                let attrs: &[&str] = match f.as_str() {
                    GMAIL_ALL_MAIL => &["\\HasNoChildren", "\\All"],
                    GMAIL_TRASH => &["\\HasNoChildren", "\\Trash"],
                    GMAIL_SPAM => &["\\HasNoChildren", "\\Junk"],
                    "[Gmail]/Sent Mail" => &["\\HasNoChildren", "\\Sent"],
                    "[Gmail]/Drafts" => &["\\HasNoChildren", "\\Drafts"],
                    "[Gmail]/Starred" => &["\\HasNoChildren", "\\Flagged"],
                    "[Gmail]/Important" => &["\\HasNoChildren", "\\Important"],
                    _ => &["\\HasNoChildren"],
                };
                self.mailboxes.push(Mailbox::new(&f).with_attrs(attrs));
            }
            let mb = self.find_mut(&f).expect("just created");
            let mut m = Message::new(mb.uid_next, msg.raw.clone());
            m.flags = msg.flags.clone();
            m.gm_msgid = Some(id);
            if let Some(d) = &msg.internal_date {
                m.internal_date = d.clone();
            }
            m.modseq = mb.highest_modseq + 1;
            mb.add(m);
        }
        id
    }

    /// Every X-GM-LABELS entry for a message: the folders that hold a copy of
    /// this X-GM-MSGID, All Mail left out (it is where every message lives, not
    /// a label), in mailbox order.
    pub fn gmail_labels(&self, gm_msgid: u64) -> Vec<String> {
        self.mailboxes
            .iter()
            .filter(|mb| !mb.is_all_mail())
            .filter(|mb| mb.messages.iter().any(|m| m.gm_msgid == Some(gm_msgid)))
            .map(|mb| folder_label(&mb.name))
            .collect()
    }

    /// Expunge from a test, the way another client would: recorded, so a
    /// QRESYNC client that reconnects hears about it.
    pub fn expunge(&mut self, mailbox: &str, uids: &[u32]) {
        let qresync = self.has_cap("QRESYNC");
        if let Some(mb) = self.find_mut(mailbox) {
            mb.expunge(uids, qresync);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_date_string_renders_the_same_instant_in_two_zones() {
        // 2024-12-31T22:30:00Z
        let ms = 1_735_684_200_000;
        assert_eq!(internal_date_string(ms, 0), "31-Dec-2024 22:30:00 +0000");
        assert_eq!(internal_date_string(ms, 120), "01-Jan-2025 00:30:00 +0200");
        assert_eq!(internal_date_string(ms, -330), "31-Dec-2024 17:00:00 -0530");
    }

    #[test]
    fn add_gmail_message_shares_one_msgid_and_gives_each_copy_its_own_uid() {
        let mut st = ServerState::default();
        st.gmail = true;
        let a = st.add_gmail_message(GmailMsg::new("Subject: a\n\nx").labels(&["\\Inbox", "Work"]));
        let b = st.add_gmail_message(GmailMsg::new("Subject: b\n\nx"));
        assert_ne!(a, b, "the server hands out a fresh id per message");
        assert_eq!(st.find("INBOX").unwrap().messages[0].gm_msgid, Some(a));
        assert_eq!(st.find("Work").unwrap().messages[0].gm_msgid, Some(a));
        let all = st.find(GMAIL_ALL_MAIL).unwrap();
        assert_eq!(all.messages.iter().map(|m| (m.uid, m.gm_msgid)).collect::<Vec<_>>(), vec![(1, Some(a)), (2, Some(b))]);
        assert_eq!(st.gmail_labels(a), vec!["\\Inbox".to_string(), "Work".to_string()]);
        assert!(st.gmail_labels(b).is_empty());
    }
}
