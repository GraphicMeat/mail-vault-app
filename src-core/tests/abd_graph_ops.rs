//! `GraphClient`'s ABD calls and `abd::graph_ops::GraphOps`, against a tiny
//! in-process HTTP stub that serves exactly the Graph endpoints they use.
//!
//! `graph::graph_base()` is a process-wide `OnceLock`, so the whole binary talks
//! to ONE stub. It is started once, on its own thread (a stub started inside a
//! test would die with that test's runtime), and the base override is set in
//! the same initialiser, before any client exists. Tests share the stub, so
//! each one uses ids with its own prefix and registers routes under it.

use mailvault_core::abd::graph_ops::{GraphOps, LeaseStore, TokenLease};
use mailvault_core::abd::{FolderInfo, FolderPlan, FolderRole, ListedMsg, OpsError, ServerOps};
use mailvault_core::graph::GraphClient;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

// ── the stub ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Req {
    method: String,
    path: String,
    /// Percent-decoded.
    query: String,
    headers: HashMap<String, String>,
    body: String,
}

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// Never answer (the connection stays open for a few seconds).
    hang: bool,
    /// Answer only after this many milliseconds.
    delay_ms: u64,
}

impl Resp {
    fn json(status: u16, body: serde_json::Value) -> Resp {
        Resp {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.to_string().into_bytes(),
            hang: false,
            delay_ms: 0,
        }
    }
    fn empty(status: u16) -> Resp {
        Resp { status, headers: vec![], body: vec![], hang: false, delay_ms: 0 }
    }
    fn hang() -> Resp {
        Resp { status: 200, headers: vec![], body: vec![], hang: true, delay_ms: 0 }
    }
    fn with_header(mut self, k: &str, v: &str) -> Resp {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }
}

type Handler = Arc<dyn Fn(&Req) -> Resp + Send + Sync>;

struct Stub {
    base: String,
    routes: Mutex<Vec<(String, Handler)>>,
    log: Mutex<Vec<Req>>,
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn read_request(stream: &mut TcpStream) -> Option<Req> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p;
        }
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let want: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body: Vec<u8> = buf[head_end + 4..].to_vec();
    while body.len() < want {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), pct_decode(q)),
        None => (target.clone(), String::new()),
    };
    Some(Req { method, path: pct_decode(&path), query, headers, body: String::from_utf8_lossy(&body).into_owned() })
}

fn serve(stub: &'static Stub, mut stream: TcpStream) {
    let Some(req) = read_request(&mut stream) else { return };
    stub.log.lock().unwrap().push(req.clone());
    let handler = {
        let routes = stub.routes.lock().unwrap();
        routes
            .iter()
            .filter(|(prefix, _)| req.path.starts_with(prefix.as_str()))
            .max_by_key(|(prefix, _)| prefix.len())
            .map(|(_, h)| h.clone())
    };
    let resp = match handler {
        Some(h) => h(&req),
        None => Resp::json(404, serde_json::json!({"error": {"code": "ErrorItemNotFound"}})),
    };
    if resp.hang {
        std::thread::sleep(Duration::from_secs(3));
        return;
    }
    if resp.delay_ms > 0 {
        std::thread::sleep(Duration::from_millis(resp.delay_ms));
    }
    let mut head = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", resp.status, resp.body.len());
    for (k, v) in &resp.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&resp.body);
    let _ = stream.flush();
}

fn stub() -> &'static Stub {
    static STUB: OnceLock<&'static Stub> = OnceLock::new();
    STUB.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{port}");
        let s: &'static Stub =
            Box::leak(Box::new(Stub { base: base.clone(), routes: Mutex::new(Vec::new()), log: Mutex::new(Vec::new()) }));
        // Before any client exists: the base is read once per process.
        std::env::set_var("MAILVAULT_GRAPH_BASE", &base);
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                std::thread::spawn(move || serve(s, conn));
            }
        });
        s
    })
}

fn route(prefix: &str, h: impl Fn(&Req) -> Resp + Send + Sync + 'static) {
    stub().routes.lock().unwrap().push((prefix.to_string(), Arc::new(h)));
}

