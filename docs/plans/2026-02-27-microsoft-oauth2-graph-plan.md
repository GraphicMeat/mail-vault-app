# Microsoft OAuth2 Fix + Graph API Transport — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Microsoft OAuth2 login for corporate M365 accounts and add Graph API read-only transport for personal Microsoft accounts.

**Architecture:** Two-part solution. Part A swaps the borrowed Thunderbird client ID with MailVault's own Azure AD app (`d4e1c192-2c87-4aeb-b2d6-edbb91c577cd`). Part B adds a new `graph.rs` Rust module that fetches email via Microsoft Graph REST API instead of IMAP, auto-detected for personal Microsoft domains.

**Tech Stack:** Rust (Tauri, reqwest, serde_json), React (Zustand), Microsoft Graph API v1.0

---

## Part A: OAuth2 Client ID Swap

### Task 1: Replace Thunderbird Client ID with MailVault's

**Files:**
- Modify: `src-tauri/src/oauth2.rs:18` (constant)
- Modify: `src-tauri/src/oauth2.rs:39-89` (get_provider_config)

**Step 1: Update the client ID constant**

In `src-tauri/src/oauth2.rs`, line 18, change:

```rust
const MS_THUNDERBIRD_CLIENT_ID: &str = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
```

To:

```rust
const MS_MAILVAULT_CLIENT_ID: &str = "d4e1c192-2c87-4aeb-b2d6-edbb91c577cd";
```

**Step 2: Update all references to the constant name**

In `get_provider_config()` (~line 48), change `MS_THUNDERBIRD_CLIENT_ID` → `MS_MAILVAULT_CLIENT_ID`.

**Step 3: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

**Step 4: Commit**

```bash
git add src-tauri/src/oauth2.rs
git commit -m "feat: swap to MailVault's own Azure AD client ID"
```

---

### Task 2: Add Per-Account Custom Client ID and Tenant ID Support

**Files:**
- Modify: `src-tauri/src/oauth2.rs:29-37` (ProviderConfig struct)
- Modify: `src-tauri/src/oauth2.rs:163-245` (generate_auth_url)
- Modify: `src-tauri/src/oauth2.rs:247-325` (exchange_code)
- Modify: `src-tauri/src/oauth2.rs:327-388` (refresh_token)
- Modify: `src-tauri/src/commands.rs:440-484` (command wrappers)
- Modify: `src/services/api.js:264-290` (API functions)

**Step 1: Add optional overrides to Tauri commands**

Update the `oauth2_auth_url` command in `commands.rs` (~line 440) to accept optional `custom_client_id` and `tenant_id` parameters:

```rust
#[tauri::command]
pub async fn oauth2_auth_url(
    email: String,
    provider: String,
    custom_client_id: Option<String>,
    tenant_id: Option<String>,
    state: tauri::State<'_, Arc<tokio::sync::Mutex<OAuth2Manager>>>,
) -> Result<serde_json::Value, String> {
    let manager = state.lock().await;
    manager.generate_auth_url(&email, &provider, custom_client_id.as_deref(), tenant_id.as_deref()).await
}
```

Apply the same pattern to `oauth2_exchange` and `oauth2_refresh` commands for `custom_client_id` and `tenant_id`.

**Step 2: Update `generate_auth_url()` signature**

In `oauth2.rs`, update the method to accept optional overrides:

```rust
pub async fn generate_auth_url(
    &self,
    email: &str,
    provider: &str,
    custom_client_id: Option<&str>,
    tenant_id: Option<&str>,
) -> Result<serde_json::Value, String> {
```

Inside the function, after `get_provider_config(provider)`:
- If `custom_client_id` is `Some`, override `config.client_id`
- If `tenant_id` is `Some`, replace `/common/` in `config.auth_endpoint` with `/{tenant_id}/`

