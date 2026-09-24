//! Saved views: a named, stored set of filters over the indexed mail.
//!
//! A view moves nothing and copies nothing. It is a definition here plus an
//! evaluation against the search index, so the same message can appear in any
//! number of views and still live in exactly one folder.
//!
//! Definitions live in `app.db` with the tags and custom fields, never in the
//! rebuildable search index.

use super::db::in_txn;
use rusqlite::{params, Connection, OptionalExtension};

/// What a view filters on and how it presents what it finds. Serialized whole
/// into `views.def_json`, so adding a field never needs a schema migration —
/// `#[serde(default)]` on the struct makes an older row readable.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewDef {
    /// Account ids, or empty for every account.
    pub accounts: Vec<String>,
    /// Server mailbox paths, or empty for every mailbox.
    pub mailboxes: Vec<String>,
    /// Mailboxes to leave out by server path — only ever what a person picked
    /// themselves, never a folder MailVault guessed the name of.
    pub mailboxes_excluded: Vec<String>,
    /// Mailboxes to leave out by IMAP special-use attribute (`\\Trash`,
    /// `\\Junk`, `\\Archive`). A folder's *name* is a per-mailbox word —
    /// a German account's trash is `Papierkorb` — so a view that means "not
    /// the bin" has to say it this way. The app resolves these to server paths
    /// per account when it runs the view.
    pub exclude_special: Vec<String>,
    pub query: String,
    pub sender: Option<String>,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    /// "The last N days", resolved when the view runs rather than when it was
    /// saved: a saved absolute range would rot the day after it was made.
    pub within_days: Option<i64>,
    pub has_attachments: bool,
    pub unread: Option<bool>,
    pub starred: Option<bool>,
    pub answered: Option<bool>,
    /// Keep only messages whose address headers carry the account's own
    /// address. The index merges From, To, Cc, Bcc and Reply-To into one
    /// column, so this reads as "involves me", and on its own it would also
    /// match the mail the account sent — `not_from_me` is what excludes that.
    pub to_me: bool,
    /// Drop messages the account itself sent.
    pub not_from_me: bool,
    /// Tag ids a message must carry, all of them.
    pub tags: Vec<String>,
    /// Custom field conditions a message must satisfy, all of them. Combined
    /// with `tags` as an AND: a view narrows, it never piles up.
    pub fields: Vec<crate::app_db::fields::FieldFilter>,
    /// `null`, `sender`, `date`, `tag` or `field:<id>`.
    pub group: Option<String>,
    /// `date`, `sender` or `subject`.
    pub sort: Option<String>,
    /// `desc` or `asc`.
    pub direction: Option<String>,
    pub columns: Vec<String>,
    /// Open this view with the month timeline beside the list. Presentation
    /// only — the list toolbar's own toggle can still override it for the
    /// session, and neither reaches `request_for`, so it never narrows what
    /// the view finds.
    pub show_timeline: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub position: i64,
    /// The starter this row came from, or `None` for one the user made.
    pub builtin: Option<String>,
    pub def: ViewDef,
}

/// The views MailVault ships with. A person may edit or delete any of them;
/// they are seeded once, not re-asserted on every start.
pub fn starters() -> Vec<View> {
    // No name: the app translates a starter by its `builtin` id, and only a
    // name the user typed is ever stored.
    let base = |id: &str, _name: &str, icon: &str, position: i64, def: ViewDef| View {
        id: format!("builtin-{id}"),
        name: String::new(),
        icon: icon.into(),
        position,
        builtin: Some(id.into()),
        def,
    };
    vec![
        base(
            "needs-reply",
            "Needs reply",
            "reply",
            0,
            ViewDef {
                // Maildir's replied flag is the honest signal: MailVault does
                // not index In-Reply-To, so nothing here can follow a thread.
                answered: Some(false),
                to_me: true,
                not_from_me: true,
                within_days: Some(30),
                exclude_special: vec!["\\Trash".into(), "\\Junk".into(), "\\Archive".into()],
                sort: Some("date".into()),
                ..ViewDef::default()
            },
        ),
        base("starred", "Starred", "star", 1, ViewDef { starred: Some(true), ..ViewDef::default() }),
        base("attachments", "Attachments", "paperclip", 2, ViewDef { has_attachments: true, ..ViewDef::default() }),
    ]
}

pub fn list(conn: &Connection) -> Result<Vec<View>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, icon, position, builtin, def_json FROM views ORDER BY position, name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| row_to_view(r)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<View>, String> {
    conn.query_row("SELECT id, name, icon, position, builtin, def_json FROM views WHERE id = ?1", [id], |r| row_to_view(r))
        .optional()
        .map_err(|e| e.to_string())
}

