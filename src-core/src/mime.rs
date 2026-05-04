//! RFC 2047 encoded-word decoding for mail headers.
//!
//! `mailparse` (0.15) follows RFC 2047 §6.2 strictly: an encoded-word must
//! be separated from adjacent encoded-words or plain text by linear-white-
//! space. Many real-world MUAs emit non-conformant headers like
//! `=?utf-8?Q?Dovan=C4=97l=C4=97_?=naujagimiui` where the encoded-word
//! butts directly against plain text. mailparse leaves those raw, which
//! surfaces in the UI as a literal `=?charset?Q?...?=` blob.
//!
//! `decode_rfc2047` here is lenient: it scans for `=?charset?enc?text?=`
//! tokens regardless of surrounding whitespace, decodes each, strips
//! whitespace only between two adjacent encoded-words (per RFC 2047
//! §6.2), and keeps non-token text verbatim.

/// Decode RFC 2047 encoded-words in raw header bytes.
///
/// Falls back to a lossy UTF-8 string if no encoded-word marker is present
/// or a token fails to parse.
pub fn decode_rfc2047(raw: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(raw);
    if !lossy.contains("=?") {
        return lossy.into_owned();
    }

    let bytes = lossy.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    let mut last_was_encoded_word = false;

    while i < bytes.len() {
        if bytes[i] == b'=' && i + 1 < bytes.len() && bytes[i + 1] == b'?' {
            if let Some((decoded, end)) = try_decode_encoded_word(bytes, i) {
                if last_was_encoded_word {
                    let trimmed = out
                        .trim_end_matches(|c: char| c == ' ' || c == '\t' || c == '\r' || c == '\n')
                        .len();
                    out.truncate(trimmed);
                }
                out.push_str(&decoded);
                i = end;
                last_was_encoded_word = true;
                continue;
            }
        }
        let ch = lossy[i..].chars().next().unwrap();
        let ch_len = ch.len_utf8();
        if !ch.is_whitespace() {
            last_was_encoded_word = false;
        }
        out.push(ch);
        i += ch_len;
    }
    out
}

fn try_decode_encoded_word(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    debug_assert!(bytes[start] == b'=' && bytes.get(start + 1) == Some(&b'?'));
    let cs_start = start + 2;
    let cs_end = bytes[cs_start..].iter().position(|&b| b == b'?')? + cs_start;
    let enc_start = cs_end + 1;
    if enc_start + 1 >= bytes.len() || bytes[enc_start + 1] != b'?' {
        return None;
    }
    let enc_byte = bytes[enc_start];
    let text_start = enc_start + 2;

    let mut search = text_start;
    let text_end;
    loop {
        if search + 1 >= bytes.len() {
            return None;
        }
        if bytes[search] == b'?' && bytes[search + 1] == b'=' {
            text_end = search;
            break;
        }
        if matches!(bytes[search], b' ' | b'\t' | b'\r' | b'\n') {
            return None;
        }
        search += 1;
    }

    let charset_label = std::str::from_utf8(&bytes[cs_start..cs_end]).ok()?;
    let charset_label = charset_label.split('*').next().unwrap_or(charset_label);
    let text = &bytes[text_start..text_end];

    let raw_bytes: Vec<u8> = match enc_byte {
        b'Q' | b'q' => {
            let mut buf = Vec::with_capacity(text.len());
            let mut j = 0;
            while j < text.len() {
                match text[j] {
                    b'_' => {
                        buf.push(b' ');
                        j += 1;
                    }
                    b'=' if j + 2 < text.len() => {
                        let hi = (text[j + 1] as char).to_digit(16);
                        let lo = (text[j + 2] as char).to_digit(16);
                        if let (Some(h), Some(l)) = (hi, lo) {
                            buf.push((h * 16 + l) as u8);
                            j += 3;
                        } else {
                            buf.push(b'=');
                            j += 1;
                        }
                    }
                    other => {
                        buf.push(other);
                        j += 1;
                    }
                }
            }
            buf
        }
        b'B' | b'b' => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(text))
                .ok()?
        }
        _ => return None,
    };

    let cs = charset::Charset::for_label_no_replacement(charset_label.as_bytes())
        .or_else(|| charset::Charset::for_label_no_replacement(b"utf-8"))?;
    let (decoded, _, _) = cs.decode(&raw_bytes);
    Some((decoded.into_owned(), text_end + 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_no_encoded_word() {
        assert_eq!(decode_rfc2047(b"Hello world"), "Hello world");
    }

    #[test]
    fn q_with_separating_space() {
        assert_eq!(
            decode_rfc2047(b"=?utf-8?Q?Dovan=C4=97l=C4=97?= naujagimiui"),
            "Dovanėlė naujagimiui"
        );
    }

    #[test]
    fn q_no_separating_space_real_world() {
        // The reported real-world bug.
        assert_eq!(
            decode_rfc2047(b"=?utf-8?Q?Dovan=C4=97l=C4=97_?=naujagimiui ir mamai"),
            "Dovanėlė naujagimiui ir mamai"
        );
    }

    #[test]
    fn b_base64() {
        assert_eq!(decode_rfc2047(b"=?utf-8?B?SGVsbG8=?=World"), "HelloWorld");
    }

    #[test]
    fn consecutive_encoded_words_strip_whitespace() {
        assert_eq!(decode_rfc2047(b"=?utf-8?Q?foo?= =?utf-8?Q?bar?="), "foobar");
    }

    #[test]
    fn windows_1257_lithuanian() {
        assert_eq!(decode_rfc2047(b"=?windows-1257?Q?=D0?="), "Š");
    }

    #[test]
    fn malformed_passthrough() {
        assert_eq!(
            decode_rfc2047(b"=?utf-8?Q?broken plain text"),
            "=?utf-8?Q?broken plain text"
        );
    }
}
