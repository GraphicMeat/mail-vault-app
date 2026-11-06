//! The mobile shell. It holds no logic: it opens the engine on Tauri's app data and cache dirs
//! with the platform secret store, forwards `daemon_rpc` to it off the webview thread, and writes
//! app log lines to the platform log.

mod secrets;

use mailvault_mobile_engine::{Engine, RpcError};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// The engine, or why it failed to open. The app starts either way; every RPC then answers
/// `INTERNAL` with the reason.
struct EngineState(Arc<Result<Engine, String>>);

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
    let engine = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || match engine.as_ref() {
        Ok(engine) => engine.rpc(&method, params),
        Err(reason) => Err(RpcError::Internal(reason.clone())),
    })
    .await
    .map_err(|e| RpcError::Internal(e.to_string()))?
}

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
    tauri::Builder::default()
        .setup(|app| {
            init_tls_verifier();
            let secrets = secrets::KeyringSecrets::new();
            if let Some(reason) = secrets.error() {
                log_line(&format!("MV_MOBILE {}", serde_json::json!({ "secretsError": reason })));
            }
            let engine = match (app.path().app_data_dir(), app.path().app_cache_dir()) {
                (Ok(data), Ok(cache)) => Engine::open(&data, &cache, Arc::new(secrets)).map_err(|e| e.to_string()),
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
            app.manage(EngineState(Arc::new(engine)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_rpc, mobile_log])
        .run(tauri::generate_context!())
        .expect("error while running the MailVault mobile shell");
}
