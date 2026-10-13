//! Laid-out text runs for the frontend's selection layer.
//!
//! Coordinates follow blitz-dom's own `inline_fragment_rects`
//! (document.rs:2219): an inline root's content-box origin plus parley's
//! line and glyph-run geometry, divided by the layout scale (parley lays out
//! in device px). `node` is the inline root; `start` is a UTF-8 byte offset
//! into its `TextLayout.text`, the same coordinates as blitz's own
//! `set_text_selection`.
use crate::TILE_CSS_HEIGHT;
use blitz_dom::{local_name, BaseDocument, LocalName, Node, NodeId};
use parley::PositionedLayoutItem;
use std::ops::Range;
use serde::Serialize;

pub const NOSELECT_ATTR: &str = "data-mv-noselect";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub text: String,
    pub font_px: f32,
    pub node: u64,
    pub start: usize,
}

/// Every visible inline root with a laid-out text layout, in layout tree
/// order (anonymous blocks included: they live in `layout_children`).
pub fn inline_roots(doc: &BaseDocument) -> Vec<NodeId> {
    let mut out = Vec::new();
    let mut stack = vec![doc.root_element().id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else { continue };
        // A closed fold (display:none) prunes its subtree: blitz may keep a
        // stale inline layout on nodes inside it, which must never be
        // selectable or copied.
        if node.primary_styles().is_some_and(|s| s.clone_display().is_none()) {
            continue;
        }
        if node.flags.is_inline_root() && node.element_data().and_then(|e| e.inline_layout_data.as_ref()).is_some() {
            out.push(id);
        }
        let kids: Vec<NodeId> = match node.layout_children.borrow().as_ref() {
            Some(c) => c.iter().copied().collect(),
            None => node.children.iter().copied().collect(),
        };
        stack.extend(kids.into_iter().rev());
    }
    out
}

/// Element `id` or an ancestor carries data-mv-noselect (fold toggles, privacy masks).
pub fn is_unselectable(doc: &BaseDocument, id: NodeId) -> bool {
    let attr = LocalName::from(NOSELECT_ATTR);
    let mut cur = Some(id);
    while let Some(n) = cur.and_then(|i| doc.get_node(i)) {
        if n.element_data().is_some_and(|e| e.attr(attr.clone()).is_some()) {
            return true;
        }
        cur = n.parent;
    }
    false
}

fn is_visibility_hidden(node: &Node) -> bool {
    node.primary_styles().is_some_and(|s| {
        s.clone_visibility() != style::computed_values::visibility::T::Visible
    })
}

/// Padding boxes of every ancestor (from `root` up) that clips overflow.
/// `overflow` on the root element, or on `body` when the root's is `visible`,
/// propagates to the viewport instead of clipping that element's content (mail
/// often sets `html,body{overflow-x:hidden}`), so those two are skipped.
fn clip_rects(doc: &BaseDocument, root: &Node) -> Vec<(f32, f32, f32, f32)> {
    use style::values::computed::Overflow;
    let clips = |s: &style::properties::ComputedValues| s.clone_overflow_x() != Overflow::Visible || s.clone_overflow_y() != Overflow::Visible;
    let root_el = doc.root_element();
    let root_clips = root_el.primary_styles().is_some_and(|s| clips(&s));
    let mut rects = Vec::new();
    let mut cur = Some(root.id);
    while let Some(n) = cur.and_then(|i| doc.get_node(i)) {
        let propagated = n.id == root_el.id || (!root_clips && n.parent == Some(root_el.id) && n.data.is_element_with_tag_name(&local_name!("body")));
        if n.is_element() && !propagated {
            if let Some(s) = n.primary_styles() {
                if clips(&s) {
                    let l = n.final_layout();
                    let p = n.absolute_position(0.0, 0.0);
                    rects.push((p.x + l.border.left, p.y + l.border.top,
                        l.size.width - l.border.left - l.border.right,
                        l.size.height - l.border.top - l.border.bottom));
                }
            }
        }
        cur = n.layout_parent.get().or(n.parent);
    }
    rects
}

fn intersects(r: &TextRun, (cx, cy, cw, ch): (f32, f32, f32, f32)) -> bool {
    r.x < cx + cw && r.x + r.w > cx && r.y < cy + ch && r.y + r.h > cy
}

