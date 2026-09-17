//! Daemon RPC routes for DNS (Task 5.8), plan
//! `docs/superpowers/plans/2026-09-17-daemon-shell-phase5-network.md`.
//!
//! Flat `resolve_email_settings`/`dns_mail_health` names, no rename layer —
//! same convention as every other Phase 5 domain (5.4a/5.4b/5.5/5.6/5.7):
//! their Tauri twins are deleted in this same task, so these go straight
//! into `transport.js`'s `DAEMON_OWNED`.
//!
//! Both are pure `mailvault_core::dns` calls with no daemon state at all —
//! `resolve_email_settings` was already core; `mail_dns_health` moves there
//! in this task (from `src-tauri/src/dns.rs`, verbatim — same relocate
//! Task 5.3 did for SMTP, except here the app-side shell has nothing left to
//! keep afterward, so `src-tauri/src/dns.rs` is deleted outright rather than
//! kept as a thin re-export; see the ledger). Response shape is the bare
//! settings/health object, matching `commands.rs`'s old
//! `serde_json::to_value(...)` with no `{success: true, ...}` wrapper —
//! unlike oauth2/smtp/graph's routes.
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::dns;
use serde_json::Value;
use std::sync::Arc;

fn domain_arg(id: &Value, params: &Value) -> Result<String, RpcResponse> {
    params
        .get("domain")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "Missing domain".to_string()))
}

pub(crate) async fn route(_state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "resolve_email_settings" => {
            let domain = match domain_arg(&id, params) {
                Ok(d) => d,
                Err(resp) => return Some(resp),
            };
            match dns::resolve_email_settings(&domain).await {
                Ok(settings) => match serde_json::to_value(settings) {
                    Ok(v) => RpcResponse::success(id, v),
                    Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Serialization error: {}", e)),
                },
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "dns_mail_health" => {
            let domain = match domain_arg(&id, params) {
                Ok(d) => d,
                Err(resp) => return Some(resp),
            };
            let new_imap_host = params.get("newImapHost").and_then(Value::as_str).map(str::to_owned);
            match dns::mail_dns_health(&domain, new_imap_host.as_deref()).await {
                Ok(health) => match serde_json::to_value(health) {
                    Ok(v) => RpcResponse::success(id, v),
                    Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Serialization error: {}", e)),
                },
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-dns-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    // No live-lookup success-path test here: `mailvault_core::dns` builds its
    // resolver from the system's real DNS config
    // (`TokioResolver::builder_tokio()`), with no injectable nameserver
    // override anywhere in this codebase -- unlike Graph/OAuth2's
    // HTTP-over-loopback overrides (`MAILVAULT_GRAPH_BASE`,
    // `MAILVAULT_MS_TOKEN_ENDPOINT`), which needed no new API surface, a
    // DNS-over-loopback equivalent would mean guessing an untested
    // hickory-resolver 0.26 `ResolverConfig`/`NameServerConfigGroup` shape
    // under this task's "don't run cargo" rule -- a wrong guess breaks the
    // whole `src-core` build, not just this test. The success path's actual
    // logic (MX/SPF/DMARC/DKIM parsing, provider matching, warning text) is
    // covered by the 9 pure-function tests that moved with `mail_dns_health`
    // into `src-core/src/dns.rs`; what's untested end-to-end is a real
    // resolver lookup reaching those functions. Flagged in the ledger.

    #[tokio::test]
    async fn resolve_email_settings_without_a_domain_is_invalid_params() {
        let s = st();
        let resp = call(&s, "resolve_email_settings", json!({})).await;
        assert!(resp.result.is_none());
        assert_eq!(resp.error.expect("must be an error").code, ipc::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn dns_mail_health_without_a_domain_is_invalid_params() {
        let s = st();
        let resp = call(&s, "dns_mail_health", json!({"newImapHost": "imap.example.com"})).await;
        assert!(resp.result.is_none());
        assert_eq!(resp.error.expect("must be an error").code, ipc::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let s = st();
        assert!(route(&s, "imap_get_mailboxes", &json!({}), json!(1)).await.is_none());
    }

    // The serde contract, not DNS itself: this is the exact shape
    // `ChangeServerModal.jsx`/`AccountModal.jsx` read (`mxHosts`,
    // `spfFound`, `imapHost`, ...). `EmailServerSettings` uses per-field
    // `#[serde(rename = "...")]`, `MailDnsHealth` uses `rename_all =
    // "camelCase"` — assert both shapes independently since they get there
    // by different attributes.
    #[test]
    fn mail_dns_health_response_keys_are_camel_case() {
        let health = dns::MailDnsHealth {
            domain: "example.com".to_string(),
            mx_hosts: vec!["mx.example.com".to_string()],
            mx_matches_new_server: Some(true),
            spf_found: true,
            spf_record: Some("v=spf1 -all".to_string()),
            dmarc_found: false,
            dmarc_record: None,
            dkim_selectors_found: vec![],
            dkim_selectors_checked: vec!["default".to_string()],
            warnings: vec!["No DMARC record found.".to_string()],
        };
        let v = serde_json::to_value(&health).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "domain", "mxHosts", "mxMatchesNewServer", "spfFound", "spfRecord",
            "dmarcFound", "dmarcRecord", "dkimSelectorsFound", "dkimSelectorsChecked", "warnings",
        ] {
            assert!(obj.contains_key(key), "missing key {key}");
        }
    }

    #[test]
    fn email_server_settings_response_keys_are_camel_case() {
        let settings = dns::EmailServerSettings {
            imap_host: Some("imap.example.com".to_string()),
            imap_port: Some(993),
            smtp_host: Some("smtp.example.com".to_string()),
            smtp_port: Some(587),
            source: "mx".to_string(),
            provider: Some("hostinger".to_string()),
        };
        let v = serde_json::to_value(&settings).unwrap();
        let obj = v.as_object().unwrap();
        for key in ["imapHost", "imapPort", "smtpHost", "smtpPort", "source", "provider"] {
            assert!(obj.contains_key(key), "missing key {key}");
        }
    }
}
