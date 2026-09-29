//! The mock's Gmail label model, commands it turns away without running, the
//! search keys a scoped listing needs, and opt-in strict capability checks.
//!
//! Each of these exists so a job that lists, moves and expunges on a real
//! account can be tested for the refusals a real account hands out.
use mock_imap::state::{synthetic_mailbox, Mailbox, Message};
use mock_imap::{Action, GmailMsg, MockImap, Scenario, Trigger};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

struct Client {
    w: TcpStream,
    r: BufReader<TcpStream>,
    n: u32,
}

impl Client {
    fn connect(server: &MockImap) -> Client {
        let w = TcpStream::connect(server.addr()).unwrap();
        w.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let r = BufReader::new(w.try_clone().unwrap());
        let mut c = Client { w, r, n: 0 };
        let mut greeting = String::new();
        c.r.read_line(&mut greeting).unwrap();
        c.send("LOGIN user@example.com hunter2");
        c
    }

    fn select(server: &MockImap, mailbox: &str) -> Client {
        let mut c = Client::connect(server);
        let out = c.send(&format!("SELECT \"{}\"", mailbox));
        assert!(status(&out).contains(" OK "), "{out:?}");
        c
    }

    /// Send one tagged command; every line up to and including its tagged reply.
    fn send(&mut self, line: &str) -> Vec<String> {
        self.n += 1;
        let tag = format!("t{}", self.n);
        write!(self.w, "{} {}\r\n", tag, line).unwrap();
        let mut out = vec![];
        loop {
            let mut l = String::new();
            let n = self.r.read_line(&mut l).unwrap();
            assert!(n > 0, "connection closed while waiting for {tag}: {out:?}");
            let l = l.trim_end().to_string();
            let done = l.starts_with(&format!("{} ", tag));
            out.push(l);
            if done {
                return out;
            }
        }
    }
}

/// The tagged reply line.
fn status(lines: &[String]) -> &str {
    lines.last().unwrap()
}

fn eml(subject: &str) -> String {
    format!(
        "From: a@example.com\nTo: b@example.com\nSubject: {subject}\nMessage-ID: <{subject}@example.com>\n\nbody\n"
    )
}

fn uids(server: &MockImap, mailbox: &str) -> Vec<u32> {
    server.state().find(mailbox).unwrap().messages.iter().map(|m| m.uid).collect()
}

fn gm_ids(server: &MockImap, mailbox: &str) -> Vec<u64> {
    server
        .state()
        .find(mailbox)
        .unwrap()
        .messages
        .iter()
        .map(|m| m.gm_msgid.unwrap())
        .collect()
}

/// Three messages: 111 in INBOX and Work, 222 in Work only, 333 in All Mail only.
fn gmail_server() -> MockImap {
    MockImap::start(
        Scenario::gmail()
            .gmail_message(GmailMsg::new(eml("one")).labels(&["\\Inbox", "Work"]).gm_msgid(111))
            .gmail_message(GmailMsg::new(eml("two")).labels(&["Work"]).gm_msgid(222))
            .gmail_message(GmailMsg::new(eml("three")).gm_msgid(333)),
    )
}

const ALL_MAIL: &str = "[Gmail]/All Mail";
const TRASH: &str = "[Gmail]/Trash";
const SPAM: &str = "[Gmail]/Spam";

// ── Gmail model ─────────────────────────────────────────────────────────────

#[test]
fn the_gmail_scenario_advertises_x_gm_ext_1_and_the_special_folders() {
    let server = gmail_server();
    let mut c = Client::connect(&server);
    let caps = c.send("CAPABILITY");
    assert!(caps.iter().any(|l| l.contains("X-GM-EXT-1")), "{caps:?}");

    let list = c.send("LIST \"\" \"*\"");
    let has = |name: &str, attr: &str| list.iter().any(|l| l.contains(name) && l.contains(attr));
    assert!(has("[Gmail]/All Mail", "\\All"), "{list:?}");
    assert!(has("[Gmail]/Trash", "\\Trash"), "{list:?}");
    assert!(has("[Gmail]/Spam", "\\Junk"), "{list:?}");

    // One copy per label folder plus All Mail, each with its own uid.
    assert_eq!(uids(&server, "INBOX"), vec![1]);
    assert_eq!(uids(&server, "Work"), vec![1, 2]);
    assert_eq!(uids(&server, ALL_MAIL), vec![1, 2, 3]);
    assert_eq!(gm_ids(&server, ALL_MAIL), vec![111, 222, 333]);
}

