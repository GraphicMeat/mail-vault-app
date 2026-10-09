//! Accounts, mailboxes, emails, blobs and the per-account change log.

use crate::{Fault, Limits, Scenario, ScenarioEmail, ScenarioMailbox};
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

const DEFAULT_RECEIVED_AT: &str = "2026-01-01T00:00:00Z";

#[derive(Debug, Clone)]
pub struct State {
    /// Keyed by account id (`acc1`, `acc2`, ...).
    pub accounts: BTreeMap<String, Account>,
    /// Content-addressed: blob id = "G" + the first 20 hex chars of sha256(bytes).
    pub blobs: HashMap<String, Vec<u8>>,
    /// Raw bytes of every message `EmailSubmission/set` accepted.
    pub submitted: Vec<Vec<u8>>,
    pub faults: Vec<Fault>,
    pub limits: Limits,
    /// Session `apiUrl` override (e.g. an `http://` URL off loopback a client must refuse).
    pub api_url_override: Option<String>,
    /// When set, `downloadUrl` points at the second listener and the main listener
    /// stops serving downloads, the way Fastmail serves blobs from a user-content host.
    /// The value is a label only; the second listener is always `127.0.0.1:<download_port>`.
    pub download_host: Option<String>,
    /// Advertise `urn:ietf:params:jmap:submission` (default true). False also makes
    /// `EmailSubmission/set` an `unknownMethod`, like a token without the Submission scope.
    pub advertise_submission: bool,
    /// Put `eventSourceUrl` in the session (default true).
    pub advertise_event_source: bool,
    /// Bumped on every `mutate` and every API request that changed an account; each bump
    /// sends one StateChange on every open EventSource stream.
    pub notify_gen: u64,
}

#[derive(Debug, Clone)]
pub struct Account {
    pub id: String,
    pub username: String,
    pub password: String,
    pub token: Option<String>,
    pub mailboxes: BTreeMap<String, Mailbox>,
    pub emails: BTreeMap<String, Email>,
    pub identities: Vec<Identity>,
    /// Submission id -> email id.
    pub submissions: BTreeMap<String, String>,
    /// Last sequence number handed out. Every log entry takes the next one.
    pub seq: u64,
    pub email_state: u64,
    pub mailbox_state: u64,
    pub submission_state: u64,
    /// Oldest state `*/changes` still accepts; `prune_log` raises it.
    pub log_floor: u64,
    pub log: Vec<LogEntry>,
    pub next_id: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mailbox {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub role: Option<String>,
    pub sort_order: u32,
    pub is_subscribed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Email {
    pub id: String,
    pub blob_id: String,
    pub mailbox_ids: BTreeSet<String>,
    pub keywords: BTreeSet<String>,
    pub received_at: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Email,
    Mailbox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Created,
    Updated,
    Destroyed,
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub seq: u64,
    pub kind: Kind,
    pub id: String,
    pub op: Op,
    /// A Mailbox update that only moved totalEmails/unreadEmails.
    pub counts_only: bool,
}

/// The folded result of `Account::changes`.
#[derive(Debug, Clone, PartialEq)]
pub struct Changes {
    pub new_state: String,
    pub has_more: bool,
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub destroyed: Vec<String>,
    /// Every updated id only changed counts (drives Mailbox/changes `updatedProperties`).
    pub counts_only: bool,
}

/// A JMAP SetError (RFC 8620 §5.3).
#[derive(Debug, Clone, PartialEq)]
pub struct SetError {
    pub kind: String,
    pub description: Option<String>,
    pub properties: Vec<String>,
    /// Extra members, e.g. `existingId` for `alreadyExists`, `notFound` for `blobNotFound`.
    pub extra: Map<String, Value>,
}

impl SetError {
    pub fn new(kind: &str) -> SetError {
        SetError { kind: kind.to_string(), description: None, properties: vec![], extra: Map::new() }
    }
    pub fn props(kind: &str, properties: &[&str]) -> SetError {
        let mut e = SetError::new(kind);
        e.properties = properties.iter().map(|p| p.to_string()).collect();
        e
    }
    pub fn describe(mut self, d: impl Into<String>) -> SetError {
        self.description = Some(d.into());
        self
    }
    pub fn with(mut self, key: &str, v: Value) -> SetError {
        self.extra.insert(key.to_string(), v);
        self
    }
    pub fn to_json(&self) -> Value {
        let mut m = self.extra.clone();
        m.insert("type".into(), json!(self.kind));
        if let Some(d) = &self.description {
            m.insert("description".into(), json!(d));
        }
        if !self.properties.is_empty() {
            m.insert("properties".into(), json!(self.properties));
        }
        Value::Object(m)
    }
}

pub fn blob_id_for(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("G{}", &hex[..20])
}

/// Seconds since the epoch as UTC "YYYY-MM-DDTHH:MM:SSZ".
pub fn iso8601(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso8601(secs)
}

fn lower_set<'a>(it: impl IntoIterator<Item = &'a String>) -> BTreeSet<String> {
    it.into_iter().map(|k| k.to_ascii_lowercase()).collect()
}

impl Account {
    /// Append one log entry and move the matching type state to it.
    pub fn record(&mut self, kind: Kind, id: &str, op: Op, counts_only: bool) {
        self.seq += 1;
        match kind {
            Kind::Email => self.email_state = self.seq,
            Kind::Mailbox => self.mailbox_state = self.seq,
        }
        self.log.push(LogEntry { seq: self.seq, kind, id: id.to_string(), op, counts_only });
    }

