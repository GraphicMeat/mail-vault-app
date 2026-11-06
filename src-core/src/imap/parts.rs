//! A message's MIME parts from its BODYSTRUCTURE, and one part's body by section, so a reader
//! can fetch the text of a message without downloading its attachments.
//!
//! Sections are numbered as RFC 3501 6.4.5 does: the children of a multipart are `1`, `2`, ...,
//! a nested multipart's children `2.1`, `2.2`, ..., and a non-multipart message's body is `1`.
//! Only leaves are listed. A `message/rfc822` part is a leaf here (a forwarded message is an
//! attachment); its insides are not walked.

use super::{select_mailbox, uid_still_present, ImapSession};
use async_imap::types::Fetch;
use futures::StreamExt;
use imap_proto::types::{BodyContentCommon, BodyContentSinglePart, BodyStructure, ContentEncoding, SectionPath};

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

/// The FETCH replies for one uid. Errors in the stream are the server refusing, never absence.
async fn fetch_uid(session: &mut ImapSession, uid: u32, spec: &str) -> Result<Vec<Fetch>, String> {
    let stream = session.uid_fetch(uid.to_string(), spec).await.map_err(|e| format!("UID FETCH {uid} failed: {e}"))?;
    let mut out = Vec::new();
    for item in stream.collect::<Vec<_>>().await {
        match item {
            // A server may slip in an unsolicited FETCH (a flag change) for another message.
            Ok(f) if f.uid == Some(uid) => out.push(f),
            Ok(_) => {}
            Err(e) => return Err(format!("UID FETCH {uid} failed: {e}")),
        }
    }
    Ok(out)
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
    let fetches = fetch_uid(session, uid, "(UID BODYSTRUCTURE)").await?;
    // The reply that carries the structure, not merely the first for the uid: another client's
    // flag change arrives as an unsolicited `FETCH (UID n FLAGS ...)` for the same uid.
    let Some(bs) = fetches.iter().find_map(|f| f.bodystructure()) else {
        absent(session, mailbox, uid).await?;
        return Ok((None, mbox.uid_validity));
    };
    Ok((Some(parts_of(bs)), mbox.uid_validity))
}

/// One part's body: `UID FETCH uid (UID BODYSTRUCTURE BODY.PEEK[section])`, decoded per the
/// part's transfer encoding, which the BODYSTRUCTURE in the same reply names. Never sets `\Seen`.
/// `Ok(None)` when the uid is gone. A reply without the part's bytes, or whose encoding cannot be
/// read (no BODYSTRUCTURE, or none of its parts is `section`), is an error: guessing would hand
/// back raw base64 as text, or no text at all.
pub async fn fetch_section(session: &mut ImapSession, mailbox: &str, uid: u32, section: &str) -> Result<Option<Vec<u8>>, String> {
    let sp = SectionPath::Part(section_path(section)?, None);
    select_mailbox(session, mailbox).await?;
    let fetches = fetch_uid(session, uid, &format!("(UID BODYSTRUCTURE BODY.PEEK[{section}])")).await?;
    // Each item is looked for across every reply for the uid, so an unsolicited FLAGS FETCH (or a
    // server that splits the items over two FETCH lines) never stands in for the data.
    let data = fetches.iter().find_map(|f| f.section(&sp));
    let structure = fetches.iter().find_map(|f| f.bodystructure());
    if data.is_none() && structure.is_none() {
        absent(session, mailbox, uid).await?;
        return Ok(None);
    }
    let data = data.ok_or_else(|| format!("UID FETCH {uid}: no BODY[{section}] in the reply"))?;
    let structure = structure.ok_or_else(|| format!("UID FETCH {uid}: no BODYSTRUCTURE in the reply, encoding of {section} unknown"))?;
    let encoding = parts_of(structure)
        .into_iter()
        .find(|p| p.section == section)
        .map(|p| p.encoding)
        .ok_or_else(|| format!("UID FETCH {uid}: no part {section} in the BODYSTRUCTURE"))?;
    Ok(Some(decode_transfer(data, &encoding)))
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
