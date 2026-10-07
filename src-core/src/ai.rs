//! Pure, testable pieces of the AI provider layer (Phase 3b). The provider
//! enum and the actual network/subprocess calls live in
//! `src-daemon/src/llm.rs` — this module only shapes JSON, so it's covered by
//! `cargo test -p mailvault-core`, which CI actually runs.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── OpenAI-compatible /chat/completions ─────────────────────────────────────

/// Build a `/chat/completions` request body. Works against both a real
/// OpenAI-shaped endpoint and Ollama's compatible one (which ignores fields
/// it doesn't use rather than rejecting the request).
pub fn chat_request_body(model: &str, prompt: &str, system: Option<&str>, max_tokens: usize) -> Value {
    let mut messages = Vec::new();
    if let Some(s) = system {
        if !s.is_empty() {
            messages.push(json!({"role": "system", "content": s}));
        }
    }
    messages.push(json!({"role": "user", "content": prompt}));
    json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
    })
}

/// Pull the assistant's text out of a `/chat/completions` response.
pub fn parse_chat_response(body: &Value) -> Result<String, String> {
    body.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("unexpected chat completion response shape: {body}"))
}

// ── Where Gmail mail may be processed ───────────────────────────────────────
//
// Google's rule for the Gmail API: Google user data never reaches a third-party
// AI service. Mail from a Google account is therefore only ever handed to an
// on-device model: Apple's, the downloaded GGUF, or an OpenAI-compatible server
// that is on THIS computer (Ollama on loopback). Everything else is cloud.

/// Stable error code the daemon answers when Gmail mail would reach a cloud
/// provider. The app maps it to the `ai.googleMailOnDeviceOnly` catalog key.
pub const GOOGLE_MAIL_ON_DEVICE_ONLY: &str = "E_GOOGLE_MAIL_ON_DEVICE_ONLY";

/// Stable error code the daemon answers when a job wants an on-device model
/// and none is available (no Apple Intelligence, no downloaded GGUF). The app
/// maps it to the `ai.noOnDeviceModel` catalog key.
pub const NO_ON_DEVICE_MODEL: &str = "E_NO_ON_DEVICE_MODEL";

/// Whether an OpenAI-compatible endpoint URL points at this computer: the host
/// is `localhost`, an address in `127.0.0.0/8`, or `::1`. Parsed, not
/// pattern-matched, so `http://localhost.evil.com` and
/// `http://localhost@evil.com` are both cloud. Anything that does not parse as
/// an http(s) URL with a host is cloud too: when in doubt, it is not local.
pub fn endpoint_is_on_device(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url.trim()) else { return false };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    match parsed.host() {
        Some(url::Host::Domain(d)) => d.trim_end_matches('.').eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
        None => false,
    }
}

/// Whether a provider may be handed mail from a Google account. `kind` is the
/// provider's `type` tag (`appleFm`, `localGguf`, `endpoint`); `endpoint_url`
/// only matters for `endpoint`. An unknown kind is not allowed.
pub fn provider_allowed_for_google_mail(kind: &str, endpoint_url: Option<&str>) -> bool {
    match kind {
        "appleFm" | "localGguf" => true,
        "endpoint" => endpoint_url.is_some_and(endpoint_is_on_device),
        _ => false,
    }
}

/// Whether an account record (an `accounts.json` entry or the keychain blob's
/// copy of it) is a Google account: Google OAuth, or an IMAP account on one of
/// Gmail's hosts (an app-password Gmail account is Google data too). Field
/// reads are trimmed and case-insensitive.
pub fn is_google_account(account: &Value) -> bool {
    let text = |key: &str| account.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_ascii_lowercase();
    let host = text("imapHost");
    let host = host.trim_end_matches('.');
    (text("authType") == "oauth2" && text("oauth2Provider") == "google") || host == "imap.gmail.com" || host == "imap.googlemail.com"
}

// ── Apple FM helper protocol (one JSON object per line, each way) ──────────

#[derive(Debug, Clone, Serialize)]
pub struct FmRequest {
    pub id: String,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "maxTokens")]
    pub max_tokens: Option<usize>,
}

impl FmRequest {
    pub fn availability(id: &str) -> Self {
        Self { id: id.to_string(), op: "availability".to_string(), prompt: None, system: None, max_tokens: None }
    }

