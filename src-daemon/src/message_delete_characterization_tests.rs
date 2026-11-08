//! Characterization matrix for the single-message delete RPCs, pinned BEFORE
//! the delete core is consolidated (plan 2026-11-01-message-delete-
//! consolidation, Task 0). Every test asserts what the wire says TODAY:
//! `imap_delete_email` (`handlers::imap`), the same RPC on a JMAP account
//! (`handlers::jmap_bridge::delete_email`) and `graph_delete_message`
//! (`handlers::graph`).
//!
//! Test names are `delete_{imap|jmap|graph}_{auto|trash|permanent}_{capture_ok|
//! capture_fetch_err|capture_timeout|capture_busy|capture_write_err}`:
//!
//! - mode `auto`: the daemon decides by core's delete rule (owner decision
//!   1, 2026-11-08; it was "INBOX moves, any other folder is permanent"
//!   before): outside Trash a move to Trash, inside Trash permanent. `auto`
//!   runs INBOX and a non-INBOX folder, both outside Trash (-> trash arm; a
//!   JMAP label the email is not alone in loses only that label). The
//!   inside-Trash and no-Trash cells are `message_delete::tests` (IMAP) and
//!   `delete_jmap_auto_*` below.
//! - `capture_ok`: the capture works. `capture_fetch_err`: the full-message
//!   fetch the capture needs is refused by the server (IMAP: tagged NO on
//!   `BODY.PEEK[]`; JMAP: the blob is gone). `capture_timeout`: that fetch
//!   outlives the ceiling (`deleted::set_fetch_ceiling_for_test` shortens the
//!   45s `BODY_FETCH_TIMEOUT`; the error text still names 45s).
//!   `capture_busy`: the account is closing (`account_lifecycle.try_close`),
//!   so `capture(id)` is refused. `capture_write_err`: the bin directory path
//!   is a regular file, so writing the copy fails.
//! - There is no local copy of the message unless a cell says so (a
//!   `capture_write_err` cell seeds vault bytes, because only a capture that
//!   HAS bytes writes a file).
//!
//! `run_delete` is the table-driven entry Tasks 1 and 2 reuse. It returns a
//! `Ran`, the `RpcResponse` plus the side effects the response alone does not
//! show (message still on the server, bin rows, fetches made).

use crate::handlers::common::with_mailbox_write;
use crate::imap::ImapConfig;
use crate::ipc::RpcResponse;
use crate::server::{handle_request_for_test, DaemonState};
use mailvault_core::app_db::{self, deleted::{self as bin, Deleted}};
use mailvault_core::custody::cache;
use mailvault_core::vault_files;
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Debug)]
pub(crate) enum Provider {
    Imap,
    Jmap,
    Graph,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Mode {
    /// `mode: "auto"`, the app's default: the daemon decides by the folder.
    Auto,
    /// `mode: "trash"`.
    Trash,
    /// `mode: "permanent"`.
    Permanent,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum CaptureScenario {
    Ok,
    FetchErr,
    Timeout,
    Busy,
    WriteErr,
}

/// Where the message sits on the server.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ServerScenario {
    Inbox,
    /// A plain non-INBOX folder (IMAP `Archive`; JMAP `Work`, a label).
    OtherFolder,
    /// IMAP `[Gmail]/All Mail` with `[Gmail]/Trash` as the trash folder.
    GmailAllMail,
}

impl ServerScenario {
    fn mailbox(self, provider: Provider) -> &'static str {
        match (self, provider) {
            (Self::Inbox, _) => "INBOX",
            (Self::OtherFolder, Provider::Jmap) => "Work",
            (Self::OtherFolder, _) => "Archive",
            (Self::GmailAllMail, _) => "[Gmail]/All Mail",
        }
    }
    fn trash(self) -> &'static str {
        match self {
            Self::GmailAllMail => "[Gmail]/Trash",
            _ => "Trash",
        }
    }
}

impl Mode {
    /// The `mode` string the daemon receives.
    fn wire(self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::Trash => "trash",
            Mode::Permanent => "permanent",
        }
    }
}

pub(crate) const RAW: &str = "From: Ann <ann@example.com>\r\nTo: user@example.com\r\nSubject: Keep me\r\n\
                   Date: Thu, 01 Jan 2015 00:00:00 +0000\r\nMessage-ID: <keep1@example.com>\r\n\r\nThe body.\r\n";

/// What a run did, beyond the response.
pub(crate) struct Ran {
    pub resp: RpcResponse,
    /// The bin rows after the call.
    pub bin: Vec<Deleted>,
    pub app_dir: PathBuf,
    /// The message is still in the folder (or carries the label) it was deleted from.
    pub in_source: bool,
    /// The message is in the trash folder (or carries the Trash label).
    pub in_trash: bool,
    /// Full-message downloads the server saw (IMAP `BODY.PEEK[]`, JMAP blob GET).
    pub body_fetches: usize,
    /// Requests the Graph mock answered (Graph only).
    pub graph_requests: usize,
    /// The message's bytes as the server (or the vault) holds them.
    pub raw: Vec<u8>,
}

