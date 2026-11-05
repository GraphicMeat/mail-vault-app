//! The mobile shell. It holds no logic: it opens the engine on Tauri's app data dir, forwards
//! `daemon_rpc` to it off the webview thread, and writes app log lines to the platform log.

use mailvault_mobile_engine::{Engine, RpcError};
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let engine = match app.path().app_data_dir() {
                Ok(dir) => Engine::open(&dir).map_err(|e| e.to_string()),
                Err(e) => Err(format!("app data dir: {e}")),
            };
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
