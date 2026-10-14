// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/inject/dynamic-theme/modify-css.ts, src/inject/dynamic-theme/css-rules.ts,
// src/inject/dynamic-theme/inline-style.ts, src/inject/dynamic-theme/index.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::color::{parse_color, rgb_to_hsl, Rgba};
use super::text::{get_matches, parse_gradient, ParsedGradient};
use super::DarkCx;
use fancy_regex::Regex;
use std::sync::LazyLock;

pub trait RuleStyle {
    fn get_property_value(&self, property: &str) -> String;
    fn get_property_priority(&self, property: &str) -> bool;
    fn selector_text(&self) -> String {
        String::new()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DeclValue {
    Text(String),
    Vars(Vec<(String, String)>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModifiedDecl {
    pub property: String,
    pub value: DeclValue,
    pub important: bool,
    pub source_value: String,
}

const BG_PROPS_TO_COPY: &[&str] = &["background-clip", "background-position", "background-repeat", "background-size"];
const UNPARSABLE: &[&str] = &["inherit", "transparent", "initial", "currentcolor", "none", "unset", "auto"];

const fn rgb(r: f64, g: f64, b: f64) -> Rgba {
    Rgba { r, g, b, a: 1.0 }
}

pub fn modifiable_declaration(property: &str, value: &str, rule: &dyn RuleStyle, cx: &mut DarkCx) -> Option<ModifiedDecl> {
    let mut property = property.to_string();
    let modifier: Option<DeclValue> = if property.starts_with("--") {
        variable_modifier(&property, value, rule, cx)
    } else if value.contains("var(") {
        var_dependant_modifier(&property, value, cx).map(DeclValue::Text)
    } else if property == "color-scheme" {
        Some(DeclValue::Text(if cx.theme.mode == 0 { "dark light" } else { "dark" }.into()))
    } else if property == "scrollbar-color" {
        scrollbar_color_modifier(value, cx).map(DeclValue::Text)
    } else if (property.contains("color") && property != "-webkit-print-color-adjust")
        || property == "fill"
        || property == "stroke"
        || property == "stop-color"
    {
        if property.starts_with("border") && property != "border-color" && value == "initial" {
            let side = property[..property.len() - 6].to_string();
            let side_val = rule.get_property_value(&side);
            if side_val.starts_with("0px") || side_val == "none" {
                property = side;
                Some(DeclValue::Text(side_val))
            } else {
                Some(DeclValue::Text(value.to_string()))
            }
        } else {
            color_modifier(&property, value, rule, cx).map(DeclValue::Text)
        }
    } else if property == "background-image" || property == "list-style-image" {
        bg_image_modifier(value, rule, cx).map(DeclValue::Text)
    } else if property.contains("shadow") {
        shadow_modifier(value, cx).map(|r| DeclValue::Text(r.result))
    } else if BG_PROPS_TO_COPY.contains(&property.as_str()) && value != "initial" {
        Some(DeclValue::Text(value.to_string()))
    } else {
        None
    };
    // `if (!modifier) return null;` (an empty string is falsy in JS).
    let modifier = modifier.filter(|m| !matches!(m, DeclValue::Text(s) if s.is_empty()))?;
    let important = rule.get_property_priority(&property);
    Some(ModifiedDecl { property, value: modifier, important, source_value: value.to_string() })
}

/// `--*` declarations (variables.ts). The store is moved out for the call: the
/// modifier needs `&mut DarkCx` (palette, bg-image modifier), and never reads `cx.vars`.
fn variable_modifier(property: &str, value: &str, rule: &dyn RuleStyle, cx: &mut DarkCx) -> Option<DeclValue> {
    let vars = std::mem::take(&mut cx.vars);
    let out = vars.modifier_for_variable(property, value, rule, cx);
    cx.vars = vars;
    Some(DeclValue::Vars(out))
}

/// `var()`-dependent declarations (variables.ts), same take-and-restore.
fn var_dependant_modifier(property: &str, value: &str, cx: &mut DarkCx) -> Option<String> {
    let vars = std::mem::take(&mut cx.vars);
    let out = vars.modifier_for_var_dependant(property, value, cx);
    cx.vars = vars;
    out
}

fn color_modifier(prop: &str, value: &str, rule: &dyn RuleStyle, cx: &mut DarkCx) -> Option<String> {
    if UNPARSABLE.contains(&value.to_lowercase().as_str()) && !(prop == "color" && value == "initial") {
        return Some(value.to_string());
    }
    let c = if prop == "color" && value == "initial" { rgb(0.0, 0.0, 0.0) } else { parse_color(value)? };
    if prop.contains("background") {
        let set = |p: &str| rule.get_property_value(p);
        let masked = (!set("-webkit-mask-image").is_empty() && set("-webkit-mask-image") != "none")
            || (!set("-webkit-mask").is_empty() && !set("-webkit-mask").starts_with("none"))
            || (!set("mask").is_empty() && set("mask") != "none")
            || (!set("mask-image").is_empty() && set("mask-image") != "none");
        return Some(if masked { cx.palette.fg(c, &cx.theme) } else { cx.palette.bg(c, &cx.theme) });
    }
    if prop.contains("border") || prop.contains("outline") {
        return Some(cx.palette.border(c, &cx.theme));
    }
    Some(cx.palette.fg(c, &cx.theme))
}

pub struct ShadowResult {
    pub result: String,
    pub matches: usize,
    pub unparsable: usize,
}

pub fn shadow_modifier(value: &str, cx: &mut DarkCx) -> Option<ShadowResult> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(^|\s)(?!calc)([a-z]+\(.+?\)|#[0-9a-f]+|[a-z]+)(.*?(inset|outset)?($|,))").unwrap());
    let found = get_matches(&RE, value, 2);
    let mut index = 0;
    let mut out = String::new();
    let mut unparsable = 0;
    for (i, m) in found.iter().enumerate() {
        let prefix_index = index;
        let match_index = value[index..].find(m.as_str()).map(|p| p + index)?;
        let match_end = match_index + m.len();
        index = match_end;
        match parse_color(m) {
            None => {
                unparsable += 1;
                out.push_str(&value[prefix_index..match_end]);
            }
            Some(c) => {
                out.push_str(&value[prefix_index..match_index]);
                out.push_str(&cx.palette.shadow(c, &cx.theme));
                if i == found.len() - 1 {
                    out.push_str(&value[match_end..]);
                }
            }
        }
    }
    Some(ShadowResult { result: out, matches: found.len(), unparsable })
}

fn scrollbar_color_modifier(value: &str, cx: &mut DarkCx) -> Option<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([a-z]+(\(.*\))?)\s+([a-z]+(\(.*\))?)\s*$").unwrap());
    let Some(c) = RE.captures(value).ok().flatten() else { return Some(value.to_string()) };
    let (thumb, track) = (parse_color(&c[1])?, parse_color(&c[3])?);
    Some(format!("{} {}", cx.palette.fg(thumb, &cx.theme), cx.palette.bg(track, &cx.theme)))
}

static CSS_URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"url\((('.*?')|(".*?")|([^\)]*?))\)"#).unwrap());

/// `getCSSURLValue`.
pub fn get_css_url_value(css_url: &str) -> String {
    static WRAP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^url\((.*)\)$").unwrap());
    let s: String = css_url.trim().chars().filter(|c| !matches!(c, '\n' | '\r' | '\\')).collect();
    let s = WRAP.replace(&s, "$1").trim().to_string();
    let s = s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).map(str::to_string).unwrap_or(s);
    s.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')).map(str::to_string).unwrap_or(s)
}

/// JS `String.prototype.substring`: clamps, and swaps when start > end.
fn js_substring(s: &str, a: usize, b: usize) -> &str {
    let (a, b) = (a.min(s.len()), b.min(s.len()));
    if a <= b { s.get(a..b).unwrap_or("") } else { s.get(b..a).unwrap_or("") }
}

fn gradient_value(g: &ParsedGradient, cx: &mut DarkCx) -> String {
    static PARTS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"([^\(\),]+(\([^\(\)]*(\([^\(\)]*\)*[^\(\)]*)?\))?([^\(\), ]|( (?!calc)))*),?").unwrap()
    });
    static STOP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(from|color-stop|to)\(([^\(\)]*?,\s*)?(.*?)\)$").unwrap());
    let parts: Vec<String> = get_matches(&PARTS, &g.matched, 1)
        .into_iter()
        .map(|part| {
            let part = part.trim();
            if let Some(c) = parse_color(part) {
                return cx.palette.gradient(c, &cx.theme);
            }
            if let Some(space) = part.rfind(' ') {
                if let Some(c) = parse_color(&part[..space]) {
                    return format!("{} {}", cx.palette.gradient(c, &cx.theme), &part[space + 1..]);
                }
            }
            if let Some(m) = STOP.captures(part).ok().flatten() {
                if let Some(c) = parse_color(&m[3]) {
                    let mid = m.get(2).map(|x| format!("{}, ", x.as_str())).unwrap_or_default();
                    return format!("{}({}{})", &m[1], mid, cx.palette.gradient(c, &cx.theme));
                }
            }
            part.to_string()
        })
        .collect();
    format!("{}({}){}", g.type_gradient, parts.join(", "), if g.has_comma { ", " } else { "" })
}

