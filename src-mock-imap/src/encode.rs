//! Render FETCH response items from raw RFC 5322 bytes.
//!
//! Nothing here is hand-authored per fixture: ENVELOPE, BODYSTRUCTURE,
//! RFC822.SIZE and BODY[...] are all derived from the stored `.eml` bytes with
//! `mailparse`. Fixtures stay readable email text; this module is the only
//! thing that has to get IMAP wire syntax right.

use crate::state::Message;
use mailparse::ParsedMail;

/// IMAP quoted-string.
pub fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// IMAP nstring: NIL or quoted-string.
pub fn nstring(v: Option<&str>) -> String {
    match v {
        Some(s) => quoted(s),
        None => "NIL".to_string(),
    }
}

/// nstring that falls back to a literal for values a quoted-string cannot hold
/// (8-bit bytes, CR/LF). Real servers do this; a quoted-string with raw UTF-8 is
/// not valid IMAP and clients are within their rights to reject it.
pub fn nstring_bytes(v: Option<&str>) -> Vec<u8> {
    let Some(s) = v else {
        return b"NIL".to_vec();
    };
    let quotable = s.is_ascii() && !s.contains(['\r', '\n']);
    if quotable {
        return quoted(s).into_bytes();
    }
    let mut out = format!("{{{}}}\r\n", s.len()).into_bytes();
    out.extend_from_slice(s.as_bytes());
    out
}

/// Raw header value, unfolded — **not** RFC 2047 decoded.
///
/// `mailparse`'s `get_first_value` decodes encoded-words, which is exactly wrong
/// here: a server sends `=?UTF-8?B?...?=` on the wire and decoding it is the
/// client's job — the job several of these tests exist to check.
fn header(mail: &ParsedMail, name: &str) -> Option<String> {
    let (head, _) = split_headers(mail.raw_bytes);
    let text = String::from_utf8_lossy(head);
    let mut value: Option<String> = None;

    for line in text.split("\r\n") {
        let is_continuation = line.starts_with(' ') || line.starts_with('\t');
        if is_continuation {
            if let Some(v) = value.as_mut() {
                v.push(' ');
                v.push_str(line.trim());
                continue;
            }
            continue;
        }
        if value.is_some() {
            break; // header complete — first occurrence wins
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(name) {
                value = Some(v.trim().to_string());
            }
        }
    }
    value.filter(|v| !v.is_empty())
}

// ── ENVELOPE ────────────────────────────────────────────────────────────────

/// One IMAP address: `("name" "adl" "mailbox" "host")`
fn addr(display: Option<&str>, email: &str) -> Vec<u8> {
    let (mailbox, host) = match email.split_once('@') {
        Some((m, h)) => (m, h),
        None => (email, ""),
    };
    let mut out = b"(".to_vec();
    out.extend_from_slice(&nstring_bytes(display));
    out.extend_from_slice(b" NIL ");
    out.extend_from_slice(&nstring_bytes(Some(mailbox)));
    out.push(b' ');
    out.extend_from_slice(&nstring_bytes(if host.is_empty() { None } else { Some(host) }));
    out.push(b')');
    out
}

/// Address list: `((...)(...))` or NIL when the header is absent.
fn addr_list(mail: &ParsedMail, name: &str) -> Vec<u8> {
    let Some(raw) = header(mail, name) else {
        return b"NIL".to_vec();
    };
    let Ok(parsed) = mailparse::addrparse(&raw) else {
        return b"NIL".to_vec();
    };

    let mut out: Vec<u8> = Vec::new();
    for entry in parsed.iter() {
        match entry {
            mailparse::MailAddr::Single(info) => {
                out.extend_from_slice(&addr(info.display_name.as_deref(), &info.addr));
            }
            mailparse::MailAddr::Group(group) => {
                // RFC 3501 group syntax: start marker, members, end marker.
                out.extend_from_slice(b"(NIL NIL ");
                out.extend_from_slice(&nstring_bytes(Some(&group.group_name)));
                out.extend_from_slice(b" NIL)");
                for info in &group.addrs {
                    out.extend_from_slice(&addr(info.display_name.as_deref(), &info.addr));
                }
                out.extend_from_slice(b"(NIL NIL NIL NIL)");
            }
        }
    }

    if out.is_empty() {
        return b"NIL".to_vec();
    }
    let mut wrapped = b"(".to_vec();
    wrapped.extend_from_slice(&out);
    wrapped.push(b')');
    wrapped
}

