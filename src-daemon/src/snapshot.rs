use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// A single email entry in a snapshot manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotEmail {
    pub uid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub flags: Vec<String>,
    pub size: u64,
}

/// Email state for a single mailbox within a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMailbox {
    pub total_emails: usize,
    pub emails: Vec<SnapshotEmail>,
}

/// A complete snapshot manifest — point-in-time state of all mailboxes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotManifest {
    pub account_id: String,
    pub account_email: String,
    pub timestamp: String,
    pub mailboxes: HashMap<String, SnapshotMailbox>,
}

/// Lightweight info for listing snapshots without loading full manifests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    pub timestamp: String,
    pub filename: String,
    pub size_bytes: u64,
    pub total_emails: usize,
    pub mailbox_count: usize,
}

/// Returns the snapshot directory for an account.
fn snapshot_dir(data_dir: &Path, account_id: &str) -> PathBuf {
    data_dir.join("snapshots").join(account_id)
}

/// Create a snapshot manifest and write it as gzipped JSON.
pub fn create_snapshot(
    data_dir: &Path,
    account_id: &str,
    account_email: &str,
    mailboxes: HashMap<String, SnapshotMailbox>,
) -> Result<SnapshotInfo, String> {
    let dir = snapshot_dir(data_dir, account_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create snapshot dir: {}", e))?;

    let timestamp = Utc::now().format("%Y-%m-%dT%H-%M-%S%.3fZ").to_string();
    let filename = format!("{}.json.gz", timestamp);
    let filepath = dir.join(&filename);

    let total_emails: usize = mailboxes.values().map(|m| m.total_emails).sum();
    let mailbox_count = mailboxes.len();

    let manifest = SnapshotManifest {
        account_id: account_id.to_string(),
        account_email: account_email.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        mailboxes,
    };

    let json = serde_json::to_vec(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;

    // Gzip compress
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder
        .write_all(&json)
        .map_err(|e| format!("Failed to gzip manifest: {}", e))?;
    let compressed = encoder
        .finish()
        .map_err(|e| format!("Failed to finish gzip: {}", e))?;

    fs::write(&filepath, &compressed)
        .map_err(|e| format!("Failed to write snapshot: {}", e))?;

    let size_bytes = compressed.len() as u64;

    info!(
        "Created snapshot {} for {} ({} emails, {} mailboxes, {} bytes compressed)",
        filename, account_email, total_emails, mailbox_count, size_bytes
    );

    Ok(SnapshotInfo {
        timestamp: manifest.timestamp,
        filename,
        size_bytes,
        total_emails,
        mailbox_count,
    })
}

/// List all snapshots for an account, sorted by timestamp descending (newest first).
pub fn list_snapshots(data_dir: &Path, account_id: &str) -> Result<Vec<SnapshotInfo>, String> {
    let dir = snapshot_dir(data_dir, account_id);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut snapshots = Vec::new();

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read snapshot dir: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json.gz") {
            continue;
        }

        let meta = entry.metadata().ok();
        let size_bytes = meta.map(|m| m.len()).unwrap_or(0);

        // Quick-read: decompress and parse just the top-level fields
        match load_snapshot_info(&entry.path()) {
            Ok(mut info) => {
                info.filename = name;
                info.size_bytes = size_bytes;
                snapshots.push(info);
            }
            Err(e) => {
                warn!("Skipping corrupt snapshot {}: {}", name, e);
            }
        }
    }

    // Sort newest first
    snapshots.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(snapshots)
}

/// Read just the metadata from a snapshot file (without loading all emails).
fn load_snapshot_info(path: &Path) -> Result<SnapshotInfo, String> {
    let compressed = fs::read(path)
        .map_err(|e| format!("Failed to read snapshot: {}", e))?;

    let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
    let mut json = Vec::new();
    decoder
        .read_to_end(&mut json)
        .map_err(|e| format!("Failed to decompress snapshot: {}", e))?;

    // Parse just enough to get metadata
    let manifest: SnapshotManifest = serde_json::from_slice(&json)
        .map_err(|e| format!("Failed to parse snapshot: {}", e))?;

    let total_emails: usize = manifest.mailboxes.values().map(|m| m.total_emails).sum();

    Ok(SnapshotInfo {
        timestamp: manifest.timestamp,
        filename: String::new(),
        size_bytes: 0,
        total_emails,
        mailbox_count: manifest.mailboxes.len(),
    })
}

