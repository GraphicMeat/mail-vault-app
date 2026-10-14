// Ported from Dark Reader v4.9.120 (https://github.com/darkreader/darkreader,
// tag v4.9.120, commit 90c39130c7b4c79068f26aaa596071c14e3425c4):
// src/inject/dynamic-theme/variables.ts.
// Copyright (c) 2026 Dark Reader Ltd. MIT License; see
// public/licenses/rust/darkreader-mit.txt.
//! CSS custom properties. Dark Reader types every `--x` by how it is used
//! (background, text, border, background image), then writes one
//! `--darkreader-<type>--x` variable per use, and rewrites `var(--x)` to point
//! at the right one.
//!
//! Dark Reader works on a live page: it queues rules, matches once, renders,
//! and re-renders each declaration whose variable changes type later
//! (`onTypeChange`). Here the document is closed, so the store is filled
//! first, matched (twice, as DR does: after the sheets, then after the inline
//! styles), and every modifier reads the settled types. Nothing is subscribed.
use super::color::{fmt_js_number, get_rgb_values, parse_color};
use super::cssom::{iterate_declarations, StyleBlock};
use super::modify_colors::{modify_background_color, modify_border_color, modify_foreground_color};
use super::modify_css::{bg_image_modifier, shadow_modifier, RuleStyle};
use super::text::get_parentheses_range;
use super::DarkCx;
use blitz_dom::{BaseDocument, LocalName};
use fancy_regex::Regex;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;
use style::shared_lock::SharedRwLockReadGuard;
use style::stylesheets::CssRule;
use style_traits::ToCss;

pub const VAR_TYPE_BG_COLOR: u8 = 1;
pub const VAR_TYPE_TEXT_COLOR: u8 = 2;
pub const VAR_TYPE_BORDER_COLOR: u8 = 4;
pub const VAR_TYPE_BG_IMG: u8 = 8;
const ANY_COLOR: u8 = VAR_TYPE_BG_COLOR | VAR_TYPE_TEXT_COLOR | VAR_TYPE_BORDER_COLOR;

/// A mail's CSS decides how deep these go; the real DR page has the same
/// exposure, but a worker must not overflow its stack or spend minutes on one
/// message. Past a limit a value is simply left unresolved.
const MAX_NESTING: usize = 64;
/// Calls and output length of one `insertVarValues`, whose stack copy makes
/// `rgb(var(--a), var(--a), var(--a))` chains grow as 3^depth.
const MAX_INSERT_CALLS: usize = 2048;
const MAX_INSERT_LEN: usize = 64 * 1024;

/// DR's `shouldSetDefaultColor`: false only on ebay hostnames. The reader's
/// srcdoc iframe is never one.
const SHOULD_SET_DEFAULT_COLOR: bool = true;

/// A JS `Set<string>`: insertion order, membership test. Mail can define
/// thousands of variables, so every operation is O(log n).
#[derive(Default, Clone)]
struct StrSet {
    seq: u64,
    index: HashMap<String, u64>,
    order: BTreeMap<u64, String>,
}

impl StrSet {
    fn insert(&mut self, s: &str) {
        if !self.index.contains_key(s) {
            self.index.insert(s.to_string(), self.seq);
            self.order.insert(self.seq, s.to_string());
            self.seq += 1;
        }
    }
    fn remove(&mut self, s: &str) {
        if let Some(n) = self.index.remove(s) {
            self.order.remove(&n);
        }
    }
    fn contains(&self, s: &str) -> bool {
        self.index.contains_key(s)
    }
    fn items(&self) -> Vec<String> {
        self.order.values().cloned().collect()
    }
}

#[derive(Default)]
pub struct VariablesStore {
    var_types: HashMap<String, u8>,
    defined_vars: HashSet<String>,
    /// `varRefs`: a Map, whose `forEach` order matters (types propagate one hop per entry).
    var_refs_order: Vec<String>,
    var_refs: HashMap<String, StrSet>,
    unknown_color_vars: StrSet,
    unknown_bg_vars: StrSet,
    unstable_var_values: HashMap<String, String>,
    /// `rulesQueue` / `inlineStyleQueue`, flattened to the declarations
    /// `iterateCSSDeclarations` yields, in order.
    rule_decls: Vec<(String, String)>,
    inline_decls: Vec<(String, String)>,
    rules_queued: bool,
    inline_queued: bool,
    /// `document.documentElement.style`, kept only when the attribute holds `--`.
    root_decls: Option<Vec<(String, String)>>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Bg,
    Text,
    Border,
}

