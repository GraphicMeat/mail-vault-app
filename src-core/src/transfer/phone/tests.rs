use super::*;
use crate::transfer::crypto::MIN_M_KIB;
use serde_json::json;

const PW: &str = "correct horse battery";

// Cheap params keep tests fast; the header carries them, decrypt reads them.
fn cheap() -> Params {
    Params { m_kib: MIN_M_KIB, t: 1, p: 1 }
}

fn gmail_oauth() -> Value {
    json!({ "id": "g", "email": "g@gmail.com", "name": "Gee", "authType": "oauth2", "oauth2Provider": "google",
        "oauth2RefreshToken": "rt-google", "oauth2AccessToken": "at-never-shipped", "oauth2ClientId": "own.apps.googleusercontent.com",
        "imapHost": "imap.gmail.com", "imapPort": 993, "smtpHost": "smtp.gmail.com", "smtpPort": 587, "smtpSecure": false })
}

fn outlook_graph() -> Value {
    json!({ "id": "o", "email": "o@outlook.com", "authType": "oauth2", "oauth2Provider": "microsoft",
        "oauth2Transport": "graph", "oauth2RefreshToken": "rt-ms" })
}

fn imap_password() -> Value {
    json!({ "id": "p", "email": "p@example.com", "authType": "password", "password": "app-pw",
        "imapHost": "mail.example.com", "imapPort": 143, "imapSecurity": "STARTTLS",
        "smtpHost": "mail.example.com", "smtpPort": 465, "smtpSecure": false })
}

fn jmap_token() -> Value {
    json!({ "id": "j", "email": "j@fastmail.com", "authType": "password", "password": "fmu1-tok",
        "jmapSessionUrl": " https://api.fastmail.com/jmap/session ", "jmapAuth": "bearer", "imapHost": "api.fastmail.com" })
}

fn one(acct: Value) -> PhoneAccount {
    let (b, skipped) = phone_bundle(&json!([acct]));
    assert!(skipped.is_empty(), "{skipped:?}");
    assert_eq!(b.accounts.len(), 1);
    b.accounts[0].clone()
}

fn skip(acct: Value) -> SkipReason {
    let (b, skipped) = phone_bundle(&json!([acct]));
    assert!(b.accounts.is_empty());
    assert_eq!(skipped.len(), 1);
    skipped[0].reason
}

// ── mapping ─────────────────────────────────────────────────────────────────

#[test]
fn google_oauth_maps_to_an_imap_oauth_row_without_the_access_token() {
    let a = one(gmail_oauth());
    assert_eq!(a.email, "g@gmail.com");
    assert_eq!(a.display_name, "Gee");
    assert_eq!((a.kind, a.auth), (PhoneKind::Imap, PhoneAuth::OAuth2));
    assert_eq!(a.provider.as_deref(), Some("google"));
    assert_eq!((a.imap_host.as_deref(), a.imap_port, a.security.as_deref()), (Some("imap.gmail.com"), Some(993), Some("ssl")));
    assert_eq!((a.smtp_host.as_deref(), a.smtp_port, a.smtp_security.as_deref()), (Some("smtp.gmail.com"), Some(587), Some("starttls")));
    assert_eq!(a.refresh.as_deref(), Some("rt-google"));
    assert_eq!(a.client_id.as_deref(), Some("own.apps.googleusercontent.com"));
    assert_eq!(a.password, None);
    let text = serde_json::to_string(&a).unwrap();
    assert!(!text.contains("at-never-shipped"));
}

#[test]
fn graph_maps_to_a_graph_oauth_row_with_no_servers() {
    let a = one(outlook_graph());
    assert_eq!((a.kind, a.auth), (PhoneKind::Graph, PhoneAuth::OAuth2));
    assert_eq!(a.provider.as_deref(), Some("microsoft"));
    assert_eq!(a.refresh.as_deref(), Some("rt-ms"));
    assert_eq!((a.imap_host.clone(), a.smtp_host.clone()), (None, None));
}

#[test]
fn graph_without_a_provider_is_microsoft() {
    let mut acct = outlook_graph();
    acct.as_object_mut().unwrap().remove("oauth2Provider");
    assert_eq!(one(acct).provider.as_deref(), Some("microsoft"));
}

#[test]
fn microsoft_oauth_over_imap_stays_imap() {
    let acct = json!({ "email": "w@corp.example", "authType": "oauth2", "oauth2Provider": "microsoft", "oauth2RefreshToken": "rt",
        "imapHost": "outlook.office365.com", "imapPort": 993, "smtpHost": "smtp.office365.com", "smtpPort": 587 });
    let a = one(acct);
    assert_eq!((a.kind, a.provider.as_deref()), (PhoneKind::Imap, Some("microsoft")));
}

#[test]
fn password_imap_maps_security_like_the_desktop_engine() {
    let a = one(imap_password());
    assert_eq!((a.kind, a.auth), (PhoneKind::Imap, PhoneAuth::Password));
    assert_eq!(a.password.as_deref(), Some("app-pw"));
    assert_eq!((a.imap_port, a.security.as_deref()), (Some(143), Some("starttls")));
    // 465 is implicit TLS whatever smtpSecure says
    assert_eq!((a.smtp_port, a.smtp_security.as_deref()), (Some(465), Some("ssl")));
    assert_eq!((a.provider.clone(), a.refresh.clone(), a.client_id.clone()), (None, None, None));
}

#[test]
fn imap_security_falls_back_to_the_legacy_flag_and_defaults_to_ssl() {
    let with = |extra: Value| {
        let mut acct = json!({ "email": "a@x.com", "password": "pw", "imapHost": "imap.x.com" });
        for (k, v) in extra.as_object().unwrap() {
            acct[k] = v.clone();
        }
        one(acct)
    };
    assert_eq!(with(json!({})).security.as_deref(), Some("ssl"));
    assert_eq!(with(json!({})).imap_port, Some(993));
    assert_eq!(with(json!({ "imapSecure": false })).security.as_deref(), Some("none"));
    assert_eq!(with(json!({ "imapSecure": true })).security.as_deref(), Some("ssl"));
    assert_eq!(with(json!({ "imapSecurity": "none", "imapSecure": true })).security.as_deref(), Some("none"));
    assert_eq!(with(json!({ "imapSecurity": "weird" })).security.as_deref(), Some("ssl"));
    // no SMTP stored: none carried; SMTP host without port: 587 STARTTLS
    assert_eq!(with(json!({})).smtp_host, None);
    let s = with(json!({ "smtpHost": "smtp.x.com" }));
    assert_eq!((s.smtp_port, s.smtp_security.as_deref()), (Some(587), Some("starttls")));
    let s = with(json!({ "smtpHost": "smtp.x.com", "smtpPort": 2525, "smtpSecure": true }));
    assert_eq!((s.smtp_port, s.smtp_security.as_deref()), (Some(2525), Some("ssl")));
}

#[test]
fn jmap_token_maps_to_bearer_with_the_trimmed_session_url() {
    let a = one(jmap_token());
    assert_eq!((a.kind, a.auth), (PhoneKind::Jmap, PhoneAuth::Bearer));
    assert_eq!(a.jmap_url.as_deref(), Some("https://api.fastmail.com/jmap/session"));
    assert_eq!(a.password.as_deref(), Some("fmu1-tok"));
    assert_eq!(a.imap_host, None);
}

#[test]
fn jmap_basic_maps_to_password_when_the_login_is_the_address() {
    let acct = json!({ "email": "j@host.example", "password": "pw", "jmapSessionUrl": "https://host.example/jmap", "jmapAuth": "Basic",
        "jmapUsername": "J@HOST.example" });
    let a = one(acct);
    assert_eq!((a.kind, a.auth), (PhoneKind::Jmap, PhoneAuth::Password));
}

