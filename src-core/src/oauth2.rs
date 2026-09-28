use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tracing::{info, error};

use crate::net_activity::{Direction, NetEvent, Pending, Protocol};

// ── OAuth2 Provider Configuration ──────────────────────────────────────────

const REDIRECT_URI: &str = "http://localhost:19876/callback";
const CALLBACK_PORT: u16 = 19876;

// Microsoft constants
const MS_AUTH_ENDPOINT: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN_ENDPOINT: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_MAILVAULT_CLIENT_ID: &str = "d4e1c192-2c87-4aeb-b2d6-edbb91c577cd";

// Google constants
const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_THUNDERBIRD_CLIENT_ID: &str = "406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com";
// Google "installed app" OAuth2 requires client_secret even with PKCE (unlike Microsoft).
// This is Thunderbird's public secret — embedded in source, not confidential by design.
pub const GOOGLE_THUNDERBIRD_CLIENT_SECRET: &str = "kSmqreRr0qwBWJgbf5Y-PjSU";

// MailVault's own Google "Desktop app" client, injected at compile time and
// never committed. Release CI sets both; a build without them (tests, local
// dev) signs new Google accounts in with Thunderbird's client instead.
const GOOGLE_OWN_CLIENT_ID: Option<&str> = option_env!("MAILVAULT_GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_OWN_CLIENT_SECRET: Option<&str> = option_env!("MAILVAULT_GOOGLE_OAUTH_CLIENT_SECRET");

/// A Google client id with the secret it was issued with. Always a matched pair.
type GoogleClient = (String, String);

fn thunderbird_google_client() -> GoogleClient {
    (GOOGLE_THUNDERBIRD_CLIENT_ID.to_string(), GOOGLE_THUNDERBIRD_CLIENT_SECRET.to_string())
}

/// MailVault's own pair, present only when BOTH halves are non-empty.
fn own_google_pair<'a>(id: Option<&'a str>, secret: Option<&'a str>) -> Option<(&'a str, &'a str)> {
    let id = id.map(str::trim).filter(|s| !s.is_empty())?;
    let secret = secret.map(str::trim).filter(|s| !s.is_empty())?;
    Some((id, secret))
}

fn compiled_google_pair() -> Option<(&'static str, &'static str)> {
    own_google_pair(GOOGLE_OWN_CLIENT_ID, GOOGLE_OWN_CLIENT_SECRET)
}

/// The client for a NEW Google sign-in (Add Account, Reconnect): MailVault's
/// own when compiled in, else Thunderbird's.
fn google_client_for_new_sign_in(compiled: Option<(&str, &str)>) -> GoogleClient {
    match compiled {
        Some((id, secret)) => (id.to_string(), secret.to_string()),
        None => thunderbird_google_client(),
    }
}

/// The client that issued an existing grant, from the id an account (or a
/// pending flow) recorded. A refresh token or auth code only works with the
/// client that issued it, so this never falls back to another client: an id
/// this build cannot pair with a secret is an error, not a guess that would
/// surface later as a confusing `invalid_grant`.
fn google_client_for_stamp(stamp: Option<&str>, compiled: Option<(&str, &str)>) -> Result<GoogleClient, String> {
    // No stamp: an account from before per-account clients, i.e. Thunderbird.
    let Some(stamp) = stamp.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(thunderbird_google_client());
    };
    if stamp == GOOGLE_THUNDERBIRD_CLIENT_ID {
        return Ok(thunderbird_google_client());
    }
    match compiled {
        Some((id, secret)) if stamp == id => Ok((id.to_string(), secret.to_string())),
        _ => Err(format!(
            "This Google account was connected with a Google client this build does not include ({}). Reconnect the account to fix it.",
            stamp
        )),
    }
}

/// Which Google client a flow runs with.
enum GoogleClientChoice<'a> {
    /// A fresh sign-in.
    NewSignIn,
    /// A grant already issued: the id recorded for it (`None` = legacy).
    Issued(Option<&'a str>),
}


struct ProviderConfig {
    auth_endpoint: String,
    token_endpoint: String,
    client_id: String,
    client_secret: Option<String>,
    scopes: String,
    /// Extra query params for the auth URL (e.g. access_type=offline for Google)
    extra_auth_params: Vec<(&'static str, String)>,
}

/// Test-only token-endpoint override, same shape and safety rule as
/// `mailvault_core::graph`'s `MAILVAULT_GRAPH_BASE` (Task 5.6 precedent): a
/// bearer-token exchange must never go anywhere but the real provider or a
/// loopback address on this machine, so the override is honoured only for a
/// plain-http loopback URL, and only in debug builds — a shipped binary
/// ignores it. Added for Task 5.7's daemon RPC tests, which must hit a fake
/// provider response, never live Microsoft/Google.
#[cfg(debug_assertions)]
fn token_endpoint_override(env_var: &str) -> Option<String> {
    std::env::var(env_var).ok()
}

#[cfg(not(debug_assertions))]
fn token_endpoint_override(_env_var: &str) -> Option<String> {
    None
}

fn resolve_token_endpoint(default: &str, env_var: &str) -> String {
    let raw = token_endpoint_override(env_var);
    let Some(raw) = raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return default.to_string();
    };
    let loopback = reqwest::Url::parse(raw).ok().is_some_and(|url| {
        url.scheme() == "http"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            })
    });
    if loopback {
        raw.to_string()
    } else {
        default.to_string()
    }
}

