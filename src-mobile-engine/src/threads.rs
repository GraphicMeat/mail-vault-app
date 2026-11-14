//! Conversations in the message list: the page's `threadMode` grouped or expandable asks
//! `mobile.messages.page` with `threads: true`, and `mobile.messages.thread` lists one
//! conversation's messages. Desktop's rule (`src/utils/emailParser.js` `buildThreads`), over the
//! folder's listed rows (in All Inboxes, each inbox on its own):
//!
//! - Every Message-ID a message names (its References, its In-Reply-To and its own, from
//!   `messages.thread_json` and `messages.message_id`) is joined into one set (union-find), so a
//!   reply that carries only its parent's id still lands in the conversation. A message without a
//!   Message-ID is its own (`uid-<uid>`). The conversation is named after its root: the one id no
//!   chain calls a descendant, else the oldest message's.
//! - A message that names no ancestor and whose subject reads as a reply (`Re:`, `Fwd:`, `Fw:`,
//!   `Re[2]:`) joins the conversation with the same subject (prefixes dropped) nearest to it in time,
//!   when one of its messages is within 30 days; bare-subject mail never merges by subject.
//!
//! The grouping is the whole folder's, never a page's, so a page of conversations pages by its
//! newest message's `(date, uid)` exactly as the flat list pages by rows, and `total` counts
//! conversations. It is kept per folder for the folder's list generation and row count (every
//! sync pass and every action that changes the folder moves the generation), so paging and
//! scrolling never regroup; a change regroups once, on the next page read. A change that leaves
//! the same messages listed (a read or flag change, which moves the generation too) only reads
//! their flags again, without regrouping. Grouping is O(n log n) in the folder's rows: a
//! reply-like orphan finds its nearest same-subject message through an ordered index, so a
//! storm of `Re:` mails with no ancestry never compares every mail with every other.

use crate::db::Shared;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// A subject alone joins a reply-like orphan to a conversation only this close in time.
const SUBJECT_MERGE_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Folders whose grouping is kept at once; one more drops them all (a few folders are in use).
const CACHED_FOLDERS: usize = 8;

/// One message of a conversation.
#[derive(Clone, Debug)]
pub(crate) struct Member {
    pub(crate) uid: i64,
    pub(crate) date_ms: i64,
    pub(crate) seen: bool,
    pub(crate) flagged: bool,
}

/// One conversation: its id and its messages, oldest first.
#[derive(Debug)]
pub(crate) struct Thread {
    pub(crate) id: String,
    pub(crate) members: Vec<Member>,
}

impl Thread {
    /// The newest message, which stands for the conversation in the list.
    pub(crate) fn head(&self) -> &Member {
        self.members.last().expect("a conversation has a message")
    }
}

/// A folder's conversations, newest head first, for one list generation and row count.
pub(crate) struct Folder {
    gen: i64,
    count: i64,
    pub(crate) threads: Vec<Thread>,
    /// uid -> index in `threads`.
    by_uid: HashMap<i64, usize>,
}

impl Folder {
    /// The conversation holding `uid`, if it is listed.
    pub(crate) fn of_uid(&self, uid: i64) -> Option<&Thread> {
        self.by_uid.get(&uid).map(|&i| &self.threads[i])
    }
}

/// The groupings kept, per `(account, folder)`.
#[derive(Default)]
pub(crate) struct Cache(Mutex<HashMap<(String, String), Arc<Folder>>>);

/// One listed row as the grouping reads it.
struct Row {
    uid: i64,
    date_ms: i64,
    message_id: String,
    subject: String,
    thread_json: String,
    seen: bool,
    flagged: bool,
}

/// What `thread_json` holds of a message's ancestry.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Ancestry {
    references: Vec<String>,
    in_reply_to: Option<String>,
}

