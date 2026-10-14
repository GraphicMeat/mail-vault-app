// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/inject/dynamic-theme/inline-style.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::cssom::{iterate_declarations, StyleBlock};
use super::modify_css::{modifiable_declaration, DeclValue, RuleStyle, OVERRIDES, SHORTHAND_OVERRIDES};
use super::DarkCx;
use blitz_dom::{ns, BaseDocument, LocalName, NodeId, QualName};
use style::properties::PropertyDeclarationBlock;

const INLINE_STYLE_ATTRS: &[&str] = &["style", "fill", "stop-color", "stroke", "bgcolor", "color", "background"];
/// DR's SMALL_SVG_THRESHOLD.
const SMALL_SVG: f64 = 32.0;
/// Bound on the recursion that unions the boxes of a group's children.
const MAX_BOX_DEPTH: u32 = 64;

/// What `overrideInlineStyle` does to one element, collected so that the
/// caller can read every element before any of them is written.
#[derive(Default, Debug)]
pub struct InlineEdits {
    /// `--darkreader-inline-*` custom properties, set on the element's style.
    pub props: Vec<(String, String)>,
    /// `data-darkreader-inline-*` attributes (value "").
    pub attrs: Vec<String>,
    /// MailVault adaptation: SVG paint attributes rewritten to the fallback colour.
    pub svg_paint: Vec<(String, String)>,
}

impl InlineEdits {
    fn is_empty(&self) -> bool {
        self.props.is_empty() && self.attrs.is_empty() && self.svg_paint.is_empty()
    }
}

fn custom_for(target: &str) -> Option<(&'static str, &'static str)> {
    OVERRIDES.iter().chain(SHORTHAND_OVERRIDES).find(|(css, _, _)| *css == target).map(|(_, custom, attr)| (*custom, *attr))
}

/// `var(--x, #abc)` -> `#abc` (the literal DR registers behind every colour).
fn var_fallback(v: &str) -> &str {
    match (v.strip_prefix("var(").and_then(|s| s.strip_suffix(')')), v.find(", ")) {
        (Some(_), Some(i)) => &v[i + 2..v.len() - 1],
        _ => v,
    }
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `setCustomProp(targetCSSProp, modifierCSSProp, cssVal)`. Returns the value
/// DR stored (the static value), if any.
fn set_custom_prop(
    target: &str,
    modifier_prop: &str,
    value: &str,
    style: &StyleBlock,
    cx: &mut DarkCx,
    svg_attr: Option<&str>,
    out: &mut InlineEdits,
) -> Option<String> {
    let m = modifiable_declaration(modifier_prop, value, style, cx)?;
    match m.value {
        DeclValue::Text(v) => {
            let (custom, attr) = custom_for(target)?;
            if let Some(a) = svg_attr {
                out.svg_paint.push((a.to_string(), var_fallback(&v).to_string()));
            }
            out.props.push((custom.to_string(), v.clone()));
            out.attrs.push(attr.to_string());
            Some(v)
        }
        DeclValue::Vars(list) => {
            out.props.extend(list);
            None
        }
    }
}

fn is_svg_el(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id).and_then(|n| n.element_data()).is_some_and(|e| e.name.ns == ns!(svg))
}

fn tag_of(doc: &BaseDocument, id: NodeId) -> &str {
    doc.get_node(id).and_then(|n| n.element_data()).map_or("", |e| e.name.local.as_ref())
}

fn attr_of<'a>(doc: &'a BaseDocument, id: NodeId, name: &str) -> Option<&'a str> {
    doc.get_node(id)?.element_data()?.attr(LocalName::from(name))
}

/// The nearest `<svg>` above `id` (`SVGElement.ownerSVGElement`), or `id` itself
/// when it is the outermost `<svg>`.
fn owner_svg(doc: &BaseDocument, id: NodeId) -> Option<NodeId> {
    let mut cur = doc.get_node(id)?.parent;
    while let Some(p) = cur {
        if is_svg_el(doc, p) && tag_of(doc, p) == "svg" {
            return Some(p);
        }
        cur = doc.get_node(p)?.parent;
    }
    (is_svg_el(doc, id) && tag_of(doc, id) == "svg").then_some(id)
}

/// `getSVGElementRoot`: the element itself when it is an `<svg>`, else the nearest `<svg>` above.
fn svg_root(doc: &BaseDocument, id: NodeId) -> Option<NodeId> {
    if is_svg_el(doc, id) && tag_of(doc, id) == "svg" {
        return Some(id);
    }
    owner_svg(doc, id)
}

