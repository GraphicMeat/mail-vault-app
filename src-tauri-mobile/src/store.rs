//! App Store and Google Play subscriptions (plan 4 Task 6). The purchase runs in native code
//! (`native/ios/Sources/Store.swift`, `native/android/.../Store.kt`); this module gives the page
//! three commands that reach it, and gives the native code its one way into the engine.
//!
//! - `mobile_store_products`, `mobile_store_purchase`, `mobile_store_restore`: one store sheet at
//!   a time, the product checked before the store is asked, and only the outcome and the engine's
//!   verdict back to the page (`tauri_plugin_mv_native::store`), never a receipt.
//! - [`verify_json`] (iOS `mv_store_verify`, Android `Store.nativeVerify`): the native code hands
//!   each transaction to the engine's `mobile.premium.verify` here and reads `answered`, which
//!   says whether it may finish it ([`store::answered`]). A purchase, a renewal, a purchase the
//!   app was killed before verifying, and a Restore all take this path, so the rule lives in one
//!   place.
//! - [`install_id_json`] (Android `Store.nativeInstallId`): the engine's install id, for Play's
//!   obfuscated account id and for telling this install's own purchases from others on the same
//!   Play account. [`account_token_json`] (iOS `mv_store_account_token`): StoreKit's
//!   `appAccountToken`, a one-way hash of the install id (a receipt must not give the id away).
//!
//! The receipt, the AppTransaction and the install id pass through here and are never logged.

use crate::background;
use mailvault_mobile_engine::RpcError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_mv_native::{pick, store, MvNative, NativeError};

/// How long a native call waits for the engine. The plugin loads after setup opened it, so this
/// is a backstop; a call that gives up leaves its transaction unfinished for the next launch.
const ENGINE_WAIT: Duration = Duration::from_secs(60);

/// One store sheet at a time (a purchase or a Restore). A call whose native answer was lost is
/// given up after [`STORE_STALE`].
static STORE_LOCK: pick::PickLock = pick::PickLock::new();
const STORE_STALE: Duration = Duration::from_secs(10 * 60);

/// What the native code sends for one transaction.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyIn {
    platform: String,
    #[serde(default)]
    jws: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    product_id: Option<String>,
    #[serde(default)]
    restore: bool,
    #[serde(default)]
    app_transaction: Option<String>,
}

/// The `mobile.premium.verify` params for one native transaction: `{platform: "apple", jws,
/// restore?, appTransaction?}` or `{platform: "google", token, productId, restore?}`, ours only.
/// `None` for anything else (the native side then leaves the transaction alone).
pub(crate) fn verify_params(input: &str) -> Option<Value> {
    let v: VerifyIn = serde_json::from_str(input).ok()?;
    let product_ok = |p: &Option<String>| p.as_deref().map_or(true, store::product_ok);
    let present = |s: Option<String>| s.filter(|s| !s.trim().is_empty());
    let mut params = match v.platform.as_str() {
        "apple" if product_ok(&v.product_id) => json!({ "platform": "apple", "jws": present(v.jws)? }),
        "google" => {
            let product = present(v.product_id).filter(|p| store::product_ok(p))?;
            json!({ "platform": "google", "token": present(v.token)?, "productId": product })
        }
        _ => return None,
    };
    if v.restore {
        params["restore"] = json!(true);
        if params["platform"] == "apple" {
            if let Some(a) = present(v.app_transaction) {
                params["appTransaction"] = json!(a);
            }
        }
    }
    Some(params)
}

/// The native side's answer: `{answered, premium}` (the engine's status) or `{answered, code}`.
pub(crate) fn verify_reply(result: Result<Value, RpcError>) -> Value {
    match result {
        Ok(status) => json!({ "answered": store::answered(Ok(())), "premium": status }),
        Err(e) => json!({ "answered": store::answered(Err(e.code())), "code": e.code() }),
    }
}

/// One transaction from the native code to the engine. Blocks for the engine and the billing
/// server (up to a minute and 15 s): never on the main thread.
pub(crate) fn verify_json(input: &str) -> String {
    let Some(params) = verify_params(input) else {
        return json!({ "answered": false, "code": "INVALID" }).to_string();
    };
    let result = background::wait_engine(ENGINE_WAIT)
        .map_err(RpcError::Internal)
        .and_then(|engine| engine.rpc("mobile.premium.verify", params));
    if let Err(e) = &result {
        // The code only: never the receipt or the reason's text.
        crate::log_line(&format!("MV_MOBILE {}", json!({ "storeVerify": e.code() })));
    }
    verify_reply(result).to_string()
}

/// One field of the engine's `mobile.premium.installId` reply, `""` when it cannot be had (the
/// native side then waits for the next launch).
fn install_field(key: &str) -> String {
    background::wait_engine(ENGINE_WAIT)
        .ok()
        .and_then(|engine| engine.rpc("mobile.premium.installId", json!({})).ok())
        .and_then(|v| v[key].as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The engine's install id (Android).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn install_id_json() -> String {
    install_field("installId")
}

/// StoreKit's `appAccountToken` for this install (iOS).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn account_token_json() -> String {
    install_field("appAccountToken")
}