/// `getBgImageModifier`, evaluated at once (MailVault has no ignore-selectors).
pub fn bg_image_modifier(value: &str, rule: &dyn RuleStyle, cx: &mut DarkCx) -> Option<String> {
    let gradients = parse_gradient(value);
    let urls = get_matches(&CSS_URL_RE, value, 0);
    if urls.is_empty() && gradients.is_empty() {
        return Some(value.to_string());
    }
    enum Kind {
        Url,
        Gradient(ParsedGradient),
    }
    struct M {
        kind: Kind,
        index: usize,
        len: usize,
        offset: usize,
        has_comma: bool,
        matched: String,
    }
    let mut ms: Vec<M> = gradients
        .iter()
        .map(|g| M { kind: Kind::Gradient(g.clone()), index: g.index, len: g.matched.len(), offset: g.offset, has_comma: g.has_comma, matched: g.matched.clone() })
        .collect();
    let mut at = 0;
    for u in &urls {
        let idx = value[at..].find(u.as_str()).map(|p| p + at)?;
        at = idx + u.len();
        ms.push(M { kind: Kind::Url, index: idx, len: u.len(), offset: 0, has_comma: false, matched: u.clone() });
    }
    ms.sort_by_key(|m| m.index);
    let had_url = !urls.is_empty();
    let mut parts: Vec<String> = Vec::new();
    let mut match_index = 0;
    let mut prev_has_comma = false;
    let last = ms.len() - 1;
    for (i, m) in ms.iter().enumerate() {
        let (match_start, prefix_start) = (m.index, match_index);
        let match_end = match_start + m.len + m.offset;
        match_index = match_end;
        if prefix_start != match_start {
            let mut between = js_substring(value, prefix_start, match_start).to_string();
            if prev_has_comma && between.starts_with(',') {
                between.remove(0);
            }
            parts.push(between);
        }
        prev_has_comma = m.has_comma;
        parts.push(match &m.kind {
            Kind::Url => url_value(&m.matched, rule, cx),
            Kind::Gradient(g) => gradient_value(g, cx),
        });
        if i == last {
            parts.push(js_substring(value, match_end, value.len()).to_string());
        }
    }
    let combined: String = parts.concat();
    // DR strips `, initial` only on the synchronous path (no url() involved).
    if !had_url && combined.ends_with(", initial") {
        return Some(combined[..combined.len() - 9].to_string());
    }
    Some(combined)
}

