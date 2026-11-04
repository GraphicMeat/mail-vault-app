//! Moving a folder and its subfolders, in one account or to another: the pure
//! half. What gets created where (`plan`), whether the copies are trusted
//! enough to retire the source (`verify`), where the source goes under Trash
//! (`trash_target`), and the job's journal. The daemon's job does the I/O.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::imap::MailboxInfo;

/// What a side speaks. IMAP names are modified UTF-7, JMAP and Graph names
/// plain UTF-8.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Imap,
    Jmap,
    Graph,
}

/// Where the folder goes: under the picked folder, or to the top level.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Target {
    Into(String),
    #[default]
    TopLevel,
}

/// One folder of the move. A `container` (noselect) is created and copies
/// nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanItem {
    #[serde(rename = "src")]
    pub src_path: String,
    #[serde(rename = "dest")]
    pub dest_path: String,
    pub container: bool,
}

/// The root first, deepest folders last. `fast_rename`: the destination path
/// of a same-account move the server can do with one rename.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Plan {
    pub items: Vec<PlanItem>,
    pub fast_rename: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanError {
    /// The source root or the picked destination is not in its listing.
    NotFound,
    /// The root or a subfolder is INBOX or a special-use folder.
    Reserved,
    /// The destination is the source, inside it, or where it already is.
    IntoItself,
    /// The destination has no hierarchy delimiter and the move needs one.
    NoHierarchy,
    /// Graph lists top-level folders only: no subfolders either side.
    GraphSubfolders,
    /// A name that holds the destination's delimiter, or none at all.
    Name,
}

impl PlanError {
    pub fn code(self) -> &'static str {
        match self {
            PlanError::NotFound => "E_FOLDER_MOVE_NOT_FOUND",
            PlanError::Reserved => "E_FOLDER_MOVE_RESERVED",
            PlanError::IntoItself => "E_FOLDER_MOVE_INTO_ITSELF",
            PlanError::NoHierarchy => "E_FOLDER_MOVE_NO_HIERARCHY",
            PlanError::GraphSubfolders => "E_FOLDER_MOVE_GRAPH_SUBFOLDERS",
            PlanError::Name => "E_FOLDER_MOVE_NAME",
        }
    }
}

/// A folder the move never takes as its source: INBOX in any case, any
/// special use (a guessed one too, as the sidebar menu locks it), any Graph
/// well-known folder. Any of them is fine as a destination.
pub fn is_reserved(path: &str, special_use: Option<&str>, well_known: Option<&str>) -> bool {
    path.eq_ignore_ascii_case("INBOX")
        || special_use.is_some_and(|s| !s.is_empty())
        || well_known.is_some_and(|w| !w.is_empty())
}

/// One side of a path mapping: its delimiter (`None` for NIL) and its kind.
#[derive(Clone, Copy, Debug)]
pub struct Side<'a> {
    pub delimiter: Option<&'a str>,
    pub kind: Kind,
}

/// The destination path of `src_path`, a folder at or under `root`: the
/// root's leaf under `dest_parent` (the top level when `None`), then the rest
/// of the path. Mapped segment by segment, each re-encoded when one side is
/// IMAP and the other is not; a segment that holds the destination's
/// delimiter is refused, never split.
pub fn map_path(src_path: &str, root: &str, src: Side, dest_parent: Option<&str>, dest: Side) -> Result<String, PlanError> {
    let leaf = match src.delimiter {
        Some(d) => root.rsplit(d).next().unwrap_or(root),
        None => root,
    };
    let mut segments = vec![leaf];
    if src_path != root {
        let d = src.delimiter.ok_or(PlanError::NotFound)?;
        let rest = src_path.strip_prefix(root).and_then(|r| r.strip_prefix(d)).ok_or(PlanError::NotFound)?;
        segments.extend(rest.split(d));
    }
    if dest.delimiter.is_none() && (segments.len() > 1 || dest_parent.is_some()) {
        return Err(PlanError::NoHierarchy);
    }
    let mut mapped = Vec::with_capacity(segments.len());
    for segment in segments {
        let name = match (src.kind == Kind::Imap, dest.kind == Kind::Imap) {
            (true, false) => crate::imap::utf7_decode(segment).ok_or(PlanError::Name)?,
            (false, true) => crate::imap::utf7_encode(segment),
            _ => segment.to_string(),
        };
        if name.is_empty() || dest.delimiter.is_some_and(|d| name.contains(d)) {
            return Err(PlanError::Name);
        }
        mapped.push(name);
    }
    let d = dest.delimiter.unwrap_or_default();
    let tail = mapped.join(d);
    Ok(match dest_parent {
        Some(parent) => format!("{parent}{d}{tail}"),
        None => tail,
    })
}