impl Ran {
    fn result(&self) -> &Value {
        match (&self.resp.result, &self.resp.error) {
            (Some(v), None) => v,
            (_, Some(e)) => panic!("expected a result, got the error: {}", e.message),
            _ => panic!("neither a result nor an error"),
        }
    }
    fn error(&self) -> &str {
        match (&self.resp.result, &self.resp.error) {
            (_, Some(e)) => &e.message,
            (r, None) => panic!("expected an error, got the result: {r:?}"),
        }
    }
}

/// What the bin holds after the call.
#[derive(Clone, Copy, Debug)]
pub(crate) enum BinCopy {
    /// One row, with the message bytes.
    Bytes,
    /// One row, no bytes (the Trash copy is the only one).
    ByteLess,
    /// No row and `binId` is null.
    Nothing,
}

pub(crate) fn plain_state(dir: &Path) -> Arc<DaemonState> {
    std::fs::create_dir_all(dir).unwrap();
    DaemonState::for_test(dir.to_path_buf(), dir.to_path_buf(), true)
}

pub(crate) fn seed_accounts(s: &Arc<DaemonState>, json: &str) {
    std::fs::write(s.app_dir.join("accounts.json"), json).unwrap();
    s.account_lifecycle.seed(&mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&s.app_dir)).unwrap());
}

fn lease(id: &str) -> crate::account_workflows::AccountLease {
    crate::account_workflows::AccountLease::detached_for_test(crate::account_workflows::AccountWriteScope { ids: [id.to_owned()].into(), ..Default::default() })
}

/// The bin directory's path is a regular file: `create_dir_all` fails, so a
/// capture that has bytes cannot write its copy.
pub(crate) fn break_the_bin(app_dir: &Path) {
    let dir = bin::bin_dir(app_dir);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::write(&dir, b"not a directory").unwrap();
}

pub(crate) fn bin_rows(s: &DaemonState) -> Vec<Deleted> {
    app_db::with(&s.app_dir, |c| bin::list(c, &s.app_dir)).unwrap()
}

/// One delete through the real RPC: `provider` x `mode` x capture scenario x
/// where the message sits. The table the tests below read.
pub(crate) async fn run_delete(provider: Provider, mode: Mode, capture: CaptureScenario, server: ServerScenario) -> Ran {
    match provider {
        Provider::Imap => run_imap(mode, capture, server).await,
        Provider::Jmap => run_jmap(mode, capture, server).await,
        Provider::Graph => run_graph(mode, capture, server).await,
    }
}

// ── IMAP ───────────────────────────────────────────────────────────────────

async fn run_imap(mode: Mode, capture: CaptureScenario, server: ServerScenario) -> Ran {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let mailbox = server.mailbox(Provider::Imap);
    let trash = server.trash();

    let mut scenario = Scenario::new();
    match capture {
        CaptureScenario::FetchErr => {
            scenario = scenario.fault(Trigger::with("FETCH", "BODY.PEEK[]"), Action::Respond("NO".into(), "fetch failed".into()));
        }
        // Past the shortened ceiling (1s), well short of a hung test.
        CaptureScenario::Timeout => {
            scenario = scenario.fault(Trigger::with("FETCH", "BODY.PEEK[]"), Action::Delay(Duration::from_secs(3)));
        }
        _ => {}
    }
    let mut target = Mailbox::new(mailbox);
    if server == ServerScenario::GmailAllMail {
        target = target.with_attrs(&["\\All"]);
    }
    target.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
    scenario = scenario.mailbox(target);
    if mailbox != "INBOX" {
        scenario = scenario.mailbox(Mailbox::new("INBOX"));
    }
    scenario = scenario.mailbox(Mailbox::new(trash).with_attrs(&["\\Trash"]));
    let srv = MockImap::start(scenario);

    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-char-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acc1"},{"id":"other"}]"#);
    let config: ImapConfig = serde_json::from_value(account.clone()).unwrap();
    s.raw_messages.accounts.lock().unwrap().insert("acc1".into(), config);
    // The list row the app showed, as a sync leaves it: this is what lets a
    // byte-less capture name the message (its Message-ID).
    let headers = json!({"emails": [{"uid": 1, "messageId": "<keep1@example.com>", "subject": "Keep me", "flags": ["\\Seen"]}]}).to_string();
    crate::custody::with_conn(&s, |c| cache::save_headers(c, "acc1", mailbox, &headers)).unwrap();

    match capture {
        CaptureScenario::Timeout => crate::handlers::deleted::set_fetch_ceiling_for_test(&s, Duration::from_secs(1)),
        CaptureScenario::WriteErr => {
            // Only a capture that has bytes writes a file.
            with_mailbox_write(&s, "acc1", mailbox, |root| vault_files::store(&s.vault_registry, root, "acc1", mailbox, 1, RAW.as_bytes(), &[], false)).unwrap();
            break_the_bin(&s.app_dir);
        }
        _ => {}
    }
    let _claim = (capture == CaptureScenario::Busy).then(|| s.account_lifecycle.try_close(lease("acc1"), "acc1").unwrap());

    let resp = handle_request_for_test(&s, "imap_delete_email", json!({"account": account, "uid": 1, "mailbox": mailbox, "mode": mode.wire()})).await;

    let state = srv.state();
    let in_source = state.find(mailbox).is_some_and(|m| m.by_uid(1).is_some());
    let in_trash = state.find(trash).is_some_and(|m| !m.messages.is_empty());
    Ran { resp, bin: bin_rows(&s), app_dir: s.app_dir.clone(), in_source, in_trash, body_fetches: srv.count_commands("BODY.PEEK[]"), graph_requests: 0, raw: RAW.as_bytes().to_vec() }
}