/// The url() branch. Remote and relative URLs: DR's cross-origin fetch fails
/// (MailVault never calls setFetchMethod), so the URL is kept. `data:` URLs
/// are analysed (`image::bg_image_value`); None keeps the URL as written.
fn url_value(css_url: &str, _rule: &dyn RuleStyle, cx: &mut DarkCx) -> String {
    let url = get_css_url_value(css_url);
    if url.is_empty() {
        return "url('')".into();
    }
    if url.starts_with("data:") {
        if let Some(v) = super::image::bg_image_value(&url, cx) {
            return v;
        }
    }
    format!("url(\"{url}\")")
}

pub const OVERRIDES: &[(&str, &str, &str)] = &[
    ("background-color", "--darkreader-inline-bgcolor", "data-darkreader-inline-bgcolor"),
    ("background-image", "--darkreader-inline-bgimage", "data-darkreader-inline-bgimage"),
    ("border-color", "--darkreader-inline-border", "data-darkreader-inline-border"),
    ("border-bottom-color", "--darkreader-inline-border-bottom", "data-darkreader-inline-border-bottom"),
    ("border-left-color", "--darkreader-inline-border-left", "data-darkreader-inline-border-left"),
    ("border-right-color", "--darkreader-inline-border-right", "data-darkreader-inline-border-right"),
    ("border-top-color", "--darkreader-inline-border-top", "data-darkreader-inline-border-top"),
    ("box-shadow", "--darkreader-inline-boxshadow", "data-darkreader-inline-boxshadow"),
    ("color", "--darkreader-inline-color", "data-darkreader-inline-color"),
    ("fill", "--darkreader-inline-fill", "data-darkreader-inline-fill"),
    ("stroke", "--darkreader-inline-stroke", "data-darkreader-inline-stroke"),
    ("outline-color", "--darkreader-inline-outline", "data-darkreader-inline-outline"),
    ("stop-color", "--darkreader-inline-stopcolor", "data-darkreader-inline-stopcolor"),
];

