//! Attachment downloads against the mock IMAP server: `mobile.attachment.fetch` streams a part in
//! 256 KiB range fetches to `<cache>/att/<hash>.part`, decoding as it goes, and renames it to
//! `<hash>` only when it is whole. The LRU cap and the lease expiry are unit tests in
//! `src/attachments.rs`: both are overridable in unit tests only.

use mailvault_mobile_engine::{Engine, MemorySecrets};
use mock_imap::state::{Mailbox, Message};
use mock_imap::{Action, MockImap, Scenario, Trigger};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT: Duration = Duration::from_secs(120);
const CHUNK: usize = 256 * 1024;
const RANGE: &str = "BODY.PEEK[2]<";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Deterministic bytes that do not compress or repeat on a line boundary.
fn source(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (x >> 56) as u8
        })
        .collect()
}

/// Base64 in 76-character lines with CRLF, as mail writes it.
fn base64_lines(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut flat = String::with_capacity(data.len() * 4 / 3 + 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        flat.push(A[(n >> 18) as usize & 63] as char);
        flat.push(A[(n >> 12) as usize & 63] as char);
        flat.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        flat.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    let mut out = String::with_capacity(flat.len() + flat.len() / 76 * 2 + 2);
    for line in flat.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(line).unwrap());
        out.push_str("\r\n");
    }
    out
}

/// Quoted-printable text with soft breaks, escapes and trailing spaces the decoder must drop.
fn qp_text(lines: usize) -> (String, Vec<u8>) {
    let mut encoded = String::new();
    let mut decoded = Vec::new();
    for i in 0..lines {
        // A long line split by soft breaks, an escaped UTF-8 word, and transport padding.
        let word = format!("line {i} Gr=C3=BC=C3=9Fe =3D ok");
        encoded.push_str(&format!("{word} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\r\nbbbbbbbbbbbbbbbbbbbb   \r\n"));
        decoded.extend_from_slice(format!("line {i} Grüße = ok aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbb\r\n").as_bytes());
    }
    (encoded, decoded)
}

/// multipart/mixed [ text/plain, the attachment (`encoding`, already encoded) ].
fn message(uid: u32, encoding: &str, encoded: &str) -> Message {
    Message::new(
        uid,
        format!(
            "From: Ana <ana@example.com>\r\n\
             To: user@example.com\r\n\
             Subject: Files {uid}\r\n\
             Message-ID: <att-{uid}@example.com>\r\n\
             MIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=\"mix\"\r\n\
             \r\n\
             --mix\r\n\
             Content-Type: text/plain; charset=utf-8\r\n\
             \r\n\
             See attached.\r\n\
             --mix\r\n\
             Content-Type: application/octet-stream; name=\"data.bin\"\r\n\
             Content-Disposition: attachment; filename=\"data.bin\"\r\n\
             Content-Transfer-Encoding: {encoding}\r\n\
             \r\n\
             {encoded}\
             --mix--\r\n"
        ),
    )
    .with_internal_ms(now_ms() - 86_400_000 + uid as i64)
}

fn binary_message(uid: u32, data: &[u8]) -> Message {
    message(uid, "base64", &base64_lines(data))
}

#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
}

