//! OpenPGP: key management RPCs (`pgp.*`) and `render`, the decrypt-on-read
//! hook the vault reads (`maildir_read`, `maildir_read_light`) and the server
//! fetch (`imap_get_email_light`) run a message's bytes through. The
//! decryption itself is `mailvault_core::pgp`; this layer brings the keys
//! from the keychain, keeps the decrypted copy in the vault under the
//! mailbox's write lock, and has the search index re-read that message.
//!
//! Skipped on purpose: encrypting or signing outgoing mail, signature
//! verification, public key directory lookups, S/MIME.
use crate::credentials;
use crate::handlers::common::{str_arg, vault_root, with_mailbox_write};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::pgp::{self as core_pgp, KeyInfo, StoredKey};
use mailvault_core::vault_files::cur_path;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{info, warn};

/// The reader's badge: the body came from decryption.
pub(crate) const DECRYPTED: &str = "decrypted";
/// Encrypted, and no imported key opens it: the reader shows a notice
/// instead of ciphertext.
pub(crate) const LOCKED: &str = "locked";

/// The bytes a reader renders for `raw`, and its badge (`None`: not
/// encrypted). `in_vault`: the vault holds `raw` as `uid`, so an existing
/// decrypted copy is used and a first decryption is kept. Blocking (a
/// keychain read, a file write): run it on a blocking thread.
pub(crate) fn render(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32, raw: Vec<u8>, in_vault: bool) -> (Vec<u8>, Option<&'static str>) {
    if !core_pgp::is_encrypted(&raw) {
        return (raw, None);
    }
    let cur = vault_root(state).ok().map(|root| cur_path(&root, account_id, mailbox));
    if in_vault {
        if let Some(copy) = cur.as_deref().and_then(|c| core_pgp::read_copy(c, uid, &raw)) {
            return (copy, Some(DECRYPTED));
        }
    }
    let keys = tokio::runtime::Handle::current().block_on(credentials::resolve_pgp_keys_guarded()).unwrap_or_else(|e| {
        warn!("[pgp] keys unavailable: {e}");
        Vec::new()
    });
    let decrypted = match core_pgp::decrypt(&raw, &keys) {
        Ok(bytes) => bytes,
        Err(e) => {
            info!("[pgp] uid {uid} in {mailbox} stays encrypted: {e}");
            return (raw, Some(LOCKED));
        }
    };
    if in_vault {
        let kept = with_mailbox_write(state, account_id, mailbox, |root| {
            core_pgp::write_copy(&cur_path(root, account_id, mailbox), uid, &decrypted)
        });
        match kept {
            // Size and mtime of the original did not change, so the sweep
            // would never notice the copy on its own.
            Ok(()) => {
                let vault_dir = mailvault_core::search_index::text::vault_dir_name(mailbox);
                if let Err(e) = mailvault_core::search_index::reconcile::forget_file(&state.search_index.db, account_id, &vault_dir, uid) {
                    warn!("[pgp] index not told about uid {uid}'s decrypted copy: {e}");
                }
                crate::search_index::nudge(&state.search_index, account_id, mailbox);
            }
            Err(e) => warn!("[pgp] could not keep the decrypted copy of uid {uid}: {e}"),
        }
    }
    (decrypted, Some(DECRYPTED))
}

/// `email` (a serialized email) with the reader's badge, `pgp`.
pub(crate) fn badge(email: &mut Value, status: Option<&'static str>) {
    if let (Some(status), Some(obj)) = (status, email.as_object_mut()) {
        obj.insert("pgp".to_string(), json!(status));
    }
}

/// A server-fetched light email (parsed from the ciphertext) with the badge,
/// and, once decrypted, the body and attachment list parsed from `bytes`.
pub(crate) fn overlay(email: &mut Value, bytes: &[u8], uid: u32, status: Option<&'static str>) {
    if status == Some(DECRYPTED) {
        if let (Ok(parsed), Some(obj)) = (mailvault_core::vault_eml::parse_eml_bytes_light(bytes, uid, Vec::new()), email.as_object_mut()) {
            let parsed = json!(parsed);
            for key in ["text", "html", "attachments", "hasAttachments"] {
                obj.insert(key.to_string(), parsed[key].clone());
            }
        }
    }
    badge(email, status);
}

fn infos(keys: &[StoredKey]) -> Vec<KeyInfo> {
    keys.iter().filter_map(|k| core_pgp::key_info(&k.armored).ok()).collect()
}

