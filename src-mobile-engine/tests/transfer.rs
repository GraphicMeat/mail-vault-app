//! `mobile.transfer.import`: the phone's half of "Set up the mobile app". A code the desktop sealed
//! (core's `transfer::phone`, cheap key derivation here) becomes account rows and secrets, with no
//! sign-in; sync surfaces a problem later through the usual banners.

use mailvault_core::transfer::crypto::{Params, MIN_M_KIB};
use mailvault_core::transfer::phone::{frames, seal_with, PhoneAccount, PhoneAuth, PhoneBundle, PhoneKind, MAX_FRAME_CHARS};
use mailvault_mobile_engine::{Credential, Engine, MemorySecrets, SecretStore};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Arc;

const PW: &str = "twelve-chars-or-more";
const CHEAP: Params = Params { m_kib: MIN_M_KIB, t: 1, p: 1 };

fn engine(dir: &std::path::Path) -> (Engine, Arc<MemorySecrets>) {
    let secrets = Arc::new(MemorySecrets::default());
    let e = Engine::open(dir, &dir.join("cache"), secrets.clone()).unwrap();
    (e, secrets)
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
    }
}

fn imap(email: &str) -> PhoneAccount {
    let mut a = account(email, PhoneKind::Imap, PhoneAuth::Password);
    a.display_name = "Ann Example".into();
    a.imap_host = Some("imap.example.test".into());
    a.imap_port = Some(993);
    a.security = Some("ssl".into());
    a.smtp_host = Some("smtp.example.test".into());
    a.smtp_port = Some(587);
    a.smtp_security = Some("starttls".into());
    a.password = Some("imap-secret-1".into());
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
    a.refresh = Some("google-refresh-1".into());
    a.client_id = Some("desktop-client.apps.googleusercontent.com".into());
    a
}

fn graph(email: &str) -> PhoneAccount {
    let mut a = account(email, PhoneKind::Graph, PhoneAuth::OAuth2);
    a.provider = Some("microsoft".into());
    a.refresh = Some("ms-refresh-1".into());
    a.client_id = Some("ms-client".into());
    a
}

fn jmap(email: &str, auth: PhoneAuth) -> PhoneAccount {
    let mut a = account(email, PhoneKind::Jmap, auth);
    a.jmap_url = Some("https://api.fastmail.test/jmap/session".into());
    a.password = Some("jmap-token-1".into());
    a
}

/// The frame texts the desktop shows for `accounts`, sealed with `password`.
fn code(password: &str, accounts: Vec<PhoneAccount>) -> Vec<String> {
    let bundle = PhoneBundle { v: 1, accounts };
    let sealed = seal_with(password, &bundle, CHEAP).unwrap();
    frames(&sealed, MAX_FRAME_CHARS).unwrap()
}

fn import(e: &Engine, frames: &[String], password: &str) -> Value {
    e.rpc("mobile.transfer.import", json!({ "frames": frames, "password": password })).unwrap()
}

struct Row {
    id: String,
    display_name: String,
    imap_host: String,
    imap_port: i64,
    security: String,
    smtp: (Option<String>, Option<i64>, Option<String>),
    kind: String,
    auth: String,
    provider: Option<String>,
    jmap_url: Option<String>,
    needs_auth: i64,
}

fn row(dir: &std::path::Path, email: &str) -> Row {
    Connection::open(dir.join("mobile.db"))
        .unwrap()
        .query_row(
            "SELECT id, display_name, imap_host, imap_port, security, smtp_host, smtp_port, smtp_security, kind, auth, provider, jmap_url, needs_auth
             FROM accounts WHERE email = ?1",
            [email],
            |r| {
                Ok(Row {
                    id: r.get(0)?,
                    display_name: r.get(1)?,
                    imap_host: r.get(2)?,
                    imap_port: r.get(3)?,
                    security: r.get(4)?,
                    smtp: (r.get(5)?, r.get(6)?, r.get(7)?),
                    kind: r.get(8)?,
                    auth: r.get(9)?,
                    provider: r.get(10)?,
                    jmap_url: r.get(11)?,
                    needs_auth: r.get(12)?,
                })
            },
        )
        .unwrap()
}

fn count(dir: &std::path::Path) -> i64 {
    Connection::open(dir.join("mobile.db")).unwrap().query_row("SELECT count(*) FROM accounts", [], |r| r.get(0)).unwrap()
}

fn cred(secrets: &MemorySecrets, id: &str) -> Credential {
    Credential::parse(&secrets.get(id).unwrap().expect("a secret is stored"))
}

