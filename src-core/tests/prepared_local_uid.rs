use mailvault_core::{message_store::{self,Format},jmap_store::record::ServerIds};
use serde_json::Value;
#[test]
fn local_prepared_uid_binding_commits_both_formats_without_changing_content(){
 let raw=b"From: a@example.test\r\nTo: b@example.test\r\nMessage-ID: <local@example.test>\r\nReferences: <root@example.test>\r\n\r\nlocal body";
 for format in [Format::Maildir,Format::Jmap]{let root=tempfile::tempdir().unwrap();message_store::set_vault_format(root.path(),format).unwrap();let prepared=message_store::prepare(root.path(),"one","Drafts",1,raw.to_vec(),&["archived".into()],Some("2026-10-25T00:00:00Z"),format).unwrap();let rebound=prepared.clone().with_local_uid(42).unwrap();assert_eq!(rebound.raw(),raw);assert_eq!(rebound.uid(),42);message_store::commit(root.path(),"one","Drafts",&prepared,&["archived".into()]).unwrap();let entry=message_store::commit(root.path(),"one","Drafts",&rebound,&["archived".into()]).unwrap();assert!(entry.name.starts_with("42"));assert_eq!(message_store::read_raw(root.path(),"one","Drafts",42).unwrap().unwrap(),raw);
 if format==Format::Jmap {let dir=message_store::mailbox_dir(root.path(),"one","Drafts").join("jmap");let old:Value=serde_json::from_slice(&std::fs::read(dir.join("1.json")).unwrap()).unwrap();let mut new:Value=serde_json::from_slice(&std::fs::read(dir.join("42.json")).unwrap()).unwrap();assert_eq!(new["uid"],42);assert!(new["email"]["id"].as_str().unwrap().starts_with("L42-"));new["uid"]=old["uid"].clone();new["email"]["id"]=old["email"]["id"].clone();assert_eq!(new,old,"blob/thread/receivedAt/mailboxIds/recipients/flags stay exact");}
 let server=prepared.with_server_ids(ServerIds{email_id:"server-id".into(),blob_id:"server-blob".into(),thread_id:Some("server-thread".into())});assert!(server.with_local_uid(43).is_err());}
}
