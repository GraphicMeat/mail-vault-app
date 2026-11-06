//! Moving a Microsoft account between Microsoft Graph and IMAP in place,
//! keeping its vault.
//!
//! The two transports number the same mailbox differently. Graph has no
//! uids: MailVault mints them in the folder's uid ledger (`graph_ledger`).
//! IMAP uids are the server's. Both land in the same vault folder (Graph's
//! Inbox storage key is `INBOX`, like IMAP's), so after a switch a vault file
//! named `5:…` would be Graph's message 5 while the server's uid 5 is some
//! other message: the list shows the wrong mail, and backup counts the
//! server's 5 as stored and never fetches it.
//!
//! A switch retires the old numbering, per folder:
//!
//! - `forget_namespace` drops what the old transport kept beside the vault:
//!   the uid ledgers and header sidecars (`header_cache::sidecar_dir`) and the
//!   IMAP generation stamp (`maildir::GENERATION_FILE`). Both directions.
//! - To IMAP, `rekey_to_server` re-files every vault message by its
//!   Message-ID under the uid the server lists it at. A message the server
//!   does not list (deleted there, kept here) moves into the import range,
//!   which no server uid reaches, so it stays in the folder as local mail.
//!   Every move goes into the folder's rehome ledger first
//!   (`import_rehome::append_entries`), which the backup replays onto the
//!   mirror before its pre-sync, so the mirror cannot copy an old Graph
//!   number back into the vault.
//! - To Graph nothing moves: with the ledger gone, `graph_ledger::allocate`
//!   adopts each vault file by Message-ID and numbers new mail above every
//!   uid on disk, the same as a first Graph listing over an IMAP backup.
//!
//! Disk only, like `maildir::repair_generation`: the daemon holds the
//! mailbox lock, remaps custody and invalidates the registry around it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::Serialize;
use tracing::warn;

use crate::{graph_ledger, header_cache, import_rehome, maildir, message_store};

/// What `rekey_to_server` did to one folder.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Rekeyed {
    /// `(old, new)` for every file that changed uid: to its server uid, or
    /// into the import range.
    pub moved: Vec<(u32, u32)>,
    /// Files already at the uid the server lists them at.
    pub kept: u32,
    /// Of `moved`, the ones the server does not list: now local mail.
    pub to_local: u32,
    /// JMAP-format records turned back into Maildir files first.
    pub demoted: u32,
    pub errors: u32,
}

/// Drop the old transport's uid bookkeeping for `mailbox` of `account_id`:
/// the header sidecar directory (uid ledgers included, under the vault-wide
/// ledger lock, so an allocation in flight cannot write one back into it) and
/// the vault folder's generation stamp. The vault's messages stay.
pub fn forget_namespace(root: &Path, account_id: &str, mailbox: &str) -> Result<(), String> {
    let sidecar = header_cache::sidecar_dir(root, account_id, mailbox);
    graph_ledger::with_ledger_lock(&root.join("email_cache"), || match fs::remove_dir_all(&sidecar) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not clear {}: {e}", sidecar.display())),
    })??;
    let stamp = message_store::mailbox_dir(root, account_id, mailbox).join(maildir::GENERATION_FILE);
    match fs::remove_file(&stamp) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {}: {e}", stamp.display())),
    }
}

