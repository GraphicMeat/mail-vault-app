//! The process's one engine (plan Ruling 12) and the background entry points (Ruling 9).
//!
//! `setup`, iOS `mv_background_fetch` (from `native/ios/Sources/Background.swift`) and Android
//! `BackgroundFetchWorker.nativeFetch` all go through [`engine_with`]: whichever comes first opens
//! the engine, the others get the same one, so there is never a second writer on `mobile.db`.
//! A background run renders its notifications here, from the locale catalogs (`build.rs`), and
//! hands the native side a list ready to post (Ruling 10): sender and subject, or "New message"
//! and the account when previews are off; one per message up to five, the rest in one summary.
//!
//! A tap on a notification comes back as `{accountId, folder, uid?}`: held here (the latest wins),
//! announced to the page as `mobile.notification.open`, and taken by the page with
//! `mobile_notification_take`, which also covers a cold launch whose tap came before the page.

use mailvault_mobile_engine::{events::NOTIFICATION_OPEN, Engine, NewMail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

include!(concat!(env!("OUT_DIR"), "/notify_strings.rs"));

/// The engine, or why it failed to open. Set once per process.
static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();
/// Wakes callers of [`wait_engine`] when [`ENGINE`] is set.
static OPENED: (Mutex<()>, Condvar) = (Mutex::new(()), Condvar::new());

/// The engine of this process: `open` runs only when no engine is open yet (and at most once,
/// whoever calls first; a second caller waits for the first one's open).
pub(crate) fn engine_with(data: &Path, cache: &Path, open: impl FnOnce(&Path, &Path) -> Result<Engine, String>) -> &'static Result<Engine, String> {
    let engine = ENGINE.get_or_init(|| open(data, cache));
    let _guard = OPENED.0.lock().unwrap_or_else(|e| e.into_inner());
    OPENED.1.notify_all();
    engine
}

/// Records why the engine cannot open (setup could not name its directories), unless one is open.
pub(crate) fn engine_failed(reason: String) -> &'static Result<Engine, String> {
    let engine = ENGINE.get_or_init(|| Err(reason));
    let _guard = OPENED.0.lock().unwrap_or_else(|e| e.into_inner());
    OPENED.1.notify_all();
    engine
}

/// The engine if one is open (or failed to), without waiting.
#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn opened() -> Option<&'static Result<Engine, String>> {
    ENGINE.get()
}

/// The engine, waiting up to `max` for whoever is opening it (the page can call before setup has
/// opened it: on Android the webview loads while setup runs). Call it off the async runtime.
pub(crate) fn wait_engine(max: Duration) -> Result<&'static Engine, String> {
    let deadline = Instant::now() + max;
    let mut guard = OPENED.0.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if let Some(engine) = ENGINE.get() {
            return engine.as_ref().map_err(Clone::clone);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("the engine is still starting".into());
        }
        guard = OPENED.1.wait_timeout(guard, left).unwrap_or_else(|e| e.into_inner()).0;
    }
}

/// Opens the engine with the platform secret store, as both setup and a background run do: the
/// engine's log lines go to the platform log, and the one-time keychain policy move runs before
/// anything can read a secret.
pub(crate) fn open_platform(data: &Path, cache: &Path) -> Result<Engine, String> {
    let secrets = std::sync::Arc::new(crate::secrets::KeyringSecrets::new());
    if let Some(reason) = secrets.error() {
        crate::log_line(&format!("MV_MOBILE {}", json!({ "secretsError": reason })));
    }
    let engine = Engine::open(data, cache, secrets.clone()).map_err(|e| e.to_string())?;
    engine.set_log_sink(crate::log_line);
    crate::migrate_secrets(&engine, &secrets);
    Ok(engine)
}

/// The engine for a background entry point, opened here when `setup` has not opened it (an iOS
/// background launch before the app's scene, an Android worker with no activity).
pub fn engine_for_background(data: &Path, cache: &Path) -> Result<&'static Engine, String> {
    engine_with(data, cache, open_platform).as_ref().map_err(Clone::clone)
}