fn flatten<'a>(tree: &'a [MailboxInfo], out: &mut Vec<&'a MailboxInfo>) {
    for m in tree {
        out.push(m);
        flatten(&m.children, out);
    }
}

fn delimiter_of(m: &MailboxInfo) -> Option<&str> {
    m.delimiter.as_deref().filter(|d| !d.is_empty())
}

/// What moving `root` (with every folder under it) to `target` creates.
/// `source_tree` and `dest_tree` are the two accounts' listings (the same
/// one when `same_account`). Graph trees list top-level folders only, so a
/// Graph folder with children says so with `\HasChildren` in its flags.
pub fn plan(
    source_tree: &[MailboxInfo],
    root: &str,
    dest_tree: &[MailboxInfo],
    target: &Target,
    same_account: bool,
    src_kind: Kind,
    dest_kind: Kind,
) -> Result<Plan, PlanError> {
    let (mut src_flat, mut dest_flat) = (Vec::new(), Vec::new());
    flatten(source_tree, &mut src_flat);
    flatten(dest_tree, &mut dest_flat);
    let root_node = src_flat.iter().find(|m| m.path == root).ok_or(PlanError::NotFound)?;
    // Graph lists top-level folders only: a display name is one segment,
    // whatever `/` it holds.
    let src_delim = if src_kind == Kind::Graph { None } else { delimiter_of(root_node) };
    let under = |path: &str| src_delim.is_some_and(|d| path.strip_prefix(root).is_some_and(|r| r.starts_with(d)));
    let mut subtree: Vec<&MailboxInfo> = src_flat.iter().copied().filter(|m| m.path == root || under(&m.path)).collect();
    let depth = |m: &&MailboxInfo| src_delim.map_or(0, |d| m.path.matches(d).count());
    subtree.sort_by_key(depth);

    if subtree.iter().any(|m| is_reserved(&m.path, m.special_use.as_deref(), None)) {
        return Err(PlanError::Reserved);
    }
    let has_children = subtree.len() > 1 || root_node.flags.iter().any(|f| f.eq_ignore_ascii_case("\\HasChildren"));
    if (src_kind == Kind::Graph || dest_kind == Kind::Graph) && has_children {
        return Err(PlanError::GraphSubfolders);
    }

    let (dest_parent, dest_delim) = match target {
        Target::Into(parent) => {
            if same_account && (parent == root || under(parent)) {
                return Err(PlanError::IntoItself);
            }
            let node = dest_flat.iter().find(|m| &m.path == parent).ok_or(PlanError::NotFound)?;
            (Some(parent.as_str()), delimiter_of(node))
        }
        Target::TopLevel => (None, dest_flat.iter().find_map(|m| delimiter_of(m)).or((dest_kind != Kind::Imap).then_some("/"))),
    };
    let src = Side { delimiter: src_delim, kind: src_kind };
    let dest = Side { delimiter: dest_delim, kind: dest_kind };
    let items = subtree
        .iter()
        .map(|m| {
            Ok(PlanItem { src_path: m.path.clone(), dest_path: map_path(&m.path, root, src, dest_parent, dest)?, container: m.noselect })
        })
        .collect::<Result<Vec<_>, PlanError>>()?;
    let dest_root = &items[0].dest_path;
    if same_account && dest_root == root {
        return Err(PlanError::IntoItself);
    }
    let fast_rename = (same_account && !dest_flat.iter().any(|m| &m.path == dest_root)).then(|| dest_root.clone());
    Ok(Plan { items, fast_rename })
}

/// What the copy engine did with one source message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Written; `acked` when the destination named what it wrote (APPENDUID,
    /// a JMAP or Graph id).
    Copied { acked: bool },
    /// The destination already held it: nothing written.
    Present,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub key: u32,
    pub message_id: Option<String>,
    pub fingerprint: u64,
    pub outcome: Outcome,
}

/// The source keys of one folder, by what the destination proves.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    pub verified: Vec<u32>,
    pub missing: Vec<u32>,
    pub unconfirmed: Vec<u32>,
    pub failed: Vec<u32>,
    pub retire_ok: bool,
}

