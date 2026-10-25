//! Complete local editor revisions, independent of transport and storage.
use crate::{app_db::compose_receipts::Identity, bulk_worker::bytes_hash, smtp::OutgoingEmail};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const FLAGS: [&str; 3] = ["archived", "seen", "draft"];
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Location { pub account_id: String, pub mailbox: String, pub uid: u32 }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Source { pub account_id: String, pub mailbox: String, pub uid: u32, pub attachment_index: usize }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Attachment {
    pub filename: String, pub content_type: String,
    pub content: Option<String>, pub encoding: Option<String>, pub cid: Option<String>, pub source: Option<Source>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub to: String, pub cc: String, pub bcc: String, pub subject: String, pub html: String, pub text: String,
    pub in_reply_to: String, pub references: String, pub attachments: Vec<Attachment>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Save {
    pub draft_id: String, pub revision: u64, pub account_id: String, pub from_address: String, pub display_name: String,
    pub snapshot: Snapshot, pub snippet: String, pub previous_identity: Option<Location>,
}
impl Save {
    pub fn parse(value: Value) -> Result<Self,String> {
        let request:Self=serde_json::from_value(value).map_err(|e|e.to_string())?;
        if request.draft_id.is_empty() || request.draft_id.len()>200 || request.revision==0 || request.revision>9_007_199_254_740_991 || !crate::vault_files::is_plain_account_id(&request.account_id) {return Err("invalid draftId, revision or accountId".into());}
        for a in &request.snapshot.attachments {
            if a.encoding.as_deref().is_some_and(|e|e!="base64") || (a.content.is_none() && a.source.is_none()) {return Err("attachments require base64 content or source".into());}
            if let Some(content)=&a.content {STANDARD.decode(content).map_err(|_|"invalid attachment base64")?;}
        }
        Ok(request)
    }
    pub fn request_hash(&self)->String {bytes_hash(&serde_json::to_vec(self).expect("typed draft request"))}
    pub fn content_hash(&self)->String {
        // Resolved descriptors carry canonical bytes, no mutable source hint.
        let mut content=self.clone(); content.draft_id.clear(); content.revision=1; content.previous_identity=None;
        for a in &mut content.snapshot.attachments {a.source=None;a.encoding=None;}
        bytes_hash(&serde_json::to_vec(&content).expect("typed draft snapshot"))
    }
    pub fn outgoing(&self)->Result<OutgoingEmail,String> {serde_json::from_value(serde_json::to_value(&self.snapshot).map_err(|e|e.to_string())?).map_err(|e|e.to_string())}
    pub fn row(&self,uid:u32,mid:&str,date:&str)->Value {
        // Keep the source JS index split; MIME remains the reopen envelope.
        let to:Vec<_>=self.snapshot.to.split(',').map(str::trim).filter(|s|!s.is_empty()).map(|a|json!({"address":a,"name":""})).collect();
        json!({"uid":uid,"from":{"address":self.from_address,"name":self.display_name},"to":to,"subject":self.snapshot.subject,"date":date,"has_attachments":!self.snapshot.attachments.is_empty(),"message_id":mid,"in_reply_to":if self.snapshot.in_reply_to.is_empty(){Value::Null}else{json!(self.snapshot.in_reply_to)},"references":if self.snapshot.references.is_empty(){Value::Null}else{json!(self.snapshot.references)},"snippet":crate::compose::snippet_of(&self.snippet),"flags":FLAGS,"source":"local_draft"})
    }
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Copy {pub identity:Identity,pub entry:Value}
impl Copy {pub fn location(&self)->Location {let s=&self.identity.scope;Location{account_id:s.account_id.clone(),mailbox:s.mailbox.clone(),uid:s.uid}}}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Intent {pub revision:u64,pub request_hash:String,pub fingerprint:String,pub copy:Copy,pub prepared:Copy,pub root:std::path::PathBuf}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Record {
    pub version:u32,pub draft_id:String,pub revision:u64,pub request_hash:Option<String>,pub fingerprint:Option<String>,pub current:Option<Copy>,
    pub pending:Option<Intent>,pub cleanup:Vec<Copy>,pub discarded:bool,
}
impl Record {pub fn new(id:&str)->Self {Self{version:1,draft_id:id.into(),revision:0,request_hash:None,fingerprint:None,current:None,pending:None,cleanup:vec![],discarded:false}}}
/// Entire nested SPECIAL-USE search precedes the case-insensitive name search.
pub fn drafts_mailbox(boxes:&Value)->String {
    fn find(boxes:&Value,role:bool)->Option<String>{for b in boxes.as_array()? {let matched=if role {b["specialUse"]=="\\Drafts"||b["special_use"]=="\\Drafts"}else{["name","path"].iter().any(|k|b[k].as_str().is_some_and(|s|s.eq_ignore_ascii_case("Drafts")))};if matched {if let Some(path)=b["path"].as_str(){return Some(path.into());}}if let Some(p)=find(&b["children"],role){return Some(p);}}None}
    find(boxes,true).or_else(||find(boxes,false)).unwrap_or_else(||"Drafts".into())
}
pub fn editable(row:&Value)->bool {row["source"]=="local_draft"&&FLAGS.iter().all(|f|row["flags"].as_array().is_some_and(|a|a.iter().any(|v|v==f)))}