```rust
let mut config = get_provider_config(provider)?;
if let Some(cid) = custom_client_id {
    config.client_id = cid.to_string();
}
if let Some(tid) = tenant_id {
    config.auth_endpoint = config.auth_endpoint.replace("/common/", &format!("/{}/", tid));
    config.token_endpoint = config.token_endpoint.replace("/common/", &format!("/{}/", tid));
}
```

**Step 3: Update `exchange_code()` and `refresh_token()` similarly**

Both need the same `custom_client_id` / `tenant_id` overrides applied to the provider config before making token requests.

**Step 4: Update frontend API functions**

In `src/services/api.js`, update `getOAuth2AuthUrl`, `exchangeOAuth2Code`, `refreshOAuth2Token` to pass through optional `customClientId` and `tenantId`:

```js
export async function getOAuth2AuthUrl(email, provider, customClientId, tenantId) {
  if (window.__TAURI__) {
    return await tauriInvoke('oauth2_auth_url', { email, provider, customClientId, tenantId });
  }
  // ... HTTP fallback
}
```

**Step 5: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles. Existing OAuth2 flow still works (overrides are optional/None).

**Step 6: Commit**

```bash
git add src-tauri/src/oauth2.rs src-tauri/src/commands.rs src/services/api.js
git commit -m "feat: support per-account custom client ID and tenant ID for Microsoft OAuth2"
```

---

### Task 3: Add Advanced OAuth2 Fields to AccountModal UI

**Files:**
- Modify: `src/components/AccountModal.jsx:8-85` (PROVIDER_CONFIGS)
- Modify: `src/components/AccountModal.jsx:292-344` (handleOAuth2SignIn)
- Modify: `src/components/AccountModal.jsx:481-559` (OAuth2 UI section)

**Step 1: Add state fields for custom client ID and tenant ID**

In AccountModal's form state, add:

```js
oauth2CustomClientId: '',
oauth2TenantId: '',
```

**Step 2: Add "Advanced" toggle and input fields**

Below the "Sign in with Microsoft" button, add a collapsible "Advanced" section:

```jsx
{formData.authType === 'oauth2' && providerConfig?.oauth2Provider === 'microsoft' && (
  <div className="mt-2">
    <button
      type="button"
      onClick={() => setShowAdvanced(!showAdvanced)}
      className="text-xs text-gray-400 hover:text-gray-300 flex items-center gap-1"
    >
      <ChevronRight size={12} className={showAdvanced ? 'rotate-90' : ''} />
      Advanced (Corporate)
    </button>
    {showAdvanced && (
      <div className="mt-2 space-y-2">
        <input
          type="text"
          placeholder="Custom Client ID (optional)"
          value={formData.oauth2CustomClientId}
          onChange={e => setFormData(prev => ({ ...prev, oauth2CustomClientId: e.target.value }))}
          className="w-full px-3 py-1.5 text-xs bg-gray-700 border border-gray-600 rounded"
        />
        <input
          type="text"
          placeholder="Tenant ID (optional, e.g. contoso.onmicrosoft.com)"
          value={formData.oauth2TenantId}
          onChange={e => setFormData(prev => ({ ...prev, oauth2TenantId: e.target.value }))}
          className="w-full px-3 py-1.5 text-xs bg-gray-700 border border-gray-600 rounded"
        />
      </div>
    )}
  </div>
)}
```

**Step 3: Pass overrides through handleOAuth2SignIn**

Update `handleOAuth2SignIn` (~line 307) to pass the custom values:

```js
const { authUrl, state } = await getOAuth2AuthUrl(
  formData.email,
  currentProvider,
  formData.oauth2CustomClientId || undefined,
  formData.oauth2TenantId || undefined
);
```

**Step 4: Persist custom fields in account data**

When saving the account, include `oauth2CustomClientId` and `oauth2TenantId` in the account object so they survive account edits.

**Step 5: Pass overrides through token refresh**

