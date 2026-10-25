use mailvault_core::{drafts::{self,Save},imap::ImapConfig,smtp,vault_eml};
use serde_json::{json,Value};
fn corpus()->Value {serde_json::from_str(include_str!("fixtures/local-draft-cases.json")).unwrap()}
fn case(name:&str)->Value {corpus()["cases"].as_array().unwrap().iter().find(|c|c["name"]==name).unwrap().clone()}
fn request(name:&str)->Value {let c=case(name);json!({"draftId":"parity","revision":1,"accountId":"one","fromAddress":c["input"]["fromAddress"],"displayName":c["input"]["displayName"],"snapshot":c["input"]["payload"],"snippet":c["input"]["snippet"]})}
#[test]
fn drafts_rows_and_mailbox_resolution_match_frozen_js(){
    for name in ["complete-alias-threaded-attachment","no-recipients"] {let c=case(name);let r=Save::parse(request(name)).unwrap();assert_eq!(r.row(42,"<fixed@example.test>","2026-10-25T00:00:00.000Z"),c["output"]["entry"]);}
    for name in ["active-nested-role-before-name","cached-role","case-insensitive-name","literal-fallback"] {let c=case(name);let boxes=c["input"].get("list").or(c["input"].get("cached")).cloned().unwrap_or(json!([]));assert_eq!(json!(drafts::drafts_mailbox(&boxes)),c["output"]);}
}
#[test]
fn drafts_complete_fields_clearing_and_bytes_are_content(){
    let empty=request("no-recipients");assert!(Save::parse(empty.clone()).is_ok());
    for key in ["to","cc","bcc","subject","html","text","inReplyTo","references","attachments"] {let mut v=empty.clone();v["snapshot"].as_object_mut().unwrap().remove(key);assert!(Save::parse(v).unwrap_err().contains(key));}
    let mut v=request("complete-alias-threaded-attachment");let a=Save::parse(v.clone()).unwrap();v["snapshot"]["attachments"][0]["content"]=json!("AwIB");let b=Save::parse(v).unwrap();assert_ne!(a.content_hash(),b.content_hash());
    let mut v=empty;v["snapshot"]["attachments"]=json!([{"filename":"empty","contentType":"application/octet-stream","content":""}]);assert!(Save::parse(v).is_ok());
}
#[test]
fn drafts_mime_roundtrip_retains_envelope_threading_and_bytes(){
    let r=Save::parse(request("complete-alias-threaded-attachment")).unwrap();
    let account:ImapConfig=serde_json::from_value(json!({"email":"one@example.test","imapHost":"offline.invalid","name":"Alias","fromEmail":"alias@example.test"})).unwrap();
    let raw=smtp::build_draft_mime(&account,&r.outgoing().unwrap()).unwrap().raw_rfc2822;
    let parsed=vault_eml::parse_eml_bytes(&raw,42,vec![]).unwrap();
    let mime=mailparse::parse_mail(&raw).unwrap();
    use mailparse::MailHeaderMap;
    let header=mime.headers.get_first_header("To").unwrap();
    let to=header.get_value();
    let original=case("complete-alias-threaded-attachment")["input"]["payload"].clone();
    let direct:smtp::OutgoingEmail=serde_json::from_value(original).unwrap();
    assert_eq!(r.snapshot.to,r.outgoing().unwrap().to);assert_eq!(r.snapshot.to,direct.to);
    let direct_raw=smtp::build_draft_mime(&account,&direct).unwrap().raw_rfc2822;
    let direct_mail=mailparse::parse_mail(&direct_raw).unwrap();
    println!("ROW12_FIXED_DIRECT_TO raw={:?} decoded={:?}",direct_mail.headers.get_first_header("To").unwrap().get_value_raw(),direct_mail.headers.get_first_value("To"));
    println!("ROW12_FIXED_HEADER raw={:?} header_aware={:?}",header.get_value_raw(),mailparse::addrparse_header(header));
    println!("ROW12_FIXED_RECIPIENT_DIAGNOSTIC outgoing={} to_header={:?} addrparse={:?} parsed={:?}",r.snapshot.to,to,mailparse::addrparse(&to),parsed.to);

    assert_eq!(parsed.from.address,"alias@example.test");assert_eq!(parsed.to.iter().map(|a|a.address.as_str()).collect::<Vec<_>>(),vec!["jane@example.test","next@example.test"]);assert_eq!(parsed.cc[0].address,"copy@example.test");assert_eq!(parsed.bcc[0].address,"blind@example.test");
    assert!(parsed.html.unwrap().contains("Words"));assert_eq!(parsed.attachments[0].content,"AAEC");
    let headers=String::from_utf8_lossy(&raw);assert!(headers.contains("In-Reply-To: <parent@example.test>"));assert!(headers.contains("<root@example.test>"));
}