#[test]
fn an_imap_password_account_gets_its_row_and_secret() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let reply = import(&e, &code(PW, vec![imap("ann@example.test")]), PW);
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["imported"], json!(["ann@example.test"]));
    assert_eq!(reply["existing"], json!([]));
    assert_eq!(reply["skipped"], json!([]));

    let r = row(tmp.path(), "ann@example.test");
    assert!(r.id.starts_with("acc_"));
    assert_eq!((r.kind.as_str(), r.auth.as_str(), r.provider), ("imap", "password", None));
    assert_eq!((r.imap_host.as_str(), r.imap_port, r.security.as_str()), ("imap.example.test", 993, "ssl"));
    assert_eq!(r.smtp, (Some("smtp.example.test".into()), Some(587), Some("starttls".into())));
    assert_eq!(r.display_name, "Ann Example");
    assert_eq!(r.needs_auth, 0);
    let c = cred(&secrets, &r.id);
    assert_eq!(c.password.as_deref(), Some("imap-secret-1"));
    assert!(c.refresh.is_none());

    // It is listed like any added account.
    let list = e.rpc("mobile.accounts.list", json!({})).unwrap();
    assert_eq!(list["accounts"][0]["email"], "ann@example.test");
    assert_eq!(list["accounts"][0]["oauth"], false);
}

#[test]
fn an_oauth_account_carries_its_refresh_token_and_client_id() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let reply = import(&e, &code(PW, vec![google("g@gmail.test"), graph("m@outlook.test")]), PW);
    assert_eq!(reply["imported"], json!(["g@gmail.test", "m@outlook.test"]), "{reply}");

    let g = row(tmp.path(), "g@gmail.test");
    assert_eq!((g.kind.as_str(), g.auth.as_str(), g.provider.as_deref()), ("imap", "oauth2", Some("google")));
    assert_eq!((g.imap_host.as_str(), g.imap_port, g.security.as_str()), ("imap.gmail.com", 993, "ssl"));
    assert_eq!(g.smtp, (Some("smtp.gmail.com".into()), Some(587), Some("starttls".into())));
    assert_eq!(g.display_name, "g@gmail.test", "no name: the address");
    let c = cred(&secrets, &g.id);
    assert_eq!(c.refresh.as_deref(), Some("google-refresh-1"));
    assert_eq!(c.client_id.as_deref(), Some("desktop-client.apps.googleusercontent.com"));
    // No access token: the first sync refreshes one.
    assert!(c.access.is_none() && c.expires_ms.is_none() && c.password.is_none());

    let m = row(tmp.path(), "m@outlook.test");
    assert_eq!((m.kind.as_str(), m.auth.as_str(), m.provider.as_deref()), ("graph", "oauth2", Some("microsoft")));
    // The column is required; Graph needs no host (same as a Microsoft sign-in).
    assert_eq!((m.imap_host.as_str(), m.imap_port, m.security.as_str()), ("outlook.office365.com", 993, "ssl"));
    assert_eq!(m.smtp, (None, None, None));
    let c = cred(&secrets, &m.id);
    assert_eq!((c.refresh.as_deref(), c.client_id.as_deref()), (Some("ms-refresh-1"), Some("ms-client")));

    let list = e.rpc("mobile.accounts.list", json!({})).unwrap();
    assert!(list["accounts"].as_array().unwrap().iter().all(|a| a["oauth"] == true && a["needsAuth"] == false), "{list}");
}

#[test]
fn a_jmap_account_keeps_its_session_url_and_auth() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    let reply = import(&e, &code(PW, vec![jmap("t@fastmail.test", PhoneAuth::Bearer), jmap("b@fastmail.test", PhoneAuth::Password)]), PW);
    assert_eq!(reply["imported"], json!(["t@fastmail.test", "b@fastmail.test"]), "{reply}");

    let t = row(tmp.path(), "t@fastmail.test");
    assert_eq!((t.kind.as_str(), t.auth.as_str()), ("jmap", "bearer"));
    assert_eq!(t.jmap_url.as_deref(), Some("https://api.fastmail.test/jmap/session"));
    assert_eq!((t.imap_host.as_str(), t.imap_port, t.security.as_str()), ("api.fastmail.test", 443, "ssl"));
    assert_eq!(cred(&secrets, &t.id).password.as_deref(), Some("jmap-token-1"));
    assert_eq!(row(tmp.path(), "b@fastmail.test").auth, "password");
}

