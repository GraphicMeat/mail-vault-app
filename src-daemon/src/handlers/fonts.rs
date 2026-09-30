//! `fonts.*`: Google Fonts on demand, for the app's UI font and signatures.
//!
//! - `fonts.download {family}` answers at once (`ready`, `downloading`, or
//!   `failed` with an `errorCode` if it could not start) and runs it on a
//!   `font-download` thread of its own at background QoS, one per family;
//!   progress and the outcome arrive as `font-download` events.
//! - `fonts.list` answers the families installed whole plus the ones
//!   downloading, so a window opened mid-download shows it.
//! - `fonts.read {family}` answers each face's bytes (base64) with its
//!   weight and unicode-range, for the webview's `FontFace`: no URL is ever
//!   handed to the page, so the CSP needs no font host.
//! - `fonts.remove {family}` deletes an installed family.
//!
//! Only catalogue families, only `fonts.gstatic.com` files, never a redirect
//! (`mailvault_core::google_fonts`). Files live under `<app_dir>/fonts/`,
//! never on the vault drive.

use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use base64::Engine;
use mailvault_core::google_fonts::{self as gf, CatalogueEntry, Fetch, FetchError, FontError, InstallOptions};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// The event every download reports on: `{family, state, done?, total?, errorCode?}`.
pub(crate) const FONT_DOWNLOAD: &str = "font-download";
const TIMEOUT: Duration = Duration::from_secs(20);
/// css2 picks the file format by User-Agent: a current browser's gets woff2.
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !matches!(method, "fonts.list" | "fonts.download" | "fonts.read" | "fonts.remove") {
        return None;
    }
    let root = gf::fonts_root(&state.app_dir);
    if method == "fonts.list" {
        let fonts = blocking(root.clone(), |root| gf::list(&root)).await.unwrap_or_default();
        return Some(RpcResponse::success(id, json!({ "fonts": fonts, "downloading": downloading(&root) })));
    }
    let Some(entry) = params.get("family").and_then(Value::as_str).and_then(gf::find) else {
        return Some(RpcResponse::error(id, ipc::INVALID_PARAMS, FontError::Unknown.code()));
    };
    Some(match method {
        "fonts.download" => RpcResponse::success(id, download(state, entry).await),
        "fonts.read" => match blocking(root, move |root| gf::read_files(&root, entry)).await.flatten() {
            Some(files) => RpcResponse::success(id, faces(entry, files)),
            None => RpcResponse::success(id, json!({ "family": entry.family, "faces": [], "errorCode": "E_FONT_MISSING" })),
        },
        _ => {
            if is_downloading(&root, entry) {
                return Some(RpcResponse::success(id, json!({ "removed": false, "errorCode": "E_FONT_BUSY" })));
            }
            match blocking(root, move |root| gf::remove(&root, entry)).await {
                Some(Ok(removed)) => RpcResponse::success(id, json!({ "removed": removed })),
                Some(Err(e)) => RpcResponse::success(id, json!({ "removed": false, "errorCode": "E_FONT_DISK", "error": e.to_string() })),
                None => RpcResponse::error(id, ipc::INTERNAL_ERROR, "fonts.remove did not finish"),
            }
        }
    })
}

async fn download(state: &Arc<DaemonState>, entry: &'static CatalogueEntry) -> Value {
    let root = gf::fonts_root(&state.app_dir);
    if blocking(root, move |root| gf::read_manifest(&root, entry)).await.flatten().is_some() {
        return json!({ "family": entry.family, "state": "ready" });
    }
    // No offline refusal up front: the user asked for this, and a gate still
    // closed after a blip must not stop it (`DaemonState::net`). A failure
    // says offline only if the gate agrees then (`outcome_code`).
    match start(state, entry, Box::new(|| NetFetch::new().map(|f| Box::new(f) as Box<dyn Fetch>))) {
        Ok(_) => json!({ "family": entry.family, "state": "downloading" }),
        Err(e) => {
            tracing::warn!("[fonts] {}: the download could not start: {e}", entry.family);
            json!({ "family": entry.family, "state": "failed", "errorCode": "E_FONT_NETWORK" })
        }
    }
}

type MakeFetch = Box<dyn FnOnce() -> Result<Box<dyn Fetch>, String> + Send>;

