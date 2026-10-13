use mailvault_render::net::BridgeNet;
use mailvault_render::{RenderDoc, RenderOptions};
use std::sync::Arc;

const RED_1PX_PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

fn opts() -> RenderOptions { RenderOptions::new(200, 1.0) }

#[test]
fn data_url_image_is_decoded_in_process_and_never_queued() {
    let net = BridgeNet::new(true);
    let html = format!(r#"<body style="margin:0"><img src="data:image/png;base64,{RED_1PX_PNG_B64}" width="50" height="50"></body>"#);
    let mut doc = RenderDoc::open(&html, opts(), Some(net.clone() as Arc<_>)).unwrap();
    assert!(net.take_outbox().is_empty());
    doc.apply_resources();
    let png = doc.tile_png(0);
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    r.next_frame(&mut buf).unwrap();
    assert_eq!(&buf[0..3], &[255, 0, 0], "decoded data: image painted");
}

#[test]
fn https_image_is_queued_once_with_its_url() {
    let net = BridgeNet::new(true);
    let _doc = RenderDoc::open(r#"<img src="https://img.example.com/a.png">"#, opts(), Some(net.clone() as Arc<_>)).unwrap();
    let out = net.take_outbox();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].url, "https://img.example.com/a.png");
    assert!(net.take_outbox().is_empty(), "outbox drains");
}

#[test]
fn http_file_and_cid_are_denied_without_queueing() {
    let net = BridgeNet::new(true);
    let html = r#"<img src="http://a.example/x.png"><img src="file:///etc/passwd"><img src="cid:abc">"#;
    let _doc = RenderDoc::open(html, opts(), Some(net.clone() as Arc<_>)).unwrap();
    assert!(net.take_outbox().is_empty());
}

#[test]
fn remote_off_queues_nothing() {
    let net = BridgeNet::new(false);
    let _doc = RenderDoc::open(r#"<img src="https://img.example.com/a.png">"#, opts(), Some(net.clone() as Arc<_>)).unwrap();
    assert!(net.take_outbox().is_empty());
}

#[test]
fn denied_stylesheet_does_not_block_paint() {
    let net = BridgeNet::new(true);
    let html = r#"<link rel="stylesheet" href="https://css.example.com/s.css"><body style="margin:0;background:#00f"><div style="height:20px"></div></body>"#;
    let mut doc = RenderDoc::open(html, opts(), Some(net.clone() as Arc<_>)).unwrap();
    let out = net.take_outbox();
    assert_eq!(out.len(), 1);
    assert!(doc.has_pending_critical(), "stylesheet is critical until answered");
    assert!(net.complete(out[0].id, None));
    doc.apply_resources();
    assert!(!doc.has_pending_critical(), "a denial answers the request");
    let png = doc.tile_png(0);
    let mut r = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    r.next_frame(&mut buf).unwrap();
    assert_eq!(&buf[0..3], &[0, 0, 255], "body painted, not blank");
}

#[test]
fn complete_unknown_id_is_false_and_fail_all_answers_everything() {
    let net = BridgeNet::new(true);
    let html = r#"<link rel="stylesheet" href="https://css.example.com/s.css"><img src="https://img.example.com/a.png">"#;
    let mut doc = RenderDoc::open(html, opts(), Some(net.clone() as Arc<_>)).unwrap();
    assert!(!net.complete(9999, None));
    assert_eq!(net.take_outbox().len(), 2);
    net.fail_all();
    doc.apply_resources();
    assert!(!doc.has_pending_critical());
}
