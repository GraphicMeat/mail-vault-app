use crate::node::{Node, NodeData};
use color::{AlphaColor, Srgb};
use keyboard_types::Modifiers;
use std::borrow::Cow;
use style::color::AbsoluteColor;

#[cfg(target_os = "macos")]
pub(crate) const ACTION_MOD: Modifiers = Modifiers::META;
#[cfg(not(target_os = "macos"))]
pub(crate) const ACTION_MOD: Modifiers = Modifiers::CONTROL;

pub type Color = AlphaColor<Srgb>;

/// Decode raw font bytes, decompressing WOFF/WOFF2 if the `woff` feature is enabled.
/// Returns the original slice unchanged for TTF/OTF input, and also on decompression
/// failure. With the `woff` feature disabled, all input passes through unchanged.
pub fn decode_font_bytes(bytes: &[u8]) -> Cow<'_, [u8]> {
    if bytes.len() < 4 {
        return Cow::Borrowed(bytes);
    }
    match &bytes[0..4] {
        #[cfg(feature = "woff")]
        b"wOFF" => wuff::decompress_woff1(bytes)
            .map(Cow::Owned)
            .unwrap_or_else(|_| {
                #[cfg(feature = "tracing")]
                tracing::warn!("Failed to decompress woff1 font");
                Cow::Borrowed(bytes)
            }),
        #[cfg(feature = "woff")]
        b"wOF2" => wuff::decompress_woff2(bytes)
            .map(Cow::Owned)
            .unwrap_or_else(|_| {
                #[cfg(feature = "tracing")]
                tracing::warn!("Failed to decompress woff2 font");
                Cow::Borrowed(bytes)
            }),
        _ => Cow::Borrowed(bytes),
    }
}

#[cfg(feature = "svg")]
use std::sync::{Arc, LazyLock};
#[cfg(feature = "svg")]
use usvg::fontdb;
#[cfg(feature = "svg")]
pub(crate) static FONT_DB: LazyLock<Arc<fontdb::Database>> = LazyLock::new(|| {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    Arc::new(db)
});

/// Which kind of CSS image layer list (`background-image` or `mask-image`) to
/// flush from style to dedicated storage on the node.
#[derive(Clone, Copy, Debug)]
pub enum ImageLayerKind {
    Background,
    Mask,
}