/// Starts the family's download thread, unless one is already running for
/// it (`Ok(false)`). Never waits on the download.
fn start(state: &Arc<DaemonState>, entry: &'static CatalogueEntry, make_fetch: MakeFetch) -> Result<bool, String> {
    let root = gf::fonts_root(&state.app_dir);
    let Some(guard) = InFlight::claim(&root, entry) else { return Ok(false) };
    let state = Arc::clone(state);
    std::thread::Builder::new()
        .name("font-download".into())
        .spawn(move || {
            crate::mbox_upload_job::background_qos();
            let family = entry.family.as_str();
            let emit = |payload: Value| {
                state.events.emit(FONT_DOWNLOAD, payload);
            };
            let result = make_fetch().map_err(FontError::Network).and_then(|fetch| {
                gf::install(
                    &root,
                    entry,
                    &*fetch,
                    &InstallOptions { retry_delays: &gf::RETRY_DELAYS },
                    &mut |done, total| emit(json!({ "family": family, "state": "downloading", "done": done, "total": total })),
                    &mut || crate::search_index::yield_to_foreground(&state.search_index),
                )
            });
            // Out of the in-flight set before the app hears the outcome, so
            // its `fonts.list` right after agrees with the event.
            drop(guard);
            match result {
                Ok(manifest) => emit(json!({ "family": family, "state": "ready", "bytes": manifest.bytes })),
                Err(e) => {
                    tracing::warn!("[fonts] {family}: {e}");
                    emit(json!({ "family": family, "state": "failed", "errorCode": outcome_code(&e, state.net.is_online()) }));
                }
            }
        })
        .map(|_| true)
        .map_err(|e| e.to_string())
}

/// The code a failed download reports: a network failure while the host is
/// offline is worded as offline, anything else as what it was.
fn outcome_code(e: &FontError, online: bool) -> &'static str {
    match e {
        FontError::Network(_) if !online => "E_FONT_OFFLINE",
        other => other.code(),
    }
}

fn faces(entry: &CatalogueEntry, files: Vec<(gf::ManifestFile, Vec<u8>)>) -> Value {
    let faces: Vec<Value> = files
        .into_iter()
        .map(|(f, bytes)| {
            json!({
                "weight": f.weight,
                "style": f.style,
                "subset": f.subset,
                "unicodeRange": f.unicode_range,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            })
        })
        .collect();
    json!({ "family": entry.family, "category": entry.category, "faces": faces })
}

/// File work off the tokio workers. `None` if the blocking task died.
async fn blocking<T: Send + 'static>(root: PathBuf, work: impl FnOnce(PathBuf) -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(move || work(root)).await.ok()
}

/// Family directories with a download running, and the family's name.
fn in_flight() -> &'static Mutex<HashMap<PathBuf, String>> {
    static SET: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<PathBuf, String>> {
    in_flight().lock().unwrap_or_else(|e| e.into_inner())
}

fn is_downloading(root: &std::path::Path, entry: &CatalogueEntry) -> bool {
    lock().contains_key(&gf::family_dir(root, entry))
}

fn downloading(root: &std::path::Path) -> Vec<String> {
    let mut out: Vec<String> = lock().iter().filter(|(dir, _)| dir.parent() == Some(root)).map(|(_, f)| f.clone()).collect();
    out.sort();
    out
}

/// A family's place in the in-flight set, given up on drop (a panic too).
struct InFlight(PathBuf);

impl InFlight {
    fn claim(root: &std::path::Path, entry: &CatalogueEntry) -> Option<Self> {
        let dir = gf::family_dir(root, entry);
        let mut set = lock();
        if set.contains_key(&dir) {
            return None;
        }
        set.insert(dir.clone(), entry.family.clone());
        Some(InFlight(dir))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        lock().remove(&self.0);
    }
}

/// The real network: one current-thread runtime on the download's own
/// thread, no redirects followed, the body capped while it streams in.
struct NetFetch {
    rt: tokio::runtime::Runtime,
    client: mailvault_core::net_activity::Tracked,
}

impl NetFetch {
    fn new() -> Result<Self, String> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .on_thread_start(crate::mbox_upload_job::background_qos)
            .build()
            .map_err(|e| e.to_string())?;
        let client = mailvault_core::net_activity::http_client_with(
            gf::PURPOSE,
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                .user_agent(USER_AGENT)
                .redirect(reqwest::redirect::Policy::none()),
        );
        Ok(NetFetch { rt, client })
    }
}