/// Requests whose path contains `needle`, oldest first.
fn seen(needle: &str) -> Vec<Req> {
    stub().log.lock().unwrap().iter().filter(|r| r.path.contains(needle)).cloned().collect()
}

// ── helpers ─────────────────────────────────────────────────────────────────

const TOKEN: &str = "tok-SECRET-abc123XYZ";
const NOW: i64 = 1_800_000_000_000;

fn client() -> GraphClient {
    stub();
    GraphClient::for_purpose(TOKEN, "backup")
}

fn cell(expires_at_ms: i64) -> Arc<Mutex<Option<TokenLease>>> {
    Arc::new(Mutex::new(Some(TokenLease { token: TOKEN.to_string(), expires_at_ms })))
}

fn ops_with(cell: &Arc<Mutex<Option<TokenLease>>>) -> GraphOps {
    stub();
    let leases: Arc<dyn LeaseStore> = cell.clone();
    GraphOps::new("user@outlook.test", leases).with_clock(Arc::new(|| NOW))
}

fn ops() -> GraphOps {
    ops_with(&cell(NOW + 3_600_000))
}

fn folder(path: &str, id: &str, role: FolderRole) -> FolderInfo {
    FolderInfo { path: path.into(), name: path.into(), role, graph_id: Some(id.into()), selectable: true }
}

fn listed(uid: u32, graph_id: &str, message_id: Option<&str>) -> ListedMsg {
    ListedMsg {
        uid,
        internal_ms: 1_700_000_000_000,
        size: 100,
        graph_id: Some(graph_id.into()),
        message_id: message_id.map(String::from),
        ..Default::default()
    }
}

fn item(id: &str, received: &str, imid: &str, size: Option<&str>) -> serde_json::Value {
    let mut v = serde_json::json!({"id": id, "receivedDateTime": received, "internetMessageId": imid});
    if let Some(s) = size {
        v["singleValueExtendedProperties"] = serde_json::json!([{"id": "Integer 0x0E08", "value": s}]);
    }
    v
}

// ── GraphClient ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn list_page_follows_next_link_and_reads_the_size_property() {
    let base = stub().base.clone();
    route("/me/mailFolders/pg-f/messages", move |r| {
        if r.query.contains("$skiptoken=2") {
            Resp::json(200, serde_json::json!({"value": [item("pg-3", "2023-12-31T23:30:00Z", "<c@x>", Some("512"))]}))
        } else {
            Resp::json(
                200,
                serde_json::json!({
                    "value": [
                        item("pg-1", "2024-03-01T10:00:00Z", "<a@x>", Some("2048")),
                        item("pg-2", "2024-03-02T10:00:00+02:00", "<b@x>", Some("1024")),
                    ],
                    "@odata.nextLink": format!("{base}/me/mailFolders/pg-f/messages?$skiptoken=2"),
                }),
            )
        }
    });
    let c = client();
    let (p1, next) = c.list_page("pg-f", None).await.unwrap();
    assert_eq!(p1.len(), 2);
    assert_eq!(p1[0].id, "pg-1");
    assert_eq!(p1[0].received_ms, 1_709_287_200_000);
    assert_eq!(p1[0].internet_message_id.as_deref(), Some("<a@x>"));
    assert_eq!(p1[0].size, Some(2048));
    // An offset in the timestamp is honoured.
    assert_eq!(p1[1].received_ms, 1_709_366_400_000);
    assert_eq!(p1[1].size, Some(1024));
    let next = next.expect("a nextLink");
    let (p2, next2) = c.list_page("pg-f", Some(&next)).await.unwrap();
    assert_eq!(p2.len(), 1);
    assert_eq!(p2[0].id, "pg-3");
    assert!(next2.is_none());

    let first = &seen("/me/mailFolders/pg-f/messages")[0];
    assert_eq!(first.method, "GET");
    assert!(first.query.contains("$top=1000"), "{}", first.query);
    assert!(first.query.contains("$select=id,receivedDateTime,internetMessageId"), "{}", first.query);
    assert!(first.query.contains("singleValueExtendedProperties"), "{}", first.query);
    assert!(first.query.contains("Integer 0x0E08"), "{}", first.query);
    assert_eq!(first.headers.get("authorization").map(String::as_str), Some(&*format!("Bearer {TOKEN}")));
}

