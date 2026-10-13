//! Quote and signature folds marked by the frontend pre-pass
//! (src/features/blitz/prepass/folds.js, from src/utils/foldDetection.js).
//! The iframe toggles them in script; here the worker does the same DOM
//! change, by style mutation, and relays out.
use crate::RenderDoc;
use blitz_dom::{ns, BaseDocument, LocalName, NodeId, QualName};
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FoldInfo {
    pub id: String,
    pub kind: String,
    pub open: bool,
}

fn attr<'a>(doc: &'a BaseDocument, id: NodeId, name: &str) -> Option<&'a str> {
    doc.get_node(id)?.element_data()?.attr(LocalName::from(name))
}

fn find(doc: &BaseDocument, selector: &str) -> Option<NodeId> {
    doc.query_selector(selector).ok().flatten()
}

fn css_ident(id: &str) -> Option<&str> {
    // Ids are ours (q0, s3); anything else never reaches a selector.
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())).then_some(id)
}

pub fn read_folds(doc: &BaseDocument) -> Vec<FoldInfo> {
    let Ok(ids) = doc.query_selector_all("[data-mv-fold]") else { return Vec::new() };
    ids.iter()
        .filter_map(|&n| {
            let id = attr(doc, n, "data-mv-fold")?.to_string();
            css_ident(&id)?;
            find(doc, &format!("[data-mv-fold-toggle=\"{id}\"]"))?; // no toggle (always-hide): not a fold
            Some(FoldInfo {
                kind: attr(doc, n, "data-mv-fold-kind").unwrap_or("quote").to_string(),
                open: attr(doc, n, "data-mv-fold-open") == Some("true"),
                id,
            })
        })
        .collect()
}

/// Put fold `id` in the requested state: the iframe's `el.style.display = ''`
/// or `'none'` on the region, plus the toggle's label. False when there is no
/// such fold or it is already so; nothing changed then. The caller relayouts
/// (`RenderDoc::set_fold`), once, so a click is one bounded unit of work.
pub fn set_fold(doc: &mut BaseDocument, id: &str, open: bool) -> bool {
    let Some(id) = css_ident(id) else { return false };
    let (Some(region), Some(toggle)) = (find(doc, &format!("[data-mv-fold=\"{id}\"]")), find(doc, &format!("[data-mv-fold-toggle=\"{id}\"]"))) else { return false };
    if (attr(doc, region, "data-mv-fold-open") == Some("true")) == open {
        return false;
    }
    let label = attr(doc, toggle, if open { "data-mv-label-open" } else { "data-mv-label-closed" }).unwrap_or("").to_string();
    let text_child = doc.get_node(toggle).and_then(|n| n.children.iter().copied().find(|c| doc.get_node(*c).is_some_and(|k| k.is_text_node())));
    let mut m = doc.mutate();
    if open {
        m.remove_style_property(region, "display");
    } else {
        m.set_style_property(region, "display", "none");
    }
    m.set_attribute(region, QualName::new(None, ns!(), LocalName::from("data-mv-fold-open")), if open { "true" } else { "false" });
    if let Some(t) = text_child {
        m.set_node_text(t, &label);
    }
    true
}

/// The fold whose toggle is `hit` or an ancestor of it.
pub fn fold_at(doc: &BaseDocument, hit: NodeId) -> Option<String> {
    let mut cur = Some(hit);
    while let Some(n) = cur.and_then(|i| doc.get_node(i)) {
        if let Some(id) = n.element_data().and_then(|e| e.attr(LocalName::from("data-mv-fold-toggle"))) {
            return Some(id.to_string());
        }
        cur = n.parent;
    }
    None
}

/// The srgb bytes of a computed colour, rounded.
fn rgb8(c: style::color::AbsoluteColor) -> [f32; 3] {
    let c = c.into_srgb_legacy();
    [c.components.0, c.components.1, c.components.2].map(|v| (v * 255.0).round())
}

fn body_is_dark(doc: &BaseDocument) -> bool {
    let Some(body) = doc.find_body_node() else { return false };
    let Some(s) = body.primary_styles() else { return false };
    let [r, g, b] = rgb8(s.clone_background_color().resolve_to_absolute(&s.clone_color()));
    // isDarkBackground (src/utils/foldDetection.js): mean of r, g, b < 128, alpha ignored.
    (r + g + b) / 3.0 < 128.0
}

/// On a dark body, give every toggle that carries `data-mv-dark-style` those
/// declarations (the iframe's `styleQuoteToggle(toggle, true)`), then relayout.
pub fn apply_toggle_theme(doc: &mut BaseDocument) {
    let Ok(ids) = doc.query_selector_all("[data-mv-dark-style]") else { return };
    if ids.is_empty() || !body_is_dark(doc) {
        return;
    }
    let work: Vec<(NodeId, String)> = ids.iter().filter_map(|&t| Some((t, attr(doc, t, "data-mv-dark-style")?.to_string()))).collect();
    {
        let mut m = doc.mutate();
        for (t, style) in &work {
            for decl in style.split(';') {
                if let Some((k, v)) = decl.split_once(':') {
                    m.set_style_property(*t, k.trim(), v.trim());
                }
            }
        }
    }
    doc.resolve(0.0);
}

/// (background-color, color) of a fold's toggle, as `rgb(r, g, b)`. Tests only.
pub fn toggle_colors(doc: &BaseDocument, id: &str) -> (String, String) {
    let t = css_ident(id).and_then(|id| find(doc, &format!("[data-mv-fold-toggle=\"{id}\"]"))).and_then(|t| doc.get_node(t)).expect("toggle");
    let s = t.primary_styles().expect("styled");
    let fmt = |c| {
        let [r, g, b] = rgb8(c);
        format!("rgb({r}, {g}, {b})")
    };
    (fmt(s.clone_background_color().resolve_to_absolute(&s.clone_color())), fmt(s.clone_color()))
}

/// After a rebuild (fonts op), put every fold back the way the user left it.
pub fn carry_folds(from: &RenderDoc, to: &mut RenderDoc) {
    let fresh = read_folds(to.base());
    for f in read_folds(from.base()) {
        if fresh.iter().find(|g| g.id == f.id).is_some_and(|g| g.open != f.open) {
            to.set_fold(&f.id, f.open);
        }
    }
}
