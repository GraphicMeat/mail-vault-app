//! `policy.*`: what an account's download mode and daily transfer limits mean,
//! and which server mailbox a vault directory holds. The rules are
//! `mailvault_core::fetch_mode`, `transfer_limits` and
//! `search_index::text`; the app shows the answers and computes none of them.
//!
//! - `policy.accounts {accounts: [{id, imapHost}]}` answers
//!   `{accounts: {<id>: {fetch, transfer}}}`, read fresh from the settings
//!   document on every call:
//!   - `fetch`: `null` for a hidden account (nothing is kept), else
//!     `{mode, windowMonths, hoarderPremium, vaultHoldsCopies,
//!     recentWindowMonths, keep, keepSinceMs}`. `keep` is `"none"`, `"all"`
//!     or `"since"` (bodies dated at or after `keepSinceMs`, an unknown date
//!     kept): what the download-ahead fetches, `FetchPolicy::keep_bodies` as
//!     of now.
//!   - `transfer`: `transfer_limits::display_limits` (`gmail`, `capEnabled`,
//!     `warnEnabled`, `down` / `up` with `limitBytes`, `isProviderDefault`,
//!     `defaultCapOn`, `defaultCapOff`), today's usage `today {down, up}`,
//!     and the banner's `warning {direction, fraction}` or `null`.
//!   The host decides Gmail, as it does for the daemon's own limit checks,
//!   which take it from the account the app hands them.
//! - `policy.vault_mailboxes {dirs, mailboxes}` answers `{mailboxes}`, one
//!   server path per directory in `dirs`, in order: the first of `mailboxes`
//!   whose vault directory it is, else the directory itself.
//!
//! A settings document that is missing or unreadable reads as the defaults,
//! as it does for the daemon's own download gate and limit checks: the app
//! is shown what the daemon enforces.

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::fetch_mode::{FetchPolicy, KeepBodies};
use mailvault_core::settings_doc::SettingsDoc;
use mailvault_core::{search_index::text, transfer_limits, transfer_stats};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Arc;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    match method {
        "policy.accounts" => {
            let Some(accounts) = params.get("accounts").and_then(Value::as_array) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing accounts"));
            };
            let accounts: Vec<(String, String)> = accounts
                .iter()
                .filter_map(|a| {
                    let id = a.get("id").and_then(Value::as_str)?;
                    let host = a.get("imapHost").and_then(Value::as_str).unwrap_or("");
                    Some((id.to_owned(), host.to_owned()))
                })
                .collect();
            let app_dir = state.app_dir.clone();
            // A settings read and a stats read per account: a blocking thread's work.
            let joined = tokio::task::spawn_blocking(move || accounts_reply(&app_dir, &accounts, now_ms())).await;
            Some(match joined {
                Ok(reply) => RpcResponse::success(id, reply),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("policy task failed: {e}")),
            })
        }
        "policy.vault_mailboxes" => {
            let strings = |name: &str| -> Option<Vec<String>> { serde_json::from_value(params.get(name)?.clone()).ok() };
            let (Some(dirs), Some(mailboxes)) = (strings("dirs"), strings("mailboxes")) else {
                return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, "Missing dirs or mailboxes"));
            };
            Some(RpcResponse::success(id, json!({"mailboxes": text::mailboxes_from_vault_dirs(&dirs, &mailboxes)})))
        }
        _ => None,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn accounts_reply(app_dir: &Path, accounts: &[(String, String)], now_ms: i64) -> Value {
    let doc = SettingsDoc::shared(app_dir).read().ok();
    let state = doc
        .as_deref()
        .and_then(|d| d.get("mailvault-settings"))
        .and_then(|s| s.get("state"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut out = Map::new();
    for (account_id, host) in accounts {
        let fetch = FetchPolicy::from_settings(&state, account_id).map(|p| fetch_view(&p, now_ms));
        let entry = state.get("transferLimits").and_then(|t| t.get(account_id));
        let shown = transfer_limits::display_limits(entry, host);
        let today = transfer_stats::usage_today(app_dir, account_id);
        let warning = transfer_limits::warning(&shown, today);
        let mut transfer = serde_json::to_value(&shown).unwrap_or(Value::Null);
        transfer["today"] = json!({"down": today.down, "up": today.up});
        transfer["warning"] = serde_json::to_value(&warning).unwrap_or(Value::Null);
        out.insert(account_id.clone(), json!({"fetch": fetch, "transfer": transfer}));
    }
    json!({"accounts": out})
}

fn fetch_view(policy: &FetchPolicy, now_ms: i64) -> Value {
    let (keep, since) = match policy.keep_bodies(now_ms) {
        KeepBodies::None => ("none", None),
        KeepBodies::All => ("all", None),
        KeepBodies::Since(ms) => ("since", Some(ms)),
    };
    json!({
        "mode": policy.mode,
        "windowMonths": policy.window_months,
        "hoarderPremium": policy.hoarder_premium,
        "vaultHoldsCopies": policy.vault_holds_copies(),
        "recentWindowMonths": policy.recent_window_months(),
        "keep": keep,
        "keepSinceMs": since,
    })
}

#[cfg(test)]
mod tests {
    use crate::server::{handle_request_for_test, DaemonState};
    use serde_json::{json, Value};
    use std::sync::Arc;

    const MB: u64 = 1024 * 1024;

    fn rig(settings: Value) -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let blob = json!({"mailvault-settings": {"state": settings}});
        std::fs::write(dir.path().join("frontend-settings.json"), blob.to_string()).unwrap();
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        (dir, state)
    }

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> Result<Value, String> {
        let resp = handle_request_for_test(state, method, params).await;
        match resp.error {
            Some(e) => Err(e.message),
            None => Ok(resp.result.unwrap_or(Value::Null)),
        }
    }

    #[tokio::test]
    async fn accounts_answer_the_mode_and_the_limits_each_account_has() {
        let (_dir, state) = rig(json!({
            "fetchMode": "keepRecent",
            "localCacheDurationMonths": 6,
            "fetchModes": {"od": "onDemand", "h": "hoarder"},
            "hiddenAccounts": {"gone": true},
            "transferLimits": {"g": {"capEnabled": true, "dailyUpLimitBytes": 50 * MB}},
        }));
        let reply = call(&state, "policy.accounts", json!({"accounts": [
            {"id": "g", "imapHost": "imap.gmail.com"},
            {"id": "od", "imapHost": "imap.example.com"},
            {"id": "h"},
            {"id": "gone", "imapHost": "imap.gmail.com"},
        ]}))
        .await
        .unwrap();
        let a = &reply["accounts"];

        let g = &a["g"]["fetch"];
        assert_eq!(g["mode"], "keepRecent");
        assert_eq!(g["windowMonths"], 6);
        assert_eq!(g["recentWindowMonths"], 6);
        assert_eq!(g["vaultHoldsCopies"], true);
        assert_eq!(g["keep"], "since");
        assert!(g["keepSinceMs"].as_i64().unwrap() < super::now_ms());

        assert_eq!(a["od"]["fetch"]["keep"], "none");
        assert_eq!(a["od"]["fetch"]["vaultHoldsCopies"], false);
        assert_eq!(a["h"]["fetch"]["keep"], "all");
        assert_eq!(a["h"]["fetch"]["keepSinceMs"], Value::Null);
        assert_eq!(a["gone"]["fetch"], Value::Null, "a hidden account keeps nothing");

        let t = &a["g"]["transfer"];
        assert_eq!(t["gmail"], true);
        assert_eq!(t["capEnabled"], true);
        assert_eq!(t["down"]["limitBytes"], 2000 * MB);
        assert_eq!(t["down"]["isProviderDefault"], true);
        assert_eq!(t["down"]["defaultCapOff"], 2500 * MB);
        assert_eq!(t["up"]["limitBytes"], 50 * MB);
        assert_eq!(t["up"]["isProviderDefault"], false);
        assert_eq!(t["today"], json!({"down": 0, "up": 0}));
        assert_eq!(t["warning"], Value::Null);
        assert_eq!(a["od"]["transfer"]["gmail"], false);
        assert_eq!(a["od"]["transfer"]["down"]["limitBytes"], Value::Null);
    }

    #[tokio::test]
    async fn the_warning_reads_todays_usage() {
        let (dir, state) = rig(json!({"transferLimits": {"g": {"capEnabled": true, "dailyDownLimitBytes": 100 * MB}}}));
        let today = mailvault_core::transfer_limits::day_key(super::now_ms());
        mailvault_core::app_db::with(dir.path(), |c| mailvault_core::app_db::stats::add(c, "g", &today, "daemon", 90 * MB, 0)).unwrap();
        let reply = call(&state, "policy.accounts", json!({"accounts": [{"id": "g", "imapHost": "imap.gmail.com"}]})).await.unwrap();
        let t = &reply["accounts"]["g"]["transfer"];
        assert_eq!(t["today"]["down"], 90 * MB);
        assert_eq!(t["warning"]["direction"], "download");
        assert!((t["warning"]["fraction"].as_f64().unwrap() - 0.9).abs() < 1e-9);
    }

    #[tokio::test]
    async fn vault_mailboxes_map_each_directory_to_the_first_listed_path() {
        let (_dir, state) = rig(json!({}));
        let reply = call(&state, "policy.vault_mailboxes", json!({
            "dirs": ["_Gmail__Sent_Mail", "Projekt_Nystart", "Old"],
            "mailboxes": ["INBOX", "Projekt Nystart", "Projekt_Nystart", "[Gmail]/Sent Mail"],
        }))
        .await
        .unwrap();
        assert_eq!(reply["mailboxes"], json!(["[Gmail]/Sent Mail", "Projekt Nystart", "Old"]));
    }

    #[tokio::test]
    async fn no_settings_file_reads_as_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().join("mail"), dir.path().to_path_buf(), true);
        let reply = call(&state, "policy.accounts", json!({"accounts": [{"id": "a", "imapHost": "imap.gmail.com"}]})).await.unwrap();
        let a = &reply["accounts"]["a"];
        assert_eq!(a["fetch"]["mode"], "keepRecent");
        assert_eq!(a["fetch"]["windowMonths"], 3);
        assert_eq!(a["transfer"]["capEnabled"], false);
        assert_eq!(a["transfer"]["warnEnabled"], true);
        assert_eq!(a["transfer"]["down"]["limitBytes"], 2500 * MB);
    }

    #[tokio::test]
    async fn missing_params_are_refused() {
        let (_dir, state) = rig(json!({}));
        assert!(call(&state, "policy.accounts", json!({})).await.is_err());
        assert!(call(&state, "policy.vault_mailboxes", json!({"dirs": ["a"]})).await.is_err());
    }
}