#[test]
fn a_spam_or_trash_labelled_message_stays_out_of_all_mail() {
    let server = MockImap::start(
        Scenario::gmail()
            .gmail_message(GmailMsg::new(eml("junk")).labels(&["\\Spam"]).gm_msgid(7))
            .gmail_message(GmailMsg::new(eml("bin")).labels(&["\\Trash"]).gm_msgid(8)),
    );
    assert_eq!(gm_ids(&server, SPAM), vec![7]);
    assert_eq!(gm_ids(&server, TRASH), vec![8]);
    assert!(uids(&server, ALL_MAIL).is_empty());
}

#[test]
fn gmail_move_to_trash_removes_every_label_copy() {
    let server = gmail_server();
    let mut c = Client::select(&server, "Work");

    let out = c.send(&format!("UID MOVE 1 \"{}\"", TRASH));
    assert!(status(&out).contains(" OK "), "{out:?}");
    assert!(out.iter().any(|l| l.contains("COPYUID")), "the Trash uid is reported: {out:?}");

    // 111 left INBOX, Work and All Mail, and one copy is in Trash.
    assert!(uids(&server, "INBOX").is_empty());
    assert_eq!(gm_ids(&server, "Work"), vec![222]);
    assert_eq!(gm_ids(&server, ALL_MAIL), vec![222, 333]);
    assert_eq!(gm_ids(&server, TRASH), vec![111]);
    // The selected mailbox is told about its own removal.
    assert!(out.iter().any(|l| l == "* 1 EXPUNGE"), "{out:?}");
}

#[test]
fn gmail_copy_to_trash_also_takes_the_message_out_of_every_folder() {
    let server = gmail_server();
    let mut c = Client::select(&server, "INBOX");
    let out = c.send(&format!("UID COPY 1 \"{}\"", TRASH));
    assert!(status(&out).contains(" OK "), "{out:?}");
    assert!(uids(&server, "INBOX").is_empty());
    assert_eq!(gm_ids(&server, "Work"), vec![222]);
    assert_eq!(gm_ids(&server, ALL_MAIL), vec![222, 333]);
    assert_eq!(gm_ids(&server, TRASH), vec![111]);
}

#[test]
fn gmail_move_out_of_a_label_keeps_all_mail() {
    let server = gmail_server();
    let mut c = Client::select(&server, "Work");

    // 222 moves from label Work to label INBOX.
    let out = c.send("UID MOVE 2 INBOX");
    assert!(status(&out).contains(" OK "), "{out:?}");
    assert_eq!(gm_ids(&server, "Work"), vec![111]);
    assert_eq!(gm_ids(&server, "INBOX"), vec![111, 222]);
    assert_eq!(gm_ids(&server, ALL_MAIL), vec![111, 222, 333], "All Mail keeps every message");
}

#[test]
fn gmail_expunge_out_of_a_label_keeps_the_other_copies() {
    let server = gmail_server();
    let mut c = Client::select(&server, "INBOX");
    assert!(status(&c.send("UID STORE 1 +FLAGS (\\Deleted)")).contains(" OK "));
    let out = c.send("EXPUNGE");
    assert!(status(&out).contains(" OK "), "{out:?}");
    assert!(uids(&server, "INBOX").is_empty());
    assert_eq!(gm_ids(&server, "Work"), vec![111, 222]);
    assert_eq!(gm_ids(&server, ALL_MAIL), vec![111, 222, 333]);
}

