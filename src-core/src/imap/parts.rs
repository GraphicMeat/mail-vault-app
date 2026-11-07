//! A message's MIME parts from its BODYSTRUCTURE, and one part's body by section, so a reader
//! can fetch the text of a message without downloading its attachments.
//!
//! Sections are numbered as RFC 3501 6.4.5 does: the children of a multipart are `1`, `2`, ...,
//! a nested multipart's children `2.1`, `2.2`, ..., and a non-multipart message's body is `1`.
//! Only leaves are listed. A `message/rfc822` part is a leaf here (a forwarded message is an
//! attachment); its insides are not walked.

use super::{patient, select_mailbox, uid_still_present, ImapSession};
use imap_proto::types::{AttributeValue, BodyContentCommon, BodyContentSinglePart, BodyStructure, ContentEncoding, SectionPath};

/// One leaf part of a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartInfo {
    /// RFC 3501 section, e.g. `1.2`.
    pub section: String,
    /// `type/subtype`, lowercase.
    pub mime: String,
    /// The disposition's `filename`, else the type's `name` (RFC 2047 words decoded).
    pub filename: Option<String>,
    /// Encoded size in octets, as the server counts it.
    pub size: u32,
    /// Transfer encoding, lowercase (`7bit`, `base64`, `quoted-printable`, ...).
    pub encoding: String,
    pub charset: Option<String>,
    /// Content-ID without its angle brackets.
    pub content_id: Option<String>,
    /// Disposition type, lowercase (`attachment`, `inline`).
    pub disposition: Option<String>,
}

/// Every leaf part of `bs`, in section order.
pub fn parts_of(bs: &BodyStructure) -> Vec<PartInfo> {
    let mut out = Vec::new();
    match bs {
        BodyStructure::Multipart { bodies, .. } => children(bodies, "", &mut out),
        leaf => push_leaf(leaf, "1".to_string(), &mut out),
    }
    out
}

fn children(bodies: &[BodyStructure], prefix: &str, out: &mut Vec<PartInfo>) {
    for (i, b) in bodies.iter().enumerate() {
        let section = if prefix.is_empty() { (i + 1).to_string() } else { format!("{prefix}.{}", i + 1) };
        match b {
            BodyStructure::Multipart { bodies, .. } => children(bodies, &section, out),
            leaf => push_leaf(leaf, section, out),
        }
    }
}

fn param<'a>(params: &'a Option<Vec<(std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)>>, name: &str) -> Option<&'a str> {
    params.as_ref()?.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_ref())
}

fn encoding_name(e: &ContentEncoding) -> String {
    match e {
        ContentEncoding::SevenBit => "7bit".into(),
        ContentEncoding::EightBit => "8bit".into(),
        ContentEncoding::Binary => "binary".into(),
        ContentEncoding::Base64 => "base64".into(),
        ContentEncoding::QuotedPrintable => "quoted-printable".into(),
        ContentEncoding::Other(s) => s.to_ascii_lowercase(),
    }
}

fn push_leaf(bs: &BodyStructure, section: String, out: &mut Vec<PartInfo>) {
    let (common, other): (&BodyContentCommon, &BodyContentSinglePart) = match bs {
        BodyStructure::Basic { common, other, .. }
        | BodyStructure::Text { common, other, .. }
        | BodyStructure::Message { common, other, .. } => (common, other),
        BodyStructure::Multipart { .. } => return,
    };
    let disposition = common.disposition.as_ref();
    let filename = disposition
        .and_then(|d| param(&d.params, "filename"))
        .or_else(|| param(&common.ty.params, "name"))
        .map(|n| crate::mime::decode_rfc2047(n.as_bytes()))
        .filter(|n| !n.trim().is_empty());
    out.push(PartInfo {
        section,
        mime: format!("{}/{}", common.ty.ty, common.ty.subtype).to_ascii_lowercase(),
        filename,
        size: other.octets,
        encoding: encoding_name(&other.transfer_encoding),
        charset: param(&common.ty.params, "charset").map(str::to_string).filter(|c| !c.trim().is_empty()),
        content_id: other
            .id
            .as_deref()
            .map(|id| id.trim().trim_start_matches('<').trim_end_matches('>').to_string())
            .filter(|id| !id.is_empty()),
        disposition: disposition.map(|d| d.ty.to_ascii_lowercase()),
    });
}

/// `1.2` -> `[1, 2]`; anything but dot-separated positive numbers is refused.
fn section_path(section: &str) -> Result<Vec<u32>, String> {
    section
        .split('.')
        .map(|n| n.parse::<u32>().ok().filter(|n| *n > 0))
        .collect::<Option<Vec<u32>>>()
        .ok_or_else(|| format!("not a part section: {section}"))
}

/// What one `* n FETCH` line for the uid carried.
#[derive(Default)]
struct Reply {
    /// The BODYSTRUCTURE's parts, when the line had one.
    parts: Option<Vec<PartInfo>>,
    /// The `BODY[section]` item, when the line had one: `Some(None)` for NIL.
    section: Option<Option<Vec<u8>>>,
    /// The item's `<origin>`, for a partial fetch's reply.
    origin: Option<u32>,
}