/// Insert or replace one view, keeping its position when it already has one.
pub fn save(conn: &Connection, view: &View) -> Result<View, String> {
    let name = view.name.trim();
    // A starter carries no name of its own until someone types one.
    if name.is_empty() && view.builtin.is_none() {
        return Err("a view needs a name".into());
    }
    in_txn(conn, || {
        let existing: Option<i64> = conn
            .query_row("SELECT position FROM views WHERE id = ?1", [&view.id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let position = match existing {
            Some(position) => position,
            None => conn
                .query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM views", [], |r| r.get(0))
                .map_err(|e| e.to_string())?,
        };
        let def_json = serde_json::to_string(&view.def).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO views(id, name, icon, position, builtin, def_json) VALUES (?1,?2,?3,?4,?5,?6)",
            params![view.id, name, view.icon, position, view.builtin, def_json],
        )
        .map_err(|e| e.to_string())?;
        Ok(View { name: name.to_string(), position, ..view.clone() })
    })
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM views WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string())
}

pub fn reorder(conn: &Connection, ids: &[String]) -> Result<(), String> {
    in_txn(conn, || {
        let current = list(conn)?;
        if ids.len() != current.len() || current.iter().any(|view| !ids.contains(&view.id)) {
            return Err("view order must include every view once".into());
        }
        for (position, id) in ids.iter().enumerate() {
            conn.execute("UPDATE views SET position = ?1 WHERE id = ?2", params![position as i64, id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// Seed the starters on the first run only. Returns how many were written.
///
/// Guarded by a `meta` key rather than by "is the table empty", so a starter
/// someone deleted stays deleted instead of reappearing at every launch.
pub fn ensure_starters(conn: &Connection) -> Result<usize, String> {
    if super::db::meta_get(conn, SEEDED).is_some() {
        return Ok(0);
    }
    let mut written = 0;
    in_txn(conn, || {
        for view in starters() {
            save(conn, &view)?;
            written += 1;
        }
        super::db::meta_set(conn, SEEDED, "1")
    })?;
    Ok(written)
}

const SEEDED: &str = "views_seeded";

fn row_to_view(r: &rusqlite::Row<'_>) -> rusqlite::Result<View> {
    let def_json: String = r.get(5)?;
    Ok(View {
        id: r.get(0)?,
        name: r.get(1)?,
        icon: r.get(2)?,
        position: r.get(3)?,
        builtin: r.get(4)?,
        // A definition this build cannot read is not a reason to lose the
        // view: an unreadable one falls back to the default, which shows
        // everything rather than nothing.
        def: serde_json::from_str(&def_json).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::db;

    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-views-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn view(id: &str, name: &str) -> View {
        View {
            id: id.into(),
            name: name.into(),
            icon: "tag".into(),
            position: 0,
            builtin: None,
            def: ViewDef { query: "invoice".into(), has_attachments: true, ..ViewDef::default() },
        }
    }

    #[test]
    fn a_saved_view_reads_back_whole() {
        let c = conn();
        save(&c, &view("v1", "Receipts")).unwrap();
        let got = get(&c, "v1").unwrap().expect("saved");
        assert_eq!(got.name, "Receipts");
        assert_eq!(got.def.query, "invoice");
        assert!(got.def.has_attachments);
    }

    #[test]
    fn show_timeline_round_trips_and_defaults_to_false_on_an_older_row() {
        let c = conn();
        save(&c, &View { def: ViewDef { show_timeline: true, ..view("v1", "Receipts").def }, ..view("v1", "Receipts") }).unwrap();
        let got = get(&c, "v1").unwrap().expect("saved");
        assert!(got.def.show_timeline);

        // A row saved before the field existed has no `showTimeline` key at
        // all; `#[serde(default)]` must read that back as false, not fail.
        let c2 = conn();
        c2.execute(
            "INSERT INTO views(id, name, icon, position, builtin, def_json) VALUES ('v2','Old','tag',0,NULL,'{}')",
            [],
        ).unwrap();
        let old = get(&c2, "v2").unwrap().expect("saved");
        assert!(!old.def.show_timeline);
    }

    #[test]
    fn saving_the_same_id_twice_edits_rather_than_duplicates() {
        let c = conn();
        save(&c, &view("v1", "Receipts")).unwrap();
        save(&c, &View { name: "Invoices".into(), ..view("v1", "unused") }).unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Invoices");
    }

    #[test]
    fn a_new_view_lands_after_the_ones_already_there() {
        let c = conn();
        save(&c, &view("v1", "One")).unwrap();
        let second = save(&c, &view("v2", "Two")).unwrap();
        assert_eq!(second.position, 1);
        assert_eq!(list(&c).unwrap().iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["v1", "v2"]);
    }

    #[test]
    fn an_edit_keeps_the_position_the_view_already_had() {
        let c = conn();
        save(&c, &view("v1", "One")).unwrap();
        save(&c, &view("v2", "Two")).unwrap();
        save(&c, &View { name: "One edited".into(), ..view("v1", "unused") }).unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["v1", "v2"]);
    }

    #[test]
    fn reordering_persists_and_rejects_incomplete_orders() {
        let c = conn();
        for id in ["a", "b", "c"] { save(&c, &view(id, id)).unwrap(); }
        assert!(reorder(&c, &["c".into(), "a".into()]).is_err());
        assert_eq!(list(&c).unwrap().iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
        reorder(&c, &["c".into(), "a".into(), "b".into()]).unwrap();
        assert_eq!(list(&c).unwrap().iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["c", "a", "b"]);
    }

    #[test]
    fn deleting_a_view_leaves_the_others() {
        let c = conn();
        save(&c, &view("v1", "One")).unwrap();
        save(&c, &view("v2", "Two")).unwrap();
        delete(&c, "v1").unwrap();
        assert_eq!(list(&c).unwrap().iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["v2"]);
    }

    #[test]
    fn the_starters_are_seeded_once_and_stay_deleted() {
        let c = conn();
        assert_eq!(ensure_starters(&c).unwrap(), 3);
        let names: Vec<String> = list(&c).unwrap().into_iter().map(|v| v.name).collect();
        assert_eq!(names.len(), 3, "{names:?}");
        assert_eq!(ensure_starters(&c).unwrap(), 0, "a second run seeds nothing");
        delete(&c, &list(&c).unwrap()[0].id).unwrap();
        assert_eq!(ensure_starters(&c).unwrap(), 0, "a starter the user deleted does not come back");
        assert_eq!(list(&c).unwrap().len(), 2);
    }

    /// A starter's name is the app's to translate: storing "Needs reply" here
    /// would pin an English sidebar into the database for a German user, and
    /// changing language later could not undo it.
    #[test]
    fn a_starter_stores_no_name_of_its_own() {
        for starter in starters() {
            assert_eq!(starter.name, "", "{:?} carries a name to translate", starter.builtin);
            assert!(starter.builtin.is_some());
        }
    }

    #[test]
    fn a_starter_can_be_given_a_name_and_keeps_it() {
        let c = conn();
        ensure_starters(&c).unwrap();
        let starred = list(&c).unwrap().into_iter().find(|v| v.builtin.as_deref() == Some("starred")).unwrap();
        save(&c, &View { name: "Pinned".into(), ..starred.clone() }).unwrap();
        let again = get(&c, &starred.id).unwrap().unwrap();
        assert_eq!(again.name, "Pinned");
        assert_eq!(again.builtin.as_deref(), Some("starred"));
    }

    #[test]
    fn a_view_the_user_made_still_needs_a_name() {
        let c = conn();
        assert!(save(&c, &View { name: "  ".into(), ..view("v1", "unused") }).is_err());
    }

    /// Folder names are per-mailbox words: a German account's trash is
    /// `Papierkorb`. A starter that excluded the English name would exclude
    /// nothing there, which is how the Graph folder keys broke.
    #[test]
    fn needs_reply_excludes_folders_by_special_use_not_by_name() {
        let needs_reply = starters().into_iter().find(|v| v.builtin.as_deref() == Some("needs-reply")).unwrap().def;
        assert!(needs_reply.mailboxes_excluded.is_empty(), "no English folder names");
        assert_eq!(needs_reply.exclude_special, vec!["\\Trash", "\\Junk", "\\Archive"]);
    }

    #[test]
    fn the_starters_say_what_they_filter_on() {
        let by_builtin = |id: &str| starters().into_iter().find(|v| v.builtin.as_deref() == Some(id)).expect(id);
        assert!(by_builtin("attachments").def.has_attachments);
        assert_eq!(by_builtin("starred").def.starred, Some(true));
        let needs_reply = by_builtin("needs-reply").def;
        assert_eq!(needs_reply.answered, Some(false));
        assert!(needs_reply.to_me, "addressed to the account");
        assert!(needs_reply.not_from_me, "not the mail you sent");
        assert_eq!(needs_reply.within_days, Some(30));
    }

    #[test]
    fn a_definition_written_by_an_older_build_still_reads() {
        let c = conn();
        c.execute(
            "INSERT INTO views(id, name, icon, position, builtin, def_json) VALUES ('old', 'Old', '', 0, NULL, '{\"query\":\"hi\"}')",
            [],
        )
        .unwrap();
        let got = get(&c, "old").unwrap().expect("read");
        assert_eq!(got.def.query, "hi");
        assert_eq!(got.def.tags, Vec::<String>::new(), "fields it never knew about default");
    }
}