// ── JMAP ───────────────────────────────────────────────────────────────────

async fn run_jmap(mode: Mode, capture: CaptureScenario, server: ServerScenario) -> Ran {
    use crate::jmap_test_support as support;
    assert_ne!(server, ServerScenario::GmailAllMail, "JMAP has no Gmail IMAP folders");
    assert_ne!(capture, CaptureScenario::Timeout, "mock-jmap has no delay fault: the JMAP capture timeout cannot be injected");
    let m = mock_jmap::MockJmap::start(support::scenario());
    let (_trap, port) = support::imap_trap();
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-char-jmap-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acct1"}]"#);
    s.raw_messages.accounts.lock().unwrap().insert("acct1".into(), support::config(&m, port));
    let account = support::account_json(&m, port);

    // INBOX holds e2 (that label only); Work holds e1 (which is also in INBOX).
    let (mailbox, email_id, source_label) = match server {
        ServerScenario::Inbox => ("INBOX", "e2", "mb-inbox"),
        _ => ("Work", "e1", "mb-work"),
    };
    // A listing first: the ledger issues the uids a delete addresses.
    let listing = handle_request_for_test(&s, "imap_get_emails", json!({"account": account, "mailbox": mailbox, "page": 1, "limit": 50})).await.result.expect("listed");
    let message_id = format!("<{email_id}@x>");
    let uid = listing["emails"].as_array().unwrap().iter().find(|e| e["messageId"] == message_id.as_str()).unwrap()["uid"].as_u64().unwrap() as u32;

    match capture {
        // The blob is gone: the capture's download fails while the delete's
        // own Email/get still works.
        CaptureScenario::FetchErr => m.mutate(|st| {
            let blob = st.email("acc1", email_id).unwrap().blob_id.clone();
            st.blobs.remove(&blob);
        }),
        CaptureScenario::WriteErr => break_the_bin(&s.app_dir),
        _ => {}
    }
    let _claim = (capture == CaptureScenario::Busy).then(|| s.account_lifecycle.try_close(lease("acct1"), "acct1").unwrap());

    let resp = handle_request_for_test(&s, "imap_delete_email", json!({"account": account, "uid": uid, "mailbox": mailbox, "mode": mode.wire()})).await;

    let labels = m.read(|st| st.email("acc1", email_id).map(|e| e.mailbox_ids.clone()));
    let in_source = labels.as_ref().is_some_and(|l| l.contains(source_label));
    let in_trash = labels.as_ref().is_some_and(|l| l.contains("mb-trash"));
    let body_fetches = m.requests().iter().filter(|r| r.path.starts_with("/jmap/download/")).count();
    let subject = if email_id == "e2" { "two" } else { "one" };
    Ran { resp, bin: bin_rows(&s), app_dir: s.app_dir.clone(), in_source, in_trash, body_fetches, graph_requests: 0, raw: support::raw(email_id, subject).into_bytes() }
}

// ── Graph ──────────────────────────────────────────────────────────────────