/// Load a full snapshot manifest by filename.
pub fn load_snapshot(
    data_dir: &Path,
    account_id: &str,
    filename: &str,
) -> Result<SnapshotManifest, String> {
    let path = snapshot_dir(data_dir, account_id).join(filename);
    if !path.exists() {
        return Err(format!("Snapshot not found: {}", filename));
    }

    let compressed = fs::read(&path)
        .map_err(|e| format!("Failed to read snapshot: {}", e))?;

    let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
    let mut json = Vec::new();
    decoder
        .read_to_end(&mut json)
        .map_err(|e| format!("Failed to decompress snapshot: {}", e))?;

    let manifest: SnapshotManifest = serde_json::from_slice(&json)
        .map_err(|e| format!("Failed to parse snapshot: {}", e))?;

    info!(
        "Loaded snapshot {} ({} emails)",
        filename,
        manifest.mailboxes.values().map(|m| m.total_emails).sum::<usize>()
    );

    Ok(manifest)
}

/// Delete a snapshot by filename.
pub fn delete_snapshot(
    data_dir: &Path,
    account_id: &str,
    filename: &str,
) -> Result<(), String> {
    let path = snapshot_dir(data_dir, account_id).join(filename);
    if !path.exists() {
        return Err(format!("Snapshot not found: {}", filename));
    }

    fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete snapshot: {}", e))?;

    info!("Deleted snapshot {}/{}", account_id, filename);
    Ok(())
}

