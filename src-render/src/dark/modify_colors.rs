// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/inject/dynamic-theme/modify-colors.ts, src/inject/dynamic-theme/palette.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::color::{hsl_to_rgb, parse_to_hsl, rgb_to_hex_string, rgb_to_hsl, rgb_to_string, scale, Hsla, Rgba};
use super::matrix::{apply_color_matrix, create_filter_matrix};
use super::Theme;
use std::collections::HashMap;

type HslFn = fn(Hsla, Option<Hsla>, Option<Hsla>) -> Hsla;

fn modify_color_with(rgb: Rgba, theme: &Theme, f: HslFn, pole: Option<&str>, another: Option<&str>) -> String {
    let hsl = rgb_to_hsl(rgb);
    let pole = pole.and_then(parse_to_hsl);
    let another = another.and_then(parse_to_hsl);
    let modified = f(hsl, pole, another);
    let Rgba { r, g, b, a } = hsl_to_rgb(modified);
    let matrix = create_filter_matrix(&Theme { mode: 0, ..theme.clone() });
    let [rf, gf, bf] = apply_color_matrix([r, g, b], &matrix);
    if a == 1.0 {
        rgb_to_hex_string(Rgba { r: rf, g: gf, b: bf, a: 1.0 })
    } else {
        rgb_to_string(Rgba { r: rf, g: gf, b: bf, a })
    }
}

const MAX_BG_LIGHTNESS: f64 = 0.4;
const MIN_FG_LIGHTNESS: f64 = 0.55;

fn modify_bg_hsl(Hsla { h, s, l, a }: Hsla, pole: Option<Hsla>, _: Option<Hsla>) -> Hsla {
    let pole = pole.expect("bg pole");
    let is_dark = l < 0.5;
    let is_blue = h > 200.0 && h < 280.0;
    let is_neutral = s < 0.12 || (l > 0.8 && is_blue);
    if is_dark {
        let lx = scale(l, 0.0, 0.5, 0.0, MAX_BG_LIGHTNESS);
        if is_neutral {
            return Hsla { h: pole.h, s: pole.s, l: lx, a };
        }
        return Hsla { h, s, l: lx, a };
    }
    let mut lx = scale(l, 0.5, 1.0, MAX_BG_LIGHTNESS, pole.l);
    if is_neutral {
        return Hsla { h: pole.h, s: pole.s, l: lx, a };
    }
    let mut hx = h;
    if h > 60.0 && h < 180.0 {
        hx = if h > 120.0 { scale(h, 120.0, 180.0, 135.0, 180.0) } else { scale(h, 60.0, 120.0, 60.0, 105.0) };
    }
    if hx > 40.0 && hx < 80.0 {
        lx *= 0.75;
    }
    Hsla { h: hx, s, l: lx, a }
}

fn modify_blue_fg_hue(h: f64) -> f64 {
    scale(h, 205.0, 245.0, 205.0, 220.0)
}

fn modify_fg_hsl(Hsla { h, s, l, a }: Hsla, pole: Option<Hsla>, _: Option<Hsla>) -> Hsla {
    let pole = pole.expect("fg pole");
    let is_light = l > 0.5;
    let is_neutral = l < 0.2 || s < 0.24;
    let is_blue = !is_neutral && h > 205.0 && h < 245.0;
    if is_light {
        let lx = scale(l, 0.5, 1.0, MIN_FG_LIGHTNESS, pole.l);
        if is_neutral {
            return Hsla { h: pole.h, s: pole.s, l: lx, a };
        }
        return Hsla { h: if is_blue { modify_blue_fg_hue(h) } else { h }, s, l: lx, a };
    }
    if is_neutral {
        return Hsla { h: pole.h, s: pole.s, l: scale(l, 0.0, 0.5, pole.l, MIN_FG_LIGHTNESS), a };
    }
    if is_blue {
        return Hsla { h: modify_blue_fg_hue(h), s, l: scale(l, 0.0, 0.5, pole.l, (MIN_FG_LIGHTNESS + 0.05).min(1.0)), a };
    }
    Hsla { h, s, l: scale(l, 0.0, 0.5, pole.l, MIN_FG_LIGHTNESS), a }
}

