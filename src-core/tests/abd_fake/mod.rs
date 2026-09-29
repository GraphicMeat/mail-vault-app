//! In-memory fakes for the ABD engine tests: a server, a local store (vault
//! and backup drive) and an environment with a manual clock. Included by
//! `abd_engine.rs`; helpers only some tests use would warn as dead code.
#![allow(dead_code)]

use chrono::{FixedOffset, TimeZone, Utc};
use mailvault_core::abd::*;
use mailvault_core::transfer_limits::day_key;
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::rc::Rc;

// ── Shared clock, wire counter and timeline ─────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct Cmd {
    pub name: &'static str,
    pub folder: String,
    pub uids: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Ev {
    Yield,
    Server(Cmd),
    Local(&'static str, String),
    Save,
    Sleep(i64, i64),
}

pub struct Shared {
    pub clock: Cell<i64>,
    pub timeline: RefCell<Vec<Ev>>,
    /// UTC day -> bytes the "wire" carried (IMAP fetches).
    pub wire: RefCell<BTreeMap<String, u64>>,
}

impl Shared {
    pub fn new(start_ms: i64) -> Rc<Shared> {
        Rc::new(Shared { clock: Cell::new(start_ms), timeline: RefCell::new(Vec::new()), wire: RefCell::new(BTreeMap::new()) })
    }
    pub fn log(&self, ev: Ev) {
        self.timeline.borrow_mut().push(ev);
    }
    pub fn wire_today(&self) -> u64 {
        self.wire.borrow().get(&day_key(self.clock.get())).copied().unwrap_or(0)
    }
    pub fn add_wire(&self, n: u64) {
        *self.wire.borrow_mut().entry(day_key(self.clock.get())).or_insert(0) += n;
    }
    /// Server commands in order, with their timeline index.
    pub fn server_cmds(&self) -> Vec<(usize, Cmd)> {
        self.timeline
            .borrow()
            .iter()
            .enumerate()
            .filter_map(|(i, e)| if let Ev::Server(c) = e { Some((i, c.clone())) } else { None })
            .collect()
    }
    pub fn cmds_named(&self, name: &str) -> Vec<(usize, Cmd)> {
        self.server_cmds().into_iter().filter(|(_, c)| c.name == name).collect()
    }
    pub fn local_events(&self, name: &str) -> Vec<usize> {
        self.timeline
            .borrow()
            .iter()
            .enumerate()
            .filter_map(|(i, e)| if let Ev::Local(n, _) = e { if *n == name { Some(i) } else { None } } else { None })
            .collect()
    }
}

// ── Time helpers ────────────────────────────────────────────────────────────

pub fn ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
}

/// One `[start, end)` per year, in a zone `offset_secs` east of UTC.
pub fn year_bounds(offset_secs: i32, from: i32, to: i32) -> Vec<YearBounds> {
    let tz = FixedOffset::east_opt(offset_secs).unwrap();
    (from..=to)
        .map(|y| YearBounds {
            year: y,
            start_ms: tz.with_ymd_and_hms(y, 1, 1, 0, 0, 0).unwrap().timestamp_millis(),
            end_ms: tz.with_ymd_and_hms(y + 1, 1, 1, 0, 0, 0).unwrap().timestamp_millis(),
        })
        .collect()
}

/// A message with no Message-ID header at all.
pub fn raw_no_id(subject: &str, pad: usize) -> Vec<u8> {
    format!("Subject: {subject}\r\n\r\n{}", "x".repeat(pad)).into_bytes()
}

pub fn raw_msg(id: &str, pad: usize) -> Vec<u8> {
    format!("Message-ID: <{id}>\r\nSubject: s\r\n\r\n{}", "x".repeat(pad)).into_bytes()
}

pub fn msgid_of(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let start = text.find("Message-ID: <")? + "Message-ID: <".len();
    let end = text[start..].find('>')? + start;
    Some(text[start..end].to_string())
}

// ── The server ──────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct FakeMsg {
    pub raw: Vec<u8>,
    pub flags: Vec<String>,
    pub internal_ms: i64,
    pub gm_msgid: Option<u64>,
    pub unlabelled: bool,
    pub graph_id: Option<String>,
}

impl FakeMsg {
    pub fn message_id(&self) -> Option<String> {
        msgid_of(&self.raw)
    }
}

pub struct FakeFolder {
    pub info: FolderInfo,
    pub validity: u32,
    pub next_uid: u32,
    pub msgs: BTreeMap<u32, FakeMsg>,
}

#[derive(Clone)]
pub struct Fault {
    pub op: &'static str,
    pub uid: Option<u32>,
    /// Only calls about this folder.
    pub folder: Option<String>,
    /// Matching calls to let pass before the fault starts.
    pub skip: usize,
    pub times: usize,
    pub err: OpsError,
    /// Run the command on the server, then answer with the error.
    pub execute_first: bool,
}

impl Fault {
    pub fn new(op: &'static str, err: OpsError) -> Fault {
        Fault { op, uid: None, folder: None, skip: 0, times: 1, err, execute_first: false }
    }
    pub fn folder(mut self, f: &str) -> Fault {
        self.folder = Some(f.to_string());
        self
    }
    pub fn times(mut self, n: usize) -> Fault {
        self.times = n;
        self
    }
    pub fn skip(mut self, n: usize) -> Fault {
        self.skip = n;
        self
    }
    pub fn uid(mut self, u: u32) -> Fault {
        self.uid = Some(u);
        self
    }
    pub fn execute_first(mut self) -> Fault {
        self.execute_first = true;
        self
    }
}