/// `folder`'s conversations for list generation `gen` (read before the caller's read
/// transaction): the kept grouping when it is of that generation and row count, else a new one.
pub(crate) fn folder_threads(shared: &Shared, c: &Connection, account: &str, folder: &str, gen: i64) -> rusqlite::Result<Arc<Folder>> {
    let count = crate::rpc::count_listed(c, account, folder)?;
    let key = (account.to_string(), folder.to_string());
    let kept = lock(&shared.threads.0).get(&key).cloned();
    if let Some(f) = &kept {
        if f.gen == gen && f.count == count {
            return Ok(Arc::clone(f));
        }
    }
    let reflagged = match &kept {
        Some(f) if f.count == count => reflag(c, account, folder, f, gen)?,
        _ => None,
    };
    let built = Arc::new(match reflagged {
        Some(f) => f,
        None => {
            let threads = group(read_rows(c, account, folder)?);
            let mut by_uid = HashMap::new();
            for (i, t) in threads.iter().enumerate() {
                for m in &t.members {
                    by_uid.insert(m.uid, i);
                }
            }
            Folder { gen, count, threads, by_uid }
        }
    });
    let mut cache = lock(&shared.threads.0);
    if cache.len() >= CACHED_FOLDERS && !cache.contains_key(&key) {
        cache.clear();
    }
    cache.insert(key, Arc::clone(&built));
    Ok(built)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `f`'s grouping for generation `gen` when the folder lists exactly the messages it grouped: the
/// same conversations with each message's read and flag state read again (one narrow read, no
/// headers, no regroup). `None` when a message came or went.
fn reflag(c: &Connection, account: &str, folder: &str, f: &Folder, gen: i64) -> rusqlite::Result<Option<Folder>> {
    let mut st = c.prepare_cached(&format!(
        "SELECT uid, COALESCE(local_seen, seen), COALESCE(local_flagged, flagged) FROM messages WHERE {}",
        crate::rpc::LISTED
    ))?;
    let mut state: HashMap<i64, (bool, bool)> = HashMap::with_capacity(f.by_uid.len());
    let mut rows = st.query((account, folder))?;
    while let Some(r) = rows.next()? {
        let uid: i64 = r.get(0)?;
        if !f.by_uid.contains_key(&uid) {
            return Ok(None);
        }
        state.insert(uid, (r.get::<_, i64>(1)? != 0, r.get::<_, i64>(2)? != 0));
    }
    if state.len() != f.by_uid.len() {
        return Ok(None);
    }
    let threads = f
        .threads
        .iter()
        .map(|t| Thread {
            id: t.id.clone(),
            members: t
                .members
                .iter()
                .map(|m| {
                    let (seen, flagged) = state[&m.uid];
                    Member { seen, flagged, ..m.clone() }
                })
                .collect(),
        })
        .collect();
    Ok(Some(Folder { gen, count: f.count, threads, by_uid: f.by_uid.clone() }))
}

fn read_rows(c: &Connection, account: &str, folder: &str) -> rusqlite::Result<Vec<Row>> {
    let mut st = c.prepare_cached(&format!(
        "SELECT uid, date_ms, message_id, subject, thread_json, COALESCE(local_seen, seen), COALESCE(local_flagged, flagged)
         FROM messages WHERE {}",
        crate::rpc::LISTED
    ))?;
    let rows = st
        .query_map((account, folder), |r| {
            Ok(Row {
                uid: r.get(0)?,
                date_ms: r.get(1)?,
                message_id: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                subject: r.get(3)?,
                thread_json: r.get(4)?,
                seen: r.get::<_, i64>(5)? != 0,
                flagged: r.get::<_, i64>(6)? != 0,
            })
        })?
        .collect();
    rows
}

/// Up to `limit` conversations of `f` strictly after `bound` (their newest message's
/// `(date_ms, uid)`), each as its newest message's list row (read now, `row_json`) and the cursor
/// that follows it. A conversation of more than one message adds `threadId`, `threadCount`,
/// `threadUnread` (its unread messages), `threadFlagged` (any flagged) and `threadUids` (newest
/// first); the row's own fields stay its newest message's. One of a single message is the plain
/// row.
pub(crate) fn heads_page(
    c: &Connection,
    f: &Folder,
    account: &str,
    folder: &str,
    bound: Option<(i64, i64)>,
    limit: i64,
) -> rusqlite::Result<Vec<((i64, i64), Value)>> {
    let start = match bound {
        Some(b) => f.threads.partition_point(|t| (t.head().date_ms, t.head().uid) >= b),
        None => 0,
    };
    let mut out = Vec::new();
    for t in f.threads[start..].iter() {
        if out.len() as i64 >= limit {
            break;
        }
        let head = t.head();
        let Some(mut row) = row_of(c, account, folder, head.uid)? else { continue };
        decorate(&mut row, t);
        out.push(((head.date_ms, head.uid), row));
    }
    Ok(out)
}

/// The list row of `uid` (`rpc::row_json`), if it is listed.
pub(crate) fn row_of(c: &Connection, account: &str, folder: &str, uid: i64) -> rusqlite::Result<Option<Value>> {
    use rusqlite::OptionalExtension;
    let mut st = c.prepare_cached(&format!(
        "SELECT {} FROM messages WHERE {} AND uid = ?3",
        crate::rpc::ROW_COLUMNS,
        crate::rpc::LISTED
    ))?;
    st.query_row((account, folder, uid), crate::rpc::row_json).optional()
}

fn decorate(row: &mut Value, t: &Thread) {
    let n = t.members.len();
    if n < 2 {
        return;
    }
    let unread = t.members.iter().filter(|m| !m.seen).count();
    let flagged = t.members.iter().any(|m| m.flagged);
    let uids: Vec<i64> = t.members.iter().rev().map(|m| m.uid).collect();
    if let Some(o) = row.as_object_mut() {
        o.insert("threadId".into(), json!(t.id));
        o.insert("threadCount".into(), json!(n));
        o.insert("threadUnread".into(), json!(unread));
        o.insert("threadFlagged".into(), json!(flagged));
        o.insert("threadUids".into(), json!(uids));
    }
}

// ── The grouping ─────────────────────────────────────────────────────────────

/// A Message-ID in one form: trimmed, inside one pair of angle brackets.
fn normalize_id(id: &str) -> Option<String> {
    let bare = id.trim().trim_start_matches('<').trim_end_matches('>').trim();
    (!bare.is_empty()).then(|| format!("<{bare}>"))
}

/// Most ids read from one message's References: its root (the first) and its nearest ancestors
/// (the last). A header is the sender's to write; a long one must not make grouping slow.
const MAX_IDS: usize = 50;

/// The ids in References / In-Reply-To values (each may hold several), oldest first, once each
/// (a set, so a header of many ids costs linear time), at most [`MAX_IDS`] of them: the first and
/// the last `MAX_IDS - 1`.
fn id_list<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for v in values {
        for token in v.split_whitespace() {
            if let Some(id) = normalize_id(token) {
                if seen.insert(id.clone()) {
                    out.push(id);
                }
            }
        }
    }
    if out.len() > MAX_IDS {
        out.drain(1..out.len() - (MAX_IDS - 1));
    }
    out
}