/// `shouldAnalyzeSVGAsImage`: the owner svg, or its parent element, has a class containing "logo".
fn svg_has_logo_class(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(svg) = owner_svg(doc, id) else { return false };
    let logo = |n: NodeId| attr_of(doc, n, "class").is_some_and(|c| c.contains("logo"));
    logo(svg) || doc.get_node(svg).and_then(|n| n.parent).is_some_and(logo)
}

/// A box in the SVG's user units: x0, y0, x1, y1.
type Box4 = [f64; 4];

fn union(a: Option<Box4>, b: Option<Box4>) -> Option<Box4> {
    match (a, b) {
        (Some(a), Some(b)) => Some([a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]),
        (a, b) => a.or(b),
    }
}

fn number(b: &[u8], i: &mut usize) -> Option<f64> {
    let start = *i;
    let mut j = *i;
    if matches!(b.get(j), Some(b'+' | b'-')) {
        j += 1;
    }
    let digits = |j: &mut usize| {
        let s = *j;
        while b.get(*j).is_some_and(u8::is_ascii_digit) {
            *j += 1;
        }
        *j > s
    };
    let int = digits(&mut j);
    let mut frac = false;
    if b.get(j) == Some(&b'.') {
        j += 1;
        frac = digits(&mut j);
    }
    if !int && !frac {
        return None;
    }
    if matches!(b.get(j), Some(b'e' | b'E')) {
        let mut k = j + 1;
        if matches!(b.get(k), Some(b'+' | b'-')) {
            k += 1;
        }
        if digits(&mut k) {
            j = k;
        }
    }
    *i = j;
    std::str::from_utf8(&b[start..j]).ok()?.parse().ok()
}

fn skip_sep(b: &[u8], i: &mut usize) {
    while b.get(*i).is_some_and(|c| c.is_ascii_whitespace() || *c == b',') {
        *i += 1;
    }
}

/// The box around every point a path visits (control points included: a
/// superset of the true bounding box, which is enough for DR's 32 px test).
fn path_box(d: &str) -> Option<Box4> {
    let b = d.as_bytes();
    let (mut i, mut cmd) = (0, 0u8);
    let (mut x, mut y, mut sx, mut sy) = (0.0, 0.0, 0.0, 0.0);
    let mut out: Option<Box4> = None;
    let mut add = |px: f64, py: f64| out = union(out, Some([px, py, px, py]));
    loop {
        skip_sep(b, &mut i);
        let Some(&ch) = b.get(i) else { break };
        if ch.is_ascii_alphabetic() {
            cmd = ch;
            i += 1;
            if cmd == b'z' || cmd == b'Z' {
                (x, y) = (sx, sy);
            }
            continue;
        }
        let lower = cmd.to_ascii_lowercase();
        let n = match lower {
            b'm' | b'l' | b't' => 2,
            b'h' | b'v' => 1,
            b'c' => 6,
            b's' | b'q' => 4,
            b'a' => 7,
            _ => break,
        };
        let mut a = [0.0; 7];
        for slot in a.iter_mut().take(n) {
            skip_sep(b, &mut i);
            match number(b, &mut i) {
                Some(v) => *slot = v,
                None => return out,
            }
        }
        let rel = cmd.is_ascii_lowercase();
        let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
        match lower {
            b'm' | b'l' | b't' => {
                (x, y) = (ox + a[0], oy + a[1]);
                add(x, y);
                if lower == b'm' {
                    (sx, sy) = (x, y);
                    cmd = if rel { b'l' } else { b'L' };
                }
            }
            b'h' => {
                x = ox + a[0];
                add(x, y);
            }
            b'v' => {
                y = oy + a[0];
                add(x, y);
            }
            b'c' => {
                add(ox + a[0], oy + a[1]);
                add(ox + a[2], oy + a[3]);
                (x, y) = (ox + a[4], oy + a[5]);
                add(x, y);
            }
            b's' | b'q' => {
                add(ox + a[0], oy + a[1]);
                (x, y) = (ox + a[2], oy + a[3]);
                add(x, y);
            }
            _ => {
                (x, y) = (ox + a[5], oy + a[6]);
                add(x, y);
            }
        }
    }
    out
}

