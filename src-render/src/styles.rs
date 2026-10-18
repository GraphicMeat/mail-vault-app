//! The one place that rewrites `<style>` text before the first resolve.
//!
//! Light and dark: Blitz 0.3.0-beta.2 parses every `<style>` with an empty
//! MediaList (`BaseDocument::make_stylesheet`), so a `media` attribute is
//! ignored. That lets rules meant for print, or for a neutralised
//! `(mv-suppressed-color-scheme: dark)` query, apply on screen. Wrapping the
//! sheet's own rules in `@media <attr> { ... }` restores browser semantics
//! without an engine change. It also leaves room after the block for Dark
//! Reader's sync rules, which DR injects with `media="screen"` whatever the
//! original said (plan B Task 13).
//!
//! Sheets are rewritten in place and never added: author sheets are ordered
//! by NodeId, so a new node would sort after every parsed sheet.
use blitz_dom::node::SpecialElementData;
use blitz_dom::{BaseDocument, LocalName, NodeId};
use std::borrow::Cow;
use style::context::QuirksMode;
use style::media_queries::MediaList;
use style::parser::ParserContext;
use style::shared_lock::{SharedRwLockReadGuard, ToCssWithGuard};
use style::stylesheets::{CssRule, CssRuleType, Namespaces, Origin, StylesheetInDocument};
use style_traits::{ParsingMode, ToCss};

pub struct StyleNode {
    pub id: NodeId,
    pub text_node: Option<NodeId>,
    pub extra_text: Vec<NodeId>,
    pub media: Option<String>,
}

pub fn style_nodes(doc: &BaseDocument) -> Vec<StyleNode> {
    let style = LocalName::from("style");
    let media = LocalName::from("media");
    let mut out = Vec::new();
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else { continue };
        if node.data.is_element_with_tag_name(&style) {
            let texts: Vec<NodeId> = node
                .children
                .iter()
                .copied()
                .filter(|c| doc.get_node(*c).map_or(false, |n| n.is_text_node()))
                .collect();
            out.push(StyleNode {
                id,
                text_node: texts.first().copied(),
                extra_text: texts.iter().skip(1).copied().collect(),
                media: node.attr(media.clone()).map(str::to_string),
            });
        }
        stack.extend(node.children.iter().rev().copied());
    }
    out
}

pub fn with_rules<R>(
    doc: &BaseDocument,
    style: NodeId,
    f: impl FnOnce(&[CssRule], &SharedRwLockReadGuard) -> R,
) -> Option<R> {
    let el = doc.get_node(style)?.element_data()?;
    let SpecialElementData::Stylesheet(sheet) = &el.special_data else { return None };
    let guard = doc.guard().read();
    let rules = sheet.contents(&guard).rules(&guard);
    Some(f(rules, &guard))
}

pub fn serialize_rules(rules: &[CssRule], guard: &SharedRwLockReadGuard) -> String {
    let mut out = String::new();
    for rule in rules {
        out.push_str(&rule.to_css_string(guard));
        out.push('\n');
    }
    out
}

/// The `media` attribute of `style`, read the way a browser reads it: a media query list
/// (an invalid query is `not all`), serialised back. Pasting the raw attribute into
/// `@media ... { }` let a `/*`, `{` or `}` in it swallow or break out of the wrapper. None
/// for an empty list (the sheet applies everywhere).
fn media_list_text(doc: &BaseDocument, style: NodeId, attr: &str) -> Option<String> {
    let el = doc.get_node(style)?.element_data()?;
    let SpecialElementData::Stylesheet(sheet) = &el.special_data else { return None };
    let guard = doc.guard().read();
    let url_data = sheet.contents(&guard).url_data.clone();
    let mut context = ParserContext::new(
        Origin::Author,
        &url_data,
        Some(CssRuleType::Media),
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        Cow::Owned(Namespaces::default()),
        None,
        None,
        Default::default(),
    );
    let list = MediaList::parse(&mut context, &mut cssparser::Parser::new(attr));
    let text = list.to_css_string();
    (!text.is_empty()).then_some(text)
}

#[derive(Default)]
pub struct Rewrite {
    pub prefix: String,
    pub suffix: String,
}

/// Rewrite each `<style>` (tree order, index `i`) as `prefix + body + suffix`.
/// `body` is the sheet's own rules, wrapped in `@media <attr> { }` when the
/// element has a non-empty `media` attribute. A style with no media and no
/// prefix or suffix is left untouched.
pub fn rewrite(doc: &mut BaseDocument, mut extra: impl FnMut(usize, NodeId) -> Rewrite) {
    let nodes = style_nodes(doc);
    let mut edits = Vec::new();
    for (i, s) in nodes.iter().enumerate() {
        let x = extra(i, s.id);
        let media = s.media.as_deref().map(str::trim).filter(|m| !m.is_empty()).and_then(|m| media_list_text(doc, s.id, m));
        if media.is_none() && x.prefix.is_empty() && x.suffix.is_empty() {
            continue;
        }
        let body = with_rules(doc, s.id, serialize_rules).unwrap_or_default();
        let body = match media {
            Some(m) => format!("@media {m} {{\n{body}}}\n"),
            None => body,
        };
        edits.push((s.id, s.text_node, s.extra_text.clone(), format!("{}{}{}", x.prefix, body, x.suffix)));
    }
    let mut m = doc.mutate();
    for (style, text, extra_text, css) in edits {
        // blitz-dom decodes HTML entities in `<style>` text whenever it parses a sheet. The
        // text set here is CSS already decoded once; escaping `&` makes that second decode
        // give back exactly this text (`&amp;lt;` in the mail stays `&lt;`, not `<`).
        let css = css.replace('&', "&amp;");
        for t in extra_text {
            m.remove_and_drop_node(t);
        }
        match text {
            Some(t) => m.set_node_text(t, &css),
            None => {
                let t = m.create_text_node(&css);
                m.append_children(style, &[t]);
            }
        }
    }
    // Dropping the mutator flushes: process_style_element re-parses every
    // <style> whose text changed.
}
