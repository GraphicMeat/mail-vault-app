//! Tile rasterisation, on the CPU (vello_cpu) or, when the worker was started with
//! `--gpu` and the build has the `gpu` feature, on the graphics card (vello on wgpu).
//!
//! CPU: one renderer per tile width, kept on the document thread for the worker's
//! life. With `multithreading` every renderer owns a thread pool, so a renderer per
//! tile (as before) would build and tear down a pool per tile. A document's last,
//! shorter tile is painted at full tile height and cropped, so it reuses the
//! renderer instead of adding one per document. Each kept renderer also keeps its
//! converted images, so their budget is cut from the crate's 64 MiB to IMAGE_BYTES.
//!
//! GPU: one renderer for the worker's life, resized per tile (device creation and
//! shader compilation cost hundreds of ms). It is created lazily by the first tile,
//! so a CPU worker never initialises wgpu. A machine with no usable adapter, a
//! tile larger than a texture may be, or a panic inside wgpu paints on the CPU
//! instead; the first two leave the GPU in use, a panic switches it off for the
//! worker's life and is reported once (`take_gpu_report`).
use anyrender::ImageRenderer;
use anyrender_vello_cpu::{ImageCacheConfig, RenderSettings, VelloCpuImageRenderer};
use blitz_dom::BaseDocument;
use serde::Serialize;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};

/// CPU renderers kept per thread: a worker serves a few widths at once (reader,
/// thread, chat bubbles).
const KEPT: usize = 3;
/// Converted-image budget per kept CPU renderer.
const IMAGE_BYTES: usize = 16 * 1024 * 1024;

/// Raster threads per CPU renderer. Two workers share the machine with the web
/// view, sync and the search index, so each takes a quarter of the cores, at most
/// 3, and a machine with fewer than 8 cores stays single-threaded (0: no pool).
pub fn raster_threads(cores: usize) -> u16 {
    match cores / 4 {
        0 | 1 => 0,
        n => n.min(3) as u16,
    }
}

fn cpu_settings() -> RenderSettings {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    RenderSettings { num_threads: raster_threads(cores), ..RenderSettings::default() }
}

static GPU_WANTED: AtomicBool = AtomicBool::new(false);

/// Called once by the worker entry (`--gpu`), before the first document opens.
pub fn want_gpu(on: bool) {
    GPU_WANTED.store(on, Ordering::Relaxed);
}

/// What `--render-gpu-probe` prints, and what a GPU worker reports when it gives up.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuProbe {
    /// The build has the GPU backend at all.
    pub compiled: bool,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    /// "Metal", "Dx12", "Vulkan".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    /// Why the GPU cannot be used: `no_adapter`, `no_compute`, `init_failed`, `paint_failed`, `not_compiled`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl GpuProbe {
    fn failed(reason: &str, detail: impl Into<Option<String>>) -> Self {
        Self { compiled: cfg!(feature = "gpu"), ok: false, adapter: None, backend: None, driver: None, reason: Some(reason.into()), detail: detail.into() }
    }
}

/// Paint `doc` (already scrolled to the tile's top) into premultiplied RGBA of `w` x `h`.
/// `full_h` (>= `h`) is a full tile's height: the paint happens at that height and the
/// rows below `h` are dropped, so every tile of one width shares a renderer.
pub fn paint(doc: &mut BaseDocument, scale: f64, w: u32, h: u32, full_h: u32) -> Vec<u8> {
    let full_h = full_h.max(h);
    #[cfg(feature = "gpu")]
    if GPU_WANTED.load(Ordering::Relaxed) {
        if let Some(rgba) = gpu::paint(doc, scale, w, full_h) {
            return crop(rgba, w, h);
        }
    }
    crop(paint_cpu(doc, scale, w, full_h), w, h)
}

/// The top `h` rows of a `w`-wide RGBA buffer.
fn crop(mut rgba: Vec<u8>, w: u32, h: u32) -> Vec<u8> {
    rgba.truncate(w as usize * h as usize * 4);
    rgba
}

