// Included inside oauth_tokens::tests to reuse the accepted synthetic fixture.
struct PersistenceRig {
    fresh: FreshRig,
    worker: Option<TestPersistenceWorker>,
    backend: Option<credentials::TestKeychainGuard>,
    sealed: Option<credentials::TestSealedGuard>,
}

impl std::ops::Deref for PersistenceRig {
    type Target = FreshRig;
    fn deref(&self) -> &FreshRig {
        &self.fresh
    }
}
impl std::ops::DerefMut for PersistenceRig {
    fn deref_mut(&mut self) -> &mut FreshRig {
        &mut self.fresh
    }
}
impl PersistenceRig {
    fn new() -> Self {
        let mut original = fresh_grant("synthetic-r0", "synthetic-expired");
        original["oauth2ExpiresAt"] = json!(1);
        Self {
            fresh: FreshRig::new(original),
            worker: None,
            backend: None,
            sealed: None,
        }
    }
    fn start(&mut self) {
        self.worker = Some(TestPersistenceWorker::start(&self.state));
    }
    fn synthetic(&mut self) -> Arc<credentials::TestKeychainBackend> {
        let guard =
            credentials::TestKeychainGuard::install(self.state.app_dir.join("credentials.json"));
        let backend = Arc::clone(&guard.0);
        self.backend = Some(guard);
        backend
    }
    fn record(&self) -> Value {
        let blob: HashMap<String, String> = serde_json::from_slice(
            &std::fs::read(self.state.app_dir.join("credentials.json")).unwrap(),
        )
        .unwrap();
        serde_json::from_str(&blob["g"]).unwrap()
    }
    fn advance(&self, by: Duration) {
        self.worker.as_ref().unwrap().advance(by);
    }
    async fn turn(&self, after: usize) -> usize {
        self.worker.as_ref().unwrap().turn_after(after).await
    }
    async fn waiting(&self, after: usize) -> usize {
        self.worker.as_ref().unwrap().wait_after(after).await
    }
    async fn stop(&mut self) {
        if let Some(worker) = self.worker.take() {
            worker.stop().await;
        }
    }
}
impl Drop for PersistenceRig {
    fn drop(&mut self) {
        // Release every synthetic backend/provider/publication gate before
        // joining the worker and all credential-triggered quiet rechecks.
        self.fresh.state.tokens.stop_persistence();
        self.fresh.release_all();
        self.fresh.write.take();
        self.worker.take();
        self.fresh.state.tokens.drain_rechecks();
        self.sealed.take();
        self.backend.take();
    }
}
fn backend_reads(backend: &credentials::TestKeychainBackend) -> usize {
    backend
        .modes
        .lock()
        .unwrap()
        .iter()
        .filter(|(leg, _)| *leg == "read")
        .count()
}
fn backend_writes(backend: &credentials::TestKeychainBackend) -> usize {
    backend
        .modes
        .lock()
        .unwrap()
        .iter()
        .filter(|(leg, _)| *leg == "write")
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_retries_with_capped_deadlines_and_coalesced_wake_floor() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let backend = rig.synthetic();
    backend
        .denied
        .store(true, std::sync::atomic::Ordering::SeqCst);
    rig.start();
    assert!(start_persistence(Arc::clone(&rig.state)).is_none());
    let mut turns = rig.turn(0).await;
    let mut waits = rig.waiting(0).await;
    assert_eq!(backend_reads(&backend), 1);
    for delay in [5, 10, 20, 40, 80, 160, 300, 300] {
        let before = backend_reads(&backend);
        rig.advance(Duration::from_secs(delay - 1));
        waits = rig.waiting(waits).await;
        assert_eq!(
            backend_reads(&backend),
            before,
            "no backend retry before its monotonic deadline"
        );
        rig.advance(Duration::from_secs(1));
        turns = rig.turn(turns).await;
        waits = rig.waiting(waits).await;
        assert_eq!(backend_reads(&backend), before + 1);
    }
    let before = backend_reads(&backend);
    for _ in 0..100 {
        rig.state.tokens.wake_persistence();
    }
    waits = rig.waiting(waits).await;
    rig.advance(Duration::from_millis(500));
    waits = rig.waiting(waits).await;
    assert_eq!(
        backend_reads(&backend),
        before,
        "recovery wakes cannot bypass the one-second failure floor"
    );
    rig.advance(Duration::from_millis(600));
    turns = rig.turn(turns).await;
    waits = rig.waiting(waits).await;
    assert_eq!(
        backend_reads(&backend),
        before + 1,
        "a burst coalesces into one attempt"
    );
    backend
        .denied
        .store(false, std::sync::atomic::Ordering::SeqCst);
    rig.state.tokens.wake_persistence();
    rig.advance(Duration::from_secs(1));
    rig.turn(turns).await;
    rig.state.tokens.drain_rechecks();
    waits = rig.waiting(waits).await;
    let idle_reads = backend_reads(&backend);
    rig.advance(Duration::from_secs(3600));
    rig.waiting(waits).await;
    assert_eq!(
        backend_reads(&backend),
        idle_reads,
        "an acknowledged empty eligible set never polls storage"
    );
    rig.stop().await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
    assert_eq!(backend_writes(&backend), 1);
    assert!(backend
        .modes
        .lock()
        .unwrap()
        .iter()
        .all(|(_, interaction)| !interaction));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_private_completion_waits_for_existing_retirement_and_adoption() {
    for cancelled in [false, true] {
        let mut rig = PersistenceRig::new();
        let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
        let reached = rig.hook(&RETIREMENT_HOOK, true);
        let original = rig.access();
        recv(&reached);
        let backend = rig.synthetic();
        rig.start();
        let waits = rig.waiting(0).await;
        assert_eq!(
            backend_reads(&backend),
            0,
            "private PendingRefresh is not saveable work"
        );
        assert!(rig.state.tokens.unsaved().is_empty());
        assert!(rig.state.tokens.entries()["g"].pending.is_some());
        if cancelled {
            rig.tasks.last().unwrap().0.abort();
        }
        rig.release_all();
        if cancelled {
            assert!(recv(&rig.access()).ok().flatten().as_deref() == Some("synthetic-a1"));
        } else {
            assert!(recv(&original).ok().flatten().as_deref() == Some("synthetic-a1"));
        }
        rig.turn(0).await;
        rig.state.tokens.drain_rechecks();
        rig.waiting(waits).await;
        rig.stop().await;
        assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
        assert_eq!(backend_writes(&backend), 1);
        assert_eq!(
            test_token_posts().len(),
            1,
            "adoption recovery never replays the provider request"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_ambiguous_private_completion_stays_idle_until_original_proof() {
    let mut rig = PersistenceRig::new();
    let original_record = rig.record();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    let reached = rig.hook(&RETIREMENT_HOOK, true);
    let pending = rig.access();
    recv(&reached);
    let mut changed = original_record.clone();
    changed["displayName"] = json!("same grant, different source record");
    assert!(recv(&rig.request(
        "credentials.save",
        json!({"records":{"g":changed.to_string()}})
    ))
    .error
    .is_none());
    let backend = rig.synthetic();
    rig.start();
    let waits = rig.waiting(0).await;
    rig.release_all();
    assert!(stale(&recv(&pending)));
    rig.state.tokens.drain_rechecks();
    let before = backend_reads(&backend);
    rig.advance(Duration::from_secs(3600));
    rig.waiting(waits).await;
    assert_eq!(
        backend_reads(&backend),
        before,
        "private ambiguous state does not become a persistence polling queue"
    );
    assert_eq!(backend_writes(&backend), 0);
    assert!(rig.state.tokens.entries()["g"].pending.is_some());
    store(&rig.state, &[("g", &original_record)]);
    assert!(recv(&rig.access()).is_ok());
    rig.turn(0).await;
    rig.stop().await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
    assert_eq!(test_token_posts().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_r1_write_and_ack_preserve_private_r2_then_adoption_wakes_save() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![
        granted("synthetic-a1", Some("synthetic-r1")),
        granted("synthetic-a2", Some("synthetic-r2")),
    ]);
    assert!(recv(&rig.access()).is_ok());
    assert!(recv(&rig.request(
        "accounts.save",
        json!({"patch":{"id":"g","fields":{"sentFolderOverride":"Sent before R1","updatedAt":"2026-10-26T00:00:00.000Z"}}})
    ))
    .error
    .is_none());
    assert_eq!(
        rig.state.tokens.unsaved().len(),
        1,
        "metadata persistence cannot acknowledge the validated unsaved R1"
    );
    rig.write = Some(credentials::TestWritePause::arm_with_timeout(5_000));
    let ack = rig.hook(&PERSISTENCE_ACK_HOOK, false);
    rig.start();
    rig.write.as_ref().unwrap().wait_until_entered();
    rig.state
        .tokens
        .advance_clock_for_tests(Duration::from_secs(3600));
    let retained = rig.hook(&RETIREMENT_HOOK, true);
    let second = rig.access();
    recv(&retained);
    assert!(rig.state.tokens.entries()["g"].pending.is_some());
    rig.write.as_mut().unwrap().finish();
    recv(&ack);
    rig.turn(0).await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
    assert!(rig.state.tokens.entries()["g"]
        .pending
        .as_ref()
        .is_some_and(|p| p.entry.grant.refresh_token == "synthetic-r2"));
    assert!(
        rig.state.tokens.unsaved().is_empty(),
        "the private completion stays private during predecessor acknowledgement"
    );
    assert!(recv(&rig.request(
        "accounts.save",
        json!({"patch":{"id":"g","fields":{"sentFolderOverride":"Sent during private R2","updatedAt":"2026-10-26T00:01:00.000Z"}}})
    ))
    .error
    .is_none());
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
    assert!(rig.state.tokens.entries()["g"]
        .pending
        .as_ref()
        .is_some_and(|p| p.entry.grant.refresh_token == "synthetic-r2"));
    rig.release_all();
    assert!(recv(&second).ok().flatten().as_deref() == Some("synthetic-a2"));
    rig.advance(Duration::from_secs(1));
    rig.turn(1).await;
    rig.stop().await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r2"));
    assert_eq!(
        rig.record()["sentFolderOverride"],
        json!("Sent during private R2")
    );
    assert_eq!(rig.record()["updatedAt"], json!("2026-10-26T00:01:00.000Z"));
    let metadata: Value =
        serde_json::from_slice(&std::fs::read(rig.state.app_dir.join("accounts.json")).unwrap())
            .unwrap();
    assert_eq!(
        metadata[0]["sentFolderOverride"],
        json!("Sent during private R2")
    );
    assert_eq!(metadata[0]["updatedAt"], json!("2026-10-26T00:01:00.000Z"));
    let posts = test_token_posts();
    assert_eq!(posts.len(), 2);
    assert_eq!(
        field(&posts[0], "refresh_token").as_deref(),
        Some("synthetic-r0")
    );
    assert_eq!(
        field(&posts[1], "refresh_token").as_deref(),
        Some("synthetic-r1")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_old_ack_cannot_clear_a_newer_validated_pair() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![
        granted("synthetic-a1", Some("synthetic-r1")),
        granted("synthetic-a2", Some("synthetic-r2")),
    ]);
    assert!(recv(&rig.access()).is_ok());
    let ack = rig.hook(&PERSISTENCE_ACK_HOOK, true);
    rig.start();
    recv(&ack);
    rig.state
        .tokens
        .advance_clock_for_tests(Duration::from_secs(3600));
    assert!(recv(&rig.access()).ok().flatten().as_deref() == Some("synthetic-a2"));
    rig.release_all();
    rig.turn(0).await;
    assert_eq!(
        rig.state.tokens.unsaved()[0]["refreshToken"],
        json!("synthetic-r2")
    );
    rig.advance(Duration::from_secs(1));
    rig.turn(1).await;
    rig.stop().await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r2"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_persistence_ack_defers_private_r2_after_cancelled_retirement_releases_flight() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![
        granted("synthetic-a1", Some("synthetic-r1")),
        granted("synthetic-a2", Some("synthetic-r2")),
    ]);
    assert!(recv(&rig.access()).is_ok());
    // Keep the existing recheck from independently recovering R2 until the
    // worker has actually acquired the now-free flight and deferred its ACK.
    let recheck = rig.hook(&RECORD_READ_HOOK, true);
    let ack = rig.hook(&PERSISTENCE_ACK_HOOK, true);
    rig.start();
    recv(&recheck);
    recv(&ack);
    rig.state
        .tokens
        .advance_clock_for_tests(Duration::from_secs(3600));
    let retained = rig.hook(&RETIREMENT_HOOK, true);
    let _second = rig.access();
    recv(&retained);
    let (task, done) = rig.tasks.pop().unwrap();
    task.abort();
    drop(rig.releases.pop()); // Release only R2's retirement gate.
    let _ = task.await;
    recv(&done);
    let flight = rig.state.tokens.flight("g");
    assert!(
        flight.try_lock().is_ok(),
        "cancelled provider waiter released its flight"
    );
    drop(rig.releases.pop()); // Release the worker ACK, leaving recheck parked.
    rig.turn(0).await;
    assert!(rig.state.tokens.entries()["g"]
        .pending
        .as_ref()
        .is_some_and(|p| p.entry.grant.refresh_token == "synthetic-r2"));
    assert!(rig.state.tokens.unsaved().is_empty());
    rig.release_all();
    rig.state.tokens.drain_rechecks();
    rig.advance(Duration::from_secs(1));
    rig.turn(1).await;
    rig.stop().await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r2"));
    assert_eq!(test_token_posts().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_absent_snapshot_cannot_retire_readded_generation() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    assert!(
        recv(&rig.request("credentials.delete", json!({"ids":["g"]})))
            .error
            .is_none()
    );
    rig.state.tokens.drain_rechecks();
    let ack = rig.hook(&PERSISTENCE_ACK_HOOK, true);
    rig.start();
    recv(&ack);
    let readded = fresh_grant("synthetic-readded-rt", "synthetic-readded-at");
    assert!(recv(&rig.request(
        "credentials.save",
        json!({"records":{"g":readded.to_string()}})
    ))
    .error
    .is_none());
    assert!(recv(&rig.access()).ok().flatten().as_deref() == Some("synthetic-readded-at"));
    rig.release_all();
    rig.turn(0).await;
    rig.stop().await;
    assert!(
        rig.state
            .tokens
            .entries()
            .get("g")
            .is_some_and(|e| e.access_token == "synthetic-readded-at"),
        "stale typed absence cannot erase the readded entry"
    );
    assert_eq!(rig.record(), readded);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_ack_cannot_remove_originating_entry_during_provider_flight() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![
        granted("synthetic-a1", Some("synthetic-r1")),
        granted("synthetic-a2", Some("synthetic-r2")),
    ]);
    assert!(recv(&rig.access()).is_ok());
    rig.state
        .tokens
        .advance_clock_for_tests(Duration::from_secs(3600));
    let result = rig.hook(&REFRESH_RESULT_HOOK, true);
    let second = rig.access();
    recv(&result);
    assert!(
        recv(&rig.request("credentials.delete", json!({"ids":["g"]})))
            .error
            .is_none()
    );
    rig.start();
    rig.turn(0).await;
    assert!(
        rig.state.tokens.entries().contains_key("g"),
        "provider flight still owns its originating entry before retention"
    );
    rig.release_all();
    assert!(stale(&recv(&second)));
    rig.stop().await;
    assert!(rig.state.tokens.entries()["g"]
        .pending
        .as_ref()
        .is_some_and(|p| p.entry.grant.refresh_token == "synthetic-r2"));
    let blob: HashMap<String, String> =
        serde_json::from_slice(&std::fs::read(rig.state.app_dir.join("credentials.json")).unwrap())
            .unwrap();
    assert!(!blob.contains_key("g"));
    assert_eq!(test_token_posts().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_fresh_context_guard_refuses_reconnect_and_provider_changes() {
    for (field_name, value) in [
        ("email", json!("different@gmail.test")),
        ("oauth2Provider", json!("microsoft")),
        ("oauth2ClientId", json!("different-client")),
        ("oauth2CustomClientId", json!("different-custom")),
        ("oauth2TenantId", json!("different-tenant")),
        ("oauth2Transport", json!("graph")),
    ] {
        let mut rig = PersistenceRig::new();
        let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
        assert!(recv(&rig.access()).is_ok());
        let pair = rig.state.tokens.persistable("g").unwrap();
        let mut changed = rig.record();
        changed[field_name] = value;
        changed["oauth2ExpiresAt"] = json!(2);
        assert!(recv(&rig.request(
            "credentials.save",
            json!({"records":{"g":changed.to_string()}})
        ))
        .error
        .is_none());
        rig.state.tokens.drain_rechecks();
        let mut events = rig.state.events.subscribe();
        let result = credentials::change_credentials_quiet(
            &rig.state,
            credentials::CredChange::Refreshed(pair),
        )
        .await;
        assert!(
            matches!(result, Err(credentials::CredError::StaleGrant)),
            "native full grant context must be checked inside the fresh mutation"
        );
        assert_eq!(rig.record(), changed);
        assert!(events.try_recv().is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_queued_snapshot_cannot_overwrite_a_reconnect() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let captured = rig.hook(&PERSISTENCE_MUTATION_HOOK, true);
    rig.start();
    recv(&captured);
    let reconnect = fresh_grant("synthetic-new-signin-rt", "synthetic-new-signin-at");
    assert!(recv(&rig.request(
        "credentials.save",
        json!({"records":{"g":reconnect.to_string()}})
    ))
    .error
    .is_none());
    rig.release_all();
    rig.turn(0).await;
    rig.stop().await;
    assert_eq!(rig.record(), reconnect);
    assert!(rig.state.tokens.unsaved().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_queued_pair_cannot_overwrite_intent_reconnect_save() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let captured = rig.hook(&PERSISTENCE_MUTATION_HOOK, true);
    rig.start();
    recv(&captured);
    let reconnect = fresh_grant("synthetic-new-signin-rt", "synthetic-new-signin-at");
    assert!(recv(&rig.request("accounts.save",json!({"patch":{"id":"g","fields":{"oauth2AccessToken":reconnect["oauth2AccessToken"],"oauth2RefreshToken":reconnect["oauth2RefreshToken"],"oauth2ExpiresAt":reconnect["oauth2ExpiresAt"]}}}))).error.is_none());
    rig.release_all();
    rig.turn(0).await;
    rig.stop().await;
    assert_eq!(
        rig.record()["oauth2RefreshToken"],
        json!("synthetic-new-signin-rt")
    );
    assert!(rig.state.tokens.unsaved().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_scoped_busy_keeps_pair_and_existing_backoff_resumes() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let backend = rig.synthetic();
    let mut scope = crate::account_workflows::AccountWriteScope::default();
    scope.record("g", &rig.record());
    let lease = rig.state.account_admission.try_reserve(scope).unwrap();
    rig.start();
    let turns = rig.turn(0).await;
    let waits = rig.waiting(0).await;
    assert_eq!(backend_reads(&backend), 0);
    assert_eq!(rig.state.tokens.unsaved().len(), 1);
    drop(lease);
    rig.advance(Duration::from_secs(5));
    rig.turn(turns).await;
    rig.waiting(waits).await;
    rig.stop().await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
    assert!(rig.state.tokens.unsaved().is_empty());
    assert_eq!(backend_writes(&backend), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_queued_pair_cannot_downgrade_newer_stored_expiry() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let expires = rig.state.tokens.unsaved()[0]["expiresAt"].as_i64().unwrap();
    let captured = rig.hook(&PERSISTENCE_MUTATION_HOOK, true);
    rig.start();
    recv(&captured);
    let current = rig.record();
    assert!(recv(&rig.request("credentials.update", json!({"id":"g","chain":[record_fingerprint(&current, None).unwrap()],
        "fields":{"oauth2AccessToken":"synthetic-stored-newer","oauth2RefreshToken":"synthetic-r0","oauth2ExpiresAt":expires+3_600_000}}))).error.is_none());
    let newer = rig.record();
    let mut announced = rig.state.events.subscribe();
    rig.release_all();
    rig.turn(0).await;
    rig.stop().await;
    assert_eq!(rig.record(), newer);
    assert!(rig.state.tokens.unsaved().is_empty());
    assert!(
        announced.try_recv().is_err(),
        "native refusal of an older pair is not another confirmed write"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_missing_record_noop_retires_only_obsolete_ordinary_entry() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    assert!(
        recv(&rig.request("credentials.delete", json!({"ids":["g"]})))
            .error
            .is_none()
    );
    rig.state.tokens.drain_rechecks();
    let mut announced = rig.state.events.subscribe();
    rig.start();
    rig.turn(0).await;
    rig.stop().await;
    assert!(!rig.state.tokens.entries().contains_key("g"));
    let blob: HashMap<String, String> =
        serde_json::from_slice(&std::fs::read(rig.state.app_dir.join("credentials.json")).unwrap())
            .unwrap();
    assert!(
        !blob.contains_key("g"),
        "a pending native refresh never creates a removed record"
    );
    assert!(announced.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_late_write_retains_exclusion_and_does_not_block_cached_foreground() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let backend = rig.synthetic();
    let mut announced = rig.state.events.subscribe();
    rig.write = Some(credentials::TestWritePause::arm());
    rig.start();
    rig.write.as_ref().unwrap().wait_until_entered();
    assert!(recv(&rig.access()).ok().flatten().as_deref() == Some("synthetic-a1"));
    rig.turn(0).await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r0"));
    assert_eq!(rig.state.tokens.unsaved().len(), 1);
    assert!(
        announced.try_recv().is_err(),
        "a timed-out write is not a confirmed change"
    );
    let busy = recv(&rig.request("credentials.delete", json!({"ids":["g"]})));
    assert!(busy
        .error
        .is_some_and(|e| e.message == "errors.keychainBusy"));
    rig.state.tokens.stop_persistence();
    // The bounded worker unit may return, but the late finalizer still owns
    // APP_WRITE. Stop never aborts that backend or promises a flush.
    rig.write.as_mut().unwrap().finish();
    rig.stop().await;
    rig.state.tokens.drain_rechecks();
    let changed = events(&mut announced)
        .into_iter()
        .filter(|(n, _)| n == crate::handlers::credentials::CHANGED_EVENT)
        .count();
    assert_eq!(changed, 1);
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
    assert!(rig.state.tokens.unsaved().is_empty());
    assert_eq!(backend_writes(&backend), 1);
    assert!(backend.modes.lock().unwrap().iter().all(|(_, mode)| !mode));
    assert_eq!(test_token_posts().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_write_failure_retains_pair_without_changed_event_then_recovers() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let backend = rig.synthetic();
    backend
        .fail_write
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let generation = credentials::write_generation();
    let mut announced = rig.state.events.subscribe();
    rig.start();
    rig.turn(0).await;
    let waits = rig.waiting(0).await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r0"));
    assert_eq!(rig.state.tokens.unsaved().len(), 1);
    assert!(
        credentials::write_generation() > generation,
        "terminal failure conservatively invalidates trust"
    );
    assert!(announced.try_recv().is_err());
    backend
        .fail_write
        .store(false, std::sync::atomic::Ordering::SeqCst);
    rig.advance(Duration::from_secs(5));
    rig.turn(1).await;
    rig.waiting(waits).await;
    rig.stop().await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
    assert_eq!(
        events(&mut announced)
            .iter()
            .filter(|(n, _)| n == crate::handlers::credentials::CHANGED_EVENT)
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_round_robin_does_not_starve_b_behind_a_busy_ack_flight() {
    let mut rig = PersistenceRig::new();
    let original = rig.record();
    let mut b = original.clone();
    b["id"] = json!("b");
    b["email"] = json!("b@gmail.test");
    store(&rig.state, &[("g", &original), ("b", &b)]);
    let _mock = test_token_mock(vec![
        granted("synthetic-b1", Some("synthetic-br1")),
        granted("synthetic-a1", Some("synthetic-r1")),
    ]);
    assert!(access_token(&rig.state, "b", Read::Quiet).await.is_ok());
    assert!(recv(&rig.access()).is_ok());
    let flight = rig.state.tokens.flight("b");
    let held = flight.lock().await;
    rig.start();
    rig.turn(0).await;
    rig.advance(Duration::from_secs(5));
    rig.turn(1).await;
    let blob: HashMap<String, String> =
        serde_json::from_slice(&std::fs::read(rig.state.app_dir.join("credentials.json")).unwrap())
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&blob["g"]).unwrap()["oauth2RefreshToken"],
        json!("synthetic-r1")
    );
    assert!(
        !rig.state.tokens.entries()["g"].unsaved,
        "another account's occupied flight does not starve this account's save/ack"
    );
    drop(held);
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_sealed_lock_keeps_precedence_and_unlock_recovery_is_quiet() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let original = rig.record();
    let debug_before = std::fs::read(rig.state.app_dir.join("credentials.json")).unwrap();
    let backend = rig.synthetic();
    let sealed = credentials::TestSealedGuard::install(rig.state.app_dir.join("synthetic.sealed"));
    sealed.0.unlock("synthetic-passphrase").unwrap();
    sealed
        .0
        .set_credentials(HashMap::from([("g".to_string(), original.to_string())]))
        .unwrap();
    sealed.0.lock();
    rig.sealed = Some(sealed);
    rig.start();
    rig.turn(0).await;
    rig.waiting(0).await;
    assert_eq!(rig.state.tokens.unsaved().len(), 1);
    assert_eq!(
        backend_reads(&backend),
        0,
        "locked sealed storage never falls back to the debug/OS backend"
    );
    rig.sealed
        .as_ref()
        .unwrap()
        .0
        .unlock("synthetic-passphrase")
        .unwrap();
    rig.state.tokens.wake_persistence();
    rig.advance(Duration::from_secs(1));
    rig.turn(1).await;
    rig.stop().await;
    let stored = rig.sealed.as_ref().unwrap().0.secrets().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&stored.credentials["g"]).unwrap()["oauth2RefreshToken"],
        json!("synthetic-r1")
    );
    assert_eq!(
        std::fs::read(rig.state.app_dir.join("credentials.json")).unwrap(),
        debug_before
    );
    assert_eq!(backend_writes(&backend), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_debug_failure_and_malformed_ack_never_infer_absence() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    let original = rig.record();
    let path = rig.state.app_dir.join("credentials.json");
    std::fs::write(&path, "{broken synthetic blob").unwrap();
    rig.start();
    rig.turn(0).await;
    assert_eq!(rig.state.tokens.unsaved().len(), 1);
    assert!(credentials::optional_record_quiet("g").await.is_err());
    std::fs::write(&path, json!({"g":"null"}).to_string()).unwrap();
    assert!(credentials::optional_record_quiet("g").await.is_err());
    rig.state.tokens.wake_persistence();
    rig.advance(Duration::from_secs(1));
    rig.turn(1).await;
    assert_eq!(rig.state.tokens.unsaved().len(), 1);
    std::fs::write(&path, json!({"g":"{}"}).to_string()).unwrap();
    rig.state.tokens.wake_persistence();
    rig.advance(Duration::from_secs(1));
    rig.turn(2).await;
    assert_eq!(
        rig.state.tokens.unsaved().len(),
        1,
        "an unrecognizable OAuth record is not typed absence"
    );
    store(&rig.state, &[("g", &original)]);
    rig.state.tokens.wake_persistence();
    rig.advance(Duration::from_secs(1));
    rig.turn(3).await;
    rig.stop().await;
    assert_eq!(rig.record()["oauth2RefreshToken"], json!("synthetic-r1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_persistence_panicking_fixture_releases_and_drains_parked_work() {
    let mut rig = PersistenceRig::new();
    let _mock = test_token_mock(vec![granted("synthetic-a1", Some("synthetic-r1"))]);
    assert!(recv(&rig.access()).is_ok());
    rig.write = Some(credentials::TestWritePause::arm_with_timeout(5_000));
    rig.start();
    rig.write.as_ref().unwrap().wait_until_entered();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _owned = rig;
        panic!("intentional synthetic fixture unwind");
    }));
    assert!(outcome.is_err());
    assert!(!credentials::WRITE_PARKED.load(std::sync::atomic::Ordering::SeqCst));
}