    pub fn generate(id: &str, prompt: &str, system: Option<&str>, max_tokens: usize) -> Self {
        Self {
            id: id.to_string(),
            op: "generate".to_string(),
            prompt: Some(prompt.to_string()),
            system: system.map(str::to_string),
            max_tokens: Some(max_tokens),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct FmResponse {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub available: Option<bool>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn encode_fm_request(req: &FmRequest) -> String {
    serde_json::to_string(req).expect("FmRequest always serializes")
}

pub fn decode_fm_response(line: &str) -> Result<FmResponse, String> {
    serde_json::from_str(line.trim()).map_err(|e| format!("bad fm helper response: {e} ({line:?})"))
}

// ── Provider availability reasoning ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    pub available: bool,
    pub reason: String,
}

pub fn local_gguf_status(any_model_downloaded: bool) -> ProviderStatus {
    ProviderStatus {
        provider: "localGguf".to_string(),
        available: any_model_downloaded,
        reason: if any_model_downloaded { String::new() } else { "no model downloaded".to_string() },
    }
}

pub fn endpoint_status(url: Option<&str>) -> ProviderStatus {
    let configured = url.map(|u| !u.trim().is_empty()).unwrap_or(false);
    ProviderStatus {
        provider: "endpoint".to_string(),
        available: configured,
        reason: if configured { String::new() } else { "not configured".to_string() },
    }
}

/// `helper_found` is whether the sidecar binary exists on disk at all;
/// `availability` is what it answered to an `{"op":"availability"}` request,
/// when it was asked (`None` when it wasn't reachable or timed out).
/// The on-device provider to use when the user has not picked one for a job
/// (an Auto Tag rule without "Allow a remote AI provider"): Apple's model when
/// it is available, else the downloaded GGUF, else none. Same order as the
/// app's `availableOnDeviceProvider`.
pub fn on_device_provider(statuses: &[ProviderStatus]) -> Option<&'static str> {
    ["appleFm", "localGguf"]
        .into_iter()
        .find(|name| statuses.iter().any(|s| s.provider == *name && s.available))
}

pub fn apple_fm_status(helper_found: bool, availability: Option<&FmResponse>) -> ProviderStatus {
    if !helper_found {
        return ProviderStatus { provider: "appleFm".to_string(), available: false, reason: "helper not found".to_string() };
    }
    match availability {
        Some(resp) if resp.ok && resp.available.unwrap_or(false) => {
            ProviderStatus { provider: "appleFm".to_string(), available: true, reason: String::new() }
        }
        Some(resp) => {
            let reason = resp.reason.clone().or_else(|| resp.error.clone()).unwrap_or_else(|| "unavailable".to_string());
            ProviderStatus { provider: "appleFm".to_string(), available: false, reason }
        }
        None => ProviderStatus { provider: "appleFm".to_string(), available: false, reason: "helper did not answer".to_string() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_request_body_includes_a_system_message_only_when_given() {
        let with_system = chat_request_body("gpt-4o-mini", "hi", Some("be terse"), 128);
        assert_eq!(with_system["messages"][0]["role"], "system");
        assert_eq!(with_system["messages"][0]["content"], "be terse");
        assert_eq!(with_system["messages"][1]["content"], "hi");
        assert_eq!(with_system["max_tokens"], 128);

        let without_system = chat_request_body("llama3", "hi", None, 128);
        assert_eq!(without_system["messages"].as_array().unwrap().len(), 1);
        assert_eq!(without_system["messages"][0]["role"], "user");

        let empty_system = chat_request_body("llama3", "hi", Some(""), 128);
        assert_eq!(empty_system["messages"].as_array().unwrap().len(), 1, "an empty system string is the same as none");
    }

    #[test]
    fn parse_chat_response_reads_the_first_choices_content() {
        let body = json!({"choices": [{"message": {"role": "assistant", "content": "hello there"}}]});
        assert_eq!(parse_chat_response(&body).unwrap(), "hello there");
    }

    #[test]
    fn parse_chat_response_rejects_an_unexpected_shape() {
        let err = parse_chat_response(&json!({"error": "bad request"})).unwrap_err();
        assert!(err.contains("unexpected chat completion response shape"), "{err}");
    }

    #[test]
    fn fm_request_encodes_one_json_line_with_only_the_fields_it_set() {
        let avail = encode_fm_request(&FmRequest::availability("1"));
        assert_eq!(avail, r#"{"id":"1","op":"availability"}"#);

        let gen = encode_fm_request(&FmRequest::generate("2", "hi", Some("sys"), 64));
        let v: Value = serde_json::from_str(&gen).unwrap();
        assert_eq!(v["op"], "generate");
        assert_eq!(v["prompt"], "hi");
        assert_eq!(v["system"], "sys");
        assert_eq!(v["maxTokens"], 64);
    }

    #[test]
    fn fm_response_decodes_a_success_and_a_failure_line() {
        let ok = decode_fm_response(r#"{"id":"1","ok":true,"available":true,"reason":""}"#).unwrap();
        assert!(ok.ok);
        assert_eq!(ok.available, Some(true));

        let failed = decode_fm_response(r#"{"id":"2","ok":false,"error":"model unavailable"}"#).unwrap();
        assert!(!failed.ok);
        assert_eq!(failed.error.as_deref(), Some("model unavailable"));
    }

    #[test]
    fn decode_fm_response_names_the_bad_line_on_garbage_input() {
        let err = decode_fm_response("not json").unwrap_err();
        assert!(err.contains("not json"), "{err}");
    }

    #[test]
    fn local_gguf_status_reasons_off_whether_anything_is_downloaded() {
        assert!(local_gguf_status(true).available);
        let status = local_gguf_status(false);
        assert!(!status.available);
        assert_eq!(status.reason, "no model downloaded");
    }

    #[test]
    fn endpoint_status_reasons_off_a_non_empty_url() {
        assert!(endpoint_status(Some("http://localhost:11434")).available);
        assert!(!endpoint_status(Some("  ")).available, "whitespace-only is not configured");
        assert!(!endpoint_status(None).available);
    }

    #[test]
    fn apple_fm_status_reasons_through_helper_presence_then_its_own_answer() {
        assert_eq!(apple_fm_status(false, None).reason, "helper not found");

        let unreachable = apple_fm_status(true, None);
        assert!(!unreachable.available);
        assert_eq!(unreachable.reason, "helper did not answer");

        let unavailable = apple_fm_status(
            true,
            Some(&FmResponse { ok: true, available: Some(false), reason: Some("Apple Intelligence not enabled".into()), ..Default::default() }),
        );
        assert!(!unavailable.available);
        assert_eq!(unavailable.reason, "Apple Intelligence not enabled");

        let available = apple_fm_status(true, Some(&FmResponse { ok: true, available: Some(true), ..Default::default() }));
        assert!(available.available);
        assert_eq!(available.reason, "");
    }

    #[test]
    fn only_a_loopback_host_is_on_device() {
        for url in [
            "http://localhost:11434/v1",
            "http://LOCALHOST:11434",
            "https://localhost/v1",
            "http://127.0.0.1:11434/v1",
            "http://127.1.2.3:8080",
            "http://[::1]:11434/v1",
            "http://[::ffff:127.0.0.1]:11434",
            " http://localhost:11434 ",
        ] {
            assert!(endpoint_is_on_device(url), "{url} is this computer");
        }
        for url in [
            "http://192.168.1.5:11434",
            "http://10.0.0.2:11434/v1",
            "http://0.0.0.0:11434",
            "https://api.openai.com/v1",
            "http://localhost.evil.com",
            "http://127.0.0.1.evil.com",
            "http://localhost@evil.com",
            "http://evil.com/localhost",
            "http://my-mac.local:11434",
            "http://[::2]:11434",
            "localhost:11434/v1",
            "ftp://localhost/x",
            "file:///localhost",
            "",
            "   ",
            "not a url",
            "http://",
        ] {
            assert!(!endpoint_is_on_device(url), "{url:?} is not provably this computer");
        }
    }

    #[test]
    fn google_mail_reaches_only_apple_the_downloaded_model_or_a_loopback_endpoint() {
        assert!(provider_allowed_for_google_mail("appleFm", None));
        assert!(provider_allowed_for_google_mail("localGguf", None));
        assert!(provider_allowed_for_google_mail("endpoint", Some("http://localhost:11434/v1")));
        assert!(!provider_allowed_for_google_mail("endpoint", Some("https://api.openai.com/v1")));
        assert!(!provider_allowed_for_google_mail("endpoint", Some("http://192.168.1.5:11434")));
        assert!(!provider_allowed_for_google_mail("endpoint", None), "an endpoint with no URL is not provably local");
        assert!(!provider_allowed_for_google_mail("somethingNew", Some("http://localhost")), "an unknown kind is refused");
    }

    #[test]
    fn a_google_account_is_google_oauth_or_a_gmail_imap_host() {
        use serde_json::json;
        assert!(is_google_account(&json!({"authType": "oauth2", "oauth2Provider": "google"})));
        assert!(is_google_account(&json!({"authType": " OAuth2 ", "oauth2Provider": "Google"})));
        assert!(is_google_account(&json!({"authType": "password", "imapHost": "imap.gmail.com"})), "an app-password Gmail account");
        assert!(is_google_account(&json!({"imapHost": "IMAP.GOOGLEMAIL.COM"})));
        assert!(is_google_account(&json!({"imapHost": " imap.gmail.com. "})));
        assert!(!is_google_account(&json!({"authType": "oauth2", "oauth2Provider": "microsoft", "imapHost": "outlook.office365.com"})));
        assert!(!is_google_account(&json!({"authType": "password", "imapHost": "imap.fastmail.com"})));
        assert!(!is_google_account(&json!({"authType": "password", "oauth2Provider": "google"})), "a provider tag without OAuth is not a Google sign-in");
        assert!(!is_google_account(&json!({"imapHost": "imap.gmail.com.evil.com"})));
        assert!(!is_google_account(&json!({})));
        assert!(!is_google_account(&json!(null)));
    }

    fn status(provider: &str, available: bool) -> ProviderStatus {
        ProviderStatus { provider: provider.to_string(), available, reason: String::new() }
    }

    #[test]
    fn the_on_device_default_prefers_apple_intelligence_then_the_downloaded_model() {
        let all = |apple, gguf, endpoint| vec![status("localGguf", gguf), status("endpoint", endpoint), status("appleFm", apple)];
        assert_eq!(on_device_provider(&all(true, false, false)), Some("appleFm"), "a Mac with Apple Intelligence and no GGUF");
        assert_eq!(on_device_provider(&all(true, true, false)), Some("appleFm"));
        assert_eq!(on_device_provider(&all(false, true, false)), Some("localGguf"));
        assert_eq!(on_device_provider(&all(false, false, true)), None, "an endpoint is never the on-device default");
        assert_eq!(on_device_provider(&all(false, false, false)), None);
    }
}
