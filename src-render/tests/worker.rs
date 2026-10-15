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

#[test]
fn a_malformed_op_with_a_req_is_answered_not_dropped() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":"<p>x","cssWidth":300.5,"scale":1.0,"allowRemote":false}),
        json!({"op":"tile","req":2,"doc":1,"index":"zero"}),
        json!({"op":"hit","req":3,"doc":1}),
        json!({"op":"open","req":4,"doc":1,"html":"<p>x","cssWidth":100,"scale":1.0,"allowRemote":false}),
    ]);
    assert_eq!(out.len(), 4, "every request is answered exactly once: {out:?}");
    for (i, req) in [(0, 1), (1, 2), (2, 3)] {
        assert_eq!(out[i], json!({"kind":"error","req":req,"code":"render_bad_request"}));
    }
    assert_eq!(out[3]["kind"], "reply", "a good op after the bad ones still works");
}

#[test]
fn a_malformed_close_or_garbage_has_no_reply_to_send() {
    let out = run(&[json!({"op":"close"}), json!({"op":"nope","req":9}), json!({"req":10})]);
    assert!(out.is_empty(), "{out:?}");
}

// A caught panic leaves the process in an unknown state (a half-run mutator
// drop, a shared lock poisoned in stylo or fontique), so the worker serves its
// remaining documents and then exits for the host to respawn clean.
fn open_op(req: u64, doc: u64, html: &str) -> Value {
    json!({"op":"open","req":req,"doc":doc,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":false})
}

#[test]
fn a_worker_that_caught_a_panic_exits_once_its_last_doc_is_closed() {
    let out = run_with(
        &[
            open_op(1, 1, "<p>fine"),
            open_op(2, 2, "<p>BOOM-MARKER"),
            json!({"op":"tile","req":3,"doc":1,"index":0}),
            json!({"op":"close","doc":1}),
            open_op(4, 3, "<p>after"),
            json!({"op":"tile","req":5,"doc":3,"index":0}),
        ],
        boom_on_marker,
    );
    assert_eq!(out[1], json!({"kind":"error","req":2,"code":"render_unavailable"}));
    assert_eq!(out[2]["kind"], "reply", "tainted, but the other doc is still served");
    assert_eq!(out.len(), 3, "after the last doc closed the worker is gone, so later requests get no answer: {out:?}");
}

#[test]
fn a_worker_that_caught_a_panic_with_no_other_doc_exits_at_once() {
    let out = run_with(&[open_op(1, 1, "<p>BOOM-MARKER"), open_op(2, 2, "<p>next")], boom_on_marker);
    assert_eq!(out, vec![json!({"kind":"error","req":1,"code":"render_unavailable"})], "the panic is answered, then the worker exits");
}

#[test]
fn a_worker_that_never_panicked_stays_up_after_its_last_doc_closes() {
    let out = run(&[open_op(1, 1, "<p>x"), json!({"op":"close","doc":1}), open_op(2, 2, "<p>y")]);
    assert_eq!(out.len(), 2);
    assert_eq!(out[1]["kind"], "reply");
}

#[test]
fn text_runs_answers_unknown_docs_and_malformed_requests_with_their_req() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":"<p>x","cssWidth":100,"scale":1.0,"allowRemote":false}),
        json!({"op":"textRuns","req":2,"doc":99,"index":0}),
        json!({"op":"textRuns","req":3,"doc":1,"index":"zero"}),
        json!({"op":"textRuns","req":4,"doc":1,"index":0}),
    ]);
    assert_eq!(out[1], json!({"kind":"error","req":2,"code":"render_unknown_doc"}));
    assert_eq!(out[2], json!({"kind":"error","req":3,"code":"render_bad_request"}));
    assert_eq!(out[3]["req"], 4);
    assert_eq!(out[3]["ok"]["runs"][0]["text"], "x");
    assert_eq!(out[3]["ok"]["owners"], json!([]));
}

#[test]
fn text_runs_names_the_tiles_whose_roots_run_into_this_one() {
    let html = r#"<body style="margin:0;font:20px/30px sans-serif"><div style="height:480px"></div><p style="margin:0;width:60px">aaaa bbbb cccc dddd</p>"#;
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":html,"cssWidth":200,"scale":1.0,"allowRemote":false}),
        json!({"op":"textRuns","req":2,"doc":1,"index":1}),
    ]);
    assert_eq!(out[1]["ok"]["runs"], json!([]));
    assert_eq!(out[1]["ok"]["owners"], json!([0]));
}