#[tokio::test]
async fn list_page_without_the_size_property_gives_none() {
    route("/me/mailFolders/ns-f/messages", |_| {
        Resp::json(
            200,
            serde_json::json!({"value": [
                item("ns-1", "2024-03-01T10:00:00Z", "<a@x>", None),
                {"id": "ns-2", "receivedDateTime": "2024-03-01T10:00:00Z", "internetMessageId": "<b@x>",
                 "singleValueExtendedProperties": [{"id": "Integer 0x0E08", "value": "not a number"}]},
                {"id": "ns-3", "receivedDateTime": "2024-03-01T10:00:00Z", "internetMessageId": "<c@x>",
                 "singleValueExtendedProperties": [{"id": "integer 0xe08", "value": "77"}]},
            ]}),
        )
    });
    let (rows, next) = client().list_page("ns-f", None).await.unwrap();
    assert!(next.is_none());
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].size, None);
    assert_eq!(rows[1].size, None);
    // Graph may echo the property id in another case.
    assert_eq!(rows[2].size, Some(77));
}

#[tokio::test]
async fn list_page_drops_an_undated_message_instead_of_filing_it_under_1970() {
    route("/me/mailFolders/ud-f/messages", |_| {
        Resp::json(
            200,
            serde_json::json!({"value": [
                {"id": "ud-1", "internetMessageId": "<a@x>"},
                item("ud-2", "2024-03-01T10:00:00Z", "<b@x>", None),
            ]}),
        )
    });
    let (rows, _) = client().list_page("ud-f", None).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["ud-2"]);
}

#[tokio::test]
async fn list_page_never_sends_the_token_to_a_next_link_outside_the_graph_base() {
    let c = client();
    let err = c.list_page("nl-f", Some("http://127.0.0.1:1/steal?x=1")).await.unwrap_err();
    assert!(err.contains("nextLink"), "{err}");
    assert!(!err.contains(TOKEN));
    let err = c.list_page("nl-f", Some("https://evil.example/v1.0/me/messages")).await.unwrap_err();
    assert!(err.contains("nextLink"), "{err}");
}

#[tokio::test]
async fn message_exists_maps_404_to_false() {
    route("/me/messages/me-yes", |_| Resp::json(200, serde_json::json!({"id": "me-yes"})));
    let c = client();
    assert!(c.message_exists("me-yes").await.unwrap());
    assert!(!c.message_exists("me-no").await.unwrap());
    let r = &seen("/me/messages/me-yes")[0];
    assert_eq!(r.method, "GET");
    assert!(r.query.contains("$select=id"), "{}", r.query);
}

#[tokio::test]
async fn permanent_delete_posts_permanent_delete() {
    route("/me/messages/pd-1/permanentDelete", |_| Resp::empty(204));
    client().permanent_delete("pd-1").await.unwrap();
    let r = seen("/me/messages/pd-1");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].method, "POST");
    assert_eq!(r[0].path, "/me/messages/pd-1/permanentDelete");
}

#[tokio::test]
async fn find_by_internet_message_id_filters_and_returns_every_hit() {
    route("/me/mailFolders/fb-f/messages", |r| {
        if r.query.contains("eq '<dup@x>'") {
            Resp::json(200, serde_json::json!({"value": [{"id": "fb-1"}, {"id": "fb-2"}]}))
        } else if r.query.contains("eq '<a''b+c&d@x>'") {
            Resp::json(200, serde_json::json!({"value": [{"id": "fb-3"}]}))
        } else {
            Resp::json(200, serde_json::json!({"value": []}))
        }
    });
    let c = client();
    assert_eq!(c.find_by_internet_message_id("fb-f", "<dup@x>").await.unwrap(), vec!["fb-1", "fb-2"]);
    // A quote is doubled and the value is percent-encoded, so `+ & '` stay in it.
    assert_eq!(c.find_by_internet_message_id("fb-f", "<a'b+c&d@x>").await.unwrap(), vec!["fb-3"]);
    assert!(c.find_by_internet_message_id("fb-f", "<none@x>").await.unwrap().is_empty());
    let q = &seen("/me/mailFolders/fb-f/messages")[0].query;
    assert!(q.contains("$filter=internetMessageId eq '<dup@x>'"), "{q}");
}

