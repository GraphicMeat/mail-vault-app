//! The mock speaks IDLE: `+ idling`, unsolicited EXISTS/FETCH while state
//! changes underneath it, `DONE` ends it. This is what the daemon watcher runs against.
use mock_imap::state::synthetic_mailbox;
use mock_imap::{Message, MockImap, Scenario};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

fn cmd(w: &mut TcpStream, r: &mut BufReader<TcpStream>, line: &str) -> Vec<String> {
    write!(w, "{}\r\n", line).unwrap();
    let tag = line.split(' ').next().unwrap();
    let mut out = vec![];
    loop {
        let mut l = String::new();
        r.read_line(&mut l).unwrap();
        let l = l.trim_end().to_string();
        let done = l.starts_with(tag);
        out.push(l);
        if done {
            break;
        }
    }
    out
}

/// Connect, log in and SELECT INBOX — every IDLE test starts here.
fn selected(server: &MockImap) -> (TcpStream, BufReader<TcpStream>) {
    let mut w = TcpStream::connect(server.addr()).unwrap();
    let mut r = BufReader::new(w.try_clone().unwrap());
    let mut greeting = String::new();
    r.read_line(&mut greeting).unwrap();
    cmd(&mut w, &mut r, "a1 LOGIN user@example.com hunter2");
    cmd(&mut w, &mut r, "a2 SELECT INBOX");
    (w, r)
}

#[test]
fn idle_reports_new_mail_and_ends_on_done() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
    let (mut w, mut r) = selected(&server);

    write!(w, "a3 IDLE\r\n").unwrap();
    let mut l = String::new();
    r.read_line(&mut l).unwrap();
    assert!(l.starts_with("+ "), "continuation expected, got {l}");

    server.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        let uid = mb.uid_next;
        mb.add(Message::new(uid, "Subject: new\r\n\r\nhi"));
    });

    r.get_ref().set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut l = String::new();
    r.read_line(&mut l).unwrap();
    assert_eq!(l.trim_end(), "* 3 EXISTS");

    write!(w, "DONE\r\n").unwrap();
    let mut l = String::new();
    r.read_line(&mut l).unwrap();
    assert!(l.starts_with("a3 OK"), "{l}");
    assert_eq!(server.count_commands("IDLE"), 1);
    assert_eq!(server.count_commands("DONE"), 1);
}

#[test]
fn idle_reports_a_flag_change_as_fetch() {
    let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
    let (mut w, mut r) = selected(&server);

    write!(w, "a3 IDLE\r\n").unwrap();
    let mut l = String::new();
    r.read_line(&mut l).unwrap();
    assert!(l.starts_with("+ "), "continuation expected, got {l}");

    server.mutate(|st| {
        let mb = st.find_mut("INBOX").unwrap();
        mb.highest_modseq += 1;
        let modseq = mb.highest_modseq;
        let msg = mb.by_uid_mut(1).unwrap();
        msg.flags.push("\\Seen".to_string());
        msg.modseq = modseq;
    });

    r.get_ref().set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut l = String::new();
    r.read_line(&mut l).unwrap();
    assert_eq!(l.trim_end(), "* 1 FETCH (FLAGS (\\Seen))");

    write!(w, "DONE\r\n").unwrap();
    let mut l = String::new();
    r.read_line(&mut l).unwrap();
    assert!(l.starts_with("a3 OK"), "{l}");
}

/// IDLE is advertised, or the daemon's watcher would never try it.
#[test]
fn idle_is_a_default_capability() {
    let server = MockImap::start(Scenario::new());
    let mut w = TcpStream::connect(server.addr()).unwrap();
    let mut r = BufReader::new(w.try_clone().unwrap());
    let mut greeting = String::new();
    r.read_line(&mut greeting).unwrap();

    let lines = cmd(&mut w, &mut r, "a1 CAPABILITY");

    assert!(lines.iter().any(|l| l.contains("IDLE")), "{lines:?}");
}
