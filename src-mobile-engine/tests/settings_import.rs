//! The desktop's settings in a phone import (W1a): its global preferences apply on the first
//! import that carries them only, each account's own settings apply to the accounts the import
//! adds, every value is checked key by key, and hidden accounts leave the phone's lists. Plus the
//! stores they land in: `mobile.prefs.*` and `mobile.accountSettings.*`.

use mailvault_core::transfer::crypto::{Params, MIN_M_KIB};
use mailvault_core::transfer::phone::{
    frames, seal_with, PhoneAccount, PhoneAccountNotifications, PhoneAccountSettings, PhoneAlias, PhoneAuth, PhoneBundle, PhoneKind,
    PhoneQuietHours, PhoneSettings, PhoneSignature, PhoneTemplate, MAX_FRAME_CHARS,
};
use mailvault_mobile_engine::{Engine, MemorySecrets};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

const PW: &str = "twelve-chars-or-more";
const CHEAP: Params = Params { m_kib: MIN_M_KIB, t: 1, p: 1 };

fn open(dir: &Path) -> Engine {
    Engine::open(dir, &dir.join("cache"), Arc::new(MemorySecrets::default())).unwrap()
}

fn imap(email: &str) -> PhoneAccount {
    PhoneAccount {
        email: email.into(),
        display_name: "Desk Name".into(),
        kind: PhoneKind::Imap,
        auth: PhoneAuth::Password,
        provider: None,
        imap_host: Some("imap.example.test".into()),
        imap_port: Some(993),
        security: Some("ssl".into()),
        smtp_host: Some("smtp.example.test".into()),
        smtp_port: Some(587),
        smtp_security: Some("starttls".into()),
        jmap_url: None,
        password: Some("secret-1".into()),
        refresh: None,
        client_id: None,
        color: None,
        order: None,
        hidden: false,
        settings: None,
    }
}

fn desk_settings() -> PhoneSettings {
    PhoneSettings {
        language: Some("de".into()),
        theme: Some("light".into()),
        palette: Some("teal".into()),
        mark_as_read_mode: Some("delay".into()),
        mark_as_read_delay: Some(5),
        confirm_before_delete: Some(true),
        after_delete_select: Some("previousUnread".into()),
        swipe_left_action: Some("archive".into()),
        swipe_right_action: Some("star".into()),
        send_delay: Some(10),
        hold_external_content: Some(false),
        date_format: Some("yyyy-MM-dd".into()),
        time_format: Some("24h".into()),
        thread_mode: Some("flat".into()),
        notification_preview: Some(false),
        templates: Some(vec![PhoneTemplate { name: "Thanks".into(), body: "Thank you!".into() }]),
        ..PhoneSettings::default()
    }
}

fn acct_settings() -> PhoneAccountSettings {
    PhoneAccountSettings {
        signature: Some(PhoneSignature { html: "<p>Ann</p>".into(), text: "Ann".into(), enabled: true }),
        send_as: Some("ann@alias.test".into()),
        aliases: Some(vec![PhoneAlias { address: "ann@alias.test".into(), name: "Ann A".into() }]),
        sent_folder_override: Some("Sent Items".into()),
        notifications: Some(PhoneAccountNotifications {
            enabled: Some(false),
            folders: Some(vec!["INBOX".into()]),
            quiet_hours: Some(PhoneQuietHours { enabled: true, start: "22:00".into(), end: "07:00".into() }),
        }),
        offline_window: Some("6m".into()),
    }
}

fn code(accounts: Vec<PhoneAccount>, settings: Option<PhoneSettings>) -> Vec<String> {
    let sealed = seal_with(PW, &PhoneBundle { v: 1, accounts, settings }, CHEAP).unwrap();
    frames(&sealed, MAX_FRAME_CHARS).unwrap()
}

fn import(e: &Engine, frames: &[String]) -> Value {
    let r = e.rpc("mobile.transfer.import", json!({ "frames": frames, "password": PW })).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    r
}

fn id_of(e: &Engine, email: &str) -> String {
    let list = e.rpc("mobile.accounts.list", json!({})).unwrap();
    list["accounts"].as_array().unwrap().iter().find(|a| a["email"] == email).unwrap()["id"].as_str().unwrap().to_string()
}

