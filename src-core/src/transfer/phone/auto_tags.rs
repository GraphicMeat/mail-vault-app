//! The desktop's Auto Tag rules in a phone bundle: each rule whose tag the code can name.
//!
//! A rule names its tag by id; on the way it names it by name instead (the phone's tag ids are
//! its own; an import maps it back, the tags block having brought the tags). A rule whose tag is
//! gone is left out. What a rule was allowed to send to travels as the endpoint's URL and model
//! only (never a key: desktop keeps none in a rule); an on-device provider travels as none, since
//! the phone has no on-device model. When a rule was turned on does not travel: the phone turns
//! an enabled rule on as of the import, so it never reaches back over mail already there (that
//! is a Backfill's). Decisions and backfill batches stay on the desktop.
//!
//! Wire shape (`autoTags` beside `views`): `{"list": [{"id", "name", "instruction",
//! "constraints", "tag", "inboxAction", "minConfidence", "allowRemote", "endpoint": {url, model}
//! | null, "enabled"}]}`. Read leniently like the tags.
//!
//! Room: [`fit`] runs after the views and gives the rules at most [`AUTO_TAGS_BUDGET_BYTES`]
//! deflated: as many rules as fit, in the desktop's order.
use super::PhoneBundle;
use crate::app_db::auto_tags::{self, Constraints, InboxAction};
use crate::app_db::tags;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Deflated bytes the rules may add to the code: about two frames.
pub const AUTO_TAGS_BUDGET_BYTES: usize = 2 * super::frames::CHUNK_BYTES;
/// Plain JSON bytes the rules may add.
pub const AUTO_TAGS_PLAIN_BYTES: usize = 32 * 1024;

/// The endpoint a rule was allowed to send to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneEndpoint {
    pub url: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAutoTag {
    pub id: String,
    pub name: String,
    pub instruction: String,
    #[serde(default)]
    pub constraints: Constraints,
    /// The tag's name.
    pub tag: String,
    pub inbox_action: InboxAction,
    pub min_confidence: f64,
    #[serde(default)]
    pub allow_remote: bool,
    #[serde(default)]
    pub endpoint: Option<PhoneEndpoint>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PhoneAutoTags {
    #[serde(default)]
    pub list: Vec<PhoneAutoTag>,
}

/// The endpoint of a rule's `provider` (desktop's `llm::Provider` JSON), when it is one.
fn endpoint_of(provider: &Value) -> Option<PhoneEndpoint> {
    if provider.get("type").and_then(Value::as_str) != Some("endpoint") {
        return None;
    }
    let url = provider.get("url").and_then(Value::as_str)?.trim();
    if url.is_empty() {
        return None;
    }
    Some(PhoneEndpoint { url: url.to_string(), model: provider.get("model").and_then(Value::as_str).unwrap_or("").to_string() })
}

/// The provider a rule gets on the phone from what travelled.
pub fn provider_of(endpoint: Option<&PhoneEndpoint>) -> Value {
    match endpoint {
        Some(e) => serde_json::json!({ "type": "endpoint", "url": e.url, "model": e.model }),
        None => Value::Null,
    }
}

/// The desktop's rules as the phone takes them: those whose tag exists. `None` when there are
/// none.
pub fn snapshot(conn: &Connection) -> Result<Option<PhoneAutoTags>, String> {
    let rules = auto_tags::list(conn)?;
    if rules.is_empty() {
        return Ok(None);
    }
    let tag_name: HashMap<String, String> = tags::list(conn)?.into_iter().map(|t| (t.id, t.name.trim().to_string())).collect();
    let list = rules
        .into_iter()
        .filter_map(|r| {
            let tag = tag_name.get(&r.tag_id).filter(|n| !n.is_empty())?.clone();
            Some(PhoneAutoTag {
                id: r.id,
                name: r.name,
                instruction: r.instruction,
                constraints: r.constraints,
                tag,
                inbox_action: r.inbox_action,
                min_confidence: r.min_confidence,
                allow_remote: r.allow_remote,
                endpoint: endpoint_of(&r.provider),
                enabled: r.enabled,
            })
        })
        .collect();
    Ok(Some(PhoneAutoTags { list }))
}

/// Cuts `bundle.auto_tags` to fit (see the module doc). Run after the views were fit. Returns
/// how many rules were left out.
pub fn fit(bundle: &mut PhoneBundle) -> usize {
    let Some(block) = bundle.auto_tags.take() else { return 0 };
    let total = block.list.len();
    let with = |keep: usize| PhoneAutoTags { list: block.list[..keep].to_vec() };
    let kept = super::fields::most_that_fit(bundle, total, AUTO_TAGS_BUDGET_BYTES, AUTO_TAGS_PLAIN_BYTES, &|b, n| b.auto_tags = n.map(&with));
    total - kept.unwrap_or(0)
}
