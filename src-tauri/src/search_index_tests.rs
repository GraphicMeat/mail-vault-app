use crate::search_index::{plan, Plan, Signal};
use mailvault_core::search_index::reconcile::IndexConfig;

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
    let (off, on) = (IndexConfig { bodies: false }, IndexConfig { bodies: true });

    // Many nudges for one folder stay scoped to it.
    assert_eq!(
        plan(vec![nudge("a", "INBOX"), nudge("a", "INBOX")]),
        Plan { rebuild: false, configure: None, only: Some(("a".into(), "INBOX".into())) }
    );
    // Two folders, or any sweep, widen to a full pass.
    assert_eq!(plan(vec![nudge("a", "INBOX"), nudge("b", "INBOX")]).only, None);
    assert_eq!(plan(vec![nudge("a", "INBOX"), Signal::Sweep]).only, None);
    // The latest configure wins and forces a full pass.
    assert_eq!(
        plan(vec![nudge("a", "INBOX"), Signal::Configure(off), Signal::Configure(on)]),
        Plan { rebuild: false, configure: Some(on), only: None }
    );
    // A rebuild is never swallowed by the nudges queued behind it.
    assert_eq!(plan(vec![Signal::Rebuild, nudge("a", "INBOX")]), Plan { rebuild: true, configure: None, only: None });
}
