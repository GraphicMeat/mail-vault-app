// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/inject/dynamic-theme/stylesheet-modifier.ts, src/inject/dynamic-theme/css-rules.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
use super::cssom::{iterate_declarations, StyleBlock};
use super::modify_css::{modifiable_declaration, DeclValue, ModifiedDecl, RuleStyle};
use super::DarkCx;
use style::shared_lock::SharedRwLockReadGuard;
use style::stylesheets::CssRule;
use style_traits::ToCss;

/// `ignoredMedia` (css-rules.ts): a `<style media=...>` equal to one of these
/// is not managed at all, and an `@media` that is only these is skipped.
pub const IGNORED_MEDIA: &[&str] = &["aural", "braille", "embossed", "handheld", "print", "projection", "speech", "tty", "tv"];

/// `shouldManageStyle`'s `!ignoredMedia.includes(element.media.toLowerCase())`.
pub fn is_managed_media(media_attr: Option<&str>) -> bool {
    !media_attr.is_some_and(|m| IGNORED_MEDIA.contains(&m.to_lowercase().as_str()))
}

/// `iterateCSSRules`' test for an `@media` block: screen, all or a bare
/// query is managed; so is anything that is not only print and its kin.
pub fn media_applies(queries: &[String]) -> bool {
    let screen_or_all_or_query = queries.iter().any(|q| q.starts_with("screen") || q.starts_with("all") || q.starts_with('('));
    let not_screen = !screen_or_all_or_query && queries.iter().any(|q| IGNORED_MEDIA.iter().any(|i| q.starts_with(i)));
    screen_or_all_or_query || !not_screen
}

/// The sync sheet DR writes after this sheet's `<style>`: every rule with at
/// least one modifiable declaration, with its media/layer/nesting groups.
pub fn sync_css(rules: &[CssRule], g: &SharedRwLockReadGuard, cx: &mut DarkCx) -> String {
    let mut out = String::new();
    write_rules(rules, g, cx, &mut out);
    out
}

fn write_rules(rules: &[CssRule], g: &SharedRwLockReadGuard, cx: &mut DarkCx, out: &mut String) {
    for rule in rules {
        match rule {
            CssRule::Style(lock) => {
                let r = lock.read_with(g);
                let selector = cssparser::ToCss::to_css_string(&r.selectors);
                let style = StyleBlock { block: r.block.read_with(g), selector: selector.clone() };
                if let Some(text) = rule_text(&style, cx) {
                    out.push_str(&text);
                    out.push('\n');
                }
                if let Some(nested) = &r.rules {
                    let mut inner = String::new();
                    write_rules(&nested.read_with(g).0, g, cx, &mut inner);
                    if !inner.is_empty() {
                        out.push_str(&format!("{selector} {{\n{inner}}}\n"));
                    }
                }
            }
            CssRule::Media(m) => {
                let queries: Vec<String> = m.media_queries.read_with(g).media_queries.iter().map(|q| q.to_css_string()).collect();
                if media_applies(&queries) {
                    let mut inner = String::new();
                    write_rules(&m.rules.read_with(g).0, g, cx, &mut inner);
                    if !inner.is_empty() {
                        out.push_str(&format!("@media {} {{\n{inner}}}\n", queries.join(", ")));
                    }
                }
            }
            CssRule::Supports(s) if s.enabled => write_rules(&s.rules.read_with(g).0, g, cx, out),
            CssRule::LayerBlock(l) => {
                let name = l.name.as_ref().map(|n| n.to_css_string()).unwrap_or_default();
                let mut inner = String::new();
                write_rules(&l.rules.read_with(g).0, g, cx, &mut inner);
                if !inner.is_empty() {
                    out.push_str(&format!("@layer {name} {{\n{inner}}}\n"));
                }
            }
            _ => {} // @import (denied), @font-face, @keyframes, @layer statements: DR skips them
        }
    }
}

fn rule_text(style: &StyleBlock, cx: &mut DarkCx) -> Option<String> {
    if style.get_property_value("all") == "revert" {
        return None;
    }
    let mut decls: Vec<ModifiedDecl> = Vec::new();
    iterate_declarations(style, cx.profile.is_safari, |p, v| {
        if let Some(d) = modifiable_declaration(p, v, style, cx) {
            decls.push(d);
        }
    });
    if decls.is_empty() {
        return None;
    }
    // setRule: `${selector} {` + ` ${property}: ${value}${important};` + ' }'
    let mut text = format!("{} {{", style.selector);
    for d in &decls {
        let imp = if d.important { " !important" } else { "" };
        match &d.value {
            DeclValue::Text(v) if !v.is_empty() => text.push_str(&format!(" {}: {v}{imp};", d.property)),
            DeclValue::Text(_) => {}
            DeclValue::Vars(list) if list.is_empty() => text.push_str(&format!(" {}: {}{imp};", d.property, d.source_value)),
            DeclValue::Vars(list) => {
                for (p, v) in list.iter().filter(|(_, v)| !v.is_empty()) {
                    text.push_str(&format!(" {p}: {v}{imp};"));
                }
            }
        }
    }
    text.push_str(" }");
    Some(text)
}
