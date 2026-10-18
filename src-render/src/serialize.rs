//! Rich and plain copy of a selection given in layout coordinates.
//!
//! The plain text uses the range rule of blitz's selection model
//! (`get_text_selection_ranges`: first root from its offset, last root up to
//! its offset, whole roots between) over the visible roots we already hold,
//! joined the way WebKit joins blocks. blitz's own range walk dedups with
//! `Vec::contains`, quadratic in the root count; a test proves ours returns the
//! same ranges. The rich markup is our own `Range.cloneContents()`: blitz's
//! `outer_html` writes unescaped text and `<x />`.
//!
//! An inline-block, an inline table or a `<button>` is an inline root of its
//! own: blitz leaves an inline box in its host's text and lists it after the
//! host. Both ends are therefore ordered, and the plain text walked, in reading
//! order (`Nesting`): a nested root's text is spliced in at its box, as the
//! iframe copies it.
use crate::dommap::{align, collapses, dom_end_point, dom_point, pseudo_owner, DomPoint, Slot};
use crate::text::{inline_roots, is_unselectable, is_visibility_hidden, to_layout, NOSELECT_ATTR, WORD_JOINER};
use blitz_dom::{BaseDocument, LocalName, Node, NodeData, NodeId};
use parley::InlineBoxKind;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// A selection end: `node` is the inline root (`NodeId::as_u64`), `offset` a
/// UTF-8 byte offset into its `TextLayout.text` less the word joiners, as the
/// text runs count it (`text::WORD_JOINER`). Everything below works in layout
/// bytes: `serialize` converts the offsets on the way in.
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
const STRUCTURAL: &[&str] = &["table", "thead", "tbody", "tfoot", "tr", "ul", "ol"];
const URL_ATTRS: &[&str] = &["href", "src", "action", "formaction", "poster", "background", "data"];
const INLINE: &[&str] = &["a", "b", "strong", "i", "em", "u", "s", "span", "font", "code", "sup", "sub", "small", "big", "mark"];

