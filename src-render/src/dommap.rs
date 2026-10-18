//! Layout-text byte -> DOM position, for one inline root.
//!
//! Replays the push order of blitz-dom's `build_inline_layout_into`
//! (blitz-dom 0.3.0-beta.4 as vendored in src-render/vendor/blitz-dom,
//! src/layout/construct.rs, MIT OR Apache-2.0): list marker, ::before, children
//! (recursing into inline-flow elements and `display: contents`, skipping
//! display:none, hidden inputs and comments, atomic inline boxes carrying no
//! text), `<br>` as "\n" in a preserving span, ::after; text pushed case-transformed,
//! with plan B's two vendored changes: the collapsible spaces that end a text right
//! before a `<br>` are dropped (`precedes_forced_break`), and an edge no-break space
//! gets a word joiner on its outer side (`push_text_keeping_nbsp`); a joiner maps to
//! the DOM text's edge with no width. The pushes then go through a model of parley
//! 0.12's `TreeStyleBuilder` (src/resolve/tree.rs, src/builder.rs), which decides what
//! whitespace survives into `TextLayout.text`, so the model's output can be
//! compared char for char with the layout text. A match gives every layout
//! char its DOM source; any difference makes the root degrade to element
//! granularity and never panics.
use crate::text::WORD_JOINER;
use blitz_dom::node::{ListItemLayoutPosition, Marker};
use blitz_dom::{local_name, BaseDocument, NodeData, NodeId};
use style::computed_values::white_space_collapse::T as Wsc;
use style::properties::ComputedValues;
use style::values::computed::{Display, TextTransform};
use style::values::specified::box_::{DisplayInside, DisplayOutside};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DomPoint {
    Text { node: NodeId, byte: usize },
    Before { node: NodeId },
    After { node: NodeId },
}

/// Where one laid-out char came from.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Src {
    /// A char of a DOM text node: its byte offset and UTF-8 length there. Case
    /// mapping can turn one DOM char into several layout chars; each keeps it.
    Text { node: NodeId, byte: usize, len: usize },
    /// Generated content (list marker, ::before, ::after), owned by element `owner`.
    Gen { owner: NodeId, after: bool },
    /// A `<br>` pushed as "\n".
    Br { node: NodeId },
}

#[derive(Clone, Copy, PartialEq)]
enum Case {
    None,
    Upper,
    Lower,
}

type Pushed = Vec<(char, Src)>;

/// The white-space-collapse of a span, as blitz-dom hands it to parley.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Collapse,
    PreserveBreaks,
    Preserve,
}

impl Mode {
    /// Whitespace this mode collapses (parley's `WhiteSpaceCollapse::is_collapsible`).
    fn collapsible(self, c: char) -> bool {
        match self {
            Mode::Collapse => c.is_ascii_whitespace(),
            Mode::PreserveBreaks => matches!(c, ' ' | '\t'),
            Mode::Preserve => false,
        }
    }
}

fn mode_of(s: &ComputedValues) -> Mode {
    match s.clone_white_space_collapse() {
        Wsc::Collapse => Mode::Collapse,
        Wsc::PreserveBreaks => Mode::PreserveBreaks,
        // parley's Preserve and BreakSpaces process whitespace the same way.
        Wsc::Preserve | Wsc::BreakSpaces => Mode::Preserve,
    }
}

