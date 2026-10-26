//! Launch resync: every cached mailbox of every account is synced once after
//! the daemon starts, not only the INBOX the app opens on.
//!
//! A folder the user has not opened since an update still holds header rows
//! written by the old build. Their native identity is stamped by the next
//! sync, and a delete aimed at such a row is refused until it is. Syncing them
//! all at launch means a delete finds a proved row whichever folder it is in.
//!
//! One account, one mailbox at a time, paced, after a delay that leaves the
//! first paint to the foreground. Credentials are read quietly: a locked
//! keychain skips the account, it never raises a prompt. A closed
//! connectivity gate ends the account's pass, since every further mailbox
//! would only be refused the same way.

use crate::server::DaemonState;
use crate::sync_engine::{SyncAccount, SyncEngine};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

const LAUNCH_DELAY: Duration = Duration::from_secs(20);
const PACE: Duration = Duration::from_millis(750);

pub fn start(state: Arc<DaemonState>) {
    tokio::spawn(async move {
        tokio::time::sleep(LAUNCH_DELAY).await;
        pass(&state).await;
    });
}

/// INBOX first (the one a user is most likely waiting on), then the rest by name.
fn order(boxes: HashSet<String>) -> Vec<String> {
    let mut rest: Vec<String> = boxes.into_iter().filter(|b| b != "INBOX").collect();
    rest.sort();
    let mut out = vec!["INBOX".to_string()];
    out.extend(rest);
    out
}

async fn pass(state: &Arc<DaemonState>) {
    let ids = {
        let dir = state.app_dir.clone();
        match crate::handlers::common::blocking(move || crate::handlers::insights::configured_account_ids(&dir)).await {
            Ok(Ok(ids)) => ids,
            other => {
                warn!("launch resync: no account list: {other:?}");
                return;
            }
        }
    };
    for id in ids {
        let Ok(config) = crate::credentials::resolve_account_credentials_quiet(&id).await else { continue };
        // Graph folders are listed and cached by the app, not synced here.
        if config.uses_graph() { continue; }
        let boxes = match crate::sync_jmap::cached_mailboxes(state, &id).await {
            Ok(boxes) if !boxes.is_empty() => order(boxes),
            _ => continue,
        };
        let account = SyncAccount { id: id.clone(), email: config.email.clone(), imap_config: config };
        let synced = resync_boxes(&state.sync_engine, &account, &boxes).await;
        info!("launch resync: {synced}/{} mailboxes of {id}", boxes.len());
    }
}

/// Sync each mailbox in turn; returns how many succeeded. Stops at the first
/// offline answer.
pub(crate) async fn resync_boxes(engine: &SyncEngine, account: &SyncAccount, boxes: &[String]) -> usize {
    let mut synced = 0;
    for mailbox in boxes {
        let result = engine.sync_account(account, mailbox).await;
        if result.offline { break; }
        if result.success { synced += 1; }
        tokio::time::sleep(PACE).await;
    }
    synced
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::state::{Mailbox, Message};

    fn eml(id: &str) -> String {
        format!("Message-ID: {id}\r\nFrom: ana@example.com\r\nTo: me@example.com\r\nSubject: s\r\nDate: Fri, 02 Oct 2026 10:00:00 +0000\r\n\r\nbody\r\n")
    }

    #[test]
    fn inbox_goes_first_then_the_rest_by_name() {
        let boxes: HashSet<String> = ["Spam", "Archive", "INBOX", "Sent"].iter().map(|s| s.to_string()).collect();
        assert_eq!(order(boxes), ["INBOX", "Archive", "Sent", "Spam"]);
    }

    /// A folder never opened this run is synced too: its rows land in the cache.
    #[tokio::test]
    async fn every_listed_mailbox_is_synced_not_only_the_inbox() {
        let _env = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        let server = mock_imap::MockImap::start(
            mock_imap::Scenario::new()
                .mailbox(Mailbox::new("INBOX").push_msg(Message::new(0, eml("<a@x>"))))
                .mailbox(Mailbox::new("Spam").push_msg(Message::new(0, eml("<b@x>")))),
        );
        let dir = std::env::temp_dir().join(format!("mv-launch-resync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = crate::server::DaemonState::for_test(dir.clone(), dir.clone(), true);
        crate::custody::open_into(&state).expect("custody opens");
        let account: SyncAccount = serde_json::from_value(serde_json::json!({
            "id": "acct", "email": "me@example.com",
            "imapConfig": { "email": "me@example.com", "password": "hunter2", "imapHost": server.host(), "imapPort": server.port() },
        }))
        .unwrap();
        let boxes = vec!["INBOX".to_string(), "Spam".to_string()];
        assert_eq!(resync_boxes(&state.sync_engine, &account, &boxes).await, 2);
        let uid = server.state().find("Spam").unwrap().messages[0].uid;
        let rows = crate::custody::with_conn(&state, |c| mailvault_core::custody::cache::load_by_uids(c, "acct", "Spam", &[uid])).unwrap();
        assert_eq!(rows.len(), 1, "Spam was synced at launch");
    }
}
