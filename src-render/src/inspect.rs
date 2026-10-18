//! Per-element measurements for the parity harness (plan B). Every element
//! that carries `data-mv-id` is reported, with the fields the iframe side
//! reads through `getComputedStyle`. The frontend pre-pass stamps
//! `data-mv-id` only when the e2e harness sets `window.__MV_PARITY__`.
use blitz_dom::{BaseDocument, LocalName, NodeId, Point};
use parley::PositionedLayoutItem;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use style::color::{AbsoluteColor, ColorSpace};
use style::values::specified::box_::{DisplayInside, DisplayOutside};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InspectRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedElement {
    pub mv_id: String,
    pub tag: String,
    pub rendered: bool,
    pub rect: Option<InspectRect>,
    pub color: Option<[f64; 4]>,
    pub background_color: Option<[f64; 4]>,
    pub border_top_color: Option<[f64; 4]>,
    pub border_right_color: Option<[f64; 4]>,
    pub border_bottom_color: Option<[f64; 4]>,
    pub border_left_color: Option<[f64; 4]>,
    /// Used border widths in CSS px (0 under `border-style: none`), as
    /// `getComputedStyle(el).borderTopWidth` reports them.
    pub border_top_width: Option<f64>,
    pub border_right_width: Option<f64>,
    pub border_bottom_width: Option<f64>,
    pub border_left_width: Option<f64>,
    pub font_size: Option<f64>,
    pub font_weight: Option<f64>,
    pub font_family: Option<String>,
    pub line_count: Option<u32>,
}

/// sRGB bytes the way WebKit's `getComputedStyle` reports a legacy colour:
/// 8-bit channels and an alpha in thousandths.
fn rgba(c: &AbsoluteColor) -> [f64; 4] {
    let [r, g, b, a] = *c.to_color_space(ColorSpace::Srgb).raw_components();
    let byte = |v: f32| ((v as f64).clamp(0.0, 1.0) * 255.0 + 0.5).floor();
    [byte(r), byte(g), byte(b), ((a as f64).clamp(0.0, 1.0) * 1000.0).round() / 1000.0]
}

fn is_rendered(doc: &BaseDocument, id: NodeId) -> bool {
    let mut cur = Some(id);
    while let Some(n) = cur.and_then(|i| doc.get_node(i)) {
        if n.is_element() {
            match n.primary_styles() {
                Some(s) if !s.get_box().display.is_none() => {}
                _ => return false,
            }
        }
        cur = n.parent;
    }
    true
}

fn is_descendant_or_self(doc: &BaseDocument, mut id: NodeId, ancestor: NodeId) -> bool {
    loop {
        if id == ancestor {
            return true;
        }
        match doc.get_node(id).and_then(|n| n.parent) {
            Some(p) => id = p,
            None => return false,
        }
    }
}

/// The text-side facts `measure` needs for every element, gathered in one pass over the
/// document: a mail near MAX_NODES with every element marked (the harness) must not walk
/// all nodes and runs once per element.
struct TextIndex {
    /// Pre-order position range `[start, end)` of each DOM node's subtree.
    range: HashMap<NodeId, (usize, usize)>,
    /// One per glyph run that counts (see `collect_spans`): (pre-order position of the run's
    /// node, top, bottom), sorted by position, so a subtree's runs are one slice.
    spans: Vec<(usize, f64, f64)>,
    /// Nodes with non-whitespace text in their subtree.
    visible: HashSet<NodeId>,
}

impl TextIndex {
    fn new(doc: &BaseDocument) -> Self {
        let mut range = HashMap::new();
        let mut visible = HashSet::new();
        let mut pos = 0usize;
        // (node, children done?): enter assigns the start, exit the end.
        let mut stack = vec![(doc.root_node().id, false)];
        while let Some((id, done)) = stack.pop() {
            let Some(n) = doc.get_node(id) else { continue };
            if done {
                if let Some(r) = range.get_mut(&id) {
                    let r: &mut (usize, usize) = r;
                    r.1 = pos;
                }
                continue;
            }
            range.insert(id, (pos, pos));
            pos += 1;
            if n.text_data().is_some_and(|t| !t.content.trim().is_empty()) {
                let mut cur = Some(id);
                while let Some(c) = cur {
                    if !visible.insert(c) {
                        break;
                    }
                    cur = doc.get_node(c).and_then(|n| n.parent);
                }
            }
            stack.push((id, true));
            stack.extend(n.children.iter().rev().map(|c| (*c, false)));
        }
        let mut index = TextIndex { range, spans: Vec::new(), visible };
        index.spans = index.collect_spans(doc);
        index.spans.sort_by_key(|s| s.0);
        index
    }

