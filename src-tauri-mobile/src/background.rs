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

use mailvault_mobile_engine::{events::NOTIFICATION_OPEN, Engine, FollowUpDue, NewMail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

include!(concat!(env!("OUT_DIR"), "/notify_strings.rs"));

/// The process's one engine (Ruling 12). Only an engine that opened is kept: a failed open (a
/// background launch before the first unlock, a full disk) is reported to its caller and the
/// next caller tries again, so a foreground start after a failed background run still opens.
/// Opens are one at a time, so two engines never coexist.
///
/// When setup's own open failed (an iOS background launch runs setup first, before the first
/// unlock), setup leaves its [`Reopen`]: the page's calls try it again, at most once per
/// [`REOPEN_EVERY`] and one attempt for all callers at a time, and any later open (a background
/// run's too) prepares the engine as setup would before it is published.
pub(crate) struct EngineCell {
    engine: OnceLock<Engine>,
    /// Held across an open: a second opener waits for the first one's result.
    opening: Mutex<()>,
    /// Setup's failure, while no open has worked.
    state: Mutex<Option<Failed>>,
    cv: Condvar,
    every: Duration,
}

/// How the page's calls reopen the engine after setup could not open it: `open` names the
/// directories again (they may be what failed) and opens; `prepare` runs on every engine opened
/// from then on before it is published (the event sink, the perf seed), whoever opened it.
pub(crate) struct Reopen {
    pub open: Box<dyn Fn() -> Result<(PathBuf, PathBuf), String> + Send + Sync>,
    pub engine: Box<dyn Fn(&Path, &Path) -> Result<Engine, String> + Send + Sync>,
    pub prepare: Box<dyn Fn(&Engine) + Send + Sync>,
}

struct Failed {
    reason: String,
    reopen: Option<std::sync::Arc<Reopen>>,
    /// When the last open (setup's, or a page call's retry) ended.
    tried: Instant,
    /// A page call is opening now: the others wait for its result.
    trying: bool,
}

/// The page's calls retry a failed setup open at most this often.
pub(crate) const REOPEN_EVERY: Duration = Duration::from_secs(2);

impl EngineCell {
    pub(crate) const fn new() -> EngineCell {
        EngineCell::retrying_every(REOPEN_EVERY)
    }

    pub(crate) const fn retrying_every(every: Duration) -> EngineCell {
        EngineCell { engine: OnceLock::new(), opening: Mutex::new(()), state: Mutex::new(None), cv: Condvar::new(), every }
    }

    /// The engine: the open one, else `open` (one opener at a time). A failure is not kept.
    pub(crate) fn get_or_open(&self, data: &Path, cache: &Path, open: impl FnOnce(&Path, &Path) -> Result<Engine, String>) -> Result<&Engine, String> {
        if let Some(e) = self.engine.get() {
            return Ok(e);
        }
        let _one = self.opening.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = self.engine.get() {
            return Ok(e);
        }
        // Read under `opening`: setup's failure is recorded under it too, so an open either
        // finds its hook here or was published before setup looked.
        let prepare = self.state.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|f| f.reopen.clone());
        let out = match open(data, cache) {
            Ok(engine) => {
                if let Some(reopen) = &prepare {
                    (reopen.prepare)(&engine);
                }
                let _ = self.engine.set(engine);
                *self.state.lock().unwrap_or_else(|e| e.into_inner()) = None;
                Ok(self.engine.get().expect("set just now"))
            }
            Err(reason) => Err(reason),
        };
        self.cv.notify_all();
        out
    }

    /// Setup could not open the engine (or name its directories): the page's calls report
    /// `reason`, and retry with `reopen` (when given) until some open works. An engine another
    /// caller opened meanwhile is prepared now.
    pub(crate) fn setup_failed(&self, reason: String, reopen: Option<Reopen>) {
        let _one = self.opening.lock().unwrap_or_else(|e| e.into_inner());
        match self.engine.get() {
            Some(engine) => {
                if let Some(reopen) = &reopen {
                    (reopen.prepare)(engine);
                }
            }
            None => {
                *self.state.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(Failed { reason, reopen: reopen.map(std::sync::Arc::new), tried: Instant::now(), trying: false });
            }
        }
        self.cv.notify_all();
    }

    /// The engine if one is open, without waiting.
    pub(crate) fn opened(&self) -> Option<&Engine> {
        self.engine.get()
    }

    /// The engine, waiting up to `max` for whoever is opening it (the page can call before setup
    /// has opened it: on Android the webview loads while setup runs). After setup's failure a
    /// call opens again once the last attempt is [`REOPEN_EVERY`] old (callers meanwhile share
    /// that attempt); otherwise it answers the latest reason at once. Call it off the async
    /// runtime.
    pub(crate) fn wait(&self, max: Duration) -> Result<&Engine, String> {
        let deadline = Instant::now() + max;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(engine) = self.engine.get() {
                return Ok(engine);
            }
            match state.as_mut() {
                Some(f) if f.trying => {}
                Some(f) => {
                    let Some(reopen) = f.reopen.clone().filter(|_| f.tried.elapsed() >= self.every) else {
                        return Err(f.reason.clone());
                    };
                    f.trying = true;
                    drop(state);
                    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let (data, cache) = (reopen.open)()?;
                        self.get_or_open(&data, &cache, |d, c| (reopen.engine)(d, c)).map(|_| ())
                    }))
                    .unwrap_or_else(|_| Err("the engine open panicked".into()));
                    state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(f) = state.as_mut() {
                        f.trying = false;
                        f.tried = Instant::now();
                        if let Err(reason) = out {
                            f.reason = reason;
                        }
                    }
                    self.cv.notify_all();
                    continue;
                }
                None => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("the engine is still starting".into());
            }
            state = self.cv.wait_timeout(state, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

static ENGINE: EngineCell = EngineCell::new();

/// The engine of this process: `open` runs only when no engine is open yet (one opener at a time;
/// a second caller waits for the first one's open, and tries itself if that one failed).
pub(crate) fn engine_with(data: &Path, cache: &Path, open: impl FnOnce(&Path, &Path) -> Result<Engine, String>) -> Result<&'static Engine, String> {
    ENGINE.get_or_open(data, cache, open)
}

