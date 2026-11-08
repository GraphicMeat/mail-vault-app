//! Android entry points that run without the app's activity: the WorkManager worker
//! (`native/android/.../BackgroundFetchWorker.kt`) and notification taps (`Notifier.kt`), plus the
//! guard that lets a worker-first process later start the activity.
//!
//! The secret store and the TLS verifier reach Android through ndk-context. tao fills it when the
//! activity is created, from a process-wide once (`tao` `ndk_glue::onCreate`), and ndk-context
//! asserts it is filled at most once. A worker that runs after the app was swiped away has no
//! activity, so it fills ndk-context itself from its `applicationContext`; when the user then
//! opens the app in that same process (a notification tap, typically), `MainActivity` calls
//! [`before_activity`] before tao's `onCreate`, which empties ndk-context again (waiting for any
//! secret call in flight; new ones wait meanwhile) so tao's fill does not abort the process, and
//! [`after_activity`] once tao has filled it. A secret call takes [`enter`] around its use.

use jni::objects::{GlobalRef, JObject, JString};
use jni::sys::{jint, jstring};
use jni::JNIEnv;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Ctx {
    /// The worker filled ndk-context with this context (a global ref kept alive while it is in).
    worker: Option<GlobalRef>,
    /// An activity has been created in this process: tao owns ndk-context from then on.
    activity: bool,
    /// Between `before_activity` and `after_activity`: ndk-context may be empty.
    swapping: bool,
    /// Secret calls using ndk-context now.
    in_use: usize,
}

static CTX: Mutex<Ctx> = Mutex::new(Ctx { worker: None, activity: false, swapping: false, in_use: 0 });
static CHANGED: Condvar = Condvar::new();
/// Longest a secret call waits for the activity's swap (a swap that never ends must not hang it).
const SWAP_WAIT: Duration = Duration::from_secs(5);

fn lock() -> std::sync::MutexGuard<'static, Ctx> {
    CTX.lock().unwrap_or_else(|e| e.into_inner())
}

/// Held around a use of ndk-context by the secret store.
pub(crate) struct InUse;

pub(crate) fn enter() -> InUse {
    let deadline = Instant::now() + SWAP_WAIT;
    let mut ctx = lock();
    while ctx.swapping {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        ctx = CHANGED.wait_timeout(ctx, left).unwrap_or_else(|e| e.into_inner()).0;
    }
    ctx.in_use += 1;
    InUse
}

impl Drop for InUse {
    fn drop(&mut self) {
        let mut ctx = lock();
        ctx.in_use = ctx.in_use.saturating_sub(1);
        CHANGED.notify_all();
    }
}

/// Fills ndk-context from the worker's application context unless an activity (tao) or an earlier
/// worker run already did.
fn ensure_context(env: &mut JNIEnv, worker: &JObject) -> Result<(), jni::errors::Error> {
    let mut ctx = lock();
    if ctx.activity || ctx.worker.is_some() {
        return Ok(());
    }
    let app = env.call_method(worker, "getApplicationContext", "()Landroid/content/Context;", &[])?.l()?;
    let global = env.new_global_ref(app)?;
    let vm = env.get_java_vm()?;
    // SAFETY: a live JavaVM and a global ref this module keeps until it empties ndk-context.
    unsafe { ndk_context::initialize_android_context(vm.get_java_vm_pointer().cast(), global.as_obj().as_raw().cast()) };
    ctx.worker = Some(global);
    Ok(())
}

