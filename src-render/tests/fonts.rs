use base64::Engine;
use mailvault_render::fonts::{FaceData, FontLibrary};
use mailvault_render::{RenderDoc, RenderOptions};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};

fn asset(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../src/assets/fonts/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}
pub fn mono_lib() -> FontLibrary {
    let mut lib = FontLibrary::new(false);
    lib.register("MV Mono", vec![FaceData { data: asset("ibm-plex-mono-latin-400.woff2"), weight: 400, style: "normal".into() }]);
    lib
}
fn opts() -> RenderOptions { RenderOptions { css_width: 400, scale: 1.0, ..Default::default() } }

#[test]
fn registered_family_lays_out_and_unknown_one_does_not() {
    let html = r#"<body style="margin:0"><p style="margin:0;font:20px/30px 'MV Mono'">abcdefghij</p></body>"#;
    let with = RenderDoc::open_with(html, opts(), None, mono_lib().context()).unwrap();
    let runs = with.text_runs(0);
    assert_eq!(runs.len(), 1);
    // Plex Mono advance is 0.6em: 10 chars x 12px.
    assert!((runs[0].w - 120.0).abs() < 0.5, "w {}", runs[0].w);
}

#[test]
fn woff2_is_decoded_before_registration() {
    let mut lib = FontLibrary::new(false);
    assert!(lib.register("MV Mono", vec![FaceData { data: asset("ibm-plex-mono-latin-400.woff2"), weight: 400, style: "normal".into() }]));
    assert!(lib.has("mv mono"), "case-insensitive");
    assert!(!lib.register("MV Mono", vec![]), "second registration of a family is not new");
}

#[test]
fn bullets_still_draw_with_our_own_context() {
    // We build the context ourselves, so blitz's BULLET_FONT registration is ours to do.
    let html = r#"<body style="margin:0"><ul style="list-style-position:inside;font:20px/30px 'MV Mono';margin:0;padding:0"><li>x</li></ul></body>"#;
    let doc = RenderDoc::open_with(html, opts(), None, mono_lib().context()).unwrap();
    let text: String = doc.text_runs(0).iter().map(|r| r.text.clone()).collect();
    assert!(text.contains('x'));
    assert!(text.contains('\u{2022}'), "marker painted with the bullet font: {text:?}");
}

#[test]
fn latin_ext_subset_registered_under_the_same_family_keeps_the_latin_face() {
    // Only one subset per weight is kept (fonts.rs): Ł is not drawn by the
    // latin-ext file but by the next family; with none here it is the latin
    // face's .notdef, so the run stays whole.
    let mut lib = mono_lib();
    lib.register("MV Mono Ext", vec![
        FaceData { data: asset("ibm-plex-mono-latin-400.woff2"), weight: 400, style: "normal".into() },
        FaceData { data: asset("ibm-plex-mono-latin-ext-400.woff2"), weight: 400, style: "normal".into() },
    ]);
    let html = r#"<body style="margin:0"><p style="margin:0;font:20px/30px 'MV Mono Ext'">aŁa</p></body>"#;
    let doc = RenderDoc::open_with(html, opts(), None, lib.context()).unwrap();
    let runs = doc.text_runs(0);
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert!((runs[0].w - 36.0).abs() < 0.5);
}

fn face(name: &str, weight: u16) -> FaceData {
    FaceData { data: asset(name), weight, style: "normal".into() }
}

/// A proportional family after the one under test, so a glyph the tested
/// family does not draw lands in a font of a different width (with no
/// fallback, a missing glyph is the same font's .notdef and nothing shows).
fn lib_with_fallback() -> FontLibrary {
    let mut lib = FontLibrary::new(false);
    lib.register("Fallback", vec![face("inter-latin.woff2", 400)]);
    lib
}