#[test]
fn inspect_op_reports_marked_elements() {
    let html = r#"<body style="margin:0"><p data-mv-id="p[1]" style="color:#ff0000">x</p></body>"#;
    let out = run(&[
        json!({"op":"open","req":1,"doc":4,"html":html,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"inspect","req":2,"doc":4}),
        json!({"op":"inspect","req":3,"doc":99}),
    ]);
    let els = out[1]["ok"]["elements"].as_array().unwrap();
    assert_eq!(els[0]["mvId"], "p[1]");
    assert_eq!(els[0]["color"], json!([255.0, 0.0, 0.0, 1.0]));
    assert_eq!(out[2]["code"], "render_unknown_doc");
}

#[test]
fn a_malformed_inspect_is_answered_not_dropped() {
    let out = run(&[json!({"op":"inspect","req":1,"doc":"one"})]);
    assert_eq!(out, vec![json!({"kind":"error","req":1,"code":"render_bad_request"})]);
}

#[test]
fn dark_open_paints_the_dr_background() {
    let html = r#"<html><head><style>body{margin:0;background:#ffffff}</style></head><body data-mv-id="b"></body></html>"#;
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":false,
               "theme":{"mode":"dark","bg":"#0a0a12","fg":"#e8e8ef","brightness":100,"contrast":100,"sepia":0}}),
        json!({"op":"inspect","req":2,"doc":1}),
    ]);
    assert_eq!(out[1]["ok"]["elements"][0]["backgroundColor"], json!([10.0, 10.0, 18.0, 1.0]));
}

#[test]
fn a_light_theme_does_not_touch_the_document() {
    let html = r#"<html><head><style>body{margin:0;background:#ffffff}</style></head><body data-mv-id="b"></body></html>"#;
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":false,"theme":{"mode":"light"}}),
        json!({"op":"inspect","req":2,"doc":1}),
    ]);
    assert_eq!(out[1]["ok"]["elements"][0]["backgroundColor"], json!([255.0, 255.0, 255.0, 1.0]));
}

#[test]
fn open_without_theme_and_with_null_bg_both_reply_ok() {
    let html = r#"<html><body data-mv-id="p"><p>x</p></body></html>"#;
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":false}),
        json!({"op":"open","req":2,"doc":2,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":false,
               "theme":{"mode":"dark","bg":null,"fg":"#e8e8ef"}}),
        json!({"op":"open","req":3,"doc":3,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":false,"theme":null}),
    ]);
    for (i, frame) in out.iter().filter(|f| f["kind"] != "fetch").take(3).enumerate() {
        assert_eq!(frame["kind"], "reply", "open {} failed: {frame}", i + 1);
    }
}

#[test]
fn image_op_and_transparent_open() {
    let html = r#"<html><body style="margin:0;background:transparent"><div style="height:100px"></div></body></html>"#;
    let out = run(&[
        json!({"op":"open","req":1,"doc":7,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":false,"theme":{"mode":"light","bg":null}}),
        json!({"op":"image","req":2,"doc":7}),
        json!({"op":"image","req":3,"doc":99}),
    ]);
    assert_eq!(out[0]["kind"], "reply");
    let png = base64::engine::general_purpose::STANDARD.decode(out[1]["ok"]["png"].as_str().unwrap()).unwrap();
    assert_eq!(&png[1..4], b"PNG");
    assert_eq!(png[25], 6, "colour type 6 (RGBA): bg null opened a transparent doc");
    assert_eq!(out[2], json!({"kind":"error","req":3,"code":"render_unknown_doc"}));
}

/// Only a theme that is present with `"bg": null` is transparent. A missing
/// theme, a theme with no `bg` key, and a colour `bg` all stay opaque RGB over
/// white. Every open still parses: B's `WireTheme` must not reject `null`.
#[test]
fn only_bg_null_is_transparent() {
    let html = r#"<html><body style="margin:0"><div style="height:50px"></div></body></html>"#;
    let open = |req: u64, doc: u64, theme: Option<serde_json::Value>| {
        let mut o = json!({"op":"open","req":req,"doc":doc,"html":html,"cssWidth":50,"scale":1.0,"allowRemote":false});
        if let Some(t) = theme {
            o["theme"] = t;
        }
        o
    };
    let out = run(&[
        open(1, 1, Some(json!({"mode":"light","bg":null}))),
        open(2, 2, None),
        open(3, 3, Some(json!({"mode":"light"}))),
        open(4, 4, Some(json!({"mode":"light","bg":"#ffffff"}))),
        json!({"op":"tile","req":5,"doc":1,"index":0}),
        json!({"op":"tile","req":6,"doc":2,"index":0}),
        json!({"op":"tile","req":7,"doc":3,"index":0}),
        json!({"op":"tile","req":8,"doc":4,"index":0}),
    ]);
    for i in 0..4 {
        assert_eq!(out[i]["kind"], "reply", "open {} parsed and succeeded: {}", i + 1, out[i]);
    }
    let colour = |i: usize| base64::engine::general_purpose::STANDARD.decode(out[i]["ok"]["png"].as_str().unwrap()).unwrap()[25];
    assert_eq!(colour(4), 6, "bg null -> RGBA");
    assert_eq!(colour(5), 2, "no theme -> RGB");
    assert_eq!(colour(6), 2, "theme without bg -> RGB");
    assert_eq!(colour(7), 2, "colour bg -> RGB");
}

#[test]
fn a_malformed_image_op_is_answered_not_dropped() {
    let out = run(&[json!({"op":"image","req":1,"doc":"one"})]);
    assert_eq!(out, vec![json!({"kind":"error","req":1,"code":"render_bad_request"})]);
}

fn red_square_png() -> String {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, 10, 10);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&[255, 0, 0].repeat(100)).unwrap();
    base64::engine::general_purpose::STANDARD.encode(out)
}

