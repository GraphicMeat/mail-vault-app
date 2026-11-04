//! `folder_move::plan` over account listings shaped as `list_mailboxes`,
//! `mailbox_tree` and the Graph listing give them.

mod folder_move_plan {
    use mailvault_core::folder_move::{plan, Kind, PlanError, PlanItem, Target};
    use mailvault_core::imap::MailboxInfo;

    fn mb(path: &str, delimiter: Option<&str>, children: Vec<MailboxInfo>) -> MailboxInfo {
        let name = delimiter.and_then(|d| path.rsplit(d).next()).unwrap_or(path).to_string();
        MailboxInfo {
            name,
            path: path.to_string(),
            special_use: None,
            special_use_guessed: false,
            flags: Vec::new(),
            delimiter: delimiter.map(str::to_string),
            noselect: false,
            children,
        }
    }

    fn special(mut m: MailboxInfo, use_: &str, guessed: bool) -> MailboxInfo {
        m.special_use = Some(use_.to_string());
        m.special_use_guessed = guessed;
        m
    }

    /// INBOX, Trash, Archive (+ Archive/Old), Clients (+ 2025 + 2025/Q1, and
    /// a noselect Clients/Hold), Clients2: one IMAP account, `/` delimiter.
    fn slash_tree() -> Vec<MailboxInfo> {
        let s = Some("/");
        let mut hold = mb("Clients/Hold", s, vec![]);
        hold.noselect = true;
        vec![
            mb("INBOX", s, vec![]),
            special(mb("Trash", s, vec![]), "\\Trash", false),
            mb("Archive", s, vec![mb("Archive/Old", s, vec![])]),
            mb("Clients", s, vec![mb("Clients/2025", s, vec![mb("Clients/2025/Q1", s, vec![])]), hold]),
            mb("Clients2", s, vec![]),
        ]
    }

    fn dot_tree() -> Vec<MailboxInfo> {
        let d = Some(".");
        vec![mb("INBOX", d, vec![]), mb("Archive", d, vec![])]
    }

    fn pairs(items: &[PlanItem]) -> Vec<(&str, &str)> {
        items.iter().map(|i| (i.src_path.as_str(), i.dest_path.as_str())).collect()
    }

    fn cross(src: &[MailboxInfo], root: &str, dest: &[MailboxInfo], target: Target) -> Result<mailvault_core::folder_move::Plan, PlanError> {
        plan(src, root, dest, &target, false, Kind::Imap, Kind::Imap)
    }

    fn same(tree: &[MailboxInfo], root: &str, target: Target) -> Result<mailvault_core::folder_move::Plan, PlanError> {
        plan(tree, root, tree, &target, true, Kind::Imap, Kind::Imap)
    }

    #[test]
    fn subtree_maps_by_segments_across_delimiters() {
        let p = cross(&slash_tree(), "Clients", &dot_tree(), Target::Into("Archive".into())).unwrap();
        assert_eq!(
            pairs(&p.items),
            [
                ("Clients", "Archive.Clients"),
                ("Clients/2025", "Archive.Clients.2025"),
                ("Clients/Hold", "Archive.Clients.Hold"),
                ("Clients/2025/Q1", "Archive.Clients.2025.Q1"),
            ],
            "root first, deepest last, Clients2 is not under Clients"
        );
        assert_eq!(p.items.iter().map(|i| i.container).collect::<Vec<_>>(), [false, false, true, false], "noselect stays a container");
        assert_eq!(p.fast_rename, None);
    }

    #[test]
    fn a_segment_holding_the_dest_delimiter_is_refused() {
        let s = Some("/");
        let src = vec![mb("Clients", s, vec![mb("Clients/v1.2", s, vec![])])];
        assert_eq!(cross(&src, "Clients", &dot_tree(), Target::TopLevel), Err(PlanError::Name));
    }

