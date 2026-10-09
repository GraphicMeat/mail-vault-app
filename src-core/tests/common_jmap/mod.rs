//! Shared fixture for the JMAP client tests: one account, four mailboxes
//! (Inbox, Work, Work/Sub, Trash), three emails, e1 in Inbox and Work.
//!
//! Included by each test binary separately, so helpers only some of them use
//! would otherwise warn as dead code.
#![allow(dead_code)]

use mock_jmap::{Limits, Scenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};

pub const E1_RAW: &str = "Message-ID: <e1@x>\r\nSubject: one\r\n\r\nbody";

pub const E2_RAW: &str = "Message-ID: <e2@x>\r\n\
In-Reply-To: <e1@x>\r\n\
References: <e1@x>\r\n\
From: Bob <bob@example.test>\r\n\
To: Alice <alice@example.test>\r\n\
Cc: carol@example.test\r\n\
Date: Fri, 02 Oct 2026 09:00:00 +0000\r\n\
Subject: two\r\n\
List-Unsubscribe: <mailto:unsub@example.test>,\r\n <https://example.test/unsub>\r\n\
Auto-Submitted: Auto-Replied\r\n\
\r\n\
second body";

/// A plain message with a Message-ID of `<{id}@x>`.
pub fn email(id: &str, subject: &str, received_at: &str) -> ScenarioEmail {
    ScenarioEmail {
        id: id.into(),
        raw: format!("Message-ID: <{id}@x>\r\nSubject: {subject}\r\n\r\nbody of {subject}"),
        keywords: vec![],
        received_at: received_at.into(),
        also_in: vec![],
    }
}

/// The scenario every JMAP client test starts from. Also lets this process
/// send credentials to the mock's loopback http URLs (`allow_loopback_for_tests`).
pub fn scenario() -> Scenario {
    mailvault_core::jmap::base::allow_loopback_for_tests();
    let e1 = ScenarioEmail {
        id: "e1".into(),
        raw: E1_RAW.into(),
        keywords: vec!["$seen".into()],
        received_at: "2026-10-01T10:00:00Z".into(),
        also_in: vec!["mb-work".into()],
    };
    let e2 = ScenarioEmail {
        id: "e2".into(),
        raw: E2_RAW.into(),
        keywords: vec!["$flagged".into()],
        received_at: "2026-10-02T10:00:00Z".into(),
        also_in: vec![],
    };
    let e3 = email("e3", "three", "2026-10-03T10:00:00Z");
    let mailbox = |id: &str, name: &str, parent: Option<&str>, role: Option<&str>, emails: Vec<ScenarioEmail>| ScenarioMailbox {
        id: id.into(),
        name: name.into(),
        parent_id: parent.map(str::to_string),
        role: role.map(str::to_string),
        emails,
    };
    Scenario {
        accounts: vec![ScenarioAccount {
            username: "alice@example.test".into(),
            password: "pw".into(),
            token: Some("tok".into()),
            identities: vec![("alice@example.test".into(), "Alice".into())],
            mailboxes: vec![
                mailbox("mb-inbox", "Inbox", None, Some("inbox"), vec![e1, e2]),
                mailbox("mb-work", "Work", None, None, vec![]),
                mailbox("mb-sub", "Sub", Some("mb-work"), None, vec![e3]),
                mailbox("mb-trash", "Trash", None, Some("trash"), vec![]),
            ],
        }],
        faults: vec![],
        limits: Limits::default(),
    }
}