#[test]
fn an_address_already_here_is_existing_and_left_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, secrets) = engine(tmp.path());
    assert_eq!(import(&e, &code(PW, vec![imap("ann@example.test")]), PW)["ok"], true);
    let first = row(tmp.path(), "ann@example.test").id;

    let mut again = imap("ANN@example.test");
    again.password = Some("a-newer-password".into());
    let reply = import(&e, &code(PW, vec![again, imap("bob@example.test"), imap("bob@example.test")]), PW);
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["imported"], json!(["bob@example.test"]));
    assert_eq!(reply["existing"], json!(["ANN@example.test", "bob@example.test"]));
    assert_eq!(count(tmp.path()), 2);
    assert_eq!(cred(&secrets, &first).password.as_deref(), Some("imap-secret-1"), "the stored secret is untouched");
}

#[test]
fn a_wrong_password_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    let reply = import(&e, &code(PW, vec![imap("ann@example.test")]), "another-twelve-chars");
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["code"], "BAD_PASSWORD");
    assert_eq!(count(tmp.path()), 0);
}

#[test]
fn a_short_password_is_refused_before_any_work() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    let reply = import(&e, &code(PW, vec![imap("ann@example.test")]), "short-pw");
    assert_eq!((reply["ok"].clone(), reply["code"].clone()), (json!(false), json!("PASSWORD_SHORT")));
    assert_eq!(count(tmp.path()), 0);
}

#[test]
fn damaged_or_missing_frames_are_invalid() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    let mut good = code(PW, vec![imap("ann@example.test")]);

    for frames in [vec!["not a frame".to_string()], vec![], vec!["MVQR1:0000000g:1/1:AAAA".to_string()]] {
        let reply = import(&e, &frames, PW);
        assert_eq!((reply["ok"].clone(), reply["code"].clone()), (json!(false), json!("INVALID")), "{frames:?}");
    }
    // A code with a part missing.
    let one = good.remove(0);
    assert!(good.is_empty() && one.contains(":1/1:"), "one account fits one frame");
    let partial = one.replacen(":1/1:", ":1/2:", 1);
    let reply = import(&e, &[partial], PW);
    assert_eq!(reply["code"], "INVALID", "{reply}");
    assert_eq!(count(tmp.path()), 0);
}

#[test]
fn bad_params_name_the_field_never_the_value() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    for params in [json!({ "frames": ["x"], "password": 123456789012345_u64 }), json!({ "frames": "MVQR1:secret", "password": PW }), json!(null)] {
        let reply = e.rpc("mobile.transfer.import", params.clone()).unwrap();
        assert_eq!(reply["code"], "INVALID", "{params}");
        let text = reply.to_string();
        assert!(!text.contains("123456789012345") && !text.contains("MVQR1:secret"), "{text}");
    }
    let reply = import(&e, &code(PW, vec![imap("ann@example.test")]), "wrong-password-here");
    assert!(!reply.to_string().contains("wrong-password-here"));
}

#[test]
fn an_account_the_phone_cannot_store_is_skipped_and_the_rest_imported() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    let mut no_host = imap("nohost@example.test");
    no_host.imap_host = Some("  ".into());
    let mut http = jmap("http@example.test", PhoneAuth::Bearer);
    http.jmap_url = Some("http://jmap.example.test/session".into());
    let mut no_secret = google("nosecret@gmail.test");
    no_secret.refresh = None;
    let mut no_smtp = imap("nosmtp@example.test");
    no_smtp.smtp_host = None;
    no_smtp.smtp_port = None;
    no_smtp.smtp_security = None;
    let reply = import(&e, &code(PW, vec![no_host, http, no_secret, imap("ok@example.test"), no_smtp]), PW);
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["imported"], json!(["ok@example.test", "nosmtp@example.test"]));
    assert_eq!(
        reply["skipped"],
        json!([
            { "email": "nohost@example.test", "reason": "invalid" },
            { "email": "http@example.test", "reason": "invalid" },
            { "email": "nosecret@gmail.test", "reason": "no-secret" },
        ])
    );
    // No SMTP server on the desktop: none here either (sending says so), never a guessed host.
    assert_eq!(row(tmp.path(), "nosmtp@example.test").smtp, (None, None, None));
}

#[test]
fn a_repeat_whose_first_copy_was_skipped_is_not_existing() {
    let tmp = tempfile::tempdir().unwrap();
    let (e, _) = engine(tmp.path());
    let mut bad = imap("cara@example.test");
    bad.imap_host = None;
    let mut bad_too = imap("dan@example.test");
    bad_too.imap_host = None;
    let reply = import(&e, &code(PW, vec![bad, imap("cara@example.test"), bad_too.clone(), bad_too]), PW);
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["imported"], json!(["cara@example.test"]));
    assert_eq!(reply["existing"], json!([]));
    // cara got in from its second copy, so it is not reported skipped; dan is named once.
    assert_eq!(reply["skipped"], json!([{ "email": "dan@example.test", "reason": "invalid" }]));
}