    #[test]
    fn top_level_target_creates_the_leaf() {
        let s = Some("/");
        let src = vec![mb("Work", s, vec![mb("Work/Clients", s, vec![mb("Work/Clients/A", s, vec![])])])];
        let p = cross(&src, "Work/Clients", &slash_tree(), Target::TopLevel).unwrap();
        assert_eq!(pairs(&p.items), [("Work/Clients", "Clients"), ("Work/Clients/A", "Clients/A")]);
        assert_eq!(p.fast_rename, None, "another account copies");
    }

    #[test]
    fn into_target_makes_picked_folder_the_parent() {
        let p = cross(&slash_tree(), "Clients2", &slash_tree(), Target::Into("Archive".into())).unwrap();
        assert_eq!(pairs(&p.items), [("Clients2", "Archive/Clients2")]);
        let p = cross(&slash_tree(), "Clients2", &slash_tree(), Target::Into("Archive/Old".into())).unwrap();
        assert_eq!(pairs(&p.items), [("Clients2", "Archive/Old/Clients2")]);
        assert_eq!(cross(&slash_tree(), "Clients2", &slash_tree(), Target::Into("Nowhere".into())), Err(PlanError::NotFound));
        assert_eq!(cross(&slash_tree(), "Nowhere", &slash_tree(), Target::TopLevel), Err(PlanError::NotFound));
    }

    #[test]
    fn existing_dest_leaf_merges() {
        let mut dest = slash_tree();
        dest[2].children.push(mb("Archive/Clients", Some("/"), vec![]));
        let p = cross(&slash_tree(), "Clients", &dest, Target::Into("Archive".into())).unwrap();
        assert_eq!(p.items[0].dest_path, "Archive/Clients");
        let p = same(&dest, "Clients", Target::Into("Archive".into())).unwrap();
        assert_eq!((p.items[0].dest_path.as_str(), p.fast_rename), ("Archive/Clients", None), "a taken path merges by copy, never renames onto it");
    }

    #[test]
    fn dest_inside_source_is_refused_same_account() {
        let tree = slash_tree();
        assert_eq!(same(&tree, "Clients", Target::Into("Clients".into())), Err(PlanError::IntoItself));
        assert_eq!(same(&tree, "Clients", Target::Into("Clients/2025/Q1".into())), Err(PlanError::IntoItself));
        assert_eq!(same(&tree, "Archive/Old", Target::Into("Archive".into())), Err(PlanError::IntoItself), "already there");
        assert!(same(&tree, "Clients", Target::Into("Clients2".into())).is_ok(), "a sibling sharing the prefix is not inside");
        assert!(cross(&tree, "Clients", &tree, Target::Into("Clients".into())).is_ok(), "another account's Clients is not the source");
    }

    #[test]
    fn same_account_top_level_is_a_fast_rename() {
        let tree = slash_tree();
        let p = same(&tree, "Archive/Old", Target::TopLevel).unwrap();
        assert_eq!((pairs(&p.items), p.fast_rename.as_deref()), (vec![("Archive/Old", "Old")], Some("Old")));
        let p = same(&tree, "Clients", Target::Into("Archive".into())).unwrap();
        assert_eq!(p.fast_rename.as_deref(), Some("Archive/Clients"), "a free destination path renames too");
        let mut taken = slash_tree();
        taken.push(mb("Old", Some("/"), vec![]));
        assert_eq!(same(&taken, "Archive/Old", Target::TopLevel).unwrap().fast_rename, None);
    }

    #[test]
    fn nil_delimiter_dest_with_children_is_refused() {
        let flat = vec![mb("INBOX", None, vec![]), mb("Archive", None, vec![])];
        assert_eq!(cross(&slash_tree(), "Clients", &flat, Target::TopLevel), Err(PlanError::NoHierarchy));
        assert_eq!(cross(&slash_tree(), "Clients2", &flat, Target::Into("Archive".into())), Err(PlanError::NoHierarchy));
        let p = cross(&slash_tree(), "Clients2", &flat, Target::TopLevel).unwrap();
        assert_eq!(pairs(&p.items), [("Clients2", "Clients2")]);
    }

