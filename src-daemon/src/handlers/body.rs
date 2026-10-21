//! `body.*`: what a mail body carries that the reader warns about, decided
//! here for every UI shell (`mailvault_core::body_scan`).
//!
//! - `body.scan {html, blocking, links, texts}`: the reader's scan of one body
//!   (inner body HTML, CID-resolved, Google Font imports already stripped):
//!   `{trackers, count, https, summary, html, alerts, maxAlertLevel}`. `html`
//!   is the body to frame (beacons replaced by markers when `blocking`, links
//!   titled and marked when `links`), `null` when it is the input unchanged.
//!   `texts` are the UI language's templates for the reasons and the marker,
//!   by catalog key (`body_scan::TEXT_KEYS`).
//! - `body.classify_links {links: [{href, text}], texts}`: one verdict per
//!   link, `{level, reason, actualDomain, textDomain}` (the social card's list).
//! - `body.verdicts {rows: [{id, key?, from, replyTo}], backfill?: [{key,
//!   accountId, mailbox, uid, messageId}], limit?}`: the alerts list rows wear.
//!   `rows` answers `{id: {_linkAlert?, _trackerInfo?, _senderAlert?,
//!   _replyToMismatch?}}` for the rows that wear any, reading the persisted
//!   verdicts and the link-safety toggle from the settings document (a
//!   `linkSafetyEnabled` in the params wins: the document can lag the
//!   window's write by half a second).
//!   `backfill` scans the vault's copy of rows nobody opened (local reads
//!   only, at most `limit`, default 40, each body proven by its Message-ID)
//!   and answers `trackers: {key: {count, vendors}}` for the ones that track.
//!   The app records those: it is the writer of its settings store.
//! - `body.info`: `{trackerPatterns}`, the size of the bundled table.
//!
//! Nothing here reaches the network, and nothing is logged but counts.
use crate::handlers::common::{blocking, done, vault_root};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::body_scan::{self, RowSettings, Texts};
use mailvault_core::settings_doc::SettingsDoc;
use mailvault_core::vault_files;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use tracing::warn;

/// The persisted store that holds `linkAlerts`, `trackerAlerts` and `linkSafetyEnabled`.
const SETTINGS_STORE: &str = "mailvault-settings";
const BACKFILL_DEFAULT: usize = 40;
const BACKFILL_MAX: usize = 200;

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    if !method.starts_with("body.") {
        return None;
    }
    let params = params.clone();
    Some(match method {
        // A body can be long: parsed off the runtime's threads.
        "body.scan" => done(
            id,
            blocking(move || {
                let html = params.get("html").and_then(Value::as_str).unwrap_or("");
                let flag = |k: &str| params.get(k).and_then(Value::as_bool).unwrap_or(false);
                body_scan::scan_body(html, flag("blocking"), flag("links"), &Texts::from_value(params.get("texts")))
            })
            .await,
        ),
        "body.classify_links" => done(
            id,
            blocking(move || {
                let texts = Texts::from_value(params.get("texts"));
                let links = params.get("links").and_then(Value::as_array).cloned().unwrap_or_default();
                let text = |l: &Value, k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                Value::Array(
                    links
                        .iter()
                        .map(|l| serde_json::to_value(body_scan::classify_link(&text(l, "href"), &text(l, "text"), &texts)).unwrap_or(Value::Null))
                        .collect(),
                )
            })
            .await,
        ),
        "body.verdicts" => {
            let state = Arc::clone(state);
            let backfilling = params.get("backfill").and_then(Value::as_array).is_some_and(|l| !l.is_empty());
            if backfilling {
                done(id, on_background_thread(move || verdicts(&state, &params)).await)
            } else {
                done(id, blocking(move || verdicts(&state, &params)).await)
            }
        }
        "body.info" => RpcResponse::success(id, json!({"trackerPatterns": body_scan::tracker_pattern_count()})),
        _ => return None,
    })
}

/// `f` on a background-QoS thread of its own (vault reads for rows nobody
/// opened): a blocking-pool thread would keep the lowered QoS for whatever it
/// runs next.
async fn on_background_thread(f: impl FnOnce() -> Value + Send + 'static) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("body-backfill".into())
        .spawn(move || {
            crate::mbox_upload_job::background_qos();
            let _ = tx.send(f());
        })
        .map_err(|e| format!("backfill thread did not start: {e}"))?;
    rx.await.map_err(|_| "backfill thread ended without an answer".to_string())
}

/// The settings store's state, or an empty one when the document holds none
/// (or cannot be read: a row then wears what it computes, not what was saved).
fn row_settings(state: &DaemonState) -> RowSettings {
    match SettingsDoc::shared(&state.app_dir).read() {
        Ok(doc) => doc.get(SETTINGS_STORE).and_then(|s| s.get("state")).map(RowSettings::from_state).unwrap_or_default(),
        Err(_) => {
            warn!("[body] settings document unreadable; rows answered without persisted verdicts");
            RowSettings::default()
        }
    }
}