In `src/services/authUtils.js` (~line 55), update the `refreshOAuth2Token` call to pass through the account's custom client ID and tenant ID:

```js
const tokenData = await refreshOAuth2Token(
  account.oauth2RefreshToken,
  account.oauth2Provider,
  account.oauth2CustomClientId,
  account.oauth2TenantId
);
```

**Step 6: Test manually**

- Verify default Microsoft sign-in still works (no custom fields filled)
- Verify Advanced section shows/hides correctly
- Verify custom client ID is passed through when provided

**Step 7: Commit**

```bash
git add src/components/AccountModal.jsx src/services/authUtils.js
git commit -m "feat: add advanced OAuth2 fields for corporate Microsoft accounts"
```

---

## Part B: Microsoft Graph API Transport

### Task 4: Create Graph API Module (Rust)

**Files:**
- Create: `src-tauri/src/graph.rs`
- Modify: `src-tauri/src/main.rs` (add `mod graph;`)

**Step 1: Write unit tests for domain detection**

Create `src-tauri/src/graph.rs` with tests at the bottom:

```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};

/// Personal Microsoft domains that should use Graph API instead of IMAP
const PERSONAL_MS_DOMAINS: &[&str] = &[
    "outlook.com", "hotmail.com", "live.com", "msn.com",
    "outlook.co.uk", "hotmail.co.uk", "live.co.uk",
    "outlook.fr", "hotmail.fr", "live.fr",
    "outlook.de", "hotmail.de", "live.de",
    "outlook.jp", "hotmail.co.jp", "live.jp",
];

pub fn is_personal_microsoft(email: &str) -> bool {
    email.split('@')
        .nth(1)
        .map(|domain| PERSONAL_MS_DOMAINS.iter().any(|d| domain.eq_ignore_ascii_case(d)))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_personal_microsoft_detection() {
        assert!(is_personal_microsoft("user@outlook.com"));
        assert!(is_personal_microsoft("user@hotmail.com"));
        assert!(is_personal_microsoft("user@live.com"));
        assert!(is_personal_microsoft("user@msn.com"));
        assert!(is_personal_microsoft("user@Outlook.com")); // case-insensitive
        assert!(!is_personal_microsoft("user@company.com"));
        assert!(!is_personal_microsoft("user@gmail.com"));
        assert!(!is_personal_microsoft("user@contoso.onmicrosoft.com"));
        assert!(!is_personal_microsoft("invalid-email"));
    }
}
```

**Step 2: Run the test**

Run: `cd src-tauri && cargo test test_personal_microsoft_detection -- --nocapture`
Expected: PASS

**Step 3: Commit**

```bash
git add src-tauri/src/graph.rs src-tauri/src/main.rs
git commit -m "feat: add Graph module with personal Microsoft domain detection"
```

---

### Task 5: Graph API Data Structures and Response Parsing

**Files:**
- Modify: `src-tauri/src/graph.rs`

**Step 1: Write test for JSON response parsing**

