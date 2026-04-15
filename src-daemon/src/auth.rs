use rand::Rng;
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Length of the raw token in bytes (256-bit).
const TOKEN_BYTES: usize = 32;

/// Returns the path to the daemon token file.
pub fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("daemon.token")
}

/// Generate a fresh random token, write it to disk with restrictive permissions,
/// and return the hex-encoded string.
pub fn generate_token(data_dir: &Path) -> io::Result<String> {
    fs::create_dir_all(data_dir)?;

    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill(&mut bytes);
    let token = hex::encode(&bytes);

    let path = token_path(data_dir);
    fs::write(&path, token.as_bytes())?;

    // chmod 0600 — owner read/write only
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }

    // Also restrict the data directory itself
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))?;
    }

    info!("Generated new daemon token at {:?}", path);
    Ok(token)
}

/// Read the existing token from disk, or generate a new one if missing/unreadable.
pub fn load_or_generate_token(data_dir: &Path) -> io::Result<String> {
    load_or_generate_token_at(&token_path(data_dir))
}

/// Read the existing token from a specific path, or generate a new one.
pub fn load_or_generate_token_at(path: &Path) -> io::Result<String> {
    match fs::read_to_string(path) {
        Ok(token) if token.len() == TOKEN_BYTES * 2 => {
            info!("Loaded existing daemon token from {:?}", path);
            Ok(token)
        }
        Ok(_) => {
            warn!("Token file exists but has invalid length, regenerating at {:?}", path);
            generate_token_at(path)
        }
        Err(_) => generate_token_at(path),
    }
}

/// Generate a fresh random token at a specific path.
fn generate_token_at(path: &Path) -> io::Result<String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill(&mut bytes);
    let token = hex::encode(&bytes);
    fs::write(path, token.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    info!("Generated new daemon token at {:?}", path);
    Ok(token)
}

/// Constant-time comparison to prevent timing attacks on token validation.
pub fn validate_token(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    let expected_hash = Sha256::digest(expected.as_bytes());
    let provided_hash = Sha256::digest(provided.as_bytes());
    expected_hash == provided_hash
}

/// Encode raw bytes to hex string.
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_generate_and_load_token() {
        let dir = std::env::temp_dir().join("mailvault-test-auth");
        let _ = fs::remove_dir_all(&dir);

        let token1 = generate_token(&dir).unwrap();
        assert_eq!(token1.len(), TOKEN_BYTES * 2);

        let token2 = load_or_generate_token(&dir).unwrap();
        assert_eq!(token1, token2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_token() {
        assert!(validate_token("abc123", "abc123"));
        assert!(!validate_token("abc123", "abc124"));
        assert!(!validate_token("abc123", "abc12"));
    }

    #[cfg(unix)]
    #[test]
    fn test_token_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("mailvault-test-auth-perms");
        let _ = fs::remove_dir_all(&dir);

        generate_token(&dir).unwrap();

        let meta = fs::metadata(token_path(&dir)).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);

        let dir_meta = fs::metadata(&dir).unwrap();
        assert_eq!(dir_meta.permissions().mode() & 0o777, 0o700);

        let _ = fs::remove_dir_all(&dir);
    }
}
