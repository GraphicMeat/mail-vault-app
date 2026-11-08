//! File extension <-> media type, one table. Used where a picked file's name
//! must become a MIME type (compose attachments) and where a MIME type must
//! become an extension.

/// (extension, media type). The first row for a media type is its canonical
/// extension; later rows are alternate spellings that only map name -> type.
const TABLE: &[(&str, &str)] = &[
    ("pdf", "application/pdf"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("heic", "image/heic"),
    ("heif", "image/heif"),
    ("txt", "text/plain"),
    ("csv", "text/csv"),
    ("html", "text/html"),
    ("htm", "text/html"),
    ("ics", "text/calendar"),
    ("vcf", "text/vcard"),
    ("eml", "message/rfc822"),
    ("json", "application/json"),
    ("zip", "application/zip"),
    ("doc", "application/msword"),
    ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("xls", "application/vnd.ms-excel"),
    ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ("ppt", "application/vnd.ms-powerpoint"),
    ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("mp4", "video/mp4"),
    ("mov", "video/quicktime"),
];

/// The fallback type for an extension the table does not know.
pub const OCTET_STREAM: &str = "application/octet-stream";

/// The media type for a file name's extension (case-insensitive);
/// `application/octet-stream` when the extension says nothing.
pub fn mime_of_name(name: &str) -> &'static str {
    let Some((_, ext)) = name.rsplit_once('.') else { return OCTET_STREAM };
    mime_of_ext(ext).unwrap_or(OCTET_STREAM)
}

/// The media type for an extension (no dot, case-insensitive), if known.
pub fn mime_of_ext(ext: &str) -> Option<&'static str> {
    TABLE.iter().find(|(e, _)| e.eq_ignore_ascii_case(ext)).map(|(_, m)| *m)
}

/// The canonical extension for a media type (case-insensitive, parameters
/// ignored), if known.
pub fn ext_for_mime(mime: &str) -> Option<&'static str> {
    let base = mime.split(';').next().unwrap_or("").trim();
    TABLE.iter().find(|(_, m)| m.eq_ignore_ascii_case(base)).map(|(e, _)| *e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_map_to_types() {
        for (name, want) in [
            ("a.pdf", "application/pdf"),
            ("A.PDF", "application/pdf"),
            ("photo.JPG", "image/jpeg"),
            ("photo.jpeg", "image/jpeg"),
            ("x.htm", "text/html"),
            ("x.html", "text/html"),
            ("forward.eml", "message/rfc822"),
            ("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            ("clip.mov", "video/quicktime"),
            ("a.tar.gz", OCTET_STREAM),
            ("noext", OCTET_STREAM),
            ("", OCTET_STREAM),
            ("trailing.", OCTET_STREAM),
            (".hidden", OCTET_STREAM),
        ] {
            assert_eq!(mime_of_name(name), want, "{name:?}");
        }
    }

    #[test]
    fn types_map_to_one_canonical_extension() {
        for (mime, want) in [
            ("image/jpeg", Some("jpg")),
            ("IMAGE/JPEG; charset=x", Some("jpg")),
            ("text/html", Some("html")),
            ("message/rfc822", Some("eml")),
            ("audio/mpeg", Some("mp3")),
            ("application/x-unknown", None),
            ("", None),
        ] {
            assert_eq!(ext_for_mime(mime), want, "{mime:?}");
        }
    }

    #[test]
    fn every_canonical_extension_round_trips() {
        for (ext, mime) in TABLE {
            assert_eq!(mime_of_ext(ext), Some(*mime));
            let canonical = ext_for_mime(mime).unwrap();
            assert_eq!(mime_of_ext(canonical), Some(*mime), "{mime}");
        }
    }
}