/// Graph: `permanent` is not a parameter (a delete always goes to Deleted
/// Items), the capture never fetches (`Source::Graph`), and a capture that
/// fails is only logged. `FetchErr` and `Timeout` therefore mean "no local
/// copy and nothing to fetch": the vault copy is not seeded.
async fn run_graph(mode: Mode, capture: CaptureScenario, _server: ServerScenario) -> Ran {
    let _mock = crate::handlers::graph::test_graph_mock_with(vec![(200, String::new())]);
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-char-graph-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acct1"},{"id":"other"}]"#);
    let raw = "From: a@x.com\r\nSubject: Bye\r\nMessage-ID: <g1@x>\r\n\r\nbody\r\n";
    if !matches!(capture, CaptureScenario::FetchErr | CaptureScenario::Timeout) {
        with_mailbox_write(&s, "acct1", "INBOX", |root| vault_files::store(&s.vault_registry, root, "acct1", "INBOX", 7, raw.as_bytes(), &[], false)).unwrap();
    }
    if capture == CaptureScenario::WriteErr {
        break_the_bin(&s.app_dir);
    }
    let _claim = (capture == CaptureScenario::Busy).then(|| s.account_lifecycle.try_close(lease("acct1"), "acct1").unwrap());
    // The daemon never makes a Graph delete permanent; send every mode, to pin that.
    let params = json!({"accessToken": "tok", "messageId": "m1", "accountId": "acct1", "mailbox": "INBOX", "uid": 7, "mode": mode.wire()});
    let resp = crate::handlers::graph::route(&s, "graph_delete_message", &params, json!(1)).await.expect("routed");
    Ran {
        resp,
        bin: bin_rows(&s),
        app_dir: s.app_dir.clone(),
        in_source: false,
        in_trash: false,
        body_fetches: 0,
        graph_requests: crate::handlers::graph::test_graph_requests().len(),
        raw: raw.as_bytes().to_vec(),
    }
}

// ── assertions ─────────────────────────────────────────────────────────────

fn assert_bin(r: &Ran, copy: BinCopy, bin_id: &Value) {
    match copy {
        BinCopy::Nothing => {
            assert_eq!(bin_id, &Value::Null, "binId");
            assert!(r.bin.is_empty(), "no bin row, got {}", r.bin.len());
        }
        BinCopy::Bytes | BinCopy::ByteLess => {
            assert_eq!(r.bin.len(), 1, "one bin row");
            assert_eq!(bin_id, &json!(r.bin[0].id), "binId names the row");
            assert_eq!(r.bin[0].has_eml, matches!(copy, BinCopy::Bytes), "bin row has bytes: {copy:?}");
            if matches!(copy, BinCopy::Bytes) {
                assert_eq!(bin::read_eml(&r.app_dir, &r.bin[0].id).unwrap(), r.raw);
            }
        }
    }
}

/// Moved to Trash: `trash` named, a Trash uid for the undo, gone from the source.
fn assert_trashed(r: &Ran, trash: &str, copy: BinCopy) {
    let v = r.result();
    assert_eq!(v["success"], json!(true), "{v}");
    assert_eq!(v["trash"], json!(trash), "{v}");
    assert!(v["trashUid"].is_u64(), "{v}");
    assert_bin(r, copy, &v["binId"]);
    assert!(!r.in_source && r.in_trash, "moved out of the source into Trash");
}

/// Permanent: no Trash, nothing to undo to, gone from the source and not in Trash.
fn assert_gone_for_good(r: &Ran, copy: BinCopy) {
    let v = r.result();
    assert_eq!(v["success"], json!(true), "{v}");
    assert_eq!((&v["trash"], &v["trashUid"]), (&Value::Null, &Value::Null), "{v}");
    assert_bin(r, copy, &v["binId"]);
    assert!(!r.in_source && !r.in_trash, "gone from the source, not in Trash");
}

/// Refused (or failed): the wire error starts with `prefix`, nothing on the
/// server changed, no bin row.
fn assert_refused(r: &Ran, prefix: &str) {
    let e = r.error();
    assert!(e.starts_with(prefix), "expected an error starting {prefix:?}, got {e:?}");
    assert!(r.in_source && !r.in_trash, "the message is untouched on the server");
    assert!(r.bin.is_empty(), "no bin row for a delete that did not happen");
}

/// A capture refusal names its cause: `E_BIN_CAPTURE:<reason>: <detail>`, with
/// the daemon's own `detail` kept for the log. Nothing on the server changed.
fn assert_capture_refused(r: &Ran, reason: &str, detail: &str) {
    let e = r.error();
    let head = format!("E_BIN_CAPTURE:{reason}: ");
    assert!(e.starts_with(&head), "expected an error starting {head:?}, got {e:?}");
    assert!(e[head.len()..].contains(detail), "expected the detail to contain {detail:?}, got {e:?}");
    assert!(r.in_source && !r.in_trash, "the message is untouched on the server");
    assert!(r.bin.is_empty(), "no bin row for a delete that did not happen");
}

