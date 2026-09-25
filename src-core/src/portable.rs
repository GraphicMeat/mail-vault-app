//! Portable mode's files: the sealed credential store on the drive.
//!
//! A portable copy writes nothing secret to the host. Account passwords,
//! OAuth tokens and the AI endpoint key live in `<root>/data/credentials.sealed`,
//! the `.mvtransfer` container (`transfer::crypto`: argon2id + XChaCha20-Poly1305)
//! around one JSON object, sealed with a passphrase the user types once per launch.

use crate::transfer::crypto::{self, Params, TransferError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use zeroize::Zeroizing;

pub const SEALED_FILE: &str = "credentials.sealed";
/// Wrong passphrase or a modified file; deliberately one answer for both.
pub const E_PASSPHRASE: &str = "E_PORTABLE_PASSPHRASE";

/// What the host keychain holds in an installed copy.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    /// `{ accountId: JSON-string-of-account }`, the keychain blob's shape.
    pub credentials: HashMap<String, String>,
    #[serde(default)]
    pub ai_endpoint_key: Option<String>,
}

/// Seal `secrets` into `path`, whole or not at all (temp file + rename).
pub fn write_sealed(path: &Path, passphrase: &str, secrets: &Secrets, params: Params) -> Result<(), String> {
    let plain = Zeroizing::new(serde_json::to_vec(secrets).map_err(|e| e.to_string())?);
    let sealed = crypto::encrypt_with(passphrase, &plain, params).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("sealed-writing");
    std::fs::write(&tmp, sealed).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

pub fn read_sealed(path: &Path, passphrase: &str) -> Result<Secrets, String> {
    let data = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let plain = Zeroizing::new(crypto::decrypt(passphrase, &data).map_err(|e| match e {
        TransferError::Decrypt => E_PASSPHRASE.to_string(),
        other => other.to_string(),
    })?);
    serde_json::from_slice(&plain).map_err(|e| format!("sealed store unreadable: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::crypto::{Params, MIN_M_KIB};

    const CHEAP: Params = Params { m_kib: MIN_M_KIB, t: 1, p: 1 };

    fn secrets() -> Secrets {
        let mut credentials = std::collections::HashMap::new();
        credentials.insert("acct-1".to_string(), r#"{"email":"a@example.com","password":"hunter2"}"#.to_string());
        Secrets { credentials, ai_endpoint_key: Some("sk-1".to_string()) }
    }

    #[test]
    fn a_sealed_store_reads_back_with_its_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SEALED_FILE);
        write_sealed(&path, "correct horse", &secrets(), CHEAP).unwrap();
        assert_eq!(read_sealed(&path, "correct horse").unwrap(), secrets());
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from(SEALED_FILE)], "no temp file left behind");
    }

    #[test]
    fn the_file_holds_no_secret_in_the_clear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SEALED_FILE);
        write_sealed(&path, "correct horse", &secrets(), CHEAP).unwrap();
        let raw = std::fs::read(&path).unwrap();
        for needle in [&b"hunter2"[..], b"a@example.com", b"sk-1"] {
            assert!(!raw.windows(needle.len()).any(|w| w == needle));
        }
    }

    #[test]
    fn a_wrong_passphrase_is_refused_with_its_own_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SEALED_FILE);
        write_sealed(&path, "correct horse", &secrets(), CHEAP).unwrap();
        let err = read_sealed(&path, "wrong horse").unwrap_err();
        assert!(err.starts_with(E_PASSPHRASE), "{err}");
    }

    #[test]
    fn a_tampered_store_is_refused_like_a_wrong_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SEALED_FILE);
        write_sealed(&path, "correct horse", &secrets(), CHEAP).unwrap();
        let mut raw = std::fs::read(&path).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        std::fs::write(&path, raw).unwrap();
        assert!(read_sealed(&path, "correct horse").unwrap_err().starts_with(E_PASSPHRASE));
    }

    #[test]
    fn a_missing_store_is_not_a_wrong_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_sealed(&dir.path().join(SEALED_FILE), "correct horse").unwrap_err();
        assert!(!err.starts_with(E_PASSPHRASE), "{err}");
    }
}
