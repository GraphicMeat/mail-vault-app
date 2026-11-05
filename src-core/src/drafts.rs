//! Complete local editor revisions, independent of transport and storage.
use crate::{app_db::compose_receipts::Identity, bulk_worker::bytes_hash, smtp::OutgoingEmail};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const FLAGS: [&str; 3] = ["archived", "seen", "draft"];
fn text_or_blank<'de, D: serde::Deserializer<'de>>(value: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(value)?.unwrap_or_default())
}
/// Any base64 a file or a parsed message can hand us, as the one form the
/// builder takes: line breaks, the URL-safe alphabet, a `data:` URL prefix, no
/// padding and stray trailing bits all decode. None only for real garbage.
fn canonical_base64(raw: &str) -> Option<String> {
    use base64::{alphabet, engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig}};
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let body = if raw.starts_with("data:") { raw.split_once(',')?.1 } else { raw };
    let clean: String = body
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .map(|c| match c { '-' => '+', '_' => '/', c => c })
        .collect();
    Some(STANDARD.encode(LENIENT.decode(clean).ok()?))
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub account_id: String,
    pub mailbox: String,
    pub uid: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub account_id: String,
    pub mailbox: String,
    pub uid: u32,
    pub attachment_index: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attachment {
    #[serde(default, deserialize_with = "text_or_blank")]
    pub filename: String,
    #[serde(default, deserialize_with = "text_or_blank")]
    pub content_type: String,
    pub content: Option<String>,
    pub encoding: Option<String>,
    pub cid: Option<String>,
    pub source: Option<Source>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub html: String,
    pub text: String,
    pub in_reply_to: String,
    pub references: String,
    pub attachments: Vec<Attachment>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Save {
    pub draft_id: String,
    pub revision: u64,
    pub account_id: String,
    pub from_address: String,
    pub display_name: String,
    pub snapshot: Snapshot,
    pub snippet: String,
    pub previous_identity: Option<Location>,
    /// Names of attachments with no usable bytes. The words must still save,
    /// so these are left out of the copy and reported back to the window.
    #[serde(skip)]
    pub omitted: Vec<String>,
}
impl Save {
    pub fn parse(value: Value) -> Result<Self, String> {
        let mut request: Self = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if request.draft_id.is_empty()
            || request.draft_id.len() > 200
            || request.revision == 0
            || request.revision > 9_007_199_254_740_991
            || !crate::vault_files::is_plain_account_id(&request.account_id)
        {
            return Err("invalid draftId, revision or accountId".into());
        }
        for mut a in std::mem::take(&mut request.snapshot.attachments) {
            if a.filename.trim().is_empty() {
                a.filename = "attachment".into();
            }
            if a.content_type.trim().is_empty() {
                a.content_type = "application/octet-stream".into();
            }
            let plain = a.encoding.as_deref().is_some_and(|e| !e.eq_ignore_ascii_case("base64"));
            a.content = a.content.take().and_then(|content| {
                if plain { Some(STANDARD.encode(content)) } else { canonical_base64(&content) }
            });
            if plain {
                a.encoding = Some("base64".into());
            }
            if a.content.is_none() && a.source.is_none() {
                request.omitted.push(a.filename);
            } else {
                request.snapshot.attachments.push(a);
            }
        }
        Ok(request)
    }
    pub fn request_hash(&self) -> String {
        let mut content = self.clone();
        content.draft_id.clear();
        content.revision = 1;
        content.previous_identity = None;
        bytes_hash(&serde_json::to_vec(&content).expect("typed draft request"))
    }
    pub fn content_hash(&self) -> String {
        // Resolved descriptors carry canonical bytes, no mutable source hint.
        let mut content = self.clone();
        content.draft_id.clear();
        content.revision = 1;
        content.previous_identity = None;
        for a in &mut content.snapshot.attachments {
            a.source = None;
            a.encoding = None;
        }
        bytes_hash(&serde_json::to_vec(&content).expect("typed draft snapshot"))
    }
    pub fn outgoing(&self) -> Result<OutgoingEmail, String> {
        serde_json::from_value(serde_json::to_value(&self.snapshot).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
    pub fn row(&self, uid: u32, mid: &str, date: &str) -> Value {
        // Keep the source JS index split; MIME remains the reopen envelope.
        let to: Vec<_> = self
            .snapshot
            .to
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|a| json!({"address":a,"name":""}))
            .collect();
        json!({"uid":uid,"from":{"address":self.from_address,"name":self.display_name},"to":to,"subject":self.snapshot.subject,"date":date,"has_attachments":!self.snapshot.attachments.is_empty(),"message_id":mid,"in_reply_to":if self.snapshot.in_reply_to.is_empty(){Value::Null}else{json!(self.snapshot.in_reply_to)},"references":if self.snapshot.references.is_empty(){Value::Null}else{json!(self.snapshot.references)},"snippet":crate::compose::snippet_of(&self.snippet),"flags":FLAGS,"source":"local_draft"})
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Copy {
    pub identity: Identity,
    pub entry: Value,
}
impl Copy {
    pub fn location(&self) -> Location {
        let s = &self.identity.scope;
        Location {
            account_id: s.account_id.clone(),
            mailbox: s.mailbox.clone(),
            uid: s.uid,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub attempt_id: String,
    pub epoch: u64,
    pub revision: u64,
    pub request_hash: String,
    pub fingerprint: String,
    pub copy: Copy,
    pub prepared: Copy,
    pub root: std::path::PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryConstraint {
    pub revision: u64,
    pub request_hash: String,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub version: u32,
    pub draft_id: String,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub retry: Option<RetryConstraint>,
    pub revision: u64,
    pub request_hash: Option<String>,
    pub fingerprint: Option<String>,
    pub current: Option<Copy>,
    pub pending: Option<Intent>,
    pub cleanup: Vec<Copy>,
    pub discarded: bool,
}
impl Record {
    pub fn new(id: &str) -> Self {
        Self {
            version: 1,
            draft_id: id.into(),
            epoch: 0,
            retry: None,
            revision: 0,
            request_hash: None,
            fingerprint: None,
            current: None,
            pending: None,
            cleanup: vec![],
            discarded: false,
        }
    }
}
/// Entire nested SPECIAL-USE search precedes the case-insensitive name search.
pub fn drafts_mailbox(boxes: &Value) -> String {
    fn find(boxes: &Value, role: bool) -> Option<String> {
        for b in boxes.as_array()? {
            let matched = if role {
                b["specialUse"] == "\\Drafts" || b["special_use"] == "\\Drafts"
            } else {
                ["name", "path"].iter().any(|k| {
                    b[k].as_str()
                        .is_some_and(|s| s.eq_ignore_ascii_case("Drafts"))
                })
            };
            if matched {
                if let Some(path) = b["path"].as_str() {
                    return Some(path.into());
                }
            }
            if let Some(p) = find(&b["children"], role) {
                return Some(p);
            }
        }
        None
    }
    find(boxes, true)
        .or_else(|| find(boxes, false))
        .unwrap_or_else(|| "Drafts".into())
}
/// The `eml` a reopened draft is shown from: the parsed message, plus
/// `draftRecipients`, the To/Cc/Bcc text exactly as it was typed when the
/// bytes carry it (`smtp::local_draft_recipients`). The parsed address lists
/// cannot give that text back whole (a trailing comma is dropped, and one
/// entry without an `@` beside a named address turns the header into a single
/// pseudo-address). The window prefers `draftRecipients` and falls back to the
/// parsed lists when it is absent (`_recipientText` in localDrafts.js).
pub fn reopened_eml(raw: &[u8], uid: u32) -> Result<Value, String> {
    let parsed = crate::vault_eml::parse_eml_bytes(raw, uid, FLAGS.map(String::from).to_vec())?;
    let mut eml = serde_json::to_value(parsed).map_err(|e| e.to_string())?;
    if let Some(typed) = crate::smtp::local_draft_recipients(raw) {
        eml["draftRecipients"] = typed;
    }
    Ok(eml)
}
pub fn editable(row: &Value) -> bool {
    row["source"] == "local_draft"
        && ["archived", "draft"].iter().all(|f| {
            row["flags"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == f))
        })
}