#[test]
fn a_missing_secret_is_skipped_as_no_secret() {
    let mut g = gmail_oauth();
    g["oauth2RefreshToken"] = json!("");
    assert_eq!(skip(g), SkipReason::NoSecret);
    let mut p = imap_password();
    p.as_object_mut().unwrap().remove("password");
    assert_eq!(skip(p), SkipReason::NoSecret);
    let mut j = jmap_token();
    j["password"] = json!(null);
    assert_eq!(skip(j), SkipReason::NoSecret);
}

#[test]
fn oauth_through_another_provider_is_unsupported() {
    let mut g = gmail_oauth();
    g["oauth2Provider"] = json!("yahoo");
    assert_eq!(skip(g), SkipReason::UnsupportedProvider);
    let mut g = gmail_oauth();
    g.as_object_mut().unwrap().remove("oauth2Provider");
    assert_eq!(skip(g), SkipReason::UnsupportedProvider);
}

#[test]
fn a_custom_oauth_client_or_tenant_is_skipped() {
    let mut a = outlook_graph();
    a["oauth2CustomClientId"] = json!("my-app");
    assert_eq!(skip(a), SkipReason::CustomOauthClient);
    let mut a = outlook_graph();
    a["oauth2TenantId"] = json!("contoso.onmicrosoft.com");
    assert_eq!(skip(a), SkipReason::CustomOauthClient);
    // the default tenants are not custom
    for tenant in ["", "common"] {
        let mut a = outlook_graph();
        a["oauth2TenantId"] = json!(tenant);
        one(a);
    }
}

#[test]
fn jmap_basic_with_a_separate_login_is_skipped() {
    let acct = json!({ "email": "me@host.example", "password": "pw", "jmapSessionUrl": "https://host.example/jmap", "jmapAuth": "basic",
        "jmapUsername": "me" });
    assert_eq!(skip(acct), SkipReason::JmapLogin);
}

#[test]
fn contradictory_or_missing_settings_are_invalid() {
    // no IMAP host
    assert_eq!(skip(json!({ "email": "a@x.com", "password": "pw" })), SkipReason::Invalid);
    // JMAP without a known auth mode
    assert_eq!(skip(json!({ "email": "a@x.com", "password": "pw", "jmapSessionUrl": "https://x/jmap" })), SkipReason::Invalid);
    // Graph without OAuth, Google over Graph
    assert_eq!(skip(json!({ "email": "a@x.com", "password": "pw", "oauth2Transport": "graph" })), SkipReason::Invalid);
    let mut g = outlook_graph();
    g["oauth2Provider"] = json!("google");
    assert_eq!(skip(g), SkipReason::Invalid);
    // no address
    let (_, skipped) = phone_bundle(&json!([{ "password": "pw", "imapHost": "imap.x.com" }]));
    assert_eq!(skipped, vec![Skipped { email: String::new(), reason: SkipReason::Invalid }]);
}

#[test]
fn order_is_kept_and_skips_are_named() {
    let mut broken = imap_password();
    broken["password"] = json!("");
    let (b, skipped) = phone_bundle(&json!([gmail_oauth(), broken, outlook_graph(), jmap_token()]));
    let emails: Vec<_> = b.accounts.iter().map(|a| a.email.as_str()).collect();
    assert_eq!(emails, vec!["g@gmail.com", "o@outlook.com", "j@fastmail.com"]);
    assert_eq!(b.v, PHONE_BUNDLE_VERSION);
    assert_eq!(skipped, vec![Skipped { email: "p@example.com".into(), reason: SkipReason::NoSecret }]);
    // a non-array is no accounts
    let (b, skipped) = phone_bundle(&json!({}));
    assert!(b.accounts.is_empty() && skipped.is_empty());
}

#[test]
fn skip_reasons_serialize_in_kebab_case() {
    let s = Skipped { email: "a@x.com".into(), reason: SkipReason::CustomOauthClient };
    assert_eq!(serde_json::to_value(&s).unwrap(), json!({ "email": "a@x.com", "reason": "custom-oauth-client" }));
    assert_eq!(serde_json::to_value(SkipReason::NoSecret).unwrap(), json!("no-secret"));
    assert_eq!(serde_json::to_value(SkipReason::JmapLogin).unwrap(), json!("jmap-login"));
}

#[test]
fn debug_never_prints_a_secret() {
    let a = one(imap_password());
    let g = one(gmail_oauth());
    let text = format!("{a:?} {g:?}");
    assert!(!text.contains("app-pw") && !text.contains("rt-google"), "{text}");
}

#[test]
fn the_wire_names_are_the_documented_camel_case() {
    let v = serde_json::to_value(one(jmap_token())).unwrap();
    assert_eq!(v["kind"], "jmap");
    assert_eq!(v["auth"], "bearer");
    assert_eq!(v["jmapUrl"], "https://api.fastmail.com/jmap/session");
    let v = serde_json::to_value(one(gmail_oauth())).unwrap();
    assert_eq!(v["displayName"], "Gee");
    assert_eq!(v["imapHost"], "imap.gmail.com");
    assert_eq!(v["smtpSecurity"], "starttls");
    assert_eq!(v["clientId"], "own.apps.googleusercontent.com");
    assert_eq!(v["auth"], "oauth2");
}

// ── seal / open / frames ────────────────────────────────────────────────────

/// Letters from a xorshift: real refresh tokens are random, so they do not deflate away.
fn noise(seed: u64, len: usize) -> String {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            char::from(b'A' + (x % 52) as u8 % 26 + if x % 2 == 0 { 32 } else { 0 })
        })
        .collect()
}

fn sample() -> Value {
    json!([gmail_oauth(), outlook_graph(), imap_password(), jmap_token()])
}

#[test]
fn roundtrip_through_frames_in_any_order() {
    let qr = encode_phone_qr_with(PW, &sample(), cheap()).unwrap();
    assert!(qr.skipped.is_empty());
    assert!(!qr.frames.is_empty());
    for f in &qr.frames {
        assert!(f.len() <= MAX_FRAME_CHARS);
    }
    let mut shuffled: Vec<String> = qr.frames.iter().rev().cloned().collect();
    shuffled.extend(qr.frames.iter().cloned()); // repeats, as the camera reads them
    let got = decode_phone_bundle(PW, &shuffled).unwrap();
    let (want, _) = phone_bundle(&sample());
    assert_eq!(got, want);
}

#[test]
fn a_bundle_too_big_for_one_frame_cycles_frames_and_still_decodes() {
    let many: Vec<Value> = (0..20)
        .map(|i| {
            let mut a = outlook_graph();
            a["email"] = json!(format!("user{i}@outlook.com"));
            // Microsoft refresh tokens are long and random: incompressible
            a["oauth2RefreshToken"] = json!(noise(i as u64 + 1, 1200));
            a
        })
        .collect();
    let qr = encode_phone_qr_with(PW, &Value::Array(many), cheap()).unwrap();
    assert!(qr.frames.len() > 1, "{} frame(s)", qr.frames.len());
    assert_eq!(decode_phone_bundle(PW, &qr.frames).unwrap().accounts.len(), 20);
}

#[test]
fn the_wrong_password_is_bad_password() {
    let qr = encode_phone_qr_with(PW, &sample(), cheap()).unwrap();
    let err = decode_phone_bundle("wrong horse battery!", &qr.frames).unwrap_err();
    assert!(matches!(err, PhoneError::BadPassword), "{err:?}");
    assert_eq!(err.to_string(), "E_TRANSFER_DECRYPT");
}

#[test]
fn missing_frames_are_incomplete() {
    let many: Vec<Value> = (0..10)
        .map(|i| {
            let mut a = outlook_graph();
            a["oauth2RefreshToken"] = json!(noise(i as u64 + 100, 900));
            a
        })
        .collect();
    let qr = encode_phone_qr_with(PW, &Value::Array(many), cheap()).unwrap();
    assert!(qr.frames.len() >= 2);
    let err = decode_phone_bundle(PW, &qr.frames[1..]).unwrap_err();
    assert!(matches!(err, PhoneError::Frame(FrameError::Incomplete { have, total }) if have == qr.frames.len() - 1 && total == qr.frames.len()), "{err:?}");
    assert!(matches!(decode_phone_bundle::<&str>(PW, &[]).unwrap_err(), PhoneError::Frame(FrameError::Incomplete { have: 0, total: 0 })));
}