    #[test]
    fn graph_source_with_children_is_refused() {
        let s = Some("/");
        let mut parent = mb("Projects", s, vec![]);
        parent.flags.push("\\HasChildren".into());
        let graph = vec![mb("INBOX", s, vec![]), parent, mb("Solo", s, vec![]), mb("Q1/Q2", s, vec![]), mb("Solo/Old", s, vec![])];
        let to_imap = |root: &str| plan(&graph, root, &slash_tree(), &Target::TopLevel, false, Kind::Graph, Kind::Imap);
        assert_eq!(to_imap("Projects"), Err(PlanError::GraphSubfolders));
        assert_eq!(pairs(&to_imap("Solo").unwrap().items), [("Solo", "Solo")], "a sibling named Solo/Old is not its child");
        assert_eq!(to_imap("Q1/Q2"), Err(PlanError::Name), "a slash in a Graph name is part of the name");
        let p = plan(&graph, "Q1/Q2", &dot_tree(), &Target::TopLevel, false, Kind::Graph, Kind::Imap).unwrap();
        assert_eq!(pairs(&p.items), [("Q1/Q2", "Q1/Q2")]);
        let to_graph = plan(&slash_tree(), "Clients", &graph, &Target::TopLevel, false, Kind::Imap, Kind::Graph);
        assert_eq!(to_graph, Err(PlanError::GraphSubfolders));
        let p = plan(&slash_tree(), "Clients2", &graph, &Target::TopLevel, false, Kind::Imap, Kind::Graph).unwrap();
        assert_eq!(pairs(&p.items), [("Clients2", "Clients2")]);
    }

    #[test]
    fn imap_to_jmap_names_are_decoded() {
        let s = Some("/");
        let imap = vec![mb("Kunden", s, vec![mb("Kunden/&ANw-bung", s, vec![])])];
        let jmap = vec![mb("INBOX", s, vec![]), mb("Archive", s, vec![])];
        let p = plan(&imap, "Kunden", &jmap, &Target::Into("Archive".into()), false, Kind::Imap, Kind::Jmap).unwrap();
        assert_eq!(pairs(&p.items), [("Kunden", "Archive/Kunden"), ("Kunden/&ANw-bung", "Archive/Kunden/Übung")]);

        let jmap_src = vec![mb("Café", s, vec![])];
        let p = plan(&jmap_src, "Café", &slash_tree(), &Target::TopLevel, false, Kind::Jmap, Kind::Imap).unwrap();
        assert_eq!(pairs(&p.items), [("Café", "Caf&AOk-")], "and encoded the other way");
    }

    #[test]
    fn inbox_and_special_use_roots_or_children_are_refused() {
        let s = Some("/");
        let mut tree = slash_tree();
        tree.push(mb("Projects", s, vec![special(mb("Projects/Sent", s, vec![]), "\\Sent", false)]));
        assert_eq!(same(&tree, "INBOX", Target::Into("Archive".into())), Err(PlanError::Reserved));
        assert_eq!(same(&tree, "Trash", Target::Into("Archive".into())), Err(PlanError::Reserved));
        assert_eq!(same(&tree, "Projects", Target::Into("Archive".into())), Err(PlanError::Reserved), "a reserved subfolder");
        assert!(same(&tree, "Clients", Target::Into("Trash".into())).is_ok(), "a special-use folder is a fine destination");
    }

    #[test]
    fn guessed_special_use_is_reserved_like_the_menu_lock() {
        let s = Some("/");
        let tree = vec![mb("INBOX", s, vec![]), special(mb("Sent Messages", s, vec![]), "\\Sent", true), mb("Archive", s, vec![])];
        assert_eq!(same(&tree, "Sent Messages", Target::Into("Archive".into())), Err(PlanError::Reserved));
    }
}
