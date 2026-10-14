use blitz_traits::node_id::NodeId;
use std::{ops::Range, sync::Arc};

use atomic_refcell::AtomicRefCell;
use markup5ever::local_name;
use style::properties::style_structs::Border;
use style::servo_arc::Arc as ServoArc;
use style::values::specified::box_::{DisplayInside, DisplayOutside};
use style::{
    Atom, computed_values::border_collapse::T as BorderCollapse,
    computed_values::table_layout::T as TableLayout,
};
use taffy::{
    DetailedGridInfo, LayoutPartialTree as _, ResolveOrZero, TrackSizingFunction, style_helpers,
};

use crate::BaseDocument;

use super::damage::{CONSTRUCT_BOX, CONSTRUCT_DESCENDENT, CONSTRUCT_FC};
use super::resolve_calc_value;

pub struct TableTreeWrapper<'doc> {
    pub(crate) doc: &'doc mut BaseDocument,
    pub(crate) ctx: Arc<TableContext>,
    // MailVault parity fix (plan B): (cell index, px) a text-only cell's content was
    // pushed down by vertical-align. Taffy writes the cell's final layout right
    // after laying it out, so the shift is added to that layout's padding-top in
    // `set_unrounded_layout` (paint and inspect start the text at padding + border).
    pub(crate) pending_inline_shift: Option<(usize, f32)>,
    // MailVault parity fix (plan B): the table style with the column widths
    // `webkit_column_widths` chose, used for the second layout pass.
    pub(crate) style_override: Option<taffy::Style<Atom>>,
}

// MailVault parity fix (plan B): how far down the spare room of a table cell its
// content sits (CSS 2 `vertical-align` on a cell): 0 top/baseline, 0.5 middle, 1 bottom.
// In stylo `vertical-align` is a shorthand: middle is `alignment-baseline`, top,
// center and bottom are `baseline-shift` keywords. Baseline alignment across a row
// is not implemented; it is laid out as top.
fn cell_vertical_align_factor(node: &crate::node::Node) -> f32 {
    use style::values::computed::{AlignmentBaseline, BaselineShift};
    use style::values::generics::box_::BaselineShiftKeyword;
    let Some(style) = node.primary_styles() else {
        return 0.0;
    };
    match style.clone_baseline_shift() {
        BaselineShift::Keyword(BaselineShiftKeyword::Bottom) => 1.0,
        BaselineShift::Keyword(BaselineShiftKeyword::Center) => 0.5,
        BaselineShift::Keyword(_) => 0.0,
        BaselineShift::Length(_) => match style.clone_alignment_baseline() {
            AlignmentBaseline::Middle => 0.5,
            _ => 0.0,
        },
    }
}

#[derive(Debug, Clone)]
pub struct TableContext {
    pub style: taffy::Style<Atom>,
    // MailVault parity fix (plan B): the preferred (specified) width of each column, from
    // the first row, in auto layout. See `TableTreeWrapper::webkit_column_widths`.
    pub column_prefs: Vec<Option<f32>>,
    pub cells: Vec<TableCell>,
    pub rows: Vec<TableRow>,
    pub computed_grid_info: AtomicRefCell<Option<DetailedGridInfo<Atom>>>,
    pub border_style: Option<ServoArc<Border>>,
    pub border_collapse: BorderCollapse,
    // MailVault parity fix (plan B): `table-layout: fixed`.
    pub is_fixed: bool,
}

// #[derive(Debug, Clone, Eq, PartialEq)]
// pub enum TableItemKind {
//     Row,
//     Cell,
// }

#[derive(Debug, Clone)]
pub struct TableCell {
    // kind: TableItemKind,
    node_id: NodeId,
    style: taffy::Style<Atom>,
    // MailVault parity fix (plan B): the column the cell starts in and its spans.
    col: u16,
    colspan: u16,
    rowspan: u16,
}

/// A column's track sizing function and, in auto layout, its specified width.
type ColumnDef = (TrackSizingFunction, Option<f32>);

#[derive(Debug, Clone)]
pub struct TableRow {
    // kind: TableItemKind,
    pub node_id: NodeId,
    pub height: f32,
}

