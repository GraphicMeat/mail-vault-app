// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/inject/dynamic-theme/css-rules.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::modify_css::RuleStyle;
use fancy_regex::Regex;
use style::properties::{PropertyDeclarationBlock, PropertyId};

/// A CSSOM `CSSStyleDeclaration` over a Stylo block. Stylo, like the CSSOM,
/// stores longhands (shorthands expanded), serialises a pending-substitution
/// longhand as "", and serialises shorthands for `getPropertyValue`.
pub struct StyleBlock<'a> {
    pub block: &'a PropertyDeclarationBlock,
    pub selector: String,
}

impl RuleStyle for StyleBlock<'_> {
    fn get_property_value(&self, property: &str) -> String {
        let Ok(id) = PropertyId::parse_enabled_for_all_content(property) else { return String::new() };
        let mut s = String::new();
        let _ = self.block.property_value_to_css(&id, &mut s);
        s
    }

    fn get_property_priority(&self, property: &str) -> bool {
        PropertyId::parse_enabled_for_all_content(property).map_or(false, |id| self.block.property_priority(&id).important())
    }

    fn selector_text(&self) -> String {
        self.selector.clone()
    }
}

impl StyleBlock<'_> {
    pub fn css_text(&self) -> String {
        let mut s = String::new();
        let _ = self.block.to_css(&mut s);
        s
    }

    /// `forEach(style, ...)`: longhand and custom-property names, in declaration order.
    pub fn property_names(&self) -> Vec<String> {
        self.block.declarations().iter().map(|d| d.id().name().into_owned()).collect()
    }
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
    for name in style.property_names() {
        let value = style.get_property_value(&name);
        let value = value.trim();
        if !value.is_empty() {
            f(&name, value);
        }
    }
}
