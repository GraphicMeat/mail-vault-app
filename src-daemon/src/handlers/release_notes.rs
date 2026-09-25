//! `app.release_notes`: what the releases between the installed and the
//! offered version say, for the update dialog. Sparkle's appcast carries no
//! notes, so on macOS these are the only ones the dialog has.
//!
//! Best effort by design: offline, rate-limited or slow, the answer is `[]`
//! and the dialog keeps whatever notes the update feed carried.
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::update_track::{release_notes_between, GithubRelease};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

const RELEASES_URL: &str = "https://api.github.com/repos/GraphicMeat/mail-vault-app/releases?per_page=30";

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if method != "app.release_notes" {
        return None;
    }
    let fetched = if state.net.is_online() { fetch().await } else { Err("offline".into()) };
    Some(RpcResponse::success(id, answer(params, fetched)))
}

async fn fetch() -> Result<Vec<GithubRelease>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        // GitHub refuses API requests without a User-Agent.
        .user_agent(concat!("MailVault/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    client
        .get(RELEASES_URL)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

fn answer(params: &Value, fetched: Result<Vec<GithubRelease>, String>) -> Value {
    let releases = match fetched {
        Ok(releases) => releases,
        Err(e) => {
            tracing::warn!("[release-notes] {e}");
            return Value::Array(Vec::new());
        }
    };
    let text = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or_default();
    let include_prereleases = params.get("includePrereleases").and_then(Value::as_bool).unwrap_or(false);
    serde_json::to_value(release_notes_between(releases, text("from"), text("to"), include_prereleases))
        .unwrap_or_else(|_| Value::Array(Vec::new()))
}

#[cfg(test)]
mod tests {
    use crate::server::DaemonState;
    use mailvault_core::update_track::GithubRelease;
    use serde_json::json;
    use std::path::PathBuf;

    fn release(tag: &str) -> GithubRelease {
        serde_json::from_value(json!({
            "tag_name": tag, "name": format!("MailVault {tag}"), "draft": false, "prerelease": false,
            "published_at": "2026-09-25T13:45:06Z", "body": "### Fixed\n- **Fixed.** it",
        }))
        .unwrap()
    }

    #[test]
    fn answers_the_releases_between_the_two_versions() {
        let fetched = Ok(vec![release("v2.14.0"), release("v2.15.0"), release("v2.16.0")]);
        let out = super::answer(&json!({ "from": "2.14.0", "to": "2.16.0", "includePrereleases": false }), fetched);
        let versions: Vec<_> = out.as_array().unwrap().iter().map(|r| r["version"].clone()).collect();
        assert_eq!(versions, [json!("2.16.0"), json!("2.15.0")]);
        assert_eq!(out[0]["body"], json!("### Fixed\n- **Fixed.** it"));
    }

    #[test]
    fn a_failed_fetch_answers_an_empty_list_not_an_error() {
        let out = super::answer(&json!({ "from": "2.14.0", "to": "2.16.0" }), Err("timed out".into()));
        assert_eq!(out, json!([]));
    }

    #[test]
    fn missing_versions_answer_an_empty_list() {
        assert_eq!(super::answer(&json!({}), Ok(vec![release("v2.16.0")])), json!([]));
    }

    #[tokio::test]
    async fn leaves_every_other_method_to_the_next_router() {
        let dir: PathBuf = std::env::temp_dir().join(format!("mv-rn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        assert!(super::route(&state, "views.list", &json!({}), json!(1)).await.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