pub fn serialize(doc: &BaseDocument, a: Endpoint, b: Endpoint) -> Serialized {
    let empty = || Serialized { html: String::new(), text: String::new() };
    let roots = inline_roots(doc);
    let nest = Nesting::new(doc, &roots);
    // An endpoint that is not a visible inline root (stale id, folded away) copies nothing.
    let at = |e: Endpoint| {
        let id = NodeId::from_u64(e.node);
        nest.order.contains_key(&id).then(|| (id, to_layout(layout_text(doc, id), e.offset).min(layout_len(doc, id))))
    };
    let (Some(mut a), Some(mut b)) = (at(a), at(b)) else { return empty() };
    if nest.key(doc, a) > nest.key(doc, b) {
        std::mem::swap(&mut a, &mut b);
    }
    // Offsets come from the page: never split a code point.
    let (a, b) = ((a.0, snap(doc, a.0, a.1, false)), (b.0, snap(doc, b.0, b.1, true)));
    if a == b {
        return empty();
    }
    let (hi, end) = match nest.runs_to_the_end(doc, &roots, b) {
        Some(top) => (vec![(roots.len(), 0)], nest.end_of(doc, top)),
        None => (nest.key(doc, b), nest.end_point(doc, b)),
    };
    let text = plain(doc, &nest, &roots, &nest.key(doc, a), &hi, &|r| align(doc, r));
    let html = markup(doc, nest.start_point(doc, a), end);
    Serialized { html, text }
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

fn layout_text(doc: &BaseDocument, root: NodeId) -> &str {
    doc.get_node(root).and_then(|n| n.element_data()).and_then(|d| d.inline_layout_data.as_deref()).map_or("", |t| t.text.as_str())
}

fn layout_len(doc: &BaseDocument, root: NodeId) -> usize {
    layout_text(doc, root).len()
}

// ── reading order ──

/// One step of a reading-order key (see `Nesting::key`).
type Step = (usize, usize);

/// How many hosts a walk up the host map follows: a real layout nests far
/// less deep, and a map that loops (it cannot from a real layout) still ends.
const MAX_DEPTH: usize = 64;

/// A nested root's place: the host whose text holds its box, the box's step
/// and element.
#[derive(Clone, Copy)]
struct Hosted {
    host: NodeId,
    at: Step,
    node: NodeId,
}

/// A box in a host's text and the roots it holds, in root order.
struct InBox {
    at: Step,
    node: NodeId,
    roots: Vec<NodeId>,
}

/// Where the nested inline roots sit in their hosts' text.
struct Nesting {
    order: HashMap<NodeId, usize>,
    host: HashMap<NodeId, Hosted>,
    /// Per host, its boxes that hold roots, in text order.
    boxes: HashMap<NodeId, Vec<InBox>>,
}

impl Nesting {
    fn new(doc: &BaseDocument, roots: &[NodeId]) -> Self {
        let order: HashMap<NodeId, usize> = roots.iter().enumerate().map(|(i, r)| (*r, i)).collect();
        // In-flow boxes only. An out-of-flow one (a float, an absolute box) is
        // pushed before its host's pending text, so its offset is not where it
        // stands: those roots stay pieces of their own.
        let mut by_box: HashMap<NodeId, (NodeId, Step)> = HashMap::new();
        for r in roots {
            let Some(tl) = doc.get_node(*r).and_then(|n| n.element_data()).and_then(|d| d.inline_layout_data.as_deref()) else { continue };
            for (k, b) in tl.layout.inline_boxes().enumerate() {
                if b.kind == InlineBoxKind::InFlow {
                    // A stale offset past the text puts the box at the end: never dropped.
                    by_box.insert(NodeId::from_u64(b.id), (*r, (b.index.min(tl.text.len()), k + 1)));
                }
            }
        }
        let mut host = HashMap::new();
        let mut boxes: HashMap<NodeId, Vec<InBox>> = HashMap::new();
        if by_box.is_empty() {
            return Self { order, host, boxes };
        }
        for r in roots {
            // The nearest box at or above the root, unless another root comes first.
            let mut cur = Some(*r);
            while let Some(id) = cur {
                if id != *r && order.contains_key(&id) {
                    break;
                }
                if let Some((h, at)) = by_box.get(&id) {
                    if h != r {
                        host.insert(*r, Hosted { host: *h, at: *at, node: id });
                        let list = boxes.entry(*h).or_default();
                        match list.iter_mut().find(|x| x.node == id) {
                            Some(x) => x.roots.push(*r),
                            None => list.push(InBox { at: *at, node: id, roots: vec![*r] }),
                        }
                    }
                    break;
                }
                cur = doc.get_node(id).and_then(|n| n.parent);
            }
        }
        for list in boxes.values_mut() {
            list.sort_by_key(|x| x.at);
        }
        Self { order, host, boxes }
    }

    /// `root` and the hosts above it, nearest first (at most `MAX_DEPTH` hosts).
    fn chain(&self, root: NodeId) -> Vec<NodeId> {
        let mut v = vec![root];
        while let Some(h) = self.host.get(v.last().unwrap()) {
            if v.len() > MAX_DEPTH {
                break;
            }
            v.push(h.host);
        }
        v
    }

    /// The reading-order key of a point: from its top-level root down through
    /// the boxes that hold it, `(root index, 0)` then `(offset, slot)` per
    /// level. A box is `(its offset, 1 + its place in the host's boxes)`; the
    /// point's own offset has slot 0, or `usize::MAX` at the end of its root's
    /// text. So a host offset at a box is before the box (a start there takes
    /// it in, an end there leaves it out), and the end of a host's text is
    /// after every box there.
    fn key(&self, doc: &BaseDocument, (root, offset): (NodeId, usize)) -> Vec<Step> {
        let mut k = vec![(offset, if offset >= layout_len(doc, root) { usize::MAX } else { 0 })];
        let chain = self.chain(root);
        for (i, cur) in chain.iter().enumerate() {
            k.push((self.order.get(cur).copied().unwrap_or(usize::MAX), 0));
            // The last host of a capped chain is treated as top-level.
            match self.host.get(cur) {
                Some(h) if i + 1 < chain.len() => k.push(h.at),
                _ => break,
            }
        }
        k.reverse();
        k
    }

    /// The pieces `(root, start, end)` from key `lo` to key `hi` (not before
    /// it), in reading order: a host's text is cut at each box in range and the
    /// box's roots go in between.
    fn pieces(&self, doc: &BaseDocument, roots: &[NodeId], lo: &[Step], hi: &[Step]) -> Vec<(NodeId, usize, usize)> {
        let mut out = Vec::new();
        let top = roots.iter().copied().filter(|r| !self.host.contains_key(r));
        self.walk_roots(doc, top, Some(lo), Some(hi), &mut out);
        out
    }

    /// Roots side by side (top-level, or in one box); `lo`/`hi` start at their
    /// root step, `None` is unbounded.
    fn walk_roots(&self, doc: &BaseDocument, list: impl Iterator<Item = NodeId>, lo: Option<&[Step]>, hi: Option<&[Step]>, out: &mut Vec<(NodeId, usize, usize)>) {
        let (lo0, hi0) = (lo.map(|l| l[0].0), hi.map(|h| h[0].0));
        for r in list {
            let i = self.order[&r];
            if lo0.is_some_and(|x| i < x) {
                continue;
            }
            if hi0.is_some_and(|x| i > x) {
                break;
            }
            let sub_lo = if lo0 == Some(i) { lo.map(|l| &l[1..]) } else { None };
            let sub_hi = if hi0 == Some(i) { hi.map(|h| &h[1..]) } else { None };
            self.walk_root(doc, r, sub_lo, sub_hi, out);
        }
    }

    /// One root; `lo`/`hi` start at its offset step.
    fn walk_root(&self, doc: &BaseDocument, r: NodeId, lo: Option<&[Step]>, hi: Option<&[Step]>, out: &mut Vec<(NodeId, usize, usize)>) {
        let len = layout_len(doc, r);
        let lo0 = lo.map_or((0, 0), |l| l[0]);
        let hi0 = hi.map_or((len, usize::MAX), |h| h[0]);
        let mut cur = lo0.0.min(len);
        for b in self.boxes.get(&r).map_or(&[][..], |v| &v[..]) {
            if b.at < lo0 {
                continue;
            }
            if b.at > hi0 {
                break;
            }
            let at = b.at.0.min(len);
            if at > cur {
                out.push((r, cur, at));
                cur = at;
            }
            let sub_lo = if b.at == lo0 { lo.map(|l| &l[1..]) } else { None };
            let sub_hi = if b.at == hi0 { hi.map(|h| &h[1..]) } else { None };
            self.walk_roots(doc, b.roots.iter().copied(), sub_lo, sub_hi, out);
        }
        let end = hi0.0.min(len);
        if end > cur {
            out.push((r, cur, end));
        }
    }

    /// What goes between two copied pieces: nothing within one host's line (a
    /// nested root and its host, the roots of two boxes of one host), the block
    /// separator between roots side by side (two top-level roots, two blocks in
    /// one inline-block).
    fn join(&self, doc: &BaseDocument, prev: NodeId, next: NodeId) -> &'static str {
        if prev == next {
            return "";
        }
        let (p, n) = (self.chain(prev), self.chain(next));
        for (ni, x) in n.iter().enumerate() {
            if let Some(pi) = p.iter().position(|y| y == x) {
                if pi == 0 || ni == 0 {
                    return "";
                }
                let (l, r) = (p[pi - 1], n[ni - 1]);
                return if self.host[&l].node == self.host[&r].node { separator(doc, l, r) } else { "" };
            }
        }
        separator(doc, *p.last().unwrap(), *n.last().unwrap())
    }

    /// The top-level root a selection that ends at `b` runs to the end of:
    /// `b` ends a nested root that nothing selectable follows. The layer lists
    /// nested roots after their host, so a select-all ends in the last one,
    /// and the host's text after its box is still part of it.
    ///
    /// Known gaps of that DOM order (the layer, not this walk): a drag from the
    /// host into a nested root highlights the host's text after the box, which
    /// is not copied; and the converse, a selection with both ends in the host
    /// text that spans a box copies the box's text (a button label) while the
    /// layer does not highlight it, and the cold reply floor (`layerPlainText`,
    /// before serialize lands) misses that text too.
    fn runs_to_the_end(&self, doc: &BaseDocument, roots: &[NodeId], (root, offset): (NodeId, usize)) -> Option<NodeId> {
        if !self.host.contains_key(&root) || offset < layout_len(doc, root) {
            return None;
        }
        let rest = &roots[self.order[&root] + 1..];
        let empty = |r: NodeId| {
            is_unselectable(doc, r)
                || layout_len(doc, r) == 0
                || match align(doc, r) {
                    Some(slots) => selectable_slice(doc, r, 0, layout_len(doc, r), &slots).is_empty(),
                    None => dom_plain(doc, r, &self.host).is_empty(),
                }
        };
        rest.iter().all(|r| empty(*r)).then(|| *self.chain(root).last().unwrap())
    }

    /// The DOM point a copy from `(root, offset)` starts at: before the box
    /// there when the plain text takes it in.
    fn start_point(&self, doc: &BaseDocument, (root, offset): (NodeId, usize)) -> DomPoint {
        if offset >= layout_len(doc, root) {
            return self.end_of(doc, root);
        }
        self.boxes
            .get(&root)
            .and_then(|v| v.iter().find(|b| b.at.0 == offset))
            .and_then(|b| child_point(doc, b.node, false))
            .unwrap_or_else(|| dom_point(doc, root, offset))
    }

    /// The DOM point a copy up to `(root, offset)` ends at.
    fn end_point(&self, doc: &BaseDocument, (root, offset): (NodeId, usize)) -> DomPoint {
        if offset >= layout_len(doc, root) {
            return self.end_of(doc, root);
        }
        dom_end_point(doc, root, offset)
    }

    /// The end of a root's text, after the boxes that end it.
    fn end_of(&self, doc: &BaseDocument, root: NodeId) -> DomPoint {
        let len = layout_len(doc, root);
        self.boxes
            .get(&root)
            .and_then(|v| v.iter().rev().find(|b| b.at.0 >= len))
            .and_then(|b| child_point(doc, b.node, true))
            .unwrap_or_else(|| dom_end_point(doc, root, len))
    }
}

