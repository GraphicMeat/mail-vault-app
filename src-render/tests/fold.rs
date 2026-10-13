use base64::Engine;
use mailvault_render::fonts::FontLibrary;
use mailvault_render::{RenderDoc, RenderOptions};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};

const PAGE: &str = r#"<body style="margin:0;background:#fff">
<p style="margin:0;height:40px">Reply</p>
<div data-quote-toggle="true" data-mv-fold-toggle="q0" data-mv-noselect data-mv-label-closed="⋯" data-mv-label-open="▾ Hide quoted text"
     data-mv-dark-style="background:#374151;color:#9ca3af;border-color:#4b5563"
     style="cursor:pointer;color:#6b7280;background:#f3f4f6;display:inline-block;height:20px;width:40px">⋯</div>
<blockquote data-mv-fold="q0" data-mv-fold-kind="quote" data-mv-fold-open="false" data-quote-folded="true" style="display:none;margin:0"><p style="margin:0;height:300px">Quoted</p></blockquote>
</body>"#;

/// PAGE with a paragraph after the fold, so a copy can span it.
const WITH_AFTER: &str = r#"<body style="margin:0;background:#fff">
<p style="margin:0;height:40px">Reply</p>
<div data-mv-fold-toggle="q0" data-mv-noselect data-mv-label-closed="⋯" data-mv-label-open="Hide" style="display:inline-block;height:20px;width:40px">⋯</div>
<blockquote data-mv-fold="q0" data-mv-fold-kind="quote" data-mv-fold-open="false" style="display:none;margin:0"><p style="margin:0;height:100px">Quoted</p></blockquote>
<p style="margin:0;height:40px">After</p>
</body>"#;

fn open(html: &str) -> RenderDoc { RenderDoc::open(html, RenderOptions { css_width: 300, scale: 1.0, ..Default::default() }, None).unwrap() }

#[test]
fn meta_lists_folds_closed() {
    let m = open(PAGE).meta();
    assert_eq!(serde_json::to_value(&m.folds).unwrap(), json!([{"id":"q0","kind":"quote","open":false}]));
}

#[test]
fn meta_lists_signatures_and_skips_a_region_without_a_toggle() {
    let html = r#"<body><p>x</p>
<div data-mv-fold-toggle="s1" data-mv-label-closed="a" data-mv-label-open="b" style="display:inline-block">a</div>
<div data-mv-fold="s1" data-mv-fold-kind="signature" data-mv-fold-open="true">sig</div>
<blockquote data-mv-fold="q9" data-mv-fold-kind="quote" data-mv-fold-open="false" style="display:none">hidden for good</blockquote></body>"#;
    assert_eq!(serde_json::to_value(&open(html).meta().folds).unwrap(), json!([{"id":"s1","kind":"signature","open":true}]));
    assert!(open("<p>no folds</p>").meta().folds.is_empty());
}

#[test]
fn hit_on_toggle_returns_fold_id() {
    let d = open(PAGE);
    let (link, fold) = d.hit(10.0, 50.0);
    assert!(link.is_none());
    assert_eq!(fold.as_deref(), Some("q0"));
    assert_eq!(d.hit(10.0, 10.0).1, None);
}

#[test]
fn opening_relayouts_and_relabels_and_closing_restores() {
    let mut d = open(PAGE);
    let h0 = d.meta().css_height;
    assert!(d.set_fold("q0", true));
    let m = d.meta();
    assert!(m.css_height >= h0 + 299.0, "{} -> {}", h0, m.css_height);
    assert_eq!(m.folds[0].open, true);
    let label: String = d.text_runs_all_including_noselect_for_test().into_iter().find(|t| t.contains("Hide")).unwrap_or_default();
    assert_eq!(label, "▾ Hide quoted text");
    assert!(d.set_fold("q0", false));
    assert!((d.meta().css_height - h0).abs() < 0.5);
    assert!(!d.set_fold("nope", true), "unknown id is a no-op");
}

#[test]
fn a_fold_already_in_the_asked_state_changes_nothing() {
    let mut d = open(PAGE);
    assert!(!d.set_fold("q0", false), "closed stays closed");
    assert!(d.set_fold("q0", true));
    assert!(!d.set_fold("q0", true), "open stays open");
    assert!(!d.set_fold("q0\"] , [x", true), "only our ids reach a selector");
    assert!(!d.set_fold("", true));
}