/// Records why setup cannot open the engine, unless one is open, and how the page's calls open
/// it again (see [`EngineCell::wait`]).
pub(crate) fn engine_failed(reason: String, reopen: Option<Reopen>) {
    ENGINE.setup_failed(reason, reopen);
}

/// The engine if one is open, without waiting.
#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn opened() -> Option<&'static Engine> {
    ENGINE.opened()
}

/// See [`EngineCell::wait`].
pub(crate) fn wait_engine(max: Duration) -> Result<&'static Engine, String> {
    ENGINE.wait(max)
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
    engine_with(data, cache, open_platform)
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

/// A notification id for message identity `key`: the same message always gets the same id, so a
/// repost (a run whose commit was lost) replaces it, whatever uid it has now.
fn note_id(account: &str, key: &str) -> String {
    // FNV-1a: stable across builds and runs, unlike the std hasher.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{account}/{h:016x}")
}

/// What the native side posts for `mail` (oldest first): the newest [`MAX_SINGLE`] one by one,
/// and the rest, if any, as one "N new messages" per account. A summary has one fixed id per
/// account, so a later one replaces it rather than stacking, and its tap opens that account's
/// INBOX. With previews off a message shows only "New message" and its account.
pub(crate) fn render(mail: &[NewMail], preview: bool, locale: &str) -> Vec<Note> {
    let split = mail.len().saturating_sub(MAX_SINGLE);
    let (rest, singles) = mail.split_at(split);
    let mut notes: Vec<Note> = Vec::with_capacity(singles.len() + 1);
    let mut accounts: Vec<&str> = Vec::new();
    for m in rest {
        if !accounts.contains(&m.account_id.as_str()) {
            accounts.push(&m.account_id);
        }
    }
    for account in accounts {
        let of: Vec<&NewMail> = rest.iter().filter(|m| m.account_id == account).collect();
        let newest = of.last().expect("an account of `rest` has mail in it");
        let key = if of.len() == 1 { "mobile.notify.summary_one" } else { "mobile.notify.summary_other" };
        notes.push(Note {
            id: format!("summary/{account}"),
            title: text(locale, key).replace("{{count}}", &of.len().to_string()),
            body: newest.account_email.clone(),
            account_id: account.to_string(),
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
            id: note_id(&m.account_id, if m.key.is_empty() { &m.subject } else { &m.key }),
            title,
            body,
            account_id: m.account_id.clone(),
            folder: m.folder.clone(),
            uid: Some(m.uid),
        });
    }
    notes
}