pub struct FakeServer {
    pub sh: Rc<Shared>,
    pub provider: Provider,
    pub caps: Caps,
    pub folders: Vec<FakeFolder>,
    pub has_trash: bool,
    pub faults: Vec<Fault>,
    pub fetch_count: HashMap<(String, u32), usize>,
    pub fetches_total: usize,
    pub moves_done: usize,
    pub expunges: Vec<(Vec<u32>, Vec<u32>)>,
    pub uncounted: u64,
    pub on_fetch: Option<Box<dyn FnMut(usize)>>,
    pub bump_validity_after_moves: Option<usize>,
    pub calls: usize,
    pub released: usize,
    pub next_gm: u64,
    /// Answer COPYUID with the destination uids in reverse order.
    pub scramble_copyuid: bool,
    /// Reissue the source folder (UIDVALIDITY + 1) right before the nth
    /// move reaches it: after the engine's own check, before the command.
    pub bump_validity_before_move: Option<usize>,
    pub moves_asked: usize,
    /// Reissue the Trash (UIDVALIDITY + 1) right before an expunge reaches it.
    pub bump_trash_validity_before_expunge: bool,
    /// Uids `message_ids` leaves out of its answer (a reply row the server
    /// never sent), though the message is there.
    pub unanswered_ids: Vec<u32>,
}

impl FakeServer {
    pub fn new(sh: Rc<Shared>, provider: Provider) -> FakeServer {
        FakeServer {
            sh,
            provider,
            caps: Caps { uidplus: true, move_cmd: true, gmail_ext: provider == Provider::Gmail },
            folders: Vec::new(),
            has_trash: true,
            faults: Vec::new(),
            fetch_count: HashMap::new(),
            fetches_total: 0,
            moves_done: 0,
            expunges: Vec::new(),
            uncounted: 0,
            on_fetch: None,
            bump_validity_after_moves: None,
            calls: 0,
            released: 0,
            next_gm: 1000,
            scramble_copyuid: false,
            bump_validity_before_move: None,
            moves_asked: 0,
            bump_trash_validity_before_expunge: false,
            unanswered_ids: Vec::new(),
        }
    }

    pub fn add_folder(&mut self, path: &str, role: FolderRole) {
        self.folders.push(FakeFolder {
            info: FolderInfo { path: path.to_string(), name: path.to_string(), role, graph_id: None, selectable: true },
            validity: 1,
            next_uid: 1,
            msgs: BTreeMap::new(),
        });
    }

    /// INBOX-style server: the folders you name, plus a Trash.
    pub fn standard(sh: Rc<Shared>, folders: &[&str]) -> FakeServer {
        let mut s = FakeServer::new(sh, Provider::Imap);
        for f in folders {
            s.add_folder(f, FolderRole::Normal);
        }
        s.add_folder("Trash", FolderRole::Trash);
        s
    }

    /// Gmail: the label folders you name, All Mail, Spam and Trash.
    pub fn gmail(sh: Rc<Shared>, labels: &[&str]) -> FakeServer {
        let mut s = FakeServer::new(sh, Provider::Gmail);
        for f in labels {
            s.add_folder(f, FolderRole::Normal);
        }
        s.add_folder("[Gmail]/All Mail", FolderRole::AllMail);
        s.add_folder("[Gmail]/Spam", FolderRole::Spam);
        s.add_folder("[Gmail]/Trash", FolderRole::Trash);
        s
    }

    pub fn folder(&self, path: &str) -> &FakeFolder {
        self.folders.iter().find(|f| f.info.path == path).unwrap_or_else(|| panic!("no folder {path}"))
    }
    pub fn folder_mut(&mut self, path: &str) -> &mut FakeFolder {
        self.folders.iter_mut().find(|f| f.info.path == path).unwrap_or_else(|| panic!("no folder {path}"))
    }
    pub fn uids_in(&self, path: &str) -> Vec<u32> {
        self.folder(path).msgs.keys().copied().collect()
    }
    pub fn ids_in(&self, path: &str) -> Vec<String> {
        self.folder(path).msgs.values().filter_map(|m| m.message_id()).collect()
    }
    pub fn trash_path(&self) -> String {
        self.folders.iter().find(|f| f.info.role == FolderRole::Trash).map(|f| f.info.path.clone()).unwrap_or_default()
    }

    /// Add a message to a plain folder; returns its uid.
    pub fn add_msg(&mut self, folder: &str, id: &str, internal_ms: i64, pad: usize) -> u32 {
        let graph_id = if self.provider == Provider::Graph { Some(format!("g-{id}")) } else { None };
        let f = self.folder_mut(folder);
        let uid = f.next_uid;
        f.next_uid += 1;
        f.msgs.insert(
            uid,
            FakeMsg { raw: raw_msg(id, pad), flags: vec!["\\Seen".to_string()], internal_ms, gm_msgid: None, unlabelled: false, graph_id },
        );
        uid
    }

    /// A message with exactly these bytes; returns its uid.
    pub fn add_raw(&mut self, folder: &str, raw: Vec<u8>, internal_ms: i64) -> u32 {
        let f = self.folder_mut(folder);
        let uid = f.next_uid;
        f.next_uid += 1;
        f.msgs.insert(uid, FakeMsg { raw, flags: vec![], internal_ms, gm_msgid: None, unlabelled: false, graph_id: None });
        uid
    }

