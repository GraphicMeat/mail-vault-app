//! The mobile shell. It holds no logic: it opens the engine on Tauri's app data and cache dirs
//! with the platform secret store, forwards `daemon_rpc` to it off the webview thread, and writes
//! app log lines to the platform log. It also hands a cached attachment to the system previewer
//! or share sheet (`mobile_open_file` / `mobile_share_file`) and, through the `mv-native` plugin's
//! navigation hook, sends links tapped in a mail to the system browser.

mod secrets;

use mailvault_mobile_engine::{Engine, RpcError};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_mv_native::files::{self, PathError};
use tauri_plugin_mv_native::{MvNative, NativeError};

/// The engine, or why it failed to open. The app starts either way; every RPC then answers
/// `INTERNAL` with the reason. Managed empty at the start of setup and filled once the engine is
/// open: the page can load and call before setup ends (on Android the webview loads while setup
/// runs), and such a call waits for the engine instead of finding no state.
struct EngineState(Arc<EngineSlot>);

type Opened = Arc<Result<Engine, String>>;

#[derive(Default)]
struct EngineSlot {
    engine: std::sync::Mutex<Option<Opened>>,
    ready: std::sync::Condvar,
}

/// Longest a call waits for setup to open the engine.
const ENGINE_WAIT: Duration = Duration::from_secs(60);

impl EngineSlot {
    fn fill(&self, engine: Opened) {
        *self.engine.lock().unwrap_or_else(|e| e.into_inner()) = Some(engine);
        self.ready.notify_all();
    }

    /// The opened engine; blocks (call it off the async runtime) until setup has opened it.
    fn wait(&self) -> Result<Opened, String> {
        let guard = self.engine.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = self
            .ready
            .wait_timeout_while(guard, ENGINE_WAIT, |e| e.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.clone().ok_or_else(|| "the engine is still starting".to_string())
    }
}

/// Same name and argument shape `daemonClient.js` sends on desktop. `daemon_mode` is the desktop
/// spawn policy and means nothing here.
#[tauri::command]
async fn daemon_rpc(
    state: tauri::State<'_, EngineState>,
    method: String,
    params: Value,
    daemon_mode: Option<Value>,
) -> Result<Value, RpcError> {
    let _ = daemon_mode;
    let slot = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let engine = slot.wait().map_err(RpcError::Internal)?;
        match engine.as_ref() {
            Ok(engine) => engine.rpc(&method, params),
            Err(reason) => Err(RpcError::Internal(reason.clone())),
        }
    })
    .await
    .map_err(|e| RpcError::Internal(e.to_string()))?
}

/// How long Android keeps a staged copy: its viewer or share target reads the file after
/// `startActivity` returns and nothing says when it is done, so copies go in a later sweep.
const STAGE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy)]
enum HandOut {
    Open,
    Share,
}

/// Opens a cached attachment in the system previewer (QuickLook on iOS, `ACTION_VIEW` on
/// Android). `path` must be one `mobile.attachment.local` answered; `name` and `mime` come from
/// the attachment's metadata and are only used to name the copy the previewer sees. Rejects with
/// `{code, message}`: `GONE` (evicted: fetch again), `INVALID` (not a cache file), `NO_APP`,
/// `BUSY`, `INTERNAL`.
#[tauri::command]
async fn mobile_open_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineState>,
    path: String,
    name: String,
    mime: String,
) -> Result<(), NativeError> {
    hand_out(app, Arc::clone(&state.0), path, name, mime, HandOut::Open).await
}

/// Offers a cached attachment to the system share sheet. Same arguments and errors as
/// `mobile_open_file`.
#[tauri::command]
async fn mobile_share_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineState>,
    path: String,
    name: String,
    mime: String,
) -> Result<(), NativeError> {
    hand_out(app, Arc::clone(&state.0), path, name, mime, HandOut::Share).await
}