    /// Log a counts-only Mailbox update for each existing mailbox.
    pub fn record_counts(&mut self, mailbox_ids: impl IntoIterator<Item = String>) {
        for m in mailbox_ids {
            if self.mailboxes.contains_key(&m) {
                self.record(Kind::Mailbox, &m, Op::Updated, true);
            }
        }
    }

    /// A fresh id with this prefix, unused by any email, mailbox, identity or submission.
    pub fn new_id(&mut self, prefix: &str) -> String {
        loop {
            self.next_id += 1;
            let id = format!("{prefix}{}", self.next_id);
            let taken = self.emails.contains_key(&id)
                || self.mailboxes.contains_key(&id)
                || self.submissions.contains_key(&id)
                || self.identities.iter().any(|i| i.id == id);
            if !taken {
                return id;
            }
        }
    }

    pub fn insert_email(&mut self, e: Email) {
        let (id, mbs) = (e.id.clone(), e.mailbox_ids.clone());
        self.emails.insert(id.clone(), e);
        self.record(Kind::Email, &id, Op::Created, false);
        self.record_counts(mbs);
    }

    pub fn remove_email(&mut self, id: &str) -> bool {
        match self.emails.remove(id) {
            Some(e) => {
                self.record(Kind::Email, id, Op::Destroyed, false);
                self.record_counts(e.mailbox_ids);
                true
            }
            None => false,
        }
    }

    /// Replace keywords and/or mailboxIds. An email must stay in at least one existing
    /// mailbox (RFC 8621 §4.1.1), else `invalidProperties`. A no-op logs nothing.
    pub fn update_email(
        &mut self,
        id: &str,
        keywords: Option<BTreeSet<String>>,
        mailbox_ids: Option<BTreeSet<String>>,
    ) -> Result<(), SetError> {
        let cur = self.emails.get(id).ok_or_else(|| SetError::new("notFound"))?;
        let new_k = keywords.map(|k| lower_set(&k)).unwrap_or_else(|| cur.keywords.clone());
        let new_m = mailbox_ids.unwrap_or_else(|| cur.mailbox_ids.clone());
        if new_m.is_empty() {
            return Err(SetError::props("invalidProperties", &["mailboxIds"])
                .describe("an Email must belong to at least one Mailbox"));
        }
        if let Some(bad) = new_m.iter().find(|m| !self.mailboxes.contains_key(*m)) {
            return Err(SetError::props("invalidProperties", &["mailboxIds"]).describe(format!("no mailbox {bad}")));
        }
        let (old_k, old_m) = (cur.keywords.clone(), cur.mailbox_ids.clone());
        if old_k == new_k && old_m == new_m {
            return Ok(());
        }
        let seen_changed = old_k.contains("$seen") != new_k.contains("$seen");
        let e = self.emails.get_mut(id).expect("checked above");
        e.keywords = new_k;
        e.mailbox_ids = new_m.clone();
        self.record(Kind::Email, id, Op::Updated, false);
        let mut touched: BTreeSet<String> = old_m.symmetric_difference(&new_m).cloned().collect();
        if seen_changed {
            touched.extend(new_m.iter().cloned());
        }
        self.record_counts(touched);
        Ok(())
    }

