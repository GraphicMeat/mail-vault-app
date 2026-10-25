//! Pure compose preparation and UX preflight. No IO and no transport authority.
//! The frozen actual-JS corpus pins recipient, quote, parser and timezone policy.
use crate::notes_to_self::fold_identity;
use chrono::{NaiveDateTime, TimeZone, Utc};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::LazyLock;

// Check/mailto payloads and the separate account reader retain this bound.
// Complete message preparation has no product byte/count cutoff.
pub const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const INVALID: &str = "compose.preparationUnavailable";
type Result<T> = std::result::Result<T, &'static str>;
#[derive(Clone, Debug, Deserialize)]
pub struct Account {
    pub id: String,
    pub email: String,
}
pub struct Context {
    pub accounts: Vec<Account>,
    pub settings: Value,
    pub settings_version: u64,
}

// ECMAScript whitespace differs from Rust's (FEFF yes, 0085 no).
fn ws(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}'|' '| '\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn trim(s: &str) -> &str {
    s.trim_matches(ws)
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => v.to_string(),
    }
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn text_html(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    s.split('\n')
        .map(|s| {
            format!(
                "<p>{}</p>",
                if s.is_empty() {
                    "<br>".into()
                } else {
                    escape(s)
                }
            )
        })
        .collect()
}
fn bound(params: &Value) -> Result<()> {
    if serde_json::to_vec(params).map_err(|_| INVALID)?.len() > MAX_REQUEST_BYTES {
        Err(INVALID)
    } else {
        Ok(())
    }
}
fn fence(request_id: &str, expected: Option<u64>, ctx: &Context) -> Result<()> {
    if trim(request_id).is_empty() || request_id.len() > 128 {
        return Err(INVALID);
    }
    if expected.is_some_and(|v| v != ctx.settings_version) {
        return Err("errors.settingsConflict");
    }
    Ok(())
}
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Address {
    address: Option<String>,
    name: Option<String>,
}
#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Header {
    from: Option<Address>,
    to: Option<Vec<Address>>,
    cc: Option<Vec<Address>>,
    reply_to: Option<Vec<Address>>,
    subject: String,
    date: Value,
    message_id: Value,
    #[serde(rename = "message_id")]
    snake_id: Value,
    references: Value,
    #[serde(rename = "_bodyLoading")]
    body_loading: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Original {
    header: Header,
    #[serde(default)]
    html: Option<String>,
    #[serde(default)]
    text: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Presented {
    original: Original,
    date_label: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Presentation {
    original_label: String,
    date_label: String,
    subject_candidate: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Prepare {
    #[serde(rename_all = "camelCase")]
    Message {
        request_id: String,
        #[serde(default)]
        expected_settings_version: Option<u64>,
        #[serde(default)]
        account_id: Option<String>,
        #[serde(default)]
        picked_from: Option<String>,
        mode: ReplyMode,
        original: Original,
        #[serde(default)]
        selected_quote_html: Option<String>,
        #[serde(default)]
        thread_context: Vec<Presented>,
        presentation: Presentation,
    },
    #[serde(rename_all = "camelCase")]
    Mailto {
        request_id: String,
        href: String,
        #[serde(default)]
        account_id: Option<String>,
        #[serde(default)]
        expected_settings_version: Option<u64>,
    },
}
#[derive(Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ReplyMode {
    Reply,
    ReplyAll,
    Forward,
}
fn addr(a: Option<&Address>) -> &str {
    a.and_then(|a| a.address.as_deref()).unwrap_or("")
}
fn addresses(list: &Option<Vec<Address>>) -> Vec<String> {
    list.iter()
        .flatten()
        .filter_map(|a| a.address.as_ref())
        .filter(|a| !a.is_empty())
        .cloned()
        .collect()
}
fn dedupe(list: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    list.into_iter()
        .filter(|a| !a.is_empty() && seen.insert(a.to_lowercase()))
        .collect()
}
fn own_addresses(ctx: &Context, picked: &str) -> HashSet<String> {
    let mut own = HashSet::new();
    for a in &ctx.accounts {
        for address in [
            ctx.settings["sendAsAddresses"][&a.id]
                .as_str()
                .unwrap_or(""),
            &a.email,
        ] {
            if !trim(address).is_empty() {
                own.insert(fold_identity(trim(address)));
            }
        }
        if let Some(aliases) = ctx.settings["aliases"][&a.id].as_array() {
            for alias in aliases {
                if let Some(address) = alias["address"].as_str() {
                    if !trim(address).is_empty() {
                        own.insert(fold_identity(trim(address)));
                    }
                }
            }
        }
    }
    let picked = fold_identity(trim(picked));
    if !picked.is_empty() {
        own.insert(picked);
    }
    own
}
fn recipients(h: &Header, mode: ReplyMode, own: &HashSet<String>) -> (String, String) {
    if mode == ReplyMode::Forward {
        return (String::new(), String::new());
    }
    let first = addr(h.reply_to.as_ref().and_then(|a| a.first()));
    let sender = if first.is_empty() {
        addr(h.from.as_ref())
    } else {
        first
    };
    let is_own = |s: &str| {
        let identity = fold_identity(trim(s));
        !identity.is_empty() && own.contains(&identity)
    };
    let to = addresses(&h.to);
    let cc = addresses(&h.cc);
    if mode == ReplyMode::Reply {
        let others = if is_own(sender) {
            dedupe(to.into_iter().filter(|a| !is_own(a)).collect())
        } else {
            Vec::new()
        };
        return (
            if others.is_empty() {
                sender.into()
            } else {
                others.join(", ")
            },
            String::new(),
        );
    }
    let to = dedupe(
        std::iter::once(sender.to_string())
            .chain(to)
            .filter(|a| !is_own(a))
            .collect(),
    );
    let cc = dedupe(cc.into_iter().filter(|a| !is_own(a)).collect());
    (
        if to.is_empty() {
            sender.into()
        } else {
            to.join(", ")
        },
        cc.join(", "),
    )
}
fn normalize_id(v: &Value) -> String {
    if !truthy(v) {
        return String::new();
    }
    let s = js_string(v);
    let s = trim(trim(&s).trim_start_matches('<').trim_end_matches('>'));
    if s.is_empty() {
        String::new()
    } else {
        format!("<{s}>")
    }
}
fn ancestry(h: &Header) -> (String, String) {
    let id = normalize_id(if truthy(&h.message_id) {
        &h.message_id
    } else {
        &h.snake_id
    });
    let parts = match &h.references {
        Value::Array(a) => a.clone(),
        v if truthy(v) => vec![v.clone()],
        _ => Vec::new(),
    };
    let mut refs = Vec::new();
    for p in parts {
        for token in js_string(&p).split(ws) {
            let r = normalize_id(&json!(token));
            if !r.is_empty() && !refs.contains(&r) {
                refs.push(r);
            }
        }
    }
    if !id.is_empty() && !refs.contains(&id) {
        refs.push(id.clone());
    }
    (id, refs.join(" "))
}
fn original_html(m: &Original, label: &str, date_label: &str) -> String {
    let h = &m.header;
    let to =
        h.to.iter()
            .flatten()
            .map(|a| a.address.as_deref().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(", ");
    let name = h
        .from
        .as_ref()
        .and_then(|a| a.name.as_deref())
        .unwrap_or("");
    let date = if truthy(&h.date) { date_label } else { "" };
    let body = m
        .html
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            text_html(if h.body_loading {
                ""
            } else {
                m.text.as_deref().unwrap_or("")
            })
        });
    // The catalog label is inserted verbatim in the source. Bodies remain untrusted
    // HTML for the restricted original pane, never privileged DOM/editor markup.
    format!("<p><strong>{label}</strong><br>From: {} &lt;{}&gt;<br>Date: {}<br>Subject: {}<br>To: {}</p>{body}",escape(name),escape(addr(h.from.as_ref())),escape(date),escape(&h.subject),escape(&to))
}
pub fn reply_context(params: &Value, ctx: &Context) -> Result<Value> {
    if params.get("kind").and_then(Value::as_str) != Some("message") {
        bound(params)?;
    }
    // Deserialize from the borrowed JSON instead of cloning the complete body
    // just to consume that clone. Ordinary shape validation remains unchanged.
    let request = Prepare::deserialize(params).map_err(|_| INVALID)?;
    match request {
        Prepare::Mailto {
            request_id,
            href,
            account_id,
            expected_settings_version,
        } => {
            fence(&request_id, expected_settings_version, ctx)?;
            Ok(
                json!({"requestId":request_id,"settingsVersion":ctx.settings_version,"initialData":parse_mailto(&href,account_id.as_deref())}),
            )
        }
        Prepare::Message {
            request_id,
            expected_settings_version,
            account_id,
            picked_from,
            mode,
            original,
            selected_quote_html,
            thread_context,
            presentation,
        } => {
            fence(&request_id, expected_settings_version, ctx)?;
            // accountId is the UI's currently resolved selection. Initialization
            // precedence/signature remain React-owned until the next reviewed slice.
            let account = account_id
                .filter(|id| ctx.accounts.iter().any(|a| &a.id == id))
                .or_else(|| ctx.accounts.first().map(|a| a.id.clone()));
            let own = own_addresses(ctx, picked_from.as_deref().unwrap_or(""));
            let (to, cc) = recipients(&original.header, mode, &own);
            let (parent, refs) = if mode == ReplyMode::Forward {
                (String::new(), String::new())
            } else {
                ancestry(&original.header)
            };
            let full = original_html(
                &original,
                &presentation.original_label,
                &presentation.date_label,
            );
            let end = full.find("</p>").map(|n| n + 4).unwrap_or(3);
            let header = &full[..end];
            let body = &full[end..];
            let selected = selected_quote_html
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(body);
            let quote = if mode == ReplyMode::Forward {
                full.clone()
            } else {
                format!("{header}{selected}")
            };
            let context = if thread_context.is_empty() {
                full.clone()
            } else {
                thread_context
                    .iter()
                    .map(|m| {
                        original_html(&m.original, &presentation.original_label, &m.date_label)
                    })
                    .collect::<Vec<_>>()
                    .join("<hr>")
            };
            let subject = &original.header.subject;
            let prefix = if mode == ReplyMode::Forward {
                "Fwd:"
            } else {
                "Re:"
            };
            Ok(
                json!({"requestId":request_id,"settingsVersion":ctx.settings_version,"accountId":account,"to":to,"cc":cc,"bcc":"","subject":if subject.starts_with(prefix){subject}else{&presentation.subject_candidate},"inReplyTo":parent,"references":refs,"quotedHeaderHtml":header,"fullQuotedBodyHtml":body,"quotedHtml":quote,"contextHtml":context,"fullOriginalHtml":full,"bodyAvailable":original.html.as_ref().is_some_and(|s|!s.is_empty())||(!original.header.body_loading&&original.text.as_ref().is_some_and(|s|!s.is_empty()))}),
            )
        }
    }
}
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return s.into();
            }
            let hex = |c: u8| match c {
                b'0'..=b'9' => Some(c - b'0'),
                b'a'..=b'f' => Some(c - b'a' + 10),
                b'A'..=b'F' => Some(c - b'A' + 10),
                _ => None,
            };
            let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) else {
                return s.into();
            };
            out.push(a * 16 + b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.into())
}
fn address_line(s: &str) -> String {
    s.split(',')
        .map(trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}
fn parse_mailto(href: &str, account: Option<&str>) -> Value {
    let href = trim(href);
    if !href
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("mailto:"))
    {
        return Value::Null;
    }
    let rest = &href[7..];
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut out = json!({"to":address_line(&decode(path)),"cc":"","bcc":"","subject":"","body":"","_prefill":true});
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = trim(&decode(key)).to_lowercase();
        let value = decode(value);
        match key.as_str() {
            "to" => {
                out["to"] = json!(address_line(&format!(
                    "{},{}",
                    out["to"].as_str().unwrap_or(""),
                    value
                )))
            }
            "cc" | "bcc" => out[&key] = json!(address_line(&value)),
            "subject" | "body" => out[&key] = json!(value),
            _ => {}
        }
    }
    out["body"] = json!(escape(out["body"].as_str().unwrap_or(""))
        .replace("\r\n", "\n")
        .replace('\n', "<br>"));
    if let Some(a) = account.filter(|a| !a.is_empty()) {
        out["_accountId"] = json!(a);
    }
    out
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Check {
    request_id: String,
    #[serde(default)]
    draft_id: Option<String>,
    #[serde(default)]
    revision: Option<u64>,
    #[serde(default)]
    expected_settings_version: Option<u64>,
    account_id: String,
    from_address: String,
    mode: Mode,
    #[serde(default)]
    in_reply_to: Option<String>,
    #[serde(default)]
    forward: bool,
    to: String,
    #[serde(default)]
    cc: String,
    #[serde(default)]
    bcc: String,
    #[serde(default)]
    subject: String,
    authored_body_text: String,
    attachment_count: u32,
    #[serde(default)]
    send_plan: Value,
    #[serde(default)]
    schedule_draft: Value,
    time_zone: String,
    #[serde(default)]
    send_anyway: bool,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Mode {
    New,
    Reply,
    ReplyAll,
    Forward,
}
fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut angle = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' && quoted {
            current.push(c);
            if let Some(c) = chars.next() {
                current.push(c)
            }
            continue;
        }
        if c == '"' {
            quoted = !quoted
        } else if c == '<' && !quoted {
            angle = true
        } else if c == '>' && !quoted {
            angle = false
        }
        if matches!(c, ',' | ';' | '\n' | '\r') && !quoted && !angle {
            if !trim(&current).is_empty() {
                out.push(trim(&current).into())
            }
            current.clear();
        } else {
            current.push(c);
        }
    }
    if !trim(&current).is_empty() {
        out.push(trim(&current).into())
    }
    out
}
fn valid_recipient(s: &str) -> bool {
    let candidate = s
        .rfind('>')
        .filter(|end| s[end + 1..].chars().all(ws))
        .and_then(|end| s[..end].rfind('<').map(|start| &s[start + 1..end]))
        .unwrap_or(s);
    let s = trim(candidate);
    if s.chars()
        .any(|c| ws(c) || matches!(c, '<' | '>' | '"' | ',' | ';'))
    {
        return false;
    }
    let mut parts = s.split('@');
    let local = parts.next().unwrap_or("");
    let host = parts.next().unwrap_or("");
    !local.is_empty()
        && parts.next().is_none()
        && host
            .rsplit_once('.')
            .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
}
const TERMS: &[&str] = &[
    "attach",
    "attached",
    "attaching",
    "attachment",
    "attachments",
    "enclosed",
    "enclosing",
    "anhang",
    "anhänge",
    "anhängen",
    "angehängt",
    "anbei",
    "beigefügt",
    "adjunto",
    "adjunta",
    "adjuntos",
    "adjuntas",
    "adjuntado",
    "adjunté",
    "pièce jointe",
    "pièces jointes",
    "ci-joint",
    "ci-jointe",
    "ci-joints",
    "ci-jointes",
    "allegato",
    "allegata",
    "allegati",
    "allegate",
    "anexo",
    "anexa",
    "anexos",
    "anexas",
    "anexado",
    "anexada",
    "anexei",
];
static MENTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?:^|[^\p{{L}}\p{{N}}-])(?:{})(?:$|[^\p{{L}}\p{{N}}-])|添付|첨부|附件|附上|随附",
        TERMS
            .iter()
            .map(|s| regex::escape(s))
            .collect::<Vec<_>>()
            .join("|")
    ))
    .unwrap()
});
fn mentions(text: &str) -> bool {
    let mut lines = Vec::new();
    for line in text.split('\n') {
        if line == "--"
            || (line.starts_with("--")
                && line[2..].chars().count() == 1
                && line[2..].chars().all(ws))
        {
            break;
        }
        if !line.trim_start_matches(ws).starts_with('>') {
            lines.push(line)
        }
    }
    MENTION.is_match(&lines.join("\n"))
}
pub fn check(params: &Value, ctx: &Context, now: i64) -> Result<Value> {
    let p: Check = serde_json::from_value(params.clone()).map_err(|_| INVALID)?;
    fence(&p.request_id, p.expected_settings_version, ctx)?;
    // Validate explicit zone even for immediate plans; unknown zones cannot authorize a send.
    zone(&p.time_zone)?;
    let _ = &p.from_address;
    let mut out = json!({"requestId":p.request_id,"settingsVersion":ctx.settings_version});
    if let Some(id) = p.draft_id {
        out["draftId"] = json!(id)
    }
    if let Some(r) = p.revision {
        out["revision"] = json!(r)
    }
    let invalid = if trim(&p.to).is_empty() {
        Some(("compose.pleaseEnterLeastOneRecipient", None))
    } else if let Some(token) = [&p.to, &p.cc, &p.bcc]
        .iter()
        .flat_map(|s| tokens(s))
        .find(|s| !valid_recipient(s))
    {
        Some(("compose.invalidRecipient", Some(token)))
    } else if !ctx.accounts.iter().any(|a| a.id == p.account_id) {
        Some(("compose.noAccountSelected", None))
    } else {
        None
    };
    if let Some((key, address)) = invalid {
        out["kind"] = json!("invalid");
        out["key"] = json!(key);
        if let Some(address) = address {
            out["args"] = json!({"address":address})
        }
        return Ok(out);
    }
    let new =
        p.mode == Mode::New && !p.forward && !p.in_reply_to.as_ref().is_some_and(|s| !s.is_empty());
    let reminder = ctx
        .settings
        .get("attachmentReminder")
        .map(truthy)
        .unwrap_or(true);
    // The JS share grant uses numeric `expiresAt > Date.now()` rather than Date.parse.
    // Reuse native billing precedence while preserving that source-specific boundary.
    let mut entitlement = ctx.settings.clone();
    let share = entitlement
        .get_mut("shareGrant")
        .map(Value::take)
        .unwrap_or(Value::Null);
    let share_active = match &share["expiresAt"] {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => trim(s).parse::<f64>().ok(),
        _ => None,
    }
    .is_some_and(|v| v > now as f64);
    // Date.parse accepts ISO minute precision, unlike the shared native reader.
    // Normalize only this observed input shape before reusing its billing policy.
    static MINUTE_EXPIRY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$").unwrap()
    });
    if let Some(expiry) = entitlement["billingProfile"]["currentPeriodEnd"].as_str() {
        let normalized = MINUTE_EXPIRY.replace(expiry, "${1}:00$2").into_owned();
        entitlement["billingProfile"]["currentPeriodEnd"] = json!(normalized);
    }
    if !p.send_anyway
        && reminder
        && p.attachment_count == 0
        && (mentions(&p.authored_body_text) || (new && mentions(&p.subject)))
        && (share_active || crate::cleanup_rules::has_premium_access(&entitlement, now))
    {
        out["kind"] = json!("confirm_attachment");
        return Ok(out);
    }
    let route = route_send(&p.send_plan, &p.schedule_draft, now, &p.time_zone)?;
    if let Some(draft) = route.get("draft") {
        if zoned_time_to_epoch(
            draft["localTime"].as_str().ok_or(INVALID)?,
            draft["tz"].as_str().ok_or(INVALID)?,
        )? <= now
        {
            out["kind"] = json!("invalid");
            out["key"] = json!("scheduled.picker.pastTime");
            return Ok(out);
        }
    }
    out["kind"] = json!("ready");
    out["route"] = route;
    Ok(out)
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Plan {
    In { minutes: u32 },
    At,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Draft {
    local_time: String,
    tz: String,
}
fn zone(name: &str) -> Result<jiff::tz::TimeZone> {
    jiff::tz::db().get(name).map_err(|_| INVALID)
}
pub fn wall_clock_at(now: i64, tz: &str) -> Result<String> {
    let t = zone(tz)?.to_datetime(jiff::Timestamp::from_millisecond(now).map_err(|_| INVALID)?);
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}",
        t.year(),
        t.month(),
        t.day(),
        t.hour(),
        t.minute()
    ))
}
fn offset_at(now: i64, tz: &jiff::tz::TimeZone) -> Result<i64> {
    let ts = jiff::Timestamp::from_millisecond(now).map_err(|_| INVALID)?;
    Ok(tz.to_offset(ts).seconds() as i64 * 1000 - now.rem_euclid(1000))
}
pub fn zoned_time_to_epoch(local: &str, tz: &str) -> Result<i64> {
    let local = NaiveDateTime::parse_from_str(&format!("{local}:00"), "%Y-%m-%dT%H:%M:%S")
        .map_err(|_| INVALID)?;
    let guess = Utc.from_utc_datetime(&local).timestamp_millis();
    let tz = zone(tz)?;
    let first = offset_at(guess, &tz)?;
    let second = offset_at(guess - first, &tz)?;
    Ok(guess - second)
}
pub fn route_send(plan: &Value, draft: &Value, now: i64, tz: &str) -> Result<Value> {
    zone(tz)?;
    if plan.is_null() {
        return Ok(json!({"delay":null}));
    }
    match serde_json::from_value::<Plan>(plan.clone()).map_err(|_| INVALID)? {
        Plan::In { minutes } if minutes > 1440 => Err(INVALID),
        Plan::In { minutes: 0 } => Ok(json!({"delay":null})),
        Plan::In { minutes } if minutes <= 5 => Ok(json!({"delay":minutes*60})),
        Plan::In { minutes } => Ok(
            json!({"draft":{"localTime":wall_clock_at(now.checked_add(minutes as i64*60000+59999).ok_or(INVALID)?,tz)?,"tz":tz}}),
        ),
        Plan::At => {
            let d: Draft = serde_json::from_value(draft.clone()).map_err(|_| INVALID)?;
            zoned_time_to_epoch(&d.local_time, &d.tz)?;
            Ok(json!({"draft":{"localTime":d.local_time,"tz":d.tz}}))
        }
    }
}
