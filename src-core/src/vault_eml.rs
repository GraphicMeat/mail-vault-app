//! The app's vault file format and its one light parser (spec 2026-09-14 §5.1). Shared by the app's maildir commands and the daemon's search index.
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MaildirAddress {
    pub name: Option<String>,
    pub address: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LightAttachment {
    pub filename: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "contentDisposition")]
    pub content_disposition: Option<String>,
    pub size: usize,
    #[serde(rename = "contentId")]
    pub content_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LightEmail {
    pub uid: u32,
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    pub subject: String,
    pub from: MaildirAddress,
    pub to: Vec<MaildirAddress>,
    pub cc: Vec<MaildirAddress>,
    pub bcc: Vec<MaildirAddress>,
    #[serde(rename = "replyTo")]
    pub reply_to: Vec<MaildirAddress>,
    pub date: Option<String>,
    pub flags: Vec<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<LightAttachment>,
    #[serde(rename = "hasAttachments")]
    pub has_attachments: bool,
    #[serde(rename = "isArchived")]
    pub is_archived: bool,
}

/// The flags a vault file name carries, as the Maildir words AND as the IMAP
/// names — `seen` and `\Seen` both, for a file named `12:2,AS.eml`.
///
/// Every row in the app asks `flags.includes('\Seen')`; a row built from its
/// .eml used to get the words alone and render unread whatever the file said.
/// The words stay, because `build_maildir_filename` and the archived checks
/// read them; the names are what the rest of the app reads.
pub fn parse_flags_from_filename(filename: &str) -> Vec<String> {
    let Some(flags_part) = filename.split(":2,").nth(1) else { return Vec::new() };
    let mut flags = Vec::new();
    for c in flags_part.chars() {
        match c {
            'A' => flags.push("archived".to_string()),
            'D' => flags.push("draft".to_string()),
            'F' => flags.push("flagged".to_string()),
            'R' => flags.push("replied".to_string()),
            'S' => flags.push("seen".to_string()),
            'T' => flags.push("trashed".to_string()),
            _ => {}
        }
    }
    for (word, name) in [("seen", "\\Seen"), ("flagged", "\\Flagged"), ("replied", "\\Answered")] {
        if flags.iter().any(|f| f == word) {
            flags.push(name.to_string());
        }
    }
    flags
}

pub use crate::maildir::find_by_uid as find_file_by_uid;

pub fn parse_address_str(header_value: &str) -> Vec<MaildirAddress> {
    match mailparse::addrparse(header_value) {
        Ok(addrs) => {
            addrs.iter().flat_map(|a| match a {
                mailparse::MailAddr::Single(info) => {
                    vec![MaildirAddress {
                        name: info.display_name.clone(),
                        address: info.addr.clone(),
                    }]
                }
                mailparse::MailAddr::Group(group) => {
                    group.addrs.iter().map(|info| MaildirAddress {
                        name: info.display_name.clone(),
                        address: info.addr.clone(),
                    }).collect()
                }
            }).collect()
        }
        Err(_) => {
            if !header_value.trim().is_empty() {
                vec![MaildirAddress { name: None, address: header_value.trim().to_string() }]
            } else {
                Vec::new()
            }
        }
    }
}

pub fn walk_mime_parts_light(
    part: &mailparse::ParsedMail,
    text_body: &mut Option<String>,
    html_body: &mut Option<String>,
    attachments: &mut Vec<LightAttachment>,
) {
    let content_type = part.ctype.mimetype.to_lowercase();

    if !part.subparts.is_empty() {
        for sub in &part.subparts {
            walk_mime_parts_light(sub, text_body, html_body, attachments);
        }
        return;
    }

    let disposition = part.get_content_disposition();
    let is_attachment = disposition.disposition == mailparse::DispositionType::Attachment;
    let is_inline_non_text = disposition.disposition == mailparse::DispositionType::Inline
        && !content_type.starts_with("text/");

    if is_attachment || is_inline_non_text {
        let size = part.get_body_raw().map(|b| b.len()).unwrap_or(0);
        let filename = disposition.params.get("filename")
            .or_else(|| part.ctype.params.get("name"))
            .cloned();
        let content_id = part.headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case("Content-ID"))
            .map(|h| h.get_value());

        attachments.push(LightAttachment {
            filename,
            content_type: content_type.clone(),
            content_disposition: Some(format!("{:?}", disposition.disposition)),
            size,
            content_id,
        });
    } else if content_type == "text/plain" && text_body.is_none() {
        *text_body = part.get_body().ok();
    } else if content_type == "text/html" && html_body.is_none() {
        *html_body = part.get_body().ok();
    }
}

