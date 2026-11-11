//! QR frame codec: a sealed phone bundle is too big for one readable QR
//! code, so it travels as frames `MVQR1:<id>:<i>/<n>:<chunk>`. `id` is 8 hex
//! digits shared by every frame of one code, `i` is 1-based, and `chunk` is
//! base64url (no padding) of that frame's slice of the ciphertext. The phone
//! feeds every frame it reads into an [`Assembler`]; the camera reads each
//! frame many times, in any order.
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;

pub const FRAME_MAGIC: &str = "MVQR1";
/// The longest frame text. Every frame of this length fits a QR code of
/// version 25 or lower at error correction M (tested), which a phone reads
/// off a laptop screen.
pub const MAX_FRAME_CHARS: usize = 800;
/// `i` and `n` have at most two digits.
pub const MAX_FRAMES: usize = 99;
/// `MVQR1:` + 8 hex + `:` + `99/99` + `:`.
const HEADER_MAX: usize = FRAME_MAGIC.len() + 1 + 8 + 1 + 5 + 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Not a MailVault phone frame (or a damaged one).
    Format,
    /// A frame of a different code: the desktop showed a new code (after the
    /// five-minute hide, say). Start over with that code.
    ForeignId,
    /// Same index read twice with different contents.
    Conflict,
    /// The ciphertext needs more than [`MAX_FRAMES`] frames.
    TooLarge,
    Incomplete { have: usize, total: usize },
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Format => write!(f, "E_PHONE_FRAME_FORMAT"),
            FrameError::ForeignId => write!(f, "E_PHONE_FRAME_FOREIGN"),
            FrameError::Conflict => write!(f, "E_PHONE_FRAME_CONFLICT"),
            FrameError::TooLarge => write!(f, "E_PHONE_FRAME_TOO_LARGE"),
            FrameError::Incomplete { have, total } => write!(f, "E_PHONE_FRAME_INCOMPLETE: {have}/{total}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// What a frame's header says, without its payload: enough for a progress
/// display ("2 of 3").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameHeader {
    pub id: String,
    /// 1-based.
    pub index: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Progress {
    pub have: usize,
    /// 0 until the first frame is read.
    pub total: usize,
}

/// Split `cipher` into frames no longer than `max_chars`, under a fresh
/// random id.
pub fn frames(cipher: &[u8], max_chars: usize) -> Result<Vec<String>, FrameError> {
    let mut id = [0u8; 4];
    rand::rng().fill_bytes(&mut id);
    frames_with_id(cipher, max_chars, id)
}

pub(crate) fn frames_with_id(cipher: &[u8], max_chars: usize, id: [u8; 4]) -> Result<Vec<String>, FrameError> {
    // A longer frame than the phone accepts would never assemble.
    let max_chars = max_chars.min(MAX_FRAME_CHARS);
    if cipher.is_empty() || max_chars < HEADER_MAX + 4 {
        return Err(FrameError::Format);
    }
    // Whole base64 quads, so every chunk decodes on its own.
    let chunk_bytes = (max_chars - HEADER_MAX) / 4 * 3;
    let total = cipher.len().div_ceil(chunk_bytes);
    if total > MAX_FRAMES {
        return Err(FrameError::TooLarge);
    }
    let id: String = id.iter().map(|b| format!("{b:02x}")).collect();
    Ok(cipher
        .chunks(chunk_bytes)
        .enumerate()
        .map(|(i, chunk)| format!("{FRAME_MAGIC}:{id}:{}/{total}:{}", i + 1, URL_SAFE_NO_PAD.encode(chunk)))
        .collect())
}

fn small_number(s: &str) -> Option<usize> {
    (!s.is_empty() && s.len() <= 2 && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// Parse one frame's header and payload.
pub fn parse_frame(text: &str) -> Result<(FrameHeader, Vec<u8>), FrameError> {
    if text.len() > MAX_FRAME_CHARS {
        return Err(FrameError::Format);
    }
    let mut parts = text.splitn(4, ':');
    let (Some(magic), Some(id), Some(position), Some(chunk)) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err(FrameError::Format);
    };
    if magic != FRAME_MAGIC || id.len() != 8 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(FrameError::Format);
    }
    let (index, total) = position.split_once('/').ok_or(FrameError::Format)?;
    let (index, total) = (small_number(index).ok_or(FrameError::Format)?, small_number(total).ok_or(FrameError::Format)?);
    if index == 0 || index > total || total > MAX_FRAMES || chunk.is_empty() {
        return Err(FrameError::Format);
    }
    let bytes = URL_SAFE_NO_PAD.decode(chunk).map_err(|_| FrameError::Format)?;
    Ok((FrameHeader { id: id.to_string(), index, total }, bytes))
}

/// Collects the frames of one code. A rejected frame leaves it unchanged.
#[derive(Debug, Default)]
pub struct Assembler {
    id: Option<String>,
    parts: Vec<Option<Vec<u8>>>,
}

impl Assembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one scanned frame. A frame already held with the same contents is
    /// a no-op (the camera reads each frame many times).
    pub fn push(&mut self, text: &str) -> Result<Progress, FrameError> {
        let (header, bytes) = parse_frame(text)?;
        match &self.id {
            Some(id) if *id != header.id => return Err(FrameError::ForeignId),
            Some(_) if header.total != self.parts.len() => return Err(FrameError::Format),
            Some(_) => {}
            None => {
                self.parts = vec![None; header.total];
                self.id = Some(header.id);
            }
        }
        let slot = &mut self.parts[header.index - 1];
        match slot {
            Some(held) if *held != bytes => return Err(FrameError::Conflict),
            Some(_) => {}
            None => *slot = Some(bytes),
        }
        Ok(self.progress())
    }

    pub fn progress(&self) -> Progress {
        Progress { have: self.parts.iter().filter(|p| p.is_some()).count(), total: self.parts.len() }
    }

    pub fn is_complete(&self) -> bool {
        !self.parts.is_empty() && self.parts.iter().all(Option::is_some)
    }

    /// Forget everything (a new code is on screen).
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The ciphertext, once every frame is in.
    pub fn finish(&self) -> Result<Vec<u8>, FrameError> {
        if !self.is_complete() {
            let Progress { have, total } = self.progress();
            return Err(FrameError::Incomplete { have, total });
        }
        Ok(self.parts.iter().flatten().flat_map(|p| p.iter().copied()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 31 % 251) as u8).collect()
    }

    #[test]
    fn a_small_payload_is_one_frame_with_the_documented_header() {
        let out = frames_with_id(b"hello", MAX_FRAME_CHARS, [0xde, 0xad, 0xbe, 0xef]).unwrap();
        assert_eq!(out, vec!["MVQR1:deadbeef:1/1:aGVsbG8".to_string()]);
    }

    #[test]
    fn every_frame_stays_within_the_bound_and_shares_one_id() {
        let data = bytes(5000);
        let out = frames(&data, MAX_FRAME_CHARS).unwrap();
        assert!(out.len() > 1);
        let id = &out[0][6..14];
        for (i, f) in out.iter().enumerate() {
            assert!(f.len() <= MAX_FRAME_CHARS, "frame {i} is {} chars", f.len());
            let (h, _) = parse_frame(f).unwrap();
            assert_eq!(h, FrameHeader { id: id.to_string(), index: i + 1, total: out.len() });
        }
    }

    #[test]
    fn two_codes_get_different_ids() {
        let a = frames(b"x", MAX_FRAME_CHARS).unwrap();
        let b = frames(b"x", MAX_FRAME_CHARS).unwrap();
        assert_ne!(a[0][6..14], b[0][6..14]);
    }

    #[test]
    fn out_of_order_and_repeated_frames_assemble() {
        let data = bytes(3000);
        let out = frames(&data, 300).unwrap();
        assert!(out.len() >= 4);
        let mut asm = Assembler::new();
        assert_eq!(asm.progress(), Progress { have: 0, total: 0 });
        for f in out.iter().rev() {
            asm.push(f).unwrap();
            // the camera sees each frame again; nothing changes
            let again = asm.push(f).unwrap();
            assert_eq!(again, asm.progress());
        }
        assert_eq!(asm.progress(), Progress { have: out.len(), total: out.len() });
        assert!(asm.is_complete());
        assert_eq!(asm.finish().unwrap(), data);
    }

    #[test]
    fn progress_counts_distinct_frames() {
        let out = frames(&bytes(2000), 300).unwrap();
        let mut asm = Assembler::new();
        assert_eq!(asm.push(&out[2]).unwrap(), Progress { have: 1, total: out.len() });
        assert_eq!(asm.push(&out[2]).unwrap(), Progress { have: 1, total: out.len() });
        assert_eq!(asm.push(&out[0]).unwrap(), Progress { have: 2, total: out.len() });
        assert!(!asm.is_complete());
        assert_eq!(asm.finish().unwrap_err(), FrameError::Incomplete { have: 2, total: out.len() });
    }

    #[test]
    fn a_frame_of_another_code_is_foreign_and_changes_nothing() {
        let a = frames(&bytes(2000), 300).unwrap();
        let b = frames(&bytes(2000), 300).unwrap();
        let mut asm = Assembler::new();
        asm.push(&a[0]).unwrap();
        assert_eq!(asm.push(&b[1]).unwrap_err(), FrameError::ForeignId);
        assert_eq!(asm.progress().have, 1);
        asm.reset();
        assert_eq!(asm.push(&b[1]).unwrap().have, 1);
    }

    #[test]
    fn a_conflicting_duplicate_or_changed_total_is_refused() {
        let out = frames_with_id(&bytes(2000), 300, [1, 2, 3, 4]).unwrap();
        let mut asm = Assembler::new();
        asm.push(&out[0]).unwrap();
        let (h, _) = parse_frame(&out[0]).unwrap();
        let conflicting = format!("MVQR1:01020304:1/{}:AAAA", h.total);
        assert_eq!(asm.push(&conflicting).unwrap_err(), FrameError::Conflict);
        let other_total = format!("MVQR1:01020304:2/{}:AAAA", h.total + 1);
        assert_eq!(asm.push(&other_total).unwrap_err(), FrameError::Format);
        assert_eq!(asm.progress().have, 1);
    }

    #[test]
    fn malformed_frames_are_format_errors() {
        for bad in [
            "",
            "hello",
            "https://example.com",
            "MVQR2:01020304:1/1:AAAA",
            "MVQR1:0102030:1/1:AAAA",
            "MVQR1:0102030g:1/1:AAAA",
            "MVQR1:01020304:0/1:AAAA",
            "MVQR1:01020304:2/1:AAAA",
            "MVQR1:01020304:1/0:AAAA",
            "MVQR1:01020304:1/100:AAAA",
            "MVQR1:01020304:x/1:AAAA",
            "MVQR1:01020304:1/1:",
            "MVQR1:01020304:1/1:AA=A",
            "MVQR1:01020304:1/1:A",
        ] {
            assert_eq!(parse_frame(bad).unwrap_err(), FrameError::Format, "{bad:?}");
            assert_eq!(Assembler::new().push(bad).unwrap_err(), FrameError::Format, "{bad:?}");
        }
        let too_long = format!("MVQR1:01020304:1/1:{}", "A".repeat(MAX_FRAME_CHARS));
        assert_eq!(parse_frame(&too_long).unwrap_err(), FrameError::Format);
    }

    #[test]
    fn a_payload_needing_more_than_ninety_nine_frames_is_too_large() {
        assert_eq!(frames(&bytes(100_000), 300).unwrap_err(), FrameError::TooLarge);
    }

    #[test]
    fn empty_payload_is_refused() {
        assert_eq!(frames(&[], MAX_FRAME_CHARS).unwrap_err(), FrameError::Format);
    }

    #[test]
    fn the_longest_frame_fits_a_version_25_qr_at_ecc_m() {
        use qrcode::{EcLevel, QrCode, Version};
        // Worst case: two-digit index and total, a full chunk, lowercase so the
        // whole text is byte mode.
        let header = "MVQR1:ffffffff:99/99:";
        let worst = format!("{header}{}", "a_-z".repeat(MAX_FRAME_CHARS).chars().take(MAX_FRAME_CHARS - header.len()).collect::<String>());
        assert_eq!(worst.len(), MAX_FRAME_CHARS);
        let code = QrCode::with_error_correction_level(worst.as_bytes(), EcLevel::M).unwrap();
        match code.version() {
            Version::Normal(v) => assert!(v <= 25, "version {v}"),
            other => panic!("unexpected {other:?}"),
        }
        // and every real frame of a big payload
        for f in frames(&bytes(20_000), MAX_FRAME_CHARS).unwrap() {
            let code = QrCode::with_error_correction_level(f.as_bytes(), EcLevel::M).unwrap();
            assert!(matches!(code.version(), Version::Normal(v) if v <= 25));
        }
    }
}