/// A length in user units; a percentage is taken of `pct`. Other units are read as numbers.
fn length(doc: &BaseDocument, id: NodeId, name: &str, pct: f64) -> f64 {
    let Some(v) = attr_of(doc, id, name) else { return 0.0 };
    let b = v.trim().as_bytes();
    let mut i = 0;
    let n = number(b, &mut i).unwrap_or(0.0);
    if b.get(i) == Some(&b'%') {
        n / 100.0 * pct
    } else {
        n
    }
}

/// Blitz lays out only the `<svg>` as a replaced box; the shapes inside have
/// no box. DR asks the browser for `getBoundingClientRect` of the element, so
/// this estimates the same box (user units, no transforms) from the geometry
/// attributes.
fn svg_box(doc: &BaseDocument, id: NodeId, vp: (f64, f64), depth: u32) -> Option<Box4> {
    let node = doc.get_node(id)?;
    let len = |n: &str, p: f64| length(doc, id, n, p);
    // html5ever restores the camel case of foreignObject and clipPath.
    match tag_of(doc, id).to_ascii_lowercase().as_str() {
        "rect" | "image" | "use" | "foreignobject" => {
            let (x, y) = (len("x", vp.0), len("y", vp.1));
            Some([x, y, x + len("width", vp.0), y + len("height", vp.1)])
        }
        "circle" => {
            let (cx, cy, r) = (len("cx", vp.0), len("cy", vp.1), len("r", vp.0));
            Some([cx - r, cy - r, cx + r, cy + r])
        }
        "ellipse" => {
            let (cx, cy, rx, ry) = (len("cx", vp.0), len("cy", vp.1), len("rx", vp.0), len("ry", vp.1));
            Some([cx - rx, cy - ry, cx + rx, cy + ry])
        }
        "line" => {
            let (x1, y1, x2, y2) = (len("x1", vp.0), len("y1", vp.1), len("x2", vp.0), len("y2", vp.1));
            Some([x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)])
        }
        "polyline" | "polygon" => {
            let b = attr_of(doc, id, "points")?.as_bytes();
            let (mut i, mut out) = (0, None);
            loop {
                skip_sep(b, &mut i);
                let Some(x) = number(b, &mut i) else { break };
                skip_sep(b, &mut i);
                let Some(y) = number(b, &mut i) else { break };
                out = union(out, Some([x, y, x, y]));
            }
            out
        }
        "path" => path_box(attr_of(doc, id, "d")?),
        "g" | "a" | "switch" | "symbol" | "svg" | "marker" | "pattern" | "mask" | "clippath" if depth < MAX_BOX_DEPTH => node
            .children
            .iter()
            .filter(|c| is_svg_el(doc, **c))
            .fold(None, |acc, c| union(acc, svg_box(doc, *c, vp, depth + 1))),
        _ => None,
    }
}

/// L475-493: a filled SVG shape counts as a background when its box is over
/// 32 px, unless the whole `<svg>` is small (area <= 32 x 32).
fn svg_fill_is_background(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(root) = svg_root(doc, id) else { return false };
    let Some(rect) = doc.get_client_bounding_rect(root) else { return false };
    if rect.width * rect.height <= SMALL_SVG * SMALL_SVG {
        return false;
    }
    if id == root {
        return rect.width > SMALL_SVG || rect.height > SMALL_SVG;
    }
    // user units -> CSS px: the viewBox scaled to the root's box (meet).
    let vb: Vec<f64> = attr_of(doc, root, "viewBox")
        .map(|v| {
            let b = v.as_bytes();
            let mut i = 0;
            let mut out = Vec::new();
            while out.len() < 4 {
                skip_sep(b, &mut i);
                match number(b, &mut i) {
                    Some(n) => out.push(n),
                    None => break,
                }
            }
            out
        })
        .unwrap_or_default();
    let (scale, vp) = match vb.as_slice() {
        [_, _, w, h] if *w > 0.0 && *h > 0.0 => ((rect.width / w).min(rect.height / h), (*w, *h)),
        _ => (1.0, (rect.width, rect.height)),
    };
    svg_box(doc, id, vp, 0).is_some_and(|b| (b[2] - b[0]) * scale > SMALL_SVG || (b[3] - b[1]) * scale > SMALL_SVG)
}