fn get_provider_config(provider: &str, google: GoogleClientChoice<'_>) -> Result<ProviderConfig, String> {
    get_provider_config_with(provider, google, compiled_google_pair())
}

/// `get_provider_config` with the compiled-in pair passed in, so tests do not
/// depend on the build environment.
fn get_provider_config_with(
    provider: &str,
    google: GoogleClientChoice<'_>,
    compiled: Option<(&str, &str)>,
) -> Result<ProviderConfig, String> {
    match provider {
        "microsoft" => {
            let client_id = std::env::var("MAILVAULT_MS_CLIENT_ID")
                .ok()
                .filter(|s| !s.is_empty() && s != "undefined")
                .unwrap_or_else(|| MS_MAILVAULT_CLIENT_ID.to_string());
            // Microsoft OAuth2 uses PKCE public client flow — never send client_secret.
            // Azure AD returns AADSTS7000215 if a secret is sent to a public client app.
            let client_secret: Option<String> = None;

            Ok(ProviderConfig {
                auth_endpoint: MS_AUTH_ENDPOINT.to_string(),
                token_endpoint: resolve_token_endpoint(MS_TOKEN_ENDPOINT, "MAILVAULT_MS_TOKEN_ENDPOINT"),
                client_id,
                client_secret,
                scopes: [
                    "offline_access",
                    "https://outlook.office.com/IMAP.AccessAsUser.All",
                    "https://outlook.office.com/SMTP.Send",
                ].join(" "),
                extra_auth_params: vec![
                    ("response_mode", "query".to_string()),
                ],
            })
        }
        "google" => {
            let (client_id, client_secret) = match google {
                GoogleClientChoice::NewSignIn => google_client_for_new_sign_in(compiled),
                GoogleClientChoice::Issued(stamp) => google_client_for_stamp(stamp, compiled)?,
            };

            Ok(ProviderConfig {
                auth_endpoint: GOOGLE_AUTH_ENDPOINT.to_string(),
                token_endpoint: resolve_token_endpoint(GOOGLE_TOKEN_ENDPOINT, "MAILVAULT_GOOGLE_TOKEN_ENDPOINT"),
                client_id,
                client_secret: Some(client_secret),
                scopes: "https://mail.google.com/".to_string(),
                extra_auth_params: vec![
                    ("access_type", "offline".to_string()),
                    ("prompt", "consent".to_string()),
                ],
            })
        }
        _ => Err(format!("Unknown OAuth2 provider: {}", provider)),
    }
}

// ── PKCE helpers ────────────────────────────────────────────────────────────

fn generate_code_verifier() -> String {
    use rand::Rng;
    let bytes: Vec<u8> = (0..32).map(|_| rand::rng().random::<u8>()).collect();
    base64_url_encode(&bytes)
}

fn generate_code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    base64_url_encode(&hash)
}

fn base64_url_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn url_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Minimal HTML-body escape for text pulled out of the callback query string.
/// Not a general-purpose sanitizer — used only on the small OAuth error page,
/// where the text is placed in element content (never in an attribute or URL).
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

// ── Response types ──────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AuthUrlResponse {
    pub success: bool,
    #[serde(rename = "authUrl")]
    pub auth_url: String,
    pub state: String,
}

#[derive(Serialize)]
pub struct TokenResponse {
    pub success: bool,
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
    /// The `email` (or `preferred_username`) claim of the id_token, when the
    /// provider returned one (Google, once `openid email` is requested).
    /// `None` for a flow that never asked for an id_token (Microsoft today).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The OAuth client the tokens were issued to (or, on a refresh, sent
    /// with). The caller records it on the account: a refresh token only
    /// works with the client that issued it.
    #[serde(rename = "clientId")]
    pub client_id: String,
}

/// Decode the `email` (falling back to `preferred_username`) claim out of an
/// id_token's payload segment, with no signature check — the token came
/// straight from the provider's token endpoint over TLS in `exchange_code`,
/// never from an untrusted party, so verifying it again buys nothing here.
/// This is a UX typo guard, not an auth boundary: IMAP still authenticates
/// with the access token regardless of what this returns.
pub fn id_token_email(id_token: &str) -> Option<String> {
    let payload_b64 = id_token.split('.').nth(1)?;
    let payload_bytes = {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload_b64.trim_end_matches('='))
            .ok()?
    };
    let claims: serde_json::Value = serde_json::from_slice(&payload_bytes).ok()?;
    claims["email"]
        .as_str()
        .or_else(|| claims["preferred_username"].as_str())
        .map(str::to_string)
}