thread_local! {
    /// Most recently used last.
    static CPU: RefCell<Vec<((u32, u32), VelloCpuImageRenderer)>> = const { RefCell::new(Vec::new()) };
}

fn paint_cpu(doc: &mut BaseDocument, scale: f64, w: u32, h: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; w as usize * h as usize * 4];
    CPU.with_borrow_mut(|kept| {
        let at = kept.iter().position(|(dims, _)| *dims == (w, h));
        let mut entry = match at {
            Some(i) => kept.remove(i),
            None => {
                let images = ImageCacheConfig { max_bytes: IMAGE_BYTES, ..ImageCacheConfig::default() };
                ((w, h), VelloCpuImageRenderer::with_render_settings(w, h, images, cpu_settings()))
            }
        };
        entry.1.reset();
        entry.1.render(|scene| blitz_paint::paint_scene(scene, doc, scale, w, h, 0, 0), &mut rgba);
        kept.push(entry);
        if kept.len() > KEPT {
            kept.remove(0);
        }
    });
    rgba
}

/// A GPU failure the daemon has not been told about yet. The worker loop drains it
/// after each batch and writes it as a `{"kind":"gpu"}` line.
pub fn take_gpu_report() -> Option<GpuProbe> {
    #[cfg(feature = "gpu")]
    return gpu::take_report();
    #[cfg(not(feature = "gpu"))]
    None
}

/// Ask for an adapter, build the renderer and paint one small frame: what Settings
/// shows before the user turns the GPU on. Run in a process of its own
/// (`mailvault-daemon --render-gpu-probe`), so a driver that crashes costs nothing.
pub fn probe() -> GpuProbe {
    #[cfg(feature = "gpu")]
    return gpu::probe();
    #[cfg(not(feature = "gpu"))]
    GpuProbe::failed("not_compiled", None)
}

/// vello writes straight alpha; the PNG encoder (`doc.rs`) takes vello_cpu's premultiplied.
#[cfg_attr(not(feature = "gpu"), allow(dead_code))]
fn premultiply(rgba: &mut [u8]) {
    for px in rgba.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a == 255 {
            continue;
        }
        for c in &mut px[..3] {
            *c = ((*c as u32 * a + 127) / 255) as u8;
        }
    }
}

#[cfg(feature = "gpu")]
mod gpu {
    use super::{premultiply, GpuProbe};
    use anyrender::ImageRenderer;
    use anyrender_vello::wgpu;
    use anyrender_vello::VelloImageRenderer;
    use blitz_dom::BaseDocument;
    use std::cell::RefCell;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::Mutex;

    /// wgpu's default `max_texture_dimension_2d`, which the renderer's device requests.
    /// A wider or taller tile paints on the CPU.
    pub const MAX_DIM: u32 = 8192;

    enum State {
        Untried,
        Ready(VelloImageRenderer, (u32, u32)),
        Off,
    }

    thread_local! {
        static GPU: RefCell<State> = const { RefCell::new(State::Untried) };
    }
    static REPORT: Mutex<Option<GpuProbe>> = Mutex::new(None);

    pub fn take_report() -> Option<GpuProbe> {
        REPORT.lock().ok()?.take()
    }

    fn report(p: GpuProbe) {
        if let Ok(mut r) = REPORT.lock() {
            *r = Some(p);
        }
    }

    fn panic_text(e: &(dyn std::any::Any + Send)) -> String {
        e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_default()
    }

    /// The adapter vello would get: the backends `WGPU_BACKEND` names (the daemon sets
    /// it to the platform's native API), else Metal, DX12 or Vulkan, never OpenGL.
    fn adapter() -> Result<wgpu::Adapter, GpuProbe> {
        let desc = wgpu::InstanceDescriptor {
            backends: wgpu::Backends::from_env().unwrap_or(wgpu::Backends::PRIMARY),
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        };
        let instance = wgpu::Instance::new(desc);
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .map_err(|e| GpuProbe::failed("no_adapter", Some(e.to_string())))?;
        if !adapter.get_downlevel_capabilities().flags.contains(wgpu::DownlevelFlags::COMPUTE_SHADERS) {
            return Err(GpuProbe::failed("no_compute", Some(adapter.get_info().name)));
        }
        Ok(adapter)
    }