impl Kind {
    fn type_bit(self) -> u8 {
        match self {
            Kind::Bg => VAR_TYPE_BG_COLOR,
            Kind::Text => VAR_TYPE_TEXT_COLOR,
            Kind::Border => VAR_TYPE_BORDER_COLOR,
        }
    }
    fn wrap(self, name: &str) -> String {
        match self {
            Kind::Bg => wrap_bg_color_variable_name(name),
            Kind::Text => wrap_text_color_variable_name(name),
            Kind::Border => wrap_border_color_variable_name(name),
        }
    }
}

fn snapshot(style: &StyleBlock, is_safari: bool) -> Vec<(String, String)> {
    let mut out = Vec::new();
    iterate_declarations(style, is_safari, |p, v| out.push((p.to_string(), v.to_string())));
    out
}

impl VariablesStore {
    fn is_var_type(&self, var_name: &str, type_num: u8) -> bool {
        self.var_types.get(var_name).is_some_and(|t| t & type_num > 0)
    }

    /// `addRulesForMatching`, for one style rule.
    pub fn queue_rules(&mut self, style: &StyleBlock, is_safari: bool) {
        self.rules_queued = true;
        self.rule_decls.extend(snapshot(style, is_safari));
    }

    /// `addInlineStyleForMatching`.
    pub fn queue_inline(&mut self, style: &StyleBlock, is_safari: bool) {
        self.inline_queued = true;
        self.inline_decls.extend(snapshot(style, is_safari));
    }

    /// `<html>`'s own inline style, which DR reads on every match
    /// (`shouldProcessRootVariables`). The caller passes it only when the
    /// attribute text contains `--`.
    pub fn set_root_style(&mut self, style: &StyleBlock, is_safari: bool) {
        self.root_decls = Some(snapshot(style, is_safari));
    }

    /// `matchVariablesAndDependents`, without the type-change subscriptions.
    pub fn match_variables(&mut self) {
        if !self.rules_queued && !self.inline_queued {
            return;
        }
        let process_root = self.rules_queued;
        if process_root {
            for (p, v) in self.root_decls.clone().unwrap_or_default() {
                if is_variable(&p) {
                    self.inspect_variable(&p, &v);
                }
            }
        }
        // collectVariablesAndVarDep: sheets, then inline styles.
        let decls: Vec<(String, String)> = std::mem::take(&mut self.rule_decls).into_iter().chain(std::mem::take(&mut self.inline_decls)).collect();
        self.rules_queued = false;
        self.inline_queued = false;
        for (p, v) in &decls {
            if is_variable(p) {
                self.inspect_variable(p, v);
            }
            if is_var_dependant(v) {
                self.inspect_var_dependant(p, v);
            }
        }
        if process_root {
            for (p, v) in self.root_decls.clone().unwrap_or_default() {
                if is_var_dependant(&v) {
                    self.inspect_var_dependant(&p, &v);
                }
            }
        }

        for v in self.var_refs_order.clone() {
            for r in self.var_refs.get(&v).map(StrSet::items).unwrap_or_default() {
                if let Some(t) = self.var_types.get(&v).copied() {
                    self.resolve_variable_type(&r, t);
                }
            }
        }

        // A JS Set.forEach skips members deleted before it reaches them; nothing is added meanwhile.
        for v in self.unknown_color_vars.items() {
            if !self.unknown_color_vars.contains(&v) {
                continue;
            }
            if self.unknown_bg_vars.contains(&v) {
                self.unknown_color_vars.remove(&v);
                self.unknown_bg_vars.remove(&v);
                self.resolve_variable_type(&v, VAR_TYPE_BG_COLOR);
            } else if self.is_var_type(&v, ANY_COLOR) {
                self.unknown_color_vars.remove(&v);
            }
            // else: `undefinedVars.add(v)`; v stays in unknownColorVars.
        }

        for v in self.unknown_bg_vars.items() {
            if !self.unknown_bg_vars.contains(&v) {
                continue;
            }
            let has_color = self.find_var_ref(&v, |s, r| s.unknown_color_vars.contains(r) || s.is_var_type(r, ANY_COLOR)).is_some();
            if has_color {
                for r in self.walk_var_refs(&v) {
                    self.resolve_variable_type(&r, VAR_TYPE_BG_COLOR);
                }
            } else if self.is_var_type(&v, VAR_TYPE_BG_COLOR | VAR_TYPE_BG_IMG) {
                self.unknown_bg_vars.remove(&v);
            }
        }
    }

