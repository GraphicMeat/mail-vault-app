use base64::Engine;
use lettre::message::header::MessageId;
use lettre::message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;
use std::time::Duration;
use tracing::{info, warn};

use crate::graph::{GraphClient, SendMailError};
use crate::imap::ImapConfig;
use crate::net_activity::{NetEvent, Pending, Protocol};

#[derive(Debug, Deserialize)]
pub struct OutgoingAttachment {
    pub filename: String,
    /// Base64-encoded file content.
    pub content: String,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    /// Bare Content-ID for an inline image the HTML references as `cid:<value>`.
    /// Absent (or blank) means a regular attachment.
    #[serde(default)]
    pub cid: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OutgoingEmail {
    pub to: String,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub cc: Option<String>,
    pub bcc: Option<String>,
    #[serde(rename = "inReplyTo")]
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<OutgoingAttachment>>,
    /// The Message-ID to send under, brackets included: the id compose staged
    /// its local Sent copy with (`smtp_build_mime`). Without it the send built
    /// a second id, and the local copy never matched the server's. Used only
    /// when `safe_message_id` accepts it; otherwise one is generated.
    #[serde(default, rename = "messageId")]
    pub message_id: Option<String>,
}

/// A caller-supplied Message-ID goes into a header verbatim (lettre does not
/// check it), so only a plain `<left@right>` of printable ASCII is taken: no
/// whitespace or control bytes (a CRLF would inject a header), no brackets
/// inside, exactly one `@` with text on both sides, and RFC 5322's 998-byte
/// line limit well clear.
fn safe_message_id(id: &str) -> bool {
    let Some(inner) = id.strip_prefix('<').and_then(|s| s.strip_suffix('>')) else { return false };
    let Some((left, right)) = inner.split_once('@') else { return false };
    id.len() <= 255
        && !left.is_empty()
        && !right.is_empty()
        && !right.contains('@')
        && inner.bytes().all(|b| b.is_ascii_graphic() && b != b'<' && b != b'>')
}

/// Send result with message ID and raw RFC2822 bytes for Sent folder append.
pub struct SendResult {
    pub message_id: String,
    pub raw_rfc2822: Vec<u8>,
    /// The server filed its own Sent copy (Microsoft Graph does): there is
    /// nothing to APPEND, and no IMAP to APPEND over.
    pub server_saved_sent: bool,
}

/// Built but not-yet-sent MIME — lets callers stage the raw bytes in Drafts
/// before handing the Message to `send_built`.
#[derive(Clone)]
pub struct BuiltMime {
    pub message: lettre::Message,
    pub raw_rfc2822: Vec<u8>,
}

/// Split a recipient line on commas, but never inside a quoted display name
/// (`"Doe, John" <j@d.com>`) or inside angle brackets. A naive split turns an
/// address-book name with a comma into two broken recipients.
fn split_address_line(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut in_angle = false;
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if in_quotes => {
                current.push(ch);
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            '<' if !in_quotes => {
                in_angle = true;
                current.push(ch);
            }
            '>' if !in_quotes => {
                in_angle = false;
                current.push(ch);
            }
            ',' if !in_quotes && !in_angle => {
                if !current.trim().is_empty() {
                    out.push(current.trim().to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// Parse a comma-separated recipient string into a list of mailboxes.
/// Empty entries (e.g. trailing commas, "a, ,b") are skipped so a stray
/// comma doesn't cause a send failure.
fn parse_address_list(raw: &str) -> Result<Vec<Mailbox>, String> {
    let mut out = Vec::new();
    for trimmed in split_address_line(raw) {
        let mb: Mailbox = trimmed
            .parse()
            .map_err(|e| format!("{} ({})", e, trimmed))?;
        out.push(mb);
    }
    Ok(out)
}

/// Build the MIME message without sending. Lets callers stage raw bytes in
/// Drafts via IMAP APPEND before the SMTP submission.
pub fn build_mime(account: &ImapConfig, email: &OutgoingEmail) -> Result<BuiltMime, String> {
    build_mime_opts(account, email, false)
}

/// A compose send builds its MIME twice over the wire: `smtp_build_mime` stages
/// the local Sent copy, then `smtp_send_email` sends the same message. With a
/// 6 MB attachment that second build is seconds of base64 decode and encode,
/// and it re-stamps `Date:`, so the sent bytes differ from the staged copy's.
/// `build_mime_staged` keeps the build for `send_email` to pick up instead.
struct Staged {
    /// Content fingerprint with the Message-ID left out: the send names the id
    /// the build chose, the build request did not carry one.
    key: u64,
    message_id: String,
    at: std::time::Instant,
    built: BuiltMime,
}

static STAGED: std::sync::Mutex<Vec<Staged>> = std::sync::Mutex::new(Vec::new());
/// Each entry holds the message twice (bytes and `Message`), so only a few.
const STAGED_MAX: usize = 3;
/// Past the longest undo-send delay (5 min), with room for a slow compose.
const STAGED_TTL: Duration = Duration::from_secs(30 * 60);

/// What the build is a function of. Anything not in here cannot change the
/// bytes, and anything in here that differs means the staged build is stale.
fn staging_key(account: &ImapConfig, email: &OutgoingEmail) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&account.email, account.from_address(), &account.name).hash(&mut h);
    (&email.to, &email.subject, &email.text, &email.html).hash(&mut h);
    (&email.cc, &email.bcc, &email.in_reply_to, &email.references).hash(&mut h);
    for a in email.attachments.iter().flatten() {
        (&a.filename, &a.content, &a.content_type, &a.cid).hash(&mut h);
    }
    h.finish()
}

/// `build_mime`, remembering the result for the `send_email` that follows it.
pub fn build_mime_staged(account: &ImapConfig, email: &OutgoingEmail) -> Result<BuiltMime, String> {
    let built = build_mime(account, email)?;
    if let Some(message_id) = message_id_of(&built.raw_rfc2822) {
        let key = staging_key(account, email);
        let mut staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
        staged.retain(|s| s.key != key && s.at.elapsed() < STAGED_TTL);
        staged.push(Staged { key, message_id, at: std::time::Instant::now(), built: built.clone() });
        let over = staged.len().saturating_sub(STAGED_MAX);
        staged.drain(..over);
    }
    Ok(built)
}

/// The staged build for this exact message, if there is one. Only a send that
/// names the staged Message-ID can take it (the id is how the local copy and
/// the server's stay one message), and it can be taken once.
fn take_staged(account: &ImapConfig, email: &OutgoingEmail) -> Option<BuiltMime> {
    let wanted = email.message_id.as_deref()?;
    let key = staging_key(account, email);
    let mut staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
    staged.retain(|s| s.at.elapsed() < STAGED_TTL);
    let at = staged.iter().position(|s| s.key == key && s.message_id == wanted)?;
    Some(staged.remove(at).built)
}

/// Same bytes, for a message that is not going anywhere yet.
///
/// A draft is usually recipient-less for a while — most people write the body
/// before the address — and `build_mime` refuses that, both here and inside
/// lettre, which derives an SMTP envelope at build time and rejects an empty
/// one. Autosave passes `allow_no_recipients: true`: the envelope is forced to
/// the sender (it is never submitted, and it is not part of the bytes), and
/// with no recipients there is simply no `To:` header — an honest draft rather
/// than one addressed to a placeholder.
pub fn build_draft_mime(account: &ImapConfig, email: &OutgoingEmail) -> Result<BuiltMime, String> {
    build_mime_opts(account, email, true)
}

fn build_mime_opts(
    account: &ImapConfig,
    email: &OutgoingEmail,
    allow_no_recipients: bool,
) -> Result<BuiltMime, String> {
    // Identity, not credentials: `from_address()` honours the per-account
    // send-as override. Authentication still uses `account.email`.
    let from_address = account.from_address();
    let from_mailbox: Mailbox = {
        let addr: lettre::Address = from_address.parse()
            .map_err(|e| format!("Invalid from email: {}", e))?;
        // Compose falls back to the address as the display name when none is
        // set. lettre RFC 2047-encodes such a name (`@` is not atom-safe) and
        // Purelymail rejects that header ("501 5.1.7 Invalid or unparseable
        // From address"). A name that is just an address says nothing: drop
        // it, and never let it name the login under a send-as override.
        let name = account.name.as_deref().map(str::trim).filter(|n| {
            !n.is_empty() && !n.eq_ignore_ascii_case(from_address) && !n.eq_ignore_ascii_case(&account.email)
        });
        Mailbox::new(name.map(String::from), addr)
    };

    let to_mailboxes = parse_address_list(&email.to)
        .map_err(|e| format!("Invalid to address: {}", e))?;
    let no_recipients =
        to_mailboxes.is_empty() && email.cc.as_deref().unwrap_or("").trim().is_empty()
            && email.bcc.as_deref().unwrap_or("").trim().is_empty();
    if to_mailboxes.is_empty() && !allow_no_recipients {
        return Err("Invalid to address: no recipients".to_string());
    }

    // Generate a stable Message-ID header. lettre does NOT auto-add one; without
    // it, recipient servers may flag the mail, and we cannot dedupe the
    // optimistic local Sent entry against the server copy by Message-ID header.
    // Message-ID domain follows the From address, not the login — receivers'
    // DMARC/spam heuristics read the From domain.
    //
    // The angle brackets are ours to add: `Message::builder().message_id(Some(v))`
    // is a raw passthrough (lettre only wraps on the `None` branch, where it
    // generates its own id), and RFC 5322 §3.6.4 requires `msg-id = "<" ... ">"`.
    let domain = from_address.splitn(2, '@').nth(1).unwrap_or("mailvault.local");
    let requested = email.message_id.as_deref().filter(|id| {
        let ok = safe_message_id(id);
        if !ok {
            warn!("[smtp] ignoring an unsafe caller Message-ID ({} bytes); generating one", id.len());
        }
        ok
    });
    let msg_id_value = match requested {
        Some(id) => id.to_string(),
        None => format!(
            "<{}.{}@{}>",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            rand::random::<u32>(),
            domain
        ),
    };

    let mut builder = Message::builder()
        .from(from_mailbox.clone())
        .subject(&email.subject)
        .message_id(Some(msg_id_value.clone()));
    if no_recipients {
        // lettre derives the envelope from the headers and refuses an empty
        // one. Force it to the sender: a draft is never submitted, and the
        // envelope never reaches the bytes we write to the vault.
        builder = builder.envelope(
            lettre::address::Envelope::new(Some(from_mailbox.email.clone()), vec![from_mailbox.email.clone()])
                .map_err(|e| format!("Failed to build draft envelope: {}", e))?,
        );
    }
    for mb in to_mailboxes {
        builder = builder.to(mb);
    }
    // Silence unused-import warning for MessageId — we depend on it only to
    // prove at compile time that the header type exists in the current lettre.
    let _phantom_header: Option<MessageId> = None;

    if let Some(ref cc) = email.cc {
        if let Ok(list) = parse_address_list(cc) {
            for mb in list {
                builder = builder.cc(mb);
            }
        }
    }

    if let Some(ref bcc) = email.bcc {
        if let Ok(list) = parse_address_list(bcc) {
            for mb in list {
                builder = builder.bcc(mb);
            }
        }
    }

    if let Some(ref reply_to) = email.in_reply_to {
        if !reply_to.is_empty() {
            builder = builder.in_reply_to(reply_to.clone());
        }
    }

    if let Some(ref refs) = email.references {
        if !refs.is_empty() {
            builder = builder.references(refs.clone());
        }
    }

    // Inline images (cid set) nest with the body inside multipart/related;
    // everything else hangs off multipart/mixed. A blank cid is a regular
    // attachment — the HTML has nothing to reference it by.
    let all_attachments: &[OutgoingAttachment] = email.attachments.as_deref().unwrap_or(&[]);
    let (inline, regular): (Vec<&OutgoingAttachment>, Vec<&OutgoingAttachment>) = all_attachments
        .iter()
        .partition(|a| a.cid.as_deref().map_or(false, |c| !c.trim().is_empty()));

    let decoded = |att: &OutgoingAttachment| -> Result<(Vec<u8>, ContentType), String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(att.content.as_bytes())
            .map_err(|e| format!("Invalid base64 for attachment '{}': {}", att.filename, e))?;
        let ct = att
            .content_type
            .as_deref()
            .and_then(|s| ContentType::parse(s).ok())
            .unwrap_or_else(|| ContentType::parse("application/octet-stream").unwrap());
        Ok((bytes, ct))
    };

    // Helper: assemble the body-only section (what the reader sees as the message).
    let body_multipart = if email.html.is_some() && email.text.is_some() {
        Some(
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .body(email.text.clone().unwrap_or_default()),
                )
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_HTML)
                        .body(email.html.clone().unwrap_or_default()),
                ),
        )
    } else {
        None
    };