Add structs and parsing tests:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMailFolder {
    pub id: String,
    pub display_name: String,
    pub total_item_count: i64,
    pub unread_item_count: i64,
    #[serde(default)]
    pub child_folder_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMessage {
    pub id: String,
    pub subject: Option<String>,
    pub from: Option<GraphEmailAddress>,
    pub to_recipients: Option<Vec<GraphEmailAddress>>,
    pub cc_recipients: Option<Vec<GraphEmailAddress>>,
    pub received_date_time: Option<String>,
    pub is_read: Option<bool>,
    pub has_attachments: Option<bool>,
    pub internet_message_id: Option<String>,
    pub body: Option<GraphBody>,
    pub internet_message_headers: Option<Vec<GraphHeader>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEmailAddress {
    pub email_address: GraphEmail,
}

#[derive(Debug, Deserialize)]
pub struct GraphEmail {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBody {
    pub content_type: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GraphHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct GraphListResponse<T> {
    pub value: Vec<T>,
    #[serde(rename = "@odata.nextLink")]
    pub next_link: Option<String>,
}

// Conversion to EmailHeader (from imap/mod.rs)
impl GraphMessage {
    pub fn to_email_header(&self, uid: u32) -> crate::imap::EmailHeader {
        let from = self.from.as_ref().and_then(|f| {
            let addr = f.email_address.address.as_deref().unwrap_or("");
            let name = f.email_address.name.as_deref().unwrap_or("");
            if name.is_empty() {
                Some(addr.to_string())
            } else {
                Some(format!("{} <{}>", name, addr))
            }
        }).unwrap_or_default();

        let to = self.to_recipients.as_ref().map(|recips| {
            recips.iter().filter_map(|r| r.email_address.address.as_deref()).collect::<Vec<_>>().join(", ")
        }).unwrap_or_default();

        let cc = self.cc_recipients.as_ref().map(|recips| {
            recips.iter().filter_map(|r| r.email_address.address.as_deref()).collect::<Vec<_>>().join(", ")
        }).unwrap_or_default();

        let mut flags = Vec::new();
        if self.is_read == Some(true) {
            flags.push("\\Seen".to_string());
        }

        // Extract In-Reply-To and References from internet message headers
        let in_reply_to = self.internet_message_headers.as_ref().and_then(|headers| {
            headers.iter().find(|h| h.name.eq_ignore_ascii_case("In-Reply-To")).map(|h| h.value.clone())
        });
        let references = self.internet_message_headers.as_ref().and_then(|headers| {
            headers.iter().find(|h| h.name.eq_ignore_ascii_case("References")).map(|h| {
                h.value.split_whitespace().map(|s| s.to_string()).collect::<Vec<_>>()
            })
        });

        crate::imap::EmailHeader {
            uid,
            seq: uid,
            display_index: None,
            message_id: self.internet_message_id.clone(),
            in_reply_to,
            references,
            subject: self.subject.clone().unwrap_or_default(),
            from,
            to,
            cc,
            bcc: String::new(),
            date: self.received_date_time.clone().unwrap_or_default(),
            internal_date: None,
            flags,
            size: 0,
            has_attachments: self.has_attachments.unwrap_or(false),
            source: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ... existing domain tests ...

    #[test]
    fn test_parse_graph_folder_response() {
        let json = r#"{
            "value": [
                {"id": "abc123", "displayName": "Inbox", "totalItemCount": 42, "unreadItemCount": 5, "childFolderCount": 0},
                {"id": "def456", "displayName": "Sent Items", "totalItemCount": 10, "unreadItemCount": 0, "childFolderCount": 0}
            ]
        }"#;
        let response: GraphListResponse<GraphMailFolder> = serde_json::from_str(json).unwrap();
        assert_eq!(response.value.len(), 2);
        assert_eq!(response.value[0].display_name, "Inbox");
        assert_eq!(response.value[0].total_item_count, 42);
        assert!(response.next_link.is_none());
    }

    #[test]
    fn test_parse_graph_message_response() {
        let json = r#"{
            "value": [
                {
                    "id": "msg1",
                    "subject": "Hello World",
                    "from": {"emailAddress": {"name": "John", "address": "john@example.com"}},
                    "toRecipients": [{"emailAddress": {"name": "Jane", "address": "jane@example.com"}}],
                    "ccRecipients": [],
                    "receivedDateTime": "2026-02-27T10:00:00Z",
                    "isRead": false,
                    "hasAttachments": true,
                    "internetMessageId": "<abc@example.com>"
                }
            ]
        }"#;
        let response: GraphListResponse<GraphMessage> = serde_json::from_str(json).unwrap();
        assert_eq!(response.value.len(), 1);
        let msg = &response.value[0];
        assert_eq!(msg.subject.as_deref(), Some("Hello World"));
        assert_eq!(msg.is_read, Some(false));
        assert_eq!(msg.has_attachments, Some(true));
    }

    #[test]
    fn test_graph_message_to_email_header() {
        let msg = GraphMessage {
            id: "msg1".to_string(),
            subject: Some("Test Subject".to_string()),
            from: Some(GraphEmailAddress { email_address: GraphEmail { name: Some("Alice".to_string()), address: Some("alice@example.com".to_string()) } }),
            to_recipients: Some(vec![GraphEmailAddress { email_address: GraphEmail { name: None, address: Some("bob@example.com".to_string()) } }]),
            cc_recipients: None,
            received_date_time: Some("2026-02-27T10:00:00Z".to_string()),
            is_read: Some(true),
            has_attachments: Some(false),
            internet_message_id: Some("<test@example.com>".to_string()),
            body: None,
            internet_message_headers: None,
        };
        let header = msg.to_email_header(1);
        assert_eq!(header.subject, "Test Subject");
        assert_eq!(header.from, "Alice <alice@example.com>");
        assert_eq!(header.to, "bob@example.com");
        assert!(header.flags.contains(&"\\Seen".to_string()));
        assert!(!header.has_attachments);
    }

    #[test]
    fn test_pagination_next_link() {
        let json = r#"{
            "value": [],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=10"
        }"#;
        let response: GraphListResponse<GraphMessage> = serde_json::from_str(json).unwrap();
        assert!(response.next_link.is_some());
        assert!(response.next_link.unwrap().contains("$skip=10"));
    }
}
```

**Step 2: Run all tests**

Run: `cd src-tauri && cargo test graph:: -- --nocapture`
Expected: All PASS

**Step 3: Commit**

```bash
git add src-tauri/src/graph.rs
git commit -m "feat: add Graph API data structures with JSON parsing and EmailHeader conversion"
```

---

### Task 6: Graph API Client — Fetch Mailboxes and Headers

**Files:**
- Modify: `src-tauri/src/graph.rs`

**Step 1: Implement the Graph client**

```rust
const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";

pub struct GraphClient {
    client: Client,
    access_token: String,
}

impl GraphClient {
    pub fn new(access_token: &str) -> Self {
        Self {
            client: Client::new(),
            access_token: access_token.to_string(),
        }
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.access_token)
    }

    /// List all mail folders
    pub async fn list_folders(&self) -> Result<Vec<GraphMailFolder>, String> {
        let url = format!("{}/me/mailFolders?$top=100", GRAPH_BASE);
        let resp = self.client.get(&url)
            .header("Authorization", self.auth_header())
            .send().await.map_err(|e| format!("Graph list folders: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Graph list folders failed ({}): {}", status, body));
        }

        let data: GraphListResponse<GraphMailFolder> = resp.json().await
            .map_err(|e| format!("Graph parse folders: {}", e))?;
        Ok(data.value)
    }

    /// Fetch email headers from a folder (paginated)
    pub async fn list_messages(
        &self,
        folder_id: &str,
        top: u32,
        skip: u32,
    ) -> Result<(Vec<GraphMessage>, Option<String>), String> {
        let url = format!(
            "{}/me/mailFolders/{}/messages?$top={}&$skip={}&$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,internetMessageId&$orderby=receivedDateTime desc",
            GRAPH_BASE, folder_id, top, skip
        );

        let resp = self.client.get(&url)
            .header("Authorization", self.auth_header())
            .send().await.map_err(|e| format!("Graph list messages: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Graph list messages failed ({}): {}", status, body));
        }

        let data: GraphListResponse<GraphMessage> = resp.json().await
            .map_err(|e| format!("Graph parse messages: {}", e))?;
        Ok((data.value, data.next_link))
    }

    /// Fetch a single message with full body and headers
    pub async fn get_message(&self, message_id: &str) -> Result<GraphMessage, String> {
        let url = format!(
            "{}/me/messages/{}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,internetMessageId,body,internetMessageHeaders",
            GRAPH_BASE, message_id
        );

        let resp = self.client.get(&url)
            .header("Authorization", self.auth_header())
            .header("Prefer", "outlook.body-content-type=\"html\"")
            .send().await.map_err(|e| format!("Graph get message: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Graph get message failed ({}): {}", status, body));
        }

        resp.json().await.map_err(|e| format!("Graph parse message: {}", e))
    }

    /// Mark a message as read or unread
    pub async fn set_read_status(&self, message_id: &str, is_read: bool) -> Result<(), String> {
        let url = format!("{}/me/messages/{}", GRAPH_BASE, message_id);

        let resp = self.client.patch(&url)
            .header("Authorization", self.auth_header())
            .json(&serde_json::json!({ "isRead": is_read }))
            .send().await.map_err(|e| format!("Graph set read status: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Graph set read status failed ({}): {}", status, body));
        }

        Ok(())
    }

    /// Get raw MIME content of a message (for .eml storage)
    pub async fn get_mime_content(&self, message_id: &str) -> Result<Vec<u8>, String> {
        let url = format!("{}/me/messages/{}/$value", GRAPH_BASE, message_id);

        let resp = self.client.get(&url)
            .header("Authorization", self.auth_header())
            .send().await.map_err(|e| format!("Graph get MIME: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Graph get MIME failed ({}): {}", status, body));
        }

        resp.bytes().await.map(|b| b.to_vec())
            .map_err(|e| format!("Graph read MIME bytes: {}", e))
    }
}
```

**Step 2: Run existing tests still pass**

Run: `cd src-tauri && cargo test graph:: -- --nocapture`
Expected: All PASS (new client code has no tests yet — unit tests were in Task 5)

**Step 3: Commit**

```bash
git add src-tauri/src/graph.rs
git commit -m "feat: implement Graph API client for folders, messages, read status, MIME content"
```

---

### Task 7: Graph API Error Handling Tests

**Files:**
- Modify: `src-tauri/src/graph.rs` (tests section)

**Step 1: Add error handling and retry logic**

Add to `GraphClient`:

```rust
/// Check if an error response indicates an expired token (401)
pub fn is_token_expired(error: &str) -> bool {
    error.contains("(401)")
}

