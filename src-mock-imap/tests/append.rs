//! APPEND's tagged reply names the new message's uid (`[APPENDUID validity uid]`)
//! only on a server that advertises UIDPLUS (RFC 4315), the way COPYUID does. A
//! server without it says nothing, and a client has to find the message itself.
use mock_imap::state::synthetic_mailbox;
use mock_imap::{MockImap, Scenario};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;

/// APPEND one message to INBOX over a raw socket and return the tagged reply line.
fn append_reply(server: &MockImap) -> String {
    let mut w = TcpStream::connect(server.addr()).unwrap();
    let mut r = BufReader::new(w.try_clone().unwrap());
    let mut line = String::new();
    r.read_line(&mut line).unwrap(); // greeting
    write!(w, "a1 LOGIN user@example.com hunter2\r\n").unwrap();
    loop {
        line.clear();
        r.read_line(&mut line).unwrap();
        if line.starts_with("a1 ") {
            break;
        }
    }
    let msg = "Subject: appended\r\nMessage-ID: <appended@example.com>\r\n\r\nhi";
    write!(w, "a2 APPEND INBOX {{{}+}}\r\n{}\r\n", msg.len(), msg).unwrap();
    loop {
        line.clear();
        r.read_line(&mut line).unwrap();
        if line.starts_with("a2 ") {
            return line.trim_end().to_string();
        }
    }
}

fn inbox(uidplus: bool) -> MockImap {
    let mut mb = synthetic_mailbox("INBOX", 4).with_uid_validity(77);
    mb.uid_next = 5;
    let s = Scenario::new().mailbox(mb);
    MockImap::start(if uidplus { s } else { s.without_cap("UIDPLUS") })
}

#[test]
fn append_with_uidplus_reports_the_validity_and_the_new_uid() {
    let server = inbox(true);
    assert_eq!(append_reply(&server), "a2 OK [APPENDUID 77 5] APPEND completed");
    assert_eq!(server.state().find("INBOX").unwrap().messages.len(), 5);
}

#[test]
fn append_without_uidplus_says_nothing_about_the_uid() {
    let server = inbox(false);
    assert_eq!(append_reply(&server), "a2 OK APPEND completed");
    // The message is stored all the same: only the reply differs.
    assert_eq!(server.state().find("INBOX").unwrap().messages.len(), 5);
}
