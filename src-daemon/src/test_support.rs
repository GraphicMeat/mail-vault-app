//! Test-only entry points: a `DaemonState` wired for scratch dirs and a request
//! driver that goes through the real dispatch. Compiled only under `cfg(test)`.
use crate::ipc::{RpcRequest, RpcResponse};
use crate::netgate::NetGate;
use crate::server::handle_request;
use crate::state::{open_vault_registry, DaemonState};
use crate::{classification, contacts_index, idle_watch, imap, inference, llm, sync_engine};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[cfg(test)]
pub(crate) async fn handle_request_for_test(state: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
    // Synthetic fixtures commonly write their authoritative document after
    // constructing DaemonState. Seed once from that real fixture document.
    if !state.account_lifecycle.is_ready() {
        if let Ok(listing) =
            mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&state.app_dir))
        {
            state.account_lifecycle.seed(&listing);
        }
    }
    Box::pin(handle_request(state, RpcRequest { method: method.into(), params, id: Some(serde_json::json!(1)) })).await
}

/// The open-file cap the test process lifts its soft limit to, or the hard
/// limit if that is lower.
#[cfg(all(test, unix))]
pub(crate) const TEST_OPEN_FILES: libc::rlim_t = 10_240;

/// Every daemon test shares one process. Ten threads of states, mock servers
/// and temp files peaked near macOS's default soft limit of 256 open files,
/// and whichever test opened the one too many failed with "Too many open
/// files" (the mini, 2026-10-07). Lifted once, as `ulimit -n` would; Linux
/// starts far above it.
#[cfg(test)]
fn lift_open_file_limit() {
    #[cfg(unix)]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            // SAFETY: getrlimit/setrlimit only read and write the struct passed.
            unsafe {
                if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) == 0 && lim.rlim_cur < lim.rlim_max.min(TEST_OPEN_FILES) {
                    lim.rlim_cur = lim.rlim_max.min(TEST_OPEN_FILES);
                    libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
                }
            }
        });
    }
}

#[cfg(test)]
impl DaemonState {
    /// Explicitly prepare an authoritative account fixture before any route
    /// can bootstrap this state's lifecycle. `for_test` itself stays Unready.
    pub(crate) fn seed_accounts_for_test(&self, ids: &[&str]) {
        assert!(!self.account_lifecycle.is_ready(), "seed before the first route");
        let rows = Value::Array(ids.iter().map(|id| serde_json::json!({"id": id})).collect());
        std::fs::write(self.app_dir.join("accounts.json"), rows.to_string()).unwrap();
        self.account_lifecycle.seed(
            &mailvault_core::accounts_doc::list(&mailvault_core::accounts_doc::shared(&self.app_dir)).unwrap(),
        );
    }

    /// A state wired the way main.rs wires it, but pointed at scratch dirs.
    pub(crate) fn for_test(
        mail_dir: PathBuf,
        app_dir: PathBuf,
        mail_dir_ok: bool,
    ) -> Arc<DaemonState> {
        // A gate whose probe always answers "online": these tests are about
        // routing and state, never about connectivity.
        Self::for_test_with_probe(
            mail_dir,
            app_dir,
            mail_dir_ok,
            Arc::new(|| Box::pin(async { true })),
        )
    }

