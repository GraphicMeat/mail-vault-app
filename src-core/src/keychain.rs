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
}
