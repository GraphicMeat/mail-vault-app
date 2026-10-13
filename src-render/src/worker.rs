//! The render worker's loop. One thread owns every document; a reader thread
//! turns stdin lines into messages. Before relayout, everything already
//! queued is drained, so a burst of image completions costs one layout.
use crate::net::BridgeNet;
use crate::{RenderDoc, RenderOptions};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, Write};
use std::sync::{mpsc, Arc};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum In {
    // `theme` is accepted now and applied by plan B (dark mode); light is the only path in A.
    Open {
        req: u64,
        doc: u64,
        html: String,
        #[serde(rename = "cssWidth")]
        css_width: u32,
        scale: f32,
        #[serde(rename = "allowRemote")]
        allow_remote: bool,
        #[serde(default)]
        #[allow(dead_code)] // read by plan B
        theme: Option<serde_json::Value>,
    },
    Tile { req: u64, doc: u64, index: u32 },
    Hit { req: u64, doc: u64, x: f32, y: f32 },
    Close { doc: u64 },
    Fetched { doc: u64, fetch: u64, bytes: Option<String> },
}

struct Open {
    doc: RenderDoc,
    net: Arc<BridgeNet>,
    rev: u32,
}

pub fn run(input: impl BufRead + Send + 'static, mut output: impl Write, pre_open: fn(&str)) -> std::io::Result<()> {
    let (tx, rx) = mpsc::channel::<In>();
    std::thread::spawn(move || {
        for line in input.lines().map_while(Result::ok) {
            if let Ok(msg) = serde_json::from_str::<In>(&line) {
                if tx.send(msg).is_err() {
                    break;
                }
            }
        }
    });
    let mut docs: HashMap<u64, Open> = HashMap::new();
    while let Ok(first) = rx.recv() {
        let mut dirty = BTreeSet::new();
        let mut batch = vec![first];
        batch.extend(rx.try_iter());
        for msg in batch {
            handle(msg, &mut docs, &mut dirty, &mut output, pre_open)?;
            // Fetches go out right after the message that caused them, so the
            // order on the wire is deterministic however stdin was batched.
            flush_fetches(&docs, &mut output)?;
        }
        for id in dirty {
            if let Some(o) = docs.get_mut(&id) {
                o.doc.apply_resources();
                o.rev += 1;
                line(&mut output, json!({"kind":"updated","doc":id,"rev":o.rev,"meta":o.doc.meta()}))?;
            }
        }
        // A relayout can discover new resources (CSS background images).
        flush_fetches(&docs, &mut output)?;
        output.flush()?;
    }
    Ok(())
}

fn handle(msg: In, docs: &mut HashMap<u64, Open>, dirty: &mut BTreeSet<u64>, out: &mut impl Write, pre_open: fn(&str)) -> std::io::Result<()> {
    match msg {
        In::Open { req, doc, html, css_width, scale, allow_remote, theme: _ } => {
            pre_open(&html);
            let net = BridgeNet::new(allow_remote);
            let opts = RenderOptions::new(css_width.clamp(1, 4000), scale.clamp(0.5, 4.0));
            match RenderDoc::open(&html, opts, Some(net.clone() as Arc<_>)) {
                Ok(mut d) => {
                    d.apply_resources(); // data: images answered during parse
                    let meta = d.meta();
                    docs.insert(doc, Open { doc: d, net, rev: 1 });
                    line(out, json!({"kind":"reply","req":req,"ok":{"rev":1,"meta":meta}}))
                }
                Err(e) => line(out, json!({"kind":"error","req":req,"code":e.code()})),
            }
        }
        In::Tile { req, doc, index } => match docs.get_mut(&doc) {
            Some(o) => {
                let png = base64::engine::general_purpose::STANDARD.encode(o.doc.tile_png(index));
                line(out, json!({"kind":"reply","req":req,"ok":{"png":png}}))
            }
            None => unknown(out, req),
        },
        In::Hit { req, doc, x, y } => match docs.get(&doc) {
            Some(o) => line(out, json!({"kind":"reply","req":req,"ok":{"link":o.doc.hit_link(x, y)}})),
            None => unknown(out, req),
        },
        In::Close { doc } => {
            if let Some(o) = docs.remove(&doc) {
                o.net.fail_all();
            }
            Ok(())
        }
        In::Fetched { doc, fetch, bytes } => {
            if let Some(o) = docs.get(&doc) {
                let bytes = bytes.and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
                if o.net.complete(fetch, bytes) {
                    dirty.insert(doc);
                }
            }
            Ok(())
        }
    }
}

fn flush_fetches(docs: &HashMap<u64, Open>, out: &mut impl Write) -> std::io::Result<()> {
    for (id, o) in docs {
        for f in o.net.take_outbox() {
            line(out, json!({"kind":"fetch","doc":id,"fetch":f.id,"url":f.url}))?;
        }
    }
    Ok(())
}

fn unknown(out: &mut impl Write, req: u64) -> std::io::Result<()> {
    line(out, json!({"kind":"error","req":req,"code":"render_unknown_doc"}))
}

fn line(out: &mut impl Write, v: Value) -> std::io::Result<()> {
    writeln!(out, "{v}")
}