    fn inspect_variable(&mut self, var_name: &str, value: &str) {
        self.unstable_var_values.insert(var_name.to_string(), value.to_string());
        if is_var_dependant(value) && is_constructed_color_var(value) {
            self.unknown_color_vars.insert(var_name);
            self.defined_vars.insert(var_name.to_string());
        }
        if self.defined_vars.contains(var_name) {
            return;
        }
        self.defined_vars.insert(var_name.to_string());
        // Either a raw value (`0, 102, 204`) or something a colour parser reads.
        let is_color = get_rgb_values(value).is_some() || parse_color(value).is_some();
        if is_color {
            self.unknown_color_vars.insert(var_name);
        } else if value.contains("url(") || value.contains("linear-gradient(") || value.contains("radial-gradient(") {
            self.resolve_variable_type(var_name, VAR_TYPE_BG_IMG);
        }
    }

    fn resolve_variable_type(&mut self, var_name: &str, type_num: u8) {
        let t = self.var_types.get(var_name).copied().unwrap_or(0) | type_num;
        self.var_types.insert(var_name.to_string(), t);
        self.unknown_color_vars.remove(var_name);
        self.unknown_bg_vars.remove(var_name);
    }

    fn inspect_var_dependant(&mut self, property: &str, value: &str) {
        if is_variable(property) {
            for r in var_deps(value) {
                if !self.var_refs.contains_key(property) {
                    self.var_refs_order.push(property.to_string());
                }
                self.var_refs.entry(property.to_string()).or_default().insert(&r);
            }
        } else if property == "background-color" || property == "box-shadow" {
            for v in var_deps(value) {
                self.resolve_variable_type(&v, VAR_TYPE_BG_COLOR);
            }
        } else if is_text_color_property(property) {
            for v in var_deps(value) {
                self.resolve_variable_type(&v, VAR_TYPE_TEXT_COLOR);
            }
        } else if property.starts_with("border") || property.starts_with("outline") {
            for v in var_deps(value) {
                self.resolve_variable_type(&v, VAR_TYPE_BORDER_COLOR);
            }
        } else if property == "background" || property == "background-image" {
            for v in var_deps(value) {
                if self.is_var_type(&v, VAR_TYPE_BG_COLOR | VAR_TYPE_BG_IMG) {
                    continue;
                }
                let is_bg_color = self.find_var_ref(&v, |s, r| s.unknown_color_vars.contains(r) || s.is_var_type(r, ANY_COLOR)).is_some();
                for r in self.walk_var_refs(&v) {
                    if is_bg_color {
                        self.resolve_variable_type(&r, VAR_TYPE_BG_COLOR);
                    } else {
                        self.unknown_bg_vars.insert(&r);
                    }
                }
            }
        }
    }

    #[cfg(test)]
    fn match_variables_for_test(&mut self) {
        self.rules_queued = true;
        self.match_variables();
    }