pub fn collect_attachment_parts<'a>(
    part: &'a mailparse::ParsedMail<'a>,
    out: &mut Vec<&'a mailparse::ParsedMail<'a>>,
) {
    if !part.subparts.is_empty() {
        for sub in &part.subparts {
            collect_attachment_parts(sub, out);
        }
        return;
    }
    let disposition = part.get_content_disposition();
    let ct = part.ctype.mimetype.to_lowercase();
    let is_attachment = disposition.disposition == mailparse::DispositionType::Attachment;
    let is_inline_non_text = disposition.disposition == mailparse::DispositionType::Inline
        && !ct.starts_with("text/");
    if is_attachment || is_inline_non_text {
        out.push(part);
    }
}

/// Check if any attachment is a "real" attachment (not an inline embedded image
/// or tracking pixel). Mirrors the JS-side `hasRealAttachments` logic.
pub fn is_real_attachment(
    content_type: &str,
    content_id: &Option<String>,
    filename: &Option<String>,
    size: usize,
    html: Option<&str>,
) -> bool {
    let ct = content_type.to_lowercase();
    // Non-image types are always real attachments
    if !ct.starts_with("image/") {
        return true;
    }
    // Inline image with Content-ID referenced in the HTML body → embedded, not real
    if let Some(ref cid) = content_id {
        if let Some(html_body) = html {
            let bare_cid = cid.trim_start_matches('<').trim_end_matches('>');
            if html_body.contains(&format!("cid:{}", bare_cid)) {
                return false;
            }
        }
    }
    // Tiny unnamed image → tracking pixel
    if filename.is_none() && size < 5000 {
        return false;
    }
    true
}

pub fn has_real_attachments(attachments: &[LightAttachment], html: Option<&str>) -> bool {
    attachments.iter().any(|att| {
        is_real_attachment(&att.content_type, &att.content_id, &att.filename, att.size, html)
    })
}

pub fn parse_eml_bytes_light(raw: &[u8], uid: u32, flags: Vec<String>) -> Result<LightEmail, String> {
    let parsed = mailparse::parse_mail(raw)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let headers = &parsed.headers;
    let get_header = |name: &str| -> Option<String> {
        headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
    };

    let subject = get_header("Subject").unwrap_or_else(|| "(No Subject)".to_string());
    let message_id = get_header("Message-ID");
    let date = get_header("Date");

    let from_str = get_header("From").unwrap_or_default();
    let from_addrs = parse_address_str(&from_str);
    let from = from_addrs.into_iter().next().unwrap_or(MaildirAddress {
        name: Some("Unknown".to_string()),
        address: "unknown@unknown.com".to_string(),
    });

    let to = get_header("To")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let cc = get_header("Cc")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let bcc = get_header("Bcc")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let reply_to = get_header("Reply-To")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();

    let mut text_body: Option<String> = None;
    let mut html_body: Option<String> = None;
    let mut attachments: Vec<LightAttachment> = Vec::new();

    walk_mime_parts_light(&parsed, &mut text_body, &mut html_body, &mut attachments);

    let is_archived = flags.iter().any(|f| f == "archived");
    let has_attachments = has_real_attachments(&attachments, html_body.as_deref());

    Ok(LightEmail {
        uid,
        message_id,
        subject,
        from,
        to,
        cc,
        bcc,
        reply_to,
        date,
        flags,
        text: text_body,
        html: html_body,
        attachments,
        has_attachments,
        is_archived,
    })
}