    /// Gmail: one copy in each label folder plus All Mail, sharing a gm id.
    /// Returns the All Mail uid. `labels` empty = unlabelled in All Mail.
    pub fn add_gmail_msg(&mut self, id: &str, internal_ms: i64, pad: usize, labels: &[&str]) -> u32 {
        let gm = self.next_gm;
        self.next_gm += 1;
        let mk = |unlabelled: bool| FakeMsg {
            raw: raw_msg(id, pad),
            flags: vec![],
            internal_ms,
            gm_msgid: Some(gm),
            unlabelled,
            graph_id: None,
        };
        for l in labels {
            let f = self.folder_mut(l);
            let u = f.next_uid;
            f.next_uid += 1;
            f.msgs.insert(u, mk(false));
        }
        let f = self.folder_mut("[Gmail]/All Mail");
        let u = f.next_uid;
        f.next_uid += 1;
        f.msgs.insert(u, mk(labels.is_empty()));
        u
    }

    /// Gmail: a message that lives in one folder only (Spam, Trash) with its
    /// own gm id and no All Mail copy.
    pub fn add_gmail_only(&mut self, folder: &str, id: &str, internal_ms: i64, pad: usize) -> u32 {
        let gm = self.next_gm;
        self.next_gm += 1;
        let f = self.folder_mut(folder);
        let uid = f.next_uid;
        f.next_uid += 1;
        f.msgs.insert(
            uid,
            FakeMsg { raw: raw_msg(id, pad), flags: vec![], internal_ms, gm_msgid: Some(gm), unlabelled: false, graph_id: None },
        );
        uid
    }

    pub fn preview(&self, id: &str) -> PreviewListing {
        let mut folders = Vec::new();
        let mut all_mail = None;
        let mut trash = None;
        for f in &self.folders {
            let rows: Vec<ListedMsg> = f
                .msgs
                .iter()
                .map(|(u, m)| ListedMsg {
                    uid: if self.provider == Provider::Graph { 0 } else { *u },
                    internal_ms: m.internal_ms,
                    size: m.raw.len() as u32,
                    gm_msgid: m.gm_msgid,
                    unlabelled: if f.info.role == FolderRole::AllMail { Some(m.unlabelled) } else { None },
                    graph_id: m.graph_id.clone(),
                    message_id: if self.provider == Provider::Graph { m.message_id() } else { None },
                })
                .collect();
            if f.info.role == FolderRole::AllMail && self.provider == Provider::Gmail {
                all_mail = Some((f.info.clone(), f.validity, rows));
                continue;
            }
            if f.info.role == FolderRole::Trash {
                trash = Some(f.info.clone());
            }
            folders.push((f.info.clone(), if self.provider == Provider::Graph { None } else { Some(f.validity) }, rows));
        }
        PreviewListing {
            preview_id: id.to_string(),
            provider: self.provider,
            caps: self.caps,
            trash: if self.has_trash { trash } else { None },
            folders,
            all_mail,
            listed_at_ms: self.sh.clock.get(),
        }
    }

    fn enter(&mut self, name: &'static str, folder: &str, uids: &[u32]) -> Result<Option<OpsError>, OpsError> {
        self.calls += 1;
        if self.calls > 200_000 {
            panic!("the fake server was called more than 200000 times: the engine is looping");
        }
        self.sh.log(Ev::Server(Cmd { name, folder: folder.to_string(), uids: uids.to_vec() }));
        let mut hit: Option<usize> = None;
        for (n, f) in self.faults.iter().enumerate() {
            if f.op != name || f.times == 0 {
                continue;
            }
            if let Some(u) = f.uid {
                if !uids.contains(&u) {
                    continue;
                }
            }
            if let Some(p) = &f.folder {
                if p != folder {
                    continue;
                }
            }
            hit = Some(n);
            break;
        }
        if let Some(n) = hit {
            let f = &mut self.faults[n];
            if f.skip > 0 {
                f.skip -= 1;
                return Ok(None);
            }
            if f.times != usize::MAX {
                f.times -= 1;
            }
            let err = f.err.clone();
            if f.execute_first {
                return Ok(Some(err));
            }
            return Err(err);
        }
        Ok(None)
    }

    fn do_move(&mut self, folder: &FolderInfo, msgs: &[ListedMsg], trash_path: &str) -> MoveResult {
        let gmail = self.provider == Provider::Gmail;
        let from_all_mail = folder.role == FolderRole::AllMail;
        let with_copyuid = self.caps.move_cmd && self.caps.uidplus;
        let mut moved = Vec::new();
        let mut tuids = Vec::new();
        for m in msgs {
            let removed = self.folder_mut(&folder.path).msgs.remove(&m.uid);
            let msg = match removed {
                Some(x) => x,
                None => continue,
            };
            if gmail && from_all_mail {
                if let Some(g) = msg.gm_msgid {
                    for f in self.folders.iter_mut() {
                        if f.info.role == FolderRole::Trash || f.info.role == FolderRole::Spam {
                            continue;
                        }
                        let dead: Vec<u32> =
                            f.msgs.iter().filter(|(_, x)| x.gm_msgid == Some(g)).map(|(u, _)| *u).collect();
                        for u in dead {
                            f.msgs.remove(&u);
                        }
                    }
                }
            }
            let tf = self.folder_mut(trash_path);
            let nu = tf.next_uid;
            tf.next_uid += 1;
            tf.msgs.insert(nu, msg);
            moved.push(m.uid);
            tuids.push(nu);
        }
        if self.scramble_copyuid {
            tuids.reverse();
        }
        let tv = self.folder_mut(trash_path).validity;
        self.moves_done += 1;
        if self.bump_validity_after_moves == Some(self.moves_done) {
            self.folder_mut(&folder.path).validity += 1;
        }
        MoveResult {
            moved,
            trash_uids: if with_copyuid { Some(tuids) } else { None },
            trash_validity: Some(tv),
            graph_new_ids: None,
        }
    }
}