pub const SHORTHAND_OVERRIDES: &[(&str, &str, &str)] = &[
    ("background", "--darkreader-inline-bg", "data-darkreader-inline-bg"),
    ("border", "--darkreader-inline-border-short", "data-darkreader-inline-border-short"),
    ("border-bottom", "--darkreader-inline-border-bottom-short", "data-darkreader-inline-border-bottom-short"),
    ("border-left", "--darkreader-inline-border-left-short", "data-darkreader-inline-border-left-short"),
    ("border-right", "--darkreader-inline-border-right-short", "data-darkreader-inline-border-right-short"),
    ("border-top", "--darkreader-inline-border-top-short", "data-darkreader-inline-border-top-short"),
];

pub fn inline_override_style() -> String {
    let mut blocks: Vec<String> = OVERRIDES
        .iter()
        .chain(SHORTHAND_OVERRIDES)
        .map(|(css, custom, attr)| format!("[{attr}] {{\n  {css}: var({custom}) !important;\n}}"))
        .collect();
    blocks.push("[data-darkreader-inline-invert] {\n    filter: invert(100%) hue-rotate(180deg);\n}".into());
    blocks.join("\n")
}

fn join_selectors(parts: &[&str]) -> String {
    parts.iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(", ")
}

pub fn selection_colors(cx: &mut DarkCx) -> (String, String) {
    if cx.theme.selection_color == "auto" {
        let t = super::Theme { grayscale: 0.0, ..cx.theme.clone() };
        return (cx.palette.bg(rgb(0.0, 96.0, 212.0), &t), cx.palette.fg(rgb(255.0, 255.0, 255.0), &t));
    }
    let l = parse_color(&cx.theme.selection_color).map(|c| rgb_to_hsl(c).l).unwrap_or(1.0);
    (cx.theme.selection_color.clone(), if l < 0.5 { "#FFF".into() } else { "#000".into() })
}