fn modify_border_hsl(Hsla { h, s, l, a }: Hsla, pole_fg: Option<Hsla>, pole_bg: Option<Hsla>) -> Hsla {
    let (pole_fg, pole_bg) = (pole_fg.expect("fg pole"), pole_bg.expect("bg pole"));
    let is_dark = l < 0.5;
    let is_neutral = l < 0.2 || s < 0.24;
    let (mut hx, mut sx) = (h, s);
    if is_neutral {
        if is_dark {
            hx = pole_fg.h;
            sx = pole_fg.s;
        } else {
            hx = pole_bg.h;
            sx = pole_bg.s;
        }
    }
    Hsla { h: hx, s: sx, l: scale(l, 0.0, 1.0, 0.5, 0.2), a }
}

/// Unregistered `modifyBackgroundColor(rgb, theme, false)` (mode 1; MailVault never uses mode 0).
pub fn modify_background_color(rgb: Rgba, t: &Theme) -> String {
    modify_color_with(rgb, t, modify_bg_hsl, Some(&t.dark_scheme_background_color), None)
}

pub fn modify_foreground_color(rgb: Rgba, t: &Theme) -> String {
    modify_color_with(rgb, t, modify_fg_hsl, Some(&t.dark_scheme_text_color), None)
}

pub fn modify_border_color(rgb: Rgba, t: &Theme) -> String {
    modify_color_with(rgb, t, modify_border_hsl, Some(&t.dark_scheme_text_color), Some(&t.dark_scheme_background_color))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ColorType {
    Background,
    Text,
    Border,
}

impl ColorType {
    fn name(self) -> &'static str {
        match self {
            ColorType::Background => "background",
            ColorType::Text => "text",
            ColorType::Border => "border",
        }
    }
}

/// palette.ts: one registry per document (DR's is per page, and a worker
/// holds many documents). Keyed by the input colour's hex, in insertion order.
#[derive(Default)]
pub struct Palette {
    order: Vec<String>,
    values: HashMap<(String, ColorType), (String, String)>, // (hex, type) -> (variable, value)
}

impl Palette {
    pub fn get(&self, ty: ColorType, rgb: Rgba) -> Option<String> {
        let hex = rgb_to_hex_string(rgb);
        self.values.get(&(hex, ty)).map(|(var, val)| format!("var({var}, {val})"))
    }

    pub fn register(&mut self, ty: ColorType, rgb: Rgba, value: String) -> String {
        let hex = rgb_to_hex_string(rgb);
        if !self.order.contains(&hex) {
            self.order.push(hex.clone());
        }
        let var = format!("--darkreader-{}-{}", ty.name(), hex.trim_start_matches('#'));
        let out = format!("var({var}, {value})");
        self.values.insert((hex, ty), (var, value));
        out
    }

    fn modify_and_register(&mut self, ty: ColorType, rgb: Rgba, t: &Theme, f: fn(Rgba, &Theme) -> String) -> String {
        if let Some(v) = self.get(ty, rgb) {
            return v;
        }
        let value = f(rgb, t);
        self.register(ty, rgb, value)
    }

    pub fn bg(&mut self, rgb: Rgba, t: &Theme) -> String {
        self.modify_and_register(ColorType::Background, rgb, t, modify_background_color)
    }

    pub fn fg(&mut self, rgb: Rgba, t: &Theme) -> String {
        self.modify_and_register(ColorType::Text, rgb, t, modify_foreground_color)
    }

    pub fn border(&mut self, rgb: Rgba, t: &Theme) -> String {
        self.modify_and_register(ColorType::Border, rgb, t, modify_border_color)
    }

    pub fn shadow(&mut self, rgb: Rgba, t: &Theme) -> String {
        self.bg(rgb, t)
    }

    pub fn gradient(&mut self, rgb: Rgba, t: &Theme) -> String {
        self.bg(rgb, t)
    }

    /// Every registered variable, for the variables sheet's `:root` (DR
    /// `registerVariablesSheet`): hex insertion order, then background, text, border.
    pub fn root_declarations(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for hex in &self.order {
            for ty in [ColorType::Background, ColorType::Text, ColorType::Border] {
                if let Some((var, val)) = self.values.get(&(hex.clone(), ty)) {
                    out.push((var.clone(), val.clone()));
                }
            }
        }
        out
    }
}
