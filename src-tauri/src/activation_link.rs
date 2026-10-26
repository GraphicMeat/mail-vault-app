//! `mailvault://activate?token=...` handed over by the OS.
//!
//! The web checkout ends on a page that opens this link. The shell's whole job
//! is delivery: queue the URL (it can arrive before the webview exists, exactly
//! like a `mailto:` click that launches the app) and wake the frontend, which
//! spends the token against the billing API. Nothing here reads the token.

use std::sync::Mutex;

/// Activation URLs the OS has handed over that the frontend has not taken yet.
#[derive(Default)]
pub struct PendingActivation(Mutex<Vec<String>>);

impl PendingActivation {
    pub fn push(&self, url: String) {
        if let Ok(mut q) = self.0.lock() {
            q.push(url);
        }
    }

    /// Hands the queue to the caller and leaves it empty.
    pub fn take(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut q| std::mem::take(&mut *q))
            .unwrap_or_default()
    }
}

/// Whether the OS handed us one of our own links rather than a `mailto:`.
/// The scheme is ASCII case-insensitive, per RFC 3986.
pub fn is_activation_url(url: &str) -> bool {
    url.get(.."mailvault:".len())
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("mailvault:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_our_scheme_in_any_case_and_nothing_else() {
        assert!(is_activation_url("mailvault://activate?token=abc"));
        assert!(is_activation_url("MailVault://activate?token=abc"));
        assert!(!is_activation_url("mailto:a@b.test"));
        assert!(!is_activation_url("https://mailvaultapp.com/mailvault:"));
        assert!(!is_activation_url("mailvaul"));
        assert!(!is_activation_url(""));
        // A multi-byte character straddling the scheme length must not panic.
        assert!(!is_activation_url("mailvaul\u{e9}x"));
    }

    #[test]
    fn queue_hands_everything_over_once() {
        let q = PendingActivation::default();
        q.push("mailvault://activate?token=a".into());
        q.push("mailvault://activate?token=b".into());
        assert_eq!(
            q.take(),
            vec!["mailvault://activate?token=a", "mailvault://activate?token=b"]
        );
        assert!(q.take().is_empty());
    }
}