    fn described(adapter: &wgpu::Adapter) -> GpuProbe {
        let info = adapter.get_info();
        GpuProbe {
            compiled: true,
            ok: true,
            adapter: Some(info.name),
            backend: Some(format!("{:?}", info.backend)),
            driver: Some([info.driver, info.driver_info].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")).filter(|s| !s.is_empty()),
            reason: None,
            detail: None,
        }
    }

    fn create(w: u32, h: u32) -> Result<VelloImageRenderer, GpuProbe> {
        catch_unwind(|| VelloImageRenderer::new(w, h)).map_err(|e| GpuProbe::failed("init_failed", Some(panic_text(&*e))))
    }

    pub fn probe() -> GpuProbe {
        let adapter = match adapter() {
            Ok(a) => a,
            Err(p) => return p,
        };
        let mut r = match create(64, 64) {
            Ok(r) => r,
            Err(p) => return p,
        };
        let mut buf = vec![0u8; 64 * 64 * 4];
        match catch_unwind(AssertUnwindSafe(|| r.render(|_| {}, &mut buf))) {
            Ok(()) => described(&adapter),
            Err(e) => GpuProbe::failed("paint_failed", Some(panic_text(&*e))),
        }
    }

    /// None: paint this tile on the CPU.
    pub fn paint(doc: &mut BaseDocument, scale: f64, w: u32, h: u32) -> Option<Vec<u8>> {
        if w > MAX_DIM || h > MAX_DIM {
            return None;
        }
        GPU.with_borrow_mut(|state| {
            if matches!(state, State::Untried) {
                *state = match adapter().and_then(|_| create(w, h)) {
                    Ok(r) => State::Ready(r, (w, h)),
                    Err(p) => {
                        report(p);
                        State::Off
                    }
                };
            }
            let State::Ready(r, dims) = state else { return None };
            if *dims != (w, h) {
                r.resize(w, h);
                *dims = (w, h);
            }
            r.reset();
            let mut rgba = vec![0u8; w as usize * h as usize * 4];
            match catch_unwind(AssertUnwindSafe(|| r.render(|scene| blitz_paint::paint_scene(scene, doc, scale, w, h, 0, 0), &mut rgba))) {
                Ok(()) => {
                    premultiply(&mut rgba);
                    Some(rgba)
                }
                Err(e) => {
                    report(GpuProbe::failed("paint_failed", Some(panic_text(&*e))));
                    *state = State::Off;
                    None
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{crop, premultiply, raster_threads};

    #[test]
    fn crop_keeps_the_top_rows() {
        let rgba: Vec<u8> = (0..2 * 3 * 4).map(|i| i as u8).collect();
        assert_eq!(crop(rgba.clone(), 2, 1), rgba[..8].to_vec());
        assert_eq!(crop(rgba.clone(), 2, 3), rgba);
    }

    #[test]
    fn small_machines_stay_single_threaded_and_big_ones_are_capped() {
        assert_eq!(raster_threads(1), 0);
        assert_eq!(raster_threads(4), 0);
        assert_eq!(raster_threads(7), 0);
        assert_eq!(raster_threads(8), 2);
        assert_eq!(raster_threads(12), 3);
        assert_eq!(raster_threads(32), 3);
    }

    #[test]
    fn straight_alpha_becomes_premultiplied_and_opaque_pixels_stay() {
        let mut px = [200, 100, 50, 255, 200, 100, 50, 128, 255, 255, 255, 0];
        premultiply(&mut px);
        assert_eq!(px, [200, 100, 50, 255, 100, 50, 25, 128, 0, 0, 0, 0]);
    }
}