#[tokio::test]
async fn a_429_error_carries_the_retry_after_the_server_sent() {
    route("/me/messages/rt-1", |_| Resp::json(429, serde_json::json!({"error": {"code": "TooManyRequests"}})).with_header("Retry-After", "7"));
    let err = client().message_exists("rt-1").await.unwrap_err();
    assert!(err.contains("(429:retry_after=7)"), "{err}");
    assert!(GraphClient::is_rate_limited(&err));
    assert_eq!(GraphClient::retry_after_from_error(&err), Some(7));
}

// ── GraphOps ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn folders_use_the_storage_key_and_the_well_known_role() {
    route("/me/mailFolders", |r| {
        if r.path != "/me/mailFolders" {
            return Resp::empty(404);
        }
        Resp::json(
            200,
            serde_json::json!({"value": [
                {"id": "fo-inbox", "displayName": "Posteingang", "totalItemCount": 3, "unreadItemCount": 0},
                {"id": "fo-del", "displayName": "Gelöschte Elemente", "totalItemCount": 1, "unreadItemCount": 0},
                {"id": "fo-junk", "displayName": "Junk-E-Mail", "totalItemCount": 0, "unreadItemCount": 0},
                {"id": "fo-own", "displayName": "Projekte", "totalItemCount": 9, "unreadItemCount": 0},
            ]}),
        )
    });
    route("/$batch", |_| {
        let ok = |id: &str, fid: &str| serde_json::json!({"id": id, "status": 200, "body": {"id": fid}});
        let no = |id: &str| serde_json::json!({"id": id, "status": 404});
        Resp::json(
            200,
            serde_json::json!({"responses": [
                ok("inbox", "fo-inbox"), no("sentitems"), no("drafts"),
                ok("deleteditems", "fo-del"), ok("junkemail", "fo-junk"), no("archive"),
            ]}),
        )
    });
    let mut o = ops();
    let folders = o.folders().await.unwrap();
    let by = |p: &str| folders.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("no folder {p}"));
    assert_eq!(by("INBOX").graph_id.as_deref(), Some("fo-inbox"));
    assert_eq!(by("INBOX").role, FolderRole::Normal);
    assert_eq!(by("Trash").role, FolderRole::Trash);
    assert_eq!(by("Trash").name, "Gelöschte Elemente");
    assert_eq!(by("Junk").role, FolderRole::Spam);
    assert_eq!(by("Projekte").role, FolderRole::Normal);
    let trash = o.trash().await.unwrap().expect("a Deleted Items folder");
    assert_eq!(trash.graph_id.as_deref(), Some("fo-del"));
    let caps = o.caps().await.unwrap();
    assert!(caps.move_cmd && caps.uidplus && !caps.gmail_ext);
    assert_eq!(o.uid_validity(&trash).await.unwrap(), None);
}

#[tokio::test]
async fn list_page_through_the_ops_gives_ledgerless_rows_and_a_cursor() {
    let base = stub().base.clone();
    route("/me/mailFolders/lo-f/messages", move |r| {
        if r.query.contains("$skiptoken=9") {
            Resp::json(200, serde_json::json!({"value": [item("lo-2", "2022-01-01T00:00:00Z", "<b@x>", None)]}))
        } else {
            Resp::json(
                200,
                serde_json::json!({
                    "value": [item("lo-1", "2024-03-01T10:00:00Z", "<a@x>", Some("4096"))],
                    "@odata.nextLink": format!("{base}/me/mailFolders/lo-f/messages?$skiptoken=9"),
                }),
            )
        }
    });
    let mut o = ops();
    let f = folder("Projekte", "lo-f", FolderRole::Normal);
    let p1 = o.list_page(&f, None).await.unwrap();
    assert_eq!(p1.uid_validity, None);
    assert_eq!(p1.items.len(), 1);
    let m = &p1.items[0];
    assert_eq!(m.uid, 0, "uids come from the ledger at plan freeze");
    assert_eq!(m.graph_id.as_deref(), Some("lo-1"));
    assert_eq!(m.message_id.as_deref(), Some("<a@x>"));
    assert_eq!(m.size, 4096);
    assert_eq!(m.internal_ms, 1_709_287_200_000);
    let p2 = o.list_page(&f, p1.next).await.unwrap();
    assert_eq!(p2.items[0].size, 0, "an unknown size is 0");
    assert!(p2.next.is_none());
}