impl ServerOps for FakeServer {
    fn provider(&self) -> Provider {
        self.provider
    }

    async fn caps(&mut self) -> Result<Caps, OpsError> {
        self.enter("caps", "", &[])?;
        Ok(self.caps)
    }

    async fn folders(&mut self) -> Result<Vec<FolderInfo>, OpsError> {
        self.enter("folders", "", &[])?;
        Ok(self.folders.iter().map(|f| f.info.clone()).collect())
    }

    async fn trash(&mut self) -> Result<Option<FolderInfo>, OpsError> {
        self.enter("trash", "", &[])?;
        if !self.has_trash {
            return Ok(None);
        }
        Ok(self.folders.iter().find(|f| f.info.role == FolderRole::Trash).map(|f| f.info.clone()))
    }

    async fn list_page(&mut self, folder: &FolderInfo, cursor: Option<String>) -> Result<ListPage, OpsError> {
        self.enter("list_page", &folder.path, &[])?;
        let after: u32 = cursor.and_then(|c| c.parse().ok()).unwrap_or(0);
        let f = self.folder(&folder.path);
        let mut items = Vec::new();
        for (u, m) in f.msgs.range((after + 1)..).take(2000) {
            items.push(ListedMsg {
                uid: *u,
                internal_ms: m.internal_ms,
                size: m.raw.len() as u32,
                gm_msgid: m.gm_msgid,
                unlabelled: None,
                graph_id: m.graph_id.clone(),
                message_id: None,
            });
        }
        let next = if items.len() == 2000 { items.last().map(|m| m.uid.to_string()) } else { None };
        Ok(ListPage { uid_validity: Some(f.validity), items, next })
    }

    async fn message_ids(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<(u32, Option<String>)>, OpsError> {
        self.enter("message_ids", &folder.path, uids)?;
        let f = self.folder(&folder.path);
        Ok(uids
            .iter()
            .filter(|u| !self.unanswered_ids.contains(*u))
            .filter_map(|u| f.msgs.get(u).map(|m| (*u, m.message_id())))
            .collect())
    }

    async fn uid_validity(&mut self, folder: &FolderInfo) -> Result<Option<u32>, OpsError> {
        self.enter("uid_validity", &folder.path, &[])?;
        if self.provider == Provider::Graph {
            return Ok(None);
        }
        Ok(Some(self.folder(&folder.path).validity))
    }

    async fn fetch(&mut self, folder: &FolderInfo, msg: &ListedMsg) -> Result<Fetched, OpsError> {
        self.enter("fetch", &folder.path, &[msg.uid])?;
        let found = {
            let f = self.folder(&folder.path);
            match &msg.graph_id {
                Some(g) => f.msgs.values().find(|m| m.graph_id.as_ref() == Some(g)).cloned(),
                None => f.msgs.get(&msg.uid).cloned(),
            }
        };
        let m = match found {
            Some(m) => m,
            None => return Err(OpsError::Gone),
        };
        *self.fetch_count.entry((folder.path.clone(), msg.uid)).or_insert(0) += 1;
        self.fetches_total += 1;
        if self.provider == Provider::Graph {
            self.uncounted += m.raw.len() as u64;
        } else {
            self.sh.add_wire(m.raw.len() as u64);
        }
        let n = self.fetches_total;
        if let Some(cb) = self.on_fetch.as_mut() {
            cb(n);
        }
        Ok(Fetched { message_id: m.message_id(), raw: m.raw, flags: m.flags, internal_ms: Some(m.internal_ms) })
    }

    async fn present(&mut self, folder: &FolderInfo, uids: &[u32]) -> Result<Vec<u32>, OpsError> {
        self.enter("present", &folder.path, uids)?;
        let f = self.folder(&folder.path);
        Ok(uids.iter().copied().filter(|u| f.msgs.contains_key(u)).collect())
    }

    async fn move_to_trash(
        &mut self,
        folder: &FolderInfo,
        msgs: &[ListedMsg],
        trash: &FolderInfo,
        validity: Option<u32>,
    ) -> Result<MoveResult, OpsError> {
        let uids: Vec<u32> = msgs.iter().map(|m| m.uid).collect();
        let late = self.enter("move", &folder.path, &uids)?;
        self.moves_asked += 1;
        if self.bump_validity_before_move == Some(self.moves_asked) {
            self.folder_mut(&folder.path).validity += 1;
        }
        // The command's own SELECT (I5): another generation refuses it.
        if self.provider != Provider::Graph {
            let now = self.folder(&folder.path).validity;
            if let Some(want) = validity {
                if now != want {
                    return Err(OpsError::ValidityChanged(format!("{VALIDITY_CHANGED}: {now} is not {want}")));
                }
            }
        }
        let r = self.do_move(folder, msgs, &trash.path);
        match late {
            Some(err) => Err(err),
            None => Ok(r),
        }
    }

    async fn expunge_exact(
        &mut self,
        trash: &FolderInfo,
        trash_uids: &[u32],
        expect: &[(u32, String)],
        validity: Option<u32>,
    ) -> Result<Vec<u32>, OpsError> {
        self.enter("expunge", &trash.path, trash_uids)?;
        if !self.caps.uidplus {
            return Err(OpsError::Other("UIDPLUS is required for an exact expunge".to_string()));
        }
        if self.bump_trash_validity_before_expunge {
            self.bump_trash_validity_before_expunge = false;
            self.folder_mut(&trash.path).validity += 1;
        }
        if let Some(want) = validity {
            let now = self.folder(&trash.path).validity;
            if now != want {
                return Err(OpsError::ValidityChanged(format!("{VALIDITY_CHANGED}: {now} is not {want}")));
            }
        }
        let mut done = Vec::new();
        let f = self.folder_mut(&trash.path);
        for u in trash_uids {
            let want = expect.iter().find(|e| e.0 == *u).map(|e| e.1.clone());
            let have = f.msgs.get(u).and_then(|m| m.message_id());
            if want.is_some() && want == have {
                f.msgs.remove(u);
                done.push(*u);
            }
        }
        self.expunges.push((trash_uids.to_vec(), done.clone()));
        Ok(done)
    }

    async fn find_in_trash(&mut self, trash: &FolderInfo, message_ids: &[String]) -> Result<Vec<(String, u32)>, OpsError> {
        self.enter("find_in_trash", &trash.path, &[])?;
        let f = self.folder(&trash.path);
        let mut out = Vec::new();
        for (u, m) in &f.msgs {
            if let Some(id) = m.message_id() {
                if message_ids.contains(&id) {
                    out.push((id, *u));
                }
            }
        }
        Ok(out)
    }

    async fn release(&mut self) {
        self.released += 1;
    }

    fn uncounted_bytes(&mut self) -> u64 {
        std::mem::take(&mut self.uncounted)
    }
}

// ── The local store ─────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct FileRec {
    pub name: String,
    pub raw: Vec<u8>,
    pub archived: bool,
}