    /// Fold the log after `since` for one type. `None` = unknown, future or pruned state
    /// (the type's current state always stays valid: nothing of that type changed since).
    /// With `max`, stops before the entry that would add id number `max + 1` and reports
    /// that point as `new_state` with `has_more`.
    pub fn changes(&self, kind: Kind, since: &str, max: Option<usize>) -> Option<Changes> {
        let since_n: u64 = since.parse().ok()?;
        let current = match kind {
            Kind::Email => self.email_state,
            Kind::Mailbox => self.mailbox_state,
        };
        if since_n > self.seq || (since_n < self.log_floor && since_n != current) {
            return None;
        }
        let mut order: Vec<String> = Vec::new();
        let mut first: HashMap<String, Op> = HashMap::new();
        let mut last: HashMap<String, Op> = HashMap::new();
        let mut real_update: BTreeSet<String> = BTreeSet::new();
        let (mut has_more, mut last_taken) = (false, since_n);
        for e in self.log.iter().filter(|e| e.seq > since_n && e.kind == kind) {
            if !first.contains_key(&e.id) {
                if max.is_some_and(|m| order.len() >= m) {
                    has_more = true;
                    break;
                }
                first.insert(e.id.clone(), e.op);
                order.push(e.id.clone());
            }
            last.insert(e.id.clone(), e.op);
            if !e.counts_only {
                real_update.insert(e.id.clone());
            }
            last_taken = e.seq;
        }
        let (mut created, mut updated, mut destroyed) = (vec![], vec![], vec![]);
        for id in order {
            match (first[&id], last[&id]) {
                (Op::Created, Op::Destroyed) => {}
                (Op::Created, _) => created.push(id),
                (_, Op::Destroyed) => destroyed.push(id),
                _ => updated.push(id),
            }
        }
        let counts_only = !updated.is_empty() && updated.iter().all(|id| !real_update.contains(id));
        let new_state = if has_more { last_taken } else { current.max(since_n) };
        Some(Changes { new_state: new_state.to_string(), has_more, created, updated, destroyed, counts_only })
    }
}

impl State {
    /// Seed from a scenario. Seeds are not logged: every state starts at "1".
    pub fn from_scenario(s: &Scenario) -> State {
        let mut st = State {
            accounts: BTreeMap::new(),
            blobs: HashMap::new(),
            submitted: vec![],
            faults: s.faults.clone(),
            limits: s.limits.clone(),
            api_url_override: None,
            download_host: None,
            advertise_submission: true,
            advertise_event_source: true,
            notify_gen: 0,
        };
        for (i, sa) in s.accounts.iter().enumerate() {
            let id = format!("acc{}", i + 1);
            let mut a = Account {
                id: id.clone(),
                username: sa.username.clone(),
                password: sa.password.clone(),
                token: sa.token.clone(),
                mailboxes: BTreeMap::new(),
                emails: BTreeMap::new(),
                identities: sa
                    .identities
                    .iter()
                    .enumerate()
                    .map(|(k, (email, name))| Identity { id: format!("id{}", k + 1), email: email.clone(), name: name.clone() })
                    .collect(),
                submissions: BTreeMap::new(),
                seq: 1,
                email_state: 1,
                mailbox_state: 1,
                submission_state: 1,
                log_floor: 1,
                log: vec![],
                next_id: 0,
            };
            for (order, mb) in sa.mailboxes.iter().enumerate() {
                a.mailboxes.insert(
                    mb.id.clone(),
                    Mailbox {
                        id: mb.id.clone(),
                        name: mb.name.clone(),
                        parent_id: mb.parent_id.clone(),
                        role: mb.role.clone(),
                        sort_order: order as u32,
                        is_subscribed: true,
                    },
                );
                for se in &mb.emails {
                    let raw = se.raw.as_bytes().to_vec();
                    let size = raw.len() as u64;
                    let blob_id = st.store_blob(raw);
                    let e = a.emails.entry(se.id.clone()).or_insert_with(|| Email {
                        id: se.id.clone(),
                        blob_id,
                        mailbox_ids: BTreeSet::new(),
                        keywords: lower_set(&se.keywords),
                        received_at: if se.received_at.is_empty() { DEFAULT_RECEIVED_AT.into() } else { se.received_at.clone() },
                        size,
                    });
                    e.mailbox_ids.insert(mb.id.clone());
                    e.mailbox_ids.extend(se.also_in.iter().cloned());
                }
            }
            st.accounts.insert(id, a);
        }
        st
    }