/// The length of a leading reply or forward prefix (`re:`, `fwd:`, `fw:`, `re[2]:`) of a
/// lower-cased subject.
fn prefix_len(lower: &str) -> Option<usize> {
    for p in ["re:", "fwd:", "fw:"] {
        if lower.starts_with(p) {
            return Some(p.len());
        }
    }
    let rest = lower.strip_prefix("re[")?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && rest[digits..].starts_with("]:")).then_some(3 + digits + 2)
}

/// Desktop's `normalizeSubject`: every leading reply and forward prefix dropped.
fn normalize_subject(subject: &str) -> String {
    let mut s = subject.trim();
    while let Some(n) = prefix_len(&s.to_ascii_lowercase()) {
        s = s[n..].trim();
    }
    if s.is_empty() {
        "(No subject)".to_string()
    } else {
        s.to_string()
    }
}

fn reply_like(subject: &str) -> bool {
    prefix_len(&subject.trim().to_ascii_lowercase()).is_some()
}

struct Ids {
    index: HashMap<String, usize>,
    names: Vec<String>,
    parent: Vec<usize>,
}

impl Ids {
    fn add(&mut self, id: &str) -> usize {
        if let Some(&i) = self.index.get(id) {
            return i;
        }
        let i = self.names.len();
        self.index.insert(id.to_string(), i);
        self.names.push(id.to_string());
        self.parent.push(i);
        i
    }

    fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }

    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[rb] = ra;
        }
    }
}

