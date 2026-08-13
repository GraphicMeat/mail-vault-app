//! Durable journal of server deletes the user confirmed but that may not have run.
//!
//! "Delete from server" is driven from the frontend: the row is hidden
//! optimistically and a session tombstone keeps it hidden, then the workflow
//! awaits one IMAP round-trip per message. Reload or quit the app inside that
//! window and the JS context dies before the command is ever sent — the message
//! is never deleted, nothing errors, nothing retries, and it is back on the next
//! launch. The user watched the row disappear and has every reason to believe it
//! is gone. The window is exactly as wide as the server is slow, so it is a real
//! provider problem, not a synthetic one.
//!
//! Writing the intent here before the first round-trip and clearing it after the
//! last lets the next launch finish what the user already confirmed.
//!
//! Deliberately the same shape as backup.rs's pending purge queue: one small
//! JSON map in the data dir, corrupt-tolerant, keyed "<accountId>|<mailbox>".
//! UIDs are unique per mailbox and nowhere else, so the mailbox has to be part
//! of the key — replaying a uid against the wrong one deletes a stranger's mail.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// "<accountId>|<mailbox>" -> uids still owed a server delete.
pub type Journal = BTreeMap<String, Vec<u32>>;

fn key(account_id: &str, mailbox: &str) -> String {
    format!("{}|{}", account_id, mailbox)
}

pub fn journal_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pending_server_delete.json")
}

pub fn read(data_dir: &Path) -> Journal {
    let Ok(content) = std::fs::read_to_string(journal_path(data_dir)) else {
        return Default::default();
    };
    // A corrupt journal must not brick deleting. Starting over loses a retry;
    // erroring here would block the delete the user is asking for right now.
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn write(data_dir: &Path, journal: &Journal) -> Result<(), String> {
    if journal.is_empty() {
        // Remove rather than write "{}" — absence is the common case, and it
        // makes the launch check a single failed open instead of a parse.
        let _ = std::fs::remove_file(journal_path(data_dir));
        return Ok(());
    }
    let data =
        serde_json::to_string(journal).map_err(|e| format!("serialize pending deletes: {}", e))?;
    std::fs::write(journal_path(data_dir), data)
        .map_err(|e| format!("write pending deletes: {}", e))
}

pub fn queue(
    data_dir: &Path,
    account_id: &str,
    mailbox: &str,
    uids: &[u32],
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    let mut journal = read(data_dir);
    let entry = journal.entry(key(account_id, mailbox)).or_default();
    entry.extend_from_slice(uids);
    entry.sort_unstable();
    entry.dedup();
    write(data_dir, &journal)
}

pub fn clear(
    data_dir: &Path,
    account_id: &str,
    mailbox: &str,
    uids: &[u32],
) -> Result<(), String> {
    let mut journal = read(data_dir);
    let k = key(account_id, mailbox);
    let Some(entry) = journal.get_mut(&k) else {
        return Ok(());
    };
    entry.retain(|uid| !uids.contains(uid));
    if entry.is_empty() {
        journal.remove(&k);
    }
    write(data_dir, &journal)
}

/// The journal as a flat list, which is the shape the replay wants.
pub fn entries(data_dir: &Path) -> Vec<(String, String, Vec<u32>)> {
    read(data_dir)
        .into_iter()
        .filter_map(|(k, uids)| {
            // A malformed key names no mailbox, and a uid without a mailbox is
            // not a message — drop it rather than guess at one.
            let (account_id, mailbox) = k.split_once('|')?;
            Some((account_id.to_string(), mailbox.to_string(), uids))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn missing_journal_reads_as_empty() {
        assert!(read(tmp().path()).is_empty());
    }

    #[test]
    fn corrupt_journal_reads_as_empty() {
        let d = tmp();
        std::fs::write(journal_path(d.path()), "{ not json").unwrap();
        assert!(read(d.path()).is_empty());
    }

    #[test]
    fn queue_merges_and_dedupes_per_mailbox() {
        let d = tmp();
        queue(d.path(), "acct-1", "INBOX", &[3, 1]).unwrap();
        queue(d.path(), "acct-1", "INBOX", &[1, 2]).unwrap();
        queue(d.path(), "acct-1", "Archive", &[1]).unwrap();

        let j = read(d.path());
        assert_eq!(j.get("acct-1|INBOX").unwrap(), &vec![1, 2, 3]);
        // Same uid, different mailbox — a separate message, kept separate.
        assert_eq!(j.get("acct-1|Archive").unwrap(), &vec![1]);
    }

    #[test]
    fn clear_removes_only_the_named_uids_in_the_named_mailbox() {
        let d = tmp();
        queue(d.path(), "acct-1", "INBOX", &[1, 2, 3]).unwrap();
        queue(d.path(), "acct-1", "Archive", &[1]).unwrap();

        clear(d.path(), "acct-1", "INBOX", &[1, 3]).unwrap();

        let j = read(d.path());
        assert_eq!(j.get("acct-1|INBOX").unwrap(), &vec![2]);
        assert_eq!(j.get("acct-1|Archive").unwrap(), &vec![1]);
    }

    #[test]
    fn clearing_the_last_uid_removes_the_file_entirely() {
        let d = tmp();
        queue(d.path(), "acct-1", "INBOX", &[1]).unwrap();
        assert!(journal_path(d.path()).exists());

        clear(d.path(), "acct-1", "INBOX", &[1]).unwrap();
        assert!(!journal_path(d.path()).exists());
        assert!(read(d.path()).is_empty());
    }

    #[test]
    fn clearing_an_unknown_mailbox_is_a_noop() {
        let d = tmp();
        queue(d.path(), "acct-1", "INBOX", &[1]).unwrap();
        clear(d.path(), "acct-1", "Nowhere", &[1]).unwrap();
        assert_eq!(read(d.path()).get("acct-1|INBOX").unwrap(), &vec![1]);
    }

    #[test]
    fn entries_drops_malformed_keys() {
        let d = tmp();
        let mut j = Journal::new();
        j.insert("acct-1|INBOX".into(), vec![1]);
        j.insert("no-separator".into(), vec![9]);
        write(d.path(), &j).unwrap();

        let got = entries(d.path());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "acct-1");
        assert_eq!(got[0].1, "INBOX");
    }
}
