//! The mobile shell. It holds no logic: it opens the engine on Tauri's app data and cache dirs
//! with the platform secret store, forwards `daemon_rpc` to it off the webview thread, and writes
//! app log lines to the platform log. It also hands a cached attachment to the system previewer
//! or share sheet (`mobile_open_file` / `mobile_share_file`), runs the system file and photo
//! pickers for outgoing attachments (`mobile_pick_files`), opens and closes the system sign-in
//! sheet for an OAuth flow (`mobile_auth_open` / `mobile_auth_close`) and, through the `mv-native`
//! plugin's navigation hook, sends links tapped in a mail to the system browser.

mod secrets;

use mailvault_mobile_engine::{Engine, RpcError};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_mv_native::files::{self, PathError};
use tauri_plugin_mv_native::{pick, MvNative, NativeError, PickKind};

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

/// Where a running pick's copies land before they are named: `<cache>/pick/<fresh dir>/<index>`.
/// Emptied after each pick and at start (a pick killed with the app leaves its dir behind).
const PICK_SCRATCH: &str = "pick";

/// One pick at a time, on both platforms: the native side keeps one pending pick (Android one
/// scratch dir), so a second call while a picker is up answers `BUSY`. A pick pending longer than
/// [`PICK_STALE`] lost its native answer (Android drops it when the launching activity goes) and
/// is taken over by the next call; see [`pick::PickLock`].
static PICK_LOCK: pick::PickLock = pick::PickLock::new();
const PICK_STALE: Duration = Duration::from_secs(10 * 60);

/// Holds one generation of [`PICK_LOCK`]; dropping it (any return, error or panic) frees the lock
/// unless a newer pick has taken it over.
struct PickGuard(u64);

impl PickGuard {
    fn take() -> Option<PickGuard> {
        PICK_LOCK.take(std::time::Instant::now(), PICK_STALE).map(PickGuard)
    }

    fn still_held(&self) -> bool {
        PICK_LOCK.holds(self.0)
    }
}

impl Drop for PickGuard {
    fn drop(&mut self) {
        PICK_LOCK.release(self.0);
    }
}

/// Runs the system picker for outgoing attachments: `kind` is `files` (the document picker) or
/// `photos` (the photo picker; no photo library permission on either platform). Answers when the
/// picker closes, `[]` on cancel. Each pick is copied into `<cache>/out/<16 hex>/<sanitized name>`
/// and answered as `{handle, name, size, mime}` with `handle` = `out/<16 hex>/<name>`, relative to
/// the cache dir: the page never sees a path, and the engine checks the handle
/// (`resolve_outgoing`) before it reads one. A pick that could not be read in full is
/// `{name, error: "UNREADABLE"}`. Rejects with `{code, message}`: `INVALID` (unknown kind),
/// `BUSY` (a picker or another sheet is up), `NO_APP`, `INTERNAL`.
#[tauri::command]
async fn mobile_pick_files(app: tauri::AppHandle, kind: String) -> Result<Vec<Value>, NativeError> {
    let kind = match kind.as_str() {
        "files" => PickKind::Files,
        "photos" => PickKind::Photos,
        _ => return Err(NativeError::new("INVALID", "unknown picker")),
    };
    let guard = PickGuard::take().ok_or_else(|| NativeError::new("BUSY", "a picker is already open"))?;
    // Off the webview thread: the native call answers only when the picker closes.
    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.path().app_cache_dir().map_err(|e| NativeError::new("INTERNAL", e.to_string()))?;
        let native = app
            .try_state::<MvNative<tauri::Wry>>()
            .ok_or_else(|| NativeError::new("INTERNAL", "the native plugin is not loaded"))?;
        let scratch = files::new_stage_dir(&cache.join(PICK_SCRATCH)).map_err(|e| NativeError::new("INTERNAL", e.to_string()))?;
        let picks = native.pick_files(kind, &scratch);
        // Taken over meanwhile (this pick was given up as lost): its answer is dropped.
        if !guard.still_held() {
            let _ = std::fs::remove_dir_all(&scratch);
            return Err(NativeError::new("BUSY", "the pick was given up"));
        }
        let reply = picks.map(|picks| {
            picks
                .into_iter()
                .map(|pick| {
                    let finished = pick
                        .file
                        .as_deref()
                        .filter(|_| pick.error.is_none())
                        .and_then(|file| files::finish_pick(&cache, &scratch, file, &pick.name, pick.mime.as_deref().unwrap_or("")).ok());
                    match finished {
                        Some(p) => json!({ "handle": p.handle, "name": p.name, "size": p.size, "mime": p.mime }),
                        None => json!({ "name": files::sanitize_filename(&pick.name, ""), "error": "UNREADABLE" }),
                    }
                })
                .collect()
        });
        let _ = std::fs::remove_dir_all(&scratch);
        reply
    })
    .await
    .map_err(|e| NativeError::new("INTERNAL", e.to_string()))?
}