// ── OAuth2 Manager ──────────────────────────────────────────────────────────

type SenderMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>>;

struct PendingOAuth {
    code_verifier: String,
    provider: String,
    /// The client id the auth URL was built with. The auth code is bound to
    /// it, so the exchange uses this client (and its matched secret), never
    /// whatever the default has become since.
    client_id: String,
    custom_client_id: Option<String>,
    tenant_id: Option<String>,
    code_rx: Option<oneshot::Receiver<Result<String, String>>>,
}

/// Apply per-account overrides (custom client ID and tenant ID) to a provider config.
fn apply_overrides(config: &mut ProviderConfig, custom_client_id: Option<&str>, tenant_id: Option<&str>) {
    if let Some(cid) = custom_client_id {
        if !cid.is_empty() {
            config.client_id = cid.to_string();
        }
    }
    if let Some(tid) = tenant_id {
        if !tid.is_empty() {
            config.auth_endpoint = config.auth_endpoint.replace("/common/", &format!("/{}/", tid));
            config.token_endpoint = config.token_endpoint.replace("/common/", &format!("/{}/", tid));
        }
    }
}

/// The config a flow runs with once a grant exists: the client that issued it
/// (`issued_client_id`; `None` = legacy Google), then per-account overrides.
/// Used by the code exchange (the id stored with the pending flow) and the
/// refresh (the id stamped on the account).
fn issued_flow_config(
    provider: &str,
    issued_client_id: Option<&str>,
    custom_client_id: Option<&str>,
    tenant_id: Option<&str>,
    compiled: Option<(&str, &str)>,
) -> Result<ProviderConfig, String> {
    // A custom client id replaces the id outright (Microsoft only in the UI),
    // so there is no issued Google client to match.
    let google = if custom_client_id.is_some_and(|c| !c.is_empty()) {
        GoogleClientChoice::NewSignIn
    } else {
        GoogleClientChoice::Issued(issued_client_id)
    };
    let mut config = get_provider_config_with(provider, google, compiled)?;
    apply_overrides(&mut config, custom_client_id, tenant_id);
    Ok(config)
}

pub struct OAuth2Manager {
    pending: Arc<Mutex<HashMap<String, PendingOAuth>>>,
    callback_running: Arc<Mutex<bool>>,
    senders: SenderMap,
}

