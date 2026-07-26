//! Scriptable mock IMAP server for MailVault tests.
//!
//! Plaintext TCP on loopback — no TLS. TLS is `async_native_tls`'s job, not ours,
//! and putting a cert here would mean an accept-invalid-certs hatch in production
//! code. The client skips its TLS wrap when `MAILVAULT_IMAP_PLAINTEXT=1` **and**
//! the address is loopback.
//!
//! Blocking `std::net` + one thread per connection: no async runtime, so it works
//! from `async-std` tests in `mailvault-core` and `tokio` tests in the daemon
//! alike, and `Delay` faults are a plain `thread::sleep`.
//!
//! ```no_run
//! use mock_imap::{MockImap, Scenario, state::{Mailbox, synthetic_mailbox}};
//! let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
//! // point ImapConfig at server.host()/server.port()
//! ```

pub mod commands;
pub mod encode;
pub mod scenario;
pub mod state;

pub use scenario::{Action, Fault, Scenario, Trigger};
pub use state::{Mailbox, Message, ServerState};

use commands::{Command, Response, Session};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct MockImap {
    addr: SocketAddr,
    state: Arc<Mutex<ServerState>>,
    stop: Arc<AtomicBool>,
    /// Every command line the server received, in order. Test assertions read this
    /// to prove *what the client sent*, which is often the actual thing under test.
    log: Arc<Mutex<Vec<String>>>,
    /// Accepted TCP connections. Proves whether a session was reused or replaced.
    connections: Arc<AtomicUsize>,
}

impl MockImap {
    pub fn start(scenario: Scenario) -> MockImap {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock imap");
        let addr = listener.local_addr().expect("local_addr");
        let state = Arc::new(Mutex::new(scenario.state.clone()));
        let stop = Arc::new(AtomicBool::new(false));
        let log = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));

        {
            let state = state.clone();
            let stop = stop.clone();
            let log = log.clone();
            let connections = connections.clone();
            let faults = scenario.faults.clone();
            let greeting = scenario
                .greeting
                .clone()
                .unwrap_or_else(|| "* OK MockIMAP ready".to_string());

            std::thread::spawn(move || {
                for conn in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(conn) = conn else { continue };
                    connections.fetch_add(1, Ordering::SeqCst);
                    let (state, log, faults, counts, greeting) = (
                        state.clone(),
                        log.clone(),
                        faults.clone(),
                        counts.clone(),
                        greeting.clone(),
                    );
                    std::thread::spawn(move || {
                        let _ = handle_conn(conn, state, log, faults, counts, greeting);
                    });
                }
            });
        }

        MockImap { addr, state, stop, log, connections }
    }

    pub fn host(&self) -> String {
        self.addr.ip().to_string()
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Snapshot of server state — assert here that a write actually landed.
    pub fn state(&self) -> ServerState {
        self.state.lock().unwrap().clone()
    }

    /// Every command line received, in order.
    pub fn commands(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    /// TCP connections accepted so far. A pooled session that was reused adds
    /// nothing here; a discarded-and-replaced one adds exactly one.
    ///
    /// The `Drop` impl opens one wake-up connection, so read this while the
    /// server is still alive.
    pub fn connection_count(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    /// Count of received command lines whose uppercase form contains `needle`.
    pub fn count_commands(&self, needle: &str) -> usize {
        let needle = needle.to_uppercase();
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.to_uppercase().contains(&needle))
            .count()
    }
}

impl Drop for MockImap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the blocking accept() so the listener thread can exit.
        let _ = TcpStream::connect(self.addr);
    }
}

// ── connection handling ─────────────────────────────────────────────────────

fn handle_conn(
    conn: TcpStream,
    state: Arc<Mutex<ServerState>>,
    log: Arc<Mutex<Vec<String>>>,
    faults: Vec<Fault>,
    counts: Arc<Mutex<HashMap<String, usize>>>,
    greeting: String,
) -> std::io::Result<()> {
    conn.set_nodelay(true)?;
    let mut out = conn.try_clone()?;
    let mut reader = BufReader::new(conn);
    let mut sess = Session::default();
    let mut responses_sent = 0usize;

    // OnConnect faults fire before the greeting.
    let connect_actions: Vec<Action> = faults
        .iter()
        .filter(|f| f.trigger == Trigger::OnConnect)
        .map(|f| f.action.clone())
        .collect();
    for a in &connect_actions {
        match a {
            Action::Delay(d) => std::thread::sleep(*d),
            Action::DropConnection => return Ok(()),
            _ => {}
        }
    }
    write_line(&mut out, greeting.as_bytes())?;

    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let line = line.trim_end_matches(['\r', '\n']).to_string();
        if line.is_empty() {
            continue;
        }
        log.lock().unwrap().push(line.clone());

        // A trailing {n} / {n+} means a literal follows.
        let (line, literal) = read_literal(&line, &mut reader, &mut out)?;

        let Some(mut cmd) = commands::parse_command(&line) else {
            write_line(&mut out, b"* BAD Unparseable command")?;
            continue;
        };
        cmd.literal = literal;

        // AUTHENTICATE needs a continuation round-trip before it can be dispatched.
        if cmd.name == "AUTHENTICATE" {
            write_line(&mut out, b"+ ")?;
            let mut blob = String::new();
            reader.read_line(&mut blob)?;
            sess.authenticated = true;
            write_line(
                &mut out,
                format!("{} OK AUTHENTICATE completed", cmd.tag).as_bytes(),
            )?;
            continue;
        }

        let actions = match_faults(&faults, &cmd.name, &counts);

        if actions.contains(&Action::DropConnection) {
            return Ok(());
        }
        for a in &actions {
            if let Action::Delay(d) = a {
                std::thread::sleep(*d);
            }
            if let Action::ThrottleAfter(n, d) = a {
                if responses_sent >= *n {
                    std::thread::sleep(*d);
                }
            }
        }

        let response = {
            let mut st = state.lock().unwrap();
            commands::dispatch(&cmd, &mut st, &mut sess, &actions)
        };
        let close_after = response.close_after;

        let bytes = serialize(&cmd, response, &actions);
        emit(&mut out, &bytes, &actions)?;
        responses_sent += 1;

        // A truncated response also closes the socket. Leaving it open would just
        // hang the client forever, which makes for a useless (and slow) test.
        let truncated = actions
            .iter()
            .any(|a| matches!(a, Action::TruncateResponse(_)));
        if close_after || truncated {
            return Ok(());
        }
    }
}

