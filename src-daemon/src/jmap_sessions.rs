//! JMAP accounts in the daemon: one connected `JmapClient` per account, the
//! account's mailbox path -> id map, the uid ledger lookups every bridged RPC
//! goes through, and the JMAP sync bookkeeping kept in custody.db (`JmapMeta`).
//!
//! A JMAP email has no uid. The ledger (`graph_ledger`, file
//! `JMAP_LEDGER_FILE` beside the mailbox's header sidecars) issues one per
//! (mailbox, email id) the first time a listing sees the pair, and keeps it
//! for good: rows are never removed, so a uid never names a second message.

use crate::handlers::common::{vault_root, with_vault_write};
use crate::imap::ImapConfig;
use crate::server::DaemonState;
use mailvault_core::custody::Connection;
use mailvault_core::jmap::mailbox_map::mailbox_tree;
use mailvault_core::jmap::{ImportResult, JMailbox, JmapClient, JmapError};
use mailvault_core::{graph_ledger, header_cache, vault_files};
use mailvault_core::imap::MailboxInfo;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// How long an email id this daemon put on the server stays out of the
/// arrival count (`JmapSessions::is_own`).
pub const OWN_IMPORT_TTL: Duration = Duration::from_secs(10 * 60);

/// Every connected JMAP account, keyed by address + session URL. One entry
/// per account: a changed password or token replaces it (`fingerprint`).
#[derive(Default)]
pub struct JmapSessions {
    map: Mutex<HashMap<String, Entry>>,
    /// Email ids this daemon put on the server itself (`import_raw`), with
    /// when, keyed by `session_key` + "\n" + id. The sync never counts them
    /// as arrivals (`sync_jmap`). Kept `OWN_IMPORT_TTL`; kept across a
    /// reconnect, which replaces the account's `AccountJmap`.
    own: Mutex<HashMap<String, Instant>>,
}

struct Entry {
    /// sha256 of the `Authorization` value the client was connected with.
    fingerprint: String,
    account: Arc<AccountJmap>,
}

fn session_key(cfg: &ImapConfig) -> String {
    format!(
        "{}\n{}",
        cfg.email.trim().to_ascii_lowercase(),
        cfg.jmap_session_url.as_deref().unwrap_or_default().trim()
    )
}

impl JmapSessions {
    /// The account's connected session: the cached one while its credentials
    /// are unchanged, else a fresh `connect`. A JMAP account with no usable
    /// credentials (`jmap_auth()` is `None`: no password or token, or an
    /// unknown `jmapAuth`) is refused with `Unauthorized` (E_JMAP_AUTH, the
    /// app's `errors.jmapAuthFailed`) before any request leaves the machine.
    pub async fn get(&self, cfg: &ImapConfig) -> Result<Arc<AccountJmap>, JmapError> {
        let auth = cfg.jmap_auth().ok_or(JmapError::Unauthorized)?;
        let key = session_key(cfg);
        let fingerprint = format!("{:x}", Sha256::digest(auth.header().as_bytes()));
        {
            let map = self.map.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(entry) = map.get(&key).filter(|e| e.fingerprint == fingerprint) {
                return Ok(Arc::clone(&entry.account));
            }
        }
        // Connect outside the lock (never hold a std guard across an await).
        // Two first calls racing both connect; the later insert wins.
        let url = cfg.jmap_session_url.as_deref().unwrap_or_default().trim().to_string();
        let client = JmapClient::connect(&url, auth, &cfg.email).await?;
        let account = Arc::new(AccountJmap::new(client));
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key, Entry { fingerprint, account: Arc::clone(&account) });
        Ok(account)
    }

    /// Drop the account's session: the next `get` connects again.
    pub fn forget(&self, cfg: &ImapConfig) {
        self.map.lock().unwrap_or_else(|p| p.into_inner()).remove(&session_key(cfg));
    }

    /// Record `email_id` as one this daemon put on the server (an import, a
    /// restore, a sent copy): the sync does not announce it as an arrival.
    pub fn note_own(&self, cfg: &ImapConfig, email_id: &str) {
        let mut own = self.own.lock().unwrap_or_else(|p| p.into_inner());
        own.retain(|_, at| at.elapsed() < OWN_IMPORT_TTL);
        own.insert(format!("{}\n{}", session_key(cfg), email_id), Instant::now());
    }

    /// Did this daemon put `email_id` on the server in the last `OWN_IMPORT_TTL`?
    pub fn is_own(&self, cfg: &ImapConfig, email_id: &str) -> bool {
        self.own
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&format!("{}\n{}", session_key(cfg), email_id))
            .is_some_and(|at| at.elapsed() < OWN_IMPORT_TTL)
    }

    /// Upload `raw` and `Email/import` it into `mailbox_id` with `keywords`,
    /// recording the new id as this daemon's own (`note_own`). A server-side
    /// dedupe (`AlreadyExists`) names an email that was already there and
    /// records nothing.
    #[cfg_attr(not(test), allow(dead_code))] // Task 9b's restore and upload call it.
    pub async fn import_raw(
        &self,
        cfg: &ImapConfig,
        raw: &[u8],
        mailbox_id: &str,
        keywords: &[String],
    ) -> Result<ImportResult, JmapError> {
        let acct = self.get(cfg).await?;
        let blob_id = acct.client.upload(raw).await?;
        let result = acct.client.import(&blob_id, &[mailbox_id.to_string()], keywords, None).await?;
        if let ImportResult::Created(imported) = &result {
            self.note_own(cfg, &imported.id);
        }
        Ok(result)
    }
}

