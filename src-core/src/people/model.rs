use serde::{Deserialize, Serialize};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
pub fn new_id() -> String { uuid::Uuid::new_v4().to_string() }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRow {
    pub id: String,
    pub display_name: String,
    pub notes: String,
    pub vip: bool,
    pub pinned: bool,
    pub blocked: bool,
    pub search_text: String,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub deleted_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRow {
    pub id: String,
    pub account_id: String,
    pub source_kind: String,
    pub remote_id: String,
    pub etag: String,
    pub raw: String,
    pub tombstone: bool,
    pub fetched_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardEmail { pub address: String, pub label: String, pub record_id: String }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPhone { pub number: String, pub label: String, pub record_id: String }

/// The resolved person the UI shows: the person row plus what its records say.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub display_name: String,
    pub emails: Vec<CardEmail>,
    pub phones: Vec<CardPhone>,
    pub org: String,
    pub notes: String,
    pub vip: bool,
    pub pinned: bool,
    pub blocked: bool,
    pub record_ids: Vec<String>,
    pub source_kinds: Vec<String>,
}