fn verdicts(state: &Arc<DaemonState>, params: &Value) -> Value {
    let mut rows = Map::new();
    if let Some(list) = params.get("rows").and_then(Value::as_array).filter(|l| !l.is_empty()) {
        let mut settings = row_settings(state);
        // The toggle as the asking window holds it: the document can lag its write.
        if let Some(on) = params.get("linkSafetyEnabled").and_then(Value::as_bool) {
            settings.link_safety_enabled = on;
        }
        for row in list {
            let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
            let found = body_scan::row_alerts(row, row.get("key").and_then(Value::as_str), &settings);
            if !found.is_empty() {
                rows.insert(id.to_string(), Value::Object(found));
            }
        }
    }
    let limit = params.get("limit").and_then(Value::as_u64).map_or(BACKFILL_DEFAULT, |n| (n as usize).min(BACKFILL_MAX));
    let trackers = match params.get("backfill").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => backfill(state, list, limit),
        _ => Map::new(),
    };
    json!({"rows": rows, "trackers": trackers})
}

struct Wanted {
    key: String,
    uid: u32,
    message_id: Option<String>,
}

fn same_message(header: Option<&str>, body: Option<&str>) -> bool {
    // A missing id on either side proves nothing and is let through (bodyMatchesHeader).
    match (header.and_then(mailvault_core::compose::normalize_message_id), body.and_then(mailvault_core::compose::normalize_message_id)) {
        (Some(h), Some(b)) => h == b,
        _ => true,
    }
}

