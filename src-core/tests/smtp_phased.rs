//! Staged (compose) and frozen (Scheduled Send) bytes over SMTP, driven step
//! by step: a connection cut after the server took the payload is
//! `MayHaveSent`, a refusal before it is `NotSent`, and the server gets the
//! bytes exactly once either way.

use mailvault_core::imap::ImapConfig;
use mailvault_core::send::classify::{classify, SendVerdict};
use mailvault_core::smtp::{self, FrozenEnvelope, OutgoingEmail, SendPhase};
use mock_imap::{MockImap, Scenario};

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

fn account(server: &MockImap) -> ImapConfig {
    std::env::set_var("MAILVAULT_SMTP_PLAINTEXT", "1");
    serde_json::from_value(serde_json::json!({
        "email": "luke@mock.test",
        "password": "hunter2",
        "imapHost": server.host(),
        "imapPort": server.port(),
        "smtpHost": server.host(),
        "smtpPort": server.smtp_port(),
        "smtpSecure": false,
    }))
    .expect("ImapConfig")
}

fn email(to: &str, body: &str) -> OutgoingEmail {
    serde_json::from_value(serde_json::json!({
        "to": to,
        "subject": "Phased",
        "text": body,
        "messageId": "<phased@mock.test>",
    }))
    .expect("OutgoingEmail")
}

fn staged(acc: &ImapConfig, mail: &OutgoingEmail) -> Vec<u8> {
    smtp::build_mime(acc, mail).expect("built").raw_rfc2822
}

fn envelope(to: &str) -> FrozenEnvelope {
    FrozenEnvelope { from: "luke@mock.test".into(), to: to.into(), cc: String::new(), bcc: String::new() }
}

#[test]
fn staged_bytes_go_out_once_as_they_are() {
    let server = MockImap::start(Scenario::new());
    let acc = account(&server);
    let mail = email("bob@example.test", "plain body");
    let raw = staged(&acc, &mail);
    let sent = rt().block_on(smtp::send_staged_phased(&acc, &mail, raw.clone())).expect("sent");
    assert_eq!(sent.raw_rfc2822, raw);
    let got = server.sent_messages();
    assert_eq!(got.len(), 1);
    assert!(String::from_utf8_lossy(&got[0]).contains("plain body"));
}

#[test]
fn a_staged_send_cut_off_after_data_may_have_sent() {
    let server = MockImap::start(Scenario::new().smtp_drop_after_data("CUT-AFTER-DATA"));
    let acc = account(&server);
    let mail = email("bob@example.test", "CUT-AFTER-DATA");
    let err = rt().block_on(smtp::send_staged_phased(&acc, &mail, staged(&acc, &mail))).err().expect("no reply is no success");
    assert_eq!(err.phase, SendPhase::MayHaveSent, "{err:?}");
    assert_eq!(classify(Err(&err)), SendVerdict::MayHaveSent);
    assert_eq!(server.sent_messages().len(), 1, "the server took it once");
}

#[test]
fn a_staged_send_refused_at_rcpt_is_not_sent() {
    let server = MockImap::start(Scenario::new().smtp_refuse("nobody"));
    let acc = account(&server);
    let mail = email("nobody@example.test", "refused");
    let err = rt().block_on(smtp::send_staged_phased(&acc, &mail, staged(&acc, &mail))).err().expect("refused");
    assert_eq!(err.phase, SendPhase::NotSent, "{err:?}");
    assert!(err.permanent, "a 550 is a permanent answer: {err:?}");
    assert!(server.sent_messages().is_empty());
}

#[test]
fn frozen_bytes_go_out_once_as_they_are() {
    let server = MockImap::start(Scenario::new());
    let acc = account(&server);
    let mail = email("bob@example.test", "frozen body");
    let raw = staged(&acc, &mail);
    rt().block_on(smtp::send_raw_phased(&acc, &envelope("bob@example.test"), raw.clone())).expect("sent");
    assert_eq!(server.sent_messages(), vec![raw]);
}

#[test]
fn a_frozen_send_cut_off_after_data_may_have_sent() {
    let server = MockImap::start(Scenario::new().smtp_drop_after_data("CUT-AFTER-DATA"));
    let acc = account(&server);
    let mail = email("bob@example.test", "CUT-AFTER-DATA");
    let err = rt()
        .block_on(smtp::send_raw_phased(&acc, &envelope("bob@example.test"), staged(&acc, &mail)))
        .err()
        .expect("no reply is no success");
    assert_eq!(err.phase, SendPhase::MayHaveSent, "{err:?}");
    assert_eq!(server.sent_messages().len(), 1);
}

#[test]
fn a_frozen_send_refused_at_rcpt_or_with_no_recipient_is_not_sent() {
    let server = MockImap::start(Scenario::new().smtp_refuse("nobody"));
    let acc = account(&server);
    let mail = email("nobody@example.test", "refused");
    let err = rt()
        .block_on(smtp::send_raw_phased(&acc, &envelope("nobody@example.test"), staged(&acc, &mail)))
        .err()
        .expect("refused");
    assert_eq!(err.phase, SendPhase::NotSent, "{err:?}");
    let err = rt().block_on(smtp::send_raw_phased(&acc, &envelope(""), b"x".to_vec())).err().expect("no recipients");
    assert_eq!(err.phase, SendPhase::NotSent);
    assert!(err.message.contains("no recipients"), "{}", err.message);
    assert!(server.sent_messages().is_empty());
}