impl ImageLayerKind {
    pub fn image_type(self, idx: usize) -> ImageType {
        match self {
            Self::Background => ImageType::Background(idx),
            Self::Mask => ImageType::Mask(idx),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ImageType {
    Image,
    Background(usize),
    Mask(usize),
}

/// A point
#[derive(Clone, Debug, Copy, Eq, PartialEq)]
pub struct Point<T> {
    /// The x coordinate
    pub x: T,
    /// The y coordinate
    pub y: T,
}

impl Point<f64> {
    pub const ZERO: Self = Point { x: 0.0, y: 0.0 };
}

// Debug print an RcDom
pub fn walk_tree(indent: usize, node: &Node) {
    // Skip all-whitespace text nodes entirely
    if let NodeData::Text(data) = &node.data {
        if data.content.chars().all(|c| c.is_ascii_whitespace()) {
            return;
        }
    }

    print!("{}", " ".repeat(indent));
    let id = node.id;
    match &node.data {
        NodeData::Document(_) => println!("#Document {id}"),

        NodeData::Text(data) => {
            if data.content.chars().all(|c| c.is_ascii_whitespace()) {
                println!("{id} #text: <whitespace>");
            } else {
                let content = data.content.trim();
                if content.len() > 10 {
                    println!(
                        "#text {id}: {}...",
                        content
                            .split_at(content.char_indices().take(10).last().unwrap().0)
                            .0
                            .escape_default()
                    )
                } else {
                    println!("#text {id}: {}", data.content.trim().escape_default())
                }
            }
        }

        NodeData::Comment { .. } => println!("<!-- COMMENT {id} -->"),

        NodeData::AnonymousBlock(_) => println!("{id} AnonymousBlock"),

        NodeData::Element(data) => {
            print!("<{} {id}", data.name.local);
            for attr in data.attrs.iter() {
                print!(" {}=\"{}\"", attr.name.local, attr.value);
            }
            if !node.children.is_empty() {
                println!(">");
            } else {
                println!("/>");
            }
        } // NodeData::Doctype {
          //     ref name,
          //     ref public_id,
          //     ref system_id,
          // } => println!("<!DOCTYPE {} \"{}\" \"{}\">", name, public_id, system_id),
          // NodeData::ProcessingInstruction { .. } => unreachable!(),
    }

    if !node.children.is_empty() {
        for child_id in node.children.iter() {
            walk_tree(indent + 2, node.with(*child_id));
        }

        if let NodeData::Element(data) = &node.data {
            println!("{}</{}>", " ".repeat(indent), data.name.local);
        }
    }
}

/// MailVault parity fix (plan B): the pixel cap for one raster an SVG embeds, and the
/// total an SVG may embed. Same figure as `MAX_IMAGE_PIXELS` in src-render/src/net.rs
/// (this crate cannot depend on mailvault-render).
#[cfg(feature = "svg")]
pub(crate) const MAX_SVG_IMAGE_PIXELS: u64 = 16_000_000;

/// MailVault parity fix (plan B): the most vector nodes (groups, paths, images, text) one
/// parsed SVG may keep. A real logo or icon is a few hundred; usvg expands `<use>` by copying
/// the linked subtree, so a kilobyte of fan-out becomes a tree of a million nodes. The
/// transient cost of building one is bounded by usvg's own 1,000,000-element cap (a few
/// hundred MiB at worst, freed when the tree is refused here); only what passes this is
/// retained, and `BaseDocument::charge_svg_nodes` charges it against `MAX_DOC_SVG_NODES`.
#[cfg(feature = "svg")]
pub(crate) const MAX_SVG_TREE_NODES: u64 = 50_000;

/// MailVault parity fix (plan B): the vector nodes all the SVG trees of one document may
/// keep together (inline `<svg>`, `<img>` and CSS images; a tree shared by URL counts once).
#[cfg(feature = "svg")]
pub(crate) const MAX_DOC_SVG_NODES: u64 = 200_000;

/// Nodes of a converted tree, subtrees of clip paths, masks, patterns and flattened text
/// included. Recursion is as deep as usvg let the SVG nest (1024 levels at most).
#[cfg(feature = "svg")]
fn count_tree_nodes(tree: &usvg::Tree) -> u64 {
    fn walk(group: &usvg::Group, count: &mut u64) {
        for node in group.children() {
            *count += 1;
            if let usvg::Node::Group(g) = node {
                walk(g, count);
            }
            node.subroots(|sub| walk(sub, count));
        }
    }
    let mut count = 0;
    walk(tree.root(), &mut count);
    count
}

/// MailVault parity fix (plan B): an href resolver that can never read a file or fetch a url.
/// usvg's default `resolve_string` opens any non-`data:` href as a local file path (a UNC
/// share on Windows), so a mail could read the machine's files through `<image href>`.
/// Here `resolve_string` is always `None`, and `resolve_data` accepts only a PNG, JPEG, GIF
/// or WebP whose header declares at most `MAX_SVG_IMAGE_PIXELS` pixels (read with
/// `imagesize`, before anything decodes it) and, summed over this document, no more than
/// that either (`budget` counts down). Nested SVG is refused (no recursion), whatever the
/// declared type.
#[cfg(feature = "svg")]
fn safe_image_href_resolver(budget: Arc<std::sync::atomic::AtomicU64>) -> usvg::ImageHrefResolver<'static> {
    use std::sync::atomic::Ordering;
    usvg::ImageHrefResolver {
        resolve_data: Box::new(move |_mime, data, _opts| {
            // Trust the bytes, not the declared mime type.
            let kind = match imagesize::image_type(&data).ok()? {
                imagesize::ImageType::Png => usvg::ImageKind::PNG(Arc::clone(&data)),
                imagesize::ImageType::Jpeg => usvg::ImageKind::JPEG(Arc::clone(&data)),
                imagesize::ImageType::Gif => usvg::ImageKind::GIF(Arc::clone(&data)),
                imagesize::ImageType::Webp => usvg::ImageKind::WEBP(Arc::clone(&data)),
                _ => return None,
            };
            let size = imagesize::blob_size(&data).ok()?;
            let pixels = (size.width as u64).saturating_mul(size.height as u64);
            budget
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| left.checked_sub(pixels))
                .ok()?;
            Some(kind)
        }),
        resolve_string: Box::new(|_href, _opts| None),
    }
}

/// Parse an SVG image.
#[cfg(feature = "svg")]
pub(crate) fn parse_svg_image(source: &[u8]) -> Result<crate::node::SvgImageData, usvg::Error> {
    use std::sync::atomic::{AtomicU64, Ordering};
    let budget = Arc::new(AtomicU64::new(MAX_SVG_IMAGE_PIXELS));
    let options = usvg::Options {
        fontdb: Arc::clone(&*FONT_DB),
        // MailVault parity fix (plan B): no file or url access from inside an SVG.
        image_href_resolver: safe_image_href_resolver(Arc::clone(&budget)),
        ..Default::default()
    };
    let mut svg = crate::node::SvgImageData::from_data(source, &options)?;
    // MailVault parity fix (plan B): refuse a tree past the per-SVG cap (nothing is kept).
    svg.nodes = count_tree_nodes(&svg.tree);
    if svg.nodes > MAX_SVG_TREE_NODES {
        return Err(usvg::Error::ElementsLimitReached);
    }
    // MailVault parity fix (plan B): what the resolver let through, for the document's
    // per-use budget (`BaseDocument::admit_image_use`).
    svg.nested_pixels = MAX_SVG_IMAGE_PIXELS - budget.load(Ordering::Acquire);
    Ok(svg)
}

pub trait ToColorColor {
    /// Converts a color into the `AlphaColor<Srgb>` type from the `color` crate
    fn as_color_color(&self) -> Color;
}
impl ToColorColor for AbsoluteColor {
    fn as_color_color(&self) -> Color {
        Color::new(
            *self
                .to_color_space(style::color::ColorSpace::Srgb)
                .raw_components(),
        )
    }
}

#[cfg(all(test, feature = "svg"))]
mod svg_tests {
    use super::parse_svg_image;