impl OAuth2Manager {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            callback_running: Arc::new(Mutex::new(false)),
            senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn generate_auth_url(
        &self,
        login_hint: Option<String>,
        provider: Option<String>,
        custom_client_id: Option<String>,
        tenant_id: Option<String>,
        use_graph: bool,
    ) -> Result<AuthUrlResponse, String> {
        let provider_name = provider.as_deref().unwrap_or("microsoft");
        // Chosen once here; the exchange reuses the id stored below.
        let mut config = get_provider_config(provider_name, GoogleClientChoice::NewSignIn)?;
        apply_overrides(&mut config, custom_client_id.as_deref(), tenant_id.as_deref());

        // For personal Microsoft accounts, request Graph API scopes instead of IMAP scopes
        if use_graph && provider_name == "microsoft" {
            config.scopes = "offline_access Mail.ReadWrite Mail.Send".to_string();
        }

        // Google only: ask for the `email` claim on the id_token so the
        // caller can catch a typo'd address (Track B, Q3). Added only to the
        // auth-URL scope, never to `get_provider_config`'s shared `scopes` —
        // `refresh_token` reuses that value, and every Google account
        // authorized before this change was granted without openid/email;
        // widening the refresh request risks `invalid_scope` for all of them.
        if provider_name == "google" {
            config.scopes = format!("{} openid email", config.scopes);
        }

        let code_verifier = generate_code_verifier();
        let code_challenge = generate_code_challenge(&code_verifier);

        use rand::Rng;
        let state_bytes: Vec<u8> = (0..16).map(|_| rand::rng().random::<u8>()).collect();
        let state = hex_encode(&state_bytes);

        // Ensure callback server is running
        self.ensure_callback_server().await;

        let (tx, rx) = oneshot::channel();

        self.pending.lock().await.insert(
            state.clone(),
            PendingOAuth {
                code_verifier,
                provider: provider_name.to_string(),
                client_id: config.client_id.clone(),
                custom_client_id,
                tenant_id,
                code_rx: Some(rx),
            },
        );

        // Store sender where callback server can find it
        self.senders.lock().await.insert(state.clone(), tx);

        // Timeout cleanup
        let pending = Arc::clone(&self.pending);
        let senders = Arc::clone(&self.senders);
        let state_clone = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            pending.lock().await.remove(&state_clone);
            if let Some(tx) = senders.lock().await.remove(&state_clone) {
                let _ = tx.send(Err("OAuth flow timed out".to_string()));
            }
        });

        let mut params = vec![
            ("client_id", config.client_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", REDIRECT_URI),
            ("scope", &config.scopes),
            ("state", &state),
            ("code_challenge", &code_challenge),
            ("code_challenge_method", "S256"),
        ];

        let hint_str;
        if let Some(ref hint) = login_hint {
            hint_str = hint.clone();
            params.push(("login_hint", &hint_str));
        }

        // Add provider-specific params (e.g. access_type=offline for Google)
        let extra_refs: Vec<(&str, &str)> = config.extra_auth_params
            .iter()
            .map(|(k, v)| (*k, v.as_str()))
            .collect();
        for (k, v) in &extra_refs {
            params.push((k, v));
        }

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, url_encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let auth_url = format!("{}?{}", config.auth_endpoint, query);

        Ok(AuthUrlResponse {
            success: true,
            auth_url,
            state,
        })
    }

    pub async fn exchange_code(&self, state: &str) -> Result<TokenResponse, String> {
        let mut pending = self.pending.lock().await;
        let flow = pending
            .get_mut(state)
            .ok_or_else(|| "No pending OAuth flow for this state".to_string())?;

        let rx = flow
            .code_rx
            .take()
            .ok_or_else(|| "OAuth code already consumed".to_string())?;

        let code_verifier = flow.code_verifier.clone();
        let provider_name = flow.provider.clone();
        let client_id = flow.client_id.clone();
        let custom_client_id = flow.custom_client_id.clone();
        let tenant_id = flow.tenant_id.clone();
        drop(pending);

        // Wait for the authorization code from callback server
        let code = rx
            .await
            .map_err(|_| "OAuth callback channel dropped".to_string())?
            .map_err(|e| format!("OAuth callback error: {}", e))?;

        let config = issued_flow_config(
            &provider_name,
            Some(&client_id),
            custom_client_id.as_deref(),
            tenant_id.as_deref(),
            compiled_google_pair(),
        )?;
        let used_client_id = config.client_id.clone();

        let mut params = vec![
            ("client_id".to_string(), config.client_id),
            ("grant_type".to_string(), "authorization_code".to_string()),
            ("code".to_string(), code),
            ("redirect_uri".to_string(), REDIRECT_URI.to_string()),
            ("code_verifier".to_string(), code_verifier),
        ];

        if let Some(secret) = config.client_secret {
            params.push(("client_secret".to_string(), secret));
        }

        info!("[OAuth2] Exchanging code for tokens ({})...", provider_name);

        // Bounded so a slow token endpoint fails the account setup or
        // refresh instead of hanging it (Track B: Google add-account timeout).
        let client = crate::net_activity::http_client("sign-in", Some(Duration::from_secs(30)));
        let resp = client
            .send(client.post(config.token_endpoint).form(&params))
            .await
            .map_err(|e| format!("Token request failed: {}", e))?;

        let data: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Token response parse failed: {}", e))?;

        if let Some(err) = data.get("error") {
            let desc = data
                .get("error_description")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            return Err(format!("Token error: {} — {}", err, desc));
        }

        let access_token = data["access_token"]
            .as_str()
            .ok_or("No access_token in response")?
            .to_string();
        let refresh_token = data["refresh_token"].as_str().map(|s| s.to_string());
        let email = data["id_token"].as_str().and_then(id_token_email);
        let expires_in = data["expires_in"].as_u64().unwrap_or(3600);
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + (expires_in * 1000);

        self.pending.lock().await.remove(state);

        Ok(TokenResponse {
            success: true,
            access_token,
            refresh_token,
            expires_at,
            email,
            client_id: used_client_id,
        })
    }

    pub async fn refresh_token(
        &self,
        refresh_token: &str,
        provider: Option<String>,
        custom_client_id: Option<String>,
        tenant_id: Option<String>,
        use_graph: bool,
        client_id: Option<String>,
    ) -> Result<TokenResponse, String> {
        let provider_name = provider.as_deref().unwrap_or("microsoft");
        // `client_id` is the Google client recorded on the account when its
        // refresh token was issued; Microsoft has one client and ignores it.
        let mut config = issued_flow_config(
            provider_name,
            client_id.as_deref(),
            custom_client_id.as_deref(),
            tenant_id.as_deref(),
            compiled_google_pair(),
        )?;
        let used_client_id = config.client_id.clone();

        // Graph accounts were authorized with Graph scopes — must refresh with the same scopes
        if use_graph && provider_name == "microsoft" {
            config.scopes = "offline_access Mail.ReadWrite Mail.Send".to_string();
        }

        let mut params = vec![
            ("client_id".to_string(), config.client_id),
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("refresh_token".to_string(), refresh_token.to_string()),
            ("scope".to_string(), config.scopes),
        ];

        if let Some(secret) = config.client_secret {
            params.push(("client_secret".to_string(), secret));
        }

        // Bounded so a slow token endpoint fails the account setup or
        // refresh instead of hanging it (Track B: Google add-account timeout).
        let client = crate::net_activity::http_client("sign-in", Some(Duration::from_secs(30)));
        let resp = client
            .send(client.post(config.token_endpoint).form(&params))
            .await
            .map_err(|e| format!("Refresh request failed: {}", e))?;

        let data: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Refresh response parse failed: {}", e))?;

        if let Some(err) = data.get("error") {
            let desc = data
                .get("error_description")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            return Err(format!("Token refresh failed: {} — {}", err, desc));
        }

        let access_token = data["access_token"]
            .as_str()
            .ok_or("No access_token in refresh response")?
            .to_string();
        let new_refresh = data["refresh_token"]
            .as_str()
            .map(|s| s.to_string())
            .or_else(|| Some(refresh_token.to_string()));
        let expires_in = data["expires_in"].as_u64().unwrap_or(3600);
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + (expires_in * 1000);

        Ok(TokenResponse {
            success: true,
            access_token,
            refresh_token: new_refresh,
            expires_at,
            email: None,
            client_id: used_client_id,
        })
    }

    /// Hand `code` to the flow waiting on `state`, as the callback server does
    /// when the browser returns. Lets a daemon test drive `exchange_code`
    /// without a browser or the loopback port.
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub async fn deliver_code_for_tests(&self, state: &str, code: &str) -> bool {
        match self.senders.lock().await.remove(state) {
            Some(tx) => tx.send(Ok(code.to_string())).is_ok(),
            None => false,
        }
    }

    async fn ensure_callback_server(&self) {
        let mut running = self.callback_running.lock().await;
        if *running {
            return;
        }
        *running = true;

        let senders = Arc::clone(&self.senders);
        let running_flag = Arc::clone(&self.callback_running);

        tokio::spawn(async move {
            if let Err(e) = run_callback_server(senders).await {
                error!("OAuth callback server error: {}", e);
                // Reset flag so next OAuth attempt can retry
                *running_flag.lock().await = false;
            }
        });

        info!("OAuth callback server started on port {}", CALLBACK_PORT);
    }
}