#[test]
fn frames_of_two_codes_do_not_mix() {
    let a = encode_phone_qr_with(PW, &sample(), cheap()).unwrap();
    let b = encode_phone_qr_with(PW, &sample(), cheap()).unwrap();
    let mixed = vec![a.frames[0].clone(), b.frames[0].clone()];
    assert!(matches!(decode_phone_bundle(PW, &mixed).unwrap_err(), PhoneError::Frame(FrameError::ForeignId)));
}

#[test]
fn a_short_password_is_refused_before_sealing() {
    let err = encode_phone_qr_with("short-11-ch", &sample(), cheap()).unwrap_err();
    assert!(matches!(err, PhoneError::Password));
    assert_eq!(err.to_string(), "E_TRANSFER_PASSWORD");
    // counted in characters, not bytes
    assert!(matches!(encode_phone_qr_with(&"é".repeat(11), &sample(), cheap()).unwrap_err(), PhoneError::Password));
    assert!(encode_phone_qr_with(&"é".repeat(12), &sample(), cheap()).is_ok());
}

#[test]
fn nothing_to_send_is_no_frames() {
    let mut p = imap_password();
    p["password"] = json!("");
    let qr = encode_phone_qr_with(PW, &json!([p]), cheap()).unwrap();
    assert!(qr.frames.is_empty());
    assert_eq!(qr.skipped.len(), 1);
}

#[test]
fn open_refuses_another_version_and_garbage() {
    let future = PhoneBundle { v: 2, accounts: vec![], settings: None, tags: None, fields: None, views: None, auto_tags: None };
    let sealed = seal_with(PW, &future, cheap()).unwrap();
    assert!(matches!(open(PW, &sealed).unwrap_err(), PhoneError::Invalid(_)));
    // sealed but not deflate
    let raw = crypto::encrypt_with(PW, b"{\"v\":1,\"accounts\":[]}", cheap()).unwrap();
    assert!(matches!(open(PW, &raw).unwrap_err(), PhoneError::Invalid(_)));
    assert!(matches!(open(PW, b"short").unwrap_err(), PhoneError::Invalid(_)));
}

#[test]
fn a_deflate_bomb_is_refused() {
    use flate2::write::DeflateEncoder;
    use std::io::Write;
    let mut enc = DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(&vec![b' '; (MAX_PLAIN_BYTES as usize) + 10]).unwrap();
    let sealed = crypto::encrypt_with(PW, &enc.finish().unwrap(), cheap()).unwrap();
    assert!(matches!(open(PW, &sealed).unwrap_err(), PhoneError::Invalid(_)));
}

#[test]
fn errors_name_no_secret() {
    let qr = encode_phone_qr_with(PW, &sample(), cheap()).unwrap();
    let err = decode_phone_bundle("wrong horse battery!", &qr.frames).unwrap_err().to_string();
    assert!(!err.contains("wrong horse") && !err.contains("rt-") && !err.contains("MVQR1"), "{err}");
}

#[test]
fn production_seal_uses_the_export_parameters() {
    // header bytes 7..19 carry m, t, p
    let bundle = PhoneBundle { v: 1, accounts: vec![], settings: None, tags: None, fields: None, views: None, auto_tags: None };
    let sealed = seal(PW, &bundle).unwrap();
    let u32_at = |i: usize| u32::from_le_bytes([sealed[i], sealed[i + 1], sealed[i + 2], sealed[i + 3]]);
    assert_eq!(Params { m_kib: u32_at(7), t: u32_at(11), p: u32_at(15) }, crypto::EXPORT_PARAMS);
}

#[test]
fn open_refuses_key_derivation_above_the_export_parameters() {
    // A crafted code must not make the phone derive with more memory or time than the desktop
    // ever seals with (1 GiB at the crypto ceiling). Refused from the header, before argon2.
    let sealed = seal_with(PW, &PhoneBundle { v: 1, accounts: vec![], settings: None, tags: None, fields: None, views: None, auto_tags: None }, cheap()).unwrap();
    let e = crypto::EXPORT_PARAMS;
    for (at, value) in [(7, e.m_kib + 1), (11, e.t + 1), (15, e.p + 1)] {
        let mut s = sealed.clone();
        s[at..at + 4].copy_from_slice(&value.to_le_bytes());
        assert!(matches!(open(PW, &s).unwrap_err(), PhoneError::Invalid(_)), "header offset {at}");
    }
}

#[test]
fn open_accepts_exactly_the_export_parameters() {
    let bundle = PhoneBundle { v: 1, accounts: vec![], settings: None, tags: None, fields: None, views: None, auto_tags: None };
    assert_eq!(open(PW, &seal(PW, &bundle).unwrap()).unwrap(), bundle);
}

// ── color and order ─────────────────────────────────────────────────────────

#[test]
fn color_and_desktop_order_are_carried() {
    let mut g = gmail_oauth();
    g["color"] = json!("#EC4899");
    let mut broken = imap_password();
    broken["password"] = json!("");
    let mut o = outlook_graph();
    o["color"] = json!("red; background:url(https://x.test/)");
    let (b, _) = phone_bundle(&json!([g, broken, o, jmap_token()]));
    let got: Vec<_> = b.accounts.iter().map(|a| (a.email.as_str(), a.color.as_deref(), a.order)).collect();
    // The order is the desktop list's position (a skipped account keeps its slot); a color that is
    // not `#rrggbb` is dropped, never the account.
    assert_eq!(
        got,
        vec![("g@gmail.com", Some("#ec4899"), Some(0)), ("o@outlook.com", None, Some(2)), ("j@fastmail.com", None, Some(3))]
    );
    let v = serde_json::to_value(&b.accounts[0]).unwrap();
    assert_eq!((v["color"].clone(), v["order"].clone()), (json!("#ec4899"), json!(0)));
}

#[test]
fn color_and_order_roundtrip_through_frames() {
    let mut g = gmail_oauth();
    g["color"] = json!("#8b5cf6");
    let mut p = imap_password();
    p["color"] = json!("#14b8a6");
    let qr = encode_phone_qr_with(PW, &json!([p, g]), cheap()).unwrap();
    let got = decode_phone_bundle(PW, &qr.frames).unwrap();
    let got: Vec<_> = got.accounts.iter().map(|a| (a.email.clone(), a.color.clone(), a.order)).collect();
    assert_eq!(
        got,
        vec![
            ("p@example.com".to_string(), Some("#14b8a6".to_string()), Some(0)),
            ("g@gmail.com".to_string(), Some("#8b5cf6".to_string()), Some(1)),
        ]
    );
}

#[test]
fn an_old_bundle_without_color_or_order_still_opens() {
    // What a desktop before color and order sealed.
    let old = br#"{"v":1,"accounts":[{"email":"a@x.test","kind":"imap","auth":"password","imapHost":"imap.x.test","password":"pw"}]}"#;
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(old).unwrap();
    let sealed = crypto::encrypt_with(PW, &enc.finish().unwrap(), cheap()).unwrap();
    let b = open(PW, &sealed).unwrap();
    assert_eq!(b.accounts.len(), 1);
    assert_eq!((b.accounts[0].color.clone(), b.accounts[0].order), (None, None));
}

// ── settings ────────────────────────────────────────────────────────────────