/// Check if an error response indicates rate limiting (429)
pub fn is_rate_limited(error: &str) -> bool {
    error.contains("(429)")
}
```

**Step 2: Write error classification tests**

```rust
#[test]
fn test_error_classification() {
    assert!(GraphClient::is_token_expired("Graph list messages failed (401): token expired"));
    assert!(!GraphClient::is_token_expired("Graph list messages failed (500): server error"));
    assert!(GraphClient::is_rate_limited("Graph list messages failed (429): too many requests"));
    assert!(!GraphClient::is_rate_limited("Graph list messages failed (401): unauthorized"));
}
```

**Step 3: Run tests**

Run: `cd src-tauri && cargo test graph:: -- --nocapture`
Expected: All PASS

**Step 4: Commit**

```bash
git add src-tauri/src/graph.rs
git commit -m "feat: add Graph API error classification helpers"
```

---

### Task 8: Tauri Commands for Graph API

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs` (register commands)

**Step 1: Add Graph API Tauri commands**

```rust
#[tauri::command]
pub async fn graph_list_folders(access_token: String) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let folders = client.list_folders().await?;
    serde_json::to_value(folders).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn graph_list_messages(
    access_token: String,
    folder_id: String,
    top: u32,
    skip: u32,
) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let (messages, next_link) = client.list_messages(&folder_id, top, skip).await?;
    let headers: Vec<_> = messages.iter().enumerate()
        .map(|(i, m)| m.to_email_header((skip + i as u32 + 1) as u32))
        .collect();
    Ok(serde_json::json!({
        "headers": headers,
        "nextLink": next_link,
        "graphMessageIds": messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub async fn graph_get_message(
    access_token: String,
    message_id: String,
) -> Result<serde_json::Value, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    let msg = client.get_message(&message_id).await?;
    serde_json::to_value(&msg).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn graph_get_mime(
    access_token: String,
    message_id: String,
) -> Result<Vec<u8>, String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.get_mime_content(&message_id).await
}

#[tauri::command]
pub async fn graph_set_read(
    access_token: String,
    message_id: String,
    is_read: bool,
) -> Result<(), String> {
    let client = crate::graph::GraphClient::new(&access_token);
    client.set_read_status(&message_id, is_read).await
}
```

