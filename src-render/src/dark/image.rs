// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/inject/dynamic-theme/image.ts, src/inject/dynamic-theme/modify-css.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
//! `data:` background images. Remote and relative URLs never reach this module
//! (DR's cross-origin fetch fails in MailVault, so their URLs are kept).
//!
//! The bytes are mail-controlled, so nothing is decoded on trust: the pixel
//! count is read from the header and refused above `net::MAX_IMAGE_PIXELS`
//! before any decoder runs, the decoder itself is limited again, and all the
//! images of one document together stay under `net::MAX_DOC_IMAGE_PIXELS`.
//!
//! Known difference: DR also analyses and filters SVG `data:` images (through a
//! canvas). Here an SVG is not rasterised, so its URL is kept as written
//! (Blitz still paints it, un-inverted). Rasterising it would need usvg and the
//! vendored safe href resolver (`parse_svg_image`), which are not exposed.
use super::color::{clamp, srgb_lightness};
use super::matrix::create_filter_matrix;
use super::{DarkCx, Theme};
use crate::net::{MAX_DOC_IMAGE_PIXELS, MAX_IMAGE_PIXELS};
use base64::Engine;
use image::{ImageFormat, Limits, RgbaImage};
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Clone, Debug, PartialEq)]
pub struct ImageDetails {
    pub width: u32,
    pub height: u32,
    pub is_dark: bool,
    pub is_light: bool,
    pub is_transparent: bool,
    pub is_large: bool,
}

/// What the analysis of one URL settled on; a URL repeated across rules costs nothing.
struct Entry {
    details: Option<ImageDetails>,
    value: Option<String>,
}

#[derive(Default)]
pub struct ImageCache {
    entries: HashMap<String, Entry>,
    /// Pixels handed to a decoder so far; bounded by `MAX_DOC_IMAGE_PIXELS`.
    pub decoded_pixels: u64,
    /// Bytes of filtered-image `url()` values written into the document's CSS so far;
    /// bounded by `MAX_DOC_OUTPUT_BYTES`.
    pub emitted_bytes: usize,
}

impl ImageCache {
    /// The analysis of `url`, if it was decoded.
    pub fn details(&self, url: &str) -> Option<&ImageDetails> {
        self.entries.get(url)?.details.as_ref()
    }
}

const MAX_ANALYSIS_PIXELS: f64 = 32.0 * 32.0;
const LARGE_IMAGE_PIXELS: u64 = 512 * 512;
/// A re-encoded image larger than this is not worth carrying in the stylesheet.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
/// All the filtered images of one document together. Each one is base64 in a sheet that
/// Stylo parses again and Blitz decodes again; past this the image keeps its URL.
const MAX_DOC_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
/// An RGBA decode of `MAX_IMAGE_PIXELS` is 64 MB; the decoder may not allocate more than that and a little.
const MAX_DECODE_ALLOC: u64 = 4 * MAX_IMAGE_PIXELS + (1 << 20);

/// `analyzeImage`: the image is sampled at no more than 32 x 32 pixels, nearest neighbour.
pub fn analyze(img: &RgbaImage) -> ImageDetails {
    let (sw, sh) = img.dimensions();
    if sw == 0 || sh == 0 {
        return ImageDetails { width: sw, height: sh, is_dark: false, is_light: false, is_transparent: false, is_large: false };
    }
    let k = (MAX_ANALYSIS_PIXELS / (sw as f64 * sh as f64)).sqrt().min(1.0);
    let (w, h) = (((sw as f64) * k).ceil() as u32, ((sh as f64) * k).ceil() as u32);
    let (mut transparent, mut dark, mut light) = (0u32, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            let sx = (((x as f64 + 0.5) * sw as f64 / w as f64).floor() as u32).min(sw - 1);
            let sy = (((y as f64 + 0.5) * sh as f64 / h as f64).floor() as u32).min(sh - 1);
            let p = img.get_pixel(sx, sy);
            if (p[3] as f64) / 255.0 < 0.05 {
                transparent += 1;
            } else {
                let l = srgb_lightness(p[0] as f64, p[1] as f64, p[2] as f64);
                if l < 0.4 {
                    dark += 1;
                }
                if l > 0.7 {
                    light += 1;
                }
            }
        }
    }
    let total = (w * h) as f64;
    let opaque = total - transparent as f64;
    ImageDetails {
        width: sw,
        height: sh,
        is_dark: dark as f64 / opaque >= 0.7,
        is_light: light as f64 / opaque >= 0.7,
        is_transparent: transparent as f64 / total >= 0.1,
        is_large: (sw as u64) * (sh as u64) > LARGE_IMAGE_PIXELS,
    }
}

const SRGB_STEPS: usize = 1 << 14;

static TO_LINEAR: LazyLock<[f64; 256]> = LazyLock::new(|| {
    std::array::from_fn(|i| {
        let c = i as f64 / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    })
});