#[test]
fn gmail_all_mail_keeps_its_copy_when_a_label_is_added() {
    let server = gmail_server();
    let mut c = Client::select(&server, ALL_MAIL);
    let out = c.send("UID MOVE 3 INBOX");
    assert!(status(&out).contains(" OK "), "{out:?}");
    assert_eq!(gm_ids(&server, ALL_MAIL), vec![111, 222, 333]);
    assert_eq!(gm_ids(&server, "INBOX"), vec![111, 333]);
    assert!(!out.iter().any(|l| l.contains("EXPUNGE")), "All Mail lost nothing: {out:?}");
}

#[test]
fn x_gm_msgid_and_labels_are_fetched() {
    let server = gmail_server();
    let mut c = Client::select(&server, "INBOX");
    let out = c.send("UID FETCH 1 (UID X-GM-MSGID X-GM-LABELS)");
    let line = &out[0];
    assert!(line.contains("X-GM-MSGID 111"), "{line}");
    // System labels are bare, user labels quoted; All Mail is not a label.
    assert!(line.contains("X-GM-LABELS (\\Inbox \"Work\")"), "{line}");

    // A message with no label at all: an empty list.
    let mut all = Client::select(&server, ALL_MAIL);
    let out = all.send("UID FETCH 3 (UID X-GM-MSGID X-GM-LABELS)");
    assert!(out[0].contains("X-GM-MSGID 333"), "{}", out[0]);
    assert!(out[0].contains("X-GM-LABELS ()"), "{}", out[0]);
}

#[test]
fn a_starred_label_reads_back_as_a_system_label() {
    let server = gmail_server();
    server.mutate(|st| {
        // New mail arriving through another client.
        st.add_gmail_message(GmailMsg::new(eml("one")).labels(&["\\Starred"]).gm_msgid(444));
    });
    let mut c = Client::select(&server, "[Gmail]/Starred");
    let out = c.send("UID FETCH 1 (X-GM-LABELS)");
    assert!(out[0].contains("X-GM-LABELS (\\Starred)"), "{}", out[0]);
}

#[test]
fn search_by_x_gm_msgid() {
    let server = gmail_server();
    let mut c = Client::select(&server, ALL_MAIL);
    let out = c.send("UID SEARCH X-GM-MSGID 222");
    assert_eq!(out[0], "* SEARCH 2", "{out:?}");

    // Copies of one message are found in every folder that holds them, under
    // that folder's own uid (or sequence number).
    let mut work = Client::select(&server, "Work");
    assert_eq!(work.send("UID SEARCH X-GM-MSGID 111")[0], "* SEARCH 1");
    assert_eq!(work.send("SEARCH X-GM-MSGID 222")[0], "* SEARCH 2");
    assert_eq!(work.send("UID SEARCH X-GM-MSGID 333")[0], "* SEARCH", "333 has no Work copy");
    assert!(status(&work.send("UID SEARCH X-GM-MSGID nope")).contains(" BAD "));
}

// ── refusals ────────────────────────────────────────────────────────────────

#[test]
fn refuse_with_does_not_run_the_command() {
    let scenario = |action: Action| {
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 2))
            .fault(Trigger::on("STORE"), action)
    };
    let flagged = |server: &MockImap| server.state().find("INBOX").unwrap().by_uid(1).unwrap().has_flag("\\Deleted");

    // The control: `Respond` rewrites the reply and the STORE still runs.
    let ran = MockImap::start(scenario(Action::Respond("NO".into(), "[THROTTLED] slow down".into())));
    let mut c = Client::select(&ran, "INBOX");
    assert!(status(&c.send("UID STORE 1 +FLAGS (\\Deleted)")).contains(" NO "));
    assert!(flagged(&ran), "Respond still ran the command");

    let refused = MockImap::start(scenario(Action::throttled()));
    let mut c = Client::select(&refused, "INBOX");
    let out = c.send("UID STORE 1 +FLAGS (\\Deleted)");
    assert_eq!(out.len(), 1, "no untagged data: {out:?}");
    assert!(out[0].starts_with("t3 NO [THROTTLED]"), "{out:?}");
    assert!(!flagged(&refused), "RefuseWith did not run the command");
    assert_eq!(refused.count_commands("STORE"), 1, "the client did send it");

    // The connection survives the refusal and the next command works.
    assert!(status(&c.send("NOOP")).contains(" OK "));
}