/// `overrideInlineStyle`, read-only: what DR would write on `id`.
pub fn override_inline(doc: &BaseDocument, id: NodeId, cx: &mut DarkCx) -> InlineEdits {
    let mut out = InlineEdits::default();
    let Some(node) = doc.get_node(id) else { return out };
    let Some(el) = node.element_data() else { return out };
    let guard = doc.guard().read();
    let empty = PropertyDeclarationBlock::new();
    let block = el.style_attribute.as_ref().map_or(&empty, |b| b.read_with(&guard));
    let style = StyleBlock::new(block, String::new());
    let tag = el.name.local.as_ref();
    let is_svg = el.name.ns == ns!(svg);
    let attr = |n: &str| el.attr(LocalName::from(n)).map(str::to_string);
    let is_root_or_body = !is_svg && (tag == "html" || tag == "body");

    // L392-429: an SVG under a "logo" class goes to DR's async raster analysis,
    // which is not ported (known diff); DR returns without recolouring it.
    if is_svg && cx.theme.mode == 1 && svg_has_logo_class(doc, id) {
        return out;
    }
    if let Some(mut v) = attr("bgcolor") {
        if is_hex(&v, 3) || is_hex(&v, 6) {
            v = format!("#{v}");
        }
        set_custom_prop("background-color", "background-color", &v, &style, cx, None, &mut out);
    }
    if is_root_or_body {
        if let Some(bg) = attr("background") {
            let value = format!("url(\"{bg}\")");
            let got = set_custom_prop("background-image", "background-image", &value, &style, cx, None, &mut out);
            if got.as_deref() == Some(value.as_str()) {
                // setAsyncValue, as on the style path below: html/body keep no image the
                // modifier hands back unchanged.
                if let Some((_, v)) = out.props.iter_mut().rev().find(|(k, _)| k == "--darkreader-inline-bgimage") {
                    *v = "none".into();
                }
            }
        }
    }
    if let Some(mut v) = attr("color") {
        let mask_icon = tag == "link" && attr("rel").is_some_and(|r| r == "mask-icon");
        if !mask_icon {
            let bare = v.strip_prefix('#').unwrap_or(&v);
            if is_hex(&v, 3) || is_hex(&v, 6) {
                v = format!("#{v}");
            } else if is_hex(bare, 4) {
                v = format!("#{bare}00");
            }
            set_custom_prop("color", "color", &v, &style, cx, None, &mut out);
        }
    }
    if is_svg {
        if let Some(v) = attr("fill").filter(|v| v != "none" && v != "currentColor") {
            let modifier = if tag == "text" {
                "color"
            } else if svg_fill_is_background(doc, id) {
                "background-color"
            } else {
                "color"
            };
            set_custom_prop("fill", modifier, &v, &style, cx, Some("fill"), &mut out);
        }
        if let Some(v) = attr("stop-color") {
            set_custom_prop("stop-color", "background-color", &v, &style, cx, Some("stop-color"), &mut out);
        }
    }
    if let Some(v) = attr("stroke") {
        let modifier = if is_svg && (tag == "line" || tag == "text") { "border-color" } else { "color" };
        set_custom_prop("stroke", modifier, &v, &style, cx, is_svg.then_some("stroke"), &mut out);
    }
    let mut pending: Vec<(String, String)> = Vec::new();
    iterate_declarations(&style, cx.profile.is_safari, |p, v| pending.push((p.to_string(), v.to_string())));
    for (property, value) in pending {
        if property == "background-image" && value.contains("url") {
            if is_root_or_body {
                let got = set_custom_prop(&property, &property, &value, &style, cx, None, &mut out);
                if got.as_deref() == Some(value.as_str()) {
                    // setAsyncValue: html/body keep no big bright background image.
                    if let Some((_, v)) = out.props.iter_mut().rev().find(|(k, _)| k == "--darkreader-inline-bgimage") {
                        *v = "none".into();
                    }
                }
            }
            continue;
        }
        let is_override = OVERRIDES.iter().any(|(css, _, _)| *css == property);
        let is_dr_custom = OVERRIDES.iter().chain(SHORTHAND_OVERRIDES).any(|(_, custom, _)| *custom == property);
        if is_override || (property.starts_with("--") && !is_dr_custom) {
            set_custom_prop(&property, &property, &value, &style, cx, None, &mut out);
        } else if SHORTHAND_OVERRIDES.iter().any(|(css, _, _)| *css == property) && value.contains("var(") {
            set_custom_prop(&property, &property, &value, &style, cx, None, &mut out);
        }
    }
    if is_svg && tag == "text" {
        let fill = style.get_property_value("fill");
        if !fill.is_empty() {
            set_custom_prop("fill", "color", &fill, &style, cx, Some("fill"), &mut out);
        }
    }
    // `addInlineStyleForMatching(element.style)` is `variables::collect_inline`, run
    // before this pass so that every variable has its settled type.
    out
}

