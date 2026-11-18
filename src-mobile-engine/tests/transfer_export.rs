//! `mobile.transfer.export`: the phone's accounts sealed into a desktop `.mvtransfer` file (core's
//! `transfer::crypto` over the bundle desktop's "Move to another computer" reads), written where
//! the shell's share sheet takes files from, and `mobile.transfer.discard` to delete it after.

use mailvault_core::transfer::crypto::{decrypt, Params, MIN_M_KIB};
use mailvault_core::transfer::phone::{frames, phone_bundle, seal_with, PhoneAccount, PhoneAuth, PhoneBundle, PhoneKind, MAX_FRAME_CHARS};
use mailvault_mobile_engine::{Engine, MemorySecrets};
use serde_json::{json, Value};
use std::sync::Arc;

const PW: &str = "twelve-chars-or-more";
const CHEAP: Params = Params { m_kib: MIN_M_KIB, t: 1, p: 1 };

fn engine(dir: &std::path::Path) -> Engine {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

fn account(email: &str, kind: PhoneKind, auth: PhoneAuth) -> PhoneAccount {
    PhoneAccount {
        email: email.into(),
        display_name: String::new(),
        kind,
        auth,
        provider: None,
        imap_host: None,
        imap_port: None,
        security: None,
        smtp_host: None,
        smtp_port: None,
        smtp_security: None,
        jmap_url: None,
        password: None,
        refresh: None,
        client_id: None,
        color: None,
        order: None,
        hidden: false,
        settings: None,
    }
}

fn imap(email: &str) -> PhoneAccount {
    let mut a = account(email, PhoneKind::Imap, PhoneAuth::Password);
    a.display_name = "Pat".into();
    a.imap_host = Some("imap.example.com".into());
    a.imap_port = Some(143);
    a.security = Some("starttls".into());
    a.smtp_host = Some("smtp.example.com".into());
    a.smtp_port = Some(465);
    a.smtp_security = Some("ssl".into());
    a.password = Some("app-password".into());
    a.color = Some("#336699".into());
    a
}

fn google(email: &str) -> PhoneAccount {
    let mut a = account(email, PhoneKind::Imap, PhoneAuth::OAuth2);
    a.provider = Some("google".into());
    a.imap_host = Some("imap.gmail.com".into());
    a.imap_port = Some(993);
    a.security = Some("ssl".into());
    a.smtp_host = Some("smtp.gmail.com".into());
    a.smtp_port = Some(587);
    a.smtp_security = Some("starttls".into());
    a.refresh = Some("refresh-google".into());
    a.client_id = Some("client.apps.googleusercontent.com".into());
    a
}

fn graph(email: &str) -> PhoneAccount {
    let mut a = account(email, PhoneKind::Graph, PhoneAuth::OAuth2);
    a.provider = Some("microsoft".into());
    a.refresh = Some("refresh-ms".into());
    a
}

fn jmap(email: &str) -> PhoneAccount {
    let mut a = account(email, PhoneKind::Jmap, PhoneAuth::Bearer);
    a.jmap_url = Some("https://api.fastmail.com/jmap/session".into());
    a.password = Some("fmu1-token".into());
    a
}

/// The phone with `accounts`, added the way a desktop code adds them.
fn with_accounts(e: &Engine, accounts: Vec<PhoneAccount>) {
    let bundle = PhoneBundle { v: 1, accounts, settings: None, tags: None, fields: None, views: None };
    let sealed = seal_with(PW, &bundle, CHEAP).unwrap();
    let texts = frames(&sealed, MAX_FRAME_CHARS).unwrap();
    let r = e.rpc("mobile.transfer.import", json!({ "password": PW, "frames": texts })).unwrap();
    assert_eq!(r["ok"], true, "{r}");
}

/// The file the export wrote, opened as desktop's `transfer.decrypt` opens it.
fn opened(reply: &Value) -> Value {
    let path = reply["path"].as_str().expect("a path");
    let bytes = std::fs::read(path).unwrap();
    serde_json::from_slice(&decrypt("export-password-1", &bytes).unwrap()).unwrap()
}

fn export(e: &Engine, params: Value) -> Value {
    e.rpc("mobile.transfer.export", params).unwrap()
}

#[test]
fn every_account_is_exported_as_desktop_reads_it_and_maps_back_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine(dir.path());
    let accounts = vec![imap("pat@example.com"), google("g@gmail.com"), graph("o@outlook.com"), jmap("j@fastmail.com")];
    with_accounts(&e, accounts.clone());

    let reply = export(&e, json!({ "password": "export-password-1" }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["count"], 4);
    assert!(reply["name"].as_str().unwrap().ends_with(".mvtransfer"));
    // Where the share sheet takes a file from: `<cache>/att/<64 hex>`.
    let path = std::path::PathBuf::from(reply["path"].as_str().unwrap());
    assert_eq!(path.parent().unwrap(), dir.path().join("cache").join("att"));
    let name = path.file_name().unwrap().to_str().unwrap();
    assert!(name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{name}");

    let bundle = opened(&reply);
    assert_eq!(bundle["formatVersion"], 1);
    let files = bundle["accounts"].as_array().unwrap();
    assert_eq!(files.len(), 4);
    for f in files {
        assert!(f["id"].as_str().is_some_and(|s| !s.is_empty()), "every account has an id: {f}");
    }
    let pat = files.iter().find(|f| f["email"] == "pat@example.com").unwrap();
    assert_eq!(pat["name"], "Pat");
    assert_eq!(pat["password"], "app-password");
    assert_eq!(pat["imapSecurity"], "starttls");
    assert_eq!(pat["smtpSecure"], true);
    assert_eq!(bundle["accountSettings"]["accountColors"][pat["id"].as_str().unwrap()], "#336699");
    let j = files.iter().find(|f| f["email"] == "j@fastmail.com").unwrap();
    // Desktop keys a JMAP account by the session URL's host.
    assert_eq!(j["imapHost"], "api.fastmail.com");
    let order: Vec<&str> = bundle["accountOrder"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(order.len(), 4);

    // Desktop's own mapping (the one that makes the phone code) reads every account back as it was.
    let (back, skipped) = phone_bundle(&bundle["accounts"]);
    assert!(skipped.is_empty(), "{skipped:?}");
    for want in &accounts {
        let got = back.accounts.iter().find(|a| a.email == want.email).unwrap();
        assert_eq!((got.kind, got.auth), (want.kind, want.auth), "{}", want.email);
        assert_eq!(got.password, want.password, "{}", want.email);
        assert_eq!(got.refresh, want.refresh, "{}", want.email);
        assert_eq!(got.client_id, want.client_id, "{}", want.email);
        assert_eq!(got.provider, want.provider, "{}", want.email);
        assert_eq!(got.jmap_url, want.jmap_url, "{}", want.email);
        if want.kind == PhoneKind::Imap {
            assert_eq!((&got.imap_host, got.imap_port, &got.security), (&want.imap_host, want.imap_port, &want.security), "{}", want.email);
            assert_eq!((&got.smtp_host, got.smtp_port, &got.smtp_security), (&want.smtp_host, want.smtp_port, &want.smtp_security), "{}", want.email);
        }
    }
}

#[test]
fn only_the_chosen_accounts_are_exported() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine(dir.path());
    with_accounts(&e, vec![imap("pat@example.com"), jmap("j@fastmail.com")]);
    let list = e.rpc("mobile.accounts.list", json!({})).unwrap();
    let rows = list.as_array().or_else(|| list["accounts"].as_array()).unwrap().clone();
    let pat = rows.iter().find(|a| a["email"] == "pat@example.com").unwrap()["id"].clone();

    let reply = export(&e, json!({ "password": "export-password-1", "accountIds": [pat] }));
    assert_eq!(reply["count"], 1);
    let bundle = opened(&reply);
    assert_eq!(bundle["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(bundle["accounts"][0]["email"], "pat@example.com");
}

#[test]
fn a_short_password_or_no_account_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine(dir.path());
    let short = export(&e, json!({ "password": "short" }));
    assert_eq!((short["ok"].clone(), short["code"].clone()), (json!(false), json!("PASSWORD_SHORT")));
    let none = export(&e, json!({ "password": "export-password-1" }));
    assert_eq!((none["ok"].clone(), none["code"].clone()), (json!(false), json!("NO_ACCOUNTS")));
    let att = dir.path().join("cache").join("att");
    assert!(!att.exists() || std::fs::read_dir(&att).unwrap().next().is_none(), "no file left behind");
}

#[test]
fn discard_deletes_the_export_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine(dir.path());
    with_accounts(&e, vec![imap("pat@example.com")]);
    let reply = export(&e, json!({ "password": "export-password-1" }));
    let path = reply["path"].as_str().unwrap().to_string();
    assert!(std::path::Path::new(&path).is_file());
    // A path the export did not write is refused.
    assert!(e.rpc("mobile.transfer.discard", json!({ "path": dir.path().join("mobile.db") })).is_err());
    assert!(dir.path().join("mobile.db").is_file());
    e.rpc("mobile.transfer.discard", json!({ "path": path })).unwrap();
    assert!(!std::path::Path::new(&path).exists());
}

#[test]
fn an_export_never_discarded_is_deleted_at_the_next_open() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine(dir.path());
    with_accounts(&e, vec![imap("pat@example.com")]);
    let first = export(&e, json!({ "password": "export-password-1" }))["path"].as_str().unwrap().to_string();
    // A second export takes the first one's place.
    let second = export(&e, json!({ "password": "export-password-1" }))["path"].as_str().unwrap().to_string();
    assert!(!std::path::Path::new(&first).exists());
    assert!(std::path::Path::new(&second).is_file());
    // The app is killed while the share sheet is up: the next open deletes it.
    drop(e);
    let _e = engine(dir.path());
    assert!(!std::path::Path::new(&second).exists());
}
