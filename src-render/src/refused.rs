//! Pictures the net provider refused for size (`BridgeNet::refused`). A refused
//! `<img>` has no pixels and would lay out empty, so it is given a box of its
//! header's shape and reported with that box: the reader lays a button over it
//! that opens the original. Only an `<img>` the pre-pass stamped `data-mv-img`
//! is reported (its number is how the reader finds the picture's src).
use crate::net::BridgeNet;
use blitz_dom::{local_name, ns, BaseDocument, LocalName, NodeId, QualName};
use serde::Serialize;

/// The box a refused picture is drawn in is its own shape, fitted into this.
const FIT_W: f32 = 400.0;
const FIT_H: f32 = 300.0;
/// No smaller than a button needs; also the box of a picture whose header says nothing.
const MIN_W: f32 = 160.0;
const MIN_H: f32 = 56.0;
const STAMP: &str = "data-mv-img";
const DONE: &str = "data-mv-big";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefusedImage {
    /// The `data-mv-img` number the pre-pass stamped.
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// The (width, height) of the box for a picture declaring `w` x `h`, in a document `max_w` wide.
fn box_size(w: u32, h: u32, max_w: f32) -> (f32, f32) {
    let max_w = max_w.max(1.0);
    let fit_w = FIT_W.min(max_w);
    let min_w = MIN_W.min(max_w);
    if w == 0 || h == 0 {
        return (fit_w.min(MIN_W * 2.0), MIN_H * 2.0);
    }
    let scale = (fit_w / w as f32).min(FIT_H / h as f32).min(1.0);
    ((w as f32 * scale).max(min_w).round(), (h as f32 * scale).max(MIN_H).round())
}

fn refused_nodes(doc: &BaseDocument, net: &BridgeNet) -> Vec<(NodeId, String, (u32, u32))> {
    if !net.has_refused() {
        return Vec::new();
    }
    let Ok(ids) = doc.query_selector_all(&format!("img[{STAMP}]")) else { return Vec::new() };
    let base = doc.base_url();
    ids.iter()
        .filter_map(|&n| {
            let node = doc.get_node(n)?;
            let id = node.attr(LocalName::from(STAMP))?.to_string();
            // The url blitz asked for: the same join `net::img_srcs` makes.
            let url = base.join(node.attr(local_name!("src"))?).ok()?.to_string();
            Some((n, id, net.refused(&url)?))
        })
        .collect()
}

/// Give every refused picture the box of its shape, tinted so it reads as a frame.
/// True when something changed and the document needs a relayout.
pub fn frame(doc: &mut BaseDocument, net: &BridgeNet, max_w: f32) -> bool {
    let todo: Vec<(NodeId, (u32, u32))> = refused_nodes(doc, net)
        .into_iter()
        .filter(|(n, ..)| doc.get_node(*n).and_then(|k| k.attr(LocalName::from(DONE))).is_none())
        .map(|(n, _, dims)| (n, dims))
        .collect();
    if todo.is_empty() {
        return false;
    }
    let mut m = doc.mutate();
    for (n, (w, h)) in todo {
        let (bw, bh) = box_size(w, h, max_w);
        m.set_attribute(n, QualName::new(None, ns!(), LocalName::from(DONE)), "1");
        for (k, v) in [
            ("display", "inline-block".to_string()),
            ("width", format!("{bw}px")),
            ("height", format!("{bh}px")),
            ("max-width", "100%".to_string()),
            ("background-color", "rgba(128, 128, 128, 0.14)".to_string()),
            ("border", "1px dashed rgba(128, 128, 128, 0.55)".to_string()),
            ("box-sizing", "border-box".to_string()),
        ] {
            m.set_style_property(n, k, &v);
        }
    }
    true
}

/// Where each refused picture sits, in document CSS px.
pub fn read(doc: &BaseDocument, net: &BridgeNet) -> Vec<RefusedImage> {
    refused_nodes(doc, net)
        .into_iter()
        .filter_map(|(n, id, _)| {
            let node = doc.get_node(n)?;
            let (l, p) = (node.final_layout(), node.absolute_position(0.0, 0.0));
            (l.size.width >= 1.0 && l.size.height >= 1.0).then_some(RefusedImage { id, x: p.x, y: p.y, w: l.size.width, h: l.size.height })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_box_keeps_the_shape_inside_the_fit() {
        assert_eq!(box_size(20_000, 20_000, 600.0), (300.0, 300.0));
        assert_eq!(box_size(30_000, 10_000, 600.0), (400.0, 133.0));
    }

    #[test]
    fn the_box_is_never_wider_than_the_document_nor_smaller_than_a_button() {
        assert_eq!(box_size(20_000, 20_000, 200.0).0, 200.0);
        let (w, h) = box_size(100_000, 100, 600.0);
        assert!(w >= MIN_W && h >= MIN_H, "{w}x{h}");
    }

    #[test]
    fn a_picture_that_says_nothing_gets_a_default_box() {
        assert_eq!(box_size(0, 0, 600.0), (320.0, 112.0));
    }
}