impl Events {
    /// Waits for the first event from index `from` on that `pick` accepts.
    fn wait(&self, from: usize, what: &str, pick: impl Fn(&str, &Value) -> bool) -> (String, Value) {
        let deadline = Instant::now() + WAIT;
        let mut list = self.list.lock().unwrap();
        loop {
            if let Some(hit) = list.iter().skip(from).find(|(n, v)| pick(n, v)) {
                return hit.clone();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no {what}: {:?}", list.iter().map(|(n, v)| format!("{n} {v}")).collect::<Vec<_>>());
            list = self.cv.wait_timeout(list, left).unwrap().0;
        }
    }

    fn len(&self) -> usize {
        self.list.lock().unwrap().len()
    }
}

struct Fixture {
    tmp: tempfile::TempDir,
    secrets: Arc<MemorySecrets>,
    engine: Arc<Engine>,
    events: Arc<Events>,
    account: String,
}

fn open(tmp: &Path, secrets: &Arc<MemorySecrets>) -> (Arc<Engine>, Arc<Events>) {
    let engine = Arc::new(Engine::open(tmp, &tmp.join("cache"), Arc::clone(secrets) as _).unwrap());
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    engine.set_event_sink(move |name, payload| {
        sink.list.lock().unwrap().push((name.to_string(), payload));
        sink.cv.notify_all();
    });
    (engine, events)
}

fn setup(server: &MockImap) -> Fixture {
    std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    let tmp = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let (engine, events) = open(tmp.path(), &secrets);
    let added = engine
        .rpc(
            "mobile.accounts.add",
            json!({ "email": "u@example.test", "password": "pw-att-test", "imapHost": server.host(), "imapPort": server.port(), "security": "none" }),
        )
        .unwrap();
    assert_eq!(added["ok"], true, "{added}");
    let account = added["account"]["id"].as_str().unwrap().to_string();
    let f = Fixture { tmp, secrets, engine, events, account };
    let from = f.events.len();
    f.engine.rpc("mobile.sync.refresh", json!({ "accountId": f.account })).unwrap();
    let (_, end) = f.events.wait(from, "sync end", |n, v| n == "mobile.sync.state" && v["state"] != "syncing");
    assert_eq!(end["state"], "idle", "{end}");
    f
}

impl Fixture {
    fn part(&self, uid: u32) -> Value {
        json!({ "accountId": self.account, "folder": "INBOX", "uid": uid, "section": "2" })
    }

    fn fetch(&self, uid: u32) -> u64 {
        let v = self.engine.rpc("mobile.attachment.fetch", self.part(uid)).unwrap();
        v["jobId"].as_u64().unwrap_or_else(|| panic!("no jobId: {v}"))
    }

    fn local(&self, uid: u32) -> Value {
        self.engine.rpc("mobile.attachment.local", self.part(uid)).unwrap()["path"].clone()
    }

    /// The job's `done` or `failed` event.
    fn end(&self, job: u64) -> (String, Value) {
        self.events.wait(0, "job end", |n, v| (n == "mobile.attachment.done" || n == "mobile.attachment.failed") && v["jobId"] == job)
    }

    fn done(&self, job: u64) -> PathBuf {
        let (name, v) = self.end(job);
        assert_eq!(name, "mobile.attachment.done", "{v}");
        PathBuf::from(v["path"].as_str().unwrap())
    }

    fn att_dir(&self) -> PathBuf {
        self.tmp.path().join("cache").join("att")
    }

    fn att_files(&self) -> Vec<String> {
        let mut names: Vec<String> = match std::fs::read_dir(self.att_dir()) {
            Ok(rd) => rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => Vec::new(),
        };
        names.sort();
        names
    }
}

/// The range fetches the server saw, as `(offset, length)`, in order.
fn ranges(server: &MockImap) -> Vec<(u64, u64)> {
    server
        .commands()
        .iter()
        .filter_map(|c| {
            let at = c.find(RANGE)? + RANGE.len();
            let rest = &c[at..];
            let (o, l) = rest[..rest.find('>')?].split_once('.')?;
            Some((o.parse().ok()?, l.parse().ok()?))
        })
        .collect()
}

#[cfg(unix)]
fn max_rss_bytes() -> u64 {
    // SAFETY: getrusage fills the struct it is handed.
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    // Bytes on macOS, kilobytes on Linux.
    if cfg!(target_os = "macos") {
        ru.ru_maxrss as u64
    } else {
        ru.ru_maxrss as u64 * 1024
    }
}

/// A 40 MB part arrives as 256 KiB range fetches into one file; the engine never holds more than
/// a chunk (raw in, decoded out), and the bytes on disk are the source.
#[test]
fn streams_to_file_in_chunks() {
    let data = source(40 * 1024 * 1024, 1);
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(binary_message(1, &data))));
    let f = setup(&server);
    #[cfg(unix)]
    let rss_before = max_rss_bytes();
    let t0 = Instant::now();
    let job = f.fetch(1);
    let path = f.done(job);
    let took = t0.elapsed();
    #[cfg(unix)]
    eprintln!(
        "[attachments] 40 MB part in {took:?}; peak RSS before {} MB, after {} MB (delta {} KB, process-wide, includes the mock)",
        rss_before / 1_048_576,
        max_rss_bytes() / 1_048_576,
        max_rss_bytes().saturating_sub(rss_before) / 1024
    );
    #[cfg(not(unix))]
    eprintln!("[attachments] 40 MB part in {took:?}");

    let peak = f.engine.attachment_peak_buffer();
    eprintln!("[attachments] largest buffer one job held: {peak} bytes");
    assert!(peak > 0 && peak <= CHUNK as u64, "a job held {peak} bytes at once");

    let sent = ranges(&server);
    let encoded = base64_lines(&data).len() as u64;
    assert_eq!(sent.len() as u64, encoded / CHUNK as u64 + 1, "{} range fetches", sent.len());
    for (i, (o, l)) in sent.iter().enumerate() {
        assert_eq!((*o, *l), (i as u64 * CHUNK as u64, CHUNK as u64));
    }
    let progress = f.events.list.lock().unwrap().iter().filter(|(n, v)| n == "mobile.attachment.progress" && v["jobId"] == job).count();
    assert!(progress >= sent.len() - 1, "{progress} progress events");

    assert!(!path.to_string_lossy().ends_with(".part"));
    assert_eq!(f.local(1), json!(path.to_string_lossy()));
    let on_disk = std::fs::read(&path).unwrap();
    assert!(on_disk == data, "file differs from the source ({} vs {} bytes)", on_disk.len(), data.len());
    assert_eq!(f.att_files().len(), 1, "{:?}", f.att_files());
}