#[test]
fn refuse_with_carries_gmails_bandwidth_wording() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 1))
            .fault(Trigger::on("FETCH"), Action::gmail_bandwidth_limit()),
    );
    let mut c = Client::select(&server, "INBOX");
    let out = c.send("UID FETCH 1 (UID)");
    assert!(out[0].contains("NO [ALERT] Account exceeded command or bandwidth limits"), "{out:?}");

    let Action::RefuseWith(status, text) = Action::too_many_connections() else { panic!() };
    assert_eq!(status, "NO");
    assert!(text.contains("[ALERT] Too many simultaneous connections"));
    let Action::RefuseWith(_, text) = Action::overquota() else { panic!() };
    assert!(text.contains("[OVERQUOTA]"));
}

#[test]
fn refuse_with_can_hit_one_nth_command_only() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .fault(Trigger::nth("FETCH", 2), Action::throttled()),
    );
    let mut c = Client::select(&server, "INBOX");
    assert!(status(&c.send("UID FETCH 1 (UID)")).contains(" OK "));
    assert!(status(&c.send("UID FETCH 2 (UID)")).contains(" NO [THROTTLED]"));
    assert!(status(&c.send("UID FETCH 3 (UID)")).contains(" OK "));
}

#[test]
fn bye_and_close_does_not_run_the_command() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 2))
            .fault(Trigger::on("EXPUNGE"), Action::ByeAndClose("[ALERT] Too many commands".into())),
    );
    let mut c = Client::select(&server, "INBOX");
    assert!(status(&c.send("UID STORE 1 +FLAGS (\\Deleted)")).contains(" OK "));

    write!(c.w, "x1 EXPUNGE\r\n").unwrap();
    let mut first = String::new();
    c.r.read_line(&mut first).unwrap();
    assert_eq!(first.trim_end(), "* BYE [ALERT] Too many commands");
    let mut eof = String::new();
    assert_eq!(c.r.read_line(&mut eof).unwrap(), 0, "the server hung up: {eof:?}");

    // The message flagged \Deleted was not expunged.
    assert_eq!(uids(&server, "INBOX"), vec![1, 2]);
}

// ── search keys ─────────────────────────────────────────────────────────────

fn gapped_server() -> MockImap {
    // uids 10, 20, 30: sequence numbers 1, 2, 3.
    let mut mb = Mailbox::new("INBOX");
    for uid in [10u32, 20, 30] {
        mb.add(Message::new(uid, eml(&format!("m{uid}"))));
    }
    MockImap::start(Scenario::new().mailbox(mb))
}

#[test]
fn uid_set_key_in_search() {
    let server = gapped_server();
    let mut c = Client::select(&server, "INBOX");
    assert_eq!(c.send("UID SEARCH UID 20:30")[0], "* SEARCH 20 30");
    assert_eq!(c.send("UID SEARCH UID 10,30")[0], "* SEARCH 10 30");
    assert_eq!(c.send("UID SEARCH UID 20:*")[0], "* SEARCH 20 30");
    assert_eq!(c.send("UID SEARCH UID 11:19")[0], "* SEARCH");
    // Combined with another key, both must hold.
    assert_eq!(c.send("UID SEARCH UID 10:20 SUBJECT m20")[0], "* SEARCH 20");
    assert_eq!(c.send("UID SEARCH NOT UID 20")[0], "* SEARCH 10 30");
    assert!(status(&c.send("UID SEARCH UID abc")).contains(" BAD "));
}

