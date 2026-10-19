//! Where the render worker's memory goes. Prints one `[renderworker-mem]` JSON line per stage:
//! RSS and physical footprint (MB) of this process after fonts, after opening N documents, after
//! painting their tiles, and after dropping everything (what the allocator keeps).
//!   cargo run --release -p mailvault-render --example mem_profile
use mailvault_render::fonts::FontLibrary;
use mailvault_render::{RenderDoc, RenderOptions};
use std::process::Command;

fn mb() -> (u64, u64) {
    let pid = std::process::id().to_string();
    let rss = Command::new("ps").args(["-o", "rss=", "-p", &pid]).output().ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok()).unwrap_or(0) / 1024;
    // What Activity Monitor calls Memory: vmmap's "Physical footprint", which leaves out pages the allocator
    // has marked reusable but the kernel has not yet taken back (those still count in RSS).
    let fp = Command::new("vmmap").args(["-summary", &pid]).output().ok()
        .and_then(|o| {
            let t = String::from_utf8_lossy(&o.stdout).to_string();
            let line = t.lines().find(|l| l.starts_with("Physical footprint:") && !l.contains("peak"))?.to_string();
            let v = line.split_whitespace().nth(2)?.to_string();
            let (n, unit) = v.split_at(v.len() - 1);
            let n: f64 = n.parse().ok()?;
            Some((match unit { "K" => n / 1024.0, "G" => n * 1024.0, _ => n }) as u64)
        }).unwrap_or(0);
    (rss, fp)
}
fn stage(name: &str, extra: serde_json::Value) {
    let (rss, fp) = mb();
    println!("[renderworker-mem] {}", serde_json::json!({ "stage": name, "rssMB": rss, "footprintMB": fp, "extra": extra }));
}

#[cfg(target_os = "macos")]
extern "C" {
    fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
}
/// Ask the allocator to give freed pages back to the OS; returns bytes released (0 off macOS).
fn relief() -> usize {
    #[cfg(target_os = "macos")]
    unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) }
    #[cfg(not(target_os = "macos"))]
    0
}

fn main() {
    let root = format!("{}/../tests/fixtures/blitz-corpus", env!("CARGO_MANIFEST_DIR"));
    let manifest: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}/manifest.json")).unwrap()).unwrap();
    let htmls: Vec<String> = manifest["fixtures"].as_array().unwrap().iter()
        .map(|f| std::fs::read_to_string(format!("{root}/{}", f["file"].as_str().unwrap())).unwrap()).collect();
    let opts = || RenderOptions { css_width: 680, scale: 2.0, ..Default::default() };

    stage("start", serde_json::json!({ "fixtures": htmls.len() }));
    let lib = FontLibrary::new(true);
    stage("fonts-system", serde_json::json!({}));

    let first = RenderDoc::open_with(&htmls[0], opts(), None, lib.context()).expect("open");
    stage("one-doc-open", serde_json::json!({ "tiles": first.meta().tile_count }));
    let mut first = first;
    for i in 0..first.meta().tile_count { let _ = first.tile_png(i); }
    stage("one-doc-all-tiles", serde_json::json!({}));
    drop(first);
    stage("one-doc-dropped", serde_json::json!({}));

    // 28 fixtures twice = 56 docs open at once, like two workers' worth of a long chat.
    let mut docs: Vec<RenderDoc> = Vec::new();
    for round in 0..2 {
        for h in &htmls {
            if let Ok(d) = RenderDoc::open_with(h, opts(), None, lib.context()) { docs.push(d); }
        }
        stage(&format!("docs-open-{}", docs.len()), serde_json::json!({ "round": round }));
    }
    let mut tiles = 0u32;
    for d in docs.iter_mut() {
        let n = d.meta().tile_count.min(2);
        for i in 0..n { if d.tile_png(i).is_ok() { tiles += 1; } }
    }
    stage("docs-first-two-tiles", serde_json::json!({ "tiles": tiles }));
    drop(docs);
    stage("docs-dropped", serde_json::json!({}));

    stage("before-relief", serde_json::json!({}));
    let freed = relief();
    stage("after-relief", serde_json::json!({ "freedMB": freed / (1 << 20) }));

    // The tall mail the e2e opens (about 20 000 CSS px): every tile painted, as the reader's tiles request them.
    let tall: String = (0..1000).map(|i| format!("<p>Tall line {i}</p>")).collect();
    let mut t = RenderDoc::open_with(&tall, opts(), None, lib.context()).expect("tall");
    stage("tall-open", serde_json::json!({ "tiles": t.meta().tile_count }));
    for i in 0..t.meta().tile_count { let _ = t.tile_png(i); }
    stage("tall-all-tiles", serde_json::json!({}));
    drop(t);
    stage("tall-dropped", serde_json::json!({}));
    let freed = relief();
    stage("tall-after-relief", serde_json::json!({ "freedMB": freed / (1 << 20) }));

    // Churn: open, paint one tile, drop, 5 rounds of the corpus. A flat line here means the allocator reuses what it has.
    for round in 0..5 {
        for h in &htmls {
            if let Ok(mut d) = RenderDoc::open_with(h, opts(), None, lib.context()) { let _ = d.tile_png(0); }
        }
        stage(&format!("churn-{round}"), serde_json::json!({}));
    }
}
