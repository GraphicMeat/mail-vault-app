//! AI on the phone: desktop's Settings > AI and the features it turns on (Quick Replies, the AI
//! actions in the viewer and compose), with the phone's one provider, an OpenAI-compatible
//! endpoint (desktop's `Provider::Endpoint`; core `ai` shapes the request and reads the reply).
//! There is no on-device model here: desktop's Apple Intelligence runs as a macOS helper process,
//! and its downloaded model runs in the daemon.
//!
//! Settings are preferences (`settings.rs` PREFS): `aiEnabled`, `aiEndpointUrl`,
//! `aiEndpointModel`, `aiSkipPreview`. The API key lives in the platform secret store under
//! [`KEY_ID`], never in `mobile.db`, a reply, an event or a log line. The engine keeps for itself
//! (`ai.*`, internal settings) the endpoint URL the user last reviewed a send to
//! ([`CONSENTED_URL`]) and the conversations whose quick replies were dismissed ([`DISMISSED`]).
//!
//! The rules, all answered here so the page cannot get them wrong:
//! - Nothing is sent while `aiEnabled` is off or no endpoint URL is set.
//! - Gmail mail only ever goes to an endpoint on this device (core
//!   `provider_allowed_for_google_mail`); so does mail of an account the engine cannot name.
//! - An explicit action (`mobile.ai.run`) needs the user's review (`confirmed`), unless
//!   `aiSkipPreview` is on and this very URL was reviewed before. A review consents for that URL
//!   only: change the URL and the next send is reviewed again.
//! - Quick replies are automatic, so they are generated only for a reviewed URL, and never for a
//!   mailing-list or automated message, nor one synced before that was known.
//! - A failed request answers `AI_FAILED` with the HTTP status at most: never the server's text,
//!   which could quote the request.

use crate::accounts::load_account;
use crate::db::Engine;
use crate::net::block_on;
use crate::rpc::{parse, RpcError};
use crate::settings::{get_in, put_in};
use mailvault_core::ai::{chat_request_body, endpoint_is_on_device, parse_chat_response, provider_allowed_for_google_mail};
use mailvault_core::net_activity;
use mailvault_core::provider::Provider;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

/// The secret store entry of the endpoint's API key (account ids never take this form).
pub(crate) const KEY_ID: &str = "mailvault.ai.endpointKey";
/// The endpoint URL the user last confirmed a send to.
pub(crate) const CONSENTED_URL: &str = "ai.consentedUrl";
/// Thread keys whose quick replies were dismissed: a JSON list, newest last.
pub(crate) const DISMISSED: &str = "ai.dismissedThreads";
const MAX_DISMISSED: usize = 500;

/// The refusal the page reads for Gmail mail (core's code, the desktop's catalog mapping).
pub(crate) const GOOGLE_REFUSED: &str = mailvault_core::ai::GOOGLE_MAIL_ON_DEVICE_ONLY;

const TEST_PROMPT: &str = "Reply with exactly one short sentence confirming you received this.";
const SAME_LANGUAGE: &str = "Write in the same language as the email.";
/// How much of a message or draft an action sends.
const MAX_SOURCE_CHARS: usize = 8000;
/// How much of a message a quick reply prompt carries (desktop's `MAX_MESSAGE_CHARS`).
const QUICK_REPLY_CHARS: usize = 800;
/// A recipient count above this reads as a broadcast (desktop's `LARGE_RECIPIENT_THRESHOLD`).
const LARGE_RECIPIENTS: usize = 15;
const RUN_TIMEOUT: Duration = Duration::from_secs(60);
/// Quick replies give up early: the deterministic ones are already showing.
const QUICK_REPLY_TIMEOUT: Duration = Duration::from_secs(8);

fn internal(e: impl ToString) -> RpcError {
    RpcError::Internal(e.to_string())
}

fn refused(code: &str) -> Value {
    json!({ "ok": false, "code": code })
}

// ── Settings ────────────────────────────────────────────────────────────────

struct Config {
    enabled: bool,
    url: String,
    model: String,
    skip_preview: bool,
    consented_url: Option<String>,
}