/// One connected JMAP account.
pub struct AccountJmap {
    pub client: JmapClient,
    /// Mailbox path (as `mailbox_tree` names it) -> JMAP mailbox id.
    pub mailbox_ids: RwLock<BTreeMap<String /*path*/, String /*id*/>>,
    /// The Mailbox state of the last `refresh`.
    pub mailbox_state: Mutex<String>,
    /// The last `refresh`'s Mailbox state and answer, in one lock: `current`
    /// hands the answer back while `Mailbox/changes` says the state stands.
    listed: Mutex<Option<(String, Mailboxes)>>,
}

/// `refresh`'s answer: the app's folder list, the JMAP mailboxes with their
/// counts, and path -> id.
#[derive(Clone)]
pub struct Mailboxes {
    pub infos: Vec<MailboxInfo>,
    pub list: Vec<JMailbox>,
    pub ids: BTreeMap<String, String>,
}

/// The JMAP ledger file of `mailbox`.
pub fn jmap_ledger_path(root: &Path, account_id: &str, mailbox: &str) -> PathBuf {
    graph_ledger::ledger_path(&header_cache::sidecar_dir(root, account_id, mailbox), true)
}

/// Is `email` (an `Email/get` object carrying `mailboxIds`) in `mailbox_id`?
pub fn in_mailbox(email: &Value, mailbox_id: &str) -> bool {
    email["mailboxIds"][mailbox_id].as_bool() == Some(true)
}

impl AccountJmap {
    pub fn new(client: JmapClient) -> AccountJmap {
        AccountJmap {
            client,
            mailbox_ids: RwLock::new(BTreeMap::new()),
            mailbox_state: Mutex::new(String::new()),
            listed: Mutex::new(None),
        }
    }

    /// Every mailbox, fetched now; the path -> id map, the Mailbox state and
    /// the answer `current` reuses are replaced with what the server answered.
    pub async fn refresh(&self) -> Result<Mailboxes, JmapError> {
        let (list, state) = self.client.mailboxes().await?;
        let (infos, ids) = mailbox_tree(&list);
        *self.mailbox_ids.write().unwrap_or_else(|p| p.into_inner()) = ids.clone();
        *self.mailbox_state.lock().unwrap_or_else(|p| p.into_inner()) = state.clone();
        let boxes = Mailboxes { infos, list, ids };
        *self.listed.lock().unwrap_or_else(|p| p.into_inner()) = Some((state, boxes.clone()));
        Ok(boxes)
    }

    /// The mailboxes with their counts, without a full `Mailbox/get` while
    /// nothing changed: one `Mailbox/changes` from the last `refresh`'s state
    /// (`maxChanges` 1: only "anything?" is asked). A state that moved (a
    /// count is a change too), one the server cannot bridge, or no `refresh`
    /// yet: `refresh`.
    pub async fn current(&self) -> Result<Mailboxes, JmapError> {
        let last = self.listed.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let Some((since, boxes)) = last.filter(|(state, _)| !state.is_empty()) else {
            return self.refresh().await;
        };
        let args = json!({"accountId": self.client.account_id(), "sinceState": since, "maxChanges": 1});
        let answer = match self.client.call(vec![json!(["Mailbox/changes", args, "c"])]).await {
            Ok(answer) => answer,
            Err(JmapError::CannotCalculateChanges) => return self.refresh().await,
            Err(e) => return Err(e),
        };
        let unchanged = answer
            .iter()
            .find(|r| r[0] == "Mailbox/changes")
            .is_some_and(|r| r[1]["newState"].as_str() == Some(since.as_str()));
        if unchanged {
            Ok(boxes)
        } else {
            self.refresh().await
        }
    }