pub(crate) fn build_table_context(
    doc: &mut BaseDocument,
    table_root_node_id: NodeId,
) -> (TableContext, Vec<NodeId>, Vec<NodeId>) {
    // MailVault parity fix (plan B): the anonymous table cells made for non-cell row children.
    let mut anonymous_cells: Vec<NodeId> = Vec::new();
    let mut cells: Vec<TableCell> = Vec::new();
    let mut rows: Vec<TableRow> = Vec::new();
    let mut row = 0u16;
    let mut col = 0u16;

    let root_node = &mut doc.nodes[table_root_node_id];

    let children = std::mem::take(&mut root_node.children);

    let Some(stylo_styles) = root_node.primary_styles() else {
        panic!("Ignoring table because it has no styles");
    };

    let mut style = stylo_taffy::to_taffy_style(&stylo_styles);
    style.item_is_table = true;
    // Use `dense` row-flow so that each cell scans the row from its
    // leftmost column for the first free track. Without `dense`,
    // `place_definite_secondary_axis_item` keeps a per-item secondary
    // cursor across rows, which means cells in later rows do not
    // backfill columns freed up by rowspan cells from earlier rows.
    style.grid_auto_flow = taffy::GridAutoFlow::RowDense;
    style.grid_auto_columns = Vec::new();
    style.grid_auto_rows = Vec::new();

    let is_fixed = match stylo_styles.clone_table_layout() {
        TableLayout::Fixed => true,
        TableLayout::Auto => false,
    };

    let border_collapse = stylo_styles.clone_border_collapse();
    let border_spacing = stylo_styles.clone_border_spacing().0;

    drop(stylo_styles);

    let mut column_sizes: Vec<ColumnDef> = Vec::new();
    let mut first_cell_border: Option<ServoArc<Border>> = None;
    for child_id in children.iter().copied() {
        collect_table_cells(
            doc,
            child_id,
            is_fixed,
            border_collapse,
            &mut row,
            &mut col,
            &mut cells,
            &mut rows,
            &mut column_sizes,
            &mut first_cell_border,
            &mut anonymous_cells,
        );
    }
    column_sizes.resize(col as usize, (style_helpers::auto(), None));

    let column_prefs: Vec<Option<f32>> = column_sizes.iter().map(|(_, pref)| *pref).collect();
    style.grid_template_columns = column_sizes.into_iter().map(|(dim, _)| dim.into()).collect();
    style.grid_template_rows = (0..row as usize)
        .map(|i| match rows.get(i) {
            // MailVault parity fix (plan B): see `TableRow::height`.
            Some(r) if r.height > 0.0 => {
                let track: TrackSizingFunction =
                    style_helpers::minmax(style_helpers::length(r.height), style_helpers::auto());
                track.into()
            }
            _ => {
                let track: TrackSizingFunction = style_helpers::auto();
                track.into()
            }
        })
        .collect();

    style.gap = match border_collapse {
        BorderCollapse::Separate => {
            // In the separated borders model, `border-spacing` also applies between
            // the table border and the outermost cells, in addition to between cells.
            let spacing_x = border_spacing.width.px();
            let spacing_y = border_spacing.height.px();
            let padding = style.padding.resolve_or_zero(None, resolve_calc_value);
            style.padding = taffy::Rect {
                left: style_helpers::length(padding.left + spacing_x),
                right: style_helpers::length(padding.right + spacing_x),
                top: style_helpers::length(padding.top + spacing_y),
                bottom: style_helpers::length(padding.bottom + spacing_y),
            };
            taffy::Size {
                width: style_helpers::length(spacing_x),
                height: style_helpers::length(spacing_y),
            }
        }
        BorderCollapse::Collapse => first_cell_border
            .as_ref()
            .map(|border| {
                // MailVault parity fix (plan B): a side with border-style none/hidden has a
                // used width of 0 (CSS Backgrounds 3, 4.3), but its computed width is still
                // `medium` (3px); using that put every borderless collapsed table 3px inset.
                let used = |width: &style::values::computed::BorderSideWidth,
                            style: style::values::specified::BorderStyle| {
                    if style.none_or_hidden() {
                        0.0
                    } else {
                        width.0.to_f32_px()
                    }
                };
                let x = used(&border.border_left_width, border.border_left_style)
                    .max(used(&border.border_right_width, border.border_right_style));
                let y = used(&border.border_top_width, border.border_top_style)
                    .max(used(&border.border_bottom_width, border.border_bottom_style));
                taffy::Size {
                    width: style_helpers::length(x),
                    height: style_helpers::length(y),
                }
            })
            .unwrap_or(taffy::Size::ZERO.map(style_helpers::length)),
    };

    if border_collapse == BorderCollapse::Collapse {
        style.border = taffy::Rect {
            left: style.gap.width,
            right: style.gap.width,
            top: style.gap.height,
            bottom: style.gap.height,
        };
    }

    let layout_children = cells.iter().map(|cell| cell.node_id).collect();
    let root_node = &mut doc.nodes[table_root_node_id];
    root_node.children = children;

    (
        TableContext {
            style,
            column_prefs,
            cells,
            rows,
            computed_grid_info: AtomicRefCell::new(None),
            border_collapse,
            border_style: first_cell_border,
            is_fixed,
        },
        layout_children,
        anonymous_cells,
    )
}