impl Config {
    fn read(engine: &Engine) -> Result<Config, RpcError> {
        engine
            .read(|c| {
                Ok(Config {
                    enabled: get_in(c, "aiEnabled")?.as_deref() == Some("true"),
                    url: get_in(c, "aiEndpointUrl")?.unwrap_or_default().trim().to_string(),
                    model: get_in(c, "aiEndpointModel")?.unwrap_or_default().trim().to_string(),
                    skip_preview: get_in(c, "aiSkipPreview")?.as_deref() == Some("true"),
                    consented_url: get_in(c, CONSENTED_URL)?,
                })
            })
            .map_err(internal)
    }

    /// An http(s) URL is set.
    fn configured(&self) -> bool {
        url::Url::parse(&self.url).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
    }

    /// The user confirmed a send to this very URL.
    fn consented(&self) -> bool {
        self.configured() && self.consented_url.as_deref() == Some(self.url.as_str())
    }

    /// Why nothing may be sent at all, if so.
    fn blocked(&self) -> Option<&'static str> {
        if !self.enabled {
            Some("AI_OFF")
        } else if !self.configured() {
            Some("AI_NOT_CONFIGURED")
        } else {
            None
        }
    }
}

/// Whether an account's mail is Google's: Google OAuth, or Gmail's IMAP host (an app password).
fn is_google(row: &crate::accounts::AccountRow) -> bool {
    Provider::Google.owns_account(&json!({
        "authType": row.auth,
        "oauth2Provider": row.provider.clone().unwrap_or_default(),
        "imapHost": row.imap_host,
    }))
}

/// Whether mail of these accounts may go to the configured endpoint: always for an endpoint on
/// this device; else only when every account is named, known, and not Google's.
fn mail_allowed(engine: &Engine, cfg: &Config, account_ids: &[&str]) -> Result<bool, RpcError> {
    if provider_allowed_for_google_mail("endpoint", Some(&cfg.url)) {
        return Ok(true);
    }
    if account_ids.is_empty() {
        return Ok(false);
    }
    for id in account_ids {
        match load_account(engine.shared(), id).map_err(internal)? {
            Some(row) if !is_google(&row) => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

// ── Messages ────────────────────────────────────────────────────────────────

/// What the AI features read of a stored message.
struct Message {
    subject: String,
    from_address: String,
    recipients: usize,
    thread: Value,
    message_id: String,
    text: String,
}

fn load_message(engine: &Engine, account_id: &str, folder: &str, uid: i64) -> Result<Option<Message>, RpcError> {
    use rusqlite::OptionalExtension;
    engine
        .read(|c| {
            let row = c
                .query_row(
                    "SELECT subject, from_address, to_json, thread_json, message_id, snippet FROM messages
                     WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                    (account_id, folder, uid),
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                            r.get::<_, String>(5)?,
                        ))
                    },
                )
                .optional()?;
            let Some((subject, from_address, to_json, thread_json, message_id, snippet)) = row else { return Ok(None) };
            let body = c
                .query_row(
                    "SELECT text, html FROM bodies WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                    (account_id, folder, uid),
                    |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
                )
                .optional()?;
            let text = match body {
                Some((Some(t), _)) if !t.trim().is_empty() => t,
                Some((_, Some(h))) if !h.trim().is_empty() => mailvault_core::search_index::text::html_to_text(&h),
                _ => snippet,
            };
            let thread: Value = serde_json::from_str(&thread_json).unwrap_or(Value::Null);
            let count = |v: &Value| v.as_array().map_or(0, Vec::len);
            let to: Value = serde_json::from_str(&to_json).unwrap_or(Value::Null);
            let recipients = count(&to) + count(&thread["cc"]);
            Ok(Some(Message { subject, from_address, recipients, thread, message_id, text }))
        })
        .map_err(internal)
}

fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => s[..at].to_string(),
        None => s.to_string(),
    }
}

// ── Explicit actions ────────────────────────────────────────────────────────

const TONES: [&str; 3] = ["casual", "formal", "friendly"];