/// A char parley treats as a forced line break when it is preserved.
fn is_segment_break(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// parley 0.12's `TreeStyleBuilder`, reduced to what decides the text it keeps:
/// a run of collapsible whitespace becomes one pending space (attributed to its
/// first char) that is committed only when content follows it in the same inline
/// formatting context, across span boundaries; it is dropped at the start of the
/// context, after a preserved segment break, right before one, and at the end. Only
/// an in-flow inline box flushes it.
struct Sim {
    committed: Pushed,
    pending: Option<Src>,
    last_item_is_inline_box: bool,
}

impl Sim {
    fn new() -> Self {
        Sim { committed: Vec::new(), pending: None, last_item_is_inline_box: false }
    }

    fn commit(&mut self, c: char, src: Src) {
        self.committed.push((c, src));
        self.last_item_is_inline_box = false;
    }

    fn flush_pending(&mut self) {
        let Some(src) = self.pending.take() else { return };
        let at_start = self.committed.is_empty() && !self.last_item_is_inline_box;
        if at_start || self.committed.last().is_some_and(|(c, _)| is_segment_break(*c)) {
            return;
        }
        self.commit(' ', src);
    }

    fn push(&mut self, chars: Pushed, mode: Mode) {
        if chars.is_empty() {
            return;
        }
        if mode == Mode::Preserve {
            if is_segment_break(chars[0].0) {
                self.pending = None;
            }
            self.flush_pending();
            for (c, src) in chars {
                self.commit(c, src);
            }
            return;
        }
        let mut i = 0;
        while i < chars.len() {
            let (c, src) = chars[i];
            if mode.collapsible(c) {
                self.pending.get_or_insert(src);
                i += 1;
            } else if is_segment_break(c) {
                self.pending = None;
                self.commit(c, src);
                i += 1;
            } else {
                self.flush_pending();
                while i < chars.len() && !mode.collapsible(chars[i].0) && !is_segment_break(chars[i].0) {
                    self.commit(chars[i].0, chars[i].1);
                    i += 1;
                }
            }
        }
    }

    /// Only in-flow boxes flush pending whitespace; out-of-flow ones leave it pending.
    fn inline_box(&mut self, in_flow: bool) {
        if in_flow {
            self.flush_pending();
            self.last_item_is_inline_box = true;
        }
    }

    fn finish(self) -> Pushed {
        self.committed
    }
}

/// `Some((owner, is_after))` when `id` is the ::before / ::after node of `owner`.
pub(crate) fn pseudo_owner(doc: &BaseDocument, id: NodeId) -> Option<(NodeId, bool)> {
    let owner = doc.get_node(id)?.parent?;
    let o = doc.get_node(owner)?;
    if o.before() == Some(id) {
        Some((owner, false))
    } else if o.after() == Some(id) {
        Some((owner, true))
    } else {
        None
    }
}

/// Whether `s` collapses spaces and newlines alike (`white-space-collapse: collapse`).
pub(crate) fn collapses(s: &ComputedValues) -> bool {
    matches!(s.clone_white_space_collapse(), Wsc::Collapse)
}

fn case_of(s: &ComputedValues) -> Case {
    let t = s.clone_text_transform() & TextTransform::CASE_TRANSFORMS;
    if t == TextTransform::UPPERCASE {
        Case::Upper
    } else if t == TextTransform::LOWERCASE {
        Case::Lower
    } else {
        Case::None
    }
}

/// Text as `construct.rs` pushes it: the whole string case-mapped at once (so
/// context rules like the final sigma apply), each result char attributed to the
/// DOM char it grew from.
fn text_chars(content: &str, node: NodeId, case: Case, pseudo: Option<(NodeId, bool)>) -> Pushed {
    let src = |byte: usize, len: usize| match pseudo {
        Some((owner, after)) => Src::Gen { owner, after },
        None => Src::Text { node, byte, len },
    };
    let mapped: String = match case {
        Case::Upper => content.to_uppercase(),
        Case::Lower => content.to_lowercase(),
        Case::None => return content.char_indices().map(|(b, c)| (c, src(b, c.len_utf8()))).collect(),
    };
    let mut out = Vec::with_capacity(mapped.len());
    let mut it = mapped.chars();
    let mut last = src(0, 0);
    for (b, c) in content.char_indices() {
        last = src(b, c.len_utf8());
        let n = match case {
            Case::Upper => c.to_uppercase().count(),
            _ => c.to_lowercase().count(),
        };
        for _ in 0..n {
            if let Some(m) = it.next() {
                out.push((m, last));
            }
        }
    }
    out.extend(it.map(|m| (m, last)));
    out
}

/// The spaces CSS collapses: not the no-break space (vendored construct.rs).
fn is_collapsible_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c')
}