pub struct FakeLocal {
    pub sh: Rc<Shared>,
    pub vault: RefCell<HashMap<String, BTreeMap<u32, FileRec>>>,
    pub mirror: RefCell<HashMap<String, BTreeMap<u32, FileRec>>>,
    pub drive_gone: Cell<bool>,
    pub vault_gone: Cell<bool>,
    pub listing_calls: RefCell<HashMap<String, usize>>,
    pub verify_calls: Cell<usize>,
    pub mirror_copy_calls: Cell<usize>,
    pub mirror_path_calls: Cell<usize>,
    pub stores: RefCell<Vec<(String, u32)>>,
    pub reads: Cell<usize>,
    pub deleted_hook: RefCell<Vec<(String, Vec<u32>)>>,
    pub graph_map: RefCell<HashMap<(String, String), u32>>,
    /// (folder, uid, n): remove that vault file just before the nth verify_vault call.
    pub remove_before_verify: RefCell<Option<(String, u32, usize)>>,
    /// (folder, uid): remove that mirror file before the first mirror_verify_paths call.
    pub remove_mirror_before_path_check: RefCell<Option<(String, u32)>>,
    /// Run once, just before the nth verify_vault call.
    pub before_verify: RefCell<Option<(usize, Box<dyn Fn(&FakeLocal)>)>>,
    /// Run once, just before the first mirror_verify_paths call.
    pub before_mirror_path_check: RefCell<Option<Box<dyn Fn(&FakeLocal)>>>,
    /// The generation each vault folder is keyed under; a folder not named
    /// here answers `default_generation` (the fake server's first UIDVALIDITY).
    pub generation: RefCell<HashMap<String, Option<u32>>>,
    pub default_generation: Cell<Option<u32>>,
    /// (folder, uid) of every store that found an archived copy already there.
    pub found: RefCell<Vec<(String, u32, StoreOutcome)>>,
}

impl FakeLocal {
    pub fn new(sh: Rc<Shared>) -> FakeLocal {
        FakeLocal {
            sh,
            vault: RefCell::new(HashMap::new()),
            mirror: RefCell::new(HashMap::new()),
            drive_gone: Cell::new(false),
            vault_gone: Cell::new(false),
            listing_calls: RefCell::new(HashMap::new()),
            verify_calls: Cell::new(0),
            mirror_copy_calls: Cell::new(0),
            mirror_path_calls: Cell::new(0),
            stores: RefCell::new(Vec::new()),
            reads: Cell::new(0),
            deleted_hook: RefCell::new(Vec::new()),
            graph_map: RefCell::new(HashMap::new()),
            remove_before_verify: RefCell::new(None),
            remove_mirror_before_path_check: RefCell::new(None),
            before_verify: RefCell::new(None),
            before_mirror_path_check: RefCell::new(None),
            generation: RefCell::new(HashMap::new()),
            default_generation: Cell::new(Some(1)),
            found: RefCell::new(Vec::new()),
        }
    }

    pub fn set_generation(&self, folder: &str, g: Option<u32>) {
        self.generation.borrow_mut().insert(folder.to_string(), g);
    }

    pub fn path_of(folder: &str, name: &str) -> PathBuf {
        PathBuf::from(format!("/vault/{folder}/cur/{name}"))
    }

    pub fn put_vault(&self, folder: &str, uid: u32, raw: Vec<u8>, archived: bool) {
        let name = if archived { format!("{uid}.eml:2,A") } else { format!("{uid}.eml:2,S") };
        self.vault.borrow_mut().entry(folder.to_string()).or_default().insert(uid, FileRec { name, raw, archived });
    }
    pub fn remove_vault(&self, folder: &str, uid: u32) {
        if let Some(m) = self.vault.borrow_mut().get_mut(folder) {
            m.remove(&uid);
        }
    }
    pub fn swap_vault_raw(&self, folder: &str, uid: u32, raw: Vec<u8>) {
        if let Some(m) = self.vault.borrow_mut().get_mut(folder) {
            if let Some(r) = m.get_mut(&uid) {
                r.raw = raw;
            }
        }
    }
    pub fn vault_uids(&self, folder: &str) -> Vec<u32> {
        self.vault.borrow().get(folder).map(|m| m.keys().copied().collect()).unwrap_or_default()
    }
    pub fn mirror_uids(&self, folder: &str) -> Vec<u32> {
        self.mirror.borrow().get(folder).map(|m| m.keys().copied().collect()).unwrap_or_default()
    }
    pub fn remove_mirror(&self, folder: &str, uid: u32) {
        if let Some(m) = self.mirror.borrow_mut().get_mut(folder) {
            m.remove(&uid);
        }
    }
    pub fn listing_count(&self, folder: &str) -> usize {
        self.listing_calls.borrow().get(folder).copied().unwrap_or(0)
    }