#[test]
fn a_fold_closed_after_opening_leaves_no_runs_and_no_copy() {
    use mailvault_render::serialize::Endpoint;
    let mut d = open(PAGE);
    assert!(d.set_fold("q0", true));
    assert!((0..2).flat_map(|i| d.text_runs(i)).any(|r| r.text.contains("Quoted")), "open: selectable");
    assert!(d.set_fold("q0", false));
    let runs: Vec<_> = (0..2).flat_map(|i| d.text_runs(i)).collect();
    assert!(!runs.iter().any(|r| r.text.contains("Quoted")), "closed: gone from the layer: {runs:?}");
    let (first, last) = (runs.first().unwrap().clone(), runs.last().unwrap().clone());
    let out = d.serialize(Endpoint { node: first.node, offset: first.start }, Endpoint { node: last.node, offset: last.start + last.text.len() });
    assert!(!out.text.contains("Quoted") && !out.html.contains("Quoted"), "{out:?}");
}

/// Endpoint at `needle`'s first byte (or its end) in the run text.
fn at(d: &RenderDoc, needle: &str, end: bool) -> mailvault_render::serialize::Endpoint {
    for i in 0..2 {
        for r in d.text_runs(i) {
            if let Some(p) = r.text.find(needle) {
                return mailvault_render::serialize::Endpoint { node: r.node, offset: r.start + p + if end { needle.len() } else { 0 } };
            }
        }
    }
    panic!("{needle} not laid out");
}

#[test]
fn a_copy_across_a_fold_follows_the_fold_both_ways() {
    let mut d = open(WITH_AFTER);
    let (a, b) = (at(&d, "Reply", false), at(&d, "After", true));
    let closed = d.serialize(a, b);
    assert!(!closed.text.contains("Quoted") && !closed.html.contains("Quoted"), "closed: {closed:?}");
    assert!(closed.text.contains("Reply") && closed.text.contains("After"));

    assert!(d.set_fold("q0", true));
    let (a, b) = (at(&d, "Reply", false), at(&d, "After", true));
    let opened = d.serialize(a, b);
    assert!(opened.text.contains("Quoted") && opened.html.contains("Quoted"), "closed -> open: {opened:?}");
    assert!(!opened.text.contains("Hide") && !opened.html.contains("Hide"), "the toggle stays unselectable: {opened:?}");

    // The same endpoints as above, but the region closes under them: its nodes
    // keep a stale inline layout, which must not be copied.
    assert!(d.set_fold("q0", false));
    let again = d.serialize(a, b);
    assert!(!again.text.contains("Quoted") && !again.html.contains("Quoted"), "open -> closed: {again:?}");
    assert_eq!(again.text, closed.text);

    assert!(d.set_fold("q0", true));
    let reopened = d.serialize(a, b);
    assert_eq!(reopened.text, opened.text, "and open again");
}

#[test]
fn text_runs_follow_a_fold_toggle_even_when_they_were_cached() {
    let mut d = open(WITH_AFTER);
    let y_of = |d: &RenderDoc, needle: &str| (0..2).flat_map(|i| d.text_runs(i)).find(|r| r.text.contains(needle)).map(|r| r.y);
    let closed_y = y_of(&d, "After").expect("After laid out"); // fills the run cache
    assert!(y_of(&d, "Quoted").is_none());
    assert!(d.set_fold("q0", true));
    let open_y = y_of(&d, "After").unwrap();
    assert!(open_y >= closed_y + 99.0, "After moved down by the region: {closed_y} -> {open_y}");
    assert!(y_of(&d, "Quoted").is_some(), "the opened region is selectable");
    assert!(d.set_fold("q0", false));
    assert_eq!(y_of(&d, "After"), Some(closed_y));
    assert!(y_of(&d, "Quoted").is_none());
}