/// Judge one folder's copies against the destination's Message-IDs listed
/// AFTER the copy (`Err` when that listing failed: never read as empty). A
/// message with a Message-ID is verified only when the listing has it; one
/// without is verified when it was present already or its write was acked,
/// and unconfirmed otherwise. The source may be retired only when every
/// message is verified.
pub fn verify(records: &[Record], dest_ids_after: Result<&HashSet<String>, &str>) -> Verdict {
    let listed: Option<HashSet<String>> =
        dest_ids_after.ok().map(|ids| ids.iter().filter_map(|id| crate::maildir::message_id_value_key(id)).collect());
    let mut v = Verdict::default();
    for r in records {
        let id = r.message_id.as_deref().and_then(crate::maildir::message_id_value_key);
        let bucket = match (r.outcome, id, &listed) {
            (Outcome::Failed, _, _) => &mut v.failed,
            (_, Some(id), Some(listed)) if listed.contains(&id) => &mut v.verified,
            (_, Some(_), Some(_)) => &mut v.missing,
            (_, Some(_), None) => &mut v.unconfirmed,
            (Outcome::Present | Outcome::Copied { acked: true }, None, _) => &mut v.verified,
            (Outcome::Copied { acked: false }, None, _) => &mut v.unconfirmed,
        };
        bucket.push(r.key);
    }
    v.retire_ok = listed.is_some() && v.missing.is_empty() && v.unconfirmed.is_empty() && v.failed.is_empty();
    v
}

/// Where a retired source root goes: `<trash><d><leaf>`, or with ` (2)`,
/// ` (3)`... when the account already has that path.
pub fn trash_target(existing: &HashSet<String>, trash: &str, leaf: &str, d: &str) -> String {
    let base = format!("{trash}{d}{leaf}");
    if !existing.contains(&base) {
        return base;
    }
    (2..).map(|n| format!("{base} ({n})")).find(|p| !existing.contains(p)).expect("an unused name")
}

/// A message's content as 8 bytes of its SHA-256, for mail with no
/// Message-ID: stable across builds, as the mbox upload's tail keys it.
pub fn fingerprint(raw: &[u8]) -> u64 {
    use sha2::{Digest, Sha256};
    u64::from_be_bytes(Sha256::digest(raw)[..8].try_into().expect("8 bytes"))
}

/// The journal key of a message the job handled: its bracketed Message-ID,
/// else its fingerprint in hex.
pub fn done_key(message_id: Option<&str>, fingerprint: u64) -> String {
    message_id.and_then(crate::maildir::message_id_value_key).unwrap_or_else(|| format!("{fingerprint:016x}"))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderPhase {
    #[default]
    Pending,
    Copying,
    Verified,
    Unverified,
    Retired,
}

/// One plan item's progress, at the same index as in `Journal.plan.items`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JournalFolder {
    pub phase: FolderPhase,
    pub total: u32,
    pub copied: u32,
    pub skipped: u32,
    pub failed: u32,
    /// `done_key`s of the messages already copied or found present.
    pub done: Vec<String>,
}

/// What a move job persists, so a stopped one resumes where it was.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Journal {
    pub job_id: String,
    pub source_account_id: String,
    pub dest_account_id: String,
    pub root: String,
    pub target: Target,
    pub plan: Plan,
    pub folders: Vec<JournalFolder>,
}