#[tokio::test]
async fn fetch_returns_the_mime_and_counts_its_bytes_once() {
    let raw = b"From: a@x\r\nMessage-ID: <a@x>\r\n\r\nhello".to_vec();
    let body = raw.clone();
    route("/me/messages/fe-1/$value", move |_| Resp {
        status: 200,
        headers: vec![],
        body: body.clone(),
        hang: false,
        delay_ms: 0,
    });
    let mut o = ops();
    let f = folder("INBOX", "fe-f", FolderRole::Normal);
    let got = o.fetch(&f, &listed(5, "fe-1", Some("a@x"))).await.unwrap();
    assert_eq!(got.raw, raw);
    assert_eq!(o.uncounted_bytes(), raw.len() as u64);
    assert_eq!(o.uncounted_bytes(), 0, "reading the tally resets it");
    // A message that is gone is Gone, not an error to retry.
    match o.fetch(&f, &listed(6, "fe-missing", None)).await {
        Err(OpsError::Gone) => {}
        other => panic!("expected Gone, got {other:?}"),
    }
    assert_eq!(o.uncounted_bytes(), 0);
}

#[tokio::test]
async fn present_asks_the_server_and_treats_an_unknown_uid_as_present() {
    route("/me/messages/pr-1", |_| Resp::json(200, serde_json::json!({"id": "pr-1"})));
    let mut o = ops();
    let f = folder("INBOX", "pr-f", FolderRole::Normal);
    o.remember("INBOX", [(1, "pr-1".to_string()), (2, "pr-2".to_string())]);
    let mut got = o.present(&f, &[1, 2, 99]).await.unwrap();
    got.sort_unstable();
    // 2 is a 404 (moved away); 99 has no known id, so it is assumed still there.
    assert_eq!(got, vec![1, 99]);
}

#[tokio::test]
async fn move_returns_the_new_deleted_items_id() {
    route("/me/messages/mv-1/move", |_| Resp::json(201, serde_json::json!({"id": "mv-new-1"})));
    let mut o = ops();
    let f = folder("INBOX", "mv-f", FolderRole::Normal);
    let trash = folder("Trash", "mv-trash-id", FolderRole::Trash);
    let msgs = vec![listed(11, "mv-1", Some("a@x")), listed(12, "mv-2", Some("b@x"))];
    let r = o.move_to_trash(&f, &msgs, &trash).await.unwrap();
    // mv-2 is a 404: it is not in `moved`, so the engine keeps it.
    assert_eq!(r.moved, vec![11]);
    assert_eq!(r.graph_new_ids, Some(vec![(11, "mv-new-1".to_string())]));
    assert!(r.trash_uids.is_none(), "Trash uids are rebuilt by find_in_trash, so a restart loses nothing");
    let posts = seen("/me/messages/mv-1/move");
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].method, "POST");
    let body: serde_json::Value = serde_json::from_str(&posts[0].body).unwrap();
    assert_eq!(body["destinationId"], "mv-trash-id");
}