/// Quoted-printable decodes across chunk boundaries: soft breaks, escapes and trailing spaces
/// split between two range fetches come out as if decoded whole.
#[test]
fn decodes_quoted_printable_across_chunks() {
    let (encoded, decoded) = qp_text(9000);
    assert!(encoded.len() > 2 * CHUNK);
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(message(1, "quoted-printable", &encoded))));
    let f = setup(&server);
    let path = f.done(f.fetch(1));
    let on_disk = std::fs::read(&path).unwrap();
    assert!(on_disk == decoded, "{} vs {} bytes", on_disk.len(), decoded.len());
}

/// While the part downloads, `local` answers null and the only file is the `.part`; a second
/// fetch of the same part joins the running job.
#[test]
fn never_exposes_part_file_as_done() {
    let data = source(1_500_000, 2);
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push_msg(binary_message(1, &data)))
            .fault(Trigger::nth_with("FETCH", RANGE, 2), Action::Delay(Duration::from_millis(1500))),
    );
    let f = setup(&server);
    let job = f.fetch(1);
    f.events.wait(0, "first progress", |n, v| n == "mobile.attachment.progress" && v["jobId"] == job);
    assert_eq!(f.local(1), Value::Null);
    let names = f.att_files();
    assert!(names.iter().any(|n| n.ends_with(".part")), "{names:?}");
    assert!(names.iter().all(|n| n.contains(".part")), "a finished name exists mid-download: {names:?}");
    assert_eq!(f.fetch(1), job, "a second fetch of the same part started another job");

    let path = f.done(job);
    assert_eq!(f.local(1), json!(path.to_string_lossy()));
    assert_eq!(std::fs::read(&path).unwrap(), data);
    let names = f.att_files();
    assert!(!names.iter().any(|n| n.contains(".part")), "{names:?}");
}

/// The app is killed mid-download: the next engine resumes from the offset the `.part` reached,
/// never refetching what it holds, and the file comes out whole.
#[test]
fn resumes_after_kill() {
    let data = source(2_000_000, 3);
    let stall = Duration::from_secs(3);
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push_msg(binary_message(1, &data)))
            .fault(Trigger::nth_with("FETCH", RANGE, 3), Action::Delay(stall)),
    );
    let f = setup(&server);
    let job = f.fetch(1);
    f.events.wait(0, "second chunk", |n, v| n == "mobile.attachment.progress" && v["jobId"] == job && v["received"] == 2 * CHUNK as u64);
    let t_drop = Instant::now();
    let Fixture { tmp, secrets, engine, events: _, account } = f;
    drop(engine);
    // The old worker is stalled in the third fetch; let it wake, see the engine closed, and stop
    // without writing.
    std::thread::sleep(stall.saturating_sub(t_drop.elapsed()) + Duration::from_millis(700));
    let before = ranges(&server).len();
    assert_eq!(before, 3, "{:?}", ranges(&server));
    let names: Vec<String> = std::fs::read_dir(tmp.path().join("cache").join("att"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().any(|n| n.ends_with(".part")), "{names:?}");

    let (engine, events) = open(tmp.path(), &secrets);
    let f = Fixture { tmp, secrets, engine, events, account };
    let job = f.fetch(1);
    let path = f.done(job);
    let sent = ranges(&server);
    // At the end of chunk 2, less what the decoder held back: an unfinished base64 quad (at most
    // three characters and the line break inside it) is fetched again, nothing more.
    let resumed = sent[before].0;
    assert!((2 * CHUNK as u64 - 5..=2 * CHUNK as u64).contains(&resumed), "resumed at {:?}", &sent[before..]);
    assert_eq!(sent.iter().filter(|(o, _)| *o == 0).count(), 1, "the start was fetched again: {sent:?}");
    assert_eq!(sent.iter().filter(|(o, _)| *o == CHUNK as u64).count(), 1, "chunk 2 was fetched again: {sent:?}");
    assert!(std::fs::read(&path).unwrap() == data, "resumed file differs from the source");
}