/// The vendored construct.rs's `precedes_forced_break`: whether the next thing
/// on the line after text node `node` is a `<br>`, looking past
/// whitespace-only text and out of the plain inline elements the node ends.
fn precedes_forced_break(doc: &BaseDocument, node: NodeId) -> bool {
    let mut id = node;
    loop {
        let Some(parent) = doc.get_node(id).and_then(|n| n.parent).and_then(|p| doc.get_node(p)) else { return false };
        let Some(index) = parent.children.iter().position(|&c| c == id) else { return false };
        let next = parent.children[index + 1..].iter().copied().find(|&sib| {
            doc.get_node(sib).and_then(|n| n.text_data()).map_or(true, |t| !t.content.chars().all(is_collapsible_space))
        });
        match next {
            Some(sib) => return doc.get_node(sib).is_some_and(|n| n.data.is_element_with_tag_name(&local_name!("br"))),
            None => {
                let plain_inline = parent.after().is_none()
                    && parent.primary_styles().is_some_and(|s| {
                        let d = s.clone_display();
                        d.outside() == DisplayOutside::Inline && d.inside() == DisplayInside::Flow
                    });
                if !plain_inline {
                    return false;
                }
                id = parent.id;
            }
        }
    }
}

/// A text node's pushes as the vendored construct.rs makes them: trailing
/// collapsible spaces before a `<br>` dropped, case-mapped, and a word joiner
/// outside a leading or trailing nbsp of the result. A joiner is a zero-length
/// slot at the DOM text's edge, so a point on either side of it lands there.
fn text_pushes(doc: &BaseDocument, id: NodeId, content: &str, collapse: bool, case: Case, pseudo: Option<(NodeId, bool)>) -> Pushed {
    const NBSP: char = '\u{a0}';
    let content = if collapse && precedes_forced_break(doc, id) { content.trim_end_matches(is_collapsible_space) } else { content };
    let mut chars = text_chars(content, id, case, pseudo);
    let joiner = |byte: usize| match pseudo {
        Some((owner, after)) => (WORD_JOINER, Src::Gen { owner, after }),
        None => (WORD_JOINER, Src::Text { node: id, byte, len: 0 }),
    };
    if chars.first().is_some_and(|(c, _)| *c == NBSP) {
        chars.insert(0, joiner(0));
    }
    if chars.last().is_some_and(|(c, _)| *c == NBSP) {
        chars.push(joiner(content.len()));
    }
    chars
}

/// `is_replaced_element` of blitz-dom (layout/replaced.rs) plus the form
/// controls `construct.rs` also makes inline boxes.
fn is_atomic_tag(tag: &str) -> bool {
    matches!(tag, "img" | "svg" | "canvas" | "video" | "embed" | "iframe" | "input" | "textarea" | "button")
}

fn rec(doc: &BaseDocument, sim: &mut Sim, id: NodeId, mode_in: Mode, case_in: Case, pseudo: Option<(NodeId, bool)>) {
    let Some(node) = doc.get_node(id) else { return };
    let style = node.primary_styles();
    let mode = style.as_ref().map(|s| mode_of(s)).unwrap_or(mode_in);
    let case = style.as_ref().map(|s| case_of(s)).unwrap_or(Case::None);
    match &node.data {
        NodeData::Element(el) | NodeData::AnonymousBlock(el) => {
            if &*el.name.local == "input" && el.attr(local_name!("type")) == Some("hidden") {
                return;
            }
            let pseudo = pseudo.or_else(|| pseudo_owner(doc, id));
            let display = style.as_ref().map(|s| s.clone_display()).unwrap_or_else(Display::inline);
            let in_flow = style.as_ref().map_or(true, |s| !s.clone_position().is_absolutely_positioned() && !s.clone_float().is_floating());
            match (display.outside(), display.inside()) {
                (DisplayOutside::None, DisplayInside::None) => {}
                (DisplayOutside::None, DisplayInside::Contents) => {
                    for c in node.children.iter().copied() {
                        rec(doc, sim, c, mode, case, pseudo);
                    }
                }
                (DisplayOutside::Inline, DisplayInside::Flow) => {
                    let tag = &*el.name.local;
                    if is_atomic_tag(tag) {
                        sim.inline_box(in_flow);
                    } else if tag == "br" {
                        sim.push(vec![('\n', Src::Br { node: id })], Mode::Preserve);
                    } else {
                        if let Some(b) = node.before() {
                            rec(doc, sim, b, mode, case, Some((id, false)));
                        }
                        for c in node.children.iter().copied() {
                            rec(doc, sim, c, mode, case, pseudo);
                        }
                        if let Some(a) = node.after() {
                            rec(doc, sim, a, mode, case, Some((id, true)));
                        }
                    }
                }
                _ => sim.inline_box(in_flow),
            }
        }
        NodeData::Text(t) => sim.push(text_pushes(doc, id, &t.content, mode == Mode::Collapse, case_in, pseudo), mode_in),
        _ => {}
    }
}

