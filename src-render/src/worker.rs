//! The render worker's loop. One thread owns every document; a reader thread
//! turns stdin lines into messages. Before relayout, everything already
//! queued is drained, so a burst of image completions costs one layout.
use crate::fonts::{FaceData, FontLibrary};
use crate::net::BridgeNet;
use crate::{RenderDoc, RenderOptions, MAX_CSS_WIDTH, MAX_SCALE, MIN_SCALE};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::Cell;
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
    Fold { req: u64, doc: u64, id: String, open: bool },
    TextRuns { req: u64, doc: u64, index: u32 },
    Serialize { req: u64, doc: u64, start: crate::serialize::Endpoint, end: crate::serialize::Endpoint },
    Close { doc: u64 },
    Fetched { doc: u64, fetch: u64, bytes: Option<String> },
    /// Google Font families the daemon fetched. No reply: every open doc that
    /// names a new family is rebuilt in place (see `rebuild_for_fonts`).
    Fonts { families: Vec<FamilyIn> },
}

#[derive(Deserialize)]
struct FaceIn {
    data: String,
    weight: u16,
    #[serde(default)]
    style: Option<String>,
}

#[derive(Deserialize)]
struct FamilyIn {
    family: String,
    faces: Vec<FaceIn>,
}

/// What the stdin reader hands the document thread.
enum Msg {
    Op(In),
    /// A line that is JSON for an open, tile, hit, fold, textRuns or serialize with a `req`, but not a valid
    /// one. Only this thread writes to stdout, so the reader asks it to answer.
    Bad { req: u64 },
}

fn bad_request(line: &str) -> Option<u64> {
    let v: Value = serde_json::from_str(line).ok()?;
    matches!(v["op"].as_str()?, "open" | "tile" | "hit" | "textRuns" | "serialize" | "fold").then_some(())?;
    v["req"].as_u64()
}

struct Open {
    doc: RenderDoc,
    net: Arc<BridgeNet>,
    rev: u32,
    /// What a rebuild (fonts op) needs to open the same document again.
    html: String,
    opts: RenderOptions,
    allow_remote: bool,
}

/// Stack of the thread that owns the documents. Blitz layout, text collection,
/// hit testing and paint recurse once per nesting level, and the process main
/// thread has 8 MiB (macOS, Linux) or 1 MiB (Windows). MAX_DEPTH bounds the
/// recursion; this gives it generous headroom on every OS. The memory is
/// reserved address space, committed only as deep recursion touches it.
const WORKER_STACK_BYTES: usize = 256 * 1024 * 1024;

pub fn run(input: impl BufRead + Send + 'static, output: impl Write + Send, pre_open: fn(&str)) -> std::io::Result<()> {
    run_with_fonts(input, output, pre_open, FontLibrary::new(true))
}

