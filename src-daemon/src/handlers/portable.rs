//! Portable mode RPCs (`portable.*`).

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st() -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-portable-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, true)
    }

    /// Registration guard: an unwired module answers "Unknown method".
    #[tokio::test]
    async fn the_routes_are_reachable_through_the_servers_dispatch() {
        let s = st();
        for method in [
            "portable.status",
            "portable.unlock",
            "portable.lock",
            "portable.change_passphrase",
            "portable.get_credentials",
            "portable.set_credentials",
        ] {
            let resp = crate::server::handle_request_for_test(&s, method, json!({})).await;
            if let Some(err) = &resp.error {
                assert!(!err.message.contains("Unknown method"), "{method} is not routed: {err:?}");
            }
        }
    }

    /// The test binary is not beside a `MailVault Data` folder: an installed copy.
    #[tokio::test]
    async fn an_installed_copy_reports_not_portable_and_refuses_the_store_calls() {
        let s = st();
        let status = route(&s, "portable.status", &json!({}), json!(1)).await.unwrap();
        assert_eq!(status.result.unwrap()["portable"], json!(false));
        for method in ["portable.unlock", "portable.set_credentials", "portable.change_passphrase"] {
            let resp = route(&s, method, &json!({"passphrase": "x", "credentials": {}, "old": "x", "new": "y"}), json!(1)).await.unwrap();
            assert!(resp.error.unwrap().message.starts_with(E_PORTABLE_OFF), "{method}");
        }
    }

    #[tokio::test]
    async fn get_credentials_while_locked_is_unavailable_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::credentials::SealedStore::new(
            dir.path().join("credentials.sealed"),
            mailvault_core::transfer::crypto::Params { m_kib: mailvault_core::transfer::crypto::MIN_M_KIB, t: 1, p: 1 },
        );
        // "empty" would let the app save a fresh blob over every account.
        assert_eq!(credentials_reply(&store)["status"], json!("unavailable"));
        store.unlock("drive passphrase").unwrap();
        assert_eq!(credentials_reply(&store)["status"], json!("empty"));
    }
}