    /// The pre-order position of `id`, or of its nearest ancestor in the DOM walk (a run
    /// can be styled by a node that is not in its parent's child list).
    fn position(&self, doc: &BaseDocument, mut id: NodeId) -> Option<usize> {
        loop {
            if let Some(r) = self.range.get(&id) {
                return Some(r.0);
            }
            id = doc.get_node(id)?.parent?;
        }
    }

    /// Absolute vertical spans of every text fragment (glyph run): what the iframe side
    /// gets from `Range.getClientRects`. Looks in every inline root: an inline that follows
    /// a block sibling lives in an anonymous inline root that is not a DOM ancestor or
    /// descendant of it, and the run's brush id says which element a run belongs to anyway.
    /// (Same origin maths as blitz-dom's `inline_fragment_rects`.)
    fn collect_spans(&self, doc: &BaseDocument) -> Vec<(usize, f64, f64)> {
        let mut spans = Vec::new();
        for (_, root) in doc.tree().iter() {
            let Some(inline) = root.element_data().and_then(|e| e.inline_layout_data.as_ref()) else { continue };
            let layout = &inline.layout;
            let scale = layout.scale() as f64;
            let fl = root.final_layout();
            // The line boxes start `block_offset` below the content box (a cell's
            // vertical-align, `align-content`).
            let origin_y = root.absolute_position(0.0, 0.0).y as f64 + (fl.padding.top + fl.border.top + inline.block_offset) as f64;
            for line in layout.lines() {
                for item in line.items() {
                    if let PositionedLayoutItem::GlyphRun(run) = item {
                        // The harness skips whitespace-only text nodes and rects without height
                        // (cerberus sets `font-size: 0` on the cell holding its columns). A no-break
                        // space blitz-dom keeps from collapsing is wrapped in word joiners: JS `trim`
                        // sees the bare nbsp (whitespace) in the iframe's text node.
                        let text = inline.text.get(run.run().text_range()).unwrap_or("");
                        if text.chars().all(|c| c.is_whitespace() || c == '\u{2060}') {
                            continue;
                        }
                        let Some(at) = self.position(doc, run.style().brush.id) else { continue };
                        // A text fragment's rect, as `Range.getClientRects` gives it: the
                        // rounded ascent and descent around the baseline, not the line box.
                        let m = run.run().font_metrics();
                        let (top, bottom) = ((run.baseline() - m.ascent.round()) as f64, (run.baseline() + m.descent.round()) as f64);
                        if bottom > top {
                            spans.push((at, origin_y + top / scale, origin_y + bottom / scale));
                        }
                    }
                }
            }
        }
        spans
    }

    fn has_visible_text(&self, id: NodeId) -> bool {
        self.visible.contains(&id)
    }

    /// The spans of `el`'s own and descendant text.
    fn line_spans(&self, el: NodeId) -> Vec<(f64, f64)> {
        let Some(&(start, end)) = self.range.get(&el) else { return Vec::new() };
        let lo = self.spans.partition_point(|s| s.0 < start);
        let hi = self.spans.partition_point(|s| s.0 < end);
        self.spans[lo..hi].iter().map(|s| (s.1, s.2)).collect()
    }
}

pub fn cluster_line_count(mut spans: Vec<(f64, f64)>) -> u32 {
    spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut count = 0;
    let mut cur: Option<(f64, f64)> = None;
    for (top, bottom) in spans {
        let mid = (top + bottom) / 2.0;
        match cur {
            Some((ct, cb)) if mid >= ct && mid <= cb => cur = Some((ct, cb.max(bottom))),
            _ => {
                count += 1;
                cur = Some((top, bottom));
            }
        }
    }
    count
}

