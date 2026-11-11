//! One frame as an SVG QR code for the desktop modal. Always black modules on
//! white with a quiet zone, whatever the app theme: phone scanners fail on
//! inverted codes.

/// `text` as an SVG QR code at error correction M.
pub fn qr_svg(text: &str) -> Result<String, String> {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};
    // The error names the failure only, never the text.
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M).map_err(|e| format!("E_PHONE_QR: {e}"))?;
    Ok(code
        .render::<svg::Color>()
        .quiet_zone(true)
        .min_dimensions(320, 320)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_black_on_white_svg() {
        let svg = qr_svg("MVQR1:deadbeef:1/1:aGVsbG8").unwrap();
        assert!(svg.contains("<svg"), "{}", &svg[..svg.len().min(80)]);
        assert!(svg.contains("#000000"));
        assert!(svg.contains("#ffffff"));
    }

    #[test]
    fn the_longest_frame_renders() {
        let text = format!("MVQR1:ffffffff:99/99:{}", "a".repeat(super::super::frames::MAX_FRAME_CHARS - 21));
        assert!(qr_svg(&text).is_ok());
    }
}