/// Checks the path is a finished file of `<cache>/att/`, leases it while a named link or copy is
/// made under `<cache>/share/<fresh dir>/`, then hands that copy out. Off the webview thread: on
/// iOS the native call answers only when the previewer or sheet is dismissed.
async fn hand_out(
    app: tauri::AppHandle,
    slot: Arc<EngineSlot>,
    path: String,
    name: String,
    mime: String,
    how: HandOut,
) -> Result<(), NativeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let opened = slot.wait().map_err(|reason| NativeError::new("INTERNAL", reason))?;
        let engine = opened.as_ref().as_ref().map_err(|reason| NativeError::new("INTERNAL", reason.clone()))?;
        let cache = app.path().app_cache_dir().map_err(|e| NativeError::new("INTERNAL", e.to_string()))?;
        let share = cache.join("share");
        let real = files::validate_cache_file(Path::new(&path), &cache.join("att")).map_err(|e| match e {
            PathError::Gone => NativeError::new("GONE", "the file is gone"),
            PathError::Invalid(why) => NativeError::new("INVALID", why),
        })?;
        files::sweep(&share, STAGE_TTL);
        // The engine's spelling of the path (its lease compares the directory literally). Held
        // only while the link or copy is made: after that the copy no longer needs the cache name.
        let lease = engine
            .rpc("mobile.attachment.lease", json!({ "path": path }))
            .map_err(|_| NativeError::new("GONE", "the file is gone"))?;
        let staged = files::stage(&real, &files::sanitize_filename(&name, &mime), &share);
        if let Some(id) = lease.get("leaseId").cloned() {
            let _ = engine.rpc("mobile.attachment.release", json!({ "leaseId": id }));
        }
        let staged = staged.map_err(|e| NativeError::new("INTERNAL", e.to_string()))?;
        let native = app.try_state::<MvNative<tauri::Wry>>().ok_or_else(|| {
            files::unstage(&staged, &share);
            NativeError::new("INTERNAL", "the native plugin is not loaded")
        })?;
        let result = match how {
            HandOut::Open => native.open_file(&staged, &mime),
            HandOut::Share => native.share_file(&staged, &mime),
        };
        // iOS answers when the previewer or sheet has closed, so the copy is done with. Android
        // answers at once and the other app reads later: the sweep takes it.
        if cfg!(not(target_os = "android")) || result.is_err() {
            files::unstage(&staged, &share);
        }
        result
    })
    .await
    .map_err(|e| NativeError::new("INTERNAL", e.to_string()))?
}

/// Perf-gate builds log each cancelled navigation of the webview (scheme and verdict, never the
/// URL), so the on-device link check can see it.
#[cfg(feature = "perf-gate")]
const NAV_LOG: Option<tauri_plugin_mv_native::NavLog> = Some(|scheme, verdict| {
    log_line(&format!("MV_MOBILE {}", json!({ "nav": { "scheme": scheme, "verdict": verdict } })));
});
#[cfg(not(feature = "perf-gate"))]
const NAV_LOG: Option<tauri_plugin_mv_native::NavLog> = None;

/// One `MV_MOBILE <json>` line from the webview to the platform log (unified log on iOS, logcat
/// on Android), where `scripts/mobile-run.sh` reads it. The webview console reaches neither.
#[tauri::command]
fn mobile_log(line: String) {
    log_line(&line);
}

#[cfg(target_os = "android")]
fn log_line(line: &str) {
    use std::ffi::{c_char, c_int, CString};
    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }
    const ANDROID_LOG_INFO: c_int = 4;
    let text = CString::new(line.replace('\0', " ")).unwrap_or_default();
    // SAFETY: both pointers are NUL-terminated C strings that outlive the call.
    unsafe {
        __android_log_write(ANDROID_LOG_INFO, c"MailVault".as_ptr(), text.as_ptr());
    }
}