fn native(app: &tauri::AppHandle) -> Result<tauri::State<'_, MvNative<tauri::Wry>>, NativeError> {
    app.try_state::<MvNative<tauri::Wry>>().ok_or_else(|| NativeError::new("INTERNAL", "the native plugin is not loaded"))
}

/// The store's offer for both subscriptions, `[{id, title, price, period: "P1M"|"P1Y",
/// introOffer?}]` (`price` is the store's localized string; never hard-coded). Monthly first; a
/// product the store does not offer is missing. Rejects with `{code, message}`: `UNAVAILABLE`,
/// `UNSUPPORTED`, `INTERNAL`.
#[tauri::command]
pub(crate) async fn mobile_store_products(app: tauri::AppHandle) -> Result<Vec<Value>, NativeError> {
    tauri::async_runtime::spawn_blocking(move || Ok(store::products(&native(&app)?.store_products()?)))
        .await
        .map_err(|e| NativeError::new("INTERNAL", e.to_string()))?
}

/// Runs `f` under the store lock (`BUSY` while another purchase or Restore runs), off the webview
/// thread: the native call answers only when the store sheet has closed and the engine answered.
async fn exclusive<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&MvNative<tauri::Wry>) -> Result<T, NativeError> + Send + 'static,
) -> Result<T, NativeError> {
    let generation =
        STORE_LOCK.take(Instant::now(), STORE_STALE).ok_or_else(|| NativeError::new("BUSY", "a purchase is already running"))?;
    let answer = tauri::async_runtime::spawn_blocking(move || f(&*native(&app)?))
        .await
        .map_err(|e| NativeError::new("INTERNAL", e.to_string()));
    STORE_LOCK.release(generation);
    answer?
}

/// Buys `productId` (one of the two subscriptions): the store's sheet, then the purchase is
/// verified by the engine before this answers. Answers `{status: "purchased"|"pending"|"cancelled",
/// platform: "apple"|"google", productId}`, and for `purchased` either `premium` (the engine's
/// `{premium, source, expiresMs}`) or `error: {code}` (`NETWORK`, `RATE_LIMITED`: the store
/// charged and the app checks again at the next launch; `REFUSED`; `UNVERIFIED`: the store's own
/// signature check failed). `pending` is a purchase waiting for approval (Ask to Buy, a slow
/// payment): Premium arrives with `mobile.premium.changed` when it goes through. Rejects with
/// `{code, message}`: `INVALID` (not our product), `BUSY`, `UNAVAILABLE`, `NOT_FOUND`, `OWNED`
/// (Play: already subscribed, use Restore), `UNSUPPORTED`, `INTERNAL`.
#[tauri::command]
pub(crate) async fn mobile_store_purchase(app: tauri::AppHandle, product_id: String) -> Result<Value, NativeError> {
    if !store::product_ok(&product_id) {
        return Err(NativeError::new("INVALID", "not a MailVault product"));
    }
    exclusive(app, move |native| {
        let raw = native.store_purchase(&product_id)?;
        store::purchase_reply(&raw, &product_id).ok_or_else(|| NativeError::new("INTERNAL", "the store's answer does not read"))
    })
    .await
}

/// Restore Purchases: syncs with the store (iOS may ask the user to sign in to the App Store) and
/// hands each subscription the store account holds to the engine as a restore (Apple with this
/// install's AppTransaction as proof of the account). Answers one item per subscription found,
/// `[{platform, productId, premium | error: {code}}]` (`INSTALL_LIMIT`: the purchase is already on
/// its most devices); `[]` when the account holds none. Rejects with `{code, message}`: `BUSY`,
/// `UNAVAILABLE`, `UNSUPPORTED`, `INTERNAL`.
#[tauri::command]
pub(crate) async fn mobile_store_restore(app: tauri::AppHandle) -> Result<Vec<Value>, NativeError> {
    exclusive(app, |native| Ok(store::restore_reply(&native.store_restore()?))).await
}

// ── Native entry points ──────────────────────────────────────────────────────

/// iOS (Store.swift): one transaction to the engine, `json` as [`verify_params`] reads it.
/// Returns `{answered, premium | code}` JSON, freed with `mv_free_string`. Blocks: call it off
/// the main thread.
///
/// # Safety
/// `json` is null or a NUL-terminated string that outlives the call.
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn mv_store_verify(json: *const std::ffi::c_char) -> *mut std::ffi::c_char {
    let fallback = r#"{"answered":false,"code":"INTERNAL"}"#.to_string();
    if json.is_null() {
        return background::c_string(fallback);
    }
    // SAFETY: a NUL-terminated string the caller keeps alive for the call.
    let text = unsafe { std::ffi::CStr::from_ptr(json) }.to_string_lossy().into_owned();
    background::c_string(background::guarded(fallback, || verify_json(&text)))
}

