//! The smallest DOM the body scan needs: html5ever builds it the way the
//! webview's `DOMParser` does (an HTML document, scripting off, no declarative
//! shadow roots), the scan edits it, and [`Dom::inner_html`] writes it back the
//! way `element.innerHTML` does (the HTML fragment serialization algorithm, as
//! parse5 implements it: `<` and `>` in attribute values stay unescaped).

use html5ever::interface::{ElemName, ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::tree_builder::TreeBuilderOpts;
use html5ever::{Attribute, LocalName, Namespace, ParseOpts, QualName};
use std::borrow::Cow;
use std::cell::RefCell;

pub(crate) const HTML_NS: &str = "http://www.w3.org/1999/xhtml";
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

pub(crate) type Id = usize;

#[derive(Debug)]
pub(crate) enum Data {
    Document,
    /// A template's contents.
    Fragment,
    Doctype(String),
    Text(String),
    Comment(String),
    Pi(String, String),
    /// `contents`: a template's fragment. `integration`: a MathML annotation-xml HTML integration point.
    Element { name: QualName, attrs: Vec<Attribute>, contents: Option<Id>, integration: bool },
}

#[derive(Debug)]
pub(crate) struct Node {
    pub parent: Option<Id>,
    pub children: Vec<Id>,
    pub data: Data,
}

#[derive(Default)]
struct Sink {
    nodes: RefCell<Vec<Node>>,
}

impl Sink {
    fn add(&self, data: Data) -> Id {
        let mut nodes = self.nodes.borrow_mut();
        nodes.push(Node { parent: None, children: Vec::new(), data });
        nodes.len() - 1
    }

    fn detach(nodes: &mut [Node], id: Id) {
        if let Some(parent) = nodes[id].parent.take() {
            nodes[parent].children.retain(|&c| c != id);
        }
    }

    /// Insert `child` into `parent` at `at`, merging text into a text neighbour.
    fn insert(&self, parent: Id, at: usize, child: NodeOrText<Id>) {
        let mut nodes = self.nodes.borrow_mut();
        match child {
            NodeOrText::AppendText(text) => {
                if at > 0 {
                    let prev = nodes[parent].children[at - 1];
                    if let Data::Text(t) = &mut nodes[prev].data {
                        t.push_str(&text);
                        return;
                    }
                }
                nodes.push(Node { parent: Some(parent), children: Vec::new(), data: Data::Text(text.to_string()) });
                let id = nodes.len() - 1;
                nodes[parent].children.insert(at, id);
            }
            NodeOrText::AppendNode(id) => {
                Self::detach(&mut nodes, id);
                nodes[id].parent = Some(parent);
                let at = at.min(nodes[parent].children.len());
                nodes[parent].children.insert(at, id);
            }
        }
    }
}

pub(crate) struct Name(QualName);

impl std::fmt::Debug for Name {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

impl ElemName for Name {
    fn ns(&self) -> &Namespace {
        &self.0.ns
    }
    fn local_name(&self) -> &LocalName {
        &self.0.local
    }
}

impl TreeSink for Sink {
    type Handle = Id;
    type Output = Vec<Node>;
    type ElemName<'a>
        = Name
    where
        Self: 'a;

    fn finish(self) -> Vec<Node> {
        self.nodes.into_inner()
    }
    fn parse_error(&self, _msg: Cow<'static, str>) {}
    fn get_document(&self) -> Id {
        0
    }
    fn elem_name<'a>(&'a self, target: &'a Id) -> Name {
        match &self.nodes.borrow()[*target].data {
            Data::Element { name, .. } => Name(name.clone()),
            _ => panic!("not an element"),
        }
    }
    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> Id {
        let contents = flags.template.then(|| self.add(Data::Fragment));
        self.add(Data::Element { name, attrs, contents, integration: flags.mathml_annotation_xml_integration_point })
    }
    fn create_comment(&self, text: StrTendril) -> Id {
        self.add(Data::Comment(text.to_string()))
    }
    fn create_pi(&self, target: StrTendril, data: StrTendril) -> Id {
        self.add(Data::Pi(target.to_string(), data.to_string()))
    }
    fn append(&self, parent: &Id, child: NodeOrText<Id>) {
        let at = self.nodes.borrow()[*parent].children.len();
        self.insert(*parent, at, child);
    }
    fn append_based_on_parent_node(&self, element: &Id, prev_element: &Id, child: NodeOrText<Id>) {
        if self.nodes.borrow()[*element].parent.is_some() {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev_element, child);
        }
    }
    fn append_doctype_to_document(&self, name: StrTendril, _public_id: StrTendril, _system_id: StrTendril) {
        let id = self.add(Data::Doctype(name.to_string()));
        self.append(&0, NodeOrText::AppendNode(id));
    }
    fn get_template_contents(&self, target: &Id) -> Id {
        match &self.nodes.borrow()[*target].data {
            Data::Element { contents: Some(c), .. } => *c,
            _ => panic!("not a template"),
        }
    }
    fn same_node(&self, x: &Id, y: &Id) -> bool {
        x == y
    }
    fn set_quirks_mode(&self, _mode: QuirksMode) {}
    fn append_before_sibling(&self, sibling: &Id, new_node: NodeOrText<Id>) {
        let (parent, at) = {
            let nodes = self.nodes.borrow();
            let parent = nodes[*sibling].parent.expect("sibling has a parent");
            let at = nodes[parent].children.iter().position(|c| c == sibling).expect("sibling in parent");
            (parent, at)
        };
        // A node moved from before its own position shifts the index.
        let at = if let NodeOrText::AppendNode(id) = &new_node {
            let nodes = self.nodes.borrow();
            match nodes[*id].parent {
                Some(p) if p == parent && nodes[p].children.iter().position(|c| c == id).is_some_and(|i| i < at) => at - 1,
                _ => at,
            }
        } else {
            at
        };
        self.insert(parent, at, new_node);
    }
    fn add_attrs_if_missing(&self, target: &Id, attrs: Vec<Attribute>) {
        if let Data::Element { attrs: own, .. } = &mut self.nodes.borrow_mut()[*target].data {
            for attr in attrs {
                if !own.iter().any(|a| a.name == attr.name) {
                    own.push(attr);
                }
            }
        }
    }
    fn remove_from_parent(&self, target: &Id) {
        Self::detach(&mut self.nodes.borrow_mut(), *target);
    }
    fn reparent_children(&self, node: &Id, new_parent: &Id) {
        let mut nodes = self.nodes.borrow_mut();
        let children = std::mem::take(&mut nodes[*node].children);
        for &c in &children {
            nodes[c].parent = Some(*new_parent);
        }
        nodes[*new_parent].children.extend(children);
    }
    fn is_mathml_annotation_xml_integration_point(&self, handle: &Id) -> bool {
        matches!(self.nodes.borrow()[*handle].data, Data::Element { integration: true, .. })
    }
    // DOMParser never attaches declarative shadow roots: the template stays a template.
    fn allow_declarative_shadow_roots(&self, _intended_parent: &Id) -> bool {
        false
    }
}

pub(crate) struct Dom {
    pub nodes: Vec<Node>,
}

impl Dom {
    /// `new DOMParser().parseFromString(<!DOCTYPE html><html><body>{body}</body></html>, 'text/html')`.
    pub fn parse_body(body: &str) -> Dom {
        let opts = ParseOpts {
            tree_builder: TreeBuilderOpts { scripting_enabled: false, ..Default::default() },
            ..Default::default()
        };
        let sink = Sink::default();
        sink.add(Data::Document);
        let doc = format!("<!DOCTYPE html><html><body>{body}</body></html>");
        Dom { nodes: html5ever::parse_document(sink, opts).one(doc) }
    }

    pub fn element(&self, id: Id) -> Option<(&QualName, &[Attribute])> {
        match &self.nodes[id].data {
            Data::Element { name, attrs, .. } => Some((name, attrs.as_slice())),
            _ => None,
        }
    }

    pub fn is_html(&self, id: Id, local: &str) -> bool {
        self.element(id).is_some_and(|(n, _)| &*n.ns == HTML_NS && &*n.local == local)
    }

    /// `getAttribute(name)` for an attribute without a namespace.
    pub fn attr(&self, id: Id, name: &str) -> Option<&str> {
        self.element(id)?.1.iter().find(|a| a.name.ns.is_empty() && &*a.name.local == name).map(|a| &*a.value)
    }

    /// `setAttribute(name, value)`: in place when present, else appended.
    pub fn set_attr(&mut self, id: Id, name: &str, value: &str) {
        if let Data::Element { attrs, .. } = &mut self.nodes[id].data {
            if let Some(a) = attrs.iter_mut().find(|a| a.name.ns.is_empty() && &*a.name.local == name) {
                a.value = StrTendril::from_slice(value);
            } else {
                attrs.push(Attribute { name: QualName::new(None, Namespace::from(""), LocalName::from(name)), value: StrTendril::from_slice(value) });
            }
        }
    }

    /// Every element, in tree order, as `querySelectorAll` walks it (not into template contents).
    pub fn elements(&self) -> Vec<Id> {
        let mut out = Vec::new();
        let mut stack = vec![0];
        while let Some(id) = stack.pop() {
            if matches!(self.nodes[id].data, Data::Element { .. }) {
                out.push(id);
            }
            stack.extend(self.nodes[id].children.iter().rev());
        }
        out
    }

    /// The elements named `local` (any namespace) carrying the attribute `attr`.
    pub fn select(&self, local: &str, attr: &str) -> Vec<Id> {
        self.elements()
            .into_iter()
            .filter(|&id| self.element(id).is_some_and(|(n, _)| &*n.local == local) && self.attr(id, attr).is_some())
            .collect()
    }

    /// `textContent`: every descendant text node, not template contents.
    pub fn text_content(&self, id: Id) -> String {
        let mut out = String::new();
        let mut stack: Vec<Id> = self.nodes[id].children.iter().rev().copied().collect();
        while let Some(n) = stack.pop() {
            match &self.nodes[n].data {
                Data::Text(t) => out.push_str(t),
                Data::Element { .. } => stack.extend(self.nodes[n].children.iter().rev()),
                _ => {}
            }
        }
        out
    }

    pub fn parent_element(&self, id: Id) -> Option<Id> {
        self.nodes[id].parent.filter(|&p| matches!(self.nodes[p].data, Data::Element { .. }))
    }

    /// A new HTML element, not yet in the tree.
    pub fn create_element(&mut self, local: &str) -> Id {
        self.nodes.push(Node {
            parent: None,
            children: Vec::new(),
            data: Data::Element { name: QualName::new(None, Namespace::from(HTML_NS), LocalName::from(local)), attrs: Vec::new(), contents: None, integration: false },
        });
        self.nodes.len() - 1
    }

    /// `node.textContent = text` on a childless element.
    pub fn append_text(&mut self, parent: Id, text: &str) {
        self.nodes.push(Node { parent: Some(parent), children: Vec::new(), data: Data::Text(text.to_string()) });
        let id = self.nodes.len() - 1;
        self.nodes[parent].children.push(id);
    }

    /// `old.replaceWith(new)`.
    pub fn replace(&mut self, old: Id, new: Id) {
        let Some(parent) = self.nodes[old].parent.take() else { return };
        let at = self.nodes[parent].children.iter().position(|&c| c == old).expect("child of its parent");
        self.nodes[parent].children[at] = new;
        self.nodes[new].parent = Some(parent);
    }

    /// `document.body`: the html element's first body (or frameset) child.
    pub fn body(&self) -> Option<Id> {
        let html = self.nodes[0].children.iter().copied().find(|&c| self.is_html(c, "html"))?;
        self.nodes[html].children.iter().copied().find(|&c| self.is_html(c, "body") || self.is_html(c, "frameset"))
    }

    /// `document.body.innerHTML`.
    pub fn body_inner_html(&self) -> String {
        let mut out = String::new();
        if let Some(body) = self.body() {
            self.children_html(body, &mut out);
        }
        out
    }

    fn children_html(&self, id: Id, out: &mut String) {
        let container = match &self.nodes[id].data {
            Data::Element { name, contents: Some(c), .. } if &*name.ns == HTML_NS && &*name.local == "template" => *c,
            _ => id,
        };
        for &child in &self.nodes[container].children {
            self.node_html(child, out);
        }
    }

    fn node_html(&self, id: Id, out: &mut String) {
        match &self.nodes[id].data {
            Data::Element { name, attrs, .. } => {
                let tag = &*name.local;
                out.push('<');
                out.push_str(tag);
                for a in attrs {
                    out.push(' ');
                    match &*a.name.ns {
                        "" => {}
                        XML_NS => out.push_str("xml:"),
                        XMLNS_NS => {
                            if &*a.name.local != "xmlns" {
                                out.push_str("xmlns:");
                            }
                        }
                        XLINK_NS => out.push_str("xlink:"),
                        _ => {
                            if let Some(p) = &a.name.prefix {
                                out.push_str(p);
                                out.push(':');
                            }
                        }
                    }
                    out.push_str(&a.name.local);
                    out.push_str("=\"");
                    escape(&a.value, true, out);
                    out.push('"');
                }
                out.push('>');
                if &*name.ns == HTML_NS && VOID.contains(&tag) {
                    return;
                }
                self.children_html(id, out);
                out.push_str("</");
                out.push_str(tag);
                out.push('>');
            }
            Data::Text(t) => {
                let raw = self.nodes[id].parent.is_some_and(|p| {
                    self.element(p).is_some_and(|(n, _)| &*n.ns == HTML_NS && RAW_TEXT.contains(&&*n.local))
                });
                if raw {
                    out.push_str(t);
                } else {
                    escape(t, false, out);
                }
            }
            Data::Comment(c) => {
                out.push_str("<!--");
                out.push_str(c);
                out.push_str("-->");
            }
            Data::Doctype(name) => {
                out.push_str("<!DOCTYPE ");
                out.push_str(name);
                out.push('>');
            }
            Data::Pi(target, data) => {
                out.push_str("<?");
                out.push_str(target);
                out.push(' ');
                out.push_str(data);
                out.push('>');
            }
            Data::Document | Data::Fragment => self.children_html(id, out),
        }
    }
}

const VOID: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
];
/// Text written as is. `noscript` is not here: a parsed document has scripting off.
const RAW_TEXT: &[&str] = &["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext"];

fn escape(s: &str, attr: bool, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '\u{A0}' => out.push_str("&nbsp;"),
            '"' if attr => out.push_str("&quot;"),
            '<' if !attr => out.push_str("&lt;"),
            '>' if !attr => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}