fn raw(dir: &Path, key: &str) -> Option<String> {
    Connection::open(dir.join("mobile.db"))
        .unwrap()
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

#[test]
fn prefs_default_to_the_phone_as_it_was() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let p = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!(p["theme"], "system");
    assert_eq!(p["palette"], "indigo");
    assert_eq!(p["markAsReadMode"], "auto");
    assert_eq!(p["confirmBeforeDelete"], false);
    assert_eq!(p["afterDeleteSelect"], "next");
    assert_eq!((p["swipeLeftAction"].clone(), p["swipeRightAction"].clone()), (json!("delete"), json!("toggleRead")));
    assert_eq!(p["sendDelay"], 0);
    assert_eq!(p["holdExternalContent"], true);
    assert_eq!((p["dateFormat"].clone(), p["timeFormat"].clone()), (json!("auto"), json!("auto")));
    assert_eq!(p["templates"], json!([]));
    assert_eq!(p["desktopSettingsAppliedAt"], Value::Null);
}

#[test]
fn prefs_set_checks_every_value_and_changes_nothing_on_a_refusal() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let after = e.rpc("mobile.prefs.set", json!({ "theme": "dark", "sendDelay": 10, "swipeLeftAction": "flag" })).unwrap();
    assert_eq!((after["theme"].clone(), after["sendDelay"].clone(), after["swipeLeftAction"].clone()), (json!("dark"), json!(10), json!("flag")));
    for bad in [
        json!({ "theme": "neon" }),
        json!({ "sendDelay": 301 }),
        json!({ "sendDelay": "5" }),
        json!({ "swipeLeftAction": "archive" }),
        json!({ "nope": true }),
        json!({ "theme": "light", "markAsReadDelay": -1 }),
        json!({ "customDateFormat": "a\nb" }),
    ] {
        assert_eq!(e.rpc("mobile.prefs.set", bad.clone()).unwrap_err().code(), "INVALID", "{bad}");
    }
    assert_eq!(e.rpc("mobile.prefs.get", json!({})).unwrap(), after, "a refused set changes nothing");
    // Engine::set_setting takes the same checks.
    assert!(e.set_setting("palette", "neon").is_err());
    e.set_setting("palette", "graphite").unwrap();
    e.set_setting("confirmBeforeDelete", "true").unwrap();
    let p = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!((p["palette"].clone(), p["confirmBeforeDelete"].clone()), (json!("graphite"), json!(true)));
}

#[test]
fn the_first_import_applies_the_desktop_settings_and_a_later_one_does_not() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    // The tour already stored a language: the phone still has no desktop settings.
    e.rpc("mobile.settings.set", json!({ "language": "fr", "onboardingComplete": true })).unwrap();
    let r = import(&e, &code(vec![imap("ann@example.test")], Some(desk_settings())));
    assert_eq!(r["settingsApplied"], true);
    let p = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!((p["theme"].clone(), p["palette"].clone()), (json!("light"), json!("teal")));
    assert_eq!((p["markAsReadMode"].clone(), p["markAsReadDelay"].clone()), (json!("delay"), json!(5)));
    assert_eq!(p["confirmBeforeDelete"], true);
    // The phone's vocabulary: previousUnread is previous, archive is move, star is flag.
    assert_eq!(p["afterDeleteSelect"], "previous");
    assert_eq!((p["swipeLeftAction"].clone(), p["swipeRightAction"].clone()), (json!("move"), json!("flag")));
    assert_eq!((p["sendDelay"].clone(), p["holdExternalContent"].clone()), (json!(10), json!(false)));
    assert_eq!((p["dateFormat"].clone(), p["timeFormat"].clone(), p["threadMode"].clone()), (json!("yyyy-MM-dd"), json!("24h"), json!("flat")));
    assert_eq!(p["templates"], json!([{ "name": "Thanks", "body": "Thank you!" }]));
    assert!(p["desktopSettingsAppliedAt"].as_i64().unwrap() > 0);
    let s = e.rpc("mobile.settings.get", json!({})).unwrap();
    assert_eq!((s["language"].clone(), s["notificationPreview"].clone()), (json!("de"), json!(false)));
    // Never turned on by an import: that needs the system's permission.
    assert_eq!(s["notifications"], "off");

    // The user changes the phone; a later import (with other desktop settings) leaves it.
    e.rpc("mobile.prefs.set", json!({ "theme": "dark" })).unwrap();
    let mut other = desk_settings();
    other.palette = Some("graphite".into());
    other.send_delay = Some(30);
    let r = import(&e, &code(vec![imap("bob@example.test")], Some(other)));
    assert_eq!(r["settingsApplied"], false);
    let p2 = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!((p2["theme"].clone(), p2["palette"].clone(), p2["sendDelay"].clone()), (json!("dark"), json!("teal"), json!(10)));
    assert_eq!(p2["desktopSettingsAppliedAt"], p["desktopSettingsAppliedAt"]);
}