    fn log(&self, name: &'static str, folder: &str) {
        self.sh.log(Ev::Local(name, folder.to_string()));
    }

    fn find_by_path(&self, path: &Path) -> Option<FileRec> {
        let vault = self.vault.borrow();
        for (folder, m) in vault.iter() {
            for rec in m.values() {
                if FakeLocal::path_of(folder, &rec.name) == path {
                    return Some(rec.clone());
                }
            }
        }
        None
    }
}

impl LocalStore for FakeLocal {
    async fn archived_listing(&self, folder: &str) -> Result<HashMap<u32, PathBuf>, LocalError> {
        self.log("archived_listing", folder);
        *self.listing_calls.borrow_mut().entry(folder.to_string()).or_insert(0) += 1;
        if self.vault_gone.get() {
            return Err(LocalError::VaultUnavailable("vault folder is gone".to_string()));
        }
        let vault = self.vault.borrow();
        let mut out = HashMap::new();
        if let Some(m) = vault.get(folder) {
            for (uid, rec) in m {
                if rec.archived {
                    out.insert(*uid, FakeLocal::path_of(folder, &rec.name));
                }
            }
        }
        Ok(out)
    }

    async fn store_archived(&self, folder: &str, uid: u32, f: Fetched) -> Result<Stored, LocalError> {
        self.log("store_archived", folder);
        if self.vault_gone.get() {
            return Err(LocalError::VaultUnavailable("vault folder is gone".to_string()));
        }
        let mut vault = self.vault.borrow_mut();
        let m = vault.entry(folder.to_string()).or_default();
        // As `archive::store_archived`: an archived copy is never overwritten;
        // what is there comes back, saying whether it holds these bytes.
        if let Some(r) = m.get(&uid).filter(|r| r.archived) {
            let outcome = if r.raw == f.raw { StoreOutcome::FoundSame } else { StoreOutcome::FoundDifferent };
            self.found.borrow_mut().push((folder.to_string(), uid, outcome));
            return Ok(Stored { path: FakeLocal::path_of(folder, &r.name), outcome });
        }
        let name = format!("{uid}.eml:2,A");
        m.insert(uid, FileRec { name: name.clone(), raw: f.raw, archived: true });
        self.stores.borrow_mut().push((folder.to_string(), uid));
        Ok(Stored { path: FakeLocal::path_of(folder, &name), outcome: StoreOutcome::Wrote })
    }

    async fn vault_generation(&self, folder: &str) -> Result<Option<u32>, LocalError> {
        self.log("vault_generation", folder);
        if self.vault_gone.get() {
            return Err(LocalError::VaultUnavailable("vault folder is gone".to_string()));
        }
        Ok(self.generation.borrow().get(folder).copied().unwrap_or(self.default_generation.get()))
    }

    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, LocalError> {
        self.log("read_file", "");
        self.reads.set(self.reads.get() + 1);
        self.find_by_path(path).map(|r| r.raw).ok_or_else(|| LocalError::Io("no such file".to_string()))
    }

    async fn verify_vault(
        &self,
        folder: &str,
        listing: &HashMap<u32, PathBuf>,
        uids: &[u32],
        expected: &HashMap<u32, String>,
    ) -> Result<Verify, LocalError> {
        self.log("verify_vault", folder);
        let call = self.verify_calls.get() + 1;
        self.verify_calls.set(call);
        let hook = self.remove_before_verify.borrow().clone();
        if let Some((f, u, n)) = hook {
            if n == call {
                self.remove_vault(&f, u);
            }
        }
        let fire = matches!(self.before_verify.borrow().as_ref(), Some((n, _)) if *n == call);
        if fire {
            let taken = self.before_verify.borrow_mut().take();
            if let Some((_, f)) = taken {
                f(self);
            }
        }
        if self.vault_gone.get() {
            return Err(LocalError::VaultUnavailable("vault folder is gone".to_string()));
        }
        let vault = self.vault.borrow();
        let mut v = Verify { ok: vec![], missing: vec![], mismatched: vec![] };
        for u in uids {
            let rec = listing
                .get(u)
                .and_then(|p| vault.get(folder).and_then(|m| m.get(u)).filter(|r| FakeLocal::path_of(folder, &r.name) == *p));
            match rec {
                // Strict, as `maildir::verify_listed_strict`: an expected id
                // must be read and equal; no expected id is presence only.
                Some(r) if r.archived => match (expected.get(u), msgid_of(&r.raw)) {
                    (Some(e), Some(h)) if *e == h => v.ok.push(*u),
                    (Some(_), _) => v.mismatched.push(*u),
                    (None, _) => v.ok.push(*u),
                },
                _ => v.missing.push(*u),
            }
        }
        Ok(v)
    }

