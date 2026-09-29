//! What a server error means for a long-running job: wait, back off, pause for
//! a sign-in, or count against one message.
//!
//! `imap::is_bandwidth_limited` matches "exceeded bandwidth" or "throttled",
//! which misses Gmail's "Account exceeded command or bandwidth limits", and
//! nothing classifies `[ALERT] Too many simultaneous connections`. This
//! classifier is ABD's own so the shared IMAP helpers stay untouched.

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Signal {
    ProviderLimit,
    Throttled,
    TooManyConnections,
    SignIn,
    ConnectionLost,
    Timeout,
    Gone,
    Other,
}

/// Classify an IMAP error string. All matches are on the lowercased text.
pub fn classify_imap(err: &str) -> Signal {
    let e = err.to_ascii_lowercase();
    if e.contains("exceeded bandwidth") || e.contains("bandwidth limits") || e.contains("[overquota]") {
        return Signal::ProviderLimit;
    }
    if e.contains("throttled") {
        return Signal::Throttled;
    }
    if e.contains("too many simultaneous connections") {
        return Signal::TooManyConnections;
    }
    if e.contains("login failed for")
        || e.contains("xoauth2 auth failed for")
        || e.contains("oauth2 access token missing")
        || e.contains("password missing")
    {
        return Signal::SignIn;
    }
    if crate::imap::pool::is_connection_lost(err) {
        return Signal::ConnectionLost;
    }
    if e.contains("timed out") {
        return Signal::Timeout;
    }
    if e.contains("not found") {
        return Signal::Gone;
    }
    Signal::Other
}

/// Classify a Graph error string and read its `retry_after` (seconds) if the
/// call formatted one as `(429:retry_after=N)`.
pub fn classify_graph(err: &str) -> (Signal, Option<u64>) {
    let e = err.to_ascii_lowercase();
    if e.contains("(401)") {
        return (Signal::SignIn, None);
    }
    if let Some(at) = e.find("(429:retry_after=") {
        let rest = &e[at + "(429:retry_after=".len()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        return (Signal::Throttled, digits.parse::<u64>().ok());
    }
    if e.contains("(429)") || e.contains("(429:") {
        return (Signal::Throttled, None);
    }
    if e.contains("(503)") || e.contains("(504)") {
        return (Signal::Throttled, None);
    }
    if e.contains("(404)") {
        return (Signal::Gone, None);
    }
    if e.contains("timed out") || e.contains("timeout") {
        return (Signal::Timeout, None);
    }
    if e.contains("error sending request") || e.contains("connection") || e.contains("dns error") {
        return (Signal::ConnectionLost, None);
    }
    (Signal::Other, None)
}