**Step 2: Register commands in main.rs**

Add `graph_list_folders`, `graph_list_messages`, `graph_get_message`, `graph_get_mime`, `graph_set_read` to the `.invoke_handler(tauri::generate_handler![...])` list.

**Step 3: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

**Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat: add Tauri commands for Graph API operations"
```

---

### Task 9: OAuth2 Scope Branching for Graph vs IMAP

**Files:**
- Modify: `src-tauri/src/oauth2.rs:39-89` (get_provider_config)
- Modify: `src-tauri/src/oauth2.rs:163-245` (generate_auth_url)
- Modify: `src-tauri/src/commands.rs` (oauth2_auth_url)
- Modify: `src/services/api.js`

**Step 1: Add a `use_graph` parameter to auth URL generation**

When `use_graph` is true, request Graph scopes instead of IMAP scopes:

```rust
// In generate_auth_url(), after loading provider config:
let scopes = if use_graph && provider == "microsoft" {
    "offline_access Mail.ReadWrite".to_string()
} else {
    config.scopes.clone()
};
```

**Step 2: Update the Tauri command**

Add `use_graph: Option<bool>` parameter to `oauth2_auth_url` command.

**Step 3: Update the frontend API**

In `api.js`, pass `useGraph` flag to `getOAuth2AuthUrl`.

**Step 4: Auto-detect in AccountModal**

In `handleOAuth2SignIn`, check the email domain:

```js
const isPersonalMs = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com']
  .some(d => formData.email.toLowerCase().endsWith('@' + d));

