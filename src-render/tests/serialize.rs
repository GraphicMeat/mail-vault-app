use mailvault_render::fonts::{FaceData, FontLibrary};
use mailvault_render::serialize::Endpoint;
use mailvault_render::{RenderDoc, RenderOptions};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};

fn asset(n: &str) -> Vec<u8> { std::fs::read(format!("{}/../src/assets/fonts/{n}", env!("CARGO_MANIFEST_DIR"))).unwrap() }
fn lib() -> FontLibrary {
    let mut lib = FontLibrary::new(false);
    lib.register("MV Mono", vec![FaceData { data: asset("ibm-plex-mono-latin-400.woff2"), weight: 400, style: "normal".into() }]);
    lib
}
fn open(body: &str) -> RenderDoc {
    let html = format!(r#"<body style="margin:0;font:20px/30px 'MV Mono'">{body}</body>"#);
    RenderDoc::open_with(&html, RenderOptions { css_width: 600, scale: 1.0, ..Default::default() }, None, lib().context()).unwrap()
}
/// Endpoint at `needle`'s first byte (or its end) in the run text.
fn at(doc: &RenderDoc, needle: &str, end: bool) -> Endpoint {
    for i in 0..4 {
        for r in doc.text_runs(i) {
            if let Some(p) = r.text.find(needle) {
                return Endpoint { node: r.node, offset: r.start + p + if end { needle.len() } else { 0 } };
            }
        }
    }
    panic!("{needle} not laid out");
}
/// Endpoint in the `n`th inline root, by raw byte offset into its layout text.
fn root_at(doc: &RenderDoc, n: usize, offset: usize) -> Endpoint {
    Endpoint { node: mailvault_render::text::inline_roots(doc.base())[n].as_u64(), offset }
}
fn root_len(doc: &RenderDoc, n: usize) -> usize {
    let id = mailvault_render::text::inline_roots(doc.base())[n];
    doc.base().get_node(id).unwrap().element_data().unwrap().inline_layout_data.as_ref().unwrap().text.len()
}

#[test]
fn within_one_paragraph_keeps_inline_markup_and_escapes() {
    let mut d = open(r#"<p>Hi <b>bold &amp; <a href="https://x.test/?a=1&amp;b=2">link</a></b> end</p>"#);
    let (s, e) = (at(&d, "bold", false), at(&d, "lin", true));
    let out = d.serialize(s, e);
    assert_eq!(out.text, "bold & lin");
    assert_eq!(out.html, r#"<b>bold &amp; <a href="https://x.test/?a=1&amp;b=2">lin</a></b>"#);
}

#[test]
fn partial_link_keeps_its_href_through_the_inline_ancestor_chain() {
    let mut d = open(r#"<p><a href="https://x.test/">inlinelink</a></p>"#);
    let out = d.serialize(at(&d, "line", false), at(&d, "lin", true));
    assert_eq!(out.html, r#"<a href="https://x.test/">lin</a>"#);
}

#[test]
fn across_blocks_newlines_and_paragraph_double_newline() {
    let mut d = open(r#"<p style="margin:0 0 20px">Hello world</p><div>Second line</div>"#);
    let out = d.serialize(at(&d, "world", false), at(&d, "Sec", true));
    assert_eq!(out.text, "world\n\nSec");
    assert_eq!(out.html, r#"<p style="margin:0 0 20px">world</p><div>Sec</div>"#);
}

#[test]
fn table_cells_join_with_tab_rows_with_newline() {
    let mut d = open(r#"<table><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></table>"#);
    let out = d.serialize(at(&d, "a1", false), at(&d, "b2", true));
    assert_eq!(out.text, "a1\tb1\na2\tb2");
}

#[test]
fn collapsed_whitespace_text_transform_br_and_list_marker_map_back() {
    let mut d = open("<p>a   lot\n of   space</p><p style=\"text-transform:uppercase\">straße</p><p>x<br>y</p><ul style=\"list-style-position:inside\"><li>item</li></ul>");
    let out = d.serialize(at(&d, "lot", false), at(&d, "spa", true));
    assert_eq!(out.text, "lot of spa");
    assert_eq!(out.html, "lot\n of   spa", "DOM text, not the collapsed layout text; a partial single paragraph is not wrapped in its block (WebKit)");
    let out = d.serialize(at(&d, "STRA", false), at(&d, "SSE", true));
    assert_eq!(out.text, "STRASSE", "copied as displayed, like WebKit");
    assert_eq!(out.html, "straße", "the DOM text, untransformed");
    let out = d.serialize(at(&d, "x", false), at(&d, "y", true));
    assert_eq!(out.text, "x\ny");
    assert_eq!(out.html, "x<br>y");
    let out = d.serialize(at(&d, "item", false), at(&d, "item", true));
    assert_eq!(out.text, "item", "the marker is generated, never copied");
}

#[test]
fn serialize_skips_folded_region() {
    let mut d = open(r#"<p>Reply text.</p><div data-mv-fold-toggle="q0" data-mv-noselect style="display:inline-block">⋯</div><blockquote data-mv-fold="q0" style="display:none"><p>Quoted.</p></blockquote><p>After.</p>"#);
    let out = d.serialize(at(&d, "Reply", false), at(&d, "After.", true));
    assert!(!out.text.contains("Quoted") && !out.html.contains("Quoted"), "{out:?}");
    assert!(!out.text.contains('⋯') && !out.html.contains('⋯'));
    assert!(out.text.starts_with("Reply text.") && out.text.ends_with("After."));
}

#[test]
fn serialize_skips_noselect() {
    let mut d = open(r#"<p>Hi <span class="mv-pii" data-mv-noselect>•••• ••••</span> there</p>"#);
    let out = d.serialize(at(&d, "Hi", false), at(&d, "there", true));
    assert!(!out.text.contains('•') && !out.html.contains('•'), "{out:?}");
    assert_eq!(out.text, "Hi  there");
}

#[test]
fn reversed_endpoints_are_swapped_and_no_highlight_is_left_behind() {
    let mut d = open("<p>abc def</p>");
    let fwd = d.serialize(at(&d, "abc", false), at(&d, "def", true));
    let rev = d.serialize(at(&d, "def", true), at(&d, "abc", false));
    assert_eq!(fwd, rev);
    assert_eq!(fwd.text, "abc def");
    let before = d.tile_png(0);
    let _ = d.serialize(at(&d, "abc", false), at(&d, "def", true));
    assert_eq!(d.tile_png(0), before, "blitz's own selection highlight must not paint");
}

#[test]
fn dommap_covers_every_layout_byte_exactly_once() {
    let d = open("<p>a   lot\n of <b>bold</b> <i>it</i></p><p style=\"text-transform:uppercase\">straße</p>");
    let roots = mailvault_render::text::inline_roots(d.base());
    assert!(roots.len() >= 2);
    for id in roots {
        assert!(mailvault_render::dommap::self_check(d.base(), id), "root {id:?} aligns");
    }
}

/// Every shape construct.rs pushes text for, with the whitespace quirks of parley's
/// span trimming: each inline root must align, or copy silently degrades.
#[test]
fn dommap_aligns_every_inline_shape() {
    let corpus = [
        "<p>  leading and trailing  </p>",
        "<p>a <b> b </b> c <i>  d</i>e</p>",
        "<p><span> </span>x<span> </span></p>",
        "<p>a&nbsp;&nbsp;b&nbsp;</p><p>&nbsp;lead</p>",
        "<p>a<br>b<br><br>c <br> d</p>",
        "<pre>  keep\n   all\n</pre>",
        "<p style=\"white-space:pre-wrap\">  a\n  b  </p>",
        "<p style=\"white-space:pre-line\">  a\n  b  </p>",
        "<p>a <span style=\"white-space:pre\">  b  </span> c</p>",
        "<p>x <span style=\"display:inline-block\">box</span> y <img src=\"a.png\" width=4 height=4> z</p>",
        "<p>a <span style=\"position:absolute\">abs</span> b <span style=\"float:right\">fl</span> c</p>",
        "<p>a <span style=\"display:contents\"> mid <b> in </b></span> z</p>",
        "<p>a <span style=\"display:none\">hidden</span> b <input type=\"hidden\" value=\"v\"> c</p>",
        "<p>a<!-- c --> b <button>btn</button> c <textarea>t</textarea> d <select><option>o</option></select></p>",
        "<p style=\"text-transform:uppercase\">straße <b>fin\u{3a3}</b></p><p style=\"text-transform:lowercase\">\u{3a3}A\u{3a3} \u{130}</p>",
        "<p>e\u{301} \u{1f600} \u{5e9}\u{5dc}\u{5d5}\u{5dd} <span dir=\"rtl\">\u{5d0}\u{5d1}</span></p>",
        "<ul style=\"list-style-position:inside\"><li>one</li><li> two <b>b</b></li></ul><ol style=\"list-style-position:inside\"><li>n</li></ol>",
        "<ul><li>outside <b>marker</b></li></ul>",
        "<style>p.q::before{content:\"> \"} p.q::after{content:\" <\"}</style><p class=\"q\">quoted</p><p class=\"q\"> <b>sp</b> </p>",
        "bare text <b>in body</b> next <div>block</div> tail ",
        "<div>one <p>block child</p> two</div>",
        "<table><tr><td> a </td><td>b <i>c</i></td></tr></table>",
        "<p></p><p> </p><p><b></b></p>",
    ];
    let mut checked = 0;
    for html in corpus {
        let d = open(html);
        for id in mailvault_render::text::inline_roots(d.base()) {
            assert!(mailvault_render::dommap::self_check(d.base(), id), "root {id:?} of {html:?} aligns");
            checked += 1;
        }
    }
    assert!(checked >= corpus.len(), "the corpus laid out inline roots ({checked})");
}

#[test]
fn bare_text_in_an_anonymous_block_copies_across_into_the_next_block() {
    let mut d = open("lead <b>bold</b><div>block</div>");
    let out = d.serialize(at(&d, "lead", false), at(&d, "block", true));
    assert_eq!(out.text, "lead bold\nblock");
    assert_eq!(out.html, "lead <b>bold</b><div>block</div>");
    let out = d.serialize(at(&d, "ead", false), at(&d, "ol", true));
    assert_eq!(out.text, "ead bol");
    assert_eq!(out.html, "ead <b>bol</b>");
}

#[test]
fn generated_content_is_not_copied() {
    let mut d = open(r#"<style>p.q::before{content:"> "}</style><p class="q">quoted <b>text</b></p>"#);
    let len = root_len(&d, 0);
    let out = d.serialize(root_at(&d, 0, 0), root_at(&d, 0, len));
    assert_eq!(out.text, "quoted text");
    assert_eq!(out.html, "quoted <b>text</b>");
}

#[test]
fn comments_scripts_handlers_and_markers_stay_out_of_the_markup() {
    let mut d = open(r#"<p>a<!--c--><span onclick="x()" data-mv-x="1" title="t">b</span><img src="x.png" alt="i">c</p>"#);
    let out = d.serialize(at(&d, "a", false), at(&d, "c", true));
    assert_eq!(out.html, r#"a<span title="t">b</span><img src="x.png" alt="i">c"#);
    assert_eq!(out.text, "abc", "{out:?}");
}

#[test]
fn offsets_inside_a_code_point_select_the_whole_code_point() {
    let mut d = open("<p>a\u{1f600}b</p><p>e\u{301}x</p><p>\u{5e9}\u{5dc}\u{5d5}\u{5dd}</p>");
    // 'a' is byte 0, the emoji bytes 1..5, 'b' byte 5.
    let out = d.serialize(root_at(&d, 0, 2), root_at(&d, 0, 4));
    assert_eq!((out.text.as_str(), out.html.as_str()), ("\u{1f600}", "\u{1f600}"));
    // Combining acute: bytes 1..3 of the second paragraph.
    let out = d.serialize(root_at(&d, 1, 1), root_at(&d, 1, 3));
    assert_eq!((out.text.as_str(), out.html.as_str()), ("\u{301}", "\u{301}"));
    // Hebrew, two bytes a letter, logical order: the middle two letters.
    let out = d.serialize(root_at(&d, 2, 2), root_at(&d, 2, 6));
    assert_eq!((out.text.as_str(), out.html.as_str()), ("\u{5dc}\u{5d5}", "\u{5dc}\u{5d5}"));
    // The same through a mid-letter offset on both ends.
    let out = d.serialize(root_at(&d, 2, 3), root_at(&d, 2, 5));
    assert_eq!(out.text, "\u{5dc}\u{5d5}");
}

#[test]
fn stale_or_out_of_range_endpoints_copy_nothing_and_never_panic() {
    let mut d = open("<p>hello</p>");
    let ok = root_at(&d, 0, 0);
    let empty = d.serialize(Endpoint { node: 987_654, offset: 0 }, ok);
    assert_eq!((empty.html.as_str(), empty.text.as_str()), ("", ""));
    let empty = d.serialize(ok, Endpoint { node: u64::MAX, offset: 3 });
    assert_eq!((empty.html.as_str(), empty.text.as_str()), ("", ""));
    let out = d.serialize(ok, Endpoint { offset: usize::MAX, ..ok });
    assert_eq!(out.text, "hello", "an end past the text is the end of the text");
    let none = d.serialize(Endpoint { offset: 2, ..ok }, Endpoint { offset: 2, ..ok });
    assert_eq!((none.html.as_str(), none.text.as_str()), ("", ""), "a collapsed selection copies nothing");
}

#[test]
fn a_selection_across_many_roots_and_tiles_keeps_order_and_separators() {
    let body: String = (0..60).map(|i| format!("<p>para {i:02} end</p>")).collect();
    let mut d = open(&body);
    assert!(d.meta().tile_count >= 3, "tall enough to span tiles");
    // `at` only looks at the first tiles; roots are addressed by index (one per paragraph).
    let out = d.serialize(root_at(&d, 3, 0), root_at(&d, 57, 9));
    let want: Vec<String> = (3..=57).map(|i| if i == 57 { "para 57 e".to_string() } else { format!("para {i:02} end") }).collect();
    assert_eq!(out.text, want.join("\n\n"));
    assert!(out.html.starts_with("<p>para 03 end</p><p>para 04 end</p>"), "{}", &out.html[..60]);
    assert!(out.html.ends_with("<p>para 56 end</p><p>para 57 e</p>"));
}

#[test]
fn serialize_op_replies_with_html_and_text() {
    let open_line = json!({"op":"open","req":1,"doc":1,"html":r#"<body style="margin:0;font:20px/30px 'MV Mono'"><p>Hello <b>big</b> world</p></body>"#,"cssWidth":400,"scale":1.0,"allowRemote":false});
    let run = |lines: Vec<Value>| -> Vec<Value> {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let mut out = Vec::new();
        mailvault_render::worker::run_with_fonts(std::io::Cursor::new(input.into_bytes()), &mut out, |_| {}, lib()).unwrap();
        BufReader::new(&out[..]).lines().map(|l| serde_json::from_str(&l.unwrap()).unwrap()).collect()
    };
    let first = run(vec![open_line.clone(), json!({"op":"textRuns","req":2,"doc":1,"index":0})]);
    let node = first[1]["ok"]["runs"][0]["node"].as_u64().unwrap();
    let out = run(vec![
        open_line,
        json!({"op":"serialize","req":2,"doc":1,"start":{"node":node,"offset":6},"end":{"node":node,"offset":9}}),
        json!({"op":"serialize","req":3,"doc":9,"start":{"node":node,"offset":0},"end":{"node":node,"offset":1}}),
        json!({"op":"serialize","req":4,"doc":1,"start":{"node":"x","offset":0},"end":{"node":node,"offset":1}}),
    ]);
    assert_eq!(out[1], json!({"kind":"reply","req":2,"ok":{"html":"<b>big</b>","text":"big"}}));
    assert_eq!(out[2], json!({"kind":"error","req":3,"code":"render_unknown_doc"}));
    assert_eq!(out[3], json!({"kind":"error","req":4,"code":"render_bad_request"}));
}
