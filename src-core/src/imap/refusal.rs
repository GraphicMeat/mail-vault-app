//! IMAP refusals that are the server's temporary state, never a verdict on the account or the
//! message. RFC 5530 names the response codes: `UNAVAILABLE` (a dependent service is down),
//! `INUSE` (a mailbox is locked), `LIMIT` (a server limit was hit) and `SERVERBUG`. Gmail also
//! answers a throttled login `[ALERT] Too many simultaneous connections`. Each of these must
//! never hold or park an account as if its password were wrong.

const CODES: [&str; 4] = ["[unavailable]", "[inuse]", "[limit]", "[serverbug]"];

/// True when an IMAP error text carries a temporary refusal: one of the RFC 5530 codes, or an
/// `[ALERT]` about too many connections. Case-insensitive, wherever in the text it sits.
pub fn is_transient_refusal(text: &str) -> bool {
    let low = text.to_ascii_lowercase();
    CODES.iter().any(|c| low.contains(c)) || (low.contains("[alert]") && low.contains("too many") && low.contains("connection"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_refusals() {
        for e in [
            "XOAUTH2 auth failed for u@gmail.com: NO [UNAVAILABLE] Temporary System Problem. Try again later.",
            "Login failed for u@example.test: NO [UNAVAILABLE] Server busy",
            "Login failed for u@example.test: NO [INUSE] Mailbox in use",
            "Login failed for u@example.test: NO [LIMIT] Too many connections",
            "Login failed for u@example.test: NO [SERVERBUG] Oops",
            "no [unavailable]",
            "Login failed for u@gmail.com: NO [ALERT] Too many simultaneous connections. (Failure)",
            "* BYE [ALERT] Too many simultaneous connections. (Failure)",
            "NO [ALERT] too many connections",
        ] {
            assert!(is_transient_refusal(e), "{e}");
        }
    }

    #[test]
    fn everything_else_is_not() {
        for e in [
            "",
            "Login failed for u@example.test: NO [AUTHENTICATIONFAILED] Invalid credentials",
            "XOAUTH2 auth failed for u@x: NO Invalid credentials",
            "NO [ALERT] Account exceeded command or bandwidth limits. (Failure)",
            "Too many simultaneous connections",
            "NO [OVERQUOTA] full",
            "NO [TRYCREATE] no such mailbox",
            "UNAVAILABLE",
        ] {
            assert!(!is_transient_refusal(e), "{e}");
        }
    }
}