/// Build a snapshot from the current Maildir state on disk.
/// Scans the Maildir for each mailbox and builds the manifest.
pub fn create_snapshot_from_maildir(
    data_dir: &Path,
    account_id: &str,
    account_email: &str,
) -> Result<SnapshotInfo, String> {
    let maildir_root = data_dir.join("Maildir").join(account_id);
    if !maildir_root.exists() {
        return Err(format!("No Maildir found for account {}", account_id));
    }

    let mut mailboxes = HashMap::new();

    // Scan each mailbox directory
    let entries = fs::read_dir(&maildir_root)
        .map_err(|e| format!("Failed to read Maildir: {}", e))?;

    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }

        let mailbox_name = entry.file_name().to_string_lossy().to_string();
        let cur_dir = entry.path().join("cur");

        if !cur_dir.exists() {
            continue;
        }

        let mut emails = Vec::new();

        if let Ok(email_entries) = fs::read_dir(&cur_dir) {
            for email_entry in email_entries.flatten() {
                let fname = email_entry.file_name().to_string_lossy().to_string();
                let size = email_entry.metadata().map(|m| m.len()).unwrap_or(0);

                // Parse filename: {uid}:{flags}:{timestamp} or just {uid}
                let parts: Vec<&str> = fname.splitn(3, ':').collect();
                let uid = parts.first()
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);

                let flags: Vec<String> = parts.get(1)
                    .map(|f| f.split(',').filter(|s| !s.is_empty()).map(String::from).collect())
                    .unwrap_or_default();

                // We store minimal info — subject/from/date require parsing .eml
                // For v1, store what we can extract from filename + metadata
                emails.push(SnapshotEmail {
                    uid,
                    message_id: None,
                    subject: String::new(), // Populated from cache if available
                    from: String::new(),
                    date: String::new(),
                    flags,
                    size,
                });
            }
        }

        emails.sort_by_key(|e| e.uid);
        let total_emails = emails.len();

        mailboxes.insert(mailbox_name, SnapshotMailbox {
            total_emails,
            emails,
        });
    }

    create_snapshot(data_dir, account_id, account_email, mailboxes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    fn sample_mailboxes() -> HashMap<String, SnapshotMailbox> {
        let mut mailboxes = HashMap::new();
        mailboxes.insert(
            "INBOX".to_string(),
            SnapshotMailbox {
                total_emails: 2,
                emails: vec![
                    SnapshotEmail {
                        uid: 1,
                        message_id: Some("<msg1@test.com>".to_string()),
                        subject: "Hello".to_string(),
                        from: "alice@test.com".to_string(),
                        date: "2026-04-01T10:00:00Z".to_string(),
                        flags: vec!["\\Seen".to_string()],
                        size: 1024,
                    },
                    SnapshotEmail {
                        uid: 2,
                        message_id: Some("<msg2@test.com>".to_string()),
                        subject: "Re: Hello".to_string(),
                        from: "bob@test.com".to_string(),
                        date: "2026-04-01T11:00:00Z".to_string(),
                        flags: vec![],
                        size: 2048,
                    },
                ],
            },
        );
        mailboxes.insert(
            "Sent".to_string(),
            SnapshotMailbox {
                total_emails: 1,
                emails: vec![SnapshotEmail {
                    uid: 100,
                    message_id: None,
                    subject: "Outgoing".to_string(),
                    from: "me@test.com".to_string(),
                    date: "2026-04-01T12:00:00Z".to_string(),
                    flags: vec!["\\Seen".to_string()],
                    size: 512,
                }],
            },
        );
        mailboxes
    }

    #[test]
    fn test_create_and_load_snapshot() {
        let dir = std::env::temp_dir().join("mailvault-test-snap-create");
        cleanup(&dir);

        let info = create_snapshot(&dir, "acc1", "user@test.com", sample_mailboxes()).unwrap();

        assert_eq!(info.total_emails, 3);
        assert_eq!(info.mailbox_count, 2);
        assert!(info.size_bytes > 0);
        assert!(info.filename.ends_with(".json.gz"));

        // Load it back
        let manifest = load_snapshot(&dir, "acc1", &info.filename).unwrap();
        assert_eq!(manifest.account_id, "acc1");
        assert_eq!(manifest.account_email, "user@test.com");
        assert_eq!(manifest.mailboxes.len(), 2);
        assert_eq!(manifest.mailboxes["INBOX"].emails.len(), 2);
        assert_eq!(manifest.mailboxes["INBOX"].emails[0].subject, "Hello");

        cleanup(&dir);
    }

    #[test]
    fn test_list_snapshots() {
        let dir = std::env::temp_dir().join("list-test");
        cleanup(&dir);

        // Create two snapshots with enough time gap for unique filenames
        let info1 = create_snapshot(&dir, "acc1", "user@test.com", sample_mailboxes()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let info2 = create_snapshot(&dir, "acc1", "user@test.com", sample_mailboxes()).unwrap();

        let list = list_snapshots(&dir, "acc1").unwrap();
        assert_eq!(list.len(), 2);
        // Newest first
        assert_eq!(list[0].filename, info2.filename);
        assert_eq!(list[1].filename, info1.filename);

        cleanup(&dir);
    }

    #[test]
    fn test_delete_snapshot() {
        let dir = std::env::temp_dir().join("delete-test");
        cleanup(&dir);

        let info = create_snapshot(&dir, "acc1", "user@test.com", sample_mailboxes()).unwrap();
        assert_eq!(list_snapshots(&dir, "acc1").unwrap().len(), 1);

        delete_snapshot(&dir, "acc1", &info.filename).unwrap();
        assert_eq!(list_snapshots(&dir, "acc1").unwrap().len(), 0);

        cleanup(&dir);
    }

    #[test]
    fn test_list_snapshots_empty_account() {
        let dir = std::env::temp_dir().join("empty-test");
        cleanup(&dir);

        let list = list_snapshots(&dir, "nonexistent").unwrap();
        assert!(list.is_empty());

        cleanup(&dir);
    }

    #[test]
    fn test_gzip_roundtrip_integrity() {
        let dir = std::env::temp_dir().join("mailvault-test-snap-gzip");
        cleanup(&dir);

        let info = create_snapshot(&dir, "acc1", "user@test.com", sample_mailboxes()).unwrap();
        let manifest = load_snapshot(&dir, "acc1", &info.filename).unwrap();

        // Verify all data survived the roundtrip
        let inbox = &manifest.mailboxes["INBOX"];
        assert_eq!(inbox.emails[0].uid, 1);
        assert_eq!(inbox.emails[0].message_id, Some("<msg1@test.com>".to_string()));
        assert_eq!(inbox.emails[0].flags, vec!["\\Seen"]);
        assert_eq!(inbox.emails[1].uid, 2);
        assert!(inbox.emails[1].flags.is_empty());

        let sent = &manifest.mailboxes["Sent"];
        assert_eq!(sent.emails[0].uid, 100);

        cleanup(&dir);
    }
}