const { authUrl, state } = await getOAuth2AuthUrl(
  formData.email, currentProvider, customClientId, tenantId, isPersonalMs
);

// Store transport type on the account
setFormData(prev => ({ ...prev, oauth2Transport: isPersonalMs ? 'graph' : 'imap' }));
```

**Step 5: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles.

**Step 6: Commit**

```bash
git add src-tauri/src/oauth2.rs src-tauri/src/commands.rs src/services/api.js src/components/AccountModal.jsx
git commit -m "feat: auto-detect personal Microsoft accounts and request Graph API scopes"
```

---

### Task 10: Frontend API Bridge for Graph Operations

**Files:**
- Modify: `src/services/api.js`

**Step 1: Add Graph API functions to frontend**

```js
export async function graphListFolders(accessToken) {
  return await tauriInvoke('graph_list_folders', { accessToken });
}

export async function graphListMessages(accessToken, folderId, top, skip) {
  return await tauriInvoke('graph_list_messages', { accessToken, folderId, top, skip: skip || 0 });
}

export async function graphGetMessage(accessToken, messageId) {
  return await tauriInvoke('graph_get_message', { accessToken, messageId });
}

export async function graphGetMime(accessToken, messageId) {
  return await tauriInvoke('graph_get_mime', { accessToken, messageId });
}