/// What construct.rs pushes for `root`, run through the parley model.
fn simulate(doc: &BaseDocument, root: NodeId) -> Option<Pushed> {
    let r = doc.get_node(root)?;
    let styles = r.primary_styles().or_else(|| r.parent.and_then(|p| doc.get_node(p)).and_then(|p| p.primary_styles()));
    let mode = styles.as_ref().map(|s| mode_of(s)).unwrap_or(Mode::Collapse);
    let case = styles.as_ref().map(|s| case_of(s)).unwrap_or(Case::None);
    let mut sim = Sim::new();
    if let Some(li) = r.element_data().and_then(|e| e.list_item_data.as_deref()) {
        if matches!(li.position, ListItemLayoutPosition::Inside) {
            let pseudo = Src::Gen { owner: root, after: false };
            let marker = match &li.marker {
                Marker::Char(c) => format!("{c} "),
                Marker::String(s) => s.to_string(),
            };
            sim.push(marker.chars().map(|ch| (ch, pseudo)).collect(), mode);
        }
    }
    let pseudo0 = pseudo_owner(doc, root);
    if let Some(b) = r.before() {
        rec(doc, &mut sim, b, mode, case, Some((root, false)));
    }
    for c in r.children.iter().copied() {
        rec(doc, &mut sim, c, mode, case, pseudo0);
    }
    if let Some(a) = r.after() {
        rec(doc, &mut sim, a, mode, case, Some((root, true)));
    }
    Some(sim.finish())
}

/// One laid-out char: its byte offset in `TextLayout.text` and where it came from.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Slot {
    pub byte: usize,
    pub ch: char,
    src: Src,
}

impl Slot {
    /// Generated content (marker, ::before, ::after): never copied.
    pub fn generated(&self) -> bool {
        matches!(self.src, Src::Gen { .. })
    }

    /// The DOM node whose text or element this char belongs to.
    pub fn dom_node(&self) -> NodeId {
        match self.src {
            Src::Text { node, .. } | Src::Br { node } => node,
            Src::Gen { owner, .. } => owner,
        }
    }
}

/// Every char of the root's layout text in order, each with its DOM source.
/// `None` when the replay does not reproduce the layout text exactly.
pub(crate) fn align(doc: &BaseDocument, root: NodeId) -> Option<Vec<Slot>> {
    let tl = doc.get_node(root)?.element_data()?.inline_layout_data.as_deref()?;
    align_with(simulate(doc, root)?, &tl.text)
}

fn align_with(pushed: Pushed, layout: &str) -> Option<Vec<Slot>> {
    let mut it = layout.char_indices();
    let mut slots = Vec::with_capacity(pushed.len());
    for (ch, src) in pushed {
        let (byte, got) = it.next()?;
        if got != ch {
            return None;
        }
        slots.push(Slot { byte, ch, src });
    }
    it.next().is_none().then_some(slots)
}

fn gen_point(doc: &BaseDocument, owner: NodeId, after: bool) -> DomPoint {
    let kids = doc.get_node(owner).map(|n| &n.children[..]).unwrap_or(&[]);
    match (after, kids.first(), kids.last()) {
        (false, Some(c), _) => DomPoint::Before { node: *c },
        (true, _, Some(c)) => DomPoint::After { node: *c },
        (false, None, _) => DomPoint::Before { node: owner },
        (true, _, None) => DomPoint::After { node: owner },
    }
}

fn start_of(doc: &BaseDocument, src: Src) -> DomPoint {
    match src {
        Src::Text { node, byte, .. } => DomPoint::Text { node, byte },
        Src::Gen { owner, after } => gen_point(doc, owner, after),
        Src::Br { node } => DomPoint::Before { node },
    }
}

fn end_of(doc: &BaseDocument, src: Src) -> DomPoint {
    match src {
        Src::Text { node, byte, len } => DomPoint::Text { node, byte: byte + len },
        Src::Gen { owner, after } => gen_point(doc, owner, after),
        Src::Br { node } => DomPoint::After { node },
    }
}