fn imap_expect(permanent: bool, capture: CaptureScenario, trash: &str, r: &Ran) {
    use CaptureScenario::*;
    if !permanent {
        // Trash arm: the capture is byte-less unless bytes are local, and a
        // capture that fails is only logged.
        match capture {
            Ok | FetchErr | Timeout => {
                assert_trashed(r, trash, BinCopy::ByteLess);
                assert_eq!(r.body_fetches, 0, "a move to Trash downloads nothing");
            }
            Busy | WriteErr => assert_trashed(r, trash, BinCopy::Nothing),
        }
        return;
    }
    match capture {
        Ok => assert_gone_for_good(r, BinCopy::Bytes),
        FetchErr => assert_capture_refused(r, "fetch", "Server returned no body for UID 1"),
        Timeout => {
            assert_eq!(r.error(), "E_BIN_CAPTURE:timeout: timed out after 45s");
            assert_capture_refused(r, "timeout", "timed out after 45s");
        }
        Busy => assert_capture_refused(r, "busy", "errors.keychainBusy"),
        WriteErr => assert_capture_refused(r, "write", "create deleted bin"),
    }
}

/// What the JMAP capture's failed blob download says (the daemon's own text).
const JMAP_FETCH_DETAIL: &str = "E_JMAP_PROTOCOL: HTTP 404";

fn jmap_expect(permanent: bool, capture: CaptureScenario, r: &Ran) {
    use CaptureScenario::*;
    // JMAP with no account stamp (the account is closing): a permanent delete,
    // whose capture is required, is the same typed busy refusal as IMAP's
    // (Task 2; it was a bare `errors.keychainBusy` before). Any other delete
    // cannot address the message without the stamp: a bare `errors.keychainBusy`.
    if capture == Busy {
        return if permanent { assert_capture_refused(r, "busy", "errors.keychainBusy") } else { assert_refused(r, "errors.keychainBusy") };
    }
    if !permanent {
        return match capture {
            Ok => assert_trashed(r, "Trash", BinCopy::Bytes),
            // A capture that fails is only logged on a non-permanent delete.
            FetchErr | WriteErr => assert_trashed(r, "Trash", BinCopy::Nothing),
            Timeout | Busy => unreachable!(),
        };
    }
    match capture {
        Ok => assert_gone_for_good(r, BinCopy::Bytes),
        FetchErr => assert_capture_refused(r, "fetch", JMAP_FETCH_DETAIL),
        WriteErr => assert_capture_refused(r, "write", "create deleted bin"),
        Timeout | Busy => unreachable!(),
    }
}

/// JMAP, a delete (not permanent) from a label the email is not alone in:
/// only that label comes off (`jmap::remove_from`), nothing moves to Trash,
/// and the capture is best effort.
fn jmap_label_expect(capture: CaptureScenario, r: &Ran) {
    use CaptureScenario::*;
    let copy = match capture {
        Busy => return assert_refused(r, "errors.keychainBusy"),
        Ok => BinCopy::Bytes,
        FetchErr | WriteErr => BinCopy::Nothing,
        Timeout => unreachable!(),
    };
    let v = r.result();
    assert_eq!(v["success"], json!(true), "{v}");
    assert_eq!((&v["trash"], &v["trashUid"]), (&Value::Null, &Value::Null), "{v}");
    assert_bin(r, copy, &v["binId"]);
    assert!(!r.in_source && !r.in_trash, "the label came off; nothing went to Trash");
}

/// Graph: every cell is the same wire call; the capture is best effort.
fn graph_expect(capture: CaptureScenario, r: &Ran) {
    use CaptureScenario::*;
    assert_eq!(r.graph_requests, 1, "exactly one request: the DELETE (nothing fetched)");
    match capture {
        Ok => {
            let v = r.result();
            assert_bin(r, BinCopy::Bytes, &v["binId"]);
        }
        // Capture refused or failed: logged, the delete still goes ahead and
        // answers null.
        Busy | WriteErr | FetchErr | Timeout => {
            assert_eq!(r.result(), &Value::Null);
            assert!(r.bin.is_empty());
        }
    }
}

// ── the matrix ─────────────────────────────────────────────────────────────

use CaptureScenario as C;
use Mode as M;
use Provider as P;
use ServerScenario as S;

/// `auto` outside Trash: INBOX and any other folder are a move to Trash
/// (owner decision 1). JMAP's `Work` holds an email INBOX holds too, so the
/// move is the label coming off (`jmap_label_expect`).
async fn auto(provider: Provider, capture: CaptureScenario) {
    for server in [S::Inbox, S::OtherFolder] {
        let r = run_delete(provider, M::Auto, capture, server).await;
        match provider {
            P::Imap => imap_expect(false, capture, "Trash", &r),
            P::Jmap if server == S::OtherFolder => jmap_label_expect(capture, &r),
            P::Jmap => jmap_expect(false, capture, &r),
            P::Graph => graph_expect(capture, &r),
        }
    }
}