    /// `findVarRef`: depth first, each name visited once, first hit wins.
    /// Iterative: a mail can chain thousands of variables.
    fn find_var_ref(&self, var_name: &str, found: impl Fn(&Self, &str) -> bool) -> Option<String> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut todo = vec![var_name.to_string()];
        while let Some(name) = todo.pop() {
            if !seen.insert(name.clone()) {
                continue;
            }
            if found(self, &name) {
                return Some(name);
            }
            if let Some(refs) = self.var_refs.get(&name) {
                todo.extend(refs.order.values().rev().cloned());
            }
        }
        None
    }

    /// `iterateVarRefs`: the names `findVarRef` visits when nothing matches.
    fn walk_var_refs(&self, var_name: &str) -> Vec<String> {
        let mut order = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut todo = vec![var_name.to_string()];
        while let Some(name) = todo.pop() {
            if !seen.insert(name.clone()) {
                continue;
            }
            if let Some(refs) = self.var_refs.get(&name) {
                todo.extend(refs.order.values().rev().cloned());
            }
            order.push(name);
        }
        order
    }

    /// `getModifierForVariable(...)(theme).declarations`, settled.
    pub fn modifier_for_variable(&self, var_name: &str, source_value: &str, rule: &dyn RuleStyle, cx: &mut DarkCx) -> Vec<(String, String)> {
        let mut declarations: Vec<(String, String)> = Vec::new();
        for kind in [Kind::Bg, Kind::Text, Kind::Border] {
            if !self.is_var_type(var_name, kind.type_bit()) {
                continue;
            }
            let property = kind.wrap(var_name);
            let modified = if is_var_dependant(source_value) {
                if is_constructed_color_var(source_value) {
                    let value = insert_var_values(source_value, &self.unstable_var_values).filter(|v| !v.is_empty());
                    let value = value.unwrap_or_else(|| if kind == Kind::Bg { "#ffffff" } else { "#000000" }.to_string());
                    try_modify(&value, kind, cx)
                } else {
                    let mut fallback = |f: &str| try_modify(f, kind, cx);
                    replace_css_variables_names(source_value, |v| kind.wrap(v), &mut fallback, None)
                }
            } else {
                try_modify(source_value, kind, cx)
            };
            declarations.push((property, modified));
        }
        if self.is_var_type(var_name, VAR_TYPE_BG_IMG) {
            let property = wrap_bg_img_variable_name(var_name);
            let mut modified = source_value.to_string();
            if is_var_dependant(source_value) {
                let mut fallback = |f: &str| try_modify(f, Kind::Bg, cx);
                modified = replace_css_variables_names(source_value, wrap_bg_color_variable_name, &mut fallback, None);
            }
            let value = bg_image_modifier(&modified, rule, cx).unwrap_or(modified);
            declarations.push((property, value));
        }
        declarations
    }

    /// `getModifierForVarDependant(...)(theme)`, settled. None is DR's `null`
    /// (the declaration is left alone) and also its Promise that never settles:
    /// a variable no rule defines, whose fallback is not a colour already.
    pub fn modifier_for_var_dependant(&self, property: &str, source_value: &str, cx: &mut DarkCx) -> Option<String> {
        static CONSTRUCTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(rgb|hsl)a?\(").unwrap());
        static SIMPLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^rgba?\(var\(--[\-_A-Za-z0-9]+\)(\s*,?/?\s*0?\.[0-9]+)?\)$").unwrap());
        let is_constructed_color = CONSTRUCTED.is_match(source_value).unwrap_or(false);
        let is_simple_constructed_color = SIMPLE.is_match(source_value).unwrap_or(false);
        if is_constructed_color && !is_simple_constructed_color {
            let is_bg = property.starts_with("background");
            let is_text = is_text_color_property(property);
            let value = insert_var_values(source_value, &self.unstable_var_values).filter(|v| !v.is_empty());
            let value = value.unwrap_or_else(|| if is_bg { "#ffffff" } else { "#000000" }.to_string());
            let kind = if is_bg {
                Kind::Bg
            } else if is_text {
                Kind::Text
            } else {
                Kind::Border
            };
            return Some(try_modify(&value, kind, cx));
        }
        if property == "background-color" || (is_simple_constructed_color && property == "background") {
            let default_fallback = if SHOULD_SET_DEFAULT_COLOR {
                try_modify(if is_constructed_color { "255, 255, 255" } else { "#ffffff" }, Kind::Bg, cx)
            } else {
                "transparent".to_string()
            };
            let mut fallback = |f: &str| try_modify(f, Kind::Bg, cx);
            return Some(replace_css_variables_names(source_value, wrap_bg_color_variable_name, &mut fallback, Some(&default_fallback)));
        }
        if is_text_color_property(property) {
            let default_fallback = try_modify(if is_constructed_color { "0, 0, 0" } else { "#000000" }, Kind::Text, cx);
            let mut fallback = |f: &str| try_modify(f, Kind::Text, cx);
            return Some(replace_css_variables_names(source_value, wrap_text_color_variable_name, &mut fallback, Some(&default_fallback)));
        }
        if property == "background" || property == "background-image" || property == "box-shadow" {
            let mut unknown_vars = false;
            let replaced = {
                let mut fallback = |f: &str| try_modify(f, Kind::Bg, cx);
                replace_css_variables_names(
                    source_value,
                    |v| {
                        if self.is_var_type(v, VAR_TYPE_BG_COLOR) {
                            wrap_bg_color_variable_name(v)
                        } else if self.is_var_type(v, VAR_TYPE_BG_IMG) {
                            wrap_bg_img_variable_name(v)
                        } else {
                            unknown_vars = true;
                            v.to_string()
                        }
                    },
                    &mut fallback,
                    None,
                )
            };
            let mut modified = replaced.clone();
            if property == "box-shadow" {
                if let Some(s) = shadow_modifier(&replaced, cx) {
                    if s.unparsable != s.matches {
                        modified = s.result;
                    }
                }
            }
            if unknown_vars && !is_fallback_resolved(&modified) {
                return None;
            }
            return Some(modified);
        }
        if property.starts_with("border") || property.starts_with("outline") {
            let mut fallback = |f: &str| try_modify(f, Kind::Border, cx);
            return Some(replace_css_variables_names(source_value, wrap_border_color_variable_name, &mut fallback, None));
        }
        None
    }

    /// `putRootVars`: the `:root` rule that carries `<html>`'s own variables.
    pub fn root_vars_style(&self, cx: &mut DarkCx) -> String {
        let mut declarations: Vec<(String, String)> = Vec::new();
        let set = |declarations: &mut Vec<(String, String)>, k: String, v: String| match declarations.iter_mut().find(|(p, _)| *p == k) {
            Some(slot) => slot.1 = v,
            None => declarations.push((k, v)),
        };
        for (property, value) in self.root_decls.as_deref().unwrap_or_default() {
            if !is_variable(property) {
                continue;
            }
            for kind in [Kind::Bg, Kind::Text, Kind::Border] {
                if self.is_var_type(property, kind.type_bit()) {
                    set(&mut declarations, kind.wrap(property), try_modify(value, kind, cx));
                }
            }
        }
        let mut lines = vec![":root {".to_string()];
        lines.extend(declarations.iter().map(|(p, v)| format!("    {p}: {v};")));
        lines.push("}".into());
        lines.join("\n")
    }
}

