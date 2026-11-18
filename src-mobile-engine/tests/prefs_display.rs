//! The display, mail and notification preferences a desktop import carries (text size, font, list
//! rows, signatures, toolbar labels, swipes, launch sync, attachments, delete in All Inboxes,
//! notification sound, the app badge) and each account's colour: their kinds in `mobile.prefs.*`,
//! the desktop's values on the first import, and the badge count the background run hands the
//! shell.

use mailvault_core::transfer::crypto::{Params, MIN_M_KIB};
use mailvault_core::transfer::phone::{frames, seal_with, PhoneAccount, PhoneAuth, PhoneBundle, PhoneKind, PhoneSettings, MAX_FRAME_CHARS};
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

fn code(accounts: Vec<PhoneAccount>, settings: Option<PhoneSettings>) -> Vec<String> {
    let sealed = seal_with(PW, &PhoneBundle { v: 1, accounts, settings, tags: None }, CHEAP).unwrap();
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

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("{v} is no number"))
}

#[test]
fn the_new_prefs_default_to_the_phone_as_it_was() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let p = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!(num(&p["textScale"]), 1.0);
    assert_eq!(p["appFont"], "instrument-sans");
    assert_eq!(p["listDensity"], "comfortable");
    assert_eq!(p["listPreviewLines"], 1);
    assert_eq!(p["signatureDisplay"], "always-show");
    assert_eq!(p["actionButtonDisplay"], "icon-only");
    assert_eq!(p["trackpadSwipeEnabled"], true);
    assert_eq!(p["refreshOnLaunch"], true);
    assert_eq!(p["autoDownloadAttachments"], false);
    assert_eq!(p["afterDeleteSameAccount"], false);
    assert_eq!(p["notificationSound"], true);
    assert_eq!((p["badgeEnabled"].clone(), p["badgeMode"].clone()), (json!(false), json!("unread")));
    assert!(e.notification_sound());
    assert_eq!(e.badge_count().unwrap(), None, "no badge until it is turned on");
}

#[test]
fn each_new_pref_takes_only_its_own_values() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let after = e
        .rpc(
            "mobile.prefs.set",
            json!({
                "textScale": 1.25, "appFont": "atkinson", "listDensity": "compact", "listPreviewLines": 3,
                "signatureDisplay": "collapsed", "actionButtonDisplay": "icon-label", "trackpadSwipeEnabled": false,
                "refreshOnLaunch": false, "autoDownloadAttachments": true, "afterDeleteSameAccount": true,
                "notificationSound": false, "badgeEnabled": true, "badgeMode": "total",
            }),
        )
        .unwrap();
    assert_eq!(num(&after["textScale"]), 1.25);
    assert_eq!((after["appFont"].clone(), after["listDensity"].clone(), after["listPreviewLines"].clone()), (json!("atkinson"), json!("compact"), json!(3)));
    assert_eq!((after["signatureDisplay"].clone(), after["actionButtonDisplay"].clone()), (json!("collapsed"), json!("icon-label")));
    assert_eq!(after["trackpadSwipeEnabled"], false);
    assert_eq!((after["refreshOnLaunch"].clone(), after["autoDownloadAttachments"].clone(), after["afterDeleteSameAccount"].clone()), (json!(false), json!(true), json!(true)));
    assert_eq!((after["notificationSound"].clone(), after["badgeEnabled"].clone(), after["badgeMode"].clone()), (json!(false), json!(true), json!("total")));
    assert!(!e.notification_sound());
    for bad in [
        json!({ "textScale": 1.3 }),
        json!({ "textScale": "1" }),
        json!({ "appFont": "google:Roboto" }),
        json!({ "appFont": "comic-sans" }),
        json!({ "listDensity": "cosy" }),
        json!({ "listPreviewLines": 4 }),
        json!({ "signatureDisplay": "never" }),
        json!({ "actionButtonDisplay": "icons" }),
        json!({ "refreshOnLaunch": "yes" }),
        json!({ "badgeMode": "flagged" }),
    ] {
        assert_eq!(e.rpc("mobile.prefs.set", bad.clone()).unwrap_err().code(), "INVALID", "{bad}");
    }
    assert_eq!(e.rpc("mobile.prefs.get", json!({})).unwrap(), after, "a refused set changes nothing");
    // Engine::set_setting reads the stored text as JSON first.
    e.set_setting("textScale", "0.9").unwrap();
    assert!(e.set_setting("textScale", "2").is_err());
    assert_eq!(num(&e.rpc("mobile.prefs.get", json!({})).unwrap()["textScale"]), 0.9);
}

#[test]
fn the_first_import_carries_the_desktop_values() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let s = PhoneSettings {
        text_scale: Some(1.1),
        app_font: Some("ibm-plex-mono".into()),
        list_density: Some("compact".into()),
        list_preview_lines: Some(0),
        signature_display: Some("smart".into()),
        action_button_display: Some("text-only".into()),
        trackpad_swipe_enabled: Some(false),
        refresh_on_launch: Some(false),
        auto_download_attachments: Some(true),
        after_delete_same_account: Some(true),
        notification_sound: Some("none".into()),
        badge_enabled: Some(true),
        badge_mode: Some("total".into()),
        ..PhoneSettings::default()
    };
    assert_eq!(import(&e, &code(vec![imap("ann@example.test")], Some(s)))["settingsApplied"], true);
    let p = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!(num(&p["textScale"]), 1.1);
    assert_eq!((p["appFont"].clone(), p["listDensity"].clone(), p["listPreviewLines"].clone()), (json!("ibm-plex-mono"), json!("compact"), json!(0)));
    assert_eq!((p["signatureDisplay"].clone(), p["actionButtonDisplay"].clone()), (json!("smart"), json!("text-only")));
    assert_eq!(p["trackpadSwipeEnabled"], false);
    assert_eq!((p["refreshOnLaunch"].clone(), p["autoDownloadAttachments"].clone(), p["afterDeleteSameAccount"].clone()), (json!(false), json!(true), json!(true)));
    // Desktop's silent sound is no sound; badge on, every message.
    assert_eq!((p["notificationSound"].clone(), p["badgeEnabled"].clone(), p["badgeMode"].clone()), (json!(false), json!(true), json!("total")));
}