#[tokio::test]
async fn find_in_trash_keeps_a_duplicate_visible_and_present_follows_its_uids() {
    route("/me/mailFolders/ft-trash/messages", |r| {
        if r.query.contains("eq '<dup@x>'") {
            Resp::json(200, serde_json::json!({"value": [{"id": "ft-d1", "internetMessageId": "<dup@x>"}, {"id": "ft-d2", "internetMessageId": "<dup@x>"}]}))
        } else if r.query.contains("eq '<one@x>'") {
            Resp::json(200, serde_json::json!({"value": [{"id": "ft-o1", "internetMessageId": "<one@x>"}]}))
        } else {
            Resp::json(200, serde_json::json!({"value": []}))
        }
    });
    route("/me/messages/ft-o1", |_| Resp::json(200, serde_json::json!({"id": "ft-o1"})));
    let mut o = ops();
    let trash = folder("Trash", "ft-trash", FolderRole::Trash);
    let ids = vec!["one@x".to_string(), "dup@x".to_string(), "none@x".to_string()];
    let found = o.find_in_trash(&trash, &ids).await.unwrap();
    let of = |id: &str| found.iter().filter(|(k, _)| k == id).map(|(_, u)| *u).collect::<Vec<u32>>();
    assert_eq!(of("one@x").len(), 1);
    assert_eq!(of("dup@x").len(), 2, "a duplicate stays visible so the engine keeps it");
    assert!(of("none@x").is_empty());
    let mut all: Vec<u32> = found.iter().map(|(_, u)| *u).collect();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), 3, "each Trash hit gets its own uid");
    assert!(all.iter().all(|u| *u >= 0x8000_0000), "synthetic uids sit above any ledger uid");
    assert_eq!(o.present(&trash, &of("one@x")).await.unwrap(), of("one@x"));
}

#[tokio::test]
async fn permanent_delete_of_exactly_the_given_ids_and_only_when_the_message_id_matches() {
    route("/me/messages/ex-a", |r| {
        if r.method == "GET" {
            Resp::json(200, serde_json::json!({"id": "ex-a", "internetMessageId": "<a@x>"}))
        } else {
            Resp::empty(204)
        }
    });
    route("/me/messages/ex-b", |r| {
        if r.method == "GET" {
            Resp::json(200, serde_json::json!({"id": "ex-b", "internetMessageId": "<someone-else@x>"}))
        } else {
            Resp::empty(204)
        }
    });
    // ex-c answers 404 on the check: already gone, which counts as done.
    let mut o = ops();
    let trash = folder("Trash", "ex-trash", FolderRole::Trash);
    o.remember("Trash", [(7, "ex-a".to_string()), (8, "ex-b".to_string()), (9, "ex-c".to_string()), (10, "ex-untouched".to_string())]);
    let expect = vec![(7, "a@x".to_string()), (8, "b@x".to_string()), (9, "c@x".to_string()), (99, "z@x".to_string())];
    let done = o.expunge_exact(&trash, &[7, 8, 9, 99], &expect).await.unwrap();
    assert_eq!(done, vec![7, 9]);
    let posts: Vec<String> =
        stub().log.lock().unwrap().iter().filter(|r| r.method == "POST" && r.path.contains("/ex-")).map(|r| r.path.clone()).collect();
    assert_eq!(posts, vec!["/me/messages/ex-a/permanentDelete"], "only the matching, named id is deleted");
    assert!(seen("ex-untouched").is_empty(), "an id that was not asked for is never touched");
}

#[tokio::test]
async fn expunge_exact_propagates_a_throttle_so_the_retry_finishes_the_rest() {
    route("/me/messages/tl-a", |r| {
        if r.method == "GET" {
            Resp::json(200, serde_json::json!({"id": "tl-a", "internetMessageId": "<a@x>"}))
        } else {
            Resp::json(429, serde_json::json!({})).with_header("Retry-After", "3")
        }
    });
    let mut o = ops();
    let trash = folder("Trash", "tl-trash", FolderRole::Trash);
    o.remember("Trash", [(1, "tl-a".to_string())]);
    match o.expunge_exact(&trash, &[1], &[(1, "a@x".to_string())]).await {
        Err(OpsError::Throttled { retry_after_secs: Some(3), .. }) => {}
        other => panic!("expected a throttle with retry_after 3, got {other:?}"),
    }
}

// ── errors, the token and the timeout ───────────────────────────────────────

