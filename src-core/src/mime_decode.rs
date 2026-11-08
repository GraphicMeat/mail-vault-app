//! Incremental transfer decoding: base64 and quoted-printable undone chunk by chunk, for a part
//! fetched in ranges (the mobile attachment cache resumes a stopped download). Core's
//! `imap::parts::decode_transfer` decodes a whole buffer; this decodes the same bytes, split
//! anywhere.

use std::borrow::Cow;

/// Longest run a quoted-printable decoder holds back (trailing whitespace whose fate the next
/// byte decides); past it the run is written as it is.
const QP_HOLD_MAX: usize = 4096;

/// Undoes a transfer encoding chunk by chunk. `held()` is how many raw bytes at the end of what
/// was fed are not decoded yet (an unfinished base64 quad with the whitespace inside it, or a
/// quoted-printable escape or whitespace run whose meaning the next byte decides); a resume
/// restarts at that many bytes before the end, with a fresh decoder.
pub enum StreamDecoder {
    Identity,
    Base64 {
        quad: [u8; 4],
        n: usize,
        /// Raw bytes since the quad's first character, that character included.
        held: usize,
    },
    Qp {
        held: Vec<u8>,
    },
}

fn b64_value(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'A'..=b'F' => Some(b - b'A' + 10),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

fn is_blank(b: u8) -> bool {
    b == b' ' || b == b'\t'
}

impl StreamDecoder {
    pub fn new(encoding: &str) -> StreamDecoder {
        match encoding.trim().to_ascii_lowercase().as_str() {
            "base64" => StreamDecoder::Base64 { quad: [0; 4], n: 0, held: 0 },
            "quoted-printable" => StreamDecoder::Qp { held: Vec::new() },
            _ => StreamDecoder::Identity,
        }
    }

    pub fn held(&self) -> usize {
        match self {
            StreamDecoder::Identity => 0,
            StreamDecoder::Base64 { held, .. } => *held,
            StreamDecoder::Qp { held } => held.len(),
        }
    }

    pub fn feed(&mut self, data: &[u8], out: &mut Vec<u8>) {
        match self {
            StreamDecoder::Identity => out.extend_from_slice(data),
            StreamDecoder::Base64 { quad, n, held } => {
                out.reserve(data.len() / 4 * 3 + 3);
                for &b in data {
                    if let Some(v) = b64_value(b) {
                        quad[*n] = v;
                        *n += 1;
                        if *n == 4 {
                            out.extend_from_slice(&[quad[0] << 2 | quad[1] >> 4, quad[1] << 4 | quad[2] >> 2, quad[2] << 6 | quad[3]]);
                            *n = 0;
                            *held = 0;
                        } else {
                            *held += 1;
                        }
                    } else if b == b'=' {
                        // Padding ends the quad: what it holds is one or two bytes.
                        flush_quad(quad, *n, out);
                        *n = 0;
                        *held = 0;
                    } else if *n > 0 {
                        // Line breaks and stray characters inside a quad are skipped, but held.
                        *held += 1;
                    }
                }
            }
            StreamDecoder::Qp { held } => {
                let buf: Cow<[u8]> = if held.is_empty() {
                    Cow::Borrowed(data)
                } else {
                    let mut b = std::mem::take(held);
                    b.extend_from_slice(data);
                    Cow::Owned(b)
                };
                let used = qp_decode(&buf, false, out);
                *held = buf[used..].to_vec();
            }
        }
    }

    /// The input ended: decodes whatever was held back.
    pub fn finish(&mut self, out: &mut Vec<u8>) {
        match self {
            StreamDecoder::Identity => {}
            StreamDecoder::Base64 { quad, n, held } => {
                flush_quad(quad, *n, out);
                *n = 0;
                *held = 0;
            }
            StreamDecoder::Qp { held } => {
                let buf = std::mem::take(held);
                qp_decode(&buf, true, out);
            }
        }
    }
}

/// The bytes a quad cut short by padding (or by the end) carries: two characters make one byte,
/// three make two; one alone makes none.
fn flush_quad(quad: &[u8; 4], n: usize, out: &mut Vec<u8>) {
    if n >= 2 {
        out.push(quad[0] << 2 | quad[1] >> 4);
    }
    if n >= 3 {
        out.push(quad[1] << 4 | quad[2] >> 2);
    }
}

/// Decodes quoted-printable from `buf` into `out` as far as the bytes decide, and returns how many
/// bytes it used; the rest waits for more input. RFC 2045 6.7 with a lenient reader's rules: `=XX`
/// is a byte, `=` before a line break (whitespace allowed between) is a soft break, a `=` that is
/// neither is itself, blanks before a line break are transport padding and dropped, and a hard
/// line break (LF or CRLF) comes out as CRLF, as core's whole-part decode writes it. At the
/// `end`, a trailing `=` and trailing blanks are dropped too.
fn qp_decode(buf: &[u8], end: bool, out: &mut Vec<u8>) -> usize {
    out.reserve(buf.len());
    let len = buf.len();
    let mut i = 0;
    while i < len {
        let b = buf[i];
        if b == b'=' {
            let j = i + 1;
            if j == len {
                if end {
                    return len;
                }
                return i;
            }
            match buf[j] {
                h if hex_value(h).is_some() => {
                    if j + 1 == len && !end {
                        return i;
                    }
                    match buf.get(j + 1).copied().and_then(hex_value) {
                        Some(lo) => {
                            out.push(hex_value(h).unwrap() << 4 | lo);
                            i += 3;
                        }
                        None => {
                            out.push(b'=');
                            i += 1;
                        }
                    }
                }
                b'\n' => i = j + 1,
                b'\r' => match buf.get(j + 1) {
                    Some(b'\n') => i = j + 2,
                    None if !end => return i,
                    None => return len,
                    Some(_) => {
                        out.push(b'=');
                        i += 1;
                    }
                },
                c if is_blank(c) => {
                    let mut k = j;
                    while k < len && is_blank(buf[k]) {
                        k += 1;
                    }
                    match buf.get(k) {
                        None if end => return len,
                        None if k - i <= QP_HOLD_MAX => return i,
                        Some(b'\n') => i = k + 1,
                        Some(b'\r') if buf.get(k + 1) == Some(&b'\n') => i = k + 2,
                        Some(b'\r') if k + 1 == len && !end => return i,
                        _ => {
                            out.push(b'=');
                            i += 1;
                        }
                    }
                }
                _ => {
                    out.push(b'=');
                    i += 1;
                }
            }
        } else if is_blank(b) {
            let mut k = i + 1;
            while k < len && is_blank(buf[k]) {
                k += 1;
            }
            let trailing = match buf.get(k) {
                None if end => true,
                None if k - i <= QP_HOLD_MAX => return i,
                Some(b'\n') => true,
                Some(b'\r') if buf.get(k + 1) == Some(&b'\n') => true,
                Some(b'\r') if k + 1 == len && !end && k - i <= QP_HOLD_MAX => return i,
                _ => false,
            };
            if !trailing {
                out.extend_from_slice(&buf[i..k]);
            }
            i = k;
        } else if b == b'\n' {
            // A hard line break is CRLF, as core's whole-part decode writes it.
            out.extend_from_slice(b"\r\n");
            i += 1;
        } else if b == b'\r' {
            match buf.get(i + 1) {
                Some(b'\n') => {
                    out.extend_from_slice(b"\r\n");
                    i += 2;
                }
                None if !end => return i,
                _ => {
                    out.push(b'\r');
                    i += 1;
                }
            }
        } else {
            // Plain bytes up to the next one that needs a look.
            let mut k = i + 1;
            while k < len && !matches!(buf[k], b'=' | b'\r' | b'\n') && !is_blank(buf[k]) {
                k += 1;
            }
            out.extend_from_slice(&buf[i..k]);
            i = k;
        }
    }
    len
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_split(data: &[u8], encoding: &str, splits: &[usize]) -> Vec<u8> {
        let mut d = StreamDecoder::new(encoding);
        let mut out = Vec::new();
        let mut from = 0;
        for &s in splits.iter().chain(std::iter::once(&data.len())) {
            d.feed(&data[from..s], &mut out);
            from = s;
        }
        d.finish(&mut out);
        out
    }

    fn samples() -> Vec<(&'static str, Vec<u8>)> {
        let mut b64 = Vec::new();
        for _ in 0..40 {
            b64.extend_from_slice(b"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0\r\n");
        }
        b64.extend_from_slice(b"QUI=\r\n");
        vec![
            ("base64", b"aGVs\r\nbG8gd29y\r\nbGQ=\r\n".to_vec()),
            ("base64", b"aGVsbG8=".to_vec()),
            ("base64", b"aGVsbA==\r\n".to_vec()),
            ("base64", b64),
            ("quoted-printable", b"caf=C3=A9 =\r\nbar  \r\nGr=c3=bc=C3=9Fe =3D=\r\nend \t\r\n=\r\nx = y =ZZ =\r".to_vec()),
            ("quoted-printable", b"soft =  \r\nbreak=\nlf only  \nlast line no eol  ".to_vec()),
            ("quoted-printable", b"trailing equals=".to_vec()),
            ("7bit", b"as is \r\n".to_vec()),
        ]
    }

    /// Split at every byte (and at every pair of bytes for the short inputs), the streaming decode
    /// equals core's whole-buffer decode.
    #[test]
    fn decoder_matches_whole_decode_at_every_split() {
        for (enc, data) in samples() {
            let whole = crate::imap::parts::decode_transfer(&data, enc);
            assert_eq!(decode_split(&data, enc, &[]), whole, "{enc} {:?}", String::from_utf8_lossy(&data));
            for s in 0..=data.len() {
                assert_eq!(decode_split(&data, enc, &[s]), whole, "{enc} split at {s}: {:?}", String::from_utf8_lossy(&data));
            }
            if data.len() <= 80 {
                for a in 0..=data.len() {
                    for b in a..=data.len() {
                        assert_eq!(decode_split(&data, enc, &[a, b]), whole, "{enc} splits {a},{b}");
                    }
                }
            }
        }
    }

    /// What `held()` reports is exactly what a resume must re-read: decoding the rest from that
    /// offset with a fresh decoder, after the bytes already out, gives the whole decode.
    #[test]
    fn held_marks_the_resume_offset() {
        for (enc, data) in samples() {
            let whole = crate::imap::parts::decode_transfer(&data, enc);
            for s in 0..=data.len() {
                let mut d = StreamDecoder::new(enc);
                let mut out = Vec::new();
                d.feed(&data[..s], &mut out);
                let resume_at = s - d.held();
                let mut fresh = StreamDecoder::new(enc);
                fresh.feed(&data[resume_at..], &mut out);
                fresh.finish(&mut out);
                assert_eq!(out, whole, "{enc} resumed at {resume_at} after a stop at {s}");
            }
        }
    }
}