    pub fn account(&self, id: &str) -> &Account {
        self.accounts.get(id).unwrap_or_else(|| panic!("mock-jmap: no account {id}"))
    }

    pub fn account_mut(&mut self, id: &str) -> &mut Account {
        self.accounts.get_mut(id).unwrap_or_else(|| panic!("mock-jmap: no account {id}"))
    }

    pub fn store_blob(&mut self, bytes: Vec<u8>) -> String {
        let id = blob_id_for(&bytes);
        self.blobs.insert(id.clone(), bytes);
        id
    }

    /// Raw bytes of an email, as `Email/get` `blobId` would download them.
    pub fn raw(&self, account: &str, email_id: &str) -> Option<Vec<u8>> {
        let e = self.accounts.get(account)?.emails.get(email_id)?;
        self.blobs.get(&e.blob_id).cloned()
    }

    pub fn email(&self, account: &str, email_id: &str) -> Option<&Email> {
        self.accounts.get(account)?.emails.get(email_id)
    }

    /// Ids of the emails in a mailbox, sorted.
    pub fn emails_in(&self, account: &str, mailbox_id: &str) -> Vec<String> {
        self.account(account).emails.values().filter(|e| e.mailbox_ids.contains(mailbox_id)).map(|e| e.id.clone()).collect()
    }

    /// Sum of every account's sequence number; changes whenever any account changed.
    pub fn seq_sum(&self) -> u64 {
        self.accounts.values().map(|a| a.seq).sum()
    }

    /// Use up a `RateLimited` fault, returning its Retry-After seconds.
    pub fn take_rate_limit(&mut self) -> Option<u64> {
        let i = self.faults.iter().position(|f| matches!(f, Fault::RateLimited { .. }))?;
        match self.faults.remove(i) {
            Fault::RateLimited { retry_after_secs } => Some(retry_after_secs),
            _ => None,
        }
    }

    pub fn drop_event_source_after(&self) -> Option<usize> {
        self.faults.iter().find_map(|f| match f {
            Fault::DropEventSourceAfter { events } => Some(*events),
            _ => None,
        })
    }

    pub fn server_fails(&self, method: &str) -> bool {
        self.faults.iter().any(|f| matches!(f, Fault::ServerFail { method: m } if m == method))
    }

    /// `Authorization` header -> account id. Basic matches username/password, Bearer
    /// matches the token. Always `None` under `Fault::Unauthorized`.
    pub fn authenticate(&self, header: Option<&str>) -> Option<String> {
        if self.faults.contains(&Fault::Unauthorized) {
            return None;
        }
        let (scheme, rest) = header?.trim().split_once(' ')?;
        let rest = rest.trim();
        if scheme.eq_ignore_ascii_case("basic") {
            let decoded = base64::engine::general_purpose::STANDARD.decode(rest).ok()?;
            let text = String::from_utf8(decoded).ok()?;
            let (user, pass) = text.split_once(':')?;
            self.accounts.values().find(|a| a.username == user && a.password == pass).map(|a| a.id.clone())
        } else if scheme.eq_ignore_ascii_case("bearer") {
            self.accounts.values().find(|a| a.token.as_deref() == Some(rest)).map(|a| a.id.clone())
        } else {
            None
        }
    }

    // ── test helpers: each logs its change; unknown ids panic ──────────────────

    /// Replace an email's keywords.
    pub fn set_keywords(&mut self, account: &str, email_id: &str, keywords: &[&str]) {
        let k = keywords.iter().map(|s| s.to_string()).collect();
        self.account_mut(account).update_email(email_id, Some(k), None).expect("set_keywords");
    }

