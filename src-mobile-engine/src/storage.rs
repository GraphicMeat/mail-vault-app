//! Settings > Storage on the phone: how much room MailVault takes, per account and in all.
//! Read only; what stays on the phone is chosen in Settings > Offline (`offline.rs`), and
//! the page links there.
//!
//! `mobile.storage.get {}` -> `{accounts: [{accountId, messages, bodiesBytes, attachmentsBytes}],
//! databaseBytes, searchBytes, logsBytes, cacheBytes, totalBytes}`:
//! - per account (in the list's order): the messages the list holds (headers), the bytes of the
//!   message bodies kept in `mobile.db`, and of its offline attachments
//!   (`<data>/offline/att/<account hash>`);
//! - `databaseBytes`: `mobile.db` with its WAL (headers, bodies, settings, the outbox);
//! - `searchBytes`: the search index (`search.db`);
//! - `logsBytes`: the log files (`logs.rs`);
//! - `cacheBytes`: the OS cache directory (attachments opened, outgoing files): the OS may empty it
//!   when the phone runs short of room, and MailVault downloads again what it needs.

use crate::db::Engine;
use crate::rpc::RpcError;
use serde_json::{json, Value};
use std::path::Path;

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// The bytes of every file under `dir`, at any depth (links not followed).
pub(crate) fn tree_bytes(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.filter_map(|e| e.ok())
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => tree_bytes(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// The bytes of the files in `dir` (not below it) whose name starts with `prefix`.
fn files_bytes(dir: &Path, prefix: &str) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// `mobile.storage.get {}`; see the module.
pub(crate) fn get(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    let shared = engine.shared();
    let rows: Vec<(String, i64, i64)> = engine
        .read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT a.id,
                        (SELECT count(*) FROM messages m WHERE m.account_id = a.id AND m.local_deleted IS NULL),
                        (SELECT COALESCE(sum(b.bytes), 0) FROM bodies b WHERE b.account_id = a.id)
                 FROM accounts a ORDER BY {}",
                crate::accounts::LIST_ORDER
            ))?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect();
            rows
        })
        .map_err(internal)?;
    let accounts: Vec<Value> = rows
        .into_iter()
        .map(|(id, messages, bodies)| {
            let att = crate::offline::attachments_dir(shared, &id).map_or(0, |d| tree_bytes(&d));
            json!({ "accountId": id, "messages": messages, "bodiesBytes": bodies, "attachmentsBytes": att })
        })
        .collect();
    let data = shared.data_dir();
    let database = data.map_or(0, |d| files_bytes(d, crate::db::DB_FILE));
    let search = data.map_or(0, |d| files_bytes(d, "search.db"));
    let logs = shared.logs.bytes();
    let cache = tree_bytes(engine.cache_dir());
    let offline: u64 = accounts.iter().map(|a| a["attachmentsBytes"].as_u64().unwrap_or(0)).sum();
    Ok(json!({
        "accounts": accounts,
        "databaseBytes": database,
        "searchBytes": search,
        "logsBytes": logs,
        "cacheBytes": cache,
        "totalBytes": database + search + logs + cache + offline,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::state::{Mailbox, Message};
    use mock_imap::{MockImap, Scenario};
    use std::sync::Arc;

    /// After a download the account's messages and bodies show, the database and the index take
    /// room, and the total adds up the parts.
    #[test]
    fn storage_counts_each_account_and_the_files() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        let mut mb = Mailbox::new("INBOX");
        for uid in 1..=3u32 {
            mb.add(
                Message::new(
                    uid,
                    format!("From: A <a@example.com>\r\nTo: u@example.test\r\nSubject: s{uid}\r\nMessage-ID: <st-{uid}@x>\r\n\r\nBody {uid}.\r\n"),
                )
                .with_internal_ms(crate::compose::now_ms() - 86_400_000),
            );
        }
        let server = MockImap::start(Scenario::new().mailbox(mb));
        let tmp = tempfile::tempdir().unwrap();
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(crate::MemorySecrets::default())).unwrap();
        e.set_front_downloads_for_tests(false);
        let empty = e.rpc("mobile.storage.get", json!({})).unwrap();
        assert_eq!(empty["accounts"], json!([]));
        assert!(empty["databaseBytes"].as_u64().unwrap() > 0);

        let added = e
            .rpc(
                "mobile.accounts.add",
                json!({ "email": "storage@example.test", "password": "pw", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
            )
            .unwrap();
        let account = added["account"]["id"].as_str().unwrap().to_string();
        crate::sync::download_now_for_test(e.shared(), &account, false).map_err(|_| "download").unwrap();
        std::fs::write(e.cache_dir().join("probe.bin"), [0u8; 1000]).unwrap();
        let got = e.rpc("mobile.storage.get", json!({})).unwrap();
        let a = &got["accounts"][0];
        assert_eq!(a["accountId"], json!(account));
        assert_eq!(a["messages"], 3);
        assert!(a["bodiesBytes"].as_u64().unwrap() > 0, "{got}");
        assert!(got["cacheBytes"].as_u64().unwrap() >= 1000, "{got}");
        let parts: u64 = ["databaseBytes", "searchBytes", "logsBytes", "cacheBytes"].iter().map(|k| got[*k].as_u64().unwrap()).sum::<u64>()
            + a["attachmentsBytes"].as_u64().unwrap();
        assert_eq!(got["totalBytes"].as_u64().unwrap(), parts);
    }
}