/// `run` with the caller's font library (tests pass one without system fonts,
/// so geometry depends only on the repo's fonts).
pub fn run_with_fonts(input: impl BufRead + Send + 'static, output: impl Write + Send, pre_open: fn(&str), fonts: FontLibrary) -> std::io::Result<()> {
    std::thread::scope(|scope| {
        let owner = std::thread::Builder::new()
            .name("render-docs".into())
            .stack_size(WORKER_STACK_BYTES)
            .spawn_scoped(scope, move || run_loop(input, output, pre_open, fonts))?;
        // A panic outside the per-document guards is still fatal to the worker,
        // exactly as before: re-raise it on the calling thread.
        owner.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

fn run_loop(input: impl BufRead + Send + 'static, mut output: impl Write, pre_open: fn(&str), mut fonts: FontLibrary) -> std::io::Result<()> {
    let (tx, rx) = mpsc::channel::<Msg>();
    std::thread::spawn(move || {
        for line in input.lines().map_while(Result::ok) {
            let msg = match serde_json::from_str::<In>(&line) {
                Ok(op) => Msg::Op(op),
                Err(_) => match bad_request(&line) {
                    Some(req) => Msg::Bad { req },
                    None => continue, // not for us, and nobody is waiting on it
                },
            };
            if tx.send(msg).is_err() {
                break;
            }
        }
    });
    let mut docs: HashMap<u64, Open> = HashMap::new();
    // Set when a per-document guard caught a panic. The process is then suspect
    // (a half-run mutator drop, a poisoned shared lock in stylo or fontique), so
    // it serves what is still open and exits when the last document is gone: the
    // host sees EOF and spawns a clean worker for the next call.
    let tainted = Cell::new(false);
    while let Ok(first) = rx.recv() {
        let mut dirty = BTreeSet::new();
        let mut batch = vec![first];
        batch.extend(rx.try_iter());
        for msg in batch {
            match msg {
                Msg::Op(op) => handle(op, &mut docs, &mut dirty, &mut output, pre_open, &tainted, &mut fonts)?,
                Msg::Bad { req } => line(&mut output, json!({"kind":"error","req":req,"code":"render_bad_request"}))?,
            }
            // Fetches go out right after the message that caused them, so the
            // order on the wire is deterministic however stdin was batched.
            flush_fetches(&docs, &mut output)?;
            if tainted.get() && docs.is_empty() {
                output.flush()?;
                return Ok(());
            }
        }
        for id in dirty {
            let Some(o) = docs.get_mut(&id) else { continue };
            match guarded(&tainted, || {
                o.doc.apply_resources();
                o.doc.meta()
            }) {
                Some(meta) => {
                    o.rev += 1;
                    line(&mut output, json!({"kind":"updated","doc":id,"rev":o.rev,"meta":meta}))?;
                }
                None => discard(&mut docs, id, &tainted), // no req to answer: the next tile says render_unknown_doc
            }
        }
        if tainted.get() && docs.is_empty() {
            output.flush()?;
            return Ok(());
        }
        // A relayout can discover new resources (CSS background images).
        flush_fetches(&docs, &mut output)?;
        output.flush()?;
    }
    Ok(())
}

fn handle(msg: In, docs: &mut HashMap<u64, Open>, dirty: &mut BTreeSet<u64>, out: &mut impl Write, pre_open: fn(&str), tainted: &Cell<bool>, fonts: &mut FontLibrary) -> std::io::Result<()> {
    match msg {
        In::Open { req, doc, html, css_width, scale, allow_remote, theme: _ } => {
            let net = BridgeNet::new(allow_remote);
            let opts = RenderOptions::new(css_width.clamp(1, MAX_CSS_WIDTH as u32), scale.clamp(MIN_SCALE, MAX_SCALE));
            let net_for_doc = net.clone();
            let stored = opts.clone();
            let font_ctx = fonts.context();
            let built = guarded(tainted, || {
                pre_open(&html);
                RenderDoc::open_with(&html, opts, Some(net_for_doc), font_ctx).map(|mut d| {
                    d.apply_resources(); // data: images answered during parse
                    let meta = d.meta();
                    (d, meta)
                })
            });
            match built {
                Some(Ok((d, meta))) => {
                    docs.insert(doc, Open { doc: d, net, rev: 1, html, opts: stored, allow_remote });
                    line(out, json!({"kind":"reply","req":req,"ok":{"rev":1,"meta":meta}}))
                }
                Some(Err(e)) => line(out, json!({"kind":"error","req":req,"code":e.code()})),
                None => unavailable(out, req),
            }
        }
        In::Tile { req, doc, index } => match docs.get_mut(&doc) {
            Some(o) => match guarded(tainted, || o.doc.tile_png(index)) {
                Some(Ok(png)) => {
                    let png = base64::engine::general_purpose::STANDARD.encode(png);
                    line(out, json!({"kind":"reply","req":req,"ok":{"png":png}}))
                }
                Some(Err(e)) => line(out, json!({"kind":"error","req":req,"code":e.code()})),
                None => {
                    discard(docs, doc, tainted);
                    unavailable(out, req)
                }
            },
            None => unknown(out, req),
        },
        In::Hit { req, doc, x, y } => match docs.get(&doc) {
            Some(o) => match guarded(tainted, || o.doc.hit(x, y)) {
                Some((link, fold)) => line(out, json!({"kind":"reply","req":req,"ok":{"link":link,"fold":fold}})),
                None => {
                    discard(docs, doc, tainted);
                    unavailable(out, req)
                }
            },
            None => unknown(out, req),
        },
        In::Fold { req, doc, id, open } => match docs.get_mut(&doc) {
            Some(o) => match guarded(tainted, || {
                let changed = o.doc.set_fold(&id, open);
                (changed, o.doc.meta())
            }) {
                Some((changed, meta)) => {
                    if changed {
                        o.rev += 1;
                    }
                    line(out, json!({"kind":"reply","req":req,"ok":{"rev":o.rev,"meta":meta}}))?;
                    // The same `updated` frame a resource arrival sends: the
                    // frontend applies new layouts from the render-updated event
                    // only, never from this reply.
                    if changed {
                        line(out, json!({"kind":"updated","doc":doc,"rev":o.rev,"meta":meta}))?;
                    }
                    Ok(())
                }
                // A half-mutated document must not keep serving tiles.
                None => {
                    discard(docs, doc, tainted);
                    unavailable(out, req)
                }
            },
            None => unknown(out, req),
        },
        In::TextRuns { req, doc, index } => match docs.get(&doc) {
            Some(o) => match guarded(tainted, || (o.doc.text_runs(index), o.doc.text_owners(index))) {
                Some((runs, owners)) => line(out, json!({"kind":"reply","req":req,"ok":{"runs":runs,"owners":owners}})),
                None => {
                    discard(docs, doc, tainted);
                    unavailable(out, req)
                }
            },
            None => unknown(out, req),
        },
        In::Serialize { req, doc, start, end } => match docs.get_mut(&doc) {
            Some(o) => match guarded(tainted, || o.doc.serialize(start, end)) {
                Some(copy) => line(out, json!({"kind":"reply","req":req,"ok":copy})),
                None => {
                    discard(docs, doc, tainted);
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
        In::Fonts { families } => {
            let mut fresh: Vec<String> = Vec::new();
            for f in families {
                // Decode and registration of one family. A panic here (hostile
                // woff2 bytes, a fontique bug) skips that family and keeps the
                // worker: it touches only the master library, no document, so
                // it does not taint (a taint with no document open would end
                // the worker, and the host would replay the same family into
                // the next one). The host reads the ack: a family it never saw
                // acknowledged is the one that killed a worker.
                let name = f.family.clone();
                let registered = catch_unwind(AssertUnwindSafe(|| {
                    let faces = f
                        .faces
                        .into_iter()
                        .filter_map(|face| {
                            let data = base64::engine::general_purpose::STANDARD.decode(face.data).ok()?;
                            Some(FaceData { data, weight: face.weight, style: face.style.unwrap_or_else(|| "normal".into()) })
                        })
                        .collect();
                    fonts.register(&f.family, faces)
                }));
                match registered {
                    Ok(new) => {
                        if new {
                            fresh.push(name.to_lowercase());
                        }
                        line(out, json!({"kind":"font","family":name,"ok":true}))?;
                    }
                    Err(_) => {
                        fonts.forget(&name);
                        line(out, json!({"kind":"font","family":name,"ok":false}))?;
                    }
                }
            }
            rebuild_for_fonts(&fresh, docs, out, tainted, fonts)
        }
        In::Fetched { doc, fetch, bytes } => {
            if let Some(o) = docs.get(&doc) {
                let bytes = bytes.and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
                match guarded(tainted, || o.net.complete(fetch, bytes)) {
                    Some(true) => {
                        dirty.insert(doc);
                    }
                    Some(false) => {}
                    None => discard(docs, doc, tainted),
                }
            }
            Ok(())
        }
    }
}

/// Open again, in place, every document whose html names one of the `fresh`
/// (lowercased) families: same `doc` id, `rev + 1`, an `updated` frame. blitz
/// keeps a document's font context private, so this is the only way a family
/// that arrives late reaches a document already open. Images come from the old
/// net's cache, so nothing is fetched twice. A document that fails to reopen
/// keeps its previous render.
fn rebuild_for_fonts(fresh: &[String], docs: &mut HashMap<u64, Open>, out: &mut impl Write, tainted: &Cell<bool>, fonts: &FontLibrary) -> std::io::Result<()> {
    let mut ids: Vec<u64> = docs.iter().filter(|(_, o)| names_any_family(&o.html, fresh)).map(|(id, _)| *id).collect();
    ids.sort_unstable();
    for id in ids {
        let Some(o) = docs.get(&id) else { continue };
        let net = BridgeNet::with_cache(o.allow_remote, o.net.cache());
        // A fetch still in flight for the old net must not be mistaken for one
        // of the new net's: its late answer finds no pending id and is dropped.
        net.continue_ids_after(&o.net);
        let net_for_doc = net.clone();
        let rebuilt = guarded(tainted, || {
            RenderDoc::open_with(&o.html, o.opts.clone(), Some(net_for_doc), fonts.context()).map(|mut d| {
                d.apply_resources();
                crate::fold::carry_folds(&o.doc, &mut d);
                d
            })
        });
        match rebuilt {
            Some(Ok(d)) => {
                let Some(o) = docs.get_mut(&id) else { continue };
                o.net.fail_all();
                o.doc = d;
                o.net = net;
                o.rev += 1;
                line(out, json!({"kind":"updated","doc":id,"rev":o.rev,"meta":o.doc.meta()}))?;
            }
            Some(Err(_)) => {} // it opened once, so this is not expected; keep the old render
            None => discard(docs, id, tainted),
        }
    }
    Ok(())
}

fn names_any_family(html: &str, fresh: &[String]) -> bool {
    if fresh.is_empty() {
        return false;
    }
    let lower = html.to_lowercase();
    fresh.iter().any(|f| names_family(&lower, f))
}

/// `html` (lowercased) names `family` (lowercased) as a whole name between
/// CSS or attribute delimiters: "lora" matches `font-family: Lora, serif`
/// but not "explorations". A false positive (the name in prose) only costs
/// one harmless rebuild.
fn names_family(html: &str, family: &str) -> bool {
    let delim = |c: Option<char>| c.map_or(true, |c| matches!(c, ':' | ',' | ';' | '\'' | '"' | '{' | '}' | '(' | ')' | '=') || c.is_whitespace());
    html.match_indices(family).any(|(i, _)| delim(html[..i].chars().next_back()) && delim(html[i + family.len()..].chars().next()))
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
/// keeps working until the worker retires (see `tainted` in `run_loop`). This
/// relies on unwinding: a `panic = "abort"` profile would turn it into a worker
/// exit, which the daemon host survives as before.
fn guarded<T>(tainted: &Cell<bool>, f: impl FnOnce() -> T) -> Option<T> {
    let r = catch_unwind(AssertUnwindSafe(f)).ok();
    if r.is_none() {
        tainted.set(true);
    }
    r
}

/// Drop a document whose operation panicked. Its state is suspect, so even
/// the drop is guarded; a doc that cannot be dropped cleanly is leaked.
fn discard(docs: &mut HashMap<u64, Open>, id: u64, tainted: &Cell<bool>) {
    if let Some(o) = docs.remove(&id) {
        if catch_unwind(AssertUnwindSafe(move || drop(o))).is_err() {
            tainted.set(true);
        }
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