/// If the command line ends in `{n}` or `{n+}`, read the literal.
/// Sync literals get a `+` continuation first; LITERAL+ (`{n+}`) does not.
fn read_literal(
    line: &str,
    reader: &mut BufReader<TcpStream>,
    out: &mut TcpStream,
) -> std::io::Result<(String, Vec<u8>)> {
    let Some(open) = line.rfind('{') else {
        return Ok((line.to_string(), Vec::new()));
    };
    if !line.ends_with('}') {
        return Ok((line.to_string(), Vec::new()));
    }
    let inner = &line[open + 1..line.len() - 1];
    let non_sync = inner.ends_with('+');
    let Ok(n) = inner.trim_end_matches('+').parse::<usize>() else {
        return Ok((line.to_string(), Vec::new()));
    };

    if !non_sync {
        write_line(out, b"+ Ready for literal data")?;
    }
    let mut buf = vec![0u8; n];
    reader.read_exact(&mut buf)?;

    // The rest of the command line follows the literal (usually just CRLF).
    let mut tail = String::new();
    reader.read_line(&mut tail)?;

    let head = line[..open].trim_end().to_string();
    Ok((format!("{} {}", head, tail.trim()).trim_end().to_string(), buf))
}

fn match_faults(
    faults: &[Fault],
    name: &str,
    counts: &Arc<Mutex<HashMap<String, usize>>>,
) -> Vec<Action> {
    let n = {
        let mut c = counts.lock().unwrap();
        let e = c.entry(name.to_string()).or_insert(0);
        *e += 1;
        *e
    };
    faults
        .iter()
        .filter(|f| match &f.trigger {
            Trigger::OnCommand(c) => c == name,
            Trigger::OnNthCommand(c, k) => c == name && *k == n,
            Trigger::OnConnect => false,
        })
        .map(|f| f.action.clone())
        .collect()
}

// ── response serialization + fault shaping ──────────────────────────────────

fn serialize(cmd: &Command, response: Response, actions: &[Action]) -> Vec<u8> {
    // RespondRaw replaces everything.
    if let Some(Action::RespondRaw(raw)) = actions
        .iter()
        .find(|a| matches!(a, Action::RespondRaw(_)))
    {
        return raw.replace("{tag}", &cmd.tag).replace("\\r\\n", "\r\n").into_bytes();
    }

    let (mut status, mut text) = response.tagged;
    let mut untagged = response.untagged;

    if let Some(Action::Respond(s, t)) = actions.iter().find(|a| matches!(a, Action::Respond(_, _)))
    {
        status = s.clone();
        text = t.clone();
        untagged.clear();
    }

    // InjectUntagged: a well-formed extra line before the data.
    for a in actions {
        if let Action::InjectUntagged(l) = a {
            untagged.insert(0, l.clone().into_bytes());
        }
    }

    // InjectMidLine: splice INTO the first data line, no CRLF break.
    // This is the Purelymail keepalive shape.
    if let Some(Action::InjectMidLine(inject)) =
        actions.iter().find(|a| matches!(a, Action::InjectMidLine(_)))
    {
        if let Some(first) = untagged.first_mut() {
            let at = first.len() / 2;
            let at = (at..first.len())
                .find(|i| first[*i] == b' ')
                .unwrap_or(first.len());
            let mut spliced = first[..at].to_vec();
            spliced.extend_from_slice(inject.as_bytes());
            spliced.extend_from_slice(&first[at..]);
            *first = spliced;
        }
    }

    let mut buf = Vec::new();
    for line in untagged {
        buf.extend_from_slice(&line);
        buf.extend_from_slice(b"\r\n");
    }
    buf.extend_from_slice(format!("{} {} {}\r\n", cmd.tag, status, text).as_bytes());
    buf
}

fn emit(out: &mut TcpStream, bytes: &[u8], actions: &[Action]) -> std::io::Result<()> {
    if let Some(Action::TruncateResponse(n)) = actions
        .iter()
        .find(|a| matches!(a, Action::TruncateResponse(_)))
    {
        out.write_all(&bytes[..(*n).min(bytes.len())])?;
        return out.flush();
    }

    if let Some(Action::SplitWrites(chunk)) =
        actions.iter().find(|a| matches!(a, Action::SplitWrites(_)))
    {
        let chunk = (*chunk).max(1);
        for part in bytes.chunks(chunk) {
            out.write_all(part)?;
            out.flush()?;
            std::thread::sleep(Duration::from_millis(1));
        }
        return Ok(());
    }

    out.write_all(bytes)?;
    out.flush()
}

fn write_line(out: &mut TcpStream, line: &[u8]) -> std::io::Result<()> {
    out.write_all(line)?;
    out.write_all(b"\r\n")?;
    out.flush()
}