/// iOS (Store.swift): this install's StoreKit `appAccountToken`, `""` when it cannot be had;
/// freed with `mv_free_string`. Blocks: call it off the main thread.
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn mv_store_account_token() -> *mut std::ffi::c_char {
    background::c_string(background::guarded(String::new(), account_token_json))
}

/// Android (`Store.nativeVerify`): as `mv_store_verify`.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_mailvault_mvnative_Store_nativeVerify(
    mut env: jni::JNIEnv,
    _class: jni::objects::JObject,
    json: jni::objects::JString,
) -> jni::sys::jstring {
    let fallback = r#"{"answered":false,"code":"INTERNAL"}"#.to_string();
    let text: Option<String> = env.get_string(&json).ok().map(Into::into);
    let out = match text {
        Some(text) => background::guarded(fallback, || verify_json(&text)),
        None => fallback,
    };
    env.new_string(out).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// Android (`Store.nativeInstallId`): this install's id, `""` when it cannot be had.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_mailvault_mvnative_Store_nativeInstallId(env: jni::JNIEnv, _class: jni::objects::JObject) -> jni::sys::jstring {
    let out = background::guarded(String::new(), install_id_json);
    env.new_string(out).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONTHLY: &str = "com.mailvault.app.premium.monthly";

    #[test]
    fn apple_params_carry_the_jws_and_the_proof_only_on_restore() {
        let p = verify_params(r#"{"platform":"apple","jws":"J","productId":"com.mailvault.app.premium.yearly"}"#).unwrap();
        assert_eq!(p, json!({ "platform": "apple", "jws": "J" }));
        let p = verify_params(r#"{"platform":"apple","jws":"J","appTransaction":"A"}"#).unwrap();
        assert_eq!(p, json!({ "platform": "apple", "jws": "J" }), "no proof without restore");
        let p = verify_params(r#"{"platform":"apple","jws":"J","restore":true,"appTransaction":"A"}"#).unwrap();
        assert_eq!(p, json!({ "platform": "apple", "jws": "J", "restore": true, "appTransaction": "A" }));
        let p = verify_params(r#"{"platform":"apple","jws":"J","restore":true,"appTransaction":" "}"#).unwrap();
        assert_eq!(p, json!({ "platform": "apple", "jws": "J", "restore": true }));
    }

    #[test]
    fn google_params_need_token_and_our_product() {
        let p = verify_params(&json!({ "platform": "google", "token": "T", "productId": MONTHLY, "restore": true }).to_string()).unwrap();
        assert_eq!(p, json!({ "platform": "google", "token": "T", "productId": MONTHLY, "restore": true }));
        let p = verify_params(&json!({ "platform": "google", "token": "T", "productId": MONTHLY, "appTransaction": "A", "restore": true }).to_string()).unwrap();
        assert!(p.get("appTransaction").is_none(), "{p}");
        assert!(verify_params(&json!({ "platform": "google", "token": "T" }).to_string()).is_none());
        assert!(verify_params(&json!({ "platform": "google", "token": "", "productId": MONTHLY }).to_string()).is_none());
        assert!(verify_params(&json!({ "platform": "google", "token": "T", "productId": "com.other" }).to_string()).is_none());
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "",
            "null",
            r#"{"platform":"apple"}"#,
            r#"{"platform":"apple","jws":"  "}"#,
            r#"{"platform":"apple","jws":"J","productId":"com.other"}"#,
            r#"{"platform":"web","jws":"J"}"#,
            r#"{"platform":"apple","jws":"J","extra":1}"#,
        ] {
            assert!(verify_params(bad).is_none(), "{bad}");
        }
        assert_eq!(verify_json("{}"), json!({ "answered": false, "code": "INVALID" }).to_string());
    }

    #[test]
    fn the_reply_says_whether_the_server_answered() {
        let ok = verify_reply(Ok(json!({ "premium": true, "source": "apple", "expiresMs": 1 })));
        assert_eq!(ok, json!({ "answered": true, "premium": { "premium": true, "source": "apple", "expiresMs": 1 } }));
        assert_eq!(verify_reply(Err(RpcError::Premium("REFUSED"))), json!({ "answered": true, "code": "REFUSED" }));
        assert_eq!(verify_reply(Err(RpcError::Premium("INSTALL_LIMIT"))), json!({ "answered": true, "code": "INSTALL_LIMIT" }));
        assert_eq!(verify_reply(Err(RpcError::Premium("NETWORK"))), json!({ "answered": false, "code": "NETWORK" }));
        assert_eq!(verify_reply(Err(RpcError::Premium("RATE_LIMITED"))), json!({ "answered": false, "code": "RATE_LIMITED" }));
        assert_eq!(verify_reply(Err(RpcError::Internal("engine".into()))), json!({ "answered": false, "code": "INTERNAL" }));
        assert_eq!(verify_reply(Err(RpcError::Invalid("x".into()))), json!({ "answered": false, "code": "INVALID" }));
    }
}