fn desktop_settings() -> Value {
    json!({ "language": "de", "theme": "light", "palette": "teal", "markAsReadMode": "delay", "markAsReadDelay": 5,
        "confirmBeforeDelete": true, "afterDeleteSelect": "previous", "swipeLeftAction": "archive", "swipeRightAction": "star",
        "sendDelay": 10, "holdExternalContent": false, "dateFormat": "yyyy-MM-dd", "timeFormat": "24h", "notificationPreview": false,
        "importantSenders": [{ "match": "boss@corp.test", "throughQuietHours": true }],
        "templates": [{ "name": "Thanks", "body": "Thank you!" }],
        "someFutureSetting": { "x": 1 } })
}

fn with_phone_settings(mut a: Value, block: Value) -> Value {
    a["phoneSettings"] = block;
    a
}

#[test]
fn hidden_accounts_are_carried_as_hidden() {
    let mut g = gmail_oauth();
    g["hidden"] = json!(true);
    let a = one(g);
    assert!(a.hidden);
    assert_eq!(serde_json::to_value(&a).unwrap()["hidden"], json!(true));
    // not hidden: no field on the wire at all
    let v = serde_json::to_value(one(imap_password())).unwrap();
    assert!(v.get("hidden").is_none() && v.get("settings").is_none(), "{v}");
}

#[test]
fn global_and_account_settings_are_carried() {
    let g = with_phone_settings(
        gmail_oauth(),
        json!({ "signature": { "html": "<p>Gee</p>", "text": "Gee", "enabled": true }, "sendAs": "alias@gmail.com",
            "aliases": [{ "address": "alias@gmail.com", "name": "Alias" }], "sentFolderOverride": "[Gmail]/Sent Mail",
            "notifications": { "enabled": false, "folders": ["INBOX"], "quietHours": { "enabled": true, "start": "22:00", "end": "07:00" } },
            "fetchMode": "keepRecent", "cacheMonths": 6 }),
    );
    let (b, _) = phone_bundle_with_settings(&json!([g, imap_password()]), Some(&desktop_settings()));
    let s = b.settings.clone().unwrap();
    assert_eq!((s.language.as_deref(), s.theme.as_deref(), s.palette.as_deref()), (Some("de"), Some("light"), Some("teal")));
    assert_eq!((s.mark_as_read_mode.as_deref(), s.mark_as_read_delay, s.send_delay), (Some("delay"), Some(5), Some(10)));
    assert_eq!((s.hold_external_content, s.notification_preview, s.confirm_before_delete), (Some(false), Some(false), Some(true)));
    assert_eq!(s.templates.as_ref().unwrap()[0].name, "Thanks");
    assert_eq!(s.important_senders.as_ref().unwrap()[0].matches, "boss@corp.test");
    let a = b.accounts[0].settings.clone().unwrap();
    assert_eq!(a.signature.as_ref().unwrap().text, "Gee");
    assert_eq!(a.send_as.as_deref(), Some("alias@gmail.com"));
    assert_eq!(a.aliases.as_ref().unwrap()[0].name, "Alias");
    assert_eq!(a.sent_folder_override.as_deref(), Some("[Gmail]/Sent Mail"));
    assert_eq!(a.notifications.as_ref().unwrap().enabled, Some(false));
    assert_eq!(a.notifications.as_ref().unwrap().quiet_hours.as_ref().unwrap().start, "22:00");
    assert_eq!(a.offline_window.as_deref(), Some("6m"));
    // an account without a block carries none
    assert!(b.accounts[1].settings.is_none());
    // and it all survives the trip
    let g = with_phone_settings(gmail_oauth(), json!({ "fetchMode": "hoarder" }));
    let qr = encode_phone_qr_settings_with(PW, &json!([g]), Some(&desktop_settings()), cheap()).unwrap();
    let got = decode_phone_bundle(PW, &qr.frames).unwrap();
    assert_eq!(got.settings.unwrap().palette.as_deref(), Some("teal"));
    assert_eq!(got.accounts[0].settings.as_ref().unwrap().offline_window.as_deref(), Some("all"));
}

#[test]
fn a_setting_of_another_shape_loses_only_that_setting() {
    let mut s = desktop_settings();
    s["sendDelay"] = json!("ten");
    s["templates"] = json!("not a list");
    let (b, _) = phone_bundle_with_settings(&json!([gmail_oauth()]), Some(&s));
    let got = b.settings.unwrap();
    assert_eq!((got.send_delay, got.templates.clone()), (None, None));
    assert_eq!(got.language.as_deref(), Some("de"));
    // A newer desktop's odd shapes, straight on the wire: the code still opens with every account.
    let wire = br#"{"v":1,"settings":{"theme":7,"language":"fr"},"accounts":[{"email":"a@x.test","kind":"imap","auth":"password",
        "imapHost":"imap.x.test","password":"pw","hidden":true,"settings":{"signature":"oops","sendAs":"b@x.test"}},
        {"email":"c@x.test","kind":"imap","auth":"password","imapHost":"imap.x.test","password":"pw","settings":[1,2]}]}"#;
    let b: PhoneBundle = serde_json::from_slice(wire).unwrap();
    assert_eq!(b.accounts.len(), 2);
    let s = b.settings.clone().unwrap();
    assert_eq!((s.theme, s.language.as_deref()), (None, Some("fr")));
    let a = b.accounts[0].settings.clone().unwrap();
    assert_eq!((a.signature, a.send_as.as_deref()), (None, Some("b@x.test")));
    assert!(b.accounts[0].hidden);
    assert!(b.accounts[1].settings.is_none());
}

#[test]
fn an_older_phone_reads_a_bundle_with_settings() {
    // The phone's structs before settings, as an older build has them.
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    #[serde(rename_all = "camelCase")]
    struct OldAccount {
        email: String,
        #[serde(default)]
        display_name: String,
        kind: PhoneKind,
        auth: PhoneAuth,
        #[serde(default)]
        imap_host: Option<String>,
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        refresh: Option<String>,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        order: Option<u32>,
    }
    #[derive(serde::Deserialize)]
    struct OldBundle {
        v: u32,
        accounts: Vec<OldAccount>,
    }
    let mut g = with_phone_settings(gmail_oauth(), json!({ "signature": { "html": "<b>x</b>", "text": "x" }, "fetchMode": "keepRecent" }));
    g["hidden"] = json!(true);
    let (b, _) = phone_bundle_with_settings(&json!([g, imap_password()]), Some(&desktop_settings()));
    let text = serde_json::to_string(&b).unwrap();
    assert!(text.contains("\"settings\"") && text.contains("\"hidden\""));
    let old: OldBundle = serde_json::from_str(&text).unwrap();
    assert_eq!(old.v, 1);
    assert_eq!(old.accounts.len(), 2);
    assert_eq!(old.accounts[0].refresh.as_deref(), Some("rt-google"));
}

#[test]
fn a_bundle_from_an_older_desktop_has_no_settings() {
    let old = br##"{"v":1,"accounts":[{"email":"a@x.test","kind":"imap","auth":"password","imapHost":"imap.x.test","password":"pw","color":"#112233","order":0}]}"##;
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(old).unwrap();
    let sealed = crypto::encrypt_with(PW, &enc.finish().unwrap(), cheap()).unwrap();
    let b = open(PW, &sealed).unwrap();
    assert!(b.settings.is_none());
    assert!(!b.accounts[0].hidden && b.accounts[0].settings.is_none());
}

#[test]
fn offline_window_maps_the_desktop_fetch_mode() {
    let table: [(Option<&str>, Option<f64>, &str); 14] = [
        (Some("hoarder"), None, "all"),
        (Some("hoarder"), Some(3.0), "all"),
        (Some("keepRecent"), Some(1.0), "1m"),
        (Some("keepRecent"), Some(3.0), "3m"),
        (Some("keepRecent"), Some(6.0), "6m"),
        (Some("keepRecent"), Some(12.0), "12m"),
        (Some("keepRecent"), Some(2.0), "3m"),
        (Some("keepRecent"), Some(9.0), "12m"),
        (Some("keepRecent"), Some(24.0), "12m"),
        (Some("keepRecent"), None, "3m"),
        (Some("keepRecent"), Some(0.0), "3m"),
        (Some("onDemand"), Some(12.0), "3m"),
        (Some("indexOnly"), Some(1.0), "3m"),
        (None, None, "3m"),
    ];
    for (mode, months, want) in table {
        assert_eq!(offline_window(mode, months), want, "{mode:?} {months:?}");
    }
}

