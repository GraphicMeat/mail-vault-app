//! Dark Reader 4.9.120, ported to Rust for the Blitz renderer (plan B).
//! `apply` (Task 13) reproduces in the Blitz DOM what DR writes into the
//! iframe's DOM; the colour engine lives in the submodules.
use blitz_dom::{ns, BaseDocument, LocalName, NodeId, QualName};
use serde::Deserialize;
use std::collections::HashMap;

pub mod color;
pub mod cssom;
pub mod image;
pub mod inline;
pub mod math_eval;
pub mod matrix;
pub mod modify_colors;
pub mod modify_css;
pub mod sheets;
pub mod text;
pub mod variables;

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
    /// The settled types of the document's CSS custom properties.
    pub vars: variables::VariablesStore,
    /// `darkreader--root-vars`: `<html>`'s own variables, once `apply` has typed them.
    pub root_vars_css: String,
    /// Analysed `data:` background images (see `image`).
    pub images: image::ImageCache,
}

impl DarkCx {
    pub fn new(theme: Theme, profile: Profile) -> Self {
        DarkCx { theme, profile, palette: modify_colors::Palette::default(), vars: variables::VariablesStore::default(), root_vars_css: String::new(), images: image::ImageCache::default() }
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

/// What Dark Reader leaves in the iframe's DOM once it has settled,
/// reproduced in the Blitz DOM. `RenderDoc::open` calls this after parse and
/// before the first resolve. Order follows DR's createDynamicStyleOverrides:
/// custom properties are typed first (`match_variables`), then sheets (sync
/// rules), then inline styles. The static sheets come
/// last, because they carry every colour the rest registered.
///
/// Cascade: Blitz orders author sheets by NodeId, so no `<style>` is added
/// next to the others. The static sheets are prepended to the text of the
/// first `<style>` (DR inserts its own before the document's first) and each
/// sheet's sync rules are appended to that sheet's own text.
///
/// `layout` runs a layout pass; it is called only for a document with an
/// SVG fill, whose box DR measures (`inline::needs_layout`). The caller owns
/// it so that the pass runs inside the net provider's layout window.
pub fn apply(doc: &mut BaseDocument, dark: &DarkTheme, layout: &mut dyn FnMut(&mut BaseDocument)) {
    let mut cx = DarkCx::new(dark.theme(), dark.profile());
    if crate::styles::style_nodes(doc).is_empty() {
        ensure_style_node(doc);
    }
    let styles = crate::styles::style_nodes(doc);
    match_variables(doc, &styles, &mut cx);
    let vars = std::mem::take(&mut cx.vars);
    cx.root_vars_css = vars.root_vars_style(&mut cx);
    cx.vars = vars;
    let mut suffix: HashMap<NodeId, String> = HashMap::new();
    for s in &styles {
        // DR does not manage a <style media="print"> (shouldManageStyle).
        if !sheets::is_managed_media(s.media.as_deref()) {
            continue;
        }
        let css = crate::styles::with_rules(doc, s.id, |rules, g| sheets::sync_css(rules, g, &mut cx)).unwrap_or_default();
        if !css.is_empty() {
            suffix.insert(s.id, format!("\n{css}"));
        }
    }
    if inline::needs_layout(doc) {
        layout(doc);
    }
    inline::apply_all(doc, &mut cx);
    let prefix = modify_css::static_sheets(&mut cx);
    crate::styles::rewrite(doc, |i, id| crate::styles::Rewrite {
        prefix: if i == 0 { format!("{prefix}\n") } else { String::new() },
        suffix: suffix.remove(&id).unwrap_or_default(),
    });
}

/// DR's two `matchVariablesAndDependents` passes, in the order its
/// `createDynamicStyleOverrides` makes them: the sheets (with `<html>`'s own
/// variables), then the inline styles. Each pass sees the types the last left.
fn match_variables(doc: &BaseDocument, styles: &[crate::styles::StyleNode], cx: &mut DarkCx) {
    let is_safari = cx.profile.is_safari;
    for s in styles {
        // A <style> DR does not manage never reaches its variable store.
        if sheets::is_managed_media(s.media.as_deref()) {
            crate::styles::with_rules(doc, s.id, |rules, g| variables::collect_rules(&mut cx.vars, rules, g, is_safari));
        }
    }
    variables::collect_root(&mut cx.vars, doc, is_safari);
    cx.vars.match_variables();
    variables::collect_inline(&mut cx.vars, doc, cx.theme.mode, is_safari);
    cx.vars.match_variables();
}

/// The sync rules per managed `<style>`, as `apply` would append them, for the
/// Dark Reader vector tests. Not part of the worker's surface.
#[doc(hidden)]
pub fn debug_sync_css(html: &str, dark: &DarkTheme) -> Vec<String> {
    let doc = blitz_html::HtmlDocument::from_html(html, blitz_dom::DocumentConfig { base_url: Some("http://invalid.invalid/".to_string()), ..Default::default() });
    let mut cx = DarkCx::new(dark.theme(), dark.profile());
    let styles = crate::styles::style_nodes(&doc);
    match_variables(&doc, &styles, &mut cx);
    let mut out = Vec::new();
    for s in &styles {
        if sheets::is_managed_media(s.media.as_deref()) {
            out.push(crate::styles::with_rules(&doc, s.id, |rules, g| sheets::sync_css(rules, g, &mut cx)).unwrap_or_default());
        }
    }
    out
}

/// A document with no `<style>` still needs DR's static sheets. With no other
/// author sheet to order against, a new node at the top of `<head>` is safe.
fn ensure_style_node(doc: &mut BaseDocument) {
    let parent = doc.find_head_node().map(|n| n.id).unwrap_or_else(|| doc.root_element().id);
    let mut m = doc.mutate();
    let style = m.create_element(QualName::new(None, ns!(html), LocalName::from("style")), vec![]);
    m.prepend_nodes(parent, &[style]);
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
