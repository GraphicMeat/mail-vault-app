//! The mock speaks enough RFC 5321 for a real client to hand it a message:
//! greeting, EHLO with AUTH, MAIL/RCPT/DATA, and a 550 for a recipient the
//! scenario says to refuse. What it accepts is readable back from the test.

use mock_imap::{MockImap, Scenario};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;

/// Send one command, return every reply line up to and including the last
/// (a `250-x` continuation keeps reading, a `250 x` ends the reply).
fn cmd(w: &mut TcpStream, r: &mut BufReader<TcpStream>, line: &str) -> Vec<String> {
    write!(w, "{}\r\n", line).unwrap();
    read_reply(r)
}

fn read_reply(r: &mut BufReader<TcpStream>) -> Vec<String> {
    let mut out = vec![];
    loop {
        let mut l = String::new();
        r.read_line(&mut l).unwrap();
        let l = l.trim_end().to_string();
        let last = l.len() < 4 || l.as_bytes()[3] != b'-';
        out.push(l);
        if last {
            break;
        }
    }
    out
}

/// Connect and consume the greeting.
fn connect(server: &MockImap) -> (TcpStream, BufReader<TcpStream>) {
    let w = TcpStream::connect(server.smtp_addr()).unwrap();
    let mut r = BufReader::new(w.try_clone().unwrap());
    let greeting = read_reply(&mut r);
    assert!(greeting[0].starts_with("220"), "greeting: {:?}", greeting);
    (w, r)
}

/// Hand the server a message. Returns the final reply to the terminating dot.
fn deliver(w: &mut TcpStream, r: &mut BufReader<TcpStream>, to: &str, body: &str) -> String {
    assert!(cmd(w, r, "MAIL FROM:<luke@mock.test>")[0].starts_with("250"));
    let rcpt = cmd(w, r, &format!("RCPT TO:<{}>", to));
    if !rcpt[0].starts_with("250") {
        return rcpt[0].clone();
    }
    assert!(cmd(w, r, "DATA")[0].starts_with("354"));
    write!(w, "{}\r\n.\r\n", body.replace('\n', "\r\n")).unwrap();
    read_reply(r)[0].clone()
}

#[test]
fn ehlo_advertises_auth_and_the_message_is_recorded() {
    let server = MockImap::start(Scenario::new());
    let (mut w, mut r) = connect(&server);

    let ehlo = cmd(&mut w, &mut r, "EHLO mailvault");
    assert!(ehlo[0].starts_with("250"), "{:?}", ehlo);
    let advertised = ehlo.join("\n");
    assert!(advertised.contains("AUTH"), "no AUTH in EHLO: {}", advertised);
    assert!(advertised.contains("PLAIN"), "no PLAIN in EHLO: {}", advertised);
    assert!(advertised.contains("LOGIN"), "no LOGIN in EHLO: {}", advertised);

    // AUTH PLAIN carries its blob on the command line — one round trip.
    let auth = cmd(&mut w, &mut r, "AUTH PLAIN AGx1a2VAbW9jay50ZXN0AHNlY3JldA==");
    assert!(auth[0].starts_with("235"), "{:?}", auth);

    let ok = deliver(&mut w, &mut r, "partner@example.com", "Subject: Hello\r\n\r\nBody text.");
    assert!(ok.starts_with("250"), "{}", ok);
    assert!(cmd(&mut w, &mut r, "QUIT")[0].starts_with("221"));

    let sent = server.sent_messages();
    assert_eq!(sent.len(), 1);
    let raw = String::from_utf8(sent[0].clone()).unwrap();
    assert!(raw.contains("Subject: Hello"), "{}", raw);
    assert!(raw.contains("Body text."), "{}", raw);
    // The terminating dot is protocol, not message.
    assert!(!raw.ends_with(".\r\n"), "{:?}", raw);
}

#[test]
fn auth_login_answers_both_challenges() {
    let server = MockImap::start(Scenario::new());
    let (mut w, mut r) = connect(&server);
    cmd(&mut w, &mut r, "EHLO mailvault");

    assert!(cmd(&mut w, &mut r, "AUTH LOGIN")[0].starts_with("334"));
    assert!(cmd(&mut w, &mut r, "bHVrZUBtb2NrLnRlc3Q=")[0].starts_with("334"));
    assert!(cmd(&mut w, &mut r, "c2VjcmV0")[0].starts_with("235"));
}

