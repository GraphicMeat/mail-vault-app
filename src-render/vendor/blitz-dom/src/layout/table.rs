use blitz_traits::node_id::NodeId;
use std::{ops::Range, sync::Arc};
use style::logical_geometry::WritingMode;
use style::properties::ComputedValues;

use atomic_refcell::AtomicRefCell;
use markup5ever::local_name;
use style::properties::style_structs::Border;
use style::servo_arc::Arc as ServoArc;
use style::typed_om::NumericBaseType;
use style::values::computed::calc::CalcPercentageLeaf;
use style::values::computed::length_percentage::{
    CalcLengthPercentage, CalcNode, ComputedLeaf, Unpacked as UnpackedLengthPercentage,
};
use style::values::computed::{Length, LengthPercentage};
use style::values::generics::Optional;
use style::values::specified::box_::{DisplayInside, DisplayOutside};
use style::{
    Atom, computed_values::border_collapse::T as BorderCollapse,
    computed_values::table_layout::T as TableLayout, values::computed::BorderStyle,
};
use style_traits::values::specified::AllowedNumericType;
use taffy::{
    DetailedGridInfo, LayoutPartialTree as _, ResolveOrZero, TrackSizingFunction, style_helpers,
};

use crate::BaseDocument;
use crate::layout::LayoutPassState;

use super::damage::{CONSTRUCT_BOX, CONSTRUCT_DESCENDENT, CONSTRUCT_FC};
use super::resolve_calc_value;

pub struct TableTreeWrapper<'a, 'doc> {
    pub(crate) doc: &'a mut LayoutPassState<'doc>,
    pub(crate) ctx: Arc<TableContext>,
    // MailVault parity fix (plan B): the table style with the column widths
    // `webkit_column_widths` chose, used for the second layout pass.
    pub(crate) style_override: Option<taffy::Style<Atom>>,
}


// Deliberately not `Clone`: `style` may hold raw pointers into `calc_values`.
#[derive(Debug)]
pub struct TableContext {
    pub style: taffy::Style<Atom>,
    // MailVault parity fix (plan B): the preferred (specified) width of each column, from
    // the cells, in auto layout. See `TableTreeWrapper::webkit_column_widths`.
    pub column_prefs: Vec<Option<ColumnPref>>,
    pub cells: Vec<TableCell>,
    /// Absolutely positioned descendants of the table's row groups and rows (and of the
    /// table itself). They take no part in the table grid.
    pub oof_children: Vec<(NodeId, taffy::Position)>,
    pub rows: Vec<TableRow>,
    pub columns: Vec<TableColumn>,
    pub computed_grid_info: AtomicRefCell<Option<DetailedGridInfo<Atom>>>,
    pub border_style: Option<ServoArc<Border>>,
    pub border_collapse: BorderCollapse,
    // MailVault parity fix (plan B): `table-layout: fixed`.
    pub is_fixed: bool,
    /// Backing storage for `calc()` track sizes synthesised by the table layout code.
    /// Taffy stores calc values as raw pointers, so these must outlive the `style`.
    #[allow(dead_code)]
    calc_values: Vec<LengthPercentage>,
}

// #[derive(Debug, Clone, Eq, PartialEq)]
// pub enum TableItemKind {
//     Row,
//     Cell,
// }

#[derive(Debug, Clone)]
pub struct TableCell {
    // kind: TableItemKind,
    pub node_id: NodeId,
    /// Index (into `TableContext::rows`) of the row the cell originates in
    pub row: u16,
    /// Index of the column the cell originates in
    pub column: u16,
    // MailVault parity fix (plan B): the cell's spans.
    colspan: u16,
    rowspan: u16,
    style: taffy::Style<Atom>,
}

/// MailVault parity fix (plan B): what a cell asks of its column in auto layout.
#[derive(Debug, Clone, Copy)]
pub enum ColumnPref {
    /// A specified width, border box, in px.
    Length(f32),
    /// A percentage of the table's width, as a fraction.
    Percent(f32),
}

/// Tracks the current column position while walking the table's cells, so that
/// cells are assigned the same columns Taffy's dense auto-placement will give them
/// (skipping columns still occupied by rowspan cells from earlier rows).
#[derive(Debug, Default)]
struct ColumnCursor {
    /// The column the next cell in the current row will be placed in
    col: u16,
    /// The total number of columns seen so far
    num_columns: u16,
    /// For each column, the number of further rows it is occupied by a rowspan cell
    rowspans: Vec<u16>,
}

impl ColumnCursor {
    fn start_row(&mut self) {
        self.col = 0;
        for remaining in self.rowspans.iter_mut() {
            *remaining = remaining.saturating_sub(1);
        }
    }

    /// Advance past occupied columns, returning the column of the next cell
    fn next_free(&mut self) -> u16 {
        while self.rowspans.get(self.col as usize).is_some_and(|r| *r > 0) {
            self.col += 1;
        }
        self.col
    }

    fn place(&mut self, colspan: u16, rowspan: u16) {
        // MailVault parity fix (plan B): the table is at most 1000 columns wide (the HTML
        // limit), so 66 cells of colspan 1000 cannot wrap the u16 counter.
        let end = self.col.saturating_add(colspan).min(MAX_TABLE_COLUMNS);
        if self.rowspans.len() < end as usize {
            self.rowspans.resize(end as usize, 0);
        }
        for remaining in &mut self.rowspans[self.col as usize..end as usize] {
            *remaining = rowspan - 1;
        }
        self.col = end;
        self.num_columns = self.num_columns.max(end);
    }
}

#[derive(Debug, Clone)]
pub struct TableColumn {
    pub node_id: NodeId,
    /// The column group (if any) that contains the column
    pub group: Option<NodeId>,
}

#[derive(Debug, Clone)]
pub struct TableRow {
    // kind: TableItemKind,
    pub node_id: NodeId,
    /// The row group (if any) that contains the row
    pub group: Option<NodeId>,
    /// The row's specified `height`, if it is a length
    pub height: Option<f32>,
    /// Whether the row or any cell originating in it (and spanning only this row) has a
    /// specified length `height`. Such rows do not receive excess table height when there
    /// are unconstrained rows to receive it instead.
    pub is_constrained: bool,
}

