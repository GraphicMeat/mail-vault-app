//! OpenPGP on the phone, as desktop has it (`src-daemon/src/handlers/pgp.rs`): the secret keys
//! mail is decrypted with (`mobile.pgp.*`), and the decrypt-on-read step the body path
//! (`body.rs`) runs a fetched message through. The decryption itself is core's
//! `mailvault_core::pgp`; nothing here encrypts or signs (desktop does neither).
//!
//! The keys live in the platform secret store under one entry, [`ENTRY`], a JSON list of core's
//! `StoredKey` (armored key and passphrase), never in `mobile.db`, a log line or an event. A key
//! file the user picked comes in as an `out/<dir>/<name>` handle (the shell's picker copy); its
//! copy is deleted as soon as it is read, whether the import works or not.
//!
//! The phone fetches a body part by part, never the whole message, so the decryption gets a
//! message rebuilt from the parts that matter: PGP/MIME (RFC 3156) is the `application/octet-stream`
//! payload, read with [`Backend::part_range`] and wrapped in a `multipart/encrypted` envelope;
//! inline PGP is the `text/plain` body. What comes out is parsed with core's
//! `vault_eml::parse_eml_bytes_light`. The decrypted body is what `body.rs` caches and indexes,
//! as desktop keeps a decrypted copy next to the original. The attachments inside the ciphertext
//! have no server section to fetch, so they are not listed.

use crate::backend::{Backend, FolderRow, RawBody};
use crate::db::{Engine, Shared};
use crate::rpc::{parse, RpcError};
use mailvault_core::imap::PartInfo;
use mailvault_core::pgp::{self as core_pgp, KeyInfo, StoredKey};
use serde::Deserialize;
use serde_json::{json, Value};

/// The secret store entry that holds every imported key. Account ids are `acc_...`, so it never
/// names an account.
pub(crate) const ENTRY: &str = "pgp_secret_keys";
/// The body's badge: it came from decryption.
pub(crate) const DECRYPTED: &str = "decrypted";
/// Encrypted, and no imported key opens it: the viewer shows a notice instead of ciphertext.
pub(crate) const LOCKED: &str = "locked";
const ARMOR_BEGIN: &str = "-----BEGIN PGP MESSAGE-----";
/// Largest key (armored text or picked file) an import reads.
const MAX_KEY_BYTES: u64 = 1024 * 1024;
/// Largest PGP/MIME payload read for a decryption.
const MAX_PAYLOAD: u64 = 64 * 1024 * 1024;
/// One `part_range` read of the payload.
const CHUNK: u32 = 512 * 1024;
const BOUNDARY: &str = "mv-pgp-envelope";

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

/// The imported keys. `Err` when the store cannot be read, or holds something that does not
/// parse (never overwritten then: an import would lose the keys already there).
fn read_keys(shared: &Shared) -> Result<Vec<StoredKey>, String> {
    match shared.secrets().get(ENTRY)? {
        None => Ok(Vec::new()),
        Some(json) => serde_json::from_str(&json).map_err(|_| "the stored OpenPGP keys could not be read".to_string()),
    }
}

fn write_keys(shared: &Shared, keys: &[StoredKey]) -> Result<(), String> {
    if keys.is_empty() {
        return shared.secrets().delete(ENTRY);
    }
    let json = serde_json::to_string(keys).map_err(|_| "the OpenPGP keys could not be saved".to_string())?;
    shared.secrets().set(ENTRY, &json)
}

/// What Settings lists: fingerprint, user ids, creation time. Never the key or its passphrase.
fn listed(keys: &[StoredKey]) -> Value {
    let infos: Vec<KeyInfo> = keys.iter().filter_map(|k| core_pgp::key_info(&k.armored).ok()).collect();
    json!({ "keys": infos })
}