/// The prompt of an action over `text` (desktop's `AiComposeActions` `buildPrompt`).
fn action_prompt(action: &str, text: &str, tone: &str) -> String {
    match action {
        "draftReply" => format!("Write a short, polite email reply to the message below. {SAME_LANGUAGE} Reply with only the message body.\n\n{text}"),
        "shorten" => format!("Rewrite the email below to be more concise, keeping its meaning and tone. {SAME_LANGUAGE} Reply with only the rewritten text.\n\n{text}"),
        "tone" => format!("Rewrite the email below in a more {tone} tone, keeping its meaning. {SAME_LANGUAGE} Reply with only the rewritten text.\n\n{text}"),
        "actionItems" => format!("List the action items from the email below as short lines, one per item. If there are none, say so in one line. {SAME_LANGUAGE}\n\n{text}"),
        _ => format!("Summarize the email thread below in 2-3 short sentences. {SAME_LANGUAGE}\n\n{text}"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionParams {
    action: String,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    uid: Option<i64>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    tone: Option<String>,
    #[serde(default)]
    confirmed: bool,
}

/// One request: its prompt, whose mail it carries, and its size.
struct Request {
    prompt: String,
    accounts: Vec<String>,
    no_mail: bool,
    max_tokens: usize,
}

/// The request an action makes, or the code it is refused with.
fn request(engine: &Engine, p: &ActionParams) -> Result<Result<Request, &'static str>, RpcError> {
    let account = p.account_id.clone().filter(|a| !a.is_empty());
    match p.action.as_str() {
        "test" => Ok(Ok(Request { prompt: TEST_PROMPT.into(), accounts: vec![], no_mail: true, max_tokens: 60 })),
        "summarize" | "actionItems" | "draftReply" => {
            let (Some(account), Some(folder), Some(uid)) = (account, p.folder.as_deref(), p.uid) else {
                return Err(RpcError::Invalid(format!("{} needs accountId, folder and uid", p.action)));
            };
            let Some(m) = load_message(engine, &account, folder, uid)? else { return Ok(Err("NOT_FOUND")) };
            if m.text.trim().is_empty() {
                return Ok(Err("NO_TEXT"));
            }
            let prompt = action_prompt(&p.action, &clip(m.text.trim(), MAX_SOURCE_CHARS), "");
            Ok(Ok(Request { prompt, accounts: vec![account], no_mail: false, max_tokens: 600 }))
        }
        "shorten" | "tone" => {
            let Some(account) = account else { return Err(RpcError::Invalid(format!("{} needs accountId", p.action))) };
            let tone = p.tone.as_deref().unwrap_or("");
            if p.action == "tone" && !TONES.contains(&tone) {
                return Err(RpcError::Invalid("tone is casual, formal or friendly".into()));
            }
            let text = p.text.as_deref().unwrap_or("").trim();
            if text.is_empty() {
                return Ok(Err("NO_TEXT"));
            }
            let prompt = action_prompt(&p.action, &clip(text, MAX_SOURCE_CHARS), tone);
            Ok(Ok(Request { prompt, accounts: vec![account], no_mail: false, max_tokens: 600 }))
        }
        other => Err(RpcError::Invalid(format!("unknown AI action: {other}"))),
    }
}

/// The request after the settings and the Gmail rule, or the code that stops it.
fn gated(engine: &Engine, cfg: &Config, p: &ActionParams) -> Result<Result<Request, &'static str>, RpcError> {
    let req = match request(engine, p)? {
        Ok(r) => r,
        Err(code) => return Ok(Err(code)),
    };
    if let Some(code) = cfg.blocked() {
        return Ok(Err(code));
    }
    if !req.no_mail {
        let ids: Vec<&str> = req.accounts.iter().map(String::as_str).collect();
        if !mail_allowed(engine, cfg, &ids)? {
            return Ok(Err(GOOGLE_REFUSED));
        }
    }
    Ok(Ok(req))
}

/// `mobile.ai.prompt {action, accountId?, folder?, uid?, text?, tone?}` -> `{ok: true, prompt,
/// destination, leavesDevice}` (what `mobile.ai.run` would send and where; nothing is sent), or
/// `{ok: false, code}`. Actions: `test`; `summarize`, `actionItems`, `draftReply` over a stored
/// message; `shorten`, `tone` (`casual|formal|friendly`) over the draft `text` written from
/// `accountId`.
pub(crate) fn prompt(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ActionParams = parse(params)?;
    let cfg = Config::read(engine)?;
    Ok(match gated(engine, &cfg, &p)? {
        Ok(req) => json!({ "ok": true, "prompt": req.prompt, "destination": cfg.url, "leavesDevice": !endpoint_is_on_device(&cfg.url) }),
        Err(code) => refused(code),
    })
}

/// `mobile.ai.run {...as prompt, confirmed?}` -> `{ok: true, text}` or `{ok: false, code,
/// status?}`. `confirmed`: the user reviewed this request's prompt (`mobile.ai.prompt`) and chose
/// to send it, which consents to this endpoint URL. Without it, the run is `REVIEW_REQUIRED`
/// unless `aiSkipPreview` is on and this URL was reviewed before.
pub(crate) fn run(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: ActionParams = parse(params)?;
    let cfg = Config::read(engine)?;
    let req = match gated(engine, &cfg, &p)? {
        Ok(r) => r,
        Err(code) => return Ok(refused(code)),
    };
    if p.confirmed {
        let url = cfg.url.clone();
        engine.write(|c| put_in(c, CONSENTED_URL, &url)).map_err(internal)?;
    } else if !(cfg.skip_preview && cfg.consented()) {
        return Ok(refused("REVIEW_REQUIRED"));
    }
    let account = match req.accounts.as_slice() {
        [one] => Some(one.as_str()),
        _ => None,
    };
    Ok(match generate(engine, &cfg, &req.prompt, None, req.max_tokens, RUN_TIMEOUT, account) {
        Ok(text) => json!({ "ok": true, "text": text.trim() }),
        Err(fail) => fail.reply(),
    })
}

// ── The endpoint ────────────────────────────────────────────────────────────

enum Fail {
    /// No answer: the server could not be reached, or did not answer in time.
    Network,
    /// The server answered with this non-2xx status.
    Status(u16),
    /// A 2xx that is not a chat completion.
    BadReply,
}

impl Fail {
    fn reply(&self) -> Value {
        match self {
            Fail::Network => json!({ "ok": false, "code": "AI_FAILED", "reason": "network" }),
            Fail::Status(s) => json!({ "ok": false, "code": "AI_FAILED", "status": s }),
            Fail::BadReply => json!({ "ok": false, "code": "AI_FAILED", "reason": "reply" }),
        }
    }
}

/// One `/chat/completions` request to the configured endpoint, with the stored key as a bearer
/// token when there is one. Every error is dropped unread: reqwest's names the URL, and the
/// server's body could quote the request. The request is a Network Activity row ("AI model", as
/// desktop's), shown as `account`'s (an id) when it carries that one account's mail.
fn generate(engine: &Engine, cfg: &Config, prompt: &str, system: Option<&str>, max_tokens: usize, timeout: Duration, account: Option<&str>) -> Result<String, Fail> {
    let key = engine.secrets().get(KEY_ID).ok().flatten().filter(|k| !k.is_empty());
    let body = serde_json::to_vec(&chat_request_body(&cfg.model, prompt, system, max_tokens)).map_err(|_| Fail::BadReply)?;
    let endpoint = format!("{}/chat/completions", cfg.url.trim_end_matches('/'));
    let email = account.and_then(|id| load_account(engine.shared(), id).ok().flatten()).map(|a| a.email);
    let call = async move {
        let client = net_activity::http_client_with("AI model", reqwest::Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none()));
        let mut req = client.post(&endpoint).header(reqwest::header::CONTENT_TYPE, "application/json").body(body);
        if let Some(key) = key {
            req = req.bearer_auth(key);
        }
        let resp = client.send(req).await.map_err(|_| Fail::Network)?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(Fail::Status(status));
        }
        let bytes = resp.bytes().await.map_err(|_| Fail::Network)?;
        let json: Value = serde_json::from_slice(&bytes).map_err(|_| Fail::BadReply)?;
        parse_chat_response(&json).map_err(|_| Fail::BadReply)
    };
    block_on(async move {
        match email {
            Some(email) => net_activity::with_account(email, call).await,
            None => call.await,
        }
    })
}