/// Re-file the folder at `mailbox_dir` under the server's uids. `server` maps
/// every normalized Message-ID the server lists in the folder to its uid; it
/// must cover the whole folder, since a miss reads as "not on the server".
/// `protected` holds uids of mail composed here, which keep their uid, as
/// does everything already in the import range. `uid_validity` is stamped on
/// the folder when given, so the generation repair has nothing left to do.
///
/// Every file below the import range ends at the server uid of its
/// Message-ID, or in the import range: none keeps a number the server gives
/// another message. Two files with one Message-ID: the one already at the
/// server's uid keeps it, else the lowest uid takes it and the other goes to
/// the import range.
pub fn rekey_to_server(
    mailbox_dir: &Path,
    server: &HashMap<String, u32>,
    protected: &HashSet<u32>,
    uid_validity: Option<u32>,
) -> Result<Rekeyed, String> {
    let mut report = Rekeyed::default();
    // Renames go by file name: a JMAP record becomes a file again first, as
    // the generation repair does.
    report.demoted = message_store::demote_records(mailbox_dir)? as u32;

    let files = message_store::maildir_paths_at(mailbox_dir);
    let mut uids: Vec<u32> =
        files.keys().copied().filter(|u| !message_store::is_import_uid(*u) && !protected.contains(u)).collect();
    uids.sort_unstable();
    let ids: HashMap<u32, Option<String>> = uids.iter().map(|u| (*u, maildir::read_message_id(&files[u]))).collect();
    let server_uid = |uid: &u32| ids[uid].as_ref().and_then(|m| server.get(m)).copied().filter(|s| !message_store::is_import_uid(*s));

    // Files already where the server has them claim their uid before any
    // other file can.
    let mut claimed: HashSet<u32> = protected.clone();
    let mut keep: HashSet<u32> = HashSet::new();
    for uid in &uids {
        if server_uid(uid) == Some(*uid) && claimed.insert(*uid) {
            keep.insert(*uid);
        }
    }
    report.kept = keep.len() as u32;

    // (from, final uid, staging uid, Message-ID): every mover leaves the
    // server range first, so a rename never lands on a file still to move.
    let mut next = import_rehome::next_free_import_uid(mailbox_dir)?;
    let mut take = || -> Result<u32, String> {
        let uid = next.ok_or("The import uid range is full")?;
        next = uid.checked_add(1);
        Ok(uid)
    };
    let mut moves: Vec<(u32, u32, u32, String)> = Vec::new();
    for uid in uids.iter().filter(|u| !keep.contains(u)) {
        let staging = take()?;
        let target = server_uid(uid).filter(|s| claimed.insert(*s)).unwrap_or(staging);
        moves.push((*uid, target, staging, ids[uid].clone().unwrap_or_default()));
    }

    // The ledger replays one entry at a time onto the mirror, whose files
    // still carry the old numbers: staged the same way, so no entry finds its
    // target held by a file a later entry moves away.
    let entries: Vec<(u32, Option<u32>, String)> = moves
        .iter()
        .map(|(from, _, staging, id)| (*from, Some(*staging), id.clone()))
        .chain(moves.iter().filter(|(_, to, staging, _)| to != staging).map(|(_, to, staging, id)| (*staging, Some(*to), id.clone())))
        .collect();
    import_rehome::append_entries(mailbox_dir, &entries)?;

    let cur = message_store::maildir_messages_dir(mailbox_dir);
    let name_of = |path: &Path| path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut staged: Vec<(u32, u32, u32, String)> = Vec::new();
    for (from, to, staging, _) in &moves {
        let name = name_of(&files[from]);
        let dst = maildir::with_uid(&name, *staging);
        match fs::rename(&files[from], cur.join(&dst)) {
            Ok(()) => {
                import_rehome::move_decrypted(mailbox_dir, *from, Some(*staging));
                staged.push((*from, *to, *staging, dst));
            }
            Err(e) => {
                warn!("transport_switch: {name} not moved: {e}");
                report.errors += 1;
            }
        }
    }
    let mut taken: HashSet<u32> = message_store::maildir_paths_at(mailbox_dir).into_keys().collect();
    for (from, to, staging, name) in staged {
        if to == staging {
            report.moved.push((from, to));
            report.to_local += 1;
            continue;
        }
        let dst = cur.join(maildir::with_uid(&name, to));
        // Free by construction (every mover left the server range above);
        // checked anyway, a rename must never replace another message.
        let landed = if dst.exists() || taken.contains(&to) {
            Err("taken".to_string())
        } else {
            fs::rename(cur.join(&name), &dst).map_err(|e| e.to_string())
        };
        match landed {
            Ok(()) => {
                import_rehome::move_decrypted(mailbox_dir, staging, Some(to));
                taken.insert(to);
                report.moved.push((from, to));
            }
            Err(e) => {
                warn!("transport_switch: {name} stays local, uid {to} not free: {e}");
                report.moved.push((from, staging));
                report.to_local += 1;
                report.errors += 1;
            }
        }
    }

    if let Some(validity) = uid_validity {
        maildir::write_generation(mailbox_dir, validity)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn eml(id: &str) -> String {
        format!("Message-ID: <{id}>\r\nSubject: {id}\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\n\r\nbody of {id}\r\n")
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-transport-switch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A vault folder as the store writes it: `<uid>:2,<flags>.eml` in its
    /// message directory.
    fn put(mailbox_dir: &Path, uid: u32, flags: &[&str], id: &str) {
        let cur = message_store::maildir_messages_dir(mailbox_dir);
        fs::create_dir_all(&cur).unwrap();
        let flags: Vec<String> = flags.iter().map(|f| f.to_string()).collect();
        fs::write(cur.join(message_store::entry_name(uid, &flags)), eml(id)).unwrap();
    }

    /// uid -> Message-ID of every file in the folder's message directory.
    fn held(mailbox_dir: &Path) -> HashMap<u32, String> {
        message_store::maildir_paths_at(mailbox_dir)
            .into_iter()
            .map(|(uid, path)| (uid, maildir::read_message_id(&path).unwrap()))
            .collect()
    }

    fn server(rows: &[(&str, u32)]) -> HashMap<String, u32> {
        rows.iter().map(|(id, uid)| (maildir::normalize_message_id(id), *uid)).collect()
    }

    /// The property a switch exists for: below the import range, the vault
    /// holds a uid only with the message the server lists at that uid.
    fn assert_no_collision(mailbox_dir: &Path, server: &HashMap<String, u32>) {
        for (uid, id) in held(mailbox_dir) {
            if message_store::is_import_uid(uid) {
                assert!(server.get(&id).is_none_or(|s| held(mailbox_dir).get(s) == Some(&id)), "{id} is local at {uid} though the server lists it");
                continue;
            }
            assert_eq!(server.get(&id), Some(&uid), "vault uid {uid} holds {id}, which the server does not list at {uid}");
        }
    }

    /// A Graph folder: four messages numbered by the ledger, 1..=4. The
    /// server numbers three of them differently and gives 4 to a message the
    /// vault does not have yet; `d` is gone from the server.
    fn graph_folder(mailbox_dir: &Path) -> HashMap<String, u32> {
        put(mailbox_dir, 1, &["seen"], "a@x");
        put(mailbox_dir, 2, &[], "b@x");
        put(mailbox_dir, 3, &["flagged"], "c@x");
        put(mailbox_dir, 4, &["seen"], "d@x");
        server(&[("a@x", 2), ("b@x", 3), ("c@x", 1), ("e@x", 4)])
    }

    #[test]
    fn a_switch_to_imap_files_every_message_under_the_server_uid() {
        let dir = scratch("to-imap");
        let mailbox = dir.join("INBOX");
        let listed = graph_folder(&mailbox);
        // Without the rekey the vault answers uid 1 with a, the server's 1 is c.
        assert_eq!(held(&mailbox)[&1], "a@x");

        let report = rekey_to_server(&mailbox, &listed, &HashSet::new(), Some(77)).unwrap();

        assert_no_collision(&mailbox, &listed);
        let now = held(&mailbox);
        assert_eq!((now[&1].as_str(), now[&2].as_str(), now[&3].as_str()), ("c@x", "a@x", "b@x"));
        assert!(!now.contains_key(&4), "the server's 4 is not here yet, so backup fetches it");
        let local: Vec<_> = now.iter().filter(|(u, _)| message_store::is_import_uid(**u)).map(|(_, id)| id.as_str()).collect();
        assert_eq!(local, vec!["d@x"], "mail gone from the server stays in the folder");
        assert_eq!((report.kept, report.to_local, report.errors, report.moved.len()), (0, 1, 0, 4));
        // Flags travel with the file.
        let flags_at = |uid| message_store::flags_in_name(&message_store::maildir_paths_at(&mailbox)[&uid].file_name().unwrap().to_string_lossy());
        let flags_of = |flag: &str| message_store::flags_in_name(&message_store::entry_name(1, &[flag.to_string()]));
        assert_eq!((flags_at(2), flags_at(1)), (flags_of("seen"), flags_of("flagged")));
        assert_eq!(maildir::read_generation(&mailbox), Some(77));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The backup mirror is keyed by uid too: its pre-sync copies a mirror
    /// file the vault lacks into the vault under the mirror's uid. The rehome
    /// ledger replay runs first and renumbers the mirror the same way.
    #[test]
    fn the_mirror_follows_the_switch_and_restores_no_old_number() {
        let dir = scratch("mirror");
        let mailbox = dir.join("vault").join("INBOX");
        let mirror_root = dir.join("mirror");
        let mirror = mirror_root.join("INBOX");
        let listed = graph_folder(&mailbox);
        graph_folder(&mirror);

        rekey_to_server(&mailbox, &listed, &HashSet::new(), Some(77)).unwrap();
        import_rehome::replay_at(&mailbox, &mirror_root, &mirror);

        assert_no_collision(&mailbox, &listed);
        let mirrored: HashMap<u32, String> = maildir::mirror_file_map(&maildir::mirror_cur_in(&mirror))
            .into_iter()
            .map(|(uid, path)| (uid, maildir::read_message_id(&path).unwrap()))
            .collect();
        for (uid, id) in &mirrored {
            if !message_store::is_import_uid(*uid) {
                assert_eq!(listed.get(id), Some(uid), "mirror uid {uid} still holds {id} under its Graph number");
            }
        }
        assert!(!mirrored.contains_key(&4), "the mirror would restore d over the server's 4");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_already_at_its_server_uid_keeps_it_and_a_twin_goes_local() {
        let dir = scratch("keepers");
        let mailbox = dir.join("INBOX");
        put(&mailbox, 1, &[], "b@x"); // the server has b at 2: a twin, lower uid
        put(&mailbox, 2, &[], "b@x"); // already where the server has it
        put(&mailbox, 3, &[], "a@x");
        let listed = server(&[("a@x", 1), ("b@x", 2)]);

        let report = rekey_to_server(&mailbox, &listed, &HashSet::new(), None).unwrap();

        assert_no_collision(&mailbox, &listed);
        assert_eq!(report.kept, 1);
        let now = held(&mailbox);
        assert_eq!((now[&1].as_str(), now[&2].as_str()), ("a@x", "b@x"));
        assert_eq!(now.iter().filter(|(u, id)| message_store::is_import_uid(**u) && id.as_str() == "b@x").count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_mail_and_imports_keep_their_uids() {
        let dir = scratch("local");
        let mailbox = dir.join("INBOX");
        put(&mailbox, 9, &[], "draft@x"); // composed here, never on a server
        let import = message_store::import_uid_floor() + 3;
        put(&mailbox, import, &[], "mbox@x");
        put(&mailbox, 1, &[], "a@x");
        let listed = server(&[("a@x", 1), ("draft@x", 9)]);

        let report = rekey_to_server(&mailbox, &listed, &HashSet::from([9]), None).unwrap();

        let now = held(&mailbox);
        assert_eq!((now[&9].as_str(), now[&import].as_str(), now[&1].as_str()), ("draft@x", "mbox@x", "a@x"));
        assert_eq!((report.kept, report.moved.len()), (1, 0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_rekey_against_the_same_listing_moves_nothing() {
        let dir = scratch("again");
        let mailbox = dir.join("INBOX");
        let listed = graph_folder(&mailbox);
        rekey_to_server(&mailbox, &listed, &HashSet::new(), None).unwrap();
        let before = held(&mailbox);
        let report = rekey_to_server(&mailbox, &listed, &HashSet::new(), None).unwrap();
        assert_eq!((report.moved.len(), report.kept), (0, 3));
        assert_eq!(held(&mailbox), before);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Back to Graph: the ledger and the stamp go, and a first Graph listing
    /// adopts each vault file by Message-ID and numbers new mail above all of
    /// them, so no Graph uid lands on a file of another message.
    #[test]
    fn forgetting_the_namespace_lets_graph_adopt_the_imap_numbered_vault() {
        let root = scratch("to-graph");
        let mailbox = message_store::mailbox_dir(&root, "acc", "INBOX");
        put(&mailbox, 7, &[], "a@x");
        put(&mailbox, 9, &[], "b@x");
        maildir::write_generation(&mailbox, 5).unwrap();
        let sidecar = header_cache::sidecar_dir(&root, "acc", "INBOX");
        fs::create_dir_all(&sidecar).unwrap();
        // A ledger left from an earlier Graph spell names 7 as another message.
        fs::write(sidecar.join(graph_ledger::LEDGER_FILE), r#"{"7":"old-graph-id"}"#).unwrap();
        fs::write(sidecar.join("headers.json"), "{}").unwrap();

        forget_namespace(&root, "acc", "INBOX").unwrap();

        assert!(!sidecar.exists(), "ledger and header sidecars are gone");
        assert_eq!(maildir::read_generation(&mailbox), None);
        let ledger = graph_ledger::ledger_path(&sidecar, false);
        let listed = vec![
            ("g-b".to_string(), Some("<b@x>".to_string())),
            ("g-new".to_string(), Some("<n@x>".to_string())),
            ("g-a".to_string(), Some("<a@x>".to_string())),
        ];
        let uids = graph_ledger::allocate_in(&ledger, &root, "acc", "INBOX", &listed).unwrap();
        assert_eq!(uids, vec![9, 10, 7], "a and b keep their files' uids, new mail goes above them");
        let _ = fs::remove_dir_all(&root);
    }

    /// Graph -> IMAP -> Graph -> IMAP: each leg leaves no uid naming two messages.
    #[test]
    fn a_round_trip_never_collides() {
        let root = scratch("round-trip");
        let mailbox = message_store::mailbox_dir(&root, "acc", "INBOX");
        let listed = graph_folder(&mailbox);

        forget_namespace(&root, "acc", "INBOX").unwrap();
        rekey_to_server(&mailbox, &listed, &HashSet::new(), Some(1)).unwrap();
        assert_no_collision(&mailbox, &listed);

        forget_namespace(&root, "acc", "INBOX").unwrap();
        let ledger = graph_ledger::ledger_path(&header_cache::sidecar_dir(&root, "acc", "INBOX"), false);
        let graph_rows: Vec<(String, Option<String>)> =
            ["a@x", "b@x", "c@x", "e@x"].iter().map(|id| (format!("g-{id}"), Some(format!("<{id}>")))).collect();
        let uids = graph_ledger::allocate_in(&ledger, &root, "acc", "INBOX", &graph_rows).unwrap();
        let now = held(&mailbox);
        for ((_, id), uid) in graph_rows.iter().zip(&uids) {
            let id = maildir::normalize_message_id(id.as_deref().unwrap().trim_matches(|c| c == '<' || c == '>'));
            assert!(now.get(uid).is_none_or(|held| *held == id), "Graph uid {uid} for {id} names the file of {:?}", now.get(uid));
        }

        forget_namespace(&root, "acc", "INBOX").unwrap();
        rekey_to_server(&mailbox, &listed, &HashSet::new(), Some(1)).unwrap();
        assert_no_collision(&mailbox, &listed);
        let _ = fs::remove_dir_all(&root);
    }
}