#[test]
fn a_bare_sequence_set_matches_by_sequence_number() {
    let server = gapped_server();
    let mut c = Client::select(&server, "INBOX");
    assert_eq!(c.send("SEARCH 2:3")[0], "* SEARCH 2 3");
    assert_eq!(c.send("SEARCH 1,3")[0], "* SEARCH 1 3");
    // UID SEARCH answers in uids, but a bare set is still sequence numbers.
    assert_eq!(c.send("UID SEARCH 2:3")[0], "* SEARCH 20 30");
    assert_eq!(c.send("SEARCH 2:*")[0], "* SEARCH 2 3");
}

#[test]
fn unparseable_since_is_bad() {
    let server = gapped_server();
    let mut c = Client::select(&server, "INBOX");
    let out = c.send("SEARCH SINCE notadate");
    assert!(status(&out).contains(" BAD "), "{out:?}");
    assert!(status(&c.send("UID SEARCH BEFORE 2026-01-01")).contains(" BAD "));
    // A good date still searches (the default INTERNALDATE is 01-Jan-2026).
    assert_eq!(c.send("SEARCH SINCE 01-Jan-2026")[0], "* SEARCH 1 2 3");
    assert_eq!(c.send("SEARCH BEFORE 01-Jan-2026")[0], "* SEARCH");
}

#[test]
fn a_bad_search_is_bad_even_on_an_empty_mailbox() {
    let server = MockImap::start(Scenario::new());
    let mut c = Client::select(&server, "INBOX");
    assert!(status(&c.send("SEARCH SINCE notadate")).contains(" BAD "));
}

// ── INTERNALDATE ────────────────────────────────────────────────────────────

#[test]
fn internal_date_is_controllable_per_message_and_zone() {
    // 2024-12-31T22:30:00Z, stamped by two servers in different zones.
    let ms = 1_735_684_200_000i64;
    let mut mb = Mailbox::new("INBOX");
    mb.add(Message::new(1, eml("utc")).with_internal_ms(ms));
    mb.add(Message::new(2, eml("east")).with_internal_at(ms, 120));
    let server = MockImap::start(Scenario::new().mailbox(mb));
    let mut c = Client::select(&server, "INBOX");
    let out = c.send("UID FETCH 1:2 (UID INTERNALDATE)");
    assert!(out[0].contains("\"31-Dec-2024 22:30:00 +0000\""), "{}", out[0]);
    assert!(out[1].contains("\"01-Jan-2025 00:30:00 +0200\""), "{}", out[1]);
    // SEARCH compares the date as stamped, the way RFC 3501 says.
    assert_eq!(c.send("UID SEARCH BEFORE 01-Jan-2025")[0], "* SEARCH 1");
    assert_eq!(c.send("UID SEARCH SINCE 01-Jan-2025")[0], "* SEARCH 2");
}

// ── strict capabilities ─────────────────────────────────────────────────────

fn two_folder_scenario() -> Scenario {
    Scenario::new()
        .mailbox(synthetic_mailbox("INBOX", 2))
        .mailbox(Mailbox::new("Other"))
}

#[test]
fn strict_caps_refuse_move_and_uid_expunge() {
    let server = MockImap::start(two_folder_scenario().strict_caps().without_cap("MOVE").without_cap("UIDPLUS"));
    let mut c = Client::select(&server, "INBOX");
    assert!(status(&c.send("UID MOVE 1 Other")).contains(" BAD "));
    assert!(status(&c.send("MOVE 1 Other")).contains(" BAD "));
    assert!(status(&c.send("UID EXPUNGE 1")).contains(" BAD "));
    assert_eq!(uids(&server, "INBOX"), vec![1, 2], "nothing ran");
    assert!(uids(&server, "Other").is_empty());

    // What the server does have still works: COPY (with no COPYUID, as
    // UIDPLUS is off) and a plain EXPUNGE.
    let out = c.send("UID COPY 1 Other");
    assert!(status(&out).contains(" OK ") && !status(&out).contains("COPYUID"), "{out:?}");
    assert!(status(&c.send("EXPUNGE")).contains(" OK "));
}

