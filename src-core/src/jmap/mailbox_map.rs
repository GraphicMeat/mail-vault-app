//! JMAP mailboxes as the folder list the app keeps for every account.
//!
//! The list is flat, like `imap::list_mailboxes`: the frontend derives the
//! tree from `path` + `delimiter` at render time and evicts a nested list as a
//! stale cache (`mailboxTree.js` `isMailboxTreeComplete`); backup, migration
//! and the vault-dir mapping walk it flat too.

use super::types::JMailbox;
use crate::imap::MailboxInfo;
use std::collections::{BTreeMap, HashMap, HashSet};

pub const DELIMITER: &str = "/";
/// Stands in for a `/` inside one mailbox name, so it never reads as the delimiter.
const SLASH_STANDIN: &str = "\u{2215}";

fn is_inbox(m: &JMailbox) -> bool {
    m.role.as_deref().is_some_and(|r| r.eq_ignore_ascii_case("inbox"))
}

/// The IMAP special-use flag for a JMAP role (RFC 8621 §2, RFC 6154).
pub fn role_special_use(role: &str) -> Option<&'static str> {
    match role.to_ascii_lowercase().as_str() {
        "inbox" => Some("\\Inbox"),
        "sent" => Some("\\Sent"),
        "drafts" => Some("\\Drafts"),
        "trash" => Some("\\Trash"),
        "junk" => Some("\\Junk"),
        "archive" => Some("\\Archive"),
        "all" => Some("\\All"),
        _ => None,
    }
}

/// The flat folder list, parents before children, and path -> mailbox id.
///
/// - The inbox role's path is "INBOX", so every "INBOX" default in the app holds.
/// - Every other path is the names up the `parent_id` chain joined by "/";
///   a "/" inside a name becomes U+2215 in the path (`name` keeps the real one).
/// - Siblings sort inbox first, then by `sort_order`, name and id.
/// - A mailbox whose parent is missing (or in a cycle) is placed at the top.
/// - A path already taken (only possible through the U+2215 stand-in) keeps
///   its first mailbox; the later one is left out, its children still listed.
pub fn mailbox_tree(list: &[JMailbox]) -> (Vec<MailboxInfo>, BTreeMap<String, String>) {
    let known: HashSet<&str> = list.iter().map(|m| m.id.as_str()).collect();
    let mut children: HashMap<Option<&str>, Vec<&JMailbox>> = HashMap::new();
    for m in list {
        let parent = m.parent_id.as_deref().filter(|p| known.contains(p) && *p != m.id);
        children.entry(parent).or_default().push(m);
    }
    for siblings in children.values_mut() {
        siblings.sort_by(|a, b| (!is_inbox(a), a.sort_order, &a.name, &a.id).cmp(&(!is_inbox(b), b.sort_order, &b.name, &b.id)));
    }
    let mut walk = Walk { children: &children, visited: HashSet::new(), out: Vec::new(), ids: BTreeMap::new() };
    for root in children.get(&None).cloned().unwrap_or_default() {
        walk.visit(root, None);
    }
    // Whatever no root reaches sits in a parent cycle: list it at the top.
    let mut rest: Vec<&JMailbox> = list.iter().filter(|m| !walk.visited.contains(m.id.as_str())).collect();
    rest.sort_by(|a, b| (a.sort_order, &a.name, &a.id).cmp(&(b.sort_order, &b.name, &b.id)));
    for m in rest {
        walk.visit(m, None);
    }
    (walk.out, walk.ids)
}

struct Walk<'a> {
    children: &'a HashMap<Option<&'a str>, Vec<&'a JMailbox>>,
    visited: HashSet<&'a str>,
    out: Vec<MailboxInfo>,
    ids: BTreeMap<String, String>,
}

impl<'a> Walk<'a> {
    fn visit(&mut self, m: &'a JMailbox, parent_path: Option<&str>) {
        if !self.visited.insert(m.id.as_str()) {
            return;
        }
        let path = if is_inbox(m) && !self.ids.contains_key("INBOX") {
            "INBOX".to_string()
        } else {
            let segment = m.name.replace('/', SLASH_STANDIN);
            match parent_path {
                Some(p) => format!("{p}{DELIMITER}{segment}"),
                None => segment,
            }
        };
        if !self.ids.contains_key(&path) {
            self.ids.insert(path.clone(), m.id.clone());
            self.out.push(MailboxInfo {
                name: m.name.clone(),
                path: path.clone(),
                special_use: m.role.as_deref().and_then(role_special_use).map(str::to_string),
                special_use_guessed: false,
                flags: Vec::new(),
                delimiter: Some(DELIMITER.to_string()),
                noselect: false,
                children: Vec::new(),
            });
        }
        let kids = self.children.get(&Some(m.id.as_str())).cloned().unwrap_or_default();
        for child in kids {
            self.visit(child, Some(&path));
        }
    }
}
