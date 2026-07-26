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
}

impl Trigger {
    pub fn on(cmd: &str) -> Self {
        Trigger::OnCommand(cmd.to_uppercase())
    }
    pub fn nth(cmd: &str, n: usize) -> Self {
        Trigger::OnNthCommand(cmd.to_uppercase(), n)
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fault {
    pub trigger: Trigger,
    pub action: Action,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Scenario {
    pub state: ServerState,
    pub faults: Vec<Fault>,
    /// Greeting line sent on connect. Default: `* OK MockIMAP ready`
    pub greeting: Option<String>,
}

impl Scenario {
    pub fn new() -> Self {
        Scenario {
            state: ServerState::default(),
            faults: vec![],
            greeting: None,
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

    /// Drop a capability — the point is exercising our fallback paths.
    pub fn without_cap(mut self, cap: &str) -> Self {
        self.state.capabilities.retain(|c| !c.eq_ignore_ascii_case(cap));
        self
    }

    pub fn greeting(mut self, g: &str) -> Self {
        self.greeting = Some(g.to_string());
        self
    }

    pub fn fault(mut self, trigger: Trigger, action: Action) -> Self {
        self.faults.push(Fault { trigger, action });
        self
    }
}