#[test]
fn a_desktop_value_the_phone_has_not_is_left_out() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let s = PhoneSettings {
        // A downloaded Google font: the phone fetches no fonts.
        app_font: Some("google:Lobster".into()),
        text_scale: Some(3.0),
        list_preview_lines: Some(9),
        // Any Mac sound is the system's sound on the phone.
        notification_sound: Some("Glass".into()),
        badge_mode: Some("flagged".into()),
        // The rest still applies.
        list_density: Some("compact".into()),
        ..PhoneSettings::default()
    };
    import(&e, &code(vec![imap("ann@example.test")], Some(s)));
    let p = e.rpc("mobile.prefs.get", json!({})).unwrap();
    assert_eq!(p["appFont"], "instrument-sans");
    assert_eq!(num(&p["textScale"]), 1.0);
    assert_eq!(p["listPreviewLines"], 1);
    assert_eq!(p["notificationSound"], true);
    assert_eq!(p["badgeMode"], "unread");
    assert_eq!(p["listDensity"], "compact");
}

fn add_row(dir: &Path, account: &str, folder: &str, uid: i64, seen: bool) {
    let c = Connection::open(dir.join("mobile.db")).unwrap();
    c.execute("INSERT OR IGNORE INTO folders (account_id, path, name, special_use) VALUES (?1, ?2, ?2, NULL)", [account, folder]).unwrap();
    c.execute(
        "INSERT INTO messages
         (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
         VALUES (?1, ?2, ?3, 's', 'S', 's@example.test', ?3, '', ?4, 0, 0)",
        rusqlite::params![account, folder, uid, seen as i64],
    )
    .unwrap();
}

#[test]
fn the_badge_counts_the_inboxes_of_the_accounts_shown() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let mut hidden = imap("hid@example.test");
    hidden.hidden = true;
    import(&e, &code(vec![imap("ann@example.test"), imap("bob@example.test"), hidden], None));
    let (ann, bob, hid) = (id_of(&e, "ann@example.test"), id_of(&e, "bob@example.test"), id_of(&e, "hid@example.test"));
    add_row(tmp.path(), &ann, "INBOX", 1, false);
    add_row(tmp.path(), &ann, "INBOX", 2, true);
    add_row(tmp.path(), &bob, "INBOX", 1, false);
    // Not an inbox, and an account hidden from the lists: neither counts.
    add_row(tmp.path(), &ann, "Archive", 3, false);
    add_row(tmp.path(), &hid, "INBOX", 1, false);
    assert_eq!(e.badge_count().unwrap(), None);
    e.rpc("mobile.prefs.set", json!({ "badgeEnabled": true })).unwrap();
    assert_eq!(e.badge_count().unwrap(), Some(2), "unread in the inboxes shown");
    // The phone's own read and delete count at once.
    let c = Connection::open(tmp.path().join("mobile.db")).unwrap();
    c.execute("UPDATE messages SET local_seen = 1 WHERE account_id = ?1 AND uid = 1", [&bob]).unwrap();
    assert_eq!(e.badge_count().unwrap(), Some(1));
    e.rpc("mobile.prefs.set", json!({ "badgeMode": "total" })).unwrap();
    assert_eq!(e.badge_count().unwrap(), Some(3), "every message in the inboxes shown");
    c.execute("UPDATE messages SET local_deleted = 1 WHERE account_id = ?1 AND uid = 2", [&ann]).unwrap();
    assert_eq!(e.badge_count().unwrap(), Some(2));
}

#[test]
fn an_accounts_colour_is_set_checked_and_cleared() {
    let tmp = tempfile::tempdir().unwrap();
    let e = open(tmp.path());
    let mut a = imap("ann@example.test");
    a.color = Some("#8B5CF6".into());
    import(&e, &code(vec![a], None));
    let id = id_of(&e, "ann@example.test");
    let got = e.rpc("mobile.accountSettings.get", json!({ "accountId": id })).unwrap();
    assert_eq!(got["color"], "#8b5cf6", "the desktop's colour, from the import");
    for bad in [json!("red"), json!("#12345"), json!(7)] {
        let err = e.rpc("mobile.accountSettings.set", json!({ "accountId": id, "values": { "color": bad } })).unwrap_err();
        assert_eq!(err.code(), "INVALID", "{bad}");
    }
    let got = e.rpc("mobile.accountSettings.set", json!({ "accountId": id, "values": { "color": "#14B8A6" } })).unwrap();
    assert_eq!(got["color"], "#14b8a6");
    // The switcher and the All Inboxes dot read it from the account list.
    let list = e.rpc("mobile.accounts.list", json!({})).unwrap();
    assert_eq!(list["accounts"][0]["color"], "#14b8a6");
    let got = e.rpc("mobile.accountSettings.set", json!({ "accountId": id, "values": { "color": null } })).unwrap();
    assert_eq!(got["color"], Value::Null, "back to the colour hashed from the address");
}