/// Register `node_id` as the next cell of the current row.
#[allow(clippy::too_many_arguments)]
fn push_table_cell(
    doc: &mut BaseDocument,
    node_id: NodeId,
    is_fixed: bool,
    border_collapse: BorderCollapse,
    row: &mut u16,
    col: &mut u16,
    cells: &mut Vec<TableCell>,
    columns: &mut Vec<ColumnDef>,
    first_cell_border: &mut Option<ServoArc<Border>>,
) {
    let node = &doc.nodes[node_id];
    let stylo_style = &node.primary_styles().unwrap();
    let colspan: u16 = node
        .attr(local_name!("colspan"))
        .and_then(|val| val.parse().ok())
        .unwrap_or(1);
    let rowspan: u16 = node
        .attr(local_name!("rowspan"))
        .and_then(|val| val.parse::<u16>().ok())
        .map(|v| v.clamp(1, 65534))
        .unwrap_or(1);
    let mut style = stylo_taffy::to_taffy_style(stylo_style);

    if first_cell_border.is_none() {
        *first_cell_border = Some(stylo_style.clone_border());
    }

    if *row == 1 {
        let column = match style.size.width.tag() {
            taffy::CompactLength::LENGTH_TAG => {
                let len = style.size.width.value();
                let padding = style.padding.resolve_or_zero(None, resolve_calc_value);
                let border = style.border.resolve_or_zero(None, resolve_calc_value);
                let width = match style.box_sizing {
                    taffy::BoxSizing::ContentBox => {
                        len + padding.left + padding.right + border.left + border.right
                    }
                    taffy::BoxSizing::BorderBox => len,
                };
                if is_fixed {
                    (style_helpers::length(width), None)
                } else {
                    // MailVault parity fix (plan B): in auto table layout a specified
                    // width is the column's preferred width, not a fixed one (CSS 2
                    // 17.5.2.2): the column is at least its content's minimum and
                    // shrinks towards it when the table is narrower than its columns.
                    (
                        style_helpers::minmax(style_helpers::auto(), style_helpers::length(width)),
                        Some(width),
                    )
                }
            }
            taffy::CompactLength::PERCENT_TAG => {
                if is_fixed {
                    (style_helpers::percent(style.size.width.value()), None)
                } else {
                    (style_helpers::auto(), None)
                }
            }
            taffy::CompactLength::AUTO_TAG => (style_helpers::auto(), None),
            // Dimension values are always length, percentage, auto or calc(),
            // so any other tag is a calc() value. Pass it through so that
            // Taffy resolves it against the table's inner width.
            _ => (style.size.width.into(), None),
        };
        columns.push(column);
    }

    // Zero-out cell borders is BorderCollapse is Collapse
    // Borders are handled at the table level in this mode
    if border_collapse == BorderCollapse::Collapse {
        style.border = taffy::Rect::ZERO.map(style_helpers::length);
    }

    // The margin properties do not apply to table-internal elements
    style.margin = taffy::Rect::ZERO.map(style_helpers::length);

    // MailVault parity fix (plan B): a cell's `height` is a minimum (CSS 2 17.5.3): the
    // cell fills its row. Taffy does not stretch an item with a definite height, so
    // the grid sees it as a min-height instead. The cell's own style still has the
    // height, which is what its content contribution to the row is measured with.
    if style.size.height.tag() == taffy::CompactLength::LENGTH_TAG {
        style.min_size.height = style_helpers::length(style.size.height.value());
        style.size.height = style_helpers::auto();
    }

    // Let Taffy auto-place the column. Combined with
    // `grid_auto_flow: RowDense` set on the table root, each cell
    // scans from the first track in its row for a free position,
    // which makes cells automatically skip columns occupied by
    // rowspan cells from earlier rows.
    style.grid_column = taffy::Line {
        start: style_helpers::auto(),
        end: style_helpers::span(colspan),
    };
    style.grid_row = taffy::Line {
        start: style_helpers::line(*row as i16),
        end: style_helpers::span(rowspan),
    };
    style.size.width = style_helpers::auto();
    cells.push(TableCell {
        node_id,
        style,
        col: *col,
        colspan,
        rowspan,
    });

    *col += colspan;
}