    // The body as it gets wrapped: related() and mixed() need `.multipart()` for
    // one and `.singlepart()` for the other.
    enum Body {
        Single(SinglePart),
        Multi(MultiPart),
    }

    let message = if inline.is_empty() && regular.is_empty() {
        // No attachments: unchanged top-level shape.
        if let Some(body) = body_multipart {
            builder
                .multipart(body)
                .map_err(|e| format!("Failed to build multipart message: {}", e))?
        } else if let Some(ref html) = email.html {
            builder
                .header(ContentType::TEXT_HTML)
                .body(html.clone())
                .map_err(|e| format!("Failed to build HTML message: {}", e))?
        } else {
            builder
                .header(ContentType::TEXT_PLAIN)
                .body(email.text.clone().unwrap_or_default())
                .map_err(|e| format!("Failed to build text message: {}", e))?
        }
    } else {
        let mut body = match body_multipart {
            Some(m) => Body::Multi(m),
            None => Body::Single(match email.html {
                Some(ref html) => SinglePart::builder()
                    .header(ContentType::TEXT_HTML)
                    .body(html.clone()),
                None => SinglePart::builder()
                    .header(ContentType::TEXT_PLAIN)
                    .body(email.text.clone().unwrap_or_default()),
            }),
        };

        if !inline.is_empty() {
            // multipart/related: body + each inline image, so the HTML's
            // `cid:` references resolve against siblings, not attachments.
            let mut related = MultiPart::related().build();
            related = match body {
                Body::Multi(m) => related.multipart(m),
                Body::Single(s) => related.singlepart(s),
            };
            for att in &inline {
                let (bytes, ct) = decoded(att)?;
                let cid = att.cid.as_deref().unwrap_or_default().trim().to_string();
                related = related.singlepart(
                    Attachment::new_inline_with_name(cid, att.filename.clone()).body(bytes, ct),
                );
            }
            body = Body::Multi(related);
        }

        if !regular.is_empty() {
            // multipart/mixed: body (possibly the related part) + each attachment.
            let mut mixed = MultiPart::mixed().build();
            mixed = match body {
                Body::Multi(m) => mixed.multipart(m),
                Body::Single(s) => mixed.singlepart(s),
            };
            for att in &regular {
                let (bytes, ct) = decoded(att)?;
                mixed = mixed.singlepart(Attachment::new(att.filename.clone()).body(bytes, ct));
            }
            body = Body::Multi(mixed);
        }

        match body {
            Body::Multi(m) => builder
                .multipart(m)
                .map_err(|e| format!("Failed to build multipart message: {}", e))?,
            // Unreachable — one of the two lists is non-empty in this branch.
            Body::Single(s) => builder
                .singlepart(s)
                .map_err(|e| format!("Failed to build message: {}", e))?,
        }
    };

    let raw_rfc2822 = message.formatted();
    Ok(BuiltMime { message, raw_rfc2822 })
}

/// Decide implicit-TLS (wrapper) vs STARTTLS. Port 465 is implicit TLS
/// (RFC 8314) whatever the flag says: the account form saves `smtpSecure:false`
/// without asking, so a stored false carries no choice. `Some(true)` forces the
/// wrapper on any other port.
fn use_implicit_tls(smtp_secure: Option<bool>, smtp_port: u16) -> bool {
    smtp_port == 465 || smtp_secure == Some(true)
}

/// True if `host` is a loopback literal (127.0.0.1/::1/localhost). Used to allow
/// self-signed TLS certs for local bridges (e.g. Proton Mail Bridge on
/// 127.0.0.1:1025) without weakening TLS validation for real remote hosts.
/// Literal check only — no DNS resolution.
fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// `MAILVAULT_SMTP_PLAINTEXT=1` drops the TLS requirement so tests can point the
/// client at a plaintext mock SMTP server. Honored ONLY for loopback hosts (the
/// caller pairs it with `is_loopback_host`) — otherwise the variable would be a
/// TLS-downgrade vector in a shipped binary. Same hatch, same rule, as
/// `MAILVAULT_IMAP_PLAINTEXT` on the IMAP side.
fn plaintext_requested() -> bool {
    std::env::var("MAILVAULT_SMTP_PLAINTEXT").as_deref() == Ok("1")
}

/// True when the server refused the *sender* identity rather than the login or
/// the recipient. Providers word this differently (Postfix "Sender address
/// rejected", Fastmail "not owned by", Microsoft "SendAsDenied", Gmail "not
/// allowed to send as"), so match on the phrases rather than the status code —
/// bare 550 is also "recipient mailbox unavailable" and must not be caught.
fn is_send_as_rejection(lower: &str) -> bool {
    const MARKERS: [&str; 7] = [
        "sender address rejected",
        "not owned by",
        "sendasdenied",
        "not allowed to send as",
        "sender not allowed",
        "sender address is not",
        "553",
    ];
    MARKERS.iter().any(|m| lower.contains(m))
}

/// Map a raw lettre SMTP error string to a human-readable message. Kept pure
/// (takes the stringified error) so the classification is unit-testable.
/// `from_addr` is the identity we tried to send as — the send-as branch names
/// it, because "which address was refused" is the whole question there.
fn friendly_smtp_error(host: &str, port: u16, from_addr: &str, err_str: &str) -> String {
    let lower = err_str.to_lowercase();
    // Ordered before the auth branch: a send-as refusal often carries "5.7.1
    // ... authorized", which would otherwise read as a password problem.
    if is_send_as_rejection(&lower) {
        format!(
            "{} refused to send as {} — the address must be an alias this login is authorized to send from.",
            host, from_addr
        )
    } else if lower.contains("auth") || lower.contains("535") || lower.contains("credential") {
        format!(
            "Authentication failed for {}:{} — check your email and password.",
            host, port
        )
    } else if lower.contains("timed out") || lower.contains("timeout") {
        format!("Connection to {}:{} timed out.", host, port)
    } else if lower.contains("dns") || lower.contains("resolve") || lower.contains("lookup") {
        format!("Could not resolve SMTP host {}.", host)
    } else {
        format!("SMTP connection to {}:{} failed: {}", host, port, err_str)
    }
}

/// What a send says when only a new sign-in can help (a Graph token Microsoft
/// refused, a scheduled send's expired token that could not be renewed). Also
/// the marker `is_terminal_send_error` reads, so the two never drift.
pub const SIGN_IN_AGAIN: &str = "Sign in to this account again under Settings, Accounts, then try again.";

