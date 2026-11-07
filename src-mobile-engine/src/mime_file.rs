//! A message's MIME structure read from a file, without holding the file in memory: one streaming
//! pass finds every leaf part's headers and where its raw (transfer-encoded) body lies, numbered as
//! IMAP numbers BODYSTRUCTURE sections (core's `parts_of`): a single-part message is `1`,
//! multipart children `1..n`, nested ones `a.b`, and a `message/rfc822` part is a leaf. A part's
//! `size` is its raw body's length, which is exactly what range reads of it return, so the
//! attachment worker's end-of-part check holds. The CRLF before a boundary belongs to the boundary
//! (RFC 2046), as in IMAP's `BODY[n]`.
//!
//! Graph accounts read bodies and attachment ranges from the MIME file `backend::graph` downloads
//! (plan Ruling 13).

use mailvault_core::imap::PartInfo;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Most header bytes kept for one part; fields past the cut are lost, the scan goes on.
const MAX_HEADER: usize = 256 * 1024;
/// Most bytes of a body line kept to compare with a boundary (RFC 2046 caps a boundary at 70).
const LINE_KEEP: usize = 256;

/// One leaf part and where its raw body is in the file.
#[derive(Clone, Debug)]
pub(crate) struct Located {
    pub(crate) info: PartInfo,
    pub(crate) start: u64,
    pub(crate) len: u64,
}

/// One line: where it starts, its first bytes without the terminator, and the terminator's length
/// (0 for a last line without one).
struct Line {
    start: u64,
    keep: Vec<u8>,
    term: u64,
}

struct Lines<R> {
    reader: R,
    pos: u64,
    /// The last byte consumed, to tell a CRLF split across two reads.
    last: Option<u8>,
}

impl<R: BufRead> Lines<R> {
    /// The next line, keeping at most `keep` bytes of it; `None` at the end of the file.
    fn next(&mut self, keep: usize) -> io::Result<Option<Line>> {
        let start = self.pos;
        let mut kept = Vec::new();
        let mut len = 0usize;
        loop {
            let buf = self.reader.fill_buf()?;
            if buf.is_empty() {
                return Ok((len > 0).then_some(Line { start, keep: kept, term: 0 }));
            }
            match buf.iter().position(|b| *b == b'\n') {
                Some(i) => {
                    let before = if i > 0 { Some(buf[i - 1]) } else { self.last };
                    let room = keep.saturating_sub(kept.len());
                    kept.extend_from_slice(&buf[..i.min(room)]);
                    len += i;
                    let term = if before == Some(b'\r') { 2 } else { 1 };
                    if term == 2 && kept.len() == len {
                        // The whole line was kept, its `\r` too.
                        kept.pop();
                    }
                    self.last = Some(b'\n');
                    self.reader.consume(i + 1);
                    self.pos += i as u64 + 1;
                    return Ok(Some(Line { start, keep: kept, term }));
                }
                None => {
                    let n = buf.len();
                    let room = keep.saturating_sub(kept.len());
                    kept.extend_from_slice(&buf[..n.min(room)]);
                    len += n;
                    self.last = buf.last().copied();
                    self.reader.consume(n);
                    self.pos += n as u64;
                }
            }
        }
    }

    /// A header block, up to and including its blank line (or the end of the file): its bytes,
    /// and the terminator length of the blank line.
    fn header(&mut self) -> io::Result<(Vec<u8>, u64)> {
        let mut out = Vec::new();
        loop {
            let Some(line) = self.next(MAX_HEADER.saturating_sub(out.len()).max(1))? else {
                return Ok((out, 0));
            };
            if line.keep.is_empty() && line.term > 0 {
                return Ok((out, line.term));
            }
            if out.len() < MAX_HEADER {
                out.extend_from_slice(&line.keep);
                out.extend_from_slice(b"\r\n");
            }
        }
    }
}

/// What a part's header says.
struct Entity {
    info: PartInfo,
    /// `Some` for a multipart with a boundary.
    boundary: Option<Vec<u8>>,
}

