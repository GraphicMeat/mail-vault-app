//! Test-only helpers the daemon's JMAP tests share outside the bridge and
//! the sync (restore, mbox upload, migration, backup): the mock scenario,
//! the account as the app sends it, an IMAP trap, and the server's emails.

use mailvault_core::imap::ImapConfig;
use mock_jmap::{Limits, MockJmap, Scenario, ScenarioAccount, ScenarioEmail, ScenarioMailbox};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::net::TcpListener;

/// A dated message from Bob with a Message-ID of `<{id}@x>`. Its Date is
/// 2019-03-05T08:15:00Z.
pub fn raw(id: &str, subject: &str) -> String {
    format!(
        "From: Bob <bob@example.test>\r\nMessage-ID: <{id}@x>\r\nSubject: {subject}\r\nDate: Tue, 05 Mar 2019 09:15:00 +0100\r\n\r\nbody of {subject}\r\n"
    )
}

/// `raw(id, subject)` as a scenario email, no keywords, in one mailbox.
pub fn email(id: &str, subject: &str, received_at: &str) -> ScenarioEmail {
    ScenarioEmail { id: id.into(), raw: raw(id, subject), keywords: vec![], received_at: received_at.into(), also_in: vec![] }
}

/// One account, mailboxes in this order: Inbox (e1 seen and also in Work,
/// e2), Work, Sent (role sent, empty), Trash. Also lets this process send
/// credentials to the mock's loopback http.
pub fn scenario() -> Scenario {
    mailvault_core::jmap::base::allow_loopback_for_tests();
    let mut e1 = email("e1", "one", "2026-10-01T10:00:00Z");
    e1.keywords = vec!["$seen".into()];
    e1.also_in = vec!["mb-work".into()];
    let e2 = email("e2", "two", "2026-10-02T10:00:00Z");
    let mailbox = |id: &str, name: &str, role: Option<&str>, emails: Vec<ScenarioEmail>| ScenarioMailbox {
        id: id.into(),
        name: name.into(),
        parent_id: None,
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
                mailbox("mb-inbox", "Inbox", Some("inbox"), vec![e1, e2]),
                mailbox("mb-work", "Work", None, vec![]),
                mailbox("mb-sent", "Sent", Some("sent"), vec![]),
                mailbox("mb-trash", "Trash", Some("trash"), vec![]),
            ],
        }],
        faults: vec![],
        limits: Limits::default(),
    }
}

/// The JMAP account as the app sends it (Basic: the address + "pw"), with
/// `imapHost:imapPort` at `imap_port` on loopback: give it an `imap_trap`
/// port and anything that dials IMAP lands in the trap's backlog.
pub fn account_json(m: &MockJmap, imap_port: u16) -> Value {
    json!({
        "id": "acct1",
        "email": "alice@example.test",
        "authType": "password",
        "jmapSessionUrl": m.session_url(),
        "jmapAuth": "basic",
        "password": "pw",
        "imapHost": "127.0.0.1",
        "imapPort": imap_port,
    })
}

pub fn config(m: &MockJmap, imap_port: u16) -> ImapConfig {
    serde_json::from_value(account_json(m, imap_port)).unwrap()
}

/// A local port that counts as an IMAP server: `trap.accept().is_err()`
/// afterwards proves nothing dialled it.
pub fn imap_trap() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

/// One email on the mock server.
#[derive(Debug, Clone)]
pub struct Stored {
    pub id: String,
    pub raw: String,
    pub keywords: BTreeSet<String>,
    pub received_at: String,
}

/// Every email in `mailbox_id` on the server, oldest first (then by id).
pub fn emails_in(m: &MockJmap, mailbox_id: &str) -> Vec<Stored> {
    m.read(|s| {
        let mut out: Vec<Stored> = s
            .account("acc1")
            .emails
            .values()
            .filter(|e| e.mailbox_ids.contains(mailbox_id))
            .map(|e| Stored {
                id: e.id.clone(),
                raw: String::from_utf8_lossy(s.blobs.get(&e.blob_id).map(Vec::as_slice).unwrap_or_default()).into_owned(),
                keywords: e.keywords.clone(),
                received_at: e.received_at.clone(),
            })
            .collect();
        out.sort_by(|a, b| (&a.received_at, &a.id).cmp(&(&b.received_at, &b.id)));
        out
    })
}

/// The id of the mailbox named `name` whose parent is named `parent`
/// (`None`: a top-level mailbox).
pub fn mailbox_named(m: &MockJmap, parent: Option<&str>, name: &str) -> Option<String> {
    m.read(|s| {
        let boxes = &s.account("acc1").mailboxes;
        let parent_id = match parent {
            Some(p) => Some(boxes.values().find(|b| b.name == p)?.id.clone()),
            None => None,
        };
        boxes.values().find(|b| b.name == name && b.parent_id == parent_id).map(|b| b.id.clone())
    })
}

/// A keyword set, for comparisons.
pub fn set(keywords: &[&str]) -> BTreeSet<String> {
    keywords.iter().map(|k| k.to_string()).collect()
}