fn mono_width(lib: &FontLibrary, css: &str, text: &str) -> (usize, f32) {
    let html = format!(r#"<body style="margin:0"><p style="margin:0;font:{css}">{text}</p></body>"#);
    let doc = RenderDoc::open_with(&html, opts(), None, lib.context()).unwrap();
    let runs = doc.text_runs(0);
    (runs.len(), runs.iter().map(|r| r.w).sum())
}

#[test]
fn a_latin_ext_subset_listed_first_does_not_hide_the_latin_face() {
    // css2 lists each weight's latin-ext block before its latin one, and the
    // daemon sends the faces in that order.
    let mut lib = lib_with_fallback();
    lib.register("MV Sub", vec![face("ibm-plex-mono-latin-ext-400.woff2", 400), face("ibm-plex-mono-latin-400.woff2", 400)]);
    let (n, w) = mono_width(&lib, "20px/30px 'Fallback'", "abcdefghij");
    assert!((w - 120.0).abs() > 2.0, "control: the fallback is not monospace ({w})");
    let (n2, w2) = mono_width(&lib, "20px/30px 'MV Sub', 'Fallback'", "abcdefghij");
    assert_eq!((n2, (w2 * 10.0).round() / 10.0), (1, 120.0), "latin letters in the latin face, one run (fallback alone: {n} runs, {w})");
}

#[test]
fn a_weight_between_registered_ones_still_lands_on_the_latin_face() {
    // 800 is matched by the nearest lower weight (700), where two faces tie.
    let mut lib = lib_with_fallback();
    lib.register("MV Sub", vec![
        face("ibm-plex-mono-latin-ext-400.woff2", 400),
        face("ibm-plex-mono-latin-400.woff2", 400),
        face("ibm-plex-mono-latin-ext-700.woff2", 700),
        face("ibm-plex-mono-latin-700.woff2", 700),
    ]);
    for weight in [400, 500, 700, 800] {
        let (n, w) = mono_width(&lib, &format!("{weight} 20px/30px 'MV Sub', 'Fallback'"), "abcdefghij");
        assert_eq!((n, (w * 10.0).round() / 10.0), (1, 120.0), "weight {weight}");
    }
}

fn run_worker(lines: &[Value]) -> Vec<Value> {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut out = Vec::new();
    mailvault_render::worker::run_with_fonts(std::io::Cursor::new(input.into_bytes()), &mut out, |_| {}, FontLibrary::new(false)).unwrap();
    BufReader::new(&out[..]).lines().map(|l| serde_json::from_str(&l.unwrap()).unwrap()).collect()
}

#[test]
fn fonts_op_rebuilds_only_docs_naming_the_family_and_keeps_doc_id() {
    let b64 = base64::engine::general_purpose::STANDARD.encode(asset("ibm-plex-mono-latin-400.woff2"));
    let names = r#"<body style="margin:0"><p style="margin:0;font:20px/30px 'Late Mono', serif">abc</p></body>"#;
    let other = r#"<body style="margin:0"><p>latemono explorations of late mono-spaced type</p></body>"#;
    let out = run_worker(&[
        json!({"op":"open","req":1,"doc":1,"html":names,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"open","req":2,"doc":2,"html":other,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"fonts","families":[{"family":"Late Mono","faces":[{"data":b64,"weight":400,"style":"normal"}]}]}),
    ]);
    let updated: Vec<_> = out.iter().filter(|v| v["kind"] == "updated").collect();
    assert_eq!(updated.len(), 1, "only doc 1 names the family");
    assert_eq!(updated[0]["doc"], 1);
    assert_eq!(updated[0]["rev"], 2);
}

#[test]
fn rebuilt_doc_lays_out_in_the_late_font() {
    let b64 = base64::engine::general_purpose::STANDARD.encode(asset("ibm-plex-mono-latin-400.woff2"));
    let names = r#"<body style="margin:0"><p style="margin:0;font:20px/30px 'Late Mono', serif">abc</p></body>"#;
    let out = run_worker(&[
        json!({"op":"open","req":1,"doc":1,"html":names,"cssWidth":300,"scale":1.0,"allowRemote":false}),
        json!({"op":"fonts","families":[{"family":"Late Mono","faces":[{"data":b64,"weight":400,"style":"normal"}]}]}),
        json!({"op":"textRuns","req":3,"doc":1,"index":0}),
    ]);
    let runs = out.iter().find(|v| v["req"] == 3).unwrap();
    assert!((runs["ok"]["runs"][0]["w"].as_f64().unwrap() - 36.0).abs() < 0.5, "rebuilt doc uses the font");
}

#[test]
fn rebuild_answers_images_from_cache_and_never_refetches() {
    let b64 = base64::engine::general_purpose::STANDARD.encode(asset("ibm-plex-mono-latin-400.woff2"));
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    let html = r#"<body style="margin:0;font-family:'Late Mono'"><img src="https://i.test/a.png" width=10 height=10>x</body>"#;
    let out = run_worker(&[
        json!({"op":"open","req":1,"doc":1,"html":html,"cssWidth":100,"scale":1.0,"allowRemote":true}),
        json!({"op":"fetched","doc":1,"fetch":1,"bytes":png}),
        json!({"op":"fonts","families":[{"family":"Late Mono","faces":[{"data":b64,"weight":400,"style":"normal"}]}]}),
        json!({"op":"tile","req":5,"doc":1,"index":0}),
    ]);
    let fetches = out.iter().filter(|v| v["kind"] == "fetch").count();
    assert_eq!(fetches, 1, "the rebuild took the image from the cache: {out:?}");
    assert_eq!(out.iter().filter(|v| v["kind"] == "updated").last().unwrap()["rev"], 3);
    let tile = out.iter().find(|v| v["req"] == 5).unwrap();
    assert!(has_red(tile["ok"]["png"].as_str().unwrap()), "the rebuilt doc paints the cached image, not a blank");
}

/// Any pure red pixel (the 1px test PNG, stretched). The line box puts the image
/// below the tile's top edge, so (0,0) is not it.
fn has_red(png_b64: &str) -> bool {
    let png = base64::engine::general_purpose::STANDARD.decode(png_b64).unwrap();
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    r.next_frame(&mut buf).unwrap();
    buf.chunks(3).any(|p| p == [255, 0, 0])
}

#[test]
fn a_net_built_from_the_old_cache_serves_the_image_without_a_fetch() {
    use mailvault_render::net::BridgeNet;
    let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    let png = base64::engine::general_purpose::STANDARD.decode(png_b64).unwrap();
    let html = r#"<body style="margin:0"><img src="https://i.test/a.png" width=10 height=10></body>"#;
    let old = BridgeNet::new(true);
    let _doc = RenderDoc::open_with(html, opts(), Some(old.clone()), mono_lib().context()).unwrap();
    let id = old.take_outbox()[0].id;
    assert!(old.complete(id, Some(png.clone())));
    let cache = old.cache();
    assert_eq!(cache.get("https://i.test/a.png"), Some(&png), "the answered fetch is cached");

    let net = BridgeNet::with_cache(true, cache);
    let mut doc = RenderDoc::open_with(html, opts(), Some(net.clone()), mono_lib().context()).unwrap();
    assert!(net.take_outbox().is_empty(), "served from the cache, nothing queued");
    doc.apply_resources();
    let tile = base64::engine::general_purpose::STANDARD.encode(doc.tile_png(0).unwrap());
    assert!(has_red(&tile), "the cached image is painted");
}