async fn fixed(provider: Provider, mode: Mode, capture: CaptureScenario) {
    let r = run_delete(provider, mode, capture, S::Inbox).await;
    let permanent = matches!(mode, M::Permanent);
    match provider {
        P::Imap => imap_expect(permanent, capture, "Trash", &r),
        P::Jmap => jmap_expect(permanent, capture, &r),
        P::Graph => graph_expect(capture, &r),
    }
}

macro_rules! cell {
    ($name:ident, ignored $reason:literal, auto, $provider:expr, $capture:expr) => {
        #[tokio::test]
        #[ignore = $reason]
        async fn $name() {
            auto($provider, $capture).await;
        }
    };
    ($name:ident, ignored $reason:literal, $mode:expr, $provider:expr, $capture:expr) => {
        #[tokio::test]
        #[ignore = $reason]
        async fn $name() {
            fixed($provider, $mode, $capture).await;
        }
    };
    ($name:ident, auto, $provider:expr, $capture:expr) => {
        #[tokio::test]
        async fn $name() {
            auto($provider, $capture).await;
        }
    };
    ($name:ident, $mode:expr, $provider:expr, $capture:expr) => {
        #[tokio::test]
        async fn $name() {
            fixed($provider, $mode, $capture).await;
        }
    };
}

// IMAP
cell!(delete_imap_auto_capture_ok, auto, P::Imap, C::Ok);
cell!(delete_imap_auto_capture_fetch_err, auto, P::Imap, C::FetchErr);
cell!(delete_imap_auto_capture_timeout, auto, P::Imap, C::Timeout);
cell!(delete_imap_auto_capture_busy, auto, P::Imap, C::Busy);
cell!(delete_imap_auto_capture_write_err, auto, P::Imap, C::WriteErr);
cell!(delete_imap_trash_capture_ok, M::Trash, P::Imap, C::Ok);
cell!(delete_imap_trash_capture_fetch_err, M::Trash, P::Imap, C::FetchErr);
cell!(delete_imap_trash_capture_timeout, M::Trash, P::Imap, C::Timeout);
cell!(delete_imap_trash_capture_busy, M::Trash, P::Imap, C::Busy);
cell!(delete_imap_trash_capture_write_err, M::Trash, P::Imap, C::WriteErr);
cell!(delete_imap_permanent_capture_ok, M::Permanent, P::Imap, C::Ok);
cell!(delete_imap_permanent_capture_fetch_err, M::Permanent, P::Imap, C::FetchErr);
cell!(delete_imap_permanent_capture_timeout, M::Permanent, P::Imap, C::Timeout);
cell!(delete_imap_permanent_capture_busy, M::Permanent, P::Imap, C::Busy);
cell!(delete_imap_permanent_capture_write_err, M::Permanent, P::Imap, C::WriteErr);

// JMAP. The capture timeout cannot be injected: mock-jmap has no delay fault
// and the JMAP fetch ceiling is the bare `BODY_FETCH_TIMEOUT` const.
cell!(delete_jmap_auto_capture_ok, auto, P::Jmap, C::Ok);
cell!(delete_jmap_auto_capture_fetch_err, auto, P::Jmap, C::FetchErr);
cell!(delete_jmap_auto_capture_timeout, ignored "mock-jmap has no delay fault; the JMAP fetch ceiling is the bare 45s BODY_FETCH_TIMEOUT const (jmap_bridge::fetch_body_timed)", auto, P::Jmap, C::Timeout);
cell!(delete_jmap_auto_capture_busy, auto, P::Jmap, C::Busy);
cell!(delete_jmap_auto_capture_write_err, auto, P::Jmap, C::WriteErr);
cell!(delete_jmap_trash_capture_ok, M::Trash, P::Jmap, C::Ok);
cell!(delete_jmap_trash_capture_fetch_err, M::Trash, P::Jmap, C::FetchErr);
cell!(delete_jmap_trash_capture_timeout, ignored "mock-jmap has no delay fault; the JMAP fetch ceiling is the bare 45s BODY_FETCH_TIMEOUT const (jmap_bridge::fetch_body_timed)", M::Trash, P::Jmap, C::Timeout);
cell!(delete_jmap_trash_capture_busy, M::Trash, P::Jmap, C::Busy);
cell!(delete_jmap_trash_capture_write_err, M::Trash, P::Jmap, C::WriteErr);
cell!(delete_jmap_permanent_capture_ok, M::Permanent, P::Jmap, C::Ok);
cell!(delete_jmap_permanent_capture_fetch_err, M::Permanent, P::Jmap, C::FetchErr);
cell!(delete_jmap_permanent_capture_timeout, ignored "mock-jmap has no delay fault; the JMAP fetch ceiling is the bare 45s BODY_FETCH_TIMEOUT const (jmap_bridge::fetch_body_timed)", M::Permanent, P::Jmap, C::Timeout);
cell!(delete_jmap_permanent_capture_busy, M::Permanent, P::Jmap, C::Busy);
cell!(delete_jmap_permanent_capture_write_err, M::Permanent, P::Jmap, C::WriteErr);

