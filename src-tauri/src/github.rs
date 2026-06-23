//! GitHub OAuth Device Flow + star verification for the share-to-unlock reward.
//!
//! Uses the OAuth 2.0 Device Authorization Grant so the desktop app needs no
//! client secret and no localhost redirect server. The user authorizes once,
//! then we verify they have starred the repo via the REST API. A verified star
//! is the trust-moat action — unlike a social post, it is provable.
//!
//! Setup: register a GitHub OAuth App, enable "Device Flow", and put its
//! Client ID in `GITHUB_CLIENT_ID`. The Client ID is public and safe to embed,
//! exactly like the bundled email OAuth client IDs — the device flow needs no
//! secret. Keep `GITHUB_REPO` in sync with the frontend `shareUnlock.js`.

use serde_json::{json, Value};

/// Public OAuth App client id. Override at runtime with `MV_GITHUB_CLIENT_ID`.
const GITHUB_CLIENT_ID: &str = "REPLACE_WITH_GITHUB_OAUTH_APP_CLIENT_ID";
/// Repository to star, "owner/repo". Override with `MV_GITHUB_REPO`.
const GITHUB_REPO: &str = "your-org/mailvault";
/// GitHub requires a User-Agent header on every API request.
const USER_AGENT: &str = "MailVault-App";

fn client_id() -> String {
    std::env::var("MV_GITHUB_CLIENT_ID").unwrap_or_else(|_| GITHUB_CLIENT_ID.to_string())
}

fn repo() -> String {
    std::env::var("MV_GITHUB_REPO").unwrap_or_else(|_| GITHUB_REPO.to_string())
}

/// Begin the device flow. Returns the user code + verification URL the user
/// must visit, plus the device code used for polling.
#[tauri::command]
pub async fn github_device_start() -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        // Empty scope: a default token can still read the authed user's public
        // stars, which is all we need to verify the star.
        .form(&[("client_id", client_id()), ("scope", String::new())])
        .send()
        .await
        .map_err(|e| format!("device code request failed: {e}"))?;
    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("device code parse failed: {e}"))?;
    if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
        return Err(format!("github device start: {err}"));
    }
    Ok(json!({
        "deviceCode": data.get("device_code").and_then(|v| v.as_str()).unwrap_or_default(),
        "userCode": data.get("user_code").and_then(|v| v.as_str()).unwrap_or_default(),
        "verificationUri": data.get("verification_uri").and_then(|v| v.as_str()).unwrap_or("https://github.com/login/device"),
        "interval": data.get("interval").and_then(|v| v.as_u64()).unwrap_or(5),
        "expiresIn": data.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(900),
    }))
}

/// Poll once for the access token. Frontend repeats this on `interval` seconds.
/// Status is one of: authorized | pending | slow_down | expired | denied | error.
#[tauri::command]
pub async fn github_device_poll(device_code: String) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .form(&[
            ("client_id", client_id()),
            ("device_code", device_code),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
        ])
        .send()
        .await
        .map_err(|e| format!("device poll failed: {e}"))?;
    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("device poll parse failed: {e}"))?;

    if let Some(token) = data.get("access_token").and_then(|v| v.as_str()) {
        return Ok(json!({ "status": "authorized", "accessToken": token }));
    }
    let err = data.get("error").and_then(|v| v.as_str()).unwrap_or("error");
    let status = match err {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        "expired_token" => "expired",
        "access_denied" => "denied",
        _ => "error",
    };
    Ok(json!({
        "status": status,
        "interval": data.get("interval").and_then(|v| v.as_u64()),
    }))
}

/// Verify the authenticated user has starred the configured repo.
/// `GET /user/starred/{owner}/{repo}` → 204 starred, 404 not starred.
#[tauri::command]
pub async fn github_check_star(access_token: String) -> Result<bool, String> {
    let url = format!("https://api.github.com/user/starred/{}", repo());
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("star check failed: {e}"))?;
    Ok(resp.status().as_u16() == 204)
}