/// `mobile.pgp.listKeys {}` -> `{keys: [{fingerprint, userIds, created}]}`.
pub(crate) fn list_keys(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    read_keys(engine.shared()).map(|k| listed(&k)).map_err(internal)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportParams {
    /// The pasted key.
    #[serde(default)]
    armored: Option<String>,
    /// Or a picked key file, as the shell's picker named it (`out/<dir>/<name>`).
    #[serde(default)]
    handle: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
}

/// Reads a picked key file and deletes the shell's copy of it (its whole `out/<dir>`), read or
/// not: a secret key never waits in the cache for the orphan sweep.
fn take_picked(cache_dir: &std::path::Path, handle: &str) -> Result<String, RpcError> {
    let path = crate::outgoing::resolve_outgoing(cache_dir, handle).map_err(RpcError::Invalid)?;
    let read = std::fs::metadata(&path).map_err(internal).and_then(|m| {
        if m.len() > MAX_KEY_BYTES {
            Err(RpcError::Invalid("the key file is too large".into()))
        } else {
            std::fs::read(&path).map_err(internal)
        }
    });
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
    String::from_utf8(read?).map_err(|_| RpcError::Invalid("Not an OpenPGP secret key".into()))
}

/// `mobile.pgp.importKey {armored | handle, passphrase?}` -> `{keys}`. The passphrase must unlock
/// the key (core's `validate`); importing a key already there replaces it (a new passphrase,
/// say). `INVALID` with core's reason when the text is not a secret key or the passphrase is
/// wrong. Once in, cached bodies no key could open are dropped, so the next download pass
/// decrypts them.
pub(crate) fn import_key(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ImportParams = parse(params)?;
    let armored = match (p.armored, p.handle) {
        (Some(a), None) => a,
        (None, Some(h)) => take_picked(engine.cache_dir(), &h)?,
        _ => return Err(RpcError::Invalid("give either the key text or a picked file".into())),
    };
    if armored.len() as u64 > MAX_KEY_BYTES {
        return Err(RpcError::Invalid("the key is too large".into()));
    }
    let stored = StoredKey { armored: armored.trim().to_string(), passphrase: p.passphrase.unwrap_or_default() };
    let info = core_pgp::validate(&stored).map_err(RpcError::Invalid)?;
    let shared = engine.shared();
    let keys = {
        let _one = crate::db::lock(&shared.pgp_keys);
        let mut keys = read_keys(shared).map_err(internal)?;
        keys.retain(|k| core_pgp::key_info(&k.armored).map_or(true, |i| i.fingerprint != info.fingerprint));
        keys.push(stored);
        write_keys(shared, &keys).map_err(internal)?;
        keys
    };
    if let Err(e) = forget_locked(shared) {
        shared.log(&format!("[pgp] locked bodies not dropped: {e}"));
    }
    Ok(listed(&keys))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveParams {
    fingerprint: String,
}

/// `mobile.pgp.removeKey {fingerprint}` -> `{keys}`. Bodies already decrypted stay readable, as
/// desktop's decrypted copies do.
pub(crate) fn remove_key(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: RemoveParams = parse(params)?;
    let shared = engine.shared();
    let _one = crate::db::lock(&shared.pgp_keys);
    let mut keys = read_keys(shared).map_err(internal)?;
    keys.retain(|k| core_pgp::key_info(&k.armored).map_or(true, |i| i.fingerprint != p.fingerprint));
    write_keys(shared, &keys).map_err(internal)?;
    Ok(listed(&keys))
}

/// Deletes the cached bodies (and their attachment rows) that were stored encrypted: no key
/// opened them, or they were cached before the phone decrypted. At most 200 per transaction.
fn forget_locked(shared: &Shared) -> Result<usize, crate::db::EngineError> {
    let mut gone = 0;
    loop {
        let rows: Vec<(String, String, i64)> = shared.read(|c| {
            let mut st = c.prepare(
                "SELECT account_id, folder, uid FROM bodies
                 WHERE instr(parts_json, '\"pgp\":\"locked\"') > 0
                    OR (instr(parts_json, 'application/pgp-encrypted') > 0 AND instr(parts_json, '\"pgp\":\"decrypted\"') = 0)
                 LIMIT 200",
            )?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        if rows.is_empty() {
            return Ok(gone);
        }
        gone += rows.len();
        shared.write(|c| {
            for (a, f, u) in &rows {
                c.execute("DELETE FROM attachments WHERE account_id = ?1 AND folder = ?2 AND uid = ?3", (a, f, u))?;
                c.execute("DELETE FROM bodies WHERE account_id = ?1 AND folder = ?2 AND uid = ?3", (a, f, u))?;
            }
            Ok(())
        })?;
    }
}

/// Whether a body of this shape is OpenPGP encrypted: PGP/MIME (an `application/pgp-encrypted`
/// part) or inline (a text body that starts with the armor). A signed or merely quoting message
/// is not.
pub(crate) fn looks_encrypted<'a>(mut mimes: impl Iterator<Item = &'a str>, text: Option<&str>) -> bool {
    mimes.any(|m| m.eq_ignore_ascii_case("application/pgp-encrypted")) || text.is_some_and(|t| t.trim_start().starts_with(ARMOR_BEGIN))
}

/// The PGP/MIME payload part, when `parts` are a PGP/MIME message's.
fn payload(parts: &[PartInfo]) -> Option<&PartInfo> {
    if !parts.iter().any(|p| p.mime.eq_ignore_ascii_case("application/pgp-encrypted")) {
        return None;
    }
    parts.iter().find(|p| p.mime.eq_ignore_ascii_case("application/octet-stream"))
}

/// The payload's raw (transfer-encoded) octets. `None` when it went away or is over
/// [`MAX_PAYLOAD`].
fn read_payload(backend: &mut dyn Backend, folder: &FolderRow, uid: u32, part: &PartInfo) -> Result<Option<Vec<u8>>, crate::sync::Fail> {
    let mut out = Vec::new();
    loop {
        let Some(chunk) = backend.part_range(folder, uid, &part.section, out.len() as u64, CHUNK)? else {
            return Ok(None);
        };
        let short = chunk.len() < CHUNK as usize;
        out.extend_from_slice(&chunk);
        if out.len() as u64 > MAX_PAYLOAD {
            return Ok(None);
        }
        if short {
            return Ok(Some(out));
        }
    }
}

/// The message core's `decrypt` reads: the payload in a `multipart/encrypted` envelope.
fn mime_envelope(payload: &[u8], encoding: &str) -> Vec<u8> {
    let cte = match encoding.to_ascii_lowercase().as_str() {
        e @ ("base64" | "quoted-printable") => format!("Content-Transfer-Encoding: {e}\r\n"),
        _ => String::new(),
    };
    let mut out = format!(
        "MIME-Version: 1.0\r\nContent-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"{BOUNDARY}\"\r\n\r\n\
         --{BOUNDARY}\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n\
         --{BOUNDARY}\r\nContent-Type: application/octet-stream\r\n{cte}\r\n"
    )
    .into_bytes();
    out.extend_from_slice(payload);
    out.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    out
}

fn inline_envelope(text: &str) -> Vec<u8> {
    format!("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{text}").into_bytes()
}

/// The decrypt-on-read step: when `raw` (just fetched over `backend`) is encrypted, decrypts it
/// with the imported keys and puts the plaintext's html and text in its place, without the
/// ciphertext parts. Returns the badge: `None` (not encrypted), [`DECRYPTED`] or [`LOCKED`] (no
/// key opens it, or the payload could not be read; `raw` is left as it came). Never fails the
/// open; the log names only the message, never a key or core's error text.
pub(crate) fn open_body(shared: &Shared, backend: &mut dyn Backend, folder: &FolderRow, uid: u32, raw: &mut RawBody) -> Option<&'static str> {
    if !looks_encrypted(raw.parts.iter().map(|p| p.mime.as_str()), raw.text.as_deref()) {
        return None;
    }
    let locked = |why: &str| {
        shared.log(&format!("[pgp] {} {uid} stays encrypted: {why}", folder.path));
        Some(LOCKED)
    };
    let keys = match read_keys(shared) {
        Ok(k) if !k.is_empty() => k,
        Ok(_) => return Some(LOCKED),
        Err(_) => return locked("keys unavailable"),
    };
    let (message, payload_section) = match payload(&raw.parts).cloned() {
        Some(part) => match read_payload(backend, folder, uid, &part) {
            Ok(Some(bytes)) => (mime_envelope(&bytes, &part.encoding), Some(part.section)),
            Ok(None) => return locked("payload unavailable"),
            Err(_) => return locked("payload not fetched"),
        },
        None => match raw.text.as_deref() {
            Some(text) if text.trim_start().starts_with(ARMOR_BEGIN) => (inline_envelope(text), None),
            _ => return locked("no payload"),
        },
    };
    let Ok(plain) = core_pgp::decrypt(&message, &keys) else {
        return locked("no imported key opens it");
    };
    let Ok(parsed) = mailvault_core::vault_eml::parse_eml_bytes_light(&plain, uid, Vec::new()) else {
        return locked("the decrypted message does not parse");
    };
    raw.html = parsed.html;
    raw.text = parsed.text;
    if let Some(section) = payload_section {
        raw.parts.retain(|p| p.section != section && !p.mime.eq_ignore_ascii_case("application/pgp-encrypted"));
    }
    Some(DECRYPTED)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::secrets::SecretStore;
    use mock_imap::state::{Mailbox, Message};
    use pgp::composed::{ArmorOptions, EncryptionCaps, KeyType, MessageBuilder, SecretKeyParamsBuilder, SignedSecretKey, SubkeyParamsBuilder};
    use pgp::crypto::{ecc_curve::ECCCurve, sym::SymmetricKeyAlgorithm};
    use std::sync::Arc;

    /// A TEST-ONLY keypair: Ed25519 primary, Curve25519 encryption subkey.
    pub(crate) fn keypair(passphrase: Option<&str>) -> SignedSecretKey {
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

    pub(crate) fn armored(key: &SignedSecretKey) -> String {
        key.to_armored_string(ArmorOptions::default()).unwrap()
    }

    fn sealed(to: &SignedSecretKey, inner: &[u8]) -> String {
        let mut rng = rand08::thread_rng();
        let mut builder = MessageBuilder::from_bytes("", inner.to_vec()).seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
        builder.encrypt_to_key(&mut rng, to.secret_subkeys[0].key.public_key()).unwrap();
        builder.to_armored_string(&mut rng, ArmorOptions::default()).unwrap()
    }

    fn pgp_mime(uid: u32, to: &SignedSecretKey) -> Message {
        let body = sealed(to, b"Content-Type: text/html; charset=utf-8\r\n\r\n<p>The code is <b>4242</b></p>\r\n");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        Message::new(
            uid,
            format!(
                "From: Ann <ann@x.test>\r\nSubject: Sealed\r\nMessage-ID: <sealed{uid}@x>\r\nMIME-Version: 1.0\r\n\
                 Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"b\"\r\n\r\n\
                 --b\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n\
                 --b\r\nContent-Type: application/octet-stream; name=\"encrypted.asc\"\r\nContent-Disposition: inline; filename=\"encrypted.asc\"\r\n\r\n{body}\r\n--b--\r\n"
            ),
        )
        .with_internal_ms(now - 3_600_000)
    }

    fn inline(uid: u32, to: &SignedSecretKey) -> Message {
        let body = sealed(to, b"Meet at noon, gate 7.");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        Message::new(
            uid,
            format!(
                "From: Ann <ann@x.test>\r\nSubject: Inline\r\nMessage-ID: <inline{uid}@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"
            ),
        )
        .with_internal_ms(now - 7_200_000)
    }

    fn engine_with(messages: Vec<Message>) -> (mock_imap::MockImap, tempfile::TempDir, Engine, Arc<crate::MemorySecrets>, String) {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
        std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
        let mut mb = Mailbox::new("INBOX");
        for m in messages {
            mb.add(m);
        }
        let server = mock_imap::MockImap::start(mock_imap::Scenario::new().mailbox(mb));
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(crate::MemorySecrets::default());
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), secrets.clone()).unwrap();
        let added = e
            .rpc(
                "mobile.accounts.add",
                json!({ "email": "u@example.test", "password": "pw", "imapHost": server.host(), "imapPort": server.port(), "security": "none", "smtpHost": server.host(), "smtpPort": server.smtp_port(), "smtpSecurity": "starttls" }),
            )
            .unwrap();
        let account = added["account"]["id"].as_str().unwrap().to_string();
        crate::sync::sync_now_for_test(e.shared(), &account, None);
        (server, tmp, e, secrets, account)
    }

    fn body(e: &Engine, account: &str, uid: u32) -> Value {
        e.rpc("mobile.message.body", json!({ "accountId": account, "folder": "INBOX", "uid": uid })).unwrap()
    }

    /// Every byte of `mobile.db` and its WAL, to prove a secret never landed there.
    fn db_bytes(tmp: &tempfile::TempDir) -> Vec<u8> {
        let mut all = Vec::new();
        for entry in std::fs::read_dir(tmp.path()).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("mobile.db") {
                all.extend(std::fs::read(entry.path()).unwrap());
            }
        }
        all
    }

    fn contains(hay: &[u8], needle: &str) -> bool {
        hay.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    #[test]
    fn keys_import_list_and_remove_through_the_secret_store() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(crate::MemorySecrets::default());
        let e = Engine::open(tmp.path(), &tmp.path().join("cache"), secrets.clone()).unwrap();
        let key = keypair(Some("hunter22"));

        assert_eq!(e.rpc("mobile.pgp.listKeys", json!({})).unwrap(), json!({ "keys": [] }));
        let wrong = e.rpc("mobile.pgp.importKey", json!({ "armored": armored(&key), "passphrase": "nope" })).unwrap_err();
        assert_eq!(wrong.code(), "INVALID");
        assert!(wrong.to_string().contains("passphrase"), "{wrong}");
        assert!(!wrong.to_string().contains("nope"), "the error quotes the passphrase: {wrong}");
        assert!(e.rpc("mobile.pgp.importKey", json!({ "armored": "not a key" })).is_err());
        assert!(secrets.get(ENTRY).unwrap().is_none(), "a refused import stored something");

        let listed = e.rpc("mobile.pgp.importKey", json!({ "armored": armored(&key), "passphrase": "hunter22" })).unwrap();
        let fp = listed["keys"][0]["fingerprint"].as_str().unwrap().to_string();
        assert_eq!(listed["keys"][0]["userIds"], json!(["Bob <bob@x.test>"]));
        assert!(listed.to_string().find("PGP").is_none() && !listed.to_string().contains("hunter22"), "the reply carries key material: {listed}");
        // Again: replaced, not listed twice.
        let again = e.rpc("mobile.pgp.importKey", json!({ "armored": armored(&key), "passphrase": "hunter22" })).unwrap();
        assert_eq!(again["keys"].as_array().unwrap().len(), 1);
        assert_eq!(e.rpc("mobile.pgp.listKeys", json!({})).unwrap()["keys"][0]["fingerprint"], json!(fp));

        let stored = secrets.get(ENTRY).unwrap().expect("the key is in the secret store");
        assert!(stored.contains("BEGIN PGP PRIVATE KEY BLOCK") && stored.contains("hunter22"));
        let db = db_bytes(&tmp);
        assert!(!contains(&db, "PRIVATE KEY BLOCK") && !contains(&db, "hunter22"), "key material in mobile.db");

        assert_eq!(e.rpc("mobile.pgp.removeKey", json!({ "fingerprint": fp })).unwrap(), json!({ "keys": [] }));
        assert!(secrets.get(ENTRY).unwrap().is_none(), "the last key's entry is gone");
    }

    #[test]
    fn a_picked_key_file_is_imported_and_its_copy_deleted_either_way() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache");
        let e = Engine::open(tmp.path(), &cache, Arc::new(crate::MemorySecrets::default())).unwrap();
        let key = keypair(None);
        let pick = |dir: &str, text: &str| {
            std::fs::create_dir_all(cache.join("out").join(dir)).unwrap();
            std::fs::write(cache.join("out").join(dir).join("key.asc"), text).unwrap();
            format!("out/{dir}/key.asc")
        };

        let bad = pick("aa", "not a key");
        assert!(e.rpc("mobile.pgp.importKey", json!({ "handle": bad })).is_err());
        assert!(!cache.join("out").join("aa").exists(), "a refused pick stays in the cache");

        let good = pick("bb", &armored(&key));
        let listed = e.rpc("mobile.pgp.importKey", json!({ "handle": good })).unwrap();
        assert_eq!(listed["keys"].as_array().unwrap().len(), 1);
        assert!(!cache.join("out").join("bb").exists(), "the picked key stays in the cache");

        assert_eq!(e.rpc("mobile.pgp.importKey", json!({ "handle": "../mobile.db" })).unwrap_err().code(), "INVALID");
        assert_eq!(e.rpc("mobile.pgp.importKey", json!({})).unwrap_err().code(), "INVALID");
    }

    /// Desktop's flow on the phone: a PGP/MIME message opened with no key shows the locked
    /// notice; once the key is in, the same open (no new sync) reads the plaintext, without the
    /// ciphertext parts as attachments, and the next open is a cache hit that needs no key.
    #[test]
    fn a_pgp_mime_message_opens_locked_then_decrypted_and_stays_readable() {
        let key = keypair(None);
        let (server, tmp, e, secrets, account) = engine_with(vec![pgp_mime(1, &key)]);

        let locked = body(&e, &account, 1);
        assert_eq!(locked["pgp"], json!(LOCKED), "{locked}");
        assert!(locked["html"].is_null() && locked["text"].is_null(), "{locked}");

        e.rpc("mobile.pgp.importKey", json!({ "armored": armored(&key) })).unwrap();
        let open = body(&e, &account, 1);
        assert_eq!(open["pgp"], json!(DECRYPTED), "{open}");
        assert!(open["html"].as_str().unwrap().contains("<b>4242</b>"), "{open}");
        assert_eq!(open["attachments"], json!([]), "the ciphertext parts are listed: {open}");
        let snippet: String = e.read(|c| c.query_row("SELECT snippet FROM messages WHERE uid = 1", [], |r| r.get(0))).unwrap();
        assert!(snippet.contains("4242"), "the list row's preview is the plaintext: {snippet}");

        // The key gone: the cached plaintext still answers, with no fetch.
        secrets.delete(ENTRY).unwrap();
        let fetches = server.commands().iter().filter(|c| c.to_uppercase().contains("FETCH")).count();
        let hit = body(&e, &account, 1);
        assert_eq!(hit["pgp"], json!(DECRYPTED));
        assert!(hit["html"].as_str().unwrap().contains("4242"));
        assert_eq!(server.commands().iter().filter(|c| c.to_uppercase().contains("FETCH")).count(), fetches, "a decrypted body was fetched again");
        drop(tmp);
    }

    /// With no key on the phone a locked body is answered from the cache (offline too), not
    /// fetched again on every open.
    #[test]
    fn a_locked_body_with_no_key_is_answered_from_the_cache() {
        let key = keypair(None);
        let (server, _tmp, e, _secrets, account) = engine_with(vec![pgp_mime(1, &key)]);
        assert_eq!(body(&e, &account, 1)["pgp"], json!(LOCKED));
        let fetches = || server.commands().iter().filter(|c| c.to_uppercase().contains("FETCH")).count();
        let before = fetches();
        let again = body(&e, &account, 1);
        assert_eq!(again["pgp"], json!(LOCKED), "{again}");
        assert_eq!(fetches(), before, "a locked body was fetched again with no key to open it");
    }

    /// A key that does not open the message changes nothing: the locked body is still answered
    /// from the cache, not fetched (up to the payload's 64 MB) on every open.
    #[test]
    fn a_locked_body_stays_cached_while_only_other_keys_are_in() {
        let (theirs, mine) = (keypair(None), keypair(None));
        let (server, _tmp, e, _secrets, account) = engine_with(vec![pgp_mime(1, &theirs)]);
        e.rpc("mobile.pgp.importKey", json!({ "armored": armored(&mine) })).unwrap();
        assert_eq!(body(&e, &account, 1)["pgp"], json!(LOCKED));
        let fetches = || server.commands().iter().filter(|c| c.to_uppercase().contains("FETCH")).count();
        let before = fetches();
        assert_eq!(body(&e, &account, 1)["pgp"], json!(LOCKED));
        assert_eq!(fetches(), before, "a locked body was fetched again for a key the phone lacks");
    }

    /// Imports and removes that overlap never lose a key: each read-modify-write of the one
    /// secret store entry runs alone.
    #[test]
    fn concurrent_imports_keep_every_key() {
        struct Slow(crate::MemorySecrets);
        impl crate::SecretStore for Slow {
            fn get(&self, id: &str) -> Result<Option<String>, String> {
                let v = self.0.get(id);
                if id == ENTRY {
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
                v
            }
            fn set(&self, id: &str, secret: &str) -> Result<(), String> {
                self.0.set(id, secret)
            }
            fn delete(&self, id: &str) -> Result<(), String> {
                self.0.delete(id)
            }
        }
        let tmp = tempfile::tempdir().unwrap();
        let e = Arc::new(Engine::open(tmp.path(), &tmp.path().join("cache"), Arc::new(Slow(crate::MemorySecrets::default()))).unwrap());
        let keys: Vec<String> = (0..4).map(|_| armored(&keypair(None))).collect();
        let threads: Vec<_> = keys
            .into_iter()
            .map(|k| {
                let e = Arc::clone(&e);
                std::thread::spawn(move || e.rpc("mobile.pgp.importKey", json!({ "armored": k })).unwrap())
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(e.rpc("mobile.pgp.listKeys", json!({})).unwrap()["keys"].as_array().unwrap().len(), 4, "an import lost another's key");
    }

    /// A download pass that ran before the key was imported cached the message encrypted; the
    /// import drops that row, and the next pass and the next open read the plaintext.
    #[test]
    fn a_body_downloaded_while_locked_is_decrypted_once_the_key_is_in() {
        let key = keypair(None);
        let (_server, _tmp, e, _secrets, account) = engine_with(vec![pgp_mime(1, &key), inline(2, &key)]);
        let pass = || {
            let mut backend = crate::backend::open(e.shared(), &account).unwrap_or_else(|_| panic!("sign-in"));
            let n = crate::body::prefetch(e.shared(), backend.as_mut(), &account, &|| false).unwrap_or_else(|_| panic!("prefetch"));
            drop(backend);
            n
        };
        assert_eq!(pass(), 2);
        assert_eq!(body(&e, &account, 1)["pgp"], json!(LOCKED));
        assert_eq!(body(&e, &account, 2)["pgp"], json!(LOCKED));

        e.rpc("mobile.pgp.importKey", json!({ "armored": armored(&key) })).unwrap();
        assert_eq!(pass(), 2, "the locked rows were not downloaded again");
        let stored: Vec<String> = e
            .read(|c| {
                let mut st = c.prepare("SELECT parts_json FROM bodies ORDER BY uid")?;
                let rows = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
                Ok(rows)
            })
            .unwrap();
        assert!(stored.iter().all(|p| p.contains("\"pgp\":\"decrypted\"")), "{stored:?}");
        let inline = body(&e, &account, 2);
        assert_eq!(inline["pgp"], json!(DECRYPTED), "{inline}");
        assert!(inline["text"].as_str().unwrap().contains("Meet at noon, gate 7."), "{inline}");
        assert!(!inline["text"].as_str().unwrap().contains("BEGIN PGP"), "{inline}");
    }

    #[test]
    fn a_plain_message_carries_no_badge() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let plain = Message::new(3, "From: a <a@x.test>\r\nSubject: hi\r\nMessage-ID: <p3@x>\r\nContent-Type: text/plain\r\n\r\nquoting -----BEGIN PGP MESSAGE----- in a sentence\r\n")
            .with_internal_ms(now - 1000);
        let (_server, _tmp, e, _secrets, account) = engine_with(vec![plain]);
        let v = body(&e, &account, 3);
        assert!(v["pgp"].is_null(), "{v}");
        assert!(v["text"].as_str().unwrap().contains("quoting"));
    }
}