/// A table row or row group (tr, tbody, thead, tfoot; by display, as mail
/// restyles tags). Blitz lays the cells out but gives these boxes no layout of
/// their own: their rect stays 0x0 at the origin.
fn is_table_row_box(node: &blitz_dom::Node) -> bool {
    node.primary_styles().map_or(false, |s| {
        matches!(
            s.clone_display().inside(),
            DisplayInside::TableRow | DisplayInside::TableRowGroup | DisplayInside::TableHeaderGroup | DisplayInside::TableFooterGroup
        )
    })
}

/// The union of the rects of an element's rendered children: what WebKit
/// reports for a row (its cells) or a row group (its rows).
fn children_union(doc: &BaseDocument, node: &blitz_dom::Node) -> Option<InspectRect> {
    let mut acc: Option<(f64, f64, f64, f64)> = None;
    for child in node.children.iter().filter(|c| doc.get_node(**c).map_or(false, |n| n.is_element())).filter_map(|c| element_rect(doc, *c)) {
        if child.w == 0.0 && child.h == 0.0 {
            continue;
        }
        acc = Some(match acc {
            Some((x0, y0, x1, y1)) => (x0.min(child.x), y0.min(child.y), x1.max(child.x + child.w), y1.max(child.y + child.h)),
            None => (child.x, child.y, child.x + child.w, child.y + child.h),
        });
    }
    acc.map(|(x0, y0, x1, y1)| InspectRect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

/// In the separated borders model WebKit's box for a row spans the table's whole content
/// box, border-spacing included (a default table, `border-spacing: 2px`: `tr` and `tbody`
/// start at the content edge, the cells 2px in), and a row group also takes the spacing above
/// its first and below its last row. `rect` is the union of the cells (rows) or rows (groups).
fn over_border_spacing(doc: &BaseDocument, node: &blitz_dom::Node, rect: InspectRect) -> InspectRect {
    use style::computed_values::border_collapse::T as BorderCollapse;
    use style::values::computed::CSSPixelLength;
    let mut cur = node.parent;
    while let Some(table) = cur.and_then(|id| doc.get_node(id)) {
        if let Some(s) = table.primary_styles() {
            if s.clone_display().inside() == DisplayInside::Table {
                if s.clone_border_collapse() == BorderCollapse::Collapse {
                    return rect;
                }
                let spacing = s.clone_border_spacing().0;
                let (sx, sy) = (spacing.width.px() as f64, spacing.height.px() as f64);
                if sx == 0.0 && sy == 0.0 {
                    return rect;
                }
                let Some(outer) = element_rect(doc, table.id) else { return rect };
                let border = s.get_border();
                let used = |w: &style::values::computed::BorderSideWidth, st: style::values::computed::BorderStyle| {
                    if st.none_or_hidden() { 0.0 } else { w.0.to_f64_px() }
                };
                let pad = s.get_padding();
                let basis = CSSPixelLength::new(outer.w as f32);
                let left = used(&border.border_left_width, border.border_left_style) + pad.padding_left.0.resolve(basis).px() as f64;
                let right = used(&border.border_right_width, border.border_right_style) + pad.padding_right.0.resolve(basis).px() as f64;
                return if node.primary_styles().map_or(false, |n| n.clone_display().inside() == DisplayInside::TableRow) {
                    InspectRect { x: outer.x + left, w: outer.w - left - right, ..rect }
                } else {
                    InspectRect { y: rect.y - sy, h: rect.h + 2.0 * sy, ..rect }
                };
            }
        }
        cur = table.parent;
    }
    rect
}

/// The rect WebKit's `getBoundingClientRect` reports. A non-atomic inline has
/// no box of its own. WebKit unions its fragments' content areas (font
/// ascent + descent, which line-height does not change); blitz-dom's
/// `get_client_bounding_rect` unions whole line boxes, which under the base
/// template's `line-height: 1.6` is ~5 px taller on every link and span. So
/// the inline case is built from glyph runs. An inline with no text (an empty
/// `<a name>`) gets None here and a zero-width rect in WebKit; the comparator
/// treats that pair as equal (Task 5).
fn element_rect(doc: &BaseDocument, id: NodeId) -> Option<InspectRect> {
    let node = doc.get_node(id)?;
    let is_inline = node.is_element()
        && !node.flags.is_inline_root()
        && node.primary_styles().map_or(false, |s| {
            let d = s.clone_display();
            d.outside() == DisplayOutside::Inline && d.inside() == DisplayInside::Flow
        });
    if !is_inline {
        let own = doc.get_client_bounding_rect(id).map(|r| InspectRect { x: r.x, y: r.y, w: r.width, h: r.height });
        if own.as_ref().map_or(true, |r| r.w == 0.0 && r.h == 0.0) && is_table_row_box(node) {
            return match children_union(doc, node) {
                Some(rect) => Some(over_border_spacing(doc, node, rect)),
                None => own,
            };
        }
        return own;
    }
    let root = node.inline_root_ancestor()?;
    let inline = root.element_data()?.inline_layout_data.as_ref()?;
    let layout = &inline.layout;
    // The correction blitz-dom makes to the height an image reserves in a line with no
    // text (WebKit's strut, `TextLayout::strut_adjust`) is not part of the image's box.
    let strut = inline.strut_adjust as f64;
    let scale = layout.scale() as f64;
    let fl = root.final_layout();
    let pos = root.absolute_position(0.0, 0.0);
    let ox = pos.x as f64 + (fl.padding.left + fl.border.left) as f64;
    let oy = pos.y as f64 + (fl.padding.top + fl.border.top + inline.block_offset) as f64;
    // One box per line the element has fragments on.
    let mut fragments: Vec<(f64, f64, f64, f64)> = Vec::new();
    for line in layout.lines() {
        let mut acc: Option<(f64, f64, f64, f64)> = None;
        let mut add = |x0: f64, y0: f64, x1: f64, y1: f64| {
            acc = Some(match acc {
                Some((a, b, c, d)) => (a.min(x0), b.min(y0), c.max(x1), d.max(y1)),
                None => (x0, y0, x1, y1),
            });
        };
        let items: Vec<_> = line.items().collect();
        let last = items.len().wrapping_sub(1);
        for (i, item) in items.into_iter().enumerate() {
            match item {
                PositionedLayoutItem::GlyphRun(run) if is_descendant_or_self(doc, run.style().brush.id, id) => {
                    // WebKit's content area is the rounded ascent plus the rounded descent.
                    let m = run.run().font_metrics();
                    let x0 = run.offset() as f64;
                    // The collapsible space a line wraps at hangs past its end and is no part of
                    // the text fragment's rect (the run's advance includes it).
                    let hang = if i == last { line.metrics().hanging_advance as f64 } else { 0.0 };
                    add(x0, (run.baseline() - m.ascent.round()) as f64, x0 + run.advance() as f64 - hang, (run.baseline() + m.descent.round()) as f64);
                }
                PositionedLayoutItem::InlineBox(b) if is_descendant_or_self(doc, NodeId::from_u64(b.id), id) => {
                    add(b.x as f64, b.y as f64, (b.x + b.width) as f64, (b.y + b.height) as f64 - strut);
                }
                _ => {}
            }
        }
        fragments.extend(acc);
    }
    // The element's own padding and border belong to its box: the first fragment starts
    // and the last ends with them, and each fragment's box is taller by the vertical ones
    // (a `<code>` with `padding: 1px 4px` is 8px wider and 2px taller than its text).
    if let Some(s) = node.primary_styles() {
        let used = |w: &style::values::computed::BorderSideWidth, st: style::values::computed::BorderStyle| {
            if st.none_or_hidden() { 0.0 } else { w.0.to_f64_px() }
        };
        let pad = s.get_padding();
        let border = s.get_border();
        let basis = style::values::computed::CSSPixelLength::new(0.0);
        let edge = |p: &style::values::computed::LengthPercentage, w: f64| (p.resolve(basis).px() as f64 + w) * scale;
        let left = edge(&pad.padding_left.0, used(&border.border_left_width, border.border_left_style));
        let right = edge(&pad.padding_right.0, used(&border.border_right_width, border.border_right_style));
        let top = edge(&pad.padding_top.0, used(&border.border_top_width, border.border_top_style));
        let bottom = edge(&pad.padding_bottom.0, used(&border.border_bottom_width, border.border_bottom_style));
        if let Some(first) = fragments.first_mut() {
            first.0 -= left;
        }
        if let Some(last) = fragments.last_mut() {
            last.2 += right;
        }
        for f in fragments.iter_mut() {
            f.1 -= top;
            f.3 += bottom;
        }
    }
    let (x0, y0, x1, y1) = fragments.into_iter().reduce(|(a, b, c, d), (x0, y0, x1, y1)| (a.min(x0), b.min(y0), c.max(x1), d.max(y1)))?;
    Some(InspectRect { x: ox + x0 / scale, y: oy + y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale })
}

fn measure(doc: &BaseDocument, text: &TextIndex, id: NodeId, mv_id: String) -> InspectedElement {
    let node = doc.get_node(id).expect("walked id");
    let tag = node.element_data().map(|e| e.name.local.to_string()).unwrap_or_default();
    let rendered = is_rendered(doc, id);
    let mut out = InspectedElement {
        mv_id,
        tag,
        rendered,
        rect: None,
        color: None,
        background_color: None,
        border_top_color: None,
        border_right_color: None,
        border_bottom_color: None,
        border_left_color: None,
        border_top_width: None,
        border_right_width: None,
        border_bottom_width: None,
        border_left_width: None,
        font_size: None,
        font_weight: None,
        font_family: None,
        line_count: None,
    };
    if !rendered {
        return out;
    }
    if let Some(s) = node.primary_styles() {
        let current = s.clone_color();
        out.color = Some(rgba(&current));
        out.background_color = Some(rgba(&s.clone_background_color().resolve_to_absolute(&current)));
        out.border_top_color = Some(rgba(&s.clone_border_top_color().resolve_to_absolute(&current)));
        out.border_right_color = Some(rgba(&s.clone_border_right_color().resolve_to_absolute(&current)));
        out.border_bottom_color = Some(rgba(&s.clone_border_bottom_color().resolve_to_absolute(&current)));
        out.border_left_color = Some(rgba(&s.clone_border_left_color().resolve_to_absolute(&current)));
        let border = s.get_border();
        // Computed width stays set under `border-style: none`; the used width
        // (what layout and getComputedStyle see) is 0 there.
        let used = |w: &style::values::computed::BorderSideWidth, st: style::values::computed::BorderStyle| {
            Some(if st.none_or_hidden() { 0.0 } else { w.0.to_f64_px() })
        };
        out.border_top_width = used(&border.border_top_width, border.border_top_style);
        out.border_right_width = used(&border.border_right_width, border.border_right_style);
        out.border_bottom_width = used(&border.border_bottom_width, border.border_bottom_style);
        out.border_left_width = used(&border.border_left_width, border.border_left_style);
        let font = s.get_font();
        out.font_size = Some(font.font_size.used_size.0.px() as f64);
        out.font_weight = Some(font.font_weight.value() as f64);
        out.font_family = Some(style_traits::ToCss::to_css_string(&font.font_family));
    }
    out.rect = element_rect(doc, id);
    if text.has_visible_text(id) {
        let spans = text.line_spans(id);
        out.line_count = (!spans.is_empty()).then(|| cluster_line_count(spans));
    }
    out
}

/// Every `[data-mv-id]` element, in tree order.
pub fn collect(doc: &BaseDocument) -> Vec<InspectedElement> {
    let attr = LocalName::from("data-mv-id");
    let text = TextIndex::new(doc);
    let mut out = Vec::new();
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else { continue };
        if let Some(mv) = node.attr(attr.clone()) {
            out.push(measure(doc, &text, id, mv.to_string()));
        }
        stack.extend(node.children.iter().rev().copied());
    }
    out
}

/// Reset the viewport scroll that `tile_png` moves, so rects are in document
/// coordinates.
pub(crate) fn reset_scroll(doc: &mut BaseDocument) {
    doc.set_viewport_scroll(Point { x: 0.0, y: 0.0 });
}