/// The size refusal's marker, likewise.
const GRAPH_SIZE_LIMIT: &str = "the limit is 4 MB";

/// The marker of a Graph send that got no answer after the request left: the
/// message may have gone out, so it is never sent again on its own.
const MAY_HAVE_GONE_OUT: &str = "the message may have gone out";

/// Map a Graph `sendMail` failure to what the user reads. Never the SMTP
/// "Authentication failed for smtp.office365.com" wording: no SMTP server was
/// involved. `from_addr` is the identity sent as, `login` the account.
fn friendly_graph_send_error(login: &str, from_addr: &str, err: &SendMailError) -> String {
    match err {
        SendMailError::TooLarge { encoded_bytes } => format!(
            "This message is too large to send through Microsoft: {:.1} MB once encoded, and {}. Remove some attachments and try again.",
            *encoded_bytes as f64 / (1024.0 * 1024.0),
            GRAPH_SIZE_LIMIT
        ),
        // The request left, and no answer came: Graph may have taken it, and
        // a second try would send it twice. Only Sent can tell.
        SendMailError::Transport { maybe_sent: true, timed_out, .. } => format!(
            "{}. Check Sent before trying again: {}.",
            if *timed_out {
                "Microsoft did not answer the send in time (timed out)"
            } else {
                "The connection to Microsoft broke before it confirmed the send"
            },
            MAY_HAVE_GONE_OUT
        ),
        SendMailError::Transport { detail, .. } => format!("Could not reach Microsoft to send the message: {}", detail),
        SendMailError::Refused { status, code, message, retry_after } => {
            let said = format!("{} {}", code.as_deref().unwrap_or(""), message.as_deref().unwrap_or("")).to_lowercase();
            // Ordered before the 403 branch: Graph refuses a sender with 403 too.
            if said.contains("sendasdenied") {
                format!(
                    "Microsoft refused to send as {}. The address must be one this account is allowed to send from.",
                    from_addr
                )
            } else if matches!(status, 401 | 403) {
                format!("Microsoft did not accept the sign-in for {} when sending. {}", login, SIGN_IN_AGAIN)
            } else if *status == 413 {
                format!("This message is too large to send through Microsoft: {}. Remove some attachments and try again.", GRAPH_SIZE_LIMIT)
            } else if *status == 429 {
                match retry_after {
                    Some(secs) => format!(
                        "Microsoft is limiting how much this account can send right now (HTTP 429). Try again in {} seconds.",
                        secs
                    ),
                    None => "Microsoft is limiting how much this account can send right now (HTTP 429). Try again in a few minutes."
                        .to_string(),
                }
            } else if *status >= 500 {
                format!("Microsoft could not send the message right now (HTTP {}). Try again in a moment.", status)
            } else {
                let detail = [code.as_deref(), message.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(": ");
                if detail.is_empty() {
                    format!("Microsoft did not accept the message (HTTP {}).", status)
                } else {
                    format!("Microsoft did not accept the message (HTTP {}: {}).", status, detail)
                }
            }
        }
    }
}

/// A send failure no retry may follow: a login the server refused, a sender
/// it will not send as, a message over Graph's size limit, and a Graph send
/// that may already have gone out (a retry would send it twice). Everything
/// else (a connection that never opened, a throttle, a server fault) is worth
/// another try. Scheduled Send's retry ladder reads this.
pub fn is_terminal_send_error(msg: &str) -> bool {
    msg.contains("Authentication failed for")
        || msg.contains("refused to send as")
        || msg.contains(SIGN_IN_AGAIN)
        || msg.contains(GRAPH_SIZE_LIMIT)
        || msg.contains(MAY_HAVE_GONE_OUT)
}

/// `raw` with a `Bcc:` header naming `bcc`, unless it already has one (then it
/// is the message's own and is left alone) or there is no one to name.
///
/// Graph has no envelope: it reads recipients off the headers, so a Bcc kept
/// out of the bytes (lettre's default, and what a frozen scheduled message
/// holds) is a recipient who gets nothing. The header is lettre's own
/// encoding (RFC 2047 names, folded lines), placed at the end of the header
/// block.
fn with_bcc_header(raw: Vec<u8>, bcc: &[Mailbox]) -> Vec<u8> {
    if bcc.is_empty() {
        return raw;
    }
    // The first blank line ends the header block, whichever line ending it
    // has: a CRLF one further down a bare-LF message is in its body.
    let crlf_end = raw.windows(4).position(|w| w == b"\r\n\r\n");
    let lf_end = raw.windows(2).position(|w| w == b"\n\n");
    let (block_end, crlf) = match (crlf_end, lf_end) {
        (Some(c), Some(l)) if l < c => (Some(l + 1), false),
        (Some(c), _) => (Some(c + 2), true),
        (None, Some(l)) => (Some(l + 1), false),
        (None, None) => (None, true),
    };
    let block = &raw[..block_end.unwrap_or(0)];
    let has_bcc = block
        .split(|b| *b == b'\n')
        .any(|line| line.len() >= 4 && line[..4].eq_ignore_ascii_case(b"bcc:"));
    if has_bcc {
        return raw;
    }
    let mut headers = lettre::message::header::Headers::new();
    headers.set(lettre::message::header::Bcc::from(bcc.iter().cloned().collect::<lettre::message::Mailboxes>()));
    let mut line = headers.to_string();
    if !crlf {
        line = line.replace("\r\n", "\n");
    }
    let at = block_end.unwrap_or(0);
    let mut out = Vec::with_capacity(raw.len() + line.len());
    out.extend_from_slice(&raw[..at]);
    out.extend_from_slice(line.as_bytes());
    out.extend_from_slice(&raw[at..]);
    out
}

/// The Message-ID header's value as written (brackets kept), if any.
fn message_id_of(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    text.lines()
        .take_while(|l| !l.is_empty())
        .find(|l| l.to_ascii_lowercase().starts_with("message-id:"))
        .map(|l| l.splitn(2, ':').nth(1).unwrap_or("").trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Send through Microsoft Graph instead of SMTP. An Outlook.com account signed
/// in with Microsoft holds a Graph token that SMTP refuses (discussion #22),
/// so `send_built` and `send_raw` both branch here for it, before anything
/// asks for an SMTP host it does not need.
async fn send_via_graph(account: &ImapConfig, raw: Vec<u8>, bcc: &[Mailbox]) -> Result<SendResult, String> {
    let raw = with_bcc_header(raw, bcc);
    let Some(token) = account.access_token.as_deref().filter(|t| !t.is_empty()) else {
        return Err(format!("There is no Microsoft sign-in for {} to send with. {}", account.email, SIGN_IN_AGAIN));
    };
    // The SMTP path's budget: a minute, plus a second per 50 KB, capped.
    let timeout = Duration::from_secs(60 + (raw.len() / 50_000) as u64).min(Duration::from_secs(600));
    info!("[smtp] Sending {} bytes via Microsoft Graph (sendMail)", raw.len());

    let client = GraphClient::for_send(token).for_account(&account.email);
    client
        .send_mime(&raw, timeout)
        .await
        .map_err(|e| friendly_graph_send_error(&account.email, account.from_address(), &e))?;

    let message_id = message_id_of(&raw).unwrap_or_default();
    info!("Email sent via Microsoft Graph: {}", message_id);
    Ok(SendResult { message_id, raw_rfc2822: raw, server_saved_sent: true })
}

/// Build the lettre async SMTP transport (TLS mode by flag/port + credentials).
/// Shared by send and the connectivity test so the two never drift.
fn build_transport(
    account: &ImapConfig,
    io_timeout: Duration,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?;
    let smtp_port = account.smtp_port.unwrap_or(587);

    let transport = if plaintext_requested() && is_loopback_host(smtp_host) {
        warn!(
            "[smtp] MAILVAULT_SMTP_PLAINTEXT=1 — TLS DISABLED for loopback {}:{}",
            smtp_host, smtp_port
        );
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(smtp_host)
            .port(smtp_port)
            .timeout(Some(io_timeout))
    } else {
        if plaintext_requested() {
            warn!("[smtp] MAILVAULT_SMTP_PLAINTEXT=1 ignored — {} is not loopback", smtp_host);
        }
        let mut tls_builder = TlsParameters::builder(smtp_host.to_string());
        if is_loopback_host(smtp_host) {
            // ponytail: local bridges (Proton Mail Bridge) use self-signed certs; loopback-only.
            tls_builder = tls_builder.dangerous_accept_invalid_certs(true);
        }
        let tls_params = tls_builder
            .build_rustls()
            .map_err(|e| format!("TLS params error: {}", e))?;

        if use_implicit_tls(account.smtp_secure, smtp_port) {
            AsyncSmtpTransport::<Tokio1Executor>::relay(smtp_host)
                .map_err(|e| format!("SMTP relay error: {}", e))?
                .port(smtp_port)
                .tls(Tls::Wrapper(tls_params))
                .timeout(Some(io_timeout))
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(smtp_host)
                .map_err(|e| format!("SMTP STARTTLS relay error: {}", e))?
                .port(smtp_port)
                .tls(Tls::Required(tls_params))
                .timeout(Some(io_timeout))
        }
    };

    let transport = if account.is_oauth2() {
        let token = account
            .access_token
            .as_deref()
            .ok_or_else(|| "OAuth2 access token missing for SMTP".to_string())?;
        // Login address, deliberately NOT from_address() — a send-as override
        // changes the identity on the envelope, never who we authenticate as.
        transport
            .credentials(Credentials::new(account.email.clone(), token.to_string()))
            .authentication(vec![Mechanism::Xoauth2])
            .build()
    } else {
        let password = account
            .password
            .as_deref()
            .ok_or_else(|| "Password missing for SMTP".to_string())?;
        // Login address, deliberately NOT from_address() — see above.
        transport
            .credentials(Credentials::new(account.email.clone(), password.to_string()))
            .build()
    };

    Ok(transport)
}

/// One Network Activity event for one SMTP conversation (lettre connects
/// per send), recorded when dropped: set its result once the send settles.
fn smtp_event(account: &ImapConfig, host: &str, port: u16, purpose: &str, bytes_up: u64) -> Pending {
    let mut ev = NetEvent::out(Protocol::Smtp, host, port, purpose);
    ev.account = Some(account.email.clone());
    ev.bytes_up = bytes_up;
    Pending::new(ev)
}

fn settle<T, E: std::fmt::Display>(mut conn: Pending, out: &Result<T, E>) {
    conn.ev.result = match out {
        Ok(_) => "ok".into(),
        Err(e) => e.to_string(),
    };
}

/// Verify SMTP connectivity + auth handshake without sending mail. Uses
/// lettre's `test_connection` (EHLO + handshake) on the built transport.
pub async fn test_connection(account: &ImapConfig) -> Result<(), String> {
    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?
        .to_string();
    let smtp_port = account.smtp_port.unwrap_or(587);

    let transport = build_transport(account, Duration::from_secs(15))?;

    let conn = smtp_event(account, &smtp_host, smtp_port, "account setup", 0);
    let tested = test_outcome(transport.test_connection().await, account, &smtp_host, smtp_port);
    settle(conn, &tested);
    tested
}

/// lettre's `test_connection` answer as a result: `Ok(false)`, a server that
/// did not accept the connection, is a failure, on the page as for the caller.
fn test_outcome<E: std::fmt::Display>(
    tested: Result<bool, E>,
    account: &ImapConfig,
    host: &str,
    port: u16,
) -> Result<(), String> {
    match tested {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("SMTP server {}:{} did not accept the connection.", host, port)),
        Err(e) => Err(friendly_smtp_error(host, port, account.from_address(), &e.to_string())),
    }
}

/// Send a pre-built MIME message via SMTP, or via Microsoft Graph for a Graph
/// account (`send_via_graph`). Returns the server response line as
/// `message_id` (existing behavior preserved) and echoes the raw bytes so the
/// caller can APPEND to Sent post-success.
pub async fn send_built(
    account: &ImapConfig,
    email: &OutgoingEmail,
    built: BuiltMime,
) -> Result<SendResult, String> {
    if account.uses_graph() {
        // The Bcc `build_mime` put on the envelope, which lettre left out of
        // the bytes. A list that does not parse it dropped, and so does this.
        let bcc = email.bcc.as_deref().and_then(|b| parse_address_list(b).ok()).unwrap_or_default();
        return send_via_graph(account, built.raw_rfc2822, &bcc).await;
    }
    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?;
    let smtp_port = account.smtp_port.unwrap_or(587);

    let attachment_bytes: usize = email
        .attachments
        .as_ref()
        .map(|v| v.iter().map(|a| a.content.len()).sum())
        .unwrap_or(0);
    let io_timeout = Duration::from_secs(60 + (attachment_bytes / 50_000) as u64).min(Duration::from_secs(600));

    let transport = build_transport(account, io_timeout)?;

    info!(
        "[smtp] Sending via {}:{} (implicit_tls={}, oauth2={})",
        smtp_host,
        smtp_port,
        use_implicit_tls(account.smtp_secure, smtp_port),
        account.is_oauth2()
    );

    let BuiltMime { message, raw_rfc2822 } = built;

    let conn = smtp_event(account, smtp_host, smtp_port, "send", raw_rfc2822.len() as u64);
    let sent = transport.send(message).await;
    settle(conn, &sent);
    let response =
        sent.map_err(|e| friendly_smtp_error(smtp_host, smtp_port, account.from_address(), &e.to_string()))?;

    let message_id = response
        .message()
        .collect::<Vec<_>>()
        .join("");

    info!("Email sent via SMTP: {}", message_id);
    Ok(SendResult { message_id, raw_rfc2822, server_saved_sent: false })
}

/// Convenience: build + send in one call. Preserved for callers that don't
/// need Drafts staging.
pub async fn send_email(account: &ImapConfig, email: &OutgoingEmail) -> Result<SendResult, String> {
    let built = match take_staged(account, email) {
        Some(staged) => {
            info!("[send:reuse_staged_mime] bytes={}", staged.raw_rfc2822.len());
            staged
        }
        None => build_mime(account, email)?,
    };
    send_built(account, email, built).await
}

/// The recipients a frozen `.eml` was addressed to, kept alongside it because
/// `send_raw` (below) has no `lettre::Message` to read them back out of.
/// Comma-separated, same shape as `OutgoingEmail`'s own `to`/`cc`/`bcc`.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenEnvelope {
    pub from: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub cc: String,
    #[serde(default)]
    pub bcc: String,
}

/// Send bytes that were built and frozen at an earlier time (Scheduled Send)
/// rather than just now.
///
/// `send_built`/`send_email` call `transport.send(message)`, and lettre's
/// default `send()` re-derives both the envelope AND the raw bytes from the
/// `lettre::Message` object at send time (`message.formatted()`,
/// `message.envelope()`) — there is no "replay this `Message` verbatim" mode,
/// and no constructor that parses a `Message` back out of raw `.eml` bytes.
/// That makes `send_built` unusable for a message frozen to disk in an
/// earlier process: the whole point of freezing is to replay the exact bytes,
/// and a `Message` object does not survive a restart. `send_raw` goes
/// straight to `AsyncTransport::send_raw(envelope, bytes)` instead, so the
/// envelope has to travel with the frozen bytes (`FrozenEnvelope`, stored
/// alongside them) rather than being read back off a `Message`. A Graph
/// account sends the same bytes through `send_via_graph`, the envelope's Bcc
/// written into them.
pub async fn send_raw(account: &ImapConfig, envelope: &FrozenEnvelope, raw_rfc2822: Vec<u8>) -> Result<SendResult, String> {
    let from: lettre::Address = envelope
        .from
        .parse()
        .map_err(|e| format!("Invalid from address '{}': {}", envelope.from, e))?;
    let parse_group = |group: &str| -> Result<Vec<Mailbox>, String> {
        if group.trim().is_empty() {
            return Ok(Vec::new());
        }
        parse_address_list(group).map_err(|e| format!("Invalid recipient address: {}", e))
    };
    let bcc = parse_group(&envelope.bcc)?;
    let mut to: Vec<lettre::Address> = Vec::new();
    for group in [&envelope.to, &envelope.cc] {
        to.extend(parse_group(group)?.into_iter().map(|mb| mb.email));
    }
    to.extend(bcc.iter().map(|mb| mb.email.clone()));
    if to.is_empty() {
        return Err("Invalid to address: no recipients".to_string());
    }
    if account.uses_graph() {
        // The frozen bytes were built without the Bcc header; it lives in the
        // envelope, and Graph only reads headers.
        return send_via_graph(account, raw_rfc2822, &bcc).await;
    }

    let smtp_host = account
        .smtp_host
        .as_deref()
        .ok_or_else(|| "SMTP host not configured".to_string())?;
    let smtp_port = account.smtp_port.unwrap_or(587);
    let io_timeout = Duration::from_secs(60 + (raw_rfc2822.len() / 50_000) as u64).min(Duration::from_secs(600));
    let transport = build_transport(account, io_timeout)?;

    let lettre_envelope =
        lettre::address::Envelope::new(Some(from), to).map_err(|e| format!("Failed to build envelope: {}", e))?;

    info!(
        "[smtp] Sending a frozen message ({} bytes) via {}:{} (implicit_tls={}, oauth2={})",
        raw_rfc2822.len(),
        smtp_host,
        smtp_port,
        use_implicit_tls(account.smtp_secure, smtp_port),
        account.is_oauth2()
    );

    let conn = smtp_event(account, smtp_host, smtp_port, "send", raw_rfc2822.len() as u64);
    let sent = transport.send_raw(&lettre_envelope, &raw_rfc2822).await;
    settle(conn, &sent);
    let response =
        sent.map_err(|e| friendly_smtp_error(smtp_host, smtp_port, account.from_address(), &e.to_string()))?;

    let message_id = response.message().collect::<Vec<_>>().join("");
    info!("Frozen email sent via SMTP: {}", message_id);
    Ok(SendResult { message_id, raw_rfc2822, server_saved_sent: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Network Activity: a server that did not accept the connection test is
    /// recorded as a failure, not "ok".
    #[test]
    fn a_refused_connection_test_is_not_recorded_as_ok() {
        let acc = account("okfalse@mock.test", None);
        let tested = test_outcome(Ok::<bool, String>(false), &acc, "okfalse.test", 25);
        assert!(tested.is_err());
        settle(smtp_event(&acc, "okfalse.test", 25, "test: smtp refused", 0), &tested);
        let e = crate::net_activity::snapshot()
            .into_iter()
            .find(|e| e.purpose == "test: smtp refused")
            .expect("recorded");
        assert_ne!(e.result, "ok");
        assert!(e.result.contains("did not accept"), "{}", e.result);
        assert_eq!(test_outcome(Ok::<bool, String>(true), &acc, "okfalse.test", 25), Ok(()));
    }

    #[test]
    fn implicit_tls_explicit_true_forces_wrapper() {
        assert!(use_implicit_tls(Some(true), 587)); // explicit true overrides port
        assert!(!use_implicit_tls(Some(false), 587));
    }

    #[test]
    fn implicit_tls_on_465_even_when_flag_says_false() {
        // The account form saves smtpSecure:false for every account; STARTTLS on
        // 465 meets a TLS server and fails with "incomplete response" (discussion #21).
        assert!(use_implicit_tls(Some(false), 465));
    }

    #[test]
    fn implicit_tls_inferred_from_port_when_unset() {
        assert!(use_implicit_tls(None, 465)); // 465 = implicit TLS
        assert!(!use_implicit_tls(None, 587)); // 587 = STARTTLS
        assert!(!use_implicit_tls(None, 25));
    }

    #[test]
    fn loopback_host_detection() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("LOCALHOST"));
        assert!(!is_loopback_host("smtp.gmail.com"));
    }

    #[test]
    fn error_mapping_classifies_auth_timeout_dns() {
        assert!(friendly_smtp_error("smtp.x.com", 587, "me@x.com", "535 Authentication failed")
            .contains("Authentication failed"));
        assert!(friendly_smtp_error("smtp.x.com", 587, "me@x.com", "operation timed out")
            .contains("timed out"));
        assert!(friendly_smtp_error("smtp.x.com", 587, "me@x.com", "failed to lookup address")
            .contains("resolve"));
    }

    #[test]
    fn error_mapping_falls_back_to_raw() {
        let msg = friendly_smtp_error("smtp.x.com", 465, "me@x.com", "some weird io error");
        assert!(msg.contains("smtp.x.com:465"));
        assert!(msg.contains("some weird io error"));
    }

    // ── draft MIME ───────────────────────────────────────────────────────

    #[test]
    fn draft_mime_builds_without_a_recipient() {
        let mut email = outgoing();
        email.to = String::new();
        email.subject = "Half written".to_string();

        // The send-side builder refuses it — a message with nowhere to go must
        // never reach SMTP.
        assert!(build_mime(&account("me@x.com", None), &email).is_err());

        // The draft builder writes it anyway: most drafts are recipient-less
        // for a while. No `To:` header rather than a placeholder one.
        let built = build_draft_mime(&account("me@x.com", None), &email).expect("build_draft_mime");
        let raw = String::from_utf8_lossy(&built.raw_rfc2822);
        let headers = raw.split("\r\n\r\n").next().unwrap_or("");
        assert!(!headers.to_lowercase().contains("\nto:"));
        assert!(headers.contains("From: \"Test User\" <me@x.com>"));
        assert!(headers.contains("Subject: Half written"));
        assert!(raw.contains("body"));
    }

    #[test]
    fn draft_mime_keeps_the_recipients_it_has() {
        let built = build_draft_mime(&account("me@x.com", None), &outgoing()).expect("build_draft_mime");
        let raw = String::from_utf8_lossy(&built.raw_rfc2822);
        assert!(raw.contains("To: someone@example.com"));
    }

    // ── send-as identity ─────────────────────────────────────────────────

    fn account(email: &str, from_email: Option<&str>) -> ImapConfig {
        ImapConfig {
            email: email.to_string(),
            password: Some("pw".to_string()),
            host: "imap.fastmail.com".to_string(),
            port: None,
            secure: None,
            security: None,
            auth_type: None,
            access_token: None,
            smtp_host: Some("smtp.fastmail.com".to_string()),
            smtp_port: Some(587),
            smtp_secure: Some(false),
            name: Some("Test User".to_string()),
            oauth2_transport: None,
            from_email: from_email.map(String::from),
        }
    }

    fn outgoing() -> OutgoingEmail {
        OutgoingEmail {
            to: "someone@example.com".to_string(),
            subject: "Hi".to_string(),
            text: Some("body".to_string()),
            html: None,
            cc: None,
            bcc: None,
            in_reply_to: None,
            references: None,
            attachments: None,
            message_id: None,
        }
    }

    fn headers_of(cfg: &ImapConfig) -> String {
        let built = build_mime(cfg, &outgoing()).expect("build_mime");
        String::from_utf8_lossy(&built.raw_rfc2822).to_string()
    }

    #[test]
    fn address_list_skips_empty_segments() {
        let out = parse_address_list("a@b.com, , c@d.com,").unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].email.to_string(), "a@b.com");
        assert_eq!(out[1].email.to_string(), "c@d.com");
    }

    #[test]
    fn address_list_keeps_commas_inside_quoted_display_names() {
        let out = parse_address_list("\"Doe, John\" <j@d.com>, a@b.com").unwrap();
        assert_eq!(out.len(), 2, "got: {:?}", out);
        assert_eq!(out[0].email.to_string(), "j@d.com");
        assert_eq!(out[0].name.as_deref(), Some("Doe, John"));
        assert_eq!(out[1].email.to_string(), "a@b.com");
    }

    #[test]
    fn address_list_keeps_commas_inside_angle_brackets() {
        // Malformed but unambiguous — never split a <...> group.
        let out = parse_address_list("John <j@d.com>, Jane <jane@d.com>").unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].email.to_string(), "jane@d.com");
    }

    #[test]
    fn address_list_names_the_broken_fragment_on_error() {
        // Unquoted comma in a display name is still an error — the message
        // must name the fragment so the user can see what to fix.
        let err = parse_address_list("Doe, John <j@d.com>").unwrap_err();
        assert!(err.contains("Doe"), "error was: {}", err);
    }

    fn from_line(raw: &str) -> String {
        raw.lines()
            .find(|l| l.starts_with("From:"))
            .unwrap_or_else(|| panic!("no From header in: {}", raw))
            .to_string()
    }

    #[test]
    fn from_header_uses_send_as_override() {
        let raw = headers_of(&account("ABC@fastmail.fm", Some("DEF@fastmail.fm")));
        let from = from_line(&raw);
        assert!(from.contains("<DEF@fastmail.fm>"), "From was: {}", from);
        assert!(from.contains("Test User"), "From was: {}", from);
        assert!(!raw.contains("ABC@fastmail.fm"), "login leaked into headers: {}", raw);
        // The reporter explicitly does not want a Reply-To — we must not add one.
        assert!(!raw.to_lowercase().contains("reply-to:"));
    }

    #[test]
    fn from_header_falls_back_to_login() {
        for override_value in [None, Some(""), Some("   ")] {
            let raw = headers_of(&account("ABC@fastmail.fm", override_value));
            assert!(
                from_line(&raw).contains("<ABC@fastmail.fm>"),
                "override {:?} produced: {}", override_value, raw
            );
        }
    }

    fn named(email: &str, from_email: Option<&str>, name: &str) -> ImapConfig {
        ImapConfig { name: Some(name.to_string()), ..account(email, from_email) }
    }

    #[test]
    fn from_header_drops_a_name_that_is_the_address() {
        // Compose falls back to the address when no display name is set. lettre
        // RFC 2047-encodes it (`@` is not atom-safe), and Purelymail rejects
        // that header with "501 5.1.7 Invalid or unparseable From address".
        for name in ["prime@graphicmeat.com", "PRIME@graphicmeat.com", " prime@graphicmeat.com "] {
            let raw = headers_of(&named("prime@graphicmeat.com", None, name));
            assert_eq!(from_line(&raw), "From: prime@graphicmeat.com", "name {:?}", name);
        }
    }

    #[test]
    fn from_header_drops_a_name_that_is_the_login_under_send_as() {
        // The same fallback under a send-as override names the login, which
        // would both break the header and leak the login address.
        let raw = headers_of(&named("ABC@fastmail.fm", Some("DEF@fastmail.fm"), "ABC@fastmail.fm"));
        assert_eq!(from_line(&raw), "From: DEF@fastmail.fm");
        assert!(!raw.contains("ABC@fastmail.fm"), "login leaked into headers: {}", raw);
    }

    #[test]
    fn from_header_drops_a_blank_name() {
        let raw = headers_of(&named("me@x.com", None, "   "));
        assert_eq!(from_line(&raw), "From: me@x.com");
    }

    #[test]
    fn from_header_keeps_a_real_name() {
        let raw = headers_of(&named("prime@graphicmeat.com", None, "Rokas"));
        let from = from_line(&raw);
        assert!(from.contains("Rokas") && from.ends_with("<prime@graphicmeat.com>"), "From was: {}", from);
    }

    fn message_id_line(raw: &str) -> String {
        raw.lines()
            .find(|l| l.to_lowercase().starts_with("message-id:"))
            .unwrap_or_else(|| panic!("no Message-ID header in: {}", raw))
            .to_string()
    }

    #[test]
    fn message_id_domain_follows_from_address() {
        let raw = headers_of(&account("ABC@fastmail.fm", Some("hello@graphicmeat.com")));
        let msg_id = message_id_line(&raw);
        assert!(msg_id.contains("@graphicmeat.com"), "message-id was: {}", msg_id);
        assert!(!msg_id.contains("@fastmail.fm"), "message-id was: {}", msg_id);
    }

    #[test]
    fn message_id_is_bracketed() {
        // RFC 5322 §3.6.4: `msg-id = "<" id-left "@" id-right ">"`. lettre's
        // `.message_id(Some(v))` passes the value through verbatim, so an
        // unbracketed `v` ships an unbracketed — malformed — header.
        let raw = headers_of(&account("ABC@fastmail.fm", Some("hello@graphicmeat.com")));
        let value = message_id_line(&raw)
            .splitn(2, ':')
            .nth(1)
            .expect("message-id value")
            .trim()
            .to_string();
        assert!(value.starts_with('<'), "message-id was: {}", value);
        assert!(value.ends_with('>'), "message-id was: {}", value);
        // Brackets must wrap the whole addr-spec, not just decorate one end.
        let inner = &value[1..value.len() - 1];
        assert!(!inner.contains('<') && !inner.contains('>'), "message-id was: {}", value);
        assert!(inner.contains('@'), "message-id was: {}", value);
    }

    /// Built from JSON on purpose: this is the shape compose sends over the
    /// wire (`messageId` beside the rest), and it is what the daemon parses.
    fn outgoing_with_id(message_id: &str) -> OutgoingEmail {
        serde_json::from_value(serde_json::json!({
            "to": "someone@example.com", "subject": "Hi", "text": "body", "messageId": message_id,
        }))
        .expect("OutgoingEmail from JSON")
    }

    fn message_id_value(raw: &str) -> String {
        message_id_line(raw).splitn(2, ':').nth(1).unwrap_or("").trim().to_string()
    }

    /// One message, one Message-ID: compose stages its local Sent copy under
    /// the id `smtp_build_mime` gave it, and the copy that goes out (and the
    /// server's Sent copy, and every reply to it) must carry that same id, or
    /// nothing can ever match the local copy to the server's.
    #[test]
    fn a_caller_message_id_is_reused_verbatim() {
        let built = build_mime(&account("me@x.com", None), &outgoing_with_id("<staged.42@x.com>")).expect("build_mime");
        let raw = String::from_utf8_lossy(&built.raw_rfc2822).to_string();
        assert_eq!(message_id_value(&raw), "<staged.42@x.com>", "{raw}");
    }

    /// The id arrives from the frontend and lands in a header verbatim (lettre
    /// does not check it), so anything that is not a plain `<left@right>` is
    /// dropped for a fresh one — a CRLF in it would be a header injection.
    #[test]
    fn an_unsafe_message_id_is_replaced_by_a_generated_one() {
        let long = format!("<{}@x.com>", "a".repeat(990));
        let bad = [
            "<a@x.com>\r\nBcc: evil@attacker.test",
            "<a@x.com>\nBcc: evil@attacker.test",
            "a@x.com",
            "<a b@x.com>",
            "<a\t@x.com>",
            "<nodomain>",
            "<@x.com>",
            "<a@>",
            "<a@b@x.com>",
            "<<a@x.com>>",
            "<a@x.com",
            "<ä@x.com>",
            "",
            long.as_str(),
        ];
        for id in bad {
            let built = build_mime(&account("me@x.com", None), &outgoing_with_id(id)).expect("build_mime");
            let raw = String::from_utf8_lossy(&built.raw_rfc2822).to_string();
            let value = message_id_value(&raw);
            assert_ne!(value, id, "unsafe id {id:?} was used");
            assert!(value.starts_with('<') && value.ends_with("@x.com>"), "id {id:?} produced {value}");
            assert!(!raw.to_lowercase().contains("evil@attacker.test"), "id {id:?} injected a header: {raw}");
        }
    }

    // ── staged build reuse ───────────────────────────────────────────────

    /// What compose does: stage the build with no id (the request carries
    /// none), then send the same fields under the id the build chose.
    fn staged_pair(subject: &str) -> (ImapConfig, OutgoingEmail, OutgoingEmail, BuiltMime) {
        let acct = account("me@x.com", None);
        let mut staged_email = outgoing();
        staged_email.subject = subject.to_string();
        let built = build_mime_staged(&acct, &staged_email).expect("build_mime_staged");
        let id = message_id_of(&built.raw_rfc2822).expect("built message has an id");
        let mut send_email = outgoing();
        send_email.subject = subject.to_string();
        send_email.message_id = Some(id);
        (acct, staged_email, send_email, built)
    }

    #[test]
    fn a_send_under_the_staged_id_takes_the_staged_build_once() {
        let (acct, _, send, built) = staged_pair("staged: take once");
        let taken = take_staged(&acct, &send).expect("the staged build is there");
        assert_eq!(taken.raw_rfc2822, built.raw_rfc2822);
        assert!(take_staged(&acct, &send).is_none(), "a staged build goes out once");
    }

    #[test]
    fn an_edited_message_does_not_take_the_staged_build() {
        let (acct, _, mut send, _) = staged_pair("staged: edited body");
        send.text = Some("a different body".to_string());
        assert!(take_staged(&acct, &send).is_none());
        let (acct, _, mut send, _) = staged_pair("staged: edited recipient");
        send.to = "other@example.com".to_string();
        assert!(take_staged(&acct, &send).is_none());
    }

    #[test]
    fn a_different_id_or_no_id_does_not_take_the_staged_build() {
        let (acct, _, mut send, _) = staged_pair("staged: other id");
        send.message_id = Some("<someone.else@x.com>".to_string());
        assert!(take_staged(&acct, &send).is_none());
        send.message_id = None;
        assert!(take_staged(&acct, &send).is_none());
    }

    #[test]
    fn a_different_sender_does_not_take_the_staged_build() {
        let (_, _, send, _) = staged_pair("staged: other sender");
        assert!(take_staged(&account("me@x.com", Some("alias@x.com")), &send).is_none());
    }

    #[test]
    fn the_staged_builds_are_capped() {
        let first = staged_pair("staged: cap 0");
        for i in 1..=STAGED_MAX {
            staged_pair(&format!("staged: cap {i}"));
        }
        assert!(take_staged(&first.0, &first.2).is_none(), "the oldest staged build is dropped");
    }

    #[test]
    fn from_address_helper_prefers_override() {
        assert_eq!(account("a@x.com", Some("b@x.com")).from_address(), "b@x.com");
        assert_eq!(account("a@x.com", None).from_address(), "a@x.com");
        assert_eq!(account("a@x.com", Some("  ")).from_address(), "a@x.com");
        assert_eq!(account("a@x.com", Some(" b@x.com ")).from_address(), "b@x.com");
    }

    #[test]
    fn error_mapping_flags_send_as_rejection() {
        let cases = [
            "550 5.7.1 Sender address rejected: not owned by user ABC@fastmail.fm",
            "553 5.7.1 <DEF@fastmail.fm>: Sender address rejected",
            "SendAsDenied; DEF@contoso.com not allowed to send as",
        ];
        for raw in cases {
            let msg = friendly_smtp_error("smtp.x.com", 587, "DEF@fastmail.fm", raw);
            assert!(msg.contains("refused to send as DEF@fastmail.fm"), "{} → {}", raw, msg);
        }
    }

    // ── Microsoft Graph send ─────────────────────────────────────────────

    fn refused(status: u16, code: Option<&str>, retry_after: Option<u64>) -> SendMailError {
        SendMailError::Refused { status, code: code.map(String::from), message: Some("refused".into()), retry_after }
    }

    /// Each Graph refusal in the user's terms, and whether Scheduled Send may
    /// try it again: sign-in, sender and size end the row, throttling, server
    /// faults and a timeout do not. None of it is the SMTP wording.
    #[test]
    fn graph_send_errors_are_worded_and_classified() {
        let word = |e: &SendMailError| friendly_graph_send_error("me@outlook.com", "alias@outlook.com", e);
        let cases = [
            (refused(401, Some("InvalidAuthenticationToken"), None), "Sign in to this account again", true),
            (refused(403, Some("ErrorAccessDenied"), None), "Sign in to this account again", true),
            (refused(403, Some("ErrorSendAsDenied"), None), "refused to send as alias@outlook.com", true),
            (refused(400, Some("ErrorSendAsDenied"), None), "refused to send as alias@outlook.com", true),
            (refused(413, None, None), "the limit is 4 MB", true),
            (SendMailError::TooLarge { encoded_bytes: 5 * 1024 * 1024 }, "5.0 MB once encoded, and the limit is 4 MB", true),
            (refused(429, Some("ApplicationThrottled"), Some(7)), "Try again in 7 seconds", false),
            (refused(429, None, None), "HTTP 429", false),
            (refused(500, Some("InternalServerError"), None), "HTTP 500", false),
            (refused(503, None, None), "HTTP 503", false),
            (refused(400, Some("ErrorInvalidRecipients"), None), "HTTP 400: ErrorInvalidRecipients: refused", false),
            // Graph may have taken it: never tried again, or it goes twice.
            (SendMailError::Transport { timed_out: true, maybe_sent: true, detail: "x".into() }, "may have gone out", true),
            (SendMailError::Transport { timed_out: false, maybe_sent: true, detail: "x".into() }, "may have gone out", true),
            // No connection was made: Graph cannot have it, so try again.
            (SendMailError::Transport { timed_out: true, maybe_sent: false, detail: "connect timed out".into() }, "connect timed out", false),
            (SendMailError::Transport { timed_out: false, maybe_sent: false, detail: "tcp connect error".into() }, "tcp connect error", false),
        ];
        for (err, want, terminal) in cases {
            let msg = word(&err);
            assert!(msg.contains(want), "{err:?} -> {msg}");
            assert_eq!(is_terminal_send_error(&msg), terminal, "{err:?} -> {msg}");
            assert!(!msg.contains("Authentication failed for"), "{msg}");
            assert!(!msg.contains('\u{2014}'), "no em dash in a new message: {msg}");
        }
        // The SMTP wordings keep their classification.
        assert!(is_terminal_send_error(&friendly_smtp_error("smtp.x.com", 587, "me@x.com", "535 Authentication failed")));
        assert!(is_terminal_send_error(&friendly_smtp_error("smtp.x.com", 587, "me@x.com", "SendAsDenied")));
        assert!(!is_terminal_send_error(&friendly_smtp_error("smtp.x.com", 587, "me@x.com", "operation timed out")));
    }

    /// A sign-in or throttle message must not read as the network being down
    /// (that would park the row as offline instead of classifying it).
    #[test]
    fn graph_refusal_wording_does_not_look_like_a_network_outage() {
        for err in [refused(401, None, None), refused(403, Some("ErrorSendAsDenied"), None), refused(429, None, Some(3)), refused(500, None, None)] {
            let msg = friendly_graph_send_error("me@outlook.com", "me@outlook.com", &err);
            assert!(!crate::net::looks_like_network_down(&msg), "{msg}");
        }
    }

    fn mailbox(s: &str) -> Mailbox {
        s.parse().unwrap()
    }

    #[test]
    fn bcc_header_is_added_at_the_end_of_the_header_block() {
        let raw = b"From: a@x.com\r\nTo: b@x.com\r\nSubject: s\r\n\r\nbody\r\n".to_vec();
        let out = String::from_utf8(with_bcc_header(raw, &[mailbox("c@x.com"), mailbox("D <d@x.com>")])).unwrap();
        assert_eq!(out, "From: a@x.com\r\nTo: b@x.com\r\nSubject: s\r\nBcc: c@x.com, D <d@x.com>\r\n\r\nbody\r\n");
    }

    #[test]
    fn bcc_header_follows_a_bare_lf_message() {
        let raw = b"From: a@x.com\nTo: b@x.com\n\nbody\n".to_vec();
        let out = String::from_utf8(with_bcc_header(raw, &[mailbox("c@x.com")])).unwrap();
        assert_eq!(out, "From: a@x.com\nTo: b@x.com\nBcc: c@x.com\n\nbody\n");
    }

    /// The header block ends at the first blank line, whatever its line
    /// ending: a bare-LF message whose body holds a CRLF blank line had the
    /// Bcc written into its body, where Graph never reads it.
    #[test]
    fn bcc_header_goes_at_the_first_blank_line_whatever_its_line_ending() {
        let lf = b"From: a@x.com\nTo: b@x.com\n\nbody\r\n\r\nmore\n".to_vec();
        let out = String::from_utf8(with_bcc_header(lf, &[mailbox("c@x.com")])).unwrap();
        assert_eq!(out, "From: a@x.com\nTo: b@x.com\nBcc: c@x.com\n\nbody\r\n\r\nmore\n");

        // The other way round already held: a CRLF message with a bare-LF
        // blank line in its body.
        let crlf = b"From: a@x.com\r\nTo: b@x.com\r\n\r\nbody\n\nmore\r\n".to_vec();
        let out = String::from_utf8(with_bcc_header(crlf, &[mailbox("c@x.com")])).unwrap();
        assert_eq!(out, "From: a@x.com\r\nTo: b@x.com\r\nBcc: c@x.com\r\n\r\nbody\n\nmore\r\n");
    }

    #[test]
    fn bcc_header_is_never_doubled_and_never_empty() {
        let has = b"From: a@x.com\r\nBCC: kept@x.com\r\n\r\nbody".to_vec();
        assert_eq!(with_bcc_header(has.clone(), &[mailbox("c@x.com")]), has, "an existing Bcc (any case) is the message's own");
        let none = b"From: a@x.com\r\n\r\nbody".to_vec();
        assert_eq!(with_bcc_header(none.clone(), &[]), none, "no Bcc recipients, no header");
        // A "bcc:" inside the body is not a header.
        let body_only = b"From: a@x.com\r\n\r\nbcc: not-a-header@x.com".to_vec();
        let out = String::from_utf8(with_bcc_header(body_only, &[mailbox("c@x.com")])).unwrap();
        assert!(out.starts_with("From: a@x.com\r\nBcc: c@x.com\r\n\r\n"), "{out}");
    }

    /// The SMTP path is untouched by the Graph branch: a non-Graph account
    /// without an SMTP host still fails on that, not by going to Graph.
    #[tokio::test]
    async fn a_non_graph_account_never_takes_the_graph_path() {
        let mut cfg = account("me@x.com", None);
        cfg.smtp_host = None;
        let built = build_mime(&cfg, &outgoing()).unwrap();
        let err = send_built(&cfg, &outgoing(), built).await.err().expect("no SMTP host");
        assert_eq!(err, "SMTP host not configured");
        assert!(!cfg.uses_graph());
    }

    // ── inline images (cid:) ─────────────────────────────────────────────

    fn attachment(filename: &str, content_type: &str, cid: Option<&str>) -> OutgoingAttachment {
        OutgoingAttachment {
            filename: filename.to_string(),
            // Valid base64; the bytes themselves don't matter here.
            content: "iVBORw0KGgo=".to_string(),
            content_type: Some(content_type.to_string()),
            cid: cid.map(String::from),
        }
    }

    fn raw_with(html: Option<&str>, attachments: Vec<OutgoingAttachment>) -> String {
        let mut email = outgoing();
        email.html = html.map(String::from);
        email.attachments = Some(attachments);
        let built = build_mime(&account("me@x.com", None), &email).expect("build_mime");
        String::from_utf8_lossy(&built.raw_rfc2822).to_string()
    }

    #[test]
    fn inline_attachment_builds_multipart_related() {
        let raw = raw_with(
            Some("<p>hi</p><img src=\"cid:logo1\">"),
            vec![attachment("logo.png", "image/png", Some("logo1"))],
        );
        assert!(raw.contains("multipart/related"), "{}", raw);
        assert!(raw.contains("Content-ID: <logo1>"), "{}", raw);
        assert!(raw.contains("Content-Disposition: inline"), "{}", raw);
        // The HTML must survive verbatim or the cid reference dangles.
        assert!(raw.contains("cid:logo1"), "{}", raw);
        // No regular attachments — nothing to wrap in mixed.
        assert!(!raw.contains("multipart/mixed"), "{}", raw);
    }

    #[test]
    fn inline_and_regular_attachments_nest_related_inside_mixed() {
        let raw = raw_with(
            Some("<p>hi</p><img src=\"cid:logo1\">"),
            vec![
                attachment("logo.png", "image/png", Some("logo1")),
                attachment("notes.pdf", "application/pdf", None),
            ],
        );
        let mixed = raw.find("multipart/mixed").expect("multipart/mixed missing");
        let related = raw.find("multipart/related").expect("multipart/related missing");
        assert!(mixed < related, "related must nest inside mixed: {}", raw);
        assert!(
            raw.contains("Content-Disposition: attachment; filename=\"notes.pdf\""),
            "{}",
            raw
        );
    }

    /// A signature logo as compose hands it over (extractInlineImages): the
    /// HTML points at it by cid, the part carries it. Readers that show the
    /// text part keep the words; the rest render the picture from the part,
    /// since Gmail and Outlook drop a data: URI. A scheduled send is frozen
    /// through `build_draft_mime`, so both builders are pinned.
    #[test]
    fn signature_logo_travels_as_an_inline_part_beside_the_text_alternative() {
        let mut email = outgoing();
        email.text = Some("Thanks!\n\n--\nRokas".to_string());
        email.html = Some(
            "<p>Thanks!</p><p></p><p>--</p><p>Rokas</p><p><img src=\"cid:sig-1@mailvault.inline\" alt=\"logo.png\"></p>"
                .to_string(),
        );
        email.attachments = Some(vec![attachment("logo.png", "image/png", Some("sig-1@mailvault.inline"))]);
        let cfg = account("me@x.com", None);
        for built in [build_mime(&cfg, &email).expect("build_mime"), build_draft_mime(&cfg, &email).expect("build_draft_mime")] {
            let raw = String::from_utf8_lossy(&built.raw_rfc2822).to_string();
            let related = raw.find("multipart/related").expect("multipart/related missing");
            let alternative = raw.find("multipart/alternative").expect("multipart/alternative missing");
            assert!(related < alternative, "the text/html pair must nest inside related: {}", raw);
            assert!(raw.contains("Content-Type: text/plain"), "{}", raw);
            assert!(raw.contains("Rokas"), "{}", raw);
            // The html part is quoted-printable: undo its soft line breaks.
            let unfolded = raw.replace("=\r\n", "").replace("=\n", "");
            assert!(unfolded.contains("cid:sig-1@mailvault.inline"), "{}", raw);
            assert!(raw.contains("Content-ID: <sig-1@mailvault.inline>"), "{}", raw);
            assert!(raw.contains("Content-Type: image/png"), "{}", raw);
            assert!(raw.contains("Content-Disposition: inline; filename=\"logo.png\""), "{}", raw);
            // The picture's bytes themselves, not a reference to them.
            assert!(raw.contains("iVBORw0KGgo="), "{}", raw);
            assert!(!raw.contains("data:image"), "{}", raw);
            // An inline logo is not a file the user attached.
            assert!(!raw.contains("multipart/mixed"), "{}", raw);
        }
    }

    #[test]
    fn regular_attachment_without_cid_keeps_mixed_shape() {
        let raw = raw_with(None, vec![attachment("notes.pdf", "application/pdf", None)]);
        assert!(raw.contains("multipart/mixed"), "{}", raw);
        assert!(!raw.contains("multipart/related"), "{}", raw);
    }

    #[test]
    fn blank_cid_is_a_regular_attachment() {
        let raw = raw_with(None, vec![attachment("notes.pdf", "application/pdf", Some("  "))]);
        assert!(!raw.contains("multipart/related"), "{}", raw);
        assert!(raw.contains("Content-Disposition: attachment"), "{}", raw);
    }

    #[test]
    fn error_mapping_does_not_flag_recipient_550() {
        // Bare 550 is also "recipient mailbox unavailable" — must not be
        // reported as a sender-identity problem.
        let msg = friendly_smtp_error("smtp.x.com", 587, "DEF@fastmail.fm",
            "550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown");
        assert!(!msg.contains("refused to send as"), "{}", msg);
    }

    // ── the wire, against the mock SMTP server ──────────────────────────────────
    //
    // Everything above tests what we BUILD; these test what a real SMTP server
    // sees and what comes back. The e2e harness leans on exactly this pairing —
    // `MAILVAULT_SMTP_PLAINTEXT=1` plus `mock-imap`'s SMTP listener — and an e2e
    // cycle on the runner is fifteen minutes, so the handshake is pinned here.

    mod wire_tests {
        use super::super::*;
        use super::{account, outgoing};
        use mock_imap::{MockImap, Scenario};

        /// The hatch is a process-wide env var and cargo runs these in parallel.
        static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

        fn config_for(server: &MockImap) -> ImapConfig {
            let mut cfg = account("luke@mock.test", None);
            cfg.smtp_host = Some("127.0.0.1".to_string());
            cfg.smtp_port = Some(server.smtp_port());
            cfg.smtp_secure = Some(false);
            cfg
        }

        async fn send_to(server: &MockImap, to: &str) -> Result<SendResult, String> {
            let cfg = config_for(server);
            let mut email = outgoing();
            email.to = to.to_string();
            email.subject = "Wire subject".to_string();
            let built = build_mime(&cfg, &email).expect("build_mime");
            send_built(&cfg, &email, built).await
        }

        #[tokio::test]
        async fn a_send_succeeds_against_the_mock_and_the_server_holds_the_message() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
            let server = MockImap::start(Scenario::new());

            let result = send_to(&server, "partner@example.com").await;
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");
            let result = result.expect("send against the mock SMTP server");
            assert!(!result.raw_rfc2822.is_empty());

            // The bytes the server took in are the message we built, not a
            // paraphrase of it — dot-stuffing and the terminator both undone.
            let sent = server.sent_messages();
            assert_eq!(sent.len(), 1, "commands: {:?}", server.smtp_commands());
            let raw = String::from_utf8_lossy(&sent[0]).to_string();
            assert!(raw.contains("Subject: Wire subject"), "{}", raw);
            assert!(raw.contains("To: partner@example.com"), "{}", raw);
            assert!(raw.contains("From: \"Test User\" <luke@mock.test>"), "{}", raw);

            // It authenticated on the way in — a mock that skipped AUTH would let a
            // broken credential path pass unnoticed.
            let log = server.smtp_commands();
            assert!(log.iter().any(|l| l.starts_with("AUTH")), "{:?}", log);
            assert!(log.iter().any(|l| l.starts_with("RCPT TO:<partner@example.com>")), "{:?}", log);
        }

        /// Network Activity: one SMTP event per send, bytes up = the message,
        /// the account named by its address.
        #[tokio::test]
        async fn a_send_records_one_smtp_event_with_the_message_size() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
            let server = MockImap::start(Scenario::new());

            let result = send_to(&server, "partner@example.com").await;
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");
            let result = result.expect("send against the mock SMTP server");

            let events: Vec<_> = crate::net_activity::snapshot()
                .into_iter()
                .filter(|e| e.protocol == Protocol::Smtp && e.port == server.smtp_port())
                .collect();
            assert_eq!(events.len(), 1, "{events:?}");
            let e = &events[0];
            assert_eq!(e.purpose, "send");
            assert_eq!(e.result, "ok");
            assert_eq!(e.host, "127.0.0.1");
            assert_eq!(e.direction, crate::net_activity::Direction::Out);
            assert_eq!(e.bytes_up, result.raw_rfc2822.len() as u64);
            assert_eq!(e.account.as_deref(), Some("luke@mock.test"), "the page names the account");
        }

        /// What the SMTP server takes in carries the id compose staged the
        /// local copy under — `send_email` builds its own MIME, and used to
        /// mint a second id for it.
        #[tokio::test]
        async fn send_email_delivers_the_caller_message_id() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
            let server = MockImap::start(Scenario::new());
            let cfg = config_for(&server);
            let email: OutgoingEmail = serde_json::from_value(serde_json::json!({
                "to": "partner@example.com", "subject": "Wire subject", "text": "body",
                "messageId": "<staged.7@mock.test>",
            }))
            .unwrap();

            let result = send_email(&cfg, &email).await;
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");
            let result = result.expect("send against the mock SMTP server");

            let sent = server.sent_messages();
            assert_eq!(sent.len(), 1);
            let raw = String::from_utf8_lossy(&sent[0]).to_string();
            assert!(raw.contains("Message-ID: <staged.7@mock.test>\r\n"), "{raw}");
            // And the bytes handed back for the Sent APPEND are those same bytes.
            assert_eq!(result.raw_rfc2822, sent[0]);
        }

        /// compose stages the build (`smtp_build_mime`) and then sends: the send
        /// goes out as those staged bytes, not as a second build. The server's
        /// copy, the Sent APPEND and the local copy are then one message.
        #[tokio::test]
        async fn send_email_sends_the_staged_build_instead_of_rebuilding() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
            let server = MockImap::start(Scenario::new());
            let cfg = config_for(&server);
            let mut email = outgoing();
            email.to = "partner@example.com".to_string();
            email.subject = "wire: staged reuse".to_string();
            let built = build_mime_staged(&cfg, &email).expect("build_mime_staged");
            email.message_id = message_id_of(&built.raw_rfc2822);

            let result = send_email(&cfg, &email).await;
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");
            let result = result.expect("send against the mock SMTP server");

            assert!(take_staged(&cfg, &email).is_none(), "send_email must consume the staged build, not rebuild");
            let sent = server.sent_messages();
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0], built.raw_rfc2822);
            assert_eq!(result.raw_rfc2822, built.raw_rfc2822);
        }

        /// SMTP carries Bcc on the envelope only. The Graph path puts a Bcc
        /// header into the MIME (Graph has no envelope); none of that may leak
        /// into what an SMTP server is handed, or every recipient sees it.
        #[tokio::test]
        async fn the_smtp_path_keeps_bcc_off_the_message_and_on_the_envelope() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
            let server = MockImap::start(Scenario::new());
            let cfg = config_for(&server);
            let mut email = outgoing();
            email.to = "partner@example.com".to_string();
            email.bcc = Some("Hidden Person <hidden@example.com>".to_string());

            let built = build_mime(&cfg, &email).expect("build_mime");
            let result = send_built(&cfg, &email, built).await;
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");
            result.expect("send against the mock SMTP server");

            let sent = server.sent_messages();
            assert_eq!(sent.len(), 1);
            let raw = String::from_utf8_lossy(&sent[0]).to_string();
            let headers = raw.split("\r\n\r\n").next().unwrap_or("").to_lowercase();
            assert!(!headers.contains("\nbcc:") && !headers.starts_with("bcc:"), "{raw}");
            assert!(!raw.contains("hidden@example.com"), "{raw}");
            let log = server.smtp_commands();
            assert!(log.iter().any(|l| l.starts_with("RCPT TO:<hidden@example.com>")), "{log:?}");
        }

        #[tokio::test]
        async fn a_refused_recipient_fails_the_send_and_leaves_nothing_behind() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
            let server = MockImap::start(Scenario::new().smtp_refuse("@refused.test"));

            let result = send_to(&server, "bounce@refused.test").await;
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");

            let Err(err) = result else { panic!("a 550 at RCPT TO must fail the send") };
            assert!(err.contains("550") || err.to_lowercase().contains("reject"), "{}", err);
            // The refusal is the whole point: nothing may reach the server.
            assert!(server.sent_messages().is_empty());
        }

        /// The scheduled-send path: build once, freeze the bytes, then send
        /// those exact bytes through `send_raw` rather than through the
        /// `Message` object `send_built` would re-serialize.
        #[tokio::test]
        async fn send_raw_delivers_the_exact_frozen_bytes() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
            let server = MockImap::start(Scenario::new());
            let cfg = config_for(&server);

            let mut email = outgoing();
            email.to = "partner@example.com".to_string();
            let built = build_mime(&cfg, &email).expect("build_mime");
            let frozen = built.raw_rfc2822.clone();

            let envelope = FrozenEnvelope {
                from: cfg.from_address().to_string(),
                to: "partner@example.com".to_string(),
                ..Default::default()
            };
            let result = send_raw(&cfg, &envelope, frozen.clone()).await;
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");
            result.expect("send_raw against the mock SMTP server");

            let sent = server.sent_messages();
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0], frozen, "the server must receive the exact frozen bytes, not a re-serialization");
        }

        #[tokio::test]
        async fn send_raw_with_no_recipients_is_an_error_and_nothing_is_sent() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
            let server = MockImap::start(Scenario::new());
            let cfg = config_for(&server);
            let envelope = FrozenEnvelope { from: cfg.from_address().to_string(), ..Default::default() };

            let result = send_raw(&cfg, &envelope, b"From: a@b.com\r\n\r\nbody".to_vec()).await;
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");

            let Err(err) = result else { panic!("no to/cc/bcc must refuse to send") };
            assert!(err.contains("no recipients"), "{err}");
            assert!(server.sent_messages().is_empty());
        }

        #[tokio::test]
        async fn without_the_env_hatch_the_plaintext_server_is_refused() {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::remove_var("MAILVAULT_SMTP_PLAINTEXT");
            let server = MockImap::start(Scenario::new());

            // STARTTLS is required by default and the mock does not offer it, so a
            // shipped binary cannot be talked into plaintext by the port alone.
            let Err(err) = send_to(&server, "partner@example.com").await else {
                panic!("STARTTLS is required by default — a plaintext server must not be used")
            };
            assert!(!err.is_empty());
            assert!(server.sent_messages().is_empty(), "a message crossed an unencrypted link");
        }
    }
}