    async fn mirror_copy_verify(
        &self,
        folder: &str,
        listing: &HashMap<u32, PathBuf>,
        uids: &[u32],
    ) -> Result<Verify, LocalError> {
        self.log("mirror_copy_verify", folder);
        self.mirror_copy_calls.set(self.mirror_copy_calls.get() + 1);
        if self.drive_gone.get() {
            return Err(LocalError::DriveUnavailable("the backup drive is not connected".to_string()));
        }
        let vault = self.vault.borrow();
        let mut mirror = self.mirror.borrow_mut();
        let mut v = Verify { ok: vec![], missing: vec![], mismatched: vec![] };
        for u in uids {
            // The vault side is found through the caller's listing only.
            let src = listing.get(u).and_then(|_| vault.get(folder).and_then(|m| m.get(u))).filter(|r| r.archived);
            match src {
                None => v.missing.push(*u),
                Some(r) => {
                    let dst = mirror.entry(folder.to_string()).or_default();
                    if !dst.contains_key(u) {
                        dst.insert(*u, r.clone());
                    }
                    if msgid_of(&dst[u].raw) == msgid_of(&r.raw) {
                        v.ok.push(*u);
                    } else {
                        v.mismatched.push(*u);
                    }
                }
            }
        }
        Ok(v)
    }

    async fn mirror_verify_paths(
        &self,
        folder: &str,
        files: &[(u32, String)],
        expected: &HashMap<u32, String>,
    ) -> Result<Verify, LocalError> {
        self.log("mirror_verify_paths", folder);
        self.mirror_path_calls.set(self.mirror_path_calls.get() + 1);
        let hook = self.remove_mirror_before_path_check.borrow_mut().take();
        if let Some((f, u)) = hook {
            self.remove_mirror(&f, u);
        }
        let taken = self.before_mirror_path_check.borrow_mut().take();
        if let Some(f) = taken {
            f(self);
        }
        if self.drive_gone.get() {
            return Err(LocalError::DriveUnavailable("the backup drive is not connected".to_string()));
        }
        let mirror = self.mirror.borrow();
        let vault = self.vault.borrow();
        let mut v = Verify { ok: vec![], missing: vec![], mismatched: vec![] };
        for (u, name) in files {
            let rec = mirror.get(folder).and_then(|m| m.get(u)).filter(|r| r.name == *name);
            match rec {
                None => v.missing.push(*u),
                Some(r) => match (expected.get(u), msgid_of(&r.raw)) {
                    (Some(e), Some(h)) if *e == h => v.ok.push(*u),
                    (Some(_), _) => v.mismatched.push(*u),
                    // No Message-ID: the same bytes as the vault copy, or not proven.
                    (None, _) => match vault.get(folder).and_then(|m| m.get(u)) {
                        Some(src) if src.raw == r.raw => v.ok.push(*u),
                        Some(_) => v.mismatched.push(*u),
                        None => v.missing.push(*u),
                    },
                },
            }
        }
        Ok(v)
    }

    async fn graph_uids(&self, folder: &str, listed: &[(String, Option<String>)]) -> Result<Vec<u32>, LocalError> {
        self.log("graph_uids", folder);
        let mut map = self.graph_map.borrow_mut();
        let mut out = Vec::new();
        for (gid, _) in listed {
            let key = (folder.to_string(), gid.clone());
            let next = map.iter().filter(|((f, _), _)| f == folder).count() as u32 + 1;
            let uid = *map.entry(key).or_insert(next);
            out.push(uid);
        }
        Ok(out)
    }

    async fn deleted_from_server(&self, folder: &str, uids: &[u32]) {
        self.deleted_hook.borrow_mut().push((folder.to_string(), uids.to_vec()));
    }
}

// ── The environment ─────────────────────────────────────────────────────────

pub struct FakeEnv {
    pub sh: Rc<Shared>,
    pub saves: RefCell<Vec<JobFile>>,
    pub plan_saves: RefCell<Vec<String>>,
    pub allmail_saves: Cell<usize>,
    pub frames: RefCell<Vec<Value>>,
    pub yields: Cell<usize>,
    pub sleeps: RefCell<Vec<(i64, i64)>>,
    pub limit: Cell<Option<u64>>,
    pub creds: Cell<bool>,
    pub crash: RefCell<Option<Box<dyn Fn(&JobFile, usize) -> bool>>>,
    pub crashed: Cell<bool>,
    pub on_yield: RefCell<Option<Box<dyn FnMut(usize)>>>,
}

impl FakeEnv {
    pub fn new(sh: Rc<Shared>) -> FakeEnv {
        FakeEnv {
            sh,
            saves: RefCell::new(Vec::new()),
            plan_saves: RefCell::new(Vec::new()),
            allmail_saves: Cell::new(0),
            frames: RefCell::new(Vec::new()),
            yields: Cell::new(0),
            sleeps: RefCell::new(Vec::new()),
            limit: Cell::new(None),
            creds: Cell::new(true),
            crash: RefCell::new(None),
            crashed: Cell::new(false),
            on_yield: RefCell::new(None),
        }
    }

    /// Fail (as a killed process would) the first save `f` says yes to, and
    /// every save after it.
    pub fn crash_when(&self, f: impl Fn(&JobFile, usize) -> bool + 'static) {
        *self.crash.borrow_mut() = Some(Box::new(f));
        self.crashed.set(false);
    }
    pub fn revive(&self) {
        *self.crash.borrow_mut() = None;
        self.crashed.set(false);
    }
    pub fn last_saved(&self) -> JobFile {
        self.saves.borrow().last().cloned().expect("nothing was saved")
    }
    pub fn statuses(&self) -> Vec<JobStatus> {
        self.saves.borrow().iter().map(|j| j.status.clone()).collect()
    }
    pub fn last_frame(&self) -> Value {
        self.frames.borrow().last().cloned().expect("no frame")
    }
    pub fn slept_ms(&self) -> Vec<i64> {
        self.sleeps.borrow().iter().map(|(a, b)| b - a).collect()
    }
}