pub fn user_agent_style(cx: &mut DarkCx) -> String {
    let t = cx.theme.clone();
    let p = cx.profile;
    let white = rgb(255.0, 255.0, 255.0);
    let black = rgb(0.0, 0.0, 0.0);
    let mut lines: Vec<String> = Vec::new();
    if !p.is_iframe {
        lines.push("html {".into());
        lines.push(format!("    background-color: {} !important;", cx.palette.bg(white, &t)));
        lines.push("}".into());
    }
    if p.color_scheme_prop_supported && t.mode == 1 {
        lines.extend(["html {", "    color-scheme: dark !important;", "}", "iframe {", "    color-scheme: dark !important;", "}"].map(String::from));
    }
    let bg_selectors = join_selectors(&[
        if p.is_iframe { "" } else { "html, body" },
        if t.style_system_controls { "input, textarea, select, button, dialog" } else { "" },
    ]);
    if !bg_selectors.is_empty() {
        lines.push(format!("{bg_selectors} {{"));
        lines.push(format!("    background-color: {};", cx.palette.bg(white, &t)));
        lines.push("}".into());
    }
    lines.push(format!("{} {{", join_selectors(&["html, body", if t.style_system_controls { "input, textarea, select, button" } else { "" }])));
    lines.push(format!("    border-color: {};", cx.palette.border(rgb(76.0, 76.0, 76.0), &t)));
    lines.push(format!("    color: {};", cx.palette.fg(black, &t)));
    lines.push("}".into());
    lines.push("a {".into());
    lines.push(format!("    color: {};", cx.palette.fg(rgb(0.0, 64.0, 255.0), &t)));
    lines.push("}".into());
    lines.push("table {".into());
    lines.push(format!("    border-color: {};", cx.palette.border(rgb(128.0, 128.0, 128.0), &t)));
    lines.push("}".into());
    lines.push("mark {".into());
    lines.push(format!("    color: {};", cx.palette.fg(black, &t)));
    lines.push("}".into());
    lines.push("::placeholder {".into());
    lines.push(format!("    color: {};", cx.palette.fg(rgb(169.0, 169.0, 169.0), &t)));
    lines.push("}".into());
    lines.push("input:-webkit-autofill,".into());
    lines.push("textarea:-webkit-autofill,".into());
    lines.push("select:-webkit-autofill {".into());
    lines.push(format!("    background-color: {} !important;", cx.palette.bg(rgb(250.0, 255.0, 189.0), &t)));
    lines.push(format!("    color: {} !important;", cx.palette.fg(black, &t)));
    lines.push("}".into());
    // theme.scrollbarColor is '' for MailVault (DEFAULT_THEME), so DR emits no scrollbar rule.
    if !t.selection_color.is_empty() {
        let (bg, fg) = selection_colors(cx);
        let sel = ["::selection", "::-moz-selection"]
            .iter()
            .map(|s| format!("{s} {{\n    background-color: {bg} !important;\n    color: {fg} !important;\n}}"))
            .collect::<Vec<_>>()
            .join("\n");
        lines.push(sel);
    }
    if p.layer_rule_supported {
        lines.insert(0, "@layer {".into());
        lines.push("}".into());
    }
    lines.join("\n")
}

/// The variables sheet's text as index.ts writes it (the golden form).
pub fn variables_style(cx: &mut DarkCx) -> String {
    let t = cx.theme.clone();
    let neutral_bg = cx.palette.bg(rgb(255.0, 255.0, 255.0), &t);
    let neutral_text = cx.palette.fg(rgb(0.0, 0.0, 0.0), &t);
    let (sel_bg, sel_fg) = if t.selection_color.is_empty() { ("initial".into(), "initial".into()) } else { selection_colors(cx) };
    [
        ":root {".to_string(),
        format!("   --darkreader-neutral-background: {neutral_bg};"),
        format!("   --darkreader-neutral-text: {neutral_text};"),
        format!("   --darkreader-selection-background: {sel_bg};"),
        format!("   --darkreader-selection-text: {sel_fg};"),
        "}".to_string(),
    ]
    .join("\n")
}

/// DR's static sheets, in DR's head order, as one CSS text: user-agent,
/// inline, then variables (its `:root` gains every registered colour, as
/// `registerVariablesSheet` does through CSSOM). The fallback sheet is
/// omitted: DR empties it once every sheet has loaded. Call this last, after
/// every sheet and inline style has registered its colours.
pub fn static_sheets(cx: &mut DarkCx) -> String {
    let ua = user_agent_style(cx);
    let inline = inline_override_style();
    let vars = variables_style(cx);
    let registered: String = cx.palette.root_declarations().iter().map(|(k, v)| format!("\n    {k}: {v};")).collect();
    let vars = format!("{}{}\n}}", vars.trim_end_matches('}').trim_end(), registered);
    let mut sheets = vec![ua, inline, vars];
    // darkreader--root-vars: `<html>`'s own variables (computed by `apply`).
    if !cx.root_vars_css.is_empty() {
        sheets.push(cx.root_vars_css.clone());
    }
    sheets.join("\n")
}