/// The used width of one border side: border widths are not adjusted for
/// border-style in computed styles, so a border with `none`/`hidden` style
/// must be treated as zero-width.
/// The writing mode the table's grid runs in (the table's own)
#[cfg_attr(not(feature = "writing-mode"), allow(unused_variables))]
fn table_wm(doc: &BaseDocument, table_root_node_id: NodeId) -> WritingMode {
    #[cfg(feature = "writing-mode")]
    {
        if doc.try_root_element().map(|root| root.id) == Some(table_root_node_id) {
            doc.root_layout_wm(table_root_node_id)
        } else {
            doc.nodes[table_root_node_id].writing_mode()
        }
    }
    #[cfg(not(feature = "writing-mode"))]
    {
        WritingMode::empty()
    }
}

/// Convert a table part's style into the table's writing mode
fn table_taffy_style(style: &ComputedValues, table_wm: WritingMode) -> taffy::Style<Atom> {
    stylo_taffy::to_taffy_style_in(style, table_wm)
}

fn side_width(width: app_units::Au, style: BorderStyle) -> f32 {
    if style.none_or_hidden() {
        0.0
    } else {
        width.to_f32_px()
    }
}

/// MailVault parity fix (plan D): a table whose `width` is a length ignores a percentage
/// `max-width`. CSS 2.1 10.4 leaves `min-width` and `max-width` on tables undefined (CSS
/// Tables 3 defines them, but the shipped engines differ). Measured in macOS WKWebView with
/// `getBoundingClientRect` in a 300px container: `width="600"` or `width:600px` with
/// `max-width: 100%` (or 50%, 75%) stays 600 and overflows, as does `width:400px` with 50% to
/// 100%; a length `max-width` is honoured (`width="600"` with `max-width:300px` is 300), and a
/// percentage `max-width` is honoured when the width is auto or a percentage (an auto table
/// of wrapping text with `max-width:50%` is 150, `width="100%"` with 50% is 150). Blitz
/// clamped every one of them, which squeezed a 600px email layout to the 268px of a chat
/// bubble's body (the bubble document carries `table { max-width: 100% }`). `min-width` is
/// honoured by WebKit as well and left alone.
///
/// Called for the table context's style the grid is computed with (`build_table_context`).
/// Taffy 0.15's block layout lets a table resolve its own width (it passes no known width),
/// so the node style the parent block reads no longer needs the same change (beta.2 also
/// patched `flush_styles_to_layout_impl`).
pub(crate) fn drop_percentage_max_width_of_fixed_width_table(style: &mut taffy::Style<Atom>) {
    if style.size.width.tag() == taffy::CompactLength::LENGTH_TAG
        && style.max_size.width.into_raw().tag() == taffy::CompactLength::PERCENT_TAG
    {
        style.max_size.width = style_helpers::auto();
    }
}

/// MailVault parity fix (plan D): the used border widths of a cell, in CSS px, ordered top,
/// right, bottom, left. A side with `border-style: none` or `hidden` has a used width of 0
/// (CSS Backgrounds 3 4.3), although its computed `border-width` is still `medium` (3px). In
/// the collapsing border model (CSS 2.1 17.6.2.1) `none` has the lowest priority and
/// contributes nothing, while `hidden` has the highest and suppresses every border it meets;
/// both leave this cell's own side without a visible line, which is all this reads. A
/// `hidden` neighbour that would also suppress this cell's border is not modelled.
fn used_border_widths(border: &Border) -> [f32; 4] {
    let used = |width: &style::values::computed::BorderSideWidth, style: style::values::specified::BorderStyle| {
        if style.none_or_hidden() {
            0.0
        } else {
            width.0.to_f32_px()
        }
    };
    [
        used(&border.border_top_width, border.border_top_style),
        used(&border.border_right_width, border.border_right_style),
        used(&border.border_bottom_width, border.border_bottom_style),
        used(&border.border_left_width, border.border_left_style),
    ]
}

/// MailVault parity fix (plan D): the border blitz-paint draws the collapsed grid lines with.
/// `draw_table_borders` takes the width and colour of the *top* border of this value for
/// every line it draws, outer and inner, and does not look at the border style. Handing it
/// the first cell's computed border drew a 3px (`medium`) frame in `currentcolor` around
/// every collapsed table whose first cell has no border (cerberus, the export header's
/// `.mv-meta`, the bubble's tables), where WKWebView draws nothing. Here a cell without any
/// visible side gives `None` (nothing is painted); otherwise the top width is the smallest
/// used width of the four sides, so an outer line is only drawn where every side has one
/// (the inner lines take their width from the track gutters, see `gap` in
/// `build_table_context`), and the colour is that of the first side that has a visible
/// border. CSS 2.1 17.6.2.1 (a border style of none, or a width of 0, loses every conflict).
///
/// Ported to beta.4: blitz-paint now takes the line widths from the track gutters and the
/// table border (both the `gap`), returns early when the *top* side's style is none or
/// hidden, and still takes the colour of the top side. So the value handed to it carries the
/// style and colour of the first side that has a visible border in its top slot, and `None`
/// when no side has one.
fn collapsed_paint_border(border: &ServoArc<Border>) -> Option<ServoArc<Border>> {
    let used = used_border_widths(border);
    let visible = used.iter().position(|width| *width > 0.0)?;
    let colours = [
        &border.border_top_color,
        &border.border_right_color,
        &border.border_bottom_color,
        &border.border_left_color,
    ];
    let styles = [
        border.border_top_style,
        border.border_right_style,
        border.border_bottom_style,
        border.border_left_style,
    ];
    let mut paint = (**border).clone();
    paint.border_top_width = style::values::computed::BorderSideWidth(app_units::Au::from_f32_px(
        used.iter().copied().fold(f32::INFINITY, f32::min),
    ));
    paint.border_top_color = colours[visible].clone();
    paint.border_top_style = styles[visible];
    Some(ServoArc::new(paint))
}

/// Build a `calc(<percent> + <length>)` track sizing function. The calc value is
/// boxed and stored in `calc_values` so that the raw pointer Taffy holds stays valid.
fn percent_plus_length(
    calc_values: &mut Vec<LengthPercentage>,
    percent: f32,
    length: f32,
) -> TrackSizingFunction {
    let node = CalcNode::Sum(
        vec![
            CalcNode::Leaf(ComputedLeaf::Percentage(CalcPercentageLeaf::new(
                percent,
                Optional::Some(NumericBaseType::Length),
            ))),
            CalcNode::Leaf(ComputedLeaf::Length(Length::new(length))),
        ]
        .into(),
    );
    let value = LengthPercentage::new_calc(node, AllowedNumericType::NonNegative);
    let dim = match value.unpack() {
        UnpackedLengthPercentage::Calc(calc) => {
            let ptr = calc as *const CalcLengthPercentage as *const ();
            // SAFETY: the pointer targets the heap allocation owned by `value`, which
            // is kept alive by `calc_values` for as long as the TableContext exists.
            unsafe { taffy::Dimension::from_raw(taffy::CompactLength::calc(ptr)) }
        }
        UnpackedLengthPercentage::Length(len) => style_helpers::length(len.px()),
        UnpackedLengthPercentage::Percentage(p) => style_helpers::percent(p.0),
    };
    calc_values.push(value);
    dim.into()
}

