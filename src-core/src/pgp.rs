//! OpenPGP decryption of vault mail, with rPGP (pure Rust: a sandboxed Mac
//! App Store build cannot run gpg). Two shapes are read: PGP/MIME (RFC 3156,
//! `multipart/encrypted; protocol="application/pgp-encrypted"`, top level or
//! nested, as Mailman wraps it) and inline, a text/plain body that starts with
//! `-----BEGIN PGP MESSAGE-----`.
//!
//! The first successful decryption is kept next to the encrypted original as
//! `Maildir/<account>/<mailbox>/.decrypted/<uid>.eml`: the original's headers
//! with the decrypted body, plus `X-MailVault-Decrypted: <fingerprint>` and
//! `X-MailVault-Source`, a hash of the original. The name carries no `:2,`
//! info part and the folder is not `cur`, so no vault walk, count, backup,
//! export or index sweep ever takes it for a second message. The hash ties
//! the copy to the exact bytes it was made from, so a reused uid never serves
//! another message's plaintext.
//!
//! Skipped on purpose: encrypting or signing outgoing mail, signature
//! verification, public key directory lookups, S/MIME.
use std::path::{Path, PathBuf};

use mailparse::ParsedMail;
use pgp::composed::{DecryptionOptions, Deserializable, Message, SignedSecretKey, TheRing};
use pgp::types::{KeyDetails, Password};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The folder beside `cur` that holds decrypted copies.
pub const DECRYPTED_DIR: &str = ".decrypted";
const DECRYPTED_HEADER: &str = "X-MailVault-Decrypted";
const SOURCE_HEADER: &str = "X-MailVault-Source";
const ARMOR_BEGIN: &str = "-----BEGIN PGP MESSAGE-----";
const ARMOR_END: &str = "-----END PGP MESSAGE-----";

/// One imported secret key as the keychain holds it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredKey {
    pub armored: String,
    #[serde(default)]
    pub passphrase: String,
}

/// What Settings lists for a key, derived from the key itself.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub fingerprint: String,
    pub user_ids: Vec<String>,
    /// Unix seconds.
    pub created: u32,
}

fn parse_key(armored: &str) -> Result<SignedSecretKey, String> {
    SignedSecretKey::from_string(armored.trim())
        .map(|(k, _)| k)
        .map_err(|e| format!("Not an OpenPGP secret key: {e}"))
}

fn fingerprint(key: &SignedSecretKey) -> String {
    format!("{:X}", key.fingerprint())
}

fn describe(key: &SignedSecretKey) -> KeyInfo {
    KeyInfo {
        fingerprint: fingerprint(key),
        user_ids: key.details.users.iter().map(|u| String::from_utf8_lossy(u.id.id()).into_owned()).collect(),
        created: key.primary_key.created_at().as_secs(),
    }
}

/// The key's fingerprint, user ids and creation time. No passphrase needed.
pub fn key_info(armored: &str) -> Result<KeyInfo, String> {
    parse_key(armored).map(|k| describe(&k))
}

/// `key_info`, once the passphrase is proven to unlock the key: what an
/// import checks. It unlocks the encryption subkeys, not the primary: a
/// subkey-only export has a stub primary that never unlocks.
pub fn validate(stored: &StoredKey) -> Result<KeyInfo, String> {
    let key = parse_key(&stored.armored)?;
    let pw = Password::from(stored.passphrase.as_str());
    let enc: Vec<_> = key.secret_subkeys.iter().filter(|s| s.key.algorithm().can_encrypt()).collect();
    let unlocks = if enc.is_empty() {
        key.primary_key.unlock(&pw, |_, _| Ok(())).is_ok()
    } else {
        enc.iter().any(|s| s.key.unlock(&pw, |_, _| Ok(())).is_ok())
    };
    if !unlocks {
        return Err("The passphrase does not unlock this key".to_string());
    }
    Ok(describe(&key))
}

// ── Detection ────────────────────────────────────────────────────────────────

/// What a decryption replaces: the part to splice out, and what to decrypt.
enum Target<'a> {
    /// A `multipart/encrypted` part and its armored payload.
    Mime(&'a ParsedMail<'a>, Vec<u8>),
    /// The part to replace (the text part, or the `multipart/alternative`
    /// around it, whose html copy is the same ciphertext) and the text.
    Inline(&'a ParsedMail<'a>, String),
}

