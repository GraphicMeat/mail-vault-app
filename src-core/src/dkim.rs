//! What a message says about its DKIM signature, and what the signer's DNS key
//! record says about the key: the algorithm (`rsa-sha256`, `ed25519-sha256`),
//! and the key's type and size (RSA 1024/2048/4096, Ed25519, Ed448).
//!
//! A message carries only the `a=`, `d=` and `s=` tags of its signature (the
//! `b=` and `bh=` blobs are not stored). The key lives in DNS at
//! `<s>._domainkey.<d>`; `dns::dkim_key_for` asks, `parse_key_record` reads.

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use serde::Serialize;

/// `name=value` tags of a DKIM header or key record, in order: names trimmed
/// and lowercased, values stripped of every space (folded lines, a key record
/// split into chunks).
fn tags(raw: &str) -> impl Iterator<Item = (String, String)> + '_ {
    raw.split(';').filter_map(|tag| {
        let (name, value) = tag.split_once('=')?;
        Some((name.trim().to_ascii_lowercase(), value.chars().filter(|c| !c.is_whitespace()).collect()))
    })
}

fn token(value: &str, extra: &[char]) -> Option<String> {
    let v = value.to_ascii_lowercase();
    let ok = !v.is_empty() && v.len() <= 253 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || extra.contains(&c));
    ok.then_some(v)
}

/// The `a=`, `d=` and `s=` tags of a DKIM-Signature header value, as
/// `a=rsa-sha256; d=brand.test; s=k1` (lowercased, absent tags left out, values
/// outside the characters those tags may hold dropped). `None` when none remain.
pub fn signature_summary(raw: &str) -> Option<String> {
    let (mut a, mut d, mut sel) = (None, None, None);
    for (name, value) in tags(raw) {
        match name.as_str() {
            "a" if a.is_none() => a = token(&value, &[]),
            "d" if d.is_none() => d = token(&value, &['.']),
            "s" if sel.is_none() => sel = token(&value, &['.', '_']),
            _ => {}
        }
    }
    let parts: Vec<String> = [("a", a), ("d", d), ("s", sel)]
        .into_iter()
        .filter_map(|(n, v)| v.map(|v| format!("{n}={v}")))
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// A signer's published key, as the reader's popover shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyInfo {
    /// `rsa`, `ed25519`, `ed448`, or the record's own `k=` for anything else.
    #[serde(rename = "keyType")]
    pub key_type: String,
    /// Modulus bits for RSA, 256 for Ed25519, 448 for Ed448; `None` when the key could not be read.
    pub bits: Option<u32>,
    /// `p=` is empty: the signer withdrew the key.
    pub revoked: bool,
}

/// A DKIM key record (`v=DKIM1; k=rsa; p=MIGf...`). The key's own encoding
/// decides its type, not `k=`, since a record that says `k=rsa` over an Ed25519
/// key is seen in the wild. `None` when there is no `p=` tag at all.
pub fn parse_key_record(txt: &str) -> Option<KeyInfo> {
    let mut k = "rsa".to_string();
    let mut p = None;
    for (name, value) in tags(txt) {
        match name.as_str() {
            "k" if !value.is_empty() => k = value.to_ascii_lowercase(),
            "p" if p.is_none() => p = Some(value),
            _ => {}
        }
    }
    let p = p?;
    if p.is_empty() {
        return Some(KeyInfo { key_type: k, bits: None, revoked: true });
    }
    let (key_type, bits) = decode(&p)
        .and_then(|der| classify(&der, &k))
        .unwrap_or((k, None));
    Some(KeyInfo { key_type, bits, revoked: false })
}

/// Padding or none, and stray trailing bits: records in the wild do both.
fn decode(p: &str) -> Option<Vec<u8>> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    LENIENT.decode(p).ok()
}

const OID_RSA: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01];
const OID_ED25519: &[u8] = &[0x2B, 0x65, 0x70];
const OID_ED448: &[u8] = &[0x2B, 0x65, 0x71];

/// The key's type and size from its own bytes: a SubjectPublicKeyInfo (its
/// algorithm OID names the type), a bare PKCS#1 RSA key, or the raw 32 or 57
/// bytes RFC 8463 puts in an Ed25519 record.
fn classify(der: &[u8], k: &str) -> Option<(String, Option<u32>)> {
    if let Some((oid, key)) = spki(der) {
        return match oid {
            OID_RSA => Some(("rsa".into(), Some(rsa_bits(key)?))),
            OID_ED25519 => Some(("ed25519".into(), Some(256))),
            OID_ED448 => Some(("ed448".into(), Some(448))),
            _ => None,
        };
    }
    match (k, der.len()) {
        ("rsa", _) => Some(("rsa".into(), Some(rsa_bits(der)?))),
        ("ed25519", 32) => Some(("ed25519".into(), Some(256))),
        ("ed448", 57) => Some(("ed448".into(), Some(448))),
        _ => None,
    }
}