/// Whether a child of a table row belongs in the row's anonymous cell: a
/// non-whitespace text node, or an element whose box is not a table-internal one
/// (a `display:block` or `inline-block` `th`, say). Whitespace text only joins a
/// cell that is already open. Captions and `display:none` stay out.
fn is_row_content_to_wrap(doc: &BaseDocument, child_id: NodeId, cell_open: bool) -> bool {
    let node = &doc.nodes[child_id];
    if let Some(text) = node.text_data() {
        return cell_open || !text.content.trim().is_empty();
    }
    if !node.is_element() {
        return false;
    }
    let Some(display) = node.primary_styles().map(|s| s.clone_display()) else {
        return false;
    };
    matches!(display.outside(), DisplayOutside::Block | DisplayOutside::Inline)
        && matches!(
            display.inside(),
            DisplayInside::Flow | DisplayInside::FlowRoot | DisplayInside::Flex | DisplayInside::Grid
        )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn collect_table_cells(
    doc: &mut BaseDocument,
    node_id: NodeId,
    is_fixed: bool,
    border_collapse: BorderCollapse,
    row: &mut u16,
    col: &mut u16,
    cells: &mut Vec<TableCell>,
    rows: &mut Vec<TableRow>,
    columns: &mut Vec<ColumnDef>,
    first_cell_border: &mut Option<ServoArc<Border>>,
    anonymous_cells: &mut Vec<NodeId>,
) {
    let node = &mut doc.nodes[node_id];

    if !node.is_element() {
        return;
    }

    let Some(display) = node.primary_styles().map(|s| s.clone_display()) else {
        #[cfg(feature = "tracing")]
        tracing::info!("Ignoring table descendent because it has no styles");
        return;
    };

    if display.outside() == DisplayOutside::None {
        node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
        return;
    }

    match display.inside() {
        DisplayInside::TableRowGroup
        | DisplayInside::TableHeaderGroup
        | DisplayInside::TableFooterGroup
        | DisplayInside::Contents => {
            let children = std::mem::take(&mut doc.nodes[node_id].children);
            for child_id in children.iter().copied() {
                doc.nodes[child_id]
                    .remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                collect_table_cells(
                    doc,
                    child_id,
                    is_fixed,
                    border_collapse,
                    row,
                    col,
                    cells,
                    rows,
                    columns,
                    first_cell_border,
                    anonymous_cells,
                );
            }
            doc.nodes[node_id].children = children;
        }
        DisplayInside::TableRow => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            *row += 1;
            *col = 0;

            // MailVault parity fix (plan B): a row is at least its own `height` tall.
            let row_height = node
                .primary_styles()
                .map(|s| stylo_taffy::to_taffy_style(&s).size.height)
                .filter(|h| h.tag() == taffy::CompactLength::LENGTH_TAG)
                .map_or(0.0, |h| h.value());
            rows.push(TableRow {
                node_id,
                height: row_height,
            });

            let children = std::mem::take(&mut doc.nodes[node_id].children);
            // MailVault parity fix (plan B): CSS 2 17.2.1 wraps consecutive non-cell
            // children of a row (a `th` made `display:block` by a media query, as
            // cerberus does to stack its columns) in ONE anonymous cell. Blitz dropped
            // them, with their whole subtree.
            let mut anonymous: Option<NodeId> = None;
            for child_id in children.iter().copied() {
                if is_row_content_to_wrap(doc, child_id, anonymous.is_some()) {
                    let anon = *anonymous.get_or_insert_with(|| {
                        let anon = super::construct::new_anonymous_block(doc, node_id);
                        anonymous_cells.push(anon);
                        push_table_cell(
                            doc,
                            anon,
                            is_fixed,
                            border_collapse,
                            row,
                            col,
                            cells,
                            columns,
                            first_cell_border,
                        );
                        anon
                    });
                    doc.nodes[anon].children.push(child_id);
                    continue;
                }
                // A comment or a `display:none` element between the blocks (cerberus
                // puts `<!-- Column : BEGIN -->` there) does not end the run.
                let invisible = {
                    let n = &doc.nodes[child_id];
                    !n.is_element() && n.text_data().is_none()
                        || n.primary_styles()
                            .is_some_and(|s| s.clone_display().outside() == DisplayOutside::None)
                };
                if !invisible {
                    anonymous = None;
                }
                collect_table_cells(
                    doc,
                    child_id,
                    is_fixed,
                    border_collapse,
                    row,
                    col,
                    cells,
                    rows,
                    columns,
                    first_cell_border,
                    anonymous_cells,
                );
            }
            doc.nodes[node_id].children = children;
        }
        DisplayInside::TableCell => push_table_cell(
            doc,
            node_id,
            is_fixed,
            border_collapse,
            row,
            col,
            cells,
            columns,
            first_cell_border,
        ),
        DisplayInside::Flow
        | DisplayInside::FlowRoot
        | DisplayInside::Flex
        | DisplayInside::Grid => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            // Probably a table caption: ignore
            // println!(
            //     "Warning: ignoring non-table typed descendent of table ({:?})",
            //     display.inside()
            // );
        }
        DisplayInside::TableColumnGroup | DisplayInside::TableColumn | DisplayInside::Table => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            //Ignore
        }
        DisplayInside::None => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            // Ignore
        }
    }
}