/// Tracker verdicts for rows nobody opened, from the vault's copy: one folder
/// read at a time, at background priority, never the network.
fn backfill(state: &Arc<DaemonState>, list: &[Value], limit: usize) -> Map<String, Value> {
    let mut out = Map::new();
    let Ok(root) = vault_root(state) else { return out };
    let mut by_folder: BTreeMap<(String, String), Vec<Wanted>> = BTreeMap::new();
    for item in list.iter().take(limit) {
        let s = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_string);
        let (Some(key), Some(account), Some(mailbox)) = (s("key"), s("accountId"), s("mailbox")) else { continue };
        let Some(uid) = item.get("uid").and_then(Value::as_u64).and_then(|u| u32::try_from(u).ok()) else { continue };
        by_folder.entry((account, mailbox)).or_default().push(Wanted { key, uid, message_id: s("messageId") });
    }
    let texts = Texts::default();
    for ((account, mailbox), wanted) in by_folder {
        let uids: Vec<u32> = wanted.iter().map(|w| w.uid).collect();
        let Ok(bodies) = vault_files::read_light_batch(&state.vault_registry, &root, &account, &mailbox, &uids) else { continue };
        for (w, body) in wanted.iter().zip(bodies) {
            let Some(body) = body else { continue };
            // The vault is keyed (account, mailbox, uid) with no generation
            // proof: a uid reissued under a newer UIDVALIDITY can be another message.
            if !same_message(w.message_id.as_deref(), body.message_id.as_deref()) {
                continue;
            }
            let Some(html) = body.html.as_deref().filter(|h| !h.is_empty()) else { continue };
            if let Some(summary) = body_scan::summarize(&body_scan::scan_trackers(html, &texts).trackers) {
                out.insert(w.key.clone(), serde_json::to_value(summary).unwrap_or(Value::Null));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{handle_request_for_test, DaemonState};

    fn rig() -> (tempfile::TempDir, Arc<DaemonState>) {
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::for_test(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        (dir, state)
    }

    async fn call(state: &Arc<DaemonState>, method: &str, params: Value) -> Value {
        let resp = handle_request_for_test(state, method, params).await;
        assert!(resp.error.is_none(), "{method}: {:?}", resp.error);
        resp.result.unwrap()
    }

    const CASES: &str = include_str!("../../../src-core/tests/fixtures/body-scan-cases.json");

    /// The reader's pipeline through the route chain: every corpus case the JS answered.
    #[tokio::test]
    async fn scan_answers_every_pipeline_case_the_js_did() {
        let (_d, s) = rig();
        let f: Value = serde_json::from_str(CASES).unwrap();
        let mut wrong = Vec::new();
        for case in f["pipeline"].as_array().unwrap() {
            let html = case["html"].as_str().unwrap();
            let ans = call(&s, "body.scan", json!({"html": html, "blocking": case["blocking"], "links": case["links"], "texts": f["texts"]["en"]})).await;
            let got = json!({
                "trackers": ans["trackers"], "count": ans["count"], "https": ans["https"],
                "html": ans["html"].as_str().unwrap_or(html), "alerts": ans["alerts"], "maxAlertLevel": ans["maxAlertLevel"],
            });
            if got != case["expected"] {
                wrong.push(case["name"].to_string());
            }
        }
        assert!(wrong.is_empty(), "{wrong:?}");
    }

    #[tokio::test]
    async fn classify_links_answers_one_verdict_per_link() {
        let (_d, s) = rig();
        let f: Value = serde_json::from_str(CASES).unwrap();
        let r = call(&s, "body.classify_links", json!({"links": [{"href": "javascript:x()", "text": "go"}, {"href": "https://fine.test", "text": "ok"}], "texts": f["texts"]["en"]})).await;
        assert_eq!(r[0]["level"], "red");
        assert_eq!(r[0]["reason"], "Link uses dangerous javascript: scheme");
        assert_eq!(r[1]["level"], Value::Null);
    }

    #[tokio::test]
    async fn verdicts_read_the_persisted_alerts_and_the_toggle_from_the_settings_document() {
        let (dir, s) = rig();
        let doc = json!({SETTINGS_STORE: {"state": {
            "linkSafetyEnabled": true,
            "linkAlerts": {"a-INBOX-1": "red"},
            "trackerAlerts": {"a-INBOX-1": {"count": 1, "vendors": ["Mailchimp"]}},
        }, "version": 4}});
        std::fs::write(dir.path().join("frontend-settings.json"), doc.to_string()).unwrap();
        let rows = json!([
            {"id": "r1", "key": "a-INBOX-1", "from": {"address": "a@x.example"}},
            {"id": "r2", "key": "a-INBOX-2", "from": {"name": "support@paypal.com", "address": "scam@evil.example"}, "replyTo": {"address": "b@other.example"}},
            {"id": "r3", "from": {"address": "a@x.example"}},
        ]);
        let r = call(&s, "body.verdicts", json!({"rows": rows})).await;
        assert_eq!(r["rows"]["r1"], json!({"_linkAlert": "red", "_trackerInfo": {"count": 1, "vendors": ["Mailchimp"]}}));
        assert_eq!(r["rows"]["r2"]["_senderAlert"], "red");
        assert_eq!(r["rows"]["r2"]["_replyToMismatch"]["replyToDomain"], "other.example");
        assert!(r["rows"].get("r3").is_none());

        // Link safety off: the persisted verdicts stay, the header checks do not run.
        let mut off = doc.clone();
        off[SETTINGS_STORE]["state"]["linkSafetyEnabled"] = json!(false);
        std::fs::write(dir.path().join("frontend-settings.json"), off.to_string()).unwrap();
        let r = call(&s, "body.verdicts", json!({"rows": rows})).await;
        assert!(r["rows"]["r1"]["_linkAlert"] == "red");
        assert!(r["rows"].get("r2").is_none());
        // The window's own toggle wins over a document that has not caught up.
        let r = call(&s, "body.verdicts", json!({"rows": rows, "linkSafetyEnabled": true})).await;
        assert_eq!(r["rows"]["r2"]["_senderAlert"], "red");
    }

    fn seed(root: &std::path::Path, uid: u32, message_id: &str, html: &str) {
        let cur = vault_files::cur_path(root, "acc", "INBOX");
        std::fs::create_dir_all(&cur).unwrap();
        let raw = format!("From: a@b.com\r\nTo: c@d.com\r\nSubject: hi\r\nMessage-ID: {message_id}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n");
        std::fs::write(cur.join(vault_files::build_maildir_filename(uid, &[])), raw).unwrap();
    }

    #[tokio::test]
    async fn backfill_scans_the_vault_copy_proven_by_its_message_id() {
        let (dir, s) = rig();
        seed(dir.path(), 41, "<m41@x>", r#"<p>hi</p><img src="https://u1.ct.sendgrid.net/wf/open?upn=abc" width="1" height="1">"#);
        seed(dir.path(), 42, "<m42@x>", r#"<p>hi</p><img src="https://example.com/logo.png" width="200">"#);
        seed(dir.path(), 43, "<other@x>", r#"<img src="https://u1.ct.sendgrid.net/wf/open?upn=abc" width="1" height="1">"#);
        let item = |uid: u32, mid: &str| json!({"key": format!("acc-INBOX-{uid}"), "accountId": "acc", "mailbox": "INBOX", "uid": uid, "messageId": mid});
        let r = call(&s, "body.verdicts", json!({"backfill": [item(41, "<m41@x>"), item(42, "<m42@x>"), item(43, "<m43@x>"), item(44, "<m44@x>")]})).await;
        assert_eq!(r["trackers"], json!({"acc-INBOX-41": {"count": 1, "vendors": ["SendGrid"]}}));

        // The budget: a fling does not read the whole mailbox.
        let r = call(&s, "body.verdicts", json!({"backfill": [item(42, "<m42@x>"), item(41, "<m41@x>")], "limit": 1})).await;
        assert_eq!(r["trackers"], json!({}));
    }

    #[tokio::test]
    async fn info_counts_the_bundled_rules() {
        let (_d, s) = rig();
        let r = call(&s, "body.info", json!({})).await;
        assert_eq!(r["trackerPatterns"].as_u64().unwrap() as usize, body_scan::tracker_pattern_count());
    }

    #[test]
    fn the_route_logs_no_body_or_settings_value() {
        let src = include_str!("body.rs");
        let code = &src[..src.find("#[cfg(test)]").unwrap()];
        for line in code.lines().filter(|l| l.contains("info!") || l.contains("warn!") || l.contains("error!")) {
            assert!(!line.contains("{"), "{line}");
        }
    }
}