#[tokio::test]
async fn a_401_is_a_sign_in_signal_and_the_token_never_reaches_the_error() {
    // A hostile server that echoes the Authorization header into its answer.
    route("/me/messages/au-", |r| {
        let echoed = r.headers.get("authorization").cloned().unwrap_or_default();
        Resp::json(
            if r.path.contains("au-500") { 500 } else { 401 },
            serde_json::json!({"error": {"message": format!("bad header {echoed} for user@outlook.test")}}),
        )
    });
    let lease = cell(NOW + 3_600_000);
    let mut o = ops_with(&lease);
    let f = folder("INBOX", "au-f", FolderRole::Normal);
    let err = o.fetch(&f, &listed(1, "au-401", None)).await.unwrap_err();
    match &err {
        OpsError::SignIn(t) => {
            assert!(!t.contains(TOKEN), "token leaked: {t}");
            assert!(!t.contains("user@outlook.test"), "address not masked: {t}");
        }
        other => panic!("expected SignIn, got {other:?}"),
    }
    assert!(lease.lock().unwrap().is_none(), "a 401 drops the lease");

    let lease = cell(NOW + 3_600_000);
    let mut o = ops_with(&lease);
    let err = o.fetch(&f, &listed(2, "au-500", None)).await.unwrap_err();
    assert!(!err.text().contains(TOKEN), "token leaked: {}", err.text());
    assert!(lease.lock().unwrap().is_some(), "only a 401 drops the lease");
}

#[tokio::test]
async fn a_429_carries_retry_after() {
    route("/me/messages/r4-1/$value", |_| Resp::json(429, serde_json::json!({})).with_header("Retry-After", "42"));
    let mut o = ops();
    let f = folder("INBOX", "r4-f", FolderRole::Normal);
    match o.fetch(&f, &listed(1, "r4-1", None)).await {
        Err(OpsError::Throttled { retry_after_secs: Some(42), .. }) => {}
        other => panic!("expected Throttled with retry_after 42, got {other:?}"),
    }
}

#[tokio::test]
async fn every_call_is_bounded_by_a_timeout() {
    route("/me/messages/to-1/$value", |_| Resp::hang());
    let mut o = ops().with_timeout(Duration::from_millis(200));
    let f = folder("INBOX", "to-f", FolderRole::Normal);
    let started = std::time::Instant::now();
    let r = tokio::time::timeout(Duration::from_secs(2), o.fetch(&f, &listed(1, "to-1", None))).await;
    let r = r.expect("the call must return by itself");
    assert!(started.elapsed() < Duration::from_millis(1500));
    match r {
        Err(OpsError::Throttled { text, .. }) => assert!(text.contains("timed out"), "{text}"),
        other => panic!("expected a Throttled timeout, got {other:?}"),
    }
}

#[tokio::test]
async fn an_expired_lease_is_refused_before_any_request() {
    // Inside the 60 s margin counts as expired.
    let lease = cell(NOW + 30_000);
    let mut o = ops_with(&lease);
    let f = folder("INBOX", "ls-f", FolderRole::Normal);
    match o.fetch(&f, &listed(1, "ls-1", None)).await {
        Err(OpsError::SignIn(_)) => {}
        other => panic!("expected SignIn, got {other:?}"),
    }
    assert!(seen("ls-1").is_empty(), "no request may leave with a stale token");
    // No lease at all is the same signal.
    *lease.lock().unwrap() = None;
    assert!(matches!(o.fetch(&f, &listed(1, "ls-1", None)).await, Err(OpsError::SignIn(_))));
    assert!(seen("ls-1").is_empty());
}

#[test]
fn token_lease_debug_redacts_the_token() {
    let l = TokenLease { token: TOKEN.to_string(), expires_at_ms: 5 };
    let s = format!("{l:?}");
    assert!(!s.contains(TOKEN), "{s}");
    assert!(s.contains("expires_at_ms"), "{s}");
}