// ── Key and status ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyParams {
    key: String,
}

/// `mobile.ai.setKey {key}` -> `{hasKey}`: stores the endpoint's API key in the platform secret
/// store, or removes it for an empty one. The key is never answered back.
pub(crate) fn set_key(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: KeyParams = parse(params)?;
    let key = p.key.trim();
    let stored = if key.is_empty() { engine.secrets().delete(KEY_ID) } else { engine.secrets().set(KEY_ID, key) };
    stored.map_err(|_| RpcError::Internal("the secret store refused the key".into()))?;
    Ok(json!({ "hasKey": !key.is_empty() }))
}

/// `mobile.ai.status {}` -> `{hasKey, reviewed}`: a key is stored; the current endpoint URL was
/// reviewed (quick replies may use it, and `aiSkipPreview` applies).
pub(crate) fn status(engine: &Engine, _params: Value) -> Result<Value, RpcError> {
    let cfg = Config::read(engine)?;
    let has_key = engine.secrets().get(KEY_ID).ok().flatten().is_some_and(|k| !k.is_empty());
    Ok(json!({ "hasKey": has_key, "reviewed": cfg.consented() }))
}

// ── Quick replies ───────────────────────────────────────────────────────────

/// The three message shapes the deterministic replies (and the page's catalog) know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Shape {
    ProposedTime,
    Question,
    Request,
}