/// linear 0..1 (in `SRGB_STEPS` steps) to an sRGB byte, so a 16 Mpx image costs a lookup per channel.
static TO_SRGB: LazyLock<Vec<u8>> = LazyLock::new(|| {
    (0..=SRGB_STEPS)
        .map(|i| {
            let c = i as f64 / SRGB_STEPS as f64;
            let s = if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
            (s * 255.0).round() as u8
        })
        .collect()
});

/// The pixels DR's `<feColorMatrix>` produces: the matrix `getSVGFilterMatrixValue`
/// serialises (three decimals), applied in the filter's default linearRGB space to
/// un-premultiplied colour. Alpha is kept (row 3 of the matrix is the identity).
pub fn filtered_png(img: &RgbaImage, theme: &Theme) -> Vec<u8> {
    let m = create_filter_matrix(theme);
    let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
    let row: [[f64; 5]; 3] = std::array::from_fn(|i| std::array::from_fn(|k| r3(m[i][k])));
    let (to_linear, to_srgb) = (&*TO_LINEAR, &*TO_SRGB);
    let mut out = img.clone();
    for p in out.pixels_mut() {
        if p[3] == 0 {
            continue;
        }
        let v = [to_linear[p[0] as usize], to_linear[p[1] as usize], to_linear[p[2] as usize], p[3] as f64 / 255.0, 1.0];
        for c in 0..3 {
            let lin = clamp((0..5).map(|k| row[c][k] * v[k]).sum::<f64>(), 0.0, 1.0);
            p[c] = to_srgb[(lin * SRGB_STEPS as f64).round() as usize];
        }
    }
    let mut png = Vec::new();
    let enc = image::codecs::png::PngEncoder::new_with_quality(&mut png, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::Adaptive);
    out.write_with_encoder(enc).expect("png");
    png
}

/// Decode a `data:` URL holding a PNG, JPEG, GIF or WebP, whatever mime type it declares.
pub fn decode_data_url(url: &str) -> Option<RgbaImage> {
    decode_within(url, &mut 0)
}

/// `decode_data_url`, charging the decoded pixels to `used` (a document's budget).
fn decode_within(url: &str, used: &mut u64) -> Option<RgbaImage> {
    let bytes = data_url::DataUrl::process(url).ok()?.decode_to_vec().ok()?.0;
    let format = image::guess_format(&bytes).ok().filter(|f| matches!(f, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP))?;
    // The header says how big it is; nothing is allocated for a larger one.
    let size = imagesize::blob_size(&bytes).ok()?;
    let px = (size.width as u64).saturating_mul(size.height as u64);
    if px == 0 || px > MAX_IMAGE_PIXELS || used.checked_add(px).is_none_or(|t| t > MAX_DOC_IMAGE_PIXELS) {
        return None;
    }
    *used += px;
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_PIXELS as u32);
    limits.max_image_height = Some(MAX_IMAGE_PIXELS as u32);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let img = reader.decode().ok()?.into_rgba8();
    // A decoder that disagreed with the header is not trusted either.
    ((img.width() as u64) * (img.height() as u64) <= MAX_IMAGE_PIXELS).then_some(img)
}

/// `getBgImageValue` for a `data:` URL; None keeps the URL as it is.
pub fn bg_image_value(url: &str, cx: &mut DarkCx) -> Option<String> {
    // getBgImageValue changes an image only in mode 1 (MailVault's mode 0 branch is not used).
    if cx.theme.mode != 1 {
        return None;
    }
    if let Some(e) = cx.images.entries.get(url) {
        return e.value.clone();
    }
    let img = decode_within(url, &mut cx.images.decoded_pixels);
    let details = img.as_ref().map(analyze);
    let value = img.zip(details.clone()).and_then(|(img, d)| value_for(&img, &d, &cx.theme));
    let value = value.filter(|v| {
        // "none" costs nothing; a filtered image is charged to the document.
        let fits = v.len() <= MAX_DOC_OUTPUT_BYTES - cx.images.emitted_bytes.min(MAX_DOC_OUTPUT_BYTES);
        if fits && v != "none" {
            cx.images.emitted_bytes += v.len();
        }
        fits || v == "none"
    });
    cx.images.entries.insert(url.to_string(), Entry { details, value: value.clone() });
    value
}

fn value_for(img: &RgbaImage, d: &ImageDetails, t: &Theme) -> Option<String> {
    let as_url = |png: Vec<u8>| {
        (png.len() <= MAX_OUTPUT_BYTES).then(|| format!("url(\"data:image/png;base64,{}\")", base64::engine::general_purpose::STANDARD.encode(png)))
    };
    if d.is_large && d.is_light && !d.is_transparent {
        Some("none".into())
    } else if d.is_dark && d.is_transparent && d.width > 2 {
        if d.is_large {
            // DR clears the data URL of a large image (image.ts: `dataURL: analysis.isLarge ? ""`),
            // so the filter wraps an <image> with an empty href and nothing is drawn.
            return Some("none".into());
        }
        as_url(filtered_png(img, &Theme { sepia: clamp(t.sepia + 10.0, 0.0, 100.0), ..t.clone() }))
    } else if d.is_light && !d.is_transparent {
        as_url(filtered_png(img, t))
    } else {
        None
    }
}
