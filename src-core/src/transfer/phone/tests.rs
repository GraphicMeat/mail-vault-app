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
    let future = PhoneBundle { v: 2, accounts: vec![], settings: None };
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
    let bundle = PhoneBundle { v: 1, accounts: vec![], settings: None };
    let sealed = seal(PW, &bundle).unwrap();
    let u32_at = |i: usize| u32::from_le_bytes([sealed[i], sealed[i + 1], sealed[i + 2], sealed[i + 3]]);
    assert_eq!(Params { m_kib: u32_at(7), t: u32_at(11), p: u32_at(15) }, crypto::EXPORT_PARAMS);
}

#[test]
fn open_refuses_key_derivation_above_the_export_parameters() {
    // A crafted code must not make the phone derive with more memory or time than the desktop
    // ever seals with (1 GiB at the crypto ceiling). Refused from the header, before argon2.
    let sealed = seal_with(PW, &PhoneBundle { v: 1, accounts: vec![], settings: None }, cheap()).unwrap();
    let e = crypto::EXPORT_PARAMS;
    for (at, value) in [(7, e.m_kib + 1), (11, e.t + 1), (15, e.p + 1)] {
        let mut s = sealed.clone();
        s[at..at + 4].copy_from_slice(&value.to_le_bytes());
        assert!(matches!(open(PW, &s).unwrap_err(), PhoneError::Invalid(_)), "header offset {at}");
    }
}

#[test]
fn open_accepts_exactly_the_export_parameters() {
    let bundle = PhoneBundle { v: 1, accounts: vec![], settings: None };
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
