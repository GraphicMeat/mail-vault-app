use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tracing::{info, error};

// ── Microsoft OAuth2 constants ──────────────────────────────────────────────

const AUTH_ENDPOINT: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_ENDPOINT: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const THUNDERBIRD_CLIENT_ID: &str = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
const REDIRECT_URI: &str = "http://localhost:19876/callback";
const CALLBACK_PORT: u16 = 19876;
const SCOPES: &[&str] = &[
    "offline_access",
    "https://outlook.office.com/IMAP.AccessAsUser.All",
    "https://outlook.office.com/SMTP.Send",
];

fn get_client_id() -> String {
    std::env::var("MAILVAULT_MS_CLIENT_ID")
        .ok()
        .filter(|s| !s.is_empty() && s != "undefined")
        .unwrap_or_else(|| THUNDERBIRD_CLIENT_ID.to_string())
}

fn get_client_secret() -> Option<String> {
    std::env::var("MAILVAULT_MS_CLIENT_SECRET")
        .ok()
        .filter(|s| !s.is_empty() && s != "undefined")
}

// ── PKCE helpers ────────────────────────────────────────────────────────────

fn generate_code_verifier() -> String {
    use rand::Rng;
    let bytes: Vec<u8> = (0..32).map(|_| rand::thread_rng().gen::<u8>()).collect();
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
}

// ── OAuth2 Manager ──────────────────────────────────────────────────────────

type SenderMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>>;

struct PendingOAuth {
    code_verifier: String,
    code_rx: Option<oneshot::Receiver<Result<String, String>>>,
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

    pub async fn generate_auth_url(&self, login_hint: Option<String>) -> Result<AuthUrlResponse, String> {
        let client_id = get_client_id();
        let code_verifier = generate_code_verifier();
        let code_challenge = generate_code_challenge(&code_verifier);

        use rand::Rng;
        let state_bytes: Vec<u8> = (0..16).map(|_| rand::thread_rng().gen::<u8>()).collect();
        let state = hex_encode(&state_bytes);

        // Ensure callback server is running
        self.ensure_callback_server().await;

        let (tx, rx) = oneshot::channel();

        self.pending.lock().await.insert(
            state.clone(),
            PendingOAuth {
                code_verifier,
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

        let scopes = SCOPES.join(" ");
        let mut params = vec![
            ("client_id", client_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", REDIRECT_URI),
            ("scope", &scopes),
            ("response_mode", "query"),
            ("state", &state),
            ("code_challenge", &code_challenge),
            ("code_challenge_method", "S256"),
        ];

        let hint_str;
        if let Some(ref hint) = login_hint {
            hint_str = hint.clone();
            params.push(("login_hint", &hint_str));
        }

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, url_encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let auth_url = format!("{}?{}", AUTH_ENDPOINT, query);

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
        drop(pending);

        // Wait for the authorization code from callback server
        let code = rx
            .await
            .map_err(|_| "OAuth callback channel dropped".to_string())?
            .map_err(|e| format!("OAuth callback error: {}", e))?;

        let client_id = get_client_id();
        let client_secret = get_client_secret();

        let mut params = vec![
            ("client_id".to_string(), client_id),
            ("grant_type".to_string(), "authorization_code".to_string()),
            ("code".to_string(), code),
            ("redirect_uri".to_string(), REDIRECT_URI.to_string()),
            ("code_verifier".to_string(), code_verifier),
        ];

        if let Some(secret) = client_secret {
            params.push(("client_secret".to_string(), secret));
        }

        info!("[OAuth2] Exchanging code for tokens...");

        let client = reqwest::Client::new();
        let resp = client
            .post(TOKEN_ENDPOINT)
            .form(&params)
            .send()
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
        })
    }

    pub async fn refresh_token(&self, refresh_token: &str) -> Result<TokenResponse, String> {
        let client_id = get_client_id();
        let client_secret = get_client_secret();
        let scopes = SCOPES.join(" ");

        let mut params = vec![
            ("client_id".to_string(), client_id),
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("refresh_token".to_string(), refresh_token.to_string()),
            ("scope".to_string(), scopes),
        ];

        if let Some(secret) = client_secret {
            params.push(("client_secret".to_string(), secret));
        }

        let client = reqwest::Client::new();
        let resp = client
            .post(TOKEN_ENDPOINT)
            .form(&params)
            .send()
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
        })
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

    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Accept failed: {}", e))?;

        let senders = Arc::clone(&senders);

        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let n = match stream.read(&mut buf).await {
                Ok(n) => n,
                Err(_) => return,
            };

            let request = String::from_utf8_lossy(&buf[..n]);
            let first_line = request.lines().next().unwrap_or("");

            if !first_line.contains("/callback") {
                let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
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
                format!(
                    "<html><body style=\"font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0\">\
                    <div style=\"text-align:center\"><h2>Authentication Failed</h2><p>{}</p><p>You can close this window.</p></div></body></html>",
                    desc
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
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                html.len(),
                html
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}