// ── Notifications ───────────────────────────────────────────────────────────

/// Individual notifications per run; more new mail than this goes in one summary.
const MAX_SINGLE: usize = 5;

/// The nine app languages, as `src/mobile/i18n.js` `pickLocale` maps the system's.
fn pick_locale(languages: &[String]) -> &'static str {
    for tag in languages {
        let base = tag.to_ascii_lowercase();
        let base = base.split(['-', '_']).next().unwrap_or("");
        match base {
            "pt" => return "pt-BR",
            "zh" => return "zh-Hans",
            "en" | "es" | "fr" | "it" | "de" | "ja" | "ko" => {
                return NOTIFY_STRINGS.iter().find(|(l, _)| *l == base).map(|(l, _)| *l).unwrap_or("en");
            }
            _ => {}
        }
    }
    "en"
}

/// `key` in `locale`, English when that catalog lacks it.
fn text(locale: &str, key: &str) -> &'static str {
    let find = |l: &str| NOTIFY_STRINGS.iter().find(|(c, _)| *c == l).and_then(|(_, keys)| keys.iter().find(|(k, _)| *k == key)).map(|(_, v)| *v);
    find(locale).or_else(|| find("en")).unwrap_or("")
}

/// One notification, ready to post. `id` is stable per message (a repeat replaces, never doubles).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub account_id: String,
    pub folder: String,
    /// `None` for the summary: its tap opens the folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
}

/// What the native side posts for `mail` (oldest first): the newest [`MAX_SINGLE`] one by one,
/// and the rest, if any, as one "N new messages". With previews off a message shows only "New
/// message" and its account.
pub(crate) fn render(mail: &[NewMail], preview: bool, locale: &str) -> Vec<Note> {
    let split = mail.len().saturating_sub(MAX_SINGLE);
    let (rest, singles) = mail.split_at(split);
    let mut notes: Vec<Note> = Vec::with_capacity(singles.len() + 1);
    if let Some(newest) = rest.last() {
        let one_account = rest.iter().all(|m| m.account_id == newest.account_id);
        let key = if rest.len() == 1 { "mobile.notify.summary_one" } else { "mobile.notify.summary_other" };
        notes.push(Note {
            id: format!("summary/{}/{}/{}", newest.account_id, newest.folder, newest.uid),
            title: text(locale, key).replace("{{count}}", &rest.len().to_string()),
            body: if one_account { newest.account_email.clone() } else { String::new() },
            account_id: newest.account_id.clone(),
            folder: newest.folder.clone(),
            uid: None,
        });
    }
    for m in singles {
        let (title, body) = if preview {
            let subject = if m.subject.trim().is_empty() { text(locale, "common.noSubject").to_string() } else { m.subject.clone() };
            (m.from.clone(), subject)
        } else {
            (text(locale, "mobile.notify.newMessage").to_string(), m.account_email.clone())
        };
        notes.push(Note {
            id: format!("{}/{}/{}", m.account_id, m.folder, m.uid),
            title,
            body,
            account_id: m.account_id.clone(),
            folder: m.folder.clone(),
            uid: Some(m.uid),
        });
    }
    notes
}

/// The system languages the native side last reported, most preferred first.
static LANGUAGES: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn locale() -> &'static str {
    pick_locale(&LANGUAGES.lock().unwrap_or_else(|e| e.into_inner()))
}