/// One sign-in sheet at a time. A sheet whose native answer was lost (Android drops it when the
/// activity goes) is given up after [`AUTH_STALE`], just over the engine's 300 s `finish` wait:
/// by then its flow is over anyway.
static AUTH_LOCK: pick::PickLock = pick::PickLock::new();
const AUTH_STALE: Duration = Duration::from_secs(330);

/// Shows `url`, the provider sign-in page `mobile.oauth.begin` (or `.reauth`) answered, in the
/// system sign-in sheet (iOS `ASWebAuthenticationSession`, Android a Custom Tab). Only
/// `https://accounts.google.com/...` and `https://login.microsoftonline.com/...` open
/// (`links::auth_url_ok`). The provider redirects to the engine's loopback listener, never back
/// here: the page does not wait on this for the code, it waits on `mobile.oauth.finish`. Answers
/// when the sheet closes, `{cancelled: true}` when the user closed it, `{cancelled: false}` when
/// `mobile_auth_close` did. Rejects with `{code, message}`: `INVALID` (not a sign-in page),
/// `BUSY` (a sheet is already up), `NO_APP` (no browser), `INTERNAL`. The URL is never logged.
#[tauri::command]
async fn mobile_auth_open(app: tauri::AppHandle, url: String) -> Result<Value, NativeError> {
    if !tauri_plugin_mv_native::links::auth_url_ok(&url) {
        return Err(NativeError::new("INVALID", "not a sign-in page this app opens"));
    }
    let generation = AUTH_LOCK
        .take(std::time::Instant::now(), AUTH_STALE)
        .ok_or_else(|| NativeError::new("BUSY", "a sign-in sheet is already open"))?;
    // Off the webview thread: the native call answers only when the sheet closes.
    let answer = tauri::async_runtime::spawn_blocking(move || {
        let native = app
            .try_state::<MvNative<tauri::Wry>>()
            .ok_or_else(|| NativeError::new("INTERNAL", "the native plugin is not loaded"))?;
        native.open_auth(&url)
    })
    .await
    .map_err(|e| NativeError::new("INTERNAL", e.to_string()));
    AUTH_LOCK.release(generation);
    let reply = answer??;
    Ok(json!({ "cancelled": reply.cancelled }))
}

/// Closes the sign-in sheet, once `mobile.oauth.finish` has answered; nothing when none is up.
/// Never waits for the sheet's lock: it runs while `mobile_auth_open` is still waiting.
#[tauri::command]
async fn mobile_auth_close(app: tauri::AppHandle) -> Result<(), NativeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let native = app
            .try_state::<MvNative<tauri::Wry>>()
            .ok_or_else(|| NativeError::new("INTERNAL", "the native plugin is not loaded"))?;
        native.close_auth()
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