/// `UID FETCH uid <spec>`, read up to its tagged status (a NO or BAD is an error with the
/// server's words, never an empty answer). Every line for the uid comes back, items as sent;
/// lines for other messages (a server's unsolicited flag news) are skipped. async-imap's
/// `Fetch` would hide the difference between a `BODY[n] NIL` item and no item at all.
async fn fetch_uid(session: &mut ImapSession, uid: u32, spec: &str, want: Option<&SectionPath>) -> Result<Vec<Reply>, String> {
    use imap_proto::{Response, Status};
    let command = format!("UID FETCH {uid} {spec}");
    patient(async {
        let id = session.run_command(&command).await.map_err(|e| format!("{command} failed: {e}"))?;
        let mut out = Vec::new();
        loop {
            let Some(rd) = session.read_response().await.map_err(|e| format!("{command} failed: {e}"))? else {
                return Err(format!("{command} failed: connection lost"));
            };
            match rd.parsed() {
                Response::Done { tag, status, information, .. } if *tag == id => {
                    return match status {
                        Status::Ok => Ok(out),
                        other => Err(format!("{command} failed: {other:?} {}", information.as_deref().unwrap_or(""))),
                    };
                }
                Response::Fetch(_, attrs) => {
                    let mut r = Reply::default();
                    let mut this_uid = None;
                    for a in attrs {
                        match a {
                            AttributeValue::Uid(u) => this_uid = Some(*u),
                            AttributeValue::BodyStructure(bs) => r.parts = Some(parts_of(bs)),
                            AttributeValue::BodySection { section: Some(sp), data, index } if Some(sp) == want => {
                                r.section = Some(data.as_ref().map(|d| d.to_vec()));
                                r.origin = *index;
                            }
                            _ => {}
                        }
                    }
                    if this_uid == Some(uid) {
                        out.push(r);
                    }
                }
                _ => {}
            }
        }
    })
    .await
}

/// `Ok(None)` when the server says the uid is not in the mailbox; an empty reply alone is not
/// proof (see `uid_still_present`).
async fn absent(session: &mut ImapSession, mailbox: &str, uid: u32) -> Result<(), String> {
    if uid_still_present(session, uid).await? {
        return Err(format!("Server returned nothing for UID {uid}, but the message is still in {mailbox}"));
    }
    Ok(())
}

/// Selects `mailbox` and lists the parts of `uid`: `(None, validity)` when the uid is gone. The
/// mailbox's UIDVALIDITY comes back too, so a caller can tell a uid that now names another message.
pub async fn fetch_parts(session: &mut ImapSession, mailbox: &str, uid: u32) -> Result<(Option<Vec<PartInfo>>, Option<u32>), String> {
    let mbox = select_mailbox(session, mailbox).await?;
    let replies = fetch_uid(session, uid, "(UID BODYSTRUCTURE)", None).await?;
    // The line that carries the structure, not merely the first for the uid: another client's
    // flag change arrives as an unsolicited `FETCH (UID n FLAGS ...)` for the same uid.
    let Some(parts) = replies.into_iter().find_map(|r| r.parts) else {
        absent(session, mailbox, uid).await?;
        return Ok((None, mbox.uid_validity));
    };
    Ok((Some(parts), mbox.uid_validity))
}

/// One part's body: `UID FETCH uid (UID BODYSTRUCTURE BODY.PEEK[section])`, decoded per the
/// part's transfer encoding, which the BODYSTRUCTURE in the same reply names. Never sets `\Seen`.
/// `Ok(None)` when the uid is gone. An empty part (`""` or NIL) is no bytes. A reply with no
/// `BODY[section]` item, or whose encoding cannot be read (no BODYSTRUCTURE, or none of its parts
/// is `section`), is an error: guessing would hand back raw base64 as text, or no text at all.
pub async fn fetch_section(session: &mut ImapSession, mailbox: &str, uid: u32, section: &str) -> Result<Option<Vec<u8>>, String> {
    let sp = SectionPath::Part(section_path(section)?, None);
    select_mailbox(session, mailbox).await?;
    let replies = fetch_uid(session, uid, &format!("(UID BODYSTRUCTURE BODY.PEEK[{section}])"), Some(&sp)).await?;
    // Each item is looked for across every line for the uid, so an unsolicited FLAGS FETCH (or a
    // server that splits the items over two FETCH lines) never stands in for the data.
    let mut data: Option<Option<Vec<u8>>> = None;
    let mut parts: Option<Vec<PartInfo>> = None;
    for r in replies {
        if data.is_none() {
            data = r.section;
        }
        if parts.is_none() {
            parts = r.parts;
        }
    }
    if data.is_none() && parts.is_none() {
        absent(session, mailbox, uid).await?;
        return Ok(None);
    }
    let data = data.ok_or_else(|| format!("UID FETCH {uid}: no BODY[{section}] in the reply"))?;
    let parts = parts.ok_or_else(|| format!("UID FETCH {uid}: no BODYSTRUCTURE in the reply, encoding of {section} unknown"))?;
    let encoding = parts
        .into_iter()
        .find(|p| p.section == section)
        .map(|p| p.encoding)
        .ok_or_else(|| format!("UID FETCH {uid}: no part {section} in the BODYSTRUCTURE"))?;
    Ok(Some(decode_transfer(&data.unwrap_or_default(), &encoding)))
}

