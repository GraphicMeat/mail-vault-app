use mailvault_core::{app_db::{self,drafts as db,compose_receipts::{Identity,Scope}},drafts::{Copy,Record}};
use serde_json::json;
#[test]
fn draft_metadata_claims_are_exclusive_and_transitions_compare_full_old_state(){
 let directory=tempfile::tempdir().unwrap();let connection=app_db::db::open(directory.path()).unwrap();let raw=b"Message-ID: <native@example.test>\r\n\r\nwords";let proof=Identity::from_bytes(Scope::new("one","Legacy",42,"native@example.test").unwrap(),raw).unwrap();let mut first=Record::new("first");first.current=Some(Copy{identity:proof,entry:json!({"source":"local_draft"})});db::save(&connection,&first).unwrap();let mut competing=first.clone();competing.draft_id="second".into();assert!(db::save(&connection,&competing).is_err());assert!(db::load(&connection,"second").unwrap().is_none());let mut next=first.clone();next.epoch=1;db::save_if(&connection,&first,&next).unwrap();assert!(db::save_if(&connection,&first,&first).is_err());assert_eq!(db::load(&connection,"first").unwrap().unwrap().epoch,1);
}
#[test]
fn schema_eleven_preserves_existing_nullable_protected_purge_proofs(){
 let directory=tempfile::tempdir().unwrap();let connection=app_db::db::open(directory.path()).unwrap();connection.execute_batch("DROP TABLE local_draft_locations; DROP TABLE local_drafts; UPDATE meta SET value='10' WHERE key='schema_version'; INSERT INTO pending_backup_purge(scope,uid,proof_json) VALUES ('legacy',42,NULL);").unwrap();drop(connection);let reopened=app_db::db::open(directory.path()).unwrap();let proof:Option<String>=reopened.query_row("SELECT proof_json FROM pending_backup_purge WHERE scope='legacy' AND uid=42",[],|r|r.get(0)).unwrap();assert_eq!(proof,None);assert!(db::all(&reopened).unwrap().is_empty());
}