/// What the native side posts for follow-up reminders that found no reply: one each, "No reply
/// yet" over the subject (the account with previews off), whose tap opens the Sent copy. The id
/// is per reminder, so a repost (a run whose commit was lost) replaces it.
pub(crate) fn render_followups(due: &[FollowUpDue], preview: bool, locale: &str) -> Vec<Note> {
    due.iter()
        .map(|f| {
            let body = if !preview {
                f.account_email.clone()
            } else if f.subject.trim().is_empty() {
                text(locale, "common.noSubject").to_string()
            } else {
                f.subject.clone()
            };
            Note {
                id: format!("followup/{}", f.id),
                title: text(locale, "followUp.notifyTitle").to_string(),
                body,
                account_id: f.account_id.clone(),
                folder: f.folder.clone(),
                uid: Some(f.uid),
            }
        })
        .collect()
}

/// The system languages the native side last reported, most preferred first.
static LANGUAGES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The notifications' language: the one picked in the app (engine setting `language`, one of the
/// nine) over the system's, as the page picks it (`src/mobile/i18n.js` `loadMobileLocale`).
fn notify_locale(stored: Option<&str>, languages: &[String]) -> &'static str {
    match stored.and_then(|code| NOTIFY_STRINGS.iter().find(|(l, _)| *l == code)) {
        Some((l, _)) => l,
        None => pick_locale(languages),
    }
}

