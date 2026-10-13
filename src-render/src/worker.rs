//! The render worker's loop. One thread owns every document; a reader thread
//! turns stdin lines into messages. Before relayout, everything already
//! queued is drained, so a burst of image completions costs one layout.
use crate::net::BridgeNet;
use crate::{RenderDoc, RenderOptions, MAX_CSS_WIDTH, MAX_SCALE, MIN_SCALE};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
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

/// Stack of the thread that owns the documents. Blitz layout, text collection,
/// hit testing and paint recurse once per nesting level, and the process main
/// thread has 8 MiB (macOS, Linux) or 1 MiB (Windows). MAX_DEPTH bounds the
/// recursion; this gives it generous headroom on every OS. The memory is
/// reserved address space, committed only as deep recursion touches it.
const WORKER_STACK_BYTES: usize = 256 * 1024 * 1024;

pub fn run(input: impl BufRead + Send + 'static, output: impl Write + Send, pre_open: fn(&str)) -> std::io::Result<()> {
    std::thread::scope(|scope| {
        let owner = std::thread::Builder::new()
            .name("render-docs".into())
            .stack_size(WORKER_STACK_BYTES)
            .spawn_scoped(scope, move || run_loop(input, output, pre_open))?;
        // A panic outside the per-document guards is still fatal to the worker,
        // exactly as before: re-raise it on the calling thread.
        owner.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

fn run_loop(input: impl BufRead + Send + 'static, mut output: impl Write, pre_open: fn(&str)) -> std::io::Result<()> {
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
            let Some(o) = docs.get_mut(&id) else { continue };
            match guarded(|| {
                o.doc.apply_resources();
                o.doc.meta()
            }) {
                Some(meta) => {
                    o.rev += 1;
                    line(&mut output, json!({"kind":"updated","doc":id,"rev":o.rev,"meta":meta}))?;
                }
                None => discard(&mut docs, id), // no req to answer: the next tile says render_unknown_doc
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
            let net = BridgeNet::new(allow_remote);
            let opts = RenderOptions::new(css_width.clamp(1, MAX_CSS_WIDTH as u32), scale.clamp(MIN_SCALE, MAX_SCALE));
            let net_for_doc = net.clone();
            let built = guarded(|| {
                pre_open(&html);
                RenderDoc::open(&html, opts, Some(net_for_doc)).map(|mut d| {
                    d.apply_resources(); // data: images answered during parse
                    let meta = d.meta();
                    (d, meta)
                })
            });
            match built {
                Some(Ok((d, meta))) => {
                    docs.insert(doc, Open { doc: d, net, rev: 1 });
                    line(out, json!({"kind":"reply","req":req,"ok":{"rev":1,"meta":meta}}))
                }
                Some(Err(e)) => line(out, json!({"kind":"error","req":req,"code":e.code()})),
                None => unavailable(out, req),
            }
        }
        In::Tile { req, doc, index } => match docs.get_mut(&doc) {
            Some(o) => match guarded(|| o.doc.tile_png(index)) {
                Some(Ok(png)) => {
                    let png = base64::engine::general_purpose::STANDARD.encode(png);
                    line(out, json!({"kind":"reply","req":req,"ok":{"png":png}}))
                }
                Some(Err(e)) => line(out, json!({"kind":"error","req":req,"code":e.code()})),
                None => {
                    discard(docs, doc);
                    unavailable(out, req)
                }
            },
            None => unknown(out, req),
        },
        In::Hit { req, doc, x, y } => match docs.get(&doc) {
            Some(o) => match guarded(|| o.doc.hit_link(x, y)) {
                Some(link) => line(out, json!({"kind":"reply","req":req,"ok":{"link":link}})),
                None => {
                    discard(docs, doc);
                    unavailable(out, req)
                }
            },
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
                match guarded(|| o.net.complete(fetch, bytes)) {
                    Some(true) => {
                        dirty.insert(doc);
                    }
                    Some(false) => {}
                    None => discard(docs, doc),
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

/// Run one operation on one document. A panic (a blitz bug on hostile markup)
/// costs that document and is reported to its caller; every other document
/// keeps working. This relies on unwinding: a `panic = "abort"` profile would
/// turn it into a worker exit, which the daemon host survives as before.
fn guarded<T>(f: impl FnOnce() -> T) -> Option<T> {
    catch_unwind(AssertUnwindSafe(f)).ok()
}

/// Drop a document whose operation panicked. Its state is suspect, so even
/// the drop is guarded; a doc that cannot be dropped cleanly is leaked.
fn discard(docs: &mut HashMap<u64, Open>, id: u64) {
    if let Some(o) = docs.remove(&id) {
        let _ = catch_unwind(AssertUnwindSafe(move || drop(o)));
    }
}

fn unavailable(out: &mut impl Write, req: u64) -> std::io::Result<()> {
    line(out, json!({"kind":"error","req":req,"code":"render_unavailable"}))
}

fn unknown(out: &mut impl Write, req: u64) -> std::io::Result<()> {
    line(out, json!({"kind":"error","req":req,"code":"render_unknown_doc"}))
}

fn line(out: &mut impl Write, v: Value) -> std::io::Result<()> {
    writeln!(out, "{v}")
}