/// `fetched` and `image` can share one stdin batch (the daemon's `settled()`
/// resolves right after it writes the answer). The image must still show what
/// the answer delivered, and the `updated` frame must come before the reply.
#[test]
fn an_image_op_paints_the_resources_that_arrived_just_before_it() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":"<body style=\"margin:0\"><img src=\"https://i.test/a.png\" width=10 height=10></body>","cssWidth":20,"scale":1.0,"allowRemote":true}),
        json!({"op":"fetched","doc":1,"fetch":1,"bytes":red_square_png()}),
        json!({"op":"image","req":2,"doc":1}),
    ]);
    let updated = out.iter().position(|f| f["kind"] == "updated").expect("an updated frame");
    let reply = out.iter().position(|f| f["req"] == 2).expect("the image reply");
    assert!(updated < reply, "updated before the image reply: {out:?}");
    let bytes = base64::engine::general_purpose::STANDARD.decode(out[reply]["ok"]["png"].as_str().unwrap()).unwrap();
    let mut r = png::Decoder::new(&bytes[..]).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    let px = (5 * info.width as usize + 5) * 3;
    assert_eq!(&buf[px..px + 3], &[255, 0, 0], "the fetched image is in the picture");
}

/// The settle step of an export that draws tiles: images that landed relaid the doc out, so the reply carries the
/// NEW meta (taller than `open`'s) and rev, after the `updated` frame, and paints nothing.
#[test]
fn a_settle_only_image_op_refreshes_a_dirty_doc_and_replies_with_its_new_meta() {
    let out = run(&[
        json!({"op":"open","req":1,"doc":1,"html":"<body style=\"margin:0\"><img src=\"https://i.test/a.png\" width=10></body>","cssWidth":20,"scale":1.0,"allowRemote":true}),
        json!({"op":"fetched","doc":1,"fetch":1,"bytes":red_square_png()}),
        json!({"op":"image","req":2,"doc":1,"settleOnly":true}),
        json!({"op":"image","req":3,"doc":1,"settleOnly":true}),
        json!({"op":"tile","req":4,"doc":1,"index":0}),
        json!({"op":"image","req":5,"doc":99,"settleOnly":true}),
    ]);
    let open_h = out.iter().find(|f| f["req"] == 1).unwrap()["ok"]["meta"]["cssHeight"].as_f64().unwrap();
    let updated = out.iter().position(|f| f["kind"] == "updated").expect("an updated frame");
    let reply = out.iter().position(|f| f["req"] == 2).expect("the settle reply");
    assert!(updated < reply, "updated before the settle reply: {out:?}");
    let ok = &out[reply]["ok"];
    assert!(ok.get("png").is_none(), "settle paints nothing: {ok}");
    assert_eq!(ok["rev"], 2, "the refresh bumped rev");
    assert_eq!(ok["meta"], out[updated]["meta"]);
    let new_h = ok["meta"]["cssHeight"].as_f64().unwrap();
    assert!(new_h >= 10.0 && new_h > open_h, "the doc grew when the image landed: {open_h} -> {new_h}");
    // Nothing is dirty the second time: same rev, no second updated frame.
    let again = out.iter().find(|f| f["req"] == 3).unwrap();
    assert_eq!(again["ok"]["rev"], 2);
    assert_eq!(out.iter().filter(|f| f["kind"] == "updated").count(), 1);
    assert_eq!(out.iter().find(|f| f["req"] == 4).unwrap()["kind"], "reply");
    assert_eq!(out.iter().find(|f| f["req"] == 5).unwrap(), &json!({"kind":"error","req":5,"code":"render_unknown_doc"}));
}
