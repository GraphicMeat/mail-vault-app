//! `mobile.accounts.*` against the mock IMAP server and an in-memory secret store.

use mailvault_mobile_engine::{Engine, SecretStore};
use mock_imap::state::synthetic_mailbox;
use mock_imap::{Action, MockImap, Scenario, Trigger};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PW: &str = "correct-horse-battery-staple";

/// A secret store that can say whether it holds anything at all.
#[derive(Default)]
struct Spy {
    map: Mutex<HashMap<String, String>>,
    /// Runs inside `set`, to sabotage the database between the secret write and the row insert.
    on_set: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl Spy {
    fn is_empty(&self) -> bool {
        self.map.lock().unwrap().is_empty()
    }
}

impl SecretStore for Spy {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.map.lock().unwrap().get(id).cloned())
    }
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        if let Some(f) = self.on_set.lock().unwrap().as_ref() {
            f();
        }
        self.map.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.map.lock().unwrap().remove(id);
        Ok(())
    }
}

fn engine(dir: &std::path::Path) -> (Engine, Arc<Spy>) {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let secrets = Arc::new(Spy::default());
    let e = Engine::open(dir, &dir.join("cache"), secrets.clone()).unwrap();
    (e, secrets)
}

fn form(server: &MockImap, email: &str, password: &str) -> Value {
    json!({ "email": email, "password": password, "imapHost": server.host(), "imapPort": server.port(), "security": "none" })
}

fn good_server() -> MockImap {
    MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 4)))
}

fn list(e: &Engine) -> Vec<Value> {
    e.rpc("mobile.accounts.list", json!({})).unwrap()["accounts"].as_array().unwrap().clone()
}

#[test]
fn add_then_list_never_returns_the_password() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let server = good_server();
    let added = e.rpc("mobile.accounts.add", form(&server, "u@example.test", PW)).unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let id = added["account"]["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("acc_") && id.len() == 20 && id[4..].chars().all(|c| c.is_ascii_hexdigit()), "{id}");
    let reply = e.rpc("mobile.accounts.list", json!({})).unwrap();
    let text = reply.to_string();
    assert_eq!(reply["accounts"].as_array().unwrap().len(), 1);
    assert!(!text.contains("\"password\"") && !text.contains(PW), "{text}");
    assert!(!added.to_string().contains(PW));
    let a = &reply["accounts"][0];
    assert_eq!(a["id"], id.as_str());
    assert_eq!(a["email"], "u@example.test");
    assert_eq!(a["imapHost"], server.host().as_str());
    assert_eq!(a["imapPort"], server.port());
    assert_eq!(a["security"], "none");
    assert_eq!(secrets.get(&id).unwrap().as_deref(), Some(PW));
    // The password is not in the database file either.
    let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
    let hits: i64 = c
        .query_row("SELECT count(*) FROM accounts WHERE instr(email || display_name || imap_host || security, ?1) > 0", [PW], |r| r.get(0))
        .unwrap();
    assert_eq!(hits, 0);
}

#[test]
fn test_reports_the_message_count_and_stores_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let server = good_server();
    let r = e.rpc("mobile.accounts.test", form(&server, "u@example.test", PW)).unwrap();
    assert_eq!(r, json!({ "ok": true, "messageCount": 4 }));
    assert!(list(&e).is_empty());
    assert!(secrets.is_empty());
}

fn rejecting_server() -> MockImap {
    MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 1))
            .fault(Trigger::on("LOGIN"), Action::Respond("NO".into(), "[AUTHENTICATIONFAILED] Invalid credentials".into())),
    )
}

#[test]
fn wrong_password_adds_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let server = rejecting_server();
    let r = e.rpc("mobile.accounts.add", form(&server, "u@example.test", "wrong")).unwrap();
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "AUTH_FAILED", "{r}");
    assert!(!r.to_string().contains("wrong"));
    assert!(list(&e).is_empty());
    let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
    let n: i64 = c.query_row("SELECT count(*) FROM accounts", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    assert!(secrets.is_empty(), "a failed login must leave no secret");
}

#[test]
fn unreachable_host_is_typed() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    // Reserve a free port, then close it so nothing listens there.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let t0 = Instant::now();
    let r = e
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": PW, "imapHost": "127.0.0.1", "imapPort": port, "security": "ssl" }),
        )
        .unwrap();
    assert!(t0.elapsed() < Duration::from_secs(15), "took {:?}", t0.elapsed());
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "HOST_UNREACHABLE", "{r}");
    assert!(list(&e).is_empty());
}

#[test]
fn same_email_twice_is_duplicate() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    let server = good_server();
    assert_eq!(e.rpc("mobile.accounts.add", form(&server, "u@example.test", PW)).unwrap()["ok"], true);
    let r = e.rpc("mobile.accounts.add", form(&server, "U@Example.test", PW)).unwrap();
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "DUPLICATE", "{r}");
    assert_eq!(list(&e).len(), 1);
}

