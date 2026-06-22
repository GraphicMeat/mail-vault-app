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

/// Parse Maildir flags from a filename in EITHER format and return a
/// space-joined IMAP flag string. archived/trashed are local-only and dropped.
///
/// Tauri format:  `{uid}:2,{LETTERS}.eml`  (letters: S F R D A T)
/// Core format:   `{uid}:{word,word}:{ts}.eml`  (words: seen,flagged,replied,draft,...)
pub fn parse_local_flags(filename: &str) -> String {
    let name = filename.strip_suffix(".eml").unwrap_or(filename);

    let mut out: Vec<&str> = Vec::new();
    let push = |out: &mut Vec<&str>, flag: &'static str| {
        if !out.contains(&flag) {
            out.push(flag);
        }
    };

    if let Some(letters) = name.split(":2,").nth(1) {
        let letters = letters.split(':').next().unwrap_or("");
        for c in letters.chars() {
            match c {
                'S' => push(&mut out, "\\Seen"),
                'F' => push(&mut out, "\\Flagged"),
                'R' => push(&mut out, "\\Answered"),
                'D' => push(&mut out, "\\Draft"),
                _ => {}
            }
        }
    } else {
        let parts: Vec<&str> = name.splitn(3, ':').collect();
        if let Some(words) = parts.get(1) {
            for w in words.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                match w.to_lowercase().as_str() {
                    "seen" => push(&mut out, "\\Seen"),
                    "flagged" => push(&mut out, "\\Flagged"),
                    "replied" | "answered" => push(&mut out, "\\Answered"),
                    "draft" => push(&mut out, "\\Draft"),
                    _ => {}
                }
            }
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_local_flags_tauri_format() {
        assert_eq!(parse_local_flags("123:2,FS.eml"), "\\Flagged \\Seen");
        assert_eq!(parse_local_flags("9:2,R.eml"), "\\Answered");
        assert_eq!(parse_local_flags("9:2,AS.eml"), "\\Seen");
        assert_eq!(parse_local_flags("9:2,.eml"), "");
    }

    #[test]
    fn test_parse_local_flags_core_format() {
        assert_eq!(parse_local_flags("123:seen,flagged:1700000000.eml"), "\\Seen \\Flagged");
        assert_eq!(parse_local_flags("123:replied:1700000000.eml"), "\\Answered");
        assert_eq!(parse_local_flags("123::1700000000.eml"), "");
    }

    #[test]
    fn test_parse_local_flags_none() {
        assert_eq!(parse_local_flags("123.eml"), "");
        assert_eq!(parse_local_flags("123:.eml"), "");
    }
}