/// `len` octets of one part from `offset` on, still transfer-encoded: `UID FETCH uid
/// (UID BODY.PEEK[section]<offset.len>)` after selecting `mailbox`. Never sets `\Seen`.
/// `Ok(None)` when the uid is gone. Fewer than `len` bytes (none at all past the end, `""` or NIL)
/// means the part ends there; a caller reads to that short slice rather than trusting the
/// BODYSTRUCTURE's size. Each call selects `mailbox`; a caller fetching many slices in a row
/// selects once and uses [`fetch_selected_section_range`].
pub async fn fetch_section_range(session: &mut ImapSession, mailbox: &str, uid: u32, section: &str, offset: u64, len: u32) -> Result<Option<Vec<u8>>, String> {
    section_path(section)?;
    select_mailbox(session, mailbox).await?;
    fetch_selected_section_range(session, mailbox, uid, section, offset, len).await
}

/// [`fetch_section_range`] on the mailbox the session already has selected (named `mailbox`,
/// for the gone check's message). No SELECT, so a download of many slices costs one round trip
/// each.
pub async fn fetch_selected_section_range(
    session: &mut ImapSession,
    mailbox: &str,
    uid: u32,
    section: &str,
    offset: u64,
    len: u32,
) -> Result<Option<Vec<u8>>, String> {
    let sp = SectionPath::Part(section_path(section)?, None);
    // imap-proto reads the reply's origin as a u32.
    let origin = u32::try_from(offset).map_err(|_| format!("part offset {offset} is past 4 GiB"))?;
    let replies = fetch_uid(session, uid, &format!("(UID BODY.PEEK[{section}]<{offset}.{len}>)"), Some(&sp)).await?;
    let Some((data, got_origin)) = replies.into_iter().find_map(|r| r.section.map(|d| (d, r.origin))) else {
        absent(session, mailbox, uid).await?;
        return Ok(None);
    };
    let data = data.unwrap_or_default();
    match got_origin {
        Some(o) if o == origin => Ok(Some(data)),
        Some(o) => Err(format!("UID FETCH {uid}: asked for BODY[{section}]<{offset}>, got <{o}>")),
        // A server that ignored the range sent the whole part: cut the slice out of it.
        None if data.len() > len as usize => {
            let start = (offset as usize).min(data.len());
            let end = start.saturating_add(len as usize).min(data.len());
            Ok(Some(data[start..end].to_vec()))
        }
        None if offset == 0 => Ok(Some(data)),
        None => Err(format!("UID FETCH {uid}: BODY[{section}] came back without its origin <{offset}>")),
    }
}

/// Undoes base64 or quoted-printable through mailparse (lenient about line breaks and stray
/// characters, as mail needs); any other encoding is the bytes themselves.
pub fn decode_transfer(data: &[u8], encoding: &str) -> Vec<u8> {
    let enc = encoding.trim().to_ascii_lowercase();
    if enc != "base64" && enc != "quoted-printable" {
        return data.to_vec();
    }
    let mut raw = format!("Content-Transfer-Encoding: {enc}\r\n\r\n").into_bytes();
    raw.extend_from_slice(data);
    mailparse::parse_mail(&raw).and_then(|m| m.get_body_raw()).unwrap_or_else(|_| data.to_vec())
}

/// Text of a decoded part in `charset`, with the reader's fallbacks (`mime::body_text`): an
/// unusable label falls back to UTF-8, then the body's own `<meta charset>`, then windows-1252.
pub fn decode_text(bytes: &[u8], charset: Option<&str>) -> String {
    // Only label characters reach the synthetic header.
    let label: String = charset
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        .collect();
    let mut raw = format!("Content-Type: text/plain; charset=\"{label}\"\r\n\r\n").into_bytes();
    raw.extend_from_slice(bytes);
    match mailparse::parse_mail(&raw) {
        Ok(m) => crate::mime::body_text(&m).unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned()),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_decoding() {
        assert_eq!(decode_transfer(b"aGVs\r\nbG8=\r\n", "BASE64"), b"hello");
        assert_eq!(decode_transfer(b"caf=C3=A9 =\r\nbar", "quoted-printable"), "café bar".as_bytes());
        assert_eq!(decode_transfer(b"as is", "7bit"), b"as is");
    }

    #[test]
    fn charset_decoding() {
        assert_eq!(decode_text(&[0x63, 0x61, 0x66, 0xE9], Some("iso-8859-1")), "café");
        assert_eq!(decode_text("Grüße".as_bytes(), None), "Grüße");
        assert_eq!(decode_text(b"x", Some("utf-8\"\r\nX-Evil: 1")), "x");
    }
}
