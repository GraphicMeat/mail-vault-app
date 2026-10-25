//! Private native backup handoff identities and saved-slot change detection.
//! The stamp fences a native observation; it grants no filesystem access.
use crate::app_db;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attempt {
    pub incarnation: String,
    pub run_id: String,
    pub execution_id: String,
    pub owner_id: String,
    pub acquisition_id: String,
}
impl Attempt {
    pub fn valid(&self) -> bool {
        [&self.incarnation, &self.run_id, &self.execution_id, &self.owner_id, &self.acquisition_id]
            .iter().all(|s| !s.is_empty() && s.len() <= 256)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Resolution {
    Authorized { root: String },
    NotConfigured,
    Unavailable,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attach {
    pub attempt: Attempt,
    pub slot_stamp: Option<String>,
    pub resolution: Resolution,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub attempt: Attempt,
    #[serde(default)]
    pub fence_unstarted: bool,
}
/// Read every saved authority byte fallibly. NULL/invalid SQL types and failed
/// reads are unknown, never absence. Hashing avoids exposing bookmark bytes.
pub fn slot_stamp(path: &Path) -> Result<Option<String>, String> {
    app_db::with(path, |conn| {
        let row = conn.query_row(
            "SELECT display_path, platform, saved_at, legacy, bookmark FROM external_locations WHERE slot='external-backup'",
            [], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,Option<Vec<u8>>>(4)?)),
        ).optional().map_err(|e| e.to_string())?;
        row.map(|row| serde_json::to_vec(&row).map(|bytes| format!("{:x}",Sha256::digest(bytes))).map_err(|e|e.to_string())).transpose()
    })
}
