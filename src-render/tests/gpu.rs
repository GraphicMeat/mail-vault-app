//! The GPU tile path paints what the CPU path paints. Its own test binary: the
//! backend is a process-wide switch (`raster::want_gpu`). On a machine with no
//! usable adapter (CI) the comparison is skipped and says so; the fallback is then
//! what runs, and that it still paints is checked instead.
#![cfg(feature = "gpu")]
use mailvault_render::raster::{probe, want_gpu};
use mailvault_render::{RenderDoc, RenderOptions};

const HTML: &str = r#"<body style="margin:0;background:#fff">
<div style="width:200px;height:80px;background:#1e6fd9"></div>
<div style="width:200px;height:80px;background:rgba(220,40,40,0.5);border:4px solid #222"></div>
<div style="width:300px;height:60px;background:linear-gradient(90deg,#000,#fff)"></div>
<p style="font:16px sans-serif;color:#333">The quick brown fox jumps over the lazy dog.</p>
</body>"#;

fn decode(png_bytes: &[u8]) -> (Vec<u8>, u32, u32, usize) {
    let mut dec = png::Decoder::new(png_bytes).read_info().unwrap();
    let mut buf = vec![0; dec.output_buffer_size()];
    let info = dec.next_frame(&mut buf).unwrap();
    buf.truncate(info.buffer_size());
    (buf, info.width, info.height, info.color_type.samples())
}

fn tile(transparent: bool) -> (Vec<u8>, u32, u32, usize) {
    let opts = RenderOptions { transparent, ..RenderOptions::new(400, 2.0) };
    let mut doc = RenderDoc::open(HTML, opts, None).unwrap();
    decode(&doc.tile_png(0).unwrap())
}

/// (largest channel difference at the solid-colour sample points, share of channels off by more than 24)
fn compare(a: &(Vec<u8>, u32, u32, usize), b: &(Vec<u8>, u32, u32, usize)) -> (u8, f64) {
    assert_eq!((a.1, a.2, a.3), (b.1, b.2, b.3), "same size and channels");
    let ch = a.3;
    // Centres of the three boxes at scale 2: solid blue, half-transparent red, the gradient's middle.
    let points = [(200u32, 80u32), (200, 250), (300, 390)];
    let mut worst = 0u8;
    for (x, y) in points {
        let i = ((y * a.1 + x) as usize) * ch;
        for c in 0..ch {
            worst = worst.max(a.0[i + c].abs_diff(b.0[i + c]));
        }
    }
    let far = a.0.iter().zip(&b.0).filter(|(p, q)| p.abs_diff(**q) > 24).count();
    (worst, far as f64 / a.0.len() as f64)
}

#[test]
fn gpu_tiles_match_cpu_tiles() {
    let p = probe();
    let cpu = [tile(false), tile(true)];
    want_gpu(true);
    let gpu = [tile(false), tile(true)];
    want_gpu(false);
    if !p.ok {
        eprintln!("SKIP gpu comparison: no usable GPU here ({:?} {:?}); the fallback painted", p.reason, p.detail);
        assert_eq!(cpu[0].0, gpu[0].0, "with no GPU the tile must come from the CPU path unchanged");
        return;
    }
    eprintln!("GPU: {:?} on {:?}", p.adapter, p.backend);
    for (label, c, g) in [("opaque", &cpu[0], &gpu[0]), ("transparent", &cpu[1], &gpu[1])] {
        let (worst, far) = compare(c, g);
        assert!(worst <= 3, "{label}: solid colours differ by {worst} (channel order or alpha handling)");
        assert!(far < 0.01, "{label}: {:.2}% of channels differ by more than 24", far * 100.0);
    }
}