pub(crate) fn build_table_context(
    doc: &mut BaseDocument,
    table_root_node_id: NodeId,
) -> (TableContext, Vec<NodeId>, Vec<NodeId>) {
    // MailVault parity fix (plan B): the anonymous table cells made for non-cell row children.
    let mut anonymous_cells: Vec<NodeId> = Vec::new();
    let mut cells: Vec<TableCell> = Vec::new();
    let mut oof_children: Vec<(NodeId, taffy::Position)> = Vec::new();
    let mut rows: Vec<TableRow> = Vec::new();
    let mut row = 0u16;
    let mut cursor = ColumnCursor::default();

    let wm = table_wm(doc, table_root_node_id);
    let root_node = &mut doc.nodes[table_root_node_id];

    let children = std::mem::take(&mut root_node.children);

    let Some(stylo_styles) = root_node.primary_styles() else {
        panic!("Ignoring table because it has no styles");
    };

    let mut style = table_taffy_style(&stylo_styles, wm);
    style.item_is_table = true;
    // MailVault parity fix (plan D): see `drop_percentage_max_width_of_fixed_width_table`.
    drop_percentage_max_width_of_fixed_width_table(&mut style);
    // Use `dense` row-flow so that each cell scans the row from its
    // leftmost column for the first free track. Without `dense`,
    // `place_definite_secondary_axis_item` keeps a per-item secondary
    // cursor across rows, which means cells in later rows do not
    // backfill columns freed up by rowspan cells from earlier rows.
    style.grid_auto_flow = taffy::GridAutoFlow::RowDense;
    style.grid_auto_columns = Vec::new();
    style.grid_auto_rows = Vec::new();

    // The fixed table layout algorithm only applies when the table has a non-auto width
    let is_fixed = match stylo_styles.clone_table_layout() {
        TableLayout::Fixed => !style.size.width.is_auto(),
        TableLayout::Auto => false,
    };

    let border_collapse = stylo_styles.clone_border_collapse();
    let border_spacing = stylo_styles.clone_border_spacing().0;

    drop(stylo_styles);

    let mut columns: Vec<TableColumn> = Vec::new();
    let mut column_sizes: Vec<taffy::TrackSizingFunction> = Vec::new();
    // MailVault parity fix (plan B): what the cells ask of each column in auto layout.
    let mut column_prefs: Vec<Option<ColumnPref>> = Vec::new();
    for child_id in children.iter().copied() {
        collect_columns(doc, child_id, wm, &mut columns, &mut column_sizes);
    }
    // Percentage column widths only take effect in the fixed table layout algorithm
    if !is_fixed {
        for column in column_sizes.iter_mut() {
            if column.max.into_raw().tag() == taffy::CompactLength::PERCENT_TAG {
                *column = style_helpers::auto();
            }
        }
    }
    let mut first_cell_border: Option<ServoArc<Border>> = None;
    // Percentage widths set on first-row cells: (column index, percentage, padding + border)
    let mut percent_columns: Vec<(u16, f32, f32)> = Vec::new();
    let mut calc_values: Vec<LengthPercentage> = Vec::new();
    // Header row groups are laid out before other rows, and footer row groups after
    let row_group_order = |doc: &BaseDocument, child_id: NodeId| -> u8 {
        let display = doc.nodes[child_id]
            .primary_styles()
            .map(|s| s.clone_display());
        match display.map(|d| d.inside()) {
            Some(DisplayInside::TableHeaderGroup) => 0,
            Some(DisplayInside::TableFooterGroup) => 2,
            _ => 1,
        }
    };
    for order in 0..3 {
        for child_id in children.iter().copied() {
            if row_group_order(doc, child_id) != order {
                continue;
            }
            collect_table_cells(
                doc,
                child_id,
                wm,
                is_fixed,
                border_collapse,
                &mut row,
                &mut cursor,
                &mut cells,
                &mut oof_children,
                &mut rows,
                &mut column_sizes,
                &mut first_cell_border,
                &mut percent_columns,
                &mut column_prefs,
                &mut anonymous_cells,
            );
        }
    }
    let remaining_column = if is_fixed {
        style_helpers::minmax(style_helpers::length(0.0), style_helpers::fr(1.0))
    } else {
        style_helpers::auto()
    };
    // Trailing `<col>` columns which contain no cells and have no definite width
    // (i.e. would be zero-width) are dropped, so they don't add border-spacing.
    while column_sizes.len() > cursor.num_columns as usize
        && column_sizes
            .last()
            .is_some_and(|c| c.min.into_raw().tag() == taffy::CompactLength::AUTO_TAG)
    {
        column_sizes.pop();
        columns.pop();
    }
    let num_columns = cursor.num_columns.max(column_sizes.len() as u16);
    column_sizes.resize(num_columns as usize, remaining_column);
    column_prefs.resize(num_columns as usize, None);
    if is_fixed {
        // In the fixed table layout algorithm, percentage column widths resolve against
        // the table's content width minus the horizontal border-spacing between columns,
        // whereas Taffy resolves percentage tracks against the container's inner width
        // (from which only the outer border-spacing has been removed via padding). Fold
        // the inner border-spacing into the percentage using `calc(N% - N * spacing)`.
        let spacing_x = match border_collapse {
            BorderCollapse::Separate => border_spacing.width.px(),
            BorderCollapse::Collapse => 0.0,
        };
        let inner_spacing = spacing_x * num_columns.saturating_sub(1) as f32;
        let mut percent_track = |percent: f32, extra: f32| -> TrackSizingFunction {
            let extra = extra - percent * inner_spacing;
            if extra == 0.0 {
                style_helpers::percent(percent)
            } else {
                percent_plus_length(&mut calc_values, percent, extra)
            }
        };

        for column in column_sizes.iter_mut() {
            if column.max.is_auto() {
                *column = remaining_column;
            } else if column.max.into_raw().tag() == taffy::CompactLength::PERCENT_TAG {
                *column = percent_track(column.max.into_raw().value(), 0.0);
            }
        }

        // Percentage widths on cells apply to the cell's content box, so the
        // cell's horizontal padding and border must be added to the column width.
        for (col_idx, percent, extra) in percent_columns {
            if let Some(column) = column_sizes.get_mut(col_idx as usize) {
                *column = percent_track(percent, extra);
            }
        }
    }

    style.grid_template_columns = column_sizes.into_iter().map(|dim| dim.into()).collect();
    // A row's `height` is a minimum: the row grows to fit the content of its cells.
    // Excess table height is distributed to unconstrained rows (via the stretching of
    // `auto` tracks) if there are any, and to all rows otherwise. So constrained rows
    // use a `max-content` (rather than `auto`) maximum when there are unconstrained rows.
    let has_unconstrained_rows = rows.iter().any(|row| !row.is_constrained);
    style.grid_template_rows = rows
        .iter()
        .map(|row| {
            let min = match row.height {
                Some(height) => style_helpers::length(height),
                None => style_helpers::auto(),
            };
            let max = if row.is_constrained && has_unconstrained_rows {
                style_helpers::max_content()
            } else {
                style_helpers::auto()
            };
            style_helpers::minmax(min, max)
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
                let x = side_width(border.border_left_width.0, border.border_left_style).max(
                    side_width(border.border_right_width.0, border.border_right_style),
                );
                let y = side_width(border.border_top_width.0, border.border_top_style).max(
                    side_width(border.border_bottom_width.0, border.border_bottom_style),
                );
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

    let layout_children = cells
        .iter()
        .map(|cell| cell.node_id)
        .chain(oof_children.iter().map(|(node_id, _)| *node_id))
        .collect();
    let root_node = &mut doc.nodes[table_root_node_id];
    root_node.children = children;

    (
        TableContext {
            style,
            cells,
            oof_children,
            rows,
            columns,
            computed_grid_info: AtomicRefCell::new(None),
            border_collapse,
            // MailVault parity fix (plan D): see `collapsed_paint_border`.
            border_style: match border_collapse {
                BorderCollapse::Collapse => first_cell_border.as_ref().and_then(collapsed_paint_border),
                BorderCollapse::Separate => first_cell_border,
            },
            column_prefs,
            is_fixed,
            calc_values,
        },
        layout_children,
        anonymous_cells,
    )
}

/// The HTML limit on a table's width in columns.
const MAX_TABLE_COLUMNS: u16 = 1000;

/// MailVault parity fix (plan B): the HTML "rules for parsing non-negative integers" (leading
/// whitespace, an optional `+`, then the leading digits), saturating instead of failing on
/// a value too large to hold.
fn parse_non_negative_integer(value: &str) -> Option<u64> {
    let s = value.trim_start_matches(|c: char| c.is_ascii_whitespace());
    let s = s.strip_prefix('+').unwrap_or(s);
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    Some(s[..digits].bytes().fold(0u64, |n, d| n.saturating_mul(10).saturating_add((d - b'0') as u64)))
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
    let Some(styles) = node.primary_styles() else {
        return false;
    };
    // Absolutely positioned children of a row stay out of the grid (`oof_children`).
    if styles.clone_position().is_absolutely_positioned() {
        return false;
    }
    let display = styles.clone_display();
    matches!(display.outside(), DisplayOutside::Block | DisplayOutside::Inline)
        && matches!(
            display.inside(),
            DisplayInside::Flow | DisplayInside::FlowRoot | DisplayInside::Flex | DisplayInside::Grid
        )
}

/// Collect `<col>` elements (and `display: table-column` elements) along with their
/// widths, which take precedence over cell widths in the fixed table layout algorithm.
/// Columns without a specified width are recorded as `auto`.
fn collect_columns(
    doc: &mut BaseDocument,
    node_id: NodeId,
    wm: WritingMode,
    columns: &mut Vec<TableColumn>,
    column_sizes: &mut Vec<TrackSizingFunction>,
) {
    let node = &doc.nodes[node_id];
    if !node.is_element() {
        return;
    }
    let Some(display) = node.display_style() else {
        return;
    };

    match display.inside() {
        DisplayInside::TableColumnGroup => {
            let first_column = columns.len();
            let children = std::mem::take(&mut doc.nodes[node_id].children);
            for child_id in children.iter().copied() {
                collect_columns(doc, child_id, wm, columns, column_sizes);
            }
            doc.nodes[node_id].children = children;
            for column in &mut columns[first_column..] {
                column.group.get_or_insert(node_id);
            }
        }
        DisplayInside::TableColumn => {
            let style = table_taffy_style(&node.primary_styles().unwrap(), wm);
            let span: u16 = node
                .attr(local_name!("span"))
                .and_then(|val| val.parse::<u16>().ok())
                .map(|v| v.max(1))
                .unwrap_or(1);
            let column: TrackSizingFunction = match style.size.width.tag() {
                taffy::CompactLength::LENGTH_TAG => {
                    // A definite `max-width` clamps the column width; a zero width is treated as auto
                    let mut width = style.size.width.value();
                    if style.max_size.width.into_raw().tag() == taffy::CompactLength::LENGTH_TAG {
                        width = width.min(style.max_size.width.into_raw().value());
                    }
                    if width > 0.0 {
                        style_helpers::length(width)
                    } else {
                        style_helpers::auto()
                    }
                }
                taffy::CompactLength::PERCENT_TAG => {
                    style_helpers::percent(style.size.width.value())
                }
                // Browsers treat calc() widths on columns as auto
                _ => style_helpers::auto(),
            };
            // A definite `min-width` on a column acts as a floor on its width
            let column = match style.min_size.width.into_raw().tag() {
                taffy::CompactLength::LENGTH_TAG if column.max.is_auto() => style_helpers::minmax(
                    style_helpers::length(style.min_size.width.into_raw().value()),
                    style_helpers::auto(),
                ),
                _ => column,
            };
            for _ in 0..span {
                columns.push(TableColumn {
                    node_id,
                    group: None,
                });
                column_sizes.push(column);
            }
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_table_cells(
    doc: &mut BaseDocument,
    node_id: NodeId,
    wm: WritingMode,
    is_fixed: bool,
    border_collapse: BorderCollapse,
    row: &mut u16,
    cursor: &mut ColumnCursor,
    cells: &mut Vec<TableCell>,
    oof_children: &mut Vec<(NodeId, taffy::Position)>,
    rows: &mut Vec<TableRow>,
    columns: &mut Vec<TrackSizingFunction>,
    first_cell_border: &mut Option<ServoArc<Border>>,
    percent_columns: &mut Vec<(u16, f32, f32)>,
    column_prefs: &mut Vec<Option<ColumnPref>>,
    anonymous_cells: &mut Vec<NodeId>,
) {
    let node = &mut doc.nodes[node_id];

    if !node.is_element() {
        return;
    }

    let Some(display) = node.display_style() else {
        #[cfg(feature = "tracing")]
        tracing::info!("Ignoring table descendent because it has no styles");
        return;
    };

    if display.outside() == DisplayOutside::None {
        node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
        return;
    }

    // Absolutely positioned boxes are out-of-flow: they are laid out by their containing
    // block rather than as part of the table grid.
    let position = node.primary_styles().unwrap().clone_position();
    if position.is_absolutely_positioned() {
        oof_children.push((node_id, stylo_taffy::convert::position(position)));
        return;
    }

    match display.inside() {
        DisplayInside::TableRowGroup
        | DisplayInside::TableHeaderGroup
        | DisplayInside::TableFooterGroup
        | DisplayInside::Contents => {
            let first_row = rows.len();
            let children = std::mem::take(&mut doc.nodes[node_id].children);
            for child_id in children.iter().copied() {
                doc.nodes[child_id]
                    .remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                collect_table_cells(
                    doc,
                    child_id,
                    wm,
                    is_fixed,
                    border_collapse,
                    row,
                    cursor,
                    cells,
                    oof_children,
                    rows,
                    columns,
                    first_cell_border,
                    percent_columns,
                    column_prefs,
                    anonymous_cells,
                );
            }
            doc.nodes[node_id].children = children;
            if display.inside() != DisplayInside::Contents {
                for row in &mut rows[first_row..] {
                    row.group.get_or_insert(node_id);
                }
            }
        }
        DisplayInside::TableRow => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            *row = row.saturating_add(1);
            cursor.start_row();

            let height = node.primary_styles().and_then(|style| {
                let height = stylo_taffy::convert::dimension(&style.clone_height());
                (height.tag() == taffy::CompactLength::LENGTH_TAG).then(|| height.value())
            });
            rows.push(TableRow {
                node_id,
                group: None,
                height,
                is_constrained: height.is_some(),
            });

            let children = std::mem::take(&mut doc.nodes[node_id].children);
            // MailVault parity fix (plan B): CSS 2 17.2.1 wraps consecutive non-cell
            // children of a row (a `th` made `display:block` by a media query, as
            // cerberus does to stack its columns) in ONE anonymous cell. Blitz dropped
            // them, with their whole subtree.
            let mut anonymous: Option<NodeId> = None;
            for child_id in children.iter().copied() {
                if is_row_content_to_wrap(doc, child_id, anonymous.is_some()) {
                    let anon = match anonymous {
                        Some(anon) => anon,
                        None => {
                            let anon = super::construct::new_anonymous_block(doc, node_id);
                            anonymous_cells.push(anon);
                            push_table_cell(
                                doc,
                                anon,
                                wm,
                                is_fixed,
                                border_collapse,
                                row,
                                cursor,
                                cells,
                                rows,
                                columns,
                                first_cell_border,
                                percent_columns,
                                column_prefs,
                            );
                            anonymous = Some(anon);
                            anon
                        }
                    };
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
                    wm,
                    is_fixed,
                    border_collapse,
                    row,
                    cursor,
                    cells,
                    oof_children,
                    rows,
                    columns,
                    first_cell_border,
                    percent_columns,
                    column_prefs,
                    anonymous_cells,
                );
            }
            doc.nodes[node_id].children = children;
        }
        DisplayInside::TableCell => push_table_cell(
            doc,
            node_id,
            wm,
            is_fixed,
            border_collapse,
            row,
            cursor,
            cells,
            rows,
            columns,
            first_cell_border,
            percent_columns,
            column_prefs,
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

/// Register `node_id` as the next cell of the current row.
// MailVault parity fix (plan B): split out of `collect_table_cells` so a row's anonymous
// cell is registered like any other.
#[allow(clippy::too_many_arguments)]
fn push_table_cell(
    doc: &mut BaseDocument,
    node_id: NodeId,
    wm: WritingMode,
    is_fixed: bool,
    border_collapse: BorderCollapse,
    row: &mut u16,
    cursor: &mut ColumnCursor,
    cells: &mut Vec<TableCell>,
    rows: &mut [TableRow],
    columns: &mut Vec<TrackSizingFunction>,
    first_cell_border: &mut Option<ServoArc<Border>>,
    percent_columns: &mut Vec<(u16, f32, f32)>,
    column_prefs: &mut Vec<Option<ColumnPref>>,
) {
    let node = &doc.nodes[node_id];
    let stylo_style = &node.primary_styles().unwrap();
    // MailVault parity fix (plan B): HTML's span rules. colspan: a failed parse or 0 is 1,
    // above 1000 is 1000 (0 underflowed the spacing maths and huge spans overflowed the
    // column counter). rowspan: above 65534 is 65534 (0, "to the end of the group", is
    // treated as 1 as before).
    let colspan: u16 = node
        .attr(local_name!("colspan"))
        .and_then(parse_non_negative_integer)
        .map_or(1, |v| v.clamp(1, MAX_TABLE_COLUMNS as u64) as u16);
    let rowspan: u16 = node
        .attr(local_name!("rowspan"))
        .and_then(parse_non_negative_integer)
        .map_or(1, |v| v.clamp(1, 65534) as u16);
    let mut style = table_taffy_style(stylo_style, wm);
    let col = cursor.next_free();

    // In the collapsed borders model the borders are laid out as gutters between
    // the cells (see the table's `gap`) rather than as part of the cells
    if border_collapse == BorderCollapse::Collapse {
        style.border = taffy::Rect::ZERO.map(style_helpers::length);
    }

    if first_cell_border.is_none() {
        *first_cell_border = Some(stylo_style.clone_border());
    }

    // In the fixed table layout algorithm the widths of columns are not
    // affected by cell contents, so cells must not impose a min-content
    // floor on their tracks.
    if is_fixed {
        style.min_size.width = style_helpers::length(0.0);
    }

    // The border-box width a cell's `width` asks for, when it is a length.
    let border_box_length = |style: &taffy::Style<Atom>| -> f32 {
        let len = style.size.width.value();
        let padding = style.padding.resolve_or_zero(None, resolve_calc_value);
        let border = style.border.resolve_or_zero(None, resolve_calc_value);
        match style.box_sizing {
            taffy::BoxSizing::ContentBox => {
                len + padding.left + padding.right + border.left + border.right
            }
            taffy::BoxSizing::BorderBox => len,
        }
    };

    // Column widths from `<col>` elements take precedence over cell widths
    let col_needs_width = (col as usize) >= columns.len() || columns[col as usize].max.is_auto();
    if *row == 1 && col_needs_width {
        let (column, pref): (TrackSizingFunction, Option<ColumnPref>) = match style.size.width.tag()
        {
            taffy::CompactLength::LENGTH_TAG => {
                let width = border_box_length(&style);
                if is_fixed {
                    (style_helpers::length(width), None)
                } else {
                    // MailVault parity fix (plan B): in auto table layout a specified
                    // width is the column's preferred width, not a fixed one (CSS 2
                    // 17.5.2.2): the column is at least its content's minimum and
                    // shrinks towards it when the table is narrower than its columns.
                    (
                        style_helpers::minmax(style_helpers::auto(), style_helpers::length(width)),
                        Some(ColumnPref::Length(width)),
                    )
                }
            }
            taffy::CompactLength::PERCENT_TAG => {
                if is_fixed {
                    let extra = match style.box_sizing {
                        taffy::BoxSizing::ContentBox => {
                            let padding = style.padding.resolve_or_zero(None, resolve_calc_value);
                            let border = style.border.resolve_or_zero(None, resolve_calc_value);
                            padding.left + padding.right + border.left + border.right
                        }
                        taffy::BoxSizing::BorderBox => 0.0,
                    };
                    // Resolved in `build_table_context` once the column count is known
                    percent_columns.push((col, style.size.width.value(), extra));
                    (style_helpers::percent(style.size.width.value()), None)
                } else {
                    // MailVault parity fix (plan B): the column's preferred width is that share
                    // of the table (see `TableTreeWrapper::webkit_column_widths`); taffy gets
                    // an auto track and its widths are replaced after the first pass.
                    (
                        style_helpers::auto(),
                        Some(ColumnPref::Percent(style.size.width.value())),
                    )
                }
            }
            taffy::CompactLength::AUTO_TAG => (style_helpers::auto(), None),
            // Dimension values are always length, percentage, auto or calc(),
            // so any other tag is a calc() value. Pass it through so that
            // Taffy resolves it against the table's inner width.
            _ => (style.size.width.into(), None),
        };
        if (col as usize) < columns.len() {
            if !column.max.is_auto() {
                columns[col as usize] = column;
            }
        } else {
            columns.resize(col as usize, style_helpers::auto());
            columns.push(column);
        }
        if column_prefs.len() <= col as usize {
            column_prefs.resize(col as usize + 1, None);
        }
        column_prefs[col as usize] = pref;
    }

    // MailVault parity fix (plan B): any row's cell can say what its column prefers, not just
    // the first row's (measured in the harness iframe): the largest percentage wins,
    // and over a length; between lengths the larger wins. postmark's purchase table puts
    // its `width="80%"` on the cells of the second row.
    if *row > 1 && !is_fixed && colspan == 1 && col_needs_width {
        let pref = match style.size.width.tag() {
            taffy::CompactLength::LENGTH_TAG => Some(ColumnPref::Length(border_box_length(&style))),
            taffy::CompactLength::PERCENT_TAG => Some(ColumnPref::Percent(style.size.width.value())),
            _ => None,
        };
        if let Some(pref) = pref {
            if column_prefs.len() <= col as usize {
                column_prefs.resize(col as usize + 1, None);
            }
            let have = column_prefs[col as usize];
            column_prefs[col as usize] = match (have, pref) {
                (Some(ColumnPref::Percent(have)), ColumnPref::Percent(new)) => {
                    Some(ColumnPref::Percent(have.max(new)))
                }
                (Some(ColumnPref::Percent(have)), ColumnPref::Length(_)) => {
                    Some(ColumnPref::Percent(have))
                }
                (_, ColumnPref::Percent(new)) => Some(ColumnPref::Percent(new)),
                (Some(ColumnPref::Length(have)), ColumnPref::Length(new)) => {
                    Some(ColumnPref::Length(have.max(new)))
                }
                (None, length) => Some(length),
            };
        }
    }

    // The margin properties do not apply to table-internal elements
    style.margin = taffy::Rect::ZERO.map(style_helpers::length);

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
        start: style_helpers::line((*row).min(i16::MAX as u16) as i16),
        end: style_helpers::span(rowspan),
    };
    if rowspan == 1 && style.size.height.tag() == taffy::CompactLength::LENGTH_TAG {
        if let Some(row) = rows.last_mut() {
            row.is_constrained = true;
        }
    }

    // MailVault parity fix (plan B): a cell's `height` is a minimum (CSS 2 17.5.3): the
    // cell fills its row. Taffy does not stretch an item with a definite height, so
    // the grid sees it as a min-height instead. The cell's own style still has the
    // height, which is what its content contribution to the row is measured with.
    if style.size.height.tag() == taffy::CompactLength::LENGTH_TAG {
        style.min_size.height = style_helpers::length(style.size.height.value());
        style.size.height = style_helpers::auto();
    }

    style.size.width = style_helpers::auto();
    cells.push(TableCell {
        node_id,
        row: row.saturating_sub(1),
        column: col,
        colspan,
        rowspan,
        style,
    });

    cursor.place(colspan, rowspan);
}

pub struct RangeIter(Range<usize>);

impl Iterator for RangeIter {
    type Item = taffy::NodeId;

    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(taffy::NodeId::from)
    }
}

impl TableTreeWrapper<'_, '_> {
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
        // MailVault parity fix (plan D): see `min_content_floor`.
        let base_style = self.min_content_floor(node_id, &inputs);
        self.style_override = base_style.clone();
        let output = taffy::compute_grid_layout(self, node_id, inputs);
        let Some((widths, table_width)) = self.webkit_column_widths(output.size.width, &inputs) else {
            self.style_override = None;
            return output;
        };
        let mut style = base_style.unwrap_or_else(|| self.ctx.style.clone());
        style.grid_template_columns = widths
            .into_iter()
            .map(|width| {
                let track: TrackSizingFunction = style_helpers::length(width);
                track.into()
            })
            .collect();
        self.style_override = Some(style);
        let mut inputs = inputs;
        inputs.known_dimensions.width = Some(table_width);
        let output = taffy::compute_grid_layout(self, node_id, inputs);
        self.style_override = None;
        output
    }

    /// MailVault parity fix (plan D): a table is never narrower than its minimum content width,
    /// whatever its `width` or `max-width` says. CSS 2.1 17.5.2.2 gives an auto-layout table a
    /// minimum width of its columns' minimum content widths, and 10.4 leaves `max-width` on
    /// tables undefined. Measured in macOS WKWebView (300px container, `table {max-width:
    /// 100%}`): an auto table whose cell holds a 600px box is 600 wide; with `max-width: 200px`
    /// a table whose cell holds a 260px box is 260; a `width="100%"` table whose cell holds a
    /// `width="600"` table is 600 (and 400 for a `width="400"` one). Blitz let the width
    /// (the container's, a percentage of it, or the max-width) win and the content overflow.
    ///
    /// The table's style with `min-width` raised to its minimum content width (taffy clamps with
    /// the minimum last, so it beats the width and the `max-width`, and applies it to the
    /// available space of an auto width); None when the table's own `min-width` is already at
    /// least that (it compares against `min-width` only, not the width the table is laid out
    /// at, so a table with a definite width pays one extra grid measure), for a
    /// `table-layout: fixed` table (its columns do not follow the content, as with the `clip`
    /// table mode), and for an intrinsic query (min- and max-content answer for themselves). The
    /// measurement ignores the table's own `width`, `min-width` and `max-width`, which all
    /// clamp the grid's content size too.
    fn min_content_floor(
        &mut self,
        node_id: taffy::NodeId,
        inputs: &taffy::tree::LayoutInput,
    ) -> Option<taffy::Style<Atom>> {
        if self.ctx.is_fixed
            || (inputs.known_dimensions.width.is_none()
                && !matches!(inputs.available_space.width, taffy::AvailableSpace::Definite(_)))
        {
            return None;
        }
        let mut unclamped = self.ctx.style.clone();
        unclamped.size.width = style_helpers::auto();
        unclamped.min_size.width = style_helpers::auto();
        unclamped.max_size.width = style_helpers::auto();
        self.style_override = Some(unclamped);
        let min_content = taffy::compute_grid_layout(
            self,
            node_id,
            taffy::tree::LayoutInput {
                run_mode: taffy::RunMode::ComputeSize,
                sizing_mode: taffy::SizingMode::ContentSize,
                axis: taffy::RequestedAxis::Horizontal,
                known_dimensions: taffy::Size::NONE,
                known_dimensions_are_definite: taffy::Size { width: false, height: false },
                parent_size: inputs.parent_size,
                available_space: taffy::Size {
                    width: taffy::AvailableSpace::MinContent,
                    height: taffy::AvailableSpace::MaxContent,
                },
                vertical_margins_are_collapsible: taffy::Line::FALSE,
            },
        )
        .size
        .width;
        self.style_override = None;
        // taffy reads `min-width` as a content-box size under `box-sizing: content-box`.
        let mut floor = min_content;
        if self.ctx.style.box_sizing == taffy::BoxSizing::ContentBox {
            let padding = self.ctx.style.padding.resolve_or_zero(inputs.parent_size.width, resolve_calc_value);
            let border = self.ctx.style.border.resolve_or_zero(inputs.parent_size.width, resolve_calc_value);
            floor -= padding.left + padding.right + border.left + border.right;
        }
        let min_width = self.ctx.style.min_size.width.into_raw();
        let have = match min_width.tag() {
            taffy::CompactLength::AUTO_TAG => 0.0,
            taffy::CompactLength::LENGTH_TAG => min_width.value(),
            taffy::CompactLength::PERCENT_TAG => min_width.value() * inputs.parent_size.width?,
            _ => return None,
        };
        if floor <= have + 0.01 {
            return None;
        }
        let mut style = self.ctx.style.clone();
        style.min_size.width = style_helpers::length(floor);
        Some(style)
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

    /// The column widths and the table's border-box width when auto table layout (CSS 2
    /// 17.5.2.2, which leaves the algorithm to the user agent; the shares below are the ones
    /// measured in the harness iframe) differs from taffy's, else None. A column prefers its
    /// specified width (at least its minimum content), a percentage of the table, or for an
    /// auto column its maximum content. When the preferred widths do not fit, the overflow is
    /// taken from the auto columns first, then from the specified ones, the percentage ones
    /// last, each cut in proportion to the room it has above its minimum content width. An
    /// auto-width table whose columns ask for percentages is, laid out in a known
    /// room, as wide as the widest of them needs (clamped to the room), which taffy does not
    /// know; its reported min/max-content size is left as taffy's. Tables with rowspans are
    /// not handled.
    fn webkit_column_widths(
        &mut self,
        table_width: f32,
        inputs: &taffy::tree::LayoutInput,
    ) -> Option<(Vec<f32>, f32)> {
        let ctx = Arc::clone(&self.ctx);
        let n = ctx.column_prefs.len();
        if ctx.is_fixed
            || n < 2
            || ctx
                .cells
                .iter()
                .any(|c| c.rowspan != 1 || c.column as usize + c.colspan as usize > n)
        {
            return None;
        }
        let has_span = ctx.cells.iter().any(|c| c.colspan != 1);
        let has_percent = ctx.column_prefs.iter().any(|p| matches!(p, Some(ColumnPref::Percent(_))));
        if has_percent && inputs.available_space.width == taffy::AvailableSpace::MinContent {
            return None;
        }
        let padding = ctx.style.padding.resolve_or_zero(None, resolve_calc_value);
        let border = ctx.style.border.resolve_or_zero(None, resolve_calc_value);
        let gap = ctx.style.gap.width.resolve_or_zero(None, resolve_calc_value);
        let chrome = padding.left + padding.right + border.left + border.right + gap * (n - 1) as f32;

        let mut min = vec![0.0f32; n];
        let mut max = vec![0.0f32; n];
        for (index, cell) in ctx.cells.iter().enumerate() {
            if cell.colspan != 1 {
                continue;
            }
            let col = cell.column as usize;
            min[col] = min[col].max(self.cell_content_width(index, taffy::AvailableSpace::MinContent));
            max[col] = max[col].max(self.cell_content_width(index, taffy::AvailableSpace::MaxContent));
        }
        // MailVault parity fix (plan B): a cell spanning columns widens them only by what they do
        // not already have, shared out in proportion to their maximum content (measured in the
        // harness iframe, ours/table-cell-edges); taffy's grid shares it equally.
        for (index, cell) in ctx.cells.iter().enumerate() {
            if cell.colspan == 1 {
                continue;
            }
            let cols = cell.column as usize..cell.column as usize + cell.colspan as usize;
            let spacing = gap * (cell.colspan - 1) as f32;
            let cell_min = self.cell_content_width(index, taffy::AvailableSpace::MinContent) - spacing;
            let cell_max = self.cell_content_width(index, taffy::AvailableSpace::MaxContent) - spacing;
            let weights: Vec<f32> = cols.clone().map(|c| max[c]).collect();
            let weight_sum: f32 = weights.iter().sum();
            for (cell_width, widths) in [(cell_min, &mut min), (cell_max, &mut max)] {
                let have: f32 = widths[cols.clone()].iter().sum();
                if cell_width > have {
                    for (i, c) in cols.clone().enumerate() {
                        let share = if weight_sum > 0.0 { weights[i] / weight_sum } else { 1.0 / cell.colspan as f32 };
                        widths[c] += (cell_width - have) * share;
                    }
                }
            }
        }
        // Percentages past 100% are scaled back to 100% in proportion.
        let percent_total: f32 = ctx
            .column_prefs
            .iter()
            .map(|p| if let Some(ColumnPref::Percent(f)) = p { *f } else { 0.0 })
            .sum();
        let percent_scale = if percent_total > 1.0 { 1.0 / percent_total } else { 1.0 };
        let mut table_width = table_width;
        if has_percent
            && ctx.style.size.width.tag() == taffy::CompactLength::AUTO_TAG
            && inputs.known_dimensions.width.is_none()
        {
            if let taffy::AvailableSpace::Definite(room) = inputs.available_space.width {
                // The table's own width (not the width it reports as its intrinsic size to a
                // parent: the harness iframe keeps the two apart, which is why a percentage
                // table in a spanning cell does not widen the table around it): as wide as
                // the columns ask for, every one at its preferred width, the auto and length
                // ones scaled up so that the percentage ones get their share, clamped to the
                // room the table has.
                let preferred = |i: usize| match ctx.column_prefs[i] {
                    Some(ColumnPref::Length(pref)) => pref.max(min[i]),
                    _ => max[i].max(min[i]),
                };
                let all: f32 = (0..n).map(preferred).sum();
                let rest: f32 = (0..n)
                    .filter(|&i| !matches!(ctx.column_prefs[i], Some(ColumnPref::Percent(_))))
                    .map(preferred)
                    .sum();
                let mut wanted = all;
                if percent_total < 1.0 {
                    wanted = wanted.max(rest / (1.0 - percent_total));
                }
                for i in 0..n {
                    if let Some(ColumnPref::Percent(f)) = ctx.column_prefs[i] {
                        if f > 0.0 {
                            wanted = wanted.max(preferred(i) / (f * percent_scale));
                        }
                    }
                }
                let mut widest = (wanted + chrome).min(room);
                let max_width = self.style_override.as_ref().unwrap_or(&ctx.style).max_size.width.into_raw();
                if max_width.tag() == taffy::CompactLength::LENGTH_TAG {
                    widest = widest.min(max_width.value());
                }
                table_width = table_width.max(widest);
            }
        }
        let available = table_width - chrome;
        let mut width: Vec<f32> = (0..n)
            .map(|i| match ctx.column_prefs[i] {
                Some(ColumnPref::Length(pref)) => pref.max(min[i]),
                Some(ColumnPref::Percent(f)) => (f * percent_scale * available).max(min[i]),
                None => max[i].max(min[i]),
            })
            .collect();
        let mut overflow = width.iter().sum::<f32>() - available;
        if overflow <= 0.5 {
            if !has_percent && !has_span {
                return None;
            }
            if overflow >= -0.5 {
                return Some((width, table_width));
            }
            // Room left over (percentages under 100%): auto columns take it in proportion to
            // their maximum content, else every column in proportion to its width.
            let auto: Vec<usize> = (0..n).filter(|&i| ctx.column_prefs[i].is_none()).collect();
            let cols: Vec<usize> = if auto.is_empty() { (0..n).collect() } else { auto };
            let base: f32 = cols.iter().map(|&i| if ctx.column_prefs[i].is_none() { max[i] } else { width[i] }).sum();
            for &i in &cols {
                let share = if base > 0.0 {
                    (if ctx.column_prefs[i].is_none() { max[i] } else { width[i] }) / base
                } else {
                    1.0 / cols.len() as f32
                };
                width[i] -= overflow * share;
            }
            return Some((width, table_width));
        }
        // Cut auto columns first, then length ones, then percentage ones.
        for kind in 0..3 {
            let cols: Vec<usize> = (0..n)
                .filter(|&i| match ctx.column_prefs[i] {
                    None => kind == 0,
                    Some(ColumnPref::Length(_)) => kind == 1,
                    Some(ColumnPref::Percent(_)) => kind == 2,
                })
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
        Some((width, table_width))
    }
}

impl taffy::TraversePartialTree for TableTreeWrapper<'_, '_> {
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
impl taffy::TraverseTree for TableTreeWrapper<'_, '_> {}

impl taffy::LayoutPartialTree for TableTreeWrapper<'_, '_> {
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
        let node_id = crate::taffy_node_id(self.ctx.cells[usize::from(node_id)].node_id);
        self.doc.set_unrounded_layout(node_id, layout)
    }

    fn compute_child_layout(
        &mut self,
        node_id: taffy::NodeId,
        inputs: taffy::tree::LayoutInput,
    ) -> taffy::LayoutOutput {
        let cell = &self.ctx.cells[usize::from(node_id)];
        let dom_id = cell.node_id;
        let node_id = crate::taffy_node_id(dom_id);
        let mut inputs = inputs;

        // MailVault parity fix (plan B): in auto table layout a cell's `width` is only a
        // hint for its column's preferred width (the track's max, see `push_table_cell`).
        // Laid out as the box's own width it would also be the cell's min-content
        // contribution, and the column could never shrink below it. beta.2 set the
        // cell's own taffy width to auto; beta.4 reads the box's size straight from its
        // computed style, so the cell is measured in `ContentSize` mode instead, which
        // makes taffy ignore the box's own `width` and `height` (the grid item style
        // still carries the height as the row's minimum).
        if !self.ctx.is_fixed
            && inputs.sizing_mode == taffy::SizingMode::InherentSize
            && self.doc.nodes[dom_id].primary_styles().is_some_and(|s| {
                stylo_taffy::convert::dimension(&s.clone_width()).tag()
                    == taffy::CompactLength::LENGTH_TAG
            })
        {
            inputs.sizing_mode = taffy::SizingMode::ContentSize;
        }

        self.doc.compute_child_layout(node_id, inputs)
    }
}

impl taffy::LayoutGridContainer for TableTreeWrapper<'_, '_> {
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