#[test]
fn an_import_without_settings_leaves_the_marker_unset() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let r = import(&e, &code(vec![imap("ann@example.test")], None));
    assert_eq!(r["settingsApplied"], false);
    assert_eq!(e.rpc("mobile.prefs.get", json!({})).unwrap()["desktopSettingsAppliedAt"], Value::Null);
    // so a later one with settings still applies them
    let r = import(&e, &code(vec![imap("bob@example.test")], Some(desk_settings())));
    assert_eq!(r["settingsApplied"], true);
}

#[test]
fn values_the_phone_does_not_take_are_left_out_not_the_import() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let mut s = desk_settings();
    s.palette = Some("neon".into());
    s.send_delay = Some(100_000);
    s.language = Some("klingon".into());
    s.date_format = Some("YYYY".into());
    let mut a = imap("ann@example.test");
    let mut st = acct_settings();
    st.send_as = Some("not an address".into());
    st.notifications.as_mut().unwrap().quiet_hours = Some(PhoneQuietHours { enabled: true, start: "25:00".into(), end: "07:00".into() });
    st.offline_window = Some("2y".into());
    a.settings = Some(st);
    let r = import(&e, &code(vec![a], Some(s)));
    assert_eq!(r["imported"], json!(["ann@example.test"]));
    let p = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!((p["palette"].clone(), p["sendDelay"].clone(), p["dateFormat"].clone()), (json!("indigo"), json!(0), json!("auto")));
    assert_eq!(p["theme"], "light", "the rest still applies");
    assert_eq!(e.rpc("mobile.settings.get", json!({})).unwrap()["language"], Value::Null);
    let id = id_of(&e, "ann@example.test");
    let got = e.rpc("mobile.accountSettings.get", json!({ "accountId": id })).unwrap();
    assert_eq!((got["sendAs"].clone(), got["quietHours"].clone()), (json!(""), Value::Null));
    assert_eq!(got["signature"]["text"], "Ann");
    assert_eq!(raw(tmp.path(), &format!("acct.{id}.offlineWindow")), None);
}

#[test]
fn account_settings_apply_to_new_accounts_only() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    import(&e, &code(vec![imap("ann@example.test")], None));
    let ann = id_of(&e, "ann@example.test");
    e.rpc("mobile.accountSettings.set", json!({ "accountId": ann, "values": { "displayName": "Phone Ann", "notify": true } })).unwrap();

    let mut a = imap("ann@example.test");
    a.display_name = "Desk Ann".into();
    a.settings = Some(acct_settings());
    a.hidden = true;
    let mut b = imap("bob@example.test");
    b.display_name = "Bob Desk".into();
    b.settings = Some(acct_settings());
    let r = import(&e, &code(vec![a, b], None));
    assert_eq!((r["imported"].clone(), r["existing"].clone()), (json!(["bob@example.test"]), json!(["ann@example.test"])));

    // Ann was here: the phone's values stay, nothing of the desktop's lands.
    let got = e.rpc("mobile.accountSettings.get", json!({ "accountId": ann })).unwrap();
    assert_eq!((got["displayName"].clone(), got["notify"].clone(), got["hidden"].clone()), (json!("Phone Ann"), json!(true), json!(false)));
    assert_eq!(got["signature"], Value::Null);
    assert_eq!(raw(tmp.path(), &format!("acct.{ann}.offlineWindow")), None);

    // Bob is new: all of it.
    let bob = id_of(&e, "bob@example.test");
    let got = e.rpc("mobile.accountSettings.get", json!({ "accountId": bob })).unwrap();
    assert_eq!(got["displayName"], "Bob Desk");
    assert_eq!(got["signature"], json!({ "html": "<p>Ann</p>", "text": "Ann", "enabled": true }));
    assert_eq!(got["sendAs"], "ann@alias.test");
    assert_eq!(got["aliases"], json!([{ "address": "ann@alias.test", "name": "Ann A" }]));
    assert_eq!(got["sentFolder"], "Sent Items");
    assert_eq!((got["notify"].clone(), got["notifyFolders"].clone()), (json!(false), json!(["INBOX"])));
    assert_eq!(got["quietHours"], json!({ "enabled": true, "start": "22:00", "end": "07:00" }));
    assert!(!e.account_notifications_on(&bob));
    assert!(e.account_notifications_on(&ann));
    // The offline window, under the shared contract's key.
    assert_eq!(raw(tmp.path(), &format!("acct.{bob}.offlineWindow")).as_deref(), Some("6m"));
}

