use super::*;
use std::sync::atomic::AtomicUsize;
fn attempt(execution: &str, generation: &str) -> Attempt {
    Attempt {
        incarnation: "daemon-a".into(),
        run_id: "logical-run".into(),
        execution_id: execution.into(),
        owner_id: "shell-a".into(),
        acquisition_id: generation.into(),
    }
}
fn holder() -> NativeBackupAccess {
    let held = NativeBackupAccess::default();
    *held.session.lock().unwrap() = Some("shell-a".into());
    held
}
struct Fake<'a> {
    held: &'a NativeBackupAccess,
    pending: Mutex<Vec<Value>>,
    receipts: Mutex<HashMap<Attempt, (&'static str, bool)>>,
    acquired: AtomicUsize,
    released: Mutex<Vec<String>>,
    attached: Mutex<Vec<Attempt>>,
}
impl<'a> Fake<'a> {
    fn new(held: &'a NativeBackupAccess) -> Self {
        Self {
            held,
            pending: Mutex::new(vec![
                json!({"runId":"logical-run","executionId":"execution-a"}),
            ]),
            receipts: Mutex::default(),
            acquired: AtomicUsize::new(0),
            released: Mutex::default(),
            attached: Mutex::default(),
        }
    }
}
impl Ports for Fake<'_> {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "backup.schedule.status" => Ok(
                json!({"accessIncarnation":"daemon-a","pendingAccess":*self.pending.lock().unwrap()}),
            ),
            "backup.attach_access" => {
                let a: Attach = serde_json::from_value(params).unwrap();
                assert!(
                    self.held.holds.lock().unwrap().contains_key(&a.attempt),
                    "attach raced before native scope registration"
                );
                self.attached.lock().unwrap().push(a.attempt.clone());
                self.receipts
                    .lock()
                    .unwrap()
                    .insert(a.attempt, ("running", false));
                Err("reply timed out after acceptance".into())
            }
            "backup.access_status" => {
                let q: Query = serde_json::from_value(params).unwrap();
                let (phase, safe) = self
                    .receipts
                    .lock()
                    .unwrap()
                    .get(&q.attempt)
                    .copied()
                    .unwrap_or(("foreign_incarnation", false));
                Ok(json!({"attempt":q.attempt,"state":phase,"safeRelease":safe}))
            }
            _ => panic!("unexpected method"),
        }
    }
    fn resolve(&self) -> AttachResolution {
        self.acquired.fetch_add(1, SeqCst);
        AttachResolution {
            stamp: Some("native-stamp".into()),
            result: Resolution::Authorized {
                root: "/shared-drive".into(),
            },
        }
    }
    fn release(&self, path: &str) {
        self.released.lock().unwrap().push(path.into());
    }
}
#[test]
fn backup_access_lost_ack_and_terminal_event_wait_for_exact_joined_receipt() {
    let held = holder();
    let ports = Fake::new(&held);
    reconcile(&held, &ports, "shell-a");
    let a = ports.attached.lock().unwrap()[0].clone();
    assert_eq!(held.holds.lock().unwrap().len(), 1);
    assert_eq!(ports.released.lock().unwrap().len(), 0);
    reconcile(&held, &ports, "shell-a"); // Same-daemon reconnect, still running.
    assert_eq!(ports.acquired.load(SeqCst), 1);
    assert_eq!(ports.released.lock().unwrap().len(), 0);
    release_receipt(
        &held,
        &ports,
        &a,
        &json!({"attempt":a,"state":"stopping","safeRelease":false}),
    );
    assert_eq!(held.holds.lock().unwrap().len(), 1);
    ports.pending.lock().unwrap().clear();
    ports
        .receipts
        .lock()
        .unwrap()
        .insert(a.clone(), ("drained", true));
    reconcile(&held, &ports, "shell-a");
    reconcile(&held, &ports, "shell-a");
    assert_eq!(ports.released.lock().unwrap().len(), 1);
    assert!(held.holds.lock().unwrap().is_empty());
}
#[test]
fn backup_access_same_path_acquisitions_and_same_run_retry_are_independent() {
    let held = holder();
    let ports = Fake::new(&held);
    ports
        .pending
        .lock()
        .unwrap()
        .push(json!({"runId":"other-run","executionId":"execution-b"}));
    reconcile(&held, &ports, "shell-a");
    let attached = ports.attached.lock().unwrap().clone();
    assert_eq!(attached.len(), 2);
    assert_eq!(ports.acquired.load(SeqCst), 2);
    ports.pending.lock().unwrap().clear();
    ports
        .receipts
        .lock()
        .unwrap()
        .insert(attached[0].clone(), ("drained", true));
    reconcile(&held, &ports, "shell-a");
    assert_eq!(ports.released.lock().unwrap().len(), 1);
    assert_eq!(held.holds.lock().unwrap().len(), 1);
    ports
        .pending
        .lock()
        .unwrap()
        .push(json!({"runId":"logical-run","executionId":"execution-retry"}));
    reconcile(&held, &ports, "shell-a");
    assert_eq!(ports.acquired.load(SeqCst), 3);
    assert_eq!(held.holds.lock().unwrap().len(), 2);
    release_receipt(
        &held,
        &ports,
        &attached[0],
        &json!({"attempt":attached[0],"state":"drained","safeRelease":true}),
    );
    assert_eq!(ports.released.lock().unwrap().len(), 1);
}
#[test]
fn backup_access_old_status_reply_cannot_release_replacement_generation() {
    let held = holder();
    let ports = Fake::new(&held);
    ports.pending.lock().unwrap().clear();
    let old = attempt("execution-a", "old");
    let fresh = attempt("execution-a", "fresh");
    held.holds
        .lock()
        .unwrap()
        .insert(old.clone(), "/shared-drive".into());
    struct Race<'a> {
        base: &'a Fake<'a>,
        old: Attempt,
        fresh: Attempt,
    }
    impl Ports for Race<'_> {
        fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            if method == "backup.access_status" {
                let old = self
                    .base
                    .held
                    .holds
                    .lock()
                    .unwrap()
                    .remove(&self.old)
                    .unwrap();
                self.base.release(&old);
                self.base
                    .held
                    .holds
                    .lock()
                    .unwrap()
                    .insert(self.fresh.clone(), "/shared-drive".into());
                return Ok(json!({"attempt":self.old,"state":"drained","safeRelease":true}));
            }
            self.base.call(method, params)
        }
        fn resolve(&self) -> AttachResolution {
            self.base.resolve()
        }
        fn release(&self, path: &str) {
            self.base.release(path)
        }
    }
    reconcile(
        &held,
        &Race {
            base: &ports,
            old: old.clone(),
            fresh: fresh.clone(),
        },
        "shell-a",
    );
    assert!(held.holds.lock().unwrap().contains_key(&fresh));
    assert_eq!(ports.released.lock().unwrap().len(), 1);
}
#[test]
fn backup_access_replacement_shell_requires_fresh_acquisition_and_keeps_unknown_old_hold() {
    let held = holder();
    let ports = Fake::new(&held);
    let old = attempt("old-execution", "old");
    held.holds
        .lock()
        .unwrap()
        .insert(old, "/shared-drive".into());
    *held.session.lock().unwrap() = Some("shell-b".into());
    reconcile(&held, &ports, "shell-a");
    assert_eq!(ports.acquired.load(SeqCst), 0);
    reconcile(&held, &ports, "shell-b");
    assert_eq!(ports.attached.lock().unwrap()[0].owner_id, "shell-b");
    assert_eq!(ports.acquired.load(SeqCst), 1);
    assert_eq!(ports.released.lock().unwrap().len(), 0);
    assert_eq!(held.holds.lock().unwrap().len(), 2);
}
#[test]
fn backup_access_slot_change_during_resolution_never_relabels_old_root() {
    let dir = tempfile::tempdir().unwrap();
    let save = |at| {
        mailvault_core::app_db::with(dir.path(), |c| {
            mailvault_core::app_db::locations::save_meta(
                c,
                "external-backup",
                "/chosen",
                "native",
                at,
                false,
            )
        })
        .unwrap()
    };
    save(1);
    let old = wire::slot_stamp(dir.path()).unwrap().unwrap();
    let acquired = AtomicUsize::new(0);
    let released = Mutex::new(Vec::<String>::new());
    let resolved = resolve_saved(
        || wire::slot_stamp(dir.path()),
        || {
            if acquired.fetch_add(1, SeqCst) == 0 {
                save(2);
                Ok("/old-root".into())
            } else {
                Ok("/fresh-root".into())
            }
        },
        |path| released.lock().unwrap().push(path.into()),
    );
    assert!(matches!(resolved.result,Resolution::Authorized{root} if root=="/fresh-root"));
    assert_ne!(resolved.stamp.as_deref(), Some(old.as_str()));
    assert_eq!(*released.lock().unwrap(), vec!["/old-root"]);
    assert_eq!(acquired.load(SeqCst), 2);
}
#[test]
fn backup_access_unknown_slot_is_not_absent_and_never_resolves_a_raw_path() {
    let called = AtomicUsize::new(0);
    let result = resolve_saved(
        || Err("unreadable".into()),
        || {
            called.fetch_add(1, SeqCst);
            Ok("/caller-path".into())
        },
        |_| panic!("nothing acquired"),
    );
    assert!(matches!(result.result, Resolution::Unknown));
    assert_eq!(called.load(SeqCst), 0);
    let result = resolve_saved(
        || Ok(None),
        || panic!("known absent needs no scope"),
        |_| panic!("nothing acquired"),
    );
    assert!(matches!(result.result, Resolution::NotConfigured));
}