/// True for the elements `override_inline` leaves before its end: DR never
/// queues their style for variable matching either.
pub(super) fn skips_inline_override(doc: &BaseDocument, id: NodeId, mode: u8) -> bool {
    is_svg_el(doc, id) && mode == 1 && svg_has_logo_class(doc, id)
}

/// Every element DR's `INLINE_STYLE_SELECTOR` matches, in tree order.
fn inline_targets(doc: &BaseDocument) -> Vec<NodeId> {
    let names: Vec<LocalName> = INLINE_STYLE_ATTRS.iter().map(|n| LocalName::from(*n)).collect();
    let mut out = Vec::new();
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else { continue };
        if node.element_data().is_some_and(|e| e.attrs.iter().any(|a| names.contains(&a.name.local))) {
            out.push(id);
        }
        stack.extend(node.children.iter().rev().copied());
    }
    out
}

/// True when an SVG element other than `<text>` has a `fill` DR will measure
/// (`getBoundingClientRect`), so the caller must run layout first.
pub fn needs_layout(doc: &BaseDocument) -> bool {
    let fill = LocalName::from("fill");
    doc.tree().iter().any(|(_, node)| {
        node.element_data().is_some_and(|e| {
            e.name.ns == ns!(svg)
                && e.name.local.as_ref() != "text"
                && e.attr(fill.clone()).is_some_and(|v| v != "none" && v != "currentColor")
        })
    })
}

/// DR's `createDynamicStyleOverrides` inline pass: every matching element
/// gets its `--darkreader-inline-*` properties and `data-darkreader-inline-*`
/// attributes. All elements are read before any is written.
pub fn apply_all(doc: &mut BaseDocument, cx: &mut DarkCx) {
    let targets = inline_targets(doc);
    let edits: Vec<(NodeId, InlineEdits)> =
        targets.into_iter().map(|id| (id, override_inline(doc, id, cx))).filter(|(_, e)| !e.is_empty()).collect();
    for (id, e) in &edits {
        for (p, v) in &e.props {
            doc.set_style_property(*id, p, v);
        }
    }
    let mut m = doc.mutate();
    for (id, e) in edits {
        for a in e.attrs {
            m.set_attribute(id, QualName::new(None, ns!(), LocalName::from(a.as_str())), "");
        }
        for (a, v) in e.svg_paint {
            m.set_attribute(id, QualName::new(None, ns!(), LocalName::from(a.as_str())), &v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn var_fallback_takes_the_literal_behind_the_variable() {
        assert_eq!(var_fallback("var(--darkreader-background-ffffff, #0a0a12)"), "#0a0a12");
        assert_eq!(var_fallback("var(--darkreader-text-1, rgb(1, 2, 3))"), "rgb(1, 2, 3)");
        assert_eq!(var_fallback("#0a0a12"), "#0a0a12");
    }

    #[test]
    fn hex_forms() {
        assert!(is_hex("fff", 3) && is_hex("E6375a", 6) && !is_hex("ffg", 3) && !is_hex("ffff", 3));
    }

    #[test]
    fn path_box_covers_absolute_and_relative_commands() {
        assert_eq!(path_box("M10 10 L30 10 L30 50 Z"), Some([10.0, 10.0, 30.0, 50.0]));
        assert_eq!(path_box("m10 10 l20 0 0 40 z"), Some([10.0, 10.0, 30.0, 50.0]));
        assert_eq!(path_box("M0,0h24v24H0z"), Some([0.0, 0.0, 24.0, 24.0]));
        assert_eq!(path_box("M0 0C0 -5 10 20 8 8"), Some([0.0, -5.0, 10.0, 20.0]));
        assert_eq!(path_box("not a path"), None);
    }

    #[test]
    fn numbers_read_signs_fractions_and_exponents() {
        let mut i = 0;
        let b = b"-.5e1 3.25";
        assert_eq!(number(b, &mut i), Some(-5.0));
        skip_sep(b, &mut i);
        assert_eq!(number(b, &mut i), Some(3.25));
    }
}
