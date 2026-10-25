use mailvault_core::compose_prep::{self, Context};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub fn fixture() -> Value { serde_json::from_str(include_str!("../fixtures/compose-prep-supplement.json")).unwrap() }
pub fn message(spec: &Value, index: Option<usize>) -> Value {
    let tag=index.map(|i|format!("context-{i}")).unwrap_or_else(||"original".into());
    let repeat=spec[if index.is_some(){"contextRepeat"}else{"originalRepeat"}].as_u64().unwrap() as usize;
    let words=format!("START-{tag}:{}:END-{tag}",spec["unit"].as_str().unwrap().repeat(repeat));
    let mut out=json!({"header":{"from":{"name":"<From & Name>","address":format!("{tag}@example.test")},"to":[{"address":"owner@example.test"}],"subject":format!("Subject <&> {tag}"),"date":format!("stamp-{tag}"),"bcc":[{"address":"bcc-large-sentinel@example.test"}]}});
    if spec["text"]==true {out["text"]=json!(words)}else{out["html"]=json!(format!("<table style=\"color:red\"><tr><td>{words}<img src=\"cid:logo\"></td></tr></table>"))} out
}
pub fn request(case: &Value) -> Value {
    let spec=&case["spec"];
    let context:Vec<Value>=(0..spec["count"].as_u64().unwrap() as usize).map(|i|json!({"original":message(spec,Some(i)),"dateLabel":format!("date:stamp-context-{i}")})).collect();
    json!({"kind":"message","requestId":spec["name"],"accountId":"one","mode":spec["mode"],"original":message(spec,None),"selectedQuoteHtml":spec["selected"],"threadContext":context,"presentation":{"originalLabel":"Original message","dateLabel":"date:stamp-original","subjectCandidate":"Re: Topic"}})
}
pub fn context() -> Context { Context{accounts:serde_json::from_value(json!([{"id":"one","email":"owner@example.test"}])).unwrap(),settings:json!({}),settings_version:7} }
pub fn assert_digests(case:&Value,out:&Value) {
    for (key,expected) in case["digests"].as_object().unwrap() {
        let bytes=out[key].as_str().unwrap().as_bytes();
        assert_eq!(bytes.len() as u64,expected["bytes"].as_u64().unwrap(),"{} {key} length",case["spec"]["name"]);
        assert_eq!(format!("{:x}",Sha256::digest(bytes)),expected["sha256"].as_str().unwrap(),"{} {key} bytes",case["spec"]["name"]);
        assert!(!out[key].as_str().unwrap().contains("bcc-large-sentinel"));
    }
}
pub fn prepare(case:&Value)->Value { compose_prep::reply_context(&request(case),&context()).unwrap() }