impl Default for OAuth2Manager {
    fn default() -> Self {
        Self::new()
    }
}

// ── Callback HTTP server ────────────────────────────────────────────────────

async fn run_callback_server(senders: SenderMap) -> Result<(), String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", CALLBACK_PORT))
        .await
        .map_err(|e| format!("Failed to bind callback server: {}", e))?;
    serve_callbacks(listener, senders).await
}

/// The accept loop, split from the bind so a test can serve on a free port.
async fn serve_callbacks(listener: TcpListener, senders: SenderMap) -> Result<(), String> {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(CALLBACK_PORT);
    loop {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|e| format!("Accept failed: {}", e))?;

        let senders = Arc::clone(&senders);

        tokio::spawn(async move {
            // The one inbound connection on Network Activity: the browser
            // coming back with the sign-in code. Host is the peer; the path
            // and query (code, state) are never copied into the event.
            let peer_ip = peer.ip().to_string();
            let mut ev = NetEvent::out(Protocol::Http, &peer_ip, port, "sign-in");
            ev.direction = Direction::In;
            ev.ip = Some(peer_ip);
            let mut hit = Pending::new(ev);
            handle_callback(&mut stream, &senders, &mut hit.ev).await;
        });
    }
}

/// Answer one loopback request, noting its bytes and result in `ev`.
async fn handle_callback(stream: &mut tokio::net::TcpStream, senders: &SenderMap, ev: &mut NetEvent) {
    let mut buf = vec![0u8; 4096];
    let n = match stream.read(&mut buf).await {
        Ok(n) => n,
        Err(e) => {
            ev.result = e.to_string();
            return;
        }
    };
    ev.bytes_down = n as u64;

    let request = String::from_utf8_lossy(&buf[..n]);
    let first_line = request.lines().next().unwrap_or("");

    if !first_line.contains("/callback") {
        let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
        ev.bytes_up = resp.len() as u64;
        ev.result = "HTTP 404".into();
        let _ = stream.write_all(resp.as_bytes()).await;
        return;
    }

    let path = first_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/callback");

    let query_str = path.split('?').nth(1).unwrap_or("");
    let params: HashMap<String, String> = url::form_urlencoded::parse(query_str.as_bytes())
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

    let state = params.get("state").cloned().unwrap_or_default();
    let code = params.get("code").cloned();
    let error_param = params.get("error").cloned();
    let error_desc = params.get("error_description").cloned();

    let html = if let Some(err) = error_param {
        let desc = error_desc.as_deref().unwrap_or(&err);
        if let Some(tx) = senders.lock().await.remove(&state) {
            let _ = tx.send(Err(desc.to_string()));
        }
        // `desc` is attacker-controllable (any process/tab that can
        // reach `127.0.0.1:19876/callback` supplies the query string).
        // Escape before it enters the HTML body.
        format!(
            "<html><body style=\"font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0\">\
            <div style=\"text-align:center\"><h2>Authentication Failed</h2><p>{}</p><p>You can close this window.</p></div></body></html>",
            html_escape(desc)
        )
    } else if let Some(code) = code {
        if let Some(tx) = senders.lock().await.remove(&state) {
            let _ = tx.send(Ok(code));
        }
        "<html><body style=\"font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0\">\
        <div style=\"text-align:center\"><h2>Sign-in Successful</h2><p>You can close this window and return to MailVault.</p></div></body></html>".to_string()
    } else {
        "<html><body>Invalid request</body></html>".to_string()
    };

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}",
        html.len(),
        html
    );
    ev.bytes_up = response.len() as u64;
    ev.result = match stream.write_all(response.as_bytes()).await {
        Ok(()) => "ok".into(),
        Err(e) => e.to_string(),
    };
}

