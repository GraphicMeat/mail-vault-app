use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC 2.0 request.
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub id: Option<Value>,
}

/// JSON-RPC 2.0 success response.
#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    pub id: Value,
}

/// JSON-RPC 2.0 error object.
#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

// Standard JSON-RPC error codes
pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;
pub const AUTH_REQUIRED: i32 = -32000;
pub const AUTH_FAILED: i32 = -32001;

impl RpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            result: Some(result),
            error: None,
            id,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data: None,
            }),
            id,
        }
    }
}

/// Authentication handshake request — first message on every new connection.
#[derive(Debug, Deserialize)]
pub struct AuthHandshake {
    pub token: String,
}

/// Parse a raw line into an RPC request, returning an error response if parsing fails.
pub fn parse_request(line: &str) -> Result<RpcRequest, RpcResponse> {
    serde_json::from_str::<RpcRequest>(line).map_err(|e| {
        RpcResponse::error(
            Value::Null,
            PARSE_ERROR,
            format!("Parse error: {}", e),
        )
    })
}

/// Streaming progress event (server-initiated, no id).
#[derive(Debug, Serialize)]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

impl RpcNotification {
    pub fn progress(task: &str, current: u64, total: u64) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            method: "progress".into(),
            params: serde_json::json!({
                "task": task,
                "current": current,
                "total": total,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_request() {
        let json = r#"{"jsonrpc":"2.0","method":"maildir.list","params":{"accountId":"abc"},"id":1}"#;
        let req = parse_request(json).unwrap();
        assert_eq!(req.method, "maildir.list");
        assert_eq!(req.id, Some(Value::Number(1.into())));
    }

    #[test]
    fn test_parse_invalid_json() {
        let result = parse_request("not json");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.error.unwrap().code, PARSE_ERROR);
    }

    #[test]
    fn test_success_response_serialization() {
        let resp = RpcResponse::success(Value::Number(1.into()), serde_json::json!({"ok": true}));
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"result\""));
        assert!(!json.contains("\"error\""));
    }

    #[test]
    fn test_error_response_serialization() {
        let resp = RpcResponse::error(Value::Number(1.into()), METHOD_NOT_FOUND, "not found");
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"error\""));
        assert!(!json.contains("\"result\""));
    }

    #[test]
    fn test_progress_notification() {
        let notif = RpcNotification::progress("classify", 50, 100);
        let json = serde_json::to_string(&notif).unwrap();
        assert!(json.contains("\"progress\""));
        assert!(json.contains("\"current\":50"));
    }
}