pub(crate) async fn route(_state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("pgp.") {
        return None;
    }
    let reply = |r: Result<Vec<StoredKey>, String>| match r {
        Ok(keys) => RpcResponse::success(id.clone(), json!({ "keys": infos(&keys) })),
        Err(e) => RpcResponse::error(id.clone(), ipc::INTERNAL_ERROR, e),
    };
    Some(match method {
        "pgp.list_keys" => reply(credentials::resolve_pgp_keys_guarded().await),
        "pgp.import_key" => {
            let armored = match str_arg(&id, params, "armored") {
                Ok(v) => v,
                Err(resp) => return Some(resp),
            };
            let passphrase = params.get("passphrase").and_then(Value::as_str).unwrap_or_default().to_string();
            let stored = StoredKey { armored: armored.trim().to_string(), passphrase };
            let info = match core_pgp::validate(&stored) {
                Ok(info) => info,
                Err(e) => return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, e)),
            };
            reply(
                credentials::update_pgp_keys(move |keys| {
                    // Re-importing a key replaces it (a new passphrase, say).
                    keys.retain(|k| core_pgp::key_info(&k.armored).map_or(true, |i| i.fingerprint != info.fingerprint));
                    keys.push(stored);
                    Ok(())
                })
                .await,
            )
        }
        "pgp.remove_key" => {
            let fingerprint = match str_arg(&id, params, "fingerprint") {
                Ok(v) => v,
                Err(resp) => return Some(resp),
            };
            reply(
                credentials::update_pgp_keys(move |keys| {
                    keys.retain(|k| core_pgp::key_info(&k.armored).map_or(true, |i| i.fingerprint != fingerprint));
                    Ok(())
                })
                .await,
            )
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use crate::server::{handle_request_for_test, DaemonState};
    use mailvault_core::search_index::plan::Signal;
    use mailvault_core::vault_files;
    use pgp::composed::{ArmorOptions, EncryptionCaps, KeyType, MessageBuilder, SecretKeyParamsBuilder, SignedSecretKey, SubkeyParamsBuilder};
    use pgp::crypto::{ecc_curve::ECCCurve, sym::SymmetricKeyAlgorithm};
    use serde_json::{json, Value};
    use std::sync::Arc;

    /// A TEST-ONLY keypair: Ed25519 primary, Curve25519 encryption subkey.
    fn keypair(passphrase: Option<&str>) -> SignedSecretKey {
        let mut rng = rand08::thread_rng();
        let sub = SubkeyParamsBuilder::default()
            .key_type(KeyType::ECDH(ECCCurve::Curve25519Legacy))
            .can_encrypt(EncryptionCaps::All)
            .passphrase(passphrase.map(str::to_string))
            .build()
            .unwrap();
        SecretKeyParamsBuilder::default()
            .key_type(KeyType::Ed25519Legacy)
            .can_certify(true)
            .can_sign(true)
            .primary_user_id("Bob <bob@x.test>".into())
            .passphrase(passphrase.map(str::to_string))
            .subkeys(vec![sub])
            .build()
            .unwrap()
            .generate(&mut rng)
            .unwrap()
    }

    fn armored(key: &SignedSecretKey) -> String {
        key.to_armored_string(ArmorOptions::default()).unwrap()
    }

    fn encrypted_eml(to: &SignedSecretKey) -> Vec<u8> {
        let mut rng = rand08::thread_rng();
        let inner = b"Content-Type: text/html; charset=utf-8\r\n\r\n<p>The code is <b>4242</b></p>\r\n".to_vec();
        let mut builder = MessageBuilder::from_bytes("", inner).seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
        builder.encrypt_to_key(&mut rng, to.secret_subkeys[0].key.public_key()).unwrap();
        let body = builder.to_armored_string(&mut rng, ArmorOptions::default()).unwrap();
        format!(
            "From: Ann <ann@x.test>\r\nSubject: Sealed\r\nMIME-Version: 1.0\r\n\
             Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"b\"\r\n\r\n\
             --b\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n\
             --b\r\nContent-Type: application/octet-stream\r\n\r\n{body}\r\n--b--\r\n"
        )
        .into_bytes()
    }

    fn st() -> (tempfile::TempDir, Arc<DaemonState>) {
        let tmp = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap().keep();
        let s = DaemonState::for_test(tmp.path().to_path_buf(), app_dir, true);
        (tmp, s)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> Result<Value, String> {
        let r = handle_request_for_test(s, method, params).await;
        r.result.ok_or_else(|| r.error.map(|e| e.message).unwrap_or_default())
    }

    #[tokio::test]
    async fn keys_import_list_and_remove_through_the_daemon() {
        let _guard = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let keys_file = tempfile::tempdir().unwrap();
        std::env::set_var("MAILVAULT_TEST_PGP_KEYS", keys_file.path().join("keys.json"));
        let (_t, s) = st();
        let key = keypair(Some("pw"));

        assert_eq!(call(&s, "pgp.list_keys", json!({})).await.unwrap(), json!({"keys": []}));
        let err = call(&s, "pgp.import_key", json!({"armored": armored(&key), "passphrase": "nope"})).await.unwrap_err();
        assert!(err.contains("passphrase"), "{err}");
        assert!(call(&s, "pgp.import_key", json!({"armored": "not a key"})).await.is_err());

        let listed = call(&s, "pgp.import_key", json!({"armored": armored(&key), "passphrase": "pw"})).await.unwrap();
        let fp = listed["keys"][0]["fingerprint"].as_str().unwrap().to_string();
        assert_eq!(listed["keys"][0]["userIds"], json!(["Bob <bob@x.test>"]));
        // Importing it again replaces it instead of listing it twice.
        let again = call(&s, "pgp.import_key", json!({"armored": armored(&key), "passphrase": "pw"})).await.unwrap();
        assert_eq!(again["keys"].as_array().unwrap().len(), 1);
        assert_eq!(call(&s, "pgp.list_keys", json!({})).await.unwrap()["keys"][0]["fingerprint"], json!(fp));

        let removed = call(&s, "pgp.remove_key", json!({"fingerprint": fp})).await.unwrap();
        assert_eq!(removed, json!({"keys": []}));
        std::env::remove_var("MAILVAULT_TEST_PGP_KEYS");
    }

    #[tokio::test]
    async fn an_encrypted_vault_message_reads_decrypted_and_keeps_a_copy_the_next_read_uses() {
        use base64::Engine;
        let _guard = crate::credentials::test_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let keys_file = tempfile::tempdir().unwrap();
        let keys_path = keys_file.path().join("keys.json");
        std::env::set_var("MAILVAULT_TEST_PGP_KEYS", &keys_path);
        let (t, s) = st();
        let (tx, rx) = std::sync::mpsc::channel();
        *s.search_index.signals.lock().unwrap() = Some(tx);
        let key = keypair(None);
        let cur = vault_files::cur_path(t.path(), "acc", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let raw = encrypted_eml(&key);
        let name = vault_files::build_maildir_filename(7, &["seen".into()]);
        std::fs::write(cur.join(&name), &raw).unwrap();
        let p = json!({"accountId": "acc", "mailbox": "INBOX", "uid": 7});

        // No key yet: the reader gets the notice's status, and no copy is kept.
        let locked = call(&s, "maildir_read_light", p.clone()).await.unwrap();
        assert_eq!(locked["pgp"], json!("locked"));
        assert!(!mailvault_core::pgp::copy_path(&cur, 7).exists());

        call(&s, "pgp.import_key", json!({"armored": armored(&key)})).await.unwrap();
        let light = call(&s, "maildir_read_light", p.clone()).await.unwrap();
        assert_eq!(light["pgp"], json!("decrypted"));
        assert_eq!(light["subject"], json!("Sealed"));
        assert!(light["html"].as_str().unwrap().contains("<b>4242</b>"));
        assert!(mailvault_core::pgp::copy_path(&cur, 7).exists(), "the first decryption is kept in the vault");
        assert!(rx.try_iter().any(|sig| matches!(sig, Signal::Nudge { .. })), "the index is told to re-read the folder");
        assert_eq!(std::fs::read(cur.join(&name)).unwrap(), raw, "the encrypted original is untouched");

        // The key is gone: the copy still answers, with no key needed.
        std::fs::remove_file(&keys_path).unwrap();
        let full = call(&s, "maildir_read", p.clone()).await.unwrap();
        assert_eq!(full["pgp"], json!("decrypted"));
        assert!(full["html"].as_str().unwrap().contains("4242"));
        let source = call(&s, "maildir_read_raw_source", p).await.unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(source.as_str().unwrap()).unwrap(), raw);
        std::env::remove_var("MAILVAULT_TEST_PGP_KEYS");
    }

    #[tokio::test]
    async fn a_plain_message_carries_no_badge() {
        let (t, s) = st();
        let cur = vault_files::cur_path(t.path(), "acc", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(vault_files::build_maildir_filename(3, &[])), b"Subject: hi\r\n\r\nhello\r\n").unwrap();
        let r = call(&s, "maildir_read_light", json!({"accountId": "acc", "mailbox": "INBOX", "uid": 3})).await.unwrap();
        assert!(r.get("pgp").is_none());
        assert_eq!(r["subject"], json!("hi"));
    }
}