/// Before or after `node` in its parent's child list (`None` when it is not in
/// one: a pseudo-element, an anonymous block).
fn child_point(doc: &BaseDocument, node: NodeId, after: bool) -> Option<DomPoint> {
    let parent = doc.get_node(node)?.parent?;
    doc.get_node(parent)?.children.contains(&node).then_some(if after { DomPoint::After { node } } else { DomPoint::Before { node } })
}

// ── plain text ──

/// The plain text from key `lo` to key `hi`; `align` maps a root's layout text
/// to its DOM (a test hook stands in a failing one).
fn plain(doc: &BaseDocument, nest: &Nesting, roots: &[NodeId], lo: &[Step], hi: &[Step], align: &dyn Fn(NodeId) -> Option<Vec<Slot>>) -> String {
    let pieces: Vec<_> = nest.pieces(doc, roots, lo, hi).into_iter().filter(|(r, _, _)| !is_unselectable(doc, *r)).collect();
    let mut slots: HashMap<NodeId, Option<Vec<Slot>>> = HashMap::new();
    for (r, _, _) in &pieces {
        slots.entry(*r).or_insert_with(|| align(*r));
    }
    // A root whose DOM map fails copies its whole DOM text once (`dom_plain`),
    // its nested roots' text included: their own pieces go.
    let degraded: HashSet<NodeId> = slots.iter().filter(|(_, s)| s.is_none()).map(|(r, _)| *r).collect();
    let mut done = HashSet::new();
    let mut out = String::new();
    let mut prev: Option<NodeId> = None;
    for (root, s, e) in pieces {
        if !degraded.is_empty() && nest.chain(root)[1..].iter().any(|h| degraded.contains(h)) {
            continue;
        }
        let piece = match &slots[&root] {
            Some(sl) => selectable_slice(doc, root, s, e, sl),
            None if done.insert(root) => dom_plain(doc, root, &nest.host),
            None => continue,
        };
        // WebKit and Chrome put a plain space on the plain-text clipboard for nbsp.
        let piece = piece.replace('\u{a0}', " ");
        if piece.is_empty() {
            continue;
        }
        if let Some(p) = prev {
            out.push_str(nest.join(doc, p, root));
        }
        out.push_str(&piece);
        prev = Some(root);
    }
    out
}

