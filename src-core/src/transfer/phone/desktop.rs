//! The other way round: phone accounts as the desktop's `.mvtransfer` bundle (what desktop's
//! "Move to another computer" export writes and its import reads, `transfer.export` /
//! `transfer.decrypt`), so the phone can hand its accounts to a computer. Each account is the
//! desktop's account object that [`super::phone_bundle`] maps back to the same phone account; the
//! bundle carries the per-account settings desktop's import applies (display names, colors, hidden
//! accounts, order) and no app settings. Sealed with [`crate::transfer::crypto::encrypt`] over the
//! plain JSON, exactly as the daemon seals its own export (no deflate: that is the phone code's).
//!
//! Never log or put in an error: a bundle or a secret.
use super::{PhoneAccount, PhoneAuth, PhoneKind};
use serde_json::{json, Map, Value};

/// Graph needs no IMAP server; desktop keeps Outlook's on a Microsoft sign-in, and keys the account
/// by it (`accountLogicalKey`: email and `imapHost`).
const GRAPH_IMAP_HOST: &str = "outlook.office365.com";

/// The host desktop keys a JMAP account by: the session URL's, lowercased (`jmapSessionHost`).
fn url_host(url: &str) -> String {
    url::Url::parse(url.trim()).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_default()
}

/// One phone account as the desktop's account object, under `id`.
pub fn desktop_account(id: &str, a: &PhoneAccount) -> Value {
    let mut o = Map::new();
    let mut put = |k: &str, v: Value| {
        o.insert(k.to_string(), v);
    };
    put("id", json!(id));
    put("email", json!(a.email));
    let name = a.display_name.trim();
    put("name", json!(if name.is_empty() { a.email.as_str() } else { name }));
    match a.kind {
        PhoneKind::Imap => {
            put("imapHost", json!(a.imap_host.as_deref().unwrap_or_default()));
            put("imapPort", json!(a.imap_port.unwrap_or(993)));
            let security = a.security.as_deref().unwrap_or("ssl");
            put("imapSecurity", json!(security));
            put("imapSecure", json!(security == "ssl"));
            if let Some(host) = a.smtp_host.as_deref().filter(|h| !h.trim().is_empty()) {
                let ssl = a.smtp_security.as_deref() == Some("ssl");
                put("smtpHost", json!(host));
                put("smtpPort", json!(a.smtp_port.unwrap_or(if ssl { 465 } else { 587 })));
                put("smtpSecure", json!(ssl));
            }
        }
        PhoneKind::Graph => {
            put("imapHost", json!(GRAPH_IMAP_HOST));
            put("imapPort", json!(993));
            put("imapSecurity", json!("ssl"));
            put("imapSecure", json!(true));
            put("oauth2Transport", json!("graph"));
        }
        PhoneKind::Jmap => {
            let url = a.jmap_url.as_deref().unwrap_or_default().trim();
            put("jmapSessionUrl", json!(url));
            put("jmapAuth", json!(if a.auth == PhoneAuth::Bearer { "bearer" } else { "basic" }));
            put("imapHost", json!(url_host(url)));
        }
    }
    match a.auth {
        PhoneAuth::Password | PhoneAuth::Bearer => {
            put("authType", json!("password"));
            put("password", json!(a.password.as_deref().unwrap_or_default()));
        }
        PhoneAuth::OAuth2 => {
            put("authType", json!("oauth2"));
            put("oauth2Provider", json!(a.provider.as_deref().unwrap_or_default()));
            put("oauth2RefreshToken", json!(a.refresh.as_deref().unwrap_or_default()));
            if let Some(c) = a.client_id.as_deref().filter(|c| !c.is_empty()) {
                put("oauth2ClientId", json!(c));
            }
            if a.kind == PhoneKind::Imap {
                put("oauth2Transport", json!("imap"));
            }
        }
    }
    Value::Object(o)
}

/// The whole bundle for `accounts` (id, account), in list order: `formatVersion` 1, the accounts,
/// their display names, colors and hidden flags (`accountSettings`, desktop's per-account maps)
/// and their order. `appSettings` and `theme` are null: the phone's settings are not desktop's.
pub fn desktop_bundle(accounts: &[(String, PhoneAccount)], exported_at_ms: u64) -> Value {
    let mut names = Map::new();
    let mut colors = Map::new();
    let mut hidden = Map::new();
    for (id, a) in accounts {
        let name = a.display_name.trim();
        // The phone stores the address as the name when there is none: not a name to send with.
        if !name.is_empty() && !name.eq_ignore_ascii_case(a.email.trim()) {
            names.insert(id.clone(), json!(name));
        }
        if let Some(c) = a.color.as_deref().and_then(super::hex_color) {
            colors.insert(id.clone(), json!(c));
        }
        if a.hidden {
            hidden.insert(id.clone(), json!(true));
        }
    }
    json!({
        "formatVersion": 1,
        "exportedAt": exported_at_ms,
        "accounts": accounts.iter().map(|(id, a)| desktop_account(id, a)).collect::<Vec<_>>(),
        "accountSettings": { "displayNames": names, "accountColors": colors, "hiddenAccounts": hidden },
        "accountOrder": accounts.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        "appSettings": null,
        "theme": null,
    })
}

#[cfg(test)]
mod tests {
    use super::super::phone_bundle;
    use super::*;
    use crate::transfer::bundle::completeness_problems;