#[cfg(target_os = "ios")]
fn log_line(line: &str) {
    use std::ffi::{c_char, c_int, CString};
    extern "C" {
        fn syslog(priority: c_int, format: *const c_char, ...);
    }
    const LOG_NOTICE: c_int = 5;
    let text = CString::new(line.replace('\0', " ")).unwrap_or_default();
    // SAFETY: a "%s" format with one NUL-terminated argument that outlives the call.
    unsafe {
        syslog(LOG_NOTICE, c"%s".as_ptr(), text.as_ptr());
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn log_line(line: &str) {
    println!("{line}");
}

/// Android: core's rustls verifier asks the platform trust store through JNI, so it needs the
/// JVM and the app context before the first handshake. tao stores both in ndk-context when the
/// activity starts. A failure is logged; TLS then fails per connection with the verifier's error.
#[cfg(target_os = "android")]
fn init_tls_verifier() {
    use jni::objects::JObject;
    let result = (|| -> Result<(), jni::errors::Error> {
        let ctx = ndk_context::android_context();
        // SAFETY: tao put a live JavaVM pointer and a global ref to the application context in
        // ndk-context; both outlive the process's use of them here. Neither wrapper frees them.
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
        let mut env = vm.attach_current_thread()?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        rustls_platform_verifier::android::init_with_env(&mut env, context)
    })();
    if let Err(e) = result {
        log_line(&format!("MV_MOBILE {}", serde_json::json!({ "tlsInitError": e.to_string() })));
    }
}

#[cfg(not(target_os = "android"))]
fn init_tls_verifier() {}

/// Perf gate builds only: 10k synthetic rows the first time the app opens (kept on later launches).
#[cfg(feature = "perf-gate")]
fn seed_for_perf_gate(engine: &Engine) {
    use mailvault_mobile_engine::seed;
    if let Err(e) = seed::ensure_seeded(engine, seed::PERF_ROWS) {
        log_line(&format!("MV_MOBILE {}", serde_json::json!({ "seedError": e.to_string() })));
    }
}

#[cfg(not(feature = "perf-gate"))]
fn seed_for_perf_gate(_: &Engine) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Managed before any webview exists, so a call never finds no state; filled in setup.
    let slot = Arc::new(EngineSlot::default());
    let setup_slot = Arc::clone(&slot);
    tauri::Builder::default()
        .manage(EngineState(slot))
        // On the builder, before any page loads: every navigation is decided from the start, and
        // if the native plugin below fails to load, links stay cancelled (nothing opens).
        .plugin(tauri_plugin_mv_native::nav_guard(NAV_LOG))
        .setup(move |app| {
            let slot = setup_slot;
            init_tls_verifier();
            let secrets = secrets::KeyringSecrets::new();
            if let Some(reason) = secrets.error() {
                log_line(&format!("MV_MOBILE {}", serde_json::json!({ "secretsError": reason })));
            }
            // On Android each path is a round trip to the UI thread, which is busy creating the
            // webview: ask once, and nothing else before the engine is open.
            let cache_dir = app.path().app_cache_dir();
            let engine = match (app.path().app_data_dir(), &cache_dir) {
                (Ok(data), Ok(cache)) => Engine::open(&data, cache, Arc::new(secrets)).map_err(|e| e.to_string()),
                (Err(e), _) => Err(format!("app data dir: {e}")),
                (_, Err(e)) => Err(format!("app cache dir: {e}")),
            };
            if let Ok(engine) = &engine {
                engine.set_log_sink(log_line);
                // The sink runs on the engine's sync thread inside its block_on: only hand the
                // event to Tauri and return, never call back into the engine (no nested block_on).
                let handle = app.handle().clone();
                engine.set_event_sink(move |name, payload| {
                    let _ = handle.emit("mobile-event", serde_json::json!({ "name": name, "payload": payload }));
                });
                seed_for_perf_gate(engine);
            }
            if let Err(reason) = &engine {
                log_line(&format!("MV_MOBILE {}", serde_json::json!({ "engineError": reason })));
            }
            slot.fill(Arc::new(engine));
            // Copies left by an earlier run: all of them on iOS (its previewer went with the app),
            // the stale ones on Android (another app may still be reading a fresh one).
            if let Ok(cache) = cache_dir {
                let ttl = if cfg!(target_os = "android") { STAGE_TTL } else { Duration::ZERO };
                std::thread::spawn(move || files::sweep(&cache.join("share"), ttl));
            }
            // The native plugin, after the engine is open: on Android registering it waits until the
            // webview exists, and the page's first calls wait for the engine meanwhile. Without it attachments cannot open and links stay cancelled (the guard above denies
            // them all the same); the rest of the app works.
            if let Err(e) = app.handle().plugin(tauri_plugin_mv_native::init()) {
                log_line(&format!("MV_MOBILE {}", json!({ "nativePluginError": e.to_string() })));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_rpc, mobile_log, mobile_open_file, mobile_share_file])
        .run(tauri::generate_context!())
        .expect("error while running the MailVault mobile shell");
}