    fn cached_id(&self, path: &str) -> Option<String> {
        self.mailbox_ids.read().unwrap_or_else(|p| p.into_inner()).get(path).cloned()
    }

    /// The JMAP id of the mailbox at `path`. A miss refreshes the map once
    /// (a folder made since the last listing); still missing is an error.
    pub async fn mailbox_id(&self, path: &str) -> Result<String, JmapError> {
        if let Some(id) = self.cached_id(path) {
            return Ok(id);
        }
        self.refresh().await?;
        self.cached_id(path).ok_or_else(|| JmapError::Protocol(format!("no mailbox {path}")))
    }

    /// Each uid's JMAP email id from the mailbox's ledger, `None` for a uid
    /// the ledger never issued. With `recheck` (ids about to be acted on),
    /// one `Email/get ["mailboxIds"]` follows: an id that is gone, or no
    /// longer in this mailbox, comes back as `None`, which the RPC answers
    /// with "E_UID_GONE:" (api.js `UID_GONE_PREFIX`). The ledger row stays.
    pub async fn uid_to_id(
        &self,
        state: &Arc<DaemonState>,
        account_id: &str,
        mailbox: &str,
        uids: &[u32],
        recheck: bool,
    ) -> Result<Vec<(u32, Option<String>)>, String> {
        let path = jmap_ledger_path(&vault_root(state)?, account_id, mailbox);
        let ledger = tokio::task::spawn_blocking(move || graph_ledger::load(&path))
            .await
            .map_err(|e| format!("Task join error: {e}"))??;
        let mut out: Vec<(u32, Option<String>)> = uids.iter().map(|uid| (*uid, ledger.get(uid).cloned())).collect();
        if recheck {
            let ids: Vec<String> = out.iter().filter_map(|(_, id)| id.clone()).collect();
            if !ids.is_empty() {
                let mailbox_id = self.mailbox_id(mailbox).await.map_err(|e| e.to_string())?;
                let got = self.client.get_emails(&ids, &["id", "mailboxIds"]).await.map_err(|e| e.to_string())?;
                let here: HashSet<String> = got
                    .list
                    .iter()
                    .filter(|e| in_mailbox(e, &mailbox_id))
                    .filter_map(|e| e["id"].as_str().map(str::to_string))
                    .collect();
                for (_, id) in out.iter_mut() {
                    if id.as_ref().is_some_and(|i| !here.contains(i)) {
                        *id = None;
                    }
                }
            }
        }
        Ok(out)
    }

    /// One uid per id, in order, from the mailbox's ledger: an id it has not
    /// seen gets the next uid, on disk before this returns.
    ///
    /// `graph_ledger::allocate` runs directly on a blocking thread, under the
    /// vault gate (`with_vault_write`, as `graph_allocate_uids` does) and
    /// never under `with_ledger_lock`: that takes the same non-reentrant
    /// `STATE` mutex `allocate` takes and would deadlock.
    ///
    /// Message-ID adoption is off for JMAP: every listed pair passes `None`.
    /// Server ids are stable, and adoption could issue a uid below the
    /// uidNext the app last saw.
    pub async fn ids_to_uids(
        &self,
        state: &Arc<DaemonState>,
        account_id: &str,
        mailbox: &str,
        ids: &[String],
    ) -> Result<Vec<u32>, String> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let listed: Vec<(String, Option<String>)> = ids.iter().map(|id| (id.clone(), None)).collect();
        let (state, account_id, mailbox) = (Arc::clone(state), account_id.to_string(), mailbox.to_string());
        tokio::task::spawn_blocking(move || {
            with_vault_write(&state, |root| {
                let ledger = jmap_ledger_path(root, &account_id, &mailbox);
                let cur = vault_files::cur_path(root, &account_id, &mailbox);
                graph_ledger::allocate(&ledger, &cur, &listed)
            })
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))?
    }
}

/// How many `[modseq, uid]` entries a mailbox's flag log keeps.
pub const FLAGLOG_CAP: usize = 2000;