/// The whole root, as a point: `after` picks the edge after it, else the one
/// before it. Anonymous blocks and pseudo-elements are not in their parent's
/// child list, so they are addressed through what they hold or own.
fn whole_root(doc: &BaseDocument, root: NodeId, after: bool) -> DomPoint {
    if let Some((owner, owner_after)) = pseudo_owner(doc, root) {
        return gen_point(doc, owner, owner_after);
    }
    let Some(n) = doc.get_node(root) else { return DomPoint::Before { node: root } };
    if n.is_anonymous() {
        let c = if after { n.children.last() } else { n.children.first() };
        if let Some(c) = c {
            return if after { DomPoint::After { node: *c } } else { DomPoint::Before { node: *c } };
        }
    }
    if after {
        DomPoint::After { node: root }
    } else {
        DomPoint::Before { node: root }
    }
}

fn text_len(doc: &BaseDocument, root: NodeId) -> usize {
    doc.get_node(root).and_then(|n| n.element_data()).and_then(|d| d.inline_layout_data.as_deref()).map_or(0, |t| t.text.len())
}

/// The DOM point of the char starting at or after `layout_byte` of `root`'s
/// text: where a selection that starts there begins. Past the last char it is
/// just after it. Alignment failure: the whole root, so a start inside it
/// begins before it (unless it starts at its very end).
pub fn dom_point(doc: &BaseDocument, root: NodeId, layout_byte: usize) -> DomPoint {
    let Some(slots) = align(doc, root).filter(|s| !s.is_empty()) else {
        let len = text_len(doc, root);
        return whole_root(doc, root, len > 0 && layout_byte >= len);
    };
    match slots.get(slots.partition_point(|s| s.byte < layout_byte)) {
        Some(s) => start_of(doc, s.src),
        None => end_of(doc, slots[slots.len() - 1].src),
    }
}

/// The DOM point just after the char that ends before `layout_byte`: where a
/// selection that ends there stops. Taking the next char's start instead would
/// pull an empty `<a></a>` into the copy whenever the selection ends at the
/// edge of an inline element. Alignment failure: the whole root, so an end
/// inside it stops after it (unless it ends at its very start).
pub fn dom_end_point(doc: &BaseDocument, root: NodeId, layout_byte: usize) -> DomPoint {
    let Some(slots) = align(doc, root).filter(|s| !s.is_empty()) else { return whole_root(doc, root, layout_byte != 0) };
    match slots.partition_point(|s| s.byte < layout_byte).checked_sub(1) {
        Some(i) => end_of(doc, slots[i].src),
        None => start_of(doc, slots[0].src),
    }
}