/// Cancel stops the job, says so, and leaves no partial file behind.
#[test]
fn cancel_removes_part_file() {
    let data = source(1_500_000, 4);
    let server = MockImap::start(
        Scenario::new()
            .mailbox(Mailbox::new("INBOX").push_msg(binary_message(1, &data)))
            .fault(Trigger::nth_with("FETCH", RANGE, 2), Action::Delay(Duration::from_millis(1500))),
    );
    let f = setup(&server);
    let job = f.fetch(1);
    f.events.wait(0, "first progress", |n, v| n == "mobile.attachment.progress" && v["jobId"] == job);
    let v = f.engine.rpc("mobile.attachment.cancel", json!({ "jobId": job })).unwrap();
    assert_eq!(v["cancelled"], true, "{v}");
    let (name, v) = f.end(job);
    assert_eq!((name.as_str(), &v["code"]), ("mobile.attachment.failed", &json!("CANCELLED")), "{v}");
    assert_eq!(f.att_files(), Vec::<String>::new());
    assert_eq!(f.local(1), Value::Null);
    let v = f.engine.rpc("mobile.attachment.cancel", json!({ "jobId": job })).unwrap();
    assert_eq!(v["cancelled"], false, "an ended job was cancelled again: {v}");
}

/// A finished file the cache lost (evicted, or the OS purged the cache dir) reads as null, and a
/// new fetch downloads it again from the start.
#[test]
fn purged_file_means_refetch() {
    let data = source(300_000, 5);
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(binary_message(1, &data))));
    let f = setup(&server);
    let path = f.done(f.fetch(1));
    assert_eq!(f.local(1), json!(path.to_string_lossy()));
    std::fs::remove_file(&path).unwrap();
    assert_eq!(f.local(1), Value::Null);
    let again = f.done(f.fetch(1));
    assert_eq!(again, path);
    assert_eq!(std::fs::read(&again).unwrap(), data);
    assert_eq!(ranges(&server).iter().filter(|(o, _)| *o == 0).count(), 2);
}

/// A uid the server no longer has fails with `GONE` and leaves nothing behind.
#[test]
fn a_gone_uid_fails_gone() {
    let data = source(10_000, 6);
    let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(binary_message(1, &data))));
    let f = setup(&server);
    server.mutate(|st| st.expunge("INBOX", &[1]));
    let job = f.fetch(1);
    let (name, v) = f.end(job);
    assert_eq!((name.as_str(), &v["code"]), ("mobile.attachment.failed", &json!("GONE")), "{v}");
    assert_eq!(f.att_files(), Vec::<String>::new());
    assert!(f.engine.rpc("mobile.attachment.fetch", json!({ "accountId": f.account, "folder": "Nope", "uid": 1, "section": "2" })).is_err());
    assert!(f.engine.rpc("mobile.attachment.fetch", json!({ "accountId": f.account, "folder": "INBOX", "uid": 1, "section": "2 BODY[]" })).is_err());
}

/// The server ends a slice early in the middle of the part (fewer bytes than asked, well before
/// the reported size) and still has bytes after it: never a finished file, the job fails.
#[test]
fn a_short_slice_mid_part_is_not_the_end() {
    let data = source(1_500_000, 7);
    let server = MockImap::start(
        Scenario::new().mailbox(Mailbox::new("INBOX").push_msg(binary_message(1, &data))).fault(
            Trigger::nth_with("FETCH", RANGE, 2),
            Action::RespondRaw(format!("* 1 FETCH (UID 1 BODY[2]<{CHUNK}> {{8}}\r\nQUJDREVG)\r\n{{tag}} OK FETCH completed\r\n")),
        ),
    );
    let f = setup(&server);
    let job = f.fetch(1);
    let (name, v) = f.end(job);
    assert_eq!((name.as_str(), &v["code"]), ("mobile.attachment.failed", &json!("INVALID")), "{v}");
    assert_eq!(f.local(1), Value::Null);
    assert!(f.att_files().iter().all(|n| n.contains(".part")), "a finished file exists: {:?}", f.att_files());
    // The end was probed right after the short slice.
    assert!(ranges(&server).contains(&(CHUNK as u64 + 8, CHUNK as u64)), "{:?}", ranges(&server));
}