/// ENVELOPE, as bytes — header values stay raw (still RFC 2047 encoded) and
/// 8-bit values become literals, which is what real servers put on the wire.
pub fn envelope(mail: &ParsedMail) -> Vec<u8> {
    let from = addr_list(mail, "From");
    let sender = if header(mail, "Sender").is_some() {
        addr_list(mail, "Sender")
    } else {
        from.clone()
    };
    let reply_to = if header(mail, "Reply-To").is_some() {
        addr_list(mail, "Reply-To")
    } else {
        from.clone()
    };

    let mut out = b"(".to_vec();
    let parts: Vec<Vec<u8>> = vec![
        nstring_bytes(header(mail, "Date").as_deref()),
        nstring_bytes(header(mail, "Subject").as_deref()),
        from,
        sender,
        reply_to,
        addr_list(mail, "To"),
        addr_list(mail, "Cc"),
        addr_list(mail, "Bcc"),
        nstring_bytes(header(mail, "In-Reply-To").as_deref()),
        nstring_bytes(header(mail, "Message-ID").as_deref()),
    ];
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            out.push(b' ');
        }
        out.extend_from_slice(p);
    }
    out.push(b')');
    out
}

// ── BODYSTRUCTURE ───────────────────────────────────────────────────────────

/// Encoded body bytes of a part (everything after the header block).
fn body_bytes<'a>(part: &'a ParsedMail<'a>) -> &'a [u8] {
    let raw = part.raw_bytes;
    match raw.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(i) => &raw[i + 4..],
        None => match raw.windows(2).position(|w| w == b"\n\n") {
            Some(i) => &raw[i + 2..],
            None => &[],
        },
    }
}

fn params_list(pairs: &[(String, String)]) -> String {
    if pairs.is_empty() {
        return "NIL".to_string();
    }
    let inner: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{} {}", quoted(&k.to_uppercase()), quoted(v)))
        .collect();
    format!("({})", inner.join(" "))
}

/// `("ATTACHMENT" ("FILENAME" "x.pdf"))` — or NIL when no Content-Disposition.
fn disposition(part: &ParsedMail) -> String {
    let Some(raw) = header(part, "Content-Disposition") else {
        return "NIL".to_string();
    };
    let mut bits = raw.split(';');
    let ty = bits.next().unwrap_or("").trim().to_uppercase();
    let params: Vec<(String, String)> = bits
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((
                k.trim().to_string(),
                v.trim().trim_matches('"').to_string(),
            ))
        })
        .collect();
    format!("({} {})", quoted(&ty), params_list(&params))
}