fn add_row(dir: &Path, account: &str, uid: i64, date_ms: i64) {
    let c = Connection::open(dir.join("mobile.db")).unwrap();
    c.execute("INSERT OR IGNORE INTO folders (account_id, path, name, special_use) VALUES (?1, 'INBOX', 'INBOX', NULL)", [account]).unwrap();
    c.execute(
        "INSERT INTO messages
         (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
         VALUES (?1, 'INBOX', ?2, 's', 'S', 's@example.test', ?3, '', 0, 0, 0)",
        rusqlite::params![account, uid, date_ms],
    )
    .unwrap();
}

#[test]
fn a_hidden_account_leaves_the_lists_but_stays_an_account() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let mut hidden = imap("hid@example.test");
    hidden.hidden = true;
    import(&e, &code(vec![imap("ann@example.test"), hidden], None));
    let (ann, hid) = (id_of(&e, "ann@example.test"), id_of(&e, "hid@example.test"));
    let list = e.rpc("mobile.accounts.list", json!({})).unwrap();
    let flags: Vec<(String, bool)> =
        list["accounts"].as_array().unwrap().iter().map(|a| (a["email"].as_str().unwrap().to_string(), a["hidden"].as_bool().unwrap())).collect();
    assert_eq!(flags, vec![("ann@example.test".to_string(), false), ("hid@example.test".to_string(), true)]);

    add_row(tmp.path(), &ann, 1, 100);
    add_row(tmp.path(), &hid, 1, 200);
    let page = e.rpc("mobile.messages.page", json!({ "scope": "allInboxes", "limit": 10 })).unwrap();
    let accounts: Vec<&str> = page["rows"].as_array().unwrap().iter().map(|r| r["accountId"].as_str().unwrap()).collect();
    assert_eq!(accounts, vec![ann.as_str()]);
    assert_eq!(page["total"], 1);

    // Shown again in Settings: back in All Inboxes.
    let got = e.rpc("mobile.accountSettings.set", json!({ "accountId": hid, "values": { "hidden": false } })).unwrap();
    assert_eq!(got["hidden"], false);
    let page = e.rpc("mobile.messages.page", json!({ "scope": "allInboxes", "limit": 10 })).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);
}

#[test]
fn account_settings_set_checks_names_and_values() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    import(&e, &code(vec![imap("ann@example.test")], None));
    let id = id_of(&e, "ann@example.test");
    let defaults = e.rpc("mobile.accountSettings.get", json!({ "accountId": id })).unwrap();
    assert_eq!(defaults["displayName"], "Desk Name");
    assert_eq!((defaults["hidden"].clone(), defaults["notify"].clone(), defaults["sendAs"].clone()), (json!(false), json!(true), json!("")));
    for bad in [
        json!({ "offlineWindow": "all" }),
        json!({ "colour": "red" }),
        json!({ "hidden": "yes" }),
        json!({ "signature": { "html": 3 } }),
        json!({ "sendAs": "two words@x.test" }),
        json!({ "quietHours": { "enabled": true, "start": "7", "end": "08:00" } }),
        json!({ "displayName": "a\nb" }),
    ] {
        let err = e.rpc("mobile.accountSettings.set", json!({ "accountId": id, "values": bad })).unwrap_err();
        assert_eq!(err.code(), "INVALID", "{bad}");
    }
    assert_eq!(e.rpc("mobile.accountSettings.get", json!({ "accountId": id })).unwrap(), defaults, "a refused set changes nothing");
    let got = e
        .rpc("mobile.accountSettings.set", json!({ "accountId": id, "values": { "displayName": " Ann  ", "signature": { "text": "-- Ann", "enabled": false } } }))
        .unwrap();
    assert_eq!(got["displayName"], "Ann");
    assert_eq!(got["signature"], json!({ "html": "", "text": "-- Ann", "enabled": false }));
    // The list shows the new name (compose's From name reads it there).
    let list = e.rpc("mobile.accounts.list", json!({})).unwrap();
    assert_eq!(list["accounts"][0]["displayName"], "Ann");
    // Blank is the address; null clears back to the default.
    let got = e.rpc("mobile.accountSettings.set", json!({ "accountId": id, "values": { "displayName": "", "signature": null } })).unwrap();
    assert_eq!((got["displayName"].clone(), got["signature"].clone()), (json!("ann@example.test"), Value::Null));
    assert_eq!(e.rpc("mobile.accountSettings.get", json!({ "accountId": "nope" })).unwrap_err().code(), "INVALID");
}

#[test]
fn removing_an_account_forgets_its_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let mut a = imap("ann@example.test");
    a.settings = Some(acct_settings());
    a.hidden = true;
    import(&e, &code(vec![a], None));
    let id = id_of(&e, "ann@example.test");
    assert!(raw(tmp.path(), &format!("acct.{id}.signature")).is_some());
    e.rpc("mobile.accounts.remove", json!({ "accountId": id })).unwrap();
    let left: i64 = Connection::open(tmp.path().join("mobile.db"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM settings WHERE key LIKE 'acct.%'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}
