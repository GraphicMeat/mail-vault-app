use crate::search_index::{bodies_action, needs_full, plan, BodiesAction, Plan, Signal, SWEEP_EVERY};
use std::time::Duration;

fn eml_html() -> Vec<u8> {
    b"From: Ann Lee <ann@x.test>\r\nTo: Bob <bob@x.test>\r\nCc: carol@x.test\r\nSubject: Quarterly numbers\r\nMessage-ID: <q@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Revenue&nbsp;grew <b>12%</b></p><style>x{}</style>\r\n".to_vec()
}

#[test]
fn adapter_builds_doc_from_the_app_parser() {
    let doc = crate::search_index::index_doc_from_light(&eml_html(), 7, "7:2,S.eml").expect("parses");
    assert_eq!(doc.subject, "Quarterly numbers");
    assert_eq!(doc.from_addr, "ann@x.test");
    assert_eq!(doc.from_name, "Ann Lee");
    assert!(doc.addrs.iter().any(|a| a.contains("bob@x.test")));
    assert!(doc.addrs.iter().any(|a| a.contains("carol@x.test")));
    assert_eq!(doc.body_text, "Revenue grew 12%");
    assert_eq!(doc.message_id.as_deref(), Some("<q@x.test>"));
    assert_eq!(doc.date_utc, Some(1789207200));
    let row: serde_json::Value = serde_json::from_str(&doc.row_json).unwrap();
    assert!(row.get("text").map_or(true, |v| v.is_null()), "row_json has no body");
    assert!(row.get("html").map_or(true, |v| v.is_null()));
    assert!(row.get("flags").is_none(), "flags come from the filename at read time");
    assert_eq!(row["subject"], "Quarterly numbers");
}

#[test]
fn search_index_signal_burst_collapses_into_one_pass() {
    let nudge = |a: &str, d: &str| Signal::Nudge { account_id: a.into(), vault_dir: d.into() };
    let quiet = || Plan { reopen: false, rebuild: false, only: None };

    // Many nudges for one folder stay scoped to it.
    assert_eq!(
        plan(vec![nudge("a", "INBOX"), nudge("a", "INBOX")]),
        Plan { only: Some(("a".into(), "INBOX".into())), ..quiet() }
    );
    // Two folders, a sweep or a configure widen to a full pass.
    assert_eq!(plan(vec![nudge("a", "INBOX"), nudge("b", "INBOX")]), quiet());
    assert_eq!(plan(vec![nudge("a", "INBOX"), Signal::Sweep]), quiet());
    assert_eq!(plan(vec![nudge("a", "INBOX"), Signal::Configure]), quiet());
    // Rebuild and reopen are never swallowed by the nudges queued behind them.
    assert_eq!(plan(vec![Signal::Rebuild, nudge("a", "INBOX")]), Plan { rebuild: true, ..quiet() });
    assert_eq!(plan(vec![Signal::Reopen, nudge("a", "INBOX")]), Plan { reopen: true, ..quiet() });
}

#[test]
fn search_index_bodies_setting_is_recorded_toggled_or_left() {
    // A fresh index has no flag: record it, nothing to strip.
    assert_eq!(bodies_action(None, true), BodiesAction::RecordOnly);
    assert_eq!(bodies_action(None, false), BodiesAction::RecordOnly);
    assert_eq!(bodies_action(Some("1"), true), BodiesAction::None);
    assert_eq!(bodies_action(Some("0"), false), BodiesAction::None);
    assert_eq!(bodies_action(Some("1"), false), BodiesAction::Toggle);
    assert_eq!(bodies_action(Some("0"), true), BodiesAction::Toggle);
}

#[test]
fn search_index_safety_sweep_is_not_starved_by_nudges() {
    let young = SWEEP_EVERY - Duration::from_secs(1);
    assert!(needs_full(SWEEP_EVERY, false), "an overdue scoped pass is promoted");
    assert!(needs_full(SWEEP_EVERY * 3, false));
    assert!(needs_full(Duration::ZERO, true), "a planned full pass stays full");
    assert!(!needs_full(young, false), "a scoped pass inside the window stays scoped");
}

fn eml_alternative(plain: &str, html: &str) -> Vec<u8> {
    format!(
        "From: Ann <ann@x.test>\r\nTo: bob@x.test\r\nSubject: Both parts\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{plain}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n--b--\r\n"
    )
    .into_bytes()
}

#[test]
fn adapter_prefers_the_text_part_when_html_is_also_present() {
    let doc = crate::search_index::index_doc_from_light(&eml_alternative("Plain wins", "<p>Html loses</p>"), 1, "1:2,.eml").expect("parses");
    assert_eq!(doc.body_text.trim(), "Plain wins");
}

#[test]
fn adapter_falls_back_to_html_when_the_text_part_is_whitespace() {
    let doc = crate::search_index::index_doc_from_light(&eml_alternative("  \r\n\t", "<p>From <b>html</b></p>"), 1, "1:2,.eml").expect("parses");
    assert_eq!(doc.body_text, "From html");
}
