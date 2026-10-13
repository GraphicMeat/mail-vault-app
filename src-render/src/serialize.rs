//! Rich and plain copy of a selection given in layout coordinates.
//!
//! The plain text comes from blitz's own selection model (so the highlight
//! logic and the copy agree), joined the way WebKit joins blocks. The rich
//! markup is our own `Range.cloneContents()`: blitz's `outer_html` writes
//! unescaped text and `<x />`.
use crate::dommap::{align, dom_end_point, dom_point, DomPoint};
use crate::text::{inline_roots, is_unselectable, NOSELECT_ATTR};
use blitz_dom::{BaseDocument, LocalName, Node, NodeData, NodeId};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// A selection end: `node` is the inline root (`NodeId::as_u64`), `offset` a
/// UTF-8 byte offset into its `TextLayout.text`.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Endpoint {
    pub node: u64,
    pub offset: usize,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Serialized {
    pub html: String,
    pub text: String,
}

const VOID: &[&str] = &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];
const INLINE: &[&str] = &["a", "b", "strong", "i", "em", "u", "s", "span", "font", "code", "sup", "sub", "small", "big", "mark"];

pub fn serialize(doc: &mut BaseDocument, a: Endpoint, b: Endpoint) -> Serialized {
    let empty = || Serialized { html: String::new(), text: String::new() };
    let roots = inline_roots(doc);
    let order: HashMap<NodeId, usize> = roots.iter().enumerate().map(|(i, r)| (*r, i)).collect();
    // An endpoint that is not a visible inline root (stale id, folded away) copies nothing.
    let at = |e: Endpoint| order.get(&NodeId::from_u64(e.node)).map(|i| (*i, NodeId::from_u64(e.node), e.offset));
    let (Some(mut a), Some(mut b)) = (at(a), at(b)) else { return empty() };
    if (a.0, a.2) > (b.0, b.2) {
        std::mem::swap(&mut a, &mut b);
    }
    // Offsets come from the page: clamp them and never split a code point.
    let (a, b) = ((a.1, snap(doc, a.1, a.2, false)), (b.1, snap(doc, b.1, b.2, true)));
    if a == b {
        return empty();
    }
    Serialized { html: markup(doc, a, b), text: plain(doc, &order, a, b) }
}

/// `offset` clamped to the root's text and moved to a char boundary (down for
/// a start, up for an end, so a point inside a code point selects all of it).
fn snap(doc: &BaseDocument, root: NodeId, offset: usize, up: bool) -> usize {
    let Some(tl) = doc.get_node(root).and_then(|n| n.element_data()).and_then(|d| d.inline_layout_data.as_deref()) else { return 0 };
    let mut o = offset.min(tl.text.len());
    while !tl.text.is_char_boundary(o) {
        if up {
            o += 1;
        } else {
            o -= 1;
        }
    }
    o
}

// ── plain text ──

fn plain(doc: &mut BaseDocument, order: &HashMap<NodeId, usize>, a: (NodeId, usize), b: (NodeId, usize)) -> String {
    doc.set_text_selection(a.0, a.1, b.0, b.1);
    let ranges = doc.get_text_selection_ranges();
    // At once, so no tile ever paints blitz's own highlight.
    doc.clear_text_selection();
    let mut out = String::new();
    let mut prev: Option<NodeId> = None;
    for (root, s, e) in ranges {
        // blitz's range walk does not know about closed folds; ours does.
        if !order.contains_key(&root) || is_unselectable(doc, root) {
            continue;
        }
        let piece = selectable_slice(doc, root, s, e);
        if piece.is_empty() {
            continue;
        }
        if let Some(p) = prev {
            out.push_str(separator(doc, p, root));
        }
        out.push_str(&piece);
        prev = Some(root);
    }
    out
}

