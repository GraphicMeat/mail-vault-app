//! Who files the Sent copy of a message that went out: one rule for both
//! apps (owner decision 2).
//!
//! Microsoft Graph files its own copy in Sent Items when it takes the message,
//! and a JMAP server files it in Sent when the submission is created
//! (`onSuccessUpdateEmail`); neither account has IMAP to APPEND over. Every
//! other account sent over SMTP, and the app uploads the copy to Sent itself.
//!
//! Gmail over SMTP is no exception: its server keeps a copy of what its SMTP
//! accepted, but the app appends one anyway, the way the desktop app always
//! has (the mobile engine used to skip it). An APPEND is filed after the send
//! is recorded as sent, so a failed one never sends the message again and
//! never turns the send into a failure.

use crate::imap::ImapConfig;
use crate::smtp::SendResult;

/// What becomes of the Sent copy of an accepted send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SentCopy {
    /// The server filed it while taking the message (Graph, JMAP): nothing to
    /// upload.
    ServerFiled,
    /// Uploaded by the app to the account's Sent folder (IMAP APPEND).
    Append,
}

/// The Sent copy rule for `result`, sent from `account`.
pub fn sent_copy_policy(account: &ImapConfig, result: &SendResult) -> SentCopy {
    if result.server_saved_sent || account.transport() != crate::imap::Transport::Imap {
        SentCopy::ServerFiled
    } else {
        SentCopy::Append
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn account(extra: serde_json::Value) -> ImapConfig {
        let mut base = json!({ "email": "u@example.com", "imapHost": "imap.example.com", "authType": "password" });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn result(server_saved_sent: bool) -> SendResult {
        SendResult { message_id: "m@x".into(), raw_rfc2822: b"Subject: x\r\n\r\nx".to_vec(), server_saved_sent }
    }

    #[test]
    fn only_graph_and_jmap_file_their_own_copy() {
        let cases = [
            ("generic SMTP", account(json!({ "smtpHost": "smtp.example.com" })), false, SentCopy::Append),
            ("Gmail by host", account(json!({ "imapHost": "imap.gmail.com", "smtpHost": "smtp.gmail.com" })), false, SentCopy::Append),
            (
                "Gmail over OAuth SMTP",
                account(json!({ "imapHost": "imap.gmail.com", "authType": "oauth2", "oauth2Transport": "smtp" })),
                false,
                SentCopy::Append,
            ),
            ("Graph", account(json!({ "authType": "oauth2", "oauth2Transport": "graph" })), true, SentCopy::ServerFiled),
            ("Graph, flag unset", account(json!({ "authType": "oauth2", "oauth2Transport": "graph" })), false, SentCopy::ServerFiled),
            ("JMAP", account(json!({ "jmapSessionUrl": "https://jmap.example.com/session" })), true, SentCopy::ServerFiled),
            ("JMAP, flag unset", account(json!({ "jmapSessionUrl": "https://jmap.example.com/session" })), false, SentCopy::ServerFiled),
            ("a transport that says it filed", account(json!({})), true, SentCopy::ServerFiled),
        ];
        for (name, acct, flag, want) in cases {
            assert_eq!(sent_copy_policy(&acct, &result(flag)), want, "{name}");
        }
    }
}