/// `text[s..e]` of `root`, less generated content, word joiners and every
/// char that comes from an unselectable or visibility-hidden DOM node.
fn selectable_slice(doc: &BaseDocument, root: NodeId, s: usize, e: usize, slots: &[Slot]) -> String {
    let Some(tl) = doc.get_node(root).and_then(|n| n.element_data()).and_then(|d| d.inline_layout_data.as_deref()) else { return String::new() };
    let e = e.min(tl.text.len());
    let (s, e) = (floor(&tl.text, s), floor(&tl.text, e));
    if s >= e {
        return String::new();
    }
    let mut cut: Option<(NodeId, bool)> = None; // one-entry cache: runs of chars share a node
    let from = slots.partition_point(|x| x.byte < s);
    slots[from..]
        .iter()
        .take_while(|x| x.byte < e)
        .filter(|x| {
            if x.generated() || x.ch == WORD_JOINER {
                return false;
            }
            let node = x.dom_node();
            match cut {
                Some((n, hidden)) if n == node => !hidden,
                _ => {
                    let hidden = is_unselectable(doc, node) || hidden_text(doc, node);
                    cut = Some((node, hidden));
                    !hidden
                }
            }
        })
        .map(|x| x.ch)
        .collect()
}

/// The degraded copy of a root: its DOM text, skipping everything `skipped`
/// skips (so it agrees with the element-granular markup) and the inline roots
/// that are pieces of their own (floats, absolute boxes); a nested root's text
/// is part of it where it stands. `<br>` is a newline, whitespace collapsed
/// unless the root preserves it. Generated content has no DOM text, and a root
/// that is itself generated copies nothing.
fn dom_plain(doc: &BaseDocument, root: NodeId, nested: &HashMap<NodeId, Hosted>) -> String {
    struct Walk<'a> {
        out: String,
        collapse: bool,
        prev_ws: bool,
        nested: &'a HashMap<NodeId, Hosted>,
    }
    fn walk(doc: &BaseDocument, id: NodeId, w: &mut Walk) {
        let Some(n) = doc.get_node(id) else { return };
        for c in n.children.iter().copied() {
            let Some(cn) = doc.get_node(c) else { continue };
            if skipped(cn) || (is_inline_root(cn) && !w.nested.contains_key(&c)) {
                continue;
            }
            if let Some(t) = cn.text_data() {
                if hidden_text(doc, c) {
                    continue;
                }
                for ch in t.content.chars() {
                    let ws = w.collapse && ch.is_ascii_whitespace();
                    if !(ws && w.prev_ws) {
                        w.out.push(if ws { ' ' } else { ch });
                    }
                    w.prev_ws = ws;
                }
            } else if tag(cn) == Some("br") {
                if is_visibility_hidden(cn) {
                    continue;
                }
                // A break is a break: later spaces fold into it, nothing folds it away.
                w.out.push('\n');
                w.prev_ws = true;
            } else {
                walk(doc, c, w);
            }
        }
    }
    fn is_inline_root(n: &Node) -> bool {
        n.flags.is_inline_root() && n.element_data().is_some_and(|e| e.inline_layout_data.is_some())
    }
    if pseudo_owner(doc, root).is_some() {
        return String::new();
    }
    let collapse = doc.get_node(root).and_then(|n| n.primary_styles()).map_or(true, |s| collapses(&s));
    let mut w = Walk { out: String::new(), collapse, prev_ws: false, nested };
    walk(doc, root, &mut w);
    if collapse {
        w.out.trim_matches(' ').to_string()
    } else {
        w.out
    }
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

