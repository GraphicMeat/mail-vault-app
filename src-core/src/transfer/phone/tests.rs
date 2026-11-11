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
    let future = PhoneBundle { v: 2, accounts: vec![] };
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
    let bundle = PhoneBundle { v: 1, accounts: vec![] };
    let sealed = seal(PW, &bundle).unwrap();
    let u32_at = |i: usize| u32::from_le_bytes([sealed[i], sealed[i + 1], sealed[i + 2], sealed[i + 3]]);
    assert_eq!(Params { m_kib: u32_at(7), t: u32_at(11), p: u32_at(15) }, crypto::EXPORT_PARAMS);
}

#[test]
fn open_refuses_key_derivation_above_the_export_parameters() {
    // A crafted code must not make the phone derive with more memory or time than the desktop
    // ever seals with (1 GiB at the crypto ceiling). Refused from the header, before argon2.
    let sealed = seal_with(PW, &PhoneBundle { v: 1, accounts: vec![] }, cheap()).unwrap();
    let e = crypto::EXPORT_PARAMS;
    for (at, value) in [(7, e.m_kib + 1), (11, e.t + 1), (15, e.p + 1)] {
        let mut s = sealed.clone();
        s[at..at + 4].copy_from_slice(&value.to_le_bytes());
        assert!(matches!(open(PW, &s).unwrap_err(), PhoneError::Invalid(_)), "header offset {at}");
    }
}

#[test]
fn open_accepts_exactly_the_export_parameters() {
    let bundle = PhoneBundle { v: 1, accounts: vec![] };
    assert_eq!(open(PW, &seal(PW, &bundle).unwrap()).unwrap(), bundle);
}
