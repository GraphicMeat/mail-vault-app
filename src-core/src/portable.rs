//! Portable mode's files: the sealed credential store on the drive.

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