/// One background run on the process's engine; the JSON the native side posts from:
/// `{channel, notes: [Note], commit?}` (`channel`: the Android channel's name). Once the notes are
/// posted the native side hands `commit` back ([`commit`]); a run whose commit never comes (the
/// OS ended the task first) returns the same mail next time. `budget` counts from the call, so
/// opening the engine (a cold background launch) is inside it. A failure is logged and answers
/// no notes.
pub(crate) fn run_json(data: &Path, cache: &Path, budget: Duration, started: Instant) -> String {
    // A worker process never ran `run()`.
    crate::perf_gate_env();
    let system_languages = LANGUAGES.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut locale = notify_locale(None, &system_languages);
    let mut token = None;
    let notes = match engine_for_background(data, cache) {
        Ok(engine) => match engine.background_fetch(budget.saturating_sub(started.elapsed())) {
            Ok(run) => {
                let stored = engine.setting("language").ok().flatten();
                locale = notify_locale(stored.as_deref(), &system_languages);
                token = run.commit;
                let mail = run.mail;
                let preview = engine.notification_preview();
                let mut notes = render(&mail, preview, locale);
                notes.extend(render_followups(&run.followups, preview, locale));
                let mut line = json!({ "background": { "new": mail.len(), "followUps": run.followups.len(), "notes": notes.len() } });
                // Perf-gate builds: what each tap would open (ids only), for the device check.
                if cfg!(feature = "perf-gate") {
                    line["background"]["taps"] = notes.iter().map(|n| json!({ "accountId": n.account_id, "folder": n.folder, "uid": n.uid })).collect();
                }
                crate::log_line(&format!("MV_MOBILE {line}"));
                // The run may have sent the last scheduled message: the OS's background refresh
                // follows what the engine wants now (a worker process that never ran setup has
                // no app handle; its next run returns at once and the app re-applies on open).
                if let Some(app) = APP.get() {
                    crate::apply_background(app, engine);
                }
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
    let mut reply = json!({ "channel": text(locale, "mobile.notify.channel"), "notes": notes });
    if let Some(t) = token {
        reply["commit"] = json!(t);
    }
    reply.to_string()
}

/// The native side posted the notes of the run that answered `token`: their mail counts as
/// notified now. Nothing when no engine is open (the process was restarted: the token is stale).
pub(crate) fn commit(token: &str) {
    let Some(engine) = opened() else { return };
    if let Err(e) = engine.background_commit(token) {
        crate::log_line(&format!("MV_MOBILE {}", json!({ "backgroundCommitError": e.to_string() })));
    }
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
    crate::log_line(&format!("MV_MOBILE {}", json!({ "notificationTap": { "held": true, "announced": APP.get().is_some() } })));
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
pub(crate) fn guarded<T>(fallback: T, f: impl FnOnce() -> T) -> T {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or(fallback)
}

pub(crate) fn c_string(s: String) -> *mut std::ffi::c_char {
    std::ffi::CString::new(s.replace('\0', " ")).unwrap_or_default().into_raw()
}

/// iOS `BGAppRefreshTask`: one run inside `budget_ms`, counted from this call. Returns
/// `{channel, notes, commit?}` JSON, freed with [`mv_free_string`]; post the notes, then hand
/// `commit` to [`mv_background_commit`]. Blocks: call it off the main thread.
#[no_mangle]
pub extern "C" fn mv_background_fetch(budget_ms: u32) -> *mut std::ffi::c_char {
    let started = Instant::now();
    c_string(guarded(r#"{"channel":"","notes":[]}"#.to_string(), || match ios_dirs() {
        Some((data, cache)) => run_json(&data, &cache, Duration::from_millis(u64::from(budget_ms)), started),
        None => {
            crate::log_line(&format!("MV_MOBILE {}", json!({ "backgroundError": "no HOME" })));
            r#"{"channel":"","notes":[]}"#.to_string()
        }
    }))
}

/// iOS: the notifications of the run that answered `token` were posted ([`commit`]).
///
/// # Safety
/// `token` is null or a NUL-terminated string that outlives the call.
#[no_mangle]
pub unsafe extern "C" fn mv_background_commit(token: *const std::ffi::c_char) {
    if token.is_null() {
        return;
    }
    // SAFETY: a NUL-terminated string the caller keeps alive for the call.
    let text = unsafe { std::ffi::CStr::from_ptr(token) }.to_string_lossy().into_owned();
    guarded((), || commit(&text));
}

/// iOS, perf-gate builds only: the device check's way to start a run with no `BGTask` (the
/// simulator launches none). Background.swift hands its run-now function over at registration;
/// a shipping build keeps nothing, so nothing outside the OS's own task can start a run.
#[no_mangle]
pub extern "C" fn mv_set_device_check_runner(runner: Option<extern "C" fn()>) {
    #[cfg(feature = "perf-gate")]
    {
        *RUNNER.lock().unwrap_or_else(|e| e.into_inner()) = runner;
    }
    #[cfg(not(feature = "perf-gate"))]
    let _ = runner;
}

#[cfg(feature = "perf-gate")]
static RUNNER: Mutex<Option<extern "C" fn()>> = Mutex::new(None);

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

/// Perf-gate iOS builds only: the device check's trigger, since the simulator launches no
/// background task and lldb cannot attach from an ssh session. A file `device-check-run` in the
/// cache dir starts the same run a `BGAppRefreshTask` does (`mv_ios_background_run_now`), and
/// `device-check-tap` (a payload JSON) is handed over as a notification tap.
#[cfg(all(feature = "perf-gate", target_os = "ios"))]
pub(crate) fn watch_device_check(cache: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if std::fs::remove_file(cache.join("device-check-run")).is_ok() {
            let runner = *RUNNER.lock().unwrap_or_else(|e| e.into_inner());
            match runner {
                Some(run) => run(),
                None => crate::log_line(&format!("MV_MOBILE {}", json!({ "deviceCheck": "no runner" }))),
            }
        }
        let tap = cache.join("device-check-tap");
        if let Ok(text) = std::fs::read_to_string(&tap) {
            let _ = std::fs::remove_file(&tap);
            tapped(text.trim());
        }
    });
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
            key: format!("mid:<{n}@example.test>"),
        }
    }

    /// A follow-up reminder's note says "No reply yet" over the subject, or the account with
    /// previews off, and its tap opens the Sent copy.
    #[test]
    fn a_follow_up_note_names_the_message_and_opens_the_sent_copy() {
        let due = FollowUpDue {
            id: "fu_1".into(),
            account_id: "a".into(),
            account_email: "a@example.test".into(),
            folder: "Sent".into(),
            uid: 9,
            subject: "Quote".into(),
            recipients: "bob@example.test".into(),
        };
        let notes = render_followups(std::slice::from_ref(&due), true, "en");
        assert_eq!(notes.len(), 1);
        assert_eq!((notes[0].id.as_str(), notes[0].body.as_str(), notes[0].folder.as_str(), notes[0].uid), ("followup/fu_1", "Quote", "Sent", Some(9)));
        assert!(!notes[0].title.is_empty(), "the title comes from the catalog");
        assert_eq!(render_followups(&[due], false, "en")[0].body, "a@example.test");
    }

    /// A failed open is not kept: the next caller (setup after a failed background launch)
    /// opens it, and only one engine is ever kept.
    #[test]
    fn a_failed_open_is_not_cached_and_the_next_caller_opens() {
        let cell = EngineCell::new();
        let dir = tempfile::tempdir().unwrap();
        let first = cell.get_or_open(dir.path(), &dir.path().join("cache"), |_, _| Err("keychain locked".into()));
        assert_eq!(first.err().as_deref(), Some("keychain locked"));
        assert!(cell.opened().is_none());
        assert_eq!(cell.wait(Duration::ZERO).err().as_deref(), Some("the engine is still starting"), "a background failure is no answer for the page");
        let mut opens = 0;
        let second = cell
            .get_or_open(dir.path(), &dir.path().join("cache"), |d, c| {
                opens += 1;
                Engine::open(d, c, Arc::new(MemorySecrets::default())).map_err(|e| e.to_string())
            })
            .expect("the next open works");
        let third = cell.get_or_open(dir.path(), &dir.path().join("cache"), |_, _| panic!("never a second engine")).unwrap();
        assert!(std::ptr::eq(second, third));
        assert_eq!(opens, 1);
        assert!(std::ptr::eq(cell.wait(Duration::ZERO).unwrap(), second));
        // Setup's own failure with no way to open again stays the page's answer.
        let failed = EngineCell::new();
        failed.setup_failed("app data dir: none".into(), None);
        assert_eq!(failed.wait(Duration::from_secs(5)).err().as_deref(), Some("app data dir: none"));
    }

    fn opener(fails: usize, opens: Arc<std::sync::atomic::AtomicUsize>, pause: Duration) -> Box<dyn Fn(&Path, &Path) -> Result<Engine, String> + Send + Sync> {
        use std::sync::atomic::Ordering::SeqCst;
        Box::new(move |d, c| {
            let n = opens.fetch_add(1, SeqCst);
            std::thread::sleep(pause);
            if n < fails {
                return Err(format!("file protection {n}"));
            }
            Engine::open(d, c, Arc::new(MemorySecrets::default())).map_err(|e| e.to_string())
        })
    }

    /// After setup's open failed (an iOS background launch before the first unlock), the page's
    /// calls open again once the last attempt is old enough, and the engine they publish
    /// already has setup's sink; an engine a background run opens meanwhile gets it too.
    #[test]
    fn a_failed_setup_open_is_retried_by_the_page_and_published_with_its_sink() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
        static CELL: EngineCell = EngineCell::retrying_every(Duration::from_millis(200));
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_path_buf();
        let opens = Arc::new(AtomicUsize::new(0));
        let prepared = Arc::new(AtomicBool::new(false));
        let p = Arc::clone(&prepared);
        CELL.setup_failed(
            "keychain locked".into(),
            Some(Reopen {
                open: Box::new(move || Ok((data.clone(), data.join("cache")))),
                engine: opener(1, Arc::clone(&opens), Duration::ZERO),
                prepare: Box::new(move |engine| {
                    assert!(CELL.opened().is_none(), "prepared after it was published");
                    assert!(engine.set_event_sink(|_, _| {}));
                    p.store(true, SeqCst);
                }),
            }),
        );
        // Setup just tried: its reason, no new open.
        assert_eq!(CELL.wait(Duration::from_secs(5)).err().as_deref(), Some("keychain locked"));
        assert_eq!(opens.load(SeqCst), 0);
        std::thread::sleep(Duration::from_millis(250));
        // The first retry fails too: its reason is the answer now, until the next interval.
        assert_eq!(CELL.wait(Duration::from_secs(5)).err().as_deref(), Some("file protection 0"));
        assert_eq!(CELL.wait(Duration::from_secs(5)).err().as_deref(), Some("file protection 0"));
        assert_eq!(opens.load(SeqCst), 1);
        std::thread::sleep(Duration::from_millis(250));
        let engine = CELL.wait(Duration::from_secs(5)).expect("the retry opens");
        assert_eq!(opens.load(SeqCst), 2);
        assert!(prepared.load(SeqCst), "setup's sink went in before the engine was published");
        assert!(!engine.set_event_sink(|_, _| {}));
        assert!(std::ptr::eq(CELL.wait(Duration::ZERO).unwrap(), engine));

        // A background run that opens first after setup failed publishes a prepared engine too.
        static OTHER: EngineCell = EngineCell::retrying_every(Duration::from_secs(60));
        let other = tempfile::tempdir().unwrap();
        let sunk = Arc::new(AtomicBool::new(false));
        let s = Arc::clone(&sunk);
        OTHER.setup_failed(
            "keychain locked".into(),
            Some(Reopen {
                open: Box::new(|| Err("app data dir: none".into())),
                engine: opener(0, Arc::new(AtomicUsize::new(0)), Duration::ZERO),
                prepare: Box::new(move |engine| s.store(engine.set_event_sink(|_, _| {}), SeqCst)),
            }),
        );
        let opened = OTHER
            .get_or_open(other.path(), &other.path().join("cache"), |d, c| Engine::open(d, c, Arc::new(MemorySecrets::default())).map_err(|e| e.to_string()))
            .unwrap();
        assert!(sunk.load(SeqCst), "the background run's engine got setup's sink");
        assert!(std::ptr::eq(OTHER.wait(Duration::ZERO).unwrap(), opened));
    }

    /// Page calls never stampede a failing open: callers at the same moment share one attempt,
    /// and a caller that keeps calling opens at most once per interval.
    #[test]
    fn page_calls_share_one_reopen_and_retry_at_most_once_per_interval() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        static CELL: EngineCell = EngineCell::retrying_every(Duration::from_millis(300));
        let opens = Arc::new(AtomicUsize::new(0));
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_path_buf();
        CELL.setup_failed(
            "locked".into(),
            Some(Reopen {
                open: Box::new(move || Ok((data.clone(), data.join("cache")))),
                engine: opener(usize::MAX, Arc::clone(&opens), Duration::from_millis(150)),
                prepare: Box::new(|_| {}),
            }),
        );
        std::thread::sleep(Duration::from_millis(350));
        let callers: Vec<_> = (0..8).map(|_| std::thread::spawn(|| CELL.wait(Duration::from_secs(5)).err())).collect();
        for c in callers {
            assert_eq!(c.join().unwrap().as_deref(), Some("file protection 0"), "every caller got the shared attempt's answer");
        }
        assert_eq!(opens.load(SeqCst), 1, "one attempt for eight callers");
        let t0 = Instant::now();
        let mut calls = 0;
        while t0.elapsed() < Duration::from_millis(1200) {
            let _ = CELL.wait(Duration::ZERO);
            calls += 1;
        }
        let retries = opens.load(SeqCst) - 1;
        assert!(calls > 100 && (1..=4).contains(&retries), "{retries} opens in 1.2 s of {calls} calls");
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
        let from_setup = from_setup.expect("setup opened the engine");
        // A background entry point in the same process gets that engine, never a second writer
        // (its own dirs and secret store are not used).
        let from_background = engine_for_background(other_dir.path(), &other_dir.path().join("cache")).expect("the open engine");
        assert!(std::ptr::eq(from_setup, from_background), "a second engine was opened");
        assert_eq!(opens, 1);
        assert!(!other_dir.path().join("mobile.db").exists(), "the background path opened its own mobile.db");
        assert!(std::ptr::eq(wait_engine(Duration::ZERO).unwrap(), from_setup));
        // And a run on it answers (notifications are off by default: nothing to post).
        let out: Value = serde_json::from_str(&run_json(other_dir.path(), other_dir.path(), Duration::from_secs(1), Instant::now())).unwrap();
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
        // One summary per account, each with a fixed id (a later one replaces it), opening that
        // account's INBOX.
        let mixed: Vec<NewMail> = (1..=8).map(|n| mail(n, if n <= 2 { "a" } else { "b" })).collect();
        let notes = render(&mixed, true, "en");
        let summaries: Vec<(&str, &str, &str, Option<u32>)> =
            notes.iter().filter(|n| n.uid.is_none()).map(|n| (n.id.as_str(), n.title.as_str(), n.account_id.as_str(), n.uid)).collect();
        assert_eq!(summaries, vec![("summary/a", "2 new messages", "a", None), ("summary/b", "1 new message", "b", None)]);
        assert_eq!(render(&many, true, "en")[0].id, render(&(1..=9).map(|n| mail(n, "a")).collect::<Vec<_>>(), true, "en")[0].id);
    }

    /// A message keeps its notification id whatever uid it has (a run whose commit was lost
    /// reposts it: the repost replaces).
    #[test]
    fn a_notification_id_follows_the_message_not_its_uid() {
        let a = mail(3, "a");
        let mut again = mail(9, "a");
        again.key = a.key.clone();
        assert_eq!(render(&[a], true, "en")[0].id, render(&[again], true, "en")[0].id);
        assert_ne!(render(&[mail(3, "a")], true, "en")[0].id, render(&[mail(4, "a")], true, "en")[0].id);
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
    fn the_language_picked_in_the_app_wins_over_the_system_one() {
        let system = vec!["fr-FR".to_string()];
        assert_eq!(notify_locale(Some("de"), &system), "de");
        assert_eq!(notify_locale(Some("pt-BR"), &system), "pt-BR");
        assert_eq!(notify_locale(Some("zh-Hans"), &system), "zh-Hans");
        assert_eq!(notify_locale(Some("en"), &system), "en");
        // Not one of the nine (or nothing stored): the system decides, as on the page.
        assert_eq!(notify_locale(Some("sv"), &system), "fr");
        assert_eq!(notify_locale(None, &system), "fr");
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
            assert_eq!(keys.len(), 6, "{locale} lacks a notification string");
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