/// Once per install: re-saves every account's secret under the iOS access policy (see
/// `secrets.rs`), recorded by the `secrets.policy` setting. A failure is logged and the next
/// start tries again.
fn migrate_secrets(engine: &Engine, secrets: &secrets::KeyringSecrets) {
    const KEY: &str = "secrets.policy";
    const DONE: &str = "afu1";
    if secrets.error().is_some() || matches!(engine.setting(KEY), Ok(Some(v)) if v == DONE) {
        return;
    }
    let result = engine
        .account_ids()
        .map_err(|e| e.to_string())
        .and_then(|ids| secrets.migrate_access_policy(&ids))
        .and_then(|()| engine.set_setting(KEY, DONE).map_err(|e| e.to_string()));
    if let Err(reason) = result {
        log_line(&format!("MV_MOBILE {}", json!({ "secretsPolicyError": reason })));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Managed before any webview exists, so a call never finds no state; filled in setup.
    let slot = Arc::new(EngineSlot::default());
    let setup_slot = Arc::clone(&slot);
    let run_slot = Arc::clone(&slot);
    tauri::Builder::default()
        .manage(EngineState(slot))
        // On the builder, before any page loads: every navigation is decided from the start, and
        // if the native plugin below fails to load, links stay cancelled (nothing opens).
        .plugin(tauri_plugin_mv_native::nav_guard(NAV_LOG))
        .setup(move |app| {
            let slot = setup_slot;
            init_tls_verifier();
            let secrets = Arc::new(secrets::KeyringSecrets::new());
            if let Some(reason) = secrets.error() {
                log_line(&format!("MV_MOBILE {}", serde_json::json!({ "secretsError": reason })));
            }
            // On Android each path is a round trip to the UI thread, which is busy creating the
            // webview: ask once, and nothing else before the engine is open.
            let cache_dir = app.path().app_cache_dir();
            let engine = match (app.path().app_data_dir(), &cache_dir) {
                (Ok(data), Ok(cache)) => Engine::open(&data, cache, secrets.clone()).map_err(|e| e.to_string()),
                (Err(e), _) => Err(format!("app data dir: {e}")),
                (_, Err(e)) => Err(format!("app cache dir: {e}")),
            };
            if let Ok(engine) = &engine {
                engine.set_log_sink(log_line);
                // Before the event sink and the slot: either one starts work that reads secrets.
                migrate_secrets(engine, &secrets);
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
            // A pick's scratch copies never outlive the pick. `<cache>/out/` is left alone: drafts
            // and the outbox hold its handles.
            if let Ok(cache) = cache_dir {
                let ttl = if cfg!(target_os = "android") { STAGE_TTL } else { Duration::ZERO };
                std::thread::spawn(move || {
                    files::sweep(&cache.join("share"), ttl);
                    files::sweep(&cache.join(PICK_SCRATCH), Duration::ZERO);
                });
            }
            // The native plugin, after the engine is open: on Android registering it waits until the
            // webview exists, and the page's first calls wait for the engine meanwhile. Without it attachments cannot open and links stay cancelled (the guard above denies
            // them all the same); the rest of the app works.
            if let Err(e) = app.handle().plugin(tauri_plugin_mv_native::init()) {
                log_line(&format!("MV_MOBILE {}", json!({ "nativePluginError": e.to_string() })));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_rpc,
            mobile_log,
            mobile_open_file,
            mobile_share_file,
            mobile_pick_files,
            mobile_auth_open,
            mobile_auth_close
        ])
        .build(tauri::generate_context!())
        .expect("error while running the MailVault mobile shell")
        .run(move |_app, event| on_run_event(&run_slot, &event));
}

/// The OS's suspend and resume (Android `onPause`/`onResume`, iOS resign/enter foreground) reach
/// the engine's live listener directly, as `mobile.app.state`: a backstop for a WebView that never
/// reports `visibilitychange: hidden`. A resume names no account: the engine resumes the one it
/// last listened on, and replaces its connection, which may have died while the app was away.
fn on_run_event(slot: &Arc<EngineSlot>, event: &tauri::RunEvent) {
    #[cfg(mobile)]
    {
        let params = match event {
            tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Suspended, .. } => json!({ "foreground": false }),
            tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Resumed, .. } => json!({ "foreground": true, "resumed": true }),
            _ => return,
        };
        // Not before setup opened the engine, and never on the UI thread.
        let Some(opened) = slot.engine.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
        std::thread::spawn(move || {
            if let Ok(engine) = opened.as_ref() {
                let _ = engine.rpc("mobile.app.state", params);
            }
        });
    }
    #[cfg(not(mobile))]
    let _ = (slot, event);
}
