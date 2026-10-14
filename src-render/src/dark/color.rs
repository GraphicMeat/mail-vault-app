// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/utils/color.ts, src/utils/math.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::math_eval::eval_math;
use super::text::get_parentheses_range;
use fancy_regex::Regex;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hsla {
    pub h: f64,
    pub s: f64,
    pub l: f64,
    pub a: f64,
}

/// JS `Math.round`: halves go up (towards +infinity).
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// JS `Number.prototype.toFixed`: the exact binary value rounded half-up (an
/// exact tie picks the larger n). Rust's `{:.N}` rounds ties to even, so it
/// cannot be used directly. Format 30 extra exact digits, then round by hand.
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity".into() } else { "Infinity".into() };
    }
    let neg = x < 0.0;
    let exact = format!("{:.*}", digits + 30, x.abs());
    let (int_part, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut ds: Vec<u8> = int_part.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    if frac.as_bytes().get(digits).map_or(false, |d| *d >= b'5') {
        let mut i = ds.len();
        loop {
            if i == 0 {
                ds.insert(0, 1);
                break;
            }
            i -= 1;
            if ds[i] == 9 {
                ds[i] = 0;
            } else {
                ds[i] += 1;
                break;
            }
        }
    }
    let int_len = ds.len() - digits;
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    s.extend(ds[..int_len].iter().map(|d| (b'0' + d) as char));
    if digits > 0 {
        s.push('.');
        s.extend(ds[int_len..].iter().map(|d| (b'0' + d) as char));
    }
    s
}

/// DR's `toFixed(n, digits)` in color.ts: JS toFixed, then strip trailing zeros.
pub fn dr_to_fixed(n: f64, digits: usize) -> String {
    let fixed = js_to_fixed(n, digits);
    if digits == 0 {
        return fixed;
    }
    if let Some(dot) = fixed.find('.') {
        let trimmed = fixed.trim_end_matches('0');
        if trimmed.len() != fixed.len() {
            let zeros_at = trimmed.len();
            if zeros_at == dot + 1 {
                return fixed[..dot].to_string();
            }
            return fixed[..zeros_at].to_string();
        }
    }
    fixed
}

/// JS `parseFloat`: the longest numeric prefix, else NaN.
pub fn js_parse_float(s: &str) -> f64 {
    static NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?").unwrap());
    let t = s.trim_start();
    match NUM.find(t).ok().flatten() {
        Some(m) => m.as_str().parse().unwrap_or(f64::NAN),
        None => f64::NAN,
    }
}

pub fn scale(x: f64, in_low: f64, in_high: f64, out_low: f64, out_high: f64) -> f64 {
    (x - in_low) * (out_high - out_low) / (in_high - in_low) + out_low
}

pub fn clamp(x: f64, min: f64, max: f64) -> f64 {
    max.min(min.max(x))
}

pub fn hsl_to_rgb(Hsla { h, s, l, a }: Hsla) -> Rgba {
    if s == 0.0 {
        let v = js_round(l * 255.0);
        return Rgba { r: v, g: v, b: v, a };
    }
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = if h < 60.0 {
        (c, x, 0.0)
    } else if h < 120.0 {
        (x, c, 0.0)
    } else if h < 180.0 {
        (0.0, c, x)
    } else if h < 240.0 {
        (0.0, x, c)
    } else if h < 300.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    Rgba { r: js_round((r + m) * 255.0), g: js_round((g + m) * 255.0), b: js_round((b + m) * 255.0), a }
}

pub fn rgb_to_hsl(Rgba { r, g, b, a }: Rgba) -> Hsla {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let c = max - min;
    let l = (max + min) / 2.0;
    if c == 0.0 {
        return Hsla { h: 0.0, s: 0.0, l, a };
    }
    let mut h = (if max == r {
        ((g - b) / c) % 6.0
    } else if max == g {
        (b - r) / c + 2.0
    } else {
        (r - g) / c + 4.0
    }) * 60.0;
    if h < 0.0 {
        h += 360.0;
    }
    let s = c / (1.0 - (2.0 * l - 1.0).abs());
    Hsla { h, s, l, a }
}

pub fn rgb_to_string(Rgba { r, g, b, a }: Rgba) -> String {
    if a < 1.0 {
        format!("rgba({}, {}, {}, {})", dr_to_fixed(r, 0), dr_to_fixed(g, 0), dr_to_fixed(b, 0), dr_to_fixed(a, 2))
    } else {
        format!("rgb({}, {}, {})", dr_to_fixed(r, 0), dr_to_fixed(g, 0), dr_to_fixed(b, 0))
    }
}