fn is_mime_encrypted(p: &ParsedMail) -> bool {
    p.ctype.mimetype.eq_ignore_ascii_case("multipart/encrypted")
        && p.ctype.params.get("protocol").is_some_and(|v| v.eq_ignore_ascii_case("application/pgp-encrypted"))
}

fn inline_text(p: &ParsedMail) -> Option<String> {
    if !p.subparts.is_empty() || !p.ctype.mimetype.eq_ignore_ascii_case("text/plain") {
        return None;
    }
    let body = p.get_body().ok()?;
    body.trim_start().starts_with(ARMOR_BEGIN).then_some(body)
}

fn target<'a>(p: &'a ParsedMail<'a>) -> Option<Target<'a>> {
    if is_mime_encrypted(p) {
        let payload = p.subparts.iter().find(|s| s.ctype.mimetype.eq_ignore_ascii_case("application/octet-stream"))?;
        return Some(Target::Mime(p, payload.get_body_raw().ok()?));
    }
    if let Some(text) = inline_text(p) {
        return Some(Target::Inline(p, text));
    }
    if p.ctype.mimetype.eq_ignore_ascii_case("multipart/alternative") {
        if let Some(text) = p.subparts.iter().find_map(inline_text) {
            return Some(Target::Inline(p, text));
        }
    }
    p.subparts.iter().find_map(target)
}

/// Cheap byte check before any parse: every message a vault read renders
/// goes through `is_encrypted`, and almost none of them are.
// ponytail: an inline armor block inside a base64 text part is not seen here;
// decode every text part if a real mailer turns out to send that.
fn may_be_encrypted(raw: &[u8]) -> bool {
    let has = |needle: &[u8]| raw.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle));
    has(b"application/pgp-encrypted") || has(ARMOR_BEGIN.as_bytes())
}

/// Whether `raw` is a message this module can decrypt. A plain message that
/// only quotes an armor block, or is PGP-signed, is not.
pub fn is_encrypted(raw: &[u8]) -> bool {
    may_be_encrypted(raw) && mailparse::parse_mail(raw).is_ok_and(|m| target(&m).is_some())
}

// ── Decryption ───────────────────────────────────────────────────────────────

/// The literal data of an armored OpenPGP message, and the fingerprint of the
/// first key that opens it.
fn open(armored: &[u8], keys: &[StoredKey]) -> Result<(Vec<u8>, String), String> {
    let mut last = String::from("no key imported");
    for stored in keys {
        let key = match parse_key(&stored.armored) {
            Ok(key) => key,
            Err(e) => { last = e; continue; }
        };
        let (msg, _) = Message::from_armor(armored).map_err(|e| format!("The OpenPGP message is damaged: {e}"))?;
        let pw = Password::from(stored.passphrase.as_str());
        let ring = TheRing {
            secret_keys: vec![&key],
            key_passwords: vec![&pw],
            // GnuPG 2.4+ writes its own OCB packet (type 20) by default to
            // keys it made itself; much of the mail a GnuPG user holds is in it.
            decrypt_options: DecryptionOptions::new().enable_gnupg_aead(),
            ..Default::default()
        };
        let mut msg = match msg.decrypt_the_ring(ring, true) {
            Ok((msg, _)) => msg,
            Err(e) => { last = e.to_string(); continue; }
        };
        while msg.is_compressed() {
            msg = msg.decompress().map_err(|e| format!("OpenPGP decompression failed: {e}"))?;
        }
        let data = msg.as_data_vec().map_err(|e| format!("OpenPGP decryption failed: {e}"))?;
        return Ok((data, fingerprint(&key)));
    }
    Err(format!("No imported OpenPGP key can decrypt this message ({last})"))
}

/// The header block of `message` without its Content-* headers (the
/// replacement brings its own), and without the blank line that ends it.
fn headers_without_content(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut keep = true;
    for line in message.split_inclusive(|&b| b == b'\n') {
        if line == b"\r\n" || line == b"\n" {
            break;
        }
        if !matches!(line.first(), Some(b' ' | b'\t')) {
            let name = line.split(|&b| b == b':').next().unwrap_or_default();
            keep = !String::from_utf8_lossy(name).trim().to_ascii_lowercase().starts_with("content-");
        }
        if keep {
            out.extend_from_slice(line);
        }
    }
    out
}

pub(crate) fn source_tag(original: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(original))
}

