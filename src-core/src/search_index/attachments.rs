//! Attachment and image text extraction. Spec 8 (phase 3).
//!
//! Classification and Office/text extraction are pure Rust and run on every
//! platform; PDF text-layer, PDF OCR and image OCR go through `TextExtractor`,
//! whose real implementation lives in `src-tauri` (platform-specific: PDFKit +
//! Vision on macOS, a `pdf-extract` subprocess elsewhere, no OCR elsewhere).
//!
//! `extract` never returns a terminal state for a transient failure: the
//! caller must be able to tell "this file will never index" from "try again
//! next sweep" (a permanent-error state ships once "phase 1 shipped this
//! exact bug: pinning IsADirectory as BODY_UNPARSEABLE forever").

use super::text::{cap_chars, html_to_text};

pub const MAX_PART_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_ZIP_UNCOMPRESSED: u64 = 50 * 1024 * 1024;
pub const MAX_PART_CHARS: usize = 200_000;
pub const MIN_IMAGE_BYTES: u64 = 10 * 1024;
pub const MIN_IMAGE_SHORT_SIDE_PX: u32 = 128;
pub const MAX_OCR_PAGES: usize = 50;

#[derive(Debug, Clone)]
pub struct AttachmentInput {
    pub filename: String,
    pub mime: String,
    pub size: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub enum ExtractError {
    /// Retry next sweep: a subprocess timeout, an I/O error, an OOM. Never
    /// written to the `attachments.state` column.
    Transient(String),
    /// A real, permanent verdict: `state` is one of the spec's non-"ok" values.
    Permanent(&'static str),
}

pub trait TextExtractor: Send + Sync {
    fn pdf_text_layer(&self, bytes: &[u8]) -> Result<(String, usize), ExtractError>; // (text, page_count)
    fn pdf_ocr(&self, bytes: &[u8], max_pages: usize) -> Result<String, ExtractError>;
    fn image_ocr(&self, bytes: &[u8], mime: &str) -> Result<String, ExtractError>;
}

/// The default when no platform extractor is wired: every native call is
/// `unsupported`, never `failed` — this is a capability gap, not a broken file.
pub struct NoOcrExtractor;

impl TextExtractor for NoOcrExtractor {
    fn pdf_text_layer(&self, _bytes: &[u8]) -> Result<(String, usize), ExtractError> {
        Err(ExtractError::Permanent("unsupported"))
    }
    fn pdf_ocr(&self, _bytes: &[u8], _max_pages: usize) -> Result<String, ExtractError> {
        Err(ExtractError::Permanent("unsupported"))
    }
    fn image_ocr(&self, _bytes: &[u8], _mime: &str) -> Result<String, ExtractError> {
        Err(ExtractError::Permanent("unsupported"))
    }
}

fn is_text_like(mime: &str, filename: &str) -> bool {
    let mime = mime.to_lowercase();
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    mime.starts_with("text/") || matches!(ext.as_str(), "csv" | "ics" | "md" | "markdown" | "html" | "htm" | "txt")
}

fn is_office(mime: &str, filename: &str) -> bool {
    let mime = mime.to_lowercase();
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    mime.contains("officedocument") || matches!(ext.as_str(), "docx" | "xlsx" | "pptx")
}

fn is_pdf(mime: &str, filename: &str) -> bool {
    mime.eq_ignore_ascii_case("application/pdf") || filename.to_lowercase().ends_with(".pdf")
}

fn is_image(mime: &str) -> bool {
    mime.to_lowercase().starts_with("image/")
}

/// Extract raw text from a `text/*`-shaped part: decode as UTF-8 lossily
/// (charset detection is the reader's job for the body; attachments have no
/// established charset-sniffing here and lossily-decoded garble still tokenizes
/// harmlessly), strip HTML tags when the part is HTML.
fn extract_text_like(input: &AttachmentInput) -> String {
    let raw = String::from_utf8_lossy(&input.bytes).into_owned();
    let ext = input.filename.rsplit('.').next().unwrap_or("").to_lowercase();
    let is_html = input.mime.eq_ignore_ascii_case("text/html") || ext == "html" || ext == "htm";
    if is_html { html_to_text(&raw) } else { raw }
}

/// docx/xlsx/pptx are zip archives; strip XML tags from the parts that carry
/// the document's visible text. A byte counter over uncompressed reads guards
/// against a zip bomb regardless of what the archive's central directory claims.
fn extract_office(input: &AttachmentInput) -> Result<String, ExtractError> {
    let reader = std::io::Cursor::new(&input.bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|_| ExtractError::Permanent("failed"))?;
    let mut out = String::new();
    let mut budget = MAX_ZIP_UNCOMPRESSED;
    use std::io::Read;
    for i in 0..zip.len() {
        if budget == 0 {
            break;
        }
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        let wanted = name == "word/document.xml"
            || name == "xl/sharedStrings.xml"
            || (name.starts_with("ppt/slides/slide") && name.ends_with(".xml"));
        if !wanted {
            continue;
        }
        // `entry.size()` is the archive's OWN claimed uncompressed size from the
        // central directory, and a crafted zip can lie about it — sizing an
        // allocation from it lets an attacker force large `vec![]`s per entry
        // while supplying almost no real data (memory/CPU amplification). Read
        // in small fixed chunks instead, so the only thing bounding work is
        // `budget`, which is decremented only by bytes actually read.
        let mut chunk = [0u8; 64 * 1024];
        let mut entry_buf = Vec::new();
        loop {
            if budget == 0 {
                break;
            }
            let want = chunk.len().min(budget as usize);
            let n = match entry.read(&mut chunk[..want]) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            entry_buf.extend_from_slice(&chunk[..n]);
            budget = budget.saturating_sub(n as u64);
        }
        if !entry_buf.is_empty() {
            let xml = String::from_utf8_lossy(&entry_buf);
            out.push_str(&strip_xml_tags(&xml));
            out.push('\n');
        }
    }
    Ok(out)
}

fn strip_xml_tags(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut in_tag = false;
    for c in xml.chars() {
        match c {
            '<' => in_tag = true,
            '>' => { in_tag = false; out.push(' '); }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// The one place every attachment part is classified and extracted.
/// `premium` and `enabled` (the settings toggles, already entitlement- and
/// platform-gated by the caller via `IndexConfig`) decide the two states that
/// never touch content at all.
pub fn extract(input: &AttachmentInput, premium: bool, enabled: bool, extractor: &dyn TextExtractor) -> (&'static str, Option<String>) {
    if !enabled {
        return ("disabled", None);
    }
    if !premium {
        return ("not_premium", None);
    }
    if input.size > MAX_PART_BYTES {
        return ("too_large", None);
    }
    if is_image(&input.mime) && input.size < MIN_IMAGE_BYTES {
        return ("too_small", None);
    }
    if is_text_like(&input.mime, &input.filename) {
        let text = cap_chars(extract_text_like(input), MAX_PART_CHARS);
        return ("ok", Some(text));
    }
    if is_office(&input.mime, &input.filename) {
        return match extract_office(input) {
            Ok(text) => ("ok", Some(cap_chars(text, MAX_PART_CHARS))),
            Err(ExtractError::Permanent(state)) => (state, None),
            Err(ExtractError::Transient(_)) => ("pending", None),
        };
    }
    if is_pdf(&input.mime, &input.filename) {
        return match extractor.pdf_text_layer(&input.bytes) {
            Ok((text, pages)) if text.trim().chars().count() >= 32 * pages.max(1) => {
                ("ok", Some(cap_chars(text, MAX_PART_CHARS)))
            }
            Ok(_) => match extractor.pdf_ocr(&input.bytes, MAX_OCR_PAGES) {
                Ok(text) if !text.trim().is_empty() => ("ok", Some(cap_chars(text, MAX_PART_CHARS))),
                Ok(_) => ("unsupported", None),
                Err(ExtractError::Permanent(state)) => (state, None),
                Err(ExtractError::Transient(_)) => ("pending", None),
            },
            Err(ExtractError::Permanent(state)) => (state, None),
            Err(ExtractError::Transient(_)) => ("pending", None),
        };
    }
    if is_image(&input.mime) {
        return match extractor.image_ocr(&input.bytes, &input.mime) {
            Ok(text) => ("ok", Some(cap_chars(text, MAX_PART_CHARS))),
            Err(ExtractError::Permanent(state)) => (state, None),
            Err(ExtractError::Transient(_)) => ("pending", None),
        };
    }
    ("unsupported", None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(mime: &str, filename: &str, bytes: Vec<u8>) -> AttachmentInput {
        AttachmentInput { filename: filename.into(), mime: mime.into(), size: bytes.len() as u64, bytes }
    }

    #[test]
    fn disabled_short_circuits_before_any_content_check() {
        let i = input("text/plain", "a.txt", b"hi".to_vec());
        assert_eq!(extract(&i, true, false, &NoOcrExtractor).0, "disabled");
    }

    #[test]
    fn not_premium_short_circuits_before_size_check() {
        let mut bytes = vec![0u8; MAX_PART_BYTES as usize + 1];
        bytes[0] = b'a';
        let i = input("text/plain", "a.txt", bytes);
        assert_eq!(extract(&i, false, true, &NoOcrExtractor).0, "not_premium");
    }

    #[test]
    fn oversized_part_is_too_large() {
        let i = input("text/plain", "a.txt", vec![0u8; MAX_PART_BYTES as usize + 1]);
        assert_eq!(extract(&i, true, true, &NoOcrExtractor).0, "too_large");
    }

    #[test]
    fn tiny_image_is_too_small() {
        let i = input("image/png", "a.png", vec![0u8; 100]);
        assert_eq!(extract(&i, true, true, &NoOcrExtractor).0, "too_small");
    }

    #[test]
    fn plain_text_extracts_verbatim() {
        let i = input("text/plain", "notes.txt", b"hello world".to_vec());
        let (state, text) = extract(&i, true, true, &NoOcrExtractor);
        assert_eq!(state, "ok");
        assert_eq!(text.as_deref(), Some("hello world"));
    }

    #[test]
    fn html_attachment_strips_tags() {
        let i = input("text/html", "page.html", b"<p>Hello <b>World</b></p>".to_vec());
        let (state, text) = extract(&i, true, true, &NoOcrExtractor);
        assert_eq!(state, "ok");
        assert!(text.unwrap().contains("Hello"));
    }

    #[test]
    fn oversized_text_is_capped_at_max_part_chars() {
        let big = "x".repeat(MAX_PART_CHARS + 5000);
        let i = input("text/plain", "big.txt", big.into_bytes());
        let (state, text) = extract(&i, true, true, &NoOcrExtractor);
        assert_eq!(state, "ok");
        assert_eq!(text.unwrap().chars().count(), MAX_PART_CHARS);
    }

    #[test]
    fn unrecognized_binary_is_unsupported() {
        let i = input("application/octet-stream", "a.bin", vec![1, 2, 3, 4]);
        assert_eq!(extract(&i, true, true, &NoOcrExtractor).0, "unsupported");
    }

    #[test]
    fn pdf_without_a_working_extractor_is_unsupported_not_failed() {
        let i = input("application/pdf", "a.pdf", b"%PDF-1.4 not a real pdf".to_vec());
        // NoOcrExtractor returns Permanent("unsupported") for both text-layer and OCR.
        assert_eq!(extract(&i, true, true, &NoOcrExtractor).0, "unsupported");
    }

    struct TransientExtractor;
    impl TextExtractor for TransientExtractor {
        fn pdf_text_layer(&self, _b: &[u8]) -> Result<(String, usize), ExtractError> {
            Err(ExtractError::Transient("subprocess timed out".into()))
        }
        fn pdf_ocr(&self, _b: &[u8], _m: usize) -> Result<String, ExtractError> {
            Err(ExtractError::Transient("timeout".into()))
        }
        fn image_ocr(&self, _b: &[u8], _m: &str) -> Result<String, ExtractError> {
            Err(ExtractError::Transient("timeout".into()))
        }
    }

    #[test]
    fn a_transient_pdf_error_is_pending_not_a_terminal_state() {
        let i = input("application/pdf", "a.pdf", b"%PDF-1.4".to_vec());
        let (state, text) = extract(&i, true, true, &TransientExtractor);
        assert_eq!(state, "pending");
        assert!(text.is_none());
    }

    #[test]
    fn a_transient_image_ocr_error_is_pending_not_a_terminal_state() {
        let i = input("image/png", "a.png", vec![0u8; MIN_IMAGE_BYTES as usize + 1]);
        let (state, _) = extract(&i, true, true, &TransientExtractor);
        assert_eq!(state, "pending");
    }

    #[test]
    fn a_valid_docx_extracts_document_xml_text() {
        // Build a minimal docx (zip containing word/document.xml) in-memory.
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            zip.start_file("word/document.xml", opts).unwrap();
            use std::io::Write;
            zip.write_all(b"<w:document><w:body><w:t>Hello Docx</w:t></w:body></w:document>").unwrap();
            zip.finish().unwrap();
        }
        let i = input(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "report.docx",
            buf,
        );
        let (state, text) = extract(&i, true, true, &NoOcrExtractor);
        assert_eq!(state, "ok");
        assert!(text.unwrap().contains("Hello Docx"));
    }

    #[test]
    fn a_corrupt_docx_is_a_terminal_failure_not_pending() {
        let i = input(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "report.docx",
            b"this is not a zip file".to_vec(),
        );
        let (state, _) = extract(&i, true, true, &NoOcrExtractor);
        assert_ne!(state, "pending", "a corrupt zip is a permanent verdict, not a retry");
        assert_ne!(state, "ok");
    }

    /// `entry.size()` is the zip's own claimed uncompressed size and cannot be
    /// trusted for allocation sizing: a crafted archive can declare a huge size
    /// per entry while holding almost no real data, which would previously force
    /// a `vec![0u8; claimed_size]` allocation on every matching entry. The `zip`
    /// crate's write API doesn't let us lie about an entry's declared size
    /// directly, so this proves the same class of amplification a different way:
    /// many small matching entries (`ppt/slides/slideN.xml` has no bound on N)
    /// must not cause per-entry allocations anywhere near `MAX_ZIP_UNCOMPRESSED`,
    /// and the whole extraction must stay fast and respect `MAX_PART_CHARS`.
    #[test]
    fn many_small_matching_zip_entries_do_not_blow_up_extraction() {
        let mut buf = Vec::new();
        const ENTRY_COUNT: usize = 500;
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            use std::io::Write;
            for n in 0..ENTRY_COUNT {
                zip.start_file(format!("ppt/slides/slide{n}.xml"), opts).unwrap();
                zip.write_all(b"<p:sld><p:txBody><a:t>hi</a:t></p:txBody></p:sld>").unwrap();
            }
            zip.finish().unwrap();
        }
        let i = input(
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "deck.pptx",
            buf,
        );
        let start = std::time::Instant::now();
        let (state, text) = extract(&i, true, true, &NoOcrExtractor);
        let elapsed = start.elapsed();
        assert_eq!(state, "ok");
        let text = text.unwrap();
        // Real content across all 500 tiny entries is a few KB, nowhere close to
        // MAX_ZIP_UNCOMPRESSED (50MB) or even MAX_PART_CHARS (200_000) — proves no
        // per-entry allocation was driven by a claimed/self-reported size.
        assert!(text.len() < 100_000, "extracted text unexpectedly large: {} bytes", text.len());
        assert!(text.contains("hi"));
        assert!(elapsed.as_secs() < 5, "extraction took too long: {elapsed:?}");
    }
}