impl Env for FakeEnv {
    fn now_ms(&self) -> i64 {
        self.sh.clock.get()
    }

    async fn sleep_until(&self, until_ms: i64, _ctl: &Control) {
        let now = self.sh.clock.get();
        self.sleeps.borrow_mut().push((now, until_ms));
        self.sh.log(Ev::Sleep(now, until_ms));
        if self.sleeps.borrow().len() > 20_000 {
            panic!("the engine slept more than 20000 times: it is looping");
        }
        if until_ms > now {
            self.sh.clock.set(until_ms);
        }
    }

    fn allowance_left(&self) -> Option<u64> {
        self.limit.get().map(|l| l.saturating_sub(self.sh.wire_today()))
    }

    fn daily_limit(&self) -> Option<u64> {
        self.limit.get()
    }

    async fn yield_to_foreground(&self) {
        let n = self.yields.get() + 1;
        self.yields.set(n);
        self.sh.log(Ev::Yield);
        if let Some(cb) = self.on_yield.borrow_mut().as_mut() {
            cb(n);
        }
    }

    fn save(&self, job: &JobFile) -> Result<(), String> {
        if self.crashed.get() {
            return Err("the process is dead".to_string());
        }
        let idx = self.saves.borrow().len();
        let die = match self.crash.borrow().as_ref() {
            Some(f) => f(job, idx),
            None => false,
        };
        if die {
            self.crashed.set(true);
            return Err("the process was killed".to_string());
        }
        self.sh.log(Ev::Save);
        self.saves.borrow_mut().push(job.clone());
        Ok(())
    }

    fn save_plan(&self, name: &str, _plan: &FolderPlan) -> Result<(), String> {
        self.sh.log(Ev::Local("save_plan", name.to_string()));
        self.plan_saves.borrow_mut().push(name.to_string());
        Ok(())
    }

    fn save_allmail(&self, _map: &AllMailMap) -> Result<(), String> {
        self.allmail_saves.set(self.allmail_saves.get() + 1);
        Ok(())
    }

    fn emit(&self, frame: &Value) {
        self.frames.borrow_mut().push(frame.clone());
    }

    fn has_credentials(&self) -> bool {
        self.creds.get()
    }
}

// ── The rig ─────────────────────────────────────────────────────────────────

pub struct Rig {
    pub sh: Rc<Shared>,
    pub server: FakeServer,
    pub local: FakeLocal,
    pub env: FakeEnv,
    pub ctl: Rc<Control>,
    pub job: JobFile,
    pub plans: PlanStore,
}

pub const START_MS: i64 = 1_790_000_000_000; // 2026-09-21T14:13:20Z

pub fn start_ms() -> i64 {
    ms(2026, 9, 29, 10, 0)
}

impl Rig {
    pub fn with_server(sh: Rc<Shared>, server: FakeServer, mode: Mode, timing: Timing, delete_mode: DeleteMode) -> Rig {
        let provider = server.provider;
        let job = JobFile::create(NewJob {
            account_id: "acc1".to_string(),
            account_email: "a@b.test".to_string(),
            host: "imap.example.test".to_string(),
            provider,
            mode,
            timing,
            delete_mode,
            scope: Scope { folders: vec![], dates: DateScope::All, date_choice: "all".to_string(), year_bounds: year_bounds(0, 2015, 2030) },
            now_ms: sh.clock.get(),
        });
        Rig {
            local: FakeLocal::new(sh.clone()),
            env: FakeEnv::new(sh.clone()),
            sh,
            server,
            ctl: Rc::new(Control::new()),
            job,
            plans: PlanStore::new(),
        }
    }

    /// A plain IMAP server with the given folders and a Trash.
    pub fn imap(folders: &[&str], mode: Mode, timing: Timing, delete_mode: DeleteMode) -> Rig {
        let sh = Shared::new(start_ms());
        let server = FakeServer::standard(sh.clone(), folders);
        Rig::with_server(sh, server, mode, timing, delete_mode)
    }

    pub fn gmail(labels: &[&str], mode: Mode, timing: Timing, delete_mode: DeleteMode) -> Rig {
        let sh = Shared::new(start_ms());
        let server = FakeServer::gmail(sh.clone(), labels);
        Rig::with_server(sh, server, mode, timing, delete_mode)
    }

    pub fn select(&mut self, folders: &[&str]) {
        self.job.scope.folders = folders.iter().map(|s| s.to_string()).collect();
    }

    pub async fn plan(&mut self) -> RunExit {
        let preview = self.server.preview("p1");
        plan_job(&mut self.job, &preview, &mut self.plans, &mut self.server, &self.local, &self.env, &self.ctl).await
    }

    pub async fn run(&mut self) -> RunExit {
        run(&mut self.job, &self.plans, &mut self.server, &self.local, &self.env, &self.ctl).await
    }

    pub async fn plan_and_run(&mut self) -> RunExit {
        let p = self.plan().await;
        assert_eq!(p, RunExit::Completed, "planning failed");
        self.run().await
    }

    /// The process died: only what was saved survives. Server, vault and
    /// drive stay as they are.
    pub fn restart_from_last_save(&mut self) {
        self.env.revive();
        self.job = self.env.last_saved();
        self.ctl = Rc::new(Control::new());
    }

    pub fn folder_state(&self, path: &str) -> &FolderState {
        self.job.folders.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("no folder state {path}"))
    }
}