/// Read and light-parse `uid` from `hint`, a path the caller already knows
/// (a listing, an index row). If there is no hint or it no longer reads, look
/// the uid up once in `cur_dir`. A file that reads but does not parse is `None`.
pub fn read_light_at(cur_dir: &Path, uid: u32, hint: Option<&Path>) -> Option<LightEmail> {
    let read = |path: &Path| -> Option<(Vec<u8>, String)> {
        Some((std::fs::read(path).ok()?, path.file_name()?.to_string_lossy().into_owned()))
    };
    // ponytail: a rename after the listing leaves a stale path; only a failed read pays one rescan
    let (raw, name) = match hint.and_then(read) {
        Some(hit) => hit,
        None => read(&find_file_by_uid(cur_dir, uid)?)?,
    };
    parse_eml_bytes_light(&raw, uid, parse_flags_from_filename(&name)).ok()
}

pub fn part_filename(part: &mailparse::ParsedMail) -> String {
    let disposition = part.get_content_disposition();
    disposition.params.get("filename")
        .or_else(|| part.ctype.params.get("name"))
        .cloned()
        .unwrap_or_else(|| "attachment".to_string())
}

// ── Full parse (base64 content, whole message) ──────────────────────────────
// Moved verbatim from src-tauri/src/main.rs:1750-1786, 2068-2187 (Task 2.2 Step
// 1). Used by `maildir_read`, whose viewer wants the full body plus attachment
// bytes; every other reader uses the light parser above.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MaildirAttachment {
    pub filename: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "contentDisposition")]
    pub content_disposition: Option<String>,
    pub size: usize,
    #[serde(rename = "contentId")]
    pub content_id: Option<String>,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParsedEmail {
    pub uid: u32,
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    pub subject: String,
    pub from: MaildirAddress,
    pub to: Vec<MaildirAddress>,
    pub cc: Vec<MaildirAddress>,
    pub bcc: Vec<MaildirAddress>,
    #[serde(rename = "replyTo")]
    pub reply_to: Vec<MaildirAddress>,
    pub date: Option<String>,
    pub flags: Vec<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<MaildirAttachment>,
    #[serde(rename = "rawSource")]
    pub raw_source: String,
    #[serde(rename = "hasAttachments")]
    pub has_attachments: bool,
    #[serde(rename = "isArchived")]
    pub is_archived: bool,
}

pub fn walk_mime_parts(
    part: &mailparse::ParsedMail,
    text_body: &mut Option<String>,
    html_body: &mut Option<String>,
    attachments: &mut Vec<MaildirAttachment>,
) {
    let content_type = part.ctype.mimetype.to_lowercase();

    if !part.subparts.is_empty() {
        for sub in &part.subparts {
            walk_mime_parts(sub, text_body, html_body, attachments);
        }
        return;
    }

    // Leaf part
    let disposition = part.get_content_disposition();
    let is_attachment = disposition.disposition == mailparse::DispositionType::Attachment;
    let is_inline_non_text = disposition.disposition == mailparse::DispositionType::Inline
        && !content_type.starts_with("text/");

    if is_attachment || is_inline_non_text {
        if let Ok(body) = part.get_body_raw() {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&body);
            let filename = disposition.params.get("filename")
                .or_else(|| part.ctype.params.get("name"))
                .cloned();
            let content_id = part.headers.iter()
                .find(|h| h.get_key().eq_ignore_ascii_case("Content-ID"))
                .map(|h| h.get_value());

            attachments.push(MaildirAttachment {
                filename,
                content_type: content_type.clone(),
                content_disposition: Some(format!("{:?}", disposition.disposition)),
                size: body.len(),
                content_id,
                content: b64,
            });
        }
    } else if content_type == "text/plain" && text_body.is_none() {
        *text_body = part.get_body().ok();
    } else if content_type == "text/html" && html_body.is_none() {
        *html_body = part.get_body().ok();
    }
}

