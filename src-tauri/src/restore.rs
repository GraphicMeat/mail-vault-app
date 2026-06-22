//! Restore engine — re-upload locally-stored Maildir emails to a (new, empty)
//! IMAP server. Source = local disk, dest = live IMAP. Reuses migration.rs
//! helpers for folder-create, dedup, and Message-ID extraction.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::imap::{self, ImapConfig, ImapPool};
use crate::migration;

#[derive(Clone, Debug, Serialize)]
pub struct RestoreProgress {
    pub account_id: String,
    pub email: String,
    pub total_emails: u32,
    pub uploaded_emails: u32,
    pub skipped_emails: u32,
    pub failed_emails: u32,
    pub current_folder: Option<String>,
    pub folder_progress: Option<String>,
    pub status: String, // "running" | "completed" | "cancelled" | "failed"
}

pub struct RestoreCancelToken(pub std::sync::Mutex<Arc<AtomicBool>>);
impl Default for RestoreCancelToken {
    fn default() -> Self {
        RestoreCancelToken(std::sync::Mutex::new(Arc::new(AtomicBool::new(false))))
    }
}

/// One local message ready to upload.
#[derive(Debug, Clone)]
pub struct LocalMsg {
    pub uid: u32,
    pub imap_flags: String, // e.g. "\\Seen \\Flagged", possibly empty
    pub path: PathBuf,
}