// Graph: no `permanent` parameter and no remote capture, so the three modes
// are one call. The fetch-error and timeout cells do not apply (one
// collapsed test below).
cell!(delete_graph_auto_capture_ok, auto, P::Graph, C::Ok);
cell!(delete_graph_auto_capture_busy, auto, P::Graph, C::Busy);
cell!(delete_graph_auto_capture_write_err, auto, P::Graph, C::WriteErr);
cell!(delete_graph_trash_capture_ok, M::Trash, P::Graph, C::Ok);
cell!(delete_graph_trash_capture_busy, M::Trash, P::Graph, C::Busy);
cell!(delete_graph_trash_capture_write_err, M::Trash, P::Graph, C::WriteErr);
cell!(delete_graph_permanent_capture_ok, M::Permanent, P::Graph, C::Ok);
cell!(delete_graph_permanent_capture_busy, M::Permanent, P::Graph, C::Busy);
cell!(delete_graph_permanent_capture_write_err, M::Permanent, P::Graph, C::WriteErr);

/// Graph never downloads for a capture (`Source::Graph` only reads local
/// bytes), so a fetch error or timeout cannot happen: with no local copy the
/// delete is one request and keeps nothing, in every mode.
#[tokio::test]
async fn delete_graph_capture_fetch_err_and_timeout_do_not_apply() {
    for mode in [M::Auto, M::Trash, M::Permanent] {
        for capture in [C::FetchErr, C::Timeout] {
            let r = run_delete(P::Graph, mode, capture, S::Inbox).await;
            graph_expect(capture, &r);
        }
    }
}

// ── the Gmail-shaped case ──────────────────────────────────────────────────
// `[Gmail]/All Mail`, a permanent delete, no local bytes, so the capture has
// to download the message first.

#[tokio::test]
async fn delete_imap_permanent_gmail_all_mail_capture_ok() {
    let r = run_delete(P::Imap, M::Permanent, C::Ok, S::GmailAllMail).await;
    assert_gone_for_good(&r, BinCopy::Bytes);
    assert_eq!(r.body_fetches, 1, "the capture downloaded it once");
}

#[tokio::test]
async fn delete_imap_permanent_gmail_all_mail_capture_fetch_err() {
    let r = run_delete(P::Imap, M::Permanent, C::FetchErr, S::GmailAllMail).await;
    assert_capture_refused(&r, "fetch", "Server returned no body for UID 1, but the message is still in [Gmail]/All Mail");
    assert_eq!(r.body_fetches, 1, "the fetch was tried");
}

#[tokio::test]
async fn delete_imap_permanent_gmail_all_mail_capture_timeout() {
    let r = run_delete(P::Imap, M::Permanent, C::Timeout, S::GmailAllMail).await;
    assert_eq!(r.error(), "E_BIN_CAPTURE:timeout: timed out after 45s");
    assert_capture_refused(&r, "timeout", "timed out after 45s");
}

/// `auto` from All Mail is outside Trash: a move to `[Gmail]/Trash` that
/// never fetches, so a fetch error does not matter (it was a permanent
/// delete, refused on the fetch, before owner decision 1).
#[tokio::test]
async fn delete_imap_auto_gmail_all_mail_capture_fetch_err() {
    let r = run_delete(P::Imap, M::Auto, C::FetchErr, S::GmailAllMail).await;
    assert_trashed(&r, "[Gmail]/Trash", BinCopy::ByteLess);
    assert_eq!(r.body_fetches, 0);
}