/// The conversations of `rows`, newest head first, each oldest message first.
fn group(rows: Vec<Row>) -> Vec<Thread> {
    let mut ids = Ids { index: HashMap::new(), names: Vec::new(), parent: Vec::new() };
    let mut chains: Vec<Vec<usize>> = Vec::with_capacity(rows.len());
    let mut has_ancestor: HashSet<usize> = HashSet::new();
    let mut own_row: HashMap<usize, usize> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        let ancestry: Ancestry = serde_json::from_str(&row.thread_json).unwrap_or_default();
        let mut chain = id_list(ancestry.references.iter().map(String::as_str));
        for id in id_list(ancestry.in_reply_to.as_deref()) {
            if !chain.contains(&id) {
                chain.push(id);
            }
        }
        let own = normalize_id(&row.message_id).unwrap_or_else(|| format!("uid-{}", row.uid));
        if !chain.contains(&own) {
            chain.push(own.clone());
        }
        let chain: Vec<usize> = chain.iter().map(|id| ids.add(id)).collect();
        for &later in &chain[1..] {
            has_ancestor.insert(later);
            ids.union(chain[0], later);
        }
        own_row.entry(ids.add(&own)).or_insert(i);
        chains.push(chain);
    }

    // Name each conversation after its root: an id no chain calls a descendant, the oldest
    // message's first (an id with no message here never wins), then the id itself.
    let ts = |id: usize| own_row.get(&id).map_or(i64::MAX, |&r| rows[r].date_ms);
    let mut components: HashMap<usize, Vec<usize>> = HashMap::new();
    for id in 0..ids.names.len() {
        let rep = ids.find(id);
        components.entry(rep).or_default().push(id);
    }
    let mut root_of: HashMap<usize, usize> = HashMap::new();
    for (rep, members) in &components {
        let roots: Vec<usize> = members.iter().copied().filter(|id| !has_ancestor.contains(id)).collect();
        let pool = if roots.is_empty() { members } else { &roots };
        let best = pool
            .iter()
            .copied()
            .min_by(|&a, &b| ts(a).cmp(&ts(b)).then_with(|| ids.names[a].cmp(&ids.names[b])))
            .expect("a component has an id");
        root_of.insert(*rep, best);
    }

    // Rows by conversation, in the order the conversations are first met.
    let mut order: Vec<usize> = Vec::new();
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, chain) in chains.iter().enumerate() {
        let root = root_of[&ids.find(chain[0])];
        groups
            .entry(root)
            .or_insert_with(|| {
                order.push(root);
                Vec::new()
            })
            .push(i);
    }

    // A reply-like message that names no ancestor joins the same-subject conversation nearest in
    // time (the one with a message closest to it; on a tie the conversation met first), oldest
    // orphan first, within the window; else it starts one later orphans may join. Each subject
    // keeps its conversations' message dates in order (`(date, conversation)`), so the nearest
    // message is the one just before or just after the orphan's date: two lookups, not a scan.
    let mut merged: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut dates: HashMap<String, BTreeSet<(i64, usize)>> = HashMap::new();
    let mut orphans: Vec<(usize, usize)> = Vec::new();
    for root in order {
        let members = groups.remove(&root).unwrap_or_default();
        let first = members[0];
        if members.len() == 1 && chains[first].len() == 1 && reply_like(&rows[first].subject) {
            orphans.push((root, first));
        } else {
            let at = dates.entry(normalize_subject(&rows[first].subject)).or_default();
            for &m in &members {
                at.insert((rows[m].date_ms, merged.len()));
            }
            merged.push((root, members));
        }
    }
    orphans.sort_by_key(|&(_, r)| (rows[r].date_ms, rows[r].uid));
    for (root, r) in orphans {
        let t = rows[r].date_ms;
        let at = dates.entry(normalize_subject(&rows[r].subject)).or_default();
        // The first conversation with a message at `date`.
        let first_at = |date: i64| at.range((date, 0)..).next().filter(|&&(d, _)| d == date).map(|&(_, g)| g);
        let before = at.range(..=(t, usize::MAX)).next_back().map(|&(d, _)| d);
        let after = at.range((t, 0)..).next().map(|&(d, _)| d);
        let best = [before, after].into_iter().flatten().filter_map(|d| first_at(d).map(|g| ((d - t).abs(), g))).min();
        let g = match best {
            Some((gap, g)) if gap <= SUBJECT_MERGE_WINDOW_MS => {
                merged[g].1.push(r);
                g
            }
            _ => {
                merged.push((root, vec![r]));
                merged.len() - 1
            }
        };
        at.insert((t, g));
    }

    let mut threads: Vec<Thread> = merged
        .into_iter()
        .map(|(root, mut members)| {
            members.sort_by_key(|&r| (rows[r].date_ms, rows[r].uid));
            Thread {
                id: ids.names[root].clone(),
                members: members
                    .into_iter()
                    .map(|r| Member { uid: rows[r].uid, date_ms: rows[r].date_ms, seen: rows[r].seen, flagged: rows[r].flagged })
                    .collect(),
            }
        })
        .collect();
    threads.sort_by(|a, b| (b.head().date_ms, b.head().uid).cmp(&(a.head().date_ms, a.head().uid)));
    threads
}