/// The plan items a resumed job still has to work on: every one not yet
/// verified or retired.
pub fn resume_items(journal: &Journal) -> Vec<usize> {
    (0..journal.plan.items.len())
        .filter(|&i| !matches!(journal.folders.get(i).map(|f| f.phase), Some(FolderPhase::Verified | FolderPhase::Retired)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn rec(key: u32, message_id: Option<&str>, outcome: Outcome) -> Record {
        Record { key, message_id: message_id.map(str::to_string), fingerprint: key as u64, outcome }
    }

    #[test]
    fn inbox_any_case_and_every_special_use_are_reserved() {
        for inbox in ["INBOX", "inbox", "Inbox"] {
            assert!(is_reserved(inbox, None, None), "{inbox}");
        }
        for su in ["\\Sent", "\\Trash", "\\Drafts", "\\Junk", "\\Archive", "\\All", "\\Flagged"] {
            assert!(is_reserved("Whatever", Some(su), None), "{su}");
        }
        assert!(!is_reserved("Clients", None, None));
        assert!(!is_reserved("INBOX/Clients", None, None), "a folder under INBOX is a custom folder");
    }

    #[test]
    fn graph_well_known_is_reserved() {
        assert!(is_reserved("Posteingang", None, Some("inbox")));
        assert!(is_reserved("Archiv", None, Some("archive")));
        assert!(!is_reserved("Clients", None, None));
    }

    #[test]
    fn verify_needs_every_message_id_listed_after_copy() {
        let records = [rec(1, Some("<a@x>"), Outcome::Copied { acked: true }), rec(2, Some("b@x"), Outcome::Present)];
        let v = verify(&records, Ok(&set(&["<a@x>"])));
        assert_eq!((v.verified, v.missing.clone(), v.retire_ok), (vec![1], vec![2], false));

        let v = verify(&records, Ok(&set(&["< a@x >", "<b@x>"])));
        assert_eq!((v.verified, v.retire_ok), (vec![1, 2], true), "both sides compared normalized");
    }

    #[test]
    fn verify_accepts_acked_writes_without_message_id() {
        let records = [rec(1, None, Outcome::Copied { acked: true }), rec(2, None, Outcome::Present)];
        let v = verify(&records, Ok(&HashSet::new()));
        assert_eq!((v.verified, v.retire_ok), (vec![1, 2], true));
    }

    #[test]
    fn verify_unconfirmed_without_message_id_keeps_source() {
        let records = [rec(1, Some("<a@x>"), Outcome::Copied { acked: false }), rec(2, None, Outcome::Copied { acked: false })];
        let v = verify(&records, Ok(&set(&["<a@x>"])));
        assert_eq!((v.verified, v.unconfirmed, v.retire_ok), (vec![1], vec![2], false));

        let v = verify(&[rec(3, Some("<c@x>"), Outcome::Failed)], Ok(&set(&["<c@x>"])));
        assert_eq!((v.failed, v.retire_ok), (vec![3], false), "a failed message keeps the source");
    }

    #[test]
    fn verify_failed_listing_is_not_empty() {
        let records = [rec(1, Some("<a@x>"), Outcome::Copied { acked: true }), rec(2, None, Outcome::Copied { acked: true })];
        let v = verify(&records, Err("listing failed"));
        assert_eq!((v.missing, v.unconfirmed, v.verified, v.retire_ok), (vec![], vec![1], vec![2], false));
        let v = verify(&[], Err("listing failed"));
        assert!(!v.retire_ok, "no listing, no retire, even with nothing to check");
    }

    #[test]
    fn trash_target_suffixes_on_collision() {
        assert_eq!(trash_target(&set(&[]), "Trash", "Clients", "/"), "Trash/Clients");
        assert_eq!(trash_target(&set(&["Trash/Clients"]), "Trash", "Clients", "/"), "Trash/Clients (2)");
        assert_eq!(trash_target(&set(&["INBOX.Trash.Clients", "INBOX.Trash.Clients (2)"]), "INBOX.Trash", "Clients", "."), "INBOX.Trash.Clients (3)");
    }

    #[test]
    fn journal_resume_skips_verified_and_retired_folders() {
        let item = |s: &str| PlanItem { src_path: s.into(), dest_path: format!("Archive/{s}"), container: false };
        let phase = |phase| JournalFolder { phase, ..Default::default() };
        let journal = Journal {
            job_id: "j1".into(),
            target: Target::Into("Archive".into()),
            plan: Plan { items: vec![item("A"), item("A/1"), item("A/2"), item("A/3"), item("A/4")], fast_rename: None },
            folders: vec![phase(FolderPhase::Verified), phase(FolderPhase::Copying), phase(FolderPhase::Retired), phase(FolderPhase::Unverified)],
            ..Default::default()
        };
        assert_eq!(resume_items(&journal), vec![1, 3, 4], "a folder the journal never reached is pending");

        let text = serde_json::to_string(&journal).unwrap();
        assert!(text.contains("\"jobId\":\"j1\"") && text.contains("\"target\":{\"into\":\"Archive\"}") && text.contains("\"phase\":\"copying\""), "{text}");
        assert_eq!(serde_json::from_str::<Journal>(&text).unwrap(), journal);
        let old: Journal = serde_json::from_str(r#"{"jobId":"j0","folders":[{"phase":"verified"}]}"#).unwrap();
        assert_eq!((old.target, old.folders[0].done.len()), (Target::TopLevel, 0), "missing fields default");
    }

    #[test]
    fn done_key_is_the_bracketed_message_id_or_the_fingerprint() {
        assert_eq!(done_key(Some("a@x"), 7), "<a@x>");
        assert_eq!(done_key(None, 0xab), "00000000000000ab");
        assert_eq!(fingerprint(b"x"), fingerprint(b"x"));
        assert_ne!(fingerprint(b"x"), fingerprint(b"y"));
    }

    #[test]
    fn plan_errors_carry_their_codes() {
        assert_eq!(PlanError::IntoItself.code(), "E_FOLDER_MOVE_INTO_ITSELF");
        assert_eq!(PlanError::Name.code(), "E_FOLDER_MOVE_NAME");
    }
}
