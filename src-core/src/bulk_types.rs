//! Plain data a stored bulk job and the `app_db` tables share. A leaf below
//! both: `bulk_worker` re-exports every item, `app_db` imports from here.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum Identity {
    Imap {
        validity: u32,
        #[serde(deserialize_with = "uid_map")]
        message_ids: HashMap<u32, String>,
    },
    Jmap {
        mailbox_id: String,
        #[serde(deserialize_with = "uid_map")]
        ids: HashMap<u32, String>,
    },
    Graph {
        #[serde(deserialize_with = "uid_map")]
        ids: HashMap<u32, String>,
    },
}
fn uid_map<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<u32, String>, D::Error> {
    let values = HashMap::<String, String>::deserialize(deserializer)?;
    values
        .into_iter()
        .map(|(key, value)| {
            let uid = key.parse::<u32>().map_err(serde::de::Error::custom)?;
            if uid.to_string() != key {
                return Err(serde::de::Error::custom("noncanonical UID key"));
            }
            Ok((uid, value))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProof {
    pub uid: u32,
    pub name: String,
    pub sha256: String,
}
pub fn bytes_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