fn markup(doc: &BaseDocument, a: DomPoint, b: DomPoint) -> String {
    let (start, end) = (boundary(doc, a), boundary(doc, b));
    let first: HashSet<NodeId> = ancestors(doc, start.0).into_iter().collect();
    let last: HashSet<NodeId> = ancestors(doc, end.0).into_iter().collect();
    let common = ancestors(doc, end.0).into_iter().find(|n| first.contains(n)).unwrap_or(start.0);
    // Both ends inside one noselect node (a masked value): nothing to copy.
    if is_unselectable(doc, common) {
        return String::new();
    }
    let range = Range { start, end, first, last };
    let mut out = String::new();
    clone_range(doc, &range, common, &mut out);
    if out.is_empty() {
        return out;
    }
    // The common ancestor itself (when it is an inline element) and its inline
    // ancestors wrap the result: a partial link keeps its href. Rows, row groups
    // and list items are meaningless to a body-context paste on their own, so a
    // result that is made of them keeps its table or list (as WebKit does).
    let mut cur = if is_text(doc, common) { doc.get_node(common).and_then(|n| n.parent) } else { Some(common) };
    let mut inline = true;
    while let Some(n) = cur.and_then(|i| doc.get_node(i)) {
        let Some(t) = tag(n) else { break };
        if skipped(n) || is_unselectable(doc, n.id) {
            return String::new();
        }
        let structural = STRUCTURAL.contains(&t);
        if !(inline && INLINE.contains(&t)) && !structural {
            break;
        }
        inline &= !structural;
        out = format!("{}{}</{}>", open_tag(n), out, t);
        if matches!(t, "table" | "ul" | "ol") {
            break;
        }
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

/// A text node, or a DOM node a slot points at, whose computed `visibility` is
/// hidden or collapse: a mail preheader is often `visibility:hidden;opacity:0`.
/// Text has no style of its own, so it takes its parent's; `visibility`
/// inherits, so a `visibility:visible` child of a hidden parent is not hidden.
/// The layer leaves such text out (text.rs), and so does a copy.
fn hidden_text(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(n) = doc.get_node(id) else { return false };
    let styled = if n.is_text_node() { n.parent.and_then(|p| doc.get_node(p)) } else { Some(n) };
    styled.is_some_and(is_visibility_hidden)
}

/// Range.cloneContents() of the range within `node`, serialized.
fn clone_range(doc: &BaseDocument, r: &Range, node: NodeId, out: &mut String) {
    let Some(n) = doc.get_node(node) else { return };
    if skipped(n) {
        return;
    }
    if let Some(t) = n.text_data() {
        if hidden_text(doc, node) {
            return;
        }
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
            if VOID.contains(&t) {
                if !is_visibility_hidden(c) {
                    out.push_str(&open_tag(c));
                }
                continue;
            }
            // A partially contained ancestor that contributes nothing (the
            // selection starts at its very end, or ends at its very start) is dropped.
            let before = out.len();
            out.push_str(&open_tag(c));
            let opened = out.len();
            clone_range(doc, r, child, out);
            if out.len() == opened {
                out.truncate(before);
            } else {
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
        if !hidden_text(doc, n.id) {
            escape_text(&t.content, out);
        }
        return;
    }
    let Some(t) = tag(n) else { return };
    let hidden = is_visibility_hidden(n);
    if VOID.contains(&t) {
        if !hidden {
            out.push_str(&open_tag(n));
        }
        return;
    }
    let before = out.len();
    out.push_str(&open_tag(n));
    let opened = out.len();
    for c in n.children.iter().copied() {
        if let Some(cn) = doc.get_node(c) {
            write_node(doc, cn, out);
        }
    }
    // A hidden element keeps its wrapper only for a visible descendant.
    if hidden && out.len() == opened {
        out.truncate(before);
        return;
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
        // A link or an image that runs script when pasted somewhere that
        // does not sanitise (stricter than the iframe's own copy, which keeps them).
        if URL_ATTRS.contains(&name) && scripted_url(&attr.value) {
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

/// A URL that runs or renders script when followed or loaded: `javascript:`,
/// `vbscript:` or `data:text/html`, after the whitespace and control
/// characters a browser strips before it reads the scheme (a tab or newline
/// inside the scheme is dropped too), compared without case. `data:image/*`,
/// http(s), mailto, tel and cid stay.
fn scripted_url(value: &str) -> bool {
    let lead = value.trim_start_matches(|c: char| c.is_whitespace() || c.is_control());
    let folded: String = lead.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).take(16).flat_map(char::to_lowercase).collect();
    folded.starts_with("javascript:") || folded.starts_with("vbscript:") || folded.starts_with("data:text/html")
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

#[cfg(test)]
mod tests {
    use super::*;
    use blitz_dom::DocumentConfig;
    use blitz_html::HtmlDocument;
    use blitz_traits::shell::{ColorScheme, Viewport};

    fn doc(html: &str) -> HtmlDocument {
        let config = DocumentConfig {
            viewport: Some(Viewport::new(400, 300, 1.0, ColorScheme::Light)),
            base_url: Some("http://invalid.invalid/".to_string()),
            ..Default::default()
        };
        let mut d = HtmlDocument::from_html(html, config);
        d.resolve(0.0);
        d
    }

    /// Our reading-order pieces equal blitz's own ranges for every ordered pair of endpoints
    /// (roots, and the offsets 0, 1, middle, end of each), on shapes with
    /// tables, lists, breaks and a folded region. Anonymous blocks are left out on
    /// purpose: blitz's range walk follows DOM children, so it misses an anonymous
    /// block between its endpoints and re-resolves an anonymous endpoint by sibling
    /// index (a start at a div and an end at offset 0 of a later anonymous block
    /// yields that block and the next paragraph). Ours treats them like any root;
    /// `anonymous_blocks_inside_and_at_the_ends_of_a_selection_are_copied` pins it.
    /// Nothing here is nested: nested roots have their own tests.
    #[test]
    fn linear_ranges_equal_blitzs_for_every_endpoint_pair() {
        let corpus = [
            "<p>one two</p><p>three</p><div>four <b>five</b></div>",
            "<table><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></table>",
            "<ul><li>x</li><li>y <i>z</i></li></ul><ol><li>n</li></ol>",
            "<p>a<br>b</p><p></p><p> </p><p>last</p>",
            "<p>keep</p><blockquote style=\"display:none\"><p>folded</p></blockquote><p>after</p>",
            "<div><p>deep</p><div><p>deeper</p></div></div><h1>h</h1>",
        ];
        let mut pairs = 0;
        for html in corpus {
            let mut d = doc(html);
            let roots = inline_roots(&d);
            let order: HashMap<NodeId, usize> = roots.iter().enumerate().map(|(i, r)| (*r, i)).collect();
            let nest = Nesting::new(&d, &roots);
            assert!(nest.host.is_empty(), "{html:?}");
            let points: Vec<(usize, usize)> = roots
                .iter()
                .enumerate()
                .flat_map(|(i, r)| {
                    let len = layout_len(&d, *r);
                    [0, 1, len / 2, len].into_iter().map(move |o| (i, o.min(len)))
                })
                .collect();
            for (x, a) in points.iter().enumerate() {
                for b in &points[x..] {
                    if a >= b {
                        continue; // `serialize` orders its endpoints; equal ones copy nothing
                    }
                    d.set_text_selection(roots[a.0], a.1, roots[b.0], b.1);
                    let theirs: Vec<_> = d.get_text_selection_ranges().into_iter().filter(|(r, _, _)| order.contains_key(r)).collect();
                    d.clear_text_selection();
                    let key = |(i, o): (usize, usize)| nest.key(&d, (roots[i], o));
                    assert_eq!(nest.pieces(&d, &roots, &key(*a), &key(*b)), theirs, "{html:?} {a:?}..{b:?}");
                    pairs += 1;
                }
            }
        }
        assert!(pairs > 300, "{pairs}");
    }

    /// The degraded copy of a host (its DOM text) carries the text of its
    /// nested inline roots where they stand.
    #[test]
    fn the_degraded_copy_of_a_host_splices_its_nested_roots() {
        let d = doc(&format!(r#"{CTA}<p>x <span style="float:right">fl</span> y</p>"#));
        let roots = inline_roots(&d);
        let nested = Nesting::new(&d, &roots).host;
        let host = |t: &str| *roots.iter().find(|r| d.get_node(**r).and_then(|n| tag(n).map(str::to_string)).as_deref() == Some(t)).unwrap();
        assert_eq!(dom_plain(&d, host("p"), &nested), "Ctabefore Ctabutton text ctamiddle Btnlabel btnafter.");
        // A float stays a piece of its own: its host's DOM text leaves it out.
        let second = roots[roots.iter().position(|r| *r == host("p")).unwrap() + 1..]
            .iter()
            .copied()
            .find(|r| d.get_node(*r).and_then(tag) == Some("p"))
            .unwrap();
        assert_eq!(dom_plain(&d, second, &nested), "x y");
    }

    const CTA: &str = r#"<p>Ctabefore <a href="https://example.com/cta" style="display:inline-block">Ctabutton text</a> ctamiddle <button type="button" style="display:inline-block">Btnlabel</button> btnafter.</p>"#;

    /// A host whose DOM map fails copies its DOM text once, nested text in
    /// place, and its nested roots are not copied a second time.
    #[test]
    fn a_degraded_host_copies_its_dom_text_once_with_its_nested_roots() {
        let d = doc(&format!("{CTA}<p>next</p>"));
        let roots = inline_roots(&d);
        let nest = Nesting::new(&d, &roots);
        assert_eq!(nest.host.len(), 2, "the link and the button are nested");
        let last = *roots.last().unwrap();
        let (lo, hi) = (nest.key(&d, (roots[0], 0)), nest.key(&d, (last, layout_len(&d, last))));
        let want = "Ctabefore Ctabutton text ctamiddle Btnlabel btnafter.\n\nnext";
        let host = roots[0];
        assert_eq!(plain(&d, &nest, &roots, &lo, &hi, &|r| if r == host { None } else { align(&d, r) }), want);
        assert_eq!(plain(&d, &nest, &roots, &lo, &hi, &|_| None), want, "every root degraded");
        // A selection inside a nested root of a degraded host copies its own slice.
        let link = roots[1];
        let (lo, hi) = (nest.key(&d, (link, 1)), nest.key(&d, (link, 6)));
        assert_eq!(plain(&d, &nest, &roots, &lo, &hi, &|r| if r == host { None } else { align(&d, r) }), "tabut");
    }

    /// A box offset past the host's text (a stale layout) puts the nested text
    /// at the end of the host instead of dropping it.
    #[test]
    fn a_box_offset_past_the_host_text_puts_the_nested_text_at_its_end() {
        let mut d = doc(&format!("{CTA}<p>next</p>"));
        let host = inline_roots(&d)[0];
        let tl = d.get_node_mut(host).unwrap().element_data_mut().unwrap().inline_layout_data.as_deref_mut().unwrap();
        tl.layout.inline_boxes_mut().nth(1).unwrap().index = 10_000;
        let roots = inline_roots(&d);
        let nest = Nesting::new(&d, &roots);
        let last = *roots.last().unwrap();
        let (lo, hi) = (nest.key(&d, (roots[0], 0)), nest.key(&d, (last, layout_len(&d, last))));
        let text = plain(&d, &nest, &roots, &lo, &hi, &|r| align(&d, r));
        assert_eq!(text, "Ctabefore Ctabutton text ctamiddle  btnafter.Btnlabel\n\nnext");
    }

    /// A host map that loops (it cannot from a real layout) still ends.
    #[test]
    fn a_looping_host_map_still_ends() {
        let (a, b) = (NodeId::from_u64(1), NodeId::from_u64(2));
        let hosted = |host| Hosted { host, at: (0, 1), node: host };
        let nest = Nesting {
            order: [(a, 0), (b, 1)].into_iter().collect(),
            host: [(a, hosted(b)), (b, hosted(a))].into_iter().collect(),
            boxes: HashMap::new(),
        };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(nest.chain(a).len());
        });
        let n = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("chain() did not end");
        assert!(n <= MAX_DEPTH + 1, "{n}");
    }
}
