//! Minimal RFC 5321 responder, on its own loopback port beside the IMAP one.
//!
//! It exists so a send can SUCCEED in a test. Before it, the e2e harness
//! pointed `smtpHost`/`smtpPort` at the IMAP mock, so every send died on the
//! wire and the whole success path — outbox completion, the APPEND to the
//! server's Sent folder, the Sent-header refresh — was unreachable.
//!
//! What it does with an accepted message: nothing but remember it.
//! `MockImap::sent_messages()` hands the raw bytes back. It deliberately does
//! NOT file the message into the Sent mailbox — MailVault APPENDs its own Sent
//! copy over IMAP once SMTP returns (`src-tauri/src/commands.rs`, the
//! `send-server-append-complete` path), so a mock that also filed one would put
//! two copies in Sent and misrepresent every provider the app actually talks to.
//!
//! Failure on demand is `SmtpScenario::refuse_recipient`: a recipient whose
//! address contains that needle is answered `550` at RCPT TO. Recipient-scoped
//! rather than global because one mock server serves the whole e2e run — a
//! per-run switch could not be flipped by a single spec, but the address a
//! spec types is its own.

use crate::scenario::SmtpScenario;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Everything the SMTP side shares with the test that started it.
pub(crate) struct SmtpRecorder {
    /// Raw RFC 5322 bytes of every accepted message, in order.
    pub accepted: Mutex<Vec<Vec<u8>>>,
    /// Every command line received, in order. DATA content is not a command.
    pub log: Mutex<Vec<String>>,
}

impl SmtpRecorder {
    pub fn new() -> Self {
        SmtpRecorder { accepted: Mutex::new(Vec::new()), log: Mutex::new(Vec::new()) }
    }
}

pub(crate) fn start(
    config: SmtpScenario,
    stop: Arc<AtomicBool>,
    recorder: Arc<SmtpRecorder>,
) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock smtp");
    let addr = listener.local_addr().expect("smtp local_addr");

    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(conn) = conn else { continue };
            let (config, recorder) = (config.clone(), recorder.clone());
            std::thread::spawn(move || {
                let _ = handle_conn(conn, config, recorder);
            });
        }
    });

    addr
}

fn handle_conn(
    conn: TcpStream,
    config: SmtpScenario,
    recorder: Arc<SmtpRecorder>,
) -> std::io::Result<()> {
    conn.set_nodelay(true)?;
    let mut out = conn.try_clone()?;
    let mut reader = BufReader::new(conn);

    reply(&mut out, "220 mock.test MockSMTP ready")?;

    // Recipients accepted for the transaction in progress. MAIL FROM starts a
    // new one; DATA and RSET end it.
    let mut recipients: Vec<String> = Vec::new();

    loop {
        let Some(line) = read_command(&mut reader)? else { return Ok(()) };
        if line.trim().is_empty() {
            continue;
        }
        recorder.log.lock().unwrap().push(line.clone());

        let verb = line
            .split([' ', ':'])
            .next()
            .unwrap_or("")
            .to_uppercase();
        let rest = line[verb.len().min(line.len())..].trim_start_matches([' ', ':']).to_string();

        match verb.as_str() {
            "EHLO" => {
                // 8BITMIME and SMTPUTF8 are advertised because lettre refuses
                // to send a non-ASCII message or envelope without them, and a
                // subject with an emoji is a normal thing for a test to type.
                out.write_all(
                    b"250-mock.test\r\n\
                      250-8BITMIME\r\n\
                      250-SMTPUTF8\r\n\
                      250-AUTH PLAIN LOGIN\r\n\
                      250 HELP\r\n",
                )?;
                out.flush()?;
            }
            "HELO" => reply(&mut out, "250 mock.test")?,
            "AUTH" => authenticate(&mut reader, &mut out, &rest, &recorder)?,
            "MAIL" => {
                recipients.clear();
                reply(&mut out, "250 2.1.0 Ok")?;
            }
            "RCPT" => {
                let addr = angle_addr(&rest);
                if refuses(&config, &addr) {
                    reply(&mut out, &format!("550 5.7.1 <{}>: Recipient address rejected", addr))?;
                } else {
                    recipients.push(addr);
                    reply(&mut out, "250 2.1.5 Ok")?;
                }
            }
            "DATA" => {
                if recipients.is_empty() {
                    reply(&mut out, "554 5.5.1 Error: no valid recipients")?;
                    continue;
                }
                reply(&mut out, "354 End data with <CR><LF>.<CR><LF>")?;
                let message = read_message(&mut reader)?;
                let n = {
                    let mut accepted = recorder.accepted.lock().unwrap();
                    accepted.push(message);
                    accepted.len()
                };
                recipients.clear();
                reply(&mut out, &format!("250 2.0.0 Ok: queued as MOCK{}", n))?;
            }
            "RSET" => {
                recipients.clear();
                reply(&mut out, "250 2.0.0 Ok")?;
            }
            "NOOP" => reply(&mut out, "250 2.0.0 Ok")?,
            "QUIT" => {
                reply(&mut out, "221 2.0.0 Bye")?;
                return Ok(());
            }
            _ => reply(&mut out, "502 5.5.2 Command not implemented")?,
        }
    }
}