#[cfg(test)]
mod tests {
    use super::{
        get_provider_config_with, google_client_for_new_sign_in, google_client_for_stamp, html_escape,
        id_token_email, issued_flow_config, own_google_pair, GoogleClientChoice, GOOGLE_THUNDERBIRD_CLIENT_ID,
        GOOGLE_THUNDERBIRD_CLIENT_SECRET,
    };

    const OWN_ID: &str = "own-client.apps.googleusercontent.com";
    const OWN_SECRET: &str = "own-secret";
    const OWN: Option<(&str, &str)> = Some((OWN_ID, OWN_SECRET));

    fn thunderbird() -> (String, String) {
        (GOOGLE_THUNDERBIRD_CLIENT_ID.to_string(), GOOGLE_THUNDERBIRD_CLIENT_SECRET.to_string())
    }

    fn own() -> (String, String) {
        (OWN_ID.to_string(), OWN_SECRET.to_string())
    }

    // ── Google client resolution ───────────────────────────────────────────

    #[test]
    fn the_compiled_pair_counts_only_when_both_halves_are_non_empty() {
        assert_eq!(own_google_pair(Some("id"), Some("secret")), Some(("id", "secret")));
        assert_eq!(own_google_pair(None, None), None);
        assert_eq!(own_google_pair(Some("id"), None), None);
        assert_eq!(own_google_pair(None, Some("secret")), None);
        assert_eq!(own_google_pair(Some(""), Some("secret")), None);
        assert_eq!(own_google_pair(Some("id"), Some("")), None);
        assert_eq!(own_google_pair(Some("  "), Some("secret")), None);
    }

    #[test]
    fn a_new_sign_in_uses_our_client_when_compiled_in_else_thunderbirds() {
        assert_eq!(google_client_for_new_sign_in(OWN), own());
        assert_eq!(google_client_for_new_sign_in(None), thunderbird());
    }

    #[test]
    fn no_stamp_or_an_empty_one_means_thunderbird_with_or_without_our_client() {
        for compiled in [None, OWN] {
            assert_eq!(google_client_for_stamp(None, compiled), Ok(thunderbird()));
            assert_eq!(google_client_for_stamp(Some(""), compiled), Ok(thunderbird()));
        }
    }

    #[test]
    fn a_thunderbird_stamp_gets_thunderbirds_pair_even_when_ours_is_compiled_in() {
        for compiled in [None, OWN] {
            assert_eq!(google_client_for_stamp(Some(GOOGLE_THUNDERBIRD_CLIENT_ID), compiled), Ok(thunderbird()));
        }
    }

    #[test]
    fn our_stamp_gets_our_matched_pair_when_compiled_in() {
        assert_eq!(google_client_for_stamp(Some(OWN_ID), OWN), Ok(own()));
    }

    #[test]
    fn our_stamp_without_the_compiled_pair_is_an_error_not_a_fallback() {
        let err = google_client_for_stamp(Some(OWN_ID), None).unwrap_err();
        assert!(err.contains(OWN_ID), "{err}");
        assert!(err.contains("Reconnect"), "{err}");
    }

    #[test]
    fn an_unknown_stamp_is_an_error_whether_or_not_ours_is_compiled_in() {
        for compiled in [None, OWN] {
            let err = google_client_for_stamp(Some("someone-elses.apps.googleusercontent.com"), compiled).unwrap_err();
            assert!(err.contains("someone-elses"), "{err}");
        }
    }

    #[test]
    fn a_google_config_always_carries_a_matched_id_and_secret() {
        let new = get_provider_config_with("google", GoogleClientChoice::NewSignIn, OWN).unwrap();
        assert_eq!((new.client_id, new.client_secret), (OWN_ID.to_string(), Some(OWN_SECRET.to_string())));

        let legacy = get_provider_config_with("google", GoogleClientChoice::Issued(None), OWN).unwrap();
        assert_eq!(
            (legacy.client_id, legacy.client_secret),
            (GOOGLE_THUNDERBIRD_CLIENT_ID.to_string(), Some(GOOGLE_THUNDERBIRD_CLIENT_SECRET.to_string()))
        );

        assert!(get_provider_config_with("google", GoogleClientChoice::Issued(Some("nope")), OWN).is_err());
    }