pub fn has_real_attachments_full(attachments: &[MaildirAttachment], html: Option<&str>) -> bool {
    attachments.iter().any(|att| {
        is_real_attachment(&att.content_type, &att.content_id, &att.filename, att.size, html)
    })
}

pub fn parse_eml_bytes(raw: &[u8], uid: u32, flags: Vec<String>) -> Result<ParsedEmail, String> {
    let parsed = mailparse::parse_mail(raw)
        .map_err(|e| format!("Failed to parse email: {}", e))?;

    let headers = &parsed.headers;
    let get_header = |name: &str| -> Option<String> {
        headers.iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
    };

    let subject = get_header("Subject").unwrap_or_else(|| "(No Subject)".to_string());
    let message_id = get_header("Message-ID");
    let date = get_header("Date");

    let from_str = get_header("From").unwrap_or_default();
    let from_addrs = parse_address_str(&from_str);
    let from = from_addrs.into_iter().next().unwrap_or(MaildirAddress {
        name: Some("Unknown".to_string()),
        address: "unknown@unknown.com".to_string(),
    });

    let to = get_header("To")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let cc = get_header("Cc")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let bcc = get_header("Bcc")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();
    let reply_to = get_header("Reply-To")
        .map(|v| parse_address_str(&v))
        .unwrap_or_default();

    let mut text_body: Option<String> = None;
    let mut html_body: Option<String> = None;
    let mut attachments: Vec<MaildirAttachment> = Vec::new();

    walk_mime_parts(&parsed, &mut text_body, &mut html_body, &mut attachments);

    let is_archived = flags.iter().any(|f| f == "archived");
    let has_attachments = has_real_attachments_full(&attachments, html_body.as_deref());

    use base64::Engine;
    let raw_source = base64::engine::general_purpose::STANDARD.encode(raw);

    Ok(ParsedEmail {
        uid,
        message_id,
        subject,
        from,
        to,
        cc,
        bcc,
        reply_to,
        date,
        flags,
        text: text_body,
        html: html_body,
        attachments,
        raw_source,
        has_attachments,
        is_archived,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vault_file_name_reports_its_flags_by_both_names() {
        assert_eq!(parse_flags_from_filename("12:2,AS.eml"), vec!["archived", "seen", "\\Seen"]);
        assert_eq!(parse_flags_from_filename("12:2,A"), vec!["archived"]);
        assert_eq!(parse_flags_from_filename("12:2,FRS"), vec!["flagged", "replied", "seen", "\\Seen", "\\Flagged", "\\Answered"]);
    }

    // -- Fixtures --

    const PLAIN_EMAIL: &[u8] = b"From: alice@example.com\r\n\
Subject: Hello\r\n\
Date: Wed, 19 Feb 2026 10:00:00 +0000\r\n\
Content-Type: text/plain\r\n\
\r\n\
Hello, World!";

    const HTML_EMAIL: &[u8] = b"From: alice@example.com\r\n\
Subject: Hello HTML\r\n\
Content-Type: text/html\r\n\
\r\n\
<p>Hello</p>";

    fn multipart_with_attachment() -> Vec<u8> {
        b"From: bob@example.com\r\n\
Subject: With attachment\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"BOUNDARY\"\r\n\
\r\n\
--BOUNDARY\r\n\
Content-Type: text/plain\r\n\
\r\n\
Body text\r\n\
--BOUNDARY\r\n\
Content-Type: application/pdf; name=\"report.pdf\"\r\n\
Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--BOUNDARY--\r\n".to_vec()
    }

    fn multipart_with_inline_image() -> Vec<u8> {
        b"From: carol@example.com\r\n\
Subject: Inline image\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"RELBOUND\"\r\n\
\r\n\
--RELBOUND\r\n\
Content-Type: text/html\r\n\
\r\n\
<html><body><img src=\"cid:logo123\"></body></html>\r\n\
--RELBOUND\r\n\
Content-Type: image/png\r\n\
Content-ID: <logo123>\r\n\
Content-Disposition: inline\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--RELBOUND--\r\n".to_vec()
    }

    fn multipart_mixed_and_inline() -> Vec<u8> {
        b"From: dave@example.com\r\n\
Subject: Mixed attachments\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"MIX\"\r\n\
\r\n\
--MIX\r\n\
Content-Type: text/plain\r\n\
\r\n\
See attached.\r\n\
--MIX\r\n\
Content-Type: image/jpeg\r\n\
Content-Disposition: inline\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
/9j/4AAQ\r\n\
--MIX\r\n\
Content-Type: application/zip; name=\"archive.zip\"\r\n\
Content-Disposition: attachment; filename=\"archive.zip\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
UEsFBg==\r\n\
--MIX--\r\n".to_vec()
    }

    fn multipart_two_attachments() -> Vec<u8> {
        b"From: eve@example.com\r\n\
Subject: Two attachments\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"TWO\"\r\n\
\r\n\
--TWO\r\n\
Content-Type: text/html\r\n\
\r\n\
<p>Please review</p>\r\n\
--TWO\r\n\
Content-Type: application/pdf; name=\"doc1.pdf\"\r\n\
Content-Disposition: attachment; filename=\"doc1.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--TWO\r\n\
Content-Type: image/png; name=\"screenshot.png\"\r\n\
Content-Disposition: attachment; filename=\"screenshot.png\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--TWO--\r\n".to_vec()
    }

    fn eml(subject: &str) -> Vec<u8> {
        format!("From: A <a@x.test>\r\nTo: b@x.test\r\nSubject: {subject}\r\nMessage-ID: <{subject}@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nbody of {subject}\r\n").into_bytes()
    }

    // -----------------------------------------------------------------------
    // parse_eml_bytes_light — basic fields
    // -----------------------------------------------------------------------

    #[test]
    fn light_parse_plain_email_fields() {
        let email = parse_eml_bytes_light(PLAIN_EMAIL, 42, vec![]).unwrap();
        assert_eq!(email.uid, 42);
        assert_eq!(email.subject, "Hello");
        assert_eq!(email.from.address, "alice@example.com");
        assert_eq!(email.text.as_deref(), Some("Hello, World!"));
        assert!(email.html.is_none());
    }

    #[test]
    fn light_parse_html_email() {
        let email = parse_eml_bytes_light(HTML_EMAIL, 1, vec![]).unwrap();
        assert!(email.html.is_some());
        assert!(email.html.unwrap().contains("<p>Hello</p>"));
    }

    // -----------------------------------------------------------------------
    // parse_eml_bytes_light — attachment detection
    // -----------------------------------------------------------------------

    #[test]
    fn light_parse_no_attachments_plain() {
        let email = parse_eml_bytes_light(PLAIN_EMAIL, 1, vec![]).unwrap();
        assert!(!email.has_attachments);
        assert!(email.attachments.is_empty());
    }

    #[test]
    fn light_parse_detects_attachment() {
        let raw = multipart_with_attachment();
        let email = parse_eml_bytes_light(&raw, 2, vec![]).unwrap();
        assert!(email.has_attachments);
        assert_eq!(email.attachments.len(), 1);
        assert_eq!(email.attachments[0].filename.as_deref(), Some("report.pdf"));
        assert_eq!(email.attachments[0].content_type, "application/pdf");
        assert!(email.attachments[0].size > 0);
    }

    #[test]
    fn light_parse_detects_inline_non_text() {
        let raw = multipart_with_inline_image();
        let email = parse_eml_bytes_light(&raw, 3, vec![]).unwrap();
        // Inline image referenced via cid: in HTML should NOT set has_attachments
        assert!(!email.has_attachments, "Embedded inline image should not count as attachment");
        // But the attachment metadata should still be present for the viewer
        assert_eq!(email.attachments.len(), 1);
        assert_eq!(email.attachments[0].content_type, "image/png");
        assert!(email.attachments[0].content_id.is_some());
    }

    #[test]
    fn light_parse_mixed_inline_and_attachment() {
        let raw = multipart_mixed_and_inline();
        let email = parse_eml_bytes_light(&raw, 4, vec![]).unwrap();
        assert!(email.has_attachments);
        assert_eq!(email.attachments.len(), 2); // inline jpeg + attached zip
        let filenames: Vec<_> = email.attachments.iter().map(|a| a.filename.as_deref()).collect();
        assert!(filenames.contains(&Some("archive.zip")));
    }

    #[test]
    fn light_parse_two_attachments() {
        let raw = multipart_two_attachments();
        let email = parse_eml_bytes_light(&raw, 5, vec![]).unwrap();
        assert!(email.has_attachments);
        assert_eq!(email.attachments.len(), 2);
        let names: Vec<_> = email.attachments.iter()
            .filter_map(|a| a.filename.as_deref())
            .collect();
        assert!(names.contains(&"doc1.pdf"));
        assert!(names.contains(&"screenshot.png"));
    }

    // -----------------------------------------------------------------------
    // Light attachment metadata — no binary content
    // -----------------------------------------------------------------------

    #[test]
    fn light_attachment_has_no_content_field() {
        // LightAttachment struct has no `content` field — this is a compile-time
        // guarantee, but we verify the JSON representation also omits it.
        let raw = multipart_with_attachment();
        let email = parse_eml_bytes_light(&raw, 6, vec![]).unwrap();
        let json = serde_json::to_value(&email.attachments[0]).unwrap();
        assert!(json.get("content").is_none(), "LightAttachment should not have content");
        assert!(json.get("contentType").is_some(), "LightAttachment should have contentType");
        assert!(json.get("filename").is_some());
        assert!(json.get("size").is_some());
    }

    // -----------------------------------------------------------------------
    // collect_attachment_parts — on-demand single attachment fetch
    // -----------------------------------------------------------------------

    #[test]
    fn collect_parts_matches_light_count() {
        let raw = multipart_two_attachments();
        let parsed = mailparse::parse_mail(&raw).unwrap();
        let mut parts = Vec::new();
        collect_attachment_parts(&parsed, &mut parts);
        // Should find same count as walk_mime_parts_light
        let email = parse_eml_bytes_light(&raw, 1, vec![]).unwrap();
        assert_eq!(parts.len(), email.attachments.len());
    }

    #[test]
    fn collect_parts_empty_for_plain() {
        let parsed = mailparse::parse_mail(PLAIN_EMAIL).unwrap();
        let mut parts = Vec::new();
        collect_attachment_parts(&parsed, &mut parts);
        assert!(parts.is_empty());
    }

    // -----------------------------------------------------------------------
    // Flags parsing
    // -----------------------------------------------------------------------

    #[test]
    fn light_parse_archived_flag() {
        let email = parse_eml_bytes_light(PLAIN_EMAIL, 1, vec!["archived".to_string()]).unwrap();
        assert!(email.is_archived);
    }

    #[test]
    fn light_parse_not_archived_by_default() {
        let email = parse_eml_bytes_light(PLAIN_EMAIL, 1, vec![]).unwrap();
        assert!(!email.is_archived);
    }

    // ── is_real_attachment tests ────────────────────────────────────────

    #[test]
    fn real_attachment_pdf() {
        assert!(is_real_attachment("application/pdf", &None, &Some("report.pdf".into()), 10000, None));
    }

    #[test]
    fn real_attachment_zip() {
        assert!(is_real_attachment("application/zip", &None, &Some("archive.zip".into()), 50000, None));
    }

    #[test]
    fn inline_image_with_cid_referenced_in_html() {
        let cid = Some("<logo123>".to_string());
        let html = Some(r#"<html><body><img src="cid:logo123"></body></html>"#);
        assert!(!is_real_attachment("image/png", &cid, &Some("logo.png".into()), 15000, html));
    }

    #[test]
    fn inline_image_with_cid_not_in_html() {
        let cid = Some("<logo123>".to_string());
        let html = Some("<html><body><p>No images</p></body></html>");
        assert!(is_real_attachment("image/png", &cid, &Some("logo.png".into()), 15000, html));
    }

    #[test]
    fn inline_image_with_cid_no_html_body() {
        let cid = Some("<logo123>".to_string());
        assert!(is_real_attachment("image/png", &cid, &Some("logo.png".into()), 15000, None));
    }

    #[test]
    fn tracking_pixel_tiny_unnamed_image() {
        assert!(!is_real_attachment("image/gif", &None, &None, 43, None));
    }

    #[test]
    fn tracking_pixel_boundary() {
        // Just under 5000 — still a tracking pixel
        assert!(!is_real_attachment("image/png", &None, &None, 4999, None));
        // At 5000 — counts as real
        assert!(is_real_attachment("image/png", &None, &None, 5000, None));
    }

    #[test]
    fn named_inline_image_no_cid() {
        // Has filename but no Content-ID → user-attached image, counts as real
        assert!(is_real_attachment("image/jpeg", &None, &Some("photo.jpg".into()), 50000, Some("<p>hello</p>")));
    }

    #[test]
    fn non_image_inline_always_real() {
        // Even with Content-ID, non-image types are always real attachments
        let cid = Some("<doc1>".to_string());
        assert!(is_real_attachment("application/pdf", &cid, &Some("doc.pdf".into()), 10000, Some("<p>hello</p>")));
    }

    // ── has_real_attachments integration tests ─────────────────────────

    #[test]
    fn has_real_attachments_mixed_inline_and_real() {
        let attachments = vec![
            LightAttachment {
                filename: Some("logo.png".into()),
                content_type: "image/png".into(),
                content_disposition: Some("Inline".into()),
                size: 15000,
                content_id: Some("<logo1>".into()),
            },
            LightAttachment {
                filename: Some("report.pdf".into()),
                content_type: "application/pdf".into(),
                content_disposition: Some("Attachment".into()),
                size: 102400,
                content_id: None,
            },
        ];
        let html = Some(r#"<img src="cid:logo1">"#);
        assert!(has_real_attachments(&attachments, html));
    }

    #[test]
    fn has_real_attachments_only_embedded_images() {
        let attachments = vec![
            LightAttachment {
                filename: Some("banner.png".into()),
                content_type: "image/png".into(),
                content_disposition: Some("Inline".into()),
                size: 20000,
                content_id: Some("<banner>".into()),
            },
        ];
        let html = Some(r#"<img src="cid:banner">"#);
        assert!(!has_real_attachments(&attachments, html));
    }

    #[test]
    fn has_real_attachments_only_tracking_pixel() {
        let attachments = vec![
            LightAttachment {
                filename: None,
                content_type: "image/gif".into(),
                content_disposition: Some("Inline".into()),
                size: 43,
                content_id: None,
            },
        ];
        assert!(!has_real_attachments(&attachments, Some("<p>hello</p>")));
    }

    #[test]
    fn eml_with_inline_image_has_attachments_false() {
        let raw = b"From: sender@test.com\r\n\
            To: rcpt@test.com\r\n\
            Subject: Inline image test\r\n\
            MIME-Version: 1.0\r\n\
            Content-Type: multipart/related; boundary=\"boundary1\"\r\n\
            \r\n\
            --boundary1\r\n\
            Content-Type: text/html; charset=\"utf-8\"\r\n\
            \r\n\
            <html><body><img src=\"cid:img1\"></body></html>\r\n\
            --boundary1\r\n\
            Content-Type: image/png\r\n\
            Content-Disposition: inline; filename=\"logo.png\"\r\n\
            Content-ID: <img1>\r\n\
            Content-Transfer-Encoding: base64\r\n\
            \r\n\
            iVBORw0KGgoAAAANSUhEUg==\r\n\
            --boundary1--\r\n";
        let email = parse_eml_bytes_light(raw, 1, vec![]).unwrap();
        assert!(!email.has_attachments, "Inline embedded image should not set has_attachments");
        assert_eq!(email.attachments.len(), 1, "Inline image should still be in attachments list");
    }

    #[test]
    fn eml_with_real_plus_inline_has_attachments_true() {
        let raw = b"From: sender@test.com\r\n\
            To: rcpt@test.com\r\n\
            Subject: Mixed attachments\r\n\
            MIME-Version: 1.0\r\n\
            Content-Type: multipart/mixed; boundary=\"outer\"\r\n\
            \r\n\
            --outer\r\n\
            Content-Type: multipart/related; boundary=\"inner\"\r\n\
            \r\n\
            --inner\r\n\
            Content-Type: text/html; charset=\"utf-8\"\r\n\
            \r\n\
            <html><body><img src=\"cid:img1\"><p>Hello</p></body></html>\r\n\
            --inner\r\n\
            Content-Type: image/png\r\n\
            Content-Disposition: inline; filename=\"logo.png\"\r\n\
            Content-ID: <img1>\r\n\
            Content-Transfer-Encoding: base64\r\n\
            \r\n\
            iVBORw0KGgoAAAANSUhEUg==\r\n\
            --inner--\r\n\
            --outer\r\n\
            Content-Type: application/pdf\r\n\
            Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
            Content-Transfer-Encoding: base64\r\n\
            \r\n\
            JVBERi0xLjQK\r\n\
            --outer--\r\n";
        let email = parse_eml_bytes_light(raw, 1, vec![]).unwrap();
        assert!(email.has_attachments, "Email with real PDF attachment should set has_attachments");
    }

    // -----------------------------------------------------------------------
    // Full parse vs light parse consistency (moved from src-tauri/src/main.rs:6261-6286)
    // -----------------------------------------------------------------------

    #[test]
    fn full_and_light_parse_same_attachment_count() {
        let raw = multipart_two_attachments();
        let full = parse_eml_bytes(&raw, 1, vec![]).unwrap();
        let light = parse_eml_bytes_light(&raw, 1, vec![]).unwrap();
        assert_eq!(full.attachments.len(), light.attachments.len());
        assert_eq!(full.has_attachments, light.has_attachments);
    }

    #[test]
    fn full_and_light_parse_same_subject() {
        let raw = multipart_with_attachment();
        let full = parse_eml_bytes(&raw, 1, vec![]).unwrap();
        let light = parse_eml_bytes_light(&raw, 1, vec![]).unwrap();
        assert_eq!(full.subject, light.subject);
    }

    #[test]
    fn full_and_light_parse_same_body_text() {
        let raw = multipart_with_attachment();
        let full = parse_eml_bytes(&raw, 1, vec![]).unwrap();
        let light = parse_eml_bytes_light(&raw, 1, vec![]).unwrap();
        assert_eq!(full.text, light.text);
    }

    #[test]
    fn read_light_at_survives_a_rename_after_the_listing() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path();
        std::fs::write(cur.join("7:2,FS.eml"), eml("seven")).unwrap();

        let seven = read_light_at(cur, 7, Some(&cur.join("7:2,S.eml"))).expect("stale hint falls back to the uid lookup");
        assert_eq!(seven.uid, 7);
        assert!(seven.flags.iter().any(|f| f == "\\Flagged"));
        assert!(seven.flags.iter().any(|f| f == "\\Seen"));

        assert!(read_light_at(cur, 8, Some(&cur.join("8:2,.eml"))).is_none(), "no uid-8 file anywhere");
    }
}
