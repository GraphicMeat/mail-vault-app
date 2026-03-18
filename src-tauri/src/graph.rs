use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::imap::{EmailAddress, EmailHeader};

// ---------------------------------------------------------------------------
// Domain detection
// ---------------------------------------------------------------------------

/// Personal Microsoft domains that should use Graph API instead of IMAP.
/// These accounts are affected by a Microsoft server-side IMAP OAuth regression
/// (since Dec 2024) that causes "User is authenticated but not connected" errors.
const PERSONAL_MS_DOMAINS: &[&str] = &[
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "outlook.co.uk",
    "hotmail.co.uk",
    "live.co.uk",
    "outlook.fr",
    "hotmail.fr",
    "live.fr",
    "outlook.de",
    "hotmail.de",
    "live.de",
    "outlook.jp",
    "hotmail.co.jp",
    "live.jp",
];

pub fn is_personal_microsoft(email: &str) -> bool {
    email
        .split('@')
        .nth(1)
        .map(|domain| {
            PERSONAL_MS_DOMAINS
                .iter()
                .any(|d| domain.eq_ignore_ascii_case(d))
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Graph API data structures (serde deserialization from Graph JSON)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMailFolder {
    pub id: String,
    pub display_name: String,
    pub total_item_count: i64,
    pub unread_item_count: i64,
    #[serde(default)]
    pub child_folder_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEmailAddress {
    pub email_address: GraphEmail,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphEmail {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBody {
    pub content_type: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
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

// ---------------------------------------------------------------------------
// GraphMessage → EmailHeader conversion
// ---------------------------------------------------------------------------

impl GraphMessage {
    /// Convert a Graph API message into the app's standard `EmailHeader`.
    /// `uid` is a synthetic UID assigned by the caller (Graph messages use
    /// opaque string IDs, so callers map them to sequential u32 UIDs).
    pub fn to_email_header(&self, uid: u32) -> EmailHeader {
        let from = self
            .from
            .as_ref()
            .map(|f| EmailAddress {
                name: f.email_address.name.clone(),
                address: f
                    .email_address
                    .address
                    .clone()
                    .unwrap_or_default(),
            })
            .unwrap_or_default();

        let to: Vec<EmailAddress> = self
            .to_recipients
            .as_ref()
            .map(|list| {
                list.iter()
                    .map(|r| EmailAddress {
                        name: r.email_address.name.clone(),
                        address: r.email_address.address.clone().unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let cc: Vec<EmailAddress> = self
            .cc_recipients
            .as_ref()
            .map(|list| {
                list.iter()
                    .map(|r| EmailAddress {
                        name: r.email_address.name.clone(),
                        address: r.email_address.address.clone().unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let mut flags = Vec::new();
        if self.is_read == Some(true) {
            flags.push("\\Seen".to_string());
        }

        // Extract threading headers from internetMessageHeaders
        let in_reply_to = self.get_header("In-Reply-To");
        let references = self.get_header("References").map(|refs_str| {
            refs_str
                .split_whitespace()
                .map(|s| s.to_string())
                .collect::<Vec<String>>()
        });

        EmailHeader {
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
            bcc: Vec::new(),
            date: self.received_date_time.clone(),
            internal_date: self.received_date_time.clone(),
            flags,
            size: None,
            has_attachments: self.has_attachments.unwrap_or(false),
            source: Some("graph".to_string()),
            reply_to: None,
            return_path: None,
            authentication_results: None,
        }
    }

    /// Look up a header by name from `internetMessageHeaders`.
    fn get_header(&self, name: &str) -> Option<String> {
        self.internet_message_headers.as_ref().and_then(|headers| {
            headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case(name))
                .map(|h| h.value.clone())
        })
    }
}

// ---------------------------------------------------------------------------
// Graph API client
// ---------------------------------------------------------------------------

const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";

pub struct GraphClient {
    pub(crate) client: Client,
    pub(crate) access_token: String,
}

impl GraphClient {
    pub fn new(access_token: &str) -> Self {
        Self {
            client: Client::new(),
            access_token: access_token.to_string(),
        }
    }

    /// List all mail folders for the authenticated user.
    pub async fn list_folders(&self) -> Result<Vec<GraphMailFolder>, String> {
        let url = format!("{}/me/mailFolders?$top=100", GRAPH_BASE);
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| format!("Graph list_folders request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph list_folders failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        let list: GraphListResponse<GraphMailFolder> = resp
            .json()
            .await
            .map_err(|e| format!("Graph list_folders parse error: {}", e))?;

        Ok(list.value)
    }

    /// List messages in a folder with pagination.
    /// Returns the messages and an optional next-link URL for the next page.
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

        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| format!("Graph list_messages request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph list_messages failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        let list: GraphListResponse<GraphMessage> = resp
            .json()
            .await
            .map_err(|e| format!("Graph list_messages parse error: {}", e))?;

        Ok((list.value, list.next_link))
    }

    /// Get a single message with full body and internet headers.
    pub async fn get_message(&self, message_id: &str) -> Result<GraphMessage, String> {
        let url = format!(
            "{}/me/messages/{}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,internetMessageId,body,internetMessageHeaders",
            GRAPH_BASE, message_id
        );

        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .header("Prefer", "outlook.body-content-type=\"html\"")
            .send()
            .await
            .map_err(|e| format!("Graph get_message request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph get_message failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        resp.json()
            .await
            .map_err(|e| format!("Graph get_message parse error: {}", e))
    }

    /// Mark a message as read or unread.
    pub async fn set_read_status(
        &self,
        message_id: &str,
        is_read: bool,
    ) -> Result<(), String> {
        let url = format!("{}/me/messages/{}", GRAPH_BASE, message_id);

        let resp = self
            .client
            .patch(&url)
            .bearer_auth(&self.access_token)
            .json(&serde_json::json!({ "isRead": is_read }))
            .send()
            .await
            .map_err(|e| format!("Graph set_read_status request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph set_read_status failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        Ok(())
    }

    /// Delete a message (moves to Deleted Items by default in Graph API).
    pub async fn delete_message(&self, message_id: &str) -> Result<(), String> {
        let url = format!("{}/me/messages/{}", GRAPH_BASE, message_id);

        let resp = self
            .client
            .delete(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| format!("Graph delete_message request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph delete_message failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        Ok(())
    }

    /// Move a message to a different folder. Returns the new message ID.
    pub async fn move_message(
        &self,
        message_id: &str,
        destination_folder_id: &str,
    ) -> Result<String, String> {
        let url = format!("{}/me/messages/{}/move", GRAPH_BASE, message_id);

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.access_token)
            .json(&serde_json::json!({ "destinationId": destination_folder_id }))
            .send()
            .await
            .map_err(|e| format!("Graph move_message request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph move_message failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        let moved: GraphMessage = resp
            .json()
            .await
            .map_err(|e| format!("Graph move_message parse error: {}", e))?;

        Ok(moved.id)
    }

    /// Download the raw MIME (.eml) content of a message.
    pub async fn get_mime_content(&self, message_id: &str) -> Result<Vec<u8>, String> {
        let url = format!("{}/me/messages/{}/$value", GRAPH_BASE, message_id);

        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .map_err(|e| format!("Graph get_mime_content request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph get_mime_content failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| format!("Graph get_mime_content read error: {}", e))
    }

    // -----------------------------------------------------------------------
    // Migration helpers: MIME upload + folder creation
    // -----------------------------------------------------------------------

    /// Upload a raw MIME message to the drafts folder, returning the new message ID.
    /// Graph API requires the MIME content to be base64-encoded with Content-Type: text/plain.
    pub async fn create_message_from_mime(&self, mime_bytes: &[u8]) -> Result<String, String> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(mime_bytes);
        let url = format!("{}/me/messages", GRAPH_BASE);

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.access_token)
            .header("Content-Type", "text/plain")
            .body(encoded)
            .send()
            .await
            .map_err(|e| format!("Graph create_message_from_mime request failed: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph create_message_from_mime failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        let msg: GraphMessage = resp
            .json()
            .await
            .map_err(|e| format!("Graph create_message_from_mime parse error: {}", e))?;

        Ok(msg.id)
    }

    /// Create a mail folder. If `parent_folder_id` is provided, creates a child folder.
    /// Handles 409 Conflict (folder already exists) by listing folders and returning the match.
    pub async fn create_folder(
        &self,
        display_name: &str,
        parent_folder_id: Option<&str>,
    ) -> Result<GraphMailFolder, String> {
        let url = match parent_folder_id {
            Some(parent_id) => format!(
                "{}/me/mailFolders/{}/childFolders",
                GRAPH_BASE, parent_id
            ),
            None => format!("{}/me/mailFolders", GRAPH_BASE),
        };

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.access_token)
            .json(&serde_json::json!({ "displayName": display_name }))
            .send()
            .await
            .map_err(|e| format!("Graph create_folder request failed: {}", e))?;

        let status = resp.status();

        // 409 Conflict = folder already exists — find and return it
        if status.as_u16() == 409 {
            let folders = self.list_folders().await?;
            return folders
                .into_iter()
                .find(|f| f.display_name.eq_ignore_ascii_case(display_name))
                .ok_or_else(|| {
                    format!(
                        "Graph create_folder: 409 Conflict but could not find folder '{}'",
                        display_name
                    )
                });
        }

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Graph create_folder failed ({}) {}",
                status.as_u16(),
                body
            ));
        }

        resp.json()
            .await
            .map_err(|e| format!("Graph create_folder parse error: {}", e))
    }

    // -----------------------------------------------------------------------
    // Error classification helpers
    // -----------------------------------------------------------------------

    pub fn is_token_expired(error: &str) -> bool {
        error.contains("(401)")
    }

    pub fn is_rate_limited(error: &str) -> bool {
        error.contains("(429)")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- Domain detection ---------------------------------------------------

    #[test]
    fn test_personal_microsoft_detection() {
        assert!(is_personal_microsoft("user@outlook.com"));
        assert!(is_personal_microsoft("user@Outlook.COM"));
        assert!(is_personal_microsoft("user@hotmail.com"));
        assert!(is_personal_microsoft("user@live.com"));
        assert!(is_personal_microsoft("user@msn.com"));
        assert!(is_personal_microsoft("user@outlook.co.uk"));
        assert!(is_personal_microsoft("user@hotmail.de"));
        assert!(is_personal_microsoft("user@live.fr"));
        assert!(is_personal_microsoft("user@outlook.jp"));
        assert!(is_personal_microsoft("user@hotmail.co.jp"));

        assert!(!is_personal_microsoft("user@gmail.com"));
        assert!(!is_personal_microsoft("user@company.onmicrosoft.com"));
        assert!(!is_personal_microsoft("user@custom-domain.com"));
        assert!(!is_personal_microsoft("noatsign"));
        assert!(!is_personal_microsoft(""));
    }

    // -- JSON parsing -------------------------------------------------------

    #[test]
    fn test_parse_graph_folder_response() {
        let json = r#"{
            "value": [
                {
                    "id": "inbox-id-123",
                    "displayName": "Inbox",
                    "totalItemCount": 42,
                    "unreadItemCount": 5,
                    "childFolderCount": 2
                },
                {
                    "id": "sent-id-456",
                    "displayName": "Sent Items",
                    "totalItemCount": 100,
                    "unreadItemCount": 0
                }
            ]
        }"#;

        let resp: GraphListResponse<GraphMailFolder> = serde_json::from_str(json).unwrap();
        assert_eq!(resp.value.len(), 2);
        assert_eq!(resp.value[0].display_name, "Inbox");
        assert_eq!(resp.value[0].total_item_count, 42);
        assert_eq!(resp.value[0].unread_item_count, 5);
        assert_eq!(resp.value[0].child_folder_count, 2);
        assert_eq!(resp.value[1].display_name, "Sent Items");
        // childFolderCount defaults to 0 when missing
        assert_eq!(resp.value[1].child_folder_count, 0);
        assert!(resp.next_link.is_none());
    }

    #[test]
    fn test_parse_graph_message_response() {
        let json = r#"{
            "value": [
                {
                    "id": "msg-id-abc",
                    "subject": "Hello World",
                    "from": {
                        "emailAddress": {
                            "name": "Alice",
                            "address": "alice@outlook.com"
                        }
                    },
                    "toRecipients": [
                        {
                            "emailAddress": {
                                "name": "Bob",
                                "address": "bob@example.com"
                            }
                        }
                    ],
                    "ccRecipients": [],
                    "receivedDateTime": "2025-01-15T10:30:00Z",
                    "isRead": true,
                    "hasAttachments": false,
                    "internetMessageId": "<msg123@outlook.com>"
                }
            ]
        }"#;

        let resp: GraphListResponse<GraphMessage> = serde_json::from_str(json).unwrap();
        assert_eq!(resp.value.len(), 1);

        let msg = &resp.value[0];
        assert_eq!(msg.id, "msg-id-abc");
        assert_eq!(msg.subject.as_deref(), Some("Hello World"));
        assert_eq!(
            msg.from.as_ref().unwrap().email_address.address.as_deref(),
            Some("alice@outlook.com")
        );
        assert_eq!(msg.is_read, Some(true));
        assert_eq!(msg.has_attachments, Some(false));
        assert_eq!(
            msg.internet_message_id.as_deref(),
            Some("<msg123@outlook.com>")
        );
    }

    #[test]
    fn test_graph_message_to_email_header() {
        let msg = GraphMessage {
            id: "msg-id-1".to_string(),
            subject: Some("Test Subject".to_string()),
            from: Some(GraphEmailAddress {
                email_address: GraphEmail {
                    name: Some("Sender Name".to_string()),
                    address: Some("sender@outlook.com".to_string()),
                },
            }),
            to_recipients: Some(vec![GraphEmailAddress {
                email_address: GraphEmail {
                    name: Some("Recipient".to_string()),
                    address: Some("recipient@example.com".to_string()),
                },
            }]),
            cc_recipients: Some(vec![GraphEmailAddress {
                email_address: GraphEmail {
                    name: None,
                    address: Some("cc@example.com".to_string()),
                },
            }]),
            received_date_time: Some("2025-01-15T10:30:00Z".to_string()),
            is_read: Some(true),
            has_attachments: Some(true),
            internet_message_id: Some("<test-123@outlook.com>".to_string()),
            body: None,
            internet_message_headers: None,
        };

        let header = msg.to_email_header(42);

        assert_eq!(header.uid, 42);
        assert_eq!(header.seq, 42);
        assert_eq!(header.subject, "Test Subject");
        assert_eq!(header.from.name.as_deref(), Some("Sender Name"));
        assert_eq!(header.from.address, "sender@outlook.com");
        assert_eq!(header.to.len(), 1);
        assert_eq!(header.to[0].address, "recipient@example.com");
        assert_eq!(header.cc.len(), 1);
        assert_eq!(header.cc[0].address, "cc@example.com");
        assert!(header.bcc.is_empty());
        assert_eq!(header.date.as_deref(), Some("2025-01-15T10:30:00Z"));
        assert!(header.flags.contains(&"\\Seen".to_string()));
        assert!(header.has_attachments);
        assert_eq!(
            header.message_id.as_deref(),
            Some("<test-123@outlook.com>")
        );
        assert_eq!(header.source.as_deref(), Some("graph"));
        assert!(header.in_reply_to.is_none());
        assert!(header.references.is_none());
    }

    #[test]
    fn test_pagination_next_link() {
        let json = r#"{
            "value": [],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50"
        }"#;

        let resp: GraphListResponse<GraphMessage> = serde_json::from_str(json).unwrap();
        assert!(resp.value.is_empty());
        assert_eq!(
            resp.next_link.as_deref(),
            Some("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50")
        );
    }

    // -- Error classification -----------------------------------------------

    #[test]
    fn test_error_classification() {
        assert!(GraphClient::is_token_expired(
            "Graph get_message failed (401) Unauthorized"
        ));
        assert!(!GraphClient::is_token_expired(
            "Graph get_message failed (403) Forbidden"
        ));
        assert!(GraphClient::is_rate_limited(
            "Graph list_messages failed (429) Too Many Requests"
        ));
        assert!(!GraphClient::is_rate_limited(
            "Graph list_messages failed (500) Server Error"
        ));
    }

    // -- Edge cases ---------------------------------------------------------

    #[test]
    fn test_message_with_no_from() {
        let msg = GraphMessage {
            id: "msg-no-from".to_string(),
            subject: None,
            from: None,
            to_recipients: None,
            cc_recipients: None,
            received_date_time: None,
            is_read: None,
            has_attachments: None,
            internet_message_id: None,
            body: None,
            internet_message_headers: None,
        };

        let header = msg.to_email_header(1);

        // from falls back to default EmailAddress
        assert_eq!(header.from.address, "unknown@unknown.com");
        assert_eq!(header.from.name.as_deref(), Some("Unknown"));
        assert_eq!(header.subject, "");
        assert!(header.to.is_empty());
        assert!(header.cc.is_empty());
        assert!(header.flags.is_empty()); // is_read is None
        assert!(!header.has_attachments);
        assert!(header.date.is_none());
        assert!(header.message_id.is_none());
    }

    #[test]
    fn test_message_with_headers_for_threading() {
        let msg = GraphMessage {
            id: "msg-threaded".to_string(),
            subject: Some("Re: Discussion".to_string()),
            from: Some(GraphEmailAddress {
                email_address: GraphEmail {
                    name: Some("Alice".to_string()),
                    address: Some("alice@outlook.com".to_string()),
                },
            }),
            to_recipients: None,
            cc_recipients: None,
            received_date_time: Some("2025-02-01T12:00:00Z".to_string()),
            is_read: Some(false),
            has_attachments: Some(false),
            internet_message_id: Some("<reply-456@outlook.com>".to_string()),
            body: None,
            internet_message_headers: Some(vec![
                GraphHeader {
                    name: "In-Reply-To".to_string(),
                    value: "<original-123@outlook.com>".to_string(),
                },
                GraphHeader {
                    name: "References".to_string(),
                    value: "<root-000@outlook.com> <original-123@outlook.com>".to_string(),
                },
            ]),
        };

        let header = msg.to_email_header(99);

        assert_eq!(
            header.in_reply_to.as_deref(),
            Some("<original-123@outlook.com>")
        );
        let refs = header.references.unwrap();
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0], "<root-000@outlook.com>");
        assert_eq!(refs[1], "<original-123@outlook.com>");

        // is_read false → no \\Seen flag
        assert!(header.flags.is_empty());
    }
}