pub fn bodystructure(part: &ParsedMail) -> String {
    let mime = part.ctype.mimetype.to_uppercase();
    let (ty, subty) = mime.split_once('/').unwrap_or((mime.as_str(), "PLAIN"));

    if ty == "MULTIPART" {
        let children: String = part.subparts.iter().map(bodystructure).collect();
        let boundary = part
            .ctype
            .params
            .get("boundary")
            .cloned()
            .unwrap_or_default();
        return format!(
            "({} {} ({} {}) {} NIL NIL)",
            children,
            quoted(subty),
            quoted("BOUNDARY"),
            quoted(&boundary),
            disposition(part),
        );
    }

    let body = body_bytes(part);
    let size = body.len();
    let enc = header(part, "Content-Transfer-Encoding").unwrap_or_else(|| "7BIT".into());
    let mut params: Vec<(String, String)> = part
        .ctype
        .params
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    params.sort();

    let head = format!(
        "{} {} {} {} {} {} {}",
        quoted(ty),
        quoted(subty),
        params_list(&params),
        nstring(header(part, "Content-ID").as_deref()),
        nstring(header(part, "Content-Description").as_deref()),
        quoted(&enc.to_uppercase()),
        size,
    );

    // Text parts carry an extra body-fld-lines field before the extensions.
    if ty == "TEXT" {
        let lines = body.iter().filter(|&&b| b == b'\n').count();
        format!("({} {} NIL {} NIL NIL)", head, lines, disposition(part))
    } else {
        format!("({} NIL {} NIL NIL)", head, disposition(part))
    }
}

// ── BODY[...] sections ──────────────────────────────────────────────────────

fn split_headers(raw: &[u8]) -> (&[u8], usize) {
    match raw.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(i) => (&raw[..i + 4], i + 4),
        None => (raw, raw.len()),
    }
}

/// `BODY[HEADER.FIELDS (A B C)]` — the named headers, in message order,
/// terminated by a blank line.
pub fn header_fields(raw: &[u8], wanted: &[String]) -> Vec<u8> {
    let (head, _) = split_headers(raw);
    let text = String::from_utf8_lossy(head);
    let wanted_lc: Vec<String> = wanted.iter().map(|w| w.to_lowercase()).collect();

    let mut out = String::new();
    let mut emitting = false;
    for line in text.split("\r\n") {
        let is_continuation = line.starts_with(' ') || line.starts_with('\t');
        if !is_continuation {
            let name = line.split(':').next().unwrap_or("").trim().to_lowercase();
            emitting = !name.is_empty() && wanted_lc.contains(&name);
        }
        if emitting && !line.is_empty() {
            out.push_str(line);
            out.push_str("\r\n");
        }
    }
    out.push_str("\r\n");
    out.into_bytes()
}

// ── FETCH item assembly ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum FetchItem {
    Uid,
    Flags,
    Envelope,
    InternalDate,
    Rfc822Size,
    BodyStructure,
    ModSeq,
    /// BODY[] / BODY.PEEK[] — whole message
    BodyFull { peek: bool },
    /// BODY[HEADER.FIELDS (...)]
    BodyHeaderFields { peek: bool, fields: Vec<String> },
}

/// Parse a FETCH spec such as
/// `(UID FLAGS ENVELOPE BODY.PEEK[HEADER.FIELDS (References Reply-To)])`.
/// A trailing modifier group like `(CHANGEDSINCE 5)` is not an item group and
/// is handled by the caller before this is called.
pub fn parse_fetch_spec(spec: &str) -> Vec<FetchItem> {
    let s = spec.trim().trim_start_matches('(').trim_end_matches(')');
    let bytes: Vec<char> = s.chars().collect();
    let mut items = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i].is_whitespace() {
            i += 1;
            continue;
        }
        // Read one item, keeping bracketed/parenthesised sections together.
        let start = i;
        let mut depth = 0usize;
        while i < bytes.len() {
            match bytes[i] {
                '[' | '(' => depth += 1,
                ']' | ')' => depth = depth.saturating_sub(1),
                c if c.is_whitespace() && depth == 0 => break,
                _ => {}
            }
            i += 1;
        }
        let token: String = bytes[start..i].iter().collect();
        if let Some(item) = parse_fetch_item(&token) {
            items.push(item);
        }
    }
    items
}