/// One background run on the process's engine; the JSON the native side posts from:
/// `{channel, notes: [Note]}` (`channel`: the Android channel's name). A failure is logged and
/// answers no notes.
pub(crate) fn run_json(data: &Path, cache: &Path, budget: Duration) -> String {
    // A worker process never ran `run()`.
    crate::perf_gate_env();
    let locale = locale();
    let notes = match engine_for_background(data, cache) {
        Ok(engine) => match engine.background_fetch(budget) {
            Ok(mail) => {
                let notes = render(&mail, engine.notification_preview(), locale);
                let mut line = json!({ "background": { "new": mail.len(), "notes": notes.len() } });
                // Perf-gate builds: what each tap would open (ids only), for the device check.
                if cfg!(feature = "perf-gate") {
                    line["background"]["taps"] = notes.iter().map(|n| json!({ "accountId": n.account_id, "folder": n.folder, "uid": n.uid })).collect();
                }
                crate::log_line(&format!("MV_MOBILE {line}"));
                notes
            }
            Err(e) => {
                crate::log_line(&format!("MV_MOBILE {}", json!({ "backgroundError": e.to_string() })));
                Vec::new()
            }
        },
        Err(reason) => {
            crate::log_line(&format!("MV_MOBILE {}", json!({ "backgroundError": reason })));
            Vec::new()
        }
    };
    json!({ "channel": text(locale, "mobile.notify.channel"), "notes": notes }).to_string()
}

// ── Taps ────────────────────────────────────────────────────────────────────

/// What a tap opens. Nothing here is trusted: the page checks the account and folder exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tap {
    pub account_id: String,
    pub folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
}

/// The last tap the page has not taken.
static TAP: Mutex<Option<Tap>> = Mutex::new(None);
/// Where a tap is announced, once setup has run.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub(crate) fn set_app(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// The native side reports a tap (`json` as posted in the notification). Held (the latest wins)
/// and announced to the page if it exists yet.
pub(crate) fn tapped(json: &str) {
    let Ok(tap) = serde_json::from_str::<Tap>(json) else {
        crate::log_line(&format!("MV_MOBILE {}", json!({ "notificationTap": "unreadable" })));
        return;
    };
    *TAP.lock().unwrap_or_else(|e| e.into_inner()) = Some(tap.clone());
    if let Some(app) = APP.get() {
        let _ = app.emit("mobile-event", json!({ "name": NOTIFICATION_OPEN, "payload": tap }));
    }
}

/// Takes the held tap, if any: each tap is opened once, by the event or by the page's take on
/// mount, whichever reads it first.
pub(crate) fn take_tap() -> Option<Tap> {
    TAP.lock().unwrap_or_else(|e| e.into_inner()).take()
}

// ── iOS entry points (Background.swift) ────────────────────────────────────

/// Tauri's `app_data_dir` / `app_cache_dir` on iOS, computed without an app handle: dirs'
/// `data_dir()` / `cache_dir()` (`$HOME/Library/Application Support`, `$HOME/Library/Caches`)
/// joined with the bundle identifier (tauri 2.12 `src/path/desktop.rs` `app_data_dir` and
/// `app_cache_dir`). Setup logs a mismatch with its own (`check_dirs`).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn ios_dirs() -> Option<(PathBuf, PathBuf)> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let library = home.join("Library");
    Some((library.join("Application Support").join(IDENTIFIER), library.join("Caches").join(IDENTIFIER)))
}

/// `identifier` in tauri.conf.json.
const IDENTIFIER: &str = "com.mailvault.app";

/// Setup's own directories against what a background entry point computes; a mismatch would
/// make a background run open an empty `mobile.db`, so it is logged.
pub(crate) fn check_dirs(data: &Path, cache: &Path) {
    #[cfg(target_os = "ios")]
    if ios_dirs().as_ref().map(|(d, c)| (d.as_path(), c.as_path())) != Some((data, cache)) {
        crate::log_line(&format!("MV_MOBILE {}", json!({ "backgroundDirsMismatch": true })));
    }
    let _ = (data, cache);
}

/// Runs `f` and turns a panic into `fallback`: unwinding across the C or JNI boundary aborts.
fn guarded<T>(fallback: T, f: impl FnOnce() -> T) -> T {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or(fallback)
}

fn c_string(s: String) -> *mut std::ffi::c_char {
    std::ffi::CString::new(s.replace('\0', " ")).unwrap_or_default().into_raw()
}

