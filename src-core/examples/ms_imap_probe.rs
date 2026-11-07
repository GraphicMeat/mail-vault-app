//! Signs a Microsoft account in for IMAP with MailVault's own sign-in code,
//! then connects to Outlook's IMAP server and prints what came back: the
//! scopes Microsoft granted, the access token's audience, and the server's
//! reply to XOAUTH2 and LIST. Never prints the token.
//!
//!   cargo run -p mailvault-core --example ms_imap_probe -- you@outlook.com
//!   MAILVAULT_MS_CLIENT_ID=<other client id> cargo run ... (an A/B control)
//!
//! Needs port 19876 free: quit MailVault and its daemon first.

use base64::Engine;
use mailvault_core::imap::{self, ImapConfig, ImapPool};
use mailvault_core::oauth2::OAuth2Manager;
use serde_json::json;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let email = std::env::args().nth(1).expect("usage: ms_imap_probe <email>");
    if let Ok(client_id) = std::env::var("PROBE_PASTE_CLIENT_ID") {
        let token = paste_flow(&client_id, &email).await;
        return imap_check(&email, token).await;
    }
    if std::net::TcpListener::bind("127.0.0.1:19876").is_err() {
        eprintln!("port 19876 is busy: quit MailVault and its daemon (pkill -f mailvault-daemon), then retry");
        std::process::exit(2);
    }

    let oauth = OAuth2Manager::new();
    let url = oauth
        .generate_auth_url(Some(email.clone()), Some("microsoft".into()), None, None, false, None)
        .await
        .expect("auth url");
    println!("client id: {}", std::env::var("MAILVAULT_MS_CLIENT_ID").unwrap_or_else(|_| "MailVault (built in)".into()));
    println!("opening the Microsoft sign-in in your browser...");
    let _ = std::process::Command::new("open").arg(&url.auth_url).status();
    let token = match oauth.exchange_code(&url.state).await {
        Ok(t) => t,
        Err(e) => {
            println!("SIGN-IN FAILED: {e}");
            return;
        }
    };
    imap_check(&email, token.access_token).await;
}

/// The same sign-in MailVault makes (scopes, PKCE, no scope on the code
/// exchange) for a client whose only redirect is `https://localhost`: the
/// browser lands on a page that will not load, and its address is pasted
/// back here. Only the client id and redirect differ from MailVault's flow.
async fn paste_flow(client_id: &str, email: &str) -> String {
    use rand::Rng;
    use sha2::Digest;
    const REDIRECT: &str = "https://localhost";
    let b64 = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    let verifier = b64(&(0..32).map(|_| rand::rng().random::<u8>()).collect::<Vec<_>>());
    let challenge = b64(&sha2::Sha256::digest(verifier.as_bytes()));
    let url = url::Url::parse_with_params(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        &[
            ("client_id", client_id),
            ("response_type", "code"),
            ("redirect_uri", REDIRECT),
            ("scope", "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"),
            ("state", "probe"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("response_mode", "query"),
            ("login_hint", email),
        ],
    )
    .unwrap();
    println!("client id: {client_id} (paste mode)");
    println!("sign in; the browser then shows a page that cannot load. Copy its address (Cmd-L, Cmd-C): this probe reads it from the clipboard.");
    let clip = || String::from_utf8_lossy(&std::process::Command::new("pbpaste").output().unwrap().stdout).trim().to_owned();
    let stale = clip();
    let _ = std::process::Command::new("open").arg(url.as_str()).status();
    let line = loop {
        let now = clip();
        if now != stale && now.starts_with("https://localhost/?") {
            break now;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    };
    println!("got the address from the clipboard");
    let back = url::Url::parse(&line).expect("a URL");
    let code = back.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.into_owned()).unwrap_or_else(|| {
        println!("SIGN-IN FAILED: {back}");
        std::process::exit(1)
    });
    let data: serde_json::Value = reqwest::Client::new()
        .post("https://login.microsoftonline.com/common/oauth2/v2.0/token")
        .form(&[
            ("client_id", client_id),
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", REDIRECT),
            ("code_verifier", &verifier),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    if let Some(e) = data.get("error") {
        println!("TOKEN FAILED: {e} {}", data["error_description"]);
        std::process::exit(1);
    }
    println!("Granted scopes: {}", data["scope"]);
    data["access_token"].as_str().unwrap().to_owned()
}

async fn imap_check(email: &str, access_token: String) {
    println!("token: {}", describe(&access_token));
    let token = access_token;
    let hosts = std::env::var("PROBE_HOSTS").unwrap_or_else(|_| "outlook.office365.com".into());
    for host in hosts.split(',') {
        let config: ImapConfig = serde_json::from_value(json!({
            "email": email, "imapHost": host, "imapPort": 993, "imapSecure": true,
            "authType": "oauth2", "oauth2AccessToken": token,
        }))
        .unwrap();
        let pool = ImapPool::new();
        match imap::create_imap_session(&config, &pool).await {
            Err(e) => println!("[{host}] IMAP SIGN-IN REFUSED: {e}"),
            Ok(mut session) => match imap::list_mailboxes(&mut session).await {
                Ok(boxes) => println!("[{host}] IMAP OK: {} folders", boxes.len()),
                Err(e) => println!("[{host}] IMAP SIGNED IN, LIST REFUSED: {e}"),
            },
        }
    }
}

/// A JWT's audience and scopes, or the shape of an opaque token.
fn describe(token: &str) -> String {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() == 3 {
        if let Some(claims) = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1].trim_end_matches('='))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        {
            return format!("JWT aud={} scp={} tid={}", claims["aud"], claims["scp"], claims["tid"]);
        }
    }
    format!("opaque, {} chars, starts {:?}", token.len(), token.chars().take(3).collect::<String>())
}