/// Queue every style rule of a sheet, in `iterateCSSRules` order.
pub fn collect_rules(store: &mut VariablesStore, rules: &[CssRule], g: &SharedRwLockReadGuard, is_safari: bool) {
    for rule in rules {
        match rule {
            CssRule::Style(lock) => {
                let r = lock.read_with(g);
                store.queue_rules(&StyleBlock { block: r.block.read_with(g), selector: String::new() }, is_safari);
                if let Some(nested) = &r.rules {
                    collect_rules(store, &nested.read_with(g).0, g, is_safari);
                }
            }
            CssRule::Media(m) => {
                let queries: Vec<String> = m.media_queries.read_with(g).media_queries.iter().map(|q| q.to_css_string()).collect();
                if super::sheets::media_applies(&queries) {
                    collect_rules(store, &m.rules.read_with(g).0, g, is_safari);
                }
            }
            CssRule::Supports(s) if s.enabled => collect_rules(store, &s.rules.read_with(g).0, g, is_safari),
            CssRule::LayerBlock(l) => collect_rules(store, &l.rules.read_with(g).0, g, is_safari),
            _ => {}
        }
    }
}

/// Queue the inline style of every element whose `style` attribute holds
/// `--` (`overrideInlineStyle`'s `addInlineStyleForMatching`), in tree order.
/// `<html>` is among them. Elements `overrideInlineStyle` leaves early are not.
pub fn collect_inline(store: &mut VariablesStore, doc: &BaseDocument, mode: u8, is_safari: bool) {
    let style_attr = LocalName::from("style");
    let guard = doc.guard().read();
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else { continue };
        stack.extend(node.children.iter().rev().copied());
        let Some(el) = node.element_data() else { continue };
        if !el.attr(style_attr.clone()).is_some_and(|s| s.contains("--")) {
            continue;
        }
        if super::inline::skips_inline_override(doc, id, mode) {
            continue;
        }
        let Some(block) = el.style_attribute.as_ref() else { continue };
        store.queue_inline(&StyleBlock { block: block.read_with(&guard), selector: String::new() }, is_safari);
    }
}

/// `<html>`'s inline style, when its attribute holds `--`.
pub fn collect_root(store: &mut VariablesStore, doc: &BaseDocument, is_safari: bool) {
    let Some(html) = doc.get_node(doc.root_element().id) else { return };
    let Some(el) = html.element_data() else { return };
    if !el.attr(LocalName::from("style")).is_some_and(|s| s.contains("--")) {
        return;
    }
    let guard = doc.guard().read();
    if let Some(block) = el.style_attribute.as_ref() {
        store.set_root_style(&StyleBlock { block: block.read_with(&guard), selector: String::new() }, is_safari);
    }
}

// ---- helpers (variables.ts L566-817) ----

fn variable_matches(input: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(start) = input.get(i..).and_then(|s| s.find("var(")).map(|p| p + i) {
        let Some(range) = get_parentheses_range(input, start + 3) else { break };
        out.push((start, range.end));
        // `i = range.end + 1`: one character past the closing parenthesis.
        i = range.end + input.get(range.end..).and_then(|s| s.chars().next()).map_or(1, char::len_utf8);
    }
    out
}

fn replace_variables_matches(input: &str, mut replacer: impl FnMut(&str, usize) -> Option<String>) -> String {
    let matches = variable_matches(input);
    if matches.is_empty() {
        return input.to_string();
    }
    let count = matches.len();
    let replacements: Vec<Option<String>> = matches.iter().map(|&(s, e)| replacer(&input[s..e], count)).collect();
    let mut out = String::from(&input[..matches[0].0]);
    for (i, &(_, end)) in matches.iter().enumerate() {
        // A null replacement joins as "".
        out.push_str(replacements[i].as_deref().unwrap_or(""));
        let next = if i < count - 1 { matches[i + 1].0 } else { input.len() };
        out.push_str(js_substring(input, end, next));
    }
    out
}