/// One DER element: its tag, its content and what follows it.
fn tlv(b: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *b.first()?;
    let first = *b.get(1)?;
    let (len, off) = if first < 0x80 {
        (first as usize, 2)
    } else {
        let n = (first & 0x7f) as usize;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *b.get(2 + i)? as usize;
        }
        (len, 2 + n)
    };
    let end = off.checked_add(len)?;
    Some((tag, b.get(off..end)?, &b[end..]))
}

/// `SEQUENCE { SEQUENCE { OID, .. }, BIT STRING }` as (the OID, the key bytes).
fn spki(der: &[u8]) -> Option<(&[u8], &[u8])> {
    let (t, seq, _) = tlv(der)?;
    let (t2, algorithm, rest) = tlv(seq).filter(|_| t == 0x30)?;
    let (t3, oid, _) = tlv(algorithm).filter(|_| t2 == 0x30)?;
    let (t4, bits, _) = tlv(rest).filter(|_| t3 == 0x06)?;
    (t4 == 0x03 && bits.first() == Some(&0)).then(|| (oid, &bits[1..]))
}

/// Bit length of the modulus in `SEQUENCE { INTEGER n, INTEGER e }`.
fn rsa_bits(key: &[u8]) -> Option<u32> {
    let (t, seq, _) = tlv(key)?;
    let (t2, n, _) = tlv(seq).filter(|_| t == 0x30)?;
    let n = &n[n.iter().position(|b| *b != 0)?..];
    (t2 == 0x02).then(|| (n.len() as u32 - 1) * 8 + (8 - n[0].leading_zeros()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSA1024: &str = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDmQZMtBeAJzM5fMTkOMYAiAWYRyYD3utz0hfEKambUaiaJQE1fy1kbrIl/D2UQUaILFaw3tZWjjScelXe9H5lslYrChwOqPz/zSvVSJWxRRVo7ESRg9ZDIzwi9Yh6gIx8KbHXTMdBGwLBamli4bXehi6IE4H7N0k/a4oB3w8KBDwIDAQAB";
    const RSA2048: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxSAfwxKJLMY11a0c9BYKzzNpeFk6mM9fLPxf68RJ+A+Kc/jL4MovMU7mNj/BQcFdMXOXgdsbSULub55BuzaZS3g6zMISbl1QAfHynX6eSbndn6uyZFzl5wdQziVzOFcAvgciZ+7LrejTmTWobON/XdfJ93bwJdQ3Ca/imyZ02tSF00EshTQb0RbCnvGi5I0783SCwCLBtRp+3rilhYKYoccQIHvBkRVw4HFqvagUgZG1hqZS2KoiEeFfOrETzwDWcUMbSXZrXaczUrbKusigyB7QW9d+grxrym0/DCR0MRNEyD3COJYehSXdyHbMwczq+eAphI4ylQsK7e/DapvCiwIDAQAB";
    const RSA4096: &str = "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAleTHvnZ3/gF+53OXW1UXMxgtHGmuoiConNSXJn0wxXA/uHgZs12I0kiU9YLNQawa5HNXLTg5s/EXnx0O9rQ/T15fWDKS7wxqHZuSm5aw6oS15QeLxMRz3hwreIDGkbt+y0sos9ReCuCB0Oigs1L8XtQsKbJHu6EYaTVIMtqlZ01MHrqoonhbE+eyBnh5/ueJvqMaaDPvb9NlsaWPtPJxBN8IHuqVz3L4CYaiebM2OMojrm5Vt3CONzO3CnUKemcg17HmlUi3OKoW/XFJpY3aOCP8ygxWdG9SoVyJmDQ2JhgfWmFHeRv9A+t/wEwWJpHYQJHPxZYejymRF9HyE2qgbo6bJDm0u3y9OHAQceWEkyDH71I10RJCROjdHpuJPxwHsthAOMorI3J+1S9P6lKojyBYhEyZMRtyWJVuSoq68VHJu5S9aS7+yFcniclrELRc9KSHStoYS8k0cNHfTP6tsSImEhhDzVLhbeXk/pe870h+xRbIqF7foiRmSrBaJiJy9qLaKo7tUWDVTBHCCc4ZeEnSLSuD6GlxthOzyZEfF/Eu/lBF4kRWYX3D7VIq+Bxz1ZD7tGHm59VTbSJ9jnCTWEEEawoDLNZD0U+y0aGwNNlg/9BVpVbEKxQMCR/6Yy5060zlmaas8b+kkqdrI8Sp2vLFW/n/Yn4mlQjHBFlIIbkCAwEAAQ==";
    const ED25519_RAW: &str = "PlGC2PwqCOHVG01VVWDTph9X2oWYe9ntNlQ07GnCFeg=";
    const ED25519_SPKI: &str = "MCowBQYDK2VwAyEAPlGC2PwqCOHVG01VVWDTph9X2oWYe9ntNlQ07GnCFeg=";
    const ED448_RAW: &str = "H/ooGKngMfRify9fIKYB7dUDoDwFqjRb11C0Jf6oLqvdWt/rXnNLqqUaAvflwt7FbVwPJbDmvJsA";
    const ED448_SPKI: &str = "MEMwBQYDK2VxAzoAH/ooGKngMfRify9fIKYB7dUDoDwFqjRb11C0Jf6oLqvdWt/rXnNLqqUaAvflwt7FbVwPJbDmvJsA";

    fn key(txt: &str) -> (String, Option<u32>, bool) {
        let k = parse_key_record(txt).expect("a record with p=");
        (k.key_type, k.bits, k.revoked)
    }

    #[test]
    fn the_summary_keeps_the_algorithm_domain_and_selector_only() {
        assert_eq!(
            signature_summary("v=1; a=rsa-sha256; c=relaxed/relaxed; d=Brand.test; s=k1; h=from:to; bh=abc=; b=zzz="),
            Some("a=rsa-sha256; d=brand.test; s=k1".into())
        );
        assert_eq!(
            signature_summary("v=1;\r\n\ta=ED25519-SHA256;\r\n\td=brand.test;\r\n\ts=sel-2"),
            Some("a=ed25519-sha256; d=brand.test; s=sel-2".into())
        );
        assert_eq!(signature_summary("v=1; d=brand.test"), Some("d=brand.test".into()));
    }

    #[test]
    fn a_tag_is_matched_by_its_whole_name_and_its_value_by_its_characters() {
        // `ba`, `bh` and `h` are not `a`.
        assert_eq!(signature_summary("v=1; ba=rsa-sha1; bh=abc=; h=from"), None);
        assert_eq!(signature_summary("v=1; a=<script>; d=brand.test"), Some("d=brand.test".into()));
        assert_eq!(signature_summary("v=1; d=../etc; s=k1"), Some("s=k1".into()));
        assert_eq!(signature_summary(""), None);
    }

    #[test]
    fn an_rsa_key_reports_its_modulus_size() {
        assert_eq!(key(&format!("v=DKIM1; k=rsa; p={RSA1024}")), ("rsa".into(), Some(1024), false));
        assert_eq!(key(&format!("v=DKIM1; k=rsa; p={RSA2048}")), ("rsa".into(), Some(2048), false));
        assert_eq!(key(&format!("v=DKIM1; p={RSA4096}")), ("rsa".into(), Some(4096), false), "k= defaults to rsa");
    }

    #[test]
    fn a_record_split_into_quoted_chunks_and_padded_oddly_still_reads() {
        let (a, b) = RSA2048.split_at(100);
        assert_eq!(key(&format!("v=DKIM1; k=rsa; p={a} {b}")), ("rsa".into(), Some(2048), false));
        assert_eq!(key(&format!("v=DKIM1; k=rsa; p={}", RSA2048.trim_end_matches('='))), ("rsa".into(), Some(2048), false));
        assert_eq!(key(&format!("v=DKIM1 ; K=RSA ; P={RSA2048} ;")), ("rsa".into(), Some(2048), false));
    }

    #[test]
    fn ed25519_is_256_bits_raw_or_wrapped() {
        assert_eq!(key(&format!("v=DKIM1; k=ed25519; p={ED25519_RAW}")), ("ed25519".into(), Some(256), false));
        assert_eq!(key(&format!("v=DKIM1; k=ed25519; p={ED25519_SPKI}")), ("ed25519".into(), Some(256), false));
    }

    #[test]
    fn ed448_is_448_bits_raw_or_wrapped() {
        assert_eq!(key(&format!("v=DKIM1; k=ed448; p={ED448_RAW}")), ("ed448".into(), Some(448), false));
        assert_eq!(key(&format!("v=DKIM1; k=ed448; p={ED448_SPKI}")), ("ed448".into(), Some(448), false));
    }

    #[test]
    fn the_key_encoding_beats_a_wrong_k_tag() {
        assert_eq!(key(&format!("v=DKIM1; k=rsa; p={ED25519_SPKI}")), ("ed25519".into(), Some(256), false));
    }

    #[test]
    fn an_empty_p_is_a_revoked_key_and_no_p_is_no_key() {
        assert_eq!(key("v=DKIM1; k=rsa; p="), ("rsa".into(), None, true));
        assert!(parse_key_record("v=spf1 -all").is_none());
    }

    #[test]
    fn a_key_that_will_not_decode_keeps_its_type_and_has_no_size() {
        assert_eq!(key("v=DKIM1; k=rsa; p=not*base64"), ("rsa".into(), None, false));
        assert_eq!(key("v=DKIM1; k=rsa; p=AAAA"), ("rsa".into(), None, false));
        assert_eq!(key("v=DKIM1; k=ecdsa; p=AAAA"), ("ecdsa".into(), None, false));
    }
}