    /// `for_test` with the network gate's probe scripted by the caller, for
    /// a test about what a send does when the probe says the network is down.
    pub(crate) fn for_test_with_probe(
        mail_dir: PathBuf,
        app_dir: PathBuf,
        mail_dir_ok: bool,
        probe: crate::netgate::Probe,
    ) -> Arc<DaemonState> {
        lift_open_file_limit();
        let app_dir_for_index = app_dir.clone();
        let imap_pool = Arc::new(imap::ImapPool::new());
        let account_lifecycle = crate::account_lifecycle::AccountLifecycle::default();
        let contacts = contacts_index::ContactsState::new(mail_dir.clone(), account_lifecycle.clone());
        let net = NetGate::with_probe(probe);
        let vault_closed = Arc::new(AtomicBool::new(false));
        let vault_gate = Arc::new(std::sync::RwLock::new(()));
        let sync_engine = Arc::new(sync_engine::SyncEngine::new(
            Arc::clone(&imap_pool),
            mail_dir.clone(),
            app_dir.clone(),
            Arc::clone(&contacts),
            Arc::clone(&net),
            Arc::clone(&vault_closed),
            Arc::clone(&vault_gate),
            account_lifecycle.clone(),
        ));
        let idle = idle_watch::IdleWatchers::new(
            Arc::clone(&sync_engine),
            Arc::clone(&imap_pool),
            Arc::clone(&net),
            std::time::Duration::from_millis(50),
        );
        let auto_tag_worker = crate::auto_tag_worker::AutoTagWorkerState::default();
        idle.set_auto_tag_notify(Arc::clone(&auto_tag_worker.notify));
        let events = crate::events::EventBus::new(crate::events::CAPACITY);
        let custody = crate::custody::CustodyState::default();
        // Production opens custody at startup, before the socket is bound, and
        // the header cache lives in it — a state with it closed cannot cache a
        // sync or report one. `open_into` drops whatever is installed before
        // it opens, so a test that calls it later still gets a clean open.
        if mail_dir_ok {
            if let Ok(conn) = mailvault_core::custody::db::open(&mail_dir) {
                *mailvault_core::custody::lock(&custody.db) = Some(conn);
                *custody.root.lock().unwrap_or_else(|p| p.into_inner()) = Some(mail_dir.clone());
            }
        }
        sync_engine.attach_custody_db(Arc::clone(&custody.db));
        contacts.attach_db(Arc::clone(&custody.db));
        let search_index = crate::search_index::SearchIndexState::new(
            mail_dir.clone(),
            app_dir_for_index.clone(),
            mail_dir_ok,
            events.clone(),
        );
        search_index.attach_custody_db(Arc::clone(&custody.db));
        // A registry file of its own per state: many tests pass the vault dir
        // (or one shared dir) as `app_dir`, and one file under two roots wipes.
        let registry_dir = tempfile::tempdir().expect("registry tempdir").keep();
        let vault_registry = open_vault_registry(&registry_dir, &mail_dir, &search_index);
        // The worker process is spawned on the first call, so no reaper runs in tests.
        #[cfg(feature = "blitz-render")]
        let blitz = Arc::new(crate::blitz::RenderPool::new(|| {
            crate::blitz::RenderHost::new(
                events.clone(),
                crate::blitz::WorkerCommand::current_exe().expect("current_exe"),
            )
        }));
        let state = Arc::new(DaemonState {
            recent: Default::default(),
            net,
            idle,
            token: "a".repeat(64),
            data_dir: mail_dir.clone(),
            app_dir: app_dir.clone(),
            mail_dir_ok,
            vault_display_path: std::sync::Mutex::new(mail_dir.to_string_lossy().into_owned()),
            vault_is_custom: std::sync::Mutex::new(false),
            vault_last_error: std::sync::Mutex::new(None),
            pending_move: std::sync::Mutex::new(None),
            vault_closed,
            vault_gate,
            started_at: std::time::Instant::now(),
            llm: Arc::new(llm::LlmState::new(app_dir.clone())),
            inference: Arc::new(inference::InferenceEngine::new()),
            classification: classification::ClassificationState::new(app_dir),
            imap_pool,
            oauth2: mailvault_core::oauth2::OAuth2Manager::new(),
            sync_engine,
            sync_observation: Default::default(),
            refresh: Default::default(),
            contacts,
            shutdown: Arc::new(tokio::sync::Notify::new()),
            search_index,
            vault_registry,
            search_runs: std::sync::Mutex::new(std::collections::HashMap::new()),
            events,
            #[cfg(feature = "blitz-render")]
            blitz,
            prefetch_lock: std::sync::Mutex::new(()),
            prefetch_high_water: std::sync::Mutex::new(Vec::new()),
            journal: std::sync::Mutex::new(()),
            delete_queue: Default::default(),
            bulk: std::sync::Mutex::new(mailvault_core::bulk::Coordinator::load(
                &app_dir_for_index,
            )),
            custody,
            run_tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
            backup_runs: std::sync::Mutex::new(std::collections::HashMap::new()),
            insights: crate::insights::InsightsSnapshots::default(),
            scheduled_send: crate::scheduled_send_worker::ScheduledSendState::default(),
            tokens: crate::oauth_tokens::TokenStore::default(),
            account_admission: Default::default(),
            account_lifecycle,
            zip_intents: Default::default(),
            snooze: crate::snooze_worker::SnoozeState::default(),
            follow_up: crate::follow_up_worker::FollowUpState::default(),
            auto_tag_worker,
            eviction_worker: crate::eviction_worker::EvictionWorkerState::default(),
            hoarder_worker: crate::hoarder_worker::HoarderWorkerState::default(),
            clock: mailvault_core::transfer_limits::Clock::system(),
            raw_messages: Default::default(),
            import_rehome_running: Default::default(),
            mbox_uploads: Default::default(),
            folder_moves: Default::default(),
            format_migration: Default::default(),
            net_log: Arc::new(mailvault_core::net_log::NetLog::start(&app_dir_for_index)),
            abd: Default::default(),
            cleanup: Default::default(),
            backup_worker: Default::default(),
            jmap: Default::default(),
        });
        state.idle.set_daemon(&state);
        state.sync_engine.set_daemon(&state);
        crate::refresh_worker::start(&state);
        state
    }
}
