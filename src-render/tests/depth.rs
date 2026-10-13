//! Deep nesting recurses in blitz (layout, text, hit, paint). These run through
//! the worker loop, which is the production path and owns a large stack. They
//! live in their own binary: a stack overflow aborts the whole process.
use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::time::{Duration, Instant};

fn run(lines: &[Value]) -> Vec<Value> {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut out = Vec::new();
    mailvault_render::worker::run(std::io::Cursor::new(input.into_bytes()), &mut out, |_| {}).unwrap();
    BufReader::new(&out[..]).lines().map(|l| serde_json::from_str(&l.unwrap()).unwrap()).collect()
}

fn nested(depth: usize) -> String {
    format!("<body style=\"margin:0\">{}x{}</body>", "<div>".repeat(depth), "</div>".repeat(depth))
}

fn open_and_tile(html: String) -> Vec<Value> {
    run(&[
        json!({"op":"open","req":1,"doc":1,"html":html,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"tile","req":2,"doc":1,"index":0}),
        json!({"op":"hit","req":3,"doc":1,"x":5.0,"y":5.0}),
    ])
}

#[test]
fn nesting_depth_200_renders_tiles_and_hits() {
    let out = open_and_tile(nested(200));
    assert_eq!(out[0]["kind"], "reply", "{:?}", out[0]);
    assert_eq!(out[1]["kind"], "reply");
    let png = base64::engine::general_purpose::STANDARD.decode(out[1]["ok"]["png"].as_str().unwrap()).unwrap();
    assert_eq!(&png[1..4], b"PNG");
    assert_eq!(out[2]["kind"], "reply");
}

#[test]
fn nesting_just_inside_the_limit_renders() {
    let out = open_and_tile(nested(240));
    assert_eq!(out[0]["kind"], "reply", "{:?}", out[0]);
    assert_eq!(out[1]["kind"], "reply");
}

#[test]
fn nesting_just_past_the_limit_is_refused() {
    // Elements the pre-parse guard does not count (here <section> is, <article> is not).
    let html = format!("<body>{}x{}</body>", "<article>".repeat(300), "</article>".repeat(300));
    let out = open_and_tile(html);
    assert_eq!(out[0]["code"], "render_too_complex", "the post-parse walk catches what the scan cannot");
}

#[test]
fn ten_thousand_nested_divs_are_refused_quickly_not_aborted() {
    let t = Instant::now();
    let out = open_and_tile(nested(10_000));
    assert_eq!(out[0], json!({"kind":"error","req":1,"code":"render_too_complex"}));
    assert_eq!(out[1]["code"], "render_unknown_doc", "the refused doc was never kept");
    assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
}

#[test]
fn a_hundred_thousand_nested_divs_are_refused_in_bounded_time() {
    let t = Instant::now();
    let out = open_and_tile(nested(100_000));
    assert_eq!(out[0]["code"], "render_too_complex");
    assert!(t.elapsed() < Duration::from_secs(30), "took {:?}", t.elapsed());
}