/// Any credentials are accepted — the IMAP half does the same. What matters is
/// completing whichever mechanism the client picked, since lettre aborts the
/// connection if the AUTH exchange does not end in a 235.
fn authenticate(
    reader: &mut BufReader<TcpStream>,
    out: &mut TcpStream,
    rest: &str,
    recorder: &Arc<SmtpRecorder>,
) -> std::io::Result<()> {
    let mut parts = rest.split_whitespace();
    let mechanism = parts.next().unwrap_or("").to_uppercase();
    let initial = parts.next();

    let challenges = match mechanism.as_str() {
        // `AUTH PLAIN <blob>` is done in one line; a bare `AUTH PLAIN` needs one.
        "PLAIN" => usize::from(initial.is_none()),
        "LOGIN" => 2 - usize::from(initial.is_some()),
        _ => return reply(out, "504 5.5.4 Unrecognized authentication type"),
    };

    // The prompts are the conventional base64 of "Username:" / "Password:".
    const PROMPTS: [&str; 2] = ["334 VXNlcm5hbWU6", "334 UGFzc3dvcmQ6"];
    for i in 0..challenges {
        let prompt = if mechanism == "LOGIN" { PROMPTS[2 - challenges + i] } else { "334 " };
        reply(out, prompt)?;
        match read_command(reader)? {
            Some(answer) => recorder.log.lock().unwrap().push(answer),
            None => return Ok(()), // client hung up mid-exchange
        }
    }

    reply(out, "235 2.7.0 Authentication successful")
}

/// One command line, or `None` at EOF. CRLF stripped.
fn read_command(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<String>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    Ok(Some(line.trim_end_matches(['\r', '\n']).to_string()))
}

/// Read DATA content up to the `CRLF.CRLF` terminator, undoing dot-stuffing.
/// Read as bytes: the client is free to hand us a body we cannot decode, and
/// what the test asserts on has to be what crossed the wire.
fn read_message(reader: &mut BufReader<TcpStream>) -> std::io::Result<Vec<u8>> {
    let mut message = Vec::new();
    loop {
        let mut line = Vec::new();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(message); // EOF mid-message: keep what arrived
        }
        let content = strip_crlf(&line);
        if content == b"." {
            // The last line's CRLF belongs to the terminator, not the message.
            if message.ends_with(b"\r\n") {
                message.truncate(message.len() - 2);
            }
            return Ok(message);
        }
        // RFC 5321 §4.5.2: a leading period the client doubled.
        let content = content.strip_prefix(b".").unwrap_or(content);
        message.extend_from_slice(content);
        message.extend_from_slice(b"\r\n");
    }
}

fn strip_crlf(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
        end -= 1;
    }
    &line[..end]
}

/// The address out of `TO:<a@b.c> PARAM=1`, or the whole argument if it carries
/// no angle brackets (some clients omit them).
fn angle_addr(rest: &str) -> String {
    let rest = rest.trim();
    match (rest.find('<'), rest.find('>')) {
        (Some(open), Some(close)) if close > open => rest[open + 1..close].to_string(),
        _ => rest.split_whitespace().next().unwrap_or("").to_string(),
    }
}

fn refuses(config: &SmtpScenario, addr: &str) -> bool {
    config
        .refuse_recipient
        .as_deref()
        .is_some_and(|needle| addr.to_lowercase().contains(&needle.to_lowercase()))
}

fn reply(out: &mut TcpStream, line: &str) -> std::io::Result<()> {
    out.write_all(line.as_bytes())?;
    out.write_all(b"\r\n")?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angle_addr_reads_the_address_out_of_a_rcpt_argument() {
        assert_eq!(angle_addr("<a@b.c>"), "a@b.c");
        assert_eq!(angle_addr("<a@b.c> NOTIFY=NEVER"), "a@b.c");
        assert_eq!(angle_addr("a@b.c"), "a@b.c");
        assert_eq!(angle_addr("<>"), "");
    }

    #[test]
    fn refuses_matches_the_needle_case_insensitively() {
        let config = SmtpScenario { refuse_recipient: Some("@Refused.test".into()) };
        assert!(refuses(&config, "bounce@refused.TEST"));
        assert!(!refuses(&config, "partner@example.com"));
        assert!(!refuses(&SmtpScenario::default(), "bounce@refused.test"));
    }

    #[test]
    fn strip_crlf_leaves_the_content() {
        assert_eq!(strip_crlf(b".\r\n"), b".");
        assert_eq!(strip_crlf(b"x\n"), b"x");
        assert_eq!(strip_crlf(b"x"), b"x");
    }
}
