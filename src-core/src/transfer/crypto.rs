//! `.mvtransfer` container: argon2id(password) -> XChaCha20-Poly1305.
//!
//! Layout: MAGIC(6) | version u8 | m_kib u32le | t u32le | p u32le |
//! salt[16] | nonce[24] | ciphertext+tag. Every header byte is AAD, so a
//! flipped parameter fails authentication like a wrong password does.
use argon2::{Algorithm, Argon2, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 6] = b"MVXFER";
pub const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
pub const HEADER_LEN: usize = 6 + 1 + 12 + SALT_LEN + NONCE_LEN;
pub const MIN_M_KIB: u32 = 8 * 1024;
pub const MAX_M_KIB: u32 = 1024 * 1024;
const MAX_T: u32 = 16;
const MAX_P: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

pub const EXPORT_PARAMS: Params = Params { m_kib: 65536, t: 3, p: 1 };

#[derive(Debug)]
pub enum TransferError {
    /// Wrong password or a modified file; deliberately indistinguishable.
    Decrypt,
    Format(String),
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransferError::Decrypt => write!(f, "E_TRANSFER_DECRYPT"),
            TransferError::Format(d) => write!(f, "E_TRANSFER_FORMAT: {d}"),
        }
    }
}

impl std::error::Error for TransferError {}

fn derive_key(password: &str, salt: &[u8], p: Params) -> Result<Zeroizing<[u8; 32]>, TransferError> {
    let params = argon2::Params::new(p.m_kib, p.t, p.p, Some(32)).map_err(|e| TransferError::Format(e.to_string()))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|e| TransferError::Format(e.to_string()))?;
    Ok(key)
}

pub fn encrypt(password: &str, plaintext: &[u8]) -> Result<Vec<u8>, TransferError> {
    encrypt_with(password, plaintext, EXPORT_PARAMS)
}

pub(crate) fn encrypt_with(password: &str, plaintext: &[u8], p: Params) -> Result<Vec<u8>, TransferError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut salt);
    rand::rng().fill_bytes(&mut nonce);

    let mut out = Vec::with_capacity(HEADER_LEN + plaintext.len() + 16);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&p.m_kib.to_le_bytes());
    out.extend_from_slice(&p.t.to_le_bytes());
    out.extend_from_slice(&p.p.to_le_bytes());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);

    let key = derive_key(password, &salt, p)?;
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let body = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: &out })
        .map_err(|_| TransferError::Format("encryption failed".into()))?;
    out.extend_from_slice(&body);
    Ok(out)
}

pub fn decrypt(password: &str, data: &[u8]) -> Result<Vec<u8>, TransferError> {
    if data.len() < HEADER_LEN + 16 {
        return Err(TransferError::Format("file too short".into()));
    }
    if &data[..6] != MAGIC {
        return Err(TransferError::Format("not a MailVault transfer file".into()));
    }
    if data[6] != VERSION {
        return Err(TransferError::Format(format!("unsupported version {}", data[6])));
    }
    let u32_at = |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    let p = Params { m_kib: u32_at(7), t: u32_at(11), p: u32_at(15) };
    // A hostile file must not be able to make us allocate gigabytes.
    if !(MIN_M_KIB..=MAX_M_KIB).contains(&p.m_kib) || !(1..=MAX_T).contains(&p.t) || !(1..=MAX_P).contains(&p.p) {
        return Err(TransferError::Format("key derivation parameters out of range".into()));
    }
    let salt = &data[19..19 + SALT_LEN];
    let nonce = &data[19 + SALT_LEN..HEADER_LEN];
    let key = derive_key(password, salt, p)?;
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: &data[HEADER_LEN..], aad: &data[..HEADER_LEN] })
        .map_err(|_| TransferError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cheap params keep tests fast; the header carries them, decrypt reads them.
    fn enc(pw: &str, msg: &[u8]) -> Vec<u8> {
        encrypt_with(pw, msg, Params { m_kib: MIN_M_KIB, t: 1, p: 1 }).unwrap()
    }

    #[test]
    fn roundtrip() {
        let data = enc("correct horse battery", b"{\"a\":1}");
        assert_eq!(&data[..6], MAGIC);
        assert_eq!(decrypt("correct horse battery", &data).unwrap(), b"{\"a\":1}");
    }

    #[test]
    fn wrong_password_is_generic_error() {
        let data = enc("correct horse battery", b"x");
        let err = decrypt("wrong horse battery!", &data).unwrap_err();
        assert!(matches!(err, TransferError::Decrypt));
        assert_eq!(err.to_string(), "E_TRANSFER_DECRYPT");
    }

    #[test]
    fn tampered_header_or_body_fails_like_wrong_password() {
        let data = enc("pw-pw-pw-pw-pw", b"secret");
        // salt byte (header is AAD), and last body byte
        for idx in [HEADER_LEN - 30, data.len() - 1] {
            let mut bad = data.clone();
            bad[idx] ^= 1;
            assert!(matches!(decrypt("pw-pw-pw-pw-pw", &bad), Err(TransferError::Decrypt)), "idx {idx}");
        }
    }

    #[test]
    fn bad_magic_version_and_short_input_are_format_errors() {
        let data = enc("pw-pw-pw-pw-pw", b"x");
        let mut m = data.clone();
        m[0] = b'X';
        assert!(matches!(decrypt("pw-pw-pw-pw-pw", &m), Err(TransferError::Format(_))));
        let mut v = data.clone();
        v[6] = 99;
        assert!(matches!(decrypt("pw-pw-pw-pw-pw", &v), Err(TransferError::Format(_))));
        assert!(matches!(decrypt("pw-pw-pw-pw-pw", &data[..10]), Err(TransferError::Format(_))));
    }

    #[test]
    fn hostile_kdf_params_rejected_before_derivation() {
        let data = enc("pw-pw-pw-pw-pw", b"x");
        let mut huge = data.clone();
        huge[7..11].copy_from_slice(&(MAX_M_KIB + 1).to_le_bytes());
        assert!(matches!(decrypt("pw-pw-pw-pw-pw", &huge), Err(TransferError::Format(_))));
        let mut t0 = data.clone();
        t0[11..15].copy_from_slice(&0u32.to_le_bytes());
        assert!(matches!(decrypt("pw-pw-pw-pw-pw", &t0), Err(TransferError::Format(_))));
    }

    #[test]
    fn export_default_params_are_the_spec_values() {
        assert_eq!(EXPORT_PARAMS, Params { m_kib: 65536, t: 3, p: 1 });
    }
}