impl Fetch for NetFetch {
    fn get(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError> {
        self.rt.block_on(async {
            let transient = |e: reqwest::Error| FetchError::Transient(e.to_string());
            let mut response = self.client.send(self.client.get(url)).await.map_err(transient)?;
            let status = response.status().as_u16();
            if status != 200 {
                return Err(FetchError::Status(status));
            }
            if response.content_length().is_some_and(|n| n as usize > cap) {
                return Err(FetchError::TooLarge);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(transient)? {
                if body.len() + chunk.len() > cap {
                    return Err(FetchError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::handle_request_for_test;
    use std::sync::mpsc;

    const CSS: &str = include_str!("../../../src-core/tests/fixtures/google_fonts_css2.css");
    const WOFF2: &[u8] = b"wOF2\0\x01\0\0fake font body";

    fn scratch(tag: &str) -> (PathBuf, Arc<DaemonState>) {
        let dir = std::env::temp_dir().join(format!("mv-fonts-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = DaemonState::for_test(dir.clone(), dir.clone(), true);
        (dir, state)
    }

    /// Serves the fixture stylesheet and a woff2 for every gstatic URL; each
    /// request first waits for `gate` when one is given.
    struct Fixture {
        gate: Option<Mutex<mpsc::Receiver<()>>>,
    }

    impl Fetch for Fixture {
        fn get(&self, url: &str, _cap: usize) -> Result<Vec<u8>, FetchError> {
            if let Some(gate) = &self.gate {
                let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(10));
            }
            if url.starts_with("https://fonts.googleapis.com/css2?family=Roboto") {
                Ok(CSS.as_bytes().to_vec())
            } else if url.starts_with("https://fonts.gstatic.com/") {
                Ok(WOFF2.to_vec())
            } else {
                Err(FetchError::Status(404))
            }
        }
    }

    fn fixture(gate: Option<mpsc::Receiver<()>>) -> MakeFetch {
        Box::new(move || Ok(Box::new(Fixture { gate: gate.map(Mutex::new) }) as Box<dyn Fetch>))
    }

    async fn next_event(rx: &mut tokio::sync::broadcast::Receiver<Arc<str>>, state_name: &str) -> Value {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("no font event").unwrap();
            let (name, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
            if name == FONT_DOWNLOAD && payload["state"] == state_name {
                return payload;
            }
        }
    }

    fn roboto() -> &'static CatalogueEntry {
        gf::find("Roboto").unwrap()
    }

    #[tokio::test]
    async fn refuses_a_family_outside_the_catalogue() {
        let (dir, state) = scratch("unknown");
        for family in [json!("Comic Sans MS"), json!("../../etc"), json!(null)] {
            for method in ["fonts.download", "fonts.read", "fonts.remove"] {
                let resp = handle_request_for_test(&state, method, json!({ "family": family })).await;
                let v = serde_json::to_value(&resp).unwrap();
                assert_eq!(v["error"]["message"], json!("E_FONT_UNKNOWN"), "{method} {family}");
            }
        }
        assert!(!dir.join("fonts").exists(), "nothing was written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_download_answers_before_its_network_work_finishes() {
        let (dir, state) = scratch("nonblocking");
        let mut rx = state.events.subscribe();
        let (release, gate) = mpsc::channel();
        let started = std::time::Instant::now();
        assert_eq!(start(&state, roboto(), fixture(Some(gate))), Ok(true));
        assert!(started.elapsed() < Duration::from_secs(1), "start waited on the download");

        // Running: listed as downloading, a second start joins it, remove refuses.
        let list = serde_json::to_value(handle_request_for_test(&state, "fonts.list", json!({})).await).unwrap();
        assert_eq!(list["result"]["downloading"], json!(["Roboto"]));
        assert_eq!(list["result"]["fonts"], json!([]));
        assert_eq!(start(&state, roboto(), fixture(None)), Ok(false));
        let removed = serde_json::to_value(handle_request_for_test(&state, "fonts.remove", json!({ "family": "Roboto" })).await).unwrap();
        assert_eq!(removed["result"]["errorCode"], json!("E_FONT_BUSY"));

        for _ in 0..3 {
            release.send(()).unwrap();
        }
        let done = next_event(&mut rx, "ready").await;
        assert_eq!(done["family"], json!("Roboto"));

        let list = serde_json::to_value(handle_request_for_test(&state, "fonts.list", json!({})).await).unwrap();
        assert_eq!(list["result"]["downloading"], json!([]));
        assert_eq!(list["result"]["fonts"][0]["family"], json!("Roboto"));
        let again = serde_json::to_value(handle_request_for_test(&state, "fonts.download", json!({ "family": "Roboto" })).await).unwrap();
        assert_eq!(again["result"]["state"], json!("ready"), "an installed family is not fetched again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_failed_download_reports_its_code_and_leaves_nothing() {
        let (dir, state) = scratch("failed");
        let mut rx = state.events.subscribe();
        start(&state, gf::find("Lato").unwrap(), fixture(None)).unwrap();
        let failed = next_event(&mut rx, "failed").await;
        assert_eq!(failed["family"], json!("Lato"));
        assert_eq!(failed["errorCode"], json!("E_FONT_REFUSED"));
        assert!(!dir.join("fonts").join("lato").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reads_the_faces_as_base64_with_their_ranges_then_removes_them() {
        let (dir, state) = scratch("read");
        let mut rx = state.events.subscribe();
        start(&state, roboto(), fixture(None)).unwrap();
        next_event(&mut rx, "ready").await;

        let read = serde_json::to_value(handle_request_for_test(&state, "fonts.read", json!({ "family": "Roboto" })).await).unwrap();
        let faces = read["result"]["faces"].as_array().unwrap();
        assert_eq!(faces.len(), 4);
        assert_eq!(faces[1]["weight"], json!(400));
        assert!(faces[1]["unicodeRange"].as_str().unwrap().starts_with("U+0000-00FF"));
        let bytes = base64::engine::general_purpose::STANDARD.decode(faces[0]["data"].as_str().unwrap()).unwrap();
        assert_eq!(bytes, WOFF2);

        let removed = serde_json::to_value(handle_request_for_test(&state, "fonts.remove", json!({ "family": "Roboto" })).await).unwrap();
        assert_eq!(removed["result"]["removed"], json!(true));
        let read = serde_json::to_value(handle_request_for_test(&state, "fonts.read", json!({ "family": "Roboto" })).await).unwrap();
        assert_eq!(read["result"]["errorCode"], json!("E_FONT_MISSING"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real thing, by hand only (`--ignored`): the css2 answer for a
    /// current browser's User-Agent still parses to gstatic woff2 files.
    #[tokio::test]
    #[ignore = "reaches fonts.googleapis.com"]
    async fn downloads_a_real_family() {
        let (dir, state) = scratch("real");
        let mut rx = state.events.subscribe();
        for family in ["Lato", "Open Sans", "Lobster"] {
            start(&state, gf::find(family).unwrap(), Box::new(|| NetFetch::new().map(|f| Box::new(f) as Box<dyn Fetch>))).unwrap();
            let outcome = loop {
                let line = tokio::time::timeout(Duration::from_secs(90), rx.recv()).await.expect("no outcome").unwrap();
                let (_, payload) = mailvault_core::daemon_ipc::parse_event(&line).unwrap();
                if payload["family"] == family && payload["state"] != "downloading" {
                    break payload;
                }
            };
            assert_eq!(outcome["state"], json!("ready"), "{family}: {outcome}");
            let manifest = gf::read_manifest(&gf::fonts_root(&dir), gf::find(family).unwrap()).unwrap();
            println!("{family}: {} faces, {} bytes: {:?}", manifest.files.len(), manifest.bytes, manifest.files.iter().map(|f| &f.file).collect::<Vec<_>>());
            assert!(manifest.files.iter().any(|f| f.subset == "latin" && f.weight == 400));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// By hand only (`--ignored --nocapture`): every catalogue family's css2
    /// request, as `install` makes it, answers with latin faces. Prints the
    /// families whose weight list css2 refused (they fall back to 400).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "reaches fonts.googleapis.com once per catalogue family"]
    async fn every_catalogue_family_is_served() {
        let (failed, fell_back) = tokio::task::spawn_blocking(|| {
            let net = NetFetch::new().unwrap();
            let (mut failed, mut fell_back) = (Vec::new(), Vec::new());
            for entry in gf::catalogue() {
                let weights = gf::download_weights(entry);
                let css = match net.get(&gf::css2_url(&entry.family, &weights), gf::MAX_CSS_BYTES) {
                    Err(FetchError::Status(400)) => {
                        fell_back.push(entry.family.clone());
                        net.get(&gf::css2_url(&entry.family, &[]), gf::MAX_CSS_BYTES).map(|css| (css, vec![400]))
                    }
                    other => other.map(|css| (css, weights)),
                };
                match css {
                    Ok((css, weights)) if !gf::parse_css(&String::from_utf8_lossy(&css), &weights).is_empty() => {}
                    Ok(_) => failed.push(format!("{}: no latin face", entry.family)),
                    Err(e) => failed.push(format!("{}: {e:?}", entry.family)),
                }
            }
            (failed, fell_back)
        })
        .await
        .unwrap();
        println!("fell back to 400: {fell_back:?}");
        println!("failed: {failed:?}");
        assert!(failed.is_empty(), "{failed:?}");
    }

    #[test]
    fn a_network_failure_reads_as_offline_only_while_the_gate_says_so() {
        assert_eq!(outcome_code(&FontError::Network("dns error".into()), false), "E_FONT_OFFLINE");
        assert_eq!(outcome_code(&FontError::Network("dns error".into()), true), "E_FONT_NETWORK");
        assert_eq!(outcome_code(&FontError::Refused(404), false), "E_FONT_REFUSED");
        assert_eq!(outcome_code(&FontError::Invalid("html".into()), false), "E_FONT_INVALID");
    }

    #[tokio::test]
    async fn leaves_every_other_method_to_the_next_router() {
        let (dir, state) = scratch("other");
        assert!(route(&state, "views.list", &json!({}), json!(1)).await.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