    #[test]
    fn svg_without_xmlns_parses() {
        let src = br#"<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>"#;
        let svg = parse_svg_image(src).unwrap();
        assert!(!svg.tree.root().children().is_empty());
    }

    #[test]
    fn missing_height_is_computed_from_width_and_viewbox_ratio() {
        let src = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200"><rect width="100%" height="100%" fill="green"/></svg>"#;
        let svg = parse_svg_image(src).unwrap();
        assert_eq!(svg.intrinsic_width(), Some(200.0));
        assert_eq!(svg.intrinsic_height(), None);
        assert_eq!(svg.viewbox_aspect_ratio(), Some(1.0));
        assert_eq!(svg.tree.size().width(), 200.0);
        assert_eq!(svg.intrinsic_size(), (200.0, 200.0));
    }

    #[test]
    fn viewbox_only_has_no_intrinsic_dimensions() {
        let src = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 485 58"></svg>"#;
        let svg = parse_svg_image(src).unwrap();
        assert_eq!(svg.intrinsic_width(), None);
        assert_eq!(svg.intrinsic_height(), None);
        // The aspect ratio is still available from the viewBox.
        assert!((svg.aspect_ratio() - (485.0 / 58.0)).abs() < 1e-3);
    }

    #[test]
    fn absolute_dimensions_are_intrinsic() {
        let src = br#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 48 32"></svg>"#;
        let svg = parse_svg_image(src).unwrap();
        assert_eq!(svg.intrinsic_width(), Some(24.0));
        assert_eq!(svg.intrinsic_height(), Some(16.0));
    }

    #[test]
    fn percentage_dimensions_are_not_intrinsic() {
        let src = br#"<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="50%" viewBox="0 0 200 100"></svg>"#;
        let svg = parse_svg_image(src).unwrap();
        assert_eq!(svg.intrinsic_width(), None);
        assert_eq!(svg.intrinsic_height(), None);
    }

    #[test]
    fn unit_lengths_are_intrinsic() {
        let src = br#"<svg xmlns="http://www.w3.org/2000/svg" width="24px" height="1.5em" viewBox="0 0 48 32"></svg>"#;
        let svg = parse_svg_image(src).unwrap();
        assert!(svg.intrinsic_width().is_some());
        assert!(svg.intrinsic_height().is_some());
    }

    #[test]
    fn non_numeric_dimensions_are_not_intrinsic() {
        let src = br#"<svg xmlns="http://www.w3.org/2000/svg" width="auto" height="foo" viewBox="0 0 200 100"></svg>"#;
        let svg = parse_svg_image(src).unwrap();
        assert_eq!(svg.intrinsic_width(), None);
        assert_eq!(svg.intrinsic_height(), None);
    }
}

/// Creates an markup5ever::QualName.
/// Given a local name and an optional namespace
#[macro_export]
macro_rules! qual_name {
    ($local:tt $(, $ns:ident)?) => {
        $crate::QualName {
            prefix: None,
            ns: $crate::ns!($($ns)?),
            local: $crate::local_name!($local),
        }
    };
}