/// A download killed after its second chunk: the server, the data dir and what to reopen with.
struct Killed {
    server: MockImap,
    tmp: tempfile::TempDir,
    secrets: Arc<MemorySecrets>,
    account: String,
    data: Vec<u8>,
    /// Range fetches sent before the kill.
    before: usize,
}

impl Killed {
    fn new(seed: u64) -> Killed {
        let data = source(1_500_000, seed);
        let stall = Duration::from_millis(1500);
        let server = MockImap::start(
            Scenario::new()
                .mailbox(Mailbox::new("INBOX").push_msg(binary_message(1, &data)))
                .fault(Trigger::nth_with("FETCH", RANGE, 3), Action::Delay(stall)),
        );
        let f = setup(&server);
        let job = f.fetch(1);
        f.events.wait(0, "second chunk", |n, v| n == "mobile.attachment.progress" && v["jobId"] == job && v["received"] == 2 * CHUNK as u64);
        let t = Instant::now();
        let Fixture { tmp, secrets, engine, events: _, account } = f;
        drop(engine);
        std::thread::sleep(stall.saturating_sub(t.elapsed()) + Duration::from_millis(700));
        let before = ranges(&server).len();
        assert_eq!(before, 3);
        Killed { server, tmp, secrets, account, data, before }
    }

    fn file(&self, suffix: &str) -> PathBuf {
        let dir = self.tmp.path().join("cache").join("att");
        std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.to_string_lossy().ends_with(suffix))
            .unwrap_or_else(|| panic!("no *{suffix} in {dir:?}"))
    }

    fn edit_meta(&self, f: impl FnOnce(&mut Value)) {
        let path = self.file(".part.meta");
        let mut v: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        f(&mut v);
        std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
    }

    /// Reopens, fetches to the end, checks the file is the source; the offsets fetched after.
    fn finish(self) -> Vec<(u64, u64)> {
        let (engine, events) = open(self.tmp.path(), &self.secrets);
        let f = Fixture { tmp: self.tmp, secrets: self.secrets, engine, events, account: self.account };
        let path = f.done(f.fetch(1));
        assert!(std::fs::read(&path).unwrap() == self.data, "the file differs from the source");
        ranges(&self.server)[self.before..].to_vec()
    }
}

/// A kill between the data write and the meta write leaves the `.part` longer than the meta
/// vouches for: the extra bytes are cut and the download resumes where the meta says.
#[test]
fn resume_truncates_bytes_the_meta_never_vouched_for() {
    let k = Killed::new(8);
    let part = k.file(".part");
    let mut f = std::fs::OpenOptions::new().append(true).open(&part).unwrap();
    std::io::Write::write_all(&mut f, &[0xAB; 100_000]).unwrap();
    drop(f);
    let after = k.finish();
    assert!(after[0].0 > CHUNK as u64, "started over instead of resuming: {after:?}");
}

/// A meta for another UIDVALIDITY or another encoding, or a `.part` shorter than the meta says,
/// cannot be resumed: the download starts over from 0.
#[test]
fn resume_starts_over_on_a_meta_that_does_not_match() {
    let k = Killed::new(9);
    k.edit_meta(|m| m["uidValidity"] = json!(m["uidValidity"].as_i64().unwrap() + 1));
    assert_eq!(k.finish()[0].0, 0, "another UIDVALIDITY");

    let k = Killed::new(10);
    k.edit_meta(|m| m["encoding"] = json!("quoted-printable"));
    assert_eq!(k.finish()[0].0, 0, "another encoding");

    let k = Killed::new(11);
    let part = k.file(".part");
    let len = std::fs::metadata(&part).unwrap().len();
    std::fs::OpenOptions::new().write(true).open(&part).unwrap().set_len(len - 1).unwrap();
    assert_eq!(k.finish()[0].0, 0, "a .part shorter than the meta");
}