/// Test hook: the alignment of `root` succeeds and covers every char once.
pub fn self_check(doc: &BaseDocument, root: NodeId) -> bool {
    align(doc, root).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serialize::{serialize, Endpoint};
    use crate::text::inline_roots;
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

    /// Break the layout text of `root` so the replay cannot match it.
    fn corrupt(d: &mut HtmlDocument, root: NodeId) {
        let tl = d.get_node_mut(root).unwrap().element_data_mut().unwrap().inline_layout_data.as_deref_mut().unwrap();
        tl.text.push('X');
    }

    #[test]
    fn layout_bytes_map_to_dom_bytes_through_collapsed_whitespace_and_inline_elements() {
        let d = doc("<p>a   lot\n of <b>bold</b>x</p>");
        let root = inline_roots(&d)[0];
        let p = d.get_node(root).unwrap();
        let (t0, b) = (p.children[0], p.children[1]);
        let t1 = d.get_node(b).unwrap().children[0];
        // layout text is "a lot of boldx"
        assert_eq!(dom_point(&d, root, 0), DomPoint::Text { node: t0, byte: 0 });
        assert_eq!(dom_point(&d, root, 2), DomPoint::Text { node: t0, byte: 4 }, "the l of lot, after three spaces");
        assert_eq!(dom_point(&d, root, 9), DomPoint::Text { node: t1, byte: 0 });
        assert_eq!(dom_end_point(&d, root, 13), DomPoint::Text { node: t1, byte: 4 }, "after the d, not before the x");
        assert!(matches!(dom_end_point(&d, root, 14), DomPoint::Text { byte: 1, .. }));
        assert!(matches!(dom_point(&d, root, 99), DomPoint::Text { byte: 1, .. }), "past the end is just after the last char");
    }

    #[test]
    fn a_mismatch_degrades_to_the_whole_root_and_copies_it_without_panicking() {
        let mut d = doc("<p>a   lot <b>bold</b></p><div>next</div>");
        let root = inline_roots(&d)[0];
        assert!(self_check(&d, root));
        corrupt(&mut d, root);
        assert!(!self_check(&d, root));
        assert_eq!(dom_point(&d, root, 0), DomPoint::Before { node: root });
        assert_eq!(dom_point(&d, root, 3), DomPoint::Before { node: root }, "a start inside the root takes all of it");
        assert_eq!(dom_point(&d, root, 99), DomPoint::After { node: root }, "a start at the end takes none of it");
        assert_eq!(dom_end_point(&d, root, 0), DomPoint::Before { node: root });
        assert_eq!(dom_end_point(&d, root, 3), DomPoint::After { node: root });
        let len = d.get_node(root).unwrap().element_data().unwrap().inline_layout_data.as_ref().unwrap().text.len();
        let e = |offset| Endpoint { node: root.as_u64(), offset };
        let out = serialize(&mut d, e(2), e(len));
        assert_eq!(out.html, "<p>a   lot <b>bold</b></p>", "element granularity: the whole root");
        assert_eq!(out.text, "a lot bold", "the DOM text of the whole root, not the layout text with its injected X");
    }

    #[test]
    fn a_mismatched_root_copies_no_noselect_or_generated_text_in_either_form() {
        let mut d = doc("<style>p::before{content:\"> \"}</style><p>Hi <span data-mv-noselect>mask</span> <b>x</b></p>");
        let root = inline_roots(&d)[0];
        corrupt(&mut d, root);
        let len = d.get_node(root).unwrap().element_data().unwrap().inline_layout_data.as_ref().unwrap().text.len();
        let e = |offset| Endpoint { node: root.as_u64(), offset };
        let out = serialize(&mut d, e(1), e(len));
        assert_eq!(out.text, "Hi x");
        assert_eq!(out.html, "<p>Hi  <b>x</b></p>");
    }

    #[test]
    fn a_mismatched_root_keeps_its_line_breaks_in_plain_text() {
        for (html, want) in [("<p>x<br>y</p>", "x\ny"), ("<p><br>x <br> y<br></p>", "\nx \ny\n")] {
            let mut d = doc(html);
            let root = inline_roots(&d)[0];
            corrupt(&mut d, root);
            let e = |offset| Endpoint { node: root.as_u64(), offset };
            let out = serialize(&mut d, e(0), e(3));
            assert_eq!(out.text, want, "{html}");
        }
    }

    #[test]
    fn a_mismatched_root_does_not_copy_a_nested_inline_root_twice() {
        let mut d = doc("<p>a <span style=\"display:inline-block\">box</span> z</p>");
        let roots = inline_roots(&d);
        assert_eq!(roots.len(), 2, "the p and the inline-block");
        corrupt(&mut d, roots[0]);
        let len = d.get_node(roots[1]).unwrap().element_data().unwrap().inline_layout_data.as_ref().unwrap().text.len();
        let out = serialize(&mut d, Endpoint { node: roots[0].as_u64(), offset: 1 }, Endpoint { node: roots[1].as_u64(), offset: len });
        // The degraded copy of the p holds the box's text where it stands (a
        // select-all ends in the nested root, the last one): once, in place.
        assert_eq!(out.text, "a box z", "{out:?}");
    }

    #[test]
    fn a_mismatched_anonymous_block_is_addressed_through_its_wrapped_children() {
        let mut d = doc("lead <b>bold</b><div>block</div>");
        let roots = inline_roots(&d);
        let anon = *roots.iter().find(|r| d.get_node(**r).unwrap().is_anonymous()).expect("an anonymous block root");
        let kids = d.get_node(anon).unwrap().children.clone();
        corrupt(&mut d, anon);
        assert_eq!(dom_point(&d, anon, 0), DomPoint::Before { node: kids[0] });
        assert_eq!(dom_point(&d, anon, 99), DomPoint::After { node: *kids.last().unwrap() });
        assert_eq!(dom_end_point(&d, anon, 1), DomPoint::After { node: *kids.last().unwrap() });
        let len = d.get_node(anon).unwrap().element_data().unwrap().inline_layout_data.as_ref().unwrap().text.len();
        let out = serialize(&mut d, Endpoint { node: anon.as_u64(), offset: 0 }, Endpoint { node: anon.as_u64(), offset: len });
        assert_eq!(out.html, "lead <b>bold</b>");
    }

    fn n(i: u64) -> NodeId {
        NodeId::from_u64(i)
    }
    fn text(s: &str) -> Pushed {
        s.char_indices().map(|(b, c)| (c, Src::Text { node: n(1), byte: b, len: c.len_utf8() })).collect()
    }
    fn s(p: &Pushed) -> String {
        p.iter().map(|(c, _)| *c).collect()
    }

    #[test]
    fn collapse_trims_the_edges_and_keeps_inner_single_spaces() {
        let mut sim = Sim::new();
        sim.push(text("  a \n\t b  "), Mode::Collapse);
        assert_eq!(s(&sim.finish()), "a b");
    }

    #[test]
    fn whitespace_collapses_across_pushes_into_one_space() {
        let mut sim = Sim::new();
        sim.push(text("a "), Mode::Collapse);
        sim.push(text(" b"), Mode::Collapse);
        sim.push(text(" c"), Mode::Collapse);
        assert_eq!(s(&sim.finish()), "a b c");
    }

    #[test]
    fn preserve_keeps_everything() {
        let mut sim = Sim::new();
        sim.push(text("  a \n b  "), Mode::Preserve);
        assert_eq!(s(&sim.finish()), "  a \n b  ");
    }

    #[test]
    fn pre_line_keeps_newlines_and_drops_the_spaces_around_them() {
        let mut sim = Sim::new();
        sim.push(text("  a \n  b  "), Mode::PreserveBreaks);
        assert_eq!(s(&sim.finish()), "a\nb");
    }

    #[test]
    fn a_preserved_break_drops_the_pending_space_before_it() {
        let mut sim = Sim::new();
        sim.push(text("a "), Mode::Collapse);
        sim.push(text("\n"), Mode::Preserve);
        sim.push(text(" b"), Mode::Collapse);
        assert_eq!(s(&sim.finish()), "a\nb");
    }

    #[test]
    fn parley_keeps_a_no_break_space_and_collapses_only_ascii_whitespace() {
        let mut sim = Sim::new();
        sim.push(text("\u{a0}a\u{a0}\u{a0}b"), Mode::Collapse);
        assert_eq!(s(&sim.finish()), "\u{a0}a\u{a0}\u{a0}b");
    }

    #[test]
    fn an_in_flow_inline_box_commits_the_space_before_it_and_keeps_the_one_after() {
        let mut sim = Sim::new();
        sim.push(text("a "), Mode::Collapse);
        sim.inline_box(true);
        sim.push(text(" b"), Mode::Collapse);
        assert_eq!(s(&sim.finish()), "a  b");
    }

    #[test]
    fn an_out_of_flow_box_leaves_the_space_pending() {
        let mut sim = Sim::new();
        sim.push(text("a "), Mode::Collapse);
        sim.inline_box(false);
        sim.push(text(" b"), Mode::Collapse);
        assert_eq!(s(&sim.finish()), "a b");
    }

    #[test]
    fn a_leading_space_after_an_in_flow_box_at_the_start_is_kept() {
        let mut sim = Sim::new();
        sim.inline_box(true);
        sim.push(text(" b"), Mode::Collapse);
        assert_eq!(s(&sim.finish()), " b");
    }

    #[test]
    fn case_mapping_attributes_every_result_char_to_its_dom_char() {
        let p = text_chars("stra\u{df}e", n(1), Case::Upper, None);
        assert_eq!(s(&p), "STRASSE");
        let srcs: Vec<usize> = p.iter().map(|(_, src)| match src { Src::Text { byte, .. } => *byte, _ => 99 }).collect();
        assert_eq!(srcs, vec![0, 1, 2, 3, 4, 4, 6]);
    }

    #[test]
    fn lowercase_uses_the_final_sigma_rule_like_str_to_lowercase() {
        let p = text_chars("\u{3a3}\u{3a3}", n(1), Case::Lower, None);
        assert_eq!(s(&p), "\u{3c3}\u{3c2}");
    }

    #[test]
    fn a_layout_that_differs_by_one_char_or_length_does_not_align() {
        assert!(align_with(text("ab"), "ab").is_some());
        assert!(align_with(text("ab"), "ac").is_none());
        assert!(align_with(text("ab"), "abc").is_none());
        assert!(align_with(text("abc"), "ab").is_none());
    }
}
