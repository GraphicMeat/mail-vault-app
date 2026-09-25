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