    #[test]
    fn microsoft_ignores_the_google_client_and_never_sends_a_secret() {
        let plain = get_provider_config_with("microsoft", GoogleClientChoice::NewSignIn, OWN).unwrap();
        let stamped = get_provider_config_with("microsoft", GoogleClientChoice::Issued(Some("nope")), None).unwrap();
        assert_eq!(plain.client_id, stamped.client_id);
        assert!(plain.client_secret.is_none() && stamped.client_secret.is_none());
    }

    /// An auth code is bound to the client that requested it: the exchange
    /// resolves the client from the id stored with the pending flow, so a
    /// Thunderbird-issued flow stays Thunderbird's after our client is
    /// compiled in, and ours stays ours.
    #[test]
    fn the_exchange_uses_the_client_the_auth_url_was_built_with() {
        let tb = issued_flow_config("google", Some(GOOGLE_THUNDERBIRD_CLIENT_ID), None, None, OWN).unwrap();
        assert_eq!((tb.client_id, tb.client_secret), (GOOGLE_THUNDERBIRD_CLIENT_ID.to_string(), Some(GOOGLE_THUNDERBIRD_CLIENT_SECRET.to_string())));

        let ours = issued_flow_config("google", Some(OWN_ID), None, None, OWN).unwrap();
        assert_eq!((ours.client_id, ours.client_secret), (OWN_ID.to_string(), Some(OWN_SECRET.to_string())));

        assert!(issued_flow_config("google", Some(OWN_ID), None, None, None).is_err());
    }

    #[test]
    fn a_microsoft_refresh_is_unchanged_by_a_stamp_and_keeps_its_overrides() {
        let config = issued_flow_config("microsoft", Some("whatever"), Some("custom-ms-id"), Some("tenant-1"), OWN).unwrap();
        assert_eq!(config.client_id, "custom-ms-id");
        assert!(config.auth_endpoint.contains("/tenant-1/"));
        assert!(config.client_secret.is_none());
    }

    // ── Full flow against a loopback token endpoint ────────────────────────