impl Shape {
    fn as_str(self) -> &'static str {
        match self {
            Shape::ProposedTime => "proposedTime",
            Shape::Question => "question",
            Shape::Request => "request",
        }
    }
}

fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Whether `phrase` occurs in `text` (both lowercase) with a word boundary at each end, like a
/// regex `\bphrase\b`.
fn has_word(text: &str, phrase: &str) -> bool {
    text.match_indices(phrase).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + phrase.len()..].chars().next();
        !before.is_some_and(word_char) && !after.is_some_and(word_char)
    })
}

/// A clock time like `3pm`, `10 am` or `9:30pm`: desktop's `\b\d{1,2}(:\d{2})?\s?(am|pm)\b`.
fn has_clock_time(text: &str) -> bool {
    let b = text.as_bytes();
    let is_word = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
    (0..b.len()).any(|start| {
        if !b[start].is_ascii_digit() || (start > 0 && is_word(start - 1)) {
            return false;
        }
        let mut i = start;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i - start > 2 {
            return false;
        }
        if b.get(i) == Some(&b':') && b.get(i + 1).is_some_and(u8::is_ascii_digit) && b.get(i + 2).is_some_and(u8::is_ascii_digit) {
            i += 3;
        }
        if b.get(i).is_some_and(|c| c.is_ascii_whitespace()) {
            i += 1;
        }
        b.get(i..i + 2).is_some_and(|s| s == b"am" || s == b"pm") && !is_word(i + 2)
    })
}

/// `does <anything> work` on one line (desktop's `does .* work\b`).
fn does_work(line: &str) -> bool {
    line.match_indices("does ").any(|(at, _)| {
        let before = line[..at].chars().next_back();
        !before.is_some_and(word_char) && has_word_after(&line[at + "does ".len()..], " work")
    })
}

fn has_word_after(rest: &str, needle: &str) -> bool {
    rest.match_indices(needle).any(|(at, _)| !rest[at + needle.len()..].chars().next().is_some_and(word_char))
}

const DAYS: [&str; 9] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "tomorrow", "today"];
const TIME_CONTEXT: [&str; 9] = ["work for you", "available", "free at", "free on", "how about", "meet", "meeting", "call at", "schedule"];

/// Desktop's `threadShape`: a proposed time, a question, or a request.
pub(crate) fn shape(subject: &str, text: &str) -> Shape {
    let all = format!("{subject}\n{text}").to_lowercase();
    let time = DAYS.iter().any(|d| has_word(&all, d)) || has_clock_time(&all);
    let context = TIME_CONTEXT.iter().any(|p| has_word(&all, p)) || all.lines().any(does_work);
    if time && context {
        Shape::ProposedTime
    } else if all.contains('?') {
        Shape::Question
    } else {
        Shape::Request
    }
}

/// A generated reply's lines as starters: list marks stripped, at most three.
pub(crate) fn parse_starters(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '-' | '*' | '.' | ')') || c.is_ascii_digit()).trim())
        .filter(|l| !l.is_empty())
        .take(3)
        .map(str::to_string)
        .collect()
}

/// A key that stays with the conversation (a uid moves): the References root, else In-Reply-To,
/// else the message's own id.
fn thread_key(m: &Message, fallback: &str) -> String {
    let first_ref = m.thread["references"].as_array().and_then(|r| r.iter().filter_map(Value::as_str).find(|s| !s.trim().is_empty()));
    first_ref
        .or_else(|| m.thread["inReplyTo"].as_str().filter(|s| !s.trim().is_empty()))
        .or_else(|| Some(m.message_id.as_str()).filter(|s| !s.trim().is_empty()))
        .map_or_else(|| fallback.to_string(), |s| s.trim().to_string())
}