#[test]
fn a_refused_recipient_gets_550_and_nothing_is_accepted() {
    let server = MockImap::start(Scenario::new().smtp_refuse("@refused.test"));
    let (mut w, mut r) = connect(&server);
    cmd(&mut w, &mut r, "EHLO mailvault");

    let refused = deliver(&mut w, &mut r, "bounce@refused.test", "Subject: No\r\n\r\nx");
    assert!(refused.starts_with("550"), "{}", refused);
    assert!(server.sent_messages().is_empty());

    // Same connection, a deliverable recipient: the refusal is about the
    // address, not about the session.
    let ok = deliver(&mut w, &mut r, "partner@example.com", "Subject: Yes\r\n\r\nx");
    assert!(ok.starts_with("250"), "{}", ok);
    assert_eq!(server.sent_messages().len(), 1);
}

#[test]
fn data_with_no_accepted_recipient_is_refused() {
    let server = MockImap::start(Scenario::new().smtp_refuse("@refused.test"));
    let (mut w, mut r) = connect(&server);
    cmd(&mut w, &mut r, "EHLO mailvault");

    assert!(cmd(&mut w, &mut r, "MAIL FROM:<luke@mock.test>")[0].starts_with("250"));
    assert!(cmd(&mut w, &mut r, "RCPT TO:<bounce@refused.test>")[0].starts_with("550"));
    let data = cmd(&mut w, &mut r, "DATA");
    assert!(data[0].starts_with("554"), "{:?}", data);
    assert!(server.sent_messages().is_empty());
}

#[test]
fn two_messages_on_one_connection() {
    let server = MockImap::start(Scenario::new());
    let (mut w, mut r) = connect(&server);
    cmd(&mut w, &mut r, "EHLO mailvault");

    assert!(deliver(&mut w, &mut r, "a@example.com", "Subject: One\r\n\r\nx").starts_with("250"));
    assert!(deliver(&mut w, &mut r, "b@example.com", "Subject: Two\r\n\r\nx").starts_with("250"));

    let sent = server.sent_messages();
    assert_eq!(sent.len(), 2);
    assert!(String::from_utf8_lossy(&sent[0]).contains("Subject: One"));
    assert!(String::from_utf8_lossy(&sent[1]).contains("Subject: Two"));
}

#[test]
fn a_dot_stuffed_body_line_is_unstuffed() {
    let server = MockImap::start(Scenario::new());
    let (mut w, mut r) = connect(&server);
    cmd(&mut w, &mut r, "EHLO mailvault");

    // A body line that begins with a period is sent doubled; the server has to
    // take one off or the stored bytes are not the message that was sent.
    assert!(cmd(&mut w, &mut r, "MAIL FROM:<luke@mock.test>")[0].starts_with("250"));
    assert!(cmd(&mut w, &mut r, "RCPT TO:<a@example.com>")[0].starts_with("250"));
    assert!(cmd(&mut w, &mut r, "DATA")[0].starts_with("354"));
    write!(w, "Subject: Dots\r\n\r\n..hidden\r\nplain\r\n.\r\n").unwrap();
    assert!(read_reply(&mut r)[0].starts_with("250"));

    let raw = String::from_utf8(server.sent_messages()[0].clone()).unwrap();
    assert!(raw.contains("\r\n.hidden\r\n"), "not unstuffed: {:?}", raw);
    assert!(raw.contains("plain"), "{:?}", raw);
}

#[test]
fn smtp_listens_on_its_own_port() {
    let server = MockImap::start(Scenario::new());
    assert_ne!(server.port(), server.smtp_port());
    assert_ne!(server.smtp_port(), 0);
}

#[test]
fn the_commands_it_received_are_readable() {
    let server = MockImap::start(Scenario::new());
    let (mut w, mut r) = connect(&server);
    cmd(&mut w, &mut r, "EHLO mailvault");
    deliver(&mut w, &mut r, "a@example.com", "Subject: Log\r\n\r\nx");

    let log = server.smtp_commands();
    assert!(log.iter().any(|l| l.starts_with("EHLO")), "{:?}", log);
    assert!(log.iter().any(|l| l.starts_with("RCPT TO:<a@example.com>")), "{:?}", log);
    // DATA content is not a command line.
    assert!(!log.iter().any(|l| l.contains("Subject: Log")), "{:?}", log);
}