    /// A loopback token endpoint that records every request body and answers
    /// each with `reply`. Debug builds only honour the endpoint override.
    #[cfg(debug_assertions)]
    async fn mock_token_endpoint(reply: &'static str) -> std::sync::Arc<std::sync::Mutex<Vec<String>>> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        std::env::set_var("MAILVAULT_GOOGLE_TOKEN_ENDPOINT", format!("http://127.0.0.1:{port}"));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = std::sync::Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                // Headers and body can arrive in separate writes: read until
                // the declared Content-Length of body has landed.
                let body = loop {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break String::new();
                    }
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let want = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if body.len() >= want {
                            break body.to_string();
                        }
                    }
                };
                log.lock().unwrap().push(body);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });
        seen
    }

    #[cfg(debug_assertions)]
    fn form_field(body: &str, key: &str) -> Option<String> {
        url::form_urlencoded::parse(body.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.to_string())
    }

    /// One test, sequential steps: the token-endpoint override is a
    /// process-wide env var.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn google_flows_post_a_matched_pair_and_report_the_client_they_used() {
        let seen = mock_token_endpoint(r#"{"access_token":"at","refresh_token":"rt","expires_in":3600}"#).await;
        let manager = super::OAuth2Manager::new();

        // New sign-in: the id in the auth URL is the id stored with the flow.
        let auth = manager.generate_auth_url(None, Some("google".into()), None, None, false).await.unwrap();
        let url_client = form_field(auth.auth_url.split('?').nth(1).unwrap(), "client_id").unwrap();
        assert_eq!(manager.pending.lock().await.get(&auth.state).unwrap().client_id, url_client);

        assert!(manager.deliver_code_for_tests(&auth.state, "the-code").await);
        let exchanged = manager.exchange_code(&auth.state).await.unwrap();
        let exchange_body = seen.lock().unwrap().pop().unwrap();
        assert_eq!(form_field(&exchange_body, "grant_type").as_deref(), Some("authorization_code"));
        assert_eq!(form_field(&exchange_body, "client_id").as_deref(), Some(url_client.as_str()));
        assert_eq!(exchanged.client_id, url_client);
        // Whichever client this build picked, a secret went with it.
        let secret = form_field(&exchange_body, "client_secret").expect("a Google exchange carries a secret");
        if url_client == GOOGLE_THUNDERBIRD_CLIENT_ID {
            assert_eq!(secret, GOOGLE_THUNDERBIRD_CLIENT_SECRET);
        }

        // Refresh with the recorded client and with none (a legacy account).
        let stamped = manager
            .refresh_token("rt", Some("google".into()), None, None, false, Some(GOOGLE_THUNDERBIRD_CLIENT_ID.into()))
            .await
            .unwrap();
        let body = seen.lock().unwrap().pop().unwrap();
        assert_eq!(form_field(&body, "client_id").as_deref(), Some(GOOGLE_THUNDERBIRD_CLIENT_ID));
        assert_eq!(form_field(&body, "client_secret").as_deref(), Some(GOOGLE_THUNDERBIRD_CLIENT_SECRET));
        assert_eq!(stamped.client_id, GOOGLE_THUNDERBIRD_CLIENT_ID);

        let legacy = manager.refresh_token("rt", Some("google".into()), None, None, false, None).await.unwrap();
        let body = seen.lock().unwrap().pop().unwrap();
        assert_eq!(form_field(&body, "client_id").as_deref(), Some(GOOGLE_THUNDERBIRD_CLIENT_ID));
        assert_eq!(legacy.client_id, GOOGLE_THUNDERBIRD_CLIENT_ID);

        // An id this build cannot pair fails before anything is posted.
        let before = seen.lock().unwrap().len();
        let err = manager
            .refresh_token("rt", Some("google".into()), None, None, false, Some("unknown.apps.googleusercontent.com".into()))
            .await
            .err()
            .expect("an unpairable client id must fail");
        assert!(err.contains("unknown.apps.googleusercontent.com"), "{err}");
        assert_eq!(seen.lock().unwrap().len(), before);
    }

    /// Network Activity: a hit on the sign-in loopback is an inbound event,
    /// and the code and state in its query never reach it.
    #[tokio::test]
    async fn a_hit_on_the_sign_in_loopback_is_recorded_inbound() {
        use crate::net_activity::{snapshot, Direction, Protocol};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(super::serve_callbacks(listener, Default::default()));

        let mut browser = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        browser
            .write_all(b"GET /callback?state=st4te-x&code=s3cret-code HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut reply = Vec::new();
        browser.read_to_end(&mut reply).await.unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 200"), "{}", String::from_utf8_lossy(&reply));

        // Recorded as the handler's task ends, which may trail the reply.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let e = loop {
            if let Some(e) = snapshot().into_iter().find(|e| e.port == port && e.direction == Direction::In) {
                break e;
            }
            assert!(std::time::Instant::now() < deadline, "no inbound event on port {port}");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };
        assert_eq!(e.protocol, Protocol::Http);
        assert_eq!(e.purpose, "sign-in");
        assert_eq!(e.host, "127.0.0.1");
        assert_eq!(e.result, "ok");
        assert!(e.bytes_down > 0);
        assert_eq!(e.bytes_up, reply.len() as u64);
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("s3cret-code") && !json.contains("st4te-x"), "{json}");
    }

    /// Build a fake (unsigned) id_token: two base64url segments joined by
    /// dots, matching what `id_token_email` reads — it never checks the
    /// signature, so a dummy header and no third segment are enough.
    fn fake_id_token(claims_json: &str) -> String {
        use base64::Engine;
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!("{}.{}.sig", enc.encode(b"{}"), enc.encode(claims_json.as_bytes()))
    }

    #[test]
    fn id_token_email_reads_the_email_claim() {
        let token = fake_id_token(r#"{"email":"user@gmail.com","sub":"123"}"#);
        assert_eq!(id_token_email(&token).as_deref(), Some("user@gmail.com"));
    }

    #[test]
    fn id_token_email_falls_back_to_preferred_username() {
        let token = fake_id_token(r#"{"preferred_username":"user@outlook.com"}"#);
        assert_eq!(id_token_email(&token).as_deref(), Some("user@outlook.com"));
    }

    #[test]
    fn id_token_email_is_none_when_neither_claim_is_present() {
        let token = fake_id_token(r#"{"sub":"123"}"#);
        assert_eq!(id_token_email(&token), None);
    }

    #[test]
    fn id_token_email_is_none_for_garbage_input() {
        assert_eq!(id_token_email("not-a-jwt"), None);
        assert_eq!(id_token_email(""), None);
        assert_eq!(id_token_email("only.one.dot.too.many"), None);
    }

    #[test]
    fn html_escape_neutralizes_script_injection() {
        let esc = html_escape("<script>alert(1)</script>");
        assert!(!esc.contains('<'));
        assert!(!esc.contains('>'));
        assert_eq!(esc, "&lt;script&gt;alert(1)&lt;/script&gt;");
    }

    #[test]
    fn html_escape_handles_ampersand_and_quotes() {
        assert_eq!(
            html_escape(r#"A&B "c" 'd'"#),
            "A&amp;B &quot;c&quot; &#39;d&#39;"
        );
    }

    #[test]
    fn html_escape_leaves_plain_text_intact() {
        assert_eq!(html_escape("access denied — try again"), "access denied — try again");
    }
}