fn js_hex(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    // `x.toString(16)` for the whole numbers a colour channel holds; a negative
    // one prints as "-" and its magnitude, after the "0" the `< 16` test adds.
    let n = x as i64;
    if n < 0 {
        format!("0-{:x}", -n)
    } else {
        format!("{}{:x}", if x < 16.0 { "0" } else { "" }, n)
    }
}

pub fn rgb_to_hex_string(Rgba { r, g, b, a }: Rgba) -> String {
    let mut s = String::from("#");
    for x in [r, g, b] {
        s.push_str(&js_hex(x));
    }
    if a < 1.0 {
        s.push_str(&js_hex(js_round(a * 255.0)));
    }
    s
}

pub fn srgb_lightness(r: f64, g: f64, b: f64) -> f64 {
    (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
}

/// DR's system colour table (color.ts `systemColors`), verbatim.
const SYSTEM_COLORS: &[(&str, u32)] = &[
    ("activeborder", 0x3b99fc), ("activecaption", 0x000000), ("appworkspace", 0xaaaaaa), ("background", 0x6363ce),
    ("buttonface", 0xffffff), ("buttonhighlight", 0xe9e9e9), ("buttonshadow", 0x9fa09f), ("buttontext", 0x000000),
    ("captiontext", 0x000000), ("graytext", 0x7f7f7f), ("highlight", 0xb2d7ff), ("highlighttext", 0x000000),
    ("inactiveborder", 0xffffff), ("inactivecaption", 0xffffff), ("inactivecaptiontext", 0x000000), ("infobackground", 0xfbfcc5),
    ("infotext", 0x000000), ("menu", 0xf6f6f6), ("menutext", 0xffffff), ("scrollbar", 0xaaaaaa),
    ("threeddarkshadow", 0x000000), ("threedface", 0xc0c0c0), ("threedhighlight", 0xffffff), ("threedlightshadow", 0xffffff),
    ("threedshadow", 0x000000), ("window", 0xececec), ("windowframe", 0xaaaaaa), ("windowtext", 0x000000),
    ("-webkit-focus-ring-color", 0xe59700),
];

fn from_int(n: u32) -> Rgba {
    Rgba { r: ((n >> 16) & 255) as f64, g: ((n >> 8) & 255) as f64, b: (n & 255) as f64, a: 1.0 }
}

static RGB_MATCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^rgba?\([^\(\)]+\)$").unwrap());
static HSL_MATCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^hsla?\([^\(\)]+\)$").unwrap());
static HEX_MATCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^#[0-9a-f]+$").unwrap());

/// `parseColorWithCache` (without the cache).
pub fn parse_color(input: &str) -> Option<Rgba> {
    let mut c = input.trim().to_string();
    if c.contains("calc(") {
        c = lower_calc_expression(&c);
    }
    parse(&c)
}

pub fn parse_to_hsl(input: &str) -> Option<Hsla> {
    parse_color(input).map(rgb_to_hsl)
}

fn is_match(re: &Regex, s: &str) -> bool {
    re.is_match(s).unwrap_or(false)
}

/// `parse()`. Forms DR reads through a canvas or matchMedia return None:
/// relative `(from …)`, `rgb(#…)`, the colour functions (`color`, `color-mix`,
/// `hwb`, `lab`, `lch`, `oklab`, `oklch`) and `light-dark()`. They are harness-only (Global Constraints).
fn parse(color: &str) -> Option<Rgba> {
    let c = color.trim().to_lowercase();
    if c.contains("(from ") {
        return None;
    }
    if is_match(&RGB_MATCH, &c) {
        if c.starts_with("rgb(#") || c.starts_with("rgba(#") {
            return None;
        }
        return parse_rgb(&c);
    }
    if is_match(&HSL_MATCH, &c) {
        return parse_hsl(&c);
    }
    if is_match(&HEX_MATCH, &c) {
        return parse_hex(&c);
    }
    if c == "transparent" {
        return Some(Rgba { r: 0.0, g: 0.0, b: 0.0, a: 0.0 });
    }
    if let Ok((r, g, b)) = cssparser::color::parse_named_color(&c) {
        return Some(Rgba { r: r as f64, g: g as f64, b: b as f64, a: 1.0 });
    }
    if let Some((_, n)) = SYSTEM_COLORS.iter().find(|(k, _)| *k == c) {
        return Some(from_int(*n));
    }
    None
}

/// `getNumbersFromString`.
fn get_numbers_from_string(input: &str, range: &[f64], units: &[(&str, f64)]) -> Vec<f64> {
    let bytes = input.as_bytes();
    let search_start = input.find('(').map_or(0, |i| i + 1);
    let search_end = input.len().saturating_sub(1);
    let mut numbers: Vec<f64> = Vec::new();
    let mut num_start: Option<usize> = None;
    let mut unit_start: Option<usize> = None;
    let push = |match_end: usize, numbers: &mut Vec<f64>, num_start: &mut Option<usize>, unit_start: &mut Option<usize>| {
        let ns = num_start.unwrap();
        let num_end = unit_start.unwrap_or(match_end);
        let mut n = js_parse_float(&input[ns..num_end]);
        let r = range.get(numbers.len()).copied().unwrap_or(f64::NAN); // JS: undefined -> NaN
        if let Some(us) = *unit_start {
            let unit = &input[us..match_end];
            if let Some((_, u)) = units.iter().find(|(k, _)| *k == unit) {
                n *= r / u;
            }
        }
        if r > 1.0 {
            n = js_round(n);
        }
        numbers.push(n);
        *num_start = None;
        *unit_start = None;
    };
    for i in search_start..search_end {
        let c = bytes[i];
        let is_num = c.is_ascii_digit() || c == b'.' || c == b'+' || c == b'-' || c == b'e';
        let is_delim = c == b' ' || c == b',' || c == b'/';
        if is_num {
            if num_start.is_none() {
                num_start = Some(i);
            }
        } else if num_start.is_some() {
            if is_delim {
                push(i, &mut numbers, &mut num_start, &mut unit_start);
            } else if unit_start.is_none() {
                unit_start = Some(i);
            }
        }
    }
    if num_start.is_some() {
        push(search_end, &mut numbers, &mut num_start, &mut unit_start);
    }
    numbers
}

fn parse_rgb(c: &str) -> Option<Rgba> {
    let n = get_numbers_from_string(c, &[255.0, 255.0, 255.0, 1.0], &[("%", 100.0)]);
    if n.len() < 3 {
        return None;
    }
    Some(Rgba { r: n[0], g: n[1], b: n[2], a: n.get(3).copied().unwrap_or(1.0) })
}

fn parse_hsl(c: &str) -> Option<Rgba> {
    let units = [("%", 100.0), ("deg", 360.0), ("rad", 2.0 * std::f64::consts::PI), ("turn", 1.0)];
    let n = get_numbers_from_string(c, &[360.0, 1.0, 1.0, 1.0], &units);
    if n.len() < 3 {
        return None;
    }
    Some(hsl_to_rgb(Hsla { h: n[0], s: n[1], l: n[2], a: n.get(3).copied().unwrap_or(1.0) }))
}

fn parse_hex(c: &str) -> Option<Rgba> {
    let b = c.as_bytes();
    let digits = b.len() - 1;
    let short = digits == 3 || digits == 4;
    let long = digits == 6 || digits == 8;
    if !short && !long {
        return None;
    }
    let hex = |i: usize| -> f64 {
        let ch = b[i];
        (match ch {
            b'A'..=b'F' => ch - b'A' + 10,
            b'a'..=b'f' => ch - b'a' + 10,
            _ => ch.wrapping_sub(b'0'),
        }) as f64
    };
    Some(if short {
        Rgba { r: hex(1) * 17.0, g: hex(2) * 17.0, b: hex(3) * 17.0, a: if digits == 4 { hex(4) * 17.0 / 255.0 } else { 1.0 } }
    } else {
        Rgba {
            r: hex(1) * 16.0 + hex(2),
            g: hex(3) * 16.0 + hex(4),
            b: hex(5) * 16.0 + hex(6),
            a: if digits == 8 { (hex(7) * 16.0 + hex(8)) / 255.0 } else { 1.0 },
        }
    })
}

/// `lowerCalcExpression`.
pub fn lower_calc_expression(color: &str) -> String {
    let mut color = color.to_string();
    while let Some(search) = color.find("calc(") {
        let Some(range) = get_parentheses_range(&color, search) else { break };
        let slice = &color[range.start + 1..range.end - 1];
        let pct = slice.contains('%');
        let output = js_round(eval_math(&slice.replace('%', "")));
        let repl = format!("{}{}", fmt_js_number(output), if pct { "%" } else { "" });
        color = format!("{}{}{}", &color[..range.start - 4], repl, &color[range.end..]);
    }
    color
}

/// JS number to string, for the integers `Math.round` yields.
fn fmt_js_number(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x < 0.0 { "-Infinity".into() } else { "Infinity".into() }
    } else if x == x.trunc() && x.abs() < 1e21 {
        if x == 0.0 { "0".into() } else { format!("{x:.0}") }
    } else {
        format!("{x}")
    }
}