/// `MainActivity.onCreate`, before `super.onCreate` (tao's fill of ndk-context).
#[no_mangle]
pub extern "system" fn Java_com_mailvault_app_MainActivity_nativeBeforeActivity(_env: JNIEnv, _this: JObject) {
    let _ = std::panic::catch_unwind(|| {
        let mut ctx = lock();
        if ctx.activity {
            return;
        }
        ctx.activity = true;
        if ctx.worker.is_none() {
            return;
        }
        ctx.swapping = true;
        let deadline = Instant::now() + SWAP_WAIT;
        while ctx.in_use > 0 && Instant::now() < deadline {
            let left = deadline.saturating_duration_since(Instant::now());
            ctx = CHANGED.wait_timeout(ctx, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        // SAFETY: filled by `ensure_context`, emptied once here.
        unsafe { ndk_context::release_android_context() };
        ctx.worker = None;
    });
}

/// `MainActivity.onCreate`, after `super.onCreate`: tao has filled ndk-context.
#[no_mangle]
pub extern "system" fn Java_com_mailvault_app_MainActivity_nativeAfterActivity(_env: JNIEnv, _this: JObject) {
    let _ = std::panic::catch_unwind(|| {
        lock().swapping = false;
        CHANGED.notify_all();
    });
}

fn jstr(env: &mut JNIEnv, s: &JString) -> Option<String> {
    env.get_string(s).ok().map(Into::into)
}

/// The system languages (`Locale.getDefault()`), for the notification text.
fn system_language(env: &mut JNIEnv) -> Option<String> {
    let locale = env.call_static_method("java/util/Locale", "getDefault", "()Ljava/util/Locale;", &[]).ok()?.l().ok()?;
    let tag = env.call_method(&locale, "toLanguageTag", "()Ljava/lang/String;", &[]).ok()?.l().ok()?;
    jstr(env, &JString::from(tag))
}

/// `BackgroundFetchWorker.nativeFetch(dataDir, cacheDir, budgetMs)`: one background run; returns
/// `{channel, notes, commit?}` JSON (see `background::run_json`).
#[no_mangle]
pub extern "system" fn Java_com_mailvault_mvnative_BackgroundFetchWorker_nativeFetch(
    mut env: JNIEnv,
    this: JObject,
    data_dir: JString,
    cache_dir: JString,
    budget_ms: jint,
) -> jstring {
    // The budget counts from here: opening the engine in a worker-first process is inside it.
    let started = Instant::now();
    let empty = r#"{"channel":"","notes":[]}"#.to_string();
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if let Err(e) = ensure_context(&mut env, &this) {
            crate::log_line(&format!("MV_MOBILE {}", serde_json::json!({ "backgroundError": format!("context: {e}") })));
            return empty.clone();
        }
        // The TLS verifier, as setup does; a second call is a no-op.
        if let Ok(app) = env.call_method(&this, "getApplicationContext", "()Landroid/content/Context;", &[]).and_then(|v| v.l()) {
            if let Err(e) = rustls_platform_verifier::android::init_with_env(&mut env, app) {
                crate::log_line(&format!("MV_MOBILE {}", serde_json::json!({ "tlsInitError": e.to_string() })));
            }
        }
        if let Some(lang) = system_language(&mut env) {
            crate::background::set_languages(vec![lang]);
        }
        let (Some(data), Some(cache)) = (jstr(&mut env, &data_dir), jstr(&mut env, &cache_dir)) else {
            return empty.clone();
        };
        let budget = Duration::from_millis(u64::try_from(budget_ms).unwrap_or(0));
        crate::background::run_json(&PathBuf::from(data), &PathBuf::from(cache), budget, started)
    }))
    .unwrap_or(empty);
    env.new_string(out).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// `BackgroundFetchWorker.nativeCommit(token)`: the run's notifications were posted.
#[no_mangle]
pub extern "system" fn Java_com_mailvault_mvnative_BackgroundFetchWorker_nativeCommit(mut env: JNIEnv, _this: JObject, token: JString) {
    let Some(text) = jstr(&mut env, &token) else { return };
    let _ = std::panic::catch_unwind(|| crate::background::commit(&text));
}

/// `Notifier.nativeTapped(json)`: a notification was tapped.
#[no_mangle]
pub extern "system" fn Java_com_mailvault_mvnative_Notifier_nativeTapped(mut env: JNIEnv, _class: JObject, json: JString) {
    let Some(text) = jstr(&mut env, &json) else { return };
    let _ = std::panic::catch_unwind(|| crate::background::tapped(&text));
}