/// The text of the glyph run that holds glyphs `first..first + count` of `run`
/// (glyph indices in visual order, as parley numbers them). A cluster belongs to
/// the glyph run holding its first glyph; a cluster without glyphs (a ligature
/// component) goes with the cluster visually before it. Parley pushes a
/// ligature's start, which holds all its glyphs, and then its components, and
/// reverses the whole list for RTL, so visual order has components after their
/// start in both directions.
fn glyph_run_text_range<B: parley::Brush>(run: &parley::Run<'_, B>, first: usize, count: usize) -> Option<Range<usize>> {
    let mut seen = 0;
    let mut owner = 0;
    let mut span: Option<Range<usize>> = None;
    for c in run.visual_clusters() {
        let glyphs = c.glyphs().count();
        if glyphs > 0 {
            owner = seen;
        }
        seen += glyphs;
        if (first..first + count).contains(&owner) {
            let text = c.text_range();
            span = Some(match span {
                Some(s) => s.start.min(text.start)..s.end.max(text.end),
                None => text,
            });
        }
    }
    span
}

fn root_runs(doc: &BaseDocument, root: &Node, out: &mut Vec<TextRun>) {
    let Some(tl) = root.element_data().and_then(|e| e.inline_layout_data.as_deref()) else { return };
    if is_unselectable(doc, root.id) {
        return;
    }
    let layout = &tl.layout;
    let scale = layout.scale();
    let fl = root.final_layout();
    let pos = root.absolute_position(0.0, 0.0);
    let ox = pos.x + fl.padding.left + fl.border.left;
    let oy = pos.y + fl.padding.top + fl.border.top;
    let clips = clip_rects(doc, root);

    // (run, kept?) in logical order; dropped runs stop gap-filling across them.
    let mut all: Vec<(TextRun, bool)> = Vec::new();
    for line in layout.lines() {
        let m = line.metrics();
        // parley splits one shaped run into a glyph run per style, so the run's
        // own text range covers several of them: track which glyphs of it the
        // previous glyph run consumed to find this one's share.
        let mut consumed: Option<(usize, usize)> = None; // (run index in line, glyphs used)
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(gr) = item else {
                consumed = None;
                continue;
            };
            let first = match consumed {
                Some((run, used)) if run == gr.run().index() => used,
                _ => 0,
            };
            let count = gr.glyphs().count();
            consumed = Some((gr.run().index(), first + count));
            let Some(range) = glyph_run_text_range(gr.run(), first, count) else { continue };
            let brush = gr.style().brush.id;
            let run = TextRun {
                x: ox + gr.offset() / scale,
                y: oy + m.block_min_coord / scale,
                w: gr.advance() / scale,
                h: (m.block_max_coord - m.block_min_coord) / scale,
                text: tl.text[range.clone()].to_string(),
                font_px: gr.run().font_size() / scale,
                node: root.id.as_u64(),
                start: range.start,
            };
            let keep = run.w > 0.01
                && run.font_px >= 0.5
                && !is_unselectable(doc, brush)
                && !doc.get_node(brush).is_some_and(is_visibility_hidden)
                && clips.iter().all(|c| intersects(&run, *c));
            all.push((run, keep));
        }
    }
    all.sort_by_key(|(r, _)| r.start);

    // Contiguity: whitespace between two KEPT, adjacent runs joins the earlier one.
    let mut kept: Vec<TextRun> = Vec::new();
    for i in 0..all.len() {
        if !all[i].1 {
            continue;
        }
        let mut run = all[i].0.clone();
        if let Some((next, true)) = all.get(i + 1) {
            let end = run.start + run.text.len();
            if next.start > end {
                let gap = &tl.text[end..next.start];
                if gap.chars().all(char::is_whitespace) {
                    run.text.push_str(gap);
                }
            }
        }
        kept.push(run);
    }
    out.extend(kept);
}

pub fn all_runs(doc: &BaseDocument) -> Vec<TextRun> {
    let mut out = Vec::new();
    for id in inline_roots(doc) {
        if let Some(root) = doc.get_node(id) {
            root_runs(doc, root, &mut out);
        }
    }
    out
}

/// The one tile a run belongs to: the tile holding its line's top.
pub fn tile_of(r: &TextRun) -> u32 {
    (r.y / TILE_CSS_HEIGHT as f32).floor().max(0.0) as u32
}
