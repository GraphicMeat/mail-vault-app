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

/// The full server: a set of mailboxes plus advertised capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerState {
    pub mailboxes: Vec<Mailbox>,
    pub delimiter: String,
    pub capabilities: Vec<String>,
    /// Credentials the server accepts. `None` accepts anything.
    pub expect_login: Option<(String, String)>,
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
                "SPECIAL-USE".to_string(),
                "AUTH=XOAUTH2".to_string(),
            ],
            expect_login: None,
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
}