/// iOS `BGAppRefreshTask`: one run inside `budget_ms`. Returns `{channel, notes}` JSON, freed with
/// [`mv_free_string`]. Blocks: call it off the main thread.
#[no_mangle]
pub extern "C" fn mv_background_fetch(budget_ms: u32) -> *mut std::ffi::c_char {
    c_string(guarded(r#"{"channel":"","notes":[]}"#.to_string(), || match ios_dirs() {
        Some((data, cache)) => run_json(&data, &cache, Duration::from_millis(u64::from(budget_ms))),
        None => {
            crate::log_line(&format!("MV_MOBILE {}", json!({ "backgroundError": "no HOME" })));
            r#"{"channel":"","notes":[]}"#.to_string()
        }
    }))
}

/// Frees a string [`mv_background_fetch`] returned.
///
/// # Safety
/// `s` is null or a pointer `mv_background_fetch` returned, freed once.
#[no_mangle]
pub unsafe extern "C" fn mv_free_string(s: *mut std::ffi::c_char) {
    if !s.is_null() {
        // SAFETY: the caller hands back a pointer CString::into_raw made, once.
        drop(unsafe { std::ffi::CString::from_raw(s) });
    }
}

/// iOS: a notification was tapped; `json` is its payload `{accountId, folder, uid?}`.
///
/// # Safety
/// `json` is null or a NUL-terminated string that outlives the call.
#[no_mangle]
pub unsafe extern "C" fn mv_notification_tapped(json: *const std::ffi::c_char) {
    if json.is_null() {
        return;
    }
    // SAFETY: a NUL-terminated string the caller keeps alive for the call.
    let text = unsafe { std::ffi::CStr::from_ptr(json) }.to_string_lossy().into_owned();
    guarded((), || tapped(&text));
}

/// iOS: the system languages, most preferred first, comma separated (`Locale.preferredLanguages`).
///
/// # Safety
/// `csv` is null or a NUL-terminated string that outlives the call.
#[no_mangle]
pub unsafe extern "C" fn mv_set_languages(csv: *const std::ffi::c_char) {
    if csv.is_null() {
        return;
    }
    // SAFETY: a NUL-terminated string the caller keeps alive for the call.
    let text = unsafe { std::ffi::CStr::from_ptr(csv) }.to_string_lossy().into_owned();
    set_languages(text.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect());
}

