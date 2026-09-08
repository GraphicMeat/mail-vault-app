//! Scenario = server state + a list of faults.
//!
//! Every fault here exists because a real provider did it to us in production.
//! Add faults with the regression test that needs them, not speculatively.

use crate::state::{Mailbox, ServerState};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Trigger {
    /// Every occurrence of a command. Match is on the command word,
    /// uppercase, without the `UID ` prefix — e.g. "SEARCH", "FETCH", "APPEND".
    OnCommand(String),
    /// The nth occurrence (1-based) of a command.
    OnNthCommand(String, usize),
    /// Fires once, right after the TCP connection is accepted.
    OnConnect,
    /// Every occurrence of a command whose arguments contain `needle`
    /// (case-insensitive). The only way to fault one FETCH shape and not the
    /// others: a body read is `BODY.PEEK[]`, a header page is
    /// `BODY.PEEK[HEADER.FIELDS (…)]`, and both arrive as "FETCH".
    OnCommandWith(String, String),
}

impl Trigger {
    pub fn on(cmd: &str) -> Self {
        Trigger::OnCommand(cmd.to_uppercase())
    }
    pub fn nth(cmd: &str, n: usize) -> Self {
        Trigger::OnNthCommand(cmd.to_uppercase(), n)
    }
    pub fn with(cmd: &str, needle: &str) -> Self {
        Trigger::OnCommandWith(cmd.to_uppercase(), needle.to_uppercase())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Action {
    /// Stall before responding. Hostinger's post-SMTP APPEND went silent 15s+.
    Delay(Duration),

    /// Emit a well-formed untagged line before the real response.
    /// e.g. `* OK Still here`
    InjectUntagged(String),

    /// Splice text INTO the first response line with no CRLF break.
    ///
    /// This is the Purelymail keepalive bug: `* OK Still here` landed inside a
    /// `* SEARCH 1 2 3 ...` line, producing `* SEARCH 1 2 * OK Still here3 4`.
    /// No real server can be asked to do this on demand — it is the single most
    /// important fault this mock provides.
    InjectMidLine(String),

    /// Replace the entire response (untagged + tagged) with raw bytes.
    /// Used for ESEARCH-where-SEARCH-expected and malformed literals.
    /// `{tag}` is substituted with the command's tag.
    RespondRaw(String),

    /// `RespondRaw` for a reply that is not valid UTF-8 — a Latin-1 filename in
    /// a BODYSTRUCTURE param, say, which a `String` cannot carry. `{tag}` is
    /// substituted the same way; write CRLF as real bytes.
    RespondRawBytes(Vec<u8>),

    /// Replace the tagged result: ("NO"|"BAD"|"BYE", text). Untagged data suppressed.
    Respond(String, String),

    /// Close the socket without responding.
    DropConnection,

    /// Send only the first N bytes of the response, then keep the socket open.
    TruncateResponse(usize),

    /// Write the response in N-byte chunks with a flush between each,
    /// forcing the client's parser to handle TCP fragmentation.
    SplitWrites(usize),

    /// CONDSTORE FETCH reports changed flags but never the vanished UIDs —
    /// exactly how expunges get missed on a delta sync.
    OmitExpunged,

    /// Return only this fraction (0.0–1.0) of matching UIDs from SEARCH.
    /// Server-side pagination that silently truncates.
    PartialSearchResult(f32),

    /// Report a UIDNEXT that does not match the actual highest UID + 1.
    LieUidNext(u32),

    /// Report a different UIDVALIDITY on SELECT, forcing a full resync.
    BumpUidValidity,

    /// After N responses, delay every subsequent one — bulk-operation throttling.
    ThrottleAfter(usize, Duration),

    /// Replace the nth (1-based) untagged FETCH item with a line the client's
    /// decoder cannot parse.
    ///
    /// B4 in the parity audit. async-imap's decoder stops advancing after a
    /// line it fails on, so one poisoned item costs every item behind it and
    /// the page that comes back is SHORT — indistinguishable from a mailbox
    /// that really holds that many. This is the only way to produce an `Err`
    /// item in the FETCH stream on demand; no real server can be asked for one.
    CorruptFetchItem(usize),

    /// Replace the untagged FETCH item carrying this UID with a line that no
    /// parser can read, keeping its own `* <seq>` and `UID <n>` — so the error
    /// can name the message and the client can retry the page without it.
    ///
    /// Unlike `CorruptFetchItem`, which is addressed by position, this one is
    /// addressed by UID and so survives a re-fetch of a different range. It
    /// covers `UID FETCH` too: the mock strips the `UID ` prefix, so both
    /// arrive as `FETCH`.
    PoisonFetchUid(u32),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fault {
    pub trigger: Trigger,
    pub action: Action,
}

/// The SMTP listener's behaviour. It runs on its own port beside the IMAP one
/// (`MockImap::smtp_port`) and accepts everything by default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SmtpScenario {
    /// A recipient whose address contains this needle (case-insensitive) is
    /// refused with `550` at RCPT TO. `None` accepts every recipient.
    ///
    /// Recipient-scoped rather than a global on/off because one mock server
    /// serves a whole e2e run: a per-run switch cannot be flipped by a single
    /// spec, but the address a spec types is its own.
    pub refuse_recipient: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Scenario {
    pub state: ServerState,
    pub faults: Vec<Fault>,
    /// Greeting line sent on connect. Default: `* OK MockIMAP ready`
    pub greeting: Option<String>,
    pub smtp: SmtpScenario,
}

impl Scenario {
    pub fn new() -> Self {
        Scenario {
            state: ServerState::default(),
            faults: vec![],
            greeting: None,
            smtp: SmtpScenario::default(),
        }
    }

    /// Replace the mailbox set.
    pub fn mailboxes(mut self, mailboxes: Vec<Mailbox>) -> Self {
        self.state.mailboxes = mailboxes;
        self
    }

    pub fn mailbox(mut self, mb: Mailbox) -> Self {
        self.state.mailboxes.retain(|m| m.name != mb.name);
        self.state.mailboxes.push(mb);
        self
    }

    pub fn capabilities(mut self, caps: &[&str]) -> Self {
        self.state.capabilities = caps.iter().map(|c| c.to_string()).collect();
        self
    }

    /// What SELECT advertises as PERMANENTFLAGS. Default (None): the five
    /// system flags plus `\*`. A server that keeps fewer is what the
    /// flag-writing gate exists for.
    pub fn permanent_flags(mut self, flags: &[&str]) -> Self {
        self.state.permanent_flags = Some(flags.iter().map(|f| f.to_string()).collect());
        self
    }

    /// Drop a capability — the point is exercising our fallback paths.
    pub fn without_cap(mut self, cap: &str) -> Self {
        self.state.capabilities.retain(|c| !c.eq_ignore_ascii_case(cap));
        self
    }

    pub fn greeting(mut self, g: &str) -> Self {
        self.greeting = Some(g.to_string());
        self
    }

    /// Refuse any SMTP recipient whose address contains `needle`.
    pub fn smtp_refuse(mut self, needle: &str) -> Self {
        self.smtp.refuse_recipient = Some(needle.to_string());
        self
    }

    pub fn fault(mut self, trigger: Trigger, action: Action) -> Self {
        self.faults.push(Fault { trigger, action });
        self
    }
}