#[test]
fn strip_data_images_keeps_everything_else() {
    let html = r#"<p>Hi</p><IMG alt="logo" SRC="data:image/png;base64,AAAA"><img src="https://x.test/a.png"><b>bye</b>"#;
    assert_eq!(settings::strip_data_images(html), r#"<p>Hi</p><img src="https://x.test/a.png"><b>bye</b>"#);
    assert_eq!(settings::strip_data_images("<p>plain</p>"), "<p>plain</p>");
}

/// Five OAuth accounts with long random tokens, each with a `signature`, plus `templates`.
fn heavy(signature: impl Fn(usize) -> Value, templates: usize) -> (Value, Value) {
    let accounts: Vec<Value> = (0..5)
        .map(|i| {
            let mut a = outlook_graph();
            a["email"] = json!(format!("user{i}@outlook.com"));
            a["oauth2RefreshToken"] = json!(noise(i as u64 + 7, 1200));
            with_phone_settings(a, json!({ "signature": signature(i), "sendAs": "", "fetchMode": "keepRecent", "cacheMonths": 3 }))
        })
        .collect();
    let mut s = desktop_settings();
    s["templates"] = json!((0..templates).map(|i| json!({ "name": format!("t{i}"), "body": noise(i as u64 + 500, 900) })).collect::<Vec<_>>());
    (Value::Array(accounts), s)
}

fn fit_of(accounts: &Value, s: &Value) -> (Degrade, PhoneBundle) {
    let (mut b, _) = phone_bundle_with_settings(accounts, Some(s));
    let d = settings::fit(&mut b);
    (d, b)
}

fn assert_accounts_intact(accounts: &Value, s: &Value) {
    let qr = encode_phone_qr_settings_with(PW, accounts, Some(s), cheap()).unwrap();
    let got = decode_phone_bundle(PW, &qr.frames).unwrap();
    assert_eq!(got.accounts.len(), 5);
    for (i, a) in got.accounts.iter().enumerate() {
        assert_eq!(a.refresh.as_deref(), Some(noise(i as u64 + 7, 1200).as_str()));
    }
    assert!(got.settings.is_some(), "the scalars always fit");
}

#[test]
fn small_settings_fit_whole() {
    let (accounts, s) = heavy(|i| json!({ "html": format!("<p>User {i}</p>"), "text": format!("User {i}") }), 1);
    let (d, b) = fit_of(&accounts, &s);
    assert_eq!(d, Degrade::Full);
    assert_eq!(b.settings.unwrap().templates.unwrap().len(), 1);
}

#[test]
fn too_many_templates_go_first() {
    let (accounts, s) = heavy(|i| json!({ "html": format!("<p>User {i}</p>"), "text": format!("User {i}") }), 20);
    let (d, b) = fit_of(&accounts, &s);
    assert_eq!(d, Degrade::NoTemplates);
    assert!(b.settings.as_ref().unwrap().templates.is_none());
    assert_eq!(b.settings.as_ref().unwrap().language.as_deref(), Some("de"));
    assert!(b.accounts.iter().all(|a| a.settings.as_ref().unwrap().signature.as_ref().unwrap().html.starts_with("<p>User")));
    assert_accounts_intact(&accounts, &s);
}

#[test]
fn then_images_inside_signatures() {
    let sig = |i: usize| {
        json!({ "html": format!("<p>User {i}</p><img src=\"data:image/png;base64,{}\">", noise(i as u64 + 900, 3000)), "text": format!("User {i}") })
    };
    let (accounts, s) = heavy(sig, 20);
    let (d, b) = fit_of(&accounts, &s);
    assert_eq!(d, Degrade::NoSignatureImages);
    assert!(b.settings.as_ref().unwrap().templates.is_none());
    for (i, a) in b.accounts.iter().enumerate() {
        let sig = a.settings.as_ref().unwrap().signature.as_ref().unwrap();
        assert_eq!((sig.html.clone(), sig.text.clone()), (format!("<p>User {i}</p>"), format!("User {i}")));
    }
    assert_accounts_intact(&accounts, &s);
}

#[test]
fn then_the_signatures() {
    let sig = |i: usize| json!({ "html": format!("<p>{}</p>", noise(i as u64 + 300, 2500)), "text": noise(i as u64 + 400, 2500) });
    let (accounts, s) = heavy(sig, 20);
    let (d, b) = fit_of(&accounts, &s);
    assert_eq!(d, Degrade::NoSignatures);
    for a in &b.accounts {
        let st = a.settings.as_ref().unwrap();
        assert!(st.signature.is_none());
        assert_eq!(st.offline_window.as_deref(), Some("3m"));
    }
    assert_eq!(b.settings.as_ref().unwrap().theme.as_deref(), Some("light"));
    assert_accounts_intact(&accounts, &s);
}

#[test]
fn the_reader_quick_actions_are_carried_in_the_desktop_vocabulary() {
    let mut s = desktop_settings();
    s["quickActionsReader"] = json!(["archive", "spam", "reply", "star"]);
    let (b, _) = phone_bundle_with_settings(&json!([gmail_oauth()]), Some(&s));
    assert_eq!(
        b.settings.unwrap().quick_actions_reader,
        Some(vec!["archive".to_string(), "spam".into(), "reply".into(), "star".into()])
    );
    // Another shape loses only that setting.
    s["quickActionsReader"] = json!({ "defaults": {} });
    let (b, _) = phone_bundle_with_settings(&json!([gmail_oauth()]), Some(&s));
    let got = b.settings.unwrap();
    assert_eq!(got.quick_actions_reader, None);
    assert_eq!(got.language.as_deref(), Some("de"));
}

#[test]
fn the_row_and_selection_quick_actions_are_carried_as_the_desktop_keeps_them() {
    let cfg = json!({
        "defaults": {
            "row": { "mode": "radial", "entries": [{ "id": "reply", "action": "reply" }, { "id": "delete", "action": "delete" }], "palette": "semantic" },
            "selection": { "mode": "inline", "entries": [{ "id": "markRead", "action": "markRead" }], "selectionActionLimit": 3 },
        },
    });
    let mut s = desktop_settings();
    s["quickActions"] = cfg.clone();
    let (b, _) = phone_bundle_with_settings(&json!([gmail_oauth()]), Some(&s));
    assert_eq!(b.settings.unwrap().quick_actions, Some(cfg));
    // Another shape, or a configuration too big for a code, loses only that setting.
    for bad in [json!(["row"]), json!("row"), json!({ "defaults": { "row": { "noise": "x".repeat(40_000) } } })] {
        s["quickActions"] = bad;
        let (b, _) = phone_bundle_with_settings(&json!([gmail_oauth()]), Some(&s));
        let got = b.settings.unwrap();
        assert_eq!(got.quick_actions, None);
        assert_eq!(got.language.as_deref(), Some("de"));
    }
}

#[test]
fn quick_actions_stay_while_dropping_templates_is_enough_and_go_right_after() {
    let small = json!({ "defaults": { "row": { "mode": "radial", "entries": [{ "id": "reply", "action": "reply" }] } } });
    let (accounts, mut s) = heavy(|i| json!({ "html": format!("<p>User {i}</p>"), "text": format!("User {i}") }), 20);
    s["quickActions"] = small.clone();
    let (d, b) = fit_of(&accounts, &s);
    assert_eq!(d, Degrade::NoTemplates);
    let got = b.settings.unwrap();
    assert!(got.templates.is_none());
    assert_eq!(got.quick_actions, Some(small));

    // A configuration that is itself too much for the code goes before anything else of the person's.
    let (accounts, mut s) = heavy(|i| json!({ "html": format!("<p>User {i}</p>"), "text": format!("User {i}") }), 0);
    s["quickActions"] = json!({ "defaults": { "row": { "noise": noise(77, 30_000) } } });
    let (d, b) = fit_of(&accounts, &s);
    assert_eq!(d, Degrade::NoTemplates);
    let got = b.settings.unwrap();
    assert!(got.quick_actions.is_none());
    assert_eq!(got.language.as_deref(), Some("de"));
}

#[test]
fn the_folder_icon_style_and_picks_are_carried_and_a_bad_shape_loses_only_that_setting() {
    // Picks are keyed by the account's address, the one name both devices share.
    let picks = json!({ "ann@example.test|Work": "#ef4444", "ann@example.test|INBOX": "#3B82F6" });
    let mut s = desktop_settings();
    s["folderIconStyle"] = json!("theme");
    s["folderIconColors"] = picks.clone();
    let (b, _) = phone_bundle_with_settings(&json!([gmail_oauth()]), Some(&s));
    let got = b.settings.unwrap();
    assert_eq!(got.folder_icon_style.as_deref(), Some("theme"));
    assert_eq!(got.folder_icon_colors, Some(picks));
    // Another shape, or too many picks for a code, loses only the picks.
    let many: serde_json::Map<String, Value> = (0..2_000).map(|i| (format!("ann@example.test|F{i}"), json!("#ef4444"))).collect();
    for bad in [json!(["a"]), json!("a"), Value::Object(many)] {
        s["folderIconColors"] = bad;
        let (b, _) = phone_bundle_with_settings(&json!([gmail_oauth()]), Some(&s));
        let got = b.settings.unwrap();
        assert_eq!(got.folder_icon_colors, None);
        assert_eq!(got.folder_icon_style.as_deref(), Some("theme"));
        assert_eq!(got.language.as_deref(), Some("de"));
    }
}

// ── tags ────────────────────────────────────────────────────────────────────

fn tag_store() -> rusqlite::Connection {
    let dir = std::env::temp_dir().join(format!("mv-phone-tags-{}", uuid::Uuid::new_v4()));
    crate::app_db::db::open(&dir).expect("open")
}

fn target(account: &str, key: &str) -> crate::app_db::tags::Target {
    crate::app_db::tags::Target { account_id: account.into(), msg_key: key.into() }
}

#[test]
fn tags_travel_under_the_account_address_with_their_color() {
    use crate::app_db::tags as store;
    let c = tag_store();
    let work = store::ensure(&c, "Work", "#AABBCC").unwrap();
    let odd = store::ensure(&c, "Odd", "red; background:url(x)").unwrap();
    store::assign(&c, &work.id, &[target("p", "a@example.com"), target("gone-account", "b@example.com")]).unwrap();
    store::assign(&c, &odd.id, &[target("p", "u:INBOX:7")]).unwrap();

    let snap = tags::snapshot(&c, &sample()).unwrap().unwrap();
    assert_eq!(snap.list, vec![
        PhoneTag { name: "Work".into(), color: "#aabbcc".into() },
        PhoneTag { name: "Odd".into(), color: String::new() },
    ]);
    // The account the desktop no longer has is left out; the rest go by address.
    assert_eq!(snap.assigned, vec![
        PhoneTagged { email: "p@example.com".into(), tag: 1, keys: vec!["u:INBOX:7".into()] },
        PhoneTagged { email: "p@example.com".into(), tag: 0, keys: vec!["a@example.com".into()] },
    ]);
    assert!(tags::snapshot(&tag_store(), &sample()).unwrap().is_none(), "no tags, no block");
}

#[test]
fn tags_ride_the_code_and_come_back_out() {
    let block = PhoneTags {
        list: vec![PhoneTag { name: "Work".into(), color: "#112233".into() }],
        assigned: vec![PhoneTagged { email: "p@example.com".into(), tag: 0, keys: vec!["a@example.com".into()] }],
    };
    let mut sent = block.clone();
    sent.assigned.push(PhoneTagged { email: "skipped@example.com".into(), tag: 0, keys: vec!["b@example.com".into()] });
    let qr = encode_phone_qr_full_with(PW, &sample(), None, Some(sent), cheap()).unwrap();
    // An account the code does not carry takes no room.
    assert_eq!(decode_phone_bundle(PW, &qr.frames).unwrap().tags, Some(block));
}

/// Thousands of assignments do not fit a code: every account and every tag still go, with the
/// assignments that fit, and the code stays within its frames.
#[test]
fn too_many_assignments_are_cut_never_the_accounts_or_the_tags() {
    let list: Vec<PhoneTag> = (0..30).map(|i| PhoneTag { name: format!("Tag {i}"), color: "#123456".into() }).collect();
    let assigned: Vec<PhoneTagged> = (0..3u32)
        .map(|t| PhoneTagged {
            email: "p@example.com".into(),
            tag: t,
            keys: (0..2000).map(|n| format!("{}@mail.example.com", noise(u64::from(t) * 10_000 + n + 1, 24))).collect(),
        })
        .collect();
    let block = PhoneTags { list: list.clone(), assigned };
    let qr = encode_phone_qr_full_with(PW, &sample(), None, Some(block), cheap()).unwrap();
    assert!(qr.frames.len() <= MAX_FRAMES, "{} frames", qr.frames.len());
    let got = decode_phone_bundle(PW, &qr.frames).unwrap();
    assert_eq!(got.accounts.len(), 4);
    let tags = got.tags.expect("the tags are kept");
    assert_eq!(tags.list, list);
    let kept = tags.assignment_count();
    assert!(kept > 50 && kept < 6000, "{kept} assignments kept");
    // Each tag got its turn: none crowded the others out.
    assert_eq!(tags.assigned.len(), 3, "{:?}", tags.assigned.iter().map(|a| a.keys.len()).collect::<Vec<_>>());
    // The newest of each tag went first.
    assert_eq!(tags.assigned[0].keys[0], format!("{}@mail.example.com", noise(1, 24)));
}

#[test]
fn a_code_without_tags_or_with_a_tags_block_of_another_shape_still_opens() {
    // An older desktop: no `tags`. A newer one that changed its shape: the tags are lost, not the import.
    for tags in [None, Some(json!([1, 2])), Some(json!({ "list": "nope" }))] {
        let mut v = serde_json::to_value(phone_bundle(&sample()).0).unwrap();
        if let Some(t) = tags {
            v["tags"] = t;
        }
        let back: PhoneBundle = serde_json::from_value(v).unwrap();
        assert_eq!(back.accounts.len(), 4);
        assert_eq!(back.tags, None);
    }
}

#[test]
fn a_desktop_uid_key_is_kept_only_for_an_imap_account() {
    let tagged = PhoneTagged { email: "x@example.com".into(), tag: 0, keys: vec!["a@example.com".into(), "u:INBOX:7".into(), " ".into()] };
    assert_eq!(tags::keys_for(PhoneKind::Imap, &tagged), vec!["a@example.com".to_string(), "u:INBOX:7".to_string()]);
    assert_eq!(tags::keys_for(PhoneKind::Graph, &tagged), vec!["a@example.com".to_string()]);
    assert_eq!(tags::keys_for(PhoneKind::Jmap, &tagged), vec!["a@example.com".to_string()]);
}

// ── fields ──────────────────────────────────────────────────────────────────

fn field(id: &str, scope: &str, name: &str, kind: &str) -> crate::app_db::fields::Field {
    crate::app_db::fields::Field {
        id: id.into(),
        scope: scope.into(),
        name: name.into(),
        kind: kind.into(),
        options: vec![crate::app_db::fields::FieldOption { id: "hi".into(), label: "High".into(), color: "#ff0000".into() }],
        position: 0,
    }
}

#[test]
fn fields_travel_with_their_ids_and_the_account_address() {
    use crate::app_db::fields as store;
    let c = tag_store();
    store::save(&c, &field("g1", "*", "Owner", "text")).unwrap();
    store::save(&c, &field("f1", "p", "Priority", "select")).unwrap();
    store::save(&c, &field("f2", "gone-account", "Stale", "text")).unwrap();
    store::set_value(&c, "p", "a@example.com", "f1", Some(&json!("hi"))).unwrap();
    store::set_value(&c, "gone-account", "b@example.com", "g1", Some(&json!("Bo"))).unwrap();

    let snap = fields::snapshot(&c, &sample()).unwrap().unwrap();
    let ids: Vec<(&str, Option<&str>)> = snap.list.iter().map(|f| (f.id.as_str(), f.email.as_deref())).collect();
    // A field of an account the desktop no longer has stays home.
    assert_eq!(ids, vec![("g1", None), ("f1", Some("p@example.com"))]);
    assert_eq!(snap.list[1].options[0].id, "hi");
    assert_eq!(snap.values, vec![PhoneFieldValues { email: "p@example.com".into(), field: 1, values: vec![("a@example.com".into(), json!("hi"))] }]);
    assert!(fields::snapshot(&tag_store(), &sample()).unwrap().is_none(), "no fields, no block");
}

#[test]
fn fields_ride_the_code_and_a_skipped_accounts_go_with_it() {
    let shared = PhoneField { id: "g1".into(), email: None, name: "Owner".into(), kind: "text".into(), options: vec![] };
    let mine = PhoneField { id: "f1".into(), email: Some("p@example.com".into()), name: "Priority".into(), kind: "text".into(), options: vec![] };
    let theirs = PhoneField { id: "f2".into(), email: Some("skipped@example.com".into()), name: "X".into(), kind: "text".into(), options: vec![] };
    let sent = PhoneFields {
        list: vec![shared.clone(), theirs, mine.clone()],
        values: vec![
            PhoneFieldValues { email: "p@example.com".into(), field: 2, values: vec![("a@example.com".into(), json!("v"))] },
            PhoneFieldValues { email: "skipped@example.com".into(), field: 0, values: vec![("b@example.com".into(), json!("w"))] },
        ],
    };
    let blocks = PhoneBlocks { fields: Some(sent), ..PhoneBlocks::default() };
    let qr = encode_phone_qr_blocks_with(PW, &sample(), None, blocks, cheap()).unwrap();
    let got = decode_phone_bundle(PW, &qr.frames).unwrap().fields.expect("fields");
    assert_eq!(got.list, vec![shared, mine]);
    assert_eq!(got.values, vec![PhoneFieldValues { email: "p@example.com".into(), field: 1, values: vec![("a@example.com".into(), json!("v"))] }]);
}

#[test]
fn too_many_values_are_cut_never_the_fields_or_the_accounts() {
    let list: Vec<PhoneField> =
        (0..3).map(|i| PhoneField { id: format!("f{i}"), email: Some("p@example.com".into()), name: format!("F{i}"), kind: "text".into(), options: vec![] }).collect();
    let values: Vec<PhoneFieldValues> = (0..3u32)
        .map(|f| PhoneFieldValues {
            email: "p@example.com".into(),
            field: f,
            values: (0..3000).map(|n| (format!("{}@mail.example.com", noise(u64::from(f) * 10_000 + n + 1, 24)), json!(noise(n + 7, 30)))).collect(),
        })
        .collect();
    let blocks = PhoneBlocks { fields: Some(PhoneFields { list: list.clone(), values }), ..PhoneBlocks::default() };
    let qr = encode_phone_qr_blocks_with(PW, &sample(), None, blocks, cheap()).unwrap();
    assert!(qr.frames.len() <= MAX_FRAMES, "{} frames", qr.frames.len());
    let got = decode_phone_bundle(PW, &qr.frames).unwrap();
    assert_eq!(got.accounts.len(), 4);
    let fields = got.fields.expect("the fields are kept");
    assert_eq!(fields.list, list);
    let kept = fields.value_count();
    assert!(kept > 20 && kept < 9000, "{kept} values kept");
    assert_eq!(fields.values.len(), 3, "each field got its turn");
}

#[test]
fn a_code_without_fields_or_with_a_fields_block_of_another_shape_still_opens() {
    for block in [None, Some(json!("x")), Some(json!({ "list": [{ "id": 1 }] }))] {
        let mut v = serde_json::to_value(phone_bundle(&sample()).0).unwrap();
        if let Some(b) = block {
            v["fields"] = b;
        }
        let back: PhoneBundle = serde_json::from_value(v).unwrap();
        assert_eq!(back.accounts.len(), 4);
        assert_eq!(back.fields, None);
    }
}

#[test]
fn a_phone_from_before_fields_reads_a_code_that_has_them() {
    // The bundle as the tags build had it: no `fields`.
    #[derive(serde::Deserialize)]
    struct TagsEraBundle {
        v: u32,
        accounts: Vec<PhoneAccount>,
        #[serde(default)]
        tags: Option<PhoneTags>,
    }
    let fields = PhoneFields { list: vec![PhoneField { id: "g1".into(), email: None, name: "Owner".into(), kind: "text".into(), options: vec![] }], values: vec![] };
    let tags = PhoneTags { list: vec![PhoneTag { name: "Work".into(), color: String::new() }], assigned: vec![] };
    let blocks = PhoneBlocks { tags: Some(tags.clone()), fields: Some(fields), views: None, auto_tags: None };
    let qr = encode_phone_qr_blocks_with(PW, &sample(), None, blocks, cheap()).unwrap();
    let full = decode_phone_bundle(PW, &qr.frames).unwrap();
    assert!(full.fields.is_some());
    let old: TagsEraBundle = serde_json::from_value(serde_json::to_value(&full).unwrap()).unwrap();
    assert_eq!((old.v, old.accounts.len(), old.tags), (1, 4, Some(tags)));
}

// ── views ───────────────────────────────────────────────────────────────────

#[test]
fn views_travel_by_address_and_tag_name_and_one_the_phone_cannot_follow_stays_home() {
    use crate::app_db::views::{self as store, View, ViewDef};
    let c = tag_store();
    assert!(views::snapshot(&c, &sample()).unwrap().is_none(), "a desktop that never listed its views sends none");
    store::ensure_starters(&c).unwrap();
    let work = crate::app_db::tags::ensure(&c, "Work", "").unwrap();
    crate::app_db::fields::save(&c, &field("f1", "*", "Priority", "select")).unwrap();
    let view = |id: &str, def: ViewDef| View { id: id.into(), name: id.into(), icon: "tag".into(), position: 0, builtin: None, def };
    let filter = |id: &str| crate::app_db::fields::FieldFilter { field_id: id.into(), op: "is".into(), value: json!("hi") };
    store::save(&c, &view("mine", ViewDef { accounts: vec!["p".into()], tags: vec![work.id.clone()], fields: vec![filter("f1")], ..ViewDef::default() })).unwrap();
    store::save(&c, &view("gone-account", ViewDef { accounts: vec!["gone".into()], ..ViewDef::default() })).unwrap();
    store::save(&c, &view("gone-tag", ViewDef { tags: vec!["no-such-tag".into()], ..ViewDef::default() })).unwrap();
    store::save(&c, &view("gone-field", ViewDef { fields: vec![filter("nope")], ..ViewDef::default() })).unwrap();

    let snap = views::snapshot(&c, &sample()).unwrap().unwrap();
    assert!(snap.seeded);
    let ids: Vec<&str> = snap.list.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(ids, vec!["builtin-needs-reply", "builtin-starred", "builtin-attachments", "mine"]);
    let mine = &snap.list[3].def;
    assert_eq!(mine.accounts, vec!["p@example.com".to_string()]);
    assert_eq!(mine.tags, vec!["Work".to_string()]);
    assert_eq!(mine.fields[0].field_id, "f1");
}

#[test]
fn views_ride_the_code_and_a_skipped_accounts_view_does_not() {
    let view = |id: &str, accounts: Vec<String>| PhoneView {
        id: id.into(), name: id.into(), icon: "tag".into(), builtin: None,
        def: crate::app_db::views::ViewDef { accounts, ..Default::default() },
    };
    let sent = PhoneViews { list: vec![view("all", vec![]), view("theirs", vec!["skipped@example.com".into()]), view("mine", vec!["p@example.com".into()])], seeded: true };
    let blocks = PhoneBlocks { views: Some(sent), ..PhoneBlocks::default() };
    let qr = encode_phone_qr_blocks_with(PW, &sample(), None, blocks, cheap()).unwrap();
    let got = decode_phone_bundle(PW, &qr.frames).unwrap().views.expect("views");
    assert_eq!(got.list.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["all", "mine"]);
    assert!(got.seeded);
}

#[test]
fn a_code_without_views_or_with_a_views_block_of_another_shape_still_opens() {
    for block in [None, Some(json!(7)), Some(json!({ "list": [{ "def": 1 }] }))] {
        let mut v = serde_json::to_value(phone_bundle(&sample()).0).unwrap();
        if let Some(b) = block {
            v["views"] = b;
        }
        let back: PhoneBundle = serde_json::from_value(v).unwrap();
        assert_eq!(back.accounts.len(), 4);
        assert_eq!(back.views, None);
    }
}

// ── Auto Tag rules ──────────────────────────────────────────────────────────

fn auto_rule(tag_id: &str, provider: Value, enabled: bool) -> crate::app_db::auto_tags::RuleDraft {
    crate::app_db::auto_tags::RuleDraft {
        name: "Receipts".into(),
        instruction: "receipts and invoices".into(),
        constraints: crate::app_db::auto_tags::Constraints { from_domain: Some("shop.example".into()), ..Default::default() },
        tag_id: tag_id.into(),
        inbox_action: crate::app_db::auto_tags::InboxAction::Hide,
        min_confidence: 0.8,
        allow_remote: !provider.is_null(),
        provider,
        enabled,
    }
}

#[test]
fn auto_tag_rules_travel_by_tag_name_with_their_endpoint_and_never_a_rule_whose_tag_is_gone() {
    use crate::app_db::auto_tags as store;
    let c = tag_store();
    assert!(auto_tags::snapshot(&c).unwrap().is_none(), "a desktop with no rules sends none");
    let work = crate::app_db::tags::ensure(&c, "Work", "").unwrap();
    let endpoint = json!({ "type": "endpoint", "url": "https://ai.example.test/v1", "model": "m" });
    store::create(&c, auto_rule(&work.id, endpoint, true)).unwrap();
    store::create(&c, auto_rule(&work.id, json!({ "type": "localGguf" }), false)).unwrap();
    store::create(&c, auto_rule("no-such-tag", Value::Null, true)).unwrap();

    let snap = auto_tags::snapshot(&c).unwrap().unwrap();
    assert_eq!(snap.list.len(), 2, "the rule whose tag is gone stays home");
    let remote = &snap.list[0];
    assert_eq!((remote.tag.as_str(), remote.inbox_action, remote.min_confidence, remote.enabled), ("Work", crate::app_db::auto_tags::InboxAction::Hide, 0.8, true));
    assert_eq!(remote.endpoint, Some(PhoneEndpoint { url: "https://ai.example.test/v1".into(), model: "m".into() }));
    assert_eq!(remote.constraints.from_domain.as_deref(), Some("shop.example"));
    assert_eq!(snap.list[1].endpoint, None, "an on-device provider is none on the phone");
    assert_eq!(auto_tags::provider_of(remote.endpoint.as_ref()), json!({ "type": "endpoint", "url": "https://ai.example.test/v1", "model": "m" }));
    assert_eq!(auto_tags::provider_of(None), Value::Null);
}

#[test]
fn auto_tag_rules_ride_the_code() {
    let rule = |id: &str| PhoneAutoTag {
        id: id.into(), name: id.into(), instruction: "receipts".into(), constraints: Default::default(), tag: "Work".into(),
        inbox_action: crate::app_db::auto_tags::InboxAction::Keep, min_confidence: 0.7, allow_remote: false, endpoint: None, enabled: true,
    };
    let sent = PhoneAutoTags { list: vec![rule("a"), rule("b")] };
    let blocks = PhoneBlocks { auto_tags: Some(sent.clone()), ..PhoneBlocks::default() };
    let qr = encode_phone_qr_blocks_with(PW, &sample(), None, blocks, cheap()).unwrap();
    assert_eq!(decode_phone_bundle(PW, &qr.frames).unwrap().auto_tags, Some(sent));
}

#[test]
fn many_auto_tag_rules_are_cut_to_their_room() {
    let rule = |i: usize| PhoneAutoTag {
        id: format!("rule-{i}"), name: format!("Rule {i}"), instruction: format!("{i} {}", "unrepeatable words ".repeat(20) + &i.to_string().repeat(40)),
        constraints: Default::default(), tag: "Work".into(), inbox_action: crate::app_db::auto_tags::InboxAction::Keep,
        min_confidence: 0.7, allow_remote: false, endpoint: None, enabled: true,
    };
    let mut bundle = phone_bundle(&sample()).0;
    bundle.auto_tags = Some(PhoneAutoTags { list: (0..2000).map(rule).collect() });
    let dropped = auto_tags::fit(&mut bundle);
    let kept = bundle.auto_tags.as_ref().map_or(0, |a| a.list.len());
    assert!(dropped > 0 && kept > 0, "kept {kept}, dropped {dropped}");
    assert_eq!(kept + dropped, 2000);
}

#[test]
fn a_code_without_auto_tags_or_with_a_block_of_another_shape_still_opens() {
    for block in [None, Some(json!("x")), Some(json!({ "list": [{ "id": 1 }] })), Some(json!({ "list": [{ "id": "r", "inboxAction": "archive" }] }))] {
        let mut v = serde_json::to_value(phone_bundle(&sample()).0).unwrap();
        if let Some(b) = block {
            v["autoTags"] = b;
        }
        let back: PhoneBundle = serde_json::from_value(v).unwrap();
        assert_eq!(back.accounts.len(), 4);
        assert_eq!(back.auto_tags, None);
    }
}

#[test]
fn a_phone_from_before_auto_tags_reads_a_code_that_has_them() {
    // The bundle as the views build had it: no `autoTags`.
    #[derive(serde::Deserialize)]
    struct ViewsEraBundle {
        v: u32,
        accounts: Vec<PhoneAccount>,
        #[serde(default)]
        views: Option<PhoneViews>,
    }
    let rules = PhoneAutoTags { list: vec![PhoneAutoTag {
        id: "r".into(), name: "R".into(), instruction: "receipts".into(), constraints: Default::default(), tag: "Work".into(),
        inbox_action: crate::app_db::auto_tags::InboxAction::Keep, min_confidence: 0.7, allow_remote: false, endpoint: None, enabled: false,
    }] };
    let views = PhoneViews { list: vec![], seeded: true };
    let blocks = PhoneBlocks { views: Some(views.clone()), auto_tags: Some(rules), ..PhoneBlocks::default() };
    let qr = encode_phone_qr_blocks_with(PW, &sample(), None, blocks, cheap()).unwrap();
    let full = decode_phone_bundle(PW, &qr.frames).unwrap();
    assert!(full.auto_tags.is_some());
    let old: ViewsEraBundle = serde_json::from_value(serde_json::to_value(&full).unwrap()).unwrap();
    assert_eq!((old.v, old.accounts.len(), old.views), (1, 4, Some(views)));
}
