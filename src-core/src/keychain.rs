//! When a failed keychain read is one the user can fix by unlocking the
//! keychain, and what the daemon's banner says when it asks them to. The read
//! itself and the gate it feeds live in `src-daemon/src/credentials.rs`.

/// Why a keychain read is waiting on the user, or `None` when unlocking would
/// not help (a missing item, a corrupt blob, anything unrecognised), which
/// keeps today's error handling for those.
///
/// `os_status` is the macOS `OSStatus` the read failed with; other platforms
/// never have one, so only a timeout gates there.
pub fn keychain_block_reason(os_status: Option<i32>, timed_out: bool) -> Option<&'static str> {
    if timed_out {
        // Locked, or an "allow access" prompt nobody has answered yet.
        return Some("timeout");
    }
    match os_status? {
        -25308 => Some("locked"),         // errSecInteractionNotAllowed
        -25293 | -128 => Some("denied"), // errSecAuthFailed, errSecUserCanceled
        _ => None,
    }
}

/// Title and body of the banner the daemon posts itself when no app is
/// listening, for a macOS preferred language such as `de-DE` or `zh-Hans-CN`.
/// Same words as the app's `keychainGate.notifyTitle`/`notifyBody` keys.
pub fn keychain_banner_text(lang: &str) -> (&'static str, &'static str) {
    let lang = lang.to_ascii_lowercase();
    let is = |p: &str| lang == p || lang.starts_with(&format!("{p}-"));
    if is("es") {
        ("MailVault necesita tu llavero", "Haz clic para desbloquearlo y que la sincronización y los envíos programados puedan continuar.")
    } else if is("fr") {
        ("MailVault a besoin de votre trousseau", "Cliquez pour le déverrouiller afin que la synchronisation et les envois programmés reprennent.")
    } else if is("it") {
        ("MailVault ha bisogno del portachiavi", "Fai clic per sbloccarlo, così la sincronizzazione e gli invii programmati possono continuare.")
    } else if is("de") {
        ("MailVault braucht deinen Schlüsselbund", "Klicke, um ihn zu entsperren, damit Synchronisierung und geplante Sendungen weiterlaufen.")
    } else if is("pt") {
        ("O MailVault precisa das suas chaves", "Clique para desbloqueá-las e continuar a sincronização e os envios agendados.")
    } else if is("ja") {
        ("MailVault にキーチェーンへのアクセスが必要です", "クリックしてロックを解除すると、同期と予約送信が再開されます。")
    } else if is("ko") {
        ("MailVault에서 키체인이 필요합니다", "클릭해서 잠금을 해제하면 동기화와 예약 발송이 계속됩니다.")
    } else if is("zh") {
        ("MailVault 需要访问你的钥匙串", "点按以解锁，同步和定时发送即可继续。")
    } else {
        ("MailVault needs your keychain", "Click to unlock it so syncing and scheduled sends can continue.")
    }
}

// ── Split secrets ───────────────────────────────────────────────────────────
//
// Windows Credential Manager holds at most 2560 bytes of UTF-16 per secret,
// and the account blob outgrows that at one OAuth account. A secret over the
// platform limit is stored as parts `<key>.<generation>.<i>` plus a manifest
// in `<key>` itself; one within it stays inline, as it always is on macOS and
// Linux. The app writes (store_credentials), the app and daemon both read.

const MANIFEST: &str = "mvparts:";

/// Largest secret (UTF-16 units) this platform stores in one entry.
pub fn secret_limit() -> usize {
    if cfg!(windows) { 1280 } else { usize::MAX }
}

pub struct SplitSecret {
    /// What goes in `<key>`: the secret itself, or the manifest.
    pub primary: String,
    /// `(entry name, value)`, written before `primary`.
    pub parts: Vec<(String, String)>,
}

/// `secret` laid out for entries of at most `limit` UTF-16 units. Parts
/// break on char boundaries, never inside a surrogate pair.
pub fn split_secret(key: &str, secret: &str, limit: usize, generation: &str) -> SplitSecret {
    if secret.encode_utf16().count() <= limit {
        return SplitSecret { primary: secret.to_string(), parts: Vec::new() };
    }
    let mut chunks = Vec::new();
    let (mut start, mut units) = (0, 0);
    for (i, c) in secret.char_indices() {
        if units + c.len_utf16() > limit {
            chunks.push(&secret[start..i]);
            (start, units) = (i, 0);
        }
        units += c.len_utf16();
    }
    chunks.push(&secret[start..]);
    SplitSecret {
        primary: format!("{MANIFEST}{generation}:{}", chunks.len()),
        parts: chunks.iter().enumerate().map(|(i, c)| (format!("{key}.{generation}.{i}"), c.to_string())).collect(),
    }
}