pub struct RangeIter(Range<usize>);

impl Iterator for RangeIter {
    type Item = taffy::NodeId;

    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(taffy::NodeId::from)
    }
}

impl TableTreeWrapper<'_> {
    /// MailVault parity fix (plan B): lay the table out, then redo the columns the way
    /// WebKit's auto table layout shares out a table narrower than its columns.
    /// Taffy's grid algorithm grows every column by the same amount up to its limit;
    /// WebKit cuts columns back from their preferred width in proportion to the room
    /// each has above its minimum, so the widths (and with them the text wrapping)
    /// differ. A table that fits is left to taffy.
    pub(crate) fn layout_table(
        &mut self,
        node_id: taffy::NodeId,
        inputs: taffy::tree::LayoutInput,
    ) -> taffy::LayoutOutput {
        let output = taffy::compute_grid_layout(self, node_id, inputs);
        let Some(widths) = self.webkit_column_widths(output.size.width) else {
            return output;
        };
        let mut style = self.ctx.style.clone();
        style.grid_template_columns = widths
            .into_iter()
            .map(|width| {
                let track: TrackSizingFunction = style_helpers::length(width);
                track.into()
            })
            .collect();
        self.style_override = Some(style);
        let mut inputs = inputs;
        inputs.known_dimensions.width = Some(output.size.width);
        let output = taffy::compute_grid_layout(self, node_id, inputs);
        self.style_override = None;
        output
    }

    /// The border-box width of a cell under a min- or max-content constraint.
    fn cell_content_width(&mut self, cell: usize, space: taffy::AvailableSpace) -> f32 {
        self.compute_child_layout(
            taffy::NodeId::from(cell),
            taffy::tree::LayoutInput {
                run_mode: taffy::RunMode::ComputeSize,
                sizing_mode: taffy::SizingMode::ContentSize,
                axis: taffy::RequestedAxis::Horizontal,
                known_dimensions: taffy::Size::NONE,
                known_dimensions_are_definite: taffy::Size {
                    width: false,
                    height: false,
                },
                parent_size: taffy::Size::NONE,
                available_space: taffy::Size {
                    width: space,
                    height: taffy::AvailableSpace::MaxContent,
                },
                vertical_margins_are_collapsible: taffy::Line::FALSE,
            },
        )
        .size
        .width
    }

    /// Column widths when the columns' preferred widths do not fit `table_width`, else
    /// None. A column prefers its specified width (at least its minimum content), or
    /// for an auto column its maximum content. The overflow is taken from the auto
    /// columns first, then from the specified ones (WebKit's AutoTableLayout), each cut
    /// in proportion to the room it has above its minimum content width. Tables with
    /// spanning cells are not handled.
    fn webkit_column_widths(&mut self, table_width: f32) -> Option<Vec<f32>> {
        let ctx = Arc::clone(&self.ctx);
        let n = ctx.column_prefs.len();
        if ctx.is_fixed
            || n < 2
            || ctx
                .cells
                .iter()
                .any(|c| c.colspan != 1 || c.rowspan != 1 || c.col as usize >= n)
        {
            return None;
        }
        let padding = ctx.style.padding.resolve_or_zero(None, resolve_calc_value);
        let border = ctx.style.border.resolve_or_zero(None, resolve_calc_value);
        let gap = ctx.style.gap.width.resolve_or_zero(None, resolve_calc_value);
        let available = table_width
            - padding.left
            - padding.right
            - border.left
            - border.right
            - gap * (n - 1) as f32;

        let mut min = vec![0.0f32; n];
        let mut max = vec![0.0f32; n];
        for (index, cell) in ctx.cells.iter().enumerate() {
            let col = cell.col as usize;
            min[col] = min[col].max(self.cell_content_width(index, taffy::AvailableSpace::MinContent));
            max[col] = max[col].max(self.cell_content_width(index, taffy::AvailableSpace::MaxContent));
        }
        let mut width: Vec<f32> = (0..n)
            .map(|i| match ctx.column_prefs[i] {
                Some(pref) => pref.max(min[i]),
                None => max[i].max(min[i]),
            })
            .collect();
        let mut overflow = width.iter().sum::<f32>() - available;
        if overflow <= 0.5 {
            return None;
        }
        for specified in [false, true] {
            let cols: Vec<usize> = (0..n)
                .filter(|&i| ctx.column_prefs[i].is_some() == specified)
                .collect();
            let room: f32 = cols.iter().map(|&i| width[i] - min[i]).sum();
            if room <= 0.0 {
                continue;
            }
            let cut = overflow.min(room);
            for &i in &cols {
                width[i] -= cut * (width[i] - min[i]) / room;
            }
            overflow -= cut;
            if overflow <= 0.0 {
                break;
            }
        }
        Some(width)
    }
}

