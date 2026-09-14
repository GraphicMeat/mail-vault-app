//! The app's side of the daemon socket when it cannot be async: one connection,
//! token handshake, one request, one reply. Also the pure pieces of the app's
//! channel loop, here so CI tests them (CI never runs app-crate tests).

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum CallError {
    /// No daemon answered: socket missing, refused, closed, timed out, or the token was rejected.
    Unreachable(String),
    /// The daemon answered with a JSON-RPC error.
    Rpc(String),
}

fn unreachable(e: impl ToString) -> CallError {
    CallError::Unreachable(e.to_string())
}

fn read_json(r: &mut BufReader<UnixStream>) -> Result<Value, CallError> {
    let mut line = String::new();
    match r.read_line(&mut line) {
        Ok(0) => Err(unreachable("daemon closed the connection")),
        Ok(_) => serde_json::from_str(&line).map_err(unreachable),
        Err(e) => Err(unreachable(e)),
    }
}

fn write_json(w: &mut UnixStream, v: &Value) -> Result<(), CallError> {
    let mut buf = v.to_string().into_bytes();
    buf.push(b'\n');
    w.write_all(&buf).map_err(unreachable)
}

pub fn call(socket: &Path, token: &str, method: &str, params: Value, timeout: Duration) -> Result<Value, CallError> {
    let stream = UnixStream::connect(socket).map_err(unreachable)?;
    stream.set_read_timeout(Some(timeout)).map_err(unreachable)?;
    stream.set_write_timeout(Some(timeout)).map_err(unreachable)?;
    let mut writer = stream.try_clone().map_err(unreachable)?;
    let mut reader = BufReader::new(stream);
    write_json(&mut writer, &json!({"token": token.trim()}))?;
    if read_json(&mut reader)?.get("error").is_some() {
        return Err(unreachable("daemon rejected the token"));
    }
    write_json(&mut writer, &json!({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}))?;
    let resp = read_json(&mut reader)?;
    if let Some(err) = resp.get("error") {
        return Err(CallError::Rpc(err.get("message").and_then(Value::as_str).unwrap_or("daemon error").to_string()));
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

pub const BACKOFF_FIRST: Duration = Duration::from_millis(250);
pub const BACKOFF_MAX: Duration = Duration::from_secs(5);

/// 250 ms, doubling, capped at 5 s. `None` = the connection just dropped.
pub fn next_backoff(prev: Option<Duration>) -> Duration {
    prev.map_or(BACKOFF_FIRST, |d| (d * 2).min(BACKOFF_MAX))
}

#[derive(Debug, PartialEq, Eq)]
pub enum BuildCheck {
    Same,
    /// Stop that daemon and spawn our own sidecar.
    Restart,
    /// Still different after our one restart (a stale staged sidecar): log and use it, never loop.
    Accept,
}

pub fn check_build(ours: &str, theirs: Option<&str>, already_restarted: bool) -> BuildCheck {
    match theirs {
        Some(t) if t == ours => BuildCheck::Same,
        _ if already_restarted => BuildCheck::Accept,
        _ => BuildCheck::Restart,
    }
}

pub fn parse_event(line: &str) -> Option<(String, Value)> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("method")?.as_str()? != "event" {
        return None;
    }
    let params = v.get("params")?.as_object()?;
    let name = params.get("name")?.as_str()?.to_string();
    Some((name, params.get("payload").cloned().unwrap_or(Value::Null)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    fn sock() -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("mvc-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("s.sock"), dir)
    }

    /// One connection: expect the token, answer auth, answer one request with `reply`.
    fn serve_once(path: &std::path::Path, token_ok: bool, reply: Value) -> std::thread::JoinHandle<Value> {
        let listener = UnixListener::bind(path).unwrap();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut w = stream.try_clone().unwrap();
            let mut r = BufReader::new(stream);
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            if !token_ok {
                writeln!(w, "{}", json!({"jsonrpc":"2.0","error":{"code":-32001,"message":"Authentication failed"},"id":null})).unwrap();
                return Value::Null;
            }
            writeln!(w, "{}", json!({"jsonrpc":"2.0","result":{"authenticated":true},"id":null})).unwrap();
            line.clear();
            r.read_line(&mut line).unwrap();
            let req: Value = serde_json::from_str(&line).unwrap();
            let mut resp = reply;
            if let Some(obj) = resp.as_object_mut() {
                obj.insert("id".into(), req["id"].clone());
            }
            writeln!(w, "{resp}").unwrap();
            req
        })
    }

    #[test]
    fn call_returns_the_result_after_the_token_handshake() {
        let (path, dir) = sock();
        let server = serve_once(&path, true, json!({"jsonrpc":"2.0","result":{"pong":true}}));
        let got = call(&path, "tok\n", "ping", json!({"a": 1}), Duration::from_secs(2));
        assert_eq!(got, Ok(json!({"pong": true})));
        let req = server.join().unwrap();
        assert_eq!(req["method"], "ping");
        assert_eq!(req["params"], json!({"a": 1}));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_rpc_error_is_rpc_not_unreachable() {
        let (path, dir) = sock();
        let _server = serve_once(&path, true, json!({"jsonrpc":"2.0","error":{"code":-32601,"message":"Unknown method: x"}}));
        assert_eq!(call(&path, "tok", "x", json!({}), Duration::from_secs(2)), Err(CallError::Rpc("Unknown method: x".into())));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_socket_is_unreachable() {
        let (path, dir) = sock();
        assert!(matches!(call(&path, "tok", "ping", json!({}), Duration::from_secs(1)), Err(CallError::Unreachable(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_rejected_token_is_unreachable() {
        let (path, dir) = sock();
        let _server = serve_once(&path, false, Value::Null);
        assert!(matches!(call(&path, "bad", "ping", json!({}), Duration::from_secs(2)), Err(CallError::Unreachable(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn backoff_doubles_from_250ms_and_caps_at_5s() {
        let mut d = next_backoff(None);
        assert_eq!(d, Duration::from_millis(250));
        let mut seen = vec![d];
        for _ in 0..8 {
            d = next_backoff(Some(d));
            seen.push(d);
        }
        assert_eq!(&seen[..6], &[250, 500, 1000, 2000, 4000, 5000].map(Duration::from_millis));
        assert_eq!(*seen.last().unwrap(), Duration::from_secs(5));
    }

    #[test]
    fn a_build_mismatch_restarts_once_then_is_accepted() {
        assert_eq!(check_build("abc", Some("abc"), false), BuildCheck::Same);
        assert_eq!(check_build("abc", Some("abc"), true), BuildCheck::Same);
        assert_eq!(check_build("abc", Some("old"), false), BuildCheck::Restart);
        assert_eq!(check_build("abc", None, false), BuildCheck::Restart, "a daemon too old to report a build id");
        assert_eq!(check_build("abc", Some("old"), true), BuildCheck::Accept);
    }

    #[test]
    fn parse_event_reads_name_and_payload_and_ignores_everything_else() {
        let line = json!({"jsonrpc":"2.0","method":"event","params":{"name":"daemon-ping","payload":{"n":1}}}).to_string();
        assert_eq!(parse_event(&line), Some(("daemon-ping".to_string(), json!({"n": 1}))));
        let no_payload = json!({"jsonrpc":"2.0","method":"event","params":{"name":"x"}}).to_string();
        assert_eq!(parse_event(&no_payload), Some(("x".to_string(), Value::Null)));
        assert_eq!(parse_event(&json!({"jsonrpc":"2.0","result":{},"id":1}).to_string()), None);
        assert_eq!(parse_event("not json"), None);
        assert_eq!(parse_event(&json!({"method":"event","params":[1]}).to_string()), None);
    }
}