/// JMAP sync bookkeeping, one home: custody.db `meta` rows
/// (`custody::db::meta_get` / `meta_set`):
/// - `jmap:<acct>:<jmapAccount>:email_state`: the account's Email state string.
/// - `jmap:<acct>:<mailbox>:modseq`: per-mailbox monotonic counter, bumped
///   whenever a delta touches the mailbox (the RPC's `highestModseq`).
/// - `jmap:<acct>:<mailbox>:flaglog`: JSON `[[modseq, uid], ...]`, oldest
///   first, the newest `FLAGLOG_CAP` entries.
///
/// The log needs no separate floor. Bumps start at modseq 1, so a log that
/// was never cut starts at its first bump and covers every change after
/// `first - 1`. A cut log holds exactly `FLAGLOG_CAP` entries from then on,
/// and its oldest modseq may have lost some uids, so it covers only changes
/// after that oldest modseq.
///
/// Every function takes the custody connection: run them inside
/// `custody::with_conn` on a blocking thread.
pub struct JmapMeta;

fn meta_key(account_id: &str, scope: &str, field: &str) -> String {
    format!("jmap:{account_id}:{scope}:{field}")
}

fn read_log(conn: &Connection, account_id: &str, mailbox: &str) -> Option<Vec<(u64, u32)>> {
    match mailvault_core::custody::db::meta_get(conn, &meta_key(account_id, mailbox, "flaglog")) {
        None => Some(Vec::new()),
        Some(raw) => serde_json::from_str(&raw).ok(),
    }
}

impl JmapMeta {
    /// The account's last synced Email state, keyed by the JMAP accountId.
    pub fn email_state(conn: &Connection, account_id: &str, jmap_account: &str) -> Option<String> {
        mailvault_core::custody::db::meta_get(conn, &meta_key(account_id, jmap_account, "email_state"))
    }

    pub fn set_email_state(conn: &Connection, account_id: &str, jmap_account: &str, state: &str) -> Result<(), String> {
        mailvault_core::custody::db::meta_set(conn, &meta_key(account_id, jmap_account, "email_state"), state)
    }

    /// The mailbox's counter: 0 until the first bump.
    pub fn modseq(conn: &Connection, account_id: &str, mailbox: &str) -> u64 {
        mailvault_core::custody::db::meta_get(conn, &meta_key(account_id, mailbox, "modseq"))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0)
    }

    /// Advance the counter by one and log `uids` under the new value, in
    /// one transaction. No uids: nothing changed, the counter stays.
    pub fn bump(conn: &Connection, account_id: &str, mailbox: &str, uids: &[u32]) -> Result<u64, String> {
        let current = Self::modseq(conn, account_id, mailbox);
        if uids.is_empty() {
            return Ok(current);
        }
        let next = current + 1;
        // An unreadable log restarts here; its first entry (`next`) then
        // tells `changed_since` that nothing before `next - 1` is covered.
        let mut log = read_log(conn, account_id, mailbox).unwrap_or_default();
        log.extend(uids.iter().map(|uid| (next, *uid)));
        if log.len() > FLAGLOG_CAP {
            log.drain(..log.len() - FLAGLOG_CAP);
        }
        let log_json = serde_json::to_string(&log).map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        mailvault_core::custody::db::meta_set(&tx, &meta_key(account_id, mailbox, "flaglog"), &log_json)?;
        mailvault_core::custody::db::meta_set(&tx, &meta_key(account_id, mailbox, "modseq"), &next.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(next)
    }

    /// The uids changed after `since`, ascending, each once. `None`: the log
    /// cannot tell (older than the log, or a counter from somewhere else),
    /// and the caller answers every uid's flags instead.
    pub fn changed_since(conn: &Connection, account_id: &str, mailbox: &str, since: u64) -> Option<Vec<u32>> {
        let current = Self::modseq(conn, account_id, mailbox);
        if since == current {
            return Some(Vec::new());
        }
        if since > current {
            return None;
        }
        let log = read_log(conn, account_id, mailbox)?;
        let oldest = log.first()?.0;
        let floor = if log.len() >= FLAGLOG_CAP { oldest } else { oldest.saturating_sub(1) };
        if since < floor {
            return None;
        }
        let mut uids: Vec<u32> = log.iter().filter(|(m, _)| *m > since).map(|(_, uid)| *uid).collect();
        uids.sort_unstable();
        uids.dedup();
        Some(uids)
    }
}