impl taffy::TraversePartialTree for TableTreeWrapper<'_> {
    type ChildIter<'a>
        = RangeIter
    where
        Self: 'a;

    #[inline(always)]
    fn child_ids(&self, _node_id: taffy::NodeId) -> Self::ChildIter<'_> {
        RangeIter(0..self.ctx.cells.len())
    }

    #[inline(always)]
    fn child_count(&self, _node_id: taffy::NodeId) -> usize {
        self.ctx.cells.len()
    }

    #[inline(always)]
    fn get_child_id(&self, _node_id: taffy::NodeId, index: usize) -> taffy::NodeId {
        index.into()
    }
}
impl taffy::TraverseTree for TableTreeWrapper<'_> {}

impl taffy::LayoutPartialTree for TableTreeWrapper<'_> {
    type CoreContainerStyle<'a>
        = &'a taffy::Style<Atom>
    where
        Self: 'a;

    type CustomIdent = Atom;

    fn get_core_container_style(&self, _node_id: taffy::NodeId) -> &taffy::Style<Atom> {
        self.style_override.as_ref().unwrap_or(&self.ctx.style)
    }

    fn resolve_calc_value(&self, calc_ptr: *const (), parent_size: f32) -> f32 {
        resolve_calc_value(calc_ptr, parent_size)
    }

    fn set_unrounded_layout(&mut self, node_id: taffy::NodeId, layout: &taffy::Layout) {
        let index = usize::from(node_id);
        let node_id = crate::taffy_node_id(self.ctx.cells[index].node_id);
        match self.pending_inline_shift.take() {
            Some((cell, shift)) if cell == index => {
                // MailVault parity fix (plan B): move the text of the cell down by
                // vertical-align (see `pending_inline_shift`).
                let mut layout = *layout;
                layout.padding.top += shift;
                self.doc.set_unrounded_layout(node_id, &layout)
            }
            _ => self.doc.set_unrounded_layout(node_id, layout),
        }
    }

    fn compute_child_layout(
        &mut self,
        node_id: taffy::NodeId,
        inputs: taffy::tree::LayoutInput,
    ) -> taffy::LayoutOutput {
        let index = usize::from(node_id);
        let cell = &self.ctx.cells[index];
        let dom_id = cell.node_id;
        let node_id = crate::taffy_node_id(dom_id);

        // MailVault parity fix (plan B): in auto table layout a cell's `width` is only a
        // hint for its column's preferred width (the track's max, see `push_table_cell`).
        // Laid out as the box's own width it would also be the cell's min-content
        // contribution, and the column could never shrink below it.
        if !self.ctx.is_fixed {
            let style = self.doc.nodes[dom_id].style_mut();
            if style.size.width.tag() == taffy::CompactLength::LENGTH_TAG {
                style.size.width = style_helpers::auto();
            }
        }

        // MailVault parity fix (plan B): vertical-align on a table cell. The final
        // layout pass gives the cell its full row height; the content then moves down
        // by a share of the room the content leaves. The cell box itself stays put,
        // so backgrounds and borders still fill the row.
        if inputs.run_mode == taffy::RunMode::PerformLayout {
            if let Some(cell_height) = inputs.known_dimensions.height {
                let factor = cell_vertical_align_factor(&self.doc.nodes[dom_id]);
                if factor > 0.0 {
                    let natural = self
                        .doc
                        .compute_child_layout(
                            node_id,
                            taffy::tree::LayoutInput {
                                run_mode: taffy::RunMode::ComputeSize,
                                sizing_mode: taffy::SizingMode::ContentSize,
                                axis: taffy::RequestedAxis::Vertical,
                                known_dimensions: taffy::Size {
                                    width: inputs.known_dimensions.width,
                                    height: None,
                                },
                                ..inputs
                            },
                        )
                        .size
                        .height;
                    let shift = ((cell_height - natural) * factor).max(0.0);
                    // Not through the layout cache: a cache hit would skip writing the
                    // children, and their positions must start from the unshifted ones.
                    let output = self.doc.compute_child_layout_internal(node_id, inputs, None);
                    if shift > 0.0 {
                        if self.doc.nodes[dom_id].flags.is_inline_root() {
                            self.pending_inline_shift = Some((index, shift));
                        } else {
                            let children: Vec<NodeId> = self.doc.nodes[dom_id]
                                .layout_children
                                .borrow()
                                .as_ref()
                                .map(|children| children.iter().copied().collect())
                                .unwrap_or_default();
                            for child in children {
                                self.doc.nodes[child].unrounded_layout_mut().location.y += shift;
                            }
                        }
                    }
                    return output;
                }
            }
        }

        self.doc.compute_child_layout(node_id, inputs)
    }
}

impl taffy::LayoutGridContainer for TableTreeWrapper<'_> {
    type GridContainerStyle<'a>
        = &'a taffy::Style<Atom>
    where
        Self: 'a;

    type GridItemStyle<'a>
        = &'a taffy::Style<Atom>
    where
        Self: 'a;

    fn get_grid_container_style(&self, node_id: taffy::NodeId) -> Self::GridContainerStyle<'_> {
        self.get_core_container_style(node_id)
    }

    fn get_grid_child_style(&self, child_node_id: taffy::NodeId) -> Self::GridItemStyle<'_> {
        &self.ctx.cells[usize::from(child_node_id)].style
    }

    fn set_detailed_grid_info(
        &mut self,
        _node_id: taffy::NodeId,
        detailed_grid_info: DetailedGridInfo<Atom>,
    ) {
        *self.ctx.computed_grid_info.borrow_mut() = Some(detailed_grid_info);
    }
}