/// `raw` decrypted into a whole RFC 822 message: its own headers, the
/// decrypted body in place of the encrypted part, and the two
/// `X-MailVault-*` headers first. `Err` when `raw` is not encrypted or no key
/// opens it.
pub fn decrypt(raw: &[u8], keys: &[StoredKey]) -> Result<Vec<u8>, String> {
    let parsed = mailparse::parse_mail(raw).map_err(|e| format!("Failed to parse email: {e}"))?;
    let target = target(&parsed).ok_or("The message is not OpenPGP encrypted")?;
    let (part, entity, fp) = match target {
        Target::Mime(part, armored) => {
            let (entity, fp) = open(&armored, keys)?;
            (part, entity, fp)
        }
        Target::Inline(part, text) => {
            let start = text.find(ARMOR_BEGIN).unwrap_or(0);
            let end = text[start..].find(ARMOR_END).map(|i| start + i + ARMOR_END.len()).unwrap_or(text.len());
            let (plain, fp) = open(text[start..end].as_bytes(), keys)?;
            let body = format!("{}{}{}", &text[..start], String::from_utf8_lossy(&plain), &text[end..]);
            let entity = format!("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{body}");
            (part, entity.into_bytes(), fp)
        }
    };
    let mut replacement = Vec::new();
    // The whole message is the encrypted part: its non-Content headers stay.
    if std::ptr::eq(part.raw_bytes, parsed.raw_bytes) {
        replacement.extend(headers_without_content(raw));
    }
    replacement.extend_from_slice(&entity);
    if !replacement.ends_with(b"\n") {
        replacement.extend_from_slice(b"\r\n");
    }
    let start = part.raw_bytes.as_ptr() as usize - raw.as_ptr() as usize;
    let end = start + part.raw_bytes.len();
    let mut out = format!("{DECRYPTED_HEADER}: {fp}\r\n{SOURCE_HEADER}: {}\r\n", source_tag(raw)).into_bytes();
    out.extend_from_slice(&raw[..start]);
    out.extend(replacement);
    out.extend_from_slice(&raw[end..]);
    Ok(out)
}

// ── The decrypted copy in the vault ─────────────────────────────────────────

/// Where `uid`'s decrypted copy lives for a mailbox whose `cur` is `cur_dir`.
pub fn copy_path(cur_dir: &Path, uid: u32) -> PathBuf {
    cur_dir.parent().unwrap_or(cur_dir).join(DECRYPTED_DIR).join(format!("{uid}.eml"))
}

/// `uid`'s decrypted copy, if there is one made from exactly `original`.
pub fn read_copy(cur_dir: &Path, uid: u32, original: &[u8]) -> Option<Vec<u8>> {
    let copy = std::fs::read(copy_path(cur_dir, uid)).ok()?;
    let (headers, _) = mailparse::parse_headers(&copy).ok()?;
    let source = headers.iter().find(|h| h.get_key().eq_ignore_ascii_case(SOURCE_HEADER))?.get_value();
    (source.trim() == source_tag(original)).then_some(copy)
}

pub fn write_copy(cur_dir: &Path, uid: u32, decrypted: &[u8]) -> Result<(), String> {
    let path = copy_path(cur_dir, uid);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    }
    crate::fsx::write_atomic(&path, decrypted).map_err(|e| format!("Failed to write the decrypted copy: {e}"))
}

/// Remove `uid`'s decrypted copy along with its original: plaintext must not
/// outlive the message.
pub fn remove_copy(cur_dir: &Path, uid: u32) {
    let _ = std::fs::remove_file(copy_path(cur_dir, uid));
}

