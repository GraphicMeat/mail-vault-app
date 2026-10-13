use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};

/// Run the worker on scripted input; return every output line as JSON.
fn run(lines: &[Value]) -> Vec<Value> {
    run_with(lines, |_| {})
}

fn run_with(lines: &[Value], pre_open: fn(&str)) -> Vec<Value> {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut out = Vec::new();
    mailvault_render::worker::run(std::io::Cursor::new(input.into_bytes()), &mut out, pre_open).unwrap();
    BufReader::new(&out[..]).lines().map(|l| serde_json::from_str(&l.unwrap()).unwrap()).collect()
}

#[test]
fn open_then_tile_then_hit() {
    let html = r#"<body style="margin:0"><a href="https://x.test/" style="display:block;height:40px">x</a></body>"#;
    let out = run(&[
        json!({"op":"open","req":1,"doc":7,"html":html,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"tile","req":2,"doc":7,"index":0}),
        json!({"op":"hit","req":3,"doc":7,"x":5.0,"y":5.0}),
    ]);
    assert_eq!(out[0]["kind"], "reply");
    assert_eq!(out[0]["ok"]["rev"], 1);
    assert_eq!(out[0]["ok"]["meta"]["tileCount"], 1);
    let png = base64::engine::general_purpose::STANDARD.decode(out[1]["ok"]["png"].as_str().unwrap()).unwrap();
    assert_eq!(&png[1..4], b"PNG");
    assert_eq!(out[2]["ok"]["link"]["href"], "https://x.test/");
}

#[test]
fn remote_image_round_trip_bumps_rev() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":"<img src=\"https://i.test/a.png\" width=10 height=10>","cssWidth":100,"scale":1.0,"allowRemote":true}),
        json!({"op":"fetched","doc":1,"fetch":1,"bytes":null}),
    ]);
    assert_eq!(out[0]["kind"], "reply");
    assert_eq!(out[1], json!({"kind":"fetch","doc":1,"fetch":1,"url":"https://i.test/a.png"}));
    assert_eq!(out[2]["kind"], "updated");
    assert_eq!(out[2]["rev"], 2);
}

#[test]
fn unknown_doc_and_limits_are_error_codes() {
    let out = run(&[
        json!({"op":"tile","req":1,"doc":99,"index":0}),
        json!({"op":"open","req":2,"doc":2,"html":"a".repeat(mailvault_render::MAX_HTML_BYTES + 1),"cssWidth":100,"scale":1.0,"allowRemote":false}),
    ]);
    assert_eq!(out[0], json!({"kind":"error","req":1,"code":"render_unknown_doc"}));
    assert_eq!(out[1], json!({"kind":"error","req":2,"code":"render_too_large"}));
}

#[test]
fn close_forgets_the_doc() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":3,"html":"<p>x","cssWidth":100,"scale":1.0,"allowRemote":false}),
        json!({"op":"close","doc":3}),
        json!({"op":"hit","req":2,"doc":3,"x":1.0,"y":1.0}),
    ]);
    assert_eq!(out[1]["code"], "render_unknown_doc");
}

#[test]
fn garbage_line_is_skipped_not_fatal() {
    let input = "not json\n{\"op\":\"open\",\"req\":1,\"doc\":1,\"html\":\"<p>x\",\"cssWidth\":100,\"scale\":1.0,\"allowRemote\":false}\n";
    let mut out = Vec::new();
    mailvault_render::worker::run(std::io::Cursor::new(input.as_bytes().to_vec()), &mut out, |_| {}).unwrap();
    let first: Value = serde_json::from_str(std::str::from_utf8(&out).unwrap().lines().next().unwrap()).unwrap();
    assert_eq!(first["kind"], "reply");
}

fn boom_on_marker(html: &str) {
    if html.contains("BOOM-MARKER") {
        panic!("test panic in open");
    }
}

#[test]
fn a_panic_in_open_costs_that_doc_only() {
    let open = |req: u64, doc: u64, html: &str| json!({"op":"open","req":req,"doc":doc,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":false});
    let out = run_with(
        &[
            open(1, 1, "<p>fine"),
            open(2, 2, "<p>BOOM-MARKER"),
            json!({"op":"tile","req":3,"doc":1,"index":0}),
            json!({"op":"tile","req":4,"doc":2,"index":0}),
        ],
        boom_on_marker,
    );
    assert_eq!(out[0]["kind"], "reply");
    assert_eq!(out[1], json!({"kind":"error","req":2,"code":"render_unavailable"}));
    assert_eq!(out[2]["kind"], "reply", "the other doc survives and still tiles");
    assert_eq!(out[3], json!({"kind":"error","req":4,"code":"render_unknown_doc"}), "the panicked doc is gone");
}

#[test]
fn relative_url_mail_opens_through_the_worker() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":"<img src=\"logo.png\"><link rel=stylesheet href=\"s.css\">x","cssWidth":100,"scale":1.0,"allowRemote":true}),
        json!({"op":"tile","req":2,"doc":1,"index":0}),
    ]);
    assert_eq!(out[0]["kind"], "reply");
    assert_eq!(out[1]["kind"], "reply");
}
