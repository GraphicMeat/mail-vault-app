//! One scrubber for error and log text: every known secret removed, in plain
//! and base64 form, plus anything shaped like a bearer token or an XOAUTH2
//! blob. The desktop daemon, the abd Graph ops and the mobile engine all
//! scrub through here.

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use regex::Regex;
use std::sync::LazyLock;

/// What mobile logs show in place of a secret.
pub const MARKER: &str = "***";

/// A secret shorter than this is only removed in plain form: its base64 is a
/// few characters that would mangle ordinary text.
const MIN_ENCODED_LEN: usize = 4;

/// `Bearer <token>` (the token at least 8 characters, so prose like
/// "bearer of" survives).
static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}").unwrap());
/// A JWT: a base64url JSON header always starts `eyJ`.
static JWT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"eyJ[A-Za-z0-9._-]{10,}").unwrap());
/// An XOAUTH2 initial response: base64 of `user=...`, which always starts
/// `dXNlcj` (base64 of "user" without its last partial group).
static XOAUTH2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"dXNlcj[A-Za-z0-9+/_-]{16,}={0,2}").unwrap());

/// `text` with every secret replaced by [`MARKER`].
pub fn scrub(text: &str, secrets: &[&str]) -> String {
    scrub_with(text, secrets, MARKER)
}

/// [`scrub`] with the caller's own marker (desktop logs read `[redacted]`).
/// Empty secrets are ignored. Order: plain secrets (longest first, so a secret
/// holding another is removed whole), their base64 forms, then token shapes.
pub fn scrub_with(text: &str, secrets: &[&str], marker: &str) -> String {
    let mut ordered: Vec<&str> = secrets.iter().copied().filter(|s| !s.is_empty()).collect();
    ordered.sort_by_key(|s| std::cmp::Reverse(s.len()));
    ordered.dedup();
    let mut out = text.to_string();
    for s in &ordered {
        out = out.replace(s, marker);
    }
    for s in ordered.iter().filter(|s| s.len() >= MIN_ENCODED_LEN) {
        for enc in encodings(s) {
            out = out.replace(&enc, marker);
        }
    }
    let bearer = format!("Bearer {marker}");
    let out = BEARER.replace_all(&out, bearer.as_str());
    let out = JWT.replace_all(&out, marker);
    XOAUTH2.replace_all(&out, marker).into_owned()
}

/// The distinct base64 spellings of `secret`.
fn encodings(secret: &str) -> Vec<String> {
    let b = secret.as_bytes();
    let mut all = vec![STANDARD.encode(b), STANDARD_NO_PAD.encode(b), URL_SAFE.encode(b), URL_SAFE_NO_PAD.encode(b)];
    // Longest first: the padded form must go before its unpadded prefix.
    all.sort_by_key(|e| std::cmp::Reverse(e.len()));
    all.dedup();
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_secrets_go_and_empty_ones_are_ignored() {
        // The mobile engine's old cases.
        assert_eq!(scrub("a rt-1 b at-2 c", &["rt-1", "at-2", ""]), "a *** b *** c");
        assert_eq!(scrub("bad pw hunter2 here", &["hunter2"]), "bad pw *** here");
        assert_eq!(scrub("nothing here", &[]), "nothing here");
        assert_eq!(scrub("", &["x"]), "");
    }

    #[test]
    fn a_custom_marker_is_used_everywhere() {
        let t = "Bearer abcdefgh12345 and sekret!";
        assert_eq!(scrub_with(t, &["sekret!"], "[redacted]"), "Bearer [redacted] and [redacted]");
    }

    #[test]
    fn longer_secrets_are_removed_whole() {
        assert_eq!(scrub("pw abcdef.", &["abc", "abcdef"]), "pw ***.");
    }

    #[test]
    fn base64_forms_of_a_secret_go_too() {
        let secret = "p@ss/word+1";
        for enc in [STANDARD.encode(secret), STANDARD_NO_PAD.encode(secret), URL_SAFE.encode(secret), URL_SAFE_NO_PAD.encode(secret)] {
            let s = scrub(&format!("auth {enc} end"), &[secret]);
            assert!(!s.contains(&enc), "{s}");
            assert!(s.contains("auth *** end"), "{s}");
        }
    }

    #[test]
    fn a_short_secret_is_not_base64_scrubbed() {
        // base64("ab") = "YWI=" would otherwise eat unrelated text.
        assert_eq!(scrub("YWI= stays, ab goes", &["ab"]), "YWI= stays, *** goes");
    }

    #[test]
    fn bearer_tokens_and_jwts_go_whatever_the_secret_list() {
        let s = scrub("hdr Authorization: bearer ya29.A0AbCdEf-gh_ij tail", &[]);
        assert_eq!(s, "hdr Authorization: Bearer *** tail");
        let s = scrub("tok eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc.def end", &[]);
        assert_eq!(s, "tok *** end");
    }

    #[test]
    fn prose_about_bearers_survives() {
        assert_eq!(scrub("the bearer of bad news", &[]), "the bearer of bad news");
    }

    #[test]
    fn an_xoauth2_blob_goes() {
        let blob = STANDARD.encode("user=me@example.com\u{1}auth=Bearer tok-123456789\u{1}\u{1}");
        assert!(blob.starts_with("dXNlcj"));
        let s = scrub(&format!("AUTH XOAUTH2 {blob} rejected"), &[]);
        assert_eq!(s, "AUTH XOAUTH2 *** rejected");
    }

    #[test]
    fn the_abd_graph_case() {
        let token = "tok-SECRET-abc123XYZ";
        let e = format!("(401) {{\"m\":\"Bearer {token} eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc.def\"}} raw {token}");
        let s = scrub_with(&e, &[token], "<token>");
        assert!(!s.contains(token) && !s.contains("eyJhbGci"), "{s}");
        assert!(s.contains("(401)"), "{s}");
    }
}