pub(crate) fn set_languages(languages: Vec<String>) {
    *LANGUAGES.lock().unwrap_or_else(|e| e.into_inner()) = languages;
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_mobile_engine::MemorySecrets;
    use serde_json::Value;
    use std::sync::Arc;

    fn mail(n: u32, account: &str) -> NewMail {
        NewMail {
            account_id: account.into(),
            account_email: format!("{account}@example.test"),
            folder: "INBOX".into(),
            uid: n,
            from: format!("Sender {n}"),
            subject: format!("Subject {n}"),
            date_ms: i64::from(n),
        }
    }

    #[test]
    fn background_fetch_shares_an_engine_already_open_in_the_process() {
        let setup_dir = tempfile::tempdir().unwrap();
        let other_dir = tempfile::tempdir().unwrap();
        let mut opens = 0;
        // What setup does: the process's engine, opened here.
        let from_setup = engine_with(setup_dir.path(), &setup_dir.path().join("cache"), |d, c| {
            opens += 1;
            Engine::open(d, c, Arc::new(MemorySecrets::default())).map_err(|e| e.to_string())
        });
        let from_setup = from_setup.as_ref().expect("setup opened the engine");
        // A background entry point in the same process gets that engine, never a second writer
        // (its own dirs and secret store are not used).
        let from_background = engine_for_background(other_dir.path(), &other_dir.path().join("cache")).expect("the open engine");
        assert!(std::ptr::eq(from_setup, from_background), "a second engine was opened");
        assert_eq!(opens, 1);
        assert!(!other_dir.path().join("mobile.db").exists(), "the background path opened its own mobile.db");
        assert!(std::ptr::eq(wait_engine(Duration::ZERO).unwrap(), from_setup));
        // And a run on it answers (notifications are off by default: nothing to post).
        let out: Value = serde_json::from_str(&run_json(other_dir.path(), other_dir.path(), Duration::from_secs(1))).unwrap();
        assert_eq!(out["notes"], json!([]));
        assert_eq!(out["channel"], "New mail");
    }

    #[test]
    fn five_single_notifications_then_one_summary() {
        let few: Vec<NewMail> = (1..=3).map(|n| mail(n, "a")).collect();
        let notes = render(&few, true, "en");
        assert_eq!(notes.iter().map(|n| (n.title.as_str(), n.body.as_str(), n.uid)).collect::<Vec<_>>(), vec![
            ("Sender 1", "Subject 1", Some(1)),
            ("Sender 2", "Subject 2", Some(2)),
            ("Sender 3", "Subject 3", Some(3)),
        ]);
        let many: Vec<NewMail> = (1..=8).map(|n| mail(n, "a")).collect();
        let notes = render(&many, true, "en");
        assert_eq!(notes.len(), 6);
        assert_eq!((notes[0].title.as_str(), notes[0].body.as_str(), notes[0].uid), ("3 new messages", "a@example.test", None));
        assert_eq!(notes[1..].iter().map(|n| n.uid.unwrap()).collect::<Vec<_>>(), vec![4, 5, 6, 7, 8], "the newest five");
        let six: Vec<NewMail> = (1..=6).map(|n| mail(n, "a")).collect();
        assert_eq!(render(&six, true, "en")[0].title, "1 new message");
        let mixed: Vec<NewMail> = (1..=7).map(|n| mail(n, if n == 1 { "a" } else { "b" })).collect();
        assert_eq!(render(&mixed, true, "en")[0].body, "", "a summary over two accounts names none");
    }

    #[test]
    fn previews_off_show_only_new_message_and_the_account() {
        let notes = render(&[mail(7, "a")], false, "de");
        assert_eq!((notes[0].title.as_str(), notes[0].body.as_str()), ("Neue Nachricht", "a@example.test"));
        let mut blank = mail(8, "a");
        blank.subject = "  ".into();
        assert_eq!(render(&[blank], true, "fr")[0].body, "(Sans objet)");
        assert_eq!(text("ja", "mobile.notify.summary_other").replace("{{count}}", "9"), "9 件の新着メッセージ");
    }

    #[test]
    fn the_locale_follows_the_system_languages_like_the_page() {
        let l = |tags: &[&str]| pick_locale(&tags.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(l(&["de-AT"]), "de");
        assert_eq!(l(&["pt-PT"]), "pt-BR");
        assert_eq!(l(&["zh-Hant-TW", "ja-JP"]), "zh-Hans");
        assert_eq!(l(&["sv-SE", "fr-CA"]), "fr");
        assert_eq!(l(&["sv-SE"]), "en");
        assert_eq!(l(&[]), "en");
        assert_eq!(l(&["KO"]), "ko");
        for (locale, keys) in NOTIFY_STRINGS {
            assert_eq!(keys.len(), 5, "{locale} lacks a notification string");
        }
    }

    #[test]
    fn a_tap_is_taken_once_and_the_latest_wins() {
        tapped(r#"{"accountId":"a","folder":"INBOX","uid":3}"#);
        tapped(r#"{"accountId":"b","folder":"INBOX","uid":9}"#);
        tapped("not json");
        assert_eq!(take_tap(), Some(Tap { account_id: "b".into(), folder: "INBOX".into(), uid: Some(9) }));
        assert_eq!(take_tap(), None);
        tapped(r#"{"accountId":"a","folder":"INBOX"}"#);
        assert_eq!(serde_json::to_value(take_tap().unwrap()).unwrap(), json!({ "accountId": "a", "folder": "INBOX" }));
    }
}
