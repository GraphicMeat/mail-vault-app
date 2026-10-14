//! Dark Reader 4.9.120, ported to Rust for the Blitz renderer (plan B).
//! `apply` (Task 13) reproduces in the Blitz DOM what DR writes into the
//! iframe's DOM; the colour engine lives in the submodules.
use serde::Deserialize;

pub mod color;
pub mod math_eval;
pub mod matrix;
pub mod modify_colors;
pub mod modify_css;
pub mod text;

/// DR's `Theme`, limited to the fields the dynamic engine reads (definitions.d.ts).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub mode: u8,
    pub brightness: f64,
    pub contrast: f64,
    pub grayscale: f64,
    pub sepia: f64,
    pub dark_scheme_background_color: String,
    pub dark_scheme_text_color: String,
    pub light_scheme_background_color: String,
    pub light_scheme_text_color: String,
    pub selection_color: String,
    pub scrollbar_color: String,
    pub style_system_controls: bool,
}

impl Theme {
    /// DR's DEFAULT_THEME (src/defaults.ts) under the WebKit profile, with the
    /// options MailVault passes (src/utils/darkReaderInject.js).
    pub fn mailvault(bg: &str, fg: &str, brightness: f64, contrast: f64, sepia: f64) -> Theme {
        Theme {
            mode: 1,
            brightness,
            contrast,
            grayscale: 0.0,
            sepia,
            dark_scheme_background_color: bg.to_string(),
            dark_scheme_text_color: fg.to_string(),
            light_scheme_background_color: "#dcdad7".into(),
            light_scheme_text_color: "#181a1b".into(),
            selection_color: "auto".into(),
            scrollbar_color: String::new(),
            style_system_controls: false,
        }
    }
}

/// Per-document Dark Reader state: one theme, one profile, one colour registry.
pub struct DarkCx {
    pub theme: Theme,
    pub profile: Profile,
    pub palette: modify_colors::Palette,
}

impl DarkCx {
    pub fn new(theme: Theme, profile: Profile) -> Self {
        DarkCx { theme, profile, palette: modify_colors::Palette::default() }
    }
}

/// The environment DR's code branches on (utils/platform.ts, api/index.ts).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Profile {
    pub is_iframe: bool,
    pub layer_rule_supported: bool,
    pub color_scheme_prop_supported: bool,
    pub is_safari: bool,
    pub is_chromium: bool,
}

impl Profile {
    /// The macOS reader: WKWebView (no "Safari" in Tauri's UA), inside an iframe.
    pub const WEBKIT_IFRAME: Profile = Profile {
        is_iframe: true,
        layer_rule_supported: true,
        color_scheme_prop_supported: true,
        is_safari: false,
        is_chromium: false,
    };
}

fn hundred() -> f64 {
    100.0
}

/// The worker's `open.theme` when `mode` is "dark" (overview: {mode, bg, fg,
/// brightness, contrast, sepia}). `top_level` is for plan D's pop-out
/// window, where DR runs outside an iframe; the reader leaves it false.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DarkTheme {
    pub bg: String,
    pub fg: String,
    #[serde(default = "hundred")]
    pub brightness: f64,
    #[serde(default = "hundred")]
    pub contrast: f64,
    #[serde(default)]
    pub sepia: f64,
    #[serde(default)]
    pub top_level: bool,
}

impl DarkTheme {
    pub fn theme(&self) -> Theme {
        // An unparsable pole would make DR itself throw; use DR's defaults.
        let bg = if color::parse_color(&self.bg).is_some() { self.bg.as_str() } else { "#181a1b" };
        let fg = if color::parse_color(&self.fg).is_some() { self.fg.as_str() } else { "#e8e6e3" };
        Theme::mailvault(bg, fg, self.brightness, self.contrast, self.sepia)
    }

    pub fn profile(&self) -> Profile {
        Profile { is_iframe: !self.top_level, ..Profile::WEBKIT_IFRAME }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_theme_takes_the_overview_shape_and_defaults() {
        let d: DarkTheme = serde_json::from_str(r##"{"bg":"#0a0a12","fg":"#e8e8ef"}"##).unwrap();
        assert_eq!((d.brightness, d.contrast, d.sepia, d.top_level), (100.0, 100.0, 0.0, false));
        assert_eq!(d.theme(), Theme::mailvault("#0a0a12", "#e8e8ef", 100.0, 100.0, 0.0));
        assert!(d.profile().is_iframe);
        let top: DarkTheme = serde_json::from_str(r##"{"bg":"#000","fg":"#fff","topLevel":true,"sepia":10}"##).unwrap();
        assert!(!top.profile().is_iframe);
        assert_eq!(top.theme().sepia, 10.0);
    }

    #[test]
    fn unparsable_poles_fall_back_to_dr_defaults() {
        let d: DarkTheme = serde_json::from_str(r#"{"bg":"nonsense","fg":"also-not"}"#).unwrap();
        let t = d.theme();
        assert_eq!((t.dark_scheme_background_color.as_str(), t.dark_scheme_text_color.as_str()), ("#181a1b", "#e8e6e3"));
    }
}