#[test]
fn remove_deletes_rows_and_secret() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let server = good_server();
    let id = e.rpc("mobile.accounts.add", form(&server, "u@example.test", PW)).unwrap()["account"]["id"].as_str().unwrap().to_string();
    let other = e.rpc("mobile.accounts.add", form(&server, "v@example.test", PW)).unwrap()["account"]["id"].as_str().unwrap().to_string();
    {
        let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
        for aid in [&id, &other] {
            c.execute("INSERT INTO folders (account_id, path, name) VALUES (?1, 'INBOX', 'INBOX')", [aid]).unwrap();
            c.execute(
                "INSERT INTO messages (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
                 VALUES (?1, 'INBOX', 1, 's', 'n', 'n@example.test', 1, '', 0, 0, 0)",
                [aid],
            )
            .unwrap();
            c.execute("INSERT INTO bodies (account_id, folder, uid) VALUES (?1, 'INBOX', 1)", [aid]).unwrap();
            c.execute("INSERT INTO attachments (account_id, folder, uid, section, filename, mime) VALUES (?1, 'INBOX', 1, '2', 'a', 'x/y')", [aid]).unwrap();
            c.execute("INSERT INTO pending_actions (account_id, folder, uids_json, kind, created_ms) VALUES (?1, 'INBOX', '[1]', 'seen', 1)", [aid]).unwrap();
        }
    }
    let r = e.rpc("mobile.accounts.remove", json!({ "accountId": id })).unwrap();
    assert_eq!(r, json!({ "removed": true }));
    assert_eq!(secrets.get(&id).unwrap(), None);
    assert_eq!(secrets.get(&other).unwrap().as_deref(), Some(PW));
    let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
    for t in ["accounts", "folders", "messages", "bodies", "attachments", "pending_actions"] {
        let col = if t == "accounts" { "id" } else { "account_id" };
        let n: i64 = c.query_row(&format!("SELECT count(*) FROM {t} WHERE {col} = ?1"), [&id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{t} still holds rows for the removed account");
        let kept: i64 = c.query_row(&format!("SELECT count(*) FROM {t} WHERE {col} = ?1"), [&other], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1, "{t} lost the other account's row");
    }
    assert_eq!(list(&e).len(), 1);
}

#[test]
fn invalid_form_is_typed_without_touching_the_network() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    for bad in [
        json!({ "email": "no-at-sign", "password": PW, "imapHost": "h", "imapPort": 993, "security": "ssl" }),
        json!({ "email": "u@example.test", "password": "", "imapHost": "h", "imapPort": 993, "security": "ssl" }),
        json!({ "email": "u@example.test", "password": PW, "imapHost": " ", "imapPort": 993, "security": "ssl" }),
        json!({ "email": "u@example.test", "password": PW, "imapHost": "h", "imapPort": 0, "security": "ssl" }),
        json!({ "email": "u@example.test", "password": PW, "imapHost": "h", "imapPort": 993, "security": "tls" }),
    ] {
        let r = e.rpc("mobile.accounts.add", bad.clone()).unwrap();
        assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!("INVALID")), "{bad}");
    }
    assert_eq!(e.rpc("mobile.accounts.remove", json!({})).unwrap_err().code(), "INVALID");
}

#[test]
fn password_that_is_not_a_string_is_never_echoed_and_big_port_is_invalid() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    for method in ["mobile.accounts.test", "mobile.accounts.add"] {
        let r = e
            .rpc(method, json!({ "email": "u@example.test", "password": 12345, "imapHost": "h", "imapPort": 993, "security": "ssl" }))
            .map_or_else(|err| serde_json::to_value(err).unwrap(), |v| v);
        assert!(!r.to_string().contains("12345"), "{method}: {r}");
        assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!("INVALID")), "{r}");
        let r = e
            .rpc(method, json!({ "email": "u@example.test", "password": PW, "imapHost": "h", "imapPort": 70000, "security": "ssl" }))
            .unwrap();
        assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!("INVALID")), "{r}");
    }
}

fn row_count(dir: &std::path::Path) -> i64 {
    Connection::open(dir.join("mobile.db")).unwrap().query_row("SELECT count(*) FROM accounts", [], |r| r.get(0)).unwrap()
}

#[test]
fn losing_the_insert_race_is_duplicate_and_leaves_no_secret() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let server = good_server();
    let path = tmp.path().join("mobile.db");
    *secrets.on_set.lock().unwrap() = Some(Box::new(move || {
        // A concurrent add of the same address lands between the pre-check and our insert.
        let c = Connection::open(&path).unwrap();
        c.busy_timeout(Duration::from_secs(5)).unwrap();
        c.execute(
            "INSERT INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
             VALUES ('acc_rival', 'u@example.test', 'u', 'h', 993, 'ssl', 1)",
            [],
        )
        .unwrap();
    }));
    let r = e.rpc("mobile.accounts.add", form(&server, "u@example.test", PW)).unwrap();
    assert_eq!((r["ok"].clone(), r["code"].clone()), (json!(false), json!("DUPLICATE")), "{r}");
    assert_eq!(row_count(tmp.path()), 1, "only the rival row");
    assert!(secrets.is_empty(), "the new account's secret must be deleted");
}

#[test]
fn a_failed_insert_deletes_the_secret_and_reports_internal() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let server = good_server();
    let path = tmp.path().join("mobile.db");
    *secrets.on_set.lock().unwrap() = Some(Box::new(move || {
        Connection::open(&path).unwrap().execute_batch("DROP TABLE accounts;").unwrap();
    }));
    let err = e.rpc("mobile.accounts.add", form(&server, "u@example.test", PW)).unwrap_err();
    assert_eq!(err.code(), "INTERNAL");
    assert!(!err.to_string().contains(PW));
    assert!(secrets.is_empty(), "the secret must be deleted when the row insert fails");
}