/// `text[s..e]` of `root`, less generated content and every char that comes
/// from an unselectable DOM node. When the DOM map fails, the plain slice.
fn selectable_slice(doc: &BaseDocument, root: NodeId, s: usize, e: usize) -> String {
    let Some(tl) = doc.get_node(root).and_then(|n| n.element_data()).and_then(|d| d.inline_layout_data.as_deref()) else { return String::new() };
    let e = e.min(tl.text.len());
    let (s, e) = (floor(&tl.text, s), floor(&tl.text, e));
    if s >= e {
        return String::new();
    }
    let Some(slots) = align(doc, root) else { return tl.text[s..e].to_string() };
    let mut cut: Option<(NodeId, bool)> = None; // one-entry cache: runs of chars share a node
    let from = slots.partition_point(|x| x.byte < s);
    slots[from..]
        .iter()
        .take_while(|x| x.byte < e)
        .filter(|x| {
            if x.generated() {
                return false;
            }
            let node = x.dom_node();
            match cut {
                Some((n, hidden)) if n == node => !hidden,
                _ => {
                    let hidden = is_unselectable(doc, node);
                    cut = Some((node, hidden));
                    !hidden
                }
            }
        })
        .map(|x| x.ch)
        .collect()
}

fn floor(text: &str, mut o: usize) -> usize {
    while o > 0 && !text.is_char_boundary(o) {
        o -= 1;
    }
    o
}

fn tag(n: &Node) -> Option<&str> {
    match &n.data {
        NodeData::Element(e) => Some(&*e.name.local),
        _ => None,
    }
}

/// How WebKit's copy joins two blocks: a tab between cells of one table row,
/// a blank line after a paragraph or heading whose bottom margin is at least
/// half its font size, a newline otherwise.
fn separator(doc: &BaseDocument, prev: NodeId, next: NodeId) -> &'static str {
    let cell = |id: NodeId| ancestor_with(doc, id, &["td", "th"]);
    if let (Some(c1), Some(c2)) = (cell(prev), cell(next)) {
        let row = |c: NodeId| doc.get_node(c).and_then(|n| n.parent);
        if c1 != c2 && row(c1) == row(c2) {
            return "\t";
        }
    }
    if let Some(p) = doc.get_node(prev) {
        if matches!(tag(p), Some("p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6")) {
            if let Some(s) = p.primary_styles() {
                let fs = s.get_font().font_size.used_size.0.px();
                if p.final_layout().margin.bottom * 2.0 >= fs {
                    return "\n\n";
                }
            }
        }
    }
    "\n"
}

fn ancestor_with(doc: &BaseDocument, id: NodeId, tags: &[&str]) -> Option<NodeId> {
    let mut cur = Some(id);
    while let Some(n) = cur.and_then(|i| doc.get_node(i)) {
        if tag(n).is_some_and(|t| tags.contains(&t)) {
            return Some(n.id);
        }
        cur = n.parent;
    }
    None
}

// ── markup ──

/// The range, with the node chains from each boundary up to the root.
struct Range {
    start: (NodeId, usize),
    end: (NodeId, usize),
    first: HashSet<NodeId>,
    last: HashSet<NodeId>,
}

fn markup(doc: &BaseDocument, a: (NodeId, usize), b: (NodeId, usize)) -> String {
    let start = boundary(doc, dom_point(doc, a.0, a.1));
    let end = boundary(doc, dom_end_point(doc, b.0, b.1));
    let first: HashSet<NodeId> = ancestors(doc, start.0).into_iter().collect();
    let last: HashSet<NodeId> = ancestors(doc, end.0).into_iter().collect();
    let common = ancestors(doc, end.0).into_iter().find(|n| first.contains(n)).unwrap_or(start.0);
    let range = Range { start, end, first, last };
    let mut out = String::new();
    clone_range(doc, &range, common, &mut out);
    if out.is_empty() {
        return out;
    }
    // The common ancestor itself (when it is an inline element) and its inline
    // ancestors wrap the result: a partial link keeps its href.
    let mut cur = if is_text(doc, common) { doc.get_node(common).and_then(|n| n.parent) } else { Some(common) };
    while let Some(n) = cur.and_then(|i| doc.get_node(i)) {
        let Some(t) = tag(n) else { break };
        if !INLINE.contains(&t) {
            break;
        }
        out = format!("{}{}</{}>", open_tag(n), out, t);
        cur = n.parent;
    }
    out
}

fn is_text(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id).is_some_and(|n| n.is_text_node())
}