fn entity(header: &[u8], section: String) -> Entity {
    let headers = mailparse::parse_headers(header).map(|(h, _)| h).unwrap_or_default();
    let get = |name: &str| headers.iter().find(|h| h.get_key_ref().eq_ignore_ascii_case(name)).map(|h| h.get_value());
    let ctype = mailparse::parse_content_type(&get("Content-Type").unwrap_or_default());
    let disposition = get("Content-Disposition").map(|v| mailparse::parse_content_disposition(&v));
    let mime = ctype.mimetype.to_ascii_lowercase();
    let boundary = if mime.starts_with("multipart/") {
        ctype.params.get("boundary").filter(|b| !b.is_empty()).map(|b| b.as_bytes().to_vec())
    } else {
        None
    };
    let filename = disposition
        .as_ref()
        .and_then(|d| d.params.get("filename"))
        .or_else(|| ctype.params.get("name"))
        .map(|n| mailvault_core::mime::decode_rfc2047(n.as_bytes()))
        .filter(|n| !n.trim().is_empty());
    let disposition = disposition.map(|d| match d.disposition {
        mailparse::DispositionType::Inline => "inline".to_string(),
        mailparse::DispositionType::Attachment => "attachment".to_string(),
        mailparse::DispositionType::FormData => "form-data".to_string(),
        mailparse::DispositionType::Extension(e) => e.to_ascii_lowercase(),
    });
    let info = PartInfo {
        section,
        mime,
        filename,
        size: 0,
        encoding: get("Content-Transfer-Encoding").map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty()).unwrap_or_else(|| "7bit".into()),
        charset: ctype.params.get("charset").map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
        content_id: get("Content-ID").map(|id| id.trim().trim_start_matches('<').trim_end_matches('>').to_string()).filter(|id| !id.is_empty()),
        disposition,
    };
    Entity { info, boundary }
}

/// `Some(closing)` when `line` is a delimiter of `boundary` (`--b`, or `--b--` closing),
/// transport padding allowed after it.
fn delimiter(line: &[u8], boundary: &[u8]) -> Option<bool> {
    let rest = line.strip_prefix(b"--")?.strip_prefix(boundary)?;
    let (closing, rest) = match rest.strip_prefix(b"--") {
        Some(r) => (true, r),
        None => (false, rest),
    };
    rest.iter().all(|b| *b == b' ' || *b == b'\t').then_some(closing)
}

struct Frame {
    boundary: Vec<u8>,
    section: String,
    children: u32,
}

fn child_section(prefix: &str, n: u32) -> String {
    if prefix.is_empty() {
        n.to_string()
    } else {
        format!("{prefix}.{n}")
    }
}

/// Every leaf part of the message in `path`, in section order.
pub(crate) fn index(path: &Path) -> io::Result<Vec<Located>> {
    let mut lines = Lines { reader: BufReader::with_capacity(64 * 1024, File::open(path)?), pos: 0, last: None };
    let mut out: Vec<Located> = Vec::new();
    let mut frames: Vec<Frame> = Vec::new();
    // The leaf whose body is being read, and where that body starts.
    let mut open: Option<(PartInfo, u64)> = None;
    let close = |open: &mut Option<(PartInfo, u64)>, end: u64, out: &mut Vec<Located>| {
        if let Some((mut info, start)) = open.take() {
            let len = end.saturating_sub(start);
            info.size = u32::try_from(len).unwrap_or(u32::MAX);
            out.push(Located { info, start, len });
        }
    };

    let (header, mut prev_term) = lines.header()?;
    let top = entity(&header, String::new());
    match top.boundary {
        Some(b) => frames.push(Frame { boundary: b, section: String::new(), children: 0 }),
        None => open = Some((PartInfo { section: "1".into(), ..top.info }, lines.pos)),
    }

    while let Some(line) = lines.next(LINE_KEEP)? {
        let hit = if line.keep.starts_with(b"--") {
            frames.iter().enumerate().rev().find_map(|(i, f)| delimiter(&line.keep, &f.boundary).map(|c| (i, c)))
        } else {
            None
        };
        let Some((i, closing)) = hit else {
            prev_term = line.term;
            continue;
        };
        close(&mut open, line.start.saturating_sub(prev_term), &mut out);
        // A delimiter of an outer part ends every part nested in it (a malformed inner one).
        frames.truncate(i + 1);
        if closing {
            frames.pop();
            prev_term = line.term;
            continue;
        }
        let frame = &mut frames[i];
        frame.children += 1;
        let section = child_section(&frame.section, frame.children);
        let (header, blank) = lines.header()?;
        let child = entity(&header, section.clone());
        match child.boundary {
            Some(b) => frames.push(Frame { boundary: b, section, children: 0 }),
            None => open = Some((child.info, lines.pos)),
        }
        prev_term = blank;
    }
    // The last leaf runs to the end of the file (a single part, or a multipart never closed).
    close(&mut open, lines.pos, &mut out);
    Ok(out)
}