export async function graphSetRead(accessToken, messageId, isRead) {
  return await tauriInvoke('graph_set_read', { accessToken, messageId, isRead });
}
```

**Step 2: Commit**

```bash
git add src/services/api.js
git commit -m "feat: add frontend API bridge for Graph operations"
```

---

### Task 11: Store Integration — Route Graph Accounts Through Graph Transport

**Files:**
- Modify: `src/stores/mailStore.js` (loadEmails, selectEmail, markEmailReadStatus)

**Step 1: Add transport detection helper**

```js
function isGraphAccount(account) {
  return account?.oauth2Transport === 'graph';
}
```

**Step 2: Add Graph-based email loading in `loadEmails`**

At the top of `loadEmails`, branch on transport:

```js
if (isGraphAccount(account)) {
  return await loadEmailsViaGraph(account);
}
// ... existing IMAP loading
```

Implement `loadEmailsViaGraph`:

```js
async function loadEmailsViaGraph(account) {
  const freshAccount = await ensureFreshToken(account);
  const token = freshAccount.oauth2AccessToken;

  // List folders
  const folders = await graphListFolders(token);

  // Map Graph folder names to IMAP-style names
  const mailboxes = folders.map(f => ({
    name: f.displayName,
    graphId: f.id,
    total: f.totalItemCount,
    unread: f.unreadItemCount,
    noselect: false,
  }));

  // Fetch messages from active mailbox
  const activeFolder = folders.find(f => f.displayName === activeMailbox) || folders[0];
  const { headers, graphMessageIds } = await graphListMessages(token, activeFolder.id, 50, 0);

  // Store graphMessageId mapping for later fetches
  // ... set state
}
```

**Step 3: Add Graph-based body fetching in selectEmail**

When selecting an email on a Graph account, use `graphGetMime` to get the raw .eml content and pass it through existing MIME parsing.

**Step 4: Add Graph-based mark read/unread**

In `markEmailReadStatus`, branch on `isGraphAccount` and use `graphSetRead`.

**Step 5: Test manually with a personal Microsoft account**

- Sign in with an outlook.com account
- Verify folders appear
- Verify email headers load
- Verify email bodies render
- Verify mark as read works

**Step 6: Commit**

```bash
git add src/stores/mailStore.js
git commit -m "feat: route personal Microsoft accounts through Graph API transport"
```

---

### Task 12: Pipeline Integration for Graph Accounts

**Files:**
- Modify: `src/services/AccountPipeline.js`
- Modify: `src/services/EmailPipelineManager.js`

**Step 1: Skip IMAP pipeline for Graph accounts**

In `AccountPipeline`, check if the account uses Graph transport. If so, use Graph API for header loading and content caching instead of IMAP.

**Step 2: Adapt header loading phase**

Replace IMAP UID fetch with `graphListMessages` pagination (loop using `$skip` until all headers loaded).

**Step 3: Adapt content caching phase**

Replace IMAP body fetch with `graphGetMime` for .eml download and local storage.

**Step 4: Test manually**

Verify background caching works for a personal Microsoft account.

**Step 5: Commit**

```bash
git add src/services/AccountPipeline.js src/services/EmailPipelineManager.js
git commit -m "feat: integrate Graph transport into background caching pipeline"
```

---

### Task 13: Update CLAUDE.md and CHANGELOG.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

**Step 1: Add Graph API section to CLAUDE.md**

Document the new `graph.rs` module, Graph transport routing, personal domain detection, and new Tauri commands.

**Step 2: Add changelog entries under `[Unreleased]`**

```markdown
### Added
- Microsoft Graph API read-only transport for personal Outlook.com/Hotmail/Live.com accounts (bypasses IMAP regression)
- Own Azure AD app registration replaces borrowed Thunderbird client ID
- Advanced OAuth2 fields for corporate Microsoft accounts (custom client ID, tenant ID)
```

**Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: document Graph API transport and OAuth2 changes"
```

---

## Ship Order

1. **Tasks 1-3** → Part A (client ID swap + advanced fields) — can ship immediately as a quick win
2. **Tasks 4-12** → Part B (Graph transport) — larger feature, ship after testing with real personal accounts
3. **Task 13** → Documentation — ship with whichever part lands