/// Actual shell resolver and direct native RPC against a freshly built daemon.
/// Uses an isolated portable fixture so it never changes the runner's HOME or
/// installed account/keychain state. The fixture follows the production scope
/// rules through the real bookmark resolver on macOS.
#[cfg(unix)]
#[test]
#[ignore = "requires a freshly built daemon, selected explicitly by the mini gate"]
fn backup_access_fresh_shell_daemon_reconnect() {
    use mailvault_core::{paths, portable, settings_doc::SettingsDoc};
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    struct Daemon {
        child: Option<Child>,
        ipc: std::path::PathBuf,
    }
    impl Drop for Daemon {
        fn drop(&mut self) {
            if let Some(mut c) = self.child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            let _ = std::fs::remove_dir_all(&self.ipc);
        }
    }
    let binary =
        std::env::var_os("MAILVAULT_NATIVE_BACKUP_DAEMON").expect("fresh daemon binary required");
    let dir = tempfile::Builder::new()
        .prefix("mv-native-access-")
        .tempdir()
        .unwrap();
    let root = dir.path();
    std::fs::write(root.join("portable.json"), br#"{"version":1}"#).unwrap();
    let app = paths::portable_data_dir(root);
    std::fs::create_dir_all(&app).unwrap();
    let ipc = paths::portable_ipc_dir(&paths::home_dir().unwrap(), root);
    let endpoint = mailvault_core::transport::endpoint(&ipc);
    let raw=b"From: sender@test\r\nTo: native@test\r\nSubject: native handoff\r\nMessage-ID: <native-access@test>\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\n\r\nNative mirror body.\r\n";
    let mut mailbox = mock_imap::Mailbox::new("INBOX");
    mailbox.messages.push(mock_imap::Message {
        uid: 1,
        raw: raw.to_vec(),
        ..Default::default()
    });
    mailbox.uid_next = 2;
    let mock = mock_imap::MockImap::start(mock_imap::Scenario::new().mailbox(mailbox).fault(
        mock_imap::Trigger::with("FETCH", "BODY.PEEK[]"),
        mock_imap::Action::Delay(Duration::from_secs(3)),
    ));
    let account = json!({"id":"native","email":"native@test","password":"fixture-password","imapHost":"127.0.0.1","imapPort":mock.port(),"imapSecure":false,"authType":"password"});
    let mut secrets = portable::Secrets::default();
    secrets
        .credentials
        .insert("native".into(), account.to_string());
    portable::write_sealed(
        &app.join(portable::SEALED_FILE),
        "native fixture passphrase",
        &secrets,
        mailvault_core::transfer::crypto::Params {
            m_kib: mailvault_core::transfer::crypto::MIN_M_KIB,
            t: 1,
            p: 1,
        },
    )
    .unwrap();
    std::fs::write(
        app.join("accounts.json"),
        br#"[{"id":"native","email":"native@test"}]"#,
    )
    .unwrap();
    SettingsDoc::shared(&app).replace(&json!({"mailvault-settings":{"version":3,"state":{"backupState":{},"backupHistory":{}}}}),None).unwrap();
    let mirror = root.join("mirror");
    std::fs::create_dir(&mirror).unwrap();
    external_location::save_external_location(
        &app,
        external_location::SLOT_EXTERNAL_BACKUP,
        mirror.to_str().unwrap(),
    )
    .unwrap();
    let spawn = || {
        Command::new(&binary)
            .env(paths::PORTABLE_ENV, root)
            .env("MAILVAULT_IMAP_PLAINTEXT", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut daemon = Daemon {
        child: Some(spawn()),
        ipc: ipc.clone(),
    };
    fn until(mut check: impl FnMut() -> bool, label: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !check() {
            assert!(
                Instant::now() < deadline,
                "native integration timed out: {label}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let mut token = String::new();
    until(
        || {
            token = std::fs::read_to_string(ipc.join("mv.token")).unwrap_or_default();
            !token.is_empty()
                && mailvault_core::daemon_ipc::call(
                    &endpoint,
                    &token,
                    "ping",
                    json!({}),
                    Duration::from_secs(1),
                )
                .is_ok()
        },
        "daemon ready",
    );
    let rpc = |method: &str, params: Value| {
        mailvault_core::daemon_ipc::call(&endpoint, &token, method, params, Duration::from_secs(30))
            .expect("native RPC")
    };
    rpc(
        "portable.unlock",
        json!({"passphrase":"native fixture passphrase"}),
    );
    struct Channel {
        stream: UnixStream,
        reader: Option<std::thread::JoinHandle<()>>,
        pings: std::sync::Arc<AtomicUsize>,
        access_events: std::sync::Arc<AtomicUsize>,
    }
    impl Drop for Channel {
        fn drop(&mut self) {
            let _ = self.stream.shutdown(std::net::Shutdown::Both);
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        }
    }
    fn owner(endpoint: &std::path::Path, token: &str, id: &str) -> Channel {
        let mut stream = UnixStream::connect(endpoint).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        writeln!(stream, "{}", json!({"token":token.trim()})).unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        writeln!(
            stream,
            "{}",
            json!({"jsonrpc":"2.0","method":"channel.open","params":{"backupOwner":id},"id":1})
        )
        .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let ack: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ack["result"]["channel"], true);
        let pings = std::sync::Arc::new(AtomicUsize::new(0));
        let observed = pings.clone();
        let access_events = std::sync::Arc::new(AtomicUsize::new(0));
        let triggered = access_events.clone();
        let task = std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if let Ok(event) = serde_json::from_str::<Value>(&line) {
                            if event["params"]["name"] == "daemon-ping" {
                                observed.fetch_add(1, SeqCst);
                            }
                            if let Some(name) = event["params"]["name"].as_str() {
                                crate::daemon_channel::schedule_backup_access_event(name, || {
                                    triggered.fetch_add(1, SeqCst);
                                });
                            }
                        }
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => break,
                }
            }
        });
        Channel {
            stream,
            reader: Some(task),
            pings,
            access_events,
        }
    }
    struct Native<'a> {
        app: &'a std::path::Path,
        endpoint: &'a std::path::Path,
        token: &'a str,
        acquired: AtomicUsize,
        released: AtomicUsize,
        lose_ack: AtomicBool,
        last_status: Mutex<Value>,
        unavailable: AtomicBool,
        resolutions: AtomicUsize,
    }
    impl Ports for Native<'_> {
        fn call(&self, m: &str, p: Value) -> Result<Value, String> {
            let result = mailvault_core::daemon_ipc::call(
                self.endpoint,
                self.token,
                m,
                p,
                Duration::from_secs(30),
            )
            .map_err(|_| "native RPC unavailable".into());
            if m == "backup.schedule.status" {
                if let Ok(value) = &result {
                    *self.last_status.lock().unwrap() = json!({"ready":value["ready"],"incarnation":value["accessIncarnation"],"pendingStages":value["pendingAccess"].as_array().map(|items|items.iter().map(|i|i["stage"].clone()).collect::<Vec<_>>()),"activeStage":value["active"]["stage"]});
                }
            }
            if m == "backup.attach_access"
                && result.as_ref().is_ok_and(|v| v["state"] == "accepted")
                && self.lose_ack.swap(false, SeqCst)
            {
                Err("accepted native ACK deliberately lost at the RPC boundary".into())
            } else {
                result
            }
        }
        fn resolve(&self) -> AttachResolution {
            self.resolutions.fetch_add(1, SeqCst);
            if self.unavailable.load(SeqCst) {
                return AttachResolution {
                    stamp: wire::slot_stamp(self.app).unwrap(),
                    result: Resolution::Unavailable,
                };
            }
            let r = resolve_native(self.app);
            assert!(
                matches!(r.result, Resolution::Authorized { .. }),
                "actual saved native resolver unavailable in the connected fixture"
            );
            if matches!(r.result, Resolution::Authorized { .. }) {
                self.acquired.fetch_add(1, SeqCst);
            }
            r
        }
        fn release(&self, path: &str) {
            self.released.fetch_add(1, SeqCst);
            release_backup_path(path);
        }
    }
    let native = Native {
        app: &app,
        endpoint: &endpoint,
        token: &token,
        acquired: AtomicUsize::new(0),
        released: AtomicUsize::new(0),
        lose_ack: AtomicBool::new(true),
        last_status: Mutex::new(Value::Null),
        unavailable: AtomicBool::new(true),
        resolutions: AtomicUsize::new(0),
    };
    let held = holder();
    let first = rpc(
        "backup.run_now",
        json!({"accountId":"native","requestId":"native-manual"}),
    );
    until(
        || {
            rpc("backup.schedule.status", json!({}))["pendingAccess"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
        },
        "pending without shell",
    );
    assert!(
        mock.commands().is_empty(),
        "configured backup started without an authorizing shell"
    );
    // A configured disconnected drive yields no authority. Follow only actual
    // socket events through the same production hook, with a finite test cap.
    let unavailable_channel = owner(&endpoint, &token, "shell-unavailable");
    *held.session.lock().unwrap() = Some("shell-unavailable".into());
    reconcile(&held, &native, "shell-unavailable");
    let mut quiet_since = Instant::now();
    let feedback_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let events = unavailable_channel.access_events.swap(0, SeqCst);
        if events > 0 {
            if native.resolutions.load(SeqCst) >= 8 {
                break;
            }
            reconcile(&held, &native, "shell-unavailable");
            quiet_since = Instant::now();
        }
        if quiet_since.elapsed() >= Duration::from_millis(200)
            || Instant::now() >= feedback_deadline
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let unavailable_status = rpc("backup.schedule.status", json!({}));
    let unavailable_attempts = native.resolutions.load(SeqCst);
    let unavailable_receipts = unavailable_status["accessReceipts"]
        .as_array()
        .unwrap()
        .len();
    let unavailable_bounded = unavailable_attempts <= 3 && unavailable_receipts <= 3;
    let unchanged_intent = unavailable_status["pendingAccess"]
        .as_array()
        .is_some_and(|items| {
            items
                .iter()
                .any(|i| i["runId"] == first["runId"] && i["executionId"] == first["executionId"])
        });
    let unavailable_no_work = mock.commands().is_empty()
        && unavailable_status["lastOutcomes"]
            .as_array()
            .unwrap()
            .is_empty();
    println!("NATIVE_UNAVAILABLE_FEEDBACK: resolutions={} receipts={} bounded={} sameIntent={} noProvider={}",unavailable_attempts,unavailable_receipts,unavailable_bounded,unchanged_intent,unavailable_no_work);
    drop(unavailable_channel);
    // A genuine availability change and new native connection must recover the
    // same pending intent, through the actual saved bookmark resolver.
    native.unavailable.store(false, SeqCst);
    *held.session.lock().unwrap() = Some("shell-a".into());
    let mut channel = owner(&endpoint, &token, "shell-a");
    struct Paused<'a, 'b> {
        base: &'a Native<'b>,
        entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Ports for Paused<'_, '_> {
        fn call(&self, m: &str, p: Value) -> Result<Value, String> {
            self.base.call(m, p)
        }
        fn resolve(&self) -> AttachResolution {
            self.entered
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(())
                .unwrap();
            self.release.lock().unwrap().recv().unwrap();
            self.base.resolve()
        }
        fn release(&self, path: &str) {
            self.base.release(path)
        }
    }
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let paused = Paused {
        base: &native,
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(release_rx),
    };
    let auth_events=channel.access_events.clone();
    std::thread::scope(|scope| {
        let task = scope.spawn(|| {
            reconcile(&held,&paused,"shell-a");
            if paused.entered.lock().unwrap().is_some() {println!("NATIVE_AUTH_CONNECT_WAIT: {}",native.last_status.lock().unwrap());}
            let deadline=Instant::now()+Duration::from_secs(5);
            while paused.entered.lock().unwrap().is_some() && Instant::now()<deadline {
                let events=auth_events.swap(0,SeqCst);
                if events>0 {reconcile(&held,&paused,"shell-a");}
                else {std::thread::sleep(Duration::from_millis(10));}
            }
        });
        let entered=entered_rx.recv_timeout(Duration::from_secs(5));
        if entered.is_err() {
            let _=release_tx.send(());task.join().unwrap();
            panic!("actual connect/event hook did not enter the paused native resolver");
        }
        let started = Instant::now();
        let ping = native.call("ping", json!({}));
        let responsive = started.elapsed() < Duration::from_secs(1);
        writeln!(channel.stream,"{}",json!({"jsonrpc":"2.0","method":"daemon.ping","params":{"nonce":"paused-native-resolver"}})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while channel.pings.load(SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let pumped = channel.pings.load(SeqCst) > 0;
        release_tx.send(()).unwrap();
        task.join().unwrap();
        assert!(
            ping.is_ok() && responsive,
            "pending native resolver blocked unrelated RPC"
        );
        assert!(
            pumped,
            "pending native resolver blocked native event channel"
        );
    });
    until(
        || {
            mock.commands()
                .iter()
                .any(|c| c.to_uppercase().contains("BODY.PEEK[]"))
        },
        "actual body fetch entered",
    );
    assert!(
        !native.lose_ack.load(SeqCst),
        "actual accepted ACK was not exercised"
    );
    let old = held.holds.lock().unwrap().keys().next().unwrap().clone();
    let started = Instant::now();
    rpc("ping", json!({}));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "paused body blocked unrelated RPC"
    );
    assert_eq!(
        rpc(
            "backup.access_status",
            serde_json::to_value(Query {
                attempt: old.clone(),
                fence_unstarted: true
            })
            .unwrap()
        )["safeRelease"],
        false
    );
    // An unrelated consumer acquires the very same saved native location.
    // Its one release cannot consume the scheduler's independent acquisition.
    let other = resolve_native(&app);
    let Resolution::Authorized { root: other_root } = other.result else {
        panic!("second actual native acquisition unavailable");
    };
    assert_eq!(
        std::fs::canonicalize(&other_root).unwrap(),
        std::fs::canonicalize(&mirror).unwrap()
    );
    release_backup_path(&other_root);
    assert_eq!(held.holds.lock().unwrap().len(), 1);
    // Lose the actual authorizing channel while the real provider is paused.
    drop(channel);
    let channel = owner(&endpoint, &token, "shell-b");
    *held.session.lock().unwrap() = Some("shell-b".into());
    reconcile(&held, &native, "shell-b");
    assert_eq!(native.released.load(SeqCst), 0);
    until(
        || {
            rpc("backup.schedule.status", json!({}))["pendingAccess"]
                .as_array()
                .is_some_and(|a| a.iter().any(|i| i["executionId"] != first["executionId"]))
        },
        "old provider joined and fresh execution pending",
    );
    reconcile(&held, &native, "shell-b");
    if native.acquired.load(SeqCst) != 2 {
        println!(
            "NATIVE_OWNER_FIRST_RECONCILE: {}",
            native.last_status.lock().unwrap()
        );
    }
    until(
        || {
            if native.acquired.load(SeqCst) == 2 {
                return true;
            }
            let events = channel.access_events.swap(0, SeqCst);
            if events > 0 {
                reconcile(&held, &native, "shell-b");
                println!(
                    "NATIVE_OWNER_EVENT_RECONCILE: triggers={} acquired={} status={}",
                    events,
                    native.acquired.load(SeqCst),
                    native.last_status.lock().unwrap()
                );
            }
            native.acquired.load(SeqCst) == 2
        },
        "event-triggered second actual native acquisition after owner loss",
    );
    assert_eq!(native.acquired.load(SeqCst), 2);
    assert_eq!(native.released.load(SeqCst), 1);
    until(
        || {
            rpc("backup.schedule.status", json!({}))["requests"]["native-manual"]["status"]
                == "success"
        },
        "fresh authorized mirror completes",
    );
    reconcile(&held, &native, "shell-b");
    assert_eq!(native.released.load(SeqCst), 2);
    assert!(held.holds.lock().unwrap().is_empty());
    let cur = mailvault_core::maildir::mirror_cur(&mirror, "native@test", "INBOX").unwrap();
    let files = std::fs::read_dir(cur)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|s| s == "eml"))
        .collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    assert_eq!(std::fs::read(files[0].path()).unwrap(), raw);
    // Persist a pending request, then replace the real daemon. Neither the
    // native session nor the resolved root survives as reusable authority.
    drop(channel);
    *held.session.lock().unwrap() = None;
    rpc(
        "backup.run_now",
        json!({"accountId":"native","requestId":"daemon-restart"}),
    );
    until(
        || {
            rpc("backup.schedule.status", json!({}))["pendingAccess"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
        },
        "pending intent before daemon replacement",
    );
    let mut child = daemon.child.take().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    daemon.child = Some(spawn());
    until(
        || {
            mailvault_core::daemon_ipc::call(
                &endpoint,
                &token,
                "ping",
                json!({}),
                Duration::from_secs(1),
            )
            .is_ok()
        },
        "replacement daemon ready",
    );
    rpc(
        "portable.unlock",
        json!({"passphrase":"native fixture passphrase"}),
    );
    assert_eq!(
        rpc(
            "backup.access_status",
            serde_json::to_value(Query {
                attempt: old,
                fence_unstarted: true
            })
            .unwrap()
        )["safeRelease"],
        false
    );
    let channel = owner(&endpoint, &token, "shell-c");
    *held.session.lock().unwrap() = Some("shell-c".into());
    until(
        || {
            rpc("backup.schedule.status", json!({}))["pendingAccess"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
        },
        "recovered pending intent",
    );
    reconcile(&held, &native, "shell-c");
    if native.acquired.load(SeqCst) != 3 {
        println!(
            "NATIVE_RESTART_FIRST_RECONCILE: {}",
            native.last_status.lock().unwrap()
        );
    }
    // Follow-up work requires the same actual native event hook as the pump.
    // No polling of status can manufacture a missing access-needed trigger.
    until(
        || {
            let events = channel.access_events.swap(0, SeqCst);
            if events > 0 {
                reconcile(&held, &native, "shell-c");
                println!(
                    "NATIVE_RESTART_EVENT_RECONCILE: triggers={} acquired={} status={}",
                    events,
                    native.acquired.load(SeqCst),
                    native.last_status.lock().unwrap()
                );
            }
            native.acquired.load(SeqCst) == 3
        },
        "event-triggered third actual native acquisition after replacement",
    );
    assert_eq!(native.acquired.load(SeqCst), 3);
    until(
        || {
            rpc("backup.schedule.status", json!({}))["requests"]["daemon-restart"]["status"]
                == "success"
        },
        "replacement daemon requires fresh native scope",
    );
    reconcile(&held, &native, "shell-c");
    assert_eq!(native.released.load(SeqCst), 3);
    drop(channel);
    assert!(
        unavailable_bounded,
        "unchanged unavailable resolver sustained its own delivered-event feedback loop"
    );
    assert!(unchanged_intent && unavailable_no_work);
    println!("NATIVE_ACCESS_CONNECTED: real resolver, pending/manual/attach with lost accepted ACK, live owner disconnect, joined drain, same-daemon replacement shell, fresh acquisition, persisted pending daemon replacement, byte-exact mirror, responsive ping+event channel during paused resolver, independent actual same-path consumer");
}
#[test]
fn backup_access_bookmark_refresh_reacquires_against_renewed_record() {
    let dir = tempfile::tempdir().unwrap();
    mailvault_core::app_db::with(dir.path(), |c| {
        mailvault_core::app_db::locations::save_meta(
            c,
            "external-backup",
            "/same-selection",
            "macos",
            1,
            false,
        )?;
        mailvault_core::app_db::locations::save_bookmark(c, "external-backup", b"old-bookmark")
    })
    .unwrap();
    let old = wire::slot_stamp(dir.path()).unwrap().unwrap();
    let count = AtomicUsize::new(0);
    let released = AtomicUsize::new(0);
    let resolved = resolve_saved(
        || wire::slot_stamp(dir.path()),
        || {
            if count.fetch_add(1, SeqCst) == 0 {
                mailvault_core::app_db::with(dir.path(), |c| {
                    mailvault_core::app_db::locations::save_bookmark(
                        c,
                        "external-backup",
                        b"renewed-bookmark",
                    )
                })
                .unwrap();
            }
            Ok("/same-root".into())
        },
        |path| {
            assert_eq!(path, "/same-root");
            released.fetch_add(1, SeqCst);
        },
    );
    assert!(matches!(resolved.result,Resolution::Authorized{root} if root=="/same-root"));
    assert_ne!(resolved.stamp.as_deref(), Some(old.as_str()));
    assert_eq!(count.load(SeqCst), 2);
    assert_eq!(released.load(SeqCst), 1);
}