/// Raw octets `offset..offset + len` of `part` from the file (fewer at the part's end, none past
/// it).
pub(crate) fn read_range(path: &Path, part: &Located, offset: u64, len: u32) -> io::Result<Vec<u8>> {
    let want = part.len.saturating_sub(offset).min(len as u64);
    let mut buf = Vec::with_capacity(want as usize);
    if want == 0 {
        return Ok(buf);
    }
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(part.start + offset))?;
    f.take(want).read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn indexed(raw: &str) -> (tempfile::NamedTempFile, Vec<Located>) {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        std::io::Write::write_all(&mut f, raw.as_bytes()).unwrap();
        let parts = index(f.path()).unwrap();
        (f, parts)
    }

    fn body(f: &tempfile::NamedTempFile, p: &Located) -> String {
        String::from_utf8(read_range(f.path(), p, 0, u32::MAX).unwrap()).unwrap()
    }

    #[test]
    fn a_single_part_message_is_section_1() {
        let (f, parts) = indexed("Subject: x\r\nContent-Type: text/plain; charset=\"utf-8\"\r\n\r\nHello\r\nthere\r\n");
        assert_eq!(parts.len(), 1);
        let p = &parts[0];
        assert_eq!((p.info.section.as_str(), p.info.mime.as_str(), p.info.charset.as_deref()), ("1", "text/plain", Some("utf-8")));
        assert_eq!(p.info.encoding, "7bit");
        assert_eq!(body(&f, p), "Hello\r\nthere\r\n");
        assert_eq!(p.info.size as u64, p.len);
    }

    #[test]
    fn nested_multiparts_number_as_imap_does() {
        let raw = "Content-Type: multipart/mixed; boundary=\"o\"\r\n\r\npreamble\r\n\
--o\r\nContent-Type: multipart/alternative; boundary=\"i\"\r\n\r\n\
--i\r\nContent-Type: text/plain\r\n\r\nplain\r\n\
--i\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n\
--i--\r\n\r\n\
--o\r\nContent-Type: application/pdf; name=\"=?utf-8?Q?r=C3=A9sum=C3=A9.pdf?=\"\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <c1@x>\r\n\r\nQUJD\r\nREVG\r\n\
--o\r\nContent-Type: message/rfc822\r\n\r\nSubject: inner\r\nContent-Type: multipart/mixed; boundary=\"z\"\r\n\r\n--z\r\n\r\nx\r\n--z--\r\n\
--o--\r\nepilogue\r\n";
        let (f, parts) = indexed(raw);
        let sections: Vec<&str> = parts.iter().map(|p| p.info.section.as_str()).collect();
        assert_eq!(sections, ["1.1", "1.2", "2", "3"]);
        assert_eq!(body(&f, &parts[0]), "plain");
        assert_eq!(body(&f, &parts[1]), "<p>html</p>");
        let pdf = &parts[2];
        assert_eq!(body(&f, pdf), "QUJD\r\nREVG");
        assert_eq!(pdf.info.filename.as_deref(), Some("résumé.pdf"));
        assert_eq!((pdf.info.encoding.as_str(), pdf.info.disposition.as_deref(), pdf.info.content_id.as_deref()), ("base64", Some("attachment"), Some("c1@x")));
        assert_eq!(parts[3].info.mime, "message/rfc822");
        assert!(body(&f, &parts[3]).starts_with("Subject: inner"), "a message part is a leaf with its own boundaries inside");
        // Ranges stop at the part's end.
        assert_eq!(read_range(f.path(), pdf, 4, 4).unwrap(), b"\r\nRE");
        assert_eq!(read_range(f.path(), pdf, 8, 100).unwrap(), b"VG");
        assert!(read_range(f.path(), pdf, 10, 100).unwrap().is_empty());
    }

    #[test]
    fn bare_newlines_and_empty_bodies_read() {
        let raw = "Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\n--b\nContent-Type: text/plain\n\nsecond\n--b--\n";
        let (f, parts) = indexed(raw);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len, 0);
        assert_eq!(body(&f, &parts[1]), "second");
    }
}