/// (container, offset): a text node with a byte offset, or an element with a child index.
fn boundary(doc: &BaseDocument, p: DomPoint) -> (NodeId, usize) {
    match p {
        DomPoint::Text { node, byte } => (node, byte),
        DomPoint::Before { node } | DomPoint::After { node } => {
            let parent = doc.get_node(node).and_then(|n| n.parent).unwrap_or(node);
            let idx = doc.get_node(parent).and_then(|pn| pn.children.iter().position(|c| *c == node)).unwrap_or(0);
            (parent, if matches!(p, DomPoint::After { .. }) { idx + 1 } else { idx })
        }
    }
}

/// `id` and its DOM ancestors, nearest first.
fn ancestors(doc: &BaseDocument, id: NodeId) -> Vec<NodeId> {
    let mut v = vec![id];
    let mut cur = doc.get_node(id).and_then(|n| n.parent);
    while let Some(p) = cur {
        v.push(p);
        cur = doc.get_node(p).and_then(|n| n.parent);
    }
    v
}

fn skipped(n: &Node) -> bool {
    if matches!(n.data, NodeData::Comment { .. }) {
        return true;
    }
    if let NodeData::Element(e) = &n.data {
        if matches!(&*e.name.local, "script" | "style" | "head" | "title") {
            return true;
        }
        if e.attr(LocalName::from(NOSELECT_ATTR)).is_some() {
            return true;
        }
    }
    n.primary_styles().is_some_and(|s| s.clone_display().is_none())
}

/// Range.cloneContents() of the range within `node`, serialized.
fn clone_range(doc: &BaseDocument, r: &Range, node: NodeId, out: &mut String) {
    let Some(n) = doc.get_node(node) else { return };
    if skipped(n) {
        return;
    }
    if let Some(t) = n.text_data() {
        let s = if r.start.0 == node { r.start.1 } else { 0 };
        let e = if r.end.0 == node { r.end.1 } else { t.content.len() };
        if let Some(slice) = t.content.get(s..e.min(t.content.len())) {
            escape_text(slice, out);
        }
        return;
    }
    let kids = &n.children;
    // Children before the start, and from the end on, are outside the range.
    let from = if r.start.0 == node {
        r.start.1
    } else if r.first.contains(&node) {
        kids.iter().position(|c| r.first.contains(c)).unwrap_or(0)
    } else {
        0
    };
    let to = if r.end.0 == node {
        r.end.1
    } else if r.last.contains(&node) {
        kids.iter().position(|c| r.last.contains(c)).map_or(kids.len(), |i| i + 1)
    } else {
        kids.len()
    };
    for child in kids.iter().copied().take(to).skip(from) {
        let Some(c) = doc.get_node(child) else { continue };
        if skipped(c) {
            continue;
        }
        let partial = r.first.contains(&child) || r.last.contains(&child);
        if !partial {
            write_node(doc, c, out);
        } else if c.is_text_node() {
            clone_range(doc, r, child, out);
        } else if let Some(t) = tag(c) {
            out.push_str(&open_tag(c));
            if !VOID.contains(&t) {
                clone_range(doc, r, child, out);
                out.push_str("</");
                out.push_str(t);
                out.push('>');
            }
        }
    }
}

fn write_node(doc: &BaseDocument, n: &Node, out: &mut String) {
    if skipped(n) {
        return;
    }
    if let Some(t) = n.text_data() {
        escape_text(&t.content, out);
        return;
    }
    let Some(t) = tag(n) else { return };
    out.push_str(&open_tag(n));
    if VOID.contains(&t) {
        return;
    }
    for c in n.children.iter().copied() {
        if let Some(cn) = doc.get_node(c) {
            write_node(doc, cn, out);
        }
    }
    out.push_str("</");
    out.push_str(t);
    out.push('>');
}

fn open_tag(n: &Node) -> String {
    let Some(e) = n.element_data() else { return String::new() };
    let mut s = format!("<{}", &*e.name.local);
    for attr in e.attrs() {
        let name = &*attr.name.local;
        // Our own markers never leave the app; handlers never reach a clipboard.
        if name.starts_with("data-mv-") || name.starts_with("on") {
            continue;
        }
        s.push(' ');
        s.push_str(name);
        s.push_str("=\"");
        escape_attr(&attr.value, &mut s);
        s.push('"');
    }
    s.push('>');
    s
}

fn escape_text(t: &str, out: &mut String) {
    for c in t.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}

fn escape_attr(t: &str, out: &mut String) {
    for c in t.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}