fn dismissed(engine: &Engine) -> Result<Vec<String>, RpcError> {
    let stored = engine.read(|c| get_in(c, DISMISSED)).map_err(internal)?;
    Ok(stored.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

/// Desktop's `isAutomatedThread`: `Some(true)` for a list, bulk or automated message,
/// `Some(false)` for a person's, `None` when the row predates the headers that tell.
fn automated(m: &Message) -> Option<bool> {
    let reply_to = m.thread["replyTo"].as_array().and_then(|l| l.first()).and_then(|a| a["address"].as_str()).unwrap_or("");
    let differs = !reply_to.is_empty() && !m.from_address.is_empty() && !reply_to.eq_ignore_ascii_case(&m.from_address);
    if differs || m.recipients > LARGE_RECIPIENTS {
        return Some(true);
    }
    m.thread["automated"].as_bool()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuickParams {
    account_id: String,
    folder: String,
    uid: i64,
    #[serde(default)]
    generate: bool,
}

/// `mobile.ai.quickReplies {accountId, folder, uid, generate?}` -> `{show, shape, starters}`.
/// `show` is false for a message that is the account's own, a list or automated one, or one in a
/// conversation whose replies were dismissed. `shape` picks the deterministic starters the page
/// shows from its catalog. `starters` (`generate: true` only) are three generated by the
/// endpoint, or `null` when AI is off, not configured, the endpoint was never reviewed, the mail
/// is Gmail's, the message predates the list headers, or the request failed: the page keeps the
/// deterministic ones.
pub(crate) fn quick_replies(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: QuickParams = parse(params)?;
    let Some(m) = load_message(engine, &p.account_id, &p.folder, p.uid)? else {
        return Ok(json!({ "show": false, "shape": Shape::Request.as_str(), "starters": null }));
    };
    let shape = shape(&m.subject, &m.text);
    let own = load_account(engine.shared(), &p.account_id)
        .map_err(internal)?
        .is_some_and(|a| a.email.eq_ignore_ascii_case(m.from_address.trim()));
    let key = thread_key(&m, &format!("{}/{}/{}", p.account_id, p.folder, p.uid));
    let auto = automated(&m);
    let show = !own && auto != Some(true) && !dismissed(engine)?.contains(&key);
    let mut starters = Value::Null;
    if show && p.generate && auto == Some(false) {
        let cfg = Config::read(engine)?;
        if cfg.blocked().is_none() && cfg.consented() && mail_allowed(engine, &cfg, &[p.account_id.as_str()])? {
            let prompt = format!(
                "Suggest exactly 3 very short email reply starters (a few words each), one per line, no numbering, for this email conversation:\n\nSubject: {}\n\nFrom: {}\n{}",
                m.subject,
                if m.from_address.is_empty() { "unknown" } else { m.from_address.as_str() },
                clip(m.text.trim(), QUICK_REPLY_CHARS),
            );
            if let Ok(text) = generate(engine, &cfg, &prompt, None, 120, QUICK_REPLY_TIMEOUT, Some(&p.account_id)) {
                let list = parse_starters(&text);
                if !list.is_empty() {
                    starters = json!(list);
                }
            }
        }
    }
    Ok(json!({ "show": show, "shape": shape.as_str(), "starters": starters }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DismissParams {
    account_id: String,
    folder: String,
    uid: i64,
}

/// `mobile.ai.dismissQuickReplies {accountId, folder, uid}` -> `{}`: no quick replies for this
/// message's conversation again (the newest [`MAX_DISMISSED`] conversations are remembered).
pub(crate) fn dismiss_quick_replies(engine: &Engine, params: Value) -> Result<Value, RpcError> {
    let p: DismissParams = parse(params)?;
    let Some(m) = load_message(engine, &p.account_id, &p.folder, p.uid)? else { return Ok(json!({})) };
    let key = thread_key(&m, &format!("{}/{}/{}", p.account_id, p.folder, p.uid));
    engine
        .write(|c| {
            let mut list: Vec<String> = get_in(c, DISMISSED)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            list.retain(|k| k != &key);
            list.push(key.clone());
            let excess = list.len().saturating_sub(MAX_DISMISSED);
            list.drain(..excess);
            put_in(c, DISMISSED, &serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()))
        })
        .map_err(internal)?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests;