    /// Replace an email's mailboxes (labels).
    pub fn set_mailboxes(&mut self, account: &str, email_id: &str, mailbox_ids: &[&str]) {
        let m = mailbox_ids.iter().map(|s| s.to_string()).collect();
        self.account_mut(account).update_email(email_id, None, Some(m)).expect("set_mailboxes");
    }

    pub fn add_to_mailbox(&mut self, account: &str, email_id: &str, mailbox_id: &str) {
        let mut m = self.email(account, email_id).expect("add_to_mailbox: no email").mailbox_ids.clone();
        m.insert(mailbox_id.to_string());
        self.account_mut(account).update_email(email_id, None, Some(m)).expect("add_to_mailbox");
    }

    pub fn remove_from_mailbox(&mut self, account: &str, email_id: &str, mailbox_id: &str) {
        let mut m = self.email(account, email_id).expect("remove_from_mailbox: no email").mailbox_ids.clone();
        m.remove(mailbox_id);
        self.account_mut(account).update_email(email_id, None, Some(m)).expect("remove_from_mailbox");
    }

    /// Add an email with a fixed id into `mailbox_id` (plus `also_in`), as a new arrival.
    pub fn add_email(&mut self, account: &str, mailbox_id: &str, e: ScenarioEmail) {
        assert!(self.email(account, &e.id).is_none(), "add_email: {} exists", e.id);
        let raw = e.raw.as_bytes().to_vec();
        let size = raw.len() as u64;
        let blob_id = self.store_blob(raw);
        let mut mailbox_ids: BTreeSet<String> = e.also_in.iter().cloned().collect();
        mailbox_ids.insert(mailbox_id.to_string());
        let received_at = if e.received_at.is_empty() { now_iso() } else { e.received_at.clone() };
        let email = Email { id: e.id.clone(), blob_id, mailbox_ids, keywords: lower_set(&e.keywords), received_at, size };
        self.account_mut(account).insert_email(email);
    }

    /// Deliver raw bytes into a mailbox with a server-chosen id ("M<n>"), received now.
    pub fn deliver(&mut self, account: &str, mailbox_id: &str, raw: &[u8], keywords: &[&str]) -> String {
        assert!(self.account(account).mailboxes.contains_key(mailbox_id), "deliver: no mailbox {mailbox_id}");
        let blob_id = self.store_blob(raw.to_vec());
        let a = self.account_mut(account);
        let id = a.new_id("M");
        let email = Email {
            id: id.clone(),
            blob_id,
            mailbox_ids: [mailbox_id.to_string()].into_iter().collect(),
            keywords: keywords.iter().map(|k| k.to_ascii_lowercase()).collect(),
            received_at: now_iso(),
            size: raw.len() as u64,
        };
        a.insert_email(email);
        id
    }

    pub fn destroy_email(&mut self, account: &str, email_id: &str) {
        assert!(self.account_mut(account).remove_email(email_id), "destroy_email: no email {email_id}");
    }

    /// Create a mailbox (and its emails) as a server-side change.
    pub fn add_mailbox(&mut self, account: &str, mb: ScenarioMailbox) {
        let a = self.account_mut(account);
        assert!(!a.mailboxes.contains_key(&mb.id), "add_mailbox: {} exists", mb.id);
        let sort_order = a.mailboxes.len() as u32;
        a.mailboxes.insert(
            mb.id.clone(),
            Mailbox { id: mb.id.clone(), name: mb.name.clone(), parent_id: mb.parent_id.clone(), role: mb.role.clone(), sort_order, is_subscribed: true },
        );
        a.record(Kind::Mailbox, &mb.id, Op::Created, false);
        for e in mb.emails {
            self.add_email(account, &mb.id, e);
        }
    }

    pub fn rename_mailbox(&mut self, account: &str, mailbox_id: &str, name: &str) {
        let a = self.account_mut(account);
        a.mailboxes.get_mut(mailbox_id).unwrap_or_else(|| panic!("rename_mailbox: no {mailbox_id}")).name = name.to_string();
        a.record(Kind::Mailbox, mailbox_id, Op::Updated, false);
    }

    /// Forget the change log: every older state now gets `cannotCalculateChanges`.
    pub fn prune_log(&mut self, account: &str) {
        let a = self.account_mut(account);
        a.log.clear();
        a.log_floor = a.seq;
    }
}