/// The part entries a stored primary names; empty for an inline secret.
fn part_names(key: &str, primary: &str) -> Option<Vec<String>> {
    let (generation, count) = primary.strip_prefix(MANIFEST)?.rsplit_once(':')?;
    let count: usize = count.parse().ok()?;
    Some((0..count).map(|i| format!("{key}.{generation}.{i}")).collect())
}

/// Parts the previous primary named that `new` no longer uses: delete them
/// after `new.primary` is written.
pub fn stale_parts(key: &str, old_primary: Option<&str>, new: &SplitSecret) -> Vec<String> {
    let old = old_primary.and_then(|p| part_names(key, p)).unwrap_or_default();
    old.into_iter().filter(|name| !new.parts.iter().any(|(n, _)| n == name)).collect()
}

/// The secret a stored primary stands for. `get` reads any entry by name
/// (`Ok(None)` = no such entry). A manifest whose parts vanished was replaced
/// mid-read, so the primary is read again once. Every failure says "parts",
/// never "not found": a caller that took it for an empty keychain would save
/// over every other account's secrets.
pub fn join_secret(
    key: &str,
    primary: &str,
    get: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
) -> Result<String, String> {
    let mut primary = primary.to_string();
    for attempt in 0..2 {
        let Some(names) = part_names(key, &primary) else {
            if primary.starts_with(MANIFEST) {
                return Err(format!("credential parts manifest unreadable: {primary}"));
            }
            return Ok(primary);
        };
        let mut joined = String::new();
        let mut complete = true;
        for name in &names {
            match get(name).map_err(|e| format!("credential part read failed: {e}"))? {
                Some(part) => joined.push_str(&part),
                None => { complete = false; break; }
            }
        }
        if complete {
            return Ok(joined);
        }
        if attempt == 0 {
            primary = get(key)
                .map_err(|e| format!("credential parts reread failed: {e}"))?
                .ok_or("credential parts incomplete and the manifest is gone")?;
        }
    }
    Err("credential parts incomplete".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timeout_gates_whatever_the_status() {
        assert_eq!(keychain_block_reason(None, true), Some("timeout"));
        assert_eq!(keychain_block_reason(Some(-25300), true), Some("timeout"));
    }

    #[test]
    fn a_locked_keychain_gates() {
        assert_eq!(keychain_block_reason(Some(-25308), false), Some("locked"));
    }

    #[test]
    fn a_refused_or_cancelled_prompt_gates_as_denied() {
        assert_eq!(keychain_block_reason(Some(-25293), false), Some("denied"));
        assert_eq!(keychain_block_reason(Some(-128), false), Some("denied"));
    }

    #[test]
    fn anything_unlocking_cannot_fix_does_not_gate() {
        assert_eq!(keychain_block_reason(None, false), None);
        assert_eq!(keychain_block_reason(Some(-25300), false), None); // errSecItemNotFound
        assert_eq!(keychain_block_reason(Some(-25291), false), None); // errSecNotAvailable
        assert_eq!(keychain_block_reason(Some(-1), false), None);
    }

    #[test]
    fn the_banner_follows_the_preferred_language_and_falls_back_to_english() {
        assert_eq!(keychain_banner_text("de-DE").0, "MailVault braucht deinen Schlüsselbund");
        assert_eq!(keychain_banner_text("pt-BR").0, "O MailVault precisa das suas chaves");
        assert_eq!(keychain_banner_text("zh-Hans-CN").0, "MailVault 需要访问你的钥匙串");
        assert_eq!(keychain_banner_text("en-GB").0, "MailVault needs your keychain");
        assert_eq!(keychain_banner_text("nl-NL").0, "MailVault needs your keychain");
    }

    // ── split secrets ──

    use std::collections::HashMap;

    type Store = HashMap<String, String>;

    fn write(store: &mut Store, secret: &str, limit: usize, generation: &str) {
        let old = store.get("credentials").cloned();
        let mut set = |name: &str, value: &str| -> Result<(), String> {
            store.insert(name.to_string(), value.to_string());
            Ok(())
        };
        let parts = split_secret("credentials", secret, limit, generation);
        for (name, value) in &parts.parts {
            set(name, value).unwrap();
        }
        set("credentials", &parts.primary).unwrap();
        for name in stale_parts("credentials", old.as_deref(), &parts) {
            store.remove(&name);
        }
    }

    fn read(store: &Store) -> Result<String, String> {
        let primary = store.get("credentials").cloned().expect("primary stored");
        join_secret("credentials", &primary, &mut |name| Ok(store.get(name).cloned()))
    }

    #[test]
    fn a_secret_within_the_limit_is_stored_inline() {
        let mut store = Store::new();
        write(&mut store, r#"{"a":"1"}"#, 64, "g1");
        assert_eq!(store.len(), 1);
        assert_eq!(store["credentials"], r#"{"a":"1"}"#);
        assert_eq!(read(&store).unwrap(), r#"{"a":"1"}"#);
    }

    #[test]
    fn no_limit_never_splits() {
        let secret = "x".repeat(100_000);
        let parts = split_secret("credentials", &secret, usize::MAX, "g1");
        assert!(parts.parts.is_empty());
        assert_eq!(parts.primary, secret);
    }

    #[test]
    fn a_long_secret_is_split_into_parts_within_the_limit_and_joins_back() {
        let secret = format!(r#"{{"a":"{}"}}"#, "p".repeat(50));
        let mut store = Store::new();
        write(&mut store, &secret, 8, "g1");
        assert!(store.len() > 2);
        for value in store.values() {
            assert!(value.encode_utf16().count() <= 8 || value.starts_with("mvparts:"), "{value}");
        }
        assert_eq!(read(&store).unwrap(), secret);
    }

    #[test]
    fn a_part_boundary_never_cuts_a_surrogate_pair_or_a_multibyte_char() {
        let secret = "ąč😀ėę😀įš😀ųū😀ž".repeat(5);
        let parts = split_secret("credentials", &secret, 3, "g1");
        for (_, value) in &parts.parts {
            assert!(value.encode_utf16().count() <= 3);
        }
        let mut store = Store::new();
        write(&mut store, &secret, 3, "g1");
        assert_eq!(read(&store).unwrap(), secret);
    }

    #[test]
    fn a_rewrite_removes_the_previous_generations_parts() {
        let mut store = Store::new();
        write(&mut store, &"a".repeat(40), 8, "g1");
        let first: Vec<String> = store.keys().filter(|k| k.contains("g1")).cloned().collect();
        assert!(!first.is_empty());
        write(&mut store, &"b".repeat(40), 8, "g2");
        assert!(store.keys().all(|k| !k.contains("g1")), "{:?}", store.keys());
        assert_eq!(read(&store).unwrap(), "b".repeat(40));
    }

    #[test]
    fn shrinking_back_inline_removes_every_part() {
        let mut store = Store::new();
        write(&mut store, &"a".repeat(40), 8, "g1");
        write(&mut store, "{}", 8, "g2");
        assert_eq!(store.len(), 1);
        assert_eq!(read(&store).unwrap(), "{}");
    }

    #[test]
    fn a_rewrite_in_the_same_generation_keeps_its_own_parts() {
        let mut store = Store::new();
        write(&mut store, &"a".repeat(40), 8, "g1");
        write(&mut store, &"b".repeat(40), 8, "g1");
        assert_eq!(read(&store).unwrap(), "b".repeat(40));
    }

    #[test]
    fn a_missing_part_is_an_error_that_never_reads_as_an_empty_keychain() {
        let mut store = Store::new();
        write(&mut store, &"a".repeat(40), 8, "g1");
        let victim = store.keys().find(|k| k.contains("g1")).cloned().unwrap();
        store.remove(&victim);
        let err = read(&store).unwrap_err();
        // get_credentials maps these words to "empty", which lets the next
        // save overwrite every other account's secrets.
        for word in ["NoEntry", "not found", "No password found"] {
            assert!(!err.contains(word), "{err}");
        }
    }

    #[test]
    fn a_manifest_replaced_mid_read_is_followed_once() {
        // The reader got g1's manifest, then the app wrote g2 and deleted g1's
        // parts before the reader fetched them.
        let mut store = Store::new();
        write(&mut store, &"a".repeat(40), 8, "g1");
        let stale = store["credentials"].clone();
        write(&mut store, &"b".repeat(40), 8, "g2");
        let joined = join_secret("credentials", &stale, &mut |name| Ok(store.get(name).cloned()));
        assert_eq!(joined.unwrap(), "b".repeat(40));
    }
}