fn js_substring(s: &str, a: usize, b: usize) -> &str {
    let (a, b) = (a.min(s.len()), b.min(s.len()));
    if a <= b { s.get(a..b).unwrap_or("") } else { s.get(b..a).unwrap_or("") }
}

fn variable_name_and_fallback(m: &str) -> (String, String) {
    match m.find(',') {
        Some(comma) => (js_substring(m, 4, comma).trim().to_string(), js_substring(m, comma + 1, m.len().saturating_sub(1)).trim().to_string()),
        None => (js_substring(m, 4, m.len().saturating_sub(1)).trim().to_string(), String::new()),
    }
}

/// `replaceCSSVariablesNames`.
pub fn replace_css_variables_names(
    value: &str,
    mut name_replacer: impl FnMut(&str) -> String,
    mut fallback_replacer: impl FnMut(&str) -> String,
    final_fallback: Option<&str>,
) -> String {
    replace_names(value, &mut name_replacer, &mut fallback_replacer, final_fallback, 0)
}

fn replace_names(
    value: &str,
    name_replacer: &mut dyn FnMut(&str) -> String,
    fallback_replacer: &mut dyn FnMut(&str) -> String,
    final_fallback: Option<&str>,
    depth: usize,
) -> String {
    if depth > MAX_NESTING {
        return value.to_string();
    }
    replace_variables_matches(value, |m, _| {
        let (name, fallback) = variable_name_and_fallback(m);
        let new_name = name_replacer(&name);
        if fallback.is_empty() {
            return Some(match final_fallback.filter(|f| !f.is_empty()) {
                Some(f) => format!("var({new_name}, {f})"),
                None => format!("var({new_name})"),
            });
        }
        let new_fallback = if is_var_dependant(&fallback) {
            replace_names(&fallback, name_replacer, fallback_replacer, None, depth + 1)
        } else {
            fallback_replacer(&fallback)
        };
        Some(format!("var({new_name}, {new_fallback})"))
    })
}

/// `iterateVarDependencies` into a JS `Set`: unique names, first seen first.
fn var_deps(value: &str) -> Vec<String> {
    let mut seen = StrSet::default();
    replace_names(
        value,
        &mut |name| {
            seen.insert(name);
            name.to_string()
        },
        &mut |f| f.to_string(),
        None,
        0,
    );
    seen.items()
}

fn wrap_bg_color_variable_name(name: &str) -> String {
    format!("--darkreader-bg{name}")
}
fn wrap_text_color_variable_name(name: &str) -> String {
    format!("--darkreader-text{name}")
}
fn wrap_border_color_variable_name(name: &str) -> String {
    format!("--darkreader-border{name}")
}
fn wrap_bg_img_variable_name(name: &str) -> String {
    format!("--darkreader-bgimg{name}")
}

fn is_variable(property: &str) -> bool {
    property.starts_with("--")
}

fn is_var_dependant(value: &str) -> bool {
    value.contains("var(")
}