fn parse_fetch_item(token: &str) -> Option<FetchItem> {
    let upper = token.to_uppercase();
    match upper.as_str() {
        "UID" => return Some(FetchItem::Uid),
        "FLAGS" => return Some(FetchItem::Flags),
        "ENVELOPE" => return Some(FetchItem::Envelope),
        "INTERNALDATE" => return Some(FetchItem::InternalDate),
        "RFC822.SIZE" => return Some(FetchItem::Rfc822Size),
        "BODYSTRUCTURE" | "BODY" => return Some(FetchItem::BodyStructure),
        "MODSEQ" => return Some(FetchItem::ModSeq),
        _ => {}
    }

    let peek = upper.starts_with("BODY.PEEK[");
    if !peek && !upper.starts_with("BODY[") {
        return None;
    }
    let inner_start = token.find('[')? + 1;
    let inner_end = token.rfind(']')?;
    let section = &token[inner_start..inner_end];

    if section.trim().is_empty() {
        return Some(FetchItem::BodyFull { peek });
    }
    let sec_upper = section.to_uppercase();
    if sec_upper.starts_with("HEADER.FIELDS") {
        let list_start = section.find('(')?;
        let list_end = section.rfind(')')?;
        let fields = section[list_start + 1..list_end]
            .split_whitespace()
            .map(|f| f.to_string())
            .collect();
        return Some(FetchItem::BodyHeaderFields { peek, fields });
    }
    // Unsupported section — treat as whole message rather than dropping the item.
    Some(FetchItem::BodyFull { peek })
}

/// Render the data list for one message: `UID 3 FLAGS (\Seen) ...`
/// Returns bytes because BODY[...] items are IMAP literals containing raw email.
pub fn render_items(msg: &Message, items: &[FetchItem], force_uid: bool) -> Vec<u8> {
    let parsed = mailparse::parse_mail(&msg.raw).ok();
    let mut out: Vec<u8> = Vec::new();
    let mut wrote_uid = false;

    let push = |out: &mut Vec<u8>, s: &str| {
        if !out.is_empty() {
            out.push(b' ');
        }
        out.extend_from_slice(s.as_bytes());
    };

    for item in items {
        match item {
            FetchItem::Uid => {
                push(&mut out, &format!("UID {}", msg.uid));
                wrote_uid = true;
            }
            FetchItem::Flags => {
                push(&mut out, &format!("FLAGS ({})", msg.flags.join(" ")));
            }
            FetchItem::InternalDate => {
                push(&mut out, &format!("INTERNALDATE {}", quoted(&msg.internal_date)));
            }
            FetchItem::Rfc822Size => {
                push(&mut out, &format!("RFC822.SIZE {}", msg.raw.len()));
            }
            FetchItem::ModSeq => {
                push(&mut out, &format!("MODSEQ ({})", msg.modseq));
            }
            FetchItem::Envelope => {
                let v = parsed.as_ref().map(envelope).unwrap_or_else(|| b"NIL".to_vec());
                push(&mut out, "ENVELOPE ");
                out.extend_from_slice(&v);
            }
            FetchItem::BodyStructure => {
                let v = parsed
                    .as_ref()
                    .map(bodystructure)
                    .unwrap_or_else(|| "NIL".into());
                push(&mut out, &format!("BODYSTRUCTURE {}", v));
            }
            FetchItem::BodyFull { .. } => {
                push(&mut out, &format!("BODY[] {{{}}}\r\n", msg.raw.len()));
                out.extend_from_slice(&msg.raw);
            }
            FetchItem::BodyHeaderFields { fields, .. } => {
                let data = header_fields(&msg.raw, fields);
                let names = fields.join(" ");
                push(
                    &mut out,
                    &format!("BODY[HEADER.FIELDS ({})] {{{}}}\r\n", names, data.len()),
                );
                out.extend_from_slice(&data);
            }
        }
    }

    // A UID FETCH response must carry UID even if the client did not list it.
    if force_uid && !wrote_uid {
        let mut prefixed = format!("UID {}", msg.uid).into_bytes();
        if !out.is_empty() {
            prefixed.push(b' ');
            prefixed.extend_from_slice(&out);
        }
        return prefixed;
    }
    out
}