#[test]
fn strict_caps_allow_what_is_advertised() {
    let server = MockImap::start(two_folder_scenario().strict_caps());
    let mut c = Client::select(&server, "INBOX");
    let out = c.send("UID MOVE 1 Other");
    assert!(status(&out).contains(" OK "), "{out:?}");
    assert!(out.iter().any(|l| l.contains("COPYUID")));
    assert!(status(&c.send("UID EXPUNGE 2")).contains(" OK "));
}

#[test]
fn without_strict_caps_a_missing_capability_is_still_tolerated() {
    let server = MockImap::start(two_folder_scenario().without_cap("MOVE").without_cap("UIDPLUS"));
    let mut c = Client::select(&server, "INBOX");
    assert!(status(&c.send("UID MOVE 1 Other")).contains(" OK "));
    assert!(status(&c.send("UID EXPUNGE 2")).contains(" OK "));
}

#[test]
fn unknown_fetch_item_is_bad_in_strict_mode() {
    let strict = MockImap::start(two_folder_scenario().strict_caps());
    let mut c = Client::select(&strict, "INBOX");
    assert!(status(&c.send("UID FETCH 1 (UID FROBNICATE)")).contains(" BAD "));
    // Gmail items need the capability.
    assert!(status(&c.send("UID FETCH 1 (UID X-GM-MSGID)")).contains(" BAD "));
    assert!(status(&c.send("UID FETCH 1 (UID FLAGS RFC822.SIZE INTERNALDATE)")).contains(" OK "));

    // Lenient by default: the unknown item is dropped, the rest answers.
    let lenient = MockImap::start(two_folder_scenario());
    let mut c = Client::select(&lenient, "INBOX");
    let out = c.send("UID FETCH 1 (UID FROBNICATE)");
    assert!(status(&out).contains(" OK "), "{out:?}");
    assert!(out[0].contains("UID 1"));

    // A strict Gmail server knows its own items.
    let gmail = MockImap::start(
        Scenario::gmail().strict_caps().gmail_message(GmailMsg::new(eml("a")).gm_msgid(5)),
    );
    let mut c = Client::select(&gmail, ALL_MAIL);
    let out = c.send("UID FETCH 1 (UID X-GM-MSGID X-GM-LABELS)");
    assert!(status(&out).contains(" OK ") && out[0].contains("X-GM-MSGID 5"), "{out:?}");
}

// ── COPYUID / UID EXPUNGE scoping ───────────────────────────────────────────

#[test]
fn uid_expunge_removes_only_the_named_deleted_uids() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
    let mut c = Client::select(&server, "INBOX");
    assert!(status(&c.send("UID STORE 1:3 +FLAGS (\\Deleted)")).contains(" OK "));
    let out = c.send("UID EXPUNGE 2");
    assert!(status(&out).contains(" OK "), "{out:?}");
    // 1 and 3 are \Deleted too, and another client's flags are not this
    // client's to expunge.
    assert_eq!(uids(&server, "INBOX"), vec![1, 3]);
}

#[test]
fn move_reports_copyuid_for_each_moved_uid() {
    let server = MockImap::start(
        Scenario::new()
            .mailbox(synthetic_mailbox("INBOX", 3))
            .mailbox(Mailbox::new("Trash").with_attrs(&["\\Trash"])),
    );
    let mut c = Client::select(&server, "INBOX");
    let out = c.send("UID MOVE 1,3 Trash");
    let copyuid = out.iter().find(|l| l.contains("COPYUID")).unwrap();
    assert!(copyuid.contains("COPYUID 1 1,3 1,2"), "{copyuid}");
    assert_eq!(uids(&server, "INBOX"), vec![2]);
    assert_eq!(uids(&server, "Trash"), vec![1, 2]);
}