/// What a reader parses for `raw`: its decrypted copy when it is encrypted
/// and one exists, else `raw` itself. Needs no key.
pub fn readable(cur_dir: &Path, uid: u32, raw: Vec<u8>) -> Vec<u8> {
    if !may_be_encrypted(&raw) {
        return raw;
    }
    read_copy(cur_dir, uid, &raw).unwrap_or(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pgp::composed::{
        ArmorOptions, EncryptionCaps, KeyType, MessageBuilder, SecretKeyParamsBuilder, SubkeyParamsBuilder,
    };
    use pgp::crypto::{ecc_curve::ECCCurve, sym::SymmetricKeyAlgorithm};

    /// A TEST-ONLY keypair: Ed25519 primary, Curve25519 encryption subkey.
    fn keypair(user: &str, passphrase: Option<&str>) -> SignedSecretKey {
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
            .primary_user_id(user.into())
            .passphrase(passphrase.map(str::to_string))
            .subkeys(vec![sub])
            .build()
            .unwrap()
            .generate(&mut rng)
            .unwrap()
    }

    fn stored(key: &SignedSecretKey, passphrase: &str) -> StoredKey {
        StoredKey { armored: key.to_armored_string(ArmorOptions::default()).unwrap(), passphrase: passphrase.into() }
    }

    fn encrypt(to: &SignedSecretKey, plain: &[u8]) -> String {
        let mut rng = rand08::thread_rng();
        let mut builder = MessageBuilder::from_bytes("", plain.to_vec()).seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
        builder.encrypt_to_key(&mut rng, to.secret_subkeys[0].key.public_key()).unwrap();
        builder.to_armored_string(&mut rng, ArmorOptions::default()).unwrap()
    }

    const INNER: &str = "Content-Type: multipart/alternative; boundary=\"in\"\r\n\r\n--in\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThe launch code is 4242.\r\n--in\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>The launch code is <b>4242</b>.</p>\r\n--in--\r\n";

    fn pgp_mime(armored: &str) -> Vec<u8> {
        format!(
            "From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Secret plans\r\nMessage-ID: <m1@x.test>\r\nMIME-Version: 1.0\r\n\
             Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"b1\"\r\n\r\n\
             --b1\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n\
             --b1\r\nContent-Type: application/octet-stream; name=\"encrypted.asc\"\r\n\r\n{armored}\r\n--b1--\r\n"
        )
        .into_bytes()
    }

    fn inline(armored: &str) -> Vec<u8> {
        format!("From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Inline\r\nContent-Type: text/plain\r\n\r\n{armored}\r\n").into_bytes()
    }

    #[test]
    fn pgp_mime_decrypts_to_a_message_whose_parts_parse_normally() {
        let key = keypair("Bob <bob@x.test>", None);
        let raw = pgp_mime(&encrypt(&key, INNER.as_bytes()));
        assert!(is_encrypted(&raw));
        let out = decrypt(&raw, &[stored(&key, "")]).unwrap();
        let email = crate::vault_eml::parse_eml_bytes(&out, 7, vec![]).unwrap();
        assert_eq!(email.subject, "Secret plans");
        assert_eq!(email.message_id.as_deref(), Some("<m1@x.test>"));
        assert!(email.text.unwrap().contains("launch code is 4242"));
        assert!(email.html.unwrap().contains("<b>4242</b>"));
        let text = String::from_utf8_lossy(&out);
        assert!(text.starts_with(&format!("{DECRYPTED_HEADER}: {}\r\n", fingerprint(&key))), "{text}");
        assert!(!text.contains("multipart/encrypted"));
    }

    #[test]
    fn pgp_mime_nested_in_a_mailing_list_wrapper_decrypts_in_place() {
        let key = keypair("Bob <bob@x.test>", None);
        let enc = String::from_utf8(pgp_mime(&encrypt(&key, INNER.as_bytes()))).unwrap();
        let part = &enc[enc.find("Content-Type: multipart/encrypted").unwrap()..];
        let raw = format!(
            "From: list@x.test\r\nSubject: [list] Secret\r\nContent-Type: multipart/mixed; boundary=\"outer\"\r\n\r\n\
             --outer\r\n{part}\r\n--outer\r\nContent-Type: text/plain\r\n\r\nList footer\r\n--outer--\r\n"
        );
        let out = decrypt(raw.as_bytes(), &[stored(&key, "")]).unwrap();
        let email = crate::vault_eml::parse_eml_bytes(&out, 1, vec![]).unwrap();
        assert!(email.html.unwrap().contains("4242"));
        assert!(String::from_utf8_lossy(&out).contains("List footer"));
    }

    #[test]
    fn inline_decrypts_the_text_body() {
        let key = keypair("Bob <bob@x.test>", None);
        let raw = inline(&encrypt(&key, "Meet at noon. Ąčę.".as_bytes()));
        assert!(is_encrypted(&raw));
        let out = decrypt(&raw, &[stored(&key, "")]).unwrap();
        let email = crate::vault_eml::parse_eml_bytes(&out, 1, vec![]).unwrap();
        assert_eq!(email.subject, "Inline");
        assert_eq!(email.text.unwrap().trim(), "Meet at noon. Ąčę.");
    }

    /// Real GnuPG output (2.5, whose default is its own OCB packet), not only
    /// what rPGP writes itself. Both files are TEST ONLY.
    #[test]
    fn a_gnupg_encrypted_message_opens_with_the_gnupg_exported_key() {
        let key = include_str!("../tests/fixtures/pgp-TEST-ONLY-key.asc");
        let armored = include_str!("../tests/fixtures/pgp-TEST-ONLY-message.asc");
        let raw = pgp_mime(armored);
        let out = decrypt(&raw, &[StoredKey { armored: key.into(), passphrase: String::new() }]).unwrap();
        let email = crate::vault_eml::parse_eml_bytes(&out, 1, vec![]).unwrap();
        assert!(email.text.unwrap().contains("The vault combination is 7 3 9 1."));
        let info = key_info(key).unwrap();
        assert_eq!(info.fingerprint, "85D0EC45B7C4AA14E8DD4231811F20E64270A275");
        assert_eq!(info.user_ids, vec!["MailVault E2E Test Key (TEST ONLY) <pgp-test@mock.test>".to_string()]);
    }

    #[test]
    fn the_wrong_key_is_a_clean_error() {
        let key = keypair("Bob <bob@x.test>", None);
        let other = keypair("Eve <eve@x.test>", None);
        let raw = pgp_mime(&encrypt(&key, INNER.as_bytes()));
        let err = decrypt(&raw, &[stored(&other, "")]).unwrap_err();
        assert!(err.contains("No imported OpenPGP key"), "{err}");
        assert!(decrypt(&raw, &[]).is_err());
        // Several keys: the one that fits is found.
        assert!(decrypt(&raw, &[stored(&other, ""), stored(&key, "")]).is_ok());
    }

    #[test]
    fn a_passphrase_protected_key_needs_its_passphrase() {
        let key = keypair("Bob <bob@x.test>", Some("correct horse"));
        let raw = inline(&encrypt(&key, b"hello"));
        assert!(decrypt(&raw, &[stored(&key, "wrong")]).is_err());
        assert!(decrypt(&raw, &[stored(&key, "correct horse")]).is_ok());
        assert!(validate(&stored(&key, "wrong")).is_err());
        let info = validate(&stored(&key, "correct horse")).unwrap();
        assert_eq!(key_info(&stored(&key, "").armored).unwrap(), info, "listing needs no passphrase");
        assert_eq!(info.user_ids, vec!["Bob <bob@x.test>".to_string()]);
        assert_eq!(info.fingerprint, fingerprint(&key));
        assert!(info.created > 0);
    }

    #[test]
    fn key_info_refuses_something_that_is_not_a_secret_key() {
        let key = keypair("Bob <bob@x.test>", None);
        let public = key.to_public_key().to_armored_string(ArmorOptions::default()).unwrap();
        assert!(validate(&StoredKey { armored: public, passphrase: String::new() }).is_err());
        assert!(key_info("hello").is_err());
    }

    #[test]
    fn plain_mail_quoting_an_armor_block_or_signed_mail_is_not_encrypted() {
        let quoted = b"Subject: re\r\n\r\nYou wrote:\r\n> -----BEGIN PGP MESSAGE-----\r\n> abc\r\n";
        assert!(!is_encrypted(quoted));
        let prose = b"Subject: how to\r\n\r\nPaste the block that starts with -----BEGIN PGP MESSAGE----- here.\r\n";
        assert!(!is_encrypted(prose));
        let signed = b"Subject: s\r\n\r\n-----BEGIN PGP SIGNED MESSAGE-----\r\nHash: SHA256\r\n\r\nhi\r\n";
        assert!(!is_encrypted(signed));
        assert!(!is_encrypted(b"Subject: x\r\n\r\nhello\r\n"));
    }

    fn mailbox() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let cur = crate::vault_files::cur_path(tmp.path(), "acct", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        (tmp, cur)
    }

    #[test]
    fn the_copy_is_served_only_for_the_original_it_was_made_from() {
        let key = keypair("Bob <bob@x.test>", None);
        let raw = pgp_mime(&encrypt(&key, INNER.as_bytes()));
        let (_tmp, cur) = mailbox();
        assert_eq!(readable(&cur, 5, raw.clone()), raw, "no copy yet: the original");
        let out = decrypt(&raw, &[stored(&key, "")]).unwrap();
        write_copy(&cur, 5, &out).unwrap();
        assert_eq!(readable(&cur, 5, raw.clone()), out);
        // uid 5 reused by another encrypted message: its plaintext is not this copy.
        let other = pgp_mime(&encrypt(&key, b"Content-Type: text/plain\r\n\r\nother\r\n"));
        assert_eq!(readable(&cur, 5, other.clone()), other);
        // A plain message never looks for a copy.
        assert_eq!(readable(&cur, 5, b"Subject: x\r\n\r\nhi\r\n".to_vec()), b"Subject: x\r\n\r\nhi\r\n");
        remove_copy(&cur, 5);
        assert_eq!(readable(&cur, 5, raw.clone()), raw);
    }

    #[test]
    fn a_leftover_temp_file_is_never_read_as_the_copy() {
        let (_tmp, cur) = mailbox();
        let raw = inline(&format!("{ARMOR_BEGIN}\r\nxx\r\n{ARMOR_END}"));
        let dir = copy_path(&cur, 9).parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&dir).unwrap();
        let temp = dir.join(".9.eml.tmp-1-0");
        std::fs::write(&temp, format!("{SOURCE_HEADER}: {}\r\n\r\nhalf", source_tag(&raw))).unwrap();
        assert_eq!(readable(&cur, 9, raw.clone()), raw);
        assert!(crate::maildir::vault_filename_uid(".9.eml.tmp-1-0").is_none());
        assert!(crate::maildir::vault_filename_uid("9.eml").is_none());
    }

    #[test]
    fn vault_reads_render_the_copy_and_a_delete_takes_it_along() {
        use base64::Engine;
        let key = keypair("Bob <bob@x.test>", None);
        let inner = "Content-Type: multipart/mixed; boundary=\"mx\"\r\n\r\n--mx\r\nContent-Type: text/html\r\n\r\n<p>code 4242</p>\r\n\
                     --mx\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=\"plan.txt\"\r\n\r\nsecret file\r\n--mx--\r\n";
        let raw = pgp_mime(&encrypt(&key, inner.as_bytes()));
        let tmp = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = crate::vault_files::cur_path(root, "acct", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(format!("5{}S.eml", crate::maildir::INFO_PREFIX)), &raw).unwrap();
        let reg = crate::vault_registry::VaultRegistry::open(app.path(), root);
        write_copy(&cur, 5, &decrypt(&raw, &[stored(&key, "")]).unwrap()).unwrap();

        let light = crate::vault_files::read_light(&reg, root, "acct", "INBOX", 5).unwrap().unwrap();
        assert!(light.html.unwrap().contains("code 4242"));
        assert_eq!(light.attachments.len(), 1);
        let full = crate::vault_files::read(&reg, root, "acct", "INBOX", 5).unwrap().unwrap();
        assert!(full.html.unwrap().contains("code 4242"));
        let part = crate::vault_files::read_attachment(&reg, root, "acct", "INBOX", 5, 0).unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(part).unwrap(), b"secret file\r\n");
        // The raw source view is the original, ciphertext and all.
        let source = crate::vault_files::read_raw_source(&reg, root, "acct", "INBOX", 5).unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(source).unwrap(), raw);

        assert!(crate::vault_files::delete(&reg, root, "acct", "INBOX", 5).unwrap());
        assert!(!copy_path(&cur, 5).exists(), "plaintext must not outlive the message");
    }

    #[test]
    fn the_copy_is_invisible_to_every_vault_count_and_listing() {
        let key = keypair("Bob <bob@x.test>", None);
        let raw = pgp_mime(&encrypt(&key, INNER.as_bytes()));
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cur = crate::vault_files::cur_path(root, "acct", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(cur.join(format!("5{}S.eml", crate::maildir::INFO_PREFIX)), &raw).unwrap();
        let reg = crate::vault_registry::VaultRegistry::open(root, root);
        let before = (
            crate::vault_files::storage_stats(root, None).email_count,
            crate::vault_ops::count_messages(root),
            crate::vault_files::list_on_disk(root, "acct", "INBOX", None).unwrap().len(),
            crate::maildir::uid_file_map(&cur).len(),
        );
        write_copy(&cur, 5, &decrypt(&raw, &[stored(&key, "")]).unwrap()).unwrap();
        assert!(copy_path(&cur, 5).exists());
        let after = (
            crate::vault_files::storage_stats(root, None).email_count,
            crate::vault_ops::count_messages(root),
            crate::vault_files::list_on_disk(root, "acct", "INBOX", None).unwrap().len(),
            crate::maildir::uid_file_map(&cur).len(),
        );
        assert_eq!(before, (1, 1, 1, 1));
        assert_eq!(after, before);
        assert_eq!(crate::vault_files::list(&reg, root, "acct", "INBOX", None).unwrap().len(), 1);
    }
}