#[tokio::test]
async fn remember_plan_lets_present_and_expunge_find_messages_this_run_never_fetched() {
    route("/me/messages/rp-1", |_| Resp::json(200, serde_json::json!({"id": "rp-1"})));
    route("/me/messages/rp-2", |r| {
        if r.method == "GET" {
            Resp::json(200, serde_json::json!({"id": "rp-2", "internetMessageId": "<b@x>"}))
        } else {
            Resp::empty(204)
        }
    });
    let plan = FolderPlan {
        version: 1,
        path: "Trash".into(),
        graph_folder_id: Some("rp-trash".into()),
        uid_validity: None,
        uids: vec![4, 5],
        internal_ms: vec![0, 0],
        sizes: vec![0, 0],
        message_ids: vec![None, None],
        gm_msgids: None,
        graph_ids: Some(vec!["rp-1".into(), "rp-2".into()]),
    };
    let mut o = ops();
    o.remember_plan(&plan);
    let trash = folder("Trash", "rp-trash", FolderRole::Trash);
    assert_eq!(o.present(&trash, &[4, 5]).await.unwrap(), vec![4, 5]);
    assert_eq!(seen("/me/messages/rp-").len(), 2, "both ids were looked up, none assumed");
    let done = o.expunge_exact(&trash, &[5], &[(5, "b@x".to_string())]).await.unwrap();
    assert_eq!(done, vec![5]);
    let posts: Vec<String> = seen("/me/messages/rp-").iter().filter(|r| r.method == "POST").map(|r| r.path.clone()).collect();
    assert_eq!(posts, vec!["/me/messages/rp-2/permanentDelete"]);
}

#[tokio::test]
async fn a_refusal_a_retry_cannot_fix_reports_what_is_already_deleted() {
    route("/me/messages/ex2-a", |r| {
        if r.method == "GET" {
            Resp::json(200, serde_json::json!({"id": "ex2-a", "internetMessageId": "<a@x>"}))
        } else {
            Resp::empty(204)
        }
    });
    route("/me/messages/ex2-b", |r| {
        if r.method == "GET" {
            Resp::json(200, serde_json::json!({"id": "ex2-b", "internetMessageId": "<b@x>"}))
        } else {
            Resp::json(403, serde_json::json!({"error": {"code": "ErrorAccessDenied"}}))
        }
    });
    let mut o = ops();
    let trash = folder("Trash", "ex2-trash", FolderRole::Trash);
    o.remember("Trash", [(1, "ex2-a".to_string()), (2, "ex2-b".to_string()), (3, "ex2-c".to_string())]);
    let expect = vec![(1, "a@x".to_string()), (2, "b@x".to_string()), (3, "c@x".to_string())];
    // uid 1 is deleted for good, uid 2 is refused: the answer keeps uid 1 as done
    // instead of an Err that would count it as kept.
    let done = o.expunge_exact(&trash, &[1, 2, 3], &expect).await.unwrap();
    assert_eq!(done, vec![1]);
    assert!(seen("ex2-c").is_empty(), "it stops at a refusal");
}

#[tokio::test]
async fn find_in_trash_tries_the_bare_message_id_before_calling_it_absent() {
    route("/me/mailFolders/fk-trash/messages", |r| {
        if r.query.contains("eq 'bare@x'") {
            Resp::json(200, serde_json::json!({"value": [{"id": "fk-1"}]}))
        } else {
            Resp::json(200, serde_json::json!({"value": []}))
        }
    });
    let mut o = ops();
    let trash = folder("Trash", "fk-trash", FolderRole::Trash);
    let found = o.find_in_trash(&trash, &["bare@x".to_string(), "missing@x".to_string()]).await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, "bare@x");
    let queries: Vec<String> = seen("/me/mailFolders/fk-trash/messages").iter().map(|r| r.query.clone()).collect();
    assert_eq!(queries.len(), 4, "each id is tried bracketed, then bare: {queries:?}");
    assert!(queries[0].contains("eq '<bare@x>'") && queries[1].contains("eq 'bare@x'"), "{queries:?}");
}

#[tokio::test]
async fn a_big_download_gets_time_for_its_size_on_top_of_the_request_bound() {
    route("/me/messages/sl-1/$value", |_| {
        Resp { status: 200, headers: vec![], body: b"slow body".to_vec(), hang: false, delay_ms: 600 }
    });
    let mut o = ops().with_timeout(Duration::from_millis(200));
    let f = folder("INBOX", "sl-f", FolderRole::Normal);
    // 160 KiB at the 32 KiB/s floor is 5 s more than the 200 ms bound.
    let mut big = listed(1, "sl-1", None);
    big.size = 160 * 1024;
    let got = o.fetch(&f, &big).await.unwrap();
    assert_eq!(got.raw, b"slow body");
    // The same answer for a small message misses the bound.
    let small = listed(2, "sl-1", None);
    assert!(matches!(o.fetch(&f, &small).await, Err(OpsError::Throttled { .. })));
}