fn is_constructed_color_var(value: &str) -> bool {
    static A: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(rgb|hsl)a?\(").unwrap());
    static B: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^((([0-9]{1,3})|(var\([\-_A-Za-z0-9]+\))),?\s*?){3}$").unwrap());
    A.is_match(value).unwrap_or(false) || B.is_match(value).unwrap_or(false)
}

/// `isFallbackResolved`: the declaration already ends in a usable colour.
fn is_fallback_resolved(modified: &str) -> bool {
    static PLAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(#[0-9a-f]+)|([a-z]+)$").unwrap());
    if !(modified.starts_with("var(") && modified.ends_with(')')) {
        return false;
    }
    let has_nested = modified.ends_with("))");
    let has_double_nested = modified.ends_with(")))");
    // lastIndexOf(char, from): the last match at or before `from`.
    let last_index_of = |c: char, from: usize| modified.get(..(from + 1).min(modified.len())).and_then(|s| s.rfind(c));
    let from = if has_nested {
        let Some(last_open) = modified.rfind('(') else { return false };
        if has_double_nested {
            // lastIndexOf('(', lastOpen - 1) is -1 when nothing precedes it, and then no comma is found.
            let Some(first_open) = last_open.checked_sub(1).and_then(|f| last_index_of('(', f)) else { return false };
            first_open
        } else {
            last_open
        }
    } else {
        modified.len()
    };
    let Some(comma) = last_index_of(',', from) else { return false };
    if modified.as_bytes().get(comma + 1) != Some(&b' ') {
        return false;
    }
    // slice(): an end before the start is empty.
    let fallback = modified.get(comma + 2..modified.len() - 1).unwrap_or("");
    if has_nested {
        return fallback.starts_with("rgb(")
            || fallback.starts_with("rgba(")
            || fallback.starts_with("hsl(")
            || fallback.starts_with("hsla(")
            || fallback.starts_with("var(--darkreader-bg--")
            || fallback.starts_with("var(--darkreader-background-")
            || (has_double_nested && fallback.contains("var(--darkreader-background-"));
    }
    PLAIN.is_match(fallback).unwrap_or(false)
}

fn is_text_color_property(property: &str) -> bool {
    ["color", "caret-color", "-webkit-text-fill-color", "fill", "stroke"].contains(&property)
}

/// `parseRawColorValue`: a bare `r, g, b[, a]` list becomes an `rgb()` colour.
fn parse_raw_color_value(input: &str) -> (bool, String) {
    match get_rgb_values(input) {
        Some(v) => {
            let n = |i: usize| fmt_js_number(v[i]);
            let color = if v[3] < 1.0 { format!("rgb({} {} {} / {})", n(0), n(1), n(2), n(3)) } else { format!("rgb({} {} {})", n(0), n(1), n(2)) };
            (true, color)
        }
        None => (false, input.to_string()),
    }
}

/// `handleRawColorValue` + `tryModify{Bg,Text,Border}Color`. A raw list is
/// modified without the palette and written back as a raw list.
fn try_modify(input: &str, kind: Kind, cx: &mut DarkCx) -> String {
    let (is_raw, color) = parse_raw_color_value(input);
    let Some(rgb) = parse_color(&color) else { return color };
    let out = match (kind, is_raw) {
        (Kind::Bg, false) => cx.palette.bg(rgb, &cx.theme),
        (Kind::Text, false) => cx.palette.fg(rgb, &cx.theme),
        (Kind::Border, false) => cx.palette.border(rgb, &cx.theme),
        (Kind::Bg, true) => modify_background_color(rgb, &cx.theme),
        (Kind::Text, true) => modify_foreground_color(rgb, &cx.theme),
        (Kind::Border, true) => modify_border_color(rgb, &cx.theme),
    };
    if !is_raw {
        return out;
    }
    // "This should technically never fail", as DR puts it.
    match parse_color(&out) {
        Some(o) if o.a.is_nan() || o.a == 1.0 => format!("{}, {}, {}", fmt_js_number(o.r), fmt_js_number(o.g), fmt_js_number(o.b)),
        Some(o) => format!("{}, {}, {}, {}", fmt_js_number(o.r), fmt_js_number(o.g), fmt_js_number(o.b), fmt_js_number(o.a)),
        None => out,
    }
}

/// `insertVarValues`: the value with every `var()` replaced by what the sheets
/// define for it, or None when one cannot be resolved.
fn insert_var_values(source: &str, values: &HashMap<String, String>) -> Option<String> {
    let mut calls = 0;
    insert_values(source, values, &mut HashSet::new(), 0, &mut calls)
}

fn insert_values(source: &str, values: &HashMap<String, String>, full_stack: &mut HashSet<String>, depth: usize, calls: &mut usize) -> Option<String> {
    *calls += 1;
    if depth > MAX_NESTING || *calls > MAX_INSERT_CALLS {
        return None;
    }
    let mut contains_unresolved = false;
    let replaced = replace_variables_matches(source, |m, count| {
        let (name, fallback) = variable_name_and_fallback(m);
        // With several matches each one gets its own copy of the stack.
        let mut own;
        let stack: &mut HashSet<String> = if count > 1 {
            own = full_stack.clone();
            &mut own
        } else {
            &mut *full_stack
        };
        if stack.contains(&name) {
            contains_unresolved = true;
            return None;
        }
        stack.insert(name.clone());
        let var_value = values.get(&name).filter(|v| !v.is_empty()).cloned().unwrap_or(fallback);
        let mut inserted: Option<String> = None;
        if !var_value.is_empty() {
            inserted = if is_var_dependant(&var_value) { insert_values(&var_value, values, stack, depth + 1, calls) } else { Some(var_value) };
        }
        match inserted.filter(|i| !i.is_empty() && i.len() <= MAX_INSERT_LEN) {
            Some(i) => Some(i),
            None => {
                contains_unresolved = true;
                None
            }
        }
    });
    if contains_unresolved {
        None
    } else {
        Some(replaced)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dark::{Profile, Theme};

    fn cx() -> DarkCx {
        DarkCx::new(Theme::mailvault("#0a0a12", "#e8e8ef", 100.0, 100.0, 0.0), Profile::WEBKIT_IFRAME)
    }

    #[test]
    fn raw_rgb_lists_are_read_and_nothing_else() {
        assert_eq!(get_rgb_values("0, 102, 204"), Some([0.0, 102.0, 204.0, 1.0]));
        assert_eq!(get_rgb_values("0 102 204 / 0.5"), Some([0.0, 102.0, 204.0, 0.5]));
        assert_eq!(get_rgb_values("10px 20px 30px"), None);
        assert_eq!(get_rgb_values("1, 2"), None);
        assert_eq!(get_rgb_values("100%, 50%, 0%"), None);
        assert_eq!(get_rgb_values("1000, 2, 3"), None);
        assert_eq!(get_rgb_values("#fff"), None);
    }

    #[test]
    fn names_and_fallbacks_are_replaced_at_every_depth() {
        let out = replace_css_variables_names("1px var(--a, var(--b, #fff)) var(--c)", |n| format!("--x{n}"), |f| format!("<{f}>"), Some("end"));
        assert_eq!(out, "1px var(--x--a, var(--x--b, <#fff>)) var(--x--c, end)");
        assert_eq!(var_deps("var(--a, var(--b)) var(--a) é var(--c)"), ["--a", "--b", "--c"]);
    }

    #[test]
    fn var_values_insert_through_chains_and_stop_at_cycles() {
        let vals: HashMap<String, String> =
            [("--r", "10"), ("--g", "var(--r)"), ("--loop", "var(--loop)")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(insert_var_values("rgb(var(--r), var(--g), var(--b, 3))", &vals).as_deref(), Some("rgb(10, 10, 3)"));
        assert_eq!(insert_var_values("rgb(var(--nope), 1, 2)", &vals), None);
        assert_eq!(insert_var_values("var(--loop)", &vals), None);
    }

    #[test]
    fn var_value_expansion_is_bounded() {
        // --v{n} = rgb(var(--v{n+1}), var(--v{n+1}), var(--v{n+1})): 3^40 inserted values if unchecked.
        let mut vals: HashMap<String, String> = HashMap::new();
        for n in 0..40 {
            vals.insert(format!("--v{n}"), format!("rgb(var(--v{}), var(--v{}), var(--v{}))", n + 1, n + 1, n + 1));
        }
        vals.insert("--v40".into(), "1".into());
        assert_eq!(insert_var_values("var(--v0)", &vals), None);
        // A chain deeper than the nesting limit is left unresolved instead of recursing to the end.
        let mut chain: HashMap<String, String> = (0..500).map(|n| (format!("--c{n}"), format!("var(--c{})", n + 1))).collect();
        chain.insert("--c500".into(), "7".into());
        assert_eq!(insert_var_values("var(--c0)", &chain), None);
        assert_eq!(insert_var_values("var(--c480)", &chain).as_deref(), Some("7"));
    }

    #[test]
    fn a_long_reference_chain_types_without_recursing() {
        let mut store = VariablesStore::default();
        for n in 0..5000 {
            store.inspect_var_dependant(&format!("--c{n}"), &format!("var(--c{})", n + 1));
        }
        store.inspect_variable("--c5000", "#ffffff");
        store.inspect_var_dependant("background-color", "var(--c0)");
        store.match_variables_for_test();
        assert!(store.is_var_type("--c5000", VAR_TYPE_BG_COLOR));
    }

    #[test]
    fn fallback_resolution_follows_dark_reader() {
        assert!(is_fallback_resolved("var(--a, #fff)"));
        assert!(is_fallback_resolved("var(--a, red)"));
        assert!(!is_fallback_resolved("var(--a)"));
        assert!(!is_fallback_resolved("#fff"));
        assert!(is_fallback_resolved("var(--a, rgb(1, 2, 3))"));
        assert!(!is_fallback_resolved("var(--a, calc(1px + 2px))"));
    }

    #[test]
    fn an_undefined_background_var_is_left_alone_unless_its_fallback_is_a_colour() {
        let mut cx = cx();
        let store = VariablesStore::default();
        assert_eq!(store.modifier_for_var_dependant("background", "var(--nowhere)", &mut cx), None);
        assert_eq!(
            store.modifier_for_var_dependant("background", "var(--nowhere, #fff)", &mut cx).as_deref(),
            Some("var(--nowhere, var(--darkreader-background-ffffff, #0a0a12))")
        );
        assert_eq!(store.modifier_for_var_dependant("margin", "var(--nowhere)", &mut cx), None);
    }

    #[test]
    fn raw_lists_keep_their_shape_through_the_modifier() {
        let mut cx = cx();
        assert_eq!(try_modify("255, 255, 255", Kind::Bg, &mut cx), "10, 10, 18");
        assert_eq!(try_modify("#ffffff", Kind::Bg, &mut cx), "var(--darkreader-background-ffffff, #0a0a12)");
        assert_eq!(try_modify("not a colour", Kind::Text, &mut cx), "not a colour");
    }
}