/// JMAP `auto` by core's rule: from Sent (its only mailbox) a move to Trash
/// with a Trash uid for the undo; from Trash permanent (destroyed, the bin
/// copy first).
#[tokio::test]
async fn delete_jmap_auto_moves_from_sent_and_is_permanent_in_trash() {
    use crate::jmap_test_support as support;
    let mut scenario = support::scenario();
    let boxes = &mut scenario.accounts[0].mailboxes;
    boxes.iter_mut().find(|b| b.id == "mb-sent").unwrap().emails.push(support::email("e3", "three", "2026-10-03T10:00:00Z"));
    boxes.iter_mut().find(|b| b.id == "mb-trash").unwrap().emails.push(support::email("e4", "four", "2026-10-04T10:00:00Z"));
    let m = mock_jmap::MockJmap::start(scenario);
    let (_trap, port) = support::imap_trap();
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-char-jmap-rule-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acct1"}]"#);
    s.raw_messages.accounts.lock().unwrap().insert("acct1".into(), support::config(&m, port));
    let account = support::account_json(&m, port);
    let uid_of = |listing: &Value, id: &str| listing["emails"].as_array().unwrap().iter().find(|e| e["messageId"] == format!("<{id}@x>").as_str()).unwrap()["uid"].as_u64().unwrap();

    let sent = handle_request_for_test(&s, "imap_get_emails", json!({"account": account, "mailbox": "Sent", "page": 1, "limit": 50})).await.result.expect("listed");
    let resp = handle_request_for_test(&s, "imap_delete_email", json!({"account": account, "uid": uid_of(&sent, "e3"), "mailbox": "Sent", "mode": "auto"})).await;
    let v = resp.result.unwrap_or_else(|| panic!("{:?}", resp.error.map(|e| e.message)));
    assert_eq!(v["trash"], json!("Trash"), "Sent: a move to Trash: {v}");
    assert!(v["trashUid"].is_u64(), "the undo's handle: {v}");
    let labels = m.read(|st| st.email("acc1", "e3").map(|e| e.mailbox_ids.clone())).expect("e3 still on the server");
    assert!(labels.contains("mb-trash") && !labels.contains("mb-sent"), "{labels:?}");

    let trash = handle_request_for_test(&s, "imap_get_emails", json!({"account": account, "mailbox": "Trash", "page": 1, "limit": 50})).await.result.expect("listed");
    let resp = handle_request_for_test(&s, "imap_delete_email", json!({"account": account, "uid": uid_of(&trash, "e4"), "mailbox": "Trash", "mode": "auto"})).await;
    let v = resp.result.unwrap_or_else(|| panic!("{:?}", resp.error.map(|e| e.message)));
    assert_eq!((&v["trash"], &v["trashUid"]), (&Value::Null, &Value::Null), "Trash: permanent: {v}");
    assert!(v["binId"].is_string(), "the bin copy came first: {v}");
    assert!(m.read(|st| st.email("acc1", "e4").is_none()), "destroyed");
}

/// A trash-mode delete from All Mail never fetches, so a fetch error does not matter.
#[tokio::test]
async fn delete_imap_trash_gmail_all_mail_capture_fetch_err() {
    let r = run_delete(P::Imap, M::Trash, C::FetchErr, S::GmailAllMail).await;
    assert_trashed(&r, "[Gmail]/Trash", BinCopy::ByteLess);
    assert_eq!(r.body_fetches, 0);
}

/// The server no longer has the message the app is deleting (it went in
/// another client): the capture's fetch answers with no message, which is the
/// "gone already" path (`kept_already`), not a refusal. No earlier attempt kept
/// a copy, so nothing is binned and the delete itself goes ahead.
#[tokio::test]
async fn delete_imap_permanent_capture_empty_fetch_is_gone_already_not_a_refusal() {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let srv = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])));
    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-char-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acc1"}]"#);
    let resp = handle_request_for_test(&s, "imap_delete_email", json!({"account": account, "uid": 1, "mailbox": "INBOX", "mode": "permanent"})).await;
    let v = resp.result.clone().unwrap_or_else(|| panic!("expected a result, got {:?}", resp.error.as_ref().map(|e| &e.message)));
    assert_eq!(v["success"], json!(true), "{v}");
    assert_eq!(v["binId"], Value::Null, "nothing was kept, nothing to name: {v}");
    assert!(bin_rows(&s).is_empty(), "no bin row");
    assert_eq!(srv.count_commands("BODY.PEEK[]"), 1, "the capture asked for the message once");
}

/// The wire default: no `permanent` or `mode` param at all is a move to Trash.
#[tokio::test]
async fn delete_imap_absent_permanent_param_is_a_move_to_trash() {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let mut inbox = Mailbox::new("INBOX");
    inbox.add(Message::new(1, RAW).with_flags(&["\\Seen"]));
    let srv = MockImap::start(Scenario::new().mailbox(inbox).mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])));
    let account = json!({"id": "acc1", "email": "user@example.com", "password": "hunter2", "imapHost": srv.host(), "imapPort": srv.port()});
    let s = plain_state(&std::env::temp_dir().join(format!("mv-delete-char-{}", uuid::Uuid::new_v4())));
    seed_accounts(&s, r#"[{"id":"acc1"}]"#);
    let resp = handle_request_for_test(&s, "imap_delete_email", json!({"account": account, "uid": 1, "mailbox": "INBOX"})).await;
    let v = resp.result.expect("deleted");
    assert_eq!((v["trash"].clone(), v["success"].clone()), (json!("Trash"), json!(true)));
    assert!(srv.state().find("INBOX").unwrap().messages.is_empty());
}
