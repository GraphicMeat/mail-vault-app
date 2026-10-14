// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/inject/dynamic-theme/css-rules.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::modify_css::RuleStyle;
use fancy_regex::Regex;
use std::cell::OnceCell;
use std::collections::HashMap;
use style::properties::{PropertyDeclaration, PropertyDeclarationBlock, PropertyId};

/// A CSSOM `CSSStyleDeclaration` over a Stylo block. Stylo, like the CSSOM,
/// stores longhands (shorthands expanded), serialises a pending-substitution
/// longhand as "", and serialises shorthands for `getPropertyValue`.
///
/// Stylo finds a longhand or custom property by a linear scan of the block, so a
/// lookup per declaration is quadratic in a block's size (a mail can hold a
/// `:root` with 100k custom properties). Longhand and custom lookups go through a
/// name index built once per block instead; shorthands keep Stylo's own path.
pub struct StyleBlock<'a> {
    pub block: &'a PropertyDeclarationBlock,
    pub selector: String,
    index: OnceCell<HashMap<String, usize>>,
}

impl RuleStyle for StyleBlock<'_> {
    fn get_property_value(&self, property: &str) -> String {
        let Ok(id) = PropertyId::parse_enabled_for_all_content(property) else { return String::new() };
        let mut s = String::new();
        match id.as_shorthand() {
            Ok(_) => {
                let _ = self.block.property_value_to_css(&id, &mut s);
            }
            Err(longhand_or_custom) => {
                if let Some(i) = self.position(&longhand_or_custom.name()) {
                    let _ = self.block.declarations()[i].to_css(&mut s);
                }
            }
        }
        s
    }

    fn get_property_priority(&self, property: &str) -> bool {
        let Ok(id) = PropertyId::parse_enabled_for_all_content(property) else { return false };
        match id.as_shorthand() {
            Ok(_) => self.block.property_priority(&id).important(),
            Err(longhand_or_custom) => self
                .position(&longhand_or_custom.name())
                .is_some_and(|i| self.block.declarations_importance().get(i).unwrap_or(false)),
        }
    }

    fn selector_text(&self) -> String {
        self.selector.clone()
    }
}

impl<'a> StyleBlock<'a> {
    pub fn new(block: &'a PropertyDeclarationBlock, selector: String) -> Self {
        StyleBlock { block, selector, index: OnceCell::new() }
    }

    /// Where the declaration of a longhand or custom property sits in the block
    /// (a block holds at most one per property).
    fn position(&self, name: &str) -> Option<usize> {
        self.index
            .get_or_init(|| self.block.declarations().iter().enumerate().map(|(i, d)| (d.id().name().into_owned(), i)).collect())
            .get(name)
            .copied()
    }

    pub fn css_text(&self) -> String {
        let mut s = String::new();
        let _ = self.block.to_css(&mut s);
        s
    }
}

/// `getPropertyValue(name)` for a declaration of the block itself: Stylo's
/// `property_value_to_css` finds that same declaration and serialises it.
fn declaration_value(d: &PropertyDeclaration) -> String {
    let mut s = String::new();
    let _ = d.to_css(&mut s);
    s
}

const SHORTHAND_VAR_DEPENDANT: &[&str] =
    &["background", "border", "border-color", "border-bottom", "border-left", "border-right", "border-top", "outline", "outline-color"];

/// `iterateCSSDeclarations`. The Chromium-only `handleEmptyShorthand` is not
/// ported: Stylo never serialises `background-color: ;`.
pub fn iterate_declarations(style: &StyleBlock, is_safari: bool, mut f: impl FnMut(&str, &str)) {
    let css_text = style.css_text();
    if css_text.contains("var(") {
        for prop in SHORTHAND_VAR_DEPENDANT {
            if is_safari {
                let re = Regex::new(&format!(r"{prop}:\s*(.*?)\s*;")).unwrap();
                if let Ok(Some(m)) = re.captures(&css_text) {
                    if let Some(v) = m.get(1).map(|x| x.as_str().trim()).filter(|v| !v.is_empty()) {
                        f(prop, v);
                    }
                }
            } else {
                let v = style.get_property_value(prop);
                if v.contains("var(") {
                    f(prop, &v);
                }
            }
        }
    }
    for d in style.block.declarations() {
        let value = declaration_value(d);
        let value = value.trim();
        if !value.is_empty() {
            f(&d.id().name(), value);
        }
    }
}
