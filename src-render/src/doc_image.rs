//! The whole document as one PNG (`image` op): the export canvas and the
//! social app shot draw it. Painted at the doc's own scale until the image
//! would pass the canvas area WebKit accepts (imagePacker.js MAX_PAGE_AREA,
//! the same wall modern-screenshot shrinks at today), then just below it.

pub const MAX_IMAGE_AREA_PX: f64 = 16_700_000.0;

/// The scale to paint a `css_w` x `css_h` document at: `scale` while the image
/// stays under MAX_IMAGE_AREA_PX, otherwise the largest scale that does.
pub fn image_scale(css_w: f64, css_h: f64, scale: f64) -> f64 {
    if css_w <= 0.0 || css_h <= 0.0 || scale <= 0.0 {
        return scale.max(0.0);
    }
    if css_w * scale * css_h * scale <= MAX_IMAGE_AREA_PX {
        return scale;
    }
    // 0.999: device sizes are rounded up; start just under the wall, then
    // shrink until the rounded-up size really is under it.
    let mut s = (MAX_IMAGE_AREA_PX / (css_w * css_h)).sqrt() * 0.999;
    while (css_w * s).ceil() * (css_h * s).ceil() > MAX_IMAGE_AREA_PX {
        s *= 0.999;
    }
    s
}

/// Box-filter downscale of premultiplied RGBA by `factor` (0 < factor <= 1).
pub fn downscale_rgba(src: &[u8], w: u32, h: u32, factor: f64) -> (Vec<u8>, u32, u32) {
    if factor >= 1.0 {
        return (src.to_vec(), w, h);
    }
    let dw = ((w as f64 * factor).floor() as u32).max(1);
    let dh = ((h as f64 * factor).floor() as u32).max(1);
    let mut out = vec![0u8; (dw as usize) * (dh as usize) * 4];
    for y in 0..dh {
        let y0 = ((y as f64 / factor) as u32).min(h - 1);
        let y1 = (((y + 1) as f64 / factor) as u32).clamp(y0 + 1, h);
        for x in 0..dw {
            let x0 = ((x as f64 / factor) as u32).min(w - 1);
            let x1 = (((x + 1) as f64 / factor) as u32).clamp(x0 + 1, w);
            let mut acc = [0u32; 4];
            let n = (y1 - y0) * (x1 - x0);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = (sy as usize * w as usize + sx as usize) * 4;
                    for c in 0..4 {
                        acc[c] += src[i + c] as u32;
                    }
                }
            }
            let o = (y as usize * dw as usize + x as usize) * 4;
            for c in 0..4 {
                out[o + c] = (acc[c] / n) as u8;
            }
        }
    }
    (out, dw, dh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_doc_scale_under_the_wall() {
        assert_eq!(image_scale(820.0, 2000.0, 2.0), 2.0);
    }

    #[test]
    fn image_scale_caps_area() {
        for h in [20_000.0, 60_000.0, 200_000.0] {
            let s = image_scale(820.0, h, 2.0);
            assert!(s < 2.0, "h={h} s={s}");
            let w = (820.0 * s).ceil();
            let hh = (h * s).ceil();
            assert!(w * hh <= MAX_IMAGE_AREA_PX, "h={h} area={}", w * hh);
        }
    }

    #[test]
    fn degenerate_sizes_keep_the_scale() {
        assert_eq!(image_scale(0.0, 100.0, 2.0), 2.0);
        assert_eq!(image_scale(100.0, 0.0, 2.0), 2.0);
    }

    #[test]
    fn downscale_halves_and_averages() {
        // 2x2 of one colour, 2x2 of another, side by side: 4x2 -> 2x1.
        let mut src = Vec::new();
        for _ in 0..2 {
            src.extend_from_slice(&[255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
        }
        let (out, w, h) = downscale_rgba(&src, 4, 2, 0.5);
        assert_eq!((w, h), (2, 1));
        assert_eq!(&out[0..4], &[255, 0, 0, 255]);
        assert_eq!(&out[4..8], &[0, 0, 255, 255]);
    }

    #[test]
    fn factor_one_is_a_copy() {
        let src = vec![1, 2, 3, 4];
        assert_eq!(downscale_rgba(&src, 1, 1, 1.0), (src.clone(), 1, 1));
    }
}