#[test]
fn dark_body_switches_quote_toggle_to_the_dark_variant() {
    let mut d = open(&PAGE.replace("background:#fff", "background:#111"));
    let colors = d.inspect_toggle_colors_for_test("q0");
    assert_eq!(colors, ("rgb(55, 65, 81)".to_string(), "rgb(156, 163, 175)".to_string()));
    let mut l = open(PAGE);
    assert_eq!(l.inspect_toggle_colors_for_test("q0").0, "rgb(243, 244, 246)");
}

#[test]
fn the_dark_toggle_keeps_its_colours_through_a_relabel() {
    let mut d = open(&PAGE.replace("background:#fff", "background:#111"));
    assert!(d.set_fold("q0", true));
    assert_eq!(d.inspect_toggle_colors_for_test("q0").0, "rgb(55, 65, 81)");
}

fn run(lines: &[Value]) -> Vec<Value> {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut out = Vec::new();
    mailvault_render::worker::run(std::io::Cursor::new(input.into_bytes()), &mut out, |_| {}).unwrap();
    BufReader::new(&out[..]).lines().map(|l| serde_json::from_str(&l.unwrap()).unwrap()).collect()
}

#[test]
fn worker_fold_bumps_rev_and_hit_reports_fold() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":PAGE,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"hit","req":2,"doc":1,"x":10.0,"y":50.0}),
        json!({"op":"fold","req":3,"doc":1,"id":"q0","open":true}),
        json!({"op":"fold","req":4,"doc":1,"id":"zz","open":true}),
    ]);
    assert_eq!(out[1]["ok"], json!({"link": null, "fold": "q0"}));
    assert_eq!(out[2]["ok"]["rev"], 2);
    assert_eq!(out[2]["ok"]["meta"]["folds"][0]["open"], true);
    assert_eq!(out[3]["kind"], "updated", "a fold is announced like any relayout");
    assert_eq!(out[3]["doc"], 1);
    assert_eq!(out[3]["rev"], 2);
    assert_eq!(out[4]["ok"]["rev"], 2, "unknown id: no rev bump");
    assert_eq!(out.len(), 5, "and no updated frame for a no-op");
}

#[test]
fn worker_fold_to_the_state_it_is_in_is_a_no_op_and_bad_requests_are_answered() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":PAGE,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"fold","req":2,"doc":1,"id":"q0","open":false}),
        json!({"op":"fold","req":3,"doc":1}),
        json!({"op":"fold","req":4,"doc":99,"id":"q0","open":true}),
    ]);
    assert_eq!(out[1]["ok"]["rev"], 1, "already closed: nothing changed");
    assert_eq!(out[2], json!({"kind":"error","req":3,"code":"render_bad_request"}));
    assert_eq!(out[3], json!({"kind":"error","req":4,"code":"render_unknown_doc"}));
    assert_eq!(out.len(), 4, "no updated frame");
}

#[test]
fn a_fonts_rebuild_keeps_the_folds_as_the_user_left_them() {
    let asset = std::fs::read(format!("{}/../src/assets/fonts/ibm-plex-mono-latin-400.woff2", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let b64 = base64::engine::general_purpose::STANDARD.encode(asset);
    let html = PAGE.replace("<body style=\"margin:0;", "<body style=\"font-family:'Late Mono',serif;margin:0;");
    let lines = [
        json!({"op":"open","req":1,"doc":1,"html":html,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"fold","req":2,"doc":1,"id":"q0","open":true}),
        json!({"op":"fonts","families":[{"family":"Late Mono","faces":[{"data":b64,"weight":400,"style":"normal"}]}]}),
    ];
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut raw = Vec::new();
    mailvault_render::worker::run_with_fonts(std::io::Cursor::new(input.into_bytes()), &mut raw, |_| {}, FontLibrary::new(false)).unwrap();
    let out: Vec<Value> = BufReader::new(&raw[..]).lines().map(|l| serde_json::from_str(&l.unwrap()).unwrap()).collect();
    let rebuilt = out.iter().filter(|v| v["kind"] == "updated").last().unwrap();
    assert_eq!(rebuilt["rev"], 3, "fold, then the rebuild");
    assert_eq!(rebuilt["meta"]["folds"][0]["open"], true, "{rebuilt}");
    assert!(rebuilt["meta"]["cssHeight"].as_f64().unwrap() >= 300.0, "the opened quote is still laid out");
}
