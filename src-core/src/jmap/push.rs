//! JMAP push (RFC 8620 §7.3): the EventSource reader and the StateChange rule
//! the daemon's `jmap_push` and the mobile engine's live watch share.
//!
//! - [`SseParser`]: an incremental `text/event-stream` parser. Chunks go in
//!   split anywhere; each event a blank line completes comes out.
//! - [`StateChange`]: a `state` event's JSON, read for one JMAP account.

use serde_json::Value;
use tracing::warn;

/// The most one event's lines may hold before the parser drops it (a server
/// that never ends an event must not grow memory without bound).
pub const MAX_EVENT_BYTES: usize = 1 << 20;

/// One Server-Sent Event: its `event:` type ("message" when none was given)
/// and its `data:` lines joined with "\n".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub kind: String,
    pub data: String,
}

/// An incremental `text/event-stream` parser (the parts JMAP uses: `event:`,
/// `data:`, comments, the blank line that ends an event). An event over
/// [`MAX_EVENT_BYTES`] is dropped whole, its content never logged.
#[derive(Default)]
pub struct SseParser {
    /// The current line, not yet ended.
    line: Vec<u8>,
    kind: String,
    data: Vec<String>,
    /// Bytes held for the current event (its line included).
    held: usize,
    /// The current event went over the cap: skip it to its end.
    skipping: bool,
    /// The current line was cut by the cap: its newline is not a blank line.
    line_cut: bool,
}

impl SseParser {
    /// Feeds bytes; returns every event they ended.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        for &b in bytes {
            if b != b'\n' {
                self.held += 1;
                if self.held > MAX_EVENT_BYTES {
                    if !self.skipping {
                        warn!("[push] an event grew past {} bytes without ending: dropped", MAX_EVENT_BYTES);
                    }
                    self.skipping = true;
                    self.line_cut = true;
                    self.line.clear();
                    self.kind.clear();
                    self.data.clear();
                } else if !self.skipping {
                    self.line.push(b);
                }
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if std::mem::take(&mut self.line_cut) {
                continue;
            }
            if line.is_empty() {
                if !self.skipping && (!self.data.is_empty() || !self.kind.is_empty()) {
                    let kind = if self.kind.is_empty() { "message".to_string() } else { std::mem::take(&mut self.kind) };
                    out.push(SseEvent { kind, data: self.data.join("\n") });
                }
                self.kind.clear();
                self.data.clear();
                self.held = 0;
                self.skipping = false;
                continue;
            }
            if self.skipping || line[0] == b':' {
                continue;
            }
            let line = String::from_utf8_lossy(&line);
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_ref(), ""),
            };
            match field {
                "event" => self.kind = value.to_string(),
                "data" => self.data.push(value.to_string()),
                _ => {}
            }
        }
        out
    }
}

/// A pushed StateChange (`event: state`): `{"changed": {accountId: {Type: state}}}`.
pub struct StateChange(Value);

impl StateChange {
    /// `None` when `data` is not JSON.
    pub fn parse(data: &str) -> Option<StateChange> {
        serde_json::from_str::<Value>(data).ok().map(StateChange)
    }

    /// The Email state pushed for this JMAP account; another account's entry is none.
    pub fn email_state(&self, jmap_account: &str) -> Option<&str> {
        self.0["changed"][jmap_account]["Email"].as_str()
    }

    /// The Mailbox state pushed for this JMAP account.
    pub fn mailbox_state(&self, jmap_account: &str) -> Option<&str> {
        self.0["changed"][jmap_account]["Mailbox"].as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_reassembles_events_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.feed(b"event: st").is_empty());
        assert!(p.feed(b"ate\r\ndata: {\"a\":").is_empty());
        let got = p.feed(b"1}\r\n\r\n: a comment\n\nevent: ping\ndata: {}\n\ndata: x\ndata: y\n\n");
        assert_eq!(
            got,
            vec![
                SseEvent { kind: "state".into(), data: "{\"a\":1}".into() },
                SseEvent { kind: "ping".into(), data: "{}".into() },
                SseEvent { kind: "message".into(), data: "x\ny".into() },
            ]
        );
        assert!(p.feed(b"event: state\ndata: half").is_empty(), "no blank line yet");
    }

    #[test]
    fn an_endless_event_is_dropped_and_the_next_one_read() {
        let mut p = SseParser::default();
        let big = vec![b'x'; MAX_EVENT_BYTES + 10];
        assert!(p.feed(b"event: state\ndata: ").is_empty());
        assert!(p.feed(&big).is_empty());
        assert!(p.line.len() <= MAX_EVENT_BYTES, "held {}", p.line.len());
        assert!(p.feed(b"\n\n").is_empty(), "the oversized event is dropped");
        assert_eq!(p.feed(b"event: state\ndata: {}\n\n"), vec![SseEvent { kind: "state".into(), data: "{}".into() }]);
    }

    #[test]
    fn many_data_lines_past_the_cap_are_dropped() {
        let mut p = SseParser::default();
        let line = format!("data: {}\n", "x".repeat(1000));
        let mut got = Vec::new();
        for _ in 0..(MAX_EVENT_BYTES / 1000 + 10) {
            got.extend(p.feed(line.as_bytes()));
        }
        assert!(got.is_empty());
        assert!(p.data.is_empty(), "the oversized event was dropped");
        assert!(p.feed(b"\n").is_empty());
        assert_eq!(p.feed(b"event: state\ndata: {}\n\n"), vec![SseEvent { kind: "state".into(), data: "{}".into() }]);
    }

    #[test]
    fn a_state_change_is_read_for_one_account() {
        let c = StateChange::parse(r#"{"@type":"StateChange","changed":{"a1":{"Email":"s7","Mailbox":"m3"},"a2":{"Email":"x"}}}"#).unwrap();
        assert_eq!(c.email_state("a1"), Some("s7"));
        assert_eq!(c.mailbox_state("a1"), Some("m3"));
        assert_eq!(c.email_state("a2"), Some("x"));
        assert_eq!(c.mailbox_state("a2"), None);
        assert_eq!(c.email_state("other"), None);
        assert!(StateChange::parse("not json").is_none());
        assert_eq!(StateChange::parse("{}").unwrap().email_state("a1"), None);
    }
}