    fn base(email: &str, kind: PhoneKind, auth: PhoneAuth) -> PhoneAccount {
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

    fn samples() -> Vec<PhoneAccount> {
        let mut imap = base("p@example.com", PhoneKind::Imap, PhoneAuth::Password);
        imap.display_name = "Pat".into();
        imap.imap_host = Some("mail.example.com".into());
        imap.imap_port = Some(143);
        imap.security = Some("starttls".into());
        imap.smtp_host = Some("mail.example.com".into());
        imap.smtp_port = Some(465);
        imap.smtp_security = Some("ssl".into());
        imap.password = Some(" pw with spaces ".into());
        let mut none = base("n@example.com", PhoneKind::Imap, PhoneAuth::Password);
        none.imap_host = Some("imap.example.com".into());
        none.imap_port = Some(143);
        none.security = Some("none".into());
        none.password = Some("pw".into());
        let mut gmail = base("g@gmail.com", PhoneKind::Imap, PhoneAuth::OAuth2);
        gmail.provider = Some("google".into());
        gmail.imap_host = Some("imap.gmail.com".into());
        gmail.imap_port = Some(993);
        gmail.security = Some("ssl".into());
        gmail.smtp_host = Some("smtp.gmail.com".into());
        gmail.smtp_port = Some(587);
        gmail.smtp_security = Some("starttls".into());
        gmail.refresh = Some("rt".into());
        gmail.client_id = Some("own.apps.googleusercontent.com".into());
        let mut graph = base("o@outlook.com", PhoneKind::Graph, PhoneAuth::OAuth2);
        graph.provider = Some("microsoft".into());
        graph.refresh = Some("rt-ms".into());
        let mut jmap = base("j@fastmail.com", PhoneKind::Jmap, PhoneAuth::Bearer);
        jmap.jmap_url = Some("https://API.fastmail.com/jmap/session".into());
        jmap.password = Some("tok".into());
        let mut basic = base("b@host.example", PhoneKind::Jmap, PhoneAuth::Password);
        basic.jmap_url = Some("https://host.example/jmap".into());
        basic.password = Some("pw".into());
        vec![imap, none, gmail, graph, jmap, basic]
    }

    #[test]
    fn every_kind_maps_back_to_the_same_phone_account() {
        for a in samples() {
            let (back, skipped) = phone_bundle(&json!([desktop_account("id-1", &a)]));
            assert!(skipped.is_empty(), "{}: {skipped:?}", a.email);
            let got = &back.accounts[0];
            assert_eq!((got.kind, got.auth), (a.kind, a.auth), "{}", a.email);
            assert_eq!((&got.email, &got.password, &got.refresh), (&a.email, &a.password, &a.refresh), "{}", a.email);
            assert_eq!((&got.provider, &got.client_id), (&a.provider, &a.client_id), "{}", a.email);
            assert_eq!((&got.imap_host, got.imap_port, &got.security), (&a.imap_host, a.imap_port, &a.security), "{}", a.email);
            assert_eq!((&got.smtp_host, got.smtp_port, &got.smtp_security), (&a.smtp_host, a.smtp_port, &a.smtp_security), "{}", a.email);
            assert_eq!(got.jmap_url, a.jmap_url.as_deref().map(str::trim).map(str::to_string), "{}", a.email);
        }
    }

    #[test]
    fn desktop_keys_and_flags_are_spelled_as_desktop_spells_them() {
        let s = samples();
        let imap = desktop_account("a", &s[0]);
        assert_eq!((imap["name"].clone(), imap["smtpSecure"].clone(), imap["imapSecure"].clone()), (json!("Pat"), json!(true), json!(false)));
        // No name: desktop's form fills the address.
        assert_eq!(desktop_account("b", &s[1])["name"], "n@example.com");
        assert_eq!(desktop_account("c", &s[2])["oauth2Transport"], "imap");
        let graph = desktop_account("d", &s[3]);
        assert_eq!((graph["oauth2Transport"].clone(), graph["imapHost"].clone()), (json!("graph"), json!(GRAPH_IMAP_HOST)));
        assert!(graph.get("oauth2AccessToken").is_none());
        let jmap = desktop_account("e", &s[4]);
        assert_eq!((jmap["imapHost"].clone(), jmap["jmapAuth"].clone()), (json!("api.fastmail.com"), json!("bearer")));
        assert_eq!(desktop_account("f", &s[5])["jmapAuth"], "basic");
    }

    #[test]
    fn the_bundle_carries_names_colors_hidden_and_order_and_passes_the_export_check() {
        let mut s = samples();
        s[0].color = Some("#AABBCC".into());
        s[1].hidden = true;
        s[2].color = Some("red; background:url(x)".into());
        let list: Vec<(String, PhoneAccount)> = s.into_iter().enumerate().map(|(i, a)| (format!("id-{i}"), a)).collect();
        let b = desktop_bundle(&list, 42);
        assert_eq!(b["formatVersion"], 1);
        assert_eq!(b["exportedAt"], 42);
        assert_eq!(b["accounts"].as_array().unwrap().len(), 6);
        assert_eq!(b["accountOrder"], json!(["id-0", "id-1", "id-2", "id-3", "id-4", "id-5"]));
        assert_eq!(b["accountSettings"]["displayNames"], json!({ "id-0": "Pat" }));
        assert_eq!(b["accountSettings"]["accountColors"], json!({ "id-0": "#aabbcc" }));
        assert_eq!(b["accountSettings"]["hiddenAccounts"], json!({ "id-1": true }));
        assert!(b["appSettings"].is_null() && b["theme"].is_null());
        assert!(completeness_problems(&b).is_empty());
    }
}
